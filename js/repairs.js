/* ================= 维修（第 23 条） =================
   报修这件事以前全靠群里喊一句，事后没人记得「修没修、谁修的、花了多少钱」。
   这一页只干三件事：记下坏了什么、看清楚哪些还没修、修完留个底。
   状态只有四个，够用且不会让用户选半天：
     pending 待处理 → doing 处理中 → done 已修好（canceled 取消） */
import {
  api, esc, toast, sheet, confirmDialog, ymd,
} from './core.js';
import { registerView, icon, pageHead } from './ui.js';

const SS_META = {
  pending: { label: '待处理', chip: 'amber' },
  doing: { label: '处理中', chip: 'blue' },
  done: { label: '已修好', chip: 'green' },
  canceled: { label: '已取消', chip: 'grey' },
};

/* 【状态为什么不能随便选】
   以前下拉里四项全开，于是可以把一条「已修好」的记录改回「待处理」，
   保存时下面那行 `if (payload.status !== 'done') payload.fixed_at = ''` 顺手把
   修好日期清空 —— 谁修的、什么时候修好的、花了多少钱那段时间线就没了，
   事后想查都查不回来。
   现在的规则：
     - 没修好的可以往前走（待处理 → 处理中 → 已修好），也可以取消；
     - 已经修好的只允许在「已修好 / 已取消」之间纠错，不给退回未完成；
     - 取消掉的想重新开工，从「待处理」重来，但修好日期照样保留原值不再乱清。 */
const SS_ORDER = ['pending', 'doing', 'done'];
function statusOptions(cur) {
  const c = cur || 'pending';
  if (c === 'done') return ['done', 'canceled'];
  if (c === 'canceled') return ['canceled', 'pending', 'doing'];
  // 未完成：只能在本节点及之后推进，加一个「已取消」出口
  const i = Math.max(0, SS_ORDER.indexOf(c));
  return [...SS_ORDER.slice(i), 'canceled'];
}
const URG = {
  low: { label: '不急', chip: 'grey' },
  normal: { label: '一般', chip: 'blue' },
  high: { label: '急', chip: 'red' },
};
const FILTERS = [
  ['open', '待修'],
  ['all', '全部'],
  ['done', '已修好'],
];

/* 老链接 #/repairs 兜底（render() 里会先 translate 成 work/repairs） */
registerView(async function repairs(main) {
  main.innerHTML = pageHead('维修', '投影、网络、门锁、灯管坏了——报一声，修完留个底');
  const box = document.createElement('div');
  main.appendChild(box);
  return renderRepairsBody(box);
});

/* 二级导航「工作 → 维修」直接调这里，正文挂到传入的容器上 */
export async function renderRepairsBody(box) {

  let rows = [];
  let filter = 'open';

  const load = async () => {
    box.innerHTML = `<div class="empty">加载中…</div>`;
    try {
      rows = await api.get('/repairs');
    } catch (e) {
      box.innerHTML = `<div class="empty">${esc(e.message || '加载失败')}<br>
        <span class="tiny muted">如果是登录过期，刷新页面重新登录即可</span></div>`;
      return;
    }
    paint();
  };

  const paint = () => {
    const open = rows.filter((r) => r.status === 'pending' || r.status === 'doing');
    const done = rows.filter((r) => r.status === 'done');
    const shown = filter === 'open' ? open : filter === 'done' ? done : rows;
    const cost = rows.filter((r) => r.status === 'done').reduce((s, r) => s + (Number(r.cost) || 0), 0);

    box.innerHTML = `
      <div class="rp-stats">
        <div class="card card-pad rp-stat"><div class="rp-k">待修</div>
          <div class="rp-v" style="color:${open.length ? 'var(--amber)' : 'var(--text)'}">${open.length}</div>
          <div class="tiny muted">${rows.filter((r) => r.status === 'pending').length} 条还没人接</div></div>
        <div class="card card-pad rp-stat"><div class="rp-k">已修好</div>
          <div class="rp-v">${done.length}</div>
          <div class="tiny muted">累计花费 ¥${cost.toLocaleString('zh-CN')}</div></div>
      </div>

      <div class="seg" style="margin:14px 0 10px">
        ${FILTERS.map(([k, l]) => `<button class="${k === filter ? 'on' : ''}" data-rp-f="${k}">${l}${k === 'open' ? ` <span class="tiny">${open.length}</span>` : ''}</button>`).join('')}
      </div>

      ${shown.length ? `<div class="rp-list">${shown.map(rowHTML).join('')}</div>` : `
        <div class="card"><div class="empty" style="padding:36px 20px">
          <div class="em">${icon('wrench', 32)}</div>
          ${filter === 'open' ? '没有待修的，一切正常' : filter === 'done' ? '还没有修好的记录' : '还没有报修记录'}
          <div class="tiny muted" style="margin-top:6px">有东西坏了，点右上角「报修」记一条</div>
        </div></div>`}`;

    box.querySelectorAll('[data-rp-f]').forEach((b) => {
      b.onclick = () => { filter = b.dataset.rpF; paint(); };
    });
    box.querySelectorAll('[data-rp-edit]').forEach((b) => {
      b.onclick = () => editor(rows.find((x) => String(x.id) === b.dataset.rpEdit));
    });
    // 一键「修好了」：报修最常见的动作，不该逼人进编辑框再改状态
    box.querySelectorAll('[data-rp-done]').forEach((b) => {
      b.onclick = async () => {
        const r = rows.find((x) => String(x.id) === b.dataset.rpDone);
        b.disabled = true;
        try {
          await api.patch('/repairs/' + r.id, { status: 'done', fixed_at: ymd(new Date()) });
          toast('已标记为修好');
          load();
        } catch (e) { b.disabled = false; toast(e.message || '操作失败', 'err'); }
      };
    });
    box.querySelectorAll('[data-rp-del]').forEach((b) => {
      b.onclick = async () => {
        const r = rows.find((x) => String(x.id) === b.dataset.rpDel);
        if (!await confirmDialog(`删除「${r.item || r.fault}」这条报修？删除后可在回收站找回。`)) return;
        try { await api.del('/repairs/' + r.id); toast('已删除'); load(); }
        catch (e) { toast(e.message || '删除失败', 'err'); }
      };
    });
  };

  const rowHTML = (r) => {
    const st = SS_META[r.status] || SS_META.pending;
    const ug = URG[r.urgency] || URG.normal;
    return `<div class="card card-pad rp-row ${r.status === 'done' ? 'is-done' : ''}">
      <div class="rp-head">
        <span class="rp-no">${esc(r.seq || '—')}</span>
        <div class="rp-title">
          <b>${esc(r.item || '报修')}</b>
          ${r.place ? `<span class="tiny muted">· ${esc(r.place)}</span>` : ''}
          <span class="chip ${st.chip}">${st.label}</span>
          ${r.status !== 'done' && r.urgency !== 'normal' ? `<span class="chip ${ug.chip}">${ug.label}</span>` : ''}
        </div>
        <div class="rp-ops">
          ${r.status !== 'done' ? `<button class="btn ghost sm" data-rp-done="${r.id}">${icon('check', 13)} 修好了</button>` : ''}
          <button class="icon-btn sm" data-rp-edit="${r.id}" title="修改">${icon('edit', 15)}</button>
          <button class="icon-btn sm danger" data-rp-del="${r.id}" title="删除">${icon('trash', 15)}</button>
        </div>
      </div>
      <div class="rp-fault">${esc(r.fault)}</div>
      <div class="rp-meta">
        <span class="mono">${esc(r.date || '')}</span>
        ${r.reporter ? `<span>报修人：${esc(r.reporter)}</span>` : ''}
        ${r.handler ? `<span>维修：${esc(r.handler)}</span>` : ''}
        ${Number(r.cost) ? `<span>费用 ¥${Number(r.cost).toLocaleString('zh-CN')}</span>` : ''}
        ${r.fixed_at ? `<span>修好于 ${esc(r.fixed_at)}</span>` : ''}
      </div>
      ${r.remark ? `<div class="lc-remark">${icon('edit', 12)} ${esc(r.remark)}</div>` : ''}
    </div>`;
  };

  async function editor(row) {
    const isNew = !row;
    const today = ymd(new Date());
    const body = document.createElement('div');
    body.className = 'sheet-body';
    body.innerHTML = `
      <div class="form-grid">
        <div class="field"><label class="field-label">报修日期</label>
          <input class="input" id="d" type="date" value="${esc(row?.date || today)}"></div>
        <div class="field"><label class="field-label">紧急程度</label>
          <select class="input" id="u">
            ${Object.entries(URG).map(([k, v]) => `<option value="${k}" ${(row?.urgency || 'normal') === k ? 'selected' : ''}>${v.label}</option>`).join('')}
          </select></div>
      </div>
      <div class="form-grid">
        <div class="field"><label class="field-label">位置</label>
          <input class="input" id="pl" value="${esc(row?.place || '')}" placeholder="如 高二(3)班教室"></div>
        <div class="field"><label class="field-label">坏的是什么</label>
          <input class="input" id="it" value="${esc(row?.item || '')}" placeholder="如 投影仪 / 门锁 / 灯管 / 网线"></div>
      </div>
      <div class="field"><label class="field-label">什么现象</label>
        <textarea class="input" id="fl" rows="2" placeholder="如：开机后一直闪红灯，投不出画面">${esc(row?.fault || '')}</textarea></div>
      <div class="form-grid">
        <div class="field"><label class="field-label">报修人 <span class="tiny muted">（选填）</span></label>
          <input class="input" id="rp" value="${esc(row?.reporter || '')}" placeholder="谁发现的"></div>
        <div class="field"><label class="field-label">维修人/单位 <span class="tiny muted">（选填）</span></label>
          <input class="input" id="hd" value="${esc(row?.handler || '')}" placeholder="如 后勤王师傅"></div>
      </div>
      <div class="form-grid">
        <div class="field"><label class="field-label">状态</label>
          <select class="input" id="s">
            ${statusOptions(row?.status).map((k) => `<option value="${k}" ${(row?.status || 'pending') === k ? 'selected' : ''}>${SS_META[k].label}</option>`).join('')}
          </select></div>
        <div class="field"><label class="field-label">费用（元）</label>
          <input class="input" id="co" type="number" min="0" step="0.01" value="${esc(row?.cost || '')}" placeholder="0"></div>
      </div>
      <div class="field"><label class="field-label">备注</label>
        <input class="input" id="rm" value="${esc(row?.remark || '')}" placeholder="有什么要补充的？直接在这里写"></div>
      <div class="confirm-actions">
        ${row ? '<button class="btn ghost" id="del" style="color:var(--red);margin-right:auto">删除</button>' : ''}
        <button class="btn ghost" id="cancel">取消</button>
        <button class="btn primary" id="ok">保存</button>
      </div>`;
    const s = sheet({ title: isNew ? '报修' : '修改报修', body, wide: true });
    const $ = (id) => body.querySelector('#' + id);

    $('cancel').onclick = s.close;
    $('del')?.addEventListener('click', async () => {
      if (await confirmDialog('删除这条报修记录？')) {
        try { await api.del('/repairs/' + row.id); s.close(); toast('已删除'); load(); }
        catch (e) { toast(e.message, 'err'); }
      }
    });
    $('ok').onclick = async () => {
      const payload = {
        date: $('d').value || today,
        place: $('pl').value.trim(),
        item: $('it').value.trim(),
        fault: $('fl').value.trim(),
        urgency: $('u').value,
        status: $('s').value,
        reporter: $('rp').value.trim(),
        handler: $('hd').value.trim(),
        cost: Number($('co').value) || 0,
        remark: $('rm').value.trim(),
      };
      if (!payload.fault) return toast('写一下坏在哪、什么现象', 'warn');
      /* 修好日期只加不清：
         以前 status 一旦不是 done 就把 fixed_at 抹成空串，等于把「这台投影仪
         10 月 3 号修过」这件事直接删掉。改成「改成已修好时补今天，其余情况保留原值」，
         历史不会被一次误操作抹掉。 */
      if (payload.status === 'done' && !row?.fixed_at) payload.fixed_at = today;
      const btn = $('ok'); btn.disabled = true; btn.textContent = '保存中…';
      try {
        if (isNew) await api.post('/repairs', payload);
        else await api.patch('/repairs/' + row.id, payload);
        s.close(); toast('已保存'); load();
      } catch (e) {
        btn.disabled = false; btn.textContent = '保存';
        toast(e.message || '保存失败', 'err');
      }
    };
  }

  /* 「报修」按钮原在页头上，现在页头由 work.js 画，按钮挪进正文 */
  const bar = document.createElement('div');
  bar.className = 'row wrap';
  bar.style.cssText = 'gap:8px;margin:0 0 12px';
  bar.innerHTML = `<button class="btn primary sm" id="rp-new">${icon('plus', 15)} 报修</button>`;
  box.parentElement.insertBefore(bar, box);
  bar.querySelector('#rp-new').onclick = () => editor(null);
  await load();
}
