import { api, el, esc, clsName, startPoll, toast, sheet, saving, confirmDialog, ymd, pad2, WD_SHORT, fmtDateTime, fmtTime, parseDT, exportUrl, download } from './core.js';
import { registerView, state, icon, go, pageHead, tabsBar, bindTabs, WORK_TABS, onViewLeave } from './ui.js';
import { renderAttendance } from './attendance.js';

const M = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
/* 备注字段统一生成器。
   用户反馈「备注要重点显示、加个方框，不然不知道能写字」——问题出在各处写法不统一：
   有的用 <input>、有的用 <textarea>，有的没 placeholder，有的连 label 都省了。
   抽成一个函数后，样式和占位文案只需改这里一处，不会再漏。 */
function remarkField({ id = 'remark', value = '', placeholder = '有什么要补充的？直接在这里写', rows = 0, hint = '' } = {}) {
  const tag = rows
    ? `<textarea class="input" id="${id}" rows="${rows}" placeholder="${esc(placeholder)}">${esc(value)}</textarea>`
    : `<input class="input" id="${id}" value="${esc(value)}" placeholder="${esc(placeholder)}">`;
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
      if (f === 'html') { window.open(exportUrl(kind, q), '_blank'); }
      else download(exportUrl(kind, q), `${kind}-${Date.now()}.${f}`);
      s.close();
    };
  });
}
export function importSheet(kind, reload) {
  const body = el(`<div class="sheet-body">
    <div class="small muted" style="margin-bottom:8px">从 Excel / WPS 选中区域 <b>Ctrl+C</b> 后粘贴到这里（第一行可为表头），或选择文本文件。</div>
    <textarea class="input" id="imp" rows="9" placeholder="日期\t节次\t班级\t内容&#10;2026-10-20\t1\t高二(3)班\t《劝学》第二课时"></textarea>
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

/* ================= 工作首页 ================= */
registerView(async function work(main, { tab }) {
  main.innerHTML = pageHead('工作', '课时、课表、考勤、监考、出差、课件与笔记') + tabsBar(WORK_TABS, 'work', tab) + '<div id="work-body"></div>';
  bindTabs(main);
  const body = main.querySelector('#work-body');
  if (tab === 'lessons') return renderLessons(body);
  if (tab === 'prep') return renderPreps(body);
  if (tab === 'timetable') return renderTimetable(body);
  if (tab === 'attendance') return renderAttendance(body);
  if (tab === 'invigilation') return renderInvigilation(body);
  if (tab === 'trips') return renderTrips(body);
  if (tab === 'materials') return renderMaterials(body);
  if (tab === 'notes') return renderNotes(body);
});

/* ================= 上课（课时统计 & 代课对账） ================= */
const SUB_LABEL = { normal: '正常上课', '替他人上': '我代别人上', '他人替我上': '别人代我上', '换课': '换课' };
const money = (n) => (Math.round(Number(n || 0) * 100) / 100).toLocaleString('zh-CN');

/* 默认课时单价。用户明确说过「默认 30 元」——之前是 60，
   和实际拿到手的课时费对不上，每次进页面都要手改一遍。
   注意：这里只是「本地还没读到云端设置时」的兜底值，真实值以 settings 为准。 */
const DEFAULT_PRICE = 30;

async function renderLessons(box) {
  let month = M();
  let price = DEFAULT_PRICE;

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
    const netTxt = net.direction === 'even' ? '已平' : `${net.direction === 'receivable' ? '应收' : '应付'} ${money(Math.abs(net.amount))}`;

    box.innerHTML = `
    <div class="row wrap" style="gap:8px;margin-bottom:12px">
      <div class="row" style="gap:4px"><button class="icon-btn sm" data-mprev>${icon('left', 16)}</button>
        <button class="btn ghost sm month-btn" data-mpick style="min-width:112px;justify-content:center">${monthLabel(month)}</button>
        <button class="icon-btn sm" data-mnext>${icon('right', 16)}</button></div>
      <button class="btn ghost sm" id="ls-price">${icon('settings', 15)} 单价 ${money(price)} 元/节</button>
      <span style="flex:1"></span>
      <button class="btn ghost sm" id="ls-pdf">${icon('download', 15)} 对账单</button>
      <button class="btn primary sm" id="ls-add">${icon('plus', 15)} 记一节课</button>
    </div>

    <div class="ls-cards">
      <div class="ls-card main">
        <div class="lc-k">本月实际课时</div>
        <div class="lc-v">${s.total_hours}<span class="lc-u">节</span></div>
        <div class="lc-s">共 ${s.lesson_count} 节课记录</div>
      </div>
      <div class="ls-card">
        <div class="lc-k">${icon('arrow-up-right', 13)} 我该收</div>
        <div class="lc-v green">${s.sub_out.hours}<span class="lc-u">节</span></div>
        <div class="lc-s">${money(s.sub_out.amount)} 元 · ${s.sub_out.count} 次代课</div>
      </div>
      <div class="ls-card">
        <div class="lc-k">${icon('arrow-down-left', 13)} 我该付</div>
        <div class="lc-v amber">${s.sub_in.hours}<span class="lc-u">节</span></div>
        <div class="lc-s">${money(s.sub_in.amount)} 元 · ${s.sub_in.count} 次被代</div>
      </div>
      <div class="ls-card">
        <div class="lc-k">净额（未结清）</div>
        <div class="lc-v ${netCls}">${netTxt}</div>
        <div class="lc-s">${net.hours ? (net.hours > 0 ? '+' : '') + net.hours + ' 节' : '两边持平'}</div>
      </div>
      <div class="ls-card">
        <div class="lc-k">换课</div>
        <div class="lc-v">${s.swap.count}<span class="lc-u">次</span></div>
        <div class="lc-s">只备查，不计账</div>
      </div>
    </div>

    <div class="ls-tri">
      <div class="lt-i"><span class="lt-k">课表排课</span><b>${sch.total}</b><span class="lt-u">节</span></div>
      <span class="lt-sep">=</span>
      <div class="lt-i"><span class="lt-k">实际授课</span><b>${s.total_hours}</b><span class="lt-u">节</span></div>
      <span class="lt-sep">+</span>
      <div class="lt-i"><span class="lt-k">请假代课</span><b>${s.sub_in.count}</b><span class="lt-u">节</span></div>
      <div class="lt-note">${data.partial ? `本月才过 ${data.partial.passed}/${data.partial.total} 天，排课数按全月推算` : '排课数按课表整月推算'}</div>
    </div>

    ${s.people.length ? `<div class="card card-pad ls-settle">
      <div class="lss-head">跟谁结算<span class="lss-head-s">点开可逐节勾选，先结一部分也行</span></div>
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
        </div>` : ''}
      </div>`).join('')}
    </div>` : ''}

    <div class="mobile-tip">手机上以卡片显示，点任意一条可修改</div>
    <div class="table-wrap"><table class="tbl tbl-lesson">
      <thead><tr><th class="th-no">#</th><th style="width:78px">日期</th><th style="width:64px">节次</th><th style="width:110px">班级</th><th>上课内容 / 下次要讲</th><th style="width:110px">进度</th><th style="width:130px">代课</th><th style="width:56px">课时</th><th class="th-ops">操作</th></tr></thead>
      <tbody>${rows.length ? rows.map((r, idx) => {
        const t = r.sub_type || 'normal';
        const chip = t === 'normal' ? '<span class="tiny muted">—</span>'
          : `<span class="chip ${t === '替他人上' ? 'green' : t === '他人替我上' ? 'amber' : 'purple'}">${SUB_LABEL[t] || t}</span>${r.peer_name ? `<div class="tiny muted">${esc(r.peer_name)}</div>` : ''}`;
        return `<tr data-row="${r.id}">
          <td class="td-no">${idx + 1}</td>
          <td class="nowrap">${esc(String(r.date).slice(5))}</td>
          <td class="nowrap">${r.period_no ? '第' + r.period_no + '节' : '—'}<div class="tiny muted">${esc(r.start_time || '')}</div></td>
          <td>${esc(r.class_name || '—')}</td>
          <td class="lc-content">${esc(r.content || '')}${r.next_content ? `<div class="lc-next">下次：${esc(r.next_content)}</div>` : ''}${r.discipline ? `<div class="tiny" style="color:var(--amber)">⚠ ${esc(r.discipline)}</div>` : ''}${r.remark ? `<div class="lc-remark">${icon('edit', 11)}<span>${esc(r.remark)}</span></div>` : ''}</td>
          <td class="tiny">${esc(r.progress || '')}</td>
          <td>${chip}</td>
          <td class="num">${r.hours}</td>
          <td class="td-ops">
            <button class="icon-btn sm" data-edit="${r.id}" title="修改">${icon('edit', 14)}</button>
            <button class="icon-btn sm danger" data-del-lesson="${r.id}" title="删除">${icon('trash', 14)}</button>
          </td>
        </tr>`;
      }).join('') : `<tr><td colspan="9"><div class="empty">${monthLabel(month)}还没有上课记录<br><span class="tiny muted">点右上角「记一节课」开始</span></div></td></tr>`}</tbody>
    </table></div>`;

    // 月份切换
    box.querySelector('[data-mprev]').onclick = () => { month = monthShift(month, -1); load(); };
    box.querySelector('[data-mnext]').onclick = () => { month = monthShift(month, 1); load(); };
    box.querySelector('[data-mpick]').onclick = () => pickMonth(month, (m) => { month = m; load(); });
    box.querySelector('#ls-add').onclick = () => lessonEditor(null, load, month, price);
    box.querySelector('#ls-price').onclick = () => priceDialog(price, load);
    box.querySelector('#ls-pdf').onclick = () => exportStatement(month, box.querySelector('#ls-pdf'));
    box.querySelectorAll('[data-edit]').forEach((b) => {
      b.onclick = (e) => { e.stopPropagation(); lessonEditor(rows.find((r) => String(r.id) === b.dataset.edit), load, month, price); };
    });
    /* 第 12 条：操作栏里的删除。
       必须 stopPropagation —— 整行 tr 也有 onclick（打开编辑器），
       不拦住的话点删除会先弹编辑器再弹确认框，两个弹层叠在一起。 */
    box.querySelectorAll('[data-del-lesson]').forEach((b) => {
      b.onclick = async (e) => {
        e.stopPropagation();
        const r = rows.find((x) => String(x.id) === b.dataset.delLesson);
        if (!r) return;
        if (!(await confirmDialog(`删除 ${String(r.date).slice(5)} ${r.class_name || ''} 第${r.period_no || '?'}节这节课？`, { danger: true, okText: '删除' }))) return;
        try { await api.del('/lessons/' + r.id); toast('已删除'); load(); }
        catch (err) { toast(err.message || '删除失败', 'err'); }
      };
    });
    box.querySelectorAll('[data-row]').forEach((tr) => {
      tr.onclick = () => lessonEditor(rows.find((r) => String(r.id) === tr.dataset.row), load, month, price);
    });
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
    const res = await fetch(`/api/lessons/statement?month=${month}`, { credentials: 'same-origin' });
    if (!res.ok) {
      let msg = '生成失败';
      try { const j = await res.json(); msg = j.error || msg; } catch { /* 非 JSON */ }
      throw new Error(msg);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${monthLabel(month)}课时对账单.pdf`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 8000);
    toast('对账单已生成');
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
      <div class="field"><label class="field-label">班级</label><input class="input" id="class" value="${esc(row?.class_name || '')}" placeholder="高二(3)班"></div>
      <div class="field"><label class="field-label">科目</label><input class="input" id="subject" value="${esc(row?.subject || '语文')}"></div>
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
        <input class="input" id="peer" list="le-tlist" value="${esc(row?.peer_name || '')}" placeholder="从名册选或直接输入">
        <datalist id="le-tlist">${[...new Set(teachers.map((t) => t?.name).filter(Boolean))].map((n) => `<option value="${esc(n)}">`).join('')}</datalist>
      </div>
      <div class="field hidden" id="le-swap-w">
        <label class="field-label">换课说明</label>
        <div class="form-grid">
          <input class="input" id="swap_from" value="${esc(row?.swap_from || '')}" placeholder="我原上的是，如 周三第5节">
          <input class="input" id="swap_to" value="${esc(row?.swap_to || '')}" placeholder="换成，如 周四第4节">
        </div>
      </div>
      <div class="le-tip" id="le-tip"></div>
    </div>

    <div class="field"><label class="field-label">上课内容</label><textarea class="input" id="content" rows="2">${esc(row?.content || '')}</textarea></div>
    <div class="form-grid">
      <div class="field"><label class="field-label">教学进度</label><input class="input" id="progress" value="${esc(row?.progress || '')}" placeholder="如：完成第二段翻译"></div>
      <div class="field"><label class="field-label">下一节课内容</label><input class="input" id="next_content" value="${esc(row?.next_content || '')}"></div>
    </div>
    <div class="field"><label class="field-label">违纪情况</label><input class="input" id="discipline" value="${esc(row?.discipline || '')}" placeholder="如：张三上课睡觉（口头提醒一次）"></div>
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
  $('#pay_hours').oninput = recalc;
  $('#le_price').oninput = recalc;
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

  // 金额按 课时口径 × 单价 重算
  $('#le-reset').onclick = () => {
    const ph = Number($('#pay_hours').value) || 0;
    $('#pay_amount').value = Math.round(ph * price * 100) / 100;
    syncType();
  };

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
      hours: type === '他人替我上' ? 0 : (Number($('#hours').value) || 0),
      pay_hours: Number($('#pay_hours').value) || 0,
      /* 单价跟着这一条走。存下来有两个用处：
         ① 以后改全局单价时，历史记录的单价和金额不会被一起改掉（对账要能复现）；
         ② 编辑旧记录时输入框回填的就是当时那个单价，而不是现在的默认值。 */
      unit_price: $('#le_price').value === '' ? null : Number($('#le_price').value),
      pay_amount: Number($('#pay_amount').value) || 0,
      content: $('#content').value, progress: $('#progress').value,
      next_content: $('#next_content').value, discipline: $('#discipline').value,
      remark: $('#remark').value,
    };
    if (!payload.date) return toast('请选择日期', 'warn');
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
    const [courses, periods] = await Promise.all([api.get('/courses'), api.get('/periods')]);
    const maxP = Math.max(8, ...periods.map((p) => Number(p.period_no)));
    const wd = [0, 1, 2, 3, 4, 5, 6];
    const get = (d, p) => courses.find((c) => Number(c.weekday) === d && Number(c.period_no) === p);
    box.innerHTML = `
      <div class="row wrap" style="margin-bottom:12px">
        <button class="btn primary sm" id="add-course">${icon('plus', 15)} 添加课程</button>
        <button class="btn ghost sm" id="edit-periods">编辑节次时间</button>
        <button class="btn ghost sm" id="print-tt">${icon('download', 15)} 打印/导出课表</button>
        <span style="flex:1"></span>
        <span class="tiny muted">点击任意格子即可修改，时间、节次、班级都会变的情况也支持</span>
      </div>
      <div class="table-wrap"><table class="tbl" style="min-width:860px">
        <thead><tr><th style="width:96px">节次</th>${wd.map((d) => `<th>周${WD_SHORT[d]}</th>`).join('')}</tr></thead>
        <tbody>${Array.from({ length: maxP }, (_, i) => i + 1).map((p) => {
          const per = periods.find((x) => Number(x.period_no) === p);
          return `<tr><td><b>第${p}节</b><div class="tiny muted mono">${per ? per.start_time + '-' + per.end_time : '未设置'}</div></td>
            ${wd.map((d) => {
              const c = get(d, p);
              return `<td data-cell="${d}-${p}" style="cursor:pointer;min-width:104px;height:52px;background:${c ? colorBg(c.class_name) : 'transparent'}">
                ${c ? `<div class="small bold">${esc(c.class_name)}</div><div class="tiny muted">${esc(c.subject)} ${esc(c.room || '')}</div>` : '<span class="tiny muted">＋</span>'}
              </td>`;
            }).join('')}
          </tr>`;
        }).join('')}</tbody>
      </table></div>
      <div class="small muted" style="margin-top:10px">课时统计：本表每周共 ${courses.length} 节，按 4.3 周/月估算约 ${Math.round(courses.length * 4.3)} 节。实际以「上课」中的记录为准。</div>`;
    box.querySelectorAll('[data-cell]').forEach((td) => {
      td.onclick = () => {
        const [d, p] = td.dataset.cell.split('-').map(Number);
        courseEditor(get(d, p) || { weekday: d, period_no: p }, load);
      };
    });
    box.querySelector('#add-course').onclick = () => courseEditor(null, load);
    box.querySelector('#edit-periods').onclick = () => periodEditor(periods, load);
    box.querySelector('#print-tt').onclick = async () => {
      const w = window.open('', '_blank');
      w.document.write(printTimetableHTML(courses, periods, maxP));
      w.document.close();
    };
  };
  await load();
}
function colorBg(name) {
  const c = ['#eef4ff', '#f3eeff', '#e6f7f7', '#fff6e5', '#ffeef6', '#eef0ff'][(String(name).length + String(name).charCodeAt(1) || 1) % 6];
  return c;
}
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
  const body = el(`<div class="sheet-body"><div class="form-grid">
    <div class="field"><label class="field-label">星期</label><select class="input" id="weekday">${[1,2,3,4,5,6,0].map((d) => `<option value="${d}" ${Number(row?.weekday) === d ? 'selected' : ''}>周${WD_SHORT[d]}</option>`).join('')}</select></div>
    <div class="field"><label class="field-label">节次</label><input class="input" type="number" id="period_no" value="${row?.period_no || 1}"></div>
    <div class="field"><label class="field-label">开始时间</label><input class="input" type="time" id="st" value="${esc(row?.start_time || '')}"></div>
    <div class="field"><label class="field-label">结束时间</label><input class="input" type="time" id="et" value="${esc(row?.end_time || '')}"></div>
    <div class="field"><label class="field-label">年级</label><input class="input" id="grade" value="${esc(row?.grade || '高二')}"></div>
    <div class="field"><label class="field-label">班级</label><input class="input" id="class_name" value="${esc(row?.class_name || '')}"></div>
    <div class="field"><label class="field-label">科目</label><input class="input" id="subject" value="${esc(row?.subject || '语文')}"></div>
    <div class="field"><label class="field-label">教室</label><input class="input" id="room" value="${esc(row?.room || '')}"></div>
    <div class="field"><label class="field-label">生效开始日</label><input class="input" type="date" id="sd" value="${esc(row?.start_date || '')}"></div>
    <div class="field"><label class="field-label">生效结束日</label><input class="input" type="date" id="ed" value="${esc(row?.end_date || '')}"></div>
  </div>
  ${remarkField({ value: row?.remark || '', placeholder: '如：走班教室、需带教具' })}
  <div class="confirm-actions">${isNew ? '' : '<button class="btn ghost" id="del" style="margin-right:auto;color:var(--red)">删除</button>'}
  <button class="btn ghost" id="cancel">取消</button><button class="btn primary" id="save">保存</button></div></div>`);
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
  const s = sheet({ title: '编辑节次时间', body, wide: true });
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
const INVIG_LABEL = { school: '学校分配', '替他人': '我代别人', '他人替我': '别人代我' };
async function renderInvigilation(box) {
  let month = M();
  let rules = null;
  const load = async () => {
    let data;
    try { data = await api.get('/invig/summary?month=' + month); } catch (e) { box.innerHTML = `<div class="empty">${esc(e.message || '加载失败')}</div>`; return; }
    rules = data.rules || rules;
    const s = data.summary;
    const rows = data.rows || [];
    const netCls = s.net.direction === 'receivable' ? 'green' : s.net.direction === 'payable' ? 'amber' : '';
    const netTxt = s.net.direction === 'even' ? '已平' : `${s.net.direction === 'receivable' ? '应收' : '应付'} ${money(Math.abs(s.net.amount))}`;

    // 学校款「标记已到账 / 撤销」
    const markSchool = async (paid) => {
      try {
        const r = await api.post('/invig/school-paid', { month, paid });
        toast(paid ? `已标记 ${r.updated} 场学校监考费到账` : '已撤销到账标记');
        load();
      } catch (e) { toast(e.message || '操作失败', 'err'); }
    };

    box.innerHTML = `
    <div class="row wrap" style="gap:8px;margin-bottom:12px">
      <div class="row" style="gap:4px"><button class="icon-btn sm" data-mprev>${icon('left', 16)}</button>
        <button class="btn ghost sm month-btn" data-mpick style="min-width:112px;justify-content:center">${monthLabel(month)}</button>
        <button class="icon-btn sm" data-mnext>${icon('right', 16)}</button></div>
      <button class="btn ghost sm" id="iv-rules">${icon('settings', 15)} 计价 ${rules.mode === '时长' ? '按时长' : '按场次'}</button>
      <span style="flex:1"></span>
      <button class="btn primary sm" id="iv-add">${icon('plus', 15)} 记一场监考</button>
    </div>

    <div class="ls-cards">
      <div class="ls-card main">
        <div class="lc-k">学校应发</div>
        <div class="lc-v">${money(s.school.unpaid)}<span class="lc-u">元</span></div>
        <div class="lc-s">${s.school.count} 场${s.school.paid > 0 ? ` · 已到账 ${money(s.school.paid)} 元` : ' · 统一打卡，不算私账'}</div>
        ${s.school.count ? `<button class="iv-linked" data-school-paid="${s.school.unpaid > 0 ? 1 : 0}">${s.school.unpaid > 0 ? '标记已到账' : '撤销到账'}</button>` : ''}
      </div>
      <div class="ls-card">
        <div class="lc-k">${icon('arrow-up-right', 13)} 我该收</div>
        <div class="lc-v green">${money(s.sub_out.open_amount)}<span class="lc-u">元</span></div>
        <div class="lc-s">替人监考 ${s.sub_out.count} 场 · 共 ${money(s.sub_out.amount)} 元</div>
      </div>
      <div class="ls-card">
        <div class="lc-k">${icon('arrow-down-left', 13)} 我该付</div>
        <div class="lc-v amber">${money(s.sub_in.open_amount)}<span class="lc-u">元</span></div>
        <div class="lc-s">别人代我 ${s.sub_in.count} 场 · 共 ${money(s.sub_in.amount)} 元</div>
      </div>
      <div class="ls-card">
        <div class="lc-k">同事间净额</div>
        <div class="lc-v ${netCls}">${netTxt}</div>
        <div class="lc-s">${s.school.count ? '学校那笔不在内' : '两边持平'}</div>
      </div>
      <div class="ls-card">
        <div class="lc-k">本月监考</div>
        <div class="lc-v">${s.total}<span class="lc-u">场</span></div>
        <div class="lc-s">${Math.round(s.minutes / 60 * 10) / 10} 小时</div>
      </div>
    </div>

    ${s.people.length ? `<div class="card card-pad ls-settle">
      <div class="lss-head">跟谁结算<span class="lss-head-s">点开可逐场勾选，先结一部分也行</span></div>
      ${s.people.map((p) => `<div class="lss-row${p.settled ? ' done' : ''}${p.partial ? ' part' : ''}" data-person="${esc(p.name)}|${p.direction}">
        <div class="lss-line">
          <div class="lss-main">
            <span class="lss-name">${esc(p.name)}</span>
            <span class="chip ${p.direction === 'out' ? 'green' : 'amber'}">${p.direction === 'out' ? '应收' : '应付'}</span>
            <span class="lss-amt">${p.settled
              ? `${p.count} 场 / ${money(p.amount)} 元`
              : p.partial
                ? `还剩 ${money(p.open_amount)} 元<span class="lss-dim">（已结 ${p.count - p.open_items.length}/${p.count} 场）</span>`
                : `${p.count} 场 / ${money(p.amount)} 元`}</span>
            ${p.settled ? '<span class="chip grey">已结清</span>' : p.partial ? '<span class="chip grey">部分结清</span>' : ''}
          </div>
          <div class="lss-btns">
            ${p.settled ? '' : `<button class="btn ghost sm" data-toggle="${esc(p.name)}|${p.direction}">逐场结</button>`}
            <button class="btn ${p.settled ? 'ghost' : 'primary'} sm" data-settle="${esc(p.name)}" data-dir="${p.direction}" data-done="${p.settled ? '1' : ''}">${p.settled ? '撤销结清' : '全部结清'}</button>
          </div>
        </div>
        ${p.open_items.length && !p.settled ? `<div class="lss-items hidden" data-items="${esc(p.name)}|${p.direction}">
          ${p.open_items.map((it) => `<label class="lss-item">
            <input type="checkbox" data-pick="${it.id}" data-name="${esc(p.name)}" data-dir="${p.direction}" data-h="1" data-a="${it.amount}">
            <span class="lsi-d">${esc(String(it.date).slice(5))}${it.start_time ? ' ' + esc(it.start_time) : ''}</span>
            <span class="lsi-c">${esc(it.exam_name || '')}${it.room ? ' · ' + esc(it.room) : ''}</span>
            <span class="lsi-h">${money(it.amount)} 元</span>
          </label>`).join('')}
          <div class="lss-pick-bar">
            <span class="lss-pick-sum" data-sum-for="${esc(p.name)}|${p.direction}">未选</span>
            <button class="btn ghost sm" data-checkall="${esc(p.name)}|${p.direction}">全选</button>
            <button class="btn primary sm" data-settlepick="${esc(p.name)}|${p.direction}" disabled>结清选中的</button>
          </div>
        </div>` : ''}
      </div>`).join('')}
    </div>` : ''}

    <div class="mobile-tip">手机上以卡片显示，点任意一条可修改</div>
    <div class="table-wrap"><table class="tbl tbl-invig">
      <thead><tr><th class="th-no">#</th><th style="width:78px">日期</th><th style="width:74px">类型</th><th style="width:96px">对方</th><th>考试 / 考场</th><th style="width:104px">时间</th><th style="width:62px">金额</th><th style="width:78px">状态</th><th class="th-ops">操作</th></tr></thead>
      <tbody>${rows.length ? rows.map((r, idx) => {
        const dt = r.duty_type || 'school';
        const chip = `<span class="chip ${dt === 'school' ? 'blue' : dt === '替他人' ? 'green' : dt === '他人替我' ? 'amber' : 'grey'}">${INVIG_LABEL[dt] || dt}</span>`;
        const st = dt === 'school'
          ? (r.school_paid ? '<span class="chip green">已到账</span>' : '<span class="chip blue">待学校发</span>')
          : (r.settled_at ? '<span class="chip grey">已结清</span>' : '<span class="chip red">未结</span>');
        return `<tr data-row="${r.id}">
          <td class="td-no">${idx + 1}</td>
          <td class="nowrap">${esc(String(r.date || '').slice(5))}</td>
          <td class="nowrap">${chip}</td>
          <td class="iv-peer">${esc(r.peer_name || '')}</td>
          <td class="lc-content">${esc(r.exam_name || (r.duty_type === 'school' ? '学校监考' : '监考'))}${r.room ? `<div class="lc-next">考场：${esc(r.room)}</div>` : ''}</td>
          <td class="tiny mono nowrap">${esc(r.start_time || '')}${r.end_time ? '-' + esc(r.end_time) : ''}<div class="tiny muted">${r.duration_min ? r.duration_min + ' 分钟' : ''}</div></td>
          <td class="num">${money(r.pay_amount || 0)}</td>
          <td>${st}</td>
          <td class="td-ops">
            <button class="icon-btn sm" data-edit="${r.id}" title="修改">${icon('edit', 14)}</button>
            <button class="icon-btn sm danger" data-del-invig="${r.id}" title="删除">${icon('trash', 14)}</button>
          </td>
        </tr>`;
      }).join('') : `<tr><td colspan="9"><div class="empty">${monthLabel(month)}还没有监考记录<br><span class="tiny muted">点右上角「记一场监考」开始</span></div></td></tr>`}</tbody>
    </table></div>`;

    box.querySelector('[data-mprev]').onclick = () => { month = monthShift(month, -1); load(); };
    box.querySelector('[data-mnext]').onclick = () => { month = monthShift(month, 1); load(); };
    box.querySelector('[data-mpick]').onclick = () => pickMonth(month, (m) => { month = m; load(); });
    box.querySelector('#iv-add').onclick = () => invEditor(null, load, month, rules, s.people);
    box.querySelector('#iv-rules').onclick = () => invRulesDialog(rules, load);
    box.querySelectorAll('[data-edit]').forEach((b) => {
      b.onclick = (e) => { e.stopPropagation(); invEditor(rows.find((r) => String(r.id) === b.dataset.edit), load, month, rules, s.people); };
    });
    box.querySelectorAll('[data-del-invig]').forEach((b) => {
      b.onclick = async (e) => {
        e.stopPropagation();
        const r = rows.find((x) => String(x.id) === b.dataset.delInvig);
        if (!r) return;
        /* 已经结清的场次要额外提醒：删掉之后对账金额会变，
           用户往往没意识到「删一条记录」等于「改了对账单」。 */
        const warn = r.settled_at ? '这一场已经结清过了，删除后对账金额会跟着变。' : '';
        if (!(await confirmDialog(`删除 ${String(r.date || '').slice(5)} ${r.exam_name || '监考'} 这一场？${warn ? '\n' + warn : ''}`, { danger: true, okText: '删除' }))) return;
        try { await api.del('/invigilations/' + r.id); toast('已删除'); load(); }
        catch (err) { toast(err.message || '删除失败', 'err'); }
      };
    });
    box.querySelectorAll('[data-row]').forEach((tr) => {
      tr.onclick = () => invEditor(rows.find((r) => String(r.id) === tr.dataset.row), load, month, rules, s.people);
    });

    // 学校款「标记已到账 / 撤销」
    box.querySelectorAll('[data-school-paid]').forEach((b) => {
      b.onclick = (e) => { e.stopPropagation(); markSchool(Number(b.dataset.schoolPaid) === 1); };
    });

    box.querySelectorAll('[data-settle]').forEach((b) => {
      b.onclick = async (e) => {
        e.stopPropagation();
        const { settle: name, dir, done } = b.dataset;
        try {
          await api.post(`/invig/${done ? 'unsettle' : 'settle'}`, { month, name, direction: dir });
          toast(done ? '已撤销结清' : `已把 ${name} 本月监考费结清`);
          load();
        } catch (err) { toast(err.message || '操作失败', 'err'); }
      };
    });
    box.querySelectorAll('[data-toggle]').forEach((b) => {
      b.onclick = (e) => {
        e.stopPropagation();
        const key = b.dataset.toggle;
        const panel = box.querySelector(`[data-items="${CSS.escape(key)}"]`);
        if (!panel) return;
        const open = !panel.classList.toggle('hidden');
        b.textContent = open ? '收起' : '逐场结';
        b.classList.toggle('on', open);
      };
    });
    const refreshPick = (key) => {
      const panel = box.querySelector(`[data-items="${CSS.escape(key)}"]`);
      if (!panel) return;
      const picks = [...panel.querySelectorAll('[data-pick]:checked')];
      const sum = picks.reduce((a, x) => a + Number(x.dataset.a || 0), 0);
      const sumEl = panel.querySelector('[data-sum-for]');
      const btn = panel.querySelector('[data-settlepick]');
      if (sumEl) sumEl.innerHTML = picks.length ? `已选 <b>${picks.length}</b> 场 / <b>${money(sum)}</b> 元` : '未选';
      if (btn) { btn.disabled = !picks.length; btn.textContent = picks.length ? `结清选中的 ${picks.length} 场` : '结清选中的'; }
    };
    box.querySelectorAll('[data-pick]').forEach((ck) => { ck.onchange = () => refreshPick(ck.dataset.name + '|' + ck.dataset.dir); });
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
          const r = await api.post('/invig/settle', { month, name, direction: dir, ids });
          toast(`已结清 ${r.settled} 场`);
          load();
        } catch (err) { b.disabled = false; toast(err.message || '操作失败', 'err'); }
      };
    });
  };
  await load();
}

/* 计价规则 */
function invRulesDialog(rules, reload) {
  const r = rules || { mode: '场次', perSession: 60, perHour: 30, peerPerSession: 50, tiers: [] };
  const nt = (r.tiers && r.tiers.length ? r.tiers : [{ max: 90, amount: 50 }, { max: 150, amount: 70 }, { max: 999, amount: 90 }]);
  const body = el(`<div class="sheet-body">
    <div class="small muted" style="margin-bottom:12px">同事之间（替人监考）固定一场一口价；学校分配的按你自己的学校标准算。</div>
    <div class="field"><label class="field-label">学校监考怎么算</label>
      <select class="input" id="mode">
        <option value="场次" ${r.mode !== '时长' ? 'selected' : ''}>按场次（每场固定）</option>
        <option value="时长" ${r.mode === '时长' ? 'selected' : ''}>按时长（按分钟分档）</option>
      </select></div>
    <div class="field" id="w-per"><label class="field-label">每场多少钱（元）</label><input class="input" type="number" step="1" id="perSession" value="${r.perSession}"></div>
    <div class="field hidden" id="w-tier">
      <label class="field-label">按时长分档（分钟以内 → 多少钱）</label>
      ${nt.map((t, i) => `<div class="row" style="gap:8px;margin-bottom:8px">
        <input class="input" type="number" data-tmax="${i}" value="${t.max}" placeholder="分钟上限" style="flex:1">
        <span class="muted">分钟以内 →</span>
        <input class="input" type="number" data-tamt="${i}" value="${t.amount}" placeholder="元" style="width:96px">
      </div>`).join('')}
    </div>
    <div class="field"><label class="field-label">同事之间每场（元）</label><input class="input" type="number" step="1" id="peer" value="${r.peerPerSession}"></div>
    <div class="confirm-actions"><button class="btn ghost" id="c">取消</button><button class="btn primary" id="k">保存</button></div>
  </div>`);
  const s = sheet({ title: '监考计价规则', body });
  const modeEl = body.querySelector('#mode');
  const sync = () => {
    const dur = modeEl.value === '时长';
    body.querySelector('#w-per').classList.toggle('hidden', dur);
    body.querySelector('#w-tier').classList.toggle('hidden', !dur);
  };
  modeEl.onchange = sync; sync();
  body.querySelector('#c').onclick = s.close;
  body.querySelector('#k').onclick = async () => {
    const tiers = [...body.querySelectorAll('[data-tmax]')].map((x, i) => ({
      max: Number(x.value) || 0,
      amount: Number(body.querySelector(`[data-tamt="${i}"]`).value) || 0,
    }));
    try {
      await api.patch('/invig/rules', {
        mode: modeEl.value,
        perSession: Number(body.querySelector('#perSession').value) || 0,
        peerPerSession: Number(body.querySelector('#peer').value) || 0,
        tiers,
      });
      s.close(); toast('计价规则已保存'); reload();
    } catch (e) { toast(e.message || '保存失败', 'err'); }
  };
}

/* 录入 / 编辑一场监考 */
function invEditor(row, reload, month, rules, people) {
  const isNew = !row;
  const r = rules || { peerPerSession: 50, perSession: 60, mode: '场次', tiers: [] };
  const dt0 = row?.duty_type || 'school';
  const peerNames = [...new Set((people || []).map((p) => p.name))];
  const calc = (dt, mins) => {
    if (dt !== 'school') return Number(r.peerPerSession) || 0;
    if (r.mode === '时长') {
      const tiers = r.tiers?.length ? r.tiers : [{ max: 90, amount: 50 }, { max: 150, amount: 70 }, { max: 999, amount: 90 }];
      for (const t of tiers) if (mins <= Number(t.max)) return Number(t.amount) || 0;
      return Number(tiers[tiers.length - 1].amount) || 0;
    }
    return Number(r.perSession) || 0;
  };
  const body = el(`<div class="sheet-body">
    <div class="field"><label class="field-label">这一场是什么情况</label>
      <div class="seg3" id="dt">
        ${[['school', '学校分配'], ['替他人', '我代别人'], ['他人替我', '别人代我']].map(([v, l]) =>
          `<button type="button" class="seg3-i ${dt0 === v ? 'on' : ''}" data-v="${v}">${l}</button>`).join('')}
      </div>
      <div class="tiny muted" id="dt-hint" style="margin-top:6px"></div>
    </div>
    <div class="form-grid">
      <div class="field"><label class="field-label">日期</label><input class="input" type="date" id="date" value="${esc(row?.date || ymd(new Date()))}"></div>
      <div class="field" id="w-peer"><label class="field-label">对方老师</label>
        <input class="input" id="peer" list="peer-names" value="${esc(row?.peer_name || '')}" placeholder="姓名">
        <datalist id="peer-names">${peerNames.map((n) => `<option value="${esc(n)}">`).join('')}</datalist></div>
      <div class="field"><label class="field-label">考试名称</label><input class="input" id="exam" value="${esc(row?.exam_name || '')}" placeholder="如 期中数学"></div>
      <div class="field"><label class="field-label">考场</label><input class="input" id="room" value="${esc(row?.room || '')}" placeholder="如 高三(2)"></div>
      <div class="field"><label class="field-label">开始</label><input class="input" type="time" id="st" value="${esc(row?.start_time || '')}"></div>
      <div class="field"><label class="field-label">结束</label><input class="input" type="time" id="et" value="${esc(row?.end_time || '')}"></div>
      <div class="field"><label class="field-label">时长（分钟）</label><input class="input" type="number" id="mins" value="${row?.duration_min ?? ''}"></div>
      <div class="field"><label class="field-label">金额（元）</label><input class="input" type="number" step="1" id="amt" value="${row?.pay_amount ?? ''}"></div>
    </div>
    <div class="field" id="w-paid"><label class="field-label">学校这笔到账了吗</label>
      <select class="input" id="schoolPaid">
        <option value="0" ${!Number(row?.school_paid) ? 'selected' : ''}>还没到账</option>
        <option value="1" ${Number(row?.school_paid) ? 'selected' : ''}>已到账（已打卡）</option>
      </select></div>
    ${remarkField({ value: row?.remark || row?.pay_note || '', placeholder: '如：需带答题卡袋、考场在三楼' })}
    <div class="confirm-actions"><button class="btn ghost" id="c">取消</button><button class="btn primary" id="k">保存</button></div>
  </div>`);
  const s = sheet({ title: isNew ? '记一场监考' : '编辑监考', body, wide: true });
  const q = (id) => body.querySelector('#' + id);
  let dt = dt0;

  const syncKind = () => {
    const isSchool = dt === 'school';
    q('w-peer').classList.toggle('hidden', isSchool);
    q('w-paid').classList.toggle('hidden', !isSchool);
    q('dt-hint').textContent = isSchool
      ? '学校统一发放到工资卡，不进同事间净额'
      : dt === '替他人' ? '你替对方监考，对方该给你钱' : '对方替你监考，你该给对方钱';
    body.querySelectorAll('.seg3-i').forEach((b) => b.classList.toggle('on', b.dataset.v === dt));
  };
  const syncAmt = (force) => {
    const mins = Number(q('mins').value) || 0;
    if (force || !q('amt').value) q('amt').value = calc(dt, mins);
  };
  body.querySelectorAll('.seg3-i').forEach((b) => {
    b.onclick = () => { dt = b.dataset.v; syncKind(); syncAmt(true); };
  });
  // 起止时间改动时自动算时长，再按时长（或场次）算金额
  const calcMins = () => {
    const a = q('st').value; const b2 = q('et').value;
    if (!a || !b2) return;
    const [h1, m1] = a.split(':').map(Number); const [h2, m2] = b2.split(':').map(Number);
    let d = (h2 * 60 + m2) - (h1 * 60 + m1);
    if (d < 0) d += 24 * 60;
    q('mins').value = d;
    syncAmt(true);
  };
  q('st').onchange = calcMins; q('et').onchange = calcMins;
  q('mins').onchange = () => syncAmt(true);
  syncKind();
  if (isNew) syncAmt(true);

  body.querySelector('#c').onclick = s.close;
  body.querySelector('#k').onclick = async () => {
    const payload = {
      date: q('date').value, duty_type: dt,
      peer_name: dt === 'school' ? '' : q('peer').value.trim(),
      exam_name: q('exam').value.trim(), room: q('room').value.trim(),
      start_time: q('st').value, end_time: q('et').value,
      duration_min: Number(q('mins').value) || 0,
      pay_amount: Number(q('amt').value) || 0,
      pay_rule: dt === 'school' && r.mode === '时长' ? '时长' : '场次',
      school_paid: dt === 'school' ? Number(q('schoolPaid').value) : 0,
      status: 'done',
      remark: q('remark').value,
      paid: dt === 'school' ? Number(q('schoolPaid').value) : 0,
      // 兼容旧列与日历/首页读取
      type: dt === 'school' ? '学校分配' : dt === '替他人' ? '我代他人' : '他人代我',
      person: dt === 'school' ? '' : q('peer').value.trim(),
      subject: q('exam').value.trim(),
      place: q('room').value.trim(),
      amount: Number(q('amt').value) || 0,
      minutes: Number(q('mins').value) || 0,
      start_at: q('date').value && q('st').value ? `${q('date').value}T${q('st').value}` : '',
      end_at: q('date').value && q('et').value ? `${q('date').value}T${q('et').value}` : '',
    };
    if (dt !== 'school' && !payload.peer_name) { toast('请填对方老师姓名', 'err'); return; }
    try {
      if (isNew) await api.post('/invigilations', payload); else await api.patch('/invigilations/' + row.id, payload);
      s.close(); toast('已保存'); reload();
    } catch (e) { toast(e.message || '保存失败', 'err'); }
  };
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
  const load = async () => {
    const d = await api.get('/trip/list', { month: ctx.month }).catch(() => ({ rows: [], rules: {} }));
    const rows = d.rows || [];
    const rules = d.rules || { foodPerDay: 100, localPerDay: 40 };
    const sum = (f) => rows.reduce((s, r) => s + (f(r) || 0), 0);
    const total = sum((r) => r.calc.total);
    const pending = sum((r) => (r.reimb_status === 'paid' ? 0 : r.calc.net));
    const km = sum((r) => Number(r.km) || 0);
    const missing = sum((r) => r.calc.bigMissingCount);

    box.innerHTML = `<div class="stat-cards" style="margin-bottom:14px">
      <div class="stat"><div class="k">本月出差</div><div class="v">${rows.length}<span class="u">次</span></div></div>
      <div class="stat"><div class="k">应报总额</div><div class="v">${money2(total)}<span class="u">元</span></div></div>
      <div class="stat"><div class="k">待报销</div><div class="v" style="color:${pending > 0 ? 'var(--amber)' : 'var(--text)'}">${money2(pending)}<span class="u">元</span></div></div>
      <div class="stat"><div class="k">里程</div><div class="v">${km}<span class="u">km</span></div></div>
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
          <span class="tiny muted">${esc(r.start_date)}${r.end_date && r.end_date !== r.start_date ? ' ~ ' + esc(r.end_date) : ''} · ${c.days} 天</span>
        </div>
        <div class="small muted" style="margin-top:2px">${esc(r.reason || '')}${r.companions ? ' · 随行：' + esc(r.companions) : ''}</div>
        <div class="trip-math">
          <span class="tm-piece">实报 <b>¥${money2(c.realTotal)}</b></span>
          <span class="tm-op">+</span>
          <span class="tm-piece">补贴 <b>¥${money2(c.subsidyTotal)}</b></span>
          ${c.advance > 0 ? `<span class="tm-op">−</span><span class="tm-piece">预借 <b>¥${money2(c.advance)}</b></span>` : ''}
          <span class="tm-res"><span class="tm-op">=</span><span class="tm-total">¥${money2(c.net)}</span></span>
        </div>
        <div class="trip-foot">
          <span class="tiny muted trip-meta">${c.itemCount ? c.itemCount + ' 笔明细' : '无明细'}${c.missingCount ? ` · ${c.missingCount} 笔无票` : ''}${Number(r.km) > 0 ? ` · ${r.km} km` : ''}</span>
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
        /* 出差卡里往往已经录了明细和发票，删掉是连带一起没的，
           所以确认文案要把差额金额也说出来，让人看清楚损失的是什么。 */
        const amt = r.calc?.net != null ? `（含 ${r.calc.itemCount || 0} 笔明细，合计 ¥${money2(r.calc.net)}）` : '';
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
  const kinds = Object.entries(d.byKind).filter(([, v]) => v > 0);
  const kindTotal = kinds.reduce((a, [, v]) => a + v, 0) || 1;
  const body = el(`<div class="sheet-body">
    <div class="rd-cards" style="grid-template-columns:repeat(4,1fr)">
      <div class="rd-c"><div class="rd-n">${s0.count}</div><div class="rd-l">出差次数</div></div>
      <div class="rd-c"><div class="rd-n">${s0.km}</div><div class="rd-l">总里程 km</div></div>
      <div class="rd-c"><div class="rd-n" style="color:var(--primary)">${money2(s0.total)}</div><div class="rd-l">应报合计</div></div>
      <div class="rd-c"><div class="rd-n" style="color:var(--amber)">${money2(s0.pending)}</div><div class="rd-l">未到手</div></div>
    </div>
    <div class="sec-title" style="margin:16px 0 8px">${d.year} 年每月应报</div>
    <div class="bar-chart">
      ${d.months.map((m) => `<div class="bc-col" title="${m.month} ¥${money2(m.total)}">
        <div class="bc-bar" style="height:${m.total > 0 ? Math.max(4, Math.round(m.total / maxM * 100)) : 0}%"></div>
        <div class="bc-x">${Number(m.month.slice(5))}</div>
        ${m.total > 0 ? `<div class="bc-v">${money2(m.total)}</div>` : ''}
      </div>`).join('')}
    </div>
    ${kinds.length ? `<div class="sec-title" style="margin:18px 0 8px">钱花在哪</div>
      <div class="kind-list">
        ${kinds.sort((a, b) => b[1] - a[1]).map(([k, v]) => `<div class="kind-row">
          <span class="kind-name">${KIND_LABEL[k] || k}</span>
          <span class="kind-bar"><i style="width:${Math.round(v / kindTotal * 100)}%"></i></span>
          <span class="kind-v">¥${money2(v)}</span>
          <span class="tiny muted" style="width:42px;text-align:right">${Math.round(v / kindTotal * 100)}%</span>
        </div>`).join('')}
      </div>` : '<div class="empty" style="padding:20px 0">今年还没有出差记录</div>'}
    <div class="confirm-actions"><button class="btn ghost" id="c">关闭</button></div>
  </div>`);
  const s = sheet({ title: `出差统计 · ${d.year}`, body, wide: true });
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
    <div class="small muted" style="margin-bottom:14px">${esc(r.reason || '')}${r.companions ? ' · 随行：' + esc(r.companions) : ''}</div>

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
    <div class="field"><label class="field-label">说明</label><input class="input" id="note" value="${esc(it?.note || '')}" placeholder="如：高铁往返 / 酒店 2 晚"></div>
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
  const body = el(`<div class="sheet-body">
    <div class="sec-title">行程</div>
    <div class="form-grid">
      <div class="field"><label class="field-label">出发日期</label><input class="input" type="date" id="sd" value="${esc(row?.start_date || ymd(new Date()))}"></div>
      <div class="field"><label class="field-label">返回日期</label><input class="input" type="date" id="ed" value="${esc(row?.end_date || '')}"></div>
      <div class="field"><label class="field-label">出发地</label><input class="input" id="from" value="${esc(row?.from_place || '学校')}"></div>
      <div class="field"><label class="field-label">目的地</label><input class="input" id="to" value="${esc(row?.to_place || '')}"></div>
    </div>
    <div class="field"><label class="field-label">事由</label><input class="input" id="reason" value="${esc(row?.reason || '')}"></div>
    <div class="field"><label class="field-label">随行人员</label><input class="input" id="comp" value="${esc(row?.companions || '')}" placeholder="没有就留空"></div>

    <div class="sec-title" style="margin-top:18px">实报实销 <span class="tiny muted">（大额建议留票）</span></div>
    <div class="form-grid">
      <div class="field"><label class="field-label">交通（车票/机票）</label><input class="input" type="number" id="transport" value="${row?.transport ?? 0}"></div>
      <div class="field"><label class="field-label">住宿</label><input class="input" type="number" id="hotel" value="${row?.hotel ?? 0}"></div>
      <div class="field"><label class="field-label">市内打车</label><input class="input" type="number" id="taxi" value="${row?.taxi ?? 0}"></div>
      <div class="field"><label class="field-label">过路费</label><input class="input" type="number" id="toll" value="${row?.toll ?? 0}"></div>
      <div class="field"><label class="field-label">停车费</label><input class="input" type="number" id="park" value="${row?.parking ?? 0}"></div>
      <div class="field"><label class="field-label">其他费用</label><input class="input" type="number" id="other" value="${row?.other ?? 0}"></div>
    </div>
    <div class="tiny muted" style="margin:-4px 0 4px">大额（住宿/交通）没票会在列表里标「缺票」。要逐笔记录、传发票，保存后点卡片上的「明细 / 发票」。</div>

    <div class="sec-title" style="margin-top:18px">预借 / 自驾</div>
    <div class="form-grid">
      <div class="field"><label class="field-label">预借（从应报里扣）</label><input class="input" type="number" id="advance" value="${row?.advance ?? 0}"></div>
      <div class="field"><label class="field-label">自驾公里数</label><input class="input" type="number" id="km" value="${row?.km ?? 0}"></div>
    </div>

    <div class="sec-title" style="margin-top:18px">状态</div>
    <div class="form-grid">
      <div class="field"><label class="field-label">审批状态</label><select class="input" id="status">
        ${[['draft', '草稿'], ['submitted', '已提交（待领导审核）'], ['approved', '已审核'], ['rejected', '被驳回']].map(([v, l]) => `<option value="${v}" ${row?.status === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="field"><label class="field-label">报销状态</label><select class="input" id="rstat">
        ${[['draft', '未提交'], ['submitted', '已交财务'], ['paid', '已到账']].map(([v, l]) => `<option value="${v}" ${row?.reimb_status === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    </div>
    <div class="field"><label class="field-label">审核意见</label><input class="input" id="anote" value="${esc(row?.approve_note || '')}"></div>
    ${remarkField({ value: row?.remark || '', rows: 2, placeholder: '如：领导要求当天往返、带纸质材料三份' })}
    <div class="confirm-actions">${isNew ? '' : '<button class="btn ghost" id="del" style="margin-right:auto;color:var(--red)">删除</button>'}
      <button class="btn ghost" id="c">取消</button><button class="btn primary" id="k">保存</button></div>
  </div>`);
  const s = sheet({ title: isNew ? '记录出差' : '编辑出差', body, wide: true });
  body.querySelector('#c').onclick = s.close;
  body.querySelector('#del')?.addEventListener('click', async () => {
    if (await confirmDialog('删除这条出差记录？')) { await api.del('/trips/' + row.id); s.close(); toast('已删除'); reload(); }
  });
  const num = (id) => Number(body.querySelector('#' + id).value) || 0;
  body.querySelector('#k').onclick = async () => {
    const payload = {
      start_date: body.querySelector('#sd').value, end_date: body.querySelector('#ed').value || null,
      from_place: body.querySelector('#from').value, to_place: body.querySelector('#to').value,
      reason: body.querySelector('#reason').value, companions: body.querySelector('#comp').value,
      transport: num('transport'), hotel: num('hotel'), taxi: num('taxi'),
      toll: num('toll'), parking: num('park'), other: num('other'),
      advance: num('advance'), km: num('km'),
      status: body.querySelector('#status').value,
      reimb_status: body.querySelector('#rstat').value,
      approve_note: body.querySelector('#anote').value,
      remark: body.querySelector('#remark').value,
    };
    if (!payload.start_date) return toast('出发日期要填', 'err');
    try {
      if (isNew) await api.post('/trips', payload); else await api.patch('/trips/' + row.id, payload);
      s.close(); toast('已保存'); reload();
    } catch (e) { toast(e.message || '保存失败', 'err'); }
  };
}

/* 学生短链：把当前访问凭据（?sharecode= 之类）一并带上，
   否则学生打开会遇到「链接不完整」的拦截页 */
function studentUrl(code) {
  if (!code) return '';
  const qs = new URLSearchParams(location.search);
  // 只透传平台要求的访问参数，其余（utm 等）不带
  const keep = new URLSearchParams();
  for (const k of ['sharecode', 'code', 'access']) {
    const v = qs.get(k);
    if (v) keep.set(k, v);
  }
  const q = keep.toString();
  return `${location.origin}/s/${code}${q ? '?' + q : ''}`;
}

/* 屏幕上只显示路径部分。
   用户报的是「学生短链仍显示长链」——之前直接把 studentUrl() 整个丢进 <code>，
   连 https://ad90e9…app.workbuddy.host 这截也一起显示，看着完全不像短链。
   真正的短链主体是 /s/feutnv 这 9 个字符，复制时再补全成完整地址。 */
function shortPath(code) {
  if (!code) return '';
  return `/s/${code}`;
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
      <input class="input" id="t" value="${esc(p?.text || '')}" placeholder="如：唱歌 30 秒 / 做 20 个深蹲"></div>
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
  const cats = await api.get('/categories', { scope: 'material' });
  const body = el(`<div class="sheet-body">
    <div class="field"><label class="field-label">标题</label><input class="input" id="t" value="${esc(m?.title || '')}" placeholder="如：《劝学》第一课时 PPT"></div>
    <div class="form-grid">
      <div class="field"><label class="field-label">分类</label><select class="input" id="cat"><option value="">未分类</option>${cats.map((c) => `<option value="${c.id}" ${Number(m?.category_id || catId) === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
      <div class="field"><label class="field-label">班级</label><input class="input" id="cls" value="${esc(m?.class_name || '')}"></div>
      <div class="field"><label class="field-label">年级</label><input class="input" id="grade" value="${esc(m?.grade || '高二')}"></div>
      <div class="field"><label class="field-label">学生可见</label><select class="input" id="pub"><option value="1" ${m?.public !== 0 ? 'selected' : ''}>是（短链可看）</option><option value="0" ${m?.public === 0 ? 'selected' : ''}>否</option></select></div>
    </div>
    <div class="field"><label class="field-label">说明</label><textarea class="input" id="d" rows="2">${esc(m?.descr || '')}</textarea></div>
    <div class="field"><label class="field-label">文件（可多选）</label>
      <input type="file" id="f" multiple class="small"
        accept=".pptx,.ppt,.ppsx,.pdf,.doc,.docx,.xls,.xlsx,.txt,.md,.zip,.rar,.7z,.png,.jpg,.jpeg,.gif,.webp,.mp4,.mov,.mp3,.wav">
      <div class="field-hint" style="margin-top:6px">
        <b>默认就是 PPT（.pptx）</b>，其余格式也都能传：
        PDF、Word、Excel、图片、视频、压缩包都行。
        <br>选文件时如果找不到某个格式，把筛选切到「所有文件」即可——这里只是默认帮你把常用格式排在前面。
      </div></div>
    <div class="field-hint">上传后学生打开短链即可在线预览或下载，解决忘带 U 盘、班级电脑接口损坏的问题。</div>
    <div class="confirm-actions"><button class="btn ghost" id="c">取消</button><button class="btn primary" id="k">保存</button></div></div>`);
  const s = sheet({ title: isNew ? '上传课件' : '编辑课件', body, wide: true });
  body.querySelector('#c').onclick = s.close;
  body.querySelector('#k').onclick = async () => {
    const payload = { title: body.querySelector('#t').value.trim() || '未命名课件', category_id: Number(body.querySelector('#cat').value) || null,
      class_name: body.querySelector('#cls').value, grade: body.querySelector('#grade').value,
      descr: body.querySelector('#d').value, public: Number(body.querySelector('#pub').value) };
    const r = isNew ? await api.post('/materials', payload) : await api.patch('/materials/' + m.id, payload);
    const files = body.querySelector('#f').files;
    if (files.length) {
      const fd = new FormData();
      for (const f of files) fd.append('files', f, f.name);
      fd.append('owner_type', 'material'); fd.append('owner_id', String(r.id));
      await api.req('POST', '/upload', fd);
    }
    s.close(); toast('已保存'); reload();
  };
}

/* ================= 备课 =================
   用户的原话：「有时候我不记得我备课备到哪里了，看了这个之后以后就不会忘记了。」
   所以这个页面的重点不是「存一份教案」，而是**一眼看到进度断点**：
   - 最上面单独一块「接着备」：只放还没备完的，按日期排，点一下直接进编辑；
   - 下面才是完整清单，能按班级筛、按状态筛；
   - 每条记录强制露出「备到哪了 / 下一步」，这两栏是空的话，列表会显示提醒文字。
   和「上课」的区别：课上完记一条；备课是课前的事，一节课可能备两次，也可能一次备两节，
   所以是独立的一张表，用 lesson_id 松松地挂一下（选填）。 */
const PREP_STATUS = { doing: ['在备', 'amber'], done: ['备好了', 'green'] };

/* 备课清单的筛选逻辑单独抽出来：paint() 和「搜索框边打边筛」都要用同一套规则，
   抄两遍迟早会出现「输入框筛出来的和点按钮筛出来的不一样」。 */
function filterList(src, { fClass = '', fStatus = '', keyword = '' } = {}) {
  let out = src;
  if (fClass) out = out.filter((p) => (p.class_name || '').trim() === fClass);
  if (fStatus) out = out.filter((p) => ((p.status || 'doing') === 'done') === (fStatus === 'done'));
  if (keyword) {
    const k = keyword.toLowerCase();
    out = out.filter((p) => [p.topic, p.progress, p.next_step, p.class_name, p.remark]
      .some((x) => String(x || '').toLowerCase().includes(k)));
  }
  return out;
}

async function renderPreps(box) {
  let list = [];
  let fClass = '';
  let fStatus = '';   // '' 全部 / 'doing' 未完成 / 'done' 已完成
  let keyword = '';

  const load = async () => {
    list = await api.get('/preps').catch(() => []);
    paint();
  };

  /* 一条记录「备到哪了」的断点短句：优先 next_step，其次 progress，都没有就说没写 */
  const breakpointOf = (p) => {
    const nx = (p.next_step || '').trim();
    if (nx) return { k: 'next', v: nx };
    const pr = (p.progress || '').trim();
    if (pr) return { k: 'prog', v: pr };
    return null;
  };

  const paint = () => {
    const classes = [...new Set(list.map((p) => (p.class_name || '').trim()).filter(Boolean))].sort();
    const doing = list.filter((p) => (p.status || 'doing') !== 'done');

    const show = filterList(list, { fClass, fStatus, keyword });

    box.innerHTML = `
    <div class="row wrap" style="gap:8px;margin-bottom:14px">
      <div class="prep-stat">
        <span class="ps-num">${doing.length}</span>
        <span class="ps-k">还在备</span>
      </div>
      <div class="prep-stat done">
        <span class="ps-num">${list.filter((p) => (p.status || 'doing') === 'done').length}</span>
        <span class="ps-k">已备好</span>
      </div>
      <span style="flex:1"></span>
      <button class="btn primary sm" id="prep-add">${icon('plus', 15)} 记一次备课</button>
    </div>

    ${doing.length ? `<section class="card card-pad prep-next">
      <div class="prep-next-h">${icon('book', 16)} 接着备这些 <span class="chip amber">${doing.length}</span>
        <span class="prep-next-s">上次停在哪，下次就从哪接着</span></div>
      <div class="prep-next-list">
        ${doing.slice(0, 6).map((p) => {
          const bp = breakpointOf(p);
          return `<button class="prep-next-i" data-open="${p.id}">
            <span class="pni-l">
              <span class="pni-t">${esc(p.topic || '未命名课题')}</span>
              <span class="pni-m">${p.class_name ? esc(p.class_name) + ' · ' : ''}${esc(p.subject || '')}${p.date ? ' · ' + esc(String(p.date).slice(5)) : ''}</span>
            </span>
            <span class="pni-bp">${bp
              ? `${bp.k === 'next' ? '下一步' : '进度'}：${esc(bp.v)}`
              : '<span class="pni-todo">还没写进度，点开补一句</span>'}</span>
            ${icon('right', 14)}
          </button>`;
        }).join('')}
      </div>
      ${doing.length > 6 ? `<div class="tiny muted" style="margin-top:8px">还有 ${doing.length - 6} 条未备完，见下面清单</div>` : ''}
    </section>` : ''}

    <div class="prep-filter">
      <div class="row wrap" style="gap:6px">
        <button class="sr-chip${fClass === '' ? ' on' : ''}" data-fc="">全部班级</button>
        ${classes.map((c) => `<button class="sr-chip${fClass === c ? ' on' : ''}" data-fc="${esc(c)}">${esc(c)}</button>`).join('')}
      </div>
      <div class="row wrap" style="gap:6px;margin-top:6px">
        <button class="sr-chip${fStatus === '' ? ' on' : ''}" data-fs="">全部状态</button>
        <button class="sr-chip${fStatus === 'doing' ? ' on' : ''}" data-fs="doing">在备</button>
        <button class="sr-chip${fStatus === 'done' ? ' on' : ''}" data-fs="done">备好了</button>
        <span style="flex:1"></span>
        <input class="input prep-q" id="prep-q" placeholder="搜课题 / 进度" value="${esc(keyword)}">
      </div>
    </div>

    <div class="card prep-list-card">
      ${show.length ? `<div class="prep-list">${show.map(prepRow).join('')}</div>` : `<div class="empty">
        ${list.length ? '没有符合筛选条件的备课记录' : '还没有备课记录<br><span class="tiny muted">点右上角「记一次备课」，一分钟就能记一条</span>'}
      </div>`}
    </div>`;

    box.querySelector('#prep-add').onclick = () => prepEditor(null, load);
    box.querySelectorAll('[data-fc]').forEach((b) => { b.onclick = () => { fClass = b.dataset.fc; paint(); }; });
    box.querySelectorAll('[data-fs]').forEach((b) => { b.onclick = () => { fStatus = b.dataset.fs; paint(); }; });
    const q = box.querySelector('#prep-q');
    if (q) {
      q.oninput = () => {
        keyword = q.value.trim();
        /* 只重画列表那一块，不整页重绘。整页重绘会把输入框本身也重建，
           光标和输入法候选框都会丢——中文输入时表现为「打一个字跳一次」，很难用。
           所以先把列表容器里的内容换掉，输入框本身原封不动。 */
        const card = box.querySelector('.prep-list-card');
        if (!card) return;
        const shown = filterList(list, { fClass, fStatus, keyword });
        card.innerHTML = shown.length
          ? `<div class="prep-list">${shown.map(prepRow).join('')}</div>`
          : `<div class="empty">${list.length ? '没有符合筛选条件的备课记录' : '还没有备课记录'}</div>`;
        bindRows();
      };
    }
    bindRows();

    function bindRows() {
      box.querySelectorAll('[data-open]').forEach((b) => {
        b.onclick = () => prepEditor(list.find((p) => String(p.id) === b.dataset.open), load);
      });
      box.querySelectorAll('[data-toggle-done]').forEach((b) => {
        b.onclick = async (e) => {
          e.stopPropagation();
          const p = list.find((x) => String(x.id) === b.dataset.toggleDone);
          if (!p) return;
          const next = (p.status || 'doing') === 'done' ? 'doing' : 'done';
          try {
            await api.patch('/preps/' + p.id, { status: next });
            toast(next === 'done' ? '已标记备好' : '已改回在备');
            load();
          } catch (err) { toast(err.message || '操作失败', 'err'); }
        };
      });
    }
  };

  const prepRow = (p) => {
    const st = PREP_STATUS[p.status || 'doing'] || PREP_STATUS.doing;
    const bp = breakpointOf(p);
    return `<div class="prep-row${(p.status || 'doing') === 'done' ? ' is-done' : ''}" data-open="${p.id}">
      <div class="pr-date"><b>${esc((p.date || '').slice(5) || '—')}</b><span>${esc((p.date || '').slice(0, 4))}</span></div>
      <div class="pr-main">
        <div class="pr-t">${esc(p.topic || '未命名课题')}
          <span class="chip ${st[1]}">${st[0]}</span>
          ${p.seq ? `<span class="sr-no">编号 ${String(p.seq).padStart(3, '0')}</span>` : ''}
        </div>
        <div class="pr-m">${p.class_name ? `<span>${esc(p.class_name)}</span>` : ''}${p.subject ? `<span>${esc(p.subject)}</span>` : ''}${p.minutes ? `<span>${p.minutes} 分钟</span>` : ''}</div>
        ${bp ? `<div class="pr-bp"><i>${bp.k === 'next' ? '下一步' : '进度'}</i>${esc(bp.v)}</div>`
          : `<div class="pr-bp empty">还没写进度和下一步，点开补一句，下次就知道从哪接</div>`}
        ${p.remark ? `<div class="pr-rm">${icon('edit', 11)}<span>${esc(p.remark)}</span></div>` : ''}
      </div>
      <button class="btn ghost sm pr-ok" data-toggle-done="${p.id}">${(p.status || 'doing') === 'done' ? '改回在备' : '标记备好'}</button>
    </div>`;
  };

  await load();
}

/* 备课编辑弹窗 */
function prepEditor(row, reload) {
  const isNew = !row;
  const today = ymd(new Date());
  const st = row?.status || 'doing';
  const body = el(`<div class="sheet-body">
    <div class="prep-tip">${icon('alert', 14)} 记清三件事，下次一定接得上：<b>给哪个班备</b>、<b>备的是哪一课</b>、<b>备到哪了</b>。</div>
    <div class="form-grid">
      <div class="field"><label class="field-label">备课日期</label>
        <input class="input" type="date" id="p-date" value="${esc(row?.date || today)}"></div>
      <div class="field"><label class="field-label">班级</label>
        <input class="input" id="p-class" value="${esc(row?.class_name || '')}" placeholder="高二(3)班"></div>
      <div class="field"><label class="field-label">学科</label>
        <input class="input" id="p-subject" value="${esc(row?.subject || '语文')}"></div>
      <div class="field"><label class="field-label">花了多久（分钟，选填）</label>
        <input class="input" id="p-min" type="number" min="0" step="5" value="${row?.minutes ?? ''}"></div>
    </div>
    <div class="field"><label class="field-label">备的是哪一课 <span class="req">*</span></label>
      <input class="input" id="p-topic" value="${esc(row?.topic || '')}" placeholder="如：《劝学》第三段 + 课后练习"></div>
    <div class="field"><label class="field-label">备到哪了</label>
      <textarea class="input" id="p-progress" rows="3" placeholder="如：导入和字词梳理做完了，第三段翻译写到一半">${esc(row?.progress || '')}</textarea></div>
    <div class="field"><label class="field-label">下次接着备什么 <span class="prep-hint">这句是重点，写了下回一看就明白</span></label>
      <textarea class="input" id="p-next" rows="2" placeholder="如：把第三段剩下的翻译补完，再找两道对比阅读题">${esc(row?.next_step || '')}</textarea></div>
    ${remarkField({ id: 'p-remark', value: row?.remark || '', placeholder: '如：需要打印学案、借投影笔' })}
    <div class="field"><label class="field-label">状态</label>
      <div class="le-seg" id="p-seg">
        <button type="button" class="le-seg-i${st !== 'done' ? ' on' : ''}" data-s="doing">还在备</button>
        <button type="button" class="le-seg-i${st === 'done' ? ' on' : ''}" data-s="done">备好了</button>
      </div>
    </div>
    <div class="confirm-actions">
      ${isNew ? '' : '<button class="btn ghost" id="p-del" style="margin-right:auto;color:var(--red)">删除</button>'}
      <button class="btn ghost" id="p-cancel">取消</button>
      <button class="btn primary" id="p-save">保存</button>
    </div>
  </div>`);
  const s = sheet({ title: isNew ? '记一次备课' : '编辑备课记录', body, wide: true });
  let status = st;
  body.querySelectorAll('[data-s]').forEach((b) => {
    b.onclick = () => {
      status = b.dataset.s;
      body.querySelectorAll('[data-s]').forEach((x) => x.classList.toggle('on', x === b));
    };
  });
  body.querySelector('#p-cancel').onclick = s.close;
  const del = body.querySelector('#p-del');
  if (del) {
    del.onclick = async () => {
      if (!(await confirmDialog('删除这条备课记录？', { danger: true, okText: '删除' }))) return;
      try { await api.del('/preps/' + row.id); s.close(); reload(); toast('已删除'); }
      catch (e) { toast(e.message || '删除失败', 'err'); }
    };
  }
  saving(body.querySelector('#p-save'), async () => {
    const topic = body.querySelector('#p-topic').value.trim();
    if (!topic) return toast('请填「备的是哪一课」', 'warn');
    const payload = {
      date: body.querySelector('#p-date').value || today,
      class_name: body.querySelector('#p-class').value.trim(),
      subject: body.querySelector('#p-subject').value.trim(),
      topic,
      progress: body.querySelector('#p-progress').value.trim(),
      next_step: body.querySelector('#p-next').value.trim(),
      minutes: Number(body.querySelector('#p-min').value) || 0,
      remark: body.querySelector('#p-remark').value.trim(),
      status,
    };
    try {
      if (isNew) await api.post('/preps', payload);
      else await api.patch('/preps/' + row.id, payload);
      s.close();
      toast(isNew ? '已记下这次备课' : '已保存');
      reload();
    } catch (e) { toast(e.message || '保存失败', 'err'); }
  });
}

/* ================= 笔记（知识库） ================= */
async function renderNotes(box) {
  let cat = 0; let editing = null; let all = [];
  const relDate = (s) => {
    const d = parseDT(s); if (!d) return '';
    const diff = (Date.now() - d) / 60000;
    if (diff < 60) return Math.max(1, Math.round(diff)) + ' 分钟前';
    if (diff < 1440) return Math.round(diff / 60) + ' 小时前';
    return `${d.getMonth() + 1}/${d.getDate()}`;
  };
  const load = async () => {
    const [cats, notes] = await Promise.all([api.get('/categories', { scope: 'note' }), api.get('/notes')]);
    all = notes;
    const list = cat ? notes.filter((n) => Number(n.category_id) === cat) : notes;
    box.innerHTML = `<div class="doc-grid">
      <div class="card card-pad">
        <button class="btn primary sm block" id="new-note" style="margin-bottom:10px">${icon('plus', 15)} 新建笔记</button>
        <div class="cat-list">
          <button class="cat-item ${cat === 0 ? 'active' : ''}" data-cat="0">${icon('folder',15)} 全部笔记</button>
          ${cats.map((c) => `<button class="cat-item ${cat === c.id ? 'active' : ''}" data-cat="${c.id}">${icon('folder',15)} ${esc(c.name)}</button>`).join('')}
        </div>
        <button class="btn ghost sm block" id="new-cat" style="margin-top:8px">＋ 新建分类</button>
      </div>
      <div class="col">
        <div class="card card-pad" id="note-list"></div>
        <div class="card card-pad" id="note-editor" hidden></div>
      </div>
    </div>`;
    box.querySelectorAll('[data-cat]').forEach((b) => { b.onclick = () => { cat = Number(b.dataset.cat); load(); }; });
    box.querySelector('#new-cat').onclick = async () => {
      const n = await promptDialog({ title: '新建分类', label: '分类名称', placeholder: '如：课文解读' });
      if (n) { await api.post('/categories', { scope: 'note', name: n }); load(); }
    };
    box.querySelector('#new-note').onclick = () => { cat = cat; openEditor(null, cats); };
    const holder = box.querySelector('#note-list');
    holder.innerHTML = `<div class="row" style="margin-bottom:8px"><div class="card-title">笔记列表 <span class="chip">${list.length}</span></div></div>`
      + (list.length ? '' : '<div class="empty">还没有笔记，点左侧「新建笔记」</div>');
    list.forEach((n) => {
      const it = el(`<div class="doc-item" style="cursor:pointer">
        <div class="doc-ico">${icon(n.pinned ? 'pin' : 'file', 20)}</div>
        <div style="flex:1;min-width:0"><div class="bold small">${esc(n.title)}</div>
          <div class="tiny muted" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc((n.content || '').replace(/[#*>`\n-]/g, ' ').slice(0, 60))}</div></div>
        <span class="tiny muted">${relDate(n.updated_at)}</span></div>`);
      it.onclick = () => openEditor(n, cats);
      holder.appendChild(it);
    });
    if (editing) {
      const cur = all.find((x) => x.id === editing);
      if (cur) openEditor(cur, cats);
    }
  };
  function openEditor(n, cats) {
    const isNew = !n;
    const ed = box.querySelector('#note-editor');
    ed.hidden = false;
    ed.innerHTML = `
      <div class="row" style="margin-bottom:10px">
        <input class="input" id="n-title" value="${esc(n?.title || '')}" placeholder="笔记标题" style="font-weight:650;flex:1">
        <select class="input" id="n-cat" style="max-width:150px">${cats.map((c) => `<option value="${c.id}" ${Number(n?.category_id) === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
      </div>
      <div class="seg" style="margin-bottom:8px"><button class="on" data-mv="edit">编辑</button><button data-mv="preview">预览</button></div>
      <textarea class="input" id="n-body" rows="16" placeholder="支持 Markdown：# 标题、## 小标题、- 列表、**加粗**">${esc(n?.content || '')}</textarea>
      <div id="n-preview" hidden style="background:var(--bg-sunken);border-radius:12px;padding:14px;min-height:200px;line-height:1.75"></div>
      <div class="row" style="margin-top:10px">
        <label class="row small" style="gap:6px"><input type="checkbox" id="n-pin" ${n?.pinned ? 'checked' : ''}> 置顶</label>
        <span style="flex:1"></span>
        ${isNew ? '' : '<button class="btn ghost sm" id="n-del" style="color:var(--red)">删除</button>'}
        <button class="btn ghost sm" id="n-cancel">关闭</button>
        <button class="btn primary sm" id="n-save">保存</button>
      </div>`;
    ed.querySelectorAll('[data-mv]').forEach((b) => {
      b.onclick = () => {
        ed.querySelectorAll('[data-mv]').forEach((x) => x.classList.toggle('on', x === b));
        const pv = b.dataset.mv === 'preview';
        ed.querySelector('#n-body').hidden = pv;
        ed.querySelector('#n-preview').hidden = !pv;
        if (pv) ed.querySelector('#n-preview').innerHTML = mdToHtml(ed.querySelector('#n-body').value);
      };
    });
    ed.querySelector('#n-cancel').onclick = () => { ed.hidden = true; editing = null; };
    ed.querySelector('#n-del')?.addEventListener('click', async () => {
      if (await confirmDialog('删除这篇笔记？可在回收站找回。')) { await api.del('/notes/' + n.id); editing = null; load(); }
    });
    ed.querySelector('#n-save').onclick = async () => {
      const payload = { title: ed.querySelector('#n-title').value.trim() || '未命名笔记', content: ed.querySelector('#n-body').value,
        category_id: Number(ed.querySelector('#n-cat').value) || null, pinned: ed.querySelector('#n-pin').checked ? 1 : 0 };
      if (isNew) { const r = await api.post('/notes', payload); editing = r.id; } else { await api.patch('/notes/' + n.id, payload); editing = n.id; }
      toast('已保存'); load();
    };
  }
  await load();
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
