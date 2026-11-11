import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileTaskMessages } from '../js/task-messages.mjs';
import { installBrowser } from './test-browser.mjs';

const today = '2026-11-10', now = today + 'T12:00:00Z';
test('one task reminder per linked pair, distinct tasks with identical titles are retained', () => {
  const db = { items: [{ id: 1, title: '买牛奶', status: 'doing', created_at: now }, { id: 2, title: '买牛奶', status: 'todo', created_at: now }], todos: [{ id: 9, ref_item_id: 1 }], messages: [{ id: 1, type: 'task', ref_type: 'items', ref_id: 1, read: 0 }, { id: 2, type: 'task', ref_type: 'todos', ref_id: 9, read: 0 }] };
  assert.equal(reconcileTaskMessages(db, { today, now }), true);
  const visible = db.messages.filter(row => !row.deleted_at);
  assert.equal(visible.length, 2);
  assert.equal(visible.find(row => row.ref_id === 1).task_status, 'doing');
  assert.equal(reconcileTaskMessages(db, { today, now }), false);
});

test('historic reminders follow renamed and completed tasks, reopening restores automatically read reminders', () => {
  const item = { id: 1, title: '新标题', status: 'done', created_at: '2026-11-09T10:00:00Z' };
  const db = { items: [item], messages: [{ id: 1, type: 'task', title: '旧标题', body: '没完成', ref_type: 'items', ref_id: 1, read: 0 }] };
  reconcileTaskMessages(db, { today, now });
  assert.equal(db.messages[0].title, '新标题'); assert.equal(db.messages[0].body, '已完成'); assert.equal(db.messages[0].read, 1);
  item.status = 'doing'; reconcileTaskMessages(db, { today, now });
  assert.equal(db.messages[0].read, 0); assert.equal(db.messages[0].body, '进行中');
  db.messages[0].read = 1; db.messages[0].task_auto_read = false;
  item.status = 'done'; reconcileTaskMessages(db, { today, now });
  item.status = 'todo'; reconcileTaskMessages(db, { today, now });
  assert.equal(db.messages[0].read, 1, 'manual reading remains independent of task completion');
});

test('deleted sources and dismissed reminders do not reappear, system messages are untouched', () => {
  const db = { items: [{ id: 1, title: '删除', deleted_at: now }, { id: 2, title: '关闭提醒', status: 'todo', created_at: now }], messages: [{ id: 1, type: 'task', ref_type: 'items', ref_id: 1 }, { id: 2, type: 'task', ref_type: 'items', ref_id: 2, deleted_at: now }, { id: 3, type: 'system', title: '系统消息', read: 0 }] };
  reconcileTaskMessages(db, { today, now });
  assert.deepEqual(db.messages.filter(row => !row.deleted_at).map(row => row.id), [3]);
  assert.equal(reconcileTaskMessages(db, { today, now }), false);
});

test('actual home, note and message APIs agree in all states and unchanged reads never save', async () => {
  const storage = installBrowser();
  const db = await import('../js/localdb.js');
  db.setActiveAccount('message-sync-test'); db.replaceAll(db.blank());
  const { handle } = await import('../js/localapi.js');
  const call = async (method, path, body, query = {}) => {
    const result = await handle(method, path, query, body);
    assert.equal(result.ok, true, result.error); return result.data;
  };
  const note = await call('POST', '/todos', { title: '联动事项' });
  for (const table of ['items', 'todos']) for (const status of ['doing', 'done', 'todo']) {
    await call('PATCH', '/' + table + '/' + (table === 'items' ? note.ref_item_id : note.id), { status });
    const home = await call('GET', '/home');
    const notes = await call('GET', '/todos');
    const messages = await call('GET', '/messages');
    assert.equal(home.items.find(row => row.id === note.ref_item_id).status, status);
    assert.equal(notes.find(row => row.id === note.id).status, status);
    assert.equal(messages.rows.length, 1);
    assert.equal(messages.rows[0].task_status, status);
    assert.equal(home.unread, messages.unread);
    assert.equal(messages.unread, status === 'done' ? 0 : 1);
  }
  let writes = 0;
  const original = storage.setItem.bind(storage);
  storage.setItem = (key, value) => { if (key === db.DB_KEY) writes++; original(key, value); };
  for (let i = 0; i < 3; i++) for (const path of ['/messages', '/home', '/todos', '/items']) await call('GET', path);
  assert.equal(writes, 0);
  await call('POST', '/messages/read', { all: true });
  assert.equal((await call('GET', '/todos'))[0].status, 'todo');
  await call('POST', '/messages/clear', { readOnly: true });
  for (let i = 0; i < 3; i++) assert.equal((await call('GET', '/messages')).rows.length, 0);
});
