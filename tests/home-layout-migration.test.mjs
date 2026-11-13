import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  normalizeHomeLayout,
  readHomeLayoutFromDatabase,
  readHomeLayoutFromSnapshot,
  layoutChecksum,
  analyzeHomeLayoutState,
  selectHomeLayoutCandidate,
  snapshotMatchesHomeLayout,
  snapshotsMatchExceptHomeLayout,
  withHomeLayoutInSnapshot,
  readMigrationMarker,
  commitHomeLayoutWithCas,
} from "../js/home-layout-migration.mjs";

const clone = (value) => JSON.parse(JSON.stringify(value));

function layout(card = "profile", updatedAt = "2026-11-06T01:00:00.000Z") {
  return {
    version: 2,
    updatedAt,
    breakpoints: {
      desktop: { layout: [{ id: card, x: 0, y: 0, w: 5, h: 2 }], hidden: [] },
      tablet: { layout: [{ id: card, x: 0, y: 0, w: 6, h: 3 }], hidden: [] },
      mobile: { layout: [{ id: card, x: 0, y: 0, w: 12, h: 3 }], hidden: [] },
    },
  };
}

function snapshot(homeLayout, overrides = {}) {
  return {
    seqs: { lesson: 7 },
    meta: {
      seeded: true,
      user: {
        account: "demo_teacher",
        nickname: "示例老师",
        settings: {
          theme: "warm",
          lesson: { pricePerHour: 35 },
          ...(homeLayout ? { homeLayout } : {}),
        },
      },
      ...(overrides.meta || {}),
    },
    lessons: [{ id: 7, date: "2026-11-06", content: "示例课程" }],
    notes: [{ id: 9, title: "示例笔记" }],
    ...overrides.root,
  };
}

function harness({ remote = null, local = null } = {}) {
  let remoteState = clone(remote);
  let localState = clone(local);
  const saves = [];
  const applied = [];
  return {
    get remote() { return remoteState; },
    get local() { return localState; },
    saves,
    applied,
    readSnapshot: async () => clone(remoteState),
    saveSnapshot: async (payload, expectedRevision) => {
      const currentRevision = Number(remoteState?.revision) || 0;
      if (expectedRevision !== currentRevision) {
        const error = new Error("WB_DATA_REVISION_CONFLICT 40001");
        error.code = "40001";
        throw error;
      }
      remoteState = {
        payload: clone(payload),
        revision: currentRevision + 1,
        updated_at: "2026-11-06T01:10:00.000Z",
      };
      saves.push(clone(remoteState));
      return clone(remoteState);
    },
    readLocalSnapshot: async () => clone(localState),
    applySnapshot: async (payload, revision) => {
      localState = clone(payload);
      applied.push({ payload: clone(payload), revision });
    },
    setRemote(next) {
      remoteState = clone(next);
    },
  };
}

test("正确读取账号快照中的 homeLayout", () => {
  const expected = layout("calendar");
  const payload = snapshot(expected);
  assert.equal(readHomeLayoutFromSnapshot(payload)?.breakpoints.desktop.layout[0].id, "calendar");
});

test("错误顶层 settings.homeLayout 不会被读取", () => {
  const payload = snapshot(null);
  payload.settings = { homeLayout: layout("calendar") };
  assert.equal(readHomeLayoutFromSnapshot(payload), null);
});

test("本地数据库布局读取使用 meta.user.settings 路径", () => {
  const db = snapshot(layout("weather"));
  assert.equal(readHomeLayoutFromDatabase(db)?.breakpoints.mobile.layout[0].id, "weather");
});

test("快照布局读取保留移动端顺序和隐藏状态", () => {
  const value = layout("timeline");
  value.breakpoints.mobile.layout.push({ id: "profile", x: 0, y: 3, w: 12, h: 2 });
  value.breakpoints.mobile.hidden = ["calendar"];
  const parsed = readHomeLayoutFromSnapshot(snapshot(value));
  assert.deepEqual(parsed.breakpoints.mobile.layout.map((item) => item.id), ["timeline", "profile"]);
  assert.deepEqual(parsed.breakpoints.mobile.hidden, ["calendar"]);
});

test("旧布局载荷可被统一标准化", () => {
  const legacy = normalizeHomeLayout(layout("dailyQuote", ""));
  assert.ok(legacy);
  assert.equal(legacy.updatedAt, "");
  assert.equal(layoutChecksum(legacy), layoutChecksum(legacy));
});

test("三份布局内容一致时确认而不覆盖", () => {
  const same = layout("profile");
  const analysis = analyzeHomeLayoutState({
    localLayout: same,
    snapshotLayout: { ...same, updatedAt: "2026-11-07T00:00:00.000Z" },
    legacyLayout: { ...same, updatedAt: "2026-11-05T00:00:00.000Z" },
  });
  assert.equal(analysis.status, "confirmed");
  assert.equal(analysis.choices.length, 1);
});

test("快照缺少布局、旧布局有效、本机没有冲突时允许迁移", () => {
  const legacy = layout("profile");
  const analysis = analyzeHomeLayoutState({
    localLayout: null,
    snapshotLayout: null,
    legacyLayout: legacy,
  });
  assert.equal(analysis.status, "migrate");
  assert.equal(analysis.legacy.checksum, layoutChecksum(legacy));
});

test("默认布局 normalizer 不会把缺失的持久化布局误判为已有", () => {
  const defaultingNormalizer = (raw) => raw == null ? layout("profile") : normalizeHomeLayout(raw);
  const analysis = analyzeHomeLayoutState({
    localLayout: undefined,
    snapshotLayout: undefined,
    legacyLayout: layout("calendar"),
    normalizer: defaultingNormalizer,
  });
  assert.equal(analysis.status, "migrate");
  assert.equal(analysis.local.present, false);
  assert.equal(analysis.snapshot.present, false);
});

test("本机布局与云端不同时停止自动迁移", () => {
  const analysis = analyzeHomeLayoutState({
    localLayout: layout("calendar"),
    snapshotLayout: layout("profile"),
    legacyLayout: layout("calendar"),
  });
  assert.equal(analysis.status, "conflict");
  assert.equal(analysis.choices.length, 2);
});

test("旧布局与账号快照不同时停止自动迁移", () => {
  const analysis = analyzeHomeLayoutState({
    localLayout: layout("calendar"),
    snapshotLayout: layout("calendar"),
    legacyLayout: layout("profile"),
  });
  assert.equal(analysis.status, "conflict");
});

test("即使 updatedAt 看似更新，只要内容不同就不自动覆盖", () => {
  const analysis = analyzeHomeLayoutState({
    localLayout: layout("calendar", "2025-01-01T00:00:00.000Z"),
    snapshotLayout: layout("profile", "2026-01-01T00:00:00.000Z"),
    legacyLayout: layout("weather", "2099-01-01T00:00:00.000Z"),
  });
  assert.equal(analysis.status, "conflict");
});

test("冲突提供人工选择接口且保留全部不同版本", () => {
  const analysis = analyzeHomeLayoutState({
    localLayout: layout("calendar"),
    snapshotLayout: layout("profile"),
    legacyLayout: layout("weather"),
  });
  assert.deepEqual(new Set(analysis.choices.map((item) => item.source)), new Set(["local", "snapshot", "legacy"]));
  assert.equal(selectHomeLayoutCandidate(analysis, "legacy").breakpoints.desktop.layout[0].id, "weather");
  assert.throws(() => selectHomeLayoutCandidate(analysis, "unknown"));
});

test("有未保存草稿时延迟迁移", () => {
  const analysis = analyzeHomeLayoutState({
    localLayout: null,
    snapshotLayout: null,
    legacyLayout: layout("profile"),
    hasUnsavedDraft: true,
  });
  assert.equal(analysis.status, "deferred");
});

test("无效旧布局不会触发迁移", () => {
  const analysis = analyzeHomeLayoutState({
    localLayout: null,
    snapshotLayout: null,
    legacyLayout: { version: 2, breakpoints: null },
  });
  assert.equal(analysis.status, "no_legacy");
});

test("写回快照只替换 homeLayout 并保留其他 settings", () => {
  const before = snapshot(layout("profile"));
  const after = withHomeLayoutInSnapshot(before, layout("calendar"));
  assert.equal(after.meta.user.settings.homeLayout.breakpoints.desktop.layout[0].id, "calendar");
  assert.equal(after.meta.user.settings.theme, before.meta.user.settings.theme);
  assert.deepEqual(after.meta.user.settings.lesson, before.meta.user.settings.lesson);
});

test("写回快照保留全部业务数据", () => {
  const before = snapshot(null);
  const after = withHomeLayoutInSnapshot(before, layout("profile"));
  assert.deepEqual(after.lessons, before.lessons);
  assert.deepEqual(after.notes, before.notes);
  assert.deepEqual(after.seqs, before.seqs);
  assert.equal(snapshotsMatchExceptHomeLayout(before, after), true);
});

test("账号快照存在其他本机差异时拒绝直接合并", async () => {
  const remoteBase = snapshot(layout("profile"));
  const localBase = snapshot(layout("profile"));
  localBase.lessons[0].content = "本机未同步内容";
  const h = harness({
    remote: { payload: remoteBase, revision: 3 },
    local: localBase,
  });
  const result = await commitHomeLayoutWithCas({
    mode: "set",
    desiredLayout: layout("calendar"),
    ...h,
  });
  assert.equal(result.status, "deferred");
  assert.equal(h.saves.length, 0);
});

test("revision 正常递增并在回读后应用", async () => {
  const base = snapshot(layout("profile"));
  const h = harness({ remote: { payload: base, revision: 4 }, local: base });
  const result = await commitHomeLayoutWithCas({
    mode: "set",
    desiredLayout: layout("calendar"),
    ...h,
  });
  assert.equal(result.status, "saved");
  assert.equal(result.revision, 5);
  assert.equal(h.applied.length, 1);
  assert.equal(snapshotMatchesHomeLayout(h.remote.payload, layout("calendar")), true);
});

test("迁移先保存布局，确认后才写云端完成标记", async () => {
  const base = snapshot(null);
  const h = harness({ remote: { payload: base, revision: 2 }, local: base });
  const result = await commitHomeLayoutWithCas({
    mode: "migrate",
    legacyLayout: layout("profile"),
    legacyServerUpdatedAt: "2026-11-06T02:00:00.000Z",
    ...h,
  });
  assert.equal(result.status, "saved");
  assert.equal(result.markerWritten, true);
  assert.equal(h.saves.length, 2);
  assert.equal(Boolean(readMigrationMarker(h.saves[0].payload)), false);
  assert.equal(readMigrationMarker(h.saves[1].payload)?.status, "completed");
  assert.equal(result.revision, 4);
});

test("revision conflict 后重新读取并在迁移规则下停止覆盖", async () => {
  const base = snapshot(null);
  const h = harness({ remote: { payload: base, revision: 2 }, local: base });
  let first = true;
  const originalSave = h.saveSnapshot;
  h.saveSnapshot = async (payload, revision) => {
    if (first) {
      first = false;
      h.setRemote({
        payload: snapshot(layout("weather")),
        revision: 3,
      });
      throw new Error("WB_DATA_REVISION_CONFLICT 40001");
    }
    return originalSave(payload, revision);
  };
  const result = await commitHomeLayoutWithCas({
    mode: "migrate",
    legacyLayout: layout("profile"),
    ...h,
  });
  assert.equal(result.status, "conflict");
  assert.equal(h.saves.length, 0);
});

test("55P03 busy 后有限重试成功", async () => {
  const base = snapshot(layout("profile"));
  const h = harness({ remote: { payload: base, revision: 1 }, local: base });
  let first = true;
  const originalSave = h.saveSnapshot;
  h.saveSnapshot = async (payload, revision) => {
    if (first) {
      first = false;
      throw new Error("WB_DATA_WRITE_BUSY 55P03");
    }
    return originalSave(payload, revision);
  };
  const result = await commitHomeLayoutWithCas({
    mode: "set",
    desiredLayout: layout("calendar"),
    retryDelayMs: 0,
    sleep: async () => {},
    ...h,
  });
  assert.equal(result.status, "saved");
  assert.equal(result.attempts, 2);
});

test("保存失败时不应用快照也不写完成标记", async () => {
  const base = snapshot(null);
  const h = harness({
    remote: { payload: base, revision: 1 },
    local: base,
  });
  h.saveSnapshot = async () => { throw new Error("database unavailable"); };
  const result = await commitHomeLayoutWithCas({
    mode: "migrate",
    legacyLayout: layout("profile"),
    maxAttempts: 2,
    ...h,
  });
  assert.equal(result.status, "failed");
  assert.equal(h.applied.length, 0);
  assert.deepEqual(h.local, base);
  assert.equal(Boolean(readMigrationMarker(h.remote.payload)), false);
});

test("回读失败时不应用快照也不写完成标记", async () => {
  const base = snapshot(null);
  let remote = { payload: base, revision: 1 };
  let reads = 0;
  const result = await commitHomeLayoutWithCas({
    mode: "migrate",
    legacyLayout: layout("profile"),
    readSnapshot: async () => {
      reads += 1;
      if (reads >= 2) throw new Error("readback unavailable");
      return clone(remote);
    },
    saveSnapshot: async (payload) => {
      remote = { payload: clone(payload), revision: 2 };
      return clone(remote);
    },
    readLocalSnapshot: async () => clone(base),
    applySnapshot: async () => { throw new Error("must not apply"); },
    maxAttempts: 1,
  });
  assert.equal(result.status, "failed");
  assert.equal(Boolean(readMigrationMarker(remote.payload)), false);
});

test("迁移完成后再次执行保持幂等", async () => {
  const base = snapshot(null);
  const h = harness({ remote: { payload: base, revision: 1 }, local: base });
  const options = {
    mode: "migrate",
    legacyLayout: layout("profile"),
    ...h,
  };
  const first = await commitHomeLayoutWithCas(options);
  const saveCount = h.saves.length;
  const applyCount = h.applied.length;
  const second = await commitHomeLayoutWithCas(options);
  assert.equal(first.status, "saved");
  assert.equal(second.status, "confirmed");
  assert.equal(second.markerWritten, false);
  assert.equal(h.saves.length, saveCount);
  assert.equal(h.applied.length, applyCount);
});

test("用户 A/B 的布局快照互不影响", async () => {
  const baseA = snapshot(null);
  const baseB = snapshot(null);
  const hA = harness({ remote: { payload: baseA, revision: 1 }, local: baseA });
  const hB = harness({ remote: { payload: baseB, revision: 1 }, local: baseB });
  await commitHomeLayoutWithCas({ mode: "migrate", legacyLayout: layout("profile"), ...hA });
  await commitHomeLayoutWithCas({ mode: "migrate", legacyLayout: layout("calendar"), ...hB });
  assert.equal(snapshotMatchesHomeLayout(hA.remote.payload, layout("profile")), true);
  assert.equal(snapshotMatchesHomeLayout(hB.remote.payload, layout("calendar")), true);
  assert.equal(snapshotMatchesHomeLayout(hA.remote.payload, layout("calendar")), false);
  assert.equal(snapshotMatchesHomeLayout(hB.remote.payload, layout("profile")), false);
});

test("正常业务代码不再调用旧 wb_get 和 wb_put", async () => {
  const source = await Promise.all([
    readFile(new URL("../js/homegrid.js", import.meta.url), "utf8"),
    readFile(new URL("../js/cloudsync.js", import.meta.url), "utf8"),
  ]);
  for (const text of source) {
    assert.doesNotMatch(text, /\/rest\/v1\/rpc\/wb_(get|put)(?!_home_layout)/);
    assert.doesNotMatch(text, /['"]wb_(get|put)['"]/);
  }
});

test("数据库模板不会删除旧同步数据或重新开放 anon", async () => {
  const sql = await readFile(new URL("../supabase_setup.sql", import.meta.url), "utf8");
  assert.doesNotMatch(sql, /delete\s+from\s+public\.wb_sync/i);
  assert.doesNotMatch(sql, /truncate\s+public\.wb_sync/i);
  assert.doesNotMatch(sql, /drop\s+table\s+(if\s+exists\s+)?public\.wb_sync/i);
  assert.doesNotMatch(sql, /grant\s+execute[^;]+to\s+anon/i);
});
