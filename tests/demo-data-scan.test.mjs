import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  findSeedBatch, scanDemoData, collectRemovable, PROTECTED_TABLES,
} from '../js/demo-data-scan.mjs';

const SEED_AT = '2026-11-01T02:00:00.000Z';
const USER_AT = '2026-11-10T09:12:34.000Z';

function seedRow(id, extra = {}) {
  return { id, created_at: SEED_AT, updated_at: SEED_AT, deleted_at: null, ...extra };
}

function makeDb() {
  const db = { seqs: {}, meta: { seeded: true } };
  db.periods = Array.from({ length: 10 }, (_, i) => seedRow(i + 1, { period_no: i + 1 }));
  db.courses = Array.from({ length: 18 }, (_, i) => seedRow(i + 1, { class_name: '高二(3)班' }));
  db.todos = Array.from({ length: 3 }, (_, i) => seedRow(i + 1, { title: '示例便签' }));
  db.notes = Array.from({ length: 2 }, (_, i) => seedRow(i + 1, { title: '示例笔记' }));
  return db;
}

test('识别出系统同一批次灌入的示例数据', () => {
  const db = makeDb();
  const batch = findSeedBatch(db);
  assert.ok(batch, '应找到示例批次');
  assert.equal(batch.stamp, Date.parse(SEED_AT));
  assert.equal(batch.rows, 33);
  assert.ok(batch.tables.includes('periods'));
  assert.ok(batch.tables.includes('courses'));
});

test('用户后来录入的记录全部保留', () => {
  const db = makeDb();
  db.class_records = [
    { id: 101, created_at: USER_AT, updated_at: USER_AT, class_name: '高二(3)班' },
    { id: 102, created_at: USER_AT, updated_at: USER_AT, class_name: '高二(5)班' },
  ];
  db.courses.push({ id: 999, created_at: USER_AT, updated_at: USER_AT, class_name: '我自己的课' });
  const scan = scanDemoData(db);
  assert.equal(scan.total, 33);
  assert.equal(scan.found, true);
  const removable = collectRemovable(db, scan.stamp);
  assert.equal(removable.get('class_records'), undefined);
  assert.ok(!removable.get('courses').has(db.courses.at(-1)));

  for (const [table, rows] of removable) db[table] = db[table].filter((r) => !rows.has(r));
  assert.equal(db.class_records.length, 2, '用户录入的上课记录不能被删');
  assert.equal(db.courses.length, 1, '用户录入的课程不能被删');
  assert.equal(db.courses[0].class_name, '我自己的课');
});

test('被用户改过的示例记录保留，并在预览里单独计数', () => {
  const db = makeDb();
  db.courses[0].updated_at = USER_AT;
  db.courses[0].class_name = '我改过的课';
  const scan = scanDemoData(db);
  assert.equal(scan.modified, 1);
  assert.equal(scan.total, 32);
  const courses = scan.groups.find((g) => g.table === 'courses');
  assert.equal(courses.remove, 17);
  assert.equal(courses.keep, 1);
  const removable = collectRemovable(db, scan.stamp);
  db.courses = db.courses.filter((r) => !removable.get('courses').has(r));
  assert.equal(db.courses.length, 1);
  assert.equal(db.courses[0].class_name, '我改过的课');
});

test('教师名册等保护表不参与清理', () => {
  const db = makeDb();
  assert.ok(PROTECTED_TABLES.has('teachers'));
  db.teachers = Array.from({ length: 30 }, (_, i) => seedRow(i + 1, { name: '真实老师' + i }));
  db.invig_rules = Array.from({ length: 5 }, (_, i) => seedRow(i + 1));
  const scan = scanDemoData(db);
  assert.equal(scan.total, 33);
  assert.ok(!scan.groups.some((g) => g.table === 'teachers' || g.table === 'invig_rules'));
  const removable = collectRemovable(db, scan.stamp);
  for (const [table, rows] of removable) db[table] = db[table].filter((r) => !rows.has(r));
  assert.equal(db.teachers.length, 30, '真实教师名册必须保留');
  assert.equal(db.invig_rules.length, 5);
});

test('批量导入的真实数据不会被误判成示例', () => {
  const db = makeDb();
  /* 只清掉种子，再塞一批同一时刻、但只在单表且不含 periods/courses 的导入数据 */
  const removable = collectRemovable(db, findSeedBatch(db).stamp);
  for (const [table, rows] of removable) db[table] = db[table].filter((r) => !rows.has(r));
  const IMPORT_AT = '2026-11-05T03:00:00.000Z';
  db.class_records = Array.from({ length: 60 }, (_, i) => ({
    id: i + 1, created_at: IMPORT_AT, updated_at: IMPORT_AT, class_name: '导入班级' + i,
  }));
  assert.equal(findSeedBatch(db), null, '单表批量导入不应命中示例判定');
  assert.equal(scanDemoData(db).found, false);
  /* UI 只在命中示例批次时才打开清理入口，collectRemovable 不会被误调用 */
  const ui = readFileSync(new URL('../js/clean-demo-data.js', import.meta.url), 'utf8');
  assert.match(ui, /if \(!scan\.found\)/);
  assert.match(readFileSync(new URL('../js/me.js', import.meta.url), 'utf8'), /hasDemoData\(\)/);
});

test('批次时间戳丢失时按示例原文精确清理学习记录', () => {
  const db = { seqs: {}, meta: { seeded: true } };
  const seed = (id, title, minutes) => ({
    id, title, content: '记录要点若干', minutes, source: '', tags: '',
    created_at: USER_AT, updated_at: USER_AT, deleted_at: null,
  });
  db.studies = [
    seed(1, '《红楼梦》整本书阅读指导', 60),
    seed(2, '读《语文学习任务设计》', 45),
    { id: 3, title: '我自己的读书笔记', content: '记录要点若干', minutes: 45, source: '', tags: '', created_at: USER_AT, updated_at: USER_AT },
    { id: 4, title: '《红楼梦》整本书阅读指导', content: '我写的真实心得', minutes: 60, source: '', tags: '', created_at: USER_AT, updated_at: USER_AT },
  ];
  const scan = scanDemoData(db);
  assert.equal(scan.found, true);
  assert.equal(scan.stamp, null, '时间戳对不上批次，走原文匹配');
  assert.equal(scan.total, 2);
  const removable = collectRemovable(db, scan.stamp);
  const rows = removable.get('studies');
  assert.equal(rows.size, 2);
  assert.ok(![...rows].some((r) => r.title === '我自己的读书笔记'));
  assert.ok(![...rows].some((r) => r.content === '我写的真实心得'));
});

test('清理后写标记防止示例数据再灌回来', () => {
  const source = readFileSync(new URL('../js/clean-demo-data.js', import.meta.url), 'utf8');
  assert.match(source, /db\.meta\.seeded = true/);
  assert.match(source, /db\.meta\.importedAt = new Date\(\)\.toISOString\(\)/);
  assert.match(source, /delete db\.meta\.seedFiles/);
  assert.match(source, /pushNow\(\)/, '清理后必须把快照推到云端');
  assert.match(source, /saveBlob\(/, '执行前必须强制导出备份');
});

test('执行前强制备份、且要手打「清空」二次确认', () => {
  const source = readFileSync(new URL('../js/clean-demo-data.js', import.meta.url), 'utf8');
  const backupAt = source.indexOf('强制备份');
  const saveAt = source.indexOf('const db = load();');
  assert.ok(backupAt > -1 && saveAt > backupAt, '备份必须发生在改动数据之前');
  assert.match(source, /word\.value\.trim\(\) !== '清空'/);
  assert.match(source, /备份下载失败，已中止清理/);
});
