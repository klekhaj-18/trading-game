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

// /stable/earnings returns the modern field names (epsActual, revenueActual);
// older v3 endpoints used (eps, revenue). We accept both for resilience.
interface FmpEarningsRow {
  date?: string;
  symbol?: string;
  eps?: number | null;
  epsActual?: number | null;
  epsEstimated?: number | null;
  revenue?: number | null;
  revenueActual?: number | null;
  revenueEstimated?: number | null;
}

function pickNum(...vs: Array<number | null | undefined>): number | null {
  for (const v of vs) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

const PER_SYMBOL_TTL_SECONDS = 6 * 60 * 60;

function cacheKey(symbol: string): string {
  // v2: bumped after picking logic changed to prefer the most recent reported
  // quarter (epsActual non-null) over the upcoming quarter.
  return `fmp:earnings:${symbol.toUpperCase()}:v2`;
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
    if (fetched.ok) {
      result[sym] = fetched.data;
      await env.CACHE.put(cacheKey(sym), JSON.stringify(fetched.data), {
        expirationTtl: PER_SYMBOL_TTL_SECONDS,
      });
    } else {
      console.warn(`fmp ${sym}: ${fetched.reason}`);
      result[sym] = null;
    }
  }
  return { bySymbol: result, source: "fmp" };
}

type FetchOneResult =
  | { ok: true; data: FmpEarnings }
  | { ok: false; reason: string };

async function fetchOne(env: Env, symbol: string): Promise<FetchOneResult> {
  if (!env.FMP_API_KEY) return { ok: false, reason: "FMP_API_KEY not set" };
  // /stable/earnings (the modern endpoint) returns past + upcoming earnings
  // for a single symbol with epsActual/epsEstimated/revenueActual/revenueEstimated.
  // The old /api/v3/historical/earning_calendar endpoint was deprecated 2025.
  // Free tier caps `limit` at 5; we only need the most recent quarter anyway.
  const url = `https://financialmodelingprep.com/stable/earnings?symbol=${encodeURIComponent(symbol)}&limit=5&apikey=${encodeURIComponent(env.FMP_API_KEY)}`;
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    return {
      ok: false,
      reason: `fetch error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!res.ok) {
    let body = "";
    try {
      body = (await res.text()).slice(0, 500);
    } catch {
      /* ignore */
    }
    return {
      ok: false,
      reason: `HTTP ${res.status} ${res.statusText}${body ? ` — ${body}` : ""}`,
    };
  }
  let payload: unknown;
  try {
    payload = await res.json();
  } catch (err) {
    return {
      ok: false,
      reason: `bad JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  // FMP sometimes returns { "Error Message": "..." } as a 200 with an error
  // payload (especially on free-tier endpoint restrictions or stale keys).
  if (
    payload != null &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    ("Error Message" in (payload as Record<string, unknown>) ||
      "error" in (payload as Record<string, unknown>) ||
      "message" in (payload as Record<string, unknown>))
  ) {
    const obj = payload as Record<string, unknown>;
    const msg = obj["Error Message"] ?? obj["error"] ?? obj["message"];
    return {
      ok: false,
      reason: `FMP error: ${String(msg).slice(0, 500)}`,
    };
  }
  if (!Array.isArray(payload) || payload.length === 0) {
    return { ok: false, reason: "FMP returned empty array" };
  }
  const rows = payload as FmpEarningsRow[];
  // Sort newest-first by report date.
  const sorted = rows
    .filter((r) => typeof r.date === "string")
    .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));

  const toData = (r: FmpEarningsRow): FmpEarnings => ({
    symbol: symbol.toUpperCase(),
    date: r.date ?? "",
    epsActual: pickNum(r.epsActual, r.eps),
    epsEstimate: pickNum(r.epsEstimated),
    revActual: pickNum(r.revenueActual, r.revenue),
    revEstimate: pickNum(r.revenueEstimated),
  });

  // Prefer the most recent ALREADY-REPORTED quarter (epsActual or revActual
  // non-null). FMP's calendar response includes the upcoming quarter as the
  // top row with only estimates populated; we want the last reported quarter
  // for a "what just happened" view.
  for (const r of sorted) {
    const data = toData(r);
    if (data.epsActual != null || data.revActual != null) {
      return { ok: true, data };
    }
  }

  // No reported quarter found (rare). Fall back to the most recent row with
  // any populated field — at minimum we get the upcoming-quarter estimates.
  for (const r of sorted) {
    const data = toData(r);
    if (
      data.epsActual != null ||
      data.epsEstimate != null ||
      data.revActual != null ||
      data.revEstimate != null
    ) {
      return { ok: true, data };
    }
  }
  return { ok: false, reason: `no rows with EPS/revenue (got ${rows.length} entries)` };
}

export async function probeFmp(env: Env, symbol = "AAPL"): Promise<FetchOneResult> {
  return fetchOne(env, symbol);
}
