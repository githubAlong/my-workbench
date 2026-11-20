import test from 'node:test';
import assert from 'node:assert/strict';
import { classSuggestions } from '../js/class-picker.mjs';
import { installBrowser } from './test-browser.mjs';

test('课表班级按年级区分，相同班级去重，已删除课程不参与候选', () => {
  const rows = [
    { grade: '高二', class_name: ' 5班 ' },
    { grade: '高一', class_name: '5班' },
    { grade: '高二', class_name: '高二5班' },
    { grade: '高二', class_name: '11班' },
    { grade: '高二', class_name: '9班', deleted_at: '2026-11-20' },
    { grade: '高三', class_name: '' },
  ];
  const choices = classSuggestions(rows, { qualified: true });
  assert.deepEqual(choices.map(({ value }) => value), ['高二5班', '高二11班', '高一5班']);
  assert.equal(choices.find(({ value }) => value === '高一5班').grade, '高一');
  assert.deepEqual(classSuggestions([]), []);
});

test('有独立年级字段的表单保留原始班级名', () => {
  const choices = classSuggestions([{ grade: '高二', class_name: '5班' }]);
  assert.deepEqual(choices, [{ label: '高二5班', grade: '高二', value: '5班' }]);
});

test('课堂签到可以为未建名单的班级开启，重复开同一班时复用原场次', async () => {
  installBrowser();
  const { handle } = await import('../js/localapi.js');
  const open = async (className) => {
    const result = await handle('POST', '/roll/open', {}, { class_name: className, date: '2026-11-20', period_no: 1 });
    assert.equal(result.ok, true, result.error);
    return result.data;
  };
  const first = await open('临时合班甲');
  const repeat = await open(' 临时合班甲 ');
  const other = await open('临时合班乙');
  assert.equal(first.class_name, '临时合班甲');
  assert.equal(first.roster_id, null);
  assert.equal(repeat.id, first.id);
  assert.notEqual(other.id, first.id);
});
