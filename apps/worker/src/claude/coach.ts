import Anthropic from "@anthropic-ai/sdk";
import type { CoachDraft, CoachMessage, CoachPlanRevision, CoachPlaybookRevision } from "shared/coach";
import type { IntentSummary } from "shared/intent";
import type { OperationalPlan } from "shared/playbook";
import { anthropic } from "./client";
import { OPUS_MODEL } from "./prompts";
import { submitPlanTool } from "./tools";
import {
  readAggregatedSymbolFactors,
  refreshFactors,
  type AggregatedSymbolFactors,
  type CoachMarketContext,
} from "../data/factors";
import type { GameState } from "../data/game-state";
import type { AlpacaCreds } from "../lib/alpaca";

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
- When the player asks about an untradable asset (crypto, futures, FX, non-US listings, options): explain it's not tradable here and suggest the closest US-listed proxy. Examples: bitcoin → IBIT or FBTC; ether → ETHA; gold → GLD or IAU; oil → USO or XLE; euro → FXE; treasuries → TLT (long) / IEF (mid) / SHY (short); China → MCHI or KWEB; Japan → EWJ. Never call \`lookup_symbol_factors\` with an untradable ticker.
- Execution: the player does NOT trade manually (mostly). Claude Opus runs 5 routines per trading day — premarket (9:15 ET), open (9:35 ET), midmorning (11:30 ET), afternoon (2:00 ET), close (3:45 ET) — and at each slot reads the playbook, looks at the account, and decides what to buy, sell, or leave alone.
- Order types: market and limit, day or GTC. No server-side stops.
- The player CAN override at the trade level via "intents" (binding one-shot or standing) and via direct orders that bypass the plan entirely. You do NOT manage those — the player does.
- Leaderboard: ranks by total return on $100k starting equity, updated after each routine.

CONTEXT YOU GET (in addition to <current_strategy>):
- <market_context> — live regime card (VIX, yield curve, DXY, SPY/QQQ trend, sector rotation 20d) plus per-universe-symbol factors (profile, fundamentals, technicals, per-headline sentiment scores when cached, earnings dates, recent headlines). Use this to ground critique in the actual market — "ATR14=4.2% but your stop_loss_pct=2 — you'll be stopped out by noise" beats "your stop seems tight". When sentiment scores are available, quote the strongest signals. When a factor is "n/a", say so plainly rather than inventing.
- <game_state> — the player's equity curve, leaderboard rank + delta to leader, days remaining in the comp, win rate / avg winner / avg loser / profit factor, slot performance breakdown. Use this to time recommendations: "8 days left, rank 3, down 1.8% to leader" calls for a different tilt than "day 2, rank 1". When pointing out slot weakness, cite the numbers ("afternoon trades: 0/5 winners net -$840").
- The \`lookup_symbol_factors\` tool — when the player asks about a symbol or instrument NOT already in <market_context>, call this tool to fetch its factor card live (profile, technicals, sentiment, headlines, earnings). Examples: player asks about oil, you call lookup with ["USO", "BNO", "XLE"]; player mentions "is META cheap" and META isn't in the universe, you call lookup with ["META"]. Skip if the symbol is already in <market_context>. Skip for general macro questions you can answer from the regime card. Cap at 5 symbols/turn. The returned data is then yours to quote and reason over in your reply.

STYLE:
- Pit-wall engineer, not life coach. Direct, F1-flavored when natural.
- ALWAYS open with one short sentence acknowledging what you're about to do — e.g. "Looking at your AAPL position now," "Pulling up your universe," "Reviewing your sizing rule." This sentence streams to the player FIRST so they know you're working. Never start with a multi-sentence preamble.
- After the ack, keep the rest tight — 2-3 sentences plus the tool call when one's needed.
- One sharp question or one specific suggestion per turn.
- Cite specific numbers from the new context blocks when you make claims. "RSI14=72, vs50d=+8.4%, 20-day sector momentum leading — momentum is real, not just noise" carries more weight than "looks bullish".
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

const lookupSymbolFactorsTool: Anthropic.Tool = {
  name: "lookup_symbol_factors",
  description:
    "Fetch live factor data for symbols NOT already in <market_context>. Triggers a refresh from Finnhub/FRED/Alpaca + Haiku-scored sentiment, caches the result for future turns, and returns the factor card so you can quote specific numbers in your reply. Use only when the player asks about a ticker, sector ETF, or instrument that isn't already in the universe. STRICT CONSTRAINT: only US-listed equities and ADRs are tradable on Alpaca paper. Do NOT call lookup with crypto tickers (BTC, ETH), FX (EURUSD), futures (CL, ES), or non-US listings (BARC.L, 7203.T) — they will return empty and waste a turn. For untradable assets the player asks about, suggest the closest US-listed proxy ETF in your reply instead of calling lookup.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["symbols", "rationale"],
    properties: {
      symbols: {
        type: "array",
        minItems: 1,
        maxItems: 5,
        items: { type: "string", minLength: 1, maxLength: 8 },
        description: "Uppercase US ticker symbols to fetch (e.g. ['USO', 'XLE']). Max 5 per call.",
      },
      rationale: {
        type: "string",
        maxLength: 200,
        description:
          "One short phrase telling the player what you're checking — shown in the chat as 'Looking up X (rationale)'. Example: 'oil exposure check'.",
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
  marketContext: CoachMarketContext | null;
  gameState: GameState | null;
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

function fmt(n: number | null | undefined, dp = 2, suffix = ""): string {
  if (n == null || !Number.isFinite(n)) return "n/a";
  return `${n.toFixed(dp)}${suffix}`;
}

function renderMarketContext(mc: CoachMarketContext | null): string {
  if (!mc) return "<market_context>(unavailable)</market_context>";
  const lines: string[] = [];
  lines.push("<market_context>");
  // --- Regime card (nullable until first cron-warm) ---
  const r = mc.regime;
  if (!r) {
    lines.push("# Macro regime: (no cached regime card yet — premarket cron hasn't populated it)");
  } else {
    lines.push("# Macro regime");
    if (r.vixLevel != null) {
      const band = r.vixLevel < 15 ? "calm" : r.vixLevel < 22 ? "elevated" : r.vixLevel < 30 ? "nervous" : "panic";
      lines.push(`- VIX: ${fmt(r.vixLevel, 2)} (${band}) [${r.vixDate ?? "?"}]`);
    } else {
      lines.push("- VIX: n/a");
    }
    if (r.yieldSpread10y2y != null) {
      const flag = r.yieldSpread10y2y < 0 ? "INVERTED" : r.yieldSpread10y2y < 0.5 ? "flat" : "positive";
      lines.push(`- 10y-2y curve: ${fmt(r.yieldSpread10y2y, 2)}pp (${flag}) [${r.yieldSpreadDate ?? "?"}]`);
    }
    if (r.dxy != null) lines.push(`- USD index (DXY): ${fmt(r.dxy, 2)} [${r.dxyDate ?? "?"}]`);
    lines.push(
      `- SPY: close=${fmt(r.spy.lastClose, 2)}, vs50d=${fmt(r.spy.pctVsSma50, 2, "%")}, vs200d=${fmt(r.spy.pctVsSma200, 2, "%")}`,
    );
    lines.push(
      `- QQQ: close=${fmt(r.qqq.lastClose, 2)}, vs50d=${fmt(r.qqq.pctVsSma50, 2, "%")}, vs200d=${fmt(r.qqq.pctVsSma200, 2, "%")}`,
    );
    if (r.sectorLeader && r.sectorLaggard) {
      lines.push(
        `- Sector rotation 20d: leader ${r.sectorLeader.label} (${r.sectorLeader.symbol}, ${fmt(r.sectorLeader.return20dPct, 2, "%")}); laggard ${r.sectorLaggard.label} (${r.sectorLaggard.symbol}, ${fmt(r.sectorLaggard.return20dPct, 2, "%")})`,
      );
    }
  }

  // --- Per-symbol factor cards ---
  if (mc.symbols.length > 0) {
    lines.push("");
    lines.push("# Per-universe-symbol factors");
    for (const s of mc.symbols) {
      lines.push(`## ${s.symbol}`);
      if (s.profile) {
        const cap = s.profile.marketCapMillionsUsd;
        const capStr = cap == null ? "n/a" : cap >= 1_000_000 ? `$${(cap / 1_000_000).toFixed(2)}T` : cap >= 1_000 ? `$${(cap / 1_000).toFixed(1)}B` : `$${cap.toFixed(0)}M`;
        lines.push(`- ${s.profile.name ?? "?"} | ${s.profile.industry ?? "?"} | ${s.profile.exchange ?? "?"} | mcap=${capStr}`);
      }
      if (s.metrics) {
        const m = s.metrics;
        const parts: string[] = [];
        if (m.beta != null) parts.push(`beta=${fmt(m.beta, 2)}`);
        if (m.pe != null) parts.push(`P/E=${fmt(m.pe, 1)}`);
        if (m.ps != null) parts.push(`P/S=${fmt(m.ps, 1)}`);
        if (m.netMarginPct != null) parts.push(`netMargin=${fmt(m.netMarginPct, 1, "%")}`);
        if (m.shortInterestPct != null) parts.push(`shortInt=${fmt(m.shortInterestPct, 1, "%")}`);
        if (m.dividendYieldPct != null) parts.push(`divYld=${fmt(m.dividendYieldPct, 2, "%")}`);
        if (parts.length > 0) lines.push(`- fundamentals: ${parts.join(", ")}`);
      }
      if (s.technicals) {
        const t = s.technicals;
        const parts: string[] = [];
        if (t.lastClose != null) parts.push(`close=${fmt(t.lastClose, 2)}`);
        if (t.pricePosVsSma50Pct != null) parts.push(`vs50d=${fmt(t.pricePosVsSma50Pct, 2, "%")}`);
        if (t.pricePosVsSma200Pct != null) parts.push(`vs200d=${fmt(t.pricePosVsSma200Pct, 2, "%")}`);
        if (t.rsi14 != null) parts.push(`RSI14=${fmt(t.rsi14, 1)}`);
        if (t.atr14PctOfPrice != null) parts.push(`ATR14=${fmt(t.atr14PctOfPrice, 2, "%")}`);
        if (t.realizedVol30dAnnPct != null) parts.push(`realizedVol30d=${fmt(t.realizedVol30dAnnPct, 1, "%")}`);
        if (t.pctFromFiftyTwoWeekHigh != null) parts.push(`fromHi52w=${fmt(t.pctFromFiftyTwoWeekHigh, 2, "%")}`);
        if (t.pctFromFiftyTwoWeekLow != null) parts.push(`fromLo52w=${fmt(t.pctFromFiftyTwoWeekLow, 2, "%")}`);
        if (parts.length > 0) lines.push(`- technicals: ${parts.join(", ")}`);
      }
      if (s.scoredSentiment && s.scoredSentiment.scoredCount > 0) {
        const ss = s.scoredSentiment;
        lines.push(
          `- sentiment (per-headline, n=${ss.scoredCount}): avg=${fmt(ss.averageScore, 2)}, bullish=${ss.bullishCount}, bearish=${ss.bearishCount}, neutral=${ss.neutralCount}, mixed=${ss.mixedCount}`,
        );
        for (const h of ss.topHeadlines.slice(0, 3)) {
          lines.push(`  - [${h.label} ${fmt(h.score, 2)}] ${h.headline}`);
        }
      }
      if (s.earningsHint) lines.push(`- earnings: ${s.earningsHint}`);
      if (s.recentHeadlinesSlim.length > 0) {
        lines.push(`- recent headlines (last 48h, top ${Math.min(3, s.recentHeadlinesSlim.length)}):`);
        for (const h of s.recentHeadlinesSlim.slice(0, 3)) {
          lines.push(`  - ${h.headline} (${h.source})`);
        }
      }
    }
  }

  if (mc.staleSymbols.length > 0) {
    lines.push("");
    lines.push(
      `# Stale (no factor cache): ${mc.staleSymbols.join(", ")} — premarket refresh hasn't populated these yet. Don't fabricate factor numbers for them.`,
    );
  }

  lines.push("</market_context>");
  return lines.join("\n");
}

function renderGameState(gs: GameState | null): string {
  if (!gs) return "<game_state>(unavailable)</game_state>";
  const lines: string[] = [];
  lines.push("<game_state>");
  if (gs.equityNow != null) {
    lines.push(
      `- Equity: $${gs.equityNow.toFixed(2)} (start $${gs.startingEquity.toFixed(0)}, total return ${fmt(gs.totalReturnPct, 2, "%")})`,
    );
  }
  if (gs.intradayPlPct != null) lines.push(`- Intraday P&L: ${fmt(gs.intradayPlPct, 2, "%")}`);
  if (gs.maxDrawdownPct != null) lines.push(`- Max drawdown to date: ${fmt(gs.maxDrawdownPct, 2, "%")}`);
  if (gs.daysElapsed != null && gs.daysRemaining != null) {
    lines.push(`- Comp progress: day ${gs.daysElapsed} of ~${gs.daysElapsed + gs.daysRemaining} (${gs.daysRemaining} remaining)`);
  } else if (gs.daysRemaining != null) {
    lines.push(`- Days remaining: ${gs.daysRemaining}`);
  }
  if (gs.myRank != null) {
    const lead = gs.deltaToLeaderPct;
    const leadStr =
      lead == null ? "" : lead === 0 ? " (leading)" : ` (${lead > 0 ? "ahead of" : "behind"} leader by ${fmt(Math.abs(lead), 2, "%")})`;
    lines.push(`- Leaderboard: rank ${gs.myRank} of ${gs.leaderboard.length}${leadStr}`);
  }
  if (gs.totalTrades > 0) {
    const parts: string[] = [];
    if (gs.winRatePct != null) parts.push(`win rate ${fmt(gs.winRatePct, 0, "%")}`);
    if (gs.avgWinner != null) parts.push(`avg win $${gs.avgWinner.toFixed(2)}`);
    if (gs.avgLoser != null) parts.push(`avg loss $${gs.avgLoser.toFixed(2)}`);
    if (gs.profitFactor != null) parts.push(`PF=${fmt(gs.profitFactor, 2)}`);
    lines.push(
      `- Trades: ${gs.totalTrades} total (${gs.aiTrades} AI / ${gs.directTrades} direct)${parts.length > 0 ? "; " + parts.join(", ") : ""}`,
    );
  }
  const slotRows = gs.bySlot.filter((s) => s.trades > 0);
  if (slotRows.length > 0) {
    lines.push("- Slot performance (net realized $, FIFO approximation):");
    for (const s of slotRows) {
      lines.push(`  - ${s.slot}: ${s.trades} trades, $${s.netRealized.toFixed(2)}`);
    }
  }
  if (gs.leaderboard.length > 1) {
    lines.push("- Leaderboard standings:");
    for (const row of gs.leaderboard) {
      const eq = row.equity != null ? `$${row.equity.toFixed(2)}` : "n/a";
      const d = row.delta24hPct != null ? ` (24h ${fmt(row.delta24hPct, 2, "%")})` : "";
      lines.push(`  ${row.rank}. ${row.displayName}: ${eq}${d}`);
    }
  }
  lines.push("</game_state>");
  return lines.join("\n");
}

export interface CoachLookupEvent {
  status: "started" | "completed";
  symbols: string[];
  rationale?: string;
  resolvedCount?: number;
  failedSymbols?: string[];
}

export interface CoachStreamHandlers {
  onText?: (delta: string) => void | Promise<void>;
  onLookup?: (event: CoachLookupEvent) => void | Promise<void>;
  signal?: AbortSignal;
}

export interface CoachTurnTools {
  /** Alpaca creds used by lookup_symbol_factors to fetch news + bars. If null, the lookup tool is removed from the toolset. */
  creds: AlpacaCreds | null;
}

export async function coachTurn(
  env: Env,
  messages: CoachMessage[],
  ctx: CoachContext,
  handlers: CoachStreamHandlers = {},
  tools: CoachTurnTools = { creds: null },
): Promise<CoachTurnResult> {
  const client = anthropic(env);
  const contextBlock = renderContext(ctx);
  const marketContextBlock = renderMarketContext(ctx.marketContext);
  const gameStateBlock = renderGameState(ctx.gameState);

  const systemBlocks: Anthropic.TextBlockParam[] = [
    { type: "text", text: COACH_SYSTEM, cache_control: { type: "ephemeral" } },
    { type: "text", text: contextBlock },
    { type: "text", text: marketContextBlock },
    { type: "text", text: gameStateBlock },
  ];

  // Tools list: include lookup_symbol_factors only if we have Alpaca creds to back it.
  const toolsRound1: Anthropic.Tool[] = [
    commitDraftTool,
    proposePlaybookRevisionTool,
    proposePlanRevisionTool,
  ];
  if (tools.creds) toolsRound1.unshift(lookupSymbolFactorsTool);

  // Convert input messages once so we can re-use them in the continuation loop.
  const apiMessages: Anthropic.MessageParam[] = messages.map((m) => ({ role: m.role, content: m.content }));

  // ---- Round 1: initial Claude call ----
  const stream1 = client.messages.stream(
    {
      model: OPUS_MODEL,
      max_tokens: 8192,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
      system: systemBlocks,
      tools: toolsRound1,
      tool_choice: { type: "auto" },
      messages: apiMessages,
    },
    { signal: handlers.signal },
  );
  for await (const event of stream1) {
    if (
      event.type === "content_block_delta" &&
      event.delta.type === "text_delta" &&
      handlers.onText
    ) {
      await handlers.onText(event.delta.text);
    }
  }
  const final1 = await stream1.finalMessage();

  // ---- Tool extraction (round 1) ----
  // We pull final tools (commit_draft, propose_*) from whichever round actually
  // produced them; lookup is only honored from round 1 to prevent loops.
  let draft: CoachDraft | null = null;
  let playbookRevision: CoachPlaybookRevision | null = null;
  let planRevision: CoachPlanRevision | null = null;
  let lookupBlock: Anthropic.ToolUseBlock | null = null;
  for (const block of final1.content) {
    if (block.type !== "tool_use") continue;
    if (block.name === "lookup_symbol_factors") {
      // Honor only the first lookup if the model emits multiple.
      if (!lookupBlock) lookupBlock = block;
    } else {
      extractTerminalTool(block, (tool) => {
        if (tool.kind === "draft") draft = tool.value;
        else if (tool.kind === "playbook") playbookRevision = tool.value;
        else if (tool.kind === "plan") planRevision = tool.value;
      });
    }
  }

  let final2: Anthropic.Message | null = null;

  // ---- Round 2: if a lookup was requested, execute it and continue the conversation ----
  if (lookupBlock && tools.creds) {
    const input = lookupBlock.input as { symbols?: unknown; rationale?: unknown };
    const requested = Array.isArray(input.symbols)
      ? input.symbols
          .filter((s): s is string => typeof s === "string" && s.length > 0)
          .map((s) => s.toUpperCase())
          .slice(0, 5)
      : [];
    const rationale = typeof input.rationale === "string" ? input.rationale : undefined;

    if (requested.length > 0) {
      await handlers.onLookup?.({ status: "started", symbols: requested, rationale });
      const refreshed = await refreshFactors(env, tools.creds, requested, { uncapped: false });
      const cards = await Promise.all(requested.map((s) => readAggregatedSymbolFactors(env, s)));
      const failedSymbols = refreshed.failures
        .map((f) => f.symbol)
        .filter((s): s is string => typeof s === "string");
      const resolvedCount = cards.filter((c) => c != null).length;
      await handlers.onLookup?.({
        status: "completed",
        symbols: requested,
        rationale,
        resolvedCount,
        failedSymbols,
      });

      const toolResultText = JSON.stringify(buildLookupToolResult(requested, cards), null, 0);

      // Continuation: assistant turn (with lookup tool_use) + user turn (tool_result)
      const continuation: Anthropic.MessageParam[] = [
        ...apiMessages,
        { role: "assistant", content: final1.content },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: lookupBlock.id,
              content: toolResultText,
            },
          ],
        },
      ];

      // Round 2: same tools EXCEPT no lookup (prevents nested lookup loops).
      const toolsRound2: Anthropic.Tool[] = [
        commitDraftTool,
        proposePlaybookRevisionTool,
        proposePlanRevisionTool,
      ];

      const stream2 = client.messages.stream(
        {
          model: OPUS_MODEL,
          max_tokens: 8192,
          thinking: { type: "adaptive" },
          output_config: { effort: "medium" },
          system: systemBlocks,
          tools: toolsRound2,
          tool_choice: { type: "auto" },
          messages: continuation,
        },
        { signal: handlers.signal },
      );
      for await (const event of stream2) {
        if (
          event.type === "content_block_delta" &&
          event.delta.type === "text_delta" &&
          handlers.onText
        ) {
          await handlers.onText(event.delta.text);
        }
      }
      final2 = await stream2.finalMessage();

      // Pull terminal tools from round 2 (overrides any from round 1, which
      // shouldn't have any anyway since lookup was the only tool call).
      for (const block of final2.content) {
        if (block.type !== "tool_use") continue;
        extractTerminalTool(block, (tool) => {
          if (tool.kind === "draft") draft = tool.value;
          else if (tool.kind === "playbook") playbookRevision = tool.value;
          else if (tool.kind === "plan") planRevision = tool.value;
        });
      }
    }
  }

  // ---- Compose final assistant text from both rounds ----
  const text1 = textOf(final1);
  const text2 = final2 ? textOf(final2) : "";
  const assistantText = [text1, text2].filter((s) => s.length > 0).join("\n\n").trim();

  // Token usage: sum across rounds.
  const usage1 = final1.usage;
  const usage2 = final2?.usage;
  return {
    assistantText,
    draft,
    playbookRevision,
    planRevision,
    usage: {
      input_tokens: usage1.input_tokens + (usage2?.input_tokens ?? 0),
      output_tokens: usage1.output_tokens + (usage2?.output_tokens ?? 0),
      cache_read_input_tokens:
        (usage1.cache_read_input_tokens ?? 0) + (usage2?.cache_read_input_tokens ?? 0) || null,
      cache_creation_input_tokens:
        (usage1.cache_creation_input_tokens ?? 0) + (usage2?.cache_creation_input_tokens ?? 0) || null,
    },
  };
}

function textOf(msg: Anthropic.Message): string {
  return msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n\n");
}

type TerminalToolEmit =
  | { kind: "draft"; value: CoachDraft }
  | { kind: "playbook"; value: CoachPlaybookRevision }
  | { kind: "plan"; value: CoachPlanRevision };

function extractTerminalTool(
  block: Anthropic.ToolUseBlock,
  emit: (t: TerminalToolEmit) => void,
): void {
  const input = block.input as Record<string, unknown>;
  if (block.name === "commit_draft") {
    emit({
      kind: "draft",
      value: { goal: String(input.goal ?? ""), playbook: String(input.playbook ?? "") },
    });
  } else if (block.name === "propose_playbook_revision") {
    emit({
      kind: "playbook",
      value: {
        goal: String(input.goal ?? ""),
        playbook: String(input.playbook ?? ""),
        rationale: String(input.rationale ?? ""),
      },
    });
  } else if (block.name === "propose_plan_revision") {
    const { rationale, ...planFields } = input as { rationale?: string } & Record<string, unknown>;
    emit({
      kind: "plan",
      value: {
        plan: planFields as unknown as OperationalPlan,
        rationale: String(rationale ?? ""),
      },
    });
  }
}

interface LookupToolResultEntry {
  symbol: string;
  found: boolean;
  factors: AggregatedSymbolFactors | null;
}

function buildLookupToolResult(
  requested: string[],
  cards: Array<AggregatedSymbolFactors | null>,
): { symbols: LookupToolResultEntry[] } {
  return {
    symbols: requested.map((sym, i) => ({
      symbol: sym,
      found: cards[i] != null,
      factors: cards[i] ?? null,
    })),
  };
}
