import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { installBrowser } from './test-browser.mjs';

installBrowser({ href: 'http://localhost/' });
const { handle } = await import('../js/localapi.js?attendance-performance=1');

async function call(method, path, query = {}, body = undefined) {
  const response = await handle(method, path, query, body);
  assert.equal(response.ok, true, response.error || `${method} ${path}`);
  return response.data;
}

test('500-teacher grade exposes 1000 daily records within the list target', async () => {
  await call('POST', '/grades', {}, { name: '规模测试年级' });
  const teachers = Array.from({ length: 500 }, (_, index) => ({
    name: `教师${String.fromCharCode(0x4e00 + index)}`,
    subject: index % 2 ? '语文' : '数学',
  }));
  await call('POST', '/teachers', {}, { grade: '规模测试年级', items: teachers });

  const bodyRows = (rows) => ({
    rows: rows.map((teacher) => ({
      teacher: teacher.name,
      subject: teacher.subject,
      data: { k_上课: '1' },
    })),
    dirty: true,
  });
  const seat = await call('POST', '/attendance', {}, {
    grade: '规模测试年级',
    sheet_type: 'seat',
    sheet_date: '2026-11-06',
    month: '2026-11',
    name: '规模坐班表',
  });
  const classSheet = await call('POST', '/attendance', {}, {
    grade: '规模测试年级',
    sheet_type: 'class',
    sheet_date: '2026-11-06',
    month: '2026-11',
    name: '规模上课表',
  });
  await call('POST', `/attendance/${seat.id}/rows`, {}, bodyRows(teachers));
  await call('POST', `/attendance/${classSheet.id}/rows`, {}, bodyRows(teachers));

  const started = performance.now();
  const list = await call('GET', '/attendance', {
    grade: '规模测试年级',
    sheet_date: '2026-11-06',
  });
  const elapsed = performance.now() - started;
  assert.equal(list.length, 2);
  assert.equal(list.reduce((sum, table) => sum + table.row_count, 0), 1000);
  assert.ok(elapsed < 1000, `local list load took ${elapsed.toFixed(1)}ms`);
});
