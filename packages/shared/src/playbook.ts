import { z } from "zod";

export const alpacaKeysSchema = z.object({
  apiKey: z.string().trim().min(10).max(100),
  apiSecret: z.string().trim().min(10).max(100),
});
export type AlpacaKeysInput = z.infer<typeof alpacaKeysSchema>;

export const playbookInputSchema = z.object({
  goal: z.string().trim().min(20, "Give Claude at least a few sentences of goal.").max(4000),
  playbook: z.string().trim().min(40, "Playbook needs more detail.").max(8000),
});
export type PlaybookDraftInput = z.infer<typeof playbookInputSchema>;

export const rejectPlanSchema = z.object({
  reason: z.string().trim().min(5, "Leave a reason so the next plan is better.").max(2000),
});

export type ApprovalState = "pending" | "approved" | "rejected" | "superseded";

export interface PlanUniverseEntry {
  symbol: string;
  rationale: string;
}
export interface PlanRule {
  condition: string;
  action: string;
}
export interface OperationalPlan {
  universe: PlanUniverseEntry[];
  entry_rules: PlanRule[];
  exit_rules: PlanRule[];
  sizing: { position_size_pct: number; max_positions: number; concentration_cap_pct: number };
  risk: { max_daily_loss_pct: number; stop_loss_pct: number; take_profit_pct: number };
  per_slot_emphasis: {
    premarket: string;
    open: string;
    midmorning: string;
    afternoon: string;
    close: string;
  };
  markdown_summary: string;
}

export interface PlaybookVersionSummary {
  id: string;
  version: number;
  goalPreview: string;
  createdAt: number;
}

export interface PlanSummary {
  id: string;
  approvalState: ApprovalState;
  claudeModel: string;
  planMarkdown: string;
  planJson: OperationalPlan;
  createdAt: number;
  approvedAt: number | null;
  rejectedReason: string | null;
}

export interface PlaybookCurrentResponse {
  playbook: {
    id: string;
    version: number;
    goalText: string;
    playbookText: string;
    createdAt: number;
  } | null;
  plan: PlanSummary | null;
  history: PlaybookVersionSummary[];
  alpacaLinked: boolean;
}
