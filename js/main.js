import { state, loadMe, render, parseHash, loadAuthConfig } from './ui.js';
import { ls, toast, STATIC, api } from './core.js';
import { setActiveAccount, activeAccountId } from './localdb.js';
import { takeRetiredResetParam } from './startup-safety.mjs';

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
import { hookSave, tryImportFromHash, initializeAccountSync } from './cloudsync.js';

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

/* 旧维护入口已停用。URL 清理不接触数据库、同步元数据或云端数据。 */
const retiredReset = takeRetiredResetParam(location.href);
if (retiredReset.requested) {
  try { history.replaceState(null, '', retiredReset.next); } catch { }
  setTimeout(() => toast('旧的数据重置链接已停用，现有数据没有变化', 'warn', 7000), 600);
}

/* 【换设备登录 #k=…】必须在 render 之前跑完：
   先把 token 换到手，后面课时页一渲染就是已登录状态，
   不会出现「先闪一下未登录提示条、再跳成已登录」的抖动。 */
try {
  const { autoLoginFromUrl } = await import('./auth.js');
  await autoLoginFromUrl();
} catch (e) {
  toast(e.message, 'err', 6000);
}

await loadAuthConfig();
const cloudAuth = await import('./cloud.js');
let cloudSession = cloudAuth.session();
setActiveAccount(cloudSession?.uid || '');

let accountSyncReady = !cloudSession?.uid;
if (cloudSession?.uid) {
  try {
    accountSyncReady = await initializeAccountSync();
    if (!accountSyncReady) throw new Error('云端账户数据尚未完成初始化');
  } catch (e) {
    /* 云端临时超时不应阻止本地工作台打开。
       cloudsync 在初始化成功前会拒绝所有上传，避免把本机旧快照覆盖到云端。 */
    accountSyncReady = false;
    console.error('[sync] 账户数据初始化失败，进入本地只读保护模式', e);
    toast('云端暂时连接不上：' + (e.message || e) + '。工作台将先使用本机缓存；本地修改会留在本机，云端连接恢复前不会上传。请稍后刷新重试。', 'warn', 12000);
  }
}
if (cloudSession?.uid) {
  try {
    /* 导入和同步数据写入当前用户自己的本地命名空间，绝不落进旧的共享库。 */
    try { await tryImportFromHash(); } catch (e) { toast(e.message, 'err', 6000); }
    await api.post('/auth/login-cloud', {
      phone: cloudSession.phone || '',
      email: cloudSession.email || '',
      uid: cloudSession.uid,
    }, { silent: true });
  } catch (e) {
    console.warn('[auth] 本机账号初始化失败', e);
    toast('账号数据初始化失败：' + (e.message || e), 'err', 7000);
    await cloudAuth.logout();
    setActiveAccount('');
    cloudSession = null;
  }
}
/* 仅供本地 Playwright 使用的隔离登录夹具。
   必须同时满足 localhost/127.0.0.1 与显式 ?e2e=1；不写 Supabase token、
   不请求云端认证、不在任何线上域名启用。每个浏览器 context 使用全新存储。 */
const E2E_LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname)
  && new URLSearchParams(location.search).get('e2e') === '1'
  && !cloudSession?.uid;
let e2eLocalUser = null;
if (E2E_LOCAL) {
  e2eLocalUser = await api.post('/auth/login-cloud', {
    account: '12345678901',
    email: 'e2e@workbench.local',
    uid: 'e2e-local-only',
  }, { silent: true });
}
state.user = E2E_LOCAL ? (e2eLocalUser?.user || null) : (cloudSession?.uid ? await loadMe() : null);
if (!location.hash) location.hash = '#/home';
window.addEventListener('hashchange', () => render());

window.addEventListener('storage', (event) => {
  if (event.key !== cloudAuth.SESSION_STORAGE_KEY) return;
  const nextUid = cloudAuth.session()?.uid || '';
  if (nextUid !== activeAccountId()) location.reload();
});

window.addEventListener('wb:signout', async () => {
  try { await cloudAuth.logout(); } catch (e) { console.warn('[auth] 云端退出失败', e); }
  try { await api.post('/auth/logout', null, { silent: true }); } catch (e) { console.warn('[auth] 本地退出标记失败', e); }
  window.dispatchEvent(new Event('wb:auth-changed'));
  setActiveAccount('');
  state.user = null;
  location.hash = '#/home';
  await render();
});

await render();
window.__wbBooted = true;
window.dispatchEvent(new Event('wb:booted'));

/* ============================================================================
   实时同步（一端改动，另一端自己变）

   放在首屏渲染之后启动，而不是之前：订阅要建 WebSocket、要拉 token，
   让用户先看到界面比先连上更重要 —— 反正连接只需几百毫秒。

   两件事要分开看：
     · realtime.js  负责"连上、收到推送"（网络层）
     · live.js      负责"收到推送后怎么安全地重绘"（界面层）
   合在一起写会让重连逻辑和重绘逻辑互相牵制，debug 时很难分辨是哪边的问题。
   ========================================================================== */
try {
  const rt = await import('./realtime.js');
  const live = await import('./live.js');
  live.startLiveRefresh();
  live.bindLiveDot();
  window.addEventListener('wb:snapshot-applied', async () => {
    try {
      /* 云端快照已经写入本地库，必须同步刷新内存中的用户对象。
         否则「我的」首页仍拿旧 state.user 渲染，顶部资料卡片会显示旧信息。 */
      await loadMe();
      /* profileDraft 会保留当前正在编辑的未保存输入；重绘可让资料表单与顶部卡片一起读取最新 state.user。 */
      await render();
    } catch (e) {
      console.warn('[sync] 远端资料刷新失败', e);
    }
  });
  rt.syncWithAuth();
  /* 登录框是浮层，登录成功不会重新加载页面，所以这里要主动补一次连接。
     用事件解耦：auth.js 登录/退出后派发 wb:auth-changed，不必反向 import。 */
  window.addEventListener('wb:auth-changed', () => { try { rt.syncWithAuth(); } catch { } });
} catch (e) {
  /* 实时同步失败不应该影响任何主流程：页面照常能用，只是不会自动变 */
  console.warn('[live] 实时同步没启动起来', e);
}

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
const LOCAL_DEV_HOSTS = new Set(['localhost', '127.0.0.1']);
if ('serviceWorker' in navigator && !LOCAL_DEV_HOSTS.has(location.hostname)) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
  /* 注册后主动问一次：有没有装好但还没接管的新版本？
     以前只能等 activate 里的 postMessage，如果那次消息没送达
     （页面刚好在切换、或 SW 装完时页面已关闭），用户就永远不知道有新版本。
     这里在页面可见时补一刀，顺带覆盖「后台积压了好几个版本」的情况。 */
  navigator.serviceWorker.ready.then(async (reg) => {
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
} else if ('serviceWorker' in navigator) {
  /* localhost 是开发环境，不能使用 PWA 缓存：否则切换 dev 代码后，
     浏览器可能继续拿旧 index.html / JS，造成「页面加载失败」假象。
     index.html 中还有一段更早执行的注销逻辑，防止 main.js 未加载时被旧 SW 卡住。 */
  navigator.serviceWorker.getRegistrations()
    .then((regs) => Promise.all(regs.map((reg) => reg.unregister())))
    .catch((e) => console.warn('[sw] 本地开发环境注销旧缓存失败', e));
}

/* === 【2026-10 离线失效事故复盘 —— 这里曾经把缓存删干净】 ===
   现象：联网时页面正常，一旦断网（或 GitHub Pages 抽风），打开就是
        「页面没能加载出来」，反复刷新也不恢复；但 devtools 里缓存条目
        明明有 27 条、SW 状态也是 activated。
   原因：上面原本有一段「清理空壳 SW」的老代码，是从上一代项目
        「班级资料站」原样搬来的，它有三处必须写成上一代项目才成立：
          ① 缓存版本写死成 'wb-v66'（当前 sw.js 用的是 'wb-v70'）；
          ② 用「缓存里有没有 ./app.js」判断 SW 是否健康
             —— app.js 是旧项目 674KB 的打包产物，本项目没有这个文件，
             所以这个判断永远得出「不健康」；
          ③ 只要发现有注册过的 SW，就把「所有名字不等于 wb-v66 的缓存
             全部删掉」。sw.js 刚建好的 wb-v70 正好不是 wb-v66 → 被删。
        于是每次打开页面：SW 装好、预缓存写满 27 条 →
        main.js 一执行 → 27 条全被删 → 断网时 caches.match 落空 → 兜底页。
        这也能解释「同一台电脑换个浏览器就好了」：那个浏览器里
        SW 还没注册上，走的是纯网络，反而正常。
   修法：这一整段删除逻辑直接去掉。
        · 缓存版本号只有 sw.js 一个地方说了算，页面不再重复声明；
        · 旧版本缓存由 sw.js 的 activate 清理（它只留 CACHE 那一个名字）；
        · 不再靠 app.js 这种具体文件判断健康，只认 serviceWorker.controller。
   教训：跨项目搬代码时，凡是出现具体版本号、具体文件名的地方，
        要么一起改，要么整段删 —— 半懂不懂地留着比没有更危险。 */

/* 【自愈：SW 脚本地址不对时，自动刷一次】
   只处理一种真的会发生的坏情况：controller 指向的不是本目录的 sw.js
   （换过部署路径、或历史遗留注册）。用 sessionStorage 记一笔，只刷一次，
   避免刷成死循环。
   注意：这里绝不再碰 caches，删缓存的事只归 sw.js 的 activate 管。 */
if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
  const key = 'wb_sw_healed';
  let healed = 0;
  try { healed = Number(sessionStorage.getItem(key)) || 0; } catch { }
  if (healed < 1) {
    const cur = navigator.serviceWorker.controller.scriptURL;
    if (!cur || !cur.endsWith('/sw.js')) {
      (async () => {
        try {
          sessionStorage.setItem(key, '1');
        } catch { }
        location.reload();
      })();
    }
  }
}

/* 账户级云同步已在首屏前完成一次初始化；不要再无条件重复请求。
   失败时保留本地只读模式，用户刷新页面即可重新尝试。 */

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
