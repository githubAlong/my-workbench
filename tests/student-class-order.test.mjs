import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normGrade, inferGrade, normClass, gradeRank, clsShort, clsPair, makeClsLabeler } from '../js/grade-class.mjs';

/* Windows 工作区是 CRLF，切函数体前先归一，否则按 '\n}\n' 找结尾会找不到 */
const src = (await readFile(new URL('../student.html', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');

/* classChoices 是内联在学生页里的，这里整段切出来真跑一遍：
   断言的是学生实际看到的下拉顺序，而不是源码长得对不对。
   数据源是老师课表 classes（归一后就是「高二 / 5班」），课表没排才退回名单。 */
const start = src.indexOf('function classChoices()');
const body = src.slice(start, src.indexOf('\n}\n', start) + 2);

/* 学生页是 ES module，抽出来的函数体依赖 grade-class.mjs，这里显式注入同一套实现 */
const DEPS = ['normGrade', 'inferGrade', 'normClass', 'gradeRank', 'clsShort', 'clsPair', 'makeClsLabeler'];
const DEP_VALS = [normGrade, inferGrade, normClass, gradeRank, clsShort, clsPair, makeClsLabeler];
const build = (code, argNames = []) => new Function(...DEPS, ...argNames, code);
const choices = (rows) => build(`${body}; return classChoices();`, ['data'])(...DEP_VALS, { classes: rows });

test('班级下拉按班号排，10 班不再插到 5 班前面', () => {
  const rows = [10, 11, 12, 13, 14, 15, 16, 18, 5, 6, 7, 8, 9]
    .map((n) => ({ grade: '高二', class_name: `高二${n}班` }));
  assert.deepEqual(choices(rows).classesOf('高二'),
    [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 18].map((n) => `${n}班`),
    '课表里的「高二5班」在下拉里要显示成「5班」');
});

test('班号单独存成「10 班」这种写法也按数字比，空值不进选项', () => {
  const rows = [
    { grade: '高一', class_name: '9 班' }, { grade: '高一', class_name: '10 班' },
    { grade: '高一', class_name: '2 班' }, { grade: '高一', class_name: '2 班' },
    { grade: '高一', class_name: '' }, { grade: '', class_name: '' },
  ];
  assert.deepEqual(choices(rows).classesOf('高一'), ['2班', '9班', '10班'],
    '带空格的「2 班」「10 班」都要归成「2班」「10班」');
  assert.deepEqual(choices(rows).gradeList, ['高一']);
});

test('年级按 高一→高二→高三 固定顺序，不按拼音排', () => {
  const rows = [
    { grade: '高三', class_name: '1班' },
    { grade: '高一', class_name: '2班' },
    { grade: '高二', class_name: '5班' },
  ];
  assert.deepEqual(choices(rows).gradeList, ['高一', '高二', '高三']);
});

test('同一个班在课表里出现多次，下拉里只留一条', () => {
  const rows = [
    { grade: '高二', class_name: '5班' }, { grade: '高二', class_name: '高二5班' },
    { grade: '高二', class_name: '高二(5)班' },
  ];
  assert.deepEqual(choices(rows).classesOf('高二'), ['5班'], '三种写法是同一个班');
});

test('课表没排班时退回班级名单，学生端不会一个班都选不到', () => {
  const c = build(`${body}; return classChoices();`, ['data'])(...DEP_VALS,
    { classes: [], rosters: [{ grade: '高二', class_name: '高二6班' }] });
  assert.deepEqual(c.classesOf('高二'), ['6班']);
});

test('违纪和留言板两个页签共用同一份选项，改一处两边都跟着变', () => {
  const uses = src.match(/const \{ classPairs, gradeList, classesOf, splitCls \} = classChoices\(\);/g) || [];
  assert.equal(uses.length, 2, 'paintMisconduct 与 paintBulletinBoard 都要走 classChoices');
  assert.doesNotMatch(src, /localeCompare\([^)]*'zh-Hans-CN'\)/, '不能再留一处不带 numeric 的排序');
});
