import { api, esc, toast, confirmDialog, saveBlob } from './core.js';
import { icon } from './ui.js';
import { createSlot } from './attday.js';
import { makeXlsx } from './attendance.js';
import { parseRosterFile, parseRosterText } from './roster-batch.mjs';
import {
  DEFAULT_PERIODS, LEAVE_TYPES, ATTENDANCE_COLUMNS,
  nextTriState, activeLeavesFor, deriveRosterState, calculateDailySummary,
  matchesAttendancePeriod,
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

async function chooseResearchAttendees(members, selected = members){
  return new Promise(resolve=>{
    const chosen=new Set(selected);
    const dialog=document.createElement('div');dialog.className='aprd-dialog';
    dialog.innerHTML='<div class="aprd-editor"><h3>教研签到 · 勾选到场教师</h3><div class="aprd-check-list">'+members.map(name=>'<label style="display:flex;grid-template-columns:auto 1fr;align-items:center"><input type="checkbox" value="'+esc(name)+'" '+(chosen.has(name)?'checked':'')+'> '+esc(name)+'</label>').join('')+'</div><div class="aprd-foot"><button data-cancel>取消</button><button class="primary" data-ok>确定登记</button></div></div>';
    document.body.append(dialog);
    dialog.querySelector('[data-cancel]').onclick=()=>{dialog.remove();resolve(null);};
    dialog.querySelector('[data-ok]').onclick=()=>{const picked=[...dialog.querySelectorAll('input:checked')].map(x=>x.value);dialog.remove();resolve(picked);};
  });
}


export async function renderAttendancePRD(root, { grade: initialGrade = '' } = {}) {
  let grades = (await api.get('/grades').catch(() => ({grades:[]}))).grades || [];
  let grade = grades.includes(initialGrade) ? initialGrade : (grades[0] || initialGrade || '');
  let date = TODAY(), period = 1, tab = 'roster', search = '', subject = '';
  let teachers = [], allTeachers = [], tables = [], details = {}, leaveRecords = [], prefs = {};
  let showAddTeacher = true;
  const draftCache = new Map();
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
    if (type === 'class') {
      const rows = Array.isArray(t.rows) ? t.rows.slice() : [];
      let changed = false;
      for (const teacher of teachers) {
        const hasPeriodRow = rows.some(row => {
          const data = rowData(row), record = data.__classRecord || {};
          return !data.__deleted && row.teacher === teacher.name
            && Number(record.period || period) === Number(period);
        });
        if (hasPeriodRow) continue;
        let row = rows.find(item => item.teacher === teacher.name
          && !rowData(item).__classRecord && !rowData(item).__deleted);
        if (!row) {
          row = {teacher:teacher.name,subject:teacher.subject||'',data:{}};
          rows.push(row);
        }
        row.data = {...rowData(row),__classRecord:{
          class_name:'',period:Number(period),status:'u',listeners:[],remark:'',
        }};
        changed = true;
      }
      if (changed) {
        await saveRows(t,rows);
        t = await api.get('/attendance/'+t.id);
        details[type] = t;
      }
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

  const draftKey = type => [grade,date,period,type].join('|');
  const cloneAttendanceRow = row => ({...row,data:{...rowData(row)}});
  const getDraftRows = type => {
    const key=draftKey(type);
    if(!draftCache.has(key)){
      const source=(details[type]?.rows||[]).map(cloneAttendanceRow);
      let rows=[];
      if(type==='seat')rows=source;
      else if(type==='class')rows=source.filter(row=>!!rowData(row).__classRecord
        && Number(rowData(row).__classRecord.period||period)===Number(period));
      else if(type==='research')rows=source.filter(row=>!!rowData(row).__research
        && matchesAttendancePeriod(rowData(row).__research.period_time,period));
      draftCache.set(key,rows);
    }
    const rows=draftCache.get(key);
    if(type==='seat'){
      for(const teacher of teachers)if(!rows.some(row=>row.teacher===teacher.name))
        rows.push({teacher:teacher.name,subject:teacher.subject||'',data:{__periods:{}}});
    }else if(type==='class'){
      for(const teacher of teachers){
        const exists=rows.some(row=>!rowData(row).__deleted&&row.teacher===teacher.name
          && Number(rowData(row).__classRecord?.period||period)===Number(period));
        if(!exists)rows.push({teacher:teacher.name,subject:teacher.subject||'',data:{__classRecord:{
          class_name:'',period:Number(period),status:'u',listeners:[],remark:'',
        }}});
      }
    }else if(type==='research'){
      const subjects=[...new Set(teachers.map(item=>String(item.subject||'').trim()).filter(Boolean))];
      for(const subjectName of subjects){
        const exists=rows.some(row=>!rowData(row).__deleted
          && String(rowData(row).__research?.subject||row.subject||row.teacher||'').trim()===subjectName
          && matchesAttendancePeriod(rowData(row).__research?.period_time,period));
        if(!exists){
          const members=teachers.filter(item=>String(item.subject||'').trim()===subjectName).map(item=>item.name);
          rows.push({teacher:subjectName,subject:subjectName,data:{__research:{
            subject:subjectName,period_time:'第'+period+'节',location:'',host:'',
            expected:members.length,attendees:[],absent:members,status:'待登记',remark:'',
          }}});
        }
      }
    }
    return rows;
  };
  const mergeDraftRows = (type,table,draftRows) => {
    const rows=(table.rows||[]).map(cloneAttendanceRow);
    if(type==='seat'){
      for(const draft of draftRows){
        let target=rows.find(row=>row.teacher===draft.teacher);
        if(!target){target=cloneAttendanceRow(draft);rows.push(target);}
        const data=rowData(target),draftData=rowData(draft),periods={...(data.__periods||{})};
        const periodValue=draftData.__periods?.[String(period)]||{};
        periods[String(period)]={...(periods[String(period)]||{}),...periodValue};
        target.data={...data,__periods:periods};
      }
    }else if(type==='class'){
      for(const draft of draftRows){
        const draftData=rowData(draft),record=draftData.__classRecord;
        if(!record)continue;
        let target=draft.id?rows.find(row=>String(row.id)===String(draft.id)):null;
        if(!target&&!draft.__draftNew)target=rows.find(row=>row.teacher===draft.teacher
          && Number(rowData(row).__classRecord?.period||period)===Number(period)
          && String(rowData(row).__classRecord?.class_name||'')===String(record.class_name||''));
        if(draftData.__deleted){
          if(target)target.data={...rowData(target),__deleted:true};
          else if(draft.id)rows.push(cloneAttendanceRow(draft));
          continue;
        }
        if(!target&&!draft.__draftNew)target=rows.find(row=>row.teacher===draft.teacher
          && !rowData(row).__classRecord&&!rowData(row).__deleted);
        if(target)target.data={...rowData(target),__classRecord:{...record}};
        else{
          const added=cloneAttendanceRow(draft);delete added.__draftNew;rows.push(added);
        }
      }
    }else if(type==='research'){
      for(const draft of draftRows){
        const draftData=rowData(draft),record=draftData.__research;
        if(!record)continue;
        let target=draft.id?rows.find(row=>String(row.id)===String(draft.id)):null;
        if(!target)target=rows.find(row=>!!rowData(row).__research
          && String(rowData(row).__research.subject||row.subject||row.teacher||'').trim()===String(record.subject||'').trim()
          && matchesAttendancePeriod(rowData(row).__research.period_time,period));
        if(draftData.__deleted){if(target)target.data={...rowData(target),__deleted:true};continue;}
        if(target)target.data={...rowData(target),__research:{...record}};
        else rows.push(cloneAttendanceRow(draft));
      }
    }
    return rows;
  };
  const persistDraft = async (type,{reload=true}={}) => {
    const key=draftKey(type),draftRows=getDraftRows(type),table=await getTable(type);
    const rows=mergeDraftRows(type,table,draftRows);
    await saveRows(table,rows);
    draftCache.delete(key);
    if(reload)await load();
  };
  const generateTable = async type => {
    const existed=!!details[type];
    await persistDraft(type,{reload:false});
    await load();
    tab=type;paint();
    toast((existed?'已更新':'已生成')+({seat:'坐班表',class:'上课表',research:'教研表'}[type]),'ok');
  };
  const teacherSubjects = () => [...new Set(teachers.map(item=>String(item.subject||'').trim()).filter(Boolean))].sort();
  const teacherFiltersHtml = () => {
    const subjects=teacherSubjects();
    return '<input type="search" id="aprd-search" placeholder="搜索教师姓名" value="'+esc(search)+'">'
      +'<select id="aprd-subject"><option value="">全部学科</option>'
      +subjects.map(item=>'<option value="'+esc(item)+'" '+(subject===item?'selected':'')+'>'+esc(item)+'</option>').join('')
      +'</select>';
  };
  const teacherAddCardHtml = () => {
    if(!showAddTeacher)return '';
    const subjects=teacherSubjects();
    return '<section class="aprd-roster-add-card" aria-label="新增教师">'
      +'<div class="aprd-roster-add-head"><div><h3>新增教师</h3><p>在当前年级新增人员，花名册及已生成的工作表将同步显示</p></div>'
      +'<span>当前年级：'+esc(grade)+'</span></div>'
      +'<form class="aprd-roster-add-form" id="aprd-roster-add-form">'
      +'<label>姓名 <em>*</em><input name="name" type="text" placeholder="请输入教师姓名" autocomplete="off" required></label>'
      +'<label>学科 <em>*</em><input name="subject" type="text" list="aprd-add-subjects" placeholder="请输入或选择学科" autocomplete="off" required>'
      +'<datalist id="aprd-add-subjects">'+subjects.map(item=>'<option value="'+esc(item)+'"></option>').join('')+'</datalist></label>'
      +'<label>归属部门<input name="department" type="text" value="高中部" placeholder="请输入归属部门"></label>'
      +'<div class="aprd-roster-add-actions"><button type="button" data-roster-add-cancel>取消</button><button type="submit" class="primary">保存教师</button></div>'
      +'</form></section>';
  };
  const saveDraftButton = (type,label) => '<button '+(details[type]?'':'disabled')+' data-save-'+type+'>'+(details[type]?label:'生成后可保存修改')+'</button>';
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
    const dialog=document.createElement('div');dialog.className='attendance-prd aprd-dialog aprd-roster-dialog';
    dialog.innerHTML='<section class="aprd-roster-import"><header><div><h3>批量导入教师名单</h3><p>导入目标年级：'+esc(grade)+' · 原有考勤记录不会被覆盖</p></div><button type="button" data-import-close aria-label="关闭">×</button></header><div class="aprd-import-body"><div class="aprd-upload-zone"><input id="aprd-import-file" type="file" accept=".xlsx,.xls,.xlsm,.csv,.tsv,.txt,.pdf,.png,.jpg,.jpeg,.webp"><span class="aprd-upload-icon">↑</span><b>上传教师名单文件</b><small>支持 XLSX / XLS / CSV / PDF / JPG / PNG / WebP</small><button type="button" data-import-browse>选择文件</button></div><div class="aprd-import-paste"><label for="aprd-import-text">或者直接粘贴 Excel 表格</label><textarea id="aprd-import-text" rows="4" placeholder="复制 Excel 中的姓名、学科等列，然后粘贴到这里…"></textarea><button type="button" data-import-paste>解析粘贴内容</button><button type="button" data-import-template>下载 Excel 模板</button></div><div class="aprd-import-status" id="aprd-import-status" role="status">上传后会先识别并显示预览，只有点击“确认导入”才会写入花名册。</div><div class="aprd-import-warnings" id="aprd-import-warnings" hidden></div><div class="aprd-import-preview" id="aprd-import-preview" hidden><div class="aprd-import-summary" id="aprd-import-summary"></div><div class="aprd-import-table-wrap"><table><thead><tr><th>序号</th><th>姓名</th><th>学科</th><th>归属部门</th><th>来源年级</th><th>处理方式</th></tr></thead><tbody id="aprd-import-rows"></tbody></table></div></div></div><footer><button type="button" data-import-close>取消</button><button type="button" class="primary" data-import-confirm disabled>确认导入</button></footer></section>';
    document.body.append(dialog);
    let importRows=[];
    const $=(selector)=>dialog.querySelector(selector);
    const close=()=>{dialog.remove();document.removeEventListener('keydown',onDialogKeydown);};
    const onDialogKeydown=(event)=>{if(event.key==='Escape')close();};
    document.addEventListener('keydown',onDialogKeydown);
    dialog.addEventListener('click',(event)=>{if(event.target===dialog)close();});
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
        let action=row.action||(key?'add':'skip');
        if(inFile)action='skip';
        else if(existing){if(action==='add')action='skip';}
        else if(!key)action='skip';
        else if(action!=='skip')action='add';
        return {...row,duplicateKind,duplicateId:existing?.id||null,action};
      });
    };
    const renderPreview=()=>{
      refreshDuplicates();
      const preview=$('#aprd-import-preview');
      preview.hidden=false;
      const completeRow=row=>String(row.name||'').trim()&&String(row.subject||'').trim();
      const incomplete=importRows.filter(row=>!completeRow(row)).length;
      const invalid=importRows.filter(row=>row.action!=='skip'&&!completeRow(row)).length;
      const additions=importRows.filter(row=>row.action==='add'&&completeRow(row)).length;
      const updates=importRows.filter(row=>row.action==='update'&&completeRow(row)).length;
      const skipped=importRows.filter(row=>row.action==='skip').length;
      $('#aprd-import-summary').innerHTML='<b>识别 '+importRows.length+' 条</b><span>新增 '+additions+' 条</span><span>更新 '+updates+' 条</span><span>跳过 '+skipped+' 条</span>'+(incomplete?'<strong>有 '+incomplete+' 条未完整识别；空白行默认跳过，可补全后改为新增</strong>':'');
      $('#aprd-import-warnings').hidden=!importWarnings.length;
      $('#aprd-import-warnings').textContent=importWarnings.join('；');
      $('#aprd-import-rows').innerHTML=importRows.map((row,index)=>{
        const status=row.duplicateKind==='file'?'文件内重复':row.duplicateKind==='existing'?'名册已存在':(!row.name||!row.subject?'信息不完整':'可导入');
        const options=row.duplicateKind==='file'?'<option value="skip" selected>跳过重复行</option>':row.duplicateKind==='existing'?'<option value="skip" '+(row.action==='skip'?'selected':'')+'>跳过已存在</option><option value="update" '+(row.action==='update'?'selected':'')+'>更新已有人员</option>':'<option value="add" '+(row.action==='add'?'selected':'')+'>新增人员</option><option value="skip" '+(row.action==='skip'?'selected':'')+'>跳过此行</option>';
        return '<tr><td>'+esc(row.serial||index+1)+'</td><td><input data-import-field="name" data-index="'+index+'" value="'+esc(row.name||'')+'" aria-label="姓名"></td><td><input data-import-field="subject" data-index="'+index+'" value="'+esc(row.subject||'')+'" aria-label="学科"></td><td><input data-import-field="department" data-index="'+index+'" value="'+esc(row.department||'')+'" aria-label="归属部门" placeholder="高中部"></td><td>'+esc(row.grade||grade)+'</td><td><select data-import-action="'+index+'">'+options+'</select><small class="aprd-import-row-status">'+status+'</small></td></tr>';
      }).join('');
      $('[data-import-confirm]').disabled=!importRows.some(row=>row.action!=='skip'&&String(row.name||'').trim()&&String(row.subject||'').trim());
    };
    let importWarnings=[];
    const acceptParsed=(result)=>{
      importRows=(result.rows||[]).map((row,index)=>({...row,serial:row.serial||index+1,action:row.name&&row.subject?'add':'skip'}));
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
        const recognizedCount=Number.isFinite(Number(result.recognizedCount))?Number(result.recognizedCount):result.rows.length;
        const expectedCount=Number(result.expectedCount)||result.rows.length;
        updateStatus(recognizedCount<expectedCount
          ? '识别完成：有效识别 '+recognizedCount+' / '+expectedCount+' 条，缺失项已保留，请逐项补全或跳过。'
          : '识别完成：'+recognizedCount+' 条，请逐项核对后确认导入。');
      }catch(error){updateStatus(error.message||'文件解析失败');toast(error.message||'文件解析失败','err');}
    };
    const fileInput=$('#aprd-import-file');
    $('[data-import-browse]').addEventListener('click',(event)=>{event.preventDefault();fileInput.click();});
    $('.aprd-upload-zone').addEventListener('click',(event)=>{if(!event.target.closest('[data-import-browse]'))fileInput.click();});
    fileInput.onchange=()=>{const file=fileInput.files?.[0];fileInput.value='';if(file)parseFile(file);};
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
    (root.querySelector('.attendance-prd') || root).append(dialog); const form=dialog.querySelector('form');
    dialog.querySelector('[data-cancel]').onclick=()=>dialog.remove();
    form.onsubmit=async e=>{e.preventDefault();const data=Object.fromEntries(new FormData(form));try{await onSave(data);dialog.remove();}catch(err){toast(err.message||'保存失败','err');}};
  };
  const editLeaveRecord = (record = null, defaultTeacher = null) => {
    const recordName=record?.name||record?.teacher||'';
    const teacherOptions=teachers.map(x=>({value:x.name,label:x.name+' · '+x.subject}));
    if(recordName&&!teacherOptions.some(x=>x.value===recordName))teacherOptions.push({value:recordName,label:recordName+'（历史记录）'});
    openEditor(record?'修改请假记录':'登记请假',[
      {key:'teacher',label:'教师',type:'select',options:teacherOptions},
      {key:'type',label:'类型',type:'select',options:[{value:'',label:'无（取消请假）'},...LEAVE_TYPES.map(x=>({value:x,label:x}))]},
      {key:'start_date',label:'开始日期',type:'date'},
      {key:'end_date',label:'结束日期',type:'date'},
      {key:'days',label:'天数',type:'number'},
      {key:'status',label:'状态',type:'select',options:['待批','已批','已撤销'].map(x=>({value:x,label:x}))},
      {key:'remark',label:'备注',type:'textarea'},
    ],{
      teacher:recordName||defaultTeacher?.name||teachers[0]?.name||'',
      type:record?.type||'',start_date:record?.start_date||date,end_date:record?.end_date||date,
      days:record?.days||1,status:record?.status||'待批',remark:record?.remark||'',
    },async data=>{
      const who=teachers.find(x=>x.name===data.teacher);
      const next=record
        ? leaveRecords.filter(x=>x!==record&&String(x.id)!==String(record.id))
        : leaveRecords.slice();
      if(data.type){
        next.push({
          ...(record||{}),id:record?.id||Date.now(),grade:record?.grade||grade,
          name:who?.name||recordName||data.teacher,subject:who?.subject||record?.subject||'',type:data.type,
          start_date:data.start_date||date,end_date:data.end_date||data.start_date||date,
          days:Number(data.days)||1,status:data.status||'待批',remark:data.remark||'',
        });
      }
      await savePrefs({leaves:next});
      await load();
    });
  };
  const handleClassStatus = async teacher => {
    const table=await getTable('class');
    const records=(table.rows||[]).filter(row=>{
      const data=rowData(row), record=data.__classRecord||{};
      return !data.__deleted && row.teacher===teacher.name && Number(record.period||period)===Number(period);
    });
    const current=deriveRosterState(teacher,{seatRows:details.seat?.rows||[],classRows:table.rows||[],researchRows:details.research?.rows||[],leaveRecords,date,period}).class;
    const existing=records.find(row=>String(rowData(row).__classRecord?.class_name||'').trim())||records[0];
    const existingData=existing?{...rowData(existing).__classRecord}:{};
    const hasClassName=!!String(existingData.class_name||'').trim();
    if(records.length&&hasClassName&&(current==='y'||current==='n')){
      const next=nextTriState(current);
      records.forEach(row=>{
        const data={...rowData(row)},record={...data.__classRecord,status:next};
        row.data={...data,__classRecord:record};
      });
      await saveRows(table,table.rows||[]);
      await load();
      return;
    }
    openEditor('登记上课情况',[
      {key:'class_name',label:'班级',required:true},
      {key:'period',label:'节次',type:'select',options:DEFAULT_PERIODS.map(p=>({value:p.no,label:p.label}))},
      {key:'status',label:'上课状态',type:'select',options:[{value:'u',label:'未登记'},{value:'y',label:'已上课'},{value:'n',label:'未上课'}]},
      {key:'listeners',label:'听课教师'},
      {key:'remark',label:'备注',type:'textarea'},
    ],{
      class_name:existingData.class_name||'',period:String(existingData.period||period),
      status:existingData.status==='n'?'n':'y',
      listeners:Array.isArray(existingData.listeners)?existingData.listeners.join('、'):'',
      remark:existingData.remark||'',
    },async data=>{
      let row=existing;
      if(!row){
        row=(table.rows||[]).find(item=>item.teacher===teacher.name&&!rowData(item).__classRecord&&!rowData(item).__deleted);
        if(!row){row={teacher:teacher.name,subject:teacher.subject||'',data:{}};table.rows.push(row);}
      }
      const record={
        ...existingData,class_name:String(data.class_name||'').trim(),period:Number(data.period||period),
        status:data.status||'u',
        listeners:String(data.listeners||'').split(/[、,，]/).map(x=>x.trim()).filter(Boolean),
        remark:data.remark||'',
      };
      row.data={...rowData(row),__classRecord:record};
      await saveRows(table,table.rows||[]);
      await load();
    });
  };
  const handleResearchStatus = async teacher => {
    const table=await getTable('research');
    const subjectName=String(teacher.subject||'').trim();
    const members=teachers.filter(item=>String(item.subject||'').trim()===subjectName).map(item=>item.name);
    const existing=(table.rows||[]).find(row=>{
      const data=rowData(row),record=data.__research||{};
      return !data.__deleted && !!data.__research
        && String(record.subject||row.subject||'').trim()===subjectName
        && matchesAttendancePeriod(record.period_time,period);
    });
    const updateAttendance=async(row,record,formData=null)=>{
      const attendees=new Set(Array.isArray(record.attendees)?record.attendees:[]);
      attendees.add(teacher.name);
      const present=members.filter(name=>attendees.has(name));
      const nextRecord={
        ...record,...(formData||{}),subject:subjectName,expected:members.length,
        attendees:present,absent:members.filter(name=>!present.includes(name)),
        status:present.length?'已登记':'待登记',
      };
      row.data={...rowData(row),__research:nextRecord};
      await saveRows(table,table.rows||[]);
      await load();
    };
    if(existing){
      const record={...rowData(existing).__research};
      if(!String(record.period_time||'').trim()||!String(record.host||'').trim()){
        openEditor('完善教研登记',[
          {key:'period_time',label:'节次/时间',required:true},
          {key:'location',label:'地点'},
          {key:'host',label:'主持人',required:true},
        ],{period_time:record.period_time||'第'+period+'节',location:record.location||'',host:record.host||teacher.name},
        async data=>updateAttendance(existing,record,data));
        return;
      }
      const attendees=new Set(Array.isArray(record.attendees)?record.attendees:[]);
      if(attendees.has(teacher.name))attendees.delete(teacher.name);else attendees.add(teacher.name);
      const present=members.filter(name=>attendees.has(name));
      existing.data={...rowData(existing),__research:{
        ...record,subject:subjectName,expected:members.length,attendees:present,
        absent:members.filter(name=>!present.includes(name)),status:present.length?'已登记':'待登记',
      }};
      await saveRows(table,table.rows||[]);
      await load();
      return;
    }
    openEditor('登记教研签到',[
      {key:'period_time',label:'节次/时间',required:true},
      {key:'location',label:'地点'},
      {key:'host',label:'主持人',required:true},
    ],{period_time:'第'+period+'节',location:'',host:teacher.name},async data=>{
      const attendees=[teacher.name];
      table.rows.push({
        teacher:subjectName||teacher.name,subject:subjectName,
        data:{__research:{
          ...data,subject:subjectName,expected:members.length,attendees,
          absent:members.filter(name=>!attendees.includes(name)),status:'已登记',
        }},
      });
      await saveRows(table,table.rows);
      await load();
    });
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
      const mark=(key,val)=>'<button type="button" class="aprd-mark '+(val==='y'?'y':val==='n'?'n':'u')+'" data-person="'+t.id+'" data-key="'+key+'">'+CHECK_LABEL(val)+'</button>';
      return '<tr><td>'+(i+1)+'</td><td><button type="button" class="aprd-link" data-dept="'+t.id+'">'+esc(deptOf(t))+'</button></td><td><button type="button" class="aprd-link" data-teacher-grade="'+t.id+'">'+esc(t.grade||grade)+'</button></td><td><b>'+esc(t.name)+'</b></td><td>'+esc(t.subject||'')+'</td><td>'+mark('class',st.class)+'</td><td>'+mark('sit',st.sit)+'</td><td>'+mark('listen',st.listen?'y':'u')+'</td><td>'+mark('research',st.research?'y':'u')+'</td><td><button type="button" class="aprd-mark '+(st.leave?'y':'u')+'" data-leave="'+t.id+'">'+esc(st.leave||'无')+'</button></td><td>'+esc(noteOf(t))+'</td><td><div class="aprd-actions"><button type="button" data-edit="'+t.id+'">编辑</button><button type="button" data-disable="'+t.id+'">停用</button></div></td></tr>';
    }).join('');
    const addCard = teacherAddCardHtml();
    return '<div class="aprd-toolbar"><input type="search" id="aprd-search" placeholder="搜索教师姓名" value="'+esc(search)+'"><select id="aprd-subject"><option value="">全部学科</option>'+subjects.map(s=>'<option '+(subject===s?'selected':'')+'>'+esc(s)+'</option>').join('')+'</select><button class="primary" data-add>'+(showAddTeacher?'收起表单':'＋ 新增教师')+'</button><button type="button" data-roster-import>批量导入</button><div class="aprd-export-wrap"><button data-roster-export-toggle>批量导出 ▾</button><div class="aprd-export-menu" data-roster-export-menu hidden><label>导出范围 <select id="aprd-export-scope"><option value="all">全部在岗人员</option><option value="filtered">当前筛选结果</option></select></label><button data-roster-export="xlsx">Excel 表格</button><button data-roster-export="csv">CSV 文件</button><button data-roster-export="pdf">PDF 文档</button><button data-roster-export="png">PNG 图片</button></div></div><button data-copy>复制名单</button><button data-subject-manager>学科管理</button><span>当前筛：'+esc(subject||'全部')+' · '+list.length+' 人</span></div>'+addCard+'<div class="aprd-table-wrap"><table><thead><tr>'+ATTENDANCE_COLUMNS.roster.map(c=>'<th>'+c+'</th>').join('')+'</tr></thead><tbody>'+rows+'</tbody></table></div><p class="aprd-note">花名册仅显示当前年级在岗教师；状态按当前日期和节次读取。</p>';
  };

  const seatHtml = () => {
    const list=visibleTeachers(),draftRows=getDraftRows('seat'),generated=!!details.seat;
    const headers=['序号','姓名','学科','年级/部门','坐班','请假','听课','备注','操作'];
    const rows=list.map((teacher,index)=>{
      const row=draftRows.find(item=>item.teacher===teacher.name)||{teacher:teacher.name,data:{}};
      const rec=rowData(row).__periods?.[String(period)]||{};
      const leave=activeLeavesFor(leaveRecords,date,grade).find(item=>String(item.name||item.teacher||'').trim()===teacher.name);
      return '<tr><td>'+(index+1)+'</td><td><b>'+esc(teacher.name)+'</b></td><td>'+esc(teacher.subject||'')+'</td>'
        +'<td>'+esc((teacher.grade||grade)+' / '+deptOf(teacher))+'</td>'
        +'<td><select data-seat="'+teacher.id+'" data-k="status"><option value="u" '+(!rec.status||rec.status==='u'?'selected':'')+'>未登记</option><option value="y" '+(rec.status==='y'?'selected':'')+'>在坐班</option><option value="n" '+(rec.status==='n'?'selected':'')+'>未坐班</option></select></td>'
        +'<td>'+esc(leave?.type||'—')+'</td>'
        +'<td><input data-seat="'+teacher.id+'" data-k="listen_class" value="'+esc(rec.listen_class||'')+'" placeholder="听课班级"></td>'
        +'<td><input data-seat="'+teacher.id+'" data-k="remark" value="'+esc(rec.remark||'')+'" placeholder="备注"></td>'
        +'<td><span class="aprd-status '+(generated?'approved':'pending')+'">'+(generated?'可编辑':'待生成')+'</span></td></tr>';
    }).join('');
    return '<div class="aprd-toolbar">'+teacherFiltersHtml()+'<span>在岗 '+draftRows.filter(row=>(rowData(row).__periods?.[String(period)]||{}).status==='y').length+' / 应到 '+teachers.length+'</span>'
      +saveDraftButton('seat','保存修改')+'</div>'+teacherAddCardHtml()
      +'<div class="aprd-table-wrap"><table><thead><tr>'+headers.map(item=>'<th>'+item+'</th>').join('')+'</tr></thead><tbody>'
      +(rows||'<tr><td colspan="9" class="aprd-empty">当前年级暂无在岗教师</td></tr>')
      +'</tbody></table></div>';
  };
  const classHtml = () => {
    const draftRows=getDraftRows('class');
    const headers=['序号','班级','节次','任课教师','学科','上课状态','听课教师','备注','操作'];
    const visible=draftRows.map((row,index)=>({row,index})).filter(({row})=>{
      const data=rowData(row),record=data.__classRecord||{};
      return !data.__deleted
        && (!search||(String(row.teacher||'')+' '+String(row.subject||'')+' '+String(record.class_name||'')).toLowerCase().includes(search.toLowerCase()))
        && (!subject||String(row.subject||'')===subject);
    });
    const rows=visible.map(({row,index},serial)=>{
      const d=rowData(row).__classRecord||{},listeners=Array.isArray(d.listeners)?d.listeners.join('、'):'';
      return '<tr><td>'+(serial+1)+'</td>'
        +'<td><input data-class-index="'+index+'" data-k="class_name" value="'+esc(d.class_name||'')+'" placeholder="填写班级"></td>'
        +'<td><select data-class-index="'+index+'" data-k="period">'+DEFAULT_PERIODS.map(item=>'<option value="'+item.no+'" '+(Number(d.period||period)===item.no?'selected':'')+'>第'+item.no+'节</option>').join('')+'</select></td>'
        +'<td><b>'+esc(row.teacher||'')+'</b></td><td>'+esc(row.subject||'')+'</td>'
        +'<td><select data-class-index="'+index+'" data-k="status"><option value="u" '+(!d.status||d.status==='u'?'selected':'')+'>未登记</option><option value="y" '+(d.status==='y'?'selected':'')+'>已上课</option><option value="n" '+(d.status==='n'?'selected':'')+'>未上课</option></select></td>'
        +'<td><input data-class-index="'+index+'" data-k="listeners" value="'+esc(listeners)+'" placeholder="听课教师，多人用顿号分隔"></td>'
        +'<td><input data-class-index="'+index+'" data-k="remark" value="'+esc(d.remark||'')+'" placeholder="备注"></td>'
        +'<td><div class="aprd-actions"><button type="button" data-delete-class="'+index+'">删除</button></div></td></tr>';
    }).join('');
    return '<div class="aprd-toolbar">'+teacherFiltersHtml()+'<span>当前教师 '+visibleTeachers().length+' 人 · 本节记录 '+visible.length+' 条</span>'
      +'<button class="primary" data-add-class>新增班级记录</button>'+saveDraftButton('class','保存修改')+'</div>'
      +teacherAddCardHtml()+'<div class="aprd-table-wrap"><table><thead><tr>'+headers.map(item=>'<th>'+item+'</th>').join('')+'</tr></thead><tbody>'
      +(rows||'<tr><td colspan="9" class="aprd-empty">请先编辑当前年级教师的班级与节次，点击顶部“确认生成”后形成正式上课表</td></tr>')
      +'</tbody></table></div>';
  };
  const researchHtml = () => {
    const draftRows=getDraftRows('research'),list=visibleTeachers();
    const headers=['序号','姓名','学科','节次/时间','地点','主持人','参加状态','备注','操作'];
    const rows=list.map((teacher,index)=>{
      const row=draftRows.find(item=>String(rowData(item).__research?.subject||item.subject||item.teacher||'').trim()===String(teacher.subject||'').trim()
        && matchesAttendancePeriod(rowData(item).__research?.period_time,period));
      const record=row?rowData(row).__research||{}:{};
      const attendees=Array.isArray(record.attendees)?record.attendees:[];
      const present=attendees.includes(teacher.name);
      return '<tr><td>'+(index+1)+'</td><td><b>'+esc(teacher.name)+'</b></td><td>'+esc(teacher.subject||'')+'</td>'
        +'<td>'+esc(record.period_time||'第'+period+'节')+'</td><td>'+esc(record.location||'—')+'</td><td>'+esc(record.host||'—')+'</td>'
        +'<td><button type="button" class="aprd-mark '+(present?'y':'u')+'" data-research-toggle="'+teacher.id+'">'+(present?'已参加':'未参加')+'</button></td>'
        +'<td>'+esc(record.remark||'')+'</td>'
        +'<td><div class="aprd-actions"><button type="button" data-research-edit="'+teacher.id+'">编辑</button></div></td></tr>';
    }).join('');
    return '<div class="aprd-toolbar">'+teacherFiltersHtml()+'<span>当前教师 '+list.length+' 人 · 教研安排 '+draftRows.filter(row=>!rowData(row).__deleted).length+' 条</span>'
      +'<button class="primary" data-add-research>新增教研安排</button>'+saveDraftButton('research','保存修改')+'</div>'
      +teacherAddCardHtml()+'<div class="aprd-table-wrap"><table><thead><tr>'+headers.map(item=>'<th>'+item+'</th>').join('')+'</tr></thead><tbody>'
      +(rows||'<tr><td colspan="9" class="aprd-empty">当前年级暂无教师</td></tr>')
      +'</tbody></table></div>';
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
    root.innerHTML='<div class="attendance-prd"><div class="aprd-head"><h2>考勤工作台</h2><div class="aprd-grade">'+grades.map(g=>'<button data-grade-tab="'+esc(g)+'" class="'+(g===grade?'on':'')+'">'+esc(g)+'</button>').join('')+'</div><span style="margin-left:auto;color:#168448;font-size:12px">数据已加载</span></div><div class="aprd-meta"><label>日期 <input type="date" id="aprd-date" value="'+date+'"></label><button data-day="-1">‹</button><button data-day="1">›</button><label>节次 <select id="aprd-period">'+DEFAULT_PERIODS.map(p=>'<option value="'+p.no+'" '+(p.no===period?'selected':'')+'>'+p.label+'</option>').join('')+'</select></label><label>时段 <input type="time" id="aprd-start" value="'+DEFAULT_PERIODS[period-1].start+'">—<input type="time" id="aprd-end" value="'+DEFAULT_PERIODS[period-1].end+'"></label><select id="aprd-generate"><option value="seat">生成坐班表</option><option value="class">生成上课表</option><option value="research">生成教研表</option></select><button class="primary" data-generate>确认生成</button></div><nav class="aprd-tabs">'+TABS.map(([id,label])=>'<button data-tab="'+id+'" class="'+(tab===id?'on':'')+'">'+label+'</button>').join('')+'</nav><section class="aprd-panel">'+content+'</section></div>';
    root.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>{tab=b.dataset.tab;search='';subject='';paint();});
    root.querySelectorAll('[data-grade-tab]').forEach(b=>b.onclick=async()=>{grade=b.dataset.gradeTab;await load();});
    root.querySelector('#aprd-date').onchange=e=>{date=e.target.value;load();};
    root.querySelectorAll('[data-day]').forEach(b=>b.onclick=()=>{const d=new Date(date+'T00:00:00');d.setDate(d.getDate()+Number(b.dataset.day));date=d.toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'});load();});
    root.querySelector('#aprd-period').onchange=e=>{period=Number(e.target.value);paint();};
    root.querySelector('[data-generate]').onclick=async()=>{const type=root.querySelector('#aprd-generate').value;try{await generateTable(type);}catch(e){toast(e.message||'生成失败','err');}};
    root.querySelector('#aprd-search')?.addEventListener('input',e=>{search=e.target.value;const p=e.target.selectionStart;paint();const q=root.querySelector('#aprd-search');q?.focus();q?.setSelectionRange(p,p);});
    root.querySelector('#aprd-subject')?.addEventListener('change',e=>{subject=e.target.value;paint();});
    root.querySelectorAll('[data-person]').forEach(b=>b.onclick=async()=>{
      const teacher=teachers.find(x=>String(x.id)===b.dataset.person);
      if(!teacher)return;
      try{
        if(b.dataset.key==='class')await handleClassStatus(teacher);
        else if(b.dataset.key==='research')await handleResearchStatus(teacher);
        else await toggle(teacher,b.dataset.key==='sit'?'status':'listen');
      }catch(error){toast(error.message||'状态保存失败','err');}
    });
    root.querySelectorAll('[data-leave]').forEach(b=>b.onclick=()=>{
      const teacher=teachers.find(x=>String(x.id)===b.dataset.leave);
      if(!teacher)return;
      const existing=activeLeavesFor(leaveRecords,date,grade).find(x=>String(x.name||x.teacher||'').trim()===teacher.name);
      editLeaveRecord(existing,teacher);
    });
    root.querySelector('[data-add]')?.addEventListener('click',()=>{showAddTeacher=!showAddTeacher;paint();});
    root.querySelector('[data-roster-add-cancel]')?.addEventListener('click',()=>{showAddTeacher=false;paint();});
    root.querySelector('#aprd-roster-add-form')?.addEventListener('submit',async event=>{
      event.preventDefault();
      const form=event.currentTarget;
      const submit=form.querySelector('[type="submit"]');
      const values=Object.fromEntries(new FormData(form));
      const name=String(values.name||'').trim();
      const subjectName=String(values.subject||'').trim();
      const department=String(values.department||'').trim()||'高中部';
      if(!name){toast('请填写教师姓名','warn');form.querySelector('[name="name"]')?.focus();return;}
      if(!subjectName){toast('请填写教师学科','warn');form.querySelector('[name="subject"]')?.focus();return;}
      submit.disabled=true;
      submit.textContent='保存中…';
      try{
        await api.post('/teachers',{grade,name,subject:subjectName});
        const updated=await api.get('/teachers',{grade,active:'all'});
        const created=(updated.list||[]).find(item=>item.name===name&&item.subject===subjectName);
        if(created)await setTeacherMeta(created,{department});
        toast('教师已新增','ok');
        await load();
      }catch(error){
        submit.disabled=false;
        submit.textContent='保存教师';
        toast(error.message||'新增教师失败','err');
      }
    });
    const rosterImportButton=root.querySelector('[data-roster-import]');
    if(rosterImportButton){
      rosterImportButton.type='button';
      rosterImportButton.addEventListener('click',(event)=>{event.preventDefault();openRosterImport();});
    }
    root.querySelector('[data-roster-export-toggle]')?.addEventListener('click',()=>{
      const menu=root.querySelector('[data-roster-export-menu]');
      if(menu)menu.hidden=!menu.hidden;
    });
    root.querySelectorAll('[data-roster-export]').forEach(button=>button.addEventListener('click',()=>exportRoster(button.dataset.rosterExport)));

    root.querySelector('[data-copy]')?.addEventListener('click',()=>{const names=visibleTeachers().map(t=>t.name).join('\n');navigator.clipboard?.writeText(names);toast('已复制当前名单','ok');});
    root.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>{const t=teachers.find(x=>String(x.id)===b.dataset.edit);openEditor('编辑教师',[{key:'name',label:'姓名',required:true},{key:'subject',label:'学科',required:true},{key:'department',label:'归属部门'},{key:'remark',label:'备注'}],{name:t.name,subject:t.subject,department:deptOf(t),remark:noteOf(t)},async d=>{await api.patch('/teachers/'+t.id,{name:d.name,subject:d.subject});await setTeacherMeta(t,{department:d.department,remark:d.remark});await load();});});
    root.querySelectorAll('[data-disable]').forEach(b=>b.onclick=async()=>{if(await confirmDialog('停用该教师？')){await api.patch('/teachers/'+b.dataset.disable,{active:0});await load();}});
    root.querySelector('[data-add-leave]')?.addEventListener('click',()=>editLeaveRecord(null,teachers[0]));
    root.querySelectorAll('[data-delete-leave]').forEach(b=>b.onclick=async()=>{if(await confirmDialog('删除这条请假记录？')){leaveRecords=leaveRecords.filter(x=>String(x.id)!==b.dataset.deleteLeave);await savePrefs({leaves:leaveRecords});await load();}});
    root.querySelectorAll('[data-edit-leave]').forEach(b=>b.onclick=()=>{
      const record=leaveRecords.find(x=>String(x.id)===b.dataset.editLeave);
      if(record)editLeaveRecord(record);
    });

    root.querySelector('[data-add-class]')?.addEventListener('click',()=>openEditor('新增班级上课记录',[
      {key:'class_name',label:'班级',required:true},
      {key:'teacher',label:'任课教师',type:'select',options:teachers.map(item=>({value:item.name,label:item.name}))},
      {key:'period',label:'节次',type:'select',options:DEFAULT_PERIODS.map(item=>({value:item.no,label:item.label}))},
      {key:'status',label:'上课状态',type:'select',options:[{value:'u',label:'未登记'},{value:'y',label:'已上课'},{value:'n',label:'未上课'}]},
      {key:'listeners',label:'听课教师'},{key:'remark',label:'备注',type:'textarea'},
    ],{period:String(period),status:'u'},async data=>{
      const teacher=teachers.find(item=>item.name===data.teacher);
      if(!teacher)throw new Error('请先选择任课教师');
      getDraftRows('class').push({teacher:teacher.name,subject:teacher.subject||'',__draftNew:true,data:{__classRecord:{
        class_name:String(data.class_name||'').trim(),period:Number(data.period||period),status:data.status||'u',
        listeners:String(data.listeners||'').split(/[、,，]/).map(item=>item.trim()).filter(Boolean),remark:data.remark||'',
      }}});
      paint();
    }));
    root.querySelectorAll('[data-class-index]').forEach(el=>el.addEventListener('change',()=>{
      const row=getDraftRows('class')[Number(el.dataset.classIndex)];
      if(!row)return;
      const data={...rowData(row)},record={...(data.__classRecord||{period:Number(period),status:'u',listeners:[],remark:''})};
      if(el.dataset.k==='listeners')record.listeners=el.value.split(/[、,，]/).map(item=>item.trim()).filter(Boolean);
      else if(el.dataset.k==='period')record.period=Number(el.value);
      else record[el.dataset.k]=el.value;
      row.data={...data,__classRecord:record};
    }));
    root.querySelectorAll('[data-delete-class]').forEach(button=>button.addEventListener('click',()=>{
      const row=getDraftRows('class')[Number(button.dataset.deleteClass)];
      if(!row)return;
      row.data={...rowData(row),__deleted:true};paint();
    }));
    root.querySelector('[data-save-class]')?.addEventListener('click',async()=>{try{await persistDraft('class');toast('上课表修改已保存','ok');}catch(error){toast(error.message||'保存失败','err');}});


    root.querySelector('[data-add-class]')?.addEventListener('click',()=>openEditor('新增班级上课记录',[
      {key:'class_name',label:'班级',required:true},
      {key:'teacher',label:'任课教师',type:'select',options:teachers.map(item=>({value:item.name,label:item.name}))},
      {key:'period',label:'节次',type:'select',options:DEFAULT_PERIODS.map(item=>({value:item.no,label:item.label}))},
      {key:'status',label:'上课状态',type:'select',options:[{value:'u',label:'未登记'},{value:'y',label:'已上课'},{value:'n',label:'未上课'}]},
      {key:'listeners',label:'听课教师'},{key:'remark',label:'备注',type:'textarea'},
    ],{period:String(period),status:'u'},async data=>{
      const teacher=teachers.find(item=>item.name===data.teacher);
      if(!teacher)throw new Error('请先选择任课教师');
      getDraftRows('class').push({teacher:teacher.name,subject:teacher.subject||'',__draftNew:true,data:{__classRecord:{
        class_name:String(data.class_name||'').trim(),period:Number(data.period||period),status:data.status||'u',
        listeners:String(data.listeners||'').split(/[、,，]/).map(item=>item.trim()).filter(Boolean),remark:data.remark||'',
      }}});
      paint();
    }));
    root.querySelectorAll('[data-class-index]').forEach(el=>el.addEventListener('change',()=>{
      const row=getDraftRows('class')[Number(el.dataset.classIndex)];
      if(!row)return;
      const data={...rowData(row)},record={...(data.__classRecord||{period:Number(period),status:'u',listeners:[],remark:''})};
      if(el.dataset.k==='listeners')record.listeners=el.value.split(/[、,，]/).map(item=>item.trim()).filter(Boolean);
      else if(el.dataset.k==='period')record.period=Number(el.value);
      else record[el.dataset.k]=el.value;
      row.data={...data,__classRecord:record};
    }));
    root.querySelectorAll('[data-delete-class]').forEach(button=>button.addEventListener('click',()=>{
      const row=getDraftRows('class')[Number(button.dataset.deleteClass)];
      if(!row)return;
      row.data={...rowData(row),__deleted:true};paint();
    }));
    root.querySelector('[data-save-class]')?.addEventListener('click',async()=>{try{await persistDraft('class');toast('上课表修改已保存','ok');}catch(error){toast(error.message||'保存失败','err');}});


    root.querySelectorAll('[data-seat]').forEach(el=>el.addEventListener('change',()=>{
      const teacher=teachers.find(item=>String(item.id)===String(el.dataset.seat));
      if(!teacher)return;
      const row=getDraftRows('seat').find(item=>item.teacher===teacher.name);
      if(!row)return;
      const data={...rowData(row)},periods={...(data.__periods||{})},record={...(periods[String(period)]||{})};
      record[el.dataset.k]=el.value;periods[String(period)]=record;row.data={...data,__periods:periods};
    }));
    root.querySelector('[data-save-seat]')?.addEventListener('click',async()=>{try{await persistDraft('seat');toast('坐班表修改已保存','ok');}catch(error){toast(error.message||'保存失败','err');}});


    root.querySelector('[data-add-research]')?.addEventListener('click',()=>{
      const subjects=teacherSubjects();
      openEditor('新增教研安排',[
        {key:'subject',label:'学科',type:'select',options:subjects.map(item=>({value:item,label:item}))},
        {key:'period_time',label:'节次/时间',required:true},
        {key:'location',label:'地点'},
        {key:'host',label:'主持人',type:'select',options:teachers.map(item=>({value:item.name,label:item.name}))},
        {key:'remark',label:'备注',type:'textarea'},
      ],{subject:subjects[0]||'',period_time:'第'+period+'节',location:'',host:teachers[0]?.name||'',remark:''},async data=>{
        const subjectName=String(data.subject||'').trim();
        const members=teachers.filter(item=>String(item.subject||'').trim()===subjectName).map(item=>item.name);
        const draftRows=getDraftRows('research');
        let row=draftRows.find(item=>String(rowData(item).__research?.subject||item.subject||item.teacher||'').trim()===subjectName
          && matchesAttendancePeriod(rowData(item).__research?.period_time,period));
        if(!row){row={teacher:subjectName,subject:subjectName,data:{}};draftRows.push(row);}
        const old=rowData(row).__research||{};
        const picked=await chooseResearchAttendees(members,Array.isArray(old.attendees)?old.attendees:members);
        if(picked===null)return;
        row.data={...rowData(row),__research:{...old,...data,subject:subjectName,expected:members.length,
          attendees:picked,absent:members.filter(name=>!picked.includes(name)),status:picked.length?'已登记':'待登记'}};
        paint();
      });
    });
    root.querySelectorAll('[data-research-toggle]').forEach(button=>button.addEventListener('click',()=>{
      const teacher=teachers.find(item=>String(item.id)===String(button.dataset.researchToggle));
      if(!teacher)return;
      const row=getDraftRows('research').find(item=>String(rowData(item).__research?.subject||item.subject||item.teacher||'').trim()===String(teacher.subject||'').trim()
        && matchesAttendancePeriod(rowData(item).__research?.period_time,period));
      if(!row)return;
      const record={...(rowData(row).__research||{})},members=teachers.filter(item=>String(item.subject||'').trim()===String(teacher.subject||'').trim()).map(item=>item.name);
      const attendees=new Set(Array.isArray(record.attendees)?record.attendees:[]);
      if(attendees.has(teacher.name))attendees.delete(teacher.name);else attendees.add(teacher.name);
      const present=members.filter(name=>attendees.has(name));
      row.data={...rowData(row),__research:{...record,subject:teacher.subject,expected:members.length,attendees:present,
        absent:members.filter(name=>!present.includes(name)),status:present.length?'已登记':'待登记'}};
      paint();
    }));
    root.querySelectorAll('[data-research-edit]').forEach(button=>button.addEventListener('click',()=>{
      const teacher=teachers.find(item=>String(item.id)===String(button.dataset.researchEdit));
      if(!teacher)return;
      const subjectName=String(teacher.subject||'').trim(),members=teachers.filter(item=>String(item.subject||'').trim()===subjectName).map(item=>item.name);
      const row=getDraftRows('research').find(item=>String(rowData(item).__research?.subject||item.subject||item.teacher||'').trim()===subjectName
        && matchesAttendancePeriod(rowData(item).__research?.period_time,period));
      if(!row)return;
      const old={...(rowData(row).__research||{})};
      openEditor('修改教研安排',[
        {key:'period_time',label:'节次/时间',required:true},
        {key:'location',label:'地点'},
        {key:'host',label:'主持人',type:'select',options:teachers.map(item=>({value:item.name,label:item.name}))},
        {key:'remark',label:'备注',type:'textarea'},
      ],{period_time:old.period_time||'第'+period+'节',location:old.location||'',host:old.host||teacher.name,remark:old.remark||''},async data=>{
        const picked=await chooseResearchAttendees(members,Array.isArray(old.attendees)?old.attendees:[]);
        if(picked===null)return;
        row.data={...rowData(row),__research:{...old,...data,subject:subjectName,expected:members.length,
          attendees:picked,absent:members.filter(name=>!picked.includes(name)),status:picked.length?'已登记':'待登记'}};
        paint();
      });
    }));
    root.querySelector('[data-save-research]')?.addEventListener('click',async()=>{try{await persistDraft('research');toast('教研表修改已保存','ok');}catch(error){toast(error.message||'保存失败','err');}});

    root.querySelector('[data-subject-manager]')?.addEventListener('click',()=>toast('学科管理请在名册管理入口维护','warn'));
  };
  await load();
}
