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

import { detectGrid, cellImage } from './ttimage.js';

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

/* 判断一个格子里是 √ / × / 空。
   思路：把墨迹位图按对角线方向做「连续性」检验。
     ×：两条对角线都几乎全是墨（\ 和 / 各一条直贯）
     √：只有「左下到中下」一小段 + 「中下到右中」一条斜线，左上角基本是空的
   实测 √ 的左上区域总是空的，× 的左上角一定有墨 —— 就靠这一点分开。 */
function classifyMark(mono, w, st) {
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

  if (diagA >= 4 && diagB >= 4) return '×';         // 两条对角线都在 → ×
  if (topLeft === 0 && bottomMid >= 1) return '√';  // 左上空 + 底部有转折 → √
  if (topRight === 0 && topLeft <= 1) return '√';
  /* 实在分不清就当作有勾（宁可多记一笔，让人去划掉；漏记会变成「没做」） */
  return '√';
}

/* 按列的统计特征推断角色。
   返回每列一个标签：'idx' | 'name' | 'subject' | 'check'

   【怎么判断，以及为什么不能用「有字率」】
   实测一张 10 行的真实排版表，每格墨量是这样的（节选）：
       序号  姓名  学科  上课  坐班  听课  教研  请假  备注
        45   371   239   107   107   153   107   107     0
        57   220   239   107   107   107   107   107     0
        63   252   239   107   153     0   153   107     0
   注意三件事：
     ① 一个勾（√）的墨量几乎是常数 107，叉（×）是 153 —— 因为它们是同一个字形放大缩小。
     ② 汉字名的墨量 220~410，比勾大一个量级。
     ③ 序号只有 44~66，比勾还小。
   所以单看「这格有没有字」区分不开（序号 45 也挺小），
   但看**墨量档位**一目了然：几十 = 序号，一百多 = 勾，两百以上 = 汉字。

   早先我用「有字率 ≥ 某比例」判断，遇到勾得比较满的表就整列误判 ——
   而且序号列墨量低，直接判成空格，连带姓名列的位置也错。
   现在改成按**每列的中位墨量**来分档，因为中位数不受个别空格影响。 */
function inferColumnRoles(grid, rows, cols) {
  const stats = [];
  for (let c = 0; c < cols; c++) {
    const inks = [];
    for (let r = 1; r < rows; r++) {
      const cell = grid[r][c];
      if (cell.ink > 0) inks.push(cell.ink);
    }
    inks.sort((a, b) => a - b);
    const med = inks.length ? inks[Math.floor(inks.length / 2)] : 0;
    stats.push({
      col: c,
      fillRate: rows > 1 ? inks.length / (rows - 1) : 0,
      avgInk: inks.length ? inks.reduce((a, b) => a + b, 0) / inks.length : 0,
      medInk: med,
    });
  }

  const roles = new Array(cols).fill('check');
  /* 汉字列的判定：中位墨量明显高于「一个勾」。
     勾约 107、叉约 153，汉字少说 200+。这里用 190 当分界，
     并且要求这一列至少一半的行都有字（勾选列总有不少空格）。 */
  const HAN_INK = 190;
  const textCols = stats.filter((s) => s.medInk >= HAN_INK && s.fillRate >= 0.5);

  /* 【序号列要单独捞】
     序号只有一两位数字，墨量 44~66，比一个勾（107）还低，
     按上面的墨量门线会被判成勾选列。但它有个勾选列绝不会有特征：
     **每一行都有字**（fillRate = 100%）。勾选列再满也总有几个空格。
     所以：如果文字列左边还有一列「几乎每行都有字」，那它就是序号。 */
  const textMinCol = textCols.length ? Math.min(...textCols.map((s) => s.col)) : cols;
  for (let c = 0; c < textMinCol; c++) {
    const s = stats[c];
    if (s && s.fillRate >= 0.85 && s.medInk > 0) {
      roles[c] = 'idx';
    }
  }

  /* 文字列里再分姓名 / 学科：
       姓名列墨最多（2~3 个汉字），学科列居中。
       只有一列文字就是姓名；多于两列时，墨量最大的当姓名，
       夹在序号和姓名之间的都算学科。 */
  const ranked = textCols.slice().sort((a, b) => a.medInk - b.medInk);
  if (ranked.length === 1) {
    roles[ranked[0].col] = 'name';
  } else if (ranked.length >= 2) {
    roles[ranked[ranked.length - 1].col] = 'name';
    for (let i = 0; i < ranked.length - 1; i++) roles[ranked[i].col] = 'subject';
  }
  return { roles, stats, textCols };
}

/* 主入口：传 <img> 或 ImageBitmap，返回跟 CSV 识别同样结构的结果 */
export function detectAttendance(img, opts = {}) {
  const g = detectGrid(img);
  if (!g.ok) return { ok: false, reason: g.reason };

  const { rows, cols, grid, mono, hs, vs } = g;
  if (rows < 2 || cols < 2) {
    return { ok: false, reason: '表格太小，没切出数据行。请把整张表拍进画面。' };
  }

  /* 表头行：第一行通常是「序号 姓名 学科 上课 坐班…」，整行几乎每格都有字。
     找不到就当没有表头，从第 0 行开始读（有些表直接就是名单）。 */
  let headerRow = -1;
  for (let r = 0; r < Math.min(3, rows); r++) {
    const cnt = grid[r].filter((c) => c.filled).length;
    if (cnt >= cols - 1) { headerRow = r; break; }
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
  for (let i = 0; i < sub.length; i++) {
    const r = sub[i];
    /* 整行都没字（空行 / 合计行下面的空白）就跳过 */
    if (!r.some((c) => c.filled)) continue;
    const data = {};
    let anyMark = false;
    useChecks.forEach((c, k) => {
      const st = cellInkStats(mono, g.w, r[c].box);
      const mark = classifyMark(mono, g.w, st);
      if (mark) { data[CHECK_KEYS[k].key] = mark === '√' ? '1' : '0'; anyMark = true; }
      cellsForPreview.push({ row: i, col: c, mark, box: r[c].box });
    });
    /* 一个勾都没有的行，多半是表尾（制表人/审核）或空白，不当教师行 */
    if (!anyMark) continue;
    const guess = roster[filledIdx] || null;
    outRows.push({
      /* 铺名册名字；名册不够长就写「第N行」占位，让老师知道这里要改 */
      teacher: guess ? guess.name : `（第${bodyStart + i + 1}行）`,
      subject: guess ? (guess.subject || '') : '',
      data,
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
      roleStats: stats.map((s) => ({ col: s.col, role: roles[s.col], fill: Math.round(s.fillRate * 100), ink: Math.round(s.avgInk) })),
    },
    _preview: { cells: cellsForPreview, w: g.w, h: g.h },
  };
}
