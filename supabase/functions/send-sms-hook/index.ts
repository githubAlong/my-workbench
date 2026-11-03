const TENCENT_HOST = 'sms.tencentcloudapi.com';
const TENCENT_SERVICE = 'sms';
const TENCENT_VERSION = '2021-01-11';
const WEBHOOK_TOLERANCE_SECONDS = 300;

function hex(bytes: ArrayBuffer | Uint8Array) {
  const view = bytes instanceof ArrayBuffer
    ? new Uint8Array(bytes)
    : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from(view, (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
}

async function sha256(value: string) {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

async function hmacSha256(key: Uint8Array, value: string) {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(value)));
}

function decodeBase64(value: string) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalized);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function constantTimeEqual(left: string, right: string) {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (a[index % (a.length || 1)] || 0) ^ (b[index % (b.length || 1)] || 0);
  }
  return difference === 0;
}

async function verifyWebhook(request: Request, rawBody: string, secrets: string) {
  const id = request.headers.get('webhook-id') || '';
  const timestamp = request.headers.get('webhook-timestamp') || '';
  const signatures = request.headers.get('webhook-signature') || '';
  if (!id || !/^\d+$/.test(timestamp) || !signatures) return false;

  const timestampSeconds = Number(timestamp);
  if (!Number.isSafeInteger(timestampSeconds) ||
    Math.abs(Math.floor(Date.now() / 1000) - timestampSeconds) > WEBHOOK_TOLERANCE_SECONDS) {
    return false;
  }

  const signedContent = `${id}.${timestamp}.${rawBody}`;
  const suppliedSignatures = signatures.split(' ').map((signature) => signature.split(',', 2));
  for (const secret of secrets.split('|').map((value) => value.trim()).filter(Boolean)) {
    const keyText = secret.replace(/^v1,/, '').replace(/^whsec_/, '');
    let key: Uint8Array;
    try {
      key = decodeBase64(keyText);
    } catch {
      continue;
    }
    if (!key.length) continue;

    const expected = btoa(String.fromCharCode(...await hmacSha256(key, signedContent)));
    if (suppliedSignatures.some(([version, value]) =>
      version === 'v1' && !!value && constantTimeEqual(value, expected)
    )) return true;
  }
  return false;
}

function normalizePhone(phone: unknown) {
  const value = String(phone || '').trim().replace(/[\s()-]/g, '');
  return /^\+[1-9]\d{6,14}$/.test(value) ? value : '';
}

function getRequiredEnv(name: string) {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function tc3Date(timestamp: number) {
  return new Date(timestamp * 1000).toISOString().slice(0, 10);
}

async function sendTencentSms(phone: string, otp: string) {
  const secretId = getRequiredEnv('TENCENT_SECRET_ID');
  const secretKey = getRequiredEnv('TENCENT_SECRET_KEY');
  const sdkAppId = getRequiredEnv('TENCENT_SMS_SDK_APP_ID');
  const signName = getRequiredEnv('TENCENT_SMS_SIGN_NAME');
  const templateId = getRequiredEnv('TENCENT_SMS_TEMPLATE_ID');
  const region = Deno.env.get('TENCENT_REGION')?.trim() || 'ap-guangzhou';

  const payload = JSON.stringify({
    PhoneNumberSet: [phone],
    SmsSdkAppId: sdkAppId,
    SignName: signName,
    TemplateId: templateId,
    TemplateParamSet: [otp],
  });
  const timestamp = Math.floor(Date.now() / 1000);
  const date = tc3Date(timestamp);
  const action = 'SendSms';
  const contentType = 'application/json; charset=utf-8';
  const signedHeaders = 'content-type;host;x-tc-action';
  const canonicalHeaders =
    `content-type:${contentType}\nhost:${TENCENT_HOST}\nx-tc-action:${action.toLowerCase()}\n`;
  const canonicalRequest = [
    'POST',
    '/',
    '',
    canonicalHeaders,
    signedHeaders,
    await sha256(payload),
  ].join('\n');
  const credentialScope = `${date}/${TENCENT_SERVICE}/tc3_request`;
  const stringToSign = [
    'TC3-HMAC-SHA256',
    String(timestamp),
    credentialScope,
    await sha256(canonicalRequest),
  ].join('\n');

  const dateKey = await hmacSha256(new TextEncoder().encode(`TC3${secretKey}`), date);
  const serviceKey = await hmacSha256(dateKey, TENCENT_SERVICE);
  const signingKey = await hmacSha256(serviceKey, 'tc3_request');
  const signature = hex(await hmacSha256(signingKey, stringToSign));
  const authorization =
    `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const response = await fetch(`https://${TENCENT_HOST}/`, {
    method: 'POST',
    headers: {
      Authorization: authorization,
      'Content-Type': contentType,
      'X-TC-Action': action,
      'X-TC-Timestamp': String(timestamp),
      'X-TC-Version': TENCENT_VERSION,
      'X-TC-Region': region,
    },
    body: payload,
  });
  const result = await response.json().catch(() => ({}));
  const responseError = result?.Response?.Error;
  if (!response.ok || responseError) {
    console.error('Tencent Cloud SendSms API request failed', {
      status: response.status,
      code: responseError?.Code || 'HTTP_ERROR',
      requestId: result?.Response?.RequestId,
    });
    throw new Error('SMS_PROVIDER_ERROR');
  }

  const sendStatus = result?.Response?.SendStatusSet?.[0];
  if (!sendStatus || sendStatus.Code !== 'Ok') {
    console.error('Tencent Cloud SMS was not accepted', {
      code: sendStatus?.Code || 'NO_SEND_STATUS',
      requestId: result?.Response?.RequestId,
    });
    throw new Error('SMS_SEND_FAILED');
  }
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  let webhookSecret: string;
  try {
    webhookSecret = getRequiredEnv('SUPABASE_SMS_HOOK_SECRET');
  } catch (error) {
    console.error(error);
    return new Response('Hook is not configured', { status: 500 });
  }

  const rawBody = await request.text();
  try {
    if (!await verifyWebhook(request, rawBody, webhookSecret)) {
      return new Response('Invalid webhook signature', { status: 401 });
    }
  } catch (error) {
    console.error('Unable to verify Send SMS Hook signature', error);
    return new Response('Unable to verify webhook signature', { status: 401 });
  }

  let payload: { user?: { phone?: unknown }; sms?: { otp?: unknown } };
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response('Invalid JSON body', { status: 400 });
  }

  const phone = normalizePhone(payload.user?.phone);
  const otp = String(payload.sms?.otp || '').trim();
  if (!phone || !/^\d{4,10}$/.test(otp)) {
    return new Response('Invalid phone or OTP', { status: 400 });
  }

  try {
    await sendTencentSms(phone, otp);
    return new Response('{}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Send SMS Hook could not deliver SMS', error);
    return new Response('Unable to send SMS', { status: 502 });
  }
});
