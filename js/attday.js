/* ============ 每日工作表组（PRD FR-DAY） ============
 *
 * 【为什么要多这一层】
 * 以前考勤是「自由新建表」：想查就建一张，忘了建就没有，谁也不知道今天到底
 * 查没查齐。V1.0 要求的是一天固定三张独立表 —— 坐班 1 张 + 教研 1 张
 * + 上课 1 张，全部确认才算今天做完。节次只是表内可编辑元数据，
 * 不再参与每日表身份，因此修改节次不会意外多生成日常表。
 *
 * 【为什么不跑定时任务】
 * 这个项目是纯静态站，托管在 GitHub Pages，没有服务器、没有 cron。
 * Service Worker 的 periodicSync 只有装了 PWA 且用户授权才生效，靠不住。
 * 所以改成「惰性生成」：打开考勤页 / 点某个格子时才去补，补之前先查已有的，
 * 已有的就不重复建 —— 幂等。多设备同时打开最多各建一次，靠 day_key 认出来。
 *
 * 【day_key 存在哪】
 * 存在 attendance_tables.meta 里（jsonb，不用改表结构）：
 *   '2026-11-04|高一|seat' / '2026-11-04|高一|research' /
 *   '2026-11-04|高一|class'
 * 想加数据库级唯一约束，见仓库根目录 step5_att_day.sql（只建表达式索引，不动表）。
 */

import { api, esc, toast } from './core.js';
import { icon } from './ui.js';
import {
  ATTENDANCE_TYPE_LABELS,
  ATTENDANCE_TYPE_SHORT,
  dailySlots,
  dayKeyOf as canonicalDayKey,
  keeperForDailySlot,
  normalizeAttendanceType,
  tableTypeOf,
} from './attendance-domain.mjs';

const pad2 = (n) => String(n).padStart(2, '0');
const WD = ['日', '一', '二', '三', '四', '五', '六'];
export const ymd = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

const TYPE_LABEL = ATTENDANCE_TYPE_LABELS;
const TYPE_SHORT = ATTENDANCE_TYPE_SHORT;

export function dayKeyOf(date, grade, type, period = '') {
  void period;
  return canonicalDayKey(date, grade, type);
}
/* Compatibility export: seat periods no longer control table creation. */
export function readSeatPeriods() {
  return [1];
}

/* ---------- 一组表里应该有哪些 ---------- */
function wantedSlots() {
  return dailySlots().map((slot) => ({ ...slot, period: '' }));
}

/* 把当天已有的表按槽位归好，顺手标出重复 */
function slotOf(tables, date, grade) {
  const mine = (tables || []).filter((t) => (t.grade || '高一') === grade
    && String(t.sheet_date || '') === date
    && !t.deleted_at);
  const byKey = new Map();
  for (const t of mine) {
    const k = dayKeyOf(date, grade, tableTypeOf(t));
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(t);
  }
  return { mine, byKey };
}

/* 同一天同一节次建了两张（多设备同时点「补齐」），留哪张？
   有确认的优先，其次勾得多的，再其次 id 小的。 */
function keeper(list) {
  if (!list?.length) return null;
  const first = list[0];
  return keeperForDailySlot(list, first.sheet_date, first.grade, tableTypeOf(first));
}

/* ---------- 今日进度（列表页用，只要数字） ----------
   列表页每个年级卡片上就一个「今天查了几个」，不需要整块看板。
   判定逻辑跟看板完全一样（同一套 wantedSlots / keeper），
   否则会出现「列表说 3/3、进去看是 2/3」这种自己打自己脸的情况。 */
export function dayProgress({ date, grade, tables }) {
  const slots = wantedSlots();
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
  const slots = wantedSlots();
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
    const label = TYPE_SHORT[s.type];
    const st = !t ? 'none' : cst === 'confirmed' ? 'ok' : cst === 'modified' ? 'warn' : 'wait';
    const stText = !t ? '未生成' : cst === 'confirmed' ? '已确认' : cst === 'modified' ? '已改待确认' : '未确认';
    chips.push(`<button class="ad-slot ${st}" ${t ? `data-open="${t.id}"` : `data-gen="${s.type}:${s.period}"`}
      title="${t ? esc(t.name || '') : '点一下就建这张'}">
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
  const normalizedType = normalizeAttendanceType(type);
  if (!normalizedType) throw new Error('未知考勤表类型');
  const fresh = await api.get('/attendance', { grade, sheet_date: date });
  const list = fresh.filter((t) => (t.grade || '高一') === grade
    && String(t.sheet_date || '') === date
    && !t.deleted_at
    && tableTypeOf(t) === normalizedType);
  if (list.length) return keeper(list);
  const d = new Date(date + 'T00:00:00');
  const name = `${date.slice(0, 4)}年${grade}${TYPE_LABEL[normalizedType]}`;
  let r;
  try {
    r = await api.post('/attendance', {
      sheet_type: normalizedType,
      grade,
      sheet_date: date,
      weekday: Number.isNaN(d.getTime()) ? '' : WD[d.getDay()],
      periods: String(period || ''),
      subject: '',
      name,
      month: date.slice(0, 7),
      meta: {
        day_key: dayKeyOf(date, grade, normalizedType),
        gen: 'auto-v1',
        year: date.slice(0, 4),
        weekday: Number.isNaN(d.getTime()) ? '' : WD[d.getDay()],
        periods: String(period || ''),
      },
    });
  } catch (error) {
    /* Multi-device race: the database unique index rejects the losing write.
       Re-read and return the winner rather than reporting a false failure. */
    const latest = (await api.get('/attendance', { grade, sheet_date: date })).filter((t) => (
      String(t.grade || '') === String(grade)
      && String(t.sheet_date || '') === String(date)
      && !t.deleted_at
      && tableTypeOf(t) === normalizedType
    ));
    if (latest.length) return keeper(latest);
    throw error;
  }
  if (!r?.id) throw new Error('生成失败，请重试');
  await seedRows(r.id, grade);
  return r;
}

/* 补齐整组，返回新建了几张 */
export async function ensureDay({ date, grade }) {
  const fresh = await api.get('/attendance', { grade, sheet_date: date });
  const { byKey } = slotOf(fresh, date, grade);
  let made = 0;
  // V1.0: exactly one independent seat, research and class table per day.
  for (const slot of wantedSlots()) {
    const key = dayKeyOf(date, grade, slot.type, slot.period);
    if ((byKey.get(key) || []).length) continue;
    await createSlot({ date, grade, type: slot.type, period: slot.period });
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
