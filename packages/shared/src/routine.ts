import { z } from "zod";

export const ROUTINE_SLOTS = ["premarket", "open", "midmorning", "afternoon", "close"] as const;
export type RoutineSlot = (typeof ROUTINE_SLOTS)[number];

/**
 * A scheduled touchpoint persisted on routineRuns.scheduledSlot.
 * Includes the executable trading slots plus "warm" — the pre-premarket factor
 * refresh that prepares KV data for the 09:15 routine. "warm" never invokes
 * the LLM or places orders; it only logs a per-player Radio entry.
 */
export const SCHEDULED_TOUCHPOINTS = [...ROUTINE_SLOTS, "warm"] as const;
export type ScheduledTouchpoint = (typeof SCHEDULED_TOUCHPOINTS)[number];

export const ROUTINE_KINDS = ["scheduled", "on_demand", "admin_test"] as const;
export type RoutineKind = (typeof ROUTINE_KINDS)[number];

export type RoutineStatus =
  | "running"
  | "succeeded"
  | "partial"
  | "validation_failed"
  | "error"
  | "noop_market_closed"
  | "noop_race_not_active";

export const decisionActionSchema = z.enum(["buy", "sell", "plan", "hold"]);
export type DecisionAction = z.infer<typeof decisionActionSchema>;

export interface HaikuDecision {
  action: DecisionAction;
  symbol: string;
  qty: number;
  order_type: "market" | "limit";
  limit_price?: number;
  time_in_force: "day" | "gtc";
  rationale: string;
  /** When set, this decision is fulfilling a player intent and bypasses the universe + duplicate validators. Sizing, concentration, and buying-power caps still apply. */
  intent_id?: string;
}

/** Outcome the routine LLM declares for each pending user intent it saw. */
export interface ConsumedIntent {
  id: string;
  /** honored = an order was placed for it; rejected = cannot be done; deferred = standing intent, conditions not met this slot. */
  status: "honored" | "rejected" | "deferred";
  reason?: string;
}

export interface HaikuDecisionsOutput {
  reasoning: string;
  decisions: HaikuDecision[];
  consumed_intents?: ConsumedIntent[];
}

export interface RoutineRunSummary {
  id: string;
  kind: RoutineKind;
  scheduledSlot: ScheduledTouchpoint | null;
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

export interface ValidationFailure {
  decisionIndex: number;
  symbol: string;
  reason: string;
}

export interface PlacedOrderSummary {
  decisionIndex: number;
  alpacaOrderId: string;
  symbol: string;
  side: "buy" | "sell";
  qty: string;
  orderStatus: string;
  filledAvgPrice: string | null;
}

export const fireTestRoutineSchema = z.object({
  slot: z.enum(ROUTINE_SLOTS),
  oneShotInstruction: z.string().trim().max(2000).optional(),
});
export type FireTestRoutineInput = z.infer<typeof fireTestRoutineSchema>;

export const FIRE_NOW_HOURLY_LIMIT = 5;
export const FIRE_NOW_DAILY_LIMIT = 15;

export interface FireNowResponse {
  runId: string;
  slot: RoutineSlot;
  rateLimit: {
    hourRemaining: number;
    dayRemaining: number;
    hourResetAt: number;
    dayResetAt: number;
  };
}

/**
 * Pick an executable trading slot from a wall-clock time. Used by fire-now to
 * decide which slot context the routine runs in. Outside trading hours and on
 * weekends, fall through to "close" so Claude reasons in end-of-day mode.
 *
 * Hours are in US Eastern; caller passes `nowUtcSec` and we convert.
 */
export function deriveFireNowSlot(nowUtcSec: number): RoutineSlot {
  const d = new Date(nowUtcSec * 1000);
  // Compute Eastern minutes-of-day. Cloudflare Workers don't expose Intl
  // timezone offsets reliably across all runtimes, so use the well-known
  // -5 (EST) / -4 (EDT) heuristic via Date#toLocaleString.
  const etString = d.toLocaleString("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
  // etString example: "Mon, 14:32"
  const dayMatch = etString.match(/^([A-Za-z]+)/);
  const timeMatch = etString.match(/(\d{1,2}):(\d{2})/);
  if (!dayMatch || !timeMatch) return "close";
  const day = dayMatch[1];
  if (day === "Sat" || day === "Sun") return "close";
  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  const minutes = hour * 60 + minute;
  if (minutes < 9 * 60 + 30) return "premarket";
  if (minutes < 10 * 60 + 30) return "open";
  if (minutes < 13 * 60) return "midmorning";
  if (minutes < 15 * 60 + 30) return "afternoon";
  return "close";
}
