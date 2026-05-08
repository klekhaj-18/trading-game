// Financial Modeling Prep (FMP) — earnings enrichment for revenue actual/estimate.
// Free tier (250 req/day, 5 yrs history). Used as a complement to Finnhub free,
// which only returns EPS. Disabled gracefully when FMP_API_KEY is not set.
//
// Endpoint used:
//   GET https://financialmodelingprep.com/api/v3/historical/earning_calendar/{SYMBOL}?apikey=KEY
//   → array of past earnings rows; we take the most recent one with at least one
//     of revenue / revenueEstimated / eps / epsEstimated populated.

export interface FmpEarnings {
  symbol: string;
  date: string;
  epsActual: number | null;
  epsEstimate: number | null;
  revActual: number | null;
  revEstimate: number | null;
}

export interface FmpEarningsLookup {
  bySymbol: Record<string, FmpEarnings | null>;
  source: "fmp" | "disabled";
  reason?: string;
}

interface FmpEarningsRow {
  date?: string;
  symbol?: string;
  eps?: number | null;
  epsEstimated?: number | null;
  revenue?: number | null;
  revenueEstimated?: number | null;
}

const PER_SYMBOL_TTL_SECONDS = 6 * 60 * 60;

function cacheKey(symbol: string): string {
  return `fmp:earnings:${symbol.toUpperCase()}:v1`;
}

export async function fetchFmpEarningsBatch(
  env: Env,
  symbols: string[],
): Promise<FmpEarningsLookup> {
  const upper = Array.from(new Set(symbols.map((s) => s.toUpperCase())));
  if (upper.length === 0) return { bySymbol: {}, source: "disabled" };
  if (!env.FMP_API_KEY) {
    const empty: Record<string, FmpEarnings | null> = {};
    for (const s of upper) empty[s] = null;
    return { bySymbol: empty, source: "disabled", reason: "FMP_API_KEY not set" };
  }

  const result: Record<string, FmpEarnings | null> = {};
  for (const sym of upper) {
    const cached = await env.CACHE.get<FmpEarnings>(cacheKey(sym), "json");
    if (cached !== null) {
      result[sym] = cached;
      continue;
    }
    const fetched = await fetchOne(env, sym);
    result[sym] = fetched;
    if (fetched != null) {
      await env.CACHE.put(cacheKey(sym), JSON.stringify(fetched), {
        expirationTtl: PER_SYMBOL_TTL_SECONDS,
      });
    }
  }
  return { bySymbol: result, source: "fmp" };
}

async function fetchOne(env: Env, symbol: string): Promise<FmpEarnings | null> {
  if (!env.FMP_API_KEY) return null;
  const url = `https://financialmodelingprep.com/api/v3/historical/earning_calendar/${encodeURIComponent(symbol)}?apikey=${encodeURIComponent(env.FMP_API_KEY)}`;
  let rows: FmpEarningsRow[];
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`fmp earnings ${symbol} HTTP ${res.status}`);
      return null;
    }
    rows = (await res.json()) as FmpEarningsRow[];
  } catch (err) {
    console.warn(`fmp earnings ${symbol} fetch error`, err);
    return null;
  }
  if (!Array.isArray(rows) || rows.length === 0) return null;

  // Most recent first; pick the latest row that has at least one non-null field.
  const sorted = rows
    .filter((r) => typeof r.date === "string")
    .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
  for (const r of sorted) {
    if (
      r.eps != null ||
      r.epsEstimated != null ||
      r.revenue != null ||
      r.revenueEstimated != null
    ) {
      return {
        symbol: symbol.toUpperCase(),
        date: r.date ?? "",
        epsActual: typeof r.eps === "number" ? r.eps : null,
        epsEstimate: typeof r.epsEstimated === "number" ? r.epsEstimated : null,
        revActual: typeof r.revenue === "number" ? r.revenue : null,
        revEstimate: typeof r.revenueEstimated === "number" ? r.revenueEstimated : null,
      };
    }
  }
  return null;
}
