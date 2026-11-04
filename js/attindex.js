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

  const card = (g) => {
    const n = counts[g] || 0;
    const p = dayProgress({ date: today, grade: g, tables });
    const pct = p.total ? Math.round(p.done / p.total * 100) : 0;
    /* 四种状态：没名册 / 今天没建表 / 建了没确认完 / 全确认 */
    const st = n === 0 ? 'empty' : p.done === p.total ? 'ok' : p.built === 0 ? 'idle' : 'wait';
    const badge = { ok: 'green', wait: 'amber', idle: 'grey', empty: 'grey' }[st];
    const stText = n === 0 ? '名册还没录'
      : p.done === p.total ? '今日已查齐'
        : p.built === 0 ? '今日还没建表' : `今日 ${p.done}/${p.total}`;
    return `<button class="agl-card ${st}" data-g="${esc(g)}" title="进入 ${esc(g)}">
      <div class="agl-c-top">
        <span class="agl-c-name">${esc(g)}</span>
        <span class="att-badge ${badge}">${esc(stText)}</span>
      </div>
      <div class="agl-c-meta">${n ? `${n} 位老师` : '还没导入名册'}${p.dup ? ` · <b class="agl-dup">重复 ${p.dup}</b>` : ''}</div>
      <div class="agl-c-bar"><i style="width:${pct}%"></i></div>
      <div class="agl-c-foot">
        <span>今天 ${p.done}/${p.total} 张已确认</span>
        <span class="agl-c-go">进入${icon('right', 13)}</span>
      </div>
    </button>`;
  };

  box.innerHTML = `<div class="agl">
    <div class="agl-top">
      <div class="agl-hint">每个年级的花名册、三张考勤表、统计都是独立的一套。点进去只看这一个年级。</div>
      <button class="btn ghost sm" id="agl-mgr">${icon('grid', 15)} 年级管理</button>
    </div>
    <div class="agl-grid">
      ${tabs.map(card).join('')}
      <button class="agl-card agl-new" id="agl-add">
        <span class="agl-plus">${icon('plus', 20)}</span>
        <span class="agl-new-t">新建年级</span>
        <span class="agl-new-s">比如高三</span>
      </button>
    </div>
    <div class="agl-foot">
      <button class="link-btn agl-danger" id="agl-reset">清空考勤数据…</button>
      <span class="agl-foot-note">名册、三张表、统计会一起清掉，清之前会先导出一份备份</span>
    </div>
  </div>`;

  box.querySelectorAll('[data-g]').forEach((b) => {
    b.onclick = () => go(GRADE_URL(b.dataset.g));
  });
  box.querySelector('#agl-add').onclick = () => addGradeDialog(() => renderGradeList(box));
  box.querySelector('#agl-mgr').onclick = () => gradeManageDialog(() => renderGradeList(box), () => renderGradeList(box));
  box.querySelector('#agl-reset').onclick = async () => {
    /* 延迟加载：清空是低频且危险的动作，不该让 3600 行的编辑器和它一起进首屏 */
    try {
      const m = await import('./attreset.js');
      await m.resetAttendanceData(() => renderGradeList(box));
    } catch (e) {
      toast(e.message || '清空失败', 'err');
    }
  };
}
