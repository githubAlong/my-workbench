/* 课表节次归一化：统一 1–9 节与晚自习，不修改或删除原始课程记录。 */
function parsePeriodLabel(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (/早自习|早读/.test(text)) return 0;
  if (/午休|午间休息/.test(text)) return 5.5;
  if (/晚四/.test(text)) return 13;
  if (/晚三/.test(text)) return 12;
  if (/晚二/.test(text)) return 11;
  if (/晚一|晚自习/.test(text)) return 10;

  const numericOnly = text.match(/^\s*(\d+(?:\.\d+)?)\s*$/);
  if (numericOnly) {
    const number = Number(numericOnly[1]);
    return number > 0 ? number : null;
  }

  const digits = text.match(/(?:第\s*)?(\d{1,2})\s*节/) || text.match(/(\d{1,2})/);
  if (digits) {
    const number = Number(digits[1]);
    return number > 0 ? number : null;
  }

  const chinese = text.match(/第?\s*(十|[一二三四五六七八九])\s*节?/);
  if (!chinese) return null;
  const map = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  return map[chinese[1]] || null;
}

export function cleanPeriodTime(value) {
  const match = String(value ?? '').trim().match(/^(\d{1,2})[:：](\d{2})$/);
  if (!match) return '';
  const hour = Number(match[1]), minute = Number(match[2]);
  if (hour > 23 || minute > 59 || (hour === 0 && minute === 0)) return '';
  return String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0');
}

function canonicalNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  if (number >= 10 && number <= 15) return number;
  return number;
}

function periodNumberFromTime(record, options = {}) {
  const start = cleanPeriodTime(record?.start_time);
  const end = cleanPeriodTime(record?.end_time);
  if (!start || !end) return null;

  const configured = options.periodTimes?.[options.scheduleType] || {};
  for (const [key, value] of Object.entries(configured)) {
    if (cleanPeriodTime(value?.start_time) === start && cleanPeriodTime(value?.end_time) === end) {
      return canonicalNumber(key);
    }
  }

  const known = [
    ['08:00', '08:40', 1], ['08:00', '08:45', 1],
    ['08:50', '09:30', 2], ['08:55', '09:40', 2],
    ['09:50', '10:35', 3], ['10:00', '10:40', 3],
    ['10:50', '11:30', 4], ['10:55', '11:40', 4],
    ['11:40', '12:20', 5], ['14:10', '14:55', 5],
    ['14:10', '14:50', 6], ['15:05', '15:50', 6],
    ['15:20', '16:00', 7], ['16:00', '16:45', 7],
    ['16:15', '16:55', 8], ['16:55', '17:40', 8],
    ['17:05', '17:45', 9], ['17:50', '18:35', 9],
    ['19:00', '19:45', 10], ['19:30', '20:10', 10],
    ['20:20', '21:00', 10], ['21:10', '21:55', 10],
  ];
  const match = known.find(([from, to]) => from === start && to === end);
  return match ? match[2] : null;
}

function isGenericPeriodName(value) {
  return /^(?:第?\s*[一二三四五六七八九十\d]+\s*节|[一二三四五六七八九十\d]+)$/.test(String(value || '').trim());
}

export function getCanonicalPeriodNumber(record, options = {}) {
  if (record == null) return null;
  const isObject = typeof record === 'object';
  const raw = isObject ? record.period_no : record;
  const name = isObject ? String(record.name || record.period_name || record.label || '').trim() : '';

  if (/早自习|早读/.test(name)) return 0;
  if (/午休|午间休息/.test(name)) return 5.5;
  if (/晚四/.test(name)) return 13;
  if (/晚三/.test(name)) return 12;
  if (/晚二/.test(name)) return 11;
  if (/晚一|晚自习/.test(name)) return 10;

  /* 时间是更可靠的纠错依据：旧数据可能把第一节误存成第10节。 */
  const byTime = isObject ? periodNumberFromTime(record, options) : null;
  if (byTime != null) return byTime;

  const byName = parsePeriodLabel(name);
  if (byName != null && byName >= 1 && byName <= 9) return byName;

  const byRaw = parsePeriodLabel(raw);
  if (byRaw != null) {
    if (byRaw >= 10 && byRaw <= 15) return byRaw;
    if (byRaw >= 1 && byRaw <= 9) return byRaw;
    if (byRaw === 0 || byRaw === 5.5) return byRaw;
    if (byRaw > 15 && isObject && !isGenericPeriodName(name) &&
        cleanPeriodTime(record.start_time) && cleanPeriodTime(record.end_time)) return byRaw;
    return null;
  }
  if (byName != null) return byName >= 10 ? 10 : byName;
  return null;
}

function normalizedPeriodName(period, number) {
  const name = String(period?.name || period?.period_name || '').trim();
  const chinese = ['', '第1节', '第2节', '第3节', '第4节', '第5节', '第6节', '第7节', '第8节', '第9节'];
  if (number === 0) return '早自习';
  if (number === 5.5) return '午休';
  if (number === 10) return '晚一';
  if (number === 11) return '晚二';
  if (number === 12) return '晚三';
  if (number === 13) return '晚四';
  if (number >= 1 && number <= 9) return chinese[number];
  if (name && !isGenericPeriodName(name)) return name;
  return number == null ? name : '第' + number + '节';
}

function periodQuality(period) {
  const start = cleanPeriodTime(period.start_time);
  const end = cleanPeriodTime(period.end_time);
  const timeScore = start && end ? 100 : start || end ? 10 : 0;
  const numericNo = Number(period.period_no);
  const numberScore = Number.isFinite(numericNo) && numericNo > 0 ? 5 : 0;
  const idScore = period.id != null && period.id !== '' ? 1 : 0;
  return timeScore + numberScore + idScore;
}

function mergePeriodRows(first, second, number) {
  const firstScore = periodQuality(first);
  const secondScore = periodQuality(second);
  const firstTime = Date.parse(first.updated_at || first.created_at || '') || 0;
  const secondTime = Date.parse(second.updated_at || second.created_at || '') || 0;
  const primary = secondScore > firstScore || (secondScore === firstScore && secondTime > firstTime) ? second : first;
  const secondary = primary === first ? second : first;
  const primaryName = normalizedPeriodName(primary, number);
  const secondaryName = normalizedPeriodName(secondary, number);
  const genericName = (value) => /^第\d+(?:\.\d+)?节$/.test(value);
  const name = number === 10 ? '晚一'
    : genericName(primaryName) && !genericName(secondaryName) ? secondaryName : primaryName;
  const starts = [cleanPeriodTime(first.start_time), cleanPeriodTime(second.start_time)].filter(Boolean).sort();
  const ends = [cleanPeriodTime(first.end_time), cleanPeriodTime(second.end_time)].filter(Boolean).sort();
  return {
    ...secondary,
    ...primary,
    id: primary.id ?? secondary.id,
    period_no: number,
    name: name || secondaryName,
    start_time: cleanPeriodTime(primary.start_time) || cleanPeriodTime(secondary.start_time),
    end_time: cleanPeriodTime(primary.end_time) || cleanPeriodTime(secondary.end_time),
  };
}

export function normalizeTimetablePeriods(periods, options = {}) {
  const byNumber = new Map();
  for (const source of Array.isArray(periods) ? periods : []) {
    const number = getCanonicalPeriodNumber(source, options);
    if (number == null) continue;
    const period = {
      ...source,
      period_no: number,
      name: normalizedPeriodName(source, number),
      start_time: cleanPeriodTime(source.start_time),
      end_time: cleanPeriodTime(source.end_time),
    };
    const existing = byNumber.get(number);
    byNumber.set(number, existing ? mergePeriodRows(existing, period, number) : period);
  }
  return [...byNumber.values()].sort((a, b) => Number(a.period_no) - Number(b.period_no));
}
