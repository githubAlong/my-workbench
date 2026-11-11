import {api,el,esc,toast,sheet,confirmDialog,ymd,saveBlob} from './core.js';
import {STUDY_STATES,STUDY_COLUMNS,studyView,studySummary,studyHours,validateStudy,studyPayload,studyCsv,parseStudyCsv,prepareStudyImport,studyText} from './study-records-domain.mjs';

function studySheet(options) {
  const previous=document.body.style.overflow;document.body.style.overflow='hidden';
  return sheet({...options,cls:'trip-simple study-simple',onClose:()=>{document.body.style.overflow=previous;options.onClose?.();}});
}
function exportPdf(values) {
  const popup=window.open('','_blank');
  if(!popup)return toast('请允许弹出窗口后重试','warn');
  popup.document.open();
  popup.document.write('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>学习记录-'+esc(values.title)+'</title><style>body{font:15px/1.9 "Microsoft YaHei",sans-serif;color:#1f2937;margin:28px}h1{font-size:22px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}@page{size:A4;margin:18mm}</style><h1>学习记录</h1><pre>'+esc(studyText(values))+'</pre></html>');
  popup.document.close();popup.focus();popup.setTimeout(()=>popup.print(),250);
}
function openEditor(row,reload) {
  const initial=row?studyView(row):{date:ymd(),title:'',goal:'',planned_duration:'',actual_duration:'',status:'todo',content:'',remark:''};
  const fields=[['date','学习日期','date','',true],['title','学习主题','text','例如：Llama本地部署学习',true],['goal','学习目标','textarea','填写本次想要达成的学习目标'],['planned_duration','计划学习时长','text','例如：2小时'],['actual_duration','实际学习时长','text','学习完成后填写，例如：90分钟'],['status','进度状态','select','',true],['content','学习笔记','textarea','记录知识点、踩坑、总结'],['remark','备注信息','textarea','其他补充说明（选填）']];
  const body=el('<form class="trip-form study-form" novalidate>'+fields.map(([key,label,type,placeholder,required])=>{
    const attrs='id="study-'+key+'" name="'+key+'" '+(required?'required ':'')+'aria-describedby="study-error-'+key+'"';
    const input=type==='textarea'?'<textarea '+attrs+' rows="'+(key==='content'?6:3)+'" placeholder="'+esc(placeholder)+'">'+esc(initial[key]||'')+'</textarea>':type==='select'?'<select '+attrs+'>'+STUDY_STATES.map(([value,label])=>'<option value="'+value+'" '+(initial.status===value?'selected':'')+'>'+label+'</option>').join('')+'</select>':'<input '+attrs+' type="'+type+'" value="'+esc(initial[key]||'')+'" placeholder="'+esc(placeholder)+'">';
    return '<div class="trip-field"><label for="study-'+key+'">'+label+(required?'<em>*</em>':'')+'</label>'+input+'<span class="trip-error" id="study-error-'+key+'"></span></div>';
  }).join('')+'</form>');
  const footer=el('<div class="trip-footer"><button type="button" data-study-cancel>取消</button><button type="button" data-study-pdf>导出PDF</button><button type="button" class="trips-primary" data-study-save>确认保存</button></div>');
  const dialog=studySheet({title:'学习详情',body,footer});
  const read=()=>Object.fromEntries(new FormData(body));
  const check=()=>{
    const errors=validateStudy(read());let first;
    for(const [key] of fields){const input=body.querySelector('#study-'+key);input.setAttribute('aria-invalid',String(!!errors[key]));body.querySelector('#study-error-'+key).textContent=errors[key]||'';if(errors[key]&&!first)first=input;}
    first?.focus();return !first;
  };
  footer.querySelector('[data-study-cancel]').onclick=dialog.close;
  footer.querySelector('[data-study-pdf]').onclick=()=>{if(check())exportPdf(studyPayload(read()));};
  let saving=false;
  const submit=async()=>{
    if(saving||!check())return;
    saving=true;const button=footer.querySelector('[data-study-save]');button.disabled=true;button.textContent='保存中…';
    try{
      const payload=studyPayload(read());
      const changes=row?Object.fromEntries(Object.entries(payload).filter(([key,value])=>initial[key]!==value)):payload;
      if(!row)await api.post('/studies',{...payload,source:'manual'});
      else if(Object.keys(changes).length)await api.patch('/studies/'+encodeURIComponent(row.id),changes);
      dialog.close();toast('学习记录已保存','ok');await reload(payload.date.slice(0,7));
    }catch(error){toast(error.message||'保存失败，请重试','err');}
    finally{saving=false;button.disabled=false;button.textContent='确认保存';}
  };
  footer.querySelector('[data-study-save]').onclick=submit;
  body.onsubmit=event=>{event.preventDefault();void submit();};
}
function openImport(reload) {
  const body=el('<div><p class="trip-import-note">支持 CSV 或 JSON 学习记录。CSV 需包含“日期”和“学习主题”列；先校验，确认后追加导入。</p><input type="file" id="study-import-file" accept=".csv,.json"><p id="study-import-status" role="status"></p></div>');
  const footer=el('<div class="trip-footer"><button type="button" data-import-cancel>取消</button><button type="button" class="trips-primary" data-import-confirm disabled>确认导入</button></div>');
  const dialog=studySheet({title:'导入学习记录',body,footer});
  const input=body.querySelector('input'),status=body.querySelector('#study-import-status'),button=footer.querySelector('[data-import-confirm]');
  let records=[],generation=0,saving=false;
  input.onchange=async()=>{
    const current=++generation;records=[];button.disabled=true;const file=input.files?.[0];if(!file){status.textContent='';return;}
    try{
      if(file.size>5*1024*1024)throw Error('请选择5MB以内的文件');
      const text=await file.text();let raw;
      if(/\.json$/i.test(file.name)){const parsed=JSON.parse(text.replace(/^\ufeff/,''));raw=Array.isArray(parsed)?parsed:parsed.records||parsed.studies;}
      else if(/\.csv$/i.test(file.name))raw=parseStudyCsv(text);
      else throw Error('请选择 CSV 或 JSON 文件');
      const next=prepareStudyImport(raw);if(current!==generation)return;
      records=next;status.textContent='已校验 '+records.length+' 条学习记录，确认后追加导入。';button.disabled=false;
    }catch(error){if(current===generation)status.textContent=error.message||'文件格式不正确';}
  };
  footer.querySelector('[data-import-cancel]').onclick=dialog.close;
  button.onclick=async()=>{
    if(saving||!records.length)return;saving=true;button.disabled=true;input.disabled=true;
    try{const result=await api.post('/study/records/import',{rows:records});dialog.close();toast('已导入 '+result.imported+' 条学习记录','ok');await reload(records[0].date.slice(0,7));}
    catch(error){status.textContent=error.message||'导入失败，请重试';}
    finally{saving=false;button.disabled=false;input.disabled=false;}
  };
}
export async function renderStudyRecords(root) {
  let month=ymd().slice(0,7),all=[],generation=0;
  async function load(targetMonth) {
    if(targetMonth)month=targetMonth;
    const current=++generation;
    try{
      const result=await api.get('/studies');if(current!==generation||!root.isConnected)return;
      all=result.filter(row=>!row.deleted_at&&row.source!=='running').map(studyView);paint();
    }catch(error){if(current!==generation||!root.isConnected)return;root.innerHTML='<div class="card empty">'+esc(error.message||'学习记录加载失败')+'<br><button id="study-retry" class="btn ghost">重新加载</button></div>';root.querySelector('button').onclick=()=>load();}
  }
  function paint() {
    const rows=all.filter(row=>String(row.date||'').startsWith(month)).sort((a,b)=>String(b.date).localeCompare(String(a.date))||Number(b.id)-Number(a.id));
    const summary=studySummary(all),stats=[['总学习条目',summary.count,'条'],['进行中',summary.doing,'条'],['已完成',summary.done,'条'],['累计学习时长',studyHours(summary.minutes),'小时']];
    root.innerHTML='<section class="trips-page study-records-page"><h1>学习记录</h1><p class="trips-subtitle">记录个人学习目标、学习进度和学习笔记</p><div class="trips-stats">'+stats.map(([label,value,unit],index)=>'<div class="trips-stat"><span>'+label+'</span><b data-study-stat="'+index+'" class="'+(index===2?'trips-green':'')+'">'+esc(value)+'</b><small>'+unit+'</small></div>').join('')+'</div><div class="trips-toolbar"><div class="trips-month"><button data-study-month="-1" aria-label="上一月">‹</button><span id="study-month-label">'+month.slice(0,4)+'年'+Number(month.slice(5))+'月</span><button data-study-month="1" aria-label="下一月">›</button><button class="trips-primary" id="study-add">＋ 新增学习记录</button></div><div class="trips-tools"><button id="study-export">↓ 导出</button><button id="study-import">↑ 导入</button></div></div><div class="trips-table-wrap"><table class="trips-table study-table"><thead><tr>'+STUDY_COLUMNS.map(label=>'<th>'+label+'</th>').join('')+'</tr></thead><tbody>'+rows.map(row=>'<tr data-study-id="'+esc(row.id)+'"><td>'+esc(row.date)+'</td><td>'+esc(row.title)+'</td><td class="study-multiline">'+esc(row.goal||'—')+'</td><td class="study-time"><span>计划：'+esc(row.planned_duration||'—')+'</span><span>实际：'+esc(row.actual_duration||'—')+'</span></td><td><span class="study-status '+row.status+'">'+STUDY_STATES.find(([value])=>value===row.status)[1]+'</span></td><td class="study-multiline">'+esc(row.content||'—')+'</td><td class="study-multiline">'+esc(row.remark||'—')+'</td><td><div class="trips-row-actions"><button data-study-edit>编辑</button><button class="trips-danger" data-study-delete>删除</button></div></td></tr>').join('')+(rows.length?'':'<tr><td colspan="8" class="trips-empty">本月暂无学习记录，点击“新增学习记录”开始记录</td></tr>')+'</tbody></table></div></section>';
    root.querySelector('#study-add').onclick=()=>openEditor(null,load);
    root.querySelectorAll('[data-study-month]').forEach(button=>{button.onclick=()=>{const date=new Date(Number(month.slice(0,4)),Number(month.slice(5))-1+Number(button.dataset.studyMonth),1);month=ymd(date).slice(0,7);paint();};});
    root.querySelector('#study-export').onclick=()=>saveBlob(new Blob([studyCsv(rows)],{type:'text/csv;charset=utf-8'}),'学习记录-'+month+'.csv');
    root.querySelector('#study-import').onclick=()=>openImport(load);
    root.querySelectorAll('[data-study-id]').forEach(element=>{
      const row=rows.find(row=>String(row.id)===element.dataset.studyId);
      element.querySelector('[data-study-edit]').onclick=()=>openEditor(row,load);
      element.querySelector('[data-study-delete]').onclick=async()=>{
        if(!await confirmDialog('确定删除“'+row.title+'”这条学习记录吗？',{title:'删除学习记录',danger:true}))return;
        try{await api.del('/studies/'+encodeURIComponent(row.id));toast('已删除','ok');await load();}catch(error){toast(error.message||'删除失败','err');}
      };
    });
  }
  await load();
}
