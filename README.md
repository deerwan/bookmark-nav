# Bookmark Nav

多功能简洁书签导航站。前台是干净的公开导航页,后台提供完整的书签管理能力,数据完全存放在你自己的 Cloudflare 账号里。另有浏览器插件,一键收藏 + AI 智能填充。

![Bookmark Nav 预览](./img/image.png)

## 文档


- [项目说明与部署](./docs/project.md):功能特性、Fork 部署到 Cloudflare、更新版本、许可证
- [浏览器插件](./docs/extension.md):安装、配置、日常使用、AI 功能、插件开发
- [开发相关](./docs/development.md):技术栈、架构、目录结构、本地开发、代码规范
- [命令速查](./docs/commands.md):npm / wrangler / drizzle / wxt 全部常用命令
- [商店上架与打包](./docs/publishing.md):Chrome Web Store / Firefox AMO / WXT 自动发布
- [已知限制与建议](./docs/limitations.md):限制清单、遗留建议、后续规划

## 快速开始

```bash
npm install
cp .dev.vars.example .dev.vars   # 填入任意 JWT_SECRET
npx wrangler d1 migrations apply DB --local   # 须在 npm run dev 之前(dev server 会锁住本地 D1)
npm run dev                      # http://localhost:5173
```

## 💰 请喝咖啡

如果这个项目对你有帮助，欢迎赞助支持！

<table>
  <tr>
    <td align="center">
      <strong>微信</strong><br>
      <img src="./public/zsm.jpeg" alt="微信" width="200">
    </td>
    <td align="center">
      <strong>支付宝</strong><br>
      <img src="./public/zfb.JPG" alt="支付宝" width="200">
    </td>
    <td align="center">
      <strong>红包码</strong><br>
      <img src="./public/hbm.PNG" alt="红包码" width="200">
    </td>
  </tr>
</table>

☕ 感谢所有支持者！

## 许可证

[GPL-3.0](./LICENSE)

