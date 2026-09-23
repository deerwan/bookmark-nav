import { describe, expect, it } from "vitest";
import { ADMIN_SETTING_KEYS, filterAdminSettings } from "./settings";

describe("filterAdminSettings(保存设置键白名单)", () => {
	it("白名单内的键全部保留", () => {
		const input = {
			siteName: "我的导航",
			"ai.apiKey": "sk-xxx",
			"appearance.compact": "1",
			"deadLink.schedule": '{"freq":"daily","hour":4}',
		};
		const { kept, ignored } = filterAdminSettings(input);
		expect(kept).toEqual(input);
		expect(ignored).toEqual([]);
	});

	it("未知键被剔除并报告", () => {
		const { kept, ignored } = filterAdminSettings({
			siteName: "a",
			"evil.key": "x",
			injected: "y",
		});
		expect(kept).toEqual({ siteName: "a" });
		expect(ignored.sort()).toEqual(["evil.key", "injected"]);
	});

	it("系统内部键不允许从前端写入", () => {
		const { kept, ignored } = filterAdminSettings({
			"deadLink.lastRun": "2026-01-01T00:00:00.000Z",
			"deadLink.dead": "5",
			"backup.lastRun": "2026-01-01T00:00:00.000Z",
			"ai.enabled": "true",
		});
		// 只有 ai.enabled 通过;lastRun/dead 由检测与备份任务写入
		expect(kept).toEqual({ "ai.enabled": "true" });
		expect(ignored).toHaveLength(3);
	});

	it("公开白名单(PUBLIC_SETTING_KEYS)是管理白名单的子集", async () => {
		// 防止未来只加公开键忘了加管理键,导致后台改不生效
		const { PUBLIC_SETTING_KEYS } = await import("../routes/public");
		for (const key of PUBLIC_SETTING_KEYS) {
			expect(ADMIN_SETTING_KEYS.has(key)).toBe(true);
		}
	});
});
