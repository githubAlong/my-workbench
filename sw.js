/* 我的工作台 Service Worker
   作用只有两个：可添加到主屏幕、断网时能打开。

   === 为什么策略是「网络优先」 ===
   踩过坑：缓存优先的写法改完代码用户还看旧版，而且刷新几次都不变，
   只能手动清缓存，比不能离线更糟。所以任何能连上网络的时候都以网络为准，
   缓存只用于断网兜底。

   === 【2026-10 白屏事故复盘，别再犯】 ===
   现象：同一台电脑，Chrome 正常、另一个浏览器整个页面空白（书签栏还在，
        页面内容一片灰），刷新有时好有时坏。
   原因：这份清单是从上一代项目「班级资料站」抄过来的，里面列着
        student.html、student.bundle.js、app.js 这三个文件 ——
        它们在本仓库里确实还留着（旧项目的残骸），但「我的工作台」
        根本不用它们。本项目真正要缓存的是 index.html + js/main.js + js/*.js。
        于是 install 阶段这几个请求要么 404、要么去拉那个 674KB 的旧 app.js
        在 GitHub Pages 上卡几十秒。install 超时被浏览器丢掉，
        而 fetch 又是「网络优先、失败回退缓存」：
        网络一抖，navigate 请求就退到一份半截的 index.html 上 —— 白屏。
        不同浏览器对 install 超时的容忍度不同，所以「换个浏览器就好了 / 就坏了」。
   修法：
     1) 清单只列本项目真实存在的文件，并且用脚本核对过全部 200。
     2) 导航请求（打开页面本身）单独处理：网络最多等 3 秒，
        超时就用缓存；缓存也没有就返回一个「加载失败，点这里重试」的极简页，
        永远不让用户对着一片空白猜。
     3) 清单里的 JS 与 index.html 版本绑定在同一个 CACHE 名上，
        改名即全量换新，不会出现「新 HTML 配旧 JS」的错配。

   资源清单用相对路径：线上可能挂在 /xxx/ 子路径下，写死 '/' 会缓存错东西。 */

/* 版本号改动 = 全量换缓存。
   每次发布只要改这里一个地方，activate 会把旧缓存整个删掉。 */
const CACHE = 'wb-v80';

/* 【只列真实存在的文件】
   这份清单必须和 index.html 及 js/ 目录的实际内容对得上。
   加新模块时记得同步加进来，否则断网时那个页面打不开
   （联网时没影响，因为网络优先）。
   核对方法：把下面每个路径拼到站点根地址后面，应当全部返回 200。 */
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  /* 入口与它直接依赖的三个 */
  './js/main.js',
  './js/ui.js',
  './js/core.js',
  './js/cloudsync.js',
  './js/cloud.js',
  './js/auth.js',
  './js/migrate.js',
  /* 实时同步：这两个不进预缓存也不会坏（它们是用 import() 按需拉的），
     但进了清单离线时才有「一端改了另一端自己变」的正经体验 */
  './js/realtime.js',
  './js/live.js',
  /* 数据层 */
  './js/localapi.js',
  './js/localdb.js',
  /* 各业务页面 */
  './js/home.js',
  './js/work.js',
  './js/daily.js',
  './js/study.js',
  './js/me.js',
  './js/repairs.js',
  './js/recycle.js',
  './js/selfstudy.js',
  /* 功能模块 */
  './js/attendance.js',
  './js/alarm.js',
  './js/qrdecode.js',
  './js/pdfprint.js',
  './js/ttimage.js',
  './js/attimage.js',
  './js/homelayout.js',
  './js/xlsx-lite.js',
  './js/att-parse.js',
];

/* 【预缓存的超时】
   线上实测（GitHub Pages）：manifest 只有 603 字节，也要 36 秒；
   css/app.css 193KB 要 40 秒。不是文件大小的问题，是每个请求都要排进
   同一条慢队列。而 install 事件是等 waitUntil 里的 Promise 全部落地才算装完，
   任一请求挂住，整个 SW 就永远停在 installing：
     · active 永远是 null → 页面压根没被 SW 接管
     · 缓存只写进一半
     · 断网也就打不开
   所以给每个文件 8 秒上限：拿不到就算了，不拖累整体。
   断网兜底只要求 index.html + css 在，这两个优先、超时放宽到 15 秒。 */
const TIMEOUT_MS = 8000;
const CORE = new Set(['./', './index.html', './css/app.css']);

function withTimeout(p, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('超时 ' + ms + 'ms: ' + label)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

self.addEventListener('install', (e) => {
  // 立刻进入 waiting → activate，不等所有旧标签页关掉
  self.skipWaiting();
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    /* 逐个添加，且**互不等待**：某个文件慢或 404 都不影响其它文件落进缓存。
       核心文件（首页与样式）放最后并且单独一串，超时更宽，
       这样即使前面几个静态资源全部超时，断网也还能打开站点。 */
    const others = ASSETS.filter((u) => !CORE.has(u));
    const cores = ASSETS.filter((u) => CORE.has(u));
    const grab = (u, ms) => withTimeout(
      fetch(new Request(u, { cache: 'reload' })).then((r) => {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return c.put(u, r);
      }),
      ms, u,
    ).catch((err) => {
      console.warn('[sw] 预缓存失败，跳过：', u, err && err.message);
    });
    // 两串并发跑，谁先完成都不影响谁
    await Promise.all([
      Promise.all(others.map((u) => grab(u, TIMEOUT_MS))),
      Promise.all(cores.map((u) => grab(u, 15000))),
    ]);
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    // 清掉所有旧版本缓存
    const ks = await caches.keys();
    await Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    // 立刻接管已经打开的页面，不用等用户关标签页
    await self.clients.claim();
    // 告诉每个页面「有新版本了，可以刷新」
    const cs = await self.clients.matchAll({ type: 'window' });
    cs.forEach((c) => c.postMessage({ type: 'WB_SW_UPDATED', cache: CACHE }));
  })());
});

/* 【兜底页】
   网络挂了、缓存里也没有首页时，返回这个。
   以前这里直接 throw err，浏览器就是一片灰白，用户只会觉得「这网站坏了」。
   页面上给一个「重试」按钮，点一下重新走一遍导航。 */
const OFFLINE_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>我的工作台</title>
<style>
  html,body{height:100%;margin:0}
  body{display:flex;align-items:center;justify-content:center;min-height:100vh;
       font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;
       background:#f5f6f8;color:#2a2f3a;padding:24px;box-sizing:border-box}
  .box{max-width:340px;text-align:center}
  .logo{width:52px;height:52px;border-radius:15px;margin:0 auto 16px;display:grid;place-items:center;
        background:linear-gradient(135deg,#4f6ef7,#7b5cf0);color:#fff;font-size:22px;font-weight:700}
  h1{font-size:17px;margin:0 0 8px;font-weight:700}
  p{font-size:13.5px;line-height:1.65;color:#6b7280;margin:0 0 18px}
  button{width:100%;height:44px;border:0;border-radius:12px;background:#4f6ef7;color:#fff;
         font-size:15px;font-weight:600;font-family:inherit;cursor:pointer}
  .sub{margin-top:12px;font-size:12px;color:#9aa1ad}
</style></head><body>
<div class="box">
  <div class="logo">台</div>
  <h1>页面没能加载出来</h1>
  <p>多半是网络卡了一下，或者浏览器里存着旧的版本。<br>点下面按钮再试一次。</p>
  <button onclick="location.reload()">重新加载</button>
  <div class="sub">还不行就换个网络，或在浏览器设置里清除本站数据</div>
</div></body></html>`;

function offlineResponse() {
  return new Response(OFFLINE_HTML, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  // 只处理同源的 GET。跨域（天气、字体、图床）和 /api 一律放行，
  // 否则会把第三方响应也塞进缓存，既占空间又可能拿到过期数据。
  if (e.request.method !== 'GET') return;
  if (u.origin !== self.location.origin) return;
  if (u.pathname.includes('/api/')) return;

  /* 【打开页面本身：缓存优先 + 后台更新（stale-while-revalidate）】
     这是白屏事故的直接修法，也是唯一一处「缓存优先」。
     打开页面如果傻等网络，GitHub Pages 一排队就是几十秒，
     用户看到的就是一片空白，然后自己按 F5，每次结果还不一样。
     所以：缓存里有首页就**立刻**给（毫秒级，不可能白屏），
          同时后台去拉最新版，拉到就更新缓存，下次打开就是新的。
     缓存里没有（第一次来）才走网络；网络也拿不到就返回兜底页。
     注意不能把「网络返回的错误页」当成功 —— 502/503 也要走兜底。 */
  if (e.request.mode === 'navigate') {
    const base = self.registration.scope;
    e.respondWith((async () => {
      /* 【查缓存要用绝对地址】
         caches.match('./index.html') 的相对路径按 SW 自己的 scope 解析，
         而缓存里的键是 fetch('./index.html') 得到的完整 URL。
         两者在某些浏览器能对上、有些对不上。显式拼 scope 最稳。 */
      let cached = null;
      try {
        cached = (await caches.match(base + 'index.html'))
          || (await caches.match(base))
          || (await caches.match('./index.html'))
          || (await caches.match('./'));
      } catch (err) {
        cached = null;
      }

      /* 后台更新：不 await，用户不用等它。
         拉到了就覆盖缓存；拉不到（断网/源站挂）就算了，反正手上这份能用。 */
      const revalidate = (async () => {
        try {
          const r = await withTimeout(fetch(e.request), 15000, 'revalidate');
          if (r && r.ok) {
            const c = await caches.open(CACHE);
            await c.put(base + 'index.html', r.clone());
            await c.put(base, r.clone());
          }
        } catch (err) { /* 静默：离线或超时都正常 */ }
      })();

      if (cached) {
        e.waitUntil(revalidate);
        return cached;
      }
      /* 第一次来，缓存是空的：只能等网络 */
      try {
        const r = await withTimeout(fetch(e.request), 12000, 'navigate-first');
        if (r && r.ok) {
          const c = await caches.open(CACHE);
          await c.put(base + 'index.html', r.clone());
          e.waitUntil(c.put(base, r.clone()));
          return r;
        }
        throw new Error('HTTP ' + (r && r.status));
      } catch (err) {
        return offlineResponse();
      }
    })());
    return;
  }

  e.respondWith((async () => {
    try {
      const r = await fetch(e.request);
      return r;
    } catch (err) {
      // 断网：先找缓存，找不到再抛给浏览器
      const hit = await caches.match(e.request);
      if (hit) return hit;
      throw err;
    }
  })());
});
