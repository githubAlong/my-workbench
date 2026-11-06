import {
  ATTENDANCE_TYPE_SHORT,
  normalizeAttendanceType,
} from './attendance-domain.mjs';

export function attendanceExportGrid({ grade, date, type, columns = [], rows = [] }) {
  const normalizedType = normalizeAttendanceType(type) || 'seat';
  const safeColumns = Array.isArray(columns) ? columns : [];
  return [
    [`${grade || ''}${ATTENDANCE_TYPE_SHORT[normalizedType]} · ${date || ''}`],
    ['序号', '姓名', '学科', ...safeColumns.map((column) => column.label)],
    ...(Array.isArray(rows) ? rows : []).map((row, index) => [
      index + 1,
      row.teacher || '',
      row.subject || '',
      ...safeColumns.map((column) => {
        const value = row.data?.[column.key];
        if (column.type !== 'check') return String(value ?? '');
        return value === '1' ? '✓' : value === '0' ? '×' : '';
      }),
    ]),
  ];
}

export function attendanceExportFileName({ grade, date, type, extension = 'xlsx' }) {
  const normalizedType = normalizeAttendanceType(type) || 'seat';
  return `${grade || '年级'}${ATTENDANCE_TYPE_SHORT[normalizedType]}_${date || ''}.${extension}`;
}

export function resolveWatermarkText(setting, { grade = '', date = '', name = '' } = {}) {
  if (!setting?.on) return '';
  const template = String(setting.text || '{grade} {date}').trim();
  return template
    .replaceAll('{grade}', String(grade))
    .replaceAll('{date}', String(date))
    .replaceAll('{name}', String(name));
}

export function recentMonthKeys(endDate = new Date(), count = 12) {
  const monthCount = Math.max(1, Math.trunc(Number(count) || 12));
  const year = endDate.getFullYear();
  const month = endDate.getMonth();
  return Array.from({ length: monthCount }, (_, index) => {
    const date = new Date(year, month - monthCount + 1 + index, 1);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  });
}
