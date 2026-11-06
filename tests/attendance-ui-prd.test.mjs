import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('attendance tabs do not silently create drafts when opened', async () => {
  const source = await read('../js/attendance.js');
  assert.doesNotMatch(source, /if \(activeTab !== 'roster' && !matches\.length\)\s*\{\s*await createSlot/);
  assert.doesNotMatch(source, /if \(tab !== 'roster' && !listFor\(tab\)\.length\)\s*\{/);
  assert.match(source, /id="att-work-create"/);
});

test('attendance confirmation shows the required confirmation and result summary', async () => {
  const source = await read('../js/attendance.js');
  assert.match(source, /确认生成本次考勤？生成后将同步至移动端，并计入当前考勤记录。/);
  assert.match(source, /aw-result-card/);
  assert.match(source, /生成时间：/);
  assert.match(source, /操作人：/);
  assert.match(source, /未坐班人数/);
});

test('teacher add dialog supports selecting a grade and cross-grade class entry', async () => {
  const source = await read('../js/attendance.js');
  assert.match(source, /id="ra-grade"/);
  assert.match(source, /id="tt-cross"/);
  assert.match(source, /id="tt-from"/);
  assert.match(source, /新增上课老师/);
});

test('attendance presence tracks viewers and exposes presence state changes', async () => {
  const source = await read('../js/realtime.js');
  assert.match(source, /presence_state/);
  assert.match(source, /presence_diff/);
  assert.match(source, /event: 'presence'/);
  assert.match(source, /wb:attendance-presence/);
});

test('attendance PRD layout freezes roster columns and uses cards through tablet widths', async () => {
  const css = await read('../css/attendance-workspace.css');
  assert.match(css, /\.aw-roster-table th:nth-child\(3\).*left:200px/s);
  assert.match(css, /@media\(max-width:900px\)/);
  assert.match(css, /\.aw-result-card/);
});

test('concurrent edit conflicts offer an explicit refresh action', async () => {
  const source = await read('../js/attendance.js');
  assert.match(source, /该记录已被其他人更新，请刷新后查看最新数据。/);
  assert.match(source, /okText: '刷新数据'/);
});
