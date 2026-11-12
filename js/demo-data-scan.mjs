/* ==========================================================================
   识别「系统首次启动自动灌入的示例数据」（localapi.js 的 seedIfEmpty）。

   为什么能可靠区分示例数据和用户自己录的数据：
     1. seedIfEmpty 在函数开头取一次 now，整批几百条记录共用同一个 created_at；
        用户后来一条一条录入的记录，时间戳必然更晚、且不会恰好凑成几百条同刻。
     2. 用户如果改过某条示例记录，updateRow 会刷新 updated_at；
        这类「已被用户接管」的记录必须保留，不能按批次误删。
     3. 只有满足「≥20 条 / ≥3 张表 / 含 periods 或 courses」的批次才认作示例，
        避免把用户批量导入的一批真实数据误判成示例。

   本模块是纯函数，不碰 DOM、不碰 localStorage，方便直接单测。
   ========================================================================== */

export const TABLE_LABELS = {
  periods: '节次设置',
  courses: '课表课程',
  class_records: '上课记录',
  invigilations: '监考记录',
  trips: '出差报销',
  materials: '课件资料',
  notes: '笔记',
  preps: '备课',
  categories: '分类',
  homework: '作业',
  studies: '学习记录',
  students: '学生名单',
  rosters: '班级名册',
  punishments: '奖惩条目',
  exceptions: '调课例外',
  selfstudy: '自习记录',
  repairs: '报修记录',
  items: '今日事项',
  todos: '便签待办',
  reminders: '提醒',
  messages: '消息',
  links: '搬家链接',
  attendance_tables: '考勤表',
  students_att: '考勤明细',
  teachers: '教师名册',
  invig_rules: '监考计费规则',
  trip_rules: '出差规则',
  punish_records: '奖惩记录',
  homework_records: '作业记录',
  attachments: '附件',
};

/* 真实名册 / 规则配置 / 搬家链接：即使在示例批次里也绝不删。
   teachers 里装的是老师提供的四张纸表人名，删了等于丢真实数据。 */
export const PROTECTED_TABLES = new Set([
  'teachers', 'invig_rules', 'trip_rules', 'links', 'messages', 'reminders',
]);

const MIN_BATCH_ROWS = 20;
const MIN_BATCH_TABLES = 3;

function stampOf(row) {
  const raw = row && row.created_at;
  if (typeof raw !== 'string' || !raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

/* 只看「创建时间属于该批次、且从未被修改」的原始示例记录 */
function isUntouchedSeed(row, stamp) {
  if (stampOf(row) !== stamp) return false;
  const u = row.updated_at;
  if (u === undefined || u === null || u === '') return true;
  const ums = Date.parse(String(u));
  if (!Number.isFinite(ums)) return false; // 看不懂的修改时间，保守保留
  return ums === stamp;
}

function scanTables(db) {
  return Object.keys(db).filter(
    (key) => key !== 'meta' && key !== 'seqs' && Array.isArray(db[key]) && !PROTECTED_TABLES.has(key)
  );
}

/* 找出示例批次的时间戳；找不到返回 null */
export function findSeedBatch(db) {
  if (!db || typeof db !== 'object') return null;
  const buckets = new Map();
  for (const table of scanTables(db)) {
    for (const row of db[table]) {
      const stamp = stampOf(row);
      if (stamp === null) continue;
      let bucket = buckets.get(stamp);
      if (!bucket) {
        bucket = { stamp, rows: 0, tables: new Set() };
        buckets.set(stamp, bucket);
      }
      bucket.rows += 1;
      bucket.tables.add(table);
    }
  }
  let best = null;
  for (const bucket of buckets.values()) {
    if (bucket.rows < MIN_BATCH_ROWS || bucket.tables.size < MIN_BATCH_TABLES) continue;
    if (!bucket.tables.has('periods') && !bucket.tables.has('courses')) continue;
    if (!best || bucket.rows > best.rows) best = bucket;
  }
  return best ? { stamp: best.stamp, rows: best.rows, tables: [...best.tables] } : null;
}

/* 预览用：每张表将删多少条、有多少条因被改过而保留 */
export function scanDemoData(db) {
  const batch = findSeedBatch(db);
  if (!batch) return { found: false, stamp: null, groups: [], total: 0, modified: 0 };
  const groups = [];
  let total = 0;
  let modified = 0;
  for (const table of scanTables(db)) {
    const same = db[table].filter((row) => stampOf(row) === batch.stamp);
    if (!same.length) continue;
    const remove = same.filter((row) => isUntouchedSeed(row, batch.stamp)).length;
    const keep = same.length - remove;
    total += remove;
    modified += keep;
    groups.push({ table, label: TABLE_LABELS[table] || table, remove, keep });
  }
  return { found: total > 0, stamp: batch.stamp, groups, total, modified };
}

/* 执行用：按对象引用收集待删记录，避免 filter 时靠字段二次推测 */
export function collectRemovable(db, stamp) {
  const out = new Map();
  for (const table of scanTables(db)) {
    const rows = new Set(db[table].filter((row) => isUntouchedSeed(row, stamp)));
    if (rows.size) out.set(table, rows);
  }
  return out;
}
