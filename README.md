# 我的工作台

静态 Web 工作台，当前部署于 GitHub Pages。登录使用 Supabase Auth 手机号 + 密码。可选的腾讯云短信 Auth Hook 配置见下文。

## 手机号登录配置

在 Supabase Dashboard 的 Authentication 设置中：

1. 启用 Phone provider，并启用新用户注册。
2. 如果要使用短信注册/验证，部署并配置下方的 Send SMS Hook 后，再按需要启用 Phone confirmations。Hook 只负责把 Supabase Auth 发起的短信交给腾讯云；前端也必须使用与短信验证码相匹配的注册/验证流程。
3. 不使用短信验证时关闭 Phone confirmations。
4. 不要在前端代码中保存 Supabase `service_role` 密钥。

用户注册时只验证手机号格式，不验证号码归属。任何人都可能先注册尚未被占用的号码，因此这不是已验证的手机号身份；不要用此方式保护高敏感数据。管理员手机号应先确保已经是 Supabase 用户，且不要让其他人抢先注册。

## 管理员重置密码

`supabase/functions/admin-reset-password/index.ts` 是管理员重置密码的 Supabase Edge Function。它要求请求者同时匹配服务器端配置的管理员 Supabase 用户 ID 和手机号；前端隐藏管理入口不构成安全边界。

部署前先从 Supabase Dashboard → Authentication → Users 中确认管理员用户 ID 和手机号。不要把用户 ID、密钥或重置密码发到聊天或提交到代码库。

安装并登录 Supabase CLI 后，在仓库根目录设置 Edge Function secrets 并部署：

```powershell
supabase secrets set ADMIN_USER_ID=<管理员Supabase用户UUID> ADMIN_PHONE_E164=+8613071825243
supabase functions deploy admin-reset-password
```

函数会使用 Supabase Edge Functions 提供的 `SUPABASE_URL`、`SUPABASE_ANON_KEY` 和 `SUPABASE_SERVICE_ROLE_KEY` 环境变量；若项目没有自动注入这些变量，请在 Supabase Dashboard 的 Edge Function secrets 中配置。`service_role` 只能保存在服务端。

部署后，管理员用管理员手机号登录，在「我的 → 管理 → 重置用户密码」输入目标用户手机号。临时密码只在响应和页面中显示一次，应由管理员通过私下渠道交给用户。管理员账号不能通过该功能重置自身密码。

Edge Function 仅允许来自 `https://githubalong.github.io` 的浏览器跨域请求；若部署到其他域名，需要同步修改函数中的 CORS 来源。

## 腾讯云短信 Send SMS Hook（可选）

`supabase/functions/send-sms-hook/index.ts` 接收 Supabase Auth Hook 的 Standard Webhooks 请求，验证 `webhook-id`、`webhook-timestamp` 和 `webhook-signature`，从 `user.phone`、`sms.otp` 读取手机号和验证码，再用腾讯云 SMS `SendSms` API 发送。函数不会记录手机号或验证码；凭证只从 Edge Function secrets 读取。

先在腾讯云短信控制台准备好短信应用、**已审核通过的签名**和短信模板。模板必须含一个验证码变量（例如 `${1}`），模板 ID 与签名内容须符合腾讯云审核及使用要求。未完成资质/签名/模板审核时，函数无法发送真实短信；不要尝试绕过审核。

在仓库根目录为该 Supabase 项目设置 secrets（值只在本机终端输入，不要提交或发到聊天）：

```powershell
supabase secrets set `
  "TENCENT_SECRET_ID=你的腾讯云SecretId" `
  "TENCENT_SECRET_KEY=你的腾讯云SecretKey" `
  "TENCENT_SMS_SDK_APP_ID=短信SdkAppId" `
  "TENCENT_SMS_SIGN_NAME=已审核短信签名" `
  "TENCENT_SMS_TEMPLATE_ID=已审核模板ID" `
  "TENCENT_REGION=ap-guangzhou" `
  "SUPABASE_SMS_HOOK_SECRET=v1,whsec_从Supabase复制的Hook密钥"
```

使用腾讯云 IAM 子账号密钥，并只授予发送短信所需权限；不要使用或暴露主账号密钥。`SUPABASE_SMS_HOOK_SECRET` 必须填写 Supabase Hook 配置生成的完整 `v1,whsec_...` 值。Hook 请求签名或时间戳无效时，函数不会发送短信。

成功发送后，函数返回 HTTP 200 和 JSON `{}`；发送失败返回非 200，使 Supabase Auth 知道短信未送达。

部署函数时关闭 Supabase Edge Gateway 的 JWT 校验（函数自身会验证 Hook 签名）：

```powershell
supabase functions deploy send-sms-hook --no-verify-jwt
```

部署 URL 格式为：

```text
https://<项目Ref>.supabase.co/functions/v1/send-sms-hook
```

本项目 URL 的 Hook 地址为 `https://gfgxvpvexzcfbujkwsqw.supabase.co/functions/v1/send-sms-hook`。在 Supabase Dashboard → Authentication → Hooks 中添加 **Send SMS Hook**，选择 HTTP endpoint，填入此 URL，并将生成的完整 `v1,whsec_...` 密钥配置到上述 secret。仅在函数 secrets 和 Hook 配置都完成后启用 Hook。腾讯云短信必须已完成资质、签名和模板审核。

## 本地数据与云同步

本地工作台数据按 Supabase 用户 ID 分开存储在浏览器 `localStorage` 中。旧的 `wb_static_db_v1` 数据保留原位，不自动迁移给任何新账号。清除浏览器数据会删除对应设备上的本地记录。

现有 Supabase 云同步目前只覆盖项目已接入的表（例如课时）；这项登录改动不会自动把所有本地模块迁移到云端，也不会让所有模块跨设备同步。

## 首页布局

首页 6 张卡片（个人信息、每日一句、天气、今日事项、今日课程、日历）是 12 列栅格里可拖拽、可缩放的模块，实现见 `js/homegrid.js`。搜索框和倒计时通栏是固定区域，不参与拖拽。

- **位置存在哪**：账号的 `settings.homeLayout`，结构是 `{ version, updatedAt, breakpoints: { desktop, tablet, mobile } }`，每套断点各自存 `layout`（`{ id, x, y, w, h }`）与 `hidden`。
- **跨设备**：保存时额外写一份到 Supabase 的 `wb_sync`（RPC `wb_put`），键名 `home-layout-v1-<用户UID>`；进入首页时用 `wb_get` 拉一次，云端比本地新就用云端。云端不可用时静默退回本地那份，不影响使用。
- **保存策略**：显式点「保存布局」才提交（不做自动保存）。失败时草稿留在本机 `localStorage` 的 `wb_home_layout_draft`，刷新后仍可重新保存。
- **隐藏**：隐藏只是不渲染，位置配置保留，三套断点共享同一份 `hidden`；至少保留一张卡片。
- **手机**：自动单列（`w=12`、行高 auto），不沿用桌面位置，也不提供拖拽/缩放，只保留隐藏/显示。

## 教师考勤（按 PRD V1.0 实现）

入口：工作 → 考勤。数据按年级隔离，一个年级一套花名册、三张表、一份统计。

### 结构
- **年级**：内置高一/高二，可新建（如高三）、改名、删除。改名会把该年级的名册和考勤表一起迁过去；删除是软删，可从回收站找回。
- **花名册**：姓名 + 学科。四种进来的方式：手动加、批量粘贴、Excel 导入、拍照建册（照片 + 对照录入）。顶部按学科筛选，`学科管理` 可重命名（名册和历史记录一起改）或删除（有人挂着会被拦住）。
- **三张表**：坐班表 / 教研签到表 / 上课检查表，每天一张，可以自建也可以传 Excel / 拍纸表照片导入。列名照老师手上的纸表：
  - 坐班表：`序号 姓名 学科 上课 坐班 听课 教研 请假 备注`（纸表一页双栏，左 1~23、右 24~46，导入时自动接成一列）
  - 教研签到表：`序号 姓名 学科 签到 备注`（按学科分块，**每块的序号从 1 重新开始**）；纸上没有请假列，假别写在备注里
  - 上课检查表：`序号 姓名 学科 按时上课 请假 备注`
- **统计表**：按老师汇总，近 12 个月滚动 + 按年归档翻页，可导出 Excel。

### 状态怎么判定
纸表上一个节次只给一个人划一格，所以界面里同一行只有一种状态：**打✓时同行的其他状态格自动取消**（再打×不清别人，× 表示「这一项没做」）。判定优先级：

| 顺序 | 条件 | 状态 |
|---|---|---|
| 1 | 请假格打了✓，或有假别细化数据，或备注里写了请假/病假/事假/公出 | 请假 |
| 2 | 上课 / 坐班 / 听课 / 教研 / 签到 / 按时上课 任一打了✓ | 在岗（教研表叫已签到） |
| 3 | 没有✓但画了× | 未到（教研表叫未签到） |
| 4 | 一格都没动过 | 未填 |

行底色跟着状态走（请假淡橙、未到淡红），汇总条给出「在岗 / 请假 / 未到 / 未填」四个人数，加起来等于总人数。统计表里的「未到」只算**明确画了×**、或**表已确认却仍然全空**的 —— 刚建出来还没填的表不会被算成缺勤。

### 确认机制（FR-TABLE-4/5）
每张表编辑完要点 **确认生成** 才算正式生效；确认后**仍然可以改**，改完再点一次「重新确认」覆盖。状态三档：

| 状态 | 含义 |
|---|---|
| 未确认 | 还没点过确认，算草稿 |
| 已确认 | 已确认且之后没动过 |
| 已修改·待确认 | 确认后又改了，等重新确认 |

「只是点了保存、一个格子都没动」不会把状态打成待确认（前端带 `dirty` 标记，后端比对列定义内容后再决定）。

### 请假（FR-TABLE-3）
勾「请假」会弹细化框：假别（病假/事假/未注明）、时段（上午/下午/全天）、时长（天，全天默认 1、半天 0.5）。格子下面会显示 `病·上` 这样的小标签（完整信息在 title 里），点「请假」格还能再改。取消勾选时细化数据一起清掉。

教研签到表默认没有「请假」列（纸表就没有）。要给假别单独计数时，工具栏 **＋ 加一列** 会预填好「请假」，点「确定」即可；不加也能用 —— 老师在备注里写「病假」，判定和统计同样按请假算。

### 临时老师（FR-CLASS-1~4）
上课表工具栏的 **＋ 临时老师**：跨年级借调来的人，只写进当天这张表，**不进名册**，次日新建表自动消失；统计里归到「临时老师」维度，末尾给一条合计，保证总数和三张表对得上。行上打 `data.__temp = 1` 标记。

### 语音录入（FR-VOICE）
表头的 **语音** 按钮。话术 `姓名 [学科] 状态`，可以连着说多人。状态词按纸表枚举：坐班表说「上课 / 坐班 / 听课 / 教研 / 请假（病假、事假）」，教研签到表说「签到 / 请假」，另外说「没来 / 缺勤」会标成未到。识别结果先列成可编辑列表（姓名/学科/状态都能改，请假的还能点开选假别时段），**点「应用到表格」才写入**。没有麦克风或接口被禁的设备会自动露出「打字/粘贴」入口，用的是同一套解析。

### 导入导出
- **导入**：Excel（姓名列 + 学科列，自动找表头）、粘贴 Excel 剪贴板、纸表拍照（识别打勾状态）。
- **导出**：三张表各自独立导出，`Excel`（数据）/ `PDF`（打印预览→另存为 PDF）/ `截图发群`（PNG）。PDF 和 PNG 支持水印。
- **水印**：`导出设置` 里开关 + 自由文字，支持 `{grade}` `{date}` `{name}` 占位。关掉就是干净文件；Excel 不加。

### 数据与同步
考勤表存在云端 `attendance_tables` / `attendance_rows`（Supabase），名册仍在本地库（`teachers`）。确认状态记在 `attendance_tables.meta` 的 `confirmed_at` / `confirm_dirty` 上 —— 线上表已有 `meta` 列，不需要改数据库 schema。

### 已知未做
`拍照建册` 目前没有随附 OCR 引擎（仓库里只有 `ocr/chi_sim.traineddata.gz` 语言包，没有运行时代码），所以走的是「照片摆在上面、对着它逐行录入」；若页面提供 `window.WB_OCR.recognize(file)` 会自动调用识别并预填。要真正离线 OCR，需要额外引入 Tesseract（约 4MB wasm + 20MB 中文语言包）并加进 Service Worker 缓存。
