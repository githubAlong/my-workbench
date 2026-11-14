import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [home, grid, styles, ui, me, wbStyles] = await Promise.all([
  readFile(new URL('../js/home.js', import.meta.url), 'utf8'),
  readFile(new URL('../js/homegrid.js', import.meta.url), 'utf8'),
  readFile(new URL('../css/teacher-ui.css', import.meta.url), 'utf8'),
  readFile(new URL('../js/ui.js', import.meta.url), 'utf8'),
  readFile(new URL('../js/me.js', import.meta.url), 'utf8'),
  readFile(new URL('../css/workbench-unified.css', import.meta.url), 'utf8'),
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

test('天气城市搜索支持县级行政区和完整行政路径', () => {
  assert.match(home, /kw2 \+ '县'/);
  assert.match(home, /kw2 \+ '区'/);
  assert.match(home, /r\.admin1, r\.admin2, r\.admin3, r\.admin4/);
  assert.match(home, /ADM1/);
  assert.match(home, /ADM2/);
  assert.match(home, /ADM3/);
  assert.match(home, /ADM4/);
  assert.match(home, /function cityFullName\(/);
  assert.match(home, /fullName/);
});

test('当前位置定位后保存并显示省市区县完整信息', () => {
  assert.match(home, /async function reverseGeocode\(lat, lon\)/);
  assert.match(home, /return resolvePlace\(lat, lon, \{ previous: state.city \}\)/);
  assert.match(home, /weather-location\.mjs/);
  assert.match(home, /source: 'geo'/);
  assert.match(home, /wxb-location-source/);
  assert.match(home, /使用当前位置定位/);
});

test('城市选择弹窗采用独立的现代化样式并兼容深色主题', () => {
  assert.match(home, /cls: 'weather-city-sheet'/);
  assert.match(home, /weather-city-current/);
  assert.match(home, /weather-city-result/);
  assert.match(styles, /\.sheet\.weather-city-sheet/);
  assert.match(styles, /html\[data-theme="dark"\] \.sheet\.weather-city-sheet/);
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
  assert.doesNotMatch(ui, /id: 'work', label: '工作'/);
  assert.match(ui, /id: 'timetable', label: '课表'/);
  assert.match(ui, /id: 'invigilation', label: '监考'/);
  assert.match(ui, /id: 'me', label: '我的'/);
  assert.match(ui, /seg === 'messages' \\|\\| seg === 'profile'/);
  assert.ok(home.includes("go('work/timetable')"));
});


test('我的个人中心各模块统一为可独立展开和收起的手风琴面板', () => {
  for (const id of ['profile', 'workbench', 'account', 'messages', 'theme', 'wide', 'layout', 'logout']) {
    assert.ok(me.includes(`data-me-accordion="${id}"`), `缺少可折叠模块：${id}`);
  }
  assert.match(me, /details class="me-accordion" data-me-accordion="profile">/);
  assert.doesNotMatch(me, /data-me-accordion="profile"\s+open/);
  assert.match(me, /id="me-identity-toggle"/);
  assert.match(me, /class="me-accordion-chevron"/);
  assert.match(me, /renderProfile\(main\.querySelector\('#me-profile-panel'\), \{ inline: true \}\)/);
  assert.match(me, /renderWorkbenchSettings\(main\.querySelector\('#me-workbench-panel'\), \{ inline: true \}\)/);
  assert.match(me, /renderAccountSettings\(main\.querySelector\('#me-account-panel'\), \{ inline: true \}\)/);
  assert.match(me, /renderMessages\(main\.querySelector\('#me-messages-panel'\), \{ inline: true \}\)/);
  assert.match(me, /function renderProfile\(main, \{ inline = false \} = \{\}\)/);
  assert.match(me, /id="p-avatar-upload"/);
  assert.match(me, /id="p-avatar-remove"/);
  assert.match(wbStyles, /\.me-accordion-head/);
  assert.match(wbStyles, /\.me-accordion\[open\] \.me-accordion-chevron/);
  assert.match(wbStyles, /\.me-identity-card\.is-collapsed/);
});



test('日历默认收起当天安排，点击日期后展开可滚动的24小时时间轴', () => {
  assert.match(home, /dayOpen: false/);
  assert.match(home, /function setCalendarDayOpen\(open\)/);
  assert.match(home, /setCalendarDayOpen\(true\)/);
  assert.match(home, /if \(calState\.dayOpen && calState\.selected\) loadDay\(calState\.selected\)/);
  assert.match(home, /Array\.from\(\{ length: 24 \}/);
  assert.match(home, /data-day-event=/);
  assert.match(home, /id="home-todo-day-title"/);
  assert.match(home, /id="home-course-day-title"/);
  assert.match(home, /home-profile-heading.*个人名片/);
  assert.match(home, /cal-heading-main.*日历/);
  assert.doesNotMatch(home, /function calDayHeaderHTML|data-add-day|cal-day-head/);
  assert.match(home, /24小时 · 上下滑动查看/);
  assert.match(home, /scrollTop = 6 \* 29/);
  assert.match(grid, /export function setTemporaryHeight\(id, minRows = 0\)/);
  assert.match(styles, /\.home-redesign \.home-calendar-card \.cal-day-content\s*\{[\s\S]*?min-height:\s*360px;[\s\S]*?overflow-y:\s*auto;/);
  assert.match(styles, /\.home-redesign \.home-calendar-card \.cal-day\[hidden\]\s*\{\s*display:none!important;/);
  assert.match(styles, /scrollbar-width:\s*thin/);
  assert.match(styles, /flex:1 1 0;[\s\S]*?max-width:none;[\s\S]*?margin:0;/);
});


test('日历重构没有遗留临时替换标记或旧折叠入口', () => {
  assert.doesNotMatch(home, /remove calendar collapse controller/);
  assert.doesNotMatch(home, /cal-collapse|cal-collapse-row|cal-day-toggle/);
  assert.doesNotMatch(home, /dayExpanded|syncHomeDayGridHeight|hg-day-expanded/);
});

test('桌面首页取消1920px最大宽度并铺满侧栏以外的可用空间', () => {
  assert.match(styles, /\.main:has\(#home-grid\)\s*\{\s*max-width:\s*none;/);
  assert.match(styles, /@media\s*\(min-width:\s*1101px\)\s*\{\s*#main\.main:has\(#home-grid\)\s*\{[\s\S]*?flex:\s*1 1 0;[\s\S]*?width:\s*0;[\s\S]*?max-width:\s*none;[\s\S]*?min-width:\s*0;[\s\S]*?margin:\s*0;/);
});


test('首页每日一句喇叭按钮仅向上微调，不改变原有尺寸与定位方式', () => {
  assert.match(styles, /\.home-redesign \.home-quote \.speak-btn\s*\{[^}]*bottom:\s*6px;/s);
  assert.match(styles, /\.home-redesign \.home-quote \.speak-btn\s*\{[^}]*position:\s*absolute;/s);
  assert.match(styles, /\.home-redesign \.home-quote \.speak-btn\s*\{[^}]*width:\s*26px;/s);
  assert.match(styles, /\.home-redesign \.home-quote \.speak-btn\s*\{[^}]*height:\s*26px;/s);
});
