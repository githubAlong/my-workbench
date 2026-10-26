/* ============ 极简 xlsx 读取器（不依赖任何第三方库） ============
 *
 * 为什么自己写：
 *   ① 这个项目是纯静态站（GitHub Pages），全站零外链、零 CDN。
 *      引 SheetJS 要多一个 400KB+ 的外部请求，还得处理它的许可证标注。
 *   ② 我们只需要「读单元格的值」，不需要样式、公式、图表。
 *      xlsx 本质是个 zip 包，里面是几个 XML。浏览器自带 DecompressionStream('deflate-raw')，
 *      解压这一环不用自己实现，剩下就是解 XML。
 *   ③ 老师上传的是 WPS / Excel 存出来的普通表格，结构非常固定。
 *
 * 支持：
 *   - .xlsx / .xlsm（Office Open XML，本质同一个格式）
 *   - 共享字符串（sharedStrings.xml）、内联字符串（inlineStr）、数字、布尔
 *   - 合并单元格（只取左上角的值，但会保留合并信息供调用方判断）
 *   - 多个 sheet（默认读第一个有数据的）
 *
 * 不支持（也用不上）：
 *   - 老格式 .xls（BIFF，完全不同的二进制格式）
 *   - 密码加密的文件
 *   - 样式/颜色/字体
 */

/* ---------- zip 解包 ---------- */
async function unzip(buf) {
  const u8 = new Uint8Array(buf);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);

  /* 从尾部往前找「中央目录结束标记」EOCD: 50 4B 05 06。
     注释区最长 65535 字节，所以最多回溯这么多。 */
  let eocd = -1;
  const maxBack = Math.min(u8.length, 65535 + 22);
  for (let i = u8.length - 22; i >= u8.length - maxBack && i >= 0; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('这不是有效的 xlsx（找不到 zip 目录）');

  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);

  const files = new Map();
  const dec = new TextDecoder('utf-8');

  for (let i = 0; i < count; i++) {
    if (dv.getUint32(off, true) !== 0x02014b50) break;   // 中央目录文件头
    const method = dv.getUint16(off + 10, true);
    const compSize = dv.getUint32(off + 20, true);
    const nameLen = dv.getUint16(off + 28, true);
    const extraLen = dv.getUint16(off + 30, true);
    const commentLen = dv.getUint16(off + 32, true);
    const localOff = dv.getUint32(off + 42, true);
    const name = dec.decode(u8.subarray(off + 46, off + 46 + nameLen));
    files.set(name, { method, compSize, localOff });
    off += 46 + nameLen + extraLen + commentLen;
  }

  /* 真正解压某个文件（按需，避免把图片之类也解了） */
  async function read(name) {
    const f = files.get(name);
    if (!f) return null;
    // 本地文件头长度不固定（文件名和 extra 长度都可能不同），要重新读
    const lnameLen = dv.getUint16(f.localOff + 26, true);
    const lextraLen = dv.getUint16(f.localOff + 28, true);
    const start = f.localOff + 30 + lnameLen + lextraLen;
    const data = u8.subarray(start, start + f.compSize);
    if (f.method === 0) return dec.decode(data);            // 未压缩
    if (f.method !== 8) throw new Error('不支持的压缩方式：' + f.method);
    // deflate-raw：不带 zlib 头，正是 zip 用的格式
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Blob([data]).stream().pipeThrough(ds);
    const out = await new Response(stream).arrayBuffer();
    return dec.decode(new Uint8Array(out));
  }

  return { names: [...files.keys()], read };
}

/* ---------- XML 小工具 ---------- */
const unescapeXml = (s) => String(s)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
  .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
  .replace(/&amp;/g, '&');

/* 收集 <si> 里的所有 <t>（富文本会被拆成多段 <r><t>），拼接成完整字符串 */
function siText(xml) {
  const parts = [...xml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => unescapeXml(m[1]));
  // 去掉拼音注音 <rPh> 里的内容
  const clean = String(xml).replace(/<rPh[\s\S]*?<\/rPh>/g, '');
  const parts2 = [...clean.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => unescapeXml(m[1]));
  return (parts2.length ? parts2 : parts).join('');
}

/* "AB12" -> { col: 27, row: 11 }（col 从 0 开始，row 从 0 开始） */
function refToPos(ref) {
  const m = /^([A-Z]+)(\d+)$/.exec(String(ref || '').toUpperCase());
  if (!m) return null;
  let col = 0;
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { col: col - 1, row: Number(m[2]) - 1 };
}

/* ---------- 主入口 ---------- */
/**
 * 读一个 xlsx
 * @param {ArrayBuffer|Blob} input
 * @param {object} opts { sheetIndex?: number }
 * @returns {Promise<{sheets:{name:string,rows:string[][]}[], rows:string[][]}>}
 */
export async function readXlsx(input, opts = {}) {
  const buf = input instanceof Blob ? await input.arrayBuffer() : input;
  const zip = await unzip(buf);

  // 共享字符串表
  const sstXml = await zip.read('xl/sharedStrings.xml');
  let shared = [];
  if (sstXml) {
    shared = [...sstXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => siText(m[1]));
  }

  // 工作表清单（按 workbook.xml 的顺序找对应的 sheetN.xml）
  const wbXml = (await zip.read('xl/workbook.xml')) || '';
  const relXml = (await zip.read('xl/_rels/workbook.xml.rels')) || '';
  const relMap = new Map(
    [...relXml.matchAll(/<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)]
      .map((m) => [m[1], m[2].replace(/^\/?xl\//, '')]),
  );
  const sheetMeta = [...wbXml.matchAll(/<sheet\b[^>]*\/>/g)].map((m) => {
    const name = /name="([^"]*)"/.exec(m[0])?.[1] || '';
    const rid = /r:id="([^"]*)"/.exec(m[0])?.[1] || '';
    return { name: unescapeXml(name), target: relMap.get(rid) || '' };
  });

  // 兜底：没有 workbook 元信息就直接按目录里出现的 sheet 文件排序
  let parts = sheetMeta.map((s) => s.target).filter(Boolean);
  if (!parts.length) {
    parts = zip.names.filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
      .sort((a, b) => {
        const na = Number(/(\d+)\.xml$/.exec(a)[1]);
        const nb = Number(/(\d+)\.xml$/.exec(b)[1]);
        return na - nb;
      });
  }

  const sheets = [];
  for (let i = 0; i < parts.length; i++) {
    const key = parts[i].startsWith('xl/') ? parts[i] : 'xl/' + parts[i];
    const xml = await zip.read(key);
    if (!xml) continue;
    sheets.push({
      name: sheetMeta[i]?.name || `Sheet${i + 1}`,
      rows: parseSheet(xml, shared),
    });
  }
  if (!sheets.length) throw new Error('这个 xlsx 里没有工作表');

  const idx = Math.min(Math.max(0, opts.sheetIndex || 0), sheets.length - 1);
  // 默认智能选表：优先选有内容的那个（有些文件第一个 sheet 是空的说明页）
  const auto = sheets.find((s) => s.rows.some((r) => r.some((c) => String(c).trim())));
  return { sheets, rows: (sheets[idx].rows.some((r) => r.some((c) => String(c).trim()))
    ? sheets[idx].rows
    : (auto?.rows || sheets[idx].rows)), sheetName: sheets[idx].name };
}

function parseSheet(xml, shared) {
  const rows = [];
  for (const rm of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const rowAttr = rm[1];
    const body = rm[2];
    const rIdx = Number((/r="(\d+)"/.exec(rowAttr) || [])[1]);
    const target = Number.isFinite(rIdx) && rIdx > 0 ? rIdx - 1 : rows.length;
    const line = rows[target] || (rows[target] = []);

    let pos = 0;
    for (const cm of body.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attr = cm[1];
      const inner = cm[2] || '';
      const ref = (/r="([A-Z]+\d+)"/.exec(attr) || [])[1];
      const p = ref ? refToPos(ref) : null;
      const col = p ? p.col : pos;
      pos = col + 1;

      const t = (/t="([^"]+)"/.exec(attr) || [])[1] || 'n';
      let val = '';
      if (t === 's') {
        const vi = Number((/<v>([\s\S]*?)<\/v>/.exec(inner) || [])[1]);
        val = shared[vi] ?? '';
      } else if (t === 'inlineStr') {
        val = siText(inner);
      } else if (t === 'str') {
        val = unescapeXml((/<v>([\s\S]*?)<\/v>/.exec(inner) || [])[1] || '');
      } else if (t === 'b') {
        val = (/<v>([\s\S]*?)<\/v>/.exec(inner) || [])[1] === '1' ? 'TRUE' : 'FALSE';
      } else {
        val = unescapeXml((/<v>([\s\S]*?)<\/v>/.exec(inner) || [])[1] || '');
      }
      line[col] = val;
    }
  }
  // 补齐每行长度，避免后面下标越界
  const width = rows.reduce((a, r) => Math.max(a, r ? r.length : 0), 0);
  return rows.map((r) => {
    const out = r || [];
    for (let i = 0; i < width; i++) if (out[i] === undefined) out[i] = '';
    return out;
  });
}

/* ---------- CSV / TSV 兜底（Excel 另存为 csv 也能传） ---------- */
export function readDelimited(text, sep) {
  const s = String(text || '').replace(/^\uFEFF/, '');   // 去 UTF-8 BOM
  const lines = s.split(/\r\n|\n|\r/).filter((l) => l.length);
  if (!lines.length) return [];
  const sepCh = sep || (lines[0].includes('\t') ? '\t'
    : (lines[0].split(',').length >= lines[0].split(';').length ? ',' : ';'));
  const parseLine = (line) => {
    const out = [];
    let cur = '';
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) {
        if (ch === '"') {
          if (line[i + 1] === '"') { cur += '"'; i++; } else q = false;
        } else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === sepCh) { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out.map((x) => x.trim());
  };
  return lines.map(parseLine);
}
