export const DEFAULT_ROSTER_EXPECTED_COUNT = 46;
export const DEFAULT_LEFT_GROUP_COUNT = 23;

export const ROSTER_SUBJECTS = [
  "信息技术", "通用技术", "劳动技术", "心理健康", "综合实践",
  "语文", "数学", "英语", "物理", "化学", "生物",
  "政治", "历史", "地理", "体育", "音乐", "美术", "科学"
];

const STOP_WORDS = new Set([
  "姓名", "名字", "学科", "序号", "编号", "教师", "老师",
  "教师名单", "教师名册", "花名册", "合计", "小计", "总计",
  "备注", "说明", "年级", "班级", "星期", "日期", "签到",
  "上课", "坐班", "听课", "教研", "请假", "高一", "高二", "高三"
]);

const CHINESE_DIGITS = {
  "零": 0, "〇": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4,
  "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10
};

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function pointXY(point) {
  if (Array.isArray(point)) return [Number(point[0]), Number(point[1])];
  if (point && typeof point === "object") return [Number(point.x), Number(point.y)];
  return [NaN, NaN];
}

function itemBounds(item) {
  const points = Array.isArray(item?.poly) ? item.poly.map(pointXY) : [];
  const valid = points.filter((point) => Number.isFinite(point[0]) && Number.isFinite(point[1]));
  if (valid.length < 2) return null;
  const xs = valid.map((point) => point[0]);
  const ys = valid.map((point) => point[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return {
    minX, maxX, minY, maxY,
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2,
    width: maxX - minX,
    height: maxY - minY
  };
}

function normalizeDigits(value) {
  return String(value || "")
    .replace(/[０-９]/g, (char) => String(char.charCodeAt(0) - 0xff10))
    .replace(/[OoＯｏ]/g, "0")
    .replace(/[Il|丨]/g, "1");
}

function chineseNumber(value) {
  const text = String(value || "");
  if (!text || !/^[零〇一二两三四五六七八九十]+$/.test(text)) return null;
  if (text === "十") return 10;
  if (text.startsWith("十")) return 10 + (CHINESE_DIGITS[text.slice(1)] || 0);
  if (text.endsWith("十")) return (CHINESE_DIGITS[text[0]] || 1) * 10;
  const tenAt = text.indexOf("十");
  if (tenAt > 0) {
    return (CHINESE_DIGITS[text.slice(0, tenAt)] || 1) * 10
      + (CHINESE_DIGITS[text.slice(tenAt + 1)] || 0);
  }
  return CHINESE_DIGITS[text] ?? null;
}

export function parseRosterSerial(value, expectedCount = DEFAULT_ROSTER_EXPECTED_COUNT) {
  const text = normalizeDigits(value).trim();
  const matches = text.match(/\d{1,2}/g) || [];
  for (const token of matches) {
    const number = Number(token);
    if (Number.isInteger(number) && number >= 1 && number <= expectedCount) return number;
  }
  const chinese = chineseNumber(text);
  return chinese !== null && chinese >= 1 && chinese <= expectedCount ? chinese : null;
}

export function findRosterSubject(value) {
  const text = String(value || "").replace(/\s+/g, "");
  return [...ROSTER_SUBJECTS].sort((a, b) => b.length - a.length)
    .find((subject) => text.includes(subject)) || "";
}

function cleanCandidateName(value, subject = "") {
  let text = String(value || "");
  if (subject) text = text.replaceAll(subject, "");
  text = normalizeDigits(text).replace(/\d+/g, "");
  for (const word of STOP_WORDS) text = text.replaceAll(word, "");
  const name = text.replace(/[^\u3400-\u9fff]/g, "");
  if (name.length >= 2 && name.length <= 4 && !STOP_WORDS.has(name)) return name;
  if (name.length > 4) {
    for (let length = 4; length >= 2; length -= 1) {
      for (let start = 0; start + length <= name.length; start += 1) {
        const candidate = name.slice(start, start + length);
        if (!STOP_WORDS.has(candidate)) return candidate;
      }
    }
  }
  return "";
}

function averageConfidence(items) {
  const scores = items.map((item) => Number(item.score)).filter(Number.isFinite);
  if (!scores.length) return 0;
  const normalized = scores.map((score) => score > 1 ? score / 100 : score);
  return Math.max(0, Math.min(1, normalized.reduce((sum, score) => sum + score, 0) / normalized.length));
}

function clusterRows(items, imageHeight) {
  if (!items.length) return [];
  const tolerance = Math.max(7, median(items.map((item) => item.bounds.height).filter((height) => height > 0)) * 0.72, imageHeight * 0.0035);
  const clusters = [];
  for (const item of [...items].sort((a, b) => a.bounds.centerY - b.bounds.centerY)) {
    let target = clusters[clusters.length - 1];
    if (!target || Math.abs(item.bounds.centerY - target.centerY) > tolerance) {
      target = { centerY: item.bounds.centerY, items: [] };
      clusters.push(target);
    }
    target.items.push(item);
    target.centerY = target.items.reduce((sum, entry) => sum + entry.bounds.centerY, 0) / target.items.length;
  }
  return clusters;
}

function parseRowItems(items, side, rowIndex, options) {
  const sorted = [...items].sort((a, b) => a.bounds.centerX - b.bounds.centerX);
  const subjectItem = sorted.find((item) => findRosterSubject(item.text)) || null;
  const subject = subjectItem ? findRosterSubject(subjectItem.text) : findRosterSubject(sorted.map((item) => item.text).join(""));
  const serialItem = sorted.find((item) => parseRosterSerial(item.text, options.expectedCount) !== null) || null;
  const detectedSerial = serialItem ? parseRosterSerial(serialItem.text, options.expectedCount) : null;

  let nameItems = sorted;
  if (serialItem && subjectItem && serialItem !== subjectItem) {
    const between = sorted.filter((item) =>
      item.bounds.centerX > serialItem.bounds.centerX
      && item.bounds.centerX < subjectItem.bounds.centerX
    );
    if (between.length) nameItems = between;
  } else if (subjectItem) {
    const beforeSubject = sorted.filter((item) => item.bounds.centerX < subjectItem.bounds.centerX);
    if (beforeSubject.length) nameItems = beforeSubject;
  }

  let name = cleanCandidateName(nameItems.map((item) => item.text).join(""), subject);
  if (!name) name = cleanCandidateName(sorted.map((item) => item.text).join(""), subject);
  if (!detectedSerial && !name && !subject) return null;

  const serialSource = detectedSerial === null ? "position" : "ocr";
  const serial = detectedSerial === null
    ? (side === "left" ? rowIndex + 1 : options.leftGroupCount + rowIndex + 1)
    : detectedSerial;

  return {
    serial,
    name,
    subject,
    side,
    serialSource,
    confidence: averageConfidence(sorted),
    needsReview: serialSource !== "ocr" || !name || !subject || averageConfidence(sorted) < 0.65
  };
}

function parseWideLine(item, options) {
  const text = normalizeDigits(item.text).replace(/\s+/g, "");
  const matches = [...text.matchAll(/\d{1,2}/g)]
    .map((match) => ({ index: match.index, value: Number(match[0]) }))
    .filter((match) => match.value >= 1 && match.value <= options.expectedCount);
  const rows = [];
  for (let i = 0; i < matches.length; i += 1) {
    const current = matches[i];
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
    const segment = text.slice(current.index, end);
    const subject = findRosterSubject(segment);
    const name = cleanCandidateName(segment, subject);
    if (!name && !subject) continue;
    rows.push({
      serial: current.value,
      name,
      subject,
      side: current.value <= options.leftGroupCount ? "left" : "right",
      serialSource: "ocr",
      confidence: averageConfidence([item]),
      needsReview: !name || !subject || averageConfidence([item]) < 0.65
    });
  }
  return rows;
}

export function extractRosterRowsFromPaddle(items, imageWidth, imageHeight, config = {}) {
  const expectedCount = Math.max(1, Number(config.expectedCount) || DEFAULT_ROSTER_EXPECTED_COUNT);
  const leftGroupCount = Math.max(1, Math.min(expectedCount, Number(config.leftGroupCount) || Math.ceil(expectedCount / 2)));
  const options = { expectedCount, leftGroupCount };
  const normalized = (Array.isArray(items) ? items : []).map((item) => {
    const bounds = itemBounds(item);
    return {
      text: String(item?.text || "").trim(),
      score: Number(item?.score) || 0,
      poly: item?.poly,
      bounds
    };
  }).filter((item) => item.text && item.bounds);

  if (!normalized.length || !(imageWidth > 0) || !(imageHeight > 0)) return [];

  const wideItems = [];
  const sideItems = { left: [], right: [] };
  for (const item of normalized) {
    if (item.bounds.width >= imageWidth * 0.58) {
      wideItems.push(item);
    } else {
      sideItems[item.bounds.centerX < imageWidth / 2 ? "left" : "right"].push(item);
    }
  }

  const rows = wideItems.flatMap((item) => parseWideLine(item, options));
  for (const side of ["left", "right"]) {
    const clusters = clusterRows(sideItems[side], imageHeight);
    let dataRowIndex = 0;
    for (const cluster of clusters) {
      const row = parseRowItems(cluster.items, side, dataRowIndex, options);
      if (!row) continue;
      rows.push(row);
      dataRowIndex += 1;
    }
  }

  const unique = new Map();
  for (const row of rows) {
    const key = [row.serial, row.name, row.subject].join("|");
    const previous = unique.get(key);
    if (!previous || row.confidence > previous.confidence) unique.set(key, row);
  }
  return [...unique.values()].sort((a, b) =>
    Number(a.serial) - Number(b.serial) || (a.side === "left" ? -1 : 1)
  );
}


/* 将 Tesseract.js 的 words/bbox 统一转换为表格几何识别器所需的文本框。
   这样实际浏览器 OCR 与结构识别测试走同一条解析路径。 */
export function extractRosterRowsFromTesseract(words, imageWidth, imageHeight, config = {}) {
  const items = (Array.isArray(words) ? words : []).map((word) => {
    const box = word?.bbox || {};
    const x0 = Number(box.x0);
    const y0 = Number(box.y0);
    const x1 = Number(box.x1);
    const y1 = Number(box.y1);
    if (![x0, y0, x1, y1].every(Number.isFinite) || x1 <= x0 || y1 <= y0) return null;
    return {
      text: String(word?.text || "").trim(),
      score: Number(word?.confidence) || 0,
      poly: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
    };
  }).filter((item) => item && item.text);
  return extractRosterRowsFromPaddle(items, imageWidth, imageHeight, config);
}

export function validateRosterRows(rows, config = {}) {
  const expectedCount = Math.max(1, Number(config.expectedCount) || DEFAULT_ROSTER_EXPECTED_COUNT);
  const list = Array.isArray(rows) ? rows : [];
  const serialCounts = new Map();
  for (const row of list) {
    const serial = Number(row?.serial);
    if (Number.isInteger(serial) && serial >= 1) serialCounts.set(serial, (serialCounts.get(serial) || 0) + 1);
  }
  const duplicateSerials = [...serialCounts.entries()]
    .filter((entry) => entry[1] > 1).map((entry) => entry[0]).sort((a, b) => a - b);
  const present = new Set(serialCounts.keys());
  const missingSerials = Array.from({ length: expectedCount }, (_, index) => index + 1)
    .filter((serial) => !present.has(serial));
  const outOfRangeSerials = [...present].filter((serial) => serial > expectedCount).sort((a, b) => a - b);
  const incompleteSerials = list.filter((row) =>
    !String(row?.name || "").trim() || !String(row?.subject || "").trim()
  ).map((row) => Number(row?.serial)).filter(Number.isFinite);
  const inferredSerials = list.filter((row) => row?.serialSource === "position")
    .map((row) => Number(row.serial)).filter(Number.isFinite);
  const completeCount = list.filter((row) =>
    /^[\u3400-\u9fff]{2,4}$/.test(String(row?.name || "").trim())
    && String(row?.subject || "").trim()
  ).length;
  const valid = completeCount === expectedCount
    && list.length === expectedCount
    && missingSerials.length === 0
    && duplicateSerials.length === 0
    && incompleteSerials.length === 0
    && inferredSerials.length === 0
    && outOfRangeSerials.length === 0;
  return {
    expectedCount,
    totalRows: list.length,
    completeCount,
    missingSerials,
    duplicateSerials,
    incompleteSerials,
    inferredSerials,
    outOfRangeSerials,
    valid
  };
}

export function buildRosterReviewRows(rows, expectedCount = DEFAULT_ROSTER_EXPECTED_COUNT, leftGroupCount = Math.ceil(expectedCount / 2)) {
  const sourceRows = Array.isArray(rows) ? rows.map((row) => ({ ...row })) : [];
  const bySerial = new Map();
  const extras = [];
  for (const row of sourceRows) {
    const serial = Number(row.serial);
    if (Number.isInteger(serial) && serial >= 1 && serial <= expectedCount) {
      if (!bySerial.has(serial)) bySerial.set(serial, []);
      bySerial.get(serial).push(row);
    } else {
      extras.push(row);
    }
  }

  const output = [];
  for (let serial = 1; serial <= expectedCount; serial += 1) {
    const matches = bySerial.get(serial);
    if (matches?.length) {
      output.push(...matches);
    } else {
      output.push({
        serial,
        name: "",
        subject: "",
        side: serial <= leftGroupCount ? "left" : "right",
        serialSource: "template",
        confidence: 0,
        needsReview: true
      });
    }
  }
  return [...output, ...extras].sort((a, b) =>
    Number(a.serial || 9999) - Number(b.serial || 9999)
  );
}

export function scoreRosterExtraction(rows, expectedCount = DEFAULT_ROSTER_EXPECTED_COUNT) {
  const validation = validateRosterRows(rows, { expectedCount });
  const detectedSerials = (rows || []).filter((row) => row.serialSource === "ocr").length;
  return validation.completeCount * 1000
    + detectedSerials * 2
    - validation.inferredSerials.length * 5
    - validation.missingSerials.length * 2
    - validation.duplicateSerials.length * 100;
}
