import {
  api, el, esc, toast, sheet, confirmDialog, fmtDateTime, download, saveBlob, ls, ymd,
} from './core.js';
import { registerView, onViewLeave, state, icon, go, pageHead, parseHash, render, themeName, openThemeSheet, isWideMode, setWideMode, paintUnread, refreshUnread } from './ui.js';
import { AUTH_CFG } from './ui.js';
import { makeShareLink } from './cloudsync.js';
import { loginSheet, cloudOn } from './auth.js';
import * as cloud from './cloud.js';
import { load as loadLocalDB, save as saveLocalDB } from './localdb.js';

const ADMIN_PHONE = '+8613071825243';

registerView(async function me(main, { query }) {
  const { path } = parseHash();
  // 每次 render() 都会重建 main 节点，这里加类不会残留到别的页面。
  // 桌面端靠 .page-me 把卡片收窄，否则菜单行会被拉成一整条 1100px 的长条。
  main.classList.add('page-me');
  /* 离开个人信息页就把草稿丢掉。
     不丢的话，下次再进来会看到上一次没保存的残字，比清空更让人困惑。 */
  onViewLeave(() => {
    if (parseHash().path !== 'profile') profileDraft = null;
  });
  if (path === 'messages') return renderMessages(main);
  if (path === 'profile') return renderProfile(main);
  if (path === 'me/account-settings') return renderAccountSettings(main);
  if (path === 'me/workbench-settings') return renderWorkbenchSettings(main);
  return renderMe(main);
});

/* ================= 我的（首页） ================= */
async function renderMe(main) {
  let u = state.user;
  if (!u) {
    try {
      const m = await import('./ui.js');
      u = await m.loadMe();
    } catch { u = null; }
  }
  if (!u) {
    main.innerHTML = '<div class="empty" style="padding:48px 20px">' +
      '<div class="em">' + icon('user', 34) + '</div>登录状态已过期' +
      '<div class="tiny muted" style="margin-top:8px">重新登录后，「我的」里的数据都还在</div>' +
      '<div style="margin-top:16px"><button class="btn primary" id="me-relogin">重新登录</button></div></div>';
    const b = main.querySelector('#me-relogin');
    if (b) b.onclick = () => { location.hash = '#/home'; location.reload(); };
    return;
  }

  main.classList.add('page-me-home');
  const msgs = await api.get('/messages').catch(() => ({ unread: 0, counts: {} }));
  const unread = Number(msgs.unread) || 0;
  const needProfile = !u.school || !u.subject;
  const account = displayLoginAccount(u.account || u.phone, '暂未绑定登录账号');
  const wideEnabled = isWideMode();
  const meta = [u.school, u.subject].filter(Boolean).join(' · ')
    || [u.title, u.grade_group].filter(Boolean).join(' · ')
    || '完善个人资料，让工作台更懂你的工作';
  const role = [u.title, u.grade_group].filter(Boolean).join(' · ');
  const signature = u.signature || u.motto || u.bio || '';
  const bindings = [
    u.bindings?.wechat ? '<span class="chip green">微信已绑定</span>' : '',
    u.bindings?.qq ? '<span class="chip blue">QQ已绑定</span>' : '',
    u.bindings?.workbuddy ? '<span class="chip purple">WorkBuddy已绑定</span>' : '',
    needProfile ? '<span class="chip amber">资料待完善</span>' : '<span class="chip green">资料已完善</span>'
  ].filter(Boolean).join('');

  main.innerHTML = `
    <header class="me-home-head">
      <div><div class="me-home-eyebrow">PERSONAL CENTER</div><h1>我的</h1>
      <p>管理个人资料、工作台配置与消息通知</p></div>
    </header>

    <section class="me-identity-card" id="me-identity-card">
      <div class="me-identity-main">
        <button type="button" class="me-identity-avatar" id="avatar-btn" title="更换头像">
          ${avatarHTML(u, 58, 'me-avatar-lg', true)}
          <span class="me-identity-camera">${icon('camera', 13)}</span>
        </button>
        <div class="me-identity-copy">
          <div class="me-identity-name" id="me-identity-name">${esc(u.nickname || '未设置昵称')}</div>
          <div class="me-identity-meta" id="me-identity-meta">${esc(meta)}</div>
          <div class="me-identity-account" id="me-identity-role">${esc(role || account)}</div>
          ${signature ? `<div class="me-identity-signature">${esc(signature)}</div>` : ''}
          <div class="me-identity-chips">${bindings}</div>
        </div>
      </div>
      <span class="me-identity-compact" id="me-identity-compact">${esc(u.nickname || '未设置昵称')} · ${esc(meta)}</span>
      <button type="button" class="me-identity-toggle" id="me-identity-toggle"
        aria-expanded="true" aria-controls="me-identity-card">收起</button>
    </section>

    <div class="me-home-accordions" id="me-home-accordions">
      <details class="me-accordion" data-me-accordion="profile" open>
        <summary class="me-accordion-head">
          <span class="me-accordion-icon">${icon('user', 19)}</span>
          <span class="me-accordion-copy"><strong>个人信息</strong><small>头像、姓名、学校、学科及职务</small></span>
          <span class="me-accordion-chevron">${icon('down', 17)}</span>
        </summary>
        <div class="me-accordion-panel page-me-profile" id="me-profile-panel"></div>
      </details>

      <details class="me-accordion" data-me-accordion="workbench">
        <summary class="me-accordion-head">
          <span class="me-accordion-icon">${icon('sliders', 19)}</span>
          <span class="me-accordion-copy"><strong>工作台设置</strong><small>左上角名称、副标题和品牌图片</small></span>
          <span class="me-accordion-chevron">${icon('down', 17)}</span>
        </summary>
        <div class="me-accordion-panel page-me-workbench-settings" id="me-workbench-panel"></div>
      </details>

      <details class="me-accordion" data-me-accordion="account">
        <summary class="me-accordion-head">
          <span class="me-accordion-icon">${icon('shield', 19)}</span>
          <span class="me-accordion-copy"><strong>账号设置</strong><small>管理登录账号和修改密码</small></span>
          <span class="me-accordion-chevron">${icon('down', 17)}</span>
        </summary>
        <div class="me-accordion-panel page-me-account-settings" id="me-account-panel"></div>
      </details>

      <details class="me-accordion" data-me-accordion="messages">
        <summary class="me-accordion-head">
          <span class="me-accordion-icon">${icon('bell', 19)}</span>
          <span class="me-accordion-copy"><strong>消息中心</strong><small>${unread ? unread + ' 条未读消息' : '暂无未读消息'}</small></span>
          ${unread ? `<span class="me-accordion-badge">${unread > 99 ? '99+' : unread}</span>` : ''}
          <span class="me-accordion-chevron">${icon('down', 17)}</span>
        </summary>
        <div class="me-accordion-panel page-me-messages" id="me-messages-panel">
          <div class="empty" style="padding:18px">正在加载消息…</div>
        </div>
      </details>

      <details class="me-accordion" data-me-accordion="theme">
        <summary class="me-accordion-head">
          <span class="me-accordion-icon">${icon('sun', 19)}</span>
          <span class="me-accordion-copy"><strong>主题外观</strong><small>调整工作台整体颜色主题</small></span>
          <span class="me-accordion-summary-extra" id="me-theme-value">${esc(themeName(state.theme))}</span>
          <span class="me-accordion-chevron">${icon('down', 17)}</span>
        </summary>
        <div class="me-accordion-panel">
          <div class="me-inline-setting">
            <div><strong>当前主题：${esc(themeName(state.theme))}</strong><p>主题颜色会统一应用到首页、工作页面和个人中心。</p></div>
            <button type="button" class="btn primary" id="me-theme-open">${icon('sun', 15)} 更改外观</button>
          </div>
        </div>
      </details>

      <details class="me-accordion" data-me-accordion="wide">
        <summary class="me-accordion-head">
          <span class="me-accordion-icon">${icon('expand', 19)}</span>
          <span class="me-accordion-copy"><strong>页面显示</strong><small>设置工作台内容区域的显示宽度</small></span>
          <span class="me-accordion-summary-extra" id="me-wide-value">${wideEnabled ? '已开启平铺' : '舒适宽度'}</span>
          <span class="me-accordion-chevron">${icon('down', 17)}</span>
        </summary>
        <div class="me-accordion-panel">
          <div class="me-inline-setting">
            <div><strong>整页平铺</strong><p id="me-wide-description">${wideEnabled ? '当前已开启，页面内容铺满屏幕' : '当前已关闭，使用舒适内容宽度'}</p></div>
            <button type="button" class="btn primary" id="me-wide-toggle">${wideEnabled ? '恢复舒适宽度' : '开启整页平铺'}</button>
          </div>
        </div>
      </details>

      <details class="me-accordion" data-me-accordion="layout">
        <summary class="me-accordion-head">
          <span class="me-accordion-icon">${icon('grid', 19)}</span>
          <span class="me-accordion-copy"><strong>首页布局</strong><small>恢复首页卡片的默认排列</small></span>
          <span class="me-accordion-chevron">${icon('down', 17)}</span>
        </summary>
        <div class="me-accordion-panel">
          <div class="me-inline-setting">
            <div><strong>重置首页布局</strong><p>只恢复首页卡片排列，不会删除课程、事项或其他业务数据。</p></div>
            <button type="button" class="btn ghost" id="me-reset-layout">恢复默认布局</button>
          </div>
        </div>
      </details>

      <details class="me-accordion" data-me-accordion="logout">
        <summary class="me-accordion-head">
          <span class="me-accordion-icon danger">${icon('logout', 19)}</span>
          <span class="me-accordion-copy"><strong>退出登录</strong><small>安全退出当前工作台账号</small></span>
          <span class="me-accordion-chevron">${icon('down', 17)}</span>
        </summary>
        <div class="me-accordion-panel">
          <div class="me-inline-setting">
            <div><strong>退出当前账号</strong><p>退出后需要重新登录才能继续使用工作台。</p></div>
            <button type="button" class="btn danger" id="me-logout">退出登录</button>
          </div>
        </div>
      </details>
    </div>`;

  // 各设置模块复用原有表单与业务处理，只把容器放进可展开面板。
  renderProfile(main.querySelector('#me-profile-panel'), { inline: true });
  renderWorkbenchSettings(main.querySelector('#me-workbench-panel'), { inline: true });
  renderAccountSettings(main.querySelector('#me-account-panel'), { inline: true });
  renderMessages(main.querySelector('#me-messages-panel'), { inline: true });

  // 手动接管折叠行为：避免部分浏览器/页面样式下 details/summary 原生点击未切换。
  // 整个标题栏（包括最右侧箭头）都可点击；再次点击恢复收起。
  main.querySelectorAll('.me-accordion').forEach((section) => {
    const summary = section.querySelector(':scope > summary.me-accordion-head');
    if (!summary) return;
    summary.setAttribute('aria-expanded', String(section.open));
    summary.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      section.open = !section.open;
      summary.setAttribute('aria-expanded', String(section.open));
    });
  });

  const avatarButton = main.querySelector('#avatar-btn');
  if (avatarButton) avatarButton.onclick = () => avatarSheet();

  const identityCard = main.querySelector('#me-identity-card');
  const identityToggle = main.querySelector('#me-identity-toggle');
  if (identityToggle && identityCard) identityToggle.onclick = () => {
    const collapsed = identityCard.classList.toggle('is-collapsed');
    identityToggle.textContent = collapsed ? '展开' : '收起';
    identityToggle.setAttribute('aria-expanded', String(!collapsed));
  };

  const themeButton = main.querySelector('#me-theme-open');
  if (themeButton) themeButton.onclick = () => openThemeSheet();

  const wideButton = main.querySelector('#me-wide-toggle');
  if (wideButton) wideButton.onclick = async () => {
    const openSections = Array.from(main.querySelectorAll('.me-accordion[open]'))
      .map((section) => section.dataset.meAccordion);
    const enabled = setWideMode(!isWideMode());
    toast(enabled ? '已平铺整页，再点一次恢复舒适宽度' : '已恢复舒适宽度', 'ok', 3000);
    await render();
    const nextMain = document.getElementById('main');
    nextMain?.querySelectorAll('.me-accordion').forEach((section) => {
      section.open = openSections.includes(section.dataset.meAccordion);
    });
  };

  const resetButton = main.querySelector('#me-reset-layout');
  if (resetButton) resetButton.onclick = async () => {
    try {
      const m = await import('./home.js');
      await m.restoreHomeLayout();
      toast('首页布局已恢复默认', 'ok');
      go('home');
    } catch (e) {
      toast('重置首页布局失败：' + (e.message || e), 'err');
    }
  };

  const logoutButton = main.querySelector('#me-logout');
  if (logoutButton) logoutButton.onclick = async () => {
    if (await confirmDialog('确定退出登录？')) window.dispatchEvent(new Event('wb:signout'));
  };
}


function adminResetSheet() {
  const body = el(`<div class="sheet-body">
    <div class="tiny muted" style="line-height:1.7;margin-bottom:12px">
      输入已注册用户的手机号，系统会生成临时密码并立即替换原密码。密码仅在此页面显示一次，请通过私下渠道交给用户。
    </div>
    <div class="auth-input"><input id="admin-reset-phone" type="tel" inputmode="numeric" maxlength="11" placeholder="用户手机号"></div>
    <button class="auth-btn" id="admin-reset-go" style="margin-top:8px">生成临时密码</button>
    <div id="admin-reset-result" class="small" style="margin-top:12px;line-height:1.7"></div>
  </div>`);
  const sh = sheet({ title: '重置用户密码', body });
  const button = body.querySelector('#admin-reset-go');
  const result = body.querySelector('#admin-reset-result');
  button.onclick = async () => {
    const phone = body.querySelector('#admin-reset-phone').value.trim();
    if (!/^1[3-9]\d{9}$/.test(phone)) {
      result.textContent = '请输入正确的 11 位手机号';
      result.style.color = 'var(--red)';
      return;
    }
    button.disabled = true;
    button.textContent = '重置中…';
    result.textContent = '';
    try {
      const reset = await cloud.adminResetPassword(phone);
      result.style.color = 'var(--text)';
      result.innerHTML = `<div>临时密码（仅本次显示）</div>
        <code id="admin-reset-password" style="display:block;word-break:break-all;padding:10px;background:var(--bg2);border-radius:8px">${esc(reset.password)}</code>
        <button class="btn-sm" id="admin-reset-copy" style="margin-top:8px">复制密码</button>
        <div class="tiny muted" style="margin-top:8px">请立即私下转交给用户。为安全起见，不要在公开群聊中发送。</div>`;
      result.querySelector('#admin-reset-copy').onclick = async () => {
        try {
          await navigator.clipboard.writeText(reset.password);
          toast('临时密码已复制', 'ok');
        } catch {
          toast('复制失败，请手动选中临时密码复制', 'warn');
        }
      };
      button.hidden = true;
    } catch (e) {
      result.textContent = e.message || '重置失败';
      result.style.color = 'var(--red)';
      button.disabled = false;
      button.textContent = '生成临时密码';
    }
  };
}

const maskPhone = (p) => (p ? String(p).replace(/(\d{3})\d{4}(\d{4})/, '$1****$2') : '未绑定手机号');

/* 有头像就显示图片，没有就用首字 + 渐变底。
   slot=true 时额外打上 data-avatar-* 标记，供 refreshAvatarUI() 原地替换。

   【为什么要这个标记】
   换头像成功后如果走整页 render()，用户手输但还没保存的学校/学科/职务会一起没掉。
   正确做法是只把头像那个 span 换掉，其它 DOM 一动不动。
   可 avatarHTML() 一共被三处用（我的主页 74px、个人信息页 68px、换头像弹层里 96px 预览），
   尺寸/类名各不相同，靠选择器猜容易把弹层里的预览也换掉，
   所以让调用方显式声明「这块要能被刷新」。 */
function avatarHTML(u, size = 44, cls = '', slot = false) {
  const first = esc((u.nickname || '师').slice(0, 1));
  // data-avatar-* 只在 slot 模式下输出，避免污染弹层预览和列表里的一次性头像
  const mark = slot ? ` data-avatar-slot data-avatar-size="${size}" data-avatar-cls="${esc(cls)}"` : '';
  if (u.avatar) {
    return `<span class="avatar ${cls}"${mark} style="width:${size}px;height:${size}px">
      <img src="${esc(u.avatar)}" alt="头像" loading="lazy"></span>`;
  }
  return `<span class="avatar ${cls} avatar-fallback"${mark} style="width:${size}px;height:${size};font-size:${Math.round(size * 0.4)}px">${first}</span>`;
}

/* 只刷新页面上带 data-avatar-slot 的头像节点，不重建 DOM。

   换头像 / 移除头像调这里，不调 render()。
   注意替换的是 span 本身（outerHTML），但外层容器不动 ——
   「个人信息」页的点击事件绑在 #p-avatar 这个 button 上，
   button 不动，onclick 就还活着，换完还能接着点。 */
function refreshAvatarUI(u) {
  const nodes = document.querySelectorAll('[data-avatar-slot]');
  for (const node of nodes) {
    const size = Number(node.getAttribute('data-avatar-size')) || 44;
    const cls = node.getAttribute('data-avatar-cls') || '';
    node.outerHTML = avatarHTML(u, size, cls, true);
  }
  const profileRemove = document.querySelector('#p-avatar-remove');
  if (profileRemove) profileRemove.hidden = !u.avatar;
  // 弹层里的「移除头像」按钮：第一次上传后才该出现，移除后又要消失
  const del = document.querySelector('#av-del');
  if (del && !u.avatar) del.remove();
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
      /* 【这里原来调的是 render()，就是用户报的那个 bug】
         整页重绘会把用户手输但还没保存的学校/学科/职务冲掉。
         现在只换头像节点，输入框里的字一个都不碰。
         captureProfileDraft() 是为了兜住弹层开着时补一次快照 ——
         万一别处触发了整页重绘，草稿还能把字救回来。 */
      captureProfileDraft();
      refreshAvatarUI(r.user);
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
      // 同上：移除头像也不整页重绘
      captureProfileDraft();
      refreshAvatarUI(r.user);
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

/* ================= 个人信息页的输入草稿 =================
   【要解决什么】
   这四个输入框（昵称/学校/学科/职务）的 value 原本只从 state.user 取。
   只要中间发生一次整页 render()（app.innerHTML 重建整棵 DOM），
   用户刚敲进去、还没点保存的字就会全部变回旧值 ——
   用户看到的就是「上传照片把我填的信息清空了」。

   第一层修法是让换头像/移除头像不再整页重绘（见 refreshAvatarUI）。
   但整页重绘的入口不止一个：保存成功、改完密码返回、云同步重新登录回来、
   切主题、另一台设备推了 wb:remote……任何一个都会再冲一次。
   所以再加这一层：把输入框里的字实时镜像到 profileDraft，
   renderProfile 回填时优先用草稿。

   草稿什么时候清掉？
     · 保存成功（已经落盘了，草稿没用了）
     · 离开个人信息页（不能把上一页没保存的字带到下次进来）
   focusout 时不抓、input 时才抓 —— 因为 input 事件是「值真的变了」，
   而 focusout 只是「光标走了」，抓了会白存一份同样的值。 */
let profileDraft = null;
const PROFILE_FIELDS = ['nickname', 'school', 'subject', 'title', 'gender', 'contact_phone', 'grade_group'];

/* 把当前页面可编辑的个人资料字段快照到 profileDraft。
   页面不在个人信息页时不执行；未展示的邮箱字段不参与本次编辑。 */
function captureProfileDraft() {
  const box = document.querySelector('#f-nickname');
  if (!box) return;                       // 不在个人信息页
  const d = {};
  let any = false;
  for (const k of PROFILE_FIELDS) {
    const inp = document.querySelector('#f-' + k);
    if (!inp) continue;
    d[k] = inp.value;
    any = true;
  }
  if (any) profileDraft = d;
}


/* ================= 工作台设置 ================= */
function readWorkbenchBrand() {
  const db = loadLocalDB();
  const value = db?.meta?.workbenchBrand;
  return value && typeof value === 'object' ? value : { title: '', subtitle: '', image: '' };
}

async function renderWorkbenchSettings(main, { inline = false } = {}) {
  main.classList.add('page-me-workbench-settings');
  const stored = readWorkbenchBrand();
  // 直接读取后台工作台设计；兼容历史已保存配置，不要求额外启用标记。
  const current = stored;
  let image = typeof current.image === 'string' && /^data:image\/(png|jpeg|webp);base64,/i.test(current.image)
    ? current.image : '';
  const fallbackTitle = '我的工作台';
  const fallbackSubtitle = 'Workbench';
  const defaultBrandLogo = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="4.5" y="4.5" width="15" height="15" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 8v8M8 12h8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
  // 预览与侧栏使用同一默认品牌图标；自定义图片只在主动保存后生效。
  const logoMarkup = () => image
    ? '<img src="' + esc(image) + '" alt="工作台图标">'
    : defaultBrandLogo;

  main.innerHTML = (inline ? '' : mePageHeader('workbench')) +
    '<section class="card wb-brand-settings">' +
      '<header class="wb-brand-settings-head">' +
        '<div><h2>工作台品牌设置</h2><p>此处读取并设置后台工作台设计；未设置的项目自动使用系统默认值</p></div>' +
        '<span class="wb-brand-live"><i></i> 实时预览</span>' +
      '</header>' +
      '<div class="wb-brand-preview-area">' +
        '<div class="wb-brand-preview-label">左上角显示效果</div>' +
        '<div class="wb-brand-preview" id="wb-brand-preview">' +
          '<div class="wb-brand-preview-logo" id="wb-brand-preview-logo">' + logoMarkup() + '</div>' +
          '<div class="wb-brand-preview-copy">' +
            '<div class="wb-brand-preview-title" id="wb-brand-preview-title"></div>' +
            '<div class="wb-brand-preview-subtitle" id="wb-brand-preview-subtitle"></div>' +
          '</div>' +
        '</div>' +
        '<p class="wb-brand-preview-note">预览区域对应电脑端侧栏左上角的品牌名称、说明文字和图片。</p>' +
      '</div>' +
      '<div class="wb-brand-form">' +
        '<div class="field">' +
          '<label class="field-label" for="wb-brand-title">主标题 <span>（左上角名称）</span></label>' +
          '<input class="input" id="wb-brand-title" maxlength="40" placeholder="我的工作台" value="' + esc(current.title || '') + '">' +
        '</div>' +
        '<div class="field">' +
          '<label class="field-label" for="wb-brand-subtitle">副标题 <span>（左上角英文或说明）</span></label>' +
          '<input class="input" id="wb-brand-subtitle" maxlength="60" placeholder="Workbench" value="' + esc(current.subtitle || '') + '">' +
        '</div>' +
        '<div class="field wb-brand-image-field">' +
          '<label class="field-label">品牌图片 <span>（左上角图标）</span></label>' +
          '<div class="wb-brand-image-setting">' +
            '<div class="wb-brand-image-preview" id="wb-brand-image-preview">' + logoMarkup() + '</div>' +
            '<div class="wb-brand-image-controls">' +
              '<div class="wb-brand-image-actions">' +
                '<label class="btn soft" style="cursor:pointer">' + icon('upload', 15) + ' 上传图片' +
                  '<input id="wb-brand-image" type="file" accept="image/png,image/jpeg,image/webp" hidden>' +
                '</label>' +
                '<button class="btn ghost" id="wb-brand-remove-image" type="button">恢复默认图标</button>' +
              '</div>' +
              '<span class="tiny muted" id="wb-brand-image-hint">支持 JPG、PNG、WebP，建议正方形图片，最大 8MB，保存时自动压缩。</span>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<footer class="wb-brand-settings-footer">' +
        '<span class="wb-brand-tip">只修改左上角品牌展示，不会改变首页欢迎语、课表、考勤或其他业务数据。</span>' +
        '<button class="btn primary" id="wb-brand-save" type="button">' + icon('check', 16) + ' 保存设置</button>' +
      '</footer>' +
    '</section>';

  if (!inline) bindMeBackButton(main);
  const title = main.querySelector('#wb-brand-title');
  const subtitle = main.querySelector('#wb-brand-subtitle');
  const previewTitle = main.querySelector('#wb-brand-preview-title');
  const previewSubtitle = main.querySelector('#wb-brand-preview-subtitle');
  const previewLogo = main.querySelector('#wb-brand-preview-logo');
  const imagePreview = main.querySelector('#wb-brand-image-preview');
  const imageHint = main.querySelector('#wb-brand-image-hint');

  const paint = () => {
    previewTitle.textContent = title.value.trim() || fallbackTitle;
    previewSubtitle.textContent = subtitle.value.trim() || fallbackSubtitle;
    const markup = logoMarkup();
    previewLogo.innerHTML = markup;
    imagePreview.innerHTML = markup;
  };
  title.addEventListener('input', paint);
  subtitle.addEventListener('input', paint);
  paint();

  main.querySelector('#wb-brand-image').onchange = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
      toast('请上传 JPG、PNG 或 WebP 图片', 'warn');
      event.target.value = '';
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      toast('图片不能超过 8MB', 'warn');
      event.target.value = '';
      return;
    }
    imageHint.textContent = '图片处理中…';
    try {
      image = await new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
          try {
            const maxSide = 640;
            const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(img.width * scale));
            canvas.height = Math.max(1, Math.round(img.height * scale));
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            canvas.toBlob((blob) => {
              URL.revokeObjectURL(url);
              if (!blob) return reject(new Error('图片压缩失败'));
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result);
              reader.onerror = () => reject(new Error('图片读取失败'));
              reader.readAsDataURL(blob);
            }, 'image/jpeg', 0.82);
          } catch (err) { URL.revokeObjectURL(url); reject(err); }
        };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('无法读取这张图片')); };
        img.src = url;
      });
      imageHint.textContent = '图片已载入，保存后会显示在左上角';
      paint();
    } catch (err) {
      imageHint.textContent = '图片载入失败';
      toast(err.message || '图片处理失败', 'err');
    }
    event.target.value = '';
  };

  main.querySelector('#wb-brand-remove-image').onclick = () => {
    image = '';
    imageHint.textContent = '已恢复默认图标，保存后生效';
    paint();
  };

  main.querySelector('#wb-brand-save').onclick = () => {
    const db = loadLocalDB();
    if (!db.meta || typeof db.meta !== 'object') db.meta = {};
    db.meta.workbenchBrand = {
      title: title.value.trim().slice(0, 40),
      subtitle: subtitle.value.trim().slice(0, 60),
      image,
      updatedAt: new Date().toISOString(),
    };
    if (!saveLocalDB()) {
      toast('保存失败，请检查本机存储空间', 'err');
      return;
    }
    toast('工作台品牌设置已保存', 'ok');
    render();
  };
}

/* ================= 个人信息（独立页） ================= */
function mePageHeader(section) {
  const page = {
    profile: {
      title: '个人信息',
      description: '修改头像、姓名、学校、学科及职务等个人资料',
    },
    workbench: {
      title: '工作台设置',
      description: '设置左上角工作台名称、副标题和品牌图片',
    },
    account: {
      title: '账号设置',
      description: '管理登录账号、密码及账号安全信息',
    },
  }[section] || {
    title: '个人信息',
    description: '修改个人资料',
  };

  return '<div class="me-page-toolbar">' +
      '<button type="button" class="me-back-home" id="me-back-home"><span aria-hidden="true">←</span> 返回我的</button>' +
    '</div>' +
    pageHead(page.title, page.description);
}

function bindMeBackButton(main) {
  const back = main.querySelector('#me-back-home');
  if (back) back.onclick = () => go('me');
}

function meMessagesHeader(sub, actions = '') {
  return '<div class="me-page-toolbar">' +
    '<button type="button" class="me-back-home" id="me-back-home"><span aria-hidden="true">←</span> 返回我的</button>' +
    '</div>' +
    pageHead('消息中心', sub, actions);
}

function displayLoginAccount(value, fallback = '未设置') {
  const raw = String(value || '').trim();
  return raw ? (cloud.displayPhone(raw) || fallback) : fallback;
}

/* ================= 个人信息页 ================= */
async function renderProfile(main, { inline = false } = {}) {
  const u = state.user;
  if (!u) {
    main.innerHTML = '<div class="empty" style="padding:40px 20px">登录状态已过期，请刷新页面重新登录</div>';
    return;
  }
  main.classList.add('page-me-profile');
  const valueOf = (key) => profileDraft ? (profileDraft[key] ?? '') : (u[key] || '');
  const uv = (key) => esc(valueOf(key));
  // 旧资料中的「其他」按新选项统一显示为「保密」。
  const genderValue = valueOf('gender') === '其他' ? '保密' : valueOf('gender');
  const bannerName = valueOf('nickname') || '未设置昵称';
  const bannerMeta = [valueOf('title') || '教师', valueOf('grade_group')].filter(Boolean).join(' · ') || '完善个人资料，让工作台更懂你的工作';
  const session = cloud.session() || {};
  const account = u.account || session.phone || session.email || '未设置';

  main.innerHTML = (inline ? '' : mePageHeader('profile')) + `
    <section class="card profile-shell profile-shell-single">
      <header class="profile-banner ${inline ? 'profile-banner-inline' : ''}">
        <div class="profile-banner-content">
          <button id="p-avatar" class="profile-avatar-btn" type="button" title="更换头像">
            ${avatarHTML(u, 92, 'profile-avatar-image', true)}
            <span class="pa-tip">${icon('camera', 14)}</span>
          </button>
          <div class="profile-banner-info">
            <div class="profile-banner-name" id="profile-banner-name">${esc(bannerName)}</div>
            <div class="profile-banner-meta" id="profile-banner-meta">${esc(bannerMeta)}</div>
            <div class="profile-banner-hint">${inline ? '头像照片 · 支持 JPG / PNG，上传后首页头像同步显示' : '教师个人资料 · 仅用于工作台内展示'}</div>
          </div>
        </div>
        ${inline ? '<div class="profile-avatar-actions"><button type="button" class="btn primary sm" id="p-avatar-upload">上传照片</button><button type="button" class="btn ghost sm" id="p-avatar-remove" ' + (u.avatar ? '' : 'hidden') + '>移除</button></div>' : ''}
      </header>

      <div class="profile-content">
        <div class="profile-section-title"><span></span>基本信息</div>
        <div class="profile-fields">
          <div class="field profile-field-name">
            <label class="field-label" for="f-nickname">姓名 <b class="required-mark">*</b></label>
            <input class="input" id="f-nickname" maxlength="20" value="${uv('nickname')}" placeholder="请输入姓名">
          </div>
          <div class="field profile-field-gender">
            <label class="field-label" for="f-gender">性别</label>
            <select class="input" id="f-gender">
              <option value="" ${!genderValue ? 'selected' : ''}>请选择</option>
              <option value="男" ${genderValue === '男' ? 'selected' : ''}>男</option>
              <option value="女" ${genderValue === '女' ? 'selected' : ''}>女</option>
              <option value="保密" ${genderValue === '保密' ? 'selected' : ''}>保密</option>
            </select>
          </div>
          <div class="field profile-field-phone">
            <label class="field-label" for="f-contact_phone">联系电话</label>
            <input class="input" id="f-contact_phone" type="tel" maxlength="24" value="${uv('contact_phone') || uv('phone')}" placeholder="请输入联系电话" autocomplete="tel">
          </div>
          <div class="field profile-field-subject">
            <label class="field-label" for="f-subject">学科</label>
            <input class="input" id="f-subject" maxlength="20" value="${uv('subject')}" placeholder="如：信息技术">
          </div>
          <div class="field profile-field-title">
            <label class="field-label" for="f-title">职务</label>
            <input class="input" id="f-title" maxlength="30" value="${uv('title')}" placeholder="如：教师">
          </div>
          <div class="field profile-field-grade">
            <label class="field-label" for="f-grade_group">所属年级组</label>
            <input class="input" id="f-grade_group" maxlength="30" value="${uv('grade_group')}" placeholder="如：高二年级组">
          </div>
        </div>

        <section class="profile-work-section" aria-labelledby="profile-work-title">
          <div class="profile-section-title" id="profile-work-title"><span></span>工作信息</div>
          <div class="profile-work-field">
            <label class="field-label" for="f-school">所在学校</label>
            <input class="input" id="f-school" maxlength="50" value="${uv('school')}" placeholder="请输入学校名称">
          </div>
        </section>

        <div class="profile-save-row">
          <div class="profile-save-note">修改完成后点击保存，资料会自动同步。</div>
          <button class="btn primary" id="p-save" type="button">${icon('check', 16)} 保存</button>
        </div>
      </div>
    </section>`;

  if (!inline) bindMeBackButton(main);

  const updateBanner = () => {
    const nickname = main.querySelector('#f-nickname').value.trim() || '未设置昵称';
    const title = main.querySelector('#f-title').value.trim() || '教师';
    const grade = main.querySelector('#f-grade_group').value.trim();
    main.querySelector('#profile-banner-name').textContent = nickname;
    main.querySelector('#profile-banner-meta').textContent = [title, grade].filter(Boolean).join(' · ');
    const homeName = document.querySelector('#me-identity-name');
    const homeMeta = document.querySelector('#me-identity-meta');
    const homeRole = document.querySelector('#me-identity-role');
    if (homeName) homeName.textContent = nickname;
    if (homeMeta) homeMeta.textContent = [main.querySelector('#f-school').value.trim(), main.querySelector('#f-subject').value.trim()].filter(Boolean).join(' · ') || '完善个人资料，让工作台更懂你的工作';
    if (homeRole) homeRole.textContent = [title, grade].filter(Boolean).join(' · ');
  };

  for (const key of ['nickname', 'school', 'subject', 'title', 'gender', 'contact_phone', 'grade_group']) {
    const input = main.querySelector('#f-' + key);
    if (!input) continue;
    input.addEventListener('input', updateBanner);
    input.addEventListener('change', updateBanner);
    input.addEventListener('input', () => {
      if (!profileDraft) profileDraft = {};
      profileDraft[key] = input.value;
    });
  }

  const avatarButton = main.querySelector('#p-avatar');
  const snapshot = () => captureProfileDraft();
  avatarButton.addEventListener('mousedown', snapshot);
  avatarButton.addEventListener('touchstart', snapshot, { passive: true });
  avatarButton.onclick = () => { snapshot(); avatarSheet(); };
  const uploadButton = main.querySelector('#p-avatar-upload');
  if (uploadButton) uploadButton.onclick = () => { snapshot(); avatarSheet(); };
  const removeButton = main.querySelector('#p-avatar-remove');
  if (removeButton) removeButton.onclick = async () => {
    if (!state.user?.avatar) return;
    if (!(await confirmDialog('移除当前头像？', { danger: true, okText: '移除' }))) return;
    snapshot();
    removeButton.disabled = true;
    try {
      const result = await api.del('/me/avatar');
      state.user = result.user;
      refreshAvatarUI(result.user);
      removeButton.hidden = true;
      toast('已移除头像', 'ok');
    } catch (error) {
      toast(error.message || '移除头像失败，请稍后再试', 'err');
    } finally {
      removeButton.disabled = false;
    }
  };

  main.querySelector('#p-save').onclick = async (event) => {
    const button = event.currentTarget;
    const nickname = main.querySelector('#f-nickname').value.trim();
    if (!nickname) {
      toast('姓名不能为空，请填写姓名', 'warn');
      main.querySelector('#f-nickname').focus();
      return;
    }
    button.disabled = true;
    button.textContent = '保存中…';
    const payload = {};
    for (const key of ['nickname', 'school', 'subject', 'title', 'gender', 'contact_phone', 'grade_group']) {
      payload[key] = main.querySelector('#f-' + key).value.trim();
    }
    try {
      const result = await api.patch('/me', payload);
      state.user = result.user;
      profileDraft = null;
      toast('个人信息已保存', 'ok');
      render();
    } catch (error) {
      toast(error.message || '保存失败', 'err');
      button.disabled = false;
      button.innerHTML = icon('check', 16) + ' 保存';
    }
  };
}

/* ================= 账号设置页 ================= */
function renderAccountSettings(main, { inline = false } = {}) {
  const u = state.user;
  if (!u) {
    main.innerHTML = '<div class="empty" style="padding:40px 20px">登录状态已过期，请刷新页面重新登录</div>';
    return;
  }
  main.classList.add('page-me-account-settings');
  const session = cloud.session() || {};
  const account = displayLoginAccount(u.account || session.phone || u.phone || session.email);
  main.innerHTML = (inline ? '' : mePageHeader('account')) + `
    <section class="card account-security-shell">
      <header class="account-security-banner">
        <span class="account-security-banner-icon">${icon('shield', 42)}</span>
        <div class="account-security-banner-copy">
          <div class="account-security-banner-title">账号设置</div>
          <div class="account-security-banner-subtitle">管理您的登录账号、密码及账号安全信息</div>
        </div>
      </header>

      <div class="account-security-content">
        <button class="account-security-row account-security-login-row" id="account-login-change" type="button">
          <span class="account-security-row-icon">${icon('phone', 26)}</span>
          <span class="account-security-row-copy">
            <strong>登录账号</strong>
            <small>点击修改用于登录系统的11位数字账号</small>
          </span>
          <span class="account-security-row-value">${esc(account)}</span>
          <span class="account-security-chevron" aria-hidden="true">${icon('right', 18)}</span>
        </button>

        <button class="account-security-row account-security-password-row" id="account-password-change" type="button">
          <span class="account-security-row-icon">${icon('lock', 26)}</span>
          <span class="account-security-row-copy">
            <strong>修改密码</strong>
            <small>更新登录密码，保障账号安全</small>
          </span>
          <span class="account-security-chevron" aria-hidden="true">${icon('right', 18)}</span>
        </button>

        <div class="account-security-art" aria-hidden="true">
          <span class="account-security-orbit"></span>
          <span class="account-security-orbit account-security-orbit-inner"></span>
          <span class="account-security-shield">${icon('shield', 62)}<i>${icon('lock', 24)}</i></span>
        </div>
        <div class="account-security-caption">账号安全 · 个人隐私 · 数据保护</div>
      </div>
    </section>`;

  if (!inline) bindMeBackButton(main);
  main.querySelector('#account-login-change').onclick = () => accountLoginSheet();
  main.querySelector('#account-password-change').onclick = () => accountPwdSheet(null);
}

/* ================= 修改登录账号 ================= */
function accountLoginSheet() {
  const currentAccount = displayLoginAccount(state.user?.account || cloud.session()?.phone, '');
  const body = el(`<div class="sheet-body">
    <div class="account-login-current">
      <span class="tiny muted">当前登录账号</span>
      <strong>${esc(currentAccount)}</strong>
    </div>
    <div class="field">
      <label class="field-label" for="account-new">新的登录账号</label>
      <input class="input" id="account-new" type="text" inputmode="numeric" autocomplete="off"
        maxlength="11" placeholder="请输入新的11位数字账号">
    </div>
    <div class="field">
      <label class="field-label" for="account-new-confirm">确认新账号</label>
      <input class="input" id="account-new-confirm" type="text" inputmode="numeric" autocomplete="off"
        maxlength="11" placeholder="请再次输入新的11位数字账号">
    </div>
    <div class="field">
      <label class="field-label" for="account-current-password">当前登录密码</label>
      <input class="input" id="account-current-password" type="password" autocomplete="current-password"
        maxlength="72" placeholder="请输入当前登录密码">
    </div>
    <div class="tiny muted" style="line-height:1.7;margin:4px 0 12px">
      修改后，其他设备需要使用新的账号和原密码登录。不会发送短信，原有个人资料、权限和工作台数据都会保留。
    </div>
    <button class="btn primary block" id="account-login-save" type="button">确认修改</button>
  </div>`);
  const sh = sheet({ title: '修改登录账号', body });
  const field = (id) => body.querySelector('#' + id);
  const save = field('account-login-save');

  save.onclick = async () => {
    const next = field('account-new').value.trim();
    const confirm = field('account-new-confirm').value.trim();
    const password = field('account-current-password').value;
    if (!/^1[3-9]\d{9}$/.test(next)) {
      toast('新登录账号必须是11位数字，请检查后重试', 'warn');
      field('account-new').focus();
      return;
    }
    if (next === currentAccount) {
      toast('新账号不能与当前账号相同', 'warn');
      return;
    }
    if (next !== confirm) {
      toast('两次输入的新账号不一致，请重新确认', 'warn');
      field('account-new-confirm').focus();
      return;
    }
    if (!password) {
      toast('请输入当前登录密码', 'warn');
      field('account-current-password').focus();
      return;
    }
    if (!cloud.session()?.uid) {
      toast('当前账号尚未连接云端认证，暂时无法安全修改登录账号', 'err', 6000);
      return;
    }

    save.disabled = true;
    save.textContent = '正在验证并修改…';
    try {
      const changed = await cloud.changeLoginAccount(next, password);
      const local = await api.post('/auth/login-cloud', {
        account: next,
        phone: changed.phone,
        uid: changed.uid,
        email: cloud.session()?.email || '',
      }, { silent: true });
      if (!local?.user || local.user.account !== next) {
        throw new Error('云端账号已更新，本机资料正在重新同步；请刷新页面确认');
      }
      state.user = local.user;
      toast('登录账号修改成功，原有数据和权限均已保留', 'ok', 5000);
      sh.close();
      render();
    } catch (error) {
      save.disabled = false;
      save.textContent = '确认修改';
      toast(error.message || '修改登录账号失败，请稍后重试', 'err', 6000);
    }
  };

  body.querySelectorAll('input').forEach((input) => {
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') save.click();
    });
  });
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
    ${bindRow('account', `${icon('user', 15)} 登录账号`, displayLoginAccount(u.account), !!u.account, false, '改密码')}
    <div class="tiny muted" style="margin-top:12px;line-height:1.7">
      登录账号由 Supabase 管理。修改密码时需要验证当前密码；忘记密码请联系管理员重置。
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

/* 修改 Supabase 手机号账号的密码，并先重新验证当前密码。 */
function accountPwdSheet(parent) {
  const b = el(`<div class="sheet-body">
    <div class="tiny muted" style="margin-bottom:10px;line-height:1.7">
      当前账号 <b>${esc(displayLoginAccount(state.user?.account || cloud.session()?.phone, ''))}</b>。修改后请使用新密码登录其他设备。
    </div>
    <div class="field"><label class="field-label">原密码</label>
      <input class="input" id="op" type="password" autocomplete="current-password" maxlength="72" placeholder="当前密码"></div>
    <div class="field"><label class="field-label">新密码</label>
      <input class="input" id="np" type="password" autocomplete="new-password" maxlength="72" placeholder="至少 8 位"></div>
    <div class="field"><label class="field-label">再输一遍</label>
      <input class="input" id="np2" type="password" autocomplete="new-password" maxlength="72" placeholder="确认新密码"></div>
    <button class="btn primary block" id="pw-save" style="margin-top:6px">保存新密码</button>
  </div>`);
  const sh = sheet({ title: '修改密码', body: b });
  b.querySelector('#pw-save').onclick = async () => {
    const op = b.querySelector('#op').value;
    const np = b.querySelector('#np').value;
    const np2 = b.querySelector('#np2').value;
    if (!op) return toast('请填写原密码', 'warn');
    if (np.length < 8) return toast('新密码至少 8 位', 'warn');
    if (np !== np2) return toast('两次输入的新密码不一致', 'warn');
    const btn = b.querySelector('#pw-save');
    btn.disabled = true; btn.textContent = '保存中…';
    try {
      await cloud.updatePhonePassword(op, np);
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
  /* 【注册时云端那一步没成的，在这里如实说】
     以前这种情况会在注册成功后弹一条 9 秒的警告，人已经进了工作台，
     右上角却挂着一句"云端开关还关着"，看起来像注册失败。
     现在不弹了，改成在这里标一下 —— 想知道的人点进「云同步」能看明白，
     不想管的人完全不会被打扰。 */
  let st = '';
  try { st = localStorage.getItem('wb_signup_cloud_state') || ''; } catch { }
  if (st === 'off') {
    return '<span class="chip" style="background:#FEF3C7;color:#92400E">云端注册未开</span>';
  }
  if (st === 'need_confirm') {
    return '<span class="chip" style="background:#FEF3C7;color:#92400E">待邮箱确认</span>';
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
async function renderMessages(main, { inline = false } = {}) {
  // 消息中心使用主内容区全宽，不继承个人信息页的窄版布局。
  main.classList.add('page-me-messages');
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
      main.innerHTML = (inline ? '' : meMessagesHeader('', ''))
        + `<div class="empty" style="padding:40px 20px">${esc(e.message || '加载失败')}<br>
           <span class="tiny muted">如果是登录过期，刷新页面重新登录即可</span></div>`;
      if (!inline) bindMeBackButton(main);
      return;
    }
    const counts = r.counts || {};
    const rows = r.rows || [];
    main.innerHTML = (inline ? '' : meMessagesHeader(r.unread ? `${r.unread} 条未读` : '都看完了',
      `<button class="btn ghost sm" id="read-all" ${r.unread ? '' : 'disabled'}>全部已读</button>`)) + `
      <div class="seg msg-seg" style="margin-bottom:14px">
        ${TYPES.map(([v, l]) => `<button class="${type === v ? 'on' : ''}" data-t="${v}">${l}${counts[v] ? `<b class="seg-dot">${counts[v]}</b>` : ''}</button>`).join('')}
      </div>
      <div class="card">${rows.length ? rows.map((m) => msgItem(m)).join('') : '<div class="empty">这里还没有消息<br><span class="tiny">事项到期、系统变更时会出现</span></div>'}</div>
      ${rows.length ? '<button class="btn ghost block" id="clear-read" style="margin-top:12px">清空已读消息</button>' : ''}`;
    if (!inline) bindMeBackButton(main);

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
