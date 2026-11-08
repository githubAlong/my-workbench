export const DEFAULT_PERIODS = [
  { no: 1, label: '第1节', start: '08:00', end: '08:45' },
  { no: 2, label: '第2节', start: '08:55', end: '09:40' },
  { no: 3, label: '第3节', start: '10:00', end: '10:45' },
  { no: 4, label: '第4节', start: '10:55', end: '11:40' },
  { no: 5, label: '第5节', start: '14:20', end: '15:05' },
  { no: 6, label: '第6节', start: '15:15', end: '16:00' },
  { no: 7, label: '第7节', start: '16:10', end: '16:55' },
  { no: 8, label: '第8节', start: '17:05', end: '17:50' },
  { no: 9, label: '第9节', start: '18:30', end: '19:15' },
];

export const LEAVE_TYPES = ['事假', '病假', '婚假', '丧假', '产假', '公假', '调休', '公出'];

export const ATTENDANCE_COLUMNS = {
  roster: ['序号', '归属部门', '归属年级', '姓名', '学科', '上课', '坐班', '听课', '教研', '请假', '备注', '操作'],
  seat: ['序号', '姓名', '学科', '年级/部门', '坐班', '请假', '听课', '备注'],
  class: ['序号', '班级', '节次', '任课教师', '学科', '上课', '听课教师', '备注'],
  research: ['学科', '节次(时间)', '地点', '主持人', '应到人数', '实到人数', '未到名单', '状态'],
  leave: ['姓名', '学科', '类型', '开始', '结束', '天数', '状态', '备注'],
  summary: ['序号', '姓名', '学科', '坐班（在/应到）', '上课节次', '听课次数', '教研（已到/—）', '请假天数', '综合状态'],
};

export function nextTriState(value) {
  return value === 'y' ? 'n' : 'y';
}

export function leaveCoversDate(leave, date) {
  const start = String(leave?.start_date || leave?.from || '');
  const end = String(leave?.end_date || leave?.to || start);
  return !!start && !!date && start <= date && end >= date;
}

export function activeLeavesFor(leaveRecords, date, grade) {
  return (Array.isArray(leaveRecords) ? leaveRecords : []).filter((item) =>
    (!grade || String(item.grade || '') === String(grade))
    && leaveCoversDate(item, date)
    && item.status !== '已撤销'
  );
}

function rowData(row) {
  return row?.data && typeof row.data === 'object' ? row.data : {};
}

function periodRecord(row, period) {
  const data = rowData(row);
  const periods = data.__periods && typeof data.__periods === 'object' ? data.__periods : {};
  return periods[String(period)] || periods['第' + period + '节'] || {};
}

export function deriveRosterState(teacher, {
  seatRows = [],
  classRows = [],
  researchRows = [],
  leaveRecords = [],
  date = '',
  period = 1,
} = {}) {
  const name = String(teacher?.name || '').trim();
  const seatRow = seatRows.find((row) => String(row.teacher || '').trim() === name);
  const selectedSeat = periodRecord(seatRow, period);
  const seatRecords = Array.from({ length: 9 }, (_, index) => periodRecord(seatRow, index + 1));
  const classRecords = classRows.filter((row) => {
    const d = rowData(row);
    return !d.__deleted && String(row.teacher || '').trim() === name;
  });
  const researchRecords = researchRows.filter((row) => {
    const d = rowData(row).__research || {};
    return Array.isArray(d.attendees) && d.attendees.includes(name);
  });
  const leaves = (Array.isArray(leaveRecords) ? leaveRecords : []).filter((item) =>
    String(item.name || item.teacher || '').trim() === name && leaveCoversDate(item, date)
  );
  const classStatus = classRecords.some((row) => (rowData(row).__classRecord || {}).status === 'y') ? 'y'
    : classRecords.some((row) => (rowData(row).__classRecord || {}).status === 'n') ? 'n' : 'n';
  const seatStatus = seatRecords.some((record) => record.status === 'y') ? 'y'
    : seatRecords.some((record) => record.status === 'n') ? 'n'
      : selectedSeat.status || 'n';
  const listensFromSeat = seatRecords.some((record) => !!String(record.listen_class || '').trim());
  const listensFromClass = classRows.some((row) => {
    const d = rowData(row);
    return !d.__deleted && Array.isArray(d.__classRecord?.listeners) && d.__classRecord.listeners.includes(name);
  });
  return {
    class: classStatus,
    sit: seatStatus,
    listen: listensFromSeat || listensFromClass || !!selectedSeat.listen_class,
    research: researchRecords.length > 0,
    leave: leaves[0]?.type || '',
    leaveRecords: leaves,
    seatRecord: selectedSeat,
  };
}

export function calculateDailySummary({
  teachers = [],
  seatRows = [],
  classRows = [],
  researchRows = [],
  leaveRecords = [],
  date = '',
} = {}) {
  const people = (teachers || []).filter((teacher) => teacher && teacher.active !== false && Number(teacher.active ?? 1) !== 0);
  const activeLeaves = activeLeavesFor(leaveRecords, date);
  const rows = people.map((teacher, index) => {
    const name = String(teacher.name || '').trim();
    const seatRow = seatRows.find((row) => String(row.teacher || '').trim() === name);
    const seatPeriods = Array.from({ length: 9 }, (_, i) => periodRecord(seatRow, i + 1));
    const registeredSeat = seatPeriods.filter((record) => record.status === 'y' || record.status === 'n');
    const seatPresent = registeredSeat.filter((record) => record.status === 'y').length;
    const assignedClasses = classRows.filter((row) => {
      const data = rowData(row);
      return !data.__deleted && String(row.teacher || '').trim() === name;
    });
    const taught = assignedClasses.filter((row) => (rowData(row).__classRecord || {}).status === 'y').length;
    const listenedFromSeat = seatPeriods.filter((record) => !!String(record.listen_class || '').trim()).length;
    const listenedFromClass = classRows.filter((row) => {
      const data = rowData(row);
      return !data.__deleted && Array.isArray(data.__classRecord?.listeners) && data.__classRecord.listeners.includes(name);
    }).length;
    const researchCount = researchRows.filter((row) => {
      const research = rowData(row).__research || {};
      return Array.isArray(research.attendees) && research.attendees.includes(name);
    }).length;
    const leaves = activeLeaves.filter((item) => String(item.name || item.teacher || '').trim() === name);
    const leaveDays = leaves.reduce((sum, item) => sum + (Number(item.days) || 0), 0);
    const hasClassAbsence = assignedClasses.some((row) => (rowData(row).__classRecord || {}).status === 'n');
    const hasSeatAbsence = registeredSeat.some((record) => record.status === 'n');
    const overall = leaves.length ? '请假' : hasClassAbsence ? '空堂待核实'
      : hasSeatAbsence ? '未坐班' : registeredSeat.length ? '正常' : '未登记';
    return {
      serial: index + 1,
      name,
      subject: teacher.subject || '',
      seatPresent,
      seatExpected: registeredSeat.length,
      classes: taught,
      listens: listenedFromSeat + listenedFromClass,
      research: researchCount ? '已到' : '—',
      leaveDays,
      overall,
      note: teacher.remark || teacher.note || '',
    };
  });
  const seatPresent = rows.reduce((sum, row) => sum + row.seatPresent, 0);
  const seatExpected = rows.reduce((sum, row) => sum + row.seatExpected, 0);
  const classes = rows.reduce((sum, row) => sum + row.classes, 0);
  const listens = rows.reduce((sum, row) => sum + row.listens, 0);
  const leavePeople = new Set(activeLeaves.map((item) => String(item.name || item.teacher || '').trim()).filter(Boolean)).size;
  return {
    expectedTeachers: people.length,
    seatRate: seatExpected ? Math.round((seatPresent / seatExpected) * 100) : 0,
    seatPresent,
    seatExpected,
    classes,
    listens,
    leavePeople,
    rows,
  };
}
