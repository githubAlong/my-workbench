/* ================= 惩罚盲盒（从 work.js 抽离） =================
   原来和「课件 / 课堂签到」一起塞在「工作 › 课件」里，
   现在独立成「小助手 › 盲盒」一级子页面，逻辑不变。 */
import {
  api, el, esc, toast, sheet, confirmDialog, ymd, fmtTime,
} from './core.js';
import { registerView, icon, pageHead } from './ui.js';

/* 惩罚盲盒：学生抽到什么，这里能看到；任务清单也在这里维护 */
const LV_TXT = { light: '轻松', average: '有点挑战', heavy: '大冒险' };
const LV_COLOR = { light: 'green', average: 'amber', heavy: 'red' };
function paintPunishCard(items, records) {
  const today = records.filter((r) => r.source === 'student');
  return `<div class="card card-pad punish-card">
    <div class="row wrap" style="gap:10px;align-items:center">
      <div style="flex:1;min-width:180px">
        <div class="bold">${icon('gift', 15)} 惩罚盲盒<span class="tiny muted" style="margin-left:6px">${items.length} 个任务</span></div>
        <div class="small muted">学生点「抽任务」随机弹一个，抽到什么这里立刻能看到。</div>
      </div>
      <button class="btn ghost sm" id="pb-add">${icon('plus', 15)} 加任务</button>
      ${items.length ? `<button class="btn ghost sm" id="pb-seed">补经典任务</button>` : ''}
    </div>
    ${items.length ? `<div class="pb-list">
      ${items.map((p) => `<div class="pb-row">
        <span class="chip ${LV_COLOR[p.level] || 'grey'}">${LV_TXT[p.level] || '任务'}</span>
        <span class="pb-text">${esc(p.text)}</span>
        <button class="icon-btn sm" data-pb-edit="${p.id}">${icon('edit', 14)}</button>
        <button class="icon-btn sm" data-pb-del="${p.id}">${icon('close', 13)}</button>
      </div>`).join('')}
    </div>` : '<div class="empty" style="padding:18px 0">还没有任务，点「加任务」或「补默认任务」开始</div>'}
    ${today.length ? `<div class="pb-recent">
      <div class="tiny muted" style="margin:10px 0 6px">今天学生抽到的（${today.length} 条）</div>
      ${today.slice(0, 6).map((r) => `<div class="pb-rec">
        <span class="chip ${r.stu_name ? 'blue' : 'grey'}">${esc(r.stu_name || '匿名')}</span>
        <span class="pb-rtext">${esc(r.text)}</span>
        <span class="tiny muted">${esc(fmtTime(r.created_at))}</span>
      </div>`).join('')}
    </div>` : ''}
  </div>`;
}
/* 抽任务弹层：标题 + 等级 */
function punishEditor(p, reload) {
  const body = el(`<div class="sheet-body">
    <div class="field"><label class="field-label">任务内容</label>
      <input class="input" id="t" value="${esc(p?.text || '')}" placeholder="如：唱歌 30 秒 / 做 20 个深蹲"></div>
    <div class="field"><label class="field-label">强度</label>
      <select class="input" id="lv">
        <option value="light" ${p?.level === 'light' || !p ? 'selected' : ''}>轻松（唱歌、讲笑话）</option>
        <option value="average" ${p?.level === 'average' ? 'selected' : ''}>有点挑战（领读、讲题）</option>
        <option value="heavy" ${p?.level === 'heavy' ? 'selected' : ''}>大冒险（深蹲 20 个、下节课复盘）</option>
      </select></div>
    <div class="confirm-actions"><button class="btn ghost" id="cancel">取消</button>
      <button class="btn primary" id="ok">${p ? '保存' : '添加'}</button></div>
  </div>`);
  const s = sheet({ title: p ? '编辑任务' : '新增任务', body });
  body.querySelector('#cancel').onclick = () => s.close();
  body.querySelector('#ok').onclick = async () => {
    const text = body.querySelector('#t').value.trim();
    if (!text) return toast('先写上任务内容', 'err');
    const level = body.querySelector('#lv').value;
    try {
      if (p) await api.patch('/punishments/' + p.id, { text, level });
      else await api.post('/punishments', { text, level, active: 1 });
      s.close(); toast(p ? '已保存' : '已添加'); reload();
    } catch (e) { toast(e.message, 'err'); }
  };
}

async function renderBlindbox(box) {
  const load = async () => {
    const [punishes, punRecs] = await Promise.all([
      api.get('/punishments').catch(() => []),
      api.get('/punish/records', { date: ymd(new Date()) }).catch(() => []),
    ]);
    box.innerHTML = paintPunishCard(punishes, punRecs);
    box.querySelector('#pb-add')?.addEventListener('click', () => punishEditor(null, load));
    box.querySelectorAll('[data-pb-edit]').forEach((b) => {
      b.onclick = () => punishEditor(punishes.find((p) => String(p.id) === b.dataset.pbEdit), load);
    });
    box.querySelectorAll('[data-pb-del]').forEach((b) => {
      b.onclick = async () => {
        if (!(await confirmDialog('删掉这个任务？学生就抽不到它了。'))) return;
        await api.del('/punishments/' + b.dataset.pbDel); toast('已删除'); load();
      };
    });
    box.querySelector('#pb-seed')?.addEventListener('click', async () => {
      if (!(await confirmDialog('补一批经典任务（唱歌、深蹲、领读等 12 个，自动跳过已有的）？'))) return;
      const have = new Set(punishes.map((p) => p.text.trim()));
      const seeds = [
        ['唱歌 30 秒：随便唱一首，全班跟拍', 'light'],
        ['讲个笑话，要让人笑出来', 'light'],
        ['做 20 个深蹲', 'heavy'],
        ['做 15 个开合跳', 'average'],
        ['领读今天的课文段落', 'average'],
        ['当小老师：给全班讲一道题', 'average'],
        ['用一句话总结这节课的重点', 'average'],
        ['30 秒英文自我介绍', 'heavy'],
        ['背诵一句名言并解释意思', 'light'],
        ['给同桌讲一遍刚才的题目', 'average'],
        ['下节课开头用 1 分钟回顾今天内容', 'heavy'],
        ['整理讲台与板书', 'light'],
      ].filter(([t]) => !have.has(t));
      if (!seeds.length) return toast('这些任务都已经有了');
      for (const [text, level] of seeds) {
        await api.post('/punishments', { text, level, active: 1 }).catch(() => {});
      }
      toast(`已补 ${seeds.length} 个任务`); load();
    });
  };
  await load();
}

registerView(async function blindbox(main) {
  main.innerHTML = pageHead('盲盒', '惩罚盲盒——学生点「抽任务」随机弹一个，抽到什么这里立刻能看到')
    + '<div id="pb-body"></div>';
  const box = main.querySelector('#pb-body');
  await renderBlindbox(box);
});
