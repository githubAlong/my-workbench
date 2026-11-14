/* ============================================================================
   云同步（Supabase 免费档）

   为什么需要这一层：
   纯静态版的数据只存浏览器 localStorage，手机和电脑各存各的，
   改了这边那边看不见。备份文件来回倒能解决，但每次都要手动导出导入。
   这里接 Supabase（免费、不用绑卡）当云端硬盘，两边自动同步。

   同步策略（故意做得简单）：
   整个数据库就是一个 JSON 大对象（localdb.js 的 wb_static_db_v1），
   所以不做字段级合并，整包上传/下载，谁的更新时间新谁赢：
     - 本地改过、云端没动  → 推上去
     - 云端动了、本地没改  → 拉下来（自动，不打扰）
     - 两边都动过          → 弹窗让用户选，不悄悄覆盖（选之前旧数据可下载备份）
   一个教师工作台，数据只属于一个人，LWW + 冲突确认完全够用，
   字段级 merge 的复杂度不值得。

   安全模型：
   Supabase 的 anon key 本来就是公开的（相当于项目 ID），
   真正的「钥匙」是首次绑定时随机生成的 sync_key（UUID），
   云端按它隔离数据。等于「知道房间号才能进」——对个人数据够用，
   但别把 sync_key 发给别人。

   免费档额度：500MB 数据库 / 5GB 流量每月。工作台数据几十 KB，
   就算一天同步一百次也用不到额度的零头。
   ========================================================================== */

import { toast, confirmDialog } from './core.js';
import { DB_KEY, activeAccountId, exportJSON as localMemorySnapshot } from './localdb.js';
import { session } from './cloud.js';
import { stableJson, mergeSnapshots, applyConflictChoices, readJournal, writeJournal, localDrafts } from './sync-journal.mjs';

const CFG_KEY = 'wb_cloud_cfg';      // { url, anon, syncKey }
const META_KEY = 'wb_cloud_meta';    // { lastPull, lastPush, localChanged }

let _debounce = null;

function storageKey(key) {
  const uid = session()?.uid || 'legacy';
  return `${key}:${uid}`;
}
function cfg() {
  const uid = session()?.uid;
  if (!uid || uid !== activeAccountId()) return null;
  try { return JSON.parse(localStorage.getItem(storageKey(CFG_KEY)) || 'null'); } catch { return null; }
}
function meta() {
  try { return JSON.parse(localStorage.getItem(storageKey(META_KEY)) || '{}'); } catch { return {}; }
}
function setMeta(patch) {
  localStorage.setItem(storageKey(META_KEY), JSON.stringify({ ...meta(), ...patch }));
}
function url(cfg0, path) {
  return (cfg0.url || '').replace(/\/+$/, '') + path;
}
function headers(cfg0) {
  return {
    apikey: cfg0.anon,
    Authorization: 'Bearer ' + cfg0.anon,
    'Content-Type': 'application/json',
  };
}

/* ---------------- Supabase REST 读写 ----------------

   【为什么走 RPC 而不是直接读写表】
   早先这里用的是 /rest/v1/wb_sync 表接口。那种写法要能跑通，
   数据库那边就必须给 anon 开表的读写权限，而 anon key 是公开的
   （就在网页 JS 里），于是任何人都能：
     · 不带过滤 GET 整张表 → 拿到所有人的 sync_key
     · 拿着别人的 key POST 覆盖 → 数据被改，本人毫不知情
   现在数据库只开放两个函数（见 supabase_setup.sql）：
     wb_get(钥匙)        只返回那一行，钥匙不对返回空
     wb_put(钥匙, 数据)  只写那一行
   表本身对 anon 没有任何权限，连 SELECT 都不给，所以列举不出来。
   这两个函数在 PostgREST 里就是 /rest/v1/rpc/wb_get 这样的地址。 */

async function fetchRemote(cfg0) {
  const u = url(cfg0, '/rest/v1/rpc/wb_get');
  const r = await fetch(u, {
    method: 'POST',
    headers: headers(cfg0),
    body: JSON.stringify({ k: cfg0.syncKey }),
  });
  if (!r.ok) throw new Error('云端读取失败 ' + r.status + (r.status === 404 ? '（数据库还没建函数，先跑一遍 supabase_setup.sql）' : ''));
  const rows = await r.json();
  /* 函数返回 table 类型，PostgREST 给的是数组；没命中就是空数组 */
  return Array.isArray(rows) ? (rows[0] || null) : (rows || null);
}

async function pushRemote(cfg0, dbObj) {
  const now = new Date().toISOString();
  const u = url(cfg0, '/rest/v1/rpc/wb_put');
  const r = await fetch(u, {
    method: 'POST',
    headers: headers(cfg0),
    body: JSON.stringify({ k: cfg0.syncKey, p: dbObj }),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    throw new Error('云端写入失败 ' + r.status + (detail ? '：' + detail.slice(0, 120) : ''));
  }
  setMeta({ lastPush: now, localChanged: false });
  return now;
}

/* 【写完 localStorage 必须让内存缓存失效，否则这次拉取等于白拉】
   2026-10 修：原来这里只 localStorage.setItem 就返回了。
   但 localdb.load() 有内存缓存 _db，页面启动后早被填满了。
   于是：云端数据写进磁盘 → 内存里还是旧库 → 下一次 save() 把旧库
   原样写回磁盘，把刚拉下来的云端数据整个盖掉。
   表现就是「点了同步云端、提示成功了，一刷新还是老数据」。
   tryImportFromHash（搬家链接导入）早就踩过并修过这个坑，
   云同步这条路当时漏了，现在补齐，两边写法保持一致。 */
function applyRemote(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('云端数据是空的');
  localStorage.setItem(DB_KEY, JSON.stringify(payload));
  /* 用动态 import 拿 replaceMemFromDisk：与 tryImportFromHash 里的写法保持一致，
     不新增静态依赖边（避免 localdb ↔ cloudsync 循环引用）。
     注意这是 async 函数，调用方 await 它，刷新前一定来得及。 */
  return (async () => {
    try {
      const m2 = await import('./localdb.js');
      m2.replaceMemFromDisk?.();
    } catch { }
    setMeta({ lastPull: new Date().toISOString(), localChanged: false });
  })();
}

/* ---------------- 账户级自动同步 ---------------- */
const REV_KEY = 'wb_account_revision';
let _revision = 0, _uid = '', _pending = false, _writing = Promise.resolve(), _retryDelay = 1500, _remoteBound = false;
let _syncReady = false, _conflictPaused = false;
let _savedContent = '', _observedContent = '';
let _inFlight = 0;
let _baseSnapshot = null, _sentPayload = null, _conflicts = [], _conflictRemote = null;
let _attempts = 0, _statusDetail = null, _lifecycleBound = false;
let _localConflict=null;
let _storageFailed=false;
const MAX_AUTO_ATTEMPTS = 5;
export function getAccountSyncStatus() { return _statusDetail; }
export function getSyncConflicts() { return JSON.parse(JSON.stringify(_localConflict?.conflicts || _conflicts)); }
function emitSyncStatus(status, message = '') {
  if(_storageFailed){status='error';message='本机存储空间不足，部分修改可能尚未保存。请保留页面并导出本机备份';}
  _statusDetail = {status,message,pending:_pending,uid:_uid};
  window.dispatchEvent(new CustomEvent('wb:sync-status',{detail:_statusDetail}));
}
function pendingJournal() {
  if (!_uid || !_baseSnapshot || _uid !== activeAccountId()) return;
  // Other tabs may have acknowledged a write since this tab last observed it.
  const shared=readJournal(localStorage,_uid);
  if(shared && Number(shared.revision)>_revision){
    _baseSnapshot=shared.base;writeRevision(_uid,shared.revision);_savedContent=stableJson(shared.base);
  }
  const local=safeSnapshot(JSON.parse(localStorage.getItem(DB_KEY)||'{}'));
  _pending=stableJson(local)!==_savedContent || !!_sentPayload || !!shared?.sent || !!_conflicts.length || !!_localConflict;
  writeJournal(localStorage,_uid,{base:_baseSnapshot,draft:_pending?local:null,revision:_revision,conflicts:_conflicts,sent:_sentPayload || shared?.sent || null});
}
async function applySyncSnapshot(payload) {
  if (localContent()!==stableJson(payload)) localStorage.setItem(DB_KEY,JSON.stringify(payload));
  const db=await import('./localdb.js');db.replaceMemFromDisk();
}
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
async function replaceLocalSnapshot(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('云端工作台数据格式不正确');
  try {
    const key = 'wb_before_account_sync:' + _uid;
    const existing = localStorage.getItem(DB_KEY);
    if (existing && !localStorage.getItem(key)) localStorage.setItem(key, existing);
  } catch {}
  localStorage.setItem(DB_KEY, JSON.stringify(payload));
  const localdb = await import('./localdb.js');
  localdb.replaceMemFromDisk?.();
}
function localContent() {
  return stableJson(safeSnapshot(JSON.parse(localStorage.getItem(DB_KEY) || '{}')));
}
function acknowledgeContent(content) {
  const observed=localContent(),pending=observed!==content;
  writeJournal(localStorage,_uid,{base:JSON.parse(content),draft:pending?JSON.parse(observed):null,revision:_revision});
  _baseSnapshot=JSON.parse(content);_sentPayload=null;
  _savedContent = content;_observedContent = observed;_pending = pending;
  _attempts=0;
}
function isRevisionConflict(error) {
  return /WB_DATA_REVISION_CONFLICT|40001|revision conflict/i.test(String(error?.message || ''));
}
function isWriteBusy(error) {
  return /WB_DATA_WRITE_BUSY|55P03|lock_not_available|lock timeout/i.test(String(error?.message || error?.code || ''));
}
function makeRevisionConflict(raw) {
  _conflictPaused = true;
  try { localStorage.setItem('wb_sync_conflict_backup:' + _uid, raw); } catch { }
  pendingJournal();
  const error = new Error('检测到同一内容存在不同修改，本机待同步数据已保留。请点页面上方“处理冲突”选择保留内容；刷新不会丢弃待同步修改。');
  error.code = 'WB_DATA_REVISION_CONFLICT';
  emitSyncStatus('conflict',error.message);
  return error;
}
async function adoptRemoteIfSame(cloud, payload) {
  const uid=_uid;
  let remote = null;
  try { remote = await cloud.getWorkbenchSnapshot(); } catch { }
  if(uid!==_uid||uid!==activeAccountId())return null;
  if (!remote?.payload || stableJson(remote.payload) !== stableJson(payload)) return null;
  writeRevision(_uid, remote.revision);
  acknowledgeContent(stableJson(payload));
  setMeta({ lastPush: remote.updated_at || new Date().toISOString(), localChanged: _pending });
  _retryDelay = 1500;
  emitSyncStatus(_pending?'pending':'saved');
  return remote;
}
async function rebaseRemote(cloud) {
  const uid=_uid,remote=await cloud.getWorkbenchSnapshot();
  if(uid!==_uid||uid!==activeAccountId())return false;
  if(!remote?.payload)throw Error('暂时无法读取云端最新版本，本机修改已保留');
  const local=safeSnapshot(JSON.parse(localStorage.getItem(DB_KEY)||'{}'));
  const merged=mergeSnapshots(_baseSnapshot,local,safeSnapshot(remote.payload));
  if(_sentPayload && stableJson(remote.payload)!==stableJson(_sentPayload) && stableJson(remote.payload)!==_savedContent){
    merged.payload=local;merged.conflicts=[{path:[],base:_baseSnapshot,local,remote:remote.payload}];
  }
  _conflicts=merged.conflicts;_conflictRemote=remote;
  if(_conflicts.length){
    writeJournal(localStorage,_uid,{base:_baseSnapshot,draft:merged.payload,revision:_revision,conflicts:_conflicts,sent:_sentPayload});
    await applySyncSnapshot(merged.payload);
    throw makeRevisionConflict(JSON.stringify(merged.payload));
  }
  writeJournal(localStorage,_uid,{base:remote.payload,draft:stableJson(merged.payload)!==stableJson(remote.payload)?merged.payload:null,revision:remote.revision});
  await applySyncSnapshot(merged.payload);
  writeRevision(_uid,remote.revision);_sentPayload=null;
  acknowledgeContent(stableJson(remote.payload));
  return true;
}
async function pushSnapshotUnlocked(rebases=0) {
  if (!_syncReady || !_uid || _uid !== activeAccountId() || !_pending) return;
  if (_conflictPaused) throw makeRevisionConflict(localStorage.getItem(DB_KEY) || '');
  const owner=_uid;
  const cloud = await import('./cloud.js');
  if(owner!==_uid||owner!==activeAccountId()||!_syncReady)return;
  const raw = localStorage.getItem(DB_KEY);
  if (!raw) throw new Error('本机工作台数据尚未初始化');
  const payload = _sentPayload || safeSnapshot(JSON.parse(raw));
  const content = stableJson(payload);
  if (content === _savedContent && !_sentPayload) {
    _pending = false;
    setMeta({ localChanged: false });
    return;
  }
  const savingUid = _uid;

  /* 同一浏览器的其他标签页可能已经推进了版本号。
     先比对云端快照；相同则只认领新版本，不同则停写，绝不拿旧快照覆盖新数据。 */
  const sharedRevision = Number(localStorage.getItem(revisionStorageKey(_uid)) || 0);
  if (sharedRevision > _revision) {
    const adopted = await adoptRemoteIfSame(cloud, payload);
    if (adopted) return adopted;
    if(rebases>=2)throw Object.assign(Error('云端版本正在更新，稍后重试'),{code:'WB_DATA_WRITE_BUSY'});
    if(!await rebaseRemote(cloud))return;
    return _pending ? pushSnapshotUnlocked(rebases+1) : undefined;
  }

  let saved;
  try {
    _sentPayload=payload;pendingJournal();
    emitSyncStatus('saving');
    saved = await cloud.saveWorkbenchSnapshot(payload, _revision,savingUid);
  } catch (error) {
    if(_uid!==savingUid||activeAccountId()!==savingUid)return;
    const adopted = await adoptRemoteIfSame(cloud, payload);
    if (adopted) return adopted;
    if (!isRevisionConflict(error)) throw error;
    // A rejected revision is a definite non-write, so it can safely be rebased.
    _sentPayload=null;
    if(rebases>=2)throw Object.assign(Error('云端版本更新较快，修改已保留并稍后重试'),{code:'WB_DATA_WRITE_BUSY'});
    if(!await rebaseRemote(cloud))return;
    return _pending ? pushSnapshotUnlocked(rebases+1) : undefined;
  }

  if (_uid !== savingUid || _uid !== activeAccountId()) return saved;
  if(saved.payload && stableJson(saved.payload)!==content)throw Error('云端返回内容与本次保存不一致，已保留本机修改');
  writeRevision(_uid, saved.revision);
  acknowledgeContent(content);
  setMeta({ lastPush: saved.updated_at || new Date().toISOString(), localChanged: _pending });
  _retryDelay = 1500;
  emitSyncStatus(_pending?'pending':'saved');
  return saved;
}
/* Cross-tab serialization: keep the wait in the browser, not in a Postgres
   connection. All tabs on this origin share the same localStorage snapshot/revision. */
async function pushSnapshot() {
  const uid=_uid;
  const run = async () => {
    if(uid!==_uid||uid!==activeAccountId())return;
    _inFlight += 1;
    try { return await pushSnapshotUnlocked(); }
    finally { _inFlight -= 1; }
  };
  if (typeof navigator === 'undefined' || !navigator.locks?.request) {
    return run();
  }
  return navigator.locks.request(`wb-snapshot:${_uid}`, { mode: 'exclusive' }, run);
}

export async function initializeAccountSync() {
  const cloud = await import('./cloud.js');
  const uid = cloud.session()?.uid || '';
  if (!uid || uid !== activeAccountId()) return false;
  if (_uid === uid && _syncReady) return true;
  clearTimeout(_debounce);
  _debounce = null;
  _uid = uid;
  _syncReady = false;
  _conflictPaused = false;
  _conflicts=[];_sentPayload=null;_attempts=0;_retryDelay=1500;_storageFailed=false;
  let journal;
  try {journal=readJournal(localStorage,uid);}
  catch(error){_pending=true;emitSyncStatus('error','本机待同步记录无法读取，已停止同步。请导出备份后处理');throw error;}
  let remote;
  try {remote=await cloud.getWorkbenchSnapshot();}
  catch(error){
    if(uid!==_uid||uid!==activeAccountId())return false;
    if(!journal){emitSyncStatus('error','云端暂时不可达，未覆盖本机内容。请联网后重试');throw error;}
    _baseSnapshot=journal.base;_savedContent=stableJson(journal.base);_observedContent=localContent();
    _sentPayload=journal.sent||null;_revision=Number(journal.revision)||0;
    _conflicts=journal.conflicts||[];_localConflict=localDrafts(localStorage,uid)[0]||null;
    _conflictPaused=!!_conflicts.length||!!_localConflict;
    _pending=_observedContent!==_savedContent||!!_sentPayload||_conflictPaused;
    pendingJournal();_syncReady=true;bindRemoteSnapshotEvents();bindSyncLifecycle();
    emitSyncStatus(_conflictPaused?'conflict':globalThis.navigator?.onLine===false?'offline':'pending','已保留本机缓存，联网后继续同步');
    if(_pending&&!_conflictPaused)queueSave(1500);return true;
  }
  if(uid!==activeAccountId()||uid!==_uid)return false;
  let local=safeSnapshot(JSON.parse(localStorage.getItem(DB_KEY)||'{}'));
  let base=remote?.payload ? safeSnapshot(remote.payload) : local;
  let restored=local;
  if(journal){
    if(journal.draft && stableJson(local)===stableJson(journal.base))local=journal.draft;
    _sentPayload=journal.sent || null;
    const remoteContent=stableJson(base);
    const committed=_sentPayload&&remoteContent===stableJson(_sentPayload);
    const mergeBase=committed?_sentPayload:journal.base;
    if(committed)_sentPayload=null;
    const merged=mergeSnapshots(mergeBase,local,base);restored=merged.payload;_conflicts=merged.conflicts;
    if(journal.sent && !committed && remoteContent!==stableJson(journal.base)){
      restored=local;_conflicts=[{path:[],base:journal.base,local,remote:base}];
    }
    if(!remote?.payload&&Number(journal.revision)>0){restored=local;_conflicts=[{path:[],base:journal.base,local,remote:null}];}
    if(_conflicts.length)base=journal.base;
  }else if(remote?.payload){
    const hasRecords=Object.values(local).some(value=>Array.isArray(value)&&value.length>0);
    const hasProfile=!!(local.meta?.user?.school||local.meta?.user?.subject||meta().localChanged);
    if(stableJson(local)!==stableJson(base)&&(hasRecords||hasProfile)){
      _conflicts=[{path:[],base,local,remote:base}];
    }else restored=base;
  }
  _baseSnapshot=base;_savedContent=stableJson(base);
  _revision=Number(remote?.revision ?? journal?.revision)||0;
  _observedContent=stableJson(restored);
  _pending=_observedContent!==_savedContent||!!_sentPayload||_conflicts.length>0;
  _localConflict=localDrafts(localStorage,uid)[0]||null;
  _conflictPaused=_conflicts.length>0||!!_localConflict;_conflictRemote=remote;
  _pending=_pending||!!_localConflict;
  // Persist the recovery copy before replacing any local data.
  writeJournal(localStorage,uid,{base,draft:_pending?restored:null,revision:_revision,conflicts:_conflicts,sent:_sentPayload});
  await applySyncSnapshot(restored);writeRevision(uid,_revision);
  _syncReady = true;
  bindRemoteSnapshotEvents();
  bindSyncLifecycle();
  emitSyncStatus(_conflictPaused?'conflict':_pending?'pending':'saved');
  if(_pending&&!_conflictPaused)queueSave();
  return true;
}
export async function refreshAccountSync() {
  if (!_syncReady || !_uid || _uid !== activeAccountId()) return false;
  if(editingLocally())return false;
  const uid=_uid;
  const cloud = await import('./cloud.js');
  const remote = await cloud.getWorkbenchSnapshot();
  if(uid!==_uid||uid!==activeAccountId())return false;
  if (!remote?.payload || Number(remote.revision) <= _revision || _pending || _inFlight || _conflictPaused) return false;
  const current=localContent();
  if(current!==_savedContent){hookSave();return false;}
  writeJournal(localStorage,uid,{base:remote.payload,revision:remote.revision});
  await replaceLocalSnapshot(remote.payload);
  writeRevision(_uid, remote.revision);
  acknowledgeContent(localContent());
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
  if (!_syncReady || !_uid || _uid !== activeAccountId()) return;
  _storageFailed=false;
  const content = localContent();
  if (content === _observedContent) return;
  _observedContent = content;
  _pending = content !== _savedContent || !!_sentPayload || _conflicts.length>0;
  try { pendingJournal(); } catch(error) { _pending=true;_storageFailed=true;emitSyncStatus('error');return; }
  setMeta({ localChanged: _pending });
  if (!_pending) {
    clearTimeout(_debounce);
    _debounce = null;
    emitSyncStatus('saved');
    return;
  }
  if(_conflictPaused){emitSyncStatus('conflict');return;}
  emitSyncStatus('pending');
  queueSave();
}
function handleSyncError(error) {
  _pending=true;
  try { pendingJournal(); } catch {}
  if(/QuotaExceededError|SecurityError/.test(error?.name||'')){_storageFailed=true;emitSyncStatus('error');return;}
  if(isRevisionConflict(error)||_conflictPaused){_conflictPaused=true;emitSyncStatus('conflict',error.message);return;}
  _attempts+=1;
  if(globalThis.navigator?.onLine===false){emitSyncStatus('offline','已保存到本机，联网后继续同步');return;}
  if(error?.status===401||error?.status===403){emitSyncStatus('error','登录状态或权限异常，修改已保留在本机，请重新登录后重试');return;}
  if(_attempts>=MAX_AUTO_ATTEMPTS){emitSyncStatus('error','已保存到本机，自动重试未成功。可点击“重试同步”继续');return;}
  const message=isWriteBusy(error)?'云端正在处理其他请求，修改已保留并排队重试':'已保存到本机，云端暂时不可达，稍后重试';
  emitSyncStatus('pending',message);
  const delay=_retryDelay+(_attempts>1?Math.floor(Math.random()*_retryDelay*.25):0);
  _retryDelay=Math.min(30000,_retryDelay*2);
  queueSave(delay);
}
/* 【流量】合并窗口从 0.8 秒放宽到 3 秒。
   整包快照一次保存约 60~110KB，手机端连续改十来个格子的场景里，
   0.8 秒窗口会把它们拆成十几次上传。3 秒窗口把连续的编辑合并成一次。
   数据安全不受影响：每次改动仍然先写 localStorage 与待同步日志，
   就算用户当场关掉页面，下次打开也会从日志里补推。 */
const SAVE_DEBOUNCE_MS = 3000;
function queueSave(delay = SAVE_DEBOUNCE_MS) {
  clearTimeout(_debounce);
  if(!_pending||_conflictPaused)return;
  if(globalThis.navigator?.onLine===false){emitSyncStatus('offline','已保存到本机，联网后继续同步');return;}
  _debounce = setTimeout(() => {
    _debounce = null;
    _writing = _writing.then(async () => {
      await pushSnapshot();
      if (_pending && _syncReady && !_conflictPaused) queueSave();
    }).catch(handleSyncError);
  }, delay);
}
export async function autoSync() { return initializeAccountSync(); }
export async function pushNow() {
  if (!_syncReady || _conflictPaused) throw new Error('云端同步尚未就绪或已暂停，请重新连接后再试');
  if(globalThis.navigator?.onLine===false){pendingJournal();emitSyncStatus('offline','已保存到本机，联网后继续同步');return;}
  clearTimeout(_debounce);_debounce=null;
  _pending = localContent() !== _savedContent || !!_sentPayload;
  pendingJournal();
  const task=_writing.then(()=>pushSnapshot());_writing=task.catch(()=>{});
  try {const saved=await task;if(_pending)queueSave();return saved;}
  catch(error){handleSyncError(error);throw error;}
}
export async function pullNow() { return refreshAccountSync(); }

export async function retryAccountSync() {
  if(!_syncReady)await initializeAccountSync();
  if(_localConflict)throw Error('请先处理标签页之间的修改冲突');
  if(_conflictPaused){const cloud=await import('./cloud.js');_conflictPaused=false;try{await rebaseRemote(cloud);}catch(error){handleSyncError(error);throw error;}}
  _attempts=0;_retryDelay=1500;
  return pushNow();
}
export async function resolveAccountSyncConflicts(choices) {
  if(_localConflict){
    const current=JSON.parse(localContent()),record=_localConflict;
    const merged=mergeSnapshots(record.base,record.draft,current);
    if(stableJson(merged.conflicts)!==stableJson(record.conflicts)){
      _localConflict={...record,remote:current,conflicts:merged.conflicts};localStorage.setItem(record.key,JSON.stringify(_localConflict));
      emitSyncStatus('conflict','其他标签页已有新修改，请重新查看');throw Error('内容已有新变化，请重新打开冲突列表');
    }
    const resolved=applyConflictChoices(merged.payload,merged.conflicts,choices);
    localStorage.setItem('wb_sync_resolution_backup:'+_uid,JSON.stringify({local:record.draft,remote:current,at:new Date().toISOString()}));
    writeJournal(localStorage,_uid,{base:_baseSnapshot,draft:resolved,revision:_revision,sent:_sentPayload});
    await applySyncSnapshot(resolved);localStorage.removeItem(record.key);
    _localConflict=localDrafts(localStorage,_uid)[0]||null;_conflictPaused=!!_localConflict;_conflicts=[];
    _pending=localContent()!==_savedContent||!!_sentPayload;pendingJournal();
    if(_localConflict){emitSyncStatus('conflict');return;}
    window.dispatchEvent(new Event('wb:snapshot-applied'));return retryAccountSync();
  }
  const cloud=await import('./cloud.js'),uid=_uid;
  const remote=await cloud.getWorkbenchSnapshot();
  if(uid!==_uid||uid!==activeAccountId())throw Error('账号已切换，请重新打开冲突列表');
  const local=JSON.parse(localContent()),merged=mergeSnapshots(_baseSnapshot,local,remote?.payload);
  // An unknown legacy base cannot be field-merged; require an explicit whole-copy choice.
  if(_conflicts.some(item=>item.path.length===0)){
    merged.payload=local;merged.conflicts=[{path:[],base:_baseSnapshot,local,remote:remote?.payload}];
  }
  if(stableJson(remote)!==stableJson(_conflictRemote)||stableJson(merged.conflicts)!==stableJson(_conflicts)){
    _conflicts=merged.conflicts;_conflictRemote=remote;pendingJournal();emitSyncStatus('conflict','内容已有新变化，请重新查看后选择');
    throw Error('内容已有新变化，请重新打开冲突列表');
  }
  const resolved=applyConflictChoices(merged.payload,_conflicts,choices);
  if(!resolved||typeof resolved!=='object')throw Error('云端记录不存在，请先导出本机备份后处理');
  // Keep an explicit recovery copy before any user-selected replacement.
  localStorage.setItem('wb_sync_resolution_backup:'+uid,JSON.stringify({local,remote,at:new Date().toISOString()}));
  writeJournal(localStorage,uid,{base:remote.payload,draft:resolved,revision:remote.revision});
  await applySyncSnapshot(resolved);writeRevision(uid,remote.revision);
  _conflicts=[];_conflictPaused=false;_sentPayload=null;acknowledgeContent(stableJson(remote.payload));
  window.dispatchEvent(new Event('wb:snapshot-applied'));
  return retryAccountSync();
}
export function exportPendingSync() {
  if(!_uid||_uid!==activeAccountId())throw Error('没有当前账号的待同步数据');
  let journal;try{journal=readJournal(localStorage,_uid);}catch{journal={unreadable:localStorage.getItem('wb_sync_journal_v1:'+_uid)};}
  return {version:1,account:_uid,exported_at:new Date().toISOString(),local:JSON.parse(localContent()),memory:safeSnapshot(localMemorySnapshot()),journal,localDrafts:localDrafts(localStorage,_uid)};
}
function bindSyncLifecycle() {
  if(_lifecycleBound)return;_lifecycleBound=true;
  const resume=()=>{
    if(!_syncReady||_uid!==activeAccountId())return;
    if(_conflictPaused)return;
    if(_pending){_attempts=0;_retryDelay=1500;queueSave(250);}
    else refreshAccountSync().then(changed=>{if(changed)window.dispatchEvent(new Event('wb:snapshot-applied'));}).catch(()=>{});
  };
  window.addEventListener('online',resume);
  window.addEventListener('offline',()=>{if(_pending){clearTimeout(_debounce);emitSyncStatus('offline','已保存到本机，联网后继续同步');}});
  window.addEventListener('focus',resume);
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')resume();});
  window.addEventListener('beforeunload',event=>{if(_pending||_inFlight){try{pendingJournal();}catch{}event.preventDefault();event.returnValue='';}});
  window.addEventListener('wb:storagefull',()=>{_storageFailed=true;_pending=true;emitSyncStatus('error');});
  window.addEventListener('wb:localconflict',()=>{_localConflict=localDrafts(localStorage,_uid)[0]||null;_conflictPaused=true;_pending=true;emitSyncStatus('conflict','多个标签页修改了同一内容，本机副本已保留');});
  window.addEventListener('storage',event=>{
    if(event.key!==DB_KEY||!_syncReady||_uid!==activeAccountId()||_localConflict||editingLocally())return;
    import('./localdb.js').then(db=>{db.replaceMemFromDisk();hookSave();}).catch(()=>{});
  });
}
function editingLocally() {
  const tag=String(document.activeElement?.tagName||'').toLowerCase();
  return ['input','textarea','select'].includes(tag)||!!document.activeElement?.isContentEditable||!!document.querySelector?.('.sheet-mask');
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

/* ---------------- 绑定 / 状态 UI ---------------- */

export function bindSheet() {
  const c = cfg();
  const m = meta();
  /* 【这段 SQL 与 supabase_setup.sql 保持一致】
     不要换成网上随处可见的 using (true) 写法 —— 那等于谁都能读写全部行，
     而 anon key 是公开的。表对 anon 一律不开放，只开放两个函数。 */
  const sql = `create table if not exists public.wb_sync (
  sync_key text primary key,
  payload jsonb not null,
  updated_at timestamptz not null default now());
alter table public.wb_sync enable row level security;
alter table public.wb_sync force row level security;
revoke all on public.wb_sync from anon, authenticated, public;

create or replace function public.wb_get(k text)
returns table (updated_at timestamptz, payload jsonb)
language sql security definer set search_path = public as $$
  select s.updated_at, s.payload from public.wb_sync s
  where s.sync_key = k and length(k) >= 32; $$;

create or replace function public.wb_put(k text, p jsonb)
returns void language sql security definer set search_path = public as $$
  insert into public.wb_sync (sync_key, payload, updated_at)
  values (k, p, now())
  on conflict (sync_key) do update
    set payload = excluded.payload, updated_at = excluded.updated_at
  where length(k) >= 32; $$;

revoke all on function public.wb_get(text) from public;
revoke all on function public.wb_put(text, jsonb) from public;
grant execute on function public.wb_get(text) to anon;
grant execute on function public.wb_put(text, jsonb) to anon;`;

  const b = document.createElement('div');
  b.innerHTML = `
    ${c ? `
      <div class="card card-pad" style="margin-bottom:10px">
        <div class="row"><b>已绑定</b><span style="flex:1"></span><span class="tiny muted">钥匙 …${esc(String(c.syncKey).slice(-6))}</span></div>
        <div class="tiny muted" style="margin-top:6px">
          上次上传：${m.lastPush ? fmt(m.lastPush) : '还没传过'}<br>
          上次下载：${m.lastPull ? fmt(m.lastPull) : '还没拉过'}<br>
          ${m.conflict ? '<span style="color:var(--warn,#b45309)">⚠ 有未处理的冲突</span>' : ''}
        </div>
      </div>
      <div class="card card-pad tiny" style="margin-bottom:10px">
        <b>同步钥匙</b>（另一台设备绑定时填这把，才能连到同一份数据）：
        <div class="row" style="margin-top:4px">
          <code style="word-break:break-all;flex:1">${esc(c.syncKey)}</code>
          <button class="btn ghost tiny" id="cs-copykey">复制</button>
        </div>
      </div>
      <button class="btn primary block" id="cs-push" style="margin-bottom:8px">⬆ 把本机数据上传到云端</button>
      <button class="btn ghost block" id="cs-pull" style="margin-bottom:8px">⬇ 用云端数据覆盖本机</button>
      <button class="btn ghost block" id="cs-unbind">解除绑定（只解绑，不动数据）</button>
    ` : `
      <div class="small" style="margin-bottom:10px">
        云同步用 <b>Supabase 免费档</b>当云端硬盘，绑定后手机、电脑自动同步。
        只需要做一次（每台设备都要绑一次同一把钥匙）：
      </div>
      <div class="card card-pad tiny" style="margin-bottom:10px;line-height:1.8">
        <b>第一次使用（做一次就行）：</b><br>
        1. 打开 <a href="https://supabase.com" target="_blank" rel="noopener">supabase.com</a> 注册（免费，不用卡）<br>
        2. New project 建个项目（名字随便，区域选 Singapore）<br>
        3. 左侧 SQL Editor，粘贴下面这段并点 Run：<br>
        <textarea readonly id="cs-sql" style="width:100%;height:88px;margin-top:4px;font-size:11px">${sql}</textarea>
        <button class="btn ghost tiny" id="cs-copysql" style="margin-top:4px">复制 SQL</button><br>
        4. 左侧 Project Settings → API，找到 <b>Project URL</b> 和 <b>anon public key</b>，填到下面<br>
        5. 电脑上先绑定，然后把「同步钥匙」抄到手机上再绑一次 —— 两边就通了
      </div>
      <input id="cs-url" class="input" placeholder="Project URL（https://xxxx.supabase.co）" style="margin-bottom:8px">
      <input id="cs-anon" class="input" placeholder="anon public key（一长串 eyJ…）" style="margin-bottom:8px">
      <input id="cs-key" class="input" placeholder="同步钥匙（第一台设备留空自动生成；第二台设备必须填第一台的那把）" style="margin-bottom:8px">
      <button class="btn primary block" id="cs-gen">绑定云存储</button>
    `}`;

  const s = sheet({ title: '云同步', body: b });

  const $ = (id) => b.querySelector(id);
  if (c) {
    $('#cs-copykey').onclick = () => {
      navigator.clipboard?.writeText(c.syncKey).then(() => toast('钥匙已复制', 'ok'), () => toast('复制失败，长按钥匙文字手动复制', 'warn'));
    };
    $('#cs-push').onclick = async () => {
      toast('正在上传…');
      try { await pushNow(); toast('已上传，云端已更新', 'ok'); }
      catch (e) { toast(e.message, 'err'); }
    };
    $('#cs-pull').onclick = async () => {
      try {
        const r = await fetchRemote(c);
        if (!r) return toast('云端还没有数据', 'warn');
        if (!(await confirmDialog('会用云端数据覆盖本机。本机数据可以先「上传到云端」留底，确定继续？'))) return;
        await applyRemote(r.payload);
        toast('已覆盖，刷新中…', 'ok');
        s.close();
        setTimeout(() => location.reload(), 800);
      } catch (e) { toast(e.message, 'err'); }
    };
    $('#cs-unbind').onclick = async () => {
      if (!(await confirmDialog('只解除本机与云端的绑定，本地数据不动，确定？'))) return;
      localStorage.removeItem(storageKey(CFG_KEY));
      localStorage.removeItem(storageKey(META_KEY));
      toast('已解除绑定');
      s.close();
    };
    return;
  }

  $('#cs-copysql').onclick = () => {
    navigator.clipboard?.writeText(sql).then(() => toast('SQL 已复制', 'ok'), () => toast('复制失败，请手动选择文本', 'warn'));
  };
  $('#cs-gen').onclick = async () => {
    const u = $('#cs-url').value.trim();
    const a = $('#cs-anon').value.trim();
    if (!/^https:\/\/.+\.supabase\.(co|in)/.test(u)) return toast('URL 不对，应该是 https://xxxx.supabase.co', 'warn');
    if (a.length < 30) return toast('anon key 不对，是一长串 eyJ 开头的字符', 'warn');
    /* 同步钥匙：第一台设备留空自动生成；第二台设备必须填同一把，
       否则两台各存各的「房间」，数据永远碰不上。 */
    const typedKey = ($('#cs-key')?.value || '').trim();
    const key = typedKey || (crypto.randomUUID ? crypto.randomUUID() : 'k' + Date.now() + Math.random().toString(36).slice(2));
    const c0 = { url: u, anon: a, syncKey: key };
    toast('正在验证连接…');
    try {
      await fetchRemote(c0);   // 通了就行，404 行不存在也算通
    } catch (e) {
      return toast('连不上：' + e.message + '。检查 URL/key 和 SQL 是否跑过', 'err', 6000);
    }

    /* 【先写配置，再上传 —— 但上传失败必须让用户看见】
       2026-10 修：原来是这样写的：
           await pushNow().catch(() => {});                  // 失败被吞
           toast('绑定成功，本机数据已上传。同步钥匙：' + key);  // 无论如何都这么说
       结果上传失败了，界面照样报「已上传」，只是一闪而过没人注意。
       用户以为绑好了，去另一台设备一拉——空的。
       现在分三步，每步结果都如实说：
         ① 配置写进去（拉取/后续同步要用）
         ② 真的上传一次，拿到结果
         ③ 成功报成功；失败就明说失败，并把钥匙给用户留着，
            让他可以在弹层里点「把本机数据上传到云端」重试。 */
    localStorage.setItem(storageKey(CFG_KEY), JSON.stringify(c0));
    setMeta({ localChanged: true });   // 第一次绑定后把本地推上去

    let pushErr = null;
    try {
      await pushNow();
    } catch (e) {
      pushErr = e && e.message ? e.message : '未知错误';
    }

    if (pushErr) {
      /* 上传失败：钥匙照样显示出来（已经生成了，别让用户白等一次），
         但要明确告诉他「还没传上去」，以及下一步该做什么。 */
      toast('已连接云端，但本机数据没传上去：' + pushErr + '。请在云同步里点「把本机数据上传到云端」重试。', 'err', 12000);
      s.close();
      return;
    }
    toast('绑定成功，本机数据已上传。同步钥匙：' + key, 'ok', 8000);
    s.close();
  };
}

/* ---------------- 工具 ---------------- */

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }
function fmt(iso) {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
/* 【弹层样式要与应用内其它弹层保持一致】
   2026-10 改：原来这里是自己写的一套：
       max-height:86vh; overflow:auto;
   把标题栏和内容放进同一个滚动区。后果：
     · 一滚动，标题和「×」跟着滚出去，用户找不到怎么关
     · 手机上右侧会出现一条突兀的滚动条压住内容
     · 底部「绑定云存储」按钮离屏幕边缘太近，容易被当成页面尽头而忽略
   现在改成三段式：标题固定、内容区独立滚动、按钮贴在底部常驻。
   max-height 也从 86vh 提到 90vh（手机上 94vh），尽量少滚。 */
function sheet({ title, body }) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:9999;display:flex;align-items:flex-end;justify-content:center';
  const box = document.createElement('div');
  box.style.cssText = [
    'background:var(--card,#fff)',
    'width:min(520px,100%)',
    'max-height:90vh',
    'border-radius:16px 16px 0 0',
    'display:flex',
    'flex-direction:column',
    'overflow:hidden',
    'box-shadow:0 -8px 32px rgba(0,0,0,.18)',
  ].join(';');
  /* 标题固定，不随内容滚动 */
  const head = document.createElement('div');
  head.style.cssText = 'display:flex;align-items:center;gap:8px;padding:16px 16px 10px;flex:0 0 auto';
  head.innerHTML = `<b style="font-size:15px">${esc(title)}</b><span style="flex:1"></span>
    <button id="cs-close" aria-label="关闭" style="border:0;background:none;font-size:22px;line-height:1;cursor:pointer;color:var(--muted,#888);padding:0 4px">×</button>`;
  /* 内容区独立滚动 */
  const scroll = document.createElement('div');
  scroll.style.cssText = 'flex:1 1 auto;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:0 16px 16px';
  scroll.appendChild(body);
  box.appendChild(head);
  box.appendChild(scroll);
  wrap.appendChild(box);
  document.body.appendChild(wrap);

  /* 小屏再抬一点高度，同时给底部留出安全区（iPhone 那条横条）。
     667px 高的手机（iPhone SE/8）实测差 15px 需要滚，这里把
     标题栏和内容区各收一点边距，争取一屏放下、不用滚。 */
  const mq = window.matchMedia('(max-width: 760px)');
  const applyH = () => {
    const small = mq.matches;
    box.style.maxHeight = small ? '96vh' : '90vh';
    box.style.paddingBottom = small ? 'env(safe-area-inset-bottom, 0px)' : '0';
    head.style.padding = small ? '12px 16px 8px' : '16px 16px 10px';
    scroll.style.padding = small ? '0 16px 10px' : '0 16px 16px';
  };
  applyH();
  mq.addEventListener?.('change', applyH);

  wrap.onclick = (e) => { if (e.target === wrap) close(); };
  head.querySelector('#cs-close').onclick = close;
  function close() {
    mq.removeEventListener?.('change', applyH);
    wrap.remove();
  }
  return { close };
}


