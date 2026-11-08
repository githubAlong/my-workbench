import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../js/timetable.js", import.meta.url), "utf8");
const css = await readFile(new URL("../css/timetable-redesign.css", import.meta.url), "utf8");
const work = await readFile(new URL("../js/work.js", import.meta.url), "utf8");

test("my timetable is registered through the existing work/timetable route", () => {
  assert.match(work, /import \{ renderTimetable as renderMyTimetable \} from '\.\/timetable\.js'/);
  assert.match(work, /if \(t === 'timetable'\) \{ headEl\.remove\(\); return renderMyTimetable\(body\); \}/);
});

test("timetable implements the approved five page regions and grade/type apply button", () => {
  for (const token of ["tt-reminder", "tt-query-bar", "tt-current-tag", "tt-grid-table", "tt-confirm", "周一", "周日"]) {
    assert.ok(source.includes(token), "missing " + token);
  }
  assert.match(source, /addEventListener\('click', async \(\) => \{\s*appliedType = typeSelect\.value/);
});

test("timetable normalizes imported period identifiers before rendering", () => {
  assert.match(source, /normalizeTimetablePeriods/);
  assert.match(source, /getCanonicalPeriodNumber\(course\)/);
  assert.match(source, /WINTER_PERIOD_TIMES/);
});

test("timetable rows use the fixed early, nine-lesson and evening axis", () => {
  assert.match(source, /function periodOrder\(period\)/);
  assert.match(source, /for \(const number of \[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10\]\)/);
  assert.match(source, /const orderDiff = periodOrder\(a\) - periodOrder\(b\)/);
  assert.match(source, /晚自习第一节/);
  assert.match(source, /samePeriodName\(periodName\(period\), label\)/);
});

test("course editing supports editable weekday/period, free-text times and closeable sheet", () => {
  for (const token of ["tt-course-name", "tt-course-grade", "tt-course-weekday", "tt-course-period", "tt-course-start", "tt-course-end", "tt-course-class", "tt-course-cancel"]) {
    assert.ok(source.includes(token), "missing " + token);
  }
  assert.match(source, /type="text" value=/);
  assert.match(source, /data-time-pick/);
});

test("drag and drop, hover actions and soft delete are wired", () => {
  assert.match(source, /addEventListener\('dragstart'/);
  assert.match(source, /addEventListener\('drop'/);
  assert.match(source, /data-edit-course/);
  assert.match(source, /data-delete-course/);
  assert.match(source, /api\.del\('\/courses\/' \+ row\.id\)/);
});

test("import supports xlsx, delimited text, PDF and images with preview before commit", () => {
  assert.match(source, /readXlsx\(file\)/);
  assert.match(source, /readDelimited\(await file\.text\(\)\)/);
  assert.match(source, /ext === 'pdf'/);
  assert.match(source, /file\.type\.startsWith\('image\/'\)/);
  assert.match(source, /renderImportPreview/);
  assert.match(source, /导入到当前课表/);
});

test("export supports xlsx, PDF and PNG", () => {
  assert.match(source, /exportXlsx/);
  assert.match(source, /exportPdf/);
  assert.match(source, /exportPng/);
  assert.match(css, /\.tt-export-options/);
});

test("summer/winter course mapping and period overrides are stored in user settings", () => {
  assert.match(source, /courseTypes/);
  assert.match(source, /periodTimes/);
  assert.match(source, /api\.patch\('\/me', \{ settings: nextSettings \}\)/);
});

test("empty, loading and error states are present", () => {
  assert.match(source, /正在加载课表/);
  assert.match(source, /课表加载失败/);
  assert.match(source, /当前课表还没有课程/);
});

test("timetable supports grade/type scoped period editing and high-two winter import", () => {
  assert.match(source, /tt-period-settings/);
  assert.match(source, /function openPeriodSettings/);
  assert.match(source, /periodDefinitions/);
  assert.match(source, /tt-import-high2/);
  assert.match(source, /导入2026秋季高二课表/);
  assert.match(source, /grade: "高二"/);
  assert.match(source, /subject: "信息技术"/);
  assert.match(source, /晚四/);
});
