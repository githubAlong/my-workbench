/* ============ 考勤管理首页（年级总览） ============ */
/* 首页只负责展示年级与每日进度；所有生成、编辑、确认动作仍由年级工作台处理。 */
import { api, esc, toast } from './core.js';
import { icon, go } from './ui.js';
import { dayProgress, ymd, readSeatPeriods } from './attday.js';
import { addGradeDialog, gradeManageDialog, gradeTabs } from './attgrade.js';

const GRADE_URL = (g) => `work/attendance/${encodeURIComponent(g)}`;
const TYPE_LABEL = { seat: '坐班表', research: '教研表', class: '上课表' };

function dateText(date) {
  const d = new Date(`${date}T00:00:00`);
  if (Number.isNaN(d.getTime())) return date;
  const week = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}（周${week}）`;
}

function tableState(tables, grade, type, periods, classConfirmed) {
  const matches = (periods || ['']).map((period) => {
    const candidates = tables.filter((t) =>
      t.grade === grade
      && (t.sheet_type || t.kind) === type
      && (type !== 'seat' || String(t.periods || '') === String(period || ''))
      && !t.deleted_at);
    return candidates.find((t) => t.confirm_state === 'confirmed')
      || candidates.find((t) => t.confirm_state === 'modified')
      || candidates[0]
      || null;
  });
  const existing = matches.filter(Boolean);
  if (!existing.length) {
    if (type === 'seat' && !classConfirmed) return { label: '待上课表确认', tone: 'locked' };
    return { label: '未生成', tone: 'idle' };
  }
  if (existing.length === matches.length && existing.every((t) => t.confirm_state === 'confirmed')) {
    return { label: '已确认', tone: 'ok' };
  }
  if (existing.some((t) => t.confirm_state === 'modified')) return { label: '待重新确认', tone: 'warn' };
  return { label: '待确认', tone: 'wait' };
}

export async function renderGradeList(box) {
  const [gradesData, tables] = await Promise.all([
    api.get('/grades').catch(() => ({ grades: [], counts: {} })),
    api.get('/attendance').catch(() => []),
  ]);
  const tabs = gradeTabs(gradesData);
  const counts = gradesData.counts || {};
  const today = ymd();
  const seatPeriods = readSeatPeriods().map(String);
  const progressList = tabs.map((grade) => ({
    grade,
    count: Number(counts[grade] || 0),
    progress: dayProgress({ date: today, grade, tables }),
  }));
  const teacherTotal = progressList.reduce((sum, item) => sum + item.count, 0);
  const confirmedTotal = progressList.reduce((sum, item) => sum + item.progress.done, 0);
  const expectedTotal = progressList.reduce((sum, item) => sum + item.progress.total, 0);
  const incompleteTotal = Math.max(0, expectedTotal - confirmedTotal);

  const card = ({ grade, count, progress }) => {
    const pct = progress.total ? Math.round(progress.done / progress.total * 100) : 0;
    const todayTables = tables.filter((t) =>
      t.grade === grade && String(t.sheet_date || '') === today && !t.deleted_at);
    const classConfirmed = todayTables.some((t) =>
      (t.sheet_type || t.kind) === 'class' && t.confirm_state === 'confirmed');
    const states = [
      { type: 'seat', state: tableState(todayTables, grade, 'seat', seatPeriods, classConfirmed) },
      { type: 'research', state: tableState(todayTables, grade, 'research', [''], classConfirmed) },
      { type: 'class', state: tableState(todayTables, grade, 'class', [''], classConfirmed) },
    ];
    const overall = count === 0 ? { label: '暂无教师', tone: 'empty' }
      : progress.done === progress.total ? { label: '今日已查齐', tone: 'ok' }
        : progress.built ? { label: '今日进行中', tone: 'wait' }
          : { label: '今日待开始', tone: 'idle' };

    return `<button class="agd-grade-card" data-g="${esc(grade)}" title="进入 ${esc(grade)} 考勤工作台">
      <span class="agd-grade-banner">
        <span class="agd-grade-name"><i>${icon('users', 20)}</i>${esc(grade)}</span>
        <span class="agd-overall ${overall.tone}"><i></i>${overall.label}</span>
      </span>
      <span class="agd-grade-content">
        <span class="agd-grade-meta"><b>${count}</b> 位教师 <span>·</span> 今日已确认 <strong>${progress.done}/${progress.total}</strong></span>
        <span class="agd-progress"><i style="width:${pct}%"></i></span>
        <span class="agd-progress-label"><span>今日确认进度</span><b>${pct}%</b></span>
        <span class="agd-sheet-grid">
          ${states.map(({ type, state }) => `<span class="agd-sheet ${state.tone}">
            <i>${type === 'seat' ? '▦' : type === 'research' ? '▤' : '▣'}</i>
            <b>${TYPE_LABEL[type]}</b><em>${state.label}</em>
          </span>`).join('')}
        </span>
        <span class="agd-grade-foot"><span>按年级独立管理花名册与考勤数据</span><b>进入考勤工作台 ${icon('right', 14)}</b></span>
      </span>
    </button>`;
  };

  box.innerHTML = `<div class="agl agd-dashboard">
    <nav class="agd-crumb" aria-label="面包屑导航">
      <span class="agd-crumb-home">${icon('home', 15)}</span>
      <span>首页</span><i>›</i><span>工作</span><i>›</i><b>考勤</b>
    </nav>
    <header class="agd-header">
      <div class="agd-heading">
        <span class="agd-heading-icon">${icon('cal', 27)}</span>
        <div><h2>考勤管理</h2><p>按年级管理花名册、每日三张考勤表与教师考勤统计</p></div>
      </div>
      <div class="agd-actions">
        <span class="agd-live"><i></i>数据实时状态</span>
        <button class="btn ghost agd-manage" id="agl-mgr">${icon('grid', 15)} 年级管理</button>
        <button class="btn primary agd-add" id="agl-add">${icon('plus', 16)} 新建年级</button>
      </div>
    </header>

    <section class="agd-stats" aria-label="考勤数据概览">
      <div class="agd-stat blue"><i>▱</i><div><b>${tabs.length}</b><span>管理年级</span></div></div>
      <div class="agd-stat purple"><i>♙</i><div><b>${teacherTotal}</b><span>教师总人数</span></div></div>
      <div class="agd-stat green"><i>✓</i><div><b>${confirmedTotal}</b><span>今日已确认表</span></div></div>
      <div class="agd-stat orange"><i>◷</i><div><b>${incompleteTotal}</b><span>未完成表</span></div></div>
    </section>

    <section class="agd-workspace">
      <div class="agd-section-head">
        <div><h3>${icon('grid', 19)} 年级考勤工作区</h3><p>选择年级进入独立工作台，查看当天考勤与历史记录</p></div>
        <span class="agd-date">${dateText(today)}</span>
      </div>
      <div class="agd-grade-grid">
        ${progressList.map(card).join('')}
        <button class="agd-new-card" id="agl-add-card">
          <span class="agd-new-plus">${icon('plus', 25)}</span>
          <b>新建年级</b><span>添加新的年级考勤管理</span>
          <i class="agd-school-scene" aria-hidden="true">⌂</i>
        </button>
      </div>
    </section>

    <details class="agd-maintenance">
      <summary>数据维护</summary>
      <div><span>清空操作会影响年级、花名册、考勤记录及统计数据，请谨慎操作。</span>
        <button class="link-btn agl-danger" id="agl-reset">清空考勤数据…</button>
      </div>
    </details>
  </div>`;

  box.querySelectorAll('[data-g]').forEach((button) => {
    button.onclick = () => go(GRADE_URL(button.dataset.g));
  });
  const add = () => addGradeDialog(() => renderGradeList(box));
  box.querySelector('#agl-add').onclick = add;
  box.querySelector('#agl-add-card').onclick = add;
  box.querySelector('#agl-mgr').onclick = () =>
    gradeManageDialog(() => renderGradeList(box), () => renderGradeList(box));
  box.querySelector('#agl-reset').onclick = async () => {
    try {
      const m = await import('./attreset.js');
      await m.resetAttendanceData(() => renderGradeList(box));
    } catch (e) {
      toast(e.message || '清空失败', 'err');
    }
  };
}
