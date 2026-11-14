import { api, el, esc, toast, confirmDialog, ymd, sheet } from './core.js';
import { encodeLessonPlanContent, decodeLessonPlanContent } from './prep-domain.mjs';
import {
  buildPrepCsv, parsePrepCsv, applyFilterDefaults, filterPrepRows,
  truncateTwoLines, normalizePrepDate,
} from './prep-csv.mjs';

const MAX_FILE_BYTES = 1.5 * 1024 * 1024;
/* 顺序 = 详情页字段顺序；列表表头与之保持一致。 */
const FIELD_IDS = ['planDate', 'subject', 'grade', 'title', 'process', 'remark'];
const SUBJECT_OPTIONS = ['语文', '数学', '英语', '物理', '化学', '生物', '政治', '历史', '地理', '信息技术', '体育', '音乐', '美术'];
const EMPTY_FILTERS = { subject: '', grade: '', from: '', to: '', keyword: '' };

function recordFields(record) {
  const detail = decodeLessonPlanContent(record || {});
  return {
    planDate: String(record?.date || ''),
    subject: String(record?.subject || ''),
    grade: String(detail.grade || record?.class_name || ''),
    title: String(record?.topic || ''),
    process: String(detail.process || ''),
    remark: String(record?.remark || ''),
  };
}

function readFields(root) {
  const result = {};
  FIELD_IDS.forEach((id) => {
    result[id] = String(root.querySelector('#lp-' + id)?.value || '').trim();
  });
  return result;
}

/* 授课内容写进原有 content JSON，备注写进 preps.remark，其余字段不变。 */
function buildPayload(data, currentRecord) {
  return {
    date: data.planDate || ymd(new Date()),
    class_name: data.grade,
    subject: data.subject,
    topic: data.title,
    remark: data.remark || '',
    content: encodeLessonPlanContent({ ...decodeLessonPlanContent(currentRecord || {}), ...data }),
  };
}

function validateRow(data) {
  if (!normalizePrepDate(data.planDate)) return '备课时间无效（应为 YYYY-MM-DD）';
  for (const [key, label] of [['subject', '学科'], ['grade', '年级'], ['title', '标题']]) {
    if (!String(data[key] || '').trim()) return label + '为空';
  }
  return '';
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

function safeFilename(value) {
  return String(value || '备课').replace(/[\\/:*?"<>|]/g, '_');
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = safeFilename(filename);
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadDataUrl(url, filename) {
  if (!url || !String(url).startsWith('data:')) throw new Error('附件正文暂时不可用');
  const link = document.createElement('a');
  link.href = url;
  link.download = safeFilename(filename);
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function optionList(values, selected, allLabel) {
  const list = [...new Set(values.filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b), 'zh-CN'));
  return '<option value="">' + esc(allLabel) + '</option>' + list.map((value) =>
    '<option value="' + esc(value) + '"' + (selected === value ? ' selected' : '') + '>' + esc(value) + '</option>'
  ).join('');
}

async function removeRecord(record, reload) {
  const ok = await confirmDialog('确定删除这条备课？删除后记录将进入回收站。', {
    title: '删除备课', danger: true, okText: '删除',
  });
  if (!ok) return;
  try {
    const attachments = await api.get('/attachments', { owner_type: 'prep', owner_id: record.id });
    await api.del('/preps/' + encodeURIComponent(record.id));
    let failed = 0;
    for (const attachment of attachments || []) {
      try { await api.del('/attachments/' + encodeURIComponent(attachment.id)); }
      catch (error) { failed += 1; console.warn('备课附件清理失败', attachment.name, error); }
    }
    await reload();
    toast(failed ? '记录已删除，但有 ' + failed + ' 个附件未能清理' : '备课已删除', failed ? 'warn' : 'ok');
  } catch (error) {
    toast(error?.message || '删除失败，请重试', 'err');
  }
}

export async function renderPreps(box) {
  let records = [];
  const filters = { ...EMPTY_FILTERS };

  const visibleRows = () => filterPrepRows(
    records.map((record) => ({ ...recordFields(record), id: record.id, raw: record })),
    filters
  ).sort((a, b) =>
    String(b.planDate || '').localeCompare(String(a.planDate || '')) ||
    String(b.raw?.updated_at || b.raw?.created_at || '').localeCompare(String(a.raw?.updated_at || a.raw?.created_at || ''))
  );

  const paint = () => {
    const ordered = visibleRows();
    const rows = ordered.map((record) => {
      const id = esc(String(record.id));
      const clipped = truncateTwoLines(record.process, 60);
      return '<tr>' +
        '<td class="prep-col-date">' + esc(record.planDate || '—') + '</td>' +
        '<td>' + esc(record.subject || '—') + '</td>' +
        '<td>' + esc(record.grade || '—') + '</td>' +
        '<td class="prep-topic" title="' + esc(record.title) + '">' + esc(record.title || '—') + '</td>' +
        '<td class="prep-process" title="' + esc(record.process) + '"><div class="prep-clip">' + esc(clipped.text || '—') + '</div></td>' +
        '<td class="prep-remark" title="' + esc(record.remark) + '"><div class="prep-clip">' + esc(record.remark || '—') + '</div></td>' +
        '<td class="prep-actions">' +
          '<button class="prep-act prep-act-preview" type="button" data-preview="' + id + '">预览</button>' +
          '<button class="prep-act prep-act-edit" type="button" data-edit="' + id + '">编辑</button>' +
          '<button class="prep-act prep-act-delete" type="button" data-delete="' + id + '">删除</button>' +
        '</td></tr>';
    }).join('');

    box.innerHTML = '<section class="prep-page">' +
      '<div class="prep-card prep-head-card">' +
        '<div class="prep-head-text">' +
          '<h2>备课管理</h2>' +
          '<p>记录每一次备课内容，支持筛选、批量导入导出、预览查看</p>' +
        '</div>' +
        '<div class="prep-head-actions">' +
          '<label class="prep-search">' +
            '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="9" cy="9" r="5.6"></circle><path d="M13.2 13.2 17 17" stroke-linecap="round"></path></svg>' +
            '<input id="prep-search" type="search" placeholder="搜索标题 / 授课内容 / 备注" value="' + esc(filters.keyword) + '">' +
          '</label>' +
          '<button class="prep-primary" id="prep-add" type="button">＋ 新建备课</button>' +
        '</div>' +
      '</div>' +
      '<div class="prep-card prep-filter-card">' +
        '<div class="prep-filter-head">' +
          '<b>筛选条件</b>' +
          '<div class="prep-filter-tools">' +
            '<button class="prep-mini" id="prep-import" type="button">批量导入</button>' +
            '<button class="prep-mini" id="prep-export" type="button">批量导出</button>' +
            '<span class="prep-hint">导出 CSV、Excel 可打开</span>' +
            '<input class="lp-hidden-file" id="prep-import-file" type="file" accept=".csv,text/csv">' +
          '</div>' +
        '</div>' +
        '<div class="prep-filter-row">' +
          '<label for="lp-filter-subject">学科：<select id="lp-filter-subject">' +
            optionList([...SUBJECT_OPTIONS, ...records.map((r) => r.subject)], filters.subject, '全部学科') + '</select></label>' +
          '<label for="lp-filter-grade">年级：<select id="lp-filter-grade">' +
            optionList(records.map((r) => recordFields(r).grade), filters.grade, '全部年级') + '</select></label>' +
          '<label for="lp-filter-from">备课时间：' +
            '<input id="lp-filter-from" type="date" value="' + esc(filters.from) + '">' +
            '<span class="prep-date-sep">至</span>' +
            '<input id="lp-filter-to" type="date" value="' + esc(filters.to) + '">' +
          '</label>' +
        '</div>' +
      '</div>' +
      '<div class="prep-card prep-table-card">' +
        '<div class="prep-table-wrap"><table class="prep-table" id="lp-record-table">' +
        '<thead><tr><th>备课时间</th><th>学科</th><th>年级</th><th>标题</th><th>授课内容</th><th>备注</th><th>操作</th></tr></thead>' +
        '<tbody>' + (rows || '<tr><td colspan="7" class="prep-empty">暂时还没有备课，点击「新建备课」开始填写。</td></tr>') + '</tbody>' +
        '</table></div>' +
        '<div class="prep-count">共 ' + ordered.length + ' 条记录</div>' +
      '</div>' +
      '</section>';

    const bind = (selector, event, key) => {
      box.querySelector(selector).addEventListener(event, (target) => {
        filters[key] = target.target.value;
        paint();
        if (event === 'input') {
          const next = box.querySelector(selector);
          if (next) { next.focus(); next.setSelectionRange(filters[key].length, filters[key].length); }
        }
      });
    };
    bind('#lp-filter-subject', 'change', 'subject');
    bind('#lp-filter-grade', 'change', 'grade');
    bind('#lp-filter-from', 'change', 'from');
    bind('#lp-filter-to', 'change', 'to');
    bind('#prep-search', 'input', 'keyword');

    box.querySelector('#prep-add').addEventListener('click', () => openEditor(null, reload));
    box.querySelector('#prep-export').addEventListener('click', () => {
      const list = visibleRows();
      if (!list.length) { toast('当前筛选条件下没有可导出的记录', 'warn'); return; }
      const csv = buildPrepCsv(list.map((row) => ({
        planDate: row.planDate, subject: row.subject, grade: row.grade,
        title: row.title, process: row.process, remark: row.remark,
      })));
      downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }),
        '备课_' + ymd(new Date()).replace(/-/g, '') + '.csv');
      toast('已按当前筛选条件导出 ' + list.length + ' 条备课', 'ok');
    });
    const importInput = box.querySelector('#prep-import-file');
    box.querySelector('#prep-import').addEventListener('click', () => importInput.click());
    importInput.addEventListener('change', async (event) => {
      const file = event.target.files?.[0];
      if (!file) return;
      try {
        const parsed = parsePrepCsv(await file.text());
        if (parsed.errors.length) { toast(parsed.errors.join('；'), 'err', 6000); return; }
        if (!parsed.rows.length) { toast('文件里没有可导入的记录', 'warn'); return; }
        const ok = await confirmDialog(
          '将按当前筛选条件导入 ' + parsed.rows.length + ' 条备课；文件里缺失的学科 / 年级 / 备课时间会套用当前筛选值。是否继续？',
          { title: '批量导入备课', okText: '开始导入' }
        );
        if (!ok) return;
        let done = 0, failed = 0;
        for (const row of parsed.rows) {
          const filled = applyFilterDefaults(row, filters);
          if (validateRow(filled)) { failed += 1; continue; }
          try { await api.post('/preps', buildPayload(filled)); done += 1; }
          catch (error) { failed += 1; console.warn('备课导入失败，第 ' + row.__line + ' 行', error); }
        }
        toast('导入完成：成功 ' + done + ' 条' + (failed ? '，失败 ' + failed + ' 条' : ''), failed ? 'warn' : 'ok');
        if (done) await reload();
      } catch (error) {
        toast(error?.message || '批量导入失败', 'err', 6000);
      } finally { event.target.value = ''; }
    });
    box.querySelectorAll('[data-preview]').forEach((button) => {
      button.addEventListener('click', () => {
        const row = ordered.find((item) => String(item.id) === button.dataset.preview);
        if (row) openPreview(row);
      });
    });
    box.querySelectorAll('[data-edit]').forEach((button) => {
      button.addEventListener('click', () => {
        const row = ordered.find((item) => String(item.id) === button.dataset.edit);
        if (row) openEditor(row.raw, reload);
      });
    });
    box.querySelectorAll('[data-delete]').forEach((button) => {
      button.addEventListener('click', () => {
        const row = ordered.find((item) => String(item.id) === button.dataset.delete);
        if (row) removeRecord(row.raw, reload);
      });
    });
  };

  const reload = async () => {
    try {
      records = await api.get('/preps') || [];
      paint();
    } catch (error) {
      console.error('读取备课失败', error);
      box.innerHTML = '<section class="lesson-plan-list"><div class="lp-load-error">读取备课失败：' +
        esc(error?.message || '请检查网络或工作台数据状态') + '</div></section>';
    }
  };
  await reload();
}

function validateSimpleFields(root) {
  for (const [id, label] of [['planDate', '备课时间'], ['subject', '学科'], ['grade', '年级'], ['title', '标题']]) {
    const input = root.querySelector('#lp-' + id);
    if (!input.value.trim() || !input.checkValidity()) {
      alert('请填写有效的' + label); input.focus(); return false;
    }
  }
  return true;
}

function openPreview(record) {
  const multiLine = (value) => esc(value || '—').replace(/\n/g, '<br>');
  const body = el(
    '<div class="prep-preview">' +
      '<div class="prep-preview-meta">' +
        '<div><span>备课时间</span><b>' + esc(record.planDate || '—') + '</b></div>' +
        '<div><span>学科</span><b>' + esc(record.subject || '—') + '</b></div>' +
        '<div><span>年级</span><b>' + esc(record.grade || '—') + '</b></div>' +
        '<div><span>标题</span><b>' + esc(record.title || '—') + '</b></div>' +
      '</div>' +
      '<section class="prep-preview-section"><h4>授课内容</h4><p>' + multiLine(record.process) + '</p></section>' +
      '<section class="prep-preview-section"><h4>备注</h4><p>' + multiLine(record.remark) + '</p></section>' +
    '</div>'
  );
  const footer = el(
    '<div class="lp-footer"><div class="lp-actions-left"></div>' +
    '<div class="lp-footer-actions"><button class="btn ghost" id="prep-preview-close" type="button">关闭</button></div></div>'
  );
  const dialog = sheet({ title: '预览备课', body, footer, wide: true, cls: 'lesson-plan-sheet' });
  footer.querySelector('#prep-preview-close').addEventListener('click', () => dialog.close());
}

function openEditor(record, reload) {
  let currentRecord = record ? { ...record } : null;
  let existingAttachments = [];
  let pendingFiles = [];
  const removedIds = new Set();
  const initial = recordFields(record || {});
  if (!record) initial.planDate = ymd(new Date());

  const body = el(
    '<div class="lesson-plan-editor lp-simple-editor"><div class="lp-meta-grid">' +
    '<div class="field"><label class="field-label" for="lp-planDate">备课时间 <span class="req">*</span></label><input class="input" id="lp-planDate" type="date" required></div>' +
    '<div class="field"><label class="field-label" for="lp-subject">学科 <span class="req">*</span></label><input class="input" id="lp-subject" list="lp-subject-options" placeholder="请选择或输入学科" required><datalist id="lp-subject-options">' + SUBJECT_OPTIONS.map((value) => '<option value="' + esc(value) + '"></option>').join('') + '</datalist></div>' +
    '<div class="field"><label class="field-label" for="lp-grade">年级 <span class="req">*</span></label><input class="input" id="lp-grade" placeholder="例如：高一15班" required></div>' +
    '<div class="field"><label class="field-label" for="lp-title">标题 <span class="req">*</span></label><input class="input" id="lp-title" placeholder="本课标题" required></div></div>' +
    '<label class="lp-section-title" for="lp-process" style="display:block">授课内容</label><textarea class="input lp-textarea lp-process" id="lp-process" rows="8" placeholder="记录本节课知识点、课堂任务、课堂练习、课后作业等"></textarea>' +
    '<label class="lp-section-title" for="lp-remark" style="display:block">备注</label><textarea class="input lp-textarea lp-remark" id="lp-remark" rows="3" placeholder="可选：补充需要说明的事项"></textarea>' +
    /* 附件能力保留但不占用简化表单字段。 */
    '<div hidden><button id="lp-pick-files" type="button">选择附件</button><input id="lp-file-input" type="file" multiple><div id="lp-attach-list"></div></div></div>'
  );

  const footer = el(
    '<div class="lp-footer"><div class="lp-actions-left">' +
      '<span class="lp-tool-status" id="lp-tool-status" aria-live="polite"></span>' +
    '</div><div class="lp-footer-actions">' +
      '<button class="btn ghost" id="lp-close" type="button">关闭</button>' +
      '<button class="btn primary lp-save-btn" id="lp-save" type="button">保存</button>' +
    '</div></div>'
  );

  const dialog = sheet({
    title: currentRecord ? '查看 / 编辑备课' : '新建备课',
    body, footer, wide: true, cls: 'lesson-plan-sheet',
  });
  const saveButton = footer.querySelector('#lp-save');
  const attachmentList = body.querySelector('#lp-attach-list');
  FIELD_IDS.forEach((id) => { body.querySelector('#lp-' + id).value = initial[id] || ''; });

  const renderAttachments = () => {
    attachmentList.replaceChildren();
    const visible = existingAttachments.filter((item) => !removedIds.has(String(item.id)));
    if (!visible.length && !pendingFiles.length) {
      const empty = document.createElement('div');
      empty.className = 'lp-attach-empty';
      empty.textContent = '暂未添加附件';
      attachmentList.appendChild(empty);
      return;
    }
    const appendRow = (item, pending) => {
      const row = document.createElement('div');
      row.className = 'lp-attach-item' + (pending ? ' is-pending' : '');
      const detail = document.createElement('div');
      detail.className = 'lp-attach-detail';
      const name = document.createElement('span');
      name.className = 'lp-attach-name';
      name.textContent = pending ? item.file.name : (item.name || '未命名附件');
      const size = document.createElement('span');
      size.className = 'lp-attach-size';
      size.textContent = formatBytes(pending ? item.file.size : item.size) + (pending ? ' · 待上传' : '');
      detail.append(name, size);
      const actions = document.createElement('div');
      actions.className = 'lp-attach-actions';
      if (!pending) {
        const download = document.createElement('button');
        download.type = 'button';
        download.className = 'btn ghost sm';
        download.textContent = '下载';
        download.addEventListener('click', async () => {
          try {
            const file = await api.get('/attachments/' + encodeURIComponent(item.id) + '/file');
            downloadDataUrl(file?.url, item.name);
          } catch (error) { toast(error?.message || '附件下载失败', 'err'); }
        });
        actions.appendChild(download);
      }
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'btn ghost sm lp-attach-remove';
      remove.textContent = '删除';
      remove.addEventListener('click', () => {
        if (pending) pendingFiles = pendingFiles.filter((file) => file.id !== item.id);
        else removedIds.add(String(item.id));
        renderAttachments();
      });
      actions.appendChild(remove);
      row.append(detail, actions);
      attachmentList.appendChild(row);
    };
    visible.forEach((item) => appendRow(item, false));
    pendingFiles.forEach((item) => appendRow(item, true));
  };

  body.querySelector('#lp-pick-files').addEventListener('click', () => body.querySelector('#lp-file-input').click());
  body.querySelector('#lp-file-input').addEventListener('change', (event) => {
    Array.from(event.target.files || []).forEach((file) => {
      if (file.size > MAX_FILE_BYTES) {
        alert('附件「' + file.name + '」超过当前工作台单文件 1.5MB 的限制，请压缩后再上传。');
      } else {
        pendingFiles.push({
          id: 'pending-' + Date.now() + '-' + Math.random().toString(16).slice(2),
          file,
        });
      }
    });
    renderAttachments();
    event.target.value = '';
  });

  const loadAttachments = async () => {
    if (!currentRecord?.id) return;
    try {
      existingAttachments = await api.get('/attachments', {
        owner_type: 'prep', owner_id: currentRecord.id,
      }) || [];
      renderAttachments();
    } catch (error) {
      toast('附件列表读取失败：' + (error?.message || '未知错误'), 'err');
    }
  };
  renderAttachments();
  loadAttachments();

  footer.querySelector('#lp-close').addEventListener('click', () => dialog.close());

  let saving = false;
  saveButton.addEventListener('click', async () => {
    if (saving) return;
    const data = readFields(body);
    if (!validateSimpleFields(body)) return;
    saving = true;
    saveButton.disabled = true;
    const creating = !currentRecord;
    saveButton.textContent = '保存中…';
    try {
      const saved = currentRecord
        ? await api.patch('/preps/' + encodeURIComponent(currentRecord.id), buildPayload(data, currentRecord))
        : await api.post('/preps', buildPayload(data));
      if (!saved || saved.id == null) throw new Error('记录保存后没有返回记录编号');
      currentRecord = saved;
      if (creating) {
        const title = dialog.wrap.querySelector('.sheet-title');
        if (title) title.textContent = '查看 / 编辑备课';
      }
      if (pendingFiles.length) {
        const fd = new FormData();
        pendingFiles.forEach((item) => fd.append('files', item.file, item.file.name));
        fd.append('owner_type', 'prep');
        fd.append('owner_id', String(currentRecord.id));
        const uploaded = await api.req('POST', '/upload', fd);
        existingAttachments.push(...(uploaded || []));
        pendingFiles = [];
        renderAttachments();
      }
      for (const id of [...removedIds]) {
        await api.del('/attachments/' + encodeURIComponent(id));
        removedIds.delete(id);
        existingAttachments = existingAttachments.filter((item) => String(item.id) !== id);
      }
      toast(creating ? '备课已创建' : '备课已保存', 'ok');
      dialog.close();
      await reload();
    } catch (error) {
      toast((currentRecord ? '记录已保存，但附件处理未完成：' : '保存失败：') +
        (error?.message || '请重试'), 'err', 6000);
    } finally {
      saving = false;
      saveButton.disabled = false;
      if (saveButton.isConnected) saveButton.textContent = '保存';
    }
  });
}
