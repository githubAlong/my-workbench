/* 我的工作台 Service Worker
   作用只有两个：可添加到主屏幕、断网时能打开。
   别在这里做「缓存优先」——踩过坑，改了代码用户还看旧版。
   资源清单用相对路径：线上可能挂在 /xxx/ 子路径下，写死 '/' 会缓存错东西。 */
const CACHE = 'wb-v33';
const ASSETS = ['./', './index.html', './css/app.css', './js/main.js', './js/core.js', './js/ui.js', './js/home.js', './js/work.js', './js/daily.js', './js/study.js', './js/me.js', './js/recycle.js', './js/alarm.js', './js/homelayout.js', './js/selfstudy.js', './js/repairs.js', './js/qrdecode.js', './manifest.webmanifest'];
self.addEventListener('install', (e) => { self.skipWaiting(); e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS).catch(() => {}))); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))); });
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.pathname.startsWith('/api/')) return;
  e.respondWith(fetch(e.request).then((r) => {
    // 网络优先，仅作离线兜底
    return r;
  }).catch(() => caches.match(e.request).then((hit) => hit || caches.match('./index.html'))));
});
