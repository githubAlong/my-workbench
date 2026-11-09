import { readXlsx, readDelimited } from './xlsx-lite.js';
import { chooseBestRosterSheet, parseTeacherRosterGrid } from './roster-import.mjs';
import { recognizeRosterPhoto } from './ocr.js';

const NAME_HEADERS = new Set(['姓名','名字','教师','教师姓名','老师','name','teacher']);
const SUBJECT_HEADERS = new Set(['学科','科目','教研组','subject']);
const DEPT_HEADERS = new Set(['归属部门','部门','处室','教研组','department','dept']);
const GRADE_HEADERS = new Set(['归属年级','年级','grade']);

function clean(value) {
  return String(value ?? '').replace(/[\u3000\s]+/g, ' ').trim();
}
function headerKind(value) {
  const key = clean(value).replace(/\s+/g, '').toLowerCase();
  if (NAME_HEADERS.has(key)) return 'name';
  if (SUBJECT_HEADERS.has(key)) return 'subject';
  if (DEPT_HEADERS.has(key)) return 'department';
  if (GRADE_HEADERS.has(key)) return 'grade';
  return '';
}
function validName(value) {
  const name = clean(value);
  return /^[\u3400-\u9fffA-Za-z·•.\-]{2,20}$/.test(name);
}
function validSubject(value) {
  const subject = clean(value);
  return subject.length > 0 && subject.length <= 20 && !/^(姓名|学科|科目|备注|序号|合计|小计)$/.test(subject);
}
function identity(row) {
  const name = clean(row.name).toLowerCase();
  const subject = clean(row.subject).toLowerCase();
  return name && subject ? name + '\u0000' + subject : '';
}

function parseGenericGrid(grid, gradeHint = '') {
  const rows = Array.isArray(grid) ? grid : [];
  for (let headerIndex = 0; headerIndex < Math.min(rows.length, 30); headerIndex += 1) {
    const header = Array.isArray(rows[headerIndex]) ? rows[headerIndex] : [];
    const columns = { name: -1, subject: -1, department: -1, grade: -1 };
    header.forEach((cell, index) => {
      const kind = headerKind(cell);
      if (kind && columns[kind] < 0) columns[kind] = index;
    });
    if (columns.name < 0 || columns.subject < 0) continue;
    const extracted = [];
    for (let r = headerIndex + 1; r < rows.length; r += 1) {
      const line = Array.isArray(rows[r]) ? rows[r] : [];
      const name = clean(line[columns.name]);
      const subject = clean(line[columns.subject]);
      if (!name && !subject) continue;
      if (!validName(name) || !validSubject(subject)) continue;
      extracted.push({
        name, subject,
        department: columns.department >= 0 ? clean(line[columns.department]) : '',
        grade: columns.grade >= 0 ? clean(line[columns.grade]) : gradeHint,
        sourceRow: r + 1,
        serial: extracted.length + 1,
        needsReview: false,
      });
    }
    if (extracted.length) return extracted;
  }

  // 纯粘贴的两列名单可以没有表头；只在每行均像“姓名 + 学科”时启用。
  const dataRows = rows.filter((line) => Array.isArray(line) && line.some((cell) => clean(cell)));
  if (dataRows.length >= 2 && dataRows.every((line, index) => {
    if (index === 0 && /姓名|学科|科目/.test(line.join(''))) return true;
    return validName(line[0]) && validSubject(line[1]);
  })) {
    return dataRows.slice(/姓名|学科|科目/.test(dataRows[0].join('')) ? 1 : 0).map((line, index) => ({
      name: clean(line[0]), subject: clean(line[1]),
      department: clean(line[2] || ''), grade: clean(line[3] || gradeHint),
      sourceRow: index + 1, serial: index + 1, needsReview: false,
    }));
  }
  return [];
}

function markFileDuplicates(rows) {
  const seen = new Set();
  return rows.map((row, index) => {
    const key = identity(row);
    const duplicateInFile = !!key && seen.has(key);
    if (key) seen.add(key);
    return { ...row, serial: Number(row.serial) || index + 1, duplicateInFile };
  });
}

export function parseRosterSheets(sheets, gradeHint = '') {
  const validSheets = (Array.isArray(sheets) ? sheets : []).filter((sheet) => Array.isArray(sheet.rows));
  if (!validSheets.length) throw new Error('文件中没有可读取的工作表');
  const structured = chooseBestRosterSheet(validSheets, { gradeHint });
  const genericCandidates = validSheets.map((sheet) => ({
    name: sheet.name || '',
    rows: parseGenericGrid(sheet.rows, gradeHint),
  })).filter((sheet) => sheet.rows.length);
  genericCandidates.sort((a, b) => b.rows.length - a.rows.length);
  const generic = genericCandidates[0];
  let selected = null;
  if (generic && (!structured.ok || generic.rows.length >= structured.rows.length)) {
    selected = { name: generic.name, rows: generic.rows, grade: gradeHint };
  } else if (structured.ok) {
    selected = {
      name: structured.name,
      grade: structured.grade || gradeHint,
      warnings: structured.warnings || [],
      rows: structured.rows.map((row) => ({ ...row, department: '', grade: structured.grade || gradeHint })),
    };
  }
  if (!selected?.rows?.length) throw new Error(structured.reason || '没有识别到“姓名”和“学科”两列，请使用标准模板或粘贴表格。');

  // If the same sheet also contains department/grade columns, enrich the structured rows.
  if (structured.ok && generic && generic.rows.length) {
    const meta = new Map(generic.rows.map((row) => [identity(row), row]));
    selected.rows = selected.rows.map((row) => {
      const extra = meta.get(identity(row));
      return extra ? { ...row, department: extra.department || '', grade: extra.grade || selected.grade || gradeHint } : row;
    });
  }
  const rows = markFileDuplicates(selected.rows);
  const duplicateCount = rows.filter((row) => row.duplicateInFile).length;
  const warnings = [...(selected.warnings || [])];
  if (duplicateCount) warnings.push('文件内有 ' + duplicateCount + ' 条重复的姓名+学科记录，预览中已标记，可选择跳过。');
  return { ok: true, sheetName: selected.name, grade: selected.grade || gradeHint, rows, warnings };
}

function loadScript(url) {
  return new Promise((resolve, reject) => {
    const existing = [...document.scripts].find((script) => script.src === url);
    if (existing) {
      if (window.XLSX || window.pdfjsLib) return resolve();
    }
    const script = document.createElement('script');
    const timer = setTimeout(() => {
      script.remove();
      reject(new Error('外部文件解析组件加载超时'));
    }, 30000);
    script.src = url;
    script.async = true;
    script.crossOrigin = 'anonymous';
    script.onload = () => { clearTimeout(timer); resolve(); };
    script.onerror = () => { clearTimeout(timer); script.remove(); reject(new Error('外部文件解析组件下载失败')); };
    document.head.appendChild(script);
  });
}

async function readLegacyXls(file) {
  if (!window.XLSX) {
    const urls = [
      'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js',
      'https://unpkg.com/xlsx@0.18.5/dist/xlsx.full.min.js',
    ];
    let loaded = false;
    for (const url of urls) {
      try { await loadScript(url); if (window.XLSX) { loaded = true; break; } } catch (_) {}
    }
    if (!loaded) throw new Error('旧版 .xls 解析组件加载失败。请将文件另存为 .xlsx 后重试。');
  }
  const workbook = window.XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
  return workbook.SheetNames.map((name) => ({
    name,
    rows: window.XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, defval: '' }),
  }));
}

async function loadPdfJs() {
  if (window.pdfjsLib?.getDocument) return window.pdfjsLib;
  const sources = [
    {
      script: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
      worker: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
    },
    {
      script: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js',
      worker: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js',
    },
  ];
  let lastError = null;
  for (const source of sources) {
    try {
      await loadScript(source.script);
      if (!window.pdfjsLib?.getDocument) throw new Error('PDF 解析组件没有初始化');
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = source.worker;
      return window.pdfjsLib;
    } catch (error) { lastError = error; }
  }
  throw new Error('PDF 解析组件加载失败，请检查网络后重试。' + (lastError?.message || ''));
}

async function recognizePdf(file, gradeHint, onProgress) {
  if (file.size > 50 * 1024 * 1024) throw new Error('PDF 超过 50MB，请先压缩后再上传');
  const pdfjs = await loadPdfJs();
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  if (pdf.numPages > 20) throw new Error('PDF 超过 20 页，请拆分后分批导入，避免浏览器处理过慢。');
  const allRows = [];
  const warnings = [];
  for (let pageNo = 1; pageNo <= pdf.numPages; pageNo += 1) {
    onProgress?.('正在读取 PDF 第 ' + pageNo + ' / ' + pdf.numPages + ' 页…');
    const page = await pdf.getPage(pageNo);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(2.2, 2200 / Math.max(base.width, base.height));
    const viewport = page.getViewport({ scale: Math.max(1, scale) });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const context = canvas.getContext('2d', { alpha: false });
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: context, viewport }).promise;
    const blob = await new Promise((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error('PDF 页面转换图片失败')), 'image/png'));
    canvas.width = 0; canvas.height = 0;
    try {
      const result = await recognizeRosterPhoto(blob, (message) => onProgress?.('第 ' + pageNo + ' 页：' + message), null, gradeHint);
      const pageRows = (Array.isArray(result.rows) && result.rows.length ? result.rows : (result.pairs || []))
        .filter((row) => row && (row.name || row.subject || row.serial));
      allRows.push(...pageRows.map((row) => ({ ...row, grade: gradeHint, department: '', sourcePage: pageNo })));
    } catch (error) {
      warnings.push('第 ' + pageNo + ' 页未能可靠识别：' + (error.message || '请检查原图'));
    }
  }
  if (!allRows.length) throw new Error('PDF 中没有识别到可靠的姓名+学科记录。请上传清晰扫描件，或使用 Excel 导入。');
  return { rows: markFileDuplicates(allRows), warnings, grade: gradeHint, pageCount: pdf.numPages };
}

export async function parseRosterText(text, gradeHint = '') {
  const grid = readDelimited(String(text || ''), '\t');
  const result = parseRosterSheets([{ name: '粘贴内容', rows: grid }], gradeHint);
  return { ...result, sourceName: '粘贴内容' };
}

export async function parseRosterFile(file, gradeHint = '', onProgress = () => {}) {
  if (!file) throw new Error('请先选择文件');
  const name = String(file.name || '名单文件');
  const ext = (name.split('.').pop() || '').toLowerCase();
  let result;
  if (['xlsx', 'xlsm'].includes(ext)) {
    onProgress('正在读取 Excel 工作表…');
    const workbook = await readXlsx(file);
    result = parseRosterSheets(workbook.sheets, gradeHint);
  } else if (ext === 'xls') {
    onProgress('正在读取旧版 Excel 文件…');
    result = parseRosterSheets(await readLegacyXls(file), gradeHint);
  } else if (['csv', 'tsv', 'txt'].includes(ext)) {
    onProgress('正在读取表格文本…');
    const grid = readDelimited(await file.text());
    result = parseRosterSheets([{ name, rows: grid }], gradeHint);
  } else if (ext === 'pdf' || file.type === 'application/pdf') {
    result = await recognizePdf(file, gradeHint, onProgress);
  } else if (/^image\/(png|jpe?g|webp)$/i.test(file.type) || /\.(png|jpe?g|webp)$/i.test(name)) {
    const { recognizeRosterPhoto } = await import('./ocr.js');
    onProgress('正在启动中文图片识别…');
    const recognized = await recognizeRosterPhoto(file, onProgress, null, gradeHint);
    // Keep the complete review grid; do not silently discard rows the OCR missed.
    const sourceRows = Array.isArray(recognized.rows) && recognized.rows.length ? recognized.rows : (recognized.pairs || []);
    const rows = sourceRows.filter((row) => row && (row.name || row.subject || row.serial));
    const recognizedCount = Number.isFinite(Number(recognized.recognizedCount))
      ? Number(recognized.recognizedCount)
      : rows.filter((row) => row.name && row.subject).length;
    const expectedCount = Number(recognized.expectedCount) || rows.length;
    const warnings = [...(recognized.warnings || [])];
    if (expectedCount && recognizedCount < expectedCount) {
      warnings.push('图片识别到 ' + recognizedCount + ' / ' + expectedCount + ' 条完整记录；未识别的行已保留，请逐项补全或选择跳过。');
    }
    result = {
      ok: true, grade: gradeHint, rows: markFileDuplicates(rows), warnings,
      confidence: recognized.confidence, recognizedCount, expectedCount,
    };
  } else {
    throw new Error('暂不支持该文件格式。请选择 Excel、CSV、PDF、JPG 或 PNG。');
  }
  return { ...result, sourceName: name };
}
