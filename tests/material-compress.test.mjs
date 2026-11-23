/* 教材超上限文件的自动压缩：真跑一遍 zip 拆包→重压图片→重建→回读。
   图片解码这一步注入假实现（Node 里没有 createImageBitmap），
   但 zip 的读写、CRC、条目取舍、档位阶梯和报错明细全是线上那份代码。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { deflateRawSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import {
  MATERIAL_MAX_BYTES, inflateRaw, isZipContainer, looksLikeSizeRejection,
  readZipEntries, shrinkOversizedFile,
} from '../js/material-compress.mjs';

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (const byte of bytes) c = crcTable[(c ^ byte) & 255] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
/* 随机字节：deflate 压不动它，正好模拟包里已经压缩过的 JPEG / 视频 */
const noise = (length) => randomBytes(length);
function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, raw] of Object.entries(entries)) {
    const n = Buffer.from(name);
    const compressed = deflateRawSync(raw);
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(n.length, 26);
    locals.push(local, n, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(n.length, 28); central.writeUInt32LE(offset, 42);
    centrals.push(central, n);
    offset += local.length + n.length + compressed.length;
  }
  const center = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10); end.writeUInt32LE(center.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, center, end]);
}

const RELS = '<Relationships><Relationship Id="rId3" Target="../media/image1.png"/></Relationships>';
const CONTENT_TYPES = '<Types><Default Extension="png" ContentType="image/png"/></Types>';
function deck() {
  return zip({
    '[Content_Types].xml': Buffer.from(CONTENT_TYPES),
    'ppt/presentation.xml': Buffer.from('<presentation/>'),
    'ppt/slides/_rels/slide1.xml.rels': Buffer.from(RELS),
    'ppt/media/image1.png': noise(300000),
    'ppt/media/media1.mp4': noise(120000),
  });
}
const bytesOf = async (blob) => new Uint8Array(await blob.arrayBuffer());
const entryOf = (entries, name) => entries.find((entry) => entry.name === name);
const rawOf = async (entry) => (entry.method === 8 ? await inflateRaw(entry.data) : entry.data);
/* 测试这边造的是 Buffer、模块产出的是 Uint8Array，内容一样但 deepStrictEqual 认原型 */
const sameBytes = (a, b) => Buffer.from(a).equals(Buffer.from(b));
const textOf = async (entry) => new TextDecoder().decode(await rawOf(entry));
/* 假解码器：按档位把图片字节砍短，够小就停 —— 阶梯逻辑走的还是真代码 */
const fakeDecode = async (raw, type, rung) => {
  assert.match(type, /^image\/(png|jpeg|webp)$/, '只该把可重编码的图片交给解码器');
  const ratio = rung.maxDim === 1920 ? 0.6 : 0.12;
  return raw.slice(0, Math.floor(raw.length * ratio));
};

test('超上限的 PPT 包：只重压 media 里的图片，其余条目字节不动', async () => {
  const source = deck();
  const file = { filename: '课件.pptx', mime: 'application/vnd.openxmlformats', data: new Blob([source]) };
  const shrunk = await shrinkOversizedFile(file, { limit: 200000, decodeImage: fakeDecode });
  assert.equal(shrunk.compressed, true);
  assert.ok(shrunk.size <= 200000, `压完 ${shrunk.size} 还在上限外`);

  const out = readZipEntries(await bytesOf(shrunk.data));
  /* 引用靠名字：改名（png→jpg）会让 rels 指空，PowerPoint 直接报损坏 */
  assert.deepEqual(out.map((entry) => entry.name).sort(),
    Object.keys({ '[Content_Types].xml': 1, 'ppt/presentation.xml': 1, 'ppt/slides/_rels/slide1.xml.rels': 1, 'ppt/media/image1.png': 1, 'ppt/media/media1.mp4': 1 }).sort());
  assert.equal(await textOf(entryOf(out, '[Content_Types].xml')), CONTENT_TYPES);
  assert.equal(await textOf(entryOf(out, 'ppt/slides/_rels/slide1.xml.rels')), RELS);
  /* 没被重编码的条目连压缩字节都原样搬走，不重新压一遍 */
  const before = readZipEntries(source);
  assert.ok(sameBytes(entryOf(out, 'ppt/media/media1.mp4').data, entryOf(before, 'ppt/media/media1.mp4').data));
  /* 图片条目换成了假解码器的产物：第一档（0.6）还压不进 200000，
     所以停在第二档（0.12）—— 这条同时证明档位是逐档加码、不是一步到底 */
  const image = entryOf(out, 'ppt/media/image1.png');
  const original = await rawOf(entryOf(before, 'ppt/media/image1.png'));
  assert.equal(original.length, 300000);
  assert.deepEqual(await rawOf(image), await fakeDecode(original, 'image/png', { maxDim: 1536 }));
});

test('重建的包每个条目 CRC 都对得上（PowerPoint 会校验，错了就是打不开）', async () => {
  const file = { filename: '课件.pptx', mime: 'application/vnd.openxmlformats', data: new Blob([deck()]) };
  const shrunk = await shrinkOversizedFile(file, { limit: 200000, decodeImage: fakeDecode });
  for (const entry of readZipEntries(await bytesOf(shrunk.data))) {
    const raw = entry.method === 8 ? await inflateRaw(entry.data) : entry.data;
    assert.equal(entry.crc, crc32(raw), `${entry.name} 的 CRC 不对`);
    assert.equal(entry.size, raw.length, `${entry.name} 的原始大小不对`);
    assert.equal(entry.compSize, entry.data.length, `${entry.name} 的压缩大小不对`);
  }
});

test('压到最低档还是超上限时，报出最大的几块是什么，而不是「请检查网络」', async () => {
  const file = { filename: '课件.pptx', mime: 'application/vnd.openxmlformats', data: new Blob([deck()]) };
  /* 解码器几乎不省：三档都试完仍在上限外 */
  await assert.rejects(
    () => shrinkOversizedFile(file, { limit: 200000, decodeImage: async (raw) => raw.slice(0, Math.floor(raw.length * 0.95)) }),
    (error) => {
      assert.equal(error.code, 'material_over_limit');
      assert.match(error.message, /压到最低档还是超上限/);
      assert.match(error.message, /media1\.mp4/);
      assert.match(error.message, /MB/);
      return true;
    },
  );
});

test('包里根本没有可压的图片就直接说清楚，不白跑三档', async () => {
  const onlyVideo = zip({ '[Content_Types].xml': Buffer.from(CONTENT_TYPES), 'ppt/media/media1.mp4': noise(400000) });
  const file = { filename: '课件.pptx', mime: 'application/vnd.openxmlformats', data: new Blob([onlyVideo]) };
  await assert.rejects(
    () => shrinkOversizedFile(file, { limit: 200000, decodeImage: fakeDecode }),
    (error) => {
      assert.match(error.message, /没有能压的图片/);
      assert.match(error.message, /media1\.mp4/);
      return true;
    },
  );
});

test('视频、PDF 这类压不动的格式如实报，不改口成网络问题', async () => {
  const file = { filename: '录像.mp4', mime: 'video/mp4', data: new Blob([noise(300000)]) };
  await assert.rejects(
    () => shrinkOversizedFile(file, { limit: 200000, decodeImage: fakeDecode }),
    (error) => {
      assert.match(error.message, /压不动/);
      assert.match(error.message, /录像\.mp4/);
      return true;
    },
  );
});

test('没超上限的文件一个字节都不动，画质不为用不到的余量买单', async () => {
  const source = deck();
  const blob = new Blob([source]);
  const file = { filename: '课件.pptx', mime: 'application/vnd.openxmlformats', data: blob };
  const shrunk = await shrinkOversizedFile(file, { limit: blob.size + 1, decodeImage: fakeDecode });
  assert.equal(shrunk.compressed, false);
  assert.equal(shrunk.data, blob);
  assert.equal(MATERIAL_MAX_BYTES, 50 * 1048576, '上限写死成 Free 套餐的 50MB');
});

test('独立的图片文件也按同一套档位压，压完还是超限就报原大小', async () => {
  const big = new Blob([noise(300000)], { type: 'image/png' });
  const shrunk = await shrinkOversizedFile({ filename: '照片.png', mime: 'image/png', data: big }, { limit: 100000, decodeImage: fakeDecode });
  assert.ok(shrunk.size <= 100000);
  assert.equal(isZipContainer(await bytesOf(shrunk.data)), false, '独立图片不该被当包处理');
  await assert.rejects(
    () => shrinkOversizedFile({ filename: '照片.png', mime: 'image/png', data: big }, { limit: 100000, decodeImage: async (raw) => raw }),
    (error) => {
      assert.match(error.message, /图片压到最低档还是超上限/);
      return true;
    },
  );
});

test('服务端尺寸拒绝认得出来：413 和存储原话都算，权限错不算', () => {
  assert.equal(looksLikeSizeRejection(413, ''), true);
  assert.equal(looksLikeSizeRejection(502, 'PayloadTooLarge：The file is larger than the maximum allowed size'), true);
  assert.equal(looksLikeSizeRejection(502, '「a.pptx」云端拒绝（HTTP 403）：new row violates row-level security'), false);
  assert.equal(looksLikeSizeRejection(0, '连不上云端教材服务，请检查网络后重试'), false);
});

test('边缘函数把存储的真实状态码和原话透出来，不再统一说成网络问题', async () => {
  const handler = await readFile(new URL('../supabase/functions/material-sharing/handler.mjs', import.meta.url), 'utf8');
  assert.match(handler, /async function storageFailure/);
  assert.match(handler, /throw await storageFailure\(file\.name, response\)/);
  assert.match(handler, /return failure\(status, /, '状态码要原样透出去，客户端靠它判断是不是尺寸问题');
  assert.doesNotMatch(handler, /上传失败，请检查网络后重试/, '这句谎话已经删掉了');
});

test('上传链路先压再传，压缩进度有地方显示，界面不再写「不限大小」', async () => {
  const cloud = await readFile(new URL('../js/cloud.js', import.meta.url), 'utf8');
  const localapi = await readFile(new URL('../js/localapi.js', import.meta.url), 'utf8');
  const work = await readFile(new URL('../js/work.js', import.meta.url), 'utf8');
  const sw = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
  assert.match(cloud, /import \{ MATERIAL_MAX_BYTES, looksLikeSizeRejection, shrinkOversizedFile \} from '\.\/material-compress\.mjs'/);
  assert.match(cloud, /const prepared = await shrinkBeforeUpload\(file, onStage\)/);
  assert.match(cloud, /shrunk: prepared !== file/);
  assert.match(cloud, /if \(!shrunk && looksLikeSizeRejection\(error\.status, error\.message\)\)/, '服务端说太大时补压一次再传');
  assert.match(cloud, /attempts = attempt \+ 1/, '补压后要真有一次重传机会，不然循环直接结束');
  assert.match(localapi, /cloud\.uploadMaterialFiles\(files, ownerId, opts\?\.onProgress, opts\?\.onFileDone, opts\?\.onStage\)/);
  assert.match(work, /onStage: \(text\) => \{ upStage\.textContent = text; \}/);
  assert.match(work, /自动压小再传/);
  assert.doesNotMatch(work, /不限文件数量和大小/, '这句在 Free 套餐下是错的');
  assert.match(sw, /'\.\/js\/material-compress\.mjs'/, '新模块要进 Service Worker 清单，否则离线打不开');
});
