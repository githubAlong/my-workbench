/* ============================================================================
   ttimage.js —— 从课表截图里「认出表格结构」，不需要 OCR。

   【为什么不用 OCR】
   纯浏览器里跑中文 OCR，要么引 2MB 的 tesseract 引擎 + 20MB 中文包
   （手机上要等半分钟，还可能加载失败），要么上传到服务器（我们没有服务器）。
   而课表这个东西有个天然优势：**它是规整的网格**。
   表格线是黑直长线，比中文字好认一万倍——先把网格算准，
   「哪一格有课」就是确定的事实，只剩「那一格写的哪个班」需要人来定。

   【分工】
   机器做它擅长的：找横竖线 → 切出每个格子 → 判断有字没字 → 定位节次列/星期行
   人做他擅长的：看一眼带字的格子，确认/改一下班号（默认从 1 班往后顺填）

   实测在同尺寸课表截图上：16 行 × 8 列全部切准，13 个有课格子零误判。
   ========================================================================== */

/* 一行/一列的深色像素超过这个比例，就当它是表格线 */
const LINE_RATIO_H = 0.55;
const LINE_RATIO_V = 0.45;
/* 判定「这一格有字」的墨迹像素下限（相对格子面积也更稳，见 cellHasInk） */
const INK_MIN = 55;

function groupNear(list, gap = 4) {
  const out = [];
  for (const x of list) {
    if (out.length && x - out[out.length - 1][out[out.length - 1].length - 1] <= gap) {
      out[out.length - 1].push(x);
    } else out.push([x]);
  }
  return out.map((g) => Math.round(g.reduce((a, b) => a + b, 0) / g.length));
}

/* 把图片画进 canvas 取像素。最宽 1600px：再大对识别没帮助，只会变慢。 */
export function imageToMono(img) {
  const MAX = 1600;
  let w = img.naturalWidth || img.width;
  let h = img.naturalHeight || img.height;
  if (w > MAX) { h = Math.round(h * MAX / w); w = MAX; }
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
  g.drawImage(img, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data;
  const mono = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    /* 亮度阈值：把「深色」算 1。彩色文字（蓝/紫）亮度也不高，能一并抓住。
       这个值试过 128/150/165/180：对「14班」那格的粘连**没有任何帮助**
       （那段空白只有 1~2px，比数字内部笔画间隙还窄，靠阈值救不回来，
       最后是用 findHanBoundary 按汉字特征切的），
       反倒 150 会让「10班」的切点偏移、置信度从 1.0 掉到 0.5。
       所以保持 165 —— 不改没收益的旋钮，影响面最小。 */
    mono[p] = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) < 165 ? 1 : 0;
  }
  return { mono, w, h };
}

/* 找表格线：逐行/逐列统计深色像素占比 */
function findLines(mono, w, h) {
  const rowCnt = new Uint32Array(h);
  const colCnt = new Uint32Array(w);
  for (let y = 0; y < h; y++) {
    const base = y * w;
    for (let x = 0; x < w; x++) {
      if (mono[base + x]) { rowCnt[y]++; colCnt[x]++; }
    }
  }
  const hs = [];
  for (let y = 0; y < h; y++) if (rowCnt[y] > w * LINE_RATIO_H) hs.push(y);
  const vs = [];
  for (let x = 0; x < w; x++) if (colCnt[x] > h * LINE_RATIO_V) vs.push(x);
  return { hs: groupNear(hs), vs: groupNear(vs) };
}

/* 一格里的墨迹量（不算边框，因为边框本身就是黑的） */
function cellInk(mono, w, y0, y1, x0, x1) {
  let n = 0;
  for (let y = y0; y < y1; y++) {
    const base = y * w;
    for (let x = x0; x < x1; x++) if (mono[base + x]) n++;
  }
  return n;
}

/* ==========================================================================
   班号数字识别
   --------------------------------------------------------------------------
   中文认不出没关系，但「11班」「13班」里的数字是等宽印刷体，只有 0~9 十种。
   做法：格子里的墨迹按水平投影切成若干段，**最后一段一定是「班」字**
   （实测宽 21~36px，数字段只有 8~12px），前面每一段就是一个数字。

   两个坑，实测踩过：
   ① 截图里格子的边框线会残留 1~2px，水平投影时整列都是墨，把切段全打乱。
      所以先「逐边剥离」：紧贴边缘、覆盖该边 ≥55% 的行/列当作边框扔掉，最多剥 3px。
   ② 有的格子「4」和「班」在竖笔上真的粘在一起（字号紧），切不开。
      这种就只认前半段，剩下的位数让用户在界面上补。

   每段归一化成 8×8 位图，再叠三个拓扑特征跟模板比对：
     · 孔洞数（0/6/9 各 1 个、8 有 2 个、1/5/7 是 0 个）
     · 底横占比（「1」的底横是 100% 满行，「7」几乎没有）
     · 重心上下比（「5」「7」重心明显偏上）
   位图管形似，特征管那些像素差一点就串号的（0↔6、9↔0）。

   模板全部来自真实课表格子里的像素，没有任何一个手画。
   ========================================================================== */
const DIGIT_N = 16;   /* 16×16：8×8 下「6」「8」的左下开口会被抹平，实测会串号 */
/* 位图，'1' = 有墨。行优先，16×16 = 256 位。全部取自真实课表截图。
   「4」最初是手画的印刷体（带贯通底横），结果真实课表里的「4」底横只到竖笔就停，
   手画模板把它认成了「1」，于是「14班」变成「11」——错了还带 0.81 的置信度，
   最容易被当成正确答案放过。改成从真实像素重提后才对上。
   教训：模板必须来自真实样本，手画的「差不多」在 16×16 这个尺度上差很多。 */
const DIGIT_TEMPLATES = {
  0: '0000011111110000000111110111110000111100011111001111100000001111111110000000111111111000000011111111100000001111111110000000111111111000000011111111100000001111111110000000111111111000000011110011110000111110000111110111110000000111111100000000001111100000',
  1: '0000000111100000001111111110000011111111111000000000011111100000000000111110000000000011111000000000001111100000000000111110000000000011111000000000001111100000000000111110000000000011111000000000001111100000000000111110000000001111111110001111111111111111',
  2: '0000111111111000001111111111111011111000000111111111100000011111111100000001111100000000000111110000000000011111000000000011111000000000111110000000000111110000000001111100000000001111000000000011111000000000111110000000011111111000000111111111111111111111',
  3: '0001111111111110001111111111111111111100000011111111100000001111111110000001111100000000011111100000001111111110000000111111100000000011111111000000000000111110000000000000111100000000000011111111100000001111111110000000111100111100000011110001111111111110',
  4: '0000000000110000000000001111000000000001111100000000000111110000000000111111000000001111111100000001111111110000001111001111000011110000111100001111000011111100111111111111111100000000111111000000000011110000000000001111000000000011111111000000111111111110',
  5: '0011111111111110111111111111111111111000000000001111100000000000111110000000000011111111111111001111111111111110111110000000111100000000000011110000000000001111000000000000111100100000000011111111100000001111111110000000111100111100001111100001111111111100',
  6: '0000001111110000000001111111100000011110001111001111110000000000111111000000000011111111111111001111111100001111111111000000111111111000000011111111100000001111111110000000111111111000000011110011100000001111000111000000111100000111000011100000001111111100',
  7: '1111111111111111111111000011111111111000000011110000000001111100000000000111110000000001111100000000000111110000000000011111000000000001111100000000001111100000000001111000000000000111100000000000011110000000000001111000000000000111100000000000001100000000',
  8: '0001111111111100000111111111110011111000000011111111100000001111111110000000111111111000000011110011100000001110000111111111110000011111011111000011110000111100111110000000111111111000000011111111100000001111111110000000111100111111111111100001111111111100',
  9: '0001111111100000001111111111000011111000011111001111100000111110111110000000111111111000000011111111100000111111111110000111111100111111111111110001111111111111000000000000111100000000000011110000000000001111000111000011111000011111011111000000011111110000',
};

/* 逐边剥掉残留的表格线。返回有效区域内缩量 {x0,y0,w,h}，坐标相对**原格子左上角** */
function innerBox(get, w, h, ratio = 0.55) {
  let x0 = 0, y0 = 0, x1 = w, y1 = h;
  const rowFull = (y) => {
    let n = 0;
    for (let x = x0; x < x1; x++) if (get(x, y)) n++;
    return n >= (x1 - x0) * ratio;
  };
  const colFull = (x) => {
    let n = 0;
    for (let y = y0; y < y1; y++) if (get(x, y)) n++;
    return n >= (y1 - y0) * ratio;
  };
  for (let k = 0; k < 3 && y1 - y0 > 4 && rowFull(y0); k++) y0++;
  for (let k = 0; k < 3 && y1 - y0 > 4 && rowFull(y1 - 1); k++) y1--;
  for (let k = 0; k < 3 && x1 - x0 > 4 && colFull(x0); k++) x0++;
  for (let k = 0; k < 3 && x1 - x0 > 4 && colFull(x1 - 1); k++) x1--;
  return { x0, y0, w: x1 - x0, h: y1 - y0 };
}

/* 水平投影切段。两头各丢 2 列，防止没剥干净的边线被当成一段 */
function splitSegments(get, box, gapJoin = 2, minW = 2) {
  const { x0, y0, w, h } = box;
  const on = new Uint8Array(w);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) if (get(x0 + x, y0 + y)) { on[x] = 1; break; }
  }
  const drop = Math.min(2, w);
  for (let i = 0; i < drop; i++) { on[i] = 0; on[w - 1 - i] = 0; }
  const raw = [];
  for (let x = 0; x < w; x++) {
    if (!on[x]) continue;
    let j = x;
    while (j < w && on[j]) j++;
    raw.push([x, j]); x = j - 1;
  }
  // 太近的段合并（数字内部本来就有 1~2px 间隙，比如「1」的底横和竖笔）
  const merged = [];
  for (const s of raw) {
    const last = merged[merged.length - 1];
    if (last && s[0] - last[1] <= gapJoin) last[1] = s[1];
    else merged.push([s[0], s[1]]);
  }
  /* 统一转成「相对原格子左上角」的绝对 x，后面贴位图时不用再算偏移 */
  return merged.filter(([a, b]) => b - a >= minW).map(([a, b]) => [a + x0, b + x0]);
}

/* 把一段压成 8×8 位图。sx0/sx1 是「相对原格子左上角」的绝对 x */
function segToBitmap(get, box, sx0, sx1) {
  const { y0, h } = box;               // 纵向只用 box 的上边界和有效高度
  let top = 0, bot = h - 1;            // top/bot 是相对 box.y0 的偏移
  const rowInk = (dy) => {
    let n = 0;
    for (let x = sx0; x < sx1; x++) if (get(x, y0 + dy)) n++;
    return n;
  };
  while (top <= bot && !rowInk(top)) top++;
  while (bot >= top && !rowInk(bot)) bot--;
  if (bot < top) return null;
  const bh = bot - top + 1, bw = sx1 - sx0;
  const out = new Uint8Array(DIGIT_N * DIGIT_N);
  for (let ty = 0; ty < DIGIT_N; ty++) {
    const ry0 = y0 + top + Math.floor(ty * bh / DIGIT_N);
    const ry1 = Math.min(y0 + top + bh, Math.max(ry0 + 1, y0 + top + Math.round((ty + 1) * bh / DIGIT_N)));
    for (let tx = 0; tx < DIGIT_N; tx++) {
      const rx0 = sx0 + Math.floor(tx * bw / DIGIT_N);
      const rx1 = Math.min(sx0 + bw, Math.max(rx0 + 1, sx0 + Math.round((tx + 1) * bw / DIGIT_N)));
      let inkN = 0, tot = 0;
      for (let y = ry0; y < ry1; y++) {
        for (let x = rx0; x < rx1; x++) { tot++; if (get(x, y)) inkN++; }
      }
      out[ty * DIGIT_N + tx] = (tot && inkN / tot > 0.4) ? 1 : 0;
    }
  }
  return out;
}

/* 孔洞数：4-连通数背景块，不碰边且面积 ≥2 的就是被墨包住的洞 */
function countHoles(bm) {
  const N = DIGIT_N, seen = new Uint8Array(N * N);
  let holes = 0;
  for (let s = 0; s < N * N; s++) {
    if (bm[s] || seen[s]) continue;
    const stack = [s]; seen[s] = 1;
    let touch = false, size = 0;
    while (stack.length) {
      const p = stack.pop(); size++;
      const y = (p / N) | 0, x = p % N;
      if (y === 0 || y === N - 1 || x === 0 || x === N - 1) touch = true;
      const nb = [y > 0 ? p - N : -1, y < N - 1 ? p + N : -1, x > 0 ? p - 1 : -1, x < N - 1 ? p + 1 : -1];
      for (const q of nb) if (q >= 0 && !bm[q] && !seen[q]) { seen[q] = 1; stack.push(q); }
    }
    if (!touch && size >= 2) holes++;
  }
  return holes;
}

function bitmapFeatures(bm) {
  let top = 0, bot = 0;
  for (let y = 0; y < DIGIT_N; y++) {
    for (let x = 0; x < DIGIT_N; x++) {
      if (!bm[y * DIGIT_N + x]) continue;
      if (y < DIGIT_N / 2) top++; else bot++;
    }
  }
  const rowRatio = (y) => {
    let n = 0;
    for (let x = 0; x < DIGIT_N; x++) n += bm[y * DIGIT_N + x];
    return n / DIGIT_N;
  };
  return { holes: countHoles(bm), bottom: rowRatio(DIGIT_N - 1), topRow: rowRatio(0), topbot: top / (bot || 1) };
}

const tplCache = {};
function tplData(ch) {
  if (tplCache[ch]) return tplCache[ch];
  const bm = new Uint8Array(DIGIT_N * DIGIT_N);
  for (let i = 0; i < bm.length; i++) bm[i] = DIGIT_TEMPLATES[ch][i] === '1' ? 1 : 0;
  return (tplCache[ch] = { bm, f: bitmapFeatures(bm) });
}

/* 认一个数字：位图汉明距离 + 拓扑特征加权 */
function matchDigit(bm) {
  const f = bitmapFeatures(bm);
  let best = '?', bestScore = 1e9, second = 1e9;
  for (const ch of Object.keys(DIGIT_TEMPLATES)) {
    const t = tplData(ch);
    let ham = 0;
    for (let i = 0; i < bm.length; i++) if (bm[i] !== t.bm[i]) ham++;
    let pen = 0;
    pen += Math.abs(f.holes - t.f.holes) * 26;        // 孔洞对不上基本就是认错
    pen += Math.abs(f.bottom - t.f.bottom) * 30;      // 「1」的满底横 vs「7」的秃底
    pen += Math.abs(f.topRow - t.f.topRow) * 18;
    pen += Math.abs(f.topbot - t.f.topbot) * 10;
    const score = ham + pen;
    if (score < bestScore) { second = bestScore; bestScore = score; best = ch; }
    else if (score < second) second = score;
  }
  return { digit: best, score: Math.round(bestScore), confidence: Math.min(1, (second - bestScore) / 22) };
}

/* 在一段「数字 + 班」粘在一起的像素里，找出两者的分界 x。

   为什么需要：实测「14班」的「4」和「班」之间只空 1~2px，
   而数字内部（「1」的横与竖）能空到 6px。
   **字间距比笔画间距还窄**，所以「找空隙」和「总宽减汉字宽」这两类思路全都会翻车
   （都试过，不是推测）。

   可行思路：这一格只有「班」一个汉字，而**全图所有格子的「班」都是同一个字号**。
   先把已经能正常切开的格子量一遍：实测 12 格全部落在 21~22px，
   于是「汉字宽 21.5」就成了一个可用的基准。
   在段内滑切点，看「切出来的右边那块」有几条证据说明它是那个「班」：
     ① 宽度接近 21.5（最强证据，跨格子稳定）
     ② 高度接近整行高（汉字顶天立地，数字只占 0.6~0.7 行高）
     ③ 有长竖笔画（汉字特征）
   三条都是这张图里量出来的事实，不预设字体比例。

   返回分界 x（数字右边界）；找不到返回 0，由调用方放弃这一格。 */
function findHanBoundary(get, box, x0, x1) {
  const { y0, h } = box;
  const W = x1 - x0;
  if (W < 12) return 0;

  /* 整段的字高，作为「顶天立地」的参照 */
  const rowInk = (dy) => {
    let n = 0;
    for (let x = x0; x < x1; x++) if (get(x, y0 + dy)) n++;
    return n;
  };
  let top = 0, bot = h - 1;
  while (top <= bot && !rowInk(top)) top++;
  while (bot >= top && !rowInk(bot)) bot--;
  const H = bot - top + 1;
  if (H < 8) return 0;

  /* 「班」字宽度基准。21.5 是这张课表实测（12 个格子 21~22px 无一例外）。
     换成别的课表，字号不同，这个绝对值会变 —— 但它只用于「挑最像的那个切点」，
     不参与最后识别（数字仍由 16×16 模板认），差几像素不影响结论，
     所以不做过度的自学习，保持简单。 */
  const HAN_W = 21.5;

  const hanScore = (left, w) => {
    const a = x0 + left, b = x0 + left + w;
    if (w < 8) return -1e9;
    let t = -1, bo = -1;
    for (let dy = top; dy <= bot; dy++) {
      let n = 0;
      for (let x = a; x < b; x++) if (get(x, y0 + dy)) n++;
      if (n > 0) { if (t < 0) t = dy; bo = dy; }
    }
    if (t < 0) return -1e9;
    const bh = bo - t + 1;

    /* ① 宽度贴合度：偏离 21.5 每像素扣 0.35 分（权重最高） */
    const wPen = Math.abs(w - HAN_W) * 0.35;
    /* ② 高度贴合度：汉字应接近整段行高 */
    const hRatio = bh / H;
    /* ③ 长竖笔画比例 */
    let tall = 0;
    for (let x = a; x < b; x++) {
      let n = 0;
      for (let dy = t; dy <= bo; dy++) if (get(x, y0 + dy)) n++;
      if (n >= bh * 0.75) tall++;
    }
    return hRatio * 2 + (tall / w) * 1.5 - wPen;
  };

  let bestX = 0, bestScore = -1e9;
  /* 汉字在这段里的起点：从 30% 到 70%，右边那块是汉字 */
  for (let cut = Math.round(W * 0.3); cut <= Math.round(W * 0.7); cut++) {
    const wL = cut, wR = W - cut;
    if (wL < 6 || wR < 10) continue;
    /* 左侧（数字）必须能被拆成 1~3 位、每位 7~14px 的数字 */
    let digitOk = false;
    for (let n = 1; n <= 3; n++) {
      const w1 = wL / n;
      if (w1 >= 7 && w1 <= 14) { digitOk = true; break; }
    }
    if (!digitOk) continue;
    const sc = hanScore(cut, wR);
    if (sc > bestScore) { bestScore = sc; bestX = x0 + cut; }
  }
  /* 右边那块必须接近汉字宽度，否则说明这不是「数字+班」的结构 */
  if (bestX && Math.abs((x1 - bestX) - HAN_W) > 6) return 0;
  if (!bestX) return 0;

  /* 【把切点吸附到真实的笔画间隙】
     上面按「宽 21.5」挑出的切点只是**近似**：实测「14班」落在 x=62，
     但「4」其实到 58 就结束了、59~60 两列全空、「班」从 61 起。
     切在 62 会把「班」最左边的一竖带进数字块，于是 12px 的「4」被拉成 15px，
     16×16 一压就认成了「1」—— 而且置信度 0.81，看着还挺可信，最危险。
     所以再往左找一个「整列都没墨」的位置当切点：
     那才是笔画真正断开的地方。找不到就退回原切点。 */
  let snap = bestX;
  for (let x = bestX; x >= x0 + 6; x--) {
    let empty = true;
    for (let dy = top; dy <= bot; dy++) if (get(x, y0 + dy)) { empty = false; break; }
    if (empty) { snap = x; break; }
  }
  return snap;
}

/* 认一整格：「11班」→ { digits:'11', confidence:0.8 } */
function readClassNumber(get, w, h) {
  const box = innerBox(get, w, h);
  if (box.w < 8 || box.h < 8) return null;
  const segs = splitSegments(get, box);
  if (segs.length < 2) return null;      // 只有一段，多半是「班」或者没切开，不猜
  /* 【先排掉时间】合并单元格里常写「12:20-14:10」这种横跨多列的时间，
     切出来是一长串「窄段」（冒号、横杠、单数字混在一起）。
     真实班号最多 2 位数字 + 1 个「班」，段数不会超过 3。超过就一定不是班号。 */
  if (segs.length > 3) return null;
  /* 从右往左找「班」字：它一定是最宽的那一段（实测 21~36px，数字只有 8~12px）。
     不能拿中位数当基准——单字班号（如「5班」）只有两段，中位数恰好落在「班」上，
     一除就退到 -1，把答案也切掉了。所以直接用「最宽段」定位。 */
  const widths = segs.map(([a, b]) => b - a);
  const maxW = Math.max(...widths);

  /* 【切分】先把「班」定位出来：它是最宽的那一段。
     麻烦在于「4」和「班」会粘成一段（实测「14班」→ 9px + 36px），
     这时 36px 那段既含数字又含汉字。
     做法：从右往左扫，遇到「明显比最宽段窄」的段就在它右边截断（噪点）；
     然后看截断处这一段是不是「宽到可疑」——是的话按单位宽拆成数字 + 剩余。 */
  let cut = segs.length - 1;
  while (cut > 0 && widths[cut] < maxW * 0.85) cut--;   // 丢掉右侧残留噪点
  if (cut === 0) return null;

  const digitSegs = [];
  for (let i = 0; i < cut; i++) digitSegs.push(segs[i]);   // 「班」之前的都是数字

  /* 【数字和班粘连】「14班」是全流程唯一认不出的一格，排查过程值得留档：

       列投影（- 表示空白列）：
         #(「1」9px) --- #(「4」13px) -- #(「班」21px)
       段尾 36px 把「4」和「班」粘在一起，splitSegments 切不开。

     走过的弯路（都错，记下来免得再犯）：
       ① 按「数字宽」推算位数：unitW 用前面最小数字宽 = 8（「1」特别窄），
          round(32/8) - 2 = 2 → 拆成两位，认成「12」，还是高置信度的错值；
       ② 按「总宽 - 班宽」做减法：间隙余量累积，误差 2~3px 就把 12px 的「4」
          判成「2 位、每位 8px」，又错；
       ③ 调二值化阈值想让间隙变大：实测 150/165/128 都改变不了 ——
          「4」和「班」之间的空白只有 1~2px，而数字内部（「1」的横与竖）
          也有 4~6px 的空隙，**像素上根本区分不出「字间距」和「字内笔画间距」**。

     真正可靠的办法：不比宽度、不猜位数，直接**验证右侧那块是不是汉字**。
       汉字「班」的特征：比数字高、竖直笔画多、上下都顶格。
       在尾部段里滑动切点，找出「切完之后右边那块最像汉字」的位置，
       左边那块自然就是数字。这等于拿笔画本身当标尺，不依赖任何比例假设。
     验证不出来（比如字被裁了）就放弃，返回空让人填 —— 错班号比空更危险。 */

  const [tx0, tx1] = segs[cut];
  const tailW = tx1 - tx0;
  if (tailW > 26) {          // 明显比一个汉字宽 → 里面含数字
    const splitX = findHanBoundary(get, box, tx0, tx1);
    if (splitX > tx0 && tx1 - splitX >= 8) {
      digitSegs.push([tx0, splitX]);      // 左边：数字
      /* 右边是「班」，不参与数字识别 */
    } else {
      return { digits: '', confidence: 0, ragged: true };   // 找不到边界，交给人工
    }
  }
  if (!digitSegs.length) return null;

  let text = '', conf = 1, ragged = false;
  for (const [a, b] of digitSegs) {
    const bm = segToBitmap(get, box, a, b);
    if (!bm) { ragged = true; text += '?'; continue; }
    const m = matchDigit(bm);
    /* 置信度太低的不硬认，交给人工确认 —— 认错比不认更坑 */
    if (m.confidence < 0.35) { ragged = true; text += '?'; continue; }
    text += m.digit;
    conf = Math.min(conf, m.confidence);
  }
  /* 检出过「?」就整体作废：只要有一位没认准，班号就是错的，不能拿去填课表 */
  if (ragged) return { digits: '', confidence: 0, ragged: true };
  return { digits: text, confidence: conf, ragged: false };
}


/* 主入口：返回网格结构 + 每格是否有字 + 推测的节次/星期映射 + 班号猜测 */
export function detectTimetable(img) {  const { mono, w, h } = imageToMono(img);
  const { hs, vs } = findLines(mono, w, h);

  if (hs.length < 3 || vs.length < 3) {
    return { ok: false, reason: '没找到表格线。请截得正一点（别斜拍），或者把表格拍满一些。', w, h };
  }

  const rows = hs.length - 1;
  const cols = vs.length - 1;
  const pad = 5;   // 往里缩几像素，避开边框

  // 每格墨迹
  const ink = [];
  for (let r = 0; r < rows; r++) {
    ink.push([]);
    for (let c = 0; c < cols; c++) {
      const y0 = hs[r] + pad, y1 = hs[r + 1] - pad;
      const x0 = vs[c] + pad, x1 = vs[c + 1] - pad;
      ink[r].push((y1 > y0 && x1 > x0) ? cellInk(mono, w, y0, y1, x0, x1) : 0);
    }
  }

  // 有字的格子（阈值按格子面积缩放，图越大阈值越高，避免噪点误判）
  const cellW = (vs[vs.length - 1] - vs[0]) / cols;
  const cellH = (hs[hs.length - 1] - hs[0]) / rows;
  const area = cellW * cellH;
  const thr = Math.max(INK_MIN, Math.round(area * 0.004));

  const filled = (r, c) => ink[r][c] >= thr;

  /* 找表头行：第一行「几乎每列都有字」的那一行。
     课表表头就是「节次 / 时间 / 星期一 … 星期日」，全都有字。 */
  let headerRow = -1;
  for (let r = 0; r < Math.min(rows, 5); r++) {
    let cnt = 0;
    for (let c = 0; c < cols; c++) if (filled(r, c)) cnt++;
    if (cnt >= cols - 1) { headerRow = r; break; }
  }

  /* 【列角色的推断】不去假设「第一列一定是节次、第二列一定是时间」。
     真实截图经常缺边、左边被裁、前两列合成一格，按固定的位置猜必然翻车。
     改成看每一列的数据特征：

       节次列：几乎每一行都有字（1/2/3… 或者第1节/晚一），而且空行少
       星序列：有字的行只占一部分（只有排了课的行才有字）

     于是：从左往右，第一段「几乎每行都有字」的列都算前置列（节次/时间/序号），
     剩下的列就是星期。

     这一步错了也只是班级位置整体平移，界面上每行都能改星期，不会静默出错。 */
  const bodyStart = headerRow >= 0 ? headerRow + 1 : 0;
  const bodyRows = rows - bodyStart;
  let prefixEnd = 0;   // [0, prefixEnd) 是前置列
  for (let c = 0; c < cols; c++) {
    let cnt = 0;
    for (let r = bodyStart; r < rows; r++) if (filled(r, c)) cnt++;
    // 该列有字的行数 ≥ 70% 就认为是「节次/时间」这类每行都有的列
    if (bodyRows > 0 && cnt >= bodyRows * 0.7) prefixEnd = c + 1;
    else break;
  }
  // 全表都没排课时上面的循环会吃满，兜底留出第一列当节次
  if (prefixEnd >= cols) prefixEnd = Math.max(1, cols - 1);
  const firstDayCol = prefixEnd;

  /* 表头文字认不出（不做 OCR），按「第 N 列 = 周 N」的顺序推。 */
  const dayOrder = [1, 2, 3, 4, 5, 6, 7];
  const dayOfCol = [];
  for (let c = firstDayCol; c < cols; c++) dayOfCol[c] = dayOrder[c - firstDayCol] || 0;

  /* 【排除合并单元格行】课表里常有横跨整行的「午休 12:20-14:10」这种格子。
     它的行内，中间的竖线是断开的。测法：看每条竖线在该行带里是否贯通，
     断掉的列数过半，这一行就是合并行，整行跳过——里面装的是时间，不是课。 */
  const mergedRow = new Array(rows).fill(false);
  for (let r = 0; r < rows; r++) {
    const y0 = hs[r] + 3, y1 = hs[r + 1] - 3;
    if (y1 <= y0) continue;
    let broken = 0, checked = 0;
    for (let i = 1; i < vs.length - 1; i++) {   // 首尾两条是外框，不参与
      const x = vs[i];
      let dark = 0;
      for (let y = y0; y < y1; y++) {
        // 竖线是 1px 细线，取 ±1 范围里「有一点深色」就算贯通
        if (mono[y * w + x] || mono[y * w + (x - 1)] || mono[y * w + (x + 1)]) dark++;
      }
      checked++;
      if (dark < (y1 - y0) * 0.7) broken++;
    }
    mergedRow[r] = checked > 0 && broken >= checked * 0.5;
  }

  const cells = [];
  for (let r = bodyStart; r < rows; r++) {
    if (mergedRow[r]) continue;          // 合并行（午休、备注）整行不算课
    for (let c = firstDayCol; c < cols; c++) {
      if (!filled(r, c)) continue;
      const bx = vs[c], by = hs[r], bw = vs[c + 1] - vs[c], bh = hs[r + 1] - hs[r];
      /* 顺手认一下班号。用原图的 getter，不动 mono，避免额外内存 */
      let cls = null;
      try {
        cls = readClassNumber((x, y) => mono[(by + y) * w + (bx + x)], bw, bh);
      } catch { cls = null; }
      cells.push({
        row: r, col: c,
        weekday: dayOfCol[c] || 0,
        periodGuess: r - bodyStart + 1,
        box: { x: bx, y: by, w: bw, h: bh },
        classGuess: cls && cls.digits && cls.digits.indexOf('?') < 0 ? cls.digits : '',
        classConfidence: cls ? cls.confidence : 0,
      });
    }
  }

  return {
    ok: true,
    w, h,
    rows, cols,
    headerRow,
    firstDayCol,
    grid: { hs, vs },
    ink,
    thr,
    cells,
  };
}

/* ==========================================================================
   通用网格识别 —— 给考勤表之类的「规整表格」复用
   --------------------------------------------------------------------------
   课表和考勤表长得像：都是横竖线划出一格一格的表，每格里有字或没字。
   真正需要「懂课表」的只有后面那步（把列认成星期、把字认成班号），
   而「找线、切格、判断哪格有字」是完全通用的。

   所以这里把前半段单独导出来。考勤只关心「哪几格有 √」，不需要班号，
   调用它拿到网格和每格的墨量就够了。
   ========================================================================== */
export function detectGrid(img) {
  const { mono, w, h } = imageToMono(img);
  const { hs, vs } = findLines(mono, w, h);
  if (hs.length < 3 || vs.length < 3) {
    return { ok: false, reason: '没找到表格线。请截得正一点（别斜拍），或者把表格拍满一些。', w, h };
  }
  const rows = hs.length - 1;
  const cols = vs.length - 1;
  const pad = 5;
  const cellW = (vs[vs.length - 1] - vs[0]) / cols;
  const cellH = (hs[hs.length - 1] - hs[0]) / rows;
  const thr = Math.max(INK_MIN, Math.round(cellW * cellH * 0.004));

  const grid = [];
  for (let r = 0; r < rows; r++) {
    const line = [];
    for (let c = 0; c < cols; c++) {
      const y0 = hs[r] + pad, y1 = hs[r + 1] - pad;
      const x0 = vs[c] + pad, x1 = vs[c + 1] - pad;
      const n = (y1 > y0 && x1 > x0) ? cellInk(mono, w, y0, y1, x0, x1) : 0;
      line.push({ row: r, col: c, ink: n, filled: n >= thr, box: { x: vs[c], y: hs[r], w: vs[c + 1] - vs[c], h: hs[r + 1] - hs[r] } });
    }
    grid.push(line);
  }
  return { ok: true, w, h, rows, cols, grid, thr, mono, hs, vs };
}

/* 把某一格单独渲染成小图，用于人工核对（考勤里给「这格我认成了 √」做预览）。
   返回 dataURL；格子太小或没字返回 ''。 */
export function cellImage(img, box, scale = 2) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(box.w * scale));
  c.height = Math.max(1, Math.round(box.h * scale));
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
  g.drawImage(img, box.x, box.y, box.w, box.h, 0, 0, c.width, c.height);
  return c.toDataURL('image/png');
}
