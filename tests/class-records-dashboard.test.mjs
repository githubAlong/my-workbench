import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../js/class-records.js', import.meta.url), 'utf8');

test('class records page presents a course dashboard', () => {
  for (const marker of [
    '上课记录',
    '本月课程概况',
    'id="cr-month-total"',
    'id="cr-month-normal"',
    'id="cr-month-substitute"',
    'id="cr-month-swap"',
    '上课类型分布',
    '学科分布',
    'id="cr-record-grid"',
    'cr-record-card',
    'data-edit=',
    'data-print=',
    'data-delete=',
  ]) {
    assert.ok(source.includes(marker), 'missing dashboard marker: ' + marker);
  }
  assert.ok(!source.includes('课程数据驾驶舱'), 'legacy dashboard eyebrow should be removed');
  for (const marker of ['id="cr-date"', 'id="cr-period"', 'id="cr-time"', 'id="cr-substitute-person"', 'id="cr-original-teacher"', 'id="cr-status"']) {
    assert.ok(source.includes(marker), 'missing editable form field: ' + marker);
  }
  assert.ok(source.includes('placeholder="手动输入支付状态"'));
});

test('class records dashboard keeps all four lesson types and monthly export', () => {
  for (const type of ['normal', 'i_substitute', 'substituted_for_me', 'swap']) {
    assert.ok(source.includes("'" + type + "'"), 'missing lesson type: ' + type);
  }
  assert.ok(source.includes('currentMonthKey()'));
  assert.ok(source.includes('rowMonth(r) === month'));
  assert.ok(source.includes('上课记录统计_'));
});
