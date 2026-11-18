import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { apiTokens, users } from "../db/schema";
import type { Db } from "../db/client";
import { generateApiToken, hashApiToken } from "./token";
import { userFromApiToken } from "../middleware/auth";

// 用 better-sqlite3 内存库 + drizzle 模拟 D1(SQL 方言一致)。
// 只建认证所需的两张表,外键开启以验证 user_id 级联。
function setupDb() {
	const sqlite = new Database(":memory:");
	sqlite.pragma("foreign_keys = ON");
	sqlite.exec(`
		CREATE TABLE users (
			id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
			username text NOT NULL,
			token_version integer DEFAULT 0 NOT NULL,
			api_token_hash text
		);
		CREATE TABLE api_tokens (
			id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
			user_id integer NOT NULL REFERENCES users(id) ON DELETE cascade,
			name text NOT NULL,
			token_hash text NOT NULL,
			hint text NOT NULL,
			status text DEFAULT 'active' NOT NULL,
			scopes text,
			expires_at integer,
			last_used_at integer,
			created_at integer DEFAULT (unixepoch()) NOT NULL
		);
		CREATE UNIQUE INDEX api_tokens_hash_idx ON api_tokens (token_hash);
	`);
	return sqlite;
}

type TestDb = ReturnType<typeof setupDb>;
// D1 与 better-sqlite3 两种 drizzle 驱动的查询 API 运行时一致;
// 仅类型签名不同(D1 多一个 batch 方法),这里断言成生产 Db 以便复用中间件函数。
function makeDb(sqlite: TestDb): Db {
	return drizzle(sqlite, { schema: { apiTokens, users } }) as unknown as Db;
}

async function addUser(sqlite: TestDb, username: string) {
	const r = sqlite.prepare("INSERT INTO users (username) VALUES (?)").run(username);
	return Number(r.lastInsertRowid);
}

async function addToken(
	db: ReturnType<typeof makeDb>,
	dbRaw: TestDb,
	userId: number,
	name: string,
	overrides?: { status?: string; expiresAt?: Date | null; hash?: string },
) {
	const raw = generateApiToken();
	const hash = overrides?.hash ?? (await hashApiToken(raw));
	const r = dbRaw
		.prepare(
			"INSERT INTO api_tokens (user_id, name, token_hash, hint, status, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
		)
		.run(
			userId,
			name,
			hash,
			raw.slice(-4),
			overrides?.status ?? "active",
			overrides?.expiresAt ? Math.floor(overrides.expiresAt.getTime() / 1000) : null,
		);
	return { raw, id: Number(r.lastInsertRowid), db };
}

describe("多令牌认证", () => {
	let sqlite: TestDb;
	let db: ReturnType<typeof makeDb>;
	beforeEach(() => {
		sqlite = setupDb();
		db = makeDb(sqlite);
	});

	it("多个令牌可同时认证,互不干扰", async () => {
		const uid = await addUser(sqlite, "admin");
		const a = await addToken(db, sqlite, uid, "设备A");
		const b = await addToken(db, sqlite, uid, "设备B");
		expect((await userFromApiToken(db, a.raw))?.id).toBe(uid);
		expect((await userFromApiToken(db, b.raw))?.id).toBe(uid);
	});

	it("停用单个令牌后其认证失败,其他令牌仍成功", async () => {
		const uid = await addUser(sqlite, "admin");
		const a = await addToken(db, sqlite, uid, "A");
		const b = await addToken(db, sqlite, uid, "B");
		sqlite.prepare("UPDATE api_tokens SET status = 'disabled' WHERE id = ?").run(a.id);
		expect(await userFromApiToken(db, a.raw)).toBeNull();
		expect((await userFromApiToken(db, b.raw))?.id).toBe(uid);
	});

	it("删除单个令牌后其认证失败,其他令牌仍成功", async () => {
		const uid = await addUser(sqlite, "admin");
		const a = await addToken(db, sqlite, uid, "A");
		const b = await addToken(db, sqlite, uid, "B");
		sqlite.prepare("DELETE FROM api_tokens WHERE id = ?").run(a.id);
		expect(await userFromApiToken(db, a.raw)).toBeNull();
		expect((await userFromApiToken(db, b.raw))?.id).toBe(uid);
	});

	it("过期令牌认证失败", async () => {
		const uid = await addUser(sqlite, "admin");
		const past = await addToken(db, sqlite, uid, "过期", {
			expiresAt: new Date(Date.now() - 60_000),
		});
		const future = await addToken(db, sqlite, uid, "有效", {
			expiresAt: new Date(Date.now() + 3_600_000),
		});
		expect(await userFromApiToken(db, past.raw)).toBeNull();
		expect((await userFromApiToken(db, future.raw))?.id).toBe(uid);
	});

	it("删除用户后其令牌级联清理", async () => {
		const uid = await addUser(sqlite, "admin");
		const a = await addToken(db, sqlite, uid, "A");
		sqlite.prepare("DELETE FROM users WHERE id = ?").run(uid);
		expect(await userFromApiToken(db, a.raw)).toBeNull();
	});

	it("旧 users 字段的令牌仍可回退认证(迁移兼容)", async () => {
		const uid = await addUser(sqlite, "admin");
		const raw = generateApiToken();
		sqlite
			.prepare("UPDATE users SET api_token_hash = ? WHERE id = ?")
			.run(await hashApiToken(raw), uid);
		expect((await userFromApiToken(db, raw))?.id).toBe(uid);
	});

	it("用户已有新表令牌时,旧字段不再回退(防止删除后令牌复活)", async () => {
		const uid = await addUser(sqlite, "admin");
		const legacyRaw = generateApiToken();
		sqlite
			.prepare("UPDATE users SET api_token_hash = ? WHERE id = ?")
			.run(await hashApiToken(legacyRaw), uid);
		// 新建一条新表令牌后,旧字段应立即停止生效
		await addToken(db, sqlite, uid, "新令牌");
		expect(await userFromApiToken(db, legacyRaw)).toBeNull();
	});

	it("随机令牌与格式不符的令牌均认证失败", async () => {
		await addUser(sqlite, "admin");
		expect(await userFromApiToken(db, generateApiToken())).toBeNull();
		expect(await userFromApiToken(db, "not-a-token")).toBeNull();
	});
});
