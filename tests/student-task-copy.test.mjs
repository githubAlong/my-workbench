import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const src = (await readFile(new URL('../student.html', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');

test('学生端页签与文案改成「任务」，不再出现自习字样', () => {
  assert.match(src, /selfstudy: \{ icon: ICON\.clock, label: '任务' \}/);
  assert.doesNotMatch(src, /label: '自习'/);
  assert.equal(src.match(/今日自习任务/g)?.length || 0, 0, '卡片标题和两处兜底都要换成今日任务');
  assert.equal(src.match(/今日任务/g)?.length || 0, 3, '空态标题 + 任务卡 + 弹层兜底');
  assert.doesNotMatch(src, /本时段暂无自习任务/);
  assert.match(src, /<b>暂无任务<\/b>/);
});

test('标签页图标是「课」，不再让浏览器去要仓库里没有的 favicon.ico', () => {
  const icon = src.match(/<link rel="icon" href="([^"]+)">/);
  assert.ok(icon, 'student.html 要有自己的 favicon 声明');
  assert.match(icon[1], /^data:image\/svg\+xml,/);
  assert.ok(decodeURIComponent(icon[1]).includes('课'), '图标里就是「课」这个字');
});
