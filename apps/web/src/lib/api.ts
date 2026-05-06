import type { AuthStatusResponse, AuthUser, LoginInput, SignupInput } from "shared/auth";
import type {
  AlpacaKeysInput,
  OperationalPlan,
  PlaybookCurrentResponse,
  PlaybookDraftInput,
  PlanSummary,
} from "shared/playbook";
import type { CoachChatResponse, CoachMessage, CoachPlanRevision } from "shared/coach";
import type { CreateIntentInput, IntentSummary, IntentsListResponse } from "shared/intent";
import type { PnlSplitResponse } from "shared/pnl";
import type {
  FireTestRoutineInput,
  HaikuDecision,
  PlacedOrderSummary,
  RoutineKind,
  RoutineSlot,
  RoutineStatus,
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

export interface EquityPoint {
  t: number;
  equity: number;
  cash: number;
  longMarketValue: number;
}

export interface RoutineRunSummary extends AdminTestRun {}

export interface AdminTestRun {
  id: string;
  kind: RoutineKind;
  scheduledSlot: RoutineSlot | null;
  oneShotInstruction: string | null;
  claudeModel: string | null;
  claudeReasoning: string | null;
  decisions: HaikuDecision[] | null;
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

  fireTestRoutine: (input: FireTestRoutineInput) =>
    request<{
      runId: string;
      status: RoutineStatus;
      decisions: HaikuDecision[] | null;
      validationFailures: ValidationFailure[];
      orders: PlacedOrderSummary[];
      reasoning: string | null;
      errorText: string | null;
      usage: { input: number | null; output: number | null; cacheRead: number | null; cacheWrite: number | null };
    }>("/api/admin/fire-test-routine", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  adminTestRuns: () => request<{ runs: AdminTestRun[] }>("/api/admin/test-runs"),

  resetAdminTestData: () =>
    request<{ ok: true }>("/api/admin/reset-admin-test-data", { method: "POST" }),

  mePositions: () => request<{ positions: PositionSummary[]; error?: string }>("/api/me/positions"),

  meOpenOrders: () => request<{ orders: OpenOrderSummary[]; error?: string }>("/api/me/open-orders"),

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
    request<{ ok: true; intent: IntentSummary }>("/api/me/intents", {
      method: "POST",
      body: JSON.stringify(input),
    }),

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
