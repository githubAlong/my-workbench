/* ============ 考勤表语义识别：把「二维数组」翻译成「结构化考勤表」 ============
 *
 * 输入是 xlsx / csv 读出来的 rows（string[][]），输出是：
 *   { grade, date, period, type, columns, people, warnings }
 *
 * 设计原则：
 *   ① 先认「列标题」，再按列取「人」。老师的表列标题非常固定：
 *      序号 姓名 学科 上课 坐班 听课 教研 请假 备注，教研表是 序号 姓名 学科 签到 备注。
 *   ② 必须支持**一页双栏**：右边还有一组「序号 姓名 学科 …」。
 *      判据：同一行里「序号」出现两次 → 从第二个序号开始是右半栏。
 *   ③ 判勾：单元格有字就算打了。手写的 √ ✓ 1 是 / 对勾字符 / 任意非空标记都算「已勾」。
 *      空白 = 未勾。这一条比图像识别稳得多，因为 Excel 里就是「有内容/没内容」。
 *   ④ 表头上方那行「时间 2026 年 10 月 19 日 星期 一 第 二 节」要能解析出日期和节次。
 *      它是拆散在一个个单元格里的（年/月/日各占一格），要按顺序拼。
 */

/* 列标题归一化：去掉空格、全角转半角、去掉标点 */
export function normHead(s) {
  return String(s || '')
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/\s+/g, '')
    .replace(/[：:（）()【】\[\]・.。、]/g, '')
    .toLowerCase();
}

/* 认一个列标题属于哪一类 */
const HEAD_RULES = [
  ['no', ['序号', '编号', '序', 'no', 'no.', '工号']],
  ['name', ['姓名', '名字', '教师', '老师', 'name']],
  ['subject', ['学科', '科目', '学科组', '教研组', 'subject']],
  ['attend', ['上课', '坐班', '听课', '教研', '签到', '出勤', '到岗', '在岗', '值班', '坐班情况']],
  ['leave', ['请假', '公假', '病假', '事假', '缺勤', 'leave']],
  ['remark', ['备注', '说明', 'remark', 'note']],
];

function headKind(cell) {
  const h = normHead(cell);
  if (!h) return null;
  for (const [kind, words] of HEAD_RULES) {
    if (words.some((w) => h === normHead(w))) return kind;
  }
  // 「坐班情况」「上课情况」这类带后缀的
  for (const [kind, words] of HEAD_RULES) {
    if (words.some((w) => w.length >= 2 && h.includes(normHead(w)))) return kind;
  }
  return null;
}

/* 一个单元格是否被标记（打了勾） */
const MARK_EMPTY = /^[\s\u3000]*$/;
const MARK_NEG = /^[×xX✗✘╳]$/;
export function isMarked(v) {
  const s = String(v == null ? '' : v).trim();
  if (MARK_EMPTY.test(s)) return false;
  if (MARK_NEG.test(s)) return false;
  // 数字 0 / "否" 也算没打
  if (s === '0' || s === '否' || s === '无' || /^no?$/i.test(s)) return false;
  return true;
}

/* 中文数字 → 阿拉伯数字 */
const CN_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
  十一: 11, 十二: 12, 十三: 13, 十四: 14, 十五: 15, 十六: 16, 十七: 17, 十八: 18, 十九: 19, 二十: 20 };
export function toNum(s) {
  const t = String(s || '').trim().replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  if (/^\d+$/.test(t)) return Number(t);
  const n = Number(t);
  if (Number.isFinite(n) && t !== '') return n;
  return CN_NUM[t] ?? null;
}

/* 从表头上方的碎单元格里拼出 年/月/日/节次/星期 */
export function parseHeadMeta(rows) {
  const out = { year: null, month: null, day: null, period: null, weekday: null, grade: null };
  // 只看前 5 行（表头通常在最上面）
  const flat = [];
  for (let r = 0; r < Math.min(5, rows.length); r++) {
    for (let c = 0; c < (rows[r] || []).length; c++) flat.push({ r, c, v: String(rows[r][c] || '').trim() });
  }
  const txt = flat.map((x) => x.v).join(' ');
  const joined = flat.map((x) => x.v).filter(Boolean).join('');

  // 年级：表名或表头里出现「高一 / 高二 / 高三」
  const gm = /(高[一二三]|初[一二三])/.exec(joined);
  if (gm) out.grade = gm[1];

  /* 年 / 月 / 日：形如 「2026 年 10 月 19 日」，也可能被拆成一格一个字。
     做法：在展平序列里找「年」，它前面最近的纯数字就是年份。 */
  const findBefore = (idx, maxBack = 6) => {
    for (let i = idx - 1; i >= Math.max(0, idx - maxBack); i--) {
      const n = toNum(flat[i]?.v);
      if (n != null && String(flat[i].v).match(/^\d{1,4}$/)) return n;
    }
    return null;
  };
  flat.forEach((x, i) => {
    if (/^年$/.test(x.v) && out.year == null) {
      const y = findBefore(i);
      if (y && y >= 1900 && y <= 2200) out.year = y;
    }
    if (/^月$/.test(x.v) && out.month == null) {
      const m = findBefore(i, 4);
      if (m && m >= 1 && m <= 12) out.month = m;
    }
    if (/^日$/.test(x.v) && out.day == null) {
      const d = findBefore(i, 4);
      if (d && d >= 1 && d <= 31) out.day = d;
    }
  });

  // 正则兜底：连续文本里直接出现 2026-10-19 / 2026年10月19日
  if (out.year == null) {
    const m = /(20\d{2})\s*[-/年.]\s*(\d{1,2})\s*[-/月.]\s*(\d{1,2})/.exec(txt) || /(20\d{2})-(\d{1,2})-(\d{1,2})/.exec(txt);
    if (m) { out.year = Number(m[1]); out.month = Number(m[2]); out.day = Number(m[3]); }
  }

  // 星期
  const wm = /星期\s*([一二三四五六日天])/.exec(joined) || /周\s*([一二三四五六日天])/.exec(joined);
  if (wm) out.weekday = '一二三四五六日'[('一二三四五六日'.indexOf(wm[1]))] || (wm[1] === '天' ? '日' : wm[1]);

  // 节次：「第 二 节」「第2节」「2节」
  const pm = /第\s*([一二三四五六七八九十\d]{1,2})\s*节/.exec(joined);
  if (pm) {
    const n = toNum(pm[1]);
    if (n && n >= 1 && n <= 12) out.period = n;
  }
  return out;
}

/**
 * 主识别函数
 * @param {string[][]} rows
 * @param {object} opts { gradeHint, typeHint }
 */
export function parseAttendanceSheet(rows, opts = {}) {
  /* labelMode：'seg' = 左右栏加前缀（一页双栏的坐班表用）
     'group' = 按学科分组（教研签到表按学科一块一块排，加左右栏反而看不懂） */
  const labelMode = opts.labelMode || 'seg';
  const warnings = [];
  const meta = parseHeadMeta(rows);
  const grade = meta.grade || opts.gradeHint || '';

  /* ---------- 1. 找列标题行 ---------- */
  // 一行里同时出现「姓名」和（序号|学科），就当标题行
  let headRow = -1;
  let bestScore = 0;
  for (let r = 0; r < Math.min(8, rows.length); r++) {
    const row = rows[r] || [];
    let score = 0;
    for (const cell of row) {
      const k = headKind(cell);
      if (k === 'name') score += 3;
      if (k === 'no') score += 2;
      if (k === 'subject') score += 2;
      if (k === 'attend' || k === 'leave' || k === 'remark') score += 1;
    }
    if (score > bestScore) { bestScore = score; headRow = r; }
  }
  if (headRow < 0 || bestScore < 4) {
    return { ok: false, reason: '没找到「序号 / 姓名 / 学科」这样的列标题行，认不出这是不是一张考勤表。', meta, warnings };
  }

  /* ---------- 2. 切分双栏 ---------- */
  const head = rows[headRow].map((c) => String(c || '').trim());
  // 找出所有「序号」标题所在列
  const noCols = [];
  head.forEach((c, i) => { if (headKind(c) === 'no') noCols.push(i); });
  // 半栏边界：第一个序号列 ~ 第二个序号列前
  const segments = [];
  if (noCols.length >= 2) {
    for (let i = 0; i < noCols.length; i++) {
      const start = noCols[i];
      const end = i + 1 < noCols.length ? noCols[i + 1] : head.length;
      segments.push([start, end]);
    }
  } else if (noCols.length === 1) {
    segments.push([noCols[0], head.length]);
  } else {
    // 没有序号列，就按姓名列切
    const nameCol = head.findIndex((c) => headKind(c) === 'name');
    if (nameCol < 0) return { ok: false, reason: '没找到「姓名」列', meta, warnings };
    segments.push([Math.max(0, nameCol - 1), head.length]);
  }

  /* ---------- 3. 每个半栏各自映射列 ---------- */
  /* 先粗判一次表类型：看整行标题里有没有「教研/签到」而没有「坐班/上课」。
     这里只是为了让列名好听（教研表的「签到」不该叫「左栏·签到」），
     最终类型在下面第 5 步还会再判一次。 */
  const headAll = head.join('|');
  const type0 = (/教研|签到/.test(headAll) && !/坐班|上课|听课/.test(headAll)) ? 'research' : 'seat';
  const columns = [];   // [{key,label,type,seg}]
  const segCols = [];
  segments.forEach(([from, to], si) => {
    const map = { no: -1, name: -1, subject: -1, marks: [], leave: -1, remark: -1 };
    for (let c = from; c < to; c++) {
      const k = headKind(head[c]);
      if (k === 'no' && map.no < 0) map.no = c;
      else if (k === 'name' && map.name < 0) map.name = c;
      else if (k === 'subject' && map.subject < 0) map.subject = c;
      else if (k === 'attend') map.marks.push(c);
      else if (k === 'leave' && map.leave < 0) map.leave = c;
      else if (k === 'remark' && map.remark < 0) map.remark = c;
    }
    segCols.push(map);
    // 勾选列：双栏表左右两栏的列名会重复（都有「上课/坐班/听课/教研」），
    // 加上「左栏/右栏」前缀，否则页面上两组同名列分不清该勾哪个。
    const multi = segments.length > 1 && labelMode === 'seg';
    map.marks.forEach((c) => {
      const base = head[c] || `第${c + 1}列`;
      /* 教研签到表只有一个「签到」列，左右栏名字一样才是正常的，不加前缀 */
      const prefixed = multi && !(type0 === 'research' && map.marks.length === 1);
      const label = prefixed ? `${si === 0 ? '左栏·' : '右栏·'}${base}` : base;
      columns.push({ key: `c${si}_${c}`, label, rawLabel: base, type: 'check', col: c, seg: si });
    });
  });

  /* ---------- 4. 逐行取人 ---------- */
  /* 【为什么按栏分组输出，而不是按行交错】
     一页双栏的表，人眼读法是「先把左边 1~23 号读完，再读右边 24~46 号」。
     如果按行取（左1、右24、左2、右25…），导出来序号是乱的
     （1,24,2,25,3,26…），老师核对时完全对不上原文。
     所以这里先收集，最后按栏号稳定排序：seg 小的在前，同栏内保持原顺序。 */
  const people = [];
  /* 【被判为"不是人名"的格子，要记下来告诉用户】
     下面那个正则会把「李四（备课组长）」「赵六一2」这类名字挡掉。
     原来挡掉就挡掉，一声不吭 —— 老师看到的是"5 个人只导进来 3 个"，
     而且确认弹层上的「N 位教师」也是少算的，他根本意识不到少了人。
     现在把每一处被挡掉的原文收进 droppedNames，最后拼一条 warning。 */
  const droppedNames = [];
  for (let r = headRow + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    let got = 0;
    segCols.forEach((map, si) => {
      const name = String(row[map.name] ?? '').trim();
      if (!name) return;
      /* 【姓名只排除"明显不是人"的，不再要求必须是纯中文】
         原来的正则 ^[\u4e00-\u9fa5a-zA-Z·\s]{2,10}$ 太窄，真实学校里这些写法全被吃掉了：
           李四（备课组长）   带职务后缀
           赵六一2            带编号
           A2 / 张1          用编号代称
           比 10 个字更长     少数民族姓名、带说明的名字
         老师不会因为这些就被"不算人"，所以这里只挡三种：
           ① 纯数字（那就是序号列认错了）
           ② 纯符号
           ③ 长度超过 30（基本是整段话，不是名字）
         剩下的一律当人名，宁可多认一个错的（确认弹层可以逐行改），
         也不要少认一个对的（少认是静默的，改都没处改）。 */
      const isName = name.length <= 30
        && !/^\d+(\.\d+)?$/.test(name)
        && /[\u4e00-\u9fa5a-zA-Z]/.test(name);
      if (!isName) { droppedNames.push(name); return; }
      if (/^(姓名|序号|学科|备注|合计|小计|总计)$/.test(name)) return;
      const subject = map.subject >= 0 ? String(row[map.subject] ?? '').trim() : '';
      const no = map.no >= 0 ? String(row[map.no] ?? '').trim() : '';
      const marks = {};
      columns.filter((c) => c.seg === si).forEach((c) => {
        marks[c.key] = isMarked(row[c.col]);
      });
      const leave = map.leave >= 0 ? String(row[map.leave] ?? '').trim() : '';
      const remark = map.remark >= 0 ? String(row[map.remark] ?? '').trim() : '';
      people.push({ no, name, subject, marks, leave, remark, seg: si, _row: r });
      got += 1;
    });
    // 连续 12 行都读不到人，认为表已结束（避免把页脚说明读进来）
    if (!got) {
      let rest = 0;
      for (let k = r + 1; k < Math.min(r + 13, rows.length); k++) {
        if (segCols.some((m) => String((rows[k] || [])[m.name] ?? '').trim())) { rest = 1; break; }
      }
      if (!rest) break;
    }
  }

  /* 稳定排序：先左栏后右栏，同栏内按原行序 */
  people.sort((a, b) => (a.seg - b.seg) || (a._row - b._row));
  people.forEach((p) => { delete p._row; });

  if (!people.length) {
    /* 【提示不能指错方向】
       原来这里恒报「可能姓名是贴的图片」——可真实原因常常是姓名列填的是编号。
       把被挡掉的内容摊出来，老师一眼就知道该改哪儿。 */
    const hint = droppedNames.length
      ? `姓名那一列读到的是「${[...new Set(droppedNames)].slice(0, 6).join('、')}」，这些不像人名 —— 检查一下姓名列是不是填成了编号。`
      : '可能这张表还没填名字，或者姓名是贴的图片。';
    return { ok: false, reason: `找到列标题了，但下面没读到教师姓名 —— ${hint}`, meta, warnings, columns, dropped: droppedNames };
  }

  /* ---------- 5. 判断表类型 ---------- */
  const labels = columns.map((c) => c.label);
  const hasSeat = labels.some((l) => /坐班|上课|听课/.test(l));
  const hasResearch = labels.some((l) => /教研|签到/.test(l));
  let type = opts.typeHint || (hasResearch && !hasSeat ? 'research' : 'seat');
  if (hasSeat && hasResearch) type = 'seat';   // 两者都有，坐班表优先（教研表不会有"上课"列）

  /* 【教研表只留一组签到列】
     教研签到表是一块一块按学科排的，但每块结构一样（序号 姓名 学科 签到 备注）。
     按「双栏」切开后，左右两栏的签到列数据其实是同一件事，
     界面上并排两个「签到」只会让人犹豫点哪个。这里统一收成一列，
     数据仍然各自存在 p.marks 里，靠「哪一栏有人」就能对上号。 */
  let useColumns = columns;
  if (type === 'research') {
    const hasSign = labels.some((l) => /签到/.test(l));
    const firstSeg = columns.find((c) => c.type === 'check')?.seg ?? 0;
    const keep = columns.filter((c) => c.type !== 'check' || c.seg === firstSeg);
    useColumns = keep;
    if (!hasSign) useColumns.forEach((c) => { if (c.type === 'check') c.label = '签到'; });
    /* 把右栏的签到勾并入对应的左栏 key，这样 people[i].marks 一眼就对得上 */
    const remap = new Map();
    columns.forEach((c) => {
      if (c.seg === firstSeg) return;
      const twin = columns.find((x) => x.seg === firstSeg && x.rawLabel === c.rawLabel && x.type === 'check');
      if (twin) remap.set(c.key, twin.key);
    });
    people.forEach((p) => {
      for (const [from, to] of remap) {
        if (p.marks[from]) p.marks[to] = true;
        delete p.marks[from];
      }
    });
    /* 教研表顺带把顺序按学科整理好，跟纸表分块的读法一致 */
    const rank = (s) => {
      const order = ['语文', '数学', '英语', '物理', '化学', '生物', '政治', '历史', '地理', '体育', '音乐', '美术', '信息', '通用技术', '心理', '日语', '俄语', '道法'];
      const i = order.indexOf(s); return i < 0 ? 99 : i;
    };
    people.sort((a, b) => (rank(a.subject) - rank(b.subject)) || (a.seg - b.seg) || 0);
  }

  const markedCount = people.reduce((a, p) => a + Object.values(p.marks).filter(Boolean).length, 0);
  if (!markedCount) warnings.push('这张表看起来还没打勾（所有勾选列都是空的），已按空白表导入，你可以打开逐人打勾。');
  if (type === 'research' && !(meta.year && meta.month && meta.day)) warnings.push('教研签到表上没有日期，导入后请在上面把日期填上。');
  /* 有人名没认出来 → 明确说出来，别让老师靠数人数发现 */
  if (droppedNames.length) {
    const uniq = [...new Set(droppedNames)];
    warnings.push(`有 ${droppedNames.length} 个名字没认出来，已跳过：${uniq.slice(0, 5).join('、')}${uniq.length > 5 ? ` 等 ${uniq.length} 个` : ''}。如果确实是老师姓名，请在上面的表格里补一行。`);
  }
  /* 日期没解析出来 → 也说出来，否则会静默回落成"今天"，老师以为没问题 */
  if (!(meta.year && meta.month && meta.day)) {
    warnings.push('表头上没找到日期，导入后会先记成今天，请确认一下。');
  }

  const date = (meta.year && meta.month && meta.day)
    ? `${meta.year}-${String(meta.month).padStart(2, '0')}-${String(meta.day).padStart(2, '0')}`
    : null;

  return {
    ok: true,
    grade,
    date,
    period: meta.period,
    weekday: meta.weekday,
    type,
    columns: useColumns,
    people,
    warnings,
    meta,
  };
}
