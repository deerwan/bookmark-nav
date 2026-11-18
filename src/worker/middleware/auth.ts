import { createMiddleware } from "hono/factory";
import { getCookie } from "hono/cookie";
import { verify } from "hono/jwt";
import { eq } from "drizzle-orm";
import { createDb, type Db } from "../db/client";
import { apiTokens, users } from "../db/schema";
import { hashApiToken, isApiToken } from "../lib/token";
import { AUTH_COOKIE, type AppEnv, type JwtUser } from "../lib/types";

// lastUsedAt 写库节流:每 60s 最多写一次,避免每次插件请求都 UPDATE。
// Worker 会被回收,缓存丢失只是多写一次,无正确性问题。
const LAST_USED_THROTTLE_MS = 60_000;
const lastUsedCache = new Map<number, number>();

function maybeTouchLastUsed(db: Db, tokenId: number) {
	const now = Date.now();
	if (now - (lastUsedCache.get(tokenId) ?? 0) < LAST_USED_THROTTLE_MS) return;
	lastUsedCache.set(tokenId, now);
	try {
		void db
			.update(apiTokens)
			.set({ lastUsedAt: new Date(now) })
			.where(eq(apiTokens.id, tokenId))
			.run();
	} catch {
		// 写失败不影响认证结果,下次请求可重试
	}
}

// 软认证:有合法 token 则注入 user,没有也放行(公开接口按登录态过滤 visibility)
export const softAuth = createMiddleware<AppEnv>(async (c, next) => {
	// 插件走 Bearer 令牌;无效(如已吊销)时继续回落 cookie 认证,避免误伤
	const authz = c.req.header("Authorization") ?? "";
	const bearer = authz.startsWith("Bearer ") ? authz.slice(7).trim() : "";
	if (isApiToken(bearer)) {
		const db = createDb(c.env.DB);
		const user = await userFromApiToken(db, bearer);
		if (user) {
			c.set("user", user satisfies JwtUser);
			await next();
			return;
		}
	}

	const token = getCookie(c, AUTH_COOKIE);
	if (token) {
		try {
			const payload = await verify(token, c.env.JWT_SECRET, "HS256");
			if (typeof payload.id === "number" && typeof payload.username === "string") {
				// 校验 token 版本:改密码后旧 token 立即失效
				const db = createDb(c.env.DB);
				const [user] = await db
					.select({
						id: users.id,
						username: users.username,
						tokenVersion: users.tokenVersion,
					})
					.from(users)
					.where(eq(users.id, payload.id))
					.limit(1);
				// 缺少 ver 字段的旧版 token 一律视为失效
				const ver = typeof payload.ver === "number" ? payload.ver : -1;
				if (user && user.tokenVersion === ver) {
					c.set("user", { id: user.id, username: user.username } satisfies JwtUser);
				}
			}
		} catch {
			// token 无效/过期:视为未登录,不报错
		}
	}
	await next();
});

// 强认证:管理接口必须登录
export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
	if (!c.get("user")) {
		return c.json({ error: "Unauthorized" }, 401);
	}
	await next();
});

// 按令牌哈希查用户:优先查 api_tokens 新表,查不到再回退旧 users 字段(迁移兼容)。
// 返回 user 时附带 tokenId 供 lastUsedAt 节流写入。
export async function userFromApiToken(
	db: Db,
	raw: string,
): Promise<(JwtUser & { tokenId?: number }) | null> {
	const hash = await hashApiToken(raw);
	const [row] = await db
		.select({
			tokenId: apiTokens.id,
			userId: apiTokens.userId,
			status: apiTokens.status,
			expiresAt: apiTokens.expiresAt,
			username: users.username,
		})
		.from(apiTokens)
		.innerJoin(users, eq(apiTokens.userId, users.id))
		.where(eq(apiTokens.tokenHash, hash))
		.limit(1);
	if (row && row.status === "active" && (!row.expiresAt || row.expiresAt.getTime() > Date.now())) {
		maybeTouchLastUsed(db, row.tokenId);
		return { id: row.userId, username: row.username, tokenId: row.tokenId };
	}

	// 回退:仅当该用户新表里一条令牌都没有(尚未使用新系统)时,才认旧字段。
	// 否则用户删除/停用新表令牌后会被旧字段"复活",导致吊销失效。
	const [legacy] = await db
		.select({ id: users.id, username: users.username })
		.from(users)
		.where(eq(users.apiTokenHash, hash))
		.limit(1);
	if (legacy) {
		const [anyNew] = await db
			.select({ id: apiTokens.id })
			.from(apiTokens)
			.where(eq(apiTokens.userId, legacy.id))
			.limit(1);
		if (!anyNew) return { id: legacy.id, username: legacy.username };
	}
	return null;
}
