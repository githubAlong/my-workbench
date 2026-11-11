import { api, el, esc, toast, confirmDialog, ymd, sheet } from './core.js';
import { encodeLessonPlanContent, decodeLessonPlanContent, PREP_TYPE_OPTIONS, PREP_UNCLASSIFIED, normalizePrepType, prepTypeLabel, filterPrepRecords, validatePrepRecord } from './prep-domain.mjs';
import { recognizeLessonPlanImage } from './ocr.js';

const MAX_FILE_BYTES = 1.5 * 1024 * 1024;
const FIELD_IDS = ['subject','grade','title','planDate','process'];
const scriptLoads = new Map();

function recordFields(record) {
  const detail = decodeLessonPlanContent(record || {});
  return {
    subject: String(record?.subject || ''),
    prepType: normalizePrepType(record?.prep_type),
    grade: String(detail.grade || record?.class_name || ''),
    title: String(record?.topic || ''),
    planDate: String(record?.date || ymd(new Date())),
    target: String(detail.target || ''),
    keyPoint: String(detail.keyPoint || ''),
    hardPoint: String(detail.hardPoint || ''),
    prepare: String(detail.prepare || ''),
    process: String(detail.process || ''),
    blackboard: String(detail.blackboard || ''),
    homeMust: String(detail.homeMust || ''),
    homeExtra: String(detail.homeExtra || ''),
    reflect: String(detail.reflect || ''),
  };
}

function readFields(root) {
  const result = {};
  FIELD_IDS.forEach((id) => {
    result[id] = String(root.querySelector('#lp-' + id)?.value || '').trim();
  });
  result.prepType = String(root.querySelector('#lp-prep-type')?.value || '').trim();
  return result;
}

function writeFields(root, values) {
  if (!values || typeof values !== 'object') return;
  const aliases = { title: ['title','topic'], planDate: ['planDate','date'] };
  FIELD_IDS.forEach((id) => {
    const key = (aliases[id] || [id]).find((name) => Object.prototype.hasOwnProperty.call(values, name));
    if (key) {
      const input = root.querySelector('#lp-' + id);
      if (input) input.value = String(values[key] ?? '');
    }
  });
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

function safeFilename(value) {
  return String(value || '电子备课记录').replace(/[\\/:*?"<>|]/g, '_');
}

function loadScript(src, globalName) {
  if (window[globalName]) return Promise.resolve(window[globalName]);
  if (scriptLoads.has(globalName)) return scriptLoads.get(globalName);
  const promise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = () => window[globalName]
      ? resolve(window[globalName])
      : reject(new Error('导入组件加载后未初始化'));
    script.onerror = () => reject(new Error('导入组件加载失败，请检查网络后重试'));
    document.head.appendChild(script);
  }).catch((error) => {
    scriptLoads.delete(globalName);
    throw error;
  });
  scriptLoads.set(globalName, promise);
  return promise;
}

async function extractDocx(file) {
  const JSZip = await loadScript(
    'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js',
    'JSZip'
  );
  const zip = await JSZip.loadAsync(file);
  const xmlFile = zip.file('word/document.xml');
  if (!xmlFile) throw new Error('没有找到 Word 正文，请确认文件是 .docx 格式');
  const xml = await xmlFile.async('string');
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Word 文档结构无法解析');
  const paragraphs = Array.from(doc.getElementsByTagNameNS(
    'http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'p'
  ));
  return paragraphs.map((p) => Array.from(p.getElementsByTagNameNS(
    'http://schemas.openxmlformats.org/wordprocessingml/2006/main', 't'
  )).map((node) => node.textContent || '').join('')).filter(Boolean).join('\n');
}

async function extractPdf(file) {
  const pdfjs = await loadScript(
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
    'pdfjsLib'
  );
  pdfjs.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const pages = [];
  for (let pageNo = 1; pageNo <= pdf.numPages; pageNo += 1) {
    const page = await pdf.getPage(pageNo);
    const content = await page.getTextContent();
    pages.push(content.items.map((item) => item.str || '').join(' '));
  }
  return pages.join('\n\n').trim();
}

function sectionValue(lines, startPattern, endPattern) {
  const start = lines.findIndex((line) => startPattern.test(line));
  if (start < 0) return '';
  const first = lines[start].replace(startPattern, '').replace(/^[：:\s]+/, '').trim();
  const output = first ? [first] : [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (endPattern.test(lines[i])) break;
    output.push(lines[i]);
  }
  return output.join('\n').trim();
}

function parseImportedText(raw) {
  const text = String(raw || '').replace(/\r/g, '').trim();
  const lines = text.split('\n').map((line) => line.trim()).filter((line, index, all) => line || (index && all[index - 1]));
  const joined = lines.join('\n');
  const data = {};
  const label = (pattern) => {
    const match = joined.match(pattern);
    return match ? String(match[1] || '').trim() : '';
  };
  data.subject = label(/(?:^|\n)\s*学科\s*[：:]\s*([^\n]+)/);
  data.grade = label(/(?:^|\n)\s*年级\s*[：:]\s*([^\n]+)/);
  data.title = label(/(?:^|\n)\s*(?:课题|主题)\s*[：:]\s*([^\n]+)/);
  data.planDate = label(/(?:^|\n)\s*(?:备课日期|日期)\s*[：:]\s*(\d{4}[-/.]\d{1,2}[-/.]\d{1,2})/);
  const definitions = [
    ['target', /^(?:一[、.．]\s*)?教学目标(?:（[^）]*）)?\s*[：:]?/, /^(?:二[、.．]|教学重点|教学难点)/],
    ['keyPoint', /^(?:二[、.．]\s*)?教学重点\s*[：:]?/, /^(?:教学难点|三[、.．]|教学准备)/],
    ['hardPoint', /^教学难点\s*[：:]?/, /^(?:三[、.．]|教学准备)/],
    ['prepare', /^(?:三[、.．]\s*)?教学准备\s*[：:]?/, /^(?:四[、.．]|教学过程)/],
    ['process', /^(?:四[、.．]\s*)?教学过程(?:（[^）]*）)?\s*[：:]?/, /^(?:五[、.．]|板书设计)/],
    ['blackboard', /^(?:五[、.．]\s*)?板书设计\s*[：:]?/, /^(?:六[、.．]|分层作业)/],
    ['homeMust', /^(?:六[、.．]\s*)?分层作业|^必做题\s*[：:]?/, /^(?:选做题|七[、.．]|课后反思)/],
    ['homeExtra', /^选做题(?:（[^）]*）)?\s*[：:]?/, /^(?:七[、.．]|课后反思)/],
    ['reflect', /^(?:七[、.．]\s*)?课后反思\s*[：:]?/, /^(?:八[、.．]|附件素材)/],
  ];
  definitions.forEach(([id, start, end]) => {
    const value = sectionValue(lines, start, end);
    if (value) data[id] = value;
  });
  if (!definitions.some(([id]) => data[id])) data.process = text;
  return data;
}

function applyImported(root, data) {
  if (typeof data === 'string') {
    writeFields(root, { ...parseImportedText(data), process: data });
    return;
  }
  const source = data?.fields && typeof data.fields === 'object' ? data.fields : data;
  if (source && typeof source === 'object') writeFields(root, source);
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

async function removeRecord(record, reload) {
  const ok = await confirmDialog('确定删除这条备课记录？删除后记录将进入回收站。', {
    title: '删除备课记录', danger: true, okText: '删除',
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
    toast(failed ? '记录已删除，但有 ' + failed + ' 个附件未能清理' : '备课记录已删除', failed ? 'warn' : 'ok');
  } catch (error) {
    toast(error?.message || '删除失败，请重试', 'err');
  }
}

export async function renderPreps(box) {
  let records = [];
  let typeFilter = '';
  const paint = () => {
    const filtered = filterPrepRecords(records, { type: typeFilter });
    const ordered = [...filtered].sort((a, b) =>
      String(b.date || '').localeCompare(String(a.date || '')) ||
      String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || ''))
    );
    const rows = ordered.map((record) => {
      const data = recordFields(record);
      const id = esc(String(record.id));
      return '<tr><td>' + esc(data.subject || '—') + '<div class="lp-type-label">' + esc(prepTypeLabel(record)) + '</div></td>' +
        '<td class="lp-topic-cell" title="' + esc(data.title) + '">' + esc(data.title || '—') + '</td>' +
        '<td>' + esc(data.grade || '—') + '</td><td>' + esc(data.planDate || '—') + '</td>' +
        '<td><div class="lp-row-actions">' +
          '<button class="btn ghost sm" type="button" data-edit="' + id + '">查看/编辑</button>' +
          '<button class="btn ghost sm lp-delete-btn" type="button" data-delete="' + id + '">删除</button>' +
        '</div></td></tr>';
    }).join('');

    box.innerHTML = '<section class="lesson-plan-list">' +
      '<div class="lp-list-toolbar"><div><div class="lp-list-caption">电子备课</div>' +
      '<div class="lp-filter-row"><label for="lp-type-filter">备课类型</label><select class="input lp-type-filter" id="lp-type-filter"><option value="">全部类型</option>' +
      [...PREP_TYPE_OPTIONS, ...[...new Set(records.map(normalizePrepType))].filter(type => type !== PREP_UNCLASSIFIED && !PREP_TYPE_OPTIONS.some(item => item.value === type)).map(type => ({value:type,label:type}))].map((item) => '<option value="' + esc(item.value) + '" ' + (typeFilter === item.value ? 'selected' : '') + '>' + esc(item.label) + '</option>').join('') +
      '<option value="' + PREP_UNCLASSIFIED + '" ' + (typeFilter === PREP_UNCLASSIFIED ? 'selected' : '') + '>待分类</option></select></div></div>' +
      '<button class="btn primary" id="prep-add" type="button">＋ 新建备课记录</button></div>' +
      '<div class="lp-table-wrap"><table class="lp-table" id="lp-record-table">' +
      '<thead><tr><th>学科</th><th>课题</th><th>年级</th><th>备课日期</th><th>操作</th></tr></thead>' +
      '<tbody>' + (rows || '<tr><td colspan="5" class="lp-empty">暂时还没有备课记录，点击右上角「新建备课记录」开始填写。</td></tr>') + '</tbody>' +
      '</table></div><div class="lp-record-count">共 ' + ordered.length + ' 条记录</div></section>';

    box.querySelector('#lp-type-filter').addEventListener('change', (event) => { typeFilter = event.target.value; paint(); });
    box.querySelector('#prep-add').addEventListener('click', () => openEditor(null, reload));
    box.querySelectorAll('[data-edit]').forEach((button) => {
      button.addEventListener('click', () => {
        const row = ordered.find((item) => String(item.id) === button.dataset.edit);
        if (row) openEditor(row, reload);
      });
    });
    box.querySelectorAll('[data-delete]').forEach((button) => {
      button.addEventListener('click', () => {
        const row = ordered.find((item) => String(item.id) === button.dataset.delete);
        if (row) removeRecord(row, reload);
      });
    });
  };

  const reload = async () => {
    try {
      records = await api.get('/preps') || [];
      paint();
    } catch (error) {
      console.error('读取电子备课记录失败', error);
      box.innerHTML = '<section class="lesson-plan-list"><div class="lp-load-error">读取备课记录失败：' +
        esc(error?.message || '请检查网络或工作台数据状态') + '</div></section>';
    }
  };
  await reload();
}

function validateSimpleFields(root) {
  for (const [id, label] of [['prep-type','备课类型'],['subject','学科'],['grade','年级班级'],['title','课题'],['planDate','上课日期']]) {
    const input = root.querySelector('#lp-' + id);
    if (!input.value.trim() || !input.checkValidity()) {
      alert('请填写有效的' + label); input.focus(); return false;
    }
  }
  return true;
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
    '<div class="field"><label class="field-label" for="lp-prep-type">备课类型 <span class="req">*</span></label><input class="input" id="lp-prep-type" list="lp-type-options" placeholder="请选择或输入备课类型" required maxlength="80"><datalist id="lp-type-options">' + PREP_TYPE_OPTIONS.map(item=>'<option value="'+esc(item.label)+'"></option>').join('') + '</datalist></div>' +
    '<div class="field"><label class="field-label" for="lp-subject">学科 <span class="req">*</span></label><input class="input" id="lp-subject" list="lp-subject-options" placeholder="请选择或输入学科" required><datalist id="lp-subject-options">' + ['语文','数学','英语','物理','化学','生物','政治','历史','地理','信息技术','体育','音乐','美术'].map(value=>'<option value="'+value+'"></option>').join('') + '</datalist></div>' +
    '<div class="field"><label class="field-label" for="lp-grade">年级班级 <span class="req">*</span></label><input class="input" id="lp-grade" placeholder="例如：高一15班" required></div>' +
    '<div class="field"><label class="field-label" for="lp-title">课题 <span class="req">*</span></label><input class="input" id="lp-title" placeholder="本课课题" required></div>' +
    '<div class="field"><label class="field-label" for="lp-planDate">上课日期 <span class="req">*</span></label><input class="input" id="lp-planDate" type="date" required></div></div>' +
    '<label class="lp-section-title" for="lp-process" style="display:block">本节课授课内容</label><textarea class="input lp-textarea lp-process" id="lp-process" rows="8" placeholder="记录本节课知识点、课堂任务、课堂练习、课后作业等上课相关内容"></textarea>' +
    // Keep legacy attachment handlers available without adding fields to the simple form.
    '<div hidden><button id="lp-pick-files" type="button">选择附件</button><input id="lp-file-input" type="file" multiple><div id="lp-attach-list"></div></div></div>'
  );

  const footer = el(
    '<div class="lp-footer"><div class="lp-actions-left">' +
      '<button class="btn ghost" id="lp-import" type="button">导入文件</button>' +
      '<button class="btn ghost" id="lp-ocr" type="button">图片识别(OCR)</button>' +
      '<button class="btn ghost" id="lp-pdf" type="button">导出PDF</button>' +
      '<button class="btn ghost" id="lp-image" type="button">导出图片</button>' +
      '<input class="lp-hidden-file" id="lp-import-input" type="file" accept=".doc,.docx,.pdf">' +
      '<input class="lp-hidden-file" id="lp-ocr-input" type="file" accept="image/*">' +
      '<span class="lp-tool-status" id="lp-tool-status" aria-live="polite"></span>' +
    '</div><button class="btn primary lp-save-btn" id="lp-save" type="button">' +
      '生成备课记录' + '</button></div>'
  );

  const dialog = sheet({
    title: currentRecord ? '查看 / 编辑电子备课详情' : '电子备课详情',
    body, footer, wide: true, cls: 'lesson-plan-sheet',
  });
  const saveButton = footer.querySelector('#lp-save');
  const attachmentList = body.querySelector('#lp-attach-list');
  const toolStatus = footer.querySelector('#lp-tool-status');
  FIELD_IDS.forEach((id) => { body.querySelector('#lp-' + id).value = initial[id] || ''; });
  body.querySelector('#lp-prep-type').value = initial.prepType === PREP_UNCLASSIFIED ? '' : prepTypeLabel(initial.prepType);

  const visibleAttachmentNames = () => [
    ...existingAttachments.filter((item) => !removedIds.has(String(item.id))).map((item) => item.name),
    ...pendingFiles.map((item) => item.file.name),
  ];

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
      if (!pending) remove.dataset.removeExisting = String(item.id);
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

  const importInput = footer.querySelector('#lp-import-input');
  footer.querySelector('#lp-import').addEventListener('click', () => importInput.click());
  importInput.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    toolStatus.textContent = '正在读取文件…';
    try {
      const ext = file.name.toLowerCase().split('.').pop();
      let text = '';
      if (ext === 'pdf') text = await extractPdf(file);
      else if (ext === 'docx') text = await extractDocx(file);
      else if (ext === 'doc') throw new Error('暂不支持旧版 .doc 二进制格式，请先另存为 .docx 后导入');
      else throw new Error('目前支持 .docx 和可提取文字的 PDF 文件');
      if (!text) throw new Error('没有提取到可复制文字；扫描版 PDF 请使用图片识别(OCR)');
      applyImported(body, text);
      toolStatus.textContent = '文件内容已导入，请检查后保存。';
      toast('文件导入完成，请核对内容', 'ok');
    } catch (error) {
      toolStatus.textContent = '';
      toast(error?.message || '文件导入失败', 'err', 6000);
    } finally { event.target.value = ''; }
  });

  const ocrInput = footer.querySelector('#lp-ocr-input');
  footer.querySelector('#lp-ocr').addEventListener('click', () => ocrInput.click());
  ocrInput.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    toolStatus.textContent = '正在准备 OCR…';
    try {
      const result = await recognizeLessonPlanImage(file, (message) => { toolStatus.textContent = message; });
      applyImported(body, result.text);
      toolStatus.textContent = '识别完成（置信度 ' + result.confidence + '%），请检查并修正。';
      toast('图片文字识别完成，请核对内容', 'ok');
    } catch (error) {
      toolStatus.textContent = '';
      toast(error?.message || '图片识别失败', 'err', 6000);
    } finally { event.target.value = ''; }
  });

  footer.querySelector('#lp-pdf').addEventListener('click', () => { if (validateSimpleFields(body)) printLessonPlan(readFields(body), []); });
  footer.querySelector('#lp-image').addEventListener('click', () => { if (validateSimpleFields(body)) exportLessonPlanImage(readFields(body), []); });

  let saving = false;
  saveButton.addEventListener('click', async () => {
    if (saving) return;
    const data = readFields(body);
    const rawType = body.querySelector('#lp-prep-type').value.trim();
    const prepType = normalizePrepType(rawType);
    const typeError = validatePrepRecord({ prep_type: prepType, topic: data.title }, { isNew: true });
    if (typeError) { alert(typeError); body.querySelector(typeError.includes('类型') ? '#lp-prep-type' : '#lp-title').focus(); return; }
    if (!validateSimpleFields(body)) return;
    saving = true;
    saveButton.disabled = true;
    const originalText = saveButton.textContent;
    const creating = !currentRecord;
    saveButton.textContent = '保存中…';
    try {
      const payload = {
        date: data.planDate || ymd(new Date()),
        class_name: data.grade,
        subject: data.subject,
        topic: data.title,
        ...(prepType && prepType !== PREP_UNCLASSIFIED ? { prep_type: prepType } : {}),
        content: encodeLessonPlanContent({ ...decodeLessonPlanContent(currentRecord || {}), ...data }),
      };
      const saved = currentRecord
        ? await api.patch('/preps/' + encodeURIComponent(currentRecord.id), payload)
        : await api.post('/preps', payload);
      if (!saved || saved.id == null) throw new Error('记录保存后没有返回记录编号');
      currentRecord = saved;
      if (creating) {
        saveButton.textContent = '生成备课记录';
        const title = dialog.wrap.querySelector('.sheet-title');
        if (title) title.textContent = '查看 / 编辑电子备课详情';
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
      toast(creating ? '电子备课记录已生成' : '电子备课记录已更新', 'ok');
      dialog.close();
      await reload();
    } catch (error) {
      toast((currentRecord ? '记录已保存，但附件处理未完成：' : '保存失败：') +
        (error?.message || '请重试'), 'err', 6000);
    } finally {
      saving = false;
      saveButton.disabled = false;
      if (saveButton.isConnected) saveButton.textContent = currentRecord ? '保存修改' : originalText;
    }
  });
}

function wrapCanvasText(ctx, value, maxWidth) {
  const output = [];
  String(value || '—').split(/\r?\n/).forEach((paragraph) => {
    if (!paragraph) { output.push(''); return; }
    let line = '';
    for (const char of paragraph) {
      const next = line + char;
      if (line && ctx.measureText(next).width > maxWidth) { output.push(line); line = char; }
      else line = next;
    }
    output.push(line);
  });
  return output;
}

async function exportLessonPlanImage(data, attachments) {
  if (!data.subject && !data.title && !data.process) {
    alert('请先填写备课内容，再导出图片。');
    return;
  }
  const width = 1200, margin = 76, maxWidth = width - margin * 2;
  const blocks = [
    { type:'title', text:'电子备课记录' },
    { type:'meta', text:'备课类型：' + data.prepType + '    学科：' + data.subject },
    { type:'meta', text:'年级班级：' + data.grade + '    上课日期：' + data.planDate },
    { type:'meta', text:'课题：' + data.title },
    { type:'section', text:'本节课授课内容' }, { type:'body', text:data.process },
  ];
  const measure = document.createElement('canvas').getContext('2d');
  let totalHeight = 130;
  blocks.forEach((block) => {
    measure.font = block.type === 'title' ? 'bold 34px Microsoft YaHei'
      : block.type === 'section' ? 'bold 24px Microsoft YaHei'
      : block.type === 'meta' ? '22px Microsoft YaHei' : '20px Microsoft YaHei';
    block.lines = wrapCanvasText(measure, block.text, maxWidth);
    block.lineHeight = block.type === 'title' ? 50 : block.type === 'section' ? 38 : block.type === 'meta' ? 38 : 33;
    totalHeight += block.type === 'section' ? 48 : block.lines.length * block.lineHeight + 12;
  });
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = Math.max(900, totalHeight + 50);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  let y = 65;
  blocks.forEach((block) => {
    if (block.type === 'title') {
      ctx.font = 'bold 34px Microsoft YaHei'; ctx.fillStyle = '#1d2129'; ctx.textAlign = 'center';
      ctx.fillText(block.text, width / 2, y + 26); ctx.textAlign = 'left'; y += 66;
    } else if (block.type === 'section') {
      y += 34; ctx.fillStyle = '#2b7bcd'; ctx.fillRect(margin, y - 22, 5, 27);
      ctx.font = 'bold 24px Microsoft YaHei'; ctx.fillStyle = '#222b38';
      ctx.fillText(block.text, margin + 16, y); y += 14;
    } else {
      ctx.font = block.type === 'meta' ? '22px Microsoft YaHei' : '20px Microsoft YaHei';
      ctx.fillStyle = block.type === 'meta' ? '#4e5969' : '#344054';
      block.lines.forEach((line) => { y += block.lineHeight; ctx.fillText(line, margin, y); });
      y += 10;
    }
  });
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) { alert('图片生成失败，请重试。'); return; }
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = safeFilename(data.title) + '.png';
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  toast('备课图片已导出', 'ok');
}

function printLessonPlan(data, attachments) {
  const popup = window.open('', '_blank');
  if (!popup) {
    toast('打印窗口被浏览器拦截，请允许本站打开弹出窗口后重试', 'warn');
    return;
  }
  const blocks = [['本节课授课内容', data.process]];
  const sections = blocks.map(([heading, value]) =>
    '<section><h2>' + esc(heading) + '</h2><div>' + esc(value || '—').replace(/\r?\n/g,'<br>') + '</div></section>'
  ).join('');
  popup.document.open();
  popup.document.write('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>' +
    esc(data.title || '电子备课记录') + '</title><style>' +
    'body{font-family:"Microsoft YaHei",sans-serif;color:#1d2129;margin:28px auto;max-width:850px;line-height:1.75}' +
    'h1{text-align:center;font-size:24px;margin:0 0 18px}.meta{display:flex;flex-wrap:wrap;gap:8px 22px;border-bottom:1px solid #d8dce3;padding:10px 0 16px;color:#4e5969}' +
    'section{margin-top:18px;break-inside:auto}h2{font-size:15px;border-left:4px solid #2b7bcd;padding-left:9px;margin:0 0 8px;break-after:avoid}' +
    'section div{white-space:normal;overflow-wrap:anywhere;min-height:20px}@page{size:A4;margin:16mm}' +
    '@media print{body{margin:0;max-width:none}}</style></head><body><h1>电子备课记录</h1>' +
    '<div class="meta"><span>备课类型：' + esc(data.prepType || '—') + '</span><span>学科：' + esc(data.subject || '—') + '</span><span>年级班级：' + esc(data.grade || '—') +
    '</span><span>课题：' + esc(data.title || '—') + '</span><span>上课日期：' + esc(data.planDate || '—') +
    '</span></div>' + sections + '</body></html>');
  popup.document.close();
  popup.focus();
  popup.setTimeout(() => popup.print(), 300);
}
