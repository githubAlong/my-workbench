/* 课表作息：导入课表时以原件「时间」列为唯一权威。
   纯逻辑，无 DOM / API 依赖，便于 node --test 直接跑。 */

/* 2026 年秋季信息课表（老师提供原件）逐行抄录：
   1–9 节、午休、晚一–晚四，共 14 行；不补早自习、不丢晚间节次。 */
export const AUTUMN_2026_SCHEDULE = [
  { period_no: 1, name: '第1节', start_time: '08:00', end_time: '08:40' },
  { period_no: 2, name: '第2节', start_time: '08:50', end_time: '09:30' },
  { period_no: 3, name: '第3节', start_time: '10:00', end_time: '10:40' },
  { period_no: 4, name: '第4节', start_time: '10:50', end_time: '11:30' },
  { period_no: 5, name: '第5节', start_time: '11:40', end_time: '12:20' },
  { period_no: 5.5, name: '午休', start_time: '12:20', end_time: '14:10' },
  { period_no: 6, name: '第6节', start_time: '14:10', end_time: '14:50' },
  { period_no: 7, name: '第7节', start_time: '15:20', end_time: '16:00' },
  { period_no: 8, name: '第8节', start_time: '16:15', end_time: '16:55' },
  { period_no: 9, name: '第9节', start_time: '17:05', end_time: '17:45' },
  { period_no: 10, name: '晚一', start_time: '18:25', end_time: '18:40' },
  { period_no: 11, name: '晚二', start_time: '19:30', end_time: '20:10' },
  { period_no: 12, name: '晚三', start_time: '20:20', end_time: '21:00' },
  { period_no: 13, name: '晚四', start_time: '21:10', end_time: '21:55' },
];

export function normalizeClock(value) {
  const match = String(value ?? '').trim().match(/^(\d{1,2})[:：](\d{1,2})$/);
  if (!match) return '';
  const hour = Number(match[1]), minute = Number(match[2]);
  if (hour > 23 || minute > 59) return '';
  return String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0');
}

function toMinutes(clock) {
  const [h, m] = clock.split(':').map(Number);
  return h * 60 + m;
}

export function cloneSchedule(schedule = AUTUMN_2026_SCHEDULE) {
  return schedule.map((row) => ({ ...row }));
}

/* 作息表 → 规范定义。编号取行上自带的 period_no（模板提供），
   不按名称或时间反推，避免旧数据错号被反复固化。 */
export function buildDefinitions(rows) {
  const source = Array.isArray(rows) ? rows : [];
  if (!source.length) throw new Error('作息时间不能为空');
  const seen = new Set();
  const defs = source.map((row, index) => {
    const name = String(row?.name ?? '').trim();
    const start_time = normalizeClock(row?.start_time);
    const end_time = normalizeClock(row?.end_time);
    if (!name) throw new Error(`第 ${index + 1} 行请填写节次名称`);
    if (!start_time || !end_time) throw new Error(`「${name}」的时间格式不对，请写成 08:00`);
    if (toMinutes(end_time) <= toMinutes(start_time)) throw new Error(`「${name}」的结束时间必须晚于开始时间`);
    const no = Number(row?.period_no);
    if (!Number.isFinite(no)) throw new Error(`「${name}」缺少有效的节次编号`);
    if (seen.has(no)) throw new Error(`节次编号 ${no} 重复，请检查`);
    seen.add(no);
    return { id: 'schedule-' + no, period_no: no, name, start_time, end_time, order: index };
  });
  return defs;
}

export function buildPeriodTimes(defs) {
  const out = {};
  for (const row of defs) {
    out[String(row.period_no)] = { start_time: row.start_time, end_time: row.end_time };
  }
  return out;
}

/* 全校共用一套：按「作息类型」存取，不再按年级拆 key。
   兼容历史上已保存的 type|grade / type|全部 数据。 */
export function resolveDefinitions(periodDefinitions, type, grade) {
  const defs = periodDefinitions || {};
  const direct = defs[String(type)];
  if (Array.isArray(direct) && direct.length) return direct;
  for (const key of [String(type) + '|' + String(grade ?? ''), String(type) + '|全部']) {
    if (Array.isArray(defs[key]) && defs[key].length) return defs[key];
  }
  return null;
}

/* 保存时清掉该类型下所有旧 key（含按年级拆开的），只留一套，避免视图分叉。 */
export function withScheduleDefinitions(periodDefinitions, type, defs) {
  const next = { ...(periodDefinitions || {}) };
  const base = String(type);
  const prefix = base + '|';
  for (const key of Object.keys(next)) {
    if (key === base || key.startsWith(prefix)) delete next[key];
  }
  next[base] = defs;
  return next;
}

/* 全量覆盖 periodTimes[type]：旧默认值（07:40-08:25 等）一条不留。 */
export function withScheduleTimes(periodTimes, type, defs) {
  return { ...(periodTimes || {}), [String(type)]: buildPeriodTimes(defs) };
}

/* 导入预览里的课程节次 → 本次作息定义。
   优先按名称，其次按预览里带的起止时间；找不到返回 null。 */
export function matchScheduleRow(defs, label, startTime, endTime) {
  const text = String(label ?? '').trim();
  let hit = defs.find((row) => row.name === text);
  if (hit) return hit;
  const digits = text.match(/(?:第\s*)?(\d{1,2})\s*节?/);
  if (digits) {
    hit = defs.find((row) => Number(row.period_no) === Number(digits[1]));
    if (hit) return hit;
  }
  const start = normalizeClock(startTime), end = normalizeClock(endTime);
  if (start && end) {
    hit = defs.find((row) => row.start_time === start && row.end_time === end);
    if (hit) return hit;
  }
  return null;
}
