import { z } from "zod";

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
});
export type CreateIntentInput = z.infer<typeof createIntentSchema>;

export interface IntentsListResponse {
  pending: IntentSummary[];
  recent: IntentSummary[];
}
