import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const src = (await readFile(new URL('../js/realtime.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');

/* 曾经的 BUG：onclose 用「距连接尝试满 10 秒」当"曾经通"的判据清零 tries。
   被墙 / 表没发布的连接握手挂住从不推 phx_reply，却每轮满 10 秒后才关闭，
   于是 tries 被反复清零 → 永远走 tries===1 的 0ms 分支，控制台刷屏「0ms 后重试」。
   修法：只有 status 到过 live（收到 phx_reply）才清零。 */
test('断线清零重连次数按"是否真通过"判，不再按墙钟', () => {
  assert.match(src, /if \(st\.status === 'live'\) st\.tries = 0;/, 'onclose 按 live 状态清零');
  assert.doesNotMatch(src, /Date\.now\(\) - \(st\.openAt[^)]*\) > \d+\) st\.tries/, '不再有 openAt 墙钟清零的旧判据');
  assert.doesNotMatch(src, /markOpen|st\.openAt/, 'openAt/markOpen 这套已随之删除，不留死代码');
});

test('真正的健康信号仍由 phx_reply 把 status 转 live 时清零', () => {
  const reply = src.slice(src.indexOf("case 'phx_reply'"), src.indexOf("case 'phx_error'"));
  assert.match(reply, /st\.tries = 0;/, '收到回执才认为通，顺带清零');
  assert.match(reply, /setStatus\('live'\)/, '回执后才亮绿灯');
});

test('退避曲线不变：第一次 0ms 立即重来，之后 1s→30s 封顶', () => {
  assert.match(src, /st\.tries === 1 \? 0 :/, '保留"首次失败立即重试"的设计');
  assert.match(src, /Math\.min\(30000, 1000 \* Math\.pow\(2, Math\.min\(st\.tries - 2, 5\)\)\)/, '指数退避封顶 30 秒');
});
