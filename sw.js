/* 我的工作台 Service Worker
   作用：可添加到主屏幕、断网时能打开。
   关键修正（wb-v34）：index.html 永远走网络且绕过浏览器缓存（cache:'reload'），
   保证 WB_API_BASE 这种「写在 index.html 里」的配置改动后能立即生效，
   不会再被 service worker / HTTP 缓存锁在旧后端域名上（之前就是这个原因卡住）。
   其它静态资源仍走「网络优先 + 写入缓存」做离线兜底。
   资源清单用相对路径：线上可能挂在 /xxx/ 子路径下，写死 '/' 会缓存错东西。 */
const CACHE = 'wb-v34';
const ASSETS = ['./', './index.html', './css/app.css', './js/main.js', './js/core.js', './js/ui.js', './js/home.js', './js/work.js', './js/daily.js', './js/study.js', './js/me.js', './js/recycle.js', './js/alarm.js', './js/homelayout.js', './js/selfstudy.js', './js/repairs.js', './js/qrdecode.js', './manifest.webmanifest'];
self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS).catch(() => {})).then(() => self.clients.claim()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
});
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.pathname.startsWith('/api/')) return;
  const isIndex = u.pathname === '/' || u.pathname === '/index.html' || u.pathname.endsWith('/index.html');
  if (isIndex) {
    // index.html：永远直连网络并绕过缓存，离线才退回缓存里的旧版
    e.respondWith(fetch(e.request, { cache: 'reload' }).catch(() => caches.match('./index.html')));
    return;
  }
  // 其它静态资源：网络优先，顺手写进缓存供离线使用
  e.respondWith(
    fetch(e.request).then((r) => {
      const copy = r.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
      return r;
    }).catch(() => caches.match(e.request).then((hit) => hit || caches.match('./index.html')))
  );
});
