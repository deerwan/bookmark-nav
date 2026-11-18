import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { setCookie, deleteCookie } from "hono/cookie";
import { sign } from "hono/jwt";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { createDb } from "../db/client";
import { apiTokens, users } from "../db/schema";
import { hashPassword, verifyPassword } from "../lib/password";
import { requireAuth } from "../middleware/auth";
import { AUTH_COOKIE, TOKEN_TTL_SECONDS, type AppEnv } from "../lib/types";
import {
	clearRateLimit,
	clientIp,
	consumeRateLimit,
	pruneRateLimits,
} from "../lib/rate-limit";

const credentialsSchema = z.object({
	username: z.string().min(1).max(50),
	password: z.string().min(6).max(100),
});

// 登录限流:IP 维度防止通过轮换用户名绕过,IP+用户名维度防止单账号爆破
const LOGIN_WINDOW_MS = 15 * 60_000;
const LOGIN_IP_LIMIT = 30;
const LOGIN_USER_LIMIT = 10;

// 初始化接口未初始化前对所有人开放:先限流再判断,防公网扫描器抢注/爆破
const SETUP_WINDOW_MS = 60 * 60_000;
const SETUP_IP_LIMIT = 10;

// tokenVersion 写入 JWT,配合 softAuth 校验实现改密码后旧会话失效
async function issueToken(
	c: Context<AppEnv>,
	user: { id: number; username: string; tokenVersion?: number },
) {
	// 漏配 JWT_SECRET 时给出明确提示,而非模糊的 500
	if (!c.env.JWT_SECRET) {
		throw new HTTPException(500, {
			message:
				"服务未配置 JWT_SECRET:请在 Worker → 设置 → 变量和机密中添加机密 JWT_SECRET 后重试",
		});
	}
	const token = await sign(
		{
			id: user.id,
			username: user.username,
			ver: user.tokenVersion ?? 0,
			exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
		},
		c.env.JWT_SECRET,
		"HS256",
	);
	setCookie(c, AUTH_COOKIE, token, {
		httpOnly: true,
		secure: true,
		sameSite: "Lax",
		path: "/",
		maxAge: TOKEN_TTL_SECONDS,
	});
}

export const authRoutes = new Hono<AppEnv>()
	// 初始化状态:前端据此决定显示"初始化管理员"还是"登录"
	.get("/status", async (c) => {
		const db = createDb(c.env.DB);
		const [first] = await db.select({ id: users.id }).from(users).limit(1);
		return c.json({
			initialized: !!first,
			authenticated: !!c.get("user"),
			user: c.get("user") ?? null,
		});
	})
	// 首次初始化管理员,仅当没有任何用户时可用
	.post("/setup", zValidator("json", credentialsSchema), async (c) => {
		const db = createDb(c.env.DB);
		const setupRl = await consumeRateLimit(
			db,
			`setup:${clientIp(c)}`,
			SETUP_IP_LIMIT,
			SETUP_WINDOW_MS,
		);
		if (!setupRl.ok) {
			await pruneRateLimits(db, SETUP_WINDOW_MS);
			return c.json({ error: "尝试次数过多,请稍后再试" }, 429);
		}
		const [exists] = await db.select({ id: users.id }).from(users).limit(1);
		if (exists) {
			return c.json({ error: "Already initialized" }, 403);
		}
		const { username, password } = c.req.valid("json");
		const [user] = await db
			.insert(users)
			.values({ username, passwordHash: await hashPassword(password) })
			.returning({
				id: users.id,
				username: users.username,
				tokenVersion: users.tokenVersion,
			});
		// 并发兜底:先查后插有竞态,插完再确认一次,多出来的立即回滚
		const all = await db.select({ id: users.id }).from(users);
		if (all.length > 1) {
			await db.delete(users).where(eq(users.id, user.id));
			return c.json({ error: "Already initialized" }, 403);
		}
		await issueToken(c, user);
		return c.json({ user });
	})
	.post("/login", zValidator("json", credentialsSchema), async (c) => {
		const db = createDb(c.env.DB);
		const { username, password } = c.req.valid("json");
		const ip = clientIp(c);
		const ipKey = `login:${ip}`;
		const userKey = `login:${ip}:${username}`;
		const byIp = await consumeRateLimit(db, ipKey, LOGIN_IP_LIMIT, LOGIN_WINDOW_MS);
		if (!byIp.ok) {
			await pruneRateLimits(db, LOGIN_WINDOW_MS);
			return c.json({ error: "尝试次数过多,请 15 分钟后再试" }, 429);
		}
		const byUser = await consumeRateLimit(db, userKey, LOGIN_USER_LIMIT, LOGIN_WINDOW_MS);
		if (!byUser.ok) {
			return c.json({ error: "尝试次数过多,请 15 分钟后再试" }, 429);
		}
		const [user] = await db
			.select()
			.from(users)
			.where(eq(users.username, username))
			.limit(1);
		if (!user || !(await verifyPassword(password, user.passwordHash))) {
			return c.json({ error: "用户名或密码错误" }, 401);
		}
		// 登录成功清零,避免正常用户的历史失败次数累积
		await Promise.all([clearRateLimit(db, ipKey), clearRateLimit(db, userKey)]);
		await issueToken(c, user);
		return c.json({ user: { id: user.id, username: user.username } });
	})
	// 修改当前登录用户的密码,需验证原密码
	.post(
		"/change-password",
		requireAuth,
		zValidator(
			"json",
			z.object({
				oldPassword: z.string().min(1).max(100),
				newPassword: z.string().min(6).max(100),
			}),
		),
		async (c) => {
			const me = c.get("user")!;
			const db = createDb(c.env.DB);
			const { oldPassword, newPassword } = c.req.valid("json");
			const [user] = await db
				.select()
				.from(users)
				.where(eq(users.id, me.id))
				.limit(1);
			if (!user || !(await verifyPassword(oldPassword, user.passwordHash))) {
				return c.json({ error: "当前密码错误" }, 400);
			}
			// tokenVersion 自增,使此前签发的所有 JWT 立即失效;
			// 同时撤销该用户全部插件令牌(权限等同管理员,改密码必须连带失效)
			const [updated] = await db
				.update(users)
				.set({
					passwordHash: await hashPassword(newPassword),
					tokenVersion: sql`${users.tokenVersion} + 1`,
				})
				.where(eq(users.id, me.id))
				.returning({
					id: users.id,
					username: users.username,
					tokenVersion: users.tokenVersion,
				});
			await db.delete(apiTokens).where(eq(apiTokens.userId, me.id));
			// 重新签发当前会话,避免改密码后把自己也踢下线
			await issueToken(c, updated);
			return c.json({ ok: true });
		},
	)
	// 修改当前登录用户的用户名,需验证当前密码
	.post(
		"/change-username",
		requireAuth,
		zValidator(
			"json",
			z.object({
				username: z.string().min(1).max(50),
				password: z.string().min(1).max(100),
			}),
		),
		async (c) => {
			const me = c.get("user")!;
			const db = createDb(c.env.DB);
			const { username, password } = c.req.valid("json");
			const [user] = await db
				.select()
				.from(users)
				.where(eq(users.id, me.id))
				.limit(1);
			if (!user || !(await verifyPassword(password, user.passwordHash))) {
				return c.json({ error: "密码错误" }, 400);
			}
			if (username !== user.username) {
				const [taken] = await db
					.select({ id: users.id })
					.from(users)
					.where(eq(users.username, username))
					.limit(1);
				if (taken) {
					return c.json({ error: "用户名已被使用" }, 400);
				}
			}
			const [updated] = await db
				.update(users)
				.set({ username })
				.where(eq(users.id, me.id))
				.returning({
					id: users.id,
					username: users.username,
					tokenVersion: users.tokenVersion,
				});
			// 用户名存在 JWT 里,修改后重新签发 token
			await issueToken(c, updated);
			return c.json({ user: { id: updated.id, username: updated.username } });
		},
	)
	.post("/logout", (c) => {
		deleteCookie(c, AUTH_COOKIE, { path: "/" });
		return c.json({ ok: true });
	});
