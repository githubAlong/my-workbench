/* ============ 考勤：教师坐班表 / 教师教研签到表 ============
 * 设计原则：
 *  1. 一切以「纸上那张表」为准 —— 表头是「年级 + 年 月 日 + 星期 + 第几节」，表身是「序号 姓名 学科 勾选列」。
 *  2. 年级是第一层分类，高一 / 高二各自有一张坐班表、一张教研表。
 *  3. 勾选只有三种状态：空（没填）/ ✓（做了）/ ×（明确划掉）。空白不等于没做。
 */
import { api, el, esc, toast, sheet, saving, confirmDialog, doExport, saveBlob } from './core.js';
import { printAttendance } from './pdfprint.js';
import { state, icon } from './ui.js';

const WD = ['日', '一', '二', '三', '四', '五', '六'];
const pad2 = (n) => String(n).padStart(2, '0');
const ymd = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const TYPE_LABEL = { seat: '教师坐班表', research: '教师教研签到表' };

/* 学科固定顺序，跟学校习惯一致；没列到的排在后面 */
const SUBJECT_ORDER = ['语文', '数学', '英语', '物理', '化学', '生物', '政治', '历史', '地理', '体育', '音乐', '美术', '信息', '通用技术', '心理', '日语', '俄语', '道法'];
const subjectRank = (s) => { const i = SUBJECT_ORDER.indexOf(s); return i < 0 ? 99 : i; };

/* ================= 入口 ================= */
export async function renderAttendance(box) {
  let gradesData = { grades: ['高一', '高二'], builtin: ['高一', '高二'], counts: {} };
  let tables = [];
  let activeGrade = sessionStorage.getItem('wb_att_grade') || '';

  const load = async () => {
    [gradesData, tables] = await Promise.all([
      api.get('/grades').catch(() => gradesData),
      api.get('/attendance'),
    ]);
    if (!activeGrade || !gradesData.grades.includes(activeGrade)) activeGrade = gradesData.grades[0];
    paint();
  };

  const paint = () => {
    const gradeList = gradesData.grades;
    const gradeTables = (g) => tables.filter((t) => (t.grade || '高一') === g);
    box.innerHTML = `
      <div class="att-toolbar">
        <button class="btn primary sm" id="att-new">${icon('plus', 15)} 新建表格</button>
        <button class="btn ghost sm" id="att-upload">${icon('upload', 15)} 上传识别</button>
        <button class="btn ghost sm" id="att-roster">${icon('users', 15)} 教师名册</button>
        <span style="flex:1"></span>
        <span class="tiny muted hide-sm">支持 .xlsx / .csv，自动识别年级、日期、节次和勾选列</span>
      </div>
      <div class="att-grades">
        ${gradeList.map((g) => {
          const ts = gradeTables(g);
          const on = g === activeGrade;
          return `<button class="att-grade-tab${on ? ' on' : ''}" data-grade="${esc(g)}">
            <span class="agt-name">${esc(g)}</span>
            <span class="agt-meta">${ts.length ? ts.length + ' 张表' : '暂无'}</span>
          </button>`;
        }).join('')}
        <button class="att-grade-add" id="att-add-grade" title="添加年级">${icon('plus', 15)}</button>
      </div>
      <div id="att-cards">${cardsHTML(gradeTables(activeGrade), activeGrade)}</div>`;

    box.querySelector('#att-new').onclick = () => newSheetDialog(activeGrade, load);
    box.querySelector('#att-upload').onclick = () => uploadDialog(activeGrade, load);
    box.querySelector('#att-roster').onclick = () => rosterSheet(activeGrade, load);
    box.querySelector('#att-add-grade').onclick = () => addGradeDialog(load);
    box.querySelectorAll('[data-grade]').forEach((b) => {
      b.onclick = () => { activeGrade = b.dataset.grade; sessionStorage.setItem('wb_att_grade', activeGrade); paint(); };
    });
    bindCards(box, load);
  };

  await load();
}

/* 每个年级固定展示「坐班表」「教研签到表」两张入口卡 + 已有的表 */
function cardsHTML(list, grade) {
  const byType = { seat: list.filter((t) => t.sheet_type === 'seat'), research: list.filter((t) => t.sheet_type === 'research') };
  const slot = (type) => {
    const ts = byType[type];
    const label = TYPE_LABEL[type];
    if (!ts.length) {
      return `<button class="att-slot empty" data-newtype="${type}">
        <div class="as-plus">${icon('plus', 20)}</div>
        <div class="as-t">${label}</div>
        <div class="as-s">还没有，点这里新建一张</div>
      </button>`;
    }
    return `<div class="att-slot-group">
      <div class="asg-head"><span class="asg-t">${label}</span><span class="asg-n">${ts.length} 张</span></div>
      <div class="asg-list">${ts.map((t) => tableCard(t, type)).join('')}</div>
    </div>`;
  };
  return `<div class="att-groups">
    <div class="att-group">${slot('seat')}</div>
    <div class="att-group">${slot('research')}</div>
  </div>`;
}

function tableCard(t, type) {
  const s = t.summary || {};
  const d = t.sheet_date ? new Date(t.sheet_date + 'T00:00:00') : null;
  const dateText = d && !Number.isNaN(d.getTime())
    ? `${d.getMonth() + 1}月${d.getDate()}日 星期${WD[d.getDay()]}`
    : (t.month || '');
  const periods = t.periods ? `第 ${t.periods} 节` : '';
  const subjText = type === 'research' && t.subjects?.length ? `${t.subjects.length} 个学科` : '';
  const badges = [];
  if (s.leave) badges.push(`<span class="att-badge amber">请假 ${s.leave}</span>`);
  if (s.none) badges.push(`<span class="att-badge grey">未勾选 ${s.none}</span>`);
  return `<div class="att-card" data-id="${t.id}">
    <div class="ac-top">
      <div class="ac-title" data-open="${t.id}">${esc(t.name)}</div>
      <button class="icon-btn sm" data-more="${t.id}" title="更多">${icon('more', 16)}</button>
    </div>
    <div class="ac-meta">
      <span class="ac-chip">${esc(t.grade || '—')}</span>
      <span>${esc(dateText)}</span>
      ${periods ? `<span class="ac-dot">·</span><span>${esc(periods)}</span>` : ''}
      ${subjText ? `<span class="ac-dot">·</span><span>${esc(subjText)}</span>` : ''}
    </div>
    <div class="ac-count"><b>${t.row_count}</b> 人${badges.length ? ' ' + badges.join('') : ''}</div>
    <div class="ac-actions">
      <button class="btn ghost sm" data-open="${t.id}">打开</button>
      <button class="btn ghost sm" data-stat="${t.id}">统计</button>
      <button class="btn ghost sm" data-shot="${t.id}">截图</button>
    </div>
  </div>`;
}

function bindCards(root, load) {
  root.querySelectorAll('.att-card').forEach((c) => {
    c.onclick = () => openTable(Number(c.dataset.id), load);
  });
  root.querySelectorAll('[data-newtype]').forEach((b) => {
    b.onclick = () => newSheetDialog(sessionStorage.getItem('wb_att_grade') || '高一', load, b.dataset.newtype);
  });
  root.querySelectorAll('[data-open]').forEach((b) => {
    b.onclick = (e) => { e.stopPropagation(); openTable(Number(b.dataset.open), load); };
  });
  root.querySelectorAll('[data-stat]').forEach((b) => { b.onclick = (e) => { e.stopPropagation(); showStats(Number(b.dataset.stat)); }; });
  root.querySelectorAll('[data-shot]').forEach((b) => { b.onclick = (e) => { e.stopPropagation(); shotTable(Number(b.dataset.shot)); }; });
  root.querySelectorAll('[data-more]').forEach((b) => {
    b.onclick = async (e) => {
      e.stopPropagation();
      const id = Number(b.dataset.more);
      const t = (await api.get('/attendance')).find((x) => x.id === id);
      if (!t) return;
      if (await confirmDialog(`删除「${t.name}」？删除后可在地下方「回收站」找回。`)) {
        await api.del('/attendance_tables/' + id); toast('已移入回收站'); load();
      }
    };
  });
}

function addGradeDialog(reload) {
  const body = el(`<div class="sheet-body">
    <div class="field"><label class="field-label">年级名称</label>
      <input class="input" id="gname">
      <div class="field-hint">已内置「高一」「高二」，需要更多年级时在这里加。</div></div>
    <div class="confirm-actions"><button class="btn ghost" id="c">取消</button><button class="btn primary" id="k">添加</button></div>
  </div>`);
  const s = sheet({ title: '添加年级', body });
  body.querySelector('#c').onclick = s.close;
  body.querySelector('#k').onclick = async () => {
    const name = body.querySelector('#gname').value.trim();
    if (!name) return toast('请填写年级名', 'warn');
    try { await api.post('/grades', { name }); s.close(); toast('已添加'); reload(); }
    catch (e) { toast(e.message, 'err'); }
  };
}

/* ================= 新建表（自动带出名册） ================= */
function newSheetDialog(grade, reload, type = 'seat') {
  const today = ymd();
  const body = el(`<div class="sheet-body">
    <div class="field"><label class="field-label">表格类型</label>
      <div class="seg" id="stype">
        <button class="seg-btn${type === 'seat' ? ' on' : ''}" data-t="seat">教师坐班表</button>
        <button class="seg-btn${type === 'research' ? ' on' : ''}" data-t="research">教师教研签到表</button>
      </div></div>
    <div class="field-row">
      <div class="field"><label class="field-label">年级</label>
        <select class="input" id="grade">${[grade, '高一', '高二'].filter((v, i, a) => a.indexOf(v) === i).map((g) => `<option ${g === grade ? 'selected' : ''}>${esc(g)}</option>`).join('')}</select></div>
      <div class="field"><label class="field-label">日期</label><input class="input" type="date" id="date" value="${today}"></div>
    </div>
    <div class="field-row">
      <div class="field" id="wrap-periods"><label class="field-label">节次</label><input class="input" id="periods" value="1-2"></div>
      <div class="field" id="wrap-subject" hidden><label class="field-label">学科（可选）</label><input class="input" id="subject"></div>
    </div>
    <div class="field"><label class="field-label">表格名称</label><input class="input" id="name"></div>
    <div class="att-roster-hint" id="rhint">正在读取名册…</div>
    <div class="confirm-actions"><button class="btn ghost" id="c">取消</button><button class="btn primary" id="k">创建并打开</button></div>
  </div>`);
  const s = sheet({ title: '新建考勤表', body });
  const $ = (x) => body.querySelector(x);
  let roster = [];

  const autoName = () => {
    const g = $('#grade').value; const d = $('#date').value;
    const dt = d ? new Date(d + 'T00:00:00') : new Date();
    const isSeat = $('#stype .on').dataset.t === 'seat';
    const per = isSeat && $('#periods').value ? ` · 第${$('#periods').value.replace(/-/g, '-')}节` : '';
    $('#name').value = `${dt.getFullYear()}年${g}${isSeat ? '老师坐班表' : '老师教研签到表'}${per}`;
  };
  const loadRoster = async () => {
    const g = $('#grade').value;
    try {
      const r = await api.get('/teachers', { grade: g });
      roster = r.list || [];
      const subs = [...new Set(roster.map((t) => t.subject).filter(Boolean))];
      $('#rhint').innerHTML = roster.length
        ? `将从名册带出 <b>${roster.length}</b> 位教师${subs.length ? `（${subs.length} 个学科）` : ''}，创建后逐个打勾即可。`
        : `「${esc(g)}」还没有名册。<button class="link-btn" id="go-roster">现在录入 →</button>`;
      if (!roster.length) {
        $('#rhint').querySelector('#go-roster').onclick = () => { s.close(); rosterSheet(g, reload); };
      }
    } catch { $('#rhint').textContent = '名册读取失败，将创建空表'; }
  };
  const syncType = () => {
    const isSeat = $('#stype .on').dataset.t === 'seat';
    $('#wrap-periods').hidden = !isSeat;
    $('#wrap-subject').hidden = isSeat;
    autoName();
  };
  body.querySelectorAll('#stype .seg-btn').forEach((b) => {
    b.onclick = () => {
      body.querySelectorAll('#stype .seg-btn').forEach((x) => x.classList.toggle('on', x === b));
      syncType();
    };
  });
  ['#grade', '#date', '#periods', '#subject'].forEach((sel) => {
    $(sel).addEventListener('input', () => { autoName(); });
    $(sel).addEventListener('change', () => { autoName(); if (sel === '#grade') loadRoster(); });
  });
  syncType(); loadRoster();
  $('#c').onclick = s.close;
  saving($('#k'), async () => {
    const isSeat = $('#stype .on').dataset.t === 'seat';
    const d = $('#date').value;
    const dt = d ? new Date(d + 'T00:00:00') : new Date();
    const r = await api.post('/attendance', {
      sheet_type: isSeat ? 'seat' : 'research',
      grade: $('#grade').value,
      sheet_date: d,
      weekday: WD[dt.getDay()],
      periods: isSeat ? $('#periods').value : '',
      subject: isSeat ? '' : $('#subject').value,
      name: $('#name').value,
      month: d.slice(0, 7),
    });
    // 把名册里的人灌进新表
    if (roster.length) {
      await api.post(`/attendance/${r.id}/rows`, {
        rows: roster.map((t) => ({ teacher: t.name, subject: t.subject, data: {} })),
      });
    }
    s.close(); toast(roster.length ? `已创建，带出 ${roster.length} 位教师` : '已创建'); reload();
    openTable(r.id, reload);
  });
}

/* ================= 打开一张表 ================= */
async function openTable(id, reload) {
  const t = await api.get('/attendance/' + id);
  return t.sheet_type === 'research' ? openResearch(t, reload) : openSeat(t, reload);
}

/* ---------- 通用：表头信息条 ---------- */
function headerBar(t, onRefresh) {
  const d = t.sheet_date ? new Date(t.sheet_date + 'T00:00:00') : null;
  const yy = d && !Number.isNaN(d.getTime()) ? d.getFullYear() : (t.meta?.year || new Date().getFullYear());
  const mm = d && !Number.isNaN(d.getTime()) ? d.getMonth() + 1 : '';
  const dd = d && !Number.isNaN(d.getDate) && d ? d.getDate() : '';
  const wk = d && !Number.isNaN(d.getTime()) ? WD[d.getDay()] : (t.weekday || '');
  const isSeat = t.sheet_type === 'seat';
  const nPhoto = Number(t.photo_count || 0);
  return `<div class="att-header">
    <div class="ah-grade">${esc(t.grade || '高一')}</div>
    <div class="ah-date">
      <span class="ah-num">${yy}</span><span class="ah-u">年</span>
      <span class="ah-num">${mm}</span><span class="ah-u">月</span>
      <span class="ah-num">${dd}</span><span class="ah-u">日</span>
    </div>
    <div class="ah-wd">星期${esc(wk || '—')}</div>
    ${isSeat && t.periods ? `<div class="ah-period">第 ${esc(t.periods)} 节</div>` : ''}
    <span style="flex:1"></span>
    <button class="btn primary sm" id="att-quick">${icon('zap', 14)} 快速打勾</button>
    <button class="btn ghost sm" id="att-photos">${icon('camera', 14)} 原图${nPhoto ? ` ${nPhoto}` : ''}</button>
    <button class="btn ghost sm" id="att-edit-head">${icon('edit', 14)} 改日期/节次</button>
  </div>`;
}

/* ---------- 导出 PDF：先保存，再下载 ---------- */
async function saveThenPdf(t, rows) {
  const btn = document.querySelector('#att-pdf');
  const old = btn ? btn.innerHTML : '';
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '生成中…';
    btn.style.opacity = '.65';
  }
  toast('正在生成 PDF…');
  try {
    // 先把当前改动落库，否则刚打的勾不会进 PDF
    if (rows) {
      await api.post(`/attendance/${t.id}/rows`, {
        rows: rows.map((r) => ({ id: r.id, teacher: r.teacher, subject: r.subject, data: r.data })),
      });
    }
    /* 静态版：没有服务端 Python 渲染 PDF，改为本地拼 A4 排版 + 调起打印。
       在打印对话框里选「另存为 PDF」得到的就是原来那份文件。 */
    const detail = await api.get('/attendance/' + t.id);
    const cols = detail.columns || [];
    const checkCols = cols.filter((c) => c.type === 'check');
    const otherCols = cols.filter((c) => c.type !== 'check');
    const d = detail.sheet_date ? new Date(detail.sheet_date + 'T00:00:00') : null;
    const wkName = ['日', '一', '二', '三', '四', '五', '六'];
    const dateText = d && !Number.isNaN(d.getTime())
      ? `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日` : '';
    const outRows = (detail.rows || []).map((r, i) => {
      const marks = checkCols.map((c) => String(r.data?.[c.key] ?? ''));
      otherCols.forEach((c) => marks.push(String(r.data?.[c.key] ?? '')));
      return { no: i + 1, name: r.teacher, subject: r.subject || '', marks };
    });
    const summary = checkCols.map((c) => ({
      label: c.label,
      value: String((detail.rows || []).filter((r) => r.data?.[c.key] === '1').length),
    }));
    const vacant = (detail.rows || []).filter((r) => checkCols.every((c) => !r.data?.[c.key])).length;
    if (vacant) summary.push({ label: '一项未填', value: String(vacant) });
    summary.unshift({ label: '教师', value: String((detail.rows || []).length) });
    if (!outRows.length) throw new Error('这张表还没有数据');
    printAttendance({
      title: detail.name || `${detail.grade || ''}考勤表`,
      grade: detail.grade || '',
      date_text: dateText,
      weekday: d && !Number.isNaN(d.getTime()) ? '星期' + wkName[d.getDay()] : (detail.weekday ? '星期' + detail.weekday : ''),
      periods: detail.periods ? `第 ${detail.periods} 节` : '',
      columns: cols,
      rows: outRows,
      summary,
      footer: `导出于 ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    });
    toast('已打开打印预览，选「另存为 PDF」即可');
  } catch (e) {
    toast(e.message || 'PDF 生成失败', 'err');
  } finally {
    if (btn && btn.isConnected) {
      btn.disabled = false;
      btn.innerHTML = old;
      btn.style.opacity = '';
    }
  }
}

/* ---------- 快速打勾：一屏一人，标完自动下一个 ---------- */
function quickSheet(t, rowsRef, onDone) {
  const cols = (t.columns || []).filter((c) => c.type === 'check');
  if (!cols.length) return toast('这张表没有勾选列', 'warn');
  let queue = rowsRef.map((r, i) => ({ ...r, _i: i })).filter((r) => {
    // 默认只过「一项都没填」的人；全填完了就全部重过一遍
    return cols.every((c) => !r.data?.[c.key]);
  });
  const allCount = rowsRef.length;
  const blankCount = queue.length;
  if (!queue.length) queue = rowsRef.map((r, i) => ({ ...r, _i: i }));
  const skipped = blankCount === 0;

  let pos = 0;
  const body = el(`<div class="att-quick">
    <div class="aq-bar">
      <div class="aq-prog"><i id="aq-fill"></i></div>
      <div class="aq-count" id="aq-count"></div>
    </div>
    <div class="aq-card" id="aq-card"></div>
    <div class="aq-legend">
      ${skipped ? '所有人都填过了，这次是逐个复核。' : `还有 <b>${blankCount}</b> 人没填，逐个过一遍。`}
      标完自动跳到下一个。
    </div>
    <div class="confirm-actions">
      <button class="btn ghost" id="aq-prev">上一位</button>
      <button class="btn ghost" id="aq-skip">跳过</button>
      <button class="btn primary" id="aq-save">保存并关闭</button>
    </div>
  </div>`);
  const s = sheet({ title: '快速打勾', body, cls: 'att-quick-sheet' });
  const $ = (x) => body.querySelector(x);
  let changed = 0;

  const paint = () => {
    const r = queue[pos];
    if (!r) return;
    const doneAll = cols.every((c) => r.data?.[c.key]);
    $('#aq-count').textContent = `${pos + 1} / ${queue.length}　${r.teacher}${r.subject ? ' · ' + r.subject : ''}`;
    $('#aq-fill').style.width = `${Math.round((pos + (doneAll ? 1 : 0)) / queue.length * 100)}%`;
    $('#aq-card').innerHTML = `
      <div class="aq-name">${esc(r.teacher)}</div>
      <div class="aq-subj">${esc(r.subject || '')}</div>
      <div class="aq-tiles" data-n="${Math.min(cols.length, 5)}">
        ${cols.map((c) => {
          const v = String(r.data?.[c.key] ?? '');
          return `<button class="aq-tile ${v === '1' ? 'on' : v === '0' ? 'off' : ''}" data-k="${c.key}">
            <span class="aq-tile-l">${esc(c.label)}</span>
            <span class="aq-tile-m">${v === '1' ? '✓' : v === '0' ? '×' : ''}</span>
          </button>`;
        }).join('')}
      </div>
      <div class="aq-hint">点一下 = ✓ 做了　再点 = × 没做　再点 = 清空</div>`;
    $('#aq-card').querySelectorAll('.aq-tile').forEach((b) => {
      b.onclick = () => {
        const k = b.dataset.k;
        const cur = String(rowsRef[r._i].data?.[k] ?? '');
        const next = cur === '' ? '1' : cur === '1' ? '0' : '';
        rowsRef[r._i].data = rowsRef[r._i].data || {};
        if (next === '') delete rowsRef[r._i].data[k]; else rowsRef[r._i].data[k] = next;
        changed++;
        const allDone = cols.every((c) => rowsRef[r._i].data?.[c.key]);
        if (allDone && next !== '') {
          // 全标完了，自动进下一个
          const old = b.className;
          b.className = 'aq-tile ' + (next === '1' ? 'on' : 'off');
          setTimeout(() => { if (pos < queue.length - 1) { pos++; paint(); } else paint(); }, 180);
        } else paint();
      };
    });
    $('#aq-prev').disabled = pos === 0;
  };
  paint();
  $('#aq-prev').onclick = () => { if (pos > 0) { pos--; paint(); } };
  $('#aq-skip').onclick = () => { if (pos < queue.length - 1) { pos++; paint(); } else toast('已经是最后一位了', 'warn'); };
  saving($('#aq-save'), async () => {
    await api.post(`/attendance/${t.id}/rows`, {
      rows: rowsRef.map((r) => ({ id: r.id, teacher: r.teacher, subject: r.subject, data: r.data })),
    });
    toast(changed ? `已保存（${changed} 次修改）` : '已保存');
    s.close();
    onDone?.();
  });
}

/* ---------- 原始照片（纸表扫描件 / 手机拍的） ---------- */
async function photosSheet(tableId, onCount) {
  const list = await api.get(`/attendance/${tableId}/photos`).catch(() => []);
  const body = el(`<div class="att-photos">
    <div class="ap-hint">这里放这张表的纸质原件（拍的照片或扫描件），随时能调出来核对。</div>
    <div class="ap-list" id="ap-list"></div>
    <label class="ap-add" id="ap-add">
      <input type="file" accept="image/*" multiple hidden id="ap-file">
      <span>${icon('upload', 18)} 添加照片 / 拍照</span>
    </label>
    <div class="confirm-actions"><button class="btn ghost" id="ap-close">关闭</button></div>
  </div>`);
  const s = sheet({ title: '原始照片', body, wide: true, cls: 'att-photos-sheet' });
  const $ = (x) => body.querySelector(x);

  const paint = (items) => {
    $('#ap-list').innerHTML = items.length ? items.map((p) => `
      <div class="ap-item" data-pid="${p.id}">
        <a class="ap-thumb" href="${esc(p.url)}" target="_blank" rel="noopener">
          <img src="${esc(p.url)}" alt="${esc(p.name)}" loading="lazy">
        </a>
        <div class="ap-meta">
          <div class="ap-name">${esc(p.name || '照片')}</div>
          <div class="ap-size">${fmtSize(p.size)}</div>
        </div>
        <button class="icon-btn sm" data-del="${p.id}" title="删除">${icon('close', 13)}</button>
      </div>`).join('') : '<div class="ap-empty">还没有照片。拍一张纸表存进来，以后核对有据可查。</div>';
    body.querySelectorAll('[data-del]').forEach((b) => {
      b.onclick = async () => {
        if (!(await confirmDialog('删除这张照片？'))) return;
        await api.del('/attachments/' + b.dataset.del);
        toast('已删除');
        const now = await api.get(`/attendance/${tableId}/photos`).catch(() => []);
        paint(now); onCount?.(now.length);
      };
    });
  };
  paint(list);

  $('#ap-file').onchange = async (e) => {
    const files = [...e.target.files];
    if (!files.length) return;
    toast('正在上传…');
    try {
      for (const f of files) {
        const fd = new FormData();
        fd.append('file', f);
        fd.append('owner_type', 'attendance');
        fd.append('owner_id', String(tableId));
        await api.post('/upload', fd);
      }
      toast(`已存入 ${files.length} 张照片`);
      const now = await api.get(`/attendance/${tableId}/photos`).catch(() => []);
      paint(now); onCount?.(now.length);
    } catch (err) { toast(err.message, 'err'); }
  };
  $('#ap-close').onclick = s.close;
}

function fmtSize(n) {
  const v = Number(n) || 0;
  return v > 1024 * 1024 ? (v / 1024 / 1024).toFixed(1) + ' MB' : Math.max(1, Math.round(v / 1024)) + ' KB';
}

/* ---------- 勾选方块：空 → ✓ → × → 空 ---------- */
function tickCell(value, ri, key) {
  const v = String(value ?? '');
  const cls = v === '1' ? 'on' : v === '0' ? 'off' : '';
  const mark = v === '1' ? '✓' : v === '0' ? '×' : '';
  return `<button class="tick ${cls}" data-r="${ri}" data-k="${key}" aria-label="切换">${mark}</button>`;
}

/* ================= 坐班表 ================= */
function openSeat(t, reload) {
  let rows = t.rows.slice();
  let cols = t.columns.slice();
  const checkCols = cols.filter((c) => c.type === 'check');
  const remarkCol = cols.find((c) => c.type !== 'check');

  const body = el(`<div class="att-edit">
    ${headerBar(t)}
    <div class="att-sum" id="att-sum"></div>
    <div class="att-tools">
      <input class="input att-search" id="att-q" placeholder="搜姓名 / 学科…">
      <button class="btn ghost sm" id="att-reset">清空勾选</button>
      <button class="btn ghost sm" id="att-fillall">全部标 ✓</button>
      <span style="flex:1"></span>
      <button class="btn ghost sm" id="att-addrow">＋ 加一行</button>
      <button class="btn ghost sm" id="att-addcol">＋ 加一列</button>
      <button class="btn ghost sm" id="att-pdf">${icon('download', 14)} PDF</button>
      <button class="btn primary sm" id="att-save">保存</button>
    </div>
    <div class="att-table-wrap"><div id="att-table"></div></div>
    <div class="att-legend">
      <span><i class="tick on">✓</i> 已做</span>
      <span><i class="tick off">×</i> 明确划掉（未做）</span>
      <span><i class="tick"></i> 空白（未填写）</span>
      <span class="muted">点方块循环切换：空 → ✓ → × → 空</span>
    </div>
  </div>`);
  const s = sheet({ title: `${t.grade || ''} ${TYPE_LABEL.seat}`, body, wide: true, cls: 'att-sheet' });
  const $ = (x) => body.querySelector(x);

  let filter = '';
  const paint = () => {
    const list = rows.map((r, i) => ({ ...r, _i: i })).filter((r) => {
      if (!filter) return true;
      const k = filter.toLowerCase();
      return String(r.teacher).toLowerCase().includes(k) || String(r.subject).includes(k);
    });
    // 按学科排序显示，但保留原序号
    list.sort((a, b) => subjectRank(a.subject) - subjectRank(b.subject) || a._i - b._i);
    const sum = (key) => rows.filter((r) => r.data?.[key] === '1').length;
    const vacant = rows.filter((r) => checkCols.every((c) => !r.data?.[c.key])).length;
    $('#att-sum').innerHTML = `
      <span class="as-total"><b>${rows.length}</b> 人</span>
      ${checkCols.map((c) => `<span class="as-item"><i>${esc(c.label)}</i><b>${sum(c.key)}</b></span>`).join('')}
      ${vacant ? `<span class="as-warn">${vacant} 人一项都没勾</span>` : ''}`;
    $('#att-table').innerHTML = `<table class="att-tbl">
      <thead><tr>
        <th class="th-no">序号</th><th class="th-name">姓名</th><th class="th-subj">学科</th>
        ${checkCols.map((c) => `<th class="th-check">${esc(c.label)}</th>`).join('')}
        ${remarkCol ? `<th class="th-remark">${esc(remarkCol.label)}</th>` : ''}
        <th class="th-del"></th>
      </tr></thead>
      <tbody>${list.map((r, k) => `<tr data-ri="${r._i}">
        <td class="td-no">${k + 1}</td>
        <td class="td-name"><input class="cell-in" data-r="${r._i}" data-k="__teacher" value="${esc(r.teacher)}"></td>
        <td class="td-subj"><input class="cell-in subject-in" data-r="${r._i}" data-k="__subject" value="${esc(r.subject || '')}" list="subj-list"></td>
        ${checkCols.map((c) => `<td class="td-check">${tickCell(r.data?.[c.key], r._i, c.key)}</td>`).join('')}
        ${remarkCol ? `<td class="td-remark"><input class="cell-in" data-r="${r._i}" data-k="${remarkCol.key}" value="${esc(r.data?.[remarkCol.key] ?? '')}"></td>` : ''}
        <td class="td-del"><button class="icon-btn sm" data-del="${r._i}" title="删除此行">${icon('close', 13)}</button></td>
      </tr>`).join('')}</tbody>
    </table>
    <datalist id="subj-list">${SUBJECT_ORDER.map((x) => `<option>${x}</option>`).join('')}</datalist>`;

    // 勾选
    body.querySelectorAll('.tick').forEach((b) => {
      b.onclick = () => {
        const ri = Number(b.dataset.r); const k = b.dataset.k;
        const cur = String(rows[ri].data?.[k] ?? '');
        const next = cur === '' ? '1' : cur === '1' ? '0' : '';
        rows[ri].data = rows[ri].data || {};
        if (next === '') delete rows[ri].data[k]; else rows[ri].data[k] = next;
        // 局部更新，不重绘整表（避免输入框失焦）
        b.className = 'tick' + (next === '1' ? ' on' : next === '0' ? ' off' : '');
        b.textContent = next === '1' ? '✓' : next === '0' ? '×' : '';
        updateSum();
      };
    });
    // 姓名 / 学科 / 备注
    body.querySelectorAll('.cell-in').forEach((inp) => {
      inp.oninput = () => {
        const ri = Number(inp.dataset.r); const k = inp.dataset.k;
        if (k === '__teacher') rows[ri].teacher = inp.value;
        else if (k === '__subject') rows[ri].subject = inp.value;
        else { rows[ri].data = rows[ri].data || {}; rows[ri].data[k] = inp.value; }
      };
    });
    body.querySelectorAll('[data-del]').forEach((b) => {
      b.onclick = () => { rows.splice(Number(b.dataset.del), 1); paint(); };
    });
  };
  const updateSum = () => {
    const sum = (key) => rows.filter((r) => r.data?.[key] === '1').length;
    const vacant = rows.filter((r) => checkCols.every((c) => !r.data?.[c.key])).length;
    const elSum = $('#att-sum');
    if (!elSum) return;
    elSum.innerHTML = `<span class="as-total"><b>${rows.length}</b> 人</span>
      ${checkCols.map((c) => `<span class="as-item"><i>${esc(c.label)}</i><b>${sum(c.key)}</b></span>`).join('')}
      ${vacant ? `<span class="as-warn">${vacant} 人一项都没勾</span>` : ''}`;
  };

  paint();
  $('#att-q').oninput = (e) => { filter = e.target.value.trim(); paint(); };
  $('#att-addrow').onclick = () => { rows.push({ teacher: '', subject: '', data: {} }); paint(); };
  $('#att-addcol').onclick = () => colEditor(cols, null, (n) => { cols = n; checkCols.length = 0; cols.filter((c) => c.type === 'check').forEach((c) => checkCols.push(c)); paint(); });
  $('#att-reset').onclick = async () => {
    if (!(await confirmDialog('把这张表所有勾选清空？'))) return;
    rows.forEach((r) => { r.data = {}; }); paint();
  };
  $('#att-fillall').onclick = async () => {
    const first = checkCols[0];
    if (!first) return;
    if (!(await confirmDialog(`把所有人「${first.label}」都标成 ✓？`))) return;
    rows.forEach((r) => { r.data = r.data || {}; r.data[first.key] = '1'; }); paint();
  };
  $('#att-quick').onclick = () => quickSheet(t, rows, () => { paint(); });
  $('#att-pdf').onclick = () => saveThenPdf(t, rows);
  $('#att-edit-head').onclick = () => editHead(t, s, reload);
  $('#att-photos').onclick = () => photosSheet(t.id, (n) => {
    t.photo_count = n;
    const b = $('#att-photos');
    if (b) b.innerHTML = `${icon('camera', 14)} 原图${n ? ' ' + n : ''}`;
  });
  saving($('#att-save'), async () => {
    await api.post(`/attendance/${t.id}/rows`, { rows: rows.map((r) => ({ id: r.id, teacher: r.teacher, subject: r.subject, data: r.data })) });
    await api.patch('/attendance/' + t.id, { columns: cols });
    toast('已保存'); s.close(); reload();
  });
}

/* ================= 教研签到表（按学科分块） ================= */
function openResearch(t, reload) {
  let rows = t.rows.slice();
  let cols = t.columns.slice();
  const checkCols = cols.filter((c) => c.type === 'check');
  const remarkCol = cols.find((c) => c.type !== 'check');

  const body = el(`<div class="att-edit">
    ${headerBar(t)}
    <div class="att-sum" id="att-sum"></div>
    <div class="att-tools">
      <input class="input att-search" id="att-q" placeholder="搜姓名 / 学科…">
      <button class="btn ghost sm" id="att-expand">展开全部</button>
      <span style="flex:1"></span>
      <button class="btn ghost sm" id="att-addrow">＋ 加一位教师</button>
      <button class="btn ghost sm" id="att-pdf">${icon('download', 14)} PDF</button>
      <button class="btn primary sm" id="att-save">保存</button>
    </div>
    <div id="att-blocks" class="att-blocks"></div>
    <div class="att-legend">
      <span><i class="tick on">✓</i> 已签到</span>
      <span><i class="tick off">×</i> 未签到</span>
      <span><i class="tick"></i> 未填写</span>
      <span class="muted">点块头「全部签到」可一键勾选整个学科组</span>
    </div>
  </div>`);
  const s = sheet({ title: `${t.grade || ''} ${TYPE_LABEL.research}`, body, wide: true, cls: 'att-sheet' });
  const $ = (x) => body.querySelector(x);
  let filter = '';
  let collapsed = new Set();

  const paint = () => {
    const key = checkCols[0]?.key || 'k_签到';
    // 按学科分组
    const groups = new Map();
    rows.forEach((r, i) => {
      const sj = r.subject || '未分学科';
      if (!groups.has(sj)) groups.set(sj, []);
      groups.get(sj).push({ ...r, _i: i });
    });
    const sorted = [...groups.entries()].sort((a, b) => subjectRank(a[0]) - subjectRank(b[0]));
    const totalSigned = rows.filter((r) => r.data?.[key] === '1').length;
    const rate = rows.length ? Math.round(totalSigned / rows.length * 100) : 0;
    $('#att-sum').innerHTML = `<span class="as-total"><b>${rows.length}</b> 人 · ${sorted.length} 个学科</span>
      <span class="as-item"><i>已签到</i><b>${totalSigned}</b></span>
      <span class="as-item"><i>签到率</i><b>${rate}%</b></span>
      ${rows.length - totalSigned ? `<span class="as-warn">${rows.length - totalSigned} 人未签到</span>` : ''}`;

    $('#att-blocks').innerHTML = sorted.map(([sj, list]) => {
      const shown = list.filter((r) => !filter || String(r.teacher).includes(filter) || String(r.subject).includes(filter));
      if (!shown.length) return '';
      const signed = list.filter((r) => r.data?.[key] === '1').length;
      const isCollapsed = collapsed.has(sj) && !filter;
      const pct = list.length ? Math.round(signed / list.length * 100) : 0;
      return `<div class="att-block" data-sj="${esc(sj)}">
        <div class="ab-head">
          <button class="ab-toggle" data-toggle="${esc(sj)}">${icon(isCollapsed ? 'down' : 'down', 15, isCollapsed ? '' : 'rot')}</button>
          <span class="ab-name">${esc(sj)}</span>
          <span class="ab-count">${list.length} 人</span>
          <span class="ab-bar"><i style="width:${pct}%"></i></span>
          <span class="ab-pct">${signed}/${list.length}</span>
          <span style="flex:1"></span>
          <button class="btn ghost sm" data-all="${esc(sj)}">全部签到</button>
        </div>
        ${isCollapsed ? '' : `<table class="att-tbl att-tbl-compact">
          <thead><tr><th class="th-no">序号</th><th class="th-name">姓名</th><th class="th-check">${esc(checkCols[0]?.label || '签到')}</th>
          ${remarkCol ? `<th class="th-remark">${esc(remarkCol.label)}</th>` : ''}</tr></thead>
          <tbody>${shown.map((r, k) => `<tr>
            <td class="td-no">${k + 1}</td>
            <td class="td-name"><input class="cell-in" data-r="${r._i}" data-k="__teacher" value="${esc(r.teacher)}"></td>
            <td class="td-check">${tickCell(r.data?.[key], r._i, key)}</td>
            ${remarkCol ? `<td class="td-remark"><input class="cell-in" data-r="${r._i}" data-k="${remarkCol.key}" value="${esc(r.data?.[remarkCol.key] ?? '')}" placeholder="—"></td>` : ''}
          </tr>`).join('')}</tbody></table>`}
      </div>`;
    }).join('') || '<div class="att-empty">没有匹配的教师</div>';

    body.querySelectorAll('.tick').forEach((b) => {
      b.onclick = () => {
        const ri = Number(b.dataset.r); const k = b.dataset.k;
        const cur = String(rows[ri].data?.[k] ?? '');
        const next = cur === '' ? '1' : cur === '1' ? '0' : '';
        rows[ri].data = rows[ri].data || {};
        if (next === '') delete rows[ri].data[k]; else rows[ri].data[k] = next;
        b.className = 'tick' + (next === '1' ? ' on' : next === '0' ? ' off' : '');
        b.textContent = next === '1' ? '✓' : next === '0' ? '×' : '';
        refreshBlockHeads();
      };
    });
    body.querySelectorAll('.cell-in').forEach((inp) => {
      inp.oninput = () => {
        const ri = Number(inp.dataset.r); const k = inp.dataset.k;
        if (k === '__teacher') rows[ri].teacher = inp.value;
        else { rows[ri].data = rows[ri].data || {}; rows[ri].data[k] = inp.value; }
      };
    });
    body.querySelectorAll('[data-toggle]').forEach((b) => {
      b.onclick = () => {
        const sj = b.dataset.toggle;
        if (collapsed.has(sj)) collapsed.delete(sj); else collapsed.add(sj);
        paint();
      };
    });
    body.querySelectorAll('[data-all]').forEach((b) => {
      b.onclick = () => {
        const sj = b.dataset.all;
        rows.forEach((r) => {
          if ((r.subject || '未分学科') === sj) { r.data = r.data || {}; r.data[key] = '1'; }
        });
        paint();
        toast(`「${sj}」已全部标为签到`);
      };
    });
  };
  const refreshBlockHeads = () => {
    const key = checkCols[0]?.key || 'k_签到';
    const totalSigned = rows.filter((r) => r.data?.[key] === '1').length;
    const rate = rows.length ? Math.round(totalSigned / rows.length * 100) : 0;
    const elSum = $('#att-sum');
    if (elSum) {
      const nSub = new Set(rows.map((r) => r.subject || '未分学科')).size;
      elSum.innerHTML = `<span class="as-total"><b>${rows.length}</b> 人 · ${nSub} 个学科</span>
        <span class="as-item"><i>已签到</i><b>${totalSigned}</b></span>
        <span class="as-item"><i>签到率</i><b>${rate}%</b></span>
        ${rows.length - totalSigned ? `<span class="as-warn">${rows.length - totalSigned} 人未签到</span>` : ''}`;
    }
    body.querySelectorAll('.att-block').forEach((blk) => {
      const sj = blk.dataset.sj;
      const list = rows.filter((r) => (r.subject || '未分学科') === sj);
      const signed = list.filter((r) => r.data?.[key] === '1').length;
      const pct = list.length ? Math.round(signed / list.length * 100) : 0;
      const bar = blk.querySelector('.ab-bar i'); if (bar) bar.style.width = pct + '%';
      const pc = blk.querySelector('.ab-pct'); if (pc) pc.textContent = `${signed}/${list.length}`;
    });
  };

  paint();
  $('#att-q').oninput = (e) => { filter = e.target.value.trim(); paint(); };
  $('#att-expand').onclick = () => { collapsed.clear(); paint(); toast('已展开全部学科'); };
  $('#att-addrow').onclick = () => { rows.push({ teacher: '', subject: '', data: {} }); paint(); };
  /* openResearch 自己的工具栏模板里没有 att-quick 按钮，
     早先这里无条件 $('#att-quick').onclick = ... → null 赋值抛 TypeError，
     后面的保存 / 加行 / PDF / 改表头 / 原图绑定全部中断，教研签到表存不了。 */
  const quickBtnR = $('#att-quick');
  if (quickBtnR) quickBtnR.onclick = () => quickSheet(t, rows, () => { paint(); });
  $('#att-pdf').onclick = () => saveThenPdf(t, rows);
  $('#att-edit-head').onclick = () => editHead(t, s, reload);
  $('#att-photos').onclick = () => photosSheet(t.id, (n) => {
    t.photo_count = n;
    const b = $('#att-photos');
    if (b) b.innerHTML = `${icon('camera', 14)} 原图${n ? ' ' + n : ''}`;
  });
  saving($('#att-save'), async () => {
    await api.post(`/attendance/${t.id}/rows`, { rows: rows.map((r) => ({ id: r.id, teacher: r.teacher, subject: r.subject, data: r.data })) });
    toast('已保存'); s.close(); reload();
  });
}

/* ---------- 改表头（日期 / 节次） ---------- */
function editHead(t, parentSheet, reload) {
  const body = el(`<div class="sheet-body">
    <div class="field-row">
      <div class="field"><label class="field-label">年级</label><input class="input" id="g" value="${esc(t.grade || '')}"></div>
      <div class="field"><label class="field-label">日期</label><input class="input" type="date" id="d" value="${esc(t.sheet_date || '')}"></div>
    </div>
    <div class="field-row">
      <div class="field"><label class="field-label">星期</label><input class="input" id="w" value="${esc(t.weekday || '')}" placeholder="一"></div>
      <div class="field"><label class="field-label">节次</label><input class="input" id="p" value="${esc(t.periods || '')}" placeholder="1-2"></div>
    </div>
    <div class="field"><label class="field-label">表格名称</label><input class="input" id="n" value="${esc(t.name)}"></div>
    <div class="confirm-actions"><button class="btn ghost" id="c">取消</button><button class="btn primary" id="k">保存</button></div>
  </div>`);
  const s = sheet({ title: '修改表头信息', body });
  const $ = (x) => body.querySelector(x);
  $('#d').onchange = () => {
    const v = $('#d').value; if (!v) return;
    const dt = new Date(v + 'T00:00:00');
    $('#w').value = WD[dt.getDay()];
  };
  $('#c').onclick = s.close;
  $('#k').onclick = async () => {
    await api.patch('/attendance/' + t.id, {
      grade: $('#g').value, sheet_date: $('#d').value, weekday: $('#w').value,
      periods: $('#p').value, name: $('#n').value,
      month: ($('#d').value || '').slice(0, 7) || t.month,
    });
    s.close(); parentSheet.close(); toast('已更新'); reload();
  };
}

/* ---------- 列编辑器（坐班表加列用） ---------- */
function colEditor(cols, idx, done) {
  const isNew = idx === null;
  const c = isNew ? { key: 'k_' + Date.now().toString(36), label: '新列', type: 'check' } : cols[idx];
  const body = el(`<div class="sheet-body">
    <div class="field"><label class="field-label">列名</label><input class="input" id="l" value="${esc(c.label)}"></div>
    <div class="field"><label class="field-label">类型</label><select class="input" id="ty">
      <option value="check" ${c.type === 'check' ? 'selected' : ''}>勾选（✓ / × / 空）</option>
      <option value="text" ${c.type === 'text' ? 'selected' : ''}>文本</option>
    </select></div>
    <div class="confirm-actions">
      ${isNew ? '' : '<button class="btn ghost" id="d" style="margin-right:auto;color:var(--red)">删除此列</button>'}
      <button class="btn ghost" id="c">取消</button><button class="btn primary" id="k">确定</button></div>
  </div>`);
  const s = sheet({ title: isNew ? '新增列' : '编辑列', body });
  body.querySelector('#c').onclick = s.close;
  const del = body.querySelector('#d');
  if (del) del.onclick = () => { cols.splice(idx, 1); s.close(); done(cols); };
  body.querySelector('#k').onclick = () => {
    c.label = body.querySelector('#l').value.trim() || '新列';
    c.type = body.querySelector('#ty').value;
    c.key = c.type === 'check' ? 'k_' + c.label : c.key;
    if (isNew) cols.push(c);
    s.close(); done(cols);
  };
}

/* ================= 上传识别 ================= */
function uploadDialog(grade, reload) {
  const body = el(`<div class="sheet-body">
    <div class="att-drop" id="drop">
      <div class="ad-ico">${icon('upload', 26)}</div>
      <div class="ad-t">点这里选文件，或把表格拖进来</div>
      <div class="ad-s">支持 <b>截图 / 拍照</b>、.xlsx / .csv，单表 12MB 以内</div>
      <input type="file" id="file" accept=".xlsx,.xlsm,.csv,.txt,.tsv,image/*" hidden>
    </div>
    <div class="att-tips">
      <div class="att-tip-h">能自动认出这些</div>
      <div class="att-tip-grid">
        <div>${icon('check', 14)} 哪一列是姓名、哪几列要打勾</div>
        <div>${icon('check', 14)} 每一格是 √ 还是 ×（空白保持未填）</div>
        <div>${icon('check', 14)} 表类型（坐班 / 教研）</div>
        <div>${icon('check', 14)} 年 月 日 星期、第几节</div>
        <div>${icon('check', 14)} 姓名 + 学科（Excel 版）</div>
        <div>${icon('check', 14)} 左右两栏排版自动合并</div>
      </div>
      <div class="att-tip-note">
        传图片时，勾选状态在你自己浏览器里算，图片不上传；<b>姓名需要你照着原图补一下</b>
        —— 手写名字认不准，认错比认不出更麻烦。行数和顺序会跟原表保持一致。
      </div>
    </div>
    <div class="att-manual">
      <button class="link-btn" id="paste-mode">只想把纸表照片存起来、不想识别？建个空表 →</button>
    </div>
  </div>`);
  const s = sheet({ title: '上传表格，自动识别', body });
  const $ = (x) => body.querySelector(x);
  const pick = () => $('#file').click();
  $('#drop').onclick = pick;
  $('#drop').ondragover = (e) => { e.preventDefault(); $('#drop').classList.add('over'); };
  $('#drop').ondragleave = () => $('#drop').classList.remove('over');
  $('#drop').ondrop = (e) => {
    e.preventDefault(); $('#drop').classList.remove('over');
    const f = e.dataTransfer.files[0]; if (f) doDetect(f, s, grade, reload);
  };
  $('#file').onchange = (e) => { const f = e.target.files[0]; if (f) doDetect(f, s, grade, reload); };
  $('#paste-mode').onclick = () => { s.close(); photoOnlyDialog(grade, reload); };
}

/* 只有照片、没有 Excel：先建空表（带名册），再把照片存进去 */
async function photoOnlyDialog(grade, reload) {
  const body = el(`<div class="sheet-body">
    <div class="field"><label class="field-label">这是哪个年级的表</label>
      <select class="input" id="po-grade">
        <option ${grade === '高一' ? 'selected' : ''}>高一</option>
        <option ${grade === '高二' ? 'selected' : ''}>高二</option>
      </select></div>
    <div class="field"><label class="field-label">表类型</label>
      <div class="seg" id="po-type">
        <button class="seg-btn on" data-t="seat">教师坐班表</button>
        <button class="seg-btn" data-t="research">教师教研签到表</button>
      </div></div>
    <div class="field"><label class="field-label">日期</label><input class="input" type="date" id="po-date" value="${ymd()}"></div>
    <div class="field"><label class="field-label">照片</label>
      <label class="ap-add" id="po-add"><input type="file" accept="image/*" multiple hidden id="po-file"><span id="po-txt">＋ 选择照片 / 拍照</span></label>
      <div class="ap-list" id="po-list" style="margin-top:8px"></div></div>
    <div class="field-hint">会按名册把教师名单先铺好，你点开表对着照片逐行打勾就行。</div>
    <div class="confirm-actions"><button class="btn ghost" id="po-cancel">取消</button>
      <button class="btn primary" id="po-ok">建表并存照片</button></div>
  </div>`);
  const s = sheet({ title: '拍照建表', body });
  const $ = (x) => body.querySelector(x);
  let type = 'seat';
  const picked = [];
  body.querySelectorAll('#po-type .seg-btn').forEach((b) => {
    b.onclick = () => {
      type = b.dataset.t;
      body.querySelectorAll('#po-type .seg-btn').forEach((x) => x.classList.toggle('on', x === b));
    };
  });
  const paint = () => {
    $('#po-list').innerHTML = picked.map((p, i) => `
      <div class="ap-item"><div class="ap-thumb"><img src="${p.preview}" alt=""></div>
        <div class="ap-meta"><div class="ap-name">${esc(p.file.name)}</div><div class="ap-size">${fmtSize(p.file.size)}</div></div>
        <button class="icon-btn sm" data-d="${i}">${icon('close', 13)}</button></div>`).join('');
    $('#po-txt').textContent = picked.length ? `已选 ${picked.length} 张` : '＋ 选择照片 / 拍照';
    body.querySelectorAll('[data-d]').forEach((b) => {
      b.onclick = () => { const [rm] = picked.splice(Number(b.dataset.d), 1); if (rm) URL.revokeObjectURL(rm.preview); paint(); };
    });
  };
  $('#po-file').onchange = (e) => {
    for (const f of e.target.files) if (/^image\//i.test(f.type)) picked.push({ file: f, preview: URL.createObjectURL(f) });
    e.target.value = ''; paint();
  };
  $('#po-cancel').onclick = s.close;
  saving($('#po-ok'), async () => {
    const g = $('#po-grade').value;
    const date = $('#po-date').value;
    const wd = date ? WD[new Date(date + 'T00:00:00').getDay()] : '';
    if (!date) return toast('选个日期', 'warn');
    const res = await api.post('/attendance', {
      name: `${date.slice(0, 4)}年${g}${type === 'seat' ? '老师坐班表' : '教师教研签到表'}`,
      grade: g, sheet_type: type, sheet_date: date, weekday: wd, periods: type === 'seat' ? '1-2' : '',
      columns: null,
    });
    const newId = res.id || res.table_id;
    if (!newId) throw new Error('建表失败，请重试');
    for (const p of picked) {
      const fd = new FormData();
      fd.append('file', p.file);
      fd.append('owner_type', 'attendance');
      fd.append('owner_id', String(newId));
      await api.post('/upload', fd).catch((err) => toast(`${p.file.name} 没存上：${err.message}`, 'err'));
    }
    picked.forEach((p) => URL.revokeObjectURL(p.preview));
    s.close(); toast('建好了'); reload();
    setTimeout(() => openTable(newId, reload), 260);
  });
}

async function doDetect(file, s, grade, reload) {
  if (file.size > 12 * 1024 * 1024) return toast('文件太大了（上限 12MB）', 'warn');

  /* 【图片走本地识别，跟课表一个体验】
     拍张照直接能导，不用先转 Excel。
     全程在浏览器里算，图片不上传 —— 考勤表上有全校老师的名字，
     能不传就不传。 */
  if (/^image\//i.test(file.type || '') || /\.(png|jpe?g|webp|bmp|gif)$/i.test(file.name || '')) {
    toast('正在识别图片…');
    let r;
    try {
      r = await detectFromImage(file, grade);
    } catch (e) {
      return toast('识别失败：' + e.message, 'err');
    }
    if (!r.ok) return toast(r.reason || '没识别出来', 'err');
    s.close();
    confirmSheet(r, reload);
    return;
  }

  toast('正在识别…');
  const fd = new FormData();
  fd.append('file', file);
  fd.append('grade', grade || '');
  let r;
  try { r = await api.post('/attendance/detect', fd); }
  catch (e) { return toast(e.message, 'err'); }
  if (!r.ok) {
    toast(r.reason || '没识别出来', 'err');
    return;
  }
  s.close();
  confirmSheet(r, reload);
}

/* 图片 → 与 CSV 识别同构的结果 */
async function detectFromImage(file, grade) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  await new Promise((res, rej) => {
    img.onload = res;
    img.onerror = () => rej(new Error('图片打不开，换一张试试'));
    img.src = url;
  });

  /* 名册是为了「铺名字」用的：认不出手写名字，就按名册顺序先填上，
     老师核对时只改顺序不一致的几行，比从零敲 46 个名字快。
     名册拿不到也不影响识别，只是名字变成占位符。 */
  let roster = [];
  try {
    const g = grade || '';
    const all = await api.get('/teachers');
    const list = Array.isArray(all) ? all : (all?.data || []);
    roster = list
      .filter((t) => !t.deleted_at && (!g || !t.grade || t.grade === g))
      .sort((a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0))
      .map((t) => ({ name: t.name, subject: t.subject || '' }));
    /* 该年级没单独标 grade 的，退回全量名册 */
    if (!roster.length) {
      roster = list.filter((t) => !t.deleted_at)
        .sort((a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0))
        .map((t) => ({ name: t.name, subject: t.subject || '' }));
    }
  } catch { roster = []; }

  const { detectAttendance } = await import('./attimage.js');
  const r = detectAttendance(img, { grade, roster });
  r.filename = file.name;
  /* 确认页要显示原图，供对照 */
  r._imgURL = url;
  return r;
}

/* 识别结果确认页 */
function confirmSheet(r, reload) {
  const d = r.detected || {};
  const checkCols = (r.columns || []).filter((c) => c.type === 'check');
  /* 图片识别看不出日期（表头文字认不了），默认给今天；CSV 那边从表头解析出年月日就用它 */
  const defDate = d.year
    ? `${d.year}-${String(d.month || '1').padStart(2, '0')}-${String(d.day || '1').padStart(2, '0')}`
    : ymd();
  const isImg = r.source === 'image';
  const body = el(`<div class="att-confirm">
    <div class="acm-file">
      <span class="acm-f">${icon('file', 15)} ${esc(r.filename)}</span>
      ${r.stats?.dual_column ? '<span class="chip">检测到双栏排版，已合并</span>' : ''}
      ${isImg ? '<span class="chip">图片识别</span>' : ''}
    </div>
    ${isImg ? `<div class="acm-roster" style="background:#FFFBEB;border-color:#FDE68A">
      <div><b>名字是按名册顺序铺的，请扫一眼核对。</b>手写名字认不出来，我没硬猜 ——
        认错名字比让你改顺序麻烦得多。</div>
      <div class="tiny muted" style="margin-top:4px">
        勾选状态（√ / × / 空）已经照原图认好了，行数和顺序跟原表一致。名字如果整体错位，
        直接在表里上下改一下就行。识别详情：切出 ${r.stats.rows} 行 × ${r.stats.cols} 列，
        姓名在第 ${r.stats.nameCol + 1} 列，${r.stats.checkCols.length} 个勾选列。
      </div>
    </div>` : ''}
    <div class="acm-grid">
      <div class="field"><label class="field-label">年级</label>
        <select class="input" id="c-grade">${['高一', '高二', d.grade].filter((v, i, a) => v && a.indexOf(v) === i).map((g) => `<option ${g === d.grade ? 'selected' : ''}>${esc(g)}</option>`).join('')}</select></div>
      <div class="field"><label class="field-label">表类型</label>
        <select class="input" id="c-type">
          <option value="seat" ${d.sheet_type !== 'research' ? 'selected' : ''}>教师坐班表</option>
          <option value="research" ${d.sheet_type === 'research' ? 'selected' : ''}>教师教研签到表</option>
        </select></div>
      <div class="field"><label class="field-label">日期</label><input class="input" type="date" id="c-date" value="${defDate}"></div>
      <div class="field"><label class="field-label">节次</label><input class="input" id="c-periods" value="${esc(d.periods || '')}"></div>
    </div>
    <div class="field"><label class="field-label">表格名称</label><input class="input" id="c-name" value="${esc(r.filename.replace(/\.(xlsx|xlsm|csv|txt|tsv)$/i, ''))}"></div>
    <div class="acm-sum">
      <span><b>${r.stats?.teachers || 0}</b> 位教师</span>
      <span><b>${r.stats?.subjects || 0}</b> 个学科</span>
      <span><b>${checkCols.length}</b> 个勾选列：${checkCols.map((c) => esc(c.label)).join(' / ')}</span>
    </div>
    ${r.roster?.known ? `<div class="acm-roster">
      <div>名册比对：表里 ${r.roster.matched}/${r.roster.known} 人与名册一致</div>
      ${r.roster.missing?.length ? `<div class="acm-miss">名册里有、这张表没有：${r.roster.missing.slice(0, 12).map(esc).join('、')}${r.roster.missing.length > 12 ? ' 等 ' + r.roster.missing.length + ' 人' : ''}</div>` : ''}
      ${r.roster.extra?.length ? `<div class="acm-extra">表里有、名册没登记：${r.roster.extra.slice(0, 12).map(esc).join('、')}${r.roster.extra.length > 12 ? ' 等 ' + r.roster.extra.length + ' 人' : ''}　<button class="link-btn" id="add-roster">一键加进名册</button></div>` : ''}
    </div>` : ''}
    <div class="acm-photo">
      <div class="acm-photo-h">${icon('camera', 14)} 纸质原件（可选）</div>
      <div class="acm-photo-s">如果有这张表的照片或扫描件，一起存进来，以后核对不用翻手机相册。</div>
      <label class="ap-add acm-photo-add" id="c-photo-add">
        <input type="file" accept="image/*" multiple hidden id="c-photo-file">
        <span id="c-photo-txt">＋ 选择照片</span>
      </label>
      <div class="ap-list" id="c-photo-list"></div>
    </div>
    <div class="acm-preview" id="acm-preview">
      <button class="acm-pv-h acm-pv-toggle" id="acm-pv-btn">
        ${icon('down', 14)} ${isImg ? '逐行核对（原图 + 识别结果）' : '识别结果预览'}（共 ${r.rows.length} 行）<span class="acm-pv-more">点开看看认得对不对</span>
      </button>
      <div class="acm-pv-wrap" id="acm-pv-wrap" hidden></div>
    </div>
    <div class="confirm-actions" style="position:sticky;bottom:0;background:var(--card);padding-top:8px">
      <button class="btn ghost" id="c-cancel">取消</button>
      <button class="btn primary" id="c-ok">导入为新表</button>
    </div>
  </div>`);
  /* 【blob 泄漏】detectFromImage 为原图建了一个 objectURL，confirmSheet 里
     用它裁出每一格小图。这个 URL 以前一直没人 revoke —— 关掉弹层、导入完成、
     或者干脆取消，它都还挂着那张原图（手机拍的表 3~5MB）。
     连着识别十几张，内存就堆到几十上百 MB，页面开始卡。
     这里挂在 sheet 的 onClose 上，不管从哪条路关（X / 取消 / Esc / 导入完成）
     都只走这一处，释放一次，同时把引用置空免得之后又裁图。 */
  const releaseSrc = () => {
    if (r._imgURL) { try { URL.revokeObjectURL(r._imgURL); } catch { } r._imgURL = ''; }
  };
  const s = sheet({ title: '确认识别结果', body, wide: true, cls: 'att-confirm-sheet', onClose: releaseSrc });
  const $ = (x) => body.querySelector(x);
  $('#c-cancel').onclick = s.close;

  /* 顺带存纸质原件：先在本地预览，导入拿到表 id 后再真正上传 */
  const pickedPhotos = [];
  const paintPicked = () => {
    $('#c-photo-list').innerHTML = pickedPhotos.map((p, i) => `
      <div class="ap-item">
        <div class="ap-thumb"><img src="${p.preview}" alt=""></div>
        <div class="ap-meta"><div class="ap-name">${esc(p.file.name)}</div><div class="ap-size">${fmtSize(p.file.size)}</div></div>
        <button class="icon-btn sm" data-photo-del="${i}" title="移除">${icon('close', 13)}</button>
      </div>`).join('');
    $('#c-photo-txt').textContent = pickedPhotos.length ? `已选 ${pickedPhotos.length} 张，可继续添加` : '＋ 选择照片';
    body.querySelectorAll('[data-photo-del]').forEach((b) => {
      b.onclick = () => {
        const [rm] = pickedPhotos.splice(Number(b.dataset.photoDel), 1);
        if (rm) URL.revokeObjectURL(rm.preview);
        paintPicked();
      };
    });
  };
  $('#c-photo-file').onchange = (e) => {
    for (const f of e.target.files) {
      if (!/^image\//i.test(f.type)) { toast(`${f.name} 不是图片`, 'warn'); continue; }
      pickedPhotos.push({ file: f, preview: URL.createObjectURL(f) });
    }
    e.target.value = '';
    paintPicked();
  };

  $('#c-date').onchange = () => {
    const v = $('#c-date').value; if (!v) return;
    const dt = new Date(v + 'T00:00:00');
    if ($('#c-periods').value === '' && d.periods) $('#c-periods').value = d.periods;
  };
  /* ===== 逐行核对表 =====
     【为什么要有这张表】图片识别最大的风险是「错了但没人发现」：
     姓名是按名册顺序铺的，可能整体错位；勾可能认错。
     光给个结果表，用户没法定夺。这里把原图每一行的格子裁出来贴在旁边，
     人眼一对比就知道认没认对，点一下就能改。
     【为什么懒加载】一张 46 人 × 5 列的表 = 230 个格子，
     每格一张 dataURL 会吃掉几十 MB 内存，手机上直接卡死。
     所以只裁**勾选列**，并且只渲染前 LIMIT 行，剩下的滚动再补。 */
  const LIMIT = 20;
  const cells = r._preview?.cells || [];
  const view = new Map();          // `${rowIdx}|${key}` → 格子状态，改这里，最后写回 r.rows
  r.rows.forEach((row, i) => {
    checkCols.forEach((c) => {
      const m = row.marks?.[c.key] ?? (row.data?.[c.key] === '1' ? '√' : row.data?.[c.key] === '0' ? '×' : '');
      view.set(`${i}|${c.key}`, m);
    });
  });
  const CYCLE = { '√': '×', '×': '', '': '√', '?': '√' };
  let paintedRows = 0;
  let imgEl = null;

  /* 裁格：复用 detectFromImage 已经加载好的 img，绝不新建 Image ——
     新建会重新拉一次图，手机上慢且可能出现跨域污染 canvas */
  const crop = (box) => {
    try {
      if (!r._imgURL) return '';   // 弹层关掉后原图已释放，不再裁
      if (!imgEl) {
        imgEl = new Image();
        imgEl.src = r._imgURL;
      }
      if (!imgEl.complete || !imgEl.naturalWidth) return '';
      const zoom = 2;
      /* box 是 detectGrid 在「压到 ≤1600 宽」画布上的坐标，
         原图可能更大，必须乘以 scale 换算回去，否则裁到的是左上角某块。 */
      const k = r._preview?.scale || 1;
      const bw = box.w * k; const bh = box.h * k;
      const cv = document.createElement('canvas');
      cv.width = Math.max(1, Math.round(bw * zoom));
      cv.height = Math.max(1, Math.round(bh * zoom));
      const ctx = cv.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.drawImage(imgEl, box.x * k, box.y * k, bw, bh, 0, 0, cv.width, cv.height);
      return cv.toDataURL('image/png');
    } catch { return ''; }
  };

  const statCount = () => {
    let unsure = 0, ticks = 0;
    view.forEach((v) => { if (v === '?') unsure++; if (v === '√') ticks++; });
    return { unsure, ticks };
  };

  const paintBar = () => {
    const bar = $('#acm-pv-wrap').querySelector('#pv-bar');
    if (!bar) return null;
    const { unsure, ticks } = statCount();
    bar.innerHTML = `
      <div class="pv-bar-txt">
        共 ${r.rows.length} 行 · 已勾 <b>${ticks}</b> 格
        ${unsure ? ` · <b style="color:#B45309">${unsure} 格认不准</b>（标黄，点一下改成 √ 或 ×）` : ''}
      </div>
      <div class="pv-bar-ops">
        <button class="btn ghost sm" id="pv-all-tick">整表全√</button>
      </div>`;
    bar.querySelector('#pv-all-tick').onclick = () => {
      view.forEach((v, k) => { view.set(k, '√'); });
      repaintAll();
    };
    return bar;
  };

  const repaintAll = () => {
    const wrap = $('#acm-pv-wrap');
    wrap.querySelectorAll('[data-cell]').forEach((b) => {
      const [i, key] = b.dataset.cell.split('|');
      const v = view.get(`${i}|${key}`) || '';
      b.dataset.mark = v;
      b.className = 'pv-mark' + (v === '√' ? ' on' : v === '×' ? ' off' : v === '?' ? ' unsure' : '');
      b.textContent = v === '√' ? '✓' : v === '×' ? '×' : v === '?' ? '?' : '·';
    });
    paintBar();
  };

  /* 渲染一批行。原图小图只在首次渲染该行时裁，之后复用 DOM */
  const paintRows = (from, to) => {
    const tbody = $('#acm-pv-wrap').querySelector('tbody');
    if (!tbody) return;
    const frag = document.createDocumentFragment();
    for (let i = from; i < Math.min(to, r.rows.length); i++) {
      const row = r.rows[i];
      const tr = document.createElement('tr');
      const dup = r.rows.filter((x) => x.teacher === row.teacher).length > 1 && row.teacher;
      const placeholder = /^（第\d+行）$/.test(row.teacher);
      tr.innerHTML = `
        <td class="pv-no">${i + 1}</td>
        <td class="pv-thumb">${checkCols.map((c) => {
          /* 用 r.rows 的下标 i 去匹配，别用 _srcRow：
             _srcRow 是「原图第几行」（含表头、空行），预览 cells 用的是「第几条教师行」，
             两套口径一混，行有缺漏时原图就串到别人身上了。 */
          const cell = cells.find((x) => x.row === i && x.key === c.key);
          const d = cell ? crop(cell.box) : '';
          return d ? `<img src="${d}" alt="" data-zoom="${d}">` : '';
        }).join('')}</td>
        <td><input class="input pv-in" data-name="${i}" value="${esc(row.teacher)}"
             style="${placeholder || dup ? 'background:#FEF3C7' : ''}"></td>
        <td><input class="input pv-in" data-subj="${i}" value="${esc(row.subject || '')}"></td>
        ${checkCols.map((c) => {
          const v = view.get(`${i}|${c.key}`) || '';
          return `<td><button class="pv-mark${v === '√' ? ' on' : v === '×' ? ' off' : v === '?' ? ' unsure' : ''}"
            data-cell="${i}|${c.key}" data-mark="${v}">${v === '√' ? '✓' : v === '×' ? '×' : v === '?' ? '?' : '·'}</button></td>`;
        }).join('')}`;
      frag.appendChild(tr);
    }
    tbody.appendChild(frag);
    /* 事件用委托，但新插入的这批要单独绑（委托也能覆盖，这里省一次全表遍历） */
    tbody.querySelectorAll('[data-cell]').forEach((b) => {
      if (b._bound) return;
      b._bound = true;
      b.onclick = () => {
        const [i, key] = b.dataset.cell.split('|');
        const cur = view.get(`${i}|${key}`) || '';
        const next = CYCLE[cur] ?? '√';
        view.set(`${i}|${key}`, next);
        repaintAll();
      };
    });
    tbody.querySelectorAll('[data-name]').forEach((inp) => {
      if (inp._bound) return;
      inp._bound = true;
      inp.oninput = () => { r.rows[Number(inp.dataset.name)].teacher = inp.value; };
    });
    tbody.querySelectorAll('[data-subj]').forEach((inp) => {
      if (inp._bound) return;
      inp._bound = true;
      inp.oninput = () => { r.rows[Number(inp.dataset.subj)].subject = inp.value; };
    });
    /* 缩略图太小看不清勾叉的细节，点一下放大到原尺寸的 4 倍再看 */
    tbody.querySelectorAll('[data-zoom]').forEach((im) => {
      if (im._bound) return;
      im._bound = true;
      im.onclick = () => {
        const mask = document.createElement('div');
        mask.className = 'pv-zoom-mask';
        mask.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.72);z-index:99999;display:flex;align-items:center;justify-content:center;cursor:zoom-out';
        const big = document.createElement('img');
        big.src = im.dataset.zoom;
        big.style.cssText = 'max-width:88vw;max-height:82vh;image-rendering:pixelated;background:#fff;border-radius:8px;padding:8px';
        mask.appendChild(big);
        mask.onclick = () => mask.remove();
        document.body.appendChild(mask);
      };
    });
    paintedRows = Math.min(to, r.rows.length);
  };

  const buildTable = () => {
    const wrap = $('#acm-pv-wrap');
    wrap.innerHTML = `
      <div class="pv-bar" id="pv-bar"></div>
      <div class="pv-scroll">
        <table class="pv-tbl">
          <thead><tr>
            <th class="pv-no">#</th>
            <th class="pv-thumb">原图</th>
            <th>姓名（可改）</th>
            <th>学科</th>
            ${checkCols.map((c) => `<th class="pv-ch">${esc(c.label)}</th>`).join('')}
          </tr></thead>
          <tbody></tbody>
        </table>
      </div>
      ${r.rows.length > LIMIT ? `<div class="tiny muted" style="padding:6px 2px">先显示前 ${LIMIT} 行，往下滚动自动加载</div>` : ''}`;
    paintRows(0, LIMIT);
    paintBar();
    /* 滚动到底自动补下一批 */
    wrap.querySelector('.pv-scroll').onscroll = (e) => {
      const el0 = e.currentTarget;
      if (paintedRows >= r.rows.length) return;
      if (el0.scrollTop + el0.clientHeight > el0.scrollHeight - 120) {
        paintRows(paintedRows, paintedRows + LIMIT);
      }
    };
  };

  /* 预览折叠 */
  $('#acm-pv-btn').onclick = () => {
    const w = $('#acm-pv-wrap');
    const open = w.hidden;
    w.hidden = !open;
    if (open && !w.querySelector('table')) buildTable();
    $('#acm-pv-btn').classList.toggle('open', open);
    const more = body.querySelector('.acm-pv-more');
    if (more) more.textContent = open ? '再点收起' : '点开看看认得对不对';
  };
  /* 图片识别：默认就展开核对表，因为核对是必须做的动作，不该藏在折叠里 */
  if (isImg) {
    $('#acm-pv-wrap').hidden = false;
    buildTable();
    $('#acm-pv-btn').classList.add('open');
    const more = body.querySelector('.acm-pv-more');
    if (more) more.textContent = '再点收起';
  }

  /* 把编辑结果写回 r.rows：勾选状态 + 姓名 + 学科 */
  const flushEdits = () => {
    r.rows.forEach((row, i) => {
      row.data = row.data || {};
      checkCols.forEach((c) => {
        const v = view.get(`${i}|${c.key}`) || '';
        if (v === '√') row.data[c.key] = '1';
        else if (v === '×') row.data[c.key] = '0';
        else delete row.data[c.key];
      });
    });
  };
  const addRoster = $('#add-roster');
  if (addRoster) {
    addRoster.onclick = async () => {
      const g = $('#c-grade').value;
      const items = r.rows.filter((x) => r.roster.extra.includes(x.teacher)).map((x) => ({ name: x.teacher, subject: x.subject }));
      await api.post('/teachers', { grade: g, items });
      toast(`已把 ${items.length} 人加进「${g}」名册`);
      addRoster.disabled = true; addRoster.textContent = '已加入名册';
    };
  }
  saving($('#c-ok'), async () => {
    /* 【导入前的最后一道闸】
       有认不准的格子就先拦一下 —— 这一张表发到群里是要让老师签字的，
       带着错数据发出去比晚发十分钟严重得多。
       拦的时候给出路：要么去改，要么明确「当没勾」强行导入。 */
    const { unsure } = statCount();
    if (isImg && unsure > 0) {
      const go = await confirmDialog(
        `还有 ${unsure} 格没认准（表里标黄的「?」）。点「确认」会把它们当成「没勾」导入，点「取消」回去改。`,
        { title: '有格子没认准', okText: '当没勾，继续导入', danger: false },
      );
      if (!go) {
        if ($('#acm-pv-wrap').hidden) $('#acm-pv-btn').onclick();
        return;
      }
      view.forEach((v, k) => { if (v === '?') view.set(k, ''); });
    }
    flushEdits();
    const res = await api.post('/attendance/commit', {
      name: $('#c-name').value,
      grade: $('#c-grade').value,
      sheet_type: $('#c-type').value,
      sheet_date: $('#c-date').value,
      periods: $('#c-periods').value,
      weekday: (() => { const v = $('#c-date').value; if (!v) return ''; return WD[new Date(v + 'T00:00:00').getDay()]; })(),
      columns: r.columns,
      rows: r.rows,
      source: 'upload',
      filename: r.filename,
    });
    // 表建好之后，把选好的纸质原件挂上去
    if (pickedPhotos.length) {
      for (const p of pickedPhotos) {
        try {
          const fd = new FormData();
          fd.append('file', p.file);
          fd.append('owner_type', 'attendance');
          fd.append('owner_id', String(res.table_id));
          await api.post('/upload', fd);
        } catch (err) { toast(`照片「${p.file.name}」没存上：${err.message}`, 'err'); }
      }
      pickedPhotos.forEach((p) => URL.revokeObjectURL(p.preview));
    }
    s.close();
    toast(pickedPhotos.length ? `已导入 ${res.added} 行，并存了 ${pickedPhotos.length} 张原件` : `已导入 ${res.added} 行`);
    reload();
    setTimeout(() => openTable(res.table_id, reload), 260);
  });
}

/* ================= 教师名册 ================= */
function rosterSheet(grade, reload) {
  const body = el(`<div class="att-roster-sheet">
    <div class="ars-tabs" id="ars-tabs"></div>
    <div class="ars-add">
      <input class="input" id="ars-name">
      <input class="input" id="ars-subj" list="subj-list2">
      <button class="btn primary sm" id="ars-add-btn">＋ 添加</button>
      <button class="btn ghost sm" id="ars-bulk">批量粘贴</button>
    </div>
    <datalist id="subj-list2">${SUBJECT_ORDER.map((x) => `<option>${x}</option>`).join('')}</datalist>
    <div class="ars-stats" id="ars-stats"></div>
    <div id="ars-list" class="ars-list"></div>
    <div class="confirm-actions"><button class="btn ghost" id="ars-close">关闭</button></div>
  </div>`);
  const s = sheet({ title: '教师名册', body, wide: true, cls: 'att-roster-dialog' });
  const $ = (x) => body.querySelector(x);
  let cur = grade || '高一';
  let all = { grades: ['高一', '高二'] };

  const load = async () => {
    const [g, list] = await Promise.all([api.get('/grades'), api.get('/teachers', { grade: cur, active: 'all' })]);
    all = g;
    const people = list.list || [];
    $('#ars-tabs').innerHTML = g.grades.map((x) => `<button class="seg-btn${x === cur ? ' on' : ''}" data-g="${esc(x)}">${esc(x)} <span class="tiny muted">${g.counts[x] || 0}</span></button>`).join('');
    $('#ars-tabs').querySelectorAll('[data-g]').forEach((b) => {
      b.onclick = () => { cur = b.dataset.g; load(); };
    });
    const subs = {};
    people.filter((p) => p.active).forEach((p) => { const k = p.subject || '未填学科'; subs[k] = (subs[k] || 0) + 1; });
    $('#ars-stats').innerHTML = `<span><b>${people.filter((p) => p.active).length}</b> 位在册</span>
      <span>${Object.keys(subs).length} 个学科</span>
      ${people.filter((p) => !p.active).length ? `<span class="muted">${people.filter((p) => !p.active).length} 位已调出</span>` : ''}`;
    $('#ars-list').innerHTML = people.length ? people.map((p) => `<div class="ars-row${p.active ? '' : ' off'}">
      <input class="cell-in" data-id="${p.id}" data-k="name" value="${esc(p.name)}">
      <input class="cell-in subject-in" data-id="${p.id}" data-k="subject" value="${esc(p.subject || '')}" list="subj-list2">
      <button class="btn ghost sm" data-toggle="${p.id}" data-active="${p.active}">${p.active ? '调出' : '恢复'}</button>
      <button class="icon-btn sm" data-rm="${p.id}">${icon('close', 13)}</button>
    </div>`).join('') : `<div class="att-empty">「${esc(cur)}」还没有教师，用上面的输入框添加</div>`;

    body.querySelectorAll('[data-toggle]').forEach((b) => {
      b.onclick = async () => { await api.patch('/teachers/' + b.dataset.toggle, { active: b.dataset.active ? 0 : 1 }); load(); };
    });
    body.querySelectorAll('[data-rm]').forEach((b) => {
      b.onclick = async () => {
        if (await confirmDialog('从名册删除这位教师？已有表格里的记录不受影响。')) { await api.del('/teachers/' + b.dataset.rm); load(); }
      };
    });
    // 就地改名 / 改学科（失焦保存）
    body.querySelectorAll('.ars-row .cell-in').forEach((inp) => {
      inp.onchange = async () => {
        const k = inp.dataset.k;
        await api.patch('/teachers/' + inp.dataset.id, { [k]: inp.value.trim() });
        toast('已更新');
      };
    });
  };

  const addOne = async () => {
    const name = $('#ars-name').value.trim();
    if (!name) return toast('请填写姓名', 'warn');
    await api.post('/teachers', { grade: cur, name, subject: $('#ars-subj').value.trim() });
    $('#ars-name').value = ''; $('#ars-subj').value = '';
    load(); toast('已添加');
  };
  $('#ars-add-btn').onclick = addOne;
  $('#ars-name').onkeydown = (e) => { if (e.key === 'Enter') addOne(); };
  $('#ars-bulk').onclick = () => bulkDialog(cur, load);
  $('#ars-close').onclick = () => { s.close(); reload?.(); };
  load();
}

function bulkDialog(grade, reload) {
  const body = el(`<div class="sheet-body">
    <div class="small muted" style="margin-bottom:8px">每行一位教师，可以写「姓名」或「姓名 学科」或「姓名,学科」。从 Excel 里复制一整列直接粘进来也行。</div>
    <textarea class="input" id="bulk" rows="10"></textarea>
    <div class="confirm-actions"><button class="btn ghost" id="c">取消</button><button class="btn primary" id="k">导入到 ${esc(grade)}</button></div>
  </div>`);
  const s = sheet({ title: '批量粘贴教师名单', body });
  body.querySelector('#c').onclick = s.close;
  body.querySelector('#k').onclick = async () => {
    const lines = body.querySelector('#bulk').value.split('\n').map((x) => x.trim()).filter(Boolean);
    if (!lines.length) return toast('请粘贴名单', 'warn');
    const items = lines.map((l) => {
      const parts = l.split(/[\t,，\s]+/).filter(Boolean);
      return { name: parts[0], subject: parts[1] || '' };
    });
    const r = await api.post('/teachers', { grade, items });
    s.close(); toast(`已导入 ${items.length} 人${r.skipped ? `（${r.skipped} 人已存在）` : ''}`);
    reload();
  };
}

/* ================= 统计（按新结构重算） ================= */
async function showStats(id) {
  const t = await api.get('/attendance/' + id);
  const cols = t.columns.filter((c) => c.type === 'check');
  const key = cols[0]?.key;
  const bySubject = {};
  for (const r of t.rows) {
    const sj = r.subject || '未填学科';
    bySubject[sj] = bySubject[sj] || { total: 0, done: 0, off: 0, names: [] };
    bySubject[sj].total++;
    if (r.data?.[key] === '1') bySubject[sj].done++;
    else { bySubject[sj].off++; bySubject[sj].names.push(r.teacher); }
  }
  const rowsHtml = Object.entries(bySubject).sort((a, b) => subjectRank(a[0]) - subjectRank(b[0])).map(([sj, v]) => `
    <tr><td class="bold">${esc(sj)}</td><td>${v.total}</td><td>${v.done}</td>
    <td ${v.off ? 'style="color:var(--red);font-weight:700"' : ''}>${v.off}</td>
    <td>${v.total ? Math.round(v.done / v.total * 100) : 0}%</td>
    <td class="tiny">${esc(v.names.join('、'))}</td></tr>`).join('');
  const body = el(`<div style="overflow:auto;padding:0 16px 8px">
    <div class="small muted" style="margin-bottom:10px">${esc(t.name)}　按学科汇总「${esc(cols[0]?.label || '签到')}」情况</div>
    <div class="table-wrap"><table class="tbl" style="min-width:0">
      <thead><tr><th>学科</th><th>人数</th><th>已完成</th><th>未完成</th><th>完成率</th><th>未完成名单</th></tr></thead>
      <tbody>${rowsHtml}</tbody></table></div>
    <div class="confirm-actions"><button class="btn ghost" id="expd">导出这张表</button></div></div>`);
  const s = sheet({ title: '学科统计', body, wide: true });
  body.querySelector('#expd').onclick = () => {
    // 静态版：本地取数后造 CSV 下载（没有 /api/export 文件流）
    doExport('attendance', { month: String(t.id), format: 'csv' });
  };
}

/* ================= 整表截图 =================
   【2026-10 重做】老实现想「把 DOM 序列化成 SVG 的 foreignObject 再画进 canvas」，
   这条路在 Chrome 上根本走不通：

     Failed to execute 'toBlob' on 'HTMLCanvasElement':
     Tainted canvases may not be exported.

   原因不是跨域图片，而是 **foreignObject 里的内容被浏览器视为不可信来源**，
   一旦 drawImage 到 canvas，这张画布就被标记成 tainted，
   之后 getImageData / toDataURL / toBlob 全部抛 SecurityError。
   实测三种导出一个都取不出来，不是偶发。

   现在的做法：**不用 DOM，直接拿 canvas 画表格**。
   位置全部按列宽/行高手算，文字用 fillText，勾叉用路径。
   好处是画布始终同源、一定能导出；顺带不再依赖「等 60ms 让布局稳定」这种玄学。
   导出失败也有明确回退：提示改用「打印 → 另存为 PDF」，那条路本来就有。 */
async function shotTable(id) {
  const t = await api.get('/attendance/' + id);
  const cols = (t.columns || []).filter((c) => c.type === 'check');
  const isSeat = t.sheet_type === 'seat';
  const d = t.sheet_date ? new Date(t.sheet_date + 'T00:00:00') : null;
  const dateLine = d && !Number.isNaN(d.getTime())
    ? `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日　星期${WD[d.getDay()]}${t.periods ? '　第 ' + t.periods + ' 节' : ''}`
    : '';

  try {
    const blob = await renderSheetPng({
      title: t.name,
      dateLine,
      rows: t.rows || [],
      cols,
      isSeat,
    });
    const stamp = String(t.sheet_date || ymd()).replace(/-/g, '');
    saveBlob(blob, `${t.name}-${stamp}.png`);
    toast('图片已生成，可直接发群里');
  } catch (e) {
    /* 真出不来就老实说，并给一条一定能走的路 */
    console.warn('导出 PNG 失败', e);
    toast('图片导出没成功，可以改用「打印 → 另存为 PDF」', 'err', 6000);
  }
}

/* 把一张考勤表画成 PNG（纯 canvas，不涉及 DOM 序列化） */
async function renderSheetPng({ title, dateLine, rows, cols, isSeat }) {
  const DPR = 2;
  const PAD = 28;
  const colW = isSeat ? [44, 104, 70] : [44, 104, 70];
  const chkW = 62;
  const tableW = colW.reduce((a, b) => a + b, 0) + cols.length * chkW;
  const W = Math.max(tableW, isSeat ? 860 : 560) + PAD * 2;
  const HEAD_H = 34;
  const ROW_H = 34;
  const TOP = 96;                                   // 标题 + 日期占的高度
  const FOOT = 52;
  const H = TOP + HEAD_H + rows.length * ROW_H + FOOT;

  const cv = document.createElement('canvas');
  cv.width = Math.round(W * DPR);
  cv.height = Math.round(H * DPR);
  const ctx = cv.getContext('2d');
  ctx.scale(DPR, DPR);

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);

  const FONT = '"PingFang SC","Microsoft YaHei","Noto Sans CJK SC",sans-serif';
  /* 标题 */
  ctx.fillStyle = '#1c1c1e';
  ctx.font = `700 19px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(title, W / 2, PAD + 10);
  if (dateLine) {
    ctx.font = `12px ${FONT}`;
    ctx.fillStyle = '#6c6c70';
    ctx.fillText(dateLine, W / 2, PAD + 36);
  }

  /* 表头文字 */
  const heads = ['序号', '姓名', '学科', ...cols.map((c) => c.label)];
  const widths = [...colW, ...cols.map(() => chkW)];
  const left = (W - widths.reduce((a, b) => a + b, 0)) / 2;
  const top = PAD + TOP - PAD;

  /* 表头底色 */
  const totalW = widths.reduce((a, b) => a + b, 0);
  ctx.fillStyle = '#f2f2f7';
  ctx.fillRect(left, top, totalW, HEAD_H);
  ctx.strokeStyle = '#c8c8cc';
  ctx.lineWidth = 1;

  let x = left;
  ctx.fillStyle = '#1c1c1e';
  ctx.font = `700 13px ${FONT}`;
  heads.forEach((h, i) => {
    ctx.strokeRect(x + 0.5, top + 0.5, widths[i], HEAD_H);
    ctx.fillText(h, x + widths[i] / 2, top + HEAD_H / 2);
    x += widths[i];
  });

  /* 数据行 */
  ctx.font = `13px ${FONT}`;
  rows.forEach((r, ri) => {
    const y = top + HEAD_H + ri * ROW_H;
    if (ri % 2 === 1) {          // 隔行浅底，长表更好读
      ctx.fillStyle = '#fafafd';
      ctx.fillRect(left, y, totalW, ROW_H);
    }
    const cells = [String(ri + 1), r.teacher || '', r.subject || ''];
    let cx = left;
    ctx.fillStyle = '#1c1c1e';
    cells.forEach((v, i) => {
      ctx.strokeStyle = '#d8d8dc';
      ctx.strokeRect(cx + 0.5, y + 0.5, widths[i], ROW_H);
      ctx.fillText(v, cx + widths[i] / 2, y + ROW_H / 2);
      cx += widths[i];
    });
    /* 勾选列：画勾/叉，不画字 —— 和纸表一致，也避免字体里没有 ✓ 的机器显示成方块 */
    cols.forEach((c) => {
      const v = r.data?.[c.key];
      ctx.strokeStyle = '#d8d8dc';
      ctx.strokeRect(cx + 0.5, y + 0.5, chkW, ROW_H);
      const mx = cx + chkW / 2;
      const my = y + ROW_H / 2;
      if (v === '1') {
        ctx.strokeStyle = '#1a7f37';
        ctx.lineWidth = 2.4;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(mx - 9, my + 1);
        ctx.lineTo(mx - 3, my + 8);
        ctx.lineTo(mx + 10, my - 8);
        ctx.stroke();
        ctx.lineWidth = 1;
      } else if (v === '0') {
        ctx.strokeStyle = '#c62828';
        ctx.lineWidth = 2.4;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(mx - 8, my - 8); ctx.lineTo(mx + 8, my + 8);
        ctx.moveTo(mx + 8, my - 8); ctx.lineTo(mx - 8, my + 8);
        ctx.stroke();
        ctx.lineWidth = 1;
      }
      cx += chkW;
    });
  });

  /* 页脚 */
  ctx.fillStyle = '#8e8e93';
  ctx.font = `11px ${FONT}`;
  ctx.fillText(
    `导出时间 ${new Date().toLocaleString('zh-CN')}　　✓ 已做　× 未做　空白 未填写`,
    W / 2, top + HEAD_H + rows.length * ROW_H + 24,
  );

  /* 导成 PNG。到这一步画布从头到尾都是自己画的，不可能 tainted */
  return new Promise((res, rej) => {
    cv.toBlob((b) => (b ? res(b) : rej(new Error('canvas 导出为空'))), 'image/png');
  });
}
