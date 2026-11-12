import { api, esc, el, sheet, saving, confirmDialog, toast, download } from './core.js';
import { cleanPeriodTime, normalizeTimetablePeriods } from './timetable-periods.mjs';

const TYPES = [
  ['normal', '正常上课'],
  ['i_substitute', '我代别人上课'],
  ['substituted_for_me', '别人代我上课'],
  ['swap', '换课'],
];
const TYPE_LABEL = Object.fromEntries(TYPES);
/* 上课类型 → 课时费 / 支付状态默认值。切换类型时自动带出，之后仍可手改。 */
const TYPE_DEFAULTS = {
  normal: { amount: 30, status: '学校支付' },
  i_substitute: { amount: 40, status: '待支付' },
  substituted_for_me: { amount: 40, status: '待支付' },
  swap: { amount: 0, status: '无需支付' },
};
const PAY_OPTIONS = ['学校支付', '待支付', '无需支付', '已支付', '未支付'];
const GRADE_OPTIONS = ['高一', '高二', '高三'];
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
export const monthShift = (key, delta) => {
  const parts = String(key || currentMonthKey()).split('-').map(Number);
  const d = new Date(parts[0], parts[1] - 1 + delta, 1);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
};
/* 「最近一年」快捷入口：过去 11 个月 + 本月 + 下一个月，前后箭头仍可翻到任意年月。 */
export const recentMonths = (base = currentMonthKey()) => {
  const out = [];
  for (let delta = -11; delta <= 1; delta++) out.push(monthShift(base, delta));
  return out;
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
  return { date, period: period || (time ? rest : ''), time: time || (!period && !date ? rest : '') };
};
const joinClassTime = (date, period, time) => [date, period, time].map((v) => String(v || '').trim()).filter(Boolean).join(' ');
/* 历史记录把人员塞在 related_person JSON 里；新记录只写代课人，其余由独立字段承载。 */
const parseRelatedPeople = (value, classType) => {
  const raw = String(value || '').trim();
  if (!raw) return { substitute_person: '', original_teacher: '' };
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return {
      substitute_person: String(parsed.substitute_person || parsed.substitutePerson || ''),
      original_teacher: String(parsed.original_teacher || parsed.originalTeacher || ''),
      original_class: String(parsed.original_class || ''),
    };
  } catch {}
  if (classType === 'i_substitute') return { substitute_person: '', original_teacher: raw };
  if (classType === 'substituted_for_me') return { substitute_person: raw, original_teacher: '' };
  return { substitute_person: raw, original_teacher: '' };
};
const packRelatedPeople = (substitutePerson, originalTeacher = '', originalClass = '') => {
  const value = {
    substitute_person: String(substitutePerson || '').trim(),
    original_teacher: String(originalTeacher || '').trim(),
    original_class: String(originalClass || '').trim(),
  };
  return value.substitute_person || value.original_teacher || value.original_class ? JSON.stringify(value) : null;
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
const typeBadgeClass = (type) => ({ normal: 'normal', i_substitute: 'i-substitute', substituted_for_me: 'substituted', swap: 'swap' })[type] || 'other';
const statusClass = (status) => {
  if (status === '已支付' || status === '学校支付') return 'paid';
  if (status === '待支付' || status === '未支付') return 'unpaid';
  if (status === '无需支付') return 'settled';
  return 'custom';
};
const clip = (value, max = 26) => {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max) + '…' : text;
};

/* 表单与列表共用的列顺序 —— 改这里之前先确认「列表显示顺序跟表单一致」这条约定。 */
const COLUMNS = ['上课日期', '上课年级', '上课班级', '节次', '学科', '上课类型', '上课人', '代课人', '课时费（元）', '支付状态', '备注说明'];


export async function renderClassRecords(root) {
  let rows = [];
  let month = currentMonthKey();
  let page = 1;
  let pageSize = 10;

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
        .cr-month-nav{display:inline-flex;align-items:center;gap:4px;height:36px;padding:3px 5px;border:1px solid var(--line,#e5e6eb);border-radius:9px;background:var(--card,#fff)}
        .cr-month-btn{width:26px;height:28px;border:0;border-radius:6px;background:transparent;color:var(--text-2,#4e5969);font:inherit;font-size:19px;line-height:1;cursor:pointer}
        .cr-month-btn:hover{background:var(--surface-2,#f5f6f8);color:var(--primary,#4f46e5)}
        .cr-month-label{min-width:92px;height:28px;padding:0 7px;border:0;border-radius:6px;background:transparent;color:var(--text,#1d2129);font:inherit;font-size:12.5px;font-weight:700;cursor:pointer;white-space:nowrap}
        .cr-month-label:hover{background:var(--surface-2,#f5f6f8)}
        .cr-month-hidden{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}
        .cr-month-quick{height:28px;max-width:104px;padding:0 4px;border:1px solid var(--line,#e5e6eb);border-radius:6px;background:var(--card,#fff);color:var(--text-2,#4e5969);font:inherit;font-size:11.5px;cursor:pointer}
        .cr-month-today{height:28px;padding:0 8px;border:0;border-radius:6px;background:var(--surface-2,#f5f6f8);color:var(--text-2,#4e5969);font:inherit;font-size:11.5px;font-weight:600;cursor:pointer;white-space:nowrap}
        .cr-month-today:hover{color:var(--primary,#4f46e5)}
        .cr-btn{border:1px solid var(--line,#e5e6eb);border-radius:9px;padding:9px 14px;min-height:36px;background:var(--card,#fff);color:var(--text-2,#4e5969);cursor:pointer;font:inherit;font-size:13px;font-weight:600;transition:background .15s,border-color .15s}
        .cr-btn:hover{border-color:var(--primary,#4f46e5);color:var(--primary,#4f46e5)}
        .cr-btn.primary{background:var(--primary,#4f46e5);border-color:var(--primary,#4f46e5);color:#fff;box-shadow:0 4px 12px color-mix(in srgb,var(--primary,#4f46e5) 20%,transparent)}
        .cr-btn.primary:hover{filter:brightness(.97);color:#fff}
        .cr-section-head,.cr-records-head{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;margin-bottom:11px}
        .cr-section-title{font-size:15px;font-weight:700;color:var(--text,#1d2129)}
        .cr-section-note{font-size:12px;color:var(--text-3,#86909c);margin-top:4px}
        .cr-section-hint{font-size:12px;font-weight:650;color:var(--text-2,#4e5969);white-space:nowrap}
        .cr-kpi-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:12px}
        .cr-kpi-card{position:relative;overflow:hidden;min-width:0;padding:16px 17px 14px;background:var(--card,#fff);border:1px solid var(--line,#e5e6eb);border-radius:13px;box-shadow:var(--shadow-s,0 2px 8px rgba(31,35,41,.035))}
        .cr-kpi-card:before{content:"";position:absolute;left:0;top:0;bottom:0;width:4px;background:var(--cr-accent,var(--primary,#4f46e5))}
        .cr-kpi-card.total{--cr-accent:var(--primary,#4f46e5)}
        .cr-kpi-card.normal{--cr-accent:#16a36a}
        .cr-kpi-card.i-substitute{--cr-accent:#4387e8}
        .cr-kpi-card.substituted{--cr-accent:#7650c9}
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
        .cr-filter-reset{height:38px;padding:0 12px;border:1px solid var(--line,#e5e6eb);border-radius:9px;background:var(--card,#fff);color:var(--text-2,#4e5969);font:inherit;font-size:12px;cursor:pointer}
        .cr-table-wrap{width:100%;overflow:auto;border:1px solid var(--line,#e5e6eb);border-radius:12px;background:var(--card,#fff);box-shadow:var(--shadow-s,0 2px 8px rgba(31,35,41,.035));-webkit-overflow-scrolling:touch}
        .cr-table{width:100%;min-width:1380px;border-collapse:separate;border-spacing:0;font-size:12.5px}
        .cr-table th{height:43px;padding:10px 13px;background:var(--surface-2,#f5f6f8);border-bottom:1px solid var(--line,#e5e6eb);color:var(--text-2,#4e5969);font-weight:700;text-align:left;white-space:nowrap}
        .cr-table td{height:58px;padding:9px 13px;border-bottom:1px solid var(--line,#eef0f3);color:var(--text-2,#4e5969);vertical-align:middle}
        .cr-table tbody tr:last-child td{border-bottom:0}
        .cr-table tbody tr:hover td{background:color-mix(in srgb,var(--primary,#4f46e5) 3%,var(--card,#fff))}
        .cr-type-badge{display:inline-flex;align-items:center;padding:3px 7px;border-radius:6px;font-size:10px;font-weight:650;white-space:nowrap}
        .cr-type-badge.normal{color:#12835b;background:#e8f7f0}
        .cr-type-badge.i-substitute{color:#286fc5;background:#eaf3ff}
        .cr-type-badge.substituted{color:#7650c9;background:#f1ebff}
        .cr-type-badge.swap{color:#a86a12;background:#fff4df}
        .cr-type-badge.other{color:var(--text-2,#4e5969);background:var(--surface-2,#f5f6f8)}
        .cr-status{display:inline-flex;align-items:center;max-width:135px;padding:5px 9px;border-radius:7px;font-size:11px;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        .cr-status.paid{color:#12835b;background:#e8f7f0}
        .cr-status.unpaid{color:#b7791f;background:#fff4df}
        .cr-status.custom{color:#5b55a5;background:#f0efff}
        .cr-status.settled{color:var(--text-2,#4e5969);background:var(--surface-2,#f5f6f8)}
        .cr-row-actions{display:flex;align-items:center;gap:10px;white-space:nowrap}
        .cr-row-action{padding:0;border:0;background:none;color:var(--primary,#4f46e5);font:inherit;font-size:11.5px;cursor:pointer}
        .cr-row-action:hover{text-decoration:underline}
        .cr-row-action.danger{color:#d84a4a}
        .cr-empty-state{display:flex;min-height:150px;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:24px;border:1px dashed var(--line,#e5e6eb);border-radius:13px;background:var(--card,#fff);color:var(--text-3,#86909c);text-align:center;font-size:13px}
        .cr-empty-state b{color:var(--text-2,#4e5969);font-size:14px}
        .cr-empty-icon{width:38px;height:38px;border-radius:12px;display:grid;place-items:center;background:var(--surface-2,#f5f6f8);color:var(--primary,#4f46e5);font-size:19px}
        .cr-pagination{display:flex;align-items:center;justify-content:space-between;gap:12px;color:var(--text-3,#86909c);font-size:12px}
        .cr-pagination-tools{display:flex;align-items:center;gap:8px}
        .cr-pagination select,.cr-page-btn{height:32px;padding:0 9px;border:1px solid var(--line,#e5e6eb);border-radius:8px;background:var(--card,#fff);color:var(--text-2,#4e5969);font:inherit;font-size:12px}
        .cr-page-btn{min-width:32px;cursor:pointer}
        .cr-page-btn:disabled{opacity:.4;cursor:not-allowed}
        .cr-page-number{display:inline-grid;min-width:28px;height:28px;place-items:center;border-radius:7px;background:var(--primary,#4f46e5);color:#fff;font-weight:700}
        .cr-editor{padding:18px 22px 22px}
        .cr-form-foot{display:flex;justify-content:flex-end;gap:10px;margin-top:20px;padding-top:14px;border-top:1px solid var(--line,#e5e6eb)}
        .cr-form-foot .cr-btn{min-width:112px}
        .sheet-mask.cr-record-drawer-mask{align-items:center;justify-content:center;padding:24px}
        .sheet-mask.cr-record-drawer-mask .sheet{width:min(720px,100%);max-width:720px;height:auto;max-height:calc(100dvh - 48px);border-radius:18px}
        .sheet-mask.cr-record-drawer-mask .sheet-head{min-height:66px;padding:18px 22px 14px;border-bottom:1px solid var(--line,#e5e6eb)}
        .sheet-mask.cr-record-drawer-mask .sheet-title{font-size:19px;font-weight:750}
        .sheet-mask.cr-record-drawer-mask .sheet-body{flex:1;min-height:0;padding:0;overflow:auto}
        .cr-form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
        .cr-field{min-width:0}.cr-field label{display:block;font-size:13px;color:var(--text-2,#4e5969);margin-bottom:6px}
        .cr-field input,.cr-field select,.cr-field textarea{width:100%;min-height:40px;border:1px solid var(--line,#e5e6eb);border-radius:9px;padding:9px 11px;background:var(--card,#fff);color:var(--text,#1d2129);font:inherit}
        .cr-field textarea{min-height:96px;resize:vertical}.cr-required{color:var(--red,#f53f3f)}
        .cr-viewer-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1px;background:var(--line,#e5e6eb);border:1px solid var(--line,#e5e6eb);border-radius:11px;overflow:hidden}
        .cr-viewer-item{display:flex;flex-direction:column;gap:5px;min-width:0;padding:11px 13px;background:var(--card,#fff)}
        .cr-viewer-item span{font-size:11.5px;color:var(--text-3,#86909c);font-weight:600}
        .cr-viewer-item strong{font-size:13px;color:var(--text,#1d2129);font-weight:650;word-break:break-all}
        .cr-viewer-item.full{grid-column:1/-1}
        @media(max-width:1100px){.cr-kpi-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.cr-filter-bar select{min-width:115px}}
        @media(max-width:720px){
          .cr-page{gap:14px}.cr-header{align-items:flex-start}.cr-title{font-size:22px}
          .cr-kpi-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.cr-kpi-card{padding:12px}.cr-kpi-number{font-size:24px}
          .cr-month-quick,.cr-month-today{display:none}
          .cr-records-head{align-items:flex-start}.cr-filter-bar{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}
          .cr-filter-bar select{width:100%;min-width:0}.cr-search{grid-column:1/-1;width:100%;min-width:0}
          .cr-filter-reset{grid-column:1/-1}.cr-pagination{align-items:flex-start;flex-direction:column}
          .sheet-mask.cr-record-drawer-mask{padding:12px}
          .cr-editor{padding:15px 15px 18px}.cr-editor .cr-form-grid,.cr-viewer-grid{grid-template-columns:1fr;gap:12px}
        }
      </style>

      <div class="cr-header">
        <div class="cr-heading">
          <div class="cr-title">上课记录</div>
          <div class="cr-subtitle">按月份、上课类型和结算状态，清晰查看每一条授课记录</div>
        </div>
        <div class="cr-header-actions">
          <div class="cr-month-nav" role="group" aria-label="切换统计月份">
            <button class="cr-month-btn" id="cr-month-prev" type="button" aria-label="上一个月">‹</button>
            <button class="cr-month-label" id="cr-month-pick" type="button"></button>
            <input class="cr-month-hidden" id="cr-month-input" type="month" aria-label="选择月份">
            <button class="cr-month-btn" id="cr-month-next" type="button" aria-label="下一个月">›</button>
            <select class="cr-month-quick" id="cr-month-quick" aria-label="最近一年"></select>
            <button class="cr-month-today" id="cr-month-today" type="button">回到本月</button>
          </div>
          <button class="cr-btn" id="cr-export">导出该月统计</button>
          <button class="cr-btn primary" id="cr-add">＋ 新增上课记录</button>
        </div>
      </div>

      <section class="cr-kpi-section">
        <div class="cr-section-head">
          <div>
            <div class="cr-section-title">月度课程概况</div>
            <div class="cr-section-note" id="cr-month-summary">按上课类型统计，方便月底核对总课时</div>
          </div>
          <span class="cr-section-hint" id="cr-month-fee">课时费合计 ¥0</span>
        </div>
        <div class="cr-kpi-grid">
          <div class="cr-kpi-card total"><div class="cr-kpi-label">当月上课总次数</div><div class="cr-kpi-number" id="cr-month-total">0</div><div class="cr-kpi-foot">当月登记的全部课程</div></div>
          <div class="cr-kpi-card normal"><div class="cr-kpi-label">正常上课</div><div class="cr-kpi-number" id="cr-month-normal">0</div><div class="cr-kpi-foot">本人正常授课记录</div></div>
          <div class="cr-kpi-card i-substitute"><div class="cr-kpi-label">我代别人上课</div><div class="cr-kpi-number" id="cr-month-isub">0</div><div class="cr-kpi-foot">替其他老师上的课</div></div>
          <div class="cr-kpi-card substituted"><div class="cr-kpi-label">别人代我上课</div><div class="cr-kpi-number" id="cr-month-subme">0</div><div class="cr-kpi-foot">请其他老师代的课</div></div>
          <div class="cr-kpi-card swap"><div class="cr-kpi-label">换课</div><div class="cr-kpi-number" id="cr-month-swap">0</div><div class="cr-kpi-foot">课程调整与换课记录</div></div>
        </div>
      </section>

      <section class="cr-records-section">
        <div class="cr-records-head">
          <div><h3>我的上课记录</h3><p>按月份查看，列表顺序与新增表单保持一致</p></div>
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
            <thead><tr><th>上课日期</th><th>上课年级</th><th>上课班级</th><th>节次</th><th>学科</th><th>上课类型</th><th>上课人</th><th>代课人</th><th>课时费（元）</th><th>支付状态</th><th>备注说明</th><th>操作</th></tr></thead>
            <tbody id="cr-record-tbody"><tr><td colspan="12"><div class="cr-empty-state">正在加载上课记录…</div></td></tr></tbody>
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
  const quick = q('#cr-month-quick');
  quick.innerHTML = '<option value="">最近一年…</option>' + recentMonths().map((m) => '<option value="' + m + '">' + monthLabel(m) + '</option>').join('');

  const load = async () => {
    rows = await api.get('/class_records').catch((e) => { toast(e.message || '上课记录加载失败', 'err'); return []; });
    rows = Array.isArray(rows) ? rows : [];
    paint();
  };

  const setMonth = (next) => {
    if (!parseMonth(next)) return;
    month = next;
    page = 1;
    paint();
  };

  const paint = () => {
    const monthRows = rows.filter((r) => rowMonth(r) === month);
    q('#cr-month-pick').textContent = monthLabel(month);
    q('#cr-month-input').value = month;
    quick.value = recentMonths().includes(month) ? month : '';
    q('#cr-month-summary').textContent = monthLabel(month) + ' · 按上课类型统计，方便月底核对总课时';
    q('#cr-month-total').textContent = monthRows.length;
    q('#cr-month-normal').textContent = monthRows.filter((r) => r.class_type === 'normal').length;
    q('#cr-month-isub').textContent = monthRows.filter((r) => r.class_type === 'i_substitute').length;
    q('#cr-month-subme').textContent = monthRows.filter((r) => r.class_type === 'substituted_for_me').length;
    q('#cr-month-swap').textContent = monthRows.filter((r) => r.class_type === 'swap').length;
    const fee = monthRows.reduce((sum, r) => sum + (Number(r.amount) || 0), 0);
    q('#cr-month-fee').textContent = '课时费合计 ¥' + money(fee);
    q('#cr-export').textContent = '导出' + monthLabel(month) + '统计';

    const updateOptions = (selector, label, values) => {
      const select = q(selector);
      const current = select.value;
      select.innerHTML = '<option value="">' + esc(label) + '</option>' + values.map((value) => '<option value="' + esc(value) + '">' + esc(value) + '</option>').join('');
      if (values.includes(current)) select.value = current;
    };
    updateOptions('#cr-filter-subject', '全部学科', [...new Set(rows.map((r) => String(r.subject || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')));
    updateOptions('#cr-filter-class', '全部年级班级', [...new Set(rows.map((r) => String(r.class_name || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')));

    const subject = q('#cr-filter-subject').value;
    const className = q('#cr-filter-class').value;
    const type = q('#cr-filter-type').value;
    const keyword = q('#cr-search').value.trim().toLowerCase();
    const filtered = rows.filter((r) => {
      if (rowMonth(r) !== month) return false;
      if (subject && r.subject !== subject) return false;
      if (className && r.class_name !== className) return false;
      if (type && r.class_type !== type) return false;
      if (keyword) {
        const people = parseRelatedPeople(r.related_person, r.class_type);
        const haystack = [r.subject, r.grade, r.class_name, r.class_time, r.teacher, people.original_teacher, people.substitute_person, r.pay_status, r.remark].join(' ').toLowerCase();
        if (!haystack.includes(keyword)) return false;
      }
      return true;
    }).sort((a, b) => rowSortValue(b) - rowSortValue(a));

    const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
    page = Math.min(page, pageCount);
    const visible = filtered.slice((page - 1) * pageSize, page * pageSize);
    q('#cr-record-count').textContent = '共 ' + filtered.length + ' 条记录';
    q('#cr-page-info').textContent = filtered.length ? monthLabel(month) + '共 ' + filtered.length + ' 条记录' : '暂无记录';
    q('#cr-page-number').textContent = page;
    q('#cr-page-prev').disabled = page <= 1;
    q('#cr-page-next').disabled = page >= pageCount;

    const body = q('#cr-record-tbody');
    if (!filtered.length) {
      const message = rows.length ? monthLabel(month) + '没有符合条件的记录' : '还没有上课记录';
      const hint = rows.length ? '可以切换月份查看其它记录，或重置筛选条件。' : '点击右上角「新增上课记录」，开始登记授课、代课和换课情况。';
      body.innerHTML = '<tr><td colspan="12"><div class="cr-empty-state"><div class="cr-empty-icon">＋</div><b>' + message + '</b><span>' + hint + '</span></div></td></tr>';
      return;
    }

    body.innerHTML = visible.map((r) => {
      const typeLabel = TYPE_LABEL[r.class_type] || r.class_type || '未分类';
      const people = parseRelatedPeople(r.related_person, r.class_type);
      const classTime = splitClassTime(r.class_time);
      const status = r.pay_status || (r.class_type === 'swap' ? '无需支付' : '未填写');
      const amount = r.amount == null || r.amount === '' ? '—' : money(r.amount);
      const remark = String(r.remark || '');
      return '<tr>' +
        '<td>' + esc(classTime.date || '—') + '</td>' +
        '<td>' + esc(r.grade || '—') + '</td>' +
        '<td>' + esc(r.class_name || '—') + '</td>' +
        '<td>' + esc(classTime.period || '—') + '</td>' +
        '<td>' + esc(r.subject || '—') + '</td>' +
        '<td><span class="cr-type-badge ' + typeBadgeClass(r.class_type) + '">' + esc(typeLabel) + '</span></td>' +
        '<td>' + esc(r.teacher || people.original_teacher || '—') + '</td>' +
        '<td>' + esc(people.substitute_person || '—') + '</td>' +
        '<td>' + esc(amount) + '</td>' +
        '<td><span class="cr-status ' + statusClass(status) + '" title="' + esc(status) + '">' + esc(status) + '</span></td>' +
        '<td title="' + esc(remark) + '">' + esc(clip(remark) || '—') + '</td>' +
        '<td><div class="cr-row-actions"><button class="cr-row-action" data-view="' + esc(r.id) + '">查看</button><button class="cr-row-action" data-edit="' + esc(r.id) + '">编辑</button><button class="cr-row-action danger" data-delete="' + esc(r.id) + '">删除</button></div></td>' +
      '</tr>';
    }).join('');

    body.querySelectorAll('[data-view]').forEach((b) => { b.onclick = () => openViewer(rows.find((r) => String(r.id) === b.dataset.view)); });
    body.querySelectorAll('[data-edit]').forEach((b) => { b.onclick = () => openEditor(rows.find((r) => String(r.id) === b.dataset.edit)); });
    body.querySelectorAll('[data-delete]').forEach((b) => { b.onclick = () => removeRow(b.dataset.delete); });
  };

  /* 查看：只读详情页，和编辑表单是两个独立页面。 */
  const openViewer = (row) => {
    if (!row) return;
    const classTime = splitClassTime(row.class_time);
    const people = parseRelatedPeople(row.related_person, row.class_type);
    const fields = [
      ['上课日期', classTime.date],
      ['上课年级', row.grade],
      ['上课班级', row.class_name],
      ['节次', classTime.period],
      ['学科', row.subject],
      ['上课类型', TYPE_LABEL[row.class_type] || row.class_type],
      ['上课人', row.teacher || people.original_teacher],
      ['代课人', people.substitute_person],
      ['课时费（元）', row.amount == null || row.amount === '' ? '' : money(row.amount)],
      ['支付状态', row.pay_status],
      ['备注说明', row.remark, 'full'],
    ];
    const form = el('<div class="cr-editor cr-viewer"><div class="cr-viewer-grid">' +
      fields.map(([label, value, span]) => '<div class="cr-viewer-item' + (span ? ' ' + span : '') + '"><span>' + esc(label) + '</span><strong>' + esc(value || '—') + '</strong></div>').join('') +
      '</div><div class="cr-form-foot"><button class="cr-btn primary" id="cr-view-close" type="button">关闭</button></div></div>');
    const sh = sheet({ title: '查看上课记录', body: form, cls: 'cr-record-drawer' });
    sh.wrap.classList.add('cr-record-drawer-mask');
    form.querySelector('#cr-view-close').onclick = () => sh.close();
  };

  const openEditor = (row = null) => {
    const editing = !!row;
    const initialType = row?.class_type || 'normal';
    const initialTime = splitClassTime(row?.class_time);
    const initialPeople = parseRelatedPeople(row?.related_person, initialType);
    const form = el(`<div class="cr-editor">
      <div class="cr-form-grid">
        <div class="cr-field"><label>上课日期 <span class="cr-required">*</span></label><input id="cr-date" type="date" value="${esc(initialTime.date)}"></div>
        <div class="cr-field"><label>上课年级 <span class="cr-required">*</span></label><input id="cr-grade" list="cr-grade-options" value="${esc(row?.grade || '')}" placeholder="如：高一 / 高二 / 高三"><datalist id="cr-grade-options">${GRADE_OPTIONS.map((g) => '<option value="' + g + '"></option>').join('')}</datalist></div>
        <div class="cr-field"><label>上课班级 <span class="cr-required">*</span></label><input id="cr-class" value="${esc(row?.class_name || '')}" placeholder="如：高二11班"></div>
        <div class="cr-field"><label>节次</label><input id="cr-period" list="cr-period-options" value="${esc(initialTime.period)}" placeholder="选择课表节次或手动输入"><datalist id="cr-period-options"></datalist></div>
        <div class="cr-field"><label>学科</label><input id="cr-subject" value="${esc(row?.subject || '')}" placeholder="例如：信息技术、语文"></div>
        <div class="cr-field"><label>上课类型</label><select id="cr-type">${TYPES.map(([v, t]) => `<option value="${v}" ${initialType === v ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
        <div class="cr-field"><label>上课人</label><input id="cr-teacher" value="${esc(row?.teacher || initialPeople.original_teacher || '')}" placeholder="填写实际授课老师"></div>
        <div class="cr-field"><label>代课人</label><input id="cr-substitute-person" value="${esc(initialPeople.substitute_person)}" placeholder="填写代课老师"></div>
        <div class="cr-field"><label>课时费（元）</label><input id="cr-money" type="number" min="0" step="0.01" value="${row?.amount ?? ''}" placeholder="请输入金额"></div>
        <div class="cr-field"><label>支付状态</label><input id="cr-status" list="cr-status-options" value="${esc(row?.pay_status || '')}" placeholder="选择或手动输入支付状态"><datalist id="cr-status-options">${PAY_OPTIONS.map((s) => '<option value="' + s + '"></option>').join('')}</datalist></div>
      </div>
      <div class="cr-field" style="margin-top:14px"><label>备注说明</label><textarea id="cr-remark" placeholder="换课说明、特殊情况备注等">${esc(row?.remark || '')}</textarea></div>
      <div class="cr-form-foot"><button class="cr-btn" id="cr-cancel" type="button">关闭</button><button class="cr-btn primary" id="cr-save" type="button">${editing ? '保存修改' : '保存记录'}</button></div>
    </div>`);
    const sh = sheet({ title: editing ? '编辑上课记录' : '新增上课记录', body: form, cls: 'cr-record-drawer' });
    sh.wrap.classList.add('cr-record-drawer-mask');
    const type = form.querySelector('#cr-type');
    const moneyInput = form.querySelector('#cr-money');
    const statusInput = form.querySelector('#cr-status');
    form.querySelector('#cr-cancel').onclick = () => sh.close();

    /* 只在切换上课类型（或新建）时自动带出默认值，用户手改后不会被覆盖。 */
    const applyTypeDefaults = () => {
      const preset = TYPE_DEFAULTS[type.value] || TYPE_DEFAULTS.normal;
      moneyInput.value = String(preset.amount);
      statusInput.value = preset.status;
    };
    type.onchange = applyTypeDefaults;
    if (!editing || (row.amount == null && !row.pay_status)) applyTypeDefaults();

    /* 时间不再单独显示，但节次仍按课表自动带出，保持 class_time 与历史数据兼容。 */
    let autoTime = initialTime.time;
    const periodInput = form.querySelector('#cr-period');
    let timetableOptions = [];
    const fillTime = () => {
      const matches = timetableOptions.filter((option) => option.name === periodInput.value);
      const times = [...new Set(matches.map((option) => option.time).filter(Boolean))];
      if (times.length === 1) autoTime = times[0];
    };
    periodInput.addEventListener('input', fillTime);
    const parseSettings = (value) => {
      if (value && typeof value === 'object') return value;
      try { return JSON.parse(value || '{}'); } catch { return {}; }
    };
    Promise.all([api.get('/periods'), api.get('/courses'), api.get('/me')]).then(([periods, courses, me]) => {
      if (!form.isConnected) return;
      const preference = parseSettings(localStorage.getItem('wb_timetable_view_v1'));
      const scheduleType = preference.type === '冬令时课表' ? '冬令时课表' : '夏令时课表';
      const timetable = parseSettings(parseSettings(me?.settings).timetable);
      const periodTimes = parseSettings(timetable.periodTimes);
      const configured = Array.isArray(periods) ? periods : [];
      const normalized = normalizeTimetablePeriods(configured, { periodTimes, scheduleType });
      timetableOptions = normalized.map((period) => {
        const override = periodTimes[scheduleType]?.[String(period.period_no)] || {};
        const start = cleanPeriodTime(override.start_time) || cleanPeriodTime(period.start_time);
        const end = cleanPeriodTime(override.end_time) || cleanPeriodTime(period.end_time);
        return { name: period.name || '第' + period.period_no + '节', time: start && end ? start + '-' + end : '' };
      });
      form.querySelector('#cr-period-options').innerHTML = [...new Set(timetableOptions.map((option) => option.name))].map((name) => `<option value="${esc(name)}"></option>`).join('');
      fillTime();
    }).catch(() => { if (form.isConnected) toast('课表加载失败，仍可手动填写节次', 'warn'); });

    saving(form.querySelector('#cr-save'), async () => {
      const date = form.querySelector('#cr-date').value;
      const grade = form.querySelector('#cr-grade').value.trim();
      const className = form.querySelector('#cr-class').value.trim();
      if (!date) throw new Error('请填写上课日期');
      if (!grade) throw new Error('请填写上课年级');
      if (!className) throw new Error('请填写上课班级');
      const classTime = joinClassTime(date, periodInput.value, autoTime);
      const data = {
        class_type: type.value || 'normal',
        subject: form.querySelector('#cr-subject').value.trim(),
        class_name: className,
        grade: grade || null,
        teacher: form.querySelector('#cr-teacher').value.trim() || null,
        class_time: classTime || null,
        related_person: packRelatedPeople(form.querySelector('#cr-substitute-person').value, '', ''),
        amount: moneyInput.value === '' ? null : Number(moneyInput.value),
        pay_time: null,
        pay_status: statusInput.value.trim() || null,
        remark: form.querySelector('#cr-remark').value.trim() || null,
        class_month: parseMonth(date),
      };
      if (editing) await api.patch('/class_records/' + row.id, data);
      else await api.post('/class_records', data);
      sh.close();
      toast(editing ? '上课记录已更新' : '上课记录已新增');
      month = data.class_month || month;
      await load();
    });
  };

  const removeRow = async (id) => {
    const row = rows.find((r) => String(r.id) === String(id));
    if (!row) return;
    const ok = await confirmDialog(`确定删除「${row.subject} · ${row.class_name || '未填写班级'}」这条上课记录吗？`, { title: '删除上课记录', okText: '确认删除', danger: true });
    if (!ok) return;
    await api.del('/class_records/' + id);
    toast('已删除');
    await load();
  };

  const exportMonth = () => {
    const list = rows.filter((r) => rowMonth(r) === month);
    const data = list.map((r) => {
      const classTime = splitClassTime(r.class_time);
      const people = parseRelatedPeople(r.related_person, r.class_type);
      return [
        classTime.date, r.grade, r.class_name, classTime.period, r.subject,
        TYPE_LABEL[r.class_type] || r.class_type,
        r.teacher || people.original_teacher, people.substitute_person,
        r.amount, r.pay_status, r.remark,
      ];
    });
    const csv = '\ufeff' + [COLUMNS, ...data].map((row) => row.map(escapeCsv).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    download(url, '上课记录统计_' + month + '.csv');
    URL.revokeObjectURL(url);
    toast('已导出' + month + '共' + list.length + '条记录');
  };

  q('#cr-month-prev').onclick = () => setMonth(monthShift(month, -1));
  q('#cr-month-next').onclick = () => setMonth(monthShift(month, 1));
  q('#cr-month-today').onclick = () => setMonth(currentMonthKey());
  q('#cr-month-pick').onclick = () => {
    const input = q('#cr-month-input');
    if (typeof input.showPicker === 'function') input.showPicker();
    else input.focus();
  };
  q('#cr-month-input').onchange = (e) => setMonth(e.target.value);
  quick.onchange = () => { if (quick.value) setMonth(quick.value); };
  ['#cr-filter-subject', '#cr-filter-class', '#cr-filter-type'].forEach((selector) => { q(selector).onchange = () => { page = 1; paint(); }; });
  q('#cr-search').oninput = () => { page = 1; paint(); };
  q('#cr-filter-reset').onclick = () => { q('#cr-filter-subject').value = ''; q('#cr-filter-class').value = ''; q('#cr-filter-type').value = ''; q('#cr-search').value = ''; page = 1; paint(); };
  q('#cr-page-size').onchange = () => { pageSize = Number(q('#cr-page-size').value) || 10; page = 1; paint(); };
  q('#cr-page-prev').onclick = () => { page = Math.max(1, page - 1); paint(); };
  q('#cr-page-next').onclick = () => { page += 1; paint(); };
  q('#cr-add').onclick = () => openEditor();
  q('#cr-export').onclick = exportMonth;
  await load();
}
