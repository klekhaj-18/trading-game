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
