import path from "node:path";
import { defineConfig } from "vitest/config";

// 单元测试配置:仅覆盖 src/worker 下的纯逻辑与数据库交互。
// 用 better-sqlite3 内存库 + drizzle/better-sqlite3 模拟 D1,SQL 方言一致,无需 mock。
export default defineConfig({
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "./src/react-app"),
		},
	},
	test: {
		include: ["src/**/*.test.ts"],
		environment: "node",
	},
});
