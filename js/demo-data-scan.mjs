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
  if (stamp === null || stamp === undefined) return false;
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

/* 有些示例记录的时间戳已经对不上批次（被页面重新保存过、或批次只剩零星几条），
   只靠时间戳会漏掉，清理入口干脆不出现。这里按「示例原文」逐字段精确匹配，
   学习记录的标题、内容、时长、来源必须和种子一模一样才算示例，用户自己写的不会命中。 */
const SEED_STUDY_TITLES = new Set(['《红楼梦》整本书阅读指导', '读《语文学习任务设计》']);
const SEED_STUDY_MINUTES = new Set([30, 45, 60, 75]);

function isSeedStudy(row) {
  if (!row || typeof row !== 'object' || row.deleted_at) return false;
  if (!SEED_STUDY_TITLES.has(String(row.title || '').trim())) return false;
  if (String(row.content || '').trim() !== '记录要点若干') return false;
  if (String(row.source || '').trim()) return false;
  if (String(row.tags || '').trim()) return false;
  return SEED_STUDY_MINUTES.has(Number(row.minutes));
}

/* 示例事项 / 便签：消息中心里的「任务提醒」就是它们投影出来的。
   按「标题 + 正文」逐字段比对：改过标题或正文的记录视为用户已接管，保留；
   只改了状态（在消息中心点「待完成 / 进行中 / 已完成」）仍然算示例，
   连它生成的提醒一起清掉，否则刷新后消息中心又会长回来。 */
const SEED_TASK_ROWS = {
  '高二语文备课组会': '讨论下周《劝学》教学进度',
  '提交十月课时统计表': '月底与财务核对课时',
  '期中考试命题截止': '完成试卷与答题卡',
  '把月考答题卡交到教务处': '',
  '给(3)班准备《劝学》课件': '',
  '联系家长沟通作业情况': '',
};

/* items 的正文叫 detail，todos 的正文叫 content；两边都按同一张示例表比对 */
function isSeedTaskRow(row) {
  if (!row || typeof row !== 'object' || row.deleted_at) return false;
  const title = String(row.title || '').trim();
  if (!Object.prototype.hasOwnProperty.call(SEED_TASK_ROWS, title)) return false;
  const body = row.detail !== undefined ? row.detail : row.content;
  return String(body || '').trim() === SEED_TASK_ROWS[title];
}

function collectBySignature(db) {
  const out = new Map();
  if (!db || typeof db !== 'object') return out;
  const studies = Array.isArray(db.studies) ? db.studies.filter(isSeedStudy) : [];
  if (studies.length) out.set('studies', new Set(studies));
  for (const table of ['items', 'todos']) {
    const rows = Array.isArray(db[table]) ? db[table].filter(isSeedTaskRow) : [];
    if (rows.length) out.set(table, new Set(rows));
  }
  return out;
}

/* 示例事项 / 便签的 id 集合：既认批次时间戳，也认示例原文。
   时间戳认「同批创建」，所以只改过状态的记录也跑不掉；原文认「批次时间戳已丢失」的情况。 */
function demoSourceIds(db, stamp, signature) {
  const ids = { items: new Set(), todos: new Set() };
  for (const table of ['items', 'todos']) {
    const rows = Array.isArray(db[table]) ? db[table] : [];
    for (const row of rows) if (stamp !== null && stampOf(row) === stamp) ids[table].add(String(row.id));
    for (const row of signature.get(table) || []) ids[table].add(String(row.id));
  }
  return ids;
}

/* 消息中心里由示例事项 / 便签生成的任务提醒。
   这些消息不是示例批次的一部分（created_at 是生成提醒的时间），
   只能顺着 ref_type / ref_id 找回来源，再判断来源是不是示例数据。 */
export function collectDemoMessages(db, stamp) {
  if (!db || typeof db !== 'object') return [];
  const ids = demoSourceIds(db, stamp, collectBySignature(db));
  return (Array.isArray(db.messages) ? db.messages : []).filter((row) => row
    && typeof row === 'object'
    && !row.deleted_at
    && row.type === 'task'
    && ((row.ref_type === 'items' && ids.items.has(String(row.ref_id)))
      || (row.ref_type === 'todos' && ids.todos.has(String(row.ref_id)))));
}

/* 预览用：每张表将删多少条、有多少条因被改过而保留 */
export function scanDemoData(db) {
  const batch = findSeedBatch(db);
  const stamp = batch ? batch.stamp : null;
  const signature = collectBySignature(db);
  const groups = [];
  let total = 0;
  let modified = 0;
  const tables = new Set([...scanTables(db), ...signature.keys()]);
  for (const table of tables) {
    const rows = Array.isArray(db[table]) ? db[table] : [];
    const same = stamp === null ? [] : rows.filter((row) => stampOf(row) === stamp);
    const untouched = same.filter((row) => isUntouchedSeed(row, stamp));
    const removable = new Set([...untouched, ...(signature.get(table) || [])]);
    /* 「改过·保留」只算最终不会被删的那些，否则只改过状态的示例事项
       会同时出现在「将删除」和「改过·保留」两列里。 */
    const keep = same.filter((row) => !removable.has(row)).length;
    if (!removable.size && !keep) continue;
    total += removable.size;
    modified += keep;
    groups.push({ table, label: TABLE_LABELS[table] || table, remove: removable.size, keep });
  }
  /* 消息中心的任务提醒不是批次记录，按来源单独统计 */
  const demoMessages = collectDemoMessages(db, stamp).length;
  if (demoMessages) {
    groups.push({ table: 'messages', label: TABLE_LABELS.messages, remove: demoMessages, keep: 0 });
    total += demoMessages;
  }
  return { found: total > 0, stamp, groups, total, modified };
}

/* 执行用：按对象引用收集待删记录，避免 filter 时靠字段二次推测 */
export function collectRemovable(db, stamp) {
  const out = new Map();
  const signature = collectBySignature(db);
  for (const table of scanTables(db)) {
    const rows = new Set((Array.isArray(db[table]) ? db[table] : []).filter((row) => isUntouchedSeed(row, stamp)));
    for (const row of signature.get(table) || []) rows.add(row);
    if (rows.size) out.set(table, rows);
  }
  for (const [table, rows] of signature) {
    if (rows.size && !out.has(table)) out.set(table, rows);
  }
  return out;
}
