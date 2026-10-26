/* ============================================================================
   登录 / 云同步 界面

   【这一层解决的问题】
   以前「云同步」是：生成一把密钥 → 手动点上传 / 下载。
   换台设备要重新输一把 32 位的密钥，改完还得记得点上传。
   那不是云端，那是「带手动备份按钮的单机软件」。

   现在是：输一次邮箱密码 → 数据就在云上 → 打开网址就在。

   【首次使用只有一步】
   教师在 Supabase 后台建好自己的账号后，第一次打开会看到「连接云端」，
   填邮箱 + 密码即可。地址和 anon key 会写在这个文件顶部（部署时已填好），
   教师不用去后台复制任何东西。

   【为什么还要保留旧的手动同步】
   旧数据还在 localStorage 里（29 张表）。这一版只把「课时」搬上云，
   其余表仍是本地。所以「数据导出与备份」和「搬到另一台设备」保留不动，
   等所有表都搬完再统一下线。贸然删掉，教师的旧数据就真的拿不出来了。
   ========================================================================== */

import { toast, el, esc, sheet, confirmDialog } from './core.js';
import { icon } from './ui.js';
import * as cloud from './cloud.js';
import { migrateLessons, previewMigration, migrateInvigilations, migrateAttendance } from './migrate.js';

/* ---------------------------------------------------------------------------
   ★★★ 部署前要填这两个值 ★★★
   Supabase 后台 → Settings → API：
     Project URL      → SUPA_URL
     anon / publishable key → SUPA_ANON
   这两个都是「公开信息」，写进前端不丢人（它没有读取权限，
   真正管权限的是 RLS 和登录账号）。但 URL 填错就整站连不上，
   所以这里留一个显眼的注释，日后换项目别漏改。
   --------------------------------------------------------------------------- */
/* 内置的云端地址与 key 放在 cloud.js 里（见那边的注释：谁先加载都要能用）。
   这里只是取过来继续用，不再各存一份 —— 两份地址最容易改了一处忘了另一处。 */
const SUPA_URL = cloud.BUILTIN_URL;
const SUPA_ANON = cloud.BUILTIN_ANON;

/* 把内置配置写进 localStorage，cloud.js 只认 localStorage 里的，
   这样「换一个项目」只要改上面两行，不需要用户做任何事。

   【故意不覆盖的情况】地址里带了 ?supa=<地址>。
   这是留给测试用的口子：本地起一个假 Supabase，靠它把前端指过去。
   正常访问（没有这个参数）永远用上面的生产地址，
   所以用户手里残留的旧配置、别人给的错误地址，都会被强制纠正回来。 */
function ensureCfg() {
  /* 纠正与 ?supa= 的处理都挪到 cloud.cfg() 里了 ——
     那里是唯一的入口，所有模块读到的配置一定是同一份。 */
  return cloud.cfg();
}

/* 是否已经真的连上云端并能读写（登录 + 表已建好） */
export function cloudOn() {
  ensureCfg();
  return !!cloud.session();
}

/* ============================================================================
   换设备靠「带钥匙的网址」自动登录

   【为什么不能真的做到「任何设备都免密」】
   浏览器把登录状态存在自己的 localStorage 里，这块空间不跨设备、不跨浏览器
   —— 电脑上的 Chrome 和手机上的 Safari 是两个互不相通的世界。
   这是浏览器的安全模型决定的，不是代码没写对。任何纯前端应用都做不到
   「换个设备自动就登录了」，除非在超链接里带上凭证。

   【所以这里的做法】
   在已登录的设备上生成一个一次性链接（#k=<令牌>）。
   复制到手机打开 → 自动登录 → 15 分钟内有效、只能换一次。
   手机此时拿到的 refresh_token 由 Supabase 默认永久有效，
   于是这台手机以后就也不用再输了。

   为什么不直接把 refresh_token 放进链接：
   它长期有效，一旦被转发（发错群、截屏、聊天记录被别人翻到），
   对方可以长期读你的数据。一次性、短效、换完即废，风险可控得多。
   ========================================================================== */

/* 生成换设备链接：用 refresh_token 换一个一次性 token hash */
export async function makeDeviceLink() {
  const c = cloud.cfg();
  const sess = cloud.session();
  if (!c || !sess) throw new Error('请先登录');

  const rt = cloud.refreshToken();
  if (!rt) throw new Error('本机登录状态不完整，请退出后重新登录一次');

  const r = await fetch(c.url + '/auth/v1/token?grant_type=refresh_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: c.anon },
    body: JSON.stringify({ refresh_token: rt }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) {
    throw new Error(j.error_description || j.msg || '生成失败，请重新登录后再试');
  }
  /* 这一步会让本机的 refresh_token 也轮换掉，同步存回去，否则本机掉线 */
  if (j.refresh_token) cloud.adoptTokens(j);

  const th = await fetch(c.url + '/auth/v1/user/token_hash', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: c.anon, Authorization: 'Bearer ' + j.access_token },
    body: '{}',
  });
  const tj = await th.json().catch(() => ({}));
  if (!th.ok || !tj.token_hash) {
    throw new Error(tj.msg || tj.message || '生成一次性凭证失败');
  }

  /* 拼链接要连「查询串」一起带上。
     线上是 /my-workbench/ 这种目录地址，但本地/预览常见 /index.html，
     只取 origin+pathname 会把 ?supa=… 这类参数丢掉，
     在测试环境和多参数部署下指向就错了。 */
  const base = location.origin + location.pathname + location.search;
  return `${base}#k=${encodeURIComponent(tj.token_hash)}&t=${encodeURIComponent(j.access_token)}`;
}

/* 打开带 #k= 的链接时自动登录。成功返回 true */
export async function autoLoginFromUrl() {
  const m = /[#&]k=([^&]+)/.exec(location.hash || '');
  if (!m) return false;

  ensureCfg();
  const hash = decodeURIComponent(m[1]);

  /* 不论成败，先把 #k= 从地址栏抹掉：
     否则用户刷新页面会再试一次（而它已经失效了），报错更莫名其妙。
     同时也避免这个链接被存在浏览器历史里、被截图分享。 */
  try {
    history.replaceState(null, '', location.pathname + location.search + '#home');
  } catch { }

  const c = cloud.cfg();
  try {
    const r = await fetch(c.url + '/auth/v1/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: c.anon },
      body: JSON.stringify({ token_hash: hash, type: 'magiclink' }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) {
      toast('这个登录链接已失效（一次性，15 分钟内有效）。请在本机正常登录一次。', 'warn', 9000);
      return false;
    }
    cloud.adoptTokens(j);

    /* 【关键一步，漏了就白登】本机账号也要"登录"一次。
       工作台自己的登录（账号 + 密码）和云端登录是两套：
       云端的 token 只管能不能读写 Supabase；
       页面要不要显示"登录页"看的是 state.user。
       以前只做了前半段，结果手机上打开链接后 token 拿到了，
       界面却还停在登录页 —— 用户会觉得"根本没登进去"，然后再手输一次。
       这里直接用服务端给的邮箱号建/登本机账号，两边一次对齐。 */
    try {
      const { api } = await import('./core.js');
      const local = await api.post('/auth/login-cloud', { email: j.user?.email || '', uid: j.user?.id || '' }, { silent: true });
      if (local?.user) {
        const ui = await import('./ui.js');
        ui.setUser(local.user);
      }
    } catch (e) {
      /* 本机账号对齐失败不影响云端登录本身，只是首屏还要再登一次本机账号 */
      console.warn('本机账号对齐失败', e);
    }

    toast('已在这台设备上登录', 'ok');
    return true;
  } catch (e) {
    toast('自动登录失败：' + (e.message || e), 'err', 8000);
    return false;
  }
}

/* ============================================================================
   登录弹层
   ========================================================================== */

export function loginSheet(opts = {}) {
  ensureCfg();
  const s = cloud.session();

  /* 已登录 → 显示账号状态 + 退出 */
  if (s && !opts.forceForm) return accountSheet();

  const b = el(`<div class="sheet-body">
    <div class="cl-hero">
      <div class="cl-ico">${icon('cloud', 26)}</div>
      <div>
        <div class="bold">登录后，数据跟着账号走</div>
        <div class="tiny muted" style="margin-top:3px">
          手机、平板、电脑打开同一个网址，看到的是同一份数据。改完就存到云上，不用点上传。
        </div>
      </div>
    </div>

    <div class="field"><label class="field-label">邮箱</label>
      <input class="input" id="cl-mail" type="email" inputmode="email" autocomplete="username"
        placeholder="邮箱，比如 name@qq.com">
      <div class="tiny muted" id="cl-hint" style="margin-top:5px;display:none">
        这是<b>邮箱</b>不是手机号 —— Supabase 只认邮箱格式，填手机号会提示「密码不对」。
      </div>
    </div>

    <div class="field"><label class="field-label">密码</label>
      <input class="input" id="cl-pwd" type="password" autocomplete="current-password" placeholder="密码"></div>

    <div class="tiny" style="margin-top:2px;color:var(--muted);line-height:1.6">
      这台设备登录一次，以后打开就不用再输了。
    </div>

    <button class="btn primary block" id="cl-go" style="justify-content:center;margin-top:14px">
      登录
    </button>

    <div class="tiny muted" id="cl-msg" style="margin-top:12px;min-height:19px;text-align:center"></div>

    <div class="cl-tip">
      <b>没有账号？</b> 这一步只做一次。
      打开 Supabase 后台 → Authentication → Users → Add user，
      填你的邮箱和一个密码（记得勾上自动确认）。以后就用它登录。
    </div>

    ${cloud.cfg() ? `<button class="btn ghost block" id="cl-adv" style="margin-top:8px;justify-content:center;font-size:13px">换一个 Supabase 项目</button>` : ''}
  </div>`);

  const sh = sheet({ title: '登录云同步', body: b });
  const mail = b.querySelector('#cl-mail');
  const pwd = b.querySelector('#cl-pwd');
  const go = b.querySelector('#cl-go');
  const msg = b.querySelector('#cl-msg');

  /* 记住上次用的邮箱，省得每次重打 */
  try { mail.value = localStorage.getItem('wb_last_mail') || ''; } catch { }

  /* 手机号一眼看穿：边输边提示，不用等到点了登录才挨一句「密码不对」 */
  const hint = b.querySelector('#cl-hint');
  const checkMail = () => {
    hint.style.display = cloud.looksLikePhone(mail.value) ? 'block' : 'none';
  };
  mail.oninput = checkMail;
  checkMail();

  const say = (t, kind = 'muted') => {
    msg.textContent = t;
    msg.style.color = kind === 'err' ? 'var(--red)' : kind === 'ok' ? 'var(--green, var(--text))' : 'var(--muted)';
  };

  async function submit() {
    const e = (mail.value || '').trim();
    const p = pwd.value || '';
    if (!e) return say('请填邮箱', 'err');
    if (!p) return say('请填密码', 'err');
    go.disabled = true;
    go.textContent = '登录中…';
    say('');
    try {
      const s2 = await cloud.login(e, p);
      try { localStorage.setItem('wb_last_mail', e); } catch { }
      /* 告诉实时同步模块：登录状态变了，该建连接了。
         main.js 只在这个事件上挂了一次，不会有重复订阅。 */
      try { window.dispatchEvent(new Event('wb:auth-changed')); } catch { }
      say('登录成功', 'ok');
      /* 登录后立刻探一下课时表能不能读，把「表没建 / 权限没配」这类问题
         在登录这一刻就说清楚，而不是等用户点进课时页看到一个报错 */
      try {
        await cloud.listLessons({});
        say('登录成功，云端可读写', 'ok');
      } catch (err) {
        say('登录成功，但云端还没准备好：' + (err.message || err), 'err');
        toast('登录成功。云端数据库还差一步：' + (err.message || err), 'warn', 10000);
      }
      setTimeout(() => { sh.close(); opts.onDone && opts.onDone(s2); }, 700);
    } catch (err) {
      say(err.message || String(err), 'err');
      go.disabled = false;
      go.textContent = '登录';
    }
  }

  go.onclick = submit;
  pwd.onkeydown = (ev) => { if (ev.key === 'Enter') submit(); };
  mail.onkeydown = (ev) => { if (ev.key === 'Enter') pwd.focus(); };

  const adv = b.querySelector('#cl-adv');
  if (adv) adv.onclick = () => {
    const u = prompt('Supabase Project URL', cloud.cfg()?.url || '');
    if (!u) return;
    const a = prompt('anon / publishable key', cloud.cfg()?.anon || '');
    if (!a) return;
    cloud.saveCfg(u, a);
    toast('已切换项目，请重新登录', 'ok');
    sh.close();
    setTimeout(() => loginSheet(opts), 200);
  };

  setTimeout(() => { (mail.value ? pwd : mail).focus(); }, 250);
}

/* 已登录时点「云同步」看到的页面 */
function accountSheet() {
  const s = cloud.session();
  const b = el(`<div class="sheet-body">
    <div class="cl-hero">
      <div class="cl-ico ok">${icon('shield', 24)}</div>
      <div>
        <div class="bold">已连上云端</div>
        <div class="tiny muted" style="margin-top:3px">${esc(s.email || '')}</div>
      </div>
    </div>

    <div class="cl-list">
      <div class="cl-row"><span>课时数据</span><b id="cl-n" class="muted">检查中…</b></div>
      <div class="cl-row"><span>存哪</span><b>Supabase（云端数据库）</b></div>
      <div class="cl-row"><span>谁能看</span><b>只有你这个账号</b></div>
      <div class="cl-row"><span>这台设备的登录</span><b>会一直记住</b></div>
    </div>

    <div class="tiny muted" style="margin-top:10px;line-height:1.65">
      课时现在直接存在云上，改完即保存，不需要再点上传。
      这台设备关掉浏览器、关机、明天再打开，都不用重新输密码。
      其余模块（考勤、监考、值日等）这一步还没搬，仍存在本机。
    </div>

    <button class="btn ghost block" id="cl-dev" style="margin-top:14px;justify-content:center">
      在手机 / 另一台电脑上登录
    </button>

    <button class="btn ghost block" id="cl-mig" style="margin-top:8px;justify-content:center">
      把本机以前的课时搬到云端
    </button>

    <button class="btn ghost block" id="cl-out" style="margin-top:8px;justify-content:center;color:var(--red)">
      退出登录
    </button>
  </div>`);

  const sh = sheet({ title: '云同步', body: b });
  const n = b.querySelector('#cl-n');

  cloud.listLessons({}).then((rows) => {
    n.textContent = `${rows.length} 条已同步`;
    n.classList.remove('muted');
  }).catch((e) => {
    n.textContent = '读不到';
    n.style.color = 'var(--red)';
    toast('云端读不到：' + (e.message || e), 'err', 9000);
  });

  b.querySelector('#cl-dev').onclick = () => { sh.close(); setTimeout(deviceSheet, 200); };
  b.querySelector('#cl-mig').onclick = () => { sh.close(); setTimeout(migrateSheet, 200); };

  b.querySelector('#cl-out').onclick = async () => {
    if (!(await confirmDialog('退出后课时数据在云端保留，重新登录还能看到。确定退出？'))) return;
    await cloud.logout();
    /* 退出时把 WebSocket 也断掉。不断的话这条连接还挂着你之前的 token，
       页面看着是"已退出"，后台却还在收推送 —— 这在公用电脑上很难解释。 */
    try { window.dispatchEvent(new Event('wb:auth-changed')); } catch { }
    toast('已退出登录', 'ok');
    sh.close();
  };
}

/* ============================================================================
   在另一台设备上登录（一次性链接）
   ========================================================================== */

async function deviceSheet() {
  const b = el(`<div class="sheet-body">
    <div class="cl-hero">
      <div class="cl-ico">${icon('phone', 24)}</div>
      <div>
        <div class="bold">在另一台设备上登录</div>
        <div class="tiny muted" style="margin-top:3px">生成一个一次性链接，在手机上打开就自动登录</div>
      </div>
    </div>
    <div id="dv-body"><div class="small muted" style="padding:10px 0">生成中…</div></div>
  </div>`);
  const sh = sheet({ title: '换设备登录', body: b });
  const body = b.querySelector('#dv-body');

  let url;
  try {
    url = await makeDeviceLink();
  } catch (e) {
    body.innerHTML = `<div class="small" style="color:var(--red)">${esc(e.message || e)}</div>`;
    return;
  }

  body.innerHTML = `
    <div class="cl-tip">
      <b>怎么用：</b>把这个链接发到微信「文件传输助手」，在手机上点开 →
      自动登录，以后这台手机也不用再输密码。
    </div>

    <input class="input" id="dv-url" readonly value="${esc(url)}"
      style="margin-top:10px;font-size:12px;font-family:ui-monospace,monospace">

    <div class="row" style="gap:8px;margin-top:10px">
      <button class="btn primary" id="dv-copy" style="flex:1;justify-content:center">复制链接</button>
      <button class="btn ghost" id="dv-share" style="flex:1;justify-content:center">系统分享</button>
    </div>

    <div class="tiny muted" style="margin-top:12px;line-height:1.7">
      <b>这条链接等于你的钥匙</b>，谁拿到都能登进你的账号：<br>
      · 只能用一次，且 <b>15 分钟内</b>有效<br>
      · 用掉或过期就自动作废<br>
      · 别发到群里、别截图发人<br>
      · 万一发错了，去「退出登录」再重新登录一次，旧链接立刻失效
    </div>
  `;

  const inp = body.querySelector('#dv-url');
  body.querySelector('#dv-copy').onclick = async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast('已复制，去手机粘贴打开', 'ok');
    } catch {
      inp.select();
      toast('已选中，长按复制', 'ok');
    }
  };

  const shBtn = body.querySelector('#dv-share');
  if (!navigator.share) {
    shBtn.style.opacity = '.5';
  }
  shBtn.onclick = async () => {
    try {
      await navigator.share({ title: '教师工作台', text: '点开就自动登录', url });
    } catch { }
  };

  /* 关掉面板时清掉输入框里的链接，减少被旁人看到的机会。
     注意 sheet 的 onClose 是构造时捕获的，事后赋值不生效，
     所以这里直接包一层 close。 */
  const rawClose = sh.close;
  sh.close = () => { try { inp.value = ''; } catch { } rawClose(); };
}

/* ============================================================================
   数据迁移：本机旧课时 → 云端
   设计原则：**先给用户看，再动手**。
   迁移是有风险的操作（重复、错乱都会影响对账），所以这里不让它一键闷头跑：
   先把「本机多少条、哪些是空的、有多少能认出日期」摆出来，
   用户点确认才真正开始，跑完给出逐条结果。
   ========================================================================== */

async function migrateSheet() {
  const b = el(`<div class="sheet-body">
    <div class="cl-hero">
      <div class="cl-ico">${icon('upload', 24)}</div>
      <div>
        <div class="bold">把本机数据搬到云端</div>
        <div class="tiny muted" style="margin-top:3px" id="mg-sub">先检查一下本机数据…</div>
      </div>
    </div>
    <div id="mg-body"><div class="small muted" style="padding:10px 0">读取中…</div></div>
  </div>`);
  const sh = sheet({ title: '数据迁移', body: b });
  const body = b.querySelector('#mg-body');
  const sub = b.querySelector('#mg-sub');

  /* 三类数据一起体检：课时、监考、考勤。
     一张表一张表搬太累，老师只想点一次。 */
  let lessons = null; let invig = 0; let attTables = 0; let attRows = 0;
  try {
    lessons = await previewMigration();
    const m = await import('./localdb.js');
    const db = m.load() || {};
    invig = (db.invigilations || []).filter((r) => !r.deleted_at).length;
    const liveTables = (db.attendance_tables || []).filter((r) => !r.deleted_at);
    attTables = liveTables.length;
    const ids = new Set(liveTables.map((t) => String(t.id)));
    attRows = (db.attendance_rows || []).filter((r) => !r.deleted_at && ids.has(String(r.table_id))).length;
  } catch (e) {
    body.innerHTML = `<div class="small" style="color:var(--red)">读不到本机数据：${esc(e.message || e)}</div>`;
    return;
  }

  sub.textContent = '检查完毕，请确认';

  const anyData = (lessons?.realRows || 0) + invig + attTables > 0;
  if (!anyData) {
    body.innerHTML = `<div class="card card-pad small">本机没有需要迁移的记录。</div>`;
    return;
  }

  const warn = [];
  if (lessons?.badDate) warn.push(`${lessons.badDate} 条课时的日期认不出来，会存成空日期（记录本身不会丢）`);
  if (lessons?.emptyRows) warn.push(`${lessons.emptyRows} 条空课时记录（没日期也没内容），会自动跳过`);

  body.innerHTML = `
    <div class="cl-list">
      <div class="cl-row"><span>课时</span><b>${lessons?.realRows || 0} 条</b></div>
      <div class="cl-row"><span>监考</span><b>${invig} 场</b></div>
      <div class="cl-row"><span>考勤表</span><b>${attTables} 张（${attRows} 人次）</b></div>
    </div>

    ${warn.length ? `<div class="cl-tip">
      <b>需要注意：</b><br>${warn.map((w) => '· ' + esc(w)).join('<br>')}
    </div>` : ''}

    <div class="cl-tip" style="margin-top:10px">
      <b>放心几点：</b><br>
      · 只往云端<b>复制</b>，本机数据一条都不删<br>
      · 已经传过的会自动跳过，重复点不会重复插<br>
      · 中途断了可以再点一次，接着传<br>
      · 考勤表的明细会挂到对应的表下面，不会串行
    </div>

    <button class="btn primary block" id="mg-go" style="margin-top:14px;justify-content:center">
      开始迁移
    </button>
    <div id="mg-prog" class="tiny muted" style="margin-top:10px;text-align:center;min-height:18px"></div>
  `;

  const go = body.querySelector('#mg-go');
  const prog = body.querySelector('#mg-prog');

  const showProg = (text, pct) => {
    prog.innerHTML = `${esc(text)}<div style="height:4px;border-radius:2px;background:var(--line,#e6e8ec);margin-top:6px;overflow:hidden">
      <div style="height:100%;width:${pct}%;background:var(--blue,#2563eb);transition:width .2s"></div></div>`;
  };

  go.onclick = async () => {
    go.disabled = true;
    go.textContent = '迁移中…';
    try {
      /* 三块依次跑。任何一块抛错都记下来继续跑下一块 ——
         不能因为监考表没建好，把考勤也一起卡死。 */
      const fails = [];
      let l = { total: 0, added: 0, skipped: 0, failed: 0, errors: [] };
      let iv = { total: 0, added: 0, skipped: 0, failed: 0, errors: [] };
      let at = { total: 0, added: 0, skipped: 0, failed: 0, errors: [], tables: 0, rows: 0 };

      if (lessons?.realRows) {
        try {
          l = await migrateLessons(({ done, total, text }) => showProg(text, total ? Math.round((done / total) * 100) : 0));
        } catch (e) { fails.push('课时：' + (e.message || e)); }
      }
      if (invig) {
        try {
          iv = await migrateInvigilations(({ done, total, text }) => showProg(text, total ? Math.round((done / total) * 100) : 0));
        } catch (e) { fails.push('监考：' + (e.message || e)); }
      }
      if (attTables) {
        try {
          at = await migrateAttendance(({ done, total, text }) => showProg(text, total ? Math.round((done / total) * 100) : 0));
        } catch (e) { fails.push('考勤：' + (e.message || e)); }
      }

      const errors = [...l.errors, ...iv.errors, ...at.errors];
      const totalFailed = l.failed + iv.failed + at.failed + fails.length;
      const bad = (errors.length || fails.length)
        ? `<div class="cl-tip" style="margin-top:10px;color:var(--red)">
             ${fails.map(esc).join('<br>')}
             ${errors.length ? `<br>${errors.slice(0, 5).map(esc).join('<br>')}` : ''}
             ${errors.length > 5 ? '<br>…还有其他 ' + (errors.length - 5) + ' 条' : ''}
           </div>`
        : '';

      body.innerHTML = `
        <div class="cl-list">
          <div class="cl-row"><span>课时 新上传</span><b style="color:#166534">${l.added} 条</b></div>
          <div class="cl-row"><span>监考 新上传</span><b style="color:#166534">${iv.added} 场</b></div>
          <div class="cl-row"><span>考勤 新上传</span><b style="color:#166534">${at.tables || 0} 张 / ${at.rows || 0} 人</b></div>
          <div class="cl-row"><span>跳过（已存在/空）</span><b>${l.skipped + iv.skipped + at.skipped} 条</b></div>
          <div class="cl-row"><span>失败</span><b style="color:${totalFailed ? 'var(--red)' : 'inherit'}">${totalFailed} 条</b></div>
        </div>
        ${bad}
        <div class="tiny muted" style="margin-top:10px;line-height:1.7">
          ${totalFailed ? '有失败的，可以再点一次「开始迁移」重试（已成功的会自动跳过）。' : '迁移完成。去「上课」「监考」「考勤」各刷新一下就能看到。'}
        </div>
        <button class="btn primary block" id="mg-done" style="margin-top:14px;justify-content:center">知道了</button>
      `;
      body.querySelector('#mg-done').onclick = () => {
        sh.close();
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      };
      const sum = l.added + iv.added + (at.tables || 0);
      toast(`迁移完成：新增 ${sum} 项`, totalFailed ? 'warn' : 'ok', 6000);
    } catch (e) {
      go.disabled = false;
      go.textContent = '重试';
      prog.innerHTML = `<span style="color:var(--red)">${esc(e.message || e)}</span>`;
    }
  };
}

/* ============================================================================
   页面顶部提示条
   没登录时在课时页顶部挂一条，点一下就能登录。
   为什么不用弹窗强拦：教师可能在地铁上、教室里网络差，
   强制登录会让人连看都看不到内容。给一条能关的提示更友好。
   ========================================================================== */

export function loginBanner() {
  if (cloudOn()) return '';
  return `<button class="cl-banner" id="cl-banner">
    ${icon('cloud', 15)}
    <span style="flex:1;text-align:left">登录后课时自动存到云端 · 换设备直接看到</span>
    ${icon('right', 14)}
  </button>`;
}

export function hookBanner(root) {
  const el2 = root && root.querySelector('#cl-banner');
  if (el2) {
    el2.onclick = () => loginSheet({
      onDone: () => {
        /* 登录完成后重绘当前页，让课时从云端重新拉一遍 */
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      },
    });
  }
}
