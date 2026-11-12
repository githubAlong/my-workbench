/* ==========================================================================
   清理示例数据（「我的 → 数据管理」入口）

   用户诉求：测试环境里系统自动灌的假课表 / 假名单 / 示例考勤等混在真实数据里，
   影响正常录入。这里只删「原始示例记录」，用户自己录入的和改过示例的记录全保留。

   三道保险：
     1. 先列出逐表预览清单，让用户看清会删什么；
     2. 执行前强制下载一份完整备份，下载失败立即中止、一个字节都不改；
     3. 要手打「清空」两个字才能点确认（照抄 attreset 的防手滑设计）。

   清理后会把本机 + 云端快照一起更新，并写好 meta.seeded / meta.importedAt，
   否则 seedIfEmpty 会在下次刷新把示例数据再灌回来。
   ========================================================================== */

import { el, esc, toast, sheet, saveBlob } from './core.js';
import { load, save, exportJSON } from './localdb.js';
import { scanDemoData, collectRemovable } from './demo-data-scan.mjs';

export function hasDemoData() {
  try { return scanDemoData(load()).found; } catch { return false; }
}

function backupName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `工作台完整备份-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.json`;
}

function stampText(ms) {
  try { return new Date(ms).toLocaleString('zh-CN'); } catch { return String(ms); }
}

export function openCleanDemoSheet() {
  const scan = scanDemoData(load());
  if (!scan.found) {
    toast('没有找到需要清理的示例数据', 'ok');
    return;
  }

  const rows = scan.groups.map((g) =>
    `<tr><td>${esc(g.label)}</td><td class="demo-num">${g.remove}</td>` +
    `<td class="demo-num">${g.keep ? g.keep : '—'}</td></tr>`
  ).join('');

  const body = el(
    '<div class="demo-clean">' +
      '<p class="demo-clean-lead">检测到系统首次启动时自动灌入的一批示例数据（时间：' +
        esc(stampText(scan.stamp)) + '）。下面这些<strong>从未被修改过</strong>的记录会被删除，共 <strong>' +
        scan.total + '</strong> 条。</p>' +
      '<div class="demo-clean-table"><table><thead><tr><th>数据</th><th>将删除</th><th>改过·保留</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table></div>' +
      '<div class="demo-clean-notes">' +
        '<p>· 你自己后来录入的记录<strong>全部保留</strong>；被你改过的示例记录也保留。</p>' +
        '<p>· 教师名册、计费规则、搬家链接等不参与清理。</p>' +
        '<p>· 点确认时会先<strong>自动下载一份完整备份</strong>；清理后本机与云端一起更新，示例数据不会自己长回来。</p>' +
      '</div>' +
      '<label class="field-label" for="demo-clean-word">确认请输入「清空」两个字</label>' +
      '<input class="input" id="demo-clean-word" placeholder="清空" autocomplete="off">' +
    '</div>'
  );
  const footer = el(
    '<div class="sync-dialog-actions">' +
      '<button class="btn ghost" data-demo-cancel type="button">取消</button>' +
      '<button class="btn danger" data-demo-ok type="button" disabled>导出备份并清理</button>' +
    '</div>'
  );
  const dialog = sheet({ title: '清理示例数据', body, footer, wide: true, cls: 'demo-clean-sheet' });
  const word = body.querySelector('#demo-clean-word');
  const okBtn = footer.querySelector('[data-demo-ok]');
  footer.querySelector('[data-demo-cancel]').onclick = dialog.close;
  word.oninput = () => { okBtn.disabled = word.value.trim() !== '清空'; };
  okBtn.onclick = async () => {
    if (word.value.trim() !== '清空') return;
    okBtn.disabled = true;
    dialog.close();
    await runClean(scan.stamp, scan.total);
  };
}

async function runClean(stamp, total) {
  /* ---------- 1. 强制备份，失败即中止 ---------- */
  try {
    const payload = JSON.stringify({ v: 1, kind: 'workbench-full-backup', at: new Date().toISOString(), db: exportJSON() }, null, 2);
    saveBlob(new Blob([payload], { type: 'application/json' }), backupName());
  } catch (error) {
    toast('备份下载失败，已中止清理，没有动任何数据：' + (error?.message || error), 'err', 7000);
    return;
  }

  /* ---------- 2. 只删原始示例记录 ---------- */
  const db = load();
  const removable = collectRemovable(db, stamp);
  let removed = 0;
  for (const [table, rows] of removable) {
    const before = db[table].length;
    db[table] = db[table].filter((row) => !rows.has(row));
    removed += before - db[table].length;
  }
  if (!removed) {
    toast('没有可删除的记录，未改动数据', 'warn');
    return;
  }
  db.meta = db.meta || {};
  delete db.meta.seedFiles;
  /* 这两个标记缺一个，刷新后 seedIfEmpty 就会把示例数据再灌一遍 */
  db.meta.seeded = true;
  db.meta.importedAt = new Date().toISOString();
  db.meta.demoCleanedAt = new Date().toISOString();
  try {
    save();
  } catch (error) {
    toast('本机保存失败，请在同步状态里先处理冲突后重试：' + (error?.message || error), 'err', 7000);
    return;
  }

  /* ---------- 3. 把清理后的快照推到云端，防止同步把旧数据拉回来 ---------- */
  let cloudOk = true;
  try {
    const m = await import('./cloudsync.js');
    await m.pushNow();
  } catch {
    cloudOk = false;
  }
  toast(
    cloudOk
      ? `已清理 ${removed} 条示例数据，备份已下载；本机与云端都已更新`
      : `已清理 ${removed} 条示例数据并下载备份；云端同步未就绪，联网登录后会自动补上`,
    cloudOk ? 'ok' : 'warn',
    6000
  );
  /* 各页面内存里还留着旧数据，刷新一次才是干净的 */
  setTimeout(() => { try { location.reload(); } catch { } }, 1400);
}
