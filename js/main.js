import { state, loadMe, render, parseHash, loadAuthConfig } from './ui.js';
import { ls, toast, STATIC } from './core.js';

/* 【第 30 条 · 白屏】
   原来这里是 9 行串行 import：
       await import('./home.js'); await import('./work.js'); ...
   本地看不出问题，但部署到静态托管（GitHub Pages / 任何 CDN）后，
   每个 js 文件都要单独回源，冷启动一个文件就要 0.8~5 秒。
   串行等 9 个 = 十几秒白屏，用户以为站坏了，直接关掉。

   改并行：9 个请求同时发出，总耗时约等于最慢的那一个。
   同时把「页面注册」和「首屏渲染」解耦——渲染只需要 ui.js + core.js，
   早就到位了，不该陪着模块一起等。 */
const MODULES = [
  './home.js', './work.js', './daily.js', './study.js', './selfstudy.js',
  './repairs.js', './me.js', './recycle.js', './alarm.js',
];

/* 先给个骨架，避免用户盯着空白页 */
function paintSkeleton() {
  const app = document.getElementById('app');
  if (!app || app.innerHTML.trim()) return;
  app.innerHTML =
    '<div style="display:flex;align-items:center;justify-content:center;height:100vh;' +
    'font:14px/1.6 -apple-system,BlinkMacSystemFont,\'PingFang SC\',\'Microsoft YaHei\',sans-serif;' +
    'color:#8e8899;flex-direction:column;gap:14px">' +
    '<div style="width:26px;height:26px;border:2.5px solid rgba(124,92,255,.2);' +
    'border-top-color:#7C5CFF;border-radius:50%;animation:wbspin .8s linear infinite"></div>' +
    '<div>正在打开工作台…</div>' +
    '<style>@keyframes wbspin{to{transform:rotate(360deg)}}</style>' +
    '</div>';
}
paintSkeleton();

/* 并行加载所有页面模块。这里只 await「注册完成」，不等任何网络数据。 */
const modulesReady = Promise.all(MODULES.map((m) => import(m).catch((e) => {
  // 单个页面模块挂了，不能让整个工作台打不开
  console.error('页面模块加载失败：' + m, e);
  return null;
})));

const [me] = await Promise.all([
  loadAuthConfig().then(() => (STATIC ? loadSeed() : null)).then(() => loadMe()),
  modulesReady,
]);

/* 静态版没有服务端，进来先灌一份示例数据（只灌一次），
   否则新用户看到一个空工作台会以为坏了。 */
async function loadSeed() {
  const { seedIfEmpty } = await import('./localapi.js');
  seedIfEmpty();
}

state.user = me;
if (!location.hash) location.hash = '#/home';
window.addEventListener('hashchange', () => render());
await render();

/* WorkBuddy 授权回调带回来的结果。
   回调是整页跳转回来的，页面会整个重载，所以提示只能靠 URL 参数传。
   处理完立刻把参数从地址栏抹掉，否则用户刷新一次就会再弹一遍。 */
(function handleWbCallback() {
  const q = new URLSearchParams(location.search);
  const map = {
    wb_login: ['WorkBuddy 登录成功', 'ok'],
    wb_bound: ['WorkBuddy 账号已绑定', 'ok'],
    wb_error: [q.get('wb_error') || 'WorkBuddy 登录失败', 'err'],
  };
  const hit = Object.keys(map).find((k) => q.has(k));
  if (!hit) return;
  const [msg, kind] = map[hit];
  // 延后一帧，让首屏先渲染完，否则 toast 容器还没建好
  setTimeout(() => toast(msg, kind), 260);
  q.delete(hit);
  const rest = q.toString();
  history.replaceState(null, '', location.pathname + (rest ? '?' + rest : '') + location.hash);
}());

/* 注册 Service Worker（PWA，可添加到主屏幕）
   scope 用相对路径：线上可能被平台挂在 /xxx/ 子路径下，写死 '/sw.js' 会 404。 */
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});

/* 主题同步 */
document.documentElement.dataset.theme = state.theme;
ls.set('theme', state.theme);
