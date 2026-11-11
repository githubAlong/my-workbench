export const TRIP_COLUMNS = ['日期','出发地','目的地','出差事由','出差人员','是否开车','开车人','公里数','里程费','合计金额','备注','操作'];
export const tripMoney = value => Number(value || 0).toLocaleString('zh-CN',{maximumFractionDigits:2});
export function tripDriving(row) {
  if (row.is_driving != null) return row.is_driving === true || row.is_driving === 1 || row.is_driving === '1';
  return Number(row.km) > 0 || !!String(row.driver || '').trim();
}
export function tripView(row) {
  const driving = tripDriving(row);
  const km = driving ? Math.max(0,Number(row.km) || 0) : 0;
  // Never turn historical formula-based reimbursement into a user-entered amount.
  const total = row.total_amount == null || row.total_amount === '' ? null : Number(row.total_amount);
  return {...row, driving, km, mileageFee:Math.round(km * 100)/100, total};
}
export function tripMonthRows(rows,month) {
  return rows.filter(row=>!row.deleted_at && String(row.start_date || '').startsWith(month))
    .sort((a,b)=>String(b.start_date).localeCompare(String(a.start_date)) || Number(b.id)-Number(a.id));
}
export function tripSummary(rows) {
  const views=rows.map(tripView);
  const sum=key=>Math.round(views.reduce((total,row)=>total+(Number(row[key])||0),0)*100)/100;
  return {count:rows.length,km:sum('km'),mileageFee:sum('mileageFee'),total:sum('total')};
}
export function validateTrip(values) {
  const errors={};
  const date=String(values.start_date||'');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date+'T00:00:00Z')) || new Date(date+'T00:00:00Z').toISOString().slice(0,10)!==date) errors.start_date='请选择有效的出差日期';
  if (!String(values.to_place||'').trim()) errors.to_place='请填写出差目的地';
  if (!String(values.reason||'').trim()) errors.reason='请填写出差事由';
  if (!['0','1'].includes(String(values.is_driving))) errors.is_driving='请选择是否开车';
  if (String(values.is_driving)==='1') {
    if (!String(values.driver||'').trim()) errors.driver='请填写驾驶员姓名';
    if (String(values.km??'').trim()==='' || !/^\d+(?:\.\d+)?$/.test(String(values.km)) || !Number.isFinite(Number(values.km))) errors.km='请输入非负公里数';
  }
  if (values.total_amount != null && String(values.total_amount).trim()!=='' && (!/^\d+(?:\.\d{1,2})?$/.test(String(values.total_amount)) || !Number.isFinite(Number(values.total_amount)))) errors.total_amount='请输入非负金额，最多两位小数';
  return errors;
}
export function tripPayload(values) {
  const driving=String(values.is_driving)==='1';
  return {start_date:values.start_date,from_place:String(values.from_place||'').trim(),to_place:String(values.to_place||'').trim(),reason:String(values.reason||'').trim(),companions:String(values.companions||'').trim(),is_driving:driving?1:0,driver:driving?String(values.driver||'').trim():'',km:driving?Number(values.km):0,km_rate:1,total_amount:values.total_amount==null||String(values.total_amount).trim()===''?null:Number(values.total_amount),remark:String(values.remark||'').trim()};
}
export function tripText(row) {
  const v=tripView(row);
  return ['出差记录','日期：'+v.start_date,'出发地：'+(v.from_place||'—'),'目的地：'+(v.to_place||'—'),'出差事由：'+(v.reason||'—'),'出差人员：'+(v.companions||'—'),'是否开车：'+(v.driving?'是':'否'),'开车人：'+(v.driving?v.driver||'—':'—'),'公里数：'+tripMoney(v.km)+' km','里程费（单独统计）：¥'+tripMoney(v.mileageFee),'合计金额（不含里程费）：'+(v.total==null?'未填写':'¥'+tripMoney(v.total)),'备注：'+(v.remark||'无')].join('\n');
}
export function tripCsv(rows) {
  const cell=v=>{const text=String(v??'');return '"'+(/^[=+@\t\r-]/.test(text)?"'":'')+text.replace(/"/g,'""')+'"';};
  return '\uFEFF'+[TRIP_COLUMNS.slice(0,-1),...rows.map(row=>{const v=tripView(row);return [v.start_date,v.from_place,v.to_place,v.reason,v.companions,v.driving?'是':'否',v.driving?v.driver:'—',v.km,v.mileageFee,v.total??'',v.remark||'无'];})].map(row=>row.map(cell).join(',')).join('\r\n');
}
export function parseTripCsv(text) {
  const rows=[];let row=[],value='',quoted=false;
  for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"'){value+='"';i++;}else quoted=!quoted;}else if(c===','&&!quoted){row.push(value);value='';}else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&text[i+1]==='\n')i++;row.push(value);if(row.some(v=>v.trim()))rows.push(row);row=[];value='';}else value+=c;}
  if(quoted)throw Error('CSV 引号未闭合');if(value||row.length){row.push(value);rows.push(row);}
  const header=rows.shift()?.map(v=>v.replace(/^\uFEFF/,'').trim())||[];
  for(const name of ['日期','目的地','出差事由'])if(!header.includes(name))throw Error('CSV 缺少“'+name+'”列');
  return rows.map(cells=>{const get=name=>cells[header.indexOf(name)]?.trim()||'';const driving=get('是否开车');if(driving&&!['是','否','0','1'].includes(driving))throw Error('是否开车只能为“是”或“否”');return {start_date:get('日期'),from_place:get('出发地'),to_place:get('目的地'),reason:get('出差事由'),companions:get('出差人员'),is_driving:['是','1'].includes(driving)?'1':'0',driver:get('开车人'),km:get('公里数').replace(/\s*km$/i,''),total_amount:get('合计金额').replace(/^[¥￥]/,''),remark:get('备注')==='无'?'':get('备注')};});
}
