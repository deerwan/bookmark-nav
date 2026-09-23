import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./password";
import {
	generateApiToken,
	hashApiToken,
	isApiToken,
	tokenHint,
} from "./token";

describe("password(PBKDF2)", () => {
	it("哈希可被正确验证(正确密码 true,错误密码 false)", async () => {
		const stored = await hashPassword("password");
		expect(await verifyPassword("password", stored)).toBe(true);
		expect(await verifyPassword("Password", stored)).toBe(false);
		expect(await verifyPassword("password ", stored)).toBe(false);
	});

	it("同一密码每次加盐,存储值不同但都可验证", async () => {
		const a = await hashPassword("same-password");
		const b = await hashPassword("same-password");
		expect(a).not.toBe(b);
		// 格式:salt:hash,各为 32/64 位十六进制
		const [saltA, hashA] = a.split(":");
		expect(saltA).toMatch(/^[0-9a-f]{32}$/);
		expect(hashA).toMatch(/^[0-9a-f]{64}$/);
		expect(await verifyPassword("same-password", a)).toBe(true);
		expect(await verifyPassword("same-password", b)).toBe(true);
	});

	it("存储格式损坏时验证失败而非抛错", async () => {
		expect(await verifyPassword("x", "not-a-valid-hash")).toBe(false);
		expect(await verifyPassword("x", "")).toBe(false);
		expect(await verifyPassword("x", "zz:yy")).toBe(false);
	});
});

describe("api token(PAT)", () => {
	it("生成令牌带 bnav_ 前缀,总长为前缀+64 位十六进制", () => {
		const t = generateApiToken();
		expect(t).toMatch(/^bnav_[0-9a-f]{64}$/);
		// isApiToken 只认形态(前缀 + 长度),不校验字符集——中间件据此快速分流,
		// 非法内容的令牌在后续哈希查库时自然失配
		expect(isApiToken(t)).toBe(true);
		expect(isApiToken(`Bearer ${t}`)).toBe(false);
		expect(isApiToken("short")).toBe(false);
		expect(isApiToken(`bnav_${"g".repeat(64)}`)).toBe(true);
		expect(isApiToken(`bnav_${"g".repeat(63)}`)).toBe(false);
		expect(isApiToken("")).toBe(false);
	});

	it("哈希为 SHA-256 十六进制,同输入同哈希", async () => {
		const h1 = await hashApiToken("bnav_abc");
		const h2 = await hashApiToken("bnav_abc");
		expect(h1).toBe(h2);
		expect(h1).toMatch(/^[0-9a-f]{64}$/);
	});

	it("不同令牌哈希不同", async () => {
		const [a, b] = [generateApiToken(), generateApiToken()];
		expect(await hashApiToken(a)).not.toBe(await hashApiToken(b));
	});

	it("tokenHint 只保留末 4 位", () => {
		const t = generateApiToken();
		expect(tokenHint(t)).toBe(t.slice(-4));
		expect(tokenHint(t)).toHaveLength(4);
	});
});
