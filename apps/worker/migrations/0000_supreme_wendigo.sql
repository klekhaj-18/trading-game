CREATE TABLE `equity_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`equity` text NOT NULL,
	`cash` text NOT NULL,
	`buying_power` text NOT NULL,
	`long_market_value` text NOT NULL,
	`captured_at` integer DEFAULT (strftime('%s','now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `equity_user_captured_idx` ON `equity_snapshots` (`user_id`,`captured_at`);--> statement-breakpoint
CREATE TABLE `one_shot_instructions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`routine_run_id` text,
	`instruction` text NOT NULL,
	`created_at` integer DEFAULT (strftime('%s','now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`routine_run_id`) REFERENCES `routine_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `instructions_user_created_idx` ON `one_shot_instructions` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `operational_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`playbook_id` text NOT NULL,
	`plan_json` text NOT NULL,
	`plan_markdown` text NOT NULL,
	`claude_model` text NOT NULL,
	`approval_state` text DEFAULT 'pending' NOT NULL,
	`approved_at` integer,
	`rejected_reason` text,
	`created_at` integer DEFAULT (strftime('%s','now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`playbook_id`) REFERENCES `playbooks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `plans_user_state_idx` ON `operational_plans` (`user_id`,`approval_state`);--> statement-breakpoint
CREATE INDEX `plans_user_created_idx` ON `operational_plans` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `playbooks` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`version` integer NOT NULL,
	`goal_text` text NOT NULL,
	`playbook_text` text NOT NULL,
	`created_at` integer DEFAULT (strftime('%s','now')) NOT NULL,
	`superseded_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `playbooks_user_version_uq` ON `playbooks` (`user_id`,`version`);--> statement-breakpoint
CREATE INDEX `playbooks_user_created_idx` ON `playbooks` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `rate_limits` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`bucket` text NOT NULL,
	`window_start` integer NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rate_limits_user_bucket_window_uq` ON `rate_limits` (`user_id`,`bucket`,`window_start`);--> statement-breakpoint
CREATE TABLE `routine_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`operational_plan_id` text,
	`kind` text NOT NULL,
	`scheduled_slot` text,
	`one_shot_instruction` text,
	`market_snapshot_json` text,
	`claude_model` text,
	`input_tokens` integer,
	`output_tokens` integer,
	`cache_read_tokens` integer,
	`cache_write_tokens` integer,
	`claude_reasoning` text,
	`decisions_json` text,
	`status` text NOT NULL,
	`error_text` text,
	`started_at` integer DEFAULT (strftime('%s','now')) NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`operational_plan_id`) REFERENCES `operational_plans`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `runs_user_started_idx` ON `routine_runs` (`user_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `runs_user_kind_idx` ON `routine_runs` (`user_id`,`kind`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`jti` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer DEFAULT (strftime('%s','now')) NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`competition_start_at` integer,
	`competition_end_at` integer,
	`dates_locked` integer DEFAULT false NOT NULL,
	`updated_at` integer DEFAULT (strftime('%s','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `trades` (
	`id` text PRIMARY KEY NOT NULL,
	`alpaca_order_id` text NOT NULL,
	`user_id` text NOT NULL,
	`routine_run_id` text,
	`symbol` text NOT NULL,
	`side` text NOT NULL,
	`qty` text NOT NULL,
	`filled_qty` text,
	`filled_avg_price` text,
	`order_status` text NOT NULL,
	`submitted_at` integer NOT NULL,
	`filled_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`routine_run_id`) REFERENCES `routine_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `trades_alpaca_order_uq` ON `trades` (`alpaca_order_id`);--> statement-breakpoint
CREATE INDEX `trades_user_submitted_idx` ON `trades` (`user_id`,`submitted_at`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`password_hash` text NOT NULL,
	`team_color` text NOT NULL,
	`alpaca_key_ciphertext` text,
	`alpaca_secret_ciphertext` text,
	`alpaca_key_iv` text,
	`alpaca_account_id` text,
	`created_at` integer DEFAULT (strftime('%s','now')) NOT NULL,
	`onboarded_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_display_name_uq` ON `users` (`display_name`);