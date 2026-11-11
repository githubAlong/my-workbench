import test from 'node:test';
import assert from 'node:assert/strict';
import {parseLeaveDuration,formatLeaveDuration,calculateDailySummary,updateTeacherGrid,deriveTableGridState} from '../js/attendance-prd-domain.mjs';
const teacher={id:1,name:'李老师',subject:'语文',grade:'高一',active:1};
const base={teachers:[teacher],date:'2026-11-11',seatRows:[],classRows:[],researchRows:[],leaveRecords:[]};
test('请假不允许负数与零，半天与小时分开记录，避免错误换算',()=>{
 for(const value of ['-1','',0,'abc','Infinity'])assert.throws(()=>parseLeaveDuration(value,'day'));
 assert.deepEqual(parseLeaveDuration('0.5','day'),{duration:0.5,duration_unit:'day',days:0.5,hours:0});
 assert.deepEqual(parseLeaveDuration('1.25','hour'),{duration:1.25,duration_unit:'hour',days:0,hours:1.25});
 assert.throws(()=>parseLeaveDuration('.25','day'),/0.5天/);assert.equal(formatLeaveDuration({days:0.5,hours:2}),'0.5天 / 2小时');
});
test('四类考勤的对与错都标为已登记，清空后恢复未登记',()=>{
 for(const key of ['sit','class','listen','research'])for(const value of ['y','n']){
  const rows=[];updateTeacherGrid(rows,teacher,'seat',1,key,value,base);
  assert.equal(calculateDailySummary({...base,seatRows:rows}).rows[0].overall,'已登记');
  updateTeacherGrid(rows,teacher,'seat',1,key,'u',base);
  assert.equal(calculateDailySummary({...base,seatRows:rows}).rows[0].overall,'未登记');
 }
});
test('全天独立保存为一次，不能串到第一节，教研也按次数累计',()=>{
 const researchRows=[];updateTeacherGrid(researchRows,teacher,'research',0,'research','y',base);
 assert.equal(deriveTableGridState(teacher,'research',researchRows,{...base,period:0}).research,'y');
 assert.equal(deriveTableGridState(teacher,'research',researchRows,{...base,period:1}).research,'u');
 updateTeacherGrid(researchRows,teacher,'research',2,'research','y',base);
 const output=calculateDailySummary({...base,researchRows}).rows[0];assert.equal(output.research,2);assert.equal(output.overall,'已登记');
});
test('坐班、上课、听课次数仅累计对，跨表与节次保持独立',()=>{
 const seatRows=[],classRows=[];
 updateTeacherGrid(seatRows,teacher,'seat',0,'sit','y',base);
 updateTeacherGrid(seatRows,teacher,'seat',1,'sit','n',base);
 updateTeacherGrid(classRows,teacher,'class',0,'class','y',base);
 updateTeacherGrid(classRows,teacher,'class',2,'listen','y',base);
 const output=calculateDailySummary({...base,seatRows,classRows}).rows[0];assert.equal(output.seatPresent,1);assert.equal(output.classes,1);assert.equal(output.listens,1);assert.equal(output.overall,'已登记');
});
test('仅有历史教研或听课记录也标记已登记，小时请假独立汇总',()=>{
 const output=calculateDailySummary({...base,researchRows:[{teacher:'语文',subject:'语文',data:{__research:{attendees:[teacher.name]}}}],leaveRecords:[{name:teacher.name,start_date:base.date,end_date:base.date,...parseLeaveDuration('2','hour'),type:'事假'}]}).rows[0];
 assert.equal(output.research,1);assert.equal(output.leaveDays,0);assert.equal(output.leaveHours,2);assert.equal(output.overall,'已登记');
});

test('历史整次教研不会因为多个坐班节次而被重复计数',()=>{const seatRows=[];for(const period of [1,2])updateTeacherGrid(seatRows,teacher,'seat',period,'sit','y',base);const output=calculateDailySummary({...base,seatRows,researchRows:[{teacher:'语文',subject:'语文',data:{__research:{attendees:[teacher.name],period_time:'上午'}}}]}).rows[0];assert.equal(output.research,1);assert.equal(output.seatPresent,2);});
