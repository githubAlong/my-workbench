import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CSV_HEADERS, buildPrepCsv, parsePrepCsv, csvEscape, normalizePrepDate,
  applyFilterDefaults, filterPrepRows, truncateTwoLines,
} from '../js/prep-csv.mjs';

const sample = {
  planDate: '2026-11-12', subject: '信息技术', grade: '高一15班',
  title: '表格与公式', process: '第一节讲单元格\n第二节讲函数', remark: '带,逗号和"引号"',
};

test('导出 CSV 带 BOM、表头为六个中文字段、内容正确转义', () => {
  const csv = buildPrepCsv([sample]);
  assert.ok(csv.startsWith('\uFEFF'));
  assert.ok(csv.includes(CSV_HEADERS.join(',')));
  assert.ok(csv.includes('"第一节讲单元格\n第二节讲函数"'));
  assert.ok(csv.includes('"带,逗号和""引号"""'));
});

test('导出 → 解析回环一致，含逗号、引号、换行、CRLF', () => {
  const parsed = parsePrepCsv(buildPrepCsv([sample, { ...sample, title: '第二课', remark: '' }]));
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.rows[0].title, '表格与公式');
  assert.equal(parsed.rows[0].process, '第一节讲单元格\n第二节讲函数');
  assert.equal(parsed.rows[0].remark, '带,逗号和"引号"');
  assert.equal(parsed.rows[0].planDate, '2026-11-12');
  assert.equal(parsed.rows[1].remark, '');
});

test('解析兼容 BOM、CRLF、英文 key 与历史表头叫法', () => {
  const csv = '\uFEFFdate,subject,class_name,topic,content,remark\r\n2026/3/5,语文,高一1班,春,正文,无\r\n';
  const parsed = parsePrepCsv(csv);
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].planDate, '2026-03-05');
  assert.equal(parsed.rows[0].grade, '高一1班');
  assert.equal(parsed.rows[0].title, '春');
  const legacy = parsePrepCsv('上课日期,学科,年级班级,课题,本节课授课内容,备注\n2026年3月5日,数学,高二,函数,讲解,');
  assert.equal(legacy.rows[0].planDate, '2026-03-05');
  assert.equal(legacy.rows[0].process, '讲解');
});

test('结构错误与空文件不产生脏数据', () => {
  assert.deepEqual(parsePrepCsv('').errors, ['文件是空的']);
  assert.match(parsePrepCsv('学科,年级\n语文,高一').errors[0], /标题/);
  assert.equal(parsePrepCsv('备课时间,学科,年级,标题,授课内容,备注\n\n\n').rows.length, 0);
});

test('日期规范化：补零、中文、非法值', () => {
  assert.equal(normalizePrepDate('2026-3-5'), '2026-03-05');
  assert.equal(normalizePrepDate('2026/11/12'), '2026-11-12');
  assert.equal(normalizePrepDate('2026年11月12日'), '2026-11-12');
  assert.equal(normalizePrepDate('2026-13-01'), '');
  assert.equal(normalizePrepDate('乱写'), '');
  assert.equal(normalizePrepDate(''), '');
});

test('导入时把筛选值补到缺失字段，已有值不被覆盖', () => {
  const filters = { subject: '数学', grade: '高二3班', from: '2026-09-01', to: '2026-12-31' };
  const filled = applyFilterDefaults({ subject: '', grade: '', planDate: '', title: '测试' }, filters);
  assert.equal(filled.subject, '数学');
  assert.equal(filled.grade, '高二3班');
  assert.equal(filled.planDate, '2026-09-01');
  const kept = applyFilterDefaults({ subject: '语文', grade: '高一', planDate: '2026-11-11' }, filters);
  assert.equal(kept.subject, '语文');
  assert.equal(kept.grade, '高一');
  assert.equal(kept.planDate, '2026-11-11');
});

test('按 学科 / 年级 / 日期区间 / 关键词 过滤', () => {
  const rows = [
    { planDate: '2026-09-01', subject: '语文', grade: '高一', title: '春', process: '写景', remark: '' },
    { planDate: '2026-11-12', subject: '数学', grade: '高二', title: '函数', process: '单调性', remark: '重点' },
    { planDate: '2027-01-05', subject: '数学', grade: '高二', title: '导数', process: '极值', remark: '' },
  ];
  assert.equal(filterPrepRows(rows, { subject: '数学' }).length, 2);
  assert.equal(filterPrepRows(rows, { subject: '数学', grade: '高二', from: '2026-11-01', to: '2026-11-30' }).length, 1);
  assert.equal(filterPrepRows(rows, { keyword: '单调' }).length, 1);
  assert.equal(filterPrepRows(rows, { keyword: '重点' }).length, 1);
  assert.equal(filterPrepRows(rows, {}).length, 3);
});

test('授课内容两行截断：短文本原样、长文本带 .....、换行压平', () => {
  assert.deepEqual(truncateTwoLines('短内容'), { text: '短内容', clipped: false });
  const long = '这里是一段很长的授课内容'.repeat(12);
  const clipped = truncateTwoLines(long);
  assert.equal(clipped.clipped, true);
  assert.ok(clipped.text.endsWith('.....'));
  assert.ok(clipped.text.length < long.length);
  const multiline = truncateTwoLines('第一行内容\n第二行内容');
  assert.equal(multiline.text, '第一行内容 第二行内容');
  assert.equal(multiline.clipped, false);
  assert.deepEqual(truncateTwoLines(''), { text: '', clipped: false });
});

test('csvEscape 只在必要时加引号', () => {
  assert.equal(csvEscape('普通'), '普通');
  assert.equal(csvEscape('a,b'), '"a,b"');
  assert.equal(csvEscape('a"b'), '"a""b"');
  assert.equal(csvEscape(null), '');
});
