export const DEFAULT_PERIODS = [
  { no: 1, label: '第1节', start: '08:00', end: '08:40' },
  { no: 2, label: '第2节', start: '08:50', end: '09:30' },
  { no: 3, label: '第3节', start: '10:00', end: '10:40' },
  { no: 4, label: '第4节', start: '10:50', end: '11:30' },
  { no: 5, label: '第5节', start: '11:40', end: '12:20' },
  { no: 6, label: '第6节', start: '14:10', end: '14:50' },
  { no: 7, label: '第7节', start: '15:20', end: '16:00' },
  { no: 8, label: '第8节', start: '16:15', end: '16:55' },
  { no: 9, label: '第9节', start: '17:05', end: '17:45' },
];

export const LEAVE_TYPES = ['事假', '病假', '婚假', '丧假', '产假', '公假', '调休', '公出'];

/* 2026-11-14：列顺序按用户要求改为 坐班 / 上课 / 听课 / 教研 / 请假。 */
const TEACHER_COLUMNS = Object.freeze(['序号', '归属部门', '归属年级', '姓名', '学科', '坐班', '上课', '听课', '教研', '请假', '备注', '操作']);
export const ATTENDANCE_COLUMNS = {
  roster: TEACHER_COLUMNS,
  seat: TEACHER_COLUMNS,
  class: TEACHER_COLUMNS,
  research: TEACHER_COLUMNS,
  leave: ['姓名', '学科', '类型', '开始', '结束', '请假时长', '状态', '备注'],
  summary: ['序号', '姓名', '学科', '坐班', '上课', '听课', '教研', '请假时长', '综合状态'],
};

export function nextTriState(value) {
  return value === 'y' ? 'n' : value === 'n' ? 'u' : 'y';
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

export function matchesAttendancePeriod(value, period) {
  if (Number(period) === 0) return String(value || '').includes('全天');
  if (String(value || '').includes('全天')) return false;
  const match = String(value || '').match(/(?:第\s*)?(\d+)(?:\s*[-~至]\s*(\d+))?\s*节/);
  if (!match) return true;
  const current = Number(period);
  return current >= Number(match[1]) && current <= Number(match[2] || match[1]);
}

function deriveLegacyRosterState(teacher, {
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
  const classRecords = classRows.filter((row) => {
    const data = rowData(row);
    const record = data.__classRecord || {};
    return !data.__deleted
      && String(row.teacher || '').trim() === name
      && Number(record.period ?? period) === Number(period);
  });
  const researchRecords = researchRows.filter((row) => {
    const d = rowData(row).__research || {};
    return Array.isArray(d.attendees)
      && d.attendees.includes(name)
      && matchesAttendancePeriod(d.period_time, period);
  });
  const leaves = activeLeavesFor(leaveRecords,date).filter((item) =>
    String(item.name || item.teacher || '').trim() === name && leaveCoversDate(item, date)
  );
  const classStatus = classRecords.some((row) => (rowData(row).__classRecord || {}).status === 'y') ? 'y'
    : classRecords.some((row) => (rowData(row).__classRecord || {}).status === 'n') ? 'n' : 'u';
  const seatStatus = selectedSeat.status === 'y' || selectedSeat.status === 'n' ? selectedSeat.status : 'u';
  const listensFromSeat = !!String(selectedSeat.listen_class || '').trim();
  const listensFromClass = classRows.some((row) => {
    const data = rowData(row);
    const record = data.__classRecord || {};
    return !data.__deleted
      && Number(record.period ?? period) === Number(period)
      && Array.isArray(record.listeners)
      && record.listeners.includes(name);
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

function calculateLegacyDailySummary({
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

const GRID_TYPES = ['seat', 'class', 'research'];
const GRID_KEYS = ['class', 'sit', 'listen', 'research'];
const gridRecord = (row, period) => rowData(row).__teacherGrid?.[String(period)];
export function matchesGridTeacher(row, teacher) {
  const id = rowData(row).__teacherId;
  if (id != null && teacher?.id != null) return String(id) === String(teacher.id);
  return String(row?.teacher || '').trim() === String(teacher?.name || '').trim()
    && String(row?.subject || '').trim() === String(teacher?.subject || '').trim();
}

export function deriveTableGridState(teacher, type, rows, context = {}) {
  const legacy = deriveLegacyRosterState(teacher, {
    ...context, seatRows: [], classRows: [], researchRows: [],
    [type + 'Rows']: rows.filter(row => !rowData(row).__deleted && (matchesGridTeacher(row, teacher)
      || (type === 'research' && rowData(row).__research
        && String(rowData(row).__research.subject || row.subject || row.teacher || '').trim() === String(teacher.subject || '').trim()))),
  });
  // Class listening records name the listener rather than the class teacher.
  if (type === 'class') legacy.listen = deriveLegacyRosterState(teacher, { ...context, classRows: rows }).listen;
  const row = rows.find(item => !rowData(item).__deleted && matchesGridTeacher(item, teacher));
  const saved = gridRecord(row, context.period ?? 1) || {};
  const result = {
    class: legacy.class, sit: legacy.sit, listen: legacy.listen ? 'y' : 'u',
    research: legacy.research ? 'y' : 'u', leave: legacy.leave,
    remark: type === 'seat' ? legacy.seatRecord?.remark || ''
      : rowData(row).__classRecord?.remark || rowData(row).__research?.remark || '',
    ...saved,
  };
  // Historical multi-category entries display one category without rewriting history.
  /* 单张表内也按全局优先级裁决（上课 > 坐班 > 听课 > 教研），
     历史数据里一格同时留了多个状态时，保留的必须是优先级最高的那个。 */
  const selected = ['class','sit','listen','research'].find(key => result[key] === 'y' || result[key] === 'n');
  for (const key of GRID_KEYS) if (key !== selected) result[key] = 'u';
  return result;
}

export function updateTeacherGrid(rows, teacher, type, period, key, value, context = {}) {
  if (!GRID_TYPES.includes(type) || ![...GRID_KEYS, 'leave', 'remark'].includes(key)) {
    throw new Error('无效的考勤表或字段');
  }
  let row = rows.find(item => !rowData(item).__deleted && matchesGridTeacher(item, teacher));
  if (!row) {
    row = { teacher: teacher.name, subject: teacher.subject || '', data: {} };
    rows.push(row);
  }
  const record = deriveTableGridState(teacher, type, rows, { ...context, period });
  const next = { ...record, [key]: value };
  if (GRID_KEYS.includes(key)) {
    if (!['u','y','n'].includes(value)) throw new Error('无效的考勤状态');
    for (const other of GRID_KEYS) if (other !== key) next[other] = 'u';
  }
  row.teacher = teacher.name;
  row.subject = teacher.subject || '';
  row.data = {
    ...rowData(row), __teacherId: teacher.id,
    __teacherGrid: { ...(rowData(row).__teacherGrid || {}), [String(period)]: next },
  };
  return next;
}

export function mergeTeacherGridRows(savedRows, draftRows, period) {
  const rows = savedRows.map(row => ({ ...row, data: { ...rowData(row) } }));
  for (const draft of draftRows) {
    const record = gridRecord(draft, period);
    if (!record || rowData(draft).__deleted) continue;
    const teacher = { id: rowData(draft).__teacherId, name: draft.teacher, subject: draft.subject };
    let target = rows.find(row => !rowData(row).__deleted && matchesGridTeacher(row, teacher));
    if (!target) {
      target = { teacher: draft.teacher, subject: draft.subject, data: {} };
      rows.push(target);
    }
    target.teacher = draft.teacher;
    target.subject = draft.subject;
    target.data = {
      ...rowData(target), __teacherId: rowData(draft).__teacherId,
      __teacherGrid: { ...(rowData(target).__teacherGrid || {}), [String(period)]: { ...record } },
    };
  }
  return rows;
}

/* 五种状态互斥（用户 11-12 裁决）：请假 > 上课 > 坐班 > 听课 > 教研。
   坐班表和上课表是两张独立的表，同一个人很容易两边都有记录，合并显示
   时必须只留一个状态，否则会出现「上课✓ 坐班✓」两个勾同时亮。 */
const STATE_PRIORITY = ['leave', 'class', 'sit', 'listen', 'research'];
function exclusiveRosterState(state) {
  const statusOf = key => {
    if (key === 'listen' || key === 'research') {
      const explicit = key === 'listen' ? state.listenStatus : state.researchStatus;
      if (explicit === 'y' || explicit === 'n' || explicit === 'u') return explicit;
      const value = key === 'listen' ? state.listen : state.research;
      return value === true || value === 'y' ? 'y' : value === 'n' ? 'n' : 'u';
    }
    return state[key] === 'y' || state[key] === 'n' ? state[key] : 'u';
  };
  const next = {
    ...state,
    listenStatus: statusOf('listen'),
    researchStatus: statusOf('research'),
  };
  /* raw 保留互斥前的原始状态：显示只留一个，但「坐班次数/上课次数」这类
     次数统计必须两边都算，否则同一个人既上课又坐班会少算一次。 */
  next.raw = {
    class: statusOf('class'), sit: statusOf('sit'),
    listenStatus: statusOf('listen'), researchStatus: statusOf('research'),
  };
  next.listen = next.listenStatus === 'y';
  next.research = next.researchStatus === 'y';
  const winner = STATE_PRIORITY.find(key => key === 'leave' ? !!state.leave : statusOf(key) === 'y');
  if (!winner) return next;
  if (winner !== 'class') next.class = 'u';
  if (winner !== 'sit') next.sit = 'u';
  if (winner !== 'listen') { next.listen = false; next.listenStatus = 'u'; }
  if (winner !== 'research') { next.research = false; next.researchStatus = 'u'; }
  return next;
}

export function deriveRosterState(teacher, context = {}) {
  const legacy = deriveLegacyRosterState(teacher, context);
  const period = context.period ?? 1;
  const hasGrid = GRID_TYPES.some(type => (context[type + 'Rows'] || []).some(row =>
    !rowData(row).__deleted && matchesGridTeacher(row, teacher) && gridRecord(row, period)));
  if (!hasGrid) return exclusiveRosterState(legacy);
  const states = GRID_TYPES.map(type => deriveTableGridState(teacher, type, context[type + 'Rows'] || [], context));
  const aggregate = key => states.some(state => state[key] === 'y') ? 'y'
    : states.some(state => state[key] === 'n') ? 'n' : 'u';
  return exclusiveRosterState({
    ...legacy, class: aggregate('class'), sit: aggregate('sit'),
    listen: aggregate('listen') === 'y', research: aggregate('research') === 'y',
    listenStatus: aggregate('listen'), researchStatus: aggregate('research'),
    leave: states.find(state => state.leave)?.leave || legacy.leave,
  });
}

export function calculateDailySummary(context = {}) {
  const summary = calculateLegacyDailySummary(context);
  const people = (context.teachers || []).filter(teacher => teacher && Number(teacher.active ?? 1) !== 0);
  const leavePeople = new Set(activeLeavesFor(context.leaveRecords, context.date)
    .map(row => String(row.name || row.teacher || '').trim()).filter(Boolean));
  people.forEach((teacher, index) => {
    const periods = new Set();
    for (const type of GRID_TYPES) for (const row of context[type + 'Rows'] || []) {
      if (rowData(row).__deleted || !matchesGridTeacher(row, teacher)) continue;
      for (const value of Object.keys(rowData(row).__teacherGrid || {})) periods.add(Number(value));
    }
    const output = summary.rows[index];
    output.leaveHours = activeLeavesFor(context.leaveRecords, context.date).filter(item => String(item.name || item.teacher || '').trim() === teacher.name).reduce((sum,item)=>sum+(Number(item.hours)||0),0);
    if (!periods.size) {
      output.research = (context.researchRows || []).filter(row => !rowData(row).__deleted && rowData(row).__research?.attendees?.includes(teacher.name)).length;
      output.overall = output.overall !== '未登记' || output.classes || output.listens || output.research ? '已登记' : '未登记';
      return;
    }
    const states = [...periods].map(period => ({ period, state: deriveRosterState(teacher, { ...context, period }) }));
    const rawOf = item => item.state.raw || {
      class: item.state.class, sit: item.state.sit,
      listenStatus: item.state.listenStatus || (item.state.listen ? 'y' : 'u'),
      researchStatus: item.state.researchStatus || (item.state.research ? 'y' : 'u'),
    };
    const seats = [0,1,2,3,4,5,6,7,8,9].map(period => deriveRosterState(teacher, { ...context, period }))
      .map(state => (state.raw?.sit) || state.sit);
    output.seatPresent = seats.filter(value => value === 'y').length;
    output.seatExpected = seats.filter(value => value === 'y' || value === 'n').length;
    // Retain legacy records outside the edited periods, including multiple classes.
    const classes = (context.classRows || []).filter(row => !rowData(row).__deleted
      && matchesGridTeacher(row, teacher) && rowData(row).__classRecord?.status === 'y'
      && !periods.has(Number(rowData(row).__classRecord.period ?? 1))).length;
    output.classes = classes + states.filter(item => rawOf(item).class === 'y').length;
    const seatListens = (context.seatRows || []).filter(row => matchesGridTeacher(row, teacher))
      .flatMap(row => Object.entries(rowData(row).__periods || {}))
      .filter(([period, record]) => !periods.has(Number(period)) && !!record.listen_class).length;
    const classListens = (context.classRows || []).filter(row => !rowData(row).__deleted
      && !periods.has(Number(rowData(row).__classRecord?.period ?? 1))
      && rowData(row).__classRecord?.listeners?.includes(teacher.name)).length;
    output.listens = seatListens + classListens + states.filter(item => rawOf(item).listenStatus === 'y').length;
    const explicitResearch = [...periods].filter(period => GRID_TYPES.some(type => (context[type+'Rows']||[]).some(row => !rowData(row).__deleted && matchesGridTeacher(row,teacher) && gridRecord(row,period)?.research==='y')));
    const researchOverrides = [...periods].filter(period => (context.researchRows||[]).some(row => !rowData(row).__deleted && matchesGridTeacher(row,teacher) && gridRecord(row,period)));
    const legacyResearch = (context.researchRows || []).filter(row => !rowData(row).__deleted && rowData(row).__research?.attendees?.includes(teacher.name)
      && ![...new Set([...researchOverrides,...explicitResearch])].some(period => matchesAttendancePeriod(rowData(row).__research.period_time, period))).length;
    output.research = legacyResearch + explicitResearch.length;
    const onLeave = states.some(item => item.state.leave) || output.leaveDays > 0;
    if (onLeave) leavePeople.add(teacher.name);
    const registered = states.some(({state})=>{
      const raw = rawOf({state});
      return raw.class !== 'u' || raw.sit !== 'u' || raw.listenStatus === 'y' || raw.listenStatus === 'n'
        || raw.researchStatus === 'y' || raw.researchStatus === 'n';
    });
    const legacyAbsent = (context.seatRows||[]).some(row=>matchesGridTeacher(row,teacher) && Object.entries(rowData(row).__periods||{}).some(([p,value])=>!periods.has(Number(p)) && value.status==='n'))
      || (context.classRows||[]).some(row=>matchesGridTeacher(row,teacher) && !rowData(row).__deleted && rowData(row).__classRecord?.status==='n' && !periods.has(Number(rowData(row).__classRecord.period??1)));
    output.overall = onLeave || registered || legacyAbsent || output.classes || output.seatPresent || output.listens || output.research ? '已登记' : '未登记';
  });
  summary.seatPresent = summary.rows.reduce((sum, row) => sum + row.seatPresent, 0);
  summary.seatExpected = summary.rows.reduce((sum, row) => sum + row.seatExpected, 0);
  summary.seatRate = summary.seatExpected ? Math.round(summary.seatPresent / summary.seatExpected * 100) : 0;
  summary.classes = summary.rows.reduce((sum, row) => sum + row.classes, 0);
  summary.listens = summary.rows.reduce((sum, row) => sum + row.listens, 0);
  summary.leavePeople = leavePeople.size;
  return summary;
}

export function parseLeaveDuration(amount, unit='day') {
  if (!['day','hour','morning','afternoon'].includes(unit)) throw new Error('请选择请假时长单位');
  if (unit === 'morning' || unit === 'afternoon') return {duration:0.5,duration_unit:unit,days:0.5,hours:0};
  const value=Number(amount);
  if (String(amount).trim()==='' || !Number.isFinite(value) || value<=0) throw new Error('请假时长必须大于0，不能为负数');
  if(unit==='day' && !Number.isInteger(value*2)) throw new Error('按天请假以0.5天为单位');
  return {duration:value,duration_unit:unit,days:unit==='day'?value:0,hours:unit==='hour'?value:0};
}
export function formatLeaveDuration(record) {
  if (record?.duration_unit === 'morning') return '上午（0.5天）';
  if (record?.duration_unit === 'afternoon') return '下午（0.5天）';
  const parts=[];
  if(Number(record.days)>0)parts.push(Number(Number(record.days).toFixed(2))+'天');
  if(Number(record.hours)>0)parts.push(Number(Number(record.hours).toFixed(2))+'小时');
  return parts.join(' / ') || '0天';
}

/**
 * 导出网格分页：PNG 一张长图在手机/预览器里没法上下滑动，按固定行数切页，
 * 每页都带同一份表头，导出后逐页查看或打印。
 */
export function paginateExportGrid(grid, rowsPerPage = 18) {
  const headers = Array.isArray(grid?.[1]) ? grid[1] : [];
  const body = Array.isArray(grid) ? grid.slice(2) : [];
  const size = Math.max(1, Number(rowsPerPage) || 18);
  const pageCount = Math.max(1, Math.ceil(body.length / size));
  return Array.from({ length: pageCount }, (_, index) => ({
    index,
    pageCount,
    headers,
    rows: body.slice(index * size, (index + 1) * size),
  }));
}

const EXPORT_HEADERS = Object.freeze({
  roster: ['序号','归属部门','归属年级','姓名','学科','坐班','上课','听课','教研','请假','备注'],
  seat: ['序号','归属部门','归属年级','姓名','学科','坐班','上课','听课','教研','请假','备注'],
  class: ['序号','归属部门','归属年级','姓名','学科','班级','节次','上课时间','上课状态','听课教师','备注'],
  research: ['序号','归属部门','归属年级','姓名','学科','教研时间','地点','主持人','签到状态','备注'],
  leave: ['序号','归属部门','归属年级','姓名','学科','请假类型','开始日期','结束日期','时段','请假时长','状态','备注'],
});

const exportRowData = row => row?.data && typeof row.data === 'object' ? row.data : {};
/* 「—」看不出是没登记还是导出丢了，统一写成「未登记」。
   用户 11-12 裁决：导出要让每位教师的状态都能看到，空白表格没有意义。 */
const exportStatusLabel = value => value === 'y' ? '✓' : value === 'n' ? '✗' : '未登记';
const exportName = row => String(row?.name || row?.teacher || '').trim();
const exportLeavePeriod = record => String(record?.period || record?.time_period || record?.part_of_day || record?.period_label || '').trim();
const exportLeaveDuration = record => {
  const raw = Number(record?.duration) || 0;
  const days = Number(record?.days ?? (record?.duration_unit === 'hour' ? 0 : raw)) || 0;
  const hours = Number(record?.hours ?? (record?.duration_unit === 'hour' ? raw : 0)) || 0;
  if (days > 0 || hours > 0) return formatLeaveDuration({ days, hours });
  if (['上午', '下午'].includes(exportLeavePeriod(record))) return '0.5天';
  return '未填写';
};

/**
 * 四个页签的导出都以「当前导出范围内的全量教师名单」为准（用户 11-12 裁决，
 * 推翻了此前「只导出对应记录」的旧规则）：有记录的教师显示记录内容与状态，
 * 没有记录的教师也要出现，状态明确写「未登记 / 未请假」，不再留白。
 * 列头仍按页签分类，不做成统一的花名册式列。
 */
export function buildAttendanceExportGrid({
  type = 'seat', grade = '', date = '', period = 1, teachers = [],
  seatRows = [], classRows = [], researchRows = [], leaveRecords = [],
  teacherMeta = {}, resolvePeriodRange = () => [], includeUnlisted = true,
} = {}) {
  const people = (Array.isArray(teachers) ? teachers : [])
    .filter(teacher => teacher && Number(teacher.active ?? 1) !== 0);
  const teacherByName = new Map(people.map(teacher => [String(teacher.name || '').trim(), teacher]));
  const departmentOf = teacher => {
    const meta = teacher ? (teacherMeta?.[String(teacher.id)] || {}) : {};
    return meta.department || meta.dept || teacher?.department || '高中部';
  };
  const gradeOf = (teacher, row) => teacher?.grade || row?.grade || grade;
  const periodLabel = value => Number(value) === 0 ? '全天' : '第' + Number(value) + '节';
  const rangeText = value => {
    const range = typeof resolvePeriodRange === 'function' ? resolvePeriodRange(Number(value)) : [];
    return Array.isArray(range) && range.filter(Boolean).length ? range.filter(Boolean).join('—') : '—';
  };
  /* 全天导出要同时算「全天登记」（__teacherGrid['0']）和第 1~9 节的分节登记：
     页面在全天模式下读的是 '0'，只遍历 1~9 会让导出全是「未登记」。 */
  const periodNumbers = Number(period) === 0
    ? [0, ...Array.from({ length: 9 }, (_, index) => index + 1)]
    : [Number(period)];
  const baseTitle = type === 'roster' ? '花名册' : ({
    seat: '坐班表', class: '上课表', research: '教研表', leave: '请假总表',
  }[type] || '考勤表');
  const fileTitle = baseTitle + ' · ' + (grade || '全部年级') + ' · ' + date + ' · ' + periodLabel(period);

  if (type === 'seat' || type === 'roster') {
    const activeLeaves = activeLeavesFor(leaveRecords, date);
    const rows = people.map((teacher, index) => {
      const states = periodNumbers.map(currentPeriod => deriveRosterState(teacher, {
        seatRows, classRows, researchRows, leaveRecords, date, period: currentPeriod,
      }));
      const aggregate = key => {
        const values = states.map(state => key === 'listen'
          ? (state.listenStatus || (state.listen ? 'y' : 'u'))
          : key === 'research'
            ? (state.researchStatus || (state.research ? 'y' : 'u'))
            : (state[key] || 'u'));
        return values.includes('y') ? 'y' : values.includes('n') ? 'n' : 'u';
      };
      const name = String(teacher.name || '').trim();
      const leaves = activeLeaves.filter(item => {
        if (exportName(item) !== name) return false;
        const recordGrade = String(item.grade || teacher.grade || grade);
        return !grade || recordGrade === String(grade);
      });
      const leaveText = leaves.map(item => [
        item.type || '请假', exportLeavePeriod(item), exportLeaveDuration(item),
      ].filter(Boolean).join(' ')).join('；') || '无';
      const meta = teacherMeta?.[String(teacher.id)] || {};
      return [
        index + 1, departmentOf(teacher), gradeOf(teacher), name, teacher.subject || '',
        exportStatusLabel(aggregate('sit')), exportStatusLabel(aggregate('class')),
        exportStatusLabel(aggregate('listen')), exportStatusLabel(aggregate('research')),
        leaveText, meta.remark || teacher.remark || teacher.note || '',
      ];
    });
    const count = key => rows.filter(row => row[{ class: 6, sit: 5, listen: 7, research: 8 }[key]] === '✓').length;
    const leaveCount = rows.filter(row => row[9] !== '无').length;
    const unregistered = rows.filter(row => [5, 6, 7, 8].every(index => row[index] === '未登记') && row[9] === '无').length;
    const title = fileTitle + ' · 共' + people.length + '人 · 坐班' + count('sit')
      + ' · 上课' + count('class') + ' · 听课' + count('listen')
      + ' · 教研' + count('research') + ' · 请假' + leaveCount
      + ' · 未登记' + unregistered + '人';
    return [[title], EXPORT_HEADERS[type], ...rows];
  }

  if (type === 'class') {
    const entries = [];
    const seenTeacherPeriods = new Set();
    for (const row of Array.isArray(classRows) ? classRows : []) {
      const data = exportRowData(row);
      if (data.__deleted) continue;
      const record = data.__classRecord || {};
      const currentPeriod = Number(record.period ?? period);
      if (Number(period) !== 0 && currentPeriod !== Number(period)) continue;
      const saved = data.__teacherGrid?.[String(currentPeriod)] || data.__teacherGrid?.[String(period)] || {};
      const status = record.status === 'y' || record.status === 'n' ? record.status : (saved.class || record.status || 'u');
      const className = String(record.class_name || '').trim();
      const name = String(row.teacher || '').trim();
      if (!name || status === 'n' || (!className && status !== 'y' && saved.class !== 'y')) continue;
      const teacher = teacherByName.get(name);
      if (!teacher && !includeUnlisted) continue;
      seenTeacherPeriods.add(name + '|' + currentPeriod);
      entries.push({
        period: currentPeriod, name, className,
        row: [
          0, departmentOf(teacher) || row.department || '高中部', gradeOf(teacher, row),
          name, teacher?.subject || row.subject || record.subject || '',
          className || '班级待补充', periodLabel(currentPeriod), rangeText(currentPeriod),
          status === 'y' ? '已上课' : status === 'n' ? '未上课' : '待登记',
          Array.isArray(record.listeners) ? record.listeners.join('、') : String(record.listeners || ''),
          record.remark || saved.remark || '',
        ],
      });
    }
    for (const teacher of people) {
      for (const currentPeriod of periodNumbers) {
        const key = String(teacher.name || '').trim() + '|' + currentPeriod;
        if (seenTeacherPeriods.has(key)) continue;
        const state = deriveRosterState(teacher, {
          seatRows, classRows, researchRows, leaveRecords, date, period: currentPeriod,
        });
        if (state.class !== 'y') continue;
        const name = String(teacher.name || '').trim();
        entries.push({
          period: currentPeriod, name, className: '',
          row: [
            0, departmentOf(teacher), gradeOf(teacher), name, teacher.subject || '',
            '班级待补充', periodLabel(currentPeriod), rangeText(currentPeriod),
            '已上课', '', '',
          ],
        });
        seenTeacherPeriods.add(key);
      }
    }
    /* 全名单兜底：没有上课记录的教师也要出一行，状态明确写「未登记」，
       否则导出只剩几个有课的人，整张名单看不出谁没登记。 */
    const covered = new Set(entries.map(entry => entry.name));
    let unregisteredPeople = 0;
    for (const teacher of people) {
      const name = String(teacher.name || '').trim();
      if (!name || covered.has(name)) continue;
      entries.push({
        period: Number(period) || 0, name, className: '',
        row: [0, departmentOf(teacher), gradeOf(teacher), name, teacher.subject || '',
          '—', Number(period) === 0 ? '全天' : periodLabel(period),
          Number(period) === 0 ? '—' : rangeText(period), '未登记', '', ''],
      });
      covered.add(name);
      unregisteredPeople += 1;
    }
    entries.sort((a, b) => a.period - b.period || a.name.localeCompare(b.name, 'zh-CN') || a.className.localeCompare(b.className, 'zh-CN'));
    const rows = entries.map((entry, index) => [index + 1, ...entry.row.slice(1)]);
    const title = fileTitle + ' · 共' + people.length + '人 · '
      + (rows.length - unregisteredPeople) + '条上课记录 · 未登记' + unregisteredPeople + '人';
    return [[title], EXPORT_HEADERS.class, ...rows];
  }

  if (type === 'research') {
    const rows = [];
    const seen = new Set();
    const seenTeacherPeriods = new Set();
    for (const row of Array.isArray(researchRows) ? researchRows : []) {
      const data = exportRowData(row);
      if (data.__deleted) continue;
      const record = data.__research;
      if (!record || typeof record !== 'object') continue;
      const time = String(record.period_time || (Number(period) === 0 ? '全天' : periodLabel(period))).trim();
      if (Number(period) !== 0 && !matchesAttendancePeriod(time, period)) continue;
      const attendees = Array.isArray(record.attendees) ? record.attendees : [];
      for (const rawName of attendees) {
        const name = String(rawName || '').trim();
        if (!name) continue;
        const teacher = teacherByName.get(name);
        if (!teacher && !includeUnlisted) continue;
        const subjectName = teacher?.subject || record.subject || row.subject || '';
        const key = [name, subjectName, time, record.location || '', record.host || ''].join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        seenTeacherPeriods.add(name + '|' + (Number(period) === 0 ? 'all' : Number(period)));
        rows.push([
          0, departmentOf(teacher), gradeOf(teacher, row), name, subjectName, time,
          record.location || '', record.host || '', '已签到', record.remark || '',
        ]);
      }
    }
    for (const teacher of people) {
      for (const currentPeriod of periodNumbers) {
        const name = String(teacher.name || '').trim();
        const scopeKey = name + '|' + (Number(period) === 0 ? 'all' : Number(period));
        if (seenTeacherPeriods.has(scopeKey)) continue;
        const state = deriveRosterState(teacher, {
          seatRows: [], classRows: [], researchRows, leaveRecords: [], date, period: currentPeriod,
        });
        const status = state.researchStatus || (state.research ? 'y' : 'u');
        if (status !== 'y') continue;
        rows.push([
          0, departmentOf(teacher), gradeOf(teacher), name, teacher.subject || '',
          periodLabel(currentPeriod), '', '', '已登记', '',
        ]);
        seenTeacherPeriods.add(scopeKey);
      }
    }
    /* 全名单兜底：没签到的教师也要出一行，签到状态写「未登记」 */
    const covered = new Set(rows.map(row => String(row[3] || '').trim()));
    let unregisteredPeople = 0;
    for (const teacher of people) {
      const name = String(teacher.name || '').trim();
      if (!name || covered.has(name)) continue;
      rows.push([
        0, departmentOf(teacher), gradeOf(teacher), name, teacher.subject || '',
        Number(period) === 0 ? '全天' : periodLabel(period), '—', '—', '未登记', '',
      ]);
      covered.add(name);
      unregisteredPeople += 1;
    }
    rows.sort((a, b) => String(a[5]).localeCompare(String(b[5]), 'zh-CN') || String(a[3]).localeCompare(String(b[3]), 'zh-CN'));
    const numbered = rows.map((row, index) => [index + 1, ...row.slice(1)]);
    const title = fileTitle + ' · 共' + people.length + '人 · '
      + (numbered.length - unregisteredPeople) + '条教研签到 · 未登记' + unregisteredPeople + '人';
    return [[title], EXPORT_HEADERS.research, ...numbered];
  }

  if (type === 'leave') {
    const entries = activeLeavesFor(leaveRecords, date).filter(record => {
      const name = exportName(record);
      if (!name) return false;
      const teacher = teacherByName.get(name);
      const recordGrade = String(record.grade || teacher?.grade || (teacher ? grade : ''));
      return !grade || recordGrade === String(grade);
    }).slice().sort((a, b) => String(a.start_date || '').localeCompare(String(b.start_date || ''))
      || exportName(a).localeCompare(exportName(b), 'zh-CN'));
    const rows = entries.map((record, index) => {
      const name = exportName(record);
      const teacher = teacherByName.get(name);
      return [
        index + 1, departmentOf(teacher) || record.department || '高中部',
        gradeOf(teacher, record), name, teacher?.subject || record.subject || '',
        record.type || '未填写', record.start_date || '', record.end_date || record.start_date || '',
        exportLeavePeriod(record) || '—', exportLeaveDuration(record),
        record.status || '未注明', record.remark || '',
      ];
    });
    /* 全名单兜底：没请假的教师也出一行，状态写「未请假」 */
    const covered = new Set(entries.map(exportName));
    let noLeavePeople = 0;
    for (const teacher of people) {
      const name = String(teacher.name || '').trim();
      if (!name || covered.has(name)) continue;
      rows.push([
        0, departmentOf(teacher), gradeOf(teacher), name, teacher.subject || '',
        '无', '—', '—', '—', '—', '未请假', '',
      ]);
      covered.add(name);
      noLeavePeople += 1;
    }
    const numbered = rows.map((row, index) => [index + 1, ...row.slice(1)]);
    const title = fileTitle + ' · 共' + people.length + '人 · '
      + (numbered.length - noLeavePeople) + '条请假记录 · 未请假' + noLeavePeople + '人';
    return [[title], EXPORT_HEADERS.leave, ...numbered];
  }

  throw new Error('不支持的考勤导出类型：' + type);
}
