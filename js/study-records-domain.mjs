export const STUDY_STATES = [['todo','待开始'],['doing','进行中'],['done','已完成']];
export const STUDY_COLUMNS = ['日期','学习主题','学习目标','学习时长','进度状态','学习笔记','备注','操作'];
const labels = Object.fromEntries(STUDY_STATES);
export function durationMinutes(value) {
  const text = String(value ?? '').trim().toLowerCase().replace(/\s+/g, '');
  if (!text) return null;
  let minutes;
  if (/^\d+(?:\.\d+)?$/.test(text)) minutes = Number(text) * 60;
  else if (/^\d+:([0-5]\d)$/.test(text)) { const [h,m] = text.split(':').map(Number); minutes = h * 60 + m; }
  else {
    const match = text.match(/^(?:(\d+(?:\.\d+)?)(?:小时|时|h|hours?))?(?:(\d+(?:\.\d+)?)(?:分钟|分|m|min(?:utes?)?))?$/);
    if (!match || (!match[1] && !match[2])) throw Error('请输入有效时长，例如：2小时、90分钟或1小时30分钟');
    minutes = Number(match[1] || 0) * 60 + Number(match[2] || 0);
  }
  if (!Number.isFinite(minutes)) throw Error('学习时长超出有效范围');
  return Math.round(minutes * 100) / 100;
}
export const studyHours = minutes => Number((Number(minutes || 0) / 60).toFixed(2)).toLocaleString('zh-CN', {maximumFractionDigits:2});
export function studyView(row) {
  return {...row, goal:row.goal || '', planned_duration:row.planned_duration || '',
    actual_duration:row.actual_duration ?? (row.minutes == null ? '' : row.minutes + '分钟'),
    status:labels[row.status] ? row.status : row.source === 'running' ? 'doing' : 'done', content:row.content || '', remark:row.remark || ''};
}
export function validateStudy(values) {
  const errors = {}, date = String(values.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date+'T00:00:00Z')) || new Date(date+'T00:00:00Z').toISOString().slice(0,10)!==date) errors.date = '请选择有效的学习日期';
  if (!String(values.title || '').trim()) errors.title = '请填写学习主题';
  if (!labels[values.status]) errors.status = '请选择进度状态';
  for (const field of ['planned_duration','actual_duration']) { try { durationMinutes(values[field]); } catch (error) { errors[field] = error.message; } }
  return errors;
}
export function studyPayload(values) {
  const errors = validateStudy(values);
  if (Object.keys(errors).length) throw Error(Object.values(errors)[0]);
  return Object.fromEntries(['date','title','goal','planned_duration','actual_duration','status','content','remark'].map(key=>[key,['goal','content','remark'].includes(key)?String(values[key] ?? ''):String(values[key] ?? '').trim()]).concat([['minutes', durationMinutes(values.actual_duration) ?? 0]]));
}
export function studySummary(rows) {
  const visible = rows.filter(row=>!row.deleted_at && row.source !== 'running').map(studyView);
  return {count:visible.length, doing:visible.filter(row=>row.status==='doing').length, done:visible.filter(row=>row.status==='done').length,
    minutes:visible.reduce((total,row)=>total+(durationMinutes(row.actual_duration) ?? 0),0)};
}
const csvFields = ['date','title','goal','planned_duration','actual_duration','status','content','remark'];
export const STUDY_CSV_HEADERS = ['日期','学习主题','学习目标','计划学习时长','实际学习时长','进度状态','学习笔记','备注'];
const safeCell = value => { const text=String(value ?? ''); return /^[\s]*[=+@-]/.test(text) ? "'"+text : text; };
export function studyCsv(rows) {
  const grid = [STUDY_CSV_HEADERS,...rows.map(studyView).map(row=>csvFields.map(key=>key==='status'?labels[row.status]:safeCell(row[key])))];
  return '\ufeff'+grid.map(row=>row.map(value=>'"'+String(value ?? '').replace(/"/g,'""')+'"').join(',')).join('\r\n');
}
export function parseStudyCsv(text) {
  const rows=[];let row=[],value='',quoted=false;
  const source=String(text).replace(/^\ufeff/,'');
  for(let i=0;i<source.length;i++) { const char=source[i];
    if(char==='"') { if(quoted && source[i+1]==='"'){value+='"';i++;}else quoted=!quoted; }
    else if(char===','&&!quoted){row.push(value);value='';}
    else if((char==='\n'||char==='\r')&&!quoted){if(char==='\r'&&source[i+1]==='\n')i++;row.push(value);if(row.some(cell=>cell.trim()))rows.push(row);row=[];value='';}
    else value+=char;
  }
  if(quoted)throw Error('CSV 引号未闭合');
  if(value||row.length){row.push(value);if(row.some(cell=>cell.trim()))rows.push(row);}
  const header=(rows.shift()||[]).map(cell=>cell.trim());
  for(const name of ['日期','学习主题'])if(!header.includes(name))throw Error('CSV 缺少“'+name+'”列');
  return rows.map(cells=>Object.fromEntries(csvFields.map((key,index)=>{
    let value=cells[header.indexOf(STUDY_CSV_HEADERS[index])] ?? '';
    if(value.startsWith("'")&&/^[\s]*[=+@-]/.test(value.slice(1)))value=value.slice(1);
    return [key,value];
  })));
}
export function prepareStudyImport(rows) {
  if(!Array.isArray(rows)||!rows.length)throw Error('文件中没有可导入的学习记录');
  if(rows.length>2000)throw Error('每次最多导入2000条记录');
  return rows.map((row,index)=>{
    if(!row || typeof row!=='object')throw Error('第'+(index+1)+'条记录格式不正确');
    const values=Object.fromEntries(csvFields.map((key,i)=>[key,row[key] ?? row[STUDY_CSV_HEADERS[i]] ?? '']));
    values.status=STUDY_STATES.find(([value,label])=>value===values.status||label===values.status)?.[0] || (values.status ? values.status : 'todo');
    if(!values.actual_duration && row.minutes!=null)values.actual_duration=row.minutes+'分钟';
    try{return studyPayload(values);}catch(error){throw Error('第'+(index+1)+'条：'+error.message);}
  });
}
export function studyText(row) {
  const value=studyView(row);
  return ['学习日期：'+(value.date||''),'学习主题：'+(value.title||''),'学习目标：'+value.goal,'计划学习时长：'+value.planned_duration,'实际学习时长：'+value.actual_duration,'进度状态：'+labels[value.status],'学习笔记：\n'+value.content,'备注信息：\n'+value.remark].join('\n\n');
}
