import test from "node:test";
import assert from "node:assert/strict";
import { mapTimetablePeriodNumbers } from "../js/ttimage.js";

test("merged lunch row does not consume a lesson number", () => {
  const merged = Array(16).fill(false);
  merged[7] = true;
  const byRow = mapTimetablePeriodNumbers(2, 16, merged);
  assert.equal(byRow[2], 1);
  assert.equal(byRow[6], 5);
  assert.equal(byRow[7], 0);
  assert.equal(byRow[8], 6);
  assert.equal(byRow[10], 8);
  assert.equal(byRow[11], 9);
});

test("merged title/header rows before body do not change body numbering", () => {
  const merged = Array(16).fill(false);
  merged[0] = true;
  merged[7] = true;
  const byRow = mapTimetablePeriodNumbers(2, 16, merged);
  assert.equal(byRow[2], 1);
  assert.equal(byRow[8], 6);
  assert.equal(byRow[11], 9);
  assert.equal(byRow[15], 13);
});

test("manual remapping can use the same row map as automatic detection", () => {
  const merged = Array(16).fill(false);
  merged[7] = true;
  const byRow = mapTimetablePeriodNumbers(2, 16, merged);
  const detectedRows = [2, 8, 11, 15];
  assert.deepEqual(detectedRows.map((row) => byRow[row]), [1, 6, 9, 13]);
});

test("weekday columns use Sunday zero, matching stored course weekdays", () => {
  const dayOrder = [1, 2, 3, 4, 5, 6, 0];
  assert.deepEqual(dayOrder, [1, 2, 3, 4, 5, 6, 0]);
});

test("the autumn reference grid keeps all nine daytime periods and four evening periods", () => {
  const merged = Array(16).fill(false);
  merged[7] = true; // lunch is a merged row, not a lesson
  const byRow = mapTimetablePeriodNumbers(2, 16, merged);
  assert.deepEqual([byRow[2], byRow[6], byRow[8], byRow[10], byRow[11], byRow[12], byRow[13], byRow[14], byRow[15]],
    [1, 5, 6, 8, 9, 10, 11, 12, 13]);
});
