import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/* 教材上传「进度 100% 却一直显示正在上传」的回归卡子。
   三个必须同时成立的不变量：
   1. 单个文件失败不能整批抛出（成功的文件已经进了 storage，重试不能重传一遍）；
   2. 请求必须有超时，否则卡死的连接永远不 settle；
   3. 失败要在弹层里留下文字，不能只靠一个 3 秒就消失的 toast。 */

const read = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('云端上传按文件独立成败，返回 { uploaded, failed }', () => {
  const source = read('js/cloud.js');
  assert.match(source, /return \{\s*uploaded: results\.filter\(Boolean\),\s*failed: failures/);
  assert.match(source, /const failures = new Array\(files\.length\)\.fill\(null\);/);
  assert.match(source, /catch \(error\) \{\s*failures\[index\] = error;/);
  /* 失败文件也要把字节数记账，否则总进度永远差一截 */
  assert.match(source, /doneBytes\[index\] = byteLen\(files\[index\]\.data\);/);
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

test('接口层把成功的文件落库，并与失败清单一并返回', () => {
  const source = read('js/localapi.js');
  assert.match(source, /const uploaded = result\?\.uploaded \|\| \[\];/);
  assert.match(source, /return \{ files: saved, failed: result\?\.failed \|\| \[\] \};/);
});

test('弹层只把成功的文件记账，失败时留在弹层里说明', () => {
  const source = read('js/work.js');
  assert.match(source, /files\.forEach\(file => \{ if \(doneNames\.has\(file\.name\)\) uploadedFiles\.add\(file\); \}\);/);
  assert.match(source, /upBox\.classList\.add\('is-error'\);/);
  assert.match(source, /点「保存」只补传失败的这几个。/);
});
