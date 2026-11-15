/* 天气代理（Cloudflare Pages Function，路径 /wx/forecast）。
   背景：部分网络下浏览器直连 api.open-meteo.com 会被重置
   （控制台 net::ERR_CONNECTION_RESET），而同一条网络里 curl 却正常，
   说明是本机浏览器这条路被拦。改由 Pages 边缘节点代取，前端只发同源请求，
   既不依赖第三方 CORS，也不会被直连拦截影响。
   只转发白名单参数，不做开放代理。 */
const UPSTREAM = 'https://api.open-meteo.com/v1/forecast';
const ALLOWED = new Set([
  'latitude', 'longitude', 'current', 'hourly', 'daily', 'timezone', 'forecast_days',
]);

function json(body, status = 200, maxAge = 0) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': maxAge ? `public, max-age=${maxAge}` : 'no-store',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

export async function onRequestGet({ request }) {
  const src = new URL(request.url);
  const lat = Number(src.searchParams.get('latitude'));
  const lon = Number(src.searchParams.get('longitude'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)
    || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return json({ error: '坐标无效' }, 400);
  }
  const target = new URL(UPSTREAM);
  for (const [key, value] of src.searchParams) {
    if (ALLOWED.has(key)) target.searchParams.set(key, value);
  }
  target.searchParams.set('latitude', String(lat));
  target.searchParams.set('longitude', String(lon));
  let upstream;
  try {
    upstream = await fetch(target.toString(), { signal: AbortSignal.timeout(8000) });
  } catch {
    return json({ error: '天气服务连接失败' }, 504);
  }
  if (!upstream.ok) return json({ error: '天气服务返回 ' + upstream.status }, 502);
  /* 原样透传上游 JSON：前端解析逻辑不用改，换代理只换了取数通道。 */
  return new Response(await upstream.text(), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
