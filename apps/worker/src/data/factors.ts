import type { AlpacaBar, AlpacaCreds, AlpacaNewsItem } from "../lib/alpaca";
import { fetchLongDailyBars, fetchNews } from "../lib/alpaca";
import { compute20dReturn, computeTechnicals, type TechnicalsCard } from "../lib/technicals";
import {
  fetchEconomicCalendar,
  fetchMetrics,
  fetchNextEarnings,
  fetchProfile,
  formatEarningsHint,
  type FinnhubEconomicEvent,
  type FinnhubMetrics,
  type FinnhubProfile,
  type EarningsItem,
} from "../lib/finnhub";
import { fetchSeriesLatest, type FredObservation } from "../lib/fred";
import {
  classifyHeadlinesBatch,
  summarizeScores,
  type HeadlineScore,
  type SymbolSentimentSummary,
} from "../lib/sentiment";

export const MACRO_SERIES = {
  vix: "VIXCLS",
  yieldSpread10y2y: "T10Y2Y",
  dxy: "DTWEXBGS",
} as const;

export interface MacroSnapshot {
  vix: FredObservation | null;
  yieldSpread10y2y: FredObservation | null;
  dxy: FredObservation | null;
  source: "fred" | "partial" | "disabled";
  errors: string[];
}

export interface SymbolFactors {
  symbol: string;
  profile: FinnhubProfile | null;
  metrics: FinnhubMetrics | null;
  earnings: EarningsItem | null;
  earningsHint: string | null;
  recentHeadlines: AlpacaNewsItem[];
  scoredSentiment: SymbolSentimentSummary | null;
  technicals: TechnicalsCard | null;
  errors: string[];
}

// Sector ETFs we use for rotation/breadth signals. Same set spans the major SPDR sleeves.
const SECTOR_ETFS: { symbol: string; label: string }[] = [
  { symbol: "XLK", label: "Technology" },
  { symbol: "XLF", label: "Financials" },
  { symbol: "XLE", label: "Energy" },
  { symbol: "XLV", label: "Health Care" },
  { symbol: "XLY", label: "Consumer Discretionary" },
  { symbol: "XLP", label: "Consumer Staples" },
  { symbol: "XLI", label: "Industrials" },
  { symbol: "XLU", label: "Utilities" },
  { symbol: "XLRE", label: "Real Estate" },
  { symbol: "XLB", label: "Materials" },
  { symbol: "XLC", label: "Communication Services" },
];

const BREADTH_INDEXES: { symbol: string; label: string }[] = [
  { symbol: "SPY", label: "S&P 500" },
  { symbol: "QQQ", label: "Nasdaq-100" },
];

export interface SectorMomentum {
  symbol: string;
  label: string;
  return20dPct: number | null;
}

export interface RegimeCard {
  asOfSec: number;
  vixLevel: number | null;
  vixDate: string | null;
  yieldSpread10y2y: number | null;
  yieldSpreadDate: string | null;
  dxy: number | null;
  dxyDate: string | null;
  spy: { lastClose: number | null; pctVsSma50: number | null; pctVsSma200: number | null };
  qqq: { lastClose: number | null; pctVsSma50: number | null; pctVsSma200: number | null };
  sectorLeader: SectorMomentum | null;
  sectorLaggard: SectorMomentum | null;
  sectorMomentum: SectorMomentum[];
  errors: string[];
}

export interface ProviderStatus {
  ok: boolean;
  source: string;
  reason?: string;
  sample?: unknown;
}

export interface ConnectivityResult {
  finnhub: ProviderStatus;
  fred: ProviderStatus;
  alpacaNews: ProviderStatus;
}

export async function loadMacroSnapshot(env: Env): Promise<MacroSnapshot> {
  const errors: string[] = [];
  const [vixR, ycR, dxyR] = await Promise.all([
    fetchSeriesLatest(env, MACRO_SERIES.vix),
    fetchSeriesLatest(env, MACRO_SERIES.yieldSpread10y2y),
    fetchSeriesLatest(env, MACRO_SERIES.dxy),
  ]);
  const vix = vixR.source === "fred" ? vixR.observation : null;
  const yieldSpread10y2y = ycR.source === "fred" ? ycR.observation : null;
  const dxy = dxyR.source === "fred" ? dxyR.observation : null;
  if (vixR.source !== "fred") errors.push(vixR.reason);
  if (ycR.source !== "fred") errors.push(ycR.reason);
  if (dxyR.source !== "fred") errors.push(dxyR.reason);
  const allOk = vix && yieldSpread10y2y && dxy;
  const noneOk = !vix && !yieldSpread10y2y && !dxy;
  return {
    vix,
    yieldSpread10y2y,
    dxy,
    source: allOk ? "fred" : noneOk ? "disabled" : "partial",
    errors,
  };
}

export async function loadSymbolFactors(
  env: Env,
  creds: AlpacaCreds,
  symbol: string,
  options: {
    includeNews?: boolean;
    sentimentScoring?: "cache_only" | "skip";
    includeTechnicals?: boolean;
  } = {},
): Promise<SymbolFactors> {
  const sym = symbol.toUpperCase();
  const includeNews = options.includeNews ?? true;
  const sentimentScoring = options.sentimentScoring ?? "cache_only";
  const includeTechnicals = options.includeTechnicals ?? true;
  const errors: string[] = [];

  const [profileR, metricsR, earningsR, newsR, barsR] = await Promise.all([
    fetchProfile(env, sym).catch((err): { source: "disabled"; reason: string } => ({
      source: "disabled",
      reason: `profile error: ${err instanceof Error ? err.message : String(err)}`,
    })),
    fetchMetrics(env, sym).catch((err): { source: "disabled"; reason: string } => ({
      source: "disabled",
      reason: `metrics error: ${err instanceof Error ? err.message : String(err)}`,
    })),
    fetchNextEarnings(env, [sym]).catch(() => null),
    includeNews
      ? fetchNews(creds, [sym], 30, 48).catch((): Record<string, AlpacaNewsItem[]> => ({}))
      : Promise.resolve({} as Record<string, AlpacaNewsItem[]>),
    includeTechnicals
      ? fetchLongDailyBars(creds, env.CACHE, [sym], 220).catch((): Record<string, AlpacaBar[]> => ({}))
      : Promise.resolve({} as Record<string, AlpacaBar[]>),
  ]);

  const profile = profileR.source === "finnhub" ? profileR.data : null;
  if (profileR.source === "disabled") errors.push(profileR.reason);
  const metrics = metricsR.source === "finnhub" ? metricsR.data : null;
  if (metricsR.source === "disabled") errors.push(metricsR.reason);

  const earnings = earningsR?.bySymbol?.[sym] ?? null;
  const earningsHint = formatEarningsHint(earnings);
  const recentHeadlines = (newsR[sym] ?? []).slice(0, 10);

  const bars = barsR[sym] ?? [];
  const technicals = includeTechnicals && bars.length > 0 ? computeTechnicals(sym, bars) : null;
  if (includeTechnicals && bars.length === 0) {
    errors.push(`technicals: no bars available for ${sym}`);
  }

  let scoredSentiment: SymbolSentimentSummary | null = null;
  if (sentimentScoring === "cache_only" && recentHeadlines.length > 0) {
    const cached: Array<HeadlineScore & { headline: string }> = [];
    for (const h of recentHeadlines) {
      const key = `sentiment:headline:${sym}:${h.id}:v1`;
      const hit = await env.CACHE.get<HeadlineScore>(key, "json");
      if (hit) cached.push({ ...hit, headline: h.headline });
    }
    if (cached.length > 0) scoredSentiment = summarizeScores(sym, cached);
  }

  return {
    symbol: sym,
    profile,
    metrics,
    earnings,
    earningsHint,
    recentHeadlines,
    scoredSentiment,
    technicals,
    errors,
  };
}

export async function loadRegimeCard(env: Env, creds: AlpacaCreds): Promise<RegimeCard> {
  const errors: string[] = [];
  const breadthSyms = BREADTH_INDEXES.map((b) => b.symbol);
  const sectorSyms = SECTOR_ETFS.map((s) => s.symbol);
  const allSyms = [...breadthSyms, ...sectorSyms];

  const [macro, bars] = await Promise.all([
    loadMacroSnapshot(env),
    fetchLongDailyBars(creds, env.CACHE, allSyms, 220).catch(
      (): Record<string, AlpacaBar[]> => ({}),
    ),
  ]);
  for (const e of macro.errors) errors.push(e);

  function trendCard(sym: string): { lastClose: number | null; pctVsSma50: number | null; pctVsSma200: number | null } {
    const b = bars[sym] ?? [];
    if (b.length === 0) return { lastClose: null, pctVsSma50: null, pctVsSma200: null };
    const t = computeTechnicals(sym, b);
    return {
      lastClose: t.lastClose,
      pctVsSma50: t.pricePosVsSma50Pct,
      pctVsSma200: t.pricePosVsSma200Pct,
    };
  }

  const sectorMomentum: SectorMomentum[] = SECTOR_ETFS.map((s) => ({
    symbol: s.symbol,
    label: s.label,
    return20dPct: (() => {
      const r = compute20dReturn(bars[s.symbol] ?? []);
      return r != null ? Number(r.toFixed(2)) : null;
    })(),
  }));
  const ranked = sectorMomentum
    .filter((s) => s.return20dPct != null)
    .sort((a, b) => (b.return20dPct ?? 0) - (a.return20dPct ?? 0));
  const sectorLeader = ranked[0] ?? null;
  const sectorLaggard = ranked[ranked.length - 1] ?? null;

  return {
    asOfSec: Math.floor(Date.now() / 1000),
    vixLevel: macro.vix?.value ?? null,
    vixDate: macro.vix?.date ?? null,
    yieldSpread10y2y: macro.yieldSpread10y2y?.value ?? null,
    yieldSpreadDate: macro.yieldSpread10y2y?.date ?? null,
    dxy: macro.dxy?.value ?? null,
    dxyDate: macro.dxy?.date ?? null,
    spy: trendCard("SPY"),
    qqq: trendCard("QQQ"),
    sectorLeader,
    sectorLaggard,
    sectorMomentum,
    errors,
  };
}

// ---------------- Aggregated cache layer ----------------
//
// Cloudflare Workers Free tier caps each request at 50 subrequests. The coach's
// `loadSymbolFactors` does ~5-15 fetches+KV reads per symbol — at 8 universe
// symbols a cold-cache turn easily exceeds 100 subrequests and fails.
//
// Fix: the refresh job (which can chunk and run multiple times) computes each
// symbol's factors and writes a single aggregated KV blob. The coach only ever
// reads aggregated blobs — 1 KV read per symbol, ~10 reads total even for a
// 10-symbol universe + macro.

export interface AggregatedSymbolFactors {
  symbol: string;
  profile: FinnhubProfile | null;
  metrics: FinnhubMetrics | null;
  earnings: EarningsItem | null;
  earningsHint: string | null;
  // Slim copy: full AlpacaNewsItem includes summary+url+author which can balloon
  // KV size; the coach only needs the headline + source + timestamp.
  recentHeadlinesSlim: { id: number; headline: string; source: string; createdAt: string }[];
  scoredSentiment: SymbolSentimentSummary | null;
  technicals: TechnicalsCard | null;
  refreshedAtSec: number;
}

export interface AggregatedRegime extends RegimeCard {
  refreshedAtSec: number;
}

const AGG_SYMBOL_TTL_SECONDS = 24 * 60 * 60;
const AGG_MACRO_TTL_SECONDS = 24 * 60 * 60;

function aggKey(sym: string): string {
  return `factors:symbol:${sym.toUpperCase()}:agg:v1`;
}

export async function writeAggregatedSymbolFactors(env: Env, factors: SymbolFactors): Promise<void> {
  const blob: AggregatedSymbolFactors = {
    symbol: factors.symbol,
    profile: factors.profile,
    metrics: factors.metrics,
    earnings: factors.earnings,
    earningsHint: factors.earningsHint,
    recentHeadlinesSlim: factors.recentHeadlines.slice(0, 10).map((h) => ({
      id: h.id,
      headline: h.headline,
      source: h.source,
      createdAt: h.createdAt,
    })),
    scoredSentiment: factors.scoredSentiment,
    technicals: factors.technicals,
    refreshedAtSec: Math.floor(Date.now() / 1000),
  };
  await env.CACHE.put(aggKey(factors.symbol), JSON.stringify(blob), {
    expirationTtl: AGG_SYMBOL_TTL_SECONDS,
  });
}

export async function readAggregatedSymbolFactors(
  env: Env,
  symbol: string,
): Promise<AggregatedSymbolFactors | null> {
  return env.CACHE.get<AggregatedSymbolFactors>(aggKey(symbol), "json");
}

export async function writeAggregatedRegime(env: Env, regime: RegimeCard): Promise<void> {
  const blob: AggregatedRegime = { ...regime, refreshedAtSec: Math.floor(Date.now() / 1000) };
  await env.CACHE.put("factors:macro:agg:v1", JSON.stringify(blob), {
    expirationTtl: AGG_MACRO_TTL_SECONDS,
  });
}

export async function readAggregatedRegime(env: Env): Promise<AggregatedRegime | null> {
  return env.CACHE.get<AggregatedRegime>("factors:macro:agg:v1", "json");
}

/**
 * Aggregator the coach calls. ONLY reads aggregated KV blobs — never live-fetches.
 * Subrequest budget = 1 KV read per universe symbol + 1 for macro (≤11 reads for
 * a 10-symbol universe). On a cold cache, returns null fields gracefully so the
 * coach still works.
 *
 * The refresh job (premarket cron + /api/admin/factors/refresh) is what populates
 * these blobs; the coach reads what's there.
 */
export interface CoachMarketContext {
  symbols: AggregatedSymbolFactors[];
  regime: AggregatedRegime | null;
  staleSymbols: string[]; // symbols requested but not in cache
}

export async function loadCoachMarketContext(
  env: Env,
  _creds: AlpacaCreds,
  universeSymbols: string[],
): Promise<CoachMarketContext> {
  const upper = Array.from(new Set(universeSymbols.map((s) => s.toUpperCase()))).slice(0, 40);
  const [perSymbol, regime] = await Promise.all([
    Promise.all(upper.map((sym) => readAggregatedSymbolFactors(env, sym))),
    readAggregatedRegime(env),
  ]);
  const symbols: AggregatedSymbolFactors[] = [];
  const staleSymbols: string[] = [];
  for (let i = 0; i < upper.length; i++) {
    const blob = perSymbol[i];
    if (blob) symbols.push(blob);
    else staleSymbols.push(upper[i]!);
  }
  return { symbols, regime, staleSymbols };
}

export interface RefreshSummary {
  refreshedSymbols: number;
  scoredHeadlines: number;
  failures: Array<{ stage: string; symbol?: string; reason: string }>;
  durationMs: number;
}

/**
 * Premarket-cron / admin-endpoint refresh.
 *
 * Per-symbol cost (cold): ~10 subrequests (5 Finnhub + 1 Alpaca news + 1 bars +
 * KV reads/writes + agg blob write). On Workers Free's 50-subrequest cap, that
 * means ~4 symbols max per invocation. Caller is responsible for chunking — pass
 * a smaller `symbols` array and call multiple times. Once a symbol's underlying
 * caches are warm, subsequent refreshes drop to ~3 subrequests/symbol.
 *
 * Side effects:
 * - Writes `factors:symbol:{T}:agg:v1` per symbol (read by coach + executor).
 * - Writes `factors:macro:agg:v1` (read by coach + executor).
 * - Writes per-headline sentiment cache via classifyHeadlinesBatch.
 */
// Per-call cap on symbols for the HTTP /factors/refresh endpoint. Bound is the
// 30s HTTP wall-time on Workers Paid — Haiku-scoring ~25 symbols × ~6 headlines
// at concurrency=8 ≈ 18-22s. The cron handler (`refreshFactorsForAllUniverses`)
// has 15min wall time and doesn't apply this cap.
export const REFRESH_MAX_SYMBOLS_PER_CALL = 25;

export interface RefreshOptions {
  /** Skip the per-call symbol cap. Use only from cron handlers (15min wall time). */
  uncapped?: boolean;
  /** Concurrency for Haiku per-headline classification. */
  scoringConcurrency?: number;
}

export async function refreshFactors(
  env: Env,
  creds: AlpacaCreds,
  symbols: string[],
  options: RefreshOptions = {},
): Promise<RefreshSummary> {
  const start = Date.now();
  const failures: Array<{ stage: string; symbol?: string; reason: string }> = [];
  const upperAll = Array.from(new Set(symbols.map((s) => s.toUpperCase())));
  const upper = options.uncapped ? upperAll : upperAll.slice(0, REFRESH_MAX_SYMBOLS_PER_CALL);
  if (!options.uncapped && upperAll.length > upper.length) {
    failures.push({
      stage: "chunk-cap",
      reason: `HTTP refresh capped at ${REFRESH_MAX_SYMBOLS_PER_CALL} symbols/call (wall-time bound). Skipped: ${upperAll.slice(upper.length).join(", ")}. Call again with the rest.`,
    });
  }
  const scoringConcurrency = options.scoringConcurrency ?? 8;

  // ---- Macro + regime card (parallel with per-symbol loop) ----
  const regimePromise = loadRegimeCard(env, creds).then(async (regime) => {
    for (const e of regime.errors) failures.push({ stage: "regime", reason: e });
    await writeAggregatedRegime(env, regime);
    return regime;
  });

  // Economic calendar (next 14d) — warms KV; result not needed here
  const econStart = new Date();
  const econEnd = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
  const econPromise = fetchEconomicCalendar(env, econStart, econEnd).then((r) => {
    if (r.source === "disabled") failures.push({ stage: "finnhub-econ", reason: r.reason });
  });

  // ---- Per-symbol slow factors + news (parallel; cache-first lib helpers) ----
  const allHeadlinesToScore: Array<{
    headlineId: number;
    symbol: string;
    headline: string;
    summary?: string;
  }> = [];
  const perSymbolFactors = await Promise.all(
    upper.map(async (sym) => {
      try {
        const factors = await loadSymbolFactors(env, creds, sym, {
          includeNews: true,
          includeTechnicals: true,
          sentimentScoring: "skip",
        });
        for (const e of factors.errors) failures.push({ stage: "symbol-factors", symbol: sym, reason: e });
        for (const h of factors.recentHeadlines) {
          allHeadlinesToScore.push({
            headlineId: h.id,
            symbol: sym,
            headline: h.headline,
            summary: h.summary,
          });
        }
        return factors;
      } catch (err) {
        failures.push({
          stage: "symbol-factors",
          symbol: sym,
          reason: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
    }),
  );

  await Promise.all([regimePromise, econPromise]);

  // ---- Score headlines (KV-deduped — only new ones hit Haiku) ----
  let scored: Awaited<ReturnType<typeof classifyHeadlinesBatch>> = [];
  try {
    scored = await classifyHeadlinesBatch(env, allHeadlinesToScore, { concurrency: scoringConcurrency });
  } catch (err) {
    failures.push({
      stage: "sentiment-scoring",
      reason: err instanceof Error ? err.message : String(err),
    });
  }

  // ---- Compose per-symbol aggregated blobs and write ----
  // Group the freshly-scored headlines by symbol from the in-memory `scored`
  // array — avoids re-reading KV for the agg compose step.
  const scoresBySymbol = new Map<string, Array<HeadlineScore & { headline: string }>>();
  if (scored.length > 0) {
    const headlineLookup = new Map<string, string>();
    for (const h of allHeadlinesToScore) {
      headlineLookup.set(`${h.symbol}|${h.headlineId}`, h.headline);
    }
    for (const s of scored) {
      const headline = headlineLookup.get(`${s.symbol}|${s.headlineId}`) ?? "";
      const list = scoresBySymbol.get(s.symbol) ?? [];
      list.push({ ...s, headline });
      scoresBySymbol.set(s.symbol, list);
    }
  }
  await Promise.all(
    perSymbolFactors.map(async (factors) => {
      if (!factors) return;
      const sym = factors.symbol;
      const list = scoresBySymbol.get(sym);
      if (list && list.length > 0) {
        factors.scoredSentiment = summarizeScores(sym, list);
      }
      try {
        await writeAggregatedSymbolFactors(env, factors);
      } catch (err) {
        failures.push({
          stage: "agg-write",
          symbol: sym,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }),
  );

  return {
    refreshedSymbols: upper.length,
    scoredHeadlines: scored.length,
    failures,
    durationMs: Date.now() - start,
  };
}

/**
 * Single-call probe used by /api/admin/refresh-factors to verify both keys
 * are wired correctly. Hits one cheap endpoint per provider; does not write
 * to caches that real refresh would touch.
 */
export async function runConnectivityProbe(env: Env, creds: AlpacaCreds): Promise<ConnectivityResult> {
  type NewsAttempt =
    | { ok: true; items: AlpacaNewsItem[] }
    | { ok: false; reason: string };
  const newsAttempt: Promise<NewsAttempt> = fetchNews(creds, ["AAPL"], 5, 48).then(
    (r): NewsAttempt => ({ ok: true, items: r.AAPL ?? [] }),
    (err): NewsAttempt => ({ ok: false, reason: err instanceof Error ? err.message : String(err) }),
  );

  const [profile, vix, news] = await Promise.all([
    fetchProfile(env, "AAPL"),
    fetchSeriesLatest(env, MACRO_SERIES.vix),
    newsAttempt,
  ]);

  const finnhub: ProviderStatus = profile.source === "finnhub"
    ? {
        ok: true,
        source: "finnhub",
        sample: {
          symbol: profile.data.symbol,
          name: profile.data.name,
          sector: profile.data.sector,
          marketCapMillionsUsd: profile.data.marketCapMillionsUsd,
        },
      }
    : { ok: false, source: "finnhub", reason: profile.reason };

  const fred: ProviderStatus = vix.source === "fred"
    ? { ok: true, source: "fred", sample: vix.observation }
    : { ok: false, source: "fred", reason: vix.reason };

  const alpacaNews: ProviderStatus = news.ok
    ? {
        ok: true,
        source: "alpaca-news",
        sample: { count: news.items.length, latestHeadline: news.items[0]?.headline ?? null },
      }
    : { ok: false, source: "alpaca-news", reason: news.reason };

  return { finnhub, fred, alpacaNews };
}

export type { FinnhubEconomicEvent };
