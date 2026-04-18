import type Anthropic from "@anthropic-ai/sdk";

export const SUBMIT_PLAN_TOOL_NAME = "submit_plan";

export const submitPlanTool: Anthropic.Tool = {
  name: SUBMIT_PLAN_TOOL_NAME,
  description:
    "Submit the operational trading plan. Translate the player's natural-language goal + playbook into concrete, enforceable rules. The plan will be executed by automated routines five times per trading day against a paper Alpaca account.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: [
      "universe",
      "entry_rules",
      "exit_rules",
      "sizing",
      "risk",
      "per_slot_emphasis",
      "markdown_summary",
    ],
    properties: {
      universe: {
        type: "array",
        description:
          "Specific tradable US stock symbols and ADRs the plan allows. Use ticker symbols only (e.g. AAPL, NVDA, TSM). Must be a concrete list; never a dynamic rule. 1-40 symbols.",
        minItems: 1,
        maxItems: 40,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["symbol", "rationale"],
          properties: {
            symbol: { type: "string", description: "Uppercase US ticker symbol" },
            rationale: {
              type: "string",
              description: "One sentence why this symbol fits the player's playbook",
            },
          },
        },
      },
      entry_rules: {
        type: "array",
        description: "Conditions under which to open a new position.",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["condition", "action"],
          properties: {
            condition: { type: "string" },
            action: { type: "string" },
          },
        },
      },
      exit_rules: {
        type: "array",
        description: "Conditions under which to close an existing position.",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["condition", "action"],
          properties: {
            condition: { type: "string" },
            action: { type: "string" },
          },
        },
      },
      sizing: {
        type: "object",
        additionalProperties: false,
        required: ["position_size_pct", "max_positions", "concentration_cap_pct"],
        properties: {
          position_size_pct: {
            type: "number",
            description: "Target position size as a % of equity (e.g. 10 means 10%).",
          },
          max_positions: {
            type: "integer",
            description: "Maximum simultaneous open positions.",
          },
          concentration_cap_pct: {
            type: "number",
            description: "Hard cap on any single position as % of equity. Must be <= 25.",
          },
        },
      },
      risk: {
        type: "object",
        additionalProperties: false,
        required: ["max_daily_loss_pct", "stop_loss_pct", "take_profit_pct"],
        properties: {
          max_daily_loss_pct: {
            type: "number",
            description:
              "Realized-loss threshold for the trading day as % of starting equity. Trading halts if breached.",
          },
          stop_loss_pct: {
            type: "number",
            description: "Per-position stop-loss as a % below entry.",
          },
          take_profit_pct: {
            type: "number",
            description: "Per-position take-profit as a % above entry.",
          },
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
      markdown_summary: {
        type: "string",
        description:
          "A readable markdown summary for the player to review. Must include headings for Universe, Entry, Exit, Sizing, Risk, and a line per slot. 300-1500 words.",
      },
    },
  },
};

export interface OperationalPlan {
  universe: { symbol: string; rationale: string }[];
  entry_rules: { condition: string; action: string }[];
  exit_rules: { condition: string; action: string }[];
  sizing: { position_size_pct: number; max_positions: number; concentration_cap_pct: number };
  risk: { max_daily_loss_pct: number; stop_loss_pct: number; take_profit_pct: number };
  per_slot_emphasis: {
    premarket: string;
    open: string;
    midmorning: string;
    afternoon: string;
    close: string;
  };
  markdown_summary: string;
}
