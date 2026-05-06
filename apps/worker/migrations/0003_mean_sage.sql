CREATE TABLE `user_intents` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`text` text NOT NULL,
	`binding_next_slot` integer DEFAULT false NOT NULL,
	`expires_at` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`routine_run_id` text,
	`rejected_reason` text,
	`consumed_at` integer,
	`created_at` integer DEFAULT (strftime('%s','now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`routine_run_id`) REFERENCES `routine_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `intents_user_status_idx` ON `user_intents` (`user_id`,`status`);--> statement-breakpoint
CREATE INDEX `intents_user_created_idx` ON `user_intents` (`user_id`,`created_at`);