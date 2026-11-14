import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePlace } from '../js/weather-location.mjs';

const ok = body => new Response(JSON.stringify(body), { status: 200 });
const bad = () => new Response('{}', { status: 400 });

test('地区查询优先请求 Photon，不再先打 BigDataCloud', async () => {
  const calls = [];
  const fetcher = async url => {
    calls.push(url);
    return ok({ features: [{ properties: { state: '湖北省', district: '咸丰县', county: '咸丰县' } }] });
  };
  const place = await resolvePlace(29.61111, 109.12222, { fetcher, now: 1000 });
  assert.equal(calls.length, 1);
  assert.match(calls[0], /photon\.komoot\.io/);
  assert.equal(place.locationResolved, true);
  assert.equal(place.locationProvider, 'photon');
  assert.equal(place.name, '咸丰县');
  assert.equal(place.fullName, '湖北省 · 咸丰县', '村级地名不当地级市');
});

test('Photon 返回真正的地级市时保留地级市层级', async () => {
  const fetcher = async () => ok({ features: [{ properties: { state: '湖北省', city: '恩施土家族苗族自治州', county: '咸丰县' } }] });
  const place = await resolvePlace(29.64444, 109.15555, { fetcher, now: 1000 });
  assert.equal(place.fullName, '湖北省 · 恩施土家族苗族自治州 · 咸丰县');
});

test('Photon 被拒绝时回退 BigDataCloud', async () => {
  const calls = [];
  const fetcher = async url => {
    calls.push(url);
    if (url.includes('photon.komoot.io')) return bad();
    return ok({ principalSubdivision: '湖北省', city: '恩施土家族苗族自治州', locality: '咸丰县' });
  };
  const place = await resolvePlace(29.62222, 109.13333, { fetcher, now: 1000 });
  assert.equal(calls.length, 2);
  assert.equal(place.locationResolved, true);
  assert.equal(place.locationProvider, 'bigdatacloud');
  assert.equal(place.fullName, '湖北省 · 恩施土家族苗族自治州 · 咸丰县');
});

test('两个提供方都失败时标记未解析，并在一分钟内复用失败结果', async () => {
  let calls = 0;
  const fetcher = async () => { calls += 1; return bad(); };
  const first = await resolvePlace(29.63333, 109.14444, { fetcher, now: 1000 });
  assert.equal(first.locationResolved, false);
  assert.deepEqual(first.locationErrors, ['rejected']);
  await resolvePlace(29.63333, 109.14444, { fetcher, now: 2000 });
  assert.equal(calls, 2, '一分钟内命中失败缓存，不应重复请求');
});
