import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ATTENDANCE_TYPES,
  applyResearchSubjectBatch,
  attendanceTypeLabels,
  dailySlots,
  dailyTableState,
  dayKeyOf,
  dedupeAttendanceRows,
  markTemporaryTeacher,
  mergeAttendanceRosterRows,
  normalizeAttendanceType,
  prepareRosterEntries,
} from '../js/attendance-domain.mjs';

test('class is a first-class attendance type and never collapses to seat', () => {
  assert.deepEqual(ATTENDANCE_TYPES, ['seat', 'research', 'class']);
  assert.equal(normalizeAttendanceType('class'), 'class');
  assert.equal(attendanceTypeLabels('class').label, '教师上课检查表');
  assert.notEqual(normalizeAttendanceType('class'), 'seat');
});

test('each grade/day has exactly three stable table identities', () => {
  assert.deepEqual(dailySlots().map((slot) => slot.type), ['seat', 'research', 'class']);
  assert.equal(dayKeyOf('2026-11-06', '高一', 'seat'), '2026-11-06|高一|seat');
  assert.equal(dayKeyOf('2026-11-06', '高一', 'class'), '2026-11-06|高一|class');
  assert.equal(
    dayKeyOf('2026-11-06', '高一', 'seat', '1'),
    dayKeyOf('2026-11-06', '高一', 'seat', '9'),
  );
});

test('46 unique teachers remain exactly 46 records in source order', () => {
  const entries = Array.from({ length: 46 }, (_, index) => ({
    name: `教师${String.fromCharCode(0x4e00 + index)}`,
    subject: index < 23 ? '语文' : '数学',
  }));
  const result = prepareRosterEntries(entries);
  assert.equal(result.accepted.length, 46);
  assert.equal(result.accepted[0].name, '教师一');
  assert.equal(result.accepted.at(-1).name, '教师中');
  assert.equal(result.invalid.length, 0);
  assert.equal(result.duplicates.length, 0);
});

test('name and subject are required and exact duplicate records are rejected', () => {
  const result = prepareRosterEntries([
    { name: '张老师', subject: '语文' },
    { name: '张老师', subject: '语文' },
    { name: '李老师', subject: '' },
    { name: '', subject: '数学' },
    { name: '王老师', subject: '英语' },
  ]);
  assert.deepEqual(result.accepted.map((row) => row.name), ['张老师', '王老师']);
  assert.equal(result.duplicates.length, 1);
  assert.equal(result.invalid.length, 2);
});

test('three daily tables confirm independently', () => {
  const tables = [
    { id: 1, grade: '高一', sheet_date: '2026-11-06', sheet_type: 'seat', confirm_state: 'confirmed' },
    { id: 2, grade: '高一', sheet_date: '2026-11-06', sheet_type: 'research', confirm_state: 'modified' },
    { id: 3, grade: '高一', sheet_date: '2026-11-06', sheet_type: 'class', confirm_state: 'none' },
  ];
  const state = dailyTableState(tables, '2026-11-06', '高一');
  assert.equal(state.total, 3);
  assert.equal(state.built, 3);
  assert.equal(state.done, 1);
  assert.equal(state.slots.find((slot) => slot.type === 'class').table.id, 3);
});

test('temporary class teacher is row-scoped and duplicate row identities collapse', () => {
  const temporary = markTemporaryTeacher(
    { teacher: '借调老师', subject: '物理', data: {} },
    { borrowGrade: '高二' },
  );
  assert.equal(temporary.data.__temp, 1);
  assert.equal(temporary.data.borrow_grade, '高二');
  const { rows, duplicateGroups } = dedupeAttendanceRows([
    temporary,
    { teacher: '借调老师', subject: '物理', data: { __temp: 1 } },
    { teacher: '在册老师', subject: '数学', data: {} },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(duplicateGroups.length, 1);
});

test('attendance rows match by name and subject, not name alone', () => {
  const merged = mergeAttendanceRosterRows([
    { teacher: '王老师', subject: '语文', data: { k_上课: '1' } },
    { teacher: '王老师', subject: '数学', data: { k_上课: '0' } },
  ], [
    { id: 1, name: '王老师', subject: '语文', active: 1 },
    { id: 2, name: '王老师', subject: '数学', active: 1 },
  ]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].data.k_上课, '1');
  assert.equal(merged[1].data.k_上课, '0');
});

test('deleting a teacher hides only today's permanent row but preserves history and temporary rows', () => {
  const existing = [
    { teacher: '在册老师', subject: '语文', data: { k_上课: '1' } },
    { teacher: '已删除老师', subject: '数学', data: { k_上课: '0' } },
    { teacher: '借调老师', subject: '物理', data: { __temp: 1, borrow_grade: '高二' } },
  ];
  const roster = [{ id: 1, name: '在册老师', subject: '语文', active: 1 }];
  const today = mergeAttendanceRosterRows(existing, roster, { hideUnlisted: true });
  assert.deepEqual(today.map((row) => row.teacher), ['在册老师', '借调老师']);
  const history = mergeAttendanceRosterRows(existing, roster, { hideUnlisted: false });
  assert.deepEqual(history.map((row) => row.teacher), ['在册老师', '已删除老师', '借调老师']);
});

test('research subject filter batch-signs only the selected subject', () => {
  const rows = [
    { teacher: '语文甲', subject: '语文', data: {} },
    { teacher: '语文乙', subject: '语文', data: { __leave: { type: '事假' } } },
    { teacher: '数学甲', subject: '数学', data: {} },
  ];
  const result = applyResearchSubjectBatch(rows, '语文');
  assert.equal(result.affected, 2);
  assert.equal(result.rows[0].data.k_签到, '1');
  assert.equal(result.rows[1].data.k_签到, '1');
  assert.equal(result.rows[1].data.__leave, undefined);
  assert.equal(result.rows[2].data.k_签到, undefined);
});
