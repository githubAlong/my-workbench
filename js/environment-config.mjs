/* Fixed deployment profiles. The Supabase target is selected only from the
   current hostname; URL query parameters and localStorage cannot override it. */
export const ENVIRONMENT_PROFILES = Object.freeze({
  production: Object.freeze({
    name: 'production',
    supabaseUrl: 'https://adapted-heavy-output-thriller.trycloudflare.com',
    publishableKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzYzMDAwMDAwLCJleHAiOjIwNzAwMDAwMDB9.QYMaK-40p1luJ3Dc83JchGAH3h02dLSAIxk_ppGEJHA',
    hosts: Object.freeze(['githubalong.github.io', 'my-workbench-dev.pages.dev']),
    hostSuffixes: Object.freeze(['.my-workbench-dev.pages.dev']),
  }),
  test: Object.freeze({
    name: 'test',
    supabaseUrl: 'https://adapted-heavy-output-thriller.trycloudflare.com',
    publishableKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzYzMDAwMDAwLCJleHAiOjIwNzAwMDAwMDB9.QYMaK-40p1luJ3Dc83JchGAH3h02dLSAIxk_ppGEJHA',
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
