/* 课表节次数据归一化：只整理前端读取结果，不写回或删除数据库记录。 */
function parsePeriodLabel(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (/早自习|早读/.test(text)) return 0;
  if (/午休|午间休息/.test(text)) return 5.5;

  const evening = [
    ['晚自习一', 10], ['晚自习二', 11], ['晚自习三', 12], ['晚自习四', 13],
    ['晚一', 10], ['晚二', 11], ['晚三', 12], ['晚四', 13],
  ];
  for (const [label, number] of evening) if (text.startsWith(label)) return number;

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

export function getCanonicalPeriodNumber(record) {
  if (record == null) return null;
  const isObject = typeof record === 'object';
  const raw = isObject ? record.period_no : record;
  const name = isObject ? String(record.name || record.period_name || record.label || '').trim() : '';

  if (/早自习|早读/.test(name)) return 0;
  if (/午休|午间休息/.test(name)) return 5.5;

  if (raw !== null && raw !== undefined && String(raw).trim() !== '') {
    const numeric = Number(raw);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
    const parsedRaw = parsePeriodLabel(raw);
    if (parsedRaw != null && parsedRaw > 0) return parsedRaw;
  }
  return parsePeriodLabel(name);
}

export function cleanPeriodTime(value) {
  const match = String(value ?? '').trim().match(/^(\d{1,2})[:：](\d{2})$/);
  if (!match) return '';
  const hour = Number(match[1]), minute = Number(match[2]);
  if (hour > 23 || minute > 59 || (hour === 0 && minute === 0)) return '';
  return String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0');
}

function normalizedPeriodName(period, number) {
  const name = String(period?.name || period?.period_name || '').trim();
  if (!name) return number === 0 ? '早自习' : number === 5.5 ? '午休' : '第' + number + '节';
  if (/午休|午间休息/.test(name)) return '午休';
  if (/早自习|早读/.test(name)) return name;
  if (/晚(?:自习)?[一二三四]/.test(name)) return name;
  if (/^(?:第?\s*[一二三四五六七八九十\d]+\s*节|[一二三四五六七八九十\d]+)$/.test(name)) {
    return '第' + number + '节';
  }
  return name;
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
  const name = genericName(primaryName) && !genericName(secondaryName) ? secondaryName : primaryName;
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

export function normalizeTimetablePeriods(periods) {
  const byNumber = new Map();
  for (const source of Array.isArray(periods) ? periods : []) {
    const number = getCanonicalPeriodNumber(source);
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
