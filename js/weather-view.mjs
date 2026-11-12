/* 天气展示的纯数据层：不碰 DOM，可以直接在 Node 里跑回归测试。
   home.js 只负责把这些行渲染成 HTML（图标 / 文案由 wxInfo 提供）。 */

/* 没有成功定位、也没有手动选过城市时的兜底：湖北武汉。
   之前默认北京，跟用户实际位置差得更远。 */
export const DEFAULT_PLACE = Object.freeze({
  name: '武汉',
  fullName: '湖北 · 武汉',
  province: '湖北',
  prefecture: '武汉',
  district: '',
  lat: 30.5928,
  lon: 114.3055,
  source: 'default',
  locationResolved: true,
});

/* Open-Meteo 地名库对中国县级行政区覆盖不全（实测「咸丰县」「咸丰」都是 0 条），
   而自动定位被拒时用户只能手动输入 —— 结果只能选到 100 公里外的「恩施」。
   这里放一份本地县市级坐标，让县级地名搜得到、坐标落在县城。
   坐标取县城中心，误差远小于拿地级市凑数。 */
const LOCAL_PLACES = [
  ['咸丰县', 29.6779, 109.1398, '湖北', '恩施土家族苗族自治州', '咸丰县'],
  ['恩施市', 30.2965, 109.4866, '湖北', '恩施土家族苗族自治州', '恩施市'],
  ['利川市', 30.2907, 108.9364, '湖北', '恩施土家族苗族自治州', '利川市'],
  ['建始县', 30.6019, 109.7225, '湖北', '恩施土家族苗族自治州', '建始县'],
  ['巴东县', 31.0429, 110.3407, '湖北', '恩施土家族苗族自治州', '巴东县'],
  ['宣恩县', 29.9875, 109.4853, '湖北', '恩施土家族苗族自治州', '宣恩县'],
  ['来凤县', 29.4936, 109.4076, '湖北', '恩施土家族苗族自治州', '来凤县'],
  ['鹤峰县', 29.8906, 110.0344, '湖北', '恩施土家族苗族自治州', '鹤峰县'],
  ['仙桃市', 30.3600, 113.4500, '湖北', '省直辖县级行政区划', '仙桃市'],
  ['潜江市', 30.4200, 112.8800, '湖北', '省直辖县级行政区划', '潜江市'],
  ['天门市', 30.6600, 113.1700, '湖北', '省直辖县级行政区划', '天门市'],
  ['神农架林区', 31.7400, 110.3400, '湖北', '省直辖县级行政区划', '神农架林区'],
];

const stripSuffix = (value) => String(value || '')
  .replace(/(特别行政区|自治州|自治县|自治县|地区|市辖区|林区|县|市|区|镇|乡|旗|盟|省)$/, '')
  .trim();

export function lookupLocalPlaces(kw) {
  const q = String(kw || '').trim().replace(/\s+/g, '');
  if (!q) return [];
  const nq = stripSuffix(q);
  if (!nq) return [];
  return LOCAL_PLACES
    .filter((row) => {
      const n = stripSuffix(row[0]);
      return n === nq || row[0] === q || (nq.length >= 2 && (n.indexOf(nq) >= 0 || nq.indexOf(n) >= 0));
    })
    .slice(0, 6)
    .map((row) => ({
      name: row[0],
      fullName: [row[3], row[4], row[5]]
        .filter((value, index, all) => value && all.indexOf(value) === index).join(' · '),
      province: row[3],
      prefecture: row[4],
      district: row[5],
      lat: row[1],
      lon: row[2],
      source: 'manual',
      locationResolved: true,
      locationProvider: 'local',
    }));
}

/* 位置行：主名称精确到区县（咸丰县），副行给完整行政路径。
   自动定位回来的 fullName 常是「湖北省 · 恩施土家族苗族自治州 · 咸丰县」，
   整串当主标题太长，也看不出自己到底在哪。 */
export function placeNames(city) {
  const c = city || {};
  const short = String(c.district || c.name || '当前位置').trim() || '当前位置';
  const parts = [c.province, c.prefecture, c.district || c.name]
    .map((value) => String(value || '').trim())
    .filter((value, index, all) => value && all.indexOf(value) === index);
  const full = String(c.fullName || '').trim() || parts.join(' · ') || short;
  return { short, full };
}

const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const first = (list) => (Array.isArray(list) ? num(list[0]) : null);

/* 卡片上的「当天详情」 */
export function todayMetrics(raw) {
  const cur = raw?.current || {};
  const day = raw?.daily || {};
  return {
    temp: num(cur.temperature_2m),
    feel: num(cur.apparent_temperature),
    humidity: num(cur.relative_humidity_2m),
    wind: num(cur.wind_speed_10m),
    code: num(cur.weather_code),
    rainProb: first(day.precipitation_probability_max),
    uv: first(day.uv_index_max),
    sunrise: Array.isArray(day.sunrise) ? String(day.sunrise[0] || '').slice(11, 16) : '',
    sunset: Array.isArray(day.sunset) ? String(day.sunset[0] || '').slice(11, 16) : '',
    hi: first(day.temperature_2m_max),
    lo: first(day.temperature_2m_min),
  };
}

const dateKey = (date) => {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/* 某一天的逐时：今天从当前小时起（不显示已经过去的时间），其余日子取全天。
   第一格永远是「现在」，之后每 step 小时一格，跟手机天气的横向时间轴一致。 */
export function hoursForDate(raw, date, { step = 3, now = new Date() } = {}) {
  const hourly = raw?.hourly;
  if (!hourly || !Array.isArray(hourly.time) || !date) return [];
  const today = dateKey(now);
  const nowHour = now.getHours();
  const matched = [];
  for (let i = 0; i < hourly.time.length; i++) {
    const stamp = String(hourly.time[i] || '');
    if (stamp.slice(0, 10) !== date) continue;
    const hour = Number(stamp.slice(11, 13));
    if (!Number.isFinite(hour)) continue;
    if (date === today && hour < nowHour) continue;
    matched.push({
      hour,
      label: `${String(hour).padStart(2, '0')}:00`,
      code: num(hourly.weather_code?.[i]),
      temp: num(hourly.temperature_2m?.[i]),
      pop: num(hourly.precipitation_probability?.[i]),
      isNow: date === today && hour === nowHour,
    });
  }
  return matched.filter((row, index) => index === 0 || index % step === 0);
}

const WD = ['日', '一', '二', '三', '四', '五', '六'];

/* 最近一周：一行一天，供「详细天气」抽屉使用 */
export function weekRows(raw) {
  const day = raw?.daily;
  if (!day || !Array.isArray(day.time)) return [];
  const at = (key, i) => (Array.isArray(day[key]) ? num(day[key][i]) : null);
  return day.time.slice(0, 7).map((date, i) => {
    const d = new Date(`${date}T00:00:00`);
    return {
      date,
      index: i,
      label: i === 0 ? '今天' : i === 1 ? '明天' : (Number.isNaN(d.getTime()) ? '—' : `周${WD[d.getDay()]}`),
      shortDate: String(date).slice(5).replace('-', '/'),
      code: at('weather_code', i),
      hi: at('temperature_2m_max', i),
      lo: at('temperature_2m_min', i),
      pop: at('precipitation_probability_max', i),
      uv: at('uv_index_max', i),
      wind: at('wind_speed_10m_max', i),
      sunrise: Array.isArray(day.sunrise) ? String(day.sunrise[i] || '').slice(11, 16) : '',
      sunset: Array.isArray(day.sunset) ? String(day.sunset[i] || '').slice(11, 16) : '',
    };
  });
}
