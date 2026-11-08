import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { TABLES } from '../js/localdb.js';
import {
  addPaymentPatch,
  buildInvigSummary,
  calcDurationMinutes,
  calcInvigAmount,
  parseSettlementMeta,
  removePaymentPatch,
  serializeSettlementMeta,
  settlementOf,
} from '../js/invigilation-domain.mjs';

test('监考时长由起止时间计算，并兼容跨午夜场次', () => {
  assert.equal(calcDurationMinutes('09:00', '11:30'), 150);
  assert.equal(calcDurationMinutes('23:30', '00:15'), 45);
  assert.equal(calcDurationMinutes('', '10:00'), null);
});

test('学校按分钟计价，同事代监按场次计价', () => {
  assert.equal(calcInvigAmount('school', 150, { mode: '分钟', perMinute: 0.4 }), 60);
  assert.equal(calcInvigAmount('school', 80, { mode: '场次', perSession: 72 }), 72);
  assert.equal(calcInvigAmount('school', 120, { mode: '时长', tiers: [{ max: 90, amount: 50 }, { max: 150, amount: 70 }] }), 70);
  assert.equal(calcInvigAmount('替他人', 120, { peerPerSession: 55 }), 55);
});

test('同一场可以分多次收款，剩余金额自动计算，足额后才结清', () => {
  const row = { id: 1, duty_type: '替他人', peer_name: '王老师', date: '2026-11-08', pay_amount: 100, pay_note: '' };
  const firstPatch = addPaymentPatch(row, { id: 'p1', amount: 30, paid_at: '2026-11-08T10:00:00.000Z', method: '微信' });
  const afterFirst = { ...row, ...firstPatch };
  assert.equal(settlementOf(afterFirst).paid, 30);
  assert.equal(settlementOf(afterFirst).remaining, 70);
  assert.equal(settlementOf(afterFirst).status, 'partial');
  assert.equal(afterFirst.settled_at, null);

  const secondPatch = addPaymentPatch(afterFirst, { id: 'p2', amount: 70, paid_at: '2026-11-09T10:00:00.000Z', method: '转账' });
  const afterSecond = { ...afterFirst, ...secondPatch };
  assert.equal(settlementOf(afterSecond).paid, 100);
  assert.equal(settlementOf(afterSecond).remaining, 0);
  assert.equal(settlementOf(afterSecond).status, 'done');
  assert.ok(afterSecond.settled_at);
  assert.equal(parseSettlementMeta(afterSecond.pay_note).payments.length, 2);
});

test('删除一笔收付明细后会重新计算余额，并保留原备注', () => {
  const note = '考试后转账';
  const row = {
    id: 2,
    duty_type: '他人替我',
    peer_name: '李老师',
    date: '2026-11-08',
    pay_amount: 80,
    pay_note: serializeSettlementMeta(note, [
      { id: 'p1', amount: 20, paid_at: '2026-11-08T10:00:00.000Z', method: '现金' },
      { id: 'p2', amount: 30, paid_at: '2026-11-08T11:00:00.000Z', method: '转账' },
    ]),
  };
  const patch = removePaymentPatch(row, 'p2');
  const updated = { ...row, ...patch };
  const state = settlementOf(updated);
  assert.equal(state.paid, 20);
  assert.equal(state.remaining, 60);
  assert.equal(state.status, 'partial');
  assert.equal(parseSettlementMeta(updated.pay_note).note, note);
  assert.equal(parseSettlementMeta(updated.pay_note).payments.length, 1);
});

test('旧版已到账和已结清记录保持兼容', () => {
  const school = settlementOf({ duty_type: 'school', pay_amount: 60, school_paid: 1 });
  const peer = settlementOf({ duty_type: '替他人', pay_amount: 50, settled_at: '2026-11-08T10:00:00Z' });
  assert.equal(school.paid, 60);
  assert.equal(school.status, 'done');
  assert.equal(school.legacy, true);
  assert.equal(peer.paid, 50);
  assert.equal(peer.status, 'done');
});

test('三类账分开统计，学校金额不混入同事往来净额', () => {
  const school = {
    id: 1, duty_type: 'school', pay_amount: 100,
    pay_note: serializeSettlementMeta('', [{ id: 's1', amount: 40, paid_at: '2026-11-08T10:00:00Z' }]),
  };
  const receivable = {
    id: 2, duty_type: '替他人', peer_name: '王老师', pay_amount: 80,
    pay_note: serializeSettlementMeta('', [{ id: 'r1', amount: 30, paid_at: '2026-11-08T10:00:00Z' }]),
  };
  const payable = { id: 3, duty_type: '他人替我', peer_name: '李老师', pay_amount: 50 };
  const summary = buildInvigSummary([school, receivable, payable], {});
  assert.equal(summary.school.amount, 100);
  assert.equal(summary.school.paid, 40);
  assert.equal(summary.school.unpaid, 60);
  assert.equal(summary.sub_out.open_amount, 50);
  assert.equal(summary.sub_in.open_amount, 50);
  assert.equal(summary.net.direction, 'even');
  assert.equal(summary.total, 3);
});

test('不新增数据库字段，继续使用已有 pay_note 保存逐笔收付明细', () => {
  assert.ok(TABLES.invigilations.includes('pay_note'));
  assert.ok(TABLES.invigilations.includes('settled_at'));
  assert.ok(TABLES.invigilations.includes('school_paid'));
});

test('监考页面接入新模块、计价规则支持按分钟，Service Worker 预缓存新模块', async () => {
  const [work, api, sw, css] = await Promise.all([
    readFile(new URL('../js/work.js', import.meta.url), 'utf8'),
    readFile(new URL('../js/localapi.js', import.meta.url), 'utf8'),
    readFile(new URL('../sw.js', import.meta.url), 'utf8'),
    readFile(new URL('../css/app.css', import.meta.url), 'utf8'),
  ]);
  assert.match(work, /import\('\.\/invigilation\.js'\)/);
  assert.match(api, /mode: '分钟'/);
  assert.match(api, /perMinute: Number\(body\?\.perMinute/);
  assert.match(sw, /'\.\/js\/invigilation\.js'/);
  assert.match(sw, /'\.\/js\/invigilation-domain\.mjs'/);
  assert.match(css, /\.iv-page\s*\{/);
});
