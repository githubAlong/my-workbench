import { api, el, esc, toast, sheet, confirmDialog, promptDialog, ymd, pad2, fmtDateTime, download } from './core.js';
import { registerView, state, icon, go, pageHead, onViewLeave } from './ui.js';

const curMonth = () => ymd().slice(0, 7);
const curYear = () => ymd().slice(0, 4);
const hm = (mins) => {
  const m = Number(mins) || 0;
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60); const r = m % 60;
  return r ? `${h} 小时 ${r} 分` : `${h} 小时`;
};
const clock = (sec) => `${pad2(Math.floor(sec / 3600))}:${pad2(Math.floor(sec % 3600 / 60))}:${pad2(sec % 60)}`;
/* 柱顶标签：只写「小时数」，小数据保留一位小数，避免 0.4 小时被取整成 0 看不懂 */
const hmLabel = (mins) => {
  const h = (Number(mins) || 0) / 60;
  if (!h) return '';
  return h >= 10 ? String(Math.round(h)) : String(+h.toFixed(1));
};
const monthLabel = (m) => `${m.slice(0, 4)} 年 ${Number(m.slice(5, 7))} 月`;
const shiftMonth = (m, delta) => {
  const d = new Date(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1 + delta, 1);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
};

/* 自绘的月份选择器。
   原生 <input type="month"> 在中国区浏览器里会显示成 "October 2026"，
   跟整页中文口径不一致，所以藏起来只当取值器用。 */
function monthPicker(id, value) {
  return `<div class="mp-wrap" id="${id}" data-v="${value}">
    <button class="mp-nav" data-d="-1" title="上个月">${icon('left', 15)}</button>
    <button class="month-btn mp-cur" title="选择年月">${icon('cal', 14)}<span>${monthLabel(value)}</span></button>
    <button class="mp-nav" data-d="1" title="下个月">${icon('right', 15)}</button>
    <input type="month" class="month-hidden mp-native" value="${value}" aria-hidden="true" tabindex="-1">
  </div>`;
}

function bindMonthPicker(root, onChange) {
  if (!root) return;
  const wrap = root.querySelector('.mp-wrap');
  if (!wrap) return;
  const cur = wrap.querySelector('.mp-cur span');
  const native = wrap.querySelector('.mp-native');
  const set = (v) => {
    wrap.dataset.v = v; native.value = v; cur.textContent = monthLabel(v); onChange(v);
  };
  wrap.querySelectorAll('.mp-nav').forEach((b) => {
    b.onclick = (e) => { e.stopPropagation(); set(shiftMonth(wrap.dataset.v, Number(b.dataset.d))); };
  });
  wrap.querySelector('.mp-cur').onclick = () => {
    // showPicker 在部分浏览器不支持，退回 click
    if (native.showPicker) { try { native.showPicker(); return; } catch { /* 降级 */ } }
    native.click();
  };
  native.onchange = () => set(native.value || wrap.dataset.v);
}

registerView(async function study(main, { query }) {
  let tab = query?.tab || 'records';     // records | stats | notes
  let year = curYear();
  let month = curMonth();
  let cat = 0;
  let q = '';
  let timer = null;      // 服务端计时态
  let tickHandle = null;
  let cats = [];

  main.innerHTML = pageHead('学习', '记录学什么、学了多久，也能留下笔记', `
    <button class="btn primary sm" id="add-study">${icon('plus', 15)} 记一笔</button>`);
  const tabsEl = el(`<div class="seg" style="margin-bottom:14px">
    ${[['records', '记录'], ['stats', '统计'], ['notes', '笔记']].map(([v, l]) => `<button data-tab="${v}" class="${tab === v ? 'on' : ''}">${l}</button>`).join('')}
  </div>`);
  const body = el('<div id="study-body"></div>');
  main.appendChild(tabsEl);
  main.appendChild(body);

  tabsEl.querySelectorAll('[data-tab]').forEach((b) => {
    b.onclick = () => {
      tab = b.dataset.tab;
      tabsEl.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('on', x === b));
      paint();
    };
  });

  document.getElementById('add-study').onclick = () => editor(null);

  // 离开页面要停掉秒表，否则后台一直在跑
  const stopTick = () => { if (tickHandle) { clearInterval(tickHandle); tickHandle = null; } };
  const onVis = () => { if (document.hidden) stopTick(); else if (timer && !timer.paused) startTick(); };
  document.addEventListener('visibilitychange', onVis);
  onViewLeave(() => {
    stopTick();
    document.removeEventListener('visibilitychange', onVis);
  });

  /* ================= 计时器 ================= */
  function startTick() {
    stopTick();
    tickHandle = setInterval(() => {
      if (!timer) return;
      timer.seconds += 1;
      const n = body.querySelector('#tm-clock');
      if (n) n.textContent = clock(timer.seconds);
    }, 1000);
  }

  async function loadTimer() {
    try { timer = await api.get('/study/timer'); } catch { timer = null; }
    if (timer && !timer.paused) startTick(); else stopTick();
  }

  async function timerStart() {
    try {
      timer = await api.post('/study/timer/start', { title: '' });
      toast('开始计时');
      paint();
    } catch (e) { toast(e.message, 'err'); }
  }
  async function timerPause() {
    try {
      timer = await api.post('/study/timer/pause');
      if (timer.paused) { stopTick(); toast('已暂停'); } else { startTick(); toast('继续计时'); }
      paint();
    } catch (e) { toast(e.message, 'err'); }
  }
  function timerStop() {
    const mins = Math.max(1, Math.round(timer.seconds / 60));
    const bodyEl = el(`<div class="sheet-body">
      <div class="small muted" style="margin-bottom:10px">本次计时 ${clock(timer.seconds)}，记为 <b style="color:var(--text)">${mins} 分钟</b></div>
      <div class="field"><label class="field-label">学了什么</label>
        <input class="input" id="t" placeholder="如：读《语文学习任务设计》第 3 章"></div>
      <div class="form-grid">
        <div class="field"><label class="field-label">时长（分钟）</label>
          <input class="input" type="number" id="m" value="${mins}" min="0"></div>
        <div class="field"><label class="field-label">分类</label>
          <select class="input" id="c">${catOptions(null)}</select></div>
      </div>
      <div class="field"><label class="field-label">笔记（可选）</label>
        <textarea class="input" id="body" rows="4" placeholder="顺手记两句"></textarea></div>
      <div class="confirm-actions">
        <button class="btn ghost" id="discard" style="margin-right:auto;color:var(--red)">丢弃</button>
        <button class="btn ghost" id="x">取消</button>
        <button class="btn primary" id="k">保存</button></div></div>`);
    const sh = sheet({ title: '结束计时', body: bodyEl });
    bodyEl.querySelector('#x').onclick = sh.close;
    bodyEl.querySelector('#discard').onclick = async () => {
      if (!(await confirmDialog('丢弃这次计时？不会留下记录'))) return;
      await api.del('/study/timer'); timer = null; stopTick(); sh.close(); paint();
    };
    bodyEl.querySelector('#k').onclick = async () => {
      const title = bodyEl.querySelector('#t').value.trim();
      if (!title) return toast('写一下学了什么', 'warn');
      try {
        const r = await api.post('/study/timer/stop', {
          title, minutes: Number(bodyEl.querySelector('#m').value) || mins,
          category_id: Number(bodyEl.querySelector('#c').value) || null,
          content: bodyEl.querySelector('#body').value,
        });
        timer = null; stopTick(); sh.close();
        toast(`已记录 ${hm(r.minutes)}`);
        paint();
      } catch (e) { toast(e.message, 'err'); }
    };
  }

  function catOptions(sel) {
    const list = [{ id: '', name: '未分类' }, ...cats];
    return list.map((c) => `<option value="${c.id}" ${String(sel || '') === String(c.id) ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
  }

  /* ================= 三个视图 ================= */
  async function paint() {
    stopTick();
    const [stats] = await Promise.all([
      api.get('/study/stats', { year, month }).catch(() => ({ byMonth: [], total: {}, byCat: [], byDay: [], monthTotal: {}, monthByCat: [], years: [] })),
      cats.length ? null : api.get('/categories', { scope: 'study' }).then((r) => { cats = r; }).catch(() => []),
    ]);
    await loadTimer();
    if (tab === 'records') return paintRecords(stats);
    if (tab === 'stats') return paintStats(stats);
    return paintNotes();
  }

  /* ---------- 记录 ---------- */
  async function paintRecords(stats) {
    const studies = await api.get('/studies').catch(() => []);
    const goalH = Number(state.user?.settings?.study?.goalHours) || 10;
    const monthMins = studies.filter((s) => String(s.date).startsWith(month)).reduce((a, b) => a + (Number(b.minutes) || 0), 0);
    const pct = Math.min(100, Math.round(monthMins / (goalH * 60) * 100));
    const maxMins = Math.max(1, ...stats.byMonth.map((m) => m.mins || 0));
    // 只有停在当月时才叫「本月」，翻到历史月份就按月份称呼，免得文案对不上
    const isCurMonth = month === new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 7);
    const inMonth = studies.filter((s) => String(s.date).startsWith(month) && (!cat || Number(s.category_id) === cat));

    body.innerHTML = `
      ${timerHTML()}
      <div class="stat-cards" style="margin-bottom:14px">
        <div class="stat"><div class="k">本月学习</div><div class="v">${(monthMins / 60).toFixed(1)}<span class="u">小时</span></div></div>
        <div class="stat"><div class="k">本月记录</div><div class="v">${studies.filter((s) => String(s.date).startsWith(month)).length}<span class="u">条</span></div></div>
        <div class="stat"><div class="k">${year} 年累计</div><div class="v">${((stats.total?.mins || 0) / 60).toFixed(1)}<span class="u">小时</span></div></div>
        <div class="stat"><div class="k">连续学习</div><div class="v">${streak(studies)}<span class="u">天</span></div></div>
      </div>

      <div class="card card-pad" style="margin-bottom:14px">
        <div class="row" style="margin-bottom:8px"><div class="card-title">${icon('chart', 15)} ${year} 年月度时长</div>
          <span style="flex:1"></span>
          <select class="input" id="year-pick" style="width:110px;height:32px">${yearOptions(stats.years)}</select></div>
        <div class="row" style="align-items:flex-end;gap:6px;height:120px;padding:0 2px">
          ${Array.from({ length: 12 }, (_, i) => {
            const mm = `${year}-${pad2(i + 1)}`;
            const row = (stats.byMonth || []).find((x) => x.m === mm);
            const h = row ? Math.max(3, Math.round((row.mins || 0) / maxMins * 100)) : 2;
            const isCur = mm === month;
            return `<button data-mm="${mm}" style="flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;gap:4px;height:100%" title="${mm}：${row ? (row.mins / 60).toFixed(1) : 0} 小时">
              <span class="tiny" style="color:${isCur ? 'var(--primary)' : 'var(--text-3)'}">${row ? hmLabel(row.mins) : ''}</span>
              <span style="width:100%;max-width:26px;height:${h}%;min-height:3px;border-radius:6px 6px 3px 3px;background:${isCur ? 'var(--primary)' : 'var(--primary-weak)'}"></span>
              <span class="tiny ${isCur ? 'bold' : 'muted'}">${i + 1}</span></button>`;
          }).join('')}
        </div>
      </div>

      <div class="card card-pad" style="margin-bottom:14px">
        <div class="row" style="margin-bottom:6px"><div class="card-title">${isCurMonth ? '本月目标' : `${Number(month.slice(5, 7))} 月目标`}</div>
          <button class="icon-btn sm" id="goal-edit" title="改目标">${icon('edit', 13)}</button>
          <span style="flex:1"></span>
          <span class="small muted">${(monthMins / 60).toFixed(1)} / ${goalH} 小时</span></div>
        <div class="goal-track"><div class="goal-fill" style="width:${pct}%"></div></div>
        <div class="tiny muted" style="margin-top:6px">${pct >= 100 ? (isCurMonth ? '本月目标已达成，漂亮' : '这个月目标达成了') : `还差 ${((goalH * 60 - monthMins) / 60).toFixed(1)} 小时`}</div>
      </div>

      <div class="row wrap" style="gap:8px;margin-bottom:12px">
        ${monthPicker('month-pick', month)}
        <div class="seg">${[['0', '全部'], ...cats.map((c) => [String(c.id), c.name])].map(([v, l]) => `<button class="${String(cat) === v ? 'on' : ''}" data-c="${v}">${esc(l)}</button>`).join('')}</div>
        <span style="flex:1"></span>
        <button class="btn ghost sm" data-cat-add>＋ 分类</button>
      </div>
      <div class="card">${inMonth.length ? groupByDay(inMonth) : '<div class="empty">这个月还没有学习记录<br><span class="tiny">点右上角「记一笔」，或者用上面的计时器</span></div>'}</div>`;

    bindTimer();
    bindMonthPicker(body, (v) => { if (v !== month) { month = v; paint(); } });
    body.querySelector('#year-pick').onchange = (e) => { year = e.target.value; paint(); };
    body.querySelectorAll('[data-mm]').forEach((b) => { b.onclick = () => { month = b.dataset.mm; paint(); }; });
    body.querySelectorAll('[data-c]').forEach((b) => { b.onclick = () => { cat = Number(b.dataset.c); paint(); }; });
    body.querySelector('[data-cat-add]').onclick = async () => {
      const n = await promptDialog({ title: '新建学习分类', label: '名称', placeholder: '如：专业阅读' });
      if (n) { await api.post('/categories', { scope: 'study', name: n }); cats = await api.get('/categories', { scope: 'study' }); paint(); }
    };
    body.querySelector('#goal-edit').onclick = () => goalEditor(goalH);
    body.querySelectorAll('[data-ed]').forEach((b) => { b.onclick = () => editor(studies.find((s) => String(s.id) === b.dataset.ed)); });
    body.querySelectorAll('[data-del]').forEach((b) => {
      b.onclick = async () => {
        if (await confirmDialog('删除这条学习记录？')) { await api.del('/studies/' + b.dataset.del); paint(); }
      };
    });
  }

  function timerHTML() {
    if (timer) {
      return `<div class="card card-pad timer-card ${timer.paused ? 'paused' : 'running'}">
        <div class="row" style="gap:12px">
          <div style="flex:1;min-width:0">
            <div class="tiny muted">${timer.paused ? '已暂停' : '正在计时'}</div>
            <div class="tm-clock" id="tm-clock">${clock(timer.seconds)}</div>
          </div>
          <button class="btn ghost" id="tm-pause">${timer.paused ? '继续' : '暂停'}</button>
          <button class="btn primary" id="tm-stop">结束并保存</button>
        </div>
        ${timer.title ? `<div class="tiny muted" style="margin-top:6px">${esc(timer.title)}</div>` : ''}
      </div>`;
    }
    return `<div class="card card-pad timer-card">
      <div class="row" style="gap:12px">
        <div style="flex:1;min-width:0">
          <div class="small bold">计时器</div>
          <div class="tiny muted">上课、读书都可以按一下开始，锁屏也不影响</div>
        </div>
        <button class="btn primary" id="tm-start">${icon('play', 14)} 开始</button>
      </div>
    </div>`;
  }

  function bindTimer() {
    const s = body.querySelector('#tm-start');
    if (s) s.onclick = timerStart;
    const pa = body.querySelector('#tm-pause');
    if (pa) pa.onclick = timerPause;
    const st = body.querySelector('#tm-stop');
    if (st) st.onclick = timerStop;
  }

  function groupByDay(list) {
    const m = new Map();
    for (const s of list) { if (!m.has(s.date)) m.set(s.date, []); m.get(s.date).push(s); }
    let html = '';
    for (const [d, rows] of [...m.entries()].sort((a, b) => b[0].localeCompare(a[0]))) {
      const total = rows.reduce((a, b) => a + (Number(b.minutes) || 0), 0);
      html += `<div class="study-day"><span>${d.slice(5).replace('-', ' 月 ')} 日</span><i></i><em>${hm(total)}</em></div>`;
      html += rows.map((s) => {
        const cname = cats.find((c) => Number(c.id) === Number(s.category_id))?.name || '';
        return `<div class="list-item study-row">
          <div class="doc-ico" style="background:var(--purple-weak);color:var(--purple)">${icon('book', 18)}</div>
          <div style="flex:1;min-width:0">
            <div class="row wrap" style="gap:8px"><span class="bold small">${esc(s.title)}</span>
              <span class="chip purple">${hm(s.minutes)}</span>
              ${s.source === 'timer' ? '<span class="chip blue">计时</span>' : ''}
              ${cname ? `<span class="chip gray">${esc(cname)}</span>` : ''}</div>
            ${s.content ? `<div class="tiny muted" style="margin-top:2px;white-space:pre-wrap">${esc(String(s.content).slice(0, 90))}${String(s.content).length > 90 ? '…' : ''}</div>` : ''}
          </div>
          <button class="icon-btn sm" data-ed="${s.id}" title="编辑">${icon('edit', 15)}</button>
          <button class="icon-btn sm" data-del="${s.id}" title="删除">${icon('close', 14)}</button>
        </div>`;
      }).join('');
    }
    return html;
  }

  function goalEditor(cur) {
    const b = el(`<div class="sheet-body">
      <div class="small muted" style="margin-bottom:10px">定个够得着的量。忙的时候 5 小时，兴致高就 20 小时。</div>
      <div class="field"><label class="field-label">每月目标（小时）</label>
        <input class="input" type="number" id="g" value="${cur}" min="1" max="400" step="1"></div>
      <div class="confirm-actions"><button class="btn ghost" id="x">取消</button><button class="btn primary" id="k">保存</button></div></div>`);
    const sh = sheet({ title: '月度学习目标', body: b });
    b.querySelector('#x').onclick = sh.close;
    b.querySelector('#k').onclick = async () => {
      const h = Math.max(1, Math.min(400, Number(b.querySelector('#g').value) || 10));
      const settings = { ...(state.user.settings || {}), study: { ...(state.user.settings?.study || {}), goalHours: h } };
      const r = await api.patch('/me', { settings });
      state.user = r.user; sh.close(); toast(`目标改成每月 ${h} 小时`); paint();
    };
  }

  /* ---------- 统计 ---------- */
  async function paintStats(stats) {
    const mt = stats.monthTotal || { mins: 0, c: 0 };
    const total = stats.total || { mins: 0, c: 0 };
    const monthsWithData = (stats.byMonth || []).filter((m) => m.mins > 0);
    const avg = monthsWithData.length ? Math.round(monthsWithData.reduce((a, b) => a + b.mins, 0) / monthsWithData.length) : 0;
    const best = monthsWithData.slice().sort((a, b) => b.mins - a.mins)[0];
    const maxDay = Math.max(1, ...(stats.byDay || []).map((d) => d.mins || 0));

    body.innerHTML = `
      <div class="row wrap" style="gap:8px;margin-bottom:14px">
        <div class="seg" id="st-mode">
          <button data-m="month" class="on">按月</button><button data-m="year">按年</button>
        </div>
        <span style="flex:1"></span>
        ${monthPicker('st-month', month)}
        <select class="input" id="st-year" style="width:104px;height:34px;display:none">${yearOptions(stats.years)}</select>
      </div>
      <div id="st-view"></div>`;

    let mode = 'month';
    const view = body.querySelector('#st-view');
    const mWrap = body.querySelector('#st-month');
    const yInput = body.querySelector('#st-year');

    const render = () => {
      if (mode === 'month') {
        mWrap.style.display = ''; yInput.style.display = 'none';
        const dim = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate();
        const firstWd = new Date(`${month}-01T00:00:00`).getDay();
        const dayMap = new Map((stats.byDay || []).map((d) => [d.d, d.mins]));
        let cells = '';
        for (let i = 0; i < firstWd; i++) cells += '<div class="heat-cell empty"></div>';
        for (let d = 1; d <= dim; d++) {
          const key = `${month}-${pad2(d)}`;
          const mins = dayMap.get(key) || 0;
          const lv = mins === 0 ? 0 : mins < 30 ? 1 : mins < 60 ? 2 : mins < 120 ? 3 : 4;
          cells += `<div class="heat-cell lv${lv}" title="${key}：${hm(mins)}"><span>${d}</span></div>`;
        }
        const cats2 = stats.monthByCat || [];
        const catTotal = cats2.reduce((a, b) => a + b.mins, 0) || 1;
        view.innerHTML = `
          <div class="stat-cards" style="margin-bottom:14px">
            <div class="stat"><div class="k">本月合计</div><div class="v">${(mt.mins / 60).toFixed(1)}<span class="u">小时</span></div></div>
            <div class="stat"><div class="k">记录条数</div><div class="v">${mt.c}<span class="u">条</span></div></div>
            <div class="stat"><div class="k">学习天数</div><div class="v">${(stats.byDay || []).length}<span class="u">天</span></div></div>
            <div class="stat"><div class="k">日均</div><div class="v">${((stats.byDay || []).length ? mt.mins / stats.byDay.length / 60 : 0).toFixed(1)}<span class="u">小时</span></div></div>
          </div>
          <div class="card card-pad" style="margin-bottom:14px">
            <div class="card-title" style="margin-bottom:10px">${icon('grid', 15)} ${month.replace('-', ' 年 ')} 月 学习热力</div>
            <div class="heat-grid"><div class="heat-wd">${['日', '一', '二', '三', '四', '五', '六'].map((w) => `<span>${w}</span>`).join('')}</div>
              <div class="heat-cells">${cells}</div></div>
            <div class="row tiny muted" style="gap:6px;margin-top:8px;justify-content:flex-end">
              <span>少</span>${[0, 1, 2, 3, 4].map((l) => `<i class="heat-dot lv${l}"></i>`).join('')}<span>多</span></div>
          </div>
          <div class="card card-pad">
            <div class="card-title" style="margin-bottom:10px">分类占比</div>
            ${cats2.length ? cats2.map((c) => `<div class="cat-bar-row">
              <span class="cb-name">${esc(c.name)}</span>
              <span class="cb-track"><i style="width:${Math.round(c.mins / catTotal * 100)}%"></i></span>
              <span class="cb-val">${hm(c.mins)}</span></div>`).join('') : '<div class="empty">本月还没有记录</div>'}
          </div>`;
      } else {
        mWrap.style.display = 'none'; yInput.style.display = '';
        const maxM = Math.max(1, ...(stats.byMonth || []).map((m) => m.mins || 0));
        const catsY = stats.byCat || [];
        const catTotal = catsY.reduce((a, b) => a + b.mins, 0) || 1;
        view.innerHTML = `
          <div class="stat-cards" style="margin-bottom:14px">
            <div class="stat"><div class="k">${year} 年累计</div><div class="v">${(total.mins / 60).toFixed(1)}<span class="u">小时</span></div></div>
            <div class="stat"><div class="k">记录条数</div><div class="v">${total.c}<span class="u">条</span></div></div>
            <div class="stat"><div class="k">月均（有记录的月）</div><div class="v">${(avg / 60).toFixed(1)}<span class="u">小时</span></div></div>
            <div class="stat"><div class="k">最高月</div><div class="v">${best ? (best.mins / 60).toFixed(1) : 0}<span class="u">${best ? ' · ' + best.m.slice(5) + ' 月' : '小时'}</span></div></div>
          </div>
          <div class="card card-pad" style="margin-bottom:14px">
            <div class="card-title" style="margin-bottom:10px">${icon('chart', 15)} 12 个月趋势</div>
            <div class="row" style="align-items:flex-end;gap:8px;height:150px;padding:0 2px">
              ${Array.from({ length: 12 }, (_, i) => {
                const mm = `${year}-${pad2(i + 1)}`;
                const row = (stats.byMonth || []).find((x) => x.m === mm);
                const h = row ? Math.max(3, Math.round((row.mins || 0) / maxM * 100)) : 2;
                return `<div style="flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;gap:4px;height:100%">
                  <span class="tiny muted">${row ? hmLabel(row.mins) : ''}</span>
                  <span style="width:100%;max-width:30px;height:${h}%;min-height:3px;border-radius:6px 6px 3px 3px;background:linear-gradient(180deg,var(--primary),color-mix(in srgb,var(--primary) 55%,#fff))"></span>
                  <span class="tiny ${mm === curMonth() ? 'bold' : 'muted'}">${i + 1}</span></div>`;
              }).join('')}
            </div>
          </div>
          <div class="card card-pad">
            <div class="card-title" style="margin-bottom:10px">全年分类排行</div>
            ${catsY.length ? catsY.map((c, i) => `<div class="cat-bar-row">
              <span class="cb-name">${i === 0 ? '🥇 ' : ''}${esc(c.name)}</span>
              <span class="cb-track"><i style="width:${Math.round(c.mins / catTotal * 100)}%"></i></span>
              <span class="cb-val">${hm(c.mins)}</span></div>`).join('') : '<div class="empty">这一年还没有记录</div>'}
          </div>`;
      }
    };
    body.querySelectorAll('#st-mode button').forEach((b) => {
      b.onclick = () => {
        mode = b.dataset.m;
        body.querySelectorAll('#st-mode button').forEach((x) => x.classList.toggle('on', x === b));
        render();
      };
    });
    bindMonthPicker(body, async (v) => { if (v !== month) { month = v; await paint(); } });
    yInput.onchange = async (e) => { year = e.target.value; await paint(); };
    render();
  }

  /* ---------- 笔记（复用工作里的笔记库） ---------- */
  async function paintNotes() {
    const [notes, noteCats] = await Promise.all([
      api.get('/notes').catch(() => []),
      api.get('/categories', { scope: 'note' }).catch(() => []),
    ]);
    const list = notes.filter((n) => !q || n.title.includes(q) || (n.content || '').includes(q)
      || (n.tags || '').includes(q));
    body.innerHTML = `
      <div class="note-toolbar" style="margin-bottom:12px;display:flex;gap:8px;align-items:center">
        <div class="note-search open" style="flex:1">
          <span class="ns-ico">${icon('search', 15)}</span>
          <input id="nb-q" placeholder="搜标题、正文、标签" value="${esc(q)}">
        </div>
        <button class="btn primary sm" id="nb-new">${icon('plus', 15)} 新建笔记</button>
      </div>
      <div class="tiny muted" style="margin-bottom:10px">共 ${list.length} 篇 · 和「工作 - 笔记」是同一个库</div>
      <div class="note-list">${list.length ? list.map((n) => `
        <button class="note-card" data-nb="${n.id}">
          <div class="nc-top"><span class="bold small">${esc(n.title)}</span>
            ${n.pinned ? `<span class="ni-pin">${icon('pin', 12)}</span>` : ''}</div>
          <div class="nc-body">${esc(String(n.content || '').replace(/\n+/g, ' ').slice(0, 80)) || '（空）'}</div>
          <div class="nc-foot"><span>${(n.updated_at || n.created_at || '').slice(0, 10)}</span>
            ${(n.tags || '') ? `<span class="chip gray">${esc(n.tags.split(/[,，\s]+/).filter(Boolean).slice(0, 2).join(' · '))}</span>` : ''}</div>
        </button>`).join('') : '<div class="empty">还没有笔记</div>'}</div>`;

    const qi = body.querySelector('#nb-q');
    let qt = null;
    qi.oninput = () => { q = qi.value.trim(); clearTimeout(qt); qt = setTimeout(() => paint(), 260); };
    body.querySelector('#nb-new').onclick = () => noteEditor(null, noteCats);
    body.querySelectorAll('[data-nb]').forEach((b) => {
      b.onclick = () => noteEditor(notes.find((n) => String(n.id) === b.dataset.nb), noteCats);
    });
  }

  function noteEditor(n, noteCats) {
    const isNew = !n;
    const b = el(`<div class="sheet-body">
      <div class="field"><input class="input" id="t" placeholder="笔记标题" value="${esc(n?.title || '')}"></div>
      <div class="form-grid">
        <div class="field"><label class="field-label">分类</label>
          <select class="input" id="c"><option value="">未分类</option>${noteCats.map((c) => `<option value="${c.id}" ${Number(n?.category_id) === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
        <div class="field"><label class="field-label">标签（逗号分隔）</label><input class="input" id="g" value="${esc(n?.tags || '')}"></div>
      </div>
      <div class="field"><label class="field-label">正文</label>
        <textarea class="input" id="body" rows="12" style="font-family:inherit">${esc(n?.content || '')}</textarea></div>
      <label class="row small" style="gap:6px;margin-bottom:10px"><input type="checkbox" id="pin" ${n?.pinned ? 'checked' : ''}> 置顶</label>
      <div class="confirm-actions">
        ${isNew ? '' : '<button class="btn ghost" id="d" style="margin-right:auto;color:var(--red)">删除</button>'}
        <button class="btn ghost" id="x">取消</button><button class="btn primary" id="k">保存</button></div></div>`);
    const sh = sheet({ title: isNew ? '新建笔记' : n.title, body: b, wide: true });
    b.querySelector('#x').onclick = sh.close;
    if (!isNew) b.querySelector('#d').onclick = async () => {
      if (!(await confirmDialog('删除这篇笔记？'))) return;
      await api.del('/notes/' + n.id); sh.close(); paint();
    };
    b.querySelector('#k').onclick = async () => {
      const payload = {
        title: b.querySelector('#t').value.trim(),
        category_id: Number(b.querySelector('#c').value) || null,
        tags: b.querySelector('#g').value.trim(),
        content: b.querySelector('#body').value,
        pinned: b.querySelector('#pin').checked ? 1 : 0,
      };
      if (!payload.title) return toast('写个标题', 'warn');
      try {
        if (isNew) await api.post('/notes', payload); else await api.patch('/notes/' + n.id, payload);
        sh.close(); toast('已保存'); paint();
      } catch (e) { toast(e.message, 'err'); }
    };
  }

  /* ---------- 手动记一笔 ---------- */
  function editor(s) {
    const isNew = !s;
    const bodyEl = el(`<div class="sheet-body">
      <div class="form-grid">
        <div class="field"><label class="field-label">日期</label><input class="input" type="date" id="d" value="${esc(s?.date || ymd())}"></div>
        <div class="field"><label class="field-label">时长（分钟）</label><input class="input" type="number" id="m" value="${s?.minutes ?? 60}" min="0"></div>
      </div>
      <div class="field"><label class="field-label">学了什么</label><input class="input" id="t" value="${esc(s?.title || '')}" placeholder="如：读《语文学习任务设计》第 3 章"></div>
      <div class="field"><label class="field-label">分类</label><select class="input" id="c">${catOptions(s?.category_id)}</select></div>
      <div class="field"><label class="field-label">笔记 / 收获</label><textarea class="input" id="body" rows="5" placeholder="记录要点">${esc(s?.content || '')}</textarea></div>
      <div class="confirm-actions"><button class="btn ghost" id="x">取消</button><button class="btn primary" id="k">保存</button></div></div>`);
    const sh = sheet({ title: isNew ? '记一笔学习' : '编辑学习记录', body: bodyEl, wide: true });
    bodyEl.querySelector('#x').onclick = sh.close;
    bodyEl.querySelector('#k').onclick = async () => {
      const payload = {
        date: bodyEl.querySelector('#d').value,
        minutes: Number(bodyEl.querySelector('#m').value) || 0,
        title: bodyEl.querySelector('#t').value.trim(),
        category_id: Number(bodyEl.querySelector('#c').value) || null,
        content: bodyEl.querySelector('#body').value,
        source: s?.source || '',
      };
      if (!payload.title) return toast('请填写学了什么', 'warn');
      try {
        if (isNew) await api.post('/studies', payload); else await api.patch('/studies/' + s.id, payload);
        sh.close(); paint();
      } catch (e) { toast(e.message, 'err'); }
    };
  }

  function yearOptions(years) {
    const set = new Set([...(years || []), curYear(), String(new Date().getFullYear() - 1)]);
    return [...set].sort((a, b) => b.localeCompare(a)).map((y) => `<option ${y === year ? 'selected' : ''}>${y}</option>`).join('');
  }

  function streak(studies) {
    const days = new Set(studies.map((s) => s.date));
    let n = 0; const d = new Date();
    for (;;) {
      if (days.has(ymd(d))) { n++; d.setDate(d.getDate() - 1); }
      else {
        if (n === 0) { d.setDate(d.getDate() - 1); if (days.has(ymd(d))) { n++; d.setDate(d.getDate() - 1); continue; } }
        break;
      }
    }
    return n;
  }

  await paint();
});
