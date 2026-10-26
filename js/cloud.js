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

/* ---------------------------------------------------------------------------
   云端配置也应该「开箱即用」

   【为什么要写死一份内置的】
   早先的做法是：auth.js 里存一份 SUPA_URL，等某个页面第一次 import auth.js
   时才把地址写进 localStorage。问题在于时序 —— main.js 里的实时同步是
   直接 import cloud.js 的，那时 auth.js 可能还没被任何页面拉起来，
   cfg() 返回 null，于是"订阅永远停在 idle，界面上一句提示都没有"。
   这不是实时同步独有的坑：任何在首屏阶段就用到云端的模块都会踩。

   现在把内置配置放在 cloud.js 自己身上（登录相关的代码都在这里），
   auth.js 里的常量改为从这里读。这样无论谁先加载，cfg() 都有值。

   【?supa= 仍然优先】
   这是留给测试的口子：本地起一个假 Supabase，靠它把前端指过去。
   正常访问（没有这个参数）永远用内置的生产地址 ——
   localStorage 里残留的旧配置、别人给的错误地址，都会被纠正回来。
--------------------------------------------------------------------------- */
export const BUILTIN_URL = 'https://gfgxvpvexzcfbujkwsqw.supabase.co';
export const BUILTIN_ANON = 'sb_publishable_-AYrJyaZEN6_zeVh45oZ3w_YMOGF-3P';

export function cfg() {
  /* 优先级：地址栏的 ?supa= （测试用） > localStorage > 内置的正式项目。
     顺序不能反 —— ?supa= 是用来临时指到别的项目的，被 localStorage 盖掉就失去意义了。 */
  let forced = '';
  try { forced = new URLSearchParams(location.search).get('supa') || ''; } catch { }
  if (forced) {
    const f = forced.replace(/\/+$/, '');
    try { localStorage.setItem(CFG_KEY, JSON.stringify({ url: f, anon: BUILTIN_ANON })); } catch { }
    return { url: f, anon: BUILTIN_ANON };
  }

  let c = null;
  try { c = JSON.parse(localStorage.getItem(CFG_KEY) || 'null'); } catch { }
  if (c && c.url) return c;

  /* 从没配过：灌内置的正式项目，登录框立刻可用 */
  try { localStorage.setItem(CFG_KEY, JSON.stringify({ url: BUILTIN_URL, anon: BUILTIN_ANON })); } catch { }
  return { url: BUILTIN_URL, anon: BUILTIN_ANON };
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

/* ----------------------------------------------------------------------------
   账号 → 云端邮箱

   【为什么需要这一步】
   工作台的登录框允许「账号」是邮箱，也允许是 zhangsan 这种短名。
   但 Supabase 的 email 字段只认邮箱格式 —— 短名直接丢过去必然 400。

   所以短名在这里补一个固定后缀，变成 zhangsan@workbench.local 再送去云端。
   用 .local 是刻意的：这个顶级域在公网 DNS 里不存在，
   就算哪天误发了验证邮件也投不出去，不会真去打扰谁。

   邮箱则原样使用（小写化），这样老师用 516796162@qq.com 注册，
   云端账号和他在别处记的邮箱是同一个，不会多出一个"影子账号"。
--------------------------------------------------------------------------- */
export const LOCAL_MAIL_DOMAIN = 'workbench.local';
export function toCloudEmail(account) {
  const a = String(account || '').trim().toLowerCase();
  if (!a) return '';
  return a.includes('@') ? a : a + '@' + LOCAL_MAIL_DOMAIN;
}
/* 反方向：云端邮箱 → 页面显示的账号。短名的后缀要剥掉，否则界面上会多出一串看不懂的字。 */
export function fromCloudEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return '';
  return e.endsWith('@' + LOCAL_MAIL_DOMAIN) ? e.slice(0, -(LOCAL_MAIL_DOMAIN.length + 1)) : e;
}

/* 【云端注册到底开没开 —— 必须问得出来，而且不能猜】
   用户的 Supabase 后台有个「Allow new users to sign up」开关，
   关着的时候 /auth/v1/signup 会回 422 signup_disabled。
   代码改不了那个开关（要后台权限），只能先探再决定走哪条路：

     开着  → 注册时云端 + 本机一起建，从此多端同步
     关着  → 只建本机账号，界面上如实说明差哪一步

   探测手法：发一次「必然失败」的注册（空邮箱 + 短密码）。
   开关关着 → 服务端在参数校验之前就直接拒（422 signup_disabled）；
   开关开着 → 走参数校验，回 400 weak_password 之类。
   两种结果的错误码不同，所以能区分，而且不会真建出账号。

   结果缓存 10 分钟：这个开关不会秒变，没必要每开一次登录页打一次网络。 */
const SIGNUP_PROBE_KEY = 'wb_supa_signup_state';
const SIGNUP_PROBE_TTL = 10 * 60 * 1000;

export async function canSignUp(force = false) {
  const c = cfg();
  if (!c) return { ok: false, reason: '云端还没配置' };

  if (!force) {
    try {
      const cache = JSON.parse(localStorage.getItem(SIGNUP_PROBE_KEY) || 'null');
      if (cache && Date.now() - cache.at < SIGNUP_PROBE_TTL) return cache.v;
    } catch { }
  }

  const save = (v) => {
    try { localStorage.setItem(SIGNUP_PROBE_KEY, JSON.stringify({ at: Date.now(), v })); } catch { }
    return v;
  };

  try {
    const r = await fetch(c.url + '/auth/v1/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: c.anon },
      body: JSON.stringify({ email: '', password: '' }),
    });
    const j = await r.json().catch(() => ({}));
    const code = String(j.error_code || j.code || '');
    if (/signup_disabled/i.test(code) || /Signups not allowed/i.test(j.msg || j.message || '')) {
      return save({ ok: false, reason: 'off' });
    }
    /* 没回 signup_disabled 就说明门是开的（回的是参数错误、弱密码、429 之类） */
    return save({ ok: true, reason: 'on' });
  } catch (e) {
    /* 网络不通不该被解读成"注册关了" —— 说"不知道"，让调用方按本机路径走 */
    return { ok: false, reason: 'unknown', error: String(e.message || e) };
  }
}

export function clearSignUpCache() {
  try { localStorage.removeItem(SIGNUP_PROBE_KEY); } catch { }
}

/* 云端注册。成功后 token 直接落盘 —— 注册即登录，不用再让用户输一遍。 */
export async function signUp(email, password) {
  const c = cfg();
  if (!c) throw new Error('还没配置 Supabase 地址');
  const r = await fetch(c.url + '/auth/v1/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: c.anon },
    body: JSON.stringify({ email, password }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = j.error_description || j.msg || j.message || ('HTTP ' + r.status);
    const code = String(j.error_code || j.code || '');
    if (/signup_disabled/i.test(code) || /Signups not allowed/i.test(msg)) {
      clearSignUpCache();
      const e = new Error('云端注册开关是关着的');
      e.code = 'signup_disabled';
      throw e;
    }
    if (/already registered|already exists|user_already_exists/i.test(msg + code)) {
      const e = new Error('这个邮箱已经在云端注册过了，直接登录就行');
      e.code = 'exists';
      throw e;
    }
    if (/Password should be|weak_password/i.test(msg + code)) {
      throw new Error('密码太简单了，换一个稍长一点的');
    }
    throw new Error(msg);
  }
  /* 关掉「Confirm email」时服务端直接回 token；开着时只回 user、没有 token。
     后一种情况下注册是成功了，但还得去邮箱点确认 —— 如实告诉用户。 */
  if (j.access_token) {
    adoptTokens(j);
    return { session: session(), needConfirm: false };
  }
  return { session: null, needConfirm: true, user: j.user || j };
}

/* 当前云端登录的是谁（uid）。没登录返回空串，不抛错。 */
export function cloudUid() {
  const t = tok();
  return t && t.uid ? t.uid : '';
}
export function cloudEmail() {
  const t = tok();
  return t && t.email ? t.email : '';
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

/* ---------------- 字段清洗与表配置 ---------------- */

/* 前端传进来的字段可能带这些「本地专用」的东西，云端不认，剔掉
   id 不能传：云端主键是自增的，传了会冲突 */
const DROP = new Set(['id', 'created_at', 'updated_at', 'deleted_at', 'seq']);

/* ============================================================================
   通用表读写
   ────────────────────────────────────────────────────────────────────────────
   课时是最简单的单表，照着它写一遍就行。但考勤是「主表 + 明细」两张表，
   监考还有 jsonb 字段 —— 如果每张表都复制一份 list/create/update/delete，
   四张表就是四份几乎一样的代码，第五张再复制一遍。改一个分页逻辑要改四处。

   所以这里抽出一层「表配置」，各表只在配置里声明差异：
     order   排序
     filter  允许按哪些字段过滤
     json    哪些字段是 jsonb（写入前要序列化）
     num     哪些字段是数字（空字符串要转成 null，否则 numeric 列会报错）
     date    哪些字段是日期（'' → null，'2026/9/3' → '2026-09-03'）

   上面这套转换不是洁癖 —— 是踩过的坑：本机数据里 period_no 存的是字符串 '3'，
   直接丢给 int 列会 400；日期存的是 '2026/9/3'，直接丢给 date 列会整批失败。
   ========================================================================== */

const TABLES = {
  lessons: {
    order: 'order=date.desc.nullslast,period_no.desc.nullslast',
    filter: ['date', 'month', 'grade', 'class_name', 'subject', 'period_no'],
  },
  invigilations: {
    /* start_at / end_at 在库里是 timestamptz，但前端把它当"日期+时间"直接显示，
       排序用 date 更稳：同一天多场按开始时间排。 */
    order: 'order=date.desc.nullslast,start_time.asc.nullslast',
    filter: ['date', 'month', 'grade', 'subject', 'status', 'type', 'duty_type'],
    date: ['date'],
    num: ['minutes', 'duration_min', 'seat_count', 'amount', 'pay_amount',
          'pay_hours', 'unit_price', 'peer_id'],
    int: ['need_paper', 'paid', 'school_paid', 'seq'],
    ts: ['start_at', 'end_at', 'settled_at'],
  },
  attendance_tables: {
    order: 'order=month.desc.nullslast,id.desc',
    filter: ['month', 'grade', 'subject', 'kind', 'sheet_type'],
    date: ['sheet_date'],
    json: ['columns', 'meta'],
    jsonDefault: { columns: [], meta: {} },
  },
  attendance_rows: {
    order: 'order=table_id.asc,sort.asc.nullslast',
    filter: ['table_id'],
    num: ['sort', 'table_id'],
    json: ['data'],
    jsonDefault: { data: {} },
  },
};

/* '' / undefined / null → null；数字字符串原样保留，交给数据库转 */
function cleanVal(v, spec, key) {
  const isJson = spec.json?.includes(key);
  const isNum = spec.num?.includes(key) || spec.int?.includes(key);
  const isDate = spec.date?.includes(key);
  const isTs = spec.ts?.includes(key);

  if (isJson) {
    if (v === undefined) return undefined;
    if (typeof v === 'string') {
      /* 本机存的就是 JSON 字符串，原样传会变成「字符串套字符串」 */
      try { return JSON.parse(v); } catch { return spec.jsonDefault?.[key] ?? null; }
    }
    return v ?? spec.jsonDefault?.[key] ?? null;
  }
  if (v === undefined) return undefined;
  if (v === null || v === '') return isJson ? null : null;

  if (isNum) {
    const n = parseFloat(String(v).replace(/[^\d.\-]/g, ''));
    if (Number.isNaN(n)) return null;
    return spec.int?.includes(key) ? Math.trunc(n) : n;
  }
  if (isDate) return toDateStr(v);
  if (isTs) return toTsStr(v);
  return v;
}

function toDateStr(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  m = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}

function toTsStr(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  /* '2026-09-10T09:00' 这种不带秒的，Postgres 也认；原样传最保险 */
  if (/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?/.test(s)) return s.replace(' ', 'T');
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function rowOf(table, body) {
  const spec = TABLES[table] || {};
  const row = {};
  for (const [k, v] of Object.entries(body || {})) {
    if (DROP.has(k)) continue;
    if (v === undefined) continue;
    const c = cleanVal(v, spec, k);
    if (c === undefined) continue;
    row[k] = c;
  }
  return row;
}

function queryOf(table, query) {
  const spec = TABLES[table] || {};
  if (table === 'attendance_rows' && query.table_id != null && query.table_id !== '') {
    return 'table_id=eq.' + encodeURIComponent(query.table_id);
  }
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query || {})) {
    if (v === undefined || v === null || v === '') continue;
    if (!(spec.filter || []).includes(k)) continue;
    if (k === 'month' && /^\d{4}-\d{2}$/.test(String(v))) {
      const [y, m] = String(v).split('-').map(Number);
      const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
      p.set('date', `gte.${v}-01`);
      p.append('date', `lt.${next}-01`);
      continue;
    }
    p.set(k, 'eq.' + v);
  }
  return p.toString();
}

export async function listRows(table, query = {}) {
  const spec = TABLES[table];
  if (!spec) throw new Error('这张表还没接云端：' + table);
  const parts = ['select=*', 'deleted_at=is.null'];
  if (spec.order) parts.push(spec.order);
  const extra = queryOf(table, query);
  const rows = await rest(`${table}?${parts.join('&')}${extra ? '&' + extra : ''}`);
  return Array.isArray(rows) ? rows : [];
}

/* ============================================================================
   回声抑制：自己写的行，服务端会原样推回来

   实时同步一开，有个很微妙的麻烦：我在 A 设备勾了一个人，服务端把这条变更
   推给我自己。前端收到推送 → 重绘 → 看起来像"我自己点了它还闪一下"。
   更糟的是正在输入的内容会被重绘冲掉。

   所以每次自己写库前，先向 realtime 模块登记"这条别推给我"。
   这里用动态 import 而不是顶部静态 import：realtime 只在登录云端后才有意义，
   没配云的时候连这个模块都不该被拉起来。失败就算了 —— 多刷一次不会坏数据。
   ========================================================================== */
function markLocal(table, id) {
  import('./realtime.js')
    .then((m) => { try { m.markLocalWrite(table, id); } catch { } })
    .catch(() => { });
}

export async function createRow(table, body) {
  if (!TABLES[table]) throw new Error('这张表还没接云端：' + table);
  const rows = await rest(`${table}?select=*`, {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(rowOf(table, body)),
  });
  const row = Array.isArray(rows) ? rows[0] : rows;
  if (row && row.id != null) markLocal(table, row.id);
  return row;
}

export async function updateRow(table, id, body) {
  if (!TABLES[table]) throw new Error('这张表还没接云端：' + table);
  markLocal(table, id);
  const rows = await rest(`${table}?id=eq.${encodeURIComponent(id)}&select=*`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(rowOf(table, body)),
  });
  if (!Array.isArray(rows) || !rows.length) throw new Error('记录不存在，或不属于你这个账号');
  return rows[0];
}

/* 软删除：与前端一致，打 deleted_at 而不是真删（回收站还能找回） */
export async function deleteRow(table, id) {
  if (!TABLES[table]) throw new Error('这张表还没接云端：' + table);
  markLocal(table, id);
  const rows = await rest(`${table}?id=eq.${encodeURIComponent(id)}&select=id`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ deleted_at: new Date().toISOString() }),
  });
  if (!Array.isArray(rows) || !rows.length) throw new Error('记录不存在，或不属于你这个账号');
  return { ok: true };
}

/* ---------------- 课时（保留原接口名，别的地方还在调） ---------------- */

const ORDER = TABLES.lessons.order;

export const listLessons = (query = {}) => listRows('lessons', query);
export const createLesson = (body) => createRow('lessons', body);
export const updateLesson = (id, body) => updateRow('lessons', id, body);
export const deleteLesson = (id) => deleteRow('lessons', id);

/* ---------------- 考勤：主表 + 明细 ---------------- */

/* 取单条。找不到返回 null，不抛错 —— 调用方要能区分
   「这条不存在」和「网络/权限出问题」，前者可以兜底，后者必须报给用户。 */
export async function getRow(table, id) {
  if (!TABLES[table]) throw new Error('这张表还没接云端：' + table);
  const rows = await rest(`${table}?id=eq.${encodeURIComponent(id)}&deleted_at=is.null&select=*`);
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

/* 一张考勤表可能带 40~60 行明细。逐条 POST 就是 60 次往返，
   手机上要等十几秒。PostgREST 支持一次提交数组，所以这里必须批量。 */
export async function createRows(table, list) {
  if (!TABLES[table]) throw new Error('这张表还没接云端：' + table);
  if (!Array.isArray(list) || !list.length) return [];
  const rows = await rest(`${table}?select=*`, {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(list.map((b) => rowOf(table, b))),
  });
  const out = Array.isArray(rows) ? rows : [];
  /* 批量插入服务端会连推 N 条，逐条登记 */
  for (const r of out) if (r && r.id != null) markLocal(table, r.id);
  return out;
}

/* 删一张考勤表 = 软删主表 + 软删它下面所有明细。
   为什么不用数据库的外键 cascade：见 SQL 里的注释 ——
   前端是"先删主表再看明细"，cascade 会把明细删得前端反应不过来。 */
export async function deleteAttendanceTable(id) {
  const ts = new Date().toISOString();
  await rest(`attendance_rows?table_id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ deleted_at: ts }),
  }).catch(() => { });
  return deleteRow('attendance_tables', id);
}

/* 一次读齐：主表 + 所有明细。考勤页打开就要这两样，
   分两次请求会多一个来回，也容易出现"表出来了但格子空着"的闪烁。 */
export async function listAttendance(query = {}) {
  const [tables, rows] = await Promise.all([
    listRows('attendance_tables', query),
    listRows('attendance_rows', {}),
  ]);
  const ids = new Set(tables.map((t) => String(t.id)));
  return {
    tables,
    rows: rows.filter((r) => ids.has(String(r.table_id))),
  };
}
