import { sql } from "drizzle-orm";
import { integer, index, primaryKey, sqliteTable, text, uniqueIndex, type AnySQLiteColumn } from "drizzle-orm/sqlite-core";

// 管理员用户(单用户模型,建表便于扩展)
export const users = sqliteTable(
	"users",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		username: text("username").notNull().unique(),
		passwordHash: text("password_hash").notNull(),
		// 改密码时自增,用于让此前签发的 JWT 立即失效
		tokenVersion: integer("token_version").notNull().default(0),
		// 浏览器插件等外部客户端的长期访问令牌(只存 SHA-256,明文仅生成时返回一次;null 表示未启用)
		apiTokenHash: text("api_token_hash"),
		// 令牌末 4 位,后台展示用于辨认
		apiTokenHint: text("api_token_hint"),
		apiTokenCreatedAt: integer("api_token_created_at", { mode: "timestamp" }),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
	},
	(t) => [
		// Bearer 令牌认证按哈希等值查询,每次插件 API 请求都会走(0003 建表时漏了索引,0004 补上)
		uniqueIndex("users_api_token_hash_idx").on(t.apiTokenHash),
	],
);

// 分类(支持任意层级嵌套,parentId 为 null 表示顶级)
export const categories = sqliteTable(
	"categories",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		name: text("name").notNull(),
		icon: text("icon"),
		parentId: integer("parent_id").references((): AnySQLiteColumn => categories.id, {
			onDelete: "cascade",
		}),
		sort: integer("sort").notNull().default(0),
		// public: 所有人可见; private: 登录后可见
		visibility: text("visibility", { enum: ["public", "private"] })
			.notNull()
			.default("public"),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
	},
	(t) => [
		// 祖先链遍历(可见性过滤/树构建)按 parentId 逐层查子级
		index("categories_parent_idx").on(t.parentId),
	],
);

// 书签
export const bookmarks = sqliteTable(
	"bookmarks",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		title: text("title").notNull(),
		url: text("url").notNull(),
		description: text("description"),
		icon: text("icon"),
		categoryId: integer("category_id").references(() => categories.id, {
			onDelete: "set null",
		}),
		sort: integer("sort").notNull().default(0),
		clickCount: integer("click_count").notNull().default(0),
		isPinned: integer("is_pinned", { mode: "boolean" }).notNull().default(false),
		// public: 所有人可见; private: 登录后可见
		visibility: text("visibility", { enum: ["public", "private"] })
			.notNull()
			.default("public"),
		// active: 正常; dead: 死链检测标记失效
		status: text("status", { enum: ["active", "dead"] })
			.notNull()
			.default("active"),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
		updatedAt: integer("updated_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
	},
	(t) => [
		// 按分类过滤书签;URL 唯一性检查/插件查重按 url 等值查询
		index("bookmarks_category_idx").on(t.categoryId),
		index("bookmarks_url_idx").on(t.url),
	],
);

// 标签
export const tags = sqliteTable("tags", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	name: text("name").notNull().unique(),
});

// 书签-标签 多对多
export const bookmarkTags = sqliteTable(
	"bookmark_tags",
	{
		bookmarkId: integer("bookmark_id")
			.notNull()
			.references(() => bookmarks.id, { onDelete: "cascade" }),
		tagId: integer("tag_id")
			.notNull()
			.references(() => tags.id, { onDelete: "cascade" }),
	},
	(t) => [primaryKey({ columns: [t.bookmarkId, t.tagId] })],
);

// 站点配置(key-value)
export const settings = sqliteTable("settings", {
	key: text("key").primaryKey(),
	value: text("value").notNull(),
});

// 固定窗口限流计数(登录防爆破、匿名 AI 接口防刷)
export const rateLimits = sqliteTable("rate_limits", {
	key: text("key").primaryKey(),
	count: integer("count").notNull().default(0),
	windowStart: integer("window_start", { mode: "timestamp" })
		.notNull()
		.default(sql`(unixepoch())`),
});

// AI 调用用量记录(免费额度防刷 + 自定义 API 防滥用)
export const aiUsage = sqliteTable(
	"ai_usage",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		feature: text("feature").notNull(),
		provider: text("provider").notNull(),
		success: integer("success").notNull(),
		durationMs: integer("duration_ms"),
		error: text("error"),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
	},
	(t) => [
		// 用量概览按时间过滤、定时清理过期记录都按 createdAt 范围查询
		index("ai_usage_created_at_idx").on(t.createdAt),
	],
);
