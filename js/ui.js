import { api, el, esc, toast, ls, sheet } from './core.js';
import { decodeQR as qrDecode } from './qrdecode.js';

/* ---------------- 图标 ---------------- */
const I = {
  home: '<path d="M3 10.6 12 3.5l9 7.1V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  work: '<rect x="3" y="7.5" width="18" height="13" rx="2.5"/><path d="M8.5 7.5V6a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v1.5M3 12.5h18"/>',
  daily: '<rect x="4" y="3.5" width="16" height="17" rx="3"/><path d="M8.5 8.5h7M8.5 12h7M8.5 15.5h4"/>',
  study: '<path d="M4 5.5A2 2 0 0 1 6 3.5h13v15H6a2 2 0 0 0-2 2z"/><path d="M4 20.5V5.5"/>',
  me: '<circle cx="12" cy="8.5" r="4"/><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0"/>',
  /* 「我的」页里单独出现的「账号」图标。I 表原本只有 me，icon('user') 会
     落到兜底的 clock，页面上显示成一只时钟，看着像加载中。 */
  user: '<circle cx="12" cy="8.5" r="4"/><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0"/>',
  trash: '<path d="M4 7h16M9.5 7V5.2a1.2 1.2 0 0 1 1.2-1.2h2.6a1.2 1.2 0 0 1 1.2 1.2V7M6.5 7l.8 12.1a2 2 0 0 0 2 1.9h5.4a2 2 0 0 0 2-1.9L17.5 7"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  bell: '<path d="M18 15.5V11a6 6 0 1 0-12 0v4.5L4.5 18h15z"/><path d="M10 21h4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  cal: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 9.5h17M8 3.5v3M16 3.5v3"/>',
  speak: '<path d="M4 9.5h3l4-3.5v12l-4-3.5H4z"/><path d="M15 8.5a5 5 0 0 1 0 7M17.6 6a8.5 8.5 0 0 1 0 12"/>',
  loc: '<path d="M12 21s6.5-6.2 6.5-11A6.5 6.5 0 0 0 5.5 10c0 4.8 6.5 11 6.5 11z"/><circle cx="12" cy="10" r="2.3"/>',
  left: '<path d="m14.5 6-6 6 6 6"/>',
  right: '<path d="m9.5 6 6 6-6 6"/>',
  down: '<path d="m6 9.5 6 6 6-6"/>',
  up: '<path d="m6 14.5 6-6 6 6"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  more: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  edit: '<path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17z"/>',
  download: '<path d="M12 4v11m0 0 4-4m-4 4-4-4M5 19.5h14"/>',
  upload: '<path d="M12 20V9m0 0 4 4m-4-4-4 4M5 4.5h14"/>',
  file: '<path d="M6 3.5h7l5 5v12H6z"/><path d="M13 3.5v5h5"/>',
  play: '<path d="M8 5.5 19 12 8 18.5z"/>',
  dice: '<rect x="4" y="4" width="16" height="16" rx="4"/><circle cx="9" cy="9" r="1.2"/><circle cx="15" cy="15" r="1.2"/><circle cx="12" cy="12" r="1.2"/>',
  users: '<circle cx="9" cy="8.5" r="3.4"/><path d="M3 20a6 6 0 0 1 12 0"/><path d="M16 5.5a3.4 3.4 0 0 1 0 6M17.5 20a6.4 6.4 0 0 0-1.4-4"/>',
  book: '<path d="M5 4.5h9a3 3 0 0 1 3 3v12H8a3 3 0 0 0-3 3z"/><path d="M17 19.5h2v-15h-2"/>',
  zap: '<path d="M13 2 4.5 13.5H11l-1 8.5 8.5-11.5H12z"/>',
  alert: '<path d="M12 3.5 21 20H3z"/><path d="M12 9v5"/><circle cx="12" cy="17" r=".9" fill="currentColor" stroke="none"/>',
  briefcase: '<rect x="3" y="7.5" width="18" height="12" rx="2.5"/><path d="M9 7.5V6a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v1.5"/>',
  car: '<path d="M4 16.5V12l2-5h12l2 5v4.5"/><path d="M4 16.5h16M7 16.5v2M17 16.5v2"/><circle cx="7.5" cy="12.8" r="1"/><circle cx="16.5" cy="12.8" r="1"/>',
  wallet: '<rect x="3" y="6" width="18" height="13" rx="2.5"/><path d="M3 10h18"/><circle cx="17" cy="14" r="1.2" fill="currentColor" stroke="none"/>',
  folder: '<path d="M3.5 6.5A1.5 1.5 0 0 1 5 5h4l2 2.5h8a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 19 19.5H5A1.5 1.5 0 0 1 3.5 18z"/>',
  drop: '<path d="M12 3.5s5.5 6 5.5 9.8A5.5 5.5 0 0 1 12 19a5.5 5.5 0 0 1-5.5-5.7C6.5 9.5 12 3.5 12 3.5z"/>',
  wind: '<path d="M3 8h9a3 3 0 1 0-3-3"/><path d="M3 12h13a3 3 0 1 1-3 3"/><path d="M3 16h6"/>',
  rain: '<path d="M7 15a4 4 0 0 1 .6-8 5.5 5.5 0 0 1 10.6 1.3A3.4 3.4 0 0 1 17.6 15z"/><path d="M8.5 18.5 7.5 21M12.5 18.5 11.5 21M16.5 18.5 15.5 21"/>',
  uv: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.2 5.2l1.4 1.4M17.4 17.4l1.4 1.4M18.8 5.2l-1.4 1.4M6.6 17.4l-1.4 1.4"/>',
  sunrise: '<path d="M12 3.5v5M9.5 6 12 3.5 14.5 6"/><path d="M3 18h18M6.5 18a5.5 5.5 0 0 1 11 0"/><path d="M2.5 14 4 15.5M21.5 14 20 15.5"/>',
  sunset: '<path d="M12 8.5v-5M9.5 6 12 8.5 14.5 6"/><path d="M3 18h18M6.5 18a5.5 5.5 0 0 1 11 0"/><path d="M2.5 14 4 15.5M21.5 14 20 15.5"/>',
  refresh: '<path d="M20 11.5a8 8 0 1 0-2.3 5.6"/><path d="M20 4.5v6h-6"/>',
  shield: '<path d="M12 3.5 20 6v6c0 5-4 7.6-8 8.5-4-.9-8-3.5-8-8.5V6z"/>',
  logout: '<path d="M15 8V5.5H4v13h11V16M9.5 12h11m0 0-3.5-3.5M20.5 12 17 15.5"/>',
  moon: '<path d="M20 14.5A8.6 8.6 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/>',
  sun: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.2 5.2l1.6 1.6M17.2 17.2l1.6 1.6M18.8 5.2l-1.6 1.6M6.8 17.2l-1.6 1.6"/>',
  qr: '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><path d="M14 14h2v2h-2zM18 14h2v2M14 18h2v2h-2M18 20h2"/>',
  pin: '<path d="M9 3.5h6l-1 5 3 3v2H7v-2l3-3z"/><path d="M12 13.5v7"/>',
  undo: '<path d="M9 8H5V4"/><path d="M5 8a8 8 0 1 1-1 9"/>',
  chart: '<path d="M4 20V9M10 20V4M16 20v-7M22 20H2"/>',
  camera: '<rect x="3" y="7" width="18" height="13" rx="3"/><circle cx="12" cy="13.5" r="3.6"/><path d="M8.5 7l1.2-2h4.6L15.5 7"/>',
  /* 扫一扫：四角取景框 + 中间一条扫描线。比用 camera 图标更准确——
     camera 表示「拍照片」，这里要做的事是「读一个码」。 */
  scan: '<path d="M4 8.5V6a2 2 0 0 1 2-2h2.5M15.5 4H18a2 2 0 0 1 2 2v2.5M20 15.5V18a2 2 0 0 1-2 2h-2.5M8.5 20H6a2 2 0 0 1-2-2v-2.5"/><path d="M4.5 12h15"/>',
  wrench: '<path d="M14.7 6.3a4 4 0 0 0 5 5l-9.4 9.4a2.8 2.8 0 0 1-4-4z"/><path d="M14.7 6.3 17.4 3.6a4.6 4.6 0 0 1 3 3l-2.7 2.7"/>',
  book: '<path d="M4 5.5A2 2 0 0 1 6 3.5h6v17H6a2 2 0 0 0-2 2z"/><path d="M20 5.5a2 2 0 0 0-2-2h-6v17h6a2 2 0 0 1 2 2z"/>',
  expand: '<path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  grid: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.6"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.6"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.6"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.6"/>',
  gift: '<rect x="4" y="10" width="16" height="10.5" rx="2"/><path d="M3 10h18v3.5H3z"/><path d="M12 10v10.5"/><path d="M12 10c-1.2 0-4-1-4-3a2 2 0 0 1 4 0c0 2-2.8 3-4 3z"/><path d="M12 10c1.2 0 4-1 4-3a2 2 0 0 0-4 0c0 2 2.8 3 4 3z"/>',
  dice: '<rect x="4" y="4" width="16" height="16" rx="3.5"/><circle cx="9" cy="9" r="1.3" fill="currentColor" stroke="none"/><circle cx="15" cy="15" r="1.3" fill="currentColor" stroke="none"/><circle cx="15" cy="9" r="1.3" fill="currentColor" stroke="none"/><circle cx="9" cy="15" r="1.3" fill="currentColor" stroke="none"/>',
};
export function icon(name, size = 20, cls = '') {
  const p = I[name] || I.clock;
  return `<svg class="${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
}

/* ---------------- 应用状态 ---------------- */
export const state = {
  user: null,
  route: 'home',
  theme: (() => { try { return document.documentElement.dataset.theme || 'light'; } catch { return 'light'; } })(),
  unread: 0,
  weather: ls.get('weather', null),
  city: ls.get('city', { name: '北京', lat: 39.9042, lon: 116.4074 }),
  /* manual = 用户自己选城市（默认）。
     以前默认 auto，进首页就弹定位授权，拒绝了还报错，观感很差。
     城市由用户自己在「选城市」里挑一次，之后一直记住，比每次猜更省事。 */
  geoMode: ls.get('geoMode', 'manual'),
};

/* 【一级 / 二级 / 三级导航】
   以前除了「工作」和「日常」，其余模块都各自占一格一级导航：
   首页、工作、自习、维修、日常、学习、回收站、我的 —— 八格。
   问题是「自习」和「维修」在业务上都属于工作，却和「工作」平级；
   手机底部导航被挤到每项只剩 46px，「回收站」三个字要折行。

   现在收成三层：
     一级 6 格：首页 / 工作 / 日常 / 学习 / 回收站 / 我的
     二级挂在「工作」下：上课、课表、备课、维修、考勤、监考、出差、课件、笔记
     三级挂在「课件」下（也就是学生看到的那个页面）：自习、教材、抽人、盲盒

   为什么自习在课件下面而不是在「工作」的二级里：
     它记录的是给学生的那个页面（student.html）里的模块，和电子教材、抽人、
     盲盒放在同一个出口，用户才找得到「我给学生看的页面上到底有什么」。
     记自己看哪个班的自习的入口没丢，在「课件 → 自习」页里单独一块。 */
export const NAV = [
  { id: 'home', label: '首页', icon: 'home' },
  {
    id: 'work', label: '工作', icon: 'work',
    sub: [
      { id: 'lessons', label: '上课', icon: 'zap' },
      /* 上课之后紧跟课表：先知道今天上什么，再记上没上。 */
      { id: 'timetable', label: '课表', icon: 'cal' },
      /* 备课紧接课表：课前看图、课后备课，动线是连着的。 */
      { id: 'prep', label: '备课', icon: 'book' },
      { id: 'repairs', label: '维修', icon: 'wrench' },
      { id: 'attendance', label: '考勤', icon: 'users' },
      { id: 'invigilation', label: '监考', icon: 'shield' },
      { id: 'trips', label: '出差', icon: 'car' },
      {
        id: 'materials', label: '课件', icon: 'folder',
        sub: [
          { id: 'selfstudy', label: '自习', icon: 'clock' },
          { id: 'textbook', label: '教材', icon: 'book' },
          { id: 'pick', label: '抽人', icon: 'dice' },
          { id: 'mystery', label: '盲盒', icon: 'gift' },
        ],
      },
      { id: 'notes', label: '笔记', icon: 'edit' },
    ],
  },
  { id: 'daily', label: '日常', icon: 'daily' },
  { id: 'study', label: '学习', icon: 'study' },
  { id: 'recycle', label: '回收站', icon: 'trash' },
  { id: 'me', label: '我的', icon: 'me' },
];

/* 旧的「工作页页签」列表由上面的 NAV 派生，不再单独维护一份，
   否则改一处漏一处（以前 WORK_TABS 和页面里的 if 链就是两份清单）。 */
export const WORK_TABS = (NAV.find((n) => n.id === 'work')?.sub || []).map((t) => ({ id: t.id, label: t.label }));
export const DAILY_TABS = [
  { id: 'notes', label: '便签' },
  { id: 'homework', label: '作业' },
];

/* ---------------- 导航层级工具 ----------------
   parentOf('work','materials') → 'work'
   parentOf('work','lessons')   → 'work'
   parentOf('home')             → null
   路由形如 work/materials/textbook，第三段是「课件」内部的视图 key。 */
const SUB_OF = {};
for (const n of NAV) for (const s of (n.sub || [])) SUB_OF[s.id] = n.id;
const THIRD_OF = {};
for (const n of NAV) for (const s of (n.sub || [])) for (const t of (s.sub || [])) THIRD_OF[t.id] = s.id;

export function navNode(id) {
  for (const n of NAV) {
    if (n.id === id) return n;
    for (const s of (n.sub || [])) {
      if (s.id === id) return s;
      for (const t of (s.sub || [])) if (t.id === id) return t;
    }
  }
  return null;
}
/* 某个一级导航当前展开的二级项（用于侧栏高亮与缩进列表） */
export function subCurrentOf(rootId, route) {
  const [seg, tab, third] = String(route || '').split('/');
  if (seg !== rootId) return null;
  if (rootId === 'work') {
    /* 旧地址 #/selfstudy、#/repairs 已经不存在了，但收藏夹里可能还有；
       它们的二级归属仍然报出来，让侧栏高亮落在正确的位置。 */
    if (!tab) return 'lessons';
    if (THIRD_OF[tab]) return THIRD_OF[tab];
    if (SUB_OF[tab] === 'work') return tab;
    return 'lessons';
  }
  if (rootId === 'daily') return tab || 'notes';
  return tab || null;
}

/* ---------------- 主题 ---------------- */
/* 每套主题的元信息 + 色卡预览用到的真实颜色（与 css 中 html[data-theme=x] 保持一致） */
export const THEMES = [
  {
    id: 'light', name: '晴空白', desc: '苹果原生浅色 · iOS 系统蓝', tag: '默认',
    sw: { bg: '#f2f2f7', card: '#ffffff', pri: '#007aff', line: '#e5e5ea', text: '#1c1c1e' },
    meta: '#f2f2f7',
  },
  {
    id: 'ocean', name: '海洋蓝', desc: '比默认更清透的蓝绿调',
    sw: { bg: '#eaf3f8', card: '#fcfdfe', pri: '#1478a8', line: '#d3e5ee', text: '#142b38' },
    meta: '#eaf3f8',
  },
  {
    id: 'green', name: '护眼绿', desc: '低饱和，久看不累',
    sw: { bg: '#eaf2ea', card: '#fdfefd', pri: '#257a40', line: '#d7e4d6', text: '#1b2b1f' },
    meta: '#eaf2ea',
  },
  {
    id: 'warm', name: '暖阳米', desc: '偏暖的纸感底色',
    sw: { bg: '#f7f1e6', card: '#fffdf8', pri: '#a9660f', line: '#e8ddc9', text: '#33291c' },
    meta: '#f7f1e6',
  },
  {
    id: 'pink', name: '樱花粉', desc: '淡粉柔和，一眼温柔',
    sw: { bg: '#fbf0f4', card: '#fffcfd', pri: '#c03a6b', line: '#f0dde5', text: '#33202a' },
    meta: '#fbf0f4',
  },
  {
    id: 'dark', name: '深色模式', desc: '纯黑底，夜里护眼省电',
    sw: { bg: '#000000', card: '#1c1c1e', pri: '#0a84ff', line: '#38383a', text: '#ffffff' },
    meta: '#000000',
  },
];
export const THEME_MAP = Object.fromEntries(THEMES.map((t) => [t.id, t]));
export function themeName(id) { return THEME_MAP[id]?.name || '晴空白'; }

export function setTheme(name, { silent = false } = {}) {
  if (!THEME_MAP[name]) name = 'light';
  state.theme = name;
  document.documentElement.dataset.theme = name;
  ls.set('theme', name);
  const meta = document.querySelector('meta[name=theme-color]');
  if (meta) meta.content = THEME_MAP[name].meta;
  if (!silent) toast(`已切换为「${themeName(name)}」`);
  document.dispatchEvent(new CustomEvent('wb:theme', { detail: { theme: name } }));
}
/* 兼容旧调用：在浅色 / 深色之间切换 */
export function toggleTheme() {
  setTheme(state.theme === 'dark' ? 'light' : 'dark');
}

/* 主题选择面板：从侧边栏底部或「我的 - 主题外观」打开同一个 */
export function openThemeSheet() {
  const body = el('<div></div>');
  body.innerHTML = `
    <div class="theme-grid">
      ${THEMES.map((t) => `
        <button class="theme-row${t.id === state.theme ? ' on' : ''}" data-theme-id="${t.id}">
          <span class="theme-swatch" style="background:${t.sw.bg}">
            <i class="sw-top" style="background:${t.sw.bg}">
              <span class="sw-dot" style="background:${t.sw.pri}"></span>
              <span class="sw-bar" style="background:${t.sw.text}"></span>
            </i>
            <i class="sw-mid" style="background:${t.sw.bg}">
              <span class="sw-card" style="background:${t.sw.card};box-shadow:0 0 0 1px ${t.sw.line}"></span>
              <span class="sw-pri" style="background:${t.sw.pri}"></span>
            </i>
            <i class="sw-bot" style="background:${t.sw.card}">
              <span class="sw-nav" style="background:${t.sw.pri}"></span>
            </i>
          </span>
          <span class="theme-meta">
            <span class="theme-name">${esc(t.name)}${t.tag ? `<span class="theme-tag">${esc(t.tag)}</span>` : ''}</span>
            <span class="theme-desc">${esc(t.desc)}</span>
          </span>
          <span class="theme-check">${icon('check', 14)}</span>
        </button>`).join('')}
    </div>`;
  const s = sheetRaw('主题外观', body);
  body.querySelectorAll('[data-theme-id]').forEach((b) => {
    b.onclick = () => {
      const id = b.dataset.themeId;
      setTheme(id);
      body.querySelectorAll('[data-theme-id]').forEach((x) => x.classList.toggle('on', x.dataset.themeId === id));
      // 侧边栏按钮上的文字与色点即时同步（不整页重绘，避免丢失滚动位置）
      syncThemeButton();
    };
  });
  return s;
}
function syncThemeButton() {
  const b = document.getElementById('side-theme');
  if (!b) return;
  const t = THEME_MAP[state.theme] || THEMES[0];
  b.innerHTML = `<span class="theme-dot" style="background:${t.sw.pri}"></span><span>主题外观</span><span class="theme-now">${esc(t.name)}</span>`;
}

/* ---------------- 注册 / 订阅 ---------------- */
export function registerView(fn) { views[fn.name] = fn; }
const views = {};

/* ---------------- 导航 ---------------- */
function navHTML(n, cls) {
  const active = isActive(n.id) ? 'active' : '';
  const badge = n.id === 'me' && state.unread ? `<span class="badge-dot">${state.unread > 99 ? '99+' : state.unread}</span>` : '';
  const caret = (n.sub && cls === 'nav-item') ? `<span class="nav-caret">${icon(isOpen(n.id) ? 'down' : 'right', 13)}</span>` : '';
  return `<button class="${cls} ${active}" data-nav="${n.id}">
    ${cls === 'bn-item' ? icon(n.icon, 22) : `<span class="ni">${icon(n.icon, 20)}</span>`}
    <span class="nav-label">${n.label}</span>${caret}${badge}</button>`;
}
/* 有二级的子菜单：展开状态跟随当前路由，不在当前模块时默认收起。
   用 data-open 而不是每次折叠都重绘整页，滚动位置不会丢。 */
function isOpen(rootId) {
  return String(state.route || '').split('/')[0] === rootId;
}
function subNavHTML(n) {
  if (!n.sub) return '';
  const cur = subCurrentOf(n.id, state.route);
  const open = isOpen(n.id);
  return `<div class="nav-sub${open ? ' open' : ''}" data-sub-of="${n.id}"${open ? '' : ' hidden'}>
    ${n.sub.map((s) => {
    const on = cur === s.id ? 'on' : '';
    /* 课件下面还有第三级：在侧栏里缩进显示，不用点进去才知道有自习/教材/抽人/盲盒 */
    const hasThird = !!s.sub;
    return `<button class="nav-subitem ${on}" data-nav="${n.id}/${s.id}">
        ${icon(s.icon, 15)}<span class="nav-label">${s.label}</span>${hasThird ? `<span class="nav-caret">${icon(cur === s.id ? 'down' : 'right', 12)}</span>` : ''}
      </button>
      ${hasThird && cur === s.id ? `<div class="nav-sub3">${s.sub.map((t) => `
        <button class="nav-subitem lv3 ${String(state.route || '').endsWith('/' + t.id) ? 'on' : ''}" data-nav="${n.id}/${s.id}/${t.id}">
          ${icon(t.icon, 14)}<span class="nav-label">${t.label}</span></button>`).join('')}</div>` : ''}`;
  }).join('')}
  </div>`;
}
function isActive(id) {
  const r = state.route;
  if (id === 'home') return r === 'home' || r === '';
  if (id === 'work') return r.startsWith('work') || r === 'selfstudy' || r === 'repairs';
  if (id === 'daily') return r.startsWith('daily');
  if (id === 'study') return r.startsWith('study');
  if (id === 'me') return r === 'me' || r === 'messages' || r === 'profile';
  if (id === 'recycle') return r === 'recycle';
  return false;
}

function bindShell() {
  document.querySelectorAll('[data-nav]').forEach((b) => { b.onclick = () => go(b.dataset.nav); });
  /* 点一级导航时展开它的二级菜单（不跳页），再点一次收起。
     没有这一步的话「工作」永远是直接跳到上课，用户看不到下面还有什么。 */
  document.querySelectorAll('.sidebar [data-nav]').forEach((b) => {
    const id = b.dataset.nav;
    if (id.includes('/')) return;
    const node = NAV.find((n) => n.id === id);
    if (!node?.sub) return;
    b.addEventListener('click', (e) => {
      e.preventDefault();
      const box = document.querySelector(`[data-sub-of="${id}"]`);
      if (!box) return;
      const willOpen = box.hidden || !box.classList.contains('open');
      document.querySelectorAll('.nav-sub').forEach((x) => {
        if (x === box) return;
        x.classList.remove('open');
        x.hidden = true;
      });
      box.classList.toggle('open', willOpen);
      box.hidden = !willOpen;
      b.classList.toggle('active', willOpen);
      const c = b.querySelector('.nav-caret');
      if (c) c.innerHTML = icon(willOpen ? 'down' : 'right', 13);
      if (willOpen && String(state.route || '').split('/')[0] !== id) {
        go(id + '/' + node.sub[0].id);
      }
    });
  });
  const st = document.getElementById('side-theme');
  if (st) st.onclick = () => openThemeSheet();
  const su = document.getElementById('side-user');
  if (su) su.onclick = () => go('me');
  /* 拖拽一定要配一个「恢复默认」。
     没有退路的功能用户不敢用——尤其手机上拖到一半松手，卡片落在奇怪的位置，
     找不回来的话下次就不拖了。这里延后导入，避免 home.js ↔ ui.js 循环依赖。 */
  /* 平铺整页：把 body 挂上 .is-wide，CSS 里 .main 的 max-width 放开。
     存在 localStorage 就够了——这是「这台机器看起来多宽」的偏好，不必跨端同步。 */
  const sw = document.getElementById('side-wide');
  const applyWide = (on) => {
    document.body.classList.toggle('is-wide', !!on);
    const now = document.getElementById('wide-now');
    if (now) now.textContent = on ? '开' : '关';
    if (sw) sw.classList.toggle('on', !!on);
  };
  applyWide(localStorage.getItem('wb.wide') === '1');
  if (sw) sw.onclick = () => {
    const on = !document.body.classList.contains('is-wide');
    localStorage.setItem('wb.wide', on ? '1' : '0');
    applyWide(on);
    toast(on ? '已平铺整页，再点一次恢复舒适宽度' : '已恢复舒适宽度', 'ok', 3000);
  };
  const sl = document.getElementById('side-layout');
  if (sl) sl.onclick = async () => {
    try {
      const m = await import('./home.js');
      m.restoreHomeLayout();
      go('home');
    } catch { /* 首页模块加载失败时静默，重置本身不关键 */ }
  };
}

/* ---------------- 路由 ---------------- */
export function parseHash() {
  const h = (location.hash || '#/home').replace(/^#\/?/, '');
  const [path, qs] = h.split('?');
  return { path: path || 'home', query: Object.fromEntries(new URLSearchParams(qs || '')) };
}
export function go(path) {
  if (location.hash === '#/' + path) render();
  else location.hash = '#/' + path;
}
/* 渲染序号：并发 render（登录后手动 render + hashchange 各触发一次）时，
   只让最后一次渲染的结果落地，避免把内容写进已被替换掉的旧 #main。 */
let renderSeq = 0;
/* 视图卸载钩子：视图里开了轮询/定时器，注册一个清理函数，
   下次换页时自动调用，防止离开页面后还在偷偷请求。 */
let viewCleanup = null;
export function onViewLeave(fn) { viewCleanup = fn; }
export async function render() {
  /* 扫码确认页必须在「是否登录」判断之前拦下来：
     它既要给已登录的人看（确认/拒绝），也要给未登录的人看（先去登录再回来）。
     走常规 render 的话，未登录会直接被踢回登录页，扫码场景就断了。 */
  {
    const h = parseHash();
    if (h.path === 'qr') {
      /* 进确认页之前先把上一个视图的定时器停掉。
         扫码登录的轮询是挂在登录页上的，如果不清理，人在手机上点着确认，
         电脑那边还在偷偷每 2 秒问一次——不是安全问题，但是白白耗电耗流量。 */
      if (viewCleanup) { try { viewCleanup(); } catch {} viewCleanup = null; }
      renderQrConfirm(h.query.id || '');
      return;
    }
  }
  if (!state.user) { renderAuth(); return; }
  const mySeq = ++renderSeq;
  if (viewCleanup) { try { viewCleanup(); } catch {} viewCleanup = null; }
  let { path, query } = parseHash();
  state.route = path;
  let [seg, tab, third] = path.split('/');

  /* 【旧地址兼容】
     #/selfstudy、#/repairs 以前是一级导航，收藏夹、群里的链接都可能是这个。
     直接 404 到首页太粗暴，原地 translate 成新地址，看起来只是「跳了一下」。 */
  if (seg === 'selfstudy') { path = 'work/materials/selfstudy'; location.replace('#/' + path); return render(); }
  if (seg === 'repairs') { path = 'work/repairs'; location.replace('#/' + path); return render(); }
  /* #/work 没有第二段时补一个默认二级，否则侧栏高亮会落空 */
  if (seg === 'work' && !tab) { path = 'work/lessons'; location.replace('#/' + path); return render(); }
  /* 其他一级导航补默认二级（#/daily → #/daily/notes），
     否则侧栏高亮只匹配到一级，「日常」下面的「便签」没有选中态。 */
  if (seg === 'daily' && !tab) { path = 'daily/notes'; location.replace('#/' + path); return render(); }
  /* 旧的三级简写 #/work/selfstudy（没有 materials 这一段）也接住 */
  if (seg === 'work' && (tab === 'selfstudy' || tab === 'textbook' || tab === 'pick' || tab === 'mystery')) {
    path = 'work/materials/' + tab; location.replace('#/' + path); return render(); }
  /* 【#/timetable、#/attendance 这类「二级直接当一级用」的老地址】
     改造前「工作」的二级页是 #/work/lessons 这种形式，但用户手工改地址、
     或者从旧页面里复制出来的链接很可能是 #/timetable ——
     那时候 render() 只按第一段找视图，找不到就退首页，至少还能打开。
     现在第一段必须是 NAV 里的 id，找不到会直接白屏（用户反馈「课表没变」，
     很可能就是停在了一个空白页上）。这里统一把已知的二级 id 补回 work/ 前面。
     判断依据直接读 NAV，新加二级项时不用再来改这段。 */
  if (!tab && WORK_TABS.some((x) => x.id === seg)) {
    path = 'work/' + seg; location.replace('#/' + path); return render();
  }
  [seg, tab, third] = path.split('/');

  let viewName = seg;
  if (seg === 'work') viewName = 'work';
  if (seg === 'daily') viewName = 'daily';
  if (seg === 'study') viewName = 'study';
  if (seg === 'messages' || seg === 'profile') viewName = 'me';
  /* 【兜底：认不出的地址不再静默退首页】
     以前 views[viewName] 找不到就直接 render 首页 —— 地址栏还写着 #/timetable，
     屏幕上却是首页，看起来像「页面没变」。现在先试一级 id，再试二级 id，
     都不认识才落首页，并且用一次性的 toast 说明，而不是默默换页。 */
  if (!views[viewName]) {
    const hit = navNode(seg);
    if (hit) {
      const root = SUB_OF[seg];
      path = root ? `${root}/${seg}` : seg;
      location.replace('#/' + path); return render();
    }
    viewName = 'home';
    if (!render.__fallbackHinted) {
      render.__fallbackHinted = true;
      setTimeout(() => toast('这个地址打不开，已回到首页', 'warn', 4000), 400);
    }
  }
  const fn = views[viewName];
  const app = document.getElementById('app');
  const pageShell = `<div class="app">
    <aside class="sidebar">
      <div class="brand"><div class="brand-logo">台</div><div><div class="brand-name">我的工作台</div><div class="brand-sub">Workbench</div></div></div>
      <div class="side-nav">${NAV.map((n) => navHTML(n, 'nav-item') + subNavHTML(n)).join('')}</div>
      <div class="sidebar-foot">
        <button class="nav-item" id="side-theme" title="切换主题外观"><span class="theme-dot" style="background:${(THEME_MAP[state.theme] || THEMES[0]).sw.pri}"></span><span>主题外观</span><span class="theme-now">${esc(themeName(state.theme))}</span></button>
        <button class="nav-item" id="side-wide" title="让正文铺满整个屏幕宽度"><span class="ni">${icon('expand', 18)}</span><span>平铺整页</span><span class="theme-now" id="wide-now">关</span></button>
        <button class="nav-item" id="side-layout" title="把首页卡片恢复到默认位置"><span class="ni">${icon('grid', 18)}</span><span>重置首页布局</span></button>
        <button class="nav-item" id="side-user" data-nav="me"><span class="ni" style="border-radius:50%;background:var(--primary-weak);color:var(--primary);font-weight:700;font-size:12px">${esc((state.user?.nickname || '师').slice(0, 1))}</span><span>${esc(state.user?.nickname || '我的')}</span></button>
      </div>
    </aside>
    <main class="main" id="main"></main>
    <nav class="bottom-nav"><div class="bn-inner">${NAV.map((n) => navHTML(n, 'bn-item')).join('')}</div></nav>
  </div>`;
  app.innerHTML = pageShell;
  bindShell();
  const main = document.getElementById('main');
  /* 手机端顶部二级条：底部导航只有 6 格一级，二级必须另给一个入口，
     否则手机上根本点不到「维修」「考勤」这些。只在 ≤1100px 显示（CSS 控制）。 */
  const rootId = String(state.route || '').split('/')[0];
  const rootNode = NAV.find((n) => n.id === rootId);
  if (rootNode?.sub) {
    const cur = subCurrentOf(rootId, state.route);
    /* 这条 bar 是 #app 的直接孩子，不在 .main 里。
       .app 是 display:flex，直接塞进去会变成 flex item 横着排在侧栏右边；
       手机上侧栏是抽屉（position:fixed），它就会被撑到「屏幕宽度 + 抽屉宽度」，
       整页横向溢出。所以外层包一个 width:100% 的壳，里面再 position:fixed。 */
    const bar = el(`<div class="sub-nav-wrap"><div class="sub-nav-bar">
      <div class="snb-title">${icon(rootNode.icon, 15)} ${esc(rootNode.label)}</div>
      <div class="snb-list">${rootNode.sub.map((s) => `<button class="snb-item${cur === s.id ? ' on' : ''}" data-nav="${rootId}/${s.id}">${esc(s.label)}</button>`).join('')}</div>
    </div></div>`);
    bar.querySelectorAll('[data-nav]').forEach((b) => { b.onclick = () => go(b.dataset.nav); });
    /* app 里此时只有 .app 一个孩子，main 是 .app 里更深一层的节点，
       所以必须插到 .app 的第一个子节点前面，不能直接拿 main 当参照
       （insertBefore 的参照点必须是 app 的直接子节点）。 */
    app.firstElementChild.insertBefore(bar, app.firstElementChild.firstChild);
  }
  try {
    await fn(main, { tab: tab || defaultTab(seg), third: third || '', query });
    // 期间又发生了一次 render：本次结果作废（DOM 已被新一次接管）
    if (mySeq !== renderSeq) return;
  } catch (e) {
    if (mySeq !== renderSeq) return;
    console.error(e);
    main.innerHTML = `<div class="empty"><div class="em">${icon('alert', 34)}</div>${esc(e.message || '页面加载失败')}</div>`;
  }
}
const defaultTab = (seg) => (seg === 'work' ? 'lessons' : seg === 'daily' ? 'notes' : '');

/* ---------------- 页面头部 ---------------- */
export function pageHead(title, sub, actions = '') {
  return `<div class="page-head"><div><h1 class="page-title">${esc(title)}</h1>${sub ? `<div class="page-sub">${esc(sub)}</div>` : ''}</div><div class="spacer"></div>${actions}</div>`;
}
export function tabsBar(tabs, base, current) {
  return `<div class="seg" style="margin-bottom:16px">${tabs.map((t) => `<button class="${t.id === current ? 'on' : ''}" data-goto="${base}/${t.id}">${esc(t.label)}</button>`).join('')}</div>`;
}
export function bindTabs(root) {
  root.querySelectorAll('[data-goto]').forEach((b) => { b.onclick = () => go(b.dataset.goto); });
}

/* ---------------- 登录页 ---------------- */
const CHAT_G = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M9.2 3.5C5 3.5 1.7 6.3 1.7 9.8c0 2 1.1 3.8 2.9 5l-.7 2.2 2.5-1.3c.9.3 1.8.4 2.8.4h.6a5.6 5.6 0 0 1-.2-1.5c0-3.3 3.1-5.9 6.9-5.9h.6C17 5.6 13.5 3.5 9.2 3.5Zm-2.6 3a1 1 0 1 1 0 2 1 1 0 0 1 0-2Zm5.2 0a1 1 0 1 1 0 2 1 1 0 0 1 0-2Z"/><path d="M22.3 14.6c0-2.8-2.7-5.1-6-5.1s-6 2.3-6 5.1 2.7 5.1 6 5.1c.7 0 1.4-.1 2-.3l2 1-.6-1.7c1.6-1 2.6-2.5 2.6-4.1Zm-8-1.4a.85.85 0 1 1 0-1.7.85.85 0 0 1 0 1.7Zm4 0a.85.85 0 1 1 0-1.7.85.85 0 0 1 0 1.7Z"/></svg>';
const QQ_G = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.5c-3.2 0-5.2 2.3-5.2 5.4 0 .8-.1 1.6-.4 2.3-.5-.6-.9-1.4-1.1-2-.1-.4-.5-.6-.8-.4-.3.1-.5.5-.4.9.3 1.2.8 2.3 1.5 3.2-.8 1.3-1.6 3-1.6 4.4 0 1 .5 1.7 1.3 1.7.6 0 1.1-.4 1.5-1 1 1.4 2.9 2.3 5.2 2.3s4.2-.9 5.2-2.3c.4.6.9 1 1.5 1 .8 0 1.3-.7 1.3-1.7 0-1.4-.8-3.1-1.6-4.4.7-.9 1.2-2 1.5-3.2.1-.4-.1-.8-.4-.9-.3-.2-.7 0-.8.4-.2.6-.6 1.4-1.1 2-.3-.7-.4-1.5-.4-2.3 0-3.1-2-5.4-5.2-5.4Z"/></svg>';
/* 站点能力（登录页据此显示哪些入口），由 /auth/config 填充。
   注意 qrEnabled 与 siteQrLogin 是两件事，别混用：
     qrEnabled   —— 微信 / QQ 第三方扫码通道（需要企业资质 + AppID，本站没有）；
     siteQrLogin —— 本站自己的扫码登录（自己的二维码 + 手机确认）。
   以前只有一个 qrEnabled，看到 false 就以为「扫码登录不能用」，
   于是界面上真能用的扫码 tab 被一行「未开通」误导了很久。 */
/* 登录页当前是「登录」还是「注册」——只在这两个之间切换，没有第三种方式 */
let authMode = 'login';

export const AUTH_CFG = { allowRegister: true, demoMode: false, smsEnabled: false, qrEnabled: false, siteQrLogin: true, wbEnabled: false, testPasscode: false };

export async function loadAuthConfig() {
  try {
    const c = await api.get('/auth/config', null, { silent: true });
    Object.assign(AUTH_CFG, c);
  } catch { /* 取不到就用默认值，保持密码登录可用 */ }
  return AUTH_CFG;
}

/* 【登录方式：只有账号 + 密码】
   用户明确要求「只支持账号和密码登录和注册，不需要发送短信，自己设置账号密码就行，
   只要账号和密码正确就可以登录成功」。

   所以这里不再有验证码页签、扫码页签、第三方登录按钮 —— 全部删掉，
   只留「账号 / 密码」两个输入框，加一个「登录」和一行「还没有账号？注册」。
   把「选哪种方式」这道题从界面上彻底拿掉。 */
function authTabsHTML() {
  const mode = authMode === 'register' ? '注册新账号' : '登录';
  const other = authMode === 'register' ? '已有账号？去登录' : '还没有账号？注册一个';
  return {
    html: `<button class="on">${mode}</button>
      <button class="auth-switch" id="auth-switch">${other}</button>`,
    def: null,
  };
}

/* 从扫码确认页跳去登录的用户，登录完要回到那一次确认。
   只在「确实有未完成的扫码请求」时才回跳，否则正常登录还是进首页——
   不能因为 sessionStorage 里残留过一个 id 就把人莫名其妙带到确认页。 */
function takeQrReturn() {
  let id = '';
  try { id = sessionStorage.getItem('wb_qr_return') || ''; } catch { return ''; }
  if (!id) return '';
  try { sessionStorage.removeItem('wb_qr_return'); } catch {}
  return id;
}

function renderAuth() {
  const app = document.getElementById('app');
  app.innerHTML = `<div class="auth">
    <div class="auth-side">
      <div class="brand" style="padding:0">
        <div class="brand-logo" style="background:rgba(255,255,255,.18)">台</div>
        <div><div class="brand-name" style="color:#fff">我的工作台</div><div class="brand-sub" style="color:rgba(255,255,255,.6)">教师个人工作台</div></div>
      </div>
      <div class="auth-hero">
        <h1>把每天的上课、<br>课时、考勤，都放进一个地方。</h1>
        <p>首页看时间与天气，工作里管课时考勤，日常随手记事，学习留下积累。手机、iPad、电脑打开即是同一份数据。</p>
        <div class="auth-feats">
          <div class="auth-feat"><i>${icon('clock', 18)}</i>时间天气一眼看清，出门前就知道穿什么</div>
          <div class="auth-feat"><i>${icon('book', 18)}</i>课时与代课自动汇总，月底对账不吃亏</div>
          <div class="auth-feat"><i>${icon('bell', 18)}</i>到点提醒，手机、平板一起响</div>
        </div>
      </div>
      <div style="font-size:12px;color:rgba(255,255,255,.55)">© ${new Date().getFullYear()} 我的工作台</div>
    </div>
    <div class="auth-main">
      <div class="auth-card" id="auth-card"></div>
    </div>
  </div>`;
  authLogin();
}

function authLogin() {
  const card = document.getElementById('auth-card');
  const tabInfo = authTabsHTML();
  card.innerHTML = `
    <div class="auth-tabs">${tabInfo.html}</div>
    <div id="auth-body"></div>
    <div class="auth-legal">
      <label><input type="checkbox" id="agree" checked><span>我已阅读并同意《服务协议》与《隐私政策》。登录即表示你同意我们按隐私政策处理你的数据。</span></label>
    </div>`;
  document.getElementById('auth-switch').onclick = () => {
    authMode = authMode === 'register' ? 'login' : 'register';
    authLogin();
  };
  authPassword();
}

function checkAgree() {
  const a = document.getElementById('agree');
  if (a && !a.checked) { toast('请先勾选同意服务协议', 'warn'); return false; }
  return true;
}

/* 【已删除】loginQR() + drawQR()
   这两个函数是一套「看起来能用」的假扫码：drawQR 用伪随机数画了一张像二维码的图案，
   手机扫上去不会有任何反应；loginQR 里还有一个「点此模拟手机已确认」的按钮，
   点下去会直接调 /auth/qr/:id/confirm，而那个接口要求调用者已登录——
   也就是自己给自己发授权，等于没有验证。

   真正的扫码登录现在走 authQr()：服务端编码真二维码，手机上打开确认页，
   由已登录的另一台设备点「确认登录」。绑定微信/QQ 必须走开放平台 OAuth，
   本站没接入就明确拒绝（见 /api/auth/bind），不再提供任何「模拟绑定」的旁路。 */

function sheetRaw(title, bodyEl) {
  const mask = el(`<div class="sheet-mask"><div class="sheet">
    <div class="sheet-head"><div class="sheet-title">${esc(title)}</div><button class="icon-btn sheet-close" aria-label="关闭"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>
  </div></div>`);
  mask.querySelector('.sheet').appendChild(bodyEl);
  document.body.appendChild(mask);
  requestAnimationFrame(() => mask.classList.add('in'));
  const h = { onClose: null };
  let closed = false;
  let onKey = null;
  const close = () => {
    if (closed) return; closed = true;
    if (onKey) document.removeEventListener('keydown', onKey);
    mask.classList.remove('in'); setTimeout(() => mask.remove(), 220); h.onClose?.();
  };
  onKey = (e) => {
    if (e.key !== 'Escape') return;
    const masks = document.querySelectorAll('.sheet-mask');
    if (masks[masks.length - 1] !== mask) return;
    e.stopPropagation(); close();
  };
  document.addEventListener('keydown', onKey);
  mask.querySelector('.sheet-close').onclick = close;
  mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
  return { mask, close, set onClose(fn) { h.onClose = fn; } };
}

/* 【账号 + 密码：一个表单同时管登录和注册】
   注册与登录的差别只有两处：要不要输第二遍密码、调哪个接口。
   所以做成同一个表单，authMode 决定文案和提交路径 ——
   这样用户永远只面对两个输入框，不会在页面之间来回跳。 */
function authPassword() {
  const isReg = authMode === 'register';
  const body = document.getElementById('auth-body');
  body.innerHTML = `
    <div class="auth-input"><input id="acct" type="text" autocomplete="username"
      placeholder="账号（3~20 位字母、数字或下划线）" maxlength="20"></div>
    <div class="auth-input"><input id="pwd" type="password" autocomplete="${isReg ? 'new-password' : 'current-password'}"
      placeholder="密码（至少 6 位）" maxlength="32"></div>
    ${isReg ? '<div class="auth-input"><input id="pwd2" type="password" autocomplete="new-password" placeholder="再输一遍密码" maxlength="32"></div>' : ''}
    <button class="auth-btn" id="do-login" style="margin-top:6px">${isReg ? '注册并登录' : '登录'}</button>
    <div class="small muted" style="margin-top:10px;line-height:1.6">
      ${isReg ? '账号密码由你自己设，不需要手机号、不需要短信验证码。' : '账号和密码正确就能进，数据只存在这台设备上。'}
    </div>`;

  const submit = async () => {
    if (!checkAgree()) return;
    const acct = document.getElementById('acct').value.trim();
    const pwd = document.getElementById('pwd').value;
    if (!/^[A-Za-z0-9_]{3,20}$/.test(acct)) return toast('账号要 3~20 位字母、数字或下划线', 'warn');
    if (!pwd || pwd.length < 6) return toast('密码至少 6 位', 'warn');
    if (isReg) {
      const pwd2 = document.getElementById('pwd2').value;
      if (pwd !== pwd2) return toast('两次输入的密码不一致', 'warn');
    }
    const btn = document.getElementById('do-login');
    btn.disabled = true; btn.textContent = isReg ? '注册中…' : '登录中…';
    try {
      const r = isReg
        ? await api.post('/auth/register', { account: acct, password: pwd })
        : await api.post('/auth/login', { account: acct, password: pwd });
      state.user = r.user;
      await loadMe();
      const back = takeQrReturn();
      location.hash = back ? `#/qr?id=${back}` : '#/home';
      render();
      toast(isReg ? '账号已创建，开始使用吧' : '欢迎回来');
    } catch (e) {
      btn.disabled = false; btn.textContent = isReg ? '注册并登录' : '登录';
      toast(e.message || '登录失败', 'err');
    }
  };
  document.getElementById('do-login').onclick = submit;
  /* 回车直接提交，不用去点按钮 */
  body.querySelectorAll('input').forEach((el) => {
    el.onkeydown = (ev) => { if (ev.key === 'Enter') submit(); };
  });
  document.getElementById('acct').focus();
}

/* ================= 忘记密码 =================
   场景是「没配短信 + 密码想不起来」，这时候一切靠短信的自助流程都是死路。
   所以做一个不依赖短信、也不需要用户碰终端的中间态：

     1. 用户填手机号 → 服务端生成一个 8 位取件码（30 分钟有效，用完即焚）
     2. 页面上把取件码和一条现成的命令一起亮出来，点一下就能复制
     3. 有服务器权限的人（我）执行那条命令，密码就重置了
     4. 用户点「我已重置，去登录」

   为什么不做成「填码就改密码」：取件码本来就显示在这个页面上，
   谁能看到这行字谁就能改密码，等于没有验证。只有「得有人去服务器上执行」
   才构成一道真实的门——而这道门恰好是用户本来就有的（他找我就行）。
   ——如果哪天配了短信通道，这套流程会自动退化成短信自助重置，不需要改这里。 */
function forgotSheet(prefillPhone = '') {
  const box = el(`<div class="fp-box">
    <div class="small muted" style="line-height:1.7;margin-bottom:14px">
      本站没配短信，收不到验证码。这里给你一个限时取件码：把它（或者下面那条命令）发给能进服务器的人，执行一下密码就重置了。
    </div>
    <div class="auth-input"><input id="fp-phone" type="tel" inputmode="numeric" maxlength="11" placeholder="请输入注册手机号" value="${esc(prefillPhone)}"></div>
    <button class="auth-btn" id="fp-gen" style="margin-top:4px">生成取件码</button>
    <div id="fp-out"></div>
  </div>`);
  const s = sheet({ title: '找回密码', body: box });
  const out = box.querySelector('#fp-out');
  const btn = box.querySelector('#fp-gen');
  btn.onclick = async () => {
    const phone = box.querySelector('#fp-phone').value.trim();
    if (!/^1[3-9]\d{9}$/.test(phone)) return toast('请输入正确的手机号', 'warn');
    btn.disabled = true; btn.textContent = '生成中…';
    try {
      const r = await api.post('/auth/forgot', { phone });
      btn.hidden = true;
      out.innerHTML = `
        <div class="fp-code-wrap">
          <div class="fp-code-label">取件码（30 分钟内有效）</div>
          <div class="fp-code" id="fp-code">${esc(r.code)}</div>
          <div class="fp-line">
            <input class="input" id="fp-cmd" readonly value="${esc(r.command)}">
            <button class="btn-sm" id="fp-copy">复制</button>
          </div>
        </div>
        <div class="small muted" style="margin-top:12px;line-height:1.7">
          ${r.hasServerAccess
            ? '你也可以自己执行：把上面那条命令粘到服务器终端里回车，然后重新登录即可。'
            : '把上面这条命令发给管理员（或这台服务器的主人），他执行完你就能用新密码登录了。'}
        </div>
        <button class="auth-btn" id="fp-done" style="margin-top:14px">我已重置，去登录</button>`;
      const copy = async (text) => {
        try {
          await navigator.clipboard.writeText(text);
          toast('已复制');
        } catch {
          /* https 下 clipboard 一般都可用；万一被策略拦了，选中让用户自己复制，
             总比只弹一句「复制失败」强。 */
          const i = document.getElementById('fp-cmd'); i?.select();
          toast('已选中，按 Ctrl/⌘+C 复制', 'warn', 4000);
        }
      };
      out.querySelector('#fp-copy').onclick = () => copy(out.querySelector('#fp-cmd').value);
      out.querySelector('#fp-done').onclick = () => s.close();
    } catch (e) {
      btn.disabled = false; btn.textContent = '生成取件码';
      toast(e.message, 'err', 4000);
    }
  };
}

/* ================= 扫一扫（移动端入口 + 摄像头解码） =================

   【为什么需要这个】
   上一个版本「扫码登录」只在电脑上成立：电脑出码，手机用系统相机或微信扫。
   可用户的原话是「移动端要有扫一扫入口」——因为手机上装个扫一扫，
   恰恰是大家对二维码最习惯的用法，而系统相机/微信扫码之后会跳浏览器，
   多一层、还容易跳出登录态。应用自己带一个扫一扫，路径最短。

   【能力分两层，别混】
     1) 摄像头扫码 —— 需要 getUserMedia + 解码器。
        · 解码优先用原生 BarcodeDetector（Chrome/Android 上有，快且准）；
        · 没有就退到 jsQR —— 但项目是零依赖，所以这里**不打包 jsQR**，
          而是先看有没有 BarcodeDetector，没有就如实告诉用户「这个浏览器不支持」，
          并给一条一定能用的替代路径（相册选图 / 直接输码）。
        · 摄像头还要求 HTTPS 或 localhost，线上是 HTTPS，满足。
     2) 手动输入 / 相册选图 —— 永远可用，不依赖任何 API。

   【为什么不干脆引入 jsQR】
   零依赖是这套部署的前提（拷过去就能跑，不需要 npm install 也能起来）。
   为了一个「扫一扫」往 bundle 里塞 30KB 的第三方解码器，代价和收益不成比例。
   原生 API 覆盖不到的浏览器，用「相册选图」兜住即可——那条路本质上也要一个解码器，
   所以只有原生解码可用时才显示入口，不做假按钮。 */

/* 判断当前环境能不能用摄像头扫码。
   解码有两条路，任一可用即可：
     · 原生 BarcodeDetector（Chrome 品牌版、部分 Android、Safari 16+）
     · 自制解码器 qrdecode.js（无依赖，任何现代浏览器都能跑）
   实测 Chromium 全平台都没有 BarcodeDetector —— 所以自制解码器不是备选，是主力。 */
export function scanSupport() {
  const hasNative = typeof window !== 'undefined' && 'BarcodeDetector' in window;
  const hasCamera = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  let secure = true;
  try {
    secure = window.isSecureContext || ['localhost', '127.0.0.1'].includes(location.hostname);
  } catch { secure = false; }
  return { hasNative, hasDecoder: true, hasCamera, secure, camera: hasCamera && secure };
}

/* 把扫到的内容归一化成票据 id。
   别处的扫码工具可能扫到完整链接、也可能只扫到 id，两种都得认；
   认不出来就返回空串，交给调用方提示「这不是本站的码」。 */
export function parseQrTicket(text) {
  const s = String(text || '').trim();
  if (/^[0-9a-f]{32}$/i.test(s)) return s;
  const m = s.match(/[#?&/]qr(?:\?|&)?.*?id=([0-9a-f]{32})/i) || s.match(/[?&]id=([0-9a-f]{32})/i);
  return m ? m[1] : '';
}

/* 用一张图片/视频帧去解码。
   先走原生（快、准），原生不存在就退回自制解码器。
   自制解码器是同步的，包成 Promise 让两条路接口一致。 */
async function decodeFromSource(src) {
  if (typeof window !== 'undefined' && 'BarcodeDetector' in window) {
    try {
      const det = new window.BarcodeDetector({ formats: ['qr_code'] });
      const codes = await det.detect(src);
      if (codes && codes.length && codes[0].rawValue) return codes[0].rawValue;
    } catch {
      /* 原生这条挂了（比如格式不支持）就往下走自制解码器，不直接失败 */
    }
  }
  try {
    return qrDecode(src) || '';
  } catch {
    return '';
  }
}

/* 扫一扫面板：全屏、摄像头预览 + 四角取景框。
   扫到之后不直接登录——只是把 id 交给调用方，让用户看到「这是哪一次的请求」。 */
export function openScanner({ onResult, title = '扫一扫', hint = '对准电脑上的二维码' } = {}) {
  const sup = scanSupport();
  /* 用一个全屏 div 而不是 <dialog>：后面要高 z-index 盖住底部导航，
     dialog 的 top-layer 在部分安卓浏览器里和 fixed 定位配合有问题。 */
  const box = el(`<div class="scan-full" id="scan-full">
    <div class="scan-bar">
      <button class="scan-x" id="scan-x" aria-label="关闭">${icon('close', 22)}</button>
      <div class="scan-title">${esc(title)}</div>
      <div style="width:40px"></div>
    </div>
    <div class="scan-stage">
      <video id="scan-video" playsinline muted autoplay></video>
      <div class="scan-mask">
        <div class="scan-frame"><span></span><span></span><span></span><span></span><i class="scan-line"></i></div>
      </div>
      <div class="scan-msg" id="scan-msg">${esc(hint)}</div>
    </div>
    <div class="scan-foot">
      <label class="scan-alt">
        ${icon('camera', 18)}<span>从相册选图</span>
        <input type="file" accept="image/*" id="scan-file" hidden>
      </label>
      <button class="scan-alt" id="scan-manual">${icon('edit', 18)}<span>手动输入</span></button>
    </div>
  </div>`);
  document.body.appendChild(box);

  let stream = null;
  let raf = null;
  let closed = false;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (raf) { cancelAnimationFrame(raf); raf = null; }
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
    try { box.remove(); } catch {}
  };
  box.querySelector('#scan-x').onclick = () => { cleanup(); };

  const msg = (t, cls = '') => {
    const m = box.querySelector('#scan-msg');
    if (!m) return;
    m.textContent = t;
    m.className = 'scan-msg ' + cls;
  };

  const finish = (text) => {
    const id = parseQrTicket(text);
    if (!id) { msg('这不是本站的登录二维码，换个码试试', 'warn'); return; }
    cleanup();
    onResult && onResult(id);
  };

  /* 相册选图：不依赖摄像头，任何现代浏览器都能走（自制解码器兜底）。
     它的价值在于「摄像头打不开 / 权限被拒 / 摄像头拍不清屏幕」时还有一条路，
     而这几种情况在真实使用里一点都不罕见。 */
  const fileInput = box.querySelector('#scan-file');
  const fileLabel = box.querySelector('.scan-alt');
  if (!fileLabel) {
    /* 结构不对就直接跳过，不让一个可选的入口把整个扫一扫搞崩 */
  } else {
    fileInput.onchange = async () => {
      const f = fileInput.files && fileInput.files[0];
      if (!f) return;
      msg('正在识别…');
      try {
        const bmp = await createImageBitmap(f);
        const text = await decodeFromSource(bmp);
        if (bmp.close) bmp.close();
        if (!text) { msg('这张图里没找到二维码，换一张或裁掉多余部分', 'warn'); return; }
        finish(text);
      } catch (e) {
        msg(e.message || '识别失败', 'warn');
      }
    };
  }

  box.querySelector('#scan-manual').onclick = () => {
    cleanup();
    manualTicketEntry({ onResult });
  };

  /* 起摄像头。权限被拒、设备没有、非 HTTPS —— 三种情况话术不同，
     不能统一说「摄像头不可用」，那等于让用户自己猜。
     注意末尾都指向「相册选图」而不是「手动输入」：前者更接近用户的直觉。 */
  (async () => {
    if (!sup.hasCamera) {
      msg('这台设备没有可用的摄像头，可以用「从相册选图」', 'warn');
      return;
    }
    if (!sup.secure) {
      msg('摄像头只在 HTTPS 下可用，可以用「从相册选图」', 'warn');
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
    } catch (e) {
      const n = e && e.name;
      msg(n === 'NotAllowedError'
        ? '你拒绝了摄像头权限，可以在浏览器设置里重新允许，或用「从相册选图」'
        : n === 'NotFoundError'
          ? '没找到可用的摄像头，可以用「从相册选图」'
          : '摄像头打不开，可以用「从相册选图」', 'warn');
      return;
    }
    if (closed) { stream.getTracks().forEach((t) => t.stop()); return; }
    const video = box.querySelector('#scan-video');
    video.srcObject = stream;
    try { await video.play(); } catch {}

    /* 逐帧解码。用 requestAnimationFrame 而不是 setInterval：
       页面切到后台时 rAF 自动停，不会在后台一直跑着烧电。 */
    let busy = false;
    const tick = async () => {
      if (closed) return;
      if (!busy && video.readyState >= 2) {
        busy = true;
        try {
          const text = await decodeFromSource(video);
          if (text) { finish(text); return; }
        } catch {
          /* 单帧识别失败很正常（糊了、角度不对），不打扰用户，下一帧继续 */
        } finally { busy = false; }
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
  })();

  /* 页面切走（换 hash / 路由重渲染）时也要关摄像头，否则指示灯常亮。
     这里监听 hashchange 而不是复用 onViewLeave：扫一扫是浮层，不属于某个视图。 */
  const onHash = () => cleanup();
  window.addEventListener('hashchange', onHash, { once: true });
  box.addEventListener('click', (e) => { if (e.target === box) cleanup(); });

  return { close: cleanup };
}

/* 手动输入票据：扫不到时唯一的兜底，也方便在电脑上测试。
   让用户直接输 32 位十六进制不现实，所以同时支持粘贴整条链接。 */
export function manualTicketEntry({ onResult } = {}) {
  const box = el(`<div class="scan-full manual-full">
    <div class="scan-bar">
      <button class="scan-x" id="m-x" aria-label="关闭">${icon('close', 22)}</button>
      <div class="scan-title">手动输入</div>
      <div style="width:40px"></div>
    </div>
    <div class="manual-body">
      <p class="manual-p">把扫码后打开的那条链接整段粘贴进来，或者直接填 32 位的票据编号。</p>
      <textarea id="m-input" class="manual-input" rows="3" placeholder="https://…/#/qr?id=xxxxxxxx…"></textarea>
      <div class="manual-err" id="m-err"></div>
      <button class="btn primary" id="m-ok" style="width:100%;height:46px;border-radius:13px">确定</button>
    </div>
  </div>`);
  document.body.appendChild(box);
  const close = () => { try { box.remove(); } catch {} };
  box.querySelector('#m-x').onclick = close;

  const ok = () => {
    const v = box.querySelector('#m-input').value;
    const id = parseQrTicket(v);
    const err = box.querySelector('#m-err');
    if (!id) { err.textContent = '没认出票据编号。请粘贴完整链接，或 32 位编号。'; return; }
    close();
    onResult && onResult(id);
  };
  box.querySelector('#m-ok').onclick = ok;
  box.querySelector('#m-input').oninput = () => { box.querySelector('#m-err').textContent = ''; };
  setTimeout(() => box.querySelector('#m-input')?.focus(), 60);
  return { close };
}

/* 登录页二维码下方那块位置：手机端放「扫一扫」，电脑端放一行提示。
   为什么按设备分：手机上看不到自己的屏幕，出码给自己扫没有意义；
   反过来电脑上有摄像头，但实用场景是「手机已经登录，用手机扫电脑」，不是电脑扫手机。 */
function fillScanSlot() {
  const slot = document.getElementById('qr-scan-slot');
  if (!slot) return;
  const isPhone = isMobileUA();
  if (!isPhone) {
    slot.innerHTML = `<div class="small muted" style="margin-top:2px">
      也可以在手机上打开本站 → 登录页 → 点「扫一扫」来扫这张码</div>`;
    return;
  }
  const sup = scanSupport();
  slot.innerHTML = `<button class="btn primary scan-entry" id="qr-scan-open">
      ${icon('scan', 18)}<span>扫一扫</span>
    </button>
    <div class="small muted" style="margin-top:8px;line-height:1.6">
      ${sup.hasCamera && sup.secure
        ? '扫一下另一台设备上的二维码，就能登录这台手机'
        : '这台设备打不开摄像头，可以用「从相册选图」或「手动输入」'}</div>`;
  const btn = document.getElementById('qr-scan-open');
  if (btn) {
    btn.onclick = () => {
      /* 保持当前网址的 hash 不变地把 id 填进去：
         扫到的是「另一台设备」的票据，所以不能拿本页那张。
         扫到后直接跳到确认页，由用户本人决定确认还是拒绝。 */
      openScanner({
        title: '扫一扫登录',
        hint: '对准另一台设备上的二维码',
        onResult: (id) => { location.hash = `#/qr?id=${id}`; render(); },
      });
    };
  }
}

/* UA 判断只用来决定「显示哪个入口」，不承担任何安全职责。
   真正的权限判断在服务端，前端猜错了最多是少显示一个按钮。 */
function isMobileUA() {
  try {
    const ua = navigator.userAgent || '';
    if (/iPad|iPhone|iPod/.test(ua)) return true;
    /* iPadOS 13+ 默认伪装成 macOS 的 UA，靠触摸点数区分 */
    if (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) return true;
    return /Android|Mobile|HarmonyOS/i.test(ua) && !/Windows NT/i.test(ua);
  } catch { return false; }
}

/* WorkBuddy 统一登录：整页跳转到 workbuddy.cn 授权，回来由服务端种 Cookie。
   失败时不再悄悄弹出假二维码，而是把原因说清楚——用户需要知道是「没配置」还是「配错了」。 */
export async function startWorkBuddyLogin(purpose = 'login') {
  try {
    const d = await api.get(`/auth/workbuddy/start${purpose !== 'login' ? '?purpose=' + encodeURIComponent(purpose) : ''}`);
    location.href = d.url;
  } catch (e) {
    if (e.extra?.notConfigured) {
      toast('WorkBuddy 登录未开通：需要先在开放平台注册应用并填写客户端凭证', 'warn');
    } else {
      toast(e.message || 'WorkBuddy 登录暂时不可用', 'err');
    }
  }
}

/* ---------------- 扫码确认页（#/qr?id=xxx） ----------------
   手机扫到二维码后打开的就是这一页。它是整条扫码登录里唯一由「人」做决定的地方：
   屏幕上必须让用户看清「哪台设备、什么时候、从哪儿」在请求登录，
   然后由他点确认或拒绝。没有这一步，拿着一张被转发的二维码就能登进来。 */
function renderQrConfirm(id) {
  const app = document.getElementById('app');
  const head = `<div class="qrc-head">
      <div class="brand-logo" style="background:var(--primary)">台</div>
      <div class="qrc-title">扫码登录</div>
    </div>`;

  if (!id) {
    app.innerHTML = `<div class="qrc-page">${head}
      <div class="qrc-card"><div class="qrc-empty">${icon('alert', 30)}<p>链接里没有票据编号，无法确认。</p>
      <button class="btn primary" id="qrc-go">去工作台</button></div></div></div>`;
    document.getElementById('qrc-go').onclick = () => { location.hash = '#/home'; };
    return;
  }

  /* 未登录：先把来龙去脉说清楚，登录完再回到这一页。
     注意要把 id 记住（sessionStorage），登录成功后自动跳回来，
     否则用户登录完落到首页，还得重新扫一次码。 */
  if (!state.user) {
    app.innerHTML = `<div class="qrc-page">${head}
      <div class="qrc-card">
        <div class="qrc-ico">${icon('bell', 30)}</div>
        <div class="qrc-h">需要先登录这台手机</div>
        <p class="qrc-p">扫码登录是「用一台已登录的设备，授权另一台设备登录」。
          你现在这台手机还没登录，所以先登录一下自己，然后再回来确认这次请求。</p>
        <button class="btn primary" id="qrc-login">去登录</button>
      </div></div>`;
    document.getElementById('qrc-login').onclick = () => {
      try { sessionStorage.setItem('wb_qr_return', id); } catch {}
      location.hash = '#/home';
    };
    return;
  }

  app.innerHTML = `<div class="qrc-page">${head}
    <div class="qrc-card" id="qrc-card">
      <div class="qrc-loading">正在获取这次登录请求…</div>
    </div></div>`;
  const card = document.getElementById('qrc-card');

  const fail = (msg, showRetry = false) => {
    card.innerHTML = `<div class="qrc-ico warn">${icon('alert', 28)}</div>
      <div class="qrc-h">${esc(msg)}</div>
      <p class="qrc-p">为安全起见，二维码 3 分钟内有效、且只能用一次。请回到要登录的设备上刷新后重新扫码。</p>
      <button class="btn primary" id="qrc-home">回到工作台</button>`;
    document.getElementById('qrc-home').onclick = () => { location.hash = '#/home'; };
  };

  (async () => {
    let info;
    try {
      info = await api.get(`/auth/qr/${encodeURIComponent(id)}/peek`, null, { silent: true });
    } catch (e) {
      fail(e.message || '这次登录请求已失效');
      return;
    }
    /* peek 是一个网络往返。回来的时候，用户可能已经点了「回到工作台」、
       或者被别的地方的 render() 换掉了整个 #app —— 这时 card 已经不是文档里的节点了。
       继续往下写，轻则把内容写进一段没人看的空壳，重则 getElementById 拿到 null 报错。
       所以每次 await 回来都重新确认一次「锚点还在页面上」。 */
    if (!card.isConnected) return;
    if (info.status === 'expired') return fail('二维码已过期');
    if (info.status === 'confirmed') return fail('这次登录已经被确认过了');
    if (info.status === 'rejected') return fail('这次登录已被拒绝');

    const when = info.created_at ? new Date(Number(info.created_at)) : null;
    const hhmm = when ? `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}` : '';
    card.innerHTML = `
      <div class="qrc-ico">${icon('zap', 30)}</div>
      <div class="qrc-h">有设备请求登录</div>
      <div class="qrc-info">
        <div class="qrc-row"><span>设备</span><b>${esc(info.device || '未知设备')}</b></div>
        <div class="qrc-row"><span>时间</span><b>${esc(hhmm || '刚刚')}</b></div>
        <div class="qrc-row"><span>账号</span><b>${esc(state.user.nickname || state.user.phone || '我')}</b></div>
      </div>
      <p class="qrc-p">如果不是你在操作，请点「不是我」——这台设备不会登进来。</p>
      <div class="qrc-acts">
        <button class="btn" id="qrc-reject">不是我</button>
        <button class="btn primary" id="qrc-accept">确认登录</button>
      </div>`;

    const act = async (action) => {
      card.querySelectorAll('button').forEach((b) => { b.disabled = true; });
      try {
        await api.post(`/auth/qr/${encodeURIComponent(id)}/confirm`, { action });
      } catch (e) {
        if (card.isConnected) fail(e.message || '操作失败');
        return;
      }
      /* 同样要再确认一次：confirm 也是一个往返，回来时页面可能已经被换掉了。
         原来这里直接 getElementById('qrc-home2').onclick = ...，
         一旦节点不在就抛 TypeError，用户那边表现为「点了没反应、控制台报红」。 */
      if (!card.isConnected) return;
      if (action === 'reject') {
        card.innerHTML = `<div class="qrc-ico ok">${icon('check', 30)}</div>
          <div class="qrc-h">已拒绝</div>
          <p class="qrc-p">那台设备不会登录进来。如果是你自己在换设备，回去重新扫一次码即可。</p>
          <button class="btn primary" id="qrc-home2">回到工作台</button>`;
      } else {
        card.innerHTML = `<div class="qrc-ico ok">${icon('check', 30)}</div>
          <div class="qrc-h">已确认，那台设备正在登录</div>
          <p class="qrc-p">可以关掉这一页了。你随时能在「我的 → 登录设备」里把不认识的设备踢出去。</p>
          <button class="btn primary" id="qrc-home2">回到工作台</button>`;
      }
      const home2 = document.getElementById('qrc-home2');
      if (home2) home2.onclick = () => { location.hash = '#/home'; };
    };
    document.getElementById('qrc-accept').onclick = () => act('accept');
    document.getElementById('qrc-reject').onclick = () => act('reject');
  })();
}

/* ---------------- 用户态 ---------------- */
export async function loadMe() {
  try {
    const r = await api.get('/auth/me', null);
    state.user = r.user;
    if (state.user?.settings?.theme) { /* 账号主题优先 */ }
    refreshUnread();
  } catch { state.user = null; }
  return state.user;
}
export async function refreshUnread() {
  if (!state.user) return; // 未登录不发请求，避免登录页出现 401
  try {
    const m = await api.get('/messages', null, { silent: true });
    state.unread = m.unread;
    paintUnread();
  } catch {}
}

/* 把未读数刷到导航上。
   这里有个必须说清楚的坑：navHTML 渲染时是 `state.unread ? '<span class=badge-dot>' : ''`，
   也就是说未读数从 0 变成有新消息时，**页面上根本没有这个节点**，只改 textContent 是改空气。
   之前只处理了「有→无」（隐藏）这一半，所以「点全部已读角标不消失」和
   「来了新消息角标不出现」是两个方向同一个 bug。
   现在两种方向都兜住：没有节点就建一个，有了就改文字，归零就隐藏。 */
/* 未读红点。
   【第 1 条：点「全部已读」后左侧导航红点不消失】
   真因是侧栏底部的用户按钮（#side-user）早先没有 data-nav="me"，
   而这里只认 [data-nav=me] —— 于是「我的」那一项的红点永远刷不到，
   点完已读它还挂在那儿。现在补上属性，同时把「只创建不更新」的写法改掉：
   数字变了要跟着变，不然从 3 变成 1 还显示 3。 */
export function paintUnread() {
  const n = Number(state.unread) || 0;
  document.querySelectorAll('[data-nav=me]').forEach((nav) => {
    let dot = nav.querySelector('.badge-dot');
    if (n <= 0) { if (dot) dot.hidden = true; return; }
    if (!dot) {
      dot = document.createElement('span');
      dot.className = 'badge-dot';
      nav.appendChild(dot);
    }
    dot.textContent = n > 99 ? '99+' : String(n);
    dot.hidden = false;
  });
  /* 底部导航的手机端也要同步：手机上根本没有侧栏 */
  document.querySelectorAll('.bn-item[data-nav=me]').forEach((nav) => {
    let dot = nav.querySelector('.badge-dot');
    if (n <= 0) { if (dot) dot.hidden = true; return; }
    if (!dot) {
      dot = document.createElement('span');
      dot.className = 'badge-dot';
      nav.appendChild(dot);
    }
    dot.textContent = n > 99 ? '99+' : String(n);
    dot.hidden = false;
  });
}

export function setUser(u) { state.user = u; }
export { authLogin };

window.addEventListener('wb:unauth', () => { if (state.user) { state.user = null; renderAuth(); } });
