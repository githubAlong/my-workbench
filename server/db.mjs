import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { CONFIG } from './env.mjs';

export const db = new DatabaseSync(path.join(CONFIG.dataDir, 'workbench.db'));
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

const DDL = `
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT UNIQUE,
  password_hash TEXT,
  nickname TEXT DEFAULT '',
  avatar TEXT DEFAULT '',
  school TEXT DEFAULT '',
  subject TEXT DEFAULT '',
  title TEXT DEFAULT '',
  wx_openid TEXT DEFAULT '',
  wx_unionid TEXT DEFAULT '',
  wx_nick TEXT DEFAULT '',
  qq_openid TEXT DEFAULT '',
  qq_nick TEXT DEFAULT '',
  wb_uid TEXT DEFAULT '',
  wb_token TEXT DEFAULT '',
  settings TEXT DEFAULT '{}',
  created_at TEXT, updated_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions(
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  device TEXT DEFAULT '',
  ip TEXT DEFAULT '',
  ua TEXT DEFAULT '',
  created_at TEXT, last_seen TEXT,
  revoked INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS otps(
  phone TEXT PRIMARY KEY,
  code TEXT, purpose TEXT, expires_at INTEGER, tries INTEGER DEFAULT 0,
  last_sent_at INTEGER
);

CREATE TABLE IF NOT EXISTS qr_tickets(
  id TEXT PRIMARY KEY,
  status TEXT DEFAULT 'pending',
  purpose TEXT DEFAULT 'login',
  user_id INTEGER,
  bind_type TEXT,
  confirmed_at INTEGER,
  created_at INTEGER, expires_at INTEGER
);

/* OAuth 授权回调的 state 暂存。
   state 必须落库而不是塞内存：授权要跳到 workbuddy.cn 再跳回来，
   中间用户可能等几十秒、可能换设备、服务也可能重启。
   只存内存会在回调时找不到记录，白白报一个「state 不匹配」。
   expires_at 用毫秒时间戳，10 分钟过期，和授权码本身的有效期一致。 */
CREATE TABLE IF NOT EXISTS oauth_states(
  state TEXT PRIMARY KEY,
  purpose TEXT DEFAULT 'login',
  user_id INTEGER,
  created_at INTEGER, expires_at INTEGER
);

/* 导出到系统日历的取件码。
   为什么不把 .ics 内容直接编进 URL：标题有中文和标点，编进 query 会被
   微信这类内置浏览器重新编码，轻则乱码重则整条丢失。
   取件码是 128 位随机串，10 分钟过期，交付时不需要登录态
   （Safari 把请求转交日历 App 时不保证还带着 Cookie）。 */
CREATE TABLE IF NOT EXISTS calendar_exports(
  code TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER, expires_at INTEGER
);

CREATE TABLE IF NOT EXISTS seqs(scope TEXT PRIMARY KEY, value INTEGER DEFAULT 0);

CREATE TABLE IF NOT EXISTS exceptions(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  type TEXT DEFAULT 'course',     -- course(课表调整)
  date TEXT NOT NULL,
  ref_id INTEGER,
  action TEXT DEFAULT 'edit',     -- edit / cancel
  start_time TEXT, end_time TEXT,
  class_name TEXT DEFAULT '', room TEXT DEFAULT '',
  rescheduled INTEGER DEFAULT 0,
  remark TEXT DEFAULT '',
  created_at TEXT, deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS items(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  seq INTEGER,
  kind TEXT NOT NULL,             -- 事项/任务/倒计时/课程/出差/学习/便签...
  title TEXT NOT NULL,
  detail TEXT DEFAULT '',
  start_at TEXT, end_at TEXT,     -- ISO 本地时间 'YYYY-MM-DDTHH:mm'
  remind_at TEXT,
  remind_min INTEGER,
  status TEXT DEFAULT 'todo',     -- todo/doing/done
  priority TEXT DEFAULT 'normal', -- low/normal/high/urgent
  source TEXT DEFAULT '',
  ref_id INTEGER DEFAULT NULL,
  created_at TEXT, updated_at TEXT,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS reminders(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  item_id INTEGER,
  kind TEXT DEFAULT 'item',       -- item / alarm
  title TEXT NOT NULL,
  body TEXT DEFAULT '',
  due_at TEXT NOT NULL,
  fire_at INTEGER NOT NULL,
  repeat TEXT DEFAULT 'none',     -- none / daily / weekly / monthly / workday / custom
  advance_min INTEGER DEFAULT 0,
  ring TEXT DEFAULT 'chime',
  status TEXT DEFAULT 'scheduled',-- scheduled / fired / acked / canceled
  created_at TEXT,
  acked_at TEXT
);

CREATE TABLE IF NOT EXISTS messages(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  type TEXT DEFAULT 'system',     -- remind/calendar/system/work
  title TEXT NOT NULL,
  body TEXT DEFAULT '',
  ref_type TEXT, ref_id INTEGER,
  read INTEGER DEFAULT 0,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS courses(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  weekday INTEGER NOT NULL,       -- 1..7
  period_no INTEGER NOT NULL,     -- 节次
  start_date TEXT, end_date TEXT, -- 生效周（可空）
  start_time TEXT, end_time TEXT,
  grade TEXT DEFAULT '', class_name TEXT DEFAULT '',
  subject TEXT DEFAULT '', room TEXT DEFAULT '',
  weeks TEXT DEFAULT '',          -- 每周说明，如 "1-18"
  color TEXT DEFAULT '',
  remark TEXT DEFAULT '',
  created_at TEXT, updated_at TEXT,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS periods(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  period_no INTEGER,
  name TEXT DEFAULT '',
  start_time TEXT, end_time TEXT,
  created_at TEXT, updated_at TEXT,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS lessons(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  seq INTEGER,
  date TEXT NOT NULL,
  period_no INTEGER,
  time_range TEXT DEFAULT '',
  grade TEXT DEFAULT '', class_name TEXT DEFAULT '',
  subject TEXT DEFAULT '',
  teacher TEXT DEFAULT '',        -- 实际上课人
  substitute TEXT DEFAULT '',     -- 代课人
  sub_type TEXT DEFAULT 'none',   -- none/代课/换课/被代课/我代他
  sub_note TEXT DEFAULT '',
  content TEXT DEFAULT '',
  progress TEXT DEFAULT '',
  next_content TEXT DEFAULT '',
  discipline TEXT DEFAULT '',
  hours REAL DEFAULT 1,
  /* 这节课的单价。和 settings.lesson.pricePerHour（全局默认单价）分开存：
     公开课、晚自习的单价经常和平时不一样，逐条记住才能如实对账。
     以前没有这一列，改单价只能改全局，历史记录就跟着一起被重算。 */
  unit_price REAL,
  remark TEXT DEFAULT '',
  created_at TEXT, updated_at TEXT,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS attendance_tables(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  kind TEXT NOT NULL,             -- research(教研签到) / seat(坐班)
  name TEXT NOT NULL,
  month TEXT NOT NULL,            -- YYYY-MM
  columns TEXT DEFAULT '[]',      -- 自定义列：[{key,label,type,...}]
  meta TEXT DEFAULT '{}',
  created_at TEXT, updated_at TEXT,
  deleted_at TEXT
);

/* 教师名册：一次录入，所有考勤表自动带出 */
CREATE TABLE IF NOT EXISTS teachers(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  grade TEXT NOT NULL DEFAULT '',    -- 高一 / 高二 ...
  name TEXT NOT NULL,
  subject TEXT DEFAULT '',
  sort INTEGER DEFAULT 0,
  active INTEGER DEFAULT 1,          -- 0 = 已调出，不再出现在新表里
  created_at TEXT, updated_at TEXT,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_teachers_user ON teachers(user_id, grade, sort);

CREATE TABLE IF NOT EXISTS attendance_rows(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  table_id INTEGER NOT NULL,
  teacher TEXT DEFAULT '',
  data TEXT DEFAULT '{}',         -- {colKey: value}
  sort INTEGER DEFAULT 0,
  created_at TEXT, updated_at TEXT,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS invigilations(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  seq INTEGER,
  date TEXT NOT NULL,
  type TEXT NOT NULL,             -- 学校分配 / 我代他人 / 他人代我
  person TEXT DEFAULT '',         -- 对应人员
  subject TEXT DEFAULT '',
  grade TEXT DEFAULT '',
  start_at TEXT, end_at TEXT,
  minutes INTEGER DEFAULT 0,
  amount REAL DEFAULT 0,
  paid INTEGER DEFAULT 0,
  place TEXT DEFAULT '',
  need_paper INTEGER DEFAULT 0,
  paper_place TEXT DEFAULT '',
  remark TEXT DEFAULT '',
  created_at TEXT, updated_at TEXT,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS trips(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  seq INTEGER,
  start_date TEXT, end_date TEXT,
  from_place TEXT DEFAULT '', to_place TEXT DEFAULT '',
  reason TEXT DEFAULT '', companions TEXT DEFAULT '',
  km REAL DEFAULT 0, toll REAL DEFAULT 0, parking REAL DEFAULT 0, other REAL DEFAULT 0,
  status TEXT DEFAULT 'draft',    -- draft / submitted / approved / rejected
  approve_note TEXT DEFAULT '',
  remark TEXT DEFAULT '',
  created_at TEXT, updated_at TEXT,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS attachments(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  owner_type TEXT NOT NULL, owner_id INTEGER NOT NULL,
  name TEXT DEFAULT '', mime TEXT DEFAULT '', size INTEGER DEFAULT 0,
  path TEXT NOT NULL,
  created_at TEXT, deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS categories(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  scope TEXT NOT NULL,            -- material(课件) / note(笔记) / study(学习)
  name TEXT NOT NULL,
  sort INTEGER DEFAULT 0,
  created_at TEXT, updated_at TEXT,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS materials(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  seq INTEGER,
  category_id INTEGER,
  title TEXT NOT NULL,
  grade TEXT DEFAULT '', class_name TEXT DEFAULT '',
  descr TEXT DEFAULT '',
  public INTEGER DEFAULT 1,
  views INTEGER DEFAULT 0,
  downloads INTEGER DEFAULT 0,
  created_at TEXT, updated_at TEXT,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS notes(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  seq INTEGER,
  category_id INTEGER,
  title TEXT NOT NULL,
  content TEXT DEFAULT '',
  tags TEXT DEFAULT '',
  pinned INTEGER DEFAULT 0,
  created_at TEXT, updated_at TEXT,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS todos(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  seq INTEGER,
  title TEXT NOT NULL,
  content TEXT DEFAULT '',
  status TEXT DEFAULT 'todo',
  color TEXT DEFAULT '',
  pin INTEGER DEFAULT 0,
  due_at TEXT,
  ref_item_id INTEGER,
  created_at TEXT, updated_at TEXT,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS homework(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  seq INTEGER,
  title TEXT NOT NULL,
  grade TEXT DEFAULT '', class_name TEXT DEFAULT '',
  subject TEXT DEFAULT '',
  assign_date TEXT, due_date TEXT,
  content TEXT DEFAULT '',
  created_at TEXT, updated_at TEXT,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS homework_records(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  homework_id INTEGER NOT NULL,
  student_id INTEGER,
  student_name TEXT DEFAULT '',
  status TEXT DEFAULT 'pending',  -- pending / done / partial / missing / late
  score REAL,
  remark TEXT DEFAULT '',
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS students(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  grade TEXT DEFAULT '', class_name TEXT DEFAULT '',
  name TEXT NOT NULL,
  no INTEGER,
  created_at TEXT, deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS studies(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  seq INTEGER,
  date TEXT NOT NULL,
  category_id INTEGER,
  title TEXT NOT NULL,
  content TEXT DEFAULT '',
  minutes INTEGER DEFAULT 0,
  source TEXT DEFAULT '',
  tags TEXT DEFAULT '',
  created_at TEXT, updated_at TEXT,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS rosters(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  grade TEXT NOT NULL, class_name TEXT NOT NULL,
  count INTEGER DEFAULT 0,
  names TEXT DEFAULT '[]',
  created_at TEXT, updated_at TEXT,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS student_links(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  code TEXT UNIQUE NOT NULL,
  title TEXT DEFAULT '班级资料站',
  grades TEXT DEFAULT '[]',
  enabled INTEGER DEFAULT 1,
  created_at TEXT, updated_at TEXT
);

CREATE TABLE IF NOT EXISTS punishments(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  text TEXT NOT NULL,
  level TEXT DEFAULT 'light',
  active INTEGER DEFAULT 1,
  created_at TEXT, updated_at TEXT, deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS daily_quotes(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  en TEXT NOT NULL,
  zh TEXT NOT NULL,
  author TEXT DEFAULT '',
  used_date TEXT
);

CREATE TABLE IF NOT EXISTS recycle(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  entity TEXT NOT NULL,
  entity_id INTEGER,
  title TEXT DEFAULT '',
  payload TEXT DEFAULT '',
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS audit_logs(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER, action TEXT, detail TEXT, ip TEXT, created_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_items_user ON items(user_id, deleted_at, start_at);
CREATE INDEX IF NOT EXISTS idx_lessons_user ON lessons(user_id, date);
CREATE INDEX IF NOT EXISTS idx_msg_user ON messages(user_id, read);
CREATE INDEX IF NOT EXISTS idx_rem_fire ON reminders(user_id, status, fire_at);
CREATE INDEX IF NOT EXISTS idx_students_user ON students(user_id, grade, class_name);
`;

db.exec(DDL);

/* ---------- 轻量迁移：给已有表补列（幂等） ---------- */
function ensureColumns(table, cols) {
  const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  for (const [name, def] of Object.entries(cols)) {
    if (!have.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`);
  }
}
ensureColumns('lessons', {
  start_time: "TEXT DEFAULT ''",
  end_time: "TEXT DEFAULT ''",
  at_school: 'INTEGER DEFAULT 1',
});
/* 扫码登录：票据要记住「哪台设备、从哪个 IP 发起」，
   手机上的确认页得把这两条显示出来，否则用户只能盲点「确认登录」。 */
ensureColumns('qr_tickets', {
  device: "TEXT DEFAULT ''",
  ip: "TEXT DEFAULT ''",
});
/* 上课模块扩展：代课对账（双轨结算 + 换课备查 + 结清留痕） */
ensureColumns('lessons', {
  peer_name: "TEXT DEFAULT ''",      // 对方姓名（代课人 / 原上课人 / 换课对象）
  peer_id: 'INTEGER',                // 关联 teachers.id，可为空
  orig_teacher: "TEXT DEFAULT ''",   // 原上课人（我代别人时=对方）
  pay_hours: 'REAL DEFAULT 1',       // 课时口径：折几次课时
  pay_amount: 'REAL DEFAULT 0',      // 金额口径：折多少钱
  unit_price: 'REAL',                // 这一节的单价（空=按全局默认单价算）
  settle_note: "TEXT DEFAULT ''",    // 结算备注
  swap_from: "TEXT DEFAULT ''",      // 换课：我原上的是什么
  swap_to: "TEXT DEFAULT ''",        // 换课：换成什么
  settled_at: 'TEXT',                // 结清时间，空=未结清
  settle_key: "TEXT DEFAULT ''",     // 结清归属（peer_name + 月份），用于按人批量结清
});

/* 中文代课类型 → 新枚举（幂等，只跑一次） */
try {
  const map = { '我代他人': '替他人上', '他人代我': '他人替我上', '换课': '换课', 'none': 'normal', '': 'normal' };
  const valid = ['normal', '替他人上', '他人替我上', '换课'];
  const rows = db.prepare("SELECT id, sub_type, substitute, hours, peer_name, orig_teacher FROM lessons").all();
  for (const r of rows) {
    const raw = r.sub_type == null ? '' : String(r.sub_type);
    if (valid.includes(raw)) continue;  // 已是新枚举，无需迁移
    const nextT = map[raw] ?? 'normal';
    const peer = r.substitute || '';
    // 「他人替我上」：课时不归我，归代课人
    const nextHours = nextT === '他人替我上' ? 0 : (r.hours == null ? 1 : r.hours);
    db.prepare('UPDATE lessons SET sub_type=?, peer_name=?, orig_teacher=?, hours=? WHERE id=?')
      .run(nextT, peer, nextT === '替他人上' ? peer : '', nextHours, r.id);
  }
} catch { /* 首次启动无表时忽略 */ }

ensureColumns('otps', { last_sent_at: 'INTEGER' });
ensureColumns('invigilations', { seq: 'INTEGER' });
ensureColumns('items', { remind_adv: 'INTEGER DEFAULT 10' });
/* 考勤表扩展：年级、表类型、日期、节次、学期 */
ensureColumns('attendance_tables', {
  grade: "TEXT DEFAULT ''",
  sheet_type: "TEXT DEFAULT ''",   // seat / research
  sheet_date: "TEXT DEFAULT ''",   // YYYY-MM-DD，坐班表用
  weekday: "TEXT DEFAULT ''",
  periods: "TEXT DEFAULT ''",      // “第 1-2 节”
  subject: "TEXT DEFAULT ''",      // 教研表可按学科拆
});
ensureColumns('attendance_rows', {
  subject: "TEXT DEFAULT ''",      // 冗余存学科，列表/分组免解析
});

/* 旧数据补齐：kind → sheet_type，年级默认高一 */
db.exec(`UPDATE attendance_tables SET sheet_type = CASE kind WHEN 'research' THEN 'research' ELSE 'seat' END
         WHERE sheet_type IS NULL OR sheet_type = ''`);
db.exec(`UPDATE attendance_tables SET grade = '高一' WHERE grade IS NULL OR grade = ''`);
/* 旧表没有具体日期时，用月份补一个 1 号，保证列表排序不乱 */
db.exec(`UPDATE attendance_tables SET sheet_date = month || '-01' WHERE sheet_date IS NULL OR sheet_date = ''`);
/* 旧版列结构 → 新版：坐班表用 5 个勾选列，教研表用 签到 + 备注 */
function migrateOldAttendance() {
  const tables = db.prepare('SELECT * FROM attendance_tables').all();
  for (const t of tables) {
    let cols = [];
    try { cols = JSON.parse(t.columns || '[]'); } catch { cols = []; }
    const isOld = cols.some((c) => ['morning', 'afternoon', 'status', 'sign_in', 'sign_out'].includes(c.key));
    if (!isOld) continue;
    const isResearch = (t.sheet_type || t.kind) === 'research';
    const newCols = isResearch
      ? [{ key: 'k_签到', label: '签到', type: 'check', w: 62 }, { key: 'k_remark', label: '备注', type: 'text', w: 130 }]
      : [
        { key: 'k_上课', label: '上课', type: 'check', w: 62 }, { key: 'k_坐班', label: '坐班', type: 'check', w: 62 },
        { key: 'k_听课', label: '听课', type: 'check', w: 62 }, { key: 'k_教研', label: '教研', type: 'check', w: 62 },
        { key: 'k_请假', label: '请假', type: 'check', w: 62 }, { key: 'k_remark', label: '备注', type: 'text', w: 130 },
      ];
    db.prepare('UPDATE attendance_tables SET columns=? WHERE id=?').run(JSON.stringify(newCols), t.id);
    const rows = db.prepare('SELECT * FROM attendance_rows WHERE table_id=?').all(t.id);
    for (const r of rows) {
      let d = {};
      try { d = JSON.parse(r.data || '{}'); } catch { d = {}; }
      const out = {};
      if (isResearch) {
        if (d.status === '已参加') out['k_签到'] = '1';
        else if (d.status === '请假' || d.status === '缺席') out['k_签到'] = '0';
        const note = [d.sign_in && '签到 ' + d.sign_in, d.topic, d.place].filter(Boolean).join(' ');
        if (note) out['k_remark'] = note;
      } else {
        if (d.morning === '是') out['k_坐班'] = '1';
        if (d.afternoon === '是') out['k_坐班'] = '1';
        if (d.morning === '请假' || d.afternoon === '请假') out['k_请假'] = '1';
        const note = [d.remark, d.hours && d.hours + 'h'].filter(Boolean).join(' ');
        if (note) out['k_remark'] = note;
      }
      db.prepare('UPDATE attendance_rows SET data=? WHERE id=?').run(JSON.stringify(out), r.id);
    }
  }
}
try { migrateOldAttendance(); } catch { /* 首次启动无表时忽略 */ }

/* 行的学科从 data 里回填一次 */
try {
  const rows = db.prepare("SELECT id, data FROM attendance_rows WHERE subject IS NULL OR subject = ''").all();
  for (const r of rows) {
    try {
      const d = JSON.parse(r.data || '{}');
      const sj = d.subject || d['学科'] || '';
      if (sj) db.prepare('UPDATE attendance_rows SET subject=? WHERE id=?').run(String(sj), r.id);
    } catch { /* 忽略解析失败 */ }
  }
} catch { /* 表可能刚建 */ }

/* ---------- 通用工具 ---------- */
export const nowISO = () => new Date().toISOString();
export const localDateTime = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

export function nextSeq(scope) {
  const row = db.prepare('SELECT value FROM seqs WHERE scope=?').get(scope);
  const v = (row?.value || 0) + 1;
  if (row) db.prepare('UPDATE seqs SET value=? WHERE scope=?').run(v, scope);
  else db.prepare('INSERT INTO seqs(scope,value) VALUES(?,?)').run(scope, v);
  return v;
}

export const all = (sql, ...p) => db.prepare(sql).all(...p);
export const one = (sql, ...p) => db.prepare(sql).get(...p);
export const run = (sql, ...p) => db.prepare(sql).run(...p);
export const j = (v, d = {}) => { try { return JSON.parse(v || ''); } catch { return d; } };

/* 监考模块扩展：三种类型 + 学校/同事两套账 + 逐场结清
   原有列（date/type/person/minutes/amount/paid/place…）保留兼容，新逻辑走新列 */
ensureColumns('invigilations', {
  exam_name: "TEXT DEFAULT ''",      // 考试名称
  duty_type: "TEXT DEFAULT 'school'",// school / 替他人 / 他人替我
  peer_name: "TEXT DEFAULT ''",      // 对方老师
  peer_id: 'INTEGER',
  start_time: "TEXT DEFAULT ''",
  end_time: "TEXT DEFAULT ''",
  duration_min: 'INTEGER DEFAULT 0',
  room: "TEXT DEFAULT ''",           // 考场
  seat_count: 'INTEGER',
  pay_amount: 'REAL DEFAULT 0',      // 金额快照
  pay_rule: "TEXT DEFAULT '场次'",   // 场次 / 时长
  pay_note: "TEXT DEFAULT ''",
  settled_at: 'TEXT',
  settle_key: "TEXT DEFAULT ''",
  status: "TEXT DEFAULT 'done'",     // planned / done / canceled
  school_paid: 'INTEGER DEFAULT 0',  // 学校那笔是否已到账
});
/* 旧数据迁移：把 type/person/date/amount 搬到新列（幂等，只处理新列为空的） */
try {
  const rows = db.prepare("SELECT id, type, person, date, start_at, end_at, minutes, amount, place, exam_name, duty_type FROM invigilations").all();
  const map = { '学校分配': 'school', '我代他人': '替他人', '他人代我': '他人替我', 'school': 'school', '替他人': '替他人', '他人替我': '他人替我' };
  for (const r of rows) {
    const dt = map[String(r.type || '').trim()] || (r.duty_type || 'school');
    if (r.duty_type === dt && r.exam_name) continue;
    const mins = Number(r.minutes) || 0;
    db.prepare(`UPDATE invigilations SET duty_type=?, peer_name=?, exam_name=?, start_time=?, end_time=?,
                duration_min=?, amount=?, pay_amount=?, room=? WHERE id=?`)
      .run(dt, dt === 'school' ? '' : String(r.person || ''), String(r.exam_name || ''),
           String(r.start_time || r.start_at || '').slice(11, 16),
           String(r.end_time || r.end_at || '').slice(11, 16), mins,
           Number(r.amount) || 0, Number(r.amount) || 0, String(r.room || r.place || ''), r.id);
  }
} catch { /* 首次启动无表时忽略 */ }

/* ========== 班级短链：点名场次 + 出勤记录 + 惩罚记录 ========== */
db.exec(`
CREATE TABLE IF NOT EXISTS roll_sessions(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  link_id INTEGER,
  roster_id INTEGER,
  grade TEXT DEFAULT '',
  class_name TEXT DEFAULT '',
  date TEXT NOT NULL,                 -- YYYY-MM-DD
  period_no INTEGER DEFAULT 0,        -- 第几节，0 表示未指定
  subject TEXT DEFAULT '',
  expect INTEGER DEFAULT 0,           -- 应到人数（开课时快照）
  status TEXT DEFAULT 'open',         -- open / closed
  note TEXT DEFAULT '',
  created_at TEXT, updated_at TEXT,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_roll_sessions_user ON roll_sessions(user_id, date);
CREATE UNIQUE INDEX IF NOT EXISTS uq_roll_sessions_slot
  ON roll_sessions(user_id, roster_id, date, period_no) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS roll_records(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  stu_key TEXT NOT NULL,              -- 归一化后的学号/姓名，用于去重
  stu_name TEXT DEFAULT '',
  stu_no TEXT DEFAULT '',
  status TEXT DEFAULT 'present',      -- present / late / leave / absent
  source TEXT DEFAULT 'student',      -- student（学生自己点）/ teacher（老师代标）
  ip TEXT DEFAULT '',
  created_at TEXT, updated_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_roll_records ON roll_records(session_id, stu_key);

CREATE TABLE IF NOT EXISTS punish_records(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  roster_id INTEGER,
  grade TEXT DEFAULT '',
  class_name TEXT DEFAULT '',
  stu_name TEXT DEFAULT '',
  text TEXT NOT NULL,                 -- 抽到的任务
  source TEXT DEFAULT 'student',      -- student / teacher
  date TEXT NOT NULL,
  note TEXT DEFAULT '',
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_punish_records_user ON punish_records(user_id, date);
`);

/* ========== 出差报销：明细行（一张票 / 一笔支出）========== */
db.exec(`
CREATE TABLE IF NOT EXISTS trip_items(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  trip_id INTEGER NOT NULL,
  kind TEXT DEFAULT 'other',      -- transport 交通 / hotel 住宿 / taxi 打车 / meal 餐饮 / toll 过路 / parking 停车 / other 其他
  date TEXT DEFAULT '',
  amount REAL DEFAULT 0,
  note TEXT DEFAULT '',
  invoice_no TEXT DEFAULT '',
  has_invoice INTEGER DEFAULT 1,  -- 1 有票 / 0 没票
  attach_id INTEGER,              -- 对应 attachments.id（这张票的图片）
  created_at TEXT, updated_at TEXT, deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_trip_items_trip ON trip_items(trip_id);
CREATE INDEX IF NOT EXISTS idx_trip_items_user ON trip_items(user_id);

/* 找回密码的取件码。
   一个手机号只留最新一条（phone 主键），旧码自动失效——避免「上次那个码还能用」
   造成的混乱，也省得清理。used_at 不为空表示已经用掉，不能再用第二次。 */
CREATE TABLE IF NOT EXISTS password_resets(
  phone TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  created_at INTEGER,      -- 生成时间（毫秒），用于 60 秒频率限制
  expires_at INTEGER,      -- 过期时间（毫秒），30 分钟
  used_at INTEGER,         -- 用掉的时间，空=还没用
  ip TEXT DEFAULT ''
);
`);

/* 出差的报销字段（老记录自动补默认值，不丢数据） */
ensureColumns('trips', {
  days: 'REAL',
  hotel: 'REAL DEFAULT 0',
  transport: 'REAL DEFAULT 0',
  taxi: 'REAL DEFAULT 0',
  subsidy_food: 'REAL DEFAULT 0',
  subsidy_local: 'REAL DEFAULT 0',
  advance: 'REAL DEFAULT 0',
  reimb_status: "TEXT DEFAULT 'draft'",   /* draft 草稿 / submitted 已提交 / paid 已到手 */
  paid_at: 'TEXT',
});

/* ========== 学习模块：计时器 ========== */
/* 计时不是纯前端走表：切到后台、锁屏、刷新页面都会让 JS 计时器失真。
   所以开始计时时先在 studies 落一条 source='running' 的草稿，
   之后按时回写 minutes，结束才转成正式记录。 */
ensureColumns('studies', {
  started_at: 'TEXT',            // 开始计时时间（ISO），手动填的为空
  end_at: 'TEXT',                // 结束计时时间（ISO）
  paused_ms: 'INTEGER DEFAULT 0', // 累计暂停时长，暂停/继续时累加
  paused_at: 'TEXT',             // 当前这次暂停的起点，null 表示正在计时
});

/* ========== 消息中心 ========== */
ensureColumns('messages', {
  link: "TEXT DEFAULT ''",       // 点消息跳转的 hash 路由，如 #/work/items
  dedupe_key: "TEXT DEFAULT ''", // 去重键，避免同一提醒反复灌消息
});
db.exec('CREATE INDEX IF NOT EXISTS idx_messages_user_unread ON messages(user_id, read)');

/* 计时草稿最多留一条：万一进程被杀留下孤儿 running，启动时收尾 */
try {
  const orphans = db.prepare("SELECT * FROM studies WHERE source='running' AND deleted_at IS NULL").all();
  const now = new Date().toISOString();
  for (const r of orphans) {
    const mins = Math.max(1, Math.round((Date.now() - Date.parse(r.started_at || now)) / 60000));
    db.prepare("UPDATE studies SET source='timer', minutes=?, end_at=?, updated_at=? WHERE id=?")
      .run(mins, now, now, r.id);
    console.log(`⏱  收尾孤儿计时草稿 #${r.id}，按 ${mins} 分钟记`);
  }
} catch { /* 首次启动无表 */ }

/* ========== 备课模块 ==========
   痛点不是「没有教案」，而是「记不清备到哪了」。
   所以每条记录必须能回答三个问题：给哪个班上（class_name）、备的是哪一课（topic）、
   备到哪一步了（progress + next_step）。
   和 lessons（实际上课记录）分开：备课发生在课前，一节课可能备两次，也可能一次备两节。 */
db.exec(`CREATE TABLE IF NOT EXISTS preps(
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  seq INTEGER,
  date TEXT,                    -- 备课日期 YYYY-MM-DD
  class_name TEXT DEFAULT '',   -- 给哪个班备的
  subject TEXT DEFAULT '',      -- 学科
  topic TEXT NOT NULL,          -- 课题，如《劝学》第三段
  progress TEXT DEFAULT '',     -- 备到哪了
  next_step TEXT DEFAULT '',    -- 下次接着备什么
  minutes INTEGER DEFAULT 0,    -- 花了多少分钟（选填）
  status TEXT DEFAULT 'doing',  -- doing 在备 / done 备好了
  lesson_id INTEGER,            -- 关联到哪节上课记录（选填）
  remark TEXT DEFAULT '',       -- 备注
  created_at TEXT, updated_at TEXT, deleted_at TEXT
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_preps_user ON preps(user_id, date)');

/* ---------- 自习（第 22 条） ----------
   老师看自习这件事一直在发生，但工作台里没有地方记：
   记进「上课」会被算成课时费（课时费只认真上课），记进「考勤」又不是上课。
   所以单独一张表，只记「哪个班、哪一节、看了多久、谁没来、做了什么」，
   默认不计课时费；只有显式打上计费标记时才进对账。 */
db.exec(`CREATE TABLE IF NOT EXISTS selfstudy(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  seq INTEGER,
  date TEXT,                       -- YYYY-MM-DD
  period_no INTEGER,               -- 第几节（选填）
  start_time TEXT DEFAULT '', end_time TEXT DEFAULT '',
  grade TEXT DEFAULT '', class_name TEXT DEFAULT '',
  subject TEXT DEFAULT '',         -- 看哪科的自习
  minutes INTEGER DEFAULT 0,
  content TEXT DEFAULT '',         -- 自习内容 / 做了哪些事
  absent TEXT DEFAULT '',          -- 缺勤的人
  billable INTEGER DEFAULT 0,      -- 是否计入课时费（默认不计）
  remark TEXT DEFAULT '',
  created_at TEXT, updated_at TEXT, deleted_at TEXT
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_selfstudy_user ON selfstudy(user_id, date)');

/* ---------- 维修（第 23 条） ----------
   教室的投影、网线、门锁、灯管坏了要报修，修完要留记录（谁报的、什么时候修的、花了多少钱）。
   以前全靠微信里喊一声，事后没人记得修没修。
   状态流转：pending 待处理 → doing 处理中 → done 已修好 / canceled 取消。 */
db.exec(`CREATE TABLE IF NOT EXISTS repairs(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  seq INTEGER,
  date TEXT,                       -- 报修日期
  place TEXT DEFAULT '',           -- 位置：如 高二(3)班教室
  item TEXT DEFAULT '',            -- 设备/物件：投影仪、门锁、灯管…
  fault TEXT NOT NULL,             -- 坏在哪、什么现象
  urgency TEXT DEFAULT 'normal',   -- low / normal / high
  status TEXT DEFAULT 'pending',   -- pending / doing / done / canceled
  reporter TEXT DEFAULT '',        -- 报修人
  handler TEXT DEFAULT '',         -- 维修人/单位
  cost REAL DEFAULT 0,             -- 费用
  expect_at TEXT DEFAULT '',       -- 期望完成时间
  fixed_at TEXT DEFAULT '',        -- 实际修好时间
  remark TEXT DEFAULT '',
  created_at TEXT, updated_at TEXT, deleted_at TEXT
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_repairs_user ON repairs(user_id, date)');
