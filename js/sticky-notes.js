import { api, el, esc, toast, sheet, saving, confirmDialog } from './core.js';
import { icon, onViewLeave, refreshUnread } from './ui.js';
import { NOTE_STATES, noteStatus, searchNotes, quickNote } from './sticky-notes-domain.mjs';

export async function renderStickyNotes(root) {
  let rows = [], query = '', mobileState = 'todo';
  let creating = false, clearing = false, draggedId = '';
  const busy = new Set();
  const colors = [['blue', '蓝色'], ['amber', '橙色'], ['green', '绿色'], ['purple', '紫色']];
  root.innerHTML = `<section class="sticky-page">
    <header class="sticky-header">
      <div class="sticky-heading"><span class="sticky-heading-icon">${icon('file', 23)}</span><div><h1>便签</h1><p>生活里的小事，想到就记下来。</p></div></div>
      <form class="sticky-search" id="sticky-search" role="search">
        <label class="sr-only" for="sticky-query">搜索全部便签</label>
        ${icon('search', 17)}<input id="sticky-query" placeholder="搜索所有便签的内容或标签…" autocomplete="off" type="search">
        <button type="submit">搜索</button>
      </form>
      <div class="sticky-header-actions"><button id="sticky-reset" type="button">${icon('undo', 14)} 重置</button><span class="sticky-save-state" role="status">已就绪</span></div>
    </header>
    <form class="sticky-compose">
      <label class="sr-only" for="sticky-input">记录生活中的事情</label>
      <textarea id="sticky-input" rows="3" placeholder="想到什么，先记下来…（支持多行记录）"></textarea>
      <div class="sticky-compose-footer">
        <div class="sticky-compose-options">
          <label class="sr-only" for="sticky-default-status">新便签状态</label>
          <select id="sticky-default-status">${NOTE_STATES.map(state => `<option value="${state.value}">${state.value === 'todo' ? '默认: ' : ''}${state.label}</option>`).join('')}</select>
          <fieldset class="sticky-colors"><legend class="sr-only">便签颜色</legend>
            ${colors.map(([value, label]) => `<label class="sticky-color" data-color="${value}" title="${label}"><input type="radio" name="color" value="${value}" ${value === 'blue' ? 'checked' : ''}><span aria-hidden="true"></span><span class="sr-only">${label}</span></label>`).join('')}
          </fieldset>
        </div>
        <div class="sticky-compose-submit">
          <span class="sticky-shortcut">按 <kbd>Ctrl</kbd> + <kbd>Enter</kbd> 快速提交</span>
          <button id="sticky-create" type="submit" disabled>${icon('plus', 16)} 记下来</button>
        </div>
      </div>
    </form>
    <div class="sticky-board-meta"><div class="sticky-result" aria-live="polite"></div><span class="sticky-drag-hint">可将便签卡片直接拖拽至不同状态栏</span></div>
    <div class="sticky-mobile-tabs" role="tablist" aria-label="便签状态"></div>
    <div class="sticky-board"></div>
  </section>`;
  const page = root.querySelector('.sticky-page');
  const board = page.querySelector('.sticky-board');
  const input = page.querySelector('#sticky-input');
  const create = page.querySelector('#sticky-create');
  const search = page.querySelector('#sticky-query');
  const status = page.querySelector('.sticky-save-state');
  const setStatus = (text, type = '') => { status.textContent = text; status.dataset.state = type; };
  const syncStatus = event => {
    const states = { saving: ['同步中', 'saving'], saved: ['已保存', ''], error: ['待同步', 'error'], conflict: ['同步暂停', 'error'] };
    const next = states[event.detail?.status];
    if (next) setStatus(...next);
  };
  window.addEventListener('wb:sync-status', syncStatus);
  onViewLeave(() => window.removeEventListener('wb:sync-status', syncStatus));

  function highlight(value) {
    const text = String(value || '');
    if (!query) return esc(text);
    const lower = text.toLocaleLowerCase(), keyword = query.toLocaleLowerCase();
    let cursor = 0, html = '', index;
    while ((index = lower.indexOf(keyword, cursor)) !== -1) {
      html += esc(text.slice(cursor, index)) + '<mark>' + esc(text.slice(index, index + query.length)) + '</mark>';
      cursor = index + query.length;
    }
    return html + esc(text.slice(cursor));
  }
  function timestamp(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
  }
  function paint() {
    const found = searchNotes(rows, query);
    page.querySelector('.sticky-result').textContent = query ? `找到 ${found.length} 条相关便签` : `共 ${rows.length} 条便签`;
    const groups = Object.fromEntries(NOTE_STATES.map(state => [state.value, []]));
    for (const note of found) groups[noteStatus(note)].push(note);
    page.querySelector('.sticky-mobile-tabs').innerHTML = NOTE_STATES.map(state => `<button type="button" role="tab" aria-selected="${mobileState === state.value}" data-note-tab="${state.value}">${state.label}<span>${groups[state.value].length}</span></button>`).join('');
    board.innerHTML = NOTE_STATES.map(({ value, label }) => {
      const notes = groups[value];
      const done = value === 'done';
      const emptyIcon = value === 'todo' ? 'edit' : done ? 'check' : 'right';
      const emptyText = value === 'todo' ? '想到什么，在上方记下来' : done ? '完成的小事，会收在这里' : '开始处理后，将便签移到这里';
      return `<section class="sticky-column ${value}" data-note-column="${value}" data-mobile-active="${mobileState === value}" aria-label="${label}">
        <header class="sticky-column-head"><h2><i></i>${label}<span>${notes.length}</span></h2>
          ${done && notes.length ? `<button type="button" class="sticky-clear" data-note-clear aria-label="清理当前显示的已完成便签" title="清理当前显示的已完成便签" ${clearing ? 'disabled' : ''}>${icon('trash', 15)}</button>` : ''}
        </header>
        <div class="sticky-cards">${notes.length ? notes.map(note => {
          const id = esc(note.id);
          const color = colors.find(([choice]) => choice === note.color)?.[0] || '';
          const pending = busy.has(String(note.id));
          return `<article class="sticky-card ${value}" data-note-id="${id}" data-color="${color}" draggable="${!pending}">
            <div class="sticky-card-head">${done ? `<span class="sticky-done-icon" aria-hidden="true">${icon('check', 11)}</span>` : ''}<h3>${highlight(note.title)}</h3>
              <details class="sticky-menu"><summary aria-label="更多操作">${icon('more', 17)}</summary><div><button type="button" data-note-edit="${id}" ${pending ? 'disabled' : ''}>编辑</button><button type="button" data-note-delete="${id}" ${pending ? 'disabled' : ''}>删除</button></div></details>
            </div>
            ${note.content ? `<p class="sticky-card-content">${highlight(note.content)}</p>` : ''}
            <div class="sticky-card-footer">
              <time datetime="${esc(note.created_at || '')}">${icon('clock', 13)}${esc(timestamp(note.created_at))}</time>
              <label class="sr-only" for="sticky-state-${id}">${esc(note.title)}的状态</label>
              <select id="sticky-state-${id}" data-note-state="${id}" ${pending ? 'disabled' : ''}>${NOTE_STATES.map(option => `<option value="${option.value}" ${value === option.value ? 'selected' : ''}>${option.label}</option>`).join('')}</select>
            </div>
          </article>`;
        }).join('') : `<p class="sticky-empty">${icon(emptyIcon, 24)}<span>${query ? '没有匹配的便签' : emptyText}</span></p>`}</div>
      </section>`;
    }).join('');
    board.querySelector('[data-note-clear]')?.addEventListener('click', () => clearCompleted(groups.done));
    page.querySelectorAll('[data-note-tab]').forEach(button => { button.onclick = () => { mobileState = button.dataset.noteTab; paint(); }; });
    board.querySelectorAll('[data-note-state]').forEach(select => { select.onchange = () => changeState(select.dataset.noteState, select.value); });
    board.querySelectorAll('[data-note-edit]').forEach(button => { button.onclick = () => editNote(rows.find(note => String(note.id) === button.dataset.noteEdit)); });
    board.querySelectorAll('[data-note-delete]').forEach(button => { button.onclick = () => deleteNote(button.dataset.noteDelete); });
  }
  async function load() {
    const data = await api.get('/todos');
    if (!page.isConnected) return;
    rows = Array.isArray(data) ? data : [];
    paint();
    await refreshUnread();
  }
  async function changeState(id, value) {
    const note = rows.find(item => String(item.id) === id);
    if (!note || busy.has(id) || noteStatus(note) === value) return;
    busy.add(id); paint();
    try {
      await api.patch('/todos/' + id, { status: value });
      setStatus('已保存');
      await load();
    } catch (error) { toast(error.message || '状态保存失败', 'err'); }
    finally { busy.delete(id); if (page.isConnected) paint(); }
  }
  async function clearCompleted(notes) {
    if (clearing) return;
    const ids = notes.map(note => String(note.id)).filter(id => !busy.has(id));
    if (!ids.length) return;
    clearing = true;
    ids.forEach(id => busy.add(id));
    paint();
    try {
      const confirmed = await confirmDialog(`将这 ${ids.length} 条已完成便签移到回收站？`, { title: '清理已完成便签', danger: true });
      if (!confirmed || !page.isConnected) return;
      for (const id of ids) {
        await api.del('/todos/' + id);
        rows = rows.filter(note => String(note.id) !== id);
      }
      setStatus('已保存');
    } catch (error) {
      toast(error.message || '部分便签清理失败', 'err');
    } finally {
      ids.forEach(id => busy.delete(id));
      clearing = false;
      if (page.isConnected) {
        paint();
        await refreshUnread();
      }
    }
  }
  async function deleteNote(id) {
    if (busy.has(id)) return;
    if (!(await confirmDialog('删除这条便签？删除后可在回收站找回。', { title: '删除便签', danger: true }))) return;
    if (!page.isConnected || busy.has(id)) return;
    try { await api.del('/todos/' + id); setStatus('已保存'); await load(); }
    catch (error) { toast(error.message || '删除失败', 'err'); }
  }
  function editNote(note) {
    if (!note) return;
    const body = el(`<form class="sticky-editor"><label for="sticky-edit-title">便签内容</label><textarea id="sticky-edit-title" class="input" rows="2" required>${esc(note.title)}</textarea><label for="sticky-edit-content">补充说明</label><textarea id="sticky-edit-content" class="input" rows="4">${esc(note.content || '')}</textarea><label for="sticky-edit-status">状态</label><select id="sticky-edit-status" class="input">${NOTE_STATES.map(state => `<option value="${state.value}" ${noteStatus(note) === state.value ? 'selected' : ''}>${state.label}</option>`).join('')}</select><div class="sticky-editor-actions"><button class="btn ghost" type="button" data-cancel>取消</button><button class="btn primary" type="button" data-save>保存修改</button></div></form>`);
    const dialog = sheet({ title: '编辑便签', body });
    body.onsubmit = event => { event.preventDefault(); body.querySelector('[data-save]').click(); };
    body.querySelector('[data-cancel]').onclick = dialog.close;
    saving(body.querySelector('[data-save]'), async () => {
      const payload = { title: body.querySelector('#sticky-edit-title').value.trim(), content: body.querySelector('#sticky-edit-content').value, status: body.querySelector('#sticky-edit-status').value };
      if (!payload.title) throw new Error('请填写便签内容');
      const changed = Object.fromEntries(Object.entries(payload).filter(([key, value]) => value !== (key === 'status' ? noteStatus(note) : note[key] || '')));
      if (Object.keys(changed).length) await api.patch('/todos/' + note.id, changed);
      dialog.close(); setStatus('已保存'); await load();
    });
  }
  page.querySelector('.sticky-search').onsubmit = event => { event.preventDefault(); query = search.value.trim(); paint(); };
  page.querySelector('#sticky-reset').onclick = () => { search.value = ''; query = ''; paint(); search.focus(); };
  function clearDrag() {
    draggedId = '';
    board.querySelector('.sticky-dragging')?.classList.remove('sticky-dragging');
    board.querySelector('.sticky-drop-target')?.classList.remove('sticky-drop-target');
  }
  board.ondragstart = event => {
    const card = event.target.closest('[data-note-id]');
    if (!card || card.draggable === false) return;
    draggedId = card.dataset.noteId;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', draggedId);
    card.classList.add('sticky-dragging');
  };
  board.ondragover = event => {
    if (!draggedId) return;
    const column = event.target.closest('[data-note-column]');
    const note = rows.find(item => String(item.id) === draggedId);
    const target = column && note && column.dataset.noteColumn !== noteStatus(note) ? column : null;
    const previous = board.querySelector('.sticky-drop-target');
    if (previous !== target) {
      previous?.classList.remove('sticky-drop-target');
      target?.classList.add('sticky-drop-target');
    }
    if (!target) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  };
  board.ondragleave = event => {
    const column = event.target.closest('.sticky-drop-target');
    if (column && !column.contains(event.relatedTarget)) column.classList.remove('sticky-drop-target');
  };
  board.ondrop = event => {
    const column = event.target.closest('[data-note-column]');
    if (!column || !draggedId) return;
    event.preventDefault();
    const id = draggedId;
    clearDrag();
    changeState(id, column.dataset.noteColumn);
  };
  board.ondragend = clearDrag;

  const updateCreate = () => { create.disabled = creating || !input.value.trim(); };
  input.oninput = updateCreate;
  const addNote = async () => {
    if (create.disabled) return;
    const draft = input.value;
    const selectedStatus = page.querySelector('#sticky-default-status').value;
    const color = page.querySelector('input[name="color"]:checked').value;
    const payload = { ...quickNote(draft), status: selectedStatus, color };
    if (!payload.title) return;
    creating = true;
    updateCreate();
    try {
      await api.post('/todos', payload);
      if (input.value === draft) input.value = '';
      mobileState = selectedStatus;
      setStatus('已保存');
      await load(); toast(query ? '已记下来，可重置搜索查看全部便签' : '已记下来'); input.focus();
    } catch (error) { toast(error.message || '保存失败，请重试', 'err'); }
    finally { creating = false; updateCreate(); }
  };
  page.querySelector('.sticky-compose').onsubmit = event => { event.preventDefault(); addNote(); };
  input.onkeydown = event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) { event.preventDefault(); addNote(); } };
  try { await load(); }
  catch (error) {
    board.innerHTML = `<div class="sticky-load-error" role="alert">${esc(error.message || '便签加载失败')}<button class="btn ghost" type="button">重试</button></div>`;
    board.querySelector('button').onclick = async () => { try { await load(); } catch (failure) { toast(failure.message || '加载失败', 'err'); } };
  }
}

