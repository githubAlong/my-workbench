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
import { taskImagePages, canvasToDataUrl, downloadCanvas } from './selfstudy-task-image.mjs';
import { cleanPeriodTime, normalizeTimetablePeriods, completeTimetablePeriods } from './timetable-periods.mjs';
import { AUTUMN_2026_SCHEDULE, resolveDefinitions } from './timetable-schedule.mjs';

/* 单独占一个视图名还保留着，是为了 #/selfstudy 这种老链接能落到正确的地方；
   实际渲染走 render() 里的 translate，这里只做兜底。 */
registerView(async function selfstudy(main, ctx) {
  main.innerHTML = pageHead('自习管理', '发布当节自习课的学习安排，学生端同步可见');
  const box = el('<div id="ss-body"></div>');
  main.appendChild(box);
  return renderSelfstudyBody(box, ctx);
});

export async function renderSelfstudyBody(box, ctx = {}) {
  /* 学生入口固定在自习管理页顶部；签到管理和教师自习记录仍可从原路由打开。 */
  const mode = ctx.studentTab ? 'student' : (ctx.mode || 'manage');
  const pane = el('<div></div>');
  box.innerHTML = '';
  if (mode === 'manage') {
    const entry = el('<div></div>');
    box.appendChild(entry);
    box.appendChild(pane);
    return Promise.all([
      renderStudentSelfstudy(entry, true),
      renderSelfstudyManage(pane),
    ]);
  }
  box.appendChild(pane);
  if (mode === 'student') return renderStudentSelfstudy(pane);
  return renderMySelfstudy(pane);
}

/* ---------- ① 自习管理（教师端发布页） ----------
   对应设计稿：左栏编辑任务，右栏任务列表 + PC 端开关，标题区右侧是发布入口。
   一条任务只对应一个班级范围；需要发多个班就新建多条。 */
function ssClsLabel(grade, cls) {
  const g = String(grade || '').trim();
  const c = String(cls || '').trim();
  if (!g) return c;
  if (!c) return g;
  return c.startsWith(g) ? c : g + c;
}

/* 班级只从课表/名单里取，界面不提供手动新增入口（需求 4.3 第五条） */
function ssClassOptions(courses, rosters) {
  const set = new Map();
  for (const r of rosters) {
    const label = ssClsLabel(r.grade, r.class_name);
    if (label) set.set(label, label);
  }
  for (const c of courses) {
    const label = ssClsLabel(c.grade, c.class_name);
    if (label) set.set(label, label);
  }
  return [...set.values()].sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true }));
}

function ssTaskStatus(task) {
  return task && task.status === 'published' ? 'published' : 'draft';
}

/* 截止时间统一取课表第六节的结束时间（精确到分），课表缺这一节时退回任务自己的节次 */
let ssDeadlineTime = '';
function ssDeadlineText(task) {
  const day = task.date === ymd(new Date()) ? '今日' : (task.date || '');
  return [day, ssDeadlineTime || task.period].filter(Boolean).join(' ');
}

/* 学生端卡片 HTML：教师端预览用，和学生页保持同一套 class 名（样式在 app.css） */
function ssStudentCard(task) {
  const raw = String(task.content || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const items = raw.map((line) => line.replace(/^\s*(?:\d+[.、)]|[-•])\s*/, '')).filter(Boolean);
  const body = items.length > 1
    ? `<ol class="st-list">${items.map((t) => `<li>${esc(t)}</li>`).join('')}</ol>`
    : `<div class="st-text">${esc(items[0] || task.content || '')}</div>`;
  const img = task.task_image || task.generated_image;
  return `<div class="st-card in-sheet">
    <div class="st-card-head">
      <div class="st-card-title">${esc(task.title || '今日自习任务')}</div>
    </div>
    <div class="st-card-body">${body}
      ${img ? `<img class="st-img" src="${esc(img)}" alt="任务图">` : ''}
    </div>
    <div class="st-meta">
      <span>教师：${esc(task.creator || state.user?.nickname || '老师')}</span>
      <span>任务类型：课堂自习</span>
      <span>截止时间：${esc(ssDeadlineText(task))}</span>
    </div>
    <div class="st-actions">
      <button class="st-btn ghost" disabled>查看任务</button>
      <button class="st-btn grad" disabled>保存任务图</button>
    </div>
  </div>`;
}

async function renderSelfstudyManage(box) {
  box.innerHTML = '<div class="empty">加载中…</div>';
  let tasks = [];
  let classes = [];
  let periods = [];
  try {
    const [rows, courses, rosters, periodRows, me] = await Promise.all([
      api.get('/selfstudy_tasks').catch(() => []),
      api.get('/courses').catch(() => []),
      api.get('/rosters').catch(() => []),
      api.get('/periods').catch(() => []),
      api.get('/me').catch(() => ({ settings: {} })),
    ]);
    tasks = rows;
    classes = ssClassOptions(courses, rosters);

    const parse = (value) => {
      if (value && typeof value === 'object') return value;
      try { return JSON.parse(value || '{}'); } catch { return {}; }
    };
    const preference = parse(localStorage.getItem('wb_timetable_view_v1'));
    const scheduleType = preference.type === '冬令时课表' ? '冬令时课表' : '夏令时课表';
    const timetable = parse(parse(me?.settings).timetable);
    const periodTimes = parse(timetable.periodTimes);
    const periodDefinitions = parse(timetable.periodDefinitions);
    const options = { periodTimes, scheduleType };
    const configured = resolveDefinitions(periodDefinitions, scheduleType, '全部');
    const normalized = normalizeTimetablePeriods(periodRows, options);
    const base = Array.isArray(configured) && configured.length
      ? [...configured].sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0))
      : (normalized.length ? normalized : AUTUMN_2026_SCHEDULE);
    const resolved = completeTimetablePeriods(base, courses, options);
    if (!Array.isArray(configured) || !configured.length) {
      resolved.sort((a, b) => Number(a.period_no) - Number(b.period_no));
    }
    periods = resolved.map((period) => {
      const override = periodTimes[scheduleType]?.[String(period.period_no)] || {};
      const start = cleanPeriodTime(override.start_time) || cleanPeriodTime(period.start_time);
      const end = cleanPeriodTime(override.end_time) || cleanPeriodTime(period.end_time);
      return {
        no: Number(period.period_no),
        name: String(period.name || `第${period.period_no}节`),
        end,
        time: start && end ? `${start}–${end}` : '',
      };
    });
    ssDeadlineTime = periods.find((p) => p.no === 6)?.end || '';
  } catch (e) {
    box.innerHTML = `<div class="empty">${esc(e.message || '加载失败')}</div>`;
    return;
  }

  const today = ymd(new Date());
  const defaultPeriod = periods.find((p) => p.name === '第3节')?.name || periods[0]?.name || '';
  let editingId = null;
  let errors = {};
  let busy = false;
  let savedAt = 0;
  let ddOpen = false;
  let form = {
    title: '今日自习任务', class_scope: 'all', class_label: '全部',
    date: today, period: defaultPeriod, content: '', task_image: '', generated_image: '',
  };

  const current = () => tasks.find((t) => String(t.id) === String(editingId)) || null;
  const isPublished = () => ssTaskStatus(current()) === 'published';
  const editingTask = () => ({ ...form, creator: state.user?.nickname || '老师', id: editingId });

  const loadTask = (t) => {
    editingId = t.id;
    errors = {};
    ddOpen = false;
    form = {
      title: t.title || '', class_scope: t.class_scope || 'all', class_label: t.class_label || '全部',
      date: t.date || today, period: t.period || defaultPeriod, content: t.content || '',
      task_image: t.task_image || '', generated_image: t.generated_image || '',
    };
    paint();
  };

  const validate = () => {
    const e = {};
    const title = form.title.trim();
    if (!title) e.title = '请填写任务标题';
    else if (title.length > 20) e.title = '任务标题最多 20 字';
    if (!form.class_label) e.class = '请选择适用班级';
    if (!form.date) e.time = '请选择自习日期';
    else if (!form.period) e.time = '请选择节次';
    if (!form.content.trim()) e.content = '请填写任务内容';
    else if (form.content.trim().length > 500) e.content = '任务内容最多 500 字';
    errors = e;
    paint();
    const first = box.querySelector('.ssm-input.is-err');
    first?.focus();
    return !Object.keys(e).length;
  };

  const payloadOf = (status) => ({
    title: form.title.trim(), class_scope: form.class_scope, class_label: form.class_label,
    date: form.date, period: form.period, content: form.content.trim(),
    task_image: form.task_image, generated_image: form.generated_image,
    status, creator: state.user?.nickname || '老师',
  });

  const upsert = async (status) => {
    const body = payloadOf(status);
    if (editingId) await api.patch('/selfstudy_tasks/' + editingId, body);
    else {
      const created = await api.post('/selfstudy_tasks', body);
      editingId = created.id;
    }
    tasks = await api.get('/selfstudy_tasks');
    errors = {};
  };

  const readImage = (file) => {
    if (!/^image\/(jpeg|png)$/.test(file.type)) return toast('只支持 JPG 或 PNG 图片', 'warn');
    if (file.size > 5 * 1024 * 1024) return toast('图片过大，请压缩后上传', 'warn');
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        /* 存原图 dataURL 会很快吃光 localStorage，这里按长边 900 压缩后再入库 */
        const scale = Math.min(1, 900 / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * scale);
        c.height = Math.round(img.height * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        form.task_image = c.toDataURL('image/jpeg', 0.82);
        paint();
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  };

  const generate = () => {
    const pages = taskImagePages({ ...editingTask(), school: state.user?.school || '' }, 'save');
    form.generated_image = canvasToDataUrl(pages[0]);
    paint();
    toast(`已生成任务图${pages.length > 1 ? `（共 ${pages.length} 页）` : ''}`);
  };

  const openPreview = () => {
    const body = el(`<div class="ssv-wrap">
      <div class="ssv-note">以下为学生端实际显示效果；未发布时学生看不到。</div>
      ${ssStudentCard(editingTask())}
      <div class="ssv-actions">
        <button class="ssm-btn" data-size="save">下载任务图 1080×1440</button>
        <button class="ssm-btn" data-size="screen">下载大屏图 1920×1080</button>
      </div>
    </div>`);
    const s = sheet({ title: '学生端预览', body, wide: true });
    body.querySelectorAll('[data-size]').forEach((b) => {
      b.onclick = () => {
        const pages = taskImagePages({ ...editingTask(), school: state.user?.school || '' }, b.dataset.size);
        pages.forEach((c, i) => downloadCanvas(c, `${form.title || '自习任务'}-${form.date || ''}-${i + 1}.png`));
      };
    });
    return s;
  };

  function paint() {
    const pub = isPublished();
    /* 保存成功后按钮自己亮 1.4 秒「已保存」：toast('已保存') 会被全局静默，见 core.js */
    const saved = Date.now() - savedAt < 1400;
    const list = tasks.slice().sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || (b.id - a.id));
    const clsOptions = [{ label: '全部', scope: 'all' }, ...classes.map((label) => ({ label, scope: label }))];

    box.innerHTML = `
      <div class="ssm-head">
        <div class="ssm-pub">
          <span class="ssm-pub-label">发布到学生端</span>
          <button class="ssm-pub-btn ${pub ? 'on' : ''}" id="ssm-pub">${pub ? '已发布' : '未发布'}</button>
        </div>
      </div>
      <div class="ssm-grid">
        <div class="ssm-card">
          <div class="ssm-card-title">编辑自习任务</div>

          <div class="ssm-field">
            <label class="ssm-label">任务标题<span class="req">*</span></label>
            <div class="ssm-ctl">
              <input class="ssm-input ${errors.title ? 'is-err' : ''}" id="ssm-title" maxlength="20" value="${esc(form.title)}" placeholder="如：今日自习任务">
              ${errors.title ? `<div class="ssm-err">${esc(errors.title)}</div>` : ''}
            </div>
          </div>

          <div class="ssm-field">
            <label class="ssm-label">适用班级<span class="req">*</span></label>
            <div class="ssm-ctl">
              <div class="ssm-dd ${ddOpen ? 'open' : ''}" id="ssm-dd">
                <button class="ssm-input ssm-dd-btn" id="ssm-dd-btn">
                  <span>${esc(form.class_label || '全部')}</span>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9.5 6 6 6-6"/></svg>
                </button>
                <div class="ssm-dd-panel">
                  ${clsOptions.map((o) => `<div class="ssm-dd-opt ${form.class_label === o.label ? 'on' : ''}" data-cls="${esc(o.label)}" data-scope="${esc(o.scope)}">${esc(o.label)}</div>`).join('')}
                  <div class="ssm-dd-foot">班级从课表中获取</div>
                </div>
              </div>
              ${errors.class ? `<div class="ssm-err">${esc(errors.class)}</div>` : ''}
            </div>
          </div>

          <div class="ssm-field">
            <label class="ssm-label">自习时间<span class="req">*</span></label>
            <div class="ssm-ctl">
              <div class="ssm-time">
                <input class="ssm-input ${errors.time ? 'is-err' : ''}" id="ssm-date" type="date" value="${esc(form.date)}">
                <select class="ssm-input" id="ssm-period">
                  ${form.period && !periods.some((p) => p.name === form.period) ? `<option value="${esc(form.period)}" selected>${esc(form.period)}</option>` : ''}
                  ${periods.map((p) => `<option value="${esc(p.name)}" ${form.period === p.name ? 'selected' : ''}>${esc(p.time ? `${p.name} · ${p.time}` : p.name)}</option>`).join('')}
                </select>
              </div>
              ${errors.time ? `<div class="ssm-err">${esc(errors.time)}</div>` : ''}
            </div>
          </div>

          <div class="ssm-field">
            <label class="ssm-label">任务内容<span class="req">*</span></label>
            <div class="ssm-ctl">
              <textarea class="ssm-input ${errors.content ? 'is-err' : ''}" id="ssm-content" rows="4" maxlength="500"
                placeholder="完成课本第56-58页练习题&#10;整理本节课错题">${esc(form.content)}</textarea>
              <div class="ssm-count ${form.content.length > 500 ? 'over' : ''}">${form.content.length} / 500</div>
              ${errors.content ? `<div class="ssm-err">${esc(errors.content)}</div>` : ''}
            </div>
          </div>

          <div class="ssm-imgs">
            <div class="ssm-img" id="ssm-up" title="上传任务图">
              ${form.task_image
                ? `<img src="${esc(form.task_image)}" alt="任务图">
                   <div class="ssm-img-ops"><span data-op="replace">替换</span><span data-op="remove">删除</span></div>`
                : `<div>${icon('upload', 22)}<div style="margin-top:6px">上传任务图</div></div>`}
            </div>
            <div class="ssm-img" id="ssm-gen" title="按当前内容生成任务图">
              ${form.generated_image
                ? `<img src="${esc(form.generated_image)}" alt="生成的任务图">`
                : `<div>${icon('file', 22)}<div style="margin-top:6px">生成PNG预览</div></div>`}
            </div>
          </div>
          <input type="file" id="ssm-file" accept="image/png,image/jpeg" class="hidden">

          <div class="ssm-actions">
            ${editingId ? '<button class="ssm-btn danger" id="ssm-del">删除</button>' : ''}
            <span style="flex:1"></span>
            <button class="ssm-btn${saved ? ' ok' : ''}" id="ssm-save" ${busy || saved ? 'disabled' : ''}>${saved ? '已保存' : '保存任务'}</button>
            <button class="ssm-btn primary" id="ssm-preview" ${busy ? 'disabled' : ''}>生成学生端预览</button>
          </div>
        </div>

        <div>
          <div class="ssm-card" style="margin-bottom:24px">
            <div class="ssm-card-title">自习任务列表</div>
            <div class="ssm-list">
              ${list.length ? list.map((t, index) => {
                const st = ssTaskStatus(t);
                return `<div class="ssm-item ${String(t.id) === String(editingId) ? 'on' : ''}" data-task="${t.id}">
                  <div class="ssm-item-no">${index + 1}</div>
                  <div class="ssm-item-ico">${icon('file', 16)}</div>
                  <div style="flex:1;min-width:0">
                    <div class="ssm-item-t">${esc(t.title || '未命名任务')}</div>
                    <div class="ssm-item-d">${esc(t.date || '')}</div>
                  </div>
                  <span class="ssm-tag ${st === 'published' ? 'pub' : 'draft'}">${st === 'published' ? '已发布' : '编辑中'}</span>
                </div>`;
              }).join('') : '<div class="empty" style="padding:20px">还没有任务，填好左侧内容后点「保存任务」</div>'}
            </div>
          </div>
        </div>
      </div>`;

    /* ---- 事件绑定 ---- */
    box.querySelector('#ssm-title').oninput = (e) => { form.title = e.target.value; };
    box.querySelector('#ssm-content').oninput = (e) => {
      form.content = e.target.value;
      const c = box.querySelector('.ssm-count');
      if (c) c.textContent = `${form.content.length} / 500`;
      c?.classList.toggle('over', form.content.length > 500);
    };
    box.querySelector('#ssm-date').onchange = (e) => { form.date = e.target.value; };
    box.querySelector('#ssm-period').onchange = (e) => { form.period = e.target.value; };

    box.querySelector('#ssm-dd-btn').onclick = (e) => {
      e.stopPropagation();
      ddOpen = !ddOpen;
      box.querySelector('#ssm-dd').classList.toggle('open', ddOpen);
    };
    box.querySelectorAll('[data-cls]').forEach((n) => {
      n.onclick = () => {
        form.class_label = n.dataset.cls;
        form.class_scope = n.dataset.scope;
        ddOpen = false;
        paint();
      };
    });

    box.querySelector('#ssm-up').onclick = (e) => {
      const op = e.target.closest('[data-op]')?.dataset.op;
      if (op === 'remove') { form.task_image = ''; paint(); return; }
      box.querySelector('#ssm-file').click();
    };
    box.querySelector('#ssm-file').onchange = (e) => {
      const f = e.target.files?.[0];
      if (f) readImage(f);
      e.target.value = '';
    };
    box.querySelector('#ssm-gen').onclick = () => {
      if (!form.title.trim() || !form.content.trim()) {
        toast('先填任务标题和内容，再生成预览图', 'warn');
        return;
      }
      generate();
    };

    box.querySelector('#ssm-save').onclick = async () => {
      if (busy || !validate()) return;
      busy = true;
      const btn = box.querySelector('#ssm-save');
      btn.disabled = true; btn.textContent = '保存中…';
      try {
        await upsert('draft');
        busy = false;
        /* 保存成功不能只靠 toast：'已保存' 属于全局静默文案（core.js 的
           SILENT_SAVE_MESSAGES），不弹提示，按钮又瞬间复原，用户会以为没点上。
           这里让按钮自己变成绿色「已保存」，停留 1.4 秒再恢复。 */
        savedAt = Date.now();
        paint();
        setTimeout(() => { if (box.isConnected) paint(); }, 1400);
        return;
      } catch (e) { toast(e.message || '保存失败', 'err'); }
      busy = false;
      paint();
    };

    box.querySelector('#ssm-preview').onclick = () => {
      if (!validate()) return;
      openPreview();
    };

    box.querySelector('#ssm-pub').onclick = async () => {
      if (busy) return;
      if (isPublished()) {
        busy = true;
        try {
          await upsert('closed');
          toast('已关闭，学生端不再显示');
        } catch (e) { toast(e.message || '操作失败', 'err'); }
        busy = false;
        paint();
        return;
      }
      if (!validate()) return;
      busy = true;
      try {
        await upsert('published');
        toast('已发布到学生端');
      } catch (e) { toast(e.message || '发布失败', 'err'); }
      busy = false;
      paint();
    };

    box.querySelectorAll('[data-task]').forEach((n) => {
      n.onclick = () => {
        const t = tasks.find((x) => String(x.id) === String(n.dataset.task));
        if (t) loadTask(t);
      };
    });

    box.querySelector('#ssm-del')?.addEventListener('click', async () => {
      if (!editingId) return;
      if (!await confirmDialog('删除这条自习任务？删除后学生端立即不再显示。')) return;
      try {
        await api.del('/selfstudy_tasks/' + editingId);
        tasks = await api.get('/selfstudy_tasks');
        editingId = null;
        form = { ...form, title: '今日自习任务', class_scope: 'all', class_label: '全部', content: '', task_image: '', generated_image: '' };
        toast('已删除');
        paint();
      } catch (e) { toast(e.message || '删除失败', 'err'); }
    });

    /* 下拉点空白收起：只在面板打开时挂一次，交给下一次点击自然结束 */
    box.querySelector('#ssm-dd').addEventListener('click', (e) => e.stopPropagation());
    if (ddOpen) {
      setTimeout(() => {
        const off = () => { ddOpen = false; box.querySelector('#ssm-dd')?.classList.remove('open'); document.removeEventListener('click', off); };
        document.addEventListener('click', off);
      }, 0);
    }
  }
  paint();
}

/* ---------- ② 学生页面里的自习模块 ----------
   学生打开短链后，如果老师开了自习签到，顶部会出现「签到」页，点「我到了」。
   老师这边能做的只有三件事：开一场、看谁到了、结束。
   配置项（是否需要学生填姓名、是否允许迟到）存在 link.settings 上。 */
async function renderStudentSelfstudy(box, entryOnly = false) {
  const links = await api.get('/links').catch(() => []);
  const [sessions, rosters] = entryOnly ? [[], []] : await Promise.all([
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
             <a class="btn ghost sm" href="${esc(studentUrl(link.code, 'tab=selfstudy'))}" target="_blank" rel="noopener">打开看看</a>
           </div>
           <div class="field-hint" style="margin-top:8px">学生打开这个链接，发布任务后顶部会出现「自习」页；没有进行中的签到时，页面会显示「现在没有在进行的签到」。</div>`
      : `<div class="empty" style="padding:18px">还没有生成学生链接。<button class="btn primary sm" id="ss-mklink">生成一条</button></div>`}
    </div>
    ${entryOnly ? '' : `
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

    <div class="card" id="ss-sess">${open.length || today.length ? '' : '<div class="empty">今天还没有自习签到</div>'}</div>`}
  `;

  box.querySelector('#ss-copy')?.addEventListener('click', async () => {
    const url = studentUrl(link.code, 'tab=selfstudy');
    try { await navigator.clipboard.writeText(url); toast('已复制，发到班级群就行'); } catch { prompt('复制下面的链接', url); }
  });
  box.querySelector('#ss-mklink')?.addEventListener('click', async () => {
    await api.post('/links', { title: '班级资料站' }).catch(() => { });
    renderStudentSelfstudy(box, entryOnly);
  });
  if (entryOnly) return;
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
