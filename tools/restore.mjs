#!/usr/bin/env node
/* 从备份恢复。会先把你当前的数据库另存一份，再覆盖——恢复错了还能退回去。
 *
 * 用法：
 *   node tools/restore.mjs backups/workbench-backup-20261025-103000.tar.gz
 *
 * 恢复完必须重启服务（WAL 模式下手动换了库文件，旧进程还握着旧句柄）。
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, rmSync, cpSync, renameSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DB = join(ROOT, 'data', 'workbench.db');
const UP = join(ROOT, 'uploads');

const src = process.argv[2];
if (!src) {
  console.error('用法：node tools/restore.mjs <备份文件.tar.gz>');
  process.exit(1);
}
if (!existsSync(src)) {
  console.error('✗ 找不到备份文件：' + src);
  process.exit(1);
}

const stamp = new Date(Date.now() + 8 * 3600e3).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const work = join(ROOT, 'backups', '.restore-' + stamp);
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

console.log('① 解包…');
execFileSync('tar', ['-xzf', resolve(src), '-C', work]);
/* 备份包里的库文件名有两种：正常备份是 workbench.db，
   而 restore 自己生成的「恢复前快照」叫 current.db —— 两种都要认，
   否则恢复错版本时恰恰用不了这条退路。 */
const DB_NAMES = ['workbench.db', 'current.db'];
const dbName = DB_NAMES.find((n) => existsSync(join(work, n)));
if (!dbName) {
  console.error('✗ 备份包里没有数据库文件（找过 ' + DB_NAMES.join(' / ') + '），可能不是本系统的备份');
  rmSync(work, { recursive: true, force: true });
  process.exit(1);
}
const newDb = join(work, dbName);
console.log('   数据库：' + dbName);

console.log('② 校验备份完整性…');
const chkDb = new DatabaseSync(newDb, { readOnly: true });
const chk = Object.values(chkDb.prepare('PRAGMA integrity_check').get() || {})[0];
if (String(chk).toLowerCase() !== 'ok') {
  chkDb.close();
  console.error('✗ 备份文件本身已损坏：' + chk);
  rmSync(work, { recursive: true, force: true });
  process.exit(1);
}
const cnt = {};
for (const t of ['users', 'items', 'todos', 'lessons', 'teachers']) {
  try { cnt[t] = chkDb.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c; } catch {}
}
chkDb.close();
console.log('   ok ' + Object.entries(cnt).map(([k, v]) => `${k}=${v}`).join('  '));

// 覆盖前先把当前库留一份
console.log('③ 备份当前数据（以防恢复错版本）…');
const safety = join(ROOT, 'backups', `before-restore-${stamp}.tar.gz`);
mkdirSync(join(ROOT, 'backups'), { recursive: true });
if (existsSync(DB)) {
  /* 必须放在独立子目录：解包目录 work/ 里已经有备份包自带的 workbench.db，
     VACUUM INTO 目标文件已存在会直接报「output file already exists」。
     这个坑第一次就踩了，恢复流程因此中断。 */
  const safeDir = join(work, '_current');
  mkdirSync(safeDir, { recursive: true });
  const bak = join(safeDir, 'workbench.db');
  const cur = new DatabaseSync(DB);
  cur.exec(`VACUUM INTO '${bak.replace(/'/g, "''")}'`);
  cur.close();
  execFileSync('tar', ['-czf', safety, '-C', safeDir, 'workbench.db']);
  console.log('   已存：' + safety);
}

console.log('④ 覆盖数据库与附件…');
/* 三个文件都要清：留着旧的 -wal 会把过期数据重放进新库，比不恢复更糟 */
for (const f of [DB, DB + '-wal', DB + '-shm']) rmSync(f, { force: true });
cpSync(newDb, DB);

const newUp = join(work, 'uploads');
if (existsSync(newUp)) {
  rmSync(UP, { recursive: true, force: true });
  cpSync(newUp, UP, { recursive: true });
  console.log('   附件已恢复');
} else {
  console.log('   备份里没有附件目录，跳过');
}
rmSync(work, { recursive: true, force: true });

console.log('\n✅ 恢复完成');
console.log('\n⚠️  必须重启服务才会生效（旧进程还握着旧数据库句柄）：');
console.log('    先停掉 node server/index.mjs，再重新启动');
console.log('\n如果恢复错了版本，用这份退回去：');
console.log('    node tools/restore.mjs ' + safety);
