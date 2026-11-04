/* ============ 年级管理（PRD FR-GRADE 1~4） ============
 *
 * 从 attendance.js 抽出来的原因：
 *   列表页（attindex.js）和详情页（attendance.js）都要开这个弹层，
 *   留在任何一边都会形成「A 引 B、B 引 A」的循环依赖。
 *
 * 规则本身没变：每个年级是独立数据空间，改名会把该年级的名册和考勤表
 * 一起迁过去；删除是软删（进回收站），提示里说清楚会连带删掉什么。
 */

import { api, el, esc, toast, sheet, confirmDialog } from './core.js';

/* 两个内置年级。学校的考勤只管高一高二；要加年级走「新建年级」。
   放在这里是因为列表页和详情页都要用，各自写一份迟早对不上。 */
export const MAIN_GRADES = ['高一', '高二'];

/* 年级 tab 顺序：内置两个在前，额外加的（高三之类）排后面 */
export function gradeTabs(data) {
  const extra = ((data && data.grades) || []).filter((g) => !MAIN_GRADES.includes(g));
  return [...MAIN_GRADES, ...extra];
}

export function addGradeDialog(reload) {
  const body = el(`<div class="sheet-body">
    <div class="field"><label class="field-label">年级名称</label>
      <input class="input" id="gname" placeholder="如：高三">
      <div class="field-hint">内置「高一」「高二」，需要别的年级（比如高三）时在这里加。新年级是空的，名册要单独录。</div></div>
    <div class="confirm-actions"><button class="btn ghost" id="c">取消</button><button class="btn primary" id="k">添加</button></div>
  </div>`);
  const s = sheet({ title: '新建年级', body });
  const input = body.querySelector('#gname');
  setTimeout(() => input.focus(), 120);
  body.querySelector('#c').onclick = s.close;
  body.querySelector('#k').onclick = async () => {
    const name = input.value.trim();
    if (!name) return toast('请填写年级名', 'warn');
    try { await api.post('/grades', { name }); s.close(); toast(`已添加「${name}」`, 'ok'); reload?.(); }
    catch (e) { toast(e.message || '添加失败', 'err'); }
  };
  input.onkeydown = (e) => { if (e.key === 'Enter') body.querySelector('#k').click(); };
}

export async function gradeManageDialog(reload, onChanged) {
  let data = await api.get('/grades').catch(() => ({ grades: [], counts: {} }));
  const body = el(`<div class="sheet-body" id="gm-body"></div>`);
  const s = sheet({ title: '年级管理', body, wide: true });
  const paint = () => {
    const list = data.grades || [];
    body.innerHTML = `<div class="gm-list">
      ${list.map((g) => `<div class="gm-row" data-g="${esc(g)}">
        <input class="input gm-name" value="${esc(g)}" aria-label="年级名称">
        <span class="gm-meta">${data.counts?.[g] ?? 0} 位老师</span>
        <button class="btn ghost sm" data-rename="${esc(g)}">改名</button>
        <button class="btn ghost sm danger" data-del="${esc(g)}">删除</button>
      </div>`).join('')}
    </div>
    <div class="att-tip-note" style="margin-top:12px">
      每个年级的花名册、三张考勤表、统计表都是独立的。改名会把该年级的名册和考勤表一起改过去；删除会连带删掉这些数据（进回收站，可从回收站找回）。
    </div>
    <div class="confirm-actions">
      <button class="btn ghost" id="gm-add">＋ 新建年级</button>
      <button class="btn primary" id="gm-close">关闭</button>
    </div>`;
    body.querySelectorAll('[data-rename]').forEach((b) => {
      b.onclick = async () => {
        const old = b.dataset.rename;
        const row = b.closest('.gm-row');
        const name = String(row.querySelector('.gm-name').value || '').trim();
        if (!name) return toast('年级名不能为空', 'warn');
        if (name === old) return toast('名字没变', 'warn');
        try {
          const r = await api.patch('/grades/' + encodeURIComponent(old), { name });
          toast(`已改名为「${name}」，${r?.migrated?.teachers ?? 0} 位老师、${r?.migrated?.tables ?? 0} 张表一起迁过去了`, 'ok', 4200);
          await refresh();
          onChanged?.();
        } catch (e) { toast(e.message || '改名失败', 'err'); }
      };
    });
    body.querySelectorAll('[data-del]').forEach((b) => {
      b.onclick = async () => {
        const g = b.dataset.del;
        const n = data.counts?.[g] ?? 0;
        const ok = await confirmDialog(
          `删除「${g}」？该年级下的 ${n} 位老师、所有考勤表与统计数据会一并删除（可从回收站找回）。`,
          { title: '删除年级', okText: '删除', danger: true },
        );
        if (!ok) return;
        try {
          const r = await api.del('/grades/' + encodeURIComponent(g));
          toast(`已删除「${g}」：${r?.deleted?.teachers ?? 0} 位老师、${r?.deleted?.tables ?? 0} 张表`, 'ok', 4200);
          await refresh();
          onChanged?.();
        } catch (e) { toast(e.message || '删除失败', 'err'); }
      };
    });
    body.querySelector('#gm-add').onclick = () => { s.close(); addGradeDialog(() => { reload?.(); onChanged?.(); }); };
    body.querySelector('#gm-close').onclick = s.close;
  };
  const refresh = async () => {
    data = await api.get('/grades').catch(() => data);
    paint();
  };
  paint();
}
