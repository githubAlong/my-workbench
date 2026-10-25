/* ============================================================================
   localapi.js —— 把服务端 126 个 /api/* 接口，在浏览器里逐个实现一遍。

   与 localdb.js 的分工：
     localdb.js  —— 存储 + 通用 CRUD（表结构、排序、软删除、seq）
     localapi.js —— 业务计算（课时汇总、监考结算、出差报销、考勤统计、点名…）

   为什么逐个对着 server/index.mjs 抄：
   这些计算是对账用的，金额算错一位、排序差一条，用户当场就会发现。
   「照着原逻辑重写」比「自己设计一套更优雅的」安全得多。
   凡是原代码里有注释解释过原因的坑（比如课时只归一个人、补贴填了就用手填的），
   这里都原样保留了同样的判断顺序。

   存储限制：浏览器 localStorage 通常只有 5MB 左右，所以附件只存元数据，
   文件内容按需读取，不整坨塞进 localStorage。
   ========================================================================== */

import {
  TABLES, load, save, blank, replaceAll, exportJSON,
  listTable, createRow, updateRow, deleteRow,
  randomCode, nowISO, pad2, ymd, hydrate,
} from './localdb.js';

/* ============================ 基础工具 ============================ */

/* 服务端抛错是 { code, message }，前端 api.req 会读 data.error。
   这里用同样的形状，页面代码不用改。 */
class ApiError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.code = code;
    this.extra = extra;
  }
}
const fail = (code, msg, extra) => { throw new ApiError(code, msg, extra); };

const n2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const pad2s = (n) => String(n).padStart(2, '0');
const todayStr = () => ymd(new Date());

/* 北京时区日期：与原服务端 cnDate() 口径一致。
   不能用 toISOString().slice(0,10)——那是 UTC，凌晨 0~8 点会差一天。 */
export function cnDate(d = new Date()) {
  return ymd(new Date(d.getTime() + 8 * 3600 * 1000));
}
function isoToCnDate(iso) {
  if (!iso) return '';
  const t = Date.parse(String(iso).length === 10 ? iso + 'T00:00:00Z' : iso);
  return Number.isNaN(t) ? String(iso).slice(0, 10) : cnDate(new Date(t));
}

/* 取当前用户名的所有行（已排除软删除） */
function rowsOf(t) {
  return (load()[t] || []).filter((r) => !r.deleted_at);
}
/* 取表：本地库是 JSON，老版本/手工改过的数据可能缺某张表。
   每次都写 (db.x || []) 太啰嗦，而且漏一处就炸「reading 'reduce' of undefined」，
   统一走这个函数，缺表当场补一个空数组。 */
function T(t) {
  const db = load();
  if (!Array.isArray(db[t])) db[t] = [];
  return db[t];
}
function byId(t, id) {
  return (load()[t] || []).find((r) => String(r.id) === String(id) && !r.deleted_at);
}

/* 序号：与服务端 seqs 表同语义，按 scope 递增 */
function nextSeq(scope) {
  const db = load();
  const cur = Number(db.seqs[scope] || 0) + 1;
  db.seqs[scope] = cur;
  return cur;
}
function bumpSeq(table) {
  const scope = { lessons: 'lesson', invigilations: 'invig', trips: 'trip', materials: 'material', notes: 'note', studies: 'study', preps: 'prep', selfstudy: 'selfstudy', repairs: 'repair' }[table];
  if (!scope) return nextSeq(table);
  return nextSeq(scope);
}

/* ============================ 用户 & 设置 ============================ */
const DEFAULT_USER = () => ({
  id: 1,
  phone: '',
  nickname: '老师',
  avatar: '',
  school: '',
  subject: '',
  title: '',
  settings: {},
});

function currentUser() {
  const db = load();
  if (!db.meta.user) db.meta.user = DEFAULT_USER();
  return db.meta.user;
}
function saveUser(u) {
  const db = load();
  db.meta.user = u;
  save();
}
function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id, phone: u.phone, nickname: u.nickname, avatar: u.avatar,
    school: u.school, subject: u.subject, title: u.title,
    wx_nick: u.wx_nick || '', qq_nick: u.qq_nick || '',
    bindings: { phone: !!u.phone, wechat: false, qq: false, workbuddy: false },
    /* settings 必须带上：前端 state.user 来自 /auth/me 的返回值，
       这里不含 settings 的话，课时单价永远读回默认值 30 元。 */
    settings: u.settings || {},
  };
}

/* ============================ 课程实例 ============================ */
/* 与 helpers.mjs 的 courseInstancesForRange 完全一致：
   按周课表推算某段日期里每一天的每一节课，并处理停课/调课例外。 */
const WD = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function courseInstancesForRange(fromDate, toDate) {
  const courses = rowsOf('courses');
  const periods = listTable('periods');
  const pmap = new Map(periods.map((p) => [Number(p.period_no), p]));
  const exceptions = new Map();
  for (const r of rowsOf('exceptions')) {
    if (r.type === 'course') exceptions.set(`${r.date}#${r.ref_id}`, r);
  }
  const start = new Date(fromDate + 'T00:00:00');
  const end = new Date(toDate + 'T00:00:00');
  const out = [];
  for (const d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const iso = ymd(d);
    const wd = d.getDay();
    for (const c of courses) {
      if (Number(c.weekday) !== wd) continue;
      if (c.start_date && iso < c.start_date) continue;
      if (c.end_date && iso > c.end_date) continue;
      const ex = exceptions.get(`${iso}#${c.id}`);
      if (ex && ex.action === 'cancel') continue;
      const p = pmap.get(Number(c.period_no)) || {};
      out.push({
        id: `c${c.id}-${iso}`,
        course_id: c.id,
        date: iso,
        weekday: wd,
        weekday_label: WD[wd],
        period_no: c.period_no,
        period_name: p.name || '',
        start_time: (ex && ex.start_time) || c.start_time || p.start_time || '',
        end_time: (ex && ex.end_time) || c.end_time || p.end_time || '',
        subject: c.subject,
        grade: c.grade,
        class_name: ex && ex.class_name ? ex.class_name : c.class_name,
        room: c.room,
        color: c.color,
        remark: c.remark,
        rescheduled: !!(ex && ex.rescheduled),
      });
    }
  }
  out.sort((a, b) => (a.date + a.start_time).localeCompare(b.date + b.start_time));
  return out;
}

/* 监考时间兜底：新记录写 start_time，老记录只有 start_at */
function fillInvigTime(r) {
  if (!r) return r;
  const d = String(r.date || '').slice(0, 10);
  const st = String(r.start_time || '').slice(0, 5);
  const et = String(r.end_time || '').slice(0, 5);
  if (!r.start_at && d && st) r.start_at = `${d}T${st}`;
  if (!r.end_at && d && et) r.end_at = `${d}T${et}`;
  if (!r.start_time && r.start_at) r.start_time = String(r.start_at).slice(11, 16);
  if (!r.end_time && r.end_at) r.end_time = String(r.end_at).slice(11, 16);
  return r;
}

/* ============================ 今日聚合 ============================ */
function todayDigest(dateISO) {
  const items = rowsOf('items')
    .filter((it) => (it.start_at ? String(it.start_at).slice(0, 10) : isoToCnDate(it.created_at)) === dateISO)
    .sort((a, b) => String(a.start_at || a.created_at || '').localeCompare(String(b.start_at || b.created_at || '')));
  const lessons = rowsOf('lessons').filter((r) => r.date === dateISO)
    .sort((a, b) => num(a.period_no) - num(b.period_no));
  const courses = courseInstancesForRange(dateISO, dateISO);
  const todos = rowsOf('todos')
    .sort((a, b) => (num(b.pin) - num(a.pin)) || (b.id - a.id)).slice(0, 60);
  const invig = rowsOf('invigilations').filter((r) => r.date === dateISO)
    .sort((a, b) => String(a.start_time || '').localeCompare(String(b.start_time || '')))
    .map(fillInvigTime);
  return { items, lessons, courses, todos, invigilations: invig };
}

/* ============================ 名言库 ============================ */
/* 与服务端 seed.mjs 同一份数据，抽签逻辑也一样：当天没抽过就随机抽一条不重复的 */
const QUOTES = [
  ['Education is not the filling of a pail, but the lighting of a fire.', '教育不是灌满一桶水，而是点燃一把火。', 'W. B. Yeats'],
  ['Tell me and I forget. Teach me and I remember. Involve me and I learn.', '告诉我，我会忘记；教我，我会记住；让我参与，我才能真正学会。', 'Benjamin Franklin'],
  ['The mediocre teacher tells. The good teacher explains. The superior teacher demonstrates. The great teacher inspires.', '平庸的老师讲述，好的老师解释，优秀的老师示范，伟大的老师启发。', 'William Arthur Ward'],
  ['It is the supreme art of the teacher to awaken joy in creative expression and knowledge.', '教师的最高艺术，是唤起学生在创造与知识中的喜悦。', 'Albert Einstein'],
  ['The beautiful thing about learning is that no one can take it away from you.', '学习最美的地方在于，没有人能把它从你手中拿走。', 'B.B. King'],
  ['A teacher affects eternity; he can never tell where his influence stops.', '教师的影响是永恒的，他永远不知道自己的影响止于何处。', 'Henry Adams'],
  ['The roots of education are bitter, but the fruit is sweet.', '教育的根是苦的，但果实是甜的。', 'Aristotle'],
  ['Live as if you were to die tomorrow. Learn as if you were to live forever.', '像明天就要死去一样生活，像永远活着一样学习。', 'Mahatma Gandhi'],
  ['The mind is not a vessel to be filled, but a fire to be kindled.', '头脑不是需要填满的容器，而是需要点燃的火焰。', 'Plutarch'],
  ['Success is the sum of small efforts, repeated day in and day out.', '成功是日复一日微小努力的总和。', 'Robert Collier'],
  ['Knowing is not enough; we must apply. Willing is not enough; we must do.', '知道还不够，我们必须应用；愿意还不够，我们必须行动。', 'Johann Wolfgang von Goethe'],
  ['The best way to predict the future is to create it.', '预测未来最好的方式，就是去创造它。', 'Peter Drucker'],
  ['Education is the most powerful weapon which you can use to change the world.', '教育是你用来改变世界最强大的武器。', 'Nelson Mandela'],
  ['Discipline is the bridge between goals and accomplishment.', '自律是目标与成就之间的桥梁。', 'Jim Rohn'],
  ['What we learn with pleasure we never forget.', '带着愉悦学到的，我们永远不会忘记。', 'Alfred Mercier'],
  ['Genius is one percent inspiration and ninety-nine percent perspiration.', '天才是百分之一的灵感加百分之九十九的汗水。', 'Thomas Edison'],
  ['The only way to do great work is to love what you do.', '做出伟大工作的唯一方法，就是热爱你所做的事。', 'Steve Jobs'],
  ['Patience is bitter, but its fruit is sweet.', '忍耐是苦的，但它的果实是甜的。', 'Jean-Jacques Rousseau'],
  ['Teaching is the one profession that creates all other professions.', '教师是创造出所有其他职业的那一个职业。', 'Unknown'],
  ['Small steps every day, lead to big changes every year.', '每天一小步，一年一大步。', 'Unknown'],
  ['The journey of a thousand miles begins with a single step.', '千里之行，始于足下。', 'Lao Tzu'],
  ['Curiosity is the wick in the candle of learning.', '好奇心是学习之烛的灯芯。', 'William Arthur Ward'],
  ['To teach is to learn twice.', '教，就是学两遍。', 'Joseph Joubert'],
  ['Every child is a different kind of flower, and all together make this world a beautiful garden.', '每个孩子都是不同的花，他们一起成就了这世界美丽的花园。', 'Unknown'],
  ['Do not wait for the perfect moment; take the moment and make it perfect.', '不要等待完美的时刻，抓住此刻并让它变得完美。', 'Unknown'],
  ['Great things are done by a series of small things brought together.', '伟大的事，是由一连串小事汇聚而成的。', 'Vincent van Gogh'],
  ['Learning never exhausts the mind.', '学习永远不会令头脑疲惫。', 'Leonardo da Vinci'],
  ['Courage is not the absence of fear, but the triumph over it.', '勇气不是没有恐惧，而是战胜恐惧。', 'Nelson Mandela'],
  ['The future belongs to those who believe in the beauty of their dreams.', '未来属于那些相信梦想之美的人。', 'Eleanor Roosevelt'],
  ['A calm sea never made a skilled sailor.', '平静的海面练不出熟练的水手。', 'Unknown'],
  ['You are never too old to set another goal or to dream a new dream.', '设立新目标、拥有新梦想，永远不嫌晚。', 'C. S. Lewis'],
  ['Excellence is not an act, but a habit.', '卓越不是一种行为，而是一种习惯。', 'Aristotle'],
  ['The more that you read, the more things you will know.', '你读得越多，知道的就越多。', 'Dr. Seuss'],
  ['Energy and persistence conquer all things.', '精力与坚持能征服一切。', 'Benjamin Franklin'],
  ['Where there is a will, there is a way.', '有志者，事竟成。', 'Proverb'],
  ['Slow and steady wins the race.', '稳扎稳打，方能取胜。', 'Aesop'],
].map((q, i) => ({ id: i + 1, en: q[0], zh: q[1], author: q[2] }));

function pickQuote(dateISO) {
  const db = load();
  if (!db.meta.quoteUsed) db.meta.quoteUsed = {};
  const used = db.meta.quoteUsed;
  if (used[dateISO]) {
    const hit = QUOTES.find((q) => q.id === used[dateISO]);
    if (hit) return hit;
  }
  const unused = QUOTES.filter((q) => !Object.values(used).includes(q.id));
  const pool = unused.length ? unused : QUOTES;
  const q = pool[Math.floor(Math.random() * pool.length)];
  // 只留最近 60 天的记录，别无限膨胀
  const keys = Object.keys(used).sort();
  while (keys.length > 60) delete used[keys.shift()];
  used[dateISO] = q.id;
  save();
  return q;
}

/* ============================ 消息 ============================ */
function pushMessage({ type = 'system', title, body = '', link = '', refType = null, refId = null, dedupe = '', skipIfSameTitleToday = false }) {
  const db = load();
  db.messages = db.messages || [];
  if (dedupe && T('messages').some((m) => m.dedupe_key === dedupe)) return null;
  if (skipIfSameTitleToday) {
    const day = new Date().toISOString().slice(0, 10);
    if (T('messages').some((m) => m.title === String(title || '') && String(m.created_at || '').slice(0, 10) === day)) return null;
  }
  const id = T('messages').reduce((mx, m) => Math.max(mx, num(m.id)), 0) + 1;
  T('messages').push({
    id, type, title: String(title || ''), body: String(body || ''),
    ref_type: refType, ref_id: refId, read: 0, link: String(link || ''),
    dedupe_key: String(dedupe || ''), created_at: nowISO(),
  });
  save();
  return id;
}

/* 把「今天到期的事项 / 待办」变成任务提醒消息。
   打开消息中心时触发，够用且不用起定时器。 */
function syncTaskMessages() {
  try {
    const today = cnDate();
    for (const it of rowsOf('items').filter((x) => x.status !== 'done')) {
      const d = it.start_at ? String(it.start_at).slice(0, 10) : isoToCnDate(it.created_at);
      if (d !== today) continue;
      pushMessage({
        type: 'task', title: it.title,
        body: it.start_at ? `今天 ${String(it.start_at).slice(11, 16)} 的事项还没完成` : '今天记下的事项还没完成',
        link: '#/home', refType: 'items', refId: it.id,
        dedupe: `item-${it.id}-${today}`, skipIfSameTitleToday: true,
      });
    }
    for (const td of rowsOf('todos').filter((x) => x.status !== 'done')) {
      if (isoToCnDate(td.created_at) !== today) continue;
      pushMessage({
        type: 'task', title: td.title, body: '今天的便签还没划掉',
        link: '#/daily', refType: 'todos', refId: td.id,
        dedupe: `todo-${td.id}-${today}`, skipIfSameTitleToday: true,
      });
    }
  } catch { /* 静默失败，不影响主流程 */ }
}

/* 到点提醒：替代服务端的 setInterval(tick)。
   每次打开页面 / 拉消息时跑一遍，把已经到点的 scheduled 转成消息。 */
function tickReminders() {
  const db = load();
  const now = Date.now();
  for (const r of T('reminders') || []) {
    if (r.status !== 'scheduled' || !r.fire_at) continue;
    if (Number(r.fire_at) > now + 1000) continue;
    r.status = 'fired';
    pushMessage({
      type: 'remind', title: r.title,
      body: r.body || ('提醒时间：' + String(r.due_at || '').replace('T', ' ')),
      refType: 'reminder', refId: r.id,
    });
  }
  save();
}

function addReminder({ title, body = '', due_at, advance_min = 0, repeat = 'none', ring = 'chime', kind = 'item', item_id = null }) {
  const db = load();
  const fire = new Date(due_at).getTime() - (num(advance_min) || 0) * 60000;
  const id = (T('reminders') || []).reduce((mx, r) => Math.max(mx, num(r.id)), 0) + 1;
  T('reminders').push({
    id, item_id, kind, title, body, due_at, fire_at: fire, repeat,
    advance_min: num(advance_min) || 0, ring, status: 'scheduled', created_at: nowISO(),
  });
  save();
  return id;
}

/* ============================ 便签 ↔ 事项 同源 ============================ */
function syncItemToTodo(itemId, changed) {
  const db = load();
  const todo = (T('todos') || []).find((t) => !t.deleted_at && String(t.ref_item_id) === String(itemId))
    || (T('todos') || []).find((t) => {
      if (t.deleted_at) return false;
      const it = (T('items') || []).find((i) => String(i.id) === String(itemId));
      return it && String(it.ref_id) === String(t.id);
    });
  if (!todo) return;
  if (changed.status) todo.status = changed.status;
  if (changed.title !== undefined) todo.title = changed.title;
  if (changed.start_at !== undefined) todo.due_at = changed.start_at || null;
  todo.updated_at = nowISO();
  if (!todo.ref_item_id) todo.ref_item_id = Number(itemId);
  save();
}

/* ============================ 回收站 ============================ */
const RECYCLE_KEEP_DAYS = 30;
const RECYCLE_TITLE = {
  items: (r) => r.title, todos: (r) => r.title,
  lessons: (r) => `${r.date} ${r.class_name || ''} ${r.content || ''}`.trim(),
  invigilations: (r) => `${r.date} ${r.subject || ''} 监考`,
  trips: (r) => `${r.to_place || ''} 出差`,
  materials: (r) => r.title, notes: (r) => r.title, homework: (r) => r.title,
  studies: (r) => r.title,
  preps: (r) => `${r.date || ''} ${r.class_name || ''} ${r.topic || ''}`.trim(),
  courses: (r) => `周${r.weekday} 第${r.period_no}节 ${r.class_name || ''}`,
  categories: (r) => r.name, students: (r) => r.name,
  attendance_tables: (r) => r.name, attendance_rows: (r) => r.teacher,
  punishments: (r) => r.text, exceptions: (r) => `${r.date} 课表调整`,
  reminders: (r) => r.title,
  teachers: (r) => `${r.name || ''}${r.subject ? '（' + r.subject + '）' : ''}`,
  periods: (r) => `第${r.period_no}节${r.start_time ? ' ' + r.start_time + '-' + (r.end_time || '') : ''}`,
  trip_items: (r) => `${r.kind || '明细'} ${r.amount ? '¥' + r.amount : ''} ${r.note || ''}`.trim(),
  attachments: (r) => r.name,
  rosters: (r) => r.class_name || r.grade,
  students_att: (r) => r.name,
  punish_records: (r) => r.text,
};
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
  rosters: { group: 'other', at: '班级 → 点名名单' },
  punish_records: { group: 'other', at: '课堂 → 惩罚记录' },
};

function recyclePut(table, id, extraTitle = '') {
  const db = load();
  db.recycle = db.recycle || [];
  const row = (db[table] || []).find((r) => String(r.id) === String(id));
  if (!row) return null;
  const ts = nowISO();
  row.deleted_at = ts;
  const gen = RECYCLE_TITLE[table];
  const title = String((gen ? gen(row) : '') || row.title || row.name || '(无标题)').slice(0, 120);
  const rid = T('recycle').reduce((mx, r) => Math.max(mx, num(r.id)), 0) + 1;
  T('recycle').push({
    id: rid, entity: table, entity_id: Number(row.id),
    title: title + (extraTitle || ''), payload: JSON.stringify(row), deleted_at: ts,
  });
  // 主表删了，从表跟着进回收站（否则还原后表回来了、格子全空）
  if (table === 'attendance_tables') {
    for (const k of (T('attendance_rows') || []).filter((r) => String(r.table_id) === String(id) && !r.deleted_at)) {
      k.deleted_at = ts;
      const kid = T('recycle').reduce((mx, r) => Math.max(mx, num(r.id)), 0) + 1;
      T('recycle').push({
        id: kid, entity: 'attendance_rows', entity_id: Number(k.id),
        title: String(k.teacher || '(明细)').slice(0, 120), payload: JSON.stringify(k), deleted_at: ts,
      });
    }
  }
  save();
  return rid;
}

function purgeExpiredRecycle() {
  const db = load();
  db.recycle = db.recycle || [];
  const cutoff = new Date(Date.now() - RECYCLE_KEEP_DAYS * 86400e3).toISOString();
  const dead = T('recycle').filter((r) => r.deleted_at < cutoff);
  for (const r of dead) {
    const arr = db[r.entity] || [];
    const i = arr.findIndex((x) => String(x.id) === String(r.entity_id));
    if (i >= 0) arr.splice(i, 1);
  }
  db.recycle = db.recycle.filter((r) => r.deleted_at >= cutoff);
  if (dead.length) save();
  return dead.length;
}

/* ============================ 课时汇总 ============================ */
/* 核心规则：课时只归一个人。
   normal     正常上课      hours 归我，计入课时
   替他人上   我代别人      hours 归我（额外），月底应收对方
   他人替我上 别人代我      hours = 0（归代课人），月底应付对方
   换课       互换          hours 归我（课时没变），不计账，只备查 */
function buildLessonSummary(rows, pricePerHour = 30) {
  const out = {
    total_hours: 0, lesson_count: 0, normal_count: 0,
    sub_out: { count: 0, hours: 0, amount: 0 },
    sub_in: { count: 0, hours: 0, amount: 0 },
    swap: { count: 0 },
    net: { hours: 0, amount: 0, direction: 'even' },
    people: [], by_subject: {},
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

    const isOut = t === '替他人上';
    const bucket = isOut ? out.sub_out : out.sub_in;
    bucket.count += 1;
    bucket.hours += ph;
    bucket.amount += pa;

    const name = String(r.peer_name || r.orig_teacher || '').trim() || '(未填对方)';
    const key = name + '|' + (isOut ? 'out' : 'in');
    if (!peopleMap.has(key)) {
      peopleMap.set(key, {
        name, direction: isOut ? 'out' : 'in',
        count: 0, hours: 0, amount: 0,
        open_hours: 0, open_amount: 0,
        settled: false, settled_count: 0, ids: [], subjects: [],
        open_ids: [], open_items: [],
      });
    }
    const p = peopleMap.get(key);
    p.count += 1;
    p.hours += ph;
    p.amount += pa;
    p.ids.push(r.id);
    if (r.subject && !p.subjects.includes(r.subject)) p.subjects.push(r.subject);
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
    p.settled = p.count > 0 && p.settled_count === p.count;
    p.partial = p.settled_count > 0 && !p.settled;
    p.open_items.sort((a, b) => (a.date === b.date ? a.period_no - b.period_no : a.date < b.date ? -1 : 1));
    out.people.push(p);
  }
  out.people.sort((a, b) => (a.direction === b.direction ? b.amount - a.amount : a.direction === 'out' ? -1 : 1));

  let netHours = 0; let netAmount = 0;
  for (const p of out.people) {
    const sign = p.direction === 'out' ? 1 : -1;
    netHours += sign * p.open_hours;
    netAmount += sign * p.open_amount;
  }
  out.net.hours = Math.round(netHours * 10) / 10;
  out.net.amount = n2(netAmount);
  out.net.direction = netAmount > 0 ? 'receivable' : netAmount < 0 ? 'payable' : 'even';
  out.price_per_hour = pricePerHour;
  return out;
}

/* ============================ 监考汇总 ============================ */
const DEFAULT_INVIG_RULES = {
  mode: '场次',
  perSession: 60,
  perHour: 30,
  peerPerSession: 50,
  tiers: [
    { max: 90, amount: 50 },
    { max: 150, amount: 70 },
    { max: 999, amount: 90 },
  ],
};
function getInvigRules() {
  const st = currentUser().settings || {};
  return { ...DEFAULT_INVIG_RULES, ...(st.invig || {}) };
}

function buildInvSummary(rows, rules = {}) {
  const out = {
    total: 0,
    school: { count: 0, amount: 0, paid: 0, unpaid: 0 },
    sub_out: { count: 0, hours: 0, amount: 0, open_amount: 0 },
    sub_in: { count: 0, hours: 0, amount: 0, open_amount: 0 },
    net: { amount: 0, direction: 'even' },
    people: [], by_room: {}, minutes: 0, rules,
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
  out.net.amount = n2(net);
  out.net.direction = net > 0 ? 'receivable' : net < 0 ? 'payable' : 'even';
  return out;
}

/* ============================ 出差报销 ============================ */
const TRIP_DEFAULT = { foodPerDay: 100, localPerDay: 40 };
const KIND_TXT = { transport: '交通', hotel: '住宿', taxi: '打车', meal: '餐饮', toll: '过路费', parking: '停车费', other: '其他' };
const moneyFmt = (v) => n2(v).toFixed(2).replace(/\.00$/, '');

function tripRules() {
  const t = (currentUser().settings || {}).trip || {};
  return {
    foodPerDay: (t.foodPerDay != null && t.foodPerDay !== '' && Number.isFinite(Number(t.foodPerDay))) ? Number(t.foodPerDay) : TRIP_DEFAULT.foodPerDay,
    localPerDay: (t.localPerDay != null && t.localPerDay !== '' && Number.isFinite(Number(t.localPerDay))) ? Number(t.localPerDay) : TRIP_DEFAULT.localPerDay,
  };
}

/* 天数：优先手填，否则按起止日期算（首尾都算，差 0 天算 1 天） */
function tripDays(t) {
  if (t.days != null && t.days !== '' && Number(t.days) > 0) return Number(t.days);
  const s = String(t.start_date || '').slice(0, 10);
  const e = String(t.end_date || '').slice(0, 10) || s;
  if (!s) return 1;
  const d = Math.round((new Date(e + 'T00:00:00').getTime() - new Date(s + 'T00:00:00').getTime()) / 86400000);
  return d >= 0 ? d + 1 : 1;
}

function calcTrip(t, rules, items = []) {
  const days = tripDays(t);
  const real = {
    transport: n2(t.transport), hotel: n2(t.hotel), taxi: n2(t.taxi),
    toll: n2(t.toll), parking: n2(t.parking), other: n2(t.other),
  };
  /* 明细里填的金额汇总到对应类别，与主表手填金额取「较大者」：
     有人习惯写总数，有人习惯逐张录明细，两种都要能用，但不能相加（否则记两遍翻倍）。 */
  const byKind = {};
  for (const it of items) {
    const k = ['transport', 'hotel', 'taxi', 'toll', 'parking'].includes(it.kind) ? it.kind : 'other';
    byKind[k] = n2((byKind[k] || 0) + n2(it.amount));
  }
  for (const k of Object.keys(byKind)) if (byKind[k] > real[k]) real[k] = byKind[k];

  const realTotal = n2(Object.values(real).reduce((a, b) => a + b, 0));
  const food = (t.subsidy_food != null && Number(t.subsidy_food) > 0) ? n2(t.subsidy_food) : n2(rules.foodPerDay * days);
  const local = (t.subsidy_local != null && Number(t.subsidy_local) > 0) ? n2(t.subsidy_local) : n2(rules.localPerDay * days);
  const subsidyTotal = n2(food + local);
  const total = n2(realTotal + subsidyTotal);
  const advance = n2(t.advance);
  const net = n2(total - advance);
  const missing = items.filter((it) => !it.has_invoice);
  const bigMissing = missing.filter((it) => Number(it.amount) >= 100 && ['transport', 'hotel', 'taxi'].includes(it.kind));
  return {
    days, real, byKind, realTotal, food, local, subsidyTotal, total, advance, net,
    itemCount: items.length,
    missingCount: missing.length,
    bigMissingCount: bigMissing.length,
    noInvoice: missing.length,
  };
}

function tripWithCalc(t, rules) {
  const items = (load().trip_items || [])
    .filter((r) => !r.deleted_at && String(r.trip_id) === String(t.id))
    .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')) || a.id - b.id);
  return { ...t, items, calc: calcTrip(t, rules, items) };
}

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
    for (const [k, v] of realLines) L.push(`　${k}：¥${moneyFmt(v)}`);
    const detail = (t.items || []).filter((it) => Number(it.amount) > 0);
    if (detail.length) {
      L.push('　明细：');
      for (const it of detail.slice(0, 12)) {
        L.push(`　　· ${it.date || ''} ${KIND_TXT[it.kind] || '其他'} ¥${moneyFmt(it.amount)}${it.note ? ' ' + it.note : ''}${it.has_invoice ? '' : '（无票）'}`);
      }
      if (detail.length > 12) L.push(`　　· 其余 ${detail.length - 12} 笔略`);
    }
    L.push(`　小计：¥${moneyFmt(c.realTotal)}`);
  } else {
    L.push('　（无）');
  }
  L.push('');
  L.push('二、定额补贴（无需发票）');
  L.push(`　伙食补助：¥${moneyFmt(c.food)}（${moneyFmt(c.food / (c.days || 1))}/天 × ${c.days} 天）`);
  L.push(`　市内交通补助：¥${moneyFmt(c.local)}（${moneyFmt(c.local / (c.days || 1))}/天 × ${c.days} 天）`);
  L.push(`　小计：¥${moneyFmt(c.subsidyTotal)}`);
  L.push('');
  if (c.advance > 0) { L.push(`三、预借/垫付：¥${moneyFmt(c.advance)}`); L.push(''); }
  L.push(`合计应报：¥${moneyFmt(c.total)}${c.advance > 0 ? `　扣除预借后应补：¥${moneyFmt(c.net)}` : ''}`);
  if (Number(t.km) > 0) L.push(`自驾里程：${t.km} km`);
  if (c.missingCount) {
    L.push(`备注：有 ${c.missingCount} 笔无发票${c.bigMissingCount ? `（其中 ${c.bigMissingCount} 笔为大额，建议补票）` : ''}——${(t.items || []).filter((i) => !i.has_invoice).map((i) => `${KIND_TXT[i.kind] || '其他'}¥${moneyFmt(i.amount)}`).slice(0, 5).join('、')}`);
  }
  if (t.remark) L.push(`补充说明：${t.remark}`);
  return L.join('\n');
}

/* ============================ 考勤表 ============================ */
function defaultCols(kind) {
  if (kind === 'research') {
    return [
      { key: 'k_签到', label: '签到', type: 'check', w: 62 },
      { key: 'k_remark', label: '签到时间 / 备注', type: 'text', w: 160 },
    ];
  }
  return [
    { key: 'k_上课', label: '上课', type: 'check', w: 62 },
    { key: 'k_坐班', label: '坐班', type: 'check', w: 62 },
    { key: 'k_听课', label: '听课', type: 'check', w: 62 },
    { key: 'k_教研', label: '教研', type: 'check', w: 62 },
    { key: 'k_请假', label: '请假', type: 'check', w: 62 },
    { key: 'k_remark', label: '备注', type: 'text', w: 130 },
  ];
}

function attTablesList(q = {}) {
  const out = rowsOf('attendance_tables')
    .filter((t) => (!q.kind || t.kind === q.kind) && (!q.grade || t.grade === q.grade))
    .sort((a, b) => String(b.sheet_date || '').localeCompare(String(a.sheet_date || '')) || b.id - a.id);
  return out.map((t) => {
    const rows = (load().attendance_rows || []).filter((r) => !r.deleted_at && String(r.table_id) === String(t.id));
    const cols = typeof t.columns === 'string' ? JSON.parse(t.columns || '[]') : (t.columns || []);
    let leaveCount = 0; let unchecked = 0; const leaveNames = [];
    for (const r of rows) {
      const d = typeof r.data === 'string' ? JSON.parse(r.data || '{}') : (r.data || {});
      const isLeave = Object.entries(d).some(([k, v]) => /请假/.test(k) && v === '1');
      if (isLeave) { leaveCount++; leaveNames.push(r.teacher); }
      const anyChecked = cols.some((c) => c.type === 'check' && /上课|坐班|签到|教研|听课/.test(c.label) && d[c.key] === '1');
      if (!anyChecked && !isLeave) unchecked++;
    }
    const subjects = [...new Set(rows.map((r) => r.subject).filter(Boolean))];
    return {
      ...t,
      sheet_type: t.sheet_type || t.kind,
      columns: cols,
      meta: typeof t.meta === 'string' ? JSON.parse(t.meta || '{}') : (t.meta || {}),
      row_count: rows.length,
      subjects,
      summary: { leave: leaveCount, leave_names: leaveNames.slice(0, 6), none: unchecked },
    };
  });
}

function attTableDetail(id) {
  const t = byId('attendance_tables', id);
  if (!t) fail(404, '考勤表不存在');
  const rows = (load().attendance_rows || [])
    .filter((r) => !r.deleted_at && String(r.table_id) === String(t.id))
    .sort((a, b) => (num(a.sort) - num(b.sort)) || a.id - b.id)
    .map((r) => ({ ...r, data: typeof r.data === 'string' ? JSON.parse(r.data || '{}') : (r.data || {}) }));
  const photoCount = (load().attachments || []).filter((a) => !a.deleted_at && a.owner_type === 'attendance' && String(a.owner_id) === String(t.id)).length;
  return {
    ...t,
    columns: typeof t.columns === 'string' ? JSON.parse(t.columns || '[]') : (t.columns || []),
    meta: typeof t.meta === 'string' ? JSON.parse(t.meta || '{}') : (t.meta || {}),
    photo_count: photoCount,
    rows,
  };
}

function attStats(id) {
  const d = attTableDetail(id);
  const cols = d.columns;
  const keyOf = (re) => cols.find((c) => re.test(c.label))?.key;
  const kReason = keyOf(/原因|备注/) || 'remark';
  const kStatus = keyOf(/状态|坐班/);
  const kHours = keyOf(/时长/);
  const teachers = [...new Set(d.rows.map((r) => r.teacher))];
  const stats = teachers.map((name) => {
    const rs = d.rows.filter((r) => r.teacher === name);
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
  return { table: { ...d, columns: cols }, stats };
}

/* 粘贴板表格：Tab 分隔优先，否则两个以上空格或逗号 */
function parseClipboardTable(text) {
  const lines = String(text).replace(/\r/g, '').split('\n').filter((l) => l.trim() !== '');
  return lines.map((l) => (l.includes('\t') ? l.split('\t') : l.split(/\s{2,}|,/)).map((s) => s.trim()));
}

/* ============================ 点名 ============================ */
function stuKey(s) {
  return String(s || '')
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/\s+/g, '')
    .toLowerCase()
    .slice(0, 40);
}
const ROLL_STATUS = ['present', 'late', 'leave', 'absent'];

function rollSessions(date) {
  const db = load();
  db.roll_sessions = db.roll_sessions || [];
  db.roll_records = db.roll_records || [];
  return T('roll_sessions')
    .filter((s) => !s.deleted_at && s.date === date)
    .sort((a, b) => (num(a.period_no) - num(b.period_no)) || a.id - b.id);
}
function rollCount(sessionId) {
  const recs = (load().roll_records || []).filter((r) => String(r.session_id) === String(sessionId));
  const c = { total: recs.length, present: 0, late: 0, leave: 0, absent: 0 };
  for (const r of recs) if (r.status in c) c[r.status] += 1;
  return c;
}

/* ============================ 导出（CSV / JSON / HTML） ============================ */
function buildExport(kind, month) {
  const M = (col) => (month ? (r) => String(r[col] || '').startsWith(month) : () => true);
  let title = '导出'; let headers = []; let rows = []; let extraHtml = '';
  if (kind === 'lessons') {
    title = `课时统计${month ? ' ' + month : ''}`;
    headers = ['序号', '日期', '节次', '时间', '年级', '班级', '科目', '任课', '代课人', '代课类型', '课时', '上课内容', '教学进度', '下节课内容', '违纪情况', '备注'];
    rows = rowsOf('lessons').filter(M('date')).sort((a, b) => String(a.date).localeCompare(String(b.date)) || num(a.period_no) - num(b.period_no))
      .map((r) => [r.seq, r.date, r.period_no, r.start_time ? `${r.start_time}-${r.end_time}` : r.time_range, r.grade, r.class_name, r.subject, r.teacher, r.substitute, r.sub_type === 'none' ? '' : r.sub_type, r.hours, r.content, r.progress, r.next_content, r.discipline, r.remark]);
    const hours = rows.reduce((s, r) => s + (Number(r[10]) || 0), 0);
    extraHtml = `<div class="sum">本月合计：${rows.length} 节，${hours} 课时；其中代课 ${rows.filter((r) => r[9]).length} 节</div>`;
  } else if (kind === 'invigilations') {
    title = `监考统计${month ? ' ' + month : ''}`;
    headers = ['序号', '日期', '类型', '相关人', '科目', '年级', '开始', '结束', '时长(分钟)', '金额(元)', '已支付', '地点', '领卷', '领卷地点', '备注'];
    rows = rowsOf('invigilations').filter(M('date')).sort((a, b) => String(a.date).localeCompare(String(b.date)))
      .map((r) => [r.seq, r.date, r.type, r.person, r.subject, r.grade, r.start_at, r.end_at, r.minutes, r.amount, r.paid ? '是' : '否', r.place, r.need_paper ? '是' : '否', r.paper_place, r.remark]);
    const mins = rows.reduce((s, r) => s + (Number(r[8]) || 0), 0);
    extraHtml = `<div class="sum">本月合计：${rows.length} 场，共 ${mins} 分钟</div>`;
  } else if (kind === 'trips') {
    title = `出差统计${month ? ' ' + month : ''}`;
    headers = ['序号', '开始', '结束', '出发地', '目的地', '事由', '随行人员', '公里数', '过路费', '停车费', '其他', '合计(元)', '状态', '备注'];
    rows = rowsOf('trips').filter(M('start_date')).sort((a, b) => String(a.start_date).localeCompare(String(b.start_date)))
      .map((r) => [r.seq, r.start_date, r.end_date, r.from_place, r.to_place, r.reason, r.companions, r.km, r.toll, r.parking, r.other, (num(r.toll) + num(r.parking) + num(r.other)), r.status, r.remark]);
    const total = rows.reduce((s, r) => s + (Number(r[11]) || 0), 0);
    extraHtml = `<div class="sum">本月合计：${rows.length} 次，费用 ${total} 元</div>`;
  } else if (kind === 'studies') {
    title = '学习记录';
    headers = ['序号', '日期', '标题', '内容', '时长(分钟)', '来源', '标签'];
    rows = rowsOf('studies').filter(M('date')).sort((a, b) => String(a.date).localeCompare(String(b.date)))
      .map((r) => [r.seq, r.date, r.title, r.content, r.minutes, r.source, r.tags]);
  } else if (kind === 'homework') {
    title = '作业完成情况';
    headers = ['序号', '作业', '班级', '布置日期', '截止', '学生', '状态', '得分', '备注'];
    rows = [];
    const recs = load().homework_records || [];
    for (const h of rowsOf('homework')) {
      for (const r of recs.filter((x) => String(x.homework_id) === String(h.id) && !x.deleted_at)) {
        rows.push([h.seq, h.title, h.class_name, h.assign_date, h.due_date, r.student_name, r.status, r.score, r.remark]);
      }
    }
  } else if (kind === 'attendance') {
    const t = byId('attendance_tables', Number(month) || 0);
    if (!t) { headers = ['提示']; rows = [['未找到考勤表，请传 month 参数为表 id']]; }
    else {
      const d = attTableDetail(t.id);
      colsPush(d, (title2, headers2, rows2) => { title = title2; headers = headers2; rows = rows2; });
    }
  } else if (kind === 'students') {
    title = '学生名单'; headers = ['序号', '年级', '班级', '姓名', '编号'];
    rows = rowsOf('students').sort((a, b) => String(a.grade).localeCompare(String(b.grade)) || String(a.class_name).localeCompare(String(b.class_name)) || num(a.no) - num(b.no))
      .map((s) => [s.no, s.grade, s.class_name, s.name, s.no]);
  } else {
    title = '事项'; headers = ['序号', '类型', '标题', '详情', '开始', '结束', '状态'];
    rows = rowsOf('items').sort((a, b) => a.id - b.id)
      .map((r) => [r.seq, r.kind, r.title, r.detail, r.start_at, r.end_at, r.status]);
  }

  function colsPush(d) {
    title = d.name;
    headers = ['序号', '姓名', '学科', ...d.columns.map((c) => c.label)];
    rows = d.rows.map((r, i) => [
      i + 1, r.teacher || '', r.subject || '',
      ...d.columns.map((c) => (c.type === 'check' ? (r.data[c.key] === '1' ? '√' : r.data[c.key] === '0' ? '×' : '') : (r.data[c.key] ?? ''))),
    ]);
  }

  const html = exportHtml(title, headers, rows, extraHtml);
  return { title, headers, rows, html };
}

function exportHtml(title, headers, rows, extra) {
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const u = currentUser();
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

/* ============================ 种子数据 ============================ */
/* 对应 server/seed.mjs。新用户第一次进来是空工作台很容易被当成「坏了」，
   所以灌一份可用的示例数据，用户可以直接改、可以删。 */
const PUNISH = [
  ['表演才艺', '唱歌、朗诵或讲个笑话，30 秒', 'light'],
  ['背诵一句名言', '说出今天黑板上的每日名言英文', 'light'],
  ['领读课文', '带全班朗读今天的课文段落', 'average'],
  ['当小老师', '为大家讲解一道题', 'average'],
  ['总结知识点', '用一句话总结本节课重点', 'average'],
  ['回答加分题', '回答老师提出的拓展问题', 'average'],
  ['帮同学解答', '给同桌讲一遍刚才的题目', 'average'],
  ['下节课开头复盘', '下次课用 1 分钟回顾今天内容', 'heavy'],
  ['整理板书', '值日整理今天的板书与讲台', 'light'],
  ['英语自我介绍', '30 秒英文自我介绍', 'heavy'],
];

export function seedIfEmpty() {
  const db = load();
  if (db.meta.seeded) return false;
  const probe = ['periods', 'courses', 'students', 'categories'].some((t) => (db[t] || []).length);
  if (probe) { db.meta.seeded = true; save(); return false; }

  const now = nowISO();
  let idC = {};

  // 节次
  const periods = [
    [1, '第一节', '07:40', '08:25'], [2, '第二节', '08:35', '09:20'],
    [3, '第三节', '09:35', '10:20'], [4, '第四节', '10:30', '11:15'],
    [5, '第五节', '11:25', '12:10'], [6, '第六节', '14:20', '15:05'],
    [7, '第七节', '15:15', '16:00'], [8, '第八节', '16:10', '16:55'],
    [9, '晚自习一', '19:00', '19:45'], [10, '晚自习二', '19:55', '20:40'],
  ];
  let pid = 0;
  for (const p of periods) {
    pid += 1;
    T('periods').push({ id: pid, period_no: p[0], name: p[1], start_time: p[2], end_time: p[3], created_at: now, updated_at: now, deleted_at: null });
  }

  // 课表（高二 · 语文）
  const plan = {
    1: [[1, '高二(3)班'], [2, '高二(3)班'], [3, '高二(5)班'], [6, '高二(5)班']],
    2: [[1, '高二(5)班'], [4, '高二(3)班'], [7, '高二(3)班']],
    3: [[2, '高二(3)班'], [3, '高二(5)班'], [6, '高二(3)班'], [9, '高二(5)班']],
    4: [[1, '高二(5)班'], [5, '高二(3)班'], [7, '高二(5)班']],
    5: [[2, '高二(3)班'], [4, '高二(5)班'], [8, '高二(3)班']],
  };
  let cid = 0;
  for (const [wd, list] of Object.entries(plan)) {
    for (const [pn, cls] of list) {
      const p = periods.find((x) => x[0] === pn);
      cid += 1;
      T('courses').push({
        id: cid, weekday: Number(wd), period_no: pn, start_time: p[2], end_time: p[3],
        grade: '高二', class_name: cls, subject: '语文', room: `教学楼${wd}0${(pn % 5) + 1}`,
        created_at: now, updated_at: now, deleted_at: null,
      });
    }
  }

  const today = new Date();
  const t = todayStr();
  const nextDay = new Date(today.getTime() + 864e5);
  const addItem = (kind, title, detail, start_at, end_at, priority) => {
    const id = T('items').reduce((mx, x) => Math.max(mx, num(x.id)), 0) + 1;
    T('items').push({
      id, seq: nextSeq('item'), kind, title, detail, start_at, end_at: end_at || null,
      status: 'todo', priority, source: '', created_at: now, updated_at: now, deleted_at: null,
    });
  };
  addItem('事项', '高二语文备课组会', '讨论下周《劝学》教学进度', `${t}T16:10`, `${t}T17:00`, 'high');
  addItem('任务', '提交十月课时统计表', '月底与财务核对课时', `${ymd(nextDay)}T09:00`, null, 'urgent');
  addItem('倒计时', '期中考试命题截止', '完成试卷与答题卡', `${ymd(new Date(today.getTime() + 5 * 864e5))}T18:00`, null, 'high');

  // 便签
  const addTodo = (title, status) => {
    const id = T('todos').reduce((mx, x) => Math.max(mx, num(x.id)), 0) + 1;
    T('todos').push({ id, seq: nextSeq('todo'), title, content: '', status, color: '', due_at: null, created_at: now, updated_at: now, deleted_at: null });
  };
  addTodo('把月考答题卡交到教务处', 'todo');
  addTodo('给(3)班准备《劝学》课件', 'doing');
  addTodo('联系家长沟通作业情况', 'done');

  // 学生名单
  const names = ['张一诺', '李晨阳', '王思远', '赵梦琪', '陈嘉禾', '刘子涵', '杨博文', '黄雨桐', '周轩宇', '吴可欣',
    '徐若彤', '孙浩然', '马睿哲', '朱怡然', '胡佳隽', '郭欣怡', '何俊熙', '高子昂', '林书瑶', '罗嘉颖',
    '郑亦航', '梁泽宇', '谢可儿', '唐语晨', '许亦辰', '邓沐阳', '冯婧仪', '曹梓萱', '彭一鸣', '苏念安',
    '蒋若冰', '韩子墨', '沈知远', '程嘉懿', '陆星野', '任以宁', '袁清和', '于书言', '董晨曦', '余乐彤'];
  let sid = 0;
  names.forEach((name, i) => {
    sid += 1;
    T('students').push({ id: sid, grade: '高二', class_name: '高二(3)班', name, no: i + 1, created_at: now, updated_at: now, deleted_at: null });
  });
  names.slice(0, 38).forEach((name, i) => {
    sid += 1;
    T('students').push({ id: sid, grade: '高二', class_name: '高二(5)班', name, no: i + 1, created_at: now, updated_at: now, deleted_at: null });
  });

  // 分类
  const addCat = (scope, nm, sort) => {
    const id = T('categories').reduce((mx, x) => Math.max(mx, num(x.id)), 0) + 1;
    T('categories').push({ id, scope, name: nm, sort, created_at: now, updated_at: now, deleted_at: null });
    return id;
  };
  const matCat = {};
  ['必修上册', '必修下册', '选择性必修', '作文素材', '试卷'].forEach((nm, i) => { matCat[nm] = addCat('material', nm, i); });
  const noteCat = {};
  ['教学资料', '课文解读', '教研记录', '学生问题'].forEach((nm, i) => { noteCat[nm] = addCat('note', nm, i); });
  ['专业阅读', '通识', '英语提升', '教研培训'].forEach((nm, i) => addCat('study', nm, i));

  // 笔记
  const notes = [
    ['《劝学》教学设计', '## 教学目标\n1. 掌握"劝、学、青、中、疾、致、假、绝、兴、功、强、用"等重点实词\n2. 理解比喻论证、对比论证的方法\n3. 体会荀子"学不可以已"的思想\n\n## 教学重点\n比喻论证的内在逻辑：青出于蓝、冰寒于水……\n\n## 板书设计\n学不可以已 → 为什么学 → 怎么学 → 态度'],
    ['学生常见病句类型汇总', '1. 语序不当\n2. 搭配不当\n3. 成分残缺或赘余\n4. 结构混乱\n5. 表意不明\n6. 不合逻辑'],
    ['十月教研会记录', '时间：10 月 15 日\n地点：高二语文组办公室\n议题：期中考试范围与命题分工'],
  ];
  notes.forEach(([title, content], i) => {
    const id = T('notes').reduce((mx, x) => Math.max(mx, num(x.id)), 0) + 1;
    T('notes').push({
      id, seq: nextSeq('note'), category_id: noteCat[Object.keys(noteCat)[i]] || null,
      title, content, tags: '', pinned: i === 0 ? 1 : 0,
      created_at: now, updated_at: now, deleted_at: null,
    });
  });

  // 学习记录
  for (let i = 0; i < 10; i += 1) {
    const d = new Date(today.getTime() - ((i * 2 + 1) % 20) * 864e5);
    const id = T('studies').reduce((mx, x) => Math.max(mx, num(x.id)), 0) + 1;
    T('studies').push({
      id, seq: nextSeq('study'), date: ymd(d), category_id: null,
      title: i % 2 ? '读《语文学习任务设计》' : '《红楼梦》整本书阅读指导',
      content: '记录要点若干', minutes: 30 + (i % 4) * 15,
      source: '', tags: '', created_at: now, updated_at: now, deleted_at: null,
    });
  }

  // 惩罚库
  for (const p of PUNISH) {
    const id = T('punishments').reduce((mx, x) => Math.max(mx, num(x.id)), 0) + 1;
    T('punishments').push({ id, text: p[0] + '：' + p[1], level: p[2], active: 1, created_at: now, updated_at: now, deleted_at: null });
  }

  // 学生短链
  const linkCode = randomCode(6);
  T('links').push({ id: 1, code: linkCode, title: '高二语文资料站', grades: JSON.stringify(['高二']), enabled: 1, created_at: now, updated_at: now, deleted_at: null });

  // 点名名单
  T('rosters').push({ id: 1, grade: '高二', class_name: '高二(3)班', count: 45, names: JSON.stringify(names), created_at: now, updated_at: now, deleted_at: null });
  T('rosters').push({ id: 2, grade: '高二', class_name: '高二(5)班', count: 38, names: JSON.stringify(names.slice(0, 38)), created_at: now, updated_at: now, deleted_at: null });

  // 课件（示例文件内容直接内联，学生端打开就能看）
  const mats = [
    [matCat['必修上册'], '《劝学》第一课时课件', '高二', '高二(3)班', '导学案 + 课堂任务单，共 3 个附件', '劝学-导学案.md', '# 《劝学》导学案\n\n## 一、通假字\n- 輮以为轮（輮，通“煣”）\n- 虽有槁暴（有，通“又”；暴，通“曝”）\n\n## 二、词类活用\n- 木直中绳，輮以为轮（輮：动词的使动用法）\n\n## 三、思考题\n1. 作者为什么用“青出于蓝”开头？\n2. 与《师说》的说理方式有什么不同？\n'],
    [matCat['选择性必修'], '《红楼梦》整本书阅读任务单', '高二', '高二(5)班', '四周阅读计划与章节任务', '红楼梦任务单.md', '# 《红楼梦》整本书阅读任务单\n\n| 周次 | 回目 | 任务 |\n| --- | --- | --- |\n| 第 1 周 | 1-5 回 | 梳理贾府人物关系图 |\n| 第 2 周 | 6-20 回 | 摘抄 3 处细节描写并批注 |\n| 第 3 周 | 21-50 回 | 分析“黛玉进府”的叙事视角 |\n| 第 4 周 | 51-80 回 | 完成一篇 800 字读书笔记 |\n'],
    [matCat['作文素材'], '议论文素材积累（十月）', '高二', '', '分“家国”“坚持”“创新”三类，可直接背诵', '作文素材-十月.md', '# 议论文素材（十月）\n\n## 家国\n- 樊锦诗：半个世纪守护敦煌\n\n## 坚持\n- 苏炳添：32 岁跑出 9 秒 83\n\n## 创新\n- 屠呦呦：190 次失败后提取青蒿素\n'],
  ];
  let mid = 0;
  let aid = 0;
  for (const [catId, title, grade, cls, descr, fname, content] of mats) {
    mid += 1;
    T('materials').push({
      id: mid, seq: nextSeq('material'), category_id: catId, title, grade,
      class_name: cls, descr, public: 1, views: 0, downloads: 0,
      created_at: now, updated_at: now, deleted_at: null,
    });
    aid += 1;
    /* 附件：真实文件内容存 localStorage 塞不下（5MB 上限），
       这里把示例文本存进 meta.seedFiles，按需取出当下载内容用。 */
    db.meta.seedFiles = db.meta.seedFiles || {};
    db.meta.seedFiles[`seed-${mid}-${fname}`] = content;
    T('attachments').push({
      id: aid, owner_type: 'material', owner_id: mid, name: fname,
      mime: 'text/markdown; charset=utf-8', size: content.length,
      path: `seed-${mid}-${fname}`, created_at: now, updated_at: now, deleted_at: null,
    });
  }

  // 考勤表（教研签到 & 坐班）
  seedAttendance(db, now);

  // 出差 & 监考示例
  const inv1 = db.invigilations.reduce((mx, x) => Math.max(mx, num(x.id)), 0) + 1;
  db.invigilations.push({
    id: inv1, seq: nextSeq('invig'), date: t, type: '学校分配', duty_type: 'school',
    person: '本人', subject: '语文', grade: '高二', start_at: `${t}T09:00`, end_at: `${t}T11:30`,
    start_time: '09:00', end_time: '11:30', minutes: 150, duration_min: 150,
    amount: 0, pay_amount: 70, pay_rule: '学校分配 · 150 分钟档', paid: 1, place: '实验楼 301', room: '实验楼 301',
    need_paper: 1, paper_place: '教务处资料室', status: 'done', school_paid: 0,
    created_at: now, updated_at: now, deleted_at: null,
  });
  const d3 = ymd(new Date(today.getTime() - 3 * 864e5));
  const inv2 = db.invigilations.reduce((mx, x) => Math.max(mx, num(x.id)), 0) + 1;
  db.invigilations.push({
    id: inv2, seq: nextSeq('invig'), date: d3, type: '我代他人', duty_type: '替他人',
    person: '王老师', peer_name: '王老师', subject: '数学', grade: '高二',
    start_at: `${d3}T14:30`, end_at: `${d3}T16:00`, start_time: '14:30', end_time: '16:00',
    minutes: 90, duration_min: 90, amount: 100, pay_amount: 50, paid: 0,
    place: '教学楼 205', room: '教学楼 205', need_paper: 0, paper_place: '', status: 'done',
    created_at: now, updated_at: now, deleted_at: null,
  });
  const d10 = ymd(new Date(today.getTime() - 10 * 864e5));
  const d9 = ymd(new Date(today.getTime() - 9 * 864e5));
  T('trips').push({
    id: 1, seq: nextSeq('trip'), start_date: d10, end_date: d9,
    from_place: '学校', to_place: '市教研室（江城区）', reason: '高二语文命题培训',
    companions: '李老师、陈老师', km: 86, toll: 40, parking: 15, other: 0,
    status: 'approved', reimb_status: 'paid', remark: '已完成报销',
    created_at: now, updated_at: now, deleted_at: null,
  });

  db.meta.seeded = true;
  db.meta.linkCode = linkCode;
  save();
  return true;
}

function seedAttendance(db, now) {
  const t = new Date();
  const month = `${t.getFullYear()}-${pad2(t.getMonth() + 1)}`;
  const teachers = ['张老师', '李老师', '王老师', '赵老师', '陈老师', '刘老师', '杨老师', '黄老师'];
  const WD_CN_S = ['日', '一', '二', '三', '四', '五', '六'];
  const dstr = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

  const tid = (T('attendance_tables').reduce((mx, x) => Math.max(mx, num(x.id)), 0)) + 1;
  const colsResearch = [
    { key: 'date', label: '日期', type: 'text', w: 92 },
    { key: 'weekday', label: '星期', type: 'text', w: 56 },
    { key: 'sign_in', label: '签到时间', type: 'text', w: 88 },
    { key: 'sign_out', label: '签退时间', type: 'text', w: 88 },
    { key: 'place', label: '教研地点', type: 'text', w: 110 },
    { key: 'topic', label: '教研主题', type: 'text', w: 150 },
    { key: 'status', label: '状态', type: 'select', options: ['已参加', '请假', '缺席', '公出'], w: 76 },
    { key: 'remark', label: '备注', type: 'text', w: 130 },
  ];
  T('attendance_tables').push({
    id: tid, kind: 'research', name: '高二语文教研签到表', month,
    columns: JSON.stringify(colsResearch),
    meta: JSON.stringify({ title: '高二语文教研签到表', org: '高二年级组', owner: '语文备课组', signer: '年级主任' }),
    grade: '高二', sheet_type: 'research', sheet_date: '', weekday: '', periods: '', subject: '',
    created_at: now, updated_at: now, deleted_at: null,
  });
  let sort = 0;
  let rid = T('attendance_rows').reduce((mx, x) => Math.max(mx, num(x.id)), 0);
  for (const teacher of teachers) {
    for (let i = 0; i < 4; i += 1) {
      const d = new Date(t.getFullYear(), t.getMonth(), 2 + i * 7);
      if (d.getMonth() !== t.getMonth()) continue;
      const absent = i === 2 && teacher === '赵老师';
      const data = {
        date: dstr(d), weekday: '周' + WD_CN_S[d.getDay()],
        sign_in: absent ? '' : '09:0' + (i % 6),
        sign_out: absent ? '' : '11:3' + (i % 6),
        place: '高二语文组办公室',
        topic: ['集体备课《劝学》', '月考质量分析', '作文批改标准', '期中复习计划'][i],
        status: absent ? '缺席' : (i === 1 && teacher === '黄老师' ? '公出' : '已参加'),
        remark: absent ? '外出参加区里培训' : '',
      };
      rid += 1;
      sort += 1;
      T('attendance_rows').push({ id: rid, table_id: tid, teacher, subject: '', data: JSON.stringify(data), sort, created_at: now, updated_at: now, deleted_at: null });
    }
  }

  const tid2 = tid + 1;
  const colsSeat = [
    { key: 'date', label: '日期', type: 'text', w: 92 },
    { key: 'weekday', label: '星期', type: 'text', w: 56 },
    { key: 'morning', label: '上午坐班', type: 'select', options: ['是', '否', '请假', '公出'], w: 82 },
    { key: 'afternoon', label: '下午坐班', type: 'select', options: ['是', '否', '请假', '公出'], w: 82 },
    { key: 'evening', label: '晚自习', type: 'select', options: ['是', '否', '无'], w: 76 },
    { key: 'hours', label: '时长(h)', type: 'number', w: 70 },
    { key: 'remark', label: '缺勤原因', type: 'text', w: 150 },
  ];
  T('attendance_tables').push({
    id: tid2, kind: 'seat', name: '高二教师坐班表', month,
    columns: JSON.stringify(colsSeat),
    meta: JSON.stringify({ title: '高二教师坐班表', org: '高二年级组', owner: '年级组', signer: '年级主任' }),
    grade: '高二', sheet_type: 'seat', sheet_date: '', weekday: '', periods: '', subject: '',
    created_at: now, updated_at: now, deleted_at: null,
  });
  sort = 0;
  for (const teacher of teachers) {
    for (let i = 0; i < 3; i += 1) {
      const d = new Date(t.getFullYear(), t.getMonth(), 3 + i * 9);
      if (d.getMonth() !== t.getMonth()) continue;
      const leave = i === 1 && teacher === '刘老师';
      const data = {
        date: dstr(d), weekday: '周' + WD_CN_S[d.getDay()],
        morning: leave ? '请假' : '是',
        afternoon: leave ? '否' : '是',
        evening: i === 2 ? '无' : '是',
        hours: i === 2 ? 6 : 8,
        remark: leave ? '病假（已报备）' : '',
      };
      rid += 1;
      sort += 1;
      T('attendance_rows').push({ id: rid, table_id: tid2, teacher, subject: '', data: JSON.stringify(data), sort, created_at: now, updated_at: now, deleted_at: null });
    }
  }
}

/* ============================ 路由表 ============================ */
/* 每条：[方法, 正则, 处理函数]
   处理函数签名 (ctx) => 返回值，ctx = { params, query, body }
   顺序重要：具体路径要排在通配前面（/api/me/avatar 不能被 /api/:table/:id 抢走）。 */

const R = [];
const on = (method, pattern, fn) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:([a-zA-Z_]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  R.push({ method, re, keys, fn });
};

/* ---- 账号 ---- */
on('GET', '/auth/config', () => ({
  allowRegister: true,
  demoMode: true,
  smsEnabled: false,
  testPasscode: false,
  qrEnabled: false,
  siteQrLogin: false,
  wbEnabled: false,
  prodHttps: location.protocol === 'https:',
  siteName: '我的工作台',
  staticMode: true,
}));

on('GET', '/auth/me', () => ({ user: publicUser(currentUser()) }));

/* 静态版没有真正的账号体系：第一次打开就是「已登录」，
   昵称可在「我的」里改，手机号可填可不填（只用于显示）。 */
on('POST', '/auth/login', ({ body }) => {
  const u = currentUser();
  if (body?.phone) u.phone = String(body.phone).trim();
  if (!u.nickname || u.nickname === '老师') u.nickname = body?.phone ? '老师' + String(body.phone).slice(-4) : '老师';
  saveUser(u);
  seedIfEmpty();
  return { user: publicUser(u), token: 'static' };
});
on('POST', '/auth/register', ({ body }) => {
  const u = currentUser();
  if (body?.phone) u.phone = String(body.phone).trim();
  if (body?.nickname) u.nickname = String(body.nickname);
  else if (u.phone) u.nickname = '老师' + u.phone.slice(-4);
  saveUser(u);
  seedIfEmpty();
  return { user: publicUser(u), token: 'static', created: true };
});
on('POST', '/auth/otp', ({ body }) => ({ sent: true, code: '000000', demo: true, phone: body?.phone || '' }));
on('POST', '/auth/logout', () => ({ ok: true }));
on('POST', '/auth/forgot', () => fail(400, '静态版没有服务端密码，直接在「我的」里改昵称即可'));
on('GET', '/auth/forgot/:phone', () => ({ exists: false }));
on('POST', '/auth/bind', () => fail(400, '静态版不支持第三方账号绑定'));
on('POST', '/auth/unbind', () => fail(400, '静态版不支持第三方账号绑定'));
on('POST', '/auth/qr', () => fail(400, '静态版没有服务端，扫码登录不可用'));
on('GET', '/auth/qr/:id', () => fail(400, '静态版没有服务端，扫码登录不可用'));
on('GET', '/auth/qr/:id/peek', () => fail(400, '静态版没有服务端，扫码登录不可用'));
on('POST', '/auth/qr/exchange', () => fail(400, '静态版没有服务端，扫码登录不可用'));
on('POST', '/auth/qr/:id/confirm', () => fail(400, '静态版没有服务端，扫码登录不可用'));
on('GET', '/auth/workbuddy/start', () => fail(400, '静态版不支持 WorkBuddy 授权'));

/* ---- 我的 ---- */
on('GET', '/me', () => ({ user: publicUser(currentUser()), settings: currentUser().settings || {} }));
on('PATCH', '/me', ({ body }) => {
  const u = currentUser();
  for (const k of ['nickname', 'school', 'subject', 'title', 'avatar']) {
    if (k in (body || {})) u[k] = String(body[k] ?? '');
  }
  if (body?.settings) u.settings = body.settings;
  saveUser(u);
  return { user: publicUser(u) };
});
on('POST', '/me/password', () => fail(400, '静态版没有服务端密码，不需要修改'));
on('GET', '/me/sessions', () => ({ rows: [{ id: 1, device: '当前浏览器', ip: '本机', created_at: nowISO(), last_seen: nowISO(), current: true }] }));
on('POST', '/me/sessions/revoke', () => ({ ok: true }));
on('POST', '/me/avatar', async ({ body }) => {
  const u = currentUser();
  const files = body?.files || [];
  const f = files[0];
  if (!f) fail(400, '没有收到图片');
  if (f.data.length > 2 * 1024 * 1024) fail(400, `图片不能超过 2MB（当前 ${(f.data.length / 1024 / 1024).toFixed(1)}MB）`);
  const ok = ['image/jpeg', 'image/png'].includes(String(f.mime || '').toLowerCase());
  if (!ok) fail(400, '只支持 JPG / PNG 格式');
  /* 头像转成 dataURL 直接存：静态版没有 /files 静态目录，
     一个小图（≤2MB）塞进 localStorage 是可以接受的，
     而且换设备靠导出备份也能带走。 */
  const dataUrl = await blobToDataURL(f.data, f.mime);
  u.avatar = dataUrl;
  saveUser(u);
  return { url: dataUrl, user: publicUser(u) };
});
on('DELETE', '/me/avatar', () => {
  const u = currentUser();
  u.avatar = '';
  saveUser(u);
  return { user: publicUser(u) };
});

/* ---- 首页 ---- */
on('GET', '/home', ({ query }) => {
  const today = query.date || cnDate();
  const digest = todayDigest(today);
  const monthFrom = today.slice(0, 8) + '01';
  const [y, m] = today.split('-').map(Number);
  const monthTo = ymd(new Date(y, m, 0));
  const coursesMonth = courseInstancesForRange(monthFrom, monthTo);
  const now = Date.now();
  const upcoming = (load().reminders || [])
    .filter((r) => r.status === 'scheduled' && Number(r.fire_at) >= now - 60000)
    .sort((a, b) => Number(a.fire_at) - Number(b.fire_at))
    .slice(0, 5);
  const unread = (load().messages || []).filter((x) => !x.read).length;
  const monthStr = today.slice(0, 7);
  const ls = rowsOf('lessons').filter((r) => String(r.date || '').startsWith(monthStr));
  const quote = pickQuote(today);
  return {
    date: today, ...digest,
    courses_month: coursesMonth,
    upcoming, unread, quote,
    stats: {
      lessons_month: ls.length,
      hours_month: ls.reduce((s, r) => s + num(r.hours), 0),
      todo_open: (digest.todos || []).filter((t) => t.status !== 'done').length,
      items_open: (digest.items || []).filter((t) => t.status !== 'done').length,
    },
  };
});
on('GET', '/home/quote', ({ query }) => {
  const notId = Number(query.not) || 0;
  const pool = QUOTES.filter((q) => q.id !== notId);
  if (!pool.length) return QUOTES[0];
  return pool[Math.floor(Math.random() * pool.length)];
});

/* ---- 日历 ---- */
on('GET', '/calendar', ({ query }) => {
  const month = String(query.month || cnDate().slice(0, 7));
  const [y, m] = month.split('-').map(Number);
  const from = ymd(new Date(y, m - 1, 1));
  const to = ymd(new Date(y, m, 0));
  const inRange = (v) => v && String(v).slice(0, 10) >= from && String(v).slice(0, 10) <= to;
  return {
    month, from, to,
    courses: courseInstancesForRange(from, to),
    items: rowsOf('items')
      .filter((x) => inRange(x.start_at || x.created_at))
      .sort((a, b) => String(a.start_at || a.created_at).localeCompare(String(b.start_at || b.created_at))),
    lessons: rowsOf('lessons').filter((x) => x.date >= from && x.date <= to),
    invigilations: rowsOf('invigilations').filter((x) => x.date >= from && x.date <= to).map(fillInvigTime),
    trips: rowsOf('trips').filter((x) => String(x.start_date || '') <= to && String(x.end_date || x.start_date || '') >= from),
    reminders: (load().reminders || []).filter((x) => x.status !== 'canceled' && inRange(x.due_at)),
  };
});
on('GET', '/calendar/day', ({ query }) => todayDigest(String(query.date || todayStr())));

/* 导出到系统日历：静态版没法给一次性链接，改成直接吐 dataURL。
   仍然保留「用真实链接而不是 blob」的思路——dataURL 同样带 MIME，
   iOS 上点 <a download> 也能落到「日历」App。 */
on('POST', '/calendar/ics', ({ body }) => {
  const raw = Array.isArray(body?.alarms) ? body.alarms : [];
  const alarms = raw
    .filter((a) => a && a.title && a.due && !Number.isNaN(new Date(a.due).getTime()))
    .slice(0, 20);
  if (!alarms.length) fail(400, '没有可导出的提醒');
  const ics = buildICS(alarms);
  const url = 'data:text/calendar;charset=utf-8,' + encodeURIComponent(ics);
  return { url, expiresIn: 0 };
});

function buildICS(alarms) {
  const p = (n) => String(n).padStart(2, '0');
  const fmt = (t) => {
    const d = new Date(t);
    return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}00Z`;
  };
  const escI = (t) => String(t || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  const stamp = fmt(Date.now());
  const L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//MyWorkbench//CN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
  for (const a of alarms) {
    L.push('BEGIN:VEVENT');
    L.push(`UID:${Math.random().toString(36).slice(2)}@workbench`);
    L.push(`DTSTAMP:${stamp}`);
    L.push(`DTSTART:${fmt(a.due)}`);
    L.push(`DTEND:${fmt(new Date(new Date(a.due).getTime() + 15 * 60000))}`);
    L.push(`SUMMARY:${escI(a.title)}`);
    if (a.body) L.push(`DESCRIPTION:${escI(a.body)}`);
    L.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${escI(a.title)}`, `TRIGGER:-PT${Number(a.advance || 0)}M`, 'END:VALARM');
    L.push('END:VEVENT');
  }
  L.push('END:VCALENDAR');
  return L.join('\r\n');
}

/* ---- 事项 ---- */
on('GET', '/items', () => rowsOf('items')
  .sort((a, b) => String(a.start_at || a.created_at || '').localeCompare(String(b.start_at || b.created_at || ''))));
on('POST', '/items', ({ body }) => {
  if (!body?.title) fail(400, '标题不能为空');
  const db = load();
  db.items = db.items || [];
  const id = T('items').reduce((mx, x) => Math.max(mx, num(x.id)), 0) + 1;
  const row = {
    id, seq: nextSeq('item'), kind: body.kind || '事项', title: body.title,
    detail: body.detail || '', start_at: body.start_at || null, end_at: body.end_at || null,
    status: body.status || 'todo', priority: body.priority || 'normal',
    source: body.source || '', remind_at: null,
    created_at: nowISO(), updated_at: nowISO(), deleted_at: null,
  };
  T('items').push(row);
  save();
  if (body.remind_min !== undefined && body.remind_min !== null && body.remind_min !== '' && body.start_at) {
    addReminder({
      title: body.title, body: body.detail || '', due_at: body.start_at,
      advance_min: Number(body.remind_min), item_id: id,
      repeat: body.repeat || 'none', ring: body.ring || 'chime',
    });
  }
  return row;
});
on('PATCH', '/items/:id', ({ params, body }) => {
  const row = byId('items', params.id);
  if (!row) fail(404, '事项不存在');
  for (const k of ['title', 'detail', 'kind', 'start_at', 'end_at', 'status', 'priority']) {
    if (k in (body || {})) row[k] = body[k] === '' ? null : body[k];
  }
  if (body?.remind_min !== undefined) {
    const db = load();
    for (const r of T('reminders') || []) if (String(r.item_id) === String(row.id)) r.status = 'canceled';
    if (body.remind_min !== null && body.remind_min !== '' && (body.start_at || row.start_at)) {
      addReminder({ title: body.title || row.title, due_at: body.start_at || row.start_at, advance_min: Number(body.remind_min), item_id: row.id });
    }
    save();
  }
  row.updated_at = nowISO();
  save();
  syncItemToTodo(row.id, body || {});
  return row;
});

/* ---- 提醒 ---- */
on('GET', '/reminders', () => {
  tickReminders();
  const items = load().items || [];
  return (load().reminders || [])
    .filter((r) => r.status !== 'canceled')
    .sort((a, b) => num(a.fire_at) - num(b.fire_at))
    .map((r) => ({ ...r, item_title: items.find((i) => String(i.id) === String(r.item_id))?.title || null }));
});
on('POST', '/reminders', ({ body }) => {
  if (!body?.title || !body?.due_at) fail(400, '标题和时间必填');
  const id = addReminder({
    title: body.title, body: body.body || '', due_at: body.due_at,
    advance_min: body.advance_min || 0, repeat: body.repeat || 'none',
    ring: body.ring || 'chime', kind: body.kind || 'alarm',
  });
  return (load().reminders || []).find((r) => r.id === id);
});
on('POST', '/reminders/:id/ack', ({ params }) => {
  const db = load();
  const r = (T('reminders') || []).find((x) => String(x.id) === String(params.id));
  if (!r) fail(404, '提醒不存在');
  r.status = 'acked';
  r.acked_at = nowISO();
  // 重复提醒：下次自动往后推
  if (r.repeat && r.repeat !== 'none') {
    const d = new Date(r.fire_at);
    const step = { daily: 1, workday: 1, weekly: 7, monthly: 30 }[r.repeat] || 0;
    if (step) {
      d.setDate(d.getDate() + step);
      if (r.repeat === 'workday' && [0, 6].includes(d.getDay())) d.setDate(d.getDate() + (d.getDay() === 6 ? 2 : 1));
    }
    addReminder({
      title: r.title, body: r.body, due_at: new Date(Number(r.due_at) || d.getTime()).toISOString(),
      advance_min: r.advance_min, repeat: r.repeat, ring: r.ring, kind: r.kind, item_id: r.item_id,
    });
    const nr = (load().reminders || []).slice(-1)[0];
    if (nr) nr.fire_at = d.getTime();
  }
  save();
  return { ok: true };
});
on('DELETE', '/reminders/:id', ({ params }) => {
  const db = load();
  const r = (T('reminders') || []).find((x) => String(x.id) === String(params.id));
  if (r) { r.status = 'canceled'; save(); }
  return { ok: true };
});
on('POST', '/reminders/:id/snooze', ({ params, body }) => {
  const db = load();
  const r = (T('reminders') || []).find((x) => String(x.id) === String(params.id));
  if (!r) fail(404, '提醒不存在');
  const mins = Number(body?.minutes || 10);
  r.status = 'acked';
  const nid = addReminder({
    title: r.title, body: r.body, due_at: r.due_at, advance_min: 0,
    repeat: 'none', ring: r.ring, kind: r.kind, item_id: r.item_id,
  });
  const nr = (load().reminders || []).find((x) => x.id === nid);
  if (nr) { nr.fire_at = Date.now() + mins * 60000; save(); }
  return { ok: true };
});

/* ---- 消息 ---- */
on('GET', '/messages', ({ query }) => {
  syncTaskMessages();
  tickReminders();
  const all = (load().messages || []).slice().sort((a, b) => b.id - a.id);
  const type = query.type;
  const rows = type && type !== 'all' ? all.filter((m) => m.type === type).slice(0, 200) : all.slice(0, 200);
  const counts = { all: 0 };
  for (const m of all) if (!m.read) { counts[m.type] = (counts[m.type] || 0) + 1; counts.all += 1; }
  return { rows, unread: counts.all, counts };
});
on('POST', '/messages/read', ({ body }) => {
  const db = load();
  for (const m of T('messages') || []) {
    if (body?.all) m.read = 1;
    else if (body?.type && m.type === body.type) m.read = 1;
    else if (Array.isArray(body?.ids) && body.ids.map(String).includes(String(m.id))) m.read = 1;
  }
  save();
  return { ok: true };
});
on('DELETE', '/messages/:id', ({ params }) => {
  const db = load();
  db.messages = (db.messages || []).filter((m) => String(m.id) !== String(params.id));
  save();
  return { ok: true };
});
on('POST', '/messages/clear', ({ body }) => {
  const db = load();
  const readOnly = body?.readOnly !== false;
  db.messages = (db.messages || []).filter((m) => (readOnly ? !m.read : false));
  save();
  return { ok: true };
});

/* ---- 便签 ---- */
on('GET', '/todos', () => {
  const items = load().items || [];
  return rowsOf('todos')
    .sort((a, b) => (num(b.pin) - num(a.pin)) || (b.id - a.id))
    .map((t) => {
      const it = items.find((i) => !i.deleted_at && String(i.ref_id) === String(t.id) && i.source === '便签');
      return { ...t, source: it?.source || '', item_status: it?.status || null, item_id: it?.id || null };
    });
});
on('POST', '/todos', ({ body }) => {
  if (!body?.title) fail(400, '内容不能为空');
  const db = load();
  db.todos = db.todos || [];
  const id = T('todos').reduce((mx, x) => Math.max(mx, num(x.id)), 0) + 1;
  const row = {
    id, seq: nextSeq('todo'), title: body.title, content: body.content || '',
    status: body.status || 'todo', color: body.color || '', due_at: body.due_at || null,
    pin: 0, ref_item_id: null, created_at: nowISO(), updated_at: nowISO(), deleted_at: null,
  };
  T('todos').push(row);
  save();
  if (body.sync_home) {
    const items = T('items');
    const iid = items.reduce((mx, x) => Math.max(mx, num(x.id)), 0) + 1;
    items.push({
      id: iid, seq: nextSeq('item'), kind: '事项', title: body.title, detail: body.content || '',
      start_at: body.due_at || null, end_at: null, status: 'todo', priority: 'normal',
      source: '便签', ref_id: id, created_at: nowISO(), updated_at: nowISO(), deleted_at: null,
    });
    row.ref_item_id = iid;
    save();
  }
  return row;
});
on('PATCH', '/todos/:id', ({ params, body }) => {
  const row = byId('todos', params.id);
  if (!row) fail(404, '便签不存在');
  for (const k of ['title', 'content', 'status', 'color', 'pin', 'due_at']) {
    if (k in (body || {})) row[k] = body[k];
  }
  row.updated_at = nowISO();
  save();
  // 状态、标题、时间改任一边，另一边都跟着变（同源）
  const db = load();
  const linked = row.ref_item_id || (T('items') || []).find((i) => !i.deleted_at && String(i.ref_id) === String(row.id) && i.source === '便签')?.id;
  if (linked) {
    const it = (T('items') || []).find((i) => String(i.id) === String(linked));
    if (it) {
      if (body?.status) it.status = body.status;
      if (body?.title !== undefined) it.title = body.title;
      if (body?.due_at !== undefined) it.start_at = body.due_at || null;
      it.updated_at = nowISO();
      if (!row.ref_item_id) row.ref_item_id = it.id;
      save();
    }
  }
  return row;
});

/* ---- 学习计时器 ---- */
function timerState() {
  const r = (load().studies || [])
    .filter((x) => !x.deleted_at && x.source === 'running')
    .sort((a, b) => b.id - a.id)[0];
  if (!r) return null;
  const start = Date.parse(r.started_at) || Date.now();
  const pausedMs = num(r.paused_ms);
  const now = r.paused_at ? Date.parse(r.paused_at) : Date.now();
  const elapsed = Math.max(0, now - start - pausedMs);
  return {
    id: r.id, title: r.title || '', category_id: r.category_id || null,
    started_at: r.started_at, elapsed_ms: elapsed,
    paused: !!r.paused_at, paused_ms: pausedMs,
    seconds: Math.floor(elapsed / 1000),
  };
}
on('GET', '/study/timer', () => timerState());
on('POST', '/study/timer/start', ({ body }) => {
  const cur = timerState();
  if (cur) return cur;
  const db = load();
  db.studies = db.studies || [];
  const id = T('studies').reduce((mx, x) => Math.max(mx, num(x.id)), 0) + 1;
  const now = nowISO();
  T('studies').push({
    id, date: cnDate(), title: String(body?.title || ''), content: '', minutes: 0,
    source: 'running', category_id: body?.category_id ?? null, started_at: now,
    paused_ms: 0, paused_at: null, created_at: now, updated_at: now, deleted_at: null,
  });
  save();
  return timerState();
});
on('POST', '/study/timer/pause', () => {
  const db = load();
  const r = (T('studies') || []).filter((x) => !x.deleted_at && x.source === 'running').sort((a, b) => b.id - a.id)[0];
  if (!r) fail(400, '当前没有在计时');
  const now = nowISO();
  if (r.paused_at) {
    r.paused_ms = num(r.paused_ms) + Math.max(0, Date.now() - Date.parse(r.paused_at));
    r.paused_at = null;
  } else {
    r.paused_at = now;
  }
  r.updated_at = now;
  save();
  return timerState();
});
on('POST', '/study/timer/stop', ({ body }) => {
  const t = timerState();
  if (!t) fail(400, '当前没有在计时');
  const db = load();
  const r = (T('studies') || []).find((x) => x.id === t.id);
  const mins = body?.minutes != null ? Math.max(0, Math.min(24 * 60, Number(body.minutes) || 0)) : Math.max(1, Math.round(t.elapsed_ms / 60000));
  const now = nowISO();
  r.title = String(body?.title ?? t.title ?? '').trim() || '未命名学习';
  r.content = String(body?.content || '');
  r.minutes = mins;
  r.category_id = body?.category_id ?? t.category_id ?? null;
  r.source = 'timer';
  r.end_at = now;
  r.paused_at = null;
  r.updated_at = now;
  r.seq = r.seq || nextSeq('study');
  save();
  return { id: t.id, minutes: mins, title: r.title };
});
on('DELETE', '/study/timer', () => {
  const db = load();
  for (const r of T('studies') || []) if (!r.deleted_at && r.source === 'running') r.deleted_at = nowISO();
  save();
  return { ok: true };
});

/* ---- 学习统计 ---- */
on('GET', '/study/stats', ({ query }) => {
  const year = String(query.year || cnDate().slice(0, 4));
  const month = String(query.month || cnDate().slice(0, 7));
  const valid = rowsOf('studies').filter((s) => s.source !== 'running');
  const cats = rowsOf('categories');
  const catName = (id) => cats.find((c) => String(c.id) === String(id))?.name || '未分类';

  const byMonthMap = {};
  for (const s of valid.filter((x) => String(x.date).slice(0, 4) === year)) {
    const m = String(s.date).slice(0, 7);
    byMonthMap[m] = byMonthMap[m] || { m, c: 0, mins: 0 };
    byMonthMap[m].c += 1;
    byMonthMap[m].mins += num(s.minutes);
  }
  const byMonth = Object.values(byMonthMap).sort((a, b) => a.m.localeCompare(b.m));

  const yRows = valid.filter((x) => String(x.date).slice(0, 4) === year);
  const total = [{ c: yRows.length, mins: yRows.reduce((s, r) => s + num(r.minutes), 0) }];

  const catAgg = (list) => {
    const map = {};
    for (const s of list) {
      const nm = catName(s.category_id);
      map[nm] = map[nm] || { name: nm, c: 0, mins: 0 };
      map[nm].c += 1;
      map[nm].mins += num(s.minutes);
    }
    return Object.values(map).sort((a, b) => b.mins - a.mins);
  };
  const byCat = catAgg(yRows);

  const mRows = valid.filter((x) => String(x.date).slice(0, 7) === month);
  const dayMap = {};
  for (const s of mRows) {
    dayMap[s.date] = dayMap[s.date] || { d: s.date, mins: 0, c: 0 };
    dayMap[s.date].mins += num(s.minutes);
    dayMap[s.date].c += 1;
  }
  const byDay = Object.values(dayMap).sort((a, b) => a.d.localeCompare(b.d));
  const monthTotal = [{ c: mRows.length, mins: mRows.reduce((s, r) => s + num(r.minutes), 0) }];
  const monthByCat = catAgg(mRows);
  const years = [...new Set(valid.map((x) => String(x.date).slice(0, 4)))].sort().reverse();

  return { year, month, byMonth, total, byCat, byDay, monthTotal, monthByCat, years };
});

/* ---- 回收站 ---- */
on('GET', '/recycle', () => {
  const purged = purgeExpiredRecycle();
  const db = load();
  const now = Date.now();
  const list = (T('recycle') || []).slice().sort((a, b) => b.id - a.id).map((r) => {
    const g = RECYCLE_GROUP[r.entity] || { group: 'other', at: '未知位置' };
    const ageDays = Math.floor((now - (Date.parse(r.deleted_at) || now)) / 86400e3);
    let payload = {};
    try { payload = JSON.parse(r.payload || '{}'); } catch { /* 忽略 */ }
    return {
      id: r.id, entity: r.entity, entity_id: r.entity_id, title: r.title,
      deleted_at: r.deleted_at, group: g.group, location: g.at,
      daysLeft: Math.max(0, RECYCLE_KEEP_DAYS - ageDays),
      size: new Blob([r.payload || '']).size,
      fileSize: num(payload.size),
      fileName: payload.name || payload.title || '',
    };
  });
  const counts = { all: list.length };
  for (const x of list) counts[x.group] = (counts[x.group] || 0) + 1;
  return { list, counts, keepDays: RECYCLE_KEEP_DAYS, purged };
});
on('POST', '/recycle/restore', ({ body }) => {
  const db = load();
  const ids = body?.all ? (T('recycle') || []).map((x) => x.id) : (body?.ids || []).map(Number).filter(Boolean);
  let n = 0;
  for (const id of ids) {
    const i = (T('recycle') || []).findIndex((r) => r.id === id);
    if (i < 0) continue;
    const r = T('recycle')[i];
    const row = (db[r.entity] || []).find((x) => String(x.id) === String(r.entity_id));
    if (row) row.deleted_at = null;
    if (r.entity === 'attendance_tables') {
      for (const k of T('attendance_rows') || []) if (String(k.table_id) === String(r.entity_id)) k.deleted_at = null;
    }
    T('recycle').splice(i, 1);
    n += 1;
  }
  save();
  return { restored: n };
});
on('POST', '/recycle/purge', ({ body }) => {
  const db = load();
  let rows;
  if (body?.all) rows = (T('recycle') || []).slice();
  else if (body?.olderThan) {
    const cutoff = new Date(Date.now() - Number(body.olderThan) * 86400e3).toISOString();
    rows = (T('recycle') || []).filter((r) => r.deleted_at < cutoff);
  } else {
    const ids = (body?.ids || []).map(Number);
    rows = (T('recycle') || []).filter((r) => ids.includes(r.id));
  }
  for (const r of rows) {
    const arr = db[r.entity] || [];
    const i = arr.findIndex((x) => String(x.id) === String(r.entity_id));
    if (i >= 0) arr.splice(i, 1);
    if (r.entity === 'attendance_tables') {
      db.attendance_rows = (db.attendance_rows || []).filter((k) => String(k.table_id) !== String(r.entity_id));
    }
    db.recycle = (db.recycle || []).filter((x) => x.id !== r.id);
  }
  save();
  const undo = rows.map((r) => ({ entity: r.entity, entity_id: r.entity_id, title: r.title, payload: r.payload, deleted_at: r.deleted_at }));
  return { purged: rows.length, undo };
});
on('POST', '/recycle/undo', ({ body }) => {
  const db = load();
  const items = Array.isArray(body?.items) ? body.items : [];
  let back = 0;
  for (const it of items) {
    if (!it?.entity || !it?.entity_id) continue;
    try {
      const row = JSON.parse(it.payload || '{}');
      db[it.entity] = db[it.entity] || [];
      const ex = db[it.entity].find((x) => String(x.id) === String(it.entity_id));
      if (ex) ex.deleted_at = it.deleted_at || nowISO();
      else { row.deleted_at = it.deleted_at || nowISO(); db[it.entity].push(row); }
      const dup = (T('recycle') || []).some((r) => r.entity === it.entity && String(r.entity_id) === String(it.entity_id) && r.deleted_at === (it.deleted_at || ''));
      if (!dup) {
        db.recycle = db.recycle || [];
        const id = T('recycle').reduce((mx, r) => Math.max(mx, num(r.id)), 0) + 1;
        T('recycle').push({
          id, entity: it.entity, entity_id: Number(it.entity_id),
          title: String(it.title || ''), payload: it.payload || '{}', deleted_at: it.deleted_at || nowISO(),
        });
      }
      back += 1;
    } catch { /* 单条失败不影响其它 */ }
  }
  save();
  return { restored: back };
});

/* ---- 考勤表 ---- */
on('GET', '/attendance', ({ query }) => attTablesList(query));
on('GET', '/attendance/:id', ({ params }) => attTableDetail(params.id));
on('POST', '/attendance', ({ body }) => {
  const db = load();
  db.attendance_tables = db.attendance_tables || [];
  const sheetType = body?.sheet_type || (body?.kind === 'research' ? 'research' : 'seat');
  const cols = body?.columns || defaultCols(sheetType);
  const month = body?.month || String(body?.sheet_date || todayStr()).slice(0, 7);
  const meta = { periods: body?.periods || '', year: String(body?.sheet_date || '').slice(0, 4) || String(new Date().getFullYear()), weekday: body?.weekday || '', ...(body?.meta || {}) };
  const id = T('attendance_tables').reduce((mx, x) => Math.max(mx, num(x.id)), 0) + 1;
  const row = {
    id, kind: sheetType, name: body?.name || '新建考勤表', month,
    columns: JSON.stringify(cols), meta: JSON.stringify(meta),
    grade: body?.grade || '高一', sheet_type: sheetType,
    sheet_date: body?.sheet_date || '', weekday: body?.weekday || '',
    periods: body?.periods || '', subject: body?.subject || '',
    created_at: nowISO(), updated_at: nowISO(), deleted_at: null,
  };
  T('attendance_tables').push(row);
  save();
  return row;
});
on('PATCH', '/attendance/:id', ({ params, body }) => {
  const t = byId('attendance_tables', params.id);
  if (!t) fail(404, '考勤表不存在');
  for (const k of ['name', 'month', 'kind', 'grade', 'sheet_date', 'weekday', 'periods', 'sheet_type', 'subject']) {
    if (k in (body || {})) t[k] = body[k];
  }
  if ('sheet_type' in (body || {})) t.kind = body.sheet_type === 'research' ? 'research' : 'seat';
  if (body?.columns) t.columns = JSON.stringify(body.columns);
  if (body?.meta) t.meta = JSON.stringify(body.meta);
  t.updated_at = nowISO();
  save();
  return t;
});
on('POST', '/attendance/:id/rows', ({ params, body }) => {
  const t = byId('attendance_tables', params.id);
  if (!t) fail(404, '考勤表不存在');
  const db = load();
  db.attendance_rows = db.attendance_rows || [];
  const list = Array.isArray(body?.rows) ? body.rows : [body];
  const ids = [];
  let sort = (T('attendance_rows').filter((r) => String(r.table_id) === String(t.id)).reduce((mx, r) => Math.max(mx, num(r.sort)), 0));
  for (const row of list) {
    if (!row) continue;
    if (row.id) {
      const ex = T('attendance_rows').find((r) => String(r.id) === String(row.id) && String(r.table_id) === String(t.id));
      if (ex) {
        ex.data = JSON.stringify(row.data || {});
        ex.teacher = row.teacher || '';
        ex.subject = String(row.subject ?? '');
        ex.updated_at = nowISO();
        ids.push(ex.id);
      }
    } else {
      sort += 1;
      const id = T('attendance_rows').reduce((mx, r) => Math.max(mx, num(r.id)), 0) + 1;
      T('attendance_rows').push({
        id, table_id: t.id, teacher: row.teacher || '', subject: String(row.subject ?? ''),
        data: JSON.stringify(row.data || {}), sort,
        created_at: nowISO(), updated_at: nowISO(), deleted_at: null,
      });
      ids.push(id);
    }
  }
  save();
  return { ids };
});
on('POST', '/attendance/:id/import', ({ params, body }) => {
  const t = byId('attendance_tables', params.id);
  if (!t) fail(404, '考勤表不存在');
  const text = String(body?.text || '');
  const grid = body?.grid || parseClipboardTable(text);
  const columns = body?.columns || JSON.parse(t.columns || '[]');
  const db = load();
  db.attendance_rows = db.attendance_rows || [];
  let added = 0;
  let sort = T('attendance_rows').filter((r) => String(r.table_id) === String(t.id)).reduce((mx, r) => Math.max(mx, num(r.sort)), 0);
  const header = grid[0] || [];
  const isHeader = header.some((h) => /日期|姓名|老师|星期|签到|时间|状态|备注/.test(String(h)));
  const bodyRows = isHeader ? grid.slice(1) : grid;
  const mapName = isHeader ? header.findIndex((h) => /姓名|老师|教师/.test(String(h))) : 0;
  for (const line of bodyRows) {
    if (!line.length || line.every((c) => !String(c).trim())) continue;
    const teacher = String(line[mapName] ?? line[0] ?? '').trim();
    if (!teacher) continue;
    const data = {};
    if (isHeader) {
      columns.forEach((c) => {
        const idx = header.findIndex((h) => String(h).replace(/\s/g, '') === c.label.replace(/\s/g, ''));
        if (idx >= 0) data[c.key] = String(line[idx] ?? '').trim();
      });
    } else {
      columns.forEach((c, i) => { if (i + 1 < line.length) data[c.key] = String(line[i + 1]).trim(); });
    }
    sort += 1;
    const id = T('attendance_rows').reduce((mx, r) => Math.max(mx, num(r.id)), 0) + 1;
    T('attendance_rows').push({ id, table_id: t.id, teacher, subject: '', data: JSON.stringify(data), sort, created_at: nowISO(), updated_at: nowISO(), deleted_at: null });
    added += 1;
  }
  save();
  return { added, detected_header: isHeader, columns };
});
on('GET', '/attendance/:id/stats', ({ params }) => attStats(params.id));
on('GET', '/attendance/:id/photos', ({ params }) => {
  const t = byId('attendance_tables', params.id);
  if (!t) fail(404, '表不存在');
  return (load().attachments || [])
    .filter((a) => !a.deleted_at && a.owner_type === 'attendance' && String(a.owner_id) === String(t.id))
    .map((a) => ({ id: a.id, name: a.name, mime: a.mime, size: a.size, created_at: a.created_at, url: a.url || '' }));
});
on('POST', '/attendance/:id/photos', async ({ params, body }) => {
  const t = byId('attendance_tables', params.id);
  if (!t) fail(404, '表不存在');
  const files = body?.files || [];
  if (!files.length) fail(400, '没有收到图片');
  const saved = [];
  for (const f of files) {
    if (!/^image\//i.test(f.mime || '')) fail(400, '只能是图片（jpg / png / heic）');
    if (f.data.length > 12 * 1024 * 1024) fail(400, '图片太大了（上限 12MB）');
    const url = await blobToDataURL(f.data, f.mime);
    const id = saveAttachment('attendance', t.id, f.filename, f.mime, f.data.length, url);
    saved.push({ id, url, name: f.filename, mime: f.mime, size: f.data.length });
  }
  return saved;
});

/* ---- 上传识别 ---- */
on('POST', '/students/detect', ({ body }) => detectStudents(body));
on('POST', '/attendance/detect', ({ body }) => detectAttendanceSheet(body));
on('POST', '/attendance/commit', ({ body }) => commitAttendanceSheet(body));

/* 学生名单识别：读 CSV / 文本，抽姓名 + 年级 + 班级 + 学号。
   静态版不能解析 .xlsx 二进制（需要额外解压库），所以提示用户另存为 CSV。 */
function detectStudents(body) {
  const mp = body?.multipart || {};
  const file = (mp.files || []).find((f) => f.field === 'file') || (mp.files || [])[0];
  if (!file) fail(400, '没有收到文件');
  const text = typeof file.data === 'string' ? file.data : new TextDecoder('utf-8').decode(file.data);
  if (/\.xlsx?$/i.test(file.filename || '')) {
    fail(400, '静态版无法直接读 Excel，请在 Excel / WPS 里「另存为 CSV」后再导入');
  }
  const grid = parseClipboardTable(text);
  if (!grid.length) fail(400, '文件是空的');
  const HEAD_NAME = /^(姓名|名字|学生|学生姓名|name)$/i;
  const HEAD_GRADE = /^(年级|级部|grade)$/i;
  const HEAD_CLASS = /^(班级|班|class)$/i;
  const HEAD_NO = /^(学号|序号|编号|no|number)$/i;
  let headRow = -1; let cols = {};
  for (let i = 0; i < Math.min(5, grid.length); i += 1) {
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
  const out = [];
  for (let i = headRow + 1; i < grid.length; i += 1) {
    const r = grid[i];
    const name = String(r[cols.name] ?? '').trim();
    if (!name) continue;
    if (/^(合计|小计|总计|备注|说明)$/.test(name) || name.length > 20) continue;
    out.push({
      name,
      grade: cols.grade !== undefined ? String(r[cols.grade] ?? '').trim() : '',
      class_name: cols.class !== undefined ? String(r[cols.class] ?? '').trim() : '',
      no: cols.no !== undefined ? Number(String(r[cols.no] ?? '').replace(/\D/g, '')) || (out.length + 1) : out.length + 1,
    });
  }
  if (!out.length) fail(400, '这个文件里没找到姓名列，确认一下表头是不是写着「姓名」');
  const exist = new Set(rowsOf('students').map((x) => `${x.grade}|${x.class_name}|${x.name}`));
  return {
    ok: true, filename: file.filename, sheet: 'CSV', sheets: ['CSV'],
    hasHeader: headRow >= 0,
    rows: out.slice(0, 500), total: out.length,
    dup: out.filter((r) => exist.has(`${r.grade}|${r.class_name}|${r.name}`)).length,
    grades: [...new Set(out.map((r) => r.grade).filter(Boolean))],
    classes: [...new Set(out.map((r) => r.class_name).filter(Boolean))],
  };
}

/* 考勤表识别：同样只支持 CSV / 文本。第一行是表头，第一列是姓名。 */
function detectAttendanceSheet(body) {
  const mp = body?.multipart || {};
  const file = (mp.files || []).find((f) => f.field === 'file') || (mp.files || [])[0];
  if (!file) fail(400, '没有收到文件');
  if (/\.xlsx?$/i.test(file.filename || '')) fail(400, '静态版无法直接读 Excel，请另存为 CSV 后再导入');
  const text = typeof file.data === 'string' ? file.data : new TextDecoder('utf-8').decode(file.data);
  const grid = parseClipboardTable(text).filter((r) => r && r.some((c) => String(c ?? '').trim()));
  if (!grid.length) return { ok: false, reason: '文件是空的', filename: file.filename, sheets: [] };
  const header = grid[0].map((c) => String(c ?? '').trim());
  const nameIdx = header.findIndex((h) => /姓名|名字|老师|教师/.test(h));
  if (nameIdx < 0) return { ok: false, reason: '第一行没找到「姓名」列', filename: file.filename, sheets: ['CSV'] };
  const columns = [
    { key: 'k_上课', label: '上课', type: 'check', w: 62 },
    { key: 'k_坐班', label: '坐班', type: 'check', w: 62 },
    { key: 'k_听课', label: '听课', type: 'check', w: 62 },
    { key: 'k_教研', label: '教研', type: 'check', w: 62 },
    { key: 'k_请假', label: '请假', type: 'check', w: 62 },
    { key: 'k_remark', label: '备注', type: 'text', w: 130 },
  ];
  const rows = [];
  for (let i = 1; i < grid.length; i += 1) {
    const teacher = String(grid[i][nameIdx] ?? '').trim();
    if (!teacher) continue;
    const data = {};
    columns.forEach((c) => {
      const idx = header.findIndex((h) => h === c.label);
      if (idx >= 0) {
        const v = String(grid[i][idx] ?? '').trim();
        if (c.type === 'check') { if (/[√✓1是]/.test(v)) data[c.key] = '1'; else if (/[×✗0否]/.test(v)) data[c.key] = '0'; }
        else if (v) data[c.key] = v;
      }
    });
    rows.push({ teacher, subject: '', data });
  }
  if (!rows.length) return { ok: false, reason: '表里没有姓名数据', filename: file.filename, sheets: ['CSV'] };
  const roster = rowsOf('teachers');
  const rosterNames = new Set(roster.map((r) => r.name));
  const sheetNames = new Set(rows.map((r) => r.teacher));
  return {
    ok: true, filename: file.filename, sheet: 'CSV', sheets: ['CSV'],
    detected: { grade: '', columns }, columns, rows,
    roster: {
      known: roster.length,
      matched: rows.filter((r) => rosterNames.has(r.teacher)).length,
      missing: roster.filter((r) => !sheetNames.has(r.name)).map((r) => r.name),
      extra: rows.filter((r) => !rosterNames.has(r.teacher)).map((r) => r.teacher),
    },
  };
}

function commitAttendanceSheet(body) {
  const rows = Array.isArray(body?.rows) ? body.rows : [];
  if (!rows.length) fail(400, '没有可导入的数据');
  const db = load();
  db.attendance_tables = db.attendance_tables || [];
  db.attendance_rows = db.attendance_rows || [];
  const sheetType = body?.sheet_type === 'research' ? 'research' : 'seat';
  const grade = String(body?.grade || '高一').trim();
  const year = body?.year || String(new Date().getFullYear());
  const month = String(body?.month || '').padStart(2, '0') || pad2(new Date().getMonth() + 1);
  const day = String(body?.day || '').padStart(2, '0') || pad2(new Date().getDate());
  const dateStr = body?.sheet_date || `${year}-${month}-${day}`;
  const periods = String(body?.periods || '');
  const name = String(body?.name || '').trim() || `${year}年${grade}${sheetType === 'seat' ? '老师坐班表' : '老师教研签到表'}${periods ? ' · 第' + periods + '节' : ''}`;
  const columns = Array.isArray(body?.columns) && body.columns.length ? body.columns : defaultCols(sheetType);
  const meta = {
    periods, year, weekday: body?.weekday || '', source: body?.source || 'upload',
    filename: body?.filename || '', imported_at: nowISO(), imported_rows: rows.length,
  };

  let tableId = Number(body?.table_id) || 0;
  let sortBase = 0;
  if (tableId) {
    const t = byId('attendance_tables', tableId);
    if (!t) fail(404, '目标表不存在');
    const exist = T('attendance_rows').filter((r) => !r.deleted_at && String(r.table_id) === String(tableId));
    const byName = new Map(exist.map((r) => [r.teacher, r]));
    let updated = 0; let added = 0;
    let sort = exist.reduce((mx, r) => Math.max(mx, num(r.sort)), 0);
    for (const row of rows) {
      const nm = String(row.teacher || '').trim();
      if (!nm) continue;
      const old = byName.get(nm);
      if (old) {
        const merged = { ...(JSON.parse(old.data || '{}')), ...(row.data || {}) };
        old.data = JSON.stringify(merged);
        old.subject = String(row.subject || old.subject || '');
        old.updated_at = nowISO();
        updated += 1;
      } else {
        sort += 1;
        const id = T('attendance_rows').reduce((mx, r) => Math.max(mx, num(r.id)), 0) + 1;
        T('attendance_rows').push({ id, table_id: tableId, teacher: nm, subject: String(row.subject || ''), data: JSON.stringify(row.data || {}), sort, created_at: nowISO(), updated_at: nowISO(), deleted_at: null });
        added += 1;
      }
    }
    t.columns = JSON.stringify(columns);
    t.meta = JSON.stringify(meta);
    t.updated_at = nowISO();
    save();
    return { table_id: tableId, added, updated, merged: true };
  }

  tableId = T('attendance_tables').reduce((mx, x) => Math.max(mx, num(x.id)), 0) + 1;
  T('attendance_tables').push({
    id: tableId, kind: sheetType, name, month: `${year}-${month}`,
    columns: JSON.stringify(columns), meta: JSON.stringify(meta), grade, sheet_type: sheetType,
    sheet_date: dateStr, weekday: body?.weekday || '', periods, subject: body?.subject || '',
    created_at: nowISO(), updated_at: nowISO(), deleted_at: null,
  });
  db.teachers = db.teachers || [];
  const inRoster = new Set(T('teachers').filter((x) => !x.deleted_at && x.grade === grade).map((x) => x.name));
  let tSort = T('teachers').filter((x) => x.grade === grade).reduce((mx, x) => Math.max(mx, num(x.sort)), 0);
  const tSort0 = tSort;
  for (const row of rows) {
    const nm = String(row.teacher || '').trim();
    if (!nm) continue;
    sortBase += 1;
    const id = T('attendance_rows').reduce((mx, r) => Math.max(mx, num(r.id)), 0) + 1;
    T('attendance_rows').push({ id, table_id: tableId, teacher: nm, subject: String(row.subject || ''), data: JSON.stringify(row.data || {}), sort: sortBase, created_at: nowISO(), updated_at: nowISO(), deleted_at: null });
    if (!inRoster.has(nm)) {
      inRoster.add(nm);
      tSort += 1;
      const tid = T('teachers').reduce((mx, x) => Math.max(mx, num(x.id)), 0) + 1;
      T('teachers').push({ id: tid, grade, name: nm, subject: String(row.subject || ''), sort: tSort, active: 1, created_at: nowISO(), updated_at: nowISO(), deleted_at: null });
    }
  }
  save();
  return { table_id: tableId, added: rows.length, updated: 0, merged: false, roster_added: tSort - tSort0 };
}

/* ---- 课时汇总 ---- */
on('GET', '/lessons/summary', ({ query }) => {
  const month = /^\d{4}-\d{2}$/.test(String(query.month || '')) ? String(query.month) : cnDate().slice(0, 7);
  const rows = rowsOf('lessons')
    .filter((r) => String(r.date || '').startsWith(month))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)) || num(a.period_no) - num(b.period_no));
  const st = currentUser().settings || {};
  const price = Number(st?.lesson?.pricePerHour) || 30;
  const summary = buildLessonSummary(rows, price);

  const [y, m] = month.split('-').map(Number);
  const lastDay = new Date(y, m, 0).getDate();
  let scheduled = 0;
  for (const c of rowsOf('courses')) {
    for (let d = 1; d <= lastDay; d += 1) {
      const dt = new Date(y, m - 1, d);
      if (dt.getDay() !== Number(c.weekday)) continue;
      const ds = `${y}-${pad2(m)}-${pad2(d)}`;
      if (c.start_date && ds < c.start_date) continue;
      if (c.end_date && ds > c.end_date) continue;
      scheduled += 1;
    }
  }
  const today = new Date();
  const isCurrentMonth = month === `${today.getFullYear()}-${pad2(today.getMonth() + 1)}`;
  return {
    month, summary, price_per_hour: price,
    partial: isCurrentMonth ? { passed: today.getDate(), total: lastDay } : null,
    scheduled: { total: scheduled, actual: summary.total_hours, substitute_out: summary.sub_in.hours },
  };
});
on('POST', '/lessons/settle', ({ body }) => {
  const month = String(body?.month || '');
  const name = String(body?.name || '').trim();
  const direction = body?.direction === 'in' ? 'in' : 'out';
  const ids = Array.isArray(body?.ids) ? body.ids.map(Number).filter(Number.isInteger) : [];
  if (!/^\d{4}-\d{2}$/.test(month)) fail(400, '月份格式不对');
  if (!name && !ids.length) fail(400, '缺少结算对象');
  const targetType = direction === 'out' ? '替他人上' : '他人替我上';
  const now = nowISO();
  let n = 0;
  for (const r of rowsOf('lessons')) {
    if (r.sub_type !== targetType || r.settled_at) continue;
    const hit = ids.length
      ? ids.includes(Number(r.id))
      : (String(r.date || '').startsWith(month + '-') && (String(r.peer_name || '') === name || String(r.orig_teacher || '') === name));
    if (!hit) continue;
    r.settled_at = now;
    r.settle_key = (name || '') + '|' + month;
    r.updated_at = now;
    n += 1;
  }
  save();
  return { settled: n, name, month, direction, scope: ids.length ? 'ids' : 'month' };
});
on('POST', '/lessons/unsettle', ({ body }) => {
  const month = String(body?.month || '');
  const name = String(body?.name || '').trim();
  const direction = body?.direction === 'in' ? 'in' : 'out';
  const ids = Array.isArray(body?.ids) ? body.ids.map(Number).filter(Number.isInteger) : [];
  const targetType = direction === 'out' ? '替他人上' : '他人替我上';
  let n = 0;
  for (const r of rowsOf('lessons')) {
    if (r.sub_type !== targetType || !r.settled_at) continue;
    const hit = ids.length
      ? ids.includes(Number(r.id))
      : (String(r.date || '').startsWith(month + '-') && (String(r.peer_name || '') === name || String(r.orig_teacher || '') === name));
    if (!hit) continue;
    r.settled_at = null;
    r.settle_key = '';
    r.updated_at = nowISO();
    n += 1;
  }
  save();
  return { unsettled: n, scope: ids.length ? 'ids' : 'month' };
});
on('GET', '/lessons/statement', ({ query }) => {
  const month = /^\d{4}-\d{2}$/.test(String(query.month || '')) ? String(query.month) : cnDate().slice(0, 7);
  const rows = rowsOf('lessons').filter((r) => String(r.date || '').startsWith(month))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)) || num(a.period_no) - num(b.period_no));
  const price = Number(currentUser().settings?.lesson?.pricePerHour) || 30;
  const summary = buildLessonSummary(rows, price);
  return { month, price, summary, rows };
});

/* ---- 监考 ---- */
on('GET', '/invig/rules', () => ({ rules: getInvigRules(), defaults: DEFAULT_INVIG_RULES }));
on('PATCH', '/invig/rules', ({ body }) => {
  const u = currentUser();
  const cur = getInvigRules();
  const next = {
    mode: body?.mode === '时长' ? '时长' : '场次',
    perSession: Number(body?.perSession ?? cur.perSession) || 0,
    perHour: Number(body?.perHour ?? cur.perHour) || 0,
    peerPerSession: Number(body?.peerPerSession ?? cur.peerPerSession) || 0,
    tiers: Array.isArray(body?.tiers) ? body.tiers.slice(0, 6).map((t) => ({ max: Number(t.max) || 0, amount: Number(t.amount) || 0 })) : cur.tiers,
  };
  u.settings = u.settings || {};
  u.settings.invig = next;
  saveUser(u);
  return { rules: next };
});
on('GET', '/invig/summary', ({ query }) => {
  const month = /^\d{4}-\d{2}$/.test(String(query.month || '')) ? String(query.month) : cnDate().slice(0, 7);
  const rows = rowsOf('invigilations')
    .filter((r) => String(r.date || '').startsWith(month))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.start_time || '').localeCompare(String(a.start_time || '')))
    .map(fillInvigTime);
  const rules = getInvigRules();
  return { month, summary: buildInvSummary(rows, rules), rules, rows };
});
on('POST', '/invig/settle', ({ body }) => {
  const month = String(body?.month || '');
  const name = String(body?.name || '').trim();
  const direction = body?.direction === 'in' ? 'in' : 'out';
  const ids = Array.isArray(body?.ids) ? body.ids.map(Number).filter(Number.isInteger) : [];
  if (!name && !ids.length) fail(400, '缺少结算对象');
  const targetType = direction === 'out' ? '替他人' : '他人替我';
  const now = nowISO();
  let n = 0;
  for (const r of rowsOf('invigilations')) {
    if ((r.duty_type || 'school') !== targetType || r.settled_at) continue;
    const hit = ids.length ? ids.includes(Number(r.id))
      : (String(r.date || '').startsWith(month + '-') && (String(r.peer_name || '') === name || String(r.person || '') === name));
    if (!hit) continue;
    r.settled_at = now;
    r.settle_key = (name || '') + '|' + month;
    r.updated_at = now;
    n += 1;
  }
  save();
  return { settled: n, scope: ids.length ? 'ids' : 'month' };
});
on('POST', '/invig/unsettle', ({ body }) => {
  const month = String(body?.month || '');
  const name = String(body?.name || '').trim();
  const direction = body?.direction === 'in' ? 'in' : 'out';
  const ids = Array.isArray(body?.ids) ? body.ids.map(Number).filter(Number.isInteger) : [];
  const targetType = direction === 'out' ? '替他人' : '他人替我';
  let n = 0;
  for (const r of rowsOf('invigilations')) {
    if ((r.duty_type || 'school') !== targetType || !r.settled_at) continue;
    const hit = ids.length ? ids.includes(Number(r.id))
      : (String(r.date || '').startsWith(month + '-') && (String(r.peer_name || '') === name || String(r.person || '') === name));
    if (!hit) continue;
    r.settled_at = null;
    r.settle_key = '';
    r.updated_at = nowISO();
    n += 1;
  }
  save();
  return { unsettled: n, scope: ids.length ? 'ids' : 'month' };
});
on('POST', '/invig/school-paid', ({ body }) => {
  const month = String(body?.month || '');
  const on2 = body?.paid ? 1 : 0;
  const ids = Array.isArray(body?.ids) ? body.ids.map(Number).filter(Number.isInteger) : [];
  if (!ids.length && !/^\d{4}-\d{2}$/.test(month)) fail(400, '月份格式不对');
  let n = 0;
  for (const r of rowsOf('invigilations')) {
    if ((r.duty_type || 'school') !== 'school') continue;
    const hit = ids.length ? ids.includes(Number(r.id)) : String(r.date || '').startsWith(month + '-');
    if (!hit) continue;
    r.school_paid = on2;
    r.updated_at = nowISO();
    n += 1;
  }
  save();
  return { updated: n };
});

/* ---- 年级 & 教师名册 ---- */
const DEFAULT_GRADES = ['高一', '高二'];
on('GET', '/grades', () => {
  const extra = (currentUser().settings?.grades || []).filter(Boolean);
  const set = [...new Set([...DEFAULT_GRADES, ...extra])];
  const counts = {};
  for (const g of set) counts[g] = rowsOf('teachers').filter((t) => t.grade === g && num(t.active) === 1).length;
  return { grades: set, builtin: DEFAULT_GRADES, counts };
});
on('POST', '/grades', ({ body }) => {
  const name = String(body?.name || '').trim();
  if (!name) fail(400, '年级名不能为空');
  if (name.length > 12) fail(400, '年级名太长');
  const u = currentUser();
  u.settings = u.settings || {};
  u.settings.grades = [...new Set([...(u.settings.grades || []), name])];
  saveUser(u);
  return { grades: [...new Set([...DEFAULT_GRADES, ...u.settings.grades])] };
});
on('DELETE', '/grades/:name', ({ params }) => {
  const name = decodeURIComponent(params.name);
  if (DEFAULT_GRADES.includes(name)) fail(400, '内置年级不能删除');
  const u = currentUser();
  u.settings = u.settings || {};
  u.settings.grades = (u.settings.grades || []).filter((g) => g !== name);
  saveUser(u);
  return { ok: true };
});
on('GET', '/teachers', ({ query }) => {
  const grade = query.grade || '';
  let list = rowsOf('teachers').filter((t) => !grade || t.grade === grade);
  if (query.active !== 'all') list = list.filter((t) => num(t.active) === 1);
  list.sort((a, b) => String(a.grade).localeCompare(String(b.grade)) || (num(a.sort) - num(b.sort)) || a.id - b.id);
  const byGrade = {};
  for (const t of list) (byGrade[t.grade] = byGrade[t.grade] || []).push(t);
  return { list, byGrade };
});
on('POST', '/teachers', ({ body }) => {
  const grade = String(body?.grade || '').trim();
  if (!grade) fail(400, '请先选择年级');
  const db = load();
  db.teachers = db.teachers || [];
  const items = Array.isArray(body?.items) ? body.items : [{ name: body?.name, subject: body?.subject }];
  let sort = T('teachers').filter((t) => t.grade === grade).reduce((mx, t) => Math.max(mx, num(t.sort)), 0);
  const ids = []; let skipped = 0;
  for (const it of items) {
    const name = String(it?.name || '').trim();
    if (!name) continue;
    const dup = T('teachers').find((t) => !t.deleted_at && t.grade === grade && t.name === name);
    if (dup) {
      if (it.subject) { dup.subject = String(it.subject).trim(); dup.updated_at = nowISO(); }
      ids.push(dup.id);
      skipped += 1;
      continue;
    }
    sort += 1;
    const id = T('teachers').reduce((mx, t) => Math.max(mx, num(t.id)), 0) + 1;
    T('teachers').push({ id, grade, name, subject: String(it.subject || '').trim(), sort, active: 1, created_at: nowISO(), updated_at: nowISO(), deleted_at: null });
    ids.push(id);
  }
  save();
  return { ids, skipped };
});
on('PATCH', '/teachers/:id', ({ params, body }) => {
  const t = byId('teachers', params.id);
  if (!t) fail(404, '教师不存在');
  for (const k of ['name', 'subject', 'grade']) if (k in (body || {})) t[k] = String(body[k]).trim();
  if ('active' in (body || {})) t.active = body.active ? 1 : 0;
  if ('sort' in (body || {})) t.sort = Number(body.sort) || 0;
  t.updated_at = nowISO();
  save();
  return t;
});
on('DELETE', '/teachers/:id', ({ params }) => {
  if (!recyclePut('teachers', params.id)) fail(404, '记录不存在');
  return { ok: true };
});

/* ---- 出差 ---- */
on('GET', '/trip/rules', () => tripRules());
on('PATCH', '/trip/rules', ({ body }) => {
  const u = currentUser();
  u.settings = u.settings || {};
  u.settings.trip = {
    ...(u.settings.trip || {}),
    ...(body?.foodPerDay != null ? { foodPerDay: Number(body.foodPerDay) || 0 } : {}),
    ...(body?.localPerDay != null ? { localPerDay: Number(body.localPerDay) || 0 } : {}),
  };
  saveUser(u);
  return tripRules();
});
on('GET', '/trip/list', ({ query }) => {
  const rules = tripRules();
  const month = String(query.month || '');
  let rows = rowsOf('trips');
  if (/^\d{4}-\d{2}$/.test(month)) rows = rows.filter((r) => String(r.start_date || '').startsWith(month + '-'));
  rows.sort((a, b) => String(b.start_date).localeCompare(String(a.start_date)) || b.id - a.id);
  return { rules, rows: rows.map((r) => tripWithCalc(r, rules)) };
});
on('GET', '/trip/stats', ({ query }) => {
  const rules = tripRules();
  const year = String(query.year || new Date().getFullYear());
  const list = rowsOf('trips').filter((r) => String(r.start_date || '').startsWith(year + '-'))
    .sort((a, b) => String(b.start_date).localeCompare(String(a.start_date)))
    .map((r) => tripWithCalc(r, rules));
  const months = {};
  for (let i = 1; i <= 12; i += 1) months[`${year}-${pad2(i)}`] = { month: `${year}-${pad2(i)}`, count: 0, km: 0, real: 0, subsidy: 0, total: 0 };
  const byKind = { transport: 0, hotel: 0, taxi: 0, toll: 0, parking: 0, other: 0 };
  let km = 0; let total = 0; let real = 0; let subsidy = 0; let net = 0; let advance = 0;
  for (const t of list) {
    const m = String(t.start_date || '').slice(0, 7);
    if (months[m]) {
      months[m].count += 1;
      months[m].km += num(t.km);
      months[m].real = n2(months[m].real + t.calc.realTotal);
      months[m].subsidy = n2(months[m].subsidy + t.calc.subsidyTotal);
      months[m].total = n2(months[m].total + t.calc.total);
    }
    km += num(t.km);
    real = n2(real + t.calc.realTotal);
    subsidy = n2(subsidy + t.calc.subsidyTotal);
    total = n2(total + t.calc.total);
    net = n2(net + t.calc.net);
    advance = n2(advance + t.calc.advance);
    for (const k of Object.keys(byKind)) byKind[k] = n2(byKind[k] + num(t.calc.real[k]));
  }
  return {
    year, rules,
    summary: {
      count: list.length, km, real, subsidy, total, net, advance,
      pending: n2(list.filter((t) => t.reimb_status !== 'paid').reduce((s, t) => s + t.calc.net, 0)),
    },
    months: Object.values(months), byKind, rows: list,
  };
});
on('GET', '/trip/:id', ({ params }) => {
  const t = byId('trips', params.id);
  if (!t) fail(404, '出差记录不存在');
  return tripWithCalc(t, tripRules());
});
on('GET', '/trip/:id/text', ({ params }) => {
  const t = byId('trips', params.id);
  if (!t) fail(404, '出差记录不存在');
  return { text: tripText(tripWithCalc(t, tripRules()), currentUser()) };
});
on('POST', '/trip/:id/items', ({ params, body }) => {
  const t = byId('trips', params.id);
  if (!t) fail(404, '出差记录不存在');
  const db = load();
  db.trip_items = db.trip_items || [];
  const id = T('trip_items').reduce((mx, x) => Math.max(mx, num(x.id)), 0) + 1;
  const row = {
    id, trip_id: t.id, kind: String(body?.kind || 'other'),
    date: String(body?.date || t.start_date || ''), amount: n2(body?.amount),
    note: String(body?.note || ''), invoice_no: String(body?.invoice_no || ''),
    has_invoice: body?.has_invoice === 0 || body?.has_invoice === false ? 0 : 1,
    attach_id: body?.attach_id ? Number(body.attach_id) : null,
    created_at: nowISO(), updated_at: nowISO(), deleted_at: null,
  };
  T('trip_items').push(row);
  save();
  return row;
});
on('PATCH', '/trip/items/:id', ({ params, body }) => {
  const it = byId('trip_items', params.id);
  if (!it) fail(404, '明细不存在');
  for (const k of ['kind', 'date', 'note', 'invoice_no']) if (k in (body || {})) it[k] = String(body[k] ?? '');
  if ('amount' in (body || {})) it.amount = n2(body.amount);
  if ('has_invoice' in (body || {})) it.has_invoice = body.has_invoice ? 1 : 0;
  if ('attach_id' in (body || {})) it.attach_id = body.attach_id ? Number(body.attach_id) : null;
  it.updated_at = nowISO();
  save();
  return it;
});
on('DELETE', '/trip/items/:id', ({ params }) => {
  if (!recyclePut('trip_items', params.id)) fail(404, '明细不存在');
  return { ok: true };
});

/* ---- 惩罚记录 ---- */
on('GET', '/punish/records', ({ query }) => {
  const date = query.date ? String(query.date) : '';
  const rows = rowsOf('punish_records').sort((a, b) => b.id - a.id);
  return date ? rows.filter((r) => r.date === date) : rows.slice(0, 100);
});
on('POST', '/punish/records', ({ body }) => {
  const text = String(body?.text || '').trim();
  if (!text) fail(400, '缺少任务内容');
  const db = load();
  db.punish_records = db.punish_records || [];
  const id = T('punish_records').reduce((mx, x) => Math.max(mx, num(x.id)), 0) + 1;
  const row = {
    id, roster_id: body?.roster_id || null, grade: String(body?.grade || ''),
    class_name: String(body?.class_name || ''), stu_name: String(body?.stu_name || ''),
    text, source: body?.source === 'teacher' ? 'teacher' : 'student',
    date: String(body?.date || todayStr()), note: String(body?.note || ''), created_at: nowISO(),
  };
  T('punish_records').push(row);
  save();
  return row;
});
on('DELETE', '/punish/records/:id', ({ params }) => {
  const db = load();
  db.punish_records = (db.punish_records || []).filter((r) => String(r.id) !== String(params.id));
  save();
  return { ok: true };
});

/* ---- 导出 / 导入 ---- */
on('GET', '/export/:kind', ({ params, query }) => {
  const data = buildExport(params.kind, query.month || '');
  return { format: query.format || 'csv', ...data };
});
on('POST', '/import/:kind', ({ params, body }) => {
  const kind = params.kind;
  const text = String(body?.text || '');
  const grid = parseClipboardTable(text);
  if (!grid.length) fail(400, '没有可导入的内容');
  const header = grid[0];
  const bodyRows = /^\s*(序号|日期|姓名|标题|类型)/.test(header.join('')) ? grid.slice(1) : grid;
  const map = {
    序号: 'seq', 日期: 'date', 开始: 'start_date', 结束: 'end_date', 节次: 'period_no',
    时间: 'time_range', 年级: 'grade', 班级: 'class_name', 科目: 'subject', 任课: 'teacher',
    代课人: 'substitute', 课时: 'hours', 上课内容: 'content', 教学进度: 'progress',
    下节课内容: 'next_content', 违纪情况: 'discipline', 备注: 'remark', 标题: 'title',
    内容: 'content', 时长分钟: 'minutes', 出发点: 'from_place', 目的地: 'to_place',
    事由: 'reason', 随行人员: 'companions', 公里数: 'km', 过路费: 'toll', 停车费: 'parking',
  };
  const table = { lessons: 'lessons', invigilations: 'invigilations', trips: 'trips', studies: 'studies', students: 'students', items: 'items', todos: 'todos' }[kind];
  if (!table) fail(400, '该类型暂不支持导入');
  const db = load();
  db[table] = db[table] || [];
  let n = 0;
  const fields = TABLES[table] || [];
  for (const line of bodyRows) {
    const obj = {};
    header.forEach((h, i) => {
      const key = map[String(h).replace(/\s/g, '')] || String(h);
      if (fields.includes(key)) obj[key] = line[i];
    });
    if (table === 'todos') {
      const id = T('todos').reduce((mx, x) => Math.max(mx, num(x.id)), 0) + 1;
      T('todos').push({ id, seq: nextSeq('todo'), title: obj.title || line[0], content: '', status: 'todo', color: '', due_at: null, created_at: nowISO(), updated_at: nowISO(), deleted_at: null });
      n += 1;
      continue;
    }
    if (table === 'items') {
      const id = T('items').reduce((mx, x) => Math.max(mx, num(x.id)), 0) + 1;
      T('items').push({ id, seq: nextSeq('item'), kind: '事项', title: obj.title || line[0], detail: '', start_at: null, end_at: null, status: 'todo', priority: 'normal', source: '', created_at: nowISO(), updated_at: nowISO(), deleted_at: null });
      n += 1;
      continue;
    }
    if (!Object.keys(obj).length) continue;
    const id = db[table].reduce((mx, x) => Math.max(mx, num(x.id)), 0) + 1;
    db[table].push({ id, ...obj, seq: bumpSeq(table), created_at: nowISO(), updated_at: nowISO(), deleted_at: null });
    n += 1;
  }
  save();
  return { imported: n, headers: header };
});

/* ---- 作业记录 ---- */
on('GET', '/homework/:id/records', ({ params }) => {
  const h = byId('homework', params.id);
  if (!h) fail(404, '作业不存在');
  return (load().homework_records || []).filter((r) => !r.deleted_at && String(r.homework_id) === String(h.id));
});
on('GET', '/homework_records', ({ query }) => {
  if (!query.homework_id) return [];
  const h = byId('homework', query.homework_id);
  if (!h) return [];
  return (load().homework_records || []).filter((r) => !r.deleted_at && String(r.homework_id) === String(h.id));
});
on('POST', '/homework/:id/records', ({ params, body }) => {
  const h = byId('homework', params.id);
  if (!h) fail(404, '作业不存在');
  const db = load();
  db.homework_records = db.homework_records || [];
  const list = body?.rows || [];
  for (const r of list) {
    const ex = T('homework_records').find((x) => !x.deleted_at && String(x.homework_id) === String(h.id) && x.student_name === r.student_name);
    if (ex) {
      ex.status = r.status || 'pending';
      ex.score = r.score ?? null;
      ex.remark = r.remark || '';
      ex.updated_at = nowISO();
    } else {
      const id = T('homework_records').reduce((mx, x) => Math.max(mx, num(x.id)), 0) + 1;
      T('homework_records').push({
        id, homework_id: h.id, student_name: r.student_name, status: r.status || 'pending',
        score: r.score ?? null, remark: r.remark || '', created_at: nowISO(), updated_at: nowISO(), deleted_at: null,
      });
    }
  }
  save();
  return { saved: list.length };
});

/* ---- 附件 & 上传 ---- */
function saveAttachment(ownerType, ownerId, name, mime, size, dataUrl) {
  const db = load();
  db.attachments = db.attachments || [];
  const id = T('attachments').reduce((mx, x) => Math.max(mx, num(x.id)), 0) + 1;
  T('attachments').push({
    id, owner_type: ownerType, owner_id: Number(ownerId) || 0,
    name, mime, size, path: `inline-${id}`, url: dataUrl || '',
    created_at: nowISO(), updated_at: nowISO(), deleted_at: null,
  });
  save();
  return id;
}
on('POST', '/upload', async ({ body }) => {
  const files = body?.files || [];
  if (!files.length) fail(400, '没有收到文件');
  const ownerType = body?.fields?.owner_type || 'misc';
  const ownerId = Number(body?.fields?.owner_id || 0);
  const out = [];
  for (const f of files) {
    /* localStorage 只有 5MB，大文件塞不进去。这里限制 1.5MB，
       超过就明确告诉用户，而不是静默把数据丢掉。 */
    if (f.data.length > 1.5 * 1024 * 1024) {
      fail(400, `静态版把文件存在浏览器里，单个文件不能超过 1.5MB（「${f.filename}」${(f.data.length / 1024 / 1024).toFixed(1)}MB）`);
    }
    const dataUrl = await blobToDataURL(f.data, f.mime);
    const id = saveAttachment(ownerType, ownerId, f.filename, f.mime, f.data.length, dataUrl);
    out.push({ id, url: dataUrl, name: f.filename, mime: f.mime, size: f.data.length });
  }
  return out;
});
on('GET', '/attachments', ({ query }) => {
  let list = (load().attachments || []).filter((a) => !a.deleted_at);
  if (query.owner_type) list = list.filter((a) => a.owner_type === query.owner_type);
  if (query.owner_id) list = list.filter((a) => String(a.owner_id) === String(Number(query.owner_id)));
  return list.sort((a, b) => a.id - b.id).map((a) => ({ ...a, url: a.url || '' }));
});
on('DELETE', '/attachments/:id', ({ params }) => {
  const a = (load().attachments || []).find((x) => String(x.id) === String(params.id));
  if (!a) fail(404, '附件不存在');
  if (a.owner_type === 'avatar') {
    a.deleted_at = nowISO();
    save();
    return { ok: true };
  }
  recyclePut('attachments', params.id);
  return { ok: true };
});

/* ---- 学生短链 ---- */
on('GET', '/links', () => (load().links || [])
  .filter((l) => !l.deleted_at)
  .sort((a, b) => a.id - b.id)
  .map((l) => ({ ...l, grades: safeJSON(l.grades, []) })));
on('POST', '/links', ({ body }) => {
  const db = load();
  db.links = db.links || [];
  const code = body?.code && /^[a-z0-9]{4,20}$/.test(body.code) ? body.code : randomCode(6);
  const id = T('links').reduce((mx, x) => Math.max(mx, num(x.id)), 0) + 1;
  const row = {
    id, code, title: body?.title || '班级资料站',
    grades: JSON.stringify(body?.grades || []), enabled: 1,
    created_at: nowISO(), updated_at: nowISO(), deleted_at: null,
  };
  T('links').push(row);
  save();
  return row;
});
on('PATCH', '/links/:id', ({ params, body }) => {
  const l = byId('links', params.id);
  if (!l) fail(404, '链接不存在');
  for (const k of ['title', 'enabled']) if (k in (body || {})) l[k] = body[k];
  if (body?.grades) l.grades = JSON.stringify(body.grades);
  l.updated_at = nowISO();
  save();
  return l;
});

/* ---- 点名 ---- */
on('POST', '/roll/open', ({ body }) => {
  const roster = byId('rosters', body?.roster_id);
  if (!roster) fail(404, '班级不存在');
  return openRollSession(roster, body);
});
function openRollSession(roster, b = {}) {
  const db = load();
  db.roll_sessions = db.roll_sessions || [];
  const date = String(b.date || todayStr());
  const period = Number(b.period_no) || 0;
  const exist = T('roll_sessions').find((s) => !s.deleted_at && String(s.roster_id) === String(roster.id) && s.date === date && num(s.period_no) === period);
  if (exist) {
    if (exist.status === 'closed' && b.reopen) {
      exist.status = 'open';
      exist.updated_at = nowISO();
      save();
    }
    return exist;
  }
  const id = T('roll_sessions').reduce((mx, x) => Math.max(mx, num(x.id)), 0) + 1;
  const row = {
    id, link_id: b.link_id || null, roster_id: roster.id,
    grade: roster.grade || '', class_name: roster.class_name || '',
    date, period_no: period, subject: String(b.subject || ''),
    expect: num(roster.count), status: 'open', note: String(b.note || ''),
    created_at: nowISO(), updated_at: nowISO(), deleted_at: null,
  };
  T('roll_sessions').push(row);
  save();
  return row;
}
on('GET', '/roll/sessions', ({ query }) => {
  const date = String(query.date || todayStr());
  return rollSessions(date).map((s) => ({ ...s, stats: rollCount(s.id) }));
});
on('GET', '/roll/sessions/:id', ({ params }) => {
  const db = load();
  const s = (T('roll_sessions') || []).find((x) => String(x.id) === String(params.id) && !x.deleted_at);
  if (!s) fail(404, '点名不存在');
  const records = (T('roll_records') || []).filter((r) => String(r.session_id) === String(s.id))
    .sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
  const roster = (T('rosters') || []).find((r) => String(r.id) === String(s.roster_id));
  const names = roster ? safeJSON(roster.names, []) : [];
  const seen = new Set(records.map((r) => stuKey(r.stu_name)));
  const missing = names.filter((n) => n && !seen.has(stuKey(n)));
  return { session: s, records, roster: roster ? { ...roster, names } : null, missing };
});
on('PATCH', '/roll/sessions/:id', ({ params, body }) => {
  const db = load();
  const s = (T('roll_sessions') || []).find((x) => String(x.id) === String(params.id) && !x.deleted_at);
  if (!s) fail(404, '点名不存在');
  for (const k of ['status', 'note', 'subject']) if (k in (body || {})) s[k] = body[k];
  s.updated_at = nowISO();
  save();
  return s;
});
on('POST', '/roll/sessions/:id/mark', ({ params, body }) => {
  const db = load();
  db.roll_records = db.roll_records || [];
  const s = (T('roll_sessions') || []).find((x) => String(x.id) === String(params.id) && !x.deleted_at);
  if (!s) fail(404, '点名不存在');
  const name = String(body?.stu_name || '').trim();
  const key = stuKey(body?.stu_no || name);
  if (!key) fail(400, '缺少学生姓名');
  const status = ROLL_STATUS.includes(body?.status) ? body.status : 'present';
  const old = T('roll_records').find((r) => String(r.session_id) === String(s.id) && r.stu_key === key);
  if (old) {
    old.status = status;
    old.source = 'teacher';
    old.stu_name = name || old.stu_name;
    old.updated_at = nowISO();
  } else {
    const id = T('roll_records').reduce((mx, x) => Math.max(mx, num(x.id)), 0) + 1;
    T('roll_records').push({
      id, session_id: s.id, stu_key: key, stu_name: name, stu_no: String(body?.stu_no || ''),
      status, source: 'teacher', ip: '', created_at: nowISO(), updated_at: nowISO(),
    });
  }
  save();
  return { ok: true };
});
on('DELETE', '/roll/sessions/:id', ({ params }) => {
  const db = load();
  const s = (T('roll_sessions') || []).find((x) => String(x.id) === String(params.id));
  if (s) { s.deleted_at = nowISO(); save(); }
  return { ok: true };
});

/* ---- 学生端（免登录） ---- */
on('GET', '/public/link/:code', ({ params, query }) => {
  const l = (load().links || []).find((x) => x.code === params.code && num(x.enabled) === 1 && !x.deleted_at);
  if (!l) fail(404, '链接不存在或已关闭');
  const db = load();
  const u = currentUser();
  const grades = safeJSON(l.grades, []);
  const mats = rowsOf('materials').filter((m) => num(m.public) === 1)
    .sort((a, b) => b.id - a.id)
    .map((m) => ({ id: m.id, seq: m.seq, title: m.title, grade: m.grade, class_name: m.class_name, descr: m.descr, created_at: m.created_at }));
  const cats = rowsOf('categories').filter((c) => c.scope === 'material')
    .sort((a, b) => num(a.sort) - num(b.sort))
    .map((c) => ({ id: c.id, name: c.name }));
  const rosters = rowsOf('rosters')
    .map((r) => ({ id: r.id, grade: r.grade, class_name: r.class_name, count: r.count, names: safeJSON(r.names, []) }))
    .filter((r) => !grades.length || grades.includes(r.grade));
  const punish = rowsOf('punishments').filter((p) => num(p.active) === 1)
    .map((p) => ({ id: p.id, text: p.text, level: p.level }));
  const date = String(query.date || todayStr());
  const roll = rollSessions(date).filter((s) => s.status === 'open')
    .map((s) => {
      const roster = (T('rosters') || []).find((r) => String(r.id) === String(s.roster_id));
      return {
        id: s.id, grade: s.grade, class_name: s.class_name, period_no: s.period_no,
        subject: s.subject, expect: num(s.expect) || num(roster?.count),
      };
    });
  return {
    link: { code: l.code, title: l.title, grades },
    teacher: { nickname: u.nickname, subject: u.subject, school: u.school },
    materials: mats, categories: cats, rosters, punishments: punish, roll, date,
  };
});
on('GET', '/public/link/:code/file/:id', ({ params }) => {
  const l = (load().links || []).find((x) => x.code === params.code && num(x.enabled) === 1 && !x.deleted_at);
  if (!l) fail(404, '链接不存在');
  const a = (load().attachments || []).find((x) => String(x.id) === String(params.id) && x.owner_type === 'material' && !x.deleted_at);
  if (!a) fail(404, '文件不存在');
  const m = byId('materials', a.owner_id);
  if (m) { m.views = num(m.views) + 1; save(); }
  return { file: a };
});
on('GET', '/public/link/:code/materials/:id', ({ params }) => {
  const l = (load().links || []).find((x) => x.code === params.code && num(x.enabled) === 1 && !x.deleted_at);
  if (!l) fail(404, '链接不存在');
  const m = byId('materials', params.id);
  if (!m) fail(404, '资料不存在');
  m.views = num(m.views) + 1;
  save();
  const files = (load().attachments || [])
    .filter((a) => !a.deleted_at && a.owner_type === 'material' && String(a.owner_id) === String(m.id))
    .map((a) => ({ id: a.id, name: a.name, mime: a.mime, size: a.size, url: a.url || '' }));
  return { material: m, files };
});
on('GET', '/public/link/:code/roll', ({ params, query }) => {
  const l = (load().links || []).find((x) => x.code === params.code && num(x.enabled) === 1 && !x.deleted_at);
  if (!l) fail(404, '链接不存在或已关闭');
  const date = String(query.date || todayStr());
  const db = load();
  const sessions = rollSessions(date).filter((s) => s.status === 'open').map((s) => {
    const roster = (T('rosters') || []).find((r) => String(r.id) === String(s.roster_id));
    return {
      id: s.id, grade: s.grade, class_name: s.class_name, period_no: s.period_no,
      subject: s.subject, expect: num(s.expect) || num(roster?.count),
    };
  });
  return { date, sessions };
});
on('POST', '/public/link/:code/roll/:id', ({ params, body }) => {
  const db = load();
  db.roll_records = db.roll_records || [];
  const s = (T('roll_sessions') || []).find((x) => String(x.id) === String(params.id) && !x.deleted_at);
  if (!s) fail(404, '这场点名不存在');
  if (s.status !== 'open') fail(400, '这场点名已经结束了');
  const status = ROLL_STATUS.includes(body?.status) ? body.status : 'present';
  const name = String(body?.name || '').trim().slice(0, 20);
  const no = String(body?.stu_no || '').trim().slice(0, 20);
  const key = stuKey(no || name);
  if (!key) fail(400, '请先填写你的学号或姓名');
  const roster = s.roster_id ? (T('rosters') || []).find((r) => String(r.id) === String(s.roster_id)) : null;
  const names = roster ? safeJSON(roster.names, []).filter(Boolean) : [];
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
  const old = T('roll_records').find((r) => String(r.session_id) === String(s.id) && r.stu_key === finalKey);
  if (old) {
    old.status = status;
    old.stu_name = matched || name || old.stu_name;
    old.stu_no = no || old.stu_no;
    old.updated_at = nowISO();
  } else {
    const id = T('roll_records').reduce((mx, x) => Math.max(mx, num(x.id)), 0) + 1;
    T('roll_records').push({
      id, session_id: s.id, stu_key: finalKey, stu_name: matched || name, stu_no: no,
      status, source: 'student', ip: '', created_at: nowISO(), updated_at: nowISO(),
    });
  }
  save();
  const c = rollCount(s.id);
  return { ok: true, status, mine: status, total: c.total, present: c.present, late: c.late, leave: c.leave };
});
on('POST', '/public/link/:code/punish', ({ params, body }) => {
  const l = (load().links || []).find((x) => x.code === params.code && num(x.enabled) === 1 && !x.deleted_at);
  if (!l) fail(404, '链接不存在或已关闭');
  const text = String(body?.text || '').trim().slice(0, 200);
  if (!text) fail(400, '缺少任务内容');
  const db = load();
  db.punish_records = db.punish_records || [];
  const id = T('punish_records').reduce((mx, x) => Math.max(mx, num(x.id)), 0) + 1;
  T('punish_records').push({
    id, roster_id: body?.roster_id || null, grade: String(body?.grade || ''),
    class_name: String(body?.class_name || ''), stu_name: String(body?.stu_name || '').slice(0, 20),
    text, source: 'student', date: todayStr(), note: '', created_at: nowISO(),
  });
  save();
  return { id };
});

/* ---- 点名名单 ---- */
on('PATCH', '/rosters/:id', ({ params, body }) => {
  const r = byId('rosters', params.id);
  if (!r) fail(404, '班级不存在');
  for (const k of ['grade', 'class_name', 'count']) if (k in (body || {})) r[k] = body[k];
  if (body?.names) {
    r.names = JSON.stringify(body.names);
    if (!('count' in (body || {}))) r.count = body.names.length;
  }
  r.updated_at = nowISO();
  save();
  return r;
});

/* ---- 快速添加 ---- */
on('POST', '/quick', ({ body }) => {
  const text = String(body?.text || '').trim();
  if (!text) fail(400, '内容不能为空');
  const db = load();
  db.todos = db.todos || [];
  db.items = db.items || [];
  const tid = T('todos').reduce((mx, x) => Math.max(mx, num(x.id)), 0) + 1;
  T('todos').push({
    id: tid, seq: nextSeq('todo'), title: text, content: '', status: 'todo',
    color: body?.color || '', due_at: null, pin: 0, ref_item_id: null,
    created_at: nowISO(), updated_at: nowISO(), deleted_at: null,
  });
  const iid = T('items').reduce((mx, x) => Math.max(mx, num(x.id)), 0) + 1;
  T('items').push({
    id: iid, seq: nextSeq('item'), kind: '事项', title: text, detail: '',
    start_at: body?.at || null, end_at: null, status: 'todo',
    priority: body?.priority || 'normal', source: '便签', ref_id: tid,
    created_at: nowISO(), updated_at: nowISO(), deleted_at: null,
  });
  // 回填双向关联，让「状态同源」真的生效
  T('todos').find((t) => t.id === tid).ref_item_id = iid;
  save();
  if (body?.at && body?.remind_min !== undefined) {
    addReminder({ title: text, due_at: body.at, advance_min: Number(body.remind_min) || 0, item_id: iid });
  }
  return { todo: T('todos').find((t) => t.id === tid), item: T('items').find((i) => i.id === iid) };
});

/* ---- 搜索 ---- */
on('GET', '/search', ({ query }) => searchAll(String(query.q || '').trim(), String(query.mode || '')));

function searchAll(q, mode) {
  if (!q) return { groups: [], total: 0, mode, q };
  const hit = (s) => String(s || '').toLowerCase().includes(q.toLowerCase());
  const groups = [];
  const push = (name, cat, rows, mapper) => {
    const hits = rows.filter((r) => mapper(r).some(hit));
    if (hits.length) groups.push({ name, cat, rows: hits.slice(0, 20), hits: hits.length });
  };
  push('上课记录', 'lessons', rowsOf('lessons'), (r) => [r.date, r.class_name, r.subject, r.content, r.progress]);
  push('笔记', 'notes', rowsOf('notes'), (r) => [r.title, r.content]);
  push('课件', 'materials', rowsOf('materials'), (r) => [r.title, r.descr]);
  push('学生', 'students', rowsOf('students'), (r) => [r.name, r.class_name]);
  push('便签', 'todos', rowsOf('todos'), (r) => [r.title, r.content]);
  push('事项', 'items', rowsOf('items'), (r) => [r.title, r.detail]);
  push('学习记录', 'studies', rowsOf('studies'), (r) => [r.title, r.content]);
  push('出差', 'trips', rowsOf('trips'), (r) => [r.to_place, r.reason]);
  push('监考', 'invigilations', rowsOf('invigilations'), (r) => [r.subject, r.exam_name, r.place, r.peer_name]);
  push('考勤表', 'attendance_tables', rowsOf('attendance_tables'), (r) => [r.name, r.grade]);
  groups.sort((a, b) => b.hits - a.hits);
  return { groups, total: groups.reduce((s, g) => s + g.rows.length, 0), mode, q };
}

/* ---- 备份 ---- */
on('GET', '/backup', () => ({ version: 1, exported_at: nowISO(), data: exportJSON() }));
on('POST', '/backup/restore', ({ body }) => {
  // 兼容两种形状：{data:{...}} 与直接 {...}
  const data = body?.data?.data ? body.data.data : (body?.data && body.data.items ? body.data : (body?.items ? body : null));
  if (!data) fail(400, '备份文件格式不正确');
  const db = load();
  let n = 0;
  for (const [t, rows] of Object.entries(data)) {
    if (!Array.isArray(rows)) continue;
    if (t === 'seqs' || t === 'meta') continue;
    db[t] = db[t] || [];
    for (const row of rows) {
      const r = { ...row };
      delete r.id;
      // 追加模式：不覆盖现有数据，重复内容用户自己清理
      const id = db[t].reduce((mx, x) => Math.max(mx, num(x.id)), 0) + 1;
      db[t].push({ ...r, id });
      n += 1;
    }
  }
  save();
  return { imported: n };
});

/* ---- 通用 CRUD（必须放在最后，避免抢走具体路由） ---- */
/* 服务端的自动路由表：/api/{table} 的 GET / POST / PATCH / bulk。
   表名来自 localdb.TABLES 里与服务端 CRUD 对齐的那 18 张。 */
const CRUD_TABLES = [
  'periods', 'courses', 'lessons', 'invigilations', 'trips', 'materials', 'notes', 'preps',
  'categories', 'homework', 'studies', 'students', 'rosters', 'punishments', 'exceptions',
  'selfstudy', 'repairs', 'teachers',
];

for (const table of CRUD_TABLES) {
  on('GET', '/' + table, ({ query }) => listTable(table, query));
  on('POST', '/' + table, ({ body }) => {
    const b = { ...(body || {}) };
    // 监考表旧列 type 是 NOT NULL，新逻辑用 duty_type，这里补一份映射
    if (table === 'invigilations' && !b.type) {
      const m = { school: '学校分配', '替他人': '我代他人', '他人替我': '他人代我' };
      b.type = m[b.duty_type] || '学校分配';
    }
    if (table === 'teachers') {
      // 教师名册要记录年级内排序，否则新加的人排最前
      const db = load();
      const sort = (T('teachers') || []).filter((t) => t.grade === b.grade).reduce((mx, t) => Math.max(mx, num(t.sort)), 0) + 1;
      b.sort = b.sort ?? sort;
      b.active = b.active ?? 1;
    }
    if (table === 'materials') { b.views = b.views ?? 0; b.downloads = b.downloads ?? 0; }
    return createRow(table, normalizeBody(b));
  });
  on('PATCH', `/${table}/:id`, ({ params, body }) => updateRow(table, params.id, normalizeBody(body || {})));
  on('POST', `/${table}/bulk`, ({ body }) => {
    const rows = Array.isArray(body?.rows) ? body.rows : [];
    const ids = [];
    for (const item of rows) {
      if (item && item.id) { updateRow(table, item.id, normalizeBody(item)); ids.push(item.id); }
      else { ids.push(createRow(table, normalizeBody(item || {})).id); }
    }
    return { ids };
  });
}

/* 对象/布尔值要按服务端的规矩落库：布尔→0/1，对象→JSON 字符串 */
function normalizeBody(b) {
  const out = {};
  for (const [k, v] of Object.entries(b)) {
    if (typeof v === 'boolean') out[k] = v ? 1 : 0;
    else if (v !== null && typeof v === 'object') out[k] = JSON.stringify(v);
    else out[k] = v;
  }
  return out;
}

/* 通用删除：/api/:table/:id（放在所有具体路由之后） */
on('DELETE', '/:table/:id', ({ params }) => {
  const table = params.table;
  if (!RECYCLE_TITLE[table]) fail(400, '不支持的删除类型');
  const row = (load()[table] || []).find((r) => String(r.id) === String(params.id) && !r.deleted_at);
  if (!row) fail(404, '记录不存在');
  if (table === 'categories') {
    const t = row.scope === 'material' ? 'materials' : row.scope === 'note' ? 'notes' : 'studies';
    const refs = rowsOf(t).filter((x) => String(x.category_id) === String(row.id)).length;
    if (refs) fail(400, '该分类下还有内容，请先移动或删除内容');
  }
  recyclePut(table, params.id);
  return { ok: true };
});

/* ============================ 统一入口 ============================ */
/* 返回 { ok:true, data } 或抛 { code, error }，与 api.req 的期望一致。 */
export async function handle(method, path, query = {}, body = undefined) {
  const clean = path.split('?')[0];
  for (const r of R) {
    if (r.method !== method) continue;
    const m = r.re.exec(clean);
    if (!m) continue;
    const params = {};
    r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
    try {
      const data = await r.fn({ params, query, body });
      return { ok: true, data: data === undefined ? null : data };
    } catch (e) {
      if (e instanceof ApiError) return { ok: false, error: e.message, code: e.code, extra: e.extra };
      console.error('[localapi]', method, clean, e);
      return { ok: false, error: '本地处理失败：' + e.message, code: 500 };
    }
  }
  return { ok: false, error: '接口不存在（静态版）：' + method + ' ' + clean, code: 404 };
}

/* ============================ 小工具 ============================ */
function safeJSON(s, dflt) {
  if (Array.isArray(s)) return s;
  if (typeof s === 'object') return s || dflt;
  try { return JSON.parse(s || 'null') ?? dflt; } catch { return dflt; }
}

function blobToDataURL(data, mime) {
  return new Promise((resolve) => {
    /* f.data 可能是 ArrayBuffer / Uint8Array / Blob / 字符串 */
    const blob = data instanceof Blob ? data : new Blob([data], { type: mime || 'application/octet-stream' });
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ''));
    fr.onerror = () => resolve('');
    fr.readAsDataURL(blob);
  });
}

/* 拿一个示例课件的文本内容（学生端「下载」用，没有真实文件时兜底） */
export function getSeedFileText(path) {
  const db = load();
  return (db.meta.seedFiles || {})[path] || '';
}

/* 给前端读的「当前是不是静态版」标记 */
export const STATIC_MODE = true;
