import { api, el, esc, toast, fmtDateTime, addToSystemCalendar } from './core.js';
import { icon, state } from './ui.js';

/* 闹钟式提醒：轮询 + 本机铃声（WebAudio） + 浏览器通知 + 全屏闹钟弹层 */

/* 【铃声为什么以前不响】
   Chrome 的自动播放策略：AudioContext 必须在「用户手势」之后创建/恢复，
   否则一直是 suspended 状态，createOscillator 能建但不发声，控制台只留一句
   「The AudioContext was not allowed to start」。用户设完提醒就去看别处了，
   到点时早已没有手势，于是弹层有、声音没有。

   解法：在页面第一次被用户触碰（点击/按键/触摸）时就把 ctx 建好并 resume，
   之后到点直接 play 就行——这是绕过自动播放策略的标准做法。 */
let ctx = null;
function ensureCtx() {
  try {
    ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
  } catch { ctx = null; }
  return ctx;
}
['pointerdown', 'keydown', 'touchstart'].forEach((ev) => {
  window.addEventListener(ev, ensureCtx, { once: true, passive: true });
});

function beep(pattern = 'chime', times = 3) {
  try {
    ensureCtx();
    if (!ctx) return;
    const seq = pattern === 'bell' ? [880, 660, 880] : pattern === 'soft' ? [523, 659] : [988, 1319];
    let t0 = ctx.currentTime;
    for (let i = 0; i < times; i++) {
      seq.forEach((f, k) => {
        const o = ctx.createOscillator(); const g = ctx.createGain();
        o.type = pattern === 'soft' ? 'sine' : 'triangle';
        o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t0 + k * 0.22);
        g.gain.exponentialRampToValueAtTime(pattern === 'soft' ? 0.12 : 0.22, t0 + k * 0.22 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + k * 0.22 + 0.3);
        o.connect(g).connect(ctx.destination);
        o.start(t0 + k * 0.22); o.stop(t0 + k * 0.22 + 0.32);
      });
      t0 += 0.9;
    }
  } catch { /* 静音环境忽略 */ }
}
export function vibrate() { try { navigator.vibrate?.([200, 120, 200, 120, 300]); } catch {} }

/* ================= 轮询（第 38 条：设置提醒到点不提醒） =================

   用户报「设了提醒，到点没动静」。查下来是四个问题叠在一起：

   ① **窗口期只有 1 小时**：`fire_at > now - 3600000` 一旦错过就永远不响。
      老师设个下午 3 点的提醒，中午关掉页面出门，下午回来就不再提醒了。
      现在改成「只要没 ack 就该响」，迟到也认——迟到总比不响强。
   ② **后台标签页被节流**：Chrome 对隐藏标签的 setInterval 压到 1 分钟一次，
      手机浏览器切走更狠（直接冻结）。20 秒的轮询根本不是准时来源。
      现在增加一个「精确闹钟」：算出最近一条的毫秒差，用 setTimeout 卡点，
      再用 60 秒兜底轮询兜住休眠/改系统时间的漂移。
   ③ **手机锁屏后什么都不响**：纯网页做不到息屏唤醒，这是浏览器的物理限制。
      所以提供「加到系统日历」作为可靠兜底——日历闹钟是系统级的，关掉网页也响。
   ④ **权限要在用户手势里要**：原来靠 document 的一次性 click 事件，
      很多人第一次点的是导航，弹窗被拦，之后一直是 default 状态。

   还有一点：`fire()` 依赖 `#alarm-root`，如果这个节点还没建好，弹层 appendChild 会抛错，
   表现出来同样是「不提醒」。这里加兜底自建。 */
const shown = new Set();
let alarmTimer = null;

async function poll(force = false) {
  if (!state.user) return; // 未登录不轮询，避免登录页 401
  try {
    const list = await api.get('/reminders', null, { silent: true });
    const now = Date.now();
    let next = 0;
    for (const r of list) {
      if (r.status !== 'scheduled' || !r.fire_at) continue;
      const fireAt = Number(r.fire_at);
      if (fireAt > now) {
        /* 记下最近的一条，用来精确卡点 */
        if (!next || fireAt < next) next = fireAt;
        continue;
      }
      if (shown.has(r.id)) continue;
      shown.add(r.id);
      /* fire() 单独 try：一条提醒渲染失败不能连带把后面的全堵死，
         而且必须 console.error 出来——早先这里被外层 catch 吞掉，
         表现就是「到点不提醒」，连日志都没有。 */
      try { fire(r); } catch (e) { console.error('[alarm] 弹提醒失败', r, e); }
    }
    scheduleNext(next);
    if (force) sweepMissed(list);
  } catch { /* 未登录或网络异常 */ }
}

/* 精确闹钟：到点前 setTimeout 一次，比 60 秒轮询准时得多。
   setTimeout 的上限是 2^31-1 毫秒（约 24.8 天），超出会立刻触发，
   所以超过 24 天的不排，交给兜底轮询。 */
function scheduleNext(at) {
  if (alarmTimer) { clearTimeout(alarmTimer); alarmTimer = null; }
  if (!at) return;
  const delay = at - Date.now() + 300; // 多给 300ms，防止时钟抖动刚好卡在边界
  if (delay <= 0 || delay > 2147483647) return;
  alarmTimer = setTimeout(() => { alarmTimer = null; poll(); }, delay);
}

/* 补提醒：页面被关了、休眠过、或者用户直接关了标签页，
   那段时间到点的提醒不会经过 fire()，只在消息中心留了一条。
   回到页面时用系统通知补一句「有 N 条提醒已经到点了」，让人知道漏了什么。 */
const SWEPT_KEY = 'wb_alarm_swept';
function sweepMissed(list) {
  let last = 0;
  try { last = Number(localStorage.getItem(SWEPT_KEY) || 0); } catch {}
  const now = Date.now();
  const missed = (list || []).filter((r) => r.status === 'scheduled'
    && Number(r.fire_at) <= now && Number(r.fire_at) > last);
  try { localStorage.setItem(SWEPT_KEY, String(now)); } catch {}
  if (!missed.length) return;
  /* 只有已经授权通知、且不是刚刚才设的，才补通知；
     刚设完 1 分钟内的不补，否则用户刚设完就被「补提醒」打扰。 */
  const old = missed.filter((r) => now - Number(r.fire_at) > 60000);
  if (!old.length) return;
  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      new Notification(`⏰ 有 ${old.length} 条提醒到点了`, {
        body: old.slice(0, 3).map((r) => r.title).join('、') + (old.length > 3 ? ` 等 ${old.length} 条` : ''),
        tag: 'wb-missed',
      });
    } catch {}
  }
  toast(`有 ${old.length} 条提醒已经到点了：${old.slice(0, 2).map((r) => r.title).join('、')}${old.length > 2 ? '…' : ''}`, 'warn', 8000);
}

function fire(r) {
  if (r.ring !== 'none') beep(r.ring, 2);
  vibrate();
  if ('Notification' in window && Notification.permission === 'granted') {
    try { new Notification('⏰ ' + r.title, { body: r.body || fmtDateTime(r.due_at), tag: 'wb-' + r.id }); } catch {}
  }
  /* #alarm-root 没建好就自己建一个：appendChild 到 null 会抛错，
     而 fire() 是在轮询的 catch 里调的，抛出去就直接静默失败了。 */
  let box = document.getElementById('alarm-root');
  if (!box) {
    box = document.createElement('div');
    box.id = 'alarm-root';
    document.body.appendChild(box);
  }
  let ringing = true;
  /* 闹钟必须压在所有弹层之上：普通弹层现在每开一层 +1，
     写死 600 迟早会被盖住（用户正在编辑东西时闹钟被挡住 = 又变成「不提醒」）。 */
  const topZ = (() => {
    let z = 600;
    document.querySelectorAll('.sheet-mask').forEach((x) => {
      const v = Number(getComputedStyle(x).zIndex) || 0;
      if (v >= z) z = v + 1;
    });
    return z;
  })();
  const pop = el(`<div class="sheet-mask in" style="z-index:${topZ}">
    <div class="sheet" style="max-width:380px;text-align:center">
      <div class="sheet-body" style="padding:26px 20px 18px">
        <div style="color:var(--primary);display:flex;justify-content:center">${icon('bell', 42)}</div>
        <div class="bold" style="font-size:19px;margin-top:10px">${esc(r.title)}</div>
        <div class="small muted" style="margin-top:4px">${esc(fmtDateTime(r.due_at))}${r.advance_min ? ` · 提前 ${r.advance_min} 分钟提醒` : ''}</div>
        ${r.body ? `<div class="small" style="margin-top:10px;color:var(--text-2)">${esc(r.body)}</div>` : ''}
        <div class="col" style="margin-top:20px;gap:8px">
          <button class="btn primary block" data-a="ok" style="height:46px">知道了</button>
          <div class="row" style="gap:8px">
            <button class="btn ghost" data-a="snooze" style="flex:1">稍后再响 10 分钟</button>
            <button class="btn ghost" data-a="ics" style="flex:1">加到系统日历</button>
          </div>
        </div>
      </div>
    </div></div>`);
  box.appendChild(pop);
  const timer = setInterval(() => { if (ringing && r.ring !== 'none') beep(r.ring, 1); }, 12000);
  const stop = () => { ringing = false; clearInterval(timer); pop.remove(); };
  pop.querySelector('[data-a=ok]').onclick = async () => { stop(); await api.post(`/reminders/${r.id}/ack`); };
  pop.querySelector('[data-a=snooze]').onclick = async () => { stop(); await api.post(`/reminders/${r.id}/snooze`, { minutes: 10 }); toast('10 分钟后再响'); shown.delete(r.id); };
  /* 加到系统日历不关闭弹层：用户可能只是想补一份到系统日历，回来还要点「知道了」。 */
  pop.querySelector('[data-a=ics]').onclick = () => {
    addToSystemCalendar({ title: r.title, due: r.due_at, advance: r.advance_min || 0, body: r.body }, toast);
  };
}

/* 兜底轮询 60 秒一次：后台标签页会被浏览器节流到分钟级，
   所以真正的准时来源是上面的 scheduleNext，这里只负责纠偏
   （休眠唤醒、改系统时间、跨天）。 */
setInterval(poll, 60000);
setTimeout(() => poll(true), 1800);
window.addEventListener('focus', () => poll(true));
document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(true); });
window.addEventListener('online', () => poll(true));
/* 手机从后台被唤回时（bfcache），定时器全停了，必须重新排一次 */
window.addEventListener('pageshow', (e) => { if (e.persisted) poll(true); });
/* 对外暴露，方便设置完提醒立刻重排闹钟，不用等 60 秒 */
export function refreshAlarms() { poll(); }

/* 请求通知权限：必须在用户手势里调，否则 Chrome 会静默拦掉、永远停在 default。
   挂在第一次「真正点击按钮」上，而不是任意 click（点空白处也算、白白浪费一次机会）。 */
function askNotify() {
  if (!('Notification' in window)) return;
  if (Notification.permission !== 'default') return;
  try { Notification.requestPermission(); } catch {}
}
document.addEventListener('click', (e) => {
  if (e.target.closest('button, .btn, [role=button], a')) askNotify();
}, { capture: true, once: true });

/* 设完提醒就立刻重排闹钟：不然最早要等 60 秒兜底轮询，
   用户会以为「设了不生效」。 */
export function alarmAfterCreate() {
  shown.clear();          // 新设的提醒不能被旧的 shown 挡住
  setTimeout(() => poll(), 400);
}
