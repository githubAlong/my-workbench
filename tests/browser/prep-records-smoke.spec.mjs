import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

async function open(page) {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('prep-seeded')) return;
    sessionStorage.setItem('prep-seeded', '1');
    const content = 'WB_LESSON_PLAN_V1\n' + JSON.stringify({
      grade: '高一1班', target: '历史目标保留', prepare: '历史准备保留', process: '旧版正文',
    });
    const seed = JSON.stringify({
      seqs: {}, meta: { seeded: true },
      preps: [
        { id: 17, date: '2026-11-05', class_name: '高一1班', subject: '信息技术', topic: '历史备课', content, remark: '已有备注' },
        { id: 18, date: '2026-11-06', class_name: '高二3班', subject: '美术', topic: '特色课', content: '正文', prep_type: 'specialty' },
      ],
      attachments: [{ id: 2, owner_type: 'prep', owner_id: 17, name: '旧附件.txt', size: 4 }],
    });
    for (const key of ['wb_static_db_v1', 'wb_static_db_v1:user:e2e-local-only']) localStorage.setItem(key, seed);
  });
  await page.goto('/?e2e=1#/prep');
  await expect(page.locator('#prep-add')).toBeVisible();
}

test('字段顺序、备注、新建 / 编辑 / 删除与关闭按钮', async ({ page }) => {
  await open(page);
  await page.locator('#prep-add').click();
  await expect(page.locator('.lesson-plan-editor input[required]')).toHaveCount(4);
  await expect(page.locator('.lesson-plan-editor textarea')).toHaveCount(2);
  expect(await page.locator('.lp-footer button').allTextContents()).toEqual(['关闭', '保存']);
  await expect(page.locator('#lp-planDate')).toHaveValue(/^\d{4}-\d{2}-\d{2}$/);

  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('#lp-save').click();
  await expect(page.locator('.lesson-plan-sheet')).toBeVisible();

  await page.locator('#lp-subject').fill('人工智能');
  await page.locator('#lp-grade').fill('高一15班');
  await page.locator('#lp-title').fill('新建标题');
  await page.locator('#lp-process').fill('知识点、课堂练习及作业');
  await page.locator('#lp-remark').fill('第一次备课');
  await page.locator('#lp-save').click();
  await expect(page.locator('.lesson-plan-sheet')).toBeHidden();

  const row = page.locator('#lp-record-table tbody tr').filter({ hasText: '新建标题' });
  await expect(row).toContainText('第一次备课');
  await row.locator('[data-edit]').click();
  await expect(page.locator('#lp-remark')).toHaveValue('第一次备课');
  await expect(page.locator('#lp-process')).toHaveValue('知识点、课堂练习及作业');
  await page.locator('#lp-close').click();
  await expect(page.locator('.lesson-plan-sheet')).toBeHidden();

  await row.locator('[data-delete]').click();
  await page.locator('.sheet-mask [data-a="ok"]').click();
  await expect(page.locator('#lp-record-table tbody')).not.toContainText('新建标题');
});

test('旧记录安全编辑：历史 content 不丢，备注写入 remark', async ({ page }) => {
  await open(page);
  await page.locator('#lp-record-table tbody tr').filter({ hasText: '历史备课' }).locator('[data-edit]').click();
  await expect(page.locator('#lp-process')).toHaveValue('旧版正文');
  await expect(page.locator('#lp-remark')).toHaveValue('已有备注');
  await page.locator('#lp-process').fill('修改后的授课内容');
  await page.locator('#lp-remark').fill('补充备注');
  await page.locator('#lp-save').click();
  await expect(page.locator('.lesson-plan-sheet')).toBeHidden();

  const saved = await page.evaluate(async () => {
    const { api } = await import('/js/core.js');
    const rows = await api.get('/preps');
    return (rows.list || rows).find((row) => row.id === 17);
  });
  expect(saved.content).toContain('历史目标保留');
  expect(saved.content).toContain('历史准备保留');
  expect(saved.content).toContain('修改后的授课内容');
  expect(saved.remark).toBe('补充备注');
  const attachments = await page.evaluate(async () => {
    const { api } = await import('/js/core.js');
    return api.get('/attachments', { owner_type: 'prep', owner_id: '17' });
  });
  expect(attachments).toHaveLength(1);
});

test('按筛选条件批量导出 CSV，导入时套用筛选默认值', async ({ page }) => {
  await open(page);
  await page.locator('#lp-filter-subject').selectOption('信息技术');
  await expect(page.locator('#lp-record-table tbody tr')).toHaveCount(1);

  const downloaded = page.waitForEvent('download');
  await page.locator('#prep-export').click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toMatch(/^备课记录_\d{8}\.csv$/);
  const csv = await readFile(await download.path(), 'utf8');
  expect(csv.startsWith('\uFEFF')).toBe(true);
  expect(csv).toContain('备课时间,学科,年级,标题,授课内容,备注');
  expect(csv).toContain('历史备课');
  expect(csv).not.toContain('特色课');

  await page.locator('#lp-filter-subject').selectOption('化学');
  const csvImport = '备课时间,学科,年级,标题,授课内容,备注\n2026-11-21,,高三2班,有机化学,官能团,\n';
  await page.locator('#prep-import-file').setInputFiles({
    name: 'prep.csv', mimeType: 'text/csv', buffer: Buffer.from(csvImport, 'utf8'),
  });
  await page.locator('.sheet-mask [data-a="ok"]').click();
  const imported = page.locator('#lp-record-table tbody tr').filter({ hasText: '有机化学' });
  await expect(imported).toContainText('化学');
});

test('手机端：底部只有关闭 / 保存，无横向溢出', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  await page.locator('#prep-add').click();
  expect(await page.locator('.lp-footer button').allTextContents()).toEqual(['关闭', '保存']);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.locator('#lp-save')).toBeInViewport();
  await page.screenshot({ path: 'artifacts/prep-records-mobile.png', fullPage: true, animations: 'disabled' });
  await page.locator('.lesson-plan-sheet .sheet-close').click();
  await expect(page.locator('.lesson-plan-sheet')).toBeHidden();
});
