import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [home, grid, styles, ui, me] = await Promise.all([
  readFile(new URL('../js/home.js', import.meta.url), 'utf8'),
  readFile(new URL('../js/homegrid.js', import.meta.url), 'utf8'),
  readFile(new URL('../css/teacher-ui.css', import.meta.url), 'utf8'),
  readFile(new URL('../js/ui.js', import.meta.url), 'utf8'),
  readFile(new URL('../js/me.js', import.meta.url), 'utf8'),
]);

test('精简首页只保留五张核心卡片的页面结构', () => {
  for (const id of ['profile', 'todayCourse', 'todayTodo', 'weather', 'calendar']) {
    assert.ok(home.includes(`data-hcard="${id}"`), `缺少核心卡片：${id}`);
  }
  assert.doesNotMatch(home, /class="home-shortcut"/);
  assert.match(home, /id="greet-line"/);
  assert.match(home, /id="clock-date"/);
  assert.match(home, /id="clock"/);
});

test('首页个人卡片右上角保留外观与编辑布局图标入口', () => {
  assert.match(home, /id="gsearch"/);
  const actionsStart = home.indexOf('<div class="home-profile-actions"');
  const actionsEnd = home.indexOf('</div>', actionsStart);
  const actions = home.slice(actionsStart, actionsEnd);
  assert.ok(actions.includes('id="theme-btn"'));
  assert.ok(actions.includes('id="teacher-layout"'));
  assert.ok(actions.indexOf('id="teacher-layout"') > actions.indexOf('id="theme-btn"'));
  assert.doesNotMatch(home, /class="home-top-actions"/);
  assert.doesNotMatch(home, /id="home-new-timetable"/);
  assert.doesNotMatch(home, /home-side-layout-edit/);
  assert.doesNotMatch(home, /q\('#home-new-timetable'\)/);
  assert.doesNotMatch(home, /id="home-new-invig"/);
  assert.doesNotMatch(home, /id="home-calendar-view"/);
});



test('天气卡保留城市切换、刷新和详细天气入口', () => {
  assert.match(home, /id="wx-card"/);
  assert.match(home, /data-pick-city/);
  assert.match(home, /data-wx-refresh/);
  assert.match(home, /id="wx-more"/);
  assert.match(home, /function weatherBriefHTML\(/);
  assert.match(home, /function openWeatherSheet\(/);
});

test('课程、待办和日历保留真实业务渲染节点与联动', () => {
  for (const marker of ['id="today-courses"', 'id="today-items"', 'id="cal-grid"',
    'id="cal-prev"', 'id="cal-next"', 'id="cal-today"']) {
    assert.ok(home.includes(marker), `缺少业务节点：${marker}`);
  }
  assert.match(home, /function renderTodayCourses\(/);
  assert.match(home, /function renderTodayItems\(/);
  assert.match(home, /function paintCal\(/);
  assert.match(home, /syncDay\(/);
});

test('V6 默认布局按参考图排列六张核心卡片，其余卡片仍可管理恢复', () => {
  assert.match(grid, /version:\s*6,/);
  assert.match(grid, /const DEFAULT_HIDDEN = \['weekLessons', 'invigilation', 'prepDeadline', 'recentNotes'\]/);
  assert.match(grid, /hidden:\s*\[\.\.\.DEFAULT_HIDDEN\]/);
  for (const id of ['profile', 'todayCourse', 'todayTodo', 'weather', 'calendar']) {
    assert.ok(grid.includes(`['${id}'`), `默认布局缺少：${id}`);
  }
  for (const id of ['timeline', 'weekLessons', 'invigilation', 'prepDeadline', 'recentNotes']) {
    assert.ok(grid.includes(`{ id: '${id}'`), `卡片管理中未保留：${id}`);
  }
});

test('旧布局迁移到 V6 时保留用户隐藏偏好且默认隐藏辅助卡片', () => {
  assert.match(grid, /if\s*\(rawVersion\s*<\s*6\)/);
  assert.match(grid, /\.\.\.DEFAULT_HIDDEN/);
  assert.match(grid, /raw\.breakpoints\.desktop\?\.hidden/);
  assert.match(grid, /out\.version = 6;/);
  assert.match(grid, /不触碰课程、事项、天气/);
});

test('精简首页在桌面、平板和手机使用响应式布局', () => {
  assert.match(styles, /首页参考图布局/);
  assert.match(styles, /\.home-redesign #home-grid\s*\{[\s\S]*?grid-template-columns:\s*repeat\(12/);
  assert.match(styles, /@media\(max-width:900px\)/);
  assert.match(styles, /@media\(max-width:640px\)/);
  assert.match(styles, /home-weather-card/);
});

test('首页布局编辑入口位于顶栏且卡片管理仍然可用', () => {
  assert.match(home, /id="teacher-layout"/);
  assert.match(home, /id="hg-toolbar"/);
  assert.match(home, /mountGrid\(document\.getElementById\('home-grid'\)\)/);
  assert.match(grid, /function openManager\(/);
  assert.match(grid, /function saveEdit\(/);
  assert.match(grid, /function resetAll\(/);
});

test('首页保留的工作与个人中心导航目标已注册', () => {
  assert.match(ui, /id: 'work', label: '工作'/);
  assert.match(ui, /id: 'timetable', label: '课表'/);
  assert.match(ui, /id: 'invigilation', label: '监考'/);
  assert.match(ui, /id: 'me', label: '我的'/);
  assert.match(ui, /seg === 'messages' \\|\\| seg === 'profile'/);
  assert.ok(home.includes("go('work/timetable')"));
});


test('我的个人中心统一收纳侧栏底部工具并移除重复分组', () => {
  for (const id of ['side-theme', 'side-wide', 'side-layout']) {
    assert.doesNotMatch(ui, new RegExp('id="' + id + '"'), `侧栏不应再显示独立入口：${id}`);
  }
  assert.match(ui, /id="side-user"/);
  assert.match(ui, /export function isWideMode\(/);
  assert.match(ui, /export function setWideMode\(/);

  assert.match(me, /me-home-settings-unified/);
  assert.equal(me.includes('<h2>个人设置</h2>'), false);
  assert.equal(me.includes('<h2>消息与偏好</h2>'), false);
  for (const marker of [
    "row('user', '个人信息'",
    "row('bell', '消息中心'",
    "row('sun', '主题外观'",
    "row('expand', '平铺整页'",
    "row('grid', '重置首页布局'",
  ]) assert.ok(me.includes(marker), `「我的」页面缺少统一设置入口：${marker}`);
  assert.match(me, /id="me-theme-value"/);
  assert.match(me, /id="me-wide-value"/);
  assert.match(me, /setWideMode\(!isWideMode\(\)\)/);
  assert.match(me, /restoreHomeLayout/);
});

test('日历选择日期会同步真实事项、课程，并显示完整24小时时间轴', () => {
  assert.match(home, /function renderHomeDayPanels\(/);
  assert.match(home, /function renderTodayItems\(rowsOverride = null, dateOverride = ''\)/);
  assert.match(home, /function renderTodayCourses\(coursesOverride = null, lessonsOverride = null, dateOverride = ''\)/);
  assert.match(home, /Array\.from\(\{ length: 24 \}/);
  assert.match(home, /data-day-event=/);
  assert.match(home, /id="home-todo-day-title"/);
  assert.match(home, /id="home-course-day-title"/);
  assert.match(home, /title\.textContent = `\$\{y\}年\$\{pad2\(m\)\}月`/);
  assert.match(styles, /cal-day-hour-row/);
  assert.match(styles, /hg-day-expanded/);
  assert.match(styles, /flex:1 1 0;[\s\S]*?max-width:none;[\s\S]*?margin:0;/);
});


test('桌面首页取消1920px最大宽度并铺满侧栏以外的可用空间', () => {
  assert.match(styles, /\.main:has\(#home-grid\)\s*\{\s*max-width:\s*none;/);
  assert.match(styles, /@media\s*\(min-width:\s*1101px\)\s*\{\s*#main\.main:has\(#home-grid\)\s*\{[\s\S]*?flex:\s*1 1 0;[\s\S]*?width:\s*0;[\s\S]*?max-width:\s*none;[\s\S]*?min-width:\s*0;[\s\S]*?margin:\s*0;/);
});
