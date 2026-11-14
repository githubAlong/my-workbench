import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePlace, parsePlace, locationWarning } from '../js/weather-location.mjs';

const ok = data => ({ ok: true, json: async () => data });
const primary = { principalSubdivision: '浙江省', city: '杭州市', locality: '西湖区' };
const backup = { features: [{ properties: { state: '浙江省', city: '杭州市', district: '西湖区', name: '某商店' } }] };

test('primary names preserve real administrative levels and deduplicate municipalities', () => {
  assert.equal(parsePlace(primary, 'bigdatacloud').fullName, '浙江省 · 杭州市 · 西湖区');
  assert.equal(parsePlace({ principalSubdivision: '上海市', city: '上海市', locality: '黄浦区' }, 'bigdatacloud').fullName, '上海市 · 黄浦区');
  assert.equal(parsePlace({ localityInfo: { administrative: [{ name: '中国', adminLevel: 2 }] } }, 'bigdatacloud'), null);
});

test('successful primary query skips the fallback and supplies a bounded request', async () => {
  let calls = 0;
  const result = await resolvePlace(30, 120, { fetcher: async (url, options) => {
    calls++;
    assert.match(url, /photon\.komoot\.io/);
    assert.ok(options.signal);
    assert.equal(options.credentials, 'omit');
    return ok(backup);
  } });
  assert.equal(calls, 1);
  assert.equal(result.locationResolved, true);
  assert.equal(result.locationProvider, 'photon');
  assert.doesNotMatch(result.fullName, /商店/);
});

test('Photon 不把村级地名当地级市', () => {
  const place = parsePlace({ features: [{ properties: { state: '湖北省', city: '垭口田', county: '咸丰县' } }] }, 'photon');
  assert.equal(place.fullName, '湖北省 · 咸丰县');
});

test('HTTP 400 rejection from Photon falls back to BigDataCloud', async () => {
  const urls = [];
  const result = await resolvePlace(30.01, 120, { fetcher: async url => {
    urls.push(url);
    return urls.length === 1 ? { ok: false, status: 400 } : ok(primary);
  } });
  assert.equal(urls.length, 2);
  assert.match(urls[1], /bigdatacloud/);
  assert.equal(result.locationProvider, 'bigdatacloud');
  assert.equal(result.fullName, '浙江省 · 杭州市 · 西湖区');
});

test('primary timeout still permits a successful fallback', async () => {
  let calls = 0;
  const result = await resolvePlace(30.02, 120, { fetcher: async () => {
    if (++calls === 1) throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    return ok(primary);
  } });
  assert.equal(result.locationProvider, 'bigdatacloud');
});

test('empty primary response and broken JSON both trigger fallback', async () => {
  for (const [i, response] of [ok({}), { ok: true, json: async () => { throw new SyntaxError(); } }].entries()) {
    let calls = 0;
    assert.equal((await resolvePlace(31 + i, 120, { fetcher: async () => ++calls === 1 ? response : ok(primary) })).locationResolved, true);
  }
});

test('two failed providers return usable coordinate mode and specific failure reasons', async () => {
  let calls = 0;
  const result = await resolvePlace(30.03, 120, { fetcher: async () => {
    if (++calls === 1) return { ok: false, status: 403 };
    throw Object.assign(new Error(), { name: 'TimeoutError' });
  } });
  assert.equal(result.name, '当前位置');
  assert.equal(result.locationResolved, false);
  assert.deepEqual(result.locationErrors, ['rejected', 'timeout']);
  assert.match(locationWarning(result), /拒绝访问.*超时.*定位坐标.*手动选择/);
});

test('matching saved coordinates reuse a recent place without a request', async () => {
  const previous = { ...parsePlace(primary, 'bigdatacloud'), lat: 30.04, lon: 120, locationResolvedAt: 100000 };
  const result = await resolvePlace(30.04, 120, { previous, now: 110000, fetcher: () => { throw new Error('must not request'); } });
  assert.equal(result.fullName, previous.fullName);
  assert.equal(result.locationCached, true);
});

test('moving to a different location or using stale saved names requires a new lookup', async () => {
  const previous = { ...parsePlace(primary, 'bigdatacloud'), lat: 30.05, lon: 120, locationResolvedAt: 100000 };
  let calls = 0;
  for (const lat of [30.06, 30.05]) {
    await resolvePlace(lat, 120, { previous, now: 100000 + 86400001, fetcher: async () => { calls++; return ok(backup); } });
  }
  assert.equal(calls, 2);
});

test('concurrent lookups are shared and failed lookups have a short retry cooldown', async () => {
  let calls = 0;
  const options = { now: 100000, fetcher: async () => { calls++; return { ok: false, status: 503 }; } };
  await Promise.all([resolvePlace(30.07, 120, options), resolvePlace(30.07, 120, options)]);
  assert.equal(calls, 2);
  await resolvePlace(30.07, 120, options);
  assert.equal(calls, 2);
  await resolvePlace(30.07, 120, { ...options, now: 160001 });
  assert.equal(calls, 4);
});

test('invalid coordinates never reach either provider', async () => {
  for (const lat of [null, NaN, 91, Infinity]) {
    await assert.rejects(resolvePlace(lat, 120, { fetcher: () => assert.fail('no network') }), /坐标无效/);
  }
});
