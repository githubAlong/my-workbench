import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('页面标题统一使用「备课」，不再出现「电子备课」', async () => {
  const [work, prep, ui] = await Promise.all([
    readFile(new URL('../js/work.js', import.meta.url), 'utf8'),
    readFile(new URL('../js/prep.js', import.meta.url), 'utf8'),
    readFile(new URL('../js/ui.js', import.meta.url), 'utf8'),
  ]);
  /* 用户 11-13 裁决：模块名从「备课记录」改回「备课」 */
  assert.match(work, /prep:\s*\['备课',/);
  assert.match(prep, /lp-list-caption">备课<\/div>/);
  assert.match(ui, /label: '备课'/);
  assert.doesNotMatch(work + prep + ui, /电子备课/);
  assert.doesNotMatch(work + prep + ui, /备课记录/);
});

test('筛选标签与下拉框在同一行显示并适配窄屏', async () => {
  const css = await readFile(new URL('../css/app.css', import.meta.url), 'utf8');
  assert.match(css, /\.lesson-plan-list \.lp-filter-row\s*\{[^}]*flex-flow:\s*row nowrap/s);
  assert.match(css, /\.lesson-plan-list \.lp-filter-row > label\s*\{[^}]*white-space:\s*nowrap/s);
  assert.match(css, /\.lesson-plan-list \.lp-type-filter\s*\{[^}]*flex:/s);
  assert.match(css, /@media\s*\(max-width:\s*520px\)/);
});

test('列表表头与详情字段同序，详情底部只有关闭/保存', async () => {
  const prep = await readFile(new URL('../js/prep.js', import.meta.url), 'utf8');
  assert.match(prep, /<th>备课时间<\/th><th>学科<\/th><th>年级<\/th><th>标题<\/th><th>授课内容<\/th><th>备注<\/th><th>操作<\/th>/);
  const order = ['lp-planDate', 'lp-subject', 'lp-grade', 'lp-title', 'lp-process', 'lp-remark'];
  const positions = order.map((id) => prep.indexOf('for="' + id + '"'));
  assert.ok(positions.every((position) => position > -1), '详情字段齐全');
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b), '详情字段顺序正确');
  assert.match(prep, /id="lp-close"[^>]*>关闭</);
  assert.match(prep, /id="lp-save"[^>]*>保存</);
  assert.doesNotMatch(prep, /导出PDF|导出图片|图片识别\(OCR\)|lp-prep-type/);
});

test('批量导入导出放在列表标题上方，并按筛选条件作用', async () => {
  const prep = await readFile(new URL('../js/prep.js', import.meta.url), 'utf8');
  const bulkBar = prep.indexOf('lp-bulk-bar');
  const caption = prep.indexOf('lp-list-caption');
  assert.ok(bulkBar > -1 && caption > bulkBar, '批量工具条在「备课」标题上方');
  for (const marker of ['buildPrepCsv', 'parsePrepCsv', 'applyFilterDefaults', 'filterPrepRows']) {
    assert.match(prep, new RegExp(marker));
  }
  assert.match(prep, /id="prep-import"/);
  assert.match(prep, /id="prep-export"/);
  assert.match(prep, /truncateTwoLines/);
});

test('两行截断样式与备注单行省略', async () => {
  const css = await readFile(new URL('../css/app.css', import.meta.url), 'utf8');
  assert.match(css, /\.lp-clip-2\s*\{/);
  assert.match(css, /\.lp-clip-1\s*\{[^}]*text-overflow:\s*ellipsis/s);
});
