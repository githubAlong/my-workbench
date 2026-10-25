/* ============================================================================
   纯静态版的数据层：把原来 143 个 /api/* 接口，全部在浏览器里实现一遍。

   为什么要这么写：
   工作台原本是 Node + SQLite，前端所有页面都通过 api.get/post/patch/del 取数。
   现在要放到 GitHub Pages（只能放静态文件，跑不了服务端），
   最省事、也最不容易出错的办法不是改 10731 行页面代码，
   而是**在 api.req 这一层把请求接住**，用浏览器本地存储实现同样的语义。
   页面代码一行不用改，行为保持一致——这是这次改造能成立的关键。

   数据模型跟 server/index.mjs 的 CRUD 表定义逐字段对齐，
   顺序、排序规则、软删除（deleted_at）、序号（seq）都照着来，
   否则导出的数据再导回服务端会错位。
   ========================================================================== */

const DB_KEY = 'wb_static_db_v1';
/* 云同步要用这个键名去读整库，导出去（cloudsync.js） */
export { DB_KEY };

/* ---------------- 表结构：照抄 server/index.mjs 的 CRUD ---------------- */
export const TABLES = {
  periods: ['period_no', 'name', 'start_time', 'end_time'],
  courses: ['weekday', 'period_no', 'start_time', 'end_time', 'start_date', 'end_date', 'grade', 'class_name', 'subject', 'room', 'weeks', 'color', 'remark'],
  lessons: ['date', 'period_no', 'time_range', 'start_time', 'end_time', 'grade', 'class_name', 'subject', 'teacher', 'substitute', 'sub_type', 'sub_note', 'content', 'progress', 'next_content', 'discipline', 'hours', 'remark', 'peer_name', 'peer_id', 'orig_teacher', 'pay_hours', 'unit_price', 'pay_amount', 'settle_note', 'swap_from', 'swap_to', 'settled_at', 'settle_key'],
  invigilations: ['date', 'type', 'person', 'subject', 'grade', 'start_at', 'end_at', 'minutes', 'amount', 'paid', 'place', 'need_paper', 'paper_place', 'remark', 'exam_name', 'duty_type', 'peer_name', 'peer_id', 'start_time', 'end_time', 'duration_min', 'room', 'seat_count', 'pay_amount', 'pay_rule', 'pay_note', 'settled_at', 'settle_key', 'status', 'school_paid'],
  trips: ['start_date', 'end_date', 'from_place', 'to_place', 'reason', 'companions', 'km', 'toll', 'parking', 'other', 'status', 'approve_note', 'remark', 'days', 'hotel', 'transport', 'taxi', 'subsidy_food', 'subsidy_local', 'advance', 'reimb_status', 'paid_at'],
  materials: ['category_id', 'title', 'grade', 'class_name', 'descr', 'public'],
  notes: ['category_id', 'title', 'content', 'tags', 'pinned'],
  preps: ['date', 'class_name', 'subject', 'topic', 'progress', 'next_step', 'minutes', 'status', 'lesson_id', 'remark'],
  categories: ['scope', 'name', 'sort'],
  homework: ['title', 'grade', 'class_name', 'subject', 'assign_date', 'due_date', 'content'],
  studies: ['date', 'category_id', 'title', 'content', 'minutes', 'source', 'tags'],
  students: ['grade', 'class_name', 'name', 'no'],
  rosters: ['grade', 'class_name', 'count', 'names'],
  punishments: ['text', 'level', 'active'],
  exceptions: ['type', 'date', 'ref_id', 'action', 'start_time', 'end_time', 'class_name', 'room', 'rescheduled', 'remark'],
  selfstudy: ['date', 'period_no', 'start_time', 'end_time', 'grade', 'class_name', 'subject', 'minutes', 'content', 'absent', 'billable', 'remark'],
  repairs: ['date', 'place', 'item', 'fault', 'urgency', 'status', 'reporter', 'handler', 'cost', 'expect_at', 'fixed_at', 'remark'],
  /* 下面几张服务端不是走 CRUD 生成的，但前端在用，一并实现 */
  items: ['title', 'done', 'due_at', 'remind_at', 'note', 'priority', 'kind'],
  todos: ['title', 'done', 'due_at', 'note', 'priority'],
  reminders: ['title', 'body', 'fire_at', 'due_at', 'item_id', 'status'],
  messages: ['type', 'title', 'body', 'ref_type', 'ref_id', 'read', 'link'],
  links: ['code', 'title', 'grades', 'enabled'],
  attendance_tables: ['grade', 'name', 'month', 'kind', 'rows'],
  students_att: ['table_id', 'no', 'name', 'rows'],
  teachers: ['grade', 'name', 'subject', 'phone'],
  invig_rules: ['name', 'amount', 'minutes', 'note'],
  trip_rules: ['name', 'km', 'rate', 'note'],
  punish_records: ['date', 'punish_id', 'student_no', 'class_name', 'text'],
  homework_records: ['date', 'homework_id', 'student_no', 'class_name', 'status'],
};

/* 序号作用域：服务端用 seqs 表按用户维护连续编号 */
const SEQ_SCOPE = { lessons: 'lesson', invigilations: 'invig', trips: 'trip', materials: 'material', notes: 'note', homework: 'homework', studies: 'study', preps: 'prep', selfstudy: 'selfstudy', repairs: 'repair' };

/* ---------------- 存取 ---------------- */
let _db = null;
export function load() {
  if (_db) return _db;
  try {
    const raw = localStorage.getItem(DB_KEY);
    _db = raw ? JSON.parse(raw) : null;
  } catch { _db = null; }
  if (!_db || typeof _db !== 'object') _db = blank();
  // 补齐缺失的表（版本升级时新增表不至于报错）
  return ensureTables(_db);
}
export function save() {
  try {
    localStorage.setItem(DB_KEY, JSON.stringify(_db));
  } catch (e) {
    /* 【不能再静默吞掉】
       早先这里只 console.warn 就过去了：内存已经改了、界面提示「已保存」，
       但磁盘一个字节都没写。用户刷新后改动全丢，还以为是程序 bug。
       典型触发是上传头像/附件把 5MB 配额占满（dataURL 原文入库）。
       现在广播一个事件，由 core.js 统一弹「本机存储空间不足」，让用户知道。 */
    console.warn('本地存储写入失败', e);
    try { window.dispatchEvent(new CustomEvent('wb:storagefull', { detail: { error: String(e && e.name || e) } })); } catch { }
    return false;
  }
  /* 云同步钩子：本地数据一变就通知 cloudsync（它内部有 3 秒防抖，
     没绑云存储时这个事件没人听，零开销）。用事件解耦，
     localdb 不 import cloudsync，避免模块循环依赖。 */
  try { window.dispatchEvent(new Event('wb:localchange')); } catch {}
  return true;
}
/* 除了 TABLES 里那 18 张「走通用 CRUD」的表，还有一批是业务表
   （点名、消息、提醒、附件、回收站……）。它们也要先建好空数组，
   否则 seed / 消息同步一 push 就炸「Cannot read properties of undefined」。 */
const EXTRA_TABLES = [
  'items', 'todos', 'reminders', 'messages', 'links', 'roll_sessions', 'roll_records',
  'attachments', 'recycle', 'homework_records', 'punish_records', 'invig_rules', 'trip_rules',
];
const ALL_TABLES = [...Object.keys(TABLES), ...EXTRA_TABLES];

export function blank() {
  const d = { seqs: {}, meta: {} };
  for (const t of ALL_TABLES) d[t] = [];
  return d;
}
/* 补齐缺失的表：版本升级时新增了表、或某些接口只用了 EXTRA 里的表 */
function ensureTables(d) {
  for (const t of ALL_TABLES) if (!Array.isArray(d[t])) d[t] = [];
  if (!d.seqs || typeof d.seqs !== 'object') d.seqs = {};
  if (!d.meta || typeof d.meta !== 'object') d.meta = {};
  return d;
}
export function replaceAll(obj) {
  _db = ensureTables(obj && typeof obj === 'object' ? obj : blank());
  save();
}
/* 外部（搬家链接导入、云同步拉取）直接写了 localStorage 之后调用：
   丢掉内存缓存，下次 load() 重新从磁盘读。不这么做就会出现
   「界面还是旧数据，下一次保存又把旧数据写回去」的双向覆盖。 */
export function replaceMemFromDisk() {
  _db = null;
  return load();
}
export function exportJSON() { return JSON.parse(JSON.stringify(load())); }

/* ---------------- 工具 ---------------- */
const nowISO = () => new Date().toISOString();
export const pad2 = (n) => String(n).padStart(2, '0');
export const ymd = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

/* 自增 id。以前是「现存最大 id + 1」，没有单调保证：
   把 id 最大的那条彻底删除（/recycle/purge 是物理删除）之后，
   新记录会拿到同一个 id；此时再从回收站「撤销删除」旧记录，
   旧 payload 就会盖到新记录身上 —— 表现为「还原回来的是一条不相干的新数据」。
   改成本表一个只增不减的计数器，存在 db.seqs 里（跟业务序号共用同一张表，
   用 'id:' 前缀区分，不会互相干扰）。 */
function nextId(t) {
  const db = load();
  const key = 'id:' + t;
  const rows = Array.isArray(db[t]) ? db[t] : [];
  let max = 0;
  for (const r of rows) if (Number(r.id) > max) max = Number(r.id);
  /* 兼容老库：计数器还没建立时，用「现存最大」起步，不会比现有 id 小 */
  const cur = Math.max(Number(db.seqs[key] || 0), max) + 1;
  db.seqs[key] = cur;
  return cur;
}
function nextSeq(t) {
  const scope = SEQ_SCOPE[t];
  if (!scope) return nextId(t);
  const db = load();
  const cur = Number(db.seqs[scope] || 0) + 1;
  db.seqs[scope] = cur;
  return cur;
}

/* 排序规则：与 server/index.mjs 里每张表的 ORDER BY 一致 */
const ORDER = {
  courses: (a, b) => (a.weekday - b.weekday) || ((a.period_no || 0) - (b.period_no || 0)),
  lessons: (a, b) => String(b.date).localeCompare(String(a.date)) || ((b.period_no || 0) - (a.period_no || 0)),
  preps: (a, b) => String(b.date).localeCompare(String(a.date)) || (b.id - a.id),
  selfstudy: (a, b) => String(b.date).localeCompare(String(a.date)) || ((b.period_no || 0) - (a.period_no || 0)) || (b.id - a.id),
  repairs: (a, b) => {
    const rank = (s) => (s === 'pending' ? 0 : s === 'doing' ? 1 : 2);
    return (rank(a.status) - rank(b.status)) || String(b.date).localeCompare(String(a.date)) || (b.id - a.id);
  },
  invigilations: (a, b) => String(b.date).localeCompare(String(a.date)) || String(b.start_time || '').localeCompare(String(a.start_time || '')),
  trips: (a, b) => String(b.start_date).localeCompare(String(a.start_date)),
  homework: (a, b) => String(b.assign_date).localeCompare(String(a.assign_date)),
  studies: (a, b) => String(b.date).localeCompare(String(a.date)),
  notes: (a, b) => ((b.pinned ? 1 : 0) - (a.pinned ? 1 : 0)) || String(b.updated_at || '').localeCompare(String(a.updated_at || '')),
  messages: (a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')),
};

/* 把 JSON 字符串字段还原成数组（服务端也是这样 j() 一下） */
function hydrate(t, row) {
  if (!row) return row;
  const copy = { ...row };
  if (t === 'rosters' && typeof copy.names === 'string') { try { copy.names = JSON.parse(copy.names); } catch { copy.names = []; } }
  if (t === 'links' && typeof copy.grades === 'string') { try { copy.grades = JSON.parse(copy.grades); } catch { copy.grades = []; } }
  if ((t === 'attendance_tables') && typeof copy.rows === 'string') { try { copy.rows = JSON.parse(copy.rows); } catch { copy.rows = []; } }
  if ((t === 'students_att') && typeof copy.rows === 'string') { try { copy.rows = JSON.parse(copy.rows); } catch { copy.rows = {}; } }
  return copy;
}

/* ---------------- 通用 CRUD（对应服务端的自动生成路由） ---------------- */
export function listTable(t, query = {}) {
  const rows = load()[t] || [];
  let out = rows.filter((r) => !r.deleted_at);
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    if (k === 'month' && /^\d{4}-\d{2}$/.test(String(v))) {
      const has = (c) => (TABLES[t] || []).includes(c);
      const col = has('date') ? 'date' : has('start_date') ? 'start_date' : null;
      if (col) out = out.filter((r) => String(r[col] || '').startsWith(String(v)));
      continue;
    }
    if ((TABLES[t] || []).includes(k) || k === 'category_id') {
      out = out.filter((r) => String(r[k]) === String(v));
    }
  }
  const cmp = ORDER[t] || ((a, b) => b.id - a.id);
  return out.sort(cmp).map((r) => hydrate(t, r));
}

export function createRow(t, body = {}) {
  const db = load();
  const row = { id: nextId(t), created_at: nowISO(), updated_at: nowISO(), deleted_at: null };
  if (SEQ_SCOPE[t]) row.seq = nextSeq(t);
  for (const f of (TABLES[t] || [])) {
    if (f in body) row[f] = body[f];
  }
  // 默认值：与服务端保持一致
  if (t === 'punishments' && row.active === undefined) row.active = 1;
  if (t === 'materials' && row.public === undefined) row.public = 1;
  if (t === 'categories' && row.sort === undefined) row.sort = 0;
  if (t === 'links' && !row.code) row.code = randomCode(6);
  if (t === 'links' && row.enabled === undefined) row.enabled = 1;
  db[t].push(row);
  save();
  return hydrate(t, row);
}

export function updateRow(t, id, body = {}) {
  const db = load();
  /* 只改「还在用」的行：找不到 id，或那行已经被软删除，都按「记录不存在」处理。
     早先不过滤 deleted_at，于是回收站里躺着的旧记录也能被 PATCH 改掉，
     一旦 id 被复用（彻底删除后新建），就会改到一条完全不相干的新数据上。 */
  const row = (db[t] || []).find((r) => String(r.id) === String(id) && !r.deleted_at);
  if (!row) throw new Error('记录不存在');
  for (const f of (TABLES[t] || [])) if (f in body) row[f] = body[f];
  row.updated_at = nowISO();
  save();
  return hydrate(t, row);
}

/* 软删除：与后端一致，进回收站而不是真删 */
export function deleteRow(t, id) {
  const db = load();
  const row = (db[t] || []).find((r) => String(r.id) === String(id));
  if (row) { row.deleted_at = nowISO(); save(); }
  return { ok: true };
}

function randomCode(n = 6) {
  const s = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < n; i += 1) out += s[Math.floor(Math.random() * s.length)];
  return out;
}

export { randomCode, nowISO, hydrate };
