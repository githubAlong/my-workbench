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
const CACHE = 'wb-v67';

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

/* 【预缓存的超时】
   线上实测（GitHub Pages）：manifest 只有 603 字节，也要 36 秒；
   app.js 674KB 要 35 秒，css/app.css 193KB 要 40 秒。
   不是文件大小的问题，是每个请求都要排进同一条慢队列。
   而 install 事件是等 waitUntil 里的 Promise 全部落地才算装完，
   任一请求挂住，整个 SW 就永远停在 installing：
     · active 永远是 null → 页面压根没被 SW 接管
     · 缓存只写进一半（实测只有 4/7 个文件）
     · 断网也就打不开
   以前这里没有任何超时，浏览器等得不耐烦就把安装任务丢掉，
   表现出来就是「加了新版本但用户那边永远不生效」。
   现在给每个文件 8 秒上限：拿不到就算了，不拖累整体。
   断网兜底只要求 index.html + app.js 在，这两个优先、超时放宽到 15 秒。 */
const TIMEOUT_MS = 8000;
const CORE = new Set(['./', './index.html', './app.js']);

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
       核心文件（首页与 app.js）放最后并且单独一串，超时更宽，
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
