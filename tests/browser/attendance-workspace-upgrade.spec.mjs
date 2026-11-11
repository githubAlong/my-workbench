import {test,expect} from '@playwright/test';
async function open(page){
 await page.clock.install({time:new Date('2026-11-11T10:00:00+08:00')});
 await page.addInitScript(()=>{if(sessionStorage.getItem('attendance-upgrade-fixture'))return;sessionStorage.setItem('attendance-upgrade-fixture','1');const seed=JSON.stringify({seqs:{},meta:{seeded:true,rosterSeeded:1},teachers:[{id:1,name:'李老师',subject:'语文',grade:'高一',active:1}],attendance_tables:[],attendance_rows:[]});for(const key of ['wb_static_db_v1','wb_static_db_v1:user:e2e-local-only'])localStorage.setItem(key,seed);});
 await page.goto('/?e2e=1#/attendance/高一');await expect(page.locator('#aprd-roster-add-form')).toBeVisible();
}
test('新增归属年级支持手输与下拉，编辑可迁移，删除保留回收站',async({page})=>{
 await open(page);const add=page.locator('#aprd-roster-add-form');await expect(add.locator('[name="grade"]')).toHaveAttribute('list','aprd-add-grades');
 await add.locator('[name="name"]').fill('王老师');await add.locator('[name="subject"]').fill('数学');await add.locator('[name="grade"]').fill('高三实验年级');await add.locator('[type="submit"]').click();await expect(page.locator('.aprd-grade .on')).toHaveText('高三实验年级');
 const row=page.locator('.aprd-table-wrap tbody tr').filter({hasText:'王老师'});await expect(row).toContainText('高三实验年级');await row.locator('[data-edit]').click();const editor=page.locator('.aprd-dialog form');await expect(editor.locator('[name="grade"]')).toHaveValue('高三实验年级');await expect(editor.locator('[name="grade"]')).toHaveAttribute('list','aprd-editor-grade-options');await editor.locator('[name="grade"]').fill('高二');await editor.locator('[type="submit"]').click();await expect(page.locator('.aprd-grade .on')).toHaveText('高二');
 await expect(row.locator('[data-disable]')).toHaveText('删除');await row.locator('[data-disable]').click();await page.locator('[data-a="ok"]').click();await expect(row).toHaveCount(0);
 const deleted=await page.evaluate(async()=>{const {load}=await import('/js/localdb.js');return load().teachers.find(t=>t.name==='王老师')?.deleted_at});expect(deleted).toBeTruthy();
});
test('半天与小时请假、负数阻止保存且汇总显示真实单位',async({page})=>{
 await open(page);await page.locator('[data-tab="leave"]').click();await page.locator('[data-add-leave]').click();const form=page.locator('.aprd-dialog form');await form.locator('[name="type"]').selectOption('事假');await form.locator('[name="days"]').fill('-1');await form.locator('[type="submit"]').click();await expect(form).toBeVisible();expect(await form.locator('[name="days"]').evaluate(input=>input.validity.rangeUnderflow)).toBe(true);
 await form.locator('[name="days"]').fill('0.5');await form.locator('[type="submit"]').click();await expect(form).toBeHidden();await expect(page.locator('.aprd-table-wrap tbody')).toContainText('0.5天');
 await page.locator('[data-edit-leave]').click();await form.locator('[name="duration_unit"]').selectOption('hour');await form.locator('[name="days"]').fill('2');await form.locator('[type="submit"]').click();await expect(form).toBeHidden();await expect(page.locator('.aprd-table-wrap tbody')).toContainText('2小时');
 await page.locator('[data-tab="summary"]').click();await expect(page.locator('.aprd-table-wrap tbody')).toContainText('2小时');await expect(page.locator('.aprd-table-wrap tbody tr').first().locator('td').last()).toHaveText('已登记');
});
test('全天教研、分节独立、数字汇总及语音识别应用',async({page})=>{
 await page.addInitScript(()=>{window.SpeechRecognition=class{start(){const result=Object.assign([{transcript:'李老师语文坐班'}],{isFinal:true});this.onresult?.({resultIndex:0,results:[result]});}stop(){this.onend?.();}};});
 await open(page);await page.locator('#aprd-period').selectOption('0');await expect(page.locator('#aprd-start')).toHaveValue('00:00');await expect(page.locator('#aprd-end')).toHaveValue('23:59');await page.locator('[data-tab="research"]').click();
 const research=page.locator('[data-grid-person="1"][data-grid-key="research"]');await research.click();await page.locator('[data-grid-save]').click();await expect(research).toHaveText('✓');await page.locator('#aprd-period').selectOption('1');await expect(research).toHaveText('—');await page.locator('#aprd-period').selectOption('0');await expect(research).toHaveText('✓');
 await page.locator('[data-tab="summary"]').click();expect(await page.locator('.aprd-table-wrap th').allTextContents()).toEqual(['序号','姓名','学科','坐班','上课','听课','教研','请假时长','综合状态']);const row=page.locator('.aprd-table-wrap tbody tr').first();await expect(row.locator('td').nth(6)).toHaveText('1');await expect(row.locator('td').last()).toHaveText('已登记');
 await page.locator('[data-tab="seat"]').click();await page.locator('[data-workspace-voice]').click();await page.locator('#vv-mic').click();await expect(page.locator('.vv-name')).toHaveValue('李老师');await page.locator('#vv-apply').click();await expect(page.locator('[data-grid-key="sit"][data-grid-person="1"]')).toHaveText('✓');await page.locator('[data-grid-save]').click();await expect(page.locator('[data-grid-save]')).toBeEnabled();await page.reload();await page.locator('#aprd-period').selectOption('0');await page.locator('[data-tab="summary"]').click();await expect(row.locator('td').nth(3)).toHaveText('1');await expect(row.locator('td').nth(6)).toHaveText('1');await expect(row.locator('td').last()).toHaveText('已登记');
});

test('语音弹窗按 Escape 关闭时停止识别',async({page})=>{
 await page.addInitScript(()=>{window.voiceStopped=0;window.SpeechRecognition=class{start(){}stop(){window.voiceStopped++;}};});await open(page);await page.locator('[data-workspace-voice]').click();await page.locator('#vv-mic').click();await page.keyboard.press('Escape');await expect(page.locator('.vv-sheet')).toBeHidden();expect(await page.evaluate(()=>window.voiceStopped)).toBeGreaterThan(0);
});
