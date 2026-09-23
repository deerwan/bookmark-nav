import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { createDb, type Db } from "../db/client";
import {
	aiUsage,
	bookmarks,
	bookmarkTags,
	categories,
	settings,
	tags,
	users,
} from "../db/schema";
import type { AppEnv } from "../lib/types";
import { requireAuth } from "../middleware/auth";
import { mergeDefaultSettings } from "../lib/settings";
import { validateCategoryNesting } from "../lib/category-nesting";
import { checkUrl } from "../lib/check-url";
import { backupToR2, buildBackupPayload } from "../lib/backup";
import { checkAllLinks } from "../lib/maintenance";
import {
	buildNetscapeHtml,
	parseNetscapeHtml,
	type ExportFolder,
	type ParsedFolder,
} from "../lib/netscape";
import { extractJson, loadAISettings, runChat, testModel } from "../lib/ai";
import { generateApiToken, hashApiToken, tokenHint } from "../lib/token";
import { isHttpUrl, httpUrlSchema } from "../lib/http-url";

const idParam = zValidator("param", z.object({ id: z.coerce.number().int() }));
// 与其余批量接口一致限制单次条数:reorder 逐条 UPDATE,不设上限会拖垮请求
const reorderSchema = z.object({ ids: z.array(z.number().int()).min(1).max(1000) });

// 校验分类挂到 parentId 下是否合法:防循环嵌套 + 限制最大层级,见 lib/category-nesting

const categoryInput = z.object({
	name: z.string().min(1).max(50),
	icon: z.string().max(200).nullish(),
	parentId: z.number().int().nullish(),
	sort: z.number().int().optional(),
	visibility: z.enum(["public", "private"]).optional(),
});

const bookmarkInput = z.object({
	title: z.string().min(1).max(200),
	// 强制 http(s):z.string().url() 会放过 javascript: 等协议,渲染成 <a href> 就是存储型 XSS
	url: httpUrlSchema,
	description: z.string().max(500).nullish(),
	icon: z.string().max(2000).nullish(),
	categoryId: z.number().int().nullish(),
	sort: z.number().int().optional(),
	isPinned: z.boolean().optional(),
	visibility: z.enum(["public", "private"]).optional(),
	status: z.enum(["active", "dead"]).optional(),
	tags: z.array(z.string().min(1).max(30)).max(20).optional(),
});

// JSON 备份文件的结构(buildBackupPayload 的产物);字段宽松以兼容历史备份,
// 未知键由 zod 自动剥离,非法行在恢复过程中跳过
// 供前端导入 hook 复用的备份负载类型
export type BackupImportPayload = z.input<typeof backupImportSchema>;

const backupImportSchema = z.object({
	categories: z
		.array(
			z.object({
				id: z.number().int(),
				name: z.string().min(1).max(50),
				icon: z.string().max(200).nullish(),
				parentId: z.number().int().nullish(),
				sort: z.number().int().optional(),
				visibility: z.enum(["public", "private"]).optional(),
			}),
		)
		.max(1000),
	bookmarks: z
		.array(
			z.object({
				id: z.number().int(),
				title: z.string().min(1).max(200),
				url: z.string().max(2000),
				description: z.string().max(500).nullish(),
				icon: z.string().max(2000).nullish(),
				categoryId: z.number().int().nullish(),
				sort: z.number().int().optional(),
				isPinned: z.boolean().optional(),
				visibility: z.enum(["public", "private"]).optional(),
				status: z.enum(["active", "dead"]).optional(),
				createdAt: z.union([z.number(), z.string()]).optional(),
			}),
		)
		.max(10_000),
	tags: z
		.array(z.object({ id: z.number().int(), name: z.string().min(1).max(30) }))
		.max(1000),
	bookmarkTags: z
		.array(z.object({ bookmarkId: z.number().int(), tagId: z.number().int() }))
		.max(10_000),
	// 设置兼容两种历史形态:对象(现行)或 {key,value} 行数组(早期备份)
	settings: z
		.union([
			z.record(z.string(), z.string()),
			z.array(z.object({ key: z.string(), value: z.string() })),
		])
		.optional(),
});

// 备份里的时间可能是 unix 秒(number)或 ISO 字符串,统一转 Date
function toBackupDate(v: number | string | undefined | null): Date | null {
	if (typeof v === "number") return new Date(v * 1000);
	if (typeof v === "string") {
		const d = new Date(v);
		return Number.isNaN(d.getTime()) ? null : d;
	}
	return null;
}

// 同步书签标签:upsert 标签名,重建关联,清理孤儿标签
async function syncTags(db: Db, bookmarkId: number, names: string[]) {
	await db.delete(bookmarkTags).where(eq(bookmarkTags.bookmarkId, bookmarkId));
	const unique = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
	if (unique.length > 0) {
		await db.insert(tags).values(unique.map((name) => ({ name }))).onConflictDoNothing();
		const rows = await db.select().from(tags).where(inArray(tags.name, unique));
		await db
			.insert(bookmarkTags)
			.values(rows.map((t) => ({ bookmarkId, tagId: t.id })));
	}
	// 解绑后可能留下无人引用的标签,顺带清理,否则 tags 表会随反复编辑不断堆积
	await db
		.delete(tags)
		.where(
			sql`NOT EXISTS (SELECT 1 FROM ${bookmarkTags} WHERE ${bookmarkTags.tagId} = ${tags.id})`,
		);
}

// 检查网址存活:实现在 lib/check-url.ts,供本文件与定时任务共用

// 解析 title / meta 只需页面头部,无需下载完整响应
const MAX_METADATA_BYTES = 200_000;

// 读取响应体并限制总量。直接 res.text() 会把整个响应读进内存,
// 遇到异常大的页面会撑爆 Worker 内存上限。
async function readBodyCapped(res: Response, limit: number): Promise<string> {
	if (!res.body) return "";
	const reader = res.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	let finished = false;
	while (total < limit) {
		const { done, value } = await reader.read();
		if (done) {
			finished = true;
			break;
		}
		chunks.push(value);
		total += value.byteLength;
	}
	// 已读够就放弃剩余流,避免继续占用连接
	if (!finished) await reader.cancel().catch(() => {});
	const buf = new Uint8Array(Math.min(total, limit));
	let offset = 0;
	for (const chunk of chunks) {
		if (offset >= buf.byteLength) break;
		buf.set(chunk.subarray(0, buf.byteLength - offset), offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(buf);
}

// 抓取网页元信息,用于表单自动填充
async function fetchMetadata(url: string) {
	const res = await fetch(url, {
		signal: AbortSignal.timeout(8000),
		headers: { "User-Agent": "Mozilla/5.0 (compatible; NavBot/1.0)" },
		redirect: "follow",
	});
	const html = await readBodyCapped(res, MAX_METADATA_BYTES);
	const pick = (re: RegExp) => html.match(re)?.[1]?.trim() ?? null;
	const decode = (s: string | null) =>
		s
			?.replace(/&amp;/g, "&")
			.replace(/&lt;/g, "<")
			.replace(/&gt;/g, ">")
			.replace(/&quot;/g, '"')
			.replace(/&#39;/g, "'") ?? null;
	const title =
		pick(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ??
		pick(/<title[^>]*>([^<]+)<\/title>/i);
	const description =
		pick(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i) ??
		pick(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i);
	return { title: decode(title), description: decode(description) };
}

export const adminRoutes = new Hono<AppEnv>()
	.use(requireAuth)
	// ---------- 分类 ----------
	.get("/categories", async (c) => {
		const db = createDb(c.env.DB);
		const rows = await db
			.select()
			.from(categories)
			.orderBy(asc(categories.sort), asc(categories.id));
		return c.json({ categories: rows });
	})
	.post("/categories", zValidator("json", categoryInput), async (c) => {
		const db = createDb(c.env.DB);
		const data = c.req.valid("json");
		if (data.parentId != null) {
			const all = await db
				.select({ id: categories.id, parentId: categories.parentId })
				.from(categories);
			const err = validateCategoryNesting(all, data.parentId);
			if (err) return c.json({ error: err }, 400);
		}
		const [row] = await db.insert(categories).values(data).returning();
		return c.json({ category: row });
	})
	.put(
		"/categories/reorder",
		zValidator("json", reorderSchema),
		async (c) => {
			const db = createDb(c.env.DB);
			const { ids } = c.req.valid("json");
			for (const [i, id] of ids.entries()) {
				await db.update(categories).set({ sort: i }).where(eq(categories.id, id));
			}
			return c.json({ ok: true });
		},
	)
	.put("/categories/:id", idParam, zValidator("json", categoryInput.partial()), async (c) => {
		const db = createDb(c.env.DB);
		const id = c.req.valid("param").id;
		const data = c.req.valid("json");
		// 防循环 + 限制三级(移动时带上子孙一起算深度)
		if (data.parentId != null) {
			const all = await db
				.select({ id: categories.id, parentId: categories.parentId })
				.from(categories);
			const err = validateCategoryNesting(all, data.parentId, id);
			if (err) return c.json({ error: err }, 400);
		}
		const [row] = await db
			.update(categories)
			.set(data)
			.where(eq(categories.id, id))
			.returning();
		if (!row) return c.json({ error: "Not found" }, 404);
		return c.json({ category: row });
	})
	// 批量删除分类:子分类级联删除,直属书签置为未分类(均由外键级联处理);ids 分片规避 D1 变量数限制
	.post(
		"/categories/batch-delete",
		zValidator("json", z.object({ ids: z.array(z.number().int()).min(1).max(1000) })),
		async (c) => {
			const db = createDb(c.env.DB);
			const { ids } = c.req.valid("json");
			for (let i = 0; i < ids.length; i += 90) {
				await db.delete(categories).where(inArray(categories.id, ids.slice(i, i + 90)));
			}
			return c.json({ ok: true, count: ids.length });
		},
	)
	.delete("/categories/:id", idParam, async (c) => {
		const db = createDb(c.env.DB);
		await db.delete(categories).where(eq(categories.id, c.req.valid("param").id));
		return c.json({ ok: true });
	})
	// ---------- 书签 ----------
	.get("/bookmarks", async (c) => {
		const db = createDb(c.env.DB);
		const rows = await db
			.select()
			.from(bookmarks)
			.orderBy(desc(bookmarks.isPinned), asc(bookmarks.sort), asc(bookmarks.id));
		const links = await db
			.select({ bookmarkId: bookmarkTags.bookmarkId, name: tags.name })
			.from(bookmarkTags)
			.innerJoin(tags, eq(bookmarkTags.tagId, tags.id));
		const map = new Map<number, string[]>();
		for (const l of links) {
			map.set(l.bookmarkId, [...(map.get(l.bookmarkId) ?? []), l.name]);
		}
		return c.json({
			bookmarks: rows.map((r) => ({ ...r, tags: map.get(r.id) ?? [] })),
		});
	})
	.post("/bookmarks", zValidator("json", bookmarkInput), async (c) => {
		const db = createDb(c.env.DB);
		const { tags: tagNames, ...data } = c.req.valid("json");
		const [row] = await db.insert(bookmarks).values(data).returning();
		if (tagNames) await syncTags(db, row.id, tagNames);
		return c.json({ bookmark: row });
	})
	.put(
		"/bookmarks/reorder",
		zValidator("json", reorderSchema),
		async (c) => {
			const db = createDb(c.env.DB);
			const { ids } = c.req.valid("json");
			for (const [i, id] of ids.entries()) {
				await db.update(bookmarks).set({ sort: i }).where(eq(bookmarks.id, id));
			}
			return c.json({ ok: true });
		},
	)
	// ---------- 批量操作(需注册在 /bookmarks/:id 之前;分片规避 D1 单语句 100 个绑定变量限制) ----------
	.put(
		"/bookmarks/batch-category",
		zValidator(
			"json",
			z.object({
				ids: z.array(z.number().int()).min(1).max(1000),
				categoryId: z.number().int().nullable(),
			}),
		),
		async (c) => {
			const db = createDb(c.env.DB);
			const { ids, categoryId } = c.req.valid("json");
			if (categoryId !== null) {
				const [cat] = await db
					.select({ id: categories.id })
					.from(categories)
					.where(eq(categories.id, categoryId));
				if (!cat) return c.json({ error: "分类不存在" }, 400);
			}
			for (let i = 0; i < ids.length; i += 90) {
				await db
					.update(bookmarks)
					.set({ categoryId, updatedAt: new Date() })
					.where(inArray(bookmarks.id, ids.slice(i, i + 90)));
			}
			return c.json({ ok: true, count: ids.length });
		},
	)
	.post(
		"/bookmarks/batch-delete",
		zValidator("json", z.object({ ids: z.array(z.number().int()).min(1).max(1000) })),
		async (c) => {
			const db = createDb(c.env.DB);
			const { ids } = c.req.valid("json");
			for (let i = 0; i < ids.length; i += 90) {
				await db.delete(bookmarks).where(inArray(bookmarks.id, ids.slice(i, i + 90)));
			}
			return c.json({ ok: true, count: ids.length });
		},
	)
	.put("/bookmarks/:id", idParam, zValidator("json", bookmarkInput.partial()), async (c) => {
		const db = createDb(c.env.DB);
		const { tags: tagNames, ...data } = c.req.valid("json");
		const [row] = await db
			.update(bookmarks)
			.set({ ...data, updatedAt: new Date() })
			.where(eq(bookmarks.id, c.req.valid("param").id))
			.returning();
		if (!row) return c.json({ error: "Not found" }, 404);
		if (tagNames) await syncTags(db, row.id, tagNames);
		return c.json({ bookmark: row });
	})
	.delete("/bookmarks/:id", idParam, async (c) => {
		const db = createDb(c.env.DB);
		await db.delete(bookmarks).where(eq(bookmarks.id, c.req.valid("param").id));
		return c.json({ ok: true });
	})
	// ---------- 元信息抓取 ----------
	.post(
		"/metadata",
		zValidator("json", z.object({ url: httpUrlSchema })),
		async (c) => {
			try {
				return c.json(await fetchMetadata(c.req.valid("json").url));
			} catch {
				return c.json({ error: "抓取失败,请检查网址是否可访问" }, 422);
			}
		},
	)
	// ---------- AI 智能填充 ----------
	.post(
		"/metadata-ai",
		zValidator("json", z.object({ url: httpUrlSchema })),
		async (c) => {
			const db = createDb(c.env.DB);
			const aiSettings = await loadAISettings(db);
			if (!aiSettings.enabled || !aiSettings.features.autoFill) {
				return c.json({ error: "AI 自动填充未启用" }, 400);
			}

			const { url } = c.req.valid("json");
			let meta: { title: string | null; description: string | null };
			try {
				meta = await fetchMetadata(url);
			} catch {
				return c.json({ error: "抓取失败,请检查网址是否可访问" }, 422);
			}

			const pageText = [meta.title, meta.description].filter(Boolean).join("\n");
			const categoryNames = (await db.select({ name: categories.name }).from(categories))
				.map((r) => r.name);
			const system =
				"你是一个书签整理助手。请根据用户提供的网页 URL 和页面信息，提取或补全书签信息。";
			const user = `请为以下网页生成书签信息，以 JSON 格式返回，不要包含其他内容：
{
  "title": "简短准确的标题",
  "description": "一句话中文描述（不超过 80 字）",
  "tags": ["标签1", "标签2", "标签3"],

  "category": "最合适的分类名称（必须是给定分类之一，没有合适的则填 null）"
}

可选分类（只能从下列选择，无法确定时填 null）：
${categoryNames.length ? categoryNames.join("、") : "（暂无分类）"}

URL: ${url}
页面信息：
${pageText || "（无）"}`;

			try {
				const raw = await runChat(
					c.env,
					aiSettings,
					[
						{ role: "system", content: system },
						{ role: "user", content: user },
					],
					"autoFill",
					db,
				);
				const parsed = extractJson<{
					title?: string;
					description?: string;
					tags?: string[];

					category?: string | null;
				}>(raw);
				// 将 AI 推荐的分类名映射到已有分类 id
				let categoryId: number | null = null;
				if (parsed.category) {
					const matched = (await db.select().from(categories)).find(
						(c) => c.name === parsed.category,
					);
					categoryId = matched ? matched.id : null;
				}
				return c.json({
					title: parsed.title || meta.title,
					description: parsed.description || meta.description,

					tags: Array.isArray(parsed.tags) ? parsed.tags.filter(Boolean) : [],
					categoryId,
				});
			} catch (err) {
				console.error("AI metadata error:", err);
				return c.json(
					{
						error: "AI 分析失败，已回退到普通抓取结果",
						title: meta.title,
						description: meta.description,

						tags: [],
					},
					500,
				);
			}
		},
	)
	// ---------- AI 智能标签推荐 ----------
	.post(
		"/suggest-tags",
		zValidator(
			"json",
			z.object({ title: z.string(), description: z.string().optional(), url: z.string().optional() }),
		),
		async (c) => {
			const db = createDb(c.env.DB);
			const aiSettings = await loadAISettings(db);
			if (!aiSettings.enabled || !aiSettings.features.tagSuggest) {
				return c.json({ error: "AI 标签推荐未启用" }, 400);
			}
			const { title, description, url } = c.req.valid("json");
			const system =
				"你是一个书签标签助手。请根据书签的标题、描述和链接,推荐 3-5 个简短的中文标签。";
			const user = `请以 JSON 格式返回标签数组,不要包含其他内容:
["标签1", "标签2", "标签3"]

标题: ${title}
描述: ${description || "（无）"}
链接: ${url || "（无）"}`;

			try {
				const raw = await runChat(
					c.env,
					aiSettings,
					[
						{ role: "system", content: system },
						{ role: "user", content: user },
					],
					"tagSuggest",
					db,
				);
				const parsed = extractJson<{ tags?: string[] } | string[]>(raw);
				const tags = Array.isArray(parsed) ? parsed : parsed.tags ?? [];
				return c.json({ tags: tags.filter(Boolean).slice(0, 5) });
			} catch (err) {
				console.error("AI suggest-tags error:", err);
				return c.json({ error: "AI 标签推荐失败" }, 500);
			}
		},
	)
	// ---------- 导入导出(Netscape Bookmark HTML,兼容 Chrome/Edge/Firefox/Safari) ----------
	.post(
		"/import",
		zValidator("json", z.object({ html: z.string().min(1).max(20_000_000) })),
		async (c) => {
			const db = createDb(c.env.DB);
			const tree = parseNetscapeHtml(c.req.valid("json").html);
			// 整棵树一条书签都没有:多半是误传了网页或错误文件,明确报错而非静默"成功 0 个"
			const countTree = (f: ParsedFolder): number =>
				f.bookmarks.length + f.children.reduce((n, ch) => n + countTree(ch), 0);
			if (countTree(tree) === 0) {
				return c.json(
					{ error: "未在文件中识别到任何书签,请确认是浏览器导出的书签 HTML 文件" },
					400,
				);
			}
			// 同名同父级分类复用;同 URL 书签跳过,重复导入不产生脏数据
			const existingCats = await db.select().from(categories);
			const catKey = new Map(
				existingCats.map((r) => [`${r.parentId ?? 0}:${r.name}`, r.id]),
			);
			const existingUrls = new Set(
				(await db.select({ url: bookmarks.url }).from(bookmarks)).map((r) => r.url),
			);
			let catCount = 0;
			let bmCount = 0;
			let skipped = 0;

			async function importBookmarks(
				folder: ParsedFolder,
				categoryId: number | null,
			) {
				for (const b of folder.bookmarks) {
					if (existingUrls.has(b.url)) {
						skipped++;
						continue;
					}
					existingUrls.add(b.url);
					await db.insert(bookmarks).values({
						title: b.title.slice(0, 200),
						url: b.url,
						icon: b.icon,
						categoryId,
						...(b.addDate ? { createdAt: new Date(b.addDate * 1000) } : {}),
					});
					bmCount++;
				}
				for (const child of folder.children) {
					const key = `${categoryId ?? 0}:${child.name}`;
					let id = catKey.get(key);
					if (id === undefined) {
						const [row] = await db
							.insert(categories)
							.values({ name: child.name.slice(0, 50), parentId: categoryId })
							.returning({ id: categories.id });
						id = row.id;
						catKey.set(key, id);
						catCount++;
					}
					await importBookmarks(child, id);
				}
			}

			await importBookmarks(tree, null);
			return c.json({ categories: catCount, bookmarks: bmCount, skipped });
		},
	)
	.get("/export", async (c) => {
		const db = createDb(c.env.DB);
		const cats = await db
			.select()
			.from(categories)
			.orderBy(asc(categories.sort), asc(categories.id));
		const bms = await db
			.select()
			.from(bookmarks)
			.orderBy(asc(bookmarks.sort), asc(bookmarks.id));
		const toEntry = (b: (typeof bms)[number]) => ({
			title: b.title,
			url: b.url,
			icon: b.icon,
			addDate: Math.floor(b.createdAt.getTime() / 1000),
		});
		// 按 parentId 重建文件夹树,保留任意层级
		const folderById = new Map<number, ExportFolder>(
			cats.map((cat) => [
				cat.id,
				{
					name: cat.name,
					addDate: Math.floor(cat.createdAt.getTime() / 1000),
					children: [],
					bookmarks: [],
				},
			]),
		);
		const rootFolders: ExportFolder[] = [];
		for (const cat of cats) {
			const node = folderById.get(cat.id)!;
			const parent = cat.parentId !== null ? folderById.get(cat.parentId) : undefined;
			if (parent) parent.children.push(node);
			else rootFolders.push(node);
		}
		const rootBookmarks = [];
		for (const b of bms) {
			const folder = b.categoryId !== null ? folderById.get(b.categoryId) : undefined;
			if (folder) folder.bookmarks.push(toEntry(b));
			else rootBookmarks.push(toEntry(b));
		}
		const html = buildNetscapeHtml(rootBookmarks, rootFolders);
		const date = new Date().toISOString().slice(0, 10);
		return c.body(html, 200, {
			"Content-Type": "text/html; charset=utf-8",
			"Content-Disposition": `attachment; filename="bookmarks-${date}.html"`,
		});
	})
	// ---------- 死链检测(后台手动触发,前端分批调用) ----------
	.post(
		"/check-links",
		zValidator("json", z.object({ ids: z.array(z.number().int()).min(1).max(10) })),
		async (c) => {
			const db = createDb(c.env.DB);
			const rows = await db
				.select({ id: bookmarks.id, url: bookmarks.url })
				.from(bookmarks)
				.where(inArray(bookmarks.id, c.req.valid("json").ids));
			const results = await Promise.all(
				rows.map(async (r) => ({
					id: r.id,
					status: (await checkUrl(r.url)) ? ("active" as const) : ("dead" as const),
				})),
			);
			for (const r of results) {
				await db
					.update(bookmarks)
					.set({ status: r.status })
					.where(eq(bookmarks.id, r.id));
			}
			return c.json({ results });
		},
	)
	// ---------- AI 自动分类建议 ----------
	.post(
		"/suggest-category",
		zValidator(
			"json",
			z.object({ title: z.string(), description: z.string().optional(), url: z.string().optional() }),
		),
		async (c) => {
			const db = createDb(c.env.DB);
			const aiSettings = await loadAISettings(db);
			if (!aiSettings.enabled || !aiSettings.features.autoCategorize) {
				return c.json({ error: "AI 自动分类未启用" }, 400);
			}
			const { title, description, url } = c.req.valid("json");
			const cats = await db.select().from(categories);
			const catList = cats.map((c) => c.name).join("、");
			const system =
				"你是一个书签分类助手。请根据书签信息,从给定的分类列表中选择最合适的一个(或返回 new 表示建议新建)。";
			const user = `请以 JSON 格式返回,不要包含其他内容:
{ "category": "分类名称 或 new", "reason": "一句话理由" }

可选分类: ${catList || "（暂无分类）"}
标题: ${title}
描述: ${description || "（无）"}
链接: ${url || "（无）"}`;

			try {
				const raw = await runChat(
					c.env,
					aiSettings,
					[
						{ role: "system", content: system },
						{ role: "user", content: user },
					],
					"autoCategorize",
					db,
				);
				const parsed = extractJson<{ category?: string; reason?: string }>(raw);
				const name = (parsed.category ?? "").trim();
				const matched = cats.find((c) => c.name === name);
				return c.json({
					categoryId: matched ? matched.id : null,
					categoryName: matched ? matched.name : name === "new" ? null : name || null,
					isNew: name === "new" || !matched,
					reason: parsed.reason ?? "",
				});
			} catch (err) {
				console.error("AI suggest-category error:", err);
				return c.json({ error: "AI 分类建议失败" }, 500);
			}
		},
	)
	// ---------- AI 死链修复建议 ----------
	.post(
		"/repair-link",
		zValidator("json", z.object({ title: z.string(), url: httpUrlSchema })),
		async (c) => {
			const db = createDb(c.env.DB);
			const aiSettings = await loadAISettings(db);
			if (!aiSettings.enabled || !aiSettings.features.deadLinkRepair) {
				return c.json({ error: "AI 死链修复未启用" }, 400);
			}
			const { title, url } = c.req.valid("json");
			const system =
				"你是一个死链修复助手。给定已失效的书签,请推断最可能的有效替代链接。";
			const user = `请以 JSON 格式返回,不要包含其他内容:
{
  "alternative": "推断的新链接(或 null)",
  "wayback": "https://web.archive.org/web/2024/原链接 的存档地址",
  "reason": "一句话说明"
}

标题: ${title}
原链接: ${url}`;

			try {
				const raw = await runChat(
					c.env,
					aiSettings,
					[
						{ role: "system", content: system },
						{ role: "user", content: user },
					],
					"deadLinkRepair",
					db,
				);
				const parsed = extractJson<{ alternative?: string | null; wayback?: string; reason?: string }>(raw);
				// AI 输出不可信(幻觉或被抓取页面注入):渲染成 <a href> 前强制 http(s),
				// 非法协议置 null,前端按"无建议"展示
				const alternative =
					parsed.alternative && isHttpUrl(parsed.alternative) ? parsed.alternative : null;
				const wayback =
					parsed.wayback && isHttpUrl(parsed.wayback)
						? parsed.wayback
						: `https://web.archive.org/web/2024/${url}`;
				return c.json({
					alternative,
					wayback,
					reason: parsed.reason ?? "",
				});
			} catch (err) {
				console.error("AI repair-link error:", err);
				return c.json({ error: "AI 死链修复失败" }, 500);
			}
		},
	)
	// ---------- AI 内容摘要 ----------
	.post(
		"/summarize",
		zValidator(
			"json",
			z.object({
				title: z.string(),
				description: z.string().optional(),
				url: z.string().optional(),
			}),
		),
		async (c) => {
			const db = createDb(c.env.DB);
			const aiSettings = await loadAISettings(db);
			if (!aiSettings.enabled || !aiSettings.features.summary) {
				return c.json({ error: "AI 内容摘要未启用" }, 400);
			}
			const { title, description, url } = c.req.valid("json");
			const system =
				"你是一个书签摘要助手。请用一句话(不超过 40 字)用中文概括书签内容要点。";
			const user = `请直接返回摘要文本,不要包含引号或任何其他内容。

标题: ${title}
描述: ${description || "（无）"}
链接: ${url || "（无）"}`;

			try {
				const raw = await runChat(
					c.env,
					aiSettings,
					[
						{ role: "system", content: system },
						{ role: "user", content: user },
					],
					"summary",
					db,
				);
				const summary = raw.trim().replace(/^["'「]|["'」]$/g, "").trim();
				return c.json({ summary });
			} catch (err) {
				console.error("AI summarize error:", err);
				return c.json({ error: "AI 摘要生成失败" }, 500);
			}
		},
	)
	// ---------- 标签 ----------
	.get("/tags", async (c) => {
		const db = createDb(c.env.DB);
		return c.json({ tags: await db.select().from(tags).orderBy(asc(tags.name)) });
	})
	// ---------- 站点设置 ----------
	.get("/settings", async (c) => {
		const db = createDb(c.env.DB);
		const rows = await db.select().from(settings);
		// 缺失的键补开箱默认值,后台表单(紧凑模式开关/图标服务)才能显示默认状态
		return c.json(mergeDefaultSettings(rows));
	})
	.put(
		"/settings",
		zValidator("json", z.record(z.string(), z.string())),
		async (c) => {
			const db = createDb(c.env.DB);
			for (const [key, value] of Object.entries(c.req.valid("json"))) {
				await db
					.insert(settings)
					.values({ key, value })
					.onConflictDoUpdate({ target: settings.key, set: { value } });
			}
			return c.json({ ok: true });
		},
	)
	// ---------- 手动备份到 R2(定时任务之外按需触发) ----------
	.post("/backup", async (c) => {
		const db = createDb(c.env.DB);
		const key = await backupToR2(c.env, db);
		if (!key) {
			return c.json(
				{ error: "未配置 R2 存储桶:请创建 bucket 并在 wrangler.json 中确认 BACKUP 绑定" },
				400,
			);
		}
		return c.json({ key });
	})
	// ---------- 手动备份:下载 JSON 快照(与 R2 备份同一数据结构) ----------
	.get("/backup", async (c) => {
		const payload = await buildBackupPayload(createDb(c.env.DB));
		const date = new Date().toISOString().slice(0, 10);
		return c.body(payload, 200, {
			"Content-Type": "application/json; charset=utf-8",
			"Content-Disposition": `attachment; filename="bookmark-nav-backup-${date}.json"`,
		});
	})
	// ---------- 恢复 JSON 备份:合并式导入,重复网址/同名分类自动跳过,设置仅补缺 ----------
	.post(
		"/import-json",
		zValidator("json", backupImportSchema),
		async (c) => {
			const db = createDb(c.env.DB);
			const payload = c.req.valid("json");

			// 1) 分类:按「父级 + 名称」复用现有分类,否则新建;父级必须先于子级入库
			const existingCats = await db.select().from(categories);
			const catKey = new Map(
				existingCats.map((r) => [`${r.parentId ?? 0}:${r.name}`, r.id]),
			);
			const catIdMap = new Map<number, number>();
			let catCount = 0;
			const pending = [...payload.categories];
			let progress = true;
			while (pending.length > 0 && progress) {
				progress = false;
				for (let i = pending.length - 1; i >= 0; i--) {
					const cat = pending[i];
					const parentMapped =
						cat.parentId == null ? true : catIdMap.has(cat.parentId);
					if (!parentMapped) continue;
					const newParentId =
						cat.parentId == null ? null : catIdMap.get(cat.parentId)!;
					const key = `${newParentId ?? 0}:${cat.name}`;
					let id = catKey.get(key);
					if (id === undefined) {
						const [row] = await db
							.insert(categories)
							.values({
								name: cat.name.slice(0, 50),
								icon: cat.icon ?? null,
								parentId: newParentId,
								sort: cat.sort ?? 0,
								visibility: cat.visibility ?? "public",
							})
							.returning({ id: categories.id });
						id = row.id;
						catKey.set(key, id);
						catCount++;
					}
					catIdMap.set(cat.id, id);
					pending.splice(i, 1);
					progress = true;
				}
			}
			// 父分类缺失的孤儿分类挂到根级,避免数据丢失
			for (const cat of pending) {
				const key = `0:${cat.name}`;
				let id = catKey.get(key);
				if (id === undefined) {
					const [row] = await db
						.insert(categories)
						.values({
							name: cat.name.slice(0, 50),
							icon: cat.icon ?? null,
							parentId: null,
							sort: cat.sort ?? 0,
							visibility: cat.visibility ?? "public",
						})
						.returning({ id: categories.id });
					id = row.id;
					catKey.set(key, id);
					catCount++;
				}
				catIdMap.set(cat.id, id);
			}

			// 2) 书签:同 URL 跳过;强制 http(s) 协议(备份文件是外部输入);还原时间戳/置顶/可见性/死链状态
			const existingUrls = new Set(
				(await db.select({ url: bookmarks.url }).from(bookmarks)).map((r) => r.url),
			);
			const bmIdMap = new Map<number, number>();
			let bmCount = 0;
			let skipped = 0;
			for (const b of payload.bookmarks) {
				let url = b.url;
				try {
					url = new URL(b.url).href;
				} catch {
					continue; // 非法网址跳过
				}
				if (!isHttpUrl(url)) {
					skipped++; // javascript:/data: 等协议一并计入跳过数
					continue;
				}
				if (existingUrls.has(url)) {
					skipped++;
					continue;
				}
				existingUrls.add(url);
				const created = toBackupDate(b.createdAt);
				const [row] = await db
					.insert(bookmarks)
					.values({
						title: b.title.slice(0, 200),
						url,
						description: b.description ?? null,
						icon: b.icon ?? null,
						categoryId: b.categoryId != null ? (catIdMap.get(b.categoryId) ?? null) : null,
						sort: b.sort ?? 0,
						isPinned: b.isPinned ?? false,
						visibility: b.visibility ?? "public",
						status: b.status ?? "active",
						...(created ? { createdAt: created, updatedAt: created } : {}),
					})
					.returning({ id: bookmarks.id });
				bmIdMap.set(b.id, row.id);
				bmCount++;
			}

			// 3) 标签与关联:同名复用,只为本次新导入的书签建立关联
			const existingTags = await db.select().from(tags);
			const tagNameMap = new Map(existingTags.map((r) => [r.name, r.id]));
			const tagIdMap = new Map<number, number>();
			for (const t of payload.tags) {
				let id = tagNameMap.get(t.name);
				if (id === undefined) {
					const [row] = await db
						.insert(tags)
						.values({ name: t.name.slice(0, 30) })
						.returning({ id: tags.id });
					id = row.id;
					tagNameMap.set(t.name, id);
				}
				tagIdMap.set(t.id, id);
			}
			let linkCount = 0;
			for (const link of payload.bookmarkTags) {
				const newBmId = bmIdMap.get(link.bookmarkId);
				const newTagId = tagIdMap.get(link.tagId);
				if (newBmId === undefined || newTagId === undefined) continue;
				const exists = await db
					.select({ bookmarkId: bookmarkTags.bookmarkId })
					.from(bookmarkTags)
					.where(
						sql`${bookmarkTags.bookmarkId} = ${newBmId} AND ${bookmarkTags.tagId} = ${newTagId}`,
					)
					.limit(1);
				if (exists.length > 0) continue;
				await db
					.insert(bookmarkTags)
					.values({ bookmarkId: newBmId, tagId: newTagId });
				linkCount++;
			}

			// 4) 站点设置:仅补齐当前缺失的键,绝不覆盖已有配置
			let settingsFilled = 0;
			if (payload.settings) {
				// 行数组形态(早期备份)先归一化为对象
				const backupSettings = Array.isArray(payload.settings)
					? Object.fromEntries(payload.settings.map((r) => [r.key, r.value]))
					: payload.settings;
				const current = new Map(
					(await db.select().from(settings)).map((r) => [r.key, r.value]),
				);
				for (const [key, value] of Object.entries(backupSettings)) {
					if (current.has(key)) continue;
					await db.insert(settings).values({ key, value });
					settingsFilled++;
				}
			}

			return c.json({
				categories: catCount,
				bookmarks: bmCount,
				skipped,
				tags: tagIdMap.size,
				links: linkCount,
				settingsFilled,
			});
		},
	)
	// ---------- 手动触发全量死链检测(与定时任务同一逻辑,不受计划/开关限制) ----------
	.post("/maintenance/check-links", async (c) => {
		const result = await checkAllLinks(createDb(c.env.DB));
		return c.json(result);
	})
	// ---------- AI 连接检测(用表单临时值,不依赖已保存设置) ----------
	.post("/ai-test", async (c) => {
		try {
			const body = await c.req.json<{
				provider: "builtin" | "custom";
				apiEndpoint?: string;
				apiKey?: string;
				model: string;
			}>();
			if (body.provider !== "builtin" && body.provider !== "custom") {
				return c.json({ ok: false, error: "provider 不合法" }, 400);
			}
			const result = await testModel(c.env, body);
			if (result.ok) return c.json({ ok: true });
			return c.json({ ok: false, error: result.error }, 400);
		} catch (err) {
			return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 400);
		}
	})
	// ---------- AI 用量概览(免费额度防刷 + 自定义 API 防滥用) ----------
	.get("/ai-usage", async (c) => {
		const db = createDb(c.env.DB);
		// created_at 是 unix 秒整数,必须直接比较:
		// SQLite 的 unixepoch(created_at) 会把裸整数当儒略日解析而返回 NULL,导致过滤恒不成立
		const sinceToday = gt(aiUsage.createdAt, new Date(Date.now() - 86_400_000));
		// 今日总调用 / 成功 / 失败
		const [todayAgg] = await db
			.select({
				total: sql<number>`count(*)`,
				success: sql<number>`sum(success)`,
				avgDuration: sql<number>`avg(duration_ms)`,
			})
			.from(aiUsage)
			.where(sinceToday);
		// 今日按功能分布
		const byFeature = await db
			.select({
				feature: aiUsage.feature,
				total: sql<number>`count(*)`,
				success: sql<number>`sum(success)`,
			})
			.from(aiUsage)
			.where(sinceToday)
			.groupBy(aiUsage.feature);
		// 今日按 provider 分布
		const byProvider = await db
			.select({
				provider: aiUsage.provider,
				total: sql<number>`count(*)`,
			})
			.from(aiUsage)
			.where(sinceToday)
			.groupBy(aiUsage.provider);
		// 最近失败记录(含错误原因,便于排查 429 / Key 失效)
		const recentErrors = await db
			.select({
				feature: aiUsage.feature,
				provider: aiUsage.provider,
				error: aiUsage.error,
				createdAt: aiUsage.createdAt,
			})
			.from(aiUsage)
			.where(and(sinceToday, eq(aiUsage.success, 0)))
			.orderBy(desc(aiUsage.createdAt))
			.limit(20);

		const success = Number(todayAgg?.success ?? 0);
		const total = Number(todayAgg?.total ?? 0);
		return c.json({
			today: {
				total,
				success,
				failed: total - success,
				successRate: total > 0 ? Math.round((success / total) * 100) : 100,
				avgDurationMs: todayAgg?.avgDuration ? Math.round(Number(todayAgg.avgDuration)) : 0,
			},
			byFeature: byFeature.map((r) => ({
				feature: r.feature,
				total: Number(r.total),
				success: Number(r.success),
			})),
			byProvider: byProvider.map((r) => ({
				provider: r.provider,
				total: Number(r.total),
			})),
			recentErrors: recentErrors.map((r) => ({
				feature: r.feature,
				provider: r.provider,
				error: r.error,
				createdAt: r.createdAt.getTime(),
			})),
		});
	})
	// 浏览器插件访问令牌状态(只回末 4 位与创建时间,永不回明文)
	.get("/token", async (c) => {
		const db = createDb(c.env.DB);
		const [row] = await db
			.select({
				hint: users.apiTokenHint,
				createdAt: users.apiTokenCreatedAt,
			})
			.from(users)
			.where(eq(users.id, c.get("user")!.id))
			.limit(1);
		return c.json({
			exists: !!row?.hint,
			hint: row?.hint ?? null,
			createdAt: row?.createdAt?.getTime() ?? null,
		});
	})
	// 生成(或轮换)令牌:明文仅在本次响应中返回一次,旧令牌同时失效
	.post("/token", async (c) => {
		const db = createDb(c.env.DB);
		const token = generateApiToken();
		await db
			.update(users)
			.set({
				apiTokenHash: await hashApiToken(token),
				apiTokenHint: tokenHint(token),
				apiTokenCreatedAt: new Date(),
			})
			.where(eq(users.id, c.get("user")!.id));
		return c.json({ token, hint: tokenHint(token) });
	})
	// 吊销令牌:立即失效,插件下次请求收到 401
	.delete("/token", async (c) => {
		const db = createDb(c.env.DB);
		await db
			.update(users)
			.set({ apiTokenHash: null, apiTokenHint: null, apiTokenCreatedAt: null })
			.where(eq(users.id, c.get("user")!.id));
		return c.json({ ok: true });
	});
