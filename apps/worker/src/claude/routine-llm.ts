import Anthropic from "@anthropic-ai/sdk";
import type { IntentSummary } from "shared/intent";
import type { OperationalPlan } from "shared/playbook";
import type { RoutineDecision, RoutineDecisionsOutput, RoutineSlot } from "shared/routine";
import { anthropic } from "./client";
import { OPUS_MODEL, SONNET_MODEL } from "./prompts";
import type { AccountContext, MarketSnapshot } from "../trading/snapshot";

// Premarket and close are the highest-leverage slots — premarket sets the day's posture
// from overnight news, close protects gains and stages tomorrow. The three intraday slots
// execute against an already-set plan, where Sonnet keeps up. Opus elsewhere.
function modelForSlot(slot: RoutineSlot): string {
  return slot === "premarket" || slot === "close" ? OPUS_MODEL : SONNET_MODEL;
}

export const SUBMIT_DECISIONS_TOOL = "submit_decisions";

const ROUTINE_SYSTEM_PROMPT = `You are the autonomous trader for a player in the **Trading Grand Prix** — a 30-day paper-trading competition between four friends. You run FIVE times per trading day (premarket, open, midmorning, afternoon, close) and execute the player's approved operational plan against their Alpaca paper account.

HARD CONSTRAINTS (a validation layer enforces these — do NOT try to work around):
- Paper trading only, US stocks and ADRs, long-only. No options/futures/crypto/shorting.
- Every trade symbol MUST appear in the plan's universe. No exceptions.
- Single-position concentration cap: 25% of account equity. Typical target 5-15%.
- Max 5 orders per routine run.
- Must respect plan.risk.max_daily_loss_pct — if the day is already past threshold, propose only 'plan' or 'hold'.
- Sells must reference positions the account actually holds; qty cannot exceed held qty.
- Limit orders must have limit_price within 10% of the current mid quote.
- During premarket (market closed), only 'plan' or 'hold' actions are allowed — no live orders.

CONTEXT YOU HAVE:
- The player's operational plan (structured JSON + markdown summary).
- Current account state: equity, cash, open positions with P&L, open orders, last 10 fills.
- Market clock (is_open, next_open/close).
- Broader market bars: SPY (S&P 500), QQQ (Nasdaq-100), VIXY (volatility proxy). Use these for risk-on/risk-off tone and relative strength vs the tape.
- Macro regime card (when available): VIX level, 10y-2y yield spread, DXY trend, SPY/QQQ price-vs-SMA50/200, and 11-sector 20-day momentum. Use this to set risk posture: high VIX or inverted curve = trim size and tighten stops; sector rotation = lean toward leaders.
- Per-plan-symbol: last quote, last 5 daily bars, next earnings date, and recent news headlines (last 48h).
- Per-plan-symbol pre-classified sentiment summary (when available): per-headline bullish/bearish/neutral/mixed labels with rationales, plus an aggregate score. Treat the summary as guidance, not gospel — the headlines themselves are still in the snapshot for cross-checking.
- Per-plan-symbol technicals card (when available): SMA20/50/200, % price-vs-SMA, RSI(14), ATR(14) and ATR% of price, 10d/30d realized vol, 52-week high/low and distance from each, 30d relative volume.
- Prior validation failures from recent runs — treat as feedback.

When the macro regime / sentiment / technicals fields are missing for a symbol, the warm cache hadn't refreshed yet; reason from raw bars and headlines instead and don't pretend you have data you don't.

DECISION QUALITY:
- Bias toward DOING LESS. A 'hold' that preserves capital is usually better than a forced trade.
- If nothing in the snapshot matches the plan's entry rules cleanly, output 'hold' decisions for current positions and 'plan' actions for anything you're watching. Do not invent setups.
- When the plan rules are ambiguous, lean conservative — smaller sizing, tighter stops, fewer new positions.
- Use news to explain moves: a symbol down 5% is different if a headline says "guidance cut" vs if there's no news and it's just tape action.
- Use earnings dates for event risk: reduce size or avoid new entries within 2 trading days of a print unless the plan explicitly allows trading earnings.
- Use broader market context: a stock falling while SPY rallies is relative-weakness; falling with SPY is beta. Weight decisions accordingly.
- Every decision MUST have a rationale that references concrete context (plan rule, account state, news, earnings proximity, broader market, or bars). Do NOT output generic rationales like "looks good" or "per the plan".

PER-SLOT EMPHASIS (the plan's per_slot_emphasis tells you the slot-specific tilt, but these defaults apply):
- premarket (09:15 ET): review overnight news mentally, set up plan-only decisions for the day. Market closed, NO LIVE ORDERS.
- open (09:35 ET): execute conviction entries after spreads settle.
- midmorning (11:30 ET): trim losers, add to winners per the plan.
- afternoon (14:00 ET): sizing review, reassess stops.
- close (15:45 ET): square up or protect gains per the plan.

USER INTENTS (override layer):
The player may submit intents — explicit overrides like "buy 5 AAPL today" — that override the plan's universe restriction. You'll see them as a USER INTENTS block. Two flavors:
- BINDING (one-shot): MUST be addressed THIS slot. Either honor it (emit a buy/sell decision tagged with intent_id) or reject it with a reason (return it in consumed_intents with status="rejected"). Silently ignoring a binding intent is auto-rejected by the system.
- STANDING: address each slot. Honor when conditions match; defer with a reason when they don't (status="deferred" in consumed_intents).
For each intent you saw, emit an entry in consumed_intents with id + status (honored | rejected | deferred) + reason. Decisions you emit to fulfill an intent MUST set their intent_id field — that is what bypasses the universe check. Sizing, concentration, and buying-power caps still apply to intent-fulfilling decisions. If a player wants 1000 AAPL and that breaches sizing, reject with a reason that names the specific cap.

OUTPUT PROTOCOL:
- Call the \`submit_decisions\` tool exactly once with your reasoning and a list of decisions.
- Include at least one decision per run (use 'hold' for every open position if nothing else applies).
- 'plan' action means "record this as a watch idea, do not trade" — useful premarket and when conditions aren't met.
- Every decision you emit will be put through a validation layer. Validation failures from prior runs appear in the account context so you can learn.`;

const submitDecisionsTool: Anthropic.Tool = {
  name: SUBMIT_DECISIONS_TOOL,
  description: "Submit the routine's decisions for this slot. Call exactly once.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["reasoning", "decisions"],
    properties: {
      reasoning: {
        type: "string",
        description:
          "A short paragraph (100-400 words) explaining how the current account state + market snapshot + plan rules led to these decisions. Reference specific plan rules and specific numbers.",
      },
      decisions: {
        type: "array",
        minItems: 1,
        maxItems: 10,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["action", "symbol", "qty", "order_type", "time_in_force", "rationale"],
          properties: {
            action: { type: "string", enum: ["buy", "sell", "plan", "hold"] },
            symbol: { type: "string", description: "Uppercase US ticker" },
            qty: { type: "number", description: "For plan/hold, use 0; otherwise positive integer share count" },
            order_type: { type: "string", enum: ["market", "limit"] },
            limit_price: {
              type: "number",
              description: "Only set when order_type=limit",
            },
            time_in_force: { type: "string", enum: ["day", "gtc"] },
            rationale: { type: "string" },
            intent_id: {
              type: "string",
              description:
                "Set this when the decision is fulfilling a player intent from the USER INTENTS block. Bypasses universe + duplicate validators. Sizing, concentration, and buying-power caps still apply.",
            },
          },
        },
      },
      consumed_intents: {
        type: "array",
        description:
          "Outcome for every pending intent you saw. Required when USER INTENTS were present.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "status"],
          properties: {
            id: { type: "string" },
            status: {
              type: "string",
              enum: ["honored", "rejected", "deferred"],
              description:
                "honored = a buy/sell decision (with this intent_id) was emitted. rejected = cannot be done this slot. deferred = standing intent, conditions not met yet.",
            },
            reason: { type: "string" },
          },
        },
      },
    },
  },
};

export interface RoutineInput {
  slot: RoutineSlot;
  plan: OperationalPlan;
  planMarkdown: string;
  account: AccountContext;
  snapshot: MarketSnapshot;
  priorValidationFailures: { symbol: string; reason: string; atIso: string }[];
  oneShotInstruction?: string;
  userIntents?: IntentSummary[];
}

export interface RoutineLlmResult {
  decisions: RoutineDecisionsOutput;
  model: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number | null;
    cache_creation_input_tokens: number | null;
  };
  stopReason: string | null;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  if (value && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify((value as Record<string, unknown>)[k])).join(",") + "}";
  }
  return JSON.stringify(value);
}

function renderPlanLayer(plan: OperationalPlan, planMarkdown: string): string {
  return [
    "# Approved operational plan (v-latest)",
    "",
    "## Structured JSON (canonical)",
    "```json",
    stableStringify(plan),
    "```",
    "",
    "## Human summary",
    planMarkdown,
  ].join("\n");
}

function renderAccountLayer(
  account: AccountContext,
  priorFailures: { symbol: string; reason: string; atIso: string }[],
): string {
  const lines: string[] = [];
  lines.push("# Account state (as of route entry)");
  lines.push("");
  lines.push(`- account_id: ${account.accountId}`);
  lines.push(`- equity: $${account.equity.toFixed(2)}`);
  lines.push(`- cash: $${account.cash.toFixed(2)}`);
  lines.push(`- buying_power: $${account.buyingPower.toFixed(2)}`);
  lines.push(`- long_market_value: $${account.longMarketValue.toFixed(2)}`);
  lines.push(`- day_unrealized_pl: $${account.dayUnrealizedPl.toFixed(2)}`);
  lines.push("");
  lines.push("## Positions");
  if (account.positions.length === 0) {
    lines.push("(none)");
  } else {
    for (const p of account.positions) {
      lines.push(
        `- ${p.symbol}: qty=${p.qty}  avg_entry=$${p.avgEntry.toFixed(2)}  current=$${p.current.toFixed(2)}  unrealized=$${p.unrealizedPl.toFixed(2)} (${p.unrealizedPlPct.toFixed(2)}%)`,
      );
    }
  }
  lines.push("");
  lines.push("## Open / working orders (IMMUTABLE — already submitted, treat as existing intent)");
  if (account.openOrders.length === 0) {
    lines.push("(none)");
  } else {
    for (const o of account.openOrders) {
      const price = o.limitPrice != null ? `@$${o.limitPrice.toFixed(2)}` : "@market";
      lines.push(
        `- ${o.side.toUpperCase()} ${o.qty} ${o.symbol} ${o.type} ${price} ${o.timeInForce}  status=${o.status}  submitted=${o.submittedAtIso}`,
      );
    }
    lines.push("");
    lines.push(
      "Open orders are immutable for this routine. If one would satisfy a decision you'd otherwise make, skip that decision and move on. Do NOT propose to replace or cancel them — the player will manage them from Pit Wall if they want changes. The validator also blocks duplicate same-side orders on the same symbol.",
    );
  }
  lines.push("");
  lines.push("## Recent fills (last 10, most recent first)");
  if (account.recentFills.length === 0) {
    lines.push("(none)");
  } else {
    for (const o of account.recentFills) {
      const price = o.filledAvgPrice != null ? `@$${o.filledAvgPrice.toFixed(2)}` : "";
      lines.push(
        `- ${o.side.toUpperCase()} ${o.filledQty} ${o.symbol} filled${price} at ${o.filledAtIso ?? "?"}`,
      );
    }
  }
  lines.push("");
  lines.push("## Recent validation failures (fix your behavior)");
  if (priorFailures.length === 0) {
    lines.push("(none in the last few runs)");
  } else {
    for (const f of priorFailures.slice(-3)) {
      lines.push(`- ${f.symbol}: ${f.reason} (${f.atIso})`);
    }
  }
  return lines.join("\n");
}

function renderUserIntentsLayer(intents: IntentSummary[]): string {
  if (intents.length === 0) return "";
  const lines: string[] = [];
  lines.push("# USER INTENTS (override layer — must be addressed)");
  lines.push("");
  for (const it of intents) {
    const kind = it.bindingNextSlot ? "BINDING (one-shot, must address this slot)" : "STANDING (address each slot until expiry)";
    const created = new Date(it.createdAt * 1000).toISOString();
    lines.push(`- intent_id=${it.id} · ${kind} · created=${created}`);
    lines.push(`  text: ${JSON.stringify(it.text)}`);
  }
  lines.push("");
  lines.push(
    "For each intent above, include an entry in consumed_intents (id + status + reason). Decisions that fulfill an intent MUST set their intent_id field.",
  );
  return lines.join("\n");
}

function renderSnapshotLayer(snapshot: MarketSnapshot, slot: RoutineSlot, oneShotInstruction?: string): string {
  const lines: string[] = [];
  lines.push(`# Market snapshot (slot=${slot}, as_of=${snapshot.asOf})`);
  lines.push("");
  lines.push(`- market_is_open: ${snapshot.marketIsOpen}`);
  lines.push(`- next_open: ${snapshot.nextOpen}`);
  lines.push(`- next_close: ${snapshot.nextClose}`);
  lines.push(`- factor_cache: ${snapshot.factorSource}${snapshot.factorSource === "cold" ? " (warm cron hasn't populated KV yet — sentiment/technicals/regime omitted)" : ""}`);
  lines.push("");

  // Macro regime card (warm cron output)
  if (snapshot.regime) {
    const r = snapshot.regime;
    lines.push("## Macro regime (use to calibrate risk posture)");
    if (r.vixLevel != null) lines.push(`- VIX: ${r.vixLevel.toFixed(2)}${r.vixDate ? ` (as of ${r.vixDate})` : ""}`);
    if (r.yieldSpread10y2y != null) lines.push(`- 10y-2y yield spread: ${r.yieldSpread10y2y.toFixed(2)}%${r.yieldSpread10y2y < 0 ? " (INVERTED)" : ""}`);
    if (r.dxy != null) lines.push(`- DXY (broad dollar index): ${r.dxy.toFixed(2)}`);
    if (r.spy.lastClose != null) {
      const v50 = r.spy.pctVsSma50 != null ? `${r.spy.pctVsSma50.toFixed(2)}% vs SMA50` : "n/a";
      const v200 = r.spy.pctVsSma200 != null ? `${r.spy.pctVsSma200.toFixed(2)}% vs SMA200` : "n/a";
      lines.push(`- SPY: last=${r.spy.lastClose.toFixed(2)}, ${v50}, ${v200}`);
    }
    if (r.qqq.lastClose != null) {
      const v50 = r.qqq.pctVsSma50 != null ? `${r.qqq.pctVsSma50.toFixed(2)}% vs SMA50` : "n/a";
      const v200 = r.qqq.pctVsSma200 != null ? `${r.qqq.pctVsSma200.toFixed(2)}% vs SMA200` : "n/a";
      lines.push(`- QQQ: last=${r.qqq.lastClose.toFixed(2)}, ${v50}, ${v200}`);
    }
    if (r.sectorLeader && r.sectorLaggard) {
      const leadR = r.sectorLeader.return20dPct != null ? `${r.sectorLeader.return20dPct.toFixed(2)}%` : "n/a";
      const lagR = r.sectorLaggard.return20dPct != null ? `${r.sectorLaggard.return20dPct.toFixed(2)}%` : "n/a";
      lines.push(
        `- Sector leader: ${r.sectorLeader.symbol} (${r.sectorLeader.label}) ${leadR} 20d · laggard: ${r.sectorLaggard.symbol} (${r.sectorLaggard.label}) ${lagR} 20d`,
      );
    }
    if (r.sectorMomentum && r.sectorMomentum.length > 0) {
      const ranked = [...r.sectorMomentum]
        .filter((s) => s.return20dPct != null)
        .sort((a, b) => (b.return20dPct ?? 0) - (a.return20dPct ?? 0));
      if (ranked.length > 0) {
        lines.push(`- Sector momentum (20d, ranked): ${ranked.map((s) => `${s.symbol}=${(s.return20dPct ?? 0).toFixed(1)}%`).join(", ")}`);
      }
    }
    lines.push("");
  }

  lines.push("## Broader market context (use for risk-on/risk-off tone and relative strength)");
  for (const s of snapshot.broaderMarket) {
    const q = s.lastQuote;
    const qStr = q ? `mid=${q.mid.toFixed(2)}` : "no quote";
    lines.push(`### ${s.symbol} · ${s.label} — ${qStr}`);
    if (s.dailyBars.length === 0) {
      lines.push("(no bars)");
    } else {
      for (const b of s.dailyBars) {
        lines.push(`- ${b.date.slice(0, 10)}: o=${b.open.toFixed(2)} h=${b.high.toFixed(2)} l=${b.low.toFixed(2)} c=${b.close.toFixed(2)} v=${b.volume}`);
      }
    }
  }
  lines.push("");
  lines.push("## Per-plan-symbol (quote · technicals · bars · earnings · news · sentiment)");
  if (snapshot.earningsSource === "disabled") {
    lines.push("_(earnings calendar unavailable — FINNHUB_API_KEY not set; ignore earnings-based plan rules this run)_");
  }
  for (const s of snapshot.symbols) {
    const q = s.lastQuote;
    const qStr = q ? `bid=${q.bid.toFixed(2)} ask=${q.ask.toFixed(2)} mid=${q.mid.toFixed(2)}` : "no quote";
    lines.push(`### ${s.symbol} — ${qStr}`);
    if (s.earningsHint) lines.push(`- ${s.earningsHint}`);

    if (s.technicals) {
      const t = s.technicals;
      const v50 = t.pricePosVsSma50Pct != null ? `${t.pricePosVsSma50Pct.toFixed(2)}% vs SMA50` : null;
      const v200 = t.pricePosVsSma200Pct != null ? `${t.pricePosVsSma200Pct.toFixed(2)}% vs SMA200` : null;
      const rsi = t.rsi14 != null ? `RSI14=${t.rsi14.toFixed(1)}` : null;
      const atr = t.atr14PctOfPrice != null ? `ATR14=${t.atr14PctOfPrice.toFixed(2)}%` : null;
      const rv30 = t.realizedVol30dAnnPct != null ? `RV30d=${t.realizedVol30dAnnPct.toFixed(1)}%` : null;
      const fromHi = t.pctFromFiftyTwoWeekHigh != null ? `${t.pctFromFiftyTwoWeekHigh.toFixed(1)}% from 52w high` : null;
      const fromLo = t.pctFromFiftyTwoWeekLow != null ? `+${t.pctFromFiftyTwoWeekLow.toFixed(1)}% from 52w low` : null;
      const relVol = t.relativeVolume30d != null ? `relVol=${t.relativeVolume30d.toFixed(2)}x` : null;
      const parts = [v50, v200, rsi, atr, rv30, fromHi, fromLo, relVol].filter((x): x is string => !!x);
      if (parts.length > 0) lines.push(`- Technicals: ${parts.join(" · ")}`);
    }

    if (s.dailyBars.length === 0) {
      lines.push("(no bars)");
    } else {
      for (const b of s.dailyBars) {
        lines.push(`- ${b.date.slice(0, 10)}: o=${b.open.toFixed(2)} h=${b.high.toFixed(2)} l=${b.low.toFixed(2)} c=${b.close.toFixed(2)} v=${b.volume}`);
      }
    }

    if (s.sentiment && s.sentiment.scoredCount > 0) {
      const sm = s.sentiment;
      const avg = sm.averageScore != null ? sm.averageScore.toFixed(2) : "n/a";
      lines.push(
        `- Sentiment summary (${sm.scoredCount} scored): avg=${avg}, bull=${sm.bullishCount} bear=${sm.bearishCount} neutral=${sm.neutralCount} mixed=${sm.mixedCount}`,
      );
      if (sm.topHeadlines.length > 0) {
        lines.push(`  Top by abs(score):`);
        for (const h of sm.topHeadlines.slice(0, 3)) {
          lines.push(`  - [${h.label} ${h.score.toFixed(2)}] "${h.headline}" — ${h.rationale}`);
        }
      }
    }

    if (s.news.length > 0) {
      lines.push(`Recent news (last 48h, most recent first):`);
      for (const n of s.news) {
        const when = n.createdAt.replace("T", " ").slice(0, 16);
        const src = n.source ? `${n.source}` : "news";
        lines.push(`- ${when}Z · ${src} — "${n.headline}"`);
      }
    }
  }
  if (oneShotInstruction && oneShotInstruction.trim().length > 0) {
    lines.push("");
    lines.push("## USER URGENT INSTRUCTION (one-shot, overlay on slot emphasis)");
    lines.push(oneShotInstruction.trim().slice(0, 2000));
  }
  lines.push("");
  lines.push(
    `Now call submit_decisions once. Remember: at least one decision. 'hold' for open positions if nothing else applies. Respect every plan rule.`,
  );
  return lines.join("\n");
}

export async function runRoutineLlm(env: Env, input: RoutineInput): Promise<RoutineLlmResult> {
  const client = anthropic(env);
  const model = modelForSlot(input.slot);
  const response = await client.messages.create({
    model,
    max_tokens: 4096,
    system: [
      {
        type: "text",
        text: ROUTINE_SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      },
    ],
    tools: [submitDecisionsTool],
    tool_choice: { type: "auto" },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: renderPlanLayer(input.plan, input.planMarkdown),
            cache_control: { type: "ephemeral" },
          },
          {
            type: "text",
            text: renderAccountLayer(input.account, input.priorValidationFailures),
            cache_control: { type: "ephemeral" },
          },
          {
            type: "text",
            text: renderSnapshotLayer(input.snapshot, input.slot, input.oneShotInstruction),
          },
          ...(input.userIntents && input.userIntents.length > 0
            ? [
                {
                  type: "text" as const,
                  text: renderUserIntentsLayer(input.userIntents),
                },
              ]
            : []),
        ],
      },
    ],
  });

  const toolBlock = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === SUBMIT_DECISIONS_TOOL,
  );
  if (!toolBlock) {
    const textBlocks = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    throw new Error(
      `Routine LLM did not call submit_decisions. stop_reason=${response.stop_reason ?? "null"}. text: ${textBlocks.slice(0, 500)}`,
    );
  }
  const decisions = toolBlock.input as RoutineDecisionsOutput;
  if (!decisions || !Array.isArray(decisions.decisions) || decisions.decisions.length === 0) {
    throw new Error("Routine LLM submit_decisions returned an empty decisions array");
  }
  decisions.decisions = decisions.decisions.map((d: RoutineDecision) => ({
    ...d,
    symbol: String(d.symbol || "").toUpperCase(),
    qty: Number(d.qty) || 0,
  }));

  return {
    decisions,
    model,
    usage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      cache_read_input_tokens: response.usage.cache_read_input_tokens ?? null,
      cache_creation_input_tokens: response.usage.cache_creation_input_tokens ?? null,
    },
    stopReason: response.stop_reason,
  };
}
