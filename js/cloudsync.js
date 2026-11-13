/* ============================================================================
   云同步（Supabase 免费档）

   为什么需要这一层：
   纯静态版的数据只存浏览器 localStorage，手机和电脑各存各的，
   改了这边那边看不见。备份文件来回倒能解决，但每次都要手动导出导入。
   这里接 Supabase（免费、不用绑卡）当云端硬盘，两边自动同步。

   同步策略：
   整个数据库是一个 JSON 对象（localdb.js 的 wb_static_db_v1），
   账号快照写入 wb_user_data，并由 revision 条件更新避免旧包覆盖新包：
     - 本地改过、云端没动  → 推上去
     - 云端动了、本地没改  → 拉下来（自动，不打扰）
     - 两边都动过          → 弹窗让用户选，不悄悄覆盖（选之前旧数据可下载备份）

   旧「同步钥匙」入口已停用。wb_sync 历史数据只作为迁移和恢复依据保留，
   不再接受匿名任意 key 读写。
   ========================================================================== */

import { toast, confirmDialog } from './core.js';
import { DB_KEY, activeAccountId, load as loadLocalDb } from './localdb.js';
import { session } from './cloud.js';
import {
  normalizeHomeLayout,
  validateLegacyHomeLayout,
  readRawHomeLayoutFromDatabase,
  readRawHomeLayoutFromSnapshot,
  mergeLocalHomeLayoutForStartup,
  withHomeLayoutInSnapshot,
  commitHomeLayoutWithCas,
  withHomeLayoutLock,
  snapshotsMatchExceptHomeLayout,
} from './home-layout-migration.mjs';

const META_KEY = 'wb_cloud_meta';    // { lastPull, lastPush, localChanged }
const HOME_LAYOUT_MIGRATION_KEY = 'wb_home_layout_migration';

let _debounce = null;
let _preservedHomeLayoutUid = '';
const _migrationTasks = new Map();

function storageKey(key) {
  const uid = session()?.uid || 'legacy';
  return `${key}:${uid}`;
}
function meta() {
  try { return JSON.parse(localStorage.getItem(storageKey(META_KEY)) || '{}'); } catch { return {}; }
}
function setMeta(patch) {
  localStorage.setItem(storageKey(META_KEY), JSON.stringify({ ...meta(), ...patch }));
}
/* ---------------- 账户级自动同步 ---------------- */
const REV_KEY = 'wb_account_revision';
let _revision = 0, _uid = '', _pending = false, _changeSeq = 0, _writing = Promise.resolve(), _retryDelay = 1500, _remoteBound = false;
let _syncReady = false, _conflictPaused = false;
function revisionStorageKey(uid) { return REV_KEY + ':' + uid; }
function writeRevision(uid, value) {
  _revision = Number(value) || 0;
  try { localStorage.setItem(revisionStorageKey(uid), String(_revision)); } catch {}
}
function safeSnapshot(raw) {
  const copy = JSON.parse(JSON.stringify(raw || {}));
  if (copy.meta?.user) delete copy.meta.user.pwd;
  return copy;
}
async function replaceLocalSnapshot(payload, { accountUid = _uid } = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('云端工作台数据格式不正确');
  let next = payload;
  try {
    const key = 'wb_before_account_sync:' + accountUid;
    const existing = localStorage.getItem(DB_KEY);
    if (existing && !localStorage.getItem(key)) localStorage.setItem(key, existing);
    /* 云端快照按设计不含本机密码摘要；应用快照时保留当前设备的摘要，
       避免浏览器模式的无网登录凭证被云端同步清掉。 */
    const previous = existing ? JSON.parse(existing) : null;
    const pwd = previous?.meta?.user?.pwd;
    if (pwd && payload.meta?.user && !payload.meta.user.pwd) {
      next = JSON.parse(JSON.stringify(payload));
      next.meta.user.pwd = pwd;
    }
  } catch {}
  localStorage.setItem(DB_KEY, JSON.stringify(next));
  const localdb = await import('./localdb.js');
  localdb.replaceMemFromDisk?.();
}
function stableJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}
function isRevisionConflict(error) {
  return /WB_DATA_REVISION_CONFLICT|40001|revision conflict/i.test(String(error?.message || ''));
}
function isWriteBusy(error) {
  return /WB_DATA_WRITE_BUSY|55P03|lock_not_available|lock timeout/i.test(String(error?.message || error?.code || ''));
}
function makeRevisionConflict(raw) {
  _conflictPaused = true;
  _syncReady = false;
  try { localStorage.setItem('wb_sync_conflict_backup:' + _uid, raw); } catch { }
  const error = new Error('检测到其他设备同时修改了工作台数据。为防止覆盖云端版本，自动同步已暂停；本机缓存未清除。请关闭重复打开的工作台标签页后刷新，重新读取云端最新数据。');
  error.code = 'WB_DATA_REVISION_CONFLICT';
  return error;
}
async function adoptRemoteIfSame(cloud, raw, payload, savingSeq) {
  let remote = null;
  try { remote = await cloud.getWorkbenchSnapshot(); } catch { }
  if (!remote?.payload || stableJson(remote.payload) !== stableJson(payload)) return null;
  writeRevision(_uid, remote.revision);
  _pending = _changeSeq !== savingSeq;
  setMeta({ lastPush: remote.updated_at || new Date().toISOString(), localChanged: _pending });
  _retryDelay = 1500;
  window.dispatchEvent(new CustomEvent('wb:sync-status', { detail: { status: 'saved', at: remote.updated_at } }));
  return remote;
}
async function pushSnapshotUnlocked() {
  if (!_uid || !_pending) return;
  if (_conflictPaused) throw makeRevisionConflict(localStorage.getItem(DB_KEY) || '');
  const cloud = await import('./cloud.js');
  const raw = localStorage.getItem(DB_KEY);
  if (!raw) throw new Error('本机工作台数据尚未初始化');
  const payload = safeSnapshot(JSON.parse(raw));
  const savingSeq = _changeSeq;

  /* 同一浏览器的其他标签页可能已经推进了版本号。
     先比对云端快照；相同则只认领新版本，不同则停写，绝不拿旧快照覆盖新数据。 */
  const sharedRevision = Number(localStorage.getItem(revisionStorageKey(_uid)) || 0);
  if (sharedRevision > _revision) {
    const adopted = await adoptRemoteIfSame(cloud, raw, payload, savingSeq);
    if (adopted) return adopted;
    throw makeRevisionConflict(raw);
  }

  let saved;
  try {
    saved = await cloud.saveWorkbenchSnapshot(payload, _revision);
  } catch (error) {
    if (!isRevisionConflict(error)) throw error;
    const adopted = await adoptRemoteIfSame(cloud, raw, payload, savingSeq);
    if (adopted) return adopted;
    throw makeRevisionConflict(raw);
  }

  writeRevision(_uid, saved.revision);
  _pending = _changeSeq !== savingSeq;
  setMeta({ lastPush: saved.updated_at || new Date().toISOString(), localChanged: _pending });
  _retryDelay = 1500;
  window.dispatchEvent(new CustomEvent('wb:sync-status', { detail: { status: 'saved', at: saved.updated_at } }));
  return saved;
}
/* Cross-tab serialization: keep the wait in the browser, not in a Postgres
   connection. All tabs on this origin share the same localStorage snapshot/revision. */
async function pushSnapshot() {
  if (typeof navigator === 'undefined' || !navigator.locks?.request) {
    return pushSnapshotUnlocked();
  }
  return navigator.locks.request(`wb-snapshot:${_uid}`, { mode: 'exclusive' }, () => pushSnapshotUnlocked());
}

export async function initializeAccountSync() {
  const cloud = await import('./cloud.js');
  const uid = cloud.session()?.uid || '';
  if (!uid || uid !== activeAccountId()) return false;
  if (_uid === uid && _revision > 0 && _syncReady) return true;
  _uid = uid;
  _syncReady = false;
  _conflictPaused = false;
  const remote = await cloud.getWorkbenchSnapshot();
  if (remote?.payload) {
    /* Preserve the current device's layout before the account snapshot is
       applied. The layout migration analysis validates and reconciles it. */
    const localBefore = safeSnapshot(loadLocalDb());
    const startupPayload = mergeLocalHomeLayoutForStartup(localBefore, remote.payload);
    _preservedHomeLayoutUid = readRawHomeLayoutFromDatabase(localBefore) === undefined ? '' : uid;
    await replaceLocalSnapshot(startupPayload, { accountUid: uid });
    writeRevision(uid, remote.revision);
    _pending = false;
  } else {
    _revision = 0;
    try { localStorage.removeItem(revisionStorageKey(uid)); } catch { }
    _pending = true;
    await pushSnapshot();
  }
  _syncReady = true;
  bindRemoteSnapshotEvents();
  window.dispatchEvent(new CustomEvent('wb:sync-status', { detail: { status: 'saved' } }));
  return true;
}
export async function refreshAccountSync() {
  if (!_syncReady || !_uid || _uid !== activeAccountId()) return false;
  const cloud = await import('./cloud.js');
  const remote = await cloud.getWorkbenchSnapshot();
  if (!remote?.payload || Number(remote.revision) <= _revision || _pending) return false;
  let next = remote.payload;
  if (_preservedHomeLayoutUid === _uid) {
    next = mergeLocalHomeLayoutForStartup(safeSnapshot(loadLocalDb()), remote.payload);
  }
  await replaceLocalSnapshot(next, { accountUid: _uid });
  writeRevision(_uid, remote.revision);
  return true;
}
function bindRemoteSnapshotEvents() {
  if (_remoteBound) return;
  _remoteBound = true;
  window.addEventListener('wb:remote', async (ev) => {
    if (ev.detail?.table !== 'wb_user_data') return;
    try {
      if (await refreshAccountSync()) window.dispatchEvent(new Event('wb:snapshot-applied'));
    } catch (e) {
      console.warn('[sync] 读取远端更新失败', e);
      toast('另一台设备的数据更新暂时没拉下来，请检查网络', 'warn', 6000);
    }
  });
}
export function hookSave() {
  /* 首次云端读取未完成或检测到多端冲突时，禁止上传本机快照。 */
  if (!_syncReady || _conflictPaused || !_uid || _uid !== activeAccountId()) return;
  setMeta({ localChanged: true });
  _pending = true;
  _changeSeq += 1;
  window.dispatchEvent(new CustomEvent('wb:sync-status', { detail: { status: 'saving' } }));
  clearTimeout(_debounce);
  _debounce = setTimeout(() => {
    _writing = _writing.then(() => pushSnapshot()).catch((e) => {
      console.error('[sync] 自动保存失败', e);
      if (isRevisionConflict(e) || _conflictPaused) {
        _conflictPaused = true;
        _syncReady = false;
        window.dispatchEvent(new CustomEvent('wb:sync-status', { detail: { status: 'conflict', message: e.message } }));
        toast(e.message || '检测到多端数据冲突，自动同步已暂停以保护云端数据。', 'err', 12000);
        return;
      }
      if (isWriteBusy(e)) {
        /* 同一账号的并发写入属于暂时性竞争：保留本地修改，静默排队重试。 */
        console.warn('[sync] 云端写入繁忙，已安排自动重试', e);
        window.dispatchEvent(new CustomEvent('wb:sync-status', {
          detail: { status: 'saving', message: '云端正在处理其他保存请求，系统会自动重试。' },
        }));
        clearTimeout(_debounce);
        const retryDelay = _retryDelay;
        _debounce = setTimeout(() => {
          if (_syncReady && !_conflictPaused) hookSave();
        }, retryDelay);
        _retryDelay = Math.min(30000, Math.max(1500, _retryDelay * 2));
        return;
      }
      window.dispatchEvent(new CustomEvent('wb:sync-status', { detail: { status: 'error', message: e.message } }));
      toast('自动保存暂时失败：' + (e.message || '网络异常') + '。系统会降低频率后重试。', 'err', 8000);
      clearTimeout(_debounce);
      _debounce = setTimeout(() => { if (_syncReady && !_conflictPaused) hookSave(); }, _retryDelay);
      _retryDelay = Math.min(30000, _retryDelay * 2);
    });
  }, 800);
}
export async function autoSync() { return initializeAccountSync(); }
export async function pushNow() {
  if (!_syncReady || _conflictPaused) throw new Error('云端同步尚未就绪或已暂停，请重新连接后再试');
  _pending = true;
  return pushSnapshot();
}
export async function pullNow() { return refreshAccountSync(); }

function localAccountSnapshot() {
  try { return safeSnapshot(loadLocalDb()); } catch { return null; }
}

function accountChangedError() {
  const error = new Error('登录账号已切换，布局任务已取消');
  error.code = 'WB_ACCOUNT_CHANGED';
  return error;
}

function accountStillActive(uid) {
  if (!uid) return activeAccountId() === '';
  return session()?.uid === uid && activeAccountId() === uid;
}

async function applyConfirmedSnapshot(payload, revision, expectedUid = _uid) {
  if (!expectedUid || !accountStillActive(expectedUid)) throw accountChangedError();
  const at = new Date().toISOString();
  await replaceLocalSnapshot(payload, { accountUid: expectedUid });
  writeRevision(expectedUid, revision);
  _preservedHomeLayoutUid = '';
  const migration = payload?.meta?.migrations?.homeLayoutFromWbSync;
  if (migration?.status === 'completed') {
    try {
      localStorage.setItem(HOME_LAYOUT_MIGRATION_KEY + ':' + expectedUid, JSON.stringify(migration));
    } catch { }
  }
  _pending = false;
  _conflictPaused = false;
  setMeta({ lastPush: at, localChanged: false });
  window.dispatchEvent(new CustomEvent('wb:sync-status', { detail: { status: 'saved', at } }));
  window.dispatchEvent(new Event('wb:snapshot-applied'));
}

function layoutTaskKey(uid) {
  return uid || 'local:' + (activeAccountId() || 'anonymous');
}

async function performHomeLayoutSave(uid, layout) {
  if (uid && !accountStillActive(uid)) return { status: 'failed', localSaved: false, error: accountChangedError() };
  const local = localAccountSnapshot();
  if (!local) return { status: 'failed', localSaved: false, error: new Error('本机工作台数据尚未初始化') };

  let localCandidate;
  try {
    localCandidate = withHomeLayoutInSnapshot(local, layout);
    if (uid && !accountStillActive(uid)) throw accountChangedError();
    await replaceLocalSnapshot(localCandidate, { accountUid: uid || _uid });
  } catch (error) {
    return { status: 'failed', localSaved: false, error };
  }

  if (!uid || uid !== activeAccountId() || !_syncReady) {
    return { status: 'local-only', localSaved: true };
  }
  if (!accountStillActive(uid)) return { status: 'failed', localSaved: true, error: accountChangedError() };
  _uid = uid;
  const cloud = await import('./cloud.js');
  const result = await commitHomeLayoutWithCas({
    mode: 'set',
    desiredLayout: layout,
    readSnapshot: () => cloud.getWorkbenchSnapshot(),
    saveSnapshot: (payload, expectedRevision) => cloud.saveWorkbenchSnapshot(payload, expectedRevision),
    readLocalSnapshot: async () => localAccountSnapshot(),
    applySnapshot: (payload, revision) => applyConfirmedSnapshot(payload, revision, uid),
  });
  if (result.status !== 'saved' && result.status !== 'confirmed') {
    _preservedHomeLayoutUid = uid;
  }
  return { ...result, localSaved: true };
}

/* 普通布局保存和迁移共用同一个用户级任务锁。 */
export async function saveHomeLayoutToAccount(layout) {
  const uid = session()?.uid || '';
  if (uid && uid !== activeAccountId()) {
    return { status: 'failed', localSaved: false, error: new Error('当前登录账号与工作台账号不一致，请刷新页面') };
  }
  try {
    return await withHomeLayoutLock(layoutTaskKey(uid), () => performHomeLayoutSave(uid, layout));
  } catch (error) {
    return { status: 'failed', localSaved: false, error };
  }
}

async function performLegacyLayoutMigration(uid, hasUnsavedDraft) {
  if (!accountStillActive(uid)) return { status: 'failed', reason: 'account-changed', error: accountChangedError() };
  _uid = uid;
  const cloud = await import('./cloud.js');
  let legacy;
  let legacyReadError = null;
  try {
    legacy = await cloud.getLegacyHomeLayout() || undefined;
  } catch (error) {
    /* The legacy RPC may not be deployed. Local/account reconciliation must
       still run and must never replace the local layout with defaults. */
    legacyReadError = error;
  }
  const result = await commitHomeLayoutWithCas({
    mode: 'migrate',
    legacyLayout: legacy?.payload,
    legacyServerUpdatedAt: legacy?.updated_at || '',
    hasUnsavedDraft,
    readSnapshot: () => cloud.getWorkbenchSnapshot(),
    saveSnapshot: (payload, expectedRevision) => cloud.saveWorkbenchSnapshot(payload, expectedRevision),
    readLocalSnapshot: async () => localAccountSnapshot(),
    applySnapshot: (payload, revision) => applyConfirmedSnapshot(payload, revision, uid),
  });
  if (result.status !== 'saved' && result.status !== 'confirmed') {
    _preservedHomeLayoutUid = uid;
  }
  return legacyReadError ? { ...result, legacyReadError } : result;
}

/* 根据当前 JWT 只读旧布局，并用 revision CAS 合并进当前账号快照。 */
export function migrateLegacyHomeLayout({ hasUnsavedDraft = false } = {}) {
  const uid = session()?.uid || '';
  if (!uid || uid !== activeAccountId() || !_syncReady) {
    return Promise.resolve({ status: 'unavailable', reason: 'account-sync-not-ready' });
  }
  if (_migrationTasks.has(uid)) return _migrationTasks.get(uid);
  const task = withHomeLayoutLock(uid, () => performLegacyLayoutMigration(uid, hasUnsavedDraft))
    .catch((error) => ({ status: 'failed', reason: error?.reason || 'migration-task-failed', error }))
    .finally(() => {
      if (_migrationTasks.get(uid) === task) _migrationTasks.delete(uid);
    });
  _migrationTasks.set(uid, task);
  return task;
}

/* Adopt the latest account layout without writing it back to the cloud. */
export async function adoptAccountHomeLayout() {
  const uid = session()?.uid || '';
  if (!uid || uid !== activeAccountId() || !_syncReady) {
    return { status: 'unavailable', reason: 'account-sync-not-ready' };
  }
  try {
    return await withHomeLayoutLock(uid, async () => {
      if (!accountStillActive(uid)) return { status: 'failed', reason: 'account-changed', error: accountChangedError() };
      const cloud = await import('./cloud.js');
      const remote = await cloud.getWorkbenchSnapshot();
      if (!remote?.payload) return { status: 'no_legacy', reason: 'account-snapshot-missing' };
      const local = localAccountSnapshot();
      if (local && !snapshotsMatchExceptHomeLayout(remote.payload, local)) {
        return { status: 'deferred', reason: 'local_snapshot_has_unrelated_changes' };
      }
      const raw = readRawHomeLayoutFromSnapshot(remote.payload);
      if (raw !== undefined) validateLegacyHomeLayout(raw);
      await applyConfirmedSnapshot(remote.payload, remote.revision, uid);
      return { status: 'adopted', revision: remote.revision, payload: remote.payload };
    });
  } catch (error) {
    return { status: 'failed', reason: error?.reason || 'adopt-account-layout-failed', error };
  }
}

/* ---------------- 链接搬运：不起服务器也能换设备 ----------------

   原理：整库先 deflate 压缩、再 base64，塞进 URL 的 # 后面。
   # 之后的内容浏览器不会发给服务器（GitHub 日志里看不到），
   页面自己解析、自己解压、自己存进 localStorage —— 全程不经过第三方。

   实测：58KB 的库压完 8.9KB，链接不到 9KB，微信/短信都发得出去。
   超长的库（比如带图片附件的）会超过浏览器地址栏上限，
   这种情况提示用户改用备份文件，不硬塞。   */

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deflate(str) {
  const data = new TextEncoder().encode(str);
  if (!window.CompressionStream) return null;
  const cs = new CompressionStream('deflate-raw');
  const w = cs.writable.getWriter();
  w.write(data);
  w.close();
  const buf = await new Response(cs.readable).arrayBuffer();
  return new Uint8Array(buf);
}

async function inflate(bytes) {
  const ds = new DecompressionStream('deflate-raw');
  const w = ds.writable.getWriter();
  w.write(bytes);
  w.close();
  const buf = await new Response(ds.readable).arrayBuffer();
  return new TextDecoder().decode(buf);
}

/* 生成可发到手机的链接 */
export async function makeShareLink() {
  const raw = localStorage.getItem(DB_KEY);
  if (!raw) throw new Error('本机没有数据可搬');
  const packed = await deflate(raw);
  if (!packed) throw new Error('这个浏览器太旧，不支持压缩。请用「数据导出与备份」的 JSON 文件');
  let bin = '';
  const CH = 0x8000;   // 分块，避免 apply 参数过多爆栈
  for (let i = 0; i < packed.length; i += CH) {
    bin += String.fromCharCode.apply(null, packed.subarray(i, i + CH));
  }
  const b64 = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const base = location.origin + location.pathname;
  const link = base + '#import=' + b64;
  return { link, bytes: raw.length, packedBytes: b64.length };
}

/* 打开页面时检查地址栏有没有 #import=，有就导入 */
export async function tryImportFromHash() {
  const m = location.hash.match(/#import=([A-Za-z0-9_-]+)/);
  if (!m) return false;
  const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
  let json;
  try {
    const pad = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    json = await inflate(b64ToBytes(pad));
    const obj = JSON.parse(json);
    if (!obj || typeof obj !== 'object') throw new Error('内容不像工作台数据');
  } catch (e) {
    history.replaceState(null, '', location.origin + location.pathname + '#/home');
    throw new Error('链接里的数据解不开：' + e.message);
  }

  /* 【不能闷头覆盖】
     早先只要 hash 里带 #import= 就无条件整库覆盖。可这个链接就是发到群里给大家点的，
     手机上本来就有一学期记录的人点一下，自己的数据全没了，而且没有任何提示。
     现在：本机已经有数据就先问，默认不是「覆盖」；确认了也先留一份底。 */
  const oldRaw = localStorage.getItem(DB_KEY);
  let oldCount = 0;
  if (oldRaw) {
    try {
      const o = JSON.parse(oldRaw);
      for (const [k, v] of Object.entries(o || {})) {
        if (k === 'meta' || k === 'seqs') continue;
        if (Array.isArray(v)) oldCount += v.length;
      }
    } catch { }
  }
  if (oldCount > 0) {
    const ok = await confirmDialog(
      `这台设备上已经有 ${oldCount} 条记录。\n\n导入会用它覆盖本机数据（导入后仍可从「数据导出与备份」里找回旧的备份）。\n\n确定要导入吗？`
    );
    if (!ok) {
      history.replaceState(null, '', location.origin + location.pathname + '#/home');
      return false;
    }
    localStorage.setItem(storageKey('wb_backup_before_import'), oldRaw);
  }

  localStorage.setItem(DB_KEY, json);
  /* 【只写 localStorage 不够】
     localdb.load() 有内存缓存 _db。如果它已经被加载过（比如骨架屏之后调了一次接口），
     那么页面读到的还是导入前的旧库，下一次 save() 还会把旧库回写进 localStorage，
     把刚导入的数据整个抹掉。所以这里必须让内存缓存失效并重新装载。
     用动态 import：cloudsync 和 localdb 之间不建立新的静态依赖边。 */
  try {
    const m2 = await import('./localdb.js');
    const db = m2.replaceMemFromDisk?.();
    /* 打上「已导入」标记：main.js 里 seedIfEmpty 靠它避免再灌示例数据把真数据搅浑 */
    if (db) {
      db.meta = db.meta || {};
      db.meta.importedAt = new Date().toISOString();
      db.meta.seeded = true;
      m2.save?.();
    }
  } catch { }

  history.replaceState(null, '', location.origin + location.pathname + '#/home');
  return true;
}

/* ---------------- 旧手动同步状态 ---------------- */

export function bindSheet() {
  toast('旧版手动云同步已停用。历史 wb_sync 数据不会自动迁移或删除；首页布局请使用账号同步。', 'warn', 9000);
  return false;
}
