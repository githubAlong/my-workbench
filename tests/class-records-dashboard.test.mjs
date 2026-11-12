import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../js/class-records.js', import.meta.url), 'utf8');
const localdb = await readFile(new URL('../js/localdb.js', import.meta.url), 'utf8');
const localapi = await readFile(new URL('../js/localapi.js', import.meta.url), 'utf8');
const sql = await readFile(new URL('../step_class_records.sql', import.meta.url), 'utf8');

test('上课记录支持点击切换月份，可翻到上一个月、下一个月和最近一年', () => {
  for (const marker of [
    'id="cr-month-prev"', 'id="cr-month-next"', 'id="cr-month-pick"',
    'id="cr-month-input"', 'id="cr-month-quick"', 'id="cr-month-today"',
    'monthShift(month, -1)', 'monthShift(month, 1)', 'recentMonths()', 'currentMonthKey()',
  ]) assert.ok(source.includes(marker), 'missing month switch marker: ' + marker);
  assert.match(source, /rowMonth\(r\) !== month\) return false/);
  assert.match(source, /rows\.filter\(\(r\) => rowMonth\(r\) === month\)/);
  assert.ok(source.includes('上课记录统计_'));
});

test('统计区列出当月总次数与四类上课类型，方便月底核对课时', () => {
  for (const marker of [
    'id="cr-month-total"', 'id="cr-month-normal"', 'id="cr-month-isub"',
    'id="cr-month-subme"', 'id="cr-month-swap"', 'id="cr-month-fee"',
  ]) assert.ok(source.includes(marker), 'missing KPI card: ' + marker);
  for (const type of ['normal', 'i_substitute', 'substituted_for_me', 'swap']) {
    assert.ok(source.includes("'" + type + "'"), 'missing lesson type: ' + type);
  }
});

test('列表列顺序与新增表单字段顺序完全一致', () => {
  assert.match(source, /<th>上课日期<\/th><th>上课年级<\/th><th>上课班级<\/th><th>节次<\/th><th>学科<\/th><th>上课类型<\/th><th>上课人<\/th><th>代课人<\/th><th>课时费（元）<\/th><th>支付状态<\/th><th>备注说明<\/th><th>操作<\/th>/);
  const ids = ['cr-date', 'cr-grade', 'cr-class', 'cr-period', 'cr-subject', 'cr-type', 'cr-teacher', 'cr-substitute-person', 'cr-money', 'cr-status', 'cr-remark'];
  for (const id of ids) assert.ok(source.includes('id="' + id + '"'), 'missing form field: ' + id);
  assert.match(source, /\['上课日期', '上课年级', '上课班级', '节次', '学科', '上课类型', '上课人', '代课人', '课时费（元）', '支付状态', '备注说明'\]/);
});

test('只有上课日期、上课年级、上课班级是必填项', () => {
  assert.match(source, /if \(!date\) throw new Error\('请填写上课日期'\)/);
  assert.match(source, /if \(!grade\) throw new Error\('请填写上课年级'\)/);
  assert.match(source, /if \(!className\) throw new Error\('请填写上课班级'\)/);
  assert.doesNotMatch(source, /请选择上课类型|请填写学科/);
  assert.match(localapi, /class_records: \[\['class_month', '请填写上课日期'\], \['grade', '请填写上课年级'\], \['class_name', '请填写上课班级'\]\]/);
});

test('上课类型自动带出课时费与支付状态默认值', () => {
  assert.match(source, /normal: \{ amount: 30, status: '学校支付' \}/);
  assert.match(source, /i_substitute: \{ amount: 40, status: '待支付' \}/);
  assert.match(source, /substituted_for_me: \{ amount: 40, status: '待支付' \}/);
  assert.match(source, /swap: \{ amount: 0, status: '无需支付' \}/);
  assert.match(source, /type\.onchange = applyTypeDefaults/);
  for (const status of ['学校支付', '待支付', '无需支付']) {
    assert.ok(source.includes("'" + status + "'"), 'missing pay status option: ' + status);
  }
});

test('查看、编辑、删除是三个独立操作，打印操作已移除', () => {
  for (const marker of ['data-view=', 'data-edit=', 'data-delete=', 'openViewer', 'openEditor', 'removeRow', 'id="cr-view-close"', 'id="cr-cancel"']) {
    assert.ok(source.includes(marker), 'missing row action: ' + marker);
  }
  for (const removed of ['data-print=', 'printRow', '打印本条记录', '查看/编辑', 'cr-print-current']) {
    assert.ok(!source.includes(removed), 'print action should be gone: ' + removed);
  }
});

test('上课年级与上课人字段已登记到本地表结构和建表脚本', () => {
  assert.match(localdb, /class_records: \[[^\]]*'grade'[^\]]*'teacher'/);
  assert.match(sql, /grade text,\s*teacher text,/);
});
