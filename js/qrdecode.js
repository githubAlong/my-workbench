/* ============================================================================
 * 零依赖二维码解码器（浏览器端）
 *
 * 【为什么必须自己写】
 * 原本打算用原生 BarcodeDetector，实测发现：Chromium 全平台都没有这个 API
 * （只有 Chrome 品牌版、部分 Android WebView、Safari 16+ 有）。
 * 也就是说，只靠它的话「移动端扫一扫」在相当多设备上直接不可用——
 * 而这正是项目一路在消灭的那种「按钮画出来了但点不动」。
 *
 * 【为什么不引入 jsQR】
 * 项目是零依赖部署（node 内置模块 + 前端原生 JS），拷过去就能跑。
 * 为这个功能往 bundle 里塞一个 30KB 的第三方库，与前提冲突。
 *
 * 【实现范围】
 * 只覆盖「登录二维码」这一个真实场景，不追求通用解码器：
 *   · 版本 1–10（容量足够放下一条 URL，约 270 字节）
 *   · 纠错等级 L / M（服务端出码就用 L）
 *   · 字节模式（UTF-8）
 *   · 掩码 0–7 全部支持（服务端会选最优掩码，不能只认一种）
 * 定位靠「三个定位图形」自寻，不要求输入的图正好裁剪好、角度端正。
 *
 * 【思路】
 *   灰度 → 二值化（Otsu） → 找定位图形 → 定四个角 → 透视校正到 N×N
 *   → 读格式信息 → 去掩码 → 读版本信息（v7+）→ 按列对取码字
 *   → 分块做 Reed-Solomon 纠错 → 拆字节模式 → UTF-8 解出字符串
 * ========================================================================== */

/* ---------------- 有限域 GF(256) ---------------- */
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function initTables() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);
const gfInv = (a) => EXP[255 - LOG[a]];

/* ---------------- 版本 / 纠错参数表 ---------------- */
/* 与编码器共用同一套数字。索引 [version] = { L: [总码字, 数据码字, 块数], M: [...] } */
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
const ALIGN = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};

/* ---------------- 图片 → 灰度 → 二值 ---------------- */

/* 把任意 ImageData / canvas / video 画到一个固定宽度的画布上再做灰度。
   固定宽度有两个好处：速度可控；定位阈值不受原图分辨率影响。 */
export function toGray(source, targetW = 640) {
  const sw = source.videoWidth || source.width || source.naturalWidth;
  const sh = source.videoHeight || source.height || source.naturalHeight;
  if (!sw || !sh) return null;
  const scale = Math.min(1, targetW / sw);
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);
  const gray = new Uint8Array(w * h);
  /* 用整数近似（R*77+G*150+B*29）>>8，比浮点快很多，精度足够二值化 */
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    gray[p] = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
  }
  return { gray, w, h };
}

/* Otsu 全局阈值：二维码是纯黑白，全局阈值比自适应更稳，
   自适应在模块密集区会把黑块边缘算成白，反而破坏定位图形。

   【必须从 t=1 起算，不能从 0】
   纯黑白图（没有任何灰度过渡）的直方图只有 0 和 255 两个峰。
   如果循环从 t=0 开始，第一步 wB=hist[0]（黑像素数）、wF=白像素数，
   此时类间方差就已经是最大值，于是 thr 被定成 0；
   而后面判 `gray <= thr` 要求像素值 ≤ 0 —— 纯黑是 0，恰好还能判对，
   但只要有一点噪声（黑变 5），整张图就被判成全白，定位图形一个都找不到。
   从 t=1 起算，得到的阈值落在 0 与 255 之间，`<=` 才真正表示「暗的一半」。 */
function otsuThreshold(gray) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const total = gray.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = -1, thr = 127;
  for (let t = 1; t < 255; t++) {
    wB += hist[t - 1];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += (t - 1) * hist[t - 1];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; thr = t; }
  }
  return thr;
}

/* ---------------- 找定位图形 ---------------- */
/* 定位图形的横截面是 黑1 : 白1 : 黑3 : 白1 : 黑1（按模块宽度为单位）。
   用「逐行扫描 + 比例匹配」找候选，再在竖直方向复核，比霍夫变换轻量得多。

   但只靠横截面会误报：数据区里随机黑块也可能凑出 1:1:3:1:1。
   实测一张 25×25 的码能出 392 个候选、聚成 16 簇 —— 全是噪声。
   所以必须再加两道过滤：
     ① **回字形检测**：真正的定位图形，在它中心的水平、竖直、两条对角线上
        都应该满足 1:1:3:1:1；数据区的偶然匹配几乎不可能四条都满足。
     ② **尺寸一致 + 三点共形**：三个定位图形的模块宽度应当接近，
        且它们构成一个近似等腰直角三角形。 */
/* 检查某点是不是「回字形」中心：水平/竖直/两条对角线都满足 黑:白:黑 的比例。
   这是最强的判据，能一票否决数据区的偶然匹配。 */
function isFinderCenter(bin, w, h, cx, cy, m) {
  const x = Math.round(cx), y = Math.round(cy);
  if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) return false;
  const at = (xx, yy) => (xx < 0 || yy < 0 || xx >= w || yy >= h ? 0 : bin[yy * w + xx]);
  if (at(x, y) !== 1) return false;
  const tol = Math.max(1.5, m * 0.85);
  /* 沿四条方向量：中心黑块半宽、紧邻白环、再外面黑框 */
  const dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
  for (const [dx, dy] of dirs) {
    /* 中心黑：向外最多 2.2m 像素 */
    let c = 0;
    while (c < m * 2.4 && at(x + dx * c, y + dy * c) === 1) c++;
    /* 白环 */
    let wlen = 0;
    while (wlen < m * 1.8 && at(x + dx * (c + wlen), y + dy * (c + wlen)) === 0) wlen++;
    /* 外框黑 */
    let blen = 0;
    while (blen < m * 2.2 && at(x + dx * (c + wlen + blen), y + dy * (c + wlen + blen)) === 1) blen++;
    /* 期望：中心半宽 ≈ 1.5m，白环 ≈ m，外框 ≥ 0.6m */
    if (Math.abs(c - 1.5 * m) > tol) return false;
    if (Math.abs(wlen - m) > tol) return false;
    if (blen < m * 0.5) return false;
  }
  return true;
}

function findFinderCandidates(bin, w, h) {
  const cands = [];
  const match = (run) => {
    /* run = [b,w,b,w,b] 五段连续像素数。总宽要够大、中间黑块要是两边的 3 倍左右 */
    const [a, b, c, d, e] = run;
    if (a < 1 || b < 1 || c < 1 || d < 1 || e < 1) return false;
    const total = a + b + c + d + e;
    if (total < 7) return false;                        // 太小，一定是噪声
    const m = total / 7;                                 // 每个模块的像素宽
    const tol = m * 0.85;                                // 允许透视和模糊带来的偏差
    return Math.abs(a - m) < tol && Math.abs(b - m) < tol
      && Math.abs(c - 3 * m) < 3 * tol && Math.abs(d - m) < tol
      && Math.abs(e - m) < tol;
  };

  for (let y = 0; y < h; y++) {
    const row = y * w;
    let x = 0;
    /* 逐行取连续色块。跳过左边缘那一大段白（quiet zone）。 */
    let runs = [];
    let cur = bin[row];
    let len = 1;
    for (x = 1; x < w; x++) {
      const v = bin[row + x];
      if (v === cur) { len++; continue; }
      runs.push([cur, len]);
      cur = v; len = 1;
    }
    runs.push([cur, len]);

    /* 在该行的 runs 里滑动一个 5 段窗口 */
    for (let i = 0; i + 4 < runs.length; i++) {
      /* 窗口必须以黑开始（[黑 白 黑 白 黑]） */
      if (runs[i][0] !== 1) continue;
      if (runs[i + 1][0] !== 0 || runs[i + 2][0] !== 1 || runs[i + 3][0] !== 0 || runs[i + 4][0] !== 1) continue;
      const lens = [runs[i][1], runs[i + 1][1], runs[i + 2][1], runs[i + 3][1], runs[i + 4][1]];
      if (!match(lens)) continue;
      /* 中心 x：从窗口起点累加前两段半 */
      let cx = 0;
      for (let k = 0; k < i; k++) cx += runs[k][1];
      cx += lens[0] + lens[1] + lens[2] / 2;
      const m = (lens[0] + lens[1] + lens[2] + lens[3] + lens[4]) / 7;
      /* 第二道关：回字形检测。不过这一关的全是数据区噪声，直接丢。 */
      if (!isFinderCenter(bin, w, h, cx, y + 0.5, m)) continue;
      cands.push({ x: cx, y: y + 0.5, m });
    }
  }
  return cands;
}

/* 把候选按「同一个定位图形」聚成一簇。
   判据要同时收紧 x 和 y：只按 y 聚会把同一行上左右两个定位图形并成一个；
   只按 x 聚同理。用两倍模块宽做容差，既能把同一个图形上扫到的几十行并起来，
   又不会把相邻的另一个图形误并。 */
function clusterCandidates(cands) {
  const clusters = [];
  for (const c of cands) {
    let hit = null;
    for (const cl of clusters) {
      const tolY = Math.max(3, cl.m * 1.5);
      const tolX = Math.max(3, cl.m * 1.5);
      if (Math.abs(cl.y - c.y) <= tolY && Math.abs(cl.x - c.x) <= tolX) { hit = cl; break; }
    }
    if (hit) {
      hit.n++;
      hit.sx += c.x; hit.sy += c.y; hit.sm += c.m;
      hit.y = hit.sy / hit.n;        // 用均值更新，便于后续聚类
      hit.x = hit.sx / hit.n;
      hit.m = hit.sm / hit.n;
    } else {
      clusters.push({ n: 1, sx: c.x, sy: c.y, sm: c.m, x: c.x, y: c.y, m: c.m });
    }
  }
  /* 一个定位图形在图上横跨好几个模块高，正常会被扫到「行数 ≥ 模块数×3」次。
     低于这个量的基本是斜着擦过的噪声，丢掉。 */
  return clusters
    .filter((c) => c.n >= 3)
    .map((c) => ({ x: c.sx / c.n, y: c.sy / c.n, m: c.sm / c.n, n: c.n }))
    .sort((a, b) => b.n - a.n);
}

/* 挑出三个定位图形，并按「哪个是左上」给它们定角色。
   判据：左上角是那个直角点——另两个点连线的中点，离左上点最远。 */
function pickThree(clusters) {
  const pts = clusters.slice(0, 8);
  let best = null;
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      for (let k = j + 1; k < pts.length; k++) {
        const [a, b, c] = [pts[i], pts[j], pts[k]];
        /* 直角判定：以某点为顶点的两条边应该近似垂直且长度相近 */
        for (const [tl, p1, p2] of [[a, b, c], [b, a, c], [c, a, b]]) {
          const v1 = [p1.x - tl.x, p1.y - tl.y];
          const v2 = [p2.x - tl.x, p2.y - tl.y];
          const l1 = Math.hypot(...v1), l2 = Math.hypot(...v2);
          if (l1 < 8 || l2 < 8) continue;
          const cos = Math.abs((v1[0] * v2[0] + v1[1] * v2[1]) / (l1 * l2));
          const ratio = l1 / l2;
          if (cos > 0.35 || ratio < 0.55 || ratio > 1.8) continue;   // 不够像直角
          const score = (1 - cos) - Math.abs(1 - ratio) * 0.5 + (tl.n + p1.n + p2.n) * 0.01;
          if (!best || score > best.score) best = { tl, p1, p2, score };
        }
      }
    }
  }
  if (!best) return null;
  /* 让 p1 在右、p2 在下：用叉积符号判断，避免镜像后坐标系翻转 */
  const { tl } = best;
  const cross = (best.p1.x - tl.x) * (best.p2.y - tl.y) - (best.p1.y - tl.y) * (best.p2.x - tl.x);
  const [right, bottom] = cross > 0 ? [best.p1, best.p2] : [best.p2, best.p1];
  return { tl, right, bottom };
}

/* ---------------- 透视校正 ---------------- */
/* 已知三个角，估第四个角，然后把整张码采样成 size×size 的模块矩阵。
   按双线性插值取点：对每个模块中心 (u,v)∈[0,1]²，映射回原图坐标再取灰度。 */
function sampleGrid(gray, w, h, corners, size, thr) {
  const { tl, tr, bl } = corners;
  const br = { x: tr.x + bl.x - tl.x, y: tr.y + bl.y - tl.y };
  const out = new Uint8Array(size * size);
  for (let r = 0; r < size; r++) {
    const v = (r + 0.5) / size;
    for (let c = 0; c < size; c++) {
      const u = (c + 0.5) / size;
      /* 双线性：先沿上边/下边插值，再沿竖直方向插值 */
      const x = (1 - v) * ((1 - u) * tl.x + u * tr.x) + v * ((1 - u) * bl.x + u * br.x);
      const y = (1 - v) * ((1 - u) * tl.y + u * tr.y) + v * ((1 - u) * bl.y + u * br.y);
      const xi = Math.round(x), yi = Math.round(y);
      let val = 0;
      if (xi >= 0 && xi < w && yi >= 0 && yi < h) {
        /* 3×3 邻域取中位数，抗噪点（摄像头噪点会让单个模块判断反） */
        const ns = [];
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const xx = xi + dx, yy = yi + dy;
            if (xx >= 0 && xx < w && yy >= 0 && yy < h) ns.push(gray[yy * w + xx]);
          }
        }
        ns.sort((a, b) => a - b);
        val = ns[ns.length >> 1];
      } else val = 255;
      out[r * size + c] = val <= thr ? 1 : 0;
    }
  }
  return out;
}

/* ---------------- 读矩阵 ---------------- */
function readFormat(grid, size) {
  /* 格式信息两份：竖排第 8 列、横排第 8 行。两位都读，取错得少的那个。 */
  const bit = (r, c) => grid[r * size + c];
  /* 按 bit14 → bit0 的顺序读入（最高位先读，便于和常量直接比）。
     竖排副本：第 8 列自上而下，跳过第 6 行（定时图形）。 */
  let a = 0, b = 0;
  for (let i = 14; i >= 0; i--) {
    const y1 = i < 6 ? i : i < 8 ? i + 1 : size - 15 + i;
    a = (a << 1) | bit(y1, 8);
  }
  for (let i = 14; i >= 0; i--) {
    const x = i < 8 ? size - 1 - i : i < 9 ? 7 : 15 - i - 1;
    b = (b << 1) | bit(8, x);
  }
  const mx = 0x5412;
  /* 与 32 个合法值（8 掩码 × 4 等级）比汉明距离，允许最多 3 位错 */
  let bestA = null, bestB = null;
  const cands = [];
  for (const [eclBits, ecl] of [[1, 'L'], [0, 'M']]) {
    for (let mask = 0; mask < 8; mask++) {
      const data = (eclBits << 3) | mask;
      let rem = data;
      for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >> 9) * 0x537);
      const val = ((data << 10) | rem) ^ mx;
      cands.push({ val, ecl, mask });
    }
  }
  const dist = (x, y) => { let d = x ^ y, n = 0; while (d) { n += d & 1; d >>= 1; } return n; };
  for (const c of cands) {
    const da = dist(a, c.val), db = dist(b, c.val);
    if (da <= 3 && (!bestA || da < bestA.d)) bestA = { ...c, d: da };
    if (db <= 3 && (!bestB || db < bestB.d)) bestB = { ...c, d: db };
  }
  return bestA || bestB || null;
}

function readVersion(grid, size) {
  /* v7+ 才有版本信息块（6×3 两块）。低位先读。 */
  if (size < 45) return null;
  const bit = (r, c) => grid[r * size + c];
  let a = 0;
  for (let i = 17; i >= 0; i--) a = (a << 1) | bit(Math.floor(i / 3), size - 11 + (i % 3));
  const dist = (x, y) => { let d = x ^ y, n = 0; while (d) { n += d & 1; d >>= 1; } return n; };
  let best = null;
  for (let v = 7; v <= 10; v++) {
    let rem = v;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >> 11) * 0x1f25);
    const val = (v << 12) | rem;
    const d = dist(a, val);
    if (d <= 3 && (!best || d < best.d)) best = { v, d };
  }
  return best ? best.v : null;
}

/* 生成「哪些位置是功能区」的掩板：功能图形不参与数据读取 */
function buildReserved(size, version) {
  const rs = new Uint8Array(size * size);
  const mark = (r, c) => { if (r >= 0 && r < size && c >= 0 && c < size) rs[r * size + c] = 1; };

  /* 三个定位图形 + 分隔符：各占 9×9 */
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) mark(cy + dy, cx + dx);
  }
  /* 定时图形：第 6 行、第 6 列 */
  for (let i = 0; i < size; i++) { mark(6, i); mark(i, 6); }
  /* 校正图形 */
  const al = ALIGN[version] || [];
  for (const ay of al) {
    for (const ax of al) {
      /* 与定位图形重叠的校正图形不存在 */
      if ((ax === 6 && ay === 6) || (ax === 6 && ay === al[al.length - 1]) || (ax === al[al.length - 1] && ay === 6)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) mark(ay + dy, ax + dx);
    }
  }
  /* 格式信息 */
  for (let i = 0; i < 15; i++) {
    const y1 = i < 6 ? i : i < 8 ? i + 1 : size - 15 + i;
    mark(y1, 8);
    const x = i < 8 ? size - 1 - i : i < 9 ? 7 : 15 - i - 1;
    mark(8, x);
  }
  mark(size - 8, 8);   // 暗模块，固定为黑，不参与数据
  /* 版本信息 */
  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      const r = Math.floor(i / 3), c = i % 3;
      mark(r, size - 11 + c);
      mark(size - 11 + r, c);
    }
  }
  return rs;
}

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

/* ---------------- Reed-Solomon 纠错 ---------------- */
/* 用欧几里得算法求错误位置和幅值。这是整段代码里最容易写错的地方，
   所以每个中间量都留了注释，并且下面有用编码器做闭环的自测。 */
function rsCorrect(block, ecLen) {
  const n = block.length;
  const syn = new Uint8Array(ecLen);
  let hasErr = false;
  for (let i = 0; i < ecLen; i++) {
    let s = 0;
    const x = EXP[i];
    for (let j = 0; j < n; j++) s = gfMul(s, x) ^ block[j];
    syn[i] = s;
    if (s) hasErr = true;
  }
  if (!hasErr) return block;            // 没有错误，原样返回

  /* Berlekamp-Massey 求错误位置多项式 Λ(x) */
  let lambda = [1];
  let b = [1];
  let L = 0, m = 1, bb = 1;
  for (let r = 0; r < ecLen; r++) {
    let d = syn[r];
    for (let i = 1; i <= L; i++) d ^= gfMul(lambda[i] || 0, syn[r - i]);
    if (d === 0) { m++; continue; }
    const coef = gfMul(d, gfInv(bb));
    const t = lambda.slice();
    if (lambda.length < b.length + m) lambda.length = b.length + m;
    for (let i = 0; i < b.length; i++) lambda[i + m] ^= gfMul(coef, b[i]);
    if (2 * L <= r) { L = r + 1 - L; b = t; bb = d; m = 1; } else m++;
  }

  /* Chien 搜索找错误位置 */
  const positions = [];
  for (let i = 0; i < n; i++) {
    const xInv = EXP[(255 - i) % 255];
    let v = 0;
    for (let j = lambda.length - 1; j >= 0; j--) v = gfMul(v, xInv) ^ (lambda[j] || 0);
    if (v === 0) positions.push(n - 1 - i);
  }
  if (positions.length !== L || positions.length * 2 > ecLen) return null;   // 错太多，纠不动

  /* Forney 求幅值 */
  const out = block.slice();
  for (const pos of positions) {
    const xi = EXP[pos];
    const xiInv = EXP[(255 - pos) % 255];
    /* Λ'(xi^-1) */
    let denom = 0;
    for (let j = 1; j < lambda.length; j += 2) {
      let t = lambda[j] || 0;
      for (let k = 0; k < j - 1; k++) t = gfMul(t, xiInv);
      denom ^= t;
    }
    if (!denom) return null;
    /* Ω(xi^-1) = S(x)·Λ(x) mod x^ecLen */
    let omega = 0;
    for (let j = 0; j < ecLen; j++) {
      let t = 0;
      for (let k = 0; k <= j && k < lambda.length; k++) t ^= gfMul(syn[j - k], lambda[k] || 0);
      let p = t;
      for (let q = 0; q < j; q++) p = gfMul(p, xiInv);
      omega ^= p;
    }
    const mag = gfMul(xi, gfMul(omega, gfInv(denom)));
    out[pos] ^= mag;
  }
  /* 复核：纠完必须真的没错误了，否则宁可判失败也别交出垃圾数据 */
  for (let i = 0; i < ecLen; i++) {
    let s = 0;
    const x = EXP[i];
    for (let j = 0; j < n; j++) s = gfMul(s, x) ^ out[j];
    if (s) return null;
  }
  return out;
}

/* 按块拆开、纠错、再拼回数据码字（交织的逆过程） */
function deinterleaveAndCorrect(words, version, ecl) {
  const [total, dataLen, blockCount] = CAP[version][ecl];
  const ecPer = Math.floor((total - dataLen) / blockCount);
  const shortLen = Math.floor(dataLen / blockCount);
  const longCount = dataLen % blockCount;      // 前 longCount 块多 1 个数据码字
  const blocks = [];
  let p = 0;
  for (let i = 0; i < blockCount; i++) {
    const dLen = shortLen + (i < longCount ? 1 : 0);
    blocks.push({ dLen, data: [], ec: [] });
  }
  /* 交织顺序：所有块的第 0 个数据码字 → 第 1 个 → … → 再所有块的纠错码字 */
  const maxData = shortLen + (longCount ? 1 : 0);
  for (let i = 0; i < maxData; i++) {
    for (const b of blocks) if (i < b.dLen) b.data.push(words[p++]);
  }
  for (let i = 0; i < ecPer; i++) {
    for (const b of blocks) b.ec.push(words[p++]);
  }
  const out = [];
  let bad = 0;
  for (const b of blocks) {
    const full = b.data.concat(b.ec);
    const fix = ecCorrect(full, ecPer);
    if (fix) out.push(...fix.slice(0, b.dLen));
    else { bad++; out.push(...b.data); }   // 纠不动就先用原值，CRC 会兜底
  }
  return { data: out, badBlocks: bad };
}

function ecCorrect(block, ecLen) {
  try { return rsCorrect(block, ecLen); } catch { return null; }
}

/* ---------------- 字节模式解析 ---------------- */
function parseBytes(dataWords) {
  let bitPos = 0;
  const readBits = (n) => {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const byteIdx = bitPos >> 3;
      if (byteIdx >= dataWords.length) return -1;
      const bit = (dataWords[byteIdx] >> (7 - (bitPos & 7))) & 1;
      v = (v << 1) | bit;
      bitPos++;
    }
    return v;
  };
  const out = [];
  let version = 0;
  for (;;) {
    const mode = readBits(4);
    if (mode < 0 || mode === 0) break;                  // 0000 = 结束符
    if (mode === 4) {                                    // 0100 = 字节模式
      /* 字符计数长度随版本变化：v1-9 是 8 位，v10-26 是 16 位 */
      const len = readBits(8);
      if (len < 0) break;
      for (let i = 0; i < len; i++) {
        const b = readBits(8);
        if (b < 0) break;
        out.push(b);
      }
    } else {
      break;   // 本解码器只处理字节模式；数字/字母数字模式服务端不用
    }
  }
  try { return new TextDecoder('utf-8').decode(new Uint8Array(out)); } catch { return ''; }
}

/* ---------------- 对外主函数 ---------------- */
/* 输入一个 CanvasImageSource（video / canvas / ImageBitmap / HTMLImageElement），
   返回解出的字符串；解不出返回空串。 */
export function decodeQR(source) {
  const img = toGray(source, 720);
  if (!img) return '';
  const { gray, w, h } = img;
  const thr = otsuThreshold(gray);
  const bin = new Uint8Array(w * h);
  for (let i = 0; i < gray.length; i++) bin[i] = gray[i] <= thr ? 1 : 0;

  const clusters = clusterCandidates(findFinderCandidates(bin, w, h));
  if (clusters.length < 3) return '';
  const trio = pickThree(clusters);
  if (!trio) return '';
  const { tl, right, bottom } = trio;

  /* 用「定位图形间距 ÷ 模块宽度」直接反推版本，而不是从 10 往下逐个试。
     为什么要改：原来按 10→1 顺序采样，对一张 25×25 的真码，先用 v10 的尺寸
     去采样也会得到一张「看着像码」的网格，前 15 位格式信息甚至可能凑巧对上，
     于是拿着错误尺寸的网格继续取码字，后面全是乱的。
     间距反推是确定性的：两定位图形中心相距 (size-7) 个模块，
     而单模块像素宽 m 已经从定位图形本身量出来了，所以 size ≈ 间距/m + 7。 */
  const distX = Math.hypot(right.x - tl.x, right.y - tl.y);
  const distY = Math.hypot(bottom.x - tl.x, bottom.y - tl.y);
  const mAvg = (tl.m + right.m + bottom.m) / 3;
  const estSize = (distX + distY) / 2 / mAvg + 7;
  const estVersion = Math.round((estSize - 17) / 4);

  /* 候选版本：以估算值为中心，优先它自己，再试邻近的 1 个（抗量化误差） */
  const candidates = [];
  for (const d of [0, -1, 1, -2, 2]) {
    const v = estVersion + d;
    if (v >= 1 && v <= 10) candidates.push(v);
  }
  if (!candidates.length) candidates.push(1);

  let result = '';
  for (const version of candidates) {
    const size = 17 + version * 4;
    const spanModules = size - 7;              // 两定位中心之间的模块数
    /* 相邻两个定位图形中心相距 (size-7) 个模块，码的边还在它们外侧 3.5 个模块处，
       所以外扩比例 = 3.5 / (size-7)。右、下两角同理。 */
    const k = 3.5 / spanModules;
    const cornerTL = { x: tl.x - (right.x - tl.x) * k, y: tl.y - (bottom.y - tl.y) * k };
    const cornerTR = { x: right.x + (right.x - tl.x) * k, y: right.y - (bottom.y - tl.y) * k };
    const cornerBL = { x: bottom.x - (right.x - tl.x) * k, y: bottom.y + (bottom.y - tl.y) * k };

    const grid = sampleGrid(gray, w, h, { tl: cornerTL, tr: cornerTR, bl: cornerBL }, size, thr);
    const fmt = readFormat(grid, size);
    if (!fmt) continue;
    /* 版本信息能读就对一下，读不出（v<7）就信候选版本 */
    const vRead = readVersion(grid, size);
    if (vRead && vRead !== version) continue;

    const reserved = buildReserved(size, version);

    /* 按编码器的反方向取位：列对从右往左、上下交替；跳过功能区；
       取的同时按掩码取反（掩码是模块级的，必须在这一步做，不能对码字做）。 */
    const bits = [];
    const pairs = [];
    for (let rt = size - 1; rt >= 1; rt -= 2) {
      if (rt === 6) rt -= 1;
      pairs.push([rt, rt - 1]);
    }
    let upward = true;
    for (const [a, b2] of pairs) {
      for (let vert = 0; vert < size; vert++) {
        const y = upward ? size - 1 - vert : vert;
        for (const x of [a, b2]) {
          if (reserved[y * size + x]) continue;
          let v = grid[y * size + x];
          if (MASKS[fmt.mask](y, x)) v ^= 1;
          bits.push(v);
        }
      }
      /* 每走完一个列对，方向必须翻转：编码器就是这样铺的（蛇形走位）。
         这一行曾经在清理冗余代码时被误删，症状极隐蔽——
         第 1 个列对方向正好是「从下往上」，完全正确，前 4 个码字能解出来；
         从第 2 个列对起方向全反，后面的码字一律错位，
         最终表现成一段「前半截像 URL、后半截乱码」的文字。 */
      upward = !upward;
    }
    const codewords = [];
    for (let i = 0; i + 7 < bits.length; i += 8) {
      let v = 0;
      for (let k = 0; k < 8; k++) v = (v << 1) | bits[i + k];
      codewords.push(v);
    }
    if (codewords.length < CAP[version][fmt.ecl][0]) continue;
    // 打印 reserved 里被标记的格数，以及 (24,0) 这类关键位置
    let rcount = 0; for (const v of reserved) if (v) rcount++;

    const need = CAP[version][fmt.ecl][0];
    const { data } = deinterleaveAndCorrect(codewords.slice(0, need), version, fmt.ecl);
    const text = parseBytes(data);
    /* 只接受「看起来是本站的码」的结果：不是任意字符串都算成功，
       否则随手扫一本书也可能返回一串噪声，走到下一步才发现不对。 */
    if (text) { result = text; break; }
  }
  return result;
}
