import { state, loadMe, render, parseHash, loadAuthConfig } from './ui.js';
import { ls, toast, STATIC } from './core.js';

/* 【第 30 条 · 白屏】
   原来这里是 9 行串行 import：
       await import('./home.js'); await import('./work.js'); ...
   本地看不出问题，但部署到静态托管后每个 js 文件都要单独回源，
   冷启动一个文件就要 0.8~5 秒，串行等 9 个 = 十几秒白屏。

   现在改用**静态 import**（不是 await import）：
     - 静态 import 会被打包工具合成一个请求，上线后 18 个文件变 1 个；
     - 静态 import 是「先解析完整个模块图再执行」，天然并发；
     - 各页面模块的顶层代码只是 registerView()，副作用极轻。
   首屏渲染仍然先于重内容：render() 只依赖 ui.js/core.js，早就到位了。 */
import './home.js';
import './work.js';
import './daily.js';
import './study.js';
import './selfstudy.js';
import './repairs.js';
import './me.js';
import './recycle.js';
import './alarm.js';
import { autoSync, hookSave } from './cloudsync.js';

/* 云同步：本地一改就排队上传（内部有防抖）；启动时看一眼云端有没有新数据。
   没绑定云存储时 hookSave 是空操作，autoSync 直接返回，零开销。 */
window.addEventListener('wb:localchange', hookSave);

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

/* 静态版没有服务端，进来先灌一份示例数据（只灌一次），
   否则新用户看到一个空工作台会以为坏了。 */
if (STATIC) {
  const { seedIfEmpty } = await import('./localapi.js');
  seedIfEmpty();
}

state.user = await loadAuthConfig().then(() => loadMe());
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

/* 云同步启动检查：放最后，等首屏渲染完再悄悄跑，不抢首屏时间 */
autoSync();

/* 主题同步 */
document.documentElement.dataset.theme = state.theme;
ls.set('theme', state.theme);

/* 打包版把 localapi 塞进了 app.js，冒烟测试/控制台调试需要能拿到 handle。
   dist 里没有 js/localapi.js 这个文件，所以从这里挂一份到 window，
   测试脚本会优先用这个，找不到再回退到动态 import 源码路径。 */
if (STATIC) {
  import('./localapi.js').then((m) => { window.__wbLocalApi = m; }).catch(() => {});
}

/* 课表图片识别也挂一份，方便排查「为什么这张图没切准」 */
import('./ttimage.js').then((m) => { window.__wbDetect = m.detectTimetable; }).catch(() => {});
