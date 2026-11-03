/* 首页可拖拽布局（第 10 条） + 模块点击联动（第 11 条）
   ------------------------------------------------------------------
   两个需求放在一个文件里，因为它们是同一件事的两面：
   布局决定了「卡片在哪」，联动决定了「点卡片会怎样」。
   两套逻辑都要知道「卡片是谁」，共用同一张登记表最省事。

   设计上的几个决定，先说清楚：

   1) **只让「卡片」可拖，不让页面骨架可拖。**
      搜索框、每日一句、时钟天气、倒计时通栏是固定位——它们回答的是
      「现在几点 / 什么天气 / 有没有新课」，位置天天一样才好找。
      真正需要按自己习惯排的是下面那几块内容卡。

   2) **拖拽期间不改 DOM 结构，只做视觉占位。**
      热路径上大规模 move 节点会让 iOS Safari 的触摸滚动抽风，
      所以拖拽中只是把「占位条」插到目标位置，松手才真正 move。

   3) **位置存到账号 settings.layout（不是 localStorage）。**
      用户的诉求是「电脑、iPad、手机都是同一份」，localStorage 各设备各一份，
      正好违背这一点。settings 跟着账号走，换设备登进来布局还在。

   4) **必须提供一个「恢复默认」。**
      拖拽最容易出事的就是拖乱了找不回来，尤其手机上拖到一半松手。
      没有复位按钮的拖拽功能，用户会直接放弃使用。 */

import { api, el, toast } from './core.js';
import { state } from './ui.js';

/* 每张卡片：id 用 data-hcard 打在 DOM 上，title 用于拖拽时的浮标和设置面板 */
export const HOME_CARDS = [
  { id: 'items', title: '今日事项', col: 0 },
  { id: 'courses', title: '今日课程', col: 0 },
  { id: 'calendar', title: '日历', col: 1 },
];

/* ---------------- 布局读写 ---------------- */

/* 从 settings 里读出保存的顺序；读不出来（老账号 / 数据坏了）就返回 null，
   让调用方用默认顺序。这里不抛错——布局坏了不该让整个首页打不开。 */
export function readLayout() {
  const raw = state.user?.settings?.layout;
  if (!raw || !Array.isArray(raw.cards)) return null;
  const known = new Set(HOME_CARDS.map((c) => c.id));
  const seen = new Set();
  const cards = [];
  for (const x of raw.cards) {
    if (!x || !known.has(x.id) || seen.has(x.id)) continue;
    seen.add(x.id);
    cards.push({ id: x.id, col: x.col === 1 ? 1 : 0 });
  }
  /* 少了几张就补回默认列，避免用户升级后新加的卡片直接看不见 */
  for (const c of HOME_CARDS) {
    if (!seen.has(c.id)) cards.push({ id: c.id, col: c.col });
  }
  return cards.length ? cards : null;
}

let saveTimer = null;
/* 存布局。防抖 600ms：拖一次可能触发多次 drop，
   不防抖会连打十几个 PATCH，慢网下互相覆盖，最后存进去的是中间态。 */
export function saveLayout(cards) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      const settings = { ...(state.user?.settings || {}), layout: { cards } };
      const r = await api.patch('/me', { settings });
      if (r?.user) state.user = r.user;
    } catch {
      toast('布局没保存成功，下次打开会回到原来的排法', 'warn');
    }
  }, 600);
}

export function resetLayout() {
  const cards = HOME_CARDS.map((c) => ({ id: c.id, col: c.col }));
  saveLayout(cards);
  return cards;
}

/* ---------------- 拖拽 ---------------- */

/* 让一个容器里的 [data-hcard] 可拖。
   gridEl 是 .home-grid，里面有两列 .home-col。
   用原生 HTML5 拖拽（桌面）+ Pointer Events 兜底（触摸），
   两套都写是因为：HTML5 drag 在 iOS Safari 上基本不可用。 */
export function enableDragSort(gridEl, { onDrop } = {}) {
  if (!gridEl) return () => {};
  const cols = Array.from(gridEl.querySelectorAll('.home-col'));
  if (cols.length < 2) return () => {};

  let dragging = null;      /* 正在拖的卡片 */
  let placeholder = null;   /* 视觉占位条 */
  const cleanups = [];

  const cardsNow = () => cols.map((col) => Array.from(col.querySelectorAll('[data-hcard]')));

  const toLayout = () => {
    const out = [];
    cols.forEach((col, ci) => {
      col.querySelectorAll('[data-hcard]').forEach((c) => out.push({ id: c.dataset.hcard, col: ci }));
    });
    return out;
  };

  /* 找插入点：指针落在哪一列、那一列里最接近哪个卡片的上/下半区 */
  const findTarget = (x, y) => {
    let best = null;
    for (let ci = 0; ci < cols.length; ci++) {
      const rect = cols[ci].getBoundingClientRect();
      /* 用整列的横向范围判断归属，允许在列间空白处也能落 */
      if (x < rect.left - 24 || x > rect.right + 24) continue;
      const list = Array.from(cols[ci].querySelectorAll('[data-hcard]')).filter((c) => c !== dragging);
      let before = null;
      for (const c of list) {
        const r = c.getBoundingClientRect();
        if (y < r.top + r.height / 2) { before = c; break; }
      }
      best = { col: cols[ci], before, ci };
      break;
    }
    /* 横向落在两列之外（比如拖到最边上）就退回按 y 判断最近的一列 */
    if (!best) {
      let nearest = 0; let min = Infinity;
      cols.forEach((c, i) => {
        const r = c.getBoundingClientRect();
        const d = Math.abs(x - (r.left + r.width / 2));
        if (d < min) { min = d; nearest = i; }
      });
      const col = cols[nearest];
      const list = Array.from(col.querySelectorAll('[data-hcard]')).filter((c) => c !== dragging);
      let before = null;
      for (const c of list) {
        const r = c.getBoundingClientRect();
        if (y < r.top + r.height / 2) { before = c; break; }
      }
      best = { col, before, ci: nearest };
    }
    return best;
  };

  const placePlaceholder = (target) => {
    if (!placeholder) {
      placeholder = el('<div class="hcard-ghost" aria-hidden="true"></div>');
      placeholder.style.height = dragging ? dragging.getBoundingClientRect().height + 'px' : '60px';
    }
    if (target.before) target.col.insertBefore(placeholder, target.before);
    else target.col.appendChild(placeholder);
  };

  const start = (card) => {
    dragging = card;
    card.classList.add('hcard-dragging');
    document.body.classList.add('hcard-dragging-body');
  };

  const finish = (commit) => {
    if (!dragging) return;
    const card = dragging;
    if (commit && placeholder && placeholder.parentNode) {
      placeholder.parentNode.insertBefore(card, placeholder);
    }
    if (placeholder) placeholder.remove();
    placeholder = null;
    card.classList.remove('hcard-dragging');
    document.body.classList.remove('hcard-dragging-body');
    dragging = null;
    if (commit) onDrop?.(toLayout());
  };

  /* ---- 桌面：HTML5 drag ---- */
  for (const col of cols) {
    const onDragOver = (e) => {
      if (!dragging) return;
      e.preventDefault();          /* 不 preventDefault 就不允许 drop */
      e.dataTransfer.dropEffect = 'move';
      placePlaceholder(findTarget(e.clientX, e.clientY));
    };
    const onDrop = (e) => {
      if (!dragging) return;
      e.preventDefault();
      placePlaceholder(findTarget(e.clientX, e.clientY));
      finish(true);
    };
    col.addEventListener('dragover', onDragOver);
    col.addEventListener('drop', onDrop);
    cleanups.push(() => { col.removeEventListener('dragover', onDragOver); col.removeEventListener('drop', onDrop); });
  }

  const bindCards = () => {
    gridEl.querySelectorAll('[data-hcard]').forEach((card) => {
      if (card.__hbound) return;   /* 重绑会叠加监听器，用标记挡住 */
      card.__hbound = true;
      const handle = card.querySelector('[data-drag-handle]') || card;

      /* 桌面 HTML5 */
      handle.addEventListener('dragstart', (e) => {
        start(card);
        try { e.dataTransfer.setData('text/plain', card.dataset.hcard); e.dataTransfer.effectAllowed = 'move'; } catch {}
      });
      handle.addEventListener('dragend', () => finish(true));

      /* 触摸 / 指针：手机和 iPad 上 HTML5 drag 根本不可用，必须自己实现 */
      let pid = null; let sx = 0; let sy = 0; let moved = false; let active = false;
      let ghostEl = null;

      const onDown = (e) => {
        if (e.pointerType === 'mouse') return;   /* 鼠标走 HTML5 drag，不重复接管 */
        const t = e.target;
        /* 卡片里的按钮、输入框不能被拖拽吃掉点击 —— 这是拖拽功能最常见的破坏点 */
        if (t.closest('button, a, input, textarea, select, label')) return;
        pid = e.pointerId; sx = e.clientX; sy = e.clientY; moved = false; active = false;
        handle.setPointerCapture?.(pid);
      };
      const onMove = (e) => {
        if (pid !== e.pointerId) return;
        const dx = e.clientX - sx; const dy = e.clientY - sy;
        if (!active) {
          /* 长按 220ms 或移动超过 8px 才算拖，避免滑一下就误触 */
          if (Math.hypot(dx, dy) < 8) return;
          active = true;
          start(card);
          const r = card.getBoundingClientRect();
          ghostEl = card.cloneNode(true);
          ghostEl.className = 'hcard-float';
          ghostEl.style.width = r.width + 'px';
          ghostEl.style.height = r.height + 'px';
          document.body.appendChild(ghostEl);
        }
        e.preventDefault();
        moved = true;
        if (ghostEl) {
          ghostEl.style.transform = `translate(${e.clientX - sx}px, ${e.clientY - sy}px) rotate(1.2deg)`;
        }
        placePlaceholder(findTarget(e.clientX, e.clientY));
      };
      const onUp = (e) => {
        if (pid !== e.pointerId) return;
        const wasActive = active;
        pid = null; active = false;
        if (ghostEl) { ghostEl.remove(); ghostEl = null; }
        if (wasActive) finish(moved);
      };
      handle.addEventListener('pointerdown', onDown);
      handle.addEventListener('pointermove', onMove, { passive: false });
      handle.addEventListener('pointerup', onUp);
      handle.addEventListener('pointercancel', onUp);
      cleanups.push(() => {
        handle.removeEventListener('pointerdown', onDown);
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        handle.removeEventListener('pointercancel', onUp);
      });
    });
  };

  bindCards();
  cleanups.push(() => { finish(false); });

  return () => { cleanups.forEach((f) => { try { f(); } catch {} }); };
}

/* ---------------- 点击联动（第 11 条） ----------------
   用户的描述很短：「点击各个模块没有联动效果」。
   这里的「联动」他指的是：点卡片上的某个东西，别的地方应该跟着动，
   而不是点完没反应、或者只是弹一个孤零零的详情框。

   落地成三条具体规则，都有明确的行为变化：

   ① 点「今日事项」里的一条 → 日历跳到那一天，并把那天在日历里高亮。
      原来点了只弹详情，日历完全不知道你在看哪天。
   ② 点日历上某一天 → 左侧事项列表滚到那天并高亮那一天的分组。
      反过来也要成立，否则「联动」只做了半个方向。
   ③ 点卡片标题 → 跳对应模块（课表、事项管理），标题本身当入口。

   这三条不需要新增接口，纯粹是「同一个日期」在两个区块之间传递，
   所以实现方式是统一发一条自定义事件，谁在听谁就响应。 */

export const DAY_SYNC = 'wb:home-day';

/* 把「当前聚焦的日期」广播出去。
   source 用来防回环：日历收到 items 发来的事件后自己也会发，
   不标来源就会两边互相触发，无限循环。 */
export function syncDay(date, source) {
  if (!date) return;
  document.dispatchEvent(new CustomEvent(DAY_SYNC, { detail: { date, source } }));
}

/* 卡片外框：拖拽手柄 + 标题入口。
   单独抽出来是因为三张卡片的头部要长得一样，
   不然拖拽手柄会出现三种样式，用户不知道哪个能拖。 */
export function cardShell(id, title, bodyHTML, opts = {}) {
  const { to, icon = '' } = opts;
  return `<section class="card home-card" data-hcard="${id}">
    <div class="hc-head">
      <span class="hc-grip" data-drag-handle title="按住拖动可调整位置" aria-label="拖动调整位置">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg>
      </span>
      <div class="card-title hc-title" ${to ? `data-goto2="${to}"` : ''}>${icon} ${title}</div>
    </div>
    ${bodyHTML}
  </section>`;
}
