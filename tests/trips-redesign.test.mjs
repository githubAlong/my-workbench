import test from 'node:test';
import assert from 'node:assert/strict';
import {tripView,tripMonthRows,tripSummary,validateTrip,tripPayload,tripText,tripCsv,parseTripCsv} from '../js/trips-domain.mjs';
const base={start_date:'2026-11-10',to_place:'教育局',reason:'开会',is_driving:'1',driver:'李老师',km:'20.5',total_amount:'140.25'};
test('手填合计不包含里程，月度统计隔离且未开车不累计里程',()=>{
 const rows=[tripPayload(base),tripPayload({...base,is_driving:'0',km:'999',total_amount:'100'}),{...tripPayload(base),start_date:'2026-10-31'},{...tripPayload(base),deleted_at:'now'}];
 assert.deepEqual(tripSummary(tripMonthRows(rows,'2026-11')),{count:2,km:20.5,mileageFee:20.5,total:240.25});
 assert.equal(tripPayload({...base,is_driving:'0'}).driver,'');assert.equal(tripPayload({...base,is_driving:'0'}).km,0);
});
test('金额和必填校验不修正用户输入，公里数与驾驶员条件必填',()=>{
 assert.deepEqual(validateTrip(base),{});
 assert.deepEqual(Object.keys(validateTrip({...base,driver:'',km:'',reason:'',to_place:''})).sort(),['driver','km','reason','to_place']);
 for(const amount of ['-1','1.234','abc','Infinity'])assert.ok(validateTrip({...base,total_amount:amount}).total_amount);
 assert.deepEqual(validateTrip({...base,is_driving:'0',driver:'',km:'',total_amount:''}),{});
 assert.ok(validateTrip({...base,start_date:'2026-02-30'}).start_date);
});
test('历史记录不自动套用旧金额或旧费率，原始字段保持不变',()=>{
 const old={km:12,km_rate:8,subsidy_food:100,transport:20,driver:'老教师'};const copy=JSON.stringify(old);
 assert.equal(tripView(old).mileageFee,12);assert.equal(tripView(old).total,null);assert.equal(JSON.stringify(old),copy);
 assert.doesNotMatch(tripText(old),/补贴|实报/);
});
test('CSV 导出导入往返保留逗号、引号、换行和手填金额',()=>{
 const row=tripPayload({...base,reason:'会议,"资料"',remark:'第一行\n第二行',companions:'张老师、李老师'});
 const parsed=parseTripCsv(tripCsv([row]));assert.deepEqual(tripPayload(parsed[0]),row);
 assert.throws(()=>parseTripCsv('日期,目的地\n2026-11-10,教育局'),/出差事由/);
});
