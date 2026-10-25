# 部署与外网访问

## 一、本地跑起来

```bash
npm install
cp .env.example .env      # 然后按需填写
npm start                 # 默认 http://localhost:3000
```

同一局域网内，手机 / iPad 用 `http://<电脑局域网IP>:3000` 就能打开，数据和电脑是同一份。

## 二、部署到 Render（外网可访问）

仓库里带了 `render.yaml`，直接用它建服务即可。

1. Render → **New → Blueprint** → 选本仓库 → 应用
2. 在 **Environment** 里补这几个变量（`.env` 里的不会跟着仓库走，必须手填）：
   - `TEST_PASSCODE`：先给自己留一个登录用的测试码
   - `ALLOW_TEST_PASSCODE=1`
   - 短信相关（`SMS_*`）：有就填，没有就跳过，用测试码登录
3. 部署完会拿到 `https://<name>.onrender.com`，手机、iPad、电脑都打开这个地址

### ⚠️ 必须知道的一件事：磁盘

SQLite 是**文件数据库**，而 Render 的容器文件系统是临时的——每次重新部署换新容器，
写在容器里的数据库会跟着消失。所以 `render.yaml` 里挂了一块持久化磁盘：

```yaml
disk:
  mountPath: /var/data
  sizeGB: 1
```

并把 `DATA_DIR=/var/data`、`UPLOAD_DIR=/var/data/uploads` 指过去。
**这两个变量不要删**，删了就等于每次部署清空一次数据。

持久化磁盘需要 Render 的付费计划（Starter 起），免费计划不支持挂盘。

## 三、数据备份

不管部署在哪，都建议定期导出：

- 站内：「我的 → 数据导出与备份」，导出一份 JSON
- 命令行：`node tools/backup.mjs`

导出的 JSON 可以在新环境里直接导入恢复，换平台也不怕。

## 四、短信为什么要单独配

真发短信必须接一家服务商，需要帐号、签名、模板审核，代码这边配好 `SMS_*` 就自动生效。
没配之前：

- 登录页会自动切到「密码登录」
- 或者用 `TEST_PASSCODE` 这个测试码进（务必配好真短信后把 `ALLOW_TEST_PASSCODE` 设为 `0` 关掉）

## 五、这个站没有的东西

- **WorkBuddy 授权登录**：需要平台侧的应用资质，代码已留好接口但默认关闭
- **微信 / QQ 扫码**：同上，需要企业资质 + AppID
- 但**本站自己的扫码登录是可用的**：手机已登录时，扫电脑上的码就能登进去
