import test from 'node:test';
import assert from 'node:assert/strict';
import {extractRosterRowsFromTesseract,buildRosterReviewRows,validateRosterRows,inferKnownRosterCount,parseRosterContactSheetRows} from '../js/roster-photo-parser.mjs';
const subjects=['语文','数学','英语','物理','化学','生物','历史','地理'];
function word(text,x,y){return {text,confidence:96,bbox:{x0:x-12,y0:y-9,x1:x+12,y1:y+9}};}
function fixture(count,left,repeat=false){
 const out=[];
 for(let i=0;i<Math.max(left,count-left);i++){
  const y=100+i*38;
  if(i<left)out.push(word(repeat?'1':String(i+1),55,y),word(['张伟','王芳','李娜','刘洋','陈静','杨洋','赵敏','黄磊'][i%8],160,y),word(subjects[i%8],275,y));
  if(i<count-left)out.push(word(repeat?'1':String(left+i+1),555,y),word(['张伟','王芳','李娜','刘洋','陈静','杨洋','赵敏','黄磊'][(left+i)%8],660,y),word(subjects[(left+i)%8],775,y));
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

test('双栏图片联系表按视觉行号保留46个审核位置',()=>{
 const left=parseRosterContactSheetRows([{text:'李成华语文',confidence:92},{text:'章承国数学',confidence:90},{text:'黄鹏英语',confidence:88}],46,23,'left');
 const right=parseRosterContactSheetRows([{text:'徐洁语文',confidence:91},{text:'覃蓉语文',confidence:89}],46,23,'right');
 const rows=[...left,...right].sort((a,b)=>a.serial-b.serial);
 assert.equal(rows.length,46);
 assert.equal(rows[0].serial,1);assert.equal(rows[0].name,'李成华');assert.equal(rows[0].subject,'语文');
 assert.equal(rows[1].serial,2);assert.equal(rows[1].name,'章承国');assert.equal(rows[1].subject,'数学');
 assert.equal(rows[22].serial,23);assert.equal(rows[23].serial,24);
 assert.equal(rows[23].name,'徐洁');assert.equal(rows[23].subject,'语文');
 assert.equal(rows[45].serial,46);assert.equal(rows[45].name,'');assert.equal(rows[45].needsReview,true);
});
test('双栏图片识别支持信息、日语、俄语学科',()=>{
 const rows=parseRosterContactSheetRows([{text:'李青丰信息',confidence:90},{text:'张琴俄语',confidence:90},{text:'向琴芳日语',confidence:90}],46,23,'left');
 assert.deepEqual(rows.slice(0,3).map(row=>row.subject),['信息','俄语','日语']);
});
