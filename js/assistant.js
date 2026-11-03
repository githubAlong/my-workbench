/* ================= 小助手（一级目录） =================
   把「自习 / 抽人 / 盲盒 / 教材」四个常用教学小工具收进同一个一级入口，
   既解决一级导航越来越长的问题，又让这些高频但轻量的功能有统一落脚点。
   小助手本身是一个「工具箱首页」：点任意卡片直达对应独立子页面。
   这四个子页面各自 registerView 注册在 ui.js 的 views 字典里，
   路由分别是 #/selfstudy #/roll #/blindbox #/materials。 */
import { registerView, icon, pageHead, go } from './ui.js';

const TOOLS = [
  { id: 'selfstudy', icon: 'clock', title: '自习', desc: '记晚自习、早读、周末自习——哪个班、第几节、做了什么' },
  { id: 'roll', icon: 'users', title: '抽人', desc: '课堂签到：学生扫码点「我到了」，这里实时长出人数' },
  { id: 'blindbox', icon: 'gift', title: '盲盒', desc: '惩罚盲盒：学生抽任务，抽到什么立刻能看到' },
  { id: 'materials', icon: 'book', title: '教材', desc: '上传课件、分类管理，学生短链可看可下载' },
];

registerView(async function assistant(main) {
  main.innerHTML = pageHead('小助手', '自习 · 抽人 · 盲盒 · 教材，常用教学小工具一站式入口')
    + `<div class="as-grid">${TOOLS.map((t) => `
      <button class="card as-card" data-tool="${t.id}">
        <span class="as-ico">${icon(t.icon, 26)}</span>
        <span class="as-title">${t.title}</span>
        <span class="as-desc">${t.desc}</span>
        <span class="as-go">${icon('right', 16)}</span>
      </button>`).join('')}</div>`;
  main.querySelectorAll('[data-tool]').forEach((b) => { b.onclick = () => go(b.dataset.tool); });
});
