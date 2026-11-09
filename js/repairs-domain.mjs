/* 维修记录表月份统计口径。旧记录缺少 follow_up 时默认视为“否”。 */
export function isRepairTracked(row) {
  const value = row?.follow_up;
  return value === true || value === 1 || value === '1'
    || ['true', 'yes', '是'].includes(String(value ?? '').trim().toLowerCase());
}

export function summarizeRepairs(rows, month) {
  const target = String(month || '');
  const monthRows = (Array.isArray(rows) ? rows : [])
    .filter((row) => String(row?.date || '').slice(0, 7) === target);
  const trackedRows = monthRows.filter(isRepairTracked);
  return {
    rows: monthRows,
    total: monthRows.length,
    fixed: monthRows.filter((row) => row.status === 'done').length,
    unfinished: monthRows.filter((row) => row.status !== 'done').length,
    tracked: trackedRows.length,
    reminders: trackedRows.map((row) => ({
      id: row.id,
      item: String(row.item || '未填写设备名称'),
      remark: String(row.remark || ''),
    })),
  };
}
