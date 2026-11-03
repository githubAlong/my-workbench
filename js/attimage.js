/* ============ 考勤表图片识别 ============
 * 目标是让「拍张照 / 截个图」也能导入考勤表，跟课表那边一个体验。
 *
 * 和课表识别的区别：
 *   课表要认「11班」里的数字 —— 有 10 个模板就够，可以硬认。
 *   考勤要认「姓名」一列的中文 —— 没有 OCR 引擎，硬认不现实。
 *
 * 所以这里换策略：**认清结构，不认字**。
 *   1. 找表格线，切成格子（直接复用 ttimage 的通用网格识别）。
 *   2. 判断每一列是什么角色：序号 / 姓名 / 学科 / 勾选列。
 *      靠的是「列的统计特征」，不是认列名文字：
 *        序号列：几乎每行都有字，且每格都很窄（1~3 个数字）
 *        姓名列：几乎每行都有字，格子里的墨最多（2~3 个汉字）
 *        学科列：大多数行有字，墨量中等（2 个汉字）
 *        勾选列：**大部分行是空的**，有字的也只是很小的一个勾
 *      这几条在真实表格里非常稳定，因为人事表就是这么排的。
 *   3. 勾选列里判断每格是 √ / × / 空。
 *      √ 和 × 的形状差别很大：√ 是「先降后升」的一笔，× 是两条交叉对角线。
 *      用笔画方向统计就能分开，不需要模板。
 *
 * 姓名本身**不做识别**，直接留空由人填 —— 老师对着表格原件敲名字，
 * 比纠正一个认错的字快得多。而且名字认错是事故，认不出只是麻烦。
 */

import { detectGrid, detectGridPhoto, cellImage, cellImagePhoto } from './ttimage.js';

/* 勾选列的默认清单，跟表格里那五列一一对应 */
const CHECK_KEYS = [
  { key: 'k_上课', label: '上课' },
  { key: 'k_坐班', label: '坐班' },
  { key: 'k_听课', label: '听课' },
  { key: 'k_教研', label: '教研' },
  { key: 'k_请假', label: '请假' },
];

/* 一格里「字」的判定：去掉边框后还剩多少墨。
   表格线已经切在格子边界上，但 1px 的线会被算进格子里，所以先剥边。 */
function cellInkStats(mono, w, box) {
  const { x, y, w: bw, h: bh } = box;
  const pad = 2;
  const x0 = x + pad, x1 = x + bw - pad;
  const y0 = y + pad, y1 = y + bh - pad;
  if (x1 <= x0 || y1 <= y0) return { ink: 0, wSpan: 0, hSpan: 0, density: 0 };
  let n = 0, minX = 1e9, maxX = -1, minY = 1e9, maxY = -1;
  for (let yy = y0; yy < y1; yy++) {
    const base = yy * w;
    for (let xx = x0; xx < x1; xx++) {
      if (!mono[base + xx]) continue;
      n++;
      if (xx < minX) minX = xx;
      if (xx > maxX) maxX = xx;
      if (yy < minY) minY = yy;
      if (yy > maxY) maxY = yy;
    }
  }
  if (!n) return { ink: 0, wSpan: 0, hSpan: 0, density: 0 };
  return {
    ink: n,
    wSpan: maxX - minX + 1,       // 墨迹横向跨度
    hSpan: maxY - minY + 1,       // 墨迹纵向跨度
    density: n / ((x1 - x0) * (y1 - y0)),
    bx: minX, by: minY, bw: maxX - minX + 1, bh: maxY - minY + 1,
  };
}

/* 判断一个格子里是 √ / × / 空 / 认不准（'?'）。
   思路：把墨迹位图按对角线方向做「连续性」检验。
     ×：两条对角线都几乎全是墨（\ 和 / 各一条直贯）
     √：只有「左下到中下」一小段 + 「中下到右中」一条斜线，左上角基本是空的
   实测 √ 的左上区域总是空的，× 的左上角一定有墨 —— 就靠这一点分开。

   【为什么要有 '?' 这一档】
   早先认不准时直接 return '√'，理由是「宁可多记让人划掉」。
   真实打印件/照片带扫描噪点，这个默认会把整列 √ 全判错，
   **而且用户完全看不出来** —— 错得比空着更危险。
   现在认不准就返回 '?'，界面上标黄，人不确认就不许导入。 */
export function classifyMark(mono, w, st) {
  if (!st.ink || st.wSpan < 4 || st.hSpan < 4) return '';
  const { bx, by, bw, bh } = st;
  /* 网格分成 5×5 小格，看每格有没有墨，做粗略形状描述 */
  const G = 5;
  const cell = [];
  for (let gy = 0; gy < G; gy++) {
    cell.push(new Array(G).fill(0));
    const y0 = by + Math.floor(gy * bh / G), y1 = by + Math.max(Math.floor((gy + 1) * bh / G), Math.floor(gy * bh / G) + 1);
    for (let gx = 0; gx < G; gx++) {
      const x0 = bx + Math.floor(gx * bw / G), x1 = bx + Math.max(Math.floor((gx + 1) * bw / G), Math.floor(gx * bw / G) + 1);
      let n = 0;
      for (let yy = y0; yy < Math.min(y1, by + bh); yy++) {
        const base = yy * w;
        for (let xx = x0; xx < Math.min(x1, bx + bw); xx++) if (mono[base + xx]) n++;
      }
      cell[gy][gx] = n >= 2 ? 1 : 0;
    }
  }
  const has = (gy, gx) => cell[gy] && cell[gy][gx];

  /* 左上角 2×2 有没有墨：× 有（左上到右下的那一撇起点在这），√ 基本没有 */
  const topLeft = (has(0, 0) ? 1 : 0) + (has(0, 1) ? 1 : 0) + (has(1, 0) ? 1 : 0) + (has(1, 1) ? 1 : 0);
  /* 右上角 2×2：× 有（右上到左下的起点），√ 也没有 */
  const topRight = (has(0, 3) ? 1 : 0) + (has(0, 4) ? 1 : 0) + (has(1, 3) ? 1 : 0) + (has(1, 4) ? 1 : 0);
  /* 底部中间：√ 的转折点在这一带 */
  const bottomMid = (has(3, 2) ? 1 : 0) + (has(4, 1) ? 1 : 0) + (has(4, 2) ? 1 : 0);

  /* × 的两头都在上方，且左下也有；√ 上方只有右侧斜线起笔 */
  const diagA = (has(0, 0) ? 1 : 0) + (has(1, 1) ? 1 : 0) + (has(2, 2) ? 1 : 0) + (has(3, 3) ? 1 : 0) + (has(4, 4) ? 1 : 0);
  const diagB = (has(0, 4) ? 1 : 0) + (has(1, 3) ? 1 : 0) + (has(2, 2) ? 1 : 0) + (has(3, 1) ? 1 : 0) + (has(4, 0) ? 1 : 0);

  /* 【2026-10 重写】老判据只看 5×5 网格的「有没有墨」，对粗笔画的勾直接失效：
     手写勾线宽 5px 时，一笔下去会把经过的小格全填满，
     左上角（√ 本该是空的）也被带上了墨 → topLeft 不再 ≤1，
     反过来对角线格全亮 → diagA/diagB 都 ≥4 → 判成 ×。
     用户那张表里 9 个勾全被认成 ×，就是这个原因。

     现在补两条和线宽无关的判据：
       · 重心位置：√ 的墨偏向下方（长尾在右上，但主体压在底部），
         × 的墨上下对称，重心基本在正中。
       · 底部宽度：√ 在底部分叉成两个端点，最底几行的墨是「两撮」；
         × 底部是两条斜线收口，也是两撮 —— 但 × 顶部同样两撮且分离更远。
       所以最后用「顶部 vs 底部的左右跨度」比较：× 上下都宽（X 形），
       √ 上窄下宽（对勾形）。这一条对粗细都不敏感。 */
  const rowSpan = (gy) => {
    let lo = -1, hi = -1;
    for (let gx = 0; gx < G; gx++) if (has(gy, gx)) { if (lo < 0) lo = gx; hi = gx; }
    return lo < 0 ? 0 : hi - lo + 1;
  };
  const topSpan = Math.max(rowSpan(0), rowSpan(1));
  const botSpan = Math.max(rowSpan(3), rowSpan(4));
  /* 重心：按行的墨量加权，0 = 顶，1 = 底 */
  let wsum = 0, ysum = 0;
  for (let gy = 0; gy < G; gy++) {
    let rowInk = 0;
    for (let gx = 0; gx < G; gx++) rowInk += has(gy, gx) ? 1 : 0;
    wsum += rowInk; ysum += rowInk * (gy + 0.5) / G;
  }
  const cy = wsum ? ysum / wsum : 0.5;

  /* × 的两条对角线基本都在，且上下都宽 */
  if (diagA >= 4 && diagB >= 4 && topSpan >= 4 && botSpan >= 4 && Math.abs(cy - 0.5) < 0.13) return '×';
  /* √：上面窄、下面宽，重心偏下 */
  if (botSpan >= 3 && topSpan <= 3 && cy >= 0.48) return '√';
  if (topLeft <= 1 && bottomMid >= 1 && diagB >= 2) return '√';
  if (topRight === 0 && topLeft <= 1 && bottomMid >= 1) return '√';
  /* 到这一步还是「上宽下也宽、重心居中」→ 大概率是 × */
  if (diagA >= 3 && diagB >= 3 && topSpan >= 3 && botSpan >= 3) return '×';

  /* 到这一步说明形状介于两者之间 —— 可能是手写体、噪点、或者根本不是勾叉（比如写了「√√」或打了个点）。
     不再猜，交给人看。 */
  return '?';
}

/* 按列的统计特征推断角色。
   返回每列一个标签：'idx' | 'name' | 'subject' | 'check'

   ==== 为什么不能用「每格墨量」分档（2026-10 真机踩坑）====
   老实现假设「一个勾的墨量约 107，汉字 200+」，于是用绝对阈值 HAN_INK=190
   把列分成「文字 / 勾选」两类。这个假设在**用户真实的表**上直接崩了：

       序号   姓名   学科   上午   下午   晚自习   备注
        122    918    626    290    290     290    1120    ← 中位墨量
        idx   subject subject subject subject subject  name   ← 老算法结果

   同一张表，我生成的测试图里一个勾是 290，而老注释里录的是 107。
   差别只来自**线宽**（手写 5px vs 印刷 2px）—— 勾的墨量会随线宽变化 3 倍以上，
   但汉字和勾的墨量区间因此重叠，任何固定阈值都会在别的表上翻车。
   「备注」列因为字多（1120）反而被当成了姓名列，整表角色全错。

   现在改成**不看墨量看形状**，用两个和线宽无关的特征：
     ① 离散度 = 平均每格墨量分布有多集中。
        一个勾/叉是一笔细线，墨均匀摊在整个格子里；
        汉字有一堆分离的笔画（横竖撇捺），局部浓、局部空。
        用「每格外接框内墨量 / 外接框面积」和「5×5 小格里有墨的格数」联合判断。
     ② 长宽比。汉字接近方块（0.6~1.8），斜线勾叉接近 1 但笔画更细（见 ①）。

   更稳的一条是 ③：**勾选列的墨量几乎相同**。
   同一张表里所有勾是同一只手画的，标准差极小；汉字列因人因字而异，离散大。
   实测：勾选列 medInk 290/290/290 完全一致，文字列 122/626/918/1120 拉开好几个档。
   这条对「凑巧线很粗」的表尤其有效，所以作为主判据之一。
*/
export function inferColumnRoles(grid, rows, cols) {
  const stats = [];
  for (let c = 0; c < cols; c++) {
    const inks = [];
    const ratios = [];   // 每格墨量占外接框面积的比例，用来描述「笔画密度」
    const fills = [];    // 每格 5×5 小格里有墨的格数占比
    for (let r = 1; r < rows; r++) {
      const cell = grid[r][c];
      if (!cell || cell.ink <= 0) continue;
      inks.push(cell.ink);
      const area = Math.max(1, (cell.bw || 1) * (cell.bh || 1));
      ratios.push(cell.ink / area);
      if (cell.cellFill != null) fills.push(cell.cellFill);
    }
    inks.sort((a, b) => a - b);
    const med = inks.length ? inks[Math.floor(inks.length / 2)] : 0;
    /* 墨量的一致性：中位绝对偏差 / 中位值。勾选列接近 0，文字列明显大 */
    const mad = inks.length
      ? inks.reduce((s2, v) => s2 + Math.abs(v - med), 0) / inks.length / Math.max(1, med)
      : 1;
    stats.push({
      col: c,
      fillRate: rows > 1 ? inks.length / (rows - 1) : 0,
      avgInk: inks.length ? inks.reduce((a, b) => a + b, 0) / inks.length : 0,
      medInk: med,
      mad,
      inkRatio: ratios.length ? ratios.reduce((a, b) => a + b, 0) / ratios.length : 0,
      cellFill: fills.length ? fills.reduce((a, b) => a + b, 0) / fills.length : 0,
      n: inks.length,
    });
  }

  const roles = new Array(cols).fill('check');
  /* 有字的列（任何墨都算） */
  const inked = stats.filter((s) => s.medInk > 0 && s.n > 0);

  /* ================= 判据选择（实测数据说话） =================
     在同一张真实表上量到的六个指标，逐个数一遍它们为什么**不能**单独用：

       col  内容    med  fill   mad   ratio cellFill
        0   序号    122  1.00  0.072  0.394   0.09
        1   姓名    918  1.00  0.064  0.366   0.34
        2   学科    626  1.00  0.096  0.354   0.35
        3   上午√   290  0.83  0.012  0.227   0.18
        4   下午√   290  1.00  0.010  0.224   0.19
        5   晚自习√ 290  0.83  0.000  0.212   0.20
        6   备注   1120  0.50  0.000  0.339   0.36

     · fill（有字率）：「下午」整列都打了勾 → 1.00，和姓名列一样。废。
     · mad（墨量离散度）：备注列 0.000，比勾选列还整齐（因为它只有 3 行，
       而且那 3 行都是同样四个字「请假已补」）。废。
     · ratio（墨/框面积）：勾 0.21~0.23，姓名 0.37。能分开，但差得不够远，
       遇到笔画少的姓名（两字）会和粗勾重叠。只当辅助。
     · cellFill（5×5 里有墨的格占比）：勾 0.18~0.20，汉字 0.34~0.36。
       这是**最干净的一条**，差了一倍。但备注列 0.36 会把「姓名」的位置抢走。

     真正稳的是两条「结构性」事实，它们不依赖任何绝对数值：
       ① 表格里**姓名列一定在最靠左的文字列**（序号右边第一列）。
          所以先定姓名，再谈别的 —— 老代码按墨量取最大当姓名，
          备注字多就抢走了，用户那张表就是这么错的。
       ② 勾选列的墨量彼此**完全相同**（290/290/290），因为它们是同一个字形的复制；
          文字列的墨量参差不齐（122/626/918/1120）。
          用「这一列的墨量是否等于所有列里出现次数最多的那个值」来判。
     */
  if (!inked.length) return { roles, stats, textCols: [] };

  /* ① 墨量众数：勾选列的墨量会高度聚集在同一个值上 */
  const buckets = new Map();
  inked.forEach((s) => {
    const k = Math.round(s.medInk / 12);      // 12 像素一档，容忍轻微抖动
    buckets.set(k, (buckets.get(k) || 0) + 1);
  });
  let modeKey = null; let modeCnt = 0;
  buckets.forEach((cnt, k) => { if (cnt > modeCnt) { modeCnt = cnt; modeKey = k; } });
  /* 至少两列共享同一个墨量档，才认为「这是勾选列」 */
  const modeInk = modeKey == null ? -1 : modeKey * 12;

  /* ② 找姓名列：最靠左、且 cellFill 明显高于「线条类」的那一列。
     先算一个 cellFill 的中位数当基准，低于它一半的视为线条（勾/序号）。 */
  /* cellFill 天然是**双峰**的：线条类（勾、序号）挤在低处，文字类挤在高处。
     所以不要用「中位数 × 系数」—— 中位数往往正好落在勾这一峰上
     （勾选列通常比文字列多），乘个 0.72 反而把阈值压到勾的下面，
     一列都分不出来（实测就是这样：阈值 0.144，勾是 0.18~0.20，全漏）。
     正确做法是找这两峰之间**最宽的空隙**：把值排序后，相邻差最大的那个断点
     就是分界。只要两峰之间有空隙，这个断点一定落在空隙里，不受各峰人数影响。 */
  const cfSorted = inked.map((s) => s.cellFill).sort((a, b) => a - b);
  let gapAt = -1; let gapMax = 0;
  for (let i = 1; i < cfSorted.length; i++) {
    const d = cfSorted[i] - cfSorted[i - 1];
    if (d > gapMax) { gapMax = d; gapAt = i; }
  }
  /* 空隙够大（0.06 以上）才认为存在两峰；否则这批列同质，按「没有线条类」处理 */
  const hasTwoModes = gapMax >= 0.06 && gapAt > 0 && gapAt < cfSorted.length;
  const cfSplit = hasTwoModes ? (cfSorted[gapAt - 1] + cfSorted[gapAt]) / 2 : -1;
  const isLine = (s) => hasTwoModes && s.cellFill < cfSplit;

  /* 文字候选：不是「线条」的列 */
  const textCand = inked.filter((s) => !isLine(s));
  const nameCol = textCand.length ? textCand.slice().sort((a, b) => a.col - b.col)[0].col : -1;

  /* 序号列：姓名左边、每行都有字、墨量比姓名小很多 */
  if (nameCol > 0) {
    for (const s of inked) {
      if (s.col >= nameCol) break;
      if (s.fillRate >= 0.85 && nameCol >= 0 && s.medInk < 400) roles[s.col] = 'idx';
    }
  }

  /* 逐列定角色 */
  const textCols = [];
  for (const s of inked) {
    if (roles[s.col] === 'idx') continue;
    if (s.col === nameCol) { roles[s.col] = 'name'; textCols.push(s); continue; }
    /* 勾选列：墨量落在众数档，且 cellFill 偏小 */
    const nearMode = modeCnt >= 2 && Math.abs(s.medInk - modeInk) <= 12 && isLine(s);
    if (nearMode) { roles[s.col] = 'check'; continue; }
    if (!isLine(s)) { roles[s.col] = 'text'; textCols.push(s); continue; }
    /* 剩下的细线条：多半是只打了个点或半个勾，按勾选列处理 */
    roles[s.col] = 'check';
  }

  /* 文字列（姓名右边）分学科 / 备注：靠左的是学科，墨量明显更大的是备注 */
  const rights = textCols.filter((s) => s.col > nameCol).sort((a, b) => a.col - b.col);
  rights.forEach((s, i) => {
    if (i === 0) roles[s.col] = 'subject';
    else {
      const prev = rights[i - 1];
      roles[s.col] = s.medInk > prev.medInk * 1.5 ? 'note' : 'subject';
    }
  });
  return { roles, stats, textCols };
}

/* 判断一张图是不是「纯白底的截图」。
   采样 96×96 个点算亮度中位数：截图的白底占绝大多数 → 中位数 250+；
   手机拍照即便补光，纸面也到不了 245（有纸纹、有暗角、有阴影）。 */
function looksLikeScreenshot(img) {
  const w = img.naturalWidth || img.width || 0;
  const h = img.naturalHeight || img.height || 0;
  if (!w || !h) return true;
  const N = 96;
  const c = document.createElement('canvas');
  c.width = N; c.height = N;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0, N, N);
  const d = g.getImageData(0, 0, N, N).data;
  const lum = [];
  for (let i = 0; i < d.length; i += 4) lum.push(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
  lum.sort((a, b) => a - b);
  const med = lum[lum.length >> 1];
  return med > 242;
}

/* 主入口：传 <img> 或 ImageBitmap，返回跟 CSV 识别同样结构的结果 */
export function detectAttendance(img, opts = {}) {
  /* 【照片 vs 截图自动分流】
     手机拍的照必须先做「方向判定 + 倾斜校正 + 局部二值化」，
     直接走 detectGrid（全局阈值）在照片上必然失败。

     【判据不能只看尺寸】早先用「宽高都 > 900」当判据，
     结果导出的表格图、横向截图也被当照片走了一遍重流程，反而认错。
     真正的区别是**背景**：截图是纯白底（整图亮度中位数 250+），
     照片总有纸面色偏、阴影、桌面，亮度中位数在 150~230。
     所以：先量亮度中位数，>242 当截图，否则当照片。
     尺寸只作兜底 —— 小图（<400px）不可能有可读文字，两种都不灵。 */
  const iw = img.naturalWidth || img.width || 0;
  const ih = img.naturalHeight || img.height || 0;
  const g = (iw >= 400 && ih >= 400 && !looksLikeScreenshot(img))
    ? detectGridPhoto(img, opts)
    : detectGrid(img);
  if (!g.ok) return { ok: false, reason: g.reason };

  const { rows, cols, grid, mono, hs, vs } = g;
  if (rows < 2 || cols < 2) {
    return { ok: false, reason: '表格太小，没切出数据行。请把整张表拍进画面。' };
  }

  /* 表头行：第一行通常是「序号 姓名 学科 上课 坐班…」，整行几乎每格都有字。
     找不到就当没有表头，从第 0 行开始读（有些表直接就是名单）。

     【为什么不是简单的「每格都有字」】
     表头最后一格可能是空的（比如「备注」那列没字），或者某个格子里是
     「上课/坐班」这种两字标题，墨量不高但确实有字。所以判据放宽成
     「有字的格数 ≥ 列数 - 1」，但**必须同时要求这一行不是勾选行** ——
     真实表里偶尔会出现「整行都打勾」的一行，那种行每格都有墨，
     按旧规则会被误判成表头，然后整行数据被吃掉。
     勾的形状墨量明显小于汉字，用中位墨量区分。 */
  const rowInkMed = (r) => {
    const inks = grid[r].filter((c) => c.ink > 0).map((c) => c.ink).sort((a, b) => a - b);
    return inks.length ? inks[Math.floor(inks.length / 2)] : 0;
  };
  let headerRow = -1;
  let bestScore = 0;
  for (let r = 0; r < Math.min(3, rows); r++) {
    const cnt = grid[r].filter((c) => c.filled).length;
    if (cnt < cols - 1) continue;
    /* 整行都有字，但墨量太小 → 更像是「整行打勾」，不是表头 */
    if (rowInkMed(r) < 90) continue;
    /* 几行都像表头时，选「墨量最接近汉字」的那一行：
       表头是印刷体标题，笔画比勾多；数据行里混着的勾会把中位数拉低。 */
    const score = rowInkMed(r) - r;      // 同一行墨量高者优先；墨量接近时取靠前的
    if (score > bestScore) { bestScore = score; headerRow = r; }
  }
  const bodyStart = headerRow >= 0 ? headerRow + 1 : 0;
  if (rows - bodyStart < 1) {
    return { ok: false, reason: '只看到表头，没有数据行。' };
  }

  /* 角色推断只在数据行上做 */
  const sub = grid.slice(bodyStart);
  const { roles, stats } = inferColumnRoles(sub, sub.length, cols);

  const nameCol = roles.indexOf('name');
  const subjCol = roles.indexOf('subject');
  const checkCols = [];
  roles.forEach((role, c) => { if (role === 'check') checkCols.push(c); });

  if (nameCol < 0) {
    return { ok: false, reason: '没找到姓名列。请确认表格最左边几列里有「姓名」这一栏。' };
  }
  if (!checkCols.length) {
    return { ok: false, reason: '没找到可以打勾的列。这张表里除了文字列，没有空着的勾选列。' };
  }

  /* 勾选列最多 5 个，多了说明列判断跑偏，截前 5 个 */
  const useChecks = checkCols.slice(0, CHECK_KEYS.length);

  /* 逐行产出。
     【姓名怎么办】没有 OCR，认不出手写名字，但空着又没法直接入库
     （后端遇到空 teacher 会跳过，整张表就废了）。
     折中：**按名册顺序铺名字**。学校这类表的排法基本是「按学科、按名册顺序」，
     铺上以后老师只需要改个别顺序，比从零敲 46 个名字快得多。
     铺的时候留两个记号给确认页：
       • rosterName = 名册里对应的名字（可能错，需要人核）
       • srcRow     = 原图第几行，方便对着原件看 */
  const roster = opts.roster || [];
  const outRows = [];
  const cellsForPreview = [];
  let filledIdx = 0;
  let unsureCount = 0;
  for (let i = 0; i < sub.length; i++) {
    const r = sub[i];
    /* 整行都没字（空行 / 合计行下面的空白）就跳过 */
    if (!r.some((c) => c.filled)) continue;
    const data = {};
    const marks = {};          // 原样保留 √/×/?/''，给确认页逐格对照用
    let anyMark = false;
    /* 【先攒本行的格子，等确认这行要收再去 push】
       早先是循环里直接 cellsForPreview.push({ row: i, ... })，用的是「未跳过」的下标 i；
       而 outRows 只收有勾的行。原表里只要有一整行没打勾（空行、合计行、只有名字的行），
       两套下标就错位，确认页「原图」那列显示的会是别人的格子。
       现在统一成「outRows 里的第几个 = 预览里的第几个」。 */
    const rowCells = [];
    useChecks.forEach((c, k) => {
      const st = cellInkStats(mono, g.w, r[c].box);
      const mark = classifyMark(mono, g.w, st);
      marks[CHECK_KEYS[k].key] = mark;
      /* '?' 不写进 data —— 宁可留空让确认页标黄，也不假装它是 √ */
      if (mark === '√') { data[CHECK_KEYS[k].key] = '1'; anyMark = true; }
      else if (mark === '×') { data[CHECK_KEYS[k].key] = '0'; anyMark = true; }
      else if (mark === '?') { anyMark = true; unsureCount++; }
      rowCells.push({ col: c, mark, key: CHECK_KEYS[k].key, box: r[c].box });
    });
    /* 一个勾都没有的行，多半是表尾（制表人/审核）或空白，不当教师行 */
    if (!anyMark) continue;
    const guess = roster[filledIdx] || null;
    const outIdx = outRows.length;
    rowCells.forEach((x) => cellsForPreview.push({ row: outIdx, ...x }));
    outRows.push({
      /* 铺名册名字；名册不够长就写「第N行」占位，让老师知道这里要改 */
      teacher: guess ? guess.name : `（第${bodyStart + i + 1}行）`,
      subject: guess ? (guess.subject || '') : '',
      data,
      marks,
      _srcRow: bodyStart + i,
      _guessed: !!guess,        // true = 名字是按名册猜的，要核对
    });
    filledIdx++;
  }

  if (!outRows.length) {
    return { ok: false, reason: '表格切出来了，但没找到任何勾（√ 或 ×）。请确认拍的是填好的那张表。' };
  }

  const columns = [
    ...useChecks.map((c, k) => ({ key: CHECK_KEYS[k].key, label: CHECK_KEYS[k].label, type: 'check', w: 62 })),
    { key: 'k_remark', label: '备注', type: 'text', w: 130 },
  ];

  return {
    ok: true,
    source: 'image',
    /* 给 confirmSheet 用的元信息。日期/节次从图上看不出来（要么在表头文字里，
       要么在标题上），留空让人选，不瞎猜。 */
    detected: { grade: opts.grade || '', columns, sheet_type: opts.sheetType || 'seat', year: '', month: '', day: '', periods: '' },
    columns,
    rows: outRows,
    stats: {
      teachers: outRows.length,
      subjects: 0,
      image: true,
      rows: rows,
      cols: cols,
      nameCol,
      checkCols: useChecks,
      checkKeys: useChecks.map((_, k) => CHECK_KEYS[k].key),
      checkLabels: useChecks.map((_, k) => CHECK_KEYS[k].label),
      unsure: unsureCount,
      roleStats: stats.map((s) => ({ col: s.col, role: roles[s.col], fill: Math.round(s.fillRate * 100), ink: Math.round(s.avgInk) })),
    },
    _preview: { cells: cellsForPreview, w: g.w, h: g.h, scale: g.scale || 1 },
  };
}
