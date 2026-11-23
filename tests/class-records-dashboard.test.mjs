import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../js/class-records.js', import.meta.url), 'utf8');
const localdb = await readFile(new URL('../js/localdb.js', import.meta.url), 'utf8');
const localapi = await readFile(new URL('../js/localapi.js', import.meta.url), 'utf8');
const sql = await readFile(new URL('../step_class_records.sql', import.meta.url), 'utf8');

test('上课记录支持点击切换月份，可翻到上一个月、下一个月和最近一年', () => {
  for (const marker of [
    'id="cr-month-prev"', 'id="cr-month-next"', 'id="cr-month-pick"',
    'id="cr-month-input"', 'id="cr-month-quick"', 'id="cr-month-today"',
    'monthShift(month, -1)', 'monthShift(month, 1)', 'recentMonths()', 'currentMonthKey()',
  ]) assert.ok(source.includes(marker), 'missing month switch marker: ' + marker);
  assert.match(source, /rowMonth\(r\) !== month\) return false/);
  assert.match(source, /rows\.filter\(\(r\) => rowMonth\(r\) === month\)/);
  assert.ok(source.includes('上课记录统计_'));
});

test('统计区列出当月总次数与上课类型（含假期/考试/其他），方便月底核对课时', () => {
  for (const marker of [
    'id="cr-month-total"', 'id="cr-month-normal"', 'id="cr-month-isub"',
    'id="cr-month-subme"', 'id="cr-month-swap"', 'id="cr-month-fee"',
  ]) assert.ok(source.includes(marker), 'missing KPI card: ' + marker);
  for (const label of ['正常上课', '我代别人上课', '别人代我上课', '换课', '假期', '考试', '其他']) {
    assert.ok(source.includes("'" + label + "'"), 'missing lesson type label: ' + label);
  }
});

test('列表列顺序与新增表单字段顺序完全一致', () => {
  assert.match(source, /<th>上课日期<\/th><th>上课年级<\/th><th>上课班级<\/th><th>节次<\/th><th>学科<\/th><th>上课类型<\/th><th>上课人<\/th><th>代课人<\/th><th>课时费（元）<\/th><th>支付状态<\/th><th>备注说明<\/th><th>操作<\/th>/);
  const ids = ['cr-date', 'cr-grade', 'cr-class', 'cr-period', 'cr-subject', 'cr-type', 'cr-teacher', 'cr-substitute-person', 'cr-money', 'cr-status', 'cr-remark'];
  for (const id of ids) assert.ok(source.includes('id="' + id + '"'), 'missing form field: ' + id);
  assert.match(source, /\['上课日期', '上课年级', '上课班级', '节次', '学科', '上课类型', '上课人', '代课人', '课时费（元）', '支付状态', '备注说明'\]/);
});

test('只有上课日期、上课年级、上课班级是必填项', () => {
  assert.match(source, /if \(!date\) throw new Error\('请填写上课日期'\)/);
  assert.match(source, /if \(!grade\) throw new Error\('请填写上课年级'\)/);
  assert.match(source, /if \(!className\) throw new Error\('请填写上课班级'\)/);
  assert.doesNotMatch(source, /请选择上课类型|请填写学科/);
  assert.match(localapi, /class_records: \[\['class_month', '请填写上课日期'\], \['grade', '请填写上课年级'\], \['class_name', '请填写上课班级'\]\]/);
});

test('上课类型自动带出课时费与支付状态默认值，新类型假期/考试/其他统一为 0 课时费 + 已支付', () => {
  assert.match(source, /正常上课: \{ amount: 30, status: '学校支付' \}/);
  assert.match(source, /我代别人上课: \{ amount: 40, status: '待支付' \}/);
  assert.match(source, /换课: \{ amount: 0, status: '已支付' \}/);
  assert.match(source, /假期: \{ amount: 0, status: '已支付' \}/);
  assert.match(source, /考试: \{ amount: 0, status: '已支付' \}/);
  assert.match(source, /type\.addEventListener\('input', applyTypeDefaults\)/);
  assert.doesNotMatch(source, /swap: \{ amount: 0, status: '无需支付' \}/);
  assert.ok(!source.includes('无需支付') || source.includes("status === '无需支付'"),
    '无需支付 不应出现在 PAY_OPTIONS 或新表单默认值中（statusClass 历史兼容除外）');
  for (const status of ['学校支付', '待支付', '已支付', '未支付']) {
    assert.ok(source.includes("'" + status + "'"), 'missing pay status option: ' + status);
  }
});

test('支付状态一个状态一种颜色：同色就等于列里看不出谁没结', () => {
  const body = /const statusClass = \(status\) => \{([\s\S]*?)\};/.exec(source)[1];
  const classes = {};
  for (const status of ['已支付', '学校支付', '待支付', '未支付', '无需支付', '未填写']) {
    const found = new RegExp("status === '" + status + "'\\) return '(\\w+)'").exec(body);
    assert.ok(found, 'statusClass 漏了「' + status + '」');
    classes[status] = found[1];
  }
  /* 手填的自由值（课时支付状态已放开，见 20261109165000 迁移）走兜底分支。 */
  const returns = [...body.matchAll(/return '(\w+)'/g)].map((m) => m[1]);
  assert.equal(returns.length, Object.keys(classes).length + 1, 'statusClass 的分支数对不上');
  classes['自定义值'] = returns[returns.length - 1];
  assert.equal(new Set(Object.values(classes)).size, Object.keys(classes).length, '有状态共用了同一个 class：' + JSON.stringify(classes));
  const colors = {};
  for (const cls of Object.values(classes)) {
    const rule = new RegExp('\\.cr-status\\.' + cls + '\\{([^}]*)\\}').exec(source);
    assert.ok(rule, 'CSS 里缺少 .cr-status.' + cls + ' 的配色');
    colors[cls] = /color:(?:var\([^,]+,\s*)?(#[0-9a-f]{3,6})/i.exec(rule[1])[1];
  }
  assert.equal(new Set(Object.values(colors)).size, Object.keys(colors).length, '有状态用了同一个字色：' + JSON.stringify(colors));
});

test('上课记录首列是序号：跟着筛选和分页连续排，翻页不断号', () => {
  assert.match(source, /<thead><tr><th>序号<\/th><th>上课日期<\/th>/);
  assert.match(source, /visible\.map\(\(r, i\) =>/);
  assert.match(source, /const no = \(page - 1\) \* pageSize \+ i \+ 1;/);
  assert.match(source, /'<td class="cr-no">' \+ no \+ '<\/td>' \+\s*'<td>' \+ esc\(classTime\.date \|\| '—'\)/);
  /* 多一列，两处空态的 colspan 必须一起变 13，否则空态短一列、表格右边漏缝。 */
  assert.deepEqual(source.match(/colspan="\d+"/g), ['colspan="13"', 'colspan="13"']);
  /* 序号只是屏幕上的位置号，不进 COLUMNS —— 导出 CSV 的列仍然和新增表单一致。 */
  assert.doesNotMatch(source, /const COLUMNS = \['序号'/);
});

test('查看、编辑、删除是三个独立操作，打印操作已移除', () => {
  for (const marker of ['data-view=', 'data-edit=', 'data-delete=', 'openViewer', 'openEditor', 'removeRow', 'id="cr-view-close"', 'id="cr-cancel"']) {
    assert.ok(source.includes(marker), 'missing row action: ' + marker);
  }
  for (const removed of ['data-print=', 'printRow', '打印本条记录', '查看/编辑', 'cr-print-current']) {
    assert.ok(!source.includes(removed), 'print action should be gone: ' + removed);
  }
});

test('上课年级与上课人字段已登记到本地表结构和建表脚本', () => {
  assert.match(localdb, /class_records: \[[^\]]*'grade'[^\]]*'teacher'/);
  assert.match(sql, /grade text,\s*teacher text,/);
});
