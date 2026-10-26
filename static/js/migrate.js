/* ============================================================================
   本地课时 → 云端课时 的迁移

   【为什么需要专门的脚本，而不是「导出 JSON 再导入」】
   本地数据是「能存什么就存什么」，云端是真正的数据库，有类型约束。
   直接灌进去会遇到三种情况，每一种都会让整批插入失败：

     1. 空字符串 → 云端是 date / numeric 类型，'' 不是合法的 null
     2. 值是字符串的 "30" → numeric 列有时能自动转，有时报错，看运气
     3. 本地 id 是流水号（1、2、3），云端是自增 → 传了会主键冲突

   所以这里逐个字段做类型清洗：能转的转，空的变 null，废弃的丢掉。

   【幂等：重复点不会重复插入】
   用「日期 + 节次 + 班级 + 内容」做指纹。迁移前先读云端已有的，
   指纹一样的跳过。这样用户可以放心点两次、三次，不会把账目搞乱。

   【不删本地数据】
   迁移只是「复制到云端」，本地一行不动。确认云端没问题之后，
   再由用户自己决定要不要清本机。
   ========================================================================== */

import * as cloud from './cloud.js';

/* 日期：本地可能存 '2026-10-26'、'2026/10/26'、'2026-10-26T00:00:00.000Z'、空串 */
function toDate(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  if (!s) return null;
  // 已经带 T 的取日期部分
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const slash = s.match(/^(\d{4})[/.](\d{1,2})[/.](\d{1,2})/);
  if (slash) {
    return `${slash[1]}-${String(slash[2]).padStart(2, '0')}-${String(slash[3]).padStart(2, '0')}`;
  }
  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  return null;   // 认不出来就当空，不能让整批失败
}

/* 数字：'' → null；'30元' → 30；'abc' → null */
function toNum(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = parseFloat(String(v).replace(/[^\d.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/* 整数 */
function toInt(v) {
  const n = toNum(v);
  return n == null ? null : Math.trunc(n);
}

/* 文本：null / undefined → null；数字转字符串；去首尾空格 */
function toText(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

/* 时间戳：settled_at 这种 */
function toTs(v) {
  if (v == null || v === '') return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/* 一行本地记录 → 一行云端记录 */
function cleanRow(r) {
  return {
    date: toDate(r.date),
    period_no: toInt(r.period_no),
    time_range: toText(r.time_range),
    start_time: toText(r.start_time),
    end_time: toText(r.end_time),

    grade: toText(r.grade),
    class_name: toText(r.class_name),
    subject: toText(r.subject),
    teacher: toText(r.teacher),
    substitute: toText(r.substitute),
    sub_type: toText(r.sub_type),
    sub_note: toText(r.sub_note),

    content: toText(r.content),
    progress: toText(r.progress),
    next_content: toText(r.next_content),
    discipline: toText(r.discipline),

    hours: toNum(r.hours),
    remark: toText(r.remark),

    peer_name: toText(r.peer_name),
    peer_id: toInt(r.peer_id),
    orig_teacher: toText(r.orig_teacher),

    pay_hours: toNum(r.pay_hours),
    unit_price: toNum(r.unit_price),
    pay_amount: toNum(r.pay_amount),
    settle_note: toText(r.settle_note),
    swap_from: toText(r.swap_from),
    swap_to: toText(r.swap_to),
    settled_at: toTs(r.settled_at),
    settle_key: toText(r.settle_key),
  };
}

/* 指纹：判断「这条是不是已经在云端了」 */
function fingerprint(r) {
  return [
    r.date || '',
    r.period_no ?? '',
    r.class_name || '',
    r.subject || '',
    (r.content || '').slice(0, 40),
    r.pay_amount ?? '',
  ].join('|');
}

/* 读本地库里的课时 */
async function readLocal() {
  const m = await import('./localdb.js');
  const db = m.load();
  const rows = db?.lessons;
  return Array.isArray(rows) ? rows : [];
}

/**
 * 执行迁移。
 * @param {(p: {done:number, total:number, text:string}) => void} onProgress
 * @returns {Promise<{total:number, added:number, skipped:number, failed:number, errors:string[]}>}
 */
export async function migrateLessons(onProgress = () => {}) {
  if (!cloud.cfg() || !cloud.session()) throw new Error('请先登录云端账号');

  onProgress({ done: 0, total: 1, text: '读取本机数据…' });
  const local = await readLocal();
  if (!local.length) {
    return { total: 0, added: 0, skipped: 0, failed: 0, errors: ['本机没有课时记录'] };
  }

  onProgress({ done: 0, total: local.length, text: '读取云端已有记录…' });
  let remote = [];
  try {
    remote = await cloud.listLessons({});
  } catch (e) {
    throw new Error('读不到云端（' + (e.message || e) + '），先确认云端表已建好且已登录');
  }
  const seen = new Set(remote.map(fingerprint));

  let added = 0, skipped = 0, failed = 0;
  const errors = [];

  for (let i = 0; i < local.length; i++) {
    const raw = local[i];
    const row = cleanRow(raw);
    const fp = fingerprint(row);

    if (seen.has(fp)) {
      skipped++;
      onProgress({ done: i + 1, total: local.length, text: `跳过重复 ${i + 1}/${local.length}` });
      continue;
    }

    /* 云端对空行没意义：完全没有日期也没有内容的，跳过 */
    if (!row.date && !row.content && !row.class_name) {
      skipped++;
      onProgress({ done: i + 1, total: local.length, text: `跳过空记录 ${i + 1}/${local.length}` });
      continue;
    }

    try {
      await cloud.createLesson(row);
      seen.add(fp);
      added++;
      onProgress({ done: i + 1, total: local.length, text: `已上传 ${added} 条（${i + 1}/${local.length}）` });
    } catch (e) {
      failed++;
      errors.push(`第 ${i + 1} 条（${row.date || '无日期'} ${row.class_name || ''}）：${e.message || e}`);
      onProgress({ done: i + 1, total: local.length, text: `失败 ${failed} 条（${i + 1}/${local.length}）` });
    }
  }

  return { total: local.length, added, skipped, failed, errors };
}

/* 迁移前的体检：只看不发，让用户心里有数 */
export async function previewMigration() {
  const local = await readLocal();
  let badDate = 0, emptyRows = 0, realRows = 0, withMoney = 0;
  for (const r of local) {
    const row = cleanRow(r);
    const blank = !row.date && !row.content && !row.class_name;
    if (blank) emptyRows++;
    else {
      realRows++;
      if (!row.date) badDate++;          // 有内容但日期认不出来
      if (row.pay_amount != null) withMoney++;
    }
  }
  return { total: local.length, realRows, emptyRows, badDate, withMoney };
}
