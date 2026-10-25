/* 短信通道适配层
 * 支持三种：
 *   - webhook：POST JSON 到你自己搭的转发服务（最通用，接什么短信商都行）
 *   - aliyun ：阿里云短信（Dysmsapi，RPC 签名 v1）
 *   - tencent：腾讯云短信（SMS 2021-01-11，TC3-HMAC-SHA256 签名）
 * 三者都不配时 sendSms 返回 { ok:false, reason:'notConfigured' }，由调用方决定降级行为。
 */
import crypto from 'node:crypto';
import { CONFIG } from './env.mjs';

const sha256hex = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const hmac = (key, msg, enc) => crypto.createHmac('sha256', key).update(msg, 'utf8').digest(enc);

const pctEncode = (s) => encodeURIComponent(s)
  .replace(/\+/g, '%20').replace(/\*/g, '%2A').replace(/%7E/g, '~');

/* ---------- 阿里云 ---------- */
async function sendAliyun(phone, code) {
  const params = {
    AccessKeyId: CONFIG.smsAccessKeyId,
    Action: 'SendSms',
    Format: 'JSON',
    PhoneNumbers: phone,
    RegionId: 'cn-hangzhou',
    SignName: CONFIG.smsSignName,
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: crypto.randomUUID(),
    SignatureVersion: '1.0',
    TemplateCode: CONFIG.smsTemplateCode,
    TemplateParam: JSON.stringify({ code }),
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    Version: '2017-05-25',
  };
  const canonical = Object.keys(params).sort()
    .map((k) => `${pctEncode(k)}=${pctEncode(params[k])}`).join('&');
  const toSign = `GET&${pctEncode('/')}&${pctEncode(canonical)}`;
  const sig = hmac(CONFIG.smsAccessKeySecret + '&', toSign, 'base64');
  const url = `https://dysmsapi.aliyuncs.com/?Signature=${pctEncode(sig)}&${canonical}`;
  const r = await fetch(url, { method: 'GET' });
  const j = await r.json().catch(() => ({}));
  if (j.Code !== 'OK') throw new Error(`阿里云短信失败：${j.Code || r.status} ${j.Message || ''}`);
  return true;
}

/* ---------- 腾讯云 ---------- */
async function sendTencent(phone, code) {
  const host = 'sms.tencentcloudapi.com';
  const service = 'sms';
  const action = 'SendSms';
  const version = '2021-01-11';
  const payload = JSON.stringify({
    PhoneNumberSet: [`+86${phone}`],
    SmsSdkAppId: CONFIG.smsSdkAppId,
    SignName: CONFIG.smsSignName,
    TemplateId: CONFIG.smsTemplateCode,
    TemplateParamSet: [code, '5'],
  });
  const ts = Math.floor(Date.now() / 1000);
  const date = new Date(ts * 1000).toISOString().slice(0, 10);
  const ct = 'application/json; charset=utf-8';
  const canonicalHeaders = `content-type:${ct}\nhost:${host}\n`;
  const signedHeaders = 'content-type;host';
  const canonicalRequest = ['POST', '/', '', canonicalHeaders, signedHeaders, sha256hex(payload)].join('\n');
  const scope = `${date}/${service}/tc3_request`;
  const stringToSign = ['TC3-HMAC-SHA256', String(ts), scope, sha256hex(canonicalRequest)].join('\n');
  const kDate = hmac(`TC3${CONFIG.smsSecretKey}`, date);
  const kService = hmac(kDate, service);
  const kSigning = hmac(kService, 'tc3_request');
  const signature = hmac(kSigning, stringToSign, 'hex');
  const authorization = `TC3-HMAC-SHA256 Credential=${CONFIG.smsSecretId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const r = await fetch(`https://${host}`, {
    method: 'POST',
    headers: { Authorization: authorization, 'Content-Type': ct, Host: host, 'X-TC-Action': action, 'X-TC-Version': version, 'X-TC-Timestamp': String(ts), 'X-TC-Region': CONFIG.smsRegion || 'ap-guangzhou' },
    body: payload,
  });
  const j = await r.json().catch(() => ({}));
  const st = j?.Response?.SendStatusSet?.[0];
  if (!st || st.Code !== 'Ok') throw new Error(`腾讯云短信失败：${st?.Code || r.status} ${st?.Message || ''}`);
  return true;
}

/* ---------- 通用 webhook ---------- */
async function sendWebhook(phone, code) {
  const r = await fetch(CONFIG.smsWebhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(CONFIG.smsWebhookToken ? { Authorization: `Bearer ${CONFIG.smsWebhookToken}` } : {}) },
    body: JSON.stringify({ phone, code, template: CONFIG.smsTemplateCode || '', text: `【${CONFIG.smsSignName || '我的工作台'}】验证码 ${code}，5 分钟内有效。` }),
  });
  if (!r.ok) throw new Error(`短信 webhook 失败：HTTP ${r.status}`);
  return true;
}

export function smsChannel() {
  if (CONFIG.smsWebhookUrl) return 'webhook';
  if (CONFIG.smsAccessKeyId && CONFIG.smsAccessKeySecret) return 'aliyun';
  if (CONFIG.smsSecretId && CONFIG.smsSecretKey && CONFIG.smsSdkAppId) return 'tencent';
  return '';
}

export async function sendSms(phone, code) {
  const ch = smsChannel();
  if (!ch) return { ok: false, reason: 'notConfigured' };
  try {
    if (ch === 'webhook') await sendWebhook(phone, code);
    else if (ch === 'aliyun') await sendAliyun(phone, code);
    else await sendTencent(phone, code);
    return { ok: true, channel: ch };
  } catch (e) {
    return { ok: false, reason: 'sendFailed', error: e.message };
  }
}
