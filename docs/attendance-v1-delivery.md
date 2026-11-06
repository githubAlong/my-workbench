# 教师工作台 V1.0 考勤管理交付报告

生成日期：2026-11-06
开发分支：`test`
基线：`1c2c4c31bf84ee93134b4cff13fc9ff16e665d0a`
正式发布：未执行

## 1. 数据保护

- 已检查 `D:\AI-FullStack-Studio-Recovery\test-recovery`。
- 完整备份位于 `D:\AI-FullStack-Studio-Recovery\round1-predevelopment-20261106\repository-copy`。
- 备份包含工作树、未提交/未跟踪文件及 `.git`。
- 源/备份逐文件校验：1225 个文件、83,248,917 字节、279 个目录。
- 路径、大小和 SHA-256 全部一致；备份前后 Git 状态一致。
- 源分支/HEAD：`test` / `b5faa59878c3bfb545deeabb7d53a67661420ab3`。
- 三个 stash 均保持原样，未执行 stash 恢复/删除。
- 未修改 J 盘事故仓库、`incident-20261106-0905` 或旧同步脚本。
- SHA-256 清单与验证报告：
  - `D:\AI-FullStack-Studio-Recovery\round1-predevelopment-20261106\evidence\source-sha256.txt`
  - `D:\AI-FullStack-Studio-Recovery\round1-predevelopment-20261106\evidence\backup-sha256.txt`
  - `D:\AI-FullStack-Studio-Recovery\round1-predevelopment-20261106\evidence\verification-report.json`

## 2. 基线与安全修改迁移

- GitHub 远程 `dev` 在再次核验时仍为 `1c2c4c31bf84ee93134b4cff13fc9ff16e665d0a`。
- 新仓库：`D:\AI-FullStack-Studio-Recovery\test-v1.0`。
- 远程 `dev` 保持原样；本地 `test` 从已核验 SHA 建立。
- 已迁移 S0-01/S0-02：
  - Supabase 地址只接受当前固定环境，URL 参数和旧 localStorage 不能改目标。
  - Realtime 复用同一个受信任配置。
  - 旧 `reset-dev-data` 只清理地址栏，不修改本机或云端数据。
- 未迁移 S0-03 和第七轮首页布局代码；未导入未完成的 `home-layout-migration.mjs`。
- 保留最新 dev 的 Excel 名单导入、OCR、课表拖拽、地点字段和原有考勤能力。

## 3. 功能变更

| 功能 | 修改前 | 修改后 |
|---|---|---|
| 表类型 | `class` 被映射成 `seat`，上课表是坐班表筛选视图 | `seat` / `research` / `class` 三种一等类型，三表独立数据、草稿、确认和修改待确认 |
| 日常生成 | 坐班可按节次生成多张，可能多于三张 | 每个用户/年级/日期固定一张坐班、一张教研、一张上课；节次只作表内元数据 |
| 并发保护 | 同一行可能后写覆盖先写 | 行级 `updated_at` 版本校验 + 事务 RPC，冲突返回 `WB_ATTENDANCE_CONFLICT` |
| 临时教师 | 与坐班/上课混合逻辑耦合 | 只允许当天上课表；不进入永久花名册，次日不自动出现，统计计入临时教师 |
| 花名册 Excel | 解析后直接写库 | 完整展示解析结果，可逐条改、删、补，确认后才写库 |
| 花名册校验 | 姓名可缺、重复口径分散 | 姓名和学科必填；精确姓名+学科重复由 UI、API、数据库索引三层保护 |
| OCR 花名册 | 有识别与编辑 | 保留识别；增加逐条删除和补齐待填记录，确认前不入库 |
| 三表语音 | 部分入口可达 | 三种表均有语音入口，识别结果可改后应用；未匹配人员仅在当天上课表允许临时新增 |
| 教研批量 | 按学科块“全部签到” | 保留并抽成可测试的隔离操作，只影响选中学科 |
| 统计 | 上课节数可能混入坐班“上课”状态 | 上课节数只取 `class` 表；坐班天数只取 `seat` 表并按日期去重 |
| 最近 12 个月 | 可能跨年时缺前一年月份 | 跨年窗口合并前一年/当前年数据 |
| 导出 | 三表已有按钮 | 三表各自导出 PDF/PNG/Excel；不合并，不生成在线分享链接，水印继续可关和自定义 |
| 环境配置 | 测试参数可覆盖 Supabase 地址 | 仅按固定 host 分流 dev/prod；未知 host 拒绝启动云端配置 |

## 4. 主要开发文件

- 规则与导出：`js/attendance-domain.mjs`、`js/attendance-export.mjs`
- 每日三表：`js/attday.js`、`js/attindex.js`
- 考勤工作台：`js/attendance.js`、`js/attstats.js`
- 年级与名册：`js/attgrade.js`
- 本地/云端数据契约：`js/localapi.js`、`js/cloud.js`、`js/migrate.js`、`js/realtime.js`
- 固定环境：`js/environment-config.mjs`
- 启动安全：`js/startup-safety.mjs`、`js/main.js`、`js/auth.js`
- 样式与离线资源：`css/app.css`、`css/attendance-workspace.css`、`sw.js`
- 数据库待审批迁移：`supabase/migrations/20261106032010_attendance_v1_foundation.sql`
- 测试/检查：`tests/*.test.mjs`、`tests/test-browser.mjs`、`scripts/check-project.mjs`
- 本地截图夹具：`tests/fixtures/attendance-v1.html`

## 5. 自动化测试结果

实际执行 `npm test`：51 项通过，0 项失败。

覆盖点：

1. 年级隔离。
2. 46 人双栏名单完整保留。
3. OCR 结构识别、人工校正、删除和确认门禁。
4. 三张表独立生成。
5. 三张表独立确认。
6. 修改后回到待重新确认。
7. 上课表临时教师。
8. 临时教师不进入永久花名册。
9. 教研按学科批量签到。
10. 病假/事假、上午/下午/全天、请假时长。
11. 语音识别结果确认后应用。
12. PDF/PNG/Excel 三表独立导出数据源与文件名。
13. 近 12 个月跨年和年度统计。
14. 两客户端版本冲突拒绝静默覆盖。
15. Realtime 配置和考勤页刷新接线。
16. PC/手机响应式 CSS。
17. 原有考勤与原清单/OCR/课表回归。
18. 500 名教师、单日 1000 条记录的本地列表测试耗时约 25 ms。

其他检查：

- `npm run check`：62 个 JS/MJS 文件语法通过。
- Service Worker：51 个资源存在，所有 `js/` 文件已入清单；唯一缓存版本 `wb-v122-v1-attendance-triple`。
- `git diff --check`：交付前复核。
- Chrome 1440px、768px、390px 实测：桌面/iPad/手机均无页面级横向溢出；390px 下 `clientWidth = scrollWidth = 390`。

说明：以上均为本地 Node/内存/浏览器夹具验证，不是 Supabase 真实环境验证。

## 6. 核心截图

- `docs/screenshots/attendance-grade-list.png`
- `docs/screenshots/attendance-roster-desktop.png`
- `docs/screenshots/attendance-seat-desktop.png`
- `docs/screenshots/attendance-research-desktop.png`
- `docs/screenshots/attendance-class-desktop.png`
- `docs/screenshots/attendance-seat-mobile.png`
- `docs/screenshots/attendance-seat-tablet.png`
- `docs/screenshots/app-login-smoke.png`

## 7. Supabase 待审批迁移

项目：`my-workbench-dev`
Ref：`xgvmwbzvvjnhzadfvdmj`
核验状态：ACTIVE_HEALTHY；`public` 0 表、0 迁移。

迁移文件将创建/配置：

- `wb_user_data` 账号快照及 revision CAS RPC。
- `attendance_tables` 考勤主表及每日唯一索引。
- `attendance_rows` 考勤明细、重复记录索引、父表归属触发器。
- `attachments` 考勤原表/照片元数据。
- 全部表的 RLS、`auth.uid()` 所有权策略和 Data API grants。
- Realtime publication。
- `wb_save_attendance_rows` 原子保存与版本冲突 RPC。
- 年级云表改名和软删除 RPC。

迁移尚未执行。必须取得用户对 SQL 写入的单独批准后才可应用。

## 8. 部署状态

- Cloudflare Wrangler 版本：4.158.0。
- Cloudflare 当前未登录；一次 OAuth 登录在等待授权码时超时。
- 尚未创建或修改 Pages 项目，也未发布测试地址。
- 建议项目名：`my-workbench-test`。
- 测试站固定使用 dev Supabase；正式 GitHub Pages 继续使用正式 Supabase。
- 未推送 `dev` 或 `master`。

## 9. 尚未完成 / 验收阻塞

1. 需要用户单独批准 Supabase 迁移 SQL，才能创建 dev 业务表。
2. 需要用户在浏览器完成 Cloudflare OAuth 授权，才能核对并创建/发布 Pages 测试项目。
3. 需要测试账号才能完成 dev Supabase 的真实登录、Realtime 和 12 客户端并发自测。
4. 真实 Supabase 多端延迟（目标 <3 秒）、真实云导出文件和 OCR 实拍准确率尚未在部署环境验证。
5. 未经用户验收，不进入正式环境，不推送 dev/master，不执行正式发布。
