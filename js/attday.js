/* ============ 每日工作表组（PRD FR-DAY） ============
 *
 * 【为什么要多这一层】
 * 以前考勤是「自由新建表」：想查就建一张，忘了建就没有，谁也不知道今天到底
 * 查没查齐。PRD 要求的是一天固定一组表 —— 坐班 N 张（按节次）+ 教研 1 张
 * + 上课 1 张，全部确认才算今天做完。
 *
 * 【为什么不跑定时任务】
 * 这个项目是纯静态站，托管在 GitHub Pages，没有服务器、没有 cron。
 * Service Worker 的 periodicSync 只有装了 PWA 且用户授权才生效，靠不住。
 * 所以改成「惰性生成」：打开考勤页 / 点某个格子时才去补，补之前先查已有的，
 * 已有的就不重复建 —— 幂等。多设备同时打开最多各建一次，靠 day_key 认出来。
 *
 * 【day_key 存在哪】
 * 存在 attendance_tables.meta 里（jsonb，不用改表结构）：
 *   '2026-11-04|高一|seat|1' / '2026-11-04|高一|research|'
 * 想加数据库级唯一约束，见仓库根目录 step5_att_day.sql（只建表达式索引，不动表）。
 */

import { api, el, esc, toast, sheet } from './core.js';
import { state, icon } from './ui.js';

const pad2 = (n) => String(n).padStart(2, '0');
const WD = ['日', '一', '二', '三', '四', '五', '六'];
export const ymd = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

const TYPE_LABEL = { seat: '教师坐班表', research: '教师教研签到表', class: '教师上课检查表' };
const TYPE_SHORT = { seat: '坐班', research: '教研', class: '上课' };

/* 只有坐班表按节次拆成多张（纸表表头就是「第__节」，一节一张）。
   教研是整场签到，上课检查一天查一次，都不按节次拆。 */
const multiPeriod = (type) => type === 'seat';

export function dayKeyOf(date, grade, type, period = '') {
  return `${date}|${grade}|${type}|${multiPeriod(type) ? (period || '') : ''}`;
}

/* ---------- 设置：哪几节要坐班 ----------
   默认 [1]，也就是一天三张表，跟 PRD 的字面要求一致；
   老师真按节次查的时候，在表组右上角把 3、5 节勾上就行。 */
export function readSeatPeriods() {
  const s = (state.user && state.user.settings && state.user.settings.attDay) || {};
  const arr = Array.isArray(s.seatPeriods) ? s.seatPeriods.map(Number).filter((n) => n >= 1 && n <= 9) : [];
  return arr.length ? [...new Set(arr)].sort((a, b) => a - b) : [1];
}

/* ---------- 一组表里应该有哪些 ---------- */
function wantedSlots(periods) {
  return [
    ...periods.map((p) => ({ type: 'seat', period: p })),
    { type: 'research', period: '' },
    { type: 'class', period: '' },
  ];
}

/* 把当天已有的表按槽位归好，顺手标出重复 */
function slotOf(tables, date, grade) {
  const mine = (tables || []).filter((t) => (t.grade || '高一') === grade
    && String(t.sheet_date || '') === date
    && !t.deleted_at);
  const byKey = new Map();
  for (const t of mine) {
    const k = dayKeyOf(date, grade, t.sheet_type || t.kind, t.periods || '');
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(t);
  }
  return { mine, byKey };
}

/* 同一天同一节次建了两张（多设备同时点「补齐」），留哪张？
   有确认的优先，其次勾得多的，再其次 id 小的。 */
function keeper(list) {
  return list.slice().sort((a, b) => {
    const ca = a.confirm_state === 'none' ? 0 : 1;
    const cb = b.confirm_state === 'none' ? 0 : 1;
    if (ca !== cb) return cb - ca;
    const ra = (a.row_count || 0) - (a.summary?.none || 0);
    const rb = (b.row_count || 0) - (b.summary?.none || 0);
    if (ra !== rb) return rb - ra;
    return Number(a.id) - Number(b.id);
  })[0];
}

/* ---------- 今日进度（列表页用，只要数字） ----------
   列表页每个年级卡片上就一个「今天查了几个」，不需要整块看板。
   判定逻辑跟看板完全一样（同一套 wantedSlots / keeper），
   否则会出现「列表说 3/3、进去看是 2/3」这种自己打自己脸的情况。 */
export function dayProgress({ date, grade, tables }) {
  const slots = wantedSlots(readSeatPeriods());
  const { byKey } = slotOf(tables, date, grade);
  let done = 0; let built = 0; let dup = 0;
  for (const s of slots) {
    const list = byKey.get(dayKeyOf(date, grade, s.type, s.period)) || [];
    if (list.length) built++;
    if (list.length > 1) dup += list.length - 1;
    const t = list.length ? keeper(list) : null;
    if (t && (t.confirm_state || 'none') === 'confirmed') done++;
  }
  return { done, built, total: slots.length, dup };
}

/* ---------- 看板 HTML ---------- */
export function dayBoardHTML({ date, grade, tables }) {
  const periods = readSeatPeriods();
  const slots = wantedSlots(periods);
  const { byKey } = slotOf(tables, date, grade);
  const d = new Date(date + 'T00:00:00');
  const ok = !Number.isNaN(d.getTime());
  const dateText = ok ? `${d.getMonth() + 1}月${d.getDate()}日 · 周${WD[d.getDay()]}` : date;
  const isToday = date === ymd();

  let done = 0; let dup = 0; const chips = [];
  for (const s of slots) {
    const list = byKey.get(dayKeyOf(date, grade, s.type, s.period)) || [];
    const t = list.length ? keeper(list) : null;
    if (list.length > 1) dup += list.length - 1;
    const cst = t ? (t.confirm_state || 'none') : '';
    if (cst === 'confirmed') done++;
    const classConfirmed = byKey.get(dayKeyOf(date, grade, 'class', ''))?.some((x) => x.confirm_state === 'confirmed') || false;
    const seatLocked = s.type === 'seat' && !t && !classConfirmed;
    const label = `${TYPE_SHORT[s.type]}${s.period ? ' · 第' + s.period + '节' : ''}`;
    const st = seatLocked ? 'locked' : !t ? 'none' : cst === 'confirmed' ? 'ok' : cst === 'modified' ? 'warn' : 'wait';
    const stText = seatLocked ? '待上课表确认' : !t ? '未生成' : cst === 'confirmed' ? '已确认' : cst === 'modified' ? '已改待确认' : '未确认';
    chips.push(`<button class="ad-slot ${st}" ${t ? `data-open="${t.id}"` : seatLocked ? 'disabled' : `data-gen="${s.type}:${s.period}"`}
      title="${t ? esc(t.name || '') : seatLocked ? '先确认当天上课表，才能生成坐班表' : '点一下就建这张'}">
      <i>${esc(label)}</i><b>${t ? stText : seatLocked ? stText : '＋ 生成'}</b></button>`);
  }

  return `<div class="att-day" data-date="${esc(date)}">
    <div class="ad-top">
      <span class="ad-t">今日工作表</span>
      <span class="ad-d">${esc(dateText)}${isToday ? '<b class="ad-today">今天</b>' : ''}</span>
      <span class="ad-p">${done}/${slots.length} 已确认</span>
      ${dup ? `<span class="ad-dup" title="同一天同一节次有多张表，建议删掉一张">重复 ${dup}</span>` : ''}
      <span class="ad-sp"></span>
      <input class="input ad-pick" type="date" value="${esc(date)}" title="看别的日期">
      <button class="btn ghost xs" id="ad-per" title="哪几节要坐班表">坐班 ${periods.length} 节</button>
      <button class="btn primary xs" id="ad-genall">${icon('check', 13)} 补齐这组</button>
    </div>
    <div class="ad-slots">${chips.join('')}</div>
  </div>`;
}

/* ---------- 生成 ---------- */
async function seedRows(tableId, grade) {
  try {
    const r = await api.get('/teachers', { grade });
    const list = r.list || [];
    if (!list.length) return 0;
    await api.post(`/attendance/${tableId}/rows`, {
      rows: list.map((x) => ({ teacher: x.name, subject: x.subject, data: {} })),
    });
    return list.length;
  } catch { return 0; }
}

/* 建一个槽位。先查已有的（不管调用方传没传 tables），已有就直接返回，不重复建。 */
export async function createSlot({ date, grade, type, period = '' }) {
  const fresh = await api.get('/attendance');
  const list = fresh.filter((t) => (t.grade || '高一') === grade
    && String(t.sheet_date || '') === date
    && (t.sheet_type || t.kind) === type
    && (multiPeriod(type) ? String(t.periods || '') === String(period || '') : true));
  if (list.length) return keeper(list);
  if (type === 'seat') {
    const classConfirmed = fresh.some((t) => (t.grade || '高一') === grade
      && String(t.sheet_date || '') === date
      && (t.sheet_type || t.kind) === 'class'
      && t.confirm_state === 'confirmed'
      && !t.deleted_at);
    if (!classConfirmed) throw new Error('请先完成当天上课表的勾选，并点击「确认生成」，之后才能生成正式坐班表。');
  }

  const d = new Date(date + 'T00:00:00');
  const name = `${date.slice(0, 4)}年${grade}${TYPE_LABEL[type]}${multiPeriod(type) && period ? ` · 第${period}节` : ''}`;
  const r = await api.post('/attendance', {
    sheet_type: type,
    grade,
    sheet_date: date,
    weekday: Number.isNaN(d.getTime()) ? '' : WD[d.getDay()],
    periods: multiPeriod(type) ? String(period || '') : '',
    subject: '',
    name,
    month: date.slice(0, 7),
    meta: {
      day_key: dayKeyOf(date, grade, type, period),
      gen: 'auto',
      year: date.slice(0, 4),
      weekday: Number.isNaN(d.getTime()) ? '' : WD[d.getDay()],
      periods: multiPeriod(type) ? String(period || '') : '',
    },
  });
  if (!r?.id) throw new Error('生成失败，请重试');
  await seedRows(r.id, grade);
  return r;
}

/* 补齐整组，返回新建了几张 */
export async function ensureDay({ date, grade }) {
  const fresh = await api.get('/attendance');
  const { byKey } = slotOf(fresh, date, grade);
  let made = 0;
  // 先准备教研表和上课表；坐班表必须等上课表人工确认后才允许生成。
  for (const s of wantedSlots(readSeatPeriods()).filter((x) => x.type !== 'seat')) {
    const key = dayKeyOf(date, grade, s.type, s.period);
    if ((byKey.get(key) || []).length) continue;
    await createSlot({ date, grade, type: s.type, period: s.period });
    made++;
  }
  const afterPrep = await api.get('/attendance');
  const classKey = dayKeyOf(date, grade, 'class', '');
  const classRows = afterPrep.filter((t) => (t.grade || '高一') === grade
    && String(t.sheet_date || '') === date
    && (t.sheet_type || t.kind) === 'class'
    && !t.deleted_at);
  const classConfirmed = classRows.some((t) => t.confirm_state === 'confirmed');
  if (!classConfirmed) return made;
  const afterMap = slotOf(afterPrep, date, grade).byKey;
  for (const s of wantedSlots(readSeatPeriods()).filter((x) => x.type === 'seat')) {
    const key = dayKeyOf(date, grade, s.type, s.period);
    if ((afterMap.get(key) || []).length) continue;
    await createSlot({ date, grade, type: s.type, period: s.period });
    made++;
  }
  return made;
}

/* ---------- 事件绑定 ---------- */
export function bindDayBoard(root, { date, grade, load, openTable }) {
  const box = root.querySelector('.att-day');
  if (!box) return;
  const curDate = box.dataset.date || date;

  const pick = box.querySelector('.ad-pick');
  if (pick) pick.onchange = () => { box.dataset.date = pick.value; load(pick.value); };

  const genAll = box.querySelector('#ad-genall');
  if (genAll) genAll.onclick = async () => {
    genAll.disabled = true;
    try {
      const n = await ensureDay({ date: curDate, grade });
      toast(n ? `已补齐 ${n} 张表` : '这组表已经齐了', 'ok');
      await load();
    } catch (e) { toast(e.message || '生成失败', 'err'); } finally { genAll.disabled = false; }
  };

  const per = box.querySelector('#ad-per');
  if (per) per.onclick = () => seatPeriodDialog(load);

  box.querySelectorAll('[data-open]').forEach((b) => {
    b.onclick = () => openTable(Number(b.dataset.open));
  });
  box.querySelectorAll('[data-gen]').forEach((b) => {
    b.onclick = async () => {
      const [type, p] = String(b.dataset.gen).split(':');
      b.disabled = true;
      try {
        const t = await createSlot({ date: curDate, grade, type, period: p });
        await load();
        if (t?.id) openTable(t.id);
      } catch (e) { toast(e.message || '生成失败', 'err'); b.disabled = false; }
    };
  });
}

/* 哪几节要查坐班：勾一下就好，勾完不会立刻建表，回到看板点「补齐」才建 */
function seatPeriodDialog(reload) {
  const cur = readSeatPeriods();
  const body = el(`<div class="sheet-body">
    <div class="field">
      <label class="field-label">坐班表按哪几节生成</label>
      <div class="ad-pers">
        ${Array.from({ length: 9 }, (_, i) => i + 1).map((p) => `
          <label class="ad-per-chip${cur.includes(p) ? ' on' : ''}">
            <input type="checkbox" data-p="${p}" ${cur.includes(p) ? 'checked' : ''}>第 ${p} 节
          </label>`).join('')}
      </div>
      <div class="field-hint">勾几节，每天就生成几张坐班表。只查一节的话保持默认就行，一天正好三张表。</div>
    </div>
    <div class="confirm-actions">
      <button class="btn ghost" id="ap-c">取消</button>
      <button class="btn primary" id="ap-k">保存</button>
    </div>
  </div>`);
  const s = sheet({ title: '坐班节次', body });
  body.querySelectorAll('input[data-p]').forEach((cb) => {
    cb.onchange = () => cb.closest('.ad-per-chip').classList.toggle('on', cb.checked);
  });
  body.querySelector('#ap-c').onclick = s.close;
  body.querySelector('#ap-k').onclick = async () => {
    const ps = [...body.querySelectorAll('input[data-p]')].filter((x) => x.checked).map((x) => Number(x.dataset.p));
    if (!ps.length) return toast('至少要留一节', 'warn');
    const settings = { ...(state.user?.settings || {}), attDay: { ...(state.user?.settings?.attDay || {}), seatPeriods: ps.sort((a, b) => a - b) } };
    try {
      const r = await api.patch('/me', { settings });
      if (r?.user) state.user = r.user;
      s.close();
      toast(`坐班表改成 ${ps.length} 节，点「补齐这组」生成`, 'ok', 3200);
      reload?.();
    } catch (e) { toast(e.message || '保存失败', 'err'); }
  };
}
