/* ================= 自习（第 22 条） =================
   为什么要单独一页，而不是塞进「上课」：
     看自习是每周都会发生的事（晚自习、早读、周末自习），但它不是上课——
     没有备课、没有讲课、通常也不计课时费。记进「上课」会把课时费和统计口径弄脏：
     本月实际课时凭空变多，对账时又对不上钱。
     记进「考勤」也不对，考勤记的是「学生到没到」，这里要记的是「我看了哪一节、做了什么」。
   所以单独一张表、单独一页，口径各自独立，互不污染。 */
import {
  api, el, esc, toast, sheet, confirmDialog, ymd, fmtDateTime, studentUrl, shortPath,
} from './core.js';
import { registerView, icon, pageHead, state } from './ui.js';

/* 单独占一个视图名还保留着，是为了 #/selfstudy 这种老链接能落到正确的地方；
   实际渲染走 render() 里的 translate，这里只做兜底。 */
registerView(async function selfstudy(main, ctx) {
  main.innerHTML = pageHead('自习', '晚自习、早读、周末自习——记哪个班、第几节、做了什么');
  const box = el('<div id="ss-body"></div>');
  main.appendChild(box);
  return renderSelfstudyBody(box, ctx);
});

export async function renderSelfstudyBody(box, ctx = {}) {
  /* 这一页有两个身份：
       ① 学生页面里的「自习」模块配置（从「课件 → 自习」进来）
       ② 老师自己记自习（从旧的一级导航进来）
     两者的数据不是一回事：①配置的是 student.html 上那个签到模块，
     ②记的是我看了哪个班的自习、多长、算不算课时。所以顶部给一道切换，
     默认落在 ①（因为二级/三级导航点进来的都是 i）。 */
  let mode = ctx.studentTab ? 'student' : 'mine';
  const tabs = el(`<div class="seg" style="margin-bottom:14px">
    <button data-m="student" class="${mode === 'student' ? 'on' : ''}">学生页面里的自习</button>
    <button data-m="mine" class="${mode === 'mine' ? 'on' : ''}">我自己看的自习</button>
  </div>`);
  const pane = el('<div></div>');
  box.innerHTML = '';
  box.appendChild(tabs);
  box.appendChild(pane);
  tabs.querySelectorAll('[data-m]').forEach((b) => {
    b.onclick = () => {
      mode = b.dataset.m;
      tabs.querySelectorAll('[data-m]').forEach((x) => x.classList.toggle('on', x === b));
      paint();
    };
  });
  const paint = () => {
    if (mode === 'student') return renderStudentSelfstudy(pane);
    return renderMySelfstudy(pane);
  };
  return paint();
}

/* ---------- ① 学生页面里的自习模块 ----------
   学生打开短链后，如果老师开了自习签到，顶部会出现「签到」页，点「我到了」。
   老师这边能做的只有三件事：开一场、看谁到了、结束。
   配置项（是否需要学生填姓名、是否允许迟到）存在 link.settings 上。 */
async function renderStudentSelfstudy(box) {
  const [links, sessions, rosters] = await Promise.all([
    api.get('/links').catch(() => []),
    api.get('/roll/sessions').catch(() => []),
    api.get('/rosters').catch(() => []),
  ]);
  const link = links[0];
  const open = sessions.filter((s) => s.status === 'open');
  const today = sessions.filter((s) => String(s.date || '') === ymd(new Date()));
  box.innerHTML = `
    <div class="card card-pad" style="margin-bottom:14px">
      <div class="card-title">${icon('route', 16)} 学生看到的入口</div>
      ${link
      ? `<div class="row wrap" style="gap:10px;margin-top:8px">
             <code class="mono link-short" id="ss-link">${esc(shortPath(link.code))}</code>
             <button class="btn ghost sm" id="ss-copy">${icon('copy', 14)} 复制链接</button>
             <a class="btn ghost sm" href="${esc(studentUrl(link.code))}" target="_blank" rel="noopener">打开看看</a>
           </div>
           <div class="field-hint" style="margin-top:8px">学生打开这个链接，顶部就有「自习」页；没有进行中的签到时，页面会显示「现在没有在进行的签到」。</div>`
      : `<div class="empty" style="padding:18px">还没有生成学生链接。<button class="btn primary sm" id="ss-mklink">生成一条</button></div>`}
    </div>

    <div class="ss-stats mod-stats">
      <div class="card card-pad ss-stat"><div class="ss-k">进行中</div>
        <div class="ss-v" style="color:${open.length ? 'var(--green)' : 'var(--text)'}">${open.length}<span class="ss-u">场</span></div>
        <div class="tiny muted">${open.length ? '学生正在点「我到了」' : '点下面开始一场'}</div></div>
      <div class="card card-pad ss-stat"><div class="ss-k">今天开了</div>
        <div class="ss-v">${today.length}<span class="ss-u">场</span></div>
        <div class="tiny muted">含已结束的</div></div>
      <div class="card card-pad ss-stat"><div class="ss-k">名单</div>
        <div class="ss-v">${rosters.length}<span class="ss-u">个班</span></div>
        <div class="tiny muted">${rosters.slice(0, 2).map((r) => esc(r.class_name)).join('、') || '还没有班级名单'}</div></div>
    </div>

    <div class="row wrap" style="gap:8px;margin:16px 0 10px">
      <button class="btn primary sm" id="ss-open">${icon('play', 15)} 开始自习签到</button>
      <span style="flex:1"></span>
      <span class="tiny muted">学生端每 3 秒刷新一次人数</span>
    </div>

    <div class="card" id="ss-sess">${open.length || today.length ? '' : '<div class="empty">今天还没有自习签到</div>'}</div>`;

  box.querySelector('#ss-copy')?.addEventListener('click', async () => {
    const url = studentUrl(link.code);
    try { await navigator.clipboard.writeText(url); toast('已复制，发到班级群就行'); } catch { prompt('复制下面的链接', url); }
  });
  box.querySelector('#ss-mklink')?.addEventListener('click', async () => {
    await api.post('/links', { title: '班级资料站' }).catch(() => { });
    renderStudentSelfstudy(box);
  });
  box.querySelector('#ss-open')?.addEventListener('click', () => openRollDialog(rosters, () => renderStudentSelfstudy(box)));

  /* 场次列表 */
  const list = (open.length ? open : today).slice(0, 6);
  const wrapBox = box.querySelector('#ss-sess');
  wrapBox.innerHTML = list.map((s) => {
    const st = s.stats || {};
    const came = (st.present || 0) + (st.late || 0);
    return `<div class="list-item">
      <div class="doc-ico">${icon('clock', 17)}</div>
      <div style="flex:1;min-width:0">
        <div class="row wrap" style="gap:8px"><span class="bold">${esc(s.class_name || s.grade || '未填班级')}</span>
          ${s.status === 'open' ? '<span class="chip green">进行中</span>' : '<span class="chip">已结束</span>'}
          ${s.period_no ? `<span class="chip blue">第 ${s.period_no} 节</span>` : ''}</div>
        <div class="tiny muted">${esc(String(s.date || ''))} · 应到 ${s.expect || '-'} · 已到 ${came}</div>
      </div>
      <button class="btn ghost sm" data-detail="${s.id}">看名单</button>
      ${s.status === 'open' ? `<button class="btn ghost sm" data-close="${s.id}">结束</button>` : ''}
    </div>`;
  }).join('') || '<div class="empty">今天还没有自习签到</div>';

  wrapBox.querySelectorAll('[data-detail]').forEach((b) => {
    b.onclick = () => rollDetail(Number(b.dataset.detail), () => renderStudentSelfstudy(box));
  });
  wrapBox.querySelectorAll('[data-close]').forEach((b) => {
    b.onclick = async () => {
      if (!(await confirmDialog('结束这场自习签到？结束后学生就点不了了，记录会保留。'))) return;
      await api.patch('/roll/sessions/' + b.dataset.close, { status: 'closed' });
      toast('已结束');
      renderStudentSelfstudy(box);
    };
  });
}

/* ---------- ② 我自己看的自习（原来的记录页） ---------- */
async function renderMySelfstudy(box) {
  let rows = [];
  let month = ymd(new Date()).slice(0, 7);

  const load = async () => {
    box.innerHTML = `<div class="empty">加载中…</div>`;
    try {
      rows = await api.get('/selfstudy');
    } catch (e) {
      box.innerHTML = `<div class="empty">${esc(e.message || '加载失败')}<br>
        <span class="tiny muted">如果是登录过期，刷新页面重新登录即可</span></div>`;
      return;
    }
    paint();
  };

  const inMonth = () => rows.filter((r) => String(r.date || '').startsWith(month));

  const paint = () => {
    const list = inMonth();
    const totalMin = list.reduce((s, r) => s + (Number(r.minutes) || 0), 0);
    const classes = new Set(list.map((r) => `${r.grade || ''}${r.class_name || ''}`).filter(Boolean));
    const billMin = list.filter((r) => Number(r.billable)).reduce((s, r) => s + (Number(r.minutes) || 0), 0);
    const hours = (m) => (Math.round((m / 60) * 10) / 10).toLocaleString('zh-CN');

    box.innerHTML = `
      <div class="ss-stats">
        <div class="card card-pad ss-stat"><div class="ss-k">本月自习</div>
          <div class="ss-v">${list.length}<span class="ss-u">次</span></div>
          <div class="tiny muted">${hours(totalMin)} 小时</div></div>
        <div class="card card-pad ss-stat"><div class="ss-k">覆盖班级</div>
          <div class="ss-v">${classes.size}<span class="ss-u">个</span></div>
          <div class="tiny muted">${classes.size ? [...classes].slice(0, 3).join('、') : '还没有记录'}</div></div>
        <div class="card card-pad ss-stat"><div class="ss-k">计课时部分</div>
          <div class="ss-v">${hours(billMin)}<span class="ss-u">小时</span></div>
          <div class="tiny muted">默认不计，需要时手动打勾</div></div>
      </div>

      <div class="row wrap" style="gap:8px;margin:14px 0 10px">
        <input class="input" type="month" id="ss-month" value="${month}" style="max-width:160px;height:34px">
        <span style="flex:1"></span>
        <span class="tiny muted">共 ${list.length} 条</span>
      </div>

      <div class="card" style="overflow:hidden">
        ${list.length ? `<div class="ss-list">${list.map(rowHTML).join('')}</div>` : `
          <div class="empty" style="padding:36px 20px">
            <div class="em">${icon('clock', 32)}</div>
            这个月还没有自习记录
            <div class="tiny muted" style="margin-top:6px">点右上角「记一次自习」，半分钟就填完</div>
          </div>`}
      </div>`;

    const mi = box.querySelector('#ss-month');
    if (mi) mi.onchange = () => { month = mi.value || month; paint(); };
    box.querySelectorAll('[data-ss-edit]').forEach((b) => {
      b.onclick = () => editor(rows.find((x) => String(x.id) === b.dataset.ssEdit));
    });
    box.querySelectorAll('[data-ss-del]').forEach((b) => {
      b.onclick = async () => {
        const r = rows.find((x) => String(x.id) === b.dataset.ssDel);
        if (!await confirmDialog(`删除 ${r.date} ${clsOf(r)} 这条自习记录？删除后可以在回收站找回。`)) return;
        try { await api.del('/selfstudy/' + r.id); toast('已删除'); load(); }
        catch (e) { toast(e.message || '删除失败', 'err'); }
      };
    });
  };

  const clsOf = (r) => {
    const g = String(r.grade || '').trim();
    const c = String(r.class_name || '').trim();
    if (!g) return c || '未填班级';
    if (!c) return g;
    return c.startsWith(g) ? c : g + ' ' + c;
  };

  const rowHTML = (r) => `<div class="ss-row">
    <div class="ss-no">${esc(r.seq || '—')}</div>
    <div class="ss-main">
      <div class="ss-t">
        <b>${esc(clsOf(r))}</b>
        ${r.period_no ? `<span class="chip blue">第${esc(r.period_no)}节</span>` : ''}
        ${r.subject ? `<span class="chip grey">${esc(r.subject)}</span>` : ''}
        ${Number(r.billable) ? '<span class="chip green">计课时</span>' : ''}
      </div>
      <div class="ss-sub">
        <span class="mono">${esc(r.date || '')}</span>
        ${r.start_time || r.end_time ? `<span>· ${esc(r.start_time || '')}${r.end_time ? '–' + esc(r.end_time) : ''}</span>` : ''}
        ${Number(r.minutes) ? `<span>· ${esc(r.minutes)} 分钟</span>` : ''}
      </div>
      ${r.content ? `<div class="ss-content">${esc(r.content)}</div>` : ''}
      ${r.absent ? `<div class="tiny" style="color:var(--amber);margin-top:4px">缺勤：${esc(r.absent)}</div>` : ''}
      ${r.remark ? `<div class="lc-remark">${icon('edit', 12)} ${esc(r.remark)}</div>` : ''}
    </div>
    <div class="ss-ops">
      <button class="icon-btn sm" data-ss-edit="${r.id}" title="修改">${icon('edit', 15)}</button>
      <button class="icon-btn sm danger" data-ss-del="${r.id}" title="删除">${icon('trash', 15)}</button>
    </div>
  </div>`;

  async function editor(row) {
    const isNew = !row;
    const today = ymd(new Date());
    const body = document.createElement('div');
    body.className = 'sheet-body';
    body.innerHTML = `
      <div class="form-grid">
        <div class="field"><label class="field-label">日期</label>
          <input class="input" id="d" type="date" value="${esc(row?.date || today)}"></div>
        <div class="field"><label class="field-label">第几节 <span class="tiny muted">（选填）</span></label>
          <input class="input" id="p" type="number" min="1" max="12" value="${esc(row?.period_no ?? '')}" placeholder="如 8"></div>
      </div>
      <div class="form-grid">
        <div class="field"><label class="field-label">年级</label>
          <input class="input" id="g" value="${esc(row?.grade || '')}" placeholder="如 高二"></div>
        <div class="field"><label class="field-label">班级</label>
          <input class="input" id="c" value="${esc(row?.class_name || '')}" placeholder="如 (3)班"></div>
      </div>
      <div class="form-grid">
        <div class="field"><label class="field-label">开始</label>
          <input class="input" id="st" type="time" value="${esc(row?.start_time || '')}"></div>
        <div class="field"><label class="field-label">结束</label>
          <input class="input" id="et" type="time" value="${esc(row?.end_time || '')}"></div>
        <div class="field"><label class="field-label">时长（分钟）</label>
          <input class="input" id="m" type="number" min="0" max="600" value="${esc(row?.minutes || '')}" placeholder="自动算"></div>
      </div>
      <div class="field"><label class="field-label">看哪科 <span class="tiny muted">（选填）</span></label>
        <input class="input" id="s" value="${esc(row?.subject || '')}" placeholder="如 数学 / 综合"></div>
      <div class="field"><label class="field-label">做了什么</label>
        <textarea class="input" id="ct" rows="2" placeholder="如：做卷子，讲了几道题，整体比较安静">${esc(row?.content || '')}</textarea></div>
      <div class="field"><label class="field-label">缺勤的人 <span class="tiny muted">（选填）</span></label>
        <input class="input" id="ab" value="${esc(row?.absent || '')}" placeholder="如：小明、小红请假"></div>
      <div class="field"><label class="field-label">备注</label>
        <input class="input" id="rm" value="${esc(row?.remark || '')}" placeholder="有什么要补充的？直接在这里写"></div>
      <label class="ss-bill"><input type="checkbox" id="bl" ${Number(row?.billable) ? 'checked' : ''}>
        <span>这次自习计入课时费 <span class="tiny muted">（默认不计；学校单独算自习费时才勾）</span></span></label>
      <div class="confirm-actions">
        ${row ? '<button class="btn ghost" id="del" style="color:var(--red);margin-right:auto">删除</button>' : ''}
        <button class="btn ghost" id="cancel">取消</button>
        <button class="btn primary" id="ok">保存</button>
      </div>`;
    const s = sheet({ title: isNew ? '记一次自习' : '修改自习记录', body, wide: true });
    const $ = (id) => body.querySelector('#' + id);

    // 填了起止时间就自动算时长，省掉一次心算
    const autoMin = () => {
      const a = $('st').value; const b = $('et').value;
      if (!a || !b) return;
      const [h1, m1] = a.split(':').map(Number);
      const [h2, m2] = b.split(':').map(Number);
      let diff = (h2 * 60 + m2) - (h1 * 60 + m1);
      if (diff < 0) diff += 24 * 60;
      if (diff > 0) $('m').value = diff;
    };
    $('st').oninput = autoMin; $('et').oninput = autoMin;

    $('cancel').onclick = s.close;
    $('del')?.addEventListener('click', async () => {
      if (await confirmDialog('删除这条自习记录？')) {
        try { await api.del('/selfstudy/' + row.id); s.close(); toast('已删除'); load(); }
        catch (e) { toast(e.message, 'err'); }
      }
    });
    $('ok').onclick = async () => {
      const payload = {
        date: $('d').value || today,
        period_no: Number($('p').value) || null,
        grade: $('g').value.trim(),
        class_name: $('c').value.trim(),
        start_time: $('st').value,
        end_time: $('et').value,
        minutes: Number($('m').value) || 0,
        subject: $('s').value.trim(),
        content: $('ct').value.trim(),
        absent: $('ab').value.trim(),
        billable: $('bl').checked ? 1 : 0,
        remark: $('rm').value.trim(),
      };
      if (!payload.grade && !payload.class_name) return toast('至少填一下班级', 'warn');
      const btn = $('ok'); btn.disabled = true; btn.textContent = '保存中…';
      try {
        if (isNew) await api.post('/selfstudy', payload);
        else await api.patch('/selfstudy/' + row.id, payload);
        s.close(); toast('已保存'); load();
      } catch (e) {
        btn.disabled = false; btn.textContent = '保存';
        toast(e.message || '保存失败', 'err');
      }
    };
  }

  /* 「记一次自习」按钮原来挂在页头上，现在页头由 work.js 统一画，
     按钮挪到正文里，靠 id 绑定。 */
  const newBtn = el(`<div class="row wrap" style="gap:8px;margin:0 0 12px">
    <button class="btn primary sm" id="ss-new">${icon('plus', 15)} 记一次自习</button>
    <span class="tiny muted">只记「我看了哪个班的自习」，和上面那个学生签到不是一回事</span>
  </div>`);
  box.insertBefore(newBtn, box.firstChild);
  newBtn.querySelector('#ss-new').onclick = () => editor(null);
  await load();
}
