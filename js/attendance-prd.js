import { api, esc, toast, confirmDialog, saveBlob } from './core.js';
import { icon } from './ui.js';
import { createSlot } from './attday.js';
import { makeXlsx } from './attendance.js';
import { voiceSheet } from './attvoice.js';
import { cleanPeriodTime, getCanonicalPeriodNumber, normalizeTimetablePeriods } from './timetable-periods.mjs';
import { parseRosterFile, parseRosterText } from './roster-batch.mjs';
import {
  DEFAULT_PERIODS, LEAVE_TYPES, ATTENDANCE_COLUMNS, buildAttendanceExportGrid, parseLeaveDuration, formatLeaveDuration,
  nextTriState, activeLeavesFor, deriveRosterState, calculateDailySummary,
  matchesAttendancePeriod, deriveTableGridState, updateTeacherGrid, mergeTeacherGridRows, paginateExportGrid,
} from './attendance-prd-domain.mjs';

const TABS = [
  ['roster','花名册'],['seat','坐班表'],['class','上课表'],
  ['research','教研表'],['leave','请假'],['summary','汇总统计表'],
];
const TYPE = { seat:'seat', class:'class', research:'research' };
const TODAY = () => new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'});
const rowData = (r) => r?.data && typeof r.data === 'object' ? r.data : {};
const objectValue = (value) => {
  if (value && typeof value === 'object') return value;
  try { const parsed = JSON.parse(String(value || '')); return parsed && typeof parsed === 'object' ? parsed : {}; }
  catch { return {}; }
};
/* 按键名排序后再序列化：判断「云端这行和本地这行内容是否一模一样」用，
   顺序不同不能算不同，否则每次都会误判成真冲突。 */
const stableValue = (value) => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((out, key) => { out[key] = stableValue(value[key]); return out; }, {});
  }
  return value;
};
const SUMMER_SCHEDULE = '夏令时课表';
const WINTER_SCHEDULE = '冬令时课表';
const FALLBACK_PERIOD_TIMES = {
  [SUMMER_SCHEDULE]: {
    0:['07:00','07:50'],1:['08:00','08:45'],2:['08:55','09:40'],3:['09:50','10:35'],
    4:['10:55','11:40'],5:['14:10','14:55'],6:['15:05','15:50'],7:['16:00','16:45'],
    8:['16:55','17:40'],9:['17:50','18:35'],10:['19:00','19:45'],
  },
  [WINTER_SCHEDULE]: {
    0:['07:20','08:00'],1:['08:00','08:40'],2:['08:50','09:30'],3:['10:00','10:40'],
    4:['10:50','11:30'],5:['11:40','12:20'],6:['14:10','14:50'],7:['15:20','16:00'],
    8:['16:15','16:55'],9:['17:05','17:45'],10:['19:10','19:55'],
  },
};
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
  let isComposingSearch = false;
  let teachers = [], allTeachers = [], tables = [], details = {}, leaveRecords = [], prefs = {};
  let timetableSettings = {}, timetableCourses = [], timetablePeriods = [], periodTimeEdits = {};
  let showAddTeacher = false;
  const draftCache = new Map();
  const currentScheduleType = () => {
    try {
      const saved = objectValue(typeof window !== 'undefined' ? window.localStorage?.getItem('wb_timetable_view_v1') : '');
      return saved.type === WINTER_SCHEDULE ? WINTER_SCHEDULE : SUMMER_SCHEDULE;
    } catch { return SUMMER_SCHEDULE; }
  };
  const resolvePeriodRange = (number) => {
    const periodNo = Number(number);
    if (periodNo === 0) return ['00:00','23:59'];
    const scheduleType = currentScheduleType();
    const periodTimes = objectValue(timetableSettings.periodTimes);
    const periodDefinitions = objectValue(timetableSettings.periodDefinitions);
    const courseTypes = objectValue(timetableSettings.courseTypes);
    const definitionRows = [
      ...(Array.isArray(periodDefinitions[scheduleType + '|' + grade]) ? periodDefinitions[scheduleType + '|' + grade] : []),
      ...(Array.isArray(periodDefinitions[scheduleType + '|全部']) ? periodDefinitions[scheduleType + '|全部'] : []),
    ];
    const configuredPeriod = definitionRows.find(item => Number(item.period_no) === periodNo);
    const normalizedPeriods = normalizeTimetablePeriods(timetablePeriods, {periodTimes,scheduleType});
    const sharedPeriod = normalizedPeriods.find(item =>
      Number(getCanonicalPeriodNumber(item,{periodTimes,scheduleType}) ?? item.period_no) === periodNo
    );
    const course = timetableCourses.find(item => {
      const itemGrade = String(item.grade || '').trim();
      const active = (!item.start_date || date >= String(item.start_date).slice(0,10))
        && (!item.end_date || date <= String(item.end_date).slice(0,10));
      const itemType = courseTypes[String(item.id)] || SUMMER_SCHEDULE;
      const itemPeriod = getCanonicalPeriodNumber(item,{periodTimes,scheduleType});
      return active && itemType === scheduleType
        && (!itemGrade || itemGrade === '全部' || itemGrade === '全体' || itemGrade === grade)
        && Number(itemPeriod) === periodNo
        && cleanPeriodTime(item.start_time) && cleanPeriodTime(item.end_time);
    });
    const override = objectValue(periodTimes[scheduleType])?.[String(periodNo)] || {};
    const fallback = FALLBACK_PERIOD_TIMES[scheduleType]?.[periodNo] || [];
    const defaultPeriod = DEFAULT_PERIODS.find(item => Number(item.no) === periodNo) || {};
    const start = cleanPeriodTime(override.start_time) || cleanPeriodTime(course?.start_time)
      || cleanPeriodTime(configuredPeriod?.start_time) || cleanPeriodTime(sharedPeriod?.start_time)
      || fallback[0] || cleanPeriodTime(defaultPeriod.start) || '08:00';
    const end = cleanPeriodTime(override.end_time) || cleanPeriodTime(course?.end_time)
      || cleanPeriodTime(configuredPeriod?.end_time) || cleanPeriodTime(sharedPeriod?.end_time)
      || fallback[1] || cleanPeriodTime(defaultPeriod.end) || '08:45';
    const editKey = [date,scheduleType,grade,periodNo].join('|');
    const edited = periodTimeEdits[editKey];
    return edited ? [edited.start || start, edited.end || end] : [start,end];
  };
  let busy = false;
  const load = async () => {
    if (busy) return; busy = true;
    try {
      const [g, roster, list, me, courses, periods] = await Promise.all([
        api.get('/grades'), api.get('/teachers',{grade,active:'all'}),
        api.get('/attendance',{grade,sheet_date:date}), api.get('/me').catch(()=>({user:{settings:{}},settings:{}})),
        api.get('/courses').catch(()=>[]), api.get('/periods').catch(()=>[]),
      ]);
      grades = g.grades || grades;
      allTeachers = roster.list || [];
      teachers = allTeachers.filter(t => Number(t.active ?? 1) === 1);
      tables = list || [];
      const userSettings = objectValue(me.user?.settings ?? me.settings);
      timetableSettings = objectValue(userSettings.timetable);
      timetableCourses = Array.isArray(courses) ? courses : [];
      timetablePeriods = Array.isArray(periods) ? periods : [];
      prefs = objectValue(userSettings.attendanceWorkspace);
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
            && Number(record.period ?? period) === Number(period);
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
        await saveRows('class',t,rows);
        t = await api.get('/attendance/'+t.id);
        details[type] = t;
      }
    }
    return t;
  };
  /* 表头版本就地同步：PATCH 表头、写明细（表上有 touch 触发器，已确认的表还会改
     meta.confirm_dirty）都会推进云端的 updated_at。本地 details 里的版本号不跟着换，
     下一次保存就拿过期版本去比对，云端匹配 0 行，于是单人单机也弹
     「表头已被另一台设备修改」——自动保存一开就必撞。 */
  const syncHeader = (type, table, header) => {
    if (!header || !header.id) return table;
    Object.assign(table, header);
    if (type) details[type] = table;
    return table;
  };
  /* 保存串行化：自动保存的 350ms 防抖回调和「切页签/节次前落盘」会撞在一起，
     两个请求拿同一个表头版本，后一个必然被判成冲突。排队执行，谁都不用抢。 */
  let saveQueue = Promise.resolve();
  const queueSave = (task) => {
    const run = saveQueue.then(task, task);
    saveQueue = run.then(() => null, () => null);
    return run;
  };
  /* 云端冲突原文（WB_ATTENDANCE_CONFLICT: …）不该直接怼到用户脸上：
     表头版本对不上属内部时序问题，下面已自动重试；只有明细行真被别的设备改过
     才需要用户核对，那时候也必须说清「这次没保存」。 */
  const attendanceErrorText = (error) => {
    const text = String(error?.message || error || '');
    if (error?.conflictScope === 'rows') {
      return '这张考勤表刚在另一台设备上改过。为避免覆盖，本次未保存；请刷新后核对再改。';
    }
    if (/WB_ATTENDANCE_CONFLICT/.test(text)) {
      return '表头版本刚被更新过，已自动重新同步；如果反复出现，请刷新页面后再试。';
    }
    return text || '保存失败，请检查网络后重试';
  };
  const saveRows = async (type, table, rows) => {
    /* 保存成功后把云端的最新版本回填到本地缓存。
       表头、每一行都有自己的 updated_at，写入一次就全变；不回填的话，
       下一次点击（或切回别的节次草稿）还拿旧版本去比对，
       刚被自己保存过的行会被判成「另一台设备改过」，与表头那条同源。 */
    const refreshSavedVersions = async () => {
      const fresh = await api.get('/attendance/'+table.id).catch(() => null);
      if (!fresh?.id) return;
      const header = {...fresh};
      delete header.rows;
      syncHeader(type, table, header);
      const byId = new Map((fresh.rows||[]).map(row=>[String(row.id), row]));
      const stamp = row => {
        const saved = row?.id ? byId.get(String(row.id)) : null;
        if (saved?.updated_at) row.updated_at = saved.updated_at;
      };
      (rows||[]).forEach(stamp);
      draftCache.forEach(cached=>(cached||[]).forEach(stamp));
      (details[type]?.rows||[]).forEach(stamp);
    };
    /* 写明细会让表头版本前进，所以表头节次要在写明细之前对齐，
       并且一律用云端最新版本号去比对。 */
    if (String(table.periods || '') !== String(period)) {
      const patchHeader = (expected) => api.patch('/attendance/'+table.id,
        {expected_updated_at:expected || '',periods:String(period)});
      let header;
      try {
        header = await patchHeader(table.updated_at);
      } catch (error) {
        /* 版本号过期多半是刚被自己上一次保存推进的：表头只存节次这类元数据，
           不该因此打断录入 —— 取最新版本重试一次，仍失败才算真冲突。 */
        if (!/WB_ATTENDANCE_CONFLICT/.test(String(error?.message || error || ''))) throw error;
        const latest = await api.get('/attendance/'+table.id).catch(() => null);
        header = await patchHeader(latest?.updated_at || '');
      }
      /* 这一步不能省：PATCH 成功后云端 updated_at 已经变了，
         本地还留旧值的话，下一次保存必定再被判成冲突。 */
      syncHeader(type, table, header);
    }
    const payload = rows.map(r => ({id:r.id,teacher:r.teacher,subject:r.subject,data:rowData(r),expected_updated_at:r.updated_at || ''}));
    try {
      const res = await api.post('/attendance/'+table.id+'/rows',{rows:payload,dirty:true});
      if (Array.isArray(res?.ids)) rows.forEach((r,i)=>{ if(!r.id && res.ids[i]) r.id=res.ids[i]; });
      await refreshSavedVersions();
      return res;
    } catch (error) {
      if (!/WB_ATTENDANCE_CONFLICT/.test(String(error?.message || error || ''))) throw error;
      /* 版本冲突先比内容：如果云端每一行都和这次要写的一模一样，说明只是自己
         上一次保存把版本推进了（重复写同样的值），回填最新版本重发一次就行；
         内容真的不同才算「另一台设备改过」，那种才必须让用户核对。 */
      const latest = await api.get('/attendance/'+table.id).catch(() => null);
      if (latest?.id) {
        const byId = new Map((latest.rows||[]).map(row=>[String(row.id), row]));
        const identical = rows.every(row=>{
          if (!row.id) return true;
          const current = byId.get(String(row.id));
          if (!current) return false;
          return String(current.teacher||'')===String(row.teacher||'')
            && String(current.subject||'')===String(row.subject||'')
            && JSON.stringify(stableValue(current.data||{}))===JSON.stringify(stableValue(rowData(row)));
        });
        if (identical) {
          rows.forEach(row=>{
            const current = row.id ? byId.get(String(row.id)) : null;
            if (current?.updated_at) row.updated_at = current.updated_at;
          });
          const latestHeader = {...latest};
          delete latestHeader.rows;
          syncHeader(type, table, latestHeader);
          const retry = rows.map(r => ({id:r.id,teacher:r.teacher,subject:r.subject,data:rowData(r),expected_updated_at:r.updated_at || ''}));
          const res = await api.post('/attendance/'+table.id+'/rows',{rows:retry,dirty:true});
          if (Array.isArray(res?.ids)) rows.forEach((r,i)=>{ if(!r.id && res.ids[i]) r.id=res.ids[i]; });
          await refreshSavedVersions();
          return res;
        }
      }
      /* 明细行版本冲突才是真的「另一台设备改过」：留给用户核对，不能被自动重试掩盖。 */
      error.conflictScope = 'rows';
      throw error;
    }
  };
  const persistAndReload = async (type, rows, message='已保存') => queueSave(async () => {
    const t = await getTable(type);
    await saveRows(type,t,rows);
    toast(message,'ok'); await load();
  });
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
      else if(type==='class')rows=source.filter(row=>(!!rowData(row).__classRecord
        && Number(rowData(row).__classRecord.period??period)===Number(period)) || rowData(row).__teacherGrid?.[String(period)]);
      else if(type==='research')rows=source.filter(row=>(!!rowData(row).__research
        && matchesAttendancePeriod(rowData(row).__research.period_time,period)) || rowData(row).__teacherGrid?.[String(period)]);
      draftCache.set(key,rows);
    }
    const rows=draftCache.get(key);
    if(type==='seat'){
      for(const teacher of teachers)if(!rows.some(row=>row.teacher===teacher.name))
        rows.push({teacher:teacher.name,subject:teacher.subject||'',data:{__periods:{}}});
    }else if(type==='class'){
      for(const teacher of teachers){
        const exists=rows.some(row=>!rowData(row).__deleted&&row.teacher===teacher.name
          && Number(rowData(row).__classRecord?.period??period)===Number(period));
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
            subject:subjectName,period_time:(period===0?'全天':'第'+period+'节'),location:'',host:'',
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
          && Number(rowData(row).__classRecord?.period??period)===Number(period)
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
    return mergeTeacherGridRows(rows,draftRows,period);
  };
  const persistDraft = async (type,{reload=true,key:overrideKey=null}={}) => queueSave(async () => {
    /* overrideKey：自动保存可能在用户切了日期/节次之后才触发，必须写回点击时
       那张草稿，否则会把改动写进新节次的空草稿里、旧改动丢掉。 */
    const key=overrideKey||draftKey(type),draftRows=draftCache.get(key)||getDraftRows(type),table=await getTable(type);
    const rows=mergeDraftRows(type,table,draftRows);
    await saveRows(type,table,rows);
    if(reload){
      draftCache.delete(key);
      await load();
    }else{
      /* 自动保存：不重载页面（每点一次都闪一下没法用），但要把刚写入的行同步回
         details 和草稿缓存，否则切页签回来会从旧数据重建草稿、刚点的状态丢掉。 */
      if(details[type])details[type]={...details[type],rows};
      draftCache.set(key,draftRows);
    }
  });
  /* 用户 11-12 裁决：去掉「保存本表」，点一下单元格就自动落盘。成功静默，
     只在失败时提示，避免每点一次弹一次「已保存」。 */
  let autoSaveTimer=null,autoSaveKey=null,autoSaveType=null;
  const scheduleAutoSave = type => {
    clearTimeout(autoSaveTimer);
    autoSaveKey=draftKey(type);autoSaveType=type;
    autoSaveTimer=setTimeout(async()=>{
      autoSaveTimer=null;
      try{await persistDraft(type,{reload:false,key:autoSaveKey});}
      catch(error){toast(attendanceErrorText(error),'err',4000);}
    },350);
  };
  /* 切页签/节次/日期之前先把待写的内容落盘，避免刚点完就切换导致改动丢失 */
  const flushAutoSave = async () => {
    if(!autoSaveTimer)return;
    clearTimeout(autoSaveTimer);autoSaveTimer=null;
    try{await persistDraft(autoSaveType,{key:autoSaveKey});}
    catch(error){toast(attendanceErrorText(error),'err',4000);}
  };
  const generateTable = async type => {
    const existed=!!details[type];
    await persistDraft(type,{reload:false});
    await load();
    tab=type;paint();
    toast((existed?'已更新':'已生成')+({seat:'坐班表',class:'上课表',research:'教研表'}[type]),'ok');
  };
  const teacherSubjects = () => [...new Set([...teachers, ...(tab === 'leave' ? leaveRecords : [])].map(item=>String(item.subject||'').trim()).filter(Boolean))].sort();
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
      +'<label>归属年级 <em>*</em><input name="grade" type="text" list="aprd-add-grades" value="'+esc(grade)+'" placeholder="请输入或选择归属年级" maxlength="12" required><datalist id="aprd-add-grades">'+grades.map(item=>'<option value="'+esc(item)+'"></option>').join('')+'</datalist></label>'
      +'<label>归属部门<input name="department" type="text" value="高中部" placeholder="请输入归属部门"></label>'
      +'<div class="aprd-roster-add-actions"><button type="button" data-roster-add-cancel>取消</button><button type="submit" class="primary">保存教师</button></div>'
      +'</form></section>';
  };
  const saveDraftButton = (type,label) => '<button '+(details[type]?'':'disabled')+' data-save-'+type+'>'+(details[type]?label:'生成后可保存修改')+'</button>';
  const rosterKey = (row) => String(row.name || '').trim().replace(/\s+/g,'').toLowerCase() + '\u0000' + String(row.subject || '').trim().replace(/\s+/g,'').toLowerCase();
  const rosterGrid = (list) => buildAttendanceExportGrid({
    type: TYPE[tab] ? tab : tab === 'leave' ? 'leave' : 'roster',
    grade, date, period, teachers: list,
    seatRows: tab === 'seat' ? getDraftRows('seat') : details.seat?.rows || [],
    classRows: tab === 'class' ? getDraftRows('class') : details.class?.rows || [],
    researchRows: tab === 'research' ? getDraftRows('research') : details.research?.rows || [],
    leaveRecords: activeLeavesFor(leaveRecords, date),
    teacherMeta: prefs.teacherMeta || {},
    resolvePeriodRange,
    includeUnlisted: true,
  });
  const downloadRosterTemplate = () => {
    const grid=[['教师花名册导入模板'],['序号','归属部门','归属年级','姓名','学科'],['1','高中部',grade,'','']];
    saveBlob(makeXlsx({title:'花名册导入模板',grid}),'教师花名册导入模板.xlsx');
  };
  /* 把导出网格切成多页 PNG：每页都带表头和页码，避免一张几千像素的长图
     在手机上无法上下滑动。 */
  const buildPngPages = (grid, fileBase, rowCount) => {
    const headers=grid[1], bodyRows=grid.slice(2);
    const widths=headers.map((header,index)=>{
      const max=Math.max(String(header).length,...bodyRows.map(row=>String(row[index]??'').length));
      return Math.max(90,Math.min(260,70+max*13));
    });
    const totalWidth=widths.reduce((sum,value)=>sum+value,0);
    const rowH=42,titleH=76,footH=34,rowsPerPage=18;
    const pages=[];
    for(const page of paginateExportGrid(grid, rowsPerPage)){
      const slice=page.rows, pageCount=page.pageCount, pageIndex=page.index;
      const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d');
      canvas.width=totalWidth;
      canvas.height=titleH+(slice.length+1)*rowH+footH;
      ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);
      ctx.fillStyle='#172744';ctx.font='bold 22px "Microsoft YaHei",sans-serif';ctx.fillText(fileBase,20,30);
      ctx.fillStyle='#667085';ctx.font='12px "Microsoft YaHei",sans-serif';
      ctx.fillText('导出时间：'+new Date().toLocaleString('zh-CN')+'　共 '+rowCount+' 条　第 '+(pageIndex+1)+'/'+pageCount+' 页',20,53);
      let y=titleH,x=0;
      headers.forEach((label,index)=>{
        ctx.fillStyle='#eef3fa';ctx.fillRect(x,y,widths[index],rowH);
        ctx.strokeStyle='#d8e1ed';ctx.strokeRect(x,y,widths[index],rowH);
        ctx.fillStyle='#34445d';ctx.font='bold 12px "Microsoft YaHei",sans-serif';
        ctx.fillText(String(label),x+8,y+26);x+=widths[index];
      });
      slice.forEach((row,rowIndex)=>{
        y+=rowH;x=0;
        row.forEach((value,index)=>{
          ctx.fillStyle=rowIndex%2?'#f9fbfe':'#fff';ctx.fillRect(x,y,widths[index],rowH);
          ctx.strokeStyle='#e3eaf3';ctx.strokeRect(x,y,widths[index],rowH);
          ctx.fillStyle='#34445d';ctx.font='12px "Microsoft YaHei",sans-serif';
          ctx.fillText(String(value??'').slice(0,32),x+8,y+26);x+=widths[index];
        });
      });
      ctx.fillStyle='#8290a5';ctx.font='11px "Microsoft YaHei",sans-serif';
      ctx.fillText('第 '+(pageIndex+1)+' / '+pageCount+' 页 · 共 '+rowCount+' 条',20,canvas.height-12);
      pages.push(canvas.toDataURL('image/png'));
    }
    return pages;
  };
  const openPngPreview = (pages, fileBase, rowCount) => {
    const dialog=document.createElement('div');
    dialog.className='attendance-prd aprd-dialog aprd-png-dialog';
    dialog.innerHTML='<section class="aprd-png-preview"><header><div><h3>'+esc(fileBase)+'</h3>'
      +'<p>共 '+rowCount+' 条 · 分成 '+pages.length+' 张图片，可上下滑动查看</p></div>'
      +'<button type="button" data-png-close aria-label="关闭">×</button></header>'
      +'<div class="aprd-png-scroll">'+pages.map((src,index)=>'<figure><img src="'+src+'" alt="第 '+(index+1)+' 页"><figcaption>第 '+(index+1)+' / '+pages.length+' 页</figcaption></figure>').join('')+'</div>'
      +'<footer><button type="button" data-png-close>关闭</button>'
      +'<button type="button" class="primary" data-png-download>下载全部图片（'+pages.length+' 张）</button></footer></section>';
    document.body.append(dialog);
    const close=()=>{dialog.remove();document.removeEventListener('keydown',onKey);};
    const onKey=event=>{if(event.key==='Escape')close();};
    document.addEventListener('keydown',onKey);
    dialog.querySelectorAll('[data-png-close]').forEach(button=>button.addEventListener('click',close));
    dialog.addEventListener('click',event=>{if(event.target===dialog)close();});
    dialog.querySelector('[data-png-download]').addEventListener('click',async()=>{
      const button=dialog.querySelector('[data-png-download]');
      button.disabled=true;
      try{
        for(let index=0;index<pages.length;index+=1){
          const blob=await (await fetch(pages[index])).blob();
          saveBlob(blob,fileBase+'（第'+(index+1)+'页）.png');
          if(index<pages.length-1)await new Promise(resolve=>setTimeout(resolve,400));
        }
        toast('已导出 '+pages.length+' 张图片','ok');
      }catch(error){toast(error.message||'图片下载失败','err');}
      finally{button.disabled=false;}
    });
  };
  const exportRoster = (format) => {
    const scope=root.querySelector('#aprd-export-scope')?.value || 'all';
    const list=scope==='filtered'?visibleTeachers():teachers.slice();
    const exportType = TYPE[tab] ? tab : tab === 'leave' ? 'leave' : 'roster';
    const scopedLeaveRecords = activeLeavesFor(leaveRecords, date)
      .filter(record => scope !== 'filtered' || list.some(teacher => teacher.name === (record.name || record.teacher)));
    const grid=buildAttendanceExportGrid({
      type: exportType, grade, date, period, teachers: list,
      seatRows: tab === 'seat' ? getDraftRows('seat') : details.seat?.rows || [],
      classRows: tab === 'class' ? getDraftRows('class') : details.class?.rows || [],
      researchRows: tab === 'research' ? getDraftRows('research') : details.research?.rows || [],
      leaveRecords: scopedLeaveRecords,
      teacherMeta: prefs.teacherMeta || {},
      resolvePeriodRange,
      includeUnlisted: scope !== 'filtered',
    });
    const rowCount = Math.max(0, grid.length - 2);
    if(!rowCount){toast('当前表格没有符合条件的记录','warn');return;}
    const typeLabel = ({roster:'花名册',seat:'坐班表',class:'上课表',research:'教研表',leave:'请假总表'})[exportType];
    const fileBase=(grade||'教师')+typeLabel+'-'+date+'-'+(period===0?'全天':'第'+period+'节');
    if(format==='xlsx'){
      saveBlob(makeXlsx({title:fileBase,grid}),fileBase+'.xlsx');
    }else if(format==='csv'){
      const csv='\uFEFF'+grid.map(row=>row.map(value=>'"'+String(value??'').replace(/"/g,'""')+'"').join(',')).join('\r\n');
      saveBlob(new Blob([csv],{type:'text/csv;charset=utf-8'}),fileBase+'.csv');
    }else if(format==='pdf'){
      const win=window.open('','_blank');
      if(!win){toast('浏览器拦截了打印窗口，请允许本站弹出窗口后重试','warn');return;}
      const body=grid.slice(2).map(row=>'<tr>'+row.map(cell=>'<td>'+esc(cell)+'</td>').join('')+'</tr>').join('');
      win.document.write('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>'+esc(fileBase)+'</title><style>body{font-family:Arial,"Microsoft YaHei",sans-serif;padding:24px;color:#1d2939}h1{font-size:20px}p{color:#667085;font-size:12px}table{width:100%;border-collapse:collapse;font-size:12px}th,td{border:1px solid #d0d5dd;padding:8px;text-align:left}th{background:#f2f4f7}</style><h1>'+esc(fileBase)+'</h1><p>导出时间：'+esc(new Date().toLocaleString('zh-CN'))+'　共 '+rowCount+' 条</p><table><thead><tr>'+grid[1].map(cell=>'<th>'+esc(cell)+'</th>').join('')+'</tr></thead><tbody>'+body+'</tbody></table><script>window.onload=function(){window.print()}<\\/script></html>');
      win.document.close();
    }else if(format==='png'){
      /* 整张长图在手机相册/预览器里没法上下滑动，改成分页（每页 18 行），
         先给可滚动的预览，确认后再下载，内容和页面表格逐格一致。 */
      openPngPreview(buildPngPages(grid, fileBase, rowCount), fileBase, rowCount);
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
      fields.map(f=>{
        const value=initial[f.key]??'';
        const required=f.required?' required':'';
        const input=f.type==='select'?'<select name="'+escAttr(f.key)+'"'+required+'>'+f.options.map(o=>'<option '+(String(value)===String(o.value)?'selected':'')+' value="'+escAttr(o.value)+'">'+esc(o.label)+'</option>').join('')+'</select>'
          :f.type==='textarea'?'<textarea name="'+escAttr(f.key)+'">'+esc(value)+'</textarea>'
          :'<input name="'+escAttr(f.key)+'" type="'+(f.type==='combo'?'text':f.type||'text')+'" value="'+escAttr(value)+'"'+required+(f.min!==undefined?' min="'+f.min+'"':'')+(f.step?' step="'+f.step+'"':'')+(f.type==='combo'?' list="aprd-editor-'+escAttr(f.key)+'-options"':'')+'>'+(f.type==='combo'?'<datalist id="aprd-editor-'+escAttr(f.key)+'-options">'+(f.options||[]).map(o=>'<option value="'+escAttr(o.value)+'"></option>').join('')+'</datalist>':'');
        return '<label>'+esc(f.label)+input+'</label>';
      }).join('')+
      '<div class="aprd-foot"><button type="button" data-cancel>取消</button><button class="primary" type="submit">保存</button></div></form>';
    (root.querySelector('.attendance-prd') || root).append(dialog); const form=dialog.querySelector('form');
    const durationUnit=form.querySelector('[name="duration_unit"]');
    const durationInput=form.querySelector('[name="days"]');
    const syncDurationMode=()=>{
      if(!durationUnit||!durationInput)return;
      const halfDay=['morning','afternoon'].includes(durationUnit.value);
      if(halfDay){durationInput.value='0.5';durationInput.readOnly=true;}
      else durationInput.readOnly=false;
    };
    durationUnit?.addEventListener('change',syncDurationMode);
    syncDurationMode();
    dialog.querySelector('[data-cancel]').onclick=()=>dialog.remove();
    form.onsubmit=async e=>{e.preventDefault();const data=Object.fromEntries(new FormData(form));try{await onSave(data);dialog.remove();}catch(err){toast(err.message||'保存失败','err');}};
  };
  const editLeaveRecord = (record = null, defaultTeacher = null) => {
    const recordName=record?.name||record?.teacher||'';
    const teacherOptions=teachers.map(x=>({value:x.name,label:x.name+' · '+x.subject}));
    if(recordName&&!teacherOptions.some(x=>x.value===recordName))teacherOptions.push({value:recordName,label:recordName+'（历史记录）'});
    openEditor(record?'修改请假记录':'登记请假',[
      {key:'teacher',label:'教师（可选择或手动输入）',type:'combo',options:teacherOptions,required:true},
      {key:'type',label:'类型',type:'select',options:[{value:'',label:'无（取消请假）'},...LEAVE_TYPES.map(x=>({value:x,label:x}))]},
      {key:'start_date',label:'开始日期',type:'date'},
      {key:'end_date',label:'结束日期',type:'date'},
      {key:'days',label:'请假时长（天支持0.5，小时支持小数）',type:'number',min:'0.01',step:'any',required:true},
      {key:'duration_unit',label:'时长单位',type:'select',options:[
        {value:'day',label:'天（支持0.5天）'},
        {value:'morning',label:'上午（0.5天）'},
        {value:'afternoon',label:'下午（0.5天）'},
        {value:'hour',label:'小时（支持小数）'},
      ]},
      {key:'status',label:'状态',type:'select',options:['待批','已批','已撤销'].map(x=>({value:x,label:x}))},
      {key:'remark',label:'备注',type:'textarea'},
    ],{
      teacher:recordName||defaultTeacher?.name||teachers[0]?.name||'',
      type:record?.type||'',start_date:record?.start_date||date,end_date:record?.end_date||date,
      days:record?.duration??(record?.hours||record?.days||1),duration_unit:record?.duration_unit||(record?.hours?'hour':'day'),status:record?.status||'待批',remark:record?.remark||'',
    },async data=>{
      const teacherName=String(data.teacher||'').trim();
      if(data.type && !teacherName)throw new Error('请填写教师姓名');
      const who=teachers.find(x=>x.name===teacherName);
      const duration = data.type ? parseLeaveDuration(data.days,data.duration_unit) : null;
      if(data.type && data.end_date < data.start_date)throw new Error('结束日期不能早于开始日期');
      const next=record
        ? leaveRecords.filter(x=>x!==record&&String(x.id)!==String(record.id))
        : leaveRecords.slice();
      if(data.type){
        next.push({
          ...(record||{}),id:record?.id||Date.now(),grade:record?.grade||grade,
          name:teacherName||recordName||'',subject:who?.subject||record?.subject||'',type:data.type,
          start_date:data.start_date||date,end_date:data.end_date||data.start_date||date,
          ...duration,status:data.status||'待批',remark:data.remark||'',
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
      return !data.__deleted && row.teacher===teacher.name && Number(record.period??period)===Number(period);
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
      await saveRows('class',table,table.rows||[]);
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
      class_name:existingData.class_name||'',period:String(existingData.period??period),
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
        ...existingData,class_name:String(data.class_name||'').trim(),period:Number(data.period??period),
        status:data.status||'u',
        listeners:String(data.listeners||'').split(/[、,，]/).map(x=>x.trim()).filter(Boolean),
        remark:data.remark||'',
      };
      row.data={...rowData(row),__classRecord:record};
      await saveRows('class',table,table.rows||[]);
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
      await saveRows('research',table,table.rows||[]);
      await load();
    };
    if(existing){
      const record={...rowData(existing).__research};
      if(!String(record.period_time||'').trim()||!String(record.host||'').trim()){
        openEditor('完善教研登记',[
          {key:'period_time',label:'节次/时间',required:true},
          {key:'location',label:'地点'},
          {key:'host',label:'主持人',required:true},
        ],{period_time:record.period_time||(period===0?'全天':'第'+period+'节'),location:record.location||'',host:record.host||teacher.name},
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
      await saveRows('research',table,table.rows||[]);
      await load();
      return;
    }
    openEditor('登记教研签到',[
      {key:'period_time',label:'节次/时间',required:true},
      {key:'location',label:'地点'},
      {key:'host',label:'主持人',required:true},
    ],{period_time:(period===0?'全天':'第'+period+'节'),location:'',host:teacher.name},async data=>{
      const attendees=[teacher.name];
      table.rows.push({
        teacher:subjectName||teacher.name,subject:subjectName,
        data:{__research:{
          ...data,subject:subjectName,expected:members.length,attendees,
          absent:members.filter(name=>!attendees.includes(name)),status:'已登记',
        }},
      });
      await saveRows('research',table,table.rows);
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
  const rosterHtml = (type = 'roster') => {
    const editable = type !== 'roster', list = visibleTeachers();
    const draftRows = editable ? getDraftRows(type) : [];
    const context = {leaveRecords,date,period};
    const rows = list.map((teacher,index) => {
      const state = editable ? deriveTableGridState(teacher,type,draftRows,context)
        : deriveRosterState(teacher,{...context,seatRows:details.seat?.rows||[],
          classRows:details.class?.rows||[],researchRows:details.research?.rows||[]});
      /* 请假优先级最高：已请假的人其他四类格子显示为未登记，与导出和 KPI 口径一致，
         避免出现「上课✓ + 请假 事假」这种自相矛盾的行。 */
      const shown = state.leave
        ? {...state, class:'u', sit:'u', listen:'u', research:'u', listenStatus:'u', researchStatus:'u'}
        : state;
      /* 状态格：绿色正常 / 黄色待确认 / 红色异常，未登记时由调用方显示占位符。
         花名册是只读汇总视图，未登记一律显示「—」占位。 */
      const mark = (key,value) => {
        value = value === 'y' || value === 'n' ? value : 'u';
        const label = value === 'y' ? '正常' : value === 'n' ? '异常' : '待确认';
        const showLabel = editable || value !== 'u';
        const tag = editable ? 'button' : 'span';
        const attrs = editable ? 'type="button" data-grid-person="'+esc(teacher.id)+'" data-grid-key="'+key+'"' : 'aria-disabled="true"';
        return '<'+tag+' class="aprd-mark '+value+(showLabel?'':' ap-placeholder')+'" '+attrs+' aria-label="'+esc(teacher.name+' '+({class:'上课',sit:'坐班',listen:'听课',research:'教研'}[key])+'：'+label)+'">'+(showLabel?'<i></i>'+label:'—')+'</'+tag+'>';
      };
      const listen = shown.listenStatus || (shown.listen === true || shown.listen === 'y' ? 'y' : 'u');
      const research = shown.researchStatus || (shown.research === true || shown.research === 'y' ? 'y' : 'u');
      const leave = editable ? '<select class="aprd-leave-select '+(state.leave?'on':'')+'" data-grid-person="'+esc(teacher.id)+'" data-grid-key="leave" aria-label="'+esc(teacher.name+' 请假')+'">'
        +['',...new Set([...LEAVE_TYPES,state.leave].filter(Boolean))].map(value=>'<option value="'+esc(value)+'" '+(state.leave===value?'selected':'')+'>'+esc(value||'无')+'</option>').join('')+'</select>'
        : (state.leave?'<span class="aprd-mark leave"><i></i>'+esc(state.leave)+'</span>':'<span class="aprd-mark ap-placeholder">—</span>');
      const remark = editable ? '<input data-grid-person="'+esc(teacher.id)+'" data-grid-key="remark" value="'+esc(state.remark||'')+'" aria-label="'+esc(teacher.name+' 备注')+'">'
        : '<span class="aprd-remark" title="'+escAttr(noteOf(teacher))+'">'+esc(noteOf(teacher)||'—')+'</span>';
      return '<tr><td>'+(index+1)+'</td><td>'+esc(deptOf(teacher))+'</td><td>'+esc(teacher.grade||grade)+'</td>'
        +'<td><b>'+esc(teacher.name)+'</b></td><td>'+esc(teacher.subject||'')+'</td>'
        +'<td>'+mark('class',shown.class)+'</td><td>'+mark('sit',shown.sit)+'</td>'
        +'<td>'+mark('listen',listen)+'</td><td>'+mark('research',research)+'</td><td>'+leave+'</td><td>'+remark+'</td>'
        +'<td><div class="aprd-actions"><button type="button" class="aprd-link" data-edit="'+esc(teacher.id)+'">'+icon('edit',13)+'编辑教师</button>'
        +(!editable?'<button type="button" class="aprd-link danger" data-disable="'+esc(teacher.id)+'">'+icon('trash',13)+'删除</button>':'')+'</div></td></tr>';
    }).join('');
    const tools = '<button class="primary aprd-add-btn" data-add>'+(showAddTeacher?'收起表单':'＋ 新增教师')+'</button>'
      +'<button type="button" data-roster-import>批量导入</button><div class="aprd-export-wrap"><button type="button" data-roster-export-toggle>批量导出 ▾</button>'
      +'<div class="aprd-export-menu" data-roster-export-menu hidden><label>导出范围 <select id="aprd-export-scope"><option value="all">全部在岗人员</option><option value="filtered">当前筛选结果</option></select></label>'
      +'<button data-roster-export="xlsx">Excel 表格</button><button data-roster-export="csv">CSV 文件</button><button data-roster-export="pdf">PDF 文档</button><button data-roster-export="png">PNG 图片</button>'
      +'<button type="button" data-copy>复制名单</button></div></div>'
      +'<button type="button" data-subject-manager>学科管理</button>';
    const summaryContext = {
      leaveRecords,date,period,
      seatRows:type==='seat'?draftRows:(details.seat?.rows||[]),
      classRows:type==='class'?draftRows:(details.class?.rows||[]),
      researchRows:type==='research'?draftRows:(details.research?.rows||[]),
    };
    const currentStates = editable ? list.map(teacher=>deriveRosterState(teacher,summaryContext)) : [];
    const summaryItems = [
      ['当前筛选教师',list.length+'人'],
      ['正在坐班',currentStates.filter(state=>state.sit==='y').length+'人'],
      ['正在上课',currentStates.filter(state=>state.class==='y').length+'人'],
      ['听课教师',currentStates.filter(state=>!!state.listen).length+'人'],
      ['教研教师',currentStates.filter(state=>!!state.research).length+'人'],
      ['请假教师',currentStates.filter(state=>!!state.leave).length+'人'],
    ];
    const summaryStrip = editable
      ? '<div class="aprd-kpis aprd-grid-summary">'+summaryItems.map(([label,value])=>'<div class="aprd-kpi"><span>'+label+'</span><b>'+value+'</b></div>').join('')+'</div>'
      : '';
    return '<div class="aprd-toolbar"><div class="aprd-toolbar-main">'+teacherFiltersHtml()+tools+'</div>'
      +'<span class="aprd-filter-count">当前筛：'+esc(subject||'全部')+' · '+list.length+' 人</span></div>'+teacherAddCardHtml()+summaryStrip
      +'<div class="aprd-table-wrap"><table><thead><tr>'+ATTENDANCE_COLUMNS[type].map(column=>'<th>'+column+'</th>').join('')
      +'</tr></thead><tbody>'+(rows||'<tr><td colspan="12" class="aprd-empty">当前筛选下暂无在岗教师</td></tr>')+'</tbody></table></div>'
      +'<p class="aprd-note">'+(editable?'本表独立登记、独立保存；花名册汇总已保存的三张表。切换页签保留本表草稿。':'花名册考勤状态仅供查看，汇总当前日期和节次已保存的三张表；请在工作表中登记。')+'</p>';
  };
  const leaveHtml = () => {
    const shown=leaveRecords.filter(x=>(!search||(x.name+' '+x.subject).includes(search))&&(!subject||x.subject===subject));
    return '<div class="aprd-toolbar"><div class="aprd-toolbar-main">'+teacherFiltersHtml()+'<button class="primary" data-add-leave>新增请假</button></div></div><div class="aprd-table-wrap"><table><thead><tr>'+ATTENDANCE_COLUMNS.leave.map(c=>'<th>'+c+'</th>').join('')+'<th>操作</th></tr></thead><tbody>'+shown.map((x)=>'<tr><td>'+esc(x.name)+'</td><td>'+esc(x.subject)+'</td><td>'+esc(x.type)+'</td><td>'+esc(x.start_date)+'</td><td>'+esc(x.end_date)+'</td><td>'+esc(formatLeaveDuration(x))+'</td><td><span class="aprd-status '+(x.status==='已批'?'approved':'pending')+'">'+esc(x.status)+'</span></td><td>'+esc(x.remark||'')+'</td><td><button data-edit-leave="'+x.id+'">编辑</button> <button data-delete-leave="'+x.id+'">删除</button></td></tr>').join('')+'</tbody></table></div>';
  };
  const summaryHtml = () => {
    const filteredTeachers=visibleTeachers();
    const filteredLeaves=leaveRecords.filter(item=>(!subject||item.subject===subject)&&(!search||((item.name||item.teacher||'')+' '+(item.subject||'')).toLowerCase().includes(search.toLowerCase())));
    const s=calculateDailySummary({teachers:filteredTeachers,seatRows:details.seat?.rows||[],classRows:details.class?.rows||[],researchRows:details.research?.rows||[],leaveRecords:filteredLeaves,date});
    const kpis=[['应到教师',s.expectedTeachers+'人'],['坐班次数',s.seatPresent],['上课次数',s.classes],['听课人次',s.listens],['请假人数',s.leavePeople+'人']];
    return '<div class="aprd-toolbar"><div class="aprd-toolbar-main">'+teacherFiltersHtml()+'</div></div><div class="aprd-kpis">'+kpis.map(([a,b],i)=>'<div class="aprd-kpi"><span>'+a+'</span><b style="'+''+'">'+b+'</b></div>').join('')+'</div><div class="aprd-table-wrap"><table><thead><tr>'+ATTENDANCE_COLUMNS.summary.map(c=>'<th>'+c+'</th>').join('')+'</tr></thead><tbody>'+s.rows.map(r=>'<tr><td>'+r.serial+'</td><td>'+esc(r.name)+'</td><td>'+esc(r.subject)+'</td><td>'+r.seatPresent+'</td><td>'+r.classes+'</td><td>'+r.listens+'</td><td>'+r.research+'</td><td>'+esc(formatLeaveDuration({days:r.leaveDays,hours:r.leaveHours}))+'</td><td>'+esc(r.overall)+'</td></tr>').join('')+'</tbody></table></div>';
  };
  const paint = () => {
    const content = ['roster','seat','class','research'].includes(tab)?rosterHtml(tab):tab==='leave'?leaveHtml():summaryHtml();
    const periodRange = resolvePeriodRange(period);
    root.innerHTML='<div class="attendance-prd">'
      +'<header class="aprd-head"><div class="aprd-head-title"><h2>考勤管理</h2><p>按年级独立管理坐班、教研与上课记录；完成后人工确认生效</p></div>'
      +'<span class="aprd-live"><i></i>实时</span></header>'
      +'<div class="aprd-grade">'+grades.map(g=>'<button data-grade-tab="'+esc(g)+'" class="'+(g===grade?'on':'')+'">'+esc(g)+'</button>').join('')+'</div>'
      +'<div class="aprd-filter"><div class="aprd-filter-fields">'
      +'<label>日期 <input type="date" id="aprd-date" value="'+date+'"></label>'
      +'<label>节次 <select id="aprd-period"><option value="0" '+(period===0?'selected':'')+'>全天</option>'+DEFAULT_PERIODS.map(p=>'<option value="'+p.no+'" '+(p.no===period?'selected':'')+'>'+p.label+'</option>').join('')+'</select></label>'
      +'<label>时段 <span class="aprd-time-range"><input type="time" id="aprd-start" value="'+periodRange[0]+'"><span class="aprd-time-sep">—</span><input type="time" id="aprd-end" value="'+periodRange[1]+'"></span></label>'
      +'</div><div class="aprd-filter-actions"><select id="aprd-generate" class="aprd-generate" aria-label="选择要生成的表"><option value="seat">生成坐班表</option><option value="class">生成上课表</option><option value="research">生成教研表</option></select>'
      +'<button class="primary" data-generate>确认生成</button><button type="button" class="aprd-voice" data-workspace-voice>'+icon('speak',15)+'语音登记</button></div></div>'
      +'<nav class="aprd-tabs">'+TABS.map(([id,label])=>'<button data-tab="'+id+'" class="'+(tab===id?'on':'')+'">'+label+'</button>').join('')+'</nav>'
      +'<section class="aprd-panel">'+content+'</section></div>';
    if(TYPE[tab]) root.querySelector('#aprd-generate').value=tab;
    root.querySelectorAll('[data-tab]').forEach(b=>b.onclick=async()=>{await flushAutoSave();tab=b.dataset.tab;search='';subject='';paint();});
    root.querySelectorAll('[data-grade-tab]').forEach(b=>b.onclick=async()=>{await flushAutoSave();grade=b.dataset.gradeTab;await load();});
    root.querySelector('#aprd-date').onchange=async e=>{await flushAutoSave();date=e.target.value;await load();};
    root.querySelector('#aprd-period').onchange=async e=>{await flushAutoSave();period=Number(e.target.value);paint();};
    const rememberPeriodTime = () => {
      const start=root.querySelector('#aprd-start')?.value||'';
      const end=root.querySelector('#aprd-end')?.value||'';
      if(start&&end&&start>=end){toast('结束时间必须晚于开始时间','warn');paint();return;}
      periodTimeEdits[[date,currentScheduleType(),grade,period].join('|')]={start,end};
    };
    root.querySelector('#aprd-start')?.addEventListener('change',rememberPeriodTime);
    root.querySelector('#aprd-end')?.addEventListener('change',rememberPeriodTime);
    root.querySelector('[data-generate]').onclick=async()=>{const type=root.querySelector('#aprd-generate').value;try{await generateTable(type);}catch(e){toast(e.message||'生成失败','err');}};
    root.querySelector('[data-workspace-voice]').onclick=()=>{
      const type=TYPE[tab]?tab:root.querySelector('#aprd-generate').value;
      const selectedPeriod=period,selectedDate=date,selectedGrade=grade;
      const cols=[{key:'class',label:'上课',type:'check'},{key:'sit',label:'坐班',type:'check'},{key:'listen',label:'听课',type:'check'},{key:'research',label:'教研',type:'check'}];
      voiceSheet({rows:teachers.map(t=>({teacher:t.name,subject:t.subject})),cols,onApply:items=>{
        if(period!==selectedPeriod||date!==selectedDate||grade!==selectedGrade){toast('日期、年级或节次已切换，请重新语音登记','warn');return;}
        let count=0;
        for(const item of items){
          const matches=teachers.filter(t=>t.name===item.name&&(!item.subject||t.subject===item.subject));
          if(matches.length!==1)continue;
          const teacher=matches[0],key=item.leave?'leave':item.absent?({seat:'sit',class:'class',research:'research'}[type]):item.statusKey;
          if(!['leave','class','sit','listen','research'].includes(key))continue;
          updateTeacherGrid(getDraftRows(type),teacher,type,period,key,item.leave?(item.leaveType||'事假'):item.absent?'n':'y',{leaveRecords,date});count++;
        }
        tab=type;paint();toast('已应用 '+count+' 条语音记录'+(count<items.length?'，未匹配或同名记录请核对':''),'ok',5000);
        scheduleAutoSave(type);
      }});
    };
    const searchInput = root.querySelector('#aprd-search');
    const restoreSearchFocus = target => {
      const position = target.selectionStart ?? target.value.length;
      paint();
      const next = root.querySelector('#aprd-search');
      next?.focus();
      next?.setSelectionRange(position,position);
    };
    searchInput?.addEventListener('compositionstart',()=>{isComposingSearch=true;});
    searchInput?.addEventListener('compositionend',event=>{
      isComposingSearch=false;
      search=event.target.value;
      restoreSearchFocus(event.target);
    });
    searchInput?.addEventListener('input',event=>{
      if(isComposingSearch || event.isComposing) return;
      search=event.target.value;
      restoreSearchFocus(event.target);
    });
    root.querySelector('#aprd-subject')?.addEventListener('change',e=>{subject=e.target.value;paint();});
    root.querySelectorAll('[data-grid-person]').forEach(control => {
      const teacher = teachers.find(item => String(item.id) === control.dataset.gridPerson);
      if (!teacher || !TYPE[tab]) return;
      const key = control.dataset.gridKey;
      const update = value => updateTeacherGrid(getDraftRows(tab),teacher,tab,period,key,value,{leaveRecords,date});
      if (['class','sit','listen','research'].includes(key)) control.onclick = () => {
        const state = deriveTableGridState(teacher,tab,getDraftRows(tab),{leaveRecords,date,period});
        update(nextTriState(state[key])); paint(); scheduleAutoSave(tab);
      };
      else control.addEventListener(key === 'remark' ? 'input' : 'change',() => {update(control.value);scheduleAutoSave(tab);});
    });
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
      const teacherGrade=String(values.grade||'').trim();
      if(!teacherGrade||teacherGrade.length>12){toast('请填写1至12字的归属年级','warn');return;}
      if(!name){toast('请填写教师姓名','warn');form.querySelector('[name="name"]')?.focus();return;}
      if(!subjectName){toast('请填写教师学科','warn');form.querySelector('[name="subject"]')?.focus();return;}
      submit.disabled=true;
      submit.textContent='保存中…';
      try{
        if(!grades.includes(teacherGrade))await api.post('/grades',{name:teacherGrade});
        await api.post('/teachers',{grade:teacherGrade,name,subject:subjectName});
        grade=teacherGrade;
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
    root.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>{
      const t=teachers.find(x=>String(x.id)===b.dataset.edit);
      openEditor('编辑教师',[{key:'name',label:'姓名',required:true},{key:'subject',label:'学科',required:true},{key:'grade',label:'归属年级',type:'combo',required:true,options:grades.map(value=>({value,label:value}))},{key:'department',label:'归属部门'},{key:'remark',label:'备注'}],{name:t.name,subject:t.subject,grade:t.grade||grade,department:deptOf(t),remark:noteOf(t)},async d=>{
        const target=String(d.grade||'').trim();if(!target||target.length>12)throw new Error('归属年级必须为1至12字');
        await api.patch('/teachers/'+t.id,{name:d.name,subject:d.subject,grade:target});
        if(!grades.includes(target))await api.post('/grades',{name:target});
        await setTeacherMeta(t,{department:d.department,remark:d.remark});grade=target;await load();
      });
    });
    root.querySelectorAll('[data-disable]').forEach(b=>b.onclick=async()=>{if(await confirmDialog('删除该教师？历史考勤记录将保留，教师可从回收站恢复。')){try{await api.del('/teachers/'+b.dataset.disable);await load();}catch(error){toast(error.message||'删除失败','err');}}});
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
        class_name:String(data.class_name||'').trim(),period:Number(data.period??period),status:data.status||'u',
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
    root.querySelector('[data-save-class]')?.addEventListener('click',async()=>{try{await persistDraft('class');toast('上课表修改已保存','ok');}catch(error){toast(attendanceErrorText(error),'err');}});


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
        class_name:String(data.class_name||'').trim(),period:Number(data.period??period),status:data.status||'u',
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
    root.querySelector('[data-save-class]')?.addEventListener('click',async()=>{try{await persistDraft('class');toast('上课表修改已保存','ok');}catch(error){toast(attendanceErrorText(error),'err');}});


    root.querySelectorAll('[data-seat]').forEach(el=>el.addEventListener('change',()=>{
      const teacher=teachers.find(item=>String(item.id)===String(el.dataset.seat));
      if(!teacher)return;
      const row=getDraftRows('seat').find(item=>item.teacher===teacher.name);
      if(!row)return;
      const data={...rowData(row)},periods={...(data.__periods||{})},record={...(periods[String(period)]||{})};
      record[el.dataset.k]=el.value;periods[String(period)]=record;row.data={...data,__periods:periods};
    }));
    root.querySelector('[data-save-seat]')?.addEventListener('click',async()=>{try{await persistDraft('seat');toast('坐班表修改已保存','ok');}catch(error){toast(attendanceErrorText(error),'err');}});


    root.querySelector('[data-add-research]')?.addEventListener('click',()=>{
      const subjects=teacherSubjects();
      openEditor('新增教研安排',[
        {key:'subject',label:'学科',type:'select',options:subjects.map(item=>({value:item,label:item}))},
        {key:'period_time',label:'节次/时间',required:true},
        {key:'location',label:'地点'},
        {key:'host',label:'主持人',type:'select',options:teachers.map(item=>({value:item.name,label:item.name}))},
        {key:'remark',label:'备注',type:'textarea'},
      ],{subject:subjects[0]||'',period_time:(period===0?'全天':'第'+period+'节'),location:'',host:teachers[0]?.name||'',remark:''},async data=>{
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
      ],{period_time:old.period_time||(period===0?'全天':'第'+period+'节'),location:old.location||'',host:old.host||teacher.name,remark:old.remark||''},async data=>{
        const picked=await chooseResearchAttendees(members,Array.isArray(old.attendees)?old.attendees:[]);
        if(picked===null)return;
        row.data={...rowData(row),__research:{...old,...data,subject:subjectName,expected:members.length,
          attendees:picked,absent:members.filter(name=>!picked.includes(name)),status:picked.length?'已登记':'待登记'}};
        paint();
      });
    }));
    root.querySelector('[data-save-research]')?.addEventListener('click',async()=>{try{await persistDraft('research');toast('教研表修改已保存','ok');}catch(error){toast(attendanceErrorText(error),'err');}});

    root.querySelector('[data-subject-manager]')?.addEventListener('click',()=>toast('学科管理请在名册管理入口维护','warn'));
  };
  await load();
}
