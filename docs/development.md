# 开发相关

## 技术栈

| 层 | 技术 |
| --- | --- |
| 前端 | React 19 · Vite · TanStack Query · shadcn/ui · Tailwind CSS v4 |
| 后端 | Hono(RPC 模式,前后端类型共享) |
| 数据库 | Cloudflare D1(SQLite)+ Drizzle ORM |
| 部署 | Cloudflare Workers(静态资源 + API 同一 Worker) |
| 浏览器插件 | WXT + React(与主前端共享 UI 组件与设计语言) |

后端仅依赖标准 Web API 与 SQLite,如需迁移到自托管环境(Node + SQLite/Postgres),只需替换 D1 绑定与部署配置。

## 整体架构

```
src/
├── worker/            # 后端(单 Worker 同时服务 API + 静态资源)
│   ├── index.ts       # Hono 入口:/api/auth|public|admin + CORS + 软认证;Scheduled handler
│   ├── middleware/    # 软认证(cookie JWT / Bearer PAT)、强认证
│   ├── routes/        # auth / public / admin 三组路由
│   ├── lib/           # 令牌、密码、AI、维护任务、备份、书签格式解析、限流等
│   └── db/            # D1 客户端 + schema
├── react-app/         # 前端(前台 Home + 后台 /admin/*,后台按路由懒加载)
└── extension/         # 浏览器插件(WXT)
```

- **认证双通道**:网页用 `HttpOnly + SameSite=Lax` cookie JWT;浏览器插件用 `Authorization: Bearer bnav_…` 访问令牌(PAT),两者注入同一 `user`。改密码时 `tokenVersion++` 使 JWT 失效,同时吊销 PAT。
- **CORS**:仅放行 `chrome-extension://` / `moz-extension://` / `safari-web-extension://` origin,`credentials:false`(插件不用 cookie)。
- **公开接口私密过滤**:未登录时分类需整条祖先链为 public 才可见;点击计数对无权限书签也返回 `ok:true`,防止探测私密书签存在性。

## 本地开发

```bash
npm install
cp .dev.vars.example .dev.vars   # 填入任意 JWT_SECRET(本地登录会话签名)
npx wrangler d1 migrations apply DB --local   # 须在 npm run dev 之前(dev server 会锁住本地 D1)
npm run dev                      # http://localhost:5173(前后端热重载)
```

- 本地数据库在 `.wrangler/state/v3/d1/`,改动 schema 后:
  1. `npx drizzle-kit generate --name xxx` 生成迁移
  2. `npx wrangler d1 migrations apply DB --local` 应用(注意:先停 dev server,workerd 会锁住本地 D1 文件导致 `SQLITE_BUSY`,见 [commands.md](./commands.md))
- 本地测试账号 `admin / password`,见 [commands.md](./commands.md)。
- 插件开发:见 [extension.md](./extension.md) 的「插件开发」。

## 代码规范与注意事项

- **注释**:重要设计决策写“为什么”,不只写“做了什么”(与仓库现有风格一致)。
- **类型共享**:后端用 Hono `AppType`,前端 `hc<AppType>` 端到端推导;新增 API 后前端自动获得类型。插件侧因域名运行时未知,用独立的 fetch 封装(见 `src/extension/lib/api.ts`)。
- **敏感配置白名单**:`/api/public/site` 只下发白名单键(`PUBLIC_SETTING_KEYS`),防止 AI 密钥等泄露。
- **D1 限制**:单条 SQL 绑定变量上限约 100,批量操作分批(参考 `BATCH_SIZE = 90`);IN 列表大时先全量取回内存映射(参考 `attachTags`)。
- **MV3 插件注意**:Service Worker 会被回收,状态只存 storage;`@` 别名被 WXT 占用,复用主前端组件见 `src/extension/lib/utils.ts` shim。
- **部署安全**:`JWT_SECRET` 等机密放构建变量(worker #8871 原因),不提交到仓库;`.dev.vars` 已在 .gitignore。
