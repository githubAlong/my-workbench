/* ============ 考勤：教师坐班表 / 教师教研签到表 ============
 *
 * 【2026-10 大改】这一版是按老师的真实表格重写的，改动集中在四件事：
 *
 *  1. **两个 tab：高一 / 高二**，各自有各自的表、各自的名册。
 *     老师原话「高一老师名册和高二所有老师名册分开，两个年级分开管理比较好」。
 *     以前的课程表年级是「高一/高二/高三」混在一页里，考勤不需要高三，也不需要混看。
 *
 *  2. **上传 Excel 优先**。老师提供的表格是 Word/Excel 做的，本质就是
 *     「序号 姓名 学科 上课 坐班 听课 教研 请假 备注」这样一张规整的表。
 *     @see att-parse.js  纯前端解析，不依赖任何服务、不上传文件。
 *
 *  3. **节次单选 1~9**。纸表上「第 二 节」就是一个数字，
 *     原来那个能填「1-2」的自由输入框是照抄了别的页面，跟纸表对不上。
 *
 *  4. **日期/时间随表可改**。每天查班、查教研，日期天天变，
 *     纸表上那行「时间 ____年__月__日 星期__ 第__节」在界面里必须能直接改。
 *
 * 数据模型（没变，仍然是 localapi 里那两张表）：
 *   attendance_tables  一张表 = 一条记录（grade / sheet_type / sheet_date / periods）
 *   attendance_rows    一行 = 一位老师 + data{列key: '1'|'0'|''}
 *   teachers           名册，按 grade 分开
 */

import { api, el, esc, toast, sheet, saving, confirmDialog, doExport, saveBlob } from './core.js';
import { printAttendance } from './pdfprint.js';
import { state, icon } from './ui.js';
import { readXlsx, readDelimited } from './xlsx-lite.js';
import { parseAttendanceSheet } from './att-parse.js';

const WD = ['日', '一', '二', '三', '四', '五', '六'];
const pad2 = (n) => String(n).padStart(2, '0');
const ymd = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
/* 三种表，对应老师手上三种纸：
   seat     教师坐班表     —— 上课/坐班/听课/教研/请假 五个勾
   research 教师教研签到表 —— 一个「签到」勾，按学科分块
   class    教师上课检查表 —— 一个「按时上课」勾，查老师有没有到堂
   第三种是老师新提的：「我会查老师有没有按时上课，只同步每个老师上课的名单就行」。 */
const TYPE_LABEL = { seat: '教师坐班表', research: '教师教研签到表', class: '教师上课检查表' };
const TYPE_SHORT = { seat: '坐班表', research: '教研签到表', class: '上课检查表' };
/* 表类型排序：坐班、教研是每天必查；上课检查按个人习惯，放第三 */
const TYPE_ORDER = ['seat', 'research', 'class'];
/* 有节次概念的表类型（教研签到是按场次，没有第几节） */
const hasPeriod = (t) => t !== 'research';

/* 两个主 tab。学校的考勤只管高一高二；要加年级走「+」那个按钮。 */
const MAIN_GRADES = ['高一', '高二'];

/* 学科固定顺序，跟学校习惯一致；没列到的排在后面 */
const SUBJECT_ORDER = ['语文', '数学', '英语', '物理', '化学', '生物', '政治', '历史', '地理', '体育', '音乐', '美术', '信息', '通用技术', '心理', '日语', '俄语', '道法'];
const subjectRank = (s) => { const i = SUBJECT_ORDER.indexOf(s); return i < 0 ? 99 : i; };

/* 坐班表的戳记列（跟纸表一致：上课 坐班 听课 教研 请假 备注） */
function seatCols() {
  return [
    { key: 'k_上课', label: '上课', type: 'check', w: 62 },
    { key: 'k_坐班', label: '坐班', type: 'check', w: 62 },
    { key: 'k_听课', label: '听课', type: 'check', w: 62 },
    { key: 'k_教研', label: '教研', type: 'check', w: 62 },
    { key: 'k_请假', label: '请假', type: 'check', w: 62 },
    { key: 'k_remark', label: '备注', type: 'text', w: 130 },
  ];
}
/* 教研签到表：只有一列签到 + 备注 */
function researchCols() {
  return [
    { key: 'k_签到', label: '签到', type: 'check', w: 72 },
    { key: 'k_remark', label: '备注', type: 'text', w: 150 },
  ];
}
/* 查上课：一列「按时上课」，加备注 */
function classCols() {
  return [
    { key: 'k_准时', label: '按时上课', type: 'check', w: 96 },
    { key: 'k_remark', label: '备注', type: 'text', w: 150 },
  ];
}
const colsOf = (type) => (type === 'research' ? researchCols() : type === 'class' ? classCols() : seatCols());

/* 节次：1~9 单选。纸表上就是「第 二 节」这样一个数。 */
function periodOptions(cur, { allowEmpty = true } = {}) {
  const n = Number(cur) || 0;
  return `${allowEmpty ? `<option value="" ${n ? '' : 'selected'}>—</option>` : ''}
    ${Array.from({ length: 9 }, (_, i) => i + 1).map((p) => `<option value="${p}" ${n === p ? 'selected' : ''}>第 ${p} 节</option>`).join('')}`;
}
/* 节次 chip（点开才能改，不用进编辑弹层） */
function periodChip(t) {
  return `<button class="ap-chip" id="att-edit-period" title="点这里改节次">第 ${esc(t.periods || '—')} 节</button>`;
}
/* 日期 chip：同样点一下就能改 */
function dateChip(t) {
  const d = t.sheet_date ? new Date(t.sheet_date + 'T00:00:00') : null;
  const ok = d && !Number.isNaN(d.getTime());
  const txt = ok ? `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日` : (t.month || '—');
  const wd = ok ? `星期${WD[d.getDay()]}` : (t.weekday ? `星期${t.weekday}` : '');
  return `<button class="ap-chip" id="att-edit-date" title="点这里改日期">
    <b>${esc(txt)}</b>${wd ? `<span class="apc-wd">${esc(wd)}</span>` : ''}</button>`;
}

/* ================= 入口 ================= */
export async function renderAttendance(box) {
  let gradesData = { grades: MAIN_GRADES.slice(), builtin: MAIN_GRADES.slice(), counts: {} };
  let tables = [];
  /* 【为什么记忆在 sessionStorage】
     每天查两三个年级，来回切。切走再回来能停在原来那个 tab 上，
     不用每次重新点一遍。但关掉浏览器就回到第一个（一般是从高一查起）。 */
  let activeGrade = sessionStorage.getItem('wb_att_grade') || '';

  const load = async () => {
    [gradesData, tables] = await Promise.all([
      api.get('/grades').catch(() => gradesData),
      api.get('/attendance'),
    ]);
    /* 主 tab 一定是高一高二；额外的年级（万一以后有高三）排后面 */
    const extra = (gradesData.grades || []).filter((g) => !MAIN_GRADES.includes(g));
    gradesData.tabs = [...MAIN_GRADES, ...extra];
    if (!activeGrade || !gradesData.tabs.includes(activeGrade)) activeGrade = gradesData.tabs[0];
    paint();
  };

  const paint = () => {
    const gradeList = gradesData.tabs;
    const gradeTables = (g) => tables.filter((t) => (t.grade || '高一') === g);
    const roster = gradesData.counts || {};

    box.innerHTML = `
      <div class="att-head">
        <div class="att-tabs" role="tablist">
          ${gradeList.map((g) => {
            const ts = gradeTables(g);
            const on = g === activeGrade;
            const nSeat = ts.filter((t) => t.sheet_type === 'seat').length;
            const nRes = ts.filter((t) => t.sheet_type === 'research').length;
            return `<button class="att-tab${on ? ' on' : ''}" data-grade="${esc(g)}" role="tab">
              <span class="at-name">${esc(g)}</span>
              <span class="at-meta">${roster[g] ? roster[g] + ' 位老师' : '名册未录入'} · ${nSeat + nRes} 张表</span>
            </button>`;
          }).join('')}
          <button class="att-tab-add" id="att-add-grade" title="添加年级">${icon('plus', 15)}</button>
        </div>
      </div>

      <div class="att-ops">
        <button class="btn primary sm" id="att-upload">${icon('upload', 15)} 上传 Excel 表格</button>
        <button class="btn ghost sm" id="att-new">${icon('plus', 15)} 手填新建</button>
        <button class="btn ghost sm" id="att-roster">${icon('users', 15)} ${esc(activeGrade)}老师名册</button>
        <span style="flex:1"></span>
        <span class="tiny muted hide-sm">三种都可以：① 铺名单现场勾 ② 传 Excel 自动填 ③ 传纸表照片对着勾</span>
      </div>

      <div class="att-groups" id="att-groups">${groupsHTML(gradeTables(activeGrade), activeGrade)}</div>`;

    box.querySelector('#att-upload').onclick = () => uploadDialog(activeGrade, load);
    box.querySelector('#att-new').onclick = () => newSheetDialog(activeGrade, load);
    box.querySelector('#att-roster').onclick = () => rosterSheet(activeGrade, load);
    box.querySelector('#att-add-grade').onclick = () => addGradeDialog(load);
    box.querySelectorAll('[data-grade]').forEach((b) => {
      b.onclick = () => { activeGrade = b.dataset.grade; sessionStorage.setItem('wb_att_grade', activeGrade); paint(); };
    });
    bindGroups(box, load, activeGrade);
  };

  await load();
}

/* 三栏：坐班表 / 教研签到表 / 上课检查表。
   每栏顶部一个「新建」，下面按日期倒序列出已有的表。
   「每天都要查的」放左边，视线自然从第一个开始。 */
function groupsHTML(list, grade) {
  const slot = (type) => {
    const ts = list.filter((t) => (t.sheet_type || t.kind) === type)
      .sort((a, b) => String(b.sheet_date || '').localeCompare(String(a.sheet_date || '')));
    return `<div class="att-group">
      <div class="asg-head">
        <span class="asg-t">${TYPE_LABEL[type]}</span>
        <span class="asg-n">${ts.length ? ts.length + ' 张' : ''}</span>
        <span style="flex:1"></span>
        <button class="btn ghost xs" data-newtype="${type}">${icon('plus', 13)} 新建</button>
      </div>
      ${ts.length
        ? `<div class="asg-list">${ts.map((t) => tableCard(t)).join('')}</div>`
        : `<button class="att-slot" data-newtype="${type}">
             <div class="as-plus">${icon('plus', 20)}</div>
             <div class="as-t">还没有${TYPE_SHORT[type]}</div>
             <div class="as-s">${type === 'class'
               ? '铺好名单，到教室门口逐个勾「按时上课」'
               : '铺好名册名单，对着照片逐行勾'}</div>
           </button>`}
      ${ts.length ? `<button class="att-slot-mini" data-newtype="${type}">${icon('plus', 13)} 再建一张${TYPE_SHORT[type]}</button>` : ''}
    </div>`;
  };
  return TYPE_ORDER.map((t) => `<div class="att-group-wrap">${slot(t)}</div>`).join('');
}

function tableCard(t) {
  const s = t.summary || {};
  const d = t.sheet_date ? new Date(t.sheet_date + 'T00:00:00') : null;
  const dateText = d && !Number.isNaN(d.getTime())
    ? `${d.getMonth() + 1}月${d.getDate()}日 周${WD[d.getDay()]}`
    : (t.month || '未填日期');
  const isSeat = (t.sheet_type || t.kind) === 'seat';
  const subjText = !isSeat && t.subjects?.length ? `${t.subjects.length} 个学科` : '';
  const badges = [];
  if (s.leave) badges.push(`<span class="att-badge amber">请假 ${s.leave}</span>`);
  if (s.none) badges.push(`<span class="att-badge grey">未勾 ${s.none}</span>`);
  return `<div class="att-card" data-card="${t.id}">
    <div class="ac-top">
      <div class="ac-title" data-open="${t.id}">${esc(t.name)}</div>
      <button class="icon-btn sm" data-more="${t.id}" title="更多">${icon('more', 16)}</button>
    </div>
    <div class="ac-meta">
      <span>${esc(dateText)}</span>
      ${isSeat && t.periods ? `<span class="ac-dot">·</span><span>第 ${esc(t.periods)} 节</span>` : ''}
      ${subjText ? `<span class="ac-dot">·</span><span>${esc(subjText)}</span>` : ''}
      <span class="ac-dot">·</span><span><b>${t.row_count}</b> 人</span>
      ${badges.length ? badges.join('') : ''}
    </div>
    <div class="ac-actions">
      <button class="btn ghost sm" data-open="${t.id}">打开</button>
      <button class="btn ghost sm" data-stat="${t.id}">统计</button>
      <button class="btn ghost sm" data-shot="${t.id}">截图</button>
    </div>
  </div>`;
}

function bindGroups(root, load, grade) {
  /* 【为什么把 grade 传进来，不再读 sessionStorage】
     「新建」按钮挂在两个板块里，归属哪个年级必须看当前这个 tab。
     以前读 sessionStorage，切 tab 时如果没写进去（或者进了别的页面再回来），
     就会出现「看着是高二，新建出来却是高一」的表。 */
  const cur = grade || sessionStorage.getItem('wb_att_grade') || '高一';
  root.querySelectorAll('[data-card]').forEach((c) => {
    c.onclick = (e) => {
      if (e.target.closest('button')) return;
      openTable(Number(c.dataset.card), load);
    };
  });
  root.querySelectorAll('[data-newtype]').forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      newSheetDialog(cur, load, b.dataset.newtype);
    };
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
      if (await confirmDialog(`删除「${t.name}」？删除后可在左侧「回收站」找回。`)) {
        await api.del('/attendance_tables/' + id); toast('已移入回收站'); load();
      }
    };
  });
}

function addGradeDialog(reload) {
  const body = el(`<div class="sheet-body">
    <div class="field"><label class="field-label">年级名称</label>
      <input class="input" id="gname">
      <div class="field-hint">内置「高一」「高二」，需要别的年级（比如高三）时在这里加。</div></div>
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

/* ================= 新建表（手填，带出名册） ================= */
/* ================= 新建：铺名单 → 现场勾 =================
 *
 * 老师说得很清楚：「名册铺名单 + 上传照片当参照照打勾，这样我可以拿着手机去查班」。
 * 所以这个弹窗的核心不是「选参数」，而是「确认要带出哪些人」。
 *
 * 三件容易出错的提供默认值兜住：
 *  - 日期默认今天（每天查班，没人会去选今天）
 *  - 节次默认当前节次（按学校作息推，不知道就选第 1 节）
 *  - 学科可只带某一科（查教研常常只看一个组）
 */
function newSheetDialog(grade, reload, type = 'seat') {
  const today = ymd();
  const nowP = guessPeriod();
  const body = el(`<div class="sheet-body">
    <div class="field"><label class="field-label">这是一张什么表</label>
      <div class="seg" id="stype" style="width:100%">
        ${TYPE_ORDER.map((t) => `<button class="seg-btn${t === type ? ' on' : ''}" data-t="${t}"
          style="flex:1;justify-content:center">${TYPE_LABEL[t]}</button>`).join('')}
      </div>
      <div class="field-hint" id="type-hint"></div></div>
    <div class="field-row">
      <div class="field"><label class="field-label">年级</label>
        <select class="input" id="grade">${[grade, ...MAIN_GRADES].filter((v, i, a) => a.indexOf(v) === i)
          .map((g) => `<option ${g === grade ? 'selected' : ''}>${esc(g)}</option>`).join('')}</select></div>
      <div class="field"><label class="field-label">日期</label>
        <input class="input" type="date" id="date" value="${today}"></div>
    </div>
    <div class="field-row">
      <div class="field" id="wrap-periods"><label class="field-label">节次</label>
        <select class="input" id="periods">${periodOptions(nowP, { allowEmpty: false })}</select></div>
      <div class="field" id="wrap-subject"><label class="field-label">学科（留空＝全年级）</label>
        <input class="input" id="subject" list="subj-new" placeholder="留空就是全年级所有人"></div>
    </div>
    <datalist id="subj-new">${SUBJECT_ORDER.map((x) => `<option>${x}</option>`).join('')}</datalist>
    <div class="field"><label class="field-label">表格名称</label><input class="input" id="name"></div>
    <div class="att-roster-hint" id="rhint">正在读取名册…</div>
    <div class="field" style="margin-top:10px"><label class="field-label">现场参照照片（可选）</label>
      <label class="ap-add" id="ns-add"><input type="file" accept="image/*" multiple hidden id="ns-file">
        <span id="ns-txt">＋ 把纸表拍下来，勾的时候可以照着看</span></label>
      <div class="ap-list" id="ns-list" style="margin-top:8px"></div></div>
    <div class="confirm-actions"><button class="btn ghost" id="c">取消</button>
      <button class="btn primary" id="k">铺好名单，开始勾</button></div>
  </div>`);
  const s = sheet({ title: '新建考勤表', body, wide: true });
  const $ = (x) => body.querySelector(x);
  let roster = [];
  const photos = [];

  const curType = () => $('#stype .on').dataset.t;

  const autoName = () => {
    const g = $('#grade').value; const d = $('#date').value;
    const dt = d ? new Date(d + 'T00:00:00') : new Date();
    const t = curType();
    const per = t !== 'research' && $('#periods').value ? ` · 第${$('#periods').value}节` : '';
    const subj = t === 'research' && $('#subject').value.trim() ? `（${$('#subject').value.trim()}）` : '';
    $('#name').value = `${dt.getFullYear()}年${g}${TYPE_LABEL[t]}${subj}${per}`;
  };

  const loadRoster = async () => {
    const g = $('#grade').value;
    try {
      const r = await api.get('/teachers', { grade: g });
      roster = r.list || [];
      const subs = [...new Set(roster.map((t) => t.subject).filter(Boolean))].sort((a, b) => subjectRank(a) - subjectRank(b));
      $('#rhint').innerHTML = roster.length
        ? `<b>${roster.length}</b> 位教师会铺进表里${subs.length ? `，${subs.length} 个学科：${subs.map(esc).join('、')}` : ''}。
           <span class="muted">名单不对就去右上角「老师名册」改。</span>`
        : `「${esc(g)}」还没有名册，建出来会是空表。<button class="link-btn" id="go-roster">现在录名册 →</button>`;
      const go = $('#rhint').querySelector('#go-roster');
      if (go) go.onclick = () => { s.close(); rosterSheet(g, reload); };
    } catch { $('#rhint').textContent = '名册读取失败，将创建空表'; }
    autoName();
  };

  const syncType = () => {
    const t = curType();
    $('#wrap-periods').hidden = t === 'research';
    $('#wrap-subject').hidden = t !== 'research';
    const hint = {
      seat: '一人一行，勾「上课 / 坐班 / 听课 / 教研 / 请假」。',
      research: '按学科分块，每组一个「签到」勾。',
      class: '一人一行，只勾「按时上课」——查老师有没有到堂。',
    };
    $('#type-hint').textContent = hint[t];
    autoName();
  };

  body.querySelectorAll('#stype .seg-btn').forEach((b) => {
    b.onclick = () => {
      body.querySelectorAll('#stype .seg-btn').forEach((x) => x.classList.toggle('on', x === b));
      syncType();
    };
  });
  ['#grade', '#date', '#periods', '#subject'].forEach((sel) => {
    $(sel).addEventListener('input', autoName);
    $(sel).addEventListener('change', () => { autoName(); if (sel === '#grade') loadRoster(); });
  });

  const paintPhotos = () => {
    $('#ns-list').innerHTML = photos.map((p, i) => `
      <div class="ap-item"><div class="ap-thumb"><img src="${p.preview}" alt=""></div>
        <div class="ap-meta"><div class="ap-name">${esc(p.file.name)}</div>
        <div class="ap-size">${fmtSize(p.file.size)}</div></div>
        <button class="icon-btn sm" data-pd="${i}">${icon('close', 13)}</button></div>`).join('');
    $('#ns-txt').textContent = photos.length ? `已选 ${photos.length} 张` : '＋ 把纸表拍下来，勾的时候可以照着看';
    body.querySelectorAll('[data-pd]').forEach((b) => {
      b.onclick = () => { const [rm] = photos.splice(Number(b.dataset.pd), 1); if (rm) URL.revokeObjectURL(rm.preview); paintPhotos(); };
    });
  };
  $('#ns-file').onchange = (e) => {
    for (const f of e.target.files) if (/^image\//i.test(f.type)) photos.push({ file: f, preview: URL.createObjectURL(f) });
    e.target.value = ''; paintPhotos();
  };

  syncType(); loadRoster();
  $('#c').onclick = s.close;
  saving($('#k'), async () => {
    const t = curType();
    const d = $('#date').value;
    if (!d) return toast('选个日期', 'warn');
    const dt = new Date(d + 'T00:00:00');
    const g = $('#grade').value;
    const subj = t === 'research' ? $('#subject').value.trim() : '';
    /* 查教研可以只带某一科：老师常常只看自己那个组 */
    const people = subj ? roster.filter((x) => x.subject === subj) : roster;
    const r = await api.post('/attendance', {
      sheet_type: t,
      grade: g,
      sheet_date: d,
      weekday: WD[dt.getDay()],
      periods: t === 'research' ? '' : String($('#periods').value || ''),
      subject: subj,
      name: $('#name').value,
      month: d.slice(0, 7),
      columns: colsOf(t),
    });
    if (!r.id) throw new Error('建表失败，请重试');
    if (people.length) {
      await api.post(`/attendance/${r.id}/rows`, {
        rows: people.map((x) => ({ teacher: x.name, subject: x.subject, data: {} })),
      });
    }
    for (const ph of photos) {
      const fd = new FormData();
      fd.append('file', ph.file);
      fd.append('owner_type', 'attendance');
      fd.append('owner_id', String(r.id));
      await api.post('/upload', fd).catch((err) => toast(`${ph.file.name} 没存上：${err.message}`, 'err'));
    }
    photos.forEach((ph) => URL.revokeObjectURL(ph.preview));
    s.close();
    toast(people.length ? `铺好 ${people.length} 位老师，开始勾吧` : '已建成空表');
    reload();
    setTimeout(() => openTable(r.id, reload), 220);
  });
}

/* 按作息猜「现在大概第几节」。猜错无所谓，下拉就在旁边，改一下就行；
   猜对的时候能省一次点击——老师站在走廊里点手机，能省一次是一次。 */
function guessPeriod() {
  const h = new Date().getHours() + new Date().getMinutes() / 60;
  if (h < 8.6) return 1;
  if (h < 9.4) return 2;
  if (h < 10.4) return 3;
  if (h < 11.3) return 4;
  if (h < 12.3) return 5;
  if (h < 15.1) return 6;
  if (h < 16.0) return 7;
  if (h < 17.0) return 8;
  return 9;
}

/* ================= 打开一张表 ================= */
async function openTable(id, reload) {
  const t = await api.get('/attendance/' + id);
  const kind = t.sheet_type || t.kind;
  if (kind === 'research') return openResearch(t, reload);
  return openSeat(t, reload);
}

/* ---------- 通用：表头信息条 ----------
   这一条就是纸表最上面那行「时间 2026 年 10 月 19 日 星期 一 第 二 节」。
   做成可点的 chip，是为了「每天查班」这个高频动作：
   一天一张表，复制不了就点两下改日期，改完立刻能填。 */
function headerBar(t) {
  const isSeat = (t.sheet_type || t.kind) === 'seat';
  const nPhoto = Number(t.photo_count || 0);
  return `<div class="att-header">
    <div class="ah-grade">${esc(t.grade || '高一')}</div>
    <div class="ah-line">时间</div>
    ${dateChip(t)}
    ${isSeat ? periodChip(t) : ''}
    <span style="flex:1"></span>
    <button class="btn primary sm" id="att-quick">${icon('zap', 14)} 快速打勾</button>
    <button class="btn ghost sm" id="att-source">${icon('file', 14)} 原表</button>
    <button class="btn ghost sm" id="att-photos">${icon('camera', 14)} 原件${nPhoto ? ` ${nPhoto}` : ''}</button>
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
    if (rows) {
      await api.post(`/attendance/${t.id}/rows`, {
        rows: rows.map((r) => ({ id: r.id, teacher: r.teacher, subject: r.subject, data: r.data })),
      });
    }
    const detail = await api.get('/attendance/' + t.id);
    const cols = detail.columns || [];
    const checkCols = cols.filter((c) => c.type === 'check');
    const otherCols = cols.filter((c) => c.type !== 'check');
    const d = detail.sheet_date ? new Date(detail.sheet_date + 'T00:00:00') : null;
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
      weekday: d && !Number.isNaN(d.getTime()) ? '星期' + WD[d.getDay()] : (detail.weekday ? '星期' + detail.weekday : ''),
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
  let queue = rowsRef.map((r, i) => ({ ...r, _i: i })).filter((r) => cols.every((c) => !r.data?.[c.key]));
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

/* ---------- 改表头：日期 chip 点一下就弹这个 ----------
   【为什么不塞进「编辑表格」里】
   每天查班第一件事就是改日期。藏在二级菜单里等于每天多点两下。
   这里只放日期/节次/星期/名称四项，改完点「保存」当场生效。 */
function editHeadDialog(t, onSaved, focusField = '') {
  const body = el(`<div class="sheet-body">
    <div class="field-row">
      <div class="field"><label class="field-label">年级</label><input class="input" id="g" value="${esc(t.grade || '')}"></div>
      <div class="field"><label class="field-label">日期</label><input class="input" type="date" id="d" value="${esc(t.sheet_date || '')}"></div>
    </div>
    <div class="field-row">
      <div class="field"><label class="field-label">星期</label>
        <select class="input" id="w">${WD.map((x) => `<option ${x === (t.weekday || '') ? 'selected' : ''}>${x}</option>`).join('')}</select></div>
      <div class="field"><label class="field-label">节次</label>
        <select class="input" id="p">${periodOptions(t.periods)}</select></div>
    </div>
    <div class="field"><label class="field-label">表格名称</label><input class="input" id="n" value="${esc(t.name)}"></div>
    <div class="confirm-actions"><button class="btn ghost" id="c">取消</button><button class="btn primary" id="k">保存</button></div>
  </div>`);
  const s = sheet({ title: '改日期 / 节次', body });
  const $ = (x) => body.querySelector(x);
  /* 改日期顺带把星期算出来 —— 纸表上星期是跟着日期走的，不该让人手填 */
  $('#d').onchange = () => {
    const v = $('#d').value; if (!v) return;
    const dt = new Date(v + 'T00:00:00');
    if (!Number.isNaN(dt.getTime())) $('#w').value = WD[dt.getDay()];
  };
  (focusField === 'period' ? $('#p') : focusField === 'date' ? $('#d') : $('#n')).focus();
  $('#c').onclick = s.close;
  saving($('#k'), async () => {
    const d = $('#d').value;
    await api.patch('/attendance/' + t.id, {
      grade: $('#g').value, sheet_date: d, weekday: $('#w').value,
      periods: $('#p').value, name: $('#n').value,
      month: (d || '').slice(0, 7) || t.month,
    });
    s.close(); toast('已更新'); onSaved?.();
  });
}

/* 把表头 chip 的事件绑上（两个视图共用） */
function bindHeader(t, s, reload) {
  const rerender = async () => {
    s.close();
    reload?.();
    setTimeout(() => openTable(t.id, reload), 200);
  };
  const dchip = document.getElementById('att-edit-date');
  if (dchip) dchip.onclick = () => editHeadDialog(t, rerender, 'date');
  const pchip = document.getElementById('att-edit-period');
  if (pchip) pchip.onclick = () => editHeadDialog(t, rerender, 'period');
  const src = document.getElementById('att-source');
  if (src) src.onclick = () => sourceSheet(t);
  const ph = document.getElementById('att-photos');
  if (ph) ph.onclick = () => photosSheet(t.id, (n) => {
    t.photo_count = n;
    ph.innerHTML = `${icon('camera', 14)} 原件${n ? ' ' + n : ''}`;
  });
}

/* ---------- 原表：当初上传的那个 Excel / CSV ---------- */
async function sourceSheet(t) {
  const list = await api.get('/attachments', { owner_type: 'attendance', owner_id: t.id }).catch(() => []);
  const files = (list || []).filter((a) => /\.(xlsx|xlsm|csv|tsv|txt)$/i.test(a.name || ''));
  if (!files.length) {
    toast('这张表不是从文件导入的，没有原表可以下载', 'warn');
    return;
  }
  const body = el(`<div class="sheet-body">
    <div class="small muted" style="margin-bottom:10px">下面是你上传的原表，库里存的是解析后的结构化数据，原文件留档方便核对。</div>
    ${files.map((f) => `<div class="ap-item">
      <div class="ap-meta"><div class="ap-name">${esc(f.name)}</div><div class="ap-size">${fmtSize(f.size)}</div></div>
      <a class="btn ghost sm" href="${esc(f.url)}" download="${esc(f.name)}">下载</a>
    </div>`).join('')}
    <div class="att-tip-note" style="margin-top:10px">
      Excel 里那一列列勾（√ / ×）在导入时已经转成了表里的 ✓ / × 状态。
      以后想按原表格式再导一份，用表里的「导出 Excel」按钮。
    </div>
    <div class="confirm-actions"><button class="btn ghost" id="c">关闭</button></div>
  </div>`);
  const s = sheet({ title: '原表文件', body });
  body.querySelector('#c').onclick = s.close;
}

/* ---------- 导出 Excel（.xlsx，能直接在 Excel / WPS 里打开） ----------
   老师说「我就可以直接上传excel表格了」，反过来也要能导出：
   学期末要把电子版交给年级组，不能只给一张截图。 */
async function exportXlsx(t, reload) {
  try {
    const detail = await api.get('/attendance/' + t.id);
    const cols = detail.columns || [];
    const rows = detail.rows || [];
    const d = detail.sheet_date ? new Date(detail.sheet_date + 'T00:00:00') : null;
    const wd = d && !Number.isNaN(d.getTime()) ? '星期' + WD[d.getDay()] : (detail.weekday ? '星期' + detail.weekday : '');
    const header = [
      `时间 ${d ? `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日` : ''}　${wd}${detail.periods ? `　第 ${detail.periods} 节` : ''}`,
      ...Array(cols.length + 2).fill(''),
    ];
    const head = ['序号', '姓名', '学科', ...cols.map((c) => c.label)];
    const data = rows.map((r, i) => [
      i + 1, r.teacher || '', r.subject || '',
      ...cols.map((c) => (c.type === 'check'
        ? (r.data?.[c.key] === '1' ? '√' : r.data?.[c.key] === '0' ? '×' : '')
        : String(r.data?.[c.key] ?? ''))),
    ]);
    const blob = makeXlsx({ title: detail.name || '考勤表', grid: [header, [detail.name, ...Array(head.length - 1).fill('')], head, ...data] });
    saveBlob(blob, `${detail.name || '考勤表'}.xlsx`);
    toast('Excel 已生成');
  } catch (e) {
    toast(e.message || '导出失败', 'err');
  }
}

/* 造一个最小的 xlsx：一个工作表、全是内联字符串，不需要 sharedStrings。
   这样 30 行代码就能产出一个 Excel / WPS 都能打开的合法文件。 */
function makeXlsx({ title, grid }) {
  const escXml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const colName = (i) => {
    let n = i + 1; let s = '';
    while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
    return s;
  };
  /* 【数字还是文本】只有「序号」那一列（第 0 列、数据行）写成数字，
     其余一律写成文本。为什么不全写文本：序号写成文本，Excel 里那一列
     左上角会冒绿三角（"以文本形式存储的数字"），老师一看就以为导错了。
     反过来把姓名写成数字是不可能的，所以按列判断就够了。 */
  const dataStart = grid.findIndex((line) => String(line[0] || '').trim() === '序号') + 1 || 3;
  const rowsXml = grid.map((line, r) => `<row r="${r + 1}">${line.map((v, c) => {
    if (v === '' || v == null) return '';
    const numeric = c === 0 && r >= dataStart && /^-?\d+(\.\d+)?$/.test(String(v));
    return numeric
      ? `<c r="${colName(c)}${r + 1}"><v>${escXml(v)}</v></c>`
      : `<c r="${colName(c)}${r + 1}" t="inlineStr"><is><t xml:space="preserve">${escXml(v)}</t></is></c>`;
  }).join('')}</row>`).join('');
  const width = Math.max(...grid.map((l) => l.length));
  const colsXml = `<cols><col min="1" max="1" width="6"/><col min="2" max="2" width="12"/><col min="3" max="3" width="8"/>${width > 3 ? `<col min="4" max="${width}" width="10"/>` : ''}</cols>`;
  const files = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${escXml(String(title).slice(0, 28) || 'Sheet1')}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    'xl/worksheets/sheet1.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${colsXml}<sheetData>${rowsXml}</sheetData></worksheet>`,
  };
  return zipStore(files);
}

/* 不压缩的 zip（store 方式）。xlsx 允许不压缩，Excel / WPS 都能打开。
   好处是不用自己实现 deflate —— 浏览器有 CompressionStream，
   但用它要额外处理 CRC 和 backpressure，为了一个导出不值当。 */
function zipStore(files) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[i] = c >>> 0;
    }
    return t;
  })();
  const crc32 = (u8) => {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < u8.length; i++) c = crcTable[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  };
  for (const [name, text] of Object.entries(files)) {
    const nameU8 = enc.encode(name);
    const dataU8 = enc.encode(text);
    const crc = crc32(dataU8);
    const local = new Uint8Array(30 + nameU8.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true);        // UTF-8 文件名
    lv.setUint16(8, 0, true);             // store
    lv.setUint16(10, 0, true); lv.setUint16(12, 0, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, dataU8.length, true);
    lv.setUint32(22, dataU8.length, true);
    lv.setUint16(26, nameU8.length, true);
    lv.setUint16(28, 0, true);
    local.set(nameU8, 30);
    parts.push(local, dataU8);

    const cen = new Uint8Array(46 + nameU8.length);
    const cv = new DataView(cen.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, 0, true); cv.setUint16(14, 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, dataU8.length, true);
    cv.setUint32(24, dataU8.length, true);
    cv.setUint16(28, nameU8.length, true);
    cv.setUint16(30, 0, true); cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true); cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);
    cen.set(nameU8, 46);
    central.push(cen);
    offset += local.length + dataU8.length;
  }
  const cenSize = central.reduce((a, b) => a + b.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, central.length, true);
  ev.setUint16(10, central.length, true);
  ev.setUint32(12, cenSize, true);
  ev.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

/* ================= 坐班表 ================= */
function openSeat(t, reload) {
  let rows = t.rows.slice();
  let cols = t.columns.slice();
  const checkCols = cols.filter((c) => c.type === 'check');
  const remarkCol = cols.find((c) => c.type !== 'check');

  const isClass = (t.sheet_type || t.kind) === 'class';
  const body = el(`<div class="att-edit">
    ${headerBar(t)}
    <div class="att-sum" id="att-sum"></div>
    <div id="att-refbar"></div>
    <div id="att-todo"></div>
    <div class="att-tools">
      <input class="input att-search" id="att-q" placeholder="搜姓名 / 学科…">
      <button class="btn ghost sm" id="att-reset">清空勾选</button>
      <button class="btn ghost sm" id="att-fillall">全部标 ✓</button>
      <span style="flex:1"></span>
      <button class="btn ghost sm" id="att-addrow">＋ 加一行</button>
      <button class="btn ghost sm" id="att-addcol">＋ 加一列</button>
      <button class="btn ghost sm" id="att-xlsx">${icon('download', 14)} Excel</button>
      <button class="btn ghost sm" id="att-shot">${icon('camera', 14)} 截图发群</button>
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
    <div class="att-bottombar">
      <div class="abb-stat" id="att-bstat"></div>
      <button class="btn primary done" id="att-done">保存</button>
    </div>
  </div>`);
  const s = sheet({ title: `${t.grade || ''} ${TYPE_LABEL[t.sheet_type || t.kind] || ''}`, body, wide: true, cls: 'att-sheet' });
  const $ = (x) => body.querySelector(x);

  let filter = '';
  const paint = () => {
    const list = rows.map((r, i) => ({ ...r, _i: i })).filter((r) => {
      if (!filter) return true;
      const k = filter.toLowerCase();
      return String(r.teacher).toLowerCase().includes(k) || String(r.subject).includes(k);
    });
    /* 【按学科排，但序号跟原表走】
       老师核对时是拿纸表对着看的，纸表上 1 号是李成华。
       如果这里按学科重排后把序号也重算，就对不上了。
       所以显示顺序按学科（查某个学科方便），序号列显示原表序号。 */
    list.sort((a, b) => subjectRank(a.subject) - subjectRank(b.subject) || a._i - b._i);
    $('#att-sum').innerHTML = sumHTML();
    if ($('#att-bstat')) $('#att-bstat').innerHTML = bstatHTML();
    paintTodo();
    $('#att-table').innerHTML = `<table class="att-tbl${isClass ? ' att-class' : ''}">
      <thead><tr>
        <th class="th-no">序号</th><th class="th-name">姓名</th><th class="th-subj">学科</th>
        ${checkCols.map((c) => `<th class="th-check">${esc(c.label)}</th>`).join('')}
        ${remarkCol ? `<th class="th-remark">${esc(remarkCol.label)}</th>` : ''}
        <th class="th-del"></th>
      </tr></thead>
      <tbody>${list.map((r, k) => `<tr data-ri="${r._i}"${isClass && r.data?.[checkCols[0]?.key] !== '1' ? ' class="pending"' : ''}>
        <td class="td-no">${r._i + 1}</td>
        <td class="td-name"><input class="cell-in" data-r="${r._i}" data-k="__teacher" value="${esc(r.teacher)}"></td>
        <td class="td-subj"><input class="cell-in subject-in" data-r="${r._i}" data-k="__subject" value="${esc(r.subject || '')}" list="subj-list"></td>
        ${checkCols.map((c) => `<td class="td-check">${tickCell(r.data?.[c.key], r._i, c.key)}</td>`).join('')}
        ${remarkCol ? `<td class="td-remark"><input class="cell-in" data-r="${r._i}" data-k="${remarkCol.key}" value="${esc(r.data?.[remarkCol.key] ?? '')}"></td>` : ''}
        <td class="td-del"><button class="icon-btn sm" data-del="${r._i}" title="删除此行">${icon('close', 13)}</button></td>
      </tr>`).join('')}</tbody>
    </table>
    <datalist id="subj-list">${SUBJECT_ORDER.map((x) => `<option>${x}</option>`).join('')}</datalist>`;
    bindCells();
  };
  const sumHTML = () => {
    const sum = (key) => rows.filter((r) => r.data?.[key] === '1').length;
    const vacant = rows.filter((r) => checkCols.every((c) => !r.data?.[c.key])).length;
    return `<span class="as-total"><b>${rows.length}</b> 人</span>
      ${checkCols.map((c) => `<span class="as-item"><i>${esc(c.label)}</i><b>${sum(c.key)}</b></span>`).join('')}
      ${vacant ? `<span class="as-warn">${vacant} 人一项都没勾</span>` : ''}`;
  };
  /* 手机底部那一条：只有「已勾几个 / 共几个」，一眼知道还差多少 */
  const bstatHTML = () => {
    const key = checkCols[0]?.key;
    const done = rows.filter((r) => r.data?.[key] === '1').length;
    return `<b>${done}<span style="font-size:13px;color:var(--text-3)">/${rows.length}</span></b>
      <span>${isClass ? '已到堂' : '已勾'} · 剩 ${rows.length - done} 人</span>`;
  };

  /* 【查上课的核心：把「还没勾的人」顶到上面】
     老师站在教室门口，顺着走廊走过去，一次只管一个人。
     所以①没勾的行底色偏黄、②顶部直接列出名字（点一下就滚动到那行）、
     ③勾完这行自动变绿淡出视野。不用自己从头找谁还没查。 */
  const paintTodo = () => {
    const key = checkCols[0]?.key;
    if (!key) return;
    const left = rows.map((r, i) => ({ r, i })).filter((x) => x.r.data?.[key] !== '1');
    const el2 = $('#att-todo');
    if (!el2) return;
    if (!rows.length) { el2.innerHTML = ''; return; }
    if (!left.length) {
      el2.innerHTML = `<div class="att-todo" style="background:var(--primary-weak);border-color:color-mix(in srgb,var(--primary) 24%,transparent)">
        <b style="color:var(--primary)">全部查完了</b> —— 点「截图发群」就能发出去。</div>`;
      return;
    }
    /* 太多人的时候只列前 12 个，否则一屏全是名字，反而挡着表 */
    const show = left.slice(0, 12);
    el2.innerHTML = `<div class="att-todo">
      <b>还剩 ${left.length} 人没勾</b>
      <span class="muted">（点名字直接跳过去）</span>
      <div style="display:flex;flex-wrap:wrap;gap:5px;margin-top:6px">
        ${show.map((x) => `<button class="btn ghost xs" data-jump="${x.i}">${esc(x.r.teacher)}</button>`).join('')}
        ${left.length > 12 ? `<span class="tiny muted" style="align-self:center">…还有 ${left.length - 12} 人</span>` : ''}
      </div></div>`;
    el2.querySelectorAll('[data-jump]').forEach((b) => {
      b.onclick = () => {
        const tr = body.querySelector(`.att-tbl tbody tr[data-ri="${b.dataset.jump}"]`);
        if (!tr) return;
        tr.scrollIntoView({ block: 'center', behavior: 'smooth' });
        tr.classList.add('flash');
        setTimeout(() => tr.classList.remove('flash'), 900);
      };
    });
  };

  /* 原表照片当参照：勾的时候抬头就能看到纸表上原本怎么画的 */
  const paintRef = async () => {
    const box2 = $('#att-refbar');
    if (!box2) return;
    let list = [];
    try { list = await api.get(`/attendance/${t.id}/photos`); } catch { list = []; }
    if (!list || !list.length) { box2.innerHTML = ''; return; }
    box2.innerHTML = `<div class="att-refbar">
      <img src="${esc(list[0].url || '')}" alt="" onerror="this.style.display='none'">
      <span>现场参照：纸表照片 ${list.length} 张</span>
      <span style="flex:1"></span>
      <button class="btn ghost xs" id="ref1">看大图</button></div>`;
    const open1 = () => photosSheet(t.id, () => { });
    box2.querySelector('#ref1').onclick = open1;
    box2.querySelector('img').onclick = open1;
  };
  const bindCells = () => {
    body.querySelectorAll('.tick').forEach((b) => {
      b.onclick = () => {
        const ri = Number(b.dataset.r); const k = b.dataset.k;
        const cur = String(rows[ri].data?.[k] ?? '');
        const next = cur === '' ? '1' : cur === '1' ? '0' : '';
        rows[ri].data = rows[ri].data || {};
        if (next === '') delete rows[ri].data[k]; else rows[ri].data[k] = next;
        /* 局部更新，不重绘整表 —— 重绘会让旁边正在输入的备注框失焦 */
        b.className = 'tick' + (next === '1' ? ' on' : next === '0' ? ' off' : '');
        b.textContent = next === '1' ? '✓' : next === '0' ? '×' : '';
        const elSum = $('#att-sum'); if (elSum) elSum.innerHTML = sumHTML();
        if ($('#att-bstat')) $('#att-bstat').innerHTML = bstatHTML();
        paintTodo();
        /* 查上课时按行上色：勾了变绿、没勾保持黄，扫一眼就知道走到哪了 */
        const tr = b.closest ? b.closest('tr') : null;
        if (tr) tr.classList.toggle('pending', next !== '1');
      };
    });
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

  paint();
  bindHeader(t, s, reload);
  paintRef();
  $('#att-q').oninput = (e) => { filter = e.target.value.trim(); paint(); };
  /* 手机上那个大「保存」，跟工具栏里的小保存走同一段逻辑 */
  const doSave = async () => {
    await api.post(`/attendance/${t.id}/rows`, { rows: rows.map((r) => ({ id: r.id, teacher: r.teacher, subject: r.subject, data: r.data })) });
    await api.patch('/attendance/' + t.id, { columns: cols });
    toast('已保存'); s.close(); reload();
  };
  saving($('#att-done'), doSave);
  $('#att-shot').onclick = () => shotTable(t.id);
  $('#att-addrow').onclick = () => { rows.push({ teacher: '', subject: '', data: {} }); paint(); };
  $('#att-addcol').onclick = () => colEditor(cols, null, (n) => {
    cols = n;
    checkCols.length = 0; cols.filter((c) => c.type === 'check').forEach((c) => checkCols.push(c));
    paint();
  });
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
  $('#att-xlsx').onclick = () => exportXlsx(t);
  saving($('#att-save'), async () => {
    await api.post(`/attendance/${t.id}/rows`, { rows: rows.map((r) => ({ id: r.id, teacher: r.teacher, subject: r.subject, data: r.data })) });
    await api.patch('/attendance/' + t.id, { columns: cols });
    toast('已保存'); s.close(); reload();
  });
}

/* ================= 教研签到表（按学科分块） ================= */
function openResearch(t, reload) {
  let rows = t.rows.slice();
  const cols = t.columns.slice();
  const checkCols = cols.filter((c) => c.type === 'check');
  const remarkCol = cols.find((c) => c.type !== 'check');
  const key = checkCols[0]?.key || 'k_签到';

  const body = el(`<div class="att-edit">
    ${headerBar(t)}
    <div class="att-sum" id="att-sum"></div>
    <div class="att-tools">
      <input class="input att-search" id="att-q" placeholder="搜姓名 / 学科…">
      <button class="btn ghost sm" id="att-expand">展开全部</button>
      <span style="flex:1"></span>
      <button class="btn ghost sm" id="att-addrow">＋ 加一位教师</button>
      <button class="btn ghost sm" id="att-xlsx">${icon('download', 14)} Excel</button>
      <button class="btn ghost sm" id="att-shot">${icon('camera', 14)} 截图发群</button>
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
    <div class="att-bottombar">
      <div class="abb-stat" id="att-bstat"></div>
      <button class="btn primary done" id="att-done">保存</button>
    </div>
  </div>`);
  const s = sheet({ title: `${t.grade || ''} ${TYPE_LABEL.research}`, body, wide: true, cls: 'att-sheet' });
  const $ = (x) => body.querySelector(x);
  let filter = '';
  const collapsed = new Set();

  const sumHTML = () => {
    const signed = rows.filter((r) => r.data?.[key] === '1').length;
    const rate = rows.length ? Math.round(signed / rows.length * 100) : 0;
    const nSub = new Set(rows.map((r) => r.subject || '未分学科')).size;
    return `<span class="as-total"><b>${rows.length}</b> 人 · ${nSub} 个学科</span>
      <span class="as-item"><i>已签到</i><b>${signed}</b></span>
      <span class="as-item"><i>签到率</i><b>${rate}%</b></span>
      ${rows.length - signed ? `<span class="as-warn">${rows.length - signed} 人未签到</span>` : ''}`;
  };

  const paint = () => {
    const groups = new Map();
    rows.forEach((r, i) => {
      const sj = r.subject || '未分学科';
      if (!groups.has(sj)) groups.set(sj, []);
      groups.get(sj).push({ ...r, _i: i });
    });
    const sorted = [...groups.entries()].sort((a, b) => subjectRank(a[0]) - subjectRank(b[0]));
    $('#att-sum').innerHTML = sumHTML();

    $('#att-blocks').innerHTML = sorted.map(([sj, list]) => {
      const shown = list.filter((r) => !filter || String(r.teacher).includes(filter) || String(r.subject).includes(filter));
      if (!shown.length) return '';
      const signed = list.filter((r) => r.data?.[key] === '1').length;
      const isCollapsed = collapsed.has(sj) && !filter;
      const pct = list.length ? Math.round(signed / list.length * 100) : 0;
      return `<div class="att-block" data-sj="${esc(sj)}">
        <div class="ab-head">
          <button class="ab-toggle" data-toggle="${esc(sj)}" aria-label="折叠">${icon('down', 15, isCollapsed ? '' : 'rot')}</button>
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
          <tbody>${shown.map((r) => `<tr>
            <td class="td-no">${r._i + 1}</td>
            <td class="td-name"><input class="cell-in" data-r="${r._i}" data-k="__teacher" value="${esc(r.teacher)}"></td>
            <td class="td-check">${tickCell(r.data?.[key], r._i, key)}</td>
            ${remarkCol ? `<td class="td-remark"><input class="cell-in" data-r="${r._i}" data-k="${remarkCol.key}" value="${esc(r.data?.[remarkCol.key] ?? '')}"></td>` : ''}
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
  /* 手机上那条底栏：教研表按「已签到 / 总人数」算 */
  const bstatHTML = () => {
    const done = rows.filter((r) => r.data?.[key] === '1').length;
    return `<b>${done}<span style="font-size:13px;color:var(--text-3)">/${rows.length}</span></b>
      <span>已签到 · 剩 ${rows.length - done} 人</span>`;
  };
  const refreshBlockHeads = () => {
    const elSum = $('#att-sum'); if (elSum) elSum.innerHTML = sumHTML();
    const elB = $('#att-bstat'); if (elB) elB.innerHTML = bstatHTML();
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
  bindHeader(t, s, reload);
  $('#att-q').oninput = (e) => { filter = e.target.value.trim(); paint(); };
  $('#att-expand').onclick = () => { collapsed.clear(); paint(); toast('已展开全部学科'); };
  $('#att-addrow').onclick = () => { rows.push({ teacher: '', subject: '', data: {} }); paint(); };
  /* 【这里的按钮绑定必须判空】
     教研表的工具栏跟坐班表不一样，早先无条件写 $('#att-quick').onclick
     → null 赋值抛 TypeError，后面的保存 / 加行 / PDF 全部没绑上，表存不了。
     现在 headerBar 两个视图用的是同一套 id，仍然判空兜一层。 */
  const quickBtnR = $('#att-quick');
  if (quickBtnR) quickBtnR.onclick = () => quickSheet(t, rows, () => { paint(); });
  $('#att-pdf').onclick = () => saveThenPdf(t, rows);
  $('#att-xlsx').onclick = () => exportXlsx(t);
  const doSaveR = async () => {
    await api.post(`/attendance/${t.id}/rows`, { rows: rows.map((r) => ({ id: r.id, teacher: r.teacher, subject: r.subject, data: r.data })) });
    toast('已保存'); s.close(); reload();
  };
  saving($('#att-save'), doSaveR);
  /* 手机底栏那个大保存、截图发群 */
  saving($('#att-done'), doSaveR);
  $('#att-shot').onclick = () => shotTable(t.id);
  const elB = $('#att-bstat'); if (elB) elB.innerHTML = bstatHTML();
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

/* ================= 上传识别 =================
 *
 * 【2026-10 重做：从「认图」改成「读文件」】
 * 老版本主打「拍照就能导」，实际跑不通：图片里最关键的姓名是手写体，
 * 没有 OCR 引擎根本认不出来，只能按名册顺序硬铺，一错位整张表全错。
 * 老师上传的本来就是 Excel / Word 导出的电子表，直接读单元格才是对的路：
 * 姓名、学科、勾叉都是文本，一个字都不会认错。
 *
 * 照片仍然有用 —— 作为「纸质原件」存进表里，核对时有据可查。
 * 所以这一步两条路都留着，只是主次调换了：
 *   ① 主路：.xlsx / .xlsm / .csv / .tsv → 前端解析（@see xlsx-lite.js）
 *   ② 辅路：照片 → 建一张空表（名册铺好）+ 把原件存进去，对着照片打勾
 */
function uploadDialog(grade, reload) {
  const body = el(`<div class="sheet-body">
    <div class="att-drop" id="drop">
      <div class="ad-ico">${icon('upload', 26)}</div>
      <div class="ad-t">点这里选 Excel，或者把文件拖进来</div>
      <div class="ad-s">支持 <b>.xlsx / .xlsm / .csv</b>，12MB 以内。文件不上传，就在你自己浏览器里读。</div>
      <input type="file" id="file" accept=".xlsx,.xlsm,.csv,.tsv,.txt" hidden>
    </div>
    <div class="att-tips">
      <div class="att-tip-h">会自动认出这些</div>
      <div class="att-tip-grid">
        <div>${icon('check', 14)} 哪一列是姓名、哪几列要打勾</div>
        <div>${icon('check', 14)} 每一格是 √ 还是 ×（空白保持未填）</div>
        <div>${icon('check', 14)} 表类型（坐班 / 教研 / 上课检查）</div>
        <div>${icon('check', 14)} 年 月 日 星期、第几节</div>
        <div>${icon('check', 14)} 姓名 + 学科</div>
        <div>${icon('check', 14)} 一页双栏，左右自动接起来</div>
      </div>
      <div class="att-tip-note">
        表格结构按你发的那两张纸表做的：<b>序号 姓名 学科 上课 坐班 听课 教研 请假 备注</b>。
        如果列名不一样（比如「签到」写成「出勤」），也能认出来；实在认不出会在下一步告诉你缺什么。
      </div>
    </div>
    <div class="att-manual">
      <button class="link-btn" id="photo-mode">只有纸质表照片、没有 Excel？铺名单自己勾 →</button>
    </div>
  </div>`);
  const s = sheet({ title: '上传 Excel 表格', body });
  const $ = (x) => body.querySelector(x);
  $('#drop').onclick = () => $('#file').click();
  $('#drop').ondragover = (e) => { e.preventDefault(); $('#drop').classList.add('over'); };
  $('#drop').ondragleave = () => $('#drop').classList.remove('over');
  $('#drop').ondrop = (e) => {
    e.preventDefault(); $('#drop').classList.remove('over');
    const f = e.dataTransfer.files[0]; if (f) doImportFile(f, s, grade, reload);
  };
  $('#file').onchange = (e) => { const f = e.target.files[0]; if (f) doImportFile(f, s, grade, reload); };
  $('#photo-mode').onclick = () => { s.close(); photoOnlyDialog(grade, reload); };
}

/* 读文件 → 二维数组。三条分支：xlsx（zip+xml）、csv/tsv、以及「传错了传成图片」 */
async function readGrid(file) {
  const name = String(file.name || '').toLowerCase();
  if (/\.(xlsx|xlsm)$/.test(name)) {
    const r = await readXlsx(file);
    return { grid: r.rows, sheetName: r.sheetName, sheets: r.sheets };
  }
  if (/\.(csv|tsv|txt)$/.test(name)) {
    const text = await file.text();
    return { grid: readDelimited(text, /\.[tT][sS][vV]$/.test(name) ? '\t' : undefined), sheetName: '' };
  }
  if (/\.xls$/.test(name)) {
    throw new Error('这是 Excel 97-2003 的老格式（.xls）。用 Excel / WPS 打开，「另存为」选 .xlsx 再传。');
  }
  if (/^image\//i.test(file.type || '') || /\.(png|jpe?g|webp|bmp|heic)$/i.test(name)) {
    throw new Error('这是一张图片。图片里的手写姓名没法可靠识别，请先在 Excel 里把表做成电子表再上传；或者用下面的「拍照建表」，先用名册铺好名单再对着照片打勾。');
  }
  throw new Error('不认识这个文件类型，请传 .xlsx / .csv');
}

/* 【为什么失败要用弹层而不是 toast】
   toast 三秒就没了，而且只有一行字。老师碰到「文件没读出来」的时候
   需要的不是一句结论，而是「问题出在哪、我该怎么改」。
   下面这个弹层把原因 + 自助检查项摊开，关掉才算完。 */
function failDialog(title, reason, tips = [], rawText = '') {
  const body = el(`<div class="sheet-body">
    <div class="acm-roster" style="background:#FEF2F2;border-color:#FECACA">
      <div style="font-weight:650;margin-bottom:2px">${esc(title)}</div>
      <div class="small">${esc(reason)}</div>
    </div>
    ${rawText ? `<div class="small muted" style="margin:12px 0 6px">文件里读到的前几行：</div>
      <pre class="att-raw">${esc(rawText)}</pre>` : ''}
    ${tips.length ? `<div class="att-tip-note" style="margin-top:10px">${tips.map((t, i) => `${i + 1}. ${t}`).join('<br>')}</div>` : ''}
    <div class="confirm-actions"><button class="btn primary" id="c">知道了</button></div>
  </div>`);
  const sd = sheet({ title, body, wide: true });
  body.querySelector('#c').onclick = sd.close;
}

async function doImportFile(file, s, grade, reload) {
  if (file.size > 12 * 1024 * 1024) return toast('文件太大了（上限 12MB）', 'warn');
  toast('正在读取表格…');
  let grid; let sheetName = ''; let sheets = [];
  try {
    const r = await readGrid(file);
    grid = r.grid; sheetName = r.sheetName; sheets = r.sheets || [];
  } catch (e) {
    return failDialog('这个文件读不出来', e.message, [
      '用 Excel 或 WPS 打开它，「另存为」选 <b>.xlsx</b> 再传一次。',
      '如果是手机相册里的照片，请改用下面的「拍照建表」。',
      '文件如果是加密的（要密码才能打开），先另存成不加密的版本。',
    ]);
  }
  if (!grid || !grid.length) {
    return failDialog('这个文件是空的', '没读到任何内容，可能是只有格式没有数据的空表。');
  }

  const parsed = parseAttendanceSheet(grid, { gradeHint: grade });
  if (!parsed.ok) {
    /* 【认不出的时候，别只丢一句「识别失败」】
       老师的反应一定是「那到底哪儿不对」。这里把读到的前几行原样摊出来，
       一眼就能看出是表头行位置不对，还是干脆传错了文件。 */
    const preview = grid.slice(0, 8)
      .map((r, i) => `第${i + 1}行：` + (r || []).filter((x) => String(x).trim()).slice(0, 10).join(' | '))
      .filter((line) => line.replace(/^第\d+行：/, ''))
      .join('\n');
    return failDialog('没认出这张表', parsed.reason, [
      '表头那一行要有「序号 / 姓名 / 学科」这几个字（列的顺序不一样没关系）。',
      '姓名要是文字，不能是截图贴进去的图片。',
      '传的是有数据的那张工作表，不是封面或说明页。',
    ], preview || '（前 8 行都是空的）');
  }
  s.close();
  /* 多个工作表时，让用户挑 —— 一个 xlsx 里常常同时放着高一和高二的表 */
  const multi = sheets.filter((x) => x.rows.some((r) => r.some((c) => String(c).trim()))).length > 1;
  confirmSheet(parsed, { grade, reload, filename: file.name, grid, sheetName, sheets: multi ? sheets : null });
}

/* 只有照片、没有 Excel：先建空表（带名册），再把照片存进去 */
async function photoOnlyDialog(grade, reload) {
  const body = el(`<div class="sheet-body">
    <div class="field-row">
      <div class="field"><label class="field-label">年级</label>
        <select class="input" id="po-grade">${MAIN_GRADES.map((g) => `<option ${g === grade ? 'selected' : ''}>${g}</option>`).join('')}</select></div>
      <div class="field"><label class="field-label">表类型</label>
        <select class="input" id="po-type">
          <option value="seat">教师坐班表</option>
          <option value="research">教师教研签到表</option>
        </select></div>
    </div>
    <div class="field-row">
      <div class="field"><label class="field-label">日期</label><input class="input" type="date" id="po-date" value="${ymd()}"></div>
      <div class="field"><label class="field-label">节次</label>
        <select class="input" id="po-period">${periodOptions(1, { allowEmpty: false })}</select></div>
    </div>
    <div class="field"><label class="field-label">照片</label>
      <label class="ap-add" id="po-add"><input type="file" accept="image/*" multiple hidden id="po-file"><span id="po-txt">＋ 选择照片 / 拍照</span></label>
      <div class="ap-list" id="po-list" style="margin-top:8px"></div></div>
    <div class="field-hint">会按「${esc(grade)}」名册把老师名单先铺好，你点开表对着照片逐行打勾就行。</div>
    <div class="confirm-actions"><button class="btn ghost" id="po-cancel">取消</button>
      <button class="btn primary" id="po-ok">建表并存照片</button></div>
  </div>`);
  const s = sheet({ title: '拍照建表', body });
  const $ = (x) => body.querySelector(x);
  const picked = [];
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
    const type = $('#po-type').value;
    const date = $('#po-date').value;
    if (!date) return toast('选个日期', 'warn');
    const wd = WD[new Date(date + 'T00:00:00').getDay()];
    let roster = [];
    try { roster = (await api.get('/teachers', { grade: g })).list || []; } catch { roster = []; }
    const per = type === 'seat' ? String($('#po-period').value || '') : '';
    const res = await api.post('/attendance', {
      name: `${date.slice(0, 4)}年${g}${TYPE_SHORT[type]}${per ? ' · 第' + per + '节' : ''}`,
      grade: g, sheet_type: type, sheet_date: date, weekday: wd, periods: per,
      month: date.slice(0, 7), columns: colsOf(type),
    });
    const newId = res.id;
    if (!newId) throw new Error('建表失败，请重试');
    if (roster.length) {
      await api.post(`/attendance/${newId}/rows`, { rows: roster.map((t) => ({ teacher: t.name, subject: t.subject, data: {} })) });
    }
    for (const p of picked) {
      const fd = new FormData();
      fd.append('file', p.file);
      fd.append('owner_type', 'attendance');
      fd.append('owner_id', String(newId));
      await api.post('/upload', fd).catch((err) => toast(`${p.file.name} 没存上：${err.message}`, 'err'));
    }
    picked.forEach((p) => URL.revokeObjectURL(p.preview));
    s.close(); toast(roster.length ? `建好了，带出 ${roster.length} 位老师` : '建好了'); reload();
    setTimeout(() => openTable(newId, reload), 260);
  });
}

/* ================= 识别结果确认页 ================= */
function confirmSheet(parsed, ctx) {
  const { grade, reload, filename } = ctx;
  let r = parsed;

  /* 支持切换工作表：一个文件里高一高二各一张表是常态 */
  const rebuild = (grid, sheetName) => {
    const np = parseAttendanceSheet(grid, { gradeHint: grade });
    if (!np.ok) { toast(np.reason, 'err', 6000); return; }
    r = np;
    ctx.grid = grid; ctx.sheetName = sheetName;
    sheetRef.close();
    confirmSheet(r, ctx);
  };

  const d = { grade: r.grade || grade, date: r.date || '', period: r.period || 1, type: r.type };
  const checkCols = (r.columns || []).filter((c) => c.type === 'check');
  const body = el(`<div class="att-confirm">
    <div class="acm-file">
      <span class="acm-f">${icon('file', 15)} ${esc(filename)}${ctx.sheetName ? ` · ${esc(ctx.sheetName)}` : ''}</span>
      ${r.columns.some((c) => /左栏/.test(c.label)) ? '<span class="chip">双栏排版，已合并</span>' : ''}
      <span class="chip">${esc(TYPE_LABEL[r.type])}</span>
    </div>
    ${ctx.sheets ? `<div class="field"><label class="field-label">这个文件里有 ${ctx.sheets.length} 张工作表</label>
      <div class="att-sheetpick" id="c-sheetpick">${ctx.sheets.map((x, i) => `<button class="btn ghost sm${x.name === ctx.sheetName ? ' on' : ''}" data-si="${i}">${esc(x.name)}<span class="tiny muted">${x.rows.length} 行</span></button>`).join('')}</div>
      <div class="field-hint">切到别的表会重新识别。高一高二通常各一张。</div></div>` : ''}
    <div class="acm-grid">
      <div class="field"><label class="field-label">年级</label>
        <select class="input" id="c-grade">${MAIN_GRADES.map((g) => `<option ${g === d.grade ? 'selected' : ''}>${esc(g)}</option>`).join('')}</select></div>
      <div class="field"><label class="field-label">表类型</label>
        <select class="input" id="c-type">
          <option value="seat" ${d.type !== 'research' ? 'selected' : ''}>教师坐班表</option>
          <option value="research" ${d.type === 'research' ? 'selected' : ''}>教师教研签到表</option>
        </select></div>
      <div class="field"><label class="field-label">日期</label><input class="input" type="date" id="c-date" value="${d.date || ymd()}"></div>
      <div class="field"><label class="field-label">节次</label><select class="input" id="c-periods">${periodOptions(d.period)}</select></div>
    </div>
    <div class="field"><label class="field-label">表格名称</label><input class="input" id="c-name" value="${esc(filename.replace(/\.(xlsx|xlsm|csv|tsv|txt)$/i, ''))}"></div>
    <div class="acm-sum">
      <span><b>${r.people.length}</b> 位教师</span>
      <span><b>${new Set(r.people.map((p) => p.subject).filter(Boolean)).size}</b> 个学科</span>
      <span><b>${checkCols.length}</b> 个勾选列：${checkCols.map((c) => esc(c.label)).join(' / ')}</span>
      <span>已勾 <b>${r.people.reduce((a, p) => a + Object.values(p.marks).filter(Boolean).length, 0)}</b> 格</span>
    </div>
    ${r.warnings?.length ? `<div class="acm-roster" style="background:#FFFBEB;border-color:#FDE68A">
      ${r.warnings.map((w) => `<div>${esc(w)}</div>`).join('')}</div>` : ''}
    <div class="acm-preview">
      <button class="acm-pv-h acm-pv-toggle open" id="acm-pv-btn">
        ${icon('down', 14)} 逐行核对（共 ${r.people.length} 行）<span class="acm-pv-more">再点收起</span>
      </button>
      <div class="acm-pv-wrap" id="acm-pv-wrap">
        <div class="pv-scroll" style="max-height:46vh">
          <table class="pv-tbl">
            <thead><tr><th class="pv-no">#</th><th>姓名（可改）</th><th>学科</th>
              ${checkCols.map((c) => `<th class="pv-ch">${esc(c.label.replace(/^[左右]栏·/, ''))}</th>`).join('')}</tr></thead>
            <tbody>${r.people.map((p, i) => `<tr data-pi="${i}">
              <td class="pv-no">${i + 1}</td>
              <td><input class="input pv-in" data-name="${i}" value="${esc(p.name)}"></td>
              <td><input class="input pv-in" data-subj="${i}" value="${esc(p.subject || '')}"></td>
              ${checkCols.map((c) => `<td><button class="pv-mark${p.marks[c.key] ? ' on' : ''}" data-cell="${i}|${c.key}">${p.marks[c.key] ? '✓' : '·'}</button></td>`).join('')}
            </tr>`).join('')}</tbody>
          </table>
        </div>
      </div>
    </div>
    <div class="confirm-actions" style="position:sticky;bottom:0;background:var(--card);padding-top:8px">
      <button class="btn ghost" id="c-cancel">取消</button>
      <button class="btn primary" id="c-ok">导入为新表</button>
    </div>
  </div>`);
  const sheetRef = sheet({ title: '确认导入内容', body, wide: true, cls: 'att-confirm-sheet' });
  const $ = (x) => body.querySelector(x);
  $('#c-cancel').onclick = () => sheetRef.close();

  /* 点格子切换 ✓ / 空 —— 认错了当场改，不用导进去再翻 */
  body.querySelectorAll('[data-cell]').forEach((b) => {
    b.onclick = () => {
      const [i, key] = b.dataset.cell.split('|');
      const p = r.people[Number(i)];
      p.marks[key] = !p.marks[key];
      b.className = 'pv-mark' + (p.marks[key] ? ' on' : '');
      b.textContent = p.marks[key] ? '✓' : '·';
    };
  });
  body.querySelectorAll('[data-name]').forEach((inp) => {
    inp.oninput = () => { r.people[Number(inp.dataset.name)].name = inp.value; };
  });
  body.querySelectorAll('[data-subj]').forEach((inp) => {
    inp.oninput = () => { r.people[Number(inp.dataset.subj)].subject = inp.value; };
  });
  body.querySelectorAll('#c-sheetpick [data-si]').forEach((b) => {
    b.onclick = () => {
      const x = ctx.sheets[Number(b.dataset.si)];
      rebuild(x.rows, x.name);
    };
  });
  $('#c-date').onchange = () => {
    const v = $('#c-date').value; if (!v) return;
    /* 名称里的年份跟着日期走，免得「2026年」配着 2027 年的日期 */
    const nm = $('#c-name');
    const dt = new Date(v + 'T00:00:00');
    if (!Number.isNaN(dt.getTime()) && /^\d{4}年/.test(nm.value)) {
      nm.value = nm.value.replace(/^\d{4}年/, dt.getFullYear() + '年');
    }
  };
  $('#acm-pv-btn').onclick = () => {
    const w = $('#acm-pv-wrap');
    w.hidden = !w.hidden;
    $('#acm-pv-btn').classList.toggle('open', !w.hidden);
  };

  saving($('#c-ok'), async () => {
    const g = $('#c-grade').value;
    const type = $('#c-type').value;
    const date = $('#c-date').value;
    const period = type === 'seat' ? $('#c-periods').value : '';
    const wd = date ? WD[new Date(date + 'T00:00:00').getDay()] : '';
    let name = $('#c-name').value.trim();
    if (!name) name = `${date.slice(0, 4)}年${g}${TYPE_SHORT[type]}${period ? ' · 第' + period + '节' : ''}`;

    /* 列定义要跟「表类型」对齐：
       用户把类型从教研改成坐班，列却还是「签到」，界面会很怪。
       解析出来的列名跟标准列名一致时保留原 key（数据对得上），
       不一致就退回标准列 —— 因为勾选状态本来就要按新列重排。 */
    const standard = colsOf(type);
    let useCols = (type === r.type) ? r.columns.map((c) => ({
      key: c.key, label: c.label, type: c.type, w: c.type === 'check' ? 62 : 130,
    })) : standard;
    /* 【双栏表要按纸表原样合过去】
       一张 A4 纸横着排 46 人，所以左栏 1~23、右栏 24~46 是并排的两组。
       如果导入后把人拉成一长条、保留 8 个勾选列（左栏上课/左栏坐班/…/右栏教研），
       界面上就是 8 列里有一半永远是空的，老师还得记「哪几列是左栏的」。
       这里把右栏的勾搬到左栏同名 key 上，然后把右栏那几列去掉 ——
       表就回到了纸表的样子：一人一行，4 个勾，46 行。
       代价是丢掉了「这个人是左栏还是右栏」的信息，但那个信息对填表毫无用处。 */
    let mergeMap = null;
    if (type === r.type && useCols.some((c) => /^右栏·/.test(c.label))) {
      /* 按「列的类型」配对，不能按 index 配对：
         左栏 = [上课,坐班,听课,教研,请假,备注]，右栏 = [上课,坐班,听课,教研,备注(缺请假)]
         两边的「备注」差一个位置，按 index 对会把备注和请假搅在一起。 */
      const left = useCols.filter((c) => !/^右栏·/.test(c.label));
      const right = useCols.filter((c) => /^右栏·/.test(c.label));
      const paired = left.map((lc) => {
        const twin = right.find((rc) => rc.type === lc.type
          && rc.label.replace(/^右栏·/, '') === lc.label.replace(/^左栏·/, ''));
        return twin;
      });
      if (paired.filter(Boolean).length === right.length) {
        useCols = left.map((lc) => {
          /* 落库的列定义要干净：左右栏的对应关系只在这次导入时用（mergeMap），
             不往库里的列定义上挂。 */
          return { key: lc.key, label: lc.label.replace(/^左栏·/, ''), type: lc.type, w: lc.w };
        });
        /* 合并关系单独留着，写 rows 时按 key 查，不走下标 */
        mergeMap = new Map(useCols.map((c, i) => [c.key, paired[i]?.key || null]));
      }
    }

    const rows = r.people.map((p) => {
      const data = {};
      if (type === r.type) {
        useCols.forEach((c) => {
          if (c.type !== 'check') return;
          const partner = mergeMap?.get(c.key);
          const hit = p.marks[c.key] || (partner && p.marks[partner]);
          if (hit) data[c.key] = '1';
        });
        // 请假 / 备注列单独带过去
        if (p.leave) data[`k_请假`] = '1';
        if (p.remark) data[`k_remark`] = p.remark;
      } else {
        /* 类型改了：把「签到」映射到目标表的第一个勾选列，其余丢掉 */
        const firstOld = checkCols[0]?.key;
        const firstNew = standard.find((c) => c.type === 'check')?.key;
        if (firstOld && firstNew && p.marks[firstOld]) data[firstNew] = '1';
        if (p.remark) data['k_remark'] = p.remark;
      }
      return { teacher: p.name, subject: p.subject, data };
    }).filter((x) => String(x.teacher || '').trim());

    if (!rows.length) throw new Error('没有读到任何教师姓名，请检查表格');

    const res = await api.post('/attendance/commit', {
      name, grade: g, sheet_type: type, sheet_date: date, periods: period,
      weekday: wd, columns: useCols, rows,
      source: 'upload', filename,
    });

    /* 原表留档：以后想核对「Excel 里到底怎么勾的」能翻出来。
       静态版把文件存 localStorage，单文件上限 1.5MB，超了就跳过并说清楚。 */
    try {
      const fd = new FormData();
      const blob = new Blob([JSON.stringify({ filename, sheet: ctx.sheetName || '', grid: ctx.grid })], { type: 'application/json' });
      fd.append('file', new File([blob], filename + '.raw.json', { type: 'application/json' }));
      fd.append('owner_type', 'attendance');
      fd.append('owner_id', String(res.table_id));
      await api.post('/upload', fd);
    } catch { /* 原表只是留档，存不上不影响导入 */ }

    sheetRef.close();
    toast(`已导入 ${res.added} 位教师${res.roster_added ? `，名册新增 ${res.roster_added} 人` : ''}`);
    reload();
    setTimeout(() => openTable(res.table_id, reload), 260);
  });
}

/* ================= 教师名册（按年级分开管） =================
 *
 * 老师的原话：「高一老师名册和高二所有老师名册分开，两个年级分开管理比较好」。
 * 所以这里不是一个长列表，而是一进来就在当前年级上，
 * 顶部的切换条跟主页面的 tab 一致，切过去看到的就是那个年级的人。
 */
function rosterSheet(grade, reload) {
  const body = el(`<div class="att-roster-sheet">
    <div class="ars-tabs" id="ars-tabs"></div>
    <div class="ars-add">
      <input class="input" id="ars-name" placeholder="姓名">
      <input class="input" id="ars-subj" list="subj-list2" placeholder="学科">
      <button class="btn primary sm" id="ars-add-btn">＋ 添加</button>
      <button class="btn ghost sm" id="ars-paste">粘贴</button>
      <button class="btn ghost sm" id="ars-xlsx">导入 Excel</button>
    </div>
    <datalist id="subj-list2">${SUBJECT_ORDER.map((x) => `<option>${x}</option>`).join('')}</datalist>
    <div class="ars-stats" id="ars-stats"></div>
    <div id="ars-list" class="ars-list"></div>
    <div class="confirm-actions"><button class="btn ghost" id="ars-close">关闭</button></div>
  </div>`);
  const s = sheet({ title: '教师名册', body, wide: true, cls: 'att-roster-dialog' });
  const $ = (x) => body.querySelector(x);
  let cur = grade || MAIN_GRADES[0];

  const load = async () => {
    const [g, list] = await Promise.all([api.get('/grades'), api.get('/teachers', { grade: cur, active: 'all' })]);
    const tabs = [...new Set([...MAIN_GRADES, ...(g.grades || [])])];
    const people = list.list || [];
    $('#ars-tabs').innerHTML = tabs.map((x) => `<button class="seg-btn${x === cur ? ' on' : ''}" data-g="${esc(x)}">${esc(x)} <span class="tiny muted">${g.counts?.[x] || 0}</span></button>`).join('');
    $('#ars-tabs').querySelectorAll('[data-g]').forEach((b) => {
      b.onclick = () => { cur = b.dataset.g; load(); };
    });
    const active = people.filter((p) => p.active);
    const subs = {};
    active.forEach((p) => { const k = p.subject || '未填学科'; subs[k] = (subs[k] || 0) + 1; });
    $('#ars-stats').innerHTML = `<span><b>${active.length}</b> 位在册</span>
      <span>${Object.keys(subs).length} 个学科</span>
      ${people.length - active.length ? `<span class="muted">${people.length - active.length} 位已调出</span>` : ''}`;

    /* 按学科分组显示：查一个学科的人一眼就能看到，跟纸表的分块一致 */
    if (!people.length) {
      $('#ars-list').innerHTML = `<div class="att-empty">「${esc(cur)}」还没有教师。可以直接导入 Excel 名册，或在上面一个个加。</div>`;
    } else {
      const groups = new Map();
      people.forEach((p) => {
        const k = p.subject || '未填学科';
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(p);
      });
      const sorted = [...groups.entries()].sort((a, b) => subjectRank(a[0]) - subjectRank(b[0]));
      $('#ars-list').innerHTML = sorted.map(([sj, list]) => `<div class="ars-group">
        <div class="arsg-head">${esc(sj)}<span class="tiny muted">${list.length} 人</span></div>
        ${list.map((p) => `<div class="ars-row${p.active ? '' : ' off'}">
          <input class="cell-in" data-id="${p.id}" data-k="name" value="${esc(p.name)}">
          <input class="cell-in subject-in" data-id="${p.id}" data-k="subject" value="${esc(p.subject || '')}" list="subj-list2">
          <button class="btn ghost sm" data-toggle="${p.id}" data-active="${p.active}">${p.active ? '调出' : '恢复'}</button>
          <button class="icon-btn sm" data-rm="${p.id}">${icon('close', 13)}</button>
        </div>`).join('')}
      </div>`).join('');
    }

    body.querySelectorAll('[data-toggle]').forEach((b) => {
      b.onclick = async () => { await api.patch('/teachers/' + b.dataset.toggle, { active: b.dataset.active ? 0 : 1 }); load(); };
    });
    body.querySelectorAll('[data-rm]').forEach((b) => {
      b.onclick = async () => {
        if (await confirmDialog('从名册删除这位教师？已有表格里的记录不受影响。')) { await api.del('/teachers/' + b.dataset.rm); load(); }
      };
    });
    body.querySelectorAll('.ars-row .cell-in').forEach((inp) => {
      inp.onchange = async () => {
        await api.patch('/teachers/' + inp.dataset.id, { [inp.dataset.k]: inp.value.trim() });
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
  $('#ars-paste').onclick = () => bulkDialog(cur, load);
  $('#ars-xlsx').onclick = () => rosterImportDialog(cur, load);
  $('#ars-close').onclick = () => { s.close(); reload?.(); };
  load();
}

/* 批量粘贴：从 Excel 里复制姓名+学科两列直接贴进来 */
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

/* 名册 Excel 导入：直接读一张「姓名 / 学科」的表 */
function rosterImportDialog(grade, reload) {
  const body = el(`<div class="sheet-body">
    <div class="att-drop" id="rdrop">
      <div class="ad-ico">${icon('upload', 24)}</div>
      <div class="ad-t">选一个 Excel 名册</div>
      <div class="ad-s">里面有一列「姓名」就够了，有「学科」更好</div>
      <input type="file" id="rfile" accept=".xlsx,.xlsm,.csv,.tsv,.txt" hidden>
    </div>
    <div class="att-tip-note">读到的人会加到「${esc(grade)}」名册里，重名的自动跳过。</div>
    <div class="confirm-actions"><button class="btn ghost" id="c">取消</button></div>
  </div>`);
  const s = sheet({ title: `导入「${grade}」名册`, body });
  const $ = (x) => body.querySelector(x);
  $('#rdrop').onclick = () => $('#rfile').click();
  $('#c').onclick = s.close;
  $('#rfile').onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    let grid;
    try { grid = (await readGrid(f)).grid; }
    catch (err) { return toast(err.message, 'err', 7000); }
    /* 找表头行：包含「姓名」的那一行；没有就当第一行就是数据 */
    const hIdx = grid.findIndex((row) => (row || []).some((c) => /姓名|名字|教师|老师/.test(String(c))));
    const head = hIdx >= 0 ? grid[hIdx] : null;
    const nCol = head ? head.findIndex((c) => /姓名|名字|教师|老师/.test(String(c))) : 0;
    const sCol = head ? head.findIndex((c) => /学科|科目/.test(String(c))) : 1;
    const items = [];
    for (let i = (head ? hIdx + 1 : 0); i < grid.length; i++) {
      const name = String(grid[i]?.[nCol] ?? '').trim();
      if (!name || !/^[\u4e00-\u9fa5a-zA-Z·]{2,10}$/.test(name)) continue;
      items.push({ name, subject: sCol >= 0 ? String(grid[i]?.[sCol] ?? '').trim() : '' });
    }
    if (!items.length) return toast('没读到姓名，检查一下这一列是不是文字', 'err', 6000);
    const res = await api.post('/teachers', { grade, items });
    s.close();
    toast(`导入 ${items.length} 人${res.skipped ? `，${res.skipped} 人已存在` : ''}`);
    reload();
  };
}

/* ================= 统计 ================= */
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
    <div class="confirm-actions"><button class="btn ghost" id="expd">导出 CSV</button></div></div>`);
  const s = sheet({ title: '学科统计', body, wide: true });
  body.querySelector('#expd').onclick = () => {
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

   现在的做法：**不用 DOM，直接拿 canvas 画表格**。
   位置全部按列宽/行高手算，文字用 fillText，勾叉用路径。
   好处是画布始终同源、一定能导出。 */
async function shotTable(id) {
  const t = await api.get('/attendance/' + id);
  const cols = (t.columns || []).filter((c) => c.type === 'check');
  const isSeat = (t.sheet_type || t.kind) === 'seat';
  const d = t.sheet_date ? new Date(t.sheet_date + 'T00:00:00') : null;
  const dateLine = d && !Number.isNaN(d.getTime())
    ? `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日　星期${WD[d.getDay()]}${t.periods ? '　第 ' + t.periods + ' 节' : ''}`
    : '';

  try {
    const blob = await renderSheetPng({ title: t.name, dateLine, rows: t.rows || [], cols, isSeat });
    const stamp = String(t.sheet_date || ymd()).replace(/-/g, '');
    saveBlob(blob, `${t.name}-${stamp}.png`);
    toast('图片已生成，可直接发群里');
  } catch (e) {
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
  const TOP = 96;
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

  const heads = ['序号', '姓名', '学科', ...cols.map((c) => c.label.replace(/^[左右]栏·/, ''))];
  const widths = [...colW, ...cols.map(() => chkW)];
  const left = (W - widths.reduce((a, b) => a + b, 0)) / 2;
  const top = PAD + TOP - PAD;

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

  ctx.font = `13px ${FONT}`;
  rows.forEach((r, ri) => {
    const y = top + HEAD_H + ri * ROW_H;
    if (ri % 2 === 1) {
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

  ctx.fillStyle = '#8e8e93';
  ctx.font = `11px ${FONT}`;
  ctx.fillText(
    `导出时间 ${new Date().toLocaleString('zh-CN')}　　✓ 已做　× 未做　空白 未填写`,
    W / 2, top + HEAD_H + rows.length * ROW_H + 24,
  );

  return new Promise((res, rej) => {
    cv.toBlob((b) => (b ? res(b) : rej(new Error('canvas 导出为空'))), 'image/png');
  });
}
