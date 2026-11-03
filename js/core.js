/* 前端 API 封装 + 通用工具

   === 静态版改造（这一层是整套改造的关键） ===
   原来的 api.req 是 fetch('/api'+path)。现在换成「先在浏览器里算，算不了再走网络」。
   好处：10731 行的页面代码一行没动，行为跟有服务端时一模一样。
   坏处：只有 localapi.js 实现了的接口能用；剩下的（扫码登录、第三方绑定）
         明确返回「静态版不支持」，而不是留个白屏让人以为坏了。 */
import { handle as localHandle } from './localapi.js';

export const STATIC = true;

/* FormData → 纯对象：localapi 需要 { files:[{field,filename,mime,data}], fields:{} } 这个形状 */
/* 【同名 key 不能只留最后一个】
   浏览器允许 FormData 里同一个字段名 append 多次（多选、复选框组、
   或者一行里传 tags 数组），entries() 会把它们一个个吐出来。
   以前这里写的是 fields[k] = v，后来的把先来的覆盖掉，
   于是「选了 3 个标签只存了 1 个」，而且一点报错都没有。
   现在同名（非文件）字段攒成数组。只有一项时仍然给字符串，
   原因是 localapi 里读的是 body.fields.owner_type 这类单值字段，
   一律变数组会让那些地方全拿到 ['attendance'] 而判错。
   需要数组的消费方用 asList() 取，单值也能兼容。 */
async function formDataToObject(fd) {
  const files = [];
  const fields = {};
  for (const [k, v] of fd.entries()) {
    if (v instanceof File) { files.push({ field: k, filename: v.name, mime: v.type, data: await v.arrayBuffer() }); continue; }
    if (Object.prototype.hasOwnProperty.call(fields, k)) {
      if (Array.isArray(fields[k])) fields[k].push(v);
      else fields[k] = [fields[k], v];
    } else {
      fields[k] = v;
    }
  }
  return { files, fields };
}

/* 把一个可能被累加成数组的字段统一取成数组 */
export function asList(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

export const api = {
  async req(method, path, body, opts = {}) {
    let payload = body;
    if (body instanceof FormData) payload = await formDataToObject(body);
    const [p, qs] = String(path).split('?');
    const query = Object.fromEntries(new URLSearchParams(qs || ''));
    const data = await localHandle(method, p, query, payload);
    if (data.ok === false) {
      const err = new Error(data.error || '请求失败');
      err.code = data.code || 500; err.extra = data;
      if (data.code === 401 && !opts.silent) { window.dispatchEvent(new Event('wb:unauth')); }
      throw err;
    }
    return data.data;
  },
  /* opts 必须透传下去：早先这里写成 get: (p, q) => api.req(...)，
     调用方传的 { silent: true } 被当成了第二个参数 q，被拼进 query（?silent=true），
     req 里 opts 永远是 {}，于是「静默轮询」命中 401 照样派发 wb:unauth 把人踢回登录页。 */
  get: (p, q, opts) => api.req('GET', p + (q ? '?' + new URLSearchParams(q) : ''), undefined, opts),
  post: (p, b, opts) => api.req('POST', p, b, opts),
  patch: (p, b, opts) => api.req('PATCH', p, b, opts),
  del: (p, opts) => api.req('DELETE', p, undefined, opts),
};

/* 直接暴露本地接口层，供少数需要原始返回的地方（PDF、导出）调用 */
export const local = { handle: localHandle };

/* ---------- 时间 / 日期 ---------- */
export const pad2 = (n) => String(n).padStart(2, '0');
export const WD_CN = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
export const WD_SHORT = ['日', '一', '二', '三', '四', '五', '六'];
export function ymd(d = new Date()) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
export function parseDT(s) {
  if (!s) return null;
  if (s instanceof Date) return s;
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
  if (!m) return new Date(s);
  return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0));
}
export function fmtTime(s) {
  const d = parseDT(s); if (!d || isNaN(d)) return '';
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
export function fmtDateTime(s) {
  const d = parseDT(s); if (!d || isNaN(d)) return '';
  return `${d.getMonth() + 1}月${d.getDate()}日 ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
export function relDay(s) {
  const d = parseDT(s); if (!d || isNaN(d)) return '';
  const t = new Date(); const a = new Date(t.getFullYear(), t.getMonth(), t.getDate());
  const b = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diff = Math.round((b - a) / 864e5);
  if (diff === 0) return '今天';
  if (diff === 1) return '明天';
  if (diff === 2) return '后天';
  if (diff === -1) return '昨天';
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
export function countdown(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return { d: Math.floor(s / 86400), h: Math.floor((s % 86400) / 3600), m: Math.floor((s % 3600) / 60), s: s % 60 };
}

/* ---------- DOM ---------- */
export function el(html, root = document) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  let node = t.content.firstElementChild;
  /* 必须在返回前把节点从 <template> 的 DocumentFragment 里"拿"出来。
     一个节点同时只能属于一个 parentNode：留在片段里的节点，
     调用方拿它去 insertBefore 时，浏览器会先把它从片段中摘下来
     （这一步是合法的），但如果它已经被别的地方拼过一次、或者
     调用方以为它还在某个容器里，就会抛
     "The node before which the new node is to be inserted is not a child of this node"。
     以前所有调用都是 el(`<div>`) 单元素、直接 appendChild，没暴露；
     手机端二级导航条那句 el(...) 掺进了 app 的 insertBefore，就炸了白屏。 */
  if (node && node.parentNode) node.parentNode.removeChild(node);
  return node;
}
export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/* 班级名：库里常存"高二(5)班"、年级也是"高二"，直接拼会重复成"高二 高二(5)班"。
   约定：班级名已包含年级时只用班级名，否则才补上年份前缀。 */
export const clsName = (grade, cls) => {
  const g = String(grade || '').trim();
  const c = String(cls || '').trim();
  if (!g) return c;
  if (!c) return g;
  return c.startsWith(g) ? c : g + ' ' + c;
};

/* 自动轮询：给「有进行中任务」的场景用（如课堂签到）。
   - 只在页面可见时拉，切到别的标签页自动停，不白烧服务器
   - 上一次没回来就不叠加下一次请求（避免网络慢时堆积）
   - 返回 stop()，离开页面 / 关掉弹层时必须调用
   - 用 setTimeout 递归而不是 setInterval：慢请求不会越堆越多 */
export function startPoll(fn, { every = 3000, immediate = false } = {}) {
  let stopped = false;
  let timer = null;
  let running = false;
  const tick = async () => {
    if (stopped) return;
    if (document.hidden) { schedule(); return; }
    if (running) { schedule(); return; }   // 上一轮还没回来，等下一轮
    running = true;
    try { await fn(); } catch { /* 网络抖动忽略，下一轮继续 */ }
    running = false;
    schedule();
  };
  const schedule = () => {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(tick, every);
  };
  const onVis = () => { if (!document.hidden && !stopped) { clearTimeout(timer); tick(); } };
  document.addEventListener('visibilitychange', onVis);
  if (immediate) tick(); else schedule();
  return () => {
    stopped = true;
    clearTimeout(timer);
    document.removeEventListener('visibilitychange', onVis);
  };
}

let toastTimer = null;
/* 把一条提醒交给系统日历。
   关键结论（实测 + 查证）：**不是在 Safari 里点 .ics 就一定没反应**。
   iOS 的 Safari 认得 text/calendar 这个类型，会把文件交给「日历」App，
   日历弹出带「添加」按钮的预览页——这正是我们要的效果。

   真正会静默失败的是这些场景，必须逐一兜住：
   1. 微信/QQ/钉钉等 App 内置浏览器（WKWebView）——拿到文件无处可去，直接丢弃。
      这些 UA 里有 MicroMessenger / QQ / DingTalk 等标记，先识别再提示。
   2. 添加到主屏幕后以独立窗口运行（standalone）——窗口脱离了 Safari 的文件处理链，
      下载会失败。这种情况给出可点击的 .ics 链接，让它跳到 Safari 里打开。
   3. 安卓——下载后用日历 App 打开即可，给个说明。

   为什么用 <a download> 的真实链接而不是 blob：
   blob URL 在 iOS 上不触发 Safari 的「按 MIME 交给对应 App」那一步，
   只有 http(s) 地址 + 正确的 Content-Type 才会。 */
export function calendarSupport() {
  const ua = navigator.userAgent || '';
  const inApp = /MicroMessenger|QQ\/|QQBrowser|DingTalk|Weibo|AlipayClient|Lark|Feishu/i.test(ua);
  const ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia?.('(display-mode: standalone)')?.matches
    || navigator.standalone === true;
  const android = /Android/i.test(ua);
  return { inApp, ios, android, standalone };
}

/* 生成 .ics 文本。时间统一按 UTC 写出（结尾 Z），
   这样不管手机在哪个时区，日历里显示的都是同一个绝对时刻。 */
export function buildICS(alarms) {
  const pad = (n) => String(n).padStart(2, '0');
  const fmt = (t) => {
    const d = new Date(t);
    return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00Z`;
  };
  const escIcs = (t) => String(t || '')
    .replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  const stamp = fmt(Date.now());
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//MyWorkbench//CN',
    'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
  ];
  for (const a of alarms) {
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${a.uid || Math.random().toString(36).slice(2)}@workbench`);
    lines.push(`DTSTAMP:${stamp}`);
    lines.push(`DTSTART:${fmt(a.due)}`);
    lines.push(`DTEND:${fmt(new Date(new Date(a.due).getTime() + 15 * 60000))}`);
    lines.push(`SUMMARY:${escIcs(a.title)}`);
    if (a.body) lines.push(`DESCRIPTION:${escIcs(a.body)}`);
    lines.push('BEGIN:VALARM', 'ACTION:DISPLAY',
      `DESCRIPTION:${escIcs(a.title)}`,
      `TRIGGER:-PT${Number(a.advance || 0)}M`, 'END:VALARM');
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

/* 把提醒加到系统日历。
   返回一个 Promise，因为要先问服务端要点链接（见 server 的 /api/calendar/ics）。 */
export async function addToSystemCalendar(alarms, toast) {
  const list = Array.isArray(alarms) ? alarms : [alarms];
  const sup = calendarSupport();
  if (sup.inApp) {
    toast?.('当前是应用内浏览器，无法直接打开日历。请点右上角「…」选择「在 Safari 中打开」后重试', 'warn');
    return false;
  }
  // 建一个一次性链接：POST 把内容存在服务端，URL 里只带随机串
  /* 静态版：localapi 直接回 data:text/calendar 的 URL，
     不再需要服务端存目录，也不受「10 分钟过期」限制。 */
  const r = await api.req('POST', '/calendar/ics', { alarms: list }).catch(() => null);
  /* 接口统一包了一层 {ok, data}——api.req 已经把 data 拆出来了，
     所以这里直接就是 { url }。少了这层就会走进「生成链接失败」的分支。 */
  const icsUrl = r?.url;
  if (!icsUrl) { toast?.('生成日历链接失败，请稍后再试', 'err'); return false; }

  /* 独立窗口（主屏幕图标）里下载会被拦，改为新窗口打开让 Safari 接管。
     普通 Safari 标签页直接用 <a download> 触发，这样不会跳走页面。 */
  if (sup.standalone || sup.android) {
    window.open(icsUrl, '_blank');
    toast?.(sup.android ? '已下载日历文件，用手机自带日历打开即可' : '正在交给系统日历…');
    return true;
  }
  const a = document.createElement('a');
  a.href = icsUrl;
  a.download = (list[0]?.title || 'reminder') + '.ics';
  document.body.appendChild(a);
  a.click();
  a.remove();
  toast?.('正在交给系统日历，弹出预览后点「添加」');
  return true;
}

/* ms 是第三个参数：默认 2.4 秒够看一句话，但「本站没配短信服务」这种要用户
   去后台配置的提示，2.4 秒根本读不完，得能停久一点。以前调用处写了 6000，
   函数只收两个参数，第三个数被静默丢掉——加参数比改调用处更省事。 */
export function toast(msg, type = 'ok', ms = 2400) {
  let box = document.getElementById('toast-box');
  if (!box) { box = el('<div id="toast-box" class="toast-box"></div>'); document.body.appendChild(box); }
  const t = el(`<div class="toast toast-${type}">${esc(msg)}</div>`);
  // 长提示给个点击消失，用户不想等可以直接点掉
  if (ms > 3000) { t.style.cursor = 'pointer'; t.onclick = () => t.remove(); }
  box.appendChild(t);
  setTimeout(() => { if (!t.isConnected) return; t.classList.add('out'); setTimeout(() => t.remove(), 260); }, ms);
}

/* 本地存储写满：localdb.save() 会广播 wb:storagefull。
   必须让用户看见——否则界面显示「已保存」，刷新一看全没了。 */
let storageWarned = false;
if (typeof window !== 'undefined') {
  window.addEventListener('wb:storagefull', () => {
    if (storageWarned) return;
    storageWarned = true;
    toast('本机存储空间不足，这次改动没有真正保存。请到「我的 → 数据导出与备份」导出一份后清理旧课件/原图。', 'err', 9000);
    setTimeout(() => { storageWarned = false; }, 12000);
  });
}

/* ---------- 全局异常兜底 ----------
   以前没人监听 unhandledrejection：任何一个没 catch 的 await（4xx/5xx、离线、
   解析失败）都是「点了没反应」——弹层不关、按钮不解禁、一句提示都没有，
   用户只能反复点。这里统一收口：给一条可读的提示，并把错误打到控制台。
   界面层面的收尾（关弹层、恢复按钮）由各处自行负责，这里只保证「有反馈」。 */
let errShownAt = 0;
function reportFatal(err, kind) {
  console.error('[wb]', kind, err);
  const now = Date.now();
  // 一个操作里往往连着抛好几个，10 秒内只提示一次，别糊屏
  if (now - errShownAt < 10000) return;
  errShownAt = now;
  let msg = (err && (err.message || err.reason || err.error)) || '';
  if (msg && msg !== '[object Object]') {
    // 前端错误信息里常带函数名/栈，截短一点，别让 toast 撑满屏幕
    msg = String(msg).split('\n')[0].slice(0, 90);
    toast('操作没成功：' + msg, 'err', 5000);
  } else {
    toast('页面出了点问题，这一步没生效。刷新一下再试，反复出现请到「我的 → 数据导出与备份」先备份数据。', 'err', 7000);
  }
}
if (typeof window !== 'undefined') {
  window.addEventListener('unhandledrejection', (e) => reportFatal(e.reason, 'unhandledrejection'));
  window.addEventListener('error', (e) => {
    // 资源加载失败（img/script）也会冒到这里，那种不该弹提示
    if (e && e.target && e.target !== window) return;
    reportFatal(e.error || e.message, 'error');
  });
}

/* ---------- 弹层：底部抽屉（移动）/居中弹窗（桌面） ---------- */
/* 弹层层级自增。
   【为什么需要它】所有弹层原本共用 .sheet-mask 的同一个 z-index，
   叠两层时（比如「头像」面板里点「移除头像」弹出确认框），
   后弹的确认框并不保证压在上面 —— 用户看到确认框出现了，
   但点「移除」点在的是下面那层的遮罩上，事件被吃掉，
   表现就是「点了确认没反应」（第 2 条）。
   改成每开一层 +1，永远保证最后打开的在最上面。 */
let zBase = 200;
export function sheet({ title = '', body = '', footer = '', wide = false, onMount, onClose, cls = '' }) {
  const wrap = el(`<div class="sheet-mask">
    <div class="sheet ${wide ? 'sheet-wide' : ''} ${cls}">
      <div class="sheet-head">
        <div class="sheet-title">${esc(title)}</div>
        <button class="icon-btn sheet-close" aria-label="关闭"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
      </div>
      <div class="sheet-body"></div>
      ${footer ? '<div class="sheet-foot"></div>' : ''}
    </div>
  </div>`);
  wrap.style.zIndex = String(++zBase);
  const bodyEl = wrap.querySelector('.sheet-body');
  if (typeof body === 'string') bodyEl.innerHTML = body; else if (body) bodyEl.appendChild(body);
  if (footer) { const f = wrap.querySelector('.sheet-foot'); if (typeof footer === 'string') f.innerHTML = footer; else f.appendChild(footer); }
  document.body.appendChild(wrap);
  requestAnimationFrame(() => wrap.classList.add('in'));
  let closed = false;
  let onKey = null;
  const close = () => {
    if (closed) return; closed = true;
    if (onKey) document.removeEventListener('keydown', onKey);
    wrap.classList.remove('in');
    setTimeout(() => {
      wrap.remove();
      /* 全部关掉后把层级归位，避免长时间使用后 z-index 越滚越大 */
      if (!document.querySelector('.sheet-mask')) zBase = 200;
    }, 220);
    onClose?.();
  };
  // Esc 关闭：桌面上点 X 离手太远，键盘用户也指望这个键。
  // 只在「最上层」弹层响应，避免嵌套弹层一按 Esc 全关。
  onKey = (e) => {
    if (e.key !== 'Escape') return;
    const masks = document.querySelectorAll('.sheet-mask');
    if (masks[masks.length - 1] !== wrap) return;
    e.stopPropagation(); close();
  };
  document.addEventListener('keydown', onKey);
  wrap.querySelector('.sheet-close').onclick = close;
  wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
  onMount?.(wrap, close);
  return { wrap, close, body: bodyEl };
}

/* 给弹层里的保存按钮加「失败必提示 + 不会卡住」的保护 */
export function saving(btn, fn) {
  if (!btn) return;
  btn.addEventListener('click', async (ev) => {
    const raw = btn.textContent;
    if (btn.dataset.busy === '1') return;
    btn.dataset.busy = '1'; btn.disabled = true; btn.textContent = '保存中…';
    try { await fn(ev); }
    catch (e) { toast(e?.message || '保存失败，请重试', 'err'); }
    finally { btn.dataset.busy = ''; btn.disabled = false; btn.textContent = raw; }
  });
}

export function confirmDialog(text, { title = '确认操作', okText = '确认', danger = false } = {}) {
  return new Promise((resolve) => {
    const box = el(`<div class="sheet-body">
      <p class="confirm-text">${esc(text)}</p>
      <div class="confirm-actions">
        <button class="btn ghost" data-a="cancel">取消</button>
        <button class="btn ${danger ? 'danger' : 'primary'}" data-a="ok">${esc(okText)}</button>
      </div></div>`);
    /* settled 兜底：原来点「确认」是 resolve(true) + 直接把 wrap 摘掉，
       但 sheet 内部的 closed 标记没同步，onClose 之后还会 resolve(false)；
       更糟的是点完立刻按 Esc 或点遮罩，可能先走 onClose 把 Promise 定成 false。
       结果就是「点了确认没反应」。现在只让第一次生效，且确认永远优先。 */
    let settled = false;
    const done = (v) => { if (settled) return; settled = true; s.close(); resolve(v); };
    const s = sheet({ title, body: box, onClose: () => done(false) });
    box.querySelector('[data-a=cancel]').onclick = () => done(false);
    box.querySelector('[data-a=ok]').onclick = () => done(true);
  });
}

export function promptDialog({ title = '输入', label = '', value = '', placeholder = '', multiline = false, okText = '确定' }) {
  return new Promise((resolve) => {
    const box = el(`<div class="sheet-body">
      ${label ? `<label class="field-label">${esc(label)}</label>` : ''}
      ${multiline ? `<textarea class="input" rows="4" placeholder="${esc(placeholder)}">${esc(value)}</textarea>`
        : `<input class="input" value="${esc(value)}" placeholder="${esc(placeholder)}">`}
      <div class="confirm-actions"><button class="btn ghost" data-a="cancel">取消</button><button class="btn primary" data-a="ok">${esc(okText)}</button></div>
    </div>`);
    let settled = false;
    const done = (v) => { if (settled) return; settled = true; s.close(); resolve(v); };
    const s = sheet({ title, body: box, onClose: () => done(null) });
    const input = box.querySelector('.input');
    setTimeout(() => input.focus(), 120);
    box.querySelector('[data-a=cancel]').onclick = () => done(null);
    box.querySelector('[data-a=ok]').onclick = () => { const v = input.value; done(v); };
  });
}

/* ---------- 表格导出 ---------- */
export function download(url, name) {
  const a = document.createElement('a');
  a.href = url; if (name) a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
}

/* 导出接口在静态版里是同步返回内容的（没有真的 GET 文件流），
   所以这里直接调 localapi 拿数据 → 造 Blob → 下载。
   页面里原来的用法是 download(exportUrl(...))，语义一样，不用改调用处太多。 */
function csvOf(headers, rows) {
  const cell = (c) => `"${String(c ?? '').replace(/"/g, '""')}"`;
  return '\ufeff' + [headers, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
}

export function exportUrl(kind, { month = '', format = 'csv' } = {}) {
  /* 返回一个 data: URL。调用方拿它当 href / download 的目标，
     和原来拿 /api/export/... 是等价的（都是浏览器直接下载）。 */
  const q = new URLSearchParams({ month: month || '', format });
  return `data:application/json,${encodeURIComponent(JSON.stringify({ kind, month: month || '', format }))}#${q}`;
}

/* 静态版真正的导出：同步从本地库取数，生成文件并触发下载。
   mode = 'csv' | 'json' | 'html'（html 走新窗口打印） */
export async function doExport(kind, { month = '', format = 'csv' } = {}) {
  const r = await api.get('/export/' + kind, { month: month || '', format });
  const { title, headers, rows, html } = r || {};
  if (!r) { toast('没有可导出的数据', 'warn'); return; }
  if (format === 'html') {
    const w = window.open('', '_blank');
    if (!w) { toast('浏览器拦截了新窗口，请允许后重试', 'err'); return; }
    w.document.write(html || '<p>无内容</p>');
    w.document.close();
    return;
  }
  let blob; let ext;
  if (format === 'json') {
    blob = new Blob([JSON.stringify({ title, headers, rows }, null, 2)], { type: 'application/json;charset=utf-8' });
    ext = 'json';
  } else {
    blob = new Blob([csvOf(headers || [], rows || [])], { type: 'text/csv;charset=utf-8' });
    ext = 'csv';
  }
  const url = URL.createObjectURL(blob);
  download(url, `${title || kind}.${ext}`);
  setTimeout(() => URL.revokeObjectURL(url), 8000);
}

/* ---------- 语音朗读（名言英文） ---------- */
/* 把一段文本/二进制存成本地文件。
   静态版所有「导出」都要走这里：没有服务端，任何 /api/xxx 下载地址都是 404。
   download(url, name) 只能下载已经存在的 URL，不能凭空造内容。 */
export function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  download(url, name);
  setTimeout(() => URL.revokeObjectURL(url), 8000);
}

let speaking = false;
export function speak(text, onEnd) {
  if (!('speechSynthesis' in window)) { toast('当前浏览器不支持朗读', 'warn'); return; }
  if (speaking) { window.speechSynthesis.cancel(); speaking = false; onEnd?.(false); return; }
  if (!text) return;
  const synth = window.speechSynthesis;
  const doSpeak = () => {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-US'; u.rate = 0.92; u.pitch = 1;
    const voices = synth.getVoices();
    const v = voices.find((x) => /^en[-_]US/i.test(x.lang)) || voices.find((x) => /^en/i.test(x.lang));
    if (v) u.voice = v;
    else if (!voices.length) { speaking = false; onEnd?.(false); toast('这台设备没有可用的语音包，无法朗读', 'warn'); return; }
    u.onend = () => { speaking = false; onEnd?.(false); };
    u.onerror = (ev) => {
      speaking = false; onEnd?.(false);
      if (ev && ev.error === 'not-allowed') toast('浏览器拦截了朗读，请先点一下页面任意位置', 'warn');
    };
    speaking = true;
    onEnd?.(true);
    synth.speak(u);
  };
  // Chrome 首次 getVoices() 为空，需等 voiceschanged
  if (!synth.getVoices().length) {
    let done = false;
    const fire = () => { if (done) return; done = true; doSpeak(); };
    synth.addEventListener('voiceschanged', fire, { once: true });
    setTimeout(fire, 350);
  } else {
    doSpeak();
  }
}
export function stopSpeak() {
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  speaking = false;
}

/* ---------- 学生/事项 颜色 ---------- */
const PALETTE = ['#007AFF', '#AF52DE', '#30B0C7', '#FF9500', '#FF2D55', '#5856D6', '#FF3B30', '#34C759'];
export function colorOf(str = '') {
  let h = 0;
  for (const c of String(str)) h = (h * 31 + c.charCodeAt(0)) % 997;
  return PALETTE[h % PALETTE.length];
}

/* ---------- 本地轻量本地存储 ---------- */
export const ls = {
  get(k, d) { try { const v = localStorage.getItem('wb_' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('wb_' + k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem('wb_' + k); } catch {} },
};

/* ---------------- 学生短链 ----------------
   这几个函数原来在本 work.js 里，只有课件页用。
   三级导航里的「自习」在另一个模块（selfstudy.js），也要拼同一个地址，
   于是上提到 core，避免两个模块各抄一份、改一处漏一处。 */
/* 学生短链：把当前访问凭据（?sharecode= 之类）一并带上，
   否则学生打开会遇到「链接不完整」的拦截页 */
export function studentUrl(code) {
  if (!code) return '';
  const qs = new URLSearchParams(location.search);
  // 只透传平台要求的访问参数，其余（utm 等）不带
  const keep = new URLSearchParams();
  for (const k of ['sharecode', 'code', 'access']) {
    const v = qs.get(k);
    if (v) keep.set(k, v);
  }
  const q = keep.toString();
  /* 【第 15 条：学生短链显示的是长链 / 打不开】
     根子上是两点：
     ① 直拼 `${location.origin}/s/xxx`，丢掉了部署子路径。
        本站托管在 GitHub Pages 的 /my-workbench/ 下，
        拼出来的 .../s/abc 是 404 —— 老师发到群里，学生一律打不开。
     ② 界面上应该显示「/s/abc」这种一眼能看懂的短链，
        完整地址只在「点开 / 复制」时才给。
     所以这里按「当前页面所在目录」拼，子路径自动带上。

     【静态版 /s/<code> 依然 404 —— 这个不是拼错，是根本没有这个路由】
     /s/abc 是服务端路由，GitHub Pages 只认真实文件。
     所以静态版必须走 student.html?code=abc，那个页面自己能读 ?code= 并缓存。
     以前这里照样拼 /s/，等于明知 404 还把死链发给学生。 */
  const base = location.pathname.replace(/[^/]*$/, '');
  const tail = STATIC ? `student.html?code=${encodeURIComponent(code)}` : `s/${code}`;
  const sep = STATIC && q ? '&' : q ? '?' : '';
  return `${location.origin}${base}${tail}${sep}${q}`;
}

/* 屏幕上只显示路径部分。
   用户报的是「学生短链仍显示长链」——之前直接把 studentUrl() 整个丢进 <code>，
   连 https://ad90e9…app.workbuddy.host 这截也一起显示，看着完全不像短链。
   真正的短链主体是 /s/feutnv 这 9 个字符，复制时再补全成完整地址。
   静态版显示 student.html?code=xxx，因为那才是学生真正要打开的地址。 */
export function shortPath(code) {
  if (!code) return '';
  return STATIC ? `student.html?code=${code}` : `/s/${code}`;
}
