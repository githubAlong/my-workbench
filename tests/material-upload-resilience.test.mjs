import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/* 教材上传的一系列回归卡子。必须同时成立的不变量：
   1. 单个文件失败不能整批抛出（成功的文件已经进了 storage，重试不能重传一遍）；
   2. 请求必须有超时，否则卡死的连接永远不 settle；
   3. 失败要在弹层里留下文字，不能只靠一个 3 秒就消失的 toast；
   4. 每传完一个文件就要回调一次，界面立刻打勾 ——
      一批里有失败时，用户要知道「哪几个已经上去了」；
   5. 有失败时背后列表也要刷新，不能让成功的那几个看不见；
   6. 大文件串行 + 不重试：并行抢带宽会把它拖到边缘函数超时（网关 502）。 */

const read = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('云端上传按文件独立成败，返回 { uploaded, failed }', () => {
  const source = read('js/cloud.js');
  assert.match(source, /return \{\s*uploaded: results\.filter\(Boolean\),\s*failed: failures/);
  assert.match(source, /const failures = new Array\(files\.length\)\.fill\(null\);/);
  assert.match(source, /catch \(error\) \{\s*failures\[index\] = error;/);
  /* 失败文件也要把字节数记账，否则总进度永远差一截 */
  assert.match(source, /doneBytes\[index\] = byteLen\(file\.data\);/);
});

test('上传请求带超时，卡住的连接不会永远挂着', () => {
  const source = read('js/cloud.js');
  assert.match(source, /const UPLOAD_TIMEOUT_MS = \d+;/);
  assert.match(source, /xhr\.timeout = UPLOAD_TIMEOUT_MS;/);
  assert.match(source, /xhr\.ontimeout = /);
});

test('可重试错误才重试，登录失效/4xx 不浪费次数', () => {
  const source = read('js/cloud.js');
  assert.match(source, /function retryable\(error\)/);
  assert.match(source, /return status === 0 \|\| status >= 500 \|\| status === 429 \|\| status === 408;/);
  assert.match(source, /await uploadWithRetry\(/);
});

test('每完成一个文件立刻回调，成功也报（界面才能当场打勾）', () => {
  const source = read('js/cloud.js');
  /* 成功分支必须回调，不能只在 catch 里报失败 */
  assert.match(source, /onFileDone\(\{ index, name: file\.filename \|\| '文件', ok: true/);
  assert.match(source, /onFileDone\(\{ index, name: file\.filename \|\| '文件', ok: false/);
  /* 回调要带 index：同批里可能重名（不同文件夹），靠名字匹配会打错行 */
  assert.match(source, /export async function uploadMaterialFiles\(files, ownerId, onProgress, onFileDone\)/);
});

test('大文件串行上传且不重试，避免撞上边缘函数超时', () => {
  const source = read('js/cloud.js');
  assert.match(source, /const BIG_FILE_BYTES = \d+ \* 1048576;/);
  assert.match(source, /const bigPresent = files\.some\(\(file\) => byteLen\(file\.data\) > BIG_FILE_BYTES\);/);
  assert.match(source, /Math\.min\(bigPresent \? 1 : UPLOAD_CONCURRENCY, files\.length\)/);
  assert.match(source, /const attempts = byteLen\(file\.data\) > BIG_FILE_BYTES \? 1 : UPLOAD_ATTEMPTS;/);
});

test('接口层把成功的文件落库，并与失败清单一并返回', () => {
  const source = read('js/localapi.js');
  assert.match(source, /const uploaded = result\?\.uploaded \|\| \[\];/);
  assert.match(source, /return \{ files: saved, failed: result\?\.failed \|\| \[\] \};/);
  /* 逐文件回调要透传到云端上传：少这一句，界面就只能在整批结束后才知道结果 */
  assert.match(source, /uploadMaterialFiles\(files, ownerId, opts\?\.onProgress, opts\?\.onFileDone\)/);
});

test('弹层逐文件显示状态，失败时保留成功清单并刷新背后列表', () => {
  const source = read('js/work.js');
  /* 每个文件一行状态 */
  assert.match(source, /const fileState = new Map\(\);/);
  assert.match(source, /const stateOf = \(file\) => fileState\.get\(file\) \|\| \{ state: 'idle' \};/);
  assert.match(source, /onFileDone: markFile/);
  /* 失败分支：记账成功的文件要发生在 reload 之前，reload 要发生在 return 之前 */
  const doneIdx = source.indexOf('const doneNames = new Set(');
  const failIdx = source.indexOf('if (failed.length) {');
  const tail = source.slice(doneIdx, source.indexOf('return;', failIdx) + 'return;'.length);
  assert.match(tail, /uploadedFiles\.add\(file\)/);
  assert.match(tail, /reload\(\);/);
  assert.match(tail, /点「保存」只补传这几个/);
  assert.ok(tail.indexOf('uploadedFiles.add(file)') < tail.indexOf('reload()'), 'successes must be booked before reload');
  /* 注意：上面 forEach 里有一个 `if (!doneNames.has(...)) return;`，不能拿第一个 return 比较 */
  const reloadAt = source.indexOf('reload();', failIdx);
  assert.ok(reloadAt > failIdx, 'failed branch must reload the list');
  assert.ok(source.indexOf('return;', reloadAt) > reloadAt, 'reload must happen before bailing out');
});

test('失败文案说明「已保存几个」，不再只说失败', () => {
  const source = read('js/work.js');
  assert.match(source, /已保存 \$\{doneNames\.size\} 个，\$\{failed\.length\} 个没传上去：/);
});
