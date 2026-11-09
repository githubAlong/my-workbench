import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('电子备课页面标题统一使用“电子备课”', async () => {
  const [work, prep] = await Promise.all([
    readFile(new URL('../js/work.js', import.meta.url), 'utf8'),
    readFile(new URL('../js/prep.js', import.meta.url), 'utf8'),
  ]);
  assert.match(work, /prep:\s*\['电子备课',/);
  assert.match(prep, /lp-list-caption">电子备课<\/div>/);
  assert.doesNotMatch(work, /prep:\s*\['电子备课记录台账'/);
  assert.doesNotMatch(prep, /lp-list-caption">电子备课记录台账/);
});

test('备课类型标签与下拉框在同一行显示并适配窄屏', async () => {
  const css = await readFile(new URL('../css/app.css', import.meta.url), 'utf8');
  assert.match(css, /\.lesson-plan-list \.lp-filter-row\s*\{[^}]*flex-flow:\s*row nowrap/s);
  assert.match(css, /\.lesson-plan-list \.lp-filter-row > label\s*\{[^}]*white-space:\s*nowrap/s);
  assert.match(css, /\.lesson-plan-list \.lp-type-filter\s*\{[^}]*flex:/s);
  assert.match(css, /@media\s*\(max-width:\s*520px\)/);
});
