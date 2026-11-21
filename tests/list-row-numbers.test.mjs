import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

const prep = await read('../js/prep.js');
const work = await read('../js/work.js');
const trips = await read('../js/trips.js');
const study = await read('../js/study-records.js');
const selfstudy = await read('../js/selfstudy.js');
const appCss = await read('../css/app.css');
const tripsCss = await read('../css/trips-redesign.css');
const studyCss = await read('../css/study-records.css');
const { TRIP_COLUMNS } = await import('../js/trips-domain.mjs');
const { STUDY_COLUMNS, STUDY_CSV_HEADERS } = await import('../js/study-records-domain.mjs');
const { CSV_HEADERS } = await import('../js/prep-csv.mjs');

/* 序号只加在视图层：表头第一列是序号，行模板有对应单元格，
   空态 colspan 必须跟着表头列数走 —— 加列最容易漏的就是这一处。 */
const tables = [
  {
    name: '备课', source: prep, css: appCss, style: '.prep-table .prep-no',
    thead: '<thead><tr><th>序号</th><th>备课时间</th><th>学科</th><th>年级</th><th>标题</th><th>授课内容</th><th>备注</th><th>操作</th></tr></thead>',
    columns: ['序号', '备课时间', '学科', '年级', '标题', '授课内容', '备注', '操作'],
    row: `'<td class="prep-no">' + (index + 1) + '</td>'`,
    loop: 'ordered.map((record, index)',
  },
  {
    name: '笔记', source: work, css: appCss, style: '.kb-table .kb-no',
    thead: '<thead><tr><th>序号</th><th>创建时间</th><th>分类</th><th>标题</th><th>标签</th><th>内容摘要</th><th>操作</th></tr></thead>',
    columns: ['序号', '创建时间', '分类', '标题', '标签', '内容摘要', '操作'],
    row: `'<td class="kb-no">' + (index + 1) + '</td>'`,
    loop: 'list.map((note, index)',
  },
  {
    name: '出差', source: trips, css: tripsCss, style: '.trips-table .trips-no',
    thead: "<thead><tr><th>序号</th>'+TRIP_COLUMNS.map",
    columns: ['序号', ...TRIP_COLUMNS],
    row: `<td class="trips-no">'+(index+1)+'</td>`,
    loop: 'rows.map((row,index)',
  },
  {
    name: '学习', source: study, css: tripsCss, style: '.trips-table .trips-no',
    thead: "<thead><tr><th>序号</th>'+STUDY_COLUMNS.map",
    columns: ['序号', ...STUDY_COLUMNS],
    row: `<td class="trips-no">'+(index+1)+'</td>`,
    loop: 'rows.map((row,index)',
  },
];

for (const table of tables) {
  test(table.name + '列表首列是序号，空态 colspan 跟着表头列数走', () => {
    assert.ok(table.source.includes(table.thead), table.name + ' 表头首位不是序号');
    assert.ok(table.source.includes(table.row), table.name + ' 行模板缺序号单元格');
    assert.ok(table.source.includes(table.loop), table.name + ' 渲染行时没有取到 index');
    assert.ok(table.css.includes(table.style), table.name + ' 缺序号列样式');
    const headers = table.thead.match(/<th>[^<]*<\/th>/g) || [];
    /* 出差、学习的表头由列数组生成，源码里只有序号这一个 <th>，无从核对顺序。 */
    if (table.thead.includes('</thead>')) assert.deepEqual(headers.map((th) => th.slice(4, -5)), table.columns, table.name + ' 表头顺序不对');
    assert.ok(table.source.includes('colspan="' + table.columns.length + '"'), table.name + ' 空态 colspan 应为 ' + table.columns.length);
    assert.ok(!table.source.includes('colspan="' + (table.columns.length - 1) + '"'), table.name + ' 还留着加序号之前的空态列数');
  });
}

test('序号列不写进列定义，导出 CSV 的列保持原样', () => {
  for (const columns of [CSV_HEADERS, TRIP_COLUMNS, STUDY_COLUMNS, STUDY_CSV_HEADERS]) {
    assert.ok(!columns.includes('序号'), '列定义里混入了序号：' + columns.join('、'));
  }
});

test('出差表格靠日期对齐的样式跟着序号后移一列', () => {
  assert.ok(tripsCss.includes('.trips-table td:nth-child(2){white-space:nowrap}'), '日期 nowrap 没有从第 1 列挪到第 2 列');
  assert.ok(!tripsCss.includes('.trips-table td:nth-child(1)'), '序号列还占着日期的 nowrap 规则');
  assert.ok(tripsCss.includes('.trips-table{width:100%;min-width:1140px'), '出差表格宽度没给序号列留位');
  assert.ok(studyCss.includes('.study-table{min-width:1140px}'), '学习表格覆盖了公共宽度，需一起放宽');
});

test('任务列表是卡片布局，序号用角标而不是表头', () => {
  assert.ok(!selfstudy.includes('<th>'), '任务列表不是表格，出现表头说明改动落错了地方');
  assert.ok(selfstudy.includes('list.map((t, index) =>'), '渲染任务时没有取到 index');
  assert.ok(selfstudy.includes('<div class="ssm-item-no">${index + 1}</div>'), '任务卡片缺序号角标');
  assert.ok(appCss.includes('.ssm-item-no {'), '任务卡片序号角标缺样式');
});
