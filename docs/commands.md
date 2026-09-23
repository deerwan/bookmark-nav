# 命令速查

> 在仓库根目录 `bookmark-nav/` 下执行。插件的 WXT 构建产物输出到 `.output/`,WXT 缓存到 `.wxt/`。

## npm scripts(package.json)

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 启动本地开发服务(Vite + Workerd),http://localhost:5173,热重载前后端 |
| `npm run build` | 生产构建:`prepare-deploy-config` 注入构建变量 → tsc → vite build |
| `npm run check` | 完整校验:tsc + vite build + wrangler deploy --dry-run(部署前必跑) |
| `npm run lint` | ESLint 检查全部源码 |
| `npm test` | 运行单元测试(Vitest,`src/**/*.test.ts`) |
| `npm run preview` | 构建后本地预览生产包 |
| `npm run deploy` | 应用 D1 迁移(remote)→ wrangler deploy(正式部署) |
| `npm run db:migrate` | 仅对远程 D1 应用迁移 |
| `npm run cf-typegen` | 重新生成 `worker-configuration.d.ts`(改了 wrangler.json 绑定后跑) |
| `npm run dev:ext` | 插件开发模式(WXT 热重载) |
| `npm run typecheck:ext` | 插件类型检查(tsconfig.ext.json),构建前必跑 |
| `npm run build:ext` | 构建插件 Chrome 版,输出 `.output/chrome-mv3` |
| `npm run build:ext:firefox` | 构建插件 Firefox 版,输出 `.output/firefox-mv2` |
| `npm run zip:ext` | 打包插件 zip(Chrome 版) |
| `npx wxt zip` | 打 Chrome 安装包(`.output/bookmark-nav-<版本>-chrome.zip`) |
| `npx wxt -b firefox zip` | 打 Firefox 安装包 + 源码包(`-firefox.zip` / `-sources.zip`) |
| `npx wxt submit init` | 交互式配置各商店发布凭据,生成 `.env.submit` |
| `npx wxt submit` | 自动提交新版本到商店审核/发布(需先 zip) |
| `npx wxt submit --dry-run …` | 只校验凭据与 zip,不真正提交 |
| `npm version patch --no-git-tag-version` | bump 版本(发版用,随后打同版本 tag 触发 CI) |

> 打包与商店上架完整流程见 [publishing.md](./publishing.md);CI/CD 自动构建见 [publishing.md](./publishing.md#六cicd-自动化构建补充渠道)。

## 本地开发初始化

```bash
npm install
cp .dev.vars.example .dev.vars   # 填入任意 JWT_SECRET
npx wrangler d1 migrations apply DB --local   # 须在 npm run dev 之前(dev server 会锁住本地 D1)
npm run dev                      # http://localhost:5173
```

## 数据库(Drizzle / D1)

| 命令 | 作用 |
| --- | --- |
| `npx drizzle-kit generate --name xxx` | 依据 schema.ts 生成新的迁移 SQL(drizzle/xxxx_xxx.sql) |
| `npx wrangler d1 migrations apply DB --local` | 应用迁移到本地 D1 |
| `npx wrangler d1 migrations apply DB --remote` | 应用迁移到远程 D1(等同 `npm run db:migrate`) |

> schema 在 `src/worker/db/schema.ts`,迁移在 `drizzle/`,journal 在 `drizzle/meta/_journal.json`。

> ⚠️ **本地迁移前先停掉 dev server**:dev server(workerd)会持有本地 D1 的 SQLite 文件锁,
> 此时执行 `d1 migrations apply/execute --local` 会报
> `database is locked: SQLITE_BUSY (extended: SQLITE_BUSY_RECOVERY)`。
> 正确顺序:停 dev server → 应用迁移 → 重新 `npm run dev`。
> 手写数据迁移(如 0005 的 DELETE)可先用内存 SQLite 验证语义(参考 `src/worker/db/purge.test.ts`)。

## 其他常用

| 命令 | 作用 |
| --- | --- |
| `openssl rand -hex 32` | 生成 JWT_SECRET |
| `npx tsc -b` | 主应用类型检查 |
| `npx tsc -p tsconfig.ext.json --noEmit` | 等同 `npm run typecheck:ext` |

## 测试账号(仅本地开发)

| 项 | 值 |
| --- | --- |
| 后台地址 | http://localhost:5173/admin |
| 用户名 | `admin` |
| 密码 | `password` |
| 登录接口 | `POST /api/auth/login` |

> ⚠️ 仅限本地开发使用;正式部署后请在后台「安全」页修改。浏览器插件访问令牌同样在「安全」页生成/吊销。
