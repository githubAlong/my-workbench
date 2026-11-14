import { api, el, esc, clsName, startPoll, toast, sheet, saving, confirmDialog, promptDialog, ymd, pad2, WD_SHORT, fmtDateTime, fmtTime, parseDT, exportUrl, download, doExport, STATIC, studentUrl, shortPath } from './core.js';
import { printStatement } from './pdfprint.js';
import { registerView, state, icon, go, pageHead, onViewLeave } from './ui.js';
import { renderAttendance } from './attendance.js';
import { renderAttendancePRD } from './attendance-prd.js';
import { renderTimetable as renderMyTimetable } from './timetable.js';
import { detectTimetable } from './ttimage.js';
import { loginBanner, hookBanner } from './auth.js';
import { renderPreps } from './prep.js';
import { renderTripManagement } from './trips.js';
import { MAX_MATERIAL_SIZE, syncMaterialSharing } from './material-sharing.mjs';

const M = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
/* 备注字段统一生成器。
   用户反馈「备注要重点显示、加个方框，不然不知道能写字」——问题出在各处写法不统一：
   有的用 <input>、有的用 <textarea>，有的没 placeholder，有的连 label 都省了。
   抽成一个函数后，样式和占位文案只需改这里一处，不会再漏。 */
function remarkField({ id = 'remark', value = '', placeholder = '', rows = 0, hint = '' } = {}) {
  /* 默认不写占位文案：预填/预提示的内容如果不符实际，用户还得先删掉，反而更慢。
     需要说明时由调用方显式传 placeholder，没传就不输出这个属性（不留空壳）。 */
  const ph = placeholder ? ` placeholder="${esc(placeholder)}"` : '';
  const tag = rows
    ? `<textarea class="input" id="${id}" rows="${rows}"${ph}>${esc(value)}</textarea>`
    : `<input class="input" id="${id}" value="${esc(value)}"${ph}>`;
  return `<div class="remark-field"><label class="field-label">${icon('edit', 13)} 备注${hint ? `<span class="rf-hint">${esc(hint)}</span>` : ''}</label>${tag}</div>`;
}
const monthLabel = (m) => { const [y, mm] = String(m || '').split('-'); return y ? `${y}年${Number(mm)}月` : '选择月份'; };
function monthShift(m, d) { const [y, mm] = m.split('-').map(Number); const x = new Date(y, mm - 1 + d, 1); return M(x); }

function toolbars(kind, month, extra = '') {
  return `<div class="row wrap" style="gap:8px;margin-bottom:14px">
    ${month !== null ? `<div class="row" style="gap:4px"><button class="icon-btn sm" data-mprev>${icon('left', 16)}</button>
      <button class="btn ghost sm month-btn" data-mpick style="min-width:112px;justify-content:center">${monthLabel(month)}</button>
      <input type="month" id="month-pick" value="${month}" class="month-hidden">
      <button class="icon-btn sm" data-mnext>${icon('right', 16)}</button></div>` : ''}
    ${extra}
    <span style="flex:1"></span>
    <span class="row" style="gap:8px;flex:0 0 auto">
    <button class="btn ghost sm" data-exp="${kind}">${icon('download', 15)} 导出</button>
    <button class="btn ghost sm" data-imp="${kind}">${icon('upload', 15)} 导入</button></span>
  </div>
  <div class="mobile-tip">手机上表格可左右滑动查看，或点任意一条记录打开表单修改</div>`;
}
function bindToolbars(root, ctx, reload) {
  root.querySelector('#month-pick')?.addEventListener('change', (e) => { ctx.month = e.target.value; reload(); });
  const mp = root.querySelector('#month-pick');
  root.querySelector('[data-mpick]')?.addEventListener('click', () => {
    if (mp?.showPicker) { try { mp.showPicker(); return; } catch {} }
    mp?.click();
  });
  root.querySelector('[data-mprev]')?.addEventListener('click', () => { ctx.month = monthShift(ctx.month, -1); reload(); });
  root.querySelector('[data-mnext]')?.addEventListener('click', () => { ctx.month = monthShift(ctx.month, 1); reload(); });
  root.querySelectorAll('[data-exp]').forEach((b) => { b.onclick = () => exportSheet(b.dataset.exp, ctx); });
  root.querySelectorAll('[data-imp]').forEach((b) => { b.onclick = () => importSheet(b.dataset.imp, reload); });
}
export function exportSheet(kind, ctx = {}) {
  const body = el(`<div class="sheet-body">
    <div class="small muted" style="margin-bottom:10px">Excel 可直接打开 CSV；PDF 会打开排版好的打印页，选择“另存为 PDF”即可发给领导。</div>
    <div class="col">
      <button class="btn ghost block" data-f="csv">下载 CSV（Excel 可打开，可继续编辑）</button>
      <button class="btn ghost block" data-f="html">打印 / 导出 PDF（带表头与签字栏）</button>
      <button class="btn ghost block" data-f="json">导出 JSON（用于备份与再导入）</button>
    </div></div>`);
  const s = sheet({ title: '导出数据', body });
  body.querySelectorAll('[data-f]').forEach((b) => {
    b.onclick = () => {
      const f = b.dataset.f;
      const q = { month: kind === 'attendance' ? String(ctx.tableId || '') : (ctx.month || ''), format: f };
      // 静态版没有 /api/export 文件流，改为本地取数后造文件下载
      doExport(kind, { month: q.month, format: f });
      s.close();
    };
  });
}
export function importSheet(kind, reload) {
  const body = el(`<div class="sheet-body">
    <div class="small muted" style="margin-bottom:8px">从 Excel / WPS 选中区域 <b>Ctrl+C</b> 后粘贴到这里（第一行可为表头），或选择文本文件。</div>
    <textarea class="input" id="imp" rows="9"></textarea>
    <div class="row" style="margin-top:10px"><input type="file" id="imp-file" accept=".csv,.txt" class="small"><span style="flex:1"></span>
    <button class="btn ghost" id="imp-cancel">取消</button><button class="btn primary" id="imp-ok">导入</button></div>
  </div>`);
  const s = sheet({ title: '导入数据', body });
  body.querySelector('#imp-cancel').onclick = s.close;
  body.querySelector('#imp-file').onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    body.querySelector('#imp').value = await f.text();
  };
  body.querySelector('#imp-ok').onclick = async () => {
    const text = body.querySelector('#imp').value;
    if (!text.trim()) return toast('请粘贴内容', 'warn');
    try {
      const r = await api.post('/import/' + kind, { text });
      s.close(); toast(`已导入 ${r.imported} 条`); reload();
    } catch (e) { toast(e.message, 'err'); }
  };
}

/* ================= 工作（二级导航分发） ================= */
/* 路由：work/<tab>，tab 取自工作一级目录下的二级导航。 */
registerView(async function work(main, { tab, third }) {
  const t = tab || 'lessons';
  /* 页头标题跟着二级项走：以前所有二级页都顶着「工作」两个字，
     点进「考勤」看到的还是「工作」，会让人怀疑自己点错了。 */
  const meta = {
    lessons: ['上课', '登记正常上课、代课与换课记录'],
    timetable: ['周课表', '一周课程安排、上课时间与班级一目了然'],
    prep: ['备课', '管理备课时间、授课内容与备注，支持按筛选条件批量导入导出'],
    repairs: ['维修记录表', '按月份查看维修记录、处理状态与待跟踪事项'],
    attendance: ['考勤', '按年级分开管：花名册、每日三张表、统计'],
    invigilation: ['监考', '监考场次、时间、补贴，一场不漏'],
    trips: ['出差', '行程、报销记录'],
    notes: ['笔记', '随手记的教学笔记，可搜索、可归档'],
  }[t] || ['工作', ''];

  /* 页头先不放进 main：工作二级页面使用各自的标题，
     先画「课件」再改字符串会闪一下。所以正文容器先给出来，标题由正文渲染完再定。 */
  main.innerHTML = '<div id="work-body"></div>';
  const body = main.querySelector('#work-body');
  const headEl = el(`<div>${pageHead(meta[0], meta[1], '')}</div>`);
  if (t !== 'lessons') main.insertBefore(headEl, body);
  /* 三级页把自己的标题写进 url 的第三段，页头用子项名字，副标题用子项说明 */
  if (t === 'materials' && third) {
    const sub = (NAV.find((n) => n.id === 'work')?.sub || []).find((x) => x.id === 'materials')?.sub || [];
    const node = sub.find((x) => x.id === third);
    if (node) {
      headEl.innerHTML = pageHead(node.label, {
        selfstudy: '学生端「自习」：开一场签到，学生点「我到了」，这里实时看人数',
        textbook: '学生端「教材」：你勾了「学生可见」的资料，就是学生看到的全部',
        pick: '学生端「抽人」：按号码或按名单，抽过的不重复',
        mystery: '学生端「盲盒」：点一下随机弹一个任务，这一轮不重复',
      }[third] || '');
    }
  }
  if (t === 'lessons') { const m = await import('./class-records.js'); return m.renderClassRecords(body); }
  if (t === 'prep') {
    /* 备课页自带「备课管理」标题卡片，外层页头移除，避免同一标题出现两次 */
    headEl.remove();
    return renderPreps(body);
  }
  if (t === 'timetable') { headEl.remove(); return renderMyTimetable(body); }
  if (t === 'attendance') {
    /* 考勤管理两级入口：
       没有年级参数时恢复原有年级总览；选择年级后进入当前考勤工作台。
       中文年级名需要解码，URL 形如 #/work/attendance/高一。 */
    const grade = third ? decodeURIComponent(third) : '';
    if (!grade) {
      headEl.remove();
      return renderAttendance(body);
    }
    /* 工作台自己渲染标题、说明与实时状态，外层页头必须移除，否则同一标题会出现两次 */
    headEl.remove();
    return renderAttendancePRD(body, { grade });
  }
  if (t === 'invigilation') return renderInvigilation(body);
  if (t === 'trips') { headEl.remove(); return renderTripManagement(body); }
  if (t === 'repairs') {
    const m = await import('./repairs.js');
    return m.renderRepairsBody(body);
  }
  if (t === 'notes') {
    /* 笔记页自带「知识库」标题卡片，外层页头移除，避免同一标题出现两次 */
    headEl.remove();
    return renderNotes(body);
  }
  return renderLessons(body);
});

/* ================= 小助手（一级目录，二级功能分发） ================= */
registerView(async function materials(main, { tab }) {
  const t = tab || '';
  const meta = {
    selfstudy: ['自习', '学生端「自习」：开一场签到，学生点「我到了」，这里实时看人数'],
    textbook: ['教材', '学生端「教材」：你勾了「学生可见」的资料，就是学生看到的全部'],
    pick: ['抽人', '学生端「抽人」：按号码或按名单，抽过的不重复'],
    mystery: ['盲盒', '学生端「盲盒」：点一下随机弹一个任务，这一轮不重复'],
  }[t] || ['小助手', '学生端互动工具统一管理：自习、教材、抽人、盲盒'];

  main.innerHTML = '<div id="materials-body"></div>';
  const body = main.querySelector('#materials-body');
  const headEl = el(`<div>${pageHead(meta[0], meta[1], '')}</div>`);
  main.insertBefore(headEl, body);

  if (!t) return renderMaterials(body);
  if (t === 'selfstudy') {
    const m = await import('./selfstudy.js');
    return m.renderSelfstudyBody(body, { studentTab: 'checkin' });
  }
  if (t === 'textbook') return renderStudentModule(body, 'textbook');
  if (t === 'pick') return renderStudentModule(body, 'pick');
  if (t === 'mystery') return renderStudentModule(body, 'mystery');
  return renderMaterials(body);
});

/* ================= 上课（课时统计 & 代课对账） ================= */
const SUB_LABEL = { normal: '本人授课', '替他人上': '替人代课', '他人替我上': '他人代课', '换课': '换课' };
const money = (n) => (Math.round(Number(n || 0) * 100) / 100).toLocaleString('zh-CN');

/* 默认课时单价。用户明确说过「默认 30 元」——之前是 60，
   和实际拿到手的课时费对不上，每次进页面都要手改一遍。
   注意：这里只是「本地还没读到云端设置时」的兜底值，真实值以 settings 为准。 */
const DEFAULT_PRICE = 30;

async function renderLessons(box) {
  let month = M();
  let price = DEFAULT_PRICE;
  let search = '';
  let typeFilter = 'all';
  let page = 1;
  const pageSize = 10;

  const load = async () => {
    const [data, me] = await Promise.all([
      api.get(`/lessons/summary?month=${month}`).catch(() => null),
      api.get('/me').catch(() => null),
    ]);
    /* 读设置时有个坑：/me 返回的是 { user, settings }，settings 在顶层而不是
      在 user 下面。以前写 me?.settings 恰好是对的，但千万别改成 me?.user?.settings。 */
    price = Number(me?.settings?.lesson?.pricePerHour) || DEFAULT_PRICE;
    /* 服务端会算一遍单价并回传 price_per_hour，以它为准。
       两边算法一样（settings → 默认 30），但 server 那份是算金额用的，
       界面显示必须跟算钱的口径完全一致，否则「单价显示 30、金额按 60 算」。 */
    if (data?.price_per_hour != null) price = Number(data.price_per_hour) || DEFAULT_PRICE;
    if (!data) { box.innerHTML = '<div class="empty">加载失败，请刷新重试</div>'; return; }
    const rows = await api.get(`/lessons?month=${month}`).catch(() => []);
    paint(data, rows, me);
  };

  const paint = (data, rows, me) => {
    const s = data.summary;
    const sch = data.scheduled || { total: 0, actual: 0, substitute_out: 0 };
    const net = s.net;
    const netCls = net.direction === 'receivable' ? 'green' : net.direction === 'payable' ? 'amber' : '';
    const netAmount = money(Math.abs(net.amount));
    const pendingPeople = s.people.filter((p) => !p.settled).length;
    const netStatus = pendingPeople
      ? net.direction === 'even' ? '应收应付相抵，仍有待结算' : `${net.direction === 'receivable' ? '待收' : '待付'}`
      : s.people.length ? '已结清' : '暂无待结算';
    const now = new Date();
    const [targetYear, targetMonth] = month.split('-').map(Number);
    const daysInMonth = new Date(targetYear, targetMonth, 0).getDate();
    const currentMonth = M(now);
    const partialDays = Number(data.partial?.passed);
    const elapsedDays = data.partial && Number.isFinite(partialDays)
      ? Math.min(daysInMonth, Math.max(0, partialDays))
      : month < currentMonth ? daysInMonth : month > currentMonth ? 0 : now.getDate();
    const monthProgress = Math.min(100, Math.max(0, Math.round(elapsedDays / daysInMonth * 100)));

    box.innerHTML = `
    <div class="lessons-page">
      ${loginBanner()}
      <div class="ls-toolbar">
        <div class="ls-month-tools">
          <div class="ls-month-picker">
            <button class="icon-btn sm" data-mprev aria-label="上一个月">${icon('left', 16)}</button>
            <button class="btn ghost sm month-btn" data-mpick>${monthLabel(month)}</button>
            <button class="icon-btn sm" data-mnext aria-label="下一个月">${icon('right', 16)}</button>
          </div>
          <button class="btn ghost sm" id="ls-price">${icon('settings', 15)} 单价 ¥${money(price)}/节</button>
        </div>
        <div class="ls-actions">
          <button class="btn ghost" id="ls-pdf">${icon('download', 15)} 导出对账单</button>
          <button class="btn primary" id="ls-add">${icon('plus', 15)} 记一节课</button>
        </div>
      </div>

      <div class="ls-cards">
        <div class="ls-card ls-primary">
          <div class="lc-k">实际授课</div>
          <div class="lc-v">${s.total_hours}<span class="lc-u">节</span></div>
          <div class="lc-s">本月共 ${s.lesson_count} 条记录</div>
        </div>
        <div class="ls-card">
          <div class="lc-k">${icon('arrow-up-right', 13)} 代课应收</div>
          <div class="lc-v green">¥${money(s.sub_out.amount)}</div>
          <div class="lc-s">${s.sub_out.count} 次代课 · ${s.sub_out.hours} 节课时</div>
          <div class="lc-extra">换课 ${s.swap.count} 次 · 仅备查，不计账</div>
        </div>
        <div class="ls-card">
          <div class="lc-k">${icon('arrow-down-left', 13)} 代课应付</div>
          <div class="lc-v amber">¥${money(s.sub_in.amount)}</div>
          <div class="lc-s">${s.sub_in.count} 次被代 · ${s.sub_in.hours} 节课时</div>
        </div>
        <div class="ls-card ls-net-card">
          <div class="lc-k">待结算净额</div>
          <div class="lc-v ${netCls}">¥${netAmount}</div>
          <div class="lc-s">${netStatus}</div>
        </div>
      </div>

      <section class="ls-schedule" aria-label="排课进度">
        <div class="ls-schedule-stat"><span>计划排课</span><b>${sch.total}<small> 节</small></b></div>
        <div class="ls-schedule-stat"><span>已记录课时</span><b>${s.total_hours}<small> 节</small></b></div>
        <div class="ls-progress">
          <div class="ls-progress-label"><span>本月时间进度</span><b>${monthProgress}%</b></div>
          <div class="ls-progress-track"><span style="width:${monthProgress}%"></span></div>
          <div class="ls-progress-note">已过 ${elapsedDays}/${daysInMonth} 天 · 排课按整月课表统计</div>
        </div>
      </section>

      ${s.people.length ? `<div class="card card-pad ls-settle">
        <div class="lss-head">代课结算<span class="lss-head-s">点开可逐节勾选，先结一部分也行</span></div>
        ${s.people.map((p) => `<div class="lss-row${p.settled ? ' done' : ''}${p.partial ? ' part' : ''}" data-person="${esc(p.name)}|${p.direction}">
          <div class="lss-line">
            <div class="lss-main">
              <span class="lss-name">${esc(p.name)}</span>
              <span class="chip ${p.direction === 'out' ? 'green' : 'amber'}">${p.direction === 'out' ? '应收' : '应付'}</span>
              <span class="lss-amt">${p.settled
                ? `${p.count} 节 / ${money(p.amount)} 元`
                : p.partial
                  ? `还剩 ${p.open_hours} 节 / ${money(p.open_amount)} 元<span class="lss-dim">（已结 ${p.settled_count}/${p.count} 节）</span>`
                  : `${p.hours} 节 / ${money(p.amount)} 元`}</span>
              ${p.settled ? '<span class="chip grey">已结清</span>' : p.partial ? '<span class="chip grey">部分结清</span>' : ''}
            </div>
            <div class="lss-btns">
              ${p.settled ? '' : `<button class="btn ghost sm" data-toggle="${esc(p.name)}|${p.direction}">逐节结</button>`}
              <button class="btn ${p.settled ? 'ghost' : 'primary'} sm" data-settle="${esc(p.name)}" data-dir="${p.direction}" data-done="${p.settled ? '1' : ''}">${p.settled ? '撤销结清' : '全部结清'}</button>
            </div>
          </div>
          ${p.open_items.length && !p.settled ? `<div class="lss-items hidden" data-items="${esc(p.name)}|${p.direction}">
            ${p.open_items.map((it) => `<label class="lss-item">
              <input type="checkbox" data-pick="${it.id}" data-name="${esc(p.name)}" data-dir="${p.direction}" data-h="${it.hours}" data-a="${it.amount}">
              <span class="lsi-d">${esc(String(it.date).slice(5))}${it.period_no ? ' 第' + it.period_no + '节' : ''}</span>
              <span class="lsi-c">${esc(it.class_name || '')}</span>
              <span class="lsi-h">${it.hours} 节 / ${money(it.amount)} 元</span>
            </label>`).join('')}
            <div class="lss-pick-bar">
              <span class="lss-pick-sum" data-sum-for="${esc(p.name)}|${p.direction}">未选</span>
              <button class="btn ghost sm" data-checkall="${esc(p.name)}|${p.direction}">全选</button>
              <button class="btn primary sm" data-settlepick="${esc(p.name)}|${p.direction}" disabled>结清选中的</button>
            </div>
          </div>
          ` : ''}
        </div>`).join('')}
      </div>` : ''}

      <section class="ls-records">
        <div class="ls-records-head">
          <div><h2>本月明细</h2><span class="ls-records-hint">${monthLabel(month)} · 可搜索内容、班级或代课人</span></div>
          <div class="ls-filters">
            <label class="ls-search">${icon('search', 16)}<input type="search" id="ls-search" placeholder="搜索班级、内容或代课人" aria-label="搜索上课记录"></label>
            <select id="ls-type-filter" aria-label="按授课类型筛选">
              <option value="all">全部类型</option><option value="normal">本人授课</option>
              <option value="替他人上">替人代课</option><option value="他人替我上">他人代课</option><option value="换课">换课</option>
            </select>
          </div>
        </div>
        <div class="table-wrap"><table class="tbl tbl-lesson">
          <thead><tr><th style="width:138px">日期／节次</th><th style="width:132px">班级</th><th>教学内容与下次计划</th><th style="width:110px">进度</th><th style="width:130px">授课类型</th><th style="width:72px">课时</th><th class="th-ops" style="width:116px">操作</th></tr></thead>
          <tbody id="ls-tbody"></tbody>
        </table></div>
        <div class="ls-records-foot"><span id="ls-record-count"></span><div id="ls-pagination" class="ls-pagination"></div></div>
      </section>
    </div>`;

    // 月份切换
    hookBanner(box);
    box.querySelector('[data-mprev]').onclick = () => { month = monthShift(month, -1); load(); };
    box.querySelector('[data-mnext]').onclick = () => { month = monthShift(month, 1); load(); };
    box.querySelector('[data-mpick]').onclick = () => pickMonth(month, (m) => { month = m; load(); });
    box.querySelector('#ls-add').onclick = () => lessonEditor(null, load, month, price);
    box.querySelector('#ls-price').onclick = () => priceDialog(price, load);
    box.querySelector('#ls-pdf').onclick = () => exportStatement(month, box.querySelector('#ls-pdf'));
    const tbody = box.querySelector('#ls-tbody');
    const countEl = box.querySelector('#ls-record-count');
    const pagination = box.querySelector('#ls-pagination');
    const renderRows = () => {
      const needle = search.trim().toLocaleLowerCase();
      const filtered = rows.filter((r) => {
        const type = r.sub_type || 'normal';
        if (typeFilter !== 'all' && type !== typeFilter) return false;
        if (!needle) return true;
        return [r.class_name, r.content, r.next_content, r.progress, r.peer_name, r.remark]
          .some((value) => String(value || '').toLocaleLowerCase().includes(needle));
      });
      const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
      page = Math.min(page, pageCount);
      const shown = filtered.slice((page - 1) * pageSize, page * pageSize);
      tbody.innerHTML = shown.length ? shown.map((r) => {
        const type = r.sub_type || 'normal';
        const typeClass = type === '替他人上' ? 'green' : type === '他人替我上' ? 'amber' : type === '换课' ? 'purple' : 'blue';
        const typeLabel = SUB_LABEL[type] || type;
        return `<tr data-row="${esc(String(r.id))}">
          <td class="ls-date"><b>${esc(String(r.date).slice(5))}</b><span>${r.period_no ? '第' + r.period_no + '节' : '未排节次'}${r.start_time ? ' · ' + esc(r.start_time) : ''}</span></td>
          <td class="ls-class">${esc(r.class_name || '—')}</td>
          <td class="lc-content">${esc(r.content || '—')}${r.next_content ? `<div class="lc-next">下次：${esc(r.next_content)}</div>` : ''}${r.discipline ? `<div class="tiny" style="color:var(--amber)">⚠ ${esc(r.discipline)}</div>` : ''}${r.remark ? `<div class="lc-remark">${icon('edit', 11)}<span>${esc(r.remark)}</span></div>` : ''}</td>
          <td class="ls-progress-cell">${esc(r.progress || '—')}</td>
          <td class="ls-type-cell"><span class="chip ${typeClass}">${esc(typeLabel)}</span>${type !== 'normal' && r.peer_name ? `<span class="ls-peer">${esc(r.peer_name)}</span>` : ''}</td>
          <td class="num">${esc(String(r.hours ?? 0))}</td>
          <td class="td-ops">
            <button class="btn ghost sm ls-edit" data-edit="${esc(String(r.id))}">编辑</button>
            <details class="ls-more"><summary aria-label="更多操作">${icon('more', 16)}</summary>
              <button class="ls-delete" data-del-lesson="${esc(String(r.id))}">删除记录</button>
            </details>
          </td>
        </tr>`;
      }).join('') : `<tr class="ls-empty-row"><td colspan="7"><div class="ls-empty">
        <strong>${rows.length ? '没有符合条件的记录' : `${monthLabel(month)}还没有上课记录`}</strong>
        ${rows.length ? '<span>试试调整搜索词或筛选条件</span>' : '<button class="btn primary" data-empty-add>' + icon('plus', 15) + ' 记第一节课</button>'}
      </div></td></tr>`;
      countEl.textContent = filtered.length === rows.length
        ? `共 ${rows.length} 条记录`
        : `显示 ${filtered.length} 条 / 共 ${rows.length} 条记录`;
      pagination.innerHTML = filtered.length > pageSize
        ? `<button class="btn ghost sm" data-page-prev ${page === 1 ? 'disabled' : ''}>上一页</button><span>第 ${page} / ${pageCount} 页</span><button class="btn ghost sm" data-page-next ${page === pageCount ? 'disabled' : ''}>下一页</button>`
        : '';
      pagination.querySelector('[data-page-prev]')?.addEventListener('click', () => { page -= 1; renderRows(); });
      pagination.querySelector('[data-page-next]')?.addEventListener('click', () => { page += 1; renderRows(); });
    };
    box.querySelector('#ls-search').addEventListener('input', (e) => { search = e.target.value; page = 1; renderRows(); });
    box.querySelector('#ls-type-filter').addEventListener('change', (e) => { typeFilter = e.target.value; page = 1; renderRows(); });
    tbody.onclick = async (e) => {
      const target = e.target.closest('[data-edit], [data-del-lesson], [data-empty-add]');
      if (target) {
        e.stopPropagation();
        if (target.hasAttribute('data-empty-add')) return lessonEditor(null, load, month, price);
        if (target.hasAttribute('data-edit')) {
          return lessonEditor(rows.find((r) => String(r.id) === target.dataset.edit), load, month, price);
        }
        const r = rows.find((item) => String(item.id) === target.dataset.delLesson);
        if (!r) return;
        if (!(await confirmDialog(`删除 ${String(r.date).slice(5)} ${r.class_name || ''} 第${r.period_no || '?'}节这节课？`, { danger: true, okText: '删除' }))) return;
        try { await api.del('/lessons/' + r.id); toast('已删除'); load(); }
        catch (err) { toast(err.message || '删除失败', 'err'); }
        return;
      }
      if (e.target.closest('details')) return;
      const tr = e.target.closest('[data-row]');
      if (tr) lessonEditor(rows.find((r) => String(r.id) === tr.dataset.row), load, month, price);
    };
    renderRows();
    // 全部结清 / 撤销整人结清
    box.querySelectorAll('[data-settle]').forEach((b) => {
      b.onclick = async (e) => {
        e.stopPropagation();
        const { settle: name, dir, done } = b.dataset;
        const act = done ? 'unsettle' : 'settle';
        try {
          await api.post(`/lessons/${act}`, { month, name, direction: dir });
          toast(done ? '已撤销结清' : `已把 ${name} 本月全部结清`);
          load();
        } catch (err) { toast(err.message || '操作失败', 'err'); }
      };
    });

    // 展开 / 收起某人的逐节明细
    box.querySelectorAll('[data-toggle]').forEach((b) => {
      b.onclick = (e) => {
        e.stopPropagation();
        const key = b.dataset.toggle;
        const panel = box.querySelector(`[data-items="${CSS.escape(key)}"]`);
        if (!panel) return;
        const open = !panel.classList.toggle('hidden');   // toggle 返回「是否还隐藏」
        b.textContent = open ? '收起' : '逐节结';
        b.classList.toggle('on', open);
      };
    });

    // 勾选后实时汇总 + 启用按钮
    const refreshPick = (key) => {
      const panel = box.querySelector(`[data-items="${CSS.escape(key)}"]`);
      if (!panel) return;
      const picks = [...panel.querySelectorAll('[data-pick]:checked')];
      const h = picks.reduce((a, x) => a + Number(x.dataset.h || 0), 0);
      const sum = picks.reduce((a, x) => a + Number(x.dataset.a || 0), 0);
      const sumEl = panel.querySelector('[data-sum-for]');
      const btn = panel.querySelector('[data-settlepick]');
      if (sumEl) sumEl.innerHTML = picks.length ? `已选 <b>${Math.round(h * 10) / 10}</b> 节 / <b>${money(sum)}</b> 元` : '未选';
      if (btn) { btn.disabled = !picks.length; btn.textContent = picks.length ? `结清选中的 ${picks.length} 节` : '结清选中的'; }
    };
    box.querySelectorAll('[data-pick]').forEach((ck) => {
      ck.onchange = () => refreshPick(ck.dataset.name + '|' + ck.dataset.dir);
    });
    box.querySelectorAll('[data-checkall]').forEach((b) => {
      b.onclick = (e) => {
        e.stopPropagation();
        const key = b.dataset.checkall;
        const panel = box.querySelector(`[data-items="${CSS.escape(key)}"]`);
        const all = [...panel.querySelectorAll('[data-pick]')];
        const target = !all.every((x) => x.checked);
        all.forEach((x) => { x.checked = target; });
        b.textContent = target ? '取消全选' : '全选';
        refreshPick(key);
      };
    });

    // 只结选中的那几条
    box.querySelectorAll('[data-settlepick]').forEach((b) => {
      b.onclick = async (e) => {
        e.stopPropagation();
        const key = b.dataset.settlepick;
        const [name, dir] = key.split('|');
        const panel = box.querySelector(`[data-items="${CSS.escape(key)}"]`);
        const ids = [...panel.querySelectorAll('[data-pick]:checked')].map((x) => Number(x.dataset.pick));
        if (!ids.length) return;
        b.disabled = true;
        try {
          const r = await api.post('/lessons/settle', { month, name, direction: dir, ids });
          toast(`已结清 ${r.settled} 节`);
          load();
        } catch (err) { b.disabled = false; toast(err.message || '操作失败', 'err'); }
      };
    });
  };

  await load();
}

/* 月份选择器 */
function pickMonth(cur, cb) {
  const body = el(`<div class="sheet-body">
    <div class="field"><label class="field-label">选择月份</label><input class="input" type="month" id="pm" value="${cur}"></div>
    <div class="confirm-actions"><button class="btn ghost" id="c">取消</button><button class="btn primary" id="ok">确定</button></div>
  </div>`);
  const s = sheet({ title: '查看哪个月', body });
  body.querySelector('#c').onclick = s.close;
  body.querySelector('#ok').onclick = () => { const v = body.querySelector('#pm').value; s.close(); if (v) cb(v); };
}

/* 单价设置 */
function priceDialog(cur, reload) {
  const body = el(`<div class="sheet-body">
    <div class="field"><label class="field-label">每节课时单价（元）</label>
      <input class="input" id="pp" type="number" min="0" step="5" value="${cur}"></div>
    <div class="tiny muted" style="margin:-4px 0 10px">改单价不会追溯已有记录，已算进账的金额保持原样。</div>
    <div class="confirm-actions"><button class="btn ghost" id="c">取消</button><button class="btn primary" id="ok">保存</button></div>
  </div>`);
  const s = sheet({ title: '课时单价', body });
  body.querySelector('#c').onclick = s.close;
  body.querySelector('#ok').onclick = async () => {
    const v = Number(body.querySelector('#pp').value);
    if (!Number.isFinite(v) || v < 0) return toast('请输入有效金额', 'warn');
    try {
      let st = { lesson: { pricePerHour: v } };
      try {
        const me = await api.get('/me');
        st = { ...(me.settings || {}), lesson: { ...(me.settings?.lesson || {}), pricePerHour: v } };
      } catch { /* 读不到旧设置就从空开始，不阻断保存 */ }
      await api.patch('/me', { settings: st });
      s.close(); toast('单价已更新'); reload();
    } catch (e) { toast(e.message || '保存失败', 'err'); }
  };
}

/* 导出竖版 A4 对账单 */
async function exportStatement(month, btn) {
  const old = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.innerHTML = '生成中…'; }
  toast('正在生成对账单…');
  try {
    /* 静态版：服务端 Python 渲染改成浏览器排版 + 打印（选「另存为 PDF」即得文件） */
    const r = await api.get('/lessons/statement', { month });
    const [yy, mm2] = month.split('-').map(Number);
    const refresh = await api.get('/lessons/summary', { month });
    printStatement({
      month_label: monthLabel(month),
      teacher: r.summary ? (state?.user?.nickname || '') : '',
      school: state?.user?.school || '',
      subject: state?.user?.subject || '',
      created: new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }),
      price: r.price,
      scheduled: refresh?.scheduled || { total: 0 },
      summary: r.summary,
      people: (r.summary?.people || []).map((p) => ({
        name: p.name, direction: p.direction, hours: p.hours, amount: p.amount, settled: p.settled,
      })),
      rows: (r.rows || []).map((x) => ({
        date: x.date, period: x.period_no ? '第' + x.period_no + '节' : '',
        class_name: x.class_name, subject: x.subject, content: x.content,
        hours: x.hours, sub_type: x.sub_type || 'normal', peer_name: x.peer_name || '',
      })),
    });
    void yy; void mm2;
    toast('已打开打印预览，选「另存为 PDF」即可');
  } catch (e) {
    toast(e.message || '生成失败', 'err');
  } finally {
    if (btn && btn.isConnected) { btn.disabled = false; btn.innerHTML = old; }
  }
}

const one_period = (periods, no) => (periods || []).find((p) => Number(p.period_no) === Number(no));

async function lessonEditor(row, reload, month, price = DEFAULT_PRICE) {
  const isNew = !row;
  const [courses, periods, tRes] = await Promise.all([
    api.get('/courses').catch(() => []),
    api.get('/periods').catch(() => []),
    api.get('/teachers').catch(() => null),
  ]);
  const teachers = Array.isArray(tRes) ? tRes : (tRes?.list || []);
  if (row && !row.start_time) {
    const per = one_period(periods, row.period_no);
    if (per) row = { ...row, start_time: per.start_time, end_time: per.end_time };
  }
  const today = ymd(new Date());
  const curType = row?.sub_type || 'normal';
  const todayWd = new Date(today + 'T00:00').getDay();
  // 一键带出用的课：优先今天的，今天没课就取下一个有课的日子（周末备课时也能用）
  const groupByWd = (wd) => courses.filter((c) => Number(c.weekday) === wd)
    .sort((a, b) => Number(a.period_no) - Number(b.period_no));
  let pickWd = todayWd; let pickCourses = groupByWd(todayWd); let pickOffset = 0;
  if (!pickCourses.length) {
    for (let i = 1; i <= 7; i++) {
      const wd = (todayWd + i) % 7;
      const list = groupByWd(wd);
      if (list.length) { pickWd = wd; pickCourses = list; pickOffset = i; break; }
    }
  }
  const todayCourses = pickCourses;
  const pickDay = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][pickWd];
  const pickLabel = pickOffset === 0 ? '今天的课' : `${pickDay}的课`;
  const pickHint = pickOffset === 0
    ? '点一下自动填好班级、节次、时间'
    : `今天没课 · 点一下会把日期改到${pickDay}，并填好班级、节次、时间`;

  const body = el(`<div class="sheet-body">
    ${isNew && todayCourses.length ? `<div class="le-pick">
      <div class="le-pick-h">${pickLabel} <span class="le-pick-s">${pickHint}</span></div>
      <div class="le-pick-list">${todayCourses.map((c, i) => `<button class="le-pick-i" data-ci="${i}">
        <span class="lpi-p">第${c.period_no}节</span>
        <span class="lpi-c">${esc(c.class_name || '')}</span>
        <span class="lpi-t">${esc(c.start_time || '')}</span>
      </button>`).join('')}</div>
    </div>` : ''}

    <div class="form-grid">
      <div class="field"><label class="field-label">日期</label><input class="input" type="date" id="date" value="${esc(row?.date || today)}"></div>
      <div class="field"><label class="field-label">节次</label><select class="input" id="period">${[1,2,3,4,5,6,7,8,9,10].map((n) => `<option ${row?.period_no === n ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
      <div class="field"><label class="field-label">班级</label><input class="input" id="class" value="${esc(row?.class_name || '')}"></div>
      <div class="field"><label class="field-label">科目</label><input class="input" id="subject" value="${esc(row?.subject || '')}"></div>
      <div class="field"><label class="field-label">开始时间</label><input class="input" type="time" id="st" value="${esc(row?.start_time || '')}"></div>
      <div class="field"><label class="field-label">结束时间</label><input class="input" type="time" id="et" value="${esc(row?.end_time || '')}"></div>
    </div>

    <div class="field" style="margin-top:4px">
      <label class="field-label">这节课谁上的</label>
      <div class="le-seg" id="le-seg">
        ${[['normal', '正常上课'], ['替他人上', '我代别人上'], ['他人替我上', '别人代我上'], ['换课', '换课']]
          .map(([v, l]) => `<button type="button" class="le-seg-i${curType === v ? ' on' : ''}" data-t="${v}">${l}</button>`).join('')}
      </div>
    </div>

    <div id="le-sub" class="le-sub hidden">
      <div class="field"><label class="field-label" id="le-peer-l">对方姓名</label>
        <input class="input" id="peer" list="le-tlist" value="${esc(row?.peer_name || '')}">
        <datalist id="le-tlist">${[...new Set(teachers.map((t) => t?.name).filter(Boolean))].map((n) => `<option value="${esc(n)}">`).join('')}</datalist>
      </div>
      <div class="field hidden" id="le-swap-w">
        <label class="field-label">换课说明</label>
        <div class="form-grid">
          <input class="input" id="swap_from" value="${esc(row?.swap_from || '')}">
          <input class="input" id="swap_to" value="${esc(row?.swap_to || '')}">
        </div>
      </div>
      <div class="le-tip" id="le-tip"></div>
    </div>

    <div class="field"><label class="field-label">上课内容</label><textarea class="input" id="content" rows="2">${esc(row?.content || '')}</textarea></div>
    <div class="form-grid">
      <div class="field"><label class="field-label">教学进度</label><input class="input" id="progress" value="${esc(row?.progress || '')}"></div>
      <div class="field"><label class="field-label">下一节课内容</label><input class="input" id="next_content" value="${esc(row?.next_content || '')}"></div>
    </div>
    <div class="field"><label class="field-label">违纪情况</label><input class="input" id="discipline" value="${esc(row?.discipline || '')}"></div>
    ${remarkField({ value: row?.remark || '', placeholder: '如：投影仪坏了、下节课带试卷' })}

    <!-- 【第 6 条：上课时单价不能改】
         原来单价只能去工具栏那个「单价 30 元/节」按钮里改，而且改的是「以后的默认值」，
         记这节课的时候根本动不了。用户实际场景是：这一节是公开课/晚自习，
         单价跟平时不一样，就想临时改一下——原来的设计逼他改完全局单价、记完再改回去，
         两次操作只为一节课，很容易忘掉第二步，导致后面所有课都按错的单价算。

         现在把「单价」直接摆进金额这一行：改它，金额立刻按 课时口径×单价 重算。
         这个改动只影响这一条记录（金额是逐条存的），不会偷偷改掉全局单价；
         想改全局默认值仍然走上面那个按钮。 -->
    <div class="le-money">
      <div class="field"><label class="field-label">课时</label><input class="input" id="hours" type="number" step="0.5" min="0" value="${row?.hours ?? 1}"></div>
      <div class="field"><label class="field-label">课时口径（节）</label><input class="input" id="pay_hours" type="number" step="0.5" min="0" value="${row?.pay_hours ?? 1}"></div>
      <div class="field"><label class="field-label">单价（元/节）</label><input class="input" id="le_price" type="number" step="1" min="0" value="${row?.unit_price ?? price}"></div>
      <div class="field"><label class="field-label">金额（元）</label><input class="input" id="pay_amount" type="number" step="1" min="0" value="${row?.pay_amount ?? price}"></div>
      <button type="button" class="btn ghost sm le-reset" id="le-reset" title="按课时×单价重算金额">按单价重算</button>
    </div>
    <div class="tiny muted" style="margin:-6px 0 10px">课时=这节课算几次课（别人代我时为 0）；单价改这里只影响这一节课，金额也可以直接改。</div>

    <div class="confirm-actions">${isNew ? '' : '<button class="btn ghost" id="del" style="margin-right:auto;color:var(--red)">删除</button>'}
      <button class="btn ghost" id="cancel">取消</button><button class="btn primary" id="save">保存</button></div>
  </div>`);
  const s = sheet({ title: isNew ? '记一节课' : '编辑上课记录', body, wide: true });
  const $ = (q) => body.querySelector(q);
  let type = curType;

  const syncType = () => {
    const isNormal = type === 'normal';
    $('#le-sub').classList.toggle('hidden', isNormal);
    $('#le-swap-w').classList.toggle('hidden', type !== '换课');
    $('#le-peer-l').textContent = type === '替他人上' ? '原上课人（谁把这节让给你）'
      : type === '他人替我上' ? '代课人（谁替你上的）' : '换课对象';
    // 别人代我：课时归对方，我这节记 0
    if (type === '他人替我上') {
      $('#hours').value = 0;
      $('#hours').disabled = true;
    } else {
      $('#hours').disabled = false;
      if (Number($('#hours').value) === 0) $('#hours').value = 1;
    }
    const tip = $('#le-tip');
    if (type === '替他人上') {
      tip.className = 'le-tip green';
      tip.innerHTML = `月底将向 <b>${esc($('#peer').value || '对方')}</b> 收取 ${$('#pay_hours').value} 节 / ${money($('#pay_amount').value)} 元`;
    } else if (type === '他人替我上') {
      tip.className = 'le-tip amber';
      tip.innerHTML = `本节课时归 <b>${esc($('#peer').value || '代课人')}</b>，你的课时记 0。<br>月底需付给对方 ${$('#pay_hours').value} 节 / ${money($('#pay_amount').value)} 元`;
    } else if (type === '换课') {
      tip.className = 'le-tip purple';
      tip.innerHTML = '换课只做记录，不计入欠账（你上了他的、他上了你的，两边抵消）';
    } else {
      tip.className = 'le-tip';
      tip.innerHTML = '';
    }
  };
  body.querySelectorAll('.le-seg-i').forEach((b) => {
    b.onclick = () => {
      type = b.dataset.t;
      body.querySelectorAll('.le-seg-i').forEach((x) => x.classList.toggle('on', x === b));
      syncType();
    };
  });
  ['#peer', '#pay_amount'].forEach((q) => { $(q).oninput = syncType; });
  /* 单价 / 课时口径 任一变化 → 金额跟着重算。
     单价取输入框当前值而不是闭包里的 price：
     用户可能刚把 30 改成 45，接着改课时口径，
     这时还用旧的 30 去算，金额就与屏幕上显示的单价对不上。 */
  const recalc = () => {
    const ph = Number($('#pay_hours').value) || 0;
    const up = Number($('#le_price').value) || 0;
    $('#pay_amount').value = Math.round(ph * up * 100) / 100;
    syncType();
  };
  /* 【课时 / 单价不接受负数】
     type=number 写了 min="0"，但浏览器只在"提交表单"时才管它，
     这里的输入框是手动读 .value 再算的，压根不会触发校验。
     所以填 -5 时，金额框会老老实实显示 -150，保存时却被 Number(...)||0 变成别的数 ——
     屏幕上和存下来的不是同一个数，用户回头对账会以为自己记错了。
     现在：输入即时夹紧到 >= 0 并回写到输入框，让用户看见的就是真正会存的。 */
  const clampNum = (q, min = 0) => {
    const el = $(q);
    const v = el.value === '' ? '' : Number(el.value);
    if (v !== '' && (Number.isNaN(v) || v < min)) {
      el.value = min;
      return min;
    }
    return v === '' ? 0 : v;
  };
  $('#pay_hours').oninput = () => { clampNum('#pay_hours'); recalc(); };
  $('#pay_hours').onblur = () => { clampNum('#pay_hours'); recalc(); };
  $('#le_price').oninput = () => { clampNum('#le_price'); recalc(); };
  $('#le_price').onblur = () => { clampNum('#le_price'); recalc(); };
  $('#hours').oninput = () => clampNum('#hours');
  $('#hours').onblur = () => clampNum('#hours');
  /* 「按单价重算」也要跟着当前单价走，同时把单价写回这一条记录 */
  const resetBtn = $('#le-reset');
  if (resetBtn) resetBtn.onclick = () => { recalc(); };

  // 一键带出课表信息（今天没课就用下一个有课的日子，同时把日期挪过去）
  body.querySelectorAll('[data-ci]').forEach((b) => {
    b.onclick = () => {
      const c = todayCourses[Number(b.dataset.ci)];
      const per = one_period(periods, c.period_no);
      if (pickOffset > 0) {
        const d = new Date(today + 'T00:00');
        d.setDate(d.getDate() + pickOffset);
        $('#date').value = ymd(d);
      }
      $('#class').value = c.class_name || '';
      $('#subject').value = c.subject || '';
      $('#period').value = c.period_no;
      $('#st').value = c.start_time || per?.start_time || '';
      $('#et').value = c.end_time || per?.end_time || '';
      body.querySelectorAll('[data-ci]').forEach((x) => x.classList.toggle('on', x === b));
      $('#content').focus();
      toast('已带出课表信息，填内容即可');
    };
  });

  /* 金额按 课时口径 × 单价 重算。
     【这里曾经绑了两次】上面 resetBtn 那次读的是输入框里的当前单价（正确），
     下面这段又用闭包里那个「打开面板时」的旧 price 覆盖了一次，后绑的生效，
     所以改完单价点「按单价重算」，金额会跳回旧数。只留上面那一次。 */

  syncType();
  $('#cancel').onclick = s.close;
  $('#del')?.addEventListener('click', async () => {
    if (await confirmDialog('确认删除这节课？')) { await api.del('/lessons/' + row.id); s.close(); reload(); }
  });
  saving($('#save'), async () => {
    const peer = $('#peer').value.trim();
    if (type !== 'normal' && !peer) { toast('请填写' + (type === '换课' ? '换课对象' : '对方姓名'), 'warn'); return; }
    if (!type) return;
    const payload = {
      date: $('#date').value, period_no: Number($('#period').value),
      class_name: $('#class').value, subject: $('#subject').value,
      start_time: $('#st').value, end_time: $('#et').value,
      sub_type: type,
      peer_name: type === 'normal' ? '' : peer,
      orig_teacher: type === '替他人上' ? peer : '',
      swap_from: type === '换课' ? $('#swap_from').value.trim() : '',
      swap_to: type === '换课' ? $('#swap_to').value.trim() : '',
      /* 负数在这里再兜一道：界面上已经夹紧了，但用户可能用键盘删掉重输后直接回车，
         blur 不一定来得及跑。存进库的必须是 >= 0 的数。 */
      hours: type === '他人替我上' ? 0 : Math.max(0, Number($('#hours').value) || 0),
      pay_hours: Math.max(0, Number($('#pay_hours').value) || 0),
      /* 单价跟着这一条走。存下来有两个用处：
         ① 以后改全局单价时，历史记录的单价和金额不会被一起改掉（对账要能复现）；
         ② 编辑旧记录时输入框回填的就是当时那个单价，而不是现在的默认值。 */
      unit_price: $('#le_price').value === '' ? null : Math.max(0, Number($('#le_price').value) || 0),
      pay_amount: Math.max(0, Number($('#pay_amount').value) || 0),
      content: $('#content').value, progress: $('#progress').value,
      next_content: $('#next_content').value, discipline: $('#discipline').value,
      remark: $('#remark').value,
    };
    if (!payload.date) return toast('请选择日期', 'warn');
    /* 【班级是必填的】
       原来只校验了日期，班级空着也能存 →
       列表里显示「-- 未填科目」，一节课没有任何归属，
       到月底统计课时和课时费的时候既不能按班汇总，也没法查是哪节课。
       科目可以先空着（有时候临时顶课，事后才补），但班级必须选。 */
    payload.class_name = String(payload.class_name || '').trim();
    if (!payload.class_name) { toast('请选择或填写班级，不然这节课没法归到哪个班', 'warn'); return; }
    if (isNew) await api.post('/lessons', payload); else await api.patch('/lessons/' + row.id, payload);
    s.close(); toast('已保存'); reload();
  });

  // 新建时如果只有一节课，直接带出来省一步
  if (isNew && todayCourses.length === 1) {
    const btn = body.querySelector('[data-ci]');
    if (btn) btn.click();
  }
}

/* ================= 课表 ================= */
async function renderTimetable(box) {
  const load = async () => {
    const [courseResult, periodResult] = await Promise.all([api.get('/courses'), api.get('/periods')]);
    const courses = Array.isArray(courseResult) ? courseResult : [];
    const periods = Array.isArray(periodResult) ? periodResult : [];
    const maxP = Math.max(8, ...periods.map((p) => Number(p.period_no) || 0), ...courses.map((c) => Number(c.period_no) || 0));
    /* 数据 weekday：0=周日；界面固定按周一至周日展示。 */
    const WD_ORDER = [1, 2, 3, 4, 5, 6, 0];
    const wd = WD_ORDER;
    const today = new Date().getDay();
    const periodByNo = new Map(periods.map((p) => [Number(p.period_no), p]));
    const get = (d, p) => courses.find((c) => Number(c.weekday) === d && Number(c.period_no) === p);
    const fmtTime = (value) => String(value || '').slice(0, 5);
    const timeRange = (start, end) => {
      const a = fmtTime(start);
      const b = fmtTime(end);
      return a && b ? a + '–' + b : (a || b || '时间待设置');
    };
    const courseTime = (course, period) => timeRange(
      course?.start_time || period?.start_time,
      course?.end_time || period?.end_time
    );

    box.innerHTML = `
      <section class="tt-workspace" aria-label="周课表">
        <div class="tt-workspace-head">
          <div class="tt-workspace-title-wrap">
            <h2 class="tt-workspace-title">周课表</h2>
          </div>
          <div class="tt-toolbar-actions">
            <button class="btn ghost sm" id="edit-periods" type="button">作息设置</button>
            <button class="btn primary sm" id="add-course" type="button">${icon('plus', 15)} 新增课程</button>
            <details class="tt-more-actions">
              <summary>更多操作</summary>
              <div class="tt-more-menu">
                <button type="button" id="import-tt">${icon('download', 14)} 导入课表</button>
                <button type="button" id="print-tt">${icon('printer', 14)} 打印 / 导出课表</button>
              </div>
            </details>
          </div>
        </div>
        <p class="tt-workspace-hint">点空格直接加课；课程块可以按住拖到别的节次或星期（落点有课则对调），点一下能改班级、时间或删除；右侧「作息设置」可以调整节次名称、上下课时间和午休时段。</p>
        <div class="tt-grid-scroll">
          <table class="tt-grid-table" aria-label="周课程安排">
            <colgroup>
              <col class="tt-col-time">
              <col class="tt-col-period">
              ${wd.map(() => '<col class="tt-col-day">').join('')}
            </colgroup>
            <thead>
              <tr>
                <th scope="col" class="tt-fixed-head">时间</th>
                <th scope="col" class="tt-fixed-head">节次</th>
                ${wd.map((d) => `<th scope="col" class="tt-weekday-head ${d === today ? 'is-today' : ''}">周${WD_SHORT[d]}</th>`).join('')}
              </tr>
            </thead>
            <tbody>
              ${Array.from({ length: maxP }, (_, i) => i + 1).map((p) => {
                const period = periodByNo.get(p);
                const prev = periodByNo.get(p - 1);
                const lunch = lunchGap(prev, period);
                const lunchRow = lunch ? `
                  <tr class="tt-lunch-row">
                    <td colspan="${wd.length + 2}">
                      <strong>午休</strong><span>${esc(lunch)}</span>
                    </td>
                  </tr>` : '';
                return lunchRow + `
                  <tr class="tt-period-row">
                    <td class="tt-time-cell">
                      <span>${esc(period ? timeRange(period.start_time, period.end_time) : '时间待设置')}</span>
                    </td>
                    <td class="tt-period-cell">第${p}节</td>
                    ${wd.map((d) => {
                      const course = get(d, p);
                      const time = course ? courseTime(course, period) : '';
                      const detail = course ? [course.subject, course.room].filter(Boolean).join(' · ') : '';
                      const label = course
                        ? [course.class_name || course.subject || '课程', time, detail].filter(Boolean).join('，')
                        : '周' + WD_SHORT[d] + '第' + p + '节，点击新增课程';
                      return `
                        <td class="tt-slot ${course ? 'has-course' : 'is-empty'}"
                          data-cell="${d}-${p}"
                          ${course ? `data-course-id="${esc(course.id)}" draggable="true"` : ''}
                          aria-label="${esc(label)}">
                          ${course ? `
                            <div class="tt-course-card" title="${esc(detail || label)}">
                              <strong>${esc(course.class_name || course.subject || '课程')}</strong>
                              <span>${esc(time)}</span>
                            </div>` : '<span class="tt-empty-add" aria-hidden="true">＋</span>'}
                        </td>`;
                    }).join('')}
                  </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
        <div class="tt-summary-bar">
          <span>本周共 ${courses.length} 节课程，按 4.3 周/月估算约 ${Math.round(courses.length * 4.3)} 节；实际以「上课」中的记录为准。</span>
          <span>与「信息课教师工作台」的课表是同一份数据</span>
        </div>
      </section>`;

    let draggedCourseId = null;
    let suppressCellClick = false;
    box.querySelectorAll('[data-cell]').forEach((td) => {
      td.onclick = () => {
        if (suppressCellClick) { suppressCellClick = false; return; }
        const [d, p] = td.dataset.cell.split('-').map(Number);
        const period = periodByNo.get(p) || {};
        courseEditor(get(d, p) || {
          weekday: d,
          period_no: p,
          start_time: period.start_time || '',
          end_time: period.end_time || ''
        }, load);
      };
      td.addEventListener('dragover', (event) => {
        if (!draggedCourseId) return;
        event.preventDefault();
        td.classList.add('tt-drop-target');
      });
      td.addEventListener('dragleave', () => td.classList.remove('tt-drop-target'));
      td.addEventListener('drop', async (event) => {
        event.preventDefault();
        td.classList.remove('tt-drop-target');
        const source = courses.find((item) => String(item.id) === String(draggedCourseId));
        draggedCourseId = null;
        if (!source) return;
        const [toDay, toPeriod] = td.dataset.cell.split('-').map(Number);
        if (Number(source.weekday) === toDay && Number(source.period_no) === toPeriod) return;
        const target = get(toDay, toPeriod);
        const sourceTime = periodByNo.get(Number(source.period_no)) || {};
        const targetTime = periodByNo.get(toPeriod) || {};
        try {
          const sourcePayload = {
            weekday: target ? Number(target.weekday) : toDay,
            period_no: target ? Number(target.period_no) : toPeriod,
            start_time: targetTime.start_time || (target ? target.start_time : '') || '',
            end_time: targetTime.end_time || (target ? target.end_time : '') || ''
          };
          const targetPayload = target ? {
            weekday: Number(source.weekday),
            period_no: Number(source.period_no),
            start_time: sourceTime.start_time || target.start_time || '',
            end_time: sourceTime.end_time || target.end_time || ''
          } : null;
          let targetUpdated = false;
          try {
            if (target) {
              await api.patch('/courses/' + target.id, targetPayload);
              targetUpdated = true;
            }
            await api.patch('/courses/' + source.id, sourcePayload);
          } catch (error) {
            if (target && targetUpdated) {
              await api.patch('/courses/' + target.id, {
                weekday: Number(target.weekday),
                period_no: Number(target.period_no),
                start_time: target.start_time || '',
                end_time: target.end_time || ''
              }).catch(() => {});
            }
            throw error;
          }
          suppressCellClick = true;
          toast(target ? '已交换两门课程的位置' : '课程已移动');
          await load();
        } catch (error) {
          toast(error.message || '拖动失败，原课表未完成更新', 'err');
          await load();
        }
      });
    });
    box.querySelectorAll('[data-course-id]').forEach((td) => {
      td.addEventListener('dragstart', (event) => {
        draggedCourseId = td.dataset.courseId;
        suppressCellClick = false;
        td.classList.add('tt-dragging');
        if (event.dataTransfer) {
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', draggedCourseId);
        }
      });
      td.addEventListener('dragend', () => {
        draggedCourseId = null;
        td.classList.remove('tt-dragging');
        box.querySelectorAll('.tt-drop-target').forEach((node) => node.classList.remove('tt-drop-target'));
      });
    });
    box.querySelector('#add-course').onclick = () => courseEditor(null, load);
    box.querySelector('#edit-periods').onclick = () => periodEditor(periods, load);
    box.querySelector('#import-tt').onclick = () => {
      box.querySelector('.tt-more-actions').open = false;
      importTimetableDialog(load);
    };
    box.querySelector('#print-tt').onclick = () => {
      box.querySelector('.tt-more-actions').open = false;
      const w = window.open('', '_blank');
      if (!w) return toast('浏览器拦截了打印窗口，请允许本站弹出窗口', 'warn');
      w.document.write(printTimetableHTML(courses, periods, maxP));
      w.document.close();
    };
  };
  await load();
}
/* 判断两节课之间是不是午休。
   条件：后一节在 12:00 之后开始、前一节在 13:30 之前结束、中间空 ≥40 分钟。
   返回 "12:00-14:10" 这样的时间段，不是午休返回空串。
   注意：前 4 节常见的 11:20 下、14:00 上 → 间隔 160 分钟，命中。 */
function lunchGap(prev, next) {
  if (!prev || !next) return '';
  const toMin = (t) => {
    const m = String(t || '').match(/^(\d{1,2}):(\d{2})/);
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  };
  const a = toMin(prev.end_time); const b = toMin(next.start_time);
  if (a == null || b == null || b <= a) return '';
  if (b < 12 * 60) return '';          // 后一节在中午前，不是午休
  if (a > 13 * 60 + 30) return '';     // 前一节在 13:30 后才下课，不是午休
  if (b - a < 40) return '';           // 只隔 10 分钟是课间，不是午休
  return `${prev.end_time}-${next.start_time}`;
}

function colorBg(name) {
  const c = ['#eef4ff', '#f3eeff', '#e6f7f7', '#fff6e5', '#ffeef6', '#eef0ff'][(String(name).length + String(name).charCodeAt(1) || 1) % 6];
  return c;
}
/* ================= 课表批量导入 ================= */
/* 【为什么要做这个】
   教务处给的是图片或者一张表，在格子里手工点 13~20 次太累，还容易点错行。
   这里支持两种最贴近真实的输入：
     1) 直接粘贴表格文本（从 Excel/WPS 复制出来就是这种，Tab 分隔）
     2) 粘贴 JSON（工作台自己导出的格式，换设备时用）

   解析规则按老师手里真实的表来设计：
     - 表头第一格是「节次」，后面是「星期一…星期日」；
     - 第一列是节次（1 / 第1节 / 第一节 都认）；
     - 第二列如果是时间（8:00-8:40），当成节次时间读，不是就当班级；
     - 「午休」「中午」这类合并行整行跳过；
     - 单元格里「11班」「高一(11)班」都行。 */
function parseWeekday(s) {
  const t = String(s || '').trim();
  const m = t.match(/[周星期]\s*([一二三四五六日天1-7])/);
  if (!m) return 0;
  const map = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7 };
  return map[m[1]] || 0;
}
function parsePeriodNo(s) {
  const t = String(s || '').trim();
  if (!t) return 0;
  const late = { 晚一: 10, 晚二: 11, 晚三: 12, 晚四: 13 };
  for (const [k, v] of Object.entries(late)) if (t.startsWith(k)) return v;
  const m = t.match(/(\d{1,2})/);
  if (m) return Number(m[1]);
  const cn = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  const m2 = t.match(/第?([一二三四五六七八九十])/);
  return m2 ? (cn[m2[1]] || 0) : 0;
}
function parseTimeRange(s) {
  const m = String(s || '').match(/(\d{1,2})[:：](\d{2})\s*[-–—~至]\s*(\d{1,2})[:：](\d{2})/);
  if (!m) return null;
  const p = (h, mi) => String(h).padStart(2, '0') + ':' + mi;
  return [p(m[1], m[2]), p(m[3], m[4])];
}

function parseTimetableText(text) {
  const lines = String(text || '').split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return { courses: [], periods: [], errors: ['没有内容'] };

  const courses = [];
  const periods = [];
  const errors = [];
  let headerDays = null;   // 表头每一列对应星期几

  for (const line of lines) {
    const cells = line.split('\t').map((c) => c.trim());
    const joined = cells.join('');

    if (!headerDays && /节次/.test(joined) && /周[一二三四五六日天]|星期/.test(joined)) {
      headerDays = cells.map(parseWeekday);
      continue;
    }
    if (/^(午休|中午|休息|课间|备注|合计)/.test(cells[0]) && cells.filter(Boolean).length <= 2) continue;

    const pn = parsePeriodNo(cells[0]);
    if (!pn) continue;

    let colStart = 1;
    const tr = parseTimeRange(cells[1]);
    if (tr) { periods.push({ period_no: pn, start_time: tr[0], end_time: tr[1] }); colStart = 2; }

    const dayCols = headerDays || [0, 1, 2, 3, 4, 5, 6, 7];
    for (let i = colStart; i < cells.length; i++) {
      const v = cells[i];
      if (!v || v === '—' || v === '-' || v === '/') continue;
      const wd = dayCols[i] ?? 0;
      if (!wd) continue;
      courses.push({ weekday: wd, period_no: pn, class_name: v });
    }
  }

  if (!courses.length) errors.push('没解析出课程，请检查第一列是不是节次、第一行是不是星期');
  return { courses, periods, errors };
}

/* ============ 导入课表：图片识别 / 粘贴表格 / 节次时间 ============ */
/* 三个页签是一条流水线的三种来源，最终都落到同一份 courses 上：
     图片：切开网格 → 找出有课的格子 → 人工确认班号
     表格：粘贴 Excel 文本 → 解析
     节次：单独维护上课时间 */
async function importTimetableDialog(reload) {
  let tab = 'image';
  let imgResult = null;   // detectTimetable 的返回值
  let imgURL = '';
  let assign = [];        // [{weekday, period, class_name}]

  const body = el(`<div class="sheet-body">
    <div class="row" style="gap:6px;margin-bottom:12px" id="tt-tabs">
      <button class="btn primary sm" data-t="image">① 传课表图片</button>
      <button class="btn ghost sm" data-t="text">② 粘贴表格</button>
      <button class="btn ghost sm" data-t="period">③ 节次时间</button>
    </div>
    <div id="tt-pane"></div>
    <div class="confirm-actions">
      <button class="btn ghost" id="tt-cancel">关闭</button>
      <button class="btn primary" id="tt-ok">导入到课表</button>
    </div></div>`);
  const s = sheet({ title: '导入课表', body, wide: true });
  const pane = body.querySelector('#tt-pane');
  const okBtn = body.querySelector('#tt-ok');
  body.querySelector('#tt-cancel').onclick = s.close;

  const setTab = (t) => {
    tab = t;
    body.querySelectorAll('#tt-tabs button').forEach((b) => {
      b.className = b.dataset.t === t ? 'btn primary sm' : 'btn ghost sm';
    });
    okBtn.style.display = t === 'period' ? 'none' : '';
    paint();
  };

  /* ---------- 图片页 ---------- */
  const paintImage = () => {
    pane.innerHTML = `
      <div class="small muted" style="line-height:1.8;margin-bottom:10px">
        把课表截图（或拍照）传上来，我会自动切出表格、找出<b>有课的格子</b>，
        再把格子里的<b>班号数字</b>读出来。<br>
        全程在你自己的浏览器里算，图片不外传。少数认不准的格子会标成橙色，填个班号就行。
      </div>
      <div class="row wrap" style="gap:8px;align-items:center">
        <label class="btn primary sm" style="cursor:pointer">
          ${icon('download', 15)} 选择图片
          <input type="file" id="tt-file" accept="image/*" style="display:none">
        </label>
        <span class="tiny muted" id="tt-hint">支持截图、拍照，斜着拍的也能试</span>
      </div>
      <div id="tt-work" style="margin-top:12px"></div>`;
    const file = pane.querySelector('#tt-file');
    file.onchange = async () => {
      const f = file.files && file.files[0];
      if (!f) return;
      const work = pane.querySelector('#tt-work');
      work.innerHTML = '<div class="small muted">识别中…</div>';
      if (imgURL) URL.revokeObjectURL(imgURL);
      imgURL = URL.createObjectURL(f);
      const img = new Image();
      img.onload = () => {
        try {
          imgResult = detectTimetable(img);
        } catch (e) {
          work.innerHTML = `<div class="small" style="color:var(--red)">识别失败：${esc(e.message)}</div>`;
          return;
        }
        if (!imgResult.ok) {
          work.innerHTML = `<div class="small" style="color:var(--red)">${esc(imgResult.reason)}</div>`;
          return;
        }
        /* 班号：优先用图片里认出来的数字（16×16 位图模板匹配）。
           认不出的那几格**留空**，不填任何字。
           早先这里填的是顺序号 String(autoNo)，结果 14 班那格显示成「12」——
           顺序号长得跟真班号一模一样，老师扫一眼只会看「需核对」三个小字，
           多半直接点确认，错班就进课表了。留空反而最安全：空着就必须填。 */
        assign = imgResult.cells.map((c) => {
          const guess = c.classGuess || '';
          return {
            weekday: c.weekday,
            period: c.periodGuess,
            class_name: guess,
            row: c.row, col: c.col,
            guessed: !!guess,          // true = 是认出来的，不是顺序填的
            confidence: c.classConfidence || 0,
          };
        });
        paintImagePreview(work);
      };
      img.onerror = () => { work.innerHTML = '<div class="small" style="color:var(--red)">图片打不开，换一张试试</div>'; };
      img.src = imgURL;
    };
  };

  const paintImagePreview = (work) => {
    const R = imgResult;
    const scale = Math.min(1, 620 / R.w);
    /* 认出来的格子用紫色实框，没认出来的用橙色虚线框 —— 一眼看出哪些要核对 */
    const marks = R.cells.map((c) => {
      const b = c.box;
      const sure = !!c.classGuess;
      return `<rect x="${b.x * scale}" y="${b.y * scale}" width="${b.w * scale}" height="${b.h * scale}"
        fill="${sure ? 'rgba(124,92,255,.22)' : 'rgba(245,158,11,.20)'}"
        stroke="${sure ? '#7C5CFF' : '#F59E0B'}" stroke-width="1"
        ${sure ? '' : 'stroke-dasharray="3 2"'}/>`;
    }).join('');
    const nSure = R.cells.filter((c) => c.classGuess).length;
    const nUnsure = R.cells.length - nSure;
    work.innerHTML = `
      <div class="small" style="margin-bottom:8px;line-height:1.8">
        切出 <b>${R.rows}</b> 行 × <b>${R.cols}</b> 列，其中 <b>${R.cells.length}</b> 格有课。<br>
        <span style="color:var(--green)">紫色实框 ${nSure} 格：班号已从图里认出来</span>${nUnsure ? `　<span style="color:#B45309">橙色虚框 ${nUnsure} 格：没认出来，班号空着，请你填</span>` : ''}
      </div>
      <div style="position:relative;display:inline-block;max-width:100%">
        <img src="${imgURL}" style="max-width:${Math.round(R.w * scale)}px;display:block;border-radius:8px">
        <svg style="position:absolute;left:0;top:0;width:${Math.round(R.w * scale)}px;height:${Math.round(R.h * scale)}px;pointer-events:none"
          viewBox="0 0 ${R.w * scale} ${R.h * scale}">${marks}</svg>
      </div>
      <div class="table-wrap" style="margin-top:12px;max-height:280px;overflow:auto">
        <table class="tbl" style="min-width:0">
          <thead><tr><th>星期</th><th>第几节</th><th>班级（可改）</th><th></th></tr></thead>
          <tbody>${assign.map((a, i) => `<tr data-i="${i}"${a.guessed ? '' : ' style="background:rgba(245,158,11,.08)"'}>
            <td><select class="cell-input" data-k="weekday">${[1, 2, 3, 4, 5, 6, 7].map((d) => `<option value="${d}" ${a.weekday === d ? 'selected' : ''}>周${WD_SHORT[d]}</option>`).join('')}</select></td>
            <td><input class="cell-input mono" data-k="period" type="number" min="1" max="14" value="${a.period}" style="width:64px"></td>
            <td><div class="row" style="gap:6px;align-items:center">
              <input class="cell-input" data-k="class_name" value="${esc(a.class_name)}"
                placeholder="${a.guessed ? '' : '填写班号'}"
                style="width:88px;${a.guessed ? '' : 'border-color:#F59E0B;background:#FFF7ED'}"
                title="${a.guessed ? '从图片识别' : '这一格没认出来，请填班号'}">
              ${a.guessed ? '' : '<span class="tiny" style="color:#B45309;white-space:nowrap;font-weight:600">待填</span>'}
            </div></td>
            <td><button class="icon-btn sm" data-del="1">${icon('close', 14)}</button></td>
          </tr>`).join('')}</tbody>
        </table>
      </div>
      <div class="row" style="margin-top:8px;gap:8px">
        <button class="btn ghost sm" id="tt-fill">空着的按 1,2,3… 填</button>
        <button class="btn ghost sm" id="tt-rows">按行号当节次</button>
      </div>
      <div class="tiny muted" style="margin-top:8px">
        改完直接点右下角「导入到课表」。格子认错了可以删掉那一行。<br>
        班号是从图里的数字认出来的（不用联网）。<b style="color:#B45309">橙色的行是没认出来的，班号空着，必须填上才能导入</b>。
      </div>`;
    work.querySelectorAll('[data-k]').forEach((inp) => {
      inp.oninput = inp.onchange = () => {
        const tr = inp.closest('tr');
        const i = Number(tr.dataset.i);
        const k = inp.dataset.k;
        assign[i][k] = k === 'weekday' || k === 'period' ? Number(inp.value) : inp.value;
      };
    });
    work.querySelectorAll('[data-del]').forEach((b) => {
      b.onclick = () => {
        const i = Number(b.closest('tr').dataset.i);
        assign.splice(i, 1);
        paintImagePreview(work);
      };
    });
    work.querySelector('#tt-fill').onclick = () => {
      /* 手动把空着的行填成 1,2,3…：只在「图里一个数字都没认出来、只能靠顺序」时才用得上。
         它填的是序号，不是真班号 —— 所以填完 guessed 仍是 false（行还是橙的），
         提醒老师这些值不是从图上认出来的，得自己核一遍。 */
      let k = 0;
      assign.forEach((a) => {
        k++;
        if (String(a.class_name || '').trim()) return;   // 已认出来的不动
        a.class_name = String(k);
      });
      paintImagePreview(work);
    };
    work.querySelector('#tt-rows').onclick = () => {
      // 按格子在原图里所在的行重新推节次（表头下方第几行 = 第几节）
      assign.forEach((a) => {
        const mapped = R.periodByRow?.[a.row];
        if (mapped) a.period = mapped;
      });
      paintImagePreview(work);
    };
  };

  /* ---------- 粘贴表格页 ---------- */
  const paintText = () => {
    pane.innerHTML = `
      <div class="small muted" style="line-height:1.8;margin-bottom:10px">
        从 Excel / WPS 选中整个课表区域（含表头和星期）→ 复制 → 粘到下面。<br>
        也可以粘贴 JSON（换设备时用）。
      </div>
      <textarea id="tt-src" class="cell-input" rows="10" style="width:100%;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;line-height:1.6"
       ></textarea>
      <div id="tt-preview" class="small" style="margin-top:10px"></div>`;
    const src = pane.querySelector('#tt-src');
    const preview = pane.querySelector('#tt-preview');
    src.oninput = () => {
      const t = src.value;
      if (!t.trim()) { preview.innerHTML = ''; return; }
      const r = parseTimetableAny(t);
      if (r.errors.length) preview.innerHTML = `<div style="color:var(--red)">${r.errors.map(esc).join('<br>')}</div>`;
      else {
        const byDay = {};
        for (const c of r.courses) byDay[c.weekday] = (byDay[c.weekday] || 0) + 1;
        preview.innerHTML = `<div style="color:var(--green)">识别到 <b>${r.courses.length}</b> 节课`
          + `${r.periods.length ? `、<b>${r.periods.length}</b> 个节次时间` : ''}（`
          + Object.keys(byDay).sort().map((d) => `周${WD_SHORT[d]} ${byDay[d]}`).join('，') + '）</div>';
      }
    };
  };

  /* ---------- 节次时间页 ---------- */
  const paintPeriod = () => {
    const rows = PERIOD_PRESET;
    pane.innerHTML = `
      <div class="small muted" style="line-height:1.8;margin-bottom:10px">
        课表上那一列「时间」照抄到这里。以后「今日课程」「上课提醒」都按这个算。
      </div>
      <div class="table-wrap"><table class="tbl" style="min-width:0">
        <thead><tr><th>节次</th><th>开始</th><th>结束</th></tr></thead>
        <tbody>${rows.map((r, i) => `<tr><td><b>${r[0]}</b></td>
          <td><input class="cell-input mono" data-p="${i}" data-k="s" type="time" value="${r[1]}"></td>
          <td><input class="cell-input mono" data-p="${i}" data-k="e" type="time" value="${r[2]}"></td>
        </tr>`).join('')}</tbody></table></div>
      <div class="row" style="margin-top:10px"><button class="btn primary sm" id="tt-savep">保存节次时间</button></div>`;
    pane.querySelector('#tt-savep').onclick = async () => {
      const exist = await api.get('/periods');
      let n = 0;
      for (const r of rows) {
        const sEl = pane.querySelector(`input[data-p="${rows.indexOf(r)}"][data-k="s"]`);
        const eEl = pane.querySelector(`input[data-p="${rows.indexOf(r)}"][data-k="e"]`);
        if (!sEl.value || !eEl.value) continue;
        const hit = exist.find((x) => Number(x.period_no) === Number(r[0]));
        const payload = { period_no: Number(r[0]), name: r[3] || `第${r[0]}节`, start_time: sEl.value, end_time: eEl.value };
        if (hit) await api.patch('/periods/' + hit.id, payload).catch(() => {});
        else await api.post('/periods', payload).catch(() => {});
        n += 1;
      }
      toast(`已保存 ${n} 个节次时间`);
    };
  };

  const paint = () => {
    if (tab === 'image') paintImage();
    else if (tab === 'text') paintText();
    else paintPeriod();
  };

  body.querySelectorAll('#tt-tabs button').forEach((b) => { b.onclick = () => setTab(b.dataset.t); });

  /* ---------- 导入 ---------- */
  saving(okBtn, async () => {
    let list = [];
    if (tab === 'image') {
      if (!assign.length) { toast('先传一张课表图片', 'err'); return; }
      /* 【空班号必须拦住，不能悄悄过滤】
         图片里认不出的格子班号是空的。这里如果直接 filter 掉，那节课会**无声消失**
         —— 老师以为导了 13 节，实际只进 12 节，少的那节要等到上课才发现。
         所以先检查有没有空行，有就报出在第几行、带着节次，让他直接去填。 */
      const blank = assign
        .map((a, i) => ({ a, i }))
        .filter(({ a }) => !String(a.class_name || '').trim());
      if (blank.length) {
        const rowsTxt = blank
          .map(({ a }) => `周${WD_SHORT[a.weekday] || a.weekday}第${a.period}节`)
          .join('、');
        toast(`还有 ${blank.length} 行没填班号（${rowsTxt}），填完再导入`, 'err');
        const first = pane.querySelector(`tr[data-i="${blank[0].i}"] [data-k=class_name]`);
        if (first) { first.focus(); first.scrollIntoView({ block: 'center' }); }
        return;
      }
      list = assign
        .filter((a) => a.weekday && a.period)
        .map((a) => ({ weekday: a.weekday, period_no: a.period, class_name: String(a.class_name).trim() }));
    } else {
      const src = pane.querySelector('#tt-src');
      const r = parseTimetableAny(src ? src.value : '');
      if (r.errors.length) { toast(r.errors[0], 'err'); return; }
      list = r.courses;
    }
    if (!list.length) { toast('没有可导入的课程', 'err'); return; }

    const old = await api.get('/courses');
    for (const c of old) await api.del('/courses/' + c.id).catch(() => {});
    const ps = await api.get('/periods');
    const pmap = new Map(ps.map((p) => [Number(p.period_no), p]));

    /* 【顺手把节次时间也写进去】
       老师课表截图上「时间」那一列就是权威作息：8:00-8:40、10:00-10:40…
       只导课程不导时间的话，课表页会显示系统自带的 07:40-08:25，一眼就看出不对。
       所以这里把 PERIOD_PRESET（照老师这张表抄的）一并落库。

       什么情况不覆盖：用户自己手动改过的时间要留住。
       判断依据 = 现有时间「既不是预设值、也不在系统内置默认值里」→ 认为是他改的。
       内置默认值放一张常量表，是为了区分「从没动过的初始值」和「用户改过的」。 */
    const BUILTIN_DEFAULT = new Set(['07:40-08:25', '08:35-09:20', '09:35-10:20', '10:30-11:15',
      '11:25-12:10', '14:20-15:05', '15:15-16:00', '16:10-16:55', '17:10-17:55', '19:00-19:45',
      '19:55-20:40', '20:45-21:30', '21:35-22:20', '']);
    let np = 0;
    for (const [no, st, en, nm] of PERIOD_PRESET) {
      const hit = pmap.get(no);
      const cur = hit ? `${hit.start_time || ''}-${hit.end_time || ''}` : '';
      const same = cur === `${st}-${en}`;
      if (hit && !same && !BUILTIN_DEFAULT.has(cur)) continue;   // 用户手动改过，尊重他
      if (same) continue;                                        // 已经对了，不用写
      const payload = { period_no: no, name: nm, start_time: st, end_time: en };
      try {
        if (hit) await api.patch('/periods/' + hit.id, payload);
        else await api.post('/periods', payload);
        pmap.set(no, { ...(hit || {}), ...payload });
        np += 1;
      } catch { /* 单个节次失败不阻断 */ }
    }

    let n = 0;
    for (const c of list) {
      const p = pmap.get(Number(c.period_no)) || {};
      try {
        await api.post('/courses', {
          weekday: Number(c.weekday), period_no: Number(c.period_no),
          start_time: c.start_time || p.start_time || '', end_time: c.end_time || p.end_time || '',
          grade: c.grade || '', class_name: c.class_name,
          subject: c.subject || '', room: c.room || '', color: c.color || '',
        });
        n += 1;
      } catch (e) { /* 单条失败不阻断 */ }
    }
    toast(`已导入 ${n} 节课${np ? `，节次时间也一并更新了 ${np} 条` : ''}`);
    s.close();
    reload();
  });

  setTab('image');
}

/* 统一解析入口：JSON 走 JSON，其余按 Tab 表格解析 */
function parseTimetableAny(text) {
  const t = String(text || '').trim();
  if (!t) return { courses: [], periods: [], errors: ['还没有内容'] };
  if (/^[[{]/.test(t)) {
    try {
      const j = JSON.parse(t);
      const cs = j.courses || (Array.isArray(j) ? j : []);
      return { courses: cs, periods: j.periods || [], errors: cs.length ? [] : ['这个 JSON 里没有课程数据'] };
    } catch (e) { return { courses: [], periods: [], errors: ['JSON 解析失败：' + e.message] }; }
  }
  return parseTimetableText(t);
}

/* 节次时间预设：[节次, 开始, 结束, 名称] */
const PERIOD_PRESET = [
  [1, '08:00', '08:40', '第一节'], [2, '08:50', '09:30', '第二节'],
  [3, '10:00', '10:40', '第三节'], [4, '10:50', '11:30', '第四节'],
  [5, '11:40', '12:20', '第五节'], [6, '14:10', '14:50', '第六节'],
  [7, '15:20', '16:00', '第七节'], [8, '16:15', '16:55', '第八节'],
  [9, '17:05', '17:45', '第九节'], [10, '18:25', '18:40', '晚一'],
  [11, '19:30', '20:10', '晚二'], [12, '20:20', '21:00', '晚三'],
  [13, '21:10', '21:55', '晚四'],
];

function printTimetableHTML(courses, periods, maxP) {
  const get = (d, p) => courses.find((c) => Number(c.weekday) === d && Number(c.period_no) === p);
  return `<!doctype html><meta charset="utf-8"><title>${state.user?.nickname || ''} 课表</title>
  <style>body{font-family:-apple-system,"PingFang SC","Microsoft YaHei";margin:24px;color:#17203a}
  h2{margin:0 0 4px}.meta{color:#667085;font-size:12px;margin-bottom:12px}
  table{width:100%;border-collapse:collapse;font-size:12px}th,td{border:1px solid #c8d0dd;padding:6px;text-align:center;height:46px}
  th{background:#eff3fa}td small{color:#667085;display:block}
  @media print{@page{size:A4 landscape;margin:12mm}}</style>
  <h2>${esc(state.user?.nickname || '')} 个人课表</h2>
  <div class="meta">${esc(state.user?.school || '')}　${esc(state.user?.subject || '')}　导出时间 ${new Date().toLocaleDateString('zh-CN')}</div>
  <table><tr><th>节次/时间</th>${[1,2,3,4,5,6,0].map((d) => `<th>周${WD_SHORT[d]}</th>`).join('')}</tr>
  ${Array.from({ length: maxP }, (_, i) => i + 1).map((p) => {
    const per = periods.find((x) => Number(x.period_no) === p);
    return `<tr><td><b>第${p}节</b><small>${per ? per.start_time + '-' + per.end_time : ''}</small></td>
    ${[1,2,3,4,5,6,0].map((d) => { const c = get(d, p); return `<td>${c ? `<b>${esc(c.class_name)}</b><small>${esc(c.subject)} ${esc(c.room || '')}</small>` : ''}</td>`; }).join('')}</tr>`;
  }).join('')}</table>`;
}
function courseEditor(row, reload) {
  const isNew = !row?.id;
  /* 【历史值联想】
     全站不再预填「语文 / 高二」这类默认值 —— 预填的东西如果不符实际，
     用户还得先删掉才能填，反而更慢。所以默认留空，直接手填。
     但又不想让用户每次都从头打字：把已存课程里出现过的科目/年级/班级
     按最近更新时间优先去重，每个字段只保留最近 5 个候选，挂在 datalist 上。
     这叫「手填为主，联想为辅」：没有强制默认值，只是给个快捷入口。

     注意：这里必须保持同步函数。弹层要立刻出现，不能等接口；
     历史值晚一步到达也没关系，反正用户点开下拉是在之后。 */

  const body = el(`<div class="sheet-body"><div class="form-grid">
    <div class="field"><label class="field-label">星期</label><select class="input" id="weekday">${[1,2,3,4,5,6,0].map((d) => `<option value="${d}" ${Number(row?.weekday) === d ? 'selected' : ''}>周${WD_SHORT[d]}</option>`).join('')}</select></div>
    <div class="field"><label class="field-label">节次</label><input class="input" type="number" id="period_no" value="${row?.period_no || 1}"></div>
    <div class="field"><label class="field-label">开始时间</label><input class="input" type="time" id="st" value="${esc(row?.start_time || '')}"></div>
    <div class="field"><label class="field-label">结束时间</label><input class="input" type="time" id="et" value="${esc(row?.end_time || '')}"></div>
    <div class="field"><label class="field-label">年级</label><input class="input" id="grade" value="${esc(row?.grade || '')}" data-hist="grade"></div>
    <div class="field"><label class="field-label">班级</label><input class="input" id="class_name" value="${esc(row?.class_name || '')}" data-hist="class_name"></div>
    <div class="field"><label class="field-label">科目</label><input class="input" id="subject" value="${esc(row?.subject || '')}" data-hist="subject"></div>
    <div class="field"><label class="field-label">地点</label><input class="input" id="room" value="${esc(row?.room || '')}" placeholder="例如：教学楼A栋101、大操场、机房" autocomplete="off"></div>
    <div class="field"><label class="field-label">生效开始日</label><input class="input" type="date" id="sd" value="${esc(row?.start_date || '')}"></div>
    <div class="field"><label class="field-label">生效结束日</label><input class="input" type="date" id="ed" value="${esc(row?.end_date || '')}"></div>
  </div>
  ${remarkField({ value: row?.remark || '' })}
  <div class="confirm-actions">${isNew ? '' : '<button class="btn ghost" id="del" style="margin-right:auto;color:var(--red)">删除</button>'}
  <button class="btn ghost" id="cancel">取消</button><button class="btn primary" id="save">保存</button></div></div>`);

  /* 历史值异步补上：失败就静默，手填照常可用 */
  api.get('/courses').then((all) => {
    // 最近使用的课程优先；优先按更新时间，其次创建时间，最后用 ID 稳定排序。
    const timestampOf = (course) => {
      const updatedAt = Date.parse(course?.updated_at || '');
      if (Number.isFinite(updatedAt)) return updatedAt;
      const createdAt = Date.parse(course?.created_at || '');
      return Number.isFinite(createdAt) ? createdAt : Number(course?.id) || 0;
    };
    const recent = [...(Array.isArray(all) ? all : [])].sort((a, b) =>
      timestampOf(b) - timestampOf(a) || (Number(b?.id) || 0) - (Number(a?.id) || 0)
    );
    for (const k of ['grade', 'class_name', 'subject']) {
      const seen = new Set();
      const vals = [];
      for (const course of recent) {
        const value = String(course?.[k] || '').trim();
        const normalized = value.toLocaleLowerCase();
        if (!value || seen.has(normalized)) continue;
        seen.add(normalized);
        vals.push(value);
        if (vals.length === 5) break;
      }
      if (!vals.length) continue;
      const input = body.querySelector(`[data-hist="${k}"]`);
      if (!input) continue;
      const id = 'dl-' + k;
      document.getElementById(id)?.remove();
      // 用 createElement 而不是 el()：el() 走 template.firstElementChild，
      // 只保证返回「第一个元素」，这里要的就是 datalist 本身，直接建更清楚。
      const list = document.createElement('datalist');
      list.id = id;
      list.innerHTML = vals.map((v) => `<option value="${esc(v)}">`).join('');
      body.appendChild(list);
      input.setAttribute('list', id);
      input.setAttribute('autocomplete', 'off');
    }
  }).catch(() => {});
  const s = sheet({ title: isNew ? '添加课程' : '修改课程', body });
  body.querySelector('#cancel').onclick = s.close;
  body.querySelector('#del')?.addEventListener('click', async () => {
    if (await confirmDialog('删除这门课？')) { await api.del('/courses/' + row.id); s.close(); reload(); }
  });
  saving(body.querySelector('#save'), async () => {
    const payload = {
      weekday: Number(body.querySelector('#weekday').value), period_no: Number(body.querySelector('#period_no').value),
      start_time: body.querySelector('#st').value, end_time: body.querySelector('#et').value,
      grade: body.querySelector('#grade').value, class_name: body.querySelector('#class_name').value,
      subject: body.querySelector('#subject').value, room: body.querySelector('#room').value,
      start_date: body.querySelector('#sd').value || null, end_date: body.querySelector('#ed').value || null,
      remark: body.querySelector('#remark').value,
    };
    if (isNew) await api.post('/courses', payload); else await api.patch('/courses/' + row.id, payload);
    s.close(); toast('已保存'); reload();
  });
}
function periodEditor(periods, reload) {
  const body = el(`<div class="sheet-body">
    <div class="small muted" style="margin-bottom:8px">上课时间全校调整时，改这里即可，课表会自动跟着变。</div>
    <div class="table-wrap"><table class="tbl" style="min-width:0"><thead><tr><th>节次</th><th>名称</th><th>开始</th><th>结束</th><th></th></tr></thead>
    <tbody>${periods.map((p) => `<tr data-id="${p.id}"><td>第${p.period_no}节</td>
      <td><input class="cell-input" data-k="name" value="${esc(p.name)}"></td>
      <td><input class="cell-input mono" data-k="start_time" type="time" value="${esc(p.start_time)}"></td>
      <td><input class="cell-input mono" data-k="end_time" type="time" value="${esc(p.end_time)}"></td>
      <td><button class="icon-btn sm" data-delp="1">${icon('close', 14)}</button></td></tr>`).join('')}</tbody></table></div>
    <div class="row" style="margin-top:10px"><button class="btn ghost sm" id="addp">＋ 加一节</button><span style="flex:1"></span><button class="btn primary" id="savep">保存</button></div>
  </div>`);
  const s = sheet({ title: '作息设置', body, wide: true });
  body.querySelector('#addp').onclick = async () => {
    const next = (Math.max(0, ...periods.map((p) => Number(p.period_no))) || 0) + 1;
    await api.post('/periods', { period_no: next, name: `第${next}节`, start_time: '00:00', end_time: '00:00' });
    s.close(); reload();
  };
  body.querySelectorAll('[data-delp]').forEach((b) => {
    b.onclick = async () => {
      const id = b.closest('tr').dataset.id;
      await api.del('/periods/' + id); s.close(); reload();
    };
  });
  body.querySelector('#savep').onclick = async () => {
    for (const tr of body.querySelectorAll('tr[data-id]')) {
      const id = tr.dataset.id;
      const p = {}; tr.querySelectorAll('[data-k]').forEach((i) => { p[i.dataset.k] = i.value; });
      await api.patch('/periods/' + id, p);
    }
    s.close(); toast('节次时间已更新'); reload();
  };
}

/* 考勤模块已独立到 attendance.js（两种表两套界面，代码量较大） */
/* ================= 监考 ================= */
async function renderInvigilation(box) {
  const module = await import('./invigilation.js');
  return module.renderInvigilation(box);
}

/* ================= 出差 ================= */
/* ================= 出差报销 ================= */
const TRIP_KIND = [
  ['transport', '交通', 'car'], ['hotel', '住宿', 'home'], ['taxi', '打车', 'car'],
  ['toll', '过路费', 'wallet'], ['parking', '停车费', 'wallet'], ['meal', '餐饮', 'wallet'], ['other', '其他', 'wallet'],
];
const KIND_LABEL = Object.fromEntries(TRIP_KIND.map(([k, l]) => [k, l]));
const REIMB_TXT = { draft: ['草稿', ''], submitted: ['已提交', 'amber'], paid: ['已到手', 'green'] };
const money2 = (v) => (Math.round((Number(v) || 0) * 100) / 100).toFixed(2).replace(/\.00$/, '');

async function renderTrips(box) {
  const ctx = { month: M() };
  const load = async (targetMonth) => {
    if (/^\d{4}-\d{2}$/.test(String(targetMonth || ''))) ctx.month = String(targetMonth);
    let d;
    try {
      d = await api.get('/trip/list', { month: ctx.month });
      if (!d || !Array.isArray(d.rows)) throw new Error('出差列表返回的数据格式不正确');

      /* 自定义列表接口为空时，再从通用出差主表核对一次。
         创建入口写入 /trips，列表入口读取 /trip/list；两者应读取同一份数据。
         这里做读后核对，避免主表已有记录却被页面误报为“暂无记录”。 */
      if (!d.rows.length) {
        const rawRows = await api.get('/trips', { month: ctx.month });
        if (Array.isArray(rawRows) && rawRows.length) {
          const rows = await Promise.all(rawRows.map((row) => api.get('/trip/' + row.id)));
          d = { ...d, rows };
        }
      }
    } catch (primaryError) {
      /* 主列表接口异常时，使用主表 + 单条详情兜底，不能把接口错误伪装成空列表。 */
      try {
        const rawRows = await api.get('/trips', { month: ctx.month });
        if (!Array.isArray(rawRows)) throw new Error('出差主表返回的数据格式不正确');
        const [rules, rows] = await Promise.all([
          api.get('/trip/rules'),
          Promise.all(rawRows.map((row) => api.get('/trip/' + row.id))),
        ]);
        d = { rules, rows };
      } catch (fallbackError) {
        console.error('[trips] 列表读取失败', primaryError, fallbackError);
        box.innerHTML = `<div class="card empty">
          <div>${esc(fallbackError.message || primaryError.message || '出差记录加载失败')}</div>
          <button class="btn ghost sm" id="trip-retry" style="margin-top:12px">重新加载</button>
        </div>`;
        box.querySelector('#trip-retry')?.addEventListener('click', () => load());
        return;
      }
    }
    const rows = Array.isArray(d.rows) ? d.rows : [];
    const rules = d.rules || { foodPerDay: 100, localPerDay: 40 };
    const sum = (f) => rows.reduce((s, r) => s + (f(r) || 0), 0);
    const reimbursement = sum((r) => r.calc.total);
    const km = sum((r) => r.calc.km);
    const vehicleFee = sum((r) => r.calc.vehicleFee);

    box.innerHTML = `<div class="stat-cards" style="margin-bottom:14px">
      <div class="stat"><div class="k">本月出差</div><div class="v">${rows.length}<span class="u">次</span></div></div>
      <div class="stat"><div class="k">累计行驶里程</div><div class="v">${money2(km)}<span class="u">km</span></div></div>
      <div class="stat"><div class="k">车辆里程费用（单独统计）</div><div class="v" style="color:var(--green)">${money2(vehicleFee)}<span class="u">元</span></div></div>
      <div class="stat"><div class="k">报销金额（不含里程费）</div><div class="v">${money2(reimbursement)}<span class="u">元</span></div></div>
    </div>
    ${toolbars('trips', ctx.month, `<button class="btn ghost sm" id="trip-stats">${icon('chart', 15)} 统计</button>
      <button class="btn ghost sm" id="trip-rules">${icon('settings', 15)} 补贴标准</button>
      <button class="btn primary sm" id="add">${icon('plus', 15)} 记录出差</button>`)}
    <div class="col" id="trip-list"></div>`;
    bindToolbars(box, ctx, load);
    box.querySelector('#add').onclick = () => tripEditor(null, load);
    box.querySelector('#trip-stats').onclick = () => tripStatsSheet();
    box.querySelector('#trip-rules').onclick = () => tripRulesSheet(rules, load);

    const list = box.querySelector('#trip-list');
    if (!rows.length) {
      list.innerHTML = `<div class="card empty">${icon('car', 30)}<div style="margin-top:8px">本月还没有出差记录</div></div>`;
      return;
    }
    list.innerHTML = rows.map((r, idx) => {
      const c = r.calc;
      const [rTxt, rCls] = REIMB_TXT[r.reimb_status] || REIMB_TXT.draft;
      return `<div class="card trip-card" data-trip="${r.id}">
        <div class="row wrap" style="gap:8px;align-items:center">
          <span class="trip-no">${idx + 1}</span>
          <span class="bold">${esc(r.to_place || '未填目的地')}</span>
          <span class="chip ${rCls}">${rTxt}</span>
          ${c.bigMissingCount ? `<span class="chip red" title="住宿/交通等大额无票">缺票 ${c.bigMissingCount}</span>` : ''}
          <span class="tiny muted">${esc(r.start_date || '')}${r.end_date && r.end_date !== r.start_date ? ' ~ ' + esc(r.end_date) : ''} · ${c.days} 天</span>
        </div>
        <div class="small muted" style="margin-top:5px">${esc(r.reason || '未填写出差事由')}</div>
        <div class="trip-people">
          <span>驾驶人员：<b>${esc(r.driver || '未填写')}</b></span>
          <span>随行人员：${esc(r.companions || '无')}</span>
        </div>
        <div class="trip-mileage">
          <div class="trip-mileage-main">
            <span>车辆里程</span><b>${money2(c.km)} km</b>
            <span>× ¥${money2(c.kmRate)} / km</span>
            <span class="trip-mileage-note">单独统计，不计入报销</span>
          </div>
          <div class="trip-mileage-fee">¥${money2(c.vehicleFee)}</div>
        </div>
        <div class="trip-math">
          <span class="tm-piece">实报 <b>¥${money2(c.realTotal)}</b></span>
          <span class="tm-op">+</span>
          <span class="tm-piece">补贴 <b>¥${money2(c.subsidyTotal)}</b></span>
          ${c.advance > 0 ? `<span class="tm-op">−</span><span class="tm-piece">预借 <b>¥${money2(c.advance)}</b></span>` : ''}
          <span class="tm-res"><span class="tm-op">=</span><span class="tm-total">¥${money2(c.net)}</span></span>
        </div>
        <div class="trip-foot">
          <span class="tiny muted trip-meta">${c.itemCount ? c.itemCount + ' 笔明细' : '无明细'}${c.missingCount ? ` · ${c.missingCount} 笔无票` : ''}</span>
          <div class="trip-acts">
            <button class="btn ghost sm" data-trip-open="${r.id}">明细 / 发票</button>
            <button class="btn ghost sm" data-trip-copy="${r.id}">${icon('copy', 14)} 复制报销单</button>
            <button class="icon-btn sm" data-trip-edit="${r.id}" title="修改">${icon('edit', 15)}</button>
            <button class="icon-btn sm danger" data-trip-del="${r.id}" title="删除">${icon('trash', 15)}</button>
          </div>
        </div>
      </div>`;
    }).join('');

    list.querySelectorAll('[data-trip-open]').forEach((b) => {
      b.onclick = () => tripDetail(Number(b.dataset.tripOpen), load);
    });
    list.querySelectorAll('[data-trip-copy]').forEach((b) => {
      b.onclick = () => copyTripText(Number(b.dataset.tripCopy));
    });
    list.querySelectorAll('[data-trip-edit]').forEach((b) => {
      b.onclick = () => tripEditor(rows.find((r) => String(r.id) === b.dataset.tripEdit), load);
    });
    list.querySelectorAll('[data-trip-del]').forEach((b) => {
      b.onclick = async (e) => {
        e.stopPropagation();
        const r = rows.find((x) => String(x.id) === b.dataset.tripDel);
        if (!r) return;
        const amt = r.calc?.net != null ? `（含 ${r.calc.itemCount || 0} 笔明细，报销应结算 ¥${money2(r.calc.net)}；另有车辆里程费 ¥${money2(r.calc.vehicleFee)}）` : '';
        if (!(await confirmDialog(`删除去「${r.to_place || '未填目的地'}」的出差记录？${amt}`, { danger: true, okText: '删除' }))) return;
        try { await api.del('/trips/' + r.id); toast('已删除'); load(); }
        catch (err) { toast(err.message || '删除失败', 'err'); }
      };
    });
  };
  await load();
}

/* 一键复制报销单纯文本：直接粘给财务 */
async function copyTripText(id) {
  let text = '';
  try {
    const d = await api.get(`/trip/${id}/text`);
    text = d.text || '';
  } catch (e) { return toast(e.message || '生成失败', 'err'); }
  if (!text) return toast('没有可复制的内容', 'err');
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制，直接粘给财务');
  } catch {
    // 老浏览器 / 非 https：退回弹框让用户自己复制
    const body = el(`<div class="sheet-body"><div class="field"><label class="field-label">长按全选复制</label>
      <textarea class="input" id="tx" rows="14" style="font-family:var(--mono);font-size:12.5px;line-height:1.6">${esc(text)}</textarea></div>
      <div class="confirm-actions"><button class="btn primary" id="ok">全选</button></div></div>`);
    const s = sheet({ title: '报销单文本', body, wide: true });
    body.querySelector('#ok').onclick = () => { const t = body.querySelector('#tx'); t.focus(); t.select(); };
    setTimeout(() => { const t = body.querySelector('#tx'); t.focus(); t.select(); }, 60);
    return s;
  }
}

/* 补贴标准设置 */
function tripRulesSheet(rules, reload) {
  const body = el(`<div class="sheet-body">
    <div class="tiny muted" style="margin-bottom:12px">各地标准不同，按你单位的实际填。补贴按天算，不需要发票。</div>
    <div class="form-grid">
      <div class="field"><label class="field-label">伙食补助（元/天）</label><input class="input" type="number" id="food" value="${rules.foodPerDay ?? 100}"></div>
      <div class="field"><label class="field-label">市内交通补助（元/天）</label><input class="input" type="number" id="local" value="${rules.localPerDay ?? 40}"></div>
    </div>
    <div class="tiny muted">例：出差 3 天 = 伙食 ${rules.foodPerDay ?? 100}×3 + 交通 ${rules.localPerDay ?? 40}×3 = ${(Number(rules.foodPerDay ?? 100) + Number(rules.localPerDay ?? 40)) * 3} 元</div>
    <div class="confirm-actions"><button class="btn ghost" id="c">取消</button><button class="btn primary" id="k">保存</button></div>
  </div>`);
  const s = sheet({ title: '补贴标准', body });
  body.querySelector('#c').onclick = s.close;
  body.querySelector('#k').onclick = async () => {
    try {
      await api.patch('/trip/rules', {
        foodPerDay: Number(body.querySelector('#food').value) || 0,
        localPerDay: Number(body.querySelector('#local').value) || 0,
      });
      s.close(); toast('已保存'); reload();
    } catch (e) { toast(e.message, 'err'); }
  };
}

/* 统计：按月柱状 + 分类占比 */
async function tripStatsSheet() {
  let d;
  try { d = await api.get('/trip/stats', { year: new Date().getFullYear() }); } catch (e) { return toast(e.message, 'err'); }
  const s0 = d.summary;
  const maxM = Math.max(1, ...d.months.map((m) => m.total));
  const maxVehicle = Math.max(1, ...d.months.map((m) => m.vehicleFee || 0));
  const kinds = Object.entries(d.byKind).filter(([, v]) => v > 0);
  const kindTotal = kinds.reduce((a, [, v]) => a + v, 0) || 1;
  const rankHtml = (items) => items?.length
    ? '<div class="trip-stat-list">' + items.map((item) => '<div class="trip-stat-row">'
      + '<span class="trip-stat-name">' + esc(item.name) + '</span>'
      + '<span>' + item.count + ' 次</span>'
      + '<span>' + money2(item.km) + ' km</span>'
      + '<b>¥' + money2(item.vehicleFee) + '</b></div>').join('') + '</div>'
    : '<div class="empty" style="padding:12px 0">暂无记录</div>';
  const reimbursementBars = d.months.map((m) => '<div class="bc-col" title="' + m.month + ' 报销 ¥' + money2(m.total) + '">'
    + '<div class="bc-bar" style="height:' + (m.total > 0 ? Math.max(4, Math.round(m.total / maxM * 100)) : 0) + '%"></div>'
    + '<div class="bc-x">' + Number(m.month.slice(5)) + '</div>'
    + (m.total > 0 ? '<div class="bc-v">' + money2(m.total) + '</div>' : '') + '</div>').join('');
  const vehicleBars = d.months.map((m) => '<div class="bc-col" title="' + m.month + ' 车辆里程费 ¥' + money2(m.vehicleFee) + '">'
    + '<div class="bc-bar" style="height:' + (m.vehicleFee > 0 ? Math.max(4, Math.round(m.vehicleFee / maxVehicle * 100)) : 0) + '%;background:var(--green)"></div>'
    + '<div class="bc-x">' + Number(m.month.slice(5)) + '</div>'
    + (m.vehicleFee > 0 ? '<div class="bc-v">' + money2(m.vehicleFee) + '</div>' : '') + '</div>').join('');
  const kindHtml = kinds.length
    ? '<div class="kind-list">' + kinds.sort((a, b) => b[1] - a[1]).map(([k, v]) => '<div class="kind-row">'
      + '<span class="kind-name">' + (KIND_LABEL[k] || k) + '</span>'
      + '<span class="kind-bar"><i style="width:' + Math.round(v / kindTotal * 100) + '%"></i></span>'
      + '<span class="kind-v">¥' + money2(v) + '</span>'
      + '<span class="tiny muted" style="width:42px;text-align:right">' + Math.round(v / kindTotal * 100) + '%</span>'
      + '</div>').join('') + '</div>'
    : '<div class="empty" style="padding:20px 0">今年还没有出差费用记录</div>';
  const body = el(`<div class="sheet-body">
    <div class="rd-cards" style="grid-template-columns:repeat(4,1fr)">
      <div class="rd-c"><div class="rd-n">${s0.count}</div><div class="rd-l">出差次数</div></div>
      <div class="rd-c"><div class="rd-n">${money2(s0.km)}</div><div class="rd-l">总里程 km</div></div>
      <div class="rd-c"><div class="rd-n" style="color:var(--green)">${money2(s0.vehicleFee)}</div><div class="rd-l">车辆里程费（单独）</div></div>
      <div class="rd-c"><div class="rd-n" style="color:var(--primary)">${money2(s0.total)}</div><div class="rd-l">报销金额（不含里程）</div></div>
    </div>
    <div class="tiny muted" style="margin-top:8px">待报销：¥${money2(s0.pending)} · 车辆里程费不计入报销金额</div>
    <div class="sec-title" style="margin:16px 0 8px">${d.year} 年每月报销金额（不含里程费）</div>
    <div class="bar-chart">${reimbursementBars}</div>
    <div class="sec-title" style="margin:18px 0 8px">${d.year} 年每月车辆里程费用（单独统计）</div>
    <div class="bar-chart">${vehicleBars}</div>
    <div class="sec-title" style="margin:18px 0 8px">目的地统计</div>
    ${rankHtml(d.byDestination)}
    <div class="sec-title" style="margin:18px 0 8px">驾驶人员统计</div>
    ${rankHtml(d.byDriver)}
    <div class="sec-title" style="margin:18px 0 8px">随行人员统计</div>
    ${rankHtml(d.byCompanion)}
    ${kindHtml}
    <div class="confirm-actions"><button class="btn ghost" id="c">关闭</button></div>
  </div>`);
  const s = sheet({ title: '出差统计 · ' + d.year, body, wide: true });
  body.querySelector('#c').onclick = s.close;
}

/* 报销单详情：明细行 + 发票 + 实时合计 */
async function tripDetail(id, reload) {
  let d;
  try { d = await api.get('/trip/' + id); } catch (e) { return toast(e.message, 'err'); }
  const r = d;
  let files = await api.get('/attachments', { owner_type: 'trip', owner_id: id }).catch(() => []);

  const body = el(`<div class="sheet-body">
    <div class="row wrap" style="gap:8px;align-items:center;margin-bottom:4px">
      <div class="bold" style="font-size:16px">${esc(r.to_place || '')}</div>
      <span class="tiny muted">${esc(r.start_date)}${r.end_date && r.end_date !== r.start_date ? ' ~ ' + esc(r.end_date) : ''}</span>
    </div>
    <div class="small muted" style="margin-bottom:8px">${esc(r.reason || '未填写出差事由')}</div>
    <div class="trip-people">
      <span>驾驶人员：<b>${esc(r.driver || '未填写')}</b></span>
      <span>随行人员：${esc(r.companions || '无')}</span>
    </div>
    <div class="trip-mileage">
      <div class="trip-mileage-main">
        <span>车辆里程</span><b>${money2(r.calc.km)} km</b>
        <span>× ¥${money2(r.calc.kmRate)} / km</span>
        <span class="trip-mileage-note">单独统计，不计入报销</span>
      </div>
      <div class="trip-mileage-fee">¥${money2(r.calc.vehicleFee)}</div>
    </div>

    <div class="sec-title">费用明细 <span class="tiny muted">（一笔一行，发票可后补）</span></div>
    <div id="items"></div>
    <button class="btn ghost sm" id="add-item" style="margin-top:8px">${icon('plus', 14)} 加一笔</button>

    <div class="sec-title" style="margin-top:20px">发票 / 凭证</div>
    <div class="row wrap" style="gap:8px" id="files">
      ${files.map((f) => `<a href="${f.url}" target="_blank" class="chip blue">${esc(f.name).slice(0, 18)}</a>`).join('') || '<span class="tiny muted">还没有上传</span>'}
    </div>
    <button class="btn ghost sm" id="up" style="margin-top:8px">${icon('upload', 14)} 上传 / 粘贴发票</button>

    <div class="trip-sum" id="sum"></div>
    <div class="confirm-actions">
      <button class="btn ghost" id="copy" style="margin-right:auto">${icon('copy', 14)} 复制报销单</button>
      <button class="btn ghost" id="c">关闭</button>
    </div>
  </div>`);
  const s = sheet({ title: '报销单', body, wide: true });
  body.querySelector('#c').onclick = s.close;
  body.querySelector('#copy').onclick = () => copyTripText(id);
  body.querySelector('#up').onclick = () => uploadTo('trip', id, async () => {
    files = await api.get('/attachments', { owner_type: 'trip', owner_id: id }).catch(() => []);
    body.querySelector('#files').innerHTML = files.map((f) => `<a href="${f.url}" target="_blank" class="chip blue">${esc(f.name).slice(0, 18)}</a>`).join('') || '<span class="tiny muted">还没有上传</span>';
  });
  body.querySelector('#add-item').onclick = () => itemEditor(id, r.start_date, null, refresh);

  async function refresh() {
    const nd = await api.get('/trip/' + id);
    paintItems(nd);
    paintSum(nd);
  }
  function paintItems(nd) {
    const wrap = body.querySelector('#items');
    if (!nd.items?.length) { wrap.innerHTML = '<div class="tiny muted" style="padding:8px 0">还没有明细。点「加一笔」把车票、住宿一条条记上。</div>'; return; }
    wrap.innerHTML = nd.items.map((it) => `<div class="ti-row">
      <span class="ti-kind">${KIND_LABEL[it.kind] || '其他'}</span>
      <span class="ti-date">${esc((it.date || '').slice(5))}</span>
      <span class="ti-note">${esc(it.note || '')}</span>
      ${it.has_invoice ? '' : '<span class="chip amber tiny-chip">无票</span>'}
      <span class="ti-amt">¥${money2(it.amount)}</span>
      <button class="icon-btn sm" data-it-edit="${it.id}">${icon('edit', 13)}</button>
      <button class="icon-btn sm" data-it-del="${it.id}">${icon('close', 12)}</button>
    </div>`).join('');
    wrap.querySelectorAll('[data-it-edit]').forEach((b) => {
      const it = nd.items.find((x) => String(x.id) === b.dataset.itEdit);
      b.onclick = () => itemEditor(id, r.start_date, it, refresh);
    });
    wrap.querySelectorAll('[data-it-del]').forEach((b) => {
      b.onclick = async () => {
        await api.del('/trip/items/' + b.dataset.itDel); refresh();
      };
    });
  }
  function paintSum(nd) {
    const c = nd.calc;
    body.querySelector('#sum').innerHTML = `
      <div class="ts-mileage-separate">
        <div class="ts-line"><span>车辆里程费用（单独统计，不计入报销）</span><b>¥${money2(c.vehicleFee)}</b></div>
        <div class="tiny muted">${money2(c.km)} km × ¥${money2(c.kmRate)} / km · 驾驶人员：${esc(nd.driver || '未填写')}</div>
      </div>
      <div class="ts-line"><span>实报实销</span><b>¥${money2(c.realTotal)}</b></div>
      <div class="ts-line"><span>补贴（伙食 ${money2(c.food)} + 市内交通 ${money2(c.local)}）</span><b>¥${money2(c.subsidyTotal)}</b></div>
      ${c.advance > 0 ? `<div class="ts-line"><span>预借 / 垫付</span><b style="color:var(--amber)">−¥${money2(c.advance)}</b></div>` : ''}
      <div class="ts-total"><span>应到手</span><b>¥${money2(c.net)}</b></div>
      ${c.bigMissingCount ? `<div class="ts-warn">${icon('alert', 13)} 有 ${c.bigMissingCount} 笔大额（住宿/交通 ≥100 元）没票，建议补票再交</div>` : (c.missingCount ? `<div class="ts-hint">${c.missingCount} 笔无票（补贴不需要票，其余建议补齐）</div>` : '')}`;
  }
  paintItems(r);
  paintSum(r);
}

/* 单笔明细编辑 */
function itemEditor(tripId, defDate, it, done) {
  const body = el(`<div class="sheet-body">
    <div class="form-grid">
      <div class="field"><label class="field-label">类别</label>
        <select class="input" id="kind">${TRIP_KIND.map(([k, l]) => `<option value="${k}" ${it?.kind === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="field"><label class="field-label">日期</label><input class="input" type="date" id="date" value="${esc(it?.date || defDate || ymd(new Date()))}"></div>
      <div class="field"><label class="field-label">金额（元）</label><input class="input" type="number" id="amt" value="${it?.amount ?? ''}" placeholder="0"></div>
      <div class="field"><label class="field-label">有没有发票</label>
        <select class="input" id="has"><option value="1" ${it?.has_invoice === 0 ? '' : 'selected'}>有票</option><option value="0" ${it?.has_invoice === 0 ? 'selected' : ''}>没票</option></select></div>
    </div>
    <div class="field"><label class="field-label">说明</label><input class="input" id="note" value="${esc(it?.note || '')}"></div>
    <div class="confirm-actions"><button class="btn ghost" id="c">取消</button><button class="btn primary" id="k">${it ? '保存' : '添加'}</button></div>
  </div>`);
  const s = sheet({ title: it ? '编辑这一笔' : '加一笔支出', body });
  body.querySelector('#c').onclick = s.close;
  body.querySelector('#k').onclick = async () => {
    const payload = {
      kind: body.querySelector('#kind').value,
      date: body.querySelector('#date').value,
      amount: Number(body.querySelector('#amt').value) || 0,
      note: body.querySelector('#note').value,
      has_invoice: Number(body.querySelector('#has').value),
    };
    if (!payload.amount) return toast('金额要填', 'err');
    try {
      if (it) await api.patch('/trip/items/' + it.id, payload);
      else await api.post(`/trip/${tripId}/items`, payload);
      s.close(); done();
    } catch (e) { toast(e.message, 'err'); }
  };
}

export async function uploadTo(ownerType, ownerId, done) {
  const input = document.createElement('input');
  input.type = 'file'; input.multiple = true; input.accept = 'image/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.zip';
  input.onchange = async () => {
    if (!input.files.length) return;
    const fd = new FormData();
    for (const f of input.files) fd.append('files', f, f.name);
    fd.append('owner_type', ownerType); fd.append('owner_id', String(ownerId));
    try { await api.req('POST', '/upload', fd); toast('已上传 ' + input.files.length + ' 个文件'); done?.(); }
    catch (e) { toast(e.message, 'err'); }
  };
  // 支持粘贴截图
  document.addEventListener('paste', onPasteOnce, { once: true });
  const onPasteOnce = async (ev) => {
    const items = [...(ev.clipboardData?.items || [])].filter((i) => i.type.startsWith('image/'));
    if (!items.length) return;
    const fd = new FormData();
    items.forEach((it, i) => fd.append('files', it.getAsFile(), `截图${Date.now()}-${i}.png`));
    fd.append('owner_type', ownerType); fd.append('owner_id', String(ownerId));
    await api.req('POST', '/upload', fd);
    toast('已粘贴上传截图'); done?.();
  };
  input.click();
}

function tripEditor(row, reload) {
  const isNew = !row;
  const kmRate = row?.km_rate != null && row.km_rate !== '' && Number.isFinite(Number(row.km_rate))
    ? Math.max(0, Number(row.km_rate))
    : 1;
  const body = el(`<div class="sheet-body">
    <div class="sec-title">01 · 基本行程</div>
    <div class="form-grid">
      <div class="field"><label class="field-label">出差开始日期</label><input class="input" type="date" id="sd" value="${esc(row?.start_date || ymd(new Date()))}"></div>
      <div class="field"><label class="field-label">出差结束日期</label><input class="input" type="date" id="ed" value="${esc(row?.end_date || '')}"></div>
      <div class="field"><label class="field-label">出发地点</label><input class="input" id="from" value="${esc(row?.from_place || '学校')}"></div>
      <div class="field"><label class="field-label">目的地</label><input class="input" id="to" value="${esc(row?.to_place || '')}" placeholder="例如：郑州"></div>
    </div>
    <div class="field"><label class="field-label">出差事由</label><input class="input" id="reason" value="${esc(row?.reason || '')}" placeholder="填写本次出差的具体原因"></div>

    <div class="sec-title" style="margin-top:18px">02 · 出差人员</div>
    <div class="form-grid">
      <div class="field"><label class="field-label">驾驶人员</label><input class="input" id="driver" value="${esc(row?.driver || '')}" placeholder="填写实际开车老师姓名"></div>
      <div class="field"><label class="field-label">随行人员</label><input class="input" id="comp" value="${esc(row?.companions || '')}" placeholder="多人可用顿号分隔"></div>
    </div>

    <div class="sec-title" style="margin-top:18px">03 · 车辆里程费用 <span class="tiny muted">（单独统计）</span></div>
    <div class="trip-mileage-editor">
      <div class="form-grid">
        <div class="field"><label class="field-label">实际行驶公里数</label><input class="input" type="number" min="0" step="0.1" id="km" value="${row?.km ?? 0}" placeholder="输入公里数"></div>
        <div class="field"><label class="field-label">里程费率</label><div class="trip-rate-static">¥${money2(kmRate)} / 公里 <span>默认标准 1 元/公里</span></div></div>
      </div>
      <div class="trip-mileage-preview" id="vehicle-preview">
        <span>车辆里程费用（不计入报销总额）</span>
        <strong>¥${money2((Number(row?.km) || 0) * kmRate)}</strong>
      </div>
    </div>

    <div class="sec-title" style="margin-top:18px">04 · 其他费用报销 <span class="tiny muted">（原有报销项目保留）</span></div>
    <div class="form-grid">
      <div class="field"><label class="field-label">交通（车票 / 机票）</label><input class="input" type="number" min="0" step="0.01" id="transport" value="${row?.transport ?? 0}"></div>
      <div class="field"><label class="field-label">住宿</label><input class="input" type="number" min="0" step="0.01" id="hotel" value="${row?.hotel ?? 0}"></div>
      <div class="field"><label class="field-label">市内打车</label><input class="input" type="number" min="0" step="0.01" id="taxi" value="${row?.taxi ?? 0}"></div>
      <div class="field"><label class="field-label">过路费</label><input class="input" type="number" min="0" step="0.01" id="toll" value="${row?.toll ?? 0}"></div>
      <div class="field"><label class="field-label">停车费</label><input class="input" type="number" min="0" step="0.01" id="park" value="${row?.parking ?? 0}"></div>
      <div class="field"><label class="field-label">其他费用</label><input class="input" type="number" min="0" step="0.01" id="other" value="${row?.other ?? 0}"></div>
    </div>
    <div class="tiny muted" style="margin:-4px 0 4px">费用明细、发票上传和复制报销单功能保持不变；车辆里程费用不并入上述报销费用。</div>

    <div class="sec-title" style="margin-top:18px">05 · 结算与状态</div>
    <div class="form-grid">
      <div class="field"><label class="field-label">预借金额（从报销金额中扣除）</label><input class="input" type="number" min="0" step="0.01" id="advance" value="${row?.advance ?? 0}"></div>
      <div class="field"><label class="field-label">审批状态</label><select class="input" id="status">
        ${[['draft', '草稿'], ['submitted', '已提交（待领导审核）'], ['approved', '已审核'], ['rejected', '被驳回']].map(([v, l]) => `<option value="${v}" ${row?.status === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="field"><label class="field-label">报销状态</label><select class="input" id="rstat">
        ${[['draft', '未提交'], ['submitted', '已交财务'], ['paid', '已到账']].map(([v, l]) => `<option value="${v}" ${row?.reimb_status === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    </div>
    <div class="field"><label class="field-label">审核意见</label><input class="input" id="anote" value="${esc(row?.approve_note || '')}"></div>
    ${remarkField({ value: row?.remark || '', rows: 2, placeholder: '补充其他说明' })}
    <div class="confirm-actions">${isNew ? '' : '<button class="btn ghost" id="del" style="margin-right:auto;color:var(--red)">删除</button>'}
      <button class="btn ghost" id="c">取消</button><button class="btn primary" id="k">保存</button></div>
  </div>`);
  const s = sheet({ title: isNew ? '记录出差' : '编辑出差', body, wide: true });
  body.querySelector('#c').onclick = s.close;
  body.querySelector('#del')?.addEventListener('click', async () => {
    if (await confirmDialog('删除这条出差记录？')) { await api.del('/trips/' + row.id); s.close(); toast('已删除'); reload(); }
  });
  const num = (id) => Number(body.querySelector('#' + id).value) || 0;
  const updateVehiclePreview = () => {
    const fee = Math.round(num('km') * kmRate * 100) / 100;
    body.querySelector('#vehicle-preview').innerHTML = `<span>车辆里程费用（不计入报销总额）</span><strong>¥${money2(fee)}</strong>`;
  };
  body.querySelector('#km').addEventListener('input', updateVehiclePreview);
  body.querySelector('#k').onclick = async () => {
    const toPlace = body.querySelector('#to').value.trim();
    const reason = body.querySelector('#reason').value.trim();
    const driver = body.querySelector('#driver').value.trim();
    if (!toPlace) {
      toast('去哪出差？先填一下目的地', 'warn');
      body.querySelector('#to').focus();
      return;
    }
    if (!body.querySelector('#sd').value) return toast('出差开始日期要填', 'err');
    if (num('km') > 0 && !driver) {
      toast('填写了行驶公里数，请补充实际驾驶人员', 'warn');
      body.querySelector('#driver').focus();
      return;
    }
    const payload = {
      start_date: body.querySelector('#sd').value, end_date: body.querySelector('#ed').value || null,
      from_place: body.querySelector('#from').value.trim(), to_place: toPlace,
      reason, driver, companions: body.querySelector('#comp').value,
      transport: num('transport'), hotel: num('hotel'), taxi: num('taxi'),
      toll: num('toll'), parking: num('park'), other: num('other'),
      advance: num('advance'), km: num('km'), km_rate: kmRate,
      status: body.querySelector('#status').value,
      reimb_status: body.querySelector('#rstat').value,
      approve_note: body.querySelector('#anote').value,
      remark: body.querySelector('#remark').value,
    };
    try {
      const saved = isNew
        ? await api.post('/trips', payload)
        : await api.patch('/trips/' + row.id, payload);
      s.close();
      toast('已保存');
      const savedMonth = String(saved?.start_date || payload.start_date).slice(0, 7);
      await reload(savedMonth);
    } catch (e) { toast(e.message || '保存失败', 'err'); }
  };
}

/* ---------- 课堂签到（教师端） ---------- */
const ROLL_S = { present: ['到了', 'green'], late: ['迟到', 'amber'], leave: ['请假', 'blue'], absent: ['未到', 'red'] };
function rollRowHtml(x) {
  const st = x.stats || {};
  const signed = (st.present || 0) + (st.late || 0);
  const total = x.roster_count || x.expect || 0;
  const pct = total ? Math.round(signed / total * 100) : 0;
  return `<div class="roll-row${x.status === 'open' ? ' live' : ''}" data-roll-row="${x.id}">
    <div class="rr-main">
      <span class="rr-cls">${esc(clsName(x.grade, x.class_name))}</span>
      ${x.period_no ? `<span class="chip grey">第${x.period_no}节</span>` : ''}
      ${x.status === 'open' ? '<span class="chip green">进行中</span>' : '<span class="chip grey">已结束</span>'}
      <span class="rr-num"><b data-n="signed">${signed}</b>/<span data-n="total">${total}</span></span>
      <span class="tiny" data-n="late" style="color:var(--amber);${st.late ? '' : 'display:none'}">迟到 ${st.late || 0}</span>
      <span class="tiny muted" data-n="leave" style="${st.leave ? '' : 'display:none'}">请假 ${st.leave || 0}</span>
      <span class="rr-bar"><i data-n="bar" style="width:${pct}%"></i></span>
    </div>
    <div class="rr-btns">
      <button class="btn ghost sm" data-roll-detail="${x.id}">看明细</button>
      ${x.status === 'open' ? `<button class="btn ghost sm" data-roll-close="${x.id}">结束</button>` : ''}
    </div>
  </div>`;
}
function paintRollCard(sessions, rosters) {
  const live = sessions.filter((x) => x.status === 'open').length;
  return `<div class="card card-pad roll-card">
    <div class="row wrap" style="gap:10px;align-items:center">
      <div style="flex:1;min-width:180px">
        <div class="bold">${icon('check', 15)} 课堂签到<span class="tiny muted" style="margin-left:6px">${sessions.length ? '今天 ' + sessions.length + ' 场' : '今天还没开始'}</span>
          <span class="live-tag" id="roll-live" ${live ? '' : 'hidden'}><i></i>实时</span></div>
        <div class="small muted">开始后学生打开短链点「我到了」，这里实时长出人数。</div>
      </div>
      <button class="btn primary sm" id="roll-open" ${rosters.length ? '' : 'disabled'}>${icon('plus', 15)} 开始签到</button>
    </div>
    ${sessions.length ? `<div class="roll-list">${sessions.map(rollRowHtml).join('')}</div>` : ''}
  </div>`;
}
/* 轮询只改数字，不动 DOM 结构：不打断按钮、不丢滚动位置、不闪 */
function applyRollStats(sessions) {
  let live = 0;
  for (const x of sessions) {
    if (x.status === 'open') live++;
    const row = document.querySelector(`[data-roll-row="${x.id}"]`);
    if (!row) continue;
    const st = x.stats || {};
    const signed = (st.present || 0) + (st.late || 0);
    const total = x.roster_count || x.expect || 0;
    const set = (k, v) => { const e = row.querySelector(`[data-n="${k}"]`); if (e && e.textContent !== String(v)) e.textContent = v; };
    set('signed', signed);
    set('total', total);
    const lateEl = row.querySelector('[data-n="late"]');
    if (lateEl) {
      if (st.late) { lateEl.style.display = ''; if (lateEl.textContent !== `迟到 ${st.late}`) lateEl.textContent = `迟到 ${st.late}`; }
      else lateEl.style.display = 'none';
    }
    const leaveEl = row.querySelector('[data-n="leave"]');
    if (leaveEl) {
      if (st.leave) { leaveEl.style.display = ''; if (leaveEl.textContent !== `请假 ${st.leave}`) leaveEl.textContent = `请假 ${st.leave}`; }
      else leaveEl.style.display = 'none';
    }
    const bar = row.querySelector('[data-n="bar"]');
    if (bar) bar.style.width = (total ? Math.round(signed / total * 100) : 0) + '%';
    // 数字变了给一下高亮，让老师看得出「刚刚有人签到」
    if (signed !== Number(row.dataset.lastSigned ?? signed)) {
      row.classList.remove('bump');
      void row.offsetWidth;   // 强制回流，让动画能重放
      row.classList.add('bump');
      row.dataset.lastSigned = signed;
    }
  }
  const tag = document.querySelector('#roll-live');
  if (tag) tag.hidden = !live;
}

/* ================= 抽人（第 19 条） =================
   用户原话：「抽人改成自己填班级 + 人数 + 抽几个，按号码抽」。

   原来的问题是：抽人绑死在「班级名册」上，没有名册就抽不了；
   而且抽出来的是姓名，课堂上点名不方便 —— 老师喊的是「3 号」，
   学生看的是自己座位号 / 学号。

   所以这里完全按用户说的做：
     · 班级随便填（有名册就下拉选，没有就直接打字）；
     · 人数自己填（40 人），不需要提前导入名单；
     · 抽几个自己填（1~N）；
     · 按 1~人数 的号码抽，结果同时显示号码和姓名（名册里有对应就叫名字）。
   号码和名册的对应关系：名册第 k 个 = k 号。这样不用额外维护学号字段，
   名册顺序就是座位号顺序，跟老师手里的点名册一致。 */
function paintPickCard(rosters) {
  return `<div class="card card-pad pick-card">
    <div class="row wrap" style="gap:10px;align-items:center">
      <div style="flex:1;min-width:180px">
        <div class="bold">${icon('user', 15)} 抽人
          <span class="tiny muted" style="margin-left:6px">按号码抽，不重复</span></div>
        <div class="small muted">填班级和人数，选抽几个，点一下就抽。</div>
      </div>
      <button class="btn primary sm" id="pick-open">${icon('refresh', 15)} 开始抽</button>
    </div>
  </div>`;
}

function pickStudentDialog(rosters) {
  const body = el(`<div class="sheet-body">
    <div class="form-grid">
      <div class="field"><label class="field-label">班级</label>
        <input class="input" id="pk-cls" list="pk-cls-list" value="${esc(rosters[0] ? clsName(rosters[0].grade, rosters[0].class_name) : '')}">
        <datalist id="pk-cls-list">${rosters.map((r) => `<option>${esc(clsName(r.grade, r.class_name))}</option>`).join('')}</datalist></div>
      <div class="field"><label class="field-label">总人数</label>
        <input class="input" id="pk-total" type="number" min="1" max="200" value="${esc(String(rosters[0]?.count || 40))}" inputmode="numeric"></div>
    </div>
    <div class="form-grid">
      <div class="field"><label class="field-label">抽几个</label>
        <input class="input" id="pk-n" type="number" min="1" max="50" value="1" inputmode="numeric"></div>
      <div class="field"><label class="field-label">已抽过的</label>
        <div class="row" style="gap:8px;align-items:center;height:38px">
          <label class="row" style="gap:6px;align-items:center;font-size:13px">
            <input type="checkbox" id="pk-norepeat" checked> 不重复抽
          </label>
          <button class="btn ghost sm" id="pk-reset" style="margin-left:auto">重置</button>
        </div></div>
    </div>
    <div class="pk-stage" id="pk-stage">
      <div class="pk-hint">点下面的按钮开始</div>
    </div>
    <div class="pk-history-wrap">
      <div class="tiny muted" id="pk-his-tip">这轮还没抽</div>
      <div class="row wrap" id="pk-history" style="gap:6px;margin-top:6px"></div>
    </div>
    <div class="confirm-actions"><button class="btn ghost" id="pk-close">关闭</button>
      <button class="btn primary" id="pk-go">${icon('refresh', 15)} 抽</button></div>
  </div>`);
  const s = sheet({ title: '抽人', body, wide: true });
  const $ = (q) => body.querySelector(q);
  const stage = $('#pk-stage');
  const drawn = [];        // 已抽出的号码（跨次累积，用于「不重复」）

  /* 名册：班级名对上就取名字，对不上就只显示号码。
     优先精确匹配「高二(3)班」，其次按 grade+class_name 拼出来的名字匹配。 */
  const namesFor = (cls) => {
    const hit = rosters.find((r) => clsName(r.grade, r.class_name) === cls) || rosters.find((r) => r.class_name === cls);
    return Array.isArray(hit?.names) ? hit.names : [];
  };
  const totalOf = () => {
    const n = Number($('#pk-total').value);
    return Number.isFinite(n) && n > 0 ? Math.min(200, Math.floor(n)) : 0;
  };

  /* 选班级时自动带出人数：名册里有 count 就用它，省得用户再数一遍 */
  $('#pk-cls').onchange = () => {
    const names = namesFor($('#pk-cls').value);
    if (names.length) $('#pk-total').value = String(names.length);
  };

  const paintHis = () => {
    const names = namesFor($('#pk-cls').value);
    $('#pk-his-tip').textContent = drawn.length ? `这轮已抽 ${drawn.length} 个` : '这轮还没抽';
    $('#pk-history').innerHTML = drawn.map((no, i) => `<span class="pk-chip">
      <b>${no}</b>${names[no - 1] ? `<i>${esc(names[no - 1])}</i>` : ''}
      <button data-un="${i}" title="撤销这个">×</button></span>`).join('');
    $('#pk-history').querySelectorAll('[data-un]').forEach((b) => {
      b.onclick = () => { drawn.splice(Number(b.dataset.un), 1); paintHis(); };
    });
  };

  /* 抽签：从 1..total 里排除已抽过的，用 crypto 取随机数。
     不用 Math.random 是因为它的种子可预测，连着抽会出现明显规律；
     课堂上「怎么又是 3 号」是要被学生起哄的。 */
  const randInt = (max) => {
    if (window.crypto?.getRandomValues) {
      const a = new Uint32Array(1);
      const lim = Math.floor(0xFFFFFFFF / max) * max;
      let v = 0;
      do { window.crypto.getRandomValues(a); v = a[0]; } while (v >= lim);
      return v % max;
    }
    return Math.floor(Math.random() * max);
  };

  const go = async () => {
    const total = totalOf();
    const want = Math.max(1, Math.min(50, Number($('#pk-n').value) || 1));
    if (!total) return toast('先填总人数', 'warn');
    const noRepeat = $('#pk-norepeat').checked;
    const pool = [];
    for (let i = 1; i <= total; i += 1) if (!noRepeat || !drawn.includes(i)) pool.push(i);
    if (!pool.length) {
      stage.innerHTML = `<div class="pk-hint pk-done">1~${total} 号都抽完了，点「重置」重新开始</div>`;
      return;
    }
    const pickCount = Math.min(want, pool.length);
    const picked = [];
    for (let i = 0; i < pickCount; i += 1) {
      const k = randInt(pool.length);
      picked.push(pool[k]);
      pool.splice(k, 1);       // 同一次里也不重复
    }
    /* 滚动动画：号码快速跳 600ms 再定格。
       不是为了炫，是为了「抽」这个动作有过程感 —— 直接出结果像内定的。 */
    stage.innerHTML = `<div class="pk-roll"><span id="pk-roll-num">?</span></div>`;
    const spin = $('#pk-roll-num');
    const t0 = Date.now();
    const timer = setInterval(() => {
      spin.textContent = String(1 + randInt(total));
    }, 55);
    await new Promise((r) => setTimeout(r, 620));
    clearInterval(timer);
    void t0;
    const names = namesFor($('#pk-cls').value);
    stage.innerHTML = `<div class="pk-result">
      ${picked.map((no) => `<div class="pk-one">
        <span class="pk-no">${no}</span>
        <span class="pk-name">${names[no - 1] ? esc(names[no - 1]) : '<i class="muted">未在名册</i>'}</span>
      </div>`).join('')}
    </div>`;
    picked.forEach((no) => { if (!drawn.includes(no)) drawn.push(no); });
    paintHis();
  };

  $('#pk-go').onclick = go;
  $('#pk-reset').onclick = () => {
    drawn.length = 0;
    stage.innerHTML = '<div class="pk-hint">点下面的按钮开始</div>';
    paintHis();
  };
  $('#pk-close').onclick = s.close;
  paintHis();
}

/* 惩罚盲盒：学生抽到什么，这里能看到；任务清单也在这里维护 */
const LV_TXT = { light: '轻松', average: '有点挑战', heavy: '大冒险' };
const LV_COLOR = { light: 'green', average: 'amber', heavy: 'red' };
function paintPunishCard(items, records) {
  const today = records.filter((r) => r.source === 'student');
  return `<div class="card card-pad punish-card">
    <div class="row wrap" style="gap:10px;align-items:center">
      <div style="flex:1;min-width:180px">
        <div class="bold">${icon('gift', 15)} 惩罚盲盒<span class="tiny muted" style="margin-left:6px">${items.length} 个任务</span></div>
        <div class="small muted">学生点「抽任务」随机弹一个，抽到什么这里立刻能看到。</div>
      </div>
      <button class="btn ghost sm" id="pb-add">${icon('plus', 15)} 加任务</button>
      ${items.length ? `<button class="btn ghost sm" id="pb-seed">补经典任务</button>` : ''}
    </div>
    ${items.length ? `<div class="pb-list">
      ${items.map((p) => `<div class="pb-row">
        <span class="chip ${LV_COLOR[p.level] || 'grey'}">${LV_TXT[p.level] || '任务'}</span>
        <span class="pb-text">${esc(p.text)}</span>
        <button class="icon-btn sm" data-pb-edit="${p.id}">${icon('edit', 14)}</button>
        <button class="icon-btn sm" data-pb-del="${p.id}">${icon('close', 13)}</button>
      </div>`).join('')}
    </div>` : '<div class="empty" style="padding:18px 0">还没有任务，点「加任务」或「补默认任务」开始</div>'}
    ${today.length ? `<div class="pb-recent">
      <div class="tiny muted" style="margin:10px 0 6px">今天学生抽到的（${today.length} 条）</div>
      ${today.slice(0, 6).map((r) => `<div class="pb-rec">
        <span class="chip ${r.stu_name ? 'blue' : 'grey'}">${esc(r.stu_name || '匿名')}</span>
        <span class="pb-rtext">${esc(r.text)}</span>
        <span class="tiny muted">${esc(fmtTime(r.created_at))}</span>
      </div>`).join('')}
    </div>` : ''}
  </div>`;
}
/* 抽任务弹层：标题 + 等级 */
function punishEditor(p, reload) {
  const body = el(`<div class="sheet-body">
    <div class="field"><label class="field-label">任务内容</label>
      <input class="input" id="t" value="${esc(p?.text || '')}"></div>
    <div class="field"><label class="field-label">强度</label>
      <select class="input" id="lv">
        <option value="light" ${p?.level === 'light' || !p ? 'selected' : ''}>轻松（唱歌、讲笑话）</option>
        <option value="average" ${p?.level === 'average' ? 'selected' : ''}>有点挑战（领读、讲题）</option>
        <option value="heavy" ${p?.level === 'heavy' ? 'selected' : ''}>大冒险（深蹲 20 个、下节课复盘）</option>
      </select></div>
    <div class="confirm-actions"><button class="btn ghost" id="cancel">取消</button>
      <button class="btn primary" id="ok">${p ? '保存' : '添加'}</button></div>
  </div>`);
  const s = sheet({ title: p ? '编辑任务' : '新增任务', body });
  body.querySelector('#cancel').onclick = () => s.close();
  body.querySelector('#ok').onclick = async () => {
    const text = body.querySelector('#t').value.trim();
    if (!text) return toast('先写上任务内容', 'err');
    const level = body.querySelector('#lv').value;
    try {
      if (p) await api.patch('/punishments/' + p.id, { text, level });
      else await api.post('/punishments', { text, level, active: 1 });
      s.close(); toast(p ? '已保存' : '已添加'); reload();
    } catch (e) { toast(e.message, 'err'); }
  };
}

function openRollDialog(rosters, reload) {
  const now = new Date();
  const body = el(`<div class="sheet-body">
    <div class="field"><label class="field-label">哪个班</label>
      <select class="input" id="rid">${rosters.map((r) => `<option value="${r.id}">${esc(clsName(r.grade, r.class_name))}（${r.count} 人）</option>`).join('')}</select></div>
    <div class="form-grid">
      <div class="field"><label class="field-label">第几节</label>
        <select class="input" id="per">${[1,2,3,4,5,6,7,8].map((n) => `<option value="${n}" ${n === 3 ? 'selected' : ''}>第 ${n} 节</option>`).join('')}</select></div>
      <div class="field"><label class="field-label">日期</label><input class="input" type="date" id="dt" value="${esc(ymd(now))}"></div>
    </div>
    ${remarkField({ id: 'note', placeholder: '如 早读 / 单元测验', hint: '可不填，会显示在签到页上' })}
    <div class="field-hint">开好后把短链发给学生，或者投到教室大屏上让学生扫码。同一班同一节重复开始会接上原来那场。</div>
    <div class="confirm-actions"><button class="btn ghost" id="c">取消</button><button class="btn primary" id="k">开始签到</button></div>
  </div>`);
  const s = sheet({ title: '开始课堂签到', body });
  body.querySelector('#c').onclick = s.close;
  body.querySelector('#k').onclick = async () => {
    try {
      await api.post('/roll/open', {
        roster_id: Number(body.querySelector('#rid').value),
        period_no: Number(body.querySelector('#per').value),
        date: body.querySelector('#dt').value,
        note: body.querySelector('#note').value,
      });
      s.close(); toast('签到已开始，学生现在可以点了'); reload();
    } catch (e) { toast(e.message || '开启失败', 'err'); }
  };
}

/* 明细里的名单区（已签 + 未到），轮询时会整块重绘，所以单独抽出来 */
function rdBodyHtml(recs, missing) {
  return `${recs.length ? `<div class="rd-list">
      ${recs.map((r) => `<div class="rd-i">
        <span class="rd-name">${esc(r.stu_name || r.stu_no || '')}</span>
        <span class="chip ${ROLL_S[r.status]?.[1] || 'grey'}">${ROLL_S[r.status]?.[0] || r.status}</span>
        ${r.source === 'teacher' ? '<span class="tiny muted">老师标记</span>' : ''}
      </div>`).join('')}
    </div>` : '<div class="empty" style="padding:18px 0">还没有人签到</div>'}
    ${missing.length ? `<div class="rd-miss"><div class="rd-miss-h">名单里还没到的 ${missing.length} 人</div>
      <div class="rd-miss-l">${missing.map((n) => `<span class="rd-chip">${esc(n)}</span>`).join('')}</div>
      <div class="tiny muted" style="margin-top:8px">点名字可以代标「已到 / 请假」，补录用</div></div>` : ''}`;
}
/* 未到名单上的名字可点，代标状态 */
function bindMissing(scope, id, s, reload) {
  scope.querySelectorAll('.rd-chip').forEach((c) => {
    c.onclick = async () => {
      const name = c.textContent;
      const pick = await askStatus();
      if (!pick) return;
      try {
        await api.post(`/roll/sessions/${id}/mark`, { stu_name: name, status: pick });
        s.close(); toast(`${name} 已标为${ROLL_S[pick][0]}`); rollDetail(id, reload); reload();
      } catch (e) { toast(e.message, 'err'); }
    };
  });
}
async function rollDetail(id, reload) {
  let d;
  try { d = await api.get('/roll/sessions/' + id); } catch (e) { toast(e.message, 'err'); return; }
  const st = d.session;
  const recs = d.records || [];
  const bySt = (k) => recs.filter((r) => r.status === k);
  const missing = d.missing || [];
  const body = el(`<div class="sheet-body">
    <div class="row wrap" style="gap:8px;align-items:center;margin-bottom:12px">
      <div class="bold" style="font-size:16px">${esc(clsName(st.grade, st.class_name))}</div>
      ${st.period_no ? `<span class="chip grey">第${st.period_no}节</span>` : ''}
      <span class="chip ${st.status === 'open' ? 'green' : 'grey'}">${st.status === 'open' ? '进行中' : '已结束'}</span>
      <span class="live-tag" id="rd-live" ${st.status === 'open' ? '' : 'hidden'}><i></i>实时</span>
      <span class="tiny muted">${esc(st.date)}${st.note ? ' · ' + esc(st.note) : ''}</span>
    </div>
    <div class="rd-cards" id="rd-cards">
      ${['present', 'late', 'leave'].map((k) => `<div class="rd-c rd-${k}"><div class="rd-n" data-c="${k}">${bySt(k).length}</div>
        <div class="rd-l">${ROLL_S[k][0]}</div></div>`).join('')}
      <div class="rd-c rd-absent"><div class="rd-n" data-c="absent">${missing.length}</div><div class="rd-l">未到</div></div>
    </div>
    <div id="rd-body">${rdBodyHtml(recs, missing)}</div>
    <div class="confirm-actions"><button class="btn ghost" id="c">关闭</button></div>
  </div>`);
  let stopDetail = null;
  const s = sheet({ title: '签到明细', body, wide: true, onClose: () => stopDetail?.() });
  body.querySelector('#c').onclick = s.close;

  /* 明细里也实时：进行中时每 3 秒拉一次，关掉弹层就停 */
  if (st.status === 'open') {
    stopDetail = startPoll(async () => {
      const nd = await api.get('/roll/sessions/' + id);
      const nrecs = nd.records || [];
      const nmiss = nd.missing || [];
      for (const k of ['present', 'late', 'leave']) {
        const cell = body.querySelector(`[data-c="${k}"]`);
        const v = nrecs.filter((r) => r.status === k).length;
        if (cell && cell.textContent !== String(v)) cell.textContent = v;
      }
      const ab = body.querySelector('[data-c="absent"]');
      if (ab && ab.textContent !== String(nmiss.length)) ab.textContent = nmiss.length;
      // 名单有变化才重绘列表（这块不会有人正在输入，重绘安全）
      const sig = (rs) => rs.map((r) => r.stu_key + r.status).join(',');
      if (sig(nrecs) !== sig(recs)) {
        recs.length = 0; recs.push(...nrecs);
        missing.length = 0; missing.push(...nmiss);
        body.querySelector('#rd-body').innerHTML = rdBodyHtml(recs, missing);
        bindMissing(body, id, s, reload);
      }
      if (nd.session.status !== 'open') { const t = body.querySelector('#rd-live'); if (t) t.hidden = true; }
    });
  }
  bindMissing(body, id, s, reload);
}
function askStatus() {
  return new Promise((resolve) => {
    const body = el(`<div class="sheet-body"><div class="col">
      <button class="btn ghost block" data-p="present">已到</button>
      <button class="btn ghost block" data-p="late">迟到</button>
      <button class="btn ghost block" data-p="leave">请假</button>
      <button class="btn ghost block" data-p="absent">算缺勤</button></div></div>`);
    const s = sheet({ title: '改成什么状态', body });
    body.querySelectorAll('[data-p]').forEach((b) => {
      b.onclick = () => { s.close(); resolve(b.dataset.p); };
    });
  });
}

/* ================= 学生页面的三个模块（小助手下面的二级入口） =================
   教材 / 抽人 / 盲盒，对应 student.html 顶部的三个页签：
     material → 老师在「课件」里上传、勾了「学生可见」的资料
     roll     → 抽人（按号码或按名单，不重复）
     punish   → 惩罚盲盒（点一下随机弹一个任务）
   二级页面不做「学生页的复刻」，而是给这三件事做后台：
   看学生到底能拿到什么、把要用的东西配好、看用了几次。
   自习那个模块因为本身就是「开一场签到 + 看名单」，逻辑更重，
   单独放在 selfstudy.js 里（见 renderSelfstudyBody）。 */
const STUDENT_MOD = {
  textbook: {
    name: '教材', icon: 'book', tab: 'material',
    desc: '学生打开短链后看到的「课件」页，内容来自你勾了「学生可见」的资料。',
  },
  pick: {
    name: '抽人', icon: 'dice', tab: 'roll',
    desc: '学生端那台设备上的抽人转盘：填班级和人数，点一下滚出号码或名字。',
  },
  mystery: {
    name: '盲盒', icon: 'gift', tab: 'punish',
    desc: '学生点「抽任务」随机弹一个。这一轮不重复，抽完自动洗牌。',
  },
};

/* 名单字段在库里可能是两种形态：JSON 数组（导入班级时写入）、
   或者「张一诺,李晨阳」这种逗号串（种子数据与手工录的一条就写成了这样）。
   以前只有抽人弹层里 JSON.parse 一处，串形态直接抛 SyntaxError，
   整页白屏。统一走这个函数，解析不了就按分隔符切开。 */
function parseNames(raw) {
  if (Array.isArray(raw)) return raw.filter(Boolean);
  const s = String(raw ?? '').trim();
  if (!s) return [];
  if (s.startsWith('[')) { try { return (JSON.parse(s) || []).filter(Boolean); } catch { /* 落到下面按分隔符切 */ } }
  return s.split(/[\n,，、;；\s]+/).map((x) => x.trim()).filter(Boolean);
}

async function renderStudentModule(box, key) {
  const meta = STUDENT_MOD[key];
  const [links, mats, rosters, punishes, punRecs, rollSess] = await Promise.all([
    api.get('/links').catch(() => []),
    api.get('/materials').catch(() => []),
    api.get('/rosters').catch(() => []),
    api.get('/punishments').catch(() => []),
    api.get('/punish/records', { date: ymd(new Date()) }).catch(() => []),
    api.get('/roll/sessions').catch(() => []),
  ]);
  const link = links[0];
  const pubMats = mats.filter((m) => Number(m.public) !== 0);

  /* 顶部：这个模块在学生那边长什么样 */
  box.innerHTML = `
    <div class="card card-pad" style="margin-bottom:14px;background:var(--primary-weak);border-color:transparent">
      <div class="row wrap" style="gap:10px">
        <div style="flex:1;min-width:200px">
          <div class="bold">${icon(meta.icon, 15)} 学生端「${esc(meta.name)}」</div>
          <div class="small muted" style="margin-top:3px">${esc(meta.desc)}</div>
        </div>
        ${link
      ? `<code class="mono link-short" title="${esc(studentUrl(link.code))}">${esc(shortPath(link.code))}</code>
             <button class="btn ghost sm" id="sm-copy">${icon('copy', 14)} 复制</button>
             <a class="btn ghost sm" href="${esc(studentUrl(link.code))}" target="_blank" rel="noopener">打开学生页</a>`
      : '<button class="btn primary sm" id="sm-mklink">生成学生链接</button>'}
      </div>
      <div class="field-hint" style="margin-top:10px">
        学生打开上面的地址 → 顶部点「${esc(meta.name)}」→ 就是这个模块。学生不用登录，也不需要装 App。
      </div>
    </div>
    <div id="sm-body"></div>`;

  box.querySelector('#sm-copy')?.addEventListener('click', async () => {
    const url = studentUrl(link.code);
    try { await syncMaterialSharing(); } catch (error) { toast(error.message || '链接尚未同步，请稍后重试', 'err'); return; }
    try { await navigator.clipboard.writeText(url); toast('已复制，发到班级群就行'); } catch { prompt('复制下面的链接', url); }
  });
  box.querySelector('a[href*="student.html"]')?.addEventListener('click', async event => {
    event.preventDefault();
    const opened = window.open('about:blank', '_blank');
    if (opened) opened.opener = null;
    try { await syncMaterialSharing(); if (opened) opened.location.replace(studentUrl(link.code)); else location.href = studentUrl(link.code); }
    catch (error) { opened?.close(); toast(error.message || '链接尚未同步，请稍后重试', 'err'); }
  });
  saving(box.querySelector('#sm-mklink'), async () => {
    await api.post('/links', { title: '班级资料站' });
    await syncMaterialSharing();
    await renderStudentModule(box, key);
  });

  const inner = box.querySelector('#sm-body');

  if (key === 'textbook') {
    /* —— 教材：其实就是在管「哪些资料对学生可见」 —— */
    inner.innerHTML = `
      <div class="rp-stats mod-stats" style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px">
        <div class="card card-pad"><div class="tiny muted">资料总数</div>
          <div style="font-size:24px;font-weight:700">${mats.length}</div></div>
        <div class="card card-pad"><div class="tiny muted">学生能看到的</div>
          <div style="font-size:24px;font-weight:700;color:var(--green)">${pubMats.length}</div></div>
        <div class="card card-pad"><div class="tiny muted">仅自己可见</div>
          <div style="font-size:24px;font-weight:700;color:var(--amber)">${mats.length - pubMats.length}</div></div>
      </div>
      <div class="row wrap" style="gap:8px;margin:16px 0 10px">
        <button class="btn primary sm" id="tb-up">${icon('upload', 15)} 上传资料</button>
        <span style="flex:1"></span>
        <span class="tiny muted">点标题右侧的开关可以随时收回</span>
      </div>
      <div class="card" style="overflow:hidden">
        ${pubMats.length ? pubMats.map((m) => `<div class="list-item">
          <div class="doc-ico">${icon('book', 17)}</div>
          <div style="flex:1;min-width:0">
            <div class="bold">${esc(m.title)}</div>
            <div class="tiny muted">${esc([clsName(m.grade, m.class_name), m.descr || ''].filter(Boolean).join(' · ') || '没有填写说明')}</div>
          </div>
          <span class="chip green">学生可见</span>
          <button class="btn ghost sm" data-unpub="${m.id}">收回</button>
        </div>`).join('') : '<div class="empty">还没有对学生可见的资料，点「上传资料」开始</div>'}
      </div>`;

    inner.querySelector('#tb-up')?.addEventListener('click', () => materialEditor(null, 0, () => renderStudentModule(box, key)));
    inner.querySelectorAll('[data-unpub]').forEach((b) => {
      b.onclick = async () => {
        const m = mats.find((x) => String(x.id) === b.dataset.unpub);
        if (!(await confirmDialog(`把《${m.title}》从学生页面收回？学生就看不到了，文件本身还在。`))) return;
        await api.patch('/materials/' + m.id, { public: 0 });
        await syncMaterialSharing();
        toast('已收回'); renderStudentModule(box, key);
      };
    });
  } else if (key === 'pick') {
    /* —— 抽人 —— */
    const totalNames = rosters.reduce((s, r) => s + (parseNames(r.names).length || Number(r.count) || 0), 0);
    inner.innerHTML = `
      <div class="rp-stats mod-stats" style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px">
        <div class="card card-pad"><div class="tiny muted">可抽班级</div>
          <div style="font-size:24px;font-weight:700">${rosters.length}</div>
          <div class="tiny muted">${rosters.slice(0, 2).map((r) => esc(r.class_name)).join('、') || '没有名单也能按号码抽'}</div></div>
        <div class="card card-pad"><div class="tiny muted">名单人数</div>
          <div style="font-size:24px;font-weight:700">${totalNames}</div>
          <div class="tiny muted">没名单就只能按号码</div></div>
        <div class="card card-pad"><div class="tiny muted">进行中的签到</div>
          <div style="font-size:24px;font-weight:700">${rollSess.filter((s) => s.status === 'open').length}</div>
          <div class="tiny muted">抽人不需要签到</div></div>
      </div>
      <div class="row wrap" style="gap:8px;margin:16px 0 10px">
        <button class="btn primary sm" id="pk-try">${icon('dice', 15)} 在这里试抽一次</button>
        <button class="btn ghost sm" id="pk-ros">${icon('users', 15)} 管理班级名单</button>
      </div>
      <div class="card card-pad">
        <div class="card-title">${icon('users', 16)} 班级名单</div>
        <div class="tiny muted" style="margin:6px 0 10px">名单只影响「按名单名字抽」这一个选项。没有名单，学生页照样能按 1~50 号抽。</div>
        ${rosters.length ? `<div class="pb-list">${rosters.map((r) => {
      const n = parseNames(r.names);
      return `<div class="pb-row">
            <span class="chip blue">${esc(clsName(r.grade, r.class_name))}</span>
            <span class="pb-text">${n.length ? `${n.length} 个名字` : `未导入姓名（按号码抽 ${r.count || 40} 人）`}</span>
            <span class="tiny muted">${n.slice(0, 6).join('、')}${n.length > 6 ? '…' : ''}</span>
          </div>`;
    }).join('')}</div>` : '<div class="empty" style="padding:16px">还没有班级名单</div>'}
      </div>`;

    inner.querySelector('#pk-try')?.addEventListener('click', () => pickStudentDialog(rosters));
    inner.querySelector('#pk-ros')?.addEventListener('click', () => openRosterDialog(rosters, () => renderStudentModule(box, key)));
  } else {
    /* —— 盲盒 —— */
    const today = punRecs.filter((r) => r.source === 'student');
    inner.innerHTML = `
      <div class="rp-stats mod-stats" style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px">
        <div class="card card-pad"><div class="tiny muted">盒子里的任务</div>
          <div style="font-size:24px;font-weight:700">${punishes.length}</div>
          <div class="tiny muted">${punishes.filter((p) => p.level === 'heavy').length} 个是「大冒险」</div></div>
        <div class="card card-pad"><div class="tiny muted">今天被抽中</div>
          <div style="font-size:24px;font-weight:700">${today.length}</div></div>
        <div class="card card-pad"><div class="tiny muted">正在生效</div>
          <div style="font-size:24px;font-weight:700;color:var(--green)">${punishes.filter((p) => Number(p.active) !== 0).length}</div></div>
      </div>
      <div class="row wrap" style="gap:8px;margin:16px 0 4px">
        <button class="btn primary sm" id="mb-add">${icon('plus', 15)} 加任务</button>
        ${punishes.length ? '<button class="btn ghost sm" id="mb-seed">补经典任务</button>' : ''}
        <span style="flex:1"></span>
        <span class="tiny muted">学生那边这一轮不重复，抽完自动洗牌</span>
      </div>
      <div class="card card-pad" id="mb-list"></div>`;

    const listBox = inner.querySelector('#mb-list');
    const paintList = () => {
      listBox.innerHTML = punishes.length ? `<div class="pb-list">${punishes.map((p) => `<div class="pb-row">
          <span class="chip ${LV_COLOR[p.level] || 'grey'}">${LV_TXT[p.level] || '任务'}</span>
          <span class="pb-text">${esc(p.text)}</span>
          <button class="icon-btn sm" data-pb-edit="${p.id}" title="修改">${icon('edit', 14)}</button>
          <button class="icon-btn sm" data-pb-del="${p.id}" title="删除">${icon('close', 13)}</button>
        </div>`).join('')}</div>` : '<div class="empty" style="padding:16px">还没有任务，点「加任务」开始</div>';
      listBox.querySelectorAll('[data-pb-edit]').forEach((b) => {
        b.onclick = () => punishEditor(punishes.find((p) => String(p.id) === b.dataset.pbEdit), () => renderStudentModule(box, key));
      });
      listBox.querySelectorAll('[data-pb-del]').forEach((b) => {
        b.onclick = async () => {
          if (!(await confirmDialog('删掉这个任务？学生就抽不到它了。'))) return;
          await api.del('/punishments/' + b.dataset.pbDel); toast('已删除'); renderStudentModule(box, key);
        };
      });
    };
    paintList();
    inner.querySelector('#mb-add')?.addEventListener('click', () => punishEditor(null, () => renderStudentModule(box, key)));
    inner.querySelector('#mb-seed')?.addEventListener('click', async () => {
      if (!(await confirmDialog('补一批经典任务（12 个，自动跳过已有的）？'))) return;
      const have = new Set(punishes.map((p) => p.text.trim()));
      const seeds = [
        ['唱歌 30 秒：随便唱一首，全班跟拍', 'light'],
        ['讲个笑话，要让人笑出来', 'light'],
        ['做 20 个深蹲', 'heavy'],
        ['做 15 个开合跳', 'average'],
        ['领读今天的课文段落', 'average'],
        ['当小老师：给全班讲一道题', 'average'],
        ['用一句话总结这节课的重点', 'average'],
        ['30 秒英文自我介绍', 'heavy'],
        ['背诵一句名言并解释意思', 'light'],
        ['给同桌讲一遍刚才的题目', 'average'],
        ['下节课开头用 1 分钟回顾今天内容', 'heavy'],
        ['整理讲台与板书', 'light'],
      ].filter(([t]) => !have.has(t));
      if (!seeds.length) return toast('这些任务都已经有了');
      for (const [text, level] of seeds) await api.post('/punishments', { text, level, active: 1 }).catch(() => { });
      toast(`已补 ${seeds.length} 个任务`);
      renderStudentModule(box, key);
    });

    if (today.length) {
      const rec = el(`<div class="card card-pad" style="margin-top:12px">
        <div class="card-title">${icon('clock', 15)} 今天学生抽到的（${today.length} 条）</div>
        <div class="pb-recent">${today.slice(0, 12).map((r) => `<div class="pb-rec">
          <span class="chip ${r.stu_name ? 'blue' : 'grey'}">${esc(r.stu_name || '匿名')}</span>
          <span class="pb-rtext">${esc(r.text)}</span>
          <span class="tiny muted">${esc(fmtTime(r.created_at))}</span>
        </div>`).join('')}</div>
      </div>`);
      inner.appendChild(rec);
    }
  }
}

/* 班级名单管理：本地版没有单独的名单页，就在抽人下面开一个弹层改。
   以前用户反馈「名单建好了没法改名字」，根因是根本没有编辑入口。 */
function openRosterDialog(rosters, reload) {
  const body = el(`<div class="sheet-body">
    <div class="small muted" style="margin-bottom:10px">名字一行一个，或用逗号、顿号、空格分开都行。名称留空等于删掉这个班。</div>
    ${rosters.map((r) => {
    const n = parseNames(r.names);
    return `<div class="field" data-rid="${r.id}">
        <label class="field-label">${esc(clsName(r.grade, r.class_name))}</label>
        <textarea class="input" rows="3" data-names="${r.id}">${esc(n.join('\n'))}</textarea>
      </div>`;
  }).join('') || '<div class="empty">还没有班级名单。先在「课件 → 上传资料」里建班，或直接在学生页按号码抽。</div>'}
    <div class="confirm-actions"><button class="btn ghost" id="rc">取消</button><button class="btn primary" id="ro">保存</button></div>
  </div>`);
  const s = sheet({ title: '班级名单', body });
  body.querySelector('#rc').onclick = s.close;
  body.querySelector('#ro').onclick = async () => {
    const btn = body.querySelector('#ro'); btn.disabled = true; btn.textContent = '保存中…';
    try {
      for (const r of rosters) {
        const ta = body.querySelector(`[data-names="${r.id}"]`);
        if (!ta) continue;
        const names = ta.value.split(/[\n,，、\s]+/).map((x) => x.trim()).filter(Boolean);
        /* /rosters 的 PATCH 接口约定 names 是数组（不是字符串），
           count 不给时会自动用数组长度；这里显式给，防止空名单把人数冲成 0。 */
        await api.patch('/rosters/' + r.id, { names, count: names.length || Number(r.count) || 0 });
      }
      s.close(); toast('名单已保存'); reload?.();
    } catch (e) {
      btn.disabled = false; btn.textContent = '保存';
      toast(e.message || '保存失败', 'err');
    }
  };
}

/* ================= 课件 + 课堂签到 ================= */
async function renderMaterials(box) {
  let currentCat = 0;
  /* 页面级的轮询句柄：离开课件页要停掉，否则切到别的模块还在偷偷请求 */
  let stopLive = null;
  const stopLivePoll = () => { if (stopLive) { stopLive(); stopLive = null; } };
  const load = async () => {
    stopLivePoll();   // 每次重绘前先停掉旧的，避免重复叠加
    const [cats, mats, links, rollSess, rosters, punishes, punRecs] = await Promise.all([
      api.get('/categories', { scope: 'material' }), api.get('/materials'), api.get('/links'),
      api.get('/roll/sessions').catch(() => []), api.get('/rosters').catch(() => []),
      api.get('/punishments').catch(() => []), api.get('/punish/records', { date: ymd(new Date()) }).catch(() => []),
    ]);
    const link = links[0];
    const list = currentCat ? mats.filter((m) => Number(m.category_id) === currentCat) : mats;
    box.innerHTML = `
      <div class="card card-pad" style="margin-bottom:14px;background:var(--primary-weak);border-color:transparent">
        <div class="row wrap" style="gap:10px">
          <div style="flex:1;min-width:200px"><div class="bold">${icon('route', 15)} 学生访问短链</div>
            <div class="small muted">学生打开这个链接即可签到、看课件、抽题，不用登录。</div></div>
          <code class="mono link-short" id="link-url" title="${esc(studentUrl(link?.code))}">${esc(link ? shortPath(link.code) : '尚未生成')}</code>
          <button class="btn ghost sm" id="copy-link" ${link ? '' : 'disabled'}>${icon('copy', 14)} 复制</button>
          ${link ? `<a class="btn ghost sm" href="${esc(studentUrl(link.code))}" target="_blank">预览</a>` : ''}
          ${link ? '' : '<button class="btn primary sm" id="new-link">生成短链</button>'}
        </div>
      </div>

      ${paintRollCard(rollSess, rosters)}

      ${paintPickCard(rosters)}

      ${paintPunishCard(punishes, punRecs)}

      <div class="row wrap" style="gap:8px;margin-bottom:12px">
        <button class="btn primary sm" id="upload-mat">${icon('upload', 15)} 上传课件</button>
        <button class="btn ghost sm" id="new-cat">＋ 新建分类</button>
        <span style="flex:1"></span>
        <input class="input" id="mat-search" placeholder="搜索课件…" style="max-width:200px;height:34px">
      </div>
      <div class="doc-grid">
        <div class="card card-pad"><div class="cat-list">
          <button class="cat-item ${currentCat === 0 ? 'active' : ''}" data-cat="0">${icon('folder',15)} 全部 <span class="tiny muted">${mats.length}</span></button>
          ${cats.map((c) => `<button class="cat-item ${currentCat === c.id ? 'active' : ''}" data-cat="${c.id}">${icon('folder',15)} ${esc(c.name)}
            <span class="tiny muted">${mats.filter((m) => Number(m.category_id) === c.id).length}</span>
            <span class="spacer"></span><span class="cat-ops" data-cid="${c.id}" style="opacity:.5">⋯</span></button>`).join('')}
        </div></div>
        <div class="card" id="mat-list"></div>
      </div>`;
    box.querySelector('#new-cat').onclick = async () => {
      const name = await promptDialog({ title: '新建分类', label: '分类名称', placeholder: '如：必修上册 / 作文素材' });
      if (name) { await api.post('/categories', { scope: 'material', name }); load(); }
    };
    box.querySelectorAll('.cat-ops').forEach((b) => {
      b.onclick = async (e) => {
        e.stopPropagation();
        const c = cats.find((x) => String(x.id) === b.dataset.cid);
        const body = el(`<div class="sheet-body"><div class="field"><label class="field-label">分类名称</label><input class="input" id="n" value="${esc(c.name)}"></div>
          <div class="confirm-actions"><button class="btn ghost" id="d" style="color:var(--red);margin-right:auto">删除分类</button>
          <button class="btn primary" id="k">保存</button></div></div>`);
        const s = sheet({ title: '编辑分类', body });
        body.querySelector('#k').onclick = async () => { await api.patch('/categories/' + c.id, { name: body.querySelector('#n').value }); s.close(); load(); };
        body.querySelector('#d').onclick = async () => {
          const used = mats.filter((m) => Number(m.category_id) === c.id).length;
          if (used && !(await confirmDialog(`这个分类下还有 ${used} 份课件，删除分类后它们会变成「未分类」，课件本身不会丢。继续？`))) return;
          try {
            await api.del('/categories/' + c.id);
            if (currentCat === c.id) currentCat = 0;
            s.close(); toast('分类已删除'); load();
          } catch (err) { toast(err.message, 'err'); }
        };
      };
    });
    box.querySelectorAll('[data-cat]').forEach((b) => { b.onclick = () => { currentCat = Number(b.dataset.cat); load(); }; });
    box.querySelector('#copy-link').onclick = async () => {
      const url = studentUrl(link?.code);
      try { await navigator.clipboard.writeText(url); toast('已复制，直接发给学生'); } catch { prompt('复制下面的链接', url); }
    };
    box.querySelector('#new-link')?.addEventListener('click', async () => { await api.post('/links', { title: '班级资料站' }); load(); });
    box.querySelector('#upload-mat').onclick = () => materialEditor(null, currentCat, load);
    /* —— 课堂签到 —— */
    box.querySelector('#roll-open')?.addEventListener('click', () => openRollDialog(rosters, load));
    box.querySelectorAll('[data-roll-detail]').forEach((b) => {
      b.onclick = () => rollDetail(Number(b.dataset.rollDetail), load);
    });
    box.querySelectorAll('[data-roll-close]').forEach((b) => {
      b.onclick = async (e) => {
        e.stopPropagation();
        if (!(await confirmDialog('结束这场签到？结束后学生就点不了了，但记录会保留。'))) return;
        await api.patch('/roll/sessions/' + b.dataset.rollClose, { status: 'closed' });
        toast('已结束签到'); load();
      };
    });
    /* —— 抽人 —— */
    box.querySelector('#pick-open')?.addEventListener('click', () => pickStudentDialog(rosters));

    /* —— 惩罚盲盒 —— */
    box.querySelector('#pb-add')?.addEventListener('click', () => punishEditor(null, load));
    box.querySelectorAll('[data-pb-edit]').forEach((b) => {
      b.onclick = () => punishEditor(punishes.find((p) => String(p.id) === b.dataset.pbEdit), load);
    });
    box.querySelectorAll('[data-pb-del]').forEach((b) => {
      b.onclick = async () => {
        if (!(await confirmDialog('删掉这个任务？学生就抽不到它了。'))) return;
        await api.del('/punishments/' + b.dataset.pbDel); toast('已删除'); load();
      };
    });
    box.querySelector('#pb-seed')?.addEventListener('click', async () => {
      if (!(await confirmDialog('补一批经典任务（唱歌、深蹲、领读等 12 个，自动跳过已有的）？'))) return;
      const have = new Set(punishes.map((p) => p.text.trim()));
      const seeds = [
        ['唱歌 30 秒：随便唱一首，全班跟拍', 'light'],
        ['讲个笑话，要让人笑出来', 'light'],
        ['做 20 个深蹲', 'heavy'],
        ['做 15 个开合跳', 'average'],
        ['领读今天的课文段落', 'average'],
        ['当小老师：给全班讲一道题', 'average'],
        ['用一句话总结这节课的重点', 'average'],
        ['30 秒英文自我介绍', 'heavy'],
        ['背诵一句名言并解释意思', 'light'],
        ['给同桌讲一遍刚才的题目', 'average'],
        ['下节课开头用 1 分钟回顾今天内容', 'heavy'],
        ['整理讲台与板书', 'light'],
      ].filter(([t]) => !have.has(t));
      if (!seeds.length) return toast('这些任务都已经有了');
      for (const [text, level] of seeds) {
        await api.post('/punishments', { text, level, active: 1 }).catch(() => {});
      }
      toast(`已补 ${seeds.length} 个任务`); load();
    });
    box.querySelector('#mat-search').oninput = (e) => {
      const q = e.target.value.trim();
      paintMats(mats.filter((m) => !q || m.title.includes(q) || (m.descr || '').includes(q)), load);
    };
    paintMats(list, load);

    /* 有进行中的签到才开轮询：每 3 秒拉一次，全部结束后自动停 */
    const hasLive = rollSess.some((x) => x.status === 'open');
    if (hasLive) {
      for (const x of rollSess) {
        const row = box.querySelector(`[data-roll-row="${x.id}"]`);
        if (row) row.dataset.lastSigned = (x.stats?.present || 0) + (x.stats?.late || 0);
      }
      stopLive = startPoll(async () => {
        const fresh = await api.get('/roll/sessions');
        // 页面被切走了就别更新了（防御：renderMaterials 的 box 已不在文档里）
        if (!document.body.contains(box)) { stopLivePoll(); return; }
        applyRollStats(fresh);
        // 全部结束 → 停掉，并整体刷一次让「结束」按钮消失
        if (!fresh.some((x) => x.status === 'open')) { stopLivePoll(); load(); }
      });
      onViewLeave(stopLivePoll);   // 切到别的模块时停掉
    }
  };
  await load();
}
async function paintMats(list, reload) {
  const box = document.querySelector('#mat-list');
  if (!list.length) { box.innerHTML = '<div class="empty">这个分类还没有课件，点「上传课件」开始</div>'; return; }
  box.innerHTML = '';
  for (const m of list) {
    const files = await api.get('/attachments', { owner_type: 'material', owner_id: m.id }).catch(() => []);
    const item = el(`<div class="list-item">
      <div class="doc-ico">${icon('file', 18)}</div>
      <div style="flex:1;min-width:0">
        <div class="row wrap" style="gap:8px"><span class="bold">${esc(m.title)}</span>
          ${m.grade || m.class_name ? `<span class="chip">${esc(clsName(m.grade, m.class_name))}</span>` : ''}
          ${m.public ? '<span class="chip green">学生可见</span>' : '<span class="chip">仅自己</span>'}</div>
        <div class="tiny muted">${esc(m.descr || '')} · 浏览 ${m.views || 0} · 下载 ${m.downloads || 0}</div>
        <div class="row wrap" style="gap:6px;margin-top:6px">${files.map((f) => `<a class="chip blue" href="${f.url}?dl=1" download>${esc(f.name).slice(0, 18)}</a>`).join('') || '<button class="chip-btn" data-up="1">＋ 上传文件</button>'}</div>
      </div>
      <button class="icon-btn sm" data-e="1">${icon('edit', 15)}</button>
      <button class="icon-btn sm" data-d="1">${icon('close', 14)}</button>
    </div>`);
    item.querySelector('[data-up]')?.addEventListener('click', () => uploadTo('material', m.id, reload));
    item.querySelector('[data-e]').onclick = () => materialEditor(m, m.category_id, reload);
    item.querySelector('[data-d]').onclick = async () => { if (await confirmDialog('删除这份课件？可在回收站找回。')) { await api.del('/materials/' + m.id); reload(); } };
    box.appendChild(item);
  }
}
async function materialEditor(m, catId, reload) {
  const isNew = !m;
  let savedMaterial = m;
  const uploadedFiles = new Set();
  const cats = await api.get('/categories', { scope: 'material' });
  const initialCategory = cats.find(category => String(category.id) === String(m?.category_id ?? catId));
  const body = el(`<div class="sheet-body">
    <div class="field"><label class="field-label">标题</label><input class="input" id="t" value="${esc(m?.title || '')}"></div>
    <div class="form-grid">
      <div class="field"><label class="field-label" for="cat">分类</label><input class="input" id="cat" type="text" value="${esc(initialCategory?.name || '')}" placeholder="手动输入分类名称，留空则为未分类"></div>
      <div class="field"><label class="field-label">班级</label><input class="input" id="cls" value="${esc(m?.class_name || '')}"></div>
      <div class="field"><label class="field-label">年级</label><input class="input" id="grade" value="${esc(m?.grade || '')}"></div>
      <div class="field"><label class="field-label">学生可见</label><select class="input" id="pub"><option value="1" ${m?.public !== 0 ? 'selected' : ''}>是（短链可看）</option><option value="0" ${m?.public === 0 ? 'selected' : ''}>否</option></select></div>
    </div>
    <div class="field"><label class="field-label">说明</label><textarea class="input" id="d" rows="2">${esc(m?.descr || '')}</textarea></div>
    <div class="field"><label class="field-label">文件（可多选）</label>
      <input type="file" id="f" multiple class="small">
      <div class="field-hint" style="margin-top:6px">
        支持 WPS 全部文件格式，包括 .wps / .wpt、.et / .ett、.dps / .dpt，以及 Word、Excel、PPT、PDF、图片和压缩包。
        <br>保留原文件名与格式，每次最多 20 个文件，单个文件最大 50 MB，每批合计不超过 50 MB。
      </div></div>
    <div class="field-hint">设为学生可见后，学生打开链接即可查看教材和下载原文件，无需账号密码。PDF、图片支持浏览器查看；WPS 文档下载后用 WPS 打开。</div>
    <div class="confirm-actions"><button class="btn ghost" id="c">取消</button><button class="btn primary" id="k">保存</button></div></div>`);
  const s = sheet({ title: isNew ? '上传课件' : '编辑课件', body, wide: true });
  body.querySelector('#c').onclick = s.close;
  saving(body.querySelector('#k'), async () => {
    const selected = [...body.querySelector('#f').files];
    if (selected.length > 20) throw new Error('每次最多选择 20 个文件');
    for (const file of selected) if (file.size > MAX_MATERIAL_SIZE) throw new Error('「' + file.name + '」超过 50 MB，请压缩后上传');
    if (selected.reduce((total, file) => total + file.size, 0) > MAX_MATERIAL_SIZE) throw new Error('每批文件合计不能超过 50 MB，请分批上传');
    const categoryName = body.querySelector('#cat').value.trim();
    let categoryId = null;
    if (categoryName) {
      const currentCategories = await api.get('/categories', { scope: 'material' });
      const category = currentCategories.find(item => String(item.name || '').trim() === categoryName)
        || await api.post('/categories', { scope: 'material', name: categoryName });
      categoryId = category.id;
    }
    const payload = { title: body.querySelector('#t').value.trim() || '未命名课件', category_id: categoryId,
      class_name: body.querySelector('#cls').value, grade: body.querySelector('#grade').value,
      descr: body.querySelector('#d').value, public: Number(body.querySelector('#pub').value) };
    const r = savedMaterial ? await api.patch('/materials/' + savedMaterial.id, { ...payload, public: savedMaterial.public }) : await api.post('/materials', { ...payload, public: 0 });
    savedMaterial = r;
    const files = selected.filter(file => !uploadedFiles.has(file));
    if (files.length) {
      const fd = new FormData();
      for (const f of files) fd.append('files', f, f.name);
      fd.append('owner_type', 'material'); fd.append('owner_id', String(r.id));
      await api.req('POST', '/upload', fd);
      files.forEach(file => uploadedFiles.add(file));
    }
    if (Number(r.public) !== payload.public) savedMaterial = await api.patch('/materials/' + r.id, { public: payload.public });
    await syncMaterialSharing();
    s.close(); toast('已保存'); reload();
  });
}

/* 备课模块由 js/prep.js 独立维护。 */

/* ================= 笔记（知识库） =================
   按设计稿：头部卡片（标题 + 搜索 + 新增）、筛选卡片（分类 / 标签）、
   表格卡片（创建时间 / 分类 / 标题 / 标签 / 内容摘要 / 操作）。 */
async function renderNotes(box) {
  let cats = [], notes = [];
  let keyword = '', catId = '', tag = '';

  /* 历史数据里 tags 可能是数组、JSON 字符串或「备课，前调」，统一读成字符串数组。 */
  const readTags = (note) => {
    const raw = note?.tags;
    let list = [];
    if (Array.isArray(raw)) list = raw;
    else if (typeof raw === 'string' && raw.trim()) {
      try { const parsed = JSON.parse(raw); list = Array.isArray(parsed) ? parsed : raw.split(/[,，;；、\s]+/); }
      catch { list = raw.split(/[,，;；、\s]+/); }
    }
    return [...new Set(list.map((item) => String(item || '').trim()).filter(Boolean))];
  };
  const catName = (id) => cats.find((c) => String(c.id) === String(id))?.name || '';
  const dateText = (note) => String(note?.created_at || note?.updated_at || '').slice(0, 10) || '—';
  const summaryOf = (note) => String(note?.content || '').replace(/[#*>`\n-]/g, ' ').replace(/\s+/g, ' ').trim();
  const allTags = () => [...new Set(notes.flatMap(readTags))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  const visibleNotes = () => notes.filter((note) => {
    if (catId && String(note.category_id || '') !== catId) return false;
    const tags = readTags(note);
    if (tag && !tags.includes(tag)) return false;
    const word = keyword.trim().toLowerCase();
    if (!word) return true;
    return [note.title, note.content, catName(note.category_id), ...tags]
      .some((value) => String(value || '').toLowerCase().includes(word));
  });

  const paint = () => {
    const list = visibleNotes();
    const rows = list.map((note) => {
      const tags = readTags(note);
      const id = esc(String(note.id));
      const summary = summaryOf(note);
      return '<tr>' +
        '<td class="kb-date">' + esc(dateText(note)) + '</td>' +
        '<td>' + esc(catName(note.category_id) || '—') + '</td>' +
        '<td class="kb-title" title="' + esc(note.title) + '">' + esc(note.title || '未命名笔记') + '</td>' +
        '<td class="kb-tags">' + (tags.length
          ? tags.map((item, index) => '<span class="kb-tag kb-tag-' + (index % 4 + 1) + '">' + esc(item) + '</span>').join('')
          : '<span class="kb-muted">—</span>') + '</td>' +
        '<td class="kb-summary" title="' + esc(summary) + '"><div class="kb-clip">' + esc(summary || '—') + '</div></td>' +
        '<td class="kb-row-acts">' +
          '<button class="kb-act kb-act-preview" type="button" data-note-preview="' + id + '">预览</button>' +
          '<button class="kb-act kb-act-edit" type="button" data-note-edit="' + id + '">编辑</button>' +
          '<button class="kb-act kb-act-delete" type="button" data-note-delete="' + id + '">删除</button>' +
        '</td></tr>';
    }).join('');

    box.innerHTML = '<section class="kb-page">' +
      '<div class="kb-card kb-head">' +
        '<div class="kb-head-text"><h2>知识库</h2><p>随手记录、分类归档、快速检索，简答留存信息</p></div>' +
        '<div class="kb-head-actions">' +
          '<label class="kb-search">' +
            '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="9" cy="9" r="5.6"></circle><path d="M13.2 13.2 17 17" stroke-linecap="round"></path></svg>' +
            '<input id="kb-search" type="search" placeholder="搜索标题 / 笔记内容" value="' + esc(keyword) + '">' +
          '</label>' +
          '<button class="kb-primary" id="kb-add" type="button">＋ 新增笔记</button>' +
        '</div>' +
      '</div>' +
      '<div class="kb-card kb-filter">' +
        '<label for="kb-filter-cat">分类：<select id="kb-filter-cat">' +
          '<option value="">筛选分类</option>' +
          cats.map((c) => '<option value="' + esc(String(c.id)) + '"' + (catId === String(c.id) ? ' selected' : '') + '>' + esc(c.name) + '</option>').join('') +
        '</select></label>' +
        '<label for="kb-filter-tag">标签：<select id="kb-filter-tag">' +
          '<option value="">筛选标签</option>' +
          allTags().map((item) => '<option value="' + esc(item) + '"' + (tag === item ? ' selected' : '') + '>' + esc(item) + '</option>').join('') +
        '</select></label>' +
      '</div>' +
      '<div class="kb-card kb-table-card">' +
        '<div class="kb-table-wrap"><table class="kb-table">' +
          '<thead><tr><th>创建时间</th><th>分类</th><th>标题</th><th>标签</th><th>内容摘要</th><th>操作</th></tr></thead>' +
          '<tbody>' + (rows || '<tr><td colspan="6" class="kb-empty">还没有笔记，点击「新增笔记」开始记录。</td></tr>') + '</tbody>' +
        '</table></div>' +
        '<div class="kb-count">共 ' + list.length + ' 条记录</div>' +
      '</div>' +
      '</section>';

    const search = box.querySelector('#kb-search');
    search.addEventListener('input', () => {
      keyword = search.value;
      paint();
      /* 重绘会换掉输入框，重新聚焦并把光标放回末尾，不然打字只能一个字一个字点。 */
      const next = box.querySelector('#kb-search');
      if (next) { next.focus(); next.setSelectionRange(keyword.length, keyword.length); }
    });
    box.querySelector('#kb-filter-cat').addEventListener('change', (event) => {
      catId = event.target.value;
      paint();
    });
    box.querySelector('#kb-filter-tag').addEventListener('change', (event) => {
      tag = event.target.value;
      paint();
    });
    box.querySelector('#kb-add').addEventListener('click', () => openEditor(null));
    box.querySelectorAll('[data-note-preview]').forEach((button) => {
      button.addEventListener('click', () => {
        const note = list.find((item) => String(item.id) === button.dataset.notePreview);
        if (note) openPreview(note);
      });
    });
    box.querySelectorAll('[data-note-edit]').forEach((button) => {
      button.addEventListener('click', () => {
        const note = list.find((item) => String(item.id) === button.dataset.noteEdit);
        if (note) openEditor(note);
      });
    });
    box.querySelectorAll('[data-note-delete]').forEach((button) => {
      button.addEventListener('click', () => {
        const note = list.find((item) => String(item.id) === button.dataset.noteDelete);
        if (note) removeNote(note);
      });
    });
  };

  const removeNote = async (note) => {
    if (!(await confirmDialog('删除这篇笔记？可在回收站找回。'))) return;
    try {
      await api.del('/notes/' + note.id);
      toast('笔记已删除');
      await reload();
    } catch (error) {
      toast(error?.message || '删除失败，请重试', 'err');
    }
  };

  function openPreview(note) {
    const tags = readTags(note);
    sheet({
      title: '预览笔记',
      wide: true,
      body: '<div class="kb-preview">' +
        '<h3 class="kb-preview-title">' + esc(note.title || '未命名笔记') + '</h3>' +
        '<div class="kb-preview-meta">' +
          '<span class="kb-preview-cat">' + esc(catName(note.category_id) || '未分类') + '</span>' +
          tags.map((item, index) => '<span class="kb-tag kb-tag-' + (index % 4 + 1) + '">' + esc(item) + '</span>').join('') +
          '<span class="kb-muted">' + esc(dateText(note)) + '</span>' +
        '</div>' +
        '<div class="kb-preview-body">' + (mdToHtml(note.content) || '<span class="kb-muted">这篇笔记还没有内容</span>') + '</div>' +
        '</div>',
    });
  }

  function openEditor(note) {
    const isNew = !note;
    const body = '<div class="kb-form">' +
      '<label class="kb-field"><span>标题</span><input class="input" id="note-title" value="' + esc(note?.title || '') + '" placeholder="给这篇笔记起个标题"></label>' +
      '<label class="kb-field"><span>分类</span><select class="input" id="note-cat">' +
        '<option value="">未分类</option>' +
        cats.map((c) => '<option value="' + esc(String(c.id)) + '"' + (String(note?.category_id || '') === String(c.id) ? ' selected' : '') + '>' + esc(c.name) + '</option>').join('') +
        '<option value="__new">＋ 新建分类…</option>' +
      '</select></label>' +
      '<label class="kb-field"><span>标签</span><input class="input" id="kb-tags" value="' + esc(readTags(note).join('，')) + '" placeholder="多个标签用逗号分隔，如：备课，前调"></label>' +
      '<label class="kb-field"><span>内容</span><textarea class="input" id="note-body" rows="14" placeholder="支持 Markdown：# 标题、- 列表、**加粗**">' + esc(note?.content || '') + '</textarea></label>' +
      '<label class="kb-pin"><input type="checkbox" id="kb-pin" ' + (note?.pinned ? 'checked' : '') + '> 置顶</label>' +
      '</div>';
    const footer = '<div class="kb-form-foot"><button class="btn ghost sm" data-note-cancel>取消</button>' +
      '<button class="btn primary sm" data-note-save>保存</button></div>';
    const s = sheet({ title: isNew ? '新增笔记' : '编辑笔记', body, footer, wide: true });
    s.wrap.querySelector('[data-note-cancel]').onclick = () => s.close();
    saving(s.wrap.querySelector('[data-note-save]'), async () => {
      let categoryId = s.wrap.querySelector('#note-cat').value;
      if (categoryId === '__new') {
        const name = await promptDialog({ title: '新建分类', label: '分类名称', placeholder: '如：课文解读' });
        if (!name) return;
        const created = await api.post('/categories', { scope: 'note', name });
        cats = await api.get('/categories', { scope: 'note' }) || cats;
        categoryId = String(created?.id || cats.find((c) => c.name === name)?.id || '');
      }
      const payload = {
        title: s.wrap.querySelector('#note-title').value.trim() || '未命名笔记',
        content: s.wrap.querySelector('#note-body').value,
        category_id: Number(categoryId) || null,
        tags: readTags({ tags: s.wrap.querySelector('#kb-tags').value }),
        pinned: s.wrap.querySelector('#kb-pin').checked ? 1 : 0,
      };
      if (isNew) await api.post('/notes', payload);
      else await api.patch('/notes/' + note.id, payload);
      toast('已保存');
      s.close();
      await reload();
    });
  }

  const reload = async () => {
    try {
      const [categoryRows, noteRows] = await Promise.all([
        api.get('/categories', { scope: 'note' }),
        api.get('/notes'),
      ]);
      cats = categoryRows || [];
      notes = noteRows || [];
      paint();
    } catch (error) {
      console.error('读取笔记失败', error);
      box.innerHTML = '<section class="kb-page"><div class="kb-card kb-load-error">读取笔记失败：'
        + esc(error?.message || '请检查网络或工作台数据状态') + '</div></section>';
    }
  };
  await reload();
}

function mdToHtml(md) {
  const inline = (t) => esc(t)
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>')
    .replace(/`([^`]+)`/g, '<code style="background:var(--card);padding:1px 5px;border-radius:5px">$1</code>')
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  const lines = String(md == null ? '' : md).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  const flushList = (ordered) => {
    const items = [];
    while (i < lines.length) {
      const m = lines[i].match(ordered ? /^\s*\d+[.)]\s+(.*)$/ : /^\s*[-*+]\s+(.*)$/);
      if (!m) break;
      items.push(`<li>${inline(m[1])}</li>`); i++;
    }
    out.push(ordered
      ? `<ol style="margin:6px 0 6px 22px">${items.join('')}</ol>`
      : `<ul style="margin:6px 0 6px 20px">${items.join('')}</ul>`);
  };
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const lv = h[1].length;
      const size = { 1: '18px', 2: '16px', 3: '15px', 4: '14px' }[lv];
      out.push(`<div style="font-weight:700;font-size:${size};margin:${lv <= 2 ? '14px' : '10px'} 0 6px">${inline(h[2])}</div>`);
      i++; continue;
    }
    if (/^\s*([-*_]){3,}\s*$/.test(line)) { out.push('<hr style="border:0;border-top:1px solid var(--line);margin:12px 0">'); i++; continue; }
    if (/^\s*[-*+]\s+/.test(line)) { flushList(false); continue; }
    if (/^\s*\d+[.)]\s+/.test(line)) { flushList(true); continue; }
    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, '')); i++; }
      out.push(`<blockquote style="margin:8px 0;padding:6px 12px;border-left:3px solid var(--brand);background:var(--card);border-radius:0 8px 8px 0">${inline(buf.join('<br>'))}</blockquote>`);
      continue;
    }
    if (/^```/.test(line)) {
      const buf = []; i++;
      while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++;
      out.push(`<pre style="background:var(--card);padding:10px 12px;border-radius:8px;overflow:auto;font-size:12.5px"><code>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }
    const buf = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|\s*[-*+]\s|\s*\d+[.)]\s|>|```)/.test(lines[i])) { buf.push(lines[i]); i++; }
    out.push(`<p style="margin:6px 0;line-height:1.75">${inline(buf.join('\n')).replace(/\n/g, '<br>')}</p>`);
  }
  return out.join('');
}

export { courseEditor, monthShift };
