/* Fixed deployment profiles. The Supabase target is selected only from the
   current hostname; URL query parameters and localStorage cannot override it. */
export const ENVIRONMENT_PROFILES = Object.freeze({
  production: Object.freeze({
    name: 'production',
    supabaseUrl: 'https://placate-synapse-stylist.ngrok-free.dev',
    publishableKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzYzMDAwMDAwLCJleHAiOjIwNzAwMDAwMDB9.QYMaK-40p1luJ3Dc83JchGAH3h02dLSAIxk_ppGEJHA',
    /* 线上也不再自动灌示例数据：账号里已经有真实数据，
       示例批次被清掉后要是又被灌回来，用户会以为删除没生效。 */
    autoSeedDemo: false,
    hosts: Object.freeze(['githubalong.github.io']),
    hostSuffixes: Object.freeze([]),
  }),
  test: Object.freeze({
    name: 'test',
    supabaseUrl: 'https://placate-synapse-stylist.ngrok-free.dev',
    publishableKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzYzMDAwMDAwLCJleHAiOjIwNzAwMDAwMDB9.QYMaK-40p1luJ3Dc83JchGAH3h02dLSAIxk_ppGEJHA',
    autoSeedDemo: false,
    hosts: Object.freeze(['localhost', '127.0.0.1', 'my-workbench-test.pages.dev']),
    hostSuffixes: Object.freeze(['.my-workbench-test.pages.dev']),
  }),
});

function isPrivateIpv4(hostname) {
  return /^(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})$/.test(hostname);
}

export function resolveEnvironmentProfile(input = globalThis.location) {
  let hostname = '';
  try {
    hostname = String(input?.hostname || new URL(String(input || '')).hostname).toLowerCase();
  } catch {
    hostname = '';
  }
  for (const profile of Object.values(ENVIRONMENT_PROFILES)) {
    if (profile.hosts.includes(hostname)) return profile;
    if (profile.hostSuffixes.some((suffix) => hostname.endsWith(suffix))) return profile;
  }
  if (isPrivateIpv4(hostname)) return ENVIRONMENT_PROFILES.test;
  throw new Error(`未配置当前访问环境：${hostname || 'unknown host'}`);
}

/* ngrok 免费版会拦截「浏览器 UA」的请求，返回一张 HTML 警告页（text/html 且没有 CORS 头），
   浏览器里改不了 UA，只能带这个头跳过，否则页面所有云端 GET 都会以 CORS 失败告终。
   参考 ngrok 文档 ERR_NGROK_6024。 */
export const NGROK_SKIP_HEADER = 'ngrok-skip-browser-warning';
const NGROK_HOST_PATTERN = /\.ngrok-free\.(?:dev|app)\//;

if (typeof window !== 'undefined' && typeof window.fetch === 'function' && !window.__wbNgrokFetchPatched) {
  window.__wbNgrokFetchPatched = true;
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : String(input?.url || '');
    if (!NGROK_HOST_PATTERN.test(url)) return nativeFetch(input, init);
    const request = new Request(input, init);
    if (!request.headers.has(NGROK_SKIP_HEADER)) request.headers.set(NGROK_SKIP_HEADER, '1');
    return nativeFetch(request);
  };
}

export function assertTrustedSupabaseConfig(profile, url, publishableKey) {
  let parsed;
  try {
    parsed = new URL(String(url || ''));
  } catch {
    return null;
  }
  const expected = new URL(profile.supabaseUrl);
  if (parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || parsed.origin !== expected.origin
    || parsed.pathname !== '/'
    || parsed.search
    || parsed.hash
    || String(publishableKey || '') !== profile.publishableKey) {
    return null;
  }
  return { url: expected.origin, anon: profile.publishableKey, environment: profile.name };
}
