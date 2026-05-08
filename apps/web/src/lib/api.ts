import type { AuthStatusResponse, AuthUser, LoginInput, SignupInput } from "shared/auth";
import type {
  AlpacaKeysInput,
  OperationalPlan,
  PlaybookCurrentResponse,
  PlaybookDraftInput,
  PlanSummary,
} from "shared/playbook";
import type { CoachChatResponse, CoachMessage, CoachPlanRevision } from "shared/coach";
import type {
  CreateIntentInput,
  CreateIntentResponse,
  IntentSummary,
  IntentsListResponse,
} from "shared/intent";
import type { PnlSplitResponse } from "shared/pnl";
import type {
  RoutineDecision,
  PlacedOrderSummary,
  RoutineKind,
  RoutineStatus,
  ScheduledTouchpoint,
  ValidationFailure,
} from "shared/routine";
import type { RaceStateResponse } from "shared/race";
import type {
  LeaderboardEquitySeriesResponse,
  LeaderboardRange,
  LeaderboardResponse,
  PublicTickerResponse,
} from "shared/leaderboard";

export interface OpenOrderSummary {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  filledQty: number;
  orderType: string;
  limitPrice: number | null;
  timeInForce: string;
  status: string;
  submittedAt: number;
}

export interface PositionSummary {
  symbol: string;
  qty: number;
  avgEntry: number;
  current: number;
  marketValue: number;
  unrealizedPl: number;
  unrealizedPlPct: number;
  side: "long" | "short";
}

export interface RecentFillSummary {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  filledQty: number;
  filledAvgPrice: number | null;
  orderType: string;
  status: string;
  submittedAt: number;
  filledAt: number | null;
}

export interface EquityPoint {
  t: number;
  equity: number;
  cash: number;
  longMarketValue: number;
}

export interface RosterPlayer {
  id: string;
  displayName: string;
  teamColor: string;
  isAdmin: boolean;
  alpacaLinked: boolean;
  planState: "approved" | "pending" | "rejected" | "superseded" | "none";
  joinedAtSec: number;
  onboardedAtSec: number | null;
}

export interface RosterResponse {
  players: RosterPlayer[];
  maxPlayers: 4;
}

export interface RoutineRunSummary {
  id: string;
  kind: RoutineKind;
  scheduledSlot: ScheduledTouchpoint | null;
  oneShotInstruction: string | null;
  claudeModel: string | null;
  claudeReasoning: string | null;
  decisions: RoutineDecision[] | null;
  validationFailures: ValidationFailure[];
  orders: PlacedOrderSummary[];
  status: RoutineStatus;
  errorText: string | null;
  tokens: {
    input: number | null;
    output: number | null;
    cacheRead: number | null;
    cacheWrite: number | null;
  };
  startedAt: number;
  completedAt: number | null;
}

// ---------------------------------------------------------------------------
// Routine run detail (returned by /api/me/routine-runs/:id only)
//
// These mirror the worker-side `MarketSnapshot` and `AccountContext` shapes
// (apps/worker/src/trading/snapshot.ts) and `AggregatedRegime`
// (apps/worker/src/data/factors.ts). The worker writes them as JSON columns
// on routine_runs and the detail endpoint parses + returns them.
// ---------------------------------------------------------------------------

export interface SnapshotQuote {
  bid: number;
  ask: number;
  mid: number;
}

export interface SnapshotDailyBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface SnapshotNewsItem {
  headline: string;
  source: string;
  createdAt: string;
  score?: number;
  label?: SentimentLabel;
  rationale?: string;
}

export interface SnapshotEarningsItem {
  symbol: string;
  date: string;
  hour: "bmo" | "amc" | "dmh" | "";
  epsActual: number | null;
  epsEstimate: number | null;
  revActual: number | null;
  revEstimate: number | null;
  quarter: number | null;
  year: number | null;
}

export interface SnapshotTechnicals {
  symbol: string;
  asOfDate: string | null;
  lastClose: number | null;
  sma20: number | null;
  sma50: number | null;
  sma200: number | null;
  pricePosVsSma50Pct: number | null;
  pricePosVsSma200Pct: number | null;
  rsi14: number | null;
  atr14: number | null;
  atr14PctOfPrice: number | null;
  realizedVol10dAnnPct: number | null;
  realizedVol30dAnnPct: number | null;
  fiftyTwoWeekHigh: number | null;
  fiftyTwoWeekLow: number | null;
  pctFromFiftyTwoWeekHigh: number | null;
  pctFromFiftyTwoWeekLow: number | null;
  avgVolume30d: number | null;
  relativeVolume30d: number | null;
  barsAvailable: number;
}

export type SentimentLabel = "bullish" | "bearish" | "neutral" | "mixed";

export interface SnapshotSentimentSummary {
  symbol: string;
  scoredCount: number;
  averageScore: number | null;
  bullishCount: number;
  bearishCount: number;
  neutralCount: number;
  mixedCount: number;
  topHeadlines: {
    headline: string;
    score: number;
    label: SentimentLabel;
    rationale: string;
  }[];
}

export interface SnapshotSymbol {
  symbol: string;
  lastQuote: SnapshotQuote | null;
  dailyBars: SnapshotDailyBar[];
  news: SnapshotNewsItem[];
  earnings: SnapshotEarningsItem | null;
  earningsHint: string | null;
  sentiment: SnapshotSentimentSummary | null;
  technicals: SnapshotTechnicals | null;
}

export interface SnapshotSectorMomentum {
  symbol: string;
  label: string;
  return20dPct: number | null;
}

export interface SnapshotRegimeCard {
  asOfSec: number;
  vixLevel: number | null;
  vixDate: string | null;
  yieldSpread10y2y: number | null;
  yieldSpreadDate: string | null;
  dxy: number | null;
  dxyDate: string | null;
  spy: { lastClose: number | null; pctVsSma50: number | null; pctVsSma200: number | null };
  qqq: { lastClose: number | null; pctVsSma50: number | null; pctVsSma200: number | null };
  sectorLeader: SnapshotSectorMomentum | null;
  sectorLaggard: SnapshotSectorMomentum | null;
  sectorMomentum: SnapshotSectorMomentum[];
  errors: string[];
  refreshedAtSec?: number;
}

export interface MarketSnapshot {
  asOf: string;
  marketIsOpen: boolean;
  nextOpen: string;
  nextClose: string;
  symbols: SnapshotSymbol[];
  broaderMarket: {
    symbol: string;
    label: string;
    lastQuote: SnapshotQuote | null;
    dailyBars: SnapshotDailyBar[];
  }[];
  earningsSource: "finnhub" | "disabled";
  regime: SnapshotRegimeCard | null;
  factorSource: "warm" | "cold";
}

export interface AccountPosition {
  symbol: string;
  qty: number;
  avgEntry: number;
  current: number;
  unrealizedPl: number;
  unrealizedPlPct: number;
}

export interface AccountOpenOrder {
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

export interface AccountRecentFill extends AccountOpenOrder {
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
  positions: AccountPosition[];
  openOrders: AccountOpenOrder[];
  recentFills: AccountRecentFill[];
}

export interface PlanUniverseEntry {
  symbol: string;
  rationale: string;
}

export interface RoutineRunDetail extends RoutineRunSummary {
  marketSnapshot: MarketSnapshot | null;
  accountContext: AccountContext | null;
  planUniverse: PlanUniverseEntry[];
}

/**
 * Slim cross-user row for the admin routines list. Intentionally omits the
 * decision/reasoning/order/token detail — admin is also a player, so per-row
 * content would leak competitor strategy. Owners get the rich view on Pit Wall.
 */
export interface ProbeStatus {
  ok: boolean;
  source: string;
  reason?: string;
  sample?: unknown;
}

export interface AdminRoutineSummary {
  id: string;
  userId: string;
  displayName: string;
  kind: RoutineKind;
  scheduledSlot: ScheduledTouchpoint | null;
  status: RoutineStatus;
  startedAt: number;
  completedAt: number | null;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
  const text = await res.text();
  const body = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const b = body as { error?: string; message?: string } | null;
    throw new ApiError(res.status, b?.error ?? "unknown", b?.message ?? b?.error ?? res.statusText);
  }
  return body as T;
}

export const api = {
  authStatus: () => request<AuthStatusResponse>("/api/auth/status"),
  signup: (input: SignupInput) =>
    request<{ user: AuthUser }>("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  login: (input: LoginInput) =>
    request<{ user: AuthUser }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  logout: () => request<{ ok: true }>("/api/auth/logout", { method: "POST" }),
  me: () => request<{ user: AuthUser }>("/api/me"),

  linkAlpaca: (input: AlpacaKeysInput) =>
    request<{
      accountId: string;
      accountNumber: string;
      status: string;
      equity: string;
      buyingPower: string;
    }>("/api/alpaca/keys", { method: "POST", body: JSON.stringify(input) }),

  playbookCurrent: () => request<PlaybookCurrentResponse>("/api/playbook/current"),

  submitPlaybook: (input: PlaybookDraftInput) =>
    request<{
      playbookId: string;
      plan: PlanSummary;
      usage: {
        input_tokens: number;
        output_tokens: number;
        cache_read_input_tokens: number | null;
        cache_creation_input_tokens: number | null;
      };
    }>("/api/playbook", { method: "POST", body: JSON.stringify(input) }),

  approvePlan: (planId: string) =>
    request<{ ok: true; approvedAt: number }>(`/api/playbook/plan/${planId}/approve`, {
      method: "POST",
    }),

  rejectPlan: (planId: string, reason: string) =>
    request<{ ok: true }>(`/api/playbook/plan/${planId}/reject`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    }),

  proposePlan: (input: CoachPlanRevision) =>
    request<{ plan: PlanSummary }>("/api/playbook/propose-plan", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  coachChat: (messages: CoachMessage[]) =>
    request<CoachChatResponse>("/api/coach/chat", {
      method: "POST",
      body: JSON.stringify({ messages }),
    }),

  adminListRoutines: (limit = 50) =>
    request<{ runs: AdminRoutineSummary[] }>(`/api/admin/routines?limit=${limit}`),

  adminFactorsProbe: () =>
    request<{
      ok: boolean;
      finnhub: ProbeStatus;
      fred: ProbeStatus;
      alpacaNews: ProbeStatus;
      fmp: ProbeStatus;
    }>("/api/admin/factors/probe", { method: "POST" }),

  adminKillRoutine: (id: string) =>
    request<{ ok: true; killed: 0 | 1; alreadyTerminal?: boolean }>(
      `/api/admin/routines/${encodeURIComponent(id)}/kill`,
      { method: "POST" },
    ),

  adminTriggerCron: (cron: string) =>
    request<{ ok: true; cron: string }>("/api/admin/trigger-cron", {
      method: "POST",
      body: JSON.stringify({ cron }),
    }),

  adminTriggerCronSync: (cron: string) =>
    request<{ ok: true; cron: string; durationMs: number }>(
      "/api/admin/trigger-cron-sync",
      { method: "POST", body: JSON.stringify({ cron }) },
    ),

  adminRoster: () => request<RosterResponse>("/api/admin/roster"),

  adminResyncUserAlpaca: (userId: string) =>
    request<{
      userId: string;
      displayName: string;
      storedAccountId: string | null;
      cacheBusted: true;
      account: {
        ok: boolean;
        accountId?: string;
        equity?: string;
        cash?: string;
        longMarketValue?: string;
        status?: string;
        error?: string;
      };
      positions: {
        ok: boolean;
        count?: number;
        raw?: Array<{
          symbol: string;
          qty: string;
          avgEntry: string;
          current: string;
          marketValue: string;
          unrealizedPl: string;
          side: "long" | "short";
        }>;
        error?: string;
      };
      openOrders: { ok: boolean; count?: number; error?: string };
    }>(`/api/admin/users/${encodeURIComponent(userId)}/alpaca-resync`, { method: "POST" }),

  mePositions: () => request<{ positions: PositionSummary[]; error?: string }>("/api/me/positions"),

  meOpenOrders: () => request<{ orders: OpenOrderSummary[]; error?: string }>("/api/me/open-orders"),

  meRecentFills: () =>
    request<{ fills: RecentFillSummary[]; error?: string }>("/api/me/recent-fills"),

  meDirectOrder: (input: {
    symbol: string;
    side: "buy" | "sell";
    qty: number;
    type: "market" | "limit";
    time_in_force: "day" | "gtc";
    limit_price?: number;
  }) =>
    request<{
      ok: true;
      order: {
        id: string;
        symbol: string;
        side: "buy" | "sell";
        qty: number;
        orderType: string;
        status: string;
      };
    }>("/api/me/orders", { method: "POST", body: JSON.stringify(input) }),

  meReplaceOrder: (
    id: string,
    input: { qty?: number; limit_price?: number; time_in_force?: "day" | "gtc" },
  ) =>
    request<{ ok: true; order: { id: string } }>(`/api/me/orders/${id}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),

  meCancelOrder: (id: string) =>
    request<{ ok: true }>(`/api/me/orders/${id}`, { method: "DELETE" }),

  meIntents: () => request<IntentsListResponse>("/api/me/intents"),

  meCreateIntent: (input: CreateIntentInput) =>
    request<CreateIntentResponse>("/api/me/intents", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  meRoutineRun: (id: string) =>
    request<{ run: RoutineRunDetail }>(`/api/me/routine-runs/${encodeURIComponent(id)}`),

  meCancelIntent: (id: string) =>
    request<{ ok: true }>(`/api/me/intents/${id}`, { method: "DELETE" }),

  mePnlSplit: () => request<PnlSplitResponse>("/api/me/pnl-split"),

  meClosePosition: (symbol: string) =>
    request<{ ok: true }>(`/api/me/positions/${encodeURIComponent(symbol)}`, {
      method: "DELETE",
    }),

  meRoutineRuns: () => request<{ runs: RoutineRunSummary[] }>("/api/me/routine-runs"),

  meEquitySeries: (range: "24h" | "7d" | "30d") =>
    request<{ range: string; points: EquityPoint[] }>(`/api/me/equity-series?range=${range}`),

  raceState: () => request<RaceStateResponse>("/api/race"),

  leaderboard: () => request<LeaderboardResponse>("/api/leaderboard"),

  leaderboardEquitySeries: (range: LeaderboardRange) =>
    request<LeaderboardEquitySeriesResponse>(
      `/api/leaderboard/equity-series?range=${range}`,
    ),

  eventsTicker: (limit = 20) =>
    request<PublicTickerResponse>(`/api/events/ticker?limit=${limit}`),

  adminSetDates: (startAt: string, endAt: string) =>
    request<{ ok: true }>("/api/race/admin/set-dates", {
      method: "POST",
      body: JSON.stringify({ startAt, endAt }),
    }),

  adminLockDates: () =>
    request<{ ok: true }>("/api/race/admin/lock-dates", { method: "POST" }),

  adminExtendEnd: (newEndAt: string) =>
    request<{ ok: true }>("/api/race/admin/extend-end", {
      method: "POST",
      body: JSON.stringify({ newEndAt }),
    }),

  adminUnlockForTesting: () =>
    request<{ ok: true }>("/api/race/admin/unlock-for-testing", { method: "POST" }),

  adminTestOrder: (input: {
    symbol: string;
    qty: number;
    side: "buy" | "sell";
    type: "market" | "limit";
    limit_price?: number;
    time_in_force: "day" | "gtc";
  }) =>
    request<{
      ok: boolean;
      order: {
        id: string;
        symbol: string;
        side: string;
        qty: string;
        status: string;
        limit_price: string | null;
        submitted_at: string;
      };
    }>("/api/admin/test-order", { method: "POST", body: JSON.stringify(input) }),
};

export type { OperationalPlan };
