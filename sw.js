/* 我的工作台 Service Worker
   作用只有两个：可添加到主屏幕、断网时能打开。

   === 为什么策略是「网络优先」 ===
   踩过坑：缓存优先的写法改完代码用户还看旧版，而且刷新几次都不变，
   只能手动清缓存，比不能离线更糟。所以任何能连上网络的时候都以网络为准，
   缓存只用于断网兜底。

   === 2026-10 修掉的两个真问题 ===
   1) 预缓存清单写的是源码路径（./js/main.js、./js/core.js …），
      但打包后的产物里根本没有 js/ 目录，只有一个 app.js。
      cache.addAll() 是「全成全败」：任何一个 404 整批都 reject，
      被 .catch(() => {}) 静默吞掉 —— 结果缓存名建出来了、里面一条都没有，
      断网打不开，而且这个失败在控制台里只有一行警告，很难发现。
      现在清单只列产物里真实存在的文件，并且改成逐个 add、单个失败不拖累其它。
   2) 没有处理「新版本装好了但旧页面还开着」的情况。
      用户开着标签页，后台装完新 SW 却不生效，要关到只留一个标签页才更新。
      现在 activate 里 clients.claim() 接管，并通知所有页面可以更新。

   资源清单用相对路径：线上可能挂在 /xxx/ 子路径下，写死 '/' 会缓存错东西。 */
const CACHE = 'wb-v64';

/* 只列构建产物里确实存在的文件。
   student.html 依赖 student.bundle.js，两个都带上。 */
const ASSETS = [
  './',
  './index.html',
  './student.html',
  './student.bundle.js',
  './app.js',
  './css/app.css',
  './manifest.webmanifest',
];

self.addEventListener('install', (e) => {
  // 立刻进入 waiting → activate，不等所有旧标签页关掉
  self.skipWaiting();
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    // 逐个添加：某个文件 404 不影响其它文件落进缓存
    await Promise.all(ASSETS.map(async (u) => {
      try { await c.add(new Request(u, { cache: 'reload' })); }
      catch (err) { console.warn('[sw] 预缓存失败，跳过：', u, err && err.message); }
    }));
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

self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  // 只处理同源的 GET。跨域（天气、字体、图床）和 /api 一律放行，
  // 否则会把第三方响应也塞进缓存，既占空间又可能拿到过期数据。
  if (e.request.method !== 'GET') return;
  if (u.origin !== self.location.origin) return;
  if (u.pathname.includes('/api/')) return;

  e.respondWith((async () => {
    try {
      const r = await fetch(e.request);
      return r;
    } catch (err) {
      // 断网：先找缓存，找不到再退首页（保证站点还能打开，不是浏览器的恐龙页）
      const hit = await caches.match(e.request);
      if (hit) return hit;
      if (e.request.mode === 'navigate') {
        const idx = await caches.match('./index.html');
        if (idx) return idx;
      }
      throw err;
    }
  })());
});
