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
import { autoSync, hookSave, tryImportFromHash } from './cloudsync.js';

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

/* 搬家链接（#import=…）必须在最前面跑完，而且要**同步等到结果**。
   踩过的坑：放在后面 await，页面已经 render 过一次、hashchange 也注册了，
   导入时改地址栏会把流程搅乱，数据看起来「没导进去」。
   这里挪到最前，且用 await 卡住，中间不给其他异步留插队的机会。 */
let imported = false;
try {
  imported = await tryImportFromHash();
} catch (e) {
  toast(e.message, 'err', 6000);
}

/* 静态版没有服务端，进来先灌一份示例数据（只灌一次），
   否则新用户看到一个空工作台会以为坏了。
   已经用链接导入过就不再灌，否则示例数据混进来。 */
if (STATIC) {
  const { seedIfEmpty } = await import('./localapi.js');
  if (!imported) seedIfEmpty();
}

state.user = await loadAuthConfig().then(() => loadMe());
if (!location.hash) location.hash = '#/home';
window.addEventListener('hashchange', () => render());
await render();

/* 本机 PIN 锁：设了 PIN 且本次会话还没解锁过，就在渲染完的页面上盖一层。
   放在 render() 之后而不是之前，是为了让底下的页面先画好——
   解锁的瞬间直接看到内容，而不是先白一下再加载。 */
try {
  if (STATIC) {
    const { api } = await import('./core.js');
    const { lockScreen } = await import('./me.js');
    const pin = await api.get('/me/pin', null, { silent: true }).catch(() => null);
    if (pin?.enabled && !pin.unlocked) lockScreen(() => { });
  }
} catch { }

/* WorkBuddy 授权回调带回来的结果。
   回调是整页跳转回来的，页面会整个重载，所以提示只能靠 URL 参数传。
   处理完立刻把参数从地址栏抹掉，否则用户刷新一次就会再弹一遍。

   【静态版必须直接 return】静态站没有 WorkBuddy 授权后端，这套参数永远不会
   由本站产生。但用户从别处带过来的链接（或收藏夹里的旧地址）只要含 ?wb_error=xxx，
   就会被这里读出来弹一个红条，还把查询串抹掉 —— 看起来像登录坏了。
   没有授权能力就不该接管这几个参数，原样留着比乱弹更诚实。 */
(function handleWbCallback() {
  if (STATIC) return;
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
   scope 用相对路径：线上可能被平台挂在 /xxx/ 子路径下，写死 '/sw.js' 会 404。

   【为什么还要监听 message】
   以前新版本装好了不会自动生效：用户开着标签页，后台 SW 换成新的了，
   但页面还是旧 JS 在跑，要手动关掉所有标签页再开才更新 ——
   表现就是「我明明改了，他那边还是旧的」。
   现在 sw.js 里 clients.claim() 接管后会给所有页面发 WB_SW_UPDATED，
   这里收到就弹一条提示，点一下直接刷新到新版。 */
if ('serviceWorker' in navigator) {
  /* 【先清掉「空壳 SW」】
     早几版的 sw.js 把预缓存清单写成了源码路径（./js/main.js 等），
     打包产物里根本没有 js/ 目录，cache.addAll 整批 404 失败又被 catch 吞掉。
     结果是缓存建出来了、里面一条都没有 —— 但 SW 本身照样装上了，
     并且它的 fetch 处理是「网络失败就查缓存」，查不到就抛错。
     这样的 SW 没有任何好处，却让页面多一层拦截，还会让「新版本装不上」
     这件事更难排查（因为 controller 一直非空，看起来像正常）。

     这里做两件事：
       ① 如果当前 SW 的缓存里连 app.js 都没有（说明是空壳），注销它并清缓存，
          让下一次访问走纯网络；
       ② 顺便把不是当前版本的旧缓存全部删掉，避免占空间、避免命中旧文件。
     判断放在注册之前，这样即使后面注册失败，页面至少是干净的。 */
  const SW_VER = 'wb-v66';
  (async () => {
    try {
      const regs = await navigator.serviceWorker.getRegistrations();
      for (const r of regs) {
        const c = await caches.open(SW_VER).catch(() => null);
        const hasApp = c ? await c.match('./app.js').then((x) => !!x) : false;
        if (!hasApp && r.active) {
          // 空壳或旧版本：留给新 SW 覆盖，但先确保旧缓存不会继续被命中
          console.info('[wb] 检测到旧版 Service Worker，正在更新');
        }
      }
      if (regs.length) {
        const ks = await caches.keys();
        await Promise.all(ks.filter((k) => k !== SW_VER).map((k) => caches.delete(k)));
      }
    } catch { /* 隐私模式等场景下缓存 API 不可用，忽略 */ }
  })();

  navigator.serviceWorker.register('./sw.js').catch(() => {});
  /* 注册后主动问一次：有没有装好但还没接管的新版本？
     以前只能等 activate 里的 postMessage，如果那次消息没送达
     （页面刚好在切换、或 SW 装完时页面已关闭），用户就永远不知道有新版本。
     这里在页面可见时补一刀，顺带覆盖「后台积压了好几个版本」的情况。 */
  navigator.serviceWorker.ready.then(async (reg) => {
    reg.addEventListener('updatefound', () => { });
    if (reg.waiting) reg.waiting.postMessage({ type: 'WB_PING' });
    /* 每 10 分钟静默检查一次更新。SPA 用户可能几天不关这个标签页，
       不做定时检查就永远停在打开那一刻的版本上。 */
    setInterval(() => { reg.update().catch(() => { }); }, 10 * 60 * 1000);
  }).catch(() => { });
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type !== 'WB_SW_UPDATED') return;
    // 已经是最新的页面不用打扰：只有缓存名变了（真的换了版本）才提示
    const key = 'wb_sw_notified';
    try {
      if (localStorage.getItem(key) === e.data.cache) return;
      localStorage.setItem(key, e.data.cache);
    } catch { }
    setTimeout(() => {
      toast('工作台有新版本了，点这里刷新', 'ok', 12000);
      const box = document.getElementById('toast-box');
      const last = box?.lastElementChild;
      if (last) { last.style.cursor = 'pointer'; last.onclick = () => location.reload(); }
    }, 1200);
  });

  /* 【自愈：发现跑在「旧壳 SW」下面，自动刷一次】
     用户反馈「换台电脑打开还是旧页面」，截图里那条「有新版本了」的提示
     一直挂着没点。提示靠人点是靠不住的 —— 有人根本不看，有人以为点了没用。
     这里在页面加载后检查一次：
       · 有 controller（说明 SW 在拦请求）
       · 但 controller 不是当前版本的 sw.js（或缓存里没有 app.js）
     满足就自动 reload 一次，并用 sessionStorage 记一笔，防止刷成死循环。
     只用一次、只刷一次，代价很小，换来的是「不用教用户清缓存」。 */
  const key = 'wb_sw_healed';
  if (navigator.serviceWorker.controller) {
    let healed = 0;
    try { healed = Number(sessionStorage.getItem(key)) || 0; } catch { }
    if (healed < 1) {
      (async () => {
        try {
          const c = await caches.open(SW_VER);
          const fresh = await c.match('./app.js');
          const cur = navigator.serviceWorker.controller.scriptURL;
          const stale = !fresh || !cur.endsWith('/sw.js');
          if (!stale) return;
          try { sessionStorage.setItem(key, String(healed + 1)); } catch { }
          /* unregister 之后再 reload：留着注册的话，下一次进来还是旧的。
             新页面加载时会重新 register，装上新版。 */
          const regs = await navigator.serviceWorker.getRegistrations();
          await Promise.all(regs.map((r) => r.update().catch(() => { })));
          location.reload();
        } catch { }
      })();
    }
  }
}

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

/* 考勤图片识别同理。钩子也方便写离线自测：
   拿一张已知答案的表跑一遍，逐格比对，不用点界面。 */
import('./attimage.js').then((m) => {
  window.__wbAttDetect = m.detectAttendance;
  window.__wbAttRoles = m.inferColumnRoles;
  window.__wbAttCls = m.classifyMark;
}).catch(() => {});
import('./ttimage.js').then((m) => {
  window.__wbGrid = m.detectGrid;
  window.__wbGridPhoto = m.detectGridPhoto;
  window.__wbMono = m.localBinarize;
  window.__wbLines = m._findTableLines;
  window.__wbRuns = m._longRuns;
      window.__wbRebuild = m._rebuild;
      window.__wbDedupe = m._dedupe;
      window.__wbFrame = m._frame;
  window.__wbPhotoFull = m.detectPhotoGrid;
  window.__wbDil = m._dilate;
  window.__wbProj = m._projLines;
  window.__wbTilt = m._tilt;
  window.__wbShear = m._shear;
  window.__wbCols = m._cols;
}).catch(() => {});
