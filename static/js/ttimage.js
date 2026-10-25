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
    // 亮度阈值：把「深色」算 1。彩色文字（蓝/紫）亮度也不高，能一并抓住
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

   模板来自真实课表格子里的 9 个数字，不是手画的。
   ========================================================================== */
const DIGIT_N = 16;   /* 16×16：8×8 下「6」「8」的左下开口会被抹平，实测会串号 */
/* 位图，'1' = 有墨。行优先，16×16 = 256 位。前 9 个取自真实课表截图，'4' 按印刷体补画 */
const DIGIT_TEMPLATES = {
  0: '0000011111110000000111110111110000111100011111001111100000001111111110000000111111111000000011111111100000001111111110000000111111111000000011111111100000001111111110000000111111111000000011110011110000111110000111110111110000000111111100000000001111100000',
  1: '0000000111100000001111111110000011111111111000000000011111100000000000111110000000000011111000000000001111100000000000111110000000000011111000000000001111100000000000111110000000000011111000000000001111100000000000111110000000001111111110001111111111111111',
  2: '0000111111111000001111111111111011111000000111111111100000011111111100000001111100000000000111110000000000011111000000000011111000000000111110000000000111110000000001111100000000001111000000000011111000000000111110000000011111111000000111111111111111111111',
  3: '0001111111111110001111111111111111111100000011111111100000001111111110000001111100000000011111100000001111111110000000111111100000000011111111000000000000111110000000000000111100000000000011111111100000001111111110000000111100111100000011110001111111111110',
  4: '0000000111100000000000111110000000000111111000000000111110111100000111110001111000111110000011110111110000001111111110000000111111111000000011111111111111111111111111111111111111111111111111100000000000001111000000000000111100000000000011110000000000011111',
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

  /* 【数字和班粘连】正常「班」字约 2 个数字宽（实测数字 9~12px、班 21~22px）。
     如果尾部这一段宽到 2.6 个数字以上，说明里面还塞了一个数字，先拆出来。 */
  const unitW = (() => {
    const dw = widths.slice(0, cut);
    return dw.length ? Math.min(...dw) : Math.max(6, Math.round(widths[cut] / 2.2));
  })();
  const tailW = widths[cut];
  if (tailW > unitW * 2.4) {
    const nDigit = Math.round(tailW / unitW) - 2;      // 减掉「班」占的约 2 份（实测 36/9-2=2）
    if (nDigit >= 1 && nDigit <= 3) {
      const step = tailW / (nDigit + 2);
      for (let i = 0; i < nDigit; i++) {
        digitSegs.push([Math.round(segs[cut][0] + i * step), Math.round(segs[cut][0] + (i + 1) * step)]);
      }
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
  return { digits: text, confidence: ragged ? 0 : conf, ragged };
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
