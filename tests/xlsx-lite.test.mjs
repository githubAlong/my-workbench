import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { readXlsx } from '../js/xlsx-lite.js';
import { parseTeacherRosterGrid } from '../js/roster-import.mjs';

const crcTable=(()=>{
 const table=new Uint32Array(256);
 for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=(c&1)?(0xedb88320^(c>>>1)):(c>>>1);table[n]=c>>>0;}
 return table;
})();
function crc32(buffer){let c=0xffffffff;for(const byte of buffer)c=crcTable[(c^byte)&255]^(c>>>8);return(c^0xffffffff)>>>0;}
function zip(entries){
 const locals=[],centrals=[];let offset=0;
 for(const [name,source] of Object.entries(entries)){
  const n=Buffer.from(name),raw=Buffer.from(source),compressed=deflateRawSync(raw),crc=crc32(raw);
  const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);local.writeUInt16LE(8,8);local.writeUInt32LE(crc,14);local.writeUInt32LE(compressed.length,18);local.writeUInt32LE(raw.length,22);local.writeUInt16LE(n.length,26);
  locals.push(local,n,compressed);
  const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50,0);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt16LE(8,10);central.writeUInt32LE(crc,16);central.writeUInt32LE(compressed.length,20);central.writeUInt32LE(raw.length,24);central.writeUInt16LE(n.length,28);central.writeUInt32LE(offset,42);centrals.push(central,n);
  offset+=local.length+n.length+compressed.length;
 }
 const center=Buffer.concat(centrals),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(Object.keys(entries).length,8);end.writeUInt16LE(Object.keys(entries).length,10);end.writeUInt32LE(center.length,12);end.writeUInt32LE(offset,16);
 return Buffer.concat([...locals,center,end]);
}
function sheet(rows){
 return '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'+rows.map((row,r)=>'<row r="'+(r+1)+'">'+row.map((value,c)=>value==null?'':'<c r="'+String.fromCharCode(65+c)+(r+1)+'" t="s"><v>'+value+'</v></c>').join('')+'</row>').join('')+'</sheetData></worksheet>';
}
test('多工作表XLSX跳过说明页并读取名单页',async()=>{
 const strings=['说明','请阅读','2026年高一老师坐班表','序号','姓名','学科','上课','坐班','听课','教研','请假','备注','1','教师甲','语文','24','教师乙','数学'];
 const shared='<sst>'+strings.map(x=>'<si><t>'+x+'</t></si>').join('')+'</sst>';
 const workbook='<workbook xmlns:r="urn:r"><sheets><sheet name="说明" sheetId="1" r:id="rId1"/><sheet name="名单" sheetId="2" r:id="rId2"/></sheets></workbook>';
 const rels='<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>';
 const bytes=zip({'xl/workbook.xml':workbook,'xl/_rels/workbook.xml.rels':rels,'xl/sharedStrings.xml':shared,'xl/worksheets/sheet1.xml':sheet([[0,1]]),'xl/worksheets/sheet2.xml':sheet([[2],[3,4,5,6,7,8,9,10,11,3,4,5,6,7,8,9,10,11],[12,13,14,null,null,null,null,null,null,15,16,17]])});
 const result=await readXlsx(new Blob([bytes]),{tryParse:rows=>rows.some(row=>row.includes('姓名'))});
 assert.equal(result.sheets.length,2);assert.equal(result.sheetName,'名单');assert.equal(result.pickedIndex,1);
 const roster=parseTeacherRosterGrid(result.rows);
 assert.equal(roster.rows.length,2);assert.deepEqual(roster.rows.map(row=>row.name),['教师甲','教师乙']);
});
