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
