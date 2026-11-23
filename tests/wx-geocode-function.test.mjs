import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/* Cloudflare Pages Function 是 ESM，Node 24 能直接 import。
   用 mock 的 fetch 验它转发/缓存/错误，而不是只 grep 源码。 */
const { onRequestGet } = await import('../functions/wx/geocode.js');

const req = (qs) => ({ request: new Request('https://my-workbench-test.pages.dev/wx/geocode' + qs) });

const withUpstream = async (impl, fn) => {
  const real = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => { seen.push({ url, init }); return impl(url, init); };
  try { return { out: await fn(), seen }; } finally { globalThis.fetch = real; }
};

test('缺 name 直接 400，不出网', async () => {
  const { out, seen } = await withUpstream(() => new Response('{}'), () => onRequestGet(req('?count=20')));
  assert.equal(out.status, 400);
  assert.equal(seen.length, 0, '没地名不该打上游');
});

test('透传白名单参数并原样回上游 JSON，带上跨域头', async () => {
  const body = JSON.stringify({ results: [{ name: '成都市', latitude: 30.57, longitude: 104.06 }] });
  const { out, seen } = await withUpstream(
    () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }),
    () => onRequestGet(req('?name=%E6%88%90%E9%83%BD&count=20&language=zh&format=json')),
  );
  assert.equal(out.headers.get('Content-Type'), 'application/json; charset=utf-8');
  assert.equal(out.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal(JSON.parse(await out.text()).results[0].name, '成都市');
  const u = new URL(seen[0].url);
  assert.equal(u.hostname, 'geocoding-api.open-meteo.com', '上游锁死在地名库，不做开放代理');
  assert.equal(u.pathname, '/v1/search');
  assert.equal(u.searchParams.get('name'), '成都');
  assert.equal(u.searchParams.get('count'), '20');
  assert.match(seen[0].init.signal ? 'has-signal' : '', /has-signal/, '带上超时 signal');
});

test('白名单之外的参数不转给上游', async () => {
  const { seen } = await withUpstream(
    () => new Response('{"results":[]}', { status: 200 }),
    () => onRequestGet(req('?name=x&evil=1&latitude=999')),
  );
  const u = new URL(seen[0].url);
  assert.equal(u.searchParams.get('evil'), null);
  assert.equal(u.searchParams.get('latitude'), null);
  assert.equal(u.searchParams.get('name'), 'x');
});

test('上游非 2xx 报 502，连不上报 504', async () => {
  const bad = await withUpstream(() => new Response('nope', { status: 429 }), () => onRequestGet(req('?name=县')));
  assert.equal(bad.out.status, 502);
  const down = await withUpstream(() => { throw new Error('reset'); }, () => onRequestGet(req('?name=县')));
  assert.equal(down.out.status, 504);
});

/* 前端接线：home.js 的城市搜索要代理优先、直连兜底，且仍认 results 数组。 */
test('home.js geocodeCity 走代理优先并保留直连兜底', async () => {
  const home = await readFile(new URL('../js/home.js', import.meta.url), 'utf8');
  assert.match(home, /my-workbench-test\.pages\.dev\/wx\/geocode/, '代理地址');
  assert.match(home, /location\.origin}\/wx\/geocode/, 'pages.dev 同源分支');
  assert.match(home, /geocoding-api\.open-meteo\.com\/v1\/search\?\$\{qs\(/, '直连兜底仍在');
  assert.match(home, /Array\.isArray\(data\?\.results\)\) return data\.results/, '只有真数组才算命中');
});
