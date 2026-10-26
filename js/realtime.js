/* ============================================================================
   实时同步：把 Supabase Realtime 接成「一端改动，另一端自己变」

   【为什么不用 supabase-js 的 channel()】
   supabase-js 会多拉 100 多 KB 一个包，而这个项目是纯静态站点、没有打包工具，
   所有 js 文件都是原样加载的。为了一个 WebSocket 订阅背上一个 SDK 不划算。
   更关键的是：咱们的登录是自己写的（token 存在 localStorage 的 wb_supa_tok），
   不是 supabase-js 的 session 对象 —— 直接用它反而要再写一层适配。
   所以这里手写协议。Realtime 底层是 Phoenix Channels，协议本身很简单：
   连上以后发一条 phx_join 加入频道，之后服务端主动推 event。
   消息体就三种：{topic, event, payload, ref}。

   【它是怎么知道"你该看哪些行"的】
   订阅时把 access_token 一起交上去，Realtime 服务会自己按 RLS 过滤 ——
   别人的数据根本不会推到你这条连接上。这点比自己在前端筛更可靠：
   前端筛等于数据已经下来了，只是没显示。

   【连不上会怎样】
   不会报错弹窗。Realtime 属于「有更好、没有也能用」的能力：
   订阅失败时页面照常工作，只是不会自动变，用户手动刷新还是能看到最新数据。
   只有真的在用（页面底部那个小圆点）才会显示「未连接」。
   ========================================================================== */

/* 和 cloud.js 保持同一个键。这里不走 import，避免两个模块互相拽着初始化。 */
const CFG_KEY = 'wb_supa_cfg';
const TOK_KEY = 'wb_supa_tok';

/* 需要实时的表。加表只改这里一行 ——
   SQL 那边也要把同名表加进 supabase_realtime 发布，两处必须对得上。 */
export const REALTIME_TABLES = [
  'lessons',
  'invigilations',
  'attendance_tables',
  'attendance_rows',
];

function cfg() {
  try { return JSON.parse(localStorage.getItem(CFG_KEY) || 'null'); } catch { return null; }
}
function tok() {
  try { return JSON.parse(localStorage.getItem(TOK_KEY) || 'null'); } catch { return null; }
}

/* ---------------------------------------------------------------------------
   回显抑制
   ---------------------------------------------------------------------------
   自己改的数据，服务端也会推回来一条。如果照单全收，就会出现
   「我在这台设备点了个勾，页面自己重绘一次」—— 看起来像闪了一下，
   还会把正在输入的内容冲掉。

   做法：每次自己写库时登记一个指纹（表+主键），5 秒内收到同表同主键的推送就跳过。
   为什么用 5 秒而不是 1 秒：手机弱网下写库到收到回推可能隔好几秒。
   为什么要按主键而不是按表：同一秒里可能既改了自己这条、又收到别人的改动，
   按表整表忽略会漏掉别人的那条。
--------------------------------------------------------------------------- */
const ECHO_MS = 5000;
const _echo = new Map();   // 'table:id' → 登记时间

function echoKey(table, id) { return table + ':' + (id == null ? '' : id); }

/** 自己写库前调一下，登记「这条是我改的」 */
export function markLocalWrite(table, id) {
  const now = Date.now();
  _echo.set(echoKey(table, id), now);
  /* 顺手清掉过期项，否则长期开着页面这个 Map 会一直涨 */
  if (_echo.size > 200) {
    for (const [k, t] of _echo) if (now - t > ECHO_MS) _echo.delete(k);
  }
}

function isEcho(table, id) {
  const t = _echo.get(echoKey(table, id));
  return !!t && Date.now() - t < ECHO_MS;
}

/* ---------------------------------------------------------------------------
   连接状态
   ---------------------------------------------------------------------------
   idle  还没开始（没配云、没登录）
   connecting 正在连
   live  连上了，收到 heartbeat 才算真的通
   error 断了，正在退避重连
--------------------------------------------------------------------------- */
const st = {
  status: 'idle',
  since: 0,
  tries: 0,
  ws: null,
  ref: 0,
  timers: {},
  lastBeat: 0,
  lastMsgAt: 0,
  tokAtJoin: '',
};

export function status() {
  return { status: st.status, since: st.since, tries: st.tries, lastMsgAt: st.lastMsgAt };
}

function setStatus(s) {
  if (st.status === s) return;
  st.status = s;
  st.since = Date.now();
  emit('wb:realtime-status', { status: s, tries: st.tries });
}

/* st.since 有两个用途：一是状态起始时间（给界面展示），
   二是"这条连接活了多久"（给 onclose 判断要不要清零重试次数）。
   后者要的是**连接建立时刻**，所以这里单独记一个字段，
   不去动 since —— 早先两个用途共用一个变量，结果心跳回执把 since 一刷，
   「连接活过 10 秒」的判断就永远不成立，退避一路涨到 30 秒。 */
function markOpen() { st.openAt = Date.now(); }

/* 只广播，不抛错：任何监听方出错都不该影响别的监听方 */
function emit(name, detail) {
  try { window.dispatchEvent(new CustomEvent(name, { detail })); } catch { }
}

/* ---------------------------------------------------------------------------
   协议细节
--------------------------------------------------------------------------- */

/* Realtime 的地址：https://xxx.supabase.co → wss://xxx.supabase.co/realtime/v1/websocket
   老项目有的挂在 /realtime/v1/websocket，新项目是 /realtime/v1/websocket?apikey=…
   vsn=1.0.0 是协议版本，写死就行（Realtime 兼容 1.0.0 很久了）。 */
function wsUrl(c, at) {
  const base = c.url.replace(/^http/, 'ws');
  const q = new URLSearchParams({ apikey: c.anon, vsn: '1.0.0' });
  return `${base}/realtime/v1/websocket?${q.toString()}`;
}

function send(obj) {
  const ws = st.ws;
  if (!ws || ws.readyState !== 1) return false;
  try { ws.send(JSON.stringify(obj)); return true; } catch { return false; }
}

function nextRef() { st.ref += 1; return String(st.ref); }

/* 停掉所有定时器。重连过程中要反复调，漏一个就会出现两条连接并存 */
function clearTimers() {
  for (const k of Object.keys(st.timers)) {
    try { clearInterval(st.timers[k]); } catch { }
    try { clearTimeout(st.timers[k]); } catch { }
    delete st.timers[k];
  }
}

function hardClose() {
  clearTimers();
  const ws = st.ws;
  st.ws = null;
  if (ws) {
    try { ws.onclose = null; ws.onerror = null; ws.onmessage = null; } catch { }
    try { ws.close(); } catch { }
  }
}

/* ---------------------------------------------------------------------------
   连上之后的动作
--------------------------------------------------------------------------- */

/* Phoenix 的规矩：加入频道前先发 phx_join。
   每条表一个 topic —— 这样某张表出问题（比如没加进发布）不会连累其他表。 */
function joinAll(at) {
  st.tokAtJoin = at;
  for (const table of REALTIME_TABLES) {
    send({
      topic: `realtime:public:${table}`,
      event: 'phx_join',
      payload: {
        /* config 里的 broadcast/postgres_changes 必须写全：
           少了 postgres_changes，服务端不会推任何行变更，而且不报错 */
        config: {
          broadcast: { self: false },
          presence: { key: '' },
          postgres_changes: [
            /* 不带 filter：一张表就一个用户的数据量（几十到几百行），
               在前端筛反而更省事；RLS 已经保证推不到别人的行。 */
            { event: '*', schema: 'public', table },
          ],
        },
        access_token: at,
      },
      ref: nextRef(),
    });
  }
}

/* 心跳：Realtime 靠 phx_heartbeat 判活，30 秒不回就断。
   这里 25 秒发一次，比它的超时短一点，避免"刚好卡在边界上"。
   同时拿它当健康检查：连续两次都发不出去（ws 不是 OPEN），直接重连。 */
const HEARTBEAT_MS = 25000;
const STALE_MS = 70000;   // 超过 70 秒什么都没收到，认为连接已经死了

function startHeartbeat() {
  clearTimers();
  st.timers.beat = setInterval(() => {
    const okSend = send({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: nextRef() });
    if (!okSend) { reconnect('心跳发不出去'); return; }
    if (st.lastMsgAt && Date.now() - st.lastMsgAt > STALE_MS) {
      reconnect('服务端长时间无响应');
    }
  }, HEARTBEAT_MS);
}

/* token 一小时过期。过期后 Realtime 连接不会主动断，但新推送会被拒。
   所以到期前主动换 token 并重连 —— 与其等它悄悄失效，不如自己重连一次。 */
function scheduleTokenRefresh() {
  const t = tok();
  if (!t || !t.expires_at) return;
  const ms = t.expires_at - Date.now() - 120000;   // 提前 2 分钟
  if (ms <= 0) return;
  st.timers.token = setTimeout(() => { reconnect('token 即将过期'); }, ms);
}

/* ---------------------------------------------------------------------------
   消息处理
--------------------------------------------------------------------------- */
function onMessage(ev) {
  st.lastMsgAt = Date.now();
  let msg;
  try { msg = JSON.parse(ev.data); } catch { return; }

  /* 服务端一次可能推一个数组（长连接批量下发） */
  const list = Array.isArray(msg) ? msg : [msg];
  for (const m of list) handleOne(m);
}

function handleOne(m) {
  if (!m || !m.event) return;

  switch (m.event) {
    /* 心跳回执：收到才算"真的通"。刚连上时 status 先给 live 会闪一下假绿灯 */
    case 'phx_reply':
      st.lastBeat = Date.now();
      if (st.status !== 'live') {
        st.tries = 0;
        setStatus('live');
      }
      return;

    /* 服务端主动关频道（比如没权限、表没加进发布）。
       这种情况重连也没用，先把话说清楚，别让它无限重试。 */
    case 'phx_error':
    case 'phx_close':
      /* 订阅被拒的典型原因：这张表没加到 supabase_realtime 里 */
      emit('wb:realtime-denied', { topic: m.topic });
      return;

    /* 真正的数据变更 */
    case 'postgres_changes':
      onRowChange(m);
      return;

    /* 订阅时的回执里带着"已为你订阅了哪几张表、有哪些列"，
       出错时用得上，平时不打扰用户 */
    case 'system':
      if (m.payload?.status === 'error') {
        emit('wb:realtime-denied', { topic: m.topic, message: m.payload?.message });
      }
      return;
    default:
      return;
  }
}

/* 行变更 → 广播 wb:remote
   payload 里是 { type: INSERT|UPDATE|DELETE, table, record, old_record }
   注意 Supabase 的 DELETE 只带主键（old_record），拿不到整行。 */
function onRowChange(m) {
  const p = m.payload || {};
  /* 从 topic 里抠表名：realtime:public:attendance_rows
     payload 里通常也带 table，但订阅被拒、或服务端版本不同的时候可能没有，
     两条路都留一手，否则一条推送认不出是哪张表，等于白收。 */
  const rowTable = String(m.topic || '').startsWith('realtime:public:')
    ? String(m.topic).slice('realtime:public:'.length)
    : (p.table || String(m.topic || '').split(':').pop());

  /* Supabase 的报文体是 {type, record, old_record}，
     但老版本 / 自建版可能是 {eventType, new, old}。两种都认。 */
  const type = String(p.type || p.eventType || 'UPDATE').toUpperCase();
  const rec = p.record || p.new || {};
  const old = p.old_record || p.old || null;
  const id = rec.id ?? old?.id;

  if (isEcho(rowTable, id)) return;   // 自己改的，不惊动界面

  emit('wb:remote', { table: rowTable, type, id, record: rec, old });
}

/* ---------------------------------------------------------------------------
   连接管理
--------------------------------------------------------------------------- */
let _want = false;   // 是否处于"应该连着"的状态（登录了、配置好了）

export function start() {
  _want = true;
  reconnect();
}

export function stop() {
  _want = false;
  hardClose();
  setStatus('idle');
}

/* 重连：指数退避 1s → 2s → 4s → 8s → 最多 30s。
   不无限快重试的原因是：Supabase 免费额度对连接数有上限，
   真断了（比如欠费）时疯狂重连只会让情况更糟。 */
function reconnect(reason) {
  if (!_want) return;
  hardClose();
  setStatus('error');
  st.tries += 1;
  /* 第 1 次失败后等 0 秒直接重来：这不是容忍坏网络，
     而是**我们自己的 bug 必须能被立刻复现**。
     真断了的时候后面几次退避会把节奏拉回正常。 */
  const wait = st.tries === 1 ? 0 : Math.min(30000, 1000 * Math.pow(2, Math.min(st.tries - 2, 5)));
  clearTimeout(st.timers.retry);
  st.timers.retry = setTimeout(() => { if (_want) connect(); }, wait);
  if (reason) console.info('[realtime] 重连原因：' + reason + '，' + wait + 'ms 后重试');
}

async function connect() {
  const c = cfg();
  const t = tok();
  if (!c || !t || !t.access_token) {
    /* 没配置云端、或没登录 —— 这不是错误，是没资格用。
       静默停在 idle，页面不该因此有任何提示。 */
    setStatus('idle');
    return;
  }

  setStatus('connecting');
  const at = t.access_token;
  let ws;
  try {
    ws = new WebSocket(wsUrl(c, at));
  } catch (e) {
    reconnect('建不起来连接：' + (e.message || e));
    return;
  }
  st.ws = ws;
  st.lastMsgAt = Date.now();
  st.lastBeat = 0;
  markOpen();

  ws.onopen = () => {
    joinAll(at);
    startHeartbeat();
    scheduleTokenRefresh();
    /* 不在这里设 live：要等第一个 phx_reply 回来才算通 */
  };

  ws.onmessage = onMessage;

  ws.onerror = () => {
    /* onerror 之后一定会 onclose，重连逻辑统一放在 onclose 里，
       否则一次断线会触发两轮重连 */
  };

  ws.onclose = () => {
    if (st.ws !== ws) return;      // 已经被新一轮连接替换掉了，忽略旧的回调
    /* 连接活过 10 秒才算"曾经通"，此时重连次数清零。
       否则网络好时每次断线都从第 1 次开始，退避形同虚设；
       反过来若连上就断（多半是配置错），次数会一路累积到最后退到 30 秒。 */
    if (Date.now() - (st.openAt || 0) > 10000) st.tries = 0;
    reconnect('连接关闭');
  };
}

/* 登录/退出后调用：登录了就（重新）连，退出了就停。
   放在这里而不是让调用方自己判断，是为了只有一个地方管这件事。 */
export function syncWithAuth() {
  const c = cfg();
  const t = tok();
  if (c && t && t.access_token) start();
  else stop();
}

/* 页面重新可见时检查一下：手机锁屏、切后台，浏览器会把 WebSocket 挂起，
   回来时连接看着在、其实已经死了。主动探一下，死了就重连。 */
try {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !_want) return;
    const ws = st.ws;
    if (!ws || ws.readyState !== 1) { reconnect('页面回到前台，连接已断'); return; }
    if (st.status === 'live' && Date.now() - st.lastBeat > STALE_MS) reconnect('页面回到前台，心跳超时');
  });
} catch { }
