import { resolvePlace, locationWarning } from './weather-location.mjs';
import { api, el, esc, toast, sheet, confirmDialog, promptDialog, ymd, pad2, WD_CN, WD_SHORT, fmtTime, fmtDateTime, relDay, parseDT, countdown, speak, stopSpeak, colorOf, ls, exportUrl, download, addToSystemCalendar } from './core.js';
import { registerView, state, icon, go, render, refreshUnread, paintUnread, onViewLeave } from './ui.js';
import { syncDay, DAY_SYNC } from './homelayout.js';
import { mount as mountGrid, resetLayout as resetGridLayout, pullCloud as pullLayoutCloud, setTemporaryHeight as setGridTemporaryHeight } from './homegrid.js';
import { cleanPeriodTime, getCanonicalPeriodNumber } from './timetable-periods.mjs';

/* ================= 欢迎语 =================
   【第 5 条：按时段问候 + 头像上移】
   最终口径（用户确认）：主问候语按时段变（早上好/上午好/下午好…），
   头像放在首页时钟卡左上角，点一下进「我的」。

   中间走过一段弯路，记下来免得再犯：
   用户第一遍说「每次进来都显示不一样」，我理解成「他要的是永不变」，
   于是把问候语钉成常量「xx工作台，欢迎您！」。结果他明确说「改回按时段问候」——
   他嫌的是**同一时段内反复跳**，不是嫌时段本身。差别在于：
   上午说「上午好」是对的，上午一会儿「上午好」一会儿「下午好」才是 bug。
   所以正确解法是按小时定档、一天内稳定，而不是取消时段。

   下面 greetFor() 只读当前小时，不掺随机数、不掺计数器，同一小时内必然同一句。 */
const GREETS = [
  // [起始小时, 主问候, 副标题]
  [5, '早上好', '新的一天，先看清时间，再安排节奏。'],
  [9, '上午好', '把最重要的一件事放在今天的前两个小时。'],
  [12, '中午好', '吃完再歇一会儿，下午的课才有力气。'],
  [14, '下午好', '还有半天，够把一件难事推进一大步。'],
  [18, '傍晚好', '今天该收尾的，别拖到明天。'],
  [20, '晚上好', '晚自习的灯亮着，你也辛苦了。'],
  [23, '夜深了', '明天的事，交给明天的你，今晚早点休息。'],
];
/* 0:00–5:00 属于上一档（夜深），跨零点不跳回「早安」 */
function greetFor(name) {
  const h = new Date().getHours();
  let cur = GREETS[6];
  for (const g of GREETS) if (h >= g[0]) cur = g;
  return [`${cur[1]}，${name}老师`, cur[2]];
}
/* 按小时取时段名，用来给问候语配一个对应的小图标 */
function greetIcon() {
  const h = new Date().getHours();
  if (h >= 5 && h < 9) return '☀️';
  if (h >= 9 && h < 12) return '🌤️';
  if (h >= 12 && h < 14) return '🍚';
  if (h >= 14 && h < 18) return '⛅';
  if (h >= 18 && h < 20) return '🌇';
  if (h >= 20 && h < 23) return '🌙';
  return '🌛';
}

function parseHomeObject(value) {
  if (value && typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(String(value || ''));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/* 首页课程提醒与我的课表共用同一节次归一化规则。
   /home 返回的是某一天的课程实例，id 是实例 id，course_id 才是原始周课表课程 id；
   必须用 course_id 读取 courseTypes，才能与 timetable.js 的 typeOfCourse() 一致。 */
function homeTimetablePeriodSettings() {
  const userSettings = parseHomeObject(state.user?.settings);
  const timetable = parseHomeObject(userSettings.timetable);
  return {
    courseTypes: parseHomeObject(timetable.courseTypes),
    periodTimes: parseHomeObject(timetable.periodTimes),
    periodDefinitions: parseHomeObject(timetable.periodDefinitions),
  };
}

/* 首页提醒必须与「我的课表」使用同一组查看条件。
   timetable.js 将课表类型、所属年级保存在同一个浏览器键中；
   这里读取同一份设置，不再把所有课表类型/年级的课程混在首页。 */
const HOME_TIMETABLE_VIEW_KEY = 'wb_timetable_view_v1';
function homeTimetableViewPreference() {
  try {
    const saved = JSON.parse(localStorage.getItem(HOME_TIMETABLE_VIEW_KEY) || '{}');
    return {
      type: saved.type === '冬令时课表' ? '冬令时课表' : '夏令时课表',
      grade: ['全部', '高一', '高二', '高三'].includes(saved.grade) ? saved.grade : '全部',
    };
  } catch {
    return { type: '夏令时课表', grade: '全部' };
  }
}

/* 将 /home 或 /calendar/day 返回的当天课程实例，与「我的课表」原始课程行关联。
   只保留当前课表类型和年级；节次、时间按 timetable.js 相同优先级计算。
   课程实例仍负责日期范围和停课/调课例外，原始课程行负责课表归属及课程设置。 */
function getHomeTimetableCourses(instances, date) {
  if (!Array.isArray(homeCourseRows)) return [];
  const { courseTypes, periodTimes, periodDefinitions } = homeTimetablePeriodSettings();
  const view = homeTimetableViewPreference();
  const sourceById = new Map(homeCourseRows.map((course) => [String(course.id), course]));
  const configuredPeriods = Array.isArray(periodDefinitions[view.type + '|' + view.grade])
    ? periodDefinitions[view.type + '|' + view.grade]
    : [];

  return (Array.isArray(instances) ? instances : [])
    .filter((instance) => String(instance.date || '') === String(date || ''))
    .map((instance) => {
      const source = sourceById.get(String(instance.course_id));
      if (!source) return null;
      const scheduleType = courseTypes[String(source.id)] || '夏令时课表';
      if (scheduleType !== view.type) return null;
      if (view.grade !== '全部') {
        const grade = String(source.grade || '').trim();
        if (grade !== view.grade && grade !== '全部' && grade !== '全体') return null;
      }

      const periodNo = getCanonicalPeriodNumber(source, { periodTimes, scheduleType });
      const number = periodNo == null ? Number(instance.period_no) : periodNo;
      const period = configuredPeriods.find((item) => Number(item.period_no) === Number(number));
      const override = periodTimes?.[scheduleType]?.[String(number)] || {};
      const startTime = instance.rescheduled
        ? (cleanPeriodTime(instance.start_time) || cleanPeriodTime(override.start_time) || cleanPeriodTime(source.start_time) || cleanPeriodTime(period?.start_time))
        : (cleanPeriodTime(override.start_time) || cleanPeriodTime(source.start_time) || cleanPeriodTime(period?.start_time) || cleanPeriodTime(instance.start_time));
      const endTime = instance.rescheduled
        ? (cleanPeriodTime(instance.end_time) || cleanPeriodTime(override.end_time) || cleanPeriodTime(source.end_time) || cleanPeriodTime(period?.end_time))
        : (cleanPeriodTime(override.end_time) || cleanPeriodTime(source.end_time) || cleanPeriodTime(period?.end_time) || cleanPeriodTime(instance.end_time));

      return {
        ...instance,
        period_no: number,
        start_time: startTime || instance.start_time || '',
        end_time: endTime || instance.end_time || '',
      };
    })
    .filter(Boolean)
    .sort((a, b) =>
      String(a.start_time || '').localeCompare(String(b.start_time || '')) ||
      Number(a.period_no) - Number(b.period_no) ||
      String(a.class_name || '').localeCompare(String(b.class_name || ''))
    );
}

const nowHM = () => { const d = new Date(); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
/* 首页顶栏的头像。这里不复用 me.js 的 avatarHTML（那是 me 模块私有的），
   但渲染逻辑保持一致：有图用图，没图用首字 + 渐变底。多一层 <button> 是为了
   点头像能直接进「我的」——用户习惯把头像当入口。 */
function homeAvatarHTML(size = 52) {
  const u = state.user || {};
  const first = esc((u.nickname || '师').slice(0, 1));
  const inner = u.avatar
    ? `<img src="${esc(u.avatar)}" alt="头像" loading="lazy">`
    : `<span class="ah-fallback" style="font-size:${Math.round(size * 0.4)}px">${first}</span>`;
  return `<button class="ah-btn" data-goto="me" title="个人中心" aria-label="个人中心"
    style="width:${size}px;height:${size}px">${inner}</button>`;
}

function applyHomeSidebar() {
  const app = document.querySelector('.app');
  const sidebar = app?.querySelector('.sidebar');
  if (!app || !sidebar) return;
  // 首页只应用首页布局样式，不得把品牌区域替换成个人资料。
  // 品牌标题、说明和图标由 ui.js 统一读取后台 workbenchBrand 配置。
  app.classList.add('home-redesign-app');
  sidebar.classList.add('home-sidebar');
}
/* ================= 天气 ================= */
const WX = {
  0: ['☀️', '晴'], 1: ['🌤️', '大部晴朗'], 2: ['⛅', '多云'], 3: ['☁️', '阴'],
  45: ['🌫️', '雾'], 48: ['🌫️', '霜雾'], 51: ['🌦️', '毛毛雨'], 53: ['🌦️', '小雨'], 55: ['🌧️', '细雨'],
  56: ['🌧️', '冻雨'], 57: ['🌧️', '冻雨'], 61: ['🌦️', '小雨'], 63: ['🌧️', '中雨'], 65: ['🌧️', '大雨'],
  66: ['🌨️', '冻雨'], 67: ['🌨️', '冻雨'], 71: ['🌨️', '小雪'], 73: ['❄️', '中雪'], 75: ['❄️', '大雪'], 77: ['🌨️', '雪粒'],
  80: ['🌦️', '阵雨'], 81: ['🌧️', '强阵雨'], 82: ['⛈️', '暴雨'], 85: ['🌨️', '阵雪'], 86: ['❄️', '强阵雪'],
  95: ['⛈️', '雷阵雨'], 96: ['⛈️', '雷雨伴冰雹'], 99: ['⛈️', '强雷暴'],
};
const wxInfo = (c) => WX[c] || ['🌤️', '天气'];
function outfitFor(t, code, wind, rain) {
  const tips = [];
  if (t >= 30) tips.push('短袖 + 透气长裤，注意防晒');
  else if (t >= 24) tips.push('短袖或薄衬衫，早晚可带薄外套');
  else if (t >= 18) tips.push('长袖衬衫 + 薄外套/西装');
  else if (t >= 12) tips.push('毛衣或针织衫 + 风衣');
  else if (t >= 5) tips.push('厚外套/大衣，内搭毛衣');
  else tips.push('羽绒服或棉服，帽子围巾备着');
  if (rain) tips.push('有雨，记得带伞');
  if (wind >= 25) tips.push('风大，外套选防风的');
  if (t <= 8) tips.push('讲课时手冷，可带保温杯');
  return tips.join('；');
}

let weatherTimer = null;
let weatherRequestSeq = 0;
async function loadWeather(force = false) {
  const city = { ...(state.city || { name: '北京', lat: 39.9042, lon: 116.4074 }) };
  const requestId = ++weatherRequestSeq;
  const cache = ls.get('weather', null);
  const matchesCity = (item) => {
    if (!item) return false;
    if (item.lat != null && item.lon != null) {
      return Math.abs(Number(item.lat) - Number(city.lat)) < 0.000001
        && Math.abs(Number(item.lon) - Number(city.lon)) < 0.000001;
    }
    return item.city === city.name;
  };
  const stillCurrent = () => {
    const current = state.city || {};
    return current.name === city.name
      && Number(current.lat) === Number(city.lat)
      && Number(current.lon) === Number(city.lon);
  };
  const fresh = cache && cache.at && (Date.now() - Number(cache.at) < 20 * 60000);
  if (!force && fresh && matchesCity(cache)) {
    if (requestId === weatherRequestSeq && stillCurrent()) state.weather = cache;
    return cache;
  }
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${city.lat}&longitude=${city.lon}`
    + '&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,wind_speed_10m,wind_direction_10m'
    + '&hourly=temperature_2m,weather_code,precipitation_probability'
    + '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset,uv_index_max,wind_speed_10m_max'
    + '&timezone=auto&forecast_days=7';
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) })
    .then((x) => (x.ok ? x.json() : null)).catch(() => null);
  if (requestId !== weatherRequestSeq || !stillCurrent()) return state.weather;
  if (!r || !r.current) {
    if (matchesCity(cache)) { state.weather = cache; return cache; }
    throw new Error('天气获取失败');
  }
  const w = { city: city.name, lat: city.lat, lon: city.lon, at: Date.now(), raw: r };
  state.weather = w;
  ls.set('weather', w);
  return w;
}
/* 城市位置名称：优先显示完整行政区划，兼容旧版只保存 name 的记录。 */
function cityFullName(city = state.city || {}) {
  return String(city?.fullName || city?.admin || city?.name || '当前位置').trim() || '当前位置';
}

/* 最近使用的 5 个地区。保留完整行政区划，县级地区不会只剩一个简称。 */
const RECENT_MAX = 5;
function recentCities() {
  const rows = ls.get('recentCities', []);
  return Array.isArray(rows)
    ? rows.filter((c) => c && c.name && c.lat != null && c.lon != null)
      .slice(0, RECENT_MAX)
      .map((c) => ({ ...c, fullName: cityFullName(c) }))
    : [];
}
function pushRecentCity(c) {
  const item = {
    name: String(c.name || '当前位置'),
    fullName: cityFullName(c),
    lat: Number(c.lat),
    lon: Number(c.lon),
    source: c.source || 'manual',
    province: c.province || '',
    prefecture: c.prefecture || '',
    district: c.district || '',
    locationResolved: c.locationResolved !== false,
  };
  const rest = recentCities().filter((x) => {
    const sameCoords = Math.abs(Number(x.lat) - item.lat) < 0.01
      && Math.abs(Number(x.lon) - item.lon) < 0.01;
    return !sameCoords && cityFullName(x) !== item.fullName;
  });
  const next = [item, ...rest].slice(0, RECENT_MAX);
  ls.set('recentCities', next);
  return next;
}

/* 把实时 GPS 坐标反查为省、市、区县；不再只取 city 一个字段。 */
async function reverseGeocode(lat, lon) {
  return resolvePlace(lat, lon, { previous: state.city });
}
let geoRequestSeq = 0;
let cityChoiceSeq = 0;
function setGeoMode(mode) {
  state.geoMode = mode;
  ls.set('geoMode', mode);
}
async function locate({ silent = false } = {}) {
  const requestId = ++geoRequestSeq;
  const choiceId = cityChoiceSeq;
  if (!navigator.geolocation) {
    if (state.geoMode === 'auto') setGeoMode('manual');
    if (!silent) toast('当前设备或浏览器不支持定位，请手动选择城市', 'warn');
    return null;
  }
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(async (pos) => {
      if (requestId !== geoRequestSeq || choiceId !== cityChoiceSeq) return resolve(null);
      const { latitude, longitude } = pos.coords;
      const resolved = await reverseGeocode(latitude, longitude);
      if (requestId !== geoRequestSeq || choiceId !== cityChoiceSeq) return resolve(null);
      const city = {
        ...resolved,
        lat: latitude,
        lon: longitude,
        source: 'geo',
      };
      cityChoiceSeq += 1;
      geoRequestSeq += 1;
      state.city = city;
      state.weather = null;
      setGeoMode('auto');
      ls.set('city', city);
      pushRecentCity(city);
      resolve(city);
    }, (err) => {
      if (requestId !== geoRequestSeq) return resolve(null);
      if (err.code === 1) setGeoMode('manual');
      const message = err.code === 1
        ? '定位权限未开启，请在浏览器站点设置中允许定位后再试；已保留当前城市'
        : err.code === 2
          ? '暂时无法获取位置信息，请检查设备定位服务'
          : '定位超时，请稍后重试；当前城市已保留';
      if (!silent) toast(message, 'warn');
      resolve(null);
    }, { timeout: 12000, maximumAge: 600000, enableHighAccuracy: false });
  });
}

/* 按城市名查坐标。
   全国几百个地级市，写死一张表必然覆盖不全（原来就只列了 48 个），
   所以输入框走 Open-Meteo 的地理编码接口（和天气同一个域名，不额外跨域）。

   这个接口的中文数据有几处坑，都得在客户端抹平：
   1. 「荆州」查不到，必须输入「荆州市」——所以两轮都试，带「市」的优先；
   2. 「周口」返回三个村，真正的河南周口市反而没进前几名——
      所以按 feature_code 和人口排序，PPLA（省会/地级市中心）排在 PPL 前面；
   3. 会混进「鄂尔多斯伊金霍洛机场」这类设施——把 AIRP/ADM 等过滤掉。

   返回统一结构 { name, lat, lon, admin }，admin 用来在列表里区分同名城市。 */
/* 内置常用城市表（第 8 条的兜底）。
   geocodeCity 走的是 open-meteo 的外网地名库，断网、被墙、接口抽风时
   一行都搜不出来 —— 用户的表现就是「切换城市没反应，天气永远是北京」。
   本地放一份地级市表，搜不到时至少能匹配上，不至于连城都换不了。
   只存名字 + 经纬度，约 300 个，压缩前 20KB 左右，比一张图还小。 */
const CITY_SEED = [
  ['北京',39.90,116.41],['上海',31.23,121.47],['天津',39.13,117.20],['重庆',29.56,106.55],
  ['广州',23.13,113.26],['深圳',22.54,114.06],['杭州',30.27,120.16],['南京',32.06,118.80],
  ['武汉',30.59,114.31],['成都',30.57,104.07],['西安',34.34,108.94],['郑州',34.75,113.63],
  ['长沙',28.23,112.94],['合肥',31.82,117.23],['南昌',28.68,115.86],['福州',26.07,119.30],
  ['厦门',24.48,118.09],['济南',36.65,117.12],['青岛',36.07,120.38],['石家庄',38.04,114.51],
  ['太原',37.87,112.55],['呼和浩特',40.84,111.75],['沈阳',41.81,123.43],['大连',38.91,121.61],
  ['长春',43.82,125.32],['哈尔滨',45.80,126.53],['昆明',25.04,102.71],['贵阳',26.65,106.63],
  ['南宁',22.82,108.37],['海口',20.04,110.20],['三亚',18.25,109.51],['兰州',36.06,103.83],
  ['西宁',36.62,101.78],['银川',38.49,106.23],['乌鲁木齐',43.83,87.62],['拉萨',29.65,91.14],
  ['苏州',31.30,120.58],['无锡',31.49,120.31],['常州',31.81,119.97],['南通',31.98,120.89],
  ['徐州',34.26,117.19],['扬州',32.39,119.41],['镇江',32.19,119.42],['盐城',33.35,120.16],
  ['泰州',32.46,119.92],['连云港',34.60,119.22],['淮安',33.61,119.02],['宿迁',33.96,118.28],
  ['宁波',29.87,121.55],['温州',28.00,120.70],['嘉兴',30.75,120.76],['绍兴',30.00,120.58],
  ['金华',29.08,119.65],['台州',28.66,121.42],['湖州',30.89,120.09],['丽水',28.45,119.92],
  ['衢州',28.94,118.87],['舟山',29.99,122.21],['芜湖',31.33,118.38],['蚌埠',32.92,117.39],
  ['阜阳',32.89,115.81],['安庆',30.53,117.05],['马鞍山',31.67,118.51],['泉州',24.87,118.68],
  ['漳州',24.51,117.65],['莆田',25.45,119.01],['三明',26.26,117.64],['龙岩',25.08,117.03],
  ['赣州',25.83,114.93],['九江',29.71,116.00],['上饶',28.45,117.94],['宜春',27.81,114.42],
  ['吉安',27.11,114.99],['淄博',36.81,118.05],['烟台',37.46,121.45],['潍坊',36.71,119.16],
  ['临沂',35.10,118.36],['济宁',35.41,116.59],['泰安',36.20,117.09],['威海',37.51,122.12],
  ['日照',35.42,119.53],['德州',37.44,116.36],['聊城',36.46,115.99],['菏泽',35.23,115.48],
  ['洛阳',34.62,112.45],['新乡',35.30,113.93],['南阳',32.99,112.53],['开封',34.80,114.31],
  ['许昌',34.04,113.85],['周口',33.63,114.70],['信阳',32.15,114.09],['商丘',34.41,115.66],
  ['驻马店',33.01,114.02],['安阳',36.10,114.39],['平顶山',33.77,113.19],['焦作',35.22,113.24],
  ['襄阳',32.01,112.12],['宜昌',30.69,111.29],['荆州',30.33,112.24],['黄冈',30.45,114.87],
  ['孝感',30.92,113.92],['十堰',32.63,110.80],['荆门',31.04,112.20],['黄石',30.20,115.04],
  ['咸宁',29.84,114.32],['随州',31.69,113.38],['恩施',30.27,109.49],['株洲',27.83,113.13],
  ['湘潭',27.83,112.94],['衡阳',26.89,112.57],['岳阳',29.36,113.13],['常德',29.03,111.70],
  ['郴州',25.77,113.01],['邵阳',27.24,111.47],['益阳',28.55,112.36],['娄底',27.70,112.00],
  ['怀化',27.55,110.00],['永州',26.42,111.61],['东莞',23.02,113.75],['佛山',23.02,113.12],
  ['珠海',22.27,113.58],['中山',22.52,113.39],['惠州',23.11,114.42],['江门',22.58,113.08],
  ['汕头',23.35,116.68],['湛江',21.27,110.36],['茂名',21.66,110.93],['肇庆',23.05,112.47],
  ['梅州',24.29,116.12],['清远',23.68,113.06],['韶关',24.81,113.60],['揭阳',23.55,116.37],
  ['柳州',24.31,109.41],['桂林',25.27,110.29],['玉林',22.63,110.15],['北海',21.48,109.12],
  ['绵阳',31.47,104.68],['德阳',31.13,104.40],['宜宾',28.77,104.62],['南充',30.84,106.11],
  ['泸州',28.87,105.44],['乐山',29.55,103.77],['自贡',29.35,104.78],['达州',31.21,107.50],
  ['遵义',27.73,106.93],['曲靖',25.49,103.80],['大理',25.60,100.27],['丽江',26.86,100.23],
  ['宝鸡',34.36,107.14],['咸阳',34.33,108.71],['渭南',34.50,109.51],['汉中',33.07,107.02],
  ['榆林',38.29,109.73],['天水',34.58,105.72],['酒泉',39.73,98.51],['克拉玛依',45.58,84.89],
  ['喀什',39.47,75.99],['伊宁',43.91,81.32],['包头',40.66,109.84],['鄂尔多斯',39.61,109.78],
  ['赤峰',42.26,118.89],['大同',40.08,113.30],['临汾',36.09,111.52],['运城',35.03,111.01],
  ['长治',36.20,113.12],['晋中',37.69,112.75],['锦州',41.10,121.13],['鞍山',41.11,122.99],
  ['抚顺',41.88,123.96],['吉林',43.84,126.55],['齐齐哈尔',47.35,123.92],['大庆',46.59,125.10],
  ['牡丹江',44.58,129.63],['保定',38.87,115.46],['唐山',39.63,118.18],['廊坊',39.54,116.68],
  ['秦皇岛',39.94,119.60],['邯郸',36.63,114.54],['邢台',37.07,114.50],['沧州',38.30,116.84],
  ['张家口',40.77,114.89],['承德',40.95,117.96],['衡水',37.74,115.67],['安庆市',30.53,117.05],
  ['香港',22.32,114.17],['澳门',22.20,113.55],['台北',25.03,121.57],['高雄',22.63,120.30],
];
/* 转成对象数组，字段名对齐 open-meteo 的返回，后面走同一套 sort / 去重 */
const SEED_CITIES = CITY_SEED.map(([name, lat, lon]) => ({ name, lat, lon }));

async function geocodeCity(kw) {
  const kw2 = String(kw || '').trim();
  if (!kw2) return [];

  /* 简称和完整行政区名称都查：例如「咸丰」会同时尝试「咸丰县」。 */
  const terms = new Set([kw2]);
  const suffix = kw2.match(/(特别行政区|自治州|自治县|地区|县|区|市|州|盟|旗)$/);
  if (suffix) {
    const base = kw2.slice(0, -suffix[0].length).trim();
    if (base.length >= 2) terms.add(base);
  } else {
    [kw2 + '县', kw2 + '区', kw2 + '市'].forEach((term) => terms.add(term));
  }

  const grab = async (term) => {
    try {
      const url = 'https://geocoding-api.open-meteo.com/v1/search?name='
        + encodeURIComponent(term) + '&count=20&language=zh&format=json';
      const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!response.ok) return [];
      const data = await response.json();
      return Array.isArray(data?.results) ? data.results : [];
    } catch {
      return [];
    }
  };

  let rows = (await Promise.all([...terms].map(grab))).flat();

  /* 在线地名库不可用时，保留原有常用地级市兜底；不伪造县级地区坐标。 */
  const seedHit = SEED_CITIES
    .filter((c) => c.name.includes(kw2) || kw2.includes(c.name))
    .slice(0, 4)
    .map((c) => ({
      name: c.name,
      latitude: c.lat,
      longitude: c.lon,
      feature_code: 'PPLA2',
      population: 9e9,
      _seed: true,
    }));
  if (seedHit.length) rows = seedHit.concat(rows);

  /* ADM1–ADM4 是真实行政区划，必须保留；只过滤机场、设施和非居住点。 */
  const BAD = new Set(['AIRP', 'PPLX', 'HSP', 'STM']);
  const normalizeName = (value) => String(value || '').trim()
    .replace(/(特别行政区|自治州|自治县|地区|市|县|区|州|盟|旗|省)$/, '')
    .toLocaleLowerCase();
  const featureRank = (feature) => ({
    PPLC: 0,
    PPLA: 1,
    ADM1: 1,
    PPLA2: 2,
    ADM2: 2,
    ADM3: 2,
    PPLA3: 3,
    ADM4: 3,
    PPLA4: 4,
    PPL: 5,
  }[feature] ?? 6);

  const seen = new Set();
  return rows
    .filter((r) => r && r.name && r.latitude != null && r.longitude != null && !BAD.has(r.feature_code))
    .sort((a, b) => {
      const aExact = normalizeName(a.name) === normalizeName(kw2) ? 0 : 1;
      const bExact = normalizeName(b.name) === normalizeName(kw2) ? 0 : 1;
      if (aExact !== bExact) return aExact - bExact;
      const rankDiff = featureRank(a.feature_code) - featureRank(b.feature_code);
      if (rankDiff) return rankDiff;
      return (b.population || 0) - (a.population || 0);
    })
    .map((r) => {
      const name = String(r.name || kw2).trim().replace(/市$/, '') || kw2;
      const adminParts = [r.admin1, r.admin2, r.admin3, r.admin4]
        .map((value) => String(value || '').trim())
        .filter((value, index, all) => value && all.indexOf(value) === index);
      const district = [...adminParts].reverse()
        .find((value) => /(县|区|旗|自治县)$/.test(value)) || '';
      const displayName = /(县|区|旗|自治县)$/.test(name) ? name : (district || name);
      const fullParts = [...adminParts, displayName]
        .filter((value, index, all) => value && all.indexOf(value) === index);
      const fullName = fullParts.join(' · ') || displayName;
      const key = [
        displayName,
        fullName,
        Number(r.latitude).toFixed(4),
        Number(r.longitude).toFixed(4),
      ].join('|');
      if (seen.has(key)) return null;
      seen.add(key);
      return {
        name: displayName,
        fullName,
        admin: fullName,
        province: r.admin1 || '',
        prefecture: r.admin2 || '',
        district: district || r.admin3 || r.admin4 || '',
        lat: Number(r.latitude),
        lon: Number(r.longitude),
        source: 'manual',
        locationResolved: true,
      };
    })
    .filter(Boolean)
    .slice(0, 8);
}

function pickCity() {
  const current = state.city || {};
  const currentLabel = cityFullName(current);
  const body = el(
    '<div class="weather-city-content">' +
      '<div class="weather-city-current">' +
        '<span class="weather-city-current-icon">' + icon('loc', 15) + '</span>' +
        '<div class="weather-city-current-copy">' +
          '<span>当前天气位置</span>' +
          '<strong title="' + esc(currentLabel) + '">' + esc(currentLabel) + '</strong>' +
        '</div>' +
      '</div>' +
      '<div class="weather-city-search-wrap">' +
        '<input class="input weather-city-input" id="city-kw" placeholder="输入城市、区县名称，如 咸丰 / 咸丰县" autocomplete="off">' +
      '</div>' +
      '<div class="weather-city-tip" id="city-tip">支持省、市、区、县、县级市；输入简称也能匹配</div>' +
      '<div class="weather-city-results" id="city-result" hidden></div>' +
      '<div class="weather-city-recent-wrap" id="city-recent-wrap">' +
        '<div class="weather-city-section-label">最近使用</div>' +
        '<div class="weather-city-recent" id="city-recent"></div>' +
      '</div>' +
      '<div class="weather-city-locate-row">' +
        '<button class="weather-city-locate" id="use-geo" type="button">' + icon('loc', 15) + '<span>使用当前位置定位</span></button>' +
        '<span class="weather-city-locate-hint">需要允许浏览器的定位权限</span>' +
      '</div>' +
    '</div>'
  );

  const s = sheet({ title: '选择所在城市', body, cls: 'weather-city-sheet' });
  const dialog = s.wrap.querySelector('.sheet');
  if (dialog) {
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
  }

  const recentBox = s.body.querySelector('#city-recent');
  const recentWrap = s.body.querySelector('#city-recent-wrap');
  const resBox = s.body.querySelector('#city-result');
  const kw = s.body.querySelector('#city-kw');
  const tip = s.body.querySelector('#city-tip');
  const geoButton = s.body.querySelector('#use-geo');

  const commit = (candidate) => {
    if (!candidate || !Number.isFinite(Number(candidate.lat)) || !Number.isFinite(Number(candidate.lon))) {
      toast('这个地区暂时没有可用的天气坐标，请换一个搜索结果', 'warn');
      return;
    }
    cityChoiceSeq += 1;
    geoRequestSeq += 1;
    const city = {
      name: candidate.name,
      fullName: cityFullName(candidate),
      admin: cityFullName(candidate),
      province: candidate.province || '',
      prefecture: candidate.prefecture || '',
      district: candidate.district || '',
      lat: Number(candidate.lat),
      lon: Number(candidate.lon),
      source: 'manual',
      locationResolved: true,
    };
    state.city = city;
    setGeoMode('manual');
    state.weather = null;
    ls.set('city', city);
    pushRecentCity(city);
    s.close();
    toast('已切换到 ' + cityFullName(city));
    applyCityWeather();
  };

  const renderRecent = () => {
    const rows = recentCities();
    recentWrap.hidden = rows.length === 0;
    recentBox.innerHTML = rows.map((city, index) => (
      '<button class="weather-city-chip' + (cityFullName(city) === currentLabel ? ' on' : '') + '" data-r="' + index + '" title="' + esc(cityFullName(city)) + '">' +
        '<strong>' + esc(city.name) + '</strong>' +
        '<small>' + esc(cityFullName(city)) + '</small>' +
      '</button>'
    )).join('');
    recentBox.querySelectorAll('[data-r]').forEach((button) => {
      button.onclick = () => commit(recentCities()[Number(button.dataset.r)]);
    });
  };
  renderRecent();

  const renderResults = (rows) => {
    resBox.hidden = !rows.length;
    resBox.innerHTML = rows.map((city, index) => (
      '<button class="weather-city-result" data-i="' + index + '" type="button">' +
        '<span class="weather-city-result-icon">' + icon('loc', 15) + '</span>' +
        '<span class="weather-city-result-copy">' +
          '<strong>' + esc(city.name) + '</strong>' +
          '<small>' + esc(cityFullName(city)) + '</small>' +
        '</span>' +
        '<span class="weather-city-result-arrow">' + icon('right', 13) + '</span>' +
      '</button>'
    )).join('');
    resBox.querySelectorAll('[data-i]').forEach((button) => {
      button.onclick = () => commit(rows[Number(button.dataset.i)]);
    });
  };

  let timer = 0;
  let seq = 0;
  const runSearch = async () => {
    const query = kw.value.trim();
    const requestId = ++seq;
    if (!query) {
      resBox.innerHTML = '';
      resBox.hidden = true;
      recentWrap.hidden = recentCities().length === 0;
      tip.textContent = '支持省、市、区、县、县级市；输入简称也能匹配';
      tip.classList.remove('is-warn');
      return [];
    }

    tip.textContent = '正在搜索城市和区县…';
    tip.classList.remove('is-warn');
    recentWrap.hidden = true;
    resBox.hidden = true;
    const rows = await geocodeCity(query);
    if (requestId !== seq) return [];

    if (!rows.length) {
      resBox.innerHTML = '';
      tip.textContent = '没有找到「' + query + '」，可以尝试补充“县 / 市 / 区”后缀';
      tip.classList.add('is-warn');
      return [];
    }

    tip.textContent = '找到 ' + rows.length + ' 个匹配地区，选择后立即更新天气';
    renderResults(rows);
    return rows;
  };

  kw.oninput = () => {
    clearTimeout(timer);
    timer = setTimeout(runSearch, 300);
  };
  kw.onkeydown = async (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    clearTimeout(timer);
    const rows = await runSearch();
    if (rows.length) commit(rows[0]);
  };

  geoButton.onclick = async () => {
    if (geoButton.disabled) return;
    const original = geoButton.innerHTML;
    geoButton.disabled = true;
    geoButton.innerHTML = icon('loc', 15) + '<span>正在定位…</span>';
    try {
      const city = await locate();
      if (!city) return;
      s.close();
      if (city.locationResolved) {
        toast('已定位：' + cityFullName(city));
      } else {
        toast(locationWarning(city), 'warn', 8000);
      }
      applyCityWeather();
    } finally {
      if (geoButton.isConnected) {
        geoButton.disabled = false;
        geoButton.innerHTML = original;
      }
    }
  };

  setTimeout(() => kw.focus(), 80);
}

/* 顶栏用的「简要天气」：只留一眼要看的——温度、天气、穿搭。
   湿度/风速/日出日落、小时预报、7 天预报都折进「详细天气」里 */
/* 天气卡片中的位置行：明确显示完整地区，并标注位置来源。 */
function weatherCityLineHTML(city) {
  const location = cityFullName(city);
  const sourceLabel = city?.source === 'geo'
    ? '当前位置'
    : city?.source === 'manual'
      ? '手动选择'
      : '当前天气位置';
  return '<div class="wxb-city">' +
    '<span class="wxb-location-pin">' + icon('loc', 13) + '</span>' +
    '<span class="wxb-location-copy">' +
      '<strong class="wxb-location-name" title="' + esc(location) + '">' + esc(location) + '</strong>' +
      '<small class="wxb-location-source">' + esc(sourceLabel) + (city?.locationResolved === false ? ' · 地名暂不可用' : '') + '</small>' + weatherLocationCredit(city) +
    '</span>' +
    '<span style="flex:1"></span>' +
    '<button class="icon-btn sm" data-wx-refresh title="刷新天气">' + icon('refresh', 14) + '</button>' +
  '</div>';
}

/* 顶栏简要天气：位置、温度、天气和穿搭。 */
function weatherLocationCredit(city) {
  return city?.locationProvider === 'photon'
    ? '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer" style="font-size:10px;color:var(--muted)">地名 © OpenStreetMap</a>'
    : '';
}

function weatherBriefHTML() {
  const w = state.weather?.raw;
  const c = state.city || { name: '北京', lat: 39.9042, lon: 116.4074 };
  if (!w) {
    return weatherCityLineHTML(c) +
      '<div class="wxb-main"><div class="wxb-temp">--<span class="deg">°</span></div>' +
        '<div class="wxb-side"><div class="wxb-desc">天气没加载出来</div>' +
          '<div class="wxb-range">点右上角刷新，或换个城市试试</div></div></div>';
  }
  const cur = w.current;
  const [emo, desc] = wxInfo(cur.weather_code);
  const day = w.daily;
  const rainToday = (day.precipitation_probability_max?.[0] || 0) > 40 || cur.precipitation > 0;
  return weatherCityLineHTML(c) +
    '<div class="wxb-main">' +
      '<button class="wxb-emoji-btn" type="button" data-wx-forecast title="点击查看未来一周天气" aria-label="查看未来一周天气"><span class="wxb-emoji">' + emo + '</span></button>' +
      '<span class="wxb-temp">' + Math.round(cur.temperature_2m) + '<span class="deg">°</span></span>' +
      '<div class="wxb-side">' +
        '<div class="wxb-desc">' + desc + '</div>' +
        '<div class="wxb-range">' + Math.round(day.temperature_2m_min[0]) + '° ~ ' + Math.round(day.temperature_2m_max[0]) + '° · 体感 ' + Math.round(cur.apparent_temperature) + '°</div>' +
      '</div>' +
    '</div>' +
    '<div class="wxb-outfit">' + esc(outfitFor(cur.temperature_2m, cur.weather_code, cur.wind_speed_10m, rainToday)) + '</div>';
}

function weatherHTML() {
  const w = state.weather?.raw;
  const c = state.city;
  if (!w) return `<div class="wx-top"><div style="flex:1">
      <div class="wx-city">${esc(cityFullName(c))} <button class="loc-btn" data-pick-city title="选择所在城市">${icon('loc', 11)} 选城市</button></div>
      <div class="wx-desc" style="margin-top:6px">天气没加载出来，点右上角刷新或换个城市</div></div>
      <span style="flex:1"></span>
      <button class="icon-btn" data-wx-refresh title="重新加载天气">${icon('refresh', 15)}</button></div>`;
  const cur = w.current; const [emo, desc] = wxInfo(cur.weather_code);
  const day = w.daily;
  return `
    <div class="wx-top">
      <div class="wx-city">${icon('loc', 13)} ${esc(cityFullName(c))}
        <button class="loc-btn" data-pick-city title="选择所在城市">${icon('loc', 10)} 选城市</button></div>
      <span style="flex:1"></span>
      <button class="icon-btn" data-wx-refresh title="刷新天气">${icon('refresh', 15)}</button>
    </div>
    <div class="wx-main">
      <div class="wx-temp"><span class="wx-emoji">${emo}</span>${Math.round(cur.temperature_2m)}<span class="deg">°</span></div>
      <div class="wx-right">
        <div class="wx-desc">${desc}</div>
        <div class="wx-range">体感 ${Math.round(cur.apparent_temperature)}° · 今日 ${Math.round(day.temperature_2m_min[0])}° ~ ${Math.round(day.temperature_2m_max[0])}°</div>
      </div>
    </div>`;
}

/* 天气卡的"指标 + 穿搭 + 小时"三块，展开后单独放进左列 */
function wxMetricsHTML() {
  const w = state.weather?.raw;
  if (!w) return '';
  const cur = w.current; const day = w.daily;
  const hours = [];
  const nowH = new Date();
  const hTimes = w.hourly.time;
  let startIdx = hTimes.findIndex((t) => new Date(t) >= new Date(nowH.getFullYear(), nowH.getMonth(), nowH.getDate(), nowH.getHours()));
  if (startIdx < 0) startIdx = 0;
  for (let i = startIdx; i < Math.min(startIdx + 8, hTimes.length); i++) {
    const [e] = wxInfo(w.hourly.weather_code[i]);
    const isNow = i === startIdx;
    hours.push(`<div class="wx-hour${isNow ? ' now' : ''}"><span class="tiny muted" style="color:inherit">${isNow ? '现在' : hTimes[i].slice(11, 13) + '时'}</span><span class="e">${e}</span><span class="t">${Math.round(w.hourly.temperature_2m[i])}°</span></div>`);
  }
  const rainProb = w.hourly.precipitation_probability?.[startIdx] ?? 0;
  const rainToday = (day.precipitation_probability_max?.[0] || 0) > 40 || cur.precipitation > 0;
  return `
    <div class="wx-metrics">
      <div class="wx-metric"><span class="k">${icon('drop', 11)} 湿度</span><span class="v">${cur.relative_humidity_2m}%</span></div>
      <div class="wx-metric"><span class="k">${icon('wind', 11)} 风速</span><span class="v">${Math.round(cur.wind_speed_10m)}<span class="tiny muted" style="font-weight:500"> km/h</span></span></div>
      <div class="wx-metric"><span class="k">${icon('rain', 11)} 降雨</span><span class="v">${rainProb}%</span></div>
      <div class="wx-metric"><span class="k">${icon('uv', 11)} 紫外线</span><span class="v">${Math.round(day.uv_index_max?.[0] ?? 0)}</span></div>
      <div class="wx-metric"><span class="k">${icon('sunrise', 11)} 日出</span><span class="v">${String(day.sunrise?.[0] || '').slice(11, 16)}</span></div>
      <div class="wx-metric"><span class="k">${icon('sunset', 11)} 日落</span><span class="v">${String(day.sunset?.[0] || '').slice(11, 16)}</span></div>
    </div>
    <div class="wx-outfit"><b>${icon('sun', 12)} 穿搭</b>${esc(outfitFor(cur.temperature_2m, cur.weather_code, cur.wind_speed_10m, rainToday))}</div>
    <div class="wx-hours">${hours.join('')}</div>`;
}

/* hero 下方通栏：7 天预报 */
function wxForecastHTML() {
  const w = state.weather?.raw;
  if (!w || !w.daily) return '';
  const day = w.daily;
  const lows = day.temperature_2m_min.slice(0, 7).map((x) => Math.round(x));
  const highs = day.temperature_2m_max.slice(0, 7).map((x) => Math.round(x));
  const gMin = Math.min(...lows); const gMax = Math.max(...highs);
  const span = Math.max(1, gMax - gMin);
  return `<div class="wx-days">${day.time.slice(0, 7).map((t, i) => {
    const [e] = wxInfo(day.weather_code[i]);
    const lo = lows[i]; const hi = highs[i];
    const wd = ['日', '一', '二', '三', '四', '五', '六'][new Date(t).getDay()];
    const left = ((lo - gMin) / span) * 100;
    const width = Math.max(14, ((hi - lo) / span) * 100);
    return `<div class="wx-day${i === 0 ? ' today' : ''}"><span>${i === 0 ? '今天' : '周' + wd}</span><span class="e">${e}</span>
      <span class="mono tiny">${lo}°</span><span class="wx-bar"><i style="left:${left}%;width:${width}%"></i></span><span class="mono tiny hi">${hi}°</span></div>`;
  }).join('')}</div>`;
}

/* ================= 首页渲染 ================= */
let homeData = null;
let homeCourseRows = null;
let clockTimer = null;
let clockAlign = null;
let lastGreetKey = '';
let lastFootKey = '';

registerView(async function home(main) {
  clearInterval(clockTimer);
  main.innerHTML = `<div class="empty"><div class="em">⏳</div>正在准备今天的工作台…</div>`;
  /* 首页个人信息与「我的 → 个人信息」保持同一数据源：
     每次进入首页先轻量刷新登录资料，避免另一处修改昵称/学校/学科/职务后，
     首页仍显示旧的 state.user。请求失败时保留当前会话中的资料，不清空用户态。 */
  const previousUser = state.user;
  const freshMe = await api.get('/auth/me', null).catch(() => null);
  if (freshMe?.user) state.user = freshMe.user;
  else if (previousUser) state.user = previousUser;

  // 先用上次城市的缓存/天气快速绘制首页；自动定位在首屏绘制后静默完成。
  try { await loadWeather(); } catch (e) { /* 离线降级 */ }
  // 必须显式带上浏览器本地日期：服务器可能跑在 UTC，跨零点时按它自己算
  // 会把今天算成昨天，刚记的便签就变成「存进去却看不见」。
  const [homeResult, courseRows] = await Promise.all([
    api.get('/home', { date: ymd() }),
    api.get('/courses').catch((error) => {
      console.warn('[home] 读取课表原始课程失败', error);
      return null;
    }),
  ]);
  homeData = homeResult;
  homeCourseRows = Array.isArray(courseRows) ? courseRows : null;
  renderHome();
  if (state.geoMode === 'auto') {
    locate({ silent: true }).then((city) => {
      if (city) applyCityWeather({ silent: true });
    });
  }
  /* 拉一次云端布局：另一台设备排过的话，这里自动换成那一套。
     没登录云端、或云端没有记录时什么都不会发生，本地这份照常用。 */
  pullLayoutCloud().catch(() => {});
});

/* 换城市之后统一走这里：先把天气真正换成新城市的，再只重绘天气区块。
   两件事分开做是有意的——天气是外网请求，可能慢、可能失败；
   失败了也不能让「城市名已经切了但温度还是旧的」这种半吊子状态留在页面上，
   所以失败时把旧天气清掉，让界面老实显示「天气加载中…」。 */
async function applyCityWeather({ silent = false } = {}) {
  const brief = document.getElementById('wx-brief');
  if (brief) brief.innerHTML = weatherBriefHTML();
  try {
    await loadWeather(true);
  } catch {
    state.weather = null;
    if (!silent) toast('天气没拉到，可点天气卡中的刷新按钮重试', 'warn');
  }
  renderWeatherOnly();
}

async function refreshHome() {
  const selectedDate = calState.selected;
  const calendarView = calState.view;
  const dayOpen = calState.dayOpen;
  const [homeResult, courseRows] = await Promise.all([
    api.get('/home', { date: ymd() }).catch(() => homeData),
    api.get('/courses').catch((error) => {
      console.warn('[home] 刷新课表原始课程失败', error);
      return null;
    }),
  ]);
  homeData = homeResult;
  if (Array.isArray(courseRows)) homeCourseRows = courseRows;
  renderHome();
  if (selectedDate) {
    await loadCal(selectedDate, { openDay: dayOpen });
    calState.view = calendarView;
    paintCal();
  }
}

function profileDetailsHTML(user = state.user || {}) {
  const schoolFields = [
    { key: 'school', label: '学校', value: user.school },
    { key: 'grade_group', label: '年级组', value: user.grade_group },
  ].filter((field) => field.value != null && String(field.value).trim());
  const roleFields = [
    { key: 'subject', label: '科目', value: user.subject },
    { key: 'title', label: '职务', value: user.title },
  ].filter((field) => field.value != null && String(field.value).trim());
  const renderFields = (fields) => fields.map((field, index) => `
    ${index ? '<span class="home-profile-separator" aria-hidden="true">·</span>' : ''}
    <span class="home-profile-detail-item" data-profile-field="${field.key}" aria-label="${field.label}">${esc(String(field.value).trim())}</span>
  `).join('');
  return `
    ${schoolFields.length ? `<div class="home-profile-details-school">${renderFields(schoolFields)}</div>` : ''}
    ${roleFields.length ? `
      <div class="home-profile-details-role">
        <span class="home-profile-role-line" aria-hidden="true"></span>
        <span class="home-profile-role-pill">${renderFields(roleFields)}</span>
        <span class="home-profile-role-line" aria-hidden="true"></span>
      </div>
    ` : ''}
  `;
}

function renderHome() {
  const main = document.getElementById('main');
  if (!main || !homeData) return;
  const d = homeData;
  const today = new Date();
  const nick = state.user?.nickname || '老师';
  /* 用户名要出现在问候里（「张老师，上午好」），但不能是「xx老师，上午好」这种叠字，
     所以去掉结尾的「老师」再拼。全名只有一个字时退回「老师」，避免「王，上午好」。 */
  const name = nick.replace(/老师$/, '').trim() || '老师';
  const [defaultG1, defaultG2] = greetFor(name);
  const g1 = defaultG1;
  const g2 = defaultG2;
  const todayCourses = getHomeTimetableCourses(d.courses, d.date);

  main.classList.add('home-redesign');
  main.innerHTML = `
  <div class="teacher-toolbar home-topbar">
    <div class="searchbar" id="searchbar">
      <span class="sb-ico">${icon('search',17)}</span>
      <input id="gsearch" placeholder="搜索任务 / 课程 / 笔记 / 出勤…（支持模糊与精准）" autocomplete="off" enterkeyhint="search">
      <button class="sb-clear" id="search-clear" title="清空" aria-label="清空" hidden>${icon('close',15)}</button>
      <button class="sb-go" id="search-go" title="搜索" aria-label="搜索">${icon('search',17)}</button>
    </div>
  </div>
  <div class="sr-scrim" id="search-scrim" hidden></div>
  <div class="sr-panel" id="search-result" hidden></div>
  <div class="hg-toolbar home-layout-toolbar" id="hg-toolbar" role="region" aria-label="首页布局编辑工具" hidden>
    <span class="hg-tb-title">${icon('grid',15)}<b>布局编辑</b></span>
    <span class="hg-tb-hint">拖动卡片换位置 · 拖右下角调大小</span>
    <span class="hg-tb-spacer"></span>
    <button class="btn ghost sm" id="hg-manage" type="button">卡片管理</button>
    <button class="btn ghost sm" id="hg-reset" type="button">恢复默认</button>
    <button class="btn ghost sm" id="hg-cancel" type="button">取消</button>
    <button class="btn primary sm" id="hg-save" type="button">保存布局</button>
  </div>
  <div class="hg-grid home-dashboard-grid" id="home-grid">
    <div class="hg-item" data-hcard="profile">
      <span class="hg-grip" data-hg-grip title="拖动调整位置">${icon('grid',14)}</span>
      <button class="hg-hide" data-hg-hide title="隐藏">${icon('close',13)}</button>
      <span class="hg-resize" data-hg-resize title="调整大小"></span>
      <section class="card home-welcome-card">
        <div class="home-profile-heading">${icon('user',18)}<span>个人名片</span></div>
        <div class="home-profile-actions" role="group" aria-label="个人卡片快捷操作">
          <button class="home-action home-action-secondary" id="theme-btn" type="button" title="更换首页及工作台主题外观">${icon('sun',16)}<span>更换外观</span></button>
          <button class="home-action teacher-layout-btn" id="teacher-layout" type="button" aria-pressed="false" title="编辑首页卡片布局">${icon('grid',16)}<span>编辑布局</span></button>
        </div>
        <div class="home-profile-head">
          ${homeAvatarHTML(64)}
          <div class="home-profile-info">
            <div class="clk-greet" id="greet-line">${esc(g1)}</div>
            <div class="clk-greet-sub" id="greet-sub">${esc(g2)}</div>
          </div>
          <div class="home-profile-details" id="home-profile-details">${profileDetailsHTML()}</div>
        </div>
        <div class="home-quote">
          <div class="home-quote-head">
            <div class="home-quote-title">每日一句</div>
            <button class="btn ghost sm" id="quote-next" title="换一句">${icon('refresh',14)} 换一句</button>
          </div>
          <div class="quote-en"><span class="qt" id="q-en">${esc(d.quote.en)}</span></div>
          <div class="quote-zh" id="q-zh">${esc(d.quote.zh)}</div>
          <div class="quote-author" id="q-author">— ${esc(d.quote.author||'')}</div>
          <button class="speak-btn" id="speak-btn" title="朗读英文" aria-label="朗读英文">${icon('speak',15)}</button>
        </div>
      </section>
    </div>
    <div class="hg-item" data-hcard="timeline">
      <span class="hg-grip" data-hg-grip title="拖动调整位置">${icon('grid',14)}</span>
      <button class="hg-hide" data-hg-hide title="隐藏">${icon('close',13)}</button>
      <span class="hg-resize" data-hg-resize title="调整大小"></span>
      <section class="card home-clock-card">
        <div class="home-clock-top">
          <div class="home-card-title">${icon('clock',19)}<span>日期与时间</span></div>
          <div class="clock-date" id="clock-date"></div>
        </div>
        <div class="home-clock-main">
          <div class="home-clock-time-wrap">
            <div class="clock" id="clock"><span class="hm">--:--</span><span class="sec">--</span></div>
          </div>
          <div class="home-clock-foot"><span>今日剩余</span><strong id="home-day-remaining">--:--:--</strong></div>
          <div class="home-day-progress-wrap" aria-label="今日时间进度">
            <svg viewBox="0 0 100 100" role="img" aria-hidden="true">
              <circle class="home-day-track" cx="50" cy="50" r="41"></circle>
              <circle class="home-day-ring" id="home-day-ring" cx="50" cy="50" r="41"></circle>
            </svg>
            <div class="home-day-progress-text"><b id="home-day-progress">0%</b><span>今日已过</span></div>
          </div>
        </div>
      </section>
    </div>
    <div class="hg-item" data-hcard="todayCourse">
      <span class="hg-grip" data-hg-grip title="拖动调整位置">${icon('grid',14)}</span>
      <button class="hg-hide" data-hg-hide title="隐藏">${icon('close',13)}</button>
      <span class="hg-resize" data-hg-resize title="调整大小"></span>
      <section class="card home-card home-course-card">
        <div class="home-card-head">
          <div class="home-card-title">${icon('book',20)}<span id="home-course-day-title">今日上课提醒</span><span class="home-count-chip" id="home-course-count">${todayCourses.length}</span></div>
          <button class="home-card-link" data-goto2="work/timetable" type="button">查看课表 ${icon('right',13)}</button>
        </div>
        <div class="card-pad hc-body" id="today-courses"></div>
      </section>
    </div>
    <div class="hg-item" data-hcard="todayTodo">
      <span class="hg-grip" data-hg-grip title="拖动调整位置">${icon('grid',14)}</span>
      <button class="hg-hide" data-hg-hide title="隐藏">${icon('close',13)}</button>
      <span class="hg-resize" data-hg-resize title="调整大小"></span>
      <section class="card home-card home-todo-card">
        <div class="home-card-head">
          <div class="home-card-title">${icon('check',19)}<span id="home-todo-day-title">今日事项</span><span class="home-count-chip" id="home-todo-count">${(d.items||[]).filter(t=>t.status!=='done').length}</span></div>
          <button class="home-card-link" id="home-new-item" data-add-item2 type="button">＋ 新增</button>
        </div>
        <div class="home-quick-add">
          <div class="home-quick-input-wrap">
            <input class="home-quick-input" id="quick-input" type="text" placeholder="快速添加所选日期事项，回车即可保存…" autocomplete="off">
            <button class="home-quick-time" id="quick-time" type="button" title="设置提醒时间" aria-label="设置提醒时间">${icon('clock',15)}</button>
          </div>
          <button class="home-quick-save" id="quick-save" type="button">添加</button>
          <div class="home-quick-hint" id="quick-hint"></div>
        </div>
        <div class="card-pad hc-body" id="today-items"></div>
      </section>
    </div>
    <div class="hg-item" data-hcard="calendar">
      <span class="hg-grip" data-hg-grip title="拖动调整位置">${icon('grid',14)}</span>
      <button class="hg-hide" data-hg-hide title="隐藏">${icon('close',13)}</button>
      <span class="hg-resize" data-hg-resize title="调整大小"></span>
      <section class="card card-pad calendar-card home-card home-calendar-card">
        <div class="hc-head hc-head-cal">
          <div class="cal-head" style="flex:1;margin:0">
            <div class="cal-heading"><div class="cal-heading-main">${icon('cal',18)}<strong class="cal-heading-label">日历</strong></div><span class="cal-title" id="cal-title"></span></div><span style="flex:1"></span>
            <button class="cal-nav" id="cal-prev" title="上个月" aria-label="上个月">${icon('left',18)}</button>
            <button class="cal-nav" id="cal-next" title="下个月" aria-label="下个月">${icon('right',18)}</button>
            <button class="btn ghost sm" id="cal-fold" title="收起成这一周">${icon('up',14)} <span id="cal-fold-txt">周</span></button>
            <button class="btn ghost sm" id="cal-today">今天</button>
            <button class="month-btn" id="cal-jump" title="选择年月">${icon('cal',15)}<span>年月</span></button>
            <input type="month" id="cal-month-input" class="month-hidden" aria-hidden="true" tabindex="-1">
          </div>
        </div>
        <div class="cal-week">${['日','一','二','三','四','五','六'].map((x,i)=>'<span class="'+(i===0||i===6?'we':'')+'">'+x+'</span>').join('')}</div>
        <div class="cal-grid" id="cal-grid"></div>
        <div class="cal-day" id="cal-day" hidden></div>
        <div class="cal-legend"><span><i style="background:var(--primary)"></i>上课</span><span><i style="background:var(--amber)"></i>监考/出差</span><span><i style="background:var(--green)"></i>教研</span><span><i style="background:var(--red)"></i>提醒</span></div>
      </section>
    </div>
    <div class="hg-item" data-hcard="weather">
      <span class="hg-grip" data-hg-grip title="拖动调整位置">${icon('grid',14)}</span>
      <button class="hg-hide" data-hg-hide title="隐藏">${icon('close',13)}</button>
      <span class="hg-resize" data-hg-resize title="调整大小"></span>
      <section class="card wx-card home-weather-card" id="wx-card">
        <div class="home-card-head">
          <div class="home-card-title">${icon('sun',20)}<span>今日天气</span></div>
          <button class="loc-btn" id="wx-city-pick" data-pick-city type="button" title="自动定位或手动切换城市">${icon('loc',13)} 切换城市</button>
        </div>
        <div class="wx-body">
          <div id="wx-brief">${weatherBriefHTML()}</div>
        </div>
        <div class="home-weather-footer">
          <button class="home-card-link" id="wx-more" type="button">详细天气 ${icon('right',13)}</button>
        </div>
      </section>
    </div>
    <div class="hg-item" data-hcard="weekLessons">
      <span class="hg-grip" data-hg-grip title="拖动调整位置">${icon('grid',14)}</span><button class="hg-hide" data-hg-hide title="隐藏">${icon('close',13)}</button><span class="hg-resize" data-hg-resize title="调整大小"></span>
      <section class="card home-mini-card"><div class="home-mini-head"><span class="home-mini-icon blue">${icon('book',20)}</span><b>本周课时</b><button class="home-card-link" data-goto2="work/lessons" type="button">详情</button></div><div class="home-mini-body" id="home-week-lessons"><span class="mini-loading">正在统计…</span></div></section>
    </div>
    <div class="hg-item" data-hcard="invigilation">
      <span class="hg-grip" data-hg-grip title="拖动调整位置">${icon('grid',14)}</span><button class="hg-hide" data-hg-hide title="隐藏">${icon('close',13)}</button><span class="hg-resize" data-hg-resize title="调整大小"></span>
      <section class="card home-mini-card invig-mini-card"><div class="home-mini-head"><span class="home-mini-icon orange">${icon('shield',20)}</span><b>监考任务</b><button class="home-card-link" data-goto2="work/invigilation" type="button">详情</button></div><div class="home-mini-body" id="home-invig-summary"><span class="mini-loading">正在统计…</span></div></section>
    </div>
    <div class="hg-item" data-hcard="prepDeadline">
      <span class="hg-grip" data-hg-grip title="拖动调整位置">${icon('grid',14)}</span><button class="hg-hide" data-hg-hide title="隐藏">${icon('close',13)}</button><span class="hg-resize" data-hg-resize title="调整大小"></span>
      <section class="card home-mini-card prep-mini-card"><div class="home-mini-head"><span class="home-mini-icon blue">${icon('file',20)}</span><b>备课截止</b><button class="home-card-link" data-goto2="work/prep" type="button">备课</button></div><div class="home-mini-body" id="home-prep-deadline"><span class="mini-loading">正在检查…</span></div></section>
    </div>
    <div class="hg-item" data-hcard="recentNotes">
      <span class="hg-grip" data-hg-grip title="拖动调整位置">${icon('grid',14)}</span><button class="hg-hide" data-hg-hide title="隐藏">${icon('close',13)}</button><span class="hg-resize" data-hg-resize title="调整大小"></span>
      <section class="card home-mini-card notes-mini-card"><div class="home-mini-head"><span class="home-mini-icon blue">${icon('edit',20)}</span><b>最近笔记</b><button class="home-card-link" data-goto2="work/notes" type="button">全部</button></div><div class="home-mini-body" id="home-recent-notes"><span class="mini-loading">正在读取…</span></div></section>
    </div>
  </div>`;
  applyHomeSidebar();
  bindHome();
  /* 卡片位置、拖拽、缩放、隐藏全部交给 homegrid。
     renderHome 每次都重建 DOM，所以这里必须每次重挂一次，
     否则任何一次刷新都会把用户排好的布局冲回默认。 */
  mountGrid(document.getElementById('home-grid'));
  // 每次重建 DOM 后，"上次渲染过什么"的记忆必须清掉，
  // 否则 refreshHome() 之后新节点会因为 key 没变而一直空着（周数行曾因此整行空白）
  lastFootKey = '';
  lastGreetKey = '';
  cdKey = '';
  startClock();
  renderTodayItems();
  renderTodayCourses();
  loadCal(ymd(today));
  loadHomeMsgs();
  loadHomeExtras();
}

/* 一年中的第几周（ISO 周，周一为一周第一天） */
function isoWeek(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
}

function startClock() {
  clearInterval(clockTimer);
  const paint = () => {
    const now = new Date();
    const c = document.getElementById('clock');
    if (!c) { clearInterval(clockTimer); return; }
    // 每秒只改这三个数字节点，不动 DOM 结构、不重建 —— 否则手机每秒重排一次，很烫
    const hm = c.querySelector('.hm');
    const sec = c.querySelector('.sec');
    if (hm) hm.textContent = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
    if (sec) sec.textContent = pad2(now.getSeconds());

    const elapsedSeconds = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
    const dayProgress = elapsedSeconds / 86400;
    const progressLabel = document.getElementById('home-day-progress');
    const progressRing = document.getElementById('home-day-ring');
    const remainingLabel = document.getElementById('home-day-remaining');
    if (progressLabel) progressLabel.textContent = `${Math.floor(dayProgress * 100)}%`;
    if (progressRing) progressRing.style.strokeDashoffset = String(2 * Math.PI * 41 * (1 - dayProgress));
    if (remainingLabel) {
      const remaining = Math.max(0, 86400 - elapsedSeconds);
      remainingLabel.textContent = `${pad2(Math.floor(remaining / 3600))}:${pad2(Math.floor((remaining % 3600) / 60))}:${pad2(remaining % 60)}`;
    }

    const dEl = document.getElementById('clock-date');
    if (dEl) {
      const wd = now.getDay();
      const weekend = wd === 0 || wd === 6;
      dEl.innerHTML = `<span class="home-date-full">${now.getFullYear()}-${pad2(now.getMonth()+1)}-${pad2(now.getDate())}</span>`
        + `<span class="wd-badge${weekend ? ' weekend' : ''}">${WD_CN[wd]}</span>`
        + `<span class="home-week-badge">第 ${isoWeek(now)} 周</span>`;
    }
    // 周数 / 本月剩余天数：一天只变一次，用 key 挡住，别每秒重算
    const footKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
    const foot = document.getElementById('clk-foot');
    if (foot && footKey !== lastFootKey) {
      lastFootKey = footKey;
      const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
      const left = daysInMonth - now.getDate();
      foot.innerHTML = `<span>第 ${isoWeek(now)} 周</span><i></i>`
        + `<span>${left > 0 ? `本月还剩 <b>${left}</b> 天` : '本月最后一天'}</span>`;
    }

    /* 分钟变化时校正问候语——现在只有跨时段（比如 08:59→09:00）才会真变，
       剩下的分钟只是把同一个字符串再写一遍，代价可以忽略。
       这里必须用和 renderHome 完全一致的取名规则，否则昵称里的「老师」
       会在跨时段那一瞬间被去重成「xx，上午好」，而首屏是「xx老师，上午好」。 */
    const key = `${Math.floor(Date.now() / 60000)}`;
    if (key !== lastGreetKey) {
      lastGreetKey = key;
      const nick = state.user?.nickname || '老师';
      const nm = nick.replace(/老师$/, '').trim() || '老师';
      const [title, subtitle] = greetFor(nm);
      const g = document.getElementById('greet-line');
      if (g && g.textContent !== title) g.textContent = title;
      const sub = document.getElementById('greet-sub');
      if (sub) sub.textContent = subtitle || '专注教学 · 高效管理 · 陪伴学生成长';
      const profileDetails = document.getElementById('home-profile-details');
      const nextProfileDetails = profileDetailsHTML();
      if (profileDetails && profileDetails.innerHTML !== nextProfileDetails) {
        profileDetails.innerHTML = nextProfileDetails;
      }
    }
  };
  paint();
  if (clockAlign) clearTimeout(clockAlign);
  // 对齐到整秒再起 1s 心跳，秒数跳变更准
  clockAlign = setTimeout(() => {
    clearInterval(clockTimer);
    paint();
    clockTimer = setInterval(paint, 1000);
  }, 1000 - (Date.now() % 1000));
  clockTimer = setInterval(paint, 1000);
}


function timelineTime(value){const m=String(value||'').match(/(?:T|^)(\d{1,2}):(\d{2})/);return m?Number(m[1])*60+Number(m[2]):null;}
function renderTimeline(){
 const times=document.getElementById('home-timeline-times'),track=document.getElementById('home-timeline-track');if(!times||!track||!homeData)return;
 const day=homeData.date,startMin=480,endMin=1080,span=600;
 times.innerHTML=Array.from({length:11},(_,i)=>'<span>'+String(8+i).padStart(2,'0')+':00</span>').join('');
 const events=[],add=e=>{if(e.start==null)return;const finish=e.end==null||e.end<=e.start?e.start+45:e.end;if(finish<startMin||e.start>endMin)return;events.push(Object.assign({},e,{end:finish}));};
 for(const c of homeData.courses||[])if(c.date===day)add({kind:'course',start:timelineTime(c.start_time),end:timelineTime(c.end_time),title:c.class_name||'课程',sub:[c.subject,c.room].filter(Boolean).join(' · '),period:c.period_no,className:c.class_name,subject:c.subject});
 for(const g of homeData.invigilations||[]){const date=g.date||String(g.start_at||'').slice(0,10);if(date===day)add({kind:'invig',start:timelineTime(g.start_time||g.start_at),end:timelineTime(g.end_time||g.end_at),title:g.exam_name||g.subject||'监考',sub:['监考',g.room||g.place].filter(Boolean).join(' · '),id:g.id});}
 for(const item of homeData.items||[])if(item.status!=='done'&&item.start_at&&String(item.start_at).slice(0,10)===day)add({kind:/教研|会议/.test(String(item.title||'')+' '+String(item.kind||''))?'meeting':'task',start:timelineTime(item.start_at),end:timelineTime(item.end_at),title:item.title||'待办',sub:item.kind||'待办',id:item.id});
 events.sort((a,b)=>a.start-b.start||a.end-b.end);const lanes=[-1,-1];
 const html=events.map(e=>{let lane=lanes.findIndex(x=>e.start>=x);if(lane<0)lane=lanes[0]<=lanes[1]?0:1;lanes[lane]=e.end;
  const left=Math.max(0,(Math.max(e.start,startMin)-startMin)/span*100),right=Math.min(100,(Math.min(e.end,endMin)-startMin)/span*100),width=Math.max(5.5,right-left);
  const time=String(Math.floor(e.start/60)).padStart(2,'0')+':'+String(e.start%60).padStart(2,'0');
  const attrs=e.kind==='course'?'data-timeline-kind="course" data-period="'+esc(e.period)+'" data-class="'+esc(e.className)+'" data-subject="'+esc(e.subject)+'"':'data-timeline-kind="'+e.kind+'" data-id="'+esc(e.id||'')+'"';
  return '<button class="timeline-event '+e.kind+'" '+attrs+' style="--event-left:'+left+'%;--event-width:'+Math.min(width,100-left)+'%;--event-lane:'+lane+'" type="button" title="'+esc(time+' '+e.title+' '+e.sub)+'"><b>'+time+'</b><span>'+esc(e.title)+'</span></button>';}).join('');
 const now=new Date(),minute=now.getHours()*60+now.getMinutes(),marker=minute>=startMin&&minute<=endMin&&day===ymd(now)?'<div class="timeline-now" id="home-timeline-now" style="left:'+((minute-startMin)/span*100)+'%"><i></i></div>':'';
 track.innerHTML=events.length?marker+html:'<div class="timeline-empty">今天暂无固定时间安排，点击右上角新建事项或课表</div>';
 track.querySelectorAll('[data-timeline-kind]').forEach(b=>{b.onclick=()=>{const k=b.dataset.timelineKind;if(k==='course')return go('work/timetable');if(k==='invig')return go('work/invigilation');if(k==='task'||k==='meeting'){const item=(homeData.items||[]).find(x=>String(x.id)===b.dataset.id);if(item)editItem(item);}};});
}
let homeExtraSeq=0;
async function loadHomeExtras(){
 const seq=++homeExtraSeq,anchor=new Date((homeData?.date||ymd())+'T00:00:00'),offset=(anchor.getDay()+6)%7,weekStart=new Date(anchor);
 weekStart.setDate(anchor.getDate()-offset);const weekEnd=new Date(weekStart);weekEnd.setDate(weekStart.getDate()+6);
 const dk=d=>d.getFullYear()+'-'+pad2(d.getMonth()+1)+'-'+pad2(d.getDate()),mk=d=>d.getFullYear()+'-'+pad2(d.getMonth()+1),from=dk(weekStart),to=dk(weekEnd),months=[...new Set([mk(weekStart),mk(weekEnd)])];
 const [bundles,preps,notes,items]=await Promise.all([
  Promise.all(months.map(async month=>{const [calendar,lessons,invig]=await Promise.all([month===String(homeData?.date||'').slice(0,7)?Promise.resolve({courses:homeData?.courses_month||[]}):api.get('/calendar',{month}).catch(()=>({courses:[]})),api.get('/class_records?class_month='+month).catch(()=>[]),api.get('/invig/summary?month='+month).catch(()=>({rows:[]}))]);return{courses:calendar?.courses||[],lessons:Array.isArray(lessons)?lessons:[],invigilations:invig?.rows||[]};})),
  api.get('/preps').catch(()=>[]),api.get('/notes').catch(()=>[]),api.get('/items').catch(()=>[])
 ]);
 if(seq!==homeExtraSeq||!document.getElementById('home-week-lessons'))return;
 const inWeek=v=>{const d=String(v||'').slice(0,10);return d>=from&&d<=to;},courses=bundles.flatMap(x=>x.courses).filter(x=>inWeek(x.date)),lessons=bundles.flatMap(x=>x.lessons).filter(x=>{const m=String(x.class_time||'').match(/(20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2})/);return m&&inWeek(m[1].replace(/[/.年]/g,'-').replace('月','-').replace('日',''));}),invigs=bundles.flatMap(x=>x.invigilations).filter(x=>inWeek(x.date));
 const done=lessons.length,planned=courses.length,left=Math.max(0,planned-done),pct=planned?Math.min(100,Math.round(done/planned*100)):0,week=document.getElementById('home-week-lessons');
 if(week)week.innerHTML=planned?'<div class="mini-number-row"><span>已上 <b>'+done+'</b> 节</span><span>剩余 <b>'+left+'</b> 节</span></div><div class="mini-progress"><i style="width:'+pct+'%"></i></div><div class="mini-foot">周课时进度 '+pct+'% · 计划 '+planned+' 节</div>':'<div class="mini-empty">本周暂无课表安排</div>';
 const inv=document.getElementById('home-invig-summary');if(inv){const next=[...invigs].sort((a,b)=>String(a.date+a.start_time).localeCompare(String(b.date+b.start_time)))[0];inv.innerHTML='<div class="mini-number-row"><span>本周 <b>'+invigs.length+'</b> 场</span></div><div class="mini-foot">'+(next?'下一场：'+esc(String(next.date||'').slice(5))+' '+esc(next.start_time||'')+' '+esc(next.exam_name||next.subject||'监考'):'本周暂无监考安排')+'</div>';}
 const now=Date.now(),deadlines=(Array.isArray(items)?items:[]).filter(x=>x.status!=='done'&&/备课|课件|教案|提交/.test(String(x.title||'')+' '+String(x.kind||''))).map(item=>({item,at:item.due_at||item.end_at||item.start_at})).filter(x=>x.at&&Number.isFinite(new Date(x.at).getTime())&&new Date(x.at).getTime()>=now).sort((a,b)=>new Date(a.at)-new Date(b.at));
 const prep=document.getElementById('home-prep-deadline');if(prep){if(deadlines.length){const item=deadlines[0].item;prep.innerHTML='<div class="mini-primary-line">'+esc(item.title)+'</div><div class="mini-foot">截止时间：'+esc(fmtDateTime(deadlines[0].at))+'</div>';}else{const next=(Array.isArray(preps)?preps:[]).filter(p=>(p.status||'doing')!=='done'&&String(p.date||'')>=from).sort((a,b)=>String(a.date||'').localeCompare(String(b.date||'')))[0];prep.innerHTML=next?'<div class="mini-primary-line">'+esc(next.topic||'备课记录')+'</div><div class="mini-foot">最近备课：'+esc(next.date||'日期未定')+' · 尚无单独截止时间</div>':'<div class="mini-empty">暂无待提交课件</div>';}}
 const recent=document.getElementById('home-recent-notes');if(recent){const list=(Array.isArray(notes)?notes:[]).sort((a,b)=>String(b.updated_at||b.created_at||'').localeCompare(String(a.updated_at||a.created_at||''))).slice(0,2);recent.innerHTML=list.length?list.map(n=>'<button class="recent-note-row" type="button" data-open-recent-notes><span>•</span><b>'+esc(n.title||'未命名笔记')+'</b></button>').join(''):'<div class="mini-empty">还没有笔记，写下第一条灵感吧</div>';recent.querySelectorAll('[data-open-recent-notes]').forEach(b=>{b.onclick=()=>go('work/notes');});}
}

function homeDayCaption(date) {
  return date === homeData?.date ? '今日' : `${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日`;
}
function updateHomeDayHeadings(date, items = null, courses = null) {
  const caption = homeDayCaption(date);
  const todoTitle = document.getElementById('home-todo-day-title');
  const courseTitle = document.getElementById('home-course-day-title');
  const todoCount = document.getElementById('home-todo-count');
  const courseCount = document.getElementById('home-course-count');
  if (todoTitle) todoTitle.textContent = caption + '事项';
  if (courseTitle) courseTitle.textContent = caption + '上课提醒';
  if (todoCount && Array.isArray(items)) todoCount.textContent = String(items.filter((item) => item.status !== 'done').length);
  if (courseCount && Array.isArray(courses)) courseCount.textContent = String(courses.length);
}
function renderHomeDayLoading(date) {
  updateHomeDayHeadings(date);
  const items = document.getElementById('today-items');
  const courses = document.getElementById('today-courses');
  if (items) items.innerHTML = '<div class="empty" style="padding:20px">正在读取所选日期事项…</div>';
  if (courses) courses.innerHTML = '<div class="empty" style="padding:20px">正在读取所选日期课程…</div>';
}
function renderHomeDayPanels(date, dayData) {
  const items = Array.isArray(dayData?.items) ? dayData.items : [];
  const courses = Array.isArray(dayData?.courses) ? dayData.courses : [];
  const lessons = Array.isArray(dayData?.lessons) ? dayData.lessons : [];
  updateHomeDayHeadings(date, items, courses);
  renderTodayItems(items, date);
  renderTodayCourses(courses, lessons, date);
}
function renderTodayItems(rowsOverride = null, dateOverride = '') {
  const box = document.getElementById('today-items');
  if (!box || !homeData) return;
  const date = dateOverride || homeData.date;
  const rows = Array.isArray(rowsOverride) ? rowsOverride : (homeData.items || []);
  updateHomeDayHeadings(date, rows, null);
  if (!rows.length) {
    box.innerHTML = `<div class="empty" style="padding:20px">${date === homeData.date ? '今天还没有事项' : '这一天还没有事项'}，点击「＋ 新增」添加</div>`;
    return;
  }
  box.innerHTML = rows.map((it) => {
    const t = it.start_at ? fmtTime(it.start_at) : '';
    const done = it.status === 'done';
    return `<div class="task-row" data-item="${esc(it.id)}">
      <span class="prio ${esc(it.priority || 'normal')}"></span>
      <button class="task-check ${done ? 'done' : ''}" data-check="${esc(it.id)}" data-status="${esc(it.status || 'todo')}" aria-label="${done ? '标记为未完成' : '标记为完成'}">${done ? icon('check', 14) : ''}</button>
      <div class="task-main" data-edit-item="${esc(it.id)}">
        <div class="task-title ${done ? 'done' : ''}">${esc(it.title)}</div>
        <div class="task-sub">${it.kind !== '事项' ? `<span class="chip" style="height:19px;font-size:10.5px">${esc(it.kind)}</span>` : ''}${it.detail ? esc(it.detail) : ''}${it.source === '便签' ? '<span class="chip amber" style="height:19px;font-size:10.5px">来自便签</span>' : ''}${t ? `<span class="task-time">${t}</span>` : ''}</div>
      </div>
      <select class="home-task-status" data-home-status="${esc(it.id)}" aria-label="${esc(it.title)}的状态">${[['todo', '待完成'], ['doing', '进行中'], ['done', '已完成']].map(([value, label]) => `<option value="${value}" ${it.status === value ? 'selected' : ''}>${label}</option>`).join('')}</select>
    </div>`;
  }).join('');
  const setItemStatus = async (id, nextStatus) => {
      const controls = box.querySelectorAll('[data-check="' + id + '"], [data-home-status="' + id + '"]');
      controls.forEach(control => { control.disabled = true; });
      try {
        await api.patch('/items/' + id, { status: nextStatus });
        const item = rows.find((row) => String(row.id) === id);
        if (item) item.status = nextStatus;
        if (date === homeData.date) {
          const todayItem = (homeData.items || []).find((row) => String(row.id) === id);
          if (todayItem) todayItem.status = nextStatus;
        }
        if (nextStatus === 'done') toast('已完成');
        renderTodayItems(rows, date);
        await refreshUnread();
        if (calState.dayOpen && calState.selected === date) await loadDay(date);
      } catch (error) {
        toast(error.message || '更新事项失败', 'err');
        renderTodayItems(rows, date);
      }
  };
  box.querySelectorAll('[data-check]').forEach((button) => {
    button.onclick = () => setItemStatus(button.dataset.check, button.dataset.status === 'done' ? 'todo' : 'done');
  });
  box.querySelectorAll('[data-home-status]').forEach(select => { select.onchange = () => setItemStatus(select.dataset.homeStatus, select.value); });
  box.querySelectorAll('[data-edit-item]').forEach((button) => {
    button.onclick = () => {
      const item = rows.find((row) => String(row.id) === button.dataset.editItem);
      if (!item) return;
      syncDay(date, 'items');
      jumpCalTo(date);
      editItem(item, date);
    };
  });
}

/* 把日历跳到指定日期：跨月就换月，同月只换选中。
   跨月必须重新 loadCal，因为月视图里的日期格子是按当前月画的——
   只把 selected 改成一个别的月份的日期，paintCal() 找不到那个格子，等于什么都没发生。 */
function jumpCalTo(date) {
  if (!date) return;
  const grid = document.getElementById('cal-grid');
  if (!grid) return;                 /* 首页没渲染完或不在首页，静默跳过 */
  const month = String(date).slice(0, 7);
  if (calState.month !== month) {
    loadCal(date);
    return;
  }
  setCalendarDayOpen(false);
  calState.selected = date;
  paintCal();
}

/* 日历选择日期后，两张业务卡片同步显示对应日期；内容由 /calendar/day 返回的真实数据驱动。 */
document.addEventListener(DAY_SYNC, (event) => {
  const { date, source } = event.detail || {};
  if (!date || source === 'items') return;
  updateHomeDayHeadings(date);
});
function renderTodayCourses(coursesOverride = null, lessonsOverride = null, dateOverride = '') {
  const box = document.getElementById('today-courses');
  if (!box || !homeData) return;
  const date = dateOverride || homeData.date;
  const allCourses = Array.isArray(coursesOverride) ? coursesOverride : (homeData.courses || []);
  if (!Array.isArray(homeCourseRows)) {
    updateHomeDayHeadings(date, null, []);
    box.innerHTML = '<div class="empty" style="padding:20px">课表数据暂时无法读取，请刷新首页重试</div>';
    return;
  }
  const list = getHomeTimetableCourses(allCourses, date);
  const lessonRows = Array.isArray(lessonsOverride) ? lessonsOverride : (homeData.lessons || []);
  updateHomeDayHeadings(date, null, list);
  if (!list.length) {
    box.innerHTML = `<div class="empty" style="padding:20px">${date === homeData.date ? '今天没有课，好好备课或休息一下' : '这一天没有课程安排'}</div>`;
    return;
  }
  const today = ymd(new Date());
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  const dayRelation = date.localeCompare(today);
  const lessonPath = (course) => 'work/lessons?add=1&period=' + encodeURIComponent(course.period_no)
    + '&class=' + encodeURIComponent(course.class_name || '')
    + '&subject=' + encodeURIComponent(course.subject || '');
  box.innerHTML = list.map((course) => {
    const start = String(course.start_time || '00:00').slice(0, 5).split(':').map(Number);
    const end = String(course.end_time || '00:00').slice(0, 5).split(':').map(Number);
    const startMinute = (start[0] || 0) * 60 + (start[1] || 0);
    const endMinute = (end[0] || 0) * 60 + (end[1] || 0);
    const status = dayRelation < 0 ? 'done' : dayRelation > 0 ? 'upcoming'
      : nowMin < startMinute ? 'upcoming' : nowMin <= endMinute ? 'ongoing' : 'done';
    const labels = { upcoming: '未开始', ongoing: '进行中', done: '已完成' };
    const recorded = lessonRows.some((row) =>
      String(row.date || '') === String(course.date || date)
      && Number(row.period_no) === Number(course.period_no)
      && String(row.class_name || '').trim() === String(course.class_name || '').trim()
      && String(row.subject || '').trim() === String(course.subject || '').trim()
    );
    const action = status === 'upcoming'
      ? { type: 'timetable', label: '查看课表' }
      : status === 'ongoing'
        ? { type: 'add', label: '记进度' }
        : recorded
          ? { type: 'view', label: '查看记录' }
          : { type: 'add', label: '补记进度' };
    return `<div class="course-row course-${status}">
      <span class="course-bar" style="background:${colorOf(course.class_name)}"></span>
      <span class="course-time">${esc(String(course.start_time || '').slice(0, 5))}<br><span class="muted">${esc(String(course.end_time || '').slice(0, 5))}</span></span>
      <div class="course-main">
        <div class="course-name">${esc(course.class_name)} <span class="small muted">${esc(course.subject)} · 第${esc(course.period_no)}节</span></div>
        <div class="course-meta">
          <span class="course-room">${esc(course.room || '')}</span>
          <span class="course-state state-${status}">${labels[status]}</span>
          ${course.rescheduled ? '<span class="chip amber" style="height:18px;font-size:10px">已调课</span>' : ''}
        </div>
      </div>
      <button class="btn ghost sm course-action" data-course-action="${action.type}"
        data-period="${esc(course.period_no)}" data-class="${esc(course.class_name)}" data-subject="${esc(course.subject)}">${action.label}</button>
    </div>`;
  }).join('');
  box.querySelectorAll('[data-course-action]').forEach((button) => {
    button.onclick = () => {
      const action = button.dataset.courseAction;
      if (action === 'timetable') return go('work/timetable');
      if (action === 'view') return go('work/lessons');
      go(lessonPath({
        period_no: button.dataset.period,
        class_name: button.dataset.class,
        subject: button.dataset.subject,
      }));
    };
  });
}



/* 倒计时（通栏横条）
   两个原则：
   1) 每秒只改 4 个数字的 textContent，绝不重建 innerHTML —— 否则每秒一次 DOM 抖动 + 重绑事件
   2) 今天的事全过去了，就退到"明天上午第一个"，晚上打开首页也知道明天几点得起 */
let cdTimer = null;
let cdKey = '';          // 当前倒计时目标的标识，变了才重建结构
let cdNext = null;       // 当前目标

function collectCdCands(now) {
  const out = [];
  for (const it of homeData.items || []) {
    if (it.status === 'done') continue;
    const t = it.start_at ? parseDT(it.start_at) : null;
    if (t && t > now) out.push({ title: it.title, at: t, type: '事项', id: it.id });
  }
  for (const c of homeData.courses || []) {
    const t = parseDT(`${c.date}T${c.start_time || '00:00'}`);
    if (t > now) out.push({ title: `${c.class_name} ${c.subject}`, at: t, type: '上课', id: c.course_id, period: c.period_no });
  }
  for (const i of homeData.invigilations || []) {
    const t = i.start_at ? parseDT(i.start_at) : null;
    if (t && t > now) out.push({ title: `${i.subject} 监考`, at: t, type: '监考' });
  }
  for (const r of (homeData.upcoming || [])) {
    if (r.status === 'scheduled' && r.fire_at > Date.now() - 60000) {
      out.push({ title: r.title, at: new Date(r.fire_at), type: '提醒', rid: r.id });
    }
  }
  out.sort((a, b) => a.at - b.at);
  return out;
}

function paintCountdown() {
  const box = document.getElementById('cd-body');
  if (!box || !homeData) return;
  const now = new Date();
  const cands = collectCdCands(now);
  const TYPE_LABEL = { 事项: '事项', 上课: '上课', 监考: '监考', 提醒: '提醒' };

  // 今天没剩的了 → 看接下来 24 小时内还有没有（通常是明天上午的课）
  let next = cands[0] || null;
  let isTomorrow = false;
  if (next) {
    const sameDay = ymd(next.at) === ymd(now);
    isTomorrow = !sameDay;
  }

  const key = next ? `${next.type}-${next.title}-${next.at.getTime()}` : 'none';
  if (key === cdKey && box.dataset.mode === (next ? (isTomorrow ? 'next-day' : 'now') : 'none')) {
    // 结构没变：只更新数字，省掉每秒一次的重排
    if (next) {
      const c = countdown(next.at - now);
      const set = (n, v) => { const el2 = box.querySelector(`[data-cd="${n}"]`); if (el2) el2.textContent = v; };
      set('d', String(c.d).padStart(2, '0'));
      set('h', String(c.h).padStart(2, '0'));
      set('m', String(c.m).padStart(2, '0'));
      set('s', String(c.s).padStart(2, '0'));
    }
    return;
  }
  cdKey = key;
  cdNext = next;

  if (!next) {
    box.dataset.mode = 'none';
    box.innerHTML = `<div class="cdb-none">
      <span class="cdb-none-t">接下来没有安排</span>
      <span class="cdb-none-s">添加一条带时间的事项，或设个提醒，这里会自动倒数</span>
      <span style="flex:1"></span>
      <button class="btn sm" data-new-alarm>＋ 设提醒</button>
      <button class="btn sm" data-cal-export title="把已设的提醒加到系统日历">${icon('cal', 13)} 日历</button>
    </div>`;
  } else {
    box.dataset.mode = isTomorrow ? 'next-day' : 'now';
    const c = countdown(next.at - now);
    const exp = isTomorrow ? (relDay(next.at) === '明天' ? '明天' : relDay(next.at)) : '今天';
    box.innerHTML = `
      <div class="cdb-left">
        <div class="cdb-k">${isTomorrow ? '今天没有别的了 · 下一个' : `下一个 · ${TYPE_LABEL[next.type] || next.type}`}</div>
        <div class="cdb-name">${esc(next.title)}</div>
        <div class="cdb-at">${exp} ${fmtTime(next.at)}</div>
      </div>
      <div class="cdb-nums">
        <div class="cdb-num"><b data-cd="d">${String(c.d).padStart(2, '0')}</b><span>天</span></div>
        <div class="cdb-num"><b data-cd="h">${String(c.h).padStart(2, '0')}</b><span>时</span></div>
        <div class="cdb-num"><b data-cd="m">${String(c.m).padStart(2, '0')}</b><span>分</span></div>
        <div class="cdb-num"><b data-cd="s">${String(c.s).padStart(2, '0')}</b><span>秒</span></div>
      </div>
      <div class="cdb-acts">
        <button class="btn cdb-btn" data-new-alarm>＋ 设提醒</button>
        <button class="btn cdb-btn" data-cal-export title="加到系统日历">${icon('cal', 13)} 日历</button>
      </div>`;
  }
  box.querySelectorAll('[data-new-alarm]').forEach((b) => { b.onclick = () => alarmEditor(null, next ? { title: next.title + ' 提醒', due: next.at } : null); });
  box.querySelectorAll('[data-cal-export]').forEach((b) => { b.onclick = exportCalendar; });
}

/* 把当前所有待触发的提醒交给系统日历。
   一次导出多条，系统日历会连续弹出几个预览，各自点「添加」即可。 */
async function exportCalendar() {
  const list = await api.get('/reminders').catch(() => null);
  const ups = (list || []).filter((r) => r.status === 'scheduled');
  if (!ups.length) return toast('还没有待触发的提醒，先设一个吧', 'warn');
  addToSystemCalendar(
    ups.map((r) => ({ title: r.title, due: r.due_at, advance: r.advance_min, body: r.body, uid: 'r' + r.id })),
    toast,
  );
}

/* 日历 */
let calState = { month: '', data: null, selected: '', view: 'month', dayLoadSeq: 0, loadSeq: 0, dayData: null, dayOpen: false };
function setCalendarDayOpen(open) {
  const next = Boolean(open);
  calState.dayOpen = next;
  const box = document.getElementById('cal-day');
  const card = box?.closest('.home-calendar-card');
  const item = box?.closest('[data-hcard="calendar"]');
  if (box) {
    box.hidden = !next;
    if (!next) box.innerHTML = '';
  }
  if (card) card.classList.toggle('is-day-open', next);
  if (item) item.classList.toggle('is-day-open', next);
  if (next) {
    setGridTemporaryHeight('calendar', 11);
  } else {
    calState.dayData = null;
    calState.dayLoadSeq += 1;
    setGridTemporaryHeight('calendar', 0);
  }
}

async function loadCal(monthDay, { openDay = false } = {}) {
  setCalendarDayOpen(openDay);
  const month = String(monthDay).slice(0, 7);
  const requestId = ++calState.loadSeq;
  calState.month = month;
  calState.selected = monthDay;
  calState.dayData = null;
  let data;
  if (month === String(homeData?.date || '').slice(0, 7) && homeData.courses_month) {
    data = {
      month, courses: homeData.courses_month,
      items: (homeData.items || []), lessons: homeData.lessons || [],
      invigilations: homeData.invigilations || [], reminders: [], trips: [],
    };
  }
  data = await api.get('/calendar', { month }).catch(() => data);
  if (requestId !== calState.loadSeq) return;
  calState.data = data || { courses: [], items: [], lessons: [], invigilations: [], trips: [], reminders: [] };
  paintCal();
}

function paintCal() {
  const { month, data } = calState;
  if (!data) return;
  const [y, m] = month.split('-').map(Number);
  const first = new Date(y, m - 1, 1);
  const startCell = first.getDay();
  const daysInMonth = new Date(y, m, 0).getDate();
  const prevDays = new Date(y, m - 1, 0).getDate();
  const title = document.getElementById('cal-title');
  if (title) title.textContent = `${y}年${pad2(m)}月`;
  const mi = document.getElementById('cal-month-input');
  if (mi) mi.value = month;
  const byDate = (rows, get) => rows.reduce((acc, r) => { const k = get(r); if (k) (acc[k] ||= []).push(r); return acc; }, {});
  const C = byDate(data.courses, (r) => r.date);
  const I2 = byDate(data.items, (r) => String(r.start_at || r.created_at || '').slice(0, 10));
  const L = byDate(data.lessons, (r) => r.date);
  const G = byDate(data.invigilations, (r) => r.date);
  const R = byDate(data.reminders || [], (r) => String(r.due_at || '').slice(0, 10));
  const todayStr = ymd(new Date());
  let cells = [];
  for (let i = 0; i < startCell; i++) cells.push({ d: prevDays - startCell + 1 + i, out: true });
  for (let d = 1; d <= daysInMonth; d++) cells.push({ d, out: false });
  while (cells.length % 7) cells.push({ d: cells.length % 7, out: true });
  // 周视图：只留包含"选中日"的那一周（选中日不在本月就退回今天所在周）
  if (calState.view === 'week') {
    const focus = calState.selected && calState.selected.startsWith(month) ? calState.selected : todayStr;
    const fd = Number(String(focus).slice(8, 10));
    const wd = new Date(y, m - 1, fd).getDay();
    const idx = startCell + fd - 1 - wd;
    cells = cells.slice(idx, idx + 7);
  }
  const grid = document.getElementById('cal-grid');
  if (!grid) return;
  grid.classList.toggle('week-view', calState.view === 'week');
  grid.innerHTML = cells.map((c, idx) => {
    const dt = c.out ? null : `${y}-${pad2(m)}-${pad2(c.d)}`;
    const dots = [];
    if (dt) {
      if (I2[dt]?.length || L[dt]?.length) dots.push('var(--primary)');
      if (C[dt]?.length) dots.push('var(--teal)');
      if ((G[dt] || []).length || (data.trips || []).some((t) => t.start_date <= dt && (t.end_date || t.start_date) >= dt)) dots.push('var(--amber)');
      if (R[dt]?.length) dots.push('var(--purple)');
    }
    const col = idx % 7;
    const we = col === 0 || col === 6;
    return `<button class="cal-cell ${c.out ? 'out' : ''} ${we ? 'we' : ''} ${dt === todayStr ? 'today' : ''} ${dt === calState.selected ? 'sel' : ''}" ${dt ? `data-day="${dt}"` : 'disabled'} aria-label="${dt || c.d + '日'}">
      <span class="cal-n">${c.d}</span>
      ${dots.length ? `<span class="cal-dots">${dots.slice(0, 4).map((x) => `<i style="background:${x}"></i>`).join('')}</span>` : ''}
    </button>`;
  }).join('');
  grid.querySelectorAll('[data-day]').forEach((b) => {
    b.onclick = () => {
      calState.selected = b.dataset.day;
      setCalendarDayOpen(true);
      paintCal();
      syncDay(b.dataset.day, 'calendar');
    };
  });
  if (calState.dayOpen && calState.selected) loadDay(calState.selected);
}


async function loadDay(date) {
  if (!calState.dayOpen || date !== calState.selected) return;
  const box = document.getElementById('cal-day');
  if (!box) return;
  box.hidden = false;
  const requestId = ++calState.dayLoadSeq;
  renderHomeDayLoading(date);
  box.innerHTML = '<div class="cal-day-content"><div class="cal-day-empty">正在加载当天安排…</div></div>';
  const dayData = await api.get('/calendar/day', { date }).catch(() => null);
  if (!box.isConnected || requestId !== calState.dayLoadSeq || date !== calState.selected) return;
  if (!dayData) {
    calState.dayData = null;
    const content = box.querySelector('.cal-day-content');
    if (content) content.innerHTML = '<div class="cal-day-empty">当天安排加载失败，请稍后重试</div>';
    renderHomeDayPanels(date, { items: [], courses: [], lessons: [] });
    return;
  }
  calState.dayData = dayData;
  const events = [];
  for (const course of (dayData.courses || [])) events.push({
    s: course.start_time || '', e: course.end_time || '', k: 'course',
    title: `${course.class_name || ''} ${course.subject || '课程'}`.trim(),
    sub: `第${course.period_no || ''}节${course.room ? ' · ' + course.room : ''}`,
    color: 'var(--teal)', id: course.course_id,
  });
  for (const item of (dayData.items || [])) events.push({
    s: item.start_at ? String(item.start_at).slice(11, 16) : '',
    e: item.end_at ? String(item.end_at).slice(11, 16) : '',
    k: 'item', title: item.title || '未命名事项',
    sub: `${item.kind || '事项'}${item.detail ? ' · ' + item.detail : ''}`,
    color: 'var(--primary)', id: item.id,
  });
  for (const invigilation of (dayData.invigilations || [])) events.push({
    s: invigilation.start_time || String(invigilation.start_at || '').slice(11, 16),
    e: invigilation.end_time || String(invigilation.end_at || '').slice(11, 16),
    k: 'inv', title: `${invigilation.subject || invigilation.exam_name || '监考'} 监考`,
    sub: `${invigilation.type || ''}${invigilation.place || invigilation.room ? ' · ' + (invigilation.place || invigilation.room) : ''}`,
    color: 'var(--amber)', id: invigilation.id,
  });
  for (const lesson of (dayData.lessons || [])) events.push({
    s: lesson.start_time || '', e: lesson.end_time || '', k: 'lesson',
    title: `${lesson.class_name || ''} ${lesson.content || '已上课'}`.trim(),
    sub: lesson.progress || '已完成课时', color: 'var(--purple)', id: lesson.id,
  });
  for (const reminder of (dayData.reminders || [])) events.push({
    s: reminder.due_at ? String(reminder.due_at).slice(11, 16) : '',
    e: '', k: 'reminder', title: reminder.title || '提醒',
    sub: reminder.body || '日程提醒', color: 'var(--red)', id: reminder.id,
  });
  const minuteOf = (value) => {
    const match = String(value || '').match(/(?:T|^)(\d{1,2}):(\d{2})/);
    return match ? Number(match[1]) * 60 + Number(match[2]) : null;
  };
  events.sort((a, b) => (minuteOf(a.s) ?? 1440) - (minuteOf(b.s) ?? 1440));
  const eventButton = (event) => {
    const time = event.s ? String(event.s).slice(0, 5) + (event.e ? '–' + String(event.e).slice(0, 5) : '') : '全天';
    return `<button class="cal-day-event cal-day-event-${event.k}" type="button"
      data-day-event="${event.k}" data-day-event-id="${esc(event.id ?? '')}"
      title="${esc(time + ' ' + event.title)}" style="--cal-event-color:${event.color}">
      <span class="cal-day-event-time">${esc(time)}</span><b>${esc(event.title)}</b>
      ${event.sub ? `<small>${esc(event.sub)}</small>` : ''}
    </button>`;
  };
  const allDayEvents = events.filter((event) => minuteOf(event.s) === null);
  const hourRows = Array.from({ length: 24 }, (_, hour) => {
    const hourEvents = events.filter((event) => {
      const minute = minuteOf(event.s);
      return minute !== null && Math.floor(minute / 60) === hour;
    });
    return `<div class="cal-day-hour-row">
      <time class="cal-day-hour-label">${String(hour).padStart(2, '0')}:00</time>
      <div class="cal-day-hour-events">${hourEvents.length ? hourEvents.map(eventButton).join('') : '<span class="cal-day-hour-empty"></span>'}</div>
    </div>`;
  }).join('');
  const allDayHTML = allDayEvents.length
    ? `<div class="cal-day-all-day"><span>全天</span>${allDayEvents.map(eventButton).join('')}</div>`
    : '';
  box.innerHTML = `<div class="cal-day-content"><div class="cal-day-timeline">
      <div class="cal-day-timeline-head"><b>当天时间轴</b><span>24小时 · 上下滑动查看</span></div>
      ${allDayHTML}<div class="cal-day-hours">${hourRows}</div>
    </div></div>`;
  bindCalDayEvents(box, date);
  renderHomeDayPanels(date, dayData);
  const scrollArea = box.querySelector('.cal-day-content');
  if (scrollArea) scrollArea.scrollTop = 6 * 29;
}

function bindCalDayEvents(box, date) {
  box.querySelectorAll('[data-day-event]').forEach((button) => {
    button.onclick = () => {
      const kind = button.dataset.dayEvent;
      if (kind === 'item') {
        const item = (calState.dayData?.items || []).find((row) => String(row.id) === button.dataset.dayEventId);
        if (item) editItem(item, date);
        return;
      }
      if (kind === 'course') return go('work/timetable');
      if (kind === 'inv') return go('work/invigilation');
      if (kind === 'lesson') return go('work/lessons');
      if (kind === 'reminder') return go('daily');
    };
  });
}

const mNum = (s) => Number(String(s).slice(5, 7));

/* 消息
   【第 24 条后这里只剩角标，不再渲染列表】
   首页那块「消息中心」卡片整块去掉了，消息入口收成时钟旁边的一枚铃铛。
   所以这个函数现在只负责把未读数刷到铃铛上——
   不删函数是因为 renderHome() 和 refreshHome() 都在调它，
   删了要改三处，留着只改一处更稳。 */
async function loadHomeMsgs() {
  const bell = document.querySelector('.msg-bell');
  if (!state.user) return; // 未登录不请求，避免 401
  const r = await api.get('/messages').catch(() => null);
  if (!r) return;
  const n = Number(r.unread) || 0;
  state.unread = n;
  /* 底部导航的红点由 paintUnread 统一画。以前这里只改了首页铃铛，
     手机上「我的」那一项的红点不会跟着变——首页看到有 3 条未读，
     点进「我的」角标却是旧的，两个数对不上。 */
  paintUnread();
  if (!bell) return;
  let dot = bell.querySelector('.msg-bell-dot');
  if (n <= 0) { if (dot) dot.remove(); return; }
  if (!dot) {
    dot = document.createElement('span');
    dot.className = 'badge-dot msg-bell-dot';
    bell.appendChild(dot);
  }
  dot.textContent = n > 99 ? '99+' : String(n);
}

/* ---------------- 全局搜索 ---------------- */
/* 两档模式由用户自己定：
     fuzzy 模糊 —— 包含即命中（默认，覆盖全）
     exact 精准 —— 词首命中（记得开头几个字时用，结果更干净）
   两种都返回分组，这里只负责渲染。 */
let srMode = 'fuzzy';
let srQuery = '';
let srData = null;
/* 当前筛选到哪个分类（空串 = 全部）。纯前端状态，不参与请求。 */
let srFilter = '';

/* 把关键词包成 <mark>。先 esc 再替换，避免 XSS；
   SQL 那层用的是不带转义的原文匹配，高亮这里按用户输入原样找即可。 */
function hl(text, q) {
  const s = String(text ?? '');
  if (!q) return esc(s);
  const safe = esc(s);
  const kw = esc(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return safe.replace(new RegExp(kw, 'gi'), (m) => `<mark class="sr-mark">${m}</mark>`);
}

async function doSearch(q, mode = srMode) {
  const box = document.getElementById('search-result');
  if (!box) return;
  q = String(q ?? document.getElementById('gsearch')?.value ?? '').trim();
  if (!q) { closeSearch(); return; }
  /* 换了关键词就把筛选清掉：否则搜「劝学」时筛到「笔记」，
     再搜「周口」会看到一篇空白页，以为真没结果。
     必须先比较再赋值——写完 srQuery = q 再比，两边永远相等，这段就废了。 */
  if (srQuery !== q) srFilter = '';
  srQuery = q; srMode = mode;
  openSearch();
  if (!srData || srData.q !== q || srData.mode !== mode) {
    box.innerHTML = `<div class="sr-loading"><span class="sr-spin"></span>搜索中…</div>`;
  }
  const r = await api.get('/search', { q, mode }).catch(() => null);
  if (!r) { box.innerHTML = `<div class="sr-loading">搜索失败，请稍后再试</div>`; return; }
  srData = r;
  paintSearch();
}

function openSearch() {
  const box = document.getElementById('search-result');
  const scrim = document.getElementById('search-scrim');
  if (box) box.hidden = false;
  if (scrim) scrim.hidden = false;
  document.body.classList.add('sr-open');
}

function closeSearch() {
  const box = document.getElementById('search-result');
  const scrim = document.getElementById('search-scrim');
  if (box) box.hidden = true;
  if (scrim) scrim.hidden = true;
  document.body.classList.remove('sr-open');
  srData = null;
}

/* 每种结果类型给一个图标，充当京东搜索结果里的「商品图」位置。
   没有配到的类型退回一个通用文件图标，不会出现空白方块。 */
const SR_ICON = {
  items: 'check', todos: 'edit', lessons: 'book', courses: 'cal',
  invigilations: 'alert', trips: 'car', materials: 'folder', notes: 'file',
  homework: 'edit', studies: 'zap', attendance: 'users', students: 'users',
  teachers: 'users', punishments: 'alert', exceptions: 'alert',
};

/* 京东搜索结果页的信息层次：
   商品图 → 标题（关键词标红）→ 卖点小字 → 价格/销量这类数据 → 右边操作按钮。
   搬过来就是：类型图标 → 标题 → 副标题/状态 → 时间 → 右侧「查看」。 */
function srRowHTML(row, g, q) {
  const ic = SR_ICON[g.type] || 'file';
  return `<div class="sr-row" data-sr="${row.href || g.route}">
    <div class="sr-thumb">${icon(ic, 22)}</div>
    <div class="sr-row-main">
      <div class="sr-row-t">${hl(row.title, q)}</div>
      ${row.subtitle ? `<div class="sr-row-sub">${hl(row.subtitle, q)}</div>` : ''}
      <div class="sr-row-meta">
        ${row.status ? `<span class="sr-tag">${esc(row.status)}</span>` : ''}
        ${row.seq ? `<span class="sr-no">编号 ${String(row.seq).padStart(3, '0')}</span>` : ''}
        ${row.time ? `<span class="sr-time">${esc(String(row.time).replace('T', ' ').slice(0, 16))}</span>` : ''}
      </div>
    </div>
    <button class="sr-go" data-goto="${row.href || g.route}">查看 ${icon('right', 11)}</button>
  </div>`;
}

function paintSearch() {
  const box = document.getElementById('search-result');
  if (!box || !srData) return;
  const r = srData;
  const q = r.q || srQuery;
  const groups = r.groups || [];

  /* 顶部筛选条：每个结果分组就是一个筛选维度，和京东「品牌/价格/尺码」一个道理。
     点一下只看这一类，再点回到全部。条数直接标在名字后面，一眼知道哪类最多。 */
  const chips = [
    `<button class="sr-chip ${srFilter ? '' : 'on'}" data-filter="">全部 <b>${r.total}</b></button>`,
    ...groups.map((g) => `<button class="sr-chip ${srFilter === g.type ? 'on' : ''}" data-filter="${g.type}">
      ${esc(g.label)} <b>${g.rows.length}</b></button>`),
  ].join('');

  const shown = srFilter ? groups.filter((g) => g.type === srFilter) : groups;
  const sum = shown.reduce((s, g) => s + g.rows.length, 0);

  const head = `
    <div class="sr-head">
      <div class="sr-head-l">
        共找到 <span class="sr-total">${r.total}</span> 条与
        <span class="sr-q">「${esc(q)}」</span> 相关的结果
      </div>
      <div class="seg sr-mode">
        <button class="${r.mode === 'fuzzy' ? 'on' : ''}" data-mode="fuzzy" title="包含即命中">模糊</button>
        <button class="${r.mode === 'exact' ? 'on' : ''}" data-mode="exact" title="从词首开始匹配">精准</button>
      </div>
      <button class="icon-btn sm" id="close-search" title="关闭">${icon('close', 15)}</button>
    </div>
    <div class="sr-filters">${chips}</div>`;

  if (!r.total) {
    box.innerHTML = `${head}
      <div class="sr-body"><div class="sr-empty">
        <div class="sr-empty-ico">${icon('search', 40)}</div>
        <div class="sr-empty-t">没有找到「${esc(q)}」</div>
        <div class="sr-empty-s">${r.mode === 'fuzzy'
          ? '换个说法试试，或者切到「精准」只搜开头几个字。'
          : '「精准」只匹配词首，切到「模糊」可以搜到正文里提到的地方。'}</div>
      </div></div>`;
  } else {
    box.innerHTML = `${head}
      <div class="sr-body">
        ${srFilter ? '' : `<div class="sr-sum">共 ${sum} 件结果，按 ${shown.length} 个分类展示</div>`}
        ${shown.map((g) => `<div class="sr-group">
          <div class="sr-g-head">
            <span class="sr-g-name">${esc(g.label)}</span>
            <span class="sr-g-n">${g.rows.length}</span>
            <span style="flex:1"></span>
            <button class="sr-g-go" data-sg="${g.route}" title="去这个页面">进入 ${icon('right', 12)}</button>
          </div>
          <div class="sr-list">${g.rows.map((row) => srRowHTML(row, g, q)).join('')}</div>
        </div>`).join('')}
      </div>`;
  }

  box.querySelector('#close-search').onclick = () => {
    closeSearch();
    const i = document.getElementById('gsearch');
    if (i) { i.value = ''; syncClear(); }
  };
  box.querySelectorAll('[data-mode]').forEach((b) => {
    b.onclick = () => doSearch(srQuery, b.dataset.mode);
  });
  // 筛选：只切本地显示，不重新请求——数据已经在手里，再打一次接口纯属浪费
  box.querySelectorAll('[data-filter]').forEach((b) => {
    b.onclick = () => { srFilter = b.dataset.filter || ''; paintSearch(); };
  });
  box.querySelectorAll('[data-goto]').forEach((b) => {
    b.onclick = (e) => { e.stopPropagation(); const t = b.dataset.goto; closeSearch(); go(t); };
  });
  box.querySelectorAll('[data-sg]').forEach((r2) => {
    r2.onclick = (e) => { e.stopPropagation(); go(r2.dataset.sg); };
  });
  box.querySelectorAll('[data-sr]').forEach((r2) => {
    r2.onclick = () => { const t = r2.dataset.sr; closeSearch(); go(t); };
  });
}

/* 清空按钮的显示 / 隐藏 */
function syncClear() {
  const i = document.getElementById('gsearch');
  const b = document.getElementById('search-clear');
  if (i && b) b.hidden = !i.value;
}

/* 事项编辑 */
export function editItem(item = null, presetDate = '') {
  const isNew = !item;
  const body = el(`<div class="sheet-body">
    <div class="field"><label class="field-label">标题</label><input class="input" id="f-title" value="${esc(item?.title || '')}" placeholder="例如：高二语文备课组会"></div>
    <div class="field"><label class="field-label">详情</label><textarea class="input" id="f-detail" rows="2" placeholder="补充说明（可选）">${esc(item?.detail || '')}</textarea></div>
    <div class="form-grid">
      <div class="field"><label class="field-label">类型</label>
        <select class="input" id="f-kind">${['事项', '任务', '倒计时', '出差', '学习'].map((k) => `<option ${item?.kind === k ? 'selected' : ''}>${k}</option>`).join('')}</select></div>
      <div class="field"><label class="field-label">优先级</label>
        <select class="input" id="f-priority">${[['low', '低'], ['normal', '普通'], ['high', '高'], ['urgent', '紧急']].map(([v, l]) => `<option value="${v}" ${item?.priority === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="field"><label class="field-label">开始时间</label><input class="input" type="datetime-local" id="f-start" value="${esc(item?.start_at || (presetDate ? presetDate + 'T09:00' : ''))}"></div>
      <div class="field"><label class="field-label">结束时间</label><input class="input" type="datetime-local" id="f-end" value="${esc(item?.end_at || '')}"></div>
      <div class="field"><label class="field-label">提前提醒</label>
        <select class="input" id="f-remind">${[[-1, '不提醒'], [0, '准点'], [5, '提前 5 分钟'], [10, '提前 10 分钟'], [15, '提前 15 分钟'], [30, '提前 30 分钟'], [60, '提前 1 小时'], [1440, '提前 1 天']].map(([v, l]) => `<option value="${v}" ${v === 10 ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="field"><label class="field-label">状态</label>
        <select class="input" id="f-status">${[['todo', '待完成'], ['doing', '进行中'], ['done', '已完成']].map(([v, l]) => `<option value="${v}" ${item?.status === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    </div>
    <div class="field-hint">提醒会进入消息中心，到点会在这个设备上弹出闹钟式提醒；也可“加到系统日历”让手机/iPad 关机也能响。</div>
    <div class="confirm-actions">
      ${isNew ? '' : '<button class="btn ghost danger" id="f-del" style="margin-right:auto;color:var(--red)">删除</button>'}
      <button class="btn ghost" id="f-cancel">取消</button><button class="btn primary" id="f-save">保存</button>
    </div>
  </div>`);
  const s = sheet({ title: isNew ? '新建事项' : '编辑事项', body });
  body.querySelector('#f-cancel').onclick = s.close;
  body.querySelector('#f-del')?.addEventListener('click', async () => {
    if (await confirmDialog('删除后可在回收站找回，确认删除？')) { await api.del('/items/' + item.id); s.close(); toast('已移到回收站'); refreshHome(); }
  });
  body.querySelector('#f-save').onclick = async () => {
    const payload = {
      title: body.querySelector('#f-title').value.trim(),
      detail: body.querySelector('#f-detail').value.trim(),
      kind: body.querySelector('#f-kind').value,
      priority: body.querySelector('#f-priority').value,
      start_at: body.querySelector('#f-start').value || null,
      end_at: body.querySelector('#f-end').value || null,
      status: body.querySelector('#f-status').value,
    };
    const rm = Number(body.querySelector('#f-remind').value);
    if (isNew) { payload.remind_min = rm >= 0 ? rm : null; } else { if (rm >= 0) payload.remind_min = rm; delete payload.remind_min; payload.remind_min = rm >= 0 ? rm : null; }
    if (!payload.title) return toast('请填写标题', 'warn');
    try {
      if (isNew) await api.post('/items', payload); else await api.patch('/items/' + item.id, payload);
      s.close(); toast('已保存'); refreshHome();
      if (payload.remind_min !== null && payload.start_at) toast('提醒已设置：' + fmtDateTime(payload.start_at));
    } catch (e) { toast(e.message, 'err'); }
  };
}

/* 闹钟式提醒编辑器 */
export function alarmEditor(rem = null, preset = null) {
  const due = rem?.due_at || (preset?.due ? new Date(preset.due).toISOString().slice(0, 16) : '');
  const body = el(`<div class="sheet-body">
    <div class="field"><label class="field-label">提醒标题</label><input class="input" id="a-title" value="${esc(rem?.title || preset?.title || '')}" placeholder="例如：带月考卷去教务处"></div>
    <div class="field"><label class="field-label">提醒时间</label><input class="input" type="datetime-local" id="a-due" value="${esc(due)}"></div>
    <div class="field"><label class="field-label">提前</label>
      <div class="row wrap" id="adv" style="gap:6px">${[[0, '准点'], [5, '5 分钟'], [10, '10 分钟'], [30, '30 分钟'], [60, '1 小时'], [1440, '1 天']].map(([v, l], i) => `<button class="chip-btn ${i === 0 ? 'on' : ''}" data-v="${v}">${l}</button>`).join('')}</div></div>
    <div class="form-grid">
      <div class="field"><label class="field-label">重复</label>
        <select class="input" id="a-repeat">${[['none', '不重复'], ['daily', '每天'], ['workday', '工作日'], ['weekly', '每周'], ['monthly', '每月']].map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></div>
      <div class="field"><label class="field-label">铃声</label>
        <select class="input" id="a-ring">${[['chime', '清脆铃声'], ['bell', '上课铃'], ['soft', '轻柔'], ['none', '静音（仅通知）']].map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></div>
    </div>
    <div class="field-hint">到点会在本页面弹出闹钟提醒（带铃声和震动）。保存后如果还想让系统日历也响，点下面的「加到系统日历」，日历弹出预览后点「添加」即可。</div>
    <div class="row" style="margin:10px 0 14px">
      <label class="row small" style="gap:6px"><input type="checkbox" id="a-notify" checked> 同时发浏览器通知（切到别的标签页也能看到）</label>
    </div>
    <div class="confirm-actions">
      <button class="btn ghost" id="a-cancel">取消</button>
      <button class="btn soft" id="a-to-cal">加到系统日历</button>
      <button class="btn primary" id="a-save">设置提醒</button>
    </div>
  </div>`);
  const s = sheet({ title: rem ? '编辑提醒' : '新建提醒（闹钟）', body });
  let adv = 0;
  body.querySelectorAll('#adv button').forEach((b) => { b.onclick = () => { body.querySelectorAll('#adv button').forEach((x) => x.classList.toggle('on', x === b)); adv = Number(b.dataset.v); }; });
  body.querySelector('#a-cancel').onclick = s.close;
  /* 只加到系统日历，不建应用内提醒——有些人就是想要系统日历自己响。
     校验和保存走同一套，避免「日历里有一条、应用里没有」的困惑：
     这里只读不写，不调 /reminders。 */
  body.querySelector('#a-to-cal').onclick = () => {
    const title = body.querySelector('#a-title').value.trim();
    const dueV = body.querySelector('#a-due').value;
    if (!title) return toast('请填写标题', 'warn');
    if (!dueV) return toast('请选择提醒时间', 'warn');
    addToSystemCalendar({ title, due: dueV, advance: adv, body: '来自我的工作台' }, toast);
  };
  body.querySelector('#a-save').onclick = async () => {
    const title = body.querySelector('#a-title').value.trim();
    const dueV = body.querySelector('#a-due').value;
    if (!title) return toast('请填写标题', 'warn');
    if (!dueV) return toast('请选择提醒时间', 'warn');
    try {
      const r = await api.post('/reminders', { title, due_at: dueV, advance_min: adv, repeat: body.querySelector('#a-repeat').value, ring: body.querySelector('#a-ring').value });
      if (body.querySelector('#a-notify').checked && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission();
      /* 设完立刻重排闹钟（第 38 条）：不然要等 60 秒兜底轮询才生效，
         用户当场测「一分钟后提醒我」，看着没反应就以为坏了。 */
      import('./alarm.js').then((m) => m.alarmAfterCreate?.()).catch(() => {});
      s.close();
      /* 提示里带上传定的时间：用户能立刻核对「是不是设成了明天」 */
      toast(`提醒已设置：${fmtDateTime(dueV)}${adv ? ` 提前 ${adv} 分钟提醒` : ''}`, 'ok', 4000);
      refreshHome();
    } catch (e) { toast(e.message, 'err'); }
  };
}

/* 首页事件绑定 */
/* 首页小偏好（天气是否展开等），只存本地 */


/* ================= 首页自定义布局 =================
   卡片位置、拖拽、缩放、隐藏、保存全部搬到了 homegrid.js。
   这里只留两个入口：
     · renderHome 里 mountGrid() 负责重挂（DOM 每次重建）
     · restoreHomeLayout() 给「我的」里的重置入口用

   为什么不再在这里维护一份 applyLayout：
   以前是「两列 + 数组顺序」，现在要存 x/y/w/h 三套断点，
   再把这份逻辑抄一遍必然和 homegrid 里的算错位。 */


/* 恢复默认布局的入口 */
export function restoreHomeLayout() {
  return resetGridLayout();
}

function bindHome() {
  const q = (s) => document.querySelector(s);
  const themeButton = q('#theme-btn');
  if (themeButton) themeButton.onclick = () => { import('./ui.js').then((m) => m.openThemeSheet()); };
  q('#home-new-item').onclick = () => editItem(null, homeData.date);
  document.querySelectorAll('[data-msg]').forEach((b) => { b.onclick = () => go('messages'); });
  document.querySelectorAll('[data-goto2]').forEach((b) => { b.onclick = () => go(b.dataset.goto2); });
  /* data-goto 在搜索结果面板里是由 srBind 绑的，顶栏头像虽然也用这个属性名，
     但走不到那段代码，所以这里单独绑。
     注意只选 .ah-btn，不要用 querySelectorAll('[data-goto]')：首页壳子里还有
     「课表 ›」「全部 ›」这些 data-goto2，而各视图自己的 bindTabs(main) 会整体
     重绑 [data-goto]——这里如果贪心，头像反而会被后绑的那次覆盖掉。 */
  document.querySelectorAll('.ah-btn[data-goto]').forEach((b) => {
    b.onclick = () => go(b.dataset.goto);
  });
  document.querySelectorAll('[data-add-item]').forEach((b) => { b.onclick = () => editItem(null, calState.selected || homeData.date); });
  document.querySelectorAll('[data-add-item2]').forEach((b) => { b.onclick = () => editItem(null, calState.selected || homeData.date); });

  const si = q('#gsearch');
  const clearBtn = q('#search-clear');
  let searchTimer = null;
  syncClear();
  // 输入即搜（防抖 300ms）；回车立刻搜；清空后收起结果
  si.addEventListener('input', () => {
    syncClear();
    clearTimeout(searchTimer);
    if (!si.value.trim()) { closeSearch(); return; }
    searchTimer = setTimeout(doSearch, 300);
  });
  si.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); clearTimeout(searchTimer); doSearch(); si.blur(); }
    if (e.key === 'Escape') { si.value = ''; syncClear(); closeSearch(); si.blur(); }
  });
  clearBtn.onclick = () => {
    si.value = ''; syncClear(); closeSearch();
    si.focus();
  };
  q('#search-go').onclick = () => { clearTimeout(searchTimer); if (si.value.trim()) doSearch(); else si.focus(); };
  // 点空白处收起结果，跟系统搜索的行为一致
  q('#search-scrim').onclick = () => { closeSearch(); si.blur(); };

  // 天气：简要常显，详细折起来
  document.querySelectorAll('[data-pick-city]').forEach((b) => { b.onclick = pickCity; });
  const bindWxRefresh = () => {
    const wr = q('[data-wx-refresh]');
    if (wr) wr.onclick = async () => { wr.textContent = '…'; await loadWeather(true).catch(() => toast('天气刷新失败', 'warn')); renderWeatherOnly(); };
  };
  bindWxRefresh();
  const bindWxForecast = (root = document) => {
    root.querySelectorAll('[data-wx-forecast]').forEach((button) => {
      button.onclick = () => openWeatherSheet();
    });
  };
  bindWxForecast();
  /* 天气卡默认只显示「今天」，详细内容（指标 / 穿搭 / 逐时 / 一周）
     走抽屉弹窗，不跳页 —— 跳页会丢掉首页上下文，回来还要滚回原位。 */
  const wxMore = q('#wx-more');
  if (wxMore) wxMore.onclick = () => openWeatherSheet();

  // 快速便签：今天事项列表底部一行，回车即存
  const qi = q('#quick-input');
  const qh = q('#quick-hint');
  const qtBtn = q('#quick-time');
  let quickAt = '';
  const save = async () => {
    const text = qi.value.trim();
    if (!text) { qi.focus(); return toast('写点什么再保存吧', 'warn'); }
    const btn = q('#quick-save');
    if (btn) btn.disabled = true;
    try {
      const targetDate = calState.selected || homeData.date;
      const at = quickAt || (targetDate && targetDate !== homeData.date ? targetDate + 'T09:00' : null);
      const payload = { text, at };
      if (quickAt) payload.remind_min = 10;
      await api.post('/quick', payload);
      qi.value = ''; quickAt = '';
      if (qh) { qh.textContent = ''; qh.classList.remove('on'); }
      if (qtBtn) qtBtn.classList.remove('on');
      toast('已记一笔，可在「今日事项」和「便签」查看');
      await refreshHome();
      // 刷新后焦点回到输入框，方便连着记第二笔
      const ni = document.getElementById('quick-input');
      if (ni) ni.focus();
    } catch (e) {
      toast(e.message || '保存失败', 'err');
    } finally {
      const b2 = document.getElementById('quick-save');
      if (b2) b2.disabled = false;
    }
  };
  if (q('#quick-save')) q('#quick-save').onclick = save;
  if (qi) {
    qi.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } });
  }
  if (qtBtn) {
    qtBtn.onclick = () => {
      const b = el(`<div class="sheet-body">
        <div class="field"><label class="field-label">什么时候提醒</label><input class="input" type="datetime-local" id="qt"></div>
        <div class="confirm-actions"><button class="btn ghost" id="qc">取消</button><button class="btn primary" id="qk">确定</button></div></div>`);
      const s = sheet({ title: '给这条便签加个时间', body: b });
      b.querySelector('#qk').onclick = () => {
        quickAt = b.querySelector('#qt').value;
        if (quickAt && qh) { qh.textContent = `将在 ${fmtDateTime(quickAt)} 前 10 分钟提醒`; qh.classList.add('on'); qtBtn.classList.add('on'); }
        s.close();
      };
      b.querySelector('#qc').onclick = s.close;
    };
  }

  // 名言：点喇叭朗读英文
  const sb = q('#speak-btn');
  const tip = q('#speak-tip');
  sb.onclick = () => {
    if (sb.classList.contains('playing')) { stopSpeak(); sb.classList.remove('playing'); if (tip) tip.textContent = '点喇叭听英文'; return; }
    speak(homeData.quote.en, (playing) => {
      sb.classList.toggle('playing', !!playing);
      if (tip) tip.textContent = playing ? '朗读中，再点停止' : '点喇叭听英文';
    });
  };
  const nextQuoteBtn = q('#quote-next');
  if (nextQuoteBtn) nextQuoteBtn.onclick = async () => {
    stopSpeak();
    sb.classList.remove('playing');
    if (tip) tip.textContent = '点喇叭听英文';
    nextQuoteBtn.disabled = true;
    try {
      const cur = homeData.quote || {};
      const r = await api.get('/home/quote?not=' + encodeURIComponent(cur.id || 0));
      if (!r || !r.en) return toast('没拿到新句子，稍后再试', 'warn');
      const en = q('#q-en'); if (en) en.textContent = r.en;
      const zh = q('#q-zh'); if (zh) zh.textContent = r.zh || '';
      const au = q('#q-author'); if (au) au.textContent = '— ' + (r.author || '');
      homeData.quote = r;
      nextQuoteBtn.blur();
    } catch (e) {
      // 以前这里没有 try/catch，接口一抖异常被吞，用户只看到「点了没反应」
      toast('换一句失败了：' + (e?.message || '网络不太行'), 'err');
    } finally {
      nextQuoteBtn.disabled = false;
    }
  };

  // 日历
  q('#cal-prev').onclick = () => shiftMonth(-1);
  q('#cal-next').onclick = () => shiftMonth(1);
  q('#cal-today').onclick = () => { loadCal(ymd(new Date())); };
  // 月 / 周切换：只重画网格，不重新拉数据，年月和选中日都保留
  const foldBtn = q('#cal-fold');
  const syncFold = () => {
    if (!foldBtn) return;
    const weekView = calState.view === 'week';
    foldBtn.innerHTML = `${icon(weekView ? 'down' : 'up', 14)} <span id="cal-fold-txt">${weekView ? '月' : '周'}</span>`;
    foldBtn.title = weekView ? '展开整月' : '收起成这一周';
    foldBtn.classList.toggle('on', weekView);
  };
  if (foldBtn) {
    foldBtn.onclick = () => {
      calState.view = calState.view === 'week' ? 'month' : 'week';
      syncFold();
      paintCal();
    };
  }
  syncFold();

  const mi = q('#cal-month-input');
  if (mi) {
    mi.onchange = () => { if (/^\d{4}-\d{2}$/.test(mi.value)) { calState.selected = mi.value + '-01'; loadCal(mi.value + '-01'); } };
  }
  q('#cal-jump').onclick = () => {
    if (!mi) return;
    mi.value = calState.month || String(ymd(new Date())).slice(0, 7);
    try { mi.showPicker ? mi.showPicker() : mi.click(); } catch { mi.click(); }
  };
  /* 新首页以时间轴呈现安排，不再运行旧版横幅倒计时。 */
  clearInterval(cdTimer);
}
function shiftMonth(delta) {
  const [y, m] = calState.month.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  loadCal(ymd(d));
}
function renderWeatherOnly() {
  const brief = document.getElementById('wx-brief');
  if (brief) {
    brief.innerHTML = weatherBriefHTML();
    brief.querySelectorAll('[data-pick-city]').forEach((b) => { b.onclick = pickCity; });
    brief.querySelectorAll('[data-wx-forecast]').forEach((b) => { b.onclick = () => openWeatherSheet(); });
    const wr = brief.querySelector('[data-wx-refresh]');
    if (wr) wr.onclick = async () => { await loadWeather(true).catch(() => {}); renderWeatherOnly(); };
  }
  const week = document.getElementById('home-weather-week');
  if (week) week.innerHTML = wxForecastHTML();
  /* 抽屉如果开着（换城市/刷新就发生在这个场景里），里面那份也要跟着换，
     否则会看到「卡片上 8 度、抽屉里还是上一个城市的 20 度」。 */
  const drawer = document.getElementById('wxd-body');
  if (drawer) drawer.innerHTML = wxDrawerHTML();
}

/* 抽屉里那块内容：当前指标 + 逐时 + 未来一周 */
function wxDrawerHTML() {
  if (!state.weather?.raw) {
    return `<div class="small muted" style="padding:10px 0;line-height:1.7">
      天气还没加载出来。回到首页点天气卡右上角的刷新，或换一个城市再试。</div>`;
  }
  return `${wxMetricsHTML()}
    <div class="wxd-title">未来一周</div>
    ${wxForecastHTML()}`;
}

/* 天气详情抽屉：默认不显示，点「详细信息」才打开 */
function openWeatherSheet() {
  const body = el(`<div class="wx-drawer" id="wxd-body">${wxDrawerHTML()}</div>`);
  sheet({ title: `${cityFullName(state.city) + ' · 未来一周天气'}`, body, wide: true });
}

/* 清理计时器（切换页面时） */
window.addEventListener('hashchange', () => { clearInterval(cdTimer); clearInterval(clockTimer); });


