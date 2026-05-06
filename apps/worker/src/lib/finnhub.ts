export interface EarningsItem {
  symbol: string;
  date: string;
  hour: "bmo" | "amc" | "dmh" | "";
  epsEstimate: number | null;
  epsActual: number | null;
  quarter: number | null;
  year: number | null;
}

export interface EarningsLookup {
  bySymbol: Record<string, EarningsItem | null>;
  source: "finnhub" | "disabled";
}

const CACHE_KEY = "finnhub:earnings:v1";
const CACHE_TTL_SECONDS = 6 * 60 * 60;

interface FinnhubEarningsResponse {
  earningsCalendar: Array<{
    date: string;
    epsActual: number | null;
    epsEstimate: number | null;
    hour: string;
    quarter: number | null;
    revenueActual: number | null;
    revenueEstimate: number | null;
    symbol: string;
    year: number | null;
  }>;
}

export async function fetchNextEarnings(
  env: Env,
  symbols: string[],
): Promise<EarningsLookup> {
  const upper = Array.from(new Set(symbols.map((s) => s.toUpperCase())));
  if (upper.length === 0) return { bySymbol: {}, source: "disabled" };
  if (!env.FINNHUB_API_KEY) {
    const empty: Record<string, EarningsItem | null> = {};
    for (const s of upper) empty[s] = null;
    return { bySymbol: empty, source: "disabled" };
  }

  const cached = await env.CACHE.get(CACHE_KEY, "json");
  if (cached) {
    const map = cached as Record<string, EarningsItem | null>;
    const result: Record<string, EarningsItem | null> = {};
    let missing = 0;
    for (const s of upper) {
      if (s in map) {
        result[s] = map[s] ?? null;
      } else {
        missing += 1;
      }
    }
    if (missing === 0) return { bySymbol: result, source: "finnhub" };
  }

  const from = new Date();
  const to = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const url = `https://finnhub.io/api/v1/calendar/earnings?from=${fmt(from)}&to=${fmt(to)}&token=${encodeURIComponent(env.FINNHUB_API_KEY)}`;

  let data: FinnhubEarningsResponse;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.warn("finnhub earnings failed", res.status);
      const empty: Record<string, EarningsItem | null> = {};
      for (const s of upper) empty[s] = null;
      return { bySymbol: empty, source: "disabled" };
    }
    data = await res.json();
  } catch (err) {
    console.warn("finnhub fetch error", err);
    const empty: Record<string, EarningsItem | null> = {};
    for (const s of upper) empty[s] = null;
    return { bySymbol: empty, source: "disabled" };
  }

  const nextBySymbol: Record<string, EarningsItem | null> = {};
  for (const item of data.earningsCalendar ?? []) {
    const sym = item.symbol.toUpperCase();
    const existing = nextBySymbol[sym];
    const candidate: EarningsItem = {
      symbol: sym,
      date: item.date,
      hour: (item.hour as EarningsItem["hour"]) ?? "",
      epsEstimate: item.epsEstimate,
      epsActual: item.epsActual,
      quarter: item.quarter,
      year: item.year,
    };
    if (!existing || candidate.date < existing.date) nextBySymbol[sym] = candidate;
  }

  await env.CACHE.put(CACHE_KEY, JSON.stringify(nextBySymbol), {
    expirationTtl: CACHE_TTL_SECONDS,
  });

  const result: Record<string, EarningsItem | null> = {};
  for (const s of upper) result[s] = nextBySymbol[s] ?? null;
  return { bySymbol: result, source: "finnhub" };
}

export function formatEarningsHint(item: EarningsItem | null): string | null {
  if (!item) return null;
  const today = new Date();
  const target = new Date(item.date + "T00:00:00Z");
  const daysAway = Math.round((target.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
  const hour =
    item.hour === "bmo" ? "before market open" : item.hour === "amc" ? "after market close" : item.hour === "dmh" ? "during market hours" : "";
  const when = daysAway < 0 ? `${-daysAway}d ago` : daysAway === 0 ? "today" : `in ${daysAway}d`;
  return `next earnings: ${item.date}${hour ? ` (${hour})` : ""} — ${when}`;
}

// ---------------- Profile / Metrics / Sentiment / Calendar ----------------

export interface FinnhubProfile {
  symbol: string;
  name: string | null;
  exchange: string | null;
  industry: string | null;
  sector: string | null;
  country: string | null;
  marketCapMillionsUsd: number | null;
  shareOutstandingMillions: number | null;
  ipo: string | null;
  weburl: string | null;
}

export interface FinnhubMetrics {
  symbol: string;
  beta: number | null;
  pe: number | null;
  ps: number | null;
  pb: number | null;
  dividendYieldPct: number | null;
  netMarginPct: number | null;
  shortInterestPct: number | null;
  fiftyTwoWeekHigh: number | null;
  fiftyTwoWeekLow: number | null;
  avgDailyVolume10dMillions: number | null;
}

export interface FinnhubSentimentAggregate {
  symbol: string;
  buzzArticlesLastWeek: number | null;
  buzzWeeklyAverage: number | null;
  bearishPct: number | null;
  bullishPct: number | null;
  companyNewsScore: number | null;
  sectorAverageNewsScore: number | null;
}

export interface FinnhubEconomicEvent {
  country: string;
  event: string;
  time: string;
  impact: string;
  estimate: number | null;
  prev: number | null;
  actual: number | null;
}

interface FinnhubProfileResponse {
  ticker?: string;
  name?: string;
  exchange?: string;
  finnhubIndustry?: string;
  ggroup?: string;
  gsector?: string;
  country?: string;
  marketCapitalization?: number;
  shareOutstanding?: number;
  ipo?: string;
  weburl?: string;
}

interface FinnhubMetricResponse {
  metric?: Record<string, number | null | undefined>;
}

interface FinnhubSentimentResponse {
  symbol?: string;
  buzz?: { articlesInLastWeek?: number; weeklyAverage?: number };
  sentiment?: { bearishPercent?: number; bullishPercent?: number };
  companyNewsScore?: number;
  sectorAverageNewsScore?: number;
}

interface FinnhubEconomicResponse {
  economicCalendar?: Array<{
    country?: string;
    event?: string;
    time?: string;
    impact?: string;
    estimate?: number | null;
    prev?: number | null;
    actual?: number | null;
  }>;
}

export type FinnhubFetchResult<T> =
  | { source: "finnhub"; data: T }
  | { source: "disabled"; reason: string };

const PROFILE_TTL = 24 * 60 * 60;
const METRIC_TTL = 24 * 60 * 60;
const SENTIMENT_TTL = 30 * 60;
const ECON_TTL = 12 * 60 * 60;

async function finnhubGet<T>(env: Env, path: string): Promise<{ ok: true; data: T } | { ok: false; reason: string }> {
  if (!env.FINNHUB_API_KEY) return { ok: false, reason: "FINNHUB_API_KEY not set" };
  const sep = path.includes("?") ? "&" : "?";
  const url = `https://finnhub.io/api/v1${path}${sep}token=${encodeURIComponent(env.FINNHUB_API_KEY)}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return { ok: false, reason: `Finnhub ${path} HTTP ${res.status}` };
    const data = (await res.json()) as T;
    return { ok: true, data };
  } catch (err) {
    return { ok: false, reason: `Finnhub ${path} fetch error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function fetchProfile(env: Env, symbol: string): Promise<FinnhubFetchResult<FinnhubProfile>> {
  const sym = symbol.toUpperCase();
  // v2: bumped to invalidate cached profiles written before the gsector→industry fallback.
  const cacheKey = `finnhub:profile:${sym}:v2`;
  const cached = await env.CACHE.get<FinnhubProfile>(cacheKey, "json");
  if (cached) return { source: "finnhub", data: cached };

  const result = await finnhubGet<FinnhubProfileResponse>(env, `/stock/profile2?symbol=${encodeURIComponent(sym)}`);
  if (!result.ok) return { source: "disabled", reason: result.reason };

  // Free Finnhub tier returns `finnhubIndustry` but not `gsector` (GICS). Fall
  // back to the industry name so the coach has *something* to anchor on.
  const industry = result.data.finnhubIndustry ?? null;
  const profile: FinnhubProfile = {
    symbol: sym,
    name: result.data.name ?? null,
    exchange: result.data.exchange ?? null,
    industry,
    sector: result.data.gsector ?? industry,
    country: result.data.country ?? null,
    marketCapMillionsUsd: typeof result.data.marketCapitalization === "number" ? result.data.marketCapitalization : null,
    shareOutstandingMillions: typeof result.data.shareOutstanding === "number" ? result.data.shareOutstanding : null,
    ipo: result.data.ipo ?? null,
    weburl: result.data.weburl ?? null,
  };
  await env.CACHE.put(cacheKey, JSON.stringify(profile), { expirationTtl: PROFILE_TTL });
  return { source: "finnhub", data: profile };
}

function pickNumber(metric: Record<string, number | null | undefined> | undefined, ...keys: string[]): number | null {
  if (!metric) return null;
  for (const k of keys) {
    const v = metric[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

export async function fetchMetrics(env: Env, symbol: string): Promise<FinnhubFetchResult<FinnhubMetrics>> {
  const sym = symbol.toUpperCase();
  const cacheKey = `finnhub:metric:${sym}:v1`;
  const cached = await env.CACHE.get<FinnhubMetrics>(cacheKey, "json");
  if (cached) return { source: "finnhub", data: cached };

  const result = await finnhubGet<FinnhubMetricResponse>(env, `/stock/metric?symbol=${encodeURIComponent(sym)}&metric=all`);
  if (!result.ok) return { source: "disabled", reason: result.reason };
  const m = result.data.metric;
  const metrics: FinnhubMetrics = {
    symbol: sym,
    beta: pickNumber(m, "beta"),
    pe: pickNumber(m, "peTTM", "peNormalizedAnnual", "peExclExtraTTM"),
    ps: pickNumber(m, "psTTM", "psAnnual"),
    pb: pickNumber(m, "pbAnnual", "pbQuarterly"),
    dividendYieldPct: pickNumber(m, "dividendYieldIndicatedAnnual", "currentDividendYieldTTM"),
    netMarginPct: pickNumber(m, "netProfitMarginTTM", "netProfitMargin5Y"),
    shortInterestPct: pickNumber(m, "shortInterestSharePercent", "shortRatio"),
    fiftyTwoWeekHigh: pickNumber(m, "52WeekHigh"),
    fiftyTwoWeekLow: pickNumber(m, "52WeekLow"),
    avgDailyVolume10dMillions: pickNumber(m, "10DayAverageTradingVolume"),
  };
  await env.CACHE.put(cacheKey, JSON.stringify(metrics), { expirationTtl: METRIC_TTL });
  return { source: "finnhub", data: metrics };
}

export async function fetchSentiment(env: Env, symbol: string): Promise<FinnhubFetchResult<FinnhubSentimentAggregate>> {
  const sym = symbol.toUpperCase();
  const cacheKey = `finnhub:sentiment:${sym}:v1`;
  const cached = await env.CACHE.get<FinnhubSentimentAggregate>(cacheKey, "json");
  if (cached) return { source: "finnhub", data: cached };

  const result = await finnhubGet<FinnhubSentimentResponse>(env, `/news-sentiment?symbol=${encodeURIComponent(sym)}`);
  if (!result.ok) return { source: "disabled", reason: result.reason };

  const data = result.data;
  const aggregate: FinnhubSentimentAggregate = {
    symbol: sym,
    buzzArticlesLastWeek: typeof data.buzz?.articlesInLastWeek === "number" ? data.buzz.articlesInLastWeek : null,
    buzzWeeklyAverage: typeof data.buzz?.weeklyAverage === "number" ? data.buzz.weeklyAverage : null,
    bearishPct: typeof data.sentiment?.bearishPercent === "number" ? data.sentiment.bearishPercent * 100 : null,
    bullishPct: typeof data.sentiment?.bullishPercent === "number" ? data.sentiment.bullishPercent * 100 : null,
    companyNewsScore: typeof data.companyNewsScore === "number" ? data.companyNewsScore : null,
    sectorAverageNewsScore: typeof data.sectorAverageNewsScore === "number" ? data.sectorAverageNewsScore : null,
  };
  await env.CACHE.put(cacheKey, JSON.stringify(aggregate), { expirationTtl: SENTIMENT_TTL });
  return { source: "finnhub", data: aggregate };
}

export async function fetchEconomicCalendar(
  env: Env,
  fromDate: Date,
  toDate: Date,
): Promise<FinnhubFetchResult<FinnhubEconomicEvent[]>> {
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const cacheKey = `finnhub:econ:${fmt(fromDate)}:${fmt(toDate)}:v1`;
  const cached = await env.CACHE.get<FinnhubEconomicEvent[]>(cacheKey, "json");
  if (cached) return { source: "finnhub", data: cached };

  const result = await finnhubGet<FinnhubEconomicResponse>(env, `/calendar/economic?from=${fmt(fromDate)}&to=${fmt(toDate)}`);
  if (!result.ok) return { source: "disabled", reason: result.reason };

  const events: FinnhubEconomicEvent[] = (result.data.economicCalendar ?? [])
    .filter((e) => e.country === "US")
    .map((e) => ({
      country: e.country ?? "US",
      event: e.event ?? "",
      time: e.time ?? "",
      impact: e.impact ?? "",
      estimate: typeof e.estimate === "number" ? e.estimate : null,
      prev: typeof e.prev === "number" ? e.prev : null,
      actual: typeof e.actual === "number" ? e.actual : null,
    }));
  await env.CACHE.put(cacheKey, JSON.stringify(events), { expirationTtl: ECON_TTL });
  return { source: "finnhub", data: events };
}
