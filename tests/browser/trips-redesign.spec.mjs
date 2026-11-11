import {test,expect} from '@playwright/test';
async function open(page){
 await page.clock.install({time:new Date('2026-11-10T10:00:00+08:00')});
 await page.addInitScript(()=>{if(sessionStorage.getItem('trips-seeded'))return;sessionStorage.setItem('trips-seeded','1');const seed=JSON.stringify({seqs:{},meta:{seeded:true,rosterSeeded:1},trips:[{id:1,start_date:'2026-11-05',from_place:'学校',to_place:'教育局',reason:'送资料',companions:'李老师、王老师',is_driving:1,driver:'李老师',km:20,total_amount:140,remark:''},{id:2,start_date:'2026-10-20',to_place:'十月地点',reason:'会议',is_driving:0,total_amount:50}],trip_items:[{id:1,trip_id:1,date:'2026-11-05',kind:'transport',amount:30,note:'车票',has_invoice:1}],attachments:[]});for(const key of ['wb_static_db_v1','wb_static_db_v1:user:e2e-local-only'])localStorage.setItem(key,seed);});
 await page.goto('/?e2e=1#/trips');await expect(page.locator('.trips-table')).toBeVisible();
}
const stats=page=>page.locator('.trips-stat b');
test('出差十二列表格、明细、月度统计及导出',async({page})=>{
 await open(page);
 expect(await page.locator('.trips-table th').allTextContents()).toEqual(['日期','出发地','目的地','出差事由','出差人员','是否开车','开车人','公里数','里程费','合计金额','备注','操作']);
 expect(await stats(page).allTextContents()).toEqual(['1','20','20','140']);
 await expect(page.locator('.trips-page')).not.toContainText(/补贴|实报费用|保存草稿/);
 await page.locator('[data-action="detail"]').click();await expect(page.locator('.trip-details')).toContainText('车票');await expect(page.locator('.trip-details')).not.toContainText('补贴');await page.locator('.trip-simple .sheet-close').click();
 await page.locator('[data-month="-1"]').click();await expect(page.locator('#trips-month-label')).toHaveText('2026年10月');await expect(page.locator('.trips-table tbody')).toContainText('十月地点');expect(await stats(page).allTextContents()).toEqual(['1','0','0','50']);
 await page.locator('[data-month="1"]').click();
 const downloaded=page.waitForEvent('download');await page.locator('#trips-export').click();expect((await downloaded).suggestedFilename()).toBe('出差记录-2026-11.csv');
 await page.screenshot({path:'artifacts/trips-desktop.png',fullPage:true,animations:'disabled'});
});
test('必填校验、开车联动、手动金额、取消、新增编辑删除',async({page})=>{
 await open(page);await page.locator('#trips-add').click();
 await expect(page.locator('#trip-drive-group')).toBeHidden();await expect(page.locator('#trip-start_date')).toHaveValue('2026-11-10');
 await page.locator('[data-trip-submit]').click();await expect(page.locator('#trip-error-to_place')).toHaveText('请填写出差目的地');
 await page.locator('#trip-to_place').fill('培训中心');await page.locator('#trip-reason').fill('教师培训');
 await page.locator('#trip-is_driving').selectOption('1');await expect(page.locator('#trip-drive-group')).toBeVisible();
 await page.locator('[data-trip-submit]').click();await expect(page.locator('#trip-error-driver')).toHaveText('请填写驾驶员姓名');
 await page.locator('#trip-driver').fill('王老师');await page.locator('#trip-km').fill('35.5');await page.locator('#trip-total_amount').fill('123.45');
 await page.locator('#trip-is_driving').selectOption('0');await expect(page.locator('#trip-km')).toHaveValue('');await expect(page.locator('#trip-driver')).toHaveValue('');await expect(page.locator('#trip-total_amount')).toHaveValue('123.45');
 await page.evaluate(()=>{window.tripPdf='';window.open=()=>({document:{open(){},write(html){window.tripPdf=html},close(){}},focus(){},setTimeout(){}})});
 await page.locator('[data-trip-pdf]').click();expect(await page.evaluate(()=>window.tripPdf)).toContain('123.45');expect(await page.evaluate(()=>window.tripPdf)).not.toContain('补贴');
 await page.locator('[data-trip-submit]').click();await expect(page.locator('.trip-simple')).toBeHidden();expect(await stats(page).allTextContents()).toEqual(['2','20','20','263.45']);
 const row=page.locator('.trips-table tbody tr').filter({hasText:'培训中心'});
 await row.locator('[data-action="edit"]').click();await page.locator('#trip-total_amount').fill('999');await page.locator('[data-trip-cancel]').click();await expect(row).toContainText('¥123.45');
 await row.locator('[data-action="edit"]').click();await page.locator('#trip-total_amount').fill('80');await page.locator('[data-trip-submit]').click();await expect(page.locator('.trip-simple')).toBeHidden();expect(await stats(page).allTextContents()).toEqual(['2','20','20','220']);
 await row.locator('[data-action="delete"]').click();await page.locator('[data-a="ok"]').click();await expect(row).toHaveCount(0);expect(await stats(page).allTextContents()).toEqual(['1','20','20','140']);
});
test('CSV 预校验导入和手机端居中、背景锁定及无页面横向溢出',async({page})=>{
 await page.setViewportSize({width:390,height:844});await open(page);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.locator('#trips-import').click();await page.locator('#trip-import-file').setInputFiles({name:'出差.csv',mimeType:'text/csv',buffer:Buffer.from('日期,目的地,出差事由,是否开车,合计金额\n2026-11-09,培训点,研修,否,30.50')});
 await expect(page.locator('#trip-import-status')).toContainText('已校验 1 条');await page.locator('[data-confirm]').click();await expect(page.locator('.trip-simple')).toBeHidden();expect(await stats(page).allTextContents()).toEqual(['2','20','20','170.5']);
 await page.locator('#trips-add').click();await expect(page.locator('.sheet-mask:has(.trip-simple)')).toHaveCSS('opacity','1');
 expect(await page.evaluate(()=>document.body.style.overflow)).toBe('hidden');
 const rect=await page.locator('.trip-simple').boundingBox();expect(Math.abs(rect.x+rect.width/2-195)).toBeLessThan(2);expect(Math.abs(rect.y+rect.height/2-422)).toBeLessThan(3);
 await expect(page.locator('[data-trip-submit]')).toBeInViewport();await page.screenshot({path:'artifacts/trips-mobile-dialog.png',fullPage:true,animations:'disabled'});
 await page.locator('[data-trip-cancel]').click();expect(await page.evaluate(()=>document.body.style.overflow)).not.toBe('hidden');
});
