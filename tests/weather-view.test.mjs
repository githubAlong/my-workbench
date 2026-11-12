import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  DEFAULT_PLACE, lookupLocalPlaces, placeNames, todayMetrics, hoursForDate, weekRows,
} from '../js/weather-view.mjs';

const DAYS = ['2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15', '2026-11-16', '2026-11-17', '2026-11-18'];
const pad = (n) => String(n).padStart(2, '0');

function makeRaw() {
  const times = [];
  const temps = [];
  const codes = [];
  const pops = [];
  for (let d = 0; d < DAYS.length; d++) {
    for (let h = 0; h < 24; h++) {
      times.push(`${DAYS[d]}T${pad(h)}:00`);
      temps.push(8 + d + h / 10);
      codes.push(d % 2 === 0 ? 3 : 61);
      pops.push((h * 7 + d) % 100);
    }
  }
  return {
    current: {
      temperature_2m: 13.4, apparent_temperature: 12.1, relative_humidity_2m: 62,
      wind_speed_10m: 7.5, weather_code: 3, precipitation: 0,
    },
    hourly: { time: times, temperature_2m: temps, weather_code: codes, precipitation_probability: pops },
    daily: {
      time: DAYS,
      weather_code: [3, 61, 0, 2, 80, 3, 71],
      temperature_2m_max: [15, 16, 18, 17, 14, 13, 11],
      temperature_2m_min: [9, 10, 11, 10, 8, 7, 5],
      precipitation_probability_max: [20, 70, 0, 10, 80, 30, 60],
      uv_index_max: [3, 2, 5, 4, 1, 3, 2],
      wind_speed_10m_max: [11, 18, 9, 12, 22, 8, 14],
      sunrise: DAYS.map((d) => `${d}T06:52`),
      sunset: DAYS.map((d) => `${d}T17:38`),
    },
  };
}

test('没定位也没手动选过时，默认城市是湖北武汉', () => {
  assert.equal(DEFAULT_PLACE.name, '武汉');
  assert.equal(DEFAULT_PLACE.fullName, '湖北 · 武汉');
  assert.ok(Math.abs(DEFAULT_PLACE.lat - 30.5928) < 0.001);
  assert.ok(Math.abs(DEFAULT_PLACE.lon - 114.3055) < 0.001);
  assert.equal(DEFAULT_PLACE.source, 'default');
});

test('县级地名「咸丰县 / 咸丰」本地命中，坐标落在县城而不是恩施市', () => {
  for (const kw of ['咸丰县', '咸丰']) {
    const rows = lookupLocalPlaces(kw);
    assert.ok(rows.length, `「${kw}」应该搜得到`);
    const hit = rows.find((r) => r.name === '咸丰县');
    assert.ok(hit, `「${kw}」应命中咸丰县`);
    assert.ok(Math.abs(hit.lat - 29.6779) < 0.001, '纬度应为咸丰县城');
    assert.ok(Math.abs(hit.lon - 109.1398) < 0.001, '经度应为咸丰县城');
    assert.match(hit.fullName, /恩施土家族苗族自治州/);
    assert.equal(hit.district, '咸丰县');
    assert.equal(hit.source, 'manual');
  }
  // 不能因为都在恩施州就把「恩施」误解析成咸丰县
  const es = lookupLocalPlaces('恩施');
  assert.ok(es.some((r) => r.name === '恩施市'));
  assert.ok(!es.some((r) => r.name === '咸丰县'));
  assert.deepEqual(lookupLocalPlaces(''), []);
  assert.deepEqual(lookupLocalPlaces('  '), []);
});

test('位置行主名称精确到区县，副行保留完整行政路径', () => {
  const geoXianfeng = {
    name: '咸丰县', district: '咸丰县', province: '湖北省',
    prefecture: '恩施土家族苗族自治州',
    fullName: '湖北省 · 恩施土家族苗族自治州 · 咸丰县', source: 'geo',
  };
  assert.deepEqual(placeNames(geoXianfeng), {
    short: '咸丰县', full: '湖北省 · 恩施土家族苗族自治州 · 咸丰县',
  });
  assert.deepEqual(placeNames(DEFAULT_PLACE), { short: '武汉', full: '湖北 · 武汉' });
  assert.equal(placeNames(null).short, '当前位置');
  assert.equal(placeNames({ name: '西湖区', province: '浙江省', prefecture: '杭州市' }).short, '西湖区');
});

test('今日指标从实况与当天预报取值，缺字段不抛错', () => {
  const m = todayMetrics(makeRaw());
  assert.equal(m.temp, 13.4);
  assert.equal(m.feel, 12.1);
  assert.equal(m.humidity, 62);
  assert.equal(m.wind, 7.5);
  assert.equal(m.rainProb, 20);
  assert.equal(m.uv, 3);
  assert.equal(m.sunrise, '06:52');
  assert.equal(m.sunset, '17:38');
  assert.equal(m.hi, 15);
  assert.equal(m.lo, 9);
  const empty = todayMetrics({ current: {}, daily: {} });
  assert.equal(empty.humidity, null);
  assert.equal(empty.uv, null);
  assert.equal(empty.sunrise, '');
  assert.equal(todayMetrics(null).temp, null);
});

test('今天的逐时从当前小时起，第一格是「现在」，之后每 3 小时一格', () => {
  const raw = makeRaw();
  const now = new Date(2026, 10, 12, 9, 34);
  const rows = hoursForDate(raw, '2026-11-12', { now });
  assert.ok(rows.length > 1);
  assert.equal(rows[0].hour, 9);
  assert.equal(rows[0].isNow, true);
  assert.equal(rows[0].code, 3);
  assert.ok(rows.every((r) => r.hour >= 9), '不能显示已经过去的小时');
  assert.ok(rows.every((r) => r.temp != null), '每格都要有温度');
  assert.equal(rows[1].hour - rows[0].hour, 3);
  assert.equal(rows.at(-1).hour, 21);
});

test('非今天的逐时从 0 点起，全天覆盖且不标「现在」', () => {
  const rows = hoursForDate(makeRaw(), '2026-11-13', { now: new Date(2026, 10, 12, 9, 34) });
  assert.equal(rows[0].hour, 0);
  assert.equal(rows[0].isNow, false);
  assert.equal(rows.at(-1).hour, 21);
  assert.equal(rows.length, 8);
  assert.ok(rows.every((r) => r.date === undefined || r.hour >= 0));
});

test('一周 7 行，标签与数值对齐，空数据返回空数组', () => {
  const rows = weekRows(makeRaw());
  assert.equal(rows.length, 7);
  assert.equal(rows[0].label, '今天');
  assert.equal(rows[1].label, '明天');
  assert.match(rows[2].label, /^周[一二三四五六日]$/);
  assert.equal(rows[0].date, '2026-11-12');
  assert.equal(rows[0].hi, 15);
  assert.equal(rows[0].lo, 9);
  assert.equal(rows[0].pop, 20);
  assert.equal(rows[0].sunrise, '06:52');
  assert.equal(rows[6].code, 71);
  assert.deepEqual(weekRows(null), []);
  assert.deepEqual(weekRows({ daily: { time: [] } }), []);
});

test('首页接线：卡片当天详情、一周抽屉、自动定位与默认武汉都落地', async () => {
  const [home, ui, sw, css, weatherModule] = await Promise.all([
    readFile(new URL('../js/home.js', import.meta.url), 'utf8'),
    readFile(new URL('../js/ui.js', import.meta.url), 'utf8'),
    readFile(new URL('../sw.js', import.meta.url), 'utf8'),
    readFile(new URL('../css/app.css', import.meta.url), 'utf8'),
    readFile(new URL('../js/weather-view.mjs', import.meta.url), 'utf8'),
  ]);
  // 新模块被引用并登记进 SW 缓存清单
  assert.match(home, /from '\.\/weather-view\.mjs'/);
  assert.match(ui, /from '\.\/weather-view\.mjs'/);
  assert.match(sw, /'\.\/js\/weather-view\.mjs'/);
  /* 每次发布都会 bump 缓存版本，这里只校验命名格式，不写死具体版本。 */
  assert.match(sw, /const CACHE = 'wb-v\d+-[^']+'/);
  // 默认城市不再是北京
  assert.match(ui, /\{\s*\.\.\.DEFAULT_PLACE\s*\}/);
  assert.doesNotMatch(home, /name: '北京', lat: 39\.9042/);
  // 卡片：当天详情；抽屉：一周 + 点某天
  assert.match(home, /function wxTodayDetailHTML\(/);
  assert.match(home, /今天 · 逐时/);
  assert.match(home, /class="wx-metrics wxb-metrics"/);
  assert.match(home, /function wxWeekHTML\(/);
  assert.match(home, /data-wxday=/);
  assert.match(home, /最近一周天气/);
  assert.match(css, /\.wxd-row \{/);
  // 县级地名库 + 每次进首页都尝试定位
  assert.match(home, /lookupLocalPlaces\(kw2\)/);
  assert.match(home, /manualLockSession/);
  assert.doesNotMatch(home, /if \(state\.geoMode === 'auto'\) \{\s*\n\s*locate/);
  assert.match(weatherModule, /咸丰县/);
  // 最近 5 次手动记录仍是原逻辑
  assert.match(home, /const RECENT_MAX = 5/);
});
