CREATE TABLE `api_tokens` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`hint` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`scopes` text,
	`expires_at` integer,
	`last_used_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_tokens_hash_idx` ON `api_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `api_tokens_user_idx` ON `api_tokens` (`user_id`);
--> statement-breakpoint
-- 数据搬迁:把用户表现存的单个令牌搬成一条命名令牌,不中断已配置的插件。
-- created_at 沿用旧值;旧字段保留不删,认证层做双读回退以防遗漏。
INSERT INTO `api_tokens` (`user_id`, `name`, `token_hash`, `hint`, `created_at`)
SELECT `id`, '迁移令牌', `api_token_hash`, `api_token_hint`, `api_token_created_at`
FROM `users` WHERE `api_token_hash` IS NOT NULL;