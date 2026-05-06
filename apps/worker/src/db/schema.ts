import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const ulid = () => text("id").primaryKey();
const unixNow = sql`(strftime('%s','now'))`;

export const users = sqliteTable(
  "users",
  {
    id: ulid(),
    displayName: text("display_name").notNull(),
    passwordHash: text("password_hash").notNull(),
    teamColor: text("team_color").notNull(),
    alpacaKeyCiphertext: text("alpaca_key_ciphertext"),
    alpacaKeyIv: text("alpaca_key_iv"),
    alpacaSecretCiphertext: text("alpaca_secret_ciphertext"),
    alpacaSecretIv: text("alpaca_secret_iv"),
    alpacaAccountId: text("alpaca_account_id"),
    createdAt: integer("created_at").notNull().default(unixNow),
    onboardedAt: integer("onboarded_at"),
  },
  (t) => ({
    displayNameUq: uniqueIndex("users_display_name_uq").on(t.displayName),
  }),
);

export const sessions = sqliteTable(
  "sessions",
  {
    jti: text("jti").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull().default(unixNow),
    expiresAt: integer("expires_at").notNull(),
    revokedAt: integer("revoked_at"),
  },
  (t) => ({
    userIdx: index("sessions_user_idx").on(t.userId),
  }),
);

export const playbooks = sqliteTable(
  "playbooks",
  {
    id: ulid(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    goalText: text("goal_text").notNull(),
    playbookText: text("playbook_text").notNull(),
    createdAt: integer("created_at").notNull().default(unixNow),
    supersededAt: integer("superseded_at"),
  },
  (t) => ({
    userVersionUq: uniqueIndex("playbooks_user_version_uq").on(t.userId, t.version),
    userCreatedIdx: index("playbooks_user_created_idx").on(t.userId, t.createdAt),
  }),
);

export const operationalPlans = sqliteTable(
  "operational_plans",
  {
    id: ulid(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    playbookId: text("playbook_id")
      .notNull()
      .references(() => playbooks.id, { onDelete: "cascade" }),
    planJson: text("plan_json").notNull(),
    planMarkdown: text("plan_markdown").notNull(),
    claudeModel: text("claude_model").notNull(),
    approvalState: text("approval_state").notNull().default("pending"),
    approvedAt: integer("approved_at"),
    rejectedReason: text("rejected_reason"),
    createdAt: integer("created_at").notNull().default(unixNow),
  },
  (t) => ({
    userStateIdx: index("plans_user_state_idx").on(t.userId, t.approvalState),
    userCreatedIdx: index("plans_user_created_idx").on(t.userId, t.createdAt),
  }),
);

export const routineRuns = sqliteTable(
  "routine_runs",
  {
    id: ulid(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    operationalPlanId: text("operational_plan_id").references(() => operationalPlans.id),
    kind: text("kind").notNull(),
    scheduledSlot: text("scheduled_slot"),
    oneShotInstruction: text("one_shot_instruction"),
    marketSnapshotJson: text("market_snapshot_json"),
    claudeModel: text("claude_model"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    cacheReadTokens: integer("cache_read_tokens"),
    cacheWriteTokens: integer("cache_write_tokens"),
    claudeReasoning: text("claude_reasoning"),
    decisionsJson: text("decisions_json"),
    status: text("status").notNull(),
    errorText: text("error_text"),
    startedAt: integer("started_at").notNull().default(unixNow),
    completedAt: integer("completed_at"),
  },
  (t) => ({
    userStartedIdx: index("runs_user_started_idx").on(t.userId, t.startedAt),
    userKindIdx: index("runs_user_kind_idx").on(t.userId, t.kind),
  }),
);

export const trades = sqliteTable(
  "trades",
  {
    id: ulid(),
    alpacaOrderId: text("alpaca_order_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    routineRunId: text("routine_run_id").references(() => routineRuns.id),
    source: text("source").notNull().default("ai"),
    symbol: text("symbol").notNull(),
    side: text("side").notNull(),
    qty: text("qty").notNull(),
    filledQty: text("filled_qty"),
    filledAvgPrice: text("filled_avg_price"),
    orderStatus: text("order_status").notNull(),
    submittedAt: integer("submitted_at").notNull(),
    filledAt: integer("filled_at"),
  },
  (t) => ({
    alpacaOrderUq: uniqueIndex("trades_alpaca_order_uq").on(t.alpacaOrderId),
    userSubmittedIdx: index("trades_user_submitted_idx").on(t.userId, t.submittedAt),
  }),
);

export const equitySnapshots = sqliteTable(
  "equity_snapshots",
  {
    id: ulid(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    equity: text("equity").notNull(),
    cash: text("cash").notNull(),
    buyingPower: text("buying_power").notNull(),
    longMarketValue: text("long_market_value").notNull(),
    capturedAt: integer("captured_at").notNull().default(unixNow),
  },
  (t) => ({
    userCapturedIdx: index("equity_user_captured_idx").on(t.userId, t.capturedAt),
  }),
);

export const userIntents = sqliteTable(
  "user_intents",
  {
    id: ulid(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    bindingNextSlot: integer("binding_next_slot", { mode: "boolean" }).notNull().default(false),
    expiresAt: integer("expires_at").notNull(),
    status: text("status").notNull().default("pending"),
    routineRunId: text("routine_run_id").references(() => routineRuns.id),
    rejectedReason: text("rejected_reason"),
    consumedAt: integer("consumed_at"),
    createdAt: integer("created_at").notNull().default(unixNow),
  },
  (t) => ({
    userStatusIdx: index("intents_user_status_idx").on(t.userId, t.status),
    userCreatedIdx: index("intents_user_created_idx").on(t.userId, t.createdAt),
  }),
);

export const oneShotInstructions = sqliteTable(
  "one_shot_instructions",
  {
    id: ulid(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    routineRunId: text("routine_run_id").references(() => routineRuns.id),
    instruction: text("instruction").notNull(),
    createdAt: integer("created_at").notNull().default(unixNow),
  },
  (t) => ({
    userCreatedIdx: index("instructions_user_created_idx").on(t.userId, t.createdAt),
  }),
);

export const rateLimits = sqliteTable(
  "rate_limits",
  {
    id: ulid(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    bucket: text("bucket").notNull(),
    windowStart: integer("window_start").notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => ({
    userBucketWindowUq: uniqueIndex("rate_limits_user_bucket_window_uq").on(
      t.userId,
      t.bucket,
      t.windowStart,
    ),
  }),
);

export const settings = sqliteTable("settings", {
  id: integer("id").primaryKey(),
  competitionStartAt: integer("competition_start_at"),
  competitionEndAt: integer("competition_end_at"),
  datesLocked: integer("dates_locked", { mode: "boolean" }).notNull().default(false),
  updatedAt: integer("updated_at").notNull().default(unixNow),
});
