import { describe, expect, it } from "vitest";
import { httpUrlSchema, isHttpUrl } from "./http-url";

describe("isHttpUrl", () => {
	it("http/https 通过", () => {
		expect(isHttpUrl("https://example.com")).toBe(true);
		expect(isHttpUrl("http://example.com/a?b=1#x")).toBe(true);
		expect(isHttpUrl("HTTPS://EXAMPLE.COM")).toBe(true);
	});

	it("危险协议被拒绝", () => {
		expect(isHttpUrl("javascript:alert(1)")).toBe(false);
		expect(isHttpUrl("JAVASCRIPT:alert(1)")).toBe(false);
		expect(isHttpUrl("data:text/html,<script>")).toBe(false);
		expect(isHttpUrl("file:///etc/passwd")).toBe(false);
		expect(isHttpUrl("vbscript:msgbox")).toBe(false);
		expect(isHttpUrl("chrome://settings")).toBe(false);
	});

	it("非法字符串被拒绝", () => {
		expect(isHttpUrl("")).toBe(false);
		expect(isHttpUrl("not a url")).toBe(false);
		expect(isHttpUrl("example.com")).toBe(false); // 无协议
	});
});

describe("httpUrlSchema", () => {
	it("合法 http(s) 通过并保留原值", () => {
		expect(httpUrlSchema.parse("https://example.com/x")).toBe("https://example.com/x");
	});

	it("javascript: 与无协议字符串被拒绝", () => {
		expect(() => httpUrlSchema.parse("javascript:alert(1)")).toThrow();
		expect(() => httpUrlSchema.parse("example.com")).toThrow();
	});

	it("超长 URL 被拒绝", () => {
		expect(() => httpUrlSchema.parse(`https://a.com/${"x".repeat(3000)}`)).toThrow();
	});
});
