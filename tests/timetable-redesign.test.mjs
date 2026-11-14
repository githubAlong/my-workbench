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

test("timetable keeps the countdown reminder and grid but drops the season/grade query bar", () => {
  for (const token of ["tt-reminder", "tt-grid-table", "周一", "周日", "tt-grid-title-text", "tt-title-edit", "openTitleEditor"]) {
    assert.ok(source.includes(token), "missing " + token);
  }
  for (const token of ["tt-query-bar", "tt-current-tag", "tt-confirm", "tt-season-switch", "data-schedule-type", 'id="tt-type"', 'id="tt-grade"', "typeSelect", "gradeSelect"]) {
    assert.ok(!source.includes(token), "query bar should be gone: " + token);
  }
  /* 用户上传什么就显示什么，不再按课表类型 / 年级过滤 */
  assert.match(source, /function getVisibleCourses\(\) \{\s*return allCourses;\s*\}/);
});

test("timetable title is always shown, editable and uses the approved larger font", () => {
  assert.match(source, /DEFAULT_TITLE = '2026年秋季信息课表'/);
  assert.match(source, /saveTimetablePrefs\(\{ title: next \}\)/);
  assert.match(source, /<strong id="tt-grid-title-text">/);
  assert.doesNotMatch(source, /appliedType === TYPE_WINTER && appliedGrade === '高二'/);
  assert.match(css, /\.tt-workspace \.tt-grid-title\{font-size:30px/);
});

test("grade colors keep the original four hues with stronger contrast", () => {
  assert.match(css, /\.tt-course-block\.tt-grade-1\{[^}]*#1d4ed8/);
  assert.match(css, /\.tt-course-block\.tt-grade-2\{[^}]*#6d28d9/);
  assert.match(css, /\.tt-course-block\.tt-grade-3\{[^}]*#b91c1c/);
  assert.match(css, /\.tt-course-block\.tt-grade-all\{[^}]*#047857/);
});

test("timetable normalizes imported period identifiers before rendering", () => {
  assert.match(source, /normalizeTimetablePeriods/);
  assert.match(source, /getCanonicalPeriodNumber\(course\)/);
  assert.match(source, /WINTER_PERIOD_TIMES/);
});

test("timetable rows retain lunch and all configured or course-referenced evening periods", () => {
  assert.match(source, /function periodOrder\(period\)/);
  assert.match(source, /for \(const number of \[0, 1, 2, 3, 4, 5, 5\.5, 6, 7, 8, 9, 10\]\)/);
  assert.match(source, /const orderDiff = periodOrder\(a\) - periodOrder\(b\)/);
  assert.match(source, /completeTimetablePeriods\(\[\.\.\.byNo\.values\(\)\], visibleCourses/);
  assert.match(source, /completeTimetablePeriods\(configuredRows, visibleCourses/);
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

test("loading and error states remain while the empty schedule panel is removed", () => {
  assert.match(source, /正在加载课表/);
  assert.match(source, /课表加载失败/);
  assert.doesNotMatch(source, /tt-empty-state|当前课表还没有课程|id="tt-empty-add"/);
  assert.match(source, /gridHtml\(visible, periods\)/);
});

test("high-two 2026 autumn timetable keeps source row numbers, lunch span and title", () => {
  for (const marker of [
    "2026年秋季信息课表",
    "period_no: 1, class_name: \"11班\"",
    "period_no: 3, class_name: \"5班\"",
    "period_no: 5, class_name: \"7班\"",
    "period_no: 6, class_name: \"9班\"",
    "period_no: 7, class_name: \"16班\"",
    "period_no: 9, class_name: \"15班\"",
    "period_no: 9, class_name: \"18班\"",
    '13:["21:10","21:55"]',
  ]) assert.ok(source.includes(marker), "missing exact source schedule marker: " + marker);
  assert.match(source, /Object\.entries\(times\)\.map/);
  assert.match(source, /period_no:Number\(no\)/);
  assert.match(source, /await api\.patch\("\/courses\/" \+ target\.id, data\)/);
  // 午休行跨列数随「显示星期」变化：1 个节次格 + (可见天数 + 1)，不再写死 8
  assert.match(source, /colspan="' \+ \(shownDays\.length \+ 1\) \+ '"/);
});

test("作息设置支持勾选周一到周日的显示与隐藏", () => {
  assert.match(source, /function normalizeShownDays/);
  assert.match(source, /shownDays = normalizeShownDays\(timetable\.visibleDays\)/);
  assert.match(source, /class="tt-day-toggle"/);
  assert.match(source, /visibleDays: pickedDays/);
  assert.match(source, /至少要保留一天显示/);
});


test("the one-click high-two import button is removed while standard import remains", () => {
  assert.doesNotMatch(source, /id="tt-import-high2"/);
  assert.doesNotMatch(source, /querySelector\('#tt-import-high2'\)/);
  assert.match(source, /id="tt-import"/);
  assert.match(source, /querySelector\('#tt-import'\)/);
});


test("timetable accent colors follow the global appearance theme", () => {
  const marker = "/* ===== 课表主题外观联动：强调色统一读取全局主题变量 ===== */";
  const themeStyles = css.slice(css.lastIndexOf(marker));
  assert.ok(themeStyles.length > marker.length, "missing global theme binding overrides");
  for (const token of ["--primary", "--primary-weak", "--primary-deep", "--card", "--line", "--bg-sunken"]) {
    assert.ok(themeStyles.includes("var(" + token + ")"), "theme override must use " + token);
  }
  for (const selector of [
    ".tt-reminder", ".tt-grid-table thead th.is-today", ".tt-course-block.tt-grade-1",
    ".tt-grade-tag.tt-grade-1", ".tt-current-tag b"
  ]) assert.ok(themeStyles.includes(selector), "missing themed component: " + selector);
  assert.ok(themeStyles.includes("background:linear-gradient(112deg,var(--primary),var(--primary-deep))"));
  assert.ok(themeStyles.includes("background:linear-gradient(135deg,var(--primary),var(--primary-deep))"));
  assert.ok(themeStyles.includes("background:var(--primary-weak)"));
  assert.ok(themeStyles.includes("color:var(--primary-deep)"));
});
test("desktop timetable row density adapts to browser viewport height", () => {
  assert.match(source, /setProperty\('--tt-period-count'/);
  assert.match(css, /--tt-row-height/);
  assert.match(css, /100dvh/);
  assert.match(css, /max-height:760px/);
});

