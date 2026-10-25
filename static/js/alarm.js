import { api, el, esc, toast, fmtDateTime, addToSystemCalendar } from './core.js';
import { icon, state } from './ui.js';

/* 闹钟式提醒：轮询 + 本机铃声（WebAudio） + 浏览器通知 + 全屏闹钟弹层 */
let ctx = null;
function beep(pattern = 'chime', times = 3) {
  try {
    ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
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

const shown = new Set();
async function poll() {
  if (!state.user) return; // 未登录不轮询，避免登录页 401
  try {
    const list = await api.get('/reminders', null, { silent: true });
    const now = Date.now();
    for (const r of list) {
      if (r.status === 'scheduled' && r.fire_at <= now && r.fire_at > now - 3600 * 1000 && !shown.has(r.id)) {
        shown.add(r.id);
        fire(r);
      }
    }
  } catch { /* 未登录或网络异常 */ }
}

function fire(r) {
  if (r.ring !== 'none') beep(r.ring, 2);
  vibrate();
  if ('Notification' in window && Notification.permission === 'granted') {
    try { new Notification('⏰ ' + r.title, { body: r.body || fmtDateTime(r.due_at), tag: 'wb-' + r.id }); } catch {}
  }
  const box = document.getElementById('alarm-root');
  let ringing = true;
  const pop = el(`<div class="sheet-mask in" style="z-index:600">
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

setInterval(poll, 20000);
setTimeout(poll, 2500);
window.addEventListener('focus', poll);
document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });

/* 请求通知权限（用户首次交互后） */
document.addEventListener('click', function once() {
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  document.removeEventListener('click', once);
}, { once: true });
