import test from 'node:test';
import assert from 'node:assert/strict';
import {extractRosterRowsFromTesseract,buildRosterReviewRows,validateRosterRows,inferKnownRosterCount} from '../js/roster-photo-parser.mjs';
const subjects=['语文','数学','英语','物理','化学','生物','历史','地理'];
function word(text,x,y){return {text,confidence:96,bbox:{x0:x-12,y0:y-9,x1:x+12,y1:y+9}};}
function fixture(count,left,repeat=false){
 const out=[];
 for(let i=0;i<Math.max(left,count-left);i++){
  const y=100+i*38;
  if(i<left)out.push(word(repeat?'1':String(i+1),55,y),word('教师'+(i+1),160,y),word(subjects[i%8],275,y));
  if(i<count-left)out.push(word(repeat?'1':String(left+i+1),555,y),word('教师'+(left+i+1),660,y),word(subjects[(left+i)%8],775,y));
 }
 return out;
}
test('46人双栏名单按位置连续编号',()=>{
 const rows=extractRosterRowsFromTesseract(fixture(46,23),1000,1100);
 assert.equal(rows.length,46);assert.deepEqual(rows.map(x=>x.serial),Array.from({length:46},(_,i)=>i+1));
 assert.equal(validateRosterRows(rows,46).valid,true);
});
test('54人双栏名单不会被46人模板截断',()=>{
 const rows=extractRosterRowsFromTesseract(fixture(54,27),1000,1200);
 assert.equal(rows.length,54);assert.equal(rows.at(-1).serial,54);
});
test('重复识别序号1时回退到空间顺序',()=>{
 const rows=extractRosterRowsFromTesseract(fixture(46,23,true),1000,1100);
 assert.equal(new Set(rows.map(x=>x.serial)).size,46);
});
test('缺失记录在审核表保留空行',()=>{
 const words=fixture(46,23).filter(x=>Math.abs((x.bbox.y0+x.bbox.y1)/2-404)>1);
 const rows=extractRosterRowsFromTesseract(words,1000,1100);
 const review=buildRosterReviewRows(rows,46,23);
 assert.equal(review.length,46);assert.equal(validateRosterRows(review,46).valid,false);
});
test('按年级和表类型匹配人数',()=>{
 assert.equal(inferKnownRosterCount('高一','2026高一坐班表'),46);
 assert.equal(inferKnownRosterCount('高二','2026高二坐班表'),54);
 assert.equal(inferKnownRosterCount('高二','2026高二教研签到表'),52);
});
