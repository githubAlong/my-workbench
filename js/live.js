/* ============================================================================
   实时重绘：收到云端推送后，让"当前这一屏"自己更新

   【为什么不直接 location.reload()】
   最省事的写法是收到推送就整页刷新。但这样会有三个问题，而且都很扎眼：
     1. 老师正在填考勤格子，对面设备改了一下别的表 → 这一页被刷掉，输入全丢
     2. 整页刷新会重新拉所有数据、重跑首屏，手机上明显卡一下
     3. 刷新频率一高（比如对面在批量导入）页面会不停闪

   所以这里分成三级：
     · 数据变了 → 通知当前视图"静默重载"（不重建整个页面，只重画内容区）
     · 正在输入 / 弹层打开 → 先记下"待刷新"，等用户停手或关掉弹层再刷新
     · 页面不可见 → 等切回来再刷新（后台标签页没必要重绘）

   【回声抑制】
   自己改的数据服务端也会推回来。realtime.js 已经按主键做了抑制，
   这里再兜一层「同一秒内同一张表只刷一次」—— 批量提交时服务端会推几十条，
   逐条重绘等于把页面刷几十遍。
   ========================================================================== */

import { render } from './ui.js';

/* 【细粒度刷新】页面自己声明"别人改了这个我该怎么刷"。
   为什么需要它：考勤页首页（列表）和"打开某张表"之后（格子）是两个完全不同的界面，
   而且打开表时 hash 仍然是 #/work/attendance —— 光看路径分不出这两者。
   如果一律走 render()，正在看格子的人会被弹回列表页，这在真实使用里是致命的：
   对面手机勾一下，这边正对着名册打勾的老师就被弹出来了。
   所以各页面在这里登记一个刷新函数，收到推送时先问它，它说"我来"就不走通用重绘。 */
const HOOKS = [];

export function registerLiveHook(fn) {
  HOOKS.push(fn);
  return () => {
    const i = HOOKS.indexOf(fn);
    if (i >= 0) HOOKS.splice(i, 1);
  };
}

/* 每张表 → 影响哪些页面。
   写清楚的原因：收到 attendance_rows 的推送时，正在看课时页的人不该被重绘，
   否则切回来会发现课时页被重置了筛选条件。 */
const AFFECTS = {
  lessons: ['work/lessons', 'work/prep', 'home'],
  invigilations: ['work/invigilation', 'home'],
  attendance_tables: ['work/attendance', 'home'],
  attendance_rows: ['work/attendance', 'home'],
};

const st = {
  pending: false,      // 有变更还没落到界面上
  timer: null,
  lastRun: 0,
  quietUntil: 0,       // 输入中：这个时间点之前不刷
  count: 0,            // 本轮累计收到多少条
};

/* 攒一下再刷：批量写入会连推几十条，等 400ms 收齐再动一次手 */
const COALESCE_MS = 400;

function currentPath() {
  const h = (location.hash || '#/home').replace(/^#\/?/, '');
  return h.split('?')[0] || 'home';
}

/* 页面里有没有"正在编辑的东西"。有就先别动 DOM。
   contenteditable 和 select 也算 —— 下拉框展开时重绘，它会被直接关掉。 */
function busyEditing() {
  if (Date.now() < st.quietUntil) return true;
  const ae = document.activeElement;
  if (ae) {
    const tag = (ae.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
    if (ae.isContentEditable) return true;
  }
  /* 弹层打开着：考勤格子、编辑对话框都在浮层里。
     浮层里往往有未保存的改动，重绘会把它们静默吞掉。
     类名用 .sheet-mask —— 这是 core.js 里 sheet() 和 ui.js 里 sheetRaw()
     唯一的共同点，新写的弹层只要走它们就自动被保护到。 */
  if (document.querySelector('.sheet-mask, [data-no-refresh]:not(#wb-live-dot)')) return true;
  return false;
}

/* 【这里踩过一个让实时同步整体失效的坑，必须写下来】
   上面那句选择器里的 [data-no-refresh] 原意是"带这个属性的区域别被重绘"，
   而状态灯自己身上也挂了 data-no-refresh（防止它被当成编辑区）。
   结果：只要状态灯在（也就是只要连着实时），querySelector 就永远命中，
   busyEditing() 恒为 true —— 推送收到了、批也攒了、真要刷的那一刻被自己挡住，
   2 秒后重试再被挡，页面一动不动。
   表现极具迷惑性：连接是 live、wb:remote 也到了、"已更新"也闪了，就是界面不变。
   所以判断"被保护的编辑区"必须**排除状态灯自己**。
   教训：一个属性同时表达两件事（"别刷我" / "别把我当编辑区"）迟早出事。 */

/* 真的去刷新 */
async function flush() {
  if (!st.pending) return;
  if (document.visibilityState === 'hidden') return;   // 后台先不动，切回来再说
  if (busyEditing()) {
    /* 用户还在动，20 秒后再看。不无限等下去的原因是：
       万一某个弹层没正确关闭（有没有这种 bug 谁也不敢保证），
       至少要保证数据最终还是新鲜的。 */
    clearTimeout(st.timer);
    st.timer = setTimeout(flush, 2000);
    return;
  }
  st.pending = false;
  st.count = 0;
  st.lastRun = Date.now();
  try {
    await render();
    emitStatus('已更新');
  } catch (e) {
    console.warn('[live] 重绘失败', e);
  }
}

function schedule() {
  st.pending = true;
  clearTimeout(st.timer);
  st.timer = setTimeout(flush, COALESCE_MS);
}

function emitStatus(text) {
  try {
    window.dispatchEvent(new CustomEvent('wb:live-tick', { detail: { text, count: st.count } }));
  } catch { }
}

/* ---------------------------------------------------------------------------
   对外
--------------------------------------------------------------------------- */

let _started = false;

export function startLiveRefresh() {
  if (_started) return;
  _started = true;

  window.addEventListener('wb:remote', (ev) => {
    const d = ev.detail || {};
    const path = currentPath();
    const targets = AFFECTS[d.table] || [];
    st.count += 1;

    /* 推送的表跟当前页面无关：不重绘。
       但仍然记一下 —— 界面上那个「云端有新数据」的提示还是要给的。 */
    if (!targets.includes(path)) {
      emitStatus('有更新');
      return;
    }

    /* 先让当前页面自己处理。钩子返回 true = 它已经知道怎么刷了，
       并且刷得比整页 render 更准（比如只重拉这张表的明细，不换界面）。 */
    for (const fn of HOOKS.slice()) {
      let took = false;
      try { took = fn(d, path) === true; } catch (e) { console.warn('[live] 页面自己的刷新钩子出错', e); }
      if (took) {
        /* 同一批推送里可能还有别的表要刷，攒完这一轮再统一兜底 */
        clearTimeout(st.hookTimer);
        st.hookTimer = setTimeout(() => { st.count = 0; st.pending = false; }, COALESCE_MS);
        emitStatus('已更新');
        return;
      }
    }
    schedule();
  });

  /* 切回前台：如果攒着没刷，立刻补一次 */
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && st.pending) flush();
  });

  /* 用户开始在输入框里打字时，把"安静期"往后推。
     不是靠监听每个输入框，而是用捕获阶段的 input 事件统收 ——
     页面里几百个格子，逐个绑不现实。 */
  document.addEventListener('input', () => {
    st.quietUntil = Date.now() + 3000;
    if (st.pending) {
      clearTimeout(st.timer);
      st.timer = setTimeout(flush, 3000);
    }
  }, true);

  /* 焦点离开输入框 = 可能保存完了，这时候补刷正好 */
  document.addEventListener('focusout', () => {
    if (st.pending) {
      clearTimeout(st.timer);
      st.timer = setTimeout(flush, 800);
    }
  }, true);
}

/* 给界面用：现在到底通没通 */
export function liveInfo() {
  return { ...st };
}

/* ============================================================================
   状态灯：右上角一个小圆点，告诉用户"现在是实时的"

   【为什么这个灯值得做】
   实时同步最怕的不是连不上，而是**用户以为连着、其实没连**：
   老师在大屏上等对面手机同步，等了半分钟没动静，会以为系统坏了，
   实际上是 WebSocket 早就断了。有一个明确的灯，至少能立刻分辨"是数据没变"
   还是"是没连上"。

   【什么情况不显示】
   没登录云端（纯本机使用）时完全不显示 —— 这是绝大多数新用户的第一印象，
   右上角挂个红点会让人以为出了问题。只有真的配了云端账号才出现。
   ========================================================================== */

const DOT_ID = 'wb-live-dot';
let dotStatus = '';
let dotTick = '';

function paintDot() {
  const host = document.getElementById(DOT_ID);
  if (!host) return;
  const s = dotStatus;
  const label = {
    live: '实时同步已连接',
    connecting: '正在连接…',
    error: '未连接，正在重试',
    denied: '订阅被拒：这张表还没在 Supabase 开启实时',
    idle: '',
  }[s] || '';

  if (!label) { host.remove(); return; }
  const color = { live: '#2f9e44', connecting: '#adb5bd', error: '#e8590c', denied: '#e03131' }[s] || '#adb5bd';
  host.innerHTML =
    `<span style="width:7px;height:7px;border-radius:50%;background:${color};display:inline-block;` +
    `${s === 'live' ? '' : 'animation:wbpulse 1.4s ease-in-out infinite'}"></span>` +
    `<span>${dotTick || (s === 'live' ? '实时' : '未连')}</span>`;
  host.title = label;
  if (!document.getElementById('wb-live-kf')) {
    const kf = document.createElement('style');
    kf.id = 'wb-live-kf';
    kf.textContent = '@keyframes wbpulse{0%,100%{opacity:1}50%{opacity:.25}}';
    document.head.appendChild(kf);
  }
}

function mountDot() {
  if (document.getElementById(DOT_ID)) return;
  /* 挂到页头右侧。页头每次都整块重建，所以每轮 render 后都要补回来，
     不能只在启动时插一次 —— 这也是为什么下面用 MutationObserver 盯着。 */
  const head = document.querySelector('.page-head');
  if (!head) return;
  const d = document.createElement('div');
  d.id = DOT_ID;
  d.style.cssText =
    'display:inline-flex;align-items:center;gap:5px;font-size:11px;color:var(--muted,#8e8899);' +
    'padding:3px 8px;border-radius:999px;background:var(--chip,#f4f3f7);white-space:nowrap;cursor:default';
  d.dataset.noRefresh = '1';   // 别让它自己被当成"正在编辑"
  const spacer = head.querySelector('.spacer');
  if (spacer) head.insertBefore(d, spacer.nextSibling);
  else head.appendChild(d);
  paintDot();
}

export function bindLiveDot() {
  window.addEventListener('wb:realtime-status', (ev) => {
    dotStatus = ev.detail?.status || '';
    if (!dotStatus || dotStatus === 'idle') {
      const host = document.getElementById(DOT_ID);
      if (host) host.remove();
      return;
    }
    mountDot();
    paintDot();
  });

  /* 订阅被拒：多半是表没加进 supabase_realtime。
     这种情况重连一万次也没用，所以给明确文案，别让用户看"正在重试"干等。 */
  window.addEventListener('wb:realtime-denied', () => {
    dotStatus = 'denied';
    mountDot();
    paintDot();
  });

  /* 收到过更新时短暂显示"已更新"，然后回到"实时"。
     这个小反馈很重要：用户能确认"对面真的改了，我这边真的收到了"，
     而不是靠猜。 */
  window.addEventListener('wb:live-tick', () => {
    dotTick = '已更新';
    paintDot();
    clearTimeout(st._tickTimer);
    st._tickTimer = setTimeout(() => { dotTick = ''; paintDot(); }, 2200);
  });

  /* 页头是 render 时整块替换的，圆点会跟着消失。盯着 DOM 变化补回去。
     用 MutationObserver 而不是在 render 结尾排队调用，
     是因为页面内部还会局部重绘（比如考勤格子），那些地方不会走 render()。 */
  let queued = false;
  const mo = new MutationObserver(() => {
    if (queued) return;
    queued = true;
    setTimeout(() => {
      queued = false;
      if (dotStatus && dotStatus !== 'idle' && !document.getElementById(DOT_ID)) mountDot();
    }, 60);
  });
  mo.observe(document.body, { childList: true, subtree: true });
}
