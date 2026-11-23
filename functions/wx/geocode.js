/* 地名库代理（Cloudflare Pages Function，路径 /wx/geocode）。
   背景同 /wx/forecast：部分网络下浏览器直连 geocoding-api.open-meteo.com 会被重置
   （net::ERR_EMPTY_RESPONSE），城市搜索查不到任何结果。改由 Pages 边缘节点代取，
   前端只发同源/代理请求，既绕开直连拦截也不依赖第三方 CORS。
   只转发白名单参数，不做开放代理。 */
const UPSTREAM = 'https://geocoding-api.open-meteo.com/v1/search';
const ALLOWED = new Set(['name', 'count', 'language', 'format']);

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

export async function onRequestGet({ request }) {
  const src = new URL(request.url);
  const name = (src.searchParams.get('name') || '').trim();
  if (!name) return json({ error: '缺少地名' }, 400);
  const target = new URL(UPSTREAM);
  for (const [key, value] of src.searchParams) {
    if (ALLOWED.has(key)) target.searchParams.set(key, value);
  }
  target.searchParams.set('name', name);
  let upstream;
  try {
    upstream = await fetch(target.toString(), { signal: AbortSignal.timeout(8000) });
  } catch {
    return json({ error: '地名服务连接失败' }, 504);
  }
  if (!upstream.ok) return json({ error: '地名服务返回 ' + upstream.status }, 502);
  /* 原样透传上游 JSON：前端解析逻辑不用改，换代理只换了取数通道。
     地名很少变，边缘缓存一天，减轻重复搜索的出网压力。 */
  return new Response(await upstream.text(), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=86400',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
