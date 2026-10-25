import { all, one, run, nextSeq, nowISO } from './db.mjs';

/* 生成一段时间内的课程实例（用于首页/日历/倒计时） */
const WD = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function pad(n) { return String(n).padStart(2, '0'); }
export function fmtDate(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

/* 全站统一的日期口径。
   时间戳（created_at 等）存的是 UTC ISO 串，但用户在北京；
   如果按服务器本地时区（部署机是 UTC）取"今天"，每天 00:00~08:00 这 8 小时里
   substr(created_at,1,10) 会比用户眼里的"今天"早一天——刚记的便签就会存进去却看不见。
   所以日期一律按 UTC+8 换算，由服务器说了算，不依赖前端传值。 */
const CN_OFFSET_MS = 8 * 3600 * 1000;
export function cnDate(d = new Date()) { return fmtDate(new Date(d.getTime() + CN_OFFSET_MS)); }
/** 把 UTC ISO 时间串（如 created_at）换算成北京时区的 YYYY-MM-DD */
export function isoToCnDate(iso) {
  if (!iso) return '';
  const t = Date.parse(iso.length === 10 ? iso + 'T00:00:00Z' : iso);
  return Number.isNaN(t) ? String(iso).slice(0, 10) : cnDate(new Date(t));
}

export function courseInstancesForRange(userId, fromDate, toDate) {
  const courses = all('SELECT * FROM courses WHERE user_id=? AND deleted_at IS NULL', userId);
  const periods = all('SELECT * FROM periods WHERE user_id=? AND deleted_at IS NULL ORDER BY period_no', userId);
  const pmap = new Map(periods.map((p) => [Number(p.period_no), p]));
  const exceptions = new Map();
  for (const r of all("SELECT * FROM exceptions WHERE user_id=? AND type='course'", userId)) {
    exceptions.set(`${r.date}#${r.ref_id}`, r);
  }
  const start = new Date(fromDate + 'T00:00:00');
  const end = new Date(toDate + 'T00:00:00');
  const out = [];
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const iso = fmtDate(d);
    const wd = d.getDay();
    for (const c of courses) {
      if (Number(c.weekday) !== wd) continue;
      if (c.start_date && iso < c.start_date) continue;
      if (c.end_date && iso > c.end_date) continue;
      const ex = exceptions.get(`${iso}#${c.id}`);
      if (ex && ex.action === 'cancel') continue;
      const p = pmap.get(Number(c.period_no)) || {};
      const st = (ex && ex.start_time) || c.start_time || p.start_time || '';
      const et = (ex && ex.end_time) || c.end_time || p.end_time || '';
      out.push({
        id: `c${c.id}-${iso}`,
        course_id: c.id,
        date: iso,
        weekday: wd,
        weekday_label: WD[wd],
        period_no: c.period_no,
        period_name: p.name || '',
        start_time: st,
        end_time: et,
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

/* 监考时间兜底：新记录写 start_time，老记录只有 start_at，统一补出可直接展示的值 */
export function fillInvigTime(r) {
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

/* 今日聚合 */
export function todayDigest(userId, dateISO) {
  // 有时间的事项按 start_at 的日期归属；没时间的（便签）按创建时间的北京日期归属。
  // 不能只用 SQL 的 substr：created_at 是 UTC，跨零点会差一天。
  const itemsAll = all(
    `SELECT * FROM items WHERE user_id=? AND deleted_at IS NULL ORDER BY COALESCE(start_at,created_at)`,
    userId
  );
  const items = itemsAll.filter((it) => (it.start_at ? String(it.start_at).slice(0, 10) : isoToCnDate(it.created_at)) === dateISO);
  const lessons = all('SELECT * FROM lessons WHERE user_id=? AND deleted_at IS NULL AND date=? ORDER BY COALESCE(period_no,0)', userId, dateISO);
  const courses = courseInstancesForRange(userId, dateISO, dateISO);
  const todos = all('SELECT * FROM todos WHERE user_id=? AND deleted_at IS NULL ORDER BY pin DESC, id DESC LIMIT 60', userId);
  const invig = all('SELECT * FROM invigilations WHERE user_id=? AND deleted_at IS NULL AND date=? ORDER BY COALESCE(start_time,\'\')', userId, dateISO)
    .map(fillInvigTime);
  return { items, lessons, courses, todos, invigilations: invig };
}

export function createMessage(userId, { type = 'system', title, body = '', ref_type = null, ref_id = null }) {
  run(
    'INSERT INTO messages(user_id,type,title,body,ref_type,ref_id,read,created_at) VALUES(?,?,?,?,?,?,0,?)',
    userId, type, title, body, ref_type, ref_id, nowISO()
  );
}

export function addReminder(userId, { title, body = '', due_at, advance_min = 0, repeat = 'none', ring = 'chime', kind = 'item', item_id = null }) {
  const fire = new Date(due_at).getTime() - (Number(advance_min) || 0) * 60000;
  run(
    `INSERT INTO reminders(user_id,item_id,kind,title,body,due_at,fire_at,repeat,advance_min,ring,status,created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?, 'scheduled', ?)`,
    userId, item_id, kind, title, body, due_at, fire, repeat, Number(advance_min) || 0, ring, nowISO()
  );
}

export function bumpSeq(userId, scope, table) {
  const seq = nextSeq(`${scope}:${userId}`);
  if (table) run(`UPDATE ${table} SET seq=?, updated_at=? WHERE user_id=? AND seq IS NULL AND deleted_at IS NULL`, seq, nowISO(), userId);
  return seq;
}
