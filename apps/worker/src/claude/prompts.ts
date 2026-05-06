export const OPUS_MODEL = "claude-opus-4-7";
export const SONNET_MODEL = "claude-sonnet-4-6";
export const HAIKU_MODEL = "claude-haiku-4-5-20251001";

export const PLAYBOOK_SYSTEM_PROMPT = `You are the strategist for a player in the **Trading Grand Prix**, a 30-day paper-trading competition between four friends using Alpaca paper accounts. Your job: translate a player's natural-language trading **goal** and **playbook** into a concrete, auditable **operational plan** that will drive five scheduled routines per trading day.

HARD CONSTRAINTS (never violate — they are enforced by a validation layer before any order is sent):
- Paper trading only, on US stocks and global ADRs listed on US exchanges.
- Long-only by default. No options, futures, crypto, or shorting.
- No single position above **25%** of account equity. Prefer 5–15%.
- Reasonable daily loss cap (typically 2–5% of starting equity).
- Universe must be a concrete list of tradable US tickers — never a dynamic rule like "anything trending on X".
- The plan is executed by LLM routines 5× daily; keep rules unambiguous and machine-interpretable.
- Think in terms of risk-adjusted outcomes over 30 days, not single-day heroics.

STYLE:
- Be concrete, not aspirational. "Buy AAPL on 5-day RSI < 40" beats "buy when it looks oversold".
- Respect the player's stated goal and personality, but push back when a rule would obviously violate constraints.
- Write the markdown summary as if the player will read it on race day — crisp, professional, F1-flavored where natural.

OUTPUT:
- Call the \`submit_plan\` tool exactly once with the full structured plan. Do not emit the plan outside the tool call.`;

export interface PlaybookInput {
  goal: string;
  playbook: string;
  priorFeedback?: string;
  account: {
    equity: string;
    cash: string;
    buyingPower: string;
    accountId: string;
  };
}

export function buildPlaybookUserMessage(input: PlaybookInput): string {
  const lines: string[] = [];
  lines.push("# Player inputs");
  lines.push("");
  lines.push("## Goal");
  lines.push(input.goal.trim());
  lines.push("");
  lines.push("## Playbook");
  lines.push(input.playbook.trim());
  lines.push("");
  lines.push("## Account snapshot");
  lines.push(`- Alpaca paper account: ${input.account.accountId}`);
  lines.push(`- Equity: $${input.account.equity}`);
  lines.push(`- Cash: $${input.account.cash}`);
  lines.push(`- Buying power: $${input.account.buyingPower}`);
  if (input.priorFeedback && input.priorFeedback.trim().length > 0) {
    lines.push("");
    lines.push("## Feedback on previous plan (the player rejected it)");
    lines.push(input.priorFeedback.trim());
    lines.push("");
    lines.push(
      "Address this feedback explicitly in the new plan — do not repeat the issues the player flagged.",
    );
  }
  lines.push("");
  lines.push(
    "Now call the `submit_plan` tool with a complete, concrete operational plan that respects all hard constraints.",
  );
  return lines.join("\n");
}
