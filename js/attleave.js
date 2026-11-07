/* ============ 请假管理页 ============ 
 * 请假记录继续写入原有 attendance_tables / attendance_rows，不新增数据库表。
 * 新增请假默认写入对应日期的坐班表；从已有记录编辑时，保留原表归属。
 */
import { api, el, esc, toast, sheet, saving, saveBlob } from './core.js';
import { createSlot } from './attday.js';

const pad2 = (n) => String(n).padStart(2, '0');
const currentMonth = () => {
  const d = new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1);
};
const monthShift = (value, delta) => {
  const [year, month] = String(value).split('-').map(Number);
  const d = new Date(year, month - 1 + delta, 1);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1);
};
const typeText = (value) => value || '未注明';
const periodText = (value) => value || '全天';

export async function renderLeavePage(container, grade) {
  if (!container) return;
  let month = currentMonth();
  let typeFilter = '全部';
  let search = '';
  let teachers = [];
  let entries = [];
  let loading = false;

  const load = async () => {
    loading = true;
    container.innerHTML = '<div class="leave-loading">正在读取请假记录…</div>';
    try {
      const [teacherResult, tableList] = await Promise.all([
        api.get('/teachers', { grade }).catch(() => ({ list: [] })),
        api.get('/attendance', { grade }),
      ]);
      teachers = teacherResult.list || [];
      const candidates = (tableList || []).filter((table) =>
        String(table.sheet_date || '').startsWith(month)
        && Number(table.summary?.leave || 0) > 0
        && !table.deleted_at
      );
      const details = await Promise.all(candidates.map((table) =>
        api.get('/attendance/' + table.id).catch(() => null)
      ));
      const found = [];
      details.forEach((detail, index) => {
        if (!detail) return;
        const table = candidates[index];
        const leaveColumn = (detail.columns || []).find((col) => /请假/.test(col.label || ''));
        const leaveKey = leaveColumn?.key || 'k_请假';
        (detail.rows || []).forEach((row) => {
          const data = row.data || {};
          const marked = data[leaveKey] === '1' || (data.__leave && typeof data.__leave === 'object');
          if (!marked) return;
          const lv = data.__leave && typeof data.__leave === 'object' ? data.__leave : {};
          found.push({
            date: String(detail.sheet_date || table.sheet_date || ''),
            teacher: String(row.teacher || ''),
            subject: String(row.subject || ''),
            type: typeText(lv.type),
            period: periodText(lv.period),
            duration: Number(lv.duration ?? (lv.period === '上午' || lv.period === '下午' ? 0.5 : 1)),
            remark: String(lv.remark || ''),
            tableId: detail.id,
            tableType: detail.sheet_type || detail.kind || 'seat',
            rowId: row.id,
            rowUpdatedAt: row.updated_at || '',
            tableUpdatedAt: detail.updated_at || '',
          });
        });
      });
      /* 同一位老师同一天可能在多张表上出现请假标记；台账只展示一条，
         优先保留坐班表记录，避免重复统计同一份请假。 */
      const unique = new Map();
      const priority = (entry) => entry.tableType === 'seat' ? 3 : entry.tableType === 'class' ? 2 : 1;
      found.forEach((entry) => {
        const key = entry.date + '|' + entry.teacher;
        const old = unique.get(key);
        if (!old || priority(entry) > priority(old) ||
          (priority(entry) === priority(old) && String(entry.rowUpdatedAt) > String(old.rowUpdatedAt))) {
          unique.set(key, entry);
        }
      });
      entries = [...unique.values()].sort((a, b) =>
        b.date.localeCompare(a.date) || a.teacher.localeCompare(b.teacher, 'zh-CN')
      );
    } catch (error) {
      entries = [];
      toast(error.message || '请假记录读取失败', 'err');
    }
    loading = false;
    paint();
  };

  const filteredEntries = () => entries.filter((entry) => {
    const q = search.trim().toLowerCase();
    return (typeFilter === '全部' || entry.type === typeFilter)
      && (!q || (entry.teacher + ' ' + entry.subject + ' ' + entry.remark).toLowerCase().includes(q));
  });

  const paint = () => {
    const shown = filteredEntries();
    const sick = entries.filter((entry) => entry.type === '病假').length;
    const personal = entries.filter((entry) => entry.type === '事假').length;
    const days = entries.reduce((sum, entry) => sum + (Number(entry.duration) || 0), 0);
    container.innerHTML = `<div class="leave-ledger">
      <div class="leave-page-head">
        <div><h3>请假记录</h3><p>${esc(grade)} · 按月查看，新增或修改后同步回对应考勤表</p></div>
        <div class="leave-page-actions">
          <button class="btn ghost sm" id="leave-export">导出 Excel</button>
          <button class="btn primary sm" id="leave-add">＋ 新增请假</button>
        </div>
      </div>
      <div class="leave-summary-grid">
        <div class="leave-summary-card"><span>本月请假人次</span><b>${entries.length}</b></div>
        <div class="leave-summary-card sick"><span>病假人次</span><b>${sick}</b></div>
        <div class="leave-summary-card personal"><span>事假人次</span><b>${personal}</b></div>
        <div class="leave-summary-card days"><span>累计时长</span><b>${Math.round(days * 10) / 10}<small>天</small></b></div>
      </div>
      <div class="leave-toolbar">
        <button class="btn ghost sm" id="leave-prev" aria-label="上个月">‹</button>
        <input class="input leave-month" type="month" id="leave-month" value="${esc(month)}">
        <button class="btn ghost sm" id="leave-next" aria-label="下个月">›</button>
        <select class="input leave-type" id="leave-type-filter">
          ${['全部', '病假', '事假', '未注明'].map((value) => `<option value="${value}" ${typeFilter === value ? 'selected' : ''}>${value}</option>`).join('')}
        </select>
        <input class="input leave-search" id="leave-search" placeholder="搜索教师 / 学科 / 备注" value="${esc(search)}">
        <span class="leave-result-count">显示 ${shown.length} 条</span>
      </div>
      <div class="leave-table-scroll">
        <table class="leave-table">
          <thead><tr><th>日期</th><th>教师</th><th>学科</th><th>假别</th><th>时段</th><th>时长</th><th>备注</th><th>操作</th></tr></thead>
          <tbody>${shown.length ? shown.map((entry) => {
            const index = entries.indexOf(entry);
            return `<tr>
              <td>${esc(entry.date)}</td>
              <td class="leave-person">${esc(entry.teacher)}</td>
              <td>${esc(entry.subject || '—')}</td>
              <td><span class="leave-type-tag ${entry.type === '病假' ? 'sick' : entry.type === '事假' ? 'personal' : ''}">${esc(entry.type)}</span></td>
              <td>${esc(entry.period)}</td>
              <td>${Number(entry.duration) || 0} 天</td>
              <td class="leave-remark">${esc(entry.remark || '—')}</td>
              <td><div class="leave-row-actions"><button data-edit="${index}">编辑</button><button data-delete="${index}" class="danger">删除</button></div></td>
            </tr>`;
          }).join('') : `<tr><td colspan="8" class="leave-empty">${loading ? '正在读取…' : '本月暂无请假记录'}</td></tr>`}
          </tbody>
        </table>
      </div>
      <div class="leave-footnote">请假记录保存在原有考勤表中；修改后会将对应考勤表标记为「已修改 · 待重新确认」。</div>
    </div>`;

    container.querySelector('#leave-month').onchange = (event) => {
      if (!event.target.value) return;
      month = event.target.value;
      load();
    };
    container.querySelector('#leave-prev').onclick = () => { month = monthShift(month, -1); load(); };
    container.querySelector('#leave-next').onclick = () => { month = monthShift(month, 1); load(); };
    container.querySelector('#leave-type-filter').onchange = (event) => { typeFilter = event.target.value; paint(); };
    container.querySelector('#leave-search').oninput = (event) => { search = event.target.value; const pos = event.target.selectionStart; paint(); const input = container.querySelector('#leave-search'); input.focus(); input.setSelectionRange(pos, pos); };
    container.querySelector('#leave-add').onclick = () => openEditor();
    container.querySelector('#leave-export').onclick = exportRows;
    container.querySelectorAll('[data-edit]').forEach((button) => {
      button.onclick = () => openEditor(entries[Number(button.dataset.edit)]);
    });
    container.querySelectorAll('[data-delete]').forEach((button) => {
      button.onclick = () => deleteEntry(entries[Number(button.dataset.delete)]);
    });
  };

  const persist = async ({ entry, date, teacher, type, period, duration, remark }) => {
    let detail;
    if (entry) {
      detail = await api.get('/attendance/' + entry.tableId);
    } else {
      const table = await createSlot({ date, grade, type: 'seat', period: '' });
      detail = await api.get('/attendance/' + table.id);
    }
    let row = entry
      ? (detail.rows || []).find((item) => String(item.id) === String(entry.rowId))
        || (detail.rows || []).find((item) => String(item.teacher || '').trim() === teacher)
      : (detail.rows || []).find((item) => String(item.teacher || '').trim() === teacher);
    if (!row) row = { teacher, subject: teachers.find((item) => item.name === teacher)?.subject || '', data: {} };
    let columns = Array.isArray(detail.columns) ? detail.columns.slice() : [];
    let leaveColumn = columns.find((column) => /请假/.test(column.label || ''));
    if (!leaveColumn) {
      leaveColumn = { key: 'k_请假', label: '请假', type: 'check', w: 76 };
      columns = [...columns, leaveColumn];
      const patch = { columns };
      if (detail.updated_at) patch.expected_updated_at = detail.updated_at;
      const updated = await api.patch('/attendance/' + detail.id, patch);
      detail.updated_at = updated?.updated_at || detail.updated_at;
      detail.columns = columns;
    }
    const data = { ...(row.data || {}) };
    columns.filter((column) => column.type === 'check' && column.key !== leaveColumn.key)
      .forEach((column) => { data[column.key] = ''; });
    data[leaveColumn.key] = '1';
    data.__leave = {
      type: type === '未注明' ? '' : type,
      period,
      duration,
      remark: String(remark || '').trim(),
    };
    const payload = { teacher: row.teacher || teacher, subject: row.subject || '', data };
    if (row.id) {
      payload.id = row.id;
      if (row.updated_at) payload.expected_updated_at = row.updated_at;
    }
    await api.post('/attendance/' + detail.id + '/rows', { rows: [payload], dirty: true });
  };

  const openEditor = (entry = null) => {
    if (!teachers.length) return toast('当前年级还没有教师名册，请先维护花名册', 'warn');
    const initialDate = entry?.date || (month === currentMonth() ? new Date().getFullYear() + '-' + pad2(new Date().getMonth() + 1) + '-' + pad2(new Date().getDate()) : month + '-01');
    const initialTeacher = entry?.teacher || teachers[0]?.name || '';
    const body = el(`<div class="sheet-body leave-editor-form">
      <div class="field"><label class="field-label">日期</label><input class="input" type="date" id="leave-form-date" value="${esc(initialDate)}" ${entry ? 'disabled' : ''}></div>
      <div class="field"><label class="field-label">教师</label><select class="input" id="leave-form-teacher" ${entry ? 'disabled' : ''}>${teachers.map((teacher) => `<option value="${esc(teacher.name)}" ${teacher.name === initialTeacher ? 'selected' : ''}>${esc(teacher.name)} · ${esc(teacher.subject || '未填学科')}</option>`).join('')}</select></div>
      <div class="field-row">
        <div class="field"><label class="field-label">假别</label><select class="input" id="leave-form-type">${['病假', '事假', '未注明'].map((value) => `<option value="${value}" ${(entry?.type || '病假') === value ? 'selected' : ''}>${value}</option>`).join('')}</select></div>
        <div class="field"><label class="field-label">时段</label><select class="input" id="leave-form-period">${['上午', '下午', '全天'].map((value) => `<option value="${value}" ${(entry?.period || '全天') === value ? 'selected' : ''}>${value}</option>`).join('')}</select></div>
      </div>
      <div class="field"><label class="field-label">请假时长（天）</label><input class="input" type="number" id="leave-form-duration" min="0.5" step="0.5" value="${Number(entry?.duration ?? (entry?.period === '上午' || entry?.period === '下午' ? 0.5 : 1))}"></div>
      <div class="field"><label class="field-label">备注</label><textarea class="input" id="leave-form-remark" rows="3" placeholder="可填写请假原因或补充说明">${esc(entry?.remark || '')}</textarea></div>
      <div class="confirm-actions"><button class="btn ghost" id="leave-form-cancel">取消</button><button class="btn primary" id="leave-form-save">${entry ? '保存修改' : '登记请假'}</button></div>
    </div>`);
    const dialog = sheet({ title: entry ? '修改请假记录' : '新增请假', body, wide: true, cls: 'leave-editor' });
    const $ = (selector) => body.querySelector(selector);
    $('#leave-form-period').onchange = () => {
      $('#leave-form-duration').value = $('#leave-form-period').value === '全天' ? '1' : '0.5';
    };
    $('#leave-form-cancel').onclick = dialog.close;
    saving($('#leave-form-save'), async () => {
      const date = $('#leave-form-date').value;
      const teacher = $('#leave-form-teacher').value;
      const type = $('#leave-form-type').value;
      const period = $('#leave-form-period').value;
      const duration = Number($('#leave-form-duration').value);
      const remark = $('#leave-form-remark').value;
      if (!date) return toast('请选择请假日期', 'warn');
      if (!teacher) return toast('请选择教师', 'warn');
      if (!Number.isFinite(duration) || duration <= 0) return toast('请填写有效的请假时长', 'warn');
      await persist({ entry, date, teacher, type, period, duration, remark });
      dialog.close();
      toast(entry ? '请假记录已更新' : '请假记录已登记', 'ok');
      await load();
    });
  };

  const deleteEntry = async (entry) => {
    if (!entry) return;
    const confirmed = window.confirm('确定删除 ' + entry.date + ' ' + entry.teacher + ' 的请假记录吗？');
    if (!confirmed) return;
    try {
      const detail = await api.get('/attendance/' + entry.tableId);
      const row = (detail.rows || []).find((item) => String(item.id) === String(entry.rowId))
        || (detail.rows || []).find((item) => String(item.teacher || '').trim() === entry.teacher);
      if (!row) throw new Error('对应考勤记录已不存在');
      const leaveColumn = (detail.columns || []).find((column) => /请假/.test(column.label || ''));
      const data = { ...(row.data || {}) };
      delete data[leaveColumn?.key || 'k_请假'];
      delete data.__leave;
      const payload = { id: row.id, teacher: row.teacher, subject: row.subject, data };
      if (row.updated_at) payload.expected_updated_at = row.updated_at;
      await api.post('/attendance/' + detail.id + '/rows', { rows: [payload], dirty: true });
      toast('请假记录已删除', 'ok');
      await load();
    } catch (error) {
      toast(error.message || '删除失败', 'err');
    }
  };

  const exportRows = async () => {
    const rows = filteredEntries();
    if (!rows.length) return toast('当前筛选没有请假记录', 'warn');
    try {
      const { makeXlsx } = await import('./attendance.js');
      const grid = [
        [grade + ' 请假记录 · ' + month],
        ['日期', '教师', '学科', '假别', '时段', '时长(天)', '备注'],
        ...rows.map((entry) => [entry.date, entry.teacher, entry.subject, entry.type, entry.period, entry.duration, entry.remark]),
      ];
      saveBlob(makeXlsx({ title: grade + '请假记录', grid }), grade + '请假记录-' + month + '.xlsx');
      toast('请假记录 Excel 已导出', 'ok');
    } catch (error) {
      toast(error.message || '导出失败', 'err');
    }
  };

  paint();
  await load();
}
