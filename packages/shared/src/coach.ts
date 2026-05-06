import { z } from "zod";
import type { OperationalPlan } from "./playbook";

export const coachRoleSchema = z.enum(["user", "assistant"]);
export type CoachRole = z.infer<typeof coachRoleSchema>;

export const coachMessageSchema = z.object({
  role: coachRoleSchema,
  content: z.string().min(1).max(8000),
});
export type CoachMessage = z.infer<typeof coachMessageSchema>;

export const coachChatRequestSchema = z.object({
  messages: z.array(coachMessageSchema).min(1).max(50),
});
export type CoachChatRequest = z.infer<typeof coachChatRequestSchema>;

export interface CoachDraft {
  goal: string;
  playbook: string;
}

/** Coach proposes rewriting the goal+playbook text. Server will re-translate via Opus to a new pending plan. */
export interface CoachPlaybookRevision {
  goal: string;
  playbook: string;
  rationale: string;
}

/** Coach proposes a fully-formed OperationalPlan revision. Skips re-translation; server stores directly as pending plan. */
export interface CoachPlanRevision {
  plan: OperationalPlan;
  rationale: string;
}

export interface CoachChatResponse {
  assistantText: string;
  draft: CoachDraft | null;
  playbookRevision: CoachPlaybookRevision | null;
  planRevision: CoachPlanRevision | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number | null;
    cache_creation_input_tokens: number | null;
  };
}
