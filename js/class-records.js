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
const splitClassTime = (value) => {
  const text = String(value || '').trim();
  const dateMatch = text.match(/(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})(?:日)?/);
  const date = dateMatch
    ? dateMatch[1] + '-' + String(Number(dateMatch[2])).padStart(2, '0') + '-' + String(Number(dateMatch[3])).padStart(2, '0')
    : '';
  let rest = dateMatch ? text.replace(dateMatch[0], '').trim() : text;
  const periodMatch = rest.match(/(?:第\s*)?([^\s，,;；]+?)\s*节/);
  const timeMatch = rest.match(/\d{1,2}[:：]\d{2}\s*[-–—~至]\s*\d{1,2}[:：]\d{2}/);
  const period = periodMatch ? periodMatch[0].replace(/\s+/g, '') : '';
  const time = timeMatch ? timeMatch[0].replace(/：/g, ':').replace(/\s+/g, '') : '';
  if (periodMatch) rest = rest.replace(periodMatch[0], '').trim();
  if (timeMatch) rest = rest.replace(timeMatch[0], '').trim();
  return { date, period, time: time || (!period && !date ? rest : '') };
};
const joinClassTime = (date, period, time) => [date, period, time].map((v) => String(v || '').trim()).filter(Boolean).join(' ');
const parseRelatedPeople = (value, classType) => {
  const raw = String(value || '').trim();
  if (!raw) return { substitute_person: '', original_teacher: '' };
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return {
      substitute_person: String(parsed.substitute_person || parsed.substitutePerson || ''),
      original_teacher: String(parsed.original_teacher || parsed.originalTeacher || ''),
    };
  } catch {}
  // Older records used one free-text related_person field.
  if (classType === 'i_substitute') return { substitute_person: '', original_teacher: raw };
  if (classType === 'substituted_for_me') return { substitute_person: raw, original_teacher: '' };
  return { substitute_person: raw, original_teacher: '' };
};
const packRelatedPeople = (substitutePerson, originalTeacher) => {
  const value = {
    substitute_person: String(substitutePerson || '').trim(),
    original_teacher: String(originalTeacher || '').trim(),
  };
  return value.substitute_person || value.original_teacher ? JSON.stringify(value) : null;
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
        .cr-records-section{display:flex;flex-direction:column;gap:12px;min-width:0}
        .cr-records-head{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;margin-bottom:0}
        .cr-records-head h3{margin:0;font-size:18px;font-weight:750;color:var(--text,#1d2129)}
        .cr-records-head p{margin:5px 0 0;font-size:12px;color:var(--text-3,#86909c)}
        .cr-record-count{font-size:12px;color:var(--text-3,#86909c);white-space:nowrap}
        .cr-filter-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
        .cr-filter-bar select,.cr-search{height:38px;min-width:125px;padding:0 11px;border:1px solid var(--line,#e5e6eb);border-radius:9px;background:var(--card,#fff);color:var(--text-2,#4e5969);font:inherit;font-size:12px}
        .cr-search{display:flex;align-items:center;gap:8px;flex:1 1 210px;min-width:180px}
        .cr-search input{width:100%;min-width:0;border:0;outline:0;background:transparent;color:var(--text,#1d2129);font:inherit}
        .cr-search:focus-within,.cr-filter-bar select:focus{border-color:var(--primary,#4f46e5);box-shadow:0 0 0 3px color-mix(in srgb,var(--primary,#4f46e5) 10%,transparent)}
        .cr-filter-reset{height:38px;padding:0 12px;border:1px solid var(--line,#e5e6eb);border-radius:9px;background:var(--card,#fff);color:var(--text-2,#4e5969);font:inherit;font-size:12px;cursor:pointer}
        .cr-table-wrap{width:100%;overflow:auto;border:1px solid var(--line,#e5e6eb);border-radius:12px;background:var(--card,#fff);box-shadow:var(--shadow-s,0 2px 8px rgba(31,35,41,.035));-webkit-overflow-scrolling:touch}
        .cr-table{width:100%;min-width:1020px;border-collapse:separate;border-spacing:0;font-size:12.5px}
        .cr-table th{height:43px;padding:10px 13px;background:var(--surface-2,#f5f6f8);border-bottom:1px solid var(--line,#e5e6eb);color:var(--text-2,#4e5969);font-weight:700;text-align:left;white-space:nowrap}
        .cr-table td{height:58px;padding:9px 13px;border-bottom:1px solid var(--line,#eef0f3);color:var(--text-2,#4e5969);vertical-align:middle}
        .cr-table tbody tr:last-child td{border-bottom:0}
        .cr-table tbody tr:hover td{background:color-mix(in srgb,var(--primary,#4f46e5) 3%,var(--card,#fff))}
        .cr-subject-cell{display:flex;flex-direction:column;align-items:flex-start;gap:5px;min-width:0}
        .cr-subject-cell strong{font-size:13px;color:var(--text,#1d2129);font-weight:700}
        .cr-type-badge{display:inline-flex;align-items:center;padding:3px 7px;border-radius:6px;font-size:10px;font-weight:650;white-space:nowrap}
        .cr-type-badge.normal{color:#12835b;background:#e8f7f0}
        .cr-type-badge.i-substitute{color:#286fc5;background:#eaf3ff}
        .cr-type-badge.substituted{color:#7650c9;background:#f1ebff}
        .cr-type-badge.swap{color:#a86a12;background:#fff4df}
        .cr-type-badge.other{color:var(--text-2,#4e5969);background:var(--surface-2,#f5f6f8)}
        .cr-time-cell strong,.cr-time-cell small{display:block;white-space:nowrap}
        .cr-time-cell strong{color:var(--text-2,#4e5969);font-size:12px;font-weight:650}
        .cr-time-cell small{margin-top:3px;color:var(--text-3,#86909c);font-size:11px}
        .cr-status{display:inline-flex;align-items:center;max-width:135px;padding:5px 9px;border-radius:7px;font-size:11px;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        .cr-status.paid{color:#12835b;background:#e8f7f0}
        .cr-status.unpaid{color:#b7791f;background:#fff4df}
        .cr-status.custom{color:#5b55a5;background:#f0efff}
        .cr-status.settled{color:var(--text-2,#4e5969);background:var(--surface-2,#f5f6f8)}
        .cr-row-actions{display:flex;align-items:center;gap:8px;white-space:nowrap}
        .cr-row-action{padding:0;border:0;background:none;color:var(--primary,#4f46e5);font:inherit;font-size:11.5px;cursor:pointer}
        .cr-row-action:hover{text-decoration:underline}
        .cr-row-action.danger{color:#d84a4a}
        .cr-empty-state{grid-column:1/-1;display:flex;min-height:150px;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:24px;border:1px dashed var(--line,#e5e6eb);border-radius:13px;background:var(--card,#fff);color:var(--text-3,#86909c);text-align:center;font-size:13px}
        .cr-empty-state b{color:var(--text-2,#4e5969);font-size:14px}
        .cr-empty-icon{width:38px;height:38px;border-radius:12px;display:grid;place-items:center;background:var(--surface-2,#f5f6f8);color:var(--primary,#4f46e5);font-size:19px}
        .cr-pagination{display:flex;align-items:center;justify-content:space-between;gap:12px;color:var(--text-3,#86909c);font-size:12px}
        .cr-pagination-tools{display:flex;align-items:center;gap:8px}
        .cr-pagination select,.cr-page-btn{height:32px;padding:0 9px;border:1px solid var(--line,#e5e6eb);border-radius:8px;background:var(--card,#fff);color:var(--text-2,#4e5969);font:inherit;font-size:12px}
        .cr-page-btn{min-width:32px;cursor:pointer}
        .cr-page-btn:disabled{opacity:.4;cursor:not-allowed}
        .cr-page-number{display:inline-grid;min-width:28px;height:28px;place-items:center;border-radius:7px;background:var(--primary,#4f46e5);color:#fff;font-weight:700}
        .cr-editor{padding:18px 22px 22px}
        .cr-form-foot{position:sticky;bottom:-22px;display:flex;justify-content:flex-end;gap:10px;margin:22px -22px -22px;padding:13px 22px calc(13px + var(--safe-b,0px));border-top:1px solid var(--line,#e5e6eb);background:var(--card,#fff)}
        .cr-form-foot .cr-btn{min-width:112px}
        .sheet-mask.cr-record-drawer-mask{align-items:stretch;justify-content:flex-end;padding:0}
        .sheet-mask.cr-record-drawer-mask .sheet{width:min(450px,100vw);max-width:450px;height:100dvh;max-height:100dvh;border-radius:16px 0 0 16px;transform:translateX(28px);transition:transform .22s cubic-bezier(.2,.8,.3,1)}
        .sheet-mask.cr-record-drawer-mask.in .sheet{transform:translateX(0)}
        .sheet-mask.cr-record-drawer-mask .sheet-head{min-height:66px;padding:18px 22px 14px;border-bottom:1px solid var(--line,#e5e6eb)}
        .sheet-mask.cr-record-drawer-mask .sheet-title{font-size:19px;font-weight:750}
        .sheet-mask.cr-record-drawer-mask .sheet-body{flex:1;min-height:0;padding:0;overflow:auto}
        @media(max-width:1100px){.cr-kpi-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.cr-filter-bar select{min-width:115px}}
        @media(max-width:720px){
          .cr-page{gap:14px}.cr-header{align-items:flex-start}.cr-title{font-size:22px}
          .cr-kpi-grid{gap:8px}.cr-kpi-card{padding:12px}.cr-kpi-number{font-size:24px}
          .cr-records-head{align-items:flex-start}.cr-filter-bar{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}
          .cr-filter-bar select{width:100%;min-width:0}.cr-search{grid-column:1/-1;width:100%;min-width:0}
          .cr-filter-reset{grid-column:1/-1}.cr-pagination{align-items:flex-start;flex-direction:column}
          .sheet-mask.cr-record-drawer-mask{align-items:flex-end;justify-content:center}
          .sheet-mask.cr-record-drawer-mask .sheet{width:100vw;max-width:100vw;height:92dvh;max-height:92dvh;border-radius:18px 18px 0 0;transform:translateY(24px)}
          .sheet-mask.cr-record-drawer-mask.in .sheet{transform:translateY(0)}
          .cr-editor{padding:15px 15px 18px}.cr-form-grid{grid-template-columns:1fr;gap:12px}
          .cr-form-foot{bottom:-18px;margin:18px -15px -18px;padding:12px 15px calc(12px + var(--safe-b,0px))}
        }
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
          <div class="cr-title">上课记录</div>
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
          <div><h3>我的上课记录</h3><p>按学科、班级和上课时间查看、管理每一条记录</p></div>
          <span class="cr-record-count" id="cr-record-count">共 0 条记录</span>
        </div>
        <div class="cr-filter-bar">
          <select id="cr-filter-subject" aria-label="按学科筛选"><option value="">全部学科</option></select>
          <select id="cr-filter-class" aria-label="按年级班级筛选"><option value="">全部年级班级</option></select>
          <select id="cr-filter-type" aria-label="按上课类型筛选">
            <option value="">全部上课类型</option><option value="normal">正常上课</option>
            <option value="i_substitute">我代别人上课</option><option value="substituted_for_me">别人代我上课</option><option value="swap">换课</option>
          </select>
          <label class="cr-search"><span aria-hidden="true">⌕</span><input id="cr-search" type="search" placeholder="搜索学科、班级或老师"></label>
          <button class="cr-filter-reset" id="cr-filter-reset" type="button">重置筛选</button>
        </div>
        <div class="cr-table-wrap">
          <table class="cr-table" id="cr-record-table">
            <thead><tr><th>学科</th><th>年级班级</th><th>上课时间</th><th>原上课人</th><th>代课人</th><th>课时费</th><th>支付状态</th><th>操作</th></tr></thead>
            <tbody id="cr-record-tbody"><tr><td colspan="8"><div class="cr-empty-state">正在加载上课记录…</div></td></tr></tbody>
          </table>
        </div>
        <div class="cr-pagination">
          <span id="cr-page-info">共 0 条记录</span>
          <div class="cr-pagination-tools">
            <select id="cr-page-size" aria-label="每页显示条数"><option value="10">10 条/页</option><option value="20">20 条/页</option><option value="50">50 条/页</option></select>
            <button class="cr-page-btn" id="cr-page-prev" type="button" aria-label="上一页">‹</button>
            <span class="cr-page-number" id="cr-page-number">1</span>
            <button class="cr-page-btn" id="cr-page-next" type="button" aria-label="下一页">›</button>
          </div>
        </div>
      </section>

    </section>`;

  const q = (s) => root.querySelector(s);
  let page = 1;
  let pageSize = 10;
  const load = async () => {
    rows = await api.get('/class_records').catch((e) => { toast(e.message || '上课记录加载失败','err'); return []; });
    rows = Array.isArray(rows) ? rows : [];
    paint();
  };


  const paint = () => {
    const month = currentMonthKey();
    const monthRows = rows.filter((r) => rowMonth(r) === month);
    q('#cr-month-label').textContent = monthLabel(month);
    q('#cr-month-summary').textContent = monthLabel(month) + ' · 本月登记的课程记录';
    q('#cr-month-total').textContent = monthRows.length;
    q('#cr-month-normal').textContent = monthRows.filter((r) => r.class_type === 'normal').length;
    q('#cr-month-substitute').textContent = monthRows.filter((r) => r.class_type === 'i_substitute' || r.class_type === 'substituted_for_me').length;
    q('#cr-month-swap').textContent = monthRows.filter((r) => r.class_type === 'swap').length;

    const updateOptions = (selector, label, values) => {
      const select = q(selector);
      const current = select.value;
      select.innerHTML = '<option value="">'+esc(label)+'</option>' + values.map((value) => '<option value="'+esc(value)+'">'+esc(value)+'</option>').join('');
      if (values.includes(current)) select.value = current;
    };
    updateOptions('#cr-filter-subject','全部学科',[...new Set(rows.map((r)=>String(r.subject||'').trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'zh-Hans-CN')));
    updateOptions('#cr-filter-class','全部年级班级',[...new Set(rows.map((r)=>String(r.class_name||'').trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'zh-Hans-CN')));

    const subject = q('#cr-filter-subject').value;
    const className = q('#cr-filter-class').value;
    const type = q('#cr-filter-type').value;
    const keyword = q('#cr-search').value.trim().toLowerCase();
    const filtered = rows.filter((r) => {
      if (subject && r.subject !== subject) return false;
      if (className && r.class_name !== className) return false;
      if (type && r.class_type !== type) return false;
      if (keyword) {
        const people = parseRelatedPeople(r.related_person,r.class_type);
        const haystack = [r.subject,r.class_name,r.class_time,people.original_teacher,people.substitute_person,r.pay_status].join(' ').toLowerCase();
        if (!haystack.includes(keyword)) return false;
      }
      return true;
    }).sort((a,b) => rowSortValue(b)-rowSortValue(a));

    const pageCount = Math.max(1,Math.ceil(filtered.length/pageSize));
    page = Math.min(page,pageCount);
    const visible = filtered.slice((page-1)*pageSize,page*pageSize);
    q('#cr-record-count').textContent = '共 '+filtered.length+' 条记录';
    q('#cr-page-info').textContent = filtered.length ? '共 '+filtered.length+' 条记录' : '暂无记录';
    q('#cr-page-number').textContent = page;
    q('#cr-page-prev').disabled = page <= 1;
    q('#cr-page-next').disabled = page >= pageCount;

    const body = q('#cr-record-tbody');
    if (!filtered.length) {
      const message = rows.length ? '没有符合条件的记录' : '还没有上课记录';
      const hint = rows.length ? '请调整筛选条件，或点击重置筛选。' : '点击右上角「新增上课记录」，开始登记授课、代课和换课情况。';
      body.innerHTML = '<tr><td colspan="8"><div class="cr-empty-state"><div class="cr-empty-icon">＋</div><b>'+message+'</b><span>'+hint+'</span></div></td></tr>';
      return;
    }

    body.innerHTML = visible.map((r) => {
      const typeClass = ({normal:'normal',i_substitute:'i-substitute',substituted_for_me:'substituted',swap:'swap'})[r.class_type] || 'other';
      const typeLabel = TYPE_LABEL[r.class_type] || r.class_type || '未分类';
      const swap = r.class_type === 'swap';
      const people = parseRelatedPeople(r.related_person,r.class_type);
      const classTime = splitClassTime(r.class_time);
      const status = swap ? '无需结算' : (r.pay_status || '未填写');
      const statusClass = swap ? 'settled' : (status === '已支付' ? 'paid' : status === '未支付' ? 'unpaid' : 'custom');
      const amount = swap ? '—' : (r.amount == null || r.amount === '' ? '—' : money(r.amount)+' 元');
      const timeLines = [
        classTime.date ? '<strong>'+esc(classTime.date)+'</strong>' : '<strong>—</strong>',
        classTime.period ? '<small>'+esc(classTime.period)+'</small>' : '',
        classTime.time ? '<small>'+esc(classTime.time)+'</small>' : '',
      ].join('');
      return '<tr>'+
        '<td><div class="cr-subject-cell"><strong>'+esc(r.subject||'未填写学科')+'</strong><span class="cr-type-badge '+typeClass+'">'+esc(typeLabel)+'</span></div></td>'+
        '<td>'+esc(r.class_name||'—')+'</td>'+
        '<td><div class="cr-time-cell">'+timeLines+'</div></td>'+
        '<td>'+esc(people.original_teacher||'—')+'</td>'+
        '<td>'+esc(people.substitute_person||'—')+'</td>'+
        '<td>'+esc(amount)+'</td>'+
        '<td><span class="cr-status '+statusClass+'" title="'+esc(status)+'">'+esc(status)+'</span></td>'+
        '<td><div class="cr-row-actions"><button class="cr-row-action" data-edit="'+esc(r.id)+'">查看/编辑</button><button class="cr-row-action" data-print="'+esc(r.id)+'">打印</button><button class="cr-row-action danger" data-delete="'+esc(r.id)+'">删除</button></div></td>'+
      '</tr>';
    }).join('');

    body.querySelectorAll('[data-edit]').forEach((b)=>{b.onclick=()=>openEditor(rows.find((r)=>String(r.id)===b.dataset.edit));});
    body.querySelectorAll('[data-delete]').forEach((b)=>{b.onclick=()=>removeRow(b.dataset.delete);});
    body.querySelectorAll('[data-print]').forEach((b)=>{b.onclick=()=>printRow(rows.find((r)=>String(r.id)===b.dataset.print));});
  };
  const openEditor = (row=null) => {
    const editing=!!row;
    const initialType=row?.class_type||'normal';
    const initialTime=splitClassTime(row?.class_time);
    const initialPeople=parseRelatedPeople(row?.related_person,initialType);
    const form=el(`<div class="cr-editor">
      <div class="cr-form-grid">
        <div class="cr-field"><label>上课类型 <span class="cr-required">*</span></label><select id="cr-type">${TYPES.map(([v,t])=>`<option value="${v}" ${initialType===v?'selected':''}>${t}</option>`).join('')}</select></div>
        <div class="cr-field"><label>学科 <span class="cr-required">*</span></label><input id="cr-subject" value="${esc(row?.subject||'')}" placeholder="例如：信息技术、语文"></div>
        <div class="cr-field"><label>班级</label><input id="cr-class" value="${esc(row?.class_name||'')}"></div>
        <div class="cr-field"><label>上课日期</label><input id="cr-date" type="date" value="${esc(initialTime.date)}"></div>
        <div class="cr-field"><label>节次</label><input id="cr-period" value="${esc(initialTime.period)}" placeholder="例如：第2节、早自习"></div>
        <div class="cr-field"><label>时间</label><input id="cr-time" value="${esc(initialTime.time)}" placeholder="例如：08:00-08:45，可手动输入"></div>
        <div class="cr-field"><label>代课人</label><input id="cr-substitute-person" value="${esc(initialPeople.substitute_person)}" placeholder="手动填写代课人"></div>
        <div class="cr-field"><label>原上课人</label><input id="cr-original-teacher" value="${esc(initialPeople.original_teacher)}" placeholder="手动填写原上课人"></div>
        <div class="cr-field" id="cr-money-wrap"><label>课时费（元）</label><input id="cr-money" type="number" min="0" step="0.01" value="${row?.amount??(initialType==='normal'?'30':'')}" placeholder="请输入金额"></div>
        <div class="cr-field" id="cr-paytime-wrap"><label>支付时间</label><input id="cr-paytime" value="${esc(row?.pay_time||'')}" placeholder="手动输入"></div>
        <div class="cr-field" id="cr-status-wrap"><label>支付状态</label><input id="cr-status" type="text" value="${esc(row?.pay_status||'未支付')}" placeholder="手动输入支付状态"></div>
      </div>
      <div class="cr-field" style="margin-top:14px"><label>备注说明</label><textarea id="cr-remark" placeholder="换课说明、特殊情况备注等">${esc(row?.remark||'')}</textarea></div>
      <div class="cr-form-foot"><button class="cr-btn" id="cr-print-current" type="button">打印本条记录</button><button class="cr-btn primary" id="cr-save" type="button">${editing?'保存修改':'保存记录'}</button></div>
    </div>`);
    const sh=sheet({title:editing?'编辑上课记录':'新增上课记录',body:form,cls:'cr-record-drawer'});
    sh.wrap.classList.add('cr-record-drawer-mask');
    const type=form.querySelector('#cr-type'), moneyInput=form.querySelector('#cr-money');
    let changedType=false;
    const currentClassTime=()=>joinClassTime(
      form.querySelector('#cr-date').value,
      form.querySelector('#cr-period').value,
      form.querySelector('#cr-time').value
    );
    const currentPeople=()=>packRelatedPeople(
      form.querySelector('#cr-substitute-person').value,
      form.querySelector('#cr-original-teacher').value
    );
    type.onchange=()=>{changedType=true;toggle();};
    function toggle(){
      const swap=type.value==='swap';
      ['#cr-money-wrap','#cr-paytime-wrap','#cr-status-wrap'].forEach(s=>form.querySelector(s).classList.toggle('cr-hidden',swap));
      if(!editing && type.value==='normal' && !changedType && !moneyInput.value) moneyInput.value='30';
      if(!editing && changedType && type.value==='normal') moneyInput.value='30';
      if(!editing && changedType && type.value!=='normal') moneyInput.value='';
    }
    toggle();
    form.querySelector('#cr-print-current').onclick=()=>printRow({
      ...row,
      class_type:type.value,
      subject:form.querySelector('#cr-subject').value,
      class_name:form.querySelector('#cr-class').value,
      class_time:currentClassTime(),
      related_person:currentPeople(),
      amount:moneyInput.value,
      pay_time:form.querySelector('#cr-paytime').value,
      pay_status:form.querySelector('#cr-status').value,
      remark:form.querySelector('#cr-remark').value
    });
    saving(form.querySelector('#cr-save'),async()=>{
      const classTime=currentClassTime();
      const data={
        class_type:type.value,subject:form.querySelector('#cr-subject').value.trim(),
        class_name:form.querySelector('#cr-class').value.trim()||null,
        class_time:classTime||null,
        related_person:currentPeople(),
        amount:type.value==='swap'?null:(moneyInput.value===''?null:Number(moneyInput.value)),
        pay_time:type.value==='swap'?null:(form.querySelector('#cr-paytime').value.trim()||null),
        pay_status:type.value==='swap'?null:(form.querySelector('#cr-status').value.trim()||null),
        remark:form.querySelector('#cr-remark').value.trim()||null,
        class_month:parseMonth(form.querySelector('#cr-date').value)||parseMonth(classTime)||row?.class_month||null,
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
    const classTime=splitClassTime(r.class_time);
    const people=parseRelatedPeople(r.related_person,r.class_type);
    const fields=[['上课类型',TYPE_LABEL[r.class_type]||r.class_type],['学科',r.subject],['班级',r.class_name],['上课日期',classTime.date],['节次',classTime.period],['时间',classTime.time],['代课人',people.substitute_person],['原上课人',people.original_teacher],['金额',r.class_type==='swap'?'无费用':(r.amount==null?'—':money(r.amount)+' 元')],['支付时间',r.class_type==='swap'?'—':r.pay_time],['支付状态',r.class_type==='swap'?'无需结算':r.pay_status],['备注说明',r.remark]];
    win.document.write('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>上课记录</title><style>body{font-family:Microsoft YaHei,sans-serif;padding:32px;color:#111}h2{font-size:20px;margin:0 0 24px}table{width:100%;border-collapse:collapse}td{border:1px solid #ddd;padding:12px}td:first-child{width:130px;background:#f7f7f7;font-weight:bold}</style><h2>上课记录</h2><table>'+fields.map(([k,v])=>'<tr><td>'+esc(k)+'</td><td>'+esc(v||'—')+'</td></tr>').join('')+'</table><script>window.onload=()=>window.print()<\/script></html>');
    win.document.close();
  };

  const exportMonth = () => {
    const month = currentMonthKey();
    const list = rows.filter((r) => rowMonth(r) === month);
    const headers = ['上课类型', '学科', '班级', '上课日期', '节次', '时间', '代课人', '原上课人', '金额', '支付时间', '支付状态', '备注说明'];
    const data = list.map((r) => {
      const classTime = splitClassTime(r.class_time);
      const people = parseRelatedPeople(r.related_person, r.class_type);
      return [
        TYPE_LABEL[r.class_type] || r.class_type,
        r.subject,
        r.class_name,
        classTime.date,
        classTime.period,
        classTime.time,
        people.substitute_person,
        people.original_teacher,
        r.class_type === 'swap' ? '无费用' : r.amount,
        r.pay_time,
        r.class_type === 'swap' ? '无需结算' : r.pay_status,
        r.remark,
      ];
    });
    const csv = '\ufeff' + [headers, ...data].map((row) => row.map(escapeCsv).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    download(url, '上课记录统计_' + month + '.csv');
    URL.revokeObjectURL(url);
    toast('已导出' + month + '共' + list.length + '条记录');
  };
  ['#cr-filter-subject','#cr-filter-class','#cr-filter-type'].forEach((selector)=>{q(selector).onchange=()=>{page=1;paint();};});
  q('#cr-search').oninput=()=>{page=1;paint();};
  q('#cr-filter-reset').onclick=()=>{q('#cr-filter-subject').value='';q('#cr-filter-class').value='';q('#cr-filter-type').value='';q('#cr-search').value='';page=1;paint();};
  q('#cr-page-size').onchange=()=>{pageSize=Number(q('#cr-page-size').value)||10;page=1;paint();};
  q('#cr-page-prev').onclick=()=>{page=Math.max(1,page-1);paint();};
  q('#cr-page-next').onclick=()=>{page+=1;paint();};
  q('#cr-add').onclick=()=>openEditor();
  q('#cr-export').onclick=exportMonth;
  await load();
}
