import Anthropic from "@anthropic-ai/sdk";
import type { CoachDraft, CoachMessage, CoachPlanRevision, CoachPlaybookRevision } from "shared/coach";
import type { IntentSummary } from "shared/intent";
import type { OperationalPlan } from "shared/playbook";
import { anthropic } from "./client";
import { OPUS_MODEL } from "./prompts";
import { submitPlanTool } from "./tools";

const COACH_SYSTEM = `You are the pit-wall engineer for the **Trading Grand Prix** — a 30-day paper-trading competition between four friends. The winner is whoever posts the highest account equity on day 30. You work with ONE player at a time.

YOUR JOB has two modes depending on what the player needs:

**Mode A — first-time onboarding interview.** Build the **goal** and **playbook** from scratch via a 3-8 exchange interview. End by calling \`commit_draft\` with goal + playbook text. The downstream system will translate it into a structured operational plan.

**Mode B — iterating on an already-active strategy.** This is the more common mode. The player already has an approved playbook + plan, you can SEE it (in the <current_strategy> block of the user message), and the player wants to refine it. You have three tools to choose from:
- \`commit_draft\` — only for first-time onboarding. Do not use if <current_strategy> shows an existing playbook.
- \`propose_playbook_revision\` — when the player wants natural-language changes ("make my playbook more aggressive", "rewrite my goal to focus on swing trades"). Returns goal + playbook + rationale; the system re-translates it via Opus into a fresh operational plan.
- \`propose_plan_revision\` — when the player wants a surgical change to the plan ("drop NVDA from universe", "bump max positions to 5", "tighten stop to 3%"). Returns the FULL revised OperationalPlan + rationale. Skip the re-translation step. ALWAYS provide the complete plan, not just the changed fields — copy the unchanged ones over verbatim from the current plan.

HOW THIS GAME ACTUALLY WORKS (never ask the player about any of this — it is fixed):
- Broker: Alpaca paper trading, $100k starting equity per player. No choice.
- Universe: US equities and ADRs only. No options, futures, crypto, FX, shorting.
- Execution: the player does NOT trade manually (mostly). Claude Opus runs 5 routines per trading day — premarket (9:15 ET), open (9:35 ET), midmorning (11:30 ET), afternoon (2:00 ET), close (3:45 ET) — and at each slot reads the playbook, looks at the account, and decides what to buy, sell, or leave alone.
- Order types: market and limit, day or GTC. No server-side stops.
- The player CAN override at the trade level via "intents" (binding one-shot or standing) and via direct orders that bypass the plan entirely. You do NOT manage those — the player does.
- Leaderboard: ranks by total return on $100k starting equity, updated after each routine.

STYLE:
- Pit-wall engineer, not life coach. Direct, F1-flavored when natural.
- Short messages (2-4 sentences). One sharp question or one specific suggestion per turn.
- When you propose a plan revision, name the specific change in the rationale ("dropping NVDA cuts your universe to 4 names — your max_positions=5 is now slack; bumping it to 4 keeps the cap meaningful").
- When the plan is well-tuned and the player is fishing, say so plainly. Don't manufacture changes.

HARD RULES for plan revisions (the validator will reject violations):
- universe: 1-40 entries, each {symbol, rationale}.
- sizing.position_size_pct: 0-25.
- sizing.concentration_cap_pct: 0-25.
- risk.stop_loss_pct, take_profit_pct: positive percents.
- per_slot_emphasis: all 5 slots (premarket/open/midmorning/afternoon/close) must be non-empty strings.
- markdown_summary: keep it under ~1500 words but rewrite to reflect the change.

When you call propose_plan_revision, ALWAYS include the COMPLETE plan — the validator will reject partial submissions.`;

const commitDraftTool: Anthropic.Tool = {
  name: "commit_draft",
  description:
    "First-time onboarding only. Commit the finalized goal + playbook that the player has converged on. Only call this when the player has NO existing strategy yet (the <current_strategy> block is missing or empty).",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["goal", "playbook"],
    properties: {
      goal: { type: "string" },
      playbook: { type: "string" },
    },
  },
};

const proposePlaybookRevisionTool: Anthropic.Tool = {
  name: "propose_playbook_revision",
  description:
    "Propose a revised goal + playbook (natural language). Use when the player wants substantive direction changes. The system will re-translate via Opus into a fresh operational plan, which the player must approve.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["goal", "playbook", "rationale"],
    properties: {
      goal: { type: "string", description: "Revised 1-3 sentence goal." },
      playbook: { type: "string", description: "Revised 5-10 line playbook." },
      rationale: {
        type: "string",
        description: "One short paragraph explaining what you changed and why.",
      },
    },
  },
};

const proposePlanRevisionTool: Anthropic.Tool = {
  name: "propose_plan_revision",
  description:
    "Propose a surgical revision to the operational plan. Use for specific changes like adjusting universe, sizing, or rules. ALWAYS return the COMPLETE plan including unchanged fields. The system stores it as a new pending plan that the player must approve.",
  input_schema: {
    ...(submitPlanTool.input_schema as Record<string, unknown>),
    properties: {
      ...((submitPlanTool.input_schema as { properties: Record<string, unknown> }).properties ?? {}),
      rationale: {
        type: "string",
        description: "One short paragraph explaining what you changed vs the prior plan and why.",
      },
    },
    required: [
      ...(((submitPlanTool.input_schema as { required?: string[] }).required) ?? []),
      "rationale",
    ],
  } as Anthropic.Tool["input_schema"],
};

export interface CoachContext {
  playbook: { goalText: string; playbookText: string; version: number } | null;
  approvedPlan: OperationalPlan | null;
  positions: { symbol: string; qty: number; avgEntry: number; current: number; unrealizedPl: number }[];
  recentFills: { symbol: string; side: string; qty: number; filledAvgPrice: number | null; filledAtIso: string | null; source: "ai" | "direct" }[];
  pendingIntents: IntentSummary[];
}

export interface CoachTurnResult {
  assistantText: string;
  draft: CoachDraft | null;
  playbookRevision: CoachPlaybookRevision | null;
  planRevision: CoachPlanRevision | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number | null;
    cache_creation_input_tokens: number | null;
  };
}

function renderContext(ctx: CoachContext): string {
  const lines: string[] = [];
  lines.push("<current_strategy>");
  if (!ctx.playbook) {
    lines.push("(none — first-time onboarding flow; use commit_draft when ready)");
    lines.push("</current_strategy>");
    return lines.join("\n");
  }
  lines.push(`# Playbook (v${ctx.playbook.version})`);
  lines.push(`## Goal\n${ctx.playbook.goalText}`);
  lines.push(`## Playbook\n${ctx.playbook.playbookText}`);
  if (ctx.approvedPlan) {
    lines.push("");
    lines.push("# Current OperationalPlan (canonical)");
    lines.push("```json");
    lines.push(JSON.stringify(ctx.approvedPlan, null, 2));
    lines.push("```");
  } else {
    lines.push("");
    lines.push("(no approved plan yet)");
  }
  if (ctx.positions.length > 0) {
    lines.push("");
    lines.push("# Current positions");
    for (const p of ctx.positions) {
      lines.push(
        `- ${p.symbol}: qty=${p.qty} avg_entry=$${p.avgEntry.toFixed(2)} current=$${p.current.toFixed(2)} unrealized=$${p.unrealizedPl.toFixed(2)}`,
      );
    }
  }
  if (ctx.recentFills.length > 0) {
    lines.push("");
    lines.push("# Recent fills (most recent first)");
    for (const f of ctx.recentFills) {
      const price = f.filledAvgPrice != null ? `@$${f.filledAvgPrice.toFixed(2)}` : "";
      lines.push(`- ${f.side.toUpperCase()} ${f.qty} ${f.symbol} ${price} [${f.source}] ${f.filledAtIso ?? ""}`);
    }
  }
  if (ctx.pendingIntents.length > 0) {
    lines.push("");
    lines.push("# Pending player intents (active overrides)");
    for (const i of ctx.pendingIntents) {
      lines.push(`- ${i.bindingNextSlot ? "BINDING" : "STANDING"}: ${i.text}`);
    }
  }
  lines.push("</current_strategy>");
  return lines.join("\n");
}

export async function coachTurn(env: Env, messages: CoachMessage[], ctx: CoachContext): Promise<CoachTurnResult> {
  const client = anthropic(env);
  const contextBlock = renderContext(ctx);
  const userMessages = messages.map((m) => ({ role: m.role, content: m.content }));
  // Prepend the strategy context to the first user message so the coach sees it without it counting as a separate turn.
  if (userMessages.length > 0 && userMessages[0]!.role === "user") {
    userMessages[0] = {
      role: "user",
      content: `${contextBlock}\n\n${userMessages[0]!.content}`,
    };
  }

  const response = await client.messages.create({
    model: OPUS_MODEL,
    max_tokens: 8192,
    thinking: { type: "adaptive" },
    output_config: { effort: "medium" },
    system: [
      {
        type: "text",
        text: COACH_SYSTEM,
        cache_control: { type: "ephemeral" },
      },
    ],
    tools: [commitDraftTool, proposePlaybookRevisionTool, proposePlanRevisionTool],
    tool_choice: { type: "auto" },
    messages: userMessages,
  });

  const textBlocks = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n\n");

  let draft: CoachDraft | null = null;
  let playbookRevision: CoachPlaybookRevision | null = null;
  let planRevision: CoachPlanRevision | null = null;
  for (const block of response.content) {
    if (block.type !== "tool_use") continue;
    const input = block.input as Record<string, unknown>;
    if (block.name === "commit_draft") {
      draft = { goal: String(input.goal ?? ""), playbook: String(input.playbook ?? "") };
    } else if (block.name === "propose_playbook_revision") {
      playbookRevision = {
        goal: String(input.goal ?? ""),
        playbook: String(input.playbook ?? ""),
        rationale: String(input.rationale ?? ""),
      };
    } else if (block.name === "propose_plan_revision") {
      const { rationale, ...planFields } = input as { rationale?: string } & Record<string, unknown>;
      planRevision = {
        plan: planFields as unknown as OperationalPlan,
        rationale: String(rationale ?? ""),
      };
    }
  }

  return {
    assistantText: textBlocks.trim(),
    draft,
    playbookRevision,
    planRevision,
    usage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      cache_read_input_tokens: response.usage.cache_read_input_tokens ?? null,
      cache_creation_input_tokens: response.usage.cache_creation_input_tokens ?? null,
    },
  };
}
