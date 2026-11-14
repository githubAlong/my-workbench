import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('页面标题统一使用「备课管理」，不再出现「电子备课」', async () => {
  const [work, prep, ui] = await Promise.all([
    readFile(new URL('../js/work.js', import.meta.url), 'utf8'),
    readFile(new URL('../js/prep.js', import.meta.url), 'utf8'),
    readFile(new URL('../js/ui.js', import.meta.url), 'utf8'),
  ]);
  /* 用户 11-15 裁决：列表页按设计稿改为「备课管理」标题 */
  assert.match(work, /prep:\s*\['备课',/);
  assert.match(prep, /<h2>备课管理<\/h2>/);
  assert.match(prep, /记录每一次备课内容，支持筛选、批量导入导出、预览查看/);
  assert.match(ui, /label: '备课'/);
  assert.doesNotMatch(work + prep + ui, /电子备课/);
  assert.doesNotMatch(work + prep + ui, /备课记录/);
});

test('筛选条件在筛选卡片内一行显示并适配窄屏', async () => {
  const css = await readFile(new URL('../css/app.css', import.meta.url), 'utf8');
  assert.match(css, /\.prep-filter-row\s*\{[^}]*display:\s*flex/s);
  assert.match(css, /\.prep-filter-row label\s*\{[^}]*white-space:\s*nowrap/s);
  assert.match(css, /\.prep-filter-row select, \.prep-filter-row input\[type="date"\]\s*\{/);
  assert.match(css, /@media\s*\(max-width:\s*760px\)/);
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

test('操作列提供预览 / 编辑 / 删除三个按钮', async () => {
  const [prep, css] = await Promise.all([
    readFile(new URL('../js/prep.js', import.meta.url), 'utf8'),
    readFile(new URL('../css/app.css', import.meta.url), 'utf8'),
  ]);
  assert.match(prep, /data-preview="' \+ id \+ '">预览</);
  assert.match(prep, /data-edit="' \+ id \+ '">编辑</);
  assert.match(prep, /data-delete="' \+ id \+ '">删除</);
  assert.match(prep, /function openPreview\(/);
  assert.match(css, /\.prep-act-preview\s*\{/);
  assert.match(css, /\.prep-act-delete\s*\{/);
});

test('批量导入导出位于筛选卡片右上角，并按筛选条件作用', async () => {
  const prep = await readFile(new URL('../js/prep.js', import.meta.url), 'utf8');
  const tools = prep.indexOf('prep-filter-tools');
  const importBtn = prep.indexOf('id="prep-import"');
  const exportBtn = prep.indexOf('id="prep-export"');
  assert.ok(tools > -1 && importBtn > tools && exportBtn > importBtn, '批量按钮在筛选卡片工具区');
  assert.match(prep, /导出 CSV、Excel 可打开/);
  for (const marker of ['buildPrepCsv', 'parsePrepCsv', 'applyFilterDefaults', 'filterPrepRows']) {
    assert.match(prep, new RegExp(marker));
  }
  assert.match(prep, /truncateTwoLines/);
});

test('授课内容两行截断与备注单行省略', async () => {
  const css = await readFile(new URL('../css/app.css', import.meta.url), 'utf8');
  assert.match(css, /\.prep-process \.prep-clip\s*\{[^}]*-webkit-line-clamp:\s*2/s);
  assert.match(css, /\.prep-remark \.prep-clip\s*\{[^}]*text-overflow:\s*ellipsis/s);
});

test('搜索框位于页头右侧，提示文案与设计稿一致', async () => {
  const prep = await readFile(new URL('../js/prep.js', import.meta.url), 'utf8');
  assert.match(prep, /placeholder="搜索标题 \/ 授课内容 \/ 备注"/);
  assert.match(prep, /id="prep-search"/);
});
