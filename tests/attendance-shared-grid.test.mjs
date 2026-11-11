import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ATTENDANCE_COLUMNS, deriveTableGridState, updateTeacherGrid,
  mergeTeacherGridRows, deriveRosterState, calculateDailySummary,
} from '../js/attendance-prd-domain.mjs';

const teacher = {id:'t1',name:'李老师',subject:'语文',grade:'高一',active:1};
const context = {date:'2026-11-10',period:1,leaveRecords:[]};

test('四个页签统一十二列，三张表的勾选和备注各自保存', () => {
  const tables = {seat:[],class:[],research:[]};
  for (const type of Object.keys(tables)) assert.deepEqual(ATTENDANCE_COLUMNS[type],ATTENDANCE_COLUMNS.roster);
  updateTeacherGrid(tables.seat,teacher,'seat',1,'sit','y',context);
  updateTeacherGrid(tables.seat,teacher,'seat',1,'remark','坐班记录',context);
  assert.equal(deriveTableGridState(teacher,'seat',tables.seat,context).sit,'y');
  for (const type of ['class','research']) {
    assert.equal(deriveTableGridState(teacher,type,tables[type],context).sit,'u');
    assert.equal(deriveTableGridState(teacher,type,tables[type],context).remark,'');
  }
});

test('保存后重新读取保留全部勾选、请假及备注；其他节次不被覆盖', () => {
  const draft = [];
  for (const [key,value] of Object.entries({class:'n',sit:'y',listen:'y',research:'n',leave:'病假',remark:'上午登记'})) {
    updateTeacherGrid(draft,teacher,'seat',1,key,value,context);
  }
  const saved = mergeTeacherGridRows([],draft,1);
  const secondPeriod = JSON.parse(JSON.stringify(saved));
  updateTeacherGrid(secondPeriod,teacher,'seat',2,'sit','n',context);
  const restored = JSON.parse(JSON.stringify(mergeTeacherGridRows(saved,secondPeriod,2)));
  const first = deriveTableGridState(teacher,'seat',restored,context);
  assert.deepEqual(first,{class:'u',sit:'u',listen:'u',research:'n',leave:'病假',remark:'上午登记'});
  assert.equal(deriveTableGridState(teacher,'seat',restored,{...context,period:2}).sit,'n');
  assert.equal(saved[0].data.__teacherGrid['2'],undefined);
});

test('花名册汇总三张已保存工作表，不改变任何表的原始数据', () => {
  const seatRows=[],classRows=[],researchRows=[];
  updateTeacherGrid(seatRows,teacher,'seat',1,'sit','y',context);
  updateTeacherGrid(classRows,teacher,'class',1,'class','n',context);
  updateTeacherGrid(researchRows,teacher,'research',1,'research','y',context);
  const source=JSON.stringify({seatRows,classRows,researchRows});
  const state=deriveRosterState(teacher,{...context,seatRows,classRows,researchRows});
  assert.equal(state.sit,'y');
  assert.equal(state.class,'n');
  assert.equal(state.research,true);
  assert.equal(JSON.stringify({seatRows,classRows,researchRows}),source);
});

test('同名不同学科、不同年级教师不会共用登记数据，新增教师没有旧勾选', () => {
  const rows=[];
  updateTeacherGrid(rows,teacher,'seat',1,'sit','y',context);
  for (const other of [{...teacher,id:'t2',subject:'数学'},{...teacher,id:'t3',grade:'高二'},{id:'t4',name:'新教师',subject:'语文'}]) {
    assert.equal(deriveTableGridState(other,'seat',rows,context).sit,'u');
  }
  const renamed={...teacher,name:'李新名'};
  updateTeacherGrid(rows,renamed,'seat',1,'listen','y',context);
  assert.equal(rows.length,1);
  assert.equal(rows[0].teacher,'李新名');
  assert.equal(deriveTableGridState(renamed,'seat',rows,context).sit,'u');
});

test('编辑当前节次保留旧的班级、教研安排、其他节次和历史字段', () => {
  const saved=[{id:'r1',teacher:teacher.name,subject:teacher.subject,data:{
    attachment:'keep',__periods:{'2':{status:'y'}},
    __classRecord:{class_name:'高一1班',period:1,status:'y'},
  }}];
  const draft=JSON.parse(JSON.stringify(saved));
  updateTeacherGrid(draft,teacher,'class',1,'class','n',context);
  const merged=mergeTeacherGridRows(saved,draft,1);
  assert.deepEqual(merged[0].data.__classRecord,saved[0].data.__classRecord);
  assert.deepEqual(merged[0].data.__periods,saved[0].data.__periods);
  assert.equal(merged[0].data.attachment,'keep');
  assert.equal(deriveTableGridState(teacher,'class',merged,context).class,'n');
  assert.equal(deriveRosterState(teacher,{...context,classRows:merged}).class,'n');
});

test('汇总统计读取已保存的统一表格，不再遗漏勾选', () => {
  const seatRows=[],classRows=[],researchRows=[];
  updateTeacherGrid(seatRows,teacher,'seat',1,'sit','y',context);
  updateTeacherGrid(classRows,teacher,'class',1,'class','y',context);
  updateTeacherGrid(classRows,teacher,'class',2,'listen','y',context);
  updateTeacherGrid(researchRows,teacher,'research',1,'research','y',context);
  updateTeacherGrid(researchRows,teacher,'research',1,'leave','事假',context);
  const summary=calculateDailySummary({...context,teachers:[teacher],seatRows,classRows,researchRows});
  assert.equal(summary.seatPresent,1);
  assert.equal(summary.seatExpected,1);
  assert.equal(summary.classes,1);
  assert.equal(summary.listens,1);
  assert.equal(summary.rows[0].research,1);
  assert.equal(summary.leavePeople,1);
  assert.equal(summary.rows[0].overall,'已登记');
});

test('空数据、已删除行、未登记和明确未到不混淆', () => {
  assert.equal(deriveRosterState(teacher,context).sit,'u');
  const rows=[];
  updateTeacherGrid(rows,teacher,'seat',1,'sit','n',context);
  assert.equal(deriveRosterState(teacher,{...context,seatRows:rows}).sit,'n');
  rows[0].data.__deleted=true;
  assert.equal(deriveRosterState(teacher,{...context,seatRows:rows}).sit,'u');
});

test('三张表每节只能选择一种类别，默认全空并支持循环清空', () => {
  for (const type of ['seat','class','research']) {
    const rows=[];
    const keys=['class','sit','listen','research'];
    assert.deepEqual(keys.map(key=>deriveTableGridState(teacher,type,rows,context)[key]),['u','u','u','u']);
    for (const key of keys) {
      for (const value of ['y','n','u']) {
        updateTeacherGrid(rows,teacher,type,1,key,value,context);
        const restored=deriveTableGridState(teacher,type,JSON.parse(JSON.stringify(rows)),context);
        assert.equal(restored[key],value);
        assert.ok(keys.filter(other=>other!==key).every(other=>restored[other]==='u'));
      }
    }
  }
});
