export interface FredObservation {
  seriesId: string;
  date: string;
  value: number;
}

export type FredResult =
  | { source: "fred"; observation: FredObservation }
  | { source: "disabled"; reason: string };

interface FredApiResponse {
  observations?: Array<{ date: string; value: string }>;
}

const CACHE_TTL_SECONDS = 12 * 60 * 60;

function cacheKey(seriesId: string): string {
  return `fred:series:${seriesId}:latest:v1`;
}

export async function fetchSeriesLatest(env: Env, seriesId: string): Promise<FredResult> {
  if (!env.FRED_API_KEY) {
    return { source: "disabled", reason: "FRED_API_KEY not set" };
  }

  const cached = await env.CACHE.get<FredObservation>(cacheKey(seriesId), "json");
  if (cached) return { source: "fred", observation: cached };

  // Trim defensively in case the secret was pasted with stray whitespace.
  const apiKey = env.FRED_API_KEY.trim();
  const params = new URLSearchParams({
    series_id: seriesId,
    file_type: "json",
    sort_order: "desc",
    limit: "1",
    api_key: apiKey,
  });
  const url = `https://api.stlouisfed.org/fred/series/observations?${params.toString()}`;

  let data: FredApiResponse;
  try {
    // FRED's edge (Akamai) blocks requests with no/empty User-Agent — Cloudflare
    // Workers' default UA gets refused with "Access Denied". Sending an explicit
    // identifying UA passes the bot check.
    const res = await fetch(url, {
      headers: {
        "User-Agent": "trading-grand-prix/1.0 (Cloudflare Worker)",
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      // FRED puts useful detail in the body. Trim and bound it so the reason stays readable.
      const detail = bodyText.replace(/\s+/g, " ").trim().slice(0, 240);
      const keyShape = `len=${apiKey.length} hex=${/^[0-9a-f]+$/i.test(apiKey)}`;
      return {
        source: "disabled",
        reason: `FRED ${seriesId} HTTP ${res.status}: ${detail || "(empty body)"} [${keyShape}]`,
      };
    }
    data = (await res.json()) as FredApiResponse;
  } catch (err) {
    return { source: "disabled", reason: `FRED ${seriesId} fetch error: ${err instanceof Error ? err.message : String(err)}` };
  }

  const first = data.observations?.find((o) => o.value !== "." && o.value != null);
  if (!first) {
    return { source: "disabled", reason: `FRED ${seriesId} returned no usable observations` };
  }
  const numeric = Number(first.value);
  if (!Number.isFinite(numeric)) {
    return { source: "disabled", reason: `FRED ${seriesId} value not numeric: ${first.value}` };
  }
  const obs: FredObservation = { seriesId, date: first.date, value: numeric };
  await env.CACHE.put(cacheKey(seriesId), JSON.stringify(obs), { expirationTtl: CACHE_TTL_SECONDS });
  return { source: "fred", observation: obs };
}
