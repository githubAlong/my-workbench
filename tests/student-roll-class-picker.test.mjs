import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normGrade, inferGrade, normClass, gradeRank, clsShort, clsPair, makeClsLabeler } from '../js/grade-class.mjs';

/* Windows 工作区是 CRLF，切函数体前先归一，否则按 '\n}\n' 找结尾会找不到 */
const src = (await readFile(new URL('../student.html', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');

const slice = (name) => {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `student.html 里要有 ${name}`);
  return src.slice(start, src.indexOf('\n}\n', start) + 2);
};

/* 排序用的数字抽取函数和 rollChoices 是一套的，一起切进来才跑得动 */
const helpers = src.slice(src.indexOf('const CN_DIGIT'), src.indexOf('function rollChoices()'));

/* 学生页是 ES module，抽出来的函数体依赖 grade-class.mjs，这里显式注入同一套实现 */
const DEPS = ['normGrade', 'inferGrade', 'normClass', 'gradeRank', 'clsShort', 'clsPair', 'makeClsLabeler'];
const DEP_VALS = [normGrade, inferGrade, normClass, gradeRank, clsShort, clsPair, makeClsLabeler];
const build = (code, argNames = []) => new Function(...DEPS, ...argNames, code);

const choices = (data) => build(`${helpers}${slice('rollChoices')}; return rollChoices();`, ['data'])(...DEP_VALS, data);
const defaultPair = (pairs, opts) => build(`${helpers}${slice('rollDefaultPair')}; return rollDefaultPair;`)(...DEP_VALS)(pairs, opts);

const roster = (id, grade, class_name, n) => ({
  id, grade, class_name, count: n, names: Array.from({ length: n }, (_, i) => `学生${i + 1}`),
});
const course = (grade, class_name) => ({ grade, class_name });

test('候选来自老师课表；班名归一成「5班」，名字池按年级+班号去名单里对上', () => {
  const data = {
    rosters: [roster(1, '高二', '高二5班', 51), roster(2, '高一', '高一3班', 40)],
    classes: [5, 6, 7].map((n) => course('高二', `高二${n}班`)),
  };
  const c = choices(data);
  assert.deepEqual(c.gradeList, ['高二'], '年级跟着课表走：课表只有高二就只出高二');
  assert.equal(c.pairsOf('高二').length, 3, '课表排了三个班，学生端就选得到三个');
  assert.equal(c.pairsOf('高一').length, 0, '名单里有高一的班，但课表没排就不出现在学生端');
  const five = c.pairsOf('高二').find((p) => p.class_name === '5班');
  assert.equal(five.names.length, 51, '课表「高二5班」要对上名单「高二5班」的名字池');
  const six = c.pairsOf('高二').find((p) => p.class_name === '6班');
  assert.deepEqual(six.names, [], '课表有班但没名单，名字池为空，只能按号码点');
  assert.equal(six.count, 40, '没名单的班退回默认 40 人');
});

test('课表写「6班」、名单写「高二6班」也能对上号', () => {
  const c = choices({
    rosters: [roster(1, '高二', '高二6班', 52)],
    classes: [course('高二', '6班')],
  });
  const six = c.pairs[0];
  assert.equal(six.class_name, '6班', '下拉里只显示班号');
  assert.equal(six.names.length, 52, '两种写法是同一个班，名字池要对上');
});

test('课表一堂都没排时退回名单，学生端不会一个班都选不到', () => {
  const c = choices({ rosters: [roster(1, '高二', '高二5班', 51)], classes: [] });
  assert.equal(c.pairs.length, 1);
  assert.equal(c.pairs[0].class_name, '5班');
  assert.equal(c.pairs[0].names.length, 51);
});

test('班级名是空的班照样能选，标签只显示年级', () => {
  const c = choices({ rosters: [roster(1, '高二', '', 51)], classes: [] });
  assert.equal(c.pairsOf('高二').length, 1, '班级名为空不能被 filter(Boolean) 掉');
  assert.equal(c.clsLabel(c.pairs[0]), '高二');
});

test('年级和班级都空的那份名单不进候选，只剩按号码', () => {
  const c = choices({ rosters: [roster(1, '', '', 51), roster(2, '高二', '5班', 40)], classes: [] });
  assert.equal(c.pairs.length, 1);
});

test('班级按班号数字序排，10 班不排到 5 班前面', () => {
  const c = choices({
    classes: [course('高二', '高二10班'), course('高二', '高二5班'), course('高二', '高二2班')],
    rosters: [],
  });
  assert.deepEqual(c.pairsOf('高二').map((p) => c.clsLabel(p)), ['2班', '5班', '10班']);
});

test('年级排成高一、高二、高三，不按拼音把高二顶到最前面', () => {
  const c = choices({
    classes: [course('高二', '5班'), course('高三', '1班'), course('高一', '2班')],
    rosters: [],
  });
  assert.deepEqual(c.gradeList, ['高一', '高二', '高三']);
});

test('班号认中文也认阿拉伯数字，九班和十班都排在 5 班后面', () => {
  const c = choices({
    classes: [course('高二', '九班'), course('高二', '十班'), course('高二', '5班')],
    rosters: [],
  });
  assert.deepEqual(c.pairsOf('高二').map((p) => c.clsLabel(p)), ['5班', '九班', '十班']);
});

test('同一个班传了两份名单只留一条，优先有名字的那份', () => {
  const c = choices({
    rosters: [{ id: 1, grade: '高二', class_name: '5班', count: 51, names: [] }, roster(2, '高二', '5班', 30)],
    classes: [course('高二', '5班')],
  });
  assert.equal(c.pairs.length, 1);
  assert.equal(c.pairs[0].id, 2);
  assert.equal(c.pairs[0].names.length, 30);
});

test('默认先落在正在签到的那个班', () => {
  const c = choices({ classes: [course('高二', '5班'), course('高二', '7班')], rosters: [] });
  const hit = defaultPair(c.pairs, { liveCls: { grade: '高二', class_name: '7班' }, saved: {}, taskCls: '' });
  assert.equal(hit.class_name, '7班');
});

test('没有签到时回到这台设备上次用的班，班级名为空也认得', () => {
  const c = choices({ classes: [course('高二', '5班'), course('高二', '')], rosters: [] });
  const hit = defaultPair(c.pairs, { liveCls: null, saved: { roll_grade: '高二', roll_cls: '' }, taskCls: '' });
  assert.equal(hit.class_name, '');
});

test('偏好没记过就退到任务带出的班级，再退到第一个班', () => {
  const c = choices({ classes: [course('高二', '5班'), course('高二', '7班')], rosters: [] });
  assert.equal(defaultPair(c.pairs, { liveCls: null, saved: {}, taskCls: '高二 · 7班' }).class_name, '7班');
  assert.equal(defaultPair(c.pairs, { liveCls: null, saved: {}, taskCls: '' }).class_name, '5班');
  assert.equal(defaultPair([], { liveCls: null, saved: {}, taskCls: '' }), null);
});

/* 下面是接线：真正跑 DOM 得开浏览器，这里至少保证改完不会悄悄把控件或口径丢掉。 */
test('点名页真的接上了年级/班级两个下拉与名单来源提示', () => {
  const roll = slice('paintRoll');
  assert.match(roll, /id="pk-grade"/, '年级下拉');
  assert.match(roll, /id="pk-cls"/, '班级下拉');
  assert.match(roll, /rollDefaultPair\(pairs/, '默认选班走同一个函数');
  assert.match(roll, /savePref\('roll_grade'/, '换年级要记住');
  assert.match(roll, /savePref\('roll_cls'/, '换班级要记住');
  assert.match(roll, /nameBtn\.disabled = !names0\.length/, '没名单的班不能按名字点');
  assert.match(roll, /if \(!names0\.length\) \{ if \(mode === 'name'\) setMode\('no'\); \}/, '换到没名单的班退回按号码');
  assert.match(roll, /else if \(!modeTouched\) setMode\('name'\)/, '换回有名单的班回到默认的按名字');
  assert.match(roll, /let mode = names0\.length \? 'name' : 'no'/, '有名单时默认按名字');
  assert.match(roll, /data-mode="name"[\s\S]*?>按名字<\/button>[\s\S]*data-mode="no"[\s\S]*?>按号码<\/button>/, '按钮顺序：按名字在前、按号码在后');
  assert.match(roll, /const keyOf = \(\) => `\$\{sel \? pairText\(sel\)/, '不重复的池子按班级分开');
  assert.match(roll, /lockables\.forEach\(\(x\) => \{ x\.disabled = true; \}\)/, '转圈期间锁住这张卡的控件');
  assert.match(roll, /lockables\.forEach\(\(x\) => \{ x\.disabled = false; \}\)/, '揭晓后要解锁');
});
