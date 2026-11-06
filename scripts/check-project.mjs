import { readdir, readFile, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];

async function walk(directory) {
  const out = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) out.push(...await walk(target));
    else out.push(target);
  }
  return out;
}

const files = await walk(root);
const jsFiles = files.filter((file) => /\.(?:js|mjs)$/i.test(file)
  && !file.includes(`${path.sep}.git${path.sep}`));

for (const file of jsFiles) {
  const checked = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (checked.status !== 0) failures.push(`语法错误 ${path.relative(root, file)}\n${checked.stderr}`);
}

const swPath = path.join(root, 'sw.js');
const sw = await readFile(swPath, 'utf8');
const cacheMatches = [...sw.matchAll(/const CACHE\s*=\s*['"]([^'"]+)['"]/g)];
if (cacheMatches.length !== 1) failures.push(`Service Worker 必须只有一个缓存版本，实际 ${cacheMatches.length}`);

const assetBlock = /const ASSETS\s*=\s*\[([\s\S]*?)\];/.exec(sw);
if (!assetBlock) failures.push('没有找到 Service Worker ASSETS 清单');
const assets = new Set([...String(assetBlock?.[1] || '').matchAll(/['"]\.\/([^'"]+)['"]/g)]
  .map((match) => match[1].replaceAll('/', path.sep)));

for (const asset of assets) {
  try {
    const info = await stat(path.join(root, asset));
    if (!info.isFile()) failures.push(`Service Worker 资源不是文件：${asset}`);
  } catch {
    failures.push(`Service Worker 资源不存在：${asset}`);
  }
}

for (const file of jsFiles) {
  const relative = path.relative(root, file);
  if (relative.startsWith(`js${path.sep}`) && !assets.has(relative)) {
    failures.push(`JavaScript 未列入 Service Worker：${relative}`);
  }
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}

console.log(JSON.stringify({
  jsFiles: jsFiles.length,
  serviceWorkerAssets: assets.size,
  cacheVersion: cacheMatches[0][1],
  syntax: 'passed',
  resources: 'complete',
}, null, 2));
