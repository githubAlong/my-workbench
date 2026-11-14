import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {durationMinutes,studyView,studySummary,studyPayload,validateStudy,studyCsv,parseStudyCsv,prepareStudyImport} from '../js/study-records-domain.mjs';
import {installBrowser} from './test-browser.mjs';
const base={date:'2026-11-10',title:'Llama本地部署',goal:'配置环境',planned_duration:'2小时',actual_duration:'90分钟',status:'doing',content:'第一行\n第二行,"引号"',remark:'周末继续'};
test('duration units and precise totals, no invalid or negative duration is silently counted',()=>{
 for(const [value,minutes] of [['2小时',120],['90分钟',90],['1小时30分钟',90],['1.5h',90],['01:30',90],['2',120],['0',0],['0.5小时',30]])assert.equal(durationMinutes(value),minutes);
 assert.equal(durationMinutes(''),null);
 for(const value of ['-1小时','abc','Infinity','1:90','2天','1小时xx'])assert.throws(()=>durationMinutes(value));
 const rows=[studyPayload(base),studyPayload({...base,status:'done',actual_duration:'30分钟',date:'2026-10-01'}),{...base,deleted_at:'now'},{...base,source:'running'}];
 assert.deepEqual(studySummary(rows),{count:2,doing:1,done:1,minutes:120});
});
test('顶部统计跟随当前月份，本月没有记录时不显示时长',async()=>{
 const source=await readFile(new URL('../js/study-records.js',import.meta.url),'utf8');
 assert.match(source,/const summary=studySummary\(rows\)/);
 assert.doesNotMatch(source,/studySummary\(all\)/);
 assert.match(source,/本月学习条目/);
 assert.match(source,/本月学习时长/);
 const november=[studyPayload(base)],october=[studyPayload({...base,date:'2026-10-01'})];
 assert.deepEqual(studySummary(november.filter(row=>row.date.startsWith('2026-12'))),{count:0,doing:0,done:0,minutes:0});
 assert.equal(studySummary(november).minutes,90);
 assert.equal(studySummary(october).count,1);
});
test('legacy rows retain content, minutes and category without mutating storage',()=>{
 const row={id:3,date:'2026-11-01',title:'历史学习',minutes:45,content:'旧笔记',category_id:8,source:'manual'};
 const before=structuredClone(row),view=studyView(row);
 assert.equal(view.status,'done');assert.equal(view.actual_duration,'45分钟');assert.deepEqual(row,before);
 assert.equal(studyPayload(view).minutes,45);assert.equal(studyPayload(view).content,'旧笔记');
  assert.equal(studyPayload({...base,content:'  保留缩进\n\n',remark:' 补充 '}).content,'  保留缩进\n\n');
});
test('required fields, actual calendar dates and states are validated',()=>{
 assert.deepEqual(validateStudy(base),{});
 assert.ok(validateStudy({...base,date:'2026-02-30'}).date);assert.ok(validateStudy({...base,title:'  '}).title);
 assert.ok(validateStudy({...base,status:'draft'}).status);assert.ok(validateStudy({...base,actual_duration:'-2'}).actual_duration);
 assert.equal(studyPayload({...base,actual_duration:''}).minutes,0);
});
test('CSV and JSON imports preserve Unicode multiline notes, state and decimal durations',()=>{
 const row=studyPayload({...base,title:'=SUM(1,2)',actual_duration:'1.25小时'});
 const csv=studyCsv([row]);assert.ok(csv.includes("'=SUM"));
 assert.deepEqual(prepareStudyImport(parseStudyCsv(csv)),[row]);
 assert.deepEqual(prepareStudyImport([row]),[row]);
 assert.throws(()=>parseStudyCsv('日期,学习主题\n"2026-11-10,未闭合'),/未闭合/);
 assert.throws(()=>prepareStudyImport([{date:'2026-11-10',title:'错误状态',status:'draft'}]),/进度状态/);
 assert.throws(()=>prepareStudyImport([]),/没有/);
});
test('real APIs persist all study fields; invalid batch imports are atomic and unchanged saves write nothing',async()=>{
 const storage=installBrowser();const db=await import('../js/localdb.js');db.setActiveAccount('study-records-tests');db.replaceAll(db.blank());
 const {handle}=await import('../js/localapi.js');
 const call=async(method,path,body)=>{const result=await handle(method,path,{},body);assert.equal(result.ok,true,result.error);return result.data;};
 const row=await call('POST','/studies',studyPayload(base));
 assert.equal(row.minutes,90);assert.equal(row.goal,'配置环境');assert.equal(row.status,'doing');
 await call('PATCH','/studies/'+row.id,{status:'done',remark:'完成',actual_duration:'2小时'});
 assert.equal(db.load().studies[0].minutes,120);assert.equal(db.load().studies[0].content,base.content);
 assert.equal((await handle('PATCH','/studies/'+row.id,{}, {status:'draft'})).ok,false);
 let writes=0;const original=storage.setItem.bind(storage);storage.setItem=(key,value)=>{if(key===db.DB_KEY)writes++;original(key,value);};
 await call('PATCH','/studies/'+row.id,{status:'done',remark:'完成',actual_duration:'2小时'});assert.equal(writes,0);
 const before=db.exportJSON();
 assert.equal((await handle('POST','/study/records/import',{}, {rows:[base,{...base,title:''}]})).ok,false);assert.deepEqual(db.exportJSON(),before);
 const imported=await call('POST','/study/records/import',{rows:[base,{...base,title:'第二条'}]});assert.equal(imported.imported,2);assert.equal(writes,1);
 assert.equal(db.load().studies.length,3);assert.equal(new Set(db.load().studies.map(row=>row.id)).size,3);
 await call('DELETE','/studies/'+row.id);assert.equal((await call('GET','/studies')).length,2);
});
