import type {
  AlpacaAccount,
  AlpacaBar,
  AlpacaNewsItem,
  AlpacaOrder,
  AlpacaPosition,
} from "../lib/alpaca";
import {
  fetchAccount,
  fetchClock,
  fetchClosedOrders,
  fetchDailyBars,
  fetchLatestQuotes,
  fetchNews,
  fetchOpenOrders,
  fetchPositions,
  type AlpacaCreds,
} from "../lib/alpaca";
import { fetchNextEarnings, formatEarningsHint, type EarningsItem } from "../lib/finnhub";
import { fetchFmpEarningsBatch, type FmpEarnings } from "../lib/fmp";
import type { SymbolSentimentSummary } from "../lib/sentiment";
import type { TechnicalsCard } from "../lib/technicals";
import {
  readAggregatedRegime,
  readAggregatedSymbolFactors,
  type AggregatedRegime,
} from "../data/factors";

export interface OpenOrderSummary {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  type: string;
  limitPrice: number | null;
  timeInForce: string;
  status: string;
  submittedAtIso: string;
}

export interface ClosedOrderSummary extends OpenOrderSummary {
  filledQty: number;
  filledAvgPrice: number | null;
  filledAtIso: string | null;
}

export interface AccountContext {
  accountId: string;
  equity: number;
  cash: number;
  buyingPower: number;
  longMarketValue: number;
  dayUnrealizedPl: number;
  positions: {
    symbol: string;
    qty: number;
    avgEntry: number;
    current: number;
    unrealizedPl: number;
    unrealizedPlPct: number;
  }[];
  openOrders: OpenOrderSummary[];
  recentFills: ClosedOrderSummary[];
}

export interface SymbolNewsItem {
  headline: string;
  source: string;
  createdAt: string;
  /** Per-headline sentiment score from the warm cron (Haiku-classified).
   * Absent when this headline wasn't in the warm-scored set — typically
   * because it appeared between warm and the routine fire. */
  score?: number;
  label?: "bullish" | "bearish" | "neutral" | "mixed";
  rationale?: string;
}

export interface MarketSnapshot {
  asOf: string;
  marketIsOpen: boolean;
  nextOpen: string;
  nextClose: string;
  symbols: {
    symbol: string;
    lastQuote: { bid: number; ask: number; mid: number } | null;
    dailyBars: { date: string; open: number; high: number; low: number; close: number; volume: number }[];
    news: SymbolNewsItem[];
    earnings: EarningsItem | null;
    earningsHint: string | null;
    /** Pre-classified sentiment for the recent headlines (warm cron output). Null when KV is cold. */
    sentiment: SymbolSentimentSummary | null;
    /** Computed technicals from 220-day bars (warm cron output). Null when KV is cold. */
    technicals: TechnicalsCard | null;
  }[];
  broaderMarket: {
    symbol: string;
    label: string;
    lastQuote: { bid: number; ask: number; mid: number } | null;
    dailyBars: { date: string; open: number; high: number; low: number; close: number; volume: number }[];
  }[];
  earningsSource: "finnhub" | "disabled";
  /** Macro regime card from the warm cron (VIX, yield curve, DXY, sector momentum). Null when KV is cold. */
  regime: AggregatedRegime | null;
  /** Diagnostic — "warm" when at least one symbol's agg blob is present; "cold" if all reads missed. */
  factorSource: "warm" | "cold";
}

const BROADER_MARKET: { symbol: string; label: string }[] = [
  { symbol: "SPY", label: "S&P 500 ETF" },
  { symbol: "QQQ", label: "Nasdaq-100 ETF" },
  { symbol: "VIXY", label: "VIX short-term futures ETF (volatility proxy)" },
];

export async function buildAccountContext(creds: AlpacaCreds): Promise<AccountContext> {
  const [account, positions, openOrders, closedOrders] = await Promise.all([
    fetchAccount(creds.apiKey, creds.apiSecret),
    fetchPositions(creds),
    fetchOpenOrders(creds).catch(() => [] as AlpacaOrder[]),
    fetchClosedOrders(creds, 10).catch(() => [] as AlpacaOrder[]),
  ]);
  return accountContextFrom(account, positions, openOrders, closedOrders);
}

function summarizeOrder(o: AlpacaOrder): OpenOrderSummary {
  return {
    id: o.id,
    symbol: o.symbol,
    side: o.side,
    qty: Number(o.qty),
    type: o.order_type,
    limitPrice: o.limit_price != null ? Number(o.limit_price) : null,
    timeInForce: o.time_in_force,
    status: o.status,
    submittedAtIso: o.submitted_at,
  };
}

export function accountContextFrom(
  account: AlpacaAccount,
  positions: AlpacaPosition[],
  openOrders: AlpacaOrder[] = [],
  closedOrders: AlpacaOrder[] = [],
): AccountContext {
  return {
    accountId: account.id,
    equity: Number(account.equity),
    cash: Number(account.cash),
    buyingPower: Number(account.buying_power),
    longMarketValue: Number(account.long_market_value),
    dayUnrealizedPl: positions.reduce((s, p) => s + Number(p.unrealized_pl), 0),
    positions: positions.map((p) => ({
      symbol: p.symbol,
      qty: Number(p.qty),
      avgEntry: Number(p.avg_entry_price),
      current: Number(p.current_price),
      unrealizedPl: Number(p.unrealized_pl),
      unrealizedPlPct: Number(p.unrealized_plpc) * 100,
    })),
    openOrders: openOrders.map(summarizeOrder),
    recentFills: closedOrders
      .filter((o) => o.status === "filled" || Number(o.filled_qty) > 0)
      .map((o) => ({
        ...summarizeOrder(o),
        filledQty: Number(o.filled_qty),
        filledAvgPrice: o.filled_avg_price != null ? Number(o.filled_avg_price) : null,
        filledAtIso: o.filled_at,
      })),
  };
}

export async function buildMarketSnapshot(
  env: Env,
  creds: AlpacaCreds,
  symbols: string[],
): Promise<MarketSnapshot> {
  const planSymbols = Array.from(new Set(symbols.map((s) => s.toUpperCase()))).slice(0, 40);
  const broaderSymbols = BROADER_MARKET.map((b) => b.symbol);
  const allSymbols = Array.from(new Set([...planSymbols, ...broaderSymbols]));
  const [clock, quotes, bars, news, earnings, fmpEarnings, aggSymbols, regime] = await Promise.all([
    fetchClock(creds),
    fetchLatestQuotes(creds, allSymbols).catch(
      () => ({}) as Record<string, { bid: number; ask: number; last: number }>,
    ),
    fetchDailyBars(creds, allSymbols, 7).catch(() => ({}) as Record<string, AlpacaBar[]>),
    fetchNews(creds, planSymbols, 40, 48).catch(
      () => ({}) as Record<string, AlpacaNewsItem[]>,
    ),
    fetchNextEarnings(env, planSymbols),
    fetchFmpEarningsBatch(env, planSymbols).catch(
      () =>
        ({ bySymbol: {} as Record<string, FmpEarnings | null>, source: "disabled" as const }),
    ),
    Promise.all(planSymbols.map((s) => readAggregatedSymbolFactors(env, s).catch(() => null))),
    readAggregatedRegime(env).catch(() => null),
  ]);

  // Merge FMP revenue + EPS data into the Finnhub-sourced EarningsItem.
  // Finnhub free returns EPS only; FMP fills in revActual/revEstimate where it
  // can. If FMP has more recent EPS data (e.g. a freshly-reported quarter that
  // Finnhub hasn't refreshed yet), prefer those too.
  const mergedEarnings: Record<string, EarningsItem | null> = {};
  for (const [sym, finn] of Object.entries(earnings.bySymbol)) {
    const fmp = fmpEarnings.bySymbol[sym];
    if (!finn && !fmp) {
      mergedEarnings[sym] = null;
      continue;
    }
    if (!finn && fmp) {
      mergedEarnings[sym] = {
        symbol: sym,
        date: fmp.date,
        hour: "",
        epsActual: fmp.epsActual,
        epsEstimate: fmp.epsEstimate,
        revActual: fmp.revActual,
        revEstimate: fmp.revEstimate,
        quarter: null,
        year: null,
      };
      continue;
    }
    if (finn && fmp) {
      mergedEarnings[sym] = {
        ...finn,
        epsActual: finn.epsActual ?? fmp.epsActual,
        epsEstimate: finn.epsEstimate ?? fmp.epsEstimate,
        revActual: finn.revActual ?? fmp.revActual,
        revEstimate: finn.revEstimate ?? fmp.revEstimate,
      };
      continue;
    }
    mergedEarnings[sym] = finn ?? null;
  }
  const earningsLookup = { bySymbol: mergedEarnings, source: earnings.source };
  const aggBySymbol = new Map<string, (typeof aggSymbols)[number]>();
  planSymbols.forEach((s, i) => aggBySymbol.set(s, aggSymbols[i] ?? null));
  const anyAggHit = aggSymbols.some((b) => b != null) || regime != null;

  const renderBroader = (sym: string) => {
    const q = quotes[sym];
    const symbolBars = (bars[sym] ?? []).slice(-5);
    return {
      symbol: sym,
      lastQuote: q ? { bid: q.bid, ask: q.ask, mid: q.last } : null,
      dailyBars: symbolBars.map((b) => ({
        date: b.t,
        open: b.o,
        high: b.h,
        low: b.l,
        close: b.c,
        volume: b.v,
      })),
    };
  };
  const renderPlanSymbol = (sym: string) => {
    const base = renderBroader(sym);
    const earn = earningsLookup.bySymbol[sym] ?? null;
    const agg = aggBySymbol.get(sym) ?? null;
    // Build an ID-keyed lookup of warm-scored headlines so each live news item
    // gets the score/label/rationale attached when warm scored it. Headlines
    // that appeared after the warm fire stay unscored — that's the real state.
    const aggHeadlineMap = new Map<number, NonNullable<typeof agg>["recentHeadlinesSlim"][number]>();
    for (const h of agg?.recentHeadlinesSlim ?? []) aggHeadlineMap.set(h.id, h);
    const nList: SymbolNewsItem[] = (news[sym] ?? []).slice(0, 5).map((n) => {
      const sc = aggHeadlineMap.get(n.id);
      return {
        headline: n.headline,
        source: n.source,
        createdAt: n.createdAt,
        score: sc?.score,
        label: sc?.label,
        rationale: sc?.rationale,
      };
    });
    return {
      ...base,
      news: nList,
      earnings: earn,
      earningsHint: formatEarningsHint(earn),
      sentiment: agg?.scoredSentiment ?? null,
      technicals: agg?.technicals ?? null,
    };
  };
  return {
    asOf: clock.timestamp,
    marketIsOpen: clock.is_open,
    nextOpen: clock.next_open,
    nextClose: clock.next_close,
    symbols: planSymbols.map(renderPlanSymbol),
    broaderMarket: BROADER_MARKET.map((b) => ({
      label: b.label,
      ...renderBroader(b.symbol),
    })),
    earningsSource: earningsLookup.source,
    regime,
    factorSource: anyAggHit ? "warm" : "cold",
  };
}
