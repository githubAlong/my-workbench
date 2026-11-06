import test from 'node:test';
import assert from 'node:assert/strict';
import {
  attendanceExportFileName,
  attendanceExportGrid,
  recentMonthKeys,
  resolveWatermarkText,
} from '../js/attendance-export.mjs';

test('PDF/PNG/Excel export source keeps each attendance table separate', () => {
  const rows = [{ teacher: '张老师', subject: '语文', data: { k_上课: '1', k_请假: '0' } }];
  const columns = [
    { key: 'k_上课', label: '上课', type: 'check' },
    { key: 'k_请假', label: '请假', type: 'check' },
  ];
  const seat = attendanceExportGrid({ grade: '高一', date: '2026-11-06', type: 'seat', period: '第1节', timeRange: '08:00-08:40', columns, rows });
  const classSheet = attendanceExportGrid({ grade: '高一', date: '2026-11-06', type: 'class', period: '第1节', timeRange: '08:00-08:40', columns, rows });
  assert.equal(seat[0][0], '高一考勤表');
  assert.deepEqual(seat[1], ['表类型：坐班表', '日期：2026-11-06', '时间段：08:00-08:40', '节次：第1节']);
  assert.equal(classSheet[1][0], '表类型：上课表');
  assert.notDeepEqual(seat[1], classSheet[1]);
  assert.equal(seat[2][0], '序号');
  assert.equal(seat[3][3], '✓');
  assert.equal(
    attendanceExportFileName({ grade: '高一', date: '2026-11-06', type: 'class', extension: 'xlsx' }),
    '高一上课表_2026-11-06.xlsx',
  );
});

test('watermark can be disabled or rendered with fixed placeholders', () => {
  assert.equal(resolveWatermarkText({ on: false, text: '{grade}' }, { grade: '高一' }), '');
  assert.equal(
    resolveWatermarkText({ on: true, text: '{grade}-{date}-{name}' }, {
      grade: '高一', date: '2026-11-06', name: '坐班表',
    }),
    '高一-2026-11-06-坐班表',
  );
});

test('rolling year window crosses the calendar-year boundary', () => {
  assert.deepEqual(recentMonthKeys(new Date(2026, 1, 15), 12), [
    '2025-03', '2025-04', '2025-05', '2025-06', '2025-07', '2025-08',
    '2025-09', '2025-10', '2025-11', '2025-12', '2026-01', '2026-02',
  ]);
});
