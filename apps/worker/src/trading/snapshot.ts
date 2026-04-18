import type { AlpacaAccount, AlpacaBar, AlpacaOrder, AlpacaPosition } from "../lib/alpaca";
import {
  fetchAccount,
  fetchClock,
  fetchClosedOrders,
  fetchDailyBars,
  fetchLatestQuotes,
  fetchOpenOrders,
  fetchPositions,
  type AlpacaCreds,
} from "../lib/alpaca";

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

export interface MarketSnapshot {
  asOf: string;
  marketIsOpen: boolean;
  nextOpen: string;
  nextClose: string;
  symbols: {
    symbol: string;
    lastQuote: { bid: number; ask: number; mid: number } | null;
    dailyBars: { date: string; open: number; high: number; low: number; close: number; volume: number }[];
  }[];
}

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

export async function buildMarketSnapshot(creds: AlpacaCreds, symbols: string[]): Promise<MarketSnapshot> {
  const uniq = Array.from(new Set(symbols.map((s) => s.toUpperCase()))).slice(0, 40);
  const [clock, quotes, bars] = await Promise.all([
    fetchClock(creds),
    fetchLatestQuotes(creds, uniq).catch(() => ({}) as Record<string, { bid: number; ask: number; last: number }>),
    fetchDailyBars(creds, uniq, 7).catch(() => ({}) as Record<string, AlpacaBar[]>),
  ]);
  return {
    asOf: clock.timestamp,
    marketIsOpen: clock.is_open,
    nextOpen: clock.next_open,
    nextClose: clock.next_close,
    symbols: uniq.map((sym) => {
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
    }),
  };
}
