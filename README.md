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
