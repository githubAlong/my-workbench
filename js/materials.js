/* ================= 教材 / 课件（从 work.js 抽离） =================
   原来和「课堂签到 / 惩罚盲盒」一起塞在「工作 › 课件」里，
   现在独立成「小助手 › 教材」一级子页面。
   课堂签到去了 roll.js，惩罚盲盒去了 blindbox.js，这里只管课件与学生短链。 */
import {
  api, el, esc, clsName, toast, sheet, confirmDialog, promptDialog,
} from './core.js';
import { registerView, icon, pageHead } from './ui.js';
import { uploadTo } from './work.js';

/* 学生短链：把当前访问凭据（?sharecode= 之类）一并带上，
   否则学生打开会遇到「链接不完整」的拦截页 */
function studentUrl(code) {
  if (!code) return '';
  const qs = new URLSearchParams(location.search);
  // 只透传平台要求的访问参数，其余（utm 等）不带
  const keep = new URLSearchParams();
  for (const k of ['sharecode', 'code', 'access']) {
    const v = qs.get(k);
    if (v) keep.set(k, v);
  }
  const q = keep.toString();
  return `${location.origin}/s/${code}${q ? '?' + q : ''}`;
}

/* 屏幕上只显示路径部分。
   真正的短链主体是 /s/feutnv 这 9 个字符，复制时再补全成完整地址。 */
function shortPath(code) {
  if (!code) return '';
  return `/s/${code}`;
}

async function renderMaterials(box) {
  let currentCat = 0;
  const load = async () => {
    const [cats, mats, links] = await Promise.all([
      api.get('/categories', { scope: 'material' }), api.get('/materials'), api.get('/links'),
    ]);
    const link = links[0];
    const list = currentCat ? mats.filter((m) => Number(m.category_id) === currentCat) : mats;
    box.innerHTML = `
      <div class="card card-pad" style="margin-bottom:14px;background:var(--primary-weak);border-color:transparent">
        <div class="row wrap" style="gap:10px">
          <div style="flex:1;min-width:200px"><div class="bold">${icon('route', 15)} 学生访问短链</div>
            <div class="small muted">学生打开这个链接即可签到、看课件、抽题，不用登录。</div></div>
          <code class="mono link-short" id="link-url" title="${esc(studentUrl(link?.code))}">${esc(link ? shortPath(link.code) : '尚未生成')}</code>
          <button class="btn ghost sm" id="copy-link" ${link ? '' : 'disabled'}>${icon('copy', 14)} 复制</button>
          ${link ? `<a class="btn ghost sm" href="${esc(studentUrl(link.code))}" target="_blank">预览</a>` : ''}
          ${link ? '' : '<button class="btn primary sm" id="new-link">生成短链</button>'}
        </div>
      </div>

      <div class="row wrap" style="gap:8px;margin-bottom:12px">
        <button class="btn primary sm" id="upload-mat">${icon('upload', 15)} 上传课件</button>
        <button class="btn ghost sm" id="new-cat">＋ 新建分类</button>
        <span style="flex:1"></span>
        <input class="input" id="mat-search" placeholder="搜索课件…" style="max-width:200px;height:34px">
      </div>
      <div class="doc-grid">
        <div class="card card-pad"><div class="cat-list">
          <button class="cat-item ${currentCat === 0 ? 'active' : ''}" data-cat="0">${icon('folder',15)} 全部 <span class="tiny muted">${mats.length}</span></button>
          ${cats.map((c) => `<button class="cat-item ${currentCat === c.id ? 'active' : ''}" data-cat="${c.id}">${icon('folder',15)} ${esc(c.name)}
            <span class="tiny muted">${mats.filter((m) => Number(m.category_id) === c.id).length}</span>
            <span class="spacer"></span><span class="cat-ops" data-cid="${c.id}" style="opacity:.5">⋯</span></button>`).join('')}
        </div></div>
        <div class="card" id="mat-list"></div>
      </div>`;
    box.querySelector('#new-cat').onclick = async () => {
      const name = await promptDialog({ title: '新建分类', label: '分类名称', placeholder: '如：必修上册 / 作文素材' });
      if (name) { await api.post('/categories', { scope: 'material', name }); load(); }
    };
    box.querySelectorAll('.cat-ops').forEach((b) => {
      b.onclick = async (e) => {
        e.stopPropagation();
        const c = cats.find((x) => String(x.id) === b.dataset.cid);
        const body = el(`<div class="sheet-body"><div class="field"><label class="field-label">分类名称</label><input class="input" id="n" value="${esc(c.name)}"></div>
          <div class="confirm-actions"><button class="btn ghost" id="d" style="color:var(--red);margin-right:auto">删除分类</button>
          <button class="btn primary" id="k">保存</button></div></div>`);
        const s = sheet({ title: '编辑分类', body });
        body.querySelector('#k').onclick = async () => { await api.patch('/categories/' + c.id, { name: body.querySelector('#n').value }); s.close(); load(); };
        body.querySelector('#d').onclick = async () => {
          const used = mats.filter((m) => Number(m.category_id) === c.id).length;
          if (used && !(await confirmDialog(`这个分类下还有 ${used} 份课件，删除分类后它们会变成「未分类」，课件本身不会丢。继续？`))) return;
          try {
            await api.del('/categories/' + c.id);
            if (currentCat === c.id) currentCat = 0;
            s.close(); toast('分类已删除'); load();
          } catch (err) { toast(err.message, 'err'); }
        };
      };
    });
    box.querySelectorAll('[data-cat]').forEach((b) => { b.onclick = () => { currentCat = Number(b.dataset.cat); load(); }; });
    box.querySelector('#copy-link').onclick = async () => {
      const url = studentUrl(link?.code);
      try { await navigator.clipboard.writeText(url); toast('已复制，直接发给学生'); } catch { prompt('复制下面的链接', url); }
    };
    box.querySelector('#new-link')?.addEventListener('click', async () => { await api.post('/links', { title: '班级资料站' }); load(); });
    box.querySelector('#upload-mat').onclick = () => materialEditor(null, currentCat, load);
    box.querySelector('#mat-search').oninput = (e) => {
      const q = e.target.value.trim();
      paintMats(mats.filter((m) => !q || m.title.includes(q) || (m.descr || '').includes(q)), load);
    };
    paintMats(list, load);
  };
  await load();
}
async function paintMats(list, reload) {
  const box = document.querySelector('#mat-list');
  if (!list.length) { box.innerHTML = '<div class="empty">这个分类还没有课件，点「上传课件」开始</div>'; return; }
  box.innerHTML = '';
  for (const m of list) {
    const files = await api.get('/attachments', { owner_type: 'material', owner_id: m.id }).catch(() => []);
    const item = el(`<div class="list-item">
      <div class="doc-ico">${icon('file', 18)}</div>
      <div style="flex:1;min-width:0">
        <div class="row wrap" style="gap:8px"><span class="bold">${esc(m.title)}</span>
          ${m.grade || m.class_name ? `<span class="chip">${esc(clsName(m.grade, m.class_name))}</span>` : ''}
          ${m.public ? '<span class="chip green">学生可见</span>' : '<span class="chip">仅自己</span>'}</div>
        <div class="tiny muted">${esc(m.descr || '')} · 浏览 ${m.views || 0} · 下载 ${m.downloads || 0}</div>
        <div class="row wrap" style="gap:6px;margin-top:6px">${files.map((f) => `<a class="chip blue" href="${f.url}?dl=1" download>${esc(f.name).slice(0, 18)}</a>`).join('') || '<button class="chip-btn" data-up="1">＋ 上传文件</button>'}</div>
      </div>
      <button class="icon-btn sm" data-e="1">${icon('edit', 15)}</button>
      <button class="icon-btn sm" data-d="1">${icon('close', 14)}</button>
    </div>`);
    item.querySelector('[data-up]')?.addEventListener('click', () => uploadTo('material', m.id, reload));
    item.querySelector('[data-e]').onclick = () => materialEditor(m, m.category_id, reload);
    item.querySelector('[data-d]').onclick = async () => { if (await confirmDialog('删除这份课件？可在回收站找回。')) { await api.del('/materials/' + m.id); reload(); } };
    box.appendChild(item);
  }
}
async function materialEditor(m, catId, reload) {
  const isNew = !m;
  const cats = await api.get('/categories', { scope: 'material' });
  const body = el(`<div class="sheet-body">
    <div class="field"><label class="field-label">标题</label><input class="input" id="t" value="${esc(m?.title || '')}" placeholder="如：《劝学》第一课时 PPT"></div>
    <div class="form-grid">
      <div class="field"><label class="field-label">分类</label><select class="input" id="cat"><option value="">未分类</option>${cats.map((c) => `<option value="${c.id}" ${Number(m?.category_id || catId) === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
      <div class="field"><label class="field-label">班级</label><input class="input" id="cls" value="${esc(m?.class_name || '')}"></div>
      <div class="field"><label class="field-label">年级</label><input class="input" id="grade" value="${esc(m?.grade || '高二')}"></div>
      <div class="field"><label class="field-label">学生可见</label><select class="input" id="pub"><option value="1" ${m?.public !== 0 ? 'selected' : ''}>是（短链可看）</option><option value="0" ${m?.public === 0 ? 'selected' : ''}>否</option></select></div>
    </div>
    <div class="field"><label class="field-label">说明</label><textarea class="input" id="d" rows="2">${esc(m?.descr || '')}</textarea></div>
    <div class="field"><label class="field-label">文件（可多选）</label>
      <input type="file" id="f" multiple class="small"
        accept=".pptx,.ppt,.ppsx,.pdf,.doc,.docx,.xls,.xlsx,.txt,.md,.zip,.rar,.7z,.png,.jpg,.jpeg,.gif,.webp,.mp4,.mov,.mp3,.wav">
      <div class="field-hint" style="margin-top:6px">
        <b>默认就是 PPT（.pptx）</b>，其余格式也都能传：
        PDF、Word、Excel、图片、视频、压缩包都行。
        <br>选文件时如果找不到某个格式，把筛选切到「所有文件」即可——这里只是默认帮你把常用格式排在前面。
      </div></div>
    <div class="field-hint">上传后学生打开短链即可在线预览或下载，解决忘带 U 盘、班级电脑接口损坏的问题。</div>
    <div class="confirm-actions"><button class="btn ghost" id="c">取消</button><button class="btn primary" id="k">保存</button></div></div>`);
  const s = sheet({ title: isNew ? '上传课件' : '编辑课件', body, wide: true });
  body.querySelector('#c').onclick = s.close;
  body.querySelector('#k').onclick = async () => {
    const payload = { title: body.querySelector('#t').value.trim() || '未命名课件', category_id: Number(body.querySelector('#cat').value) || null,
      class_name: body.querySelector('#cls').value, grade: body.querySelector('#grade').value,
      descr: body.querySelector('#d').value, public: Number(body.querySelector('#pub').value) };
    const r = isNew ? await api.post('/materials', payload) : await api.patch('/materials/' + m.id, payload);
    const files = body.querySelector('#f').files;
    if (files.length) {
      const fd = new FormData();
      for (const f of files) fd.append('files', f, f.name);
      fd.append('owner_type', 'material'); fd.append('owner_id', String(r.id));
      await api.req('POST', '/upload', fd);
    }
    s.close(); toast('已保存'); reload();
  };
}

registerView(async function materials(main) {
  main.innerHTML = pageHead('教材', '上传课件、分类管理，学生打开短链即可在线预览或下载')
    + '<div id="mat-body"></div>';
  const box = main.querySelector('#mat-body');
  await renderMaterials(box);
});
