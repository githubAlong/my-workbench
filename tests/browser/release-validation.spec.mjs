import {test,expect} from '@playwright/test';

async function seed(page,extra={}) {
  // Isolated localhost-only account; all modifications stay in this browser context.
  await page.addInitScript(extra=>{
    if(sessionStorage.getItem("release-fixture-seeded")) return;
    sessionStorage.setItem("release-fixture-seeded","1");
    const db={seqs:{},meta:{seeded:true,rosterSeeded:1},teachers:[],repairs:[],courses:[],periods:[],...extra};
    const text=JSON.stringify(db);
    localStorage.setItem('wb_static_db_v1',text);
    localStorage.setItem('wb_static_db_v1:user:e2e-local-only',text);
  },extra);
}
const today=new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'});

test('维修：已修复历史记录被识别，编辑是否修好后列表和统计同步',async({page})=>{
  await seed(page,{repairs:[{id:1,date:today,item:'测试打印机',fault:'无法打印',status:'已修复',urgency:'normal'}]});
  await page.goto('/?e2e=1#/work/repairs');
  const row=page.locator('.rp-ledger-table tbody tr').filter({hasText:'测试打印机'});
  await expect(row.locator('.rp-ledger-state')).toHaveText('已修好');
  await row.locator('[data-rp-edit]').click();
  await expect(page.locator('#fx')).toHaveValue('done');
  await page.locator('#fx').selectOption('open');
  await page.locator('.sheet-mask #ok').click();
  await expect(row.locator('.rp-ledger-state')).toHaveText('未修好');
  await expect(page.locator('.rp-ledger-stat-green .rp-ledger-stat-num')).toHaveText('0');
  await row.locator('[data-rp-edit]').click();
  await page.locator('#fx').selectOption('done');
  await page.locator('.sheet-mask #ok').click();
  await expect(row.locator('.rp-ledger-state')).toHaveText('已修好');
  await expect(page.locator('.rp-ledger-stat-green .rp-ledger-stat-num')).toHaveText('1');
  await page.screenshot({path:'artifacts/release-repairs.png',fullPage:true});
});

test('考勤：四页签同名单同列，各表独立保存，花名册只读汇总',async({page})=>{
  await seed(page,{teachers:[{id:1,name:'李老师',subject:'语文',grade:'高一',active:1},
    {id:2,name:'王老师',subject:'数学',grade:'高一',active:1}]});
  await page.goto('/?e2e=1#/work/attendance/高一');
  const table=page.locator('.attendance-prd .aprd-table-wrap table');
  await expect(table.locator('tbody tr')).toHaveCount(2);
  const headers=await table.locator('th').allTextContents();
  expect(headers).toEqual(['序号','归属部门','归属年级','姓名','学科','上课','坐班','听课','教研','请假','备注','操作']);
  await expect(page.locator('[data-grid-person]')).toHaveCount(0);
  for(const type of ['seat','class','research']) {
    await page.locator('[data-tab="'+type+'"]').click();
    expect(await table.locator('th').allTextContents()).toEqual(headers);
    await expect(table.locator('tbody tr')).toHaveCount(2);
    await expect(page.locator('[data-grid-person]')).toHaveCount(12);
  }
  await page.locator('[data-tab="seat"]').click();
  const sit=page.locator('[data-grid-person="1"][data-grid-key="sit"]');
  await sit.click();
  await page.locator('[data-grid-person="1"][data-grid-key="remark"]').fill('浏览器测试坐班备注');
  await page.locator('[data-grid-save]').click();
  await expect(page.locator('#toast-box')).toContainText('本表已保存');
  await expect(page.locator('[data-grid-save]')).toBeEnabled();
  await expect(sit).toHaveText('✓');
  await page.locator('[data-tab="class"]').click();
  await expect(page.locator('[data-grid-person="1"][data-grid-key="sit"]')).toHaveText('—');
  await page.locator('[data-tab="roster"]').click();
  await expect(table.locator('tbody tr').first().locator('td').nth(6)).toHaveText('✓');
  await expect(page.locator('[data-grid-person]')).toHaveCount(0);
  await page.screenshot({path:'artifacts/release-attendance.png',fullPage:true});
});

test('课表：午休、晚二、晚四及其课程均显示，不被固定节次过滤',async({page})=>{
  await seed(page,{periods:[{id:1,period_no:1,name:'第一节',start_time:'08:00',end_time:'08:40'},
    {id:2,period_no:5.5,name:'午休',start_time:'12:20',end_time:'14:10'},
    {id:11,period_no:11,name:'晚二',start_time:'19:30',end_time:'20:10'},
    {id:13,period_no:13,name:'晚四',start_time:'21:10',end_time:'21:55'}],
    courses:[{id:1,weekday:1,period_no:11,grade:'高一',subject:'晚二测试课程',class_name:'1班',start_time:'19:30',end_time:'20:10'},
      {id:2,weekday:2,period_no:13,grade:'高一',subject:'晚四测试课程',class_name:'2班',start_time:'21:10',end_time:'21:55'}]});
  await page.goto('/?e2e=1#/work/timetable');
  await expect(page.locator('.tt-grid-table')).toBeVisible();
  await expect(page.locator('.tt-period-cell').filter({hasText:'午休'})).toHaveCount(1);
  await expect(page.locator('.tt-course-block').filter({hasText:'晚二测试课程'})).toBeVisible();
  await expect(page.locator('.tt-course-block').filter({hasText:'晚四测试课程'})).toBeVisible();
  await page.screenshot({path:'artifacts/release-timetable.png',fullPage:true});
});

test('首页和个人中心：个人名片可见，个人信息默认收起并能展开',async({page})=>{
  await seed(page);
  await page.goto('/?e2e=1#/home');
  await expect(page.locator('.home-profile-heading')).toContainText('个人名片');
  await page.goto('/?e2e=1#/me');
  const profile=page.locator('[data-me-accordion="profile"]');
  await expect(profile).toBeVisible();
  await expect(profile).toHaveJSProperty('open',false);
  await profile.locator('summary').click();
  await expect(profile).toHaveJSProperty('open',true);
});

test('导航提升为一级，三张表每位教师只选一种状态并可回到空白',async({page})=>{
  await seed(page,{teachers:[{id:1,name:'李老师',subject:'语文',grade:'高一',active:1}]});
  await page.goto('/?e2e=1#/work/attendance/高一');
  await expect(page).toHaveURL(/#\/attendance\//);
  await expect(page.locator('.sidebar [data-nav-toggle="work"]')).toHaveCount(0);
  for(const id of ['lessons','timetable','prep','repairs','attendance','invigilation','trips','notes']) {
    await expect(page.locator('.sidebar .side-nav > [data-nav="'+id+'"]')).toBeVisible();
  }
  for(const type of ['seat','class','research']) {
    await page.locator('[data-tab="'+type+'"]').click();
    const mark=key=>page.locator('[data-grid-person="1"][data-grid-key="'+key+'"]');
    for(const key of ['class','sit','listen','research']) await expect(mark(key)).toHaveText('—');
    await mark('class').click(); await expect(mark('class')).toHaveText('✓');
    await mark('class').click(); await expect(mark('class')).toHaveText('✗');
    await mark('class').click(); await expect(mark('class')).toHaveText('—');
    await mark('sit').click(); await mark('listen').click();
    await expect(mark('sit')).toHaveText('—'); await expect(mark('listen')).toHaveText('✓');
    await page.locator('[data-grid-save]').click();
    await expect(page.locator('[data-grid-save]')).toBeEnabled();
    await page.reload();
    await page.locator('[data-tab="'+type+'"]').click();
    await expect(mark('listen')).toHaveText('✓');
    await expect(mark('sit')).toHaveText('—');
    await mark('listen').click(); await mark('listen').click();
    await page.locator('[data-grid-save]').click();
    await expect(page.locator('[data-grid-save]')).toBeEnabled();
    await page.reload(); await page.locator('[data-tab="'+type+'"]').click(); await expect(mark('listen')).toHaveText('—');
  }
});

test('请假与汇总按学科筛选，统计同步且日期箭头移除',async({page})=>{
  await seed(page,{teachers:[{id:1,name:'李老师',subject:'语文',grade:'高一',active:1},{id:2,name:'王老师',subject:'数学',grade:'高一',active:1}]});
  await page.goto('/?e2e=1#/attendance/高一');
  await expect(page.locator('[data-tab="leave"]')).toHaveText('请假');
  await expect(page.locator('[data-day]')).toHaveCount(0);
  await expect(page.locator('#aprd-date')).toBeVisible();
  await page.evaluate(async today=>{const {api}=await import('/js/core.js');await api.patch('/me',{settings:{attendanceWorkspace:{leaves:[{id:1,name:'李老师',subject:'语文',start_date:today,end_date:today,days:1,type:'事假'},{id:2,name:'王老师',subject:'数学',start_date:today,end_date:today,days:1,type:'病假'}]}}});},today);
  await page.reload();
  await page.locator('[data-tab="leave"]').click();
  const rows=page.locator('.aprd-table-wrap tbody tr');
  await expect(rows).toHaveCount(2);
  await page.locator('#aprd-subject').selectOption('数学');
  await expect(rows).toHaveCount(1);await expect(rows).toContainText('王老师');
  await page.locator('#aprd-subject').selectOption('');await expect(rows).toHaveCount(2);
  await page.locator('[data-tab="summary"]').click();
  await page.locator('#aprd-subject').selectOption('数学');
  await expect(rows).toHaveCount(1);await expect(rows).toContainText('王老师');
  await expect(page.locator('.aprd-kpi').first()).toContainText('1人');
  await expect(page.locator('.aprd-kpi').last()).toContainText('1人');
  await page.locator('#aprd-subject').selectOption('');await expect(rows).toHaveCount(2);
  await expect(page.locator('.aprd-kpi').first()).toContainText('2人');
});
