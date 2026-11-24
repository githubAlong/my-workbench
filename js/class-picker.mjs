import { normGrade, inferGrade, normClass, gradeRank } from './grade-class.mjs';

/* 候选列表：年级不再无脑拼进标签。
   以前 label 一律是「高二5班」，于是「上课记录」这类已经有独立「上课年级」字段的表单，
   下拉里还是「高二5班 / 高二6班 / …」，年级显示两遍。
   现在按字段形态分两种：
     · 有独立年级框 → 标签和写入值都只给班名「5班」，年级单独存；
     · 只有班级一列（没有年级框）→ 标签和值都带前缀「高二5班」，否则年级会丢。 */
export function classSuggestions(rows, { qualified = false } = {}) {
  const unique = new Map();
  for (const row of rows || []) {
    if (row?.deleted_at) continue;
    const rawName = typeof row === 'string' ? row : row?.class_name;
    const grade = normGrade(typeof row === 'string' ? '' : row?.grade) || inferGrade(rawName);
    const name = normClass(rawName, grade);
    /* 归一后是空的 = 这行只有年级、没有班号（「高二」「高二()」这类脏数据）。
       以前它会原样进候选，下拉第一行就多出个「高二」，点它存进去也是个坏班级值。 */
    if (!name) continue;
    const id = grade + '#' + name;
    if (unique.has(id)) continue;
    const value = qualified && grade ? grade + name : name;
    unique.set(id, { id, value, label: value, grade });
  }
  return [...unique.values()].sort((a, b) => gradeRank(a.grade) - gradeRank(b.grade)
    || a.label.localeCompare(b.label, 'zh-Hans-CN', { numeric: true }));
}

export function setClassSuggestions(input, rows, { gradeInput, qualified } = {}) {
  if (!input) return;
  const all = classSuggestions(rows, { qualified });
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
  /* 年级框有值时按年级收窄候选：上面选了「高二」，这一列就只留高二的班。
     一个都匹配不上（数据对不齐）就退回全量，不能让下拉变空、录不进去。 */
  const wantGrade = normGrade(gradeInput?.value) || '';
  const matched = wantGrade ? all.filter((choice) => choice.grade === wantGrade) : [];
  const choices = matched.length ? matched : all;
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
    if (!choice) return;
    picker.value = '';
    if (gradeInput && choice.grade) gradeInput.value = choice.grade;
    input.value = choice.value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };
}
