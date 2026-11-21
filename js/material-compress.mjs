/* 教材大文件压缩（全在浏览器里做，不上传、不落盘到第三方）。

   为什么是「把文件压小」而不是「分片上传」：
   Supabase 的单文件上限是套餐级的（Free 项目 50MB），标准上传、断点续传(TUS)、
   S3 直传都受同一个上限约束 —— 分片只能让大文件传得更稳，不能突破上限。
   所以超过上限的文件只有两条路：变小，或者升级套餐。这里做变小。

   能压的只有图片。PPT/Word/Excel（以及 WPS 的 .dps/.et/.wps 里那些本质是 zip 的）
   体积几乎全在包内 media 目录里的图片上，其余 XML 条目原样搬走，一个字节都不重编。
   视频、音频浏览器转码不了，PDF 重排风险太大，一律如实报「压不动」而不是硬试。

   【一条不能破的规矩】媒体条目只改内容，不改名字和扩展名。
   OOXML 用 rels 里的 Target="../media/image3.png" 引用图片，
   改名（png→jpg）会让引用指空，PowerPoint 直接报文件损坏；
   留着 .png 的名字却塞 JPEG 字节同样是在赌播放器的嗅探逻辑。
   所以：.png 只能重编码成 PNG（靠降尺寸变小），.jpg 才走质量参数，
   .gif 跳过（重编码会丢掉动画），.bmp/.tif 跳过（canvas 编不出来）。 */

export const MATERIAL_MAX_BYTES = 50 * 1048576;

/* 三档，从保守到激进，压到上限内就立刻收手，不再多降一档。 */
const LADDER = [
  { maxDim: 1920, quality: 0.82 },
  { maxDim: 1536, quality: 0.72 },
  { maxDim: 1280, quality: 0.6 },
];

const KEEP_AS_IS = /\.(gif|bmp|tif|tiff|mp4|m4v|mov|avi|wmv|mp3|m4a|wav|wma)$/i;

const sameFormatType = (name) => /\.png$/i.test(name) ? 'image/png'
  : /\.(jpe?g)$/i.test(name) ? 'image/jpeg'
    : /\.webp$/i.test(name) ? 'image/webp' : '';

const mediaImage = (name) => /(^|\/)media\/[^/]+\.(png|jpe?g|webp)$/i.test(name);

const byteLenOf = (value) => (value && typeof value.size === 'number' ? value.size
  : (value && value.byteLength !== undefined ? value.byteLength : 0));

/* 服务端拒绝里哪些是「太大了」：状态码优先，其次认 Supabase Storage 的措辞。
   这一句是自动压缩的兜底触发条件 —— 客户端算的上限可能和套餐实际值不一致。 */
export function looksLikeSizeRejection(status, message) {
  if (Number(status) === 413) return true;
  return /size|too large|largest|超过|上限|file_size_limit/i.test(String(message || ''));
}

/* ---------- zip 读写 ---------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

export async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function deflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export function isZipContainer(bytes) {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4B && bytes[2] === 3 && bytes[3] === 4;
}

function findEocd(dv, u8) {
  const floor = Math.max(0, u8.length - 65536 - 22);
  for (let i = u8.length - 22; i >= floor; i--) {
    if (dv.getUint32(i, true) === 0x06054B50) {
      return { count: dv.getUint16(i + 10, true), dirOff: dv.getUint32(i + 16, true) };
    }
  }
  return null;
}

/* 只读中央目录；数据用 subarray 视图指过去，不复制，67MB 的包也只占一份内存。 */
export function readZipEntries(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const eocd = findEocd(dv, u8);
  if (!eocd) throw new Error('读不到 zip 目录');
  const dec = new TextDecoder('utf-8');
  const entries = [];
  let off = eocd.dirOff;
  for (let i = 0; i < eocd.count; i++) {
    if (dv.getUint32(off, true) !== 0x02014B50) break;
    const entry = {
      flags: dv.getUint16(off + 8, true),
      method: dv.getUint16(off + 10, true),
      dosTime: dv.getUint16(off + 12, true),
      dosDate: dv.getUint16(off + 14, true),
      crc: dv.getUint32(off + 16, true),
      compSize: dv.getUint32(off + 20, true),
      size: dv.getUint32(off + 24, true),
      external: dv.getUint32(off + 38, true),
    };
    const nameLen = dv.getUint16(off + 28, true);
    const extraLen = dv.getUint16(off + 30, true);
    const commentLen = dv.getUint16(off + 32, true);
    const localOff = dv.getUint32(off + 42, true);
    entry.name = dec.decode(u8.subarray(off + 46, off + 46 + nameLen));
    if (entry.compSize === 0xFFFFFFFF || entry.size === 0xFFFFFFFF || eocd.dirOff === 0xFFFFFFFF) {
      throw new Error('这个包用了 zip64，不重压');
    }
    /* 本地头里的名字和 extra 长度可能和中央目录不一样，得按本地头重新定位数据 */
    const start = localOff + 30 + dv.getUint16(localOff + 26, true) + dv.getUint16(localOff + 28, true);
    entry.data = u8.subarray(start, start + entry.compSize);
    entries.push(entry);
    off += 46 + nameLen + extraLen + commentLen;
  }
  if (!entries.length) throw new Error('zip 里没有条目');
  return entries;
}

async function packEntry(entry) {
  if (!entry.plain) return { ...entry, bytes: entry.data };
  const raw = entry.plain;
  const crc = crc32(raw);
  const deflated = await deflateRaw(raw);
  /* 已经压不动的（音视频、现成的 JPEG）直接 store：省一次解压再压缩的白工 */
  if (deflated.length >= raw.length) return { ...entry, plain: null, crc, size: raw.length, compSize: raw.length, method: 0, bytes: raw };
  return { ...entry, plain: null, crc, size: raw.length, compSize: deflated.length, method: 8, bytes: deflated };
}

export async function writeZipBlob(entries) {
  const enc = new TextEncoder();
  const parts = [];
  const centrals = [];
  let offset = 0;
  /* 头写在一个复用的 ArrayBuffer 上，但推进 Blob 的必须是每轮拷出来的副本：
     直接塞视图的话，所有条目都会指向最后写进去的那一份，整个包塌成一个文件。 */
  const copy = (view) => new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
  const local = new DataView(new ArrayBuffer(30));
  const central = new DataView(new ArrayBuffer(46));
  for (const source of entries) {
    const entry = await packEntry(source);
    const name = enc.encode(entry.name);
    local.setUint32(0, 0x04034B50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, entry.flags, true);
    local.setUint16(8, entry.method, true);
    local.setUint16(10, entry.dosTime, true);
    local.setUint16(12, entry.dosDate, true);
    local.setUint32(14, entry.crc, true);
    local.setUint32(18, entry.compSize, true);
    local.setUint32(22, entry.size, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    parts.push(copy(local), name, entry.bytes);

    central.setUint32(0, 0x02014B50, true);
    central.setUint16(4, 20, true);
    central.setUint16(6, 20, true);
    central.setUint16(8, entry.flags, true);
    central.setUint16(10, entry.method, true);
    central.setUint16(12, entry.dosTime, true);
    central.setUint16(14, entry.dosDate, true);
    central.setUint32(16, entry.crc, true);
    central.setUint32(20, entry.compSize, true);
    central.setUint32(24, entry.size, true);
    central.setUint16(28, name.length, true);
    central.setUint16(30, 0, true);
    central.setUint16(32, 0, true);
    central.setUint16(34, 0, true);
    central.setUint16(36, 0, true);
    central.setUint32(38, entry.external, true);
    central.setUint32(42, offset, true);
    centrals.push(copy(central), name);

    offset += 30 + name.length + entry.compSize;
  }
  const dirSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054B50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, dirSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...centrals, copy(end)], { type: 'application/zip' });
}

/* 重建完必须回读验一遍：传上去一个打不开的 pptx，比传不上去更糟。 */
async function verifyZipBlob(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const entries = readZipEntries(bytes);
  const types = entries.find((entry) => entry.name === '[Content_Types].xml');
  if (!types) throw new Error('压缩后丢了 [Content_Types].xml');
  if (types.method === 8) await inflateRaw(types.data);
  return entries.length;
}

/* ---------- 图片重编码 ---------- */

async function browserDecodeImage(bytes, type, { maxDim, quality }) {
  const bitmap = await createImageBitmap(new Blob([bytes], { type }));
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();
  const out = await canvas.convertToBlob({ type, quality });
  return new Uint8Array(await out.arrayBuffer());
}

/* ---------- 主入口 ---------- */

const mb = (bytes) => (bytes / 1048576).toFixed(1) + 'MB';

/* 报错就要说清「哪几大块占着体积」：只说「太大了」，老师还是不知道该删什么。 */
function overLimit(message, detail) {
  const list = (detail || []).filter(Boolean);
  return Object.assign(new Error(list.length ? `${message}：${list.join('，')}` : message),
    { code: 'material_over_limit', detail: list });
}

function biggestEntries(entries) {
  return [...entries]
    .sort((a, b) => b.compSize - a.compSize)
    .slice(0, 3)
    .map((entry) => `${entry.name} ${mb(entry.compSize)}`);
}

async function recompressEntries(entries, rung, decodeImage) {
  /* 每一档都从原始条目重新出发：在上一档的结果上再降一次尺寸，
     等于把同一张图反复重编码，糊得越来越快，白白损失画质。 */
  const next = [];
  let changed = 0;
  for (const entry of entries) {
    const type = mediaImage(entry.name) && !KEEP_AS_IS.test(entry.name) ? sameFormatType(entry.name) : '';
    if (!type) { next.push(entry); continue; }
    const raw = entry.method === 8 ? await inflateRaw(entry.data) : entry.data;
    let smaller = null;
    try {
      const encoded = await decodeImage(raw, type, rung);
      if (encoded && encoded.length && encoded.length < raw.length) smaller = encoded;
    } catch {
      // 解不开的图（异常编码、损坏）跳过，不能让整个文件传不了
    }
    if (!smaller) { next.push(entry); continue; }
    changed += 1;
    next.push({ ...entry, plain: smaller });
  }
  return { entries: next, changed };
}

async function shrinkZipFile(bytes, { limit, decodeImage, onStage }) {
  const entries = readZipEntries(bytes);
  let best = null;
  for (let i = 0; i < LADDER.length; i++) {
    onStage?.(`正在压缩图片（第 ${i + 1} 档，共 ${LADDER.length} 档）…`);
    const pass = await recompressEntries(entries, LADDER[i], decodeImage);
    if (!pass.changed) {
      if (i === 0) throw overLimit('这个文件里没有能压的图片', biggestEntries(entries));
      continue;
    }
    const blob = await writeZipBlob(pass.entries);
    if (blob.size <= limit) {
      await verifyZipBlob(blob);
      return { data: blob, size: blob.size, compressed: true };
    }
    if (!best || blob.size < best.size) best = { blob, size: blob.size };
  }
  throw overLimit('压到最低档还是超上限', best
    ? [`压缩后 ${mb(best.size)}`, ...biggestEntries(entries)]
    : biggestEntries(entries));
}

async function shrinkPlainImage(bytes, type, { limit, decodeImage }) {
  for (const rung of LADDER) {
    const encoded = await decodeImage(bytes, type, rung);
    if (encoded && encoded.length && encoded.length < bytes.length) {
      const blob = new Blob([encoded], { type });
      if (blob.size <= limit) return { data: blob, size: blob.size, compressed: true };
    }
  }
  throw overLimit('图片压到最低档还是超上限', [`原文件 ${mb(bytes.length)}`]);
}

/* file 是上传链路里的形状：{ filename, mime, data }。
   没超上限原样返回，一个字节都不动 —— 画质不该为它没用到的余量买单。
   force 用于「服务端说不行了」的兜底：项目全局上限可能被调得比这里低。 */
export async function shrinkOversizedFile(file, options = {}) {
  const limit = options.limit || MATERIAL_MAX_BYTES;
  const decodeImage = options.decodeImage || browserDecodeImage;
  const size = byteLenOf(file.data) || byteLenOf(file);
  if (!size || (size <= limit && !options.force)) return { data: file.data ?? file, size, compressed: false };
  if (typeof CompressionStream !== 'function' || typeof DecompressionStream !== 'function') {
    throw overLimit('这个浏览器压不了大文件', ['需要较新版本的 Chrome / Edge']);
  }
  const bytes = new Uint8Array(await new Blob([file.data ?? file]).arrayBuffer());
  const name = String(file.filename || '');
  if (isZipContainer(bytes)) {
    try {
      return await shrinkZipFile(bytes, { limit, decodeImage, onStage: options.onStage });
    } catch (error) {
      if (error.code === 'material_over_limit') throw error;
      throw overLimit('这个包结构我不敢重排', [String(error.message || error)]);
    }
  }
  const type = /\.(png|jpe?g|webp)$/i.test(name) ? sameFormatType(name) : '';
  if (type) return shrinkPlainImage(bytes, type, { limit, decodeImage });
  throw overLimit('这种格式浏览器压不动', [`${name || '文件'} ${mb(size)}`]);
}
