import { and, asc, desc, eq, lte } from "drizzle-orm";
import { getDb } from "../db/client";
import { equitySnapshots, settings, trades, users } from "../db/schema";

const STARTING_EQUITY = 100_000;

export interface EquityCurvePoint {
  capturedAt: number;
  equity: number;
}

export interface SlotPerformanceRow {
  slot: string;
  trades: number;
  netRealized: number;
}

export interface LeaderboardSlot {
  userId: string;
  displayName: string;
  equity: number | null;
  rank: number;
  delta24hPct: number | null;
}

export interface GameState {
  asOfSec: number;
  equityNow: number | null;
  startingEquity: number;
  totalReturnPct: number | null;
  cashFraction: number | null;
  intradayPlPct: number | null;
  maxDrawdownPct: number | null;
  equityCurve: EquityCurvePoint[];
  competitionStartAt: number | null;
  competitionEndAt: number | null;
  daysElapsed: number | null;
  daysRemaining: number | null;
  totalTrades: number;
  aiTrades: number;
  directTrades: number;
  realizedNetByAi: number;
  realizedNetByDirect: number;
  winRatePct: number | null;
  avgWinner: number | null;
  avgLoser: number | null;
  profitFactor: number | null;
  bySlot: SlotPerformanceRow[];
  leaderboard: LeaderboardSlot[];
  myRank: number | null;
  deltaToLeaderPct: number | null;
}

type DbClient = ReturnType<typeof getDb>;

async function loadEquityCurve(db: DbClient, userId: string): Promise<EquityCurvePoint[]> {
  const rows = await db
    .select({ capturedAt: equitySnapshots.capturedAt, equity: equitySnapshots.equity })
    .from(equitySnapshots)
    .where(eq(equitySnapshots.userId, userId))
    .orderBy(asc(equitySnapshots.capturedAt));
  return rows.map((r) => ({ capturedAt: r.capturedAt, equity: Number(r.equity) }));
}

async function loadCompetitionDates(db: DbClient): Promise<{
  startAt: number | null;
  endAt: number | null;
}> {
  const [row] = await db.select().from(settings).limit(1);
  return {
    startAt: row?.competitionStartAt ?? null,
    endAt: row?.competitionEndAt ?? null,
  };
}

async function loadLeaderboard(db: DbClient): Promise<LeaderboardSlot[]> {
  const playerRows = await db
    .select({ id: users.id, displayName: users.displayName })
    .from(users)
    .orderBy(asc(users.createdAt));

  const slots: LeaderboardSlot[] = [];
  const nowSec = Math.floor(Date.now() / 1000);
  const dayAgoSec = nowSec - 24 * 60 * 60;
  for (const p of playerRows) {
    const [latest] = await db
      .select({ equity: equitySnapshots.equity })
      .from(equitySnapshots)
      .where(eq(equitySnapshots.userId, p.id))
      .orderBy(desc(equitySnapshots.capturedAt))
      .limit(1);
    const [dayAgo] = await db
      .select({ equity: equitySnapshots.equity })
      .from(equitySnapshots)
      .where(and(eq(equitySnapshots.userId, p.id), lte(equitySnapshots.capturedAt, dayAgoSec)))
      .orderBy(desc(equitySnapshots.capturedAt))
      .limit(1);
    const eqNow = latest ? Number(latest.equity) : null;
    const eq24 = dayAgo ? Number(dayAgo.equity) : null;
    const delta =
      eqNow != null && eq24 != null && eq24 > 0 ? ((eqNow - eq24) / eq24) * 100 : null;
    slots.push({
      userId: p.id,
      displayName: p.displayName,
      equity: eqNow,
      rank: 0,
      delta24hPct: delta,
    });
  }
  // Sort by equity desc; null equity sorts last
  slots.sort((a, b) => {
    if (a.equity == null && b.equity == null) return 0;
    if (a.equity == null) return 1;
    if (b.equity == null) return -1;
    return b.equity - a.equity;
  });
  for (let i = 0; i < slots.length; i++) slots[i]!.rank = i + 1;
  return slots;
}

interface TradeRow {
  symbol: string;
  side: string;
  filledQty: string | null;
  filledAvgPrice: string | null;
  routineRunId: string | null;
  source: string;
  submittedAt: number;
  filledAt: number | null;
}

interface SettlementGroup {
  symbol: string;
  buys: { qty: number; price: number }[];
  sells: { qty: number; price: number }[];
  source: string;
}

/**
 * Pair filled buys with subsequent fills using FIFO so we can compute realized
 * win/loss per round-trip. Approximation only — Alpaca's reconciliation is
 * authoritative — but good enough for coach-facing stats.
 */
function realizedRoundTrips(rows: TradeRow[]): {
  total: number;
  wins: number;
  losses: number;
  avgWinner: number | null;
  avgLoser: number | null;
  profitFactor: number | null;
  totalGains: number;
  totalLosses: number;
} {
  const groups = new Map<string, SettlementGroup>();
  for (const r of rows) {
    const fq = r.filledQty != null ? Number(r.filledQty) : 0;
    const fp = r.filledAvgPrice != null ? Number(r.filledAvgPrice) : 0;
    if (!Number.isFinite(fq) || !Number.isFinite(fp) || fq <= 0 || fp <= 0) continue;
    const key = `${r.symbol}|${r.source}`;
    let g = groups.get(key);
    if (!g) {
      g = { symbol: r.symbol, buys: [], sells: [], source: r.source };
      groups.set(key, g);
    }
    if (r.side === "buy") g.buys.push({ qty: fq, price: fp });
    else if (r.side === "sell") g.sells.push({ qty: fq, price: fp });
  }
  let wins = 0;
  let losses = 0;
  let total = 0;
  let gainSum = 0;
  let lossSum = 0;
  for (const g of groups.values()) {
    // FIFO match in submission order (which equals the order they were pushed)
    const buys = g.buys.map((b) => ({ ...b }));
    const sells = g.sells.map((s) => ({ ...s }));
    while (buys.length > 0 && sells.length > 0) {
      const b = buys[0]!;
      const s = sells[0]!;
      const matchedQty = Math.min(b.qty, s.qty);
      const pnl = (s.price - b.price) * matchedQty;
      total++;
      if (pnl >= 0) {
        wins++;
        gainSum += pnl;
      } else {
        losses++;
        lossSum += -pnl;
      }
      b.qty -= matchedQty;
      s.qty -= matchedQty;
      if (b.qty <= 0) buys.shift();
      if (s.qty <= 0) sells.shift();
    }
  }
  return {
    total,
    wins,
    losses,
    avgWinner: wins > 0 ? gainSum / wins : null,
    avgLoser: losses > 0 ? lossSum / losses : null,
    profitFactor: lossSum > 0 ? gainSum / lossSum : null,
    totalGains: gainSum,
    totalLosses: lossSum,
  };
}

function maxDrawdownPct(curve: EquityCurvePoint[]): number | null {
  if (curve.length < 2) return null;
  let peak = -Infinity;
  let maxDd = 0;
  for (const p of curve) {
    if (p.equity > peak) peak = p.equity;
    if (peak > 0) {
      const dd = (peak - p.equity) / peak;
      if (dd > maxDd) maxDd = dd;
    }
  }
  return maxDd * 100;
}

function inferSlotFromTimestamp(unixSec: number): string {
  // ET hour buckets aligned with the 5 routines (premarket / open / midmorning / afternoon / close).
  // We don't have the exact slot stored on each fill; use ET hour as a proxy.
  const d = new Date(unixSec * 1000);
  // Crude America/New_York offset — DST handling is approximate but fine for bucketing.
  const utcHour = d.getUTCHours();
  const utcMin = d.getUTCMinutes();
  const minOfDayUtc = utcHour * 60 + utcMin;
  // ET = UTC-4 (DST) or -5 (standard). Approximate using DST when month is Mar-Nov.
  const month = d.getUTCMonth();
  const offsetMin = month >= 2 && month <= 10 ? 4 * 60 : 5 * 60;
  const minOfDayEt = ((minOfDayUtc - offsetMin) + 24 * 60) % (24 * 60);
  if (minOfDayEt < 9 * 60 + 30) return "premarket";
  if (minOfDayEt < 11 * 60) return "open";
  if (minOfDayEt < 13 * 60 + 30) return "midmorning";
  if (minOfDayEt < 15 * 60) return "afternoon";
  return "close";
}

export async function loadGameState(env: Env, userId: string): Promise<GameState> {
  const db = getDb(env.DB);
  const nowSec = Math.floor(Date.now() / 1000);

  const [curve, dates, leaderboardAll, tradeRows] = await Promise.all([
    loadEquityCurve(db, userId),
    loadCompetitionDates(db),
    loadLeaderboard(db),
    db
      .select({
        symbol: trades.symbol,
        side: trades.side,
        filledQty: trades.filledQty,
        filledAvgPrice: trades.filledAvgPrice,
        routineRunId: trades.routineRunId,
        source: trades.source,
        submittedAt: trades.submittedAt,
        filledAt: trades.filledAt,
      })
      .from(trades)
      .where(eq(trades.userId, userId))
      .orderBy(asc(trades.submittedAt)),
  ]);

  const equityNow = curve.length > 0 ? curve[curve.length - 1]!.equity : null;
  const totalReturnPct = equityNow != null ? ((equityNow - STARTING_EQUITY) / STARTING_EQUITY) * 100 : null;

  // Intraday P&L: latest equity vs latest snapshot from before today's open in ET.
  const dayStart = new Date();
  dayStart.setUTCHours(13, 30, 0, 0); // ~09:30 ET (DST-aware enough for coach context)
  const dayStartSec = Math.floor(dayStart.getTime() / 1000);
  const preOpen = curve.find((p) => p.capturedAt >= dayStartSec - 24 * 60 * 60 && p.capturedAt <= dayStartSec);
  const intradayPlPct =
    equityNow != null && preOpen && preOpen.equity > 0
      ? ((equityNow - preOpen.equity) / preOpen.equity) * 100
      : null;

  const maxDrawdown = maxDrawdownPct(curve);

  // Days elapsed/remaining
  let daysElapsed: number | null = null;
  let daysRemaining: number | null = null;
  if (dates.startAt != null) {
    daysElapsed = Math.max(0, Math.floor((nowSec - dates.startAt) / (24 * 60 * 60)));
  }
  if (dates.endAt != null) {
    daysRemaining = Math.max(0, Math.ceil((dates.endAt - nowSec) / (24 * 60 * 60)));
  }

  // Round trips
  const rt = realizedRoundTrips(tradeRows);
  const winRatePct = rt.total > 0 ? (rt.wins / rt.total) * 100 : null;

  // Realized net by source
  let realizedNetByAi = 0;
  let realizedNetByDirect = 0;
  let aiTrades = 0;
  let directTrades = 0;
  for (const t of tradeRows) {
    const fq = t.filledQty != null ? Number(t.filledQty) : 0;
    const fp = t.filledAvgPrice != null ? Number(t.filledAvgPrice) : 0;
    if (!Number.isFinite(fq) || !Number.isFinite(fp) || fq <= 0 || fp <= 0) continue;
    const notional = fq * fp;
    const signed = t.side === "sell" ? notional : -notional;
    if (t.source === "direct") {
      realizedNetByDirect += signed;
      directTrades++;
    } else {
      realizedNetByAi += signed;
      aiTrades++;
    }
  }

  // Per-slot performance (ET-hour proxy from submittedAt)
  const slotMap = new Map<string, { trades: number; netRealized: number }>();
  for (const t of tradeRows) {
    const fq = t.filledQty != null ? Number(t.filledQty) : 0;
    const fp = t.filledAvgPrice != null ? Number(t.filledAvgPrice) : 0;
    if (!Number.isFinite(fq) || !Number.isFinite(fp) || fq <= 0 || fp <= 0) continue;
    const slot = inferSlotFromTimestamp(t.submittedAt);
    const sign = t.side === "sell" ? 1 : -1;
    const net = fq * fp * sign;
    const cur = slotMap.get(slot) ?? { trades: 0, netRealized: 0 };
    cur.trades++;
    cur.netRealized += net;
    slotMap.set(slot, cur);
  }
  const slotOrder = ["premarket", "open", "midmorning", "afternoon", "close"];
  const bySlot: SlotPerformanceRow[] = slotOrder
    .map((s) => ({ slot: s, ...(slotMap.get(s) ?? { trades: 0, netRealized: 0 }) }));

  // Leaderboard rank for current player
  const me = leaderboardAll.find((l) => l.userId === userId) ?? null;
  const leader = leaderboardAll[0] ?? null;
  const myRank = me?.rank ?? null;
  const deltaToLeaderPct =
    me?.equity != null && leader?.equity != null && leader.equity > 0 && me.equity !== leader.equity
      ? ((me.equity - leader.equity) / leader.equity) * 100
      : me?.equity != null && leader?.equity != null && me.equity === leader.equity
        ? 0
        : null;

  const cashFraction = null; // requires live Alpaca account; coach loader can plumb in later if needed

  return {
    asOfSec: nowSec,
    equityNow,
    startingEquity: STARTING_EQUITY,
    totalReturnPct,
    cashFraction,
    intradayPlPct,
    maxDrawdownPct: maxDrawdown,
    equityCurve: curve,
    competitionStartAt: dates.startAt,
    competitionEndAt: dates.endAt,
    daysElapsed,
    daysRemaining,
    totalTrades: tradeRows.length,
    aiTrades,
    directTrades,
    realizedNetByAi,
    realizedNetByDirect,
    winRatePct,
    avgWinner: rt.avgWinner,
    avgLoser: rt.avgLoser,
    profitFactor: rt.profitFactor,
    bySlot,
    leaderboard: leaderboardAll,
    myRank,
    deltaToLeaderPct,
  };
}

