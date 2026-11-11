import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isRepairTracked, summarizeRepairs, isRepairFixed, normalizeRepairStatus, repairStatusInputValue, repairStatusForSave } from '../js/repairs-domain.mjs';

const repairSource = await readFile(new URL('../js/repairs.js', import.meta.url), 'utf8');
const localdbSource = await readFile(new URL('../js/localdb.js', import.meta.url), 'utf8');
const cssSource = await readFile(new URL('../css/app.css', import.meta.url), 'utf8');

test('月份统计只纳入选择月份的记录', () => {
  const result = summarizeRepairs([
    { id: 1, date: '2026-11-03', status: 'pending' },
    { id: 2, date: '2026-11-08', status: 'done' },
    { id: 3, date: '2026-10-31', status: 'pending' },
  ], '2026-11');
  assert.equal(result.total, 2);
  assert.equal(result.fixed, 1);
  assert.equal(result.unfinished, 1);
});

test('未修好且勾选跟踪的记录进入提醒统计', () => {
  const result = summarizeRepairs([
    { id: 1, date: '2026-11-03', item: '机房电脑', status: 'pending', follow_up: 1, remark: '等待内存配件' },
    { id: 2, date: '2026-11-04', item: '投影仪', status: 'doing', follow_up: 0, remark: '已联系维修' },
  ], '2026-11');
  assert.equal(result.total, 2);
  assert.equal(result.unfinished, 2);
  assert.equal(result.tracked, 1);
  assert.deepEqual(result.reminders[0], { id: 1, item: '机房电脑', remark: '等待内存配件' });
});

test('编辑修好状态和跟踪状态后统计同步变化', () => {
  const row = { id: 1, date: '2026-11-03', status: 'pending', follow_up: 1 };
  const before = summarizeRepairs([row], '2026-11');
  row.status = 'done';
  row.follow_up = 0;
  const after = summarizeRepairs([row], '2026-11');
  assert.deepEqual([before.fixed, before.unfinished, before.tracked], [0, 1, 1]);
  assert.deepEqual([after.fixed, after.unfinished, after.tracked], [1, 0, 0]);
});

test('旧记录缺少 follow_up 时按否处理，并兼容常见勾选值', () => {
  assert.equal(isRepairTracked({}), false);
  assert.equal(isRepairTracked({ follow_up: 1 }), true);
  assert.equal(isRepairTracked({ follow_up: true }), true);
  assert.equal(isRepairTracked({ follow_up: '是' }), true);
  assert.equal(isRepairTracked({ follow_up: 0 }), false);
});

test('维修台账表头严格遵循 PRD 的十列顺序', () => {
  const headers = '<th>序号</th><th>维修日期</th><th>设备名称</th><th>位置</th><th>维修记录</th><th>报修人</th><th>是否修好</th><th>是否跟踪</th><th>备注</th><th>操作</th>';
  assert.ok(repairSource.replace(/>\s+</g, '><').includes(headers));
});

test('跟踪字段纳入本地维修记录字段白名单，四种统计颜色存在', () => {
  assert.match(localdbSource, /repairs:\s*\[[^\]]*'follow_up'/);
  for (const color of ['#2b7cd3', '#28c9a7', '#ff8822', '#f53f3f']) {
    assert.ok(cssSource.includes(color), `缺少统计卡颜色 ${color}`);
  }
});

test('维修状态支持自由输入并兼容旧状态',()=>{
 assert.equal(normalizeRepairStatus('待处理'),'pending');
 assert.equal(normalizeRepairStatus('处理中'),'doing');
 assert.equal(normalizeRepairStatus('已修好'),'done');
 assert.equal(normalizeRepairStatus('等待配件'),'等待配件');
 assert.equal(repairStatusInputValue('pending'),'待处理');
 assert.equal(repairStatusInputValue('等待配件'),'等待配件');
 assert.equal(isRepairFixed({status:'done'}),true);
 assert.equal(isRepairFixed({status:'已修好'}),true);
 assert.equal(isRepairFixed({status:'等待配件'}),false);
});
test('维修登记状态为自由文本输入框',()=>{
 assert.match(repairSource,/<input class="input" id="s"/);
 assert.doesNotMatch(repairSource,/<select class="input" id="s"/);
 assert.ok(repairSource.includes('placeholder="手动输入状态'));
});

test('截图中的已修复记录在编辑、列表和月份统计中均为已修好', () => {
  for (const status of ['已修复', '修好了', '已修好', 'done']) {
    const row = { date: '2026-11-09', status };
    assert.equal(isRepairFixed(row), true);
    assert.equal(repairStatusInputValue(status), '已修好');
    const summary = summarizeRepairs([row], '2026-11');
    assert.deepEqual([summary.fixed, summary.unfinished], [1, 0]);
  }
  for (const status of ['未修复', '尚未修好', '未完成', '等待配件']) {
    assert.equal(isRepairFixed({ status }), false);
  }
});

test('明确选择是否修好后保存并重新读取，列表与统计保持一致', () => {
  const row = { date: '2026-11-09', status: '等待配件', fixed_at: '2026-11-01' };
  row.status = repairStatusForSave(row.status, true);
  let restored = JSON.parse(JSON.stringify(row));
  assert.equal(isRepairFixed(restored), true);
  assert.equal(summarizeRepairs([restored], '2026-11').fixed, 1);
  row.status = repairStatusForSave(row.status, false);
  restored = JSON.parse(JSON.stringify(row));
  assert.equal(isRepairFixed(restored), false);
  assert.equal(summarizeRepairs([restored], '2026-11').unfinished, 1);
  assert.equal(restored.fixed_at, '2026-11-01');
  assert.equal(repairStatusForSave('等待配件', false), '等待配件');
  assert.equal(repairStatusForSave('已修复', false), 'pending');
});
