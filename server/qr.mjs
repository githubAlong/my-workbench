/* ============================ 二维码生成 ============================
 * 为什么自己写：本站是零依赖部署（node 内置模块 + 前端原生 JS），
 * 而「扫码登录」必须给出**真能被手机相机识别**的二维码。
 * 之前 ui.js 里的 drawQR() 是用伪随机数画的图案 —— 看着像二维码，
 * 扫上去什么反应都没有。那不是「扫码登录的简化实现」，
 * 那是一张骗人去扫的图，所以这次换成真编码器。
 *
 * 实现范围（够用即止，不做全规格）：
 *   - 字节模式（UTF-8），能编码任意 URL
 *   - 纠错等级 L / M（登录票据这种短内容用 L 就够，图案更稀疏更好扫）
 *   - 版本 1~10（最多 271 字节），远超一条登录链接所需
 *
 * 参照 ISO/IEC 18004。关键步骤：数据编码 → 分块加纠错码（Reed-Solomon）
 * → 交织 → 布置到矩阵 → 三条定位图形 + 定时图形 + 校正图形
 * → 选最优掩码（四种惩罚规则）→ 写格式信息。
 * ========================================================================= */

/* ---------- 版本容量表 ---------- */
/* 每个版本每个纠错等级：总码字数、数据码字数、分块数 */
const CAP = {
  1: { L: [26, 19, 1], M: [26, 16, 1] },
  2: { L: [44, 34, 1], M: [44, 28, 1] },
  3: { L: [70, 55, 1], M: [70, 44, 1] },
  4: { L: [100, 80, 1], M: [100, 64, 2] },
  5: { L: [134, 108, 1], M: [134, 86, 2] },
  6: { L: [172, 136, 2], M: [172, 108, 4] },
  7: { L: [196, 156, 2], M: [196, 124, 4] },
  8: { L: [242, 194, 2], M: [242, 154, 4] },
  9: { L: [292, 232, 2], M: [292, 182, 5] },
  10: { L: [346, 274, 2], M: [346, 216, 6] },
};
/* 每块纠错码字数：用 (总码字 - 数据码字) / 分块数 现算，不必另建表 */

const ALIGN = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};
const ECL_FORMAT_BITS = { L: 1, M: 0 };

/* ---------- GF(256) 与 Reed-Solomon ---------- */
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;   // 本原多项式 x^8+x^4+x^3+x^2+1
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();
const gmul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/* 生成多项式 ∏(x - α^i)，i = 0..degree-1 */
function rsPoly(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gmul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

/* 对一块数据算纠错码字 */
function rsEncode(data, ecLen) {
  const gen = rsPoly(ecLen);
  const buf = [...data, ...new Array(ecLen).fill(0)];
  for (let i = 0; i < data.length; i++) {
    const c = buf[i];
    if (!c) continue;
    for (let j = 0; j < gen.length; j++) buf[i + j] ^= gmul(gen[j], c);
  }
  return buf.slice(data.length);
}

/* ---------- 编码 ---------- */
function utf8Bytes(str) {
  return [...Buffer.from(String(str), 'utf8')];
}

function pickVersion(len, ecl) {
  for (let v = 1; v <= 10; v++) {
    const [, dataWords] = CAP[v][ecl];
    /* 字节模式头部：4 bit 模式 + 字符计数（v1~9 为 8 bit，v10 起 16 bit） */
    const headerBits = 4 + (v < 10 ? 8 : 16);
    if (len * 8 + headerBits <= dataWords * 8) return v;
  }
  throw new Error('内容太长，超出版本 10 的容量');
}

/* 把数据填成数据码字序列（含模式位、长度、终止符、填充） */
function buildDataCodewords(bytes, version, ecl) {
  const [, dataWords] = CAP[version][ecl];
  const bits = [];
  const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1); };

  push(0b0100, 4);                       // 字节模式
  push(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  // 终止符：最多 4 个 0
  for (let i = 0; i < 4 && bits.length < dataWords * 8; i++) bits.push(0);
  // 补齐到字节边界
  while (bits.length % 8 !== 0) bits.push(0);

  const out = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    out.push(b);
  }
  // 交替填充 0xEC / 0x11
  const PAD = [0xec, 0x11];
  for (let i = 0; out.length < dataWords; i++) out.push(PAD[i % 2]);
  return out;
}

/* 分块 + 纠错 + 交织 */
function interleave(dataWords, version, ecl) {
  const [totalWords, dataCount, blockCount] = CAP[version][ecl];
  /* 每块纠错码字数 = (总码字 - 数据码字) / 分块数。
     这里原来写成 Math.floor(... / CAP[v][ecl][2])，而 CAP[v][ecl][2] 就是 blockCount——
     等于除以块数两次，ecPerBlock 全算错。版本 1（只有 1 块）时碰巧不受影响，
     所以短内容一直是好的；一进版本 2 以上整张码就解不出来。 */
  const ecPerBlock = Math.floor((totalWords - dataCount) / blockCount);
  /* 分块：后面若干块多 1 个字（标准规定短块在前） */
  const shortLen = Math.floor(dataCount / blockCount);
  const numLong = dataCount % blockCount;

  const blocks = [];
  let pos = 0;
  for (let i = 0; i < blockCount; i++) {
    const len = shortLen + (i >= blockCount - numLong ? 1 : 0);
    const d = dataWords.slice(pos, pos + len);
    pos += len;
    blocks.push({ d, ec: rsEncode(d, ecPerBlock) });
  }

  const out = [];
  const maxD = Math.max(...blocks.map((b) => b.d.length));
  for (let i = 0; i < maxD; i++) {
    for (const b of blocks) if (i < b.d.length) out.push(b.d[i]);
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (const b of blocks) out.push(b.ec[i]);
  }
  return out;
}

/* ---------- 矩阵 ---------- */
/* 0/1 = 数据模块，null = 尚未决定，'F' = 功能图形（不参与掩码） */
function newMatrix(size) {
  return Array.from({ length: size }, () => new Array(size).fill(null));
}

function placeFinder(m, cx, cy) {
  /* 定位图形是 7×7，由外向内：黑(3 圈) → 白(1 圈) → 黑(3×3 实心)。
     用切比雪夫距离 d = max(|dx|,|dy|) 表达：
       d=3 → 黑（外框）
       d=2 → 白
       d<=1 → 黑（中心 3×3 实心块，占 offsets -1,0,1）
     这里原来写成 d<=1 为白、d===3 为黑，把中心的 3×3 挖空了，
     于是每个定位图形的正中央是个白洞——扫码器认不出定位点。
     加上分隔符（d=4 全白），整体 9×9。 */
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx; const y = cy + dy;
      if (x < 0 || y < 0 || x >= m.length || y >= m.length) continue;
      const d = Math.max(Math.abs(dx), Math.abs(dy));
      m[y][x] = { v: d <= 1 ? 1 : d === 2 ? 0 : d === 3 ? 1 : 0, fixed: true };
    }
  }
}

function placeFunctionPatterns(m, version) {
  const size = m.length;
  placeFinder(m, 3, 3);
  placeFinder(m, size - 4, 3);
  placeFinder(m, 3, size - 4);

  // 定时图形
  for (let i = 8; i < size - 8; i++) {
    const v = i % 2 === 0 ? 1 : 0;
    if (!m[6][i]) m[6][i] = { v, fixed: true };
    if (!m[i][6]) m[i][6] = { v, fixed: true };
  }

  // 校正图形
  const pts = ALIGN[version];
  for (const cy of pts) {
    for (const cx of pts) {
      // 跳过与定位图形重叠的三处
      if ((cx === 6 && cy === 6) || (cx === 6 && cy === pts[pts.length - 1]) || (cx === pts[pts.length - 1] && cy === 6)) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const d = Math.max(Math.abs(dx), Math.abs(dy));
          m[cy + dy][cx + dx] = { v: d === 1 ? 0 : 1, fixed: true };
        }
      }
    }
  }

  // 暗模块
  m[size - 8][8] = { v: 1, fixed: true };

  /* 版本信息（版本 7 起才有，18 位 BCH，右上 3×6 + 左下 6×3 各放一份）。
     这一块原来整个漏了：版本 1~6 不受影响，所以短内容一直正常；
     一旦内容长到版本 7 以上，这 36 个格子就被当成数据区乱写，
     解码器一读版本信息就发现对不上，直接判整张码无效。
     这就是「长链接扫不出来」的真正原因。 */
  if (version >= 7) {
    const bits = versionBits(version);
    /* 版本信息块是 6×3 的小方块，不是 3×6。
       位序：i 从 0 到 17，行 = i/3，列 = i%3（bit0 在左上角，按列主序往下铺）。
       右下角那 6×3 贴在第 8 行格式线的上方，
       左下角那 3×6 贴在最左三列、倒数第 11 行。
       我原来把行列写反成「行=i%3、列=i/3」，18 位被摊成 3 行 6 列，
       于是盖到了旁边 3 列数据区上——这就是 v7 以上整张码无效的原因。 */
    for (let i = 0; i < 18; i++) {
      const v = (bits >> i) & 1;
      const r = Math.floor(i / 3);
      const c = i % 3;
      m[r][size - 11 + c] = { v, fixed: true };          // 右上：行 r，列 size-11+c
      m[size - 11 + r][c] = { v, fixed: true };          // 左下：转置一份
    }
  }

  /* 预留格式信息区（两处副本，共 30 格，格式信息只占这些位置）
     ① 第 8 行 左 9 格 + 右 8 格
     ② 第 8 列 上 9 格 + 下 8 格
     注意：只占「第 8 行 / 第 8 列」这一条线。
     第 9 行第 0~8 列、第 0~8 行第 9 列这些格子**是数据区**，
     它们就在定位图形和格式线之间的空隙里——当初把这里也当成格式区预留，
     结果这几格永远填不上数据，整张码扫出来是残缺的（报「布置有空洞」）。 */
  for (let i = 0; i < 9; i++) {
    if (!m[8][i]) m[8][i] = { v: 0, fixed: true };
    if (!m[i][8]) m[i][8] = { v: 0, fixed: true };
  }
  for (let i = 0; i < 8; i++) {
    if (!m[8][size - 1 - i]) m[8][size - 1 - i] = { v: 0, fixed: true };
    if (!m[size - 1 - i][8]) m[size - 1 - i][8] = { v: 0, fixed: true };
  }
}

/* 数据模块的迂回布置：从右下角起，两列一组，蛇形向上/向下 */
function placeData(m, codewords) {
  const size = m.length;
  let bitIdx = 0;
  const totalBits = codewords.length * 8;
  const bit = () => {
    if (bitIdx >= totalBits) return 0;   // 剩余位补 0（标准行为）
    const b = (codewords[bitIdx >> 3] >> (7 - (bitIdx & 7))) & 1;
    bitIdx++;
    return b;
  };
  let upward = true;
  /* 先算出「列对」序列，再逐对铺数据。
     第 6 列是竖向定时图形，必须整列跳过：一旦右列走到 <=6，就把整组再左移一列。
     这一步要作用在列号本身上（而不是只挪当前组），因为跳列会连带改变后续列对的奇偶。

     这里原来写的是 `if (right === 6) right = 5;`——只在右列「正好等于 6」时生效。
     步长是 2，右列序列是 size-1, size-3, …，能不能落到 6 上完全取决于 size 的奇偶：
       size 奇数（v1/v2/v4/v6…）：永远碰不到 6，定时列被当数据写、第 5 列被漏掉；
       size 偶数（v3/v5/v7…）：恰好碰到，判断生效，结果反而正确。
     所以症状是「短内容有时能扫、长内容扫不出」，极难定位。

     另外必须按顺序去重：调整过的列号可能和上一组重叠，
     同一批格子被写两次，图像后半部分就整体错位。 */
  const pairs = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    /* 第 6 列是竖向定时图形，整列跳过。
       列号序列应当从 8 直接落到 5（8/7、5/4、3/2、1/0），不是 8/7、5/4、2/1。
       这里原来的写法是 `if (right <= 6) right -= 1;`，在 for 的自减之外又减了一次，
       于是 5 变成 4，后面全部连坐错位，最后还会漏掉整列 ——
       表现就是 (0,9)、(3,9) 这类格子永远填不上（下面的空洞检查会抓住）。 */
    if (right === 6) right -= 1;
    pairs.push([right, right - 1]);
  }
  /* 走完所有列对后，是否还有空着的格子？有的话说明列对算错了，
     静默留空会让码看着正常却扫不出来，所以直接报错，别让它悄悄发出去。 */
  for (const [a, b] of pairs) {
    for (let vert = 0; vert < size; vert++) {
      const y = upward ? size - 1 - vert : vert;
      for (const x of [a, b]) {
        const cell = m[y][x];
        if (cell && cell.fixed) continue;
        m[y][x] = { v: bit(), fixed: false };
      }
    }
    upward = !upward;
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (m[y][x]) continue;
      throw new Error(`二维码布置有空洞：(${x},${y}) 未填，列对计算有误`);
    }
  }
}

/* 四条掩码规则（返回 true 表示该位置要取反）
   注意参数顺序是 (row, col)，不是 (x, y)。IS0 18004 的公式里 i=行、j=列，
   这里原来按 (x, y) 传，导致 i/j 颠倒：mask1 成了「列号为偶数」而非「行号为偶数」，
   mask2 成了「行号能被 3 整除」，mask4 的除法也对调了。
   症状极具迷惑性——前十几个字符解出来是对的，后面开始乱码。 */
const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function penalty(grid) {
  const size = grid.length;
  let score = 0;
  const line = (get) => {
    for (let i = 0; i < size; i++) {
      let run = 1;
      for (let j = 1; j < size; j++) {
        if (get(i, j) === get(i, j - 1)) run++;
        else { if (run >= 5) score += 3 + (run - 5); run = 1; }
      }
      if (run >= 5) score += 3 + (run - 5);
    }
  };
  line((i, j) => grid[i][j]);   // 行
  line((i, j) => grid[j][i]);   // 列
  // 2x2 同色
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const v = grid[y][x];
      if (v === grid[y][x + 1] && v === grid[y + 1][x] && v === grid[y + 1][x + 1]) score += 3;
    }
  }
  /* 规则③：出现 1:1:3:1:1 且一侧有 4 个白（形似定位图形的假图案），罚 40。
     原来的写法只匹配「1:1:3:1:1 + 4 个白」这个 11 格窗口，
     漏掉了「4 个白 + 1:1:3:1:1」的另一侧，等于只罚了一半。
     漏罚本身不影响合法性（选哪个掩码都合规），但会让选出的掩码和主流实现不一致，
     交叉验证时就很难分清「真错」还是「选了别的掩码」——所以补齐。 */
  const pat1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const pat2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  for (let i = 0; i < size; i++) {
    for (let j = 0; j <= size - 11; j++) {
      for (const pat of [pat1, pat2]) {
        let okR = true; let okC = true;
        for (let k = 0; k < 11; k++) {
          if (grid[i][j + k] !== pat[k]) okR = false;
          if (grid[j + k][i] !== pat[k]) okC = false;
        }
        if (okR) score += 40;
        if (okC) score += 40;
      }
    }
  }
  // 暗色比例
  let dark = 0;
  for (const row of grid) for (const v of row) dark += v;
  const pct = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(pct - 50) / 5) * 10;
  return score;
}

/* 版本信息：6 bit 版本号 + 12 bit BCH(18,6)，生成多项式 0x1F25。
   版本 7 起必须写，且要用 bit0 在前的顺序铺。 */
function versionBits(version) {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >> 11) * 0x1f25);
  return (version << 12) | rem;
}

/* 格式信息：5 bit 数据 + 10 bit BCH(15,5)，再异或 0x5412 */
function formatBits(ecl, mask) {
  let data = (ECL_FORMAT_BITS[ecl] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  return bits;
}

/* 格式信息共 15 位，写两遍（冗余）。
   位序：沿下面这串坐标走，第一位是 bit0（最低位），最后一位是 bit14。
   ——这个方向反了整张码就解不出来，而图案看起来完全正常
   （本次就踩过：掩码、纠错码、数据布置全对，只错在格式位的方向和顺序）。 */
function writeFormat(m, ecl, mask) {
  const size = m.length;
  const bits = formatBits(ecl, mask);
  const b = (i) => (bits >> i) & 1;

  /* 副本①：竖排（第 8 列，从左上角往下），bit0 → bit14
     跳过第 6 行（定时图形），所以 bit6 落到第 7 行；
     bit8 之后直接跳到最下面 7 格（bit8 → 行 size-7 … bit14 → 行 size-1）。 */
  for (let i = 0; i < 15; i++) {
    const y = i < 6 ? i : i < 8 ? i + 1 : size - 15 + i;
    m[y][8] = { v: b(i), fixed: true };
  }

  /* 副本②：横排（第 8 行）
     bit0 → 最右列，往左走 8 格；bit8 → 第 7 列；bit9 起跳过第 6 列继续往左。 */
  for (let i = 0; i < 15; i++) {
    const x = i < 8 ? size - 1 - i : i < 9 ? 7 : 15 - i - 1;
    m[8][x] = { v: b(i), fixed: true };
  }
}

/* ---------- 对外接口 ---------- */
/**
 * 生成二维码矩阵（0/1 二维数组）
 * @param {string} text 任意文本（按 UTF-8 编码）
 * @param {'L'|'M'} ecl 纠错等级
 */
export function qrMatrix(text, ecl = 'L') {
  const bytes = utf8Bytes(text);
  const version = pickVersion(bytes.length, ecl);
  const size = version * 4 + 17;

  const dataWords = buildDataCodewords(bytes, version, ecl);
  const codewords = interleave(dataWords, version, ecl);

  // 先建一次带功能图形的骨架，用来判断哪些格子可写
  const skeleton = newMatrix(size);
  placeFunctionPatterns(skeleton, version);

  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const m = skeleton.map((row) => row.map((c) => (c ? { ...c } : null)));
    placeData(m, codewords);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (m[y][x].fixed) continue;
        m[y][x].v ^= MASKS[mask](y, x) ? 1 : 0;
      }
    }
    writeFormat(m, ecl, mask);
    const grid = m.map((row) => row.map((c) => c.v));
    const p = penalty(grid);
    if (!best || p < best.p) best = { p, grid };
  }
  return best.grid;
}

/** 生成 SVG 字符串。level 用 'L' 更适合短内容（点更少更好扫）。 */
export function qrSvg(text, { size = 220, ecl = 'L', margin = 4 } = {}) {
  const grid = qrMatrix(text, ecl);
  const n = grid.length;
  const total = n + margin * 2;
  /* 用 path 一次画完，比 n² 个 rect 小得多（一个 33×33 的码约 400 个 rect） */
  let d = '';
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (grid[y][x]) d += `M${x + margin} ${y + margin}h1v1h-1z`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="${size}" height="${size}" shape-rendering="crispEdges">`
    + `<rect width="${total}" height="${total}" fill="#fff"/>`
    + `<path d="${d}" fill="#111"/></svg>`;
}

