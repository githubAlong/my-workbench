import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/* Windows 工作区是 CRLF，切函数体前先归一，否则按 '\n}\n' 找结尾会找不到 */
const src = (await readFile(new URL('../student.html', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');

const clsName = (grade, name) => {
  const g = String(grade || '').trim();
  const c = String(name || '').trim();
  if (!g) return c;
  if (!c) return g;
  return c.startsWith(g) ? c : g + ' ' + c;
};

const slice = (name) => {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `student.html 里要有 ${name}`);
  return src.slice(start, src.indexOf('\n}\n', start) + 2);
};

/* 排序用的数字抽取函数和 rollChoices 是一套的，一起切进来才跑得动 */
const helpers = src.slice(src.indexOf('const CN_DIGIT'), src.indexOf('function rollChoices()'));

const choices = (data) => new Function('data', `${helpers}${slice('rollChoices')}; return rollChoices();`)(data);
const defaultPair = (pairs, opts) => new Function('clsName', `${helpers}${slice('rollDefaultPair')}; return rollDefaultPair;`)(clsName)(pairs, opts);

const roster = (id, grade, class_name, n) => ({
  id, grade, class_name, count: n, names: Array.from({ length: n }, (_, i) => `学生${i + 1}`),
});

test('班级候选只认后台 rosters；课表 classes 不再参与，名字池认名单', () => {
  const data = {
    rosters: [roster(1, '高二', '5班', 51), roster(2, '高一', '3班', 40)],
    classes: [10, 11, 12, 13, 14, 15, 16, 18, 5, 6, 7, 8, 9].map((n) => ({ grade: '高二', class_name: `高二${n}班` })),
  };
  const c = choices(data);
  assert.deepEqual(c.gradeList, ['高一', '高二']);
  /* 课表里排过的班不进候选：同一间教室课表写「高二6班」、名单写「6班」，
     两套并排出现会让学生选岔。候选只跟着老师维护的名单走。 */
  assert.equal(c.pairs.length, 2, '课表班级不能再混进学生端点名的下拉');
  assert.equal(c.pairsOf('高二').length, 1, '高二只剩名单里的那个班');
  assert.equal(c.pairsOf('高二')[0].class_name, '5班');
  assert.equal(c.pairsOf('高二')[0].names.length, 51, 'rosters 里的班拿到真名单');
  assert.ok(!c.pairs.some((p) => p.class_name === '高二10班'), '课表独有的班不能出现');
});

test('班级名是空的班照样能选，标签只显示年级', () => {
  const c = choices({ rosters: [roster(1, '高二', '', 51)] });
  assert.equal(c.pairsOf('高二').length, 1, '班级名为空不能被 filter(Boolean) 掉');
  assert.equal(c.clsLabel(c.pairs[0]), '高二');
  assert.equal(clsName(c.pairs[0].grade, c.pairs[0].class_name), '高二');
});

test('年级和班级都空的那份名单不进候选，只剩按号码', () => {
  const c = choices({ rosters: [roster(1, '', '', 51), roster(2, '高二', '5班', 40)] });
  assert.equal(c.pairs.length, 1);
});

test('班级按班号数字序排，高二10班不排到高二5班前面', () => {
  const c = choices({
    rosters: [roster(1, '高二', '高二10班', 45), roster(2, '高二', '高二5班', 51), roster(3, '高二', '高二2班', 40)],
  });
  assert.deepEqual(c.pairsOf('高二').map((p) => c.clsLabel(p)), ['高二2班', '高二5班', '高二10班']);
});

test('年级排成高一、高二、高三，不按拼音把高二顶到最前面', () => {
  const c = choices({
    rosters: [roster(1, '高二', '5班', 51), roster(2, '高三', '1班', 40), roster(3, '高一', '2班', 45)],
  });
  assert.deepEqual(c.gradeList, ['高一', '高二', '高三']);
});

test('班号认中文也认阿拉伯数字，九班和十班都排在 5 班后面', () => {
  const c = choices({
    rosters: [roster(1, '高二', '九班', 40), roster(2, '高二', '十班', 41), roster(3, '高二', '5班', 42)],
  });
  assert.deepEqual(c.pairsOf('高二').map((p) => c.clsLabel(p)), ['5班', '九班', '十班']);
});

test('同一个班传了两份名单只留一条，优先有名字的那份', () => {
  const c = choices({
    rosters: [{ id: 1, grade: '高二', class_name: '5班', count: 51, names: [] }, roster(2, '高二', '5班', 30)],
  });
  assert.equal(c.pairs.length, 1);
  assert.equal(c.pairs[0].id, 2);
  assert.equal(c.pairs[0].names.length, 30);
});

test('默认先落在正在签到的那个班', () => {
  const c = choices({ rosters: [roster(1, '高二', '5班', 51), roster(2, '高二', '7班', 40)] });
  const hit = defaultPair(c.pairs, { liveCls: { grade: '高二', class_name: '7班' }, saved: {}, taskCls: '' });
  assert.equal(hit.class_name, '7班');
});

test('没有签到时回到这台设备上次用的班，班级名为空也认得', () => {
  const c = choices({ rosters: [roster(1, '高二', '5班', 51), roster(2, '高二', '', 40)] });
  const hit = defaultPair(c.pairs, { liveCls: null, saved: { roll_grade: '高二', roll_cls: '' }, taskCls: '' });
  assert.equal(hit.class_name, '');
});

test('偏好没记过就退到任务带出的班级，再退到第一份名单', () => {
  const c = choices({ rosters: [roster(1, '高二', '5班', 51), roster(2, '高二', '7班', 40)] });
  assert.equal(defaultPair(c.pairs, { liveCls: null, saved: {}, taskCls: '高二 7班' }).class_name, '7班');
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
  assert.match(roll, /来自后台上传的班级名单/, '人数从哪来的说明');
  assert.match(roll, /nameBtn\.disabled = !names0\.length/, '没名单的班不能按名字点');
  assert.match(roll, /if \(mode === 'name' && !names0\.length\) setMode\('no'\)/, '换到没名单的班退回按号码');
  assert.match(roll, /const keyOf = \(\) => `\$\{sel \? pairText\(sel\)/, '不重复的池子按班级分开');
  assert.match(roll, /lockables\.forEach\(\(x\) => \{ x\.disabled = true; \}\)/, '转圈期间锁住这张卡的控件');
  assert.match(roll, /lockables\.forEach\(\(x\) => \{ x\.disabled = false; \}\)/, '揭晓后要解锁');
});
