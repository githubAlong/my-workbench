import { api, esc, toast, confirmDialog, saveBlob } from './core.js';
import { icon } from './ui.js';
import { createSlot } from './attday.js';
import { makeXlsx } from './attendance.js';
import { parseRosterFile, parseRosterText } from './roster-batch.mjs';
import {
  DEFAULT_PERIODS, LEAVE_TYPES, ATTENDANCE_COLUMNS,
  nextTriState, activeLeavesFor, deriveRosterState, calculateDailySummary,
} from './attendance-prd-domain.mjs';

const TABS = [
  ['roster','花名册'],['seat','坐班表'],['class','上课表'],
  ['research','教研表'],['leave','请假台账'],['summary','汇总统计表'],
];
const TYPE = { seat:'seat', class:'class', research:'research' };
const CHECK_LABEL = (v) => v === 'y' ? '✓' : v === 'n' ? '✗' : '—';
const TODAY = () => new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'});
const rowData = (r) => r?.data && typeof r.data === 'object' ? r.data : {};
const escAttr = esc;

async function chooseResearchAttendees(members){
  return new Promise(resolve=>{
    const dialog=document.createElement('div');dialog.className='aprd-dialog';
    dialog.innerHTML='<div class="aprd-editor"><h3>教研签到 · 勾选到场教师</h3><div class="aprd-check-list">'+members.map((name,i)=>'<label style="display:flex;grid-template-columns:auto 1fr;align-items:center"><input type="checkbox" value="'+esc(name)+'" checked> '+esc(name)+'</label>').join('')+'</div><div class="aprd-foot"><button data-cancel>取消</button><button class="primary" data-ok>确定登记</button></div></div>';
    document.body.append(dialog);
    dialog.querySelector('[data-cancel]').onclick=()=>{dialog.remove();resolve(members);};
    dialog.querySelector('[data-ok]').onclick=()=>{const selected=[...dialog.querySelectorAll('input:checked')].map(x=>x.value);dialog.remove();resolve(selected);};
  });
}


export async function renderAttendancePRD(root, { grade: initialGrade = '' } = {}) {
  let grades = (await api.get('/grades').catch(() => ({grades:[]}))).grades || [];
  let grade = grades.includes(initialGrade) ? initialGrade : (grades[0] || initialGrade || '');
  let date = TODAY(), period = 1, tab = 'roster', search = '', subject = '';
  let teachers = [], allTeachers = [], tables = [], details = {}, leaveRecords = [], prefs = {};
  let busy = false;
  const load = async () => {
    if (busy) return; busy = true;
    try {
      const [g, roster, list, me] = await Promise.all([
        api.get('/grades'), api.get('/teachers',{grade,active:'all'}),
        api.get('/attendance',{grade,sheet_date:date}), api.get('/me').catch(()=>({user:{settings:{}}})),
      ]);
      grades = g.grades || grades;
      allTeachers = roster.list || [];
      teachers = allTeachers.filter(t => Number(t.active ?? 1) === 1);
      tables = list || [];
      prefs = me.user?.settings?.attendanceWorkspace || {};
      leaveRecords = Array.isArray(prefs.leaves) ? prefs.leaves : [];
      details = {};
      for (const type of ['seat','class','research']) {
        const t = tables.find(x => (x.sheet_type || x.kind) === type && !x.deleted_at);
        if (t) details[type] = await api.get('/attendance/'+t.id);
      }
      paint();
    } catch(e) {
      root.innerHTML = '<div class="att-work-error">'+esc(e.message || '考勤数据加载失败')+'</div>';
    } finally { busy = false; }
  };
  const savePrefs = async (patch) => {
    prefs = {...prefs,...patch};
    const result = await api.patch('/me',{settings:{attendanceWorkspace:prefs}});
    if (result?.user?.settings?.attendanceWorkspace) prefs = result.user.settings.attendanceWorkspace;
  };
  const getTable = async (type) => {
    let t = details[type];
    if (!t) {
      t = await createSlot({date,grade,type,period:String(period)});
      t = await api.get('/attendance/'+t.id);
      details[type] = t;
    }
    return t;
  };
  const saveRows = async (table, rows) => {
    const payload = rows.map(r => ({id:r.id,teacher:r.teacher,subject:r.subject,data:rowData(r),expected_updated_at:r.updated_at || ''}));
    const res = await api.post('/attendance/'+table.id+'/rows',{rows:payload,dirty:true});
    if (Array.isArray(res?.ids)) rows.forEach((r,i)=>{ if(!r.id && res.ids[i]) r.id=res.ids[i]; });
    await api.patch('/attendance/'+table.id,{expected_updated_at:table.updated_at || '',periods:String(period)});
  };
  const persistAndReload = async (type, rows, message='已保存') => {
    const t = await getTable(type);
    await saveRows(t,rows);
    toast(message,'ok'); await load();
  };
  const visibleTeachers = () => teachers.filter(t =>
    (!search || (t.name+' '+t.subject).toLowerCase().includes(search.toLowerCase()))
    && (!subject || (t.subject || '未填学科') === subject)
  );
  const deptOf = (t) => prefs.teacherMeta?.[String(t.id)]?.department || '高中部';
  const noteOf = (t) => prefs.teacherMeta?.[String(t.id)]?.remark || '';
  const setTeacherMeta = async (t, patch) => {
    const teacherMeta = {...(prefs.teacherMeta || {}),[String(t.id)]:{...(prefs.teacherMeta?.[String(t.id)] || {}),...patch}};
    await savePrefs({teacherMeta});
  };
  const rosterKey = (row) => String(row.name || '').trim().replace(/\s+/g,'').toLowerCase() + '\u0000' + String(row.subject || '').trim().replace(/\s+/g,'').toLowerCase();
  const rosterGrid = (list) => [
    ['教师花名册 · '+grade],
    ['序号','归属部门','归属年级','姓名','学科','备注'],
    ...list.map((t,i)=>[i+1,deptOf(t),t.grade||grade,t.name,t.subject||'',noteOf(t)]),
  ];
  const downloadRosterTemplate = () => {
    const grid=[['教师花名册导入模板'],['序号','归属部门','归属年级','姓名','学科'],['1','高中部',grade,'','']];
    saveBlob(makeXlsx({title:'花名册导入模板',grid}),'教师花名册导入模板.xlsx');
  };
  const exportRoster = (format) => {
    const scope=root.querySelector('#aprd-export-scope')?.value || 'all';
    const list=scope==='filtered'?visibleTeachers():teachers.slice();
    if(!list.length){toast('当前没有可导出的教师','warn');return;}
    const grid=rosterGrid(list);
    const fileBase=(grade||'教师')+'花名册';
    if(format==='xlsx'){
      saveBlob(makeXlsx({title:fileBase,grid}),fileBase+'.xlsx');
    }else if(format==='csv'){
      const csv='\uFEFF'+grid.map(row=>row.map(value=>'"'+String(value??'').replace(/"/g,'""')+'"').join(',')).join('\r\n');
      saveBlob(new Blob([csv],{type:'text/csv;charset=utf-8'}),fileBase+'.csv');
    }else if(format==='pdf'){
      const win=window.open('','_blank');
      if(!win){toast('浏览器拦截了打印窗口，请允许本站弹出窗口后重试','warn');return;}
      const body=grid.slice(2).map(row=>'<tr>'+row.map(cell=>'<td>'+esc(cell)+'</td>').join('')+'</tr>').join('');
      win.document.write('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>'+esc(fileBase)+'</title><style>body{font-family:Arial,"Microsoft YaHei",sans-serif;padding:24px;color:#1d2939}h1{font-size:20px}p{color:#667085;font-size:12px}table{width:100%;border-collapse:collapse;font-size:12px}th,td{border:1px solid #d0d5dd;padding:8px;text-align:left}th{background:#f2f4f7}</style><h1>'+esc(fileBase)+'</h1><p>导出时间：'+esc(new Date().toLocaleString('zh-CN'))+'　共 '+list.length+' 人</p><table><thead><tr>'+grid[1].map(cell=>'<th>'+esc(cell)+'</th>').join('')+'</tr></thead><tbody>'+body+'</tbody></table><script>window.onload=function(){window.print()}<\/script></html>');
      win.document.close();
    }else if(format==='png'){
      const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d');
      const widths=[70,150,110,180,150,220], rowH=42, width=widths.reduce((a,b)=>a+b,0);
      canvas.width=width;canvas.height=76+(list.length+1)*rowH;
      ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);
      ctx.fillStyle='#172744';ctx.font='bold 22px "Microsoft YaHei",sans-serif';ctx.fillText(fileBase,20,30);
      ctx.fillStyle='#667085';ctx.font='12px "Microsoft YaHei",sans-serif';ctx.fillText('导出时间：'+new Date().toLocaleString('zh-CN')+'　共 '+list.length+' 人',20,53);
      const headers=grid[1];let y=76;
      let x=0;
      headers.forEach((label,i)=>{ctx.fillStyle='#eef3fa';ctx.fillRect(x,y,widths[i],rowH);ctx.strokeStyle='#d8e1ed';ctx.strokeRect(x,y,widths[i],rowH);ctx.fillStyle='#34445d';ctx.font='bold 12px "Microsoft YaHei",sans-serif';ctx.fillText(String(label),x+8,y+26);x+=widths[i];});
      list.forEach((teacher,index)=>{
        y+=rowH;x=0;
        const values=[index+1,deptOf(teacher),teacher.grade||grade,teacher.name,teacher.subject||'',noteOf(teacher)];
        values.forEach((value,i)=>{ctx.fillStyle=index%2?'#f9fbfe':'#fff';ctx.fillRect(x,y,widths[i],rowH);ctx.strokeStyle='#e3eaf3';ctx.strokeRect(x,y,widths[i],rowH);ctx.fillStyle='#34445d';ctx.font='12px "Microsoft YaHei",sans-serif';ctx.fillText(String(value??'').slice(0,24),x+8,y+26);x+=widths[i];});
      });
      canvas.toBlob(blob=>{if(blob)saveBlob(blob,fileBase+'.png');else toast('PNG 图片生成失败','err');},'image/png');
    }
    const menu=root.querySelector('[data-roster-export-menu]');if(menu)menu.hidden=true;
  };
  const openRosterImport = () => {
    const dialog=document.createElement('div');dialog.className='aprd-dialog aprd-roster-dialog';
    dialog.innerHTML='<section class="aprd-roster-import"><header><div><h3>批量导入教师名单</h3><p>导入目标年级：'+esc(grade)+' · 原有考勤记录不会被覆盖</p></div><button type="button" data-import-close aria-label="关闭">×</button></header><div class="aprd-import-body"><label class="aprd-upload-zone"><input id="aprd-import-file" type="file" accept=".xlsx,.xls,.xlsm,.csv,.tsv,.txt,.pdf,.png,.jpg,.jpeg,.webp"><span class="aprd-upload-icon">↑</span><b>选择 Excel、PDF 或图片文件</b><small>支持 XLSX / XLS / CSV / PDF / JPG / PNG / WebP</small></label><div class="aprd-import-paste"><label for="aprd-import-text">或者直接粘贴 Excel 表格</label><textarea id="aprd-import-text" rows="4" placeholder="复制 Excel 中的姓名、学科等列，然后粘贴到这里…"></textarea><button type="button" data-import-paste>解析粘贴内容</button><button type="button" data-import-template>下载 Excel 模板</button></div><div class="aprd-import-status" id="aprd-import-status" role="status">上传后会先识别并显示预览，只有点击“确认导入”才会写入花名册。</div><div class="aprd-import-warnings" id="aprd-import-warnings" hidden></div><div class="aprd-import-preview" id="aprd-import-preview" hidden><div class="aprd-import-summary" id="aprd-import-summary"></div><div class="aprd-import-table-wrap"><table><thead><tr><th>序号</th><th>姓名</th><th>学科</th><th>归属部门</th><th>来源年级</th><th>处理方式</th></tr></thead><tbody id="aprd-import-rows"></tbody></table></div></div></div><footer><button type="button" data-import-close>取消</button><button type="button" class="primary" data-import-confirm disabled>确认导入</button></footer></section>';
    document.body.append(dialog);
    let importRows=[];
    const $=(selector)=>dialog.querySelector(selector);
    const close=()=>dialog.remove();
    dialog.querySelectorAll('[data-import-close]').forEach(button=>button.onclick=close);
    $('[data-import-template]').onclick=downloadRosterTemplate;
    const updateStatus=(message)=>{$('#aprd-import-status').textContent=message;};
    const refreshDuplicates=()=>{
      const seen=new Set();
      importRows=importRows.map((row)=>{
        const key=rosterKey(row);
        const inFile=!!key&&seen.has(key);
        if(key)seen.add(key);
        const existing=allTeachers.find(t=>!t.deleted_at&&rosterKey(t)===key);
        let duplicateKind=inFile?'file':existing?'existing':'';
        let action=row.action||'add';
        if(inFile)action='skip';
        else if(existing){if(action==='add')action='skip';}
        else action='add';
        return {...row,duplicateKind,duplicateId:existing?.id||null,action};
      });
    };
    const renderPreview=()=>{
      refreshDuplicates();
      const preview=$('#aprd-import-preview');
      preview.hidden=false;
      const invalid=importRows.filter(row=>!String(row.name||'').trim()||!String(row.subject||'').trim()).length;
      const additions=importRows.filter(row=>row.action==='add').length;
      const updates=importRows.filter(row=>row.action==='update').length;
      const skipped=importRows.filter(row=>row.action==='skip').length;
      $('#aprd-import-summary').innerHTML='<b>识别 '+importRows.length+' 条</b><span>新增 '+additions+' 条</span><span>更新 '+updates+' 条</span><span>跳过 '+skipped+' 条</span>'+(invalid?'<strong>有 '+invalid+' 条缺少姓名或学科，请修正或跳过</strong>':'');
      $('#aprd-import-warnings').hidden=!importWarnings.length;
      $('#aprd-import-warnings').textContent=importWarnings.join('；');
      $('#aprd-import-rows').innerHTML=importRows.map((row,index)=>{
        const status=row.duplicateKind==='file'?'文件内重复':row.duplicateKind==='existing'?'名册已存在':(!row.name||!row.subject?'信息不完整':'可导入');
        const options=row.duplicateKind==='file'?'<option value="skip" selected>跳过重复行</option>':row.duplicateKind==='existing'?'<option value="skip" '+(row.action==='skip'?'selected':'')+'>跳过已存在</option><option value="update" '+(row.action==='update'?'selected':'')+'>更新已有人员</option>':'<option value="add" selected>新增人员</option>';
        return '<tr><td>'+esc(row.serial||index+1)+'</td><td><input data-import-field="name" data-index="'+index+'" value="'+esc(row.name||'')+'" aria-label="姓名"></td><td><input data-import-field="subject" data-index="'+index+'" value="'+esc(row.subject||'')+'" aria-label="学科"></td><td><input data-import-field="department" data-index="'+index+'" value="'+esc(row.department||'')+'" aria-label="归属部门" placeholder="高中部"></td><td>'+esc(row.grade||grade)+'</td><td><select data-import-action="'+index+'">'+options+'</select><small class="aprd-import-row-status">'+status+'</small></td></tr>';
      }).join('');
      $('[data-import-confirm]').disabled=!importRows.some(row=>row.action!=='skip'&&String(row.name||'').trim()&&String(row.subject||'').trim());
    };
    let importWarnings=[];
    const acceptParsed=(result)=>{
      importRows=(result.rows||[]).map((row,index)=>({...row,serial:row.serial||index+1,action:'add'}));
      importWarnings=[...(result.warnings||[])];
      if(result.grade&&result.grade!==grade)importWarnings.unshift('文件标题识别到'+result.grade+'，当前导入目标为'+grade+'；请确认名单属于当前年级。');
      renderPreview();
    };
    const parseFile=async(file)=>{
      if(!file)return;
      updateStatus('正在解析 '+file.name+'…');
      $('[data-import-confirm]').disabled=true;
      try{
        const result=await parseRosterFile(file,grade,updateStatus);
        acceptParsed(result);
        updateStatus('识别完成：'+result.rows.length+' 条，请逐项核对后确认导入。');
      }catch(error){updateStatus(error.message||'文件解析失败');toast(error.message||'文件解析失败','err');}
    };
    $('#aprd-import-file').onchange=()=>parseFile($('#aprd-import-file').files?.[0]);
    $('[data-import-paste]').onclick=async()=>{
      const text=$('#aprd-import-text').value.trim();
      if(!text){toast('请先粘贴 Excel 表格内容','warn');return;}
      updateStatus('正在解析粘贴的表格…');
      try{acceptParsed(await parseRosterText(text,grade));updateStatus('解析完成，请检查预览后确认导入。');}
      catch(error){updateStatus(error.message||'粘贴内容解析失败');toast(error.message||'解析失败','err');}
    };
    $('#aprd-import-rows').addEventListener('input',(event)=>{
      const input=event.target.closest('[data-import-field]');
      if(!input)return;
      const index=Number(input.dataset.index),field=input.dataset.importField;
      if(importRows[index])importRows[index][field]=input.value;
    });
    $('#aprd-import-rows').addEventListener('change',(event)=>{
      const action=event.target.closest('[data-import-action]');
      if(action){const row=importRows[Number(action.dataset.importAction)];if(row)row.action=action.value;renderPreview();return;}
      const field=event.target.closest('[data-import-field]');
      if(field&&['name','subject'].includes(field.dataset.importField))renderPreview();
    });
    $('[data-import-confirm]').onclick=async()=>{
      refreshDuplicates();
      const selected=importRows.filter(row=>row.action!=='skip');
      const invalid=selected.filter(row=>!String(row.name||'').trim()||!String(row.subject||'').trim());
      if(invalid.length){toast('请先补全 '+invalid.length+' 条记录的姓名和学科，或将其设为跳过','warn');return;}
      const additions=selected.filter(row=>row.action==='add');
      const updates=selected.filter(row=>row.action==='update'&&row.duplicateId);
      try{
        $('[data-import-confirm]').disabled=true;
        updateStatus('正在写入教师名单…');
        let addedIds=[];
        if(additions.length){
          const result=await api.post('/teachers',{grade,items:additions.map(row=>({name:row.name,subject:row.subject}))});
          addedIds=Array.isArray(result?.ids)?result.ids:[];
        }
        for(const row of updates){
          await api.patch('/teachers/'+row.duplicateId,{name:row.name,subject:row.subject,active:1});
        }
        const teacherMeta={...(prefs.teacherMeta||{})};
        additions.forEach((row,index)=>{
          const id=addedIds[index];
          if(id&&(row.department||''))teacherMeta[String(id)]={...(teacherMeta[String(id)]||{}),department:row.department};
        });
        updates.forEach(row=>{
          if(row.department)teacherMeta[String(row.duplicateId)]={...(teacherMeta[String(row.duplicateId)]||{}),department:row.department};
        });
        if(JSON.stringify(teacherMeta)!==JSON.stringify(prefs.teacherMeta||{}))await savePrefs({teacherMeta});
        close();
        await load();
        toast('导入完成：新增 '+additions.length+' 人，更新 '+updates.length+' 人，跳过 '+(importRows.length-additions.length-updates.length)+' 人','ok',3600);
      }catch(error){
        $('[data-import-confirm]').disabled=false;
        updateStatus(error.message||'导入失败，请检查名单后重试');
        toast(error.message||'导入失败','err');
      }
    };
  };

  const openEditor = (title, fields, initial, onSave) => {
    const dialog = document.createElement('div'); dialog.className='aprd-dialog';
    dialog.innerHTML = '<form class="aprd-editor"><h3>'+esc(title)+'</h3>'+
      fields.map(f=>'<label>'+esc(f.label)+(f.type==='select'?'<select name="'+escAttr(f.key)+'">'+f.options.map(o=>'<option '+(String(initial[f.key]??'')===String(o.value)?'selected':'')+' value="'+escAttr(o.value)+'">'+esc(o.label)+'</option>').join('')+'</select>':f.type==='textarea'?'<textarea name="'+escAttr(f.key)+'">'+esc(initial[f.key]||'')+'</textarea>':'<input name="'+escAttr(f.key)+'" type="'+(f.type||'text')+'" value="'+escAttr(initial[f.key]||'')+'" '+(f.required?'required':'')+'>')+'</label>').join('')+
      '<div class="aprd-foot"><button type="button" data-cancel>取消</button><button class="primary" type="submit">保存</button></div></form>';
    root.append(dialog); const form=dialog.querySelector('form');
    dialog.querySelector('[data-cancel]').onclick=()=>dialog.remove();
    form.onsubmit=async e=>{e.preventDefault();const data=Object.fromEntries(new FormData(form));try{await onSave(data);dialog.remove();}catch(err){toast(err.message||'保存失败','err');}};
  };
  const toggle = async (teacher,key) => {
    const t=await getTable('seat');
    let row=t.rows.find(r=>r.teacher===teacher.name);
    if(!row){row={teacher:teacher.name,subject:teacher.subject||'',data:{}};t.rows.push(row);}
    const d={...rowData(row)}, periods={...(d.__periods||{})}, cur={...(periods[String(period)]||{})};
    if(key==='listen'){
      cur.listen_class=cur.listen_class?'':'未指定班级';
    } else cur[key]=nextTriState(cur[key]||'u');
    periods[String(period)]=cur; d.__periods=periods; row.data=d;
    await persistAndReload('seat',t.rows);
  };
  const rosterHtml = () => {
    const list=visibleTeachers(), subjects=[...new Set(teachers.map(t=>t.subject||'未填学科'))].sort();
    const rows=list.map((t,i)=>{
      const st=deriveRosterState(t,{seatRows:details.seat?.rows||[],classRows:details.class?.rows||[],researchRows:details.research?.rows||[],leaveRecords,date,period});
      const mark=(key,val)=>'<button class="aprd-mark '+(val==='y'?'y':val==='n'?'n':'u')+'" data-person="'+t.id+'" data-key="'+key+'">'+CHECK_LABEL(val)+'</button>';
      return '<tr><td>'+(i+1)+'</td><td><button class="aprd-link" data-dept="'+t.id+'">'+esc(deptOf(t))+'</button></td><td><button class="aprd-link" data-grade="'+t.id+'">'+esc(t.grade||grade)+'</button></td><td><b>'+esc(t.name)+'</b></td><td>'+esc(t.subject||'')+'</td><td>'+mark('class',st.class)+'</td><td>'+mark('sit',st.sit)+'</td><td><button class="aprd-mark '+(st.listen?'y':'u')+'" data-person="'+t.id+'" data-key="listen">'+(st.listen?'✓':'—')+'</button></td><td><button class="aprd-mark '+(st.research?'y':'u')+'" data-person="'+t.id+'" data-key="research">'+(st.research?'✓':'—')+'</button></td><td><button class="aprd-mark" data-leave="'+t.id+'">'+esc(st.leave||'无')+'</button></td><td>'+esc(noteOf(t))+'</td><td><div class="aprd-actions"><button data-edit="'+t.id+'">编辑</button><button data-disable="'+t.id+'">停用</button></div></td></tr>';
    }).join('');
    return '<div class="aprd-toolbar"><input type="search" id="aprd-search" placeholder="搜索教师姓名" value="'+esc(search)+'"><select id="aprd-subject"><option value="">全部学科</option>'+subjects.map(s=>'<option '+(subject===s?'selected':'')+'>'+esc(s)+'</option>').join('')+'</select><button class="primary" data-add>新增人员</button><button data-roster-import>批量导入</button><div class="aprd-export-wrap"><button data-roster-export-toggle>批量导出 ▾</button><div class="aprd-export-menu" data-roster-export-menu hidden><label>导出范围 <select id="aprd-export-scope"><option value="all">全部在岗人员</option><option value="filtered">当前筛选结果</option></select></label><button data-roster-export="xlsx">Excel 表格</button><button data-roster-export="csv">CSV 文件</button><button data-roster-export="pdf">PDF 文档</button><button data-roster-export="png">PNG 图片</button></div></div><button data-copy>复制名单</button><button data-subject-manager>学科管理</button><span>当前筛：'+esc(subject||'全部')+' · '+list.length+' 人</span></div><div class="aprd-table-wrap"><table><thead><tr>'+ATTENDANCE_COLUMNS.roster.map(c=>'<th>'+c+'</th>').join('')+'</tr></thead><tbody>'+rows+'</tbody></table></div><p class="aprd-note">花名册仅显示当前年级在岗教师；状态按当前日期和节次读取。</p>';
  };
  const seatHtml = () => {
    const t=details.seat, rows=(t?.rows||[]).filter(r=>teachers.some(x=>x.name===r.teacher));
    const header=ATTENDANCE_COLUMNS.seat;
    return '<div class="aprd-toolbar"><span>在岗 '+rows.filter(r=>(rowData(r).__periods?.[String(period)]||{}).status==='y').length+' / 应到 '+teachers.length+'</span><button class="primary" data-save-seat>保存草稿</button></div><div class="aprd-table-wrap"><table><thead><tr>'+header.map(c=>'<th>'+c+'</th>').join('')+'</tr></thead><tbody>'+teachers.map((t,i)=>{const r=rows.find(x=>x.teacher===t.name), rec=rowData(r).__periods?.[String(period)]||{};return '<tr><td>'+(i+1)+'</td><td>'+esc(t.name)+'</td><td>'+esc(t.subject||'')+'</td><td>'+esc(t.grade+' / '+deptOf(t))+'</td><td><select data-seat="'+t.id+'" data-k="status"><option value="u">— 未登记</option><option value="y" '+(rec.status==='y'?'selected':'')+'>✓ 在坐班</option><option value="n" '+(rec.status==='n'?'selected':'')+'>✗ 未坐班</option></select></td><td>'+esc(activeLeavesFor(leaveRecords,date,grade).find(x=>x.name===t.name)?.type||'—')+'</td><td><input data-seat="'+t.id+'" data-k="listen_class" value="'+esc(rec.listen_class||'')+'" placeholder="听课班级"></td><td><input data-seat="'+t.id+'" data-k="remark" value="'+esc(rec.remark||'')+'"></td></tr>';}).join('')+'</tbody></table></div>';
  };
  const classHtml = () => {
    const t=details.class, rows=(t?.rows||[]).filter(r=>rowData(r).__classRecord);
    return '<div class="aprd-toolbar"><button class="primary" data-add-class>新增班级记录</button><button data-save-class>保存草稿</button></div><div class="aprd-table-wrap"><table><thead><tr>'+ATTENDANCE_COLUMNS.class.map(c=>'<th>'+c+'</th>').join('')+'</tr></thead><tbody>'+rows.map((r,i)=>{const d=rowData(r).__classRecord||{};return '<tr><td>'+(i+1)+'</td><td>'+esc(d.class_name||'')+'</td><td>第'+esc(d.period||period)+'节</td><td>'+esc(r.teacher||'')+'</td><td>'+esc(r.subject||'')+'</td><td><select data-class="'+i+'" data-k="status"><option value="u">— 未登记</option><option value="y" '+(d.status==='y'?'selected':'')+'>✓ 在班</option><option value="n" '+(d.status==='n'?'selected':'')+'>✗ 空堂</option></select></td><td><input data-class="'+i+'" data-k="listeners" value="'+esc((d.listeners||[]).join('、'))+'" placeholder="听课教师，多人用顿号分隔"></td><td><input data-class="'+i+'" data-k="remark" value="'+esc(d.remark||'')+'"></td></tr>';}).join('')+'</tbody></table></div>';
  };
  const researchHtml = () => {
    const rows=(details.research?.rows||[]).filter(r=>rowData(r).__research);
    const subs=[...new Set(teachers.map(t=>t.subject).filter(Boolean))];
    return '<div class="aprd-toolbar"><button class="primary" data-add-research>新增教研记录</button><button data-save-research>保存草稿</button></div><div class="aprd-table-wrap"><table><thead><tr>'+ATTENDANCE_COLUMNS.research.map(c=>'<th>'+c+'</th>').join('')+'</tr></thead><tbody>'+rows.map((r,i)=>{const d=rowData(r).__research;return '<tr><td>'+esc(d.subject)+'</td><td>'+esc(d.period_time||'')+'</td><td>'+esc(d.location||'')+'</td><td>'+esc(d.host||'')+'</td><td>'+d.expected+'</td><td>'+d.attendees.length+'</td><td><span style="color:#d34b4b">'+esc(d.absent.join('、')||'无')+'</span></td><td>'+esc(d.status||'待登记')+'</td></tr>';}).join('')+'</tbody></table></div>';
  };
  const leaveHtml = () => {
    const shown=leaveRecords.filter(x=>(!search||(x.name+' '+x.subject).includes(search))&&(!subject||x.subject===subject));
    return '<div class="aprd-toolbar"><input type="search" id="aprd-search" placeholder="搜索教师姓名" value="'+esc(search)+'"><button class="primary" data-add-leave>新增请假</button></div><div class="aprd-table-wrap"><table><thead><tr>'+ATTENDANCE_COLUMNS.leave.map(c=>'<th>'+c+'</th>').join('')+'<th>操作</th></tr></thead><tbody>'+shown.map((x)=>'<tr><td>'+esc(x.name)+'</td><td>'+esc(x.subject)+'</td><td>'+esc(x.type)+'</td><td>'+esc(x.start_date)+'</td><td>'+esc(x.end_date)+'</td><td>'+esc(x.days)+'</td><td><span class="aprd-status '+(x.status==='已批'?'approved':'pending')+'">'+esc(x.status)+'</span></td><td>'+esc(x.remark||'')+'</td><td><button data-edit-leave="'+x.id+'">编辑</button> <button data-delete-leave="'+x.id+'">删除</button></td></tr>').join('')+'</tbody></table></div>';
  };
  const summaryHtml = () => {
    const s=calculateDailySummary({teachers,seatRows:details.seat?.rows||[],classRows:details.class?.rows||[],researchRows:details.research?.rows||[],leaveRecords,date});
    const kpis=[['应到教师',s.expectedTeachers+'人'],['坐班在岗率',s.seatRate+'%'],['上课节次',s.classes],['听课人次',s.listens],['请假人数',s.leavePeople+'人']];
    return '<div class="aprd-kpis">'+kpis.map(([a,b],i)=>'<div class="aprd-kpi"><span>'+a+'</span><b style="'+(i===1&&s.seatRate<80?'color:#e5484d':'')+'">'+b+'</b></div>').join('')+'</div><div class="aprd-table-wrap"><table><thead><tr>'+ATTENDANCE_COLUMNS.summary.map(c=>'<th>'+c+'</th>').join('')+'</tr></thead><tbody>'+s.rows.map(r=>'<tr><td>'+r.serial+'</td><td>'+esc(r.name)+'</td><td>'+esc(r.subject)+'</td><td>'+r.seatPresent+'/'+r.seatExpected+'</td><td>'+r.classes+'</td><td>'+r.listens+'</td><td>'+r.research+'</td><td>'+r.leaveDays+'</td><td>'+esc(r.overall)+'</td></tr>').join('')+'</tbody></table></div>';
  };
  const paint = () => {
    const content = tab==='roster'?rosterHtml():tab==='seat'?seatHtml():tab==='class'?classHtml():tab==='research'?researchHtml():tab==='leave'?leaveHtml():summaryHtml();
    root.innerHTML='<div class="attendance-prd"><div class="aprd-head"><h2>考勤工作台</h2><div class="aprd-grade">'+grades.map(g=>'<button data-grade="'+esc(g)+'" class="'+(g===grade?'on':'')+'">'+esc(g)+'</button>').join('')+'</div><span style="margin-left:auto;color:#168448;font-size:12px">数据已加载</span></div><div class="aprd-meta"><label>日期 <input type="date" id="aprd-date" value="'+date+'"></label><button data-day="-1">‹</button><button data-day="1">›</button><label>节次 <select id="aprd-period">'+DEFAULT_PERIODS.map(p=>'<option value="'+p.no+'" '+(p.no===period?'selected':'')+'>'+p.label+'</option>').join('')+'</select></label><label>时段 <input type="time" id="aprd-start" value="'+DEFAULT_PERIODS[period-1].start+'">—<input type="time" id="aprd-end" value="'+DEFAULT_PERIODS[period-1].end+'"></label><select id="aprd-generate"><option value="seat">生成坐班表</option><option value="class">生成上课表</option><option value="research">生成教研表</option></select><button class="primary" data-generate>确认生成</button></div><nav class="aprd-tabs">'+TABS.map(([id,label])=>'<button data-tab="'+id+'" class="'+(tab===id?'on':'')+'">'+label+'</button>').join('')+'</nav><section class="aprd-panel">'+content+'</section></div>';
    root.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>{tab=b.dataset.tab;search='';subject='';paint();});
    root.querySelectorAll('[data-grade]').forEach(b=>b.onclick=async()=>{grade=b.dataset.grade;await load();});
    root.querySelector('#aprd-date').onchange=e=>{date=e.target.value;load();};
    root.querySelectorAll('[data-day]').forEach(b=>b.onclick=()=>{const d=new Date(date+'T00:00:00');d.setDate(d.getDate()+Number(b.dataset.day));date=d.toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'});load();});
    root.querySelector('#aprd-period').onchange=e=>{period=Number(e.target.value);paint();};
    root.querySelector('[data-generate]').onclick=async()=>{const type=root.querySelector('#aprd-generate').value;try{await getTable(type);toast('已生成'+({seat:'坐班表',class:'上课表',research:'教研表'}[type])+'草稿','ok');await load();tab=type;paint();}catch(e){toast(e.message||'生成失败','err');}};
    root.querySelector('#aprd-search')?.addEventListener('input',e=>{search=e.target.value;const p=e.target.selectionStart;paint();const q=root.querySelector('#aprd-search');q?.focus();q?.setSelectionRange(p,p);});
    root.querySelectorAll('[data-person]').forEach(b=>b.onclick=async()=>{const t=teachers.find(x=>String(x.id)===b.dataset.person);if(b.dataset.key==='research')return toast('请在教研表登记到场情况','warn');if(b.dataset.key==='class')return toast('请在上课表按班级登记','warn');await toggle(t,b.dataset.key==='sit'?'status':'listen');});
    root.querySelectorAll('[data-leave]').forEach(b=>b.onclick=()=>{const t=teachers.find(x=>String(x.id)===b.dataset.leave);openEditor('登记请假',[{key:'type',label:'请假类型',type:'select',options:[{value:'',label:'无'},...LEAVE_TYPES.map(x=>({value:x,label:x}))]},{key:'remark',label:'备注'}],{type:'',remark:''},async d=>{leaveRecords=leaveRecords.filter(x=>x.name!==t.name||!activeLeavesFor([x],date,grade).length);if(d.type)leaveRecords.push({id:Date.now(),grade,name:t.name,subject:t.subject,type:d.type,start_date:date,end_date:date,days:1,status:'待批',remark:d.remark});await savePrefs({leaves:leaveRecords});await load();});});
    root.querySelectorAll('[data-grade]').forEach(()=>{});
    root.querySelector('[data-add]')?.addEventListener('click',()=>openEditor('新增教师',[{key:'name',label:'姓名',required:true},{key:'subject',label:'学科',required:true},{key:'department',label:'归属部门'}],{department:'高中部'},async d=>{await api.post('/teachers',{grade,name:d.name,subject:d.subject});const list=await api.get('/teachers',{grade,active:'all'});const t=list.list.find(x=>x.name===d.name);if(t)await setTeacherMeta(t,{department:d.department});await load();}));
    root.querySelector('[data-roster-import]')?.addEventListener('click',openRosterImport);
    root.querySelector('[data-roster-export-toggle]')?.addEventListener('click',()=>{
      const menu=root.querySelector('[data-roster-export-menu]');
      if(menu)menu.hidden=!menu.hidden;
    });
    root.querySelectorAll('[data-roster-export]').forEach(button=>button.addEventListener('click',()=>exportRoster(button.dataset.rosterExport)));

    root.querySelector('[data-copy]')?.addEventListener('click',()=>{const names=visibleTeachers().map(t=>t.name).join('\n');navigator.clipboard?.writeText(names);toast('已复制当前名单','ok');});
    root.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>{const t=teachers.find(x=>String(x.id)===b.dataset.edit);openEditor('编辑教师',[{key:'name',label:'姓名',required:true},{key:'subject',label:'学科',required:true},{key:'department',label:'归属部门'},{key:'remark',label:'备注'}],{name:t.name,subject:t.subject,department:deptOf(t),remark:noteOf(t)},async d=>{await api.patch('/teachers/'+t.id,{name:d.name,subject:d.subject});await setTeacherMeta(t,{department:d.department,remark:d.remark});await load();});});
    root.querySelectorAll('[data-disable]').forEach(b=>b.onclick=async()=>{if(await confirmDialog('停用该教师？')){await api.patch('/teachers/'+b.dataset.disable,{active:0});await load();}});
    root.querySelector('[data-add-leave]')?.addEventListener('click',()=>{const t=teachers[0];if(!t)return;openEditor('新增请假',[{key:'teacher',label:'教师',type:'select',options:teachers.map(x=>({value:x.name,label:x.name+' · '+x.subject}))},{key:'type',label:'类型',type:'select',options:LEAVE_TYPES.map(x=>({value:x,label:x}))},{key:'start_date',label:'开始',type:'date'},{key:'end_date',label:'结束',type:'date'},{key:'days',label:'天数',type:'number'},{key:'status',label:'状态',type:'select',options:['待批','已批'].map(x=>({value:x,label:x}))},{key:'remark',label:'备注'}],{teacher:t.name,start_date:date,end_date:date,days:1,status:'待批'},async d=>{const who=teachers.find(x=>x.name===d.teacher);leaveRecords.push({id:Date.now(),grade,name:who.name,subject:who.subject,type:d.type,start_date:d.start_date,end_date:d.end_date,days:Number(d.days),status:d.status,remark:d.remark});await savePrefs({leaves:leaveRecords});await load();});});
    root.querySelectorAll('[data-delete-leave]').forEach(b=>b.onclick=async()=>{if(await confirmDialog('删除这条请假记录？')){leaveRecords=leaveRecords.filter(x=>String(x.id)!==b.dataset.deleteLeave);await savePrefs({leaves:leaveRecords});await load();}});
    root.querySelectorAll('[data-edit-leave]').forEach(b=>b.onclick=()=>toast('请假记录编辑功能即将完善','warn'));
    root.querySelector('[data-add-class]')?.addEventListener('click',()=>openEditor('新增班级上课记录',[{key:'class_name',label:'班级',required:true},{key:'teacher',label:'任课教师',type:'select',options:teachers.map(x=>({value:x.name,label:x.name}))},{key:'period',label:'节次',type:'select',options:DEFAULT_PERIODS.map(x=>({value:x.no,label:x.label}))}],{period},async d=>{const t=await getTable('class');const teacher=teachers.find(x=>x.name===d.teacher);t.rows.push({teacher:teacher?.name||'',subject:teacher?.subject||'',data:{__classRecord:{class_name:d.class_name,period:Number(d.period),status:'u',listeners:[],remark:''}}});await saveRows(t,t.rows);await load();}));
    root.querySelectorAll('[data-class]').forEach(el=>el.onchange=async()=>{const t=await getTable('class'),r=t.rows.filter(x=>rowData(x).__classRecord)[Number(el.dataset.class)];const d={...rowData(r).__classRecord};if(el.dataset.k==='listeners')d.listeners=el.value.split(/[、,，]/).map(x=>x.trim()).filter(Boolean);else d[el.dataset.k]=el.value;r.data={...rowData(r),__classRecord:d};await saveRows(t,t.rows);await load();});
    root.querySelector('[data-save-class]')?.addEventListener('click',()=>toast('上课表已自动保存','ok'));
    root.querySelector('[data-save-seat]')?.addEventListener('click',async()=>{const t=await getTable('seat');for(const el of root.querySelectorAll('[data-seat]')){const teacher=teachers.find(x=>String(x.id)===el.dataset.seat);let row=t.rows.find(x=>x.teacher===teacher.name);if(!row){row={teacher:teacher.name,subject:teacher.subject,data:{}};t.rows.push(row);}const d={...rowData(row)},p={...(d.__periods||{})},rec={...(p[String(period)]||{})};rec[el.dataset.k]=el.value;p[String(period)]=rec;d.__periods=p;row.data=d;}await persistAndReload('seat',t.rows);});
    root.querySelector('[data-add-research]')?.addEventListener('click',()=>openEditor('新增教研记录',[{key:'subject',label:'学科',type:'select',options:[...new Set(teachers.map(t=>t.subject))].filter(Boolean).map(x=>({value:x,label:x}))},{key:'period_time',label:'节次/时间'},{key:'location',label:'地点'},{key:'host',label:'主持人',type:'select',options:teachers.map(x=>({value:x.name,label:x.name}))}],{period_time:'第'+period+'节'},async d=>{const t=await getTable('research'),members=teachers.filter(x=>x.subject===d.subject).map(x=>x.name);const attendees=members.slice();const picked=await chooseResearchAttendees(members);t.rows.push({teacher:d.subject,subject:d.subject,data:{__research:{...d,expected:members.length,attendees:picked,absent:members.filter(x=>!picked.includes(x)),status:'已登记'}}});await saveRows(t,t.rows);await load();}));
    root.querySelector('[data-save-research]')?.addEventListener('click',()=>toast('教研记录已自动保存','ok'));
    root.querySelector('[data-subject-manager]')?.addEventListener('click',()=>toast('学科管理请在名册管理入口维护','warn'));
  };
  await load();
}
