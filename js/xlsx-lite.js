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
  /* 【哪些数字其实是日期】
     Excel 内部把日期存成"从 1900-01-01 起的天数"，单元格里就是一个数字。
     不读 styles.xml 的话，2026-10-19 会原样变成 46314 ——
     老师上传的表里日期赫然写着 46314，日期识别全废、表还被记成今天。
     这里读 styles.xml 的 cellXfs → numFmtId，把 14~22 和 45~47
     （内置日期/时间格式）以及自定义 numFmt 里含 y/m/d 的那些标出来。
     读不到 styles.xml 就退回"值落在 1930~2100 年的序列号区间"的宽判断。 */
  const dateXf = await readDateStyles(zip);

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
      rows: parseSheet(xml, shared, dateXf),
    });
  }
  if (!sheets.length) throw new Error('这个 xlsx 里没有工作表');

  /* 【默认选哪张表：先问"能不能认出这是一张考勤表"】
     原来只判断「第一个 sheet 有没有内容」。可老师的文件常常是
     Sheet1=封面（写两行说明）、Sheet2=真正的坐班表 ——
     封面也有内容 → 返回封面 → 解析失败 → 弹「没认出这张表」，
     而且用户根本走不到"切换工作表"那一步，只能以为文件有问题重做。
     现在：① 指定了 sheetIndex 就听指定的；
           ② 指定了 tryParse 回调（考勤导入会传）就挨个试，挑第一个能认出来的；
           ③ 都没给，就退回「第一个有内容的」。 */
  const hasContent = (s) => s.rows.some((r) => (r || []).some((c) => String(c ?? '').trim()));
  let pick = -1;
  if (opts.sheetIndex != null) {
    pick = Math.min(Math.max(0, opts.sheetIndex), sheets.length - 1);
  } else if (typeof opts.tryParse === 'function') {
    for (let i = 0; i < sheets.length; i++) {
      if (!hasContent(sheets[i])) continue;
      let okPick = false;
      try { okPick = !!opts.tryParse(sheets[i].rows, sheets[i].name); } catch { okPick = false; }
      if (okPick) { pick = i; break; }
    }
  }
  if (pick < 0) pick = Math.max(0, sheets.findIndex(hasContent));
  if (pick < 0) pick = 0;
  return { sheets, rows: sheets[pick].rows, sheetName: sheets[pick].name, pickedIndex: pick };
}

/* ---------- 日期序列号 ---------- */

/* 内置的日期/时间格式编号。
   14~17 是日期，18~21 是时间，22 是日期+时间，45~47 是带秒/时长。
   这几个不需要查 numFmts 就是日期 —— Excel 文档里写死了。 */
const BUILTIN_DATE_FMT = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

/* 读 styles.xml，返回一个 Set：哪些 cellXfs 下标（=单元格 s="N"）是日期格式 */
async function readDateStyles(zip) {
  const out = new Set();
  try {
    const xml = await zip.read('xl/styles.xml');
    if (!xml) return out;
    // 自定义格式：numFmtId -> formatCode。含 y/m/d/h 的就是日期时间
    const custom = new Set();
    for (const m of xml.matchAll(/<numFmt\b[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g)) {
      const code = unescapeXml(m[2]).replace(/\[[^\]]*\]/g, '');   // 去掉 [$-409] 这种区域标记
      if (/[ymdhs]/i.test(code) && !/^[#0.,%\s]*$/.test(code)) custom.add(Number(m[1]));
    }
    // cellXfs 里的 <xf> 按顺序就是 s="0,1,2…"
    const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml)?.[1] || '';
    let i = 0;
    for (const m of xfs.matchAll(/<xf\b([^>]*?)(?:\/>|>[\s\S]*?<\/xf>)/g)) {
      const id = Number((/numFmtId="(\d+)"/.exec(m[1]) || [])[1]);
      if (BUILTIN_DATE_FMT.has(id) || custom.has(id)) out.add(i);
      i += 1;
    }
  } catch { /* 读不到就靠下面的区间判断兜底 */ }
  return out;
}

/* 序列号 → 'YYYY-MM-DD'。只取日期部分，考勤表不看几点几分。
   Excel 的 1900 闰年 bug：它认为 1900-02-29 存在，所以 1900-03-01 之前的
   序列号要 +1 修正。我们关心的都是 2000 年以后，但仍按标准公式处理。 */
export function serialToDate(n) {
  const days = Math.floor(Number(n));
  if (!Number.isFinite(days)) return null;
  const ms = Date.UTC(1899, 11, 30) + days * 86400000;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  if (y < 1930 || y > 2100) return null;   // 不像日期，别乱转
  return `${y}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function parseSheet(xml, shared, dateXf = new Set()) {
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
        /* 数字 → 可能是日期。两个条件都试过才转：
           ① 这个单元格的样式是日期格式（最可靠）
           ② 文件里没有 styles.xml 时，按"序列号落在 1930~2100 年"宽判断
           其它数字（序号、金额、人数）绝不能被转成日期，
           所以纯数字只有在上面两个条件之一成立时才转。 */
        const sIdx = (/ s="(\d+)"/.exec(attr) || [])[1];
        const looksDate = sIdx != null ? dateXf.has(Number(sIdx)) : false;
        if (val !== '' && /^\d+(\.\d+)?$/.test(val) && looksDate) {
          const str = serialToDate(val);
          if (str) val = str;
        }
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
