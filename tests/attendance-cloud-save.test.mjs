import test from 'node:test';
import assert from 'node:assert/strict';
import {installBrowser} from './test-browser.mjs';
const storage=installBrowser({href:'https://githubalong.github.io/mywork-master/'});
storage.setItem('wb_supa_tok',JSON.stringify({uid:'00000000-0000-0000-0000-000000000001',access_token:'test-only',expires_at:Date.now()+3600000}));
const {handle}=await import('../js/localapi.js');

test('云端保存函数缺失时保留真实错误，不能回退本地查表或写入',async()=>{
  const calls=[];
  globalThis.fetch=async url=>{calls.push(url);return new Response(JSON.stringify({code:'PGRST202',message:'Could not find the function public.wb_save_attendance_rows in the schema cache'}),{status:404});};
  const result=await handle('POST','/attendance/987654/rows',{}, {rows:[{teacher:'验证教师',subject:'数学',data:{}}]});
  assert.equal(result.ok,false);
  assert.equal(result.cloud,true);
  assert.match(result.error,/保存服务尚未就绪/);
  assert.doesNotMatch(result.error,/考勤表不存在/);
  assert.equal(calls.length,1);
  assert.match(calls[0],/rpc\/wb_save_attendance_rows$/);
});

test('云端批量保存成功直接返回保存结果',async()=>{
  globalThis.fetch=async()=>new Response(JSON.stringify({ids:[123],saved:1}),{status:200});
  const result=await handle('POST','/attendance/987654/rows',{}, {rows:[{teacher:'验证教师',subject:'数学',data:{}}]});
  assert.equal(result.ok,true);
  assert.deepEqual(result.data,{ids:[123],saved:1});
});

test('云端版本冲突不写入本地，也不被伪装成缺表',async()=>{
  globalThis.fetch=async()=>new Response(JSON.stringify({message:'WB_ATTENDANCE_CONFLICT: row changed by another client'}),{status:409});
  const result=await handle('POST','/attendance/987654/rows',{}, {rows:[]});
  assert.equal(result.ok,false);
  assert.equal(result.cloud,true);
  assert.match(result.error,/WB_ATTENDANCE_CONFLICT/);
});
