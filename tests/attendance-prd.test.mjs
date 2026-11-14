import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  ATTENDANCE_COLUMNS, nextTriState, leaveCoversDate, activeLeavesFor,
  deriveRosterState, calculateDailySummary, parseLeaveDuration, formatLeaveDuration, buildAttendanceExportGrid,
  deriveTableGridState, paginateExportGrid, splitAttendanceExportGrid,
} from '../js/attendance-prd-domain.mjs';

test('PRD 固定六页签字段顺序', () => {
  assert.deepEqual(ATTENDANCE_COLUMNS.roster, ['序号','归属部门','归属年级','姓名','学科','坐班','上课','听课','教研','请假','备注','操作']);
  for (const type of ['seat','class','research']) {
    assert.deepEqual(ATTENDANCE_COLUMNS[type], ATTENDANCE_COLUMNS.roster);
  }
  assert.deepEqual(ATTENDANCE_COLUMNS.leave, ['姓名','学科','类型','开始','结束','请假时长','状态','备注']);
  assert.deepEqual(ATTENDANCE_COLUMNS.summary, ['序号','姓名','学科','坐班','上课','听课','教研','请假时长','综合状态']);
});

test('三态循环保持未登记、在岗、未在岗语义', () => {
  assert.equal(nextTriState('u'),'y');
  assert.equal(nextTriState('y'),'n');
  assert.equal(nextTriState('n'),'u');
});

test('请假区间按开始与结束日期覆盖当前日期', () => {
  const item={start_date:'2026-11-01',end_date:'2026-11-05',grade:'高一',status:'待批'};
  assert.equal(leaveCoversDate(item,'2026-11-03'),true);
  assert.equal(leaveCoversDate(item,'2026-11-06'),false);
  assert.equal(activeLeavesFor([item],'2026-11-03','高一').length,1);
  assert.equal(activeLeavesFor([item],'2026-11-03','高二').length,0);
});

test('花名册状态可从坐班、上课、教研与请假记录汇总', () => {
  const teacher={name:'李老师',subject:'语文'};
  const seatOnly=deriveRosterState(teacher,{
    seatRows:[{teacher:'李老师',data:{__periods:{'1':{status:'y',listen_class:'高一(1)班'}}}}],
    classRows:[],researchRows:[],leaveRecords:[],date:'2026-11-08',period:1,
  });
  assert.equal(seatOnly.sit,'y');
  /* 互斥：坐班优先于听课，显示层只留坐班；听课原始状态保留在 raw 里，
     「听课人次」统计仍然算得到。 */
  assert.equal(seatOnly.listen,false);
  assert.equal(seatOnly.raw.listenStatus,'y');
  /* 五种状态互斥（11-12 裁决）：请假优先级最高，有请假时其他状态不显示，
     但原始状态仍保留在 raw 里，供坐班次数/上课次数统计使用。 */
  const state=deriveRosterState(teacher,{
    seatRows:[{teacher:'李老师',data:{__periods:{'1':{status:'y',listen_class:'高一(1)班'}}}}],
    classRows:[],researchRows:[],
    leaveRecords:[{name:'李老师',start_date:'2026-11-08',end_date:'2026-11-08',type:'病假'}],
    date:'2026-11-08',period:1,
  });
  assert.equal(state.leave,'病假');
  assert.equal(state.sit,'u');
  assert.equal(state.listen,false);
  assert.equal(state.raw.sit,'y');
  assert.equal(state.raw.listenStatus,'y');
});

test('汇总 KPI 跨节次累计，未登记与缺勤不混为一类', () => {
  const s=calculateDailySummary({
    teachers:[{name:'李老师',subject:'语文',active:1},{name:'王老师',subject:'数学',active:1}],
    seatRows:[{teacher:'李老师',data:{__periods:{'1':{status:'y'},'2':{status:'n'}}}}],
    classRows:[{teacher:'李老师',data:{__classRecord:{status:'y',listeners:['王老师']}}}],
    researchRows:[{teacher:'语文',data:{__research:{attendees:['李老师']}}}],
    leaveRecords:[{name:'王老师',grade:'高一',start_date:'2026-11-08',end_date:'2026-11-08',days:1,type:'事假'}],
    date:'2026-11-08',
  });
  assert.equal(s.expectedTeachers,2);
  assert.equal(s.seatRate,50);
  assert.equal(s.classes,1);
  assert.equal(s.listens,1);
  assert.equal(s.leavePeople,1);
  assert.equal(s.rows[0].overall,'已登记');
});

test('请假时长支持半天、上午、下午和小时小数', () => {
  assert.deepEqual(parseLeaveDuration('0.5','day'), {duration:0.5,duration_unit:'day',days:0.5,hours:0});
  assert.deepEqual(parseLeaveDuration('0.5','morning'), {duration:0.5,duration_unit:'morning',days:0.5,hours:0});
  assert.equal(formatLeaveDuration(parseLeaveDuration('0.5','morning')),'上午（0.5天）');
  assert.deepEqual(parseLeaveDuration('0.5','afternoon'), {duration:0.5,duration_unit:'afternoon',days:0.5,hours:0});
  assert.equal(formatLeaveDuration(parseLeaveDuration('0.5','afternoon')),'下午（0.5天）');
  assert.deepEqual(parseLeaveDuration('1.5','hour'), {duration:1.5,duration_unit:'hour',days:0,hours:1.5});
  assert.throws(() => parseLeaveDuration('0.25','day'), /0.5天/);
});

test('四类导出都保留全量名单并显示对应状态（11-12 新裁决）', () => {
  const teachers = [
    {id:1,name:'李老师',subject:'语文',grade:'高一',active:1},
    {id:2,name:'王老师',subject:'数学',grade:'高一',active:1},
    {id:3,name:'赵老师',subject:'英语',grade:'高一',active:1},
  ];
  const seatRows = [
    {teacher:'李老师',subject:'语文',data:{__periods:{'1':{status:'y',listen_class:''}}}},
    {teacher:'王老师',subject:'数学',data:{__periods:{'1':{status:'y',listen_class:'高一(1)班'}}}},
  ];
  const classRows = [
    {teacher:'李老师',subject:'语文',data:{__classRecord:{class_name:'高一(1)班',period:1,status:'y',listeners:['王老师'],remark:'正常上课'}}},
    {teacher:'王老师',subject:'数学',data:{__classRecord:{class_name:'高一(2)班',period:1,status:'n',listeners:[],remark:'未上课'}}},
    {teacher:'赵老师',subject:'英语',data:{__classRecord:{class_name:'',period:1,status:'u',listeners:[]}}},
  ];
  const researchRows = [
    {teacher:'语文组',subject:'语文',data:{__research:{subject:'语文',period_time:'第1节',location:'会议室',host:'李老师',attendees:['李老师'],remark:'集体备课'}}},
  ];
  const leaveRecords = [
    {name:'王老师',grade:'高一',subject:'数学',type:'事假',start_date:'2026-11-11',end_date:'2026-11-11',days:0.5,duration:0.5,duration_unit:'day',status:'已批',remark:'上午请假'},
    {name:'赵老师',grade:'高一',subject:'英语',type:'病假',start_date:'2026-11-10',end_date:'2026-11-10',days:1,duration:1,duration_unit:'day',status:'已批'},
  ];
  const common = {grade:'高一',date:'2026-11-11',period:1,teachers,seatRows,classRows,researchRows,leaveRecords,resolvePeriodRange:()=>['08:00','08:45']};
  const namesOf = grid => splitAttendanceExportGrid(grid).rows.map(row => row[3]);
  const rowByName = (grid, name) => splitAttendanceExportGrid(grid).rows.find(row => row[3] === name);
  const allNames = ['李老师','王老师','赵老师'];

  const seat = buildAttendanceExportGrid({...common,type:'seat'});
  /* 三级标题各占一行，再是表头，最后才是名单（用户 11-15 要求） */
  assert.equal(seat.length,7);
  assert.match(seat[0][0],/高一教师坐班表/);
  assert.match(seat[1][0],/2026-11-11 .*星期.*第1节（08:00—08:45）/);
  assert.deepEqual(seat[3],['序号','归属部门','归属年级','姓名','学科','坐班','上课','听课','教研','请假','备注']);
  assert.equal(seat[4][3],'李老师');
  assert.equal(seat[5][3],'王老师');
  assert.match(seat[5][9],/0.5天/);
  assert.match(seat[2][0],/应到 3 人/);
  assert.match(seat[2][0],/未登记 1 人/);
  assert.deepEqual(new Set(namesOf(seat)),new Set(allNames));
  /* 一次只能显示一个状态（11-15 裁决）：李老师上课优先于坐班，坐班/听课/教研留空 */
  const liSeat = rowByName(seat,'李老师');
  assert.equal(liSeat[6],'✓');
  assert.ok([5,7,8].every(index => liSeat[index] === ''));
  /* 王老师当天请假：四类状态都留空，只在请假列看明细 */
  const wangSeat = rowByName(seat,'王老师');
  assert.ok([5,6,7,8].every(index => wangSeat[index] === ''));
  assert.match(wangSeat[9],/事假/);
  /* 赵老师什么都没登记：只在坐班格写「未登记」，不再四列都是「未登记」 */
  const zhaoSeat = rowByName(seat,'赵老师');
  assert.equal(zhaoSeat[5],'未登记');
  assert.ok([6,7,8].every(index => zhaoSeat[index] === ''));
  assert.match(seat[2][0],/未登记 1 人/);

  const classes = buildAttendanceExportGrid({...common,type:'class'});
  assert.equal(classes.length,7);
  assert.equal(rowByName(classes,'李老师')[5],'高一(1)班');
  assert.equal(rowByName(classes,'李老师')[8],'已上课');
  assert.equal(rowByName(classes,'王老师')[8],'未登记');
  assert.equal(rowByName(classes,'赵老师')[8],'未登记');
  assert.deepEqual(new Set(namesOf(classes)),new Set(allNames));
  assert.match(classes[2][0],/应到 3 人/);
  assert.match(classes[2][0],/未登记 2 人/);

  const research = buildAttendanceExportGrid({...common,type:'research'});
  assert.equal(research.length,7);
  assert.equal(rowByName(research,'李老师')[5],'第1节');
  assert.equal(rowByName(research,'李老师')[6],'会议室');
  assert.equal(rowByName(research,'李老师')[8],'已签到');
  assert.equal(rowByName(research,'王老师')[8],'未登记');
  assert.equal(rowByName(research,'赵老师')[8],'未登记');
  assert.deepEqual(new Set(namesOf(research)),new Set(allNames));
  assert.match(research[2][0],/未登记 2 人/);

  const leave = buildAttendanceExportGrid({...common,type:'leave'});
  assert.equal(leave.length,7);
  assert.match(rowByName(leave,'王老师')[9],/0.5天/);
  assert.equal(rowByName(leave,'王老师')[10],'已批');
  /* 赵老师那张病假是 11-10 单天，11-11 已失效，所以本场按「未请假」出名单 */
  assert.equal(rowByName(leave,'赵老师')[5],'无');
  assert.equal(rowByName(leave,'赵老师')[10],'未请假');
  assert.equal(rowByName(leave,'李老师')[10],'未请假');
  assert.deepEqual(new Set(namesOf(leave)),new Set(allNames));
  assert.match(leave[2][0],/未请假 2 人/);

  /* 汇总统计表同样三级标题：表名 / 日期星期·节次时段 / 人数统计 */
  const summary = buildAttendanceExportGrid({...common,type:'summary'});
  assert.equal(summary.length,7);
  assert.match(summary[0][0],/汇总统计表/);
  assert.match(summary[1][0],/2026-11-11 .*第1节（08:00—08:45）/);
  assert.match(summary[2][0],/应到 3 人/);
  assert.deepEqual(summary[3],['序号','姓名','学科','坐班','上课','听课','教研','请假时长','综合状态']);
  assert.equal(summary[4][1],'李老师');
});

test('一场都没登记时，四个页签仍然输出全名单与明确状态，不留白', () => {
  const teachers = [
    {id:1,name:'李老师',subject:'语文',grade:'高一',active:1},
    {id:2,name:'王老师',subject:'数学',grade:'高一',active:1},
    {id:3,name:'赵老师',subject:'英语',grade:'高一',active:1},
  ];
  const common = {
    grade:'高一',date:'2026-11-12',period:3,teachers,
    seatRows:[],classRows:[],researchRows:[],leaveRecords:[],
    resolvePeriodRange:()=>['10:10','10:55'],
  };
  const statusCells = {
    seat:[5,6,7,8], class:[8], research:[8], leave:[10],
  };
  for (const type of ['seat','class','research','leave']) {
    const grid = buildAttendanceExportGrid({...common,type});
    const {rows} = splitAttendanceExportGrid(grid);
    assert.equal(grid.length,7,type+' 应是 3 行标题 + 表头 + 3 行名单');
    assert.deepEqual(rows.map(row=>row[3]),['李老师','王老师','赵老师'],type+' 名单不全');
    assert.match(grid[2][0],/应到 3 人/,type+' 标题缺应到人数');
    for (const row of rows) {
      if (type === 'seat') {
        /* 一次只能一个状态（11-15 裁决）：全都没登记时只在坐班格写「未登记」，其余留空 */
        assert.equal(row[5],'未登记',type+' 的 '+row[3]+' 坐班格应是未登记');
        for (const index of [6,7,8]) assert.equal(row[index],'',type+' 的 '+row[3]+' 多余状态应留空');
        continue;
      }
      for (const index of statusCells[type]) {
        const value = String(row[index] ?? '');
        assert.ok(value && value !== '—',type+' 的 '+row[3]+' 状态格是空白');
      }
    }
    assert.ok(/未登记|未请假/.test(grid[2][0]),type+' 标题缺未登记统计');
  }
});

test('全天录入的状态能原样导出（不会被判成未登记）', () => {
  const teachers = [{ id: 1, name: '李老师', subject: '语文', grade: '高一', active: 1 },
    { id: 2, name: '王老师', subject: '数学', grade: '高一', active: 1 }];
  /* 用户实际用法：节次选「全天」，状态写进 __teacherGrid['0'] */
  const seatRows = [
    { teacher: '李老师', subject: '语文', data: { __teacherId: 1, __teacherGrid: { 0: { class: 'y', sit: 'u', listen: 'u', research: 'u', leave: '' } } } },
    { teacher: '王老师', subject: '数学', data: { __teacherId: 2, __teacherGrid: { 0: { class: 'u', sit: 'y', listen: 'u', research: 'u', leave: '' } } } },
  ];
  const grid = buildAttendanceExportGrid({
    type: 'seat', grade: '高一', date: '2026-11-12', period: 0, teachers, seatRows,
    classRows: [], researchRows: [], leaveRecords: [], resolvePeriodRange: () => ['00:00', '23:59'],
  });
  const rows = splitAttendanceExportGrid(grid).rows;
  /* 一次只能一个状态：李老师勾了上课，坐班格留空而不是「未登记」 */
  assert.equal(rows[0][5], '');
  assert.equal(rows[0][6], '✓');
  /* 王老师勾了坐班，上课格留空 */
  assert.equal(rows[1][5], '✓');
  assert.equal(rows[1][6], '');
  assert.match(grid[2][0], /上课 1 人/);
  assert.match(grid[2][0], /坐班 1 人/);
  assert.match(grid[2][0], /未登记 0 人/);
});

test('五种状态互斥：同一人只显示一个状态，按 请假>上课>坐班>听课>教研 裁决', () => {
  const teacher = { id: 1, name: '李老师', subject: '语文', grade: '高一', active: 1 };
  const cell = (period, patch) => [{ teacher: '李老师', subject: '语文',
    data: { __teacherId: 1, __teacherGrid: { [period]: { class: 'u', sit: 'u', listen: 'u', research: 'u', leave: '', ...patch } } } }];
  const context = { teachers: [teacher], classRows: [], researchRows: [], leaveRecords: [], date: '2026-11-12', period: 1 };

  const classWins = deriveRosterState(teacher, { ...context, seatRows: cell(1, { class: 'y', sit: 'y', listen: 'y', research: 'y' }) });
  assert.equal(classWins.class, 'y');
  assert.equal(classWins.sit, 'u');
  assert.equal(classWins.listen, false);
  assert.equal(classWins.research, false);

  const sitWins = deriveRosterState(teacher, { ...context, seatRows: cell(1, { sit: 'y', listen: 'y', research: 'y' }) });
  assert.equal(sitWins.sit, 'y');
  assert.equal(sitWins.listen, false);
  assert.equal(sitWins.research, false);

  /* 跨表冲突：坐班表勾坐班、上课表勾上课，合并后也只留上课 */
  const cross = deriveRosterState(teacher, { ...context,
    seatRows: cell(1, { sit: 'y' }), classRows: cell(1, { class: 'y' }) });
  assert.equal(cross.class, 'y');
  assert.equal(cross.sit, 'u');
  /* 原始状态保留，次数统计仍能两边都算 */
  assert.equal(cross.raw.class, 'y');
  assert.equal(cross.raw.sit, 'y');
});

test('坐班表行内填写的请假和备注原样进入导出（11-15 反馈）', () => {
  const teachers = [
    { id: 1, name: '朱瑞涵', subject: '语文', grade: '高一', active: 1 },
    { id: 2, name: '王玉华', subject: '数学', grade: '高一', active: 1 },
    { id: 3, name: '赵荣耀', subject: '英语', grade: '高一', active: 1 },
  ];
  const seatRows = [
    { teacher: '朱瑞涵', subject: '语文', data: { __teacherId: 1,
      __teacherGrid: { 1: { class: 'u', sit: 'u', listen: 'u', research: 'u', leave: '公出', remark: '外出培训' } } } },
    { teacher: '王玉华', subject: '数学', data: { __teacherId: 2,
      __teacherGrid: { 1: { class: 'u', sit: 'u', listen: 'u', research: 'u', leave: '病假' } } } },
    /* 行内清空请假：导出按「无」处理，不能回退成请假页的旧记录 */
    { teacher: '赵荣耀', subject: '英语', data: { __teacherId: 3,
      __teacherGrid: { 1: { class: 'u', sit: 'u', listen: 'u', research: 'u', leave: '' } } } },
  ];
  const leaveRecords = [
    { name: '赵荣耀', grade: '高一', subject: '英语', type: '事假',
      start_date: '2026-11-15', end_date: '2026-11-15', days: 1, duration: 1, duration_unit: 'day', status: '已批' },
  ];
  const grid = buildAttendanceExportGrid({
    type: 'seat', grade: '高一', date: '2026-11-15', period: 1, teachers, seatRows,
    classRows: [], researchRows: [], leaveRecords, resolvePeriodRange: () => ['08:00', '08:45'],
  });
  const rows = splitAttendanceExportGrid(grid).rows;
  assert.equal(rows[0][9], '公出');
  assert.equal(rows[0][10], '外出培训');
  assert.ok([5, 6, 7, 8].every(index => rows[0][index] === ''), '请假后四类状态应留空');
  assert.equal(rows[1][9], '病假');
  assert.ok([5, 6, 7, 8].every(index => rows[1][index] === ''), '请假后四类状态应留空');
  assert.equal(rows[2][9], '');
  assert.equal(rows[2][5], '未登记');
  assert.match(grid[2][0], /请假 2 人/);
  assert.match(grid[2][0], /未登记 1 人/);
  assert.match(grid[0][0], /高一教师坐班表/);
  assert.match(grid[1][0], /2026-11-15 星期日/);
  assert.match(grid[1][0], /08:00—08:45/);
});

test('导出的请假和备注优先取坐班表行内填写，其次才是请假页记录和教师备注', () => {
  const teachers = [{ id: 1, name: '李老师', subject: '语文', grade: '高一', active: 1 }];
  const leaveRecords = [
    { name: '李老师', grade: '高一', type: '事假', start_date: '2026-11-15', end_date: '2026-11-15',
      days: 0.5, duration: 0.5, duration_unit: 'day', status: '已批' },
  ];
  const base = { type: 'seat', grade: '高一', date: '2026-11-15', period: 0, teachers, leaveRecords,
    classRows: [], researchRows: [], teacherMeta: { 1: { remark: '教师档案备注' } } };
  const recorded = splitAttendanceExportGrid(buildAttendanceExportGrid({ ...base, seatRows: [] })).rows[0];
  assert.match(recorded[9], /事假/);
  assert.equal(recorded[10], '教师档案备注');
  const filled = splitAttendanceExportGrid(buildAttendanceExportGrid({ ...base, seatRows: [{ teacher: '李老师', subject: '语文',
    data: { __teacherId: 1, __teacherGrid: { 0: { class: 'u', sit: 'u', listen: 'u', research: 'u', leave: '调休', remark: '家里有事' } } } }] })).rows[0];
  assert.equal(filled[9], '调休');
  assert.equal(filled[10], '家里有事');
});

test('导出 PNG 按页切分，每页都带表头，方便上下滑动查看', () => {
  const grid = [['坐班表 · 高一年级 · 2026-11-12 · 全天'],
    ['序号', '姓名', '学科'],
    ...Array.from({ length: 46 }, (_, index) => [index + 1, '教师' + (index + 1), '语文'])];
  const pages = paginateExportGrid(grid, 18);
  assert.equal(pages.length, 3);
  assert.deepEqual(pages.map(page => page.rows.length), [18, 18, 10]);
  pages.forEach(page => {
    assert.deepEqual(page.headers, ['序号', '姓名', '学科']);
    assert.equal(page.pageCount, 3);
  });
  assert.equal(paginateExportGrid([['标题'], ['表头']], 18).length, 1);
});

test('勾选单元格后重绘保留表格滚动位置，不跳回顶部', async () => {
  const source = await readFile(new URL('../js/attendance-prd.js', import.meta.url), 'utf8');
  /* 重绘函数改名 renderPage，外层 paint 负责记住/还原滚动位置 */
  assert.match(source, /const renderPage = \(\) => \{/);
  assert.match(source, /const paint = \(\) => \{\s*const table = root\.querySelector\('\.aprd-table-wrap'\);/);
  assert.match(source, /nextTable\.scrollTop = tableTop;/);
  assert.match(source, /window\.scrollTo\(0, winTop\);/);
  assert.match(source, /if \(typeof window !== 'undefined'\) winTop = window\.scrollY/);
});
