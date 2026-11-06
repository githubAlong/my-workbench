import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { installBrowser } from './test-browser.mjs';

installBrowser({ href: 'http://localhost/' });

test('voice recognition requires an editable confirmation list before applying', async () => {
  const { parseVoicePhrases } = await import('../js/attvoice.js?voice-test=1');
  const columns = [
    { key: 'k_签到', label: '签到', type: 'check' },
    { key: 'k_请假', label: '请假', type: 'check' },
  ];
  const items = parseVoicePhrases('张三 语文 签到，李四 数学 病假', {
    cols: columns,
    subjects: ['语文', '数学'],
  });
  assert.equal(items.length, 2);
  assert.equal(items[0].statusKey, 'k_签到');
  assert.equal(items[1].leave, true);
  assert.equal(items[1].leaveType, '病假');

  const voiceSource = await readFile(new URL('../js/attvoice.js', import.meta.url), 'utf8');
  const attendanceSource = await readFile(new URL('../js/attendance.js', import.meta.url), 'utf8');
  assert.match(voiceSource, /识别结果（核对后再应用）/);
  assert.match(attendanceSource, /onApply:\s*\(items\)/);
});

test('OCR review is editable, deletable and only writes after confirmation', async () => {
  const source = await readFile(new URL('../js/attendance.js', import.meta.url), 'utf8');
  assert.match(source, /data-roster-name/);
  assert.match(source, /data-roster-subject/);
  assert.match(source, /data-roster-remove/);
  assert.match(source, /prepareRosterEntries\(items\)/);
  assert.match(source, /识别结果不会自动入库/);
});

test('attendance workspace uses realtime refresh without cross-table overwrite', async () => {
  const source = await readFile(new URL('../js/attendance.js', import.meta.url), 'utf8');
  assert.match(source, /registerLiveHook\(\(d\)/);
  assert.match(source, /applyRemote/);
  assert.match(source, /WB_ATTENDANCE_CONFLICT/);
  assert.doesNotMatch(source, /class:\s*'seat'/);
  assert.doesNotMatch(source, /上课表会自动筛选坐班总表/);
});

test('mobile and tablet responsive rules exist for attendance workspace', async () => {
  const css = await readFile(new URL('../css/attendance-workspace.css', import.meta.url), 'utf8');
  assert.match(css, /@media\(max-width:760px\)/);
  assert.match(css, /@media\(max-width:680px\)/);
  assert.match(css, /\.att-work-table-scroll\{max-height:65vh/);
});
