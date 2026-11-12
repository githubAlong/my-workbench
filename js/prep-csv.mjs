/* 备课记录：CSV 编解码、筛选与列表截断的纯逻辑。
   不依赖 DOM / 网络，便于 node --test 直接跑。 */

export const CSV_HEADERS = Object.freeze(['备课时间', '学科', '年级', '标题', '授课内容', '备注']);

/* 导入时兼容中文表头、英文 key 和历史叫法。 */
const HEADER_ALIASES = Object.freeze({
  '备课时间': 'planDate', '备课日期': 'planDate', '上课日期': 'planDate', '日期': 'planDate',
  date: 'planDate', planDate: 'planDate',
  '学科': 'subject', subject: 'subject',
  '年级': 'grade', '年级班级': 'grade', '班级': 'grade',
  grade: 'grade', class_name: 'grade', className: 'grade',
  '标题': 'title', '课题': 'title', '主题': 'title', title: 'title', topic: 'title',
  '授课内容': 'process', '本节课授课内容': 'process', '内容': 'process',
  process: 'process', content: 'process',
  '备注': 'remark', remark: 'remark',
});

export const ROW_KEYS = Object.freeze(['planDate', 'subject', 'grade', 'title', 'process', 'remark']);

export function csvEscape(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

/* 带 UTF-8 BOM，Excel / WPS 双击直接打开不乱码。 */
export function buildPrepCsv(rows) {
  const lines = [CSV_HEADERS.map(csvEscape).join(',')];
  for (const row of (Array.isArray(rows) ? rows : [])) {
    lines.push(ROW_KEYS.map((key) => csvEscape(row?.[key])).join(','));
  }
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

/* 逐字符状态机：支持引号内逗号、引号内换行、双引号转义、CRLF 与 BOM。 */
function csvMatrix(text) {
  const src = String(text ?? '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i += 1; }
        else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell === '') {
      quoted = true;
    } else if (ch === ',') {
      row.push(cell); cell = '';
    } else if (ch === '\n') {
      row.push(cell); rows.push(row); row = []; cell = '';
    } else {
      cell += ch;
    }
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((item) => item.some((value) => String(value).trim() !== ''));
}

function cleanHeader(value) {
  return String(value ?? '').replace(/^\uFEFF/, '').trim().toLowerCase();
}

export function normalizePrepDate(value) {
  const raw = String(value ?? '').trim();
  const match = raw.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
  if (!match) return '';
  const [, y, m, d] = match;
  const month = Number(m), day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return '';
  return `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/* 返回 { rows, errors }；errors 只记录结构性问题，业务必填校验交给调用方。 */
export function parsePrepCsv(text) {
  const matrix = csvMatrix(text);
  if (!matrix.length) return { rows: [], errors: ['文件是空的'] };
  const headerRow = matrix[0];
  const keys = headerRow.map((value) => HEADER_ALIASES[cleanHeader(value)] || '');
  const errors = [];
  if (!keys.includes('title')) errors.push('缺少「标题」列');
  if (errors.length) return { rows: [], errors };

  const rows = [];
  for (let i = 1; i < matrix.length; i += 1) {
    const cells = matrix[i];
    const row = Object.fromEntries(ROW_KEYS.map((key) => [key, '']));
    keys.forEach((key, index) => { if (key) row[key] = String(cells[index] ?? '').trim(); });
    if (!ROW_KEYS.some((key) => row[key])) continue;
    row.planDate = normalizePrepDate(row.planDate);
    row.__line = i + 1;
    rows.push(row);
  }
  return { rows, errors };
}

/* 导入时把当前筛选值补到文件里缺失的字段；日期区间取起始日。 */
export function applyFilterDefaults(row, filters = {}) {
  const next = { ...row };
  if (!next.subject) next.subject = String(filters.subject || '').trim();
  if (!next.grade) next.grade = String(filters.grade || '').trim();
  if (!next.planDate) next.planDate = normalizePrepDate(filters.from || '');
  return next;
}

export function filterPrepRows(rows, filters = {}) {
  const subject = String(filters.subject || '').trim();
  const grade = String(filters.grade || '').trim();
  const from = normalizePrepDate(filters.from || '');
  const to = normalizePrepDate(filters.to || '');
  const keyword = String(filters.keyword || '').trim().toLocaleLowerCase();
  return (Array.isArray(rows) ? rows : []).filter((row) => {
    if (subject && String(row?.subject || '').trim() !== subject) return false;
    if (grade && String(row?.grade || '').trim() !== grade) return false;
    const date = normalizePrepDate(row?.planDate || '');
    if (from && (!date || date < from)) return false;
    if (to && (!date || date > to)) return false;
    if (keyword) {
      const haystack = ROW_KEYS.map((key) => String(row?.[key] ?? '')).join(' ').toLocaleLowerCase();
      if (!haystack.includes(keyword)) return false;
    }
    return true;
  });
}

/* 列表「授课内容」只显示两行，超出显示 .....（按显示宽度估算：中文 1、ASCII 0.5）。 */
export function truncateTwoLines(text, charsPerLine = 30) {
  const flat = String(text ?? '').replace(/\s*\n+\s*/g, ' ').trim();
  if (!flat) return { text: '', clipped: false };
  const capacity = Math.max(1, Number(charsPerLine) || 30) * 2;
  let width = 0;
  let index = 0;
  let out = '';
  for (; index < flat.length; index += 1) {
    const ch = flat[index];
    const charWidth = ch.charCodeAt(0) <= 0xff ? 0.5 : 1;
    if (width + charWidth > capacity) break;
    out += ch;
    width += charWidth;
  }
  const clipped = index < flat.length;
  return { text: clipped ? out.trimEnd() + '.....' : out, clipped };
}
