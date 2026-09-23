import { inArray, lt } from "drizzle-orm";
import { createDb, type Db } from "../db/client";
import { aiUsage, bookmarks, settings } from "../db/schema";
import { checkUrl } from "./check-url";
import { backupToR2 } from "./backup";
import {
	DEFAULT_BACKUP_SCHEDULE,
	DEFAULT_DEADLINK_SCHEDULE,
	isScheduleDue,
	parseSchedule,
} from "./schedule";

// 并发上限:Workers Cron 的 CPU 时间有限,外部 fetch 大部分是 I/O 等待,
// 用固定并发池控制峰值连接数,避免一次性打出全量请求
const CHECK_CONCURRENCY = 8;
// D1 单条 SQL 的绑定参数上限保守取 90,分批更新状态
const BATCH_SIZE = 90;

export type LinkCheckResult = {
	total: number;
	dead: number;
	revived: number;
};

// 全量死链检测:并发检测所有书签,只写状态发生变化的行,并记录最近一次运行结果
export async function checkAllLinks(db: Db): Promise<LinkCheckResult> {
	const rows = await db
		.select({
			id: bookmarks.id,
			url: bookmarks.url,
			status: bookmarks.status,
		})
		.from(bookmarks);

	const dead: number[] = []; // 本次新翻转为死链的(只更新这些行,避免写放大)
	const revived: number[] = [];
	let totalDead = 0; // 运行后的死链总数(含历史死链),供后台展示
	let cursor = 0;
	async function worker() {
		while (cursor < rows.length) {
			const row = rows[cursor++];
			const alive = await checkUrl(row.url);
			if (!alive) {
				totalDead++;
				if (row.status !== "dead") dead.push(row.id);
			} else if (row.status !== "active") {
				revived.push(row.id);
			}
		}
	}
	await Promise.all(
		Array.from({ length: Math.min(CHECK_CONCURRENCY, rows.length || 1) }, worker),
	);

	for (let i = 0; i < dead.length; i += BATCH_SIZE) {
		await db
			.update(bookmarks)
			.set({ status: "dead" })
			.where(inArray(bookmarks.id, dead.slice(i, i + BATCH_SIZE)));
	}
	for (let i = 0; i < revived.length; i += BATCH_SIZE) {
		await db
			.update(bookmarks)
			.set({ status: "active" })
			.where(inArray(bookmarks.id, revived.slice(i, i + BATCH_SIZE)));
	}

	const result: LinkCheckResult = {
		total: rows.length,
		dead: totalDead,
		revived: revived.length,
	};
	await Promise.all([
		writeSetting(db, "deadLink.lastRun", new Date().toISOString()),
		writeSetting(db, "deadLink.dead", String(result.dead)),
	]);
	return result;
}

async function writeSetting(db: Db, key: string, value: string) {
	await db
		.insert(settings)
		.values({ key, value })
		.onConflictDoUpdate({ target: settings.key, set: { value } });
}

async function readSettingsMap(db: Db): Promise<Map<string, string>> {
	const rows = await db
		.select({ key: settings.key, value: settings.value })
		.from(settings);
	return new Map(rows.map((r) => [r.key, r.value]));
}

// AI 用量记录保留天数:超期记录由定时任务清理,防止表无限增长
const AI_USAGE_RETENTION_DAYS = 30;

// 清理过期 AI 用量记录。失败不影响其他任务,由调用方 catch
export async function pruneAIUsage(db: Db): Promise<number> {
	const cutoff = new Date(Date.now() - AI_USAGE_RETENTION_DAYS * 86_400_000);
	const deleted = await db
		.delete(aiUsage)
		.where(lt(aiUsage.createdAt, cutoff))
		.returning({ id: aiUsage.id });
	return deleted.length;
}

// 定时任务入口:由每小时整点的 cron 调用,按后台配置的开关与计划判断各任务是否到点。
// 缺省视为开启;显式保存过 "0" 才关闭。后台手动触发不经过这里,不受开关/计划限制。
export async function runScheduledTasks(
	env: Env,
): Promise<{ checked: boolean; backed: boolean; pruned: number }> {
	const db = createDb(env.DB);
	const map = await readSettingsMap(db);
	const enabled = (key: string) => map.get(key) === "1";
	const result = { checked: false, backed: false, pruned: 0 };

	// 用量清理无开关(纯内部维护,量小代价低),每次 cron 顺带执行
	try {
		result.pruned = await pruneAIUsage(db);
	} catch (err) {
		console.error("[maintenance] AI 用量清理失败:", err);
	}

	if (
		enabled("maintenance.checkLinks") &&
		isScheduleDue(
			parseSchedule(map.get("deadLink.schedule"), DEFAULT_DEADLINK_SCHEDULE),
		)
	) {
		try {
			await checkAllLinks(db);
			result.checked = true;
		} catch (err) {
			console.error("[maintenance] 死链检测失败:", err);
		}
	}
	if (
		enabled("maintenance.backup") &&
		isScheduleDue(parseSchedule(map.get("backup.schedule"), DEFAULT_BACKUP_SCHEDULE))
	) {
		try {
			await backupToR2(env, db);
			result.backed = true;
		} catch (err) {
			// 备份失败不影响检测结果;R2 未配置时这里不会走到
			console.error("[maintenance] R2 备份失败:", err);
		}
	}
	return result;
}
