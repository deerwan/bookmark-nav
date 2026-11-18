# 多令牌改造实施方案

> 把浏览器插件的「用户表单令牌」升级为「一用户多令牌 + 元数据 + 独立吊销」。
> 状态：已实施（数据层迁移 0006、后端、前端、测试均完成）。目标版本 v0.2.0。
> 实施时与方案的小偏差：新建令牌暂不支持指定过期时间（UI 未暴露该字段，表结构已预留 `expiresAt`）；测试覆盖 7 类场景。

## 一、目标与范围

### 现状（`users` 表单字段）

- 令牌直接存 `users.apiTokenHash` / `apiTokenHint` / `apiTokenCreatedAt`，一用户只有一个。
- 重新生成覆盖旧值 → 立即踢掉所有已配置插件，无法平滑轮换。
- 权限等同管理员，无名称、无过期、无最后使用时间，泄露只能全体重配。

### 改造后

- 独立 `api_tokens` 表，一个用户可以创建多个令牌（每台设备/每个用途一个）。
- 每个令牌有名称、状态、创建/最后使用时间、过期时间，可单独停用/删除，不影响其他令牌。
- 支持「新建 → 部署新 key → 撤销旧 key」的平滑轮换。
- 令牌仍只存 SHA-256 + 末 4 位，明文仅创建时返回一次（沿用现有安全模型）。

### 不在本期范围（明确排除）

- **scope 细粒度权限**：当前插件权限单一（写书签），拆 `bookmarks:read/write` 收益低。表结构预留 `scopes` 字段但暂不使用，避免以后加又要迁移。
- **IP 白名单 / 额度 / 分组**：来自 AI 网关的需求，导航站无此场景。
- **改 key 格式**：保留 `bnav_` + 64 位 hex（256 bit），`isApiToken` 的识别逻辑不动。

## 二、数据层

### 2.1 新表 `api_tokens`

在 `src/worker/db/schema.ts` 新增：

```ts
export const apiTokens = sqliteTable(
  "api_tokens",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),                       // 用途备注,如 "Macbook Chrome"
    tokenHash: text("token_hash").notNull(),            // SHA-256,唯一
    hint: text("hint").notNull(),                       // 末 4 位,列表展示
    status: text("status", { enum: ["active", "disabled"] }).notNull().default("active"),
    scopes: text("scopes"),                             // 预留,JSON;本期不写入
    expiresAt: integer("expires_at", { mode: "timestamp" }), // null = 永不过期
    lastUsedAt: integer("last_used_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull().default(sql`(unixepoch())`),
  },
  (t) => [
    uniqueIndex("api_tokens_hash_idx").on(t.tokenHash),
    index("api_tokens_user_idx").on(t.userId),
  ],
);
```

要点：
- `userId` 外键 `onDelete: cascade`：删用户时令牌一并清理。
- `tokenHash` 唯一索引：认证按哈希等值查，每次请求都走。
- `status` 用 `active/disabled` 两态即可；删除走真实 `DELETE`（本项目无审计/恢复需求，软删除是过度设计）。
- `expiresAt` / `lastUsedAt` 用 timestamp 模式，与现有 schema 风格一致。

### 2.2 迁移 `drizzle/0006_api_tokens.sql`

SQLite 的 `ALTER TABLE ADD COLUMN` 不支持外键/索引，所以分两步：迁移文件 + 数据搬迁。

```sql
-- statement-breakpoint 分隔,由 wrangler d1 migrations apply 逐条执行
CREATE TABLE `api_tokens` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `user_id` integer NOT NULL REFERENCES `users`(`id`) ON DELETE cascade,
  `name` text NOT NULL,
  `token_hash` text NOT NULL,
  `hint` text NOT NULL,
  `status` text NOT NULL DEFAULT 'active',
  `scopes` text,
  `expires_at` integer,
  `last_used_at` integer,
  `created_at` integer NOT NULL DEFAULT (unixepoch())
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_tokens_hash_idx` ON `api_tokens` (`token_hash`);
--> statement-breakpoint
CREATE INDEX `api_tokens_user_idx` ON `api_tokens` (`user_id`);
--> statement-breakpoint
-- 数据搬迁:把用户表里现存的单个令牌搬成一条命名令牌(不中断现有插件)
INSERT INTO `api_tokens` (`user_id`, `name`, `token_hash`, `hint`, `created_at`)
SELECT `id`, '迁移令牌', `api_token_hash`, `api_token_hint`, `api_token_created_at`
FROM `users` WHERE `api_token_hash` IS NOT NULL;
```

迁移后：
- 旧插件的令牌继续有效（哈希搬过去了），用户无感。
- `users` 的三个旧字段**保留但停止写入**（见兼容策略），下个大版本再清理。

需要同步更新 `drizzle/meta/_journal.json` 加一条 `0006_api_tokens`，并生成对应 snapshot（`npx drizzle-kit generate` 自动生成更稳妥，手写 SQL 时手动补 journal）。

### 2.3 兼容策略（重要）

迁移期采用**有条件双读、只写新表**过渡到新表：

- 认证：先查 `api_tokens`；查不到时，**仅当该用户新表里一条令牌都没有**才回退查 `users.apiTokenHash`（兼容搬迁前/遗漏数据）。
  - 关键：如果用户已经有新表令牌，就**不再回退旧字段**——否则新表令牌被删除后，旧字段会让它"复活"，吊销失效（此 bug 已在端到端验证中发现并修复）。
- 写入：所有新操作只写 `api_tokens`，不再写 users 旧字段。
- 改密码：`tokenVersion++` 仍然保留（JWT 失效）；令牌撤销改为 `DELETE FROM api_tokens WHERE user_id = ?`，不再动 users 旧字段。

这样即便用户跳过了某次迁移，旧令牌仍能登录；一旦开始使用新系统，旧字段彻底失效。

## 三、后端

### 3.1 认证中间件 `src/worker/middleware/auth.ts`

`userFromApiToken(db, raw)` 改为查新表：

```ts
export async function userFromApiToken(db: Db, raw: string): Promise<JwtUser | null> {
  const hash = await hashApiToken(raw);
  const row = await db
    .select({ id: apiTokens.id, userId: apiTokens.userId, status: apiTokens.status,
              expiresAt: apiTokens.expiresAt, username: users.username })
    .from(apiTokens)
    .innerJoin(users, eq(apiTokens.userId, users.id))
    .where(eq(apiTokens.tokenHash, hash))
    .limit(1);
  if (!row || row.status !== "active") return null;
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) return null;

  // 记录最后使用时间(节流:每 60s 最多写一次,避免每次请求都写库)
  void maybeTouchLastUsed(db, row.id);
  return { id: row.userId, username: row.username };
}
```

`maybeTouchLastUsed`：用模块级 `Map<number, number>` 记内存时间戳，超过 60s 才 `UPDATE last_used_at`。Worker 会被回收，缓存丢失只是多写一次，无正确性问题。

`softAuth` 主流程不变：`isApiToken(bearer)` → `userFromApiToken` → 注入 user；失败回落 cookie。

### 3.2 API 路由 `src/worker/routes/admin.ts`

把现有三个路由替换成：

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| GET | `/api/admin/tokens` | 列出当前用户所有令牌：id、name、hint、status、expiresAt、lastUsedAt、createdAt（**永不回 hash/明文**） |
| POST | `/api/admin/tokens` | 入参 `{ name, expiresAt? }`，生成令牌返回明文一次 `{ id, token, hint }`；上限 20 个 |
| PATCH | `/api/admin/tokens/:id` | `{ name?, status? }`，改名 / 停用启用（只操作本人令牌） |
| DELETE | `/api/admin/tokens/:id` | 删除单个令牌，立即生效 |

实现要点：
- 所有查询都带 `where(and(eq(apiTokens.id, id), eq(apiTokens.userId, c.get("user")!.id)))`，防止越权操作他人令牌。
- 数量上限 20（对齐 new-api PAT），超限时返回 400 提示先删旧的。
- `name` 做 1–50 字符校验（zod），去空白。
- 保留旧的 `/token` 三个路由做**只读兼容**（GET 返回第一个 active 令牌的状态），前端升级后即可移除；也可以直接删除，因为插件配置页不调用这三个接口（插件只用 Bearer）。**建议直接删除**，减少维护面。

### 3.3 令牌生成 `src/worker/lib/token.ts`

保持不变（`generateApiToken` / `hashApiToken` / `tokenHint` / `isApiToken`）。

### 3.4 改密码联动 `src/worker/routes/auth.ts`

`change-password` 里把 `apiTokenHash/Hint/CreatedAt = null` 改成：

```ts
await db.delete(apiTokens).where(eq(apiTokens.userId, me.id));
```

语义：改密码撤销所有插件令牌（沿用现有安全承诺），JWT 仍靠 `tokenVersion++` 失效。文档/UI 文案同步说明「改密码会撤销所有插件令牌」。

## 四、前端（导航站后台）

### 4.1 Hooks `src/react-app/lib/admin-queries.ts`

替换现有的三个 hook：

```ts
export type ApiTokenInfo = {
  id: number; name: string; hint: string;
  status: "active" | "disabled";
  expiresAt: number | null; lastUsedAt: number | null; createdAt: number;
};
export type ApiTokenCreated = { id: number; token: string; hint: string };

useApiTokens()        // GET  client.api.admin.tokens.$get()
useCreateApiToken()   // POST { name } — onSuccess 把明文交给调用方展示
useUpdateApiToken()   // PATCH /tokens/:id { name?, status? }
useDeleteApiToken()   // DELETE /tokens/:id
```

queryKey 统一用 `["admin-api-tokens"]`，变更后 invalidate。

### 4.2 页面 `src/react-app/pages/admin/AdminSecurity.tsx`

把 `ApiTokenCard` 从「单卡片 + 生成/轮换/吊销」改成「令牌列表」：

- 表格列：名称、掩码（`bnav_…<hint>`）、状态徽章、创建时间、最后使用、过期时间、操作（停用/启用、删除）。
- 顶部「新建令牌」按钮 → 弹窗填名称（+ 可选过期）→ 成功后展示明文一次的输入框 + 复制按钮（复用现有 `freshToken` 交互）。
- 每行删除走现有 `ConfirmDialog`，说明「使用该令牌的插件将立即失效，其他令牌不受影响」。
- 明确文案：「建议每台设备/每个浏览器创建一个令牌，便于单独吊销；改密码会撤销全部令牌。」

## 五、浏览器插件

插件收藏功能无需改动——只认 Bearer 令牌字符串，配置页填哪个 `bnav_…` 就用哪个，一个插件实例对应一个令牌。

**但有一处必须改**：options 页保存前的 `verifyConfig`（`src/extension/lib/api.ts`）原本调 `GET /api/admin/token` 校验令牌，该路由在改造中被移除，若不改会得到 HTTP 404「令牌校验失败」。已改为调新列表接口 `GET /api/admin/tokens`（有效令牌 200、失效 401，语义不变）。

> 教训：删/改旧接口时，要全局 grep 所有调用方——插件侧不在 Hono RPC 类型网内，tsc 不会报它引用了已删除的路径，只能靠端到端测试发现（本问题就是用户实测截图暴露的）。

## 六、测试

### 6.1 新增/修改单元测试

- `token.test.ts`：现有生成/格式/哈希/hint 测试保持。
- 新增 `api-tokens.test.ts`（在内存 SQLite 上跑）：
  - 创建多个令牌，分别能认证，互不干扰。
  - 停用/删除一个后，其认证失败、其他仍成功。
  - 过期令牌认证失败。
  - 改密码撤销全部令牌。
  - 越权：用户 A 无法操作用户 B 的令牌 id。

### 6.2 端到端手动验证

1. 迁移前先建一个令牌 → 应用 0006 迁移 → 插件仍能用（搬迁生效）。
2. 后台新建两个令牌，分别配到两个浏览器 → 都能收藏。
3. 删除其中一个 → 对应浏览器收到 401，另一个正常。
4. 改密码 → 两个都失效，需重新生成。
5. `npm run typecheck:ext` / `npm test` / `npm run lint` / `npm run build:ext` 全绿。

## 七、改动文件清单与工作量

| 文件 | 改动 | 量级 |
| --- | --- | --- |
| `src/worker/db/schema.ts` | 新增 `apiTokens` 表 | 小 |
| `drizzle/0006_api_tokens.sql` + meta | 新表 + 数据搬迁 | 小 |
| `src/worker/middleware/auth.ts` | 认证改查新表 + 双读兼容 + lastUsed 节流 | 中 |
| `src/worker/routes/admin.ts` | 4 个新路由替换 3 个旧路由 | 中 |
| `src/worker/routes/auth.ts` | 改密码撤销逻辑 | 小 |
| `src/react-app/lib/admin-queries.ts` | 4 个 hook 替换 3 个 | 小 |
| `src/react-app/pages/admin/AdminSecurity.tsx` | 单卡片改列表页 | 中 |
| `src/worker/lib/api-tokens.test.ts` | 新增测试 | 中 |
| `docs/extension.md` / `docs/project.md` | 文案同步 | 小 |

预估：后端约 1.5 天、前端约 1 天、测试与发版约 0.5 天。**风险点**是 D1 迁移的数据搬迁与双读兼容，务必在迁移前后各验证一次旧令牌可用。

## 八、分步实施顺序

1. 加 schema + 写迁移 + 本地应用迁移，确认旧令牌搬迁成功。
2. 改认证中间件（含双读兼容），跑测试确认新旧令牌都能认证。
3. 改 admin 路由 + auth 改密码联动。
4. 改前端 hooks + 安全页 UI。
5. 补测试、跑全量门禁、本地 e2e 验证。
6. 发版（v0.2.0），文档同步。

每一步单独提交，便于回滚。
