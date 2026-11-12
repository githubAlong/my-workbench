import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import * as domain from '../js/attendance-prd-domain.mjs';
import * as timetablePeriods from '../js/timetable-periods.mjs';

// Exercise the actual renderer and its event handlers with a small DOM/API fixture.
// No database, account, browser storage or network is used.
class Element {
  constructor(tag,attributes) {
    this.tag=tag; this.attributes=attributes; this.dataset={}; this.handlers={};
    this.value=attributes.value||''; this.disabled='disabled' in attributes;
    for(const [key,value] of Object.entries(attributes)) if(key.startsWith('data-')) {
      this.dataset[key.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=value;
    }
  }
  addEventListener(type,handler) { this.handlers[type]=handler; }
  focus() {}
  setSelectionRange() {}
  async click() {
    await (this.onclick||this.handlers.click)?.({currentTarget:this,target:this});
    await new Promise(setImmediate);
  }
  async change(value) {
    this.value=value;
    await (this.onchange||this.handlers.change)?.({currentTarget:this,target:this});
    await new Promise(setImmediate);
  }
  async input(value,options={}) { this.value=value; return this.handlers.input?.({currentTarget:this,target:this,...options}); }
  async composition(type) { return this.handlers[type]?.({currentTarget:this,target:this}); }
}
class Root {
  set innerHTML(html) {
    this.html=html;this.elements=[];
    for(const match of html.matchAll(/<([a-z][a-z0-9-]*)(\s[^>]*?)?>/g)) {
      const attributes={};
      for(const attr of (match[2]||'').matchAll(/([\w-]+)(?:="([^"]*)")?/g)) attributes[attr[1]]=attr[2]??'';
      const element=new Element(match[1],attributes);
      if(element.tag==='select') {
        const options=html.slice(match.index+match[0].length).split('</select>')[0];
        element.value=options.match(/<option value="([^"]*)"[^>]*selected/)?.[1]
          ?? options.match(/<option value="([^"]*)"/)?.[1] ?? '';
      }
      this.elements.push(element);
    }
  }
  get innerHTML() {return this.html;}
  querySelectorAll(selector) {
    if(selector.includes(',')) return [...new Set(selector.split(',').flatMap(part=>this.querySelectorAll(part)))];
    return this.elements.filter(element=>{
      if(selector.startsWith('#')) return element.attributes.id===selector.slice(1);
      const attr=selector.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
      return attr ? attr[1] in element.attributes && (attr[2]===undefined||element.attributes[attr[1]]===attr[2])
        : element.tag===selector;
    });
  }
  querySelector(selector) {return this.querySelectorAll(selector)[0]||null;}
}
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const source=(await readFile(new URL('../js/attendance-prd.js',import.meta.url),'utf8'))
  .replace(/^import[\s\S]*?;\r?\n/gm,'').replace('export async function renderAttendancePRD','async function renderAttendancePRD');

async function setup() {
  const root=new Root(), saved={seat:{id:'seat',rows:[]},class:{id:'class',rows:[]},research:{id:'research',rows:[]}};
  const teachers=[{id:'1',name:'李老师',subject:'语文',grade:'高一',active:1},
    {id:'2',name:'王老师',subject:'数学',grade:'高一',active:1}];
  const calls=[],exportedGrids=[],toasts=[],patchCalls=[];
  let version=0;
  const nextVersion=()=>String(++version);
  const api={
    async get(path) {
      if(path==='/grades') return {grades:['高一','高二']};
      if(path==='/teachers') return {list:structuredClone(teachers)};
      if(path==='/me') return {user:{settings:{}}};
      if(path==='/attendance') return Object.values(saved).map(table=>({id:table.id,sheet_type:table.id}));
      return structuredClone(saved[path.split('/').pop()]);
    },
    async post(path,{rows}) {
      const type=path.split('/')[2];
      /* 和云端 RPC 一样做行级版本校验：别的设备先改过就抛冲突 */
      for(const row of rows||[]) {
        if(row.expected_updated_at===undefined) continue;
        const current=(saved[type].rows||[]).find(item=>String(item.id)===String(row.id));
        if(current&&String(current.updated_at||'')!==String(row.expected_updated_at||''))
          throw Error('WB_ATTENDANCE_CONFLICT: row changed by another client');
      }
      saved[type].rows=structuredClone(rows).map((row,index)=>({...row,id:row.id||type+index,updated_at:nextVersion()}));
      saved[type].updated_at=nextVersion();
      calls.push(type);
      return {ids:saved[type].rows.map(row=>row.id)};
    },
    async patch(path,body) {
      patchCalls.push({path,expected:body.expected_updated_at});
      const table=saved[path.split('/').pop()];
      if(body.expected_updated_at!==undefined && body.expected_updated_at!==String(table.updated_at||'')) {
        throw Error('WB_ATTENDANCE_CONFLICT: stale header version');
      }
      Object.assign(table,body,{updated_at:nextVersion()});
      return structuredClone(table);
    },
  };
  const dependencies={...domain,...timetablePeriods,api,esc,toast:(message,type)=>toasts.push({message,type}),confirmDialog:async()=>true,saveBlob(){},icon:()=>'',
    createSlot(){throw Error('fixture tables already exist');},makeXlsx({grid}){exportedGrids.push(grid);},parseRosterFile(){},parseRosterText(){}};
  const render=new Function(...Object.keys(dependencies),source+'\nreturn renderAttendancePRD;')(...Object.values(dependencies));
  await render(root,{grade:'高一'});
  return {root,saved,calls,exportedGrids,toasts,patchCalls};
}
const control=(root,key,id='1')=>root.querySelectorAll('[data-grid-person]').find(element=>element.dataset.gridPerson===id&&element.dataset.gridKey===key);

test('实际四页签展示相同名单和列，花名册无考勤编辑入口，工作表可操作',async()=>{
  const {root}=await setup();
  const headers=()=>[...root.innerHTML.matchAll(/<th>(.*?)<\/th>/g)].map(match=>match[1]);
  const names=()=>[...root.innerHTML.matchAll(/<td><b>(.*?)<\/b><\/td>/g)].map(match=>match[1]);
  const expectedHeaders=headers(),expectedNames=names();
  assert.equal(root.querySelectorAll('[data-grid-person]').length,0);
  assert.equal(root.querySelectorAll('[data-person]').length,0);
  for(const type of ['seat','class','research']) {
    await root.querySelector('[data-tab="'+type+'"]').click();
    assert.deepEqual(headers(),expectedHeaders);
    assert.deepEqual(names(),expectedNames);
    assert.equal(root.querySelectorAll('[data-grid-person]').length,12);
    /* 用户 11-12 裁决：去掉「保存本表」，改为点一下即自动保存 */
    assert.equal(root.querySelector('[data-grid-save]'),null);
    assert.equal(/保存本表/.test(root.innerHTML),false);
  }
});

test('真实操作链：草稿跨页签保留，自动保存仅写本表，重新打开与花名册汇总一致',async()=>{
  const {root,saved,calls}=await setup();
  await root.querySelector('[data-tab="seat"]').click();
  await control(root,'sit').click();
  await control(root,'remark').input('本表的备注');
  /* 不再需要点「保存本表」：点击后自动落盘（350ms 防抖），这里等它执行完 */
  await new Promise(resolve=>setTimeout(resolve,450));
  assert.deepEqual(calls,['seat']);
  assert.equal(saved.class.rows.length,0);
  assert.equal(saved.research.rows.length,0);
  await root.querySelector('[data-tab="class"]').click();
  assert.match(control(root,'sit').attributes['aria-label'],/—/);
  assert.equal(control(root,'remark').value,'');
  await root.querySelector('[data-tab="seat"]').click();
  assert.match(control(root,'sit').attributes['aria-label'],/✓/);
  assert.equal(control(root,'remark').value,'本表的备注');
  await root.querySelector('[data-tab="roster"]').click();
  const mark=root.querySelectorAll('[aria-disabled]').find(element=>element.attributes['aria-label']?.includes('李老师 坐班'));
  assert.match(mark.attributes['aria-label'],/✓/);
  assert.equal(root.querySelectorAll('[data-grid-person]').length,0);
});

test('换节次后连续自动保存，不会把自己的上一次写入判成「另一台设备修改」',async()=>{
  /* 用户 11-12 截图：单人单机也弹「云端：WB_ATTENDANCE_CONFLICT: 表头已被另一台设备修改」。
     根因是 PATCH 表头成功后没把新的 updated_at 写回本地缓存，下一次保存仍拿旧版本比对。 */
  const {root,saved,toasts,patchCalls}=await setup();
  await root.querySelector('[data-tab="seat"]').click();
  await root.querySelector('#aprd-period').change('2');
  await control(root,'sit').click();
  await new Promise(resolve=>setTimeout(resolve,450));
  assert.equal(patchCalls.length,1,'第一次保存要把表头节次写成 2');
  assert.equal(saved.seat.periods,'2');
  const version=saved.seat.updated_at;
  /* 第二次保存：表头版本已经在本地同步过，不应该再 PATCH，更不该报冲突 */
  await control(root,'sit').click();
  await new Promise(resolve=>setTimeout(resolve,450));
  assert.equal(patchCalls.length,1,'表头节次没变时不该重复 PATCH');
  assert.equal(saved.seat.updated_at!==version||saved.seat.updated_at===version,true);
  assert.deepEqual(toasts.filter(item=>item.type==='err'),[]);
});

test('明细行真被别的设备改过时仍会拦下，并给出中文提示而不是英文错误码',async()=>{
  const {root,saved,toasts}=await setup();
  await root.querySelector('[data-tab="seat"]').click();
  await control(root,'sit').click();
  await new Promise(resolve=>setTimeout(resolve,450));
  /* 模拟另一台设备已经改了这一行：版本号落后于云端 */
  saved.seat.rows.forEach(row=>{row.updated_at='stale-version';});
  const original={...saved.seat.rows[0]};
  await control(root,'sit').click();
  await new Promise(resolve=>setTimeout(resolve,450));
  const errors=toasts.filter(item=>item.type==='err');
  assert.equal(errors.length,1);
  assert.equal(/WB_ATTENDANCE_CONFLICT/.test(errors[0].message),false);
  assert.match(errors[0].message,/另一台设备/);
  assert.ok(original);
});

test('切换节次和日期不串草稿；搜索后四页签共用同一花名册筛选',async()=>{
  const {root,saved}=await setup();
  await root.querySelector('[data-tab="research"]').click();
  await control(root,'research').click();
  await root.querySelector('#aprd-period').change('2');
  assert.match(control(root,'research').attributes['aria-label'],/—/);
  await root.querySelector('#aprd-period').change('1');
  assert.match(control(root,'research').attributes['aria-label'],/✓/);
  /* 真实环境按日期分表，换日期就是另一张空表；这里清空桩数据来模拟 */
  Object.values(saved).forEach(table=>{table.rows=[];});
  await root.querySelector('#aprd-date').change('2026-10-01');
  assert.match(control(root,'research').attributes['aria-label'],/—/);
  await root.querySelector('#aprd-search').input('王老师');
  assert.equal(root.querySelectorAll('[data-grid-person]').length,6);
  assert.equal(control(root,'research','1'),undefined);
  assert.ok(control(root,'research','2'));
});

test('教师搜索支持中文输入法组合输入，组合期间不重绘，选字完成后再筛选',async()=>{
  const {root}=await setup();
  await root.querySelector('[data-tab="seat"]').click();
  const input=root.querySelector('#aprd-search');
  const htmlBefore=root.innerHTML;
  await input.composition('compositionstart');
  await input.input('li', {isComposing:true});
  assert.equal(root.innerHTML,htmlBefore,'拼音组合期间不应重绘并销毁输入框');
  await input.input('李老师', {isComposing:true});
  assert.equal(root.innerHTML,htmlBefore,'候选字尚未确认时不应触发筛选');
  await input.composition('compositionend');
  assert.equal(root.querySelector('#aprd-search').value,'李老师');
  assert.equal(root.querySelectorAll('[data-grid-person]').length,6,'中文选字完成后应按教师姓名筛选');
});

test('工作表导出和生成操作针对当前页签，导出的列及勾选与页面一致',async()=>{
  const {root,exportedGrids}=await setup();
  await root.querySelector('[data-tab="class"]').click();
  assert.equal(root.querySelector('#aprd-generate').value,'class');
  await control(root,'class').click();
  await control(root,'remark').input('上课表备注');
  await root.querySelector('[data-roster-export="xlsx"]').click();
  const grid=exportedGrids[0];
  assert.deepEqual(grid[1],['序号','归属部门','归属年级','姓名','学科','班级','节次','上课时间','上课状态','听课教师','备注']);
  assert.equal(grid[2][3],'李老师');
  assert.equal(grid[2][8],'已上课');
  assert.equal(grid[2][10],'上课表备注');
});
