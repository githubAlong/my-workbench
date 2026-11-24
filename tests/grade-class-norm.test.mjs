/* 年级 / 班级口径统一：全站约定「年级 = 高二」「班级 = 5班」。
   历史数据里混着「高二5班」「高二(5)班」「高二 5 班」「5」「05班」这些写法，
   这个测试守住归一化函数，避免以后改出新的脏值。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { normGrade, inferGrade, normClass, clsShort, clsPair, clsStore, gradeRank } from '../js/core.js';

test('年级归一：去掉「年级」二字、空格和括号', () => {
  assert.equal(normGrade('高二'), '高二');
  assert.equal(normGrade('高二年级'), '高二');
  assert.equal(normGrade(' 高二 '), '高二');
  assert.equal(normGrade('高一'), '高一');
  assert.equal(normGrade('高三'), '高三');
  assert.equal(normGrade('初二年级'), '初二');
  assert.equal(normGrade(''), '');
  assert.equal(normGrade(null), '');
  assert.equal(normGrade(undefined), '');
});

test('年级归一：认不出来的自定义年级原样保留，不硬改', () => {
  assert.equal(normGrade('七年级'), '七年级');
  assert.equal(normGrade('A-level'), 'A-level');
});

test('从混杂值里推断年级', () => {
  assert.equal(inferGrade('高二5班'), '高二');
  assert.equal(inferGrade('高二(5)班'), '高二');
  assert.equal(inferGrade('5班'), '');
  assert.equal(inferGrade(''), '');
});

test('班级归一：一律收敛成「N班」', () => {
  const same = ['高二5班', '高二(5)班', '高二（5）班', '高二 5 班', '5班', '5', '05班', ' 5 班 '];
  for (const raw of same) {
    assert.equal(normClass(raw, '高二'), '5班', `${raw} 应归成 5班`);
  }
  assert.equal(normClass('5班', ''), '5班');
  assert.equal(normClass('高二5班', ''), '5班', 'grade 为空也要剥掉年级前缀');
});

test('班级归一：非数字班名保留，但剥掉年级', () => {
  assert.equal(normClass('实验班', '高二'), '实验班');
  assert.equal(normClass('高二实验班', '高二'), '实验班');
  assert.equal(normClass('', '高二'), '');
  assert.equal(normClass(null, '高二'), '');
});

test('年级与班级打架时以 grade 为准，班级里残留的别的年级也要剥掉', () => {
  assert.equal(normClass('高二5班', '高三'), '5班');
  assert.equal(clsStore('高三', '高二5班'), '高三5班');
});

test('展示用：clsShort 只给班号，年级空时退回年级', () => {
  assert.equal(clsShort('高二', '高二5班'), '5班');
  assert.equal(clsShort('高二', '5班'), '5班');
  assert.equal(clsShort('高二', ''), '高二');
  assert.equal(clsShort('', ''), '');
});

test('展示用：clsPair 带年级上下文「高二 · 5班」', () => {
  assert.equal(clsPair('高二', '5班'), '高二 · 5班');
  assert.equal(clsPair('', '高二5班'), '高二 · 5班', 'grade 空时从班级值里补出来');
  assert.equal(clsPair('高二', ''), '高二');
  assert.equal(clsPair('', ''), '');
});

test('存储用：没有 grade 列的表把年级写进班级值', () => {
  assert.equal(clsStore('高二', '5班'), '高二5班');
  assert.equal(clsStore('', '高二5班'), '高二5班');
  assert.equal(clsStore('高二', ''), '高二');
  assert.equal(clsStore('高二', '实验班'), '高二实验班');
});

test('年级排序：高一 → 高二 → 高三，未知年级排最后', () => {
  const rows = ['高三', '七年级', '高一', '高二'].sort((a, b) => gradeRank(a) - gradeRank(b));
  assert.deepEqual(rows, ['高一', '高二', '高三', '七年级']);
});
