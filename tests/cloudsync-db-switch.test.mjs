import test from 'node:test';
import assert from 'node:assert/strict';
import { installBrowser } from './test-browser.mjs';
import { writeJournal, LOCAL_DRAFT_PREFIX } from '../js/sync-journal.mjs';

const flush = async () => { for (let turn = 0; turn < 8; turn += 1) await new Promise(setImmediate); };
let scenario = 0;

/* 线上真实事故：数据库从自建 Supabase 换到云上 Supabase，账号 uid 没变，
   但新库的 revision 从零重来（156），而浏览器里还留着旧库的 revision 24674。
   旧代码会把这两份完全不同的快照当成「同一内容的两种修改」，
   直接判定整份冲突 → _conflictPaused 置位 → 之后每次保存都抛
   「云端同步尚未就绪或已暂停」，用户存不进任何数据，刷新也恢复不了。 */
test('本地缓存来自旧数据库时以云端为准，并恢复保存能力', async context => {
  const storage = installBrowser({ href: 'https://githubalong.github.io/mywork-master/' });
  globalThis.window = new EventTarget();
  const element = () => ({ style: {}, classList: { add() {} }, appendChild() {}, remove() {}, isConnected: false });
  document.getElementById = element;
  document.createElement = () => ({ content: { firstElementChild: element() } });

  const db = await import('../js/localdb.js');
  const uid = 'db-switch-' + ++scenario;
  db.setActiveAccount(uid);
  storage.setItem('wb_supa_tok', JSON.stringify({ uid, access_token: 'test-only', expires_at: Date.now() + 3600000 }));

  // 旧库留在浏览器里的一整套同步状态：库体、版本号、待同步日志、标签页草稿
  const oldSnapshot = { ...db.blank(), notes: [{ id: 1, title: '旧库记录' }] };
  storage.setItem(db.DB_KEY, JSON.stringify(oldSnapshot));
  storage.setItem('wb_account_revision:' + uid, '24674');
  writeJournal(storage, uid, {
    base: oldSnapshot,
    draft: { ...oldSnapshot, notes: [{ id: 1, title: '旧库未同步的修改' }] },
    revision: 24674,
  });
  storage.setItem(LOCAL_DRAFT_PREFIX + uid + ':tab2', JSON.stringify({
    uid, base: oldSnapshot, draft: oldSnapshot, conflicts: [], at: new Date().toISOString(),
  }));

  // 新库：迁过来的主账号快照，revision 只有 156
  const remotePayload = { ...db.blank(), notes: [{ id: 1, title: '新库记录' }] };
  let remoteRevision = 156;
  const writes = [];
  globalThis.fetch = async (url, options = {}) => {
    if (url.includes('/rpc/wb_save_user_data')) {
      const body = JSON.parse(options.body);
      writes.push(body);
      remoteRevision += 1;
      return Response.json([{ payload: body.p_payload, revision: remoteRevision }]);
    }
    return Response.json([{ payload: remotePayload, revision: remoteRevision }]);
  };

  context.mock.method(console, 'warn', () => {});
  const sync = await import('../js/cloudsync.js?dbswitch=' + scenario);
  await sync.initializeAccountSync();

  // 1) 不能停在冲突态：这是用户「一个字都存不进去」的直接原因
  assert.equal(sync.getAccountSyncStatus().status, 'saved');
  assert.deepEqual(sync.getSyncConflicts(), []);
  await assert.doesNotReject(() => sync.pushNow());

  // 2) 本机内容以新库为准，旧库的行不能混进来
  assert.equal(db.load().notes[0].title, '新库记录');

  // 3) 旧库数据整份留档，能找到也能找回
  const backups = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key?.startsWith('wb_before_db_switch:')) backups.push(key);
  }
  assert.equal(backups.length, 1);
  assert.match(storage.getItem(backups[0]) || '', /旧库记录/);
  assert.equal(storage.getItem('wb_sync_local_draft:' + uid + ':tab2'), null);

  // 4) 保存通道真的通了：改一笔能推上云端
  context.mock.timers.enable({ apis: ['setTimeout'] });
  window.addEventListener('wb:localchange', sync.hookSave);
  db.load().notes[0].title = '新录入';
  db.save();
  context.mock.timers.tick(3000);
  await flush();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].p_payload.notes[0].title, '新录入');
});

/* 反向保护：本地和云端本来就是同一个库时，revision 不可能超前，
   这条路径必须保持原样——不能被换库保护误判成「旧库数据」而丢掉本机内容。 */
test('正常同步不会被换库保护误伤', async context => {
  const storage = installBrowser({ href: 'https://githubalong.github.io/mywork-master/' });
  globalThis.window = new EventTarget();
  const element = () => ({ style: {}, classList: { add() {} }, appendChild() {}, remove() {}, isConnected: false });
  document.getElementById = element;
  document.createElement = () => ({ content: { firstElementChild: element() } });

  const db = await import('../js/localdb.js');
  const uid = 'db-same-' + ++scenario;
  db.setActiveAccount(uid);
  storage.setItem('wb_supa_tok', JSON.stringify({ uid, access_token: 'test-only', expires_at: Date.now() + 3600000 }));

  const payload = { ...db.blank(), notes: [{ id: 1, title: '云端记录' }] };
  storage.setItem(db.DB_KEY, JSON.stringify(payload));
  storage.setItem('wb_account_revision:' + uid, '156');
  globalThis.fetch = async () => Response.json([{ payload, revision: 156 }]);

  const sync = await import('../js/cloudsync.js?dbsame=' + scenario);
  await sync.initializeAccountSync();

  assert.equal(sync.getAccountSyncStatus().status, 'saved');
  let backups = 0;
  for (let index = 0; index < storage.length; index += 1) {
    if (String(storage.key(index)).startsWith('wb_before_db_switch:')) backups += 1;
  }
  assert.equal(backups, 0);
  assert.equal(db.load().notes[0].title, '云端记录');
});

/* 云端还空着（新库刚建、没迁任何东西）时，本机数据是唯一副本，
   换库保护必须让位：不能拿空云端去覆盖本机记录。 */
test('云端为空时保留本机数据，不判成换库', async context => {
  const storage = installBrowser({ href: 'https://githubalong.github.io/mywork-master/' });
  globalThis.window = new EventTarget();
  const element = () => ({ style: {}, classList: { add() {} }, appendChild() {}, remove() {}, isConnected: false });
  document.getElementById = element;
  document.createElement = () => ({ content: { firstElementChild: element() } });

  const db = await import('../js/localdb.js');
  const uid = 'db-empty-' + ++scenario;
  db.setActiveAccount(uid);
  storage.setItem('wb_supa_tok', JSON.stringify({ uid, access_token: 'test-only', expires_at: Date.now() + 3600000 }));

  const localSnapshot = { ...db.blank(), notes: [{ id: 1, title: '只在本机' }] };
  storage.setItem(db.DB_KEY, JSON.stringify(localSnapshot));
  storage.setItem('wb_account_revision:' + uid, '24674');
  globalThis.fetch = async () => Response.json([]);

  const sync = await import('../js/cloudsync.js?dbempty=' + scenario);
  await sync.initializeAccountSync();

  assert.equal(db.load().notes[0].title, '只在本机');
  let backups = 0;
  for (let index = 0; index < storage.length; index += 1) {
    if (String(storage.key(index)).startsWith('wb_before_db_switch:')) backups += 1;
  }
  assert.equal(backups, 0);
});
