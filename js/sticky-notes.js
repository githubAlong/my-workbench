import { api, el, esc, toast, sheet, saving, confirmDialog } from './core.js';
import { icon, onViewLeave, refreshUnread } from './ui.js';
import { NOTE_STATES, noteStatus, searchNotes, quickNote } from './sticky-notes-domain.mjs';

export async function renderStickyNotes(root) {
  let rows = [], query = '', mobileState = 'todo';
  const busy = new Set();
  root.innerHTML = `<section class="sticky-page">
    <header class="sticky-header"><div><h1>便签</h1><p>生活里的小事，想到就记下来。</p></div><span class="sticky-save-state" role="status">已就绪</span></header>
    <form class="sticky-search" role="search"><label for="sticky-query">搜索全部便签</label>
      <div class="sticky-search-row"><div class="sticky-search-input">${icon('search', 20)}<input id="sticky-query" placeholder="搜索所有便签的标题和正文" autocomplete="off" type="search"></div><button class="btn primary" type="submit">搜索</button><button class="btn ghost" id="sticky-reset" type="button">重置</button></div>
      <p>搜索全部状态的标题和正文，输入后点击搜索或按回车。</p>
    </form>
    <form class="sticky-compose"><label class="sr-only" for="sticky-input">记录生活中的事情</label><div class="sticky-compose-input">${icon('edit', 22)}<textarea id="sticky-input" rows="3" placeholder="想到什么，先记下来…&#10;可记录多行内容"></textarea></div>
      <div class="sticky-compose-footer"><span>默认加入待完成</span><button class="btn primary" id="sticky-create" type="submit" disabled>记下来 <kbd>Ctrl + Enter</kbd></button></div>
    </form>
    <div class="sticky-result" aria-live="polite"></div><div class="sticky-mobile-tabs" role="tablist" aria-label="便签状态"></div><div class="sticky-board"></div>
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
    page.querySelector('.sticky-mobile-tabs').innerHTML = NOTE_STATES.map(state => `<button type="button" role="tab" aria-selected="${mobileState === state.value}" data-note-tab="${state.value}">${state.label}<span>${found.filter(note => noteStatus(note) === state.value).length}</span></button>`).join('');
    board.innerHTML = NOTE_STATES.map(state => {
      const notes = found.filter(note => noteStatus(note) === state.value);
      return `<section class="sticky-column ${state.value}" data-note-column="${state.value}" data-mobile-active="${mobileState === state.value}" aria-label="${state.label}"><h2><i></i>${state.label}<span>${notes.length}</span></h2><div class="sticky-cards">${notes.length ? notes.map(note => `<article class="sticky-card ${state.value}" data-note-id="${esc(note.id)}">
        <div class="sticky-card-head">${state.value === 'done' ? '<span class="sticky-done-icon" aria-label="已完成">' + icon('check', 16) + '</span>' : ''}<h3>${highlight(note.title)}</h3><details class="sticky-menu"><summary aria-label="更多操作">${icon('more', 18)}</summary><div><button type="button" data-note-edit="${esc(note.id)}">编辑</button><button type="button" data-note-delete="${esc(note.id)}">删除</button></div></details></div>
        ${note.content ? `<p class="sticky-card-content">${highlight(note.content)}</p>` : ''}<div class="sticky-card-footer"><time datetime="${esc(note.created_at || '')}">${esc(timestamp(note.created_at))}</time><label class="sr-only" for="sticky-state-${esc(note.id)}">${esc(note.title)}的状态</label><select id="sticky-state-${esc(note.id)}" data-note-state="${esc(note.id)}" ${busy.has(String(note.id)) ? 'disabled' : ''}>${NOTE_STATES.map(option => `<option value="${option.value}" ${state.value === option.value ? 'selected' : ''}>${option.label}</option>`).join('')}</select></div>
      </article>`).join('') : `<p class="sticky-empty">${query ? '没有匹配的便签' : state.value === 'todo' ? '想到什么，在上方记下来' : state.value === 'doing' ? '开始处理后，将便签移到这里' : '完成的小事，会收在这里'}</p>`}</div></section>`;
    }).join('');
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
  async function deleteNote(id) {
    if (!(await confirmDialog('删除这条便签？删除后可在回收站找回。', { title: '删除便签', danger: true }))) return;
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
  input.oninput = () => { create.disabled = !input.value.trim(); };
  const addNote = async () => {
    if (create.disabled) return;
    const payload = quickNote(input.value);
    if (!payload.title) return;
    create.disabled = true;
    try {
      await api.post('/todos', payload);
      input.value = ''; mobileState = 'todo'; setStatus('已保存');
      await load(); toast(query ? '已记下来，可重置搜索查看全部便签' : '已记下来'); input.focus();
    } catch (error) { toast(error.message || '保存失败，请重试', 'err'); }
    finally { create.disabled = !input.value.trim(); }
  };
  page.querySelector('.sticky-compose').onsubmit = event => { event.preventDefault(); addNote(); };
  input.onkeydown = event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) { event.preventDefault(); addNote(); } };
  try { await load(); }
  catch (error) {
    board.innerHTML = `<div class="sticky-load-error" role="alert">${esc(error.message || '便签加载失败')}<button class="btn ghost" type="button">重试</button></div>`;
    board.querySelector('button').onclick = async () => { try { await load(); } catch (failure) { toast(failure.message || '加载失败', 'err'); } };
  }
}

