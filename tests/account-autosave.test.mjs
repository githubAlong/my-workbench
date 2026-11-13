import test from 'node:test';
import assert from 'node:assert/strict';
import { installBrowser } from './test-browser.mjs';

let scenario = 0;
const flush = async () => { for (let turn = 0; turn < 8; turn += 1) await new Promise(setImmediate); };

async function setup(context, { missing = false, failOnce = false } = {}) {
  const storage = installBrowser({ href: 'https://githubalong.github.io/mywork-master/' });
  globalThis.window = new EventTarget();
  const element = () => ({ style: {}, classList: { add() {} }, appendChild() {}, remove() {}, isConnected: false });
  document.getElementById = element;
  document.createElement = () => ({ content: { firstElementChild: element() } });
  const db = await import('../js/localdb.js');
  const uid = 'autosave-test-' + ++scenario;
  db.setActiveAccount(uid);
  storage.setItem('wb_supa_tok', JSON.stringify({ uid, access_token: 'test-only', expires_at: Date.now() + 3600000 }));
  let remote = missing ? null : { payload: { ...db.blank(), notes: [{ id: 1, title: 'original' }] }, revision: 1 };
  storage.setItem(db.DB_KEY, JSON.stringify(remote?.payload || db.blank()));
  const writes = [];
  let release = null;
  let hold = false;
  let shouldFail = failOnce;
  globalThis.fetch = async (url, options = {}) => {
    if (url.includes('/rpc/wb_save_user_data')) {
      const body = JSON.parse(options.body);
      writes.push(body);
      if (shouldFail) { shouldFail = false; throw new TypeError('Failed to fetch'); }
      if (hold) { hold = false; await new Promise(resolve => { release = resolve; }); }
      remote = { payload: body.p_payload, revision: (remote?.revision || 0) + 1 };
      return Response.json([remote]);
    }
    return Response.json(remote ? [remote] : []);
  };
  const sync = await import('../js/cloudsync.js?autosave=' + scenario);
  await sync.initializeAccountSync();
  window.addEventListener('wb:localchange', sync.hookSave);
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const advance = async (milliseconds = 3000) => { context.mock.timers.tick(milliseconds); await flush(); };
  return { db, sync, storage, writes, advance, holdNext: () => { hold = true; }, release: () => release(),
    remote: payload => { remote = { payload, revision: (remote?.revision || 0) + 1 }; } };
}

test('opening a fresh account does not upload an unchanged initial snapshot', async context => {
  const state = await setup(context, { missing: true });
  await state.advance(10000);
  await state.sync.initializeAccountSync();
  await state.sync.pushNow();
  assert.equal(state.writes.length, 0);
});

test('repeated identical local saves and sync notifications produce no uploads', async context => {
  const state = await setup(context);
  let changes = 0;
  window.addEventListener('wb:localchange', () => { changes += 1; });
  state.db.load();
  for (let count = 0; count < 10; count += 1) { assert.equal(state.db.save(), true); state.sync.hookSave(); }
  await state.advance(30000);
  assert.equal(changes, 0);
  assert.equal(state.writes.length, 0);
});

test('one real edit is saved once and rapid edits are combined into the latest payload', async context => {
  const state = await setup(context);
  state.db.load().notes[0].title = 'first';
  state.db.save();
  await state.advance(400);
  state.db.load().notes[0].title = 'latest';
  state.db.save();
  await state.advance(2999);
  assert.equal(state.writes.length, 0);
  await state.advance(1);
  assert.equal(state.writes.length, 1);
  assert.equal(state.writes[0].p_payload.notes[0].title, 'latest');
  for (let count = 0; count < 5; count += 1) state.sync.hookSave();
  await state.advance(30000);
  assert.equal(state.writes.length, 1);
});

test('reverting before debounce expires cancels the upload', async context => {
  const state = await setup(context);
  state.db.load().notes[0].title = 'temporary';
  state.db.save();
  state.db.load().notes[0].title = 'original';
  state.db.save();
  await state.advance(30000);
  assert.equal(state.writes.length, 0);
});

test('edits made while a save is in flight are saved afterwards without being lost', async context => {
  const state = await setup(context);
  state.holdNext();
  state.db.load().notes[0].title = 'in-flight';
  state.db.save();
  await state.advance();
  state.db.load().notes[0].title = 'latest';
  state.db.save();
  state.release();
  await flush();
  await state.advance();
  assert.equal(state.writes.length, 2);
  assert.equal(state.writes[1].p_payload.notes[0].title, 'latest');
  await state.advance(30000);
  assert.equal(state.writes.length, 2);
});

test('reverting to the old baseline during an in-flight save is preserved', async context => {
  const state = await setup(context);
  state.holdNext();
  state.db.load().notes[0].title = 'in-flight';
  state.db.save();
  await state.advance();
  state.db.load().notes[0].title = 'original';
  state.db.save();
  state.release();
  await flush();
  await state.advance();
  assert.equal(state.writes.length, 2);
  assert.equal(state.writes[1].p_payload.notes[0].title, 'original');
});

test('remote refresh updates the baseline without uploading the downloaded snapshot', async context => {
  const state = await setup(context);
  state.remote({ ...state.db.blank(), notes: [{ id: 1, title: 'remote' }] });
  assert.equal(await state.sync.refreshAccountSync(), true);
  state.db.save();
  state.sync.hookSave();
  await state.advance(30000);
  assert.equal(state.writes.length, 0);
  state.db.load().notes[0].title = 'edited remote';
  state.db.save();
  await state.advance();
  assert.equal(state.writes.length, 1);
});

test('transient failure retries the unsaved edit, then stops retrying after acknowledgement', async context => {
  const state = await setup(context, { failOnce: true });
  context.mock.method(console, 'error', () => {});
  state.db.load().notes[0].title = 'keep this edit';
  state.db.save();
  await state.advance();
  assert.equal(state.writes.length, 1);
  await state.advance(1500);
  assert.equal(state.writes.length, 2);
  assert.equal(state.writes[1].p_payload.notes[0].title, 'keep this edit');
  await state.advance(30000);
  assert.equal(state.writes.length, 2);
});

test('saving identical fields does not update record timestamps or signal a change', async context => {
  const state = await setup(context);
  let changes = 0;
  window.addEventListener('wb:localchange', () => { changes += 1; });
  state.db.updateRow('notes', 1, { title: 'original' });
  await state.advance(30000);
  assert.equal(state.db.load().notes[0].updated_at, undefined);
  assert.equal(changes, 0);
  assert.equal(state.writes.length, 0);
});

test('periodic reminder and message reads do not trigger automatic saves', async context => {
  const state = await setup(context);
  const { handle } = await import('../js/localapi.js');
  let changes = 0;
  window.addEventListener('wb:localchange', () => { changes += 1; });
  for (let count = 0; count < 20; count += 1) {
    assert.equal((await handle('GET', '/reminders')).ok, true);
    assert.equal((await handle('GET', '/messages')).ok, true);
    await state.advance(5000);
  }
  assert.equal(changes, 0);
  assert.equal(state.writes.length, 0);
});

test('semantically identical snapshots with reordered keys do not upload', async context => {
  const state = await setup(context);
  const original = state.db.load();
  state.db.replaceAll(Object.fromEntries(Object.entries(original).reverse()));
  await state.advance(30000);
  assert.equal(state.writes.length, 0);
});

test('remote events cannot overwrite a local revert while its earlier save is still in flight', async context => {
  const state = await setup(context);
  state.holdNext();
  state.db.load().notes[0].title = 'in-flight';
  state.db.save();
  await state.advance();
  state.db.load().notes[0].title = 'original';
  state.db.save();
  state.remote({ ...state.db.blank(), notes: [{ id: 1, title: 'remote event' }] });
  assert.equal(await state.sync.refreshAccountSync(), false);
  assert.equal(state.db.load().notes[0].title, 'original');
  state.release();
  await flush();
  await state.advance();
  assert.equal(state.writes.at(-1).p_payload.notes[0].title, 'original');
});

