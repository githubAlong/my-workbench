import test from 'node:test';
import assert from 'node:assert/strict';
import { installBrowser } from './test-browser.mjs';

installBrowser({ href: 'http://localhost/' });
const { handle } = await import('../js/localapi.js?attendance-localapi=1');

async function call(method, path, query = {}, body = undefined) {
  const response = await handle(method, path, query, body);
  assert.equal(response.ok, true, response.error || `${method} ${path}`);
  return response.data;
}

test('attendance V1 local API regression', async (t) => {
  await call('POST', '/grades', {}, { name: '高一' });
  await call('POST', '/grades', {}, { name: '高二' });

  const gradeOneTeachers = Array.from({ length: 46 }, (_, index) => ({
    name: `教师${String.fromCharCode(0x4e00 + index)}`,
    subject: index < 23 ? '语文' : '数学',
  }));
  const imported = await call('POST', '/teachers', {}, { grade: '高一', items: gradeOneTeachers });
  assert.equal(imported.ids.length, 46);
  await call('POST', '/teachers', {}, {
    grade: '高二',
    items: [{ name: '高二老师', subject: '英语' }],
  });

  await t.test('年级隔离与重复记录保护', async () => {
    const highOne = await call('GET', '/teachers', { grade: '高一' });
    const highTwo = await call('GET', '/teachers', { grade: '高二' });
    assert.equal(highOne.list.length, 46);
    assert.equal(highTwo.list.length, 1);
    const duplicate = await handle('POST', '/teachers', {}, {
      grade: '高一',
      items: [{ name: '教师一', subject: '语文' }],
    });
    assert.equal(duplicate.ok, false);
    assert.match(duplicate.error, /重复|校验/);
  });

  const baseTable = {
    grade: '高一',
    sheet_date: '2026-11-06',
    weekday: '五',
    month: '2026-11',
  };
  const seat = await call('POST', '/attendance', {}, {
    ...baseTable, sheet_type: 'seat', periods: '1', name: '高一坐班表',
  });
  const seatAgain = await call('POST', '/attendance', {}, {
    ...baseTable, sheet_type: 'seat', periods: '9', name: '错误重复表',
  });
  const research = await call('POST', '/attendance', {}, {
    ...baseTable, sheet_type: 'research', periods: '', name: '高一教研表',
  });
  const classSheet = await call('POST', '/attendance', {}, {
    ...baseTable, sheet_type: 'class', periods: '3', name: '高一上课表',
  });

  await t.test('每日三张表独立且 class 不映射为 seat', async () => {
    assert.equal(seatAgain.id, seat.id);
    const list = await call('GET', '/attendance', { sheet_date: '2026-11-06', grade: '高一' });
    assert.deepEqual(
      list.map((item) => item.sheet_type).sort(),
      ['class', 'research', 'seat'],
    );
    assert.equal(list.find((item) => item.sheet_type === 'class').id, classSheet.id);
    assert.notEqual(classSheet.id, seat.id);
  });

  const firstTeacher = gradeOneTeachers[0];
  const seedRows = (tableId, rows) => call('POST', `/attendance/${tableId}/rows`, {}, {
    rows,
    dirty: true,
  });
  await seedRows(seat.id, [{
    teacher: firstTeacher.name,
    subject: firstTeacher.subject,
    data: { k_请假: '1', __leave: { type: '病假', period: '上午', duration: 0.5 } },
  }]);
  await seedRows(research.id, [{
    teacher: firstTeacher.name,
    subject: firstTeacher.subject,
    data: { k_签到: '1' },
  }]);
  await seedRows(classSheet.id, [
    {
      teacher: firstTeacher.name,
      subject: firstTeacher.subject,
      data: { k_上课: '1' },
    },
    {
      teacher: '临时甲',
      subject: '物理',
      data: { k_上课: '1', __temp: 1, borrow_grade: '高二' },
    },
  ]);

  await t.test('三张表独立确认，修改后回到待重新确认', async () => {
    await call('POST', `/attendance/${seat.id}/confirm`);
    await call('POST', `/attendance/${research.id}/confirm`);
    await call('POST', `/attendance/${classSheet.id}/confirm`);
    const seatDetail = await call('GET', `/attendance/${seat.id}`);
    const classDetail = await call('GET', `/attendance/${classSheet.id}`);
    assert.equal(seatDetail.confirm_state, 'confirmed');
    assert.equal(classDetail.confirm_state, 'confirmed');

    const changedRows = classDetail.rows.map((row) => ({
      id: row.id,
      teacher: row.teacher,
      subject: row.subject,
      data: row.teacher === '临时甲'
        ? { ...row.data, k_听课: '1' }
        : row.data,
      expected_updated_at: row.updated_at,
    }));
    await call('POST', `/attendance/${classSheet.id}/rows`, {}, { rows: changedRows, dirty: true });
    const modified = await call('GET', `/attendance/${classSheet.id}`);
    assert.equal(modified.confirm_state, 'modified');
    assert.equal((await call('GET', `/attendance/${seat.id}`)).confirm_state, 'confirmed');
  });

  await t.test('临时教师只在上课表且不写入永久花名册', async () => {
    const roster = await call('GET', '/teachers', { grade: '高一', active: 'all' });
    assert.equal(roster.list.some((teacher) => teacher.name === '临时甲'), false);
    const nextDay = await call('POST', '/attendance', {}, {
      grade: '高一', sheet_date: '2026-11-07', month: '2026-11', weekday: '六',
      sheet_type: 'class', periods: '1', name: '高一上课表',
    });
    const nextDetail = await call('GET', `/attendance/${nextDay.id}`);
    assert.equal(nextDetail.rows.length, 0);
  });

  await t.test('请假细化与临时教师进入统计', async () => {
    const stats = await call('GET', '/attendance/stats', { grade: '高一', year: '2026' });
    const first = stats.year_rows.find((row) => row.name === firstTeacher.name);
    const temporary = stats.year_rows.find((row) => row.name === '临时甲');
    assert.equal(first.sick, 1);
    assert.equal(first.am, 1);
    assert.equal(first.hours, 0.5);
    assert.equal(first.classes, 1);
    assert.equal(first.research, 1);
    assert.equal(temporary.temp, 1);
    assert.equal(temporary.classes, 1);
  });

  await t.test('并发修改使用版本校验，过期写入不会静默覆盖', async () => {
    const before = await call('GET', `/attendance/${classSheet.id}`);
    const target = before.rows.find((row) => row.teacher === firstTeacher.name);
    const firstSaveRows = before.rows.map((row) => ({
      id: row.id,
      teacher: row.teacher,
      subject: row.subject,
      data: row.teacher === firstTeacher.name ? { ...row.data, k_坐班: '1' } : row.data,
      expected_updated_at: row.updated_at,
    }));
    await call('POST', `/attendance/${classSheet.id}/rows`, {}, { rows: firstSaveRows, dirty: true });

    const staleRows = before.rows.map((row) => ({
      id: row.id,
      teacher: row.teacher,
      subject: row.subject,
      data: row.id === target.id ? { ...row.data, k_听课: '1' } : row.data,
      expected_updated_at: row.updated_at,
    }));
    const stale = await handle('POST', `/attendance/${classSheet.id}/rows`, {}, {
      rows: staleRows,
      dirty: true,
    });
    assert.equal(stale.ok, false);
    assert.equal(stale.code, 409);
    assert.match(stale.error, /WB_ATTENDANCE_CONFLICT/);
  });

  await t.test('表头更新也拒绝使用过期版本', async () => {
    const before = await call('GET', `/attendance/${seat.id}`);
    const staleVersion = before.updated_at;
    await call('PATCH', `/attendance/${seat.id}`, {}, {
      expected_updated_at: staleVersion,
      name: '高一坐班表·已更新',
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const stale = await handle('PATCH', `/attendance/${seat.id}`, {}, {
      expected_updated_at: staleVersion,
      name: '不该覆盖的名称',
    });
    assert.equal(stale.ok, false);
    assert.equal(stale.code, 409);
    assert.match(stale.error, /WB_ATTENDANCE_CONFLICT/);
  });
});
