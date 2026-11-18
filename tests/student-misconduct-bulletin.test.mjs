import test from 'node:test';
import assert from 'node:assert/strict';
import { installBrowser } from './test-browser.mjs';

installBrowser({ href: 'http://localhost/' });
const { handle } = await import('../js/localapi.js?student-misconduct-bulletin=1');

async function call(method, path, query = {}, body = undefined) {
  const response = await handle(method, path, query, body);
  assert.equal(response.ok, true, response.error || `${method} ${path}`);
  return response.data;
}

/* 违纪 / 留言板的方向：学生端是输入端，老师端只查看、编辑、删除。 */
test('student submits misconduct and bulletin, teacher edits and deletes', async (t) => {
  const link = await call('POST', '/links', {}, { title: '测试班' });
  const code = link.code;

  await t.test('student submits misconduct, teacher edits it', async () => {
    const created = await call('POST', `/public/link/${code}/misconduct`, {}, {
      grade: '高二', class_name: '1班', content: '上课说话',
    });
    const before = (await call('GET', '/misconduct_records')).find((r) => r.id === created.id);
    assert.equal(before.content, '上课说话');
    assert.equal(before.source, 'student');
    assert.equal(before.grade, '高二');
    assert.equal(before.class_name, '1班');

    await call('PATCH', `/misconduct_records/${created.id}`, {}, { grade: '高二', class_name: '2班', content: '上课说话，已谈话' });
    const after = (await call('GET', '/misconduct_records')).find((r) => r.id === created.id);
    assert.equal(after.content, '上课说话，已谈话');
    assert.equal(after.class_name, '2班');
  });

  await t.test('student submits bulletin, teacher deletes it', async () => {
    const created = await call('POST', `/public/link/${code}/bulletin`, {}, {
      grade: '高一', class_name: '3班', content: '想多讲一道例题',
    });
    const before = (await call('GET', '/bulletin_records')).find((r) => r.id === created.id);
    assert.equal(before.content, '想多讲一道例题');
    assert.equal(before.source, 'student');

    await call('DELETE', `/bulletin_records/${created.id}`);
    const after = await call('GET', '/bulletin_records');
    assert.equal(after.some((r) => r.id === created.id), false);
  });

  await t.test('empty content is rejected', async () => {
    const misconduct = await handle('POST', `/public/link/${code}/misconduct`, {}, { grade: '高二', class_name: '1班', content: '  ' });
    assert.equal(misconduct.ok, false);
    const bulletin = await handle('POST', `/public/link/${code}/bulletin`, {}, { grade: '高二', class_name: '1班', content: '' });
    assert.equal(bulletin.ok, false);
  });
});
