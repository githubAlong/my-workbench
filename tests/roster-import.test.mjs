import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTeacherRosterGrid, chooseBestRosterSheet } from '../js/roster-import.mjs';

function seatGrid(grade,count,leftCount) {
  const grid=[['2026年'+grade+'老师坐班表'],['序号','姓名','学科','上课','坐班','听课','教研','请假','备注','序号','姓名','学科','上课','坐班','听课','教研','请假','备注']];
  for(let i=0;i<Math.max(leftCount,count-leftCount);i++){
    const row=Array(18).fill('');
    if(i<leftCount) row.splice(0,3,String(i+1),'教师'+String(i+1).padStart(2,'0'),'语文');
    if(i<count-leftCount) row.splice(9,3,String(leftCount+i+1),'教师'+String(leftCount+i+1).padStart(2,'0'),'数学');
    grid.push(row);
  }
  return grid;
}
function researchGrid() {
  return [
    ['2026年高二老师教研签到表'],
    ['序号','姓名','学科','签到','备注','序号','姓名','学科','签到','备注'],
    ['1','教师甲','语文','','','1','教师乙','数学','',''],
    ['2','教师丙','英语','','','2','教师丁','政治','',''],
    ['序号','姓名','学科','签到','备注','序号','姓名','学科','签到','备注'],
    ['1','教师戊','物理','','','1','教师己','化学','',''],
    ['2','教师庚','地理','','','2','教师辛','历史','','']
  ];
}
test('高一坐班Excel双栏提取46人',()=>{
 const r=parseTeacherRosterGrid(seatGrid('高一',46,23));
 assert.equal(r.grade,'高一');assert.equal(r.rows.length,46);
 assert.deepEqual(r.rows.map(x=>x.serial),Array.from({length:46},(_,i)=>i+1));
});
test('高二坐班Excel支持54人',()=>{
 const r=parseTeacherRosterGrid(seatGrid('高二',54,27));
 assert.equal(r.grade,'高二');assert.equal(r.rows.length,54);assert.equal(r.rows.at(-1).serial,54);
});
test('教研Excel重复表头及分组重置序号可解析',()=>{
 const r=parseTeacherRosterGrid(researchGrid());
 assert.equal(r.grade,'高二');assert.equal(r.rows.length,8);
 assert.deepEqual(r.rows.map(x=>x.serial),Array.from({length:8},(_,i)=>i+1));
});
test('重复姓名学科记录会合并并提示',()=>{
 const grid=researchGrid();grid.push(['1','教师甲','语文','','','','','','','']);
 const r=parseTeacherRosterGrid(grid);assert.equal(r.duplicateCount,1);assert.equal(r.rows.length,8);
 assert.match(r.warnings.join(' '),/重复/);
});
test('多工作表选择有效名单页',()=>{
 const r=chooseBestRosterSheet([{name:'说明',rows:[['说明']]},{name:'名单',rows:seatGrid('高一',46,23)}]);
 assert.equal(r.name,'名单');assert.equal(r.rows.length,46);
});
