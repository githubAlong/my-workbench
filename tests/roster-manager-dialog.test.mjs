import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/* Windows 工作树是 CRLF，切函数体前先归一，否则按 '\n}' 找结尾会找不到 */
const work = (await readFile(new URL('../js/work.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const core = (await readFile(new URL('../js/core.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const css = (await readFile(new URL('../css/app.css', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');

const fnStart = work.indexOf('function openRosterDialog(rosters, reload) {');
assert.ok(fnStart >= 0, 'work.js 里要有 openRosterDialog');
const dialog = work.slice(fnStart, work.indexOf('\n}\n', fnStart) + 2);

/* 名单解析 / 脏判定 / 重名计数是从源码里抠出来真跑的，不是照着抄第二遍 */
const grab = (name) => {
  const m = dialog.match(new RegExp(`const ${name} = [^\\n]+;`));
  assert.ok(m, `openRosterDialog 里要有单行的 const ${name}`);
  return `${m[0]}\n`;
};
const logic = new Function(`${grab('splitNames')}${grab('sameNames')}${grab('dupCount')}; return { splitNames, sameNames, dupCount };`)();

test('姓名切分认换行、逗号、顿号、分号和空格，空白不产出空姓名', () => {
  assert.deepEqual(logic.splitNames('张三\n李四, 王五、赵六；钱七  孙八'), ['张三', '李四', '王五', '赵六', '钱七', '孙八']);
  assert.deepEqual(logic.splitNames('   \n  ,  '), []);
  assert.deepEqual(logic.splitNames(undefined), []);
});

test('脏判定按顺序比姓名：改一个字算脏，原样比就不算', () => {
  assert.equal(logic.sameNames(['张三', '李四'], ['张三', '李四']), true);
  assert.equal(logic.sameNames(['张三', '李四'], ['张三', '李四四']), false);
  assert.equal(logic.sameNames(['张三', '李四'], ['李四', '张三']), false);
  assert.equal(logic.sameNames(['张三'], ['张三', '李四']), false);
});

test('重名计数用来在界面上提示「有 N 个重名，点这里去掉」', () => {
  assert.equal(logic.dupCount(['张三', '张三', '李四', '张三']), 2);
  assert.equal(logic.dupCount(['张三', '李四']), 0);
  assert.equal(logic.dupCount([]), 0);
});

test('旧的一次性全存写法已经拆掉：不再遍历所有班 PATCH，也不再挂 N 个大文本框', () => {
  assert.doesNotMatch(dialog, /for \(const r of rosters\)/, '不该再把每个班都 PATCH 一遍');
  assert.doesNotMatch(dialog, /data-names="\$\{r\.id\}"/, '不该再给每个班挂一个 textarea');
  assert.doesNotMatch(dialog, /nr-names|nr-grade|nr-class/, '新建班级那套一次性表单 id 已经换进主从结构');
});

test('保存与删除都落在「当前选中的那一个班」上', () => {
  assert.match(dialog, /api\.patch\('\/rosters\/' \+ it\.id/, 'PATCH 只打当前班');
  assert.match(dialog, /api\.del\('\/rosters\/' \+ it\.id/, '删除只删当前班');
  assert.match(dialog, /api\.post\('\/rosters'/, '新建走 POST');
  /* 空名单时 count 要退到原来的人数，不能被冲成 0，否则「按号码点」就没了 */
  assert.match(dialog, /count: names\.length \|\| it\.fallback \|\| 0/);
});

test('主从两栏的关键部位都在：左侧列表 + 搜索 + 未保存标记 + 右侧单班编辑', () => {
  for (const id of ['rm-classes', 'rm-q', 'rm-main', 'rm-new', 'rm-names', 'rm-meta', 'rm-state', 'rm-save', 'rm-revert', 'rm-text', 'rm-addn']) {
    assert.ok(dialog.includes(`id="${id}"`), `弹窗里要有 #${id}`);
  }
  assert.match(dialog, /isDirty\(it\) \? ' dirty' : ''/, '左侧班级要能标出「改动未保存」');
  assert.match(dialog, /data-act="chip-x"/, '每个姓名卡片带一个删除按钮');
});

test('卡片 ⇄ 批量粘贴两种录入形态共用同一份名单', () => {
  assert.match(dialog, /mode === 'chip'/);
  assert.match(dialog, /it\.names = splitNames\(\$\('#rm-text'\)\.value\)/, '切回卡片时才把文本框并进名单');
  assert.match(dialog, /it\.names = got\.names\.slice\(\)/, '导入 Excel/CSV 直接覆盖工作副本，不写库');
});

test('代码里写到的 rm-* 类名，样式表里都得有对应规则', () => {
  /* 只看 class="..." 里的 token，并把 ${} 拼进来的分支抹掉：
     不然会把 id="rm-q" 当类名误报，也会漏掉真没样式的死类。 */
  const classAttrs = [...dialog.matchAll(/class="([^"]*)"/g)].map((m) => m[1].replace(/\$\{[^}]*\}/g, ' '));
  const used = [...new Set(classAttrs.flatMap((v) => v.split(/\s+/)).filter((x) => /^rm-[a-z-]+$/.test(x)))].sort();
  assert.ok(used.length >= 12, `应该扫到一批 rm-* 类名，实际 ${used.length} 个`);
  const missing = used.filter((c) => !new RegExp(`\\.${c}\\b`).test(css));
  assert.deepEqual(missing, [], `这些类在 app.css 里没有样式：${missing.join(', ')}`);
});

test('每个 data-act 都有分支接住，点了不会没反应', () => {
  const emitted = [...new Set([...dialog.matchAll(/data-act="([a-z-]+)"/g)].map((m) => m[1]))].sort();
  const handled = [...new Set([...dialog.matchAll(/act === '([a-z-]+)'/g)].map((m) => m[1]))].sort();
  assert.ok(emitted.length >= 6, `data-act 至少 6 个，实际 ${emitted.length}`);
  assert.deepEqual(emitted.filter((a) => !handled.includes(a)), [], '有按钮没有对应处理分支');
});

test('sheet() 的关窗否决钩子只认严格的 false，没传钩子的弹层照常关', () => {
  assert.match(core, /onBeforeClose\?\.\(\) === false/, '只有返回 false 才拦，undefined 必须放行');
  assert.match(core, /export function sheet\(\{[^}]*onBeforeClose/, 'sheet() 要收 onBeforeClose');
  assert.match(dialog, /onBeforeClose: askClose/, '班级名单确实挂上了这道拦截');
  assert.match(dialog, /if \(!n \|\| okToClose\) return true/, '确认过之后要放行，不能死循环');
});

test('paintMain 里造的节点，事件必须绑在 paintMain 内部', () => {
  /* #rm-file / #rm-addn 是 paintMain 每次重绘新建的：绑在函数末尾会在第一次
     openRosterDialog 时拿到 null 直接抛错（改一半踩到过），所以断言位置关系。
     #rm-q / #rm-new 属于外层静态骨架，绑在后面才对，不在这里管。 */
  const at = (re) => dialog.search(re);
  const start = at(/const paintMain = \(\) => \{/);
  const end = at(/const addNames = /);
  assert.ok(start >= 0 && end > start, '找不到 paintMain 的边界');
  for (const id of ['rm-file', 'rm-addn', 'rm-grade', 'rm-class']) {
    const i = at(new RegExp(`\\$\\('#${id}'\\)\\.on`));
    assert.ok(i > start && i < end, `#${id} 的事件绑定要挪进 paintMain`);
  }
});
