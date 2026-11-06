const HEADER_WORDS = {
  serial: new Set(['序号', '编号', '序', 'no', 'no.']),
  name: new Set(['姓名', '名字', '教师', '老师', 'name']),
  subject: new Set(['学科', '科目', '教研组', 'subject']),
};
const NON_NAMES = new Set(['姓名', '名字', '教师', '老师', '序号', '编号', '学科', '科目', '签到', '备注', '合计', '小计', '总计']);

function cellText(value) {
  return String(value ?? '').replace(/[\u3000\s]+/g, '').trim();
}
function headerKind(value) {
  const text = cellText(value).toLowerCase();
  for (const [kind, words] of Object.entries(HEADER_WORDS)) {
    if (words.has(text)) return kind;
  }
  return '';
}
function validTeacherName(value) {
  const name = cellText(value);
  return name.length >= 2 && name.length <= 8
    && !NON_NAMES.has(name)
    && /[\u3400-\u9fffA-Za-z]/.test(name)
    && !/^\d+$/.test(name);
}
function validSubject(value) {
  const subject = cellText(value);
  return subject.length >= 1 && subject.length <= 12 && !NON_NAMES.has(subject)
    && !/^\d+$/.test(subject);
}
function parseGrade(text, hint = '') {
  const match = /(高[一二三]|初[一二三])/.exec(String(text || ''));
  return match?.[1] || hint || '';
}

/**
 * Extract teacher name/subject pairs from the school's Excel templates.
 * Supports side-by-side tables and repeated subject-block headers. The same
 * column map remains active until another header for that side is encountered.
 */
export function parseTeacherRosterGrid(grid, options = {}) {
  if (!Array.isArray(grid) || !grid.length) {
    return { ok: false, reason: '工作表为空，没有可导入的教师名单。', rows: [], warnings: [] };
  }
  const rows = grid.map((row) => Array.isArray(row) ? row : []);
  const maps = new Map();
  const extracted = [];
  const title = (rows.find((row) => row.some((cell) => cellText(cell))) || []).map(cellText).filter(Boolean).join(' ');
  const headerText = rows.slice(0, 6).flat().map(cellText).filter(Boolean).join(' ');

  for (let r = 0; r < rows.length; r += 1) {
    const row = rows[r] || [];
    const serialCols = [];
    row.forEach((cell, col) => { if (headerKind(cell) === 'serial') serialCols.push(col); });
    const updated = new Set();

    for (let i = 0; i < serialCols.length; i += 1) {
      const start = serialCols[i];
      const end = serialCols[i + 1] ?? Math.max(row.length, start + 5);
      let nameCol = -1;
      let subjectCol = -1;
      for (let col = start + 1; col < end; col += 1) {
        const kind = headerKind(row[col]);
        if (kind === 'name' && nameCol < 0) nameCol = col;
        if (kind === 'subject' && subjectCol < 0) subjectCol = col;
      }
      if (nameCol >= 0 && subjectCol >= 0) {
        maps.set(start, { start, end, serialCol: start, nameCol, subjectCol });
        updated.add(start);
      }
    }

    for (const [start, map] of maps) {
      if (updated.has(start)) continue;
      const name = cellText(row[map.nameCol]);
      const subject = cellText(row[map.subjectCol]);
      if (!validTeacherName(name) || !validSubject(subject)) continue;
      const sourceSerial = cellText(row[map.serialCol]);
      extracted.push({
        name,
        subject,
        sourceSerial,
        sourceRow: r + 1,
        sourceGroup: start === 0 ? 'left' : 'column-' + (start + 1),
      });
    }
  }

  if (!extracted.length) {
    return {
      ok: false,
      reason: '没有找到同时包含「姓名」和「学科」列的有效记录。请确认上传的是包含教师名单的工作表。',
      rows: [], warnings: [], grade: parseGrade(headerText, options.gradeHint), title,
    };
  }

  // A global serial sequence (1..N) is authoritative for the two-column seat
  // sheets. Subject-block sheets restart serials, so preserve their visual row
  // order instead of sorting by the repeated local serial.
  const serials = extracted.map((item) => Number(item.sourceSerial));
  const globalSequence = serials.every(Number.isInteger)
    && new Set(serials).size === serials.length
    && [...serials].sort((a, b) => a - b).every((n, i) => n === i + 1);
  if (globalSequence) extracted.sort((a, b) => Number(a.sourceSerial) - Number(b.sourceSerial));

  const unique = [];
  const seen = new Set();
  const duplicateRows = [];
  const subjectByName = new Map();
  const conflicts = [];
  for (const item of extracted) {
    const key = item.name + '\u0000' + item.subject;
    if (seen.has(key)) { duplicateRows.push(item); continue; }
    seen.add(key);
    const previousSubject = subjectByName.get(item.name);
    if (previousSubject && previousSubject !== item.subject) conflicts.push({ name: item.name, subjects: [previousSubject, item.subject] });
    else subjectByName.set(item.name, item.subject);
    unique.push(item);
  }

  const resultRows = unique.map((item, index) => ({
    serial: index + 1,
    name: item.name,
    subject: item.subject,
    sourceSerial: item.sourceSerial,
    sourceRow: item.sourceRow,
    side: item.sourceGroup,
    serialSource: 'excel',
    needsReview: false,
  }));
  const warnings = [];
  if (duplicateRows.length) warnings.push('发现 ' + duplicateRows.length + ' 条重复的姓名+学科记录，已合并为唯一教师名单。');
  if (conflicts.length) warnings.push('有 ' + conflicts.length + ' 位教师出现多个学科，请核对：' + conflicts.map((x) => x.name + '（' + x.subjects.join('/') + '）').join('、'));

  return {
    ok: resultRows.length > 0,
    grade: parseGrade(headerText, options.gradeHint),
    title,
    rawCount: extracted.length,
    duplicateCount: duplicateRows.length,
    conflictCount: conflicts.length,
    expectedCount: resultRows.length,
    rows: resultRows,
    warnings,
  };
}

export function chooseBestRosterSheet(sheets, options = {}) {
  const candidates = (Array.isArray(sheets) ? sheets : []).map((sheet) => ({
    name: sheet.name || '',
    ...parseTeacherRosterGrid(sheet.rows, options),
  })).filter((item) => item.ok);
  candidates.sort((a, b) => b.rows.length - a.rows.length);
  return candidates[0] || { ok: false, reason: '这个 Excel 的所有工作表中都没有找到可导入的教师名单。', rows: [], warnings: [] };
}
