import { state, loadMe, render, parseHash, loadAuthConfig } from './ui.js';
import { ls, toast, STATIC } from './core.js';

await import('./home.js');
await import('./work.js');
await import('./daily.js');
await import('./study.js');
await import('./selfstudy.js');
await import('./repairs.js');
await import('./me.js');
await import('./recycle.js');
await import('./alarm.js');

await loadAuthConfig();
/* 静态版没有服务端，进来先灌一份示例数据（只灌一次），
   否则新用户看到一个空工作台会以为坏了。 */
if (STATIC) {
  const { seedIfEmpty } = await import('./localapi.js');
  seedIfEmpty();
}
state.user = await loadMe();
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
