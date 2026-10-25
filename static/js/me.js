import {
  api, el, esc, toast, sheet, confirmDialog, fmtDateTime, download, ls,
} from './core.js';
import { registerView, state, icon, go, pageHead, parseHash, render, themeName, openThemeSheet, paintUnread, refreshUnread } from './ui.js';
import { AUTH_CFG } from './ui.js';
import { bindSheet } from './cloudsync.js';

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

  const [msgs, sessions] = await Promise.all([
    api.get('/messages').catch(() => ({ unread: 0, counts: {} })),
    api.get('/me/sessions').catch(() => []),
  ]);
  const needProfile = !u.school || !u.subject;
  main.innerHTML = `
    <div class="me-hero">
      ${avatarHTML(u, 74, 'me-avatar-lg')}
      <div class="me-hero-info">
        <div class="me-name">${esc(u.nickname || '未设置昵称')}</div>
        <div class="me-sub">${esc(maskPhone(u.phone))}${u.school ? ' · ' + esc(u.school) : ''}${u.subject ? ' · ' + esc(u.subject) : ''}</div>
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
      ['shield', '账号安全', '改密码、登录设备管理', 'security', ''],
      ['qr', '账号与绑定', '微信 / QQ / 手机号', 'bind', ''],
    ], needProfile)}

    ${group('个性化', [
      ['sun', '主题外观', `当前：${themeName(state.theme)}`, 'theme', `<span class="tiny muted">共 6 套</span>`],
    ])}

    ${group('数据', [
      ['refresh', '云同步', '手机、电脑数据自动一致', 'cloud', syncBadge()],
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
    if (a === 'bind') return bindManager(sessions);
    if (a === 'security') return securitySheet();
    if (a === 'backup') return backupSheet();
    if (a === 'cloud') return bindSheet();
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
      const blob = await cropSquare(f, 512);
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
function cropSquare(file, size = 512) {
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
        }, 'image/jpeg', 0.9);
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
      <div class="field"><label class="field-label">手机号</label>
        <div class="row" style="gap:8px"><input class="input" value="${esc(maskPhone(u.phone))}" disabled>
          <button class="btn ghost sm" id="p-bind" style="flex:0 0 auto">换绑</button></div></div>
      <div class="tiny muted" style="margin-top:4px">手机号是登录凭证，换绑需要短信验证。</div>
    </div>`;

  main.querySelector('#p-avatar').onclick = () => avatarSheet();
  main.querySelector('#p-bind').onclick = async () => {
    const sessions = await api.get('/me/sessions').catch(() => []);
    bindManager(sessions);
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

/* ================= 账号安全 ================= */
function securitySheet() {
  const b = el(`<div class="sheet-body">
    <div class="small bold" style="margin-bottom:8px">重置登录密码</div>
    <div class="field"><label class="field-label">原密码（还没设过可留空）</label>
      <input class="input" type="password" id="o" autocomplete="current-password" placeholder="当前密码"></div>
    <div class="field"><label class="field-label">新密码</label>
      <input class="input" type="password" id="n" autocomplete="new-password" placeholder="至少 6 位"></div>
    <div class="field"><label class="field-label">再输一次</label>
      <input class="input" type="password" id="n2" autocomplete="new-password" placeholder="确认新密码"></div>
    <div class="tiny muted" style="margin:2px 0 10px">改完密码，其他设备上的登录会继续有效，需要的话在下面一键踢掉。</div>
    <div class="confirm-actions"><button class="btn ghost" id="x">取消</button><button class="btn primary" id="k">保存新密码</button></div></div>`);
  const sh = sheet({ title: '账号安全', body: b });
  b.querySelector('#x').onclick = sh.close;
  b.querySelector('#k').onclick = async (e) => {
    const o = b.querySelector('#o').value;
    const n = b.querySelector('#n').value;
    const n2 = b.querySelector('#n2').value;
    if (n.length < 6) return toast('新密码至少 6 位', 'warn');
    if (n !== n2) return toast('两次输入的新密码不一样', 'warn');
    const btn = e.currentTarget;
    btn.disabled = true; btn.textContent = '保存中…';
    try {
      await api.post('/me/password', { oldPassword: o, newPassword: n });
      btn.disabled = false; btn.textContent = '保存新密码';
      /* 改完就关面板是个真问题：用户松手之后不知道刚才到底成没成，
         尤其这里还有个「原密码填错」的失败路径长得一样。
         所以改成留在原地，把结果写进面板里，按钮也换掉。
         顺便把「要不要踢掉其他设备」摆在这里——改密码的人十有八九就是担心这个。 */
      const wrap = b.querySelector('.confirm-actions');
      const note = document.createElement('div');
      note.className = 'pwd-done';
      note.innerHTML = `<div class="pd-ok">${icon('check', 15)} 密码已更新</div>
        <div class="tiny muted" style="margin-top:6px">其他设备上的登录还在。如果这个账号可能被别人用过，建议一并退出。</div>
        <div class="confirm-actions" style="margin-top:10px">
          <button class="btn ghost" id="pwd-close">知道了</button>
          <button class="btn soft" id="pwd-kick">退出其他设备</button>
        </div>`;
      wrap.replaceWith(note);
      note.querySelector('#pwd-close').onclick = sh.close;
      note.querySelector('#pwd-kick').onclick = async (ev) => {
        ev.currentTarget.disabled = true;
        try {
          await api.post('/me/sessions/revoke');
          toast('其他设备已退出');
          sh.close();
        } catch (err) { toast(err.message, 'err'); ev.currentTarget.disabled = false; }
      };
    } catch (err) {
      toast(err.message || '改密码失败', 'err', 4000);
      btn.disabled = false; btn.textContent = '保存新密码';
      /* 原密码错的时候把光标放回去，省得用户还要自己找是哪一格填错了 */
      if (/原密码/.test(err.message || '')) { b.querySelector('#o').focus(); b.querySelector('#o').select(); }
    }
  };
}

/* ================= 账号与绑定 ================= */
function bindManager(sessions) {
  const u = state.user;
  const b = u.bindings || {};
  const body = el(`<div class="sheet-body">
    ${bindRow('phone', `${icon('user', 15)} 手机号`, u.phone ? maskPhone(u.phone) : '未绑定', !!u.phone)}
    ${bindRow('wechat', '微信', b.wechat ? (u.wx_nick || '已绑定') : '未绑定', !!b.wechat)}
    ${bindRow('qq', 'QQ', b.qq ? (u.qq_nick || '已绑定') : '未绑定', !!b.qq)}
    ${bindRow('workbuddy', `${icon('zap', 15)} WorkBuddy 账号`, b.workbuddy ? '已绑定' : '未绑定', !!b.workbuddy)}
    <div class="hr"></div>
    <div class="small bold" style="margin-bottom:6px">登录设备</div>
    ${(sessions || []).map((s) => `<div class="row small" style="padding:5px 0">
      <span>${esc(s.device)}</span><span class="tiny muted" style="margin-left:8px">${esc(s.ip || '')}</span>
      <span style="flex:1"></span><span class="tiny muted">${s.current ? '本设备' : fmtDateTime(s.last_seen)}</span></div>`).join('')}
    <button class="btn ghost sm block" id="revoke" style="margin-top:8px">退出其他所有设备</button>
  </div>`);
  const sh = sheet({ title: '账号与绑定', body });
  body.querySelector('#revoke').onclick = async () => {
    await api.post('/me/sessions/revoke'); toast('其他设备已退出'); sh.close();
  };
  body.querySelectorAll('[data-bind]').forEach((btn) => {
    btn.onclick = async () => {
      const type = btn.dataset.bind;
      if (btn.dataset.act === 'unbind') {
        try { await api.post('/auth/unbind', { type }); toast('已解绑'); sh.close(); const m = await import('./ui.js'); await m.loadMe(); render(); }
        catch (e) { toast(e.message, 'err'); }
        return;
      }
      if (type === 'phone') { phoneBindSheet(sh); return; }
      if (type === 'workbuddy') {
        /* WorkBuddy 绑定走整页跳转授权，回来由回调接口把 wb_uid 挂到当前登录的账号上。
           所以必须先关掉这个面板——不然跳走再回来，面板状态早没了。 */
        sh.close();
        const m = await import('./ui.js');
        m.startWorkBuddyLogin('bind');
        return;
      }
      /* 微信 / QQ 走扫码授权。原来这里无论有没有接开放平台，都会弹一个「二维码」，
         而那个码是伪随机画的假图案——扫了没反应，点「模拟确认」还会真的写上一个
         假 openid（`wechat_demo_1` 这种）。用户因此以为自己绑好了，
         实际上那条绑定是假的，而假绑定又能用来解绑手机号，账号会被搞坏。

         现在的规矩：没接开放平台就直接说没开通，一个假码都不给。
         和登录页那边「不再兜假二维码」是同一条原则。
         这一段不再调用任何弹窗，只负责把话说清楚。 */
      sh.close();
      toast(`${type === 'wechat' ? '微信' : 'QQ'}绑定尚未开通：本站没接入开放平台，拿不到能验证身份的授权`, 'warn', 5000);
    };
  });
}

function bindRow(type, label, val, bound, disabled = false) {
  return `<div class="row" style="padding:9px 0;border-bottom:1px solid var(--line)">
    <div style="flex:1"><div class="small bold">${label}</div><div class="tiny muted">${esc(val)}</div></div>
    <button class="btn ${bound ? 'ghost' : 'soft'} sm" data-bind="${type}" data-act="${bound ? 'unbind' : 'bind'}" ${disabled && !bound ? 'disabled' : ''}>${bound ? '解绑' : '去绑定'}</button></div>`;
}

function phoneBindSheet(parent) {
  const b = el(`<div class="sheet-body">
    <div class="tiny muted" style="margin-bottom:10px">当前手机号 <b>${esc(maskPhone(state.user?.phone))}</b>，换绑后用它登录。</div>
    <div class="field"><label class="field-label">新手机号</label>
      <input class="input" id="p" placeholder="11 位手机号" maxlength="11" inputmode="numeric" autocomplete="tel"></div>
    <div class="field"><label class="field-label">验证码</label>
      <div class="row" style="gap:8px">
        <input class="input" id="c" placeholder="6 位验证码" maxlength="6" inputmode="numeric" autocomplete="one-time-code">
        <button class="btn soft" id="send" style="flex:0 0 auto;min-width:104px">获取验证码</button></div></div>
    <div class="confirm-actions"><button class="btn ghost" id="x">取消</button><button class="btn primary" id="k">确认换绑</button></div></div>`);
  const s = sheet({ title: '换绑手机号', body: b });
  const $p = b.querySelector('#p');
  const $c = b.querySelector('#c');
  const $send = b.querySelector('#send');
  let left = 0, timer = null;

  const tick = () => {
    if (left <= 0) {
      clearInterval(timer); timer = null;
      $send.disabled = false;
      $send.textContent = '获取验证码';
      return;
    }
    $send.disabled = true;
    $send.textContent = `${left}s 后重发`;
    left -= 1;
  };

  $send.onclick = async () => {
    const phone = $p.value.trim();
    /* 前端先挡一道：不带手机号直接点，服务端只会回一个 400，
       用户看到的是「没反应」。现在点之前就把问题指出来。 */
    if (!/^1[3-9]\d{9}$/.test(phone)) return toast('请输入 11 位手机号', 'warn');
    $send.disabled = true;
    $send.textContent = '发送中…';
    try {
      const r = await api.post('/auth/otp', { phone, purpose: 'bind' });
      /* 【原来只认 devCode（演示模式），漏了 testCode】
         本站没配短信通道，走的是「测试通行证」那条路，服务端回的是 testCode。
         只判 devCode 的话，这里既不会自动填码、也不会有任何提示，
         用户看到的就是「点了获取验证码没反应」——第 3 条报的就是这个。
         两个都要认，提示文案区分开：testCode 要明说这是测试码。 */
      if (r?.testCode) {
        $c.value = r.testCode;
        toast(`测试码 ${r.testCode} 已填入（短信通道未配置，走测试通道）`, 'ok', 5500);
      } else if (r?.devCode) {
        $c.value = r.devCode;
        toast(`演示环境验证码：${r.devCode}（已自动填入）`);
      } else {
        toast(`验证码已发到 ${phone.slice(0, 3)}****${phone.slice(-4)}`);
      }
      left = 60; tick();
      timer = setInterval(tick, 1000);
      $c.focus();
    } catch (e) {
      $send.disabled = false;
      $send.textContent = '获取验证码';
      /* 未配置短信通道是最常见的原因（服务端回 501 + smsNotConfigured），
         这时候别让用户一直点，直接把话说明白。 */
      if (e?.extra?.smsNotConfigured) {
        toast('本站没配短信服务，收不到验证码。请在服务器上配置短信通道，或先用微信/QQ 登录', 'err', 6000);
      } else {
        toast(e.message || '验证码发送失败', 'err');
      }
    }
  };

  b.querySelector('#x').onclick = () => { clearInterval(timer); s.close(); };
  b.querySelector('#k').onclick = async (e) => {
    const phone = $p.value.trim();
    const code = $c.value.trim();
    if (!/^1[3-9]\d{9}$/.test(phone)) return toast('请输入 11 位手机号', 'warn');
    if (!/^\d{6}$/.test(code)) return toast('请输入 6 位验证码', 'warn');
    const btn = e.currentTarget;
    btn.disabled = true; btn.textContent = '换绑中…';
    try {
      const r = await api.post('/auth/bind', { type: 'phone', phone, code });
      clearInterval(timer);
      s.close(); parent?.close();
      const m = await import('./ui.js'); await m.loadMe();
      /* 服务端换完会把其他设备踢掉（保留本机）。这句要说出来，
         不然用户在别的设备上莫名其妙被登出，会以为是 bug。 */
      toast(r?.kicked ? '手机号已换绑，其他设备已退出登录' : '手机号已换绑');
      render();
    } catch (err) {
      btn.disabled = false; btn.textContent = '确认换绑';
      toast(err.message || '换绑失败', 'err');
    }
  };
}

/* ================= 备份 ================= */
/* 云同步入口的状态小标签：绑定了显示状态，没绑定提示去开 */
function syncBadge() {
  try {
    const c = JSON.parse(localStorage.getItem('wb_cloud_cfg') || 'null');
    if (!c) return '<span class="chip" style="background:#FEF3C7;color:#92400E">未开启</span>';
    const m = JSON.parse(localStorage.getItem('wb_cloud_meta') || '{}');
    return m.conflict
      ? '<span class="chip" style="background:#FEE2E2;color:#991B1B">有冲突</span>'
      : '<span class="chip" style="background:#DCFCE7;color:#166534">已开启</span>';
  } catch { return ''; }
}

function backupSheet() {
  const b = el(`<div class="sheet-body">
    <div class="small muted" style="margin-bottom:10px">备份包含事项、便签、上课、考勤、监考、出差、笔记、学习记录，可以在其他设备恢复。</div>
    <button class="btn ghost block" id="exp" style="margin-bottom:8px">${icon('download', 15)} 下载完整备份（JSON）</button>
    <label class="btn ghost block" style="cursor:pointer">${icon('upload', 15)} 从备份文件恢复<input type="file" id="imp" accept=".json" hidden></label>
    <div class="tiny muted" style="margin-top:10px">恢复为「追加」模式：不会覆盖现有数据，重复内容可手动清理。</div></div>`);
  const s = sheet({ title: '数据备份与恢复', body: b });
  b.querySelector('#exp').onclick = () => { download('/api/backup', 'backup.json'); s.close(); toast('备份已开始下载'); };
  b.querySelector('#imp').onchange = async (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    try {
      const json = JSON.parse(await f.text());
      const r = await api.post('/backup/restore', json);
      s.close(); toast(`已恢复 ${r.imported} 条记录`); render();
    } catch (err) { toast(err.message || '恢复失败', 'err'); }
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
