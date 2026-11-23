import { openChoices, updateChoices, closeChoices, isChoicesFor } from './choice-panel.mjs';

const selector = 'input, textarea';
const noAutocomplete = 'input[list], input[data-choice-list], input:not([type]), input[type="text"], input[type="search"], input[type="email"], input[type="tel"], input[type="url"], input[type="number"], textarea';
const credentialAutocomplete = /^(?:username|current-password|new-password|one-time-code)$/i;
const wired = new WeakMap();

function collectItems(input) {
  const items = [];
  const seen = new Set();
  const push = (value, label, hint, group) => {
    const text = String(value ?? '').trim();
    if (!text || seen.has(text)) return;
    seen.add(text);
    items.push({ value: text, label: String(label ?? text).trim() || text, hint, group });
  };

  const custom = input.__choiceItems;
  if (Array.isArray(custom) && custom.length) {
    for (const item of custom) push(item.value, item.label, item.hint, item.group);
    return items;
  }

  const list = input.dataset.choiceList && input.ownerDocument.getElementById(input.dataset.choiceList);
  for (const option of list?.options || []) {
    if (option.value && !option.disabled) push(option.value, option.label || option.value);
  }
  return items;
}

function chevron() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('viewBox', '0 0 14 14');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M3.5 5.5L7 9l3.5-3.5');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.4');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
}

function refreshArrow(input) {
  const state = wired.get(input);
  if (!state) return;
  const items = collectItems(input);
  state.arrow.hidden = !items.length;
  const labelText = input.getAttribute('aria-label') || input.labels?.[0]?.textContent?.trim() || input.placeholder || '选项';
  state.arrow.setAttribute('aria-label', '展开' + labelText.replace(/\s*\*?\s*$/, ''));
}

function enhance(input) {
  if (input.matches(noAutocomplete) && !credentialAutocomplete.test(input.autocomplete)) input.autocomplete = 'off';
  if (!(input instanceof HTMLInputElement)) return;
  // 候选由页面面板显示，解除原生联想与输入框的绑定。
  const nativeList = input.getAttribute('list');
  if (nativeList) {
    input.dataset.choiceList = nativeList;
    input.removeAttribute('list');
  }
  /* 班级字段已有独立的选择面板。 */
  if (input.closest('.class-picker')) return;
  const items = collectItems(input);
  if (!input.dataset.choiceList && !items.length) return;

  if (wired.get(input)) { refreshArrow(input); return; }

  const doc = input.ownerDocument;
  const wrap = doc.createElement('span');
  wrap.className = 'editable-choice';
  input.before(wrap);
  wrap.append(input);

  const arrow = doc.createElement('span');
  arrow.className = 'editable-choice-arrow';
  arrow.setAttribute('role', 'button');
  arrow.setAttribute('tabindex', '-1');
  arrow.append(chevron());
  wrap.append(arrow);

  wired.set(input, { arrow });
  refreshArrow(input);

  const show = (filter) => {
    const list = collectItems(input);
    if (!list.length) { closeChoices(); return; }
    openChoices(wrap, {
      items: list,
      input,
      filter,
      selected: input.value.trim(),
      minWidth: Math.max(220, wrap.offsetWidth),
    });
  };

  arrow.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    event.stopPropagation();
    /* 面板正给自己用 → 再点一次收起；面板在别的字段上 → 换成自己的候选（不要只关掉）。 */
    if (isChoicesFor(input)) { closeChoices(); return; }
    if (input.readOnly || input.disabled) return;
    show('');
  });

  input.addEventListener('input', (event) => {
    if (!event.isTrusted || !isChoicesFor(input) || input.readOnly || input.disabled) return;
    updateChoices({ items: collectItems(input), filter: input.value, selected: input.value, input });
  });

  input.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown' || isChoicesFor(input)) return;
    if (input.readOnly || input.disabled) return;
    if (!collectItems(input).length) return;
    event.preventDefault();
    show('');
  });
}

function scan(root) {
  if (!(root instanceof Element)) return;
  if (root.matches(selector)) enhance(root);
  root.querySelectorAll(selector).forEach(enhance);
}

scan(document.body);
new MutationObserver(records => {
  let listsChanged = false;
  for (const record of records) {
    record.addedNodes.forEach(scan);
    if (record.type === 'attributes' && record.target.matches(selector)) enhance(record.target);
    if (record.target.closest('datalist') || [...record.addedNodes, ...record.removedNodes].some(node => node instanceof HTMLDataListElement)) listsChanged = true;
  }
  if (listsChanged) document.querySelectorAll('input[list], input[data-choice-list]').forEach(enhance);
}).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['list', 'disabled', 'readonly'] });
