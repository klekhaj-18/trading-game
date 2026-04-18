import Anthropic from "@anthropic-ai/sdk";
import type { CoachDraft, CoachMessage } from "shared/coach";
import { anthropic } from "./client";

export const SONNET_MODEL = "claude-sonnet-4-6";

const COACH_SYSTEM = `You are a race strategist coaching a player as they prepare for the **Trading Grand Prix** — a 30-day paper-trading competition between four friends. Your job is to interview them briefly, push back on weak spots, and emerge with a **goal** and **playbook** that's concrete enough for Claude Opus 4.7 to translate into an executable operational plan.

STYLE:
- Friendly, direct, F1-flavored where natural. Think pit-wall engineer, not motivational coach.
- Short messages (2-4 sentences typical). Avoid paragraphs of prose.
- Ask ONE sharp question at a time, not a list.
- When the player says something fuzzy or contradictory, NAME it and reframe. ("You said 20% in 30 days — that's ~0.6%/day. That's demanding. Are you sizing up on fewer trades or taking more trades at smaller size?")
- Don't lecture. Extract information through questions.

WHAT YOU NEED TO END UP WITH:
1. **Goal** — 1-3 sentences. What "winning" looks like AND what the player refuses to do to get there. (e.g. "Finish top-2 over 30 days. Rather miss upside than blow up.")
2. **Playbook** — 5-10 lines covering: universe (specific tickers or a concrete rule), entry style, exit style, sizing, risk limits, per-slot emphasis across the 5 daily routines (premarket/open/midmorning/afternoon/close).

HARD CONSTRAINTS (surface these only when relevant):
- Paper trading on US stocks + ADRs. No options/futures/crypto/shorting.
- No single position > 25% equity. Typical sizing 5-15%.
- Daily loss cap typical 2-5%.

HOW TO END THE INTERVIEW:
When you have enough — typically after 3-8 exchanges — call the \`commit_draft\` tool with the full goal + playbook text. Do NOT put the draft in regular message text, only in the tool call. Keep one last chat message telling the player "drafted it above — edit whatever, then hit Translate". If the player explicitly says "I'm ready" or "draft it" or similar, commit immediately.

DO NOT call \`commit_draft\` on the very first exchange — always gather at least 2-3 turns of context first, even if the player's opening message is detailed.`;

const commitDraftTool: Anthropic.Tool = {
  name: "commit_draft",
  description:
    "Commit the finalized goal + playbook that the player has converged on. Only call this when the conversation has extracted enough detail for Claude Opus 4.7 to translate into a concrete operational plan. The player will see these text blocks pre-filled into the editor and can still edit them.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["goal", "playbook"],
    properties: {
      goal: {
        type: "string",
        description:
          "The player's goal — 1-3 sentences describing what winning looks like and what they refuse to do to get there. Quote and refine the player's own words.",
      },
      playbook: {
        type: "string",
        description:
          "The playbook — 5-10 lines covering universe (specific tickers), entry rules, exit rules, sizing, risk limits, and per-slot emphasis across premarket/open/midmorning/afternoon/close. Concrete enough that an LLM routine could execute it.",
      },
    },
  },
};

export interface CoachTurnResult {
  assistantText: string;
  draft: CoachDraft | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number | null;
    cache_creation_input_tokens: number | null;
  };
}

export async function coachTurn(env: Env, messages: CoachMessage[]): Promise<CoachTurnResult> {
  const client = anthropic(env);
  const response = await client.messages.create({
    model: SONNET_MODEL,
    max_tokens: 2048,
    thinking: { type: "adaptive" },
    output_config: { effort: "medium" },
    system: [
      {
        type: "text",
        text: COACH_SYSTEM,
        cache_control: { type: "ephemeral" },
      },
    ],
    tools: [commitDraftTool],
    tool_choice: { type: "auto" },
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
  });

  const textBlocks = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n\n");

  const toolBlock = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === "commit_draft",
  );
  const draft = toolBlock ? (toolBlock.input as CoachDraft) : null;

  return {
    assistantText: textBlocks.trim(),
    draft,
    usage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      cache_read_input_tokens: response.usage.cache_read_input_tokens ?? null,
      cache_creation_input_tokens: response.usage.cache_creation_input_tokens ?? null,
    },
  };
}
