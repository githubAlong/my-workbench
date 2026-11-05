import test from "node:test";
import assert from "node:assert/strict";
import {
  extractRosterRowsFromPaddle,
  extractRosterRowsFromTesseract,
  buildRosterReviewRows,
  validateRosterRows,
  parseRosterSerial
} from "../js/roster-structure.mjs";

const names = [
  "张伟", "王芳", "李娜", "刘洋", "陈静", "杨洋", "赵敏", "黄磊",
  "周杰", "吴婷", "徐磊", "孙丽", "胡军", "朱琳", "高峰", "林涛",
  "何静", "郭强", "马丽", "罗敏", "梁宇", "宋佳", "郑凯", "谢宁",
  "韩雪", "唐伟", "冯静", "于洋", "董洁", "萧然", "程远", "曹颖",
  "袁野", "邓超", "彭飞", "曾琳", "叶青", "苏明", "吕佳", "蒋欣",
  "魏然", "田野", "潘婷", "石磊", "姚远", "杜鹃"
];
const subjects = ["语文", "数学", "英语", "物理", "化学", "生物", "历史", "地理"];

function box(text, x, y, score = 0.98, width = 22) {
  return {
    text,
    score,
    poly: [
      [x - width / 2, y - 8],
      [x + width / 2, y - 8],
      [x + width / 2, y + 8],
      [x - width / 2, y + 8]
    ]
  };
}

function fixture46() {
  const items = [];
  for (let index = 0; index < 23; index += 1) {
    const y = 100 + index * 38;
    items.push(box(String(index + 1), 70, y));
    items.push(box(names[index], 165, y));
    items.push(box(subjects[index % subjects.length], 275, y));
    items.push(box(String(index + 24), 570, y));
    items.push(box(names[index + 23], 665, y));
    items.push(box(subjects[(index + 23) % subjects.length], 775, y));
  }
  items.push(box("序号", 70, 45));
  items.push(box("姓名", 165, 45));
  items.push(box("学科", 275, 45));
  return items;
}

test("能按左右两组的空间位置识别并排序46条记录", () => {
  const rows = extractRosterRowsFromPaddle(fixture46(), 1000, 1100, {
    expectedCount: 46,
    leftGroupCount: 23
  });
  assert.equal(rows.length, 46);
  assert.deepEqual(rows.map((row) => row.serial), Array.from({ length: 46 }, (_, index) => index + 1));
  assert.equal(rows[0].name, names[0]);
  assert.equal(rows[22].name, names[22]);
  assert.equal(rows[23].name, names[23]);
  assert.equal(rows[45].name, names[45]);
  assert.equal(validateRosterRows(rows, { expectedCount: 46 }).valid, true);
});

test("漏掉整行时只显示空白待补项，不伪造姓名或学科", () => {
  const missingY = 100 + 11 * 38;
  const items = fixture46().filter((item) => {
    const bounds = item.poly;
    const centerY = (bounds[0][1] + bounds[2][1]) / 2;
    return Math.abs(centerY - missingY) > 1;
  });
  const rows = extractRosterRowsFromPaddle(items, 1000, 1100, {
    expectedCount: 46,
    leftGroupCount: 23
  });
  const review = buildRosterReviewRows(rows, 46, 23);
  const missing = review.find((row) => row.serial === 12);
  assert.equal(review.length, 46);
  assert.equal(missing.name, "");
  assert.equal(missing.subject, "");
  assert.equal(missing.serialSource, "template");
  assert.equal(validateRosterRows(review, { expectedCount: 46 }).valid, false);
});

test("序号识别失败时标记为位置推定，不能直接通过验收", () => {
  const items = fixture46().map((item) => {
    if (item.text === "12") return { ...item, text: "?" };
    return item;
  });
  const rows = extractRosterRowsFromPaddle(items, 1000, 1100, {
    expectedCount: 46,
    leftGroupCount: 23
  });
  const row = rows.find((entry) => entry.serial === 12);
  assert.ok(row);
  assert.equal(row.serialSource, "position");
  assert.equal(validateRosterRows(buildRosterReviewRows(rows, 46, 23), { expectedCount: 46 }).valid, false);
});

test("重复序号与越界序号会被校验拦截", () => {
  const rows = [
    { serial: 1, name: "张伟", subject: "语文", serialSource: "ocr" },
    { serial: 1, name: "王芳", subject: "数学", serialSource: "ocr" },
    { serial: 47, name: "李娜", subject: "英语", serialSource: "ocr" }
  ];
  const result = validateRosterRows(rows, { expectedCount: 46 });
  assert.deepEqual(result.duplicateSerials, [1]);
  assert.deepEqual(result.outOfRangeSerials, [47]);
  assert.equal(result.valid, false);
});


test("实际 Tesseract words/bbox 输入也能按左右两组识别46条记录", () => {
  const words = fixture46().map((item) => ({
    text: item.text,
    confidence: item.score * 100,
    bbox: {
      x0: item.poly[0][0],
      y0: item.poly[0][1],
      x1: item.poly[2][0],
      y1: item.poly[2][1]
    }
  }));
  const rows = extractRosterRowsFromTesseract(words, 1000, 1100, {
    expectedCount: 46,
    leftGroupCount: 23
  });
  assert.equal(rows.length, 46);
  assert.deepEqual(rows.map((row) => row.serial), Array.from({ length: 46 }, (_, index) => index + 1));
  assert.equal(rows[0].name, names[0]);
  assert.equal(rows[45].name, names[45]);
  assert.equal(validateRosterRows(rows, { expectedCount: 46 }).valid, true);
});

test("支持全角数字和常见中文序号", () => {
  assert.equal(parseRosterSerial("２３", 46), 23);
  assert.equal(parseRosterSerial("二十三", 46), 23);
  assert.equal(parseRosterSerial("四十六", 46), 46);
});

test("整行 OCR 文本包含左右两组时可按序号拆分", () => {
  const wide = [{
    text: "1张伟语文24王芳数学",
    score: 0.96,
    poly: [[10, 40], [990, 40], [990, 60], [10, 60]]
  }];
  const rows = extractRosterRowsFromPaddle(wide, 1000, 1100, {
    expectedCount: 46,
    leftGroupCount: 23
  });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => [row.serial, row.name, row.subject]), [
    [1, "张伟", "语文"],
    [24, "王芳", "数学"]
  ]);
});
