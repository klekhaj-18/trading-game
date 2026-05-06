const PAPER_BASE = "https://paper-api.alpaca.markets";
const DATA_BASE = "https://data.alpaca.markets";

export interface AlpacaAccount {
  id: string;
  account_number: string;
  status: string;
  cash: string;
  equity: string;
  buying_power: string;
  long_market_value: string;
  pattern_day_trader: boolean;
}

export interface AlpacaPosition {
  symbol: string;
  qty: string;
  avg_entry_price: string;
  current_price: string;
  market_value: string;
  unrealized_pl: string;
  unrealized_plpc: string;
  side: "long" | "short";
}

export interface AlpacaClock {
  timestamp: string;
  is_open: boolean;
  next_open: string;
  next_close: string;
}

export interface AlpacaOrder {
  id: string;
  client_order_id: string;
  symbol: string;
  side: "buy" | "sell";
  qty: string;
  filled_qty: string;
  filled_avg_price: string | null;
  status: string;
  order_type: string;
  limit_price: string | null;
  time_in_force: string;
  submitted_at: string;
  filled_at: string | null;
}

export interface AlpacaBar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  n?: number;
  vw?: number;
}

export class AlpacaAuthError extends Error {
  constructor(public readonly status: number) {
    super(`Alpaca rejected credentials (status ${status})`);
  }
}

export interface AlpacaCreds {
  apiKey: string;
  apiSecret: string;
}

function authHeaders(c: AlpacaCreds): Record<string, string> {
  return {
    "APCA-API-KEY-ID": c.apiKey,
    "APCA-API-SECRET-KEY": c.apiSecret,
    "Content-Type": "application/json",
  };
}

async function alpacaFetch<T>(url: string, creds: AlpacaCreds, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { ...authHeaders(creds), ...(init?.headers ?? {}) } });
  if (res.status === 401 || res.status === 403) throw new AlpacaAuthError(res.status);
  if (!res.ok) throw new Error(`Alpaca ${url} failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

export async function fetchAccount(apiKey: string, apiSecret: string): Promise<AlpacaAccount> {
  return alpacaFetch<AlpacaAccount>(`${PAPER_BASE}/v2/account`, { apiKey, apiSecret });
}

export async function fetchPositions(creds: AlpacaCreds): Promise<AlpacaPosition[]> {
  return alpacaFetch<AlpacaPosition[]>(`${PAPER_BASE}/v2/positions`, creds);
}

export async function fetchClock(creds: AlpacaCreds): Promise<AlpacaClock> {
  return alpacaFetch<AlpacaClock>(`${PAPER_BASE}/v2/clock`, creds);
}

export interface PlaceOrderInput {
  symbol: string;
  qty: number;
  side: "buy" | "sell";
  type: "market" | "limit";
  time_in_force: "day" | "gtc";
  limit_price?: number;
  client_order_id?: string;
}

export async function placeOrder(creds: AlpacaCreds, input: PlaceOrderInput): Promise<AlpacaOrder> {
  const body: Record<string, unknown> = {
    symbol: input.symbol,
    qty: input.qty.toString(),
    side: input.side,
    type: input.type,
    time_in_force: input.time_in_force,
  };
  if (input.type === "limit" && input.limit_price != null) body.limit_price = input.limit_price.toString();
  if (input.client_order_id) body.client_order_id = input.client_order_id;
  return alpacaFetch<AlpacaOrder>(`${PAPER_BASE}/v2/orders`, creds, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function fetchOrder(creds: AlpacaCreds, orderId: string): Promise<AlpacaOrder> {
  return alpacaFetch<AlpacaOrder>(`${PAPER_BASE}/v2/orders/${orderId}`, creds);
}

export interface ReplaceOrderInput {
  qty?: number;
  limit_price?: number;
  time_in_force?: "day" | "gtc";
}

export async function replaceOrder(
  creds: AlpacaCreds,
  orderId: string,
  input: ReplaceOrderInput,
): Promise<AlpacaOrder> {
  const body: Record<string, unknown> = {};
  if (input.qty != null) body.qty = input.qty.toString();
  if (input.limit_price != null) body.limit_price = input.limit_price.toString();
  if (input.time_in_force != null) body.time_in_force = input.time_in_force;
  return alpacaFetch<AlpacaOrder>(`${PAPER_BASE}/v2/orders/${orderId}`, creds, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export async function cancelAndReplaceOrder(
  creds: AlpacaCreds,
  orderId: string,
  input: ReplaceOrderInput,
): Promise<AlpacaOrder> {
  const existing = await fetchOrder(creds, orderId);
  await cancelOrder(creds, orderId);
  const type = (existing.order_type === "market" ? "market" : "limit") as "market" | "limit";
  const tif: "day" | "gtc" =
    input.time_in_force ?? (existing.time_in_force === "gtc" ? "gtc" : "day");
  const existingLimit =
    existing.limit_price != null && existing.limit_price !== ""
      ? Number(existing.limit_price)
      : undefined;
  return placeOrder(creds, {
    symbol: existing.symbol,
    qty: input.qty ?? Number(existing.qty),
    side: existing.side,
    type,
    time_in_force: tif,
    limit_price: type === "limit" ? (input.limit_price ?? existingLimit) : undefined,
  });
}

export async function cancelOrder(creds: AlpacaCreds, orderId: string): Promise<void> {
  const res = await fetch(`${PAPER_BASE}/v2/orders/${orderId}`, {
    method: "DELETE",
    headers: authHeaders(creds),
  });
  if (res.status === 401 || res.status === 403) throw new AlpacaAuthError(res.status);
  if (!res.ok && res.status !== 204) {
    throw new Error(`Alpaca cancel ${orderId} failed: ${res.status} ${await res.text()}`);
  }
}

export interface AlpacaClosePositionResult {
  symbol: string;
  status: number;
  body: unknown;
}

export async function closePosition(
  creds: AlpacaCreds,
  symbol: string,
): Promise<AlpacaClosePositionResult> {
  const res = await fetch(`${PAPER_BASE}/v2/positions/${symbol}`, {
    method: "DELETE",
    headers: authHeaders(creds),
  });
  if (res.status === 401 || res.status === 403) throw new AlpacaAuthError(res.status);
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    throw new Error(
      `Alpaca close position ${symbol} failed: ${res.status} ${typeof body === "string" ? body : JSON.stringify(body)}`,
    );
  }
  return { symbol, status: res.status, body };
}

export async function fetchOpenOrders(creds: AlpacaCreds): Promise<AlpacaOrder[]> {
  return alpacaFetch<AlpacaOrder[]>(
    `${PAPER_BASE}/v2/orders?status=open&limit=50&direction=desc`,
    creds,
  );
}

export async function fetchClosedOrders(creds: AlpacaCreds, limit = 10): Promise<AlpacaOrder[]> {
  return alpacaFetch<AlpacaOrder[]>(
    `${PAPER_BASE}/v2/orders?status=closed&limit=${limit}&direction=desc`,
    creds,
  );
}

export async function fetchDailyBars(
  creds: AlpacaCreds,
  symbols: string[],
  days: number,
): Promise<Record<string, AlpacaBar[]>> {
  if (symbols.length === 0) return {};
  const end = new Date();
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  const params = new URLSearchParams({
    symbols: symbols.join(","),
    timeframe: "1Day",
    start: start.toISOString(),
    end: end.toISOString(),
    feed: "iex",
    adjustment: "raw",
    limit: String(days * symbols.length * 2),
  });
  const data = await alpacaFetch<{ bars: Record<string, AlpacaBar[]> }>(
    `${DATA_BASE}/v2/stocks/bars?${params.toString()}`,
    creds,
  );
  return data.bars ?? {};
}

export async function fetchLongDailyBars(
  creds: AlpacaCreds,
  kv: KVNamespace,
  symbols: string[],
  days = 220,
): Promise<Record<string, AlpacaBar[]>> {
  if (symbols.length === 0) return {};
  const out: Record<string, AlpacaBar[]> = {};
  const toFetch: string[] = [];
  for (const symRaw of symbols) {
    const sym = symRaw.toUpperCase();
    const cached = await kv.get<AlpacaBar[]>(`bars:daily:${sym}:v1`, "json");
    if (cached && cached.length >= days * 0.6) {
      out[sym] = cached;
    } else {
      toFetch.push(sym);
    }
  }
  if (toFetch.length === 0) return out;

  // Fetch up to 50 symbols per Alpaca call to keep URLs reasonable.
  const batches: string[][] = [];
  for (let i = 0; i < toFetch.length; i += 50) batches.push(toFetch.slice(i, i + 50));
  // Ask for ~1.4× the trading-day window in calendar days to cover weekends/holidays.
  const calendarDays = Math.ceil(days * 1.5);
  for (const batch of batches) {
    const fresh = await fetchDailyBars(creds, batch, calendarDays).catch(() => ({} as Record<string, AlpacaBar[]>));
    for (const sym of batch) {
      const bars = fresh[sym] ?? [];
      out[sym] = bars;
      if (bars.length > 0) {
        await kv.put(`bars:daily:${sym}:v1`, JSON.stringify(bars), {
          expirationTtl: 23 * 60 * 60, // refreshed every premarket; 23h leaves a small overlap
        });
      }
    }
  }
  return out;
}

export async function fetchLatestQuotes(
  creds: AlpacaCreds,
  symbols: string[],
): Promise<Record<string, { bid: number; ask: number; last: number }>> {
  if (symbols.length === 0) return {};
  const params = new URLSearchParams({ symbols: symbols.join(","), feed: "iex" });
  const data = await alpacaFetch<{
    quotes: Record<string, { bp: number; ap: number }>;
  }>(`${DATA_BASE}/v2/stocks/quotes/latest?${params.toString()}`, creds);
  const out: Record<string, { bid: number; ask: number; last: number }> = {};
  for (const [sym, q] of Object.entries(data.quotes ?? {})) {
    out[sym] = { bid: q.bp, ask: q.ap, last: (q.bp + q.ap) / 2 };
  }
  return out;
}

interface AlpacaAsset {
  symbol: string;
  tradable: boolean;
  status: string;
  exchange: string;
  class: string;
}

export interface AlpacaNewsItem {
  id: number;
  headline: string;
  summary: string;
  author: string;
  source: string;
  symbols: string[];
  url: string;
  createdAt: string;
  updatedAt: string;
}

export async function fetchNews(
  creds: AlpacaCreds,
  symbols: string[],
  limitPerBatch = 50,
  hoursBack = 48,
): Promise<Record<string, AlpacaNewsItem[]>> {
  if (symbols.length === 0) return {};
  const start = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString();
  const params = new URLSearchParams({
    symbols: symbols.join(","),
    start,
    limit: String(limitPerBatch),
    sort: "desc",
    include_content: "false",
  });
  let data: {
    news: Array<{
      id: number;
      headline: string;
      summary?: string;
      author?: string;
      source?: string;
      symbols?: string[];
      url?: string;
      created_at: string;
      updated_at?: string;
    }>;
  };
  try {
    data = await alpacaFetch(`${DATA_BASE}/v1beta1/news?${params.toString()}`, creds);
  } catch (err) {
    console.warn("news fetch failed", err);
    return {};
  }
  const bySymbol: Record<string, AlpacaNewsItem[]> = {};
  for (const sym of symbols) bySymbol[sym.toUpperCase()] = [];
  for (const n of data.news ?? []) {
    const item: AlpacaNewsItem = {
      id: n.id,
      headline: n.headline,
      summary: n.summary ?? "",
      author: n.author ?? "",
      source: n.source ?? "",
      symbols: (n.symbols ?? []).map((s) => s.toUpperCase()),
      url: n.url ?? "",
      createdAt: n.created_at,
      updatedAt: n.updated_at ?? n.created_at,
    };
    for (const sym of item.symbols) {
      if (sym in bySymbol) bySymbol[sym]!.push(item);
    }
  }
  return bySymbol;
}

export async function fetchTradableSymbols(creds: AlpacaCreds, kv: KVNamespace): Promise<Set<string>> {
  const cacheKey = "alpaca:tradable_symbols:v1";
  const cached = await kv.get(cacheKey);
  if (cached) return new Set(JSON.parse(cached) as string[]);
  const assets = await alpacaFetch<AlpacaAsset[]>(
    `${PAPER_BASE}/v2/assets?status=active&asset_class=us_equity`,
    creds,
  );
  const tradable = assets.filter((a) => a.tradable).map((a) => a.symbol);
  await kv.put(cacheKey, JSON.stringify(tradable), { expirationTtl: 60 * 60 * 24 });
  return new Set(tradable);
}
