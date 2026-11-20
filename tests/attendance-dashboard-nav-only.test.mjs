import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

const attindex = await readFile(new URL('../js/attindex.js', import.meta.url), 'utf8');
const attday = await readFile(new URL('../js/attday.js', import.meta.url), 'utf8');
const workspaceCss = await readFile(new URL('../css/attendance-workspace.css', import.meta.url), 'utf8');

/* 首页当年抓了一次 /attendance 快照来算「今日已确认 x/y」，
   在工作台里确认完退回来数字不动，看着就是坏的；现在整块不抓、不算、不显示。 */
test('考勤首页不再抓当天考勤表，也就没有会过期的确认数字', () => {
  assert.doesNotMatch(attindex, /api\.get\('\/attendance'/);
  assert.doesNotMatch(attindex, /dayProgress|dailyTableState|tableState/);
  assert.match(attindex, /await api\.get\('\/grades'\)/);
});

test('年级卡片去掉了确认进度、状态胶囊和三张表的状态格', () => {
  for (const gone of ['今日已确认', '今日确认进度', '今日已查齐', '今日进行中', '今日待开始',
    '待确认', '待重新确认', '未生成', 'agd-sheet', 'agd-progress', 'agd-grade-meta', 'agd-overall']) {
    assert.equal(attindex.includes(gone), false, `首页不该再出现「${gone}」`);
  }
});

test('卡片留的是不会失真的信息：教师人数、工作台范围、入口', () => {
  assert.match(attindex, /WORKSPACE_SCOPE = \['花名册', '坐班表', '教研表', '上课表'\]/);
  assert.match(attindex, /class="agd-grade-count/);
  assert.match(attindex, /agd-grade-scope/);
  assert.match(attindex, /进入考勤工作台/);
});

test('概览只留两项静态统计', () => {
  const stats = attindex.match(/<section class="agd-stats"[\s\S]*?<\/section>/)[0];
  assert.match(stats, /管理年级/);
  assert.match(stats, /教师总人数/);
  assert.equal((stats.match(/class="agd-stat /g) ?? []).length, 2);
  assert.equal(stats.includes('未完成表'), false);
});

test('样式跟着删干净，统计行改成两列', () => {
  assert.doesNotMatch(workspaceCss, /\.agd-(sheet|progress|grade-meta|overall)\b/);
  assert.match(workspaceCss, /\.agd-stats\{[^}]*repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(workspaceCss, /\.agd-grade-count>b\{/);
  assert.match(workspaceCss, /\.agd-grade-scope i\{/);
});

/* 删掉的函数最怕别处还在 import：那会直接白屏，单测跑不到运行时。 */
test('dayProgress 删掉后没有任何文件再引用它', async () => {
  assert.doesNotMatch(attday, /export function dayProgress/);
  const files = (await readdir(new URL('../js/', import.meta.url), { withFileTypes: true }))
    .filter((entry) => /\.m?js$/.test(entry.name));
  for (const name of files.map((entry) => entry.name)) {
    const source = await readFile(new URL('../js/' + name, import.meta.url), 'utf8');
    const imported = /import\s*\{([^}]*)\}\s*from\s*'\.\/attday\.js'/.exec(source);
    if (!imported) continue;
    assert.equal(imported[1].includes('dayProgress'), false, `${name} 还在从 attday.js 引 dayProgress`);
  }
});
