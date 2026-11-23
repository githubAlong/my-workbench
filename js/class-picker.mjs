export function classSuggestions(rows, { qualified = false } = {}) {
  const unique = new Map();
  for (const row of rows || []) {
    if (row?.deleted_at) continue;
    const grade = String(row?.grade ?? '').trim();
    const name = String(typeof row === 'string' ? row : row?.class_name ?? '').trim();
    if (!name) continue;
    const label = grade && !name.startsWith(grade) ? grade + name : name;
    const value = qualified ? label : name;
    const key = qualified ? value : JSON.stringify([label, value]);
    if (!unique.has(key)) unique.set(key, { value, label, grade });
  }
  return [...unique.values()].sort((a, b) => a.label.localeCompare(b.label, 'zh-CN', { numeric: true }));
}

export function setClassSuggestions(input, rows, { gradeInput, qualified } = {}) {
  if (!input) return;
  const choices = classSuggestions(rows, { qualified });
  const doc = input.ownerDocument;
  const parent = input.parentElement;
  let picker = parent.classList.contains('class-picker') ? parent.lastElementChild : null;
  if (!picker) {
    const wrapper = doc.createElement('span');
    wrapper.className = 'class-picker';
    picker = doc.createElement('select');
    picker.className = 'class-picker-options';
    picker.setAttribute('aria-label', '选择班级');
    picker.title = '选择班级';
    input.replaceWith(wrapper);
    wrapper.append(input, picker);
  }
  picker.hidden = !choices.length;
  const createOption = (label, value) => {
    const option = doc.createElement('option');
    option.textContent = label;
    option.value = value;
    return option;
  };
  picker.replaceChildren(
    createOption('请选择班级', ''),
    ...choices.map(({ label }, index) => createOption(label, String(index))),
  );
  picker.onchange = () => {
    if (picker.value === '') return;
    const choice = choices[Number(picker.value)];
    picker.value = '';
    if (gradeInput && choice.grade) gradeInput.value = choice.grade;
    input.value = choice.value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };
}
