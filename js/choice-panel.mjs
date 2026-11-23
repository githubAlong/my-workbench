/* 全站统一的自绘下拉面板。
   原生 <select> 的弹层归浏览器绘制，页面改不了样式（宽度只跟控件走、没有 hover
   与选中态、不能分组），所以这里自己画一层 fixed 浮层，跟着锚点输入框定位。

   约定：
   - 焦点始终留在输入框上，面板只做「显示 + 用 ↑↓/Enter 选择」，
     这样展开面板时还能继续打字过滤。
   - 面板挂在 body 上，用 position:fixed 定位，弹层内滚动时实时重算位置，
     避免被 .sheet-body 的 overflow 裁掉。
*/

let state = null;

function normalize(text) {
  return String(text ?? '').replace(/\s+/g, '').toLowerCase();
}

function filterItems(items, filter) {
  const q = normalize(filter);
  if (!q) return items;
  return items.filter((item) => normalize(item.label || item.value).includes(q));
}

function checkIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('viewBox', '0 0 14 14');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M3 7.4l2.6 2.6L11 4.4');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.6');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
}

function panelElement() {
  if (state.el?.isConnected) return state.el;
  const el = document.createElement('div');
  el.className = 'choice-panel';
  el.setAttribute('role', 'listbox');
  document.body.append(el);
  state.el = el;
  return el;
}

function render() {
  const { el, visible, active, selectedValue, emptyHint } = state;
  const frag = document.createDocumentFragment();
  let lastGroup = null;
  let index = 0;

  for (const item of visible) {
    if (item.group && item.group !== lastGroup) {
      const head = document.createElement('div');
      head.className = 'choice-panel-group';
      head.textContent = item.group;
      frag.append(head);
      lastGroup = item.group;
    }
    /* 必须按行取一份副本：直接闭包 index 会让所有行都读到循环结束后的终值。 */
    const rowIndex = index;
    const row = document.createElement('div');
    row.className = 'choice-panel-item';
    row.setAttribute('role', 'option');
    row.dataset.index = String(rowIndex);
    row.setAttribute('aria-selected', String(item.value === selectedValue));
    if (rowIndex === active) row.dataset.active = 'true';

    const label = document.createElement('span');
    label.className = 'choice-panel-label';
    label.textContent = item.label ?? item.value;
    row.append(label);

    if (item.hint) {
      const hint = document.createElement('span');
      hint.className = 'choice-panel-hint';
      hint.textContent = item.hint;
      row.append(hint);
    }
    if (item.value === selectedValue) row.append(checkIcon());

    row.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      pick(rowIndex);
    });
    frag.append(row);
    index += 1;
  }

  if (!visible.length && emptyHint) {
    const empty = document.createElement('div');
    empty.className = 'choice-panel-empty';
    empty.textContent = emptyHint;
    frag.append(empty);
  }

  el.replaceChildren(frag);
}

function position() {
  const { el, anchor } = state;
  if (!anchor?.isConnected) { closeChoices(); return; }
  const rect = anchor.getBoundingClientRect();
  const gap = 6;
  const margin = 8;
  const width = Math.min(state.maxWidth, Math.max(state.minWidth, rect.width));
  el.style.width = width + 'px';

  const height = el.offsetHeight;
  const below = window.innerHeight - rect.bottom - gap - margin;
  const above = rect.top - gap - margin;
  const openUp = height > below && above > below;
  const top = openUp ? Math.max(margin, rect.top - gap - height) : rect.bottom + gap;
  const left = Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin));

  el.dataset.side = openUp ? 'up' : 'down';
  el.style.top = Math.round(top) + 'px';
  el.style.left = Math.round(left) + 'px';
}

function scrollActiveIntoView() {
  const row = state.el?.querySelector('.choice-panel-item[data-active="true"]');
  row?.scrollIntoView({ block: 'nearest' });
}

function setActive(index) {
  if (!state) return;
  const total = state.visible.length;
  if (!total) { state.active = -1; return; }
  const next = ((index % total) + total) % total;
  state.active = next;
  for (const row of state.el.querySelectorAll('.choice-panel-item')) {
    if (Number(row.dataset.index) === next) row.dataset.active = 'true';
    else delete row.dataset.active;
  }
  scrollActiveIntoView();
}

function pick(index) {
  if (!state) return;
  const item = state.visible[index];
  if (!item) return;
  const { onPick, input } = state;
  closeChoices();
  if (onPick) { onPick(item); return; }
  if (input) {
    input.value = item.value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

function onInputKeydown(event) {
  if (!state) return;
  const { key } = event;
  if (key === 'ArrowDown' || key === 'ArrowUp') {
    event.preventDefault();
    setActive(state.active + (key === 'ArrowDown' ? 1 : -1));
    return;
  }
  if (key === 'Enter') {
    if (state.active < 0) return;
    event.preventDefault();
    event.stopPropagation();
    pick(state.active);
    return;
  }
  if (key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    closeChoices();
    return;
  }
  if (key === 'Tab') closeChoices();
}

function onDocumentPointerDown(event) {
  if (!state) return;
  const target = event.target;
  if (state.el?.contains(target)) return;
  if (state.anchor?.contains(target)) return;
  if (target instanceof Element && target.closest('.editable-choice, .class-picker')) return;
  closeChoices();
}

let boundInput = null;

function bindGlobals() {
  if (!state.globalsBound) {
    state.globalsBound = true;
    document.addEventListener('pointerdown', onDocumentPointerDown, true);
    window.addEventListener('scroll', position, true);
    window.addEventListener('resize', position);
  }
}

function unbindGlobals() {
  document.removeEventListener('pointerdown', onDocumentPointerDown, true);
  window.removeEventListener('scroll', position, true);
  window.removeEventListener('resize', position);
}

export function openChoices(anchor, options = {}) {
  if (!anchor || !anchor.isConnected) return;
  const {
    items = [],
    input = null,
    filter = '',
    selected = '',
    onPick = null,
    emptyHint = '',
    minWidth = 220,
    maxWidth = 360,
  } = options;

  const visible = filterItems(items, filter);
  if (!visible.length && !emptyHint) { closeChoices(); return; }

  const sameAnchor = state && state.anchor === anchor && state.el?.isConnected;
  if (!sameAnchor) {
    closeChoices();
    state = { anchor, el: null, visible: [], active: -1, selectedValue: '', items: [] };
    bindGlobals();
  }

  Object.assign(state, { items, visible, onPick, emptyHint, minWidth, maxWidth, filter, selectedValue: selected, input });
  panelElement();
  render();
  position();

  const previousActive = state.active;
  const keep = visible.findIndex((item) => item.value === selected);
  state.active = keep >= 0 ? keep : (visible.length ? 0 : -1);
  if (previousActive >= 0 && state.active === previousActive) state.active = previousActive;
  setActive(state.active);

  if (input && boundInput !== input) {
    if (boundInput) boundInput.removeEventListener('keydown', onInputKeydown, true);
    boundInput = input;
    boundInput.addEventListener('keydown', onInputKeydown, true);
  }
}

/* 面板是单例的：正在给哪个 input 用，只有它自己有权改内容。
   别的字段（没带 input 校验）来 updateChoices 会把内容换成自己的候选，
   但 state.input 还指着上一个字段 —— 之后一选中就写进别人框里。
   所以这里要求调用方报上门牌，对不上就直接忽略。 */
export function updateChoices(options = {}) {
  if (!state) return;
  const { items, filter, selected, emptyHint, input } = options;
  if (input && state.input !== input) return;
  if (items) state.items = items;
  if (typeof filter === 'string') state.filter = filter;
  if (typeof selected === 'string') state.selectedValue = selected;
  if (typeof emptyHint === 'string') state.emptyHint = emptyHint;
  state.visible = filterItems(state.items, state.filter);
  if (!state.visible.length && !state.emptyHint) { closeChoices(); return; }
  render();
  position();
  state.active = state.visible.length ? 0 : -1;
  setActive(state.active);
}

export function closeChoices() {
  if (boundInput) { boundInput.removeEventListener('keydown', onInputKeydown, true); boundInput = null; }
  if (state) {
    state.el?.remove();
    if (state.globalsBound) unbindGlobals();
  }
  state = null;
}

export function isChoicesOpen() {
  return !!state;
}

/* 当前面板是不是这个输入框的。用来判断「再点一下收起」还是「切换到我这来」。 */
export function isChoicesFor(input) {
  return !!state && !!input && state.input === input;
}
