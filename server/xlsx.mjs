/* ============ 零依赖 xlsx / csv 解析 ============
 * 只做一件事：把表格文件读成二维字符串数组 grid[row][col]。
 * 支持 .xlsx（Office Open XML，zip 内含 xml）、.csv、.txt（制表符分隔）。
 * 不引入任何 npm 包：zip 的 deflate 用 node:zlib，xml 用正则精确匹配（不走 DOM，避免大文件卡死）。
 */
import zlib from 'node:zlib';

/* ---------- 1. 最小 zip 读取器 ---------- */
/* 从中央目录读文件列表，再按需解压单个条目 */
function readZip(buf) {
  // 找 End of Central Directory（EOCD）：签名 0x06054b50，从尾部向前最多扫 64KB
  let eocd = -1;
  const start = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= start; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return { files: {}, order: [] };

  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const files = {}; const order = [];

  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString('utf8');
    files[name] = { method, compSize, localOff };
    order.push(name);
    off += 46 + nameLen + extraLen + commentLen;
  }
  return { files, order };
}

function readZipEntry(buf, entry) {
  const { method, localOff } = entry;
  const nameLen = buf.readUInt16LE(localOff + 26);
  const extraLen = buf.readUInt16LE(localOff + 28);
  const dataStart = localOff + 30 + nameLen + extraLen;
  // 中央目录里的 compSize 可能为 0（流式写入的情况），此时回退到 local header
  let size = entry.compSize;
  if (!size) size = buf.readUInt32LE(localOff + 18);
  const data = buf.subarray(dataStart, dataStart + size);
  if (method === 0) return data;                 // stored
  if (method === 8) {
    try { return zlib.inflateRawSync(data); } catch { return zlib.inflateRawSync(data, { finishFlush: zlib.constants.Z_SYNC_FLUSH }); }
  }
  throw new Error('不支持的压缩方式: ' + method);
}

/* ---------- 2. XML 小工具 ---------- */
function unesc(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}
/* 取所有 <t> 内文本拼起来（富文本会拆成多个 <r><t>…） */
function textOf(xml) {
  let out = '';
  const re = /<t[^>]*>([\s\S]*?)<\/t>/g;
  let m;
  while ((m = re.exec(xml))) out += m[1];
  return unesc(out);
}
/* A1 → 列号（0 基） */
function colIndex(ref) {
  const m = /^([A-Z]+)/i.exec(ref || '');
  if (!m) return 0;
  let n = 0;
  for (const ch of m[1].toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
function rowIndex(ref) {
  const m = /(\d+)$/.exec(ref || '');
  return m ? Number(m[1]) - 1 : 0;
}

/* ---------- 3. 读 xlsx ---------- */
export function parseXlsx(buf) {
  const zip = readZip(buf);
  const names = Object.keys(zip.files);
  if (!names.length) throw new Error('不是有效的 xlsx 文件');

  // 共享字符串表
  let shared = [];
  const ssPath = names.find((n) => /sharedStrings\.xml$/i.test(n));
  if (ssPath) {
    const xml = readZipEntry(buf, zip.files[ssPath]).toString('utf8');
    shared = [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]));
  }

  // 工作表列表：从 workbook.xml 拿顺序与名称，从 rels 拿真实路径
  let sheets = [];
  const wbPath = names.find((n) => /workbook\.xml$/i.test(n) && !/rels/.test(n));
  const relPath = names.find((n) => /_rels\/workbook\.xml\.rels$/i.test(n));
  const relMap = {};
  if (relPath) {
    const relXml = readZipEntry(buf, zip.files[relPath]).toString('utf8');
    for (const m of relXml.matchAll(/<Relationship\b[^>]*>/g)) {
      const id = /Id="([^"]*)"/.exec(m[0])?.[1];
      const target = /Target="([^"]*)"/.exec(m[0])?.[1];
      if (id && target) relMap[id] = target.replace(/^\/?xl\//, '').replace(/^\//, '');
    }
  }
  if (wbPath) {
    const wbXml = readZipEntry(buf, zip.files[wbPath]).toString('utf8');
    for (const m of wbXml.matchAll(/<sheet\b([^>]*)\/?>/g)) {
      const attrs = m[1];
      const name = unesc(/name="([^"]*)"/.exec(attrs)?.[1] || '');
      const rid = /r:id="([^"]*)"/.exec(attrs)?.[1];
      const target = relMap[rid];
      if (target) sheets.push({ name, path: 'xl/' + target });
    }
  }
  if (!sheets.length) {
    // 兜底：直接按文件名排序取 worksheet
    sheets = names.filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
      .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)[1]) - Number(/(\d+)\.xml$/.exec(b)[1]))
      .map((p, i) => ({ name: 'Sheet' + (i + 1), path: p }));
  }

  const out = [];
  for (const sh of sheets) {
    const entry = zip.files[sh.path];
    if (!entry) continue;
    const xml = readZipEntry(buf, entry).toString('utf8');
    const grid = [];
    // 逐行解析：<row r="1" ...> <c r="A1" t="s"><v>0</v></c> ... </row>
    for (const rm of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
      const rIdx = Number((/r="(\d+)"/.exec(rm[1]) || [])[1] || 0) - 1;
      const cells = [];
      for (const cm of rm[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = cm[1] || '';
        const inner = cm[2] || '';
        const ref = /r="([A-Z]+\d+)"/i.exec(attrs)?.[1];
        const t = /t="([^"]*)"/.exec(attrs)?.[1] || 'n';
        const ci = ref ? colIndex(ref) : cells.length;
        let val = '';
        if (t === 's') {
          const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
          val = shared[Number(v)] ?? '';
        } else if (t === 'inlineStr') {
          val = textOf(inner);
        } else if (t === 'str') {
          val = unesc(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] || '');
        } else if (t === 'b') {
          val = /<v>1<\/v>/.test(inner) ? '是' : '';
        } else if (t === 'e') {
          val = '';
        } else {
          const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
          if (v != null && v !== '') {
            const num = Number(v);
            // 日期序列号（1900 基准）转成 YYYY-MM-DD
            if (Number.isFinite(num) && num > 20000 && num < 80000 && /(^|;)s="[^"]*(?:date|Date)/.test(attrs)) {
              val = excelDate(num);
            } else val = String(v);
          }
        }
        cells[ci] = String(val ?? '').trim();
      }
      const row = [];
      for (let i = 0; i < cells.length; i++) row[i] = cells[i] ?? '';
      grid[rIdx >= 0 ? rIdx : grid.length] = row;
    }
    // 补齐稀疏行
    const clean = [];
    for (let i = 0; i < grid.length; i++) clean[i] = grid[i] || [];
    out.push({ name: sh.name, grid: clean });
  }
  return out;
}

function excelDate(serial) {
  const ms = Math.round((serial - 25569) * 86400 * 1000);
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

/* ---------- 4. 读 csv / tsv ---------- */
export function parseCsv(text) {
  let s = String(text).replace(/^\uFEFF/, '');
  // 分隔符判断：前 5 行里出现次数最多的那个（不能用第一行，第一行常常是没有逗号的标题）
  const head = s.split(/\r?\n/).slice(0, 5).join('\n');
  const cnt = (ch) => head.split(ch).length - 1;
  const tabs = cnt('\t'); const commas = cnt(','); const semis = cnt(';');
  const delim = tabs >= commas && tabs >= semis && tabs > 0 ? '\t' : (commas >= semis ? ',' : ';');
  const rows = []; let row = []; let cur = ''; let q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c === '\r') { /* skip */ }
    else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows.map((r) => r.map((x) => String(x).trim()));
}

/* ---------- 5. 统一入口 ---------- */
export function readSheet(filename, buf) {
  const name = String(filename || '').toLowerCase();
  if (name.endsWith('.xlsx') || name.endsWith('.xlsm')) return parseXlsx(buf);
  if (name.endsWith('.csv') || name.endsWith('.txt') || name.endsWith('.tsv')) {
    const txt = buf.toString('utf8');
    return [{ name: 'CSV', grid: parseCsv(txt) }];
  }
  if (name.endsWith('.xls')) throw new Error('旧版 .xls 暂不支持，请在 Excel/WPS 里「另存为 .xlsx」再上传');
  // 未知类型：先试 xlsx（zip 头 PK），再当文本
  if (buf.length > 2 && buf[0] === 0x50 && buf[1] === 0x4b) return parseXlsx(buf);
  return [{ name: 'Text', grid: parseCsv(buf.toString('utf8')) }];
}

/* ============ 6. 识别表头：把 grid 变成结构化表 ============
 * 目标：认出「年级 / 表类型 / 年份 / 月 / 日 / 星期 / 节次 / 勾选列 / 教师名单」
 * 兼容两种真实版式：
 *   坐班表：单栏或双栏（左右各一组 序号-姓名-学科-上课-坐班-听课-教研-请假-备注）
 *   教研表：按学科分块，每块内 序号-姓名-学科-签到-备注
 */
const WEEK_CN = ['日', '一', '二', '三', '四', '五', '六'];
const TICK_RE = /^[✓✔√∨vV×xX✗✘\-—/／\\]+$/;

export function normalizeCell(s) {
  return String(s ?? '').replace(/\s+/g, '').replace(/[：:]/g, '');
}

/* 找标题行：包含 年级 或 坐班/教研/签到，且文字较长 */
function findTitle(grid) {
  for (let i = 0; i < Math.min(grid.length, 8); i++) {
    const line = (grid[i] || []).join(' ').trim();
    if (!line) continue;
    if (/(坐班|教研|签到)/.test(line) && /(年级|高一|高二|高三|初中)/.test(line)) return { row: i, text: line };
  }
  // 退一步：只要含表类型关键词
  for (let i = 0; i < Math.min(grid.length, 8); i++) {
    const line = (grid[i] || []).join(' ').trim();
    if (/(坐班表|教研签到表|签到表)/.test(line)) return { row: i, text: line };
  }
  return null;
}

/* 从标题文字抽取元信息 */
function fromTitle(text) {
  const meta = { grade: '', sheet_type: '', year: '', month: '', day: '', weekday: '', periods: '', subject: '' };
  const y = /(20\d{2})\s*年/.exec(text); if (y) meta.year = y[1];
  const gradeM = /(高一|高二|高三|初一|初二|初三)/.exec(text); if (gradeM) meta.grade = gradeM[1];
  if (/坐班/.test(text)) meta.sheet_type = 'seat';
  else if (/教研|签到/.test(text)) meta.sheet_type = 'research';
  const sj = /(语文|数学|英语|政治|历史|地理|物理|化学|生物|体育|音乐|美术|信息|通用技术|心理|日语|俄语|道法|科学)/.exec(text);
  if (sj && meta.sheet_type === 'research') meta.subject = sj[1];
  return meta;
}

/* 从「2026 | 年 | 10 | 月 | 19 | 日」这种分散单元格里抽日期 */
function fromDateCells(rows) {
  const out = { year: '', month: '', day: '', weekday: '', periods: '' };
  for (const row of rows) {
    const cells = row.map(normalizeCell);
    const gi = (kw) => cells.findIndex((c) => c === kw);
    const yi = gi('年'); const mi = gi('月'); const di = gi('日');
    if (yi > 0) { const v = cells[yi - 1]; if (/^20\d{2}$/.test(v)) out.year = v; }
    if (mi > 0) { const v = cells[mi - 1]; if (/^\d{1,2}$/.test(v)) out.month = v; }
    if (di > 0) { const v = cells[di - 1]; if (/^\d{1,2}$/.test(v)) out.day = v; }
    const wk = gi('星期');
    if (wk >= 0) {
      const v = cells[wk + 1] || '';
      const m = /^[一二三四五六日天]$/.exec(v);
      if (m) out.weekday = m[0] === '天' ? '日' : m[0];
    }
    // “第 1-2 节”
    for (let i = 0; i < cells.length; i++) {
      if (/^第/.test(cells[i])) {
        const m = /第([\d一二三四五六七八九十\-~—至]+)节?/.exec(cells.slice(i, i + 3).join(''));
        if (m) { out.periods = m[1].replace(/[~—至]/g, '-'); break; }
      }
      if (cells[i] === '节' && out.periods === '') {
        // 上一格可能是 “1-2”
        const prev = cells[i - 1] || '';
        const m = /^(\d+[-~—至]?\d*)$/.exec(prev);
        if (m) out.periods = m[1].replace(/[~—至]/g, '-');
      }
    }
  }
  return out;
}

/* 找表头行：含 姓名 */
function findHeaderRow(grid, titleRow) {
  for (let i = titleRow + 1; i < Math.min(grid.length, titleRow + 6); i++) {
    const cells = (grid[i] || []).map(normalizeCell);
    if (cells.some((c) => c === '姓名')) return i;
  }
  for (let i = 0; i < grid.length; i++) {
    const cells = (grid[i] || []).map(normalizeCell);
    if (cells.some((c) => c === '姓名')) return i;
  }
  return -1;
}

/* 在一行表头里，找出所有「姓名」列的位置（双栏会有两个） */
function nameColumns(header) {
  const idx = [];
  header.forEach((c, i) => { if (normalizeCell(c) === '姓名') idx.push(i); });
  return idx;
}

/* 识别勾选类列（上课/坐班/听课/教研/签到/请假…） */
const CHECK_LABELS = ['上课', '坐班', '听课', '教研', '签到', '请假', '签退', '备注'];

/* 解析一段栏位（从姓名列开始到下一段之前），返回 {subject, checks:[{key,label,col}], remarkCol} */
function sliceColumns(header, from, to) {
  const seg = [];
  for (let i = from; i < to && i < header.length; i++) seg.push({ i, label: normalizeCell(header[i]) });
  const out = { nameCol: from, subjectCol: -1, noCol: -1, checks: [], remarkCol: -1 };
  // 序号列：姓名左边紧邻的 “序号”
  if (from - 1 >= 0 && /序号/.test(normalizeCell(header[from - 1]))) out.noCol = from - 1;
  for (const s of seg) {
    if (/^(学科|科目)$/.test(s.label)) out.subjectCol = s.i;
    else if (/^备注$/.test(s.label)) { out.remarkCol = s.i; }
    else if (CHECK_LABELS.includes(s.label)) {
      // key 用「列名」而不是列号，双栏时左右两段的「坐班」才会合并成同一个字段
      out.checks.push({ key: 'k_' + s.label, label: s.label, col: s.i });
    }
  }
  return out;
}

/* 单元格 → 勾选状态：'1'=打勾，'0'=明确划掉，''=没填（空白格不算划掉！） */
function tickOf(v) {
  const s = String(v ?? '').trim();
  if (!s) return '';
  // 数字 0 / 1（Excel 里用 0/1 记勾选的情况）
  if (s === '1') return '1';
  if (s === '0') return '';
  if (/^[✓✔√∨vV]$/.test(s)) return '1';
  if (/^[×✗✘]$/.test(s)) return '0';
  if (/^[-—/／\\]+$/.test(s)) return '0';
  if (/^(是|有|到|已签到|已参加|出勤|√)$/.test(s)) return '1';
  if (/^(否|无|未签到|缺席|缺勤)$/.test(s)) return '0';
  return s; // 其他文字原样保留（比如签到时间 10/15）
}

export function detectSheet(grid, opts = {}) {
  const title = findTitle(grid);
  const titleRow = title ? title.row : -1;
  const metaFromTitle = title ? fromTitle(title.text) : { grade: '', sheet_type: '', subject: '' };
  const metaFromCells = fromDateCells(grid.slice(0, 8));

  const headerRow = findHeaderRow(grid, titleRow);
  if (headerRow < 0) {
    return {
      ok: false, reason: '没找到「姓名」列，无法识别为签到表。请确认表格第一行有「姓名」表头。',
      grid_preview: grid.slice(0, 8),
    };
  }
  const header = grid[headerRow] || [];
  const nameCols = nameColumns(header);

  // 每一段（双栏就两段）
  const segments = nameCols.map((from, k) => sliceColumns(header, from, nameCols[k + 1] ?? header.length));

  // 表头里的“说明行”：有些表把「上课/坐班」写在第 2 行
  const rowsOut = [];
  for (let r = headerRow + 1; r < grid.length; r++) {
    const row = grid[r] || [];
    if (!row.length) continue;
    const lineText = row.join('').trim();
    if (!lineText) continue;
    // 跳过重复的表头行（教研表按学科分块会重复出现 序号|姓名|学科|签到|备注）
    if (normalizeCell(row[segments[0].nameCol]) === '姓名') {
      // 记录学科标题（如「语文」单独一行）
      continue;
    }
    for (const seg of segments) {
      const name = String(row[seg.nameCol] ?? '').trim();
      if (!name || name === '姓名') continue;
      // 名字合理性：2-6 个汉字，或字母，排除纯数字/纯符号
      if (/^\d+$/.test(name)) continue;
      if (!/^[\u4e00-\u9fa5·A-Za-z\s]{2,12}$/.test(name)) continue;
      const subject = seg.subjectCol >= 0 ? String(row[seg.subjectCol] ?? '').trim() : '';
      const data = {};
      for (const c of seg.checks) {
        const v = tickOf(row[c.col]);
        if (v !== '') data[c.key] = v;
      }
      if (seg.remarkCol >= 0) {
        const v = String(row[seg.remarkCol] ?? '').trim();
        if (v) data.k_remark = v;
      }
      const no = seg.noCol >= 0 ? String(row[seg.noCol] ?? '').trim() : '';
      rowsOut.push({ teacher: name, subject, no, data });
    }
  }

  // 合并双栏时，同一个人可能出现两次（左栏最后一格与右栏），按姓名去重并合并勾选
  const merged = [];
  const index = new Map();
  for (const r of rowsOut) {
    const key = r.teacher + '|' + r.subject;
    if (index.has(key)) {
      const prev = merged[index.get(key)];
      prev.data = { ...r.data, ...prev.data };
    } else {
      index.set(key, merged.length);
      merged.push({ ...r, data: { ...r.data } });
    }
  }

  // 统一勾选列定义（取并集，按出现顺序）
  const checkMap = new Map();
  for (const seg of segments) for (const c of seg.checks) if (!checkMap.has(c.label)) checkMap.set(c.label, c);
  const columns = [...checkMap.values()].map((c) => ({ key: c.key, label: c.label, type: 'check', w: 62 }));
  if (segments.some((s) => s.remarkCol >= 0)) columns.push({ key: 'k_remark', label: '备注', type: 'text', w: 130 });

  const grade = opts.grade || metaFromTitle.grade || '';
  const sheetType = opts.sheetType || metaFromTitle.sheet_type || 'seat';
  const year = metaFromCells.year || metaFromTitle.year || String(new Date().getFullYear());
  const month = metaFromCells.month ? String(metaFromCells.month).padStart(2, '0') : '';
  const day = metaFromCells.day ? String(metaFromCells.day).padStart(2, '0') : '';
  let weekday = metaFromCells.weekday;
  if (!weekday && year && month && day) {
    const d = new Date(Number(year), Number(month) - 1, Number(day));
    if (!Number.isNaN(d.getTime())) weekday = WEEK_CN[d.getDay()];
  }

  const subjects = [...new Set(merged.map((r) => r.subject).filter(Boolean))];

  return {
    ok: true,
    detected: {
      grade, sheet_type: sheetType,
      subject: metaFromTitle.subject || '',
      year, month, day, weekday,
      periods: metaFromCells.periods || '',
      title: title ? title.text : '',
    },
    columns,
    rows: merged,
    subjects,
    stats: {
      teachers: merged.length,
      subjects: subjects.length,
      checks: columns.filter((c) => c.type === 'check').length,
      dual_column: segments.length > 1,
    },
  };
}
