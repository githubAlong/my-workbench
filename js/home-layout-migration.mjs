export const HOME_LAYOUT_BREAKPOINTS = Object.freeze(['desktop', 'tablet', 'mobile']);

/* Canonical card metadata shared by the renderer and the security validator. */
export const HOME_LAYOUT_CARDS = Object.freeze([
  { id: 'timeline', title: '今日时间轴', minW: 5, minH: 2 },
  { id: 'profile', title: '欢迎信息', minW: 4, minH: 2 },
  { id: 'todayCourse', title: '今日课程', minW: 5, minH: 3 },
  { id: 'weather', title: '天气', minW: 4, minH: 2 },
  { id: 'todayTodo', title: '今日事项与快速便签', minW: 4, minH: 2 },
  { id: 'dailyQuote', title: '每日一句', minW: 2, minH: 2 },
  { id: 'calendar', title: '日历', minW: 4, minH: 4 },
  { id: 'weekLessons', title: '本周课时', minW: 2, minH: 2 },
  { id: 'invigilation', title: '监考任务', minW: 2, minH: 2 },
  { id: 'prepDeadline', title: '备课截止', minW: 2, minH: 2 },
  { id: 'recentNotes', title: '最近笔记', minW: 2, minH: 2 },
].map((card) => Object.freeze(card)));

export const HOME_LAYOUT_LIMITS = Object.freeze({
  columns: 12,
  minVersion: 1,
  /* Current clients increment this value on every explicit layout save. */
  maxVersion: 1_000_000,
  maxHeight: 40,
  maxY: 500,
  maxBytes: 64 * 1024,
  maxDepth: 8,
  maxObjectKeys: 32,
  maxArrayLength: 64,
});

const BREAKPOINTS = new Set(HOME_LAYOUT_BREAKPOINTS);
const CARD_RULES = new Map(HOME_LAYOUT_CARDS.map((card) => [card.id, card]));
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const RETRYABLE = /40001|55P03|WB_DATA_REVISION_CONFLICT|WB_DATA_WRITE_BUSY|timeout|network|failed to fetch/i;
const REVISION_CONFLICT = /40001|WB_DATA_REVISION_CONFLICT|revision conflict/i;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

const LAYOUT_TASKS = new Map();
const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));

export class HomeLayoutValidationError extends Error {
  constructor(reason, path = 'homeLayout') {
    super('首页布局格式不安全或不完整');
    this.name = 'HomeLayoutValidationError';
    this.code = 'WB_HOME_LAYOUT_' + String(reason || 'invalid').toUpperCase();
    this.reason = String(reason || 'invalid');
    this.path = path;
  }
}

export class HomeLayoutLockError extends Error {
  constructor(reason = 'lock-timeout') {
    super(reason === 'lock-timeout' ? '首页布局任务等待超时' : '首页布局任务锁失败');
    this.name = 'HomeLayoutLockError';
    this.code = reason === 'lock-timeout' ? 'WB_HOME_LAYOUT_LOCK_TIMEOUT' : 'WB_HOME_LAYOUT_LOCK_FAILED';
    this.reason = reason;
  }
}

function invalid(reason, path = 'homeLayout') {
  throw new HomeLayoutValidationError(reason, path);
}

export function homeLayoutErrorCode(error) {
  return error?.code || (error?.reason ? 'WB_HOME_LAYOUT_' + String(error.reason).toUpperCase() : 'WB_HOME_LAYOUT_INVALID');
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function assertSafeStructure(value, path = 'homeLayout', depth = 0, seen = new WeakSet()) {
  if (value == null || ['string', 'number', 'boolean'].includes(typeof value)) return;
  if (typeof value !== 'object') invalid('invalid_type', path);
  if (depth > HOME_LAYOUT_LIMITS.maxDepth) invalid('too_deep', path);
  if (seen.has(value)) invalid('circular_reference', path);
  seen.add(value);

  if (Array.isArray(value)) {
    if (value.length > HOME_LAYOUT_LIMITS.maxArrayLength) invalid('array_too_long', path);
    value.forEach((item, index) => assertSafeStructure(item, path + '[' + index + ']', depth + 1, seen));
    seen.delete(value);
    return;
  }

  if (!isPlainObject(value)) invalid('invalid_object', path);
  const keys = Object.keys(value);
  if (keys.length > HOME_LAYOUT_LIMITS.maxObjectKeys) invalid('object_too_large', path);
  for (const key of keys) {
    if (DANGEROUS_KEYS.has(key)) invalid('unsafe_key', path);
    assertSafeStructure(value[key], path + '.' + key, depth + 1, seen);
  }
  seen.delete(value);
}

function assertOnlyKeys(value, allowed, path) {
  if (!isPlainObject(value)) invalid('invalid_object', path);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) invalid('unknown_field', path);
  }
}

function assertRequiredKeys(value, required, path) {
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) invalid('missing_field', path);
  }
}

function assertByteLimit(raw) {
  let text;
  try {
    text = JSON.stringify(raw);
  } catch {
    invalid('invalid_json');
  }
  if (typeof text !== 'string') invalid('invalid_json');
  if (new TextEncoder().encode(text).length > HOME_LAYOUT_LIMITS.maxBytes) invalid('too_large');
}

function normalizedInteger(value, path) {
  if (typeof value !== 'number' || !Number.isInteger(value)) invalid('invalid_number', path);
  return Object.is(value, -0) ? 0 : value;
}

/*
 * Strict validation for untrusted legacy/local/snapshot layout data.
 * Missing data is represented only by undefined. JSON null is invalid.
 * This function never fills defaults or ignores malformed entries.
 */
export function validateLegacyHomeLayout(raw) {
  if (raw === undefined) return null;
  if (raw === null) invalid('invalid_type');

  assertByteLimit(raw);
  assertSafeStructure(raw);
  assertOnlyKeys(raw, new Set(['version', 'updatedAt', 'breakpoints']), 'homeLayout');
  assertRequiredKeys(raw, ['version', 'breakpoints'], 'homeLayout');

  const version = normalizedInteger(raw.version, 'homeLayout.version');
  if (version < HOME_LAYOUT_LIMITS.minVersion || version > HOME_LAYOUT_LIMITS.maxVersion) {
    invalid('unsupported_version', 'homeLayout.version');
  }

  let updatedAt = '';
  if (Object.prototype.hasOwnProperty.call(raw, 'updatedAt')) {
    if (typeof raw.updatedAt !== 'string') invalid('invalid_updated_at', 'homeLayout.updatedAt');
    if (raw.updatedAt && (!ISO_TIME.test(raw.updatedAt) || Number.isNaN(Date.parse(raw.updatedAt)))) {
      invalid('invalid_updated_at', 'homeLayout.updatedAt');
    }
    updatedAt = raw.updatedAt;
  }

  if (!isPlainObject(raw.breakpoints)) invalid('invalid_breakpoints', 'homeLayout.breakpoints');
  const breakpointNames = Object.keys(raw.breakpoints);
  if (!breakpointNames.length) invalid('missing_breakpoint', 'homeLayout.breakpoints');
  for (const name of breakpointNames) {
    if (!BREAKPOINTS.has(name)) invalid('unknown_breakpoint', 'homeLayout.breakpoints');
  }

  const breakpoints = {};
  for (const bp of HOME_LAYOUT_BREAKPOINTS) {
    if (!Object.prototype.hasOwnProperty.call(raw.breakpoints, bp)) continue;
    const segment = raw.breakpoints[bp];
    const segmentPath = 'homeLayout.breakpoints.' + bp;
    assertOnlyKeys(segment, new Set(['layout', 'hidden']), segmentPath);
    assertRequiredKeys(segment, ['layout', 'hidden'], segmentPath);
    if (!Array.isArray(segment.layout)) invalid('invalid_layout', segmentPath + '.layout');
    if (!Array.isArray(segment.hidden)) invalid('invalid_hidden', segmentPath + '.hidden');
    if (!segment.layout.length || segment.layout.length > HOME_LAYOUT_CARDS.length) {
      invalid('layout_count', segmentPath + '.layout');
    }
    if (segment.hidden.length > HOME_LAYOUT_CARDS.length) invalid('hidden_count', segmentPath + '.hidden');

    const seen = new Set();
    const layout = segment.layout.map((item, index) => {
      const itemPath = segmentPath + '.layout[' + index + ']';
      assertOnlyKeys(item, new Set(['id', 'x', 'y', 'w', 'h']), itemPath);
      assertRequiredKeys(item, ['id', 'x', 'y', 'w', 'h'], itemPath);
      if (typeof item.id !== 'string') invalid('invalid_id', itemPath + '.id');
      const rule = CARD_RULES.get(item.id);
      if (!rule) invalid('unknown_component', itemPath + '.id');
      if (seen.has(item.id)) invalid('duplicate_component', itemPath + '.id');
      seen.add(item.id);

      const x = normalizedInteger(item.x, itemPath + '.x');
      const y = normalizedInteger(item.y, itemPath + '.y');
      const w = normalizedInteger(item.w, itemPath + '.w');
      const h = normalizedInteger(item.h, itemPath + '.h');
      if (x < 0 || y < 0) invalid('negative_coordinate', itemPath);
      if (y > HOME_LAYOUT_LIMITS.maxY) invalid('y_out_of_range', itemPath + '.y');
      if (w < rule.minW || w > HOME_LAYOUT_LIMITS.columns) invalid('width_out_of_range', itemPath + '.w');
      if (h < rule.minH || h > HOME_LAYOUT_LIMITS.maxHeight) invalid('height_out_of_range', itemPath + '.h');
      if (x + w > HOME_LAYOUT_LIMITS.columns) invalid('width_overflow', itemPath);
      return { id: item.id, x, y, w, h };
    });

    const hidden = [];
    const hiddenSeen = new Set();
    for (const value of segment.hidden) {
      if (typeof value !== 'string' || !CARD_RULES.has(value)) invalid('unknown_hidden_component', segmentPath + '.hidden');
      if (hiddenSeen.has(value)) invalid('duplicate_hidden_component', segmentPath + '.hidden');
      hiddenSeen.add(value);
      hidden.push(value);
    }
    breakpoints[bp] = { layout, hidden };
  }

  return { version, updatedAt, breakpoints };
}

/* Compatibility helper: malformed input becomes null for non-migration callers. */
export function normalizeHomeLayout(raw) {
  try {
    return validateLegacyHomeLayout(raw);
  } catch {
    return null;
  }
}

export function readRawHomeLayoutFromDatabase(db) {
  const settings = db?.meta?.user?.settings;
  if (!settings || !Object.prototype.hasOwnProperty.call(settings, 'homeLayout')) return undefined;
  return settings.homeLayout;
}

export function readRawHomeLayoutFromSnapshot(payload) {
  const settings = payload?.meta?.user?.settings;
  if (!settings || !Object.prototype.hasOwnProperty.call(settings, 'homeLayout')) return undefined;
  return settings.homeLayout;
}

export function readHomeLayoutFromDatabase(db) {
  return validateLegacyHomeLayout(readRawHomeLayoutFromDatabase(db));
}

export function readHomeLayoutFromSnapshot(payload) {
  return validateLegacyHomeLayout(readRawHomeLayoutFromSnapshot(payload));
}

/* Startup must preserve even malformed local data verbatim so validation can
   reject a migration without replacing the user's only local layout. */
export function mergeLocalHomeLayoutForStartup(localDb, remotePayload) {
  const copy = clone(remotePayload || {});
  const raw = readRawHomeLayoutFromDatabase(localDb);
  if (raw === undefined) return copy;
  copy.meta = copy.meta && typeof copy.meta === 'object' ? copy.meta : {};
  copy.meta.user = copy.meta.user && typeof copy.meta.user === 'object' ? copy.meta.user : {};
  copy.meta.user.settings = copy.meta.user.settings && typeof copy.meta.user.settings === 'object'
    ? copy.meta.user.settings
    : {};
  copy.meta.user.settings.homeLayout = clone(raw);
  return copy;
}

export function stableStringify(value) {
  if (value === null || value === undefined) return String(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  if (typeof value === 'object') {
    return '{' + Object.keys(value).sort()
      .map((key) => JSON.stringify(key) + ':' + stableStringify(value[key]))
      .join(',') + '}';
  }
  return JSON.stringify(value);
}

/*
 * Exact semantic identity of layout content. Layout array order is significant
 * for mobile stacking; hidden is a set, so its order is normalized.
 */
export function canonicalHomeLayoutJson(layout) {
  const normalized = validateLegacyHomeLayout(layout);
  if (!normalized) invalid('missing');
  const content = { breakpoints: {} };
  for (const bp of HOME_LAYOUT_BREAKPOINTS) {
    const segment = normalized.breakpoints[bp];
    if (!segment) continue;
    content.breakpoints[bp] = {
      layout: segment.layout.map((item) => ({
        id: item.id, x: item.x, y: item.y, w: item.w, h: item.h,
      })),
      hidden: [...segment.hidden].sort(),
    };
  }
  return stableStringify(content);
}

export function homeLayoutsEqual(left, right) {
  try {
    return canonicalHomeLayoutJson(left) === canonicalHomeLayoutJson(right);
  } catch {
    return false;
  }
}

/* Auxiliary display identifier only. It is never the sole equality proof. */
export function layoutChecksum(layout) {
  let text;
  try {
    text = canonicalHomeLayoutJson(layout);
  } catch {
    return '';
  }
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return 'fnv1a64-' + hash.toString(16).padStart(16, '0');
}

function inspectLayout(source, raw) {
  if (raw === undefined) {
    return { source, present: false, invalid: false, layout: null, layoutKey: '', checksum: '', updatedAt: '' };
  }
  try {
    const layout = validateLegacyHomeLayout(raw);
    const layoutKey = canonicalHomeLayoutJson(layout);
    return {
      source,
      present: true,
      invalid: false,
      layout,
      layoutKey,
      checksum: layoutChecksum(layout),
      updatedAt: layout.updatedAt || '',
    };
  } catch (error) {
    return {
      source,
      present: false,
      invalid: true,
      layout: null,
      layoutKey: '',
      checksum: '',
      updatedAt: '',
      errorCode: homeLayoutErrorCode(error),
      errorReason: error?.reason || 'invalid',
    };
  }
}

export function analyzeHomeLayoutState({
  localLayout,
  snapshotLayout,
  legacyLayout,
  legacyServerUpdatedAt = '',
  hasUnsavedDraft = false,
} = {}) {
  const local = inspectLayout('local', localLayout);
  const snapshot = inspectLayout('snapshot', snapshotLayout);
  const legacy = inspectLayout('legacy', legacyLayout);
  const views = [local, snapshot, legacy];
  const result = {
    status: 'no_layout',
    reason: '',
    local,
    snapshot,
    legacy,
    legacyServerUpdatedAt: String(legacyServerUpdatedAt || ''),
    choices: [],
  };

  const bad = views.find((item) => item.invalid);
  if (bad) {
    return {
      ...result,
      status: 'invalid',
      reason: 'invalid_' + bad.source + '_layout',
      invalidSource: bad.source,
      errorCode: bad.errorCode,
    };
  }

  const present = views.filter((item) => item.present);
  const distinct = new Map();
  for (const item of present) {
    if (!distinct.has(item.layoutKey)) distinct.set(item.layoutKey, item);
  }
  result.choices = [...distinct.values()].map((item) => clone({
    source: item.source,
    checksum: item.checksum,
    updatedAt: item.updatedAt,
    layout: item.layout,
  }));

  if (hasUnsavedDraft) return { ...result, status: 'deferred', reason: 'unsaved_draft' };
  if (!present.length) return result;

  /* A local/account conflict must be surfaced even when no legacy RPC exists. */
  if (local.present && snapshot.present && local.layoutKey !== snapshot.layoutKey) {
    return { ...result, status: 'conflict', reason: 'local_differs_from_snapshot' };
  }

  if (snapshot.present) {
    if (legacy.present && legacy.layoutKey !== snapshot.layoutKey) {
      return { ...result, status: 'conflict', reason: 'legacy_differs_from_snapshot' };
    }
    return { ...result, status: 'confirmed', reason: 'all_available_layouts_match' };
  }

  if (local.present) {
    if (legacy.present && legacy.layoutKey !== local.layoutKey) {
      return { ...result, status: 'conflict', reason: 'local_differs_from_legacy' };
    }
    return {
      ...result,
      status: legacy.present ? 'migrate' : 'migrate_local',
      reason: legacy.present ? 'snapshot_layout_missing' : 'snapshot_layout_missing_local_available',
    };
  }

  if (legacy.present) return { ...result, status: 'migrate', reason: 'snapshot_and_local_layout_missing' };
  return result;
}

export function selectHomeLayoutCandidate(analysis, source) {
  const match = analysis?.choices?.find((item) => item.source === source);
  if (!match) throw new Error('所选布局版本不存在');
  return clone(match.layout);
}

export function snapshotMatchesHomeLayout(payload, layout) {
  try {
    return homeLayoutsEqual(readHomeLayoutFromSnapshot(payload), layout);
  } catch {
    return false;
  }
}

function withoutHomeLayout(payload) {
  const copy = clone(payload || {});
  if (copy.meta?.user?.settings && Object.prototype.hasOwnProperty.call(copy.meta.user.settings, 'homeLayout')) {
    delete copy.meta.user.settings.homeLayout;
  }
  if (copy.meta?.migrations && Object.prototype.hasOwnProperty.call(copy.meta.migrations, 'homeLayoutFromWbSync')) {
    delete copy.meta.migrations.homeLayoutFromWbSync;
  }
  return copy;
}

export function snapshotsMatchExceptHomeLayout(left, right) {
  return stableStringify(withoutHomeLayout(left)) === stableStringify(withoutHomeLayout(right));
}

export function withHomeLayoutInSnapshot(payload, layout, { migrationMarker = null } = {}) {
  const normalized = validateLegacyHomeLayout(layout);
  if (!normalized) invalid('missing');
  const copy = clone(payload || {});
  copy.meta = copy.meta && typeof copy.meta === 'object' ? copy.meta : {};
  copy.meta.user = copy.meta.user && typeof copy.meta.user === 'object' ? copy.meta.user : {};
  copy.meta.user.settings = copy.meta.user.settings && typeof copy.meta.user.settings === 'object'
    ? copy.meta.user.settings
    : {};
  copy.meta.user.settings.homeLayout = normalized;
  if (migrationMarker) {
    copy.meta.migrations = copy.meta.migrations && typeof copy.meta.migrations === 'object'
      ? copy.meta.migrations
      : {};
    copy.meta.migrations.homeLayoutFromWbSync = clone(migrationMarker);
  }
  return copy;
}

export function readMigrationMarker(payload) {
  return payload?.meta?.migrations?.homeLayoutFromWbSync || null;
}

async function persistMigrationCompletion({
  confirmed,
  layout,
  legacyServerUpdatedAt,
  saveSnapshot,
  readSnapshot,
}) {
  const sourceChecksum = layoutChecksum(layout);
  const existing = readMigrationMarker(confirmed?.payload);
  if (existing?.status === 'completed'
    && existing?.sourceChecksum === sourceChecksum
    && snapshotMatchesHomeLayout(confirmed.payload, layout)) {
    return { snapshot: confirmed, markerWritten: false };
  }
  const targetRevision = Number(confirmed?.revision) + 1;
  const marker = {
    from: 'wb_sync',
    status: 'completed',
    sourceChecksum,
    sourceUpdatedAt: layout.updatedAt || '',
    sourceServerUpdatedAt: String(legacyServerUpdatedAt || ''),
    targetRevision,
    completedAt: new Date().toISOString(),
  };
  const candidate = withHomeLayoutInSnapshot(confirmed.payload, layout, { migrationMarker: marker });
  const saved = await saveSnapshot(candidate, Number(confirmed.revision));
  if (!saved?.payload || Number(saved.revision) <= Number(confirmed.revision)) {
    throw new Error('迁移完成标记未获得有效 revision');
  }
  if (stableStringify(saved.payload) !== stableStringify(candidate)) {
    throw new Error('迁移完成标记保存结果不一致');
  }
  const final = await readSnapshot();
  const finalMarker = readMigrationMarker(final?.payload);
  if (!final?.payload
    || Number(final.revision) < Number(saved.revision)
    || !snapshotMatchesHomeLayout(final.payload, layout)
    || finalMarker?.status !== 'completed'
    || finalMarker?.sourceChecksum !== sourceChecksum) {
    throw new Error('迁移完成标记回读失败');
  }
  return { snapshot: final, markerWritten: true };
}

export function isRetryableCloudError(error) {
  return RETRYABLE.test(String(error?.message || error || ''));
}

function isRevisionConflictError(error) {
  return REVISION_CONFLICT.test(String(error?.message || error || ''));
}

function setConflictResult(remote, desiredLayout, error, attempts) {
  const analysis = analyzeHomeLayoutState({
    localLayout: desiredLayout,
    snapshotLayout: readRawHomeLayoutFromSnapshot(remote?.payload),
    legacyLayout: undefined,
  });
  return {
    status: analysis.status === 'invalid' ? 'invalid' : 'conflict',
    reason: 'revision_conflict',
    analysis,
    error,
    attempts,
    revision: remote?.revision,
    payload: remote?.payload,
  };
}

/* Generic account snapshot CAS write with injected storage, network and layout. */
export async function commitHomeLayoutWithCas({
  mode = 'set',
  desiredLayout = null,
  legacyLayout,
  legacyServerUpdatedAt = '',
  hasUnsavedDraft = false,
  readSnapshot,
  saveSnapshot,
  readLocalSnapshot,
  applySnapshot = async () => {},
  maxAttempts = 3,
  retryDelayMs = 120,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (typeof readSnapshot !== 'function' || typeof saveSnapshot !== 'function') {
    throw new Error('缺少账号快照读写接口');
  }
  const attemptsLimit = Number.isFinite(Number(maxAttempts))
    ? Math.max(1, Math.min(5, Math.trunc(Number(maxAttempts))))
    : 3;
  let fixedLayout = null;
  if (mode !== 'migrate') {
    fixedLayout = validateLegacyHomeLayout(desiredLayout);
    if (!fixedLayout) throw new HomeLayoutValidationError('missing');
  }

  let lastError = null;
  let attemptsUsed = 0;
  for (let attempt = 1; attempt <= attemptsLimit; attempt += 1) {
    attemptsUsed = attempt;
    let layout = fixedLayout;
    try {
      const remote = await readSnapshot();
      const local = typeof readLocalSnapshot === 'function' ? await readLocalSnapshot() : null;
      if (remote && local && !snapshotsMatchExceptHomeLayout(remote.payload, local)) {
        return { status: 'deferred', reason: 'local_snapshot_has_unrelated_changes', attempts: attempt };
      }

      let analysis = null;
      let markerAllowed = false;
      if (mode === 'migrate') {
        analysis = analyzeHomeLayoutState({
          localLayout: readRawHomeLayoutFromDatabase(local),
          snapshotLayout: readRawHomeLayoutFromSnapshot(remote?.payload),
          legacyLayout,
          legacyServerUpdatedAt,
          hasUnsavedDraft,
        });
        if (analysis.status === 'invalid') return { status: 'invalid', analysis, attempts: attempt };
        if (analysis.status === 'conflict' || analysis.status === 'deferred') {
          return { status: analysis.status, analysis, attempts: attempt };
        }
        if (analysis.status === 'no_layout') return { status: 'no_legacy', analysis, attempts: attempt };
        if (analysis.status === 'confirmed') {
          return {
            status: 'confirmed',
            analysis,
            revision: remote?.revision,
            payload: remote?.payload,
            markerWritten: false,
            attempts: attempt,
          };
        }
        if (analysis.status === 'migrate') {
          layout = analysis.legacy.layout;
          markerAllowed = true;
        } else if (analysis.status === 'migrate_local') {
          layout = analysis.local.layout;
        } else {
          return { status: 'no_layout', analysis, attempts: attempt };
        }
      }

      const base = remote?.payload || local;
      if (!base) throw new Error('账号快照和本机快照均为空');
      if (remote && snapshotMatchesHomeLayout(remote.payload, layout)) {
        const final = analysis?.status === 'migrate'
          ? await persistMigrationCompletion({
            confirmed: remote,
            layout,
            legacyServerUpdatedAt,
            saveSnapshot,
            readSnapshot,
          })
          : { snapshot: remote, markerWritten: false };
        await applySnapshot(final.snapshot.payload, final.snapshot.revision);
        return {
          status: 'confirmed',
          analysis,
          revision: final.snapshot.revision,
          payload: final.snapshot.payload,
          markerWritten: final.markerWritten,
          attempts: attempt,
        };
      }

      const expectedRevision = Number(remote?.revision) || 0;
      const candidate = withHomeLayoutInSnapshot(base, layout);
      const saved = await saveSnapshot(candidate, expectedRevision);
      if (!saved?.payload || Number(saved.revision) <= expectedRevision) {
        throw new Error('云端保存未返回有效 revision');
      }
      if (stableStringify(saved.payload) !== stableStringify(candidate)) {
        throw new Error('云端返回的快照与提交内容不一致');
      }
      if (!snapshotMatchesHomeLayout(saved.payload, layout)) {
        throw new Error('云端返回的首页布局不一致');
      }

      const confirmed = await readSnapshot();
      if (!confirmed?.payload
        || Number(confirmed.revision) < Number(saved.revision)
        || !snapshotMatchesHomeLayout(confirmed.payload, layout)) {
        throw new Error('云端回读未确认首页布局');
      }
      const final = markerAllowed
        ? await persistMigrationCompletion({
          confirmed,
          layout,
          legacyServerUpdatedAt,
          saveSnapshot,
          readSnapshot,
        })
        : { snapshot: confirmed, markerWritten: false };
      await applySnapshot(final.snapshot.payload, final.snapshot.revision);
      return {
        status: 'saved',
        analysis,
        revision: final.snapshot.revision,
        payload: final.snapshot.payload,
        markerWritten: final.markerWritten,
        attempts: attempt,
      };
    } catch (error) {
      lastError = error;

      /* A normal user save must stop instead of silently overwriting a newer
         remote layout after a revision conflict. */
      if (mode !== 'migrate' && isRevisionConflictError(error)) {
        let latest = null;
        try {
          latest = await readSnapshot();
        } catch (readError) {
          return { status: 'failed', reason: 'revision_conflict_read_failed', error: readError, attempts: attempt };
        }
        if (!latest?.payload || readRawHomeLayoutFromSnapshot(latest.payload) === undefined) {
          return {
            status: 'conflict',
            reason: 'revision_conflict',
            analysis: null,
            error,
            attempts: attempt,
            revision: latest?.revision,
            payload: latest?.payload,
          };
        }
        const conflict = setConflictResult(latest, fixedLayout, error, attempt);
        if (conflict.status === 'conflict' && conflict.analysis?.status === 'confirmed' && latest?.payload) {
          await applySnapshot(latest.payload, latest.revision);
          return {
            status: 'confirmed',
            analysis: conflict.analysis,
            revision: latest.revision,
            payload: latest.payload,
            markerWritten: false,
            attempts: attempt,
          };
        }
        return conflict;
      }

      if (!isRetryableCloudError(error) || attempt >= attemptsLimit) break;
      await sleep(retryDelayMs * attempt);
    }
  }
  return {
    status: 'failed',
    error: lastError || new Error('首页布局同步失败'),
    attempts: attemptsUsed,
  };
}

function browserLockManager() {
  try {
    return typeof navigator !== 'undefined' && navigator.locks?.request ? navigator.locks : null;
  } catch {
    return null;
  }
}

/* Same-browser, per-account task queue. navigator.locks also serializes tabs. */
export async function withHomeLayoutLock(uid, task, {
  requestLock,
  timeoutMs = 5000,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  const key = String(uid || 'anonymous');
  const manager = requestLock === undefined ? browserLockManager() : requestLock;
  if (manager?.request) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    let timedOut = false;
    let entered = false;
    const timer = setTimeoutFn(() => {
      timedOut = true;
      controller?.abort();
    }, Math.max(1, Number(timeoutMs) || 5000));
    try {
      return await manager.request(
        'wb-home-layout:' + key,
        { mode: 'exclusive', ...(controller ? { signal: controller.signal } : {}) },
        async () => {
          entered = true;
          clearTimeoutFn(timer);
          return task();
        },
      );
    } catch (error) {
      if (entered) throw error;
      if (timedOut || error?.name === 'AbortError') throw new HomeLayoutLockError('lock-timeout');
      throw new HomeLayoutLockError('lock-failed');
    } finally {
      clearTimeoutFn(timer);
    }
  }

  const previous = LAYOUT_TASKS.get(key) || Promise.resolve();
  let timer = null;
  const deadline = new Promise((_, reject) => {
    timer = setTimeoutFn(() => reject(new HomeLayoutLockError('lock-timeout')), Math.max(1, Number(timeoutMs) || 5000));
  });
  const run = Promise.race([previous.catch(() => undefined), deadline])
    .then(() => task())
    .finally(() => clearTimeoutFn(timer));
  const tail = run.catch(() => undefined);
  LAYOUT_TASKS.set(key, tail);
  tail.finally(() => {
    if (LAYOUT_TASKS.get(key) === tail) LAYOUT_TASKS.delete(key);
  });
  return run;
}
