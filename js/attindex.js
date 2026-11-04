/* ============ 考勤：年级列表页（PRD 第 4 节 · 第一层） ============
 *
 * 这一页只回答一个问题：「哪个年级，今天查齐了没有」。
 * 点卡片进详情页（#/work/attendance/高一），花名册、三张表、统计都在那边。
 *
 * 【为什么要把年级抽成独立一页】
 *   以前是一行 tab 直接切年级，年级加到第四个就开始横向滚动；
 *   「新建 / 改名 / 删除」这些属于年级本身的操作没地方放，
 *   只能混在考勤操作按钮里，看着像在管某张表。
 *   现在年级的事归这一页，考勤的事归详情页，各管各的。
 */

import { api, esc, toast } from './core.js';
import { icon, go } from './ui.js';
import { dayProgress, ymd } from './attday.js';
import { addGradeDialog, gradeManageDialog, gradeTabs } from './attgrade.js';

const GRADE_URL = (g) => `work/attendance/${encodeURIComponent(g)}`;

export async function renderGradeList(box) {
  const [gradesData, tables] = await Promise.all([
    api.get('/grades').catch(() => ({ grades: [], counts: {} })),
    api.get('/attendance').catch(() => []),
  ]);
  const tabs = gradeTabs(gradesData);
  const counts = gradesData.counts || {};
  const today = ymd();

  const progress = tabs.map((g) => ({ grade: g, ...dayProgress({ date: today, grade: g, tables }) }));
  const totalTeachers = tabs.reduce((n, g) => n + (Number(counts[g]) || 0), 0);
  const totalSlots = progress.reduce((n, p) => n + p.total, 0);
  const confirmedSlots = progress.reduce((n, p) => n + p.done, 0);
  const builtSlots = progress.reduce((n, p) => n + p.built, 0);
  const pendingSlots = Math.max(0, totalSlots - confirmedSlots);

  const statusFor = (grade, type) => {
    const list = tables.filter((t) =>
      (t.grade || '高一') === grade &&
      t.sheet_date === today &&
      (t.sheet_type || t.kind) === type
    );
    if (!list.length) return { text: '未生成', cls: 'grey' };
    const confirmed = list.filter((t) => (t.confirm_state || 'none') === 'confirmed').length;
    if (confirmed === list.length) return { text: '已确认', cls: 'green' };
    if (list.some((t) => (t.confirm_state || 'none') === 'modified')) return { text: '修改待确认', cls: 'blue' };
    return { text: '待确认', cls: 'amber' };
  };

  const card = (g) => {
    const n = counts[g] || 0;
    const p = progress.find((x) => x.grade === g) || { done: 0, built: 0, total: 3, dup: 0 };
    const pct = p.total ? Math.round(p.done / p.total * 100) : 0;
    const st = n === 0 ? 'empty' : p.done === p.total ? 'ok' : p.built === 0 ? 'idle' : 'wait';
    const badge = { ok: 'green', wait: 'amber', idle: 'grey', empty: 'grey' }[st];
    const stText = n === 0 ? '名册还没录'
      : p.done === p.total ? '今日已确认'
        : p.built === 0 ? '今日待开始' : '今日进行中';
    const types = [
      ['seat', '坐班表'],
      ['research', '教研表'],
      ['class', '上课表'],
    ];
    return `<button class="agl-card ${st}" data-g="${esc(g)}" title="进入 ${esc(g)}">
      <div class="agl-c-top">
        <span class="agl-c-name">${esc(g)}</span>
        <span class="att-badge ${badge}">${esc(stText)}</span>
      </div>
      <div class="agl-c-meta"><b>${n}</b> 位教师 <span>·</span> 今日已确认 ${p.done}/${p.total}</div>
      <div class="agl-c-bar"><i style="width:${pct}%"></i></div>
      <div class="agl-status-list">
        ${types.map(([type, label]) => {
          const s = statusFor(g, type);
          return `<span class="agl-status-item"><i>${label}</i><b class="att-badge ${s.cls}">${s.text}</b></span>`;
        }).join('')}
      </div>
      <div class="agl-c-foot">
        <span>${p.dup ? `重复记录 ${p.dup}` : '按年级独立管理花名册与考勤数据'}</span>
        <span class="agl-c-go">进入考勤工作台 ${icon('right', 13)}</span>
      </div>
    </button>`;
  };

  box.innerHTML = `<div class="agl">
    <div class="agl-page-head">
      <div>
        <div class="agl-eyebrow">TEACHER WORKBENCH · ATTENDANCE</div>
        <h2>考勤管理</h2>
        <p>按年级管理花名册、每日三张考勤表与教师考勤统计</p>
      </div>
      <div class="agl-head-actions">
        <span class="agl-live"><i></i> 数据实时状态</span>
        <button class="btn ghost sm" id="agl-mgr">${icon('grid', 15)} 年级管理</button>
        <button class="btn primary sm" id="agl-add">${icon('plus', 15)} 新建年级</button>
      </div>
    </div>

    <div class="agl-stat-grid">
      <div class="agl-stat"><span class="agl-stat-icon blue">${icon('layers', 18)}</span><div><b>${tabs.length}</b><small>管理年级</small></div></div>
      <div class="agl-stat"><span class="agl-stat-icon violet">${icon('users', 18)}</span><div><b>${totalTeachers}</b><small>教师总人数</small></div></div>
      <div class="agl-stat"><span class="agl-stat-icon green">${icon('check-circle', 18)}</span><div><b>${confirmedSlots}</b><small>今日已确认表</small></div></div>
      <div class="agl-stat"><span class="agl-stat-icon amber">${icon('clock', 18)}</span><div><b>${pendingSlots}</b><small>未完成表</small></div></div>
    </div>

    <div class="agl-section-head">
      <div><h3>年级考勤工作区</h3><p>选择年级进入独立工作台，查看当天考勤与历史记录</p></div>
      <span class="agl-date">${today}</span>
    </div>
    <div class="agl-grid">
      ${tabs.map(card).join('')}
      <button class="agl-card agl-new" id="agl-add-card">
        <span class="agl-plus">${icon('plus', 22)}</span>
        <span class="agl-new-t">新建年级</span>
        <span class="agl-new-s">例如：高三、国际部</span>
      </button>
    </div>
    <div class="agl-foot">
      <button class="link-btn agl-danger" id="agl-reset">清空考勤数据…</button>
      <span class="agl-foot-note">清空前会提示并导出备份；年级、花名册、考勤记录及统计数据将一并处理。</span>
    </div>
  </div>`;

  box.querySelectorAll('[data-g]').forEach((b) => {
    b.onclick = () => go(GRADE_URL(b.dataset.g));
  });
  const add = () => addGradeDialog(() => renderGradeList(box));
  box.querySelector('#agl-add').onclick = add;
  box.querySelector('#agl-add-card').onclick = add;
  box.querySelector('#agl-mgr').onclick = () => gradeManageDialog(() => renderGradeList(box), () => renderGradeList(box));
  box.querySelector('#agl-reset').onclick = async () => {
    try {
      const m = await import('./attreset.js');
      await m.resetAttendanceData(() => renderGradeList(box));
    } catch (e) {
      toast(e.message || '清空失败', 'err');
    }
  };
}
