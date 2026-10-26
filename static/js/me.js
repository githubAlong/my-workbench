import {
  api, el, esc, toast, sheet, confirmDialog, fmtDateTime, download, saveBlob, ls, ymd,
} from './core.js';
import { registerView, state, icon, go, pageHead, parseHash, render, themeName, openThemeSheet, paintUnread, refreshUnread } from './ui.js';
import { AUTH_CFG } from './ui.js';
import { makeShareLink } from './cloudsync.js';
import { loginSheet, cloudOn } from './auth.js';

registerView(async function me(main, { query }) {
  const { path } = parseHash();
  // 每次 render() 都会重建 main 节点，这里加类不会残留到别的页面。
  // 桌面端靠 .page-me 把卡片收窄，否则菜单行会被拉成一整条 1100px 的长条。
  main.classList.add('page-me');
  if (path === 'messages') return renderMessages(main);
  if (path === 'profile') return renderProfile(main);
  return renderMe(main);
});

/* ================= 我的（首页） ================= */
async function renderMe(main) {
  /* 【第 27 条：点「我的」是空白页】
     本地用两个账号都复现不出来，但代码里确实有一条「什么都不显示」的路径：
     state.user 为空时，下面 u.nickname / u.bindings / u.avatar 会直接抛 TypeError，
     而 render() 的 catch 只会往 main 里塞一行「页面加载失败」——
     用户看到的就是一片空白（那行字很小，标题区还是空的）。

     state.user 什么时候会是空？三条真实路径：
       ① 会话过期，/auth/me 返回 401，loadMe() 把 state.user 设成 null；
       ② 换绑手机号 / 退出登录后，另一台设备的 tab 还开着；
       ③ 页面从 bfcache 恢复（手机切后台再切回来），内存里的 state 与 Cookie 不同步。

     正确的做法不是「假设它不为空」，而是补一次 /auth/me：
     补得回来就正常渲染，补不回来就明确说「登录已过期」并给出重新登录的按钮。
     这样无论哪种情况都不会是空白。 */
  let u = state.user;
  if (!u) {
    try {
      const m = await import('./ui.js');
      u = await m.loadMe();
    } catch { u = null; }
  }
  if (!u) {
    main.innerHTML = `<div class="empty" style="padding:48px 20px">
      <div class="em">${icon('user', 34)}</div>
      登录状态已过期
      <div class="tiny muted" style="margin-top:8px">重新登录后，「我的」里的数据都还在</div>
      <div style="margin-top:16px"><button class="btn primary" id="me-relogin">重新登录</button></div>
    </div>`;
    const b = main.querySelector('#me-relogin');
    if (b) b.onclick = () => { location.hash = '#/home'; const m = window; m.location.reload?.(); };
    return;
  }

  const [msgs, rawSessions] = await Promise.all([
    api.get('/messages').catch(() => ({ unread: 0, counts: {} })),
    api.get('/me/sessions').catch(() => null),
  ]);
  /* 接口回的是 { rows: [...] }，这里统一成数组，后面 length / map 才不会炸 */
  const sessions = Array.isArray(rawSessions) ? rawSessions : (rawSessions?.rows || []);
  const needProfile = !u.school || !u.subject;
  main.innerHTML = `
    <div class="me-hero">
      ${avatarHTML(u, 74, 'me-avatar-lg')}
      <div class="me-hero-info">
        <div class="me-name">${esc(u.nickname || '未设置昵称')}</div>
        <div class="me-sub">${esc(u.account || '')}${u.school ? ' · ' + esc(u.school) : ''}${u.subject ? ' · ' + esc(u.subject) : ''}</div>
        <div class="me-chips">
          ${u.bindings?.wechat ? '<span class="chip green">微信</span>' : ''}
          ${u.bindings?.qq ? '<span class="chip blue">QQ</span>' : ''}
          ${u.bindings?.workbuddy ? '<span class="chip purple">WorkBuddy</span>' : ''}
          ${needProfile ? '<span class="chip amber">资料还没填完</span>' : ''}
        </div>
      </div>
      <button class="icon-btn me-cam" id="avatar-btn" title="换头像">${icon('camera', 16)}</button>
    </div>

    ${group('账号', [
      ['bell', '消息中心', msgs.unread ? `${msgs.unread} 条未读` : '暂无未读', 'messages',
        msgs.unread ? `<span class="msg-badge">${msgs.unread > 99 ? '99+' : msgs.unread}</span>` : ''],
      ['user', '个人信息', needProfile ? '昵称、学校、学科填一下' : '昵称、头像、学校、学科、职务', 'profile', ''],
      ['shield', '账号安全', '本机 PIN 锁、打开需验证', 'security', ''],
      ['qr', '账号', '登录账号与改密码', 'bind', ''],
    ], needProfile)}

    ${group('个性化', [
      ['sun', '主题外观', `当前：${themeName(state.theme)}`, 'theme', `<span class="tiny muted">共 6 套</span>`],
    ])}

    ${group('数据', [
      ['refresh', '云同步', '手机、电脑数据自动一致', 'cloud', syncBadge()],
      ['copy', '搬到另一台设备', '生成一条链接，手机点开即导入', 'share', ''],
      ['down', '数据导出与备份', '导出全部数据、导入恢复', 'backup', ''],
      ['copy', '学生短链', '课件 / 点名 / 惩罚 三合一', 'link', ''],
      ['trash', '回收站', '删除的内容可在这里找回', 'recycle', ''],
    ])}

    <div class="card me-logout">
      ${row('logout', '退出登录', '', 'logout')}
    </div>

    <div class="card card-pad small muted" style="margin-top:14px">
      <div class="row"><b style="color:var(--text)">关于</b><span style="flex:1"></span><span>v1.0</span></div>
      <div style="margin-top:6px">我的工作台 · 教师个人工作台。数据保存在你的账号下，手机、iPad、电脑打开即为同一份。</div>
      <div style="margin-top:6px" class="tiny">登录设备：${sessions.length} 台在线</div>
    </div>`;

  main.querySelectorAll('[data-act]').forEach((b) => { b.onclick = () => act(b.dataset.act); });
  main.querySelector('#avatar-btn').onclick = () => avatarSheet();

  async function act(a) {
    if (a === 'messages') return go('messages');
    if (a === 'profile') return go('profile');
    if (a === 'recycle') return go('recycle');
    if (a === 'theme') return openThemeSheet();
    if (a === 'logout') {
      if (await confirmDialog('确定退出登录？')) { await api.post('/auth/logout'); state.user = null; location.hash = '#/home'; render(); }
      return;
    }
    if (a === 'bind') return bindManager();
    if (a === 'security') return securitySheet();
    if (a === 'backup') return backupSheet();
    if (a === 'cloud') {
      /* 【A 方案：这里不再是手动上传/下载，而是登录】
         以前点进来是「生成/输入同步密钥 → 上传 / 下载」，
         换设备要重输 32 位密钥，改完还得记得点上传。
         现在改成邮箱密码登录，课时直接读写云上。
         旧的 bindSheet 没删（还有别的入口在用），但主路径换成登录。 */
      loginSheet({
        onDone: () => { render(); },
      });
      return;
    }
    if (a === 'share') return shareSheet();
    if (a === 'link') {
      const links = await api.get('/links');
      const code = links[0]?.code;
      if (code) window.open('/s/' + code, '_blank');
      else toast('还没有短链，去「工作 - 课件」生成', 'warn');
    }
  }

  /* 分组卡片：以前 11 个入口全平铺成一条长列表，常用和冷门混在一起，
     眼睛找不到重点。现在按「账号 / 个性化 / 数据」三块收拢，每块带一个小标题，
     有未完成事项的分区（比如资料没填）标题旁挂个点，一眼能看到该先做什么。 */
  function group(title, items, urgent = false) {
    return `<div class="me-group">
      <div class="me-group-h">${esc(title)}${urgent ? '<i class="me-dot" title="这一组还有没完成的"></i>' : ''}</div>
      <div class="card me-group-body">${items.map(([ic, t, sub, act, extra]) => row(ic, t, sub, act, extra)).join('')}</div>
    </div>`;
  }

  function row(ic, title, sub, action, extra = '') {
    return `<button class="list-item" style="width:100%;text-align:left;align-items:center" data-act="${action}">
      <span class="doc-ico">${icon(ic, 17)}</span>
      <span style="flex:1;min-width:0"><span class="bold small" style="${action === 'logout' ? 'color:var(--red)' : ''}">${esc(title)}</span>
        ${sub ? `<div class="tiny muted">${esc(sub)}</div>` : ''}</span>${extra}${icon('right', 15)}</button>`;
  }
}

const maskPhone = (p) => (p ? String(p).replace(/(\d{3})\d{4}(\d{4})/, '$1****$2') : '未绑定手机号');

/* 有头像就显示图片，没有就用首字 + 渐变底 */
function avatarHTML(u, size = 44, cls = '') {
  const first = esc((u.nickname || '师').slice(0, 1));
  if (u.avatar) {
    return `<span class="avatar ${cls}" style="width:${size}px;height:${size}px">
      <img src="${esc(u.avatar)}" alt="头像" loading="lazy"></span>`;
  }
  return `<span class="avatar ${cls} avatar-fallback" style="width:${size}px;height:${size};font-size:${Math.round(size * 0.4)}px">${first}</span>`;
}

/* ================= 头像 ================= */
function avatarSheet() {
  const u = state.user;
  const b = el(`<div class="sheet-body">
    <div class="av-preview">${avatarHTML(u, 96)}</div>
    <div class="tiny muted" style="text-align:center;margin:10px 0 14px">只用 JPG / PNG，不超过 2MB。上传后自动裁成正方形。</div>
    <label class="btn primary block" style="cursor:pointer;justify-content:center">${icon('upload', 15)} 选择图片
      <input type="file" id="av-file" accept="image/jpeg,image/png" hidden></label>
    ${u.avatar ? `<button class="btn ghost block" id="av-del" style="margin-top:8px;color:var(--red)">移除头像</button>` : ''}
    <div class="tiny muted" id="av-hint" style="text-align:center;margin-top:10px"></div>
  </div>`);
  const sh = sheet({ title: '头像', body: b });
  const hint = b.querySelector('#av-hint');
  const file = b.querySelector('#av-file');

  file.onchange = async () => {
    const f = file.files?.[0];
    if (!f) return;
    // 前端先挡一道，省得上传完了才被服务端打回来
    if (!/^image\/(jpeg|png)$/.test(f.type)) return toast('只支持 JPG / PNG', 'warn');
    if (f.size > 2 * 1024 * 1024) return toast(`图片 ${(f.size / 1024 / 1024).toFixed(1)}MB，超过 2MB 了`, 'warn');
    hint.textContent = '裁切中…';
    try {
      /* 512px / q0.9 压出来常有 60~120KB，而 localStorage 整库只有 5MB，
         存两三个大附件就满。头像实际最大显示 74px（@2x 148px 足够），
         降到 192px / q0.72 后一般 10~18KB。 */
      const blob = await cropSquare(f, 192);
      hint.textContent = '上传中…';
      const fd = new FormData();
      fd.append('files', blob, 'avatar.jpg');
      const r = await api.post('/me/avatar', fd);
      state.user = r.user;
      sh.close();
      toast('头像已更新');
      render();
    } catch (e) {
      hint.textContent = '';
      toast(e.message || '上传失败', 'err');
    }
  };

  const del = b.querySelector('#av-del');
  if (del) del.onclick = async () => {
    if (!(await confirmDialog('移除当前头像？', { danger: true, okText: '移除' }))) return;
    /* 原来这里没有 try/catch：接口一失败就抛出去，界面既不关也没有提示，
       用户看到的就是「点了确认没反应」。现在失败必须说出来。 */
    del.disabled = true;
    del.textContent = '移除中…';
    try {
      const r = await api.del('/me/avatar');
      state.user = r.user;
      sh.close();
      toast('已移除');
      render();
    } catch (e) {
      del.disabled = false;
      del.textContent = '移除头像';
      toast(e.message || '移除失败，请稍后再试', 'err');
    }
  };
}

/* 正方形裁切 + 压成 512px 的 JPEG。
   手机拍的原图动辄 4000px，直接传会撑爆存储，也没必要。 */
function cropSquare(file, size = 192) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const side = Math.min(img.width, img.height);
        const sx = (img.width - side) / 2;
        const sy = (img.height - side) / 2;
        const cv = document.createElement('canvas');
        cv.width = size; cv.height = size;
        const ctx = cv.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
        cv.toBlob((blob) => {
          URL.revokeObjectURL(url);
          if (!blob) return reject(new Error('图片处理失败'));
          if (blob.size > 2 * 1024 * 1024) return reject(new Error('裁切后仍超过 2MB，换张小点的图'));
          resolve(blob);
        }, 'image/jpeg', 0.72);
      } catch (e) { URL.revokeObjectURL(url); reject(e); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('这张图片读不出来，换一张试试')); };
    img.src = url;
  });
}

/* ================= 个人信息（独立页） ================= */
async function renderProfile(main) {
  const u = state.user;
  /* 和 renderMe 同一个坑：u 为空时这里会连抛好几个 TypeError */
  if (!u) {
    main.innerHTML = '<div class="empty" style="padding:40px 20px">登录状态已过期，请刷新页面重新登录</div>';
    return;
  }
  main.innerHTML = pageHead('个人信息', '改完点右上角保存', '<button class="btn primary sm" id="p-save">保存</button>') + `
    <div class="card card-pad" style="margin-bottom:14px">
      <div class="profile-av-row">
        <button id="p-avatar" class="profile-av-btn">${avatarHTML(u, 68)}<span class="pa-tip">${icon('camera', 13)} 换头像</span></button>
        <div class="tiny muted" style="flex:1">头像支持 JPG / PNG，2MB 以内，会自动裁成正方形。</div>
      </div>
    </div>
    <div class="card card-pad">
      <div class="field"><label class="field-label">昵称</label>
        <input class="input" id="f-nickname" maxlength="20" value="${esc(u.nickname || '')}" placeholder="怎么称呼你"></div>
      <div class="field"><label class="field-label">学校</label>
        <input class="input" id="f-school" maxlength="40" value="${esc(u.school || '')}" placeholder="如：市第二中学"></div>
      <div class="form-grid">
        <div class="field"><label class="field-label">学科</label>
          <input class="input" id="f-subject" maxlength="20" value="${esc(u.subject || '')}" placeholder="如：语文"></div>
        <div class="field"><label class="field-label">职务</label>
          <input class="input" id="f-title" maxlength="20" value="${esc(u.title || '')}" placeholder="如：班主任"></div>
      </div>
      <div class="field"><label class="field-label">登录账号</label>
        <div class="row" style="gap:8px"><input class="input" value="${esc(u.account || '')}" disabled>
          <button class="btn ghost sm" id="p-bind" style="flex:0 0 auto">改密码</button></div></div>
      <div class="tiny muted" style="margin-top:4px">账号 + 密码是本机唯一的登录凭证，账号不可改，密码可随时修改。</div>
    </div>`;

  main.querySelector('#p-avatar').onclick = () => avatarSheet();
  main.querySelector('#p-bind').onclick = async () => {
    /* 这里原来的按钮是「换绑手机号」，现在只做改密码 ——
       拉 /me/sessions 没有意义（那套「登录设备」是服务端会话，静态版恒为空）。 */
    accountPwdSheet(null);
  };
  main.querySelector('#p-save').onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true; btn.textContent = '保存中…';
    try {
      const r = await api.patch('/me', {
        nickname: main.querySelector('#f-nickname').value.trim(),
        school: main.querySelector('#f-school').value.trim(),
        subject: main.querySelector('#f-subject').value.trim(),
        title: main.querySelector('#f-title').value.trim(),
      });
      state.user = r.user;
      toast('已保存');
      render();
    } catch (err) {
      toast(err.message || '保存失败', 'err');
    } finally {
      btn.disabled = false; btn.textContent = '保存';
    }
  };
}

/* ================= 账号安全（本机 PIN 锁） =================
   【这一屏以前是死的】
   静态版没有服务端，`POST /me/password` 永远返回 400「静态版没有服务端密码」，
   用户点进来、认认真真输两次新密码、点保存，得到的是一句「不需要修改」——
   这不是提示，这是耍人。
   现在换成一个在这里真能用的东西：本机 PIN 锁。
   设完之后，每次重新打开工作台要先输 4~6 位数字才能看到内容。
   它保护的是「别人顺手拿起我的手机/电脑翻一翻」，不是硬盘级加密 ——
   文案里就这么写，不夸大。 */
async function securitySheet() {
  let info = { enabled: false };
  try { info = await api.get('/me/pin'); } catch { }
  const b = el(`<div class="sheet-body">
    <div class="pin-state ${info.enabled ? 'on' : ''}" id="pin-state">
      ${icon(info.enabled ? 'shield' : 'alert', 16)}
      <span>${info.enabled ? `本机 PIN 已开启${info.at ? '（' + fmtDateTime(info.at) + ' 设置）' : ''}` : '本机 PIN 还没设置'}</span>
    </div>
    <div class="tiny muted" style="margin:6px 0 14px">
      这个 PIN 只保护<b>这台设备上</b>的工作台数据：重新打开页面要先输一次。
      它防的是别人顺手拿你手机、电脑翻看，<b>不是</b>硬盘加密 —— 懂技术的人打开浏览器开发者工具仍然能看到数据。
      换设备、清浏览器数据之后 PIN 就没了，需要重新设。
    </div>
    <div id="pin-form"></div>
  </div>`);
  const sh = sheet({ title: '账号安全', body: b });

  const form = b.querySelector('#pin-form');
  const paint = () => {
    if (info.enabled) {
      form.innerHTML = `
        <div class="field"><label class="field-label">当前 PIN</label>
          <input class="input" type="password" inputmode="numeric" maxlength="6" id="p-old" autocomplete="off" placeholder="用于修改或关闭"></div>
        <div class="hr"></div>
        <div class="field"><label class="field-label">新 PIN（4~6 位数字）</label>
          <input class="input" type="password" inputmode="numeric" maxlength="6" id="p-new" autocomplete="off" placeholder="换一个"></div>
        <div class="field"><label class="field-label">再输一次</label>
          <input class="input" type="password" inputmode="numeric" maxlength="6" id="p-new2" autocomplete="off" placeholder="确认新 PIN"></div>
        <div class="confirm-actions">
          <button class="btn ghost" id="p-off" style="color:var(--red);margin-right:auto">关闭 PIN</button>
          <button class="btn ghost" id="p-cancel">取消</button>
          <button class="btn primary" id="p-save">修改 PIN</button>
        </div>`;
    } else {
      form.innerHTML = `
        <div class="field"><label class="field-label">设置 PIN（4~6 位数字）</label>
          <input class="input" type="password" inputmode="numeric" maxlength="6" id="p-new" autocomplete="off" placeholder="比如 5820"></div>
        <div class="field"><label class="field-label">再输一次</label>
          <input class="input" type="password" inputmode="numeric" maxlength="6" id="p-new2" autocomplete="off" placeholder="确认"></div>
        <div class="confirm-actions">
          <button class="btn ghost" id="p-cancel">取消</button>
          <button class="btn primary" id="p-save">开启本机 PIN</button>
        </div>`;
    }
    const q = (x) => form.querySelector(x);
    q('#p-cancel').onclick = sh.close;
    q('#p-save').onclick = async (e) => {
      const nv = q('#p-new').value.trim();
      const nv2 = q('#p-new2').value.trim();
      if (!/^\d{4,6}$/.test(nv)) return toast('PIN 请设 4~6 位数字', 'warn');
      if (nv !== nv2) return toast('两次输入不一样', 'warn');
      const btn = e.currentTarget;
      btn.disabled = true; btn.textContent = '保存中…';
      try {
        if (info.enabled) await api.post('/me/pin', { oldPin: q('#p-old').value.trim(), pin: nv });
        else await api.post('/me/pin', { pin: nv });
        toast(info.enabled ? 'PIN 已修改' : '本机 PIN 已开启，下次打开要输一次');
        info = await api.get('/me/pin');
        const st = b.querySelector('#pin-state');
        st.classList.add('on');
        st.innerHTML = `${icon('shield', 16)}<span>本机 PIN 已开启</span>`;
        paint();
      } catch (err) {
        btn.disabled = false; btn.textContent = info.enabled ? '修改 PIN' : '开启本机 PIN';
        toast(err.message || '保存失败', 'err', 4000);
      }
    };
    const off = form.querySelector('#p-off');
    if (off) off.onclick = async (e) => {
      const pin = form.querySelector('#p-old').value.trim();
      if (!pin) return toast('先在上面填当前 PIN', 'warn');
      if (!await confirmDialog('关闭本机 PIN？\n\n关闭后这台设备重新打开工作台不再需要输 PIN，谁拿到都能直接看。')) return;
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        await api.post('/me/pin/disable', { pin });
        toast('本机 PIN 已关闭');
        info = { enabled: false };
        const st = b.querySelector('#pin-state');
        st.classList.remove('on');
        st.innerHTML = `${icon('alert', 16)}<span>本机 PIN 已关闭</span>`;
        paint();
      } catch (err) { btn.disabled = false; toast(err.message || '关闭失败', 'err', 4000); }
    };
  };
  paint();
}

/* ================= 锁屏 =================
   页面启动时如果设了 PIN 且本会话还没解锁过，就盖一层这个。
   它只是「挡住视线」，不销毁数据 —— 所以下面那行小字是实话，不是免责声明。 */
export function lockScreen(onOk) {
  document.querySelector('.pin-lock')?.remove();
  const w = el(`<div class="pin-lock">
    <div class="pin-card">
      <div class="pin-icon">${icon('shield', 26)}</div>
      <div class="pin-title">工作台已锁定</div>
      <div class="pin-sub">输入本机 PIN 继续</div>
      <input class="pin-input" id="pin-in" type="password" inputmode="numeric" maxlength="6" autocomplete="off" placeholder="••••">
      <div class="pin-err" id="pin-err"></div>
      <button class="btn primary pin-ok" id="pin-go">解锁</button>
      <div class="tiny muted pin-tip">忘了 PIN？在浏览器设置里清掉本站数据即可重置，但工作台里的数据也会一起清空 —— 建议平时在「数据导出与备份」里定期导出。</div>
    </div>
  </div>`);
  document.body.appendChild(w);
  const inp = w.querySelector('#pin-in');
  const err = w.querySelector('#pin-err');
  const go = w.querySelector('#pin-go');
  setTimeout(() => inp.focus(), 60);
  const submit = async () => {
    const v = inp.value.trim();
    if (!v) return;
    go.disabled = true; go.textContent = '核对中…';
    try {
      await api.post('/me/pin/verify', { pin: v });
      w.classList.add('out');
      setTimeout(() => w.remove(), 220);
      onOk?.();
    } catch (e) {
      err.textContent = e.message || 'PIN 不对';
      inp.value = ''; inp.focus();
      w.querySelector('.pin-card').classList.add('shake');
      setTimeout(() => w.querySelector('.pin-card')?.classList.remove('shake'), 420);
      go.disabled = false; go.textContent = '解锁';
    }
  };
  go.onclick = submit;
  inp.onkeydown = (e) => { if (e.key === 'Enter') submit(); };
}

/* ================= 账号与绑定 ================= */
/* 账号面板：只剩「账号 + 改密码」。
   微信 / QQ / WorkBuddy 三行原来一直在，但静态版没有任何授权通道，
   点「去绑定」只会弹一句「未开通」——留着就是三个假按钮。
   手机号那一行同理：它的意义是「换绑后用手机号登录」，而登录已经不要手机号了。
   与其摆一排点了没用的东西，不如只留真正能用的那一个。 */
function bindManager() {
  const u = state.user || {};
  const body = el(`<div class="sheet-body">
    ${bindRow('account', `${icon('user', 15)} 登录账号`, u.account || '未设置', !!u.account, false, '改密码')}
    <div class="tiny muted" style="margin-top:12px;line-height:1.7">
      账号和密码都只存在这台设备上，换设备或清浏览器数据之后就没了。
      平时记得在「数据导出与备份」里导出一份。
    </div>
  </div>`);
  const sh = sheet({ title: '账号', body });
  body.querySelectorAll('[data-bind]').forEach((btn) => {
    btn.onclick = () => { if (btn.dataset.bind === 'account') accountPwdSheet(sh); };
  });
}

/* 【第 3 / 31 条】原来已绑定时只给一个「解绑」按钮，
   想换号必须先解绑成空号再绑——中间那一秒账号是没有手机号的，
   而且解绑后 bindManager 拿的还是旧的 state.user，界面不刷新，
   看起来就是「点了没反应」/「输入框根本输不进手机号」。
   现在已绑定时给两个按钮：「换绑」直接进换号流程，「解绑」留在右边。 */
function bindRow(type, label, val, bound, disabled = false, onAct = '') {
  /* 账号这一行不是「绑 / 解绑」，而是「改密码」——一个按钮就够，不给解绑入口
     （解绑账号等于把自己锁在门外，没有服务端也没法再登回来）。 */
  if (onAct) {
    return `<div class="row" style="padding:9px 0;border-bottom:1px solid var(--line)">
      <div style="flex:1"><div class="small bold">${label}</div><div class="tiny muted">${esc(val)}</div></div>
      <button class="btn ghost sm" data-bind="${type}" data-act="rebind">${onAct}</button></div>`;
  }
  const acts = bound
    ? `<button class="btn ghost sm" data-bind="${type}" data-act="rebind">换绑</button>
       <button class="btn ghost sm" data-bind="${type}" data-act="unbind" style="margin-left:6px;color:var(--text-3)">解绑</button>`
    : `<button class="btn soft sm" data-bind="${type}" data-act="bind" ${disabled ? 'disabled' : ''}>去绑定</button>`;
  return `<div class="row" style="padding:9px 0;border-bottom:1px solid var(--line)">
    <div style="flex:1"><div class="small bold">${label}</div><div class="tiny muted">${esc(val)}</div></div>
    ${acts}</div>`;
}

/* 【改密码】账号 + 密码是本机唯一凭证，所以改密码必须验原密码。
   没有服务端可以做「忘记密码 -> 邮箱验证」，所以这里只有这一条路：
   记得旧密码就能改，忘了就只能清本站数据重来。 */
function accountPwdSheet(parent) {
  const b = el(`<div class="sheet-body">
    <div class="tiny muted" style="margin-bottom:10px;line-height:1.7">
      当前账号 <b>${esc(state.user?.account || '')}</b>。密码只存在这台设备上，改完下次打开就用新密码。
    </div>
    <div class="field"><label class="field-label">原密码</label>
      <input class="input" id="op" type="password" autocomplete="current-password" maxlength="32" placeholder="当前密码"></div>
    <div class="field"><label class="field-label">新密码</label>
      <input class="input" id="np" type="password" autocomplete="new-password" maxlength="32" placeholder="至少 6 位"></div>
    <div class="field"><label class="field-label">再输一遍</label>
      <input class="input" id="np2" type="password" autocomplete="new-password" maxlength="32" placeholder="确认新密码"></div>
    <button class="btn primary block" id="pw-save" style="margin-top:6px">保存新密码</button>
  </div>`);
  const sh = sheet({ title: '修改密码', body: b });
  b.querySelector('#pw-save').onclick = async () => {
    const op = b.querySelector('#op').value;
    const np = b.querySelector('#np').value;
    const np2 = b.querySelector('#np2').value;
    if (!op) return toast('请填写原密码', 'warn');
    if (np.length < 6) return toast('新密码至少 6 位', 'warn');
    if (np !== np2) return toast('两次输入的新密码不一致', 'warn');
    const btn = b.querySelector('#pw-save');
    btn.disabled = true; btn.textContent = '保存中…';
    try {
      await api.post('/auth/password', { oldPassword: op, newPassword: np });
      toast('密码已改，下次登录用新密码');
      sh.close();
    } catch (e) {
      btn.disabled = false; btn.textContent = '保存新密码';
      toast(e.message || '修改失败', 'err');
    }
  };
}


/* ================= 备份 ================= */
/* 云同步入口的状态小标签。
   【A 方案改了这里的语义】以前状态只有一个来源：旧的手动同步配置
   （wb_cloud_cfg）。现在多了一个「已登录 Supabase」的通道，
   而且登录才是我们想引导用户去用的那一种，所以优先显示登录状态。
   旧通道没下线，仍然保留，只是排在后面 —— 免得已经绑了旧密钥的
   用户看到「未开启」，以为自己的配置丢了。 */
function syncBadge() {
  if (cloudOn()) {
    return '<span class="chip" style="background:#DCFCE7;color:#166534">已登录</span>';
  }
  try {
    const c = JSON.parse(localStorage.getItem('wb_cloud_cfg') || 'null');
    if (!c) return '<span class="chip" style="background:#FEF3C7;color:#92400E">未登录</span>';
    const m = JSON.parse(localStorage.getItem('wb_cloud_meta') || '{}');
    if (m.conflict) return '<span class="chip" style="background:#FEE2E2;color:#991B1B">有冲突</span>';
    /* 【绑了但一次都没传成功，要说出来】
       以前只要 localStorage 里有配置就一律显示「已开启」。
       可「绑上了」和「数据真的在云上」是两件事 ——
       绑定时上传失败会被静默吞掉（见 bindSheet 的注释），
       界面却照样报成功、标签照样变绿，用户以为万事大吉，
       换设备时才发现云端是空的。
       这里把「已经传过」和「还没传成」分开显示。 */
    if (!m.lastPush) {
      return '<span class="chip" style="background:#FEF3C7;color:#92400E">已绑定·未上传</span>';
    }
    return '<span class="chip" style="background:#DCFCE7;color:#166534">已开启</span>';
  } catch { return ''; }
}

/* 搬到另一台设备：把库压成一条链接，微信发给自己、手机点开即导入。
   不起服务器、不注册账号，比备份文件少一步「传到手机」的操作。 */
async function shareSheet() {
  const s = sheet({ title: '搬到另一台设备', body: '<div class="small muted" style="padding:8px 0">正在打包数据…</div>' });
  const box = document.body.querySelector('.sheet-mask:last-of-type .sheet-body');
  try {
    const { link, bytes, packedBytes } = await makeShareLink();
    const tooLong = link.length > 32000;
    box.innerHTML = `
      <div class="small" style="margin-bottom:10px">
        把下面这条链接发到手机上（微信文件传输助手就行），<b>手机点开就自动导入</b>。
      </div>
      <div class="card card-pad tiny" style="margin-bottom:10px;line-height:1.7">
        原始数据 ${(bytes / 1024).toFixed(1)} KB → 压缩后 ${(packedBytes / 1024).toFixed(1)} KB<br>
        ${tooLong
          ? '<span style="color:var(--red,#dc2626)">⚠ 数据太大，链接超长，微信可能发不出去。请改用「数据导出与备份」的 JSON 文件。</span>'
          : '<span class="muted">链接长度正常，微信、短信都发得出去。链接里带了你的全部数据，别发到群里。</span>'}
      </div>
      <textarea readonly id="sh-link" style="width:100%;height:100px;font-size:11px;word-break:break-all">${esc(link)}</textarea>
      <button class="btn primary block" id="sh-copy" style="margin-top:8px">复制链接</button>
      <button class="btn ghost block" id="sh-open" style="margin-top:8px">在本机直接打开试试</button>
      <div class="tiny muted" style="margin-top:10px">
        点开链接时手机上已有的数据会先备份一份，导入后想找回还能捞。
        导入是<b>覆盖式</b>的——手机上先改过的东西会被这条链接里的数据替换掉。
      </div>`;
    box.querySelector('#sh-copy').onclick = () => {
      const t = box.querySelector('#sh-link');
      navigator.clipboard?.writeText(link).then(
        () => toast('链接已复制，去微信粘贴发给自己', 'ok'),
        () => { t.select(); toast('已全选，按 Ctrl+C 复制', 'ok'); },
      );
    };
    box.querySelector('#sh-open').onclick = () => { location.href = link; };
  } catch (e) {
    box.innerHTML = `<div class="small" style="color:var(--red,#dc2626);padding:8px 0">生成失败：${esc(e.message)}</div>`;
  }
}

function backupSheet() {
  const b = el(`<div class="sheet-body">
    <div class="small muted" style="margin-bottom:10px">备份包含事项、便签、上课、考勤、监考、出差、笔记、学习记录，可以在其他设备恢复。</div>
    <button class="btn ghost block" id="exp" style="margin-bottom:8px">${icon('download', 15)} 下载完整备份（JSON）</button>
    <label class="btn ghost block" style="cursor:pointer">${icon('upload', 15)} 从备份文件恢复<input type="file" id="imp" accept=".json" hidden></label>
    <div class="tiny muted" style="margin-top:10px">恢复为「追加」模式：不会覆盖现有数据，重复内容可手动清理。</div></div>`);
  const s = sheet({ title: '数据备份与恢复', body: b });
  /* 早先这里是 download('/api/backup')：静态版没有 /api 这个端点，
     GitHub Pages 直接 404，但函数不看结果，紧跟着就 toast「备份已开始下载」——
     用户以为备份过了，其实一个字节都没存下来。
     改为走 localapi 里本来就有的 GET /backup，前端生成 Blob 下载，
     成功与否都能如实反馈。 */
  b.querySelector('#exp').onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const r = await api.get('/backup');
      const raw = r?.data ?? r;
      const text = JSON.stringify(raw, null, 2);
      const n = Object.values(raw || {}).reduce((s, v) => s + (Array.isArray(v) ? v.length : 0), 0);
      const stamp = ymd(new Date()).replace(/-/g, '');
      saveBlob(new Blob([text], { type: 'application/json;charset=utf-8' }), `工作台备份-${stamp}.json`);
      toast(`已导出 ${n} 条记录`, 'ok');
    } catch (err) {
      toast('导出失败：' + (err.message || '未知错误'), 'err');
    } finally { btn.disabled = false; }
  };
  b.querySelector('#imp').onchange = async (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    /* 恢复前必须让用户看清要发生什么：
       以前选完文件立刻就 POST，一个点错就动到了全库。
       而且文件不对（选成了别的 json）也会直接把错结构塞进库里。 */
    try {
      const raw = await f.text();
      let json;
      try { json = JSON.parse(raw); } catch { return toast('这个文件不是备份文件（读不出 JSON）', 'err', 5000); }
      const body = json?.data && typeof json.data === 'object' ? json.data : json;
      const keys = Object.keys(body || {}).filter((k) => Array.isArray(body[k]));
      if (!keys.length) return toast('这个备份里没找到任何记录，可能选错文件了', 'err', 5000);
      const cnt = keys.reduce((s2, k) => s2 + body[k].length, 0);
      if (!await confirmDialog(
        `这个备份包含 ${cnt} 条记录（${keys.slice(0, 6).join('、')}${keys.length > 6 ? ' 等' : ''}）。\n\n` +
        '恢复是「追加」模式：现有数据不会删除，同名重复的会被跳过，其余新增。\n\n继续恢复吗？'
      )) { e.target.value = ''; return; }
      const r = await api.post('/backup/restore', json);
      s.close(); toast(`已恢复 ${r.imported} 条记录`); render();
    } catch (err) { toast(err.message || '恢复失败', 'err', 5000); }
    finally { e.target.value = ''; }
  };
}

/* ================= 消息中心 ================= */
async function renderMessages(main) {
  let type = 'all';
  const TYPES = [
    ['all', '全部', 'grid'],
    ['task', '任务提醒', 'check'],
    ['remind', '事项提醒', 'bell'],
    ['system', '系统通知', 'shield'],
  ];
  const load = async () => {
    /* 消息页原来没兜 401：会话一过期，api.get 直接抛错，
       下面整段渲染都不执行，页面就是空白。这里给出明确提示而不是留白。 */
    let r;
    try {
      r = await api.get('/messages', { type });
    } catch (e) {
      main.innerHTML = pageHead('消息中心', '', '')
        + `<div class="empty" style="padding:40px 20px">${esc(e.message || '加载失败')}<br>
           <span class="tiny muted">如果是登录过期，刷新页面重新登录即可</span></div>`;
      return;
    }
    const counts = r.counts || {};
    const rows = r.rows || [];
    main.innerHTML = pageHead('消息中心', r.unread ? `${r.unread} 条未读` : '都看完了',
      `<button class="btn ghost sm" id="read-all" ${r.unread ? '' : 'disabled'}>全部已读</button>`) + `
      <div class="seg msg-seg" style="margin-bottom:14px">
        ${TYPES.map(([v, l]) => `<button class="${type === v ? 'on' : ''}" data-t="${v}">${l}${counts[v] ? `<b class="seg-dot">${counts[v]}</b>` : ''}</button>`).join('')}
      </div>
      <div class="card">${rows.length ? rows.map((m) => msgItem(m)).join('') : '<div class="empty">这里还没有消息<br><span class="tiny">事项到期、系统变更时会出现</span></div>'}</div>
      ${rows.length ? '<button class="btn ghost block" id="clear-read" style="margin-top:12px">清空已读消息</button>' : ''}`;

    main.querySelectorAll('[data-t]').forEach((b) => { b.onclick = () => { type = b.dataset.t; load(); }; });
    const ra = main.querySelector('#read-all');
    if (ra) ra.onclick = async () => {
      await api.post('/messages/read', type === 'all' ? { all: true } : { type });
      // 读完立刻把导航角标同步掉，不等下一次轮询——否则左边「我的」上还挂着红点
      await refreshUnread();
      paintUnread();
      load();
    };
    const cr = main.querySelector('#clear-read');
    if (cr) cr.onclick = async () => {
      if (!(await confirmDialog('清空已读消息？未读的会保留'))) return;
      await api.post('/messages/clear', { readOnly: true }); toast('已清空'); await refreshUnread(); paintUnread(); load();
    };
    main.querySelectorAll('[data-open]').forEach((b) => {
      b.onclick = async () => {
        const id = Number(b.dataset.open);
        const m = rows.find((x) => x.id === id);
        if (!m) return;
        if (!m.read) { await api.post('/messages/read', { ids: [id] }); await refreshUnread(); paintUnread(); }
        if (m.link) go(String(m.link).replace(/^#\//, ''));
        else load();
      };
    });
    main.querySelectorAll('[data-read]').forEach((b) => {
      b.onclick = async (e) => {
        e.stopPropagation();
        await api.post('/messages/read', { ids: [Number(b.dataset.read)] });
        await refreshUnread(); paintUnread();
        load();
      };
    });
    main.querySelectorAll('[data-del]').forEach((b) => {
      b.onclick = async (e) => {
        e.stopPropagation();
        await api.del('/messages/' + b.dataset.del);
        await refreshUnread(); paintUnread();
        load();
      };
    });
  };
  await load();
}

function msgItem(m) {
  const ic = m.type === 'task' ? 'check' : m.type === 'remind' ? 'bell' : m.type === 'work' ? 'briefcase' : 'shield';
  const tone = m.type === 'task' ? 'blue' : m.type === 'remind' ? 'amber' : 'gray';
  return `<div class="msg-item ${m.read ? 'read' : ''}" data-open="${m.id}">
    <span class="msg-ico ${tone}">${icon(ic, 17)}</span>
    <div class="msg-main">
      <div class="msg-title">${m.read ? '' : '<i class="msg-dot"></i>'}<span>${esc(m.title)}</span></div>
      ${m.body ? `<div class="msg-text">${esc(m.body)}</div>` : ''}
      <div class="msg-time">${fmtDateTime(m.created_at)}${m.link ? ' · 点开查看' : ''}</div>
    </div>
    <div class="msg-acts">
      ${m.read ? '' : `<button class="icon-btn sm" data-read="${m.id}" title="标为已读">${icon('check', 14)}</button>`}
      <button class="icon-btn sm" data-del="${m.id}" title="删除">${icon('close', 13)}</button>
    </div>
  </div>`;
}
