import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/* Windows 工作区是 CRLF，切函数体前先归一，否则按 '\n}\n' 找结尾会找不到 */
const src = (await readFile(new URL('../student.html', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');

/* classChoices 是内联在学生页里的，这里整段切出来真跑一遍：
   断言的是学生实际看到的下拉顺序，而不是源码长得对不对。 */
const start = src.indexOf('function classChoices()');
const body = src.slice(start, src.indexOf('\n}\n', start) + 2);
const choices = (rows) => new Function('data', 'clsName', `${body}; return classChoices();`)(
  { classes: rows },
  (grade, name) => (grade && !String(name).startsWith(grade) ? grade + name : name),
);

test('班级下拉按班号排，10 班不再插到 5 班前面', () => {
  const rows = [10, 11, 12, 13, 14, 15, 16, 18, 5, 6, 7, 8, 9]
    .map((n) => ({ grade: '高二', class_name: `高二${n}班` }));
  assert.deepEqual(choices(rows).classesOf('高二'),
    [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 18].map((n) => `高二${n}班`));
});

test('班号单独存成「10 班」这种写法也按数字比，空值不进选项', () => {
  const rows = [
    { grade: '高一', class_name: '9 班' }, { grade: '高一', class_name: '10 班' },
    { grade: '高一', class_name: '2 班' }, { grade: '高一', class_name: '2 班' },
    { grade: '高一', class_name: '' }, { grade: '', class_name: '' },
  ];
  assert.deepEqual(choices(rows).classesOf('高一'), ['2 班', '9 班', '10 班']);
  assert.deepEqual(choices(rows).gradeList, ['高一']);
});

test('违纪和留言板两个页签共用同一份选项，改一处两边都跟着变', () => {
  const uses = src.match(/const \{ classPairs, gradeList, classesOf, splitCls \} = classChoices\(\);/g) || [];
  assert.equal(uses.length, 2, 'paintMisconduct 与 paintBulletinBoard 都要走 classChoices');
  assert.doesNotMatch(src, /localeCompare\([^)]*'zh-Hans-CN'\)/, '不能再留一处不带 numeric 的排序');
});
