/* ================= 抽人 / 课堂签到（第 23 条，从 work.js 抽离） =================
   原来它和「课件 / 惩罚盲盒」一起塞在「工作 › 课件」里，
   现在独立成「小助手 › 抽人」一级子页面，逻辑不变。 */
import {
  api, el, esc, clsName, startPoll, toast, sheet, confirmDialog, ymd,
} from './core.js';
import { registerView, icon, pageHead, onViewLeave } from './ui.js';
import { remarkField } from './work.js';

/* 签到状态字典：缺它页面就不知道「到了 / 迟到 / 请假 / 未到」怎么上色 */
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

async function renderRoll(box) {
  /* 页面级的轮询句柄：离开本页要停掉，否则切到别的模块还在偷偷请求 */
  let stopLive = null;
  const stopLivePoll = () => { if (stopLive) { stopLive(); stopLive = null; } };
  const load = async () => {
    stopLivePoll();   // 每次重绘前先停掉旧的，避免重复叠加
    const [rollSess, rosters] = await Promise.all([
      api.get('/roll/sessions').catch(() => []),
      api.get('/rosters').catch(() => []),
    ]);
    box.innerHTML = paintRollCard(rollSess, rosters);
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
    /* 有进行中的签到才开轮询：每 3 秒拉一次，全部结束后自动停 */
    const hasLive = rollSess.some((x) => x.status === 'open');
    if (hasLive) {
      for (const x of rollSess) {
        const row = box.querySelector(`[data-roll-row="${x.id}"]`);
        if (row) row.dataset.lastSigned = (x.stats?.present || 0) + (x.stats?.late || 0);
      }
      stopLive = startPoll(async () => {
        const fresh = await api.get('/roll/sessions');
        // 页面被切走了就别更新了（防御：box 已不在文档里）
        if (!document.body.contains(box)) { stopLivePoll(); return; }
        applyRollStats(fresh);
        if (!fresh.some((x) => x.status === 'open')) { stopLivePoll(); load(); }
      });
      onViewLeave(stopLivePoll);   // 切到别的模块时停掉
    }
  };
  await load();
}

registerView(async function roll(main) {
  main.innerHTML = pageHead('抽人', '课堂签到——学生打开短链点「我到了」，这里实时长出人数')
    + '<div id="roll-body"></div>';
  const box = main.querySelector('#roll-body');
  await renderRoll(box);
});
