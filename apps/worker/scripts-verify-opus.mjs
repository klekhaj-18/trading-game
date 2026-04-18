import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import path from "node:path";

const envPath = path.resolve(process.cwd(), ".dev.vars");
const envText = fs.readFileSync(envPath, "utf8");
const apiKey = envText
  .split(/\r?\n/)
  .find((l) => l.startsWith("ANTHROPIC_API_KEY"))
  ?.split("=")
  .slice(1)
  .join("=")
  .trim()
  .replace(/^["']|["']$/g, "");

if (!apiKey) throw new Error("ANTHROPIC_API_KEY not found in apps/worker/.dev.vars");

const SYSTEM = `You are the strategist for a player in the Trading Grand Prix, a 30-day paper-trading competition between four friends using Alpaca paper accounts. Translate a player's goal + playbook into a concrete operational plan.

HARD CONSTRAINTS:
- Paper trading, US stocks + ADRs, long-only.
- No single position above 25% of equity.
- Universe must be a concrete ticker list, never a dynamic rule.

OUTPUT: Call submit_plan exactly once with the full structured plan.`;

const TOOL = {
  name: "submit_plan",
  description: "Submit the operational trading plan.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["universe", "entry_rules", "exit_rules", "sizing", "risk", "per_slot_emphasis", "markdown_summary"],
    properties: {
      universe: {
        type: "array",
        minItems: 1,
        maxItems: 40,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["symbol", "rationale"],
          properties: { symbol: { type: "string" }, rationale: { type: "string" } },
        },
      },
      entry_rules: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["condition", "action"],
          properties: { condition: { type: "string" }, action: { type: "string" } },
        },
      },
      exit_rules: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["condition", "action"],
          properties: { condition: { type: "string" }, action: { type: "string" } },
        },
      },
      sizing: {
        type: "object",
        additionalProperties: false,
        required: ["position_size_pct", "max_positions", "concentration_cap_pct"],
        properties: {
          position_size_pct: { type: "number" },
          max_positions: { type: "integer" },
          concentration_cap_pct: { type: "number" },
        },
      },
      risk: {
        type: "object",
        additionalProperties: false,
        required: ["max_daily_loss_pct", "stop_loss_pct", "take_profit_pct"],
        properties: {
          max_daily_loss_pct: { type: "number" },
          stop_loss_pct: { type: "number" },
          take_profit_pct: { type: "number" },
        },
      },
      per_slot_emphasis: {
        type: "object",
        additionalProperties: false,
        required: ["premarket", "open", "midmorning", "afternoon", "close"],
        properties: {
          premarket: { type: "string" },
          open: { type: "string" },
          midmorning: { type: "string" },
          afternoon: { type: "string" },
          close: { type: "string" },
        },
      },
      markdown_summary: { type: "string" },
    },
  },
};

const client = new Anthropic({ apiKey });

const t0 = Date.now();
const resp = await client.messages.create({
  model: "claude-opus-4-7",
  max_tokens: 16000,
  thinking: { type: "adaptive" },
  output_config: { effort: "high" },
  system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
  tools: [TOOL],
  tool_choice: { type: "auto" },
  messages: [
    {
      role: "user",
      content: `# Player inputs

## Goal
Finish top 2 over 30 days. I want consistent 0.5-1% daily gains from momentum stocks. I'd rather miss a rally than blow up on a gap down.

## Playbook
Focus on large-cap tech with strong quarterly earnings beats. Buy breakouts above 5-day highs on above-average volume. Exit half on +3%, trail stop the rest. Cut losers at -2%. No more than 3 open positions. Avoid trading the first 15 minutes after open.

## Account snapshot
- Alpaca paper account: 01234567-test-test-test-000000000000
- Equity: $100000.00
- Cash: $100000.00
- Buying power: $200000.00

Now call submit_plan.`,
    },
  ],
});
const ms = Date.now() - t0;

const toolBlock = resp.content.find((b) => b.type === "tool_use" && b.name === "submit_plan");
if (!toolBlock) {
  console.error("ERROR: Opus did not call submit_plan. stop_reason =", resp.stop_reason);
  console.error("content blocks:", resp.content.map((b) => b.type));
  process.exit(1);
}

const plan = toolBlock.input;
console.log(`✓ Opus responded in ${ms}ms, stop_reason=${resp.stop_reason}`);
console.log(`  model: ${resp.model}`);
console.log(`  usage: input=${resp.usage.input_tokens}  output=${resp.usage.output_tokens}  cache_read=${resp.usage.cache_read_input_tokens ?? 0}  cache_write=${resp.usage.cache_creation_input_tokens ?? 0}`);
console.log(`  universe (${plan.universe.length}): ${plan.universe.map((u) => u.symbol).join(", ")}`);
console.log(`  sizing: ${plan.sizing.position_size_pct}% per position, max ${plan.sizing.max_positions} positions, cap ${plan.sizing.concentration_cap_pct}%`);
console.log(`  risk: daily loss ${plan.risk.max_daily_loss_pct}%, stop ${plan.risk.stop_loss_pct}%, TP ${plan.risk.take_profit_pct}%`);
console.log(`  entry rules: ${plan.entry_rules.length}   exit rules: ${plan.exit_rules.length}`);
console.log(`  markdown_summary: ${plan.markdown_summary.length} chars`);
console.log(`\n--- first 600 chars of markdown_summary ---\n${plan.markdown_summary.slice(0, 600)}…`);
