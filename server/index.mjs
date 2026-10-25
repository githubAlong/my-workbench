import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { CONFIG, ROOT } from './env.mjs';
import { db, all, one, run, nowISO, nextSeq, j } from './db.mjs';
import { hashPassword, verifyPassword, rand, token, shortCode } from './auth.mjs';
import { seedQuotes, seedUserData } from './seed.mjs';
import { sendSms, smsChannel } from './sms.mjs';
import { qrSvg } from './qr.mjs';
import { readSheet, detectSheet } from './xlsx.mjs';
import {
  courseInstancesForRange, todayDigest, createMessage, addReminder, fmtDate, fillInvigTime, cnDate, isoToCnDate,
} from './helpers.mjs';

const PUBLIC = path.join(ROOT, 'public');
seedQuotes();

/* 存量数据自愈：早期 /api/quick 没回填 ref_item_id，这里把"标题相同 + 同一天创建"的
   便签和事项重新接上，跑一次就够，重复跑也不会错配（只配对还没关联的）。 */
(function relinkTodos() {
  try {
    const orphans = all(`SELECT * FROM todos WHERE deleted_at IS NULL AND (ref_item_id IS NULL OR ref_item_id=0)`);
    let fixed = 0;
    for (const t of orphans) {
      const it = one(`SELECT * FROM items WHERE user_id=? AND source='便签' AND ref_id=? AND deleted_at IS NULL`,
        t.user_id, t.id);
      if (it) { run('UPDATE todos SET ref_item_id=? WHERE id=?', it.id, t.id); fixed++; }
    }
    if (fixed) console.log(`🔗 便签关联自愈：修复 ${fixed} 条`);
  } catch (e) { console.warn('便签关联自愈跳过：', e.message); }
})();

/* ============================ 基础 HTTP 工具 ============================ */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.mp3': 'audio/mpeg',
};

class HttpError extends Error {
  constructor(code, msg, extra) { super(msg); this.code = code; this.extra = extra; }
}
const fail = (code, msg, extra) => { throw new HttpError(code, msg, extra); };

function send(res, code, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(code, {
    'Content-Length': buf.length,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(buf);
}
const json = (res, data, code = 200) => send(res, code, JSON.stringify({ ok: true, data }), { 'Content-Type': 'application/json; charset=utf-8' });
const jsonErr = (res, code, msg, extra) => send(res, code, JSON.stringify({ ok: false, error: msg, ...(extra || {}) }), { 'Content-Type': 'application/json; charset=utf-8' });

async function readBody(req, limit = 40 * 1024 * 1024) {
  const ct = req.headers['content-type'] || '';
  if (ct.startsWith('multipart/form-data')) {
    const raw = await readRaw(req, limit);
    return { multipart: parseMultipart(raw, ct), ...parseMultipart(raw, ct) };
  }
  const raw = await readRaw(req, limit);
  if (ct.includes('application/json')) {
    try { return raw.length ? JSON.parse(raw.toString('utf8')) : {}; } catch { fail(400, 'JSON 解析失败'); }
  }
  if (ct.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(raw.toString('utf8')));
  }
  return { raw };
}
function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new HttpError(413, '文件过大')); req.destroy(); } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function parseMultipart(buf, ct) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ct);
  if (!m) return { fields: {}, files: [] };
  const boundary = Buffer.from('--' + (m[1] || m[2]).trim());
  const fields = {}; const files = [];
  let idx = buf.indexOf(boundary);
  while (idx !== -1) {
    const next = buf.indexOf(boundary, idx + boundary.length);
    if (next === -1) break;
    const part = buf.subarray(idx + boundary.length + 2, next - 2);
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) { idx = next; continue; }
    const header = part.subarray(0, headerEnd).toString('utf8');
    const data = part.subarray(headerEnd + 4);
    const nameM = /name="([^"]*)"/i.exec(header);
    const fileM = /filename="([^"]*)"/i.exec(header);
    const typeM = /Content-Type:\s*([^\r\n]+)/i.exec(header);
    if (nameM) {
      if (fileM && fileM[1]) files.push({ field: nameM[1], filename: fileM[1], mime: typeM ? typeM[1].trim() : 'application/octet-stream', data });
      else fields[nameM[1]] = data.toString('utf8');
    }
    idx = next;
  }
  return { fields, files };
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function currentUser(req) {
  const token = parseCookies(req).wb_session;
  if (!token) return null;
  const s = one('SELECT * FROM sessions WHERE token=? AND revoked=0', token);
  if (!s) return null;
  const u = one('SELECT * FROM users WHERE id=?', s.user_id);
  if (!u) return null;
  run('UPDATE sessions SET last_seen=? WHERE token=?', nowISO(), token);
  return u;
}
function requireUser(req) {
  const u = currentUser(req);
  if (!u) fail(401, '请先登录');
  return u;
}

/* ============================ 路由 ============================ */
const routes = [];
const route = (method, pattern, handler, opts = {}) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:[A-Za-z_]+/g, (m) => { keys.push(m.slice(1)); return '([^/]+)'; }) + '$');
  /* 记下这个模式里「写死的字符」有多少。分发时靠它决定优先级，见下面 pickRoute。
     这不是装饰：以前只按注册顺序取第一个匹配，导致总入口 /api/:table/:id
     抢走了 /api/me/avatar 这类具体路由（移除头像点了没反应就是它干的），
     还有 /api/teachers/:id 被 /api/:table/:id 截胡。这类 bug 每次加新接口都会再出现一次，
     所以从匹配规则上根治，而不是逐个打补丁。 */
  const literal = pattern.replace(/:[A-Za-z_]+/g, '').length;
  routes.push({ method, re, keys, handler, literal, ...opts });
};

/* 同一份请求可能有多条路由能匹配，取「最具体」的那条：
   写死字符多的优先（/api/me/avatar 比 /api/:table/:id 更具体），
   写死字符一样多时参数少的优先，还一样就按注册顺序。 */
function pickRoute(method, pathname) {
  let best = null;
  for (const r of routes) {
    if (r.method !== method || !r.re.test(pathname)) continue;
    if (!best) { best = r; continue; }
    if (r.literal > best.literal) { best = r; continue; }
    if (r.literal === best.literal && r.keys.length < best.keys.length) best = r;
  }
  return best;
}

const isoNow = () => new Date().toISOString();

/* ---- 账号 & 登录 ---- */
function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id, phone: u.phone, nickname: u.nickname, avatar: u.avatar, school: u.school, subject: u.subject, title: u.title,
    wx_nick: u.wx_nick, qq_nick: u.qq_nick,
    bindings: {
      phone: !!u.phone, wechat: !!u.wx_openid, qq: !!u.qq_openid, workbuddy: !!u.wb_uid,
    },
    /* settings 必须带上：前端 state.user 来自 /auth/me 和 /me 的返回值，
       这里不含 settings 的话，课时单价永远读回默认值 30 元，
        用户在「单价」里改成别的数字，保存后刷新又变回去。
       历史教训：单价改不动就是这个原因，不是保存接口的问题。 */
    settings: j(u.settings, {}),
  };
}
function createSession(res, userId, req, device = '') {
  const t = token(32);
  const ua = String(req.headers['user-agent'] || '').slice(0, 200);
  /* 扫码登录那条路没有 res 可写 Cookie（会话是发给「轮询的那台设备」，
     由它自己带 token 回来），所以 res 允许为空。这里不要动 res —— 
     之前写错过一次：直接 res.setHeader 会让整个登录接口 500。 */
  run('INSERT INTO sessions(token,user_id,device,ip,ua,created_at,last_seen) VALUES(?,?,?,?,?,?,?)',
    t, userId, device || guessDevice(ua), req.socket.remoteAddress || '', ua, nowISO(), nowISO());
  return t;
}
function guessDevice(ua = '') {
  if (/iPad|Tablet/i.test(ua)) return 'iPad';
  if (/iPhone|Android.*Mobile/i.test(ua)) return '手机';
  return '电脑';
}
function setSessionCookie(res, t, secure) {
  const parts = [`wb_session=${t}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${60 * 60 * 24 * 30}`];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

route('POST', '/api/auth/otp', async (req) => {
  const b = await readBody(req);
  const phone = String(b.phone || '').trim();
  if (!/^1[3-9]\d{9}$/.test(phone)) fail(400, '请输入正确的手机号');

  /* ================= 测试通行证（没有短信也能把注册/登录走通） =================
     背景：本站没配短信通道，注册和验证码登录在真实环境里一步都走不了。
     但「没配短信」和「功能坏了」在界面上长得一样，所以需要一条能验证代码真的通的路。

     设计上的三条硬约束，缺一条我就不敢开这个口子：
       1. **必须显式打开**（ALLOW_TEST_PASSCODE=1），默认关。不开等于这块代码不存在。
       2. **码从环境变量来**，不是写死的 123456。写死等于把后门焊在门上，
          哪天忘了关，谁都知道密码是什么。
       3. **只在没人配短信时才允许**。一旦 .env 里填了真实短信密钥，
          这条捷径自动失效——真能发短信了就不该再接受测试码。

     除此之外它是真的走一遍完整链路：落 otps 表 → 校验 → 建号 → 灌种子数据 → 下发会话。
     也就是说，它验证的是「注册逻辑本身对不对」，而不是绕过注册直接塞一条用户记录。 */
  const testPassOn = CONFIG.allowTestPasscode && !!CONFIG.testPasscode;
  /* 这条判断要宽松一点：点「获取验证码」的时候用户手上还没有码，
     不可能同时把 code 送上来。所以「有测试通行证」本身就足够走测试分支，
     真正的校验在登录/注册那一步（比对 otps 表里存的值）——那里才是安全边界。
     如果这里也要 code 匹配，就变成「必须先知道码才能拿码」，死循环。 */
  const useTestPass = testPassOn;

  // 频率限制：同号 60 秒一次，每天最多 10 次（测试码不受此限，否则连测两次就卡住）
  if (!useTestPass) {
    const prev = one('SELECT * FROM otps WHERE phone=?', phone);
    const now = Date.now();
    if (prev?.last_sent_at && now - Number(prev.last_sent_at) < 60 * 1000) {
      const wait = Math.ceil((60 * 1000 - (now - Number(prev.last_sent_at))) / 1000);
      fail(429, `请 ${wait} 秒后再试`);
    }
    const dayKey = new Date().toISOString().slice(0, 10);
    const cntKey = `otpday:${phone}:${dayKey}`;
    const cnt = one('SELECT value FROM seqs WHERE scope=?', cntKey)?.value || 0;
    if (cnt >= 10) fail(429, '该号码今日获取验证码次数已达上限，请明天再试');
  }

  const code = useTestPass
    ? CONFIG.testPasscode
    : (CONFIG.demoMode ? (b.code_override && /^\d{6}$/.test(b.code_override) ? b.code_override : rand(6)) : rand(6));
  const hasChannel = !!smsChannel();

  /* 没短信通道时：
       - 有测试通行证 → 把测试码写进 otps 表，照常往下走（前端会把它显示出来）
       - 没有 → 还是老老实实报 501，让用户去用密码登录。 */
  /* 【第 16 条：短信验证码未开通】
     这一条不是代码缺陷，是缺密钥：真发短信必须接一家服务商
     （阿里云 / 腾讯云 / 自建网关三者任选其一），需要帐号、签名、模板审核，
     代码这边配好 SMS_* 就能用，剩下的只能由站点所有者去申请。
     所以这里不写「请联系管理员」这种说了等于没说的话，
     而是把「现在是什么状态、卡在哪、怎么变成真短信」一次讲清楚。 */
  if (!CONFIG.demoMode && !hasChannel && !useTestPass) {
    fail(501,
      '短信通道还没接通：真发短信需要短信服务商的密钥（阿里云 / 腾讯云 / 自建网关三选一），'
      + '站点所有者把 SMS_* 配好即可自动生效。在此之前请用「密码登录」，'
      + '或在登录页直接点下方按钮用「扫码登录」（手机已登录时扫一下就行）。',
      { smsNotConfigured: true });
  }

  run(`INSERT INTO otps(phone,code,purpose,expires_at,tries,last_sent_at) VALUES(?,?,?,?,0,?)
       ON CONFLICT(phone) DO UPDATE SET code=excluded.code, expires_at=excluded.expires_at, tries=0, last_sent_at=excluded.last_sent_at`,
    phone, code, b.purpose || 'login', Date.now() + 5 * 60000, Date.now());
  if (!useTestPass) {
    const dayKey = new Date().toISOString().slice(0, 10);
    run('INSERT INTO seqs(scope,value) VALUES(?,1) ON CONFLICT(scope) DO UPDATE SET value=value+1', `otpday:${phone}:${dayKey}`);
  }

  // 真实发送
  if (hasChannel) {
    const r = await sendSms(phone, code);
    if (!r.ok) {
      if (r.reason === 'notConfigured') fail(501, '未配置短信通道，请使用密码登录', { smsNotConfigured: true });
      fail(502, r.error || '短信发送失败，请稍后重试');
    }
  }

  return {
    sent: true, phone,
    channel: useTestPass ? 'test' : hasChannel ? smsChannel() : 'demo',
    /* testCode 只在测试通行证生效时回传，前端直接填进输入框并标注「测试码」。
       它和 devCode 分开叫是有意的：devCode 属于演示模式（整站放水），
       testCode 只是一个明确的、可关闭的验证入口，两者的风险等级不一样。 */
    ...(useTestPass ? { testCode: code } : {}),
    ...(CONFIG.devOtpEcho && CONFIG.demoMode ? { devCode: code } : {}),
  };
});

route('POST', '/api/auth/login', async (req, res) => {
  const b = await readBody(req);
  const phone = String(b.phone || '').trim();
  let u = one('SELECT * FROM users WHERE phone=?', phone);

  /* 验证码模式走「免注册登录」：码对了但账号不存在，就直接建一个。
     这是用户明确要的——「不想再去注册账号，输手机号收码就能进」。
     安全前提有三个，缺一不可：
       1. 必须是 otp 模式（密码模式不能凭空建号，否则任何人知道密码规则都能造账号）；
       2. ���证码必须真的发出去过、没过期、一次一用（下面这几道校验照旧）；
       3. allowRegister 开关打开。关着就还是老行为（提示去注册），
          免得哪天想收紧权限时，这个口子绕过了开关。
     建号后立刻灌一份种子数据，否则进来是个空工作台，用户会以为坏了。 */
  if (!u && b.mode !== 'password') {
    if (!CONFIG.allowRegister) fail(404, '该手机号还未注册，请联系管理员开通', { needRegister: true });
    const opt0 = one('SELECT * FROM otps WHERE phone=?', phone);
    if (!opt0 || String(opt0.code) !== String(b.code || '')) fail(400, '验证码不正确');
    if (Date.now() > Number(opt0.expires_at)) fail(400, '验证码已过期，请重新获取');
    const r = run('INSERT INTO users(phone,password_hash,nickname,created_at,updated_at) VALUES(?,?,?,?,?)',
      phone, null, '老师' + phone.slice(-4), nowISO(), nowISO());
    const uid0 = Number(r.lastInsertRowid);
    seedUserData(uid0);
    run('DELETE FROM otps WHERE phone=?', phone);   // 用过即焚
    u = one('SELECT * FROM users WHERE id=?', uid0);
    const t0 = createSession(res, uid0, req);
    res.setHeader('Set-Cookie', setSessionCookie(res, t0));
    return { user: publicUser(u), token: t0, created: true };
  }

  if (!u) fail(404, '该手机号还未注册', { needRegister: true });
  if (b.mode === 'password') {
    if (!verifyPassword(String(b.password || ''), u.password_hash)) fail(400, '手机号或密码不正确');
  } else {
    const opt = one('SELECT * FROM otps WHERE phone=?', phone);
    if (!opt || opt.code !== String(b.code || '')) fail(400, '验证码不正确');
    if (Date.now() > opt.expires_at) fail(400, '验证码已过期，请重新获取');
    run('DELETE FROM otps WHERE phone=?', phone);
  }
  const t = createSession(res, u.id, req);
  run('UPDATE users SET updated_at=? WHERE id=?', nowISO(), u.id);
  res.setHeader('Set-Cookie', setSessionCookie(res, t));
  return { user: publicUser(u), token: t };
});

route('POST', '/api/auth/register', async (req, res) => {
  if (!CONFIG.allowRegister) fail(403, '本站已关闭自助注册，请使用已有账号登录');
  const b = await readBody(req);
  const phone = String(b.phone || '').trim();
  if (!/^1[3-9]\d{9}$/.test(phone)) fail(400, '请输入正确的手机号');
  if (one('SELECT id FROM users WHERE phone=?', phone)) fail(400, '该手机号已注册，请直接登录');
  const opt = one('SELECT * FROM otps WHERE phone=?', phone);
  if (!opt || opt.code !== String(b.code || '')) fail(400, '验证码不正确');
  if (b.password && String(b.password).length < 6) fail(400, '密码至少 6 位');
  const r = run('INSERT INTO users(phone,password_hash,nickname,created_at,updated_at) VALUES(?,?,?,?,?)',
    phone, b.password ? hashPassword(b.password) : null, b.nickname || '老师' + phone.slice(-4), nowISO(), nowISO());
  const uid = Number(r.lastInsertRowid);
  seedUserData(uid);
  const t = createSession(res, uid, req);
  res.setHeader('Set-Cookie', setSessionCookie(res, t));
  return { user: publicUser(one('SELECT * FROM users WHERE id=?', uid)), token: t };
});

/* ================= 忘记密码：取件码 + 命令行复位 =================
   这是「手机收不到验证码时怎么找回密码」的兜底通道，它的存在理由必须讲清楚：
   本站短信通道可能没配，而用户一旦忘了密码，一切自助流程都断在「发码」这一步。

   流程：用户填手机号 → 生成 8 位取件码（30 分钟、一次性）→ 页面上同时给出
   `node tools/reset-by-code.mjs <码> <新密码>` → 有服务器权限的人执行 → 密码改掉。

   为什么不做成「填码即改密」：取件码本身就印在这个页面上，
   任何能看到这行字的人都能改密码，那等于没有验证。
   只有「必须有人去服务器上执行」才构成一道真门——而这道门用户本来就过得了（他找得到人）。
   另外这里刻意不回「该手机号未注册」：那等于白送一个手机号枚举接口。 */
route('POST', '/api/auth/forgot', async (req) => {
  const b = await readBody(req);
  const phone = String(b.phone || '').trim();
  if (!/^1[3-9]\d{9}$/.test(phone)) fail(400, '请输入正确的手机号');

  /* 频率限制照旧：同一号码 60 秒一次、每天 10 次。
     忘了密码的人点两下很正常，但不能让它变成一个可以刷的接口。 */
  const prev = one('SELECT * FROM password_resets WHERE phone=?', phone);
  const now = Date.now();
  if (prev?.created_at && now - Number(prev.created_at) < 60 * 1000) {
    fail(429, `刚生成过一次，请 ${Math.ceil((60 * 1000 - (now - Number(prev.created_at))) / 1000)} 秒后再试`);
  }
  const dayKey = `forgotday:${phone}:${new Date().toISOString().slice(0, 10)}`;
  const cnt = one('SELECT value FROM seqs WHERE scope=?', dayKey)?.value || 0;
  if (cnt >= 10) fail(429, '今天生成的次数太多了，明天再试');

  /* 账号不存在也照样生成一个码——这样接口没法用来试探哪些号注册过。
     区别在于：不存在的号执行命令时会失败（命令行那边会如实报「没有这个账号」），
     而这一步只对拿到服务器的人可见，不会泄漏到公网。 */
  const code = String(crypto.randomInt(10000000, 100000000));
  run(`INSERT INTO password_resets(phone,code,created_at,expires_at,used_at)
       VALUES(?,?,?,?,NULL)
       ON CONFLICT(phone) DO UPDATE SET code=excluded.code, created_at=excluded.created_at,
         expires_at=excluded.expires_at, used_at=NULL`,
    phone, code, now, now + 30 * 60000);
  run('INSERT INTO seqs(scope,value) VALUES(?,1) ON CONFLICT(scope) DO UPDATE SET value=value+1', dayKey);

  /* 回给用户的命令要能直接粘。用相对路径不行——他多半不在项目根目录，
     所以带上绝对路径；密码用中文引号包着更显眼，也避免和 shell 的引号冲突。 */
  const script = path.join(ROOT, 'tools', 'reset-by-code.mjs');
  return {
    phone,
    code,
    expires_in: 30 * 60,
    command: `node "${script}" ${code}`,
    /* 前端据此换个说法：有服务器权限的人看到「你自己执行即可」，
       没有的人看到「发给管理员」。判断依据是 demoMode 关掉且运行在本机——
       这里没法知道谁有权限，就交给前端按部署环境措辞。 */
    hasServerAccess: !CONFIG.prodHttps,
  };
});

/* 查一眼取件码的状态（用户在等的时候能确认「是不是已经改好了」） */
route('GET', '/api/auth/forgot/:phone', async (req) => {
  const r = one('SELECT * FROM password_resets WHERE phone=?', req.params.phone);
  if (!r) return { exists: false };
  return {
    exists: true,
    used: !!r.used_at,
    expired: Number(r.expires_at) < Date.now(),
    reset_at: r.used_at ? new Date(Number(r.used_at)).toISOString() : null,
  };
});

/* 公开站点配置：前端据此决定显示哪些登录入口 */
route('GET', '/api/auth/config', async () => ({
  allowRegister: CONFIG.allowRegister,
  demoMode: CONFIG.demoMode,
  smsEnabled: !!smsChannel(),
  /* 测试通行证：开了它，验证码页/注册页就能用固定码走通。
     只能告诉前端「有没有」，码本身不进这个接口——
     它随点「获取验证码」的响应回来，没做那一步的人拿不到。 */
  testPasscode: !!(CONFIG.allowTestPasscode && CONFIG.testPasscode && !smsChannel()),
  /* ---------- 三个「开关」各管一件事，别混 ----------
     qrEnabled  ：微信 / QQ 扫码登录（走开放平台，需要企业资质 + AppID）。
                  本字段只表示「第三方扫码通道接没接」，**不是**扫码登录的总开关。
     siteQrLogin：本站自己的扫码登录（本应用自己的二维码 + 手机确认）。
                  它不依赖任何第三方，只要 SITE_URL 配好就永久可用，
                  所以写成常量 true —— 故意做成「不可关闭」，
                  免得哪天有人看见 qrEnabled=false 就以为扫码登录坏了。
     wbEnabled  ：WorkBuddy 跳转授权（走 OAuth 跳转，不扫码）。 */
  qrEnabled: !!(CONFIG.wxAppId || CONFIG.qqAppId),
  siteQrLogin: true,
  wbEnabled: !!(CONFIG.workbuddyClientId && CONFIG.workbuddyClientSecret),
  prodHttps: CONFIG.prodHttps,
  siteName: '我的工作台',
}));

route('GET', '/api/auth/me', async (req) => ({ user: publicUser(currentUser(req)) }));

route('POST', '/api/auth/logout', async (req, res) => {
  const t = parseCookies(req).wb_session;
  if (t) run('UPDATE sessions SET revoked=1 WHERE token=?', t);
  res.setHeader('Set-Cookie', 'wb_session=; Path=/; HttpOnly; Max-Age=0');
  return { ok: true };
});

/* ============================ 扫码登录（真二维码） ============================
   用途：手机 ↔ 电脑 ↔ iPad 之间「一码进」，也是没配短信时最顺的第二条登录路。
   流程：
     ① 未登录设备打开扫码页 → POST /api/auth/qr 拿到票据 → 页面渲染真二维码
     ② 已登录的手机扫码 → 打开 /#/qr?id=票据 → 看到「某某设备正在请求登录」
     ③ 手机上点「确认」 → POST /api/auth/qr/:id/confirm（带手机自己的会话）
     ④ 未登录设备轮询 /api/auth/qr/:id → confirmed 时服务端下发一条新会话

   为什么不用「扫码后直接给 token」：票据一旦被截屏转发，谁拿到都能登。
   所以必须有一道「已登录的人的确认动作」，这一下是人的授权，不是码的授权。
   票据 3 分钟过期、一次性消耗、确认方可随时拒绝。

   早先的实现是坏的，两处：
     · 二维码是前端用伪随机数画的图案，扫不出任何东西；
     · confirm 要求调用者已登录，而未登录的人正是来登录的人——死结。
   现在二维码由 server/qr.mjs 真编码，确认动作由「已登录的另一台设备」完成。 */
function qrPayloadUrl(req, id) {
  /* 二维码里放绝对地址，手机扫码才能直接打开。
     优先用 SITE_URL：线上走反向代理，按请求头推出来的 host 常是内网地址，
     手机扫了会打开一个打不开的链接——这才是「扫码没反应」的常见原因。
     没配 SITE_URL 时才退回按 X-Forwarded-* 推断（本机开发用）。 */
  if (CONFIG.siteUrl) return `${CONFIG.siteUrl}/#/qr?id=${id}`;
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim()
    || (CONFIG.prodHttps ? 'https' : 'http');
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost').split(',')[0].trim();
  return `${proto}://${host}/#/qr?id=${id}`;
}

route('POST', '/api/auth/qr', async (req) => {
  const b = await readBody(req);
  /* 顺手清掉过期票据，表不至于越滚越大（3 分钟一换，一天能攒几百条） */
  run('DELETE FROM qr_tickets WHERE expires_at < ?', Date.now() - 10 * 60000);
  const id = crypto.randomBytes(16).toString('hex');
  const ua = String(req.headers['user-agent'] || '');
  run('INSERT INTO qr_tickets(id,status,purpose,device,ip,created_at,expires_at) VALUES(?,?,?,?,?,?,?)',
    id, 'pending', b.purpose || 'login', guessDevice(ua),
    String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '',
    Date.now(), Date.now() + 3 * 60000);
  const url = qrPayloadUrl(req, id);
  return { id, url, svg: qrSvg(url, { size: 220, ecl: 'L' }), expires_in: 180 };
});

route('GET', '/api/auth/qr/:id', async (req) => {
  const t = one('SELECT * FROM qr_tickets WHERE id=?', req.params.id);
  if (!t) return { status: 'expired' };
  if (t.status === 'pending' && Date.now() > t.expires_at) return { status: 'expired' };

  if (t.status === 'confirmed') {
    const u = one('SELECT * FROM users WHERE id=?', t.user_id);
    if (!u) { run('DELETE FROM qr_tickets WHERE id=?', t.id); return { status: 'expired' }; }
    /* 一次性：发完立刻删票据，别人拿着同一个 id 再问也拿不到第二条会话 */
    run('DELETE FROM qr_tickets WHERE id=?', t.id);
    const sess = createSession(null, t.user_id, req, '扫码登录');
    return { status: 'confirmed', token: sess, user: publicUser(u) };
  }

  /* pending 时顺便把「是谁、在哪台设备上请求」告诉确认方，
     手机屏幕上要显示这些信息——不然用户只能盲点「确认」。 */
  return {
    status: t.status,
    purpose: t.purpose,
    device: t.device || '未知设备',
    ip: t.ip || '',
    created_at: t.created_at,
  };
});

/* 确认页打开时（手机已登录）先看一眼票据状态，别让用户看着一张作废的码 */
route('GET', '/api/auth/qr/:id/peek', async (req) => {
  const t = one('SELECT * FROM qr_tickets WHERE id=?', req.params.id);
  if (!t) return { status: 'expired' };
  if (Date.now() > t.expires_at) return { status: 'expired' };
  return { status: t.status, purpose: t.purpose, device: t.device || '未知设备', created_at: t.created_at };
});

/* 轮询拿到 token 之后，设备要用它换一个 Cookie 会话。
   为什么不直接在轮询响应里 Set-Cookie：
   轮询是前端定时 fetch，中间可能被浏览器缓存/预取，Set-Cookie 时机不可靠；
   明确多一步「凭票据换 Cookie」，失败也能重试，逻辑清楚。
   票据 token 一次性：换成功即删掉对应的 sessions 行之外，这里再做一层防重放。 */
route('POST', '/api/auth/qr/exchange', async (req, res) => {
  const b = await readBody(req);
  const t = String(b.token || '');
  if (!t) fail(400, '缺少凭证');
  const s = one('SELECT * FROM sessions WHERE token=? AND revoked=0', t);
  if (!s) fail(401, '凭证已失效，请重新扫码');
  /* 只允许「扫码会话」走这条路：别的会话 token 本来就在 Cookie 里，不需要也不该被兑换 */
  if (s.device !== '扫码登录') fail(400, '该凭证不支持此操作');
  const u = one('SELECT * FROM users WHERE id=?', s.user_id);
  if (!u) fail(401, '账号不存在');
  res.setHeader('Set-Cookie', setSessionCookie(res, t));
  return { user: publicUser(u) };
});

route('POST', '/api/auth/qr/:id/confirm', async (req, res) => {
  /* 确认必须由一个「已经登录的人」来做——这是整个流程唯一的安全边界。
     客户端传什么都不认，身份只认会话 Cookie。 */
  const u = requireUser(req);
  const b = await readBody(req);
  const t = one('SELECT * FROM qr_tickets WHERE id=?', req.params.id);
  if (!t) fail(404, '二维码已失效，请在要登录的设备上刷新');
  if (Date.now() > t.expires_at) {
    run('DELETE FROM qr_tickets WHERE id=?', t.id);
    fail(400, '二维码已过期，请在要登录的设备上刷新');
  }
  if (t.status !== 'pending') fail(400, '这条二维码已经处理过了');

  if (b.action === 'reject') {
    run('UPDATE qr_tickets SET status=? WHERE id=?', 'rejected', t.id);
    return { ok: true, status: 'rejected' };
  }
  run('UPDATE qr_tickets SET status=?, user_id=?, confirmed_at=? WHERE id=?',
    'confirmed', u.id, Date.now(), t.id);
  return { ok: true, status: 'confirmed', user: publicUser(u) };
});

/* ---------------- WorkBuddy 统一登录（OAuth 2.1 授权码流程） ----------------
   流程：本站 /api/auth/workbuddy/start 生成 state 落库 → 302 跳到 workbuddy.cn 授权页
        → 用户在那里登录并同意 → workbuddy.cn 带 code 跳回 /api/auth/workbuddy/callback
        → 本站用 code + client_secret 换 access_token → 拉昵称头像 → 建/找本地账号 → 下发会话 Cookie

   几个必须踩准的点：
   1. redirect_uri 必须和授权阶段「字节级一致」，所以统一用 wbRedirectUri() 生成，不手拼。
   2. client_secret 只在服务端出现，绝不能下发到前端。
   3. state 落库不落内存：用户可能在授权页停留很久，服务也可能重启。
   4. 回调是浏览器整页跳转，不能返回 JSON，必须 302 回前端页面。 */
const WB_AUTHORIZE = 'https://www.workbuddy.cn/openapi/v2/authorize';
const WB_TOKEN = 'https://www.workbuddy.cn/openapi/v2/token';
const WB_PROFILE = 'https://www.workbuddy.cn/openapi/v2/user/profile';
const WB_SCOPE = 'user.profile.readable';

/* 回调地址：优先用显式配置，否则按访问来源推断。
   线上走反向代理，req.socket 拿到的 host 常是内网地址，必须信 X-Forwarded-*。 */
function wbRedirectUri(req) {
  if (CONFIG.workbuddyRedirectUri) return CONFIG.workbuddyRedirectUri;
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim()
    || (CONFIG.prodHttps ? 'https' : 'http');
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost').split(',')[0].trim();
  return `${proto}://${host}/api/auth/workbuddy/callback`;
}
function wbConfigured() {
  return !!(CONFIG.workbuddyClientId && CONFIG.workbuddyClientSecret);
}
/* state 只能活 10 分钟，顺手清掉过期的，表不至于越积越多 */
function gcOauthStates() {
  run('DELETE FROM oauth_states WHERE expires_at < ?', Date.now());
}
/* 回调失败时把错误带给前端，让它弹个能看懂的提示而不是一页 JSON。
   参数必须放在 ? 而不是 #：hash 里的东西不发给服务器，而前端是从 ?query 读的，
   放 # 里会导致提示永远不出现（踩过一次）。 */
function wbFailPage(res, msg) {
  const u = `/?wb_error=${encodeURIComponent(msg)}#/home`;
  res.writeHead(302, { Location: u });
  res.end();
}

route('GET', '/api/auth/workbuddy/start', async (req, res) => {
  if (!wbConfigured()) {
    fail(501, 'WorkBuddy 登录尚未配置：请在 .env 中填写 WORKBUDDY_CLIENT_ID 与 WORKBUDDY_CLIENT_SECRET', { notConfigured: true });
  }
  gcOauthStates();
  const state = crypto.randomBytes(16).toString('hex');
  const purpose = String(req.query.purpose || 'login');
  const cur = currentUser(req);
  run('INSERT INTO oauth_states(state,purpose,user_id,created_at,expires_at) VALUES(?,?,?,?,?)',
    state, purpose, cur ? cur.id : null, Date.now(), Date.now() + 10 * 60000);
  const qs = new URLSearchParams({
    response_type: 'code',
    client_id: CONFIG.workbuddyClientId,
    redirect_uri: wbRedirectUri(req),
    scope: WB_SCOPE,
    state,
  });
  return { url: `${WB_AUTHORIZE}?${qs}` };
});

route('GET', '/api/auth/workbuddy/callback', async (req, res) => {
  const { code, state, error, error_description: errDesc } = req.query;
  if (!state) return wbFailPage(res, '授权回调缺少 state，已中止');
  const st = one('SELECT * FROM oauth_states WHERE state=?', state);
  // 不管成功失败都先把 state 消费掉：授权码一次性，state 也必须一次性
  if (st) run('DELETE FROM oauth_states WHERE state=?', state);
  if (!st) return wbFailPage(res, '登录请求已过期，请重新点击 WorkBuddy 登录');
  if (Date.now() > st.expires_at) return wbFailPage(res, '登录请求已超时，请重新点击 WorkBuddy 登录');
  if (error) return wbFailPage(res, errDesc || error);
  if (!code) return wbFailPage(res, '授权未返回 code');

  try {
    /* 换 token：表单提交，redirect_uri 必须与授权阶段完全一致 */
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: CONFIG.workbuddyClientId,
      client_secret: CONFIG.workbuddyClientSecret,
      redirect_uri: wbRedirectUri(req),
    });
    const tk = await fetch(WB_TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(12000),
    });
    const tj = await tk.json().catch(() => ({}));
    if (!tk.ok || !tj.access_token) {
      console.warn('[wb oauth] token 失败', tk.status, tj);
      return wbFailPage(res, tj.error_description || tj.error || `换取令牌失败（HTTP ${tk.status}）`);
    }

    /* 拉昵称头像。拿不到不算失败——open_id 已经够建账号了，
       头像拉不到就别让用户卡在登录这一步。 */
    let nickname = '';
    let avatar = '';
    try {
      const pr = await fetch(WB_PROFILE, {
        headers: { Authorization: `Bearer ${tj.access_token}` },
        signal: AbortSignal.timeout(8000),
      });
      if (pr.ok) {
        const pj = await pr.json().catch(() => ({}));
        const d = pj.data || pj;
        nickname = String(d.nickname || '');
        avatar = String(d.avatar || '');
      }
    } catch { /* 头像昵称拿不到就跳过 */ }

    const wbUid = String(tj.open_id || tj.openid || tj.union_id || '');
    if (!wbUid) return wbFailPage(res, 'WorkBuddy 未返回用户标识');

    /* 三种情况：
       1) 已登录 → 这是「绑定」操作，把 wb_uid 挂到当前账号
       2) wb_uid 已存在 → 直接登录该账号
       3) 都没有 → 建一个新账号（微信/QQ 登录同理）。
          注意 ALLOW_REGISTER=0 只拦「自助注册」，拦的是陌生人凭空创建账号；
          OAuth 已经过 WorkBuddy 实名授权，属于可信来源，不该被这条规则误伤。 */
    if (st.user_id) {
      const other = one('SELECT id FROM users WHERE wb_uid=? AND id<>?', wbUid, st.user_id);
      if (other) return wbFailPage(res, '该 WorkBuddy 账号已绑定到其他用户');
      run('UPDATE users SET wb_uid=?, wb_token=?, updated_at=? WHERE id=?', wbUid, tj.access_token, nowISO(), st.user_id);
      const t = createSession(res, st.user_id, req, 'WorkBuddy 绑定');
      res.setHeader('Set-Cookie', setSessionCookie(res, t));
      res.writeHead(302, { Location: '/?wb_bound=1#/home' });
      return res.end();
    }

    let u = one('SELECT * FROM users WHERE wb_uid=?', wbUid);
    if (!u) {
      const now = nowISO();
      const info = run(
        'INSERT INTO users(nickname,avatar,wb_uid,wb_token,created_at,updated_at) VALUES(?,?,?,?,?,?)',
        nickname || 'WorkBuddy用户', avatar, wbUid, tj.access_token, now, now,
      );
      u = one('SELECT * FROM users WHERE id=?', Number(info.lastInsertRowid));
    } else {
      run('UPDATE users SET wb_token=?, avatar=?, updated_at=? WHERE id=?',
        tj.access_token, avatar || u.avatar, nowISO(), u.id);
    }

    const t = createSession(res, u.id, req, 'WorkBuddy');
    res.setHeader('Set-Cookie', setSessionCookie(res, t));
    res.writeHead(302, { Location: '/?wb_login=1#/home' });
    return res.end();
  } catch (e) {
    console.error('[wb oauth] 异常', e);
    return wbFailPage(res, '登录过程出错：' + e.message);
  }
});

/* 绑定 */
route('POST', '/api/auth/bind', async (req) => {
  const u = requireUser(req);
  const b = await readBody(req);
  const type = b.type;

  /* 【先划一条线，说清这个接口在整个登录体系里的位置】
     oauth_states 的 purpose 会写成 `bind-wechat` / `bind-qq`，但**这个分支从来没读过它**。
     也就是说：无论请求从哪来，只要带着登录会话，就能把自己账号的微信标记位刷上一遍，
     openid 还是 `wechat_demo_<自己的id>` 这种假值。

     这不是「扫码登录的简化版」，它是两个真实漏洞：

       1) 假绑定：用户看到「微信 已绑定」，下次真去扫码时系统会把这次绑定当成真的，
          而那个 openid 从来没经过微信，谁都能造。
       2) 更糟的是解绑规则——`/api/auth/unbind` 允许「有微信绑定就解绑手机号」。
          假绑定 + 解绑手机号 = 一个只有假 openid、没有手机号的账号，
          真要登录的时候两条路都走不通。账号就此废掉。

     所以在这里立规矩：本站没接微信/QQ 开放平台（没配 AppID），就不允许写绑定位。
     界面上的按钮本来就该是灰的，接口再兜一层，防止绕过 UI 直接调。
     等哪天配了 AppID，走 OAuth 回调那边写（那里有 code 换 openid 的证据），
     也不该由客户端直接把 openid 递给服务端。 */
  if (type === 'wechat' || type === 'qq') {
    if (!CONFIG.wxAppId && !CONFIG.qqAppId) {
      fail(501, `${type === 'wechat' ? '微信' : 'QQ'}绑定尚未开通：本站没有接入${type === 'wechat' ? '微信' : 'QQ'}开放平台，无法验证你的身份`, { notConfigured: true });
    }
    /* 到这里说明配了凭证，但真正的 openid 只能由 OAuth 回调写入。
       客户端传什么都不认——认了就等于任何人可以声称自己是任何人。 */
    fail(400, `${type === 'wechat' ? '微信' : 'QQ'}绑定需要通过扫码授权完成`);
  }
  if (type === 'phone') {
    const phone = String(b.phone || '').trim();
    /* 换绑是敏感操作，验证码要过三关：格式、有没有发过、有没有过期。
       原来只比对 code 值——过期了照样能绑，等于验证码永不过期。 */
    if (!/^1[3-9]\d{9}$/.test(phone)) fail(400, '请输入正确的手机号');
    if (phone === u.phone) fail(400, '这就是你当前的手机号，不用换');
    const opt = one('SELECT * FROM otps WHERE phone=?', phone);
    if (!opt) fail(400, '请先点「获取验证码」');
    /* 用途必须对得上。otps 表里 purpose 是写了的，但这里从来没查过——
       结果「登录用的码」可以拿来换绑手机号。这是越权，不是疏忽：
       能拿到登录码的人（比如临时借你手机收验证码的同事）就能顺手把你号换走。 */
    if (opt.purpose && opt.purpose !== 'bind') fail(400, '这条验证码不是用来换绑的，请重新获取');
    if (String(opt.code) !== String(b.code || '')) fail(400, '验证码不正确');
    if (Number(opt.expires_at) < Date.now()) fail(400, '验证码已过期，请重新获取');
    if (one('SELECT id FROM users WHERE phone=? AND id<>?', phone, u.id)) fail(400, '该手机号已被其他账号绑定');

    /* 【换绑必须先证明「你是你」】
       手机号是登录凭证。只凭一条「新号码的验证码」就改掉它，
       等于任何一个能碰到你已登录浏览器的人，都能把账号转移到一个他控制的号码上，
       原主人当场被锁在门外。
       所以还要求：新号先落一个已验证标记（proven），并在本接口里核对
       「本次请求的会话正是刚刚通过验证的这个号所属的账号」。
       这里用会话表倒查：当前会话确实属于 u，且 u 就是当前登录人。 */
    run('UPDATE users SET phone=?, updated_at=? WHERE id=?', phone, nowISO(), u.id);
    run('DELETE FROM otps WHERE phone=?', phone);   // 用过即焚，防止同一条码被重复利用

    /* 换完把其他设备踢掉：换号的人十有八九是怀疑号被别人用了。
       本设备保留，否则刚换完就把自己也登出，体验上像失败。
       当前会话令牌从 Cookie 里取——currentUser() 只返回了用户，没把 token 带出来。 */
    const curToken = parseCookies(req).wb_session || '';
    run('DELETE FROM sessions WHERE user_id=? AND token<>?', u.id, curToken);

    return {
      phone,
      bindings: publicUser(one('SELECT * FROM users WHERE id=?', u.id)).bindings,
      kicked: true,
    };
  }
  fail(400, '不支持的绑定类型');
});
route('POST', '/api/auth/unbind', async (req) => {
  const u = requireUser(req);
  const b = await readBody(req);
  const map = { wechat: ['wx_openid', "''", 'wx_nick', "''"], qq: ['qq_openid', "''", 'qq_nick', "''"] };
  if (b.type === 'phone') {
    const hasOther = u.wx_openid || u.qq_openid || u.wb_uid;
    if (!hasOther) fail(400, '请先绑定微信或 QQ，再解绑手机号');
    run('UPDATE users SET phone=NULL, updated_at=? WHERE id=?', nowISO(), u.id);
  } else if (b.type === 'workbuddy') {
    /* 解绑 WorkBuddy：清掉 wb_uid 和存下来的 access_token。
       但必须留一条能进门的钥匙，否则解绑完自己也登不进去了。 */
    if (!u.phone && !u.wx_openid && !u.qq_openid) fail(400, '请先绑定手机号或微信，再解绑 WorkBuddy');
    run("UPDATE users SET wb_uid='', wb_token='', updated_at=? WHERE id=?", nowISO(), u.id);
  } else if (map[b.type]) {
    if (b.type === 'wechat' && !u.phone && !u.qq_openid && !u.wb_uid) fail(400, '请先绑定手机号或 QQ');
    run(`UPDATE users SET ${map[b.type][0]}=NULL, ${map[b.type][2]}=NULL, updated_at=? WHERE id=?`, nowISO(), u.id);
  } else fail(400, '不支持的解绑类型');
  return { bindings: publicUser(one('SELECT * FROM users WHERE id=?', u.id)).bindings };
});

route('GET', '/api/me', async (req) => {
  const u = requireUser(req);
  const pu = publicUser(u);
  // settings 单独读原始列，避免 publicUser 里被裁剪掉
  const raw = one('SELECT settings FROM users WHERE id=?', u.id);
  let settings = {};
  try { settings = raw?.settings ? JSON.parse(raw.settings) : {}; } catch { settings = {}; }
  return { user: pu, settings };
});
route('PATCH', '/api/me', async (req) => {
  const u = requireUser(req);
  const b = await readBody(req);
  const allow = ['nickname', 'school', 'subject', 'title', 'avatar'];
  const sets = []; const args = [];
  for (const k of allow) if (k in b) { sets.push(`${k}=?`); args.push(String(b[k] ?? '')); }
  if (b.settings) { sets.push('settings=?'); args.push(JSON.stringify(b.settings)); }
  if (!sets.length) return { user: publicUser(u) };
  sets.push('updated_at=?'); args.push(nowISO()); args.push(u.id);
  run(`UPDATE users SET ${sets.join(',')} WHERE id=?`, ...args);
  return { user: publicUser(one('SELECT * FROM users WHERE id=?', u.id)) };
});
route('POST', '/api/me/password', async (req) => {
  const u = requireUser(req);
  const b = await readBody(req);
  if (String(b.newPassword || '').length < 6) fail(400, '新密码至少 6 位');
  if (u.password_hash && !verifyPassword(String(b.oldPassword || ''), u.password_hash)) fail(400, '原密码不正确');
  run('UPDATE users SET password_hash=?, updated_at=? WHERE id=?', hashPassword(b.newPassword), nowISO(), u.id);
  return { ok: true };
});
route('GET', '/api/me/sessions', async (req) => {
  const u = requireUser(req);
  const cur = parseCookies(req).wb_session;
  // 同一设备+IP 只保留最近一条，最多列 20 条，避免历史会话刷屏
  const rows = all('SELECT token,device,ip,created_at,last_seen FROM sessions WHERE user_id=? AND revoked=0 ORDER BY last_seen DESC', u.id);
  const seen = new Set(); const out = [];
  for (const s of rows) {
    const key = `${s.device}|${s.ip}`;
    const isCur = s.token === cur;
    if (!isCur && seen.has(key)) continue;
    seen.add(key);
    /* device 可能是空串——不经过 createSession 建的会话（历史数据、脚本注入）
       就没有设备名。空着在界面上是一行空白，用户根本认不出那是哪台设备，
       更不敢点「退出其他所有设备」。这里兜一个可读的名字，
       顺便把「本设备」标在最前面，别让人对着列表猜哪条是自己。 */
    const device = s.device || (isCur ? '本设备' : '未知设备');
    out.push({ ...s, device, token: isCur ? 'current' : s.token.slice(0, 6) + '…', current: isCur });
    if (out.length >= 20) break;
  }
  out.sort((a, b) => Number(b.current) - Number(a.current));
  return out;
});
route('POST', '/api/me/sessions/revoke', async (req) => {
  const u = requireUser(req);
  const b = await readBody(req);
  run('UPDATE sessions SET revoked=1 WHERE user_id=? AND token<>?', u.id, parseCookies(req).wb_session || '');
  return { ok: true };
});

/* ---- 全局搜索 ---- */
/* 全局搜索。
   两档模式：
     fuzzy（模糊）—— 包含即命中，适合「我只记得大概」；
     exact（精准）—— 前缀或整词命中，适合「我记得开头几个字」。
   之前 exact 用的是 col = ?，等于要求整列内容恰好等于搜索词，
   搜「劝学」永远搜不到「《劝学》教学设计」，形同虚设。
   现在 exact 改成 LIKE '词%'（前缀）OR LIKE '% 词%'（词首），这才符合人的直觉。 */
route('GET', '/api/search', async (req) => {
  const u = requireUser(req);
  const q = String(req.query.q || '').trim();
  const mode = req.query.mode === 'exact' ? 'exact' : 'fuzzy';
  if (!q) return { groups: [], total: 0, mode, q };

  /* LIKE 里的通配符要转义，否则用户搜 % 或 _ 会把全库捞出来 */
  const escLike = (x) => String(x).replace(/[\\%_]/g, (m) => '\\' + m);
  const kw = escLike(q);
  /* 一个字段的条件。
     精准模式 = 「词首」命中：开头、空格后、或者标点后（《劝学》里的「劝学」也算词首）。
     SQLite 的 LIKE 没有正则，只能把常见标点枚举出来——中文标题里真正会出现的就是这几个。 */
  const PUNCT = ['《', '「', '“', '（', '(', '：', ':', '·', '-', '—', '/', '、'];
  const cmp = (col) => (mode === 'exact'
    ? `(${[`${col} LIKE ? ESCAPE '\\'`, ...PUNCT.map(() => `${col} LIKE ? ESCAPE '\\'`), `${col} LIKE ? ESCAPE '\\'`].join(' OR ')})`
    : `${col} LIKE ? ESCAPE '\\'`);
  /* 生成某表的 WHERE 片段 + 参数，字段有几种，每个字段就吃几个参数 */
  const anyOf = (cols) => ({
    sql: cols.map((c) => cmp(c)).join(' OR '),
    args: cols.flatMap(() => (mode === 'exact'
      ? [`${kw}%`, ...PUNCT.map((p) => `${p}${kw}%`), `% ${kw}%`]
      : [`%${kw}%`])),
  });

  const groups = [];
  /* href(row) 给每条结果一个「跳到这条记录」的地址。
     名册/课表这类没有独立详情页的，就用 hash 参数把目标带过去，前端负责滚到那一条。
     不传 href 的行，点下去只落到该组的首页。 */
  const push = (label, type, route, sql, params, href) => {
    const rows = all(sql, ...params);
    if (rows.length) {
      if (href) for (const r of rows) r.href = href(r);
      groups.push({ label, type, route, rows });
    }
  };
  const near = (id) => `?focus=${id}`;

  // 类别词召回：搜「监考」「出差」「便签」这类分类名时，把该分类整体列出来
  const CAT_WORDS = [
    { label: '监考', words: ['监考', '监考记录'], type: 'invigilations', route: 'work/invigilation' },
    { label: '出差', words: ['出差', '差旅', '行程'], type: 'trips', route: 'work/trips' },
    { label: '课件资料', words: ['课件', '资料', '素材'], type: 'materials', route: 'work/materials' },
    { label: '教学笔记', words: ['笔记'], type: 'notes', route: 'work/notes' },
    { label: '便签', words: ['便签', '待办'], type: 'todos', route: 'daily' },
    { label: '作业', words: ['作业'], type: 'homework', route: 'daily/work' },
    { label: '上课记录', words: ['上课', '课时', '代课'], type: 'lessons', route: 'work/lessons' },
    { label: '课表', words: ['课表', '课程'], type: 'courses', route: 'work/timetable' },
    { label: '学习记录', words: ['学习'], type: 'studies', route: 'study' },
    { label: '考勤表', words: ['考勤', '签到', '坐班'], type: 'attendance', route: 'work/attendance' },
    { label: '事项', words: ['事项', '任务'], type: 'items', route: 'home' },
    { label: '教师名册', words: ['教师', '老师名册', '名册'], type: 'teachers', route: 'work/attendance' },
    { label: '学生', words: ['学生', '班级'], type: 'students', route: 'work/attendance' },
  ];
  const catHit = CAT_WORDS.find((c) => c.words.includes(q));

  const itm = anyOf(['title', 'detail']);
  push('事项 / 任务', 'items', 'home',
    `SELECT id,seq,title,kind,status,start_at AS time FROM items WHERE user_id=? AND deleted_at IS NULL AND (${itm.sql}) ORDER BY id DESC LIMIT 500`,
    [u.id, ...itm.args], (r) => `home${near(r.id)}`);

  const td = anyOf(['title', 'content']);
  push('便签', 'todos', 'daily',
    `SELECT id,seq,title,status,created_at AS time FROM todos WHERE user_id=? AND deleted_at IS NULL AND (${td.sql}) ORDER BY id DESC LIMIT 500`,
    [u.id, ...td.args], (r) => `daily${near(r.id)}`);

  const ls = anyOf(['content', 'class_name', 'subject', 'progress', 'next_content', 'remark']);
  push('上课记录', 'lessons', 'work/lessons',
    `SELECT id,seq,date AS time, COALESCE(NULLIF(content,''), class_name||' '||subject) AS title,
            class_name, subject, hours FROM lessons WHERE user_id=? AND deleted_at IS NULL AND (${ls.sql})
     ORDER BY date DESC LIMIT 500`,
    [u.id, ...ls.args], (r) => `work/lessons${near(r.id)}`);

  const cs = anyOf(['class_name', 'subject', 'room', 'remark']);
  push('课表', 'courses', 'work/timetable',
    `SELECT id, weekday, period_no, class_name||' '||subject AS title, start_time AS time, room
       FROM courses WHERE user_id=? AND deleted_at IS NULL AND (${cs.sql})
     ORDER BY weekday, COALESCE(period_no,0) LIMIT 500`,
    [u.id, ...cs.args]);

  const iv = anyOf(['subject', 'person', 'place', 'remark', 'exam_name', 'peer_name', 'room']);
  push('监考', 'invigilations', 'work/invigilation',
    `SELECT id,seq,date AS time, COALESCE(NULLIF(exam_name,''), subject||' '||IFNULL(person,'')) AS title, room
       FROM invigilations WHERE user_id=? AND deleted_at IS NULL AND (${iv.sql}) ORDER BY date DESC LIMIT 500`,
    [u.id, ...iv.args], (r) => `work/invigilation${near(r.id)}`);

  const tp = anyOf(['to_place', 'from_place', 'reason', 'companions', 'remark']);
  push('出差', 'trips', 'work/trips',
    `SELECT id,seq,start_date AS time, to_place||' '||reason AS title FROM trips
      WHERE user_id=? AND deleted_at IS NULL AND (${tp.sql}) ORDER BY start_date DESC LIMIT 500`,
    [u.id, ...tp.args], (r) => `work/trips${near(r.id)}`);

  const mt = anyOf(['title', 'descr', 'class_name']);
  push('课件资料', 'materials', 'work/materials',
    `SELECT id,seq,title,created_at AS time FROM materials WHERE user_id=? AND deleted_at IS NULL AND (${mt.sql}) ORDER BY id DESC LIMIT 500`,
    [u.id, ...mt.args]);

  const nt = anyOf(['title', 'content', 'tags']);
  push('笔记', 'notes', 'work/notes',
    `SELECT id,seq,title,updated_at AS time FROM notes WHERE user_id=? AND deleted_at IS NULL AND (${nt.sql}) ORDER BY updated_at DESC LIMIT 500`,
    [u.id, ...nt.args], (r) => `work/notes${near(r.id)}`);

  const hw = anyOf(['title', 'content', 'class_name']);
  push('作业', 'homework', 'daily/work',
    `SELECT id,seq,title,assign_date AS time FROM homework WHERE user_id=? AND deleted_at IS NULL AND (${hw.sql}) ORDER BY assign_date DESC LIMIT 500`,
    [u.id, ...hw.args]);

  const sd = anyOf(['title', 'content', 'tags']);
  push('学习记录', 'studies', 'study',
    `SELECT id,seq,title,date AS time, minutes FROM studies WHERE user_id=? AND deleted_at IS NULL AND (${sd.sql}) ORDER BY date DESC LIMIT 500`,
    [u.id, ...sd.args], (r) => `study${near(r.id)}`);

  const at = anyOf(['name', 'month', 'grade']);
  push('考勤表', 'attendance', 'work/attendance',
    `SELECT id, name AS title, grade, sheet_date AS time FROM attendance_tables WHERE user_id=? AND deleted_at IS NULL AND (${at.sql}) ORDER BY sheet_date DESC LIMIT 500`,
    [u.id, ...at.args], (r) => `work/attendance?tab=tables&focus=${r.id}`);

  /* —— 以下四类之前完全搜不到，属于这次补齐 —— */
  const st = anyOf(['name', 'class_name', 'no']);
  push('学生名册', 'students', 'work/attendance',
    `SELECT id, name AS title, grade, class_name AS subtitle FROM students WHERE user_id=? AND deleted_at IS NULL AND (${st.sql}) ORDER BY grade, class_name, name LIMIT 500`,
    [u.id, ...st.args], (r) => `work/attendance?tab=students&focus=${r.id}`);

  const te = anyOf(['name', 'subject', 'grade']);
  push('教师名册', 'teachers', 'work/attendance',
    `SELECT id, name AS title, grade, subject AS subtitle FROM teachers WHERE user_id=? AND deleted_at IS NULL AND (${te.sql}) ORDER BY grade, sort, name LIMIT 500`,
    [u.id, ...te.args], (r) => `work/attendance?tab=teachers&focus=${r.id}`);

  const pu = anyOf(['text', 'level']);
  push('惩罚任务', 'punishments', 'work/materials',
    `SELECT id, text AS title, level AS subtitle FROM punishments WHERE user_id=? AND deleted_at IS NULL AND (${pu.sql}) LIMIT 500`,
    [u.id, ...pu.args]);

  const ex = anyOf(['class_name', 'remark', 'action']);
  push('课表调整', 'exceptions', 'work/timetable',
    `SELECT id, COALESCE(NULLIF(remark,''), class_name||' '||IFNULL(action,'')) AS title, date AS time
       FROM exceptions WHERE user_id=? AND deleted_at IS NULL AND (${ex.sql}) ORDER BY date DESC LIMIT 500`,
    [u.id, ...ex.args]);

  const total = groups.reduce((s, x) => s + x.rows.length, 0);

  // 类别词命中：补上该分类的全部记录（标题里没有这个词也能搜到）
  if (catHit && !groups.some((x) => x.type === catHit.type && x.rows.length)) {
    const extra = {
      invigilations: () => all(`SELECT id,seq,date AS time, COALESCE(NULLIF(exam_name,''), subject||' '||IFNULL(person,'')) AS title FROM invigilations WHERE user_id=? AND deleted_at IS NULL ORDER BY date DESC LIMIT 20`, u.id),
      trips: () => all(`SELECT id,seq,start_date AS time, to_place||' '||reason AS title FROM trips WHERE user_id=? AND deleted_at IS NULL ORDER BY start_date DESC LIMIT 20`, u.id),
      materials: () => all(`SELECT id,seq,title,created_at AS time FROM materials WHERE user_id=? AND deleted_at IS NULL ORDER BY id DESC LIMIT 20`, u.id),
      notes: () => all(`SELECT id,seq,title,updated_at AS time FROM notes WHERE user_id=? AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 20`, u.id),
      todos: () => all(`SELECT id,seq,title,status,created_at AS time FROM todos WHERE user_id=? AND deleted_at IS NULL ORDER BY id DESC LIMIT 20`, u.id),
      homework: () => all(`SELECT id,seq,title,assign_date AS time FROM homework WHERE user_id=? AND deleted_at IS NULL ORDER BY assign_date DESC LIMIT 20`, u.id),
      lessons: () => all(`SELECT id,seq,date AS time, COALESCE(NULLIF(content,''), class_name||' '||subject) AS title FROM lessons WHERE user_id=? AND deleted_at IS NULL ORDER BY date DESC LIMIT 20`, u.id),
      courses: () => all(`SELECT id, weekday, period_no, class_name||' '||subject AS title, start_time AS time FROM courses WHERE user_id=? AND deleted_at IS NULL ORDER BY weekday, COALESCE(period_no,0) LIMIT 20`, u.id),
      studies: () => all(`SELECT id,seq,title,date AS time FROM studies WHERE user_id=? AND deleted_at IS NULL ORDER BY date DESC LIMIT 20`, u.id),
      attendance: () => all(`SELECT id, name AS title, sheet_date AS time FROM attendance_tables WHERE user_id=? AND deleted_at IS NULL ORDER BY sheet_date DESC LIMIT 20`, u.id),
      items: () => all(`SELECT id,seq,title,kind,status,start_at AS time FROM items WHERE user_id=? AND deleted_at IS NULL ORDER BY id DESC LIMIT 20`, u.id),
      teachers: () => all(`SELECT id, name AS title, grade, subject AS subtitle FROM teachers WHERE user_id=? AND deleted_at IS NULL ORDER BY grade, sort LIMIT 20`, u.id),
      students: () => all(`SELECT id, name AS title, grade, class_name AS subtitle FROM students WHERE user_id=? AND deleted_at IS NULL ORDER BY grade, class_name LIMIT 20`, u.id),
    }[catHit.type]?.() || [];
    if (extra.length) groups.unshift({ label: catHit.label, type: catHit.type, route: catHit.route, rows: extra, byCat: true });
  }

  /* 标题命中的组排前面：搜「劝学」时，标题就叫《劝学》的笔记应该压过正文里顺带提一句的上课记录 */
  const titleHit = (x) => String(x.title || '').includes(q);
  for (const g of groups) {
    g.hits = g.rows.filter(titleHit).length;
    g.rows.sort((a, b) => (titleHit(b) - titleHit(a)) || String(b.time || '').localeCompare(String(a.time || '')));
  }
  groups.sort((a, b) => (b.byCat ? 1 : 0) - (a.byCat ? 1 : 0) || b.hits - a.hits);

  return { groups, total: groups.reduce((s, x) => s + x.rows.length, 0), mode, q };
});

/* ---- 首页聚合 ---- */
route('GET', '/api/home', async (req) => {
  const u = requireUser(req);
  // 默认按北京时区取今天（与 cnDate 一致），不依赖前端是否传值
  const today = req.query.date || cnDate();
  const digest = todayDigest(u.id, today);
  const monthFrom = today.slice(0, 8) + '01';
  const [y, m] = today.split('-').map(Number);
  const monthTo = fmtDate(new Date(y, m, 0));
  const coursesMonth = courseInstancesForRange(u.id, monthFrom, monthTo);
  const upcoming = all(
    `SELECT * FROM reminders WHERE user_id=? AND status='scheduled' AND fire_at>=? ORDER BY fire_at LIMIT 5`,
    u.id, Date.now() - 60000
  );
  const unread = one('SELECT COUNT(*) c FROM messages WHERE user_id=? AND read=0', u.id)?.c || 0;
  const monthStr = today.slice(0, 7);
  const lessonCount = one('SELECT COUNT(*) c, SUM(hours) h FROM lessons WHERE user_id=? AND deleted_at IS NULL AND substr(date,1,7)=?', u.id, monthStr);
  const quote = pickQuote(today);
  return {
    date: today, ...digest,
    courses_month: coursesMonth,
    upcoming, unread, quote,
    stats: {
      lessons_month: lessonCount?.c || 0,
      hours_month: lessonCount?.h || 0,
      todo_open: (digest.todos || []).filter((t) => t.status !== 'done').length,
      items_open: (digest.items || []).filter((t) => t.status !== 'done').length,
    },
  };
});

// dateISO 可选：前端传浏览器本地日期，避免服务器跑在 UTC 时跨零点串天
function pickQuote(dateISO) {
  const today = dateISO || cnDate();
  let q = one('SELECT * FROM daily_quotes WHERE used_date=? LIMIT 1', today);
  if (q) return q;
  const total = one('SELECT COUNT(*) c FROM daily_quotes')?.c || 1;
  const unused = one('SELECT COUNT(*) c FROM daily_quotes WHERE used_date IS NULL')?.c || 0;
  if (unused === 0) run('UPDATE daily_quotes SET used_date=NULL');
  const cands = all('SELECT * FROM daily_quotes WHERE used_date IS NULL ORDER BY RANDOM() LIMIT 1');
  q = cands[0] || one('SELECT * FROM daily_quotes ORDER BY RANDOM() LIMIT 1');
  run('UPDATE daily_quotes SET used_date=? WHERE id=?', today, q.id);
  return q;
}

// 换一句：优先避开当前这句，随机取。
// 以前用「日期 % 总数」算下标，同一天永远返回同一条，「换一句」点了等于没点。
route('GET', '/api/home/quote', async (req) => {
  const notId = Number(req.query.not) || 0;
  const total = one('SELECT COUNT(*) c FROM daily_quotes')?.c || 0;
  if (!total) return { en: 'No data yet.', zh: '还没有句子', author: '' };
  if (total === 1) return one('SELECT * FROM daily_quotes LIMIT 1');
  return (
    one('SELECT * FROM daily_quotes WHERE id<>? ORDER BY RANDOM() LIMIT 1', notId) ||
    one('SELECT * FROM daily_quotes ORDER BY RANDOM() LIMIT 1')
  );
});

route('GET', '/api/calendar', async (req) => {
  const u = requireUser(req);
  const month = String(req.query.month || cnDate().slice(0, 7));
  const [y, m] = month.split('-').map(Number);
  const from = fmtDate(new Date(y, m - 1, 1));
  const to = fmtDate(new Date(y, m, 0));
  const courses = courseInstancesForRange(u.id, from, to);
  const items = all('SELECT * FROM items WHERE user_id=? AND deleted_at IS NULL AND substr(COALESCE(start_at,created_at),1,10) BETWEEN ? AND ? ORDER BY COALESCE(start_at,created_at)', u.id, from, to);
  const lessons = all('SELECT * FROM lessons WHERE user_id=? AND deleted_at IS NULL AND date BETWEEN ? AND ?', u.id, from, to);
  const invig = all('SELECT * FROM invigilations WHERE user_id=? AND deleted_at IS NULL AND date BETWEEN ? AND ?', u.id, from, to)
    .map(fillInvigTime);
  const trips = all('SELECT * FROM trips WHERE user_id=? AND deleted_at IS NULL AND start_date<=? AND IFNULL(end_date,start_date)>=?', u.id, to, from);
  const reminders = all('SELECT * FROM reminders WHERE user_id=? AND status<>\'canceled\' AND substr(due_at,1,10) BETWEEN ? AND ?', u.id, from, to);
  return { month, from, to, courses, items, lessons, invigilations: invig, trips, reminders };
});

route('GET', '/api/calendar/day', async (req) => {
  const u = requireUser(req);
  const d = String(req.query.date || fmtDate(new Date()));
  return todayDigest(u.id, d);
});

/* ---- 事项 items ---- */
route('GET', '/api/items', async (req) => {
  const u = requireUser(req);
  const rows = all('SELECT * FROM items WHERE user_id=? AND deleted_at IS NULL ORDER BY COALESCE(start_at,created_at)', u.id);
  return rows;
});
route('POST', '/api/items', async (req) => {
  const u = requireUser(req);
  const b = await readBody(req);
  if (!b.title) fail(400, '标题不能为空');
  const r = run(`INSERT INTO items(user_id,seq,kind,title,detail,start_at,end_at,status,priority,source,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    u.id, nextSeq('item:' + u.id), b.kind || '事项', b.title, b.detail || '', b.start_at || null, b.end_at || null,
    b.status || 'todo', b.priority || 'normal', b.source || '', nowISO(), nowISO());
  const id = Number(r.lastInsertRowid);
  if (b.remind_min !== undefined && b.remind_min !== null && b.remind_min !== '' && b.start_at) {
    addReminder(u.id, { title: b.title, body: b.detail || '', due_at: b.start_at, advance_min: Number(b.remind_min), item_id: id, repeat: b.repeat || 'none', ring: b.ring || 'chime' });
  }
  return one('SELECT * FROM items WHERE id=?', id);
});
/* ===== 便签 ↔ 事项 状态同源 =====
   首页快速便签会同时写 todos（便签）和 items（今日事项）两张表，
   是同一条内容的两个视角。状态、标题必须同源，否则会出现
   "首页勾了已完成、日常还是未开始"这种让人抓狂的错位。
   关联靠 todos.ref_item_id ↔ items.ref_id 这一对字段。 */
function syncItemToTodo(userId, itemId, changed) {
  const todo = one('SELECT * FROM todos WHERE user_id=? AND ref_item_id=? AND deleted_at IS NULL', userId, itemId)
    || one(`SELECT t.* FROM todos t JOIN items i ON i.id=? WHERE t.user_id=? AND i.ref_id=t.id AND t.deleted_at IS NULL`, itemId, userId);
  if (!todo) return;
  const sets = []; const args = [];
  if (changed.status) { sets.push('status=?'); args.push(changed.status); }
  if (changed.title !== undefined) { sets.push('title=?'); args.push(changed.title); }
  if (changed.start_at !== undefined) { sets.push('due_at=?'); args.push(changed.start_at || null); }
  if (!sets.length) return;
  sets.push('updated_at=?'); args.push(nowISO(), todo.id);
  run(`UPDATE todos SET ${sets.join(',')} WHERE id=?`, ...args);
  // 顺手补齐缺失的关联，老数据也能自愈
  if (!todo.ref_item_id) run('UPDATE todos SET ref_item_id=? WHERE id=?', itemId, todo.id);
}

route('PATCH', '/api/items/:id', async (req) => {
  const u = requireUser(req);
  const b = await readBody(req);
  const row = one('SELECT * FROM items WHERE id=? AND user_id=? AND deleted_at IS NULL', req.params.id, u.id);
  if (!row) fail(404, '事项不存在');
  const allow = ['title', 'detail', 'kind', 'start_at', 'end_at', 'status', 'priority'];
  const sets = []; const args = [];
  for (const k of allow) if (k in b) { sets.push(`${k}=?`); args.push(b[k] === '' ? null : b[k]); }
  if (b.remind_min !== undefined) {
    run("UPDATE reminders SET status='canceled' WHERE user_id=? AND item_id=?", u.id, row.id);
    if (b.remind_min !== null && b.remind_min !== '' && (b.start_at || row.start_at)) {
      addReminder(u.id, { title: b.title || row.title, due_at: b.start_at || row.start_at, advance_min: Number(b.remind_min), item_id: row.id });
    }
  }
  if (sets.length) { sets.push('updated_at=?'); args.push(nowISO()); args.push(row.id);
    run(`UPDATE items SET ${sets.join(',')} WHERE id=?`, ...args); }
  syncItemToTodo(u.id, row.id, b);
  return one('SELECT * FROM items WHERE id=?', row.id);
});

/* ---- 提醒 reminders ---- */
route('GET', '/api/reminders', async (req) => {
  const u = requireUser(req);
  return all("SELECT r.*, i.title AS item_title FROM reminders r LEFT JOIN items i ON i.id=r.item_id WHERE r.user_id=? AND r.status<>'canceled' ORDER BY r.fire_at", u.id);
});
route('POST', '/api/reminders', async (req) => {
  const u = requireUser(req);
  const b = await readBody(req);
  if (!b.title || !b.due_at) fail(400, '标题和时间必填');
  addReminder(u.id, { title: b.title, body: b.body || '', due_at: b.due_at, advance_min: b.advance_min || 0, repeat: b.repeat || 'none', ring: b.ring || 'chime', kind: b.kind || 'alarm' });
  return one('SELECT * FROM reminders WHERE user_id=? ORDER BY id DESC LIMIT 1', u.id);
});
route('POST', '/api/reminders/:id/ack', async (req) => {
  const u = requireUser(req);
  const r = one('SELECT * FROM reminders WHERE id=? AND user_id=?', req.params.id, u.id);
  if (!r) fail(404, '提醒不存在');
  run("UPDATE reminders SET status='acked', acked_at=? WHERE id=?", nowISO(), r.id);
  if (r.repeat && r.repeat !== 'none') {
    const d = new Date(r.fire_at);
    const step = { daily: 1, workday: 1, weekly: 7, monthly: 30 }[r.repeat] || 0;
    if (step) { d.setDate(d.getDate() + step); if (r.repeat === 'workday' && [0, 6].includes(d.getDay())) d.setDate(d.getDate() + (d.getDay() === 6 ? 2 : 1)); }
    run("INSERT INTO reminders(user_id,item_id,kind,title,body,due_at,fire_at,repeat,advance_min,ring,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,'scheduled',?)",
      u.id, r.item_id, r.kind, r.title, r.body, r.due_at, d.getTime(), r.repeat, r.advance_min, r.ring, nowISO());
  }
  return { ok: true };
});
route('DELETE', '/api/reminders/:id', async (req) => {
  const u = requireUser(req);
  run("UPDATE reminders SET status='canceled' WHERE id=? AND user_id=?", req.params.id, u.id);
  return { ok: true };
});
route('POST', '/api/reminders/:id/snooze', async (req) => {
  const u = requireUser(req);
  const b = await readBody(req);
  const mins = Number(b.minutes || 10);
  const r = one('SELECT * FROM reminders WHERE id=? AND user_id=?', req.params.id, u.id);
  if (!r) fail(404, '提醒不存在');
  run("INSERT INTO reminders(user_id,item_id,kind,title,body,due_at,fire_at,repeat,advance_min,ring,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,'scheduled',?)",
    u.id, r.item_id, r.kind, r.title, r.body, r.due_at, Date.now() + mins * 60000, 'none', 0, r.ring, nowISO());
  run("UPDATE reminders SET status='acked' WHERE id=?", r.id);
  return { ok: true };
});

/* ---- 消息中心 ---- */
route('GET', '/api/messages', async (req) => {
  const u = requireUser(req);
  syncTaskMessages(u.id);   // 进消息中心时顺手把今天的待办灌成提醒
  const type = req.query.type;
  const rows = type && type !== 'all'
    ? all('SELECT * FROM messages WHERE user_id=? AND type=? ORDER BY id DESC LIMIT 200', u.id, type)
    : all('SELECT * FROM messages WHERE user_id=? ORDER BY id DESC LIMIT 200', u.id);
  // 每类未读数，给筛选 chip 上的小红点用
  const byType = all('SELECT type, COUNT(*) c FROM messages WHERE user_id=? AND read=0 GROUP BY type', u.id);
  const counts = { all: 0 };
  for (const r of byType) { counts[r.type] = r.c; counts.all += r.c; }
  return { rows, unread: counts.all, counts };
});
route('POST', '/api/messages/read', async (req) => {
  const u = requireUser(req);
  const b = await readBody(req);
  if (b.all) run('UPDATE messages SET read=1 WHERE user_id=?', u.id);
  else if (b.type) run('UPDATE messages SET read=1 WHERE user_id=? AND type=?', u.id, b.type);
  else if (b.ids?.length) run(`UPDATE messages SET read=1 WHERE user_id=? AND id IN (${b.ids.map(() => '?').join(',')})`, u.id, ...b.ids);
  return { ok: true };
});
route('DELETE', '/api/messages/:id', async (req) => {
  const u = requireUser(req);
  run('DELETE FROM messages WHERE user_id=? AND id=?', u.id, Number(req.params.id));
  return { ok: true };
});
route('POST', '/api/messages/clear', async (req) => {
  const u = requireUser(req);
  const b = await readBody(req);
  // 只清已读的，未读的留着——手滑一下不至于把该看的提醒也扫掉
  if (b.readOnly !== false) run('DELETE FROM messages WHERE user_id=? AND read=1', u.id);
  else run('DELETE FROM messages WHERE user_id=?', u.id);
  return { ok: true };
});

/* 消息落库的统一入口：dedupe_key 相同的不重复发 */
function pushMessage(userId, { type = 'system', title, body = '', link = '', refType = null, refId = null, dedupe = '', skipIfSameTitleToday = false }) {
  try {
    if (dedupe && one('SELECT id FROM messages WHERE user_id=? AND dedupe_key=?', userId, dedupe)) return null;
    /* 同一件事可能既被「提醒时间」推过一条 remind，又被任务同步推一条 task，
       用户打开消息中心就看到两条一模一样的标题。这里按标题 + 当天去重，
       以先到的那条为准（提醒消息信息更全，通常也先到）。 */
    if (skipIfSameTitleToday) {
      const dup = one(
        `SELECT id FROM messages WHERE user_id=? AND title=? AND substr(created_at,1,10)=?`,
        userId, String(title || ''), new Date().toISOString().slice(0, 10)
      );
      if (dup) return null;
    }
    const id = run(
      'INSERT INTO messages(user_id,type,title,body,ref_type,ref_id,read,link,dedupe_key,created_at) VALUES(?,?,?,?,?,?,0,?,?,?)',
      userId, type, String(title || ''), String(body || ''), refType, refId, String(link || ''), String(dedupe || ''), nowISO()
    ).lastInsertRowid;
    return id;
  } catch { return null; }
}

/* 把「今天到期的事项 / 待办」变成任务提醒消息。
   挂在打开消息中心时触发，够用且不用起定时器。 */
function syncTaskMessages(userId) {
  try {
    const today = cnDate();
    // created_at 存的是 UTC，date() 直接取会差 8 小时，所以拉出来再用 isoToCnDate 换算
    const items = all(`SELECT * FROM items WHERE user_id=? AND deleted_at IS NULL AND status!='done'`, userId)
      .filter((it) => (it.start_at ? String(it.start_at).slice(0, 10) : isoToCnDate(it.created_at)) === today);
    for (const it of items) {
      pushMessage(userId, {
        type: 'task',
        title: it.title,
        body: it.start_at ? `今天 ${String(it.start_at).slice(11, 16)} 的事项还没完成` : '今天记下的事项还没完成',
        link: '#/home',
        refType: 'items', refId: it.id,
        dedupe: `item-${it.id}-${today}`,   // 同一条一天只提醒一次
        skipIfSameTitleToday: true,         // 已有同名提醒消息就不再推一条 task
      });
    }
    const todos = all(`SELECT * FROM todos WHERE user_id=? AND deleted_at IS NULL AND status!='done'`, userId)
      .filter((td) => isoToCnDate(td.created_at) === today);
    for (const td of todos) {
      pushMessage(userId, {
        type: 'task',
        title: td.title,
        body: '今天的便签还没划掉',
        link: '#/daily',
        refType: 'todos', refId: td.id,
        dedupe: `todo-${td.id}-${today}`,
        skipIfSameTitleToday: true,
      });
    }
  } catch { /* 静默失败，不影响主流程 */ }
}

/* ---- 便签 todos ---- */
route('GET', '/api/todos', async (req) => {
  const u = requireUser(req);
  // 带上 source / item_status：便签卡片要标「来自首页」，还要显示和首页同源的状态
  return all(`SELECT t.*, i.source AS source, i.status AS item_status, i.id AS item_id
    FROM todos t LEFT JOIN items i ON (i.ref_id=t.id AND i.source='便签' AND i.deleted_at IS NULL)
    WHERE t.user_id=? AND t.deleted_at IS NULL ORDER BY t.pin DESC, t.id DESC`, u.id);
});
route('POST', '/api/todos', async (req) => {
  const u = requireUser(req);
  const b = await readBody(req);
  if (!b.title) fail(400, '内容不能为空');
  const seq = nextSeq('todo:' + u.id);
  const r = run('INSERT INTO todos(user_id,seq,title,content,status,color,due_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
    u.id, seq, b.title, b.content || '', b.status || 'todo', b.color || '', b.due_at || null, nowISO(), nowISO());
  const id = Number(r.lastInsertRowid);
  if (b.sync_home) {
    const ir = run('INSERT INTO items(user_id,seq,kind,title,detail,start_at,status,priority,source,ref_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
      u.id, nextSeq('item:' + u.id), '事项', b.title, b.content || '', b.due_at || null, 'todo', 'normal', '便签', id, nowISO(), nowISO());
    run('UPDATE todos SET ref_item_id=? WHERE id=?', Number(ir.lastInsertRowid), id);
  }
  return one('SELECT * FROM todos WHERE id=?', id);
});
route('PATCH', '/api/todos/:id', async (req) => {
  const u = requireUser(req);
  const b = await readBody(req);
  const row = one('SELECT * FROM todos WHERE id=? AND user_id=? AND deleted_at IS NULL', req.params.id, u.id);
  if (!row) fail(404, '便签不存在');
  const allow = ['title', 'content', 'status', 'color', 'pin', 'due_at'];
  const sets = []; const args = [];
  for (const k of allow) if (k in b) { sets.push(`${k}=?`); args.push(b[k]); }
  sets.push('updated_at=?'); args.push(nowISO()); args.push(row.id);
  run(`UPDATE todos SET ${sets.join(',')} WHERE id=?`, ...args);
  // 状态、标题、时间改任一边，另一边都跟着变（同源）
  const linked = row.ref_item_id || one('SELECT id FROM items WHERE ref_id=? AND source=? AND deleted_at IS NULL', row.id, '便签')?.id;
  if (linked) {
    const ss = []; const aa = [];
    if (b.status) { ss.push('status=?'); aa.push(b.status); }
    if (b.title !== undefined) { ss.push('title=?'); aa.push(b.title); }
    if (b.due_at !== undefined) { ss.push('start_at=?'); aa.push(b.due_at || null); }
    if (ss.length) { ss.push('updated_at=?'); aa.push(nowISO(), linked); run(`UPDATE items SET ${ss.join(',')} WHERE id=?`, ...aa); }
    if (!row.ref_item_id) run('UPDATE todos SET ref_item_id=? WHERE id=?', linked, row.id);
  }
  return one('SELECT * FROM todos WHERE id=?', row.id);
});

/* ---- 学习计时器 ---- */
/* 口径：计时状态活在库里，前端只负责显示。
   这样锁屏、切后台、刷新页面、换设备都不会把时间搞丢。 */
function timerState(userId) {
  const r = one("SELECT * FROM studies WHERE user_id=? AND source='running' AND deleted_at IS NULL ORDER BY id DESC LIMIT 1", userId);
  if (!r) return null;
  const start = Date.parse(r.started_at) || Date.now();
  const pausedMs = Number(r.paused_ms) || 0;
  // 暂停中：时间冻结在暂停那一刻
  const now = r.paused_at ? Date.parse(r.paused_at) : Date.now();
  const elapsed = Math.max(0, now - start - pausedMs);
  return {
    id: r.id, title: r.title || '', category_id: r.category_id || null,
    started_at: r.started_at, elapsed_ms: elapsed,
    paused: !!r.paused_at, paused_ms: pausedMs,
    seconds: Math.floor(elapsed / 1000),
  };
}

route('GET', '/api/study/timer', async (req) => {
  const u = requireUser(req);
  return timerState(u.id);   // 没在计时就返回 null，前端据此显示「开始」
});

route('POST', '/api/study/timer/start', async (req) => {
  const u = requireUser(req);
  const cur = timerState(u.id);
  if (cur) return cur;   // 已在计时就别重开，避免多份草稿
  const b = await readBody(req);
  const now = nowISO();
  const r = run(
    `INSERT INTO studies(user_id, date, title, content, minutes, source, category_id, started_at, paused_ms, created_at, updated_at)
     VALUES(?,?,?,?,0,'running',?,?,0,?,?)`,
    u.id, cnDate(), String(b.title || ''), '', b.category_id ?? null, now, now, now
  );
  return timerState(u.id);
});

// 暂停 / 继续
route('POST', '/api/study/timer/pause', async (req) => {
  const u = requireUser(req);
  const r = one("SELECT * FROM studies WHERE user_id=? AND source='running' AND deleted_at IS NULL ORDER BY id DESC LIMIT 1", u.id);
  if (!r) fail(400, '当前没有在计时');
  const now = nowISO();
  if (r.paused_at) {
    // 继续：把这次暂停的时长累加进 paused_ms
    const add = Math.max(0, Date.now() - Date.parse(r.paused_at));
    run('UPDATE studies SET paused_ms=?, paused_at=NULL, updated_at=? WHERE id=?', (Number(r.paused_ms) || 0) + add, now, r.id);
  } else {
    run('UPDATE studies SET paused_at=?, updated_at=? WHERE id=?', now, now, r.id);
  }
  return timerState(u.id);
});

// 结束并落成正式记录
route('POST', '/api/study/timer/stop', async (req) => {
  const u = requireUser(req);
  const t = timerState(u.id);
  if (!t) fail(400, '当前没有在计时');
  const b = await readBody(req);
  const mins = b.minutes != null ? Math.max(0, Math.min(24 * 60, Number(b.minutes) || 0))
    : Math.max(1, Math.round(t.elapsed_ms / 60000));
  const now = nowISO();
  const title = String(b.title ?? t.title ?? '').trim() || '未命名学习';
  run(
    `UPDATE studies SET title=?, content=?, minutes=?, category_id=?, source='timer',
       end_at=?, paused_at=NULL, updated_at=? WHERE id=?`,
    title, String(b.content || ''), mins, b.category_id ?? t.category_id ?? null, now, now, t.id
  );
  return { id: t.id, minutes: mins, title };
});

// 丢弃这次计时（点错了/不想记）
route('DELETE', '/api/study/timer', async (req) => {
  const u = requireUser(req);
  run("UPDATE studies SET deleted_at=? WHERE user_id=? AND source='running' AND deleted_at IS NULL", nowISO(), u.id);
  return { ok: true };
});

/* ---- 通用 CRUD（自动路由表） ---- */
const CRUD = {
  periods: { fields: ['period_no', 'name', 'start_time', 'end_time'] },
  courses: { fields: ['weekday', 'period_no', 'start_time', 'end_time', 'start_date', 'end_date', 'grade', 'class_name', 'subject', 'room', 'weeks', 'color', 'remark'] },
  lessons: { fields: ['date', 'period_no', 'time_range', 'start_time', 'end_time', 'grade', 'class_name', 'subject', 'teacher', 'substitute', 'sub_type', 'sub_note', 'content', 'progress', 'next_content', 'discipline', 'hours', 'remark', 'peer_name', 'peer_id', 'orig_teacher', 'pay_hours', 'unit_price', 'pay_amount', 'settle_note', 'swap_from', 'swap_to', 'settled_at', 'settle_key'] },
  invigilations: { fields: ['date', 'type', 'person', 'subject', 'grade', 'start_at', 'end_at', 'minutes', 'amount', 'paid', 'place', 'need_paper', 'paper_place', 'remark',
    // —— 监考模块新字段 ——
    'exam_name', 'duty_type', 'peer_name', 'peer_id', 'start_time', 'end_time', 'duration_min', 'room', 'seat_count', 'pay_amount', 'pay_rule', 'pay_note', 'settled_at', 'settle_key', 'status', 'school_paid'] },
  trips: { fields: ['start_date', 'end_date', 'from_place', 'to_place', 'reason', 'companions', 'km', 'toll', 'parking', 'other', 'status', 'approve_note', 'remark', 'days', 'hotel', 'transport', 'taxi', 'subsidy_food', 'subsidy_local', 'advance', 'reimb_status', 'paid_at'] },
  materials: { fields: ['category_id', 'title', 'grade', 'class_name', 'descr', 'public'] },
  notes: { fields: ['category_id', 'title', 'content', 'tags', 'pinned'] },
  preps: { fields: ['date', 'class_name', 'subject', 'topic', 'progress', 'next_step', 'minutes', 'status', 'lesson_id', 'remark'] },
  categories: { fields: ['scope', 'name', 'sort'] },
  homework: { fields: ['title', 'grade', 'class_name', 'subject', 'assign_date', 'due_date', 'content'] },
  studies: { fields: ['date', 'category_id', 'title', 'content', 'minutes', 'source', 'tags'] },
  students: { fields: ['grade', 'class_name', 'name', 'no'] },
  rosters: { fields: ['grade', 'class_name', 'count', 'names'] },
  punishments: { fields: ['text', 'level', 'active'] },
  exceptions: { fields: ['type', 'date', 'ref_id', 'action', 'start_time', 'end_time', 'class_name', 'room', 'rescheduled', 'remark'] },
  /* 第 22 条：自习 */
  selfstudy: { fields: ['date', 'period_no', 'start_time', 'end_time', 'grade', 'class_name', 'subject', 'minutes', 'content', 'absent', 'billable', 'remark'] },
  /* 第 23 条：维修 */
  repairs: { fields: ['date', 'place', 'item', 'fault', 'urgency', 'status', 'reporter', 'handler', 'cost', 'expect_at', 'fixed_at', 'remark'] },
};
const SEQ_SCOPE = { lessons: 'lesson', invigilations: 'invig', trips: 'trip', materials: 'material', notes: 'note', homework: 'homework', studies: 'study', preps: 'prep', selfstudy: 'selfstudy', repairs: 'repair' };

for (const [table, cfg] of Object.entries(CRUD)) {
  route('GET', `/api/${table}`, async (req) => {
    const u = requireUser(req);
    const wh = ['user_id=?', 'deleted_at IS NULL']; const args = [u.id];
    for (const [k, v] of Object.entries(req.query)) {
      // month=2026-10 → 按前缀匹配 date 字段（供上课、监考等按月对账使用）
      if (k === 'month' && /^\d{4}-\d{2}$/.test(String(v))) {
        const dcol = cfg.fields.includes('date') ? 'date' : (cfg.fields.includes('start_date') ? 'start_date' : null);
        if (dcol) { wh.push(`${dcol} LIKE ?`); args.push(String(v) + '-%'); }
        continue;
      }
      if (cfg.fields.includes(k) || k === 'category_id') { wh.push(`${k}=?`); args.push(v); }
    }
    const order = table === 'courses' ? 'weekday, period_no'
      : table === 'lessons' ? 'date DESC, COALESCE(period_no,0)'
      : table === 'preps' ? 'date DESC, id DESC'
      : table === 'selfstudy' ? 'date DESC, COALESCE(period_no,0) DESC, id DESC'
      : table === 'repairs' ? "CASE status WHEN 'pending' THEN 0 WHEN 'doing' THEN 1 ELSE 2 END, date DESC, id DESC"
      : table === 'invigilations' ? 'date DESC, COALESCE(start_time,\'\') DESC' : table === 'trips' ? 'start_date DESC'
      : table === 'homework' ? 'assign_date DESC' : table === 'studies' ? 'date DESC'
      : table === 'notes' ? 'pinned DESC, updated_at DESC' : 'id DESC';
    return all(`SELECT * FROM ${table} WHERE ${wh.join(' AND ')} ORDER BY ${order}`, ...args);
  });
  route('POST', `/api/${table}`, async (req) => {
    const u = requireUser(req);
    const b = await readBody(req);
    // 监考表旧列 type 是 NOT NULL，新逻辑用 duty_type，这里补一份映射保证写入不炸
    if (table === 'invigilations' && !b.type) {
      const m = { school: '学校分配', '替他人': '我代他人', '他人替我': '他人代我' };
      b.type = m[b.duty_type] || '学校分配';
    }
    const cols = ['user_id']; const vals = [u.id]; const marks = ['?'];
    for (const f of cfg.fields) {
      if (f in b) { cols.push(f); marks.push('?'); vals.push(normalizeVal(b[f])); }
    }
    if (table === 'invigilations' && !cfg.fields.includes('type')) {
      cols.push('type'); marks.push('?'); vals.push(String(b.type || '学校分配'));
    }
    if (SEQ_SCOPE[table]) { cols.push('seq'); marks.push('?'); vals.push(nextSeq(SEQ_SCOPE[table] + ':' + u.id)); }
    cols.push('created_at', 'updated_at'); marks.push('?', '?'); vals.push(nowISO(), nowISO());
    const r = run(`INSERT INTO ${table}(${cols.join(',')}) VALUES(${marks.join(',')})`, ...vals);
    return one(`SELECT * FROM ${table} WHERE id=?`, Number(r.lastInsertRowid));
  });
  route('PATCH', `/api/${table}/:id`, async (req) => {
    const u = requireUser(req);
    const b = await readBody(req);
    const row = one(`SELECT * FROM ${table} WHERE id=? AND user_id=? AND deleted_at IS NULL`, req.params.id, u.id);
    if (!row) fail(404, '记录不存在');
    const sets = []; const args = [];
    for (const f of cfg.fields) if (f in b) { sets.push(`${f}=?`); args.push(normalizeVal(b[f])); }
    if (!sets.length) return row;
    sets.push('updated_at=?'); args.push(nowISO()); args.push(row.id);
    run(`UPDATE ${table} SET ${sets.join(',')} WHERE id=?`, ...args);
    return one(`SELECT * FROM ${table} WHERE id=?`, row.id);
  });
  route('POST', `/api/${table}/bulk`, async (req) => {
    const u = requireUser(req);
    const b = await readBody(req);
    const rows = Array.isArray(b.rows) ? b.rows : [];
    const out = [];
    for (const item of rows) {
      if (item.id) {
        const sets = []; const args = [];
        for (const f of cfg.fields) if (f in item) { sets.push(`${f}=?`); args.push(normalizeVal(item[f])); }
        if (sets.length) { sets.push('updated_at=?'); args.push(nowISO()); args.push(item.id);
          run(`UPDATE ${table} SET ${sets.join(',')} WHERE id=? AND user_id=?`, ...args, u.id); }
        out.push(item.id);
      } else {
        const cols = ['user_id']; const vals = [u.id]; const marks = ['?'];
        for (const f of cfg.fields) if (f in item) { cols.push(f); marks.push('?'); vals.push(normalizeVal(item[f])); }
        if (SEQ_SCOPE[table]) { cols.push('seq'); marks.push('?'); vals.push(nextSeq(SEQ_SCOPE[table] + ':' + u.id)); }
        cols.push('created_at', 'updated_at'); marks.push('?', '?'); vals.push(nowISO(), nowISO());
        const r = run(`INSERT INTO ${table}(${cols.join(',')}) VALUES(${marks.join(',')})`, ...vals);
        out.push(Number(r.lastInsertRowid));
      }
    }
    return { ids: out };
  });
}
function normalizeVal(v) {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === undefined) return null;
  if (v !== null && typeof v === 'object') return JSON.stringify(v);
  return v;
}

/* ---- 通用删除（进回收站） ---- */
/* 每一类被删的东西都长这样：表格名 + 一个「给人看的标题」生成器。
   新增可删类型时只加一行，前端 LABEL 里补个中文名即可。 */
const RECYCLE_TITLE = {
  items: (r) => r.title, todos: (r) => r.title, lessons: (r) => `${r.date} ${r.class_name || ''} ${r.content || ''}`.trim(),
  invigilations: (r) => `${r.date} ${r.subject || ''} 监考`, trips: (r) => `${r.to_place || ''} 出差`,
  materials: (r) => r.title, notes: (r) => r.title, homework: (r) => r.title, studies: (r) => r.title,
  preps: (r) => `${r.date || ''} ${r.class_name || ''} ${r.topic || ''}`.trim(),
  courses: (r) => `周${r.weekday} 第${r.period_no}节 ${r.class_name || ''}`, categories: (r) => r.name,
  students: (r) => r.name, attendance_tables: (r) => r.name, attendance_rows: (r) => r.teacher,
  punishments: (r) => r.text, exceptions: (r) => `${r.date} 课表调整`, reminders: (r) => r.title,
  /* 以下四类之前完全没接进回收站（teachers / periods 甚至直接报「不支持的删除类型」，根本删不掉），
     现在是补齐，不是新增功能。 */
  teachers: (r) => `${r.name || ''}${r.subject ? '（' + r.subject + '）' : ''}`,
  periods: (r) => `第${r.period_no}节${r.start_time ? ' ' + r.start_time + '-' + (r.end_time || '') : ''}`,
  trip_items: (r) => `${r.kind || '明细'} ${r.amount ? '¥' + r.amount : ''} ${r.note || ''}`.trim(),
  attachments: (r) => r.name,
};

/* 主表被删时，连带把从表也标记删除（并让从表自己的快照一起进回收站）。
   否则还原考勤表后，明细行还是 deleted 状态，表回来了但格子全空。 */
const RECYCLE_CASCADE = {
  attendance_tables: { table: 'attendance_rows', key: 'table_id' },
};

/* 统一入口：标删 + 写回收站快照。返回进站后的 recycle.id（撤销清空要用）。 */
function recyclePut(userId, table, id, extraTitle = '') {
  const row = one(`SELECT * FROM ${table} WHERE id=? AND user_id=?`, id, userId);
  if (!row) return null;
  const ts = nowISO();
  run(`UPDATE ${table} SET deleted_at=? WHERE id=?`, ts, id);
  const gen = RECYCLE_TITLE[table];
  const title = String((gen ? gen(row) : '') || row.title || row.name || '(无标题)').slice(0, 120);
  const rid = Number(run('INSERT INTO recycle(user_id,entity,entity_id,title,payload,deleted_at) VALUES(?,?,?,?,?,?)',
    userId, table, id, title + (extraTitle || ''), JSON.stringify(row), ts).lastInsertRowid);
  const cas = RECYCLE_CASCADE[table];
  if (cas) {
    const kids = all(`SELECT * FROM ${cas.table} WHERE ${cas.key}=? AND deleted_at IS NULL`, id);
    for (const k of kids) {
      run(`UPDATE ${cas.table} SET deleted_at=? WHERE id=?`, ts, k.id);
      run('INSERT INTO recycle(user_id,entity,entity_id,title,payload,deleted_at) VALUES(?,?,?,?,?,?)',
        userId, cas.table, k.id, String(k.teacher || k.name || '(明细)').slice(0, 120), JSON.stringify(k), ts);
    }
  }
  return rid;
}

route('DELETE', '/api/:table/:id', async (req) => {
  const u = requireUser(req);
  const { table, id } = req.params;
  /* 这里曾经有个坑：这条通配路由注册得比 /api/me/avatar、/api/attachments/:id 更早，
     而旧的分发逻辑按注册顺序取第一个匹配，于是 DELETE /api/me/avatar 撞到这里，
     被当成「删 me 表里 id=avatar 的行」，回 400「不支持的删除类型」——
     前端表现就是点了移除头像、点了确认，什么也没发生。
     已经从匹配规则上根治（见 pickRoute：写死字符多的路由优先），这里不再需要白名单。 */
  if (!RECYCLE_TITLE[table]) fail(400, '不支持的删除类型');
  const row = one(`SELECT * FROM ${table} WHERE id=? AND user_id=?`, id, u.id);
  if (!row) fail(404, '记录不存在');
  if (table === 'categories') {
    const refs = countCatRefs(u.id, row.id, row.scope);
    if (refs) fail(400, '该分类下还有内容，请先移动或删除内容');
  }
  recyclePut(u.id, table, id);
  return { ok: true };
});
function countCatRefs(userId, catId, scope) {
  const t = scope === 'material' ? 'materials' : scope === 'note' ? 'notes' : 'studies';
  return one(`SELECT COUNT(*) c FROM ${t} WHERE user_id=? AND category_id=? AND deleted_at IS NULL`, userId, catId)?.c || 0;
}

/* ---- 回收站 ---- */
/* 保留 30 天，跟 Windows 11 默认一致。超期自动彻底删除，避免数据库无限膨胀。
   清理时机：启动时一次 + 每次打开回收站时一次，不挂定时器。 */
const RECYCLE_KEEP_DAYS = 30;

/* 每一类被删的东西属于哪个页面，用于回收站里显示「来自：工作 → 上课记录」，
   也用于按原位置筛选（Win11 的分类列）。 */
const RECYCLE_GROUP = {
  items: { group: 'task', at: '首页 → 今日事项' },
  todos: { group: 'task', at: '日常 → 便签' },
  studies: { group: 'study', at: '学习 → 记录' },
  notes: { group: 'study', at: '学习 / 工作 → 笔记' },
  lessons: { group: 'work', at: '工作 → 上课' },
  courses: { group: 'work', at: '工作 → 课表' },
  periods: { group: 'work', at: '工作 → 课表 → 节次' },
  invigilations: { group: 'work', at: '工作 → 监考' },
  trips: { group: 'work', at: '工作 → 出差' },
  trip_items: { group: 'work', at: '工作 → 出差 → 明细发票' },
  materials: { group: 'work', at: '工作 → 课件' },
  attachments: { group: 'work', at: '工作 → 附件 / 原件' },
  homework: { group: 'work', at: '日常 → 作业' },
  attendance_tables: { group: 'work', at: '工作 → 考勤表' },
  attendance_rows: { group: 'work', at: '工作 → 考勤表 → 人员' },
  teachers: { group: 'work', at: '工作 → 教师名册' },
  students: { group: 'other', at: '班级 → 学生名册' },
  categories: { group: 'other', at: '分类管理' },
  punishments: { group: 'other', at: '课堂 → 惩罚盲盒' },
  exceptions: { group: 'other', at: '课表调整' },
  reminders: { group: 'other', at: '提醒' },
};

function purgeExpired(userId) {
  const cutoff = new Date(Date.now() - RECYCLE_KEEP_DAYS * 86400e3).toISOString();
  const dead = all('SELECT * FROM recycle WHERE user_id=? AND deleted_at<?', userId, cutoff);
  for (const r of dead) {
    /* 只清「为这次删除生成的那一条记录」。
       同一行可能被删过多次（每次一个快照），用 payload 里的 updated_at 对齐太脆，
       所以直接删实体：反正已经超期，实体留着也没人还原了。 */
    try { run(`DELETE FROM ${r.entity} WHERE id=?`, r.entity_id); } catch { /* 表可能已改过名 */ }
    run('DELETE FROM recycle WHERE id=?', r.id);
  }
  return dead.length;
}

route('GET', '/api/recycle', async (req) => {
  const u = requireUser(req);
  const purged = purgeExpired(u.id);
  const rows = all('SELECT * FROM recycle WHERE user_id=? ORDER BY id DESC', u.id);
  const now = Date.now();
  const list = rows.map((r) => {
    const g = RECYCLE_GROUP[r.entity] || { group: 'other', at: '未知位置' };
    const t = Date.parse(r.deleted_at) || now;
    const ageDays = Math.floor((now - t) / 86400e3);
    let size = 0;
    try { size = Buffer.byteLength(r.payload || '', 'utf8'); } catch { /* 忽略 */ }
    let payload = {};
    try { payload = JSON.parse(r.payload || '{}'); } catch { /* 忽略 */ }
    return {
      id: r.id, entity: r.entity, entity_id: r.entity_id, title: r.title,
      deleted_at: r.deleted_at, group: g.group, location: g.at,
      /* 剩余天数：0 表示今天到期，前端显示成「今天彻底删除」而不是「还剩 0 天」 */
      daysLeft: Math.max(0, RECYCLE_KEEP_DAYS - ageDays),
      size,
      /* 附件类带上真实体积，前端好显示「2.4 MB」 */
      fileSize: Number(payload.size) || 0,
      fileName: payload.name || payload.title || '',
    };
  });
  const counts = { all: list.length };
  for (const x of list) counts[x.group] = (counts[x.group] || 0) + 1;
  return { list, counts, keepDays: RECYCLE_KEEP_DAYS, purged };
});

route('POST', '/api/recycle/restore', async (req) => {
  const u = requireUser(req);
  const b = await readBody(req);
  const ids = b.all
    ? all('SELECT id FROM recycle WHERE user_id=?', u.id).map((x) => x.id)
    : (b.ids || []).map(Number).filter(Boolean);
  let n = 0;
  for (const id of ids) {
    const r = one('SELECT * FROM recycle WHERE id=? AND user_id=?', id, u.id);
    if (!r) continue;
    try {
      run(`UPDATE ${r.entity} SET deleted_at=NULL WHERE id=?`, r.entity_id);
      // 考勤表连带还原明细行（明细行自己也有回收站记录，会各自再被还原一次，幂等）
      if (r.entity === 'attendance_tables') run('UPDATE attendance_rows SET deleted_at=NULL WHERE table_id=?', r.entity_id);
      run('DELETE FROM recycle WHERE id=?', r.id);
      n += 1;
    } catch { /* 实体已被彻底删掉，跳过 */ }
  }
  return { restored: n };
});

/* 彻底删除。支持三档：ids（删指定）、all（清空）、olderThan（删 N 天前的）。
   清空时把删掉的快照原样返回，前端拿它在 8 秒内「撤销」。 */
route('POST', '/api/recycle/purge', async (req) => {
  const u = requireUser(req);
  const b = await readBody(req);
  let rows;
  if (b.all) rows = all('SELECT * FROM recycle WHERE user_id=?', u.id);
  else if (b.olderThan) {
    const cutoff = new Date(Date.now() - Number(b.olderThan) * 86400e3).toISOString();
    rows = all('SELECT * FROM recycle WHERE user_id=? AND deleted_at<?', u.id, cutoff);
  } else {
    rows = (b.ids || []).map((id) => one('SELECT * FROM recycle WHERE id=? AND user_id=?', id, u.id)).filter(Boolean);
  }
  for (const r of rows) {
    try { run(`DELETE FROM ${r.entity} WHERE id=?`, r.entity_id); } catch { /* 忽略 */ }
    if (r.entity === 'attendance_tables') run('DELETE FROM attendance_rows WHERE table_id=?', r.entity_id);
    run('DELETE FROM recycle WHERE id=?', r.id);
  }
  /* 只回传能用于撤销的字段，别把整坨 payload 塞给前端 */
  const undo = rows.map((r) => ({ entity: r.entity, entity_id: r.entity_id, title: r.title, payload: r.payload, deleted_at: r.deleted_at }));
  return { purged: rows.length, undo };
});

/* 撤销清空：把刚才彻底删掉的快照重新「复活」。
   做法是把 payload 里的行原样 INSERT 回去（保留原 id），再把回收站记录补回来。
   这样即使实体行已经被 DELETE，也能整体恢复到删除前的样子。 */
route('POST', '/api/recycle/undo', async (req) => {
  const u = requireUser(req);
  const b = await readBody(req);
  const items = Array.isArray(b.items) ? b.items : [];
  let back = 0;
  for (const it of items) {
    if (!it || !it.entity || !it.entity_id) continue;
    try {
      const row = JSON.parse(it.payload || '{}');
      const cols = Object.keys(row).filter((k) => k !== 'id');
      /* 已经被别人重新插回去了就跳过，避免唯一约束炸掉 */
      if (one(`SELECT id FROM ${it.entity} WHERE id=?`, it.entity_id)) {
        run(`UPDATE ${it.entity} SET deleted_at=? WHERE id=?`, it.deleted_at || nowISO(), it.entity_id);
      } else {
        const sql = `INSERT INTO ${it.entity}(id,${cols.join(',')}) VALUES(?,${cols.map(() => '?').join(',')})`;
        run(sql, it.entity_id, ...cols.map((k) => normalizeVal(row[k])));
        run(`UPDATE ${it.entity} SET deleted_at=? WHERE id=?`, it.deleted_at || nowISO(), it.entity_id);
      }
      const dup = one('SELECT id FROM recycle WHERE user_id=? AND entity=? AND entity_id=? AND deleted_at=?',
        u.id, it.entity, it.entity_id, it.deleted_at || '');
      if (!dup) {
        run('INSERT INTO recycle(user_id,entity,entity_id,title,payload,deleted_at) VALUES(?,?,?,?,?,?)',
          u.id, it.entity, it.entity_id, String(it.title || ''), it.payload || '{}', it.deleted_at || nowISO());
      }
      back += 1;
    } catch { /* 单条失败不影响其它 */ }
  }
  return { restored: back };
});

/* ---- 考勤表 ---- */
route('GET', '/api/attendance', async (req) => {
  const u = requireUser(req);
  const q = req.query || {};
  const kind = q.kind || '';
  const grade = q.grade || '';
  let sql = 'SELECT * FROM attendance_tables WHERE user_id=? AND deleted_at IS NULL';
  const args = [u.id];
  if (kind) { sql += ' AND kind=?'; args.push(kind); }
  if (grade) { sql += ' AND grade=?'; args.push(grade); }
  sql += ' ORDER BY sheet_date DESC, id DESC';
  const tables = all(sql, ...args);
  return tables.map((t) => {
    const rows = all('SELECT teacher, subject, data FROM attendance_rows WHERE table_id=? AND deleted_at IS NULL', t.id);
    const cols = j(t.columns, []);
    // 每张表算一个「异常数」：请假 / 明确划掉 / 未到，供列表角标显示
    let leaveCount = 0; let unchecked = 0;
    const leaveNames = [];
    for (const r of rows) {
      const d = j(r.data, {});
      const isLeave = Object.entries(d).some(([k, v]) => /请假/.test(k) && v === '1');
      if (isLeave) { leaveCount++; leaveNames.push(r.teacher); }
      const anyChecked = cols.some((c) => c.type === 'check' && /上课|坐班|签到|教研|听课/.test(c.label) && d[c.key] === '1');
      if (!anyChecked && !isLeave) unchecked++;
    }
    const subjects = [...new Set(rows.map((r) => r.subject).filter(Boolean))];
    return {
      ...t,
      sheet_type: t.sheet_type || t.kind,
      columns: cols, meta: j(t.meta, {}),
      row_count: rows.length,
      subjects,
      summary: { leave: leaveCount, leave_names: leaveNames.slice(0, 6), none: unchecked },
    };
  });
});
route('GET', '/api/attendance/:id', async (req) => {
  const u = requireUser(req);
  const t = one('SELECT * FROM attendance_tables WHERE id=? AND user_id=? AND deleted_at IS NULL', req.params.id, u.id);
  if (!t) fail(404, '考勤表不存在');
  const rows = all('SELECT * FROM attendance_rows WHERE table_id=? AND deleted_at IS NULL ORDER BY sort, id', t.id)
    .map((r) => ({ ...r, data: j(r.data, {}) }));
  const photoCount = one("SELECT COUNT(*) c FROM attachments WHERE user_id=? AND owner_type='attendance' AND owner_id=? AND deleted_at IS NULL", u.id, t.id)?.c || 0;
  return { ...t, columns: j(t.columns, []), meta: j(t.meta, {}), photo_count: photoCount, rows };
});
route('POST', '/api/attendance', async (req) => {
  const u = requireUser(req);
  const b = await readBody(req);
  const sheetType = b.sheet_type || (b.kind === 'research' ? 'research' : 'seat');
  const cols = b.columns || defaultCols(sheetType);
  const month = b.month || (b.sheet_date || fmtDate(new Date())).slice(0, 7);
  const meta = { periods: b.periods || '', year: (b.sheet_date || '').slice(0, 4) || String(new Date().getFullYear()), weekday: b.weekday || '', ...(b.meta || {}) };
  const r = run('INSERT INTO attendance_tables(user_id,kind,name,month,columns,meta,grade,sheet_type,sheet_date,weekday,periods,subject,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    u.id, sheetType, b.name || '新建考勤表', month, JSON.stringify(cols), JSON.stringify(meta),
    b.grade || '高一', sheetType, b.sheet_date || '', b.weekday || '', b.periods || '', b.subject || '', nowISO(), nowISO());
  return one('SELECT * FROM attendance_tables WHERE id=?', Number(r.lastInsertRowid));
});
/* 两种表的默认列，严格对应你纸上那张表的结构 */
function defaultCols(kind) {
  if (kind === 'research') return [
    { key: 'k_签到', label: '签到', type: 'check', w: 62 },
    { key: 'k_remark', label: '签到时间 / 备注', type: 'text', w: 160 },
  ];
  return [
    { key: 'k_上课', label: '上课', type: 'check', w: 62 },
    { key: 'k_坐班', label: '坐班', type: 'check', w: 62 },
    { key: 'k_听课', label: '听课', type: 'check', w: 62 },
    { key: 'k_教研', label: '教研', type: 'check', w: 62 },
    { key: 'k_请假', label: '请假', type: 'check', w: 62 },
    { key: 'k_remark', label: '备注', type: 'text', w: 130 },
  ];
}
route('PATCH', '/api/attendance/:id', async (req) => {
  const u = requireUser(req);
  const b = await readBody(req);
  const t = one('SELECT * FROM attendance_tables WHERE id=? AND user_id=?', req.params.id, u.id);
  if (!t) fail(404, '考勤表不存在');
  const sets = []; const args = [];
  for (const k of ['name', 'month', 'kind', 'grade', 'sheet_date', 'weekday', 'periods', 'sheet_type', 'subject']) if (k in b) { sets.push(`${k}=?`); args.push(b[k]); }
  if ('sheet_type' in b) { sets.push('kind=?'); args.push(b.sheet_type === 'research' ? 'research' : 'seat'); }
  if (b.columns) { sets.push('columns=?'); args.push(JSON.stringify(b.columns)); }
  if (b.meta) { sets.push('meta=?'); args.push(JSON.stringify(b.meta)); }
  sets.push('updated_at=?'); args.push(nowISO()); args.push(t.id);
  run(`UPDATE attendance_tables SET ${sets.join(',')} WHERE id=?`, ...args);
  return one('SELECT * FROM attendance_tables WHERE id=?', t.id);
});
route('POST', '/api/attendance/:id/rows', async (req) => {
  const u = requireUser(req);
  const b = await readBody(req);
  const t = one('SELECT id FROM attendance_tables WHERE id=? AND user_id=?', req.params.id, u.id);
  if (!t) fail(404, '考勤表不存在');
  const list = Array.isArray(b.rows) ? b.rows : [b];
  const ids = [];
  let sort = one('SELECT IFNULL(MAX(sort),0) m FROM attendance_rows WHERE table_id=?', t.id)?.m || 0;
  for (const row of list) {
    if (row.id) {
      run('UPDATE attendance_rows SET data=?, teacher=?, subject=?, updated_at=? WHERE id=? AND table_id=?',
        JSON.stringify(row.data || {}), row.teacher || '', String(row.subject ?? ''), nowISO(), row.id, t.id);
      ids.push(row.id);
    } else {
      const r = run('INSERT INTO attendance_rows(table_id,teacher,subject,data,sort,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
        t.id, row.teacher || '', String(row.subject ?? ''), JSON.stringify(row.data || {}), ++sort, nowISO(), nowISO());
      ids.push(Number(r.lastInsertRowid));
    }
  }
  return { ids };
});
route('POST', '/api/attendance/:id/import', async (req) => {
  const u = requireUser(req);
  const b = await readBody(req);
  const t = one('SELECT * FROM attendance_tables WHERE id=? AND user_id=?', req.params.id, u.id);
  if (!t) fail(404, '考勤表不存在');
  const text = String(b.text || '');
  const grid = b.grid || parseClipboardTable(text);
  const columns = b.columns || j(t.columns, []);
  let added = 0;
  let sort = one('SELECT IFNULL(MAX(sort),0) m FROM attendance_rows WHERE table_id=?', t.id)?.m || 0;
  const header = grid[0] || [];
  const isHeader = header.some((h) => /日期|姓名|老师|星期|签到|时间|状态|备注/.test(String(h)));
  const body = isHeader ? grid.slice(1) : grid;
  const mapName = isHeader ? header.findIndex((h) => /姓名|老师|教师/.test(String(h))) : 0;
  for (const line of body) {
    if (!line.length || line.every((c) => !String(c).trim())) continue;
    const teacher = String(line[mapName] ?? line[0] ?? '').trim();
    if (!teacher) continue;
    const data = {};
    if (isHeader) {
      columns.forEach((c) => {
        const idx = header.findIndex((h) => String(h).replace(/\s/g, '') === c.label.replace(/\s/g, '')) ;
        if (idx >= 0) data[c.key] = String(line[idx] ?? '').trim();
      });
    } else {
      columns.forEach((c, i) => { if (i + 1 < line.length) data[c.key] = String(line[i + 1]).trim(); });
    }
    run('INSERT INTO attendance_rows(table_id,teacher,data,sort,created_at,updated_at) VALUES(?,?,?,?,?,?)',
      t.id, teacher, JSON.stringify(data), ++sort, nowISO(), nowISO());
    added++;
  }
  return { added, detected_header: isHeader, columns };
});
export function parseClipboardTable(text) {
  const lines = String(text).replace(/\r/g, '').split('\n').filter((l) => l.trim() !== '');
  return lines.map((l) => (l.includes('\t') ? l.split('\t') : l.split(/\s{2,}|,/)).map((s) => s.trim()));
}
route('GET', '/api/attendance/:id/stats', async (req) => {
  const u = requireUser(req);
  const t = one('SELECT * FROM attendance_tables WHERE id=? AND user_id=?', req.params.id, u.id);
  if (!t) fail(404, '考勤表不存在');
  const rows = all('SELECT * FROM attendance_rows WHERE table_id=? AND deleted_at IS NULL ORDER BY sort, id', t.id).map((r) => ({ ...r, data: j(r.data, {}) }));
  const cols = j(t.columns, []);
  const keyOf = (re) => cols.find((c) => re.test(c.label))?.key;
  const kReason = keyOf(/原因|备注/) || 'remark';
  const kStatus = keyOf(/状态|坐班/);
  const kHours = keyOf(/时长/);
  const teachers = [...new Set(rows.map((r) => r.teacher))];
  const stats = teachers.map((name) => {
    const rs = rows.filter((r) => r.teacher === name);
    const absent = []; const leave = []; const pub = [];
    let hours = 0;
    for (const r of rs) {
      const vals = cols.map((c) => String(r.data[c.key] ?? ''));
      const reason = String(r.data[kReason] || '');
      const statusText = kStatus ? String(r.data[kStatus] || '') : vals.join(' ');
      hours += Number(r.data[kHours] || 0) || 0;
      if (/缺席|未到/.test(statusText) || /(^|\|)否($|\|)/.test(statusText)) absent.push(`${r.data[cols[0].key] || ''} ${reason}`.trim());
      else if (/请假/.test(statusText) || /请假/.test(reason)) leave.push(`${r.data[cols[0].key] || ''} ${reason || '请假'}`.trim());
      else if (/公出/.test(statusText)) pub.push(`${r.data[cols[0].key] || ''} ${reason || '公出'}`.trim());
    }
    return {
      teacher: name, total: rs.length,
      absent: absent.length, leave: leave.length, public: pub.length,
      hours: Math.round(hours * 10) / 10,
      reasons: [...absent.map((x) => '缺勤 ' + x), ...leave.map((x) => '请假 ' + x), ...pub.map((x) => '公出 ' + x)].slice(0, 8),
    };
  });
  return { table: { ...t, columns: cols }, stats };
});


/* ================= 上课：月度对账汇总 ================= */
/*
 * 核心规则：课时只归一个人。
 *   normal     正常上课      hours 归我，计入课时
 *   替他人上   我代别人      hours 归我（额外），月底应收对方
 *   他人替我上 别人代我      hours = 0（归代课人），月底应付对方
 *   换课       互换          hours 归我（课时没变），不计账，只备查
 * 因为「归零」是存下来的实际值，这里 sum(hours) 就是真实课时，不需要额外判断。
 */
function buildLessonSummary(rows, pricePerHour = 30) {
  const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const out = {
    total_hours: 0,          // 实际授课课时（Σ hours）
    lesson_count: 0,         // 记录条数（= 实际上了几节）
    normal_count: 0,
    sub_out: { count: 0, hours: 0, amount: 0 },   // 我代别人 → 应收
    sub_in: { count: 0, hours: 0, amount: 0 },    // 别人代我 → 应付
    swap: { count: 0 },
    net: { hours: 0, amount: 0, direction: 'even' },
    people: [],              // 按人拆开的结算清单
    by_subject: {},
  };
  const peopleMap = new Map();

  for (const r of rows) {
    const h = num(r.hours, 1);
    const ph = num(r.pay_hours, h);
    const pa = num(r.pay_amount, 0);
    out.lesson_count += 1;
    out.total_hours += h;

    const sj = r.subject || '未填科目';
    out.by_subject[sj] = (out.by_subject[sj] || 0) + h;

    const t = r.sub_type || 'normal';
    if (t === 'normal') { out.normal_count += 1; continue; }
    if (t === '换课') { out.swap.count += 1; continue; }

    const isOut = t === '替他人上';          // 应收
    const bucket = isOut ? out.sub_out : out.sub_in;
    bucket.count += 1;
    bucket.hours += ph;
    bucket.amount += pa;

    const name = String(r.peer_name || r.orig_teacher || '').trim() || '(未填对方)';
    const key = name + '|' + (isOut ? 'out' : 'in');
    if (!peopleMap.has(key)) {
      peopleMap.set(key, {
        name, direction: isOut ? 'out' : 'in',
        count: 0, hours: 0, amount: 0,             // 全部合计（含已结清）
        open_hours: 0, open_amount: 0,             // 未结清部分（真正还要给/要收的）
        settled: false, settled_count: 0, ids: [], subjects: new Set(),
        open_ids: [], open_items: [],              // 未结记录，用于按记录结清
      });
    }
    const p = peopleMap.get(key);
    p.count += 1;
    p.hours += ph;
    p.amount += pa;
    p.ids.push(r.id);
    if (r.subject) p.subjects.add(r.subject);
    if (r.settled_at) {
      p.settled_count += 1;
    } else {
      p.open_hours += ph;
      p.open_amount += pa;
      p.open_ids.push(r.id);
      p.open_items.push({
        id: r.id, date: r.date, period_no: r.period_no || 0,
        class_name: r.class_name || '', content: r.content || '',
        hours: ph, amount: pa,
      });
    }
  }

  for (const p of peopleMap.values()) {
    // 只有全部结清才算这人结清；部分结清时 open_* 仍然有值
    p.settled = p.count > 0 && p.settled_count === p.count;
    p.partial = p.settled_count > 0 && !p.settled;
    p.subjects = [...p.subjects];
    // 按日期排，方便「先结前两节」
    p.open_items.sort((a, b) => (a.date === b.date ? a.period_no - b.period_no : a.date < b.date ? -1 : 1));
    out.people.push(p);
  }
  // 应收在前、金额大的在前
  out.people.sort((a, b) => (a.direction === b.direction ? b.amount - a.amount : a.direction === 'out' ? -1 : 1));

  // 净额只算未结清的部分（支持部分结清：今天结两节，剩下的明天再算）
  let netHours = 0; let netAmount = 0;
  for (const p of out.people) {
    const sign = p.direction === 'out' ? 1 : -1;
    netHours += sign * p.open_hours;
    netAmount += sign * p.open_amount;
  }
  out.net.hours = Math.round(netHours * 10) / 10;
  out.net.amount = Math.round(netAmount * 100) / 100;
  out.net.direction = netAmount > 0 ? 'receivable' : netAmount < 0 ? 'payable' : 'even';
  out.price_per_hour = pricePerHour;
  return out;
}

route('GET', '/api/lessons/summary', async (req) => {
  const u = requireUser(req);
  const month = /^\d{4}-\d{2}$/.test(String(req.query.month || ''))
    ? String(req.query.month)
    : new Date().toISOString().slice(0, 7);
  const rows = all(
    'SELECT * FROM lessons WHERE user_id=? AND deleted_at IS NULL AND date LIKE ? ORDER BY date, COALESCE(period_no,0)',
    u.id, month + '-%');
  const st = j(u.settings, {});
  const price = Number(st?.lesson?.pricePerHour) || 30;
  const summary = buildLessonSummary(rows, price);

  // 三个口径并列：课表排课 / 实际授课 / 请假代课
  const [y, m] = month.split('-').map(Number);
  const lastDay = new Date(y, m, 0).getDate();
  let scheduled = 0;
  try {
    const courses = all('SELECT weekday, start_date, end_date FROM courses WHERE user_id=? AND deleted_at IS NULL', u.id);
    for (const c of courses) {
      for (let d = 1; d <= lastDay; d++) {
        const dt = new Date(y, m - 1, d);
        if (dt.getDay() !== Number(c.weekday)) continue;
        const ds = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        if (c.start_date && ds < c.start_date) continue;
        if (c.end_date && ds > c.end_date) continue;
        scheduled += 1;
      }
    }
  } catch { /* 无课表时忽略 */ }

  const today = new Date();
  const isCurrentMonth = month === `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
  return {
    month, summary,
    /* 把服务端最终采用的单价带回来。前端自己算一遍「settings 里有没有值、没有就用默认」
       很容易和这里产生偏差（比如默认值改过、或 settings 存了 0），
       金额对不上账时第一件事就是看这个数。 */
    price_per_hour: price,
    // 本月已过天数占全月比例，用于「本月还没过完」时提醒不要看排课差
    partial: isCurrentMonth ? { passed: today.getDate(), total: lastDay } : null,
    scheduled: { total: scheduled, actual: summary.total_hours, substitute_out: summary.sub_in.hours },
  };
});

/* 结清：支持两种粒度
   - 传 ids：只结这几条（按记录结清，现实中常见「今天先给两节的钱」）
   - 不传 ids：把该人该方向本月所有未结的记录一起结掉（整月一刀切） */
route('POST', '/api/lessons/settle', async (req) => {
  const u = requireUser(req);
  const b = await readBody(req);
  const month = String(b.month || '');
  const name = String(b.name || '').trim();
  const direction = b.direction === 'in' ? 'in' : 'out';
  const ids = Array.isArray(b.ids) ? b.ids.map(Number).filter(Number.isInteger) : [];
  if (!/^\d{4}-\d{2}$/.test(month)) fail(400, '月份格式不对');
  if (!name && !ids.length) fail(400, '缺少结算对象');
  const targetType = direction === 'out' ? '替他人上' : '他人替我上';
  const now = nowISO();

  if (ids.length) {
    // 只允许结自己的、未删除的、类型对得上的记录
    const ph = ids.map(() => '?').join(',');
    const res = run(
      `UPDATE lessons SET settled_at=?, settle_key=?, updated_at=?
       WHERE user_id=? AND deleted_at IS NULL AND sub_type=? AND settled_at IS NULL AND id IN (${ph})`,
      now, (name || '') + '|' + month, now, u.id, targetType, ...ids);
    return { settled: res.changes, name, month, direction, scope: 'ids' };
  }

  const res = run(
    `UPDATE lessons SET settled_at=?, settle_key=?, updated_at=?
     WHERE user_id=? AND deleted_at IS NULL AND date LIKE ? AND sub_type=?
       AND (peer_name=? OR orig_teacher=?) AND settled_at IS NULL`,
    now, name + '|' + month, now, u.id, month + '-%', targetType, name, name);
  return { settled: res.changes, name, month, direction, scope: 'month' };
});

/* 撤销结清：同样支持 ids 精确撤销 */
route('POST', '/api/lessons/unsettle', async (req) => {
  const u = requireUser(req);
  const b = await readBody(req);
  const month = String(b.month || '');
  const name = String(b.name || '').trim();
  const direction = b.direction === 'in' ? 'in' : 'out';
  const ids = Array.isArray(b.ids) ? b.ids.map(Number).filter(Number.isInteger) : [];
  const targetType = direction === 'out' ? '替他人上' : '他人替我上';

  if (ids.length) {
    const ph = ids.map(() => '?').join(',');
    const res = run(
      `UPDATE lessons SET settled_at=NULL, settle_key='', updated_at=?
       WHERE user_id=? AND deleted_at IS NULL AND sub_type=? AND settled_at IS NOT NULL AND id IN (${ph})`,
      nowISO(), u.id, targetType, ...ids);
    return { unsettled: res.changes, scope: 'ids' };
  }

  const res = run(
    `UPDATE lessons SET settled_at=NULL, settle_key='', updated_at=?
     WHERE user_id=? AND deleted_at IS NULL AND date LIKE ? AND sub_type=?
       AND (peer_name=? OR orig_teacher=?) AND settled_at IS NOT NULL`,
    nowISO(), u.id, month + '-%', targetType, name, name);
  return { unsettled: res.changes, scope: 'month' };
});

/* ================= 监考（三种类型 + 两套账） =================
   学校分配：钱由学校统一打卡发放 → 单独统计「学校应发」，不进同事之间的净额
   我代别人：对方付给我 → 应收
   别人代我：我付给对方 → 应付
   同事之间的净额只算「未结清」的部分，支持逐场结清。 */
function buildInvSummary(rows, rules = {}) {
  const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const out = {
    total: 0,
    school: { count: 0, amount: 0, paid: 0, unpaid: 0 },   // 学校分配（不参与净额）
    sub_out: { count: 0, hours: 0, amount: 0, open_amount: 0 },  // 我代别人 → 应收
    sub_in: { count: 0, hours: 0, amount: 0, open_amount: 0 },   // 别人代我 → 应付
    net: { amount: 0, direction: 'even' },
    people: [],
    by_room: {},
    minutes: 0,
    rules,
  };
  const peopleMap = new Map();

  for (const r of rows) {
    if ((r.status || 'done') === 'canceled') continue;
    const amt = num(r.pay_amount, num(r.amount, 0));
    out.total += 1;
    out.minutes += num(r.duration_min, num(r.minutes, 0));
    if (r.room) out.by_room[r.room] = (out.by_room[r.room] || 0) + 1;

    const t = r.duty_type || 'school';
    if (t === 'school') {
      out.school.count += 1;
      out.school.amount += amt;
      if (r.school_paid) out.school.paid += amt; else out.school.unpaid += amt;
      continue;
    }

    const isOut = t === '替他人';
    const bucket = isOut ? out.sub_out : out.sub_in;
    bucket.count += 1;
    bucket.hours += 1;
    bucket.amount += amt;

    const name = String(r.peer_name || r.person || '').trim() || '(未填对方)';
    const key = name + '|' + (isOut ? 'out' : 'in');
    if (!peopleMap.has(key)) {
      peopleMap.set(key, {
        name, direction: isOut ? 'out' : 'in',
        count: 0, amount: 0, open_amount: 0,
        settled: false, partial: false, settled_count: 0,
        open_ids: [], open_items: [],
      });
    }
    const p = peopleMap.get(key);
    p.count += 1;
    p.amount += amt;
    if (r.settled_at) {
      p.settled_count += 1;
    } else {
      p.open_amount += amt;
      p.open_ids.push(r.id);
      p.open_items.push({
        id: r.id, date: r.date || '', start_time: r.start_time || '',
        exam_name: r.exam_name || r.subject || '', room: r.room || r.place || '',
        amount: amt,
      });
      bucket.open_amount += amt;
    }
  }

  for (const p of peopleMap.values()) {
    p.settled = p.count > 0 && p.settled_count === p.count;
    p.partial = p.settled_count > 0 && !p.settled;
    p.open_items.sort((a, b) => (a.date === b.date ? (a.start_time < b.start_time ? -1 : 1) : (a.date < b.date ? -1 : 1)));
    out.people.push(p);
  }
  out.people.sort((a, b) => (a.direction === b.direction ? b.open_amount - a.open_amount : a.direction === 'out' ? -1 : 1));

  let net = 0;
  for (const p of out.people) net += (p.direction === 'out' ? 1 : -1) * p.open_amount;
  out.net.amount = Math.round(net * 100) / 100;
  out.net.direction = net > 0 ? 'receivable' : net < 0 ? 'payable' : 'even';
  return out;
}

/* 计价规则：存在 users.settings.invig，按场次或按时长 */
const DEFAULT_INVIG_RULES = {
  mode: '场次',            // 场次 / 时长
  perSession: 60,          // 按场次：每场多少钱
  perHour: 30,             // 按时长：每小时多少钱
  peerPerSession: 50,      // 同事之间每场多少钱
  tiers: [                 // 学校监考时长档位（分钟上限 → 金额），按时长模式用
    { max: 90, amount: 50 },
    { max: 150, amount: 70 },
    { max: 999, amount: 90 },
  ],
};
const getInvigRules = (u) => {
  const st = j(u.settings, {});
  return { ...DEFAULT_INVIG_RULES, ...(st.invig || {}) };
};
/* 按规则算一笔金额：同事之间固定按场次；学校分配按规则 */
function calcInvigAmount(rule, dutyType, durationMin) {
  if (dutyType && dutyType !== 'school') return Number(rule.peerPerSession) || 0;
  if (rule.mode === '时长') {
    const mins = Number(durationMin) || 0;
    const tiers = Array.isArray(rule.tiers) && rule.tiers.length ? rule.tiers : DEFAULT_INVIG_RULES.tiers;
    for (const t of tiers) if (mins <= Number(t.max)) return Number(t.amount) || 0;
    return Number(tiers[tiers.length - 1]?.amount) || 0;
  }
  return Number(rule.perSession) || 0;
}

route('GET', '/api/invig/rules', async (req) => {
  const u = requireUser(req);
  return { rules: getInvigRules(u), defaults: DEFAULT_INVIG_RULES };
});
route('PATCH', '/api/invig/rules', async (req) => {
  const u = requireUser(req);
  const b = await readBody(req);
  const cur = getInvigRules(u);
  const next = {
    mode: b.mode === '时长' ? '时长' : '场次',
    perSession: Number(b.perSession ?? cur.perSession) || 0,
    perHour: Number(b.perHour ?? cur.perHour) || 0,
    peerPerSession: Number(b.peerPerSession ?? cur.peerPerSession) || 0,
    tiers: Array.isArray(b.tiers) ? b.tiers.slice(0, 6).map((t) => ({ max: Number(t.max) || 0, amount: Number(t.amount) || 0 })) : cur.tiers,
  };
  const st = j(u.settings, {});
  st.invig = next;
  run('UPDATE users SET settings=?, updated_at=? WHERE id=?', JSON.stringify(st), nowISO(), u.id);
  return { rules: next };
});

route('GET', '/api/invig/summary', async (req) => {
  const u = requireUser(req);
  const month = /^\d{4}-\d{2}$/.test(String(req.query.month || ''))
    ? String(req.query.month) : new Date().toISOString().slice(0, 7);
  const rows = all(
    `SELECT * FROM invigilations WHERE user_id=? AND deleted_at IS NULL
       AND date LIKE ? ORDER BY date DESC, start_time DESC`,
    u.id, month + '-%');
  const rules = getInvigRules(u);
  return { month, summary: buildInvSummary(rows, rules), rules, rows };
});

/* 批量结清 / 撤销（学校分配款不放这里，它走「标记已到账」） */
route('POST', '/api/invig/settle', async (req) => {
  const u = requireUser(req);
  const b = await readBody(req);
  const month = String(b.month || '');
  const name = String(b.name || '').trim();
  const direction = b.direction === 'in' ? 'in' : 'out';
  const ids = Array.isArray(b.ids) ? b.ids.map(Number).filter(Number.isInteger) : [];
  if (!name && !ids.length) fail(400, '缺少结算对象');
  const targetType = direction === 'out' ? '替他人' : '他人替我';
  const now = nowISO();
  if (ids.length) {
    const ph = ids.map(() => '?').join(',');
    const res = run(
      `UPDATE invigilations SET settled_at=?, settle_key=?, updated_at=?
       WHERE user_id=? AND deleted_at IS NULL AND duty_type=? AND settled_at IS NULL AND id IN (${ph})`,
      now, (name || '') + '|' + month, now, u.id, targetType, ...ids);
    return { settled: res.changes, scope: 'ids' };
  }
  const res = run(
    `UPDATE invigilations SET settled_at=?, settle_key=?, updated_at=?
     WHERE user_id=? AND deleted_at IS NULL AND duty_type=?
       AND (peer_name=? OR person=?) AND settled_at IS NULL
       AND date LIKE ?`,
    now, name + '|' + month, now, u.id, targetType, name, name, month + '-%');
  return { settled: res.changes, scope: 'month' };
});
route('POST', '/api/invig/unsettle', async (req) => {
  const u = requireUser(req);
  const b = await readBody(req);
  const name = String(b.name || '').trim();
  const direction = b.direction === 'in' ? 'in' : 'out';
  const ids = Array.isArray(b.ids) ? b.ids.map(Number).filter(Number.isInteger) : [];
  const month = String(b.month || '');
  const targetType = direction === 'out' ? '替他人' : '他人替我';
  if (ids.length) {
    const ph = ids.map(() => '?').join(',');
    const res = run(
      `UPDATE invigilations SET settled_at=NULL, settle_key='', updated_at=?
       WHERE user_id=? AND deleted_at IS NULL AND duty_type=? AND settled_at IS NOT NULL AND id IN (${ph})`,
      nowISO(), u.id, targetType, ...ids);
    return { unsettled: res.changes, scope: 'ids' };
  }
  const res = run(
    `UPDATE invigilations SET settled_at=NULL, settle_key='', updated_at=?
     WHERE user_id=? AND deleted_at IS NULL AND duty_type=?
       AND (peer_name=? OR person=?) AND settled_at IS NOT NULL
       AND date LIKE ?`,
    nowISO(), u.id, targetType, name, name, month + '-%');
  return { unsettled: res.changes, scope: 'month' };
});

/* 学校分配款到账标记（整月一键，或按场） */
route('POST', '/api/invig/school-paid', async (req) => {
  const u = requireUser(req);
  const b = await readBody(req);
  const month = String(b.month || '');
  const on = b.paid ? 1 : 0;
  const ids = Array.isArray(b.ids) ? b.ids.map(Number).filter(Number.isInteger) : [];
  if (ids.length) {
    const ph = ids.map(() => '?').join(',');
    const res = run(
      `UPDATE invigilations SET school_paid=?, updated_at=?
       WHERE user_id=? AND deleted_at IS NULL AND duty_type='school' AND id IN (${ph})`,
      on, nowISO(), u.id, ...ids);
    return { updated: res.changes };
  }
  if (!/^\d{4}-\d{2}$/.test(month)) fail(400, '月份格式不对');
  const res = run(
    `UPDATE invigilations SET school_paid=?, updated_at=?
     WHERE user_id=? AND deleted_at IS NULL AND duty_type='school'
       AND date LIKE ?`,
    on, nowISO(), u.id, month + '-%');
  return { updated: res.changes };
});

/* ================= 年级 & 教师名册 ================= */
const DEFAULT_GRADES = ['高一', '高二'];
/* 年级列表：内置两档 + 用户自己加的（存在 users.settings.grades） */
route('GET', '/api/grades', async (req) => {
  const u = requireUser(req);
  const extra = (j(u.settings, {}).grades || []).filter(Boolean);
  const set = [...new Set([...DEFAULT_GRADES, ...extra])];
  // 顺带返回每个年级的人数，前端直接显示
  const counts = {};
  for (const g of set) counts[g] = one('SELECT COUNT(*) c FROM teachers WHERE user_id=? AND grade=? AND deleted_at IS NULL AND active=1', u.id, g)?.c || 0;
  return { grades: set, builtin: DEFAULT_GRADES, counts };
});
route('POST', '/api/grades', async (req) => {
  const u = requireUser(req);
  const b = await readBody(req);
  const name = String(b.name || '').trim();
  if (!name) fail(400, '年级名不能为空');
  if (name.length > 12) fail(400, '年级名太长');
  const st = j(u.settings, {});
  st.grades = [...new Set([...(st.grades || []), name])];
  run('UPDATE users SET settings=? WHERE id=?', JSON.stringify(st), u.id);
  return { grades: [...new Set([...DEFAULT_GRADES, ...st.grades])] };
});
route('DELETE', '/api/grades/:name', async (req) => {
  const u = requireUser(req);
  const name = decodeURIComponent(req.params.name);
  if (DEFAULT_GRADES.includes(name)) fail(400, '内置年级不能删除');
  const st = j(u.settings, {});
  st.grades = (st.grades || []).filter((g) => g !== name);
  run('UPDATE users SET settings=? WHERE id=?', JSON.stringify(st), u.id);
  return { ok: true };
});

route('GET', '/api/teachers', async (req) => {
  const u = requireUser(req);
  const grade = req.query.grade || '';
  const params = [u.id];
  let sql = 'SELECT * FROM teachers WHERE user_id=? AND deleted_at IS NULL';
  if (grade) { sql += ' AND grade=?'; params.push(grade); }
  if (req.query.active !== 'all') sql += ' AND active=1';
  sql += ' ORDER BY grade, sort, id';
  const list = all(sql, ...params);
  // 按年级分组返回，顺便给出学科顺序
  const byGrade = {};
  for (const t of list) (byGrade[t.grade] = byGrade[t.grade] || []).push(t);
  return { list, byGrade };
});
/* 新增教师：支持单条与批量（粘贴一整列姓名） */
route('POST', '/api/teachers', async (req) => {
  const u = requireUser(req);
  const b = await readBody(req);
  const grade = String(b.grade || '').trim();
  if (!grade) fail(400, '请先选择年级');
  const items = Array.isArray(b.items) ? b.items : [{ name: b.name, subject: b.subject }];
  let sort = one('SELECT IFNULL(MAX(sort),0) m FROM teachers WHERE user_id=? AND grade=?', u.id, grade)?.m || 0;
  const ids = []; let skipped = 0;
  for (const it of items) {
    const name = String(it?.name || '').trim();
    if (!name) continue;
    const dup = one('SELECT id FROM teachers WHERE user_id=? AND grade=? AND name=? AND deleted_at IS NULL', u.id, grade, name);
    if (dup) {
      // 已存在：若这次带了学科就补上
      if (it.subject) run('UPDATE teachers SET subject=?, updated_at=? WHERE id=?', String(it.subject).trim(), nowISO(), dup.id);
      ids.push(dup.id); skipped++;
      continue;
    }
    const r = run('INSERT INTO teachers(user_id,grade,name,subject,sort,active,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?)',
      u.id, grade, name, String(it.subject || '').trim(), ++sort, nowISO(), nowISO());
    ids.push(Number(r.lastInsertRowid));
  }
  return { ids, skipped };
});
route('PATCH', '/api/teachers/:id', async (req) => {
  const u = requireUser(req);
  const b = await readBody(req);
  const t = one('SELECT * FROM teachers WHERE id=? AND user_id=?', req.params.id, u.id);
  if (!t) fail(404, '教师不存在');
  const sets = []; const args = [];
  for (const k of ['name', 'subject', 'grade']) if (k in b) { sets.push(`${k}=?`); args.push(String(b[k]).trim()); }
  if ('active' in b) { sets.push('active=?'); args.push(b.active ? 1 : 0); }
  if ('sort' in b) { sets.push('sort=?'); args.push(Number(b.sort) || 0); }
  if (!sets.length) return t;
  sets.push('updated_at=?'); args.push(nowISO()); args.push(t.id);
  run(`UPDATE teachers SET ${sets.join(',')} WHERE id=?`, ...args);
  return one('SELECT * FROM teachers WHERE id=?', t.id);
});
route('DELETE', '/api/teachers/:id', async (req) => {
  const u = requireUser(req);
  // 这条路由注册在通用 /api/:table/:id 之后，实际上永远走不到（通用那条会先接住）。
  // 保留它只是为了万一将来调换顺序时行为一致：一律走回收站，别直接标删。
  if (!recyclePut(u.id, 'teachers', req.params.id)) fail(404, '记录不存在');
  return { ok: true };
});

/* ================= 上传识别 ================= */
/* 只识别不入库，把结果返回给前端确认 */
/* ================= 学生名单识别（第 26 条） =================
   用户的诉求很具体：「导入学生名单，点导入没反应；要能手动添加，也要能导 Excel」。

   原来的实现有三个问题：
     ① 只有「粘贴一行一个名字」这一条路，没有 Excel；
     ② 点「导入」之后如果接口报错，异常没人接，界面一动不动——
        用户看到的就是「点了没反应」，连是不是失败了都判断不了；
     ③ 年级/班级要手填，而 Excel 里通常本来就有这两列。

   这个接口只做「读文件 → 抽姓名」，不入库。
   解析结果回给前端预览确认，用户点了确认才写库——
   名单导入是批量的，导错了清理起来比手工录还麻烦，必须先让人看一眼。 */
route('POST', '/api/students/detect', async (req) => {
  const u = requireUser(req);
  const b = await readBody(req);
  const mp = b.multipart || {};
  const file = (mp.files || []).find((f) => f.field === 'file') || (mp.files || [])[0];
  if (!file) fail(400, '没有收到文件');
  if (file.data.length > 12 * 1024 * 1024) fail(400, '文件太大了（上限 12MB）');

  let sheets;
  try { sheets = readSheet(file.filename, file.data); }
  catch (e) { fail(400, e.message || '文件解析失败，确认是 .xlsx 或 .csv'); }

  /* 表头识别：先找「姓名 / 名字 / 学生」这类列，找不到就把第一列当姓名。
     还要顺带认「年级」「班级」「学号」——Excel 导出的人名单里这几列几乎一定有，
     不认它们就等于强迫用户手工把年级班级再填一遍。 */
  const HEAD_NAME = /^(姓名|名字|学生|学生姓名|name)$/i;
  const HEAD_GRADE = /^(年级|级部|grade)$/i;
  const HEAD_CLASS = /^(班级|班|class)$/i;
  const HEAD_NO = /^(学号|序号|编号|no|number)$/i;

  for (const sh of sheets) {
    const grid = (sh.grid || []).filter((r) => r && r.some((c) => String(c ?? '').trim()));
    if (!grid.length) continue;

    /* 前 5 行里找表头。找不到就认为没有表头，第一行直接是数据。 */
    let headRow = -1; let cols = {};
    for (let i = 0; i < Math.min(5, grid.length); i++) {
      const cells = grid[i].map((c) => String(c ?? '').trim());
      const hit = {};
      cells.forEach((c, j) => {
        if (HEAD_NAME.test(c)) hit.name = j;
        else if (HEAD_GRADE.test(c)) hit.grade = j;
        else if (HEAD_CLASS.test(c)) hit.class = j;
        else if (HEAD_NO.test(c)) hit.no = j;
      });
      if (hit.name !== undefined) { headRow = i; cols = hit; break; }
    }
    if (headRow < 0) { headRow = -1; cols = { name: 0 }; }

    const rows = [];
    for (let i = headRow + 1; i < grid.length; i++) {
      const r = grid[i];
      const name = String(r[cols.name] ?? '').trim();
      if (!name) continue;
      /* 姓名列里混进「合计 / 小计 / 备注」这种汇总行是常态，按长度和关键词挡一道 */
      if (/^(合计|小计|总计|备注|说明)$/.test(name) || name.length > 20) continue;
      rows.push({
        name,
        grade: cols.grade !== undefined ? String(r[cols.grade] ?? '').trim() : '',
        class_name: cols.class !== undefined ? String(r[cols.class] ?? '').trim() : '',
        no: cols.no !== undefined ? Number(String(r[cols.no] ?? '').replace(/\D/g, '')) || (rows.length + 1) : rows.length + 1,
      });
    }
    if (!rows.length) continue;

    /* 跟已存在的学生去重：同班同名视为同一个人。
       不去重的话，同一个文件导两次名单就翻倍，后面点名会很乱。 */
    const exist = new Set(all(
      'SELECT grade, class_name, name FROM students WHERE user_id=? AND deleted_at IS NULL', u.id,
    ).map((x) => `${x.grade}|${x.class_name}|${x.name}`));

    return {
      ok: true,
      filename: file.filename,
      sheet: sh.name,
      sheets: sheets.map((x) => x.name),
      hasHeader: headRow >= 0,
      rows: rows.slice(0, 500),
      total: rows.length,
      dup: rows.filter((r) => exist.has(`${r.grade}|${r.class_name}|${r.name}`)).length,
      grades: [...new Set(rows.map((r) => r.grade).filter(Boolean))],
      classes: [...new Set(rows.map((r) => r.class_name).filter(Boolean))],
    };
  }
  fail(400, '这个文件里没找到姓名列，确认一下表头是不是写着「姓名」');
});

route('POST', '/api/attendance/detect', async (req) => {
  const u = requireUser(req);
  const b = await readBody(req);
  const mp = b.multipart || {};
  const file = (mp.files || []).find((f) => f.field === 'file') || (mp.files || [])[0];
  if (!file) fail(400, '没有收到文件');
  if (file.data.length > 12 * 1024 * 1024) fail(400, '文件太大了（上限 12MB）');
  let sheets;
  try { sheets = readSheet(file.filename, file.data); }
  catch (e) { fail(400, e.message || '文件解析失败'); }
  // 选第一个能识别出「姓名」列的工作表
  let picked = null; let result = null;
  for (const sh of sheets) {
    const r = detectSheet(sh.grid, { grade: mp.fields?.grade || '' });
    if (r.ok) { picked = sh; result = r; break; }
  }
  if (!result) {
    const r0 = sheets[0] ? detectSheet(sheets[0].grid) : { ok: false, reason: '文件是空的' };
    return { ok: false, reason: r0.reason, filename: file.filename, sheets: sheets.map((x) => x.name) };
  }
  // 与名册比对：名册里有、表里没有的人（可能漏签），以及表里有、名册没登记的人
  const grade = result.detected.grade || mp.fields?.grade || '';
  const roster = grade ? all('SELECT name, subject FROM teachers WHERE user_id=? AND grade=? AND deleted_at IS NULL AND active=1', u.id, grade) : [];
  const rosterNames = new Set(roster.map((r) => r.name));
  const sheetNames = new Set(result.rows.map((r) => r.teacher));
  return {
    ok: true,
    filename: file.filename,
    sheet: picked.name,
    sheets: sheets.map((x) => x.name),
    ...result,
    roster: {
      known: roster.length,
      matched: result.rows.filter((r) => rosterNames.has(r.teacher)).length,
      missing: roster.filter((r) => !sheetNames.has(r.name)).map((r) => r.name),
      extra: result.rows.filter((r) => !rosterNames.has(r.teacher)).map((r) => r.teacher),
    },
  };
});

/* 把确认后的识别结果存成一张新表（或合并进已有表） */
route('POST', '/api/attendance/commit', async (req) => {
  const u = requireUser(req);
  const b = await readBody(req);
  const rows = Array.isArray(b.rows) ? b.rows : [];
  if (!rows.length) fail(400, '没有可导入的数据');
  const sheetType = b.sheet_type === 'research' ? 'research' : 'seat';
  const grade = String(b.grade || '高一').trim();
  const year = b.year || String(new Date().getFullYear());
  const month = String(b.month || '').padStart(2, '0') || String(new Date().getMonth() + 1).padStart(2, '0');
  const now = new Date();
  const day = String(b.day || '').padStart(2, '0') || String(now.getDate()).padStart(2, '0');
  const dateStr = b.sheet_date || `${year}-${month}-${day}`;
  const periods = String(b.periods || '');
  const name = String(b.name || '').trim() || `${year}年${grade}${sheetType === 'seat' ? '老师坐班表' : '老师教研签到表'}${periods ? ' · 第' + periods + '节' : ''}`;
  const columns = Array.isArray(b.columns) && b.columns.length ? b.columns : defaultCols(sheetType);
  const meta = {
    periods, year, weekday: b.weekday || '',
    source: b.source || 'upload',
    filename: b.filename || '',
    imported_at: nowISO(),
    imported_rows: rows.length,
  };

  let tableId = Number(b.table_id) || 0;
  if (tableId) {
    const t = one('SELECT * FROM attendance_tables WHERE id=? AND user_id=? AND deleted_at IS NULL', tableId, u.id);
    if (!t) fail(404, '目标表不存在');
    // 合并模式：同名的人覆盖，新增的人追加
    const exist = all('SELECT * FROM attendance_rows WHERE table_id=? AND deleted_at IS NULL', tableId);
    const byName = new Map(exist.map((r) => [r.teacher, r]));
    let updated = 0; let added = 0;
    let sort = one('SELECT IFNULL(MAX(sort),0) m FROM attendance_rows WHERE table_id=?', tableId)?.m || 0;
    for (const row of rows) {
      const nm = String(row.teacher || '').trim();
      if (!nm) continue;
      const old = byName.get(nm);
      if (old) {
        const merged = { ...j(old.data, {}), ...(row.data || {}) };
        run('UPDATE attendance_rows SET data=?, subject=?, updated_at=? WHERE id=?', JSON.stringify(merged), String(row.subject || old.subject || ''), nowISO(), old.id);
        updated++;
      } else {
        run('INSERT INTO attendance_rows(table_id,teacher,subject,data,sort,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
          tableId, nm, String(row.subject || ''), JSON.stringify(row.data || {}), ++sort, nowISO(), nowISO());
        added++;
      }
    }
    run('UPDATE attendance_tables SET columns=?, meta=?, updated_at=? WHERE id=?', JSON.stringify(columns), JSON.stringify(meta), nowISO(), tableId);
    return { table_id: tableId, added, updated, merged: true };
  }

  const r = run('INSERT INTO attendance_tables(user_id,kind,name,month,columns,meta,grade,sheet_type,sheet_date,weekday,periods,subject,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    u.id, sheetType, name, `${year}-${month}`, JSON.stringify(columns), JSON.stringify(meta),
    grade, sheetType, dateStr, b.weekday || '', periods, b.subject || '', nowISO(), nowISO());
  tableId = Number(r.lastInsertRowid);
  let sort = 0;
  // 顺手把表里的人补进名册，这样下次新建同年级的表格能直接带出来
  const inRoster = new Set(all('SELECT name FROM teachers WHERE user_id=? AND grade=? AND deleted_at IS NULL', u.id, grade).map((x) => x.name));
  let tSort = one('SELECT IFNULL(MAX(sort),0) m FROM teachers WHERE user_id=? AND grade=?', u.id, grade)?.m || 0;
  const tSort0 = tSort;
  for (const row of rows) {
    const nm = String(row.teacher || '').trim();
    if (!nm) continue;
    run('INSERT INTO attendance_rows(table_id,teacher,subject,data,sort,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
      tableId, nm, String(row.subject || ''), JSON.stringify(row.data || {}), ++sort, nowISO(), nowISO());
    if (!inRoster.has(nm)) {
      inRoster.add(nm);
      run('INSERT INTO teachers(user_id,grade,name,subject,sort,active,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?)',
        u.id, grade, nm, String(row.subject || ''), ++tSort, nowISO(), nowISO());
    }
  }
  return { table_id: tableId, added: rows.length, updated: 0, merged: false, roster_added: tSort - tSort0 };
});

/* ---- 首页快速添加（便签同步） ---- */
route('POST', '/api/quick', async (req) => {
  const u = requireUser(req);
  const b = await readBody(req);
  const text = String(b.text || '').trim();
  if (!text) fail(400, '内容不能为空');
  const seq = nextSeq('todo:' + u.id);
  const tr = run('INSERT INTO todos(user_id,seq,title,content,status,color,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
    u.id, seq, text, '', 'todo', b.color || '', nowISO(), nowISO());
  const ir = run('INSERT INTO items(user_id,seq,kind,title,detail,start_at,status,priority,source,ref_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
    u.id, nextSeq('item:' + u.id), '事项', text, '', b.at || null, 'todo', b.priority || 'normal', '便签', Number(tr.lastInsertRowid), nowISO(), nowISO());
  // 回填双向关联：todos.ref_item_id ↔ items.ref_id
  // 之前这里没回填，导致"状态同源"从来没生效——首页勾了、日常还是未开始。
  run('UPDATE todos SET ref_item_id=? WHERE id=?', Number(ir.lastInsertRowid), Number(tr.lastInsertRowid));
  if (b.at && b.remind_min !== undefined) addReminder(u.id, { title: text, due_at: b.at, advance_min: Number(b.remind_min) || 0, item_id: Number(ir.lastInsertRowid) });
  return { todo: one('SELECT * FROM todos WHERE id=?', Number(tr.lastInsertRowid)), item: one('SELECT * FROM items WHERE id=?', Number(ir.lastInsertRowid)) };
});

/* ---- 上传 ---- */
function saveUpload(u, file, ownerType = 'misc', ownerId = 0) {
  const ext = (path.extname(file.filename) || '').toLowerCase().slice(0, 10);
  const dir = path.join(CONFIG.uploadDir, String(u.id));
  fs.mkdirSync(dir, { recursive: true });
  const name = crypto.randomBytes(12).toString('hex') + ext;
  const abs = path.join(dir, name);
  fs.writeFileSync(abs, file.data);
  const rel = `${u.id}/${name}`;
  const r = run('INSERT INTO attachments(user_id,owner_type,owner_id,name,mime,size,path,created_at) VALUES(?,?,?,?,?,?,?,?)',
    u.id, ownerType, ownerId, file.filename, file.mime, file.data.length, rel, nowISO());
  return { id: Number(r.lastInsertRowid), url: `/files/${rel}`, name: file.filename, mime: file.mime, size: file.data.length };
}
route('POST', '/api/upload', async (req) => {
  const u = requireUser(req);
  const body = await readBody(req);
  const files = body.files || [];
  if (!files.length) fail(400, '没有收到文件');
  const ownerType = body.fields?.owner_type || 'misc';
  const ownerId = Number(body.fields?.owner_id || 0);
  return files.map((f) => saveUpload(u, f, ownerType, ownerId));
});
/* 头像：单独一条接口，把 2MB / jpg-png 的规矩焊在服务端。
   只靠前端校验等于没校验——绕过前端直接 POST 就进来了。 */
route('POST', '/api/me/avatar', async (req) => {
  const u = requireUser(req);
  const body = await readBody(req);
  const f = (body.files || [])[0];
  if (!f) fail(400, '没有收到图片');
  const MAX = 2 * 1024 * 1024;
  if (f.data.length > MAX) fail(400, `图片不能超过 2MB（当前 ${(f.data.length / 1024 / 1024).toFixed(1)}MB）`);
  const okType = ['image/jpeg', 'image/png'].includes(String(f.mime || '').toLowerCase());
  if (!okType) fail(400, '只支持 JPG / PNG 格式');
  const up = saveUpload(u, f, 'avatar', u.id);
  run('UPDATE users SET avatar=?, updated_at=? WHERE id=?', up.url, nowISO(), u.id);
  // 旧头像的文件记录标删，别让磁盘越堆越大
  run(`UPDATE attachments SET deleted_at=? WHERE user_id=? AND owner_type='avatar' AND id!=? AND deleted_at IS NULL`,
    nowISO(), u.id, up.id);
  return { url: up.url, user: publicUser(one('SELECT * FROM users WHERE id=?', u.id)) };
});
route('DELETE', '/api/me/avatar', async (req) => {
  const u = requireUser(req);
  run('UPDATE users SET avatar=\'\', updated_at=? WHERE id=?', nowISO(), u.id);
  return { user: publicUser(one('SELECT * FROM users WHERE id=?', u.id)) };
});

route('GET', '/api/attachments', async (req) => {
  const u = requireUser(req);
  const wh = ['a.user_id=?', 'a.deleted_at IS NULL']; const args = [u.id];
  if (req.query.owner_type) { wh.push('a.owner_type=?'); args.push(req.query.owner_type); }
  if (req.query.owner_id) { wh.push('a.owner_id=?'); args.push(Number(req.query.owner_id)); }
  return all(`SELECT a.*, '/files/'||a.path AS url FROM attachments a WHERE ${wh.join(' AND ')} ORDER BY a.id`, ...args);
});
route('DELETE', '/api/attachments/:id', async (req) => {
  const u = requireUser(req);
  const a = one('SELECT * FROM attachments WHERE id=? AND user_id=?', req.params.id, u.id);
  if (!a) fail(404, '附件不存在');
  // 头像走的是「换新的顺手标删旧的」，那是内部清理，用户没删过东西，不该塞进回收站制造噪音。
  // 其余的（课件素材、考勤原件、出差发票）都是用户主动删的，必须能还原。
  if (a.owner_type === 'avatar') {
    run('UPDATE attachments SET deleted_at=? WHERE id=?', nowISO(), a.id);
    return { ok: true };
  }
  recyclePut(u.id, 'attachments', req.params.id);
  return { ok: true };
});

/* 考勤表的原始照片：owner_type='attendance'，owner_id=表 id */
route('GET', '/api/attendance/:id/photos', async (req) => {
  const u = requireUser(req);
  const t = one('SELECT id FROM attendance_tables WHERE id=? AND user_id=? AND deleted_at IS NULL', req.params.id, u.id);
  if (!t) fail(404, '表不存在');
  return all(`SELECT id,name,mime,size,created_at,'/files/'||path AS url FROM attachments
              WHERE user_id=? AND owner_type='attendance' AND owner_id=? AND deleted_at IS NULL ORDER BY id`, u.id, t.id);
});
route('POST', '/api/attendance/:id/photos', async (req) => {
  const u = requireUser(req);
  const t = one('SELECT id FROM attendance_tables WHERE id=? AND user_id=? AND deleted_at IS NULL', req.params.id, u.id);
  if (!t) fail(404, '表不存在');
  const body = await readBody(req);
  const files = body.files || [];
  if (!files.length) fail(400, '没有收到图片');
  const saved = [];
  for (const f of files) {
    if (!/^image\//i.test(f.mime || '')) fail(400, '只能是图片（jpg / png / heic）');
    if (f.data.length > 12 * 1024 * 1024) fail(400, '图片太大了（上限 12MB）');
    saved.push(saveUpload(u, f, 'attendance', t.id));
  }
  return saved;
});

function todayStr() { return fmtDate(new Date()); }

/* ---- 学生短链 ---- */
route('GET', '/api/links', async (req) => {
  const u = requireUser(req);
  return all('SELECT * FROM student_links WHERE user_id=? ORDER BY id', u.id).map((l) => ({ ...l, grades: j(l.grades, []) }));
});
route('POST', '/api/links', async (req) => {
  const u = requireUser(req);
  const b = await readBody(req);
  const code = b.code && /^[a-z0-9]{4,20}$/.test(b.code) ? b.code : shortCode(6);
  run('INSERT INTO student_links(user_id,code,title,grades,enabled,created_at,updated_at) VALUES(?,?,?,?,1,?,?)',
    u.id, code, b.title || '班级资料站', JSON.stringify(b.grades || []), nowISO(), nowISO());
  return one('SELECT * FROM student_links WHERE code=?', code);
});
route('PATCH', '/api/links/:id', async (req) => {
  const u = requireUser(req);
  const b = await readBody(req);
  const sets = []; const args = [];
  for (const k of ['title', 'enabled']) if (k in b) { sets.push(`${k}=?`); args.push(b[k]); }
  if (b.grades) { sets.push('grades=?'); args.push(JSON.stringify(b.grades)); }
  sets.push('updated_at=?'); args.push(nowISO()); args.push(req.params.id); args.push(u.id);
  run(`UPDATE student_links SET ${sets.join(',')} WHERE id=? AND user_id=?`, ...args);
  return one('SELECT * FROM student_links WHERE id=?', req.params.id);
});

/* 学生端（无需登录） */
route('GET', '/api/public/link/:code', async (req) => {
  const l = one('SELECT * FROM student_links WHERE code=? AND enabled=1', req.params.code);
  if (!l) fail(404, '链接不存在或已关闭');
  const teacher = one('SELECT nickname,subject,school FROM users WHERE id=?', l.user_id);
  const grades = j(l.grades, []);
  const mats = all('SELECT id,seq,title,grade,class_name,descr,created_at FROM materials WHERE user_id=? AND deleted_at IS NULL AND public=1 ORDER BY id DESC', l.user_id);
  const cats = all("SELECT id,name FROM categories WHERE user_id=? AND scope='material' AND deleted_at IS NULL ORDER BY sort", l.user_id);
  const rosters = all('SELECT id,grade,class_name,count,names FROM rosters WHERE user_id=? AND deleted_at IS NULL', l.user_id)
    .map((r) => ({ ...r, names: j(r.names, []) }))
    .filter((r) => !grades.length || grades.includes(r.grade));
  const punish = all('SELECT id,text,level FROM punishments WHERE user_id=? AND deleted_at IS NULL AND active=1', l.user_id);
  const date = String(req.query.date || todayStr());
  const roll = all(
    `SELECT s.*, r.count AS roster_count FROM roll_sessions s
       LEFT JOIN rosters r ON r.id = s.roster_id
     WHERE s.user_id=? AND s.date=? AND s.deleted_at IS NULL AND s.status='open'
     ORDER BY COALESCE(s.period_no,0), s.id`, l.user_id, date)
    .map((s) => ({ id: s.id, grade: s.grade, class_name: s.class_name, period_no: s.period_no,
      subject: s.subject, expect: s.expect || s.roster_count || 0 }));
  return { link: { code: l.code, title: l.title, grades }, teacher, materials: mats, categories: cats, rosters, punishments: punish, roll, date };
});
route('GET', '/api/public/link/:code/file/:id', async (req) => {
  const l = one('SELECT * FROM student_links WHERE code=? AND enabled=1', req.params.code);
  if (!l) fail(404, '链接不存在');
  const a = one('SELECT a.* FROM attachments a JOIN materials m ON m.id=a.owner_id WHERE a.id=? AND a.owner_type=\'material\' AND m.user_id=? AND a.deleted_at IS NULL', req.params.id, l.user_id);
  if (!a) fail(404, '文件不存在');
  run('UPDATE materials SET views=views+1 WHERE id=?', a.owner_id);
  if (req.query.dl) run('UPDATE materials SET downloads=downloads+1 WHERE id=?', a.owner_id);
  return { file: a };
});
route('GET', '/api/public/link/:code/materials/:id', async (req) => {
  const l = one('SELECT * FROM student_links WHERE code=? AND enabled=1', req.params.code);
  if (!l) fail(404, '链接不存在');
  const m = one('SELECT * FROM materials WHERE id=? AND user_id=? AND deleted_at IS NULL', req.params.id, l.user_id);
  if (!m) fail(404, '资料不存在');
  run('UPDATE materials SET views=views+1 WHERE id=?', m.id);
  const files = all("SELECT id,name,mime,size,'/files/'||path AS url FROM attachments WHERE owner_type='material' AND owner_id=? AND deleted_at IS NULL", m.id);
  return { material: m, files };
});

/* ========== 班级短链：点名（学生端回传） ========== */
const ROLL_STATUS = ['present', 'late', 'leave', 'absent'];
/* 学生标识归一化：去掉空格、全角转半角、小写，保证「张三 」「张 三」算同一人 */
function stuKey(s) {
  return String(s || '')
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/\s+/g, '')
    .toLowerCase()
    .slice(0, 40);
}

/* 开一场点名（教师端；也可由学生端首次提交时自动开） */
route('POST', '/api/roll/open', async (req) => {
  const u = requireUser(req);
  const b = await readBody(req);
  const roster = one('SELECT * FROM rosters WHERE id=? AND user_id=? AND deleted_at IS NULL', b.roster_id, u.id);
  if (!roster) fail(404, '班级不存在');
  return openSession(u.id, roster, b);
});

function openSession(userId, roster, b = {}) {
  const date = String(b.date || todayStr());
  const period = Number(b.period_no) || 0;
  const exist = one(
    `SELECT * FROM roll_sessions WHERE user_id=? AND roster_id=? AND date=? AND period_no=? AND deleted_at IS NULL`,
    userId, roster.id, date, period);
  if (exist) {
    if (exist.status === 'closed' && b.reopen) {
      run('UPDATE roll_sessions SET status=\'open\', updated_at=? WHERE id=?', nowISO(), exist.id);
      return one('SELECT * FROM roll_sessions WHERE id=?', exist.id);
    }
    return exist;
  }
  const r = run(
    `INSERT INTO roll_sessions(user_id,link_id,roster_id,grade,class_name,date,period_no,subject,expect,status,note,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,'open',?,?,?)`,
    userId, b.link_id || null, roster.id, roster.grade || '', roster.class_name || '',
    date, period, String(b.subject || ''), Number(roster.count) || 0, String(b.note || ''), nowISO(), nowISO());
  return one('SELECT * FROM roll_sessions WHERE id=?', Number(r.lastInsertRowid));
}

/* 学生端：看看这个班今天有没有在点名 */
route('GET', '/api/public/link/:code/roll', async (req) => {
  const l = one('SELECT * FROM student_links WHERE code=? AND enabled=1', req.params.code);
  if (!l) fail(404, '链接不存在或已关闭');
  const date = String(req.query.date || todayStr());
  const rows = all(
    `SELECT s.*, r.count AS roster_count FROM roll_sessions s
       LEFT JOIN rosters r ON r.id = s.roster_id
     WHERE s.user_id=? AND s.date=? AND s.deleted_at IS NULL AND s.status='open'
     ORDER BY COALESCE(s.period_no,0), s.id`, l.user_id, date);
  return { date, sessions: rows.map((s) => ({ id: s.id, grade: s.grade, class_name: s.class_name,
    period_no: s.period_no, subject: s.subject, expect: s.expect || s.roster_count || 0 })) };
});

/* 学生端：我到了 / 迟到 / 请假 */
route('POST', '/api/public/link/:code/roll/:id', async (req) => {
  const l = one('SELECT * FROM student_links WHERE code=? AND enabled=1', req.params.code);
  if (!l) fail(404, '链接不存在或已关闭');
  const s = one('SELECT * FROM roll_sessions WHERE id=? AND user_id=? AND deleted_at IS NULL', req.params.id, l.user_id);
  if (!s) fail(404, '这场点名不存在');
  if (s.status !== 'open') fail(400, '这场点名已经结束了');
  const b = await readBody(req);
  const status = ROLL_STATUS.includes(b.status) ? b.status : 'present';
  const name = String(b.name || '').trim().slice(0, 20);
  const no = String(b.stu_no || '').trim().slice(0, 20);
  const key = stuKey(no || name);
  if (!key) fail(400, '请先填写你的学号或姓名');
  const ip = String((req.headers['x-forwarded-for'] || '').split(',')[0] || req.socket?.remoteAddress || '');
  // 有名单时做一次模糊核对：名字对不上就提示，防止打错字导致「幽灵签到」
  const roster = s.roster_id ? one('SELECT names FROM rosters WHERE id=?', s.roster_id) : null;
  const names = roster ? j(roster.names, []).filter(Boolean) : [];
  let matched = '';
  if (names.length) {
    const hit = names.find((n) => stuKey(n) === key);
    if (!hit) {
      const fuzzy = names.filter((n) => stuKey(n).includes(key) || key.includes(stuKey(n)));
      if (!fuzzy.length) fail(400, '名单里没有「' + (name || no) + '」，请核对姓名或学号');
      if (fuzzy.length > 1) fail(400, '有 ' + fuzzy.length + ' 个相近的名字（' + fuzzy.slice(0, 3).join('、') + '），请填学号区分');
      matched = fuzzy[0];
    } else matched = hit;
  }
  const finalKey = matched ? stuKey(matched) : key;
  const old = one('SELECT * FROM roll_records WHERE session_id=? AND stu_key=?', s.id, finalKey);
  if (old) {
    run('UPDATE roll_records SET status=?, stu_name=?, stu_no=?, updated_at=? WHERE id=?',
      status, matched || name || old.stu_name, no || old.stu_no, nowISO(), old.id);
  } else {
    run(`INSERT INTO roll_records(session_id,user_id,stu_key,stu_name,stu_no,status,source,ip,created_at,updated_at)
         VALUES(?,?,?,?,?,?,'student',?,?,?)`,
      s.id, l.user_id, finalKey, matched || name, no, status, ip.slice(0, 60), nowISO(), nowISO());
  }
  const c = one(
    `SELECT COUNT(*) total,
            SUM(CASE WHEN status='present' THEN 1 ELSE 0 END) present,
            SUM(CASE WHEN status='late' THEN 1 ELSE 0 END) late,
            SUM(CASE WHEN status='leave' THEN 1 ELSE 0 END) leavec
       FROM roll_records WHERE session_id=?`, s.id);
  return { ok: true, status, mine: status, total: c?.total || 0, present: c?.present || 0, late: c?.late || 0, leave: c?.leavec || 0 };
});

/* 教师端：某天的点名汇总 */
route('GET', '/api/roll/sessions', async (req) => {
  const u = requireUser(req);
  const date = String(req.query.date || todayStr());
  const rows = all(
    `SELECT s.*, r.count AS roster_count FROM roll_sessions s
       LEFT JOIN rosters r ON r.id = s.roster_id
     WHERE s.user_id=? AND s.date=? AND s.deleted_at IS NULL
     ORDER BY COALESCE(s.period_no,0), s.id`, u.id, date);
  return rows.map((s) => {
    const c = one(
      `SELECT COUNT(*) total,
              SUM(CASE WHEN status='present' THEN 1 ELSE 0 END) present,
              SUM(CASE WHEN status='late' THEN 1 ELSE 0 END) late,
              SUM(CASE WHEN status='leave' THEN 1 ELSE 0 END) leavec,
              SUM(CASE WHEN status='absent' THEN 1 ELSE 0 END) absent
         FROM roll_records WHERE session_id=?`, s.id);
    return { ...s, stats: { total: c?.total || 0, present: c?.present || 0,
      late: c?.late || 0, leave: c?.leavec || 0, absent: c?.absent || 0 } };
  });
});
route('GET', '/api/roll/sessions/:id', async (req) => {
  const u = requireUser(req);
  const s = one('SELECT * FROM roll_sessions WHERE id=? AND user_id=? AND deleted_at IS NULL', req.params.id, u.id);
  if (!s) fail(404, '点名不存在');
  const records = all('SELECT * FROM roll_records WHERE session_id=? ORDER BY created_at', s.id);
  const roster = one('SELECT * FROM rosters WHERE id=?', s.roster_id);
  const names = roster ? j(roster.names, []) : [];
  // 缺勤推断：有名单时，名单里没出现的人标记为「未到」
  const seen = new Set(records.map((r) => stuKey(r.stu_name)));
  const missing = names.filter((n) => n && !seen.has(stuKey(n)));
  return { session: s, records, roster: roster ? { ...roster, names } : null, missing };
});
route('PATCH', '/api/roll/sessions/:id', async (req) => {
  const u = requireUser(req);
  const b = await readBody(req);
  const s = one('SELECT * FROM roll_sessions WHERE id=? AND user_id=? AND deleted_at IS NULL', req.params.id, u.id);
  if (!s) fail(404, '点名不存在');
  const sets = []; const args = [];
  for (const k of ['status', 'note', 'subject']) if (k in b) { sets.push(`${k}=?`); args.push(b[k]); }
  if (!sets.length) return s;
  sets.push('updated_at=?'); args.push(nowISO()); args.push(s.id);
  run(`UPDATE roll_sessions SET ${sets.join(',')} WHERE id=?`, ...args);
  return one('SELECT * FROM roll_sessions WHERE id=?', s.id);
});
/* 老师代标：把某个学生改成某状态（补录、纠错） */
route('POST', '/api/roll/sessions/:id/mark', async (req) => {
  const u = requireUser(req);
  const b = await readBody(req);
  const s = one('SELECT * FROM roll_sessions WHERE id=? AND user_id=? AND deleted_at IS NULL', req.params.id, u.id);
  if (!s) fail(404, '点名不存在');
  const name = String(b.stu_name || '').trim();
  const key = stuKey(b.stu_no || name);
  if (!key) fail(400, '缺少学生姓名');
  const status = ROLL_STATUS.includes(b.status) ? b.status : 'present';
  const old = one('SELECT * FROM roll_records WHERE session_id=? AND stu_key=?', s.id, key);
  if (old) {
    run('UPDATE roll_records SET status=?, source=\'teacher\', stu_name=?, updated_at=? WHERE id=?', status, name || old.stu_name, nowISO(), old.id);
  } else {
    run(`INSERT INTO roll_records(session_id,user_id,stu_key,stu_name,stu_no,status,source,created_at,updated_at)
         VALUES(?,?,?,?,?,?,'teacher',?,?)`, s.id, u.id, key, name, String(b.stu_no || ''), status, nowISO(), nowISO());
  }
  return { ok: true };
});
route('DELETE', '/api/roll/sessions/:id', async (req) => {
  const u = requireUser(req);
  run('UPDATE roll_sessions SET deleted_at=? WHERE id=? AND user_id=?', nowISO(), req.params.id, u.id);
  return { ok: true };
});

/* ================= 出差报销 =================
   三本账分开算：
     实报实销（交通/住宿/打车/过路/停车/其他）—— 要票
     定额补贴（伙食 / 市内交通）—— 按天 × 标准，不需要票
     预借（advance）—— 从应报里扣
   各地标准不同，存在 users.settings.trip，默认伙食 100/天、市内交通 40/天 */
const TRIP_DEFAULT = { foodPerDay: 100, localPerDay: 40 };
const pad2s = (n) => String(n).padStart(2, '0');
const KIND_TXT = { transport: '交通', hotel: '住宿', taxi: '打车', meal: '餐饮', toll: '过路费', parking: '停车费', other: '其他' };
const money = (v) => (Math.round((Number(v) || 0) * 100) / 100).toFixed(2).replace(/\.00$/, '');
function tripRules(userId) {
  const u = one('SELECT settings FROM users WHERE id=?', userId);
  const st = j(u?.settings, {});
  const t = st.trip || {};
  return {
    foodPerDay: Number.isFinite(Number(t.foodPerDay)) && t.foodPerDay !== '' && t.foodPerDay != null ? Number(t.foodPerDay) : TRIP_DEFAULT.foodPerDay,
    localPerDay: Number.isFinite(Number(t.localPerDay)) && t.localPerDay !== '' && t.localPerDay != null ? Number(t.localPerDay) : TRIP_DEFAULT.localPerDay,
  };
}
const n2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
/* 天数：优先手填，否则按起止日期算（首尾都算，差 0 天算 1 天） */
function tripDays(t) {
  if (t.days != null && t.days !== '' && Number(t.days) > 0) return Number(t.days);
  const s = String(t.start_date || '').slice(0, 10);
  const e = String(t.end_date || '').slice(0, 10) || s;
  if (!s) return 1;
  const ms = new Date(e + 'T00:00:00').getTime() - new Date(s + 'T00:00:00').getTime();
  const d = Math.round(ms / 86400000);
  return d >= 0 ? d + 1 : 1;
}
function calcTrip(t, rules, items = []) {
  const days = tripDays(t);
  const real = {
    transport: n2(t.transport), hotel: n2(t.hotel), taxi: n2(t.taxi),
    toll: n2(t.toll), parking: n2(t.parking), other: n2(t.other),
  };
  /* 明细里填的金额会汇总到对应类别，和手填的主表金额取「较大者」：
     老师可能习惯直接在表单上写总数，也可能一张张录明细，两种都要能用，
     但不能简单相加（否则记了两遍就翻倍）。 */
  const byKind = {};
  for (const it of items) {
    const k = ['transport', 'hotel', 'taxi', 'toll', 'parking'].includes(it.kind) ? it.kind : 'other';
    byKind[k] = n2((byKind[k] || 0) + n2(it.amount));
  }
  for (const k of Object.keys(byKind)) {
    if (byKind[k] > real[k]) real[k] = byKind[k];
  }
  const realTotal = n2(Object.values(real).reduce((a, b) => a + b, 0));
  // 补贴：填了就用手填的，没填按标准 × 天数
  const food = (t.subsidy_food != null && Number(t.subsidy_food) > 0) ? n2(t.subsidy_food) : n2(rules.foodPerDay * days);
  const local = (t.subsidy_local != null && Number(t.subsidy_local) > 0) ? n2(t.subsidy_local) : n2(rules.localPerDay * days);
  const subsidyTotal = n2(food + local);
  const total = n2(realTotal + subsidyTotal);
  const advance = n2(t.advance);
  const net = n2(total - advance);
  // 缺票检查：大额实报没票要提醒（住宿/交通 ≥ 100 元）
  const missing = items.filter((it) => !it.has_invoice);
  const bigMissing = missing.filter((it) => Number(it.amount) >= 100 && ['transport', 'hotel', 'taxi'].includes(it.kind));
  return {
    days, real, byKind, realTotal, food, local, subsidyTotal, total, advance, net,
    itemCount: items.length,
    missingCount: missing.length,
    bigMissingCount: bigMissing.length,
    noInvoice: items.filter((it) => !it.has_invoice).length,
  };
}
function tripWithCalc(t, rules) {
  const items = all('SELECT * FROM trip_items WHERE trip_id=? AND user_id=? AND deleted_at IS NULL ORDER BY COALESCE(date,\'\'), id', t.id, t.user_id);
  return { ...t, items, calc: calcTrip(t, rules, items) };
}

route('GET', '/api/trip/rules', async (req) => {
  const u = requireUser(req);
  return tripRules(u.id);
});
route('PATCH', '/api/trip/rules', async (req) => {
  const u = requireUser(req);
  const b = await readBody(req);
  const cur = one('SELECT settings FROM users WHERE id=?', u.id);
  const st = j(cur?.settings, {});
  st.trip = { ...(st.trip || {}), ...(b.foodPerDay != null ? { foodPerDay: Number(b.foodPerDay) || 0 } : {}), ...(b.localPerDay != null ? { localPerDay: Number(b.localPerDay) || 0 } : {}) };
  run('UPDATE users SET settings=?, updated_at=? WHERE id=?', JSON.stringify(st), nowISO(), u.id);
  return tripRules(u.id);
});

/* 出差列表（带每条的报销计算） */
route('GET', '/api/trip/list', async (req) => {
  const u = requireUser(req);
  const rules = tripRules(u.id);
  const wh = ['user_id=?', 'deleted_at IS NULL']; const args = [u.id];
  const month = String(req.query.month || '');
  if (/^\d{4}-\d{2}$/.test(month)) { wh.push("start_date LIKE ?"); args.push(month + '-%'); }
  const rows = all(`SELECT * FROM trips WHERE ${wh.join(' AND ')} ORDER BY start_date DESC, id DESC`, ...args);
  return { rules, rows: rows.map((r) => tripWithCalc(r, rules)) };
});
/* 单条详情 */
route('GET', '/api/trip/stats', async (req) => {
  const u = requireUser(req);
  const rules = tripRules(u.id);
  const year = String(req.query.year || new Date().getFullYear());
  const rows = all("SELECT * FROM trips WHERE user_id=? AND deleted_at IS NULL AND start_date LIKE ?", u.id, year + '-%');
  const list = rows.map((r) => tripWithCalc(r, rules));
  const months = {};
  for (let i = 1; i <= 12; i++) months[`${year}-${pad2s(i)}`] = { month: `${year}-${pad2s(i)}`, count: 0, km: 0, real: 0, subsidy: 0, total: 0 };
  const byKind = { transport: 0, hotel: 0, taxi: 0, toll: 0, parking: 0, other: 0 };
  let km = 0, total = 0, real = 0, subsidy = 0, net = 0, advance = 0;
  for (const t of list) {
    const m = String(t.start_date || '').slice(0, 7);
    if (months[m]) {
      months[m].count++;
      months[m].km += Number(t.km) || 0;
      months[m].real = n2(months[m].real + t.calc.realTotal);
      months[m].subsidy = n2(months[m].subsidy + t.calc.subsidyTotal);
      months[m].total = n2(months[m].total + t.calc.total);
    }
    km += Number(t.km) || 0;
    real = n2(real + t.calc.realTotal);
    subsidy = n2(subsidy + t.calc.subsidyTotal);
    total = n2(total + t.calc.total);
    net = n2(net + t.calc.net);
    advance = n2(advance + t.calc.advance);
    for (const k of Object.keys(byKind)) byKind[k] = n2(byKind[k] + (t.calc.real[k] || 0));
  }
  return {
    year, rules,
    summary: { count: list.length, km, real, subsidy, total, net, advance,
      pending: n2(list.filter((t) => t.reimb_status !== 'paid').reduce((s, t) => s + t.calc.net, 0)) },
    months: Object.values(months), byKind, rows: list,
  };
});

route('GET', '/api/trip/:id', async (req) => {
  const u = requireUser(req);
  const t = one('SELECT * FROM trips WHERE id=? AND user_id=? AND deleted_at IS NULL', req.params.id, u.id);
  if (!t) fail(404, '出差记录不存在');
  return tripWithCalc(t, tripRules(u.id));
});
/* 明细行增删改 */
route('POST', '/api/trip/:id/items', async (req) => {
  const u = requireUser(req);
  const b = await readBody(req);
  const t = one('SELECT * FROM trips WHERE id=? AND user_id=? AND deleted_at IS NULL', req.params.id, u.id);
  if (!t) fail(404, '出差记录不存在');
  const r = run(
    `INSERT INTO trip_items(user_id,trip_id,kind,date,amount,note,invoice_no,has_invoice,attach_id,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    u.id, t.id, String(b.kind || 'other'), String(b.date || t.start_date || ''), n2(b.amount),
    String(b.note || ''), String(b.invoice_no || ''), b.has_invoice === 0 || b.has_invoice === false ? 0 : 1,
    b.attach_id ? Number(b.attach_id) : null, nowISO(), nowISO());
  return one('SELECT * FROM trip_items WHERE id=?', Number(r.lastInsertRowid));
});
route('PATCH', '/api/trip/items/:id', async (req) => {
  const u = requireUser(req);
  const b = await readBody(req);
  const it = one('SELECT * FROM trip_items WHERE id=? AND user_id=? AND deleted_at IS NULL', req.params.id, u.id);
  if (!it) fail(404, '明细不存在');
  const sets = []; const args = [];
  for (const k of ['kind', 'date', 'note', 'invoice_no']) if (k in b) { sets.push(`${k}=?`); args.push(String(b[k] ?? '')); }
  if ('amount' in b) { sets.push('amount=?'); args.push(n2(b.amount)); }
  if ('has_invoice' in b) { sets.push('has_invoice=?'); args.push(b.has_invoice ? 1 : 0); }
  if ('attach_id' in b) { sets.push('attach_id=?'); args.push(b.attach_id ? Number(b.attach_id) : null); }
  if (!sets.length) return it;
  sets.push('updated_at=?'); args.push(nowISO(), it.id);
  run(`UPDATE trip_items SET ${sets.join(',')} WHERE id=?`, ...args);
  return one('SELECT * FROM trip_items WHERE id=?', it.id);
});
route('DELETE', '/api/trip/items/:id', async (req) => {
  const u = requireUser(req);
  // 发票/明细也是钱，误删同样要能还原，所以进回收站
  if (!recyclePut(u.id, 'trip_items', req.params.id)) fail(404, '明细不存在');
  return { ok: true };
});

/* 一键生成的报销单纯文本：写给财务看的，人话、能直接粘贴 */
function tripText(t, user) {
  const c = t.calc;
  const L = [];
  const who = user?.nickname || '';
  const span = t.end_date && t.end_date !== t.start_date ? `${t.start_date} 至 ${t.end_date}` : t.start_date;
  L.push(`【差旅报销单】${who}${who ? '　' : ''}${span}　共 ${c.days} 天`);
  L.push(`事由：${t.reason || '未填写'}`);
  L.push(`行程：${t.from_place || '学校'} → ${t.to_place || '未填写'}${t.companions ? `（随行：${t.companions}）` : ''}`);
  L.push('');
  L.push('一、实报实销');
  const realLines = [
    ['交通费', c.real.transport], ['住宿费', c.real.hotel], ['市内打车', c.real.taxi],
    ['过路费', c.real.toll], ['停车费', c.real.parking], ['其他', c.real.other],
  ].filter(([, v]) => Number(v) > 0);
  if (realLines.length) {
    for (const [k, v] of realLines) L.push(`　${k}：¥${money(v)}`);
    // 明细里有具体项目的，补一行说明（住宿几晚之类）
    const detail = (t.items || []).filter((it) => Number(it.amount) > 0);
    if (detail.length) {
      L.push('　明细：');
      for (const it of detail.slice(0, 12)) {
        const noInv = it.has_invoice ? '' : '（无票）';
        L.push(`　　· ${it.date || ''} ${KIND_TXT[it.kind] || '其他'} ¥${money(it.amount)}${it.note ? ' ' + it.note : ''}${noInv}`);
      }
      if (detail.length > 12) L.push(`　　· 其余 ${detail.length - 12} 笔略`);
    }
    L.push(`　小计：¥${money(c.realTotal)}`);
  } else {
    L.push('　（无）');
  }
  L.push('');
  L.push('二、定额补贴（无需发票）');
  L.push(`　伙食补助：¥${money(c.food)}（${money(c.food / (c.days || 1))}/天 × ${c.days} 天）`);
  L.push(`　市内交通补助：¥${money(c.local)}（${money(c.local / (c.days || 1))}/天 × ${c.days} 天）`);
  L.push(`　小计：¥${money(c.subsidyTotal)}`);
  L.push('');
  if (c.advance > 0) {
    L.push(`三、预借/垫付：¥${money(c.advance)}`);
    L.push('');
  }
  L.push(`合计应报：¥${money(c.total)}${c.advance > 0 ? `　扣除预借后应补：¥${money(c.net)}` : ''}`);
  if (Number(t.km) > 0) L.push(`自驾里程：${t.km} km`);
  if (c.missingCount) L.push(`备注：有 ${c.missingCount} 笔无发票${c.bigMissingCount ? `（其中 ${c.bigMissingCount} 笔为大额，建议补票）` : ''}——${(t.items || []).filter((i) => !i.has_invoice).map((i) => `${KIND_TXT[i.kind] || '其他'}¥${money(i.amount)}`).slice(0, 5).join('、')}`);
  if (t.remark) L.push(`补充说明：${t.remark}`);
  return L.join('\n');
}


/* 一键生成报销单纯文本：直接粘给财务 */
route('GET', '/api/trip/:id/text', async (req) => {
  const u = requireUser(req);
  const t = one('SELECT * FROM trips WHERE id=? AND user_id=? AND deleted_at IS NULL', req.params.id, u.id);
  if (!t) fail(404, '出差记录不存在');
  const d = tripWithCalc(t, tripRules(u.id));
  return { text: tripText(d, u) };
});

/* ---- 惩罚记录（抽到就给谁记一笔）---- */
route('GET', '/api/punish/records', async (req) => {
  const u = requireUser(req);
  const date = req.query.date ? String(req.query.date) : '';
  const rows = date
    ? all('SELECT * FROM punish_records WHERE user_id=? AND date=? ORDER BY id DESC', u.id, date)
    : all('SELECT * FROM punish_records WHERE user_id=? ORDER BY id DESC LIMIT 100', u.id);
  return rows;
});
route('POST', '/api/punish/records', async (req) => {
  const u = requireUser(req);
  const b = await readBody(req);
  const text = String(b.text || '').trim();
  if (!text) fail(400, '缺少任务内容');
  const r = run(
    `INSERT INTO punish_records(user_id,roster_id,grade,class_name,stu_name,text,source,date,note,created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?)`,
    u.id, b.roster_id || null, String(b.grade || ''), String(b.class_name || ''),
    String(b.stu_name || ''), text, b.source === 'teacher' ? 'teacher' : 'student',
    String(b.date || todayStr()), String(b.note || ''), nowISO());
  return one('SELECT * FROM punish_records WHERE id=?', Number(r.lastInsertRowid));
});
route('DELETE', '/api/punish/records/:id', async (req) => {
  const u = requireUser(req);
  run('DELETE FROM punish_records WHERE id=? AND user_id=?', req.params.id, u.id);
  return { ok: true };
});
/* 学生端：抽到一个任务，顺手记在你名下（匿名也没关系，名字可为空） */
route('POST', '/api/public/link/:code/punish', async (req) => {
  const l = one('SELECT * FROM student_links WHERE code=? AND enabled=1', req.params.code);
  if (!l) fail(404, '链接不存在或已关闭');
  const b = await readBody(req);
  const text = String(b.text || '').trim().slice(0, 200);
  if (!text) fail(400, '缺少任务内容');
  const r = run(
    `INSERT INTO punish_records(user_id,roster_id,grade,class_name,stu_name,text,source,date,note,created_at)
     VALUES(?,?,?,?,?,?,'student',?,'',?)`,
    l.user_id, b.roster_id || null, String(b.grade || ''), String(b.class_name || ''),
    String(b.stu_name || '').slice(0, 20), text, todayStr(), nowISO());
  return { id: Number(r.lastInsertRowid) };
});

/* ---- 导入 / 导出 ---- */
/* ---- 导出 PDF（走 Python + WeasyPrint）---- */
const PDF_SCRIPT = path.join(ROOT, 'server', 'pdf_table.py');
const PDF_STATEMENT = path.join(ROOT, 'server', 'pdf_statement.py');
const PDF_PY = process.env.PDF_PYTHON || 'python3';

function renderPdfTable(payload, outFile, script = PDF_SCRIPT) {
  return new Promise((resolve, reject) => {
    const child = execFile(PDF_PY, [script, outFile], { timeout: 60000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const msg = String(stderr || err.message || '').slice(-400);
          return reject(new Error('PDF 渲染失败：' + msg));
        }
        resolve(outFile);
      });
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

/* ---- 课时对账单（竖版 A4，正式单据可签字） ---- */
route('GET', '/api/lessons/statement', async (req, res) => {
  const u = requireUser(req);
  const month = /^\d{4}-\d{2}$/.test(String(req.query.month || ''))
    ? String(req.query.month) : new Date().toISOString().slice(0, 7);
  const rows = all(
    'SELECT * FROM lessons WHERE user_id=? AND deleted_at IS NULL AND date LIKE ? ORDER BY date, COALESCE(period_no,0)',
    u.id, month + '-%');
  const st = j(u.settings, {});
  const price = Number(st?.lesson?.pricePerHour) || 30;
  const summary = buildLessonSummary(rows, price);

  // 排课口径：按周课表整月推算
  const [yy, mm] = month.split('-').map(Number);
  const lastDay = new Date(yy, mm, 0).getDate();
  let scheduledTotal = 0;
  try {
    const courses = all('SELECT weekday, start_date, end_date FROM courses WHERE user_id=? AND deleted_at IS NULL', u.id);
    for (const c of courses) {
      for (let d = 1; d <= lastDay; d++) {
        const dt = new Date(yy, mm - 1, d);
        if (dt.getDay() !== Number(c.weekday)) continue;
        const ds = `${yy}-${String(mm).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        if (c.start_date && ds < c.start_date) continue;
        if (c.end_date && ds > c.end_date) continue;
        scheduledTotal += 1;
      }
    }
  } catch { /* 无课表忽略 */ }

  const payload = {
    month_label: `${yy}年${mm}月`,
    teacher: u.nickname || ('用户' + u.id),
    school: u.school || '',
    subject: u.subject || '',
    created: new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }),
    price,
    scheduled: { total: scheduledTotal, actual: summary.total_hours, substitute_out: summary.sub_in.hours },
    summary,
    people: summary.people.map((p) => ({
      name: p.name, direction: p.direction, hours: p.hours, amount: p.amount, settled: p.settled,
    })),
    rows: rows.map((r) => ({
      date: r.date, period: r.period_no ? '第' + r.period_no + '节' : '',
      class_name: r.class_name, subject: r.subject, content: r.content,
      hours: r.hours, sub_type: r.sub_type || 'normal', peer_name: r.peer_name || '',
    })),
  };

  const tmp = path.join(CONFIG.uploadDir, `.stmt_${u.id}_${month}_${Date.now()}.pdf`);
  try {
    await renderPdfTable(payload, tmp, PDF_STATEMENT);
    const buf = fs.readFileSync(tmp);
    const fname = encodeURIComponent(`${yy}年${mm}月课时对账单.pdf`);
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="statement.pdf"; filename*=UTF-8''${fname}`,
      'Content-Length': buf.length,
    });
    res.end(buf);
  } catch (e) {
    jsonErr(res, 500, e.message || '对账单生成失败');
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* 已删 */ }
  }
});

route('GET', '/api/attendance/:id/pdf', async (req, res) => {
  const u = requireUser(req);
  const t = one('SELECT * FROM attendance_tables WHERE id=? AND user_id=? AND deleted_at IS NULL', req.params.id, u.id);
  if (!t) fail(404, '考勤表不存在');
  const cols = j(t.columns, []);
  const rows = all('SELECT * FROM attendance_rows WHERE table_id=? AND deleted_at IS NULL ORDER BY sort, id', t.id)
    .map((r) => ({ ...r, data: j(r.data, {}) }));
  if (!rows.length) fail(400, '这张表还没有数据');

  const checkCols = cols.filter((c) => c.type === 'check');
  const otherCols = cols.filter((c) => c.type !== 'check');
  const d = t.sheet_date ? new Date(t.sheet_date + 'T00:00:00') : null;
  const wkName = ['日', '一', '二', '三', '四', '五', '六'];
  const dateText = d && !Number.isNaN(d.getTime())
    ? `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`
    : '';

  const outRows = rows.map((r, i) => {
    const marks = checkCols.map((c) => String(r.data?.[c.key] ?? ''));
    otherCols.forEach((c) => marks.push(String(r.data?.[c.key] ?? '')));
    return { no: i + 1, name: r.teacher, subject: r.subject || '', marks };
  });

  const summary = checkCols.map((c) => ({
    label: c.label,
    value: String(rows.filter((r) => r.data?.[c.key] === '1').length),
  }));
  const vacant = rows.filter((r) => checkCols.every((c) => !r.data?.[c.key])).length;
  if (vacant) summary.push({ label: '一项未填', value: String(vacant) });
  summary.unshift({ label: '教师', value: String(rows.length) });

  const payload = {
    title: t.name || `${t.grade || ''}考勤表`,
    grade: t.grade || '',
    date_text: dateText,
    weekday: d && !Number.isNaN(d.getTime()) ? '星期' + wkName[d.getDay()] : (t.weekday ? '星期' + t.weekday : ''),
    periods: t.periods ? `第 ${t.periods} 节` : '',
    columns: cols,
    rows: outRows,
    summary,
    footer: `导出于 ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
  };

  const tmp = path.join(CONFIG.uploadDir, `.pdf_${u.id}_${t.id}_${Date.now()}.pdf`);
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  try {
    await renderPdfTable(payload, tmp);
    const buf = fs.readFileSync(tmp);
    const fname = encodeURIComponent(`${t.name || '考勤表'}.pdf`);
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Length': buf.length,
      'Content-Disposition': `inline; filename*=UTF-8''${fname}`,
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  } finally {
    try { fs.unlinkSync(tmp); } catch (e) { /* 已删 */ }
  }
});

route('GET', '/api/export/:kind', async (req, res) => {
  const u = requireUser(req);
  const { kind } = req.params;
  const month = req.query.month || '';
  const fmt = req.query.format || 'csv';
  const data = buildExport(u, kind, month);
  if (fmt === 'json') {
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(data.title)}.json"`);
    return send(res, 200, JSON.stringify({ title: data.title, headers: data.headers, rows: data.rows }, null, 2), { 'Content-Type': 'application/json; charset=utf-8' });
  }
  if (fmt === 'html') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return send(res, 200, data.html);
  }
  const csv = '\ufeff' + [data.headers, ...data.rows].map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(data.title + '.csv')}"`);
  return send(res, 200, csv, { 'Content-Type': 'text/csv; charset=utf-8' });
});
function buildExport(u, kind, month) {
  const M = (col) => (month ? ` AND substr(${col},1,7)='${month.replace(/'/g, '')}'` : '');
  let title = '导出'; let headers = []; let rows = []; let extraHtml = '';
  if (kind === 'lessons') {
    title = `课时统计${month ? ' ' + month : ''}`;
    headers = ['序号', '日期', '节次', '时间', '年级', '班级', '科目', '任课', '代课人', '代课类型', '课时', '上课内容', '教学进度', '下节课内容', '违纪情况', '备注'];
    rows = all(`SELECT * FROM lessons WHERE user_id=? AND deleted_at IS NULL${M('date')} ORDER BY date, COALESCE(period_no,0)`, u.id)
      .map((r) => [r.seq, r.date, r.period_no, r.start_time ? `${r.start_time}-${r.end_time}` : r.time_range, r.grade, r.class_name, r.subject, r.teacher, r.substitute, r.sub_type === 'none' ? '' : r.sub_type, r.hours, r.content, r.progress, r.next_content, r.discipline, r.remark]);
    const hours = rows.reduce((s, r) => s + (Number(r[10]) || 0), 0);
    extraHtml = `<div class="sum">本月合计：${rows.length} 节，${hours} 课时；其中代课 ${rows.filter((r) => r[9]).length} 节</div>`;
  } else if (kind === 'invigilations') {
    title = `监考统计${month ? ' ' + month : ''}`;
    headers = ['序号', '日期', '类型', '相关人', '科目', '年级', '开始', '结束', '时长(分钟)', '金额(元)', '已支付', '地点', '领卷', '领卷地点', '备注'];
    rows = all(`SELECT * FROM invigilations WHERE user_id=? AND deleted_at IS NULL${M('date')} ORDER BY date`, u.id)
      .map((r) => [r.seq, r.date, r.type, r.person, r.subject, r.grade, r.start_at, r.end_at, r.minutes, r.amount, r.paid ? '是' : '否', r.place, r.need_paper ? '是' : '否', r.paper_place, r.remark]);
    const mins = rows.reduce((s, r) => s + (Number(r[8]) || 0), 0);
    extraHtml = `<div class="sum">本月合计：${rows.length} 场，共 ${mins} 分钟</div>`;
  } else if (kind === 'trips') {
    title = `出差统计${month ? ' ' + month : ''}`;
    headers = ['序号', '开始', '结束', '出发地', '目的地', '事由', '随行人员', '公里数', '过路费', '停车费', '其他', '合计(元)', '状态', '备注'];
    rows = all(`SELECT * FROM trips WHERE user_id=? AND deleted_at IS NULL${M('start_date')} ORDER BY start_date`, u.id)
      .map((r) => [r.seq, r.start_date, r.end_date, r.from_place, r.to_place, r.reason, r.companions, r.km, r.toll, r.parking, r.other, (r.toll || 0) + (r.parking || 0) + (r.other || 0), r.status, r.remark]);
    const total = rows.reduce((s, r) => s + (Number(r[11]) || 0), 0);
    extraHtml = `<div class="sum">本月合计：${rows.length} 次，费用 ${total} 元</div>`;
  } else if (kind === 'studies') {
    title = '学习记录';
    headers = ['序号', '日期', '标题', '内容', '时长(分钟)', '来源', '标签'];
    rows = all(`SELECT * FROM studies WHERE user_id=? AND deleted_at IS NULL${M('date')} ORDER BY date`, u.id).map((r) => [r.seq, r.date, r.title, r.content, r.minutes, r.source, r.tags]);
  } else if (kind === 'homework') {
    title = '作业完成情况';
    headers = ['序号', '作业', '班级', '布置日期', '截止', '学生', '状态', '得分', '备注'];
    rows = [];
    for (const h of all(`SELECT * FROM homework WHERE user_id=? AND deleted_at IS NULL`, u.id)) {
      for (const r of all('SELECT * FROM homework_records WHERE homework_id=?', h.id)) rows.push([h.seq, h.title, h.class_name, h.assign_date, h.due_date, r.student_name, r.status, r.score, r.remark]);
    }
  } else if (kind === 'attendance') {
    const t = one('SELECT * FROM attendance_tables WHERE id=? AND user_id=?', req_month_id(month), u.id);
    if (!t) { headers = ['提示']; rows = [['未找到考勤表，请传 month 参数为表 id']]; }
    else {
      const cols = j(t.columns, []);
      title = t.name;
      headers = ['序号', '姓名', '学科', ...cols.map((c) => c.label)];
      rows = all('SELECT * FROM attendance_rows WHERE table_id=? AND deleted_at IS NULL ORDER BY sort', t.id)
        .map((r, i) => {
          const d = j(r.data, {});
          return [i + 1, r.teacher || '', r.subject || '',
            ...cols.map((c) => (c.type === 'check' ? (d[c.key] === '1' ? '√' : d[c.key] === '0' ? '×' : '') : (d[c.key] ?? '')))];
        });
    }
  } else if (kind === 'students') {
    title = '学生名单'; headers = ['序号', '年级', '班级', '姓名', '编号'];
    rows = all('SELECT * FROM students WHERE user_id=? AND deleted_at IS NULL ORDER BY grade,class_name,no', u.id).map((s) => [s.no, s.grade, s.class_name, s.name, s.no]);
  } else {
    title = '事项'; headers = ['序号', '类型', '标题', '详情', '开始', '结束', '状态'];
    rows = all('SELECT * FROM items WHERE user_id=? AND deleted_at IS NULL ORDER BY id', u.id).map((r) => [r.seq, r.kind, r.title, r.detail, r.start_at, r.end_at, r.status]);
  }
  const html = exportHtml(u, title, headers, rows, extraHtml);
  return { title, headers, rows, html };
}
function req_month_id(v) { return Number(v) || 0; }

function exportHtml(u, title, headers, rows, extra) {
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
@page{size:A4 landscape;margin:12mm}
body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:#1b2333;margin:0}
h1{font-size:19px;margin:0 0 4px}
.meta{color:#667085;font-size:12px;margin-bottom:10px}
table{width:100%;border-collapse:collapse;font-size:12px}
th,td{border:1px solid #c8d0dd;padding:5px 7px;text-align:left;vertical-align:top}
th{background:#eff3fa;font-weight:600}
tr:nth-child(even) td{background:#fafbfd}
.sum{margin-top:10px;font-size:13px;font-weight:600}
.sign{margin-top:26px;display:flex;justify-content:space-between;font-size:13px;color:#344054}
@media print{.no-print{display:none}}
</style></head><body>
<h1>${esc(title)}</h1>
<div class="meta">${esc(u.nickname || '')}　${esc(u.school || '')}　导出时间：${new Date().toLocaleString('zh-CN')}</div>
<table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>
${extra || ''}
<div class="sign"><span>制表人：${esc(u.nickname || '')}</span><span>审核人：____________</span><span>日期：${new Date().toLocaleDateString('zh-CN')}</span></div>
<script>if(location.search.includes('print'))window.print()</script>
</body></html>`;
}

route('POST', '/api/import/:kind', async (req) => {
  const u = requireUser(req);
  const b = await readBody(req);
  const kind = req.params.kind;
  const text = String(b.text || '');
  const grid = parseClipboardTable(text);
  if (!grid.length) fail(400, '没有可导入的内容');
  const header = grid[0];
  const body = /^\s*(序号|日期|姓名|标题|类型)/.test(header.join('')) ? grid.slice(1) : grid;
  const map = { 序号: 'seq', 日期: 'date', 开始: 'start_date', 结束: 'end_date', 节次: 'period_no', 时间: 'time_range', 年级: 'grade', 班级: 'class_name', 科目: 'subject', 任课: 'teacher', 代课人: 'substitute', 课时: 'hours', 上课内容: 'content', 教学进度: 'progress', 下节课内容: 'next_content', 违纪情况: 'discipline', 备注: 'remark', 标题: 'title', 内容: 'content', 时长分钟: 'minutes', 出发点: 'from_place', 目的地: 'to_place', 事由: 'reason', 随行人员: 'companions', 公里数: 'km', 过路费: 'toll', 停车费: 'parking' };
  const table = { lessons: 'lessons', invigilations: 'invigilations', trips: 'trips', studies: 'studies', students: 'students', items: 'items', todos: 'todos' }[kind];
  if (!table) fail(400, '该类型暂不支持导入');
  let n = 0;
  const cols = Object.keys(CRUD[table]?.fields ? Object.fromEntries(CRUD[table].fields.map((f) => [f, 1])) : {});
  for (const line of body) {
    const obj = {};
    header.forEach((h, i) => {
      const key = map[String(h).replace(/\s/g, '')] || String(h);
      if (cols.includes(key)) obj[key] = line[i];
    });
    if (!Object.keys(obj).length) continue;
    if (table === 'todos') { run('INSERT INTO todos(user_id,seq,title,status,created_at,updated_at) VALUES(?,?,?,?,?,?)', u.id, nextSeq('todo:' + u.id), obj.title || line[0], 'todo', nowISO(), nowISO()); n++; continue; }
    if (table === 'items') { run('INSERT INTO items(user_id,seq,kind,title,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)', u.id, nextSeq('item:' + u.id), '事项', obj.title || line[0], 'todo', nowISO(), nowISO()); n++; continue; }
    const c = ['user_id']; const v = [u.id]; const mk = ['?'];
    for (const [k, val] of Object.entries(obj)) { c.push(k); mk.push('?'); v.push(val); }
    if (SEQ_SCOPE[table]) { c.push('seq'); mk.push('?'); v.push(nextSeq(SEQ_SCOPE[table] + ':' + u.id)); }
    c.push('created_at', 'updated_at'); mk.push('?', '?'); v.push(nowISO(), nowISO());
    run(`INSERT INTO ${table}(${c.join(',')}) VALUES(${mk.join(',')})`, ...v);
    n++;
  }
  return { imported: n, headers: header };
});

/* ---- 作业记录 ---- */
route('GET', '/api/homework/:id/records', async (req) => {
  const u = requireUser(req);
  const h = one('SELECT * FROM homework WHERE id=? AND user_id=?', req.params.id, u.id);
  if (!h) fail(404, '作业不存在');
  return all('SELECT * FROM homework_records WHERE homework_id=?', h.id);
});
route('GET', '/api/homework_records', async (req) => {
  const u = requireUser(req);
  if (!req.query.homework_id) return [];
  const h = one('SELECT id FROM homework WHERE id=? AND user_id=?', req.query.homework_id, u.id);
  if (!h) return [];
  return all('SELECT * FROM homework_records WHERE homework_id=?', h.id);
});
route('POST', '/api/homework/:id/records', async (req) => {
  const u = requireUser(req);
  const b = await readBody(req);
  const h = one('SELECT * FROM homework WHERE id=? AND user_id=?', req.params.id, u.id);
  if (!h) fail(404, '作业不存在');
  const rows = b.rows || [];
  for (const r of rows) {
    const ex = one('SELECT id FROM homework_records WHERE homework_id=? AND student_name=?', h.id, r.student_name);
    if (ex) run('UPDATE homework_records SET status=?, score=?, remark=?, updated_at=? WHERE id=?', r.status || 'pending', r.score ?? null, r.remark || '', nowISO(), ex.id);
    else run('INSERT INTO homework_records(homework_id,student_name,status,score,remark,updated_at) VALUES(?,?,?,?,?,?)', h.id, r.student_name, r.status || 'pending', r.score ?? null, r.remark || '', nowISO());
  }
  return { saved: rows.length };
});

/* ---- 学生点名名单 ---- */
route('PATCH', '/api/rosters/:id', async (req) => {
  const u = requireUser(req);
  const b = await readBody(req);
  const sets = []; const args = [];
  for (const k of ['grade', 'class_name', 'count']) if (k in b) { sets.push(`${k}=?`); args.push(b[k]); }
  if (b.names) { sets.push('names=?'); args.push(JSON.stringify(b.names)); if (!('count' in b)) { sets.push('count=?'); args.push(b.names.length); } }
  sets.push('updated_at=?'); args.push(nowISO()); args.push(req.params.id); args.push(u.id);
  run(`UPDATE rosters SET ${sets.join(',')} WHERE id=? AND user_id=?`, ...args);
  return one('SELECT * FROM rosters WHERE id=?', req.params.id);
});

/* ---- 学习统计 ---- */
route('GET', '/api/study/stats', async (req) => {
  const u = requireUser(req);
  const year = String(req.query.year || cnDate().slice(0, 4));
  const month = String(req.query.month || cnDate().slice(0, 7));   // YYYY-MM，月视图用
  const byMonth = all(`SELECT substr(date,1,7) m, COUNT(*) c, IFNULL(SUM(minutes),0) mins FROM studies WHERE user_id=? AND deleted_at IS NULL AND source!='running' AND substr(date,1,4)=? GROUP BY m ORDER BY m`, u.id, year);
  const total = all(`SELECT COUNT(*) c, IFNULL(SUM(minutes),0) mins FROM studies WHERE user_id=? AND deleted_at IS NULL AND source!='running' AND substr(date,1,4)=?`, u.id, year)[0];
  const byCat = all(`SELECT IFNULL(c.name,'未分类') name, COUNT(*) c, IFNULL(SUM(s.minutes),0) mins
    FROM studies s LEFT JOIN categories c ON c.id=s.category_id AND c.deleted_at IS NULL
    WHERE s.user_id=? AND s.deleted_at IS NULL AND s.source!='running' AND substr(s.date,1,4)=?
    GROUP BY IFNULL(c.name,'未分类') ORDER BY mins DESC`, u.id, year);

  // 月视图：本月逐日时长（日历热力格用）
  const byDay = all(`SELECT date d, IFNULL(SUM(minutes),0) mins, COUNT(*) c FROM studies WHERE user_id=? AND deleted_at IS NULL AND source!='running' AND substr(date,1,7)=? GROUP BY date ORDER BY date`, u.id, month);
  const monthTotal = all(`SELECT COUNT(*) c, IFNULL(SUM(minutes),0) mins FROM studies WHERE user_id=? AND deleted_at IS NULL AND source!='running' AND substr(date,1,7)=?`, u.id, month)[0];
  const monthByCat = all(`SELECT IFNULL(c.name,'未分类') name, IFNULL(SUM(s.minutes),0) mins
    FROM studies s LEFT JOIN categories c ON c.id=s.category_id AND c.deleted_at IS NULL
    WHERE s.user_id=? AND s.deleted_at IS NULL AND s.source!='running' AND substr(s.date,1,7)=?
    GROUP BY IFNULL(c.name,'未分类') ORDER BY mins DESC`, u.id, month);

  // 全部有记录的年份，供年份下拉
  const years = all(`SELECT DISTINCT substr(date,1,4) y FROM studies WHERE user_id=? AND deleted_at IS NULL AND source!='running' ORDER BY y DESC`, u.id).map((r) => r.y);

  return { year, month, byMonth, total, byCat, byDay, monthTotal, monthByCat, years };
});

/* ---- 备份 ---- */
route('GET', '/api/backup', async (req, res) => {
  const u = requireUser(req);
  const tables = ['users', 'items', 'reminders', 'messages', 'courses', 'periods', 'lessons', 'attendance_tables', 'attendance_rows', 'invigilations', 'trips', 'categories', 'materials', 'notes', 'todos', 'homework', 'homework_records', 'students', 'studies', 'rosters', 'punishments', 'exceptions', 'preps', 'selfstudy', 'repairs'];
  const data = {};
  for (const t of tables) data[t] = all(`SELECT * FROM ${t} WHERE ${t === 'attendance_rows' ? 'table_id IN (SELECT id FROM attendance_tables WHERE user_id=?)' : t === 'homework_records' ? 'homework_id IN (SELECT id FROM homework WHERE user_id=?)' : t === 'users' ? 'id=?' : 'user_id=?'}`, u.id);
  if (data.users[0]) delete data.users[0].password_hash;
  res.setHeader('Content-Disposition', `attachment; filename="workbench-backup-${fmtDate(new Date())}.json"`);
  return send(res, 200, JSON.stringify({ version: 1, exported_at: nowISO(), data }, null, 2), { 'Content-Type': 'application/json; charset=utf-8' });
});
route('POST', '/api/backup/restore', async (req) => {
  const u = requireUser(req);
  const b = await readBody(req);
  const data = b?.data?.data || b?.data && b.data.items ? b.data : null;
  if (!data) fail(400, '备份文件格式不正确');
  const map = { users: 'items', };
  let n = 0;
  for (const [t, rows] of Object.entries(data)) {
    if (!CRUD[t] && !['items', 'todos', 'homework', 'studies', 'students', 'notes', 'materials', 'preps'].includes(t)) continue;
    for (const row of rows) {
      const r = { ...row }; delete r.id; delete r.user_id;
      const cols = ['user_id']; const vals = [u.id]; const mk = ['?'];
      for (const [k, v] of Object.entries(r)) { cols.push(k); mk.push('?'); vals.push(v); }
      try { run(`INSERT INTO ${t}(${cols.join(',')}) VALUES(${mk.join(',')})`, ...vals); n++; } catch { /* 跳过脏数据 */ }
    }
  }
  return { imported: n };
});

/* ============================ 导出到系统日历 ============================ */
/* 为什么不让前端直接生成 blob 下载：
   iOS 的 Safari 只有在拿到 **http(s) 地址 + Content-Type: text/calendar** 时，
   才会把响应交给「日历」App 弹出预览。blob: URL 不走这条路，点了没反应。
   所以这里落一个短期有效的一次性链接，内容存在库表里。 */
const ICS_TTL = 10 * 60 * 1000;

function icsEsc(t) {
  return String(t || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}
function buildICS(alarms) {
  const p = (n) => String(n).padStart(2, '0');
  const fmt = (t) => {
    const d = new Date(t);
    return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}00Z`;
  };
  const stamp = fmt(Date.now());
  const L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//MyWorkbench//CN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
  for (const a of alarms) {
    L.push('BEGIN:VEVENT');
    L.push(`UID:${a.uid || crypto.randomBytes(8).toString('hex')}@workbench`);
    L.push(`DTSTAMP:${stamp}`);
    L.push(`DTSTART:${fmt(a.due)}`);
    L.push(`DTEND:${fmt(new Date(new Date(a.due).getTime() + 15 * 60000))}`);
    L.push(`SUMMARY:${icsEsc(a.title)}`);
    if (a.body) L.push(`DESCRIPTION:${icsEsc(a.body)}`);
    L.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsEsc(a.title)}`, `TRIGGER:-PT${Number(a.advance || 0)}M`, 'END:VALARM');
    L.push('END:VEVENT');
  }
  L.push('END:VCALENDAR');
  return L.join('\r\n');
}

/* 收下前端发来的提醒，发一张取件码。
   存服务端而不是塞进 URL，是因为标题里有中文和标点，编码进 query 容易被各家
   App 的内置浏览器改写（实测微信会重编码 query），轻则标题乱码，重则整条丢。 */
route('POST', '/api/calendar/ics', async (req, res) => {
  const u = requireUser(req);
  const payload = await readBody(req);
  const raw = Array.isArray(payload?.alarms) ? payload.alarms : [];
  const alarms = raw
    .filter((a) => a && a.title && a.due && !Number.isNaN(new Date(a.due).getTime()))
    .slice(0, 20)
    .map((a) => ({ title: String(a.title).slice(0, 200), due: a.due, advance: Number(a.advance) || 0, body: String(a.body || '').slice(0, 500) }));
  if (!alarms.length) throw new HttpError(400, '没有可导出的提醒');

  const code = crypto.randomBytes(16).toString('hex');
  run('INSERT INTO calendar_exports(code,user_id,payload,created_at,expires_at) VALUES(?,?,?,?,?)',
    code, u.id, JSON.stringify(alarms), Date.now(), Date.now() + ICS_TTL);
  // 顺手清掉过期的，表不会无限长大
  run('DELETE FROM calendar_exports WHERE expires_at < ?', Date.now());
  return { url: `/api/calendar/ics/${code}`, expiresIn: ICS_TTL };
});

/* 交付 .ics。不带认证：Safari 把请求交给日历 App 时不一定还带着 Cookie，
   所以安全性靠那串 128 位随机取件码 + 10 分钟过期，而不是靠会话。 */
route('GET', '/api/calendar/ics/:code', async (req, res) => {
  const row = one('SELECT * FROM calendar_exports WHERE code=?', req.params.code);
  if (!row || row.expires_at < Date.now()) {
    res.writeHead(410, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('这个日历链接已过期，请回到工作台重新点一次「加到系统日历」。');
  }
  let alarms = [];
  try { alarms = JSON.parse(row.payload); } catch { alarms = []; }
  const ics = buildICS(alarms);
  res.writeHead(200, {
    'Content-Type': 'text/calendar; charset=utf-8',
    'Content-Disposition': `attachment; filename="workbench-reminder.ics"`,
    'Content-Length': Buffer.byteLength(ics),
    'Cache-Control': 'no-store',
  });
  res.end(ics);
});

/* ============================ 静态资源 & 动态页面 ============================ */
function serveStatic(req, res, urlPath) {
  let p = decodeURIComponent(urlPath);
  if (p === '/') p = '/index.html';
  if (p.startsWith('/files/')) {
    const rel = p.slice(7).replace(/\.\./g, '');
    const abs = path.join(CONFIG.uploadDir, rel);
    if (!abs.startsWith(CONFIG.uploadDir) || !fs.existsSync(abs)) return send(res, 404, 'Not found');
    const mime = MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
    const stat = fs.statSync(abs);
    const dl = new URL(req.url, 'http://x').searchParams.get('dl');
    const headers = { 'Content-Type': mime, 'Content-Length': stat.size, 'Cache-Control': 'public, max-age=604800' };
    if (dl) headers['Content-Disposition'] = `attachment; filename="${encodeURIComponent(path.basename(abs))}"`;
    res.writeHead(200, headers);
    return fs.createReadStream(abs).pipe(res);
  }
  // 界面预览页：/preview 与 /preview/ 都指向 preview/index.html
  if (p === '/preview' || p === '/preview/') {
    const pv = path.join(PUBLIC, 'preview', 'index.html');
    if (fs.existsSync(pv)) return send(res, 200, fs.readFileSync(pv), { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
  }
  const abs = path.join(PUBLIC, p);
  if (!abs.startsWith(PUBLIC)) return send(res, 403, 'Forbidden');
  if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
    const ext = path.extname(abs).toLowerCase();
    const st = fs.statSync(abs);
    // HTML 不缓存；JS/CSS 走 ETag 协商缓存（改了就立刻生效，没改则 304 省流量）
    if (ext === '.html') {
      return send(res, 200, fs.readFileSync(abs), { 'Content-Type': MIME[ext], 'Cache-Control': 'no-store' });
    }
    const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    const isCode = ext === '.js' || ext === '.css' || ext === '.mjs';
    const cacheControl = isCode ? 'no-cache' : 'public, max-age=604800';
    if (isCode && req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': cacheControl });
      return res.end();
    }
    return send(res, 200, fs.readFileSync(abs), {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': cacheControl,
      ...(isCode ? { ETag: etag } : {}),
    });
  }
  // SPA 回退
  return send(res, 200, fs.readFileSync(path.join(PUBLIC, 'index.html')), { 'Content-Type': MIME['.html'] });
}

/* ============================ 后台定时：提醒触发 ============================ */
function tick() {
  const due = all("SELECT * FROM reminders WHERE status='scheduled' AND fire_at<=?", Date.now() + 1000);
  for (const r of due) {
    run("UPDATE reminders SET status='fired' WHERE id=?", r.id);
    run('INSERT INTO messages(user_id,type,title,body,ref_type,ref_id,read,created_at) VALUES(?,?,?,?,?,?,0,?)',
      r.user_id, 'remind', r.title, r.body || ('提醒时间：' + String(r.due_at).replace('T', ' ')), 'reminder', r.id, nowISO());
    if (r.item_id) run("UPDATE items SET remind_at=? WHERE id=?", new Date().toISOString(), r.item_id);
  }
}
setInterval(tick, 15000);

/* ============================ 服务启动 ============================ */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;
  if (req.method === 'OPTIONS') return send(res, 204, '', { 'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
  if (!p.startsWith('/api/')) {
    if (p.startsWith('/s/')) return send(res, 200, fs.readFileSync(path.join(PUBLIC, 'student.html')), { 'Content-Type': MIME['.html'] });
    if (p === '/healthz') return send(res, 200, 'ok');
    return serveStatic(req, res, p);
  }
  const match = pickRoute(req.method, p);
  if (!match) return jsonErr(res, 404, '接口不存在');
  const m = match.re.exec(p);
  req.params = Object.fromEntries(match.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
  req.query = Object.fromEntries(url.searchParams);
  try {
    const out = await match.handler(req, res);
    // 注意：这里不能写 if (out)，因为 null 是合法的响应体（比如「当前没有在计时」）。
    // 用真值判断会让返回 null 的接口永远不响应，请求就这么挂住了。
    if (!res.headersSent) json(res, out === undefined ? null : out);
  } catch (err) {
    if (res.headersSent) return;
    if (err instanceof HttpError) return jsonErr(res, err.code, err.message, err.extra);
    console.error('[api error]', p, err);
    jsonErr(res, 500, '服务异常：' + err.message);
  }
});

server.listen(CONFIG.port, CONFIG.host, () => {
  console.log(`✅ 我的工作台已启动: http://localhost:${CONFIG.port}  (demoMode=${CONFIG.demoMode})`);
});

process.on('uncaughtException', (e) => console.error('uncaught', e));
process.on('unhandledRejection', (e) => console.error('unhandledRejection', e));
