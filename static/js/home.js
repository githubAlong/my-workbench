import { api, el, esc, toast, sheet, confirmDialog, promptDialog, ymd, pad2, WD_CN, WD_SHORT, fmtTime, fmtDateTime, relDay, parseDT, countdown, speak, stopSpeak, colorOf, ls, exportUrl, download, addToSystemCalendar } from './core.js';
import { registerView, state, icon, go, render, refreshUnread, onViewLeave } from './ui.js';
import { readLayout, saveLayout, resetLayout, enableDragSort, syncDay, DAY_SYNC, HOME_CARDS } from './homelayout.js';

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
  return [`${name}，${cur[1]}`, cur[2]];
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
async function loadWeather(force = false) {
  const c = state.city;
  const cache = ls.get('weather', null);
  if (!force && cache && cache.city === c.name && Date.now() - cache.at < 20 * 60000) { state.weather = cache; return cache; }
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${c.lat}&longitude=${c.lon}`
    + '&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,wind_speed_10m,wind_direction_10m'
    + '&hourly=temperature_2m,weather_code,precipitation_probability'
    + '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset,uv_index_max,wind_speed_10m_max'
    + '&timezone=auto&forecast_days=7';
  const r = await fetch(url).then((x) => x.json()).catch(() => null);
  if (!r || !r.current) { if (cache) { state.weather = cache; return cache; } throw new Error('天气获取失败'); }
  const w = { city: c.name, at: Date.now(), raw: r };
  state.weather = w; ls.set('weather', w);
  return w;
}
/* 最近的 5 个城市。
   原来是 48 个写死的「常用城市」，问题是：你人在荆州，列表里全是北上广深，
   对你一点用没有，还占满一屏。真正的常用城市就是你自己去过的那几个。
   所以改成记录用户实际切换/定位过的城市，最新的排最前，最多 5 个。 */
const RECENT_MAX = 5;
function recentCities() {
  const a = ls.get('recentCities', []);
  return Array.isArray(a) ? a.filter((c) => c && c.name && c.lat != null).slice(0, RECENT_MAX) : [];
}
function pushRecentCity(c) {
  // 同名去重后插到队首：切回老城市会把它顶到最前面，而不是留个重复项
  const rest = recentCities().filter((x) => x.name !== c.name);
  const next = [{ name: c.name, lat: c.lat, lon: c.lon }, ...rest].slice(0, RECENT_MAX);
  ls.set('recentCities', next);
  return next;
}
/* 把经纬度反查成真实地名。
   原来这段是假的：拿经纬度去问天气接口，再从 timezone 里截最后一段——
   Asia/Shanghai → "Shanghai"。整个中国大陆同属一个时区，所以不管人
   在北京还是成都，定位完都显示 Shanghai。看着像定位成功了，其实城市名从来没对过。

   现在改用 BigDataCloud 的免费反查接口（无需 key，支持中文）。
   它有 city / principalSubdivision 两级，直辖市 city 就等于省，去重一下。
   反查失败不阻塞定位：坐标本身是准的，退成「当前位置」照样能查天气。 */
async function reverseGeocode(lat, lon) {
  try {
    const r = await fetch(
      `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=zh`,
      { signal: AbortSignal.timeout(7000) },
    ).then((x) => (x.ok ? x.json() : null));

    // 「上海市」→「上海」，"北京市" → "北京"
    const trim = (s) => String(s || '').replace(/市$/, '').trim();
    const city = trim(r?.city);
    if (city) return city;

    // 有的地方 city 为空，退到省/州一级
    const prov = trim(r?.principalSubdivision);
    if (prov) return prov;

    // 连行政区都没查到时，至少把坐标标出来，别谎报一个城市名
    return `${lat.toFixed(2)}, ${lon.toFixed(2)}`;
  } catch {
    return `${lat.toFixed(2)}, ${lon.toFixed(2)}`;
  }
}
async function locate() {
  if (!navigator.geolocation) return toast('当前设备不支持定位', 'warn');
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(async (pos) => {
      const { latitude, longitude } = pos.coords;
      const name = await reverseGeocode(latitude, longitude);
      /* 定位用 GPS 原始坐标，不往任何城市表上吸附。
         天气接口本身按坐标算，GPS 落点比「市中心」还准。 */
      state.city = { name, lat: latitude, lon: longitude };
      ls.set('city', state.city);
      pushRecentCity(state.city);
      resolve(state.city);
    }, (err) => { toast('定位失败：' + (err.message || '请改用上方搜索框输入城市名'), 'warn'); resolve(null); },
    { timeout: 9000, maximumAge: 600000 });
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
  const q = (s) => `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(s)}&count=10&language=zh&format=json`;

  const grab = async (s) => {
    try {
      const r = await fetch(q(s), { signal: AbortSignal.timeout(8000) })
        .then((x) => (x.ok ? x.json() : null));
      return r?.results || [];
    } catch { return []; }
  };

  // 「荆州」→ 再试一次「荆州市」；已经带「市」就不重复加
  let rows = await grab(kw2);
  if (!/市$/.test(kw2)) rows = rows.concat(await grab(kw2 + '市'));

  /* 本地城市表兜底：在线库查不到（断网 / 接口挂了 / 生僻写法）时，
     从内置表里按包含关系找。命中的排在最前面，弱化「没找到」的死路。 */
  const seedHit = SEED_CITIES.filter((c) => c.name.includes(kw2) || kw2.includes(c.name))
    .slice(0, 4)
    .map((c) => ({ name: c.name, latitude: c.lat, longitude: c.lon, feature_code: 'PPLA2', admin1: '本地常用', population: 9e9 }));
  if (seedHit.length) rows = seedHit.concat(rows);

  const BAD = new Set(['AIRP', 'ADM1', 'ADM2', 'ADM3', 'ADM4', 'PPLX', 'HSP', 'STM']);
  const rank = (r) => {
    const f = r.feature_code || '';
    if (f === 'PPLC') return 0;        // 首都
    if (f === 'PPLA') return 1;        // 省会 / 直辖市
    if (f === 'PPLA2') return 2;       // 地级市驻地
    if (f === 'PPLA3' || f === 'PPLA4') return 3;
    if (f === 'PPL') return 4;         // 普通城镇/村
    return 5;
  };

  const seen = new Set();
  return rows
    .filter((r) => r && r.latitude != null && !BAD.has(r.feature_code))
    .sort((a, b) => {
      const d = rank(a) - rank(b);
      if (d) return d;
      return (b.population || 0) - (a.population || 0);
    })
    .map((r) => ({
      // 「荆州市」显示成「荆州」更好看，重复的后缀去掉一层
      name: String(r.name || '').replace(/市$/, '') || kw2,
      lat: r.latitude,
      lon: r.longitude,
      admin: [r.admin1, r.country].filter(Boolean).join(' · '),
    }))
    .filter((r) => {
      // 同名同省只留一个（带「市」和不带「市」会查出同一个地方）
      const k = `${r.name}|${r.admin}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, 6);
}

function pickCity() {
  /* 城市选择面板。只有三样东西：搜索框、最近去过的城市、定位按钮。
     写死的 48 个城市和「手动输入经纬度」都删了——
     前者对「人在荆州」的人毫无用处，后者根本没人知道自己脚下的坐标。 */
  const cur = state.city?.name || '';
  const body = el(`<div class="sheet-body">
    <div class="field" style="margin-bottom:12px">
      <input class="input" id="city-kw" placeholder="输入城市名，如 荆州、周口、鞍山" autocomplete="off">
      <div class="small muted" id="city-tip" style="margin-top:6px">直接输入城市名即可，不用管经纬度</div>
    </div>
    <div class="row wrap" id="city-result" style="gap:8px"></div>
    <div id="city-recent-wrap">
      <div class="field-label" style="margin:4px 0 8px">最近使用</div>
      <div class="row wrap" id="city-recent" style="gap:8px"></div>
    </div>
    <hr class="hr">
    <div class="row" style="margin-bottom:2px">
      <button class="btn soft sm" id="use-geo">${icon('loc', 15)} 用当前位置定位</button>
      <span class="small muted">需要允许浏览器的定位权限</span>
    </div>
  </div>`);

  const s = sheet({ title: '选择所在城市', body });

  /* 【第 8 条：切换城市后天气没跟着变】
     真因不是天气接口坏，是 refreshHome() 只重新拉了 /home 的业务数据，
     根本没再调 loadWeather()——页面于是拿「上一个城市」缓存的天气重画了一遍，
     城市名换成了新的，温度还是老的。看起来像「只改了名字」。
     正确做法：切城市 → 强制重拉这一座城市的天气 → 只重绘天气那块。
     不整页 refreshHome()，是因为整页重绘会把展开的天气预报折叠回去。 */
  const commit = (c) => {
    state.city = { name: c.name, lat: c.lat, lon: c.lon };
    ls.set('city', state.city);
    pushRecentCity(state.city);
    s.close();
    toast('已切换到 ' + c.name);
    applyCityWeather();
  };

  const recentBox = body.querySelector('#city-recent');
  const recentWrap = body.querySelector('#city-recent-wrap');
  const resBox = body.querySelector('#city-result');
  const kw = body.querySelector('#city-kw');
  const tip = body.querySelector('#city-tip');

  // 一条记录都没有时把整块藏掉，别留个空标题在那儿
  const renderRecent = () => {
    const rows = recentCities();
    recentWrap.hidden = rows.length === 0;
    recentBox.innerHTML = rows.map((c, i) => `
      <button class="chip-btn${c.name === cur ? ' on' : ''}" data-r="${i}">${esc(c.name)}</button>`).join('');
    recentBox.querySelectorAll('[data-r]').forEach((b) => {
      b.onclick = () => commit(recentCities()[Number(b.dataset.r)]);
    });
  };
  renderRecent();

  /* 输入即搜。防抖 350ms，避免每敲一个字就打一次接口；
     seq 用来丢弃过期响应——打字快的时候先发的请求可能后回来，
     不判断就会出现「输入荆州、列表显示上周口」这种错乱。 */
  let timer = 0; let seq = 0;
  const runSearch = async () => {
    const q = kw.value.trim();
    const my = ++seq;
    if (!q) {
      resBox.innerHTML = ''; recentWrap.hidden = recentCities().length === 0;
      tip.textContent = '直接输入城市名即可，不用管经纬度'; tip.style.color = '';
      return;
    }
    tip.textContent = '正在查找…';
    const rows = await geocodeCity(q);
    if (my !== seq) return;
    recentWrap.hidden = true;
    if (!rows.length) {
      resBox.innerHTML = '';
      tip.textContent = `没找到「${q}」，换个写法试试（例如加上「市」）`;
      return;
    }
    tip.textContent = `找到 ${rows.length} 个，点一下即可切换`;
    resBox.innerHTML = rows.map((r, i) => `
      <button class="chip-btn${r.name === cur ? ' on' : ''}" data-i="${i}">
        ${esc(r.name)}${r.admin ? `<span class="small muted" style="margin-left:6px">${esc(r.admin)}</span>` : ''}
      </button>`).join('');
    resBox.querySelectorAll('[data-i]').forEach((b) => {
      b.onclick = () => commit(rows[Number(b.dataset.i)]);
    });
  };

  kw.oninput = () => { clearTimeout(timer); timer = setTimeout(runSearch, 350); };
  // 回车直接取第一条：输入「荆州」回车就切过去，不用再去点
  kw.onkeydown = async (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault(); clearTimeout(timer);
    await runSearch();
    const first = resBox.querySelector('[data-i="0"]');
    if (first) first.click();
  };

  body.querySelector('#use-geo').onclick = async () => {
    const c = await locate();
    if (c) { s.close(); toast('已定位：' + c.name); applyCityWeather(); }
  };
}

/* 顶栏用的「简要天气」：只留一眼要看的——温度、天气、穿搭。
   湿度/风速/日出日落、小时预报、7 天预报都折进「详细天气」里 */
function weatherBriefHTML() {
  const w = state.weather?.raw;
  const c = state.city;
  /* 降级分支也必须带「选城市」和「刷新」。
     早先这里只输出城市名，一旦天气拉不到（断网 / 接口被墙），
     整个天气卡就只剩一行字，连切城市和重试的按钮都没有 ——
     用户就被卡死在「北京 天气加载中」，怎么点都没用（第 8 条）。 */
  if (!w) return `<div class="wxb-city">${icon('loc', 12)} ${esc(c.name)}
      <button class="loc-btn" data-pick-city title="选择所在城市">${icon('loc', 10)} 选城市</button>
      <span style="flex:1"></span>
      <button class="icon-btn sm" data-wx-refresh title="重新加载天气">${icon('refresh', 14)}</button>
    </div>
    <div class="wxb-main"><div class="wxb-temp">--<span class="deg">°</span></div>
      <div class="wxb-side"><div class="wxb-desc">天气没加载出来</div>
        <div class="wxb-range">点右上角刷新，或换个城市试试</div></div></div>`;
  const cur = w.current; const [emo, desc] = wxInfo(cur.weather_code);
  const day = w.daily;
  const rainToday = (day.precipitation_probability_max?.[0] || 0) > 40 || cur.precipitation > 0;
  return `<div class="wxb-city">${icon('loc', 12)} ${esc(c.name)}
      <button class="loc-btn" data-pick-city title="选择所在城市">${icon('loc', 10)} 选城市</button>
      <span style="flex:1"></span>
      <button class="icon-btn sm" data-wx-refresh title="刷新天气">${icon('refresh', 14)}</button>
    </div>
    <div class="wxb-main">
      <span class="wxb-emoji">${emo}</span>
      <span class="wxb-temp">${Math.round(cur.temperature_2m)}<span class="deg">°</span></span>
      <div class="wxb-side">
        <div class="wxb-desc">${desc}</div>
        <div class="wxb-range">${Math.round(day.temperature_2m_min[0])}° ~ ${Math.round(day.temperature_2m_max[0])}° · 体感 ${Math.round(cur.apparent_temperature)}°</div>
      </div>
    </div>
    <div class="wxb-outfit">${esc(outfitFor(cur.temperature_2m, cur.weather_code, cur.wind_speed_10m, rainToday))}</div>`;
}

function weatherHTML() {
  const w = state.weather?.raw;
  const c = state.city;
  if (!w) return `<div class="wx-top"><div style="flex:1">
      <div class="wx-city">${esc(c.name)} <button class="loc-btn" data-pick-city title="选择所在城市">${icon('loc', 11)} 选城市</button></div>
      <div class="wx-desc" style="margin-top:6px">天气没加载出来，点右上角刷新或换个城市</div></div>
      <span style="flex:1"></span>
      <button class="icon-btn" data-wx-refresh title="重新加载天气">${icon('refresh', 15)}</button></div>`;
  const cur = w.current; const [emo, desc] = wxInfo(cur.weather_code);
  const day = w.daily;
  return `
    <div class="wx-top">
      <div class="wx-city">${icon('loc', 13)} ${esc(c.name)}
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
let clockTimer = null;
let clockAlign = null;
let lastGreetKey = '';
let lastFootKey = '';

registerView(async function home(main) {
  clearInterval(clockTimer);
  main.innerHTML = `<div class="empty"><div class="em">⏳</div>正在准备今天的工作台…</div>`;
  /* 不再自动申请定位权限。
     原来首次进首页就调 locate()，桌面浏览器一律弹授权框；用户点了拒绝，
     还要再吃一个红色「定位失败」的 toast——等于每开一次页面先添一次堵。
     现在默认用上次选过的城市（从没选过就用北京），想定位的人自己点
     「选城市 → 用当前位置定位」。定位从「默认动作」降级成「可选动作」。
     面板第一行是城市名搜索：没人知道自己脚下的经纬度是多少，
     输入「荆州」就该能切到荆州。 */
  try { await loadWeather(); } catch (e) { /* 离线降级 */ }
  // 必须显式带上浏览器本地日期：服务器可能跑在 UTC，跨零点时按它自己算
  // 会把今天算成昨天，刚记的便签就变成「存进去却看不见」。
  homeData = await api.get('/home', { date: ymd() });
  renderHome();
});

/* 换城市之后统一走这里：先把天气真正换成新城市的，再只重绘天气区块。
   两件事分开做是有意的——天气是外网请求，可能慢、可能失败；
   失败了也不能让「城市名已经切了但温度还是旧的」这种半吊子状态留在页面上，
   所以失败时把旧天气清掉，让界面老实显示「天气加载中…」。 */
async function applyCityWeather() {
  const brief = document.getElementById('wx-brief');
  if (brief) brief.innerHTML = weatherBriefHTML();   // 先落城市名，别让用户以为没点上
  try {
    await loadWeather(true);
  } catch {
    state.weather = null;
    toast('天气没拉到，可点天气卡右上角的刷新重试', 'warn');
  }
  renderWeatherOnly();
}

async function refreshHome() {
  homeData = await api.get('/home', { date: ymd() }).catch(() => homeData);
  renderHome();
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
  const [g1, g2] = greetFor(name);
  const todayCourses = d.courses.filter((c) => c.date === d.date);

  main.innerHTML = `
  <div class="searchbar" id="searchbar">
    <span class="sb-ico">${icon('search', 17)}</span>
    <input id="gsearch" placeholder="搜索事项、任务、上课、出差、笔记…" autocomplete="off" enterkeyhint="search">
    <button class="sb-clear" id="search-clear" title="清空" aria-label="清空" hidden>${icon('close', 15)}</button>
    <button class="sb-go" id="search-go" title="搜索" aria-label="搜索">${icon('search', 15)}</button>
  </div>
  <div class="sr-scrim" id="search-scrim" hidden></div>
  <div class="sr-panel" id="search-result" hidden></div>

  <section class="card card-pad quote quote-top">
    <div class="qt-head">
      <div class="card-title" style="margin-bottom:0">${icon('sun', 15)} 每日一句</div>
      <span style="flex:1"></span>
      <button class="btn ghost sm" id="quote-next" title="换一句，不打断今天已定的那句">${icon('refresh', 14)} 换一句</button>
    </div>
    <div class="quote-en">
      <span class="qt" id="q-en">${esc(d.quote.en)}</span>
      <button class="speak-btn" id="speak-btn" title="朗读英文" aria-label="朗读英文">${icon('speak', 15)}</button>
    </div>
    <div class="quote-zh" id="q-zh">${esc(d.quote.zh)}</div>
    <div class="quote-by">
      <span id="q-author">— ${esc(d.quote.author || '')}</span>
      <span class="tiny" id="speak-tip">点喇叭听英文</span>
    </div>
  </section>

  <div class="topbar">
    <section class="card clk-card">
      <div class="clk-hello">
        ${homeAvatarHTML(52)}
        <div class="clk-hello-t">
          <div class="clk-greet" id="greet-line">${esc(g1)}</div>
          <div class="clk-greet-sub" id="greet-sub">${greetIcon()} ${esc(g2)}</div>
        </div>
        <button class="icon-btn sm" id="theme-btn" title="主题外观">${icon('sun', 17)}</button>
      </div>
      <div class="clock-row">
        <div class="clock" id="clock"><span class="hm">--:--</span><span class="sec">--</span></div>
        <button class="icon-btn msg-bell" data-msg title="消息中心" aria-label="消息中心">${icon('bell', 19)}
          ${d.unread ? `<span class="badge-dot msg-bell-dot">${d.unread > 99 ? '99+' : d.unread}</span>` : ''}
        </button>
      </div>
      <div class="clock-date" id="clock-date"></div>
      <div class="clk-foot" id="clk-foot"></div>
    </section>

    <section class="card wx-card" id="wx-card">
      <div class="wx-body">
        <div id="wx-brief">${weatherBriefHTML()}</div>
        <div class="wx-aside" id="wx-aside">${wxForecastHTML()}</div>
      </div>
      <button class="wx-more" id="wx-more" aria-expanded="false">
        <span>${icon('down', 13)} <b>详细天气</b></span>
      </button>
      <div class="wx-fold" id="wx-fold" hidden>
        <div class="wx-col" id="wx-metrics">${wxMetricsHTML()}</div>
        <div class="wx-forecast" id="wx-forecast">${wxForecastHTML()}</div>
      </div>
    </section>
  </div>

  <section class="cd-bar" id="cd-card">
    <div class="cdb-body" id="cd-body"></div>
  </section>

  <div class="home-grid" id="home-grid">
    <div class="home-col" data-col="0">
      <section class="card home-card" data-hcard="items" data-col="0">
        <div class="hc-head">
          <span class="hc-grip" data-drag-handle title="按住拖动，可换列换顺序" aria-label="拖动调整位置">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg>
          </span>
          <div class="card-title">${icon('check', 16)} 今日事项 <span class="chip blue" style="margin-left:4px">${d.items.length}</span>
            <button class="more" data-add-item2>＋ 新增</button></div>
        </div>
        <div class="card-pad hc-body" style="padding-top:2px" id="today-items"></div>
        <div class="card-pad quick-inline">
          <div class="qi-row">
            <span class="qi-ico">${icon('edit', 15)}</span>
            <input id="quick-input" placeholder="想到什么先记一笔，回车保存…" autocomplete="off">
            <button class="qi-time" id="quick-time" title="加时间提醒">${icon('clock', 14)}</button>
            <button class="btn primary sm" id="quick-save">保存</button>
          </div>
          <div class="qi-hint" id="quick-hint"></div>
        </div>
      </section>

      <section class="card home-card" data-hcard="courses" data-col="0">
        <div class="hc-head">
          <span class="hc-grip" data-drag-handle title="按住拖动，可换列换顺序" aria-label="拖动调整位置">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg>
          </span>
          <div class="card-title">${icon('book', 16)} 今日课程 <span class="chip teal" style="margin-left:4px">${todayCourses.length}</span>
            <button class="more" data-goto2="work/timetable">课表 ›</button></div>
        </div>
        <div class="card-pad hc-body" style="padding-top:2px" id="today-courses"></div>
      </section>
    </div>

    <div class="home-col" data-col="1">
      <section class="card card-pad calendar-card home-card" data-hcard="calendar" data-col="1">
        <div class="hc-head hc-head-cal">
          <span class="hc-grip" data-drag-handle title="按住拖动，可换列换顺序" aria-label="拖动调整位置">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg>
          </span>
          <div class="cal-head" style="flex:1;margin:0">
            <div class="cal-title" id="cal-title"></div>
            <span style="flex:1"></span>
            <button class="cal-nav" id="cal-prev" title="上个月" aria-label="上个月">${icon('left', 18)}</button>
            <button class="cal-nav" id="cal-next" title="下个月" aria-label="下个月">${icon('right', 18)}</button>
            <button class="btn ghost sm" id="cal-fold" title="月 / 周视图">${icon('cal', 14)} <span id="cal-fold-txt">周</span></button>
            <button class="btn ghost sm" id="cal-today" style="margin-left:2px">今天</button>
            <button class="month-btn" id="cal-jump" title="选择年月">${icon('cal', 15)}<span>年月</span></button>
            <input type="month" id="cal-month-input" class="month-hidden" aria-hidden="true" tabindex="-1">
          </div>
        </div>
        <div class="cal-week">${['日', '一', '二', '三', '四', '五', '六'].map((x, i) => `<span class="${i === 0 || i === 6 ? 'we' : ''}">${x}</span>`).join('')}</div>
        <div class="cal-grid" id="cal-grid"></div>
        <div class="cal-legend">
          <span><i style="background:var(--primary)"></i>事项</span>
          <span><i style="background:var(--teal)"></i>上课</span>
          <span><i style="background:var(--amber)"></i>监考/出差</span>
          <span><i style="background:var(--purple)"></i>提醒</span>
        </div>
        <div class="cal-day" id="cal-day"></div>
      </section>
    </div>
  </div>`;

  bindHome();
  applyLayout();
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

    const dEl = document.getElementById('clock-date');
    if (dEl) {
      const wd = now.getDay();
      const weekend = wd === 0 || wd === 6;
      dEl.innerHTML = `<span>${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日</span>`
        + `<span class="wd-badge${weekend ? ' weekend' : ''}">${WD_CN[wd]}</span>`;
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
      const [a, b] = greetFor(nm);
      const g = document.getElementById('greet-line');
      if (g && g.textContent !== a) g.textContent = a;
      const sub = document.getElementById('greet-sub');
      if (sub) sub.textContent = `${greetIcon()} ${b}`;
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

function renderTodayItems() {
  const box = document.getElementById('today-items');
  if (!box || !homeData) return;
  const rows = homeData.items || [];
  if (!rows.length) { box.innerHTML = `<div class="empty" style="padding:20px">今天还没有事项，右上角「＋ 新增」或上面的便签记一笔</div>`; return; }
  box.innerHTML = rows.map((it) => {
    const t = it.start_at ? fmtTime(it.start_at) : '';
    const done = it.status === 'done';
    return `<div class="task-row" data-item="${it.id}">
      <span class="prio ${it.priority}"></span>
      <button class="task-check ${done ? 'done' : ''}" data-check="${it.id}" data-status="${it.status}">${done ? icon('check', 14) : ''}</button>
      <div class="task-main" data-edit-item="${it.id}">
        <div class="task-title ${done ? 'done' : ''}">${esc(it.title)}</div>
        <div class="task-sub">${it.kind !== '事项' ? `<span class="chip" style="height:19px;font-size:10.5px">${esc(it.kind)}</span>` : ''}${it.detail ? esc(it.detail) : ''}${it.source === '便签' ? '<span class="chip amber" style="height:19px;font-size:10.5px">来自便签</span>' : ''}${t ? `<span class="task-time">${t}</span>` : ''}</div>
      </div>
    </div>`;
  }).join('');
  box.querySelectorAll('[data-check]').forEach((b) => {
    b.onclick = async () => {
      const st = b.dataset.status === 'done' ? 'todo' : 'done';
      await api.patch('/items/' + b.dataset.check, { status: st });
      const it = homeData.items.find((x) => String(x.id) === b.dataset.check);
      if (it) { it.status = st; if (st === 'done') toast('已完成'); }
      renderTodayItems(); refreshHome();
    };
  });
  box.querySelectorAll('[data-edit-item]').forEach((b) => {
    b.onclick = () => {
      const it = homeData.items.find((x) => String(x.id) === b.dataset.editItem);
      /* 【第 11 条：联动】
         原来点事项只弹一个编辑框，右边日历完全不知道你在看哪天。
         现在点一下，先让日历选中那一天（右边会亮起来、下面加载那天的全部安排），
         再开编辑框。
         顺序是有讲究的：先联动再开弹窗。反过来的话弹窗一遮，
         日历在背后跳成什么样用户看不见，联动就白做了。 */
      if (it?.date) { syncDay(it.date, 'items'); jumpCalTo(it.date); }
      editItem(it);
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
  calState.selected = date;
  paintCal();
  loadDay(date);
}

/* 日历广播过来的日期同步到事项卡抬头。
   只是把「正在看哪天」写出来，不改列表内容——
   事项卡的名字就叫「今日事项」，按别的日期过滤会名不副实。 */
document.addEventListener(DAY_SYNC, (e) => {
  const { date, source } = e.detail || {};
  if (!date || source === 'items') return;   /* items 那条自己去跳日历，不回流 */
  const box = document.getElementById('today-items');
  const head = box?.closest('.home-card')?.querySelector('.card-title');
  if (!head) return;
  const chip = head.querySelector('.hc-daychip');
  const label = date === homeData?.date ? '今天' : `${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日`;
  if (chip) chip.textContent = label;
  else {
    const c = document.createElement('span');
    c.className = 'chip gray hc-daychip';
    c.style.cssText = 'margin-left:4px';
    c.textContent = label;
    head.appendChild(c);
  }
});

function renderTodayCourses() {
  const box = document.getElementById('today-courses');
  if (!box || !homeData) return;
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const list = homeData.courses.filter((c) => c.date === homeData.date);
  if (!list.length) { box.innerHTML = `<div class="empty" style="padding:20px">今天没有课，好好备课或休息一下</div>`; return; }
  box.innerHTML = list.map((c) => {
    const [sh, sm] = (c.start_time || '0:0').split(':').map(Number);
    const [eh, em] = (c.end_time || '0:0').split(':').map(Number);
    const s = sh * 60 + sm, e = eh * 60 + em;
    const isNow = nowMin >= s && nowMin <= e;
    const past = nowMin > e;
    return `<div class="course-row">
      <span class="course-bar" style="background:${colorOf(c.class_name)}"></span>
      <span class="course-time">${c.start_time}<br><span class="muted">${c.end_time}</span></span>
      <div style="flex:1;min-width:0">
        <div class="course-name">${esc(c.class_name)} <span class="small muted">${esc(c.subject)} · 第${c.period_no}节</span> ${isNow ? '<span class="now-badge">正在上</span>' : past ? '<span class="tiny muted">已结束</span>' : ''}</div>
        <div class="course-room">${esc(c.room || '')} ${c.rescheduled ? '<span class="chip amber" style="height:18px;font-size:10px">已调课</span>' : ''}</div>
      </div>
      <button class="btn ghost sm" data-lesson-add="${c.period_no}" data-class="${esc(c.class_name)}" data-subject="${esc(c.subject)}">记进度</button>
    </div>`;
  }).join('');
  box.querySelectorAll('[data-lesson-add]').forEach((b) => {
    b.onclick = () => { go('work/lessons?add=1&period=' + b.dataset.lessonAdd + '&class=' + encodeURIComponent(b.dataset.class) + '&subject=' + encodeURIComponent(b.dataset.subject)); };
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
let calState = { month: '', data: null, selected: '', view: 'month' };
async function loadCal(monthDay) {
  const month = String(monthDay).slice(0, 7);
  calState.month = month;
  calState.selected = monthDay;
  let data;
  if (month === String(homeData?.date || '').slice(0, 7) && homeData.courses_month) {
    data = {
      month, courses: homeData.courses_month,
      items: (homeData.items || []), lessons: homeData.lessons || [],
      invigilations: homeData.invigilations || [], reminders: [], trips: [],
    };
  }
  data = await api.get('/calendar', { month }).catch(() => data);
  if (!String(monthDay).startsWith(month)) return;
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
  if (title) title.innerHTML = `${m}月 <small>${y}年</small>`;
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
      paintCal();
      loadDay(b.dataset.day);
      /* 反过来也要成立：点日历那一天，左边事项区要给出回应。
         左边只显示「今天」的事项，所以不能真的过滤成那一天（会变成空列表），
         但可以把选中日期画在事项卡标题上，让两边的「当前日期」始终一致。
         source 标成 calendar，避免和上面 items 那条互相触发。 */
      syncDay(b.dataset.day, 'calendar');
    };
  });
  loadDay(calState.selected);
}

async function loadDay(date) {
  const box = document.getElementById('cal-day');
  if (!box) return;
  box.innerHTML = `<div class="cal-day-head"><span class="cal-day-date">${esc(date)}</span></div><div class="cal-day-empty">正在加载…</div>`;
  const d = await api.get('/calendar/day', { date }).catch(() => null);
  if (!box.isConnected) return;
  if (!d) { box.innerHTML = '<div class="cal-day-empty">加载失败</div>'; return; }
  const evs = [];
  for (const c of d.courses) evs.push({ s: c.start_time, e: c.end_time, k: 'course', title: `${c.class_name} ${c.subject}`, sub: `第${c.period_no}节${c.room ? ' · ' + c.room : ''}`, color: 'var(--teal)' });
  for (const i of d.items) {
    const s = i.start_at ? String(i.start_at).slice(11, 16) : '';
    evs.push({ s, e: i.end_at ? String(i.end_at).slice(11, 16) : '', k: 'item', title: i.title, sub: `${i.kind}${i.detail ? ' · ' + i.detail : ''}`, color: 'var(--primary)', id: i.id, status: i.status });
  }
  for (const g of d.invigilations || []) evs.push({ s: String(g.start_at || '').slice(11, 16), e: String(g.end_at || '').slice(11, 16), k: 'inv', title: `${g.subject} 监考`, sub: `${g.type}${g.place ? ' · ' + g.place : ''}`, color: 'var(--amber)' });
  for (const l of d.lessons || []) evs.push({ s: l.start_time || '', e: l.end_time || '', k: 'lesson', title: `${l.class_name} ${l.content || '已上课'}`, sub: l.progress || '已完成课时', color: 'var(--purple)' });
  evs.sort((a, b) => (a.s || '99').localeCompare(b.s || '99'));
  const wd = WD_CN[new Date(date + 'T00:00').getDay()];
  const isToday = date === ymd(new Date());
  const rows = evs.map((e) => `<div class="cal-day-row">
      <span class="cal-day-t">${e.s ? esc(e.s + (e.e ? '–' + e.e : '')) : '全天'}</span>
      <span class="cal-day-dot" style="background:${e.color}"></span>
      <div class="cal-day-body">
        <div class="cal-day-title">${esc(e.title)}${e.status === 'done' ? ' <span class="chip green" style="height:16px;font-size:9.5px">已完成</span>' : ''}</div>
        ${e.sub ? `<div class="cal-day-sub">${esc(e.sub)}</div>` : ''}
      </div>
    </div>`).join('');
  box.innerHTML = `
    <div class="cal-day-head">
      <span class="cal-day-date">${mNum(date)}月${Number(date.slice(8, 10))}日</span>
      <span class="cal-day-wd">${wd}${isToday ? ' · 今天' : ''}</span>
      <span class="cal-day-count">${evs.length} 项</span>
      <span style="flex:1"></span>
      <button class="btn soft sm" data-add-day="${date}" style="padding:4px 10px;font-size:12px">＋ 添加</button>
    </div>
    ${evs.length ? `<div class="cal-day-list">${rows}</div>` : `<div class="cal-day-empty">这一天还没有安排<br><span class="tiny">点右上「＋ 添加」记一件事项</span></div>`}`;
  box.querySelectorAll('[data-add-day]').forEach((b) => { b.onclick = () => editItem(null, date); });
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
function calFoldPref(k, v) {
  try {
    const key = 'home_' + k;
    if (v === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, v);
    return v;
  } catch { return null; }
}

/* ================= 首页自定义布局（第 10 条） =================
   applyLayout()：按账号里存的位置把卡片摆到对应列、对应顺序。
   renderHome() 每次都重建 DOM（卡片回到模板里的默认位），
   所以必须每次重建完都重摆一遍——只在首次摆是不够的，
   任何一次刷新首页都会把用户拖好的顺序冲回默认。 */
let dragCleanup = null;
function applyLayout() {
  const grid = document.getElementById('home-grid');
  if (!grid) return;
  const cols = grid.querySelectorAll('.home-col');
  if (!cols.length) return;

  const layout = readLayout() || HOME_CARDS.map((c) => ({ id: c.id, col: c.col }));
  for (const item of layout) {
    const card = grid.querySelector(`[data-hcard="${item.id}"]`);
    if (!card) continue;
    const col = cols[Math.min(item.col, cols.length - 1)];
    col.appendChild(card);   /* appendChild 按调用顺序决定先后，天然就是排序 */
  }

  /* 重绑前先解绑上一次的监听，否则每刷新一次就叠一层，
     拖一次会触发 N 个回调，最后存进去的是哪一次全看运气 */
  if (dragCleanup) { try { dragCleanup(); } catch {} dragCleanup = null; }
  dragCleanup = enableDragSort(grid, {
    onDrop: (cards) => {
      saveLayout(cards);
      toast('布局已记住，换设备登录也是这个样子', 'ok', 2500);
    },
  });
  onViewLeave(() => { if (dragCleanup) { try { dragCleanup(); } catch {} dragCleanup = null; } });
}

/* 恢复默认布局的入口，挂在首页标题区的「重置布局」上 */
export function restoreHomeLayout() {
  resetLayout();
  applyLayout();
  toast('已恢复默认布局');
}

function bindHome() {
  const q = (s) => document.querySelector(s);
  q('#theme-btn').onclick = () => { import('./ui.js').then((m) => m.openThemeSheet()); };
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
  document.querySelectorAll('[data-add-item]').forEach((b) => { b.onclick = () => editItem(null, homeData.date); });
  document.querySelectorAll('[data-add-item2]').forEach((b) => { b.onclick = () => editItem(null, homeData.date); });

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
  const wxMore = q('#wx-more');
  const wxFold = q('#wx-fold');
  const topbar = q('.topbar');
  const setWx = (open, remember) => {
    wxFold.hidden = !open;
    wxMore.setAttribute('aria-expanded', open ? 'true' : 'false');
    wxMore.classList.toggle('open', open);
    if (topbar) topbar.classList.toggle('wx-open', open);
    if (remember) calFoldPref('wxOpen', open ? '1' : '0');
  };
  if (wxMore && wxFold) {
    // 记住上次是展开还是收起，下次进来不用再点
    const openPref = calFoldPref('wxOpen') === '1';
    setWx(openPref, false);
    if (openPref) bindWxRefresh();
    wxMore.onclick = () => {
      const open = wxFold.hidden;
      setWx(open, true);
      if (open) bindWxRefresh();
    };
  }

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
      await api.post('/quick', { text, at: quickAt || null, remind_min: quickAt ? 10 : null });
      qi.value = ''; quickAt = '';
      if (qh) { qh.textContent = ''; qh.classList.remove('on'); }
      if (qtBtn) qtBtn.classList.remove('on');
      toast('已记一笔，进「今日事项」和「日常」便签');
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
  q('#cal-today').onclick = () => { calState.selected = ymd(new Date()); loadCal(ymd(new Date())); paintCal(); };
  // 月 / 周切换：只重画网格，不重新拉数据，年月和选中日都保留
  const foldBtn = q('#cal-fold');
  const foldTxt = q('#cal-fold-txt');
  const syncFold = () => {
    if (foldTxt) foldTxt.textContent = calState.view === 'week' ? '月' : '周';
    if (foldBtn) foldBtn.title = calState.view === 'week' ? '展开整月' : '收起成这一周';
    if (foldBtn) foldBtn.classList.toggle('on', calState.view === 'week');
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
  paintCountdown();
  clearInterval(cdTimer);
  cdTimer = setInterval(paintCountdown, 1000);
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
    const wr = brief.querySelector('[data-wx-refresh]');
    if (wr) wr.onclick = async () => { await loadWeather(true).catch(() => {}); renderWeatherOnly(); };
  }
  const det = document.getElementById('wx-metrics');
  if (det) det.innerHTML = wxMetricsHTML();
  const fc = document.getElementById('wx-forecast');
  if (fc) fc.innerHTML = wxForecastHTML();
  // 宽屏右侧那份并排预报，换城市/刷新天气时必须一起更新，否则显示的还是旧城市的
  const aside = document.getElementById('wx-aside');
  if (aside) aside.innerHTML = wxForecastHTML();
}

/* 清理计时器（切换页面时） */
window.addEventListener('hashchange', () => { clearInterval(cdTimer); clearInterval(clockTimer); });
