/* ============================================================================
   真·云端：课时表直连 Supabase（A 方案第一步）

   【为什么单独一个文件，而不是改 localapi.js】
   localapi.js 有 10731 行、143 个接口。一次性全改风险极高 ——
   改坏一处，整个工作台都用不了（上课、考勤、监考全在里面）。
   所以这里只接管「课时」这一张表，其余接口原样走本地逻辑。
   等这一条链路在真机上跑通、你确认没问题，再逐张表推进。

   【数据流】
   前端页面 → localapi.handle('GET','/lessons') → 本文件转发
            → Supabase REST（带登录 token）
            → PostgREST 用 token 里的 sub 当 auth.uid()
            → RLS 只放行 user_id = 你的行

   【登录】
   用 Supabase Auth 邮箱密码登录。登录拿到的 access_token 存 localStorage，
   每次请求放进 Authorization: Bearer。没有 token 时 RLS 一律拒绝 ——
   这正是「只有我这个账号能看」的实现方式，不再是靠一把可以复制的钥匙。
   ========================================================================== */

const CFG_KEY = 'wb_supa_cfg';    // { url, anon }
const TOK_KEY = 'wb_supa_tok';    // { access_token, refresh_token, expires_at, email, uid }

export function cfg() {
  try { return JSON.parse(localStorage.getItem(CFG_KEY) || 'null'); } catch { return null; }
}
export function saveCfg(url, anon) {
  localStorage.setItem(CFG_KEY, JSON.stringify({ url: url.replace(/\/+$/, ''), anon }));
}
export function clearCfg() {
  localStorage.removeItem(CFG_KEY);
  localStorage.removeItem(TOK_KEY);
}

function tok() {
  try { return JSON.parse(localStorage.getItem(TOK_KEY) || 'null'); } catch { return null; }
}
function setTok(t) {
  if (t) localStorage.setItem(TOK_KEY, JSON.stringify(t));
  else localStorage.removeItem(TOK_KEY);
}

/* 当前登录的是谁（页面头部要显示，退出登录也要用） */
export function session() {
  const t = tok();
  if (!t || !t.access_token) return null;
  return { email: t.email, uid: t.uid, expires_at: t.expires_at };
}

/* ---------------- Auth ---------------- */

/* 用户很容易把手机号填进「邮箱」框（截图里就是这么发生的）。
   Supabase 的 email 字段只认邮箱格式，填手机号一定是 invalid_credentials，
   但报错说的是「密码不对」，会让人一直怀疑密码。这里提前拦住，把话说清楚。 */
export function looksLikePhone(v) {
  const s = String(v || '').replace(/[\s\-()]/g, '');
  return /^\+?\d{7,15}$/.test(s);
}

export async function login(email, password) {
  const c = cfg();
  if (!c) throw new Error('还没配置 Supabase 地址');
  if (looksLikePhone(email)) {
    throw new Error('这里要填邮箱（比如 xxx@qq.com），不能填手机号');
  }
  const r = await fetch(c.url + '/auth/v1/token?grant_type=password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: c.anon },
    body: JSON.stringify({ email, password }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    /* Supabase 的错误文案是英文的，转成人话 */
    const msg = j.error_description || j.msg || j.message || ('HTTP ' + r.status);
    if (/Invalid login credentials/i.test(msg)) throw new Error('邮箱或密码不对');
    if (/Email not confirmed/i.test(msg)) throw new Error('这个邮箱还没验证。去 Supabase 后台把「Confirm email」关掉，或手动确认该用户');
    throw new Error(msg);
  }
  setTok({
    access_token: j.access_token,
    refresh_token: j.refresh_token,
    expires_at: Date.now() + (j.expires_in || 3600) * 1000,
    email: j.user?.email || email,
    uid: j.user?.id || '',
  });
  return session();
}

/* 最近一次登录取到的 refresh_token。
   换设备链接要用它去换一次性凭证，所以单独开一个只读出口，
   不把整个 token 对象暴露给界面层。 */
export function refreshToken() {
  const t = tok();
  return t && t.refresh_token ? t.refresh_token : '';
}

/* 把服务端返回的 token 包直接存下来（登录、续期、一次性链接都用它） */
export function adoptTokens(j) {
  if (!j || !j.access_token) return null;
  const old = tok() || {};
  setTok({
    access_token: j.access_token,
    refresh_token: j.refresh_token || old.refresh_token,
    expires_at: Date.now() + (j.expires_in || 3600) * 1000,
    email: j.user?.email || old.email,
    uid: j.user?.id || old.uid,
  });
  return session();
}

export async function logout() {
  const c = cfg(); const t = tok();
  if (c && t?.access_token) {
    // 尽力通知服务端作废，失败也无所谓，本地清了就行
    fetch(c.url + '/auth/v1/logout', {
      method: 'POST',
      headers: { apikey: c.anon, Authorization: 'Bearer ' + t.access_token },
    }).catch(() => {});
  }
  setTok(null);
}

/* token 一小时过期。快过期就先续一次，避免用户用到一半突然报 401 */
async function freshToken() {
  const c = cfg(); const t = tok();
  if (!c || !t) return null;
  if (t.expires_at && Date.now() < t.expires_at - 60000) return t.access_token;
  if (!t.refresh_token) { setTok(null); return null; }
  try {
    const r = await fetch(c.url + '/auth/v1/token?grant_type=refresh_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: c.anon },
      body: JSON.stringify({ refresh_token: t.refresh_token }),
    });
    if (!r.ok) { setTok(null); return null; }
    const j = await r.json();
    setTok({
      access_token: j.access_token,
      refresh_token: j.refresh_token || t.refresh_token,
      expires_at: Date.now() + (j.expires_in || 3600) * 1000,
      email: j.user?.email || t.email,
      uid: j.user?.id || t.uid,
    });
    return j.access_token;
  } catch {
    return null;
  }
}

/* ---------------- 通用请求 ---------------- */

async function rest(path, opts = {}) {
  const c = cfg();
  if (!c) throw new Error('还没配置 Supabase 地址');
  const at = await freshToken();
  if (!at) throw new Error('请先登录');
  const r = await fetch(c.url + '/rest/v1/' + path, {
    ...opts,
    headers: {
      apikey: c.anon,
      Authorization: 'Bearer ' + at,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  if (r.status === 401) { setTok(null); throw new Error('登录已过期，请重新登录'); }
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!r.ok) {
    const msg = data?.message || data?.hint || ('HTTP ' + r.status);
    /* 表不存在时给一句能直接照做的提示 */
    if (/Could not find the table/i.test(msg)) {
      throw new Error('云端还没建 lessons 表：去 Supabase 的 SQL Editor 跑一遍 step1_lessons.sql');
    }
    if (/row-level security/i.test(msg)) {
      throw new Error('被 RLS 拦下了：确认你已经登录，且用的是本人的账号');
    }
    throw new Error(msg);
  }
  return data;
}

/* ---------------- 课时 CRUD（与 localapi 的语义对齐） ---------------- */

/* 前端传进来的字段可能带这些「本地专用」的东西，云端不认，剔掉
   id 不能传：云端主键是自增的，传了会冲突 */
const DROP = new Set(['id', 'created_at', 'updated_at', 'deleted_at']);

function toRow(body) {
  const row = {};
  for (const [k, v] of Object.entries(body || {})) {
    if (DROP.has(k)) continue;
    if (v === undefined) continue;
    row[k] = v;
  }
  return row;
}

/* 按 localdb 的排序规则：日期倒序，同一天按节次倒序 */
const ORDER = 'order=date.desc.nullslast,period_no.desc.nullslast';

export async function listLessons(query = {}) {
  const qs = ['select=*', ORDER];
  /* 只取未删除的（与前端软删除语义一致） */
  qs.push('deleted_at=is.null');
  /* 支持前端常用的过滤：月份、日期、年级、班级 */
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    if (k === 'month' && /^\d{4}-\d{2}$/.test(String(v))) {
      /* 按月过滤：date >= 月初 且 date < 下月初 */
      const [y, m] = String(v).split('-').map(Number);
      const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
      p.set('date', `gte.${v}-01`);
      p.append('date', `lt.${next}-01`);
      continue;
    }
    if (['date', 'grade', 'class_name', 'subject', 'period_no'].includes(k)) {
      p.set(k, 'eq.' + v);
    }
  }
  const extra = p.toString();
  const url = 'lessons?' + qs.join('&') + (extra ? '&' + extra : '');
  const rows = await rest(url);
  return Array.isArray(rows) ? rows : [];
}

export async function createLesson(body) {
  const rows = await rest('lessons?select=*', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(toRow(body)),
  });
  return Array.isArray(rows) ? rows[0] : rows;
}

export async function updateLesson(id, body) {
  const rows = await rest(`lessons?id=eq.${encodeURIComponent(id)}&select=*`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(toRow(body)),
  });
  if (!Array.isArray(rows) || !rows.length) throw new Error('记录不存在，或不属于你这个账号');
  return rows[0];
}

/* 软删除：与前端一致，打 deleted_at 而不是真删（回收站还能找回） */
export async function deleteLesson(id) {
  const rows = await rest(`lessons?id=eq.${encodeURIComponent(id)}&select=id`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ deleted_at: new Date().toISOString() }),
  });
  if (!Array.isArray(rows) || !rows.length) throw new Error('记录不存在，或不属于你这个账号');
  return { ok: true };
}
