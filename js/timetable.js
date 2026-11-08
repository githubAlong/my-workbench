import { api, el, esc, toast, sheet, saving, confirmDialog, WD_SHORT, ymd } from './core.js';
import { state, icon, onViewLeave } from './ui.js';
import { detectTimetable } from './ttimage.js';
import { readXlsx, readDelimited } from './xlsx-lite.js';
import { cleanPeriodTime, getCanonicalPeriodNumber, normalizeTimetablePeriods } from './timetable-periods.mjs';

const DAYS = [1, 2, 3, 4, 5, 6, 0];
const DAY_NAMES = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const TYPE_SUMMER = '夏令时课表';
const TYPE_WINTER = '冬令时课表';
const VIEW_KEY = 'wb_timetable_view_v1';

function parseJson(value, fallback = {}) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(String(value || '')); } catch { return fallback; }
}
function timeMinutes(value) {
  const m = String(value || '').trim().match(/^(\d{1,2}):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
function normalizeTime(value) {
  const m = String(value || '').trim().match(/^(\d{1,2})[:：](\d{2})$/);
  if (!m) return '';
  const h = Number(m[1]), min = Number(m[2]);
  if (h > 23 || min > 59) return '';
  return String(h).padStart(2, '0') + ':' + String(min).padStart(2, '0');
}
function parseWeekday(value) {
  const s = String(value || '').trim();
  const m = s.match(/(?:周|星期)\s*([一二三四五六日天1-7])/);
  if (m) {
    const map = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 0 };
    return map[m[1]];
  }
  if (/^[1-7]$/.test(s)) return Number(s) === 7 ? 0 : Number(s);
  if (s === '星期天' || s === '周天') return 0;
  return null;
}
function parseTimeRange(value) {
  const m = String(value || '').match(/(\d{1,2})[:：](\d{2})\s*[-–—~至]\s*(\d{1,2})[:：](\d{2})/);
  if (!m) return null;
  return [normalizeTime(m[1] + ':' + m[2]), normalizeTime(m[3] + ':' + m[4])];
}
function parsePeriodNumber(value) {
  const s = String(value || '').trim();
  const late = { 晚一: 10, 晚二: 11, 晚三: 12, 晚四: 13 };
  for (const [key, number] of Object.entries(late)) if (s.startsWith(key)) return number;
  const digits = s.match(/\d{1,2}/);
  if (digits) return Number(digits[0]);
  const cn = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  const m = s.match(/第?([一二三四五六七八九十])/);
  return m ? (cn[m[1]] || 0) : 0;
}
function gradeFromText(value) {
  return (String(value || '').match(/高[一二三]/) || [])[0] || '';
}
function classFromText(value, grade) {
  const s = String(value || '').replace(/\s+/g, ' ').trim();
  const m = s.match(/(?:高[一二三]\s*)?\d{1,2}\s*班|全年级|全体/);
  let result = m ? m[0].replace(/\s+/g, '') : '';
  if (!result && /^\d{1,2}$/.test(s)) result = s + '班';
  if (result && grade && !result.startsWith(grade) && /^\d{1,2}班$/.test(result)) result = grade + result;
  return result;
}
function gradeClass(grade, className) {
  const g = String(grade || '').trim();
  const c = String(className || '').trim();
  if (!g || g === '全部' || g === '全体') return c;
  if (!c) return g;
  return c.startsWith(g) ? c : g + c;
}
function isCourseActiveToday(course, date) {
  if (course.start_date && date < String(course.start_date).slice(0, 10)) return false;
  if (course.end_date && date > String(course.end_date).slice(0, 10)) return false;
  return true;
}
function typeOfCourse(course, courseTypes) {
  return courseTypes[String(course.id)] || TYPE_SUMMER;
}
function visibleByGrade(course, grade) {
  if (grade === '全部') return true;
  const value = String(course.grade || '').trim();
  return value === grade || value === '全部' || value === '全体';
}
function courseKey(course) {
  return [course.weekday, course.period_no, course.grade, course.class_name, course.subject].map((x) => String(x || '').trim().toLowerCase()).join('|');
}
function periodOrder(period) {
  return getCanonicalPeriodNumber(period) ?? 0;
}
function samePeriodName(a, b) {
  const left = String(a || '').trim();
  const right = String(b || '').trim();
  if (!left || !right) return false;
  if (left === right) return true;
  if (left.includes('午休') || right.includes('午休')) return left.includes('午休') && right.includes('午休');
  return periodOrder({ name: left }) > 0 && periodOrder({ name: left }) === periodOrder({ name: right });
}
function sortPeriods(periods) {
  return [...periods].sort((a, b) => {
    const orderDiff = periodOrder(a) - periodOrder(b);
    if (orderDiff) return orderDiff;
    const am = timeMinutes(a.start_time), bm = timeMinutes(b.start_time);
    if (am != null && bm != null && am !== bm) return am - bm;
    return Number(a.period_no) - Number(b.period_no);
  });
}
function formatDate(date) {
  const d = date || new Date();
  return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日';
}
function formatClockMinutes(value) {
  const minutes = Number(value);
  return String(Math.floor(minutes / 60)).padStart(2, '0') + ':' + String(minutes % 60).padStart(2, '0');
}
function countdownText(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
}
const SUMMER_PERIOD_TIMES = {
  0: ['07:00', '07:50'], 1: ['08:00', '08:45'], 2: ['08:55', '09:40'],
  3: ['09:50', '10:35'], 4: ['10:55', '11:40'], 5: ['14:10', '14:55'],
  6: ['15:05', '15:50'], 7: ['16:00', '16:45'], 8: ['16:55', '17:40'],
  9: ['17:50', '18:35'], 10: ['19:00', '19:45'],
};
const WINTER_PERIOD_TIMES = {
  0: ['07:20', '08:00'], 1: ['08:00', '08:40'], 2: ['08:50', '09:30'], 3: ['10:00', '10:40'],
  4: ['10:50', '11:30'], 5: ['11:40', '12:20'], 6: ['14:10', '14:50'],
  7: ['15:20', '16:00'], 8: ['16:15', '16:55'], 9: ['17:05', '17:45'],
  10: ['19:10', '19:55'],
};
function periodDefaults(number, scheduleType) {
  const map = scheduleType === TYPE_WINTER ? WINTER_PERIOD_TIMES : SUMMER_PERIOD_TIMES;
  if (number === 5.5) return ['12:20', '14:10'];
  return map[number] || [];
}
function periodName(period) {
  const name = String(period?.name || '').trim();
  const number = getCanonicalPeriodNumber(period);
  if (number === 0) return '早自习';
  if (number === 5.5) return '午休';
  if (number === 10) return name || '晚一';
  const labels = ['', '第一节', '第二节', '第三节', '第四节', '第五节', '第六节', '第七节', '第八节', '第九节'];
  if (number >= 1 && number <= 9) return labels[number];
  return name;
}
function courseTime(course, period, periodTimes, scheduleType) {
  const periodNo = getCanonicalPeriodNumber(course) ?? getCanonicalPeriodNumber(period);
  const override = periodTimes?.[scheduleType]?.[String(periodNo)] || {};
  const fallback = scheduleType === TYPE_WINTER ? WINTER_PERIOD_TIMES[periodNo] || [] : [];
  const start = cleanPeriodTime(override.start_time) || cleanPeriodTime(course?.start_time) || cleanPeriodTime(period?.start_time) || fallback[0] || '';
  const end = cleanPeriodTime(override.end_time) || cleanPeriodTime(course?.end_time) || cleanPeriodTime(period?.end_time) || fallback[1] || '';
  return start && end ? start + '–' + end : (start || end || '时间待设置');
}
function gradeClassName(grade) {
  if (String(grade || '').includes('高二')) return 'tt-grade-2';
  if (String(grade || '').includes('高三')) return 'tt-grade-3';
  if (String(grade || '').includes('高一')) return 'tt-grade-1';
  return 'tt-grade-all';
}
function loadViewPreference() {
  try {
    const saved = JSON.parse(localStorage.getItem(VIEW_KEY) || '{}');
    return {
      type: saved.type === TYPE_WINTER ? TYPE_WINTER : TYPE_SUMMER,
      grade: ['全部', '高一', '高二', '高三'].includes(saved.grade) ? saved.grade : '全部',
    };
  } catch {
    return { type: TYPE_SUMMER, grade: '全部' };
  }
}
function saveViewPreference(type, grade) {
  try { localStorage.setItem(VIEW_KEY, JSON.stringify({ type, grade })); } catch { }
}

export async function renderTimetable(box) {
  let allCourses = [];
  let allPeriods = [];
  let settings = {};
  let courseTypes = {};
  let periodTimes = {};
  let periodDefinitions = {};
  let appliedType = loadViewPreference().type;
  let appliedGrade = loadViewPreference().grade;
  let clockTimer = null;
  let lastDate = ymd();
  let loading = false;

  const loadingHtml = '<section class="tt-workspace"><div class="tt-state"><span class="tt-spinner"></span><b>正在加载课表…</b><span>正在读取课程和节次安排</span></div></section>';
  const errorHtml = (message) => '<section class="tt-workspace"><div class="tt-state tt-state-error"><b>课表加载失败</b><span>' + esc(message || '请检查网络后重试') + '</span><button class="btn primary sm" id="tt-retry">重新加载</button></div></section>';

  async function saveTimetablePrefs(patch) {
    const me = await api.get('/me').catch(() => ({ settings: settings || {} }));
    const current = parseJson(me?.settings, {});
    const timetable = { ...parseJson(current.timetable, {}), ...patch };
    const nextSettings = { ...current, timetable };
    await api.patch('/me', { settings: nextSettings });
    settings = nextSettings;
    courseTypes = parseJson(timetable.courseTypes, {});
    periodTimes = parseJson(timetable.periodTimes, {});
    periodDefinitions = parseJson(timetable.periodDefinitions, {});
  }

  async function loadData(showLoading = true) {
    if (loading) return;
    loading = true;
    if (showLoading) box.innerHTML = loadingHtml;
    try {
      const results = await Promise.all([
        api.get('/courses'),
        api.get('/periods'),
        api.get('/me').catch(() => ({ settings: {} })),
      ]);
      settings = parseJson(results[2]?.settings, {});
      const timetable = parseJson(settings.timetable, {});
      courseTypes = parseJson(timetable.courseTypes, {});
      periodTimes = parseJson(timetable.periodTimes, {});
      periodDefinitions = parseJson(timetable.periodDefinitions, {});
      const periodOptions = { periodTimes, scheduleType: appliedType };
      const rawCourses = Array.isArray(results[0]) ? results[0] : [];
      allCourses = rawCourses.map((course) => {
        const number = getCanonicalPeriodNumber(course, periodOptions);
        return {
          ...course,
          ...(number == null ? {} : { period_no: number }),
          start_time: cleanPeriodTime(course.start_time),
          end_time: cleanPeriodTime(course.end_time),
        };
      });
      allPeriods = normalizeTimetablePeriods(Array.isArray(results[1]) ? results[1] : [], periodOptions);
      paint();
    } catch (error) {
      box.innerHTML = errorHtml(error?.message || '课表数据加载失败');
      box.querySelector('#tt-retry')?.addEventListener('click', () => loadData(true));
    } finally {
      loading = false;
    }
  }

  function getVisibleCourses() {
    return allCourses.filter((course) =>
      typeOfCourse(course, courseTypes) === appliedType && visibleByGrade(course, appliedGrade)
    );
  }

  function getPeriods(visibleCourses) {
    const key = appliedType + "|" + appliedGrade;
    const configured = periodDefinitions[key];
    if (Array.isArray(configured) && configured.length) {
      return [...configured].sort((a, b) => Number(a.order) - Number(b.order)).map((item) => ({
        id: item.id || "custom-" + item.period_no,
        period_no: Number(item.period_no),
        name: String(item.name || ("第" + item.period_no + "节")),
        start_time: cleanPeriodTime(item.start_time),
        end_time: cleanPeriodTime(item.end_time),
      }));
    }
    const byNo = new Map(allPeriods.map((period) => [Number(period.period_no), period]));
    for (const number of [0, 1, 2, 3, 4, 5, 5.5, 6, 7, 8, 9]) {
      if (byNo.has(number)) continue;
      const fallback = periodDefaults(number, appliedType);
      byNo.set(number, {
        id: "fallback-" + number, period_no: number,
        name: periodName({ period_no: number }), start_time: fallback[0] || "", end_time: fallback[1] || "",
      });
    }
    return sortPeriods([...byNo.values()].filter((period) => [0, 1, 2, 3, 4, 5, 5.5, 6, 7, 8, 9, 10].includes(Number(period.period_no))));
  }

  function currentLesson(courses) {
    const today = new Date();
    const date = ymd(today);
    const day = today.getDay();
    const now = today.getHours() * 60 + today.getMinutes();
    const todayCourses = courses.filter((course) =>
      Number(course.weekday) === day && isCourseActiveToday(course, date)
    ).map((course) => {
      const period = allPeriods.find((item) => Number(item.period_no) === Number(course.period_no));
      const range = courseTime(course, period, periodTimes, appliedType);
      const [start, end] = range.split('–').map(timeMinutes);
      return { course, period, start, end };
    }).filter((item) => item.start != null && item.end != null)
      .sort((a, b) => a.start - b.start);
    const current = todayCourses.find((item) => now >= item.start && now < item.end);
    const next = todayCourses.find((item) => item.start > now);
    return { todayCourses, current, next, now };
  }

  function reminderHtml(courses) {
    const now = new Date();
    const info = currentLesson(courses);
    const weekday = '周' + WD_SHORT[now.getDay()];
    let mode = 'free';
    let title = '今日无课，可安心备课/处理事务';
    let desc = '今天没有安排课程，适合备课、处理事务或休息';
    let target = null;
    let label = '今日课程安排';
    if (info.current) {
      mode = 'class';
      const c = info.current.course;
      const grade = gradeClass(c.grade, c.class_name);
      const nextText = info.next
        ? '下一节课：' + (info.next.course.subject || '课程') + '（' + gradeClass(info.next.course.grade, info.next.course.class_name) + '）' + formatClockMinutes(info.next.start) + '开始'
        : '本节课结束后，今日课程安排已完成';
      title = '当前正在上课：' + (c.subject || '课程') + (grade ? '（' + grade + '）' : '');
      desc = (info.current.period ? periodName(info.current.period) : '当前课程') + ' ' + courseTime(c, info.current.period, periodTimes, appliedType) + (info.next ? ' ｜ ' + nextText : ' ｜ ' + nextText);
      target = info.next ? new Date(now.getFullYear(), now.getMonth(), now.getDate(), Math.floor(info.next.start / 60), info.next.start % 60) : new Date(now.getFullYear(), now.getMonth(), now.getDate(), Math.floor(info.current.end / 60), info.current.end % 60);
      label = info.next ? '距离下节课' : '距离本节课下课';
    } else if (info.next) {
      mode = 'class';
      const c = info.next.course;
      title = '距离' + (c.subject || '课程') + '还有一段时间';
      desc = (info.next.period ? periodName(info.next.period) : '下一节') + ' · ' + gradeClass(c.grade, c.class_name) + ' · ' + courseTime(c, info.next.period, periodTimes, appliedType);
      target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), Math.floor(info.next.start / 60), info.next.start % 60);
      label = '距离下一节课';
    }
    const countdown = target ? countdownText(target.getTime() - now.getTime()) : '—';
    return '<div class="tt-reminder ' + mode + '" id="tt-reminder-card">' +
      '<div class="tt-reminder-date"><div class="tt-reminder-weekday">' + weekday + '</div><div class="tt-reminder-date-text">' + formatDate(now) + '</div></div>' +
      '<div class="tt-reminder-status"><div class="tt-reminder-title">' + esc(title) + '</div><div class="tt-reminder-desc">' + esc(desc) + '</div></div>' +
      '<div class="tt-reminder-countdown"><div class="tt-reminder-number" id="tt-reminder-number">' + countdown + '</div><div class="tt-reminder-label" id="tt-reminder-label">' + label + '</div></div>' +
      '</div>';
  }

  function renderCourse(course, period) {
    const time = courseTime(course, period, periodTimes, appliedType);
    const grade = String(course.grade || '全部');
    const className = gradeClass(grade, course.class_name);
    const isLunch = String(course.subject || '').includes('午休') || String(period?.name || '').includes('午休');
    return '<div class="tt-course-block ' + gradeClassName(grade) + (isLunch ? ' tt-course-lunch' : '') + '" draggable="true" data-course-id="' + esc(course.id) + '" title="' + esc((course.subject || '课程') + ' · ' + className + ' · ' + time) + '">' +
      '<div class="tt-course-actions">' +
        '<button class="tt-course-action" type="button" data-edit-course="' + esc(course.id) + '" aria-label="编辑课程" title="编辑">' + icon('edit', 12) + '</button>' +
        '<button class="tt-course-action danger" type="button" data-delete-course="' + esc(course.id) + '" aria-label="删除课程" title="删除">' + icon('trash', 12) + '</button>' +
      '</div>' +
      '<span class="tt-grade-tag ' + gradeClassName(grade) + '">' + esc(grade) + '</span>' +
      '<strong class="tt-course-subject">' + esc(course.subject || '未命名课程') + '</strong>' +
      '<span class="tt-course-class">' + esc(className || '班级待填写') + '</span>' +
      '<span class="tt-course-time">' + esc(time) + '</span>' +
      '</div>';
  }

  function gridHtml(courses, periods) {
    if (!periods.length) return '<div class="tt-state"><b>还没有设置上课节次</b><span>新增课程时输入节次名称即可自动创建。</span></div>';
    const rows = periods.map((period) => {
      const pNo = Number(period.period_no);
      const rowCourses = courses.filter((course) => getCanonicalPeriodNumber(course) === pNo);
      const firstCourse = rowCourses.find((course) => course.start_time || course.end_time) || {};
      const time = courseTime({ ...firstCourse, period_no: pNo }, period, periodTimes, appliedType);
      const cells = DAYS.map((day) => {
        const list = rowCourses.filter((course) => Number(course.weekday) === day);
        return '<td class="tt-slot ' + (list.length ? 'has-course' : 'is-empty') + '" data-slot="1" data-day="' + day + '" data-period="' + pNo + '">' +
          (list.length ? list.map((course) => renderCourse(course, period)).join('') : '<button class="tt-empty-add" type="button" aria-label="新增课程">＋</button>') +
          '</td>';
      }).join('');
      return '<tr><td class="tt-period-cell"><strong>' + esc(periodName(period)) + '</strong><span>' + esc(time || '时间待设置') + '</span></td>' + cells + '</tr>';
    }).join('');
    return '<div class="tt-grid-scroll"><table class="tt-grid-table tt-week-grid" aria-label="周课表">' +
      '<colgroup><col class="tt-col-period">' + DAYS.map(() => '<col class="tt-col-day">').join('') + '</colgroup>' +
      '<thead><tr><th class="tt-grid-corner">节次 / 时间</th>' + DAYS.map((day) => '<th class="tt-weekday-head ' + (day === new Date().getDay() ? 'is-today' : '') + '">' + DAY_NAMES[DAYS.indexOf(day)] + '</th>').join('') + '</tr></thead>' +
      '<tbody>' + rows + '</tbody></table></div>';
  }

  function paint() {
    const visible = getVisibleCourses();
    const periods = getPeriods(visible);
    const empty = visible.length === 0;
    const currentLabel = appliedGrade === '全部' ? '全部年级总课表' : appliedGrade + '课表';
    box.innerHTML = '<section class="tt-workspace" aria-label="我的课表">' +
      '<div class="tt-workspace-head"><div class="tt-workspace-title-wrap"><h2 class="tt-workspace-title">我的课表</h2></div>' +
      '<div class="tt-toolbar-actions">' +
        '<button class="btn ghost sm" type="button" id="tt-export">' + icon('download', 14) + ' 导出课表</button>' +
        '<button class="btn ghost sm" type="button" id="tt-import">' + icon('upload', 14) + ' 导入课表</button>' +
        (appliedType === TYPE_WINTER && appliedGrade === '高二' ? '<button class="btn ghost sm" type="button" id="tt-import-high2">导入2026秋季高二课表</button>' : '') +
        '<button class="btn ghost sm" type="button" id="tt-period-settings">作息设置</button>' +
        '<button class="btn primary sm" type="button" id="tt-add">' + icon('plus', 14) + ' 新增课程</button>' +
      '</div></div>' +
      reminderHtml(visible) +
      '<div class="tt-query-bar">' +
        '<label class="tt-query-item"><span>课表类型</span><select id="tt-type"><option value="' + TYPE_SUMMER + '"' + (appliedType === TYPE_SUMMER ? ' selected' : '') + '>' + TYPE_SUMMER + '</option><option value="' + TYPE_WINTER + '"' + (appliedType === TYPE_WINTER ? ' selected' : '') + '>' + TYPE_WINTER + '</option></select></label>' +
        '<label class="tt-query-item"><span>所属年级</span><select id="tt-grade"><option value="全部"' + (appliedGrade === '全部' ? ' selected' : '') + '>全部（跨年级总课表）</option><option value="高一"' + (appliedGrade === '高一' ? ' selected' : '') + '>高一</option><option value="高二"' + (appliedGrade === '高二' ? ' selected' : '') + '>高二</option><option value="高三"' + (appliedGrade === '高三' ? ' selected' : '') + '>高三</option></select></label>' +
        '<button class="btn primary" type="button" id="tt-confirm">确认查看课表</button>' +
      '</div>' +
      '<div class="tt-current-tag">当前查看：<b>' + esc(appliedType + ' - ' + currentLabel) + '</b></div>' +
      (empty ? '<div class="tt-empty-state"><div class="tt-empty-icon">' + icon('cal', 24) + '</div><b>当前课表还没有课程</b><span>可以新增课程，或导入教务处提供的课表。</span><button class="btn primary sm" type="button" id="tt-empty-add">新增第一门课程</button></div>' : '') +
      gridHtml(visible, periods) +
      '<div class="tt-summary-bar"><span>当前课表共 ' + visible.length + ' 节课程</span><span>课程数据在本机保存，并通过工作台现有云同步机制同步到其他设备</span></div>' +
      '</section>';
    bind(visible, periods);
    updateClock(visible);
  }

  function updateClock(visible) {
    const card = box.querySelector('#tt-reminder-card');
    if (!card) return;
    const html = reminderHtml(visible);
    const holder = el(html);
    card.className = holder.className;
    card.innerHTML = holder.innerHTML;
    const nowId = currentLesson(visible).current?.course?.id;
    box.querySelectorAll('.tt-course-block').forEach((block) => {
      block.classList.toggle('now', String(block.dataset.courseId) === String(nowId || ''));
    });
  }

  async function moveCourse(courseId, targetDay, targetPeriod, visible) {
    const source = allCourses.find((item) => String(item.id) === String(courseId));
    if (!source) return;
    const oldDay = Number(source.weekday), oldPeriod = Number(source.period_no);
    if (oldDay === targetDay && oldPeriod === targetPeriod) return;
    const target = visible.find((item) => Number(item.weekday) === targetDay && Number(item.period_no) === targetPeriod);
    const targetPeriodRow = allPeriods.find((item) => Number(item.period_no) === targetPeriod) || {};
    const oldPeriodRow = allPeriods.find((item) => Number(item.period_no) === oldPeriod) || {};
    const targetOverride = periodTimes?.[appliedType]?.[String(targetPeriod)] || {};
    const oldOverride = periodTimes?.[appliedType]?.[String(oldPeriod)] || {};
    const sourcePatch = {
      weekday: target ? Number(target.weekday) : targetDay,
      period_no: target ? Number(target.period_no) : targetPeriod,
      start_time: target ? (target.start_time || targetOverride.start_time || targetPeriodRow.start_time || '') : (targetOverride.start_time || targetPeriodRow.start_time || ''),
      end_time: target ? (target.end_time || targetOverride.end_time || targetPeriodRow.end_time || '') : (targetOverride.end_time || targetPeriodRow.end_time || ''),
    };
    const targetPatch = target ? {
      weekday: oldDay,
      period_no: oldPeriod,
      start_time: source.start_time || oldOverride.start_time || oldPeriodRow.start_time || '',
      end_time: source.end_time || oldOverride.end_time || oldPeriodRow.end_time || '',
    } : null;
    let targetUpdated = false;
    try {
      if (target && target.id !== source.id) {
        await api.patch('/courses/' + target.id, targetPatch);
        targetUpdated = true;
      }
      await api.patch('/courses/' + source.id, sourcePatch);
      toast(target ? '已交换两门课程的位置' : '课程已移动');
      await loadData(false);
    } catch (error) {
      if (target && targetUpdated) {
        await api.patch('/courses/' + target.id, {
          weekday: Number(target.weekday), period_no: Number(target.period_no),
          start_time: target.start_time || '', end_time: target.end_time || '',
        }).catch(() => {});
      }
      toast(error?.message || '拖动失败，原课表未完成更新', 'err');
      await loadData(false);
    }
  }

  function openPeriodSettings() {
    const key = appliedType + "|" + appliedGrade;
    const base = Array.isArray(periodDefinitions[key]) ? periodDefinitions[key] : getPeriods(getVisibleCourses()).map((p, index) => ({
      id: p.id, period_no: Number(p.period_no), name: p.name,
      start_time: p.start_time || "", end_time: p.end_time || "", order: index,
    }));
    let rows = base.map((p, index) => ({ ...p, order: index }));
    const body = el('<div class="sheet-body"><p class="small muted">当前设置：' + esc(appliedType + " · " + appliedGrade) + '。可新增、修改、删除和调整节次顺序。存在课程的节次不能删除。</p><div id="tt-period-rows"></div><div class="confirm-actions"><button class="btn ghost" id="tt-period-add">新增时间段</button><button class="btn ghost" id="tt-period-cancel">取消</button><button class="btn primary" id="tt-period-save">保存作息</button></div></div>');
    const modal = sheet({ title: "作息时间管理", body, wide: true });
    const list = body.querySelector("#tt-period-rows");
    const draw = () => {
      list.innerHTML = rows.map((p, i) => '<div class="tt-period-editor-row" data-row="' + i + '">' +
        '<input class="input" data-field="name" aria-label="节次名称" value="' + esc(p.name) + '" placeholder="节次名称">' +
        '<input class="input" data-field="start_time" aria-label="开始时间" value="' + esc(p.start_time) + '" placeholder="08:00">' +
        '<input class="input" data-field="end_time" aria-label="结束时间" value="' + esc(p.end_time) + '" placeholder="08:40">' +
        '<button class="btn ghost sm" data-up="' + i + '" type="button">↑</button><button class="btn ghost sm" data-down="' + i + '" type="button">↓</button><button class="btn ghost danger sm" data-remove="' + i + '" type="button">删除</button></div>').join("");
      list.querySelectorAll("[data-field]").forEach((input) => input.addEventListener("change", () => {
        const row = Number(input.closest("[data-row]").dataset.row);
        rows[row][input.dataset.field] = input.value.trim();
      }));
      list.querySelectorAll("[data-up]").forEach((button) => button.onclick = () => {
        const i = Number(button.dataset.up); if (i <= 0) return;
        [rows[i - 1], rows[i]] = [rows[i], rows[i - 1]]; draw();
      });
      list.querySelectorAll("[data-down]").forEach((button) => button.onclick = () => {
        const i = Number(button.dataset.down); if (i >= rows.length - 1) return;
        [rows[i + 1], rows[i]] = [rows[i], rows[i + 1]]; draw();
      });
      list.querySelectorAll("[data-remove]").forEach((button) => button.onclick = () => {
        const i = Number(button.dataset.remove), no = Number(rows[i].period_no);
        if (allCourses.some((c) => typeOfCourse(c, courseTypes) === appliedType && visibleByGrade(c, appliedGrade) && Number(c.period_no) === no)) {
          toast("该节次已有课程，请先调整或删除相关课程", "warn"); return;
        }
        rows.splice(i, 1); draw();
      });
    };
    draw();
    body.querySelector("#tt-period-add").onclick = () => {
      const used = new Set(rows.map((p) => Number(p.period_no)));
      let no = 1; while (used.has(no)) no++;
      rows.push({ id: "custom-" + no, period_no: no, name: "第" + no + "节", start_time: "", end_time: "", order: rows.length }); draw();
    };
    body.querySelector("#tt-period-cancel").onclick = modal.close;
    saving(body.querySelector("#tt-period-save"), async () => {
      rows = rows.map((p, i) => ({ ...p, order: i, period_no: Number(p.period_no) }));
      const seen = new Set();
      for (const p of rows) {
        if (!p.name) throw new Error("请填写所有节次名称");
        if (!p.start_time || !p.end_time || !normalizeTime(p.start_time) || !normalizeTime(p.end_time)) throw new Error("请填写有效的开始和结束时间");
        if (timeMinutes(p.end_time) <= timeMinutes(p.start_time)) throw new Error("结束时间必须晚于开始时间");
        if (seen.has(p.period_no)) throw new Error("节次编号重复，请检查");
        seen.add(p.period_no);
      }
      const nextDefs = { ...periodDefinitions, [key]: rows };
      const nextTimes = { ...periodTimes, [appliedType]: { ...(periodTimes?.[appliedType] || {}) } };
      rows.forEach((p) => { nextTimes[appliedType][String(p.period_no)] = { start_time: normalizeTime(p.start_time), end_time: normalizeTime(p.end_time) }; });
      await saveTimetablePrefs({ periodDefinitions: nextDefs, periodTimes: nextTimes });
      modal.close(); toast("作息时间已保存"); await loadData(false);
    });
  }

  async function importHigh2Winter() {
    const key = TYPE_WINTER + "|高二";
    const schedule = [
      { weekday: 3, period_no: 1, class_name: "11班" },
      { weekday: 5, period_no: 1, class_name: "13班" },
      { weekday: 1, period_no: 3, class_name: "5班" },
      { weekday: 3, period_no: 3, class_name: "12班" },
      { weekday: 1, period_no: 5, class_name: "7班" },
      { weekday: 2, period_no: 5, class_name: "6班" },
      { weekday: 4, period_no: 5, class_name: "10班" },
      { weekday: 4, period_no: 6, class_name: "9班" },
      { weekday: 4, period_no: 7, class_name: "16班" },
      { weekday: 2, period_no: 9, class_name: "15班" },
      { weekday: 3, period_no: 9, class_name: "8班" },
      { weekday: 4, period_no: 9, class_name: "14班" },
      { weekday: 5, period_no: 9, class_name: "18班" },
    ];
    const times = {
      1:["08:00","08:40"], 2:["08:50","09:30"], 3:["10:00","10:40"],
      4:["10:50","11:30"], 5:["11:40","12:20"], 5.5:["12:20","14:10"],
      6:["14:10","14:50"], 7:["15:20","16:00"], 8:["16:15","16:55"],
      9:["17:05","17:45"], 10:["18:25","18:40"], 11:["19:30","20:10"],
      12:["20:20","21:00"], 13:["21:10","21:55"],
    };
    const names = {1:"第一节",2:"第二节",3:"第三节",4:"第四节",5:"第五节",5.5:"午休",6:"第六节",7:"第七节",8:"第八节",9:"第九节",10:"晚一",11:"晚二",12:"晚三",13:"晚四"};
    const defs = Object.entries(times).map(([no, range], order) => ({
      id:"high2-winter-"+no, period_no:Number(no), name:names[no],
      start_time:range[0], end_time:range[1], order,
    }));
    const ok = await confirmDialog("将按原件重建高二冬令时信息课表：逐项校正13条课程的星期、节次和时间；不会修改高一、高三或其他学科课程。是否继续？", {
      title:"按原件重建高二课表", okText:"确认重建",
    });
    if (!ok) return;

    const normalizeClass = (value) => String(value || "").replace(/^高二/, "").replace(/\\s+/g, "").trim();
    const high2InformationCourses = allCourses.filter((c) =>
      String(c.grade || "").includes("高二") &&
      String(c.subject || "").trim() === "信息技术" &&
      ["5班","6班","7班","8班","9班","10班","11班","12班","13班","14班","15班","16班","18班"].includes(normalizeClass(c.class_name))
    );
    const byClass = new Map();
    for (const course of high2InformationCourses) {
      const className = normalizeClass(course.class_name);
      if (!byClass.has(className)) byClass.set(className, []);
      byClass.get(className).push(course);
    }
    const nextTypes = { ...courseTypes };
    let updated = 0, added = 0;
    for (const row of schedule) {
      const data = {
        weekday:row.weekday, period_no:row.period_no, grade:"高二",
        class_name:row.class_name, subject:"信息技术",
        start_time:times[row.period_no][0], end_time:times[row.period_no][1],
        room:"", weeks:"", color:"", remark:"", start_date:null, end_date:null,
      };
      const matches = byClass.get(row.class_name) || [];
      if (matches.length) {
        const target = matches[0];
        await api.patch("/courses/" + target.id, data);
        nextTypes[String(target.id)] = TYPE_WINTER;
        updated++;
      } else {
        const saved = await api.post("/courses", data);
        nextTypes[String(saved.id)] = TYPE_WINTER;
        added++;
      }
    }
    const nextDefs = { ...periodDefinitions, [key]:defs };
    const nextTimes = { ...periodTimes, [TYPE_WINTER]:{ ...(periodTimes?.[TYPE_WINTER] || {}) } };
    Object.entries(times).forEach(([no, range]) => {
      nextTimes[TYPE_WINTER][no] = { start_time:range[0], end_time:range[1] };
    });
    await saveTimetablePrefs({ courseTypes:nextTypes, periodDefinitions:nextDefs, periodTimes:nextTimes });
    toast("已按原件校正高二课表：更新 " + updated + " 条，新增 " + added + " 条");
    await loadData(false);
  }

  function bind(visible, periods) {
    const typeSelect = box.querySelector('#tt-type');
    const gradeSelect = box.querySelector('#tt-grade');
    box.querySelector('#tt-confirm')?.addEventListener('click', async () => {
      appliedType = typeSelect.value === TYPE_WINTER ? TYPE_WINTER : TYPE_SUMMER;
      appliedGrade = gradeSelect.value || '全部';
      saveViewPreference(appliedType, appliedGrade);
      await loadData(true);
    });
    box.querySelector('#tt-add')?.addEventListener('click', () => openCourseEditor(null, periods));
    box.querySelector('#tt-period-settings')?.addEventListener('click', () => openPeriodSettings());
    box.querySelector('#tt-empty-add')?.addEventListener('click', () => openCourseEditor(null, periods));
    box.querySelector('#tt-import')?.addEventListener('click', () => openImportDialog());
    box.querySelector('#tt-import-high2')?.addEventListener('click', async () => {
      try { await importHigh2Winter(); } catch (error) { toast(error?.message || '高二课表导入失败', 'err'); }
    });
    box.querySelector('#tt-export')?.addEventListener('click', () => openExportDialog(visible, periods));
    box.querySelectorAll('[data-slot]').forEach((slot) => {
      slot.addEventListener('click', (event) => {
        if (event.target.closest('.tt-course-block')) return;
        const day = Number(slot.dataset.day), pNo = Number(slot.dataset.period);
        const period = periods.find((item) => Number(item.period_no) === pNo) || {};
        openCourseEditor(null, periods, {
          weekday: day, period_no: pNo, period_name: period.name || '',
          start_time: periodTimes?.[appliedType]?.[String(pNo)]?.start_time || period.start_time || '',
          end_time: periodTimes?.[appliedType]?.[String(pNo)]?.end_time || period.end_time || '',
        });
      });
      slot.addEventListener('dragover', (event) => {
        if (!event.dataTransfer?.types?.includes('text/plain')) return;
        event.preventDefault();
        slot.classList.add('tt-drop-target');
      });
      slot.addEventListener('dragleave', () => slot.classList.remove('tt-drop-target'));
      slot.addEventListener('drop', async (event) => {
        event.preventDefault();
        slot.classList.remove('tt-drop-target');
        const id = event.dataTransfer?.getData('text/plain');
        if (!id) return;
        await moveCourse(id, Number(slot.dataset.day), Number(slot.dataset.period), visible);
      });
    });
    box.querySelectorAll('.tt-course-block').forEach((block) => {
      block.addEventListener('dragstart', (event) => {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', block.dataset.courseId);
        block.classList.add('tt-dragging');
      });
      block.addEventListener('dragend', () => {
        block.classList.remove('tt-dragging');
        box.querySelectorAll('.tt-drop-target').forEach((node) => node.classList.remove('tt-drop-target'));
      });
      block.addEventListener('click', (event) => {
        if (event.target.closest('button')) return;
        const row = allCourses.find((item) => String(item.id) === String(block.dataset.courseId));
        if (row) openCourseEditor(row, periods);
      });
    });
    box.querySelectorAll('[data-edit-course]').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        const row = allCourses.find((item) => String(item.id) === String(button.dataset.editCourse));
        if (row) openCourseEditor(row, periods);
      });
    });
    box.querySelectorAll('[data-delete-course]').forEach((button) => {
      button.addEventListener('click', async (event) => {
        event.stopPropagation();
        const row = allCourses.find((item) => String(item.id) === String(button.dataset.deleteCourse));
        if (!row) return;
        const ok = await confirmDialog('删除「' + (row.subject || '课程') + '」？删除后会进入回收站，可以恢复。', { title: '删除课程', danger: true, okText: '删除课程' });
        if (!ok) return;
        try {
          await api.del('/courses/' + row.id);
          toast('课程已移入回收站');
          await loadData(false);
        } catch (error) { toast(error?.message || '删除失败', 'err'); }
      });
    });
  }

  async function ensurePeriod(name, startTime, endTime) {
    const label = String(name || '').trim();
    if (!label) throw new Error('请填写节次名称');
    const requestedNo = getCanonicalPeriodNumber({ name: label });
    let hit = allPeriods.find((period) => samePeriodName(periodName(period), label));
    if (!hit && requestedNo != null) hit = allPeriods.find((period) => getCanonicalPeriodNumber(period) === requestedNo);
    if (hit) return hit;
    const nextNo = Math.max(0, ...allPeriods.map((period) => Number(period.period_no) || 0)) + 1;
    const lunch = label.includes('午休');
    const created = await api.post('/periods', {
      period_no: nextNo,
      name: label,
      start_time: normalizeTime(startTime) || (lunch ? '12:10' : '00:00'),
      end_time: normalizeTime(endTime) || (lunch ? '14:10' : '00:00'),
    });
    allPeriods.push(created);
    return created;
  }

  function timePickerField(id, label, value) {
    return '<div class="field tt-time-field"><label class="field-label" for="' + id + '">' + label + '</label>' +
      '<div class="tt-time-wrap"><input class="input" id="' + id + '" type="text" value="' + esc(value || '') + '" placeholder="如：08:00" inputmode="numeric">' +
      '<button class="tt-time-pick" type="button" data-time-pick="' + id + '" aria-label="选择时间">' + icon('clock', 15) + '</button>' +
      '<input class="tt-native-time" type="time" data-native-time="' + id + '" tabindex="-1" aria-hidden="true"></div></div>';
  }

  function openCourseEditor(row, periods, preset = {}) {
    const isNew = !row?.id;
    const requestedPeriodNo = getCanonicalPeriodNumber({ period_no: row?.period_no ?? preset.period_no, name: row?.period_name || preset.period_name || '' });
    const period = periods.find((item) => getCanonicalPeriodNumber(item) === requestedPeriodNo) || {};
    const periodValue = row ? periodName(period) || ('第' + requestedPeriodNo + '节') : (preset.period_name || '');
    const defaultLunch = String(periodValue).includes('午休');
    const body = el('<div class="sheet-body"><div class="form-grid">' +
      '<div class="field"><label class="field-label" for="tt-course-name">课程名称</label><input class="input" id="tt-course-name" value="' + esc(row?.subject || (defaultLunch ? '午休' : '')) + '" placeholder="如：语文课、数学课、英语课" required></div>' +
      '<div class="field"><label class="field-label" for="tt-course-grade">所属年级</label><input class="input" id="tt-course-grade" list="tt-grade-list" value="' + esc(row?.grade || (defaultLunch ? '全部' : '')) + '" placeholder="选择或输入年级"><datalist id="tt-grade-list"><option value="高一"><option value="高二"><option value="高三"><option value="全部"></datalist></div>' +
      '<div class="field"><label class="field-label" for="tt-course-weekday">星期</label><input class="input" id="tt-course-weekday" list="tt-week-list" value="' + esc(row ? ('周' + WD_SHORT[Number(row.weekday)]) : (preset.weekday != null ? '周' + WD_SHORT[Number(preset.weekday)] : '')) + '" placeholder="选择或输入周一至周日"><datalist id="tt-week-list">' + DAYS.map((day) => '<option value="周' + WD_SHORT[day] + '">').join('') + '</datalist></div>' +
      '<div class="field"><label class="field-label" for="tt-course-period">节次</label><input class="input" id="tt-course-period" list="tt-period-list" value="' + esc(periodValue) + '" placeholder="如：早自习、第一节、晚自习第一节"><datalist id="tt-period-list">' + periods.map((item) => '<option value="' + esc(item.name || ('第' + item.period_no + '节')) + '">').join('') + '</datalist></div>' +
      timePickerField('tt-course-start', '开始时间', row?.start_time || preset.start_time || period.start_time || (defaultLunch ? '12:10' : '')) +
      timePickerField('tt-course-end', '结束时间', row?.end_time || preset.end_time || period.end_time || (defaultLunch ? '14:10' : '')) +
      '<div class="field field-full"><label class="field-label" for="tt-course-class">授课班级</label><input class="input" id="tt-course-class" value="' + esc(row?.class_name || (defaultLunch ? '全体' : '')) + '" placeholder="如：高一1班 / 高二全年级"></div>' +
      '</div><div class="confirm-actions"><button class="btn ghost" id="tt-course-cancel">取消</button><button class="btn primary" id="tt-course-save">保存课程</button></div></div>');
    const modal = sheet({ title: isNew ? '新增课程' : '编辑课程', body, wide: true });
    body.querySelector('#tt-course-cancel').onclick = modal.close;
    body.querySelectorAll('[data-time-pick]').forEach((button) => {
      button.onclick = () => {
        const id = button.dataset.timePick;
        const picker = body.querySelector('[data-native-time="' + id + '"]');
        picker.value = normalizeTime(body.querySelector('#' + id).value);
        if (picker.showPicker) picker.showPicker(); else picker.click();
        picker.onchange = () => { body.querySelector('#' + id).value = picker.value; };
      };
    });
    body.querySelector('#tt-course-period').addEventListener('change', () => {
      const name = body.querySelector('#tt-course-period').value.trim();
      const match = periods.find((item) => String(item.name || '').trim() === name);
      if (!match) {
        if (name.includes('午休')) {
          if (!body.querySelector('#tt-course-start').value) body.querySelector('#tt-course-start').value = '12:10';
          if (!body.querySelector('#tt-course-end').value) body.querySelector('#tt-course-end').value = '14:10';
        }
        return;
      }
      if (!body.querySelector('#tt-course-start').value) body.querySelector('#tt-course-start').value = match.start_time || '';
      if (!body.querySelector('#tt-course-end').value) body.querySelector('#tt-course-end').value = match.end_time || '';
    });
    if (!isNew) {
      const del = el('<button class="btn ghost danger" type="button" id="tt-course-delete">删除课程</button>');
      body.querySelector('.confirm-actions').prepend(del);
      del.onclick = async () => {
        const ok = await confirmDialog('删除这门课程？删除后会进入回收站，可以恢复。', { title: '删除课程', danger: true, okText: '删除课程' });
        if (!ok) return;
        try {
          await api.del('/courses/' + row.id);
          modal.close();
          toast('课程已移入回收站');
          await loadData(false);
        } catch (error) { toast(error?.message || '删除失败', 'err'); }
      };
    }
    saving(body.querySelector('#tt-course-save'), async () => {
      const subject = body.querySelector('#tt-course-name').value.trim();
      const grade = body.querySelector('#tt-course-grade').value.trim();
      const weekday = parseWeekday(body.querySelector('#tt-course-weekday').value);
      const periodLabel = body.querySelector('#tt-course-period').value.trim();
      const startTime = normalizeTime(body.querySelector('#tt-course-start').value);
      const endTime = normalizeTime(body.querySelector('#tt-course-end').value);
      const className = body.querySelector('#tt-course-class').value.trim();
      if (!subject) throw new Error('请填写课程名称');
      if (!grade) throw new Error('请填写所属年级');
      if (weekday == null) throw new Error('星期请输入周一至周日');
      if (!periodLabel) throw new Error('请填写节次名称');
      if (!startTime || !endTime) throw new Error('开始时间和结束时间请按 HH:MM 填写');
      if (timeMinutes(endTime) <= timeMinutes(startTime)) throw new Error('结束时间必须晚于开始时间');
      if (!className) throw new Error('请填写授课班级');
      const periodRow = await ensurePeriod(periodLabel, startTime, endTime);
      const payload = {
        weekday, period_no: Number(periodRow.period_no),
        start_time: startTime, end_time: endTime,
        grade, class_name: className, subject,
        room: row?.room || '', weeks: row?.weeks || '', color: row?.color || '', remark: row?.remark || '',
        start_date: row?.start_date || null, end_date: row?.end_date || null,
      };
      let saved;
      if (isNew) saved = await api.post('/courses', payload);
      else saved = await api.patch('/courses/' + row.id, payload);
      const id = String(saved?.id || row?.id || '');
      const nextTypes = { ...courseTypes };
      if (id) nextTypes[id] = appliedType;
      const nextPeriodTimes = { ...periodTimes, [appliedType]: {
        ...(periodTimes?.[appliedType] || {}),
        [String(periodRow.period_no)]: { start_time: startTime, end_time: endTime },
      }};
      try {
        await saveTimetablePrefs({ courseTypes: nextTypes, periodTimes: nextPeriodTimes });
      } catch (error) {
        if (isNew && id) await api.del('/courses/' + id).catch(() => {});
        throw new Error('课程保存失败：课表类型同步设置没有保存。' + (error?.message || ''));
      }
      modal.close();
      toast('课程已保存');
      await loadData(false);
    });
  }

  function openExportDialog(visible, periods) {
    const body = el('<div class="sheet-body"><p class="small muted">导出的内容与当前查看的课表一致，包含午休、跨年级课程及课程颜色标识。</p>' +
      '<div class="tt-export-options">' +
        '<button class="tt-export-option" type="button" data-export="xlsx"><span>📊</span><b>Excel 表格</b><small>.xlsx 格式，可继续编辑</small></button>' +
        '<button class="tt-export-option" type="button" data-export="pdf"><span>📄</span><b>PDF 文件</b><small>打印或另存为 PDF</small></button>' +
        '<button class="tt-export-option" type="button" data-export="png"><span>🖼️</span><b>PNG 图片</b><small>高清图片，方便分享</small></button>' +
      '</div></div>');
    const modal = sheet({ title: '导出课表', body });
    body.querySelectorAll('[data-export]').forEach((button) => {
      button.onclick = async () => {
        try {
          const kind = button.dataset.export;
          if (kind === 'xlsx') exportXlsx(visible, periods);
          else if (kind === 'pdf') exportPdf(visible, periods);
          else await exportPng(visible, periods);
          modal.close();
        } catch (error) { toast(error?.message || '导出失败', 'err'); }
      };
    });
  }

  function exportRows(visible, periods) {
    const rows = [['节次 / 时间', ...DAY_NAMES]];
    for (const period of periods) {
      const pNo = Number(period.period_no);
      const rowCourses = visible.filter((course) => getCanonicalPeriodNumber(course) === pNo);
      const first = rowCourses.find((course) => course.start_time || course.end_time) || {};
      const time = courseTime({ ...first, period_no: pNo }, period, periodTimes, appliedType);
      const cells = DAYS.map((day) => rowCourses.filter((course) => Number(course.weekday) === day).map((course) =>
        [course.subject || '课程', gradeClass(course.grade, course.class_name), courseTime(course, period, periodTimes, appliedType)].filter(Boolean).join('\n')
      ).join('\n\n'));
      rows.push([periodName(period) + (time ? '\n' + time : ''), ...cells]);
    }
    return rows;
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  function xmlEscape(value) {
    return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  }
  function crc32(bytes) {
    let crc = -1;
    for (let i = 0; i < bytes.length; i++) {
      crc ^= bytes[i];
      for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
    }
    return (crc ^ -1) >>> 0;
  }
  function joinBytes(parts) {
    const length = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) { out.set(part, offset); offset += part.length; }
    return out;
  }
  function zipStore(files) {
    const encoder = new TextEncoder();
    const localParts = [], centralParts = [];
    let offset = 0;
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
    const dosDate = ((Math.max(1980, now.getFullYear()) - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    for (const file of files) {
      const name = encoder.encode(file.name);
      const data = encoder.encode(file.content);
      const crc = crc32(data);
      const local = new Uint8Array(30 + name.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true);
      lv.setUint16(6, 0, true); lv.setUint16(8, 0, true);
      lv.setUint16(10, dosTime, true); lv.setUint16(12, dosDate, true);
      lv.setUint32(14, crc, true); lv.setUint32(18, data.length, true); lv.setUint32(22, data.length, true);
      lv.setUint16(26, name.length, true); lv.setUint16(28, 0, true); local.set(name, 30);
      localParts.push(local, data);
      const central = new Uint8Array(46 + name.length);
      const cv = new DataView(central.buffer);
      cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
      cv.setUint16(8, 0, true); cv.setUint16(10, 0, true);
      cv.setUint16(12, dosTime, true); cv.setUint16(14, dosDate, true);
      cv.setUint32(16, crc, true); cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true);
      cv.setUint16(28, name.length, true); cv.setUint16(30, 0, true); cv.setUint16(32, 0, true);
      cv.setUint16(34, 0, true); cv.setUint16(36, 0, true); cv.setUint32(38, 0, true);
      cv.setUint32(42, offset, true); central.set(name, 46);
      centralParts.push(central);
      offset += local.length + data.length;
    }
    const localBytes = joinBytes(localParts);
    const centralBytes = joinBytes(centralParts);
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true); ev.setUint16(4, 0, true); ev.setUint16(6, 0, true);
    ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
    ev.setUint32(12, centralBytes.length, true); ev.setUint32(16, localBytes.length, true); ev.setUint16(20, 0, true);
    return new Blob([localBytes, centralBytes, end], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }
  function columnName(index) {
    let n = index + 1, name = '';
    while (n) { const r = (n - 1) % 26; name = String.fromCharCode(65 + r) + name; n = Math.floor((n - 1) / 26); }
    return name;
  }
  function exportXlsx(visible, periods) {
    const rows = exportRows(visible, periods);
    const sheetRows = rows.map((row, r) => '<row r="' + (r + 1) + '">' + row.map((value, c) => {
      const ref = columnName(c) + (r + 1);
      return '<c r="' + ref + '" t="inlineStr"><is><t xml:space="preserve">' + xmlEscape(value) + '</t></is></c>';
    }).join('') + '</row>').join('');
    const files = [
      { name: '[Content_Types].xml', content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>' },
      { name: '_rels/.rels', content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
      { name: 'xl/workbook.xml', content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="我的课表" sheetId="1" r:id="rId1"/></sheets></workbook>' },
      { name: 'xl/_rels/workbook.xml.rels', content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>' },
      { name: 'xl/worksheets/sheet1.xml', content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' + sheetRows + '</sheetData></worksheet>' },
    ];
    downloadBlob(zipStore(files), '我的课表-' + appliedType + '-' + appliedGrade + '.xlsx');
    toast('Excel 课表已导出');
  }

  function exportPdf(visible, periods) {
    const rows = exportRows(visible, periods);
    const htmlRows = rows.map((row, index) => '<tr>' + row.map((cell, cellIndex) =>
      '<' + (index === 0 ? 'th' : 'td') + '>' + esc(cell).replace(/\n/g, '<br>') + '</' + (index === 0 ? 'th' : 'td') + '>'
    ).join('') + '</tr>').join('');
    const title = '我的课表 - ' + appliedType + ' - ' + appliedGrade;
    const win = window.open('', '_blank');
    if (!win) throw new Error('浏览器拦截了导出窗口，请允许弹出窗口后重试');
    win.document.write('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>' + esc(title) + '</title><style>' +
      'body{font-family:system-ui,"Microsoft YaHei",sans-serif;color:#1B1F26;margin:20px}h2{margin:0 0 6px}.meta{color:#6B7280;margin-bottom:14px;font-size:12px}' +
      'table{width:100%;border-collapse:collapse;table-layout:fixed;font-size:11px}th,td{border:1px solid #D8DEE8;padding:7px 5px;vertical-align:middle;white-space:pre-wrap;overflow-wrap:anywhere}th{background:#F2F5FA}' +
      'th:first-child,td:first-child{width:115px;background:#F7F8FA;font-weight:700}@page{size:A4 landscape;margin:10mm}' +
      '</style><h2>' + esc(title) + '</h2><div class="meta">导出时间：' + esc(new Date().toLocaleString('zh-CN')) + '</div><table>' + htmlRows + '</table>' +
      '<script>window.addEventListener("load",function(){setTimeout(function(){window.print()},250)})<\/script></html>');
    win.document.close();
  }

  async function exportPng(visible, periods) {
    const width = 1680, left = 180, headerHeight = 120, rowHeight = 92;
    const height = headerHeight + 48 + Math.max(1, periods.length) * rowHeight + 30;
    const canvas = document.createElement('canvas');
    canvas.width = width * 2; canvas.height = height * 2;
    const ctx = canvas.getContext('2d');
    ctx.scale(2, 2);
    ctx.fillStyle = '#F7F8FA'; ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#1B1F26'; ctx.font = '700 25px "Microsoft YaHei",sans-serif';
    ctx.fillText('我的课表', 34, 42);
    ctx.fillStyle = '#6B7280'; ctx.font = '14px "Microsoft YaHei",sans-serif';
    ctx.fillText(appliedType + ' · ' + (appliedGrade === '全部' ? '全部年级总课表' : appliedGrade), 34, 72);
    ctx.fillText('导出时间：' + new Date().toLocaleString('zh-CN'), 34, 98);
    const dayWidth = (width - left) / 7;
    const top = headerHeight;
    ctx.fillStyle = '#EEF2F7'; ctx.fillRect(0, top, width, 48);
    ctx.fillStyle = '#64748B'; ctx.font = '700 14px "Microsoft YaHei",sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('节次 / 时间', left / 2, top + 29);
    DAY_NAMES.forEach((day, index) => ctx.fillText(day, left + dayWidth * index + dayWidth / 2, top + 29));
    periods.forEach((period, rowIndex) => {
      const y = top + 48 + rowIndex * rowHeight;
      ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, y, width, rowHeight);
      ctx.strokeStyle = '#E5E7EB'; ctx.lineWidth = 1; ctx.strokeRect(0, y, width, rowHeight);
      ctx.fillStyle = '#F7F8FA'; ctx.fillRect(0, y, left, rowHeight);
      ctx.fillStyle = '#344054'; ctx.font = '700 14px "Microsoft YaHei",sans-serif';
      ctx.fillText(periodName(period), left / 2, y + 34);
      ctx.fillStyle = '#6B7280'; ctx.font = '11px "Microsoft YaHei",sans-serif';
      const pNo = Number(period.period_no);
      const rowCourses = visible.filter((course) => getCanonicalPeriodNumber(course) === pNo);
      const first = rowCourses.find((course) => course.start_time || course.end_time) || {};
      const range = courseTime({ ...first, period_no: pNo }, period, periodTimes, appliedType);
      ctx.fillText(range, left / 2, y + 56);
      for (let dayIndex = 0; dayIndex < 7; dayIndex++) {
        const x = left + dayWidth * dayIndex;
        ctx.strokeStyle = '#E5E7EB'; ctx.strokeRect(x, y, dayWidth, rowHeight);
        const day = DAYS[dayIndex];
        const cellCourses = rowCourses.filter((course) => Number(course.weekday) === day);
        cellCourses.forEach((course, courseIndex) => {
          const grade = String(course.grade || '');
          const fill = grade.includes('高二') ? '#F3EEFF' : grade.includes('高三') ? '#FEECEC' : grade.includes('高一') ? '#EEF4FF' : '#F2F3F5';
          ctx.fillStyle = fill;
          const bx = x + 6, by = y + 5 + courseIndex * 27, bw = dayWidth - 12, bh = Math.min(25, rowHeight - 10);
          ctx.fillRect(bx, by, bw, bh);
          ctx.fillStyle = '#1B1F26'; ctx.font = '700 12px "Microsoft YaHei",sans-serif'; ctx.textAlign = 'left';
          ctx.fillText(String(course.subject || '课程').slice(0, 16), bx + 6, by + 16);
          ctx.fillStyle = '#667085'; ctx.font = '10px "Microsoft YaHei",sans-serif';
          ctx.fillText((gradeClass(course.grade, course.class_name) || '').slice(0, 20), bx + 6, by + 24);
        });
      }
    });
    ctx.textAlign = 'left';
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('图片生成失败，请重试');
    downloadBlob(blob, '我的课表-' + appliedType + '-' + appliedGrade + '.png');
    toast('PNG 课表已导出');
  }

  function openImportDialog() {
    let rawRows = null;
    let rawImage = null;
    let entries = [];
    let sourceNote = '';
    const defaultSubject = String(state.user?.subject || '');
    const body = el('<div class="sheet-body tt-import-body">' +
      '<p class="small muted">支持 PDF、Excel（.xlsx / CSV）和 PNG/JPG。上传后先预览识别结果，核对学科、年级和班级后再导入。</p>' +
      '<div class="tt-import-settings">' +
        '<div class="field"><label class="field-label" for="tt-import-subject">我的学科</label><input class="input" id="tt-import-subject" list="tt-import-subject-list" value="' + esc(defaultSubject) + '" placeholder="如：信息技术、语文、数学"><datalist id="tt-import-subject-list"><option value="信息技术"><option value="语文"><option value="数学"><option value="英语"><option value="物理"><option value="化学"><option value="生物"></datalist></div>' +
        '<div class="field"><label class="field-label" for="tt-import-grade">默认年级</label><input class="input" id="tt-import-grade" list="tt-import-grade-list" value="" placeholder="如：高一"><datalist id="tt-import-grade-list"><option value="高一"><option value="高二"><option value="高三"></datalist></div>' +
      '</div>' +
      '<label class="tt-import-check"><input type="checkbox" id="tt-import-fill-subject" checked> 表格没有标出学科时，将所有识别到的课程按“我的学科”生成</label>' +
      '<label class="tt-import-check"><input type="checkbox" id="tt-import-replace"> 替换当前课表类型中的旧课程（旧课程会进入回收站）</label>' +
      '<div class="tt-file-drop"><input type="file" id="tt-import-file" accept=".pdf,.xlsx,.csv,.tsv,image/png,image/jpeg"><b>选择课表文件</b><span>PDF / XLSX / CSV / PNG / JPG</span></div>' +
      '<div class="tt-import-status" id="tt-import-status">请选择文件开始识别</div>' +
      '<div id="tt-import-preview"></div>' +
      '<div class="confirm-actions"><button class="btn ghost" id="tt-import-cancel">取消</button><button class="btn primary" id="tt-import-save" disabled>导入到当前课表</button></div></div>');
    const modal = sheet({ title: '导入课表', body, wide: true });
    const status = body.querySelector('#tt-import-status');
    const preview = body.querySelector('#tt-import-preview');
    const saveButton = body.querySelector('#tt-import-save');
    body.querySelector('#tt-import-cancel').onclick = modal.close;

    function selectedSubject() { return body.querySelector('#tt-import-subject').value.trim(); }
    function selectedGrade() { return body.querySelector('#tt-import-grade').value.trim(); }

    function buildEntries() {
      const subject = selectedSubject();
      const defaultGrade = selectedGrade();
      if (rawImage) {
        entries = rawImage.cells.map((cell) => ({
          weekday: Number(cell.weekday),
          periodLabel: '第' + Number(cell.periodGuess || 1) + '节',
          subject,
          grade: defaultGrade || '',
          class_name: classFromText(cell.classGuess || '', defaultGrade),
          start_time: '', end_time: '',
          sourceText: cell.classGuess || '',
        }));
        sourceNote = '图片识别可定位有课单元格并读取班号；学科由你选择，橙色空白班级需要手动补全。';
      } else if (rawRows) {
        entries = parseScheduleRows(rawRows, subject, defaultGrade, body.querySelector('#tt-import-fill-subject').checked);
        sourceNote = '请核对识别出的星期、节次、学科和班级，确认后再导入。';
      }
      renderImportPreview();
    }

    function renderImportPreview() {
      saveButton.disabled = !entries.length || entries.some((entry) =>
        entry.weekday == null || !entry.periodLabel || !entry.subject || !entry.grade || !entry.class_name
      );
      if (!entries.length) {
        preview.innerHTML = '<div class="tt-import-empty">没有识别到课程，请换一份清晰的课表或手动整理 Excel。</div>';
        return;
      }
      preview.innerHTML = '<div class="tt-import-summary">识别到 <b>' + entries.length + '</b> 条课程。' + esc(sourceNote) + '</div>' +
        '<div class="tt-import-table-wrap"><table class="tt-import-table"><thead><tr><th>星期</th><th>节次</th><th>学科</th><th>年级</th><th>班级</th><th>开始</th><th>结束</th><th></th></tr></thead><tbody>' +
        entries.map((entry, index) => '<tr data-import-row="' + index + '"' + (!entry.class_name ? ' class="needs-check"' : '') + '>' +
          '<td><select data-k="weekday">' + DAYS.map((day) => '<option value="' + day + '"' + (Number(entry.weekday) === day ? ' selected' : '') + '>周' + WD_SHORT[day] + '</option>').join('') + '</select></td>' +
          '<td><input data-k="periodLabel" value="' + esc(entry.periodLabel) + '" list="tt-period-list-import"></td>' +
          '<td><input data-k="subject" value="' + esc(entry.subject) + '"></td>' +
          '<td><input data-k="grade" value="' + esc(entry.grade) + '" list="tt-grade-list-import"></td>' +
          '<td><input data-k="class_name" value="' + esc(entry.class_name) + '" placeholder="请核对班级"></td>' +
          '<td><input data-k="start_time" value="' + esc(entry.start_time) + '" placeholder="08:00"></td>' +
          '<td><input data-k="end_time" value="' + esc(entry.end_time) + '" placeholder="08:45"></td>' +
          '<td><button class="icon-btn sm" type="button" data-remove-import="' + index + '" aria-label="移除">×</button></td></tr>').join('') +
        '</tbody></table></div>' +
        '<datalist id="tt-period-list-import">' + allPeriods.map((period) => '<option value="' + esc(period.name) + '">').join('') + '</datalist>' +
        '<datalist id="tt-grade-list-import"><option value="高一"><option value="高二"><option value="高三"><option value="全部"></datalist>';
      preview.querySelectorAll('[data-import-row]').forEach((tr) => {
        tr.querySelectorAll('[data-k]').forEach((input) => {
          input.addEventListener('change', () => {
            const index = Number(tr.dataset.importRow);
            const key = input.dataset.k;
            entries[index][key] = key === 'weekday' ? Number(input.value) : input.value.trim();
            renderImportPreview();
          });
        });
      });
      preview.querySelectorAll('[data-remove-import]').forEach((button) => {
        button.onclick = () => {
          entries.splice(Number(button.dataset.removeImport), 1);
          renderImportPreview();
        };
      });
    }

    body.querySelector('#tt-import-subject').addEventListener('change', () => { if (rawRows || rawImage) buildEntries(); });
    body.querySelector('#tt-import-grade').addEventListener('change', () => { if (rawRows || rawImage) buildEntries(); });
    body.querySelector('#tt-import-fill-subject').addEventListener('change', () => { if (rawRows) buildEntries(); });

    body.querySelector('#tt-import-file').addEventListener('change', async (event) => {
      const file = event.target.files?.[0];
      if (!file) return;
      rawRows = null; rawImage = null; entries = [];
      saveButton.disabled = true;
      status.textContent = '正在读取文件…';
      preview.innerHTML = '';
      try {
        const ext = file.name.split('.').pop().toLowerCase();
        if (ext === 'xlsx') {
          const workbook = await readXlsx(file);
          const sheetData = workbook.sheets.find((item) => item.rows?.some((row) => row.some((cell) => String(cell || '').trim()))) || workbook.sheets[0];
          rawRows = sheetData?.rows || [];
          status.textContent = 'Excel 已读取：' + (sheetData?.name || '工作表') + '，正在解析课表…';
          buildEntries();
        } else if (ext === 'csv' || ext === 'tsv') {
          rawRows = readDelimited(await file.text());
          status.textContent = '表格文件已读取，正在解析课表…';
          buildEntries();
        } else if (ext === 'pdf') {
          status.textContent = '正在将 PDF 第一页转换为图片并识别…';
          const canvas = await pdfFirstPageCanvas(file);
          const image = await imageFromCanvas(canvas);
          rawImage = detectTimetable(image);
          if (!rawImage.ok) throw new Error(rawImage.reason || 'PDF 页面没有识别出课表网格');
          buildEntries();
        } else if (file.type.startsWith('image/')) {
          status.textContent = '正在识别图片课表…';
          const image = await imageFromFile(file);
          rawImage = detectTimetable(image);
          if (!rawImage.ok) throw new Error(rawImage.reason || '图片没有识别出课表网格');
          buildEntries();
        } else if (ext === 'xls') {
          throw new Error('暂不支持旧版 .xls，请在 Excel/WPS 中另存为 .xlsx 后导入。');
        } else {
          throw new Error('文件格式不支持，请选择 PDF、XLSX、CSV、PNG 或 JPG。');
        }
        status.textContent = '识别完成，请核对预览内容。';
      } catch (error) {
        status.textContent = '识别失败：' + (error?.message || '请换一份文件重试');
        saveButton.disabled = true;
      }
    });

    saving(saveButton, async () => {
      if (!entries.length) throw new Error('没有可导入的课程');
      if (entries.some((entry) => entry.weekday == null || !entry.periodLabel || !entry.subject || !entry.grade || !entry.class_name)) {
        throw new Error('请先补全星期、节次、学科、年级和班级');
      }
      const replace = body.querySelector('#tt-import-replace').checked;
      if (replace) {
        const ok = await confirmDialog('将替换' + appliedType + '中的旧课程，旧课程会进入回收站。是否继续？', { title: '替换当前课表', danger: true, okText: '替换并导入' });
        if (!ok) return;
      }
      const oldCourses = allCourses.filter((course) => typeOfCourse(course, courseTypes) === appliedType);
      const existingKeys = new Set(replace ? [] : oldCourses.map(courseKey));
      const created = [];
      const nextTypes = { ...courseTypes };
      const nextPeriodTimes = { ...periodTimes, [appliedType]: { ...(periodTimes?.[appliedType] || {}) } };
      for (const entry of entries) {
        const periodRow = await ensurePeriod(entry.periodLabel, entry.start_time, entry.end_time);
        const candidate = {
          weekday: Number(entry.weekday),
          period_no: Number(periodRow.period_no),
          grade: entry.grade,
          class_name: entry.class_name,
          subject: entry.subject,
          start_time: normalizeTime(entry.start_time) || periodRow.start_time || '',
          end_time: normalizeTime(entry.end_time) || periodRow.end_time || '',
        };
        const key = courseKey(candidate);
        if (existingKeys.has(key)) continue;
        existingKeys.add(key);
        const saved = await api.post('/courses', {
          ...candidate, room: '', weeks: '', color: '', remark: '', start_date: null, end_date: null,
        });
        created.push(saved);
        nextTypes[String(saved.id)] = appliedType;
        if (candidate.start_time || candidate.end_time) {
          nextPeriodTimes[appliedType][String(periodRow.period_no)] = {
            start_time: candidate.start_time, end_time: candidate.end_time,
          };
        }
      }
      if (!created.length && !replace) throw new Error('没有新增课程：可能这些课程已经存在');
      await saveTimetablePrefs({ courseTypes: nextTypes, periodTimes: nextPeriodTimes });
      if (replace) {
        for (const course of oldCourses) await api.del('/courses/' + course.id);
      }
      toast('已导入 ' + created.length + ' 节课程' + (replace ? '，旧课表已移入回收站' : ''));
      modal.close();
      await loadData(false);
    });
  }

  function parseScheduleRows(rows, selectedSubject, defaultGrade, fillSubjectWhenMissing) {
    const source = (rows || []).map((row) => (row || []).map((cell) => String(cell ?? '').trim()));
    if (!source.length) return [];
    let headerIndex = source.findIndex((row) => row.filter((cell) => parseWeekday(cell) != null).length >= 3);
    let dayCols = [];
    if (headerIndex >= 0) {
      dayCols = source[headerIndex].map((cell, index) => ({ index, day: parseWeekday(cell) })).filter((item) => item.day != null);
    } else {
      dayCols = [1, 2, 3, 4, 5, 6, 7].map((index, offset) => ({ index, day: DAYS[offset] }));
      headerIndex = -1;
    }
    const raw = [];
    for (let rowIndex = headerIndex + 1; rowIndex < source.length; rowIndex++) {
      const row = source[rowIndex];
      if (!row?.length) continue;
      const periodLabel = String(row[0] || '').trim();
      if (!periodLabel || /^(节次|时间|星期|周一|周二|周三|周四|周五|周六|周日)$/.test(periodLabel)) continue;
      const range = row.map(parseTimeRange).find(Boolean);
      const periodNameValue = periodLabel.replace(/\s*\d{1,2}[:：]\d{2}\s*[-–—~至]\s*\d{1,2}[:：]\d{2}/, '').trim() || periodLabel;
      for (const column of dayCols) {
        const text = String(row[column.index] || '').trim();
        if (!text || ['-', '/', '—', '休息'].includes(text)) continue;
        raw.push({
          weekday: column.day,
          periodLabel: periodNameValue,
          sourceText: text,
          start_time: range?.[0] || '',
          end_time: range?.[1] || '',
        });
      }
    }
    const hasSubject = selectedSubject && raw.some((entry) => entry.sourceText.includes(selectedSubject));
    if (selectedSubject && !hasSubject && !fillSubjectWhenMissing) {
      throw new Error('表格中没有找到“' + selectedSubject + '”。如果这份表没有标出学科，请勾选“按我的学科填充全部有课格”。');
    }
    return raw.filter((entry) => !hasSubject || entry.sourceText.includes(selectedSubject)).map((entry) => {
      const explicitGrade = gradeFromText(entry.sourceText);
      const grade = explicitGrade || defaultGrade;
      let className = classFromText(entry.sourceText, grade);
      if (!className) {
        const cleaned = entry.sourceText.replace(selectedSubject || /$^/, '').replace(parseTimeRange(entry.sourceText)?.join('-') || /$^/, '').trim();
        className = cleaned && cleaned !== selectedSubject ? cleaned : '';
      }
      return {
        ...entry,
        subject: selectedSubject || '',
        grade: grade || '',
        class_name: className,
      };
    });
  }

  function imageFromFile(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
      image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片无法打开')); };
      image.src = url;
    });
  }
  function imageFromCanvas(canvas) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('PDF 页面转换失败'));
      image.src = canvas.toDataURL('image/png');
    });
  }
  function pdfFirstPageCanvas(file) {
    return new Promise(async (resolve, reject) => {
      try {
        const pdfjs = await loadPdfJs();
        const data = new Uint8Array(await file.arrayBuffer());
        const pdf = await pdfjs.getDocument({ data }).promise;
        const page = await pdf.getPage(1);
        const viewport = page.getViewport({ scale: 1.7 });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
        resolve(canvas);
      } catch (error) { reject(error); }
    });
  }
  function loadPdfJs() {
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    if (window.__wbPdfJsPromise) return window.__wbPdfJsPromise;
    window.__wbPdfJsPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
      script.onload = () => {
        if (!window.pdfjsLib) return reject(new Error('PDF 解析组件加载失败'));
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
        resolve(window.pdfjsLib);
      };
      script.onerror = () => reject(new Error('加载 PDF 解析组件失败，请检查网络，或将 PDF 转为 PNG 后导入'));
      document.head.appendChild(script);
    });
    return window.__wbPdfJsPromise;
  }

  await loadData(true);
  if (clockTimer) clearInterval(clockTimer);
  clockTimer = setInterval(() => {
    if (!box.isConnected) { clearInterval(clockTimer); clockTimer = null; return; }
    if (ymd() !== lastDate) {
      lastDate = ymd();
      loadData(false);
      return;
    }
    updateClock(getVisibleCourses());
  }, 1000);
  onViewLeave(() => {
    if (clockTimer) clearInterval(clockTimer);
    clockTimer = null;
  });
}
