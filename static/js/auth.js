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
import { migrateLessons, previewMigration } from './migrate.js';

/* ---------------------------------------------------------------------------
   ★★★ 部署前要填这两个值 ★★★
   Supabase 后台 → Settings → API：
     Project URL      → SUPA_URL
     anon / publishable key → SUPA_ANON
   这两个都是「公开信息」，写进前端不丢人（它没有读取权限，
   真正管权限的是 RLS 和登录账号）。但 URL 填错就整站连不上，
   所以这里留一个显眼的注释，日后换项目别漏改。
   --------------------------------------------------------------------------- */
const SUPA_URL = 'https://gfgxvpvexzcfbujkwsqw.supabase.co';
const SUPA_ANON = 'sb_publishable_-AYrJyaZEN6_zeVh45oZ3w_YMOGF-3P';

/* 把内置配置写进 localStorage，cloud.js 只认 localStorage 里的，
   这样「换一个项目」只要改上面两行，不需要用户做任何事 */
function ensureCfg() {
  const c = cloud.cfg();
  if (!c || c.url !== SUPA_URL || c.anon !== SUPA_ANON) {
    cloud.saveCfg(SUPA_URL, SUPA_ANON);
  }
  return cloud.cfg();
}

/* 是否已经真的连上云端并能读写（登录 + 表已建好） */
export function cloudOn() {
  ensureCfg();
  return !!cloud.session();
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
        placeholder="你在 Supabase 里建的那个邮箱"></div>

    <div class="field"><label class="field-label">密码</label>
      <input class="input" id="cl-pwd" type="password" autocomplete="current-password" placeholder="密码"></div>

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
    </div>

    <div class="tiny muted" style="margin-top:10px;line-height:1.65">
      课时现在直接存在云上，改完即保存，不需要再点上传。
      其余模块（考勤、监考、值日等）这一步还没搬，仍存在本机，
      可以继续用「数据导出与备份」留个底。
    </div>

    <button class="btn ghost block" id="cl-mig" style="margin-top:12px;justify-content:center">
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

  b.querySelector('#cl-mig').onclick = () => { sh.close(); setTimeout(migrateSheet, 200); };

  b.querySelector('#cl-out').onclick = async () => {
    if (!(await confirmDialog('退出后课时数据在云端保留，重新登录还能看到。确定退出？'))) return;
    await cloud.logout();
    toast('已退出登录', 'ok');
    sh.close();
  };
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
        <div class="bold">把本机课时搬到云端</div>
        <div class="tiny muted" style="margin-top:3px" id="mg-sub">先检查一下本机数据…</div>
      </div>
    </div>
    <div id="mg-body"><div class="small muted" style="padding:10px 0">读取中…</div></div>
  </div>`);
  const sh = sheet({ title: '数据迁移', body: b });
  const body = b.querySelector('#mg-body');
  const sub = b.querySelector('#mg-sub');

  let info;
  try {
    info = await previewMigration();
  } catch (e) {
    body.innerHTML = `<div class="small" style="color:var(--red)">读不到本机数据：${esc(e.message || e)}</div>`;
    return;
  }

  sub.textContent = '检查完毕，请确认';

  if (!info.total) {
    body.innerHTML = `<div class="card card-pad small">本机没有课时记录，不需要迁移。</div>`;
    return;
  }

  const warn = [];
  if (info.badDate) warn.push(`${info.badDate} 条的日期认不出来，会存成空日期（记录本身不会丢）`);
  if (info.emptyRows) warn.push(`${info.emptyRows} 条是空记录（没日期也没内容），会自动跳过`);

  body.innerHTML = `
    <div class="cl-list">
      <div class="cl-row"><span>本机课时</span><b>${info.total} 条</b></div>
      <div class="cl-row"><span>其中有内容</span><b>${info.realRows} 条</b></div>
      <div class="cl-row"><span>带金额的</span><b>${info.withMoney} 条</b></div>
    </div>

    ${warn.length ? `<div class="cl-tip">
      <b>需要注意：</b><br>${warn.map((w) => '· ' + esc(w)).join('<br>')}
    </div>` : ''}

    <div class="cl-tip" style="margin-top:10px">
      <b>放心几点：</b><br>
      · 只往云端<b>复制</b>，本机数据一条都不删<br>
      · 已经传过的会自动跳过，重复点不会重复插<br>
      · 中途断了可以再点一次，接着传
    </div>

    <button class="btn primary block" id="mg-go" style="margin-top:14px;justify-content:center">
      开始迁移（${info.realRows} 条）
    </button>
    <div id="mg-prog" class="tiny muted" style="margin-top:10px;text-align:center;min-height:18px"></div>
  `;

  const go = body.querySelector('#mg-go');
  const prog = body.querySelector('#mg-prog');

  go.onclick = async () => {
    go.disabled = true;
    go.textContent = '迁移中…';
    try {
      const r = await migrateLessons(({ done, total, text }) => {
        prog.textContent = text;
        /* 进度条：几百条时纯文字看不出进展，给一条细线 */
        const pct = total ? Math.round((done / total) * 100) : 0;
        prog.innerHTML = `${esc(text)}<div style="height:4px;border-radius:2px;background:var(--line,#e6e8ec);margin-top:6px;overflow:hidden">
          <div style="height:100%;width:${pct}%;background:var(--blue,#2563eb);transition:width .2s"></div></div>`;
      });

      const bad = r.errors.length
        ? `<div class="cl-tip" style="margin-top:10px;color:var(--red)">
             ${r.errors.length} 条失败：<br>${r.errors.slice(0, 5).map(esc).join('<br>')}
             ${r.errors.length > 5 ? '<br>…还有其他 ' + (r.errors.length - 5) + ' 条' : ''}
           </div>`
        : '';

      body.innerHTML = `
        <div class="cl-list">
          <div class="cl-row"><span>本机共</span><b>${r.total} 条</b></div>
          <div class="cl-row"><span>新上传</span><b style="color:#166534">${r.added} 条</b></div>
          <div class="cl-row"><span>跳过（已存在/空）</span><b>${r.skipped} 条</b></div>
          <div class="cl-row"><span>失败</span><b style="color:${r.failed ? 'var(--red)' : 'inherit'}">${r.failed} 条</b></div>
        </div>
        ${bad}
        <div class="tiny muted" style="margin-top:10px;line-height:1.7">
          ${r.failed ? '有失败的，可以再点一次「开始迁移」重试（已成功的会自动跳过）。' : '迁移完成。回到「上课」页刷新一下就能看到。'}
        </div>
        <button class="btn primary block" id="mg-done" style="margin-top:14px;justify-content:center">知道了</button>
      `;
      body.querySelector('#mg-done').onclick = () => {
        sh.close();
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      };
      toast(`迁移完成：新增 ${r.added} 条，跳过 ${r.skipped} 条`, r.failed ? 'warn' : 'ok', 6000);
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
