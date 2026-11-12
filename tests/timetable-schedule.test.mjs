import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTUMN_2026_SCHEDULE, buildDefinitions, buildPeriodTimes,
  resolveDefinitions, withScheduleDefinitions, withScheduleTimes,
  matchScheduleRow, normalizeClock,
} from '../js/timetable-schedule.mjs';

/* 老师提供的《2026年秋季信息课表》时间列，逐行权威值 */
const PAPER = [
  ['第1节', '08:00', '08:40'], ['第2节', '08:50', '09:30'],
  ['第3节', '10:00', '10:40'], ['第4节', '10:50', '11:30'],
  ['第5节', '11:40', '12:20'], ['午休', '12:20', '14:10'],
  ['第6节', '14:10', '14:50'], ['第7节', '15:20', '16:00'],
  ['第8节', '16:15', '16:55'], ['第9节', '17:05', '17:45'],
  ['晚一', '18:25', '18:40'], ['晚二', '19:30', '20:10'],
  ['晚三', '20:20', '21:00'], ['晚四', '21:10', '21:55'],
];

test('模板逐行与纸面一致，不多不少 14 行', () => {
  assert.equal(AUTUMN_2026_SCHEDULE.length, 14);
  assert.deepEqual(
    AUTUMN_2026_SCHEDULE.map((r) => [r.name, r.start_time, r.end_time]),
    PAPER,
  );
  // 不自动补早自习，不丢晚二/晚三/晚四
  assert.equal(AUTUMN_2026_SCHEDULE.some((r) => /早自习|早读/.test(r.name)), false);
  assert.deepEqual(
    AUTUMN_2026_SCHEDULE.filter((r) => r.period_no >= 10).map((r) => r.period_no),
    [10, 11, 12, 13],
  );
});

test('buildDefinitions 保留行序与编号，不按时间反推', () => {
  const defs = buildDefinitions(AUTUMN_2026_SCHEDULE);
  assert.equal(defs.length, 14);
  assert.equal(defs[5].period_no, 5.5);
  assert.equal(defs[13].period_no, 13);
  assert.deepEqual(defs.map((d) => d.order), [...Array(14).keys()]);
  // 改了名称/时间，编号依然跟着行走
  const edited = AUTUMN_2026_SCHEDULE.map((r, i) => i === 0 ? { ...r, name: '第一节', start_time: '8:00', end_time: '8:40' } : r);
  const defs2 = buildDefinitions(edited);
  assert.equal(defs2[0].period_no, 1);
  assert.equal(defs2[0].start_time, '08:00');
});

test('buildDefinitions 拦住脏数据', () => {
  const bad = (patch, msg) => {
    const rows = AUTUMN_2026_SCHEDULE.map((r) => ({ ...r }));
    Object.assign(rows[0], patch);
    assert.throws(() => buildDefinitions(rows), new RegExp(msg));
  };
  bad({ name: '' }, '节次名称');
  bad({ start_time: 'abc' }, '时间格式');
  bad({ end_time: '07:00' }, '结束时间');
  bad({ period_no: 2 }, '重复');
  assert.throws(() => buildDefinitions([]), /不能为空/);
});

test('normalizeClock 兼容 8:00 / 中文冒号', () => {
  assert.equal(normalizeClock('8:00'), '08:00');
  assert.equal(normalizeClock('08：40'), '08:40');
  assert.equal(normalizeClock('25:00'), '');
  assert.equal(normalizeClock(''), '');
});

test('全校共用：不同年级解析到同一套定义', () => {
  const defs = buildDefinitions(AUTUMN_2026_SCHEDULE);
  const saved = withScheduleDefinitions({ '冬季作息|高二': [{ name: '旧' }], '夏季作息': [{ name: '夏' }] }, '冬季作息', defs);
  assert.deepEqual(saved['冬季作息'], defs);
  assert.equal(saved['冬季作息|高二'], undefined, '旧的按年级拆分的 key 必须清掉');
  assert.deepEqual(saved['夏季作息'], [{ name: '夏' }], '别的作息类型不受影响');
  for (const grade of ['高一', '高二', '高三', '全部']) {
    assert.equal(resolveDefinitions(saved, '冬季作息', grade), defs);
  }
  assert.equal(resolveDefinitions({}, '冬季作息', '高二'), null);
});

test('兼容历史 type|grade 数据', () => {
  const legacy = { '冬季作息|高二': [{ name: '旧高二' }] };
  assert.deepEqual(resolveDefinitions(legacy, '冬季作息', '高二'), [{ name: '旧高二' }]);
  assert.equal(resolveDefinitions(legacy, '冬季作息', '高一'), null);
});

test('periodTimes 全量覆盖，旧默认作息一条不留', () => {
  const defs = buildDefinitions(AUTUMN_2026_SCHEDULE);
  const old = { 冬季作息: { 1: { start_time: '07:40', end_time: '08:25' }, 99: { start_time: '00:01', end_time: '00:02' } } };
  const next = withScheduleTimes(old, '冬季作息', defs);
  assert.deepEqual(Object.keys(next.冬季作息).map(Number).sort((a, b) => a - b),
    [1, 2, 3, 4, 5, 5.5, 6, 7, 8, 9, 10, 11, 12, 13]);
  assert.equal(next.冬季作息[99], undefined);
  assert.deepEqual(next.冬季作息['1'], { start_time: '08:00', end_time: '08:40' });
  assert.deepEqual(buildPeriodTimes(defs)['13'], { start_time: '21:10', end_time: '21:55' });
});

test('matchScheduleRow 按名称/编号/时间命中本次作息', () => {
  const defs = buildDefinitions(AUTUMN_2026_SCHEDULE);
  assert.equal(matchScheduleRow(defs, '第1节').period_no, 1);
  assert.equal(matchScheduleRow(defs, '第9节').period_no, 9);
  assert.equal(matchScheduleRow(defs, '晚四').period_no, 13);
  assert.equal(matchScheduleRow(defs, '午休').period_no, 5.5);
  assert.equal(matchScheduleRow(defs, '9').period_no, 9);
  assert.equal(matchScheduleRow(defs, '自定义', '19:30', '20:10').period_no, 11);
  assert.equal(matchScheduleRow(defs, '不存在'), null);
});
