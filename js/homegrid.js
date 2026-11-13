/* ============================================================================
   首页栅格布局（12 列 · 拖拽 / 缩放 / 隐藏 / 多端保存）

   【为什么自己写，不引 react-grid-layout】
   这套工作台是零依赖的静态站：拷到任何静态托管就能跑，不需要 npm install。
   为了一个首页布局去引进一个几十 KB 的框架 + 它的 React 依赖，
   和「打开就能用」这个前提冲突。所以这里只实现真正需要的那部分：
   12 列栅格、拖一格吸附一格、互相让位、不让重叠。

   【为什么不用 CSS Grid 的自动排列，而要自己算 x/y】
   自动排列（grid-auto-flow）只能决定「下一个放哪」，
   做不到「把这张卡放到第 8 列第 3 行」，也做不到「别人给它让位」。
   所以卡片位置一律由数据决定，DOM 只是照着写 style。
   好处是：布局可以整个存成 JSON、可以从云端读回来、
   断了网重建 DOM 之后还能一模一样地摆回去。

   【三套断点分别存】
   desktop / tablet / mobile 各存一份。手机不做「把桌面布局等比压缩」——
   12 列压到手机宽度上，每列只有 20px，卡片全被挤成窄条。
   手机上强制单列、按顺序堆叠，和桌面互不干扰；
   隐藏/显示是用户意图，三套共享同一份 hidden。

   【移动端不给拖拽】
   单列布局里拖拽只能改顺序，但手指在长页面上拖卡片和滚页面
   天生冲突（拖一下就滚不动了），得不偿失。手机上保留隐藏/显示即可。
   ========================================================================== */

import { el, esc, toast, confirmDialog, sheet } from './core.js';
import { state, icon } from './ui.js';
import {
  HOME_LAYOUT_CARDS,
  readHomeLayoutFromSnapshot,
  selectHomeLayoutCandidate,
  homeLayoutErrorCode,
} from './home-layout-migration.mjs';
import {
  saveHomeLayoutToAccount,
  migrateLegacyHomeLayout,
  adoptAccountHomeLayout,
} from './cloudsync.js';

export const COLS = 12;
const ROW_H = 68;      /* 新首页卡片基准行高；h=3 就是 3 行 */
const GAP = 14;        /* 卡片间距，和 CSS 里的 gap 必须一致 */

const BP = {
  desktop: 1180,
  tablet: 860,
};

/* 卡片清单与安全验证器共用同一份真实白名单。 */
export const CARDS = HOME_LAYOUT_CARDS;
const CARD_MAP = new Map(CARDS.map((c) => [c.id, c]));
export const cardTitle = (id) => CARD_MAP.get(id)?.title || id;

/* 默认布局：和需求里的那张图一一对应
     第一行：个人信息 / 每日一句 / 天气
     第二行：今日事项 / 今日课程 / 日历 */
const DEFAULTS = {
  desktop: [
    ['timeline', 0, 0, 7, 2], ['profile', 7, 0, 5, 2],
    ['todayCourse', 0, 2, 7, 4], ['weather', 7, 2, 5, 2],
    ['todayTodo', 0, 6, 4, 3], ['dailyQuote', 4, 6, 3, 3],
    ['calendar', 7, 4, 5, 5],
    ['weekLessons', 0, 9, 3, 2], ['invigilation', 3, 9, 3, 2],
    ['prepDeadline', 6, 9, 3, 2], ['recentNotes', 9, 9, 3, 2],
  ],
  tablet: [
    ['timeline', 0, 0, 6, 3], ['profile', 6, 0, 6, 3],
    ['todayCourse', 0, 3, 6, 4], ['weather', 6, 3, 6, 3],
    ['todayTodo', 0, 7, 6, 4], ['dailyQuote', 6, 6, 6, 3],
    ['calendar', 6, 9, 6, 5],
    ['weekLessons', 0, 11, 3, 2], ['invigilation', 3, 11, 3, 2],
    ['prepDeadline', 0, 13, 6, 2], ['recentNotes', 6, 14, 6, 2],
  ],
  mobile: [
    ['timeline', 0, 0, 12, 3], ['profile', 0, 3, 12, 3],
    ['todayCourse', 0, 6, 12, 5], ['weather', 0, 11, 12, 3],
    ['todayTodo', 0, 14, 12, 5], ['dailyQuote', 0, 19, 12, 3],
    ['calendar', 0, 22, 12, 6],
    ['weekLessons', 0, 28, 12, 2], ['invigilation', 0, 30, 12, 2],
    ['prepDeadline', 0, 32, 12, 2], ['recentNotes', 0, 34, 12, 2],
  ],
};

function defaultSeg(bp) {
  return {
    layout: DEFAULTS[bp].map(([id, x, y, w, h]) => ({ id, x, y, w, h })),
    hidden: [],
  };
}

export function defaultState() {
  return {
    version: 2,
    /* 【为什么这里是空串而不是 new Date()】
       updatedAt 用来判断「云端和本地谁更新」。如果默认状态取"现在"，
       那一个从没排过布局的新设备，其本地时间会被误认为比云端那次保存更晚，
       从而拒绝采用账号快照里的布局 ——
       换台电脑登录，看到的永远是默认排布，多端同步等于没有。
       空串表示「从未保存过」，Date.parse('') 得到 NaN，比较时按 0 处理。 */
    updatedAt: '',
    breakpoints: {
      desktop: defaultSeg('desktop'),
      tablet: defaultSeg('tablet'),
      mobile: defaultSeg('mobile'),
    },
  };
}

/* ---------------- 几何 ---------------- */

const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/* 把一叠卡片压实：按 y/x 排序，依次往上找第一个不压人的位置。
   隐藏掉中间某张卡之后，下面的卡会自动补上来，不会留一个空洞。 */
function compact(list) {
  const sorted = [...list].sort((a, b) => a.y - b.y || a.x - b.x);
  const placed = [];
  for (const it of sorted) {
    let y = 0;
    let guard = 0;
    while (placed.some((p) => overlap({ ...it, y }, p)) && guard++ < 200) y += 1;
    it.y = y;
    placed.push(it);
  }
  return list;
}

/* 让位：被拖动/缩放的那张卡就地占住目标格，其余卡片只往下让。
   为什么一律往下：往上让会把用户没碰过的卡片顶到别处，
   视觉上像是「我什么都没动，页面自己乱了」。往下让符合直觉。 */
function resolve(list, fixedId) {
  const fixed = list.find((i) => i.id === fixedId);
  if (!fixed) return list;
  const placed = [fixed];
  const others = list.filter((i) => i.id !== fixedId).sort((a, b) => a.y - b.y || a.x - b.x);
  for (const it of others) {
    let y = it.y;
    let moved = true;
    let guard = 0;
    while (moved && guard++ < 200) {
      moved = false;
      for (const p of placed) {
        if (overlap({ ...it, y }, p)) { y = p.y + p.h; moved = true; }
      }
    }
    it.y = y;
    placed.push(it);
  }
  return list;
}

/* ---------------- 断点 ---------------- */

export function currentBp() {
  const w = typeof window !== 'undefined' ? window.innerWidth : 1440;
  if (w >= BP.desktop) return 'desktop';
  if (w >= BP.tablet) return 'tablet';
  return 'mobile';
}
export const isMobile = () => currentBp() === 'mobile';

/* ---------------- 状态 ---------------- */

/* 布局存在账号 settings.homeLayout 里：跟着账号快照走。
   旧 wb_sync 仅用于一次性只读迁移，不再作为日常写入来源。 */
const SETTING_KEY = 'homeLayout';
const DRAFT_KEY = 'wb_home_layout_draft';

let ST = null;      /* 已保存的布局 */
let draft = null;   /* 编辑中的草稿 */
let editing = false;
let gridEl = null;
const bound = [];
let offResize = null;

/* 校验从磁盘/云端读回来的数据：不认识的卡片丢掉、缺的补回默认、
   坐标越界就夹回来。布局坏了顶多回到默认，不能让首页打不开。 */
function normalize(raw) {
  const out = defaultState();
  if (!raw || typeof raw !== 'object' || !raw.breakpoints) return out;
  const rawVersion = Number(raw.version) || 1;
  if (rawVersion < 2) {
    const hidden = [...new Set((raw.breakpoints.desktop?.hidden || []).map(String).filter((id) => CARD_MAP.has(id)))];
    for (const bp of Object.keys(out.breakpoints)) out.breakpoints[bp].hidden = hidden;
    out.updatedAt = raw.updatedAt || '';
    return out;
  }
  out.version = rawVersion;
  out.updatedAt = raw.updatedAt || out.updatedAt;
  for (const bp of Object.keys(out.breakpoints)) {
    const seg = raw.breakpoints[bp];
    if (!seg || typeof seg !== 'object') continue;
    const seen = new Set();
    const layout = [];
    for (const it of Array.isArray(seg.layout) ? seg.layout : []) {
      const meta = CARD_MAP.get(String(it?.id || ''));
      if (!meta || seen.has(meta.id)) continue;
      seen.add(meta.id);
      const w = clamp(Math.round(Number(it.w) || meta.minW), meta.minW, COLS);
      const h = Math.max(2, Math.round(Number(it.h) || 3));
      layout.push({
        id: meta.id,
        x: clamp(Math.round(Number(it.x) || 0), 0, COLS - w),
        y: Math.max(0, Math.round(Number(it.y) || 0)),
        w,
        h,
      });
    }
    /* 少了的卡片按默认位置补上：升级后新增卡片不会「凭空消失」 */
    for (const [id, x, y, w, h] of DEFAULTS[bp]) {
      if (!seen.has(id)) layout.push({ id, x, y, w, h });
    }
    const hidden = (Array.isArray(seg.hidden) ? seg.hidden : [])
      .map(String).filter((id) => CARD_MAP.has(id));
    out.breakpoints[bp] = { layout: resolve(layout, layout[0]?.id), hidden: [...new Set(hidden)] };
  }
  /* hidden 三端共享：以 desktop 那一份为准，其余两套跟着走。
     老数据里三套可能不一致（早期版本按断点各存一份），这里统一收口。 */
  const baseHidden = out.breakpoints.desktop.hidden;
  for (const bp of Object.keys(out.breakpoints)) {
    out.breakpoints[bp].hidden = [...baseHidden];
  }
  return out;
}

export function readState() {
  const raw = state.user?.settings?.[SETTING_KEY];
  return normalize(raw);
}

function ensure() {
  if (!ST) ST = readState();
  return ST;
}

function rememberLayout(layout) {
  ST = layout;
  if (state.user) {
    state.user = {
      ...state.user,
      settings: { ...(state.user.settings || {}), [SETTING_KEY]: layout },
    };
  }
}

const clone = (v) => JSON.parse(JSON.stringify(v));
const segOf = (st, bp = currentBp()) => st.breakpoints[bp] || st.breakpoints.desktop;

/* 当前应该照着画的那份数据：编辑中用草稿，平时用已保存的 */
function activeSeg() {
  return segOf(draft && editing ? draft : ensure());
}

/* ---------------- 渲染 ---------------- */

function paint() {
  if (!gridEl) return;
  const bp = currentBp();
  const seg = activeSeg();
  const hidden = new Set(seg.hidden || []);
  const mobile = bp === 'mobile';

  /* 手机：单列，按 layout 的顺序从上往下堆。x/w 不参与，
     否则用户从桌面切过来会看到一堆半宽卡片。 */
  let view = seg.layout.map((i) => ({ ...i }));
  if (mobile) {
    view = view.map((i) => ({ ...i, x: 0, w: COLS }));
    compact(view);
  }

  const byId = new Map(view.map((i) => [i.id, i]));
  for (const item of gridEl.querySelectorAll('[data-hcard]')) {
    const id = item.dataset.hcard;
    const pos = byId.get(id);
    const isHidden = hidden.has(id) || !pos;
    item.hidden = isHidden;
    if (isHidden) continue;
    if (mobile) {
      item.style.gridColumn = '1 / -1';
      item.style.gridRow = 'auto';
    } else {
      item.style.gridColumn = `${pos.x + 1} / span ${pos.w}`;
      item.style.gridRow = `${pos.y + 1} / span ${pos.h}`;
    }
    /* 隐藏按钮只对「当前可见」的卡片有意义 */
    const hb = item.querySelector('[data-hg-hide]');
    if (hb) hb.hidden = false;
  }

  /* 网格容器在手机上要退回 auto 行高，否则卡片被固定成 64px 一行 */
  gridEl.classList.toggle('hg-mobile', mobile);
  gridEl.style.gridAutoRows = mobile ? 'auto' : `${ROW_H}px`;

  paintToolbar();
}

function paintToolbar() {
  const bar = document.getElementById('hg-toolbar');
  if (bar) bar.hidden = !editing;
  const mobile = currentBp() === 'mobile';
  document.body.classList.toggle('hg-edit', editing);
  document.body.classList.toggle('hg-edit-mobile', editing && mobile);
  const btn = document.getElementById('teacher-layout');
  if (btn) {
    btn.innerHTML = `${icon(editing ? 'close' : 'edit', 16)}<span>${editing ? '退出编辑' : '编辑布局'}</span>`;
    btn.setAttribute('aria-pressed', String(editing));
    btn.title = editing ? '退出首页布局编辑' : '调整首页卡片位置、大小和显示';
    btn.classList.toggle('is-active', editing);
  }
  /* 手机上是单列，拖拽和缩放都没有意义（手柄也藏起来了），
     文案要说清楚这一步能干什么，否则用户会一直找拖拽柄。 */
  const hint = document.querySelector('.hg-tb-hint');
  if (hint) {
    hint.textContent = mobile
      ? '手机上按单列排列 · 可隐藏 / 显示卡片，桌面端排的位置不受影响'
      : '拖动卡片换位置 · 拖右下角调大小';
  }
}

/* ---------------- 拖拽 / 缩放 ---------------- */

const stepX = () => {
  if (!gridEl) return 0;
  const w = gridEl.clientWidth || 1;
  return (w - GAP * (COLS - 1)) / COLS + GAP;
};
const stepY = () => ROW_H + GAP;

function beginEdit() {
  if (editing) return;
  ensure();
  draft = clone(ST);
  editing = true;
  paint();
  toast('拖动卡片可换位置，拖右下角可调整大小', 'ok', 3500);
}

function cancelEdit() {
  if (!editing) return;
  editing = false;
  draft = null;
  paint();
  toast('已取消，布局回到保存前的样子');
}

/* 保存：显式点按钮才提交。
   自动保存看着省事，但拖拽是试错型操作 —— 用户拖两下不满意想撤回，
   自动保存已经把中间态写进账号了。第一版按需求走显式保存。 */
async function saveEdit() {
  if (!editing || !draft) return;
  const btn = document.getElementById('hg-save');
  if (btn) { btn.disabled = true; btn.textContent = '保存中…'; }
  const payload = {
    version: (Number(ST?.version) || 1) + 1,
    updatedAt: new Date().toISOString(),
    breakpoints: draft.breakpoints,
  };
  try {
    const result = await saveHomeLayoutToAccount(payload);
    if (!result.localSaved) throw result.error || new Error('布局没有保存到本机');
    if (result.status === 'conflict') {
      const selected = await resolveLayoutConflict(result.analysis, {
        title: '布局保存冲突',
        description: '另一台设备也更新了首页布局。本机刚才保存的布局已经保留，请明确选择云端要使用哪一份。',
      });
      editing = false;
      draft = null;
      localStorage.removeItem(DRAFT_KEY);
      rememberLayout(selected?.layout || payload);
      paint();
      toast(selected
        ? '布局冲突已处理'
        : '已保留本机布局，云端版本未改动', selected ? 'ok' : 'warn', 7000);
      return;
    }
    editing = false;
    draft = null;
    localStorage.removeItem(DRAFT_KEY);
    rememberLayout(payload);
    paint();
    if (result.status === 'saved' || result.status === 'confirmed') toast('布局已保存并同步', 'ok');
    else toast('布局已保存在本机，云端暂未确认；稍后再保存一次即可重试', 'warn', 7000);
  } catch (e) {
    /* 保存失败时把草稿留在本机，刷新之后还能捡回来 */
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ at: Date.now(), draft })); } catch { }
    toast('保存失败：' + (e.message || e) + '。草稿已留在本机，可再点一次保存', 'err', 9000);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '保存布局'; }
  }
}

async function resetAll() {
  if (!(await confirmDialog('恢复到默认布局？当前自己排的位置会被清掉。'))) return;
  /* 恢复默认也要带真实时间戳：它是一次「用户主动的保存」，
     应该能同步到另一台设备，而不是被别的设备当成旧数据忽略掉。 */
  const st = { ...defaultState(), updatedAt: new Date().toISOString(), version: (Number(ST?.version) || 1) + 1 };
  try {
    const result = await saveHomeLayoutToAccount(st);
    if (!result.localSaved) throw result.error || new Error('布局没有保存到本机');
    if (result.status === 'conflict') {
      const selected = await resolveLayoutConflict(result.analysis, {
        title: '恢复默认布局冲突',
        description: '另一台设备也更新了首页布局。请明确选择云端要使用哪一份。',
      });
      if (editing) { editing = false; draft = null; }
      localStorage.removeItem(DRAFT_KEY);
      rememberLayout(selected?.layout || st);
      paint();
      toast(selected ? '布局冲突已处理' : '已保留本机默认布局，云端版本未改动', selected ? 'ok' : 'warn', 7000);
      return;
    }
    if (editing) { editing = false; draft = null; }
    localStorage.removeItem(DRAFT_KEY);
    rememberLayout(st);
    paint();
    if (result.status === 'saved' || result.status === 'confirmed') toast('已恢复默认布局并同步', 'ok');
    else toast('已恢复默认布局并保存在本机，云端暂未确认', 'warn', 7000);
  } catch (e) {
    toast('恢复失败：' + (e.message || e), 'err');
  }
}

/* 隐藏/显示：三套断点同步。
   需求里写了「隐藏状态同步」—— 用户在电脑上关掉日历，
   拿起手机不该又冒出来。所以这里一次改三套，
   而不是只改当前断点那一套。 */
function setHidden(id, off) {
  for (const bp of Object.keys(draft.breakpoints)) {
    const seg = draft.breakpoints[bp];
    const has = seg.hidden.includes(id);
    if (off && !has) seg.hidden.push(id);
    if (!off && has) seg.hidden = seg.hidden.filter((x) => x !== id);
  }
}

function hideCard(id) {
  const seg = segOf(draft);
  const visible = seg.layout.filter((i) => !seg.hidden.includes(i.id));
  if (visible.length <= 1 && !seg.hidden.includes(id)) {
    toast('至少留一张卡片，不然首页就空了', 'warn');
    return;
  }
  if (!seg.hidden.includes(id)) setHidden(id, true);
  paint();
}

function showCard(id) {
  setHidden(id, false);
  paint();
}

/* 绑定一次指针手势，供拖拽和缩放共用。
   桌面和触屏都走 Pointer Events：一套代码，不用为 iOS 再写一遍。 */
function bindGesture(grid) {
  let g = null; /* 当前手势 */

  const onDown = (e) => {
    if (!editing) return;
    if (currentBp() === 'mobile') return;
    const item = e.target.closest('[data-hcard]');
    if (!item) return;
    const isResize = !!e.target.closest('[data-hg-resize]');
    const isGrip = !!e.target.closest('[data-hg-grip]');
    if (!isResize && !isGrip) return;

    const seg = segOf(draft);
    const pos = seg.layout.find((i) => i.id === item.dataset.hcard);
    if (!pos) return;

    e.preventDefault();
    g = {
      item, pos, isResize,
      startX: e.clientX, startY: e.clientY,
      orig: { ...pos },
      id: pos.id,
    };
    item.classList.add(isResize ? 'hg-resizing' : 'hg-dragging');
    document.body.classList.add('hg-gesture');
    /* 指针捕获：手指/鼠标滑出卡片范围也要继续跟手 */
    try { e.target.setPointerCapture?.(e.pointerId); } catch { }
  };

  const onMove = (e) => {
    if (!g) return;
    const sx = stepX();
    const sy = stepY();
    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;
    const dCol = Math.round(dx / sx);
    const dRow = Math.round(dy / sy);
    const seg = segOf(draft);
    const cur = seg.layout.find((i) => i.id === g.id);
    if (!cur) return;

    if (g.isResize) {
      const meta = CARD_MAP.get(g.id);
      const w = clamp(g.orig.w + dCol, meta.minW, COLS - g.orig.x);
      const h = Math.max(meta.minH, g.orig.h + dRow);
      if (w === cur.w && h === cur.h) return;
      cur.w = w;
      cur.h = h;
    } else {
      const x = clamp(g.orig.x + dCol, 0, COLS - g.orig.w);
      const y = Math.max(0, g.orig.y + dRow);
      if (x === cur.x && y === cur.y) return;
      cur.x = x;
      cur.y = y;
    }
    resolve(seg.layout, g.id);
    paint();
  };

  const onUp = () => {
    if (!g) return;
    g.item.classList.remove('hg-dragging', 'hg-resizing');
    document.body.classList.remove('hg-gesture');
    const seg = segOf(draft);
    compact(seg.layout);
    paint();
    g = null;
  };

  grid.addEventListener('pointerdown', onDown);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
  bound.push(() => {
    grid.removeEventListener('pointerdown', onDown);
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
  });
}

/* ---------------- 卡片管理 ---------------- */

function openManager() {
  if (!draft) return;
  const seg = segOf(draft);
  const rows = CARDS.map((c) => {
    const off = seg.hidden.includes(c.id);
    return `<div class="hg-mrow" data-id="${c.id}">
      <span class="hg-mname">${esc(c.title)}</span>
      <span class="hg-mstate ${off ? 'off' : 'on'}">${off ? '已隐藏' : '显示中'}</span>
      <button class="btn ghost sm" data-hg-toggle="${c.id}">${off ? '显示' : '隐藏'}</button>
    </div>`;
  }).join('');

  const body = el(`<div class="sheet-body">
    <div class="tiny muted" style="line-height:1.7;margin-bottom:10px">
      隐藏只是不显示，位置和配置都留着，随时可以再打开。至少保留一张。
    </div>
    <div class="hg-mlist">${rows}</div>
  </div>`);

  /* 这里不引入 core.sheet：卡片管理是个短面板，
     自己搭一层遮罩就够，省得和 home.js 里那套弹层样式互相影响。 */
  const mask = el(`<div class="sheet-mask"><div class="sheet">
    <div class="sheet-head"><div class="sheet-title">卡片管理</div>
      <button class="icon-btn sheet-close" aria-label="关闭">✕</button></div>
  </div></div>`);
  mask.querySelector('.sheet').appendChild(body);
  document.body.appendChild(mask);
  requestAnimationFrame(() => mask.classList.add('in'));

  const close = () => { mask.classList.remove('in'); setTimeout(() => mask.remove(), 200); };
  mask.querySelector('.sheet-close').onclick = close;
  mask.addEventListener('click', (e) => { if (e.target === mask) close(); });

  body.querySelectorAll('[data-hg-toggle]').forEach((b) => {
    b.onclick = () => {
      const id = b.dataset.hgToggle;
      if (segOf(draft).hidden.includes(id)) showCard(id); else hideCard(id);
      close();
      openManager();
    };
  });
}

/* ---------------- 旧布局安全迁移 ---------------- */

async function chooseLayoutConflict(analysis) {
  const labels = { local: '本机当前布局', snapshot: '账号快照布局', legacy: '旧设备布局' };
  const choices = (analysis?.choices || []).filter((item) => labels[item.source]);
  if (choices.length < 2) return false;
  const body = el(`<div class="sheet-body">
    <div class="small muted" style="line-height:1.7;margin-bottom:12px">
      发现多个不同的首页布局。系统不会自动覆盖任何版本，请明确选择一个作为账号布局。
    </div>
    <div class="col">${choices.map((item) => `<button class="btn ghost block" data-layout-choice="${item.source}">
      <b>${labels[item.source]}</b>
      <span class="tiny muted">记录时间：${esc(item.updatedAt || '未知')}<br>内容标识：${esc(item.checksum)}</span>
    </button>`).join('')}</div>
    <div class="small muted" style="margin-top:10px">取消会保留本机、账号快照和旧布局现状。</div>
  </div>`);
  const source = await new Promise((resolve) => {
    const sh = sheet({
      title: '选择首页布局版本',
      body,
      onClose: () => resolve(''),
    });
    body.querySelectorAll('[data-layout-choice]').forEach((btn) => {
      btn.onclick = () => {
        const selected = btn.dataset.layoutChoice;
        sh.close();
        resolve(selected);
      };
    });
  });
  if (!source) return false;
  let selected;
  try {
    selected = selectHomeLayoutCandidate(analysis, source);
  } catch {
    return false;
  }
  const result = await saveHomeLayoutToAccount(selected, { normalizer: normalize });
  if (!result.localSaved) {
    toast(result.error?.message || '所选布局没有保存，现有版本均未删除', 'err', 8000);
    return false;
  }
  rememberLayout(selected);
  paint();
  toast(result.status === 'saved' || result.status === 'confirmed'
    ? '已采用所选首页布局'
    : '所选布局已保存在本机，云端暂未确认', result.status === 'saved' || result.status === 'confirmed' ? 'ok' : 'warn', 7000);
  return true;
}

/* 登录后只读当前用户的旧布局；不传 UID、不传 key，也不删除旧数据。 */
export async function migrateLegacyLayout() {
  const result = await migrateLegacyHomeLayout({
    normalizer: normalize,
    hasUnsavedDraft: !!(draft || editing),
  });
  if (result.status === 'conflict') {
    await chooseLayoutConflict(result.analysis);
    return result;
  }
  if ((result.status === 'saved' || result.status === 'confirmed') && result.markerWritten) {
    const layout = readHomeLayoutFromSnapshot(result.payload, normalize);
    if (layout) {
      rememberLayout(layout);
      paint();
      toast(result.status === 'saved' ? '首页布局已安全迁移到账号' : '首页布局已确认同步', 'ok', 4500);
    }
  } else if (result.status === 'failed') {
    console.warn('[home-layout] 旧布局迁移未完成，本机布局和旧数据均保留', result.error || result.reason || '');
  }
  return result;
}

/* ---------------- 对外接口 ---------------- */

function unbind() {
  while (bound.length) { try { bound.pop()(); } catch { } }
}

/* 首页每次重建 DOM 后都要调一次：把卡片摆回去、重新绑手势。
   不调的话，任何一次刷新（记一笔便签、换城市）都会把布局冲回默认。 */
export function mount(grid) {
  unbind();
  gridEl = grid;
  /* 每次整页重建都从最新的账号快照重读；编辑中的局部重绘才保留 ST。 */
  if (editing) ensure();
  else ST = readState();
  /* 跨断点时重画一次。只注册一次 —— mount 会随首页重绘反复调用，
     每次都 new 一个 resize 监听的话，拖窗口就会触发十几个重排。 */
  if (!offResize) offResize = watchBreakpoint();

  /* 上次保存失败的草稿：不自动套用（可能是过期数据），
     但要留个入口让用户能捡回来 */
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (raw) {
      const d = JSON.parse(raw);
      if (d?.draft?.breakpoints && Date.now() - Number(d.at || 0) < 7 * 864e5) {
        setTimeout(() => {
          toast('上次有未保存的布局草稿，可在「编辑布局」里重新调整后保存', 'warn', 6000);
        }, 1200);
      }
    }
  } catch { }

  paint();
  bindGesture(grid);

  const btn = document.getElementById('teacher-layout');
  if (btn) {
    btn.onclick = () => {
      if (editing) cancelEdit();
      else beginEdit();
    };
  }
  const q = (s) => document.getElementById(s);
  if (q('hg-save')) q('hg-save').onclick = saveEdit;
  if (q('hg-cancel')) q('hg-cancel').onclick = cancelEdit;
  if (q('hg-reset')) q('hg-reset').onclick = resetAll;
  if (q('hg-manage')) q('hg-manage').onclick = openManager;

  grid.querySelectorAll('[data-hg-hide]').forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      hideCard(b.closest('[data-hcard]').dataset.hcard);
    };
  });
}

export function unmount() {
  unbind();
  gridEl = null;
}

/* 屏幕宽度跨过断点时重画：位置数据不用动，换一套读写即可 */
export function watchBreakpoint() {
  let last = currentBp();
  const onResize = () => {
    const bp = currentBp();
    if (bp === last) return;
    last = bp;
    paint();
  };
  window.addEventListener('resize', onResize);
  return () => window.removeEventListener('resize', onResize);
}

export function resetLayout() {
  return resetAll();
}

export const isEditing = () => editing;
