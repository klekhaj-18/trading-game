import { z } from "zod";
import type { FireNowResponse } from "./routine";

export const INTENT_STATUSES = ["pending", "honored", "rejected", "expired"] as const;
export type IntentStatus = (typeof INTENT_STATUSES)[number];

export interface IntentSummary {
  id: string;
  text: string;
  bindingNextSlot: boolean;
  status: IntentStatus;
  createdAt: number;
  expiresAt: number;
  consumedAt: number | null;
  rejectedReason: string | null;
  routineRunId: string | null;
}

export const createIntentSchema = z.object({
  text: z.string().trim().min(3).max(500),
  bindingNextSlot: z.boolean().default(false),
  /** TTL hours for standing intents. Ignored when bindingNextSlot=true (auto-set to next slot + 10 min). */
  ttlHours: z.number().int().positive().max(72).default(24),
  /**
   * When true, the server also fires an on-demand routine immediately after
   * the intent is created — instead of waiting for the next scheduled slot.
   * Subject to race-state, concurrency, and rate-limit (5/hour, 15/day) gates.
   * Implies bindingNextSlot semantics for the intent itself.
   */
  fireImmediately: z.boolean().default(false),
});
export type CreateIntentInput = z.infer<typeof createIntentSchema>;

export interface CreateIntentResponse {
  ok: true;
  intent: IntentSummary;
  /** Present only when the request set fireImmediately=true and the routine kicked off. */
  fireNow?: FireNowResponse;
}

export interface IntentsListResponse {
  pending: IntentSummary[];
  recent: IntentSummary[];
}
