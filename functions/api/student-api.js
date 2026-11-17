/* Cloudflare Pages Functions — 学生端 API 代理（同源）。
   前端调 /api/student-api?path=/public/link/xxx，这个函数转发到自建 Supabase 的 student-api Edge Function。
   好处：避开 ngrok 免费版的警告页拦截（跨域浏览器 UA 会被 302 到 HTML 警告页），
   改成 Cloudflare 边缘节点发请求 → 学生端只走同源。 */
const UPSTREAM = 'https://placate-synapse-stylist.ngrok-free.dev/functions/v1/student-api';
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type, ngrok-skip-browser-warning', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };

async function handle({ request }) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const url = new URL(request.url);
  const path = url.searchParams.get('path') || '/';
  const upstream = new URL(UPSTREAM);
  upstream.searchParams.set('path', path);
  /* 透传原始方法、body、ngrok-skip-browser-warning 头 */
  const init = { method: request.method, headers: { 'ngrok-skip-browser-warning': '1', 'Content-Type': request.headers.get('content-type') || 'application/json' } };
  if (request.method === 'POST') init.body = await request.text();
  let resp;
  try { resp = await fetch(upstream.toString(), { ...init, signal: AbortSignal.timeout(15000) }); }
  catch (e) { return new Response(JSON.stringify({ error: '后端暂时不可用' }), { status: 502, headers: { 'Content-Type': 'application/json', ...CORS } }); }
  const outHeaders = { ...CORS };
  resp.headers.forEach((v, k) => { if (k !== 'access-control-allow-origin') outHeaders[k] = v; });
  return new Response(resp.body, { status: resp.status, headers: outHeaders });
}

export function onRequest({ request }) { return handle({ request }); }
export const config = { path: '/api/student-api' };
