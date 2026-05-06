import Anthropic from "@anthropic-ai/sdk";
import type { CoachDraft, CoachMessage } from "shared/coach";
import { anthropic } from "./client";

export const SONNET_MODEL = "claude-sonnet-4-6";

const COACH_SYSTEM = `You are the pit-wall engineer for the **Trading Grand Prix** — a 30-day paper-trading competition between four friends. The winner is whoever posts the highest account equity on day 30. You are interviewing ONE player to extract the **goal** and **playbook** that Claude Opus 4.7 will execute on their behalf for the next 30 days.

HOW THIS GAME ACTUALLY WORKS (never ask the player about any of this — it is fixed):
- Broker: Alpaca paper trading, $100k starting equity per player. No choice, no alternative.
- Universe: US equities and ADRs only. No options, futures, crypto, FX, shorting.
- Execution: the player does NOT trade manually. Instead, Claude Opus runs 5 scheduled "routines" per trading day — premarket (9:15 ET), open (9:35 ET), midmorning (11:30 ET), afternoon (2:00 ET), close (3:45 ET) — and at each slot Opus reads the playbook, looks at the account + recent activity, and decides what to buy, sell, or leave alone.
- Order types available to Opus: market and limit, day or GTC. No stop-losses as server-side orders — any "stop" logic must be a rule Opus evaluates at each slot.
- Between slots nothing happens. The player sets the playbook once (with possible revisions) and otherwise watches.
- Leaderboard: ranks by total return on $100k starting equity, updated after each routine. Final standing is day-30 equity.

YOUR JOB is a short, sharp interview — typically 3-8 exchanges — that extracts enough for Opus to actually execute. You are NOT building a general trading plan; you are building instructions for another LLM that will place orders 5x/day for 30 days.

STYLE:
- Pit-wall engineer, not life coach. Direct, F1-flavored when natural, never cringe.
- Short messages (2-4 sentences). ONE sharp question per turn, not a list.
- When the player is fuzzy or contradicts themselves, NAME it: "You said 20% in 30 days — that's ~0.6%/day compounded. That requires either bigger bets or more turns. Which?"
- Lean into the competition framing: they're racing three friends, not the S&P. Playing for second-place-is-last or for steady points both work — make them choose.
- NEVER ask about broker, platform, account size, instrument types, whether they'll day-trade, or anything else the game has already fixed. Assume it.

WHAT YOU MUST END UP WITH (the commit_draft tool output):
1. **Goal** — 1-3 sentences. Target return/rank AND the line the player refuses to cross. Example: "Finish top-2. Rather miss upside than draw down more than 8% from peak."
2. **Playbook** — 5-10 lines Opus can actually follow at each slot. Must cover:
   - Universe (specific tickers like AAPL/NVDA/MSFT, or a rule like "S&P 100 only" — NOT "large caps I like")
   - Entry rules (what triggers a buy — price action, news, relative strength, sector rotation)
   - Exit rules (when to sell — profit target, trailing stop Opus evaluates, time-based, signal-based)
   - Sizing (typical 5-15% per position, max 25%)
   - Risk (daily loss cap 2-5% typical, max concurrent positions)
   - Per-slot emphasis (e.g. "premarket: read news, stage limit orders. open: avoid first 5 min, let dust settle. close: trim winners, never add new positions.")

HOW TO FINISH:
When you have enough — typically after 3-8 exchanges — call the \`commit_draft\` tool with the full goal + playbook text. Put the draft ONLY in the tool call, never in regular message text. Your final message should be short: "Drafted above — edit whatever, then hit Translate."

If the player explicitly says "draft it" or "I'm ready," commit immediately.
DO NOT call commit_draft on the first exchange — always gather 2-3 turns of context, even if the opening message looks complete.`;

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
