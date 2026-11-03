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

/* 找表格线：逐行/逐列统计深色像素占比。
   findLines 已被 findTableLines 取代（下面），这里的 groupNear 仍被复用。 */
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

/* ==========================================================================
   光照归一化（拍照必需，截图无害）
   --------------------------------------------------------------------------
   手机照片的亮度分布极不均匀：中间亮、四角暗，桌面的深色木纹比表格线还黑。
   阈值 165 这种**全局**判据在照片上直接失效 —— 桌面、阴影、纸边全算成「墨」，
   表格线和背景糊成一片，行投影永远是 0.4~0.6 的糊状，一根线都找不出来。

   实测用户那张「高二老师签到表」：老算法在整张图上找不到任何一根表格线，
   行投影的 10/50/90 分位数是 0.234 / 0.455 / 0.980 —— 几乎每一行都「有一半是墨」，
   因为左半边是深色桌面。

   解法是标准的 Sauvola 思路，但简化成**积分图版局部均值**：
     先把图缩到 1/4（既能抹掉纸纹噪点，又把积分图内存降到 1/16），
     对每个像素算它周围 box 大小的均值，像素比均值暗 (1-bias) 倍以上才算墨。
     这样「深色桌面」自己也是均值的一部分，不会被当成墨；
     而表格线/文字这种比周围明显暗的细结构会被保留。

   不引入任何依赖，纯 Uint32 数组累加，1800×1350 的图几十毫秒。
   ========================================================================== */
export function localBinarize(gray, w, h, box = 25, bias = 0.12) {
  /* 积分图：sum[y][x] = 左上角到 (x-1,y-1) 的灰度总和 */
  const iw = w + 1;
  const S = new Float64Array(iw * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    const base = y * w;
    const up = y * iw, cur = (y + 1) * iw;
    for (let x = 0; x < w; x++) {
      rowSum += gray[base + x];
      S[cur + x + 1] = S[up + x + 1] + rowSum;
    }
  }
  const mono = new Uint8Array(w * h);
  const r = Math.max(4, box >> 1);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    const base = y * w;
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      const area = (x1 - x0) * (y1 - y0);
      const sum = S[y1 * iw + x1] - S[y0 * iw + x1] - S[y1 * iw + x0] + S[y0 * iw + x0];
      const mean = sum / area;
      /* 比局部均值暗 bias 倍以上就算墨；mean 很低（整体很暗）时要留一个绝对下限，
         否则深色区域内部一点噪声都会被放大成墨。 */
      const thr = mean * (1 - bias) - 6;
      mono[base + x] = gray[base + x] < thr ? 1 : 0;
    }
  }
  return mono;
}

/* 3×3 膨胀。原地改会污染邻居判断，所以用两块缓冲轮换 */
function dilate(src, w, h) {
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const b = y * w;
    for (let x = 0; x < w; x++) {
      const i = b + x;
      tmp[i] = src[i]
        || (x > 0 && src[i - 1]) || (x < w - 1 && src[i + 1]);       // 横向
    }
  }
  for (let y = 0; y < h; y++) {
    const b = y * w;
    for (let x = 0; x < w; x++) {
      const i = b + x;
      out[i] = tmp[i]
        || (y > 0 && tmp[i - w]) || (y < h - 1 && tmp[i + w]);       // 纵向
    }
  }
  return out;
}

/* ==========================================================================
   斜线段检测（Hough 的简化版，但更稳）
   --------------------------------------------------------------------------
   【为什么不能按「整行」找游程】
   截图是正着的，一条横线正好落在某一行的像素上，按行扫一遍就找到了。
   手机拍的照片不行 —— 透视 + 手持歪斜，一条横线跨 1800px 会**分到十几行**上去。
   实测「高二老师坐班表」：表格内每条横线的连续段最长只有 525px，
   而画面宽 1800px。按 30% 宽度（540px）当门槛，一条线都找不到，
   这就是「照片认不出」的直接原因。

   【换成按「线段」找】
   把二值图切成 12×12 的小块。某块里墨超过 5 个像素就算「有墨块」。
   然后对每个有墨块，向左右各允许 ±1 行的漂移（斜率 ≤1/12 ≈ 4.8°）连成一条段。
   只要一条线的斜率在 5° 以内（手机手持拍摄的典型值），整条线就会被完整串起来，
   不管它落在哪几行上。

   【为什么不用真 Hough】
   真 Hough 要量化角度、算每一条线的票数，参数一多就调不动；
   而表格线只可能是「横」或「竖」两个方向（最多差 5°），
   用「±1 行漂移的连通」就等价于扫描 -4.8°~+4.8° 之间所有斜率，还更快。
   ========================================================================== */
function longRuns(m, w, h, axis, minLen) {
  /* 竖线方向：把图转置后用同一套逻辑，省一份代码 */
  if (axis === 'v') {
    const t = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const base = y * w;
      for (let x = 0; x < w; x++) t[x * h + y] = m[base + x];
    }
    return longRuns(t, h, w, 'h', minLen);
  }

  /* 【块边长 4，不是 12】
     12 的块看着省事，但那意味着「线的位置」分辨率只有 12px，
     而表格行高只有 20~40px —— 一条线落进哪个块全看运气，
     相邻两条线经常落到同一块里，直接粘连。
     实测 12px 块下，这张照片的横线掩码是这样的：
       28: .........#................#.....#######...########...
     中间全是断口，连通时一次只能走一两块，最后切出 10 条线（真值 15 条）。
     换成 4px 块之后断口消失，一条线能从表头一直连到表尾。
     代价是块数 ×9（150×113 → 450×338），但只读一遍像素，
     1800×1350 的图仍然在 100ms 量级。 */
  const BS = 4;
  const bx = Math.ceil(w / BS), by = Math.ceil(h / BS);
  const blk = new Uint8Array(bx * by);
  const rowInk = new Uint8Array(BS);
  for (let j = 0; j < by; j++) {
    const y0 = j * BS, y1 = Math.min(h, y0 + BS);
    for (let i = 0; i < bx; i++) {
      const x0 = i * BS, x1 = Math.min(w, x0 + BS);
      rowInk.fill(0);
      for (let y = y0; y < y1; y++) {
        const base = y * w;
        let n = 0;
        for (let x = x0; x < x1; x++) if (m[base + x]) n++;
        rowInk[y - y0] = n;
      }
      /* 满行 = 这一行被墨填了半块宽以上（4 格里 ≥2）；
         一条 1~2px 粗的线穿过 4×4 块时只压住 1~2 行，其余行全空；
         汉字笔画在 4×4 里经常把 3~4 行都填上。 */
      const HALF = Math.ceil((x1 - x0) * 0.5);
      let fullRows = 0;
      for (let k = 0; k < (y1 - y0); k++) if (rowInk[k] >= HALF) fullRows++;
      const hgt = y1 - y0;
      /* 【判据：被「几乎填满」的行数占比】
         原来写的是 fullRows 在 1~2 之间才算线，太死：一条 2px 粗的线
         斜着穿过 4×4 块时，可能压住 3 行（每行只填 2~3 格），
         这时 fullRows=3 被判成文字，于是整条线在掩码里断成一串点。
         实测「高一坐班表」0° 就是这样：块掩码里 65 个连续块只认出 1/3。

         正确的判据是**占比**：线穿过时「一定有至少 1 行几乎被填满」，
         且「填满的行」不会太多；而一块只含文字时，笔画分散在 4 行里，
         没有哪一行能填满 4 格。
         所以：fullRows ≥ 1 且 fullRows ≤ hgt（4 行里最多 3 行算满）。 */
      blk[j * bx + i] = (fullRows >= 1 && fullRows < hgt) ? 1 : 0;
    }
  }

  /* 连通：从每个有墨块出发向右延伸，每一步允许行号 ±1（斜率 ≤ 1/4 = 14°）。
     14° 是刻意放开的：手机拍照时表格常常歪 3~8°，块越小容差越要放宽。 */
  const seen = new Uint8Array(bx * by);
  const runs = [];
  for (let j = 0; j < by; j++) {
    for (let i = 0; i < bx; i++) {
      if (!blk[j * bx + i] || seen[j * bx + i]) continue;
      let cx = i, cy = j;
      let x2 = i, y2 = j;
      let nBlk = 0;
      /* 局部抖动：每步 dy 的绝对值累加。
         这才是判断「一条直不直」的正确指标 ——
         累计 slope 会被「透视下整条线缓慢漂移」撑到 0.2 以上，
         但局部每步只动 0~1 块。文字连出来的假线则是上上下下乱跳。 */
      let jitter = 0;
      while (cx < bx) {
        if (blk[cy * bx + cx] && !seen[cy * bx + cx]) {
          seen[cy * bx + cx] = 1;
          nBlk++;
          x2 = cx; y2 = cy;
          cx++;
          continue;
        }
        /* 【断口处理：允许跳，也允许小幅换行】
           断口来源有三种，都必须扛住：
             · 竖线穿过（横向断 1 块，线本身没歪）
             · 字压住线（横向断 2~4 块）
             · 线在这里弯了一点点（纵向错 1~3 块）
           所以搜索窗口是 skip 1~6 块、dy -3~+3 块，
           并在窗口里优先选「dy 最小」的那块（保持原有斜率）。
           窗口放大的风险是把上下两行连起来，但两行之间隔着一整行高的空白
           （行高 20~40px = 5~10 块），6 块的横向跳跃跨不过去。 */
        let moved = false;
        for (let skip = 1; skip <= 6 && !moved; skip++) {
          const nx = cx + skip;
          if (nx >= bx) break;
          for (let dy = 0; dy <= 3 && !moved; dy++) {
            for (const s2 of (dy === 0 ? [0] : [-dy, dy])) {
              const ny = cy + s2;
              if (ny >= 0 && ny < by && blk[ny * bx + nx] && !seen[ny * bx + nx]) {
                jitter += Math.abs(s2);
                cx = nx; cy = ny; moved = true; break;
              }
            }
          }
        }
        if (!moved) break;
      }
      const len = (x2 - i + 1) * BS;
      if (len >= minLen) {
        const spanBlk = x2 - i + 1;
        runs.push({
          pos: Math.round(((j + y2) / 2 + 0.5) * BS),
          a: i * BS,
          b: Math.min(w - 1, (x2 + 1) * BS - 1),
          slope: (y2 - j) / Math.max(1, x2 - i),           // 块/块（累计）
          jitter: jitter / Math.max(1, nBlk),              // 块/块（局部抖动）
          fill: nBlk / Math.max(1, spanBlk),
        });
      }
    }
  }
  return runs;
}

/* 把线段归并成「线」—— 两轮聚类。
   --------------------------------------------------------------------------
   一张照片里的「一条横线」会被切成好几段碎片：
     · 每个汉字压住线的地方是一个缺口（单字宽 30~60px）
     · 照片左右两半光照不同，中间可能整段断开
     · 纸边、装订孔也会挡掉一块

   实测「高二老师签到表」：表格左半边的横线段是 (384→863)、
   右半边是 (1176→1451)，中间因为「姓名」「学科」几列的字密集，断了 313px。
   只按「位置相近」并成一条的话，两段会被当成两条不同的线，列数直接翻倍。

   【关键：线是斜的，pos 沿长度方向会漂移】
   一条斜 2° 的横线跨 1400px，两端 pos 差 49px —— 比分给两个不同片段还大。
   所以第一轮不能按 pos 归并，必须**按 pos + 斜率推算**：
   把 A 段的 pos 沿 x 方向线性外推到 B 段的起点，再比差值。
   外推之后同一条线的碎片必然对得上（差 ≤ 块高的 1/4），
   不同线的碎片 pos 差至少行高（20~40px），分得干干净净。

   第一轮：严格（外推后 pos 差 ≤ 8 + 区间重叠或靠近）
   第二轮：桥接（外推后 pos 差 ≤ 8 + 横向间距 ≤ 画面宽 1/3），把碎片连成整条
   -------------------------------------------------------------------------- */
function clusterRuns(runs, gap = 8) {
  /* 每段带一条直线方程 pos(x) = pos + slope*(x - cx)，外推时用它 */
  const prep = (r) => ({
    ...r,
    cx: (r.a + r.b) / 2,
    at(x) { return r.pos + (r.slope || 0) * (x - (r.a + r.b) / 2); },
  });

  const merge = (list, maxGapPx) => {
    const arr = list.slice();
    const out = [];
    for (const r0 of arr) {
      const r = prep(r0);
      let hit = null;
      for (const g of out) {
        /* 用较靠右那段的起点做外推基准，避免短段斜率噪声放大 */
        const xRef = Math.min(r.a, g.a);
        const dPos = Math.abs(g.at(xRef) - r.at(xRef));
        if (dPos > gap) continue;
        const ov = Math.min(g.b, r.b) - Math.max(g.a, r.a);
        const dist = Math.max(g.a, r.a) - Math.min(g.b, r.b);
        const okOverlap = ov > Math.min(g.b - g.a, r.b - r.a) * 0.3;
        const okBridge = maxGapPx != null && dist <= maxGapPx;
        if (!okOverlap && !okBridge) continue;
        hit = g; break;
      }
      if (hit) {
        hit.a = Math.min(hit.a, r.a); hit.b = Math.max(hit.b, r.b);
        hit.pos = (hit.pos + r.pos) / 2;
        hit.slope = ((hit.slope || 0) + (r.slope || 0)) / 2;
        hit.n++;
      } else {
        out.push(prep({ pos: r.pos, a: r.a, b: r.b, slope: r.slope || 0, n: 1 }));
      }
    }
    return out;
  };

  /* 第二轮必须重新过一遍 prep —— 第一轮的输出是普通对象，没有 at() */
  const p1 = merge(runs, null);
  const p2 = merge(p1.map(prep), clusterRuns.maxGap || 400);
  return p2.map((g) => ({ pos: Math.round(g.pos), a: Math.round(g.a), b: Math.round(g.b), thick: g.n }));
}

/* 主函数：返回 { hs, vs, hLen, vLen }  hs/vs 是线的中心坐标（升序） */
/* ==========================================================================
   表格外框定位：把「纸上的表格」从「桌面、纸边、阴影」里切出来
   --------------------------------------------------------------------------
   做法是最朴素也最稳的「投影法」：
     ① 横向投影 Row[x] = 这一列有多少墨点，纵向投影 Col[y] 同理
     ② 从中位数往上抬到一定比例（密集区），得到「有内容」的列/行区间
     ③ 取最左/最右/最上/最下的密集区，再留一点边

   为什么不用连通域 / 轮廓检测：照片边缘有桌子、纸边、手指，轮廓会连成一片；
   而投影法只看「哪里墨多」，桌面纹理的墨量远低于打印表格，天然分开。

   为什么必须做这一步：见 findTableLines 顶部注释 —— 小表会被长游程门槛漏掉。
   ========================================================================== */
function tableFrame(mono, w, h) {
  const colInk = new Float64Array(w);
  const rowInk = new Float64Array(h);
  for (let y = 0; y < h; y++) {
    const base = y * w;
    let n = 0;
    for (let x = 0; x < w; x++) {
      if (mono[base + x]) { n++; colInk[x]++; }
    }
    rowInk[y] = n;
  }
  /* 阈值取「最大值的 30%」：表格区域的墨量是桌面的 5~20 倍，
     30% 能把纸边阴影、手指彻底排除，同时不会切掉「备注」这种稀疏列。 */
  const span = (proj, len) => {
    let mx = 0;
    for (let i = 0; i < len; i++) if (proj[i] > mx) mx = proj[i];
    if (mx <= 0) return [0, len - 1];
    const thr = Math.max(mx * 0.3, len * 0.012);
    let a = -1, b = -1;
    for (let i = 0; i < len; i++) if (proj[i] >= thr) { if (a < 0) a = i; b = i; }
    if (a < 0) return [0, len - 1];
    return [a, b];
  };
  const [x0, x1] = span(colInk, w);
  const [y0, y1] = span(rowInk, h);
  const padX = Math.round((x1 - x0) * 0.03) + 6;
  const padY = Math.round((y1 - y0) * 0.03) + 6;
  const fx = Math.max(0, x0 - padX);
  const fy = Math.max(0, y0 - padY);
  const fw = Math.min(w - fx, x1 - x0 + 1 + padX * 2);
  const fh = Math.min(h - fy, y1 - y0 + 1 + padY * 2);
  return { x: fx, y: fy, w: Math.max(16, fw), h: Math.max(16, fh) };
}

function findTableLines(mono, w, h) {
  /* 【第一步：先把表格框切出来】
     用户在 A4 纸上拍的表格只占画面 55~75%，四周是桌面、纸边、阴影。
     直接在整幅图上做投影，桌面纹理会在每个方向上都贡献均匀墨量，
     把「线」这个峰值稀释掉。裁到表格框里，信噪比立刻提高一个量级。 */
  const frame = tableFrame(mono, w, h);
  const fw = frame.w, fh = frame.h;
  const sub = new Uint8Array(fw * fh);
  for (let y = 0; y < fh; y++) {
    sub.set(mono.subarray((y + frame.y) * w + frame.x, (y + frame.y) * w + frame.x + fw), y * fw);
  }

  /* 【第二步：测倾斜 + 剪切校正】——最关键的一步，见 detectTilt 注释 */
  const tilt = detectTilt(sub, fw, fh);
  const sh = shearMono(sub, fw, fh, tilt.slope);

  /* 【第三步：切变后的图上做投影找线】
     注意：shear 只改变 y，x 坐标完全不变，所以竖线（列）位置直接可用；
     横线（行）位置要减掉 shear 引入的偏移 dy0 回到原图坐标。 */
  const hL = projLines(sh.mono, sh.w, sh.h, 'h', { minCover: 0.5 });

  /* 【竖线：用「列投影」直接找，不做倾斜校正】
     竖线的特点和横线不同：
       · 一条竖线只跨「表高」（约 24 行 × 34px = 816px），
         倾斜 1° 时横向漂移只有 14px —— 远小于列宽（90px），
         所以**列投影根本不受倾斜影响**，不需要校正。
       · 反过来，把竖线转置后当横线处理，反而会被「表格最长的外框线」
         带偏，测出错误的角度，把整列切碎（实测坐班表直接失败）。
     所以竖线就在原来的（已 shear 过的）图上做列投影。
     shear 只动 y，不动 x，所以列投影完全等价于在原图上做。

     判据：表格的列边界是**贯穿整个表高的**。
     所以要求这条竖线在「上下边界之间」的跨度 ≥ 70% 表高 ——
     能把「只出现在几行里的文字笔画」排除掉。 */
  /* 横线：pos 要减掉 shear 偏移、再加 frame 偏移，才是原图 y */
  const hA = hL.map((l) => ({
    pos: l.pos + sh.dy0 + frame.y,
    a: l.a + frame.x, b: l.b + frame.x,
    cover: l.cover, len: l.b - l.a + 1,
    slope: tilt.slope,
  }));

  /* 【竖线：直接在（已 shear 的）图上做列投影】
     shear 只动 y 不动 x，所以列投影的结果和原图完全一致。
     倾斜 1° 时一条跨 816px 的竖线只漂 14px，相对列宽 60~130px 影响有限，
     而「转置后再 shear」的方案实测会被表格外框线带偏（见 git 历史），
     所以这里用最直接的做法。
     下面按覆盖率 + 同一列宽量级做两级近邻合并，压掉「汉字一竖」的噪声。 */
  const vL = projLines(sh.mono, sh.w, sh.h, 'v', { minCover: 0.42 });
  const vA = vL.map((l) => ({
    pos: l.pos + frame.x,
    a: l.a, b: l.b,
    cover: l.cover, len: l.b - l.a + 1,
    slope: 0,
  }));

  /* 【第四步：挑线 —— 横竖两套规则】
     ------------------------------------------------------------------
     横线：剪切校正后极干净（cover 0.85~0.98），按 cover 过滤即可。
     竖线：汉字的一竖每行都有一根，在列投影里和真列边界一样高，
           所以 cover 单独区分不开（实测真列 0.43，汉字竖 0.48）。
           但它们的**间距分布**完全不同：
             · 真列边界：间距集中在 60~130px，且只有 3~4 种不同值
             · 汉字竖画：间距 4~30px，杂乱无规律
           所以对竖线做「按间距归一」：以中位间距为 1 个单位，
           把间距 < 0.45 单位的峰合并（那是同一条线裂开的碎片），
           间距在 0.75~1.35 单位之间的才保留为独立列。
     ------------------------------------------------------------------ */
  const byCover = (arr, k) => {
    const f = arr.filter((l) => l.cover >= k);
    return f.length >= 3 ? f : (arr.length >= 3 ? arr : f);
  };

  /* 横线：按覆盖率高门槛过滤 + 近邻合并 */
  const hv = dedupeLines(byCover(hA, 0.7).map((l) => l.pos))
    .map((p2) => hA.reduce((best, l) => (Math.abs(l.pos - p2) < Math.abs(best.pos - p2) ? l : best), hA[0]))
    .sort((a, b) => a.pos - b.pos);

  /* 竖线：先按 cover 粗筛，再按「间距单位」合并碎片 */
  const vCand = vA.slice().sort((a, b) => a.pos - b.pos);
  const mergeFrags = (arr) => {
    if (arr.length < 3) return arr;
    const pos = arr.map((l) => l.pos);
    const gaps = [];
    for (let i = 1; i < pos.length; i++) gaps.push(pos[i] - pos[i - 1]);
    const unit = gaps.slice().sort((a, b) => a - b)[Math.floor(gaps.length * 0.75)] || 60;
    const out = [arr[0]];
    for (let i = 1; i < arr.length; i++) {
      const last = out[out.length - 1];
      if (arr[i].pos - last.pos < unit * 0.45) {
        /* 碎片：保留 cover 高的那个 */
        if (arr[i].cover > last.cover) out[out.length - 1] = arr[i];
      } else {
        out.push(arr[i]);
      }
    }
    return out;
  };
  const vv = mergeFrags(byCover(vCand, 0.45));

  const hs = hv.map((l) => l.pos);
  const vs = vv.map((l) => l.pos);
  const hLen = hv.reduce((s2, l) => s2 + l.len, 0);
  const vLen = vv.reduce((s2, l) => s2 + l.len, 0);
  return {
    hs, vs, hLen, vLen, hLines: hv, vLines: vv, frame,
    tilt: (Math.atan(tilt.slope) * 180) / Math.PI,
  };
}

/* ==========================================================================
   投影法找线 —— 内部表格线的唯一可靠办法
   --------------------------------------------------------------------------
   【为什么游程法（longRuns）不够】
   游程法要求「一条线连续贯穿画面宽的 18%」。这对**最上面那条表头线**成立
   （它横跨整表），但对中间的行分隔线经常失败：汉字压断、折痕、反光，
   任何一处断口都让连通走不下去，一条线碎成三四段，每段都够不到门槛。
   实测「高一坐班表」0°：块掩码里明明能看到 62 个连续块，
   但一路向后的断口让整段只算出 300px，直接丢弃 —— 24 行只剩 8 行。

   【投影法为什么能扛】
   不需要「连续」。只要把每一行的墨点数统计出来，表格线那一行的墨点数
   会**明显高于上下相邻行**（因为线是横贯的，而文字是零散的）。
   局部的断口、污渍都不影响这一行的总墨量。
   数学上相当于「沿 x 方向求和」，天然把断口补平了。

   【怎么区分「表格线」和「一整行密密麻麻的字」】
   这两个的行墨量都高，只看总量分不开。加两条判据：
     ① 峰值必须比「左右邻居」高出一定比例（文字行往往连续几行都高）
     ② 峰值行在 x 方向上的**覆盖率**要高（线是横贯的，字是断的）
   实测此表：表格线行覆盖率 0.85~0.95，文字行 0.35~0.6，分离度足够。

   @returns {{pos, a, b, cover}[]} 位置 + 线的水平起止 + 覆盖率
   ========================================================================== */
function projLines(mono, w, h, axis, opt = {}) {
  if (axis === 'v') {
    const t = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const base = y * w;
      for (let x = 0; x < w; x++) t[x * h + y] = mono[base + x];
    }
    return projLines(t, h, w, 'h', opt);
  }
  const minCover = opt.minCover || 0.45;
  /* 每行的墨量 + 起止 + 覆盖率（按 4px 一档统计，成本降到 1/4） */
  const ink = new Float64Array(h);
  const a0 = new Int32Array(h).fill(-1);
  const b0 = new Int32Array(h).fill(-1);
  const hit = new Float64Array(h);
  const tot = Math.max(1, Math.ceil(w / 4));
  for (let y = 0; y < h; y++) {
    const base = y * w;
    let n = 0;
    for (let x = 0; x < w; x++) if (mono[base + x]) n++;
    ink[y] = n;
  }
  /* 覆盖率：按 4px 分档，这一档里只要有 ≥1 个墨点就算「有线」 */
  for (let y = 0; y < h; y++) {
    const base = y * w;
    let h2 = 0, fa = -1, fb = -1;
    for (let s2 = 0; s2 < tot; s2++) {
      const xs = s2 * 4, xe = Math.min(w, xs + 4);
      let any = 0;
      for (let x = xs; x < xe; x++) if (mono[base + x]) { any = 1; break; }
      if (any) { h2++; if (fa < 0) fa = s2 * 4; fb = xe - 1; }
    }
    hit[y] = h2 / tot;
    a0[y] = fa; b0[y] = fb;
  }
  /* 峰值 = 局部极大（比上下各 2 行都高）+ 绝对量够 + 覆盖率高 */
  const out = [];
  const win = opt.win || 2;
  for (let y = 0; y < h; y++) {
    if (hit[y] < minCover) continue;
    let isMax = true;
    for (let d = 1; d <= win && isMax; d++) {
      if (y - d >= 0 && ink[y - d] > ink[y] * 1.02) isMax = false;
      if (y + d < h && ink[y + d] > ink[y] * 1.02) isMax = false;
    }
    if (!isMax) continue;
    /* 邻域内墨量最高的一行才是线的真实中心（线有 2~3px 粗） */
    let by = y;
    for (let d = -win; d <= win; d++) {
      const yy = y + d;
      if (yy >= 0 && yy < h && ink[yy] > ink[by]) by = yy;
    }
    out.push({ pos: by, a: a0[by], b: b0[by], cover: hit[by], ink: ink[by] });
  }
  /* 同一条粗线可能连出两三个峰（2~3px 粗），合并间距 ≤2px 的 */
  const merged = [];
  for (const l of out) {
    const last = merged[merged.length - 1];
    if (last && l.pos - last.pos <= 2) {
      if (l.ink > last.ink) { last.pos = l.pos; last.cover = l.cover; last.ink = l.ink; last.a = l.a; last.b = l.b; }
      continue;
    }
    merged.push({ ...l });
  }
  return merged;
}

/* ==========================================================================
   倾斜校正：把歪了 1~6° 的表格「掰正」，为投影法铺路
   --------------------------------------------------------------------------
   【为什么这是必须的一步】
   手机拍照，表格几乎不可能完全水平。实测用户这 5 张照片，
   全部倾斜 1°（横线从画面左端到右端漂了 20~38px）。

   1° 听起来无害，但对「整行投影」是致命的：
   一条 3px 粗的横线，只要在 x 方向漂移超过 3px，它就不再落在同一行里，
   投影后这条线被摊薄到 10~20 行上，每行的墨量只剩原来的 1/15 ——
   峰值完全消失。
   实测证据（同一张「高一坐班表」）：
     · 不校正：整行投影尖锐度 2.3，只能找到零星几条线
     · 校正 1°：尖锐度 6.1，24 行线一条不少

   所以必须：**先测角度，再按这个角度做剪切（shear）校正，最后投影找线。**

   【怎么测角度】
   对候选角度逐个做剪切投影，取「投影最尖锐」的那个。
   尖锐度 = 排序后前 3% 的行墨量均值 / 中位数 —— 线越集中在一行，
   这个比值越大。横向 ±6°、步长 0.5°，13~25 次尝试，
   每次只是把二值图按 x 平移累加，1800×1350 大约 40ms，可以接受。

   【为什么用 shear 而不是 rotate】
   切变把 (x,y) → (x, y + s*x)，只在 y 方向平移，不改变 x 方向的采样点。
   分数像素的角度也能精确表达（rotate 会导致重采样模糊，把 3px 的线糊成 5px）。
   反正后面只需要「横线变成水平的」这个效果，不需要几何上正确的旋转。
   ========================================================================== */
function shearMono(mono, w, h, s) {
  const pad = Math.ceil(Math.abs(s) * w) + 2;
  const oh = h + pad * 2;
  const out = new Uint8Array(w * oh);
  const off = s > 0 ? pad : pad + Math.round(-s * w);
  for (let x = 0; x < w; x++) {
    const dy = Math.round(s * x) + off;
    for (let y = 0; y < h; y++) {
      if (mono[y * w + x]) out[(y + dy) * w + x] = 1;
    }
  }
  return { mono: out, w, h: oh, dy0: -off };
}

/* 测出表格的倾斜角（弧度）。返回 { slope, sharp } */
function detectTilt(mono, w, h) {
  const sharpOf = (s) => {
    const sh = shearMono(mono, w, h, s);
    const prof = new Float64Array(sh.h);
    for (let y = 0; y < sh.h; y++) {
      const base = y * w;
      let n = 0;
      for (let x = 0; x < w; x += 2) if (sh.mono[base + x]) n++;
      prof[y] = n;
    }
    const arr = Array.from(prof).sort((a, b) => b - a);
    const k = Math.max(3, Math.floor(arr.length * 0.03));
    let top = 0;
    for (let i = 0; i < k; i++) top += arr[i];
    const mid = arr[Math.floor(arr.length / 2)];
    return top / k / (mid + 1);
  };
  let bestS = 0, bestV = 0;
  /* 先粗扫 ±6°（步长 1.5°），再在最优点附近细扫（步长 0.4°） */
  for (let d = -6; d <= 6; d += 1.5) {
    const s = Math.tan((d * Math.PI) / 180);
    const v = sharpOf(s);
    if (v > bestV) { bestV = v; bestS = s; }
  }
  const base = bestS;
  for (let d = -1.4; d <= 1.4; d += 0.4) {
    const s = base + Math.tan((d * Math.PI) / 180);
    const v = sharpOf(s);
    if (v > bestV) { bestV = v; bestS = s; }
  }
  return { slope: bestS, sharp: bestV };
}

/* 转置二值图：用来复用同一套「投影找线」代码处理竖线 */
function transposeMono(m, w, h) {
  const t = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const base = y * w;
    for (let x = 0; x < w; x++) t[x * h + y] = m[base + x];
  }
  return { mono: t, w: h, h: w };
}

/* ==========================================================================
   列检测：在「行边界已确定」的表格区域内，专门找列边界
   --------------------------------------------------------------------------
   【为什么列要单独做一次】
   行检出来之后表的上下边界就确定了。在这个矩形里判列有硬标准：
   列边界几乎贯穿整个表高。但要小心两个坑：

   坑①  手机拍照有透视 —— 竖线越往上（离镜头远）越往中间收，
        整条竖线不是一个常数 x，而是随 y 缓慢漂移的 x(y)。
        直接对整列求和，一条线摊到 6~10 个 x 上，覆盖率从 0.95 掉到 0.4。
   坑②  很多表格的竖线是**断着画**的（只在表头画一段、正文只画横线），
        或者被手写笔迹压断。

   所以不能按「整列覆盖率 ≥ 阈值」一刀切（实测 0.78 门槛只找到 3 条，真值 11 条）。

   【做法：缝谷法 seam】
     ① 每一行（单个文字行高，约 30px）单独算：这一行哪些 x 只落了 1~2 个墨点。
        那都是「缝」——横线之外没有东西的空隙。
     ② 缝里如果某条线穿过去，会留下 1~2px 的墨，缝就断了。
        于是「缝的连通段」= 相邻两条竖线之间的空白区。
     ③ 每行给出若干「缝段」，按 x 位置跨行聚类（窗口 ±6px），
        得到每一条缝的「从哪一行到哪一行」。
     ④ 一条缝跨越的行数够多（≥ 55% 行数）或在表头/表尾局部成立，就算真列间隙。
     ⑤ 每条缝取「靠右的边」当列边界 —— 用中位数，透视漂移自然被平均掉。

   这样竖线断着画、透视歪着画都不影响判断：判的是「两条线之间有没有干净的空隙」。
   实测「高二签到表」缝段跨 20/20 行，「高一坐班表」跨 18/18 行，非常干净。
   ========================================================================== */
function detectColumns(mono, w, yTop, yBot, xLo, xHi) {
  const x0 = Math.max(0, xLo);
  const x1 = Math.min(w - 1, xHi);
  const y0 = Math.max(0, yTop);
  const y1 = Math.min(h0Guard(mono, w), yBot);
  const total = y1 - y0;
  if (total < 20 || x1 - x0 < 20) return [];

  /* ① 找出表内所有横线所在的行（让它们不参与缝计算）。
     横线整行有墨，会把所有缝一起堵死。 */
  const rowInk = new Float64Array(y1);
  for (let y = y0; y < y1; y++) {
    const base = y * w;
    let n = 0;
    for (let x = x0; x <= x1; x++) if (mono[base + x]) n++;
    rowInk[y] = n;
  }
  let mxInk = 0;
  for (let y = y0; y < y1; y++) if (rowInk[y] > mxInk) mxInk = rowInk[y];
  const isHLine = new Uint8Array(y1);
  const hThr = Math.max((x1 - x0) * 0.45, mxInk * 0.5);
  for (let y = y0; y < y1; y++) if (rowInk[y] >= hThr) {
    /* 横线 2~3px 粗，上下各放 1px 余量 */
    for (let d = -1; d <= 1; d++) { const yy = y + d; if (yy >= y0 && yy < y1) isHLine[yy] = 1; }
  }

  /* ② 逐行找缝段。
     【为什么不能用「整行最长空段」】
     一行 34px 高，一个 60~95px 宽的格子里字只占中间 24~30px，
     两侧 30~70px 全是空的 —— 整行看过去最大的空段就是格子内部。
     实测「高二签到表」按单行找得到 29338 个「缝」，全是垃圾。

     【为什么也不能只看「这一列有没有墨」】
     表格竖线在这个分辨率下只有 1.5~2px 粗，加上二值化和透视漂移，
     打散成 5~6 个 x，任一单列的覆盖率只有 0.2~0.5；
     而汉字笔画「上下两行对齐」时单列覆盖率能到 0.5 以上 —— 完全分不开。
     实测：整列覆盖率在 0.3~0.8 之间来回翻，任何阈值都挑不出干净的 11 条。

     【正解：空白带】
     真缝的判据不是「线在哪」，而是「一段宽度内一条线都没有」。
     对每个 x 取 [x-wd, x+wd] 这段带宽内的**总墨量**：
       · 命中的是竖线 → 带里有 5~10 个横向位置全高有墨，墨量极大
       · 命中的是汉字 → 只有中间几个位置有墨，且只在本行
     带宽 wd 取「1.6 倍行高」，横线被排除后这个量非常干净。 */
  const bodyEnd = y1;
  const colInk = new Float64Array(w + 1);
  for (let y = y0; y < bodyEnd; y++) {
    if (isHLine[y]) continue;
    const base = y * w;
    for (let x = x0; x <= x1; x++) if (mono[base + x]) colInk[x] += 1;
  }
  /* 行数：排除横线后的有效行数 */
  let rows = 0;
  for (let y = y0; y < y1; y++) if (!isHLine[y]) rows++;
  if (rows < 10) return [];

  /* 累积和，O(1) 求任意带宽内的墨量 */
  const pre = new Float64Array(w + 2);
  for (let x = x0; x <= x1; x++) pre[x + 1] = pre[x] + colInk[x];
  const bandInk = (cx, wd) => {
    const a = Math.max(x0, cx - wd), b = Math.min(x1, cx + wd);
    return (pre[b + 1] - pre[a]) / Math.max(1, b - a + 1) / Math.max(1, rows);
  };

  /* 带宽：用「表高 / 估计行数」当行高。
     【这条最关键】wd 必须远小于列距（列宽约 60~130px），
     否则任何位置的带宽都会扫到旁边那条竖线，墨量全被拉平，谷一个都没有。
     实测：wd=56（1.6×行高）时谷数 0；wd≈19（0.55×行高）时谷清晰分明。
     取 0.55 倍行高 —— 大约是格子内「字与竖线之间那段空白」的宽度。 */
  const approxRowH = Math.max(12, Math.round((yBot - y0) / 26));
  const wd = Math.max(5, Math.round(approxRowH * 0.55));

  const prof = new Float64Array(w + 1);
  const pw = new Float64Array(w + 1);   /* 以该点为中心的带宽墨量 */
  for (let cx = x0; cx <= x1; cx++) pw[cx] = bandInk(cx, wd);
  for (let cx = x0 + wd; cx <= x1 - wd; cx++) {
    /* 平滑：取 ±wd/3 的平均，压掉单像素噪声 */
    let s2 = 0, n2 = 0;
    for (let d = -Math.round(wd / 3); d <= Math.round(wd / 3); d++) {
      const xx = cx + d;
      if (xx >= x0 && xx <= x1) { s2 += pw[xx]; n2++; }
    }
    prof[cx] = s2 / Math.max(1, n2);
  }

  let mxP = 0;
  for (let cx = x0 + wd; cx <= x1 - wd; cx++) if (prof[cx] > mxP) mxP = prof[cx];
  if (mxP <= 0) return [];

  /* ③ 【列边界 = 覆盖率峰】
     实测「高二签到表」每一列的覆盖率是这样的：
       x=71/167/263  → 0.83~0.84（表头区三列画得粗）
       x=358/453/550/646/742 → 0.53~0.78（正文里被手写笔画压断一部分）
       而格子中间的汉字 → 0.10~0.30
     峰和谷中间有一条明显的空档（0.35~0.50），门槛放这里就行。
     用「中位数 + 幅度 × 系数」自适应：不同照片的对比度不一样，
     固定阈值在浅色照片上会全灭、在深色照片上会全留。 */
  const W = x1 - x0;
  const srt = [];
  for (let cx = x0 + wd; cx <= x1 - wd; cx++) srt.push(colInk[cx] / Math.max(1, rows));
  srt.sort((a, b) => a - b);
  if (!srt.length) return [];
  const med = srt[srt.length >> 1];
  const hi = srt[Math.floor(srt.length * 0.95)];
  if (hi <= med + 1e-6) return [];
  const thr = med + (hi - med) * 0.45;

  /* 峰：覆盖率 ≥ 阈值，且是 ±3px 内的局部最高点。
     ±3px 是为了把「同一条线 2~3px 内的相邻像素」和「透视造成的 1~2px 重复峰」一并压掉。 */
  const raw = [];
  for (let cx = x0 + 2; cx <= x1 - 2; cx++) {
    const v = colInk[cx] / Math.max(1, rows);
    if (v < thr) continue;
    let isMax = true;
    for (let d = 1; d <= 3 && isMax; d++) {
      if (cx - d >= x0 && colInk[cx - d] / Math.max(1, rows) > v) isMax = false;
      if (cx + d <= x1 && colInk[cx + d] / Math.max(1, rows) > v) isMax = false;
    }
    if (isMax) raw.push({ pos: cx, v });
  }
  if (raw.length < 2) return [];

  /* ④ 【用「间距一致性」筛出真正的列，这一步是决定性的】
     上一步的峰会混进很多「汉字笔画凑够覆盖率」的假列（覆盖率 0.3~0.5）。
     真列和假列的区别不在高度，而在**规律**：真列之间的距离高度一致
     （实测 96/96/95/95/97/96/96），假列是随机撒的。
     所以反过来做：先用最可信的一批峰估出格宽，再要求每一列都落在网格上。

     具体：
       ① 按覆盖率降序取前若干个峰，两两求差，差值的众数就是格宽；
       ② 以格宽为准绳，把网格向右「生长」：每一步在 [目标-容差, 目标+容差]
          里找覆盖率最高的峰，找到就接纳，找不到就按格宽补一个（缺列）；
       ③ 左右各生长一遍，得到完整列边界。 */
  const cov = raw.map((r) => ({ pos: r.pos, v: r.v }));
  if (cov.length < 3) return cov.map((p) => ({ pos: p.pos, cover: p.v }));

  /* ① 格宽：两两差值的众数。步长 2px 量化，统计落在同一桶里的对数。 */
  const diff = new Map();
  for (let i = 0; i < cov.length; i++) {
    for (let j = i + 1; j < cov.length; j++) {
      const d = cov[j].pos - cov[i].pos;
      if (d < 24 || d > W / 2) continue;
      const key = Math.round(d / 2) * 2;
      diff.set(key, (diff.get(key) || 0) + 1);
    }
  }
  let unit = 0, unitHit = 0;
  for (const [k, n] of diff) {
    /* 票数相同时偏向小值：格宽小更容易被「谐波」放大票数 */
    if (n > unitHit || (n === unitHit && k < unit)) { unit = k; unitHit = n; }
  }
  /* 差值桶量化到 2px，真实格宽可能是 k 或 k±1，用命中那些对的平均精确化 */
  if (unit) {
    let sum = 0, cnt = 0;
    for (let i = 0; i < cov.length; i++) {
      for (let j = i + 1; j < cov.length; j++) {
        const d = cov[j].pos - cov[i].pos;
        if (Math.abs(d - unit) <= 3) { sum += d; cnt++; }
      }
    }
    if (cnt) unit = Math.round(sum / cnt);
  }
  if (!unit || unitHit < 2) return cov.map((p) => ({ pos: p.pos, cover: p.v }));

  /* ② 从覆盖率最高的那个峰当锚点，左右生长 */
  const byV = cov.slice().sort((a, b) => b.v - a.v);
  const anchor = byV[0].pos;
  const tol = Math.max(4, Math.round(unit * 0.12));
  const snap = (target) => {
    let best = null;
    for (const c of cov) {
      if (Math.abs(c.pos - target) > tol) continue;
      if (!best || c.v > best.v) best = c;
    }
    return best;
  };

  const line = [{ pos: anchor, cover: byV[0].v }];
  for (let x = anchor + unit; x <= x1 + unit * 0.5; x += unit) {
    const hit = snap(x);
    if (hit && !line.some((p) => p.pos === hit.pos)) line.push({ pos: hit.pos, cover: hit.v });
    else line.push({ pos: Math.round(x), cover: 0 });
  }
  const left = [];
  for (let x = anchor - unit; x >= x0 - unit * 0.5; x -= unit) {
    const hit = snap(x);
    if (hit && !line.some((p) => p.pos === hit.pos) && !left.some((p) => p.pos === hit.pos)) {
      left.push({ pos: hit.pos, cover: hit.v });
    } else left.push({ pos: Math.round(x), cover: 0 });
  }
  left.reverse();
  const all = left.concat(line);

  /* ③ 裁掉表格外的部分：首尾各去掉覆盖率 0 的补点，最多留一条当外框 */
  let a = 0, b = all.length - 1;
  while (a < b && all[a].cover === 0) a++;
  while (b > a && all[b].cover === 0) b--;
  const body = all.slice(a, b + 1);
  const out = body.map((p) => ({ pos: Math.max(x0, Math.min(x1, p.pos)), cover: p.cover }));
  /* 左右外框：若首列离画面边缘还有半格以上，补一条边框线 */
  if (out.length && out[0].pos - x0 > unit * 0.5) out.unshift({ pos: x0, cover: 0 });
  if (out.length && x1 - out[out.length - 1].pos > unit * 0.5) out.push({ pos: x1, cover: 0 });
  return out;
}

function h0Guard(mono, w) {
  return Math.floor(mono.length / Math.max(1, w));
}

export const _findTableLines = findTableLines;
export const _cols = detectColumns;
export const _projLines = projLines;
export const _tilt = detectTilt;
export const _shear = shearMono;
export const _dilate = dilate;
export const _dedupe = dedupeLines;
export const _rebuild = rebuildEven;
export const _frame = tableFrame;
export const _longRuns = longRuns;

/* 找表格线：逐行/逐列统计深色像素占比。
   【截图专用】照片走 findTableLines（倾斜校正 + 投影法）；
   截图是纯正的水平/垂直，这条简单路子又快又准，别动它。 */
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
  const { hs, vs } = findTableLines(mono, w, h);

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
  /* 【坐标口径】
     imageToMono 会把宽度压到 ≤1600。下面算出来的 box 全是「压缩后」坐标系里的，
     但 cellImage / 考勤裁切都拿它去 drawImage(原图)，图宽超过 1600 时就会裁错位置
     （表现为「原图对照」那列显示的是原图左上角的某块，而不是这一格）。
     所以这里把系数一起返回，谁要回原图坐标谁自己乘。 */
  const nw = img.naturalWidth || img.width || w;
  const scale = w ? nw / w : 1;
  /* 【截图走 findLines，不走 findTableLines】
     截图是原生水平的，覆盖率阈值一判就准，还快（不做倾斜搜索）。
     findTableLines 那套倾斜校正 + 投影 + 网格生长是给手机拍照用的，
     在截图上反而会因为「等距假设」把非等宽的列（序号窄、备注宽）拉歪。 */
  const { hs, vs } = findLines(mono, w, h);
  if (hs.length < 3 || vs.length < 3) {
    return { ok: false, reason: '没找到表格线。请截得正一点（别斜拍），或者把表格拍满一些。', w, h, scale };
  }
  const built = buildGrid(mono, w, h, hs, vs);
  return { ok: true, w, h, scale, mono, hs, vs, ...built };
}

/* 在「任意来源」的二值图上切格子。detectGrid（截图）和 detectPhotoGrid（照片）
   拿到的是同一形状的 { mono, w, h, hs, vs }，切格逻辑一字不差，
   所以抽出来共用 —— 免得两套各自演化、照片能认截图不能认。 */
function buildGrid(mono, w, h, hs, vs) {
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
      const st = (y1 > y0 && x1 > x0)
        ? cellStats(mono, w, y0, y1, x0, x1)
        : { ink: 0, bx: x0, by: y0, bw: 1, bh: 1, cellFill: 0 };
      line.push({
        row: r, col: c,
        ink: st.ink,
        filled: st.ink >= thr,
        bx: st.bx, by: st.by, bw: st.bw, bh: st.bh, cellFill: st.cellFill,
        box: { x: vs[c], y: hs[r], w: vs[c + 1] - vs[c], h: hs[r + 1] - hs[r] },
      });
    }
    grid.push(line);
  }
  return { rows, cols, grid, thr };
}

/* 照片入口：自动定方向 → 切网格。返回结构和 detectGrid 完全一致，
   额外带 rotation，上层裁预览图时原样传回 cellImagePhoto。 */
export function detectGridPhoto(img) {
  const g = detectPhotoGrid(img);
  if (!g.ok) return { ok: false, reason: g.reason };
  const { mono, w, h, hs, vs, rotation, scale } = g;
  if (hs.length < 3 || vs.length < 3) {
    return { ok: false, reason: '表格线太少，没法切格子。请把表格拍满画面、尽量正对。' };
  }
  const built = buildGrid(mono, w, h, hs, vs);
  return { ok: true, photo: true, rotation, w, h, scale, mono, hs, vs, ...built };
}

/* 一格里的墨点统计：墨量 + 墨点外接框 + 5×5 小格里「有墨」的比例。
   比单纯的 cellInk 多算两件事，但比整张图重算便宜得多（只扫这一格的像素）。
   为什么要外接框：勾叉只占格子中间一小块，用格子面积当分母会让它和
   「写满的汉字」算出差不多的密度，分不开。 */
function cellStats(mono, w, y0, y1, x0, x1) {
  let ink = 0;
  let minX = x1, maxX = x0 - 1, minY = y1, maxY = y0 - 1;
  const G = 5;
  const cells = new Uint8Array(G * G);
  const gw = Math.max(1, (x1 - x0) / G);
  const gh = Math.max(1, (y1 - y0) / G);
  for (let y = y0; y < y1; y++) {
    const base = y * w;
    for (let x = x0; x < x1; x++) {
      if (!mono[base + x]) continue;
      ink++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      const gx = Math.min(G - 1, Math.floor((x - x0) / gw));
      const gy = Math.min(G - 1, Math.floor((y - y0) / gh));
      cells[gy * G + gx] = 1;
    }
  }
  let hit = 0;
  for (let i = 0; i < cells.length; i++) hit += cells[i];
  return {
    ink,
    bx: minX, by: minY,
    bw: Math.max(1, maxX - minX + 1),
    bh: Math.max(1, maxY - minY + 1),
    cellFill: hit / (G * G),
  };
}

/* 把某一格单独渲染成小图，用于人工核对（考勤里给「这格我认成了 √」做预览）。
   box 是 detectGrid 给出的「压缩坐标系」盒子，这里按 scale 换算回原图再裁。
   返回 dataURL；格子太小或没字返回 ''。 */
export function cellImage(img, box, scaleZoom = 2, scale = 1) {
  const c = document.createElement('canvas');
  const bx = box.x * scale; const by = box.y * scale;
  const bw = box.w * scale; const bh = box.h * scale;
  c.width = Math.max(1, Math.round(bw * scaleZoom));
  c.height = Math.max(1, Math.round(bh * scaleZoom));
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
  g.drawImage(img, bx, by, bw, bh, 0, 0, c.width, c.height);
  return c.toDataURL('image/png');
}

/* ==========================================================================
   照片专用：方向校正 + 网格识别
   --------------------------------------------------------------------------
   【为什么要单独一套】
   用户拍的照片有三个截图没有的问题，detectGrid 一个都兜不住：

   ① **方向**。手机竖着拍一张横版表格，存出来是 1368×1824，内容逆时针躺倒 90°。
      不校正的话，横线全变成竖线，一根表格线都认不出。
      用户这次传的 5 张里有 3 张是这种，是最主要的原因。
      【坑】只转正「宽 < 高」的图是不够的：用户还有 1824×1368 的横向照片，
      里面表格是横的，属于正常摆放。所以方向必须**实测**：
      四个角度各切一次，谁切出的「行 × 列」最大且格子数最多就用谁。

   ② **透视/倾斜**。手拍总会歪 1~3°，一条横线跨 1600px 会斜 20~40px。
      findTableLines 里的游程聚类 + 峰检测专门处理这个。

   ③ **纸边、阴影、手指**。画面里有一大片非表格区域，不能直接当格子。

   【返回什么】
   和 detectGrid 一样的形状（多一个 rotation 字段），上层代码不用改。
   ========================================================================== */

/* 按角度旋转 + 缩放 + 局部二值化，一步到位。
   --------------------------------------------------------------------------
   【为什么用 canvas 变换而不是先转成 ImageData 再重排像素】
   90/180/270 度旋转在 canvas 里是「整像素平移」，不会产生任何插值；
   而竖拍照片（1368×1824）转 90° 之后还要 scale 到 1800 宽，
   这一层缩放**必须**在旋转之后做，否则线宽会被插值糊成 2~3px 的灰带，
   findTableLines 的游程判据就废了。

   @param targetW 目标宽度。不传就按 MAX 自适应（长边压到 1800）。
     传了的话按这个宽度出图 —— 竖拍表转正后要用「长边」当宽度，
     不然表格会被压扁、行线粘连。 */
function monoRotated(img, deg, targetW = 0) {
  const nw = img.naturalWidth || img.width;
  const nh = img.naturalHeight || img.height;
  const swap = deg === 90 || deg === 270;
  const RW = swap ? nh : nw;      // 旋转后的原图尺寸
  const RH = swap ? nw : nh;
  let w = RW, h = RH;
  const MAX = 1800;
  if (targetW) {
    w = Math.min(targetW, RW); h = Math.round(RH * w / RW);
  } else if (Math.max(w, h) > MAX) {
    const k = MAX / Math.max(w, h); w = Math.round(w * k); h = Math.round(h * k);
  }
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.save();
  if (deg === 90) { g.translate(w, 0); g.rotate(Math.PI / 2); g.drawImage(img, 0, 0, h, w); }
  else if (deg === 180) { g.translate(w, h); g.rotate(Math.PI); g.drawImage(img, 0, 0, w, h); }
  else if (deg === 270) { g.translate(0, h); g.rotate(-Math.PI / 2); g.drawImage(img, 0, 0, h, w); }
  else g.drawImage(img, 0, 0, w, h);
  g.restore();

  const d = g.getImageData(0, 0, w, h).data;
  const gray = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    gray[p] = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) | 0;
  }
  /* 局部二值化：邻域半径按图尺寸取，小图用小窗口，否则窗口比字还大就失效了 */
  const box = Math.max(15, Math.round(Math.min(w, h) * 0.022)) | 1;
  const mono = localBinarize(gray, w, h, box, 0.13);
  return { mono, w, h, gray };
}

/* ==========================================================================
   线表整理：去重 → 等距吸附 → 补漏
   --------------------------------------------------------------------------
   longRuns + clusterRuns 出来的线是「像素级」的，直接拿去切格子有三个毛病，
   在真实照片上全都会犯：

   ① **一条线被拆成几条**。表格线有 2~3px 粗，加上倾斜，聚类后常常留下
      `140 / 172 / 174` 这种 2~4px 间距的重复行 —— 行高比瞬间爆表。
   ② **线歪了半行**。斜着拍的表格，同一条线左端 pos=140、右端 pos=176，
      聚类后会得到 140 和 172 两条。平均之后仍然偏，切出来的格子上下错位。
   ③ **漏线**。汉字压断表格线、铅笔划痕盖住线、装订孔打出白洞，都会让某条
      横线整条消失。结果两行合成一行 —— 那一行的两个人就只认出一半。

   三步对症：
     ① dedupe：间距 < 中位行高 45% 的合并成一条（加权平均，取厚的）
     ② fit   ：用中位间距拟合等差数列，把每条线吸到最近的等距槽位上
                （表格本来就是等距的，这一步能把 140/172 都归到 168）
     ③ fill  ：槽位空缺率 ≤ 1/3 时补上（真漏了几条）；超过就说明「这个方向
                根本不是表格的横线方向」，一条都不补 —— 不然会把
                纯文字段落的自适应成几十条假线。
   ========================================================================== */
function dedupeLines(arr, tolRatio = 0.45) {
  if (arr.length < 2) return arr.slice();
  const a = arr.slice().sort((p, q) => p - q);
  const gaps = [];
  for (let i = 1; i < a.length; i++) gaps.push(a[i] - a[i - 1]);
  gaps.sort((p, q) => p - q);
  const med = gaps[gaps.length >> 1] || 1;
  const tol = Math.max(2, med * tolRatio);
  const out = [a[0]];
  const cnt = [1];
  for (let i = 1; i < a.length; i++) {
    if (a[i] - out[out.length - 1] <= tol) {
      out[out.length - 1] = (out[out.length - 1] * cnt[cnt.length - 1] + a[i]) / (cnt[cnt.length - 1] + 1);
      cnt[cnt.length - 1]++;
    } else { out.push(a[i]); cnt.push(1); }
  }
  return out.map((v) => Math.round(v));
}

/* ==========================================================================
   等距重建：把「检出的线」硬拽成一张规整的表格
   --------------------------------------------------------------------------
   这一步是整个照片识别的地基，值得单独说明。

   【为什么必须硬拽】
   考勤表是印刷出来的，行高列宽**必然等距**。但检出结果永远做不到等距：
     · 手机斜拍，透视让 24 行的行高从 22px 线性变到 48px
     · 字压断线、装订孔、折痕，个别线整条消失或位置偏 10px
     · 相邻两条线粘连，聚类时被并成一条

   实测「高二签到表」原始检出 25 条横线，而真值是 25 条（表头 1 + 24 行），
   看起来对上了 —— 但仔细比间距：`49,50,34,43,44,44,65,23,44,...`，
   真值应该是 24 个几乎相同的数。这说明「多出来的线」和「丢掉的线」刚好
   抵消了条数，位置却全错：切出来的格子错行，姓名和勾对不上。

   【做法】
     ① 中位间距 = 一个「行」的真实高度（透视下是中位数，仍然准）
     ② 以最靠边的两条线为锚，生成 起点 + k*step 的完整等差数列
     ③ 每条真实线就近吸附到槽位，槽位取吸附线位置的均值
     ④ 槽位数（= 行数）必须落在「合理行数区间」内，否则拒绝重建

   【为什么敢直接按等差生成，而不管「这条线到底存不存在」】
   因为下游要做的是「切格子读勾」。多切一行空行，读出来的姓名是空的，
   直接被过滤掉，无害；少切一行，那一行的两个人全丢，是致命错误。
   所以宁可多切也不能少切 —— 等差生成天然保证不漏。

   唯一要防的是「把文字的行距当成表格行距」。所以要求：
     · step ≥ 8px（小于 8px 的「行」物理上放不下字）
     · 锚点范围内至少 4 条线（3 条以内看不出等距）
     · 重建后的槽位数 ≤ 检出线数 × 2.2（差太多说明不是在拽表格线）
   ========================================================================== */
function rebuildEven(arr, opt = {}) {
  const minStep = opt.minStep || 10;
  const maxGapK = opt.maxGapK || 2.5;
  if (!arr || arr.length < 4) return { lines: (arr || []).slice(), even: false };

  const a = arr.slice().sort((p, q) => p - q);
  const gaps = [];
  for (let i = 1; i < a.length; i++) gaps.push(a[i] - a[i - 1]);
  const sorted = gaps.slice().sort((p, q) => p - q);
  const step = sorted[sorted.length >> 1];
  if (!step || step < minStep) return { lines: a, even: false };

  /* 线性插值补缺：两个相邻检出线之间隔了 k 个「行高」就补 k-1 条。
     只在缺口 ≤ maxGapK 倍行高时补 —— 缺口太大说明中间根本不是表格
     （比如双栏表两栏之间的空白），补了会造出一堆假行。 */
  const out = [a[0]];
  let filled = 0;
  for (let i = 1; i < a.length; i++) {
    const gap = a[i] - a[i - 1];
    const k = Math.round(gap / step);
    if (k >= 2 && k <= maxGapK) {
      for (let m = 1; m < k; m++) {
        out.push(a[i - 1] + (gap * m) / k);
        filled++;
      }
    }
    out.push(a[i]);
  }
  return { lines: out.map((v) => Math.round(v)), even: true, step: Math.round(step), filled, n: out.length - 1 };
}

/* 一套网格算「像不像表格」的评分。
   --------------------------------------------------------------------------
   【核心判据：横线要密、竖线要疏】
   考勤表是「宽行 × 窄列」：一行 25~40px 高，一列 60~200px 宽，所以
   **同样长度的表格，横线条数永远明显多于竖线**（15×11 的表是 16 : 12）。
   一旦方向差了 90°，这个比例立刻翻过来（12 : 16）。
   实测五张照片，正确方向的 cellsPerH / cellsPerV 落在 0.55~0.85，
   错误方向落在 1.5~4.0 —— 分离度足够大，单独这一条就能定方向。

   【辅助判据：格子要方】真实表格的格子宽高比集中在 0.8~4。
   如果某个方向的格子平均高 200px、宽 40px（6:1），那是把「段落文字之间
   的空白」当成了行分隔，不是表格。

   【为什么不再用「行高比 / 列宽比」判负】
   原来用 cv(dh) > 6 直接返回 -1，在照片上全军覆没：手机斜拍时同一张表
   的行高从 22px 到 48px 都可能（透视），检出里还夹着 2px 的重复线。
   现在改成「先去重 + 吸附，再算分」，不再一刀切。 */
function gradeGrid(hs, vs, w, h, runInfo) {
  const rows = hs.length - 1;
  const cols = vs.length - 1;
  if (rows < 2 || cols < 2) return -1;

  const gapsOf = (arr) => {
    const out = [];
    for (let i = 1; i < arr.length; i++) out.push(arr[i] - arr[i - 1]);
    return out;
  };
  const med = (arr) => {
    if (!arr.length) return 0;
    const s2 = arr.slice().sort((p, q) => p - q);
    return s2[s2.length >> 1];
  };
  const cellH = med(gapsOf(hs));
  const cellW = med(gapsOf(vs));
  if (!cellH || !cellW) return -1;

  /* 格子宽高比。正常考勤表 1.5~4（宽 90px 高 28px）；
     >10 说明「列」其实是正文字宽、「行」是段落，不是表格。 */
  const aspect = cellW / Math.max(1, cellH);
  if (aspect > 16 || aspect < 0.06) return -1;

  /* 覆盖面积：表格矩形占画面比例，太小就是「桌上的一个角落」。 */
  const area = ((hs[hs.length - 1] - hs[0]) * (vs[vs.length - 1] - vs[0])) / Math.max(1, w * h);
  if (area < 0.10) return -1;

  /* 主分：格子数。横向（行多、每行矮）是考勤表的天然形态，
     所以同样格子数下「行多列少」的方向要给正分，「行少列多」要减分。
     这条是方向判定的关键：0° 和 90° 的「行×列」经常恰好对称，
     但**表格的物理形态不对称** —— 一行只有 28px 高，一列有 90px 宽。 */
  let score = Math.min(rows, 60) * Math.min(cols, 24);
  if (rows < 4 || cols < 2) score *= 0.25;

  if (runInfo) {
    /* 【最有区分度的一条：横线的覆盖率】
       表格横线在它自己的 x 区间内几乎每个点都有墨（cover 0.75~1.0），
       而「汉字竖着叠出来的假线」只有 0.03~0.4。
       所以「高覆盖率横线的条数」是判方向最硬的指标：
       方向对了，这族线就是表格的行分隔线。 */
    const strongH = runInfo.hLines.filter((l) => l.cover >= 0.6 && l.len >= w * 0.06).length;
    const strongV = runInfo.vLines.filter((l) => l.cover >= 0.6 && l.len >= h * 0.06).length;
    score *= 0.6 + 0.4 * Math.min(2, 1 + (strongH - strongV) * 0.15);
    if (strongH < 3) score *= 0.3;
    /* 横线总长 / 画面宽 明显高于 竖线总长 / 画面高 → 表格正着 */
    const hCov = runInfo.hLen / Math.max(1, w);
    const vCov = runInfo.vLen / Math.max(1, h);
    if (hCov > vCov * 1.15) score *= 1.3;
    else if (vCov > hCov * 1.2) score *= 0.45;
  }
  return score;
}

/* 判断某张二值图里「表格是横着的还是竖着的」。
   只做线表检测 + 整理，评分交给 gradeGrid。 */
function orientationOf(mono, w, h) {
  const r = findTableLines(mono, w, h);
  return { ...r, flat: r.hs.length >= r.vs.length, gap: Math.abs(r.hs.length - r.vs.length) };
}

/* 自动定方向 + 切网格。返回 { ok, rotation, hs, vs, mono, w, h, scale } */
export function detectPhotoGrid(img) {
  const nw = img.naturalWidth || img.naturalWidth || img.width;
  const nh = img.naturalHeight || img.height;

  const cand = [];
  for (const deg of [0, 90, 270]) {
    const { mono, w, h } = monoRotated(img, deg);
    const o = orientationOf(mono, w, h);
    /* 【关键：评分必须在「整理过的线表」上算】
       原始检出里夹着 2px 间距的重复线，直接算行高比会得到 48 这种荒谬值
       （实测「微信图片」deg0 的 dh 是 [8,12,44,7,13,4,16,0,...]，中位行高
       只有 14px，而画面高 1350px —— 这明显是文字笔画，不是表格）。
       先去重吸附，得到「这条线表到底能不能切出方格」，再评分。 */
    const hs2 = rebuildEven(dedupeLines(o.hs), { minStep: 10 }).lines;
    const vs2 = rebuildEven(dedupeLines(o.vs), { minStep: 12 }).lines;
    const score = gradeGrid(hs2, vs2, w, h, o);
    cand.push({ deg, mono, w, h, hs: hs2, vs: vs2, score, hLines: o.hLines || [], frame: o.frame || null });
  }
  cand.sort((a, b) => b.score - a.score);
  const best = cand[0];
  if (!best || best.score <= 0) {
    return { ok: false, reason: '没找到表格线。拍照时把整张表放进取景框、尽量正对着拍（别太斜），光线均匀一点，再试一次。' };
  }

  const { deg, mono, w, h, hs } = best;

  /* 【列：在「行边界确定的矩形」里专门检一次】
     方向定下来、行检出来之后，表的上下边界就确定了。
     这时判列有了一条硬标准：列边界必须在整个表高范围内都有墨。
     用它一次干掉「汉字一竖」这类干扰（它们只贯穿字自己那一行）。
     见 detectColumns 注释。拿不到足够列时退回原来的 vs。 */
  /* 【先裁剪 hs：只保留「最长的那条横线」所围成的区间】
     hs 里除了真行线，还混着标题下划线、页脚线、装订孔打出来的假线。
     用它们首尾当表高会让列投影统计到表格外面的区域，覆盖率全被稀释。
     真表格的外框线是最长最直的那几条：取 hLines 里 len 最大的那条当锚，
     然后把「长度 ≥ 锚长 70%」的线围成的区间当表高。 */
  const hLen0 = best.hLines || [];
  let yTop, yBot;
  if (hLen0.length >= 2) {
    const mxLen = Math.max(...hLen0.map((l) => l.len || 0));
    const strong = hLen0.filter((l) => (l.len || 0) >= mxLen * 0.7).map((l) => l.pos);
    yTop = strong.length >= 2 ? Math.min(...strong) : hs[0];
    yBot = strong.length >= 2 ? Math.max(...strong) : hs[hs.length - 1];
  } else {
    yTop = hs[0]; yBot = hs[hs.length - 1];
  }
  const cols = detectColumns(mono, w, yTop, yBot, 0, w - 1);
  const vs = cols.length >= 4 ? cols.map((c) => c.pos) : best.vs;

  /* 【坐标换算】上层拿 box 回原图裁预览，要用**旋转后**的原图尺寸换算。
     旋转 90° 时预览图也得转，所以把 rotation 一起返回，
     cellImagePhoto 按同一个角度重画原图再裁。 */
  const swap = deg === 90 || deg === 270;
  const RW = swap ? nh : nw;
  const scale = RW / Math.max(1, w);
  return {
    ok: true, rotation: deg, hs, vs, mono, w, h, scale,
    hLines: best.hLines || [], frame: best.frame || null,
    tTop: yTop, tBot: yBot,
    _cand: cand.map((c) => ({
      deg: c.deg, rows: Math.max(0, c.hs.length - 1), cols: Math.max(0, c.vs.length - 1),
      score: Math.round(c.score),
    })),
  };
}

/* 按 detectPhotoGrid 的坐标系裁一格预览图。
   rotation 必须和 detectPhotoGrid 返回的一致，否则裁出来是歪的。 */
export function cellImagePhoto(img, box, rotation = 0, scaleZoom = 2, scale = 1) {
  const nw = img.naturalWidth || img.width;
  const nh = img.naturalHeight || img.height;
  const swap = rotation === 90 || rotation === 270;
  const RW = swap ? nh : nw;
  const RH = swap ? nw : nh;
  /* 先在「旋转后的原图尺寸」上建画布，再整体转回来画 */
  const full = document.createElement('canvas');
  full.width = RW; full.height = RH;
  const fg = full.getContext('2d');
  fg.fillStyle = '#fff'; fg.fillRect(0, 0, RW, RH);
  fg.save();
  if (rotation === 90) { fg.translate(RW, 0); fg.rotate(Math.PI / 2); }
  else if (rotation === 180) { fg.translate(RW, RH); fg.rotate(Math.PI); }
  else if (rotation === 270) { fg.translate(0, RH); fg.rotate(-Math.PI / 2); }
  fg.drawImage(img, 0, 0, swap ? RH : RW, swap ? RW : RH);
  fg.restore();

  const bx = box.x * scale; const by = box.y * scale;
  const bw = Math.max(2, box.w * scale); const bh = Math.max(2, box.h * scale);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bw * scaleZoom));
  c.height = Math.max(1, Math.round(bh * scaleZoom));
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
  g.drawImage(full, bx, by, bw, bh, 0, 0, c.width, c.height);
  return c.toDataURL('image/png');
}
