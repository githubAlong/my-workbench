export const PREP_UNCLASSIFIED = 'unclassified';

export const PREP_TYPE_OPTIONS = Object.freeze([
  Object.freeze({ value: 'information', label: '信息课备课' }),
  Object.freeze({ value: 'specialty', label: '特色课备课' }),
]);

const PREP_TYPE_VALUES = new Set(PREP_TYPE_OPTIONS.map((item) => item.value));

export function isPrepType(value) {
  const type = String(value ?? '').trim();
  return !!type && type !== PREP_UNCLASSIFIED && type.length <= 80;
}

/* 老记录没有 prep_type，或类型值不在当前选项内时，统一视为待分类。 */
export function normalizePrepType(value) {
  const raw = typeof value === 'string' ? value : value?.prep_type;
  const type = String(raw ?? '').trim();
  const known = PREP_TYPE_OPTIONS.find(item => item.label === type);
  return known?.value || (isPrepType(type) ? type : PREP_UNCLASSIFIED);
}

export function prepTypeLabel(value) {
  const type = normalizePrepType(value);
  if (type === PREP_UNCLASSIFIED) return '待分类';
  return PREP_TYPE_OPTIONS.find((item) => item.value === type)?.label || type;
}

export function filterPrepRecords(records, {
  type = '',
  className = '',
  status = '',
  keyword = '',
} = {}) {
  let result = Array.isArray(records) ? [...records] : [];

  if (type) result = result.filter((record) => normalizePrepType(record?.prep_type) === type);
  if (className) result = result.filter((record) => String(record?.class_name || '').trim() === className);
  if (status) {
    result = result.filter((record) => ((record?.status || 'doing') === 'done') === (status === 'done'));
  }
  if (keyword) {
    const query = String(keyword).trim().toLocaleLowerCase();
    if (query) {
      result = result.filter((record) => [
        record?.topic,
        record?.content,
        record?.progress,
        record?.next_step,
        record?.class_name,
        record?.subject,
        record?.remark,
      ].some((value) => String(value || '').toLocaleLowerCase().includes(query)));
    }
  }

  return result;
}

/* 新建记录必须选择两种正式类型之一；旧记录编辑时允许暂时保留「待分类」。 */
export function validatePrepRecord(payload, { isNew = false } = {}) {
  if (isNew && !isPrepType(payload?.prep_type)) return '请选择备课类型';
  if (!String(payload?.topic || '').trim()) return '请填「备的是哪一课」';
  return '';
}


/* 备课记录：完整内容放入现有 preps.content，不新增数据库列。 */
export const LESSON_PLAN_CONTENT_PREFIX = 'WB_LESSON_PLAN_V1\n';
export const LESSON_PLAN_CONTENT_FIELDS = Object.freeze([
  'grade', 'target', 'keyPoint', 'hardPoint', 'prepare', 'process',
  'blackboard', 'homeMust', 'homeExtra', 'reflect',
]);

export function encodeLessonPlanContent(fields = {}) {
  const payload = { version: 1 };
  for (const key of LESSON_PLAN_CONTENT_FIELDS) payload[key] = String(fields[key] ?? '');
  return LESSON_PLAN_CONTENT_PREFIX + JSON.stringify(payload);
}

export function decodeLessonPlanContent(record = {}) {
  const raw = String(record?.content ?? '');
  if (raw.startsWith(LESSON_PLAN_CONTENT_PREFIX)) {
    try {
      const payload = JSON.parse(raw.slice(LESSON_PLAN_CONTENT_PREFIX.length));
      const result = {};
      for (const key of LESSON_PLAN_CONTENT_FIELDS) {
        result[key] = String(payload[key] ?? (key === 'grade' ? record?.class_name : '') ?? '');
      }
      return result;
    } catch { /* 非法新格式回退为旧版纯文本 */ }
  }
  return {
    grade: String(record?.class_name || ''),
    target: '', keyPoint: '', hardPoint: '', prepare: '',
    process: raw, blackboard: '', homeMust: '', homeExtra: '', reflect: '',
  };
}
