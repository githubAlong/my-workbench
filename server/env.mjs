/* 极简 .env 读取（不引入依赖） */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const raw of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(k in process.env)) process.env[k] = v;
  }
}

export const CONFIG = {
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || '0.0.0.0',
  dataDir: process.env.DATA_DIR || path.join(ROOT, 'data'),
  uploadDir: process.env.UPLOAD_DIR || path.join(ROOT, 'uploads'),
  wxAppId: process.env.WX_APPID || '',
  wxAppSecret: process.env.WX_APPSECRET || '',
  qqAppId: process.env.QQ_APPID || '',
  qqAppKey: process.env.QQ_APPKEY || '',
  workbuddyClientId: process.env.WORKBUDDY_CLIENT_ID || '',
  workbuddyClientSecret: process.env.WORKBUDDY_CLIENT_SECRET || '',
  /* OAuth 回调地址。线上必须显式填完整 https 地址：
     反向代理后 req 拿到的 host 常是内网 IP，自动推断会得到浏览器打不开的地址。
     而且授权阶段和换 token 阶段的 redirect_uri 必须字节级一致，写死最稳。 */
  workbuddyRedirectUri: process.env.WORKBUDDY_REDIRECT_URI || '',
  /* 部署在 https 后面时置 1，Cookie 才会带 Secure、回推协议才用 https */
  prodHttps: process.env.PROD_HTTPS === '1',
  /* 站点对外地址（形如 https://xxx.app.workbuddy.host）。
     扫码登录的二维码里必须写绝对地址，手机扫到才能直接打开；
     靠请求头 Host 推断在反向代理后面经常拿到内网地址，手机扫了打不开。
     配了这一项就优先用它，没配才退回按请求头推断。 */
  siteUrl: (process.env.SITE_URL || '').replace(/\/+$/, ''),
  demoMode: process.env.DEMO_MODE !== '0',
  // 是否允许新用户自助注册（单人使用请设为 0，只有已有账号能登录）
  allowRegister: process.env.ALLOW_REGISTER === '1',
  devOtpEcho: process.env.DEV_OTP_ECHO !== '0',

  /* 测试通行证：没有短信通道时，用一串固定码把注册/验证码登录走通，用于自测。
     默认关闭。打开后还要满足「没配任何真实短信通道」才生效，
     填了短信密钥它自动失效——能真发短信就不该再接受测试码。 */
  allowTestPasscode: process.env.ALLOW_TEST_PASSCODE === '1',
  testPasscode: process.env.TEST_PASSCODE || '',

  /* 短信通道（三种任选其一，都不配则只能用密码登录） */
  smsSignName: process.env.SMS_SIGN_NAME || '我的工作台',
  smsTemplateCode: process.env.SMS_TEMPLATE_CODE || '',
  smsWebhookUrl: process.env.SMS_WEBHOOK_URL || '',
  smsWebhookToken: process.env.SMS_WEBHOOK_TOKEN || '',
  smsAccessKeyId: process.env.SMS_ACCESS_KEY_ID || '',
  smsAccessKeySecret: process.env.SMS_ACCESS_KEY_SECRET || '',
  smsSecretId: process.env.SMS_SECRET_ID || '',
  smsSecretKey: process.env.SMS_SECRET_KEY || '',
  smsSdkAppId: process.env.SMS_SDK_APP_ID || '',
  smsRegion: process.env.SMS_REGION || 'ap-guangzhou',
};

for (const d of [CONFIG.dataDir, CONFIG.uploadDir, path.join(CONFIG.uploadDir, 'misc')]) {
  fs.mkdirSync(d, { recursive: true });
}
