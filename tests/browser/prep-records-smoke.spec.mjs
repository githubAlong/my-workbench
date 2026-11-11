import {test,expect} from '@playwright/test';
async function open(page) {
  await page.addInitScript(()=>{
    if(sessionStorage.getItem('prep-seeded'))return;
    sessionStorage.setItem('prep-seeded','1');
    const content='WB_LESSON_PLAN_V1\n'+JSON.stringify({grade:'高一1班',target:'历史目标保留',prepare:'历史准备保留',process:'旧版正文'});
    const seed=JSON.stringify({seqs:{},meta:{seeded:true},preps:[{id:17,date:'2026-11-05',class_name:'高一1班',subject:'信息技术',topic:'历史备课',content},{id:18,date:'2026-11-06',class_name:'高二3班',subject:'美术',topic:'特色课',content:'正文',prep_type:'specialty'}],attachments:[{id:2,owner_type:'prep',owner_id:17,name:'旧附件.txt',size:4}]});
    for(const key of ['wb_static_db_v1','wb_static_db_v1:user:e2e-local-only'])localStorage.setItem(key,seed);
  });
  await page.goto('/?e2e=1#/prep');
  await expect(page.locator('#prep-add')).toBeVisible();
}

test('精简备课：必填、自定义类型、新建、回读、分类和删除',async({page})=>{
  await open(page);
  await page.locator('#prep-add').click();
  await expect(page.locator('.lesson-plan-editor textarea')).toHaveCount(1);
  await expect(page.locator('.lesson-plan-editor input[required]')).toHaveCount(5);
  await expect(page.locator('#lp-target,#lp-prepare,#lp-keyPoint,#lp-hardPoint')).toHaveCount(0);
  expect(await page.locator('#lp-planDate').inputValue()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  page.once('dialog',d=>d.accept());await page.locator('#lp-save').click();
  await expect(page.locator('.lesson-plan-sheet')).toBeVisible();
  for(const[id,value]of Object.entries({'lp-prep-type':'自定义实验课','lp-subject':'人工智能','lp-grade':'高一15班','lp-title':'新建课题','lp-process':'知识点、课堂练习及作业'}))await page.locator('#'+id).fill(value);
  await page.locator('#lp-save').click();await expect(page.locator('.lesson-plan-sheet')).toBeHidden();
  const row=page.locator('#lp-record-table tbody tr').filter({hasText:'新建课题'});
  await expect(row).toContainText('自定义实验课');
  await page.locator('#lp-type-filter').selectOption('自定义实验课');await expect(page.locator('#lp-record-table tbody tr')).toHaveCount(1);
  await row.locator('[data-edit]').click();await expect(page.locator('#lp-prep-type')).toHaveValue('自定义实验课');await expect(page.locator('#lp-process')).toHaveValue('知识点、课堂练习及作业');
  await page.locator('#lp-save').click();await expect(page.locator('.lesson-plan-sheet')).toBeHidden();
  await row.locator('[data-delete]').click();await page.locator('.sheet-mask [data-a="ok"]').click();await expect(page.locator('#lp-record-table tbody')).not.toContainText('新建课题');
});

test('旧记录安全编辑；PDF 和图片只导出精简字段',async({page})=>{
  await open(page);
  await page.locator('#lp-record-table tbody tr').filter({hasText:'历史备课'}).locator('[data-edit]').click();
  await page.locator('#lp-prep-type').fill('信息课备课');
  await expect(page.locator('#lp-process')).toHaveValue('旧版正文');
  await page.evaluate(()=>{
    window.exportHtml='';window.exportText=[];
    window.open=()=>({document:{open(){},write(html){window.exportHtml=html},close(){}},focus(){},setTimeout(){}});
    const fill=CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText=function(text,...args){window.exportText.push(text);return fill.call(this,text,...args)};
  });
  await page.locator('#lp-pdf').click();const pdf=await page.evaluate(()=>window.exportHtml);
  expect(pdf).toContain('本节课授课内容');expect(pdf).toContain('信息课备课');expect(pdf).toContain('上课日期');expect(pdf).not.toMatch(/教学目标|教学准备|重难点|板书设计/);
  const downloaded=page.waitForEvent('download');await page.locator('#lp-image').click();expect((await downloaded).suggestedFilename()).toMatch(/\.png$/);
  const image=await page.evaluate(()=>window.exportText.join(' '));expect(image).toContain('本节课授课内容');expect(image).not.toMatch(/教学目标|教学准备|重难点|板书设计/);
  await page.locator('#lp-process').fill('修改后的授课内容');await page.locator('#lp-save').click();await expect(page.locator('.lesson-plan-sheet')).toBeHidden();
  const saved=await page.evaluate(async()=>{const {api}=await import('/js/core.js');const rows=await api.get('/preps');return (rows.list||rows).find(row=>row.id===17)});
  expect(saved.prep_type).toBe('information');expect(saved.content).toContain('历史目标保留');expect(saved.content).toContain('历史准备保留');expect(saved.content).toContain('修改后的授课内容');
  const attachments=await page.evaluate(async()=>{const {api}=await import('/js/core.js');return api.get('/attachments',{owner_type:'prep',owner_id:'17'})});expect(attachments).toHaveLength(1);
});

test('手机端精简弹窗、按钮顺序和关闭',async({page})=>{
  await page.setViewportSize({width:390,height:844});await open(page);await page.locator('#prep-add').click();
  expect(await page.locator('.lp-footer button').allTextContents()).toEqual(['导入文件','图片识别(OCR)','导出PDF','导出图片','生成备课记录']);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await expect(page.locator('.sheet-mask:has(.lp-simple-editor)')).toHaveCSS('opacity','1');
  await expect(page.locator('#lp-save')).toBeInViewport();
  await page.screenshot({path:'artifacts/prep-simple-integrated-mobile.png',fullPage:true,animations:'disabled'});
  await page.locator('.lesson-plan-sheet .sheet-close').click();await expect(page.locator('.lesson-plan-sheet')).toBeHidden();
});
