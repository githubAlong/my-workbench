import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileTaskLinks } from '../js/todo-item-sync.mjs';
import { installBrowser } from './test-browser.mjs';

test('historic notes and manual home items are paired once without matching or merging titles', () => {
  const db = { seqs: {}, todos: [{ id: 1, title: '同名事项', status: 'doing', created_at: '2026-11-10T02:00:00Z' }], items: [{ id: 1, title: '同名事项', status: 'todo', created_at: '2026-11-10T01:00:00Z' }] };
  assert.equal(reconcileTaskLinks(db), true);
  assert.equal(db.todos.length, 2); assert.equal(db.items.length, 2);
  const item = db.items.find(row => row.id === db.todos[0].ref_item_id);
  assert.equal(item.status, 'doing'); assert.equal(item.created_at, db.todos[0].created_at);
  const snapshot = structuredClone(db);
  assert.equal(reconcileTaskLinks(db), false);
  assert.deepEqual(db, snapshot);
});
test('existing reverse-only links are repaired without duplicate records', () => {
  const db = { todos: [{ id: 4, title: '便签', status: 'todo' }], items: [{ id: 9, title: '便签', status: 'done', source: '便签', ref_id: 4 }] };
  reconcileTaskLinks(db);
  assert.equal(db.todos[0].ref_item_id, 9); assert.equal(db.todos[0].status, 'done');
  assert.equal(db.todos.length, 1); assert.equal(db.items.length, 1);
});
test('latest state is used for historic mismatches and all three states synchronize in both directions', () => {
  const db = { todos: [{ id: 1, title: '便签', status: 'doing', updated_at: '2026-11-10T10:00:00Z', ref_item_id: 1 }], items: [{ id: 1, title: '事项', status: 'todo', updated_at: '2026-11-10T09:00:00Z', source: '便签', ref_id: 1 }] };
  reconcileTaskLinks(db); assert.equal(db.items[0].status, 'doing');
  for (const table of ['todos', 'items']) for (const status of ['todo', 'doing', 'done']) {
    db[table][0].status = status;
    reconcileTaskLinks(db, { sourceTable: table, sourceId: 1, fields: ['status'] });
    assert.equal(db.todos[0].status, status); assert.equal(db.items[0].status, status);
  }
});
test('unrelated module references and deleted counterparts are not reconnected or resurrected', () => {
  const db = { todos: [{ id: 1, title: '便签', status: 'doing' }, { id: 2, title: '已删除', deleted_at: '2026-11-10', ref_item_id: 3 }], items: [{ id: 1, title: '报销', source: '出差', ref_id: 1, status: 'todo' }, { id: 3, title: '保留事项', source: '便签', ref_id: 2, status: 'todo' }] };
  reconcileTaskLinks(db);
  assert.equal(db.items[0].status, 'todo'); assert.equal(db.items[0].source, '出差');
  assert.notEqual(db.todos[0].ref_item_id, 1);
  assert.equal(db.todos.filter(row => !row.deleted_at).length, 1);
});
test('unchanged linked states do not change timestamps or data on repeated reconciliation', () => {
  const db = { seqs: {}, todos: [{ id: 1, title: '便签', status: 'doing', ref_item_id: 2, updated_at: '2026-11-10T09:00:00Z' }], items: [{ id: 2, title: '便签', status: 'doing', source: '便签', ref_id: 1, updated_at: '2026-11-10T08:00:00Z' }] };
  const before = structuredClone(db);
  assert.equal(reconcileTaskLinks(db, { sourceTable: 'items', sourceId: 2, fields: ['status'] }), false);
  assert.deepEqual(db, before);
});

test('local API creates mirrored records and synchronizes state and details without duplicate saves', async () => {
  const storage = installBrowser();
  const db = await import('../js/localdb.js');
  db.setActiveAccount('task-sync-test');
  storage.setItem(db.DB_KEY, JSON.stringify(db.blank()));
  const { handle } = await import('../js/localapi.js');
  const call = async (method, path, body) => {
    const result = await handle(method, path, {}, body);
    assert.equal(result.ok, true, result.error); return result.data;
  };
  const note = await call('POST', '/todos', { title: '买牛奶', content: '两盒', status: 'todo' });
  assert.ok(note.ref_item_id);
  const itemId = note.ref_item_id;
  for (const status of ['doing', 'done', 'todo']) {
    await call('PATCH', '/todos/' + note.id, { status });
    assert.equal(db.load().items.find(row => row.id === itemId).status, status);
    await call('PATCH', '/items/' + itemId, { status: status === 'done' ? 'doing' : 'done' });
    assert.equal(db.load().todos.find(row => row.id === note.id).status, status === 'done' ? 'doing' : 'done');
  }
  await call('PATCH', '/items/' + itemId, { detail: '改为三盒' });
  assert.equal(db.load().todos.find(row => row.id === note.id).content, '改为三盒');
  const item = await call('POST', '/items', { title: '首页新增事项', status: 'doing' });
  const linked = db.load().todos.find(row => row.ref_item_id === item.id);
  assert.equal(linked.status, 'doing');
  assert.equal(db.load().items.length, 2); assert.equal(db.load().todos.length, 2);
  let writes = 0;
  const original = storage.setItem.bind(storage);
  storage.setItem = (key, value) => { if (key === db.DB_KEY) writes += 1; original(key, value); };
  await call('PATCH', '/todos/' + linked.id, { status: 'doing' });
  await call('PATCH', '/items/' + item.id, { status: 'doing' });
  assert.equal(writes, 0);
});

test('China date does not apply the browser timezone twice or move evening notes into tomorrow', async () => {
  const { cnDate, handle } = await import('../js/localapi.js');
  const db = await import('../js/localdb.js');
  const previous = process.env.TZ;
  try {
    for (const timezone of ['UTC', 'Asia/Shanghai', 'America/New_York']) {
      process.env.TZ = timezone;
      assert.equal(cnDate(new Date('2026-11-10T14:40:00Z')), '2026-11-10');
      assert.equal(cnDate(new Date('2026-11-10T16:00:00Z')), '2026-11-11');
      db.replaceAll({ ...db.blank(), items: [{ id: 1, title: '晚间事项', status: 'todo', created_at: '2026-11-10T14:40:00Z' }] });
      const result = await handle('GET', '/calendar/day', { date: '2026-11-10' });
      assert.equal(result.data.items.length, 1);
    }
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});

