import { test, expect } from '@playwright/test';

const baseURL = process.env.BASE_URL || 'http://127.0.0.1:4173';

test('电子备课记录：旧记录待分类、新建类型必选、两类共用同一表单', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.addInitScript(() => {
    localStorage.setItem('wb_static_db_v1', JSON.stringify({
      seqs: {},
      meta: { seeded: true },
      preps: [{
        id: 17,
        seq: 17,
        date: '2026-11-05',
        class_name: '三年级1班',
        subject: '信息技术',
        topic: 'E2E 历史备课记录',
        progress: '已完成第一部分',
        next_step: '继续准备第二部分',
        minutes: 20,
        status: 'doing',
        remark: '历史备注需要保留',
      }],
    }));
  });

  await page.goto(`${baseURL}/?e2e=1#/work/prep`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#app')).not.toBeEmpty({ timeout: 20000 });
  await expect(page.locator('#prep-add')).toBeVisible({ timeout: 20000 });
  await expect(page.locator('.prep-type-filter')).toBeVisible();
  await expect(page.locator('.prep-list-card')).toContainText('E2E 历史备课记录');
  await expect(page.locator('.prep-list-card')).toContainText('待分类');

  await page.locator('[data-ft="unclassified"]').click();
  await expect(page.locator('.prep-list-card')).toContainText('E2E 历史备课记录');

  await page.locator('#prep-add').click();
  await expect(page.locator('#p-type')).toBeVisible();
  await expect(page.locator('#p-content')).toBeVisible();
  await expect(page.locator('#p-type')).toHaveValue('');
  await page.locator('#p-topic').fill('E2E 信息课备课记录');
  await page.locator('#p-content').fill('教学目标、重点难点、课堂流程和活动设计。');

  await page.locator('#p-save').click();
  await expect(page.locator('#p-type')).toBeVisible();

  await page.locator('#p-type').selectOption('information');
  await page.locator('#p-save').click();
  await expect(page.locator('#p-type')).not.toBeVisible();
  await page.locator('[data-ft="information"]').click();
  await expect(page.locator('.prep-list-card')).toContainText('E2E 信息课备课记录');
  await expect(page.locator('.prep-list-card')).toContainText('信息课备课');
  await expect(page.locator('.prep-list-card')).toContainText('教学目标、重点难点');

  await page.locator('#prep-add').click();
  await expect(page.locator('#p-type')).toBeVisible();
  await expect(page.locator('#p-content')).toBeVisible();
  await page.locator('#p-type').selectOption('specialty');
  await page.locator('#p-topic').fill('E2E 特色课备课记录');
  await page.locator('#p-content').fill('特色课程与活动安排。');
  await page.locator('#p-save').click();
  await expect(page.locator('#p-type')).not.toBeVisible();
  await page.locator('[data-ft="specialty"]').click();
  await expect(page.locator('.prep-list-card')).toContainText('E2E 特色课备课记录');
  await expect(page.locator('.prep-list-card')).toContainText('特色课备课');

  expect(pageErrors, pageErrors.join('\n')).toEqual([]);
  await context.close();
});

test('电子备课记录页面在手机宽度下没有横向溢出', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await page.goto(`${baseURL}/?e2e=1#/work/prep`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#prep-add')).toBeVisible({ timeout: 20000 });
  const metrics = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  expect(metrics.document, JSON.stringify(metrics)).toBeLessThanOrEqual(metrics.viewport + 1);
  expect(metrics.body, JSON.stringify(metrics)).toBeLessThanOrEqual(metrics.viewport + 1);
  await context.close();
});
