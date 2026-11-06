import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [home, grid, styles, ui] = await Promise.all([
  readFile(new URL('../js/home.js', import.meta.url), 'utf8'),
  readFile(new URL('../js/homegrid.js', import.meta.url), 'utf8'),
  readFile(new URL('../css/teacher-ui.css', import.meta.url), 'utf8'),
  readFile(new URL('../js/ui.js', import.meta.url), 'utf8'),
]);

test('首页包含八个设计稿快捷入口且路由有效', () => {
  const shortcuts = [...home.matchAll(/class="home-shortcut" href="#\/([^"]+)"/g)].map((m) => m[1]);
  assert.equal(shortcuts.length, 8);
  for (const route of ['work/lessons', 'work/timetable', 'work/attendance', 'work/prep',
    'work/invigilation', 'work/materials', 'study', 'work/notes']) {
    assert.ok(shortcuts.includes(route), `缺少快捷入口路由：${route}`);
  }
});

test('快捷入口使用项目已注册的图标名称', () => {
  const iconKeys = new Set([...ui.matchAll(/^  ([a-zA-Z0-9_-]+):\s*['"]/gm)].map((m) => m[1]));
  const usedIcons = [...home.matchAll(/class="shortcut-icon [^"]+">\$\{icon\('([^']+)'/g)].map((m) => m[1]);
  assert.equal(usedIcons.length, 8);
  for (const name of usedIcons) assert.ok(iconKeys.has(name), `图标未注册：${name}`);
});

test('桌面、平板和手机均有新版首页默认布局', () => {
  for (const bp of ['desktop', 'tablet', 'mobile']) {
    assert.match(grid, new RegExp(`\\b${bp}:\\s*\\[`));
  }
  for (const card of ['profile', 'weather', 'todayCourse', 'todayTodo', 'dailyQuote',
    'calendar', 'timeline', 'weekLessons', 'invigilation', 'prepDeadline', 'recentNotes']) {
    assert.ok(grid.includes(`['${card}'`), `默认布局缺少卡片：${card}`);
  }
});

test('旧版用户布局会升级到新版默认排布并保留隐藏偏好', () => {
  assert.match(grid, /version:\s*3,/);
  assert.match(grid, /if\s*\(rawVersion\s*<\s*3\)/);
  assert.match(grid, /const hidden = \[\.\.\.new Set\(\(raw\.breakpoints\.desktop\?\.hidden/);
  assert.match(grid, /out\.version = 3;/);
  assert.match(grid, /首次升级新版首页/);
});

test('快捷入口具备平板和手机响应式样式', () => {
  assert.match(styles, /\.home-shortcuts\s*\{[\s\S]*?grid-template-columns:\s*repeat\(8/);
  assert.match(styles, /@media\s*\(max-width:\s*1180px\)[\s\S]*?\.home-shortcuts/);
  assert.match(styles, /@media\s*\(max-width:\s*520px\)[\s\S]*?\.home-shortcuts/);
});

test('首页原有布局编辑和数据模块未被快捷入口替代', () => {
  for (const marker of ['id="home-grid"', 'id="hg-toolbar"', 'id="today-courses"',
    'id="today-items"', 'id="cal-grid"', 'id="home-week-lessons"', 'id="home-invig-summary"']) {
    assert.ok(home.includes(marker), `首页原有功能节点缺失：${marker}`);
  }
  assert.match(home, /mountGrid\(document\.getElementById\('home-grid'\)\)/);
});
