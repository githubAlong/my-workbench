const REPAIR_STATUS_ALIASES = new Map([
  ['pending','pending'],['待处理','pending'],['待维修','pending'],
  ['doing','doing'],['处理中','doing'],['维修中','doing'],['正在维修','doing'],
  ['done','done'],['已修好','done'],['已修复','done'],['修好了','done'],['已完成','done'],['修复完成','done'],['完成','done'],
  ['canceled','canceled'],['cancelled','canceled'],['已取消','canceled'],['取消','canceled'],
]);
const REPAIR_STATUS_LABELS = {pending:'待处理',doing:'处理中',done:'已修好',canceled:'已取消'};
export function normalizeRepairStatus(value) {
  const raw=String(value??'').trim();
  if(!raw)return 'pending';
  return REPAIR_STATUS_ALIASES.get(raw.toLowerCase())||raw;
}
export function repairStatusInputValue(value) {
  const raw=String(value??'').trim();
  if(!raw)return REPAIR_STATUS_LABELS.pending;
  const normalized=normalizeRepairStatus(raw);
  return REPAIR_STATUS_LABELS[normalized]||raw;
}
export function isRepairFixed(row) {
  return normalizeRepairStatus(row?.status)==='done';
}
export function repairStatusForSave(value, fixed) {
  if (fixed) return 'done';
  const status = normalizeRepairStatus(value);
  return status === 'done' ? 'pending' : status;
}
export function isRepairTracked(row) {
  const value=row?.follow_up;
  return value===true||value===1||value==='1'||['true','yes','是'].includes(String(value??'').trim().toLowerCase());
}
export function summarizeRepairs(rows,month) {
  const target=String(month||'');
  const monthRows=(Array.isArray(rows)?rows:[]).filter(row=>String(row?.date||'').slice(0,7)===target);
  const trackedRows=monthRows.filter(isRepairTracked);
  return {
    rows:monthRows,total:monthRows.length,
    fixed:monthRows.filter(isRepairFixed).length,
    unfinished:monthRows.filter(row=>!isRepairFixed(row)).length,
    tracked:trackedRows.length,
    reminders:trackedRows.map(row=>({id:row.id,item:String(row.item||'未填写设备名称'),remark:String(row.remark||'')})),
  };
}
