﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿/* 我的工作台 Service Worker
   作用只有两个：可添加到主屏幕、断网时能打开。

   === 为什么首页网络优先、静态资源按缓存版本更新 ===
   首页必须网络优先，才能及时发现新版本；JS/CSS 则跟随 CACHE 整体换版，
   同一个缓存版本内内容不变，可以直接使用预缓存。每次发布必须递增 CACHE，
   新 Service Worker 激活时会重新预取并删除旧缓存，不会长期停在旧版本。
   这样避免每次打开都把近百个模块重新请求一遍，慢网络下也不至于白屏一分钟。

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
     2) 导航请求（打开页面本身）单独处理：网络失败才用缓存；
        缓存也没有就返回一个「加载失败，点这里重试」的极简页，
        不用固定超时把仍在传输的线上页面误判成离线。
     3) 清单里的 JS 与 index.html 版本绑定在同一个 CACHE 名上，
        改名即全量换新，不会出现「新 HTML 配旧 JS」的错配。

   资源清单用相对路径：线上可能挂在 /xxx/ 子路径下，写死 '/' 会缓存错东西。 */

/* 版本号改动 = 全量换缓存。
   每次发布只要改这里一个地方，activate 会把旧缓存整个删掉。 */
const CACHE = 'wb-v326-db-switch-guard';

/* 【只列真实存在的文件】
   这份清单必须和 index.html 及 js/ 目录的实际内容对得上。
   加新模块时记得同步加进来，否则断网时那个页面打不开
   （联网且缓存缺失时会回源，发布时随 CACHE 整体换版）。
   核对方法：把下面每个路径拼到站点根地址后面，应当全部返回 200。 */
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './css/design-refresh.css',
  './css/teacher-ui.css',
  './css/attendance-workspace.css',
  './css/attendance-prd.css',
  './css/workbench-unified.css',
  './css/timetable-redesign.css',
  './css/sticky-notes.css',
  './css/trips-redesign.css',
  './css/study-records.css',
  './css/sync-status.css',
  './js/trips.js',
  './js/trips-domain.mjs',
  './css/auth-redesign.css',
  './assets/teacher-ui/hero-scene.webp',
  './assets/teacher-ui/brand-avatar.png',
  /* 入口与它直接依赖的三个 */
  './js/main.js',
  './js/ui.js',
  './js/core.js',
  './js/cloudsync.js',
  './js/sync-journal.mjs',
  './js/sync-status.js',
  './js/cloud.js',
  './js/environment-config.mjs',
  './js/auth-identifier.mjs',
  './js/auth.js',
  './js/migrate.js',
  './js/startup-safety.mjs',
  /* 实时同步：这两个不进预缓存也不会坏（它们是用 import() 按需拉的），
     但进了清单离线时才有「一端改了另一端自己变」的正经体验 */
  './js/realtime.js',
  './js/live.js',
  /* 数据层 */
  './js/localapi.js',
  './js/localdb.js',
  './js/prep-domain.mjs',
  './js/prep-csv.mjs',
  './js/timetable-periods.mjs',
  './js/timetable-schedule.mjs',
  './js/invigilation.js',
  './js/invigilation-domain.mjs',
  /* 各业务页面 */
  './js/home.js',
  './js/weather-location.mjs',
  './js/weather-view.mjs',
  './js/work.js',
  './js/material-sharing.mjs',
  './student.html',
  './js/class-records.js',
  './js/prep.js',
  './js/timetable.js',
  './js/daily.js',
  './js/sticky-notes.js',
  './js/sticky-notes-domain.mjs',
  './js/todo-item-sync.mjs',
  './js/task-messages.mjs',
  './js/study.js',
  './js/study-records.js',
  './js/study-records-domain.mjs',
  './js/me.js',
  './js/demo-data-scan.mjs',
  './js/clean-demo-data.js',
  './js/repairs.js',
  './js/repairs-domain.mjs',
  './js/recycle.js',
  './js/selfstudy.js',
  './js/selfstudy-task-image.mjs',
  /* 功能模块 */
  './js/attendance.js',
  './js/attendance-prd.js',
  './js/attendance-prd-domain.mjs',
  './js/ocr.js',
  './js/alarm.js',
  './js/qrdecode.js',
  './js/pdfprint.js',
  './js/ttimage.js',
  './js/attimage.js',
  './js/homelayout.js',
  './js/homegrid.js',
  './js/xlsx-lite.js',
  './js/att-parse.js',
  './js/attvoice.js',
  './js/attstats.js',
  './js/attleave.js',
  './js/attday.js',
  './js/attendance-domain.mjs',
  './js/attendance-export.mjs',
  './js/attgrade.js',
  './js/attindex.js',
  './js/attreset.js',
  './js/roster-import.mjs',
  './js/roster-batch.mjs',
  './js/roster-photo-parser.mjs',
  './js/roster-structure.mjs',
];

/* 安装阶段不预取文件。冷启动时即使只预取首页核心，也会和当前页面争用
   慢网络连接；所有资源首次实际使用时由 fetch 处理程序写入同一个 CACHE。
   ASSETS 仍保留完整清单，供版本换缓存、资源核对和已访问页面离线使用。 */
self.addEventListener('install', () => {
  // 立刻进入 waiting → activate，不等所有旧标签页关掉
  self.skipWaiting();
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
<title>教师个人工作台</title>
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
  <div class="sub">请检查网络后重试。本提示不会清除本机资料或登录信息。</div>
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

  /* 【打开页面本身：网络优先 + 离线缓存兜底】
     首页不直接沿用缓存，避免新 HTML 与当前 CACHE 的静态资源错配。
     网络失败时才读首页缓存；网络也拿不到且没有缓存就返回兜底页。
     注意不能把「网络返回的错误页」当成功 —— 502/503 也要走兜底。 */
  if (e.request.mode === 'navigate') {
    const base = self.registration.scope;
    const url = new URL(e.request.url);
    const scopePath = new URL(base).pathname;
    /* 只有工作台首页（scope 根 / index.html）才按「首页壳」处理。
       以前所有导航都当成 index.html：打开 student.html 时断网会拿缓存的教师首页
       顶替（学生端就显示「页面没能加载出来」），联网时还会把学生端 HTML 写进
       首页缓存，反过来污染工作台。子页面改成网络优先、离线回退自己的缓存。 */
    if (url.pathname !== scopePath && url.pathname !== scopePath + 'index.html') {
      e.respondWith((async () => {
        try {
          return await fetch(e.request);
        } catch (error) {
          console.warn('[sw] 子页面网络失败，尝试使用缓存：', url.pathname, error && error.message);
          const cached = (await caches.match(e.request))
            || (url.pathname.includes('student') ? await caches.match(base + 'student.html') : null);
          return cached || offlineResponse();
        }
      })());
      return;
    }
    e.respondWith((async () => {
      /* 网络优先，但不人为缩短浏览器自身的网络超时。
         缓存只用于离线兜底：写入慢或失败都不能丢弃已经成功的网络响应。 */
      try {
        const response = await fetch(e.request, { cache: 'no-store' });
        if (!response || !response.ok) throw new Error('HTTP ' + (response && response.status));
        caches.open(CACHE).then((cache) => Promise.all([
          cache.put(base + 'index.html', response.clone()),
          cache.put(base, response.clone()),
        ])).catch((cacheError) => {
          console.warn('[sw] 首页缓存写入失败，仍使用网络页面：', cacheError && cacheError.message);
        });
        return response;
      } catch (error) {
        console.warn('[sw] 导航网络请求失败，尝试使用缓存页面：', error && error.message);
        const cached = (await caches.match(base + 'index.html'))
          || (await caches.match(base))
          || (await caches.match('./index.html'))
          || (await caches.match('./'));
        return cached || offlineResponse();
      }
    })());
    return;
  }

  e.respondWith((async () => {
    /* JS/CSS 与 CACHE 同版本：命中就直接返回，不再让近百个模块逐个等待网络。
       发布时递增 CACHE 并重新预缓存；旧缓存会在 activate 时删除。 */
    const cached = await caches.match(e.request);
    if (cached) return cached;
    try {
      /* 缓存未命中时绕过浏览器 HTTP 缓存：否则套着旧 max-age 的 JS 会被
         原样写进新版本的 CACHE，发布后还继续跑旧脚本。 */
      const response = await fetch(e.request, { cache: 'reload' });
      if (response.ok) {
        const cache = await caches.open(CACHE);
        await cache.put(e.request, response.clone());
      }
      return response;
    } catch (error) {
      console.warn('[sw] 静态资源网络请求失败：', e.request.url, error && error.message);
      throw error;
    }
  })());
});

