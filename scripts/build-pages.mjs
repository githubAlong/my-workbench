import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'dist');
const files = [
  'index.html',
  'manifest.webmanifest',
  'sw.js',
  'app.js',
  'student.html',
  'student.bundle.js',
];
const directories = ['assets', 'css', 'icons', 'js'];

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const file of files) {
  await cp(path.join(root, file), path.join(output, file));
}
for (const directory of directories) {
  await cp(path.join(root, directory), path.join(output, directory), { recursive: true });
}
console.log(output);
