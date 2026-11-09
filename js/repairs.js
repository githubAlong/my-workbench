/* ================= 维修（第 23 条） =================
   报修这件事以前全靠群里喊一句，事后没人记得「修没修、谁修的、花了多少钱」。
   这一页只干三件事：记下坏了什么、看清楚哪些还没修、修完留个底。
   状态只有四个，够用且不会让用户选半天：
     pending 待处理 → doing 处理中 → done 已修好（canceled 取消） */
import {
  api, esc, toast, sheet, confirmDialog, ymd,
} from './core.js';
import { registerView, icon, pageHead } from './ui.js';
import { summarizeRepairs, isRepairTracked, isRepairFixed, normalizeRepairStatus, repairStatusInputValue } from './repairs-domain.mjs';

/* 维修状态使用自由文本输入，保留旧状态兼容。 */
const URG = {
  low: { label: '不急', chip: 'grey' },
  normal: { label: '一般', chip: 'blue' },
  high: { label: '急', chip: 'red' },
};


/* 老链接 #/repairs 兜底（render() 里会先 translate 成 work/repairs） */
registerView(async function repairs(main) {
  main.innerHTML = pageHead('维修记录表', '按月份查看维修记录、处理状态与待跟踪事项');
  const box = document.createElement('div');
  main.appendChild(box);
  return renderRepairsBody(box);
});

/* 二级导航「工作 → 维修」直接调这里，正文挂到传入的容器上 */
export async function renderRepairsBody(box) {
  let rows = [];
  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  let activeMonth = currentMonth;

  const load = async () => {
    box.innerHTML = '<div class="empty">正在加载维修记录…</div>';
    try {
      rows = await api.get('/repairs', { month: activeMonth });
      if (!Array.isArray(rows)) rows = [];
    } catch (e) {
      box.innerHTML = `<div class="empty">${esc(e.message || '维修记录加载失败')}
        <div style="margin-top:10px"><button class="btn ghost sm" id="rp-retry">重新加载</button></div></div>`;
      box.querySelector('#rp-retry')?.addEventListener('click', load);
      return;
    }
    paint();
  };

  const paint = () => {
    const stats = summarizeRepairs(rows, activeMonth);
    const tableRows = stats.rows.length ? stats.rows.map((r, index) => {
      const fixed = isRepairFixed(r);
      const tracked = isRepairTracked(r);
      return `<tr>
        <td class="rp-ledger-no">${esc(r.seq || index + 1)}</td>
        <td>${esc(r.date || '—')}</td>
        <td class="rp-ledger-item">${esc(r.item || '—')}</td>
        <td>${esc(r.place || '—')}</td>
        <td class="rp-ledger-record">${esc(r.fault || '—')}</td>
        <td>${esc(r.reporter || '—')}</td>
        <td><span class="rp-ledger-state ${fixed ? 'is-fixed' : 'is-open'}">${fixed ? '已修好' : '未修好'}</span></td>
        <td><span class="rp-ledger-track ${tracked ? 'is-tracked' : ''}">${tracked ? '是' : '否'}</span></td>
        <td class="rp-ledger-remark">${esc(r.remark || '')}</td>
        <td><div class="rp-ledger-actions">
          <button type="button" class="rp-ledger-edit" data-rp-edit="${esc(r.id)}">编辑</button>
          <button type="button" class="rp-ledger-delete" data-rp-del="${esc(r.id)}">删除</button>
        </div></td>
      </tr>`;
    }).join('') : '<tr><td colspan="10" class="rp-ledger-empty">这个月份暂无维修记录</td></tr>';

    const reminderHTML = stats.reminders.length
      ? stats.reminders.map((item) => `<span class="rp-ledger-reminder-item"><b>${esc(item.item)}</b>：${esc(item.remark)}</span>`).join('')
      : '<span class="rp-ledger-reminder-empty">当前月份暂无待跟踪事项</span>';

    box.innerHTML = `
      <section class="rp-ledger">
        <div class="rp-ledger-toolbar">
          <div class="rp-ledger-month">
            <label for="rp-ledger-month">选择统计月份：</label>
            <input id="rp-ledger-month" type="month" value="${esc(activeMonth)}">
            <button type="button" class="btn ghost sm" id="rp-ledger-view">查看该月数据</button>
          </div>
          <button type="button" class="btn primary sm rp-ledger-add" id="rp-ledger-add">${icon('plus', 15)} 新增维修记录</button>
        </div>
        <div class="rp-ledger-stats">
          <article class="rp-ledger-stat rp-ledger-stat-blue">
            <div class="rp-ledger-stat-label">本月总维修</div><div class="rp-ledger-stat-num">${stats.total}</div><div class="rp-ledger-stat-unit">条</div>
          </article>
          <article class="rp-ledger-stat rp-ledger-stat-green">
            <div class="rp-ledger-stat-label">已修好</div><div class="rp-ledger-stat-num">${stats.fixed}</div><div class="rp-ledger-stat-unit">条</div>
          </article>
          <article class="rp-ledger-stat rp-ledger-stat-orange">
            <div class="rp-ledger-stat-label">未修好</div><div class="rp-ledger-stat-num">${stats.unfinished}</div><div class="rp-ledger-stat-unit">条</div>
          </article>
          <article class="rp-ledger-stat rp-ledger-stat-red">
            <div class="rp-ledger-stat-label">需要跟踪</div><div class="rp-ledger-stat-num">${stats.tracked}</div><div class="rp-ledger-stat-unit">条</div>
          </article>
        </div>
        <div class="rp-ledger-reminders">
          <div class="rp-ledger-reminders-title">${icon('pin', 15)} 待跟踪提醒</div>
          <div class="rp-ledger-reminders-list">${reminderHTML}</div>
        </div>
        <div class="rp-ledger-table-wrap">
          <table class="rp-ledger-table">
            <thead><tr>
              <th>序号</th><th>维修日期</th><th>设备名称</th><th>位置</th><th>维修记录</th>
              <th>报修人</th><th>是否修好</th><th>是否跟踪</th><th>备注</th><th>操作</th>
            </tr></thead>
            <tbody>${tableRows}</tbody>
          </table>
        </div>
        <div class="rp-ledger-foot">共 ${stats.total} 条维修记录 · 统计月份：${esc(activeMonth)}</div>
      </section>`;

    box.querySelector('#rp-ledger-view').onclick = () => {
      const nextMonth = box.querySelector('#rp-ledger-month')?.value || '';
      if (!/^\d{4}-\d{2}$/.test(nextMonth)) return toast('请选择有效的统计月份', 'warn');
      activeMonth = nextMonth;
      load();
    };
    box.querySelector('#rp-ledger-month').onkeydown = (event) => {
      if (event.key === 'Enter') box.querySelector('#rp-ledger-view').click();
    };
    box.querySelector('#rp-ledger-add').onclick = () => editor(null);
    box.querySelectorAll('[data-rp-edit]').forEach((button) => {
      button.onclick = () => editor(rows.find((row) => String(row.id) === button.dataset.rpEdit));
    });
    box.querySelectorAll('[data-rp-del]').forEach((button) => {
      button.onclick = async () => {
        const row = rows.find((item) => String(item.id) === button.dataset.rpDel);
        if (!row) return;
        if (!await confirmDialog(`删除「${row.item || row.fault || '维修记录'}」这条维修记录？删除后可在全局回收站恢复。`)) return;
        button.disabled = true;
        try {
          await api.del('/repairs/' + row.id);
          toast('已删除，记录已移入回收站');
          await load();
        } catch (e) {
          button.disabled = false;
          toast(e.message || '删除失败', 'err');
        }
      };
    });
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
        <div class="field"><label class="field-label">设备名称</label>
          <input class="input" id="it" value="${esc(row?.item || '')}" placeholder="如 投影仪 / 门锁 / 灯管 / 网线"></div>
      </div>
      <div class="field"><label class="field-label">故障描述</label>
        <textarea class="input" id="fl" rows="2" placeholder="如：开机后一直闪红灯，投不出画面">${esc(row?.fault || '')}</textarea></div>
      <div class="form-grid">
        <div class="field"><label class="field-label">报修人 <span class="tiny muted">（选填）</span></label>
          <input class="input" id="rp" value="${esc(row?.reporter || '')}" placeholder="谁发现的"></div>
        <div class="field"><label class="field-label">维修人/单位 <span class="tiny muted">（选填）</span></label>
          <input class="input" id="hd" value="${esc(row?.handler || '')}" placeholder="如 后勤王师傅"></div>
      </div>
      <div class="form-grid">
        <div class="field"><label class="field-label">状态</label>
          <input class="input" id="s" value="${esc(repairStatusInputValue(row?.status))}" placeholder="手动输入状态，如：待处理、等待配件、已修好" autocomplete="off"></div>
        <div class="field"><label class="field-label">费用（元）</label>
          <input class="input" id="co" type="number" min="0" step="0.01" value="${esc(row?.cost || '')}" placeholder="0"></div>
      </div>
      <div class="field"><label class="field-label">是否跟踪</label>
        <label class="rp-follow-control"><input type="checkbox" id="fu" ${row?.follow_up === true || row?.follow_up === 1 || row?.follow_up === '1' ? 'checked' : ''}><span>需要持续跟踪处理</span></label></div>
      <div class="field"><label class="field-label">备注</label>
        <input class="input" id="rm" value="${esc(row?.remark || '')}" placeholder="有什么要补充的？直接在这里写"></div>
      <div class="confirm-actions">
        ${row ? '<button class="btn ghost" id="del" style="color:var(--red);margin-right:auto">删除</button>' : ''}
        <button class="btn ghost" id="cancel">取消</button>
        <button class="btn primary" id="ok">保存</button>
      </div>`;
    const s = sheet({ title: isNew ? '维修记录登记' : '维修记录修改', body, wide: true });
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
        status: normalizeRepairStatus($('s').value),
        reporter: $('rp').value.trim(),
        handler: $('hd').value.trim(),
        cost: Number($('co').value) || 0,
        follow_up: $('fu').checked,
        remark: $('rm').value.trim(),
      };
      if (!payload.fault) return toast('请填写故障描述', 'warn');
      /* 修好日期只加不清：
         以前 status 一旦不是 done 就把 fixed_at 抹成空串，等于把「这台投影仪
         10 月 3 号修过」这件事直接删掉。改成「改成已修好时补今天，其余情况保留原值」，
         历史不会被一次误操作抹掉。 */
      if (isRepairFixed({ status: payload.status }) && !row?.fixed_at) payload.fixed_at = today;
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

  await load();
}
