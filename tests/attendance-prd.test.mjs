import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ATTENDANCE_COLUMNS, nextTriState, leaveCoversDate, activeLeavesFor,
  deriveRosterState, calculateDailySummary, parseLeaveDuration, formatLeaveDuration, buildAttendanceExportGrid,
} from '../js/attendance-prd-domain.mjs';

test('PRD 固定六页签字段顺序', () => {
  assert.deepEqual(ATTENDANCE_COLUMNS.roster, ['序号','归属部门','归属年级','姓名','学科','上课','坐班','听课','教研','请假','备注','操作']);
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
  const state=deriveRosterState(teacher,{
    seatRows:[{teacher:'李老师',data:{__periods:{'1':{status:'y',listen_class:'高一(1)班'}}}}],
    classRows:[],researchRows:[],
    leaveRecords:[{name:'李老师',start_date:'2026-11-08',end_date:'2026-11-08',type:'病假'}],
    date:'2026-11-08',period:1,
  });
  assert.equal(state.sit,'y');
  assert.equal(state.listen,true);
  assert.equal(state.leave,'病假');
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
  const namesOf = grid => grid.slice(2).map(row => row[3]);
  const rowByName = (grid, name) => grid.slice(2).find(row => row[3] === name);
  const allNames = ['李老师','王老师','赵老师'];

  const seat = buildAttendanceExportGrid({...common,type:'seat'});
  assert.equal(seat.length,5);
  assert.deepEqual(seat[1],['序号','归属部门','归属年级','姓名','学科','上课','坐班','听课','教研','请假','备注']);
  assert.equal(seat[2][3],'李老师');
  assert.equal(seat[3][3],'王老师');
  assert.match(seat[3][9],/0.5天/);
  assert.match(seat[0][0],/共3人/);
  assert.match(seat[0][0],/未登记\d+人/);
  assert.deepEqual(new Set(namesOf(seat)),new Set(allNames));
  /* 未登记的格子不能再是空白或「—」 */
  const zhaoSeat = rowByName(seat,'赵老师');
  assert.ok([5,6,7,8].every(index => zhaoSeat[index] !== '' && zhaoSeat[index] !== '—'));

  const classes = buildAttendanceExportGrid({...common,type:'class'});
  assert.equal(classes.length,5);
  assert.equal(rowByName(classes,'李老师')[5],'高一(1)班');
  assert.equal(rowByName(classes,'李老师')[8],'已上课');
  assert.equal(rowByName(classes,'王老师')[8],'未登记');
  assert.equal(rowByName(classes,'赵老师')[8],'未登记');
  assert.deepEqual(new Set(namesOf(classes)),new Set(allNames));
  assert.match(classes[0][0],/共3人/);
  assert.match(classes[0][0],/未登记2人/);

  const research = buildAttendanceExportGrid({...common,type:'research'});
  assert.equal(research.length,5);
  assert.equal(rowByName(research,'李老师')[5],'第1节');
  assert.equal(rowByName(research,'李老师')[6],'会议室');
  assert.equal(rowByName(research,'李老师')[8],'已签到');
  assert.equal(rowByName(research,'王老师')[8],'未登记');
  assert.equal(rowByName(research,'赵老师')[8],'未登记');
  assert.deepEqual(new Set(namesOf(research)),new Set(allNames));
  assert.match(research[0][0],/未登记2人/);

  const leave = buildAttendanceExportGrid({...common,type:'leave'});
  assert.equal(leave.length,5);
  assert.match(rowByName(leave,'王老师')[9],/0.5天/);
  assert.equal(rowByName(leave,'王老师')[10],'已批');
  /* 赵老师那张病假是 11-10 单天，11-11 已失效，所以本场按「未请假」出名单 */
  assert.equal(rowByName(leave,'赵老师')[5],'无');
  assert.equal(rowByName(leave,'赵老师')[10],'未请假');
  assert.equal(rowByName(leave,'李老师')[10],'未请假');
  assert.deepEqual(new Set(namesOf(leave)),new Set(allNames));
  assert.match(leave[0][0],/未请假2人/);
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
    assert.equal(grid.length,5,type+' 应是 2 行表头 + 3 行名单');
    assert.deepEqual(grid.slice(2).map(row=>row[3]),['李老师','王老师','赵老师'],type+' 名单不全');
    assert.match(grid[0][0],/共3人/,type+' 抬头缺人数');
    for (const row of grid.slice(2)) {
      for (const index of statusCells[type]) {
        const value = String(row[index] ?? '');
        assert.ok(value && value !== '—',type+' 的 '+row[3]+' 状态格是空白');
      }
    }
    assert.ok(/未登记|未请假/.test(grid[0][0]),type+' 抬头缺未登记统计');
  }
});
