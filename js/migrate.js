/* ============================================================================
   本机数据 → 云端 的迁移
   目前覆盖：课时（lessons）、监考（invigilations）、考勤（attendance_tables
   主表 + attendance_rows 明细）。

   【为什么需要专门的脚本，而不是「导出 JSON 再导入」】
   本地数据是「能存什么就存什么」，云端是真正的数据库，有类型约束。
   直接灌进去会遇到三种情况，每一种都会让整批插入失败：

     1. 空字符串 → 云端是 date / numeric 类型，'' 不是合法的 null
     2. 值是字符串的 "30" → numeric 列有时能自动转，有时报错，看运气
     3. 本地 id 是流水号（1、2、3），云端是自增 → 传了会主键冲突

   所以这里逐个字段做类型清洗：能转的转，空的变 null，废弃的丢掉。

   【考勤要多一步：id 重映射】
   本地 attendance_rows.table_id 指向本地主表的流水号，云端主表是新 id。
   如果照搬 table_id，明细就会挂到别人的表下面 —— 表现是"表建了，但里面是空的"。
   所以这里维护一张「本地 id → 云端 id」的映射表，明细按映射表挂。

   【幂等：重复点不会重复插入】
   课时用「日期 + 节次 + 班级 + 内容」做指纹；监考用「日期 + 考试名 + 时段」；
   考勤用「年级 + 日期 + 类型 + 表名」。迁移前先读云端已有的，指纹一样的跳过。
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

/* 读本地任意一张表（迁移要读的是"活的"数组，不能走 rowsOf ——
   rowsOf 会过滤掉已删除的行，但迁移需要对"回收站里的"做判断） */
async function readLocalTable(name) {
  const m = await import('./localdb.js');
  const db = m.load();
  const rows = db?.[name];
  return Array.isArray(rows) ? rows : [];
}

/* 解析本地存成字符串的 JSON（考勤的 columns / meta / data 都是） */
function parseJSON(v, dflt) {
  if (v == null) return dflt;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v) ?? dflt; } catch { return dflt; }
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

/* ============================================================================
   监考：本机 → 云端
   本地监考表同时存了新旧两套字段（amount/place 与 pay_amount/room，
   minutes 与 duration_min），迁移时两套都带上，前端读哪套都能对上。
   ========================================================================== */
function cleanInvig(r) {
  return {
    date: toDate(r.date),
    exam_name: toText(r.exam_name || r.subject),
    subject: toText(r.subject || r.exam_name),
    grade: toText(r.grade),
    type: toText(r.type),
    duty_type: toText(r.duty_type),
    person: toText(r.person),
    peer_name: toText(r.peer_name || r.person),
    peer_id: toInt(r.peer_id),
    orig_teacher: toText(r.orig_teacher),
    start_at: toTs(r.start_at),
    end_at: toTs(r.end_at),
    start_time: toText(r.start_time),
    end_time: toText(r.end_time),
    minutes: toInt(r.minutes),
    duration_min: toInt(r.duration_min || r.minutes),
    place: toText(r.place || r.room),
    room: toText(r.room || r.place),
    seat_count: toInt(r.seat_count),
    need_paper: toInt(r.need_paper) || 0,
    paper_place: toText(r.paper_place),
    amount: toNum(r.amount),
    pay_amount: toNum(r.pay_amount || r.amount),
    pay_hours: toNum(r.pay_hours),
    unit_price: toNum(r.unit_price),
    pay_rule: toText(r.pay_rule),
    pay_note: toText(r.pay_note),
    paid: toInt(r.paid) || 0,
    school_paid: toInt(r.school_paid) || 0,
    settled_at: toTs(r.settled_at),
    settle_key: toText(r.settle_key),
    status: toText(r.status),
    remark: toText(r.remark),
  };
}

function invigFingerprint(r) {
  return [r.date || '', r.exam_name || '', r.start_time || '', r.peer_name || '', r.pay_amount ?? ''].join('|');
}

export async function migrateInvigilations(onProgress = () => {}) {
  if (!cloud.cfg() || !cloud.session()) throw new Error('请先登录云端账号');
  onProgress({ done: 0, total: 1, text: '读取本机监考记录…' });
  const local = (await readLocalTable('invigilations')).filter((r) => !r.deleted_at);
  if (!local.length) return { total: 0, added: 0, skipped: 0, failed: 0, errors: [] };

  onProgress({ done: 0, total: local.length, text: '读取云端已有记录…' });
  const remote = await cloud.listRows('invigilations', {});
  const seen = new Set(remote.map(invigFingerprint));

  let added = 0, skipped = 0, failed = 0;
  const errors = [];
  for (let i = 0; i < local.length; i += 1) {
    const row = cleanInvig(local[i]);
    const fp = invigFingerprint(row);
    if (seen.has(fp)) { skipped += 1; continue; }
    if (!row.date) { skipped += 1; continue; }
    try {
      await cloud.createRow('invigilations', row);
      seen.add(fp); added += 1;
      onProgress({ done: i + 1, total: local.length, text: `已上传 ${added} 场（${i + 1}/${local.length}）` });
    } catch (e) {
      failed += 1;
      errors.push(`第 ${i + 1} 场（${row.date} ${row.exam_name || ''}）：${e.message || e}`);
    }
  }
  return { total: local.length, added, skipped, failed, errors };
}

/* ============================================================================
   考勤：本机 → 云端（主表 + 明细）
   按「表」为单位迁移：一张表 + 它下面的几十行明细，一起走。
   中途某张表失败不影响其他表，错误里会写清是哪张。
   ========================================================================== */
function cleanAttTable(t) {
  const cols = parseJSON(t.columns, []);
  const meta = parseJSON(t.meta, {});
  const sheetType = t.sheet_type === 'research' || t.kind === 'research' ? 'research' : 'seat';
  return {
    name: toText(t.name) || '未命名考勤表',
    kind: sheetType,
    sheet_type: sheetType,
    grade: toText(t.grade) || '高一',
    subject: toText(t.subject),
    month: toText(t.month),
    sheet_date: toDate(t.sheet_date),
    weekday: toText(t.weekday),
    periods: toText(t.periods),
    columns: Array.isArray(cols) ? cols : [],
    meta: meta && typeof meta === 'object' ? meta : {},
  };
}

function attFingerprint(t) {
  return [t.grade || '', t.sheet_date || '', t.sheet_type || '', t.name || ''].join('|');
}

/**
 * 迁移考勤。返回结果里多了 tables / rows 两个数字，方便告诉用户
 * "搬了几张表、几个人的格子"。
 */
export async function migrateAttendance(onProgress = () => {}) {
  if (!cloud.cfg() || !cloud.session()) throw new Error('请先登录云端账号');
  onProgress({ done: 0, total: 1, text: '读取本机考勤表…' });

  const tables = (await readLocalTable('attendance_tables')).filter((t) => !t.deleted_at);
  const allRows = (await readLocalTable('attendance_rows')).filter((r) => !r.deleted_at);
  if (!tables.length) return { total: 0, added: 0, skipped: 0, failed: 0, errors: [], tables: 0, rows: 0 };

  onProgress({ done: 0, total: tables.length, text: '读取云端已有考勤表…' });
  const remote = await cloud.listRows('attendance_tables', {});
  const seen = new Map(remote.map((t) => [attFingerprint(t), t]));

  let addedT = 0; let skippedT = 0; let failedT = 0; let addedR = 0;
  const errors = [];

  for (let i = 0; i < tables.length; i += 1) {
    const local = tables[i];
    const row = cleanAttTable(local);
    const fp = attFingerprint(row);

    try {
      let cloudId;
      const hit = seen.get(fp);
      if (hit) {
        /* 已经搬过这张表：明细可能还没搬（上次中途断了），
           所以不直接跳过，而是接着走明细这一步。 */
        cloudId = hit.id;
        skippedT += 1;
      } else {
        const created = await cloud.createRow('attendance_tables', row);
        cloudId = created.id;
        seen.set(fp, created);
        addedT += 1;
      }

      /* 明细：按本地 table_id 找出来，挂到云端 id 上 */
      const mine = allRows.filter((r) => String(r.table_id) === String(local.id));
      if (mine.length) {
        /* 已经有明细就不再插，避免重复点导致翻倍 */
        const exist = await cloud.listRows('attendance_rows', { table_id: cloudId });
        const existNames = new Set(exist.map((r) => r.teacher));
        const batch = [];
        let sort = exist.reduce((mx, r) => Math.max(mx, Number(r.sort) || 0), 0);
        for (const r of mine) {
          const nm = String(r.teacher || '').trim();
          if (!nm || existNames.has(nm)) continue;
          sort += 1;
          batch.push({
            table_id: cloudId,
            teacher: nm,
            subject: String(r.subject || ''),
            data: parseJSON(r.data, {}),
            sort,
          });
        }
        for (let k = 0; k < batch.length; k += 200) {
          await cloud.createRows('attendance_rows', batch.slice(k, k + 200));
        }
        addedR += batch.length;
      }

      onProgress({
        done: i + 1, total: tables.length,
        text: `已搬 ${addedT} 张表 / ${addedR} 人（${i + 1}/${tables.length}）`,
      });
    } catch (e) {
      failedT += 1;
      errors.push(`「${row.name}」（${row.sheet_date || '无日期'}）：${e.message || e}`);
    }
  }

  return {
    total: tables.length, added: addedT, skipped: skippedT, failed: failedT,
    errors, tables: addedT, rows: addedR,
  };
}

/**
 * 迁移附件（考勤原表 Excel + 现场照片）。
 *
 * 【为什么必须单独一段，且要在 migrateAttendance 之后跑】
 * 附件挂在考勤表上，字段是 owner_id。本地 owner_id 是本地流水号，
 * 云端 attendance_tables 的 id 是另一套自增 —— 直接把本地 id 写进去，
 * 照片就会挂到"别人的表"下面。所以这里必须先把「本地表 id → 云端表 id」
 * 对应起来，认不出对应关系的附件宁可跳过，也不能挂到 0 或者别的表上。
 *
 * 【怎么对应】
 * 复用 migrateAttendance 用的同一个指纹 attFingerprint（年级|日期|类型|表名）。
 * 两边用同一个函数，才不会出现"迁移脚本认为是一张表、这里认为是两张"。
 *
 * 【为什么限制只会搬 attendance】
 * 课件（material）、出差（trip）、头像（avatar）对应的主表还没上云，
 * 它们继续留在本机，搬上去反而会在云端留一堆没人认领的孤儿数据。
 *
 * 【幂等】
 * 同一张表下同名同大小的附件只搬一次。照片可能是"a.jpg / a.jpg"同名，
 * 所以用「文件名 + 字节数」当指纹，比只用文件名稳。
 */
export async function migrateAttachments(onProgress = () => {}) {
  if (!cloud.cfg() || !cloud.session()) throw new Error('请先登录云端账号');
  onProgress({ done: 0, total: 1, text: '读取本机附件…' });

  const all = (await readLocalTable('attachments')).filter((a) => !a.deleted_at && a.owner_type === 'attendance');
  if (!all.length) return { total: 0, added: 0, skipped: 0, failed: 0, errors: [] };

  /* 先把云端已有的考勤表读回来建指纹索引。
     读不到就直接抛错 —— 这时候硬搬只会把附件挂错地方。 */
  const remoteTables = await cloud.listRows('attendance_tables', {});
  const byFp = new Map(remoteTables.map((t) => [attFingerprint(t), t]));

  /* 本地表也要读，才能知道某个本地 owner_id 对应哪张表 */
  const localTables = (await readLocalTable('attendance_tables')).filter((t) => !t.deleted_at);
  const cloudIdOf = new Map();   // 本地表 id → 云端表 id（认不出来的不放进 map）
  let orphan = 0;
  for (const lt of localTables) {
    const hit = byFp.get(attFingerprint(cleanAttTable(lt)));
    if (hit) cloudIdOf.set(String(lt.id), hit.id);
    else orphan += 1;
  }

  let added = 0; let skipped = 0; let failed = 0;
  const errors = [];
  const doneOwner = new Map();   // 云端表 id → Set(指纹)，避免每张表都重新读一遍云端

  for (let i = 0; i < all.length; i += 1) {
    const a = all[i];
    const label = a.name || `附件 ${a.id}`;
    const cloudOwner = cloudIdOf.get(String(a.owner_id));

    if (!cloudOwner) {
      /* 表本身没搬上去（或者指纹对不上）。跳过并记一笔，
         但不当作失败 —— 用户看到一大堆红字会更慌。 */
      skipped += 1;
      continue;
    }

    try {
      if (!doneOwner.has(cloudOwner)) {
        const exist = await cloud.listAttachmentMeta('attendance', cloudOwner).catch(() => []);
        doneOwner.set(cloudOwner, new Set(exist.map((x) => `${x.name || ''}|${Number(x.size) || 0}`)));
      }
      const seen = doneOwner.get(cloudOwner);
      const fp = `${a.name || ''}|${Number(a.size) || 0}`;
      if (seen.has(fp)) { skipped += 1; continue; }

      /* 正文可能没有（老数据只存了元数据），照样把元数据搬上去，
         让界面上至少能看到"有这么个附件"。 */
      await cloud.createAttachment({
        owner_type: 'attendance',
        owner_id: cloudOwner,
        name: a.name || '',
        mime: a.mime || '',
        size: Number(a.size) || 0,
        path: a.path || '',
        url: a.url || '',
      });
      seen.add(fp);
      added += 1;
      onProgress({
        done: i + 1, total: all.length,
        text: `附件已搬 ${added} 个（${i + 1}/${all.length}）`,
      });
    } catch (e) {
      failed += 1;
      errors.push(`「${label}」：${e.message || e}`);
    }
  }

  /* orphan 只是统计：有几张本地表在云端找不到对应，它们的附件一律跳过。
     写进 errors 会让用户误以为出错，所以单独放在返回值里。 */
  return { total: all.length, added, skipped, failed, errors, orphanTables: orphan };
}
