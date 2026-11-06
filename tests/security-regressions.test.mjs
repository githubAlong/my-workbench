import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { installBrowser } from './test-browser.mjs';
import {
  ENVIRONMENT_PROFILES,
  resolveEnvironmentProfile,
} from '../js/environment-config.mjs';

test('fixed environment and startup safety regressions', async (t) => {
  await t.test('hostname chooses fixed prod/test Supabase projects', () => {
    assert.equal(resolveEnvironmentProfile('https://githubalong.github.io/my-workbench/').name, 'production');
    assert.equal(resolveEnvironmentProfile('https://my-workbench-test.pages.dev/').name, 'test');
    assert.equal(resolveEnvironmentProfile('https://abc123.my-workbench-test.pages.dev/').name, 'test');
    assert.equal(resolveEnvironmentProfile('http://192.168.1.20:8080/').name, 'test');
    assert.throws(() => resolveEnvironmentProfile('https://unknown.example/'), /未配置/);
    assert.match(ENVIRONMENT_PROFILES.test.supabaseUrl, /xgvmwbzvvjnhzadfvdmj/);
    assert.match(ENVIRONMENT_PROFILES.production.supabaseUrl, /gfgxvpvexzcfbujkwsqw/);
  });

  await t.test('URL and localStorage cannot redirect test auth requests', async () => {
    const storage = installBrowser({
      href: 'https://preview.my-workbench-test.pages.dev/?supa=https://gfgxvpvexzcfbujkwsqw.supabase.co',
      cfg: { url: 'https://attacker.example', anon: ENVIRONMENT_PROFILES.production.publishableKey },
    });
    const cloud = await import('../js/cloud.js?security=test-profile');
    const resolved = cloud.cfg();
    assert.equal(new URL(resolved.url).origin, new URL(ENVIRONMENT_PROFILES.test.supabaseUrl).origin);
    assert.equal(resolved.anon, ENVIRONMENT_PROFILES.test.publishableKey);
    assert.equal(JSON.parse(storage.getItem('wb_supa_cfg')).url, ENVIRONMENT_PROFILES.test.supabaseUrl);
  });

  await t.test('test build cannot save production or third-party config', async () => {
    installBrowser({ href: 'https://preview.my-workbench-test.pages.dev/' });
    const cloud = await import('../js/cloud.js?security=save-test');
    assert.throws(
      () => cloud.saveCfg(ENVIRONMENT_PROFILES.production.supabaseUrl, ENVIRONMENT_PROFILES.production.publishableKey),
      /只能连接当前/,
    );
    assert.throws(
      () => cloud.saveCfg('https://attacker.example', ENVIRONMENT_PROFILES.test.publishableKey),
      /只能连接当前/,
    );
  });

  await t.test('Realtime reuses the same verified environment config', async () => {
    installBrowser({ href: 'https://preview.my-workbench-test.pages.dev/' });
    const realtime = await import('../js/realtime.js?security=realtime-test');
    const resolved = realtime.realtimeConfig();
    assert.equal(new URL(resolved.url).origin, new URL(ENVIRONMENT_PROFILES.test.supabaseUrl).origin);
  });

  await t.test('retired reset URL only cleans the address bar', async () => {
    const storage = installBrowser({ href: 'https://githubalong.github.io/my-workbench/' });
    storage.setItem('wb_static_db_v1:user:test-user', JSON.stringify({ items: [{ id: 1 }] }));
    storage.setItem('wb_account_revision:test-user', '7');
    const before = new Map(storage.data);
    const { takeRetiredResetParam } = await import('../js/startup-safety.mjs?security=startup');
    const result = takeRetiredResetParam(
      'https://githubalong.github.io/my-workbench/?keep=1&reset-dev-data=1#/work/attendance',
    );
    assert.equal(result.requested, true);
    assert.equal(result.next, '/my-workbench/?keep=1#/work/attendance');
    assert.deepEqual(storage.data, before);
  });

  await t.test('startup has no automatic local wipe or empty snapshot upload', async () => {
    const source = await readFile(new URL('../js/main.js', import.meta.url), 'utf8');
    assert.match(source, /takeRetiredResetParam/);
    assert.doesNotMatch(source, /resetDevData/);
    assert.doesNotMatch(source, /replaceAll\s*\(/);
    assert.doesNotMatch(source, /pushNow\s*\(/);
  });
});
