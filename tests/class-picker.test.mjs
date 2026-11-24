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
  /* 有独立年级字段（qualified=false）：标签只给班名，年级不拼进去，
     下拉里不会出现「高二5班」这种把年级重复一遍的写法。 */
  const bare = classSuggestions(rows);
  assert.deepEqual(bare.map(({ label }) => label), ['5班', '5班', '11班']);
  /* 年级按 GRADE_ORDER 排（高一在前），同年级内按班号数字排。 */
  assert.deepEqual(bare.map(({ grade }) => grade), ['高一', '高二', '高二']);
  /* 同班号跨年级必须靠 id 区分，否则点「5班」会拿到第一个、年级填错。 */
  assert.equal(new Set(bare.map(({ id }) => id)).size, 3);
  /* 没有年级框的字段（qualified=true）才把年级写进标签，否则年级会丢。 */
  assert.deepEqual(classSuggestions(rows, { qualified: true }).map(({ label }) => label),
    ['高一5班', '高二5班', '高二11班']);
  assert.deepEqual(classSuggestions([]), []);
});

test('只有年级没有班号的脏数据不进候选', () => {
  /* 「高二」「高二()」「高二 」归一后没有班号，以前会原样变成下拉第一行那个「高二」。 */
  const choices = classSuggestions([
    { grade: '高二', class_name: '高二' },
    { grade: '高二', class_name: '高二()' },
    { grade: '高二', class_name: '高二 5 班' },
  ]);
  assert.deepEqual(choices.map(({ label }) => label), ['5班']);
});

test('有独立年级字段的表单只写班名，没有年级字段才带前缀', () => {
  const rows = [{ grade: '高二', class_name: '5班' }];
  assert.deepEqual(classSuggestions(rows), [{ id: '高二#5班', label: '5班', grade: '高二', value: '5班' }]);
  /* qualified = 这个字段是唯一的班级列（没有单独年级框），年级丢掉就补不回来，
     所以标签和写入值都带前缀 —— 这时下拉里出现「高二5班」不算重复。 */
  assert.deepEqual(classSuggestions(rows, { qualified: true }), [{ id: '高二#5班', label: '高二5班', grade: '高二', value: '高二5班' }]);
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
