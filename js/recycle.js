import { api, esc, toast, confirmDialog, fmtDateTime } from './core.js';
import { registerView, icon, pageHead, onViewLeave } from './ui.js';

/* ===================================================================
   回收站 —— 对齐 Windows 11
     1. 每项显示「原位置 + 删除时间 + 剩余天数」
     2. 按原位置分组（任务便签 / 工作 / 学习 / 其他），可筛选
     3. 支持按名称 / 时间 / 大小 / 即将过期排序
     4. 还原 / 全部还原 / 彻底删除 / 清空（清空后 8 秒可撤销）
     5. 30 天自动过期，页面上写清楚还剩几天
   =================================================================== */

const LABEL = {
  items: '事项/任务', todos: '便签', lessons: '上课记录', invigilations: '监考', trips: '出差',
  trip_items: '出差发票', materials: '课件', notes: '笔记', homework: '作业',
  studies: '学习记录', courses: '课程', periods: '节次', categories: '分类',
  students: '学生', teachers: '教师', attendance_tables: '考勤表', attendance_rows: '考勤人员',
  punishments: '惩罚任务', exceptions: '课表调整', reminders: '提醒', attachments: '附件',
};

const GROUPS = [
  { id: 'all', label: '全部' },
  { id: 'task', label: '任务便签' },
  { id: 'work', label: '工作' },
  { id: 'study', label: '学习' },
  { id: 'other', label: '其他' },
];

const SORTS = [
  { id: 'time', label: '删除时间' },
  { id: 'name', label: '名称' },
  { id: 'size', label: '大小' },
  { id: 'expire', label: '即将过期' },
];

const ICON_OF = { task: 'daily', work: 'briefcase', study: 'study', other: 'file' };

const fmtSize = (n) => {
  const b = Number(n) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
};

const daysText = (d) => {
  if (d <= 0) return '今天彻底删除';
  if (d === 1) return '明天彻底删除';
  return `还剩 ${d} 天`;
};

registerView(async function recycle(main) {
  let rows = [];
  let counts = {};
  let keepDays = 30;
  let group = 'all';
  let sort = 'time';
  let picked = new Set();
  /* 清空后的撤销数据：8 秒内点「撤销」可整体恢复 */
  let undoBox = null;
  let undoTimer = null;

  /* 任何一次彻底删除都留一份撤销快照，8 秒内可整体复活。
     之前只有「清空」留了快照，单条/批量彻底删除直接扔掉，删错了只能认——那不符合用户要的「千万别找不回来」。 */
  const armUndo = (items, label = '已删除') => {
    if (!items || !items.length) return;
    undoBox = { items, label };
    clearTimeout(undoTimer);
    undoTimer = setTimeout(() => { undoBox = null; paint(); }, 8000);
  };

  const load = async () => {
    const r = await api.get('/recycle');
    rows = r.list || [];
    counts = r.counts || { all: 0 };
    keepDays = r.keepDays || 30;
    // 已经不在列表里的选中项要清掉，否则「还原选中」会带着幽灵 id
    const alive = new Set(rows.map((x) => x.id));
    picked = new Set([...picked].filter((id) => alive.has(id)));
    paint();
  };

  const view = () => {
    const list = group === 'all' ? rows.slice() : rows.filter((x) => x.group === group);
    if (sort === 'name') list.sort((a, b) => String(a.title).localeCompare(String(b.title), 'zh'));
    else if (sort === 'size') list.sort((a, b) => (b.fileSize || b.size) - (a.fileSize || a.size));
    else if (sort === 'expire') list.sort((a, b) => a.daysLeft - b.daysLeft || b.id - a.id);
    else list.sort((a, b) => b.id - a.id);
    return list;
  };

  function paint() {
    const list = view();
    const total = rows.length;
    const soon = rows.filter((x) => x.daysLeft <= 3).length;

    main.innerHTML = pageHead(
      '回收站',
      total ? `${total} 项 · ${keepDays} 天后自动彻底删除` : '删除的内容都会先来这里',
      `<button class="btn ghost sm" id="empty" ${total ? '' : 'disabled'} style="${total ? 'color:var(--red)' : ''}">清空回收站</button>`,
    ) + `
      ${undoBox ? `<div class="rec-undo" id="undo-bar">
        <span class="rec-undo-t">${icon('check', 15)} ${undoBox.label || '已删除'} ${undoBox.items.length} 项</span>
        <button class="btn ghost sm" id="undo-btn">撤销</button>
        <i class="rec-undo-timer"></i>
      </div>` : ''}

      ${total ? `
      <div class="seg rec-seg">${GROUPS.map((g) => `<button class="${group === g.id ? 'on' : ''}" data-g="${g.id}">${g.label}${counts[g.id] ? `<em>${counts[g.id]}</em>` : ''}</button>`).join('')}</div>

      <div class="rec-tools">
        <button class="btn ghost sm" id="pick-all">${picked.size && picked.size === list.length ? '取消全选' : '全选'}</button>
        <span class="rec-count">${picked.size ? `已选 ${picked.size} 项` : `${list.length} 项`}</span>
        <span style="flex:1"></span>
        <select class="input rec-sort" id="sort-sel">${SORTS.map((s) => `<option value="${s.id}" ${sort === s.id ? 'selected' : ''}>按${s.label}</option>`).join('')}</select>
      </div>

      ${soon ? `<div class="rec-warn">${icon('alert', 14)}<span>有 ${soon} 项将在 3 天内彻底删除，要留就尽快还原</span></div>` : ''}

      <div class="card rec-list">
        ${list.length ? list.map((r) => `
          <div class="rec-item ${picked.has(r.id) ? 'on' : ''}" data-row="${r.id}">
            <label class="rec-check" data-stop>
              <input type="checkbox" data-id="${r.id}" ${picked.has(r.id) ? 'checked' : ''}>
              <span class="rec-box">${icon('check', 12)}</span>
            </label>
            <div class="rec-ico ${r.group}">${icon(ICON_OF[r.group] || 'file', 17)}</div>
            <div class="rec-main">
              <div class="rec-title">${esc(r.title || '(无标题)')}</div>
              <div class="rec-meta"><span class="rec-tag">${esc(LABEL[r.entity] || r.entity)}</span><span class="rec-loc">${esc(r.location)}</span></div>
              <div class="rec-sub">
                <span>${fmtDateTime(r.deleted_at)}</span>
                ${(r.fileSize || r.size) ? `<span class="rec-sep">·</span><span>${fmtSize(r.fileSize || r.size)}</span>` : ''}
                <span class="rec-sep">·</span>
                <span class="${r.daysLeft <= 3 ? 'rec-exp' : ''}">${daysText(r.daysLeft)}</span>
              </div>
            </div>
            <div class="rec-acts">
              <button class="btn soft sm" data-restore="${r.id}">还原</button>
              <button class="icon-btn sm rec-del" data-purge="${r.id}" title="彻底删除">${icon('trash', 14)}</button>
            </div>
          </div>`).join('') : `<div class="empty"><div class="em">${icon('trash', 34)}</div>这个分类下没有内容</div>`}
      </div>

      ${picked.size ? `<div class="rec-batch">
        <button class="btn ghost" id="bulk-restore">还原 ${picked.size} 项</button>
        <button class="btn primary rec-danger" id="bulk-purge">彻底删除</button>
      </div>` : `<div class="rec-batch"><button class="btn ghost" id="restore-all">全部还原</button></div>`}
      ` : `<div class="card rec-empty">
        <div class="rec-empty-ico">${icon('trash', 56)}</div>
        <div class="rec-empty-t">回收站是空的</div>
        <div class="rec-empty-s">删除的事项、便签、上课记录、课件、笔记……都会先放到这里，${keepDays} 天内随时可以还原。</div>
      </div>`}
    `;

    bind(list);
  }

  function bind(list) {
    const q = (s) => main.querySelector(s);

    main.querySelectorAll('[data-g]').forEach((b) => {
      b.onclick = () => { group = b.dataset.g; paint(); };
    });
    const sel = q('#sort-sel');
    if (sel) sel.onchange = (e) => { sort = e.target.value; paint(); };

    main.querySelectorAll('[data-id]').forEach((c) => {
      c.onchange = () => {
        const id = Number(c.dataset.id);
        if (c.checked) picked.add(id); else picked.delete(id);
        paint();
      };
    });

    const pa = q('#pick-all');
    if (pa) pa.onclick = () => {
      if (picked.size && picked.size === list.length) picked.clear();
      else list.forEach((x) => picked.add(x.id));
      paint();
    };

    main.querySelectorAll('[data-restore]').forEach((b) => {
      b.onclick = async (e) => {
        e.stopPropagation();
        await api.post('/recycle/restore', { ids: [Number(b.dataset.restore)] });
        toast('已还原');
        await load();
      };
    });

    main.querySelectorAll('[data-purge]').forEach((b) => {
      b.onclick = async (e) => {
        e.stopPropagation();
        const r = rows.find((x) => x.id === Number(b.dataset.purge));
        if (!r) return;
        const ok = await confirmDialog(`「${r.title || '无标题'}」将永久删除，无法恢复。`, { title: '彻底删除', danger: true, okText: '彻底删除' });
        if (!ok) return;
        const res = await api.post('/recycle/purge', { ids: [r.id] });
        armUndo(res.undo, '已彻底删除');
        toast(`已彻底删除 ${res.purged ?? 1} 项`);
        await load();
      };
    });

    const ra = q('#restore-all');
    if (ra) ra.onclick = async () => {
      const ok = await confirmDialog(`把回收站里 ${rows.length} 项全部还原？`, { title: '全部还原', okText: '全部还原' });
      if (!ok) return;
      const r = await api.post('/recycle/restore', { all: true });
      toast(`已还原 ${r.restored} 项`);
      await load();
    };

    const br = q('#bulk-restore');
    if (br) br.onclick = async () => {
      const r = await api.post('/recycle/restore', { ids: [...picked] });
      toast(`已还原 ${r.restored} 项`);
      picked.clear();
      await load();
    };

    const bp = q('#bulk-purge');
    if (bp) bp.onclick = async () => {
      const ok = await confirmDialog(`彻底删除选中的 ${picked.size} 项？永久删除，无法恢复。`, { title: '彻底删除', danger: true, okText: '彻底删除' });
      if (!ok) return;
      const res = await api.post('/recycle/purge', { ids: [...picked] });
      picked.clear();
      armUndo(res.undo, '已彻底删除');
      toast(`已彻底删除 ${res.purged ?? 0} 项`);
      await load();
    };

    const em = q('#empty');
    if (em) em.onclick = async () => {
      /* 二次确认里把清单摆出来，跟 Win11 一样「你确定要永久删除这 N 项吗」 */
      const sample = rows.slice(0, 6).map((x) => `<div class="rec-cfm-row"><span>${esc(x.title || '无标题')}</span><em>${esc(LABEL[x.entity] || x.entity)}</em></div>`).join('');
      const more = rows.length > 6 ? `<div class="rec-cfm-more">…还有 ${rows.length - 6} 项</div>` : '';
      const ok = await confirmDialog(
        `<div class="rec-cfm">${sample}${more}</div><div class="rec-cfm-tip">共 ${rows.length} 项，永久删除后无法恢复。</div>`,
        { title: '清空回收站', danger: true, okText: '永久删除' },
      );
      if (!ok) return;
      const r = await api.post('/recycle/purge', { all: true });
      armUndo(r.undo, '已清空');
      picked.clear();
      toast(`已清空 ${r.purged} 项`);
      await load();
    };

    const ub = q('#undo-btn');
    if (ub) ub.onclick = async () => {
      if (!undoBox) return;
      const r = await api.post('/recycle/undo', { items: undoBox.items });
      toast(`已恢复 ${r.restored} 项`);
      undoBox = null;
      clearTimeout(undoTimer);
      await load();
    };
  }

  /* 离开页面时清掉撤销定时器，免得在别的页面上偷偷重绘 */
  onViewLeave(() => { clearTimeout(undoTimer); undoTimer = null; });

  await load();
});
