/* ================= 自习（第 22 条） =================
   为什么要单独一页，而不是塞进「上课」：
     看自习是每周都会发生的事（晚自习、早读、周末自习），但它不是上课——
     没有备课、没有讲课、通常也不计课时费。记进「上课」会把课时费和统计口径弄脏：
     本月实际课时凭空变多，对账时又对不上钱。
     记进「考勤」也不对，考勤记的是「学生到没到」，这里要记的是「我看了哪一节、做了什么」。
   所以单独一张表、单独一页，口径各自独立，互不污染。 */
import {
  api, esc, toast, sheet, confirmDialog, ymd, fmtDateTime,
} from './core.js';
import { registerView, icon, pageHead, state } from './ui.js';

registerView(async function selfstudy(main) {
  main.innerHTML = pageHead('自习', '晚自习、早读、周末自习——记哪个班、第几节、做了什么',
    `<button class="btn primary sm" id="ss-new">${icon('plus', 15)} 记一次自习</button>`)
    + '<div id="ss-body"></div>';
  const box = main.querySelector('#ss-body');

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

  main.querySelector('#ss-new').onclick = () => editor(null);
  await load();
});
