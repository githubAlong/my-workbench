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

const currentMonthKey = () => {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
};
const rowMonth = (row) => row.class_month || parseMonth(row.class_time);
const monthLabel = (key) => {
  const parts = String(key || '').split('-');
  return parts.length === 2 ? parts[0] + '年' + Number(parts[1]) + '月' : key;
};
const rowSortValue = (row) => {
  const m = String(row.class_time || '').match(/(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
  const created = Date.parse(row.created_at || '');
  if (Number.isFinite(created)) return created;
  return Number(row.id) || 0;
};


export async function renderClassRecords(root) {
  let rows = [];

  root.innerHTML = `
    <section class="cr-page">
      <style>

        .cr-page{display:flex;flex-direction:column;gap:18px;min-width:0}
        .cr-header{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap}
        .cr-heading{min-width:240px}
        .cr-eyebrow{font-size:12px;font-weight:700;letter-spacing:.08em;color:var(--primary,#4f46e5);margin-bottom:5px}
        .cr-title{font-size:23px;font-weight:750;line-height:1.35;color:var(--text,#1d2129)}
        .cr-subtitle{font-size:13px;color:var(--text-3,#86909c);margin-top:5px}
        .cr-header-actions{display:flex;align-items:center;gap:9px;flex-wrap:wrap}
        .cr-month-pill{display:inline-flex;align-items:center;height:36px;padding:0 12px;border-radius:9px;background:var(--surface-2,#f5f6f8);color:var(--text-2,#4e5969);font-size:12px;font-weight:650}
        .cr-btn{border:1px solid var(--line,#e5e6eb);border-radius:9px;padding:9px 14px;min-height:36px;background:var(--card,#fff);color:var(--text-2,#4e5969);cursor:pointer;font:inherit;font-size:13px;font-weight:600;transition:background .15s,border-color .15s,transform .15s}
        .cr-btn:hover{border-color:var(--primary,#4f46e5);color:var(--primary,#4f46e5)}
        .cr-btn.primary{background:var(--primary,#4f46e5);border-color:var(--primary,#4f46e5);color:#fff;box-shadow:0 4px 12px color-mix(in srgb,var(--primary,#4f46e5) 20%,transparent)}
        .cr-btn.primary:hover{filter:brightness(.97);color:#fff}
        .cr-btn:disabled{opacity:.55;cursor:not-allowed}
        .cr-section-head,.cr-records-head{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;margin-bottom:11px}
        .cr-section-title{font-size:15px;font-weight:700;color:var(--text,#1d2129)}
        .cr-section-note{font-size:12px;color:var(--text-3,#86909c);margin-top:4px}
        .cr-kpi-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}
        .cr-kpi-card{position:relative;overflow:hidden;min-width:0;padding:16px 17px 14px;background:var(--card,#fff);border:1px solid var(--line,#e5e6eb);border-radius:13px;box-shadow:var(--shadow-s,0 2px 8px rgba(31,35,41,.035))}
        .cr-kpi-card:before{content:"";position:absolute;left:0;top:0;bottom:0;width:4px;background:var(--cr-accent,var(--primary,#4f46e5))}
        .cr-kpi-card.total{--cr-accent:var(--primary,#4f46e5)}
        .cr-kpi-card.normal{--cr-accent:#16a36a}
        .cr-kpi-card.substitute{--cr-accent:#4387e8}
        .cr-kpi-card.swap{--cr-accent:#e69a32}
        .cr-kpi-label{font-size:12px;color:var(--text-3,#86909c);font-weight:600}
        .cr-kpi-number{font-size:29px;line-height:1.25;font-weight:750;letter-spacing:-.03em;color:var(--text,#1d2129);margin-top:8px;font-variant-numeric:tabular-nums}
        .cr-kpi-foot{font-size:11px;color:var(--text-3,#86909c);margin-top:5px}
        .cr-records-section{display:flex;flex-direction:column;gap:12px}
        .cr-records-head{margin-bottom:0}
        .cr-record-count{font-size:12px;color:var(--text-3,#86909c);white-space:nowrap}
        .cr-record-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
        .cr-record-card{min-width:0;background:var(--card,#fff);border:1px solid var(--line,#e5e6eb);border-radius:13px;padding:15px 16px;box-shadow:var(--shadow-s,0 2px 8px rgba(31,35,41,.035));transition:border-color .15s,box-shadow .15s}
        .cr-record-card:hover{border-color:color-mix(in srgb,var(--primary,#4f46e5) 36%,var(--line,#e5e6eb));box-shadow:0 5px 16px rgba(31,35,41,.06)}
        .cr-record-top{display:flex;align-items:center;justify-content:space-between;gap:10px}
        .cr-record-subject{font-size:18px;font-weight:750;color:var(--text,#1d2129);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .cr-type-badge{flex:none;display:inline-flex;align-items:center;padding:5px 9px;border-radius:7px;font-size:11px;font-weight:700;white-space:nowrap}
        .cr-type-badge.normal{color:#12835b;background:#e8f7f0}
        .cr-type-badge.i-substitute{color:#286fc5;background:#eaf3ff}
        .cr-type-badge.substituted{color:#7650c9;background:#f1ebff}
        .cr-type-badge.swap{color:#a86a12;background:#fff4df}
        .cr-type-badge.other{color:var(--text-2,#4e5969);background:var(--surface-2,#f5f6f8)}
        .cr-record-class{font-size:15px;font-weight:650;color:var(--text-2,#4e5969);margin-top:7px}
        .cr-record-info{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:14px}
        .cr-info-item{min-width:0;display:flex;flex-direction:column;gap:4px}
        .cr-info-item span,.cr-finance-label{font-size:11px;color:var(--text-3,#86909c)}
        .cr-info-item strong{font-size:12px;color:var(--text-2,#4e5969);font-weight:600;overflow-wrap:anywhere}
        .cr-record-bottom{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;border-top:1px solid var(--line,#e5e6eb);margin-top:14px;padding-top:12px}
        .cr-finance{display:flex;align-items:flex-end;gap:12px;flex-wrap:wrap}
        .cr-money-block{display:flex;flex-direction:column;gap:3px}
        .cr-money{font-size:19px;font-weight:750;color:var(--text,#1d2129);font-variant-numeric:tabular-nums}
        .cr-status{display:inline-flex;align-items:center;padding:4px 8px;border-radius:6px;font-size:11px;font-weight:650;white-space:nowrap}
        .cr-status.paid{color:#12835b;background:#e8f7f0}
        .cr-status.unpaid{color:#b7791f;background:#fff4df}
        .cr-status.settled{color:var(--text-2,#4e5969);background:var(--surface-2,#f5f6f8)}
        .cr-record-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:flex-end}
        .cr-action{border:1px solid var(--line,#e5e6eb);border-radius:7px;padding:6px 9px;background:var(--card,#fff);color:var(--text-2,#4e5969);font:inherit;font-size:11px;font-weight:600;cursor:pointer}
        .cr-action:hover{border-color:var(--primary,#4f46e5);color:var(--primary,#4f46e5)}
        .cr-action.primary{color:var(--primary,#4f46e5);background:color-mix(in srgb,var(--primary,#4f46e5) 7%,var(--card,#fff));border-color:color-mix(in srgb,var(--primary,#4f46e5) 18%,var(--line,#e5e6eb))}
        .cr-action.danger{color:#d84a4a}
        .cr-empty-state{grid-column:1/-1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;min-height:180px;padding:28px;border:1px dashed var(--line,#e5e6eb);border-radius:13px;background:var(--card,#fff);text-align:center;color:var(--text-3,#86909c);font-size:13px}
        .cr-empty-icon{width:38px;height:38px;border-radius:12px;display:grid;place-items:center;background:var(--surface-2,#f5f6f8);color:var(--primary,#4f46e5);font-size:19px}
        .cr-form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
        .cr-field{min-width:0}.cr-field label{display:block;font-size:13px;color:var(--text-2,#4e5969);margin-bottom:6px}
        .cr-field input,.cr-field select,.cr-field textarea{width:100%;min-height:40px;border:1px solid var(--line,#e5e6eb);border-radius:9px;padding:9px 11px;background:var(--card,#fff);color:var(--text,#1d2129);font:inherit}
        .cr-field textarea{min-height:96px;resize:vertical}.cr-required{color:var(--red,#f53f3f)}
        .cr-hidden{display:none!important}
        .cr-form-foot{display:flex;justify-content:space-between;gap:8px;margin-top:18px;align-items:center}
        @media print{body *{visibility:hidden!important}#cr-print-root,#cr-print-root *{visibility:visible!important}#cr-print-root{position:absolute;inset:0;width:100%;padding:24px;background:#fff;color:#111}}

      </style>

      <div class="cr-header">
        <div class="cr-heading">
          <div class="cr-eyebrow">课程数据驾驶舱</div>
          <div class="cr-title">上课记录台账</div>
          <div class="cr-subtitle">按课程、上课类型和结算状态，清晰查看每一条授课记录</div>
        </div>
        <div class="cr-header-actions">
          <span class="cr-month-pill" id="cr-month-label">本月统计</span>
          <button class="cr-btn" id="cr-export">导出本月统计</button>
          <button class="cr-btn primary" id="cr-add">＋ 新增上课记录</button>
        </div>
      </div>

      <section class="cr-kpi-section">
        <div class="cr-section-head">
          <div>
            <div class="cr-section-title">本月课程概况</div>
            <div class="cr-section-note" id="cr-month-summary">本月各类上课记录汇总</div>
          </div>
        </div>
        <div class="cr-kpi-grid">
          <div class="cr-kpi-card total"><div class="cr-kpi-label">本月上课记录</div><div class="cr-kpi-number" id="cr-month-total">0</div><div class="cr-kpi-foot">本月登记的全部课程</div></div>
          <div class="cr-kpi-card normal"><div class="cr-kpi-label">正常上课</div><div class="cr-kpi-number" id="cr-month-normal">0</div><div class="cr-kpi-foot">本人正常授课记录</div></div>
          <div class="cr-kpi-card substitute"><div class="cr-kpi-label">代课记录</div><div class="cr-kpi-number" id="cr-month-substitute">0</div><div class="cr-kpi-foot">我代别人 + 别人代我</div></div>
          <div class="cr-kpi-card swap"><div class="cr-kpi-label">换课记录</div><div class="cr-kpi-number" id="cr-month-swap">0</div><div class="cr-kpi-foot">课程调整与换课记录</div></div>
        </div>
      </section>

      <section class="cr-records-section">
        <div class="cr-records-head">
          <div><h3>我的上课记录</h3><p>每张课程卡片展示学科、班级、上课类型、时间和结算情况</p></div>
          <span class="cr-record-count" id="cr-record-count">共 0 条记录</span>
        </div>
        <div class="cr-record-grid" id="cr-record-grid"><div class="cr-empty-state"><div class="cr-empty-icon">⌛</div><b>正在加载上课记录</b></div></div>
      </section>

    </section>`;

  const q = (s) => root.querySelector(s);
  const load = async () => {
    rows = await api.get('/class_records').catch((e) => { toast(e.message || '上课记录加载失败','err'); return []; });
    rows = Array.isArray(rows) ? rows : [];
    paint();
  };


  const paint = () => {
    const month = currentMonthKey();
    const monthRows = rows.filter((r) => rowMonth(r) === month);
    const normalCount = monthRows.filter((r) => r.class_type === 'normal').length;
    const substituteCount = monthRows.filter((r) => r.class_type === 'i_substitute' || r.class_type === 'substituted_for_me').length;
    const swapCount = monthRows.filter((r) => r.class_type === 'swap').length;

    q('#cr-month-label').textContent = monthLabel(month);
    q('#cr-month-summary').textContent = monthLabel(month) + ' · 本月登记的课程记录';
    q('#cr-month-total').textContent = monthRows.length;
    q('#cr-month-normal').textContent = normalCount;
    q('#cr-month-substitute').textContent = substituteCount;
    q('#cr-month-swap').textContent = swapCount;
    q('#cr-record-count').textContent = '共 ' + rows.length + ' 条记录';

    const body = q('#cr-record-grid');
    if (!rows.length) {
      body.innerHTML = '<div class="cr-empty-state">' +
        '<div class="cr-empty-icon">＋</div>' +
        '<b>还没有上课记录</b>' +
        '<span>点击右上角「新增上课记录」，开始登记你的授课、代课和换课情况</span>' +
      '</div>';
      return;
    }

    const ordered = rows.slice().sort((a, b) => rowSortValue(b) - rowSortValue(a));
    body.innerHTML = ordered.map((r) => {
      const typeClass = ({
        normal: 'normal',
        i_substitute: 'i-substitute',
        substituted_for_me: 'substituted',
        swap: 'swap',
      })[r.class_type] || 'other';
      const typeLabel = TYPE_LABEL[r.class_type] || r.class_type || '未分类';
      const swap = r.class_type === 'swap';
      const amount = swap ? '无费用' : (r.amount == null || r.amount === '' ? '未填写' : money(r.amount) + ' 元');
      const status = swap ? '无需结算' : (r.pay_status || '未支付');
      const statusClass = swap ? 'settled' : (status === '已支付' ? 'paid' : 'unpaid');
      const className = r.class_name ? esc(r.class_name) : '班级未填写';
      return '<article class="cr-record-card">' +
        '<div class="cr-record-top">' +
          '<div class="cr-record-subject">' + esc(r.subject || '未填写学科') + '</div>' +
          '<span class="cr-type-badge ' + typeClass + '">' + esc(typeLabel) + '</span>' +
        '</div>' +
        '<div class="cr-record-class">' + className + '</div>' +
        '<div class="cr-record-info">' +
          '<div class="cr-info-item"><span>上课时间</span><strong>' + esc(r.class_time || '未填写') + '</strong></div>' +
          '<div class="cr-info-item"><span>相关人员</span><strong>' + esc(r.related_person || '—') + '</strong></div>' +
        '</div>' +
        '<div class="cr-record-bottom">' +
          '<div class="cr-finance">' +
            '<div class="cr-money-block"><span class="cr-finance-label">课时费</span><strong class="cr-money">' + esc(amount) + '</strong></div>' +
            '<span class="cr-status ' + statusClass + '">' + esc(status) + '</span>' +
          '</div>' +
          '<div class="cr-record-actions">' +
            '<button class="cr-action primary" data-edit="' + esc(r.id) + '">查看/编辑</button>' +
            '<button class="cr-action" data-print="' + esc(r.id) + '">打印</button>' +
            '<button class="cr-action danger" data-delete="' + esc(r.id) + '">删除</button>' +
          '</div>' +
        '</div>' +
      '</article>';
    }).join('');

    body.querySelectorAll('[data-edit]').forEach((b) => {
      b.onclick = () => openEditor(rows.find((r) => String(r.id) === b.dataset.edit));
    });
    body.querySelectorAll('[data-delete]').forEach((b) => {
      b.onclick = () => removeRow(b.dataset.delete);
    });
    body.querySelectorAll('[data-print]').forEach((b) => {
      b.onclick = () => printRow(rows.find((r) => String(r.id) === b.dataset.print));
    });
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

  const exportMonth = () => {
    const month = currentMonthKey();
    const list = rows.filter((r) => rowMonth(r) === month);
    const headers = ['上课类型', '学科', '班级', '上课时间', '相关人员', '金额', '支付时间', '支付状态', '备注说明'];
    const data = list.map((r) => [
      TYPE_LABEL[r.class_type] || r.class_type,
      r.subject,
      r.class_name,
      r.class_time,
      r.related_person,
      r.class_type === 'swap' ? '无费用' : r.amount,
      r.pay_time,
      r.class_type === 'swap' ? '无需结算' : r.pay_status,
      r.remark,
    ]);
    const csv = '\ufeff' + [headers, ...data].map((row) => row.map(escapeCsv).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    download(url, '上课记录统计_' + month + '.csv');
    URL.revokeObjectURL(url);
    toast('已导出' + month + '共' + list.length + '条记录');
  };
  q('#cr-add').onclick=()=>openEditor();
  q('#cr-export').onclick=exportMonth;
  await load();
}
