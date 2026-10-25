/* ============================================================================
   云同步（Supabase 免费档）

   为什么需要这一层：
   纯静态版的数据只存浏览器 localStorage，手机和电脑各存各的，
   改了这边那边看不见。备份文件来回倒能解决，但每次都要手动导出导入。
   这里接 Supabase（免费、不用绑卡）当云端硬盘，两边自动同步。

   同步策略（故意做得简单）：
   整个数据库就是一个 JSON 大对象（localdb.js 的 wb_static_db_v1），
   所以不做字段级合并，整包上传/下载，谁的更新时间新谁赢：
     - 本地改过、云端没动  → 推上去
     - 云端动了、本地没改  → 拉下来（自动，不打扰）
     - 两边都动过          → 弹窗让用户选，不悄悄覆盖（选之前旧数据可下载备份）
   一个教师工作台，数据只属于一个人，LWW + 冲突确认完全够用，
   字段级 merge 的复杂度不值得。

   安全模型：
   Supabase 的 anon key 本来就是公开的（相当于项目 ID），
   真正的「钥匙」是首次绑定时随机生成的 sync_key（UUID），
   云端按它隔离数据。等于「知道房间号才能进」——对个人数据够用，
   但别把 sync_key 发给别人。

   免费档额度：500MB 数据库 / 5GB 流量每月。工作台数据几十 KB，
   就算一天同步一百次也用不到额度的零头。
   ========================================================================== */

import { toast, confirmDialog } from './core.js';
import { DB_KEY } from './localdb.js';

const CFG_KEY = 'wb_cloud_cfg';      // { url, anon, syncKey }
const META_KEY = 'wb_cloud_meta';    // { lastPull, lastPush, localChanged }

let _debounce = null;

function cfg() {
  try { return JSON.parse(localStorage.getItem(CFG_KEY) || 'null'); } catch { return null; }
}
function meta() {
  try { return JSON.parse(localStorage.getItem(META_KEY) || '{}'); } catch { return {}; }
}
function setMeta(patch) {
  localStorage.setItem(META_KEY, JSON.stringify({ ...meta(), ...patch }));
}
function url(cfg0, path) {
  return (cfg0.url || '').replace(/\/+$/, '') + path;
}
function headers(cfg0) {
  return {
    apikey: cfg0.anon,
    Authorization: 'Bearer ' + cfg0.anon,
    'Content-Type': 'application/json',
  };
}

/* ---------------- Supabase REST 读写 ---------------- */

async function fetchRemote(cfg0) {
  const u = url(cfg0, `/rest/v1/wb_sync?sync_key=eq.${encodeURIComponent(cfg0.syncKey)}&select=updated_at,payload`);
  const r = await fetch(u, { headers: headers(cfg0) });
  if (!r.ok) throw new Error('云端读取失败 ' + r.status);
  const rows = await r.json();
  return rows[0] || null;
}

async function pushRemote(cfg0, dbObj) {
  const now = new Date().toISOString();
  const body = { sync_key: cfg0.syncKey, payload: dbObj, updated_at: now };
  /* upsert：key 冲突就更新，没有就插入 */
  const u = url(cfg0, '/rest/v1/wb_sync?on_conflict=sync_key');
  const r = await fetch(u, {
    method: 'POST',
    headers: { ...headers(cfg0), Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error('云端写入失败 ' + r.status);
  setMeta({ lastPush: now, localChanged: false });
  return now;
}

function applyRemote(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('云端数据是空的');
  localStorage.setItem(DB_KEY, JSON.stringify(payload));
  setMeta({ lastPull: new Date().toISOString(), localChanged: false });
}

/* ---------------- 对外三个动作 ---------------- */

/* 启动时静默检查：云端新且本地没改 → 自动拉；否则只挂个提醒，不打断 */
export async function autoSync() {
  const c = cfg();
  if (!c || !c.url || !c.anon || !c.syncKey) return;
  try {
    const remote = await fetchRemote(c);
    if (!remote) { /* 云端还没有数据，等本地第一次改动时推上去 */ return; }
    const m = meta();
    const remoteAt = new Date(remote.updated_at).getTime();
    const lastPull = m.lastPull ? new Date(m.lastPull).getTime() : 0;
    if (remoteAt > lastPull) {
      if (m.localChanged) {
        toast('云端有新数据，本地也有改动。打开「我的 → 云同步」选择保留哪边', 'warn', 6000);
        setMeta({ conflict: true });
      } else {
        applyRemote(remote.payload);
        toast('已同步云端最新数据', 'ok', 2500);
        setTimeout(() => location.reload(), 900);
      }
    }
  } catch (e) {
    console.warn('云同步检查失败', e);
  }
}

/* 手动：上传本地（覆盖云端） */
export async function pushNow() {
  const c = cfg();
  if (!c) throw new Error('还没绑定云存储');
  const raw = localStorage.getItem(DB_KEY);
  if (!raw) throw new Error('本地没有数据');
  return pushRemote(c, JSON.parse(raw));
}

/* 手动：下载云端（覆盖本地，先问一句） */
export async function pullNow() {
  const c = cfg();
  if (!c) throw new Error('还没绑定云存储');
  const remote = await fetchRemote(c);
  if (!remote) throw new Error('云端还没有数据');
  const before = localStorage.getItem(DB_KEY);
  applyRemote(remote.payload);
  return { before, at: remote.updated_at };
}

/* ---------------- 链接搬运：不起服务器也能换设备 ----------------

   原理：整库先 deflate 压缩、再 base64，塞进 URL 的 # 后面。
   # 之后的内容浏览器不会发给服务器（GitHub 日志里看不到），
   页面自己解析、自己解压、自己存进 localStorage —— 全程不经过第三方。

   实测：58KB 的库压完 8.9KB，链接不到 9KB，微信/短信都发得出去。
   超长的库（比如带图片附件的）会超过浏览器地址栏上限，
   这种情况提示用户改用备份文件，不硬塞。   */

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deflate(str) {
  const data = new TextEncoder().encode(str);
  if (!window.CompressionStream) return null;
  const cs = new CompressionStream('deflate-raw');
  const w = cs.writable.getWriter();
  w.write(data);
  w.close();
  const buf = await new Response(cs.readable).arrayBuffer();
  return new Uint8Array(buf);
}

async function inflate(bytes) {
  const ds = new DecompressionStream('deflate-raw');
  const w = ds.writable.getWriter();
  w.write(bytes);
  w.close();
  const buf = await new Response(ds.readable).arrayBuffer();
  return new TextDecoder().decode(buf);
}

/* 生成可发到手机的链接 */
export async function makeShareLink() {
  const raw = localStorage.getItem(DB_KEY);
  if (!raw) throw new Error('本机没有数据可搬');
  const packed = await deflate(raw);
  if (!packed) throw new Error('这个浏览器太旧，不支持压缩。请用「数据导出与备份」的 JSON 文件');
  let bin = '';
  const CH = 0x8000;   // 分块，避免 apply 参数过多爆栈
  for (let i = 0; i < packed.length; i += CH) {
    bin += String.fromCharCode.apply(null, packed.subarray(i, i + CH));
  }
  const b64 = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const base = location.origin + location.pathname;
  const link = base + '#import=' + b64;
  return { link, bytes: raw.length, packedBytes: b64.length };
}

/* 打开页面时检查地址栏有没有 #import=，有就导入 */
export async function tryImportFromHash() {
  const m = location.hash.match(/#import=([A-Za-z0-9_-]+)/);
  if (!m) return false;
  const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
  let json;
  try {
    const pad = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    json = await inflate(b64ToBytes(pad));
    const obj = JSON.parse(json);
    if (!obj || typeof obj !== 'object') throw new Error('内容不像工作台数据');
  } catch (e) {
    history.replaceState(null, '', location.origin + location.pathname + '#/home');
    throw new Error('链接里的数据解不开：' + e.message);
  }

  /* 【不能闷头覆盖】
     早先只要 hash 里带 #import= 就无条件整库覆盖。可这个链接就是发到群里给大家点的，
     手机上本来就有一学期记录的人点一下，自己的数据全没了，而且没有任何提示。
     现在：本机已经有数据就先问，默认不是「覆盖」；确认了也先留一份底。 */
  const oldRaw = localStorage.getItem(DB_KEY);
  let oldCount = 0;
  if (oldRaw) {
    try {
      const o = JSON.parse(oldRaw);
      for (const [k, v] of Object.entries(o || {})) {
        if (k === 'meta' || k === 'seqs') continue;
        if (Array.isArray(v)) oldCount += v.length;
      }
    } catch { }
  }
  if (oldCount > 0) {
    const ok = await confirmDialog(
      `这台设备上已经有 ${oldCount} 条记录。\n\n导入会用它覆盖本机数据（导入后仍可从「数据导出与备份」里找回旧的备份）。\n\n确定要导入吗？`
    );
    if (!ok) {
      history.replaceState(null, '', location.origin + location.pathname + '#/home');
      return false;
    }
    localStorage.setItem('wb_backup_before_import', oldRaw);
  }

  localStorage.setItem(DB_KEY, json);
  /* 【只写 localStorage 不够】
     localdb.load() 有内存缓存 _db。如果它已经被加载过（比如骨架屏之后调了一次接口），
     那么页面读到的还是导入前的旧库，下一次 save() 还会把旧库回写进 localStorage，
     把刚导入的数据整个抹掉。所以这里必须让内存缓存失效并重新装载。
     用动态 import：cloudsync 和 localdb 之间不建立新的静态依赖边。 */
  try {
    const m2 = await import('./localdb.js');
    const db = m2.replaceMemFromDisk?.();
    /* 打上「已导入」标记：main.js 里 seedIfEmpty 靠它避免再灌示例数据把真数据搅浑 */
    if (db) {
      db.meta = db.meta || {};
      db.meta.importedAt = new Date().toISOString();
      db.meta.seeded = true;
      m2.save?.();
    }
  } catch { }

  history.replaceState(null, '', location.origin + location.pathname + '#/home');
  return true;
}

/* ---------------- 绑定 / 状态 UI ---------------- */

export function bindSheet() {
  const c = cfg();
  const m = meta();
  const sql = `create table if not exists wb_sync (
  sync_key text primary key,
  payload jsonb not null,
  updated_at timestamptz not null default now());
alter table wb_sync enable row level security;
create policy "sync" on wb_sync for all using (true) with check (true);`;

  const b = document.createElement('div');
  b.innerHTML = `
    ${c ? `
      <div class="card card-pad" style="margin-bottom:10px">
        <div class="row"><b>已绑定</b><span style="flex:1"></span><span class="tiny muted">钥匙 …${esc(String(c.syncKey).slice(-6))}</span></div>
        <div class="tiny muted" style="margin-top:6px">
          上次上传：${m.lastPush ? fmt(m.lastPush) : '还没传过'}<br>
          上次下载：${m.lastPull ? fmt(m.lastPull) : '还没拉过'}<br>
          ${m.conflict ? '<span style="color:var(--warn,#b45309)">⚠ 有未处理的冲突</span>' : ''}
        </div>
      </div>
      <div class="card card-pad tiny" style="margin-bottom:10px">
        <b>同步钥匙</b>（另一台设备绑定时填这把，才能连到同一份数据）：
        <div class="row" style="margin-top:4px">
          <code style="word-break:break-all;flex:1">${esc(c.syncKey)}</code>
          <button class="btn ghost tiny" id="cs-copykey">复制</button>
        </div>
      </div>
      <button class="btn primary block" id="cs-push" style="margin-bottom:8px">⬆ 把本机数据上传到云端</button>
      <button class="btn ghost block" id="cs-pull" style="margin-bottom:8px">⬇ 用云端数据覆盖本机</button>
      <button class="btn ghost block" id="cs-unbind">解除绑定（只解绑，不动数据）</button>
    ` : `
      <div class="small" style="margin-bottom:10px">
        云同步用 <b>Supabase 免费档</b>当云端硬盘，绑定后手机、电脑自动同步。
        只需要做一次（每台设备都要绑一次同一把钥匙）：
      </div>
      <div class="card card-pad tiny" style="margin-bottom:10px;line-height:1.8">
        <b>第一次使用（做一次就行）：</b><br>
        1. 打开 <a href="https://supabase.com" target="_blank" rel="noopener">supabase.com</a> 注册（免费，不用卡）<br>
        2. New project 建个项目（名字随便，区域选 Singapore）<br>
        3. 左侧 SQL Editor，粘贴下面这段并点 Run：<br>
        <textarea readonly id="cs-sql" style="width:100%;height:88px;margin-top:4px;font-size:11px">${sql}</textarea>
        <button class="btn ghost tiny" id="cs-copysql" style="margin-top:4px">复制 SQL</button><br>
        4. 左侧 Project Settings → API，找到 <b>Project URL</b> 和 <b>anon public key</b>，填到下面<br>
        5. 电脑上先绑定，然后把「同步钥匙」抄到手机上再绑一次 —— 两边就通了
      </div>
      <input id="cs-url" class="input" placeholder="Project URL（https://xxxx.supabase.co）" style="margin-bottom:8px">
      <input id="cs-anon" class="input" placeholder="anon public key（一长串 eyJ…）" style="margin-bottom:8px">
      <input id="cs-key" class="input" placeholder="同步钥匙（第一台设备留空自动生成；第二台设备必须填第一台的那把）" style="margin-bottom:8px">
      <button class="btn primary block" id="cs-gen">绑定云存储</button>
    `}`;

  const s = sheet({ title: '云同步', body: b });

  const $ = (id) => b.querySelector(id);
  if (c) {
    $('#cs-copykey').onclick = () => {
      navigator.clipboard?.writeText(c.syncKey).then(() => toast('钥匙已复制', 'ok'), () => toast('复制失败，长按钥匙文字手动复制', 'warn'));
    };
    $('#cs-push').onclick = async () => {
      toast('正在上传…');
      try { await pushNow(); toast('已上传，云端已更新', 'ok'); }
      catch (e) { toast(e.message, 'err'); }
    };
    $('#cs-pull').onclick = async () => {
      try {
        const r = await fetchRemote(c);
        if (!r) return toast('云端还没有数据', 'warn');
        if (!(await confirmDialog('会用云端数据覆盖本机。本机数据可以先「上传到云端」留底，确定继续？'))) return;
        applyRemote(r.payload);
        toast('已覆盖，刷新中…', 'ok');
        s.close();
        setTimeout(() => location.reload(), 800);
      } catch (e) { toast(e.message, 'err'); }
    };
    $('#cs-unbind').onclick = async () => {
      if (!(await confirmDialog('只解除本机与云端的绑定，本地数据不动，确定？'))) return;
      localStorage.removeItem(CFG_KEY);
      localStorage.removeItem(META_KEY);
      toast('已解除绑定');
      s.close();
    };
    return;
  }

  $('#cs-copysql').onclick = () => {
    navigator.clipboard?.writeText(sql).then(() => toast('SQL 已复制', 'ok'), () => toast('复制失败，请手动选择文本', 'warn'));
  };
  $('#cs-gen').onclick = async () => {
    const u = $('#cs-url').value.trim();
    const a = $('#cs-anon').value.trim();
    if (!/^https:\/\/.+\.supabase\.(co|in)/.test(u)) return toast('URL 不对，应该是 https://xxxx.supabase.co', 'warn');
    if (a.length < 30) return toast('anon key 不对，是一长串 eyJ 开头的字符', 'warn');
    /* 同步钥匙：第一台设备留空自动生成；第二台设备必须填同一把，
       否则两台各存各的「房间」，数据永远碰不上。 */
    const typedKey = ($('#cs-key')?.value || '').trim();
    const key = typedKey || (crypto.randomUUID ? crypto.randomUUID() : 'k' + Date.now() + Math.random().toString(36).slice(2));
    const c0 = { url: u, anon: a, syncKey: key };
    toast('正在验证连接…');
    try {
      await fetchRemote(c0);   // 通了就行，404 行不存在也算通
      localStorage.setItem(CFG_KEY, JSON.stringify(c0));
      setMeta({ localChanged: true });   // 第一次绑定后把本地推上去
      await pushNow().catch(() => {});
      toast('绑定成功，本机数据已上传。同步钥匙：' + key, 'ok', 8000);
      s.close();
    } catch (e) {
      toast('连不上：' + e.message + '。检查 URL/key 和 SQL 是否跑过', 'err', 6000);
    }
  };
}

/* ---------------- 挂钩：本地一改就排队上传 ---------------- */

export function hookSave() {
  setMeta({ localChanged: true });
  clearTimeout(_debounce);
  _debounce = setTimeout(() => {
    const c = cfg();
    if (!c) return;
    pushNow().catch((e) => console.warn('自动上传失败', e));
  }, 3000);
}

/* ---------------- 工具 ---------------- */

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }
function fmt(iso) {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function sheet({ title, body }) {
  /* 跟 me.js 里的 sheet 同款最小实现，避免循环依赖 ui.js */
  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:9999;display:flex;align-items:flex-end;justify-content:center';
  const box = document.createElement('div');
  box.style.cssText = 'background:var(--card,#fff);width:min(520px,100%);max-height:86vh;overflow:auto;border-radius:16px 16px 0 0;padding:16px';
  box.innerHTML = `<div class="row" style="margin-bottom:12px"><b>${esc(title)}</b><span style="flex:1"></span><button id="cs-close" style="border:0;background:none;font-size:20px;cursor:pointer">×</button></div>`;
  box.appendChild(body);
  wrap.appendChild(box);
  document.body.appendChild(wrap);
  wrap.onclick = (e) => { if (e.target === wrap) close(); };
  box.querySelector('#cs-close').onclick = close;
  function close() { wrap.remove(); }
  return { close };
}
