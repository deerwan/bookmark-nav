import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "../db/schema";
import type { Db } from "../db/client";
import {
	clearRateLimit,
	consumeRateLimit,
	pruneRateLimits,
} from "./rate-limit";

// 用内存 SQLite 按真实 schema 建表,验证 upsert SQL 在真实引擎下的语义。
// better-sqlite3 驱动与 D1 驱动的 SQL 方言完全一致,仅缺 D1 特有的 batch 方法,
// 断言为 Db 以通过函数签名(与生产代码的 D1 实例行为无差异)。
function setupDb(): Db {
	const sqlite = new Database(":memory:");
	sqlite.exec(
		"CREATE TABLE rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0, window_start INTEGER NOT NULL DEFAULT (unixepoch()))",
	);
	return drizzle(sqlite, { schema }) as unknown as Db;
}

const WINDOW_MS = 60_000;

describe("rate-limit(内存 SQLite 验证真实 SQL 语义)", () => {
	let db: ReturnType<typeof setupDb>;
	beforeEach(() => {
		db = setupDb();
	});

	it("未超限时依次放行,计数递增", async () => {
		await expect(consumeRateLimit(db, "k", 3, WINDOW_MS)).resolves.toEqual({ ok: true, remaining: 2 });
		await expect(consumeRateLimit(db, "k", 3, WINDOW_MS)).resolves.toEqual({ ok: true, remaining: 1 });
		await expect(consumeRateLimit(db, "k", 3, WINDOW_MS)).resolves.toEqual({ ok: true, remaining: 0 });
	});

	it("超过限制后拒绝", async () => {
		for (let i = 0; i < 3; i++) await consumeRateLimit(db, "k", 3, WINDOW_MS);
		const fourth = await consumeRateLimit(db, "k", 3, WINDOW_MS);
		expect(fourth.ok).toBe(false);
		expect(fourth.remaining).toBe(0);
	});

	it("不同 key 相互独立", async () => {
		await consumeRateLimit(db, "a", 1, WINDOW_MS);
		const b = await consumeRateLimit(db, "b", 1, WINDOW_MS);
		expect(b.ok).toBe(true);
	});

	it("窗口过期后重置计数(upsert 的 CASE 分支)", async () => {
		await consumeRateLimit(db, "k", 1, WINDOW_MS);
		// 手动把 window_start 拨回 2 小时前,模拟窗口过期
		const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000);
		db.run(
			`UPDATE rate_limits SET window_start = ${Math.floor(twoHoursAgo.getTime() / 1000)} WHERE key = 'k'`,
		);
		const next = await consumeRateLimit(db, "k", 1, WINDOW_MS);
		expect(next.ok).toBe(true);
	});

	it("clearRateLimit 清零指定 key", async () => {
		await consumeRateLimit(db, "k", 1, WINDOW_MS);
		await clearRateLimit(db, "k");
		const again = await consumeRateLimit(db, "k", 1, WINDOW_MS);
		expect(again.ok).toBe(true);
	});

	it("pruneRateLimits 只清理过期窗口的行", async () => {
		await consumeRateLimit(db, "old", 5, WINDOW_MS);
		await consumeRateLimit(db, "fresh", 5, WINDOW_MS);
		// old 拨到 2 小时前,fresh 保持
		const twoHoursAgo = Math.floor((Date.now() - 2 * 3_600_000) / 1000);
		db.run(`UPDATE rate_limits SET window_start = ${twoHoursAgo} WHERE key = 'old'`);

		await pruneRateLimits(db, WINDOW_MS);

		const rows = await db.select().from(schema.rateLimits);
		expect(rows.map((r) => r.key)).toEqual(["fresh"]);
	});
});
