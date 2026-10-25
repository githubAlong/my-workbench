import { api, el, esc, toast, sheet, saving, confirmDialog, promptDialog, ymd, pad2, WD_SHORT, fmtTime, parseDT, download, exportUrl } from './core.js';
import { registerView, state, icon, go, pageHead, tabsBar, bindTabs, DAILY_TABS } from './ui.js';

const STATUS = [['todo', '未开始'], ['doing', '进行中'], ['done', '已完成']];
const ST_LABEL = { todo: '未开始', doing: '进行中', done: '已完成' };

registerView(async function daily(main, { tab }) {
  const isNotes = tab !== 'homework';
  main.innerHTML = pageHead('日常', '随手记、跟作业，像手机便签一样轻',
    isNotes ? `<button class="btn primary sm" id="new-note">${icon('plus', 15)} 新建</button>` : '')
    + tabsBar(DAILY_TABS, 'daily', tab) + '<div id="daily-body"></div>';
  bindTabs(main);
  const body = main.querySelector('#daily-body');
  const nn = main.querySelector('#new-note');
  if (!isNotes) return renderHomework(body);
  // 新建走便签自己的编辑弹窗，交给 renderSticky 内部暴露的回调
  return renderSticky(body, { onNew: (fn) => { if (nn) nn.onclick = fn; } });
});

/* ================= 便签（手机便签流） ================= */
const ST_META = {
  todo: { label: '未开始', chip: 'blue', bar: 'var(--primary)' },
  doing: { label: '进行中', chip: 'amber', bar: 'var(--amber)' },
  done: { label: '已完成', chip: 'green', bar: 'var(--green)' },
};

async function renderSticky(box, opts = {}) {
  let filter = 'all';
  let q = '';
  let showDone = false;          // 已完成默认折叠
  let rows = [];
  // 刚勾完的卡片先留在原位，给 6 秒反悔窗口。
  // 不做这个的话，用户点错一下就"卡片蒸发了"，只能翻折叠区找回来。
  const freshDone = new Map();   // id -> 过期时间戳
  const FRESH_MS = 6000;

  // 分组：今天 / 昨天 / 更早
  const groupOf = (iso) => {
    if (!iso) return '更早';
    const d = new Date(iso);
    const today = new Date();
    const t0 = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
    const d0 = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const diff = Math.round((t0 - d0) / 86400000);
    if (diff <= 0) return '今天';
    if (diff === 1) return '昨天';
    if (diff <= 7) return '最近一周';
    return '更早';
  };
  const hhmm = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  };
  const relLabel = (iso) => {
    const g = groupOf(iso);
    if (g === '今天' || g === '昨天') return `${g} ${hhmm(iso)}`;
    const d = new Date(iso);
    return `${d.getMonth() + 1}月${d.getDate()}日 ${hhmm(iso)}`;
  };

  const shell = () => {
    const c = { all: rows.length, todo: 0, doing: 0, done: 0 };
    rows.forEach((r) => { c[r.status] = (c[r.status] || 0) + 1; });
    box.innerHTML = `
      <div class="note-toolbar">
        <div class="seg note-seg">
          <button class="${filter === 'all' ? 'on' : ''}" data-f="all">全部 ${c.all}</button>
          <button class="${filter === 'todo' ? 'on' : ''}" data-f="todo">未开始 ${c.todo}</button>
          <button class="${filter === 'doing' ? 'on' : ''}" data-f="doing">进行中 ${c.doing}</button>
        </div>
        <button class="note-search-btn ${q ? 'on' : ''}" id="nt-search" title="搜索便签">${icon('search', 16)}</button>
      </div>
      <div class="note-search ${q ? 'open' : ''}" id="nt-searchbar">
        <span class="ns-ico">${icon('search', 15)}</span>
        <input id="nt-q" value="${esc(q)}" placeholder="搜便签内容…" autocomplete="off">
        <button class="ns-clear" id="nt-qc" ${q ? '' : 'hidden'}>${icon('close', 14)}</button>
      </div>
      <div id="nt-list"></div>
      <div class="note-quick">
        <div class="qi-row">
          <span class="qi-ico">${icon('edit', 15)}</span>
          <input id="nt-input" placeholder="想到什么先记一笔，回车保存…" autocomplete="off">
          <button class="btn primary sm" id="nt-save">保存</button>
        </div>
      </div>`;
    bind();
  };

  const paint = () => {
    const list = box.querySelector('#nt-list');
    if (!list) return;
    let shown = rows.filter((r) => (filter === 'all' || r.status === filter)
      && (!q || r.title.includes(q) || (r.content || '').includes(q)));
    // 未筛选「已完成」时，把已完成的收进折叠区，不占主视线
    let hiddenDone = 0;
    if (filter !== 'done') {
      const now = Date.now();
      const isFresh = (r) => (freshDone.get(r.id) || 0) > now;
      const doneRows = shown.filter((r) => r.status === 'done');
      if (!showDone) {
        const settled = doneRows.filter((r) => !isFresh(r));
        hiddenDone = settled.length;
        // 刚完成的先留在原位，过期后才收进折叠区
        shown = shown.filter((r) => r.status !== 'done' || isFresh(r));
      } else if (!q) {
        // 折叠区展开：已完成的排到最后
        shown = [...shown.filter((r) => r.status !== 'done'), ...doneRows];
      }
    }
    const order = { 今天: 0, 昨天: 1, 最近一周: 2, 更早: 3 };
    shown.sort((a, b) => {
      const ga = order[groupOf(a.created_at)] ?? 9;
      const gb = order[groupOf(b.created_at)] ?? 9;
      if (ga !== gb) return ga - gb;
      if (a.pin !== b.pin) return (b.pin || 0) - (a.pin || 0);
      return String(b.created_at).localeCompare(String(a.created_at));
    });

    if (!shown.length && !hiddenDone) {
      list.innerHTML = `<div class="empty" style="padding:34px 16px">${rows.length
        ? '没有符合条件的便签'
        : '还没有便签<br><span class="tiny">在上面那行记一笔，或者去首页的快速便签写'}</div>`;
      return;
    }

    let html = '';
    let curG = '';
    for (const n of shown) {
      const g = groupOf(n.created_at);
      if (g !== curG) {
        curG = g;
        html += `<div class="note-group"><span>${g}</span><i></i></div>`;
      }
      const m = ST_META[n.status] || ST_META.todo;
      const fresh = n.status === 'done' && (freshDone.get(n.id) || 0) > Date.now();
      html += `<div class="note-item ${n.status} ${n.pin ? 'pinned' : ''} ${fresh ? 'fresh' : ''}" data-id="${n.id}">
        <span class="ni-bar" style="background:${m.bar}"></span>
        <div class="ni-body">
          <div class="ni-title ${n.status === 'done' ? 'done' : ''}">${esc(n.title)}</div>
          ${n.content ? `<div class="ni-sub">${esc(n.content)}</div>` : ''}
          <div class="ni-foot">
            <button class="ni-st chip ${m.chip}" data-st="${n.id}" title="点一下切换状态">${m.label}</button>
            ${fresh ? `<button class="ni-undo" data-undo="${n.id}">撤销</button>` : ''}
            ${n.pin ? `<span class="ni-pin">${icon('pin', 12)}</span>` : ''}
            <span class="ni-time">${relLabel(n.created_at)}</span>
            ${n.source === '便签' ? '<span class="ni-src">来自首页</span>' : ''}
          </div>
        </div>
        <div class="ni-acts">
          <button class="ni-check ${n.status === 'done' ? 'on' : ''}" data-done="${n.id}" title="标记完成">${n.status === 'done' ? icon('check', 13) : ''}</button>
          <button class="ni-more" data-more="${n.id}" title="更多">${icon('more', 16)}</button>
        </div>
      </div>`;
    }
    if (hiddenDone) {
      html += `<button class="note-fold" id="nt-fold">${icon('down', 14)} 已完成 ${hiddenDone} 条，点开查看</button>`;
    }
    list.innerHTML = html;
    bindList();
  };

  const bindList = () => {
    const list = box.querySelector('#nt-list');
    // 点状态标签：三态循环
    list.querySelectorAll('[data-st]').forEach((b) => {
      b.onclick = async (e) => {
        e.stopPropagation();
        const id = Number(b.dataset.st);
        const n = rows.find((x) => x.id === id);
        if (!n) return;
        const order = ['todo', 'doing', 'done'];
        const next = order[(order.indexOf(n.status) + 1) % 3];
        n.status = next;                   // 先本地改，界面立刻响应
        const m = ST_META[next];
        b.className = `ni-st chip ${m.chip}`;
        b.textContent = m.label;
        b.closest('.note-item').className = `note-item ${next} ${n.pin ? 'pinned' : ''}`;
        b.closest('.note-item').querySelector('.ni-bar').style.background = m.bar;
        const ck = b.closest('.note-item').querySelector('.ni-check');
        ck.classList.toggle('on', next === 'done');
        ck.innerHTML = next === 'done' ? icon('check', 13) : '';
        b.closest('.note-item').querySelector('.ni-title').classList.toggle('done', next === 'done');
        toast('状态改成「' + m.label + '」');
        if (next === 'done') {
          freshDone.set(id, Date.now() + FRESH_MS);
          // 先重绘一次让「撤销」按钮挂上去，到期再重绘收进折叠区
          paint();
          setTimeout(() => paint(), FRESH_MS + 60);
        }
        try { await api.patch('/todos/' + id, { status: next }); } catch (err) { toast(err.message || '状态没存上', 'err'); load(); }
      };
    });
    // 圆圈：一键完成 / 取消完成
    list.querySelectorAll('[data-done]').forEach((b) => {
      b.onclick = async (e) => {
        e.stopPropagation();
        const id = Number(b.dataset.done);
        const n = rows.find((x) => x.id === id);
        if (!n) return;
        const next = n.status === 'done' ? 'todo' : 'done';
        n.status = next;
        const card = b.closest('.note-item');
        card.className = `note-item ${next} ${n.pin ? 'pinned' : ''}`;
        const m = ST_META[next];
        card.querySelector('.ni-bar').style.background = m.bar;
        const stBtn = card.querySelector('[data-st]');
        stBtn.className = `ni-st chip ${m.chip}`; stBtn.textContent = m.label;
        b.classList.toggle('on', next === 'done');
        b.innerHTML = next === 'done' ? icon('check', 13) : '';
        card.querySelector('.ni-title').classList.toggle('done', next === 'done');
        if (next === 'done') {
          toast('已完成');
          freshDone.set(id, Date.now() + FRESH_MS);
          // 先重绘一次让「撤销」按钮挂上去，到期再重绘收进折叠区
          paint();
          setTimeout(() => paint(), FRESH_MS + 60);
        }
        try { await api.patch('/todos/' + id, { status: next }); } catch (err) { toast(err.message || '没存上', 'err'); load(); }
      };
    });
    // ⋯ 操作条
    list.querySelectorAll('[data-more]').forEach((b) => {
      b.onclick = (e) => { e.stopPropagation(); const n = rows.find((x) => x.id === Number(b.dataset.more)); if (n) actionSheet(n); };
    });
    // 点正文：就地编辑
    list.querySelectorAll('.ni-body').forEach((el2) => {
      el2.onclick = () => {
        const card = el2.closest('.note-item');
        const n = rows.find((x) => x.id === Number(card.dataset.id));
        if (n) inlineEdit(card, n);
      };
    });
    // 撤销：刚标记完成，点错了立刻退回去
    list.querySelectorAll('[data-undo]').forEach((b) => {
      b.onclick = async (e) => {
        e.stopPropagation();
        const id = Number(b.dataset.undo);
        const n = rows.find((x) => x.id === id);
        if (!n) return;
        freshDone.delete(id);
        n.status = 'todo';
        try { await api.patch('/todos/' + id, { status: 'todo' }); toast('已撤回到未开始'); }
        catch (err) { toast(err.message || '没存上', 'err'); }
        load();
      };
    });
    const fold = box.querySelector('#nt-fold');
    if (fold) fold.onclick = () => { showDone = true; paint(); };
  };

  /* 就地编辑：正文变成输入框，失焦或回车保存，Esc 放弃 */
  const inlineEdit = (card, n) => {
    if (card.querySelector('.ni-edit')) return;
    const body = card.querySelector('.ni-body');
    const oldTitle = n.title;
    body.innerHTML = `<textarea class="ni-edit" rows="2">${esc(n.title)}</textarea>
      <div class="ni-foot tiny muted" style="margin-top:4px">回车或点别处保存 · Esc 取消</div>`;
    const ta = body.querySelector('.ni-edit');
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
    let done = false;
    const commit = async () => {
      if (done) return; done = true;
      const v = ta.value.trim();
      if (!v || v === oldTitle) { paint(); return; }
      try {
        await api.patch('/todos/' + n.id, { title: v });
        n.title = v;
        toast('已改好');
        load();
      } catch (e) { toast(e.message || '没存上', 'err'); paint(); }
    };
    ta.onblur = commit;
    ta.onkeydown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { done = true; paint(); }
    };
  };

  /* ⋯ 底部操作条 */
  const actionSheet = (n) => {
    const body = el(`<div class="sheet-body note-acts">
      <div class="na-title">${esc(n.title)}</div>
      <div class="na-grid">
        <button class="na-btn" data-a="pin">${icon('pin', 18)}<span>${n.pin ? '取消置顶' : '置顶'}</span></button>
        <button class="na-btn" data-a="copy">${icon('copy', 18)}<span>复制文字</span></button>
        <button class="na-btn" data-a="edit">${icon('edit', 18)}<span>改标题/备注</span></button>
        <button class="na-btn danger" data-a="del">${icon('trash', 18)}<span>删除</span></button>
      </div>
      <div class="na-st">改状态：${['todo', 'doing', 'done'].map((k) => `<button class="chip-btn ${n.status === k ? 'on' : ''}" data-set="${k}">${ST_META[k].label}</button>`).join('')}</div>
    </div>`);
    const s = sheet({ title: '便签操作', body });
    body.querySelector('[data-a="pin"]').onclick = async () => { await api.patch('/todos/' + n.id, { pin: n.pin ? 0 : 1 }); s.close(); load(); };
    body.querySelector('[data-a="copy"]').onclick = async () => {
      try { await navigator.clipboard.writeText(n.title); toast('已复制'); } catch { toast('复制失败，请长按选中', 'warn'); }
      s.close();
    };
    body.querySelector('[data-a="edit"]').onclick = () => { s.close(); setTimeout(() => editor(n), 180); };
    body.querySelector('[data-a="del"]').onclick = async () => {
      if (!(await confirmDialog('删除这条便签？'))) return;
      await api.del('/todos/' + n.id); s.close(); toast('已删除'); load();
    };
    body.querySelectorAll('[data-set]').forEach((b) => {
      b.onclick = async () => { await api.patch('/todos/' + n.id, { status: b.dataset.set }); s.close(); load(); };
    });
  };

  const bind = () => {
    box.querySelectorAll('[data-f]').forEach((b) => { b.onclick = () => { filter = b.dataset.f; showDone = false; shell(); paint(); }; });
    const sb = box.querySelector('#nt-searchbar');
    const si = box.querySelector('#nt-q');
    const sc = box.querySelector('#nt-qc');
    box.querySelector('#nt-search').onclick = () => {
      sb.classList.toggle('open');
      box.querySelector('#nt-search').classList.toggle('on', sb.classList.contains('open'));
      if (sb.classList.contains('open')) si.focus();
    };
    let timer = null;
    si.oninput = () => {
      q = si.value.trim();
      sc.hidden = !q;
      clearTimeout(timer);
      timer = setTimeout(() => paint(), 160);
    };
    sc.onclick = () => { si.value = ''; q = ''; sc.hidden = true; paint(); si.focus(); };
    // 快速添加
    const inp = box.querySelector('#nt-input');
    const save = async () => {
      const text = inp.value.trim();
      if (!text) { inp.focus(); return toast('写点什么再保存吧', 'warn'); }
      const bt = box.querySelector('#nt-save');
      bt.disabled = true;
      try {
        // 和首页走同一个接口：便签 + 今日事项 双写，两边都能看到
        await api.post('/quick', { text });
        inp.value = '';
        toast('已记一笔');
        await load();
        box.querySelector('#nt-input')?.focus();
      } catch (e) { toast(e.message || '保存失败', 'err'); }
      finally { const b2 = box.querySelector('#nt-save'); if (b2) b2.disabled = false; }
    };
    box.querySelector('#nt-save').onclick = save;
    inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } };
  };

  const load = async () => {
    rows = await api.get('/todos').catch(() => []);
    // 老便签（直接在日常里新建的）没有 source 字段，这里标注一下来源，别和首页来的混
    rows.forEach((r) => {
      if (!r.source) r.source = '';
      // 与首页那侧的历史错位，一次性对齐（后端已保证今后同源）
      if (r.item_status && r.item_status !== r.status) r.status = r.item_status;
    });
    shell(); paint();
  };

  /* 完整编辑弹窗（新建 / ⋯→改标题备注） */
  const editor = (n) => {
    const isNew = !n;
    const body = el(`<div class="sheet-body">
      <textarea class="input" id="t" rows="3" placeholder="要做的事…">${esc(n?.title || '')}</textarea>
      <div class="remark-field" style="margin-top:10px"><label class="field-label">${icon('edit', 13)} 备注<span class="rf-hint">可不填，想到什么写什么</span></label>
        <textarea class="input" id="c" rows="3" placeholder="补充说明、待确认的点、别人交代的话…">${esc(n?.content || '')}</textarea></div>
      <div class="row wrap" style="gap:6px;margin-bottom:10px">${STATUS.map(([v, l]) => `<button class="chip-btn ${((n?.status) || 'todo') === v ? 'on' : ''}" data-s="${v}">${l}</button>`).join('')}
        <label class="row small" style="gap:5px;margin-left:8px"><input type="checkbox" id="pin" ${n?.pin ? 'checked' : ''}> 置顶</label></div>
      <div class="confirm-actions">${isNew ? '' : '<button class="btn ghost" id="d" style="margin-right:auto;color:var(--red)">删除</button>'}
        <button class="btn ghost" id="c2">取消</button><button class="btn primary" id="k">保存</button></div></div>`);
    const s = sheet({ title: isNew ? '新建便签' : '编辑便签', body });
    let st = n?.status || 'todo';
    body.querySelectorAll('[data-s]').forEach((b) => { b.onclick = () => { st = b.dataset.s; body.querySelectorAll('[data-s]').forEach((x) => x.classList.toggle('on', x === b)); }; });
    body.querySelector('#c2').onclick = s.close;
    body.querySelector('#d')?.addEventListener('click', async () => { if (await confirmDialog('删除这条便签？')) { await api.del('/todos/' + n.id); s.close(); load(); } });
    body.querySelector('#k').onclick = async () => {
      const payload = { title: body.querySelector('#t').value.trim(), content: body.querySelector('#c').value, status: st, pin: body.querySelector('#pin').checked ? 1 : 0 };
      if (!payload.title) return toast('内容不能为空', 'warn');
      if (isNew) await api.post('/todos', payload); else await api.patch('/todos/' + n.id, payload);
      s.close(); load();
    };
  };

  // 顶部「新建」按钮交给这里绑定，避免两个地方各写一份编辑弹窗
  if (opts.onNew) opts.onNew(() => editor(null));

  await load();
}

/* ================= 作业 ================= */
async function renderHomework(box) {
  const load = async () => {
    const [homework, students] = await Promise.all([api.get('/homework'), api.get('/students')]);
    box.innerHTML = `<div class="row wrap" style="gap:8px;margin-bottom:14px">
        <button class="btn primary sm" id="new-hw">${icon('plus', 15)} 布置作业</button>
        <button class="btn ghost sm" id="import-stu">${icon('upload', 15)} 一键导入学生名单</button>
        <span style="flex:1"></span>
        <span class="tiny muted">共 ${students.length} 名学生</span>
      </div>
      <div class="col" id="hw-list"></div>`;
    box.querySelector('#new-hw').onclick = () => hwEditor(null, students, load);
    box.querySelector('#import-stu').onclick = () => importStudents(load);
    const list = box.querySelector('#hw-list');
    if (!homework.length) list.innerHTML = '<div class="card empty">还没有布置作业，点「布置作业」开始</div>';
    for (const h of homework) {
      const recs = await api.get('/homework_records', { homework_id: h.id }).catch(() => null);
      const card = el(`<div class="card card-pad">
        <div class="row wrap" style="gap:8px">
          <div class="bold">${esc(h.title)}</div>
          <span class="chip blue">${esc(h.class_name || '')}</span>
          <span class="tiny muted">布置 ${esc(h.assign_date || '')} · 截止 ${esc(h.due_date || '')}</span>
          <span style="flex:1"></span>
          <button class="btn ghost sm" data-rec="1">记录完成情况</button>
          <button class="icon-btn sm" data-ed="1">${icon('edit', 15)}</button>
        </div>
        ${h.content ? `<div class="small muted" style="margin-top:4px">${esc(h.content)}</div>` : ''}
        <div class="row wrap tiny" style="gap:12px;margin-top:8px" id="hw-stat-${h.id}"></div>
      </div>`);
      card.querySelector('[data-ed]').onclick = () => hwEditor(h, students, load);
      card.querySelector('[data-rec]').onclick = () => recordSheet(h, students, load);
      list.appendChild(card);
      // 统计
      const st = await api.get(`/homework/${h.id}/records`).catch(() => []);
      const done = st.filter((r) => r.status === 'done').length;
      const miss = st.filter((r) => r.status === 'missing').length;
      const pending = st.filter((r) => r.status === 'pending' || !r.status).length;
      const box2 = card.querySelector(`#hw-stat-${h.id}`);
      box2.innerHTML = `<span class="hw-dot ok"></span><span>已完成 <b>${done}</b></span>
        <span class="hw-dot bad"></span><span style="color:var(--red)">未交 <b>${miss}</b></span>
        <span class="hw-dot wait"></span><span class="muted">未记录 <b>${pending}</b></span>
        <span class="muted">共 ${st.length || 0} 人</span>`;
    }
  };
  await load();
}

/* ================= 导入学生名单（第 26 条） =================
   用户的原话：「学生名单点导入没反应，需要支持手动添加 + Excel 导入」。

   查下来「没反应」的真因不是接口坏了，而是这个函数里
   `await api.post(...)` 外面一个 try/catch 都没有：
   接口只要报一次错（年级为空、字段超长、网络抖一下），
   异常就抛到 sheet 的 onclick 里被吞掉，界面一动不动、也没有任何提示。
   用户能看到的只有「点了没反应」——比报错还糟糕，因为不知道要不要重试。

   现在这个面板做成三个入口并列，任何一步失败都必须说话：
     ① 手动逐个添加（一行一个，回车即提交）；
     ② 粘贴名单（从 Excel 整列复制）；
     ③ 直接传 .xlsx / .csv，服务端识别表头后回预览。

   Excel 这条路走的是「先预览、再确认」：
   名单是批量的，导错了清理起来比手工录还麻烦，所以不让它一步落库。 */
function importStudents(reload) {
  const body = el(`<div class="sheet-body">
    <div class="imp-tabs">
      <button class="imp-tab on" data-m="paste">粘贴名单</button>
      <button class="imp-tab" data-m="file">Excel / CSV</button>
      <button class="imp-tab" data-m="one">手动添加</button>
    </div>

    <div class="form-grid" style="margin-top:12px">
      <div class="field"><label class="field-label">年级</label><input class="input" id="g" value="高二" placeholder="如：高二"></div>
      <div class="field"><label class="field-label">班级</label><input class="input" id="c" value="高二(3)班" placeholder="如：高二(3)班"></div>
    </div>

    <div class="imp-pane" data-p="paste">
      <div class="small muted" style="margin-bottom:6px">每行一个姓名，也可以直接从 Excel 里复制一整列粘进来。</div>
      <textarea class="input" id="names" rows="7" placeholder="张一诺&#10;李晨阳&#10;王思远"></textarea>
      <div class="tiny muted" id="paste-count" style="margin-top:6px">已填 0 个姓名</div>
      <div class="confirm-actions" style="margin-top:12px">
        <button class="btn ghost" id="x1">取消</button>
        <button class="btn primary" id="k1">导入到「<span id="k1-cls">高二(3)班</span>」</button>
      </div>
    </div>

    <div class="imp-pane hidden" data-p="file">
      <div class="small muted" style="margin-bottom:8px">
        支持 .xlsx / .csv，单文件 12MB 以内。会自己找「姓名」那一列，
        有「年级 / 班级 / 学号」列也会一起读——没有就按上面填的年级班级算。
      </div>
      <input type="file" id="imp-file" accept=".xlsx,.xlsm,.csv,.txt,.tsv" hidden>
      <button class="btn ghost block" id="imp-pick" style="justify-content:center">
        选择一个 Excel / CSV 文件
      </button>
      <div class="imp-file-hint tiny muted" id="imp-hint" style="margin-top:8px">还没选文件</div>
      <div id="imp-preview"></div>
    </div>

    <div class="imp-pane hidden" data-p="one">
      <div class="small muted" style="margin-bottom:6px">临时来个转学生，直接加一个。填完按回车或点「添加」。</div>
      <div class="row" style="gap:8px">
        <input class="input" id="one-name" placeholder="学生姓名" style="flex:1">
        <input class="input" id="one-subj" placeholder="学科（可不填）" style="flex:0 0 130px">
        <button class="btn primary sm" id="one-add" style="flex:0 0 auto">添加</button>
      </div>
      <div class="tiny muted" id="one-tip" style="margin-top:8px"></div>
      <div id="one-list" class="one-list"></div>
      <div class="confirm-actions" style="margin-top:12px">
        <button class="btn ghost" id="x2">关闭</button>
      </div>
    </div>
  </div>`);

  const s = sheet({ title: '导入学生名单', body, wide: true });
  const $ = (q) => body.querySelector(q);
  const added = [];

  /* ---- 三个页签 ---- */
  body.querySelectorAll('.imp-tab').forEach((b) => {
    b.onclick = () => {
      body.querySelectorAll('.imp-tab').forEach((x) => x.classList.toggle('on', x === b));
      body.querySelectorAll('.imp-pane').forEach((p) => p.classList.toggle('hidden', p.dataset.p !== b.dataset.m));
    };
  });

  /* 班级名同步到按钮上：用户改完班级如果按钮还写着旧班名，
     很容易以为「我改的是别的字段」。 */
  $('#c').oninput = () => { $('#k1-cls').textContent = $('#c').value || '未选班级'; };

  /* ---- ① 粘贴版：实时数一下有几个名字 ---- */
  const cnt = () => {
    const n = $('#names').value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean).length;
    $('#paste-count').textContent = `已填 ${n} 个姓名`;
    return n;
  };
  $('#names').oninput = cnt;

  const gradeOf = () => ($('#g').value || '').trim();
  const classOf = () => ($('#c').value || '').trim();

  /* 真正的写库动作，两个入口共用。
     抽出来是为了让「粘贴」和「Excel」走完全一样的校验和报错路径——
     两套代码各写一遍的话，迟早有一套漏了 try/catch，又变成「点了没反应」。 */
  const commit = async (rows, btn, label) => {
    if (!rows.length) return toast('名单是空的', 'warn');
    const g = gradeOf(); const c = classOf();
    if (!g || !c) return toast('年级和班级都要填', 'warn');
    const old = btn.innerHTML;
    btn.disabled = true; btn.innerHTML = '导入中…';
    try {
      const r = await api.post('/students/bulk', {
        rows: rows.map((x, i) => ({
          grade: x.grade || g,
          class_name: x.class_name || c,
          name: x.name,
          no: x.no || i + 1,
        })),
      });
      /* 同时建班级名册（点名用）。这一步失败不影响学生已经导进去，
         但要明确告诉用户「人和名册不是一回事」，别以为全成了。 */
      try {
        const names = rows.map((x) => x.name);
        await saveRoster(g, c, names);
      } catch {
        toast('学生已导入，但班级名册没同步成功，点名时可能看不到这批人', 'warn', 6000);
      }
      s.close();
      toast(`已导入 ${r?.ids?.length || rows.length} 名学生到「${c}」`, 'ok');
      reload();
    } catch (e) {
      btn.disabled = false; btn.innerHTML = old;
      toast(e.message || `${label}失败，请重试`, 'err', 5000);
    }
  };

  $('#x1').onclick = s.close;
  $('#k1').onclick = (e) => {
    const lines = $('#names').value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    commit(lines.map((name, i) => ({ name, no: i + 1 })), e.currentTarget, '导入');
  };

  /* ---- ② Excel / CSV ---- */
  const fileEl = $('#imp-file');
  $('#imp-pick').onclick = () => fileEl.click();
  fileEl.onchange = async () => {
    const f = fileEl.files?.[0];
    if (!f) return;
    $('#imp-hint').textContent = `正在读取 ${f.name}…`;
    $('#imp-preview').innerHTML = '';
    const fd = new FormData();
    fd.append('files', f, f.name);
    try {
      const r = await api.post('/students/detect', fd);
      if (!r?.ok) throw new Error(r?.reason || '没识别出名单');
      const clsHint = r.classes.length === 1 ? r.classes[0] : classOf();
      if (r.classes.length === 1) $('#c').value = r.classes[0];
      if (r.grades.length === 1) $('#g').value = r.grades[0];
      $('#k1-cls').textContent = $('#c').value || '——';
      $('#imp-hint').innerHTML = `读到 <b>${r.total}</b> 人${r.dup ? `，其中 <b>${r.dup}</b> 人已在名单里（会自动跳过）` : ''}`
        + `${r.hasHeader ? '' : '（这个文件没有表头，已把第一列当姓名）'}`;
      $('#imp-preview').innerHTML = `
        <div class="imp-prev">
          <div class="imp-prev-h">预览（前 ${Math.min(r.rows.length, 8)} 人）</div>
          <div class="imp-prev-list">${r.rows.slice(0, 8).map((x, i) => `<span class="chip">${i + 1}. ${esc(x.name)}${x.class_name ? `<i class="muted"> · ${esc(x.class_name)}</i>` : ''}</span>`).join('')}</div>
          ${r.total > 8 ? `<div class="tiny muted" style="margin-top:6px">…还有 ${r.total - 8} 人</div>` : ''}
          <div class="confirm-actions" style="margin-top:12px">
            <button class="btn ghost" id="imp-cancel">重选文件</button>
            <button class="btn primary" id="imp-ok">导入这 ${r.total} 人到「${esc(clsHint || '未选班级')}」</button>
          </div>
        </div>`;
      $('#imp-cancel').onclick = () => { $('#imp-preview').innerHTML = ''; $('#imp-hint').textContent = '还没选文件'; fileEl.value = ''; };
      $('#imp-ok').onclick = (e2) => commit(r.rows, e2.currentTarget, '导入');
    } catch (e) {
      $('#imp-hint').textContent = '';
      $('#imp-preview').innerHTML = `<div class="imp-err">${esc(e.message || '文件读取失败')}</div>`;
    }
  };

  /* ---- ③ 手动添加 ---- */
  $('#x2').onclick = () => { if (added.length) reload(); s.close(); };
  const paintAdded = () => {
    $('#one-tip').textContent = added.length ? `本次已添加 ${added.length} 人` : '还没添加';
    $('#one-list').innerHTML = added.map((n, i) => `<span class="chip">${i + 1}. ${esc(n)}</span>`).join('');
  };
  const addOne = async () => {
    const name = $('#one-name').value.trim();
    if (!name) return toast('先填姓名', 'warn');
    const g = gradeOf(); const c = classOf();
    if (!g || !c) return toast('年级和班级都要填', 'warn');
    const btn = $('#one-add');
    btn.disabled = true; btn.textContent = '添加中…';
    try {
      await api.post('/students', { grade: g, class_name: c, name, subject: $('#one-subj').value.trim(), no: added.length + 1 });
      added.push(name);
      $('#one-name').value = ''; $('#one-subj').value = '';
      $('#one-name').focus();
      paintAdded();
      /* 每加一个人就同步一次名册。人数不多，这里不必攒批——
         攒批的话中途关掉面板，名册和学生对不上。 */
      saveRoster(g, c, added).catch(() => {});
    } catch (e) {
      toast(e.message || '添加失败', 'err');
    } finally {
      btn.disabled = false; btn.textContent = '添加';
    }
  };
  $('#one-add').onclick = addOne;
  $('#one-name').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); addOne(); } };
  $('#one-subj').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); addOne(); } };
  paintAdded();
}

async function saveRoster(g, c, names) {
  const rs = await api.get('/rosters');
  const ex = rs.find((r) => r.grade === g && r.class_name === c);
  if (ex) await api.patch('/rosters/' + ex.id, { count: names.length, names });
  else await api.post('/rosters', { grade: g, class_name: c, count: names.length, names });
}

function hwEditor(h, students, reload) {
  const isNew = !h;
  const body = el(`<div class="sheet-body">
    <div class="field"><label class="field-label">作业名称</label><input class="input" id="t" value="${esc(h?.title || '')}" placeholder="如：《劝学》第三段背诵"></div>
    <div class="form-grid">
      <div class="field"><label class="field-label">班级</label><select class="input" id="c">${[...new Set(students.map((s) => s.class_name))].map((c) => `<option ${h?.class_name === c ? 'selected' : ''}>${esc(c)}</option>`).join('') || '<option>高二(3)班</option>'}</select></div>
      <div class="field"><label class="field-label">科目</label><input class="input" id="sub" value="${esc(h?.subject || '语文')}"></div>
      <div class="field"><label class="field-label">布置日期</label><input class="input" type="date" id="ad" value="${esc(h?.assign_date || ymd(new Date()))}"></div>
      <div class="field"><label class="field-label">截止日期</label><input class="input" type="date" id="dd" value="${esc(h?.due_date || '')}"></div>
    </div>
    <div class="field"><label class="field-label">作业内容</label><textarea class="input" id="body" rows="3">${esc(h?.content || '')}</textarea></div>
    <div class="field-hint">保存后可直接「记录完成情况」，逐个学生打勾，也可以一键全部标记完成。</div>
    <div class="confirm-actions"><button class="btn ghost" id="x">取消</button><button class="btn primary" id="k">保存</button></div></div>`);
  const s = sheet({ title: isNew ? '布置作业' : '编辑作业', body, wide: true });
  body.querySelector('#x').onclick = s.close;
  body.querySelector('#k').onclick = async () => {
    const payload = { title: body.querySelector('#t').value.trim(), class_name: body.querySelector('#c').value, subject: body.querySelector('#sub').value,
      assign_date: body.querySelector('#ad').value, due_date: body.querySelector('#dd').value, content: body.querySelector('#body').value };
    if (!payload.title) return toast('请填写作业名称', 'warn');
    const r = isNew ? await api.post('/homework', payload) : await api.patch('/homework/' + h.id, payload);
    s.close(); toast('已保存'); reload();
    if (isNew) setTimeout(() => recordSheet(r, students, reload), 260);
  };
}

async function recordSheet(h, students, reload) {
  const cls = students.filter((s) => !h.class_name || s.class_name === h.class_name);
  if (!cls.length) return toast('这个班还没有学生，请先导入名单', 'warn');
  const recs = await api.get(`/homework/${h.id}/records`).catch(() => []);
  const map = new Map(recs.map((r) => [r.student_name, r]));
  const body = el(`<div style="padding:0 16px 12px">
    <div class="row wrap" style="gap:8px;margin-bottom:10px">
      <span class="small muted">${esc(h.title)} · ${esc(h.class_name || '')}</span>
      <span style="flex:1"></span>
      <button class="btn ghost sm" id="all-done">全部已完成</button>
      <button class="btn primary sm" id="save">保存</button>
    </div>
    <div class="table-wrap" style="max-height:56vh"><table class="tbl" style="min-width:0">
      <thead><tr><th style="width:44px">#</th><th>姓名</th><th style="width:120px">状态</th><th style="width:80px">得分</th><th>备注</th></tr></thead>
      <tbody>${cls.map((s, i) => {
        const r = map.get(s.name) || {};
        return `<tr data-n="${esc(s.name)}"><td class="num">${i + 1}</td><td class="bold">${esc(s.name)}</td>
        <td><select class="cell-input st">${[['pending', '未记录'], ['done', '已完成'], ['partial', '部分完成'], ['missing', '未交'], ['late', '迟交']].map(([v, l]) => `<option value="${v}" ${(r.status || 'pending') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></td>
        <td><input class="cell-input sc" type="number" value="${r.score ?? ''}"></td>
        <td><input class="cell-input rm" value="${esc(r.remark || '')}"></td></tr>`;
      }).join('')}</tbody></table></div></div>`);
  const s = sheet({ title: '作业完成情况', body, wide: true });
  body.querySelector('#all-done').onclick = () => body.querySelectorAll('.st').forEach((sel) => { sel.value = 'done'; });
  saving(body.querySelector('#save'), async () => {
    const rows = [...body.querySelectorAll('tr[data-n]')].map((tr) => ({
      student_name: tr.dataset.n, status: tr.querySelector('.st').value,
      score: tr.querySelector('.sc').value || null, remark: tr.querySelector('.rm').value,
    }));
    await api.post(`/homework/${h.id}/records`, { rows });
    s.close(); toast('已保存作业情况'); reload();
  });
}
