import { describe, expect, it } from "vitest";
import { isScheduleDue, parseSchedule, type TaskSchedule } from "./schedule";

const FALLBACK: TaskSchedule = { freq: "daily", hour: 4, weekday: 1, monthday: 1 };

// 北京时间 2026-09-21 04:30 = UTC 2026-09-20 20:30
const BJ_0430 = new Date("2026-09-20T20:30:00Z");
// 北京时间 2026-09-21 05:30 = UTC 2026-09-20 21:30
const BJ_0530 = new Date("2026-09-20T21:30:00Z");
// 2026-09-20 是周日,2026-09-21 是周一
const SUNDAY_0430 = new Date("2026-09-19T20:30:00Z");
const MONDAY_0430 = BJ_0430;

describe("parseSchedule", () => {
	it("合法 JSON 各字段被采用", () => {
		expect(
			parseSchedule('{"freq":"weekly","hour":9,"weekday":3,"monthday":15}', FALLBACK),
		).toEqual({ freq: "weekly", hour: 9, weekday: 3, monthday: 15 });
	});

	it("字段非法时逐项回退(freq 非法整体回退)", () => {
		expect(parseSchedule('{"freq":"hourly","hour":25,"weekday":9,"monthday":31}', FALLBACK)).toEqual({
			freq: "daily", // freq 非法 → 整体回退
			hour: 4,
			weekday: 1,
			monthday: 1,
		});
		expect(parseSchedule('{"freq":"weekly","hour":25}', FALLBACK)).toEqual({
			freq: "weekly", // freq 合法保留,非法字段逐项回退
			hour: 4,
			weekday: 1,
			monthday: 1,
		});
	});

	it("null / 坏 JSON / 缺字段 → 完整回退默认值", () => {
		expect(parseSchedule(null, FALLBACK)).toEqual(FALLBACK);
		expect(parseSchedule("not json{", FALLBACK)).toEqual(FALLBACK);
		expect(parseSchedule('{"hour":8}', FALLBACK)).toEqual({ ...FALLBACK, hour: 8 });
	});
});

describe("isScheduleDue", () => {
	it("daily:仅到点的小时返回 true", () => {
		expect(isScheduleDue({ freq: "daily", hour: 4, weekday: 1, monthday: 1 }, BJ_0430)).toBe(true);
		expect(isScheduleDue({ freq: "daily", hour: 5, weekday: 1, monthday: 1 }, BJ_0430)).toBe(false);
		// 同一小时重复评估/cron 重复触发不会造成跨小时误判
		expect(isScheduleDue({ freq: "daily", hour: 4, weekday: 1, monthday: 1 }, BJ_0530)).toBe(false);
	});

	it("weekly:仅在指定星期(北京时间)返回 true", () => {
		const weekly = { freq: "weekly" as const, hour: 4, weekday: 1, monthday: 1 };
		expect(isScheduleDue(weekly, MONDAY_0430)).toBe(true);
		expect(isScheduleDue(weekly, SUNDAY_0430)).toBe(false);
	});

	it("monthly:仅在指定日期(北京时间)返回 true", () => {
		const monthly = { freq: "monthly" as const, hour: 4, weekday: 1, monthday: 21 };
		expect(isScheduleDue(monthly, BJ_0430)).toBe(true);
		// 同一天不同小时不算到点
		expect(isScheduleDue(monthly, BJ_0530)).toBe(false);
	});
});
