import {api,el,esc,toast,sheet,confirmDialog,ymd,saveBlob} from './core.js';
import {TRIP_COLUMNS,tripMoney,tripView,tripMonthRows,tripSummary,validateTrip,tripPayload,tripText,tripCsv,parseTripCsv} from './trips-domain.mjs';

const fieldLabels={start_date:'出差日期',from_place:'出发地',to_place:'出差目的地',reason:'出差事由',companions:'出差人员',is_driving:'是否开车',driver:'开车人',km:'出差公里数',total_amount:'合计金额',remark:'备注信息'};
function tripSheet(options){
  const previous=document.body.style.overflow;
  document.body.style.overflow='hidden';
  return sheet({...options,cls:'trip-simple',onClose:()=>{document.body.style.overflow=previous;options.onClose?.();}});
}
function printTrip(row){
  const popup=window.open('','_blank');
  if(!popup){toast('请允许弹出窗口后重试','warn');return;}
  popup.document.open();
  popup.document.write('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>出差记录</title><style>body{font:15px/1.9 "Microsoft YaHei",sans-serif;margin:28px;color:#1f2937}h1{font-size:22px}pre{white-space:pre-wrap;font:inherit;overflow-wrap:anywhere}@page{size:A4;margin:18mm}</style><h1>出差记录</h1><pre>'+esc(tripText(row))+'</pre></html>');
  popup.document.close();popup.focus();popup.setTimeout(()=>popup.print(),250);
}
function openTripEditor(row,reload){
  const view=tripView(row||{}),isNew=!row;
  const initial={start_date:row?.start_date||ymd(new Date()),from_place:row?.from_place||'',to_place:row?.to_place||'',reason:row?.reason||'',companions:row?.companions||'',is_driving:view.driving?'1':'0',driver:row?.driver||'',km:view.driving?String(view.km):'',total_amount:view.total==null?'':String(view.total),remark:row?.remark||''};
  const field=(key,type='text',placeholder='',required=false)=>'<div class="trip-field"><label for="trip-'+key+'">'+fieldLabels[key]+(required?'<em>*</em>':'')+'</label><input id="trip-'+key+'" name="'+key+'" type="'+type+'" value="'+esc(initial[key])+'" placeholder="'+esc(placeholder)+'" '+(required?'required ':'')+(type==='number'?'min="0" step="'+(key==='km'?'any':'0.01')+'" ':'')+'aria-describedby="trip-error-'+key+'"><span class="trip-error" id="trip-error-'+key+'"></span></div>';
  const body=el('<form class="trip-form" novalidate>'+field('start_date','date','',true)+field('from_place','text','例如：学校')+field('to_place','text','例如：咸丰教育局',true)+field('reason','text','例如：送高考资料、开会',true)+field('companions','text','多人用顿号隔开')+'<div class="trip-field"><label for="trip-is_driving">是否开车<em>*</em></label><select id="trip-is_driving" name="is_driving" required aria-describedby="trip-error-is_driving"><option value="0">否</option><option value="1">是</option></select><span class="trip-error" id="trip-error-is_driving"></span></div><div class="trip-drive-group" id="trip-drive-group">'+field('driver','text','填写驾驶员姓名',true)+field('km','number','输入里程，自动计算里程费',true)+'<div class="trip-field"><small>里程单价：1元/km，里程费单独统计</small><small id="trip-mileage-preview"></small></div></div>'+field('total_amount','number','由用户自行填写')+'<div class="trip-field"><label for="trip-remark">备注信息</label><textarea id="trip-remark" name="remark" rows="4" placeholder="其他补充说明">'+esc(initial.remark)+'</textarea></div></form>');
  const footer=el('<div class="trip-footer"><button type="button" data-trip-cancel>取消</button><button type="button" data-trip-pdf>导出PDF</button><button type="button" class="trips-primary" data-trip-submit>确认提交</button></div>');
  const dialog=tripSheet({title:'出差详情',body,footer});
  const $=key=>body.querySelector('#trip-'+key);
  $('is_driving').value=initial.is_driving;
  const read=()=>Object.fromEntries(new FormData(body));
  const showErrors=()=>{
    const errors=validateTrip(read());let first;
    for(const key of Object.keys(fieldLabels)){
      const input=$(key),error=body.querySelector('#trip-error-'+key);
      if(error)error.textContent=errors[key]||'';
      input?.setAttribute('aria-invalid',String(!!errors[key]));
      if(errors[key]&&!first)first=input;
    }
    first?.focus();return !first;
  };
  const updateDriving=(clear=false)=>{
    const driving=$('is_driving').value==='1';
    body.querySelector('#trip-drive-group').hidden=!driving;
    for(const key of ['driver','km']){$(key).required=driving;if(!driving&&clear)$(key).value='';if(!driving){body.querySelector('#trip-error-'+key).textContent='';$(key).removeAttribute('aria-invalid');}}
    body.querySelector('#trip-mileage-preview').textContent='里程费：¥'+tripMoney(Number($('km').value)||0);
  };
  $('is_driving').onchange=()=>updateDriving(true);$('km').oninput=()=>updateDriving();updateDriving();
  footer.querySelector('[data-trip-cancel]').onclick=dialog.close;
  footer.querySelector('[data-trip-pdf]').onclick=()=>{if(showErrors())printTrip(tripPayload(read()));};
  let saving=false;
  const submit=async()=>{
    if(saving||!showErrors())return;
    saving=true;const button=footer.querySelector('[data-trip-submit]');button.disabled=true;button.textContent='提交中…';
    try{
      const payload=tripPayload(read());
      const saved=isNew?await api.post('/trips',payload):await api.patch('/trips/'+encodeURIComponent(row.id),payload);
      dialog.close();toast('已保存','ok');await reload(String(saved?.start_date||payload.start_date).slice(0,7));
    }catch(error){toast(error.message||'提交失败，请重试','err');}
    finally{saving=false;button.disabled=false;button.textContent='确认提交';}
  };
  footer.querySelector('[data-trip-submit]').onclick=submit;
  body.onsubmit=event=>{event.preventDefault();void submit();};
}
async function showTripDetails(row){
  try{
    const [detail,files]=await Promise.all([api.get('/trip/'+encodeURIComponent(row.id)),api.get('/attachments',{owner_type:'trip',owner_id:row.id})]);
    const body=el('<div class="trip-details"><div>'+esc(tripText(row)).replace(/\n/g,'<br>')+'</div><h3>费用明细</h3><div>'+(detail.items?.map(item=>esc([item.date,item.note||item.kind,'¥'+tripMoney(item.amount),item.has_invoice?'有发票':'无发票'].filter(Boolean).join(' · '))).join('<br>')||'暂无费用明细')+'</div><h3>发票信息</h3><div id="trip-invoices"></div></div>');
    const list=body.querySelector('#trip-invoices');
    if(!files.length)list.textContent='暂无发票信息';
    for(const file of files){const button=document.createElement('button');button.type='button';button.textContent=file.name||'查看发票';button.onclick=async()=>{try{const data=await api.get('/attachments/'+encodeURIComponent(file.id)+'/file');const url=String(data?.url||'');if(!/^(data:(?:image\/|application\/pdf|application\/octet-stream)|blob:|https:\/\/)/i.test(url))throw Error('附件地址不可用');const a=document.createElement('a');a.href=url;a.download=file.name||'发票';a.click();}catch(error){toast(error.message,'err');}};list.append(button);}
    tripSheet({title:'出差明细',body});
  }catch(error){toast(error.message||'明细读取失败','err');}
}
async function copyTrip(row){
  const text=tripText(row);
  try{await navigator.clipboard.writeText(text);toast('已复制','ok');}
  catch{const body=el('<textarea class="input trip-copy-text" readonly aria-label="出差记录文本"></textarea>');body.value=text;tripSheet({title:'复制出差记录',body});body.select();}
}
function openTripImport(reload){
  const body=el('<div><p class="trip-import-note">支持导出的 CSV 文件或 JSON 数组。文件会先校验，确认导入后才新增记录。</p><input type="file" id="trip-import-file" accept=".csv,.json"><p id="trip-import-status" role="status"></p></div>');
  const footer=el('<div class="trip-footer"><button type="button" data-cancel>取消</button><button type="button" class="trips-primary" data-confirm disabled>确认导入</button></div>');
  const dialog=tripSheet({title:'导入出差记录',body,footer});let prepared=[];
  const status=body.querySelector('#trip-import-status'),confirm=footer.querySelector('[data-confirm]');
  body.querySelector('input').onchange=async event=>{
    const file=event.target.files[0];prepared=[];confirm.disabled=true;if(!file)return;
    try{
      if(file.size>5*1024*1024)throw Error('文件不能超过 5MB');const text=await file.text();
      const rows=file.name.toLowerCase().endsWith('.json')?JSON.parse(text):parseTripCsv(text);
      if(!Array.isArray(rows)||!rows.length)throw Error('文件中没有记录');
      if(rows.length>1000)throw Error('每次最多导入 1000 条记录');
      const normalized=rows.map(row=>({...row,is_driving:row.is_driving==null?(tripView(row).driving?'1':'0'):String(row.is_driving)}));
      for(const [index,row]of normalized.entries()){const errors=validateTrip(row);if(Object.keys(errors).length)throw Error('第 '+(index+1)+' 条：'+Object.values(errors).join('；'));}
      prepared=normalized.map(tripPayload);status.textContent='已校验 '+prepared.length+' 条记录，确认后新增到相应日期月份。';confirm.disabled=false;
    }catch(error){status.textContent=error.message;}
  };
  footer.querySelector('[data-cancel]').onclick=dialog.close;
  confirm.onclick=async()=>{if(!prepared.length||confirm.disabled)return;confirm.disabled=true;try{await api.post('/trips/bulk',{rows:prepared});dialog.close();toast('已导入 '+prepared.length+' 条','ok');await reload();}catch(error){status.textContent=error.message;confirm.disabled=false;}};
}
export async function renderTripManagement(root){
  let month=ymd(new Date()).slice(0,7),allRows=[],loading=0;
  const load=async target=>{
    if(/^\d{4}-\d{2}$/.test(String(target||'')))month=target;
    const seq=++loading;
    try{const rows=await api.get('/trips');if(seq!==loading)return;if(!Array.isArray(rows))throw Error('出差记录格式异常');allRows=rows;paint();}
    catch(error){if(seq!==loading)return;root.innerHTML='<div class="trips-page"><p>'+esc(error.message||'加载失败')+'</p><button id="trips-retry">重试</button></div>';root.querySelector('button').onclick=()=>load();}
  };
  const paint=()=>{
    const rows=tripMonthRows(allRows,month),stats=tripSummary(rows),labels=[['本月出差',stats.count,'次'],['累计行驶里程',stats.km,'km'],['车辆里程费用 (单独统计)',stats.mileageFee,'元'],['报销金额 (不含里程费)',stats.total,'元']];
    root.innerHTML='<section class="trips-page"><h1>出差</h1><p class="trips-subtitle">行程、报销记录</p><div class="trips-stats">'+labels.map(([label,value,unit],i)=>'<div class="trips-stat"><span>'+label+'</span><b class="'+(i===2?'trips-green':'')+'">'+tripMoney(value)+'</b><small>'+unit+'</small></div>').join('')+'</div><div class="trips-toolbar"><div class="trips-month"><button data-month="-1" aria-label="上一月">‹</button><span id="trips-month-label">'+month.slice(0,4)+'年'+Number(month.slice(5))+'月</span><button data-month="1" aria-label="下一月">›</button><button class="trips-primary" id="trips-add">＋ 记录出差</button></div><div class="trips-tools"><button id="trips-export">↓ 导出</button><button id="trips-import">↑ 导入</button></div></div><div class="trips-table-wrap"><table class="trips-table"><thead><tr>'+TRIP_COLUMNS.map(label=>'<th>'+label+'</th>').join('')+'</tr></thead><tbody>'+rows.map(row=>{const v=tripView(row);return '<tr data-trip-id="'+esc(row.id)+'">'+[v.start_date,v.from_place||'—',v.to_place,v.reason||'—',v.companions||'—',v.driving?'是':'否',v.driving?v.driver||'—':'—',tripMoney(v.km)+' km'].map(value=>'<td>'+esc(value)+'</td>').join('')+'<td class="trips-green">¥'+tripMoney(v.mileageFee)+'</td><td>'+(v.total==null?'—':'¥'+tripMoney(v.total))+'</td><td>'+esc(v.remark||'无')+'</td><td><div class="trips-row-actions"><button data-action="detail">明细</button><button data-action="copy">复制</button><button data-action="edit">编辑</button><button class="trips-danger" data-action="delete">删除</button></div></td></tr>';}).join('')+(rows.length?'':'<tr><td colspan="12" class="trips-empty">本月暂无出差记录</td></tr>')+'</tbody></table></div></section>';
    root.querySelectorAll('[data-month]').forEach(button=>button.onclick=()=>{const d=new Date(month+'-01T12:00:00');d.setMonth(d.getMonth()+Number(button.dataset.month));month=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0');paint();});
    root.querySelector('#trips-add').onclick=()=>openTripEditor(null,load);
    root.querySelector('#trips-export').onclick=()=>saveBlob(new Blob([tripCsv(rows)],{type:'text/csv;charset=utf-8'}),'出差记录-'+month+'.csv');
    root.querySelector('#trips-import').onclick=()=>openTripImport(load);
    root.querySelectorAll('[data-action]').forEach(button=>button.onclick=async()=>{
      const row=rows.find(row=>String(row.id)===button.closest('tr').dataset.tripId);if(!row)return;
      if(button.dataset.action==='edit')return openTripEditor(row,load);
      if(button.dataset.action==='detail')return showTripDetails(row);
      if(button.dataset.action==='copy')return copyTrip(row);
      if(button.dataset.action==='delete'&&await confirmDialog('确定删除这条去“'+row.to_place+'”的出差记录？',{danger:true,okText:'删除'})){try{await api.del('/trips/'+encodeURIComponent(row.id));toast('已删除');await load();}catch(error){toast(error.message,'err');}}
    });
  };
  await load();
}
