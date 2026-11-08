import { api, esc, el, sheet, saving, confirmDialog, toast, download } from './core.js';

const TYPES = [
  ['normal', '正常上课'],
  ['i_substitute', '我代别人上课'],
  ['substituted_for_me', '别人代我上课'],
  ['swap', '换课'],
];
const TYPE_LABEL = Object.fromEntries(TYPES);
const money = (v) => v === '' || v == null ? '—' : Number(v).toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const parseMonth = (value) => {
  const m = String(value || '').match(/(20\d{2})[-/.年](\d{1,2})(?:[-/.月]|日)?/);
  if (!m) return '';
  const month = Number(m[2]);
  return month >= 1 && month <= 12 ? m[1] + '-' + String(month).padStart(2, '0') : '';
};
const escapeCsv = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';

export async function renderClassRecords(root) {
  let rows = [];
  let chartType = null;
  let chartSubject = null;
  let ChartCtor = null;
  const chartColors = ['#8b5cf6','#60a5fa','#34d399','#f59e0b','#f472b6','#22c55e','#06b6d4','#a78bfa','#fb7185'];

  root.innerHTML = `
    <section class="cr-page">
      <style>
        .cr-page{display:flex;flex-direction:column;gap:16px;min-width:0}
        .cr-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
        .cr-actions{display:flex;gap:8px;flex-wrap:wrap}
        .cr-chart-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
        .cr-card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px;min-width:0;box-shadow:var(--shadow-s)}
        .cr-card h3{font-size:14px;font-weight:650;margin:0 0 12px;color:var(--text)}
        .cr-chart{height:250px;position:relative}
        .cr-table-wrap{overflow:auto;width:100%}
        .cr-table{width:100%;border-collapse:collapse;min-width:900px}
        .cr-table th,.cr-table td{padding:11px 12px;border-bottom:1px solid var(--line);text-align:left;font-size:13px;white-space:nowrap}
        .cr-table th{background:var(--surface-2);color:var(--text-2);font-weight:600}
        .cr-table td{color:var(--text)}
        .cr-table .cr-empty{text-align:center;padding:34px;color:var(--text-3)}
        .cr-status{display:inline-flex;padding:3px 8px;border-radius:99px;background:var(--surface-2);font-size:12px}
        .cr-status.paid{color:var(--green);background:color-mix(in srgb,var(--green) 10%,transparent)}
        .cr-status.unpaid{color:var(--amber);background:color-mix(in srgb,var(--amber) 10%,transparent)}
        .cr-row-actions{display:flex;gap:6px}
        .cr-row-actions button{border:0;background:none;color:var(--primary);cursor:pointer;font:inherit}
        .cr-form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
        .cr-field{min-width:0}.cr-field label{display:block;font-size:13px;color:var(--text-2);margin-bottom:6px}
        .cr-field input,.cr-field select,.cr-field textarea{width:100%;min-height:40px;border:1px solid var(--line);border-radius:9px;padding:9px 11px;background:var(--card);color:var(--text);font:inherit}
        .cr-field textarea{min-height:96px;resize:vertical}.cr-required{color:var(--red)}
        .cr-hidden{display:none!important}
        .cr-form-foot{display:flex;justify-content:space-between;gap:8px;margin-top:18px;align-items:center}
        .cr-btn{border:1px solid var(--line);border-radius:9px;padding:9px 14px;background:var(--card);color:var(--text);cursor:pointer}
        .cr-btn.primary{background:var(--primary);border-color:var(--primary);color:white}
        .cr-btn:disabled{opacity:.55;cursor:not-allowed}
        .cr-muted{color:var(--text-3);font-size:12px}
        @media(max-width:760px){.cr-chart-grid{grid-template-columns:1fr}.cr-chart{height:230px}.cr-form-grid{grid-template-columns:1fr}.cr-toolbar{align-items:flex-start}.cr-actions{width:100%}.cr-actions .cr-btn{flex:1}}
        @media print{body *{visibility:hidden!important}#cr-print-root,#cr-print-root *{visibility:visible!important}#cr-print-root{position:absolute;inset:0;width:100%;padding:24px;background:#fff;color:#111}}
      </style>
      <div class="cr-toolbar">
        <div><div class="page-title">上课</div><div class="page-sub">登记正常上课、代课与换课记录</div></div>
        <div class="cr-actions">
          <button class="cr-btn" id="cr-export">导出本月统计</button>
          <button class="cr-btn primary" id="cr-add">＋ 新增上课记录</button>
        </div>
      </div>
      <div class="cr-chart-grid">
        <section class="cr-card"><h3>上课类型分布统计</h3><div class="cr-chart"><canvas id="cr-type-chart"></canvas></div></section>
        <section class="cr-card"><h3>学科分布统计</h3><div class="cr-chart"><canvas id="cr-subject-chart"></canvas></div></section>
      </div>
      <section class="cr-card">
        <div class="cr-table-wrap"><table class="cr-table">
          <thead><tr><th>上课类型</th><th>学科</th><th>班级</th><th>上课时间</th><th>相关人员</th><th>金额</th><th>支付状态</th><th>操作</th></tr></thead>
          <tbody id="cr-body"><tr><td colspan="8" class="cr-empty">正在加载…</td></tr></tbody>
        </table></div>
      </section>
    </section>`;

  const q = (s) => root.querySelector(s);
  const load = async () => {
    rows = await api.get('/class_records').catch((e) => { toast(e.message || '上课记录加载失败','err'); return []; });
    rows = Array.isArray(rows) ? rows : [];
    paint();
  };
  const refreshCharts = async () => {
    if (!ChartCtor) {
      if (!window.Chart) {
        await new Promise((resolve, reject) => {
          const script = document.createElement('script');
          script.src = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js';
          script.onload = resolve; script.onerror = () => reject(new Error('图表组件加载失败'));
          document.head.appendChild(script);
        }).catch(() => { toast('图表加载失败，请检查网络后刷新页面', 'warn'); return; });
      }
      ChartCtor = window.Chart;
      if (!ChartCtor) return;
    }
    const types = new Map(TYPES.map(([key,label])=>[label,0]));
    const subjects = new Map();
    rows.forEach(r=>{const label=TYPE_LABEL[r.class_type] || r.class_type || '未分类';types.set(label,(types.get(label)||0)+1);const sub=String(r.subject||'').trim();if(sub)subjects.set(sub,(subjects.get(sub)||0)+1);});
    const makeData = (map) => ({labels:[...map.keys()],datasets:[{data:[...map.values()],backgroundColor:[...map.keys()].map((_,i)=>chartColors[i%chartColors.length]),borderWidth:2,borderColor:'#ffffff'}]});
    const options = {responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'bottom',labels:{boxWidth:10,usePointStyle:true,padding:14}}}};
    if (chartType) {chartType.data=makeData(types);chartType.update();}
    else chartType=new ChartCtor(q('#cr-type-chart'),{type:'pie',data:makeData(types),options});
    if (chartSubject) {chartSubject.data=makeData(subjects);chartSubject.update();}
    else chartSubject=new ChartCtor(q('#cr-subject-chart'),{type:'pie',data:makeData(subjects),options});
  };
  const paint = () => {
    const body=q('#cr-body');
    if(!rows.length){body.innerHTML='<tr><td colspan="8" class="cr-empty">暂无上课记录，点击右上角「新增上课记录」开始登记</td></tr>';refreshCharts();return;}
    body.innerHTML=rows.slice().sort((a,b)=>String(b.class_month||'').localeCompare(String(a.class_month||''))||Number(b.id)-Number(a.id)).map(r=>{
      const swap=r.class_type==='swap';
      const amount=swap?'无费用':(r.amount==null||r.amount===''?'—':money(r.amount)+' 元');
      const status=swap?'无需结算':(r.pay_status||'未支付');
      return `<tr>
        <td>${esc(TYPE_LABEL[r.class_type]||r.class_type)}</td><td>${esc(r.subject)}</td><td>${esc(r.class_name||'—')}</td>
        <td>${esc(r.class_time||'—')}</td><td>${esc(r.related_person||'—')}</td><td>${esc(amount)}</td>
        <td>${swap?'<span class="cr-status">无需结算</span>':`<span class="cr-status ${status==='已支付'?'paid':'unpaid'}">${esc(status)}</span>`}</td>
        <td><div class="cr-row-actions"><button data-edit="${r.id}">查看/编辑</button><button data-delete="${r.id}">删除</button><button data-print="${r.id}">打印</button></div></td>
      </tr>`;
    }).join('');
    body.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>openEditor(rows.find(r=>String(r.id)===b.dataset.edit)));
    body.querySelectorAll('[data-delete]').forEach(b=>b.onclick=()=>removeRow(b.dataset.delete));
    body.querySelectorAll('[data-print]').forEach(b=>b.onclick=()=>printRow(rows.find(r=>String(r.id)===b.dataset.print)));
    refreshCharts();
  };
  const openEditor = (row=null) => {
    const editing=!!row;
    const initialType=row?.class_type||'normal';
    const form=el(`<div class="sheet-body">
      <div class="cr-form-grid">
        <div class="cr-field"><label>上课类型 <span class="cr-required">*</span></label><select id="cr-type">${TYPES.map(([v,t])=>`<option value="${v}" ${initialType===v?'selected':''}>${t}</option>`).join('')}</select></div>
        <div class="cr-field"><label>学科 <span class="cr-required">*</span></label><input id="cr-subject" value="${esc(row?.subject||'')}" placeholder="例如：信息技术、语文"></div>
        <div class="cr-field"><label>班级</label><input id="cr-class" value="${esc(row?.class_name||'')}"></div>
        <div class="cr-field"><label>上课时间</label><input id="cr-time" value="${esc(row?.class_time||'')}" placeholder="例如：2026-11-09 第2节"></div>
        <div class="cr-field"><label>相关人员（代课/换课对象）</label><input id="cr-person" value="${esc(row?.related_person||'')}"></div>
        <div class="cr-field" id="cr-money-wrap"><label>课时费（元）</label><input id="cr-money" type="number" min="0" step="0.01" value="${row?.amount??(initialType==='normal'?'30':'')}" placeholder="请输入金额"></div>
        <div class="cr-field" id="cr-paytime-wrap"><label>支付时间</label><input id="cr-paytime" value="${esc(row?.pay_time||'')}" placeholder="手动输入"></div>
        <div class="cr-field" id="cr-status-wrap"><label>支付状态</label><select id="cr-status"><option value="未支付">未支付</option><option value="已支付">已支付</option></select></div>
      </div>
      <div class="cr-field" style="margin-top:14px"><label>备注说明</label><textarea id="cr-remark" placeholder="换课说明、特殊情况备注等">${esc(row?.remark||'')}</textarea></div>
      <div class="cr-form-foot"><button class="cr-btn" id="cr-print-current" type="button">打印本条记录</button><button class="cr-btn primary" id="cr-save" type="button">${editing?'保存修改':'保存记录'}</button></div>
    </div>`);
    const sh=sheet({title:editing?'编辑上课记录':'新增上课记录',body:form,wide:true});
    const type=form.querySelector('#cr-type'), moneyInput=form.querySelector('#cr-money');
    form.querySelector('#cr-status').value=row?.pay_status||'未支付';
    let changedType=false;
    type.onchange=()=>{changedType=true;toggle();};
    function toggle(){
      const swap=type.value==='swap';
      ['#cr-money-wrap','#cr-paytime-wrap','#cr-status-wrap'].forEach(s=>form.querySelector(s).classList.toggle('cr-hidden',swap));
      if(!editing && type.value==='normal' && !changedType && !moneyInput.value) moneyInput.value='30';
      if(!editing && changedType && type.value==='normal') moneyInput.value='30';
      if(!editing && changedType && type.value!=='normal') moneyInput.value='';
    }
    toggle();
    form.querySelector('#cr-print-current').onclick=()=>printRow({...row,class_type:type.value,subject:form.querySelector('#cr-subject').value,class_name:form.querySelector('#cr-class').value,class_time:form.querySelector('#cr-time').value,related_person:form.querySelector('#cr-person').value,amount:moneyInput.value,pay_time:form.querySelector('#cr-paytime').value,pay_status:form.querySelector('#cr-status').value,remark:form.querySelector('#cr-remark').value});
    saving(form.querySelector('#cr-save'),async()=>{
      const data={
        class_type:type.value,subject:form.querySelector('#cr-subject').value.trim(),
        class_name:form.querySelector('#cr-class').value.trim()||null,class_time:form.querySelector('#cr-time').value.trim()||null,
        related_person:form.querySelector('#cr-person').value.trim()||null,
        amount:type.value==='swap'?null:(moneyInput.value===''?null:Number(moneyInput.value)),
        pay_time:type.value==='swap'?null:(form.querySelector('#cr-paytime').value.trim()||null),
        pay_status:type.value==='swap'?null:form.querySelector('#cr-status').value,
        remark:form.querySelector('#cr-remark').value.trim()||null,
        class_month:parseMonth(form.querySelector('#cr-time').value)||null,
      };
      if(!data.class_type||!data.subject)throw new Error('请填写上课类型和学科');
      if(editing)await api.patch('/class_records/'+row.id,data);else await api.post('/class_records',data);
      sh.close();toast(editing?'上课记录已更新':'上课记录已新增');await load();
    });
  };
  const removeRow=async(id)=>{
    const row=rows.find(r=>String(r.id)===String(id));if(!row)return;
    const ok=await confirmDialog(`确定删除「${row.subject} · ${row.class_name||'未填写班级'}」这条上课记录吗？`,{title:'删除上课记录',okText:'确认删除',danger:true});
    if(!ok)return;
    await api.del('/class_records/'+id);toast('已删除');await load();
  };
  const printRow=(r)=>{
    if(!r)return;
    const win=window.open('','_blank','width=800,height=700');
    if(!win)return toast('浏览器拦截了打印窗口，请允许弹出窗口','warn');
    const fields=[['上课类型',TYPE_LABEL[r.class_type]||r.class_type],['学科',r.subject],['班级',r.class_name],['上课时间',r.class_time],['相关人员',r.related_person],['金额',r.class_type==='swap'?'无费用':(r.amount==null?'—':money(r.amount)+' 元')],['支付时间',r.class_type==='swap'?'—':r.pay_time],['支付状态',r.class_type==='swap'?'无需结算':r.pay_status],['备注说明',r.remark]];
    win.document.write('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>上课记录</title><style>body{font-family:Microsoft YaHei,sans-serif;padding:32px;color:#111}h2{font-size:20px;margin:0 0 24px}table{width:100%;border-collapse:collapse}td{border:1px solid #ddd;padding:12px}td:first-child{width:130px;background:#f7f7f7;font-weight:bold}</style><h2>上课记录</h2><table>'+fields.map(([k,v])=>'<tr><td>'+esc(k)+'</td><td>'+esc(v||'—')+'</td></tr>').join('')+'</table><script>window.onload=()=>window.print()<\/script></html>');
    win.document.close();
  };
  const exportMonth=()=>{
    const month=new Date().toISOString().slice(0,7);
    const list=rows.filter(r=>r.class_month===month);
    const headers=['上课类型','学科','班级','上课时间','相关人员','金额','支付时间','支付状态','备注说明'];
    const data=list.map(r=>[TYPE_LABEL[r.class_type]||r.class_type,r.subject,r.class_name,r.class_time,r.related_person,r.class_type==='swap'?'无费用':r.amount,r.pay_time,r.class_type==='swap'?'无需结算':r.pay_status,r.remark]);
    const csv='\ufeff'+[headers,...data].map(row=>row.map(escapeCsv).join(',')).join('\r\n');
    const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));
    download(url,'上课记录统计_'+month+'.csv');URL.revokeObjectURL(url);
    toast(`已导出${month}共${list.length}条记录`);
  };
  q('#cr-add').onclick=()=>openEditor();
  q('#cr-export').onclick=exportMonth;
  await load();
}
