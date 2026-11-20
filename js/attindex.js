/* ============ 考勤管理首页（年级总览） ============ */
/* 首页只负责「选年级、进工作台」。
   以前这里还铺了当天三张表的确认进度，但它是渲染那一刻抓的一次快照：
   在工作台里确认完回到首页，数字还停在 0/3，看着就是坏的。
   生成、编辑、确认的实时状态本来就只有工作台里那份是准的，首页不再重复一遍。 */
import { api, esc, toast } from './core.js';
import { icon, go } from './ui.js';
import { ymd } from './attday.js';
import { addGradeDialog, gradeManageDialog, gradeTabs } from './attgrade.js';

const GRADE_URL = (g) => `work/attendance/${encodeURIComponent(g)}`;
/* 工作台里有什么是固定的，直接写死；换成当天数据就又开始骗人。 */
const WORKSPACE_SCOPE = ['花名册', '坐班表', '教研表', '上课表'];

function dateText(date) {
  const d = new Date(`${date}T00:00:00`);
  if (Number.isNaN(d.getTime())) return date;
  const week = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}（周${week}）`;
}

export async function renderGradeList(box) {
  const today = ymd();
  const gradesData = await api.get('/grades').catch(() => ({ grades: [], counts: {} }));
  const tabs = gradeTabs(gradesData);
  const counts = gradesData.counts || {};
  const grades = tabs.map((grade) => ({ grade, count: Number(counts[grade] || 0) }));
  const teacherTotal = grades.reduce((sum, item) => sum + item.count, 0);

  const card = ({ grade, count }) => `<button class="agd-grade-card" data-g="${esc(grade)}" title="进入 ${esc(grade)} 考勤工作台">
      <span class="agd-grade-banner">
        <span class="agd-grade-name"><i>${icon('users', 20)}</i>${esc(grade)}</span>
      </span>
      <span class="agd-grade-content">
        <span class="agd-grade-count${count ? '' : ' is-empty'}">
          <b>${count || '—'}</b><span>${count ? '位教师' : '还没有教师'}</span>
        </span>
        <span class="agd-grade-scope">${WORKSPACE_SCOPE.map(esc).join('<i>·</i>')}</span>
        <span class="agd-grade-foot"><span>按年级独立管理花名册与考勤数据</span><b>进入考勤工作台 ${icon('right', 14)}</b></span>
      </span>
    </button>`;

  box.innerHTML = `<div class="agl agd-dashboard">
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
    </section>

    <section class="agd-workspace">
      <div class="agd-section-head">
        <div><h3>${icon('grid', 19)} 年级考勤工作区</h3><p>选择年级进入独立工作台，查看当天考勤与历史记录</p></div>
        <span class="agd-date">${dateText(today)}</span>
      </div>
      <div class="agd-grade-grid${tabs.length ? '' : ' is-empty'}">
        ${grades.map(card).join('')}
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
