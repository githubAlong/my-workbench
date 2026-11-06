export const ATTENDANCE_TYPES = Object.freeze(['seat', 'research', 'class']);

export const ATTENDANCE_TYPE_LABELS = Object.freeze({
  seat: '教师坐班表',
  research: '教师教研签到表',
  class: '教师上课检查表',
});

export const ATTENDANCE_TYPE_SHORT = Object.freeze({
  seat: '坐班表',
  research: '教研表',
  class: '上课表',
});

const VALID_NAME = /^(?:[\p{Script=Han}A-Za-z·•.\-]{2,20})$/u;
const CONTROL_CHARS = /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e]/g;

export function normalizeAttendanceType(value) {
  const type = String(value ?? '').trim().toLowerCase();
  return ATTENDANCE_TYPES.includes(type) ? type : '';
}

export function attendanceTypeLabels(type) {
  const normalized = normalizeAttendanceType(type) || 'seat';
  return {
    type: normalized,
    label: ATTENDANCE_TYPE_LABELS[normalized],
    short: ATTENDANCE_TYPE_SHORT[normalized],
  };
}

/* V1.0 has exactly one seat, one research and one class table per grade/day.
   The period remains editable metadata; it is deliberately not part of the
   daily identity, so changing it cannot create another daily table. */
export function dayKeyOf(date, grade, type) {
  const normalizedType = normalizeAttendanceType(type);
  if (!normalizedType) throw new Error('未知考勤表类型');
  return `${String(date || '').trim()}|${String(grade || '').trim()}|${normalizedType}`;
}

export function dailySlots() {
  return ATTENDANCE_TYPES.map((type) => ({
    type,
    label: ATTENDANCE_TYPE_LABELS[type],
    short: ATTENDANCE_TYPE_SHORT[type],
  }));
}

export function tableTypeOf(table) {
  return normalizeAttendanceType(table?.sheet_type || table?.kind) || 'seat';
}

export function keeperForDailySlot(tables, date, grade, type) {
  const normalizedType = normalizeAttendanceType(type);
  if (!normalizedType) return null;
  const candidates = (Array.isArray(tables) ? tables : []).filter((table) => (
    !table?.deleted_at
    && String(table.sheet_date || '') === String(date || '')
    && String(table.grade || '') === String(grade || '')
    && tableTypeOf(table) === normalizedType
  ));
  candidates.sort((left, right) => {
    const leftConfirmed = left.confirm_state === 'confirmed' || left.confirmed_at ? 1 : 0;
    const rightConfirmed = right.confirm_state === 'confirmed' || right.confirmed_at ? 1 : 0;
    if (leftConfirmed !== rightConfirmed) return rightConfirmed - leftConfirmed;
    const leftFilled = Number(left.row_count || 0) - Number(left.summary?.none || 0);
    const rightFilled = Number(right.row_count || 0) - Number(right.summary?.none || 0);
    if (leftFilled !== rightFilled) return rightFilled - leftFilled;
    return Number(left.id || 0) - Number(right.id || 0);
  });
  return candidates[0] || null;
}

export function dailyTableState(tables, date, grade) {
  const slots = dailySlots().map((slot) => {
    const matches = (Array.isArray(tables) ? tables : []).filter((table) => (
      !table?.deleted_at
      && String(table.sheet_date || '') === String(date || '')
      && String(table.grade || '') === String(grade || '')
      && tableTypeOf(table) === slot.type
    ));
    return {
      ...slot,
      table: keeperForDailySlot(matches, date, grade, slot.type),
      duplicateCount: Math.max(0, matches.length - 1),
    };
  });
  const done = slots.filter((slot) => (
    slot.table
    && (slot.table.confirm_state === 'confirmed' || slot.table.confirmed_at)
  )).length;
  return {
    slots,
    done,
    built: slots.filter((slot) => !!slot.table).length,
    total: slots.length,
    duplicateCount: slots.reduce((sum, slot) => sum + slot.duplicateCount, 0),
  };
}

export function normalizeTeacherName(value) {
  const name = String(value ?? '')
    .normalize('NFKC')
    .replace(CONTROL_CHARS, '')
    .replace(/[\s\u3000]+/g, '')
    .trim();
  return VALID_NAME.test(name) ? name : '';
}

export function normalizeSubject(value) {
  const subject = String(value ?? '')
    .normalize('NFKC')
    .replace(CONTROL_CHARS, '')
    .replace(/[\s\u3000]+/g, '')
    .trim();
  if (!subject || subject.length > 20 || /^\d+$/.test(subject)) return '';
  return subject;
}

export function rosterIdentity(entry) {
  const name = normalizeTeacherName(entry?.name ?? entry?.teacher);
  const subject = normalizeSubject(entry?.subject);
  if (!name || !subject) return '';
  return `${name}\u0000${subject}`;
}

/**
 * Validate roster rows before they can be written.
 * Existing exact name+subject pairs are returned as duplicates. A 46-row input
 * with 46 unique valid pairs therefore remains 46 rows, in source order.
 */
export function prepareRosterEntries(items, { existing = [] } = {}) {
  const accepted = [];
  const invalid = [];
  const duplicates = [];
  const seen = new Set(
    (Array.isArray(existing) ? existing : [])
      .map((entry) => rosterIdentity(entry))
      .filter(Boolean),
  );

  (Array.isArray(items) ? items : []).forEach((entry, index) => {
    const name = normalizeTeacherName(entry?.name ?? entry?.teacher);
    const subject = normalizeSubject(entry?.subject);
    if (!name || !subject) {
      invalid.push({ index, entry, reason: !name ? '姓名无效或缺失' : '学科无效或缺失' });
      return;
    }
    const key = `${name}\u0000${subject}`;
    if (seen.has(key)) {
      duplicates.push({ index, entry: { ...entry, name, subject }, reason: '姓名与学科重复' });
      return;
    }
    seen.add(key);
    accepted.push({ ...entry, name, subject });
  });

  return {
    accepted,
    invalid,
    duplicates,
    ok: invalid.length === 0 && duplicates.length === 0,
  };
}

export function attendanceRowIdentity(row) {
  return rosterIdentity({ name: row?.teacher, subject: row?.subject });
}

/**
 * Rebuild a daily attendance row list from the current roster without confusing
 * teachers who share a name but teach different subjects. On today's sheet,
 * unlisted permanent teachers are hidden after roster deletion; temporary
 * cross-grade rows remain visible. Historical sheets keep their old rows.
 */
export function mergeAttendanceRosterRows(existingRows, roster, { hideUnlisted = false } = {}) {
  const existing = Array.isArray(existingRows) ? existingRows : [];
  const activeRoster = (Array.isArray(roster) ? roster : []).filter((teacher) => (
    Number(teacher?.active ?? 1) === 1 && normalizeTeacherName(teacher?.name) && normalizeSubject(teacher?.subject)
  ));
  const byIdentity = new Map();
  for (const row of existing) {
    const identity = attendanceRowIdentity(row);
    if (identity && !byIdentity.has(identity)) byIdentity.set(identity, row);
  }
  const rosterIdentities = new Set();
  const ordered = activeRoster.map((teacher) => {
    const identity = rosterIdentity(teacher);
    if (identity) rosterIdentities.add(identity);
    return (identity && byIdentity.get(identity)) || {
      teacher: String(teacher.name || '').trim(),
      subject: String(teacher.subject || '').trim(),
      data: {},
      _uiKey: `roster:${String(teacher.id || `${teacher.name}:${teacher.subject}`)}`,
    };
  });
  const other = existing.filter((row) => {
    const identity = attendanceRowIdentity(row);
    if (identity && rosterIdentities.has(identity)) return false;
    if (row?.data?.__temp) return true;
    return !hideUnlisted;
  });
  return [...ordered, ...other];
}

export function dedupeAttendanceRows(rows) {
  const out = [];
  const byIdentity = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const identity = attendanceRowIdentity(row);
    if (identity && byIdentity.has(identity)) {
      byIdentity.get(identity).push(row);
    } else {
      out.push(row);
      if (identity) byIdentity.set(identity, [row]);
    }
  }
  return { rows: out, duplicateGroups: [...byIdentity.values()].filter((group) => group.length > 1) };
}

/* A daily table is temporary-teacher safe only when the temporary identity is
   carried by that class row. It must never be promoted to the permanent roster. */
export function markTemporaryTeacher(row, { borrowGrade = '' } = {}) {
  return {
    ...row,
    data: {
      ...(row?.data || {}),
      __temp: 1,
      ...(borrowGrade ? { borrow_grade: String(borrowGrade) } : {}),
    },
  };
}

/* Research sheets can batch-sign one subject group. The operation is scoped
   to the supplied rows and never mutates seat/class rows. */
export function applyResearchSubjectBatch(rows, subject, checkKey = 'k_签到') {
  const normalizedSubject = normalizeSubject(subject);
  let affected = 0;
  const next = (Array.isArray(rows) ? rows : []).map((row) => {
    if (normalizeSubject(row?.subject) !== normalizedSubject) return row;
    affected += 1;
    const data = { ...(row.data || {}), [checkKey]: '1' };
    delete data.__leave;
    return { ...row, data };
  });
  return { rows: next, affected };
}
