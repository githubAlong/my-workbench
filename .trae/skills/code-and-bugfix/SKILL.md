---
name: code-and-bugfix
description: my-workbench 项目专属的开发与修 bug 规范：本地/云端双轨数据接口、按域名固定环境配置、Service Worker 缓存、dev→master 发布流程与本地验证命令。在本仓库新增功能、修改接口或修复线上问题时使用。
---

# my-workbench 写代码与改 bug

配合通用技能 `code-and-bugfix` 的流程（先读后改、先复现后修、验证后再报），以下是本仓库的硬约定。违反其中任何一条，改动大概率会在线上才暴露。

## 项目形状

- 纯静态站，无构建、无框架、无打包器：原生 ES Module，入口 `index.html` → `js/main.js`，按需动态 `import()`。
- 目录职责：`js/*.js` 含 DOM/浏览器逻辑；`js/*.mjs` 是可被 Node 直接测试的纯规则模块；`tests/*.test.mjs` 对应测试；`scripts/*.mjs` 是构建/检查/预览脚本；`supabase/` 放迁移与 Edge Function。
- 模块按功能拆（`att*.js` 考勤、`roster-*.mjs` 名册、`attendance-domain.mjs` 判定规则）。新逻辑优先做成纯函数放 `.mjs`，让测试能直接覆盖。

## 数据层：本地 + 云端双轨（最容易踩）

接口统一入口是 `js/localapi.js` 的 `handle()`：先尝试 `cloudRoute`（Supabase），未接云端的接口返回 `null` 再掉回本地 localStorage 实现。

新增或修改任何接口时逐条确认：

1. 本地路由和 `cloudRoute` 两边**都要实现**，且返回形状完全一致（云端以 `attRowShape` / `attListShape` 这类函数对齐本地契约）。
2. 表族接口要登记进 `CLOUD_TABLES`；漏登记不会报错，只会安静走本地，表现为「云端有数据但页面空白」。
3. 带二级语义的路径（如 `/lessons/summary`、`/lessons/statement`、`/lessons/settle`、`/lessons/unsettle`）必须在 `cloudRoute` 里**单独分支**，否则会被「单表通用」当成 `id = summary` 的查询，直接抛「云端暂不支持」，整页加载失败。
4. 云端 `null` 只表示「这个接口没接云端」，不是空数据；空数组才表示真的没有数据。
5. 云端 id 一律带 `c` 前缀（`c123`），发请求前去掉；判错方向会出现「界面提示已删除，云端纹丝不动」。

改完对照对应本地实现看一遍契约差异，这是历史上出问题最多的地方。

## 环境配置

- 环境只由 **hostname** 决定，固定写在 `js/environment-config.mjs` 的 `ENVIRONMENT_PROFILES`；URL 参数和 localStorage 都不能覆盖。
- 新增域名必须同时放进 `hosts` 或 `hostSuffixes`，否则 `resolveEnvironmentProfile` 直接抛「未配置当前访问环境」。
- 不要加入不存在的 pages.dev 域名（无法签发证书，TLS 直接失败）。
- 隧道地址变更时，同步更新 `supabaseUrl`，否则线上接口全 404。

## Service Worker 与静态资源

- `js/` 下任何文件改动或新增，都要同步更新 `sw.js` 的 `CACHE` 版本号并把新文件加进 `ASSETS`；`npm run check` 会强制校验（每个 `js/*.js` 必须列入清单、只能有一个缓存版本）。
- Service Worker 是网络优先、断网兜底，改策略前先读 `sw.js` 顶部的白屏事故复盘。

## 验证（改完必跑）

```bash
npm test        # node --test tests/*.test.mjs
npm run check   # 全量语法 + sw.js 资源存在性 + 缓存版本唯一
npm run preview # 本地起静态服务，手工验证界面
```

- 只跑测试不算验证完成：涉及界面的改动要在 `npm run preview` 里实际点一遍。
- 修 bug 要能说出复现条件和根因，并确认原场景已恢复。

## 分支与发布

- 在 `dev` 上开发和提交，`master` 只接受从 `dev` 合并（pre-commit 钩子会拦截 master 直接提交）。
- 发布用 `./scripts/release.sh -n` 先 dry-run 看范围，再去掉 `-n` 正式合并。
- 新克隆仓库先跑一次 `scripts/install-hooks.sh`。

## 安全红线

- 前端代码里绝不出现 Supabase `service_role` 密钥；密钥只放 Edge Function secrets。
- 不在代码、日志、聊天里写用户手机号、验证码、临时密码。
- 权限判断以后端/RLS 为准，前端隐藏入口不构成安全边界。

## 文案与风格

- UI 文案、错误提示、注释统一用中文；错误提示要能让人知道下一步做什么（如「加载失败，请刷新重试」）。
- 注释解释「为什么这么做」和踩过的坑，不复述代码在做什么。
- 不要把旧的 `student.html` / `student.bundle.js` / `app.js` 当成项目代码，它们是上一代项目残骸。
