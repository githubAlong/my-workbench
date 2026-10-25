#!/usr/bin/env node
/* 一键备份：数据库 + 上传的附件，打包成一个 .tar.gz
 *
 * 用法：
 *   node tools/backup.mjs                 备份到 backups/
 *   node tools/backup.mjs /path/to/dir    备份到指定目录
 *
 * 为什么不用 cp：
 *   数据库开着 WAL 模式，最近写入的数据（可能几 MB）还在 workbench.db-wal 里没合并进主库。
 *   只 cp 主文件会丢数据 —— 实测确实丢过一条上课记录。
 *   这里用 VACUUM INTO，SQLite 会把 WAL 里的内容一起写进副本，得到一个完整、独立的单文件。
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, rmSync, statSync, cpSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DB = join(ROOT, 'data', 'workbench.db');
const UP = join(ROOT, 'uploads');

const stamp = new Date(Date.now() + 8 * 3600e3).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const outDir = resolve(process.argv[2] || join(ROOT, 'backups'));
mkdirSync(outDir, { recursive: true });

if (!existsSync(DB)) {
  console.error('✗ 找不到数据库：' + DB);
  process.exit(1);
}

const stage = join(outDir, '.stage-' + stamp);
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

const snapshot = join(stage, 'workbench.db');
const db = new DatabaseSync(DB);
db.exec(`VACUUM INTO '${snapshot.replace(/'/g, "''")}'`);

// 完整性自检：坏备份不如没备份
const chk = db.prepare('PRAGMA integrity_check').get();
const check = Object.values(chk || {})[0];
const counts = {};
for (const t of ['users', 'items', 'todos', 'lessons', 'teachers', 'studies', 'notes', 'attachments']) {
  try { counts[t] = db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c; } catch {}
}
db.close();

if (String(check).toLowerCase() !== 'ok') {
  console.error('✗ 数据库完整性检查未通过：' + check);
  process.exit(1);
}

if (existsSync(UP)) cpSync(UP, join(stage, 'uploads'), { recursive: true });

// 记一份备份时的统计，将来恢复后可以对照
const meta = { backedUpAt: new Date().toISOString(), counts, integrity: check };
execFileSync('sh', ['-c', `cat > '${join(stage, 'backup-info.json')}' <<'JSON'\n${JSON.stringify(meta, null, 2)}\nJSON`]);

const tarName = `workbench-backup-${stamp}.tar.gz`;
const tarPath = join(outDir, tarName);
execFileSync('tar', ['-czf', tarPath, '-C', stage, '.']);
rmSync(stage, { recursive: true, force: true });

const mb = (statSync(tarPath).size / 1024 / 1024).toFixed(2);
console.log('✅ 备份完成');
console.log('   文件：' + tarPath);
console.log('   大小：' + mb + ' MB');
console.log('   完整性：' + check);
console.log('   记录数：' + Object.entries(counts).map(([k, v]) => `${k}=${v}`).join('  '));
console.log('\n把这个文件存到网盘/U 盘/邮箱。恢复用：node tools/restore.mjs <备份文件>');
