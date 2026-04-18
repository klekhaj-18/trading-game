import { z } from "zod";

export const ROUTINE_SLOTS = ["premarket", "open", "midmorning", "afternoon", "close"] as const;
export type RoutineSlot = (typeof ROUTINE_SLOTS)[number];

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
}

export interface HaikuDecisionsOutput {
  reasoning: string;
  decisions: HaikuDecision[];
}

export interface RoutineRunSummary {
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
