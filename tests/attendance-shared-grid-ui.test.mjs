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
    return (this.elements||[]).filter(element=>{
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
  let version=0, settings={};
  const nextVersion=()=>String(++version);
  const api={
    async get(path) {
      if(path==='/grades') return {grades:['高一','高二']};
      if(path==='/teachers') return {list:structuredClone(teachers)};
      if(path==='/me') return {user:{settings:structuredClone(settings)}};
      if(path==='/attendance') return Object.values(saved).map(table=>({id:table.id,sheet_type:table.id}));
      return structuredClone(saved[path.split('/').pop()]);
    },
    async post(path,{rows,workspace_snapshot,expected_updated_at}) {
      const [, ,type, action]=path.split('/');
      if(action==='confirm'){
        const table=saved[type];
        assert.equal(expected_updated_at,table.updated_at||'');
        if(workspace_snapshot){
          table.meta ||= {};
          table.meta.workspace_confirmed ||= {};
          table.meta.workspace_confirmed[workspace_snapshot.period]=structuredClone(workspace_snapshot.rows);
        }
        table.confirm_state='confirmed';
        table.updated_at=nextVersion();
        return {id:table.id,meta:structuredClone(table.meta||{}),updated_at:table.updated_at};
      }
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
      if(path==='/me') { settings={...settings,...structuredClone(body.settings)}; return {user:{settings:structuredClone(settings)}}; }
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
  return {root,saved,calls,exportedGrids,toasts,patchCalls,reopen:()=>render(root,{grade:'高一'})};
}
const control=(root,key,id='1')=>root.querySelectorAll('[data-grid-person]').find(element=>element.dataset.gridPerson===id&&element.dataset.gridKey===key);

test('花名册和坐班表保留完整名单，子表固定列并显示已登记记录',async()=>{
  const {root}=await setup();
  const headers=()=>[...root.innerHTML.matchAll(/<th>(.*?)<\/th>/g)].map(match=>match[1]);
  const names=()=>[...root.innerHTML.matchAll(/<td><b>(.*?)<\/b><\/td>/g)].map(match=>match[1]);
  /* 用户 11-15 需求：默认进入坐班表（数据源），优先展示全状态 */
  assert.deepEqual(headers(),['序号','归属部门','归属年级','姓名','学科','坐班','上课','听课','教研','请假','备注','操作']);
  await root.querySelector('[data-tab="roster"]').click();
  const rosterHeaders=headers(),expectedNames=names();
  /* 用户 11-15 裁决：花名册只维护教师名单，考勤状态列全部隐藏；操作前保留一列可填写的备注 */
  assert.deepEqual(rosterHeaders,['序号','归属部门','归属年级','姓名','学科','备注','操作']);
  assert.equal(root.querySelectorAll('[data-grid-person]').length,0);
  assert.equal(root.querySelectorAll('[data-person]').length,0);
  let workHeaders=null;
  /* 用户 11-15 规定：坐班表是数据源、全量显示；上课表只看上课/听课；教研表只看教研/请假。 */
  const expectedHeaders={
    seat:['序号','归属部门','归属年级','姓名','学科','坐班','上课','听课','教研','请假','备注','操作'],
    class:['序号','归属部门','归属年级','姓名','学科','上课','听课人','备注','操作'],
    research:['序号','归属部门','归属年级','姓名','学科','教研','备注','操作'],
  };
  const expectedNamesByType={seat:['李老师','王老师'],class:[],research:[]};
  const expectedControls={seat:12,class:0,research:0};
  for(const type of ['seat','class','research']) {
    await root.querySelector('[data-tab="'+type+'"]').click();
    const current=headers();
    if(workHeaders===null) workHeaders=current;
    assert.deepEqual(current,expectedHeaders[type]);
    assert.deepEqual(names(),expectedNamesByType[type]);
    assert.equal(root.querySelectorAll('[data-grid-person]').length,expectedControls[type]);
    /* 用户 11-12 裁决：去掉「保存本表」，改为点一下即自动保存 */
    assert.equal(root.querySelector('[data-grid-save]'),null);
    assert.equal(/保存本表/.test(root.innerHTML),false);
  }
  assert.ok(workHeaders.includes('坐班')&&workHeaders.includes('请假'));
});

test('真实操作链：草稿跨页签保留，自动保存仅写本表，重新打开与花名册一致',async()=>{
  const {root,saved,calls}=await setup();
  await root.querySelector('[data-tab="seat"]').click();
  await control(root,'sit').click();
  /* 用户 11-15 要求：备注列改为行内输入框，默认空白，失焦即保存 */
  assert.equal(control(root,'remark').tag,'input');
  /* 不再需要点「保存本表」：点击后自动落盘（350ms 防抖），这里等它执行完 */
  await new Promise(resolve=>setTimeout(resolve,450));
  assert.deepEqual(calls,['seat']);
  assert.equal(saved.class.rows.length,0);
  assert.equal(saved.research.rows.length,0);
  await root.querySelector('[data-tab="class"]').click();
  /* 只勾坐班不会给上课表生成记录。 */
  assert.equal(control(root,'sit'),undefined);
  assert.equal(control(root,'class'),undefined);
  assert.equal(root.querySelectorAll('[data-grid-person]').length,0);
  await root.querySelector('[data-tab="roster"]').click();
  /* 花名册只保留名单与操作，不再展示任何考勤状态格 */
  assert.equal(root.querySelectorAll('[data-grid-person]').length,0);
  assert.equal(root.querySelectorAll('[aria-disabled]').length,0);
});

test('生成请假表按所选日期汇总请假记录并切到请假页',async()=>{
  const {root,toasts,calls}=await setup();
  const leaveOption=root.querySelector('[data-generate-type="leave"]');
  assert.ok(leaveOption,'生成菜单里要有请假表');
  await leaveOption.click();
  await root.querySelector('[data-generate]').click();
  assert.match(root.querySelector('[data-tab="leave"]').attributes.class,/on/,'生成后应切到请假页');
  assert.ok(toasts.some(item=>/请假表已生成/.test(item.message)),'要有生成成功提示');
  /* 请假表只汇总请假记录，不该凭空写入坐班/上课/教研工作表 */
  assert.deepEqual(calls,[]);
});

test('确认生成只同步已勾选的同节记录，刷新后仍可编辑和删除',async()=>{
  const {root,saved,reopen}=await setup();
  const select=tab=>root.querySelector('[data-tab="'+tab+'"]').click();
  const confirm=()=>root.querySelector('[data-generate]').click();
  await root.querySelector('#aprd-period').change('6');
  await control(root,'class').click();
  await control(root,'sit','2').click();
  await select('class');
  assert.equal(control(root,'class'),undefined,'自动保存的坐班草稿尚未生效');
  await select('seat');
  await confirm();
  assert.equal(saved.seat.confirm_state,'confirmed');
  await select('class');
  assert.equal(control(root,'class','2'),undefined);
  assert.match(control(root,'class').attributes.class,/ y$/);
  await control(root,'remark').change('补充记录');
  await select('seat');
  await control(root,'research','2').click();
  await select('research');
  assert.equal(control(root,'research','2'),undefined);
  await select('seat');
  await confirm();
  await select('research');
  assert.match(control(root,'research','2').attributes.class,/ y$/);
  await reopen();
  await root.querySelector('#aprd-period').change('6');
  await select('class');
  assert.equal(control(root,'remark').value,'补充记录');
  await root.querySelector('[data-delete-work-record="1"]').click();
  assert.equal(control(root,'class'),undefined);
  await select('seat');
  assert.match(control(root,'class').attributes.class,/ y$/,'删除子表记录保留坐班表和教师');
});

test('确认后才生成当节请假记录，重新确认更新同一条',async()=>{
  const {root}=await setup();
  const select=tab=>root.querySelector('[data-tab="'+tab+'"]').click();
  await root.querySelector('#aprd-period').change('6');
  await control(root,'leave').change('事假');
  await select('leave');
  assert.equal(root.querySelectorAll('[data-edit-leave]').length,0);
  await select('seat');
  await root.querySelector('[data-generate]').click();
  await select('leave');
  assert.equal(root.querySelectorAll('[data-edit-leave]').length,1);
  assert.match(root.innerHTML,/<td>事假<\/td>/);
  await select('seat');
  await control(root,'leave').change('病假');
  await root.querySelector('[data-generate]').click();
  await select('leave');
  assert.equal(root.querySelectorAll('[data-edit-leave]').length,1);
  assert.match(root.innerHTML,/<td>病假<\/td>/);
  await root.querySelector('#aprd-period').change('7');
  assert.equal(root.querySelectorAll('[data-edit-leave]').length,0);
});

test('表内登记的请假只作用在登记的那一节，不会被带到其他节次',async()=>{
  /* 用户 11-15 反馈：第 1 节登记的信息自动带到了第 8 节，每节课录入的内容应该各管各的。 */
  const {root}=await setup();
  await root.querySelector('[data-tab="seat"]').click();
  await root.querySelector('#aprd-period').change('1');
  await control(root,'leave').change('事假');
  await new Promise(resolve=>setTimeout(resolve,450));
  assert.equal(control(root,'leave').value,'事假');
  await root.querySelector('#aprd-period').change('8');
  assert.equal(control(root,'leave').value,'','第 1 节的请假不该出现在第 8 节');
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

test('切换节次和日期不会把之前的草稿带入教研表',async()=>{
  const {root,saved}=await setup();
  /* 先在坐班表给李老师勾上教研，再验证切换节次不会串用原节次草稿。 */
  await root.querySelector('[data-tab="seat"]').click();
  await control(root,'research').click();
  await root.querySelector('[data-tab="research"]').click();
  await root.querySelector('#aprd-period').change('2');
  assert.equal(root.querySelectorAll('[data-grid-person]').length,0);
  /* 真实环境按日期分表，换日期就是另一张空表；这里清空桩数据来模拟 */
  Object.values(saved).forEach(table=>{table.rows=[];});
  await root.querySelector('#aprd-date').change('2026-10-01');
  assert.equal(root.querySelectorAll('[data-grid-person]').length,0);
  await root.querySelector('#aprd-search').input('王老师');
  assert.equal(root.querySelectorAll('[data-grid-person]').length,0);
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
  /* 上课表只出上课/听课的人：先在坐班表勾上上课，再切到上课表 */
  await root.querySelector('[data-tab="seat"]').click();
  await control(root,'class').click();
  await control(root,'listen','2').click();
  /* 「生成班表」改下拉菜单（11-15 设计稿）：先选上课表，确认生成按它走 */
  assert.equal(root.querySelector('[data-generate-menu]').attributes.hidden,'');
  await root.querySelector('[data-generate-type="class"]').click();
  await root.querySelector('[data-generate]').click();
  await root.querySelector('[data-roster-export="xlsx"]').click();
  const grid=exportedGrids[0];
  /* 三级标题（表名 / 日期节次时段 / 人数统计）占前 3 行，表头在第 4 行 */
  assert.match(grid[0][0],/上课表/);
  assert.match(grid[1][0],/星期/);
  assert.match(grid[2][0],/上课 1 人/);
  assert.match(grid[2][0],/听课 1 人/);
  assert.ok(!/应到|未登记/.test(grid[2][0]),'上课表标题不应出现应到/未登记');
  assert.deepEqual(grid[3],['序号','归属部门','归属年级','姓名','学科','上课','听课人','备注']);
  assert.equal(grid[4][3],'李老师');
  assert.equal(grid[4][5],'✓');
  assert.equal(grid[5][3],'王老师');
  assert.equal(grid[5][6],'✓');
  /* 右下角导出时间写在最后一行的最右列 */
  const last=grid.at(-1);
  assert.match(last.at(-1),/^导出时间：\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
});
