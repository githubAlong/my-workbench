/* ============ 清空考勤数据 ============
 *
 * 重新开始时用得着：把考勤表、明细、名册一次性清干净，从空白开始。
 *
 * 三条硬规矩（这种不可逆操作，少一条都会出事）：
 *   1. 先备份再动手 —— 逐张拉明细拼成 JSON 下载到本地，清错了还能拿去恢复；
 *   2. 要手打「清空」两个字才能点确认 —— 防手滑，尤其是手机上一划就点到了；
 *   3. 云表和本地一起清 —— 只清一边，下次同步旧数据又回来了。
 *
 * 删的是软删（deleted_at），不是物理删除：云端一个月内都能捞回来。
 */

import { api, el, esc, toast, sheet, saveBlob } from './core.js';
import { load, save, replaceMemFromDisk } from './localdb.js';

const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
};

export async function resetAttendanceData(onDone) {
  let tables = [];
  try {
    tables = await api.get('/attendance');
  } catch (e) {
    toast('读不到考勤表：' + (e.message || e), 'err');
    return;
  }
  const db = load();
  const roster = (db.teachers || []).filter((t) => !t.deleted_at);
  const nRows = (tables || []).reduce((a, t) => a + (t.row_count || 0), 0);
  const grades = [...new Set(roster.map((t) => t.grade).filter(Boolean))];

  const body = el(`<div class="sheet-body">
    <div class="rst-box">
      <div class="rst-line"><b>${(tables || []).length}</b> 张考勤表</div>
      <div class="rst-line"><b>${nRows}</b> 条人员记录</div>
      <div class="rst-line"><b>${roster.length}</b> 位老师的名册${grades.length ? `<span class="muted">（${grades.map((g) => esc(g)).join('、')}）</span>` : ''}</div>
    </div>
    <label class="rst-opt">
      <input type="checkbox" id="rst-roster" checked>
      <span>连名册一起清空<em>重新开始时名册也要重录；不勾就只清表，名册留着</em></span>
    </label>
    <div class="field">
      <label class="field-label">确认请输入「清空」两个字</label>
      <input class="input" id="rst-word" placeholder="清空" autocomplete="off">
    </div>
    <div class="att-tip-note">清之前会先拉一份完整 JSON 备份下载到本机（含每张表的人员与勾选状态），清错了可以拿它恢复。云端是软删除，一个月内也能捞回来。</div>
    <div class="confirm-actions">
      <button class="btn ghost" id="rst-c">取消</button>
      <button class="btn danger" id="rst-k" disabled>确认清空</button>
    </div>
  </div>`);
  const s = sheet({ title: '清空考勤数据', body });
  const word = body.querySelector('#rst-word');
  const okBtn = body.querySelector('#rst-k');
  word.oninput = () => { okBtn.disabled = word.value.trim() !== '清空'; };
  body.querySelector('#rst-c').onclick = s.close;

  okBtn.onclick = async () => {
    if (word.value.trim() !== '清空') return;
    const withRoster = body.querySelector('#rst-roster').checked;
    s.close();
    await run({ tables: tables || [], roster, withRoster, onDone });
  };
}

async function run({ tables, roster, withRoster, onDone }) {
  toast(`正在备份 ${tables.length} 张表，别关页面…`, 'ok', 6000);
  /* ---------- 1. 备份 ---------- */
  const backup = {
    v: 1, kind: 'attendance-backup', at: new Date().toISOString(),
    teachers: roster.map((t) => ({ grade: t.grade, name: t.name, subject: t.subject })),
    tables: [],
  };
  let failed = 0;
  for (const t of tables) {
    try {
      const d = await api.get('/attendance/' + t.id);
      backup.tables.push({
        name: t.name, grade: t.grade, sheet_type: t.sheet_type || t.kind,
        sheet_date: t.sheet_date, periods: t.periods,
        columns: d?.columns || t.columns || [],
        rows: (d?.rows || []).map((r) => ({ teacher: r.teacher, subject: r.subject, data: r.data || {} })),
      });
    } catch {
      /* 单张读失败不阻断整体备份，但要记下来，别让用户以为备份是完整的 */
      failed++;
      backup.tables.push({ name: t.name, grade: t.grade, sheet_date: t.sheet_date, rows: null });
    }
  }
  try {
    saveBlob(new Blob([JSON.stringify(backup, null, 1)], { type: 'application/json' }), `考勤备份-${stamp()}.json`);
  } catch (e) {
    toast('备份文件下载失败，已中止清空（没有动任何数据）', 'err', 6000);
    return;
  }

  /* ---------- 2. 云端 ---------- */
  let cloud = null;
  try {
    const m = await import('./cloud.js');
    if (m.cfg() && m.session()) cloud = await m.purgeAttendanceCloud();
  } catch (e) {
    toast('云端清空失败：' + (e.message || e) + '，已中止（本地未清）', 'err', 7000);
    return;
  }

  /* ---------- 3. 本地 ---------- */
  const db = load();
  const before = (db.attendance_tables || []).filter((t) => !t.deleted_at).length;
  db.attendance_tables = [];
  db.attendance_rows = [];
  db.students_att = [];
  if (withRoster) db.teachers = [];
  /* 考勤现场照片和原表也归这块，一起清；课件的附件不动 */
  db.attachments = (db.attachments || []).filter((a) => a.owner_type !== 'attendance');
  save();
  replaceMemFromDisk();

  /* 详情页记着上次看的年级/日期，清完回到列表页时这些都该忘掉 */
  sessionStorage.removeItem('wb_att_grade');
  sessionStorage.removeItem('wb_att_date');
  Object.keys(sessionStorage).filter((k) => k.startsWith('wb_att_ensured_')).forEach((k) => sessionStorage.removeItem(k));

  const bits = [];
  if (cloud) bits.push(`云端 ${cloud.tables} 张表 / ${cloud.rows} 条明细`);
  else bits.push(`本机 ${before} 张表`);
  toast(`已清空：${bits.join('，')}${withRoster ? `，${roster.length} 位老师的名册` : ''}`, 'ok', 6000);
  if (failed) toast(`有 ${failed} 张表的明细没读出来，备份里只留了表名`, 'warn', 6000);
  await onDone?.();
}
