import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

class MemoryStorage {
  constructor() {
    this.data = new Map();
  }

  getItem(key) {
    return this.data.has(key) ? this.data.get(key) : null;
  }

  setItem(key, value) {
    this.data.set(String(key), String(value));
  }

  removeItem(key) {
    this.data.delete(key);
  }
}

function installBrowser({ href = "https://githubalong.github.io/my-workbench/", cfg = null } = {}) {
  const storage = new MemoryStorage();
  globalThis.location = new URL(href);
  globalThis.localStorage = storage;
  globalThis.window = {
    dispatchEvent() {},
    addEventListener() {},
    removeEventListener() {},
  };
  globalThis.document = {
    visibilityState: "visible",
    addEventListener() {},
    removeEventListener() {},
  };
  if (cfg) storage.setItem("wb_supa_cfg", JSON.stringify(cfg));
  return storage;
}

test("Supabase 配置只接受当前正式 HTTPS origin", async () => {
  const storage = installBrowser();
  const cloud = await import("../js/cloud.js?security=ast");
  const official = new URL(cloud.BUILTIN_URL);
  const valid = cloud.trustedSupabaseConfig(official.origin + "/", cloud.BUILTIN_ANON);
  assert.equal(valid?.url, official.origin);

  const invalid = [
    "https://attacker.example",
    `http://${official.host}`,
    "javascript:alert(1)",
    "data:text/plain,not-allowed",
    `https://user:password@${official.host}`,
    `${official.origin}/not-the-project-root`,
    `${official.origin}/?next=https://attacker.example`,
  ];
  for (const url of invalid) {
    assert.equal(cloud.trustedSupabaseConfig(url, cloud.BUILTIN_ANON), null, url);
  }

  assert.equal(storage.getItem("wb_supa_cfg"), null);
});

test("恶意 localStorage 配置会被清理并恢复正式项目", async () => {
  const cloud = await import("../js/cloud.js?security=storage");
  const official = new URL(cloud.BUILTIN_URL).origin;
  const storage = installBrowser({
    href: "https://githubalong.github.io/my-workbench/?supa=https://attacker.example",
    cfg: { url: "https://attacker.example", anon: cloud.BUILTIN_ANON },
  });

  const resolved = cloud.cfg();
  assert.equal(new URL(resolved.url).origin, official);
  assert.equal(new URL(JSON.parse(storage.getItem("wb_supa_cfg")).url).origin, official);
});

test("URL 参数不能覆盖后端地址", async () => {
  const cloud = await import("../js/cloud.js?security=query");
  const official = new URL(cloud.BUILTIN_URL).origin;
  installBrowser({
    href: "https://githubalong.github.io/my-workbench/?supa=https://attacker.example",
  });
  assert.equal(new URL(cloud.cfg().url).origin, official);
});

test("saveCfg 在生产环境拒绝非正式地址", async () => {
  const cloud = await import("../js/cloud.js?security=save");
  installBrowser();
  assert.throws(
    () => cloud.saveCfg("https://attacker.example", cloud.BUILTIN_ANON),
    /只能连接当前正式 Supabase 项目/,
  );
});

test("登录请求只发往正式项目地址", async () => {
  const cloud = await import("../js/cloud.js?security=login");
  const official = new URL(cloud.BUILTIN_URL).origin;
  installBrowser({
    href: "https://githubalong.github.io/my-workbench/?supa=https://attacker.example",
    cfg: { url: "https://attacker.example", anon: cloud.BUILTIN_ANON },
  });

  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          access_token: "test-access-token",
          refresh_token: "test-refresh-token",
          expires_in: 3600,
          user: { id: "test-user", phone: "+8613800000000" },
        };
      },
    };
  };
  try {
    await cloud.loginPhone("13800000000", "test-only-password");
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0]).origin, official);
});

test("注册请求只发往正式项目地址", async () => {
  const cloud = await import("../js/cloud.js?security=register");
  const official = new URL(cloud.BUILTIN_URL).origin;
  installBrowser({
    href: "https://githubalong.github.io/my-workbench/?supa=https://attacker.example",
  });

  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          access_token: "test-access-token",
          refresh_token: "test-refresh-token",
          expires_in: 3600,
          user: { id: "test-user", phone: "+8613800000000" },
        };
      },
    };
  };
  try {
    await cloud.signUpPhone("13800000000", "test-only-password");
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(calls.length, 1);
  const target = new URL(calls[0]);
  assert.equal(target.origin, official);
  assert.equal(target.pathname, "/auth/v1/signup");
});

test("Token 刷新和设备链接请求只发往正式项目地址", async () => {
  const cloud = await import("../js/cloud.js?security=refresh-cloud");
  const official = new URL(cloud.BUILTIN_URL).origin;
  const storage = installBrowser({
    href: "https://githubalong.github.io/my-workbench/?supa=https://attacker.example",
  });
  storage.setItem("wb_supa_tok", JSON.stringify({
    access_token: "test-old-access-token",
    refresh_token: "test-old-refresh-token",
    expires_at: 0,
    uid: "test-user",
  }));

  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    const value = new URL(String(url));
    calls.push(value);
    if (value.pathname.endsWith("/user/token_hash")) {
      return { ok: true, status: 200, async json() { return { token_hash: "test-token-hash" }; } };
    }
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          access_token: "test-new-access-token",
          refresh_token: "test-new-refresh-token",
          expires_in: 3600,
          user: { id: "test-user" },
        };
      },
    };
  };
  let link;
  try {
    const auth = await import("../js/auth.js?security=refresh-auth");
    link = await auth.makeDeviceLink();
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(calls.length, 2);
  assert.ok(calls.every((url) => url.origin === official));
  assert.equal(calls[0].pathname, "/auth/v1/token");
  assert.equal(calls[0].searchParams.get("grant_type"), "refresh_token");
  assert.equal(calls[1].pathname, "/auth/v1/user/token_hash");
  assert.equal(new URL(link).origin, "https://githubalong.github.io");
  assert.equal(new URL(link).searchParams.has("supa"), false);
});

test("旧布局读取使用当前用户 JWT 且不接受 key 或 UID 参数", async () => {
  const cloud = await import("../js/cloud.js?security=legacy-layout-read");
  const storage = installBrowser();
  storage.setItem("wb_supa_tok", JSON.stringify({
    access_token: "test-user-access-token",
    refresh_token: "test-user-refresh-token",
    expires_at: Date.now() + 3600_000,
    uid: "test-user",
  }));

  const originalFetch = globalThis.fetch;
  let captured = null;
  globalThis.fetch = async (url, options = {}) => {
    captured = { url: new URL(String(url)), options };
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify([{
          updated_at: "2026-11-06T02:00:00.000Z",
          payload: {
            version: 2,
            updatedAt: "2026-11-06T01:00:00.000Z",
            breakpoints: {
              desktop: { layout: [], hidden: [] },
              tablet: { layout: [], hidden: [] },
              mobile: { layout: [], hidden: [] },
            },
          },
        }]);
      },
    };
  };
  let result;
  try {
    result = await cloud.getLegacyHomeLayout();
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.ok(captured);
  assert.equal(captured.url.pathname, "/rest/v1/rpc/wb_get_home_layout");
  assert.match(captured.options.headers.Authorization, /^Bearer /);
  assert.equal(captured.options.body, "{}");
  assert.equal(captured.options.body.includes("key"), false);
  assert.equal(captured.options.body.includes("user_id"), false);
  assert.equal(result.updated_at, "2026-11-06T02:00:00.000Z");
});

test("Realtime 复用同一个安全配置解析器", async () => {
  const cloud = await import("../js/cloud.js?security=realtime-cloud");
  const official = new URL(cloud.BUILTIN_URL).origin;
  installBrowser({
    href: "https://githubalong.github.io/my-workbench/?supa=https://attacker.example",
    cfg: { url: "https://attacker.example", anon: cloud.BUILTIN_ANON },
  });
  const realtime = await import("../js/realtime.js?security=realtime");
  assert.equal(new URL(realtime.realtimeConfig().url).origin, official);
});

test("旧手动同步入口已关闭且正常业务不再直接调用旧 RPC", async () => {
  const [cloudsync, homegrid] = await Promise.all([
    readFile(new URL("../js/cloudsync.js", import.meta.url), "utf8"),
    readFile(new URL("../js/homegrid.js", import.meta.url), "utf8"),
  ]);
  assert.match(cloudsync, /旧版手动云同步已停用/);
  assert.doesNotMatch(cloudsync, /\/rest\/v1\/rpc\/wb_(get|put)/);
  assert.doesNotMatch(homegrid, /['"]wb_(get|put)['"]/);
});

test("旧维护 URL 参数只从地址栏移除，不触碰用户数据", async () => {
  const { takeRetiredResetParam } = await import("../js/startup-safety.mjs?security=startup");
  for (const loggedIn of [false, true]) {
    const storage = installBrowser();
    storage.setItem("wb_static_db_v1:user:test-user", JSON.stringify({ items: [{ id: 1 }] }));
    storage.setItem("wb_account_revision:test-user", "7");
    storage.setItem("wb_cloud_meta:test-user", JSON.stringify({ lastPush: "keep-me" }));
    const before = new Map(storage.data);
    const result = takeRetiredResetParam(
      "https://githubalong.github.io/my-workbench/?keep=1&reset-dev-data=1#/work/attendance",
    );
    assert.equal(result.requested, true);
    assert.equal(result.next, "/my-workbench/?keep=1#/work/attendance");
    assert.deepEqual(storage.data, before, `loggedIn=${loggedIn}`);
  }
});

test("启动模块不再包含自动清库和空快照上传路径", async () => {
  const source = await readFile(new URL("../js/main.js", import.meta.url), "utf8");
  assert.match(source, /takeRetiredResetParam/);
  assert.doesNotMatch(source, /resetDevData/);
  assert.doesNotMatch(source, /replaceAll\s*\(/);
  assert.doesNotMatch(source, /pushNow\s*\(/);
});

test("首页布局保存在账号独立的本机快照中", async () => {
  installBrowser();
  const localdb = await import("../js/localdb.js?security=isolation");
  const layoutA = {
    version: 2,
    updatedAt: "2026-11-06T00:00:00.000Z",
    breakpoints: { desktop: { layout: [{ id: "profile", x: 0, y: 0, w: 5, h: 2 }], hidden: [] } },
  };
  const layoutB = {
    version: 2,
    updatedAt: "2026-11-06T00:01:00.000Z",
    breakpoints: { desktop: { layout: [{ id: "calendar", x: 0, y: 0, w: 5, h: 5 }], hidden: [] } },
  };

  localdb.setActiveAccount("account-a");
  const dbA = localdb.load();
  dbA.meta.user = { settings: { homeLayout: layoutA } };
  localdb.save();

  localdb.setActiveAccount("account-b");
  const dbB = localdb.load();
  assert.equal(dbB.meta.user?.settings?.homeLayout, undefined);
  dbB.meta.user = { settings: { homeLayout: layoutB } };
  localdb.save();

  const rawB = JSON.parse(localStorage.getItem("wb_static_db_v1:user:account-b"));
  assert.deepEqual(rawB.meta.user.settings.homeLayout, layoutB);

  localdb.setActiveAccount("account-a");
  assert.deepEqual(localdb.load().meta.user.settings.homeLayout, layoutA);
});
