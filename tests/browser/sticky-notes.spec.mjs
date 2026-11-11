import { test, expect } from '@playwright/test';

for (const width of [1600, 900, 390]) {
  test(`便签确认搜索、状态、编辑及一级导航（${width}px）`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width, height: 1050 } });
    const page = await context.newPage();
    await page.addInitScript(() => {
      const todos = [
        { id: 1, title: '周末整理衣柜', status: 'todo' },
        { id: 2, title: '买牛奶', content: '周末出门时买', status: 'todo' },
        { id: 3, title: '整理周末照片', status: 'doing' },
        { id: 4, title: '周末取快递', status: 'done' },
        { id: 5, title: '给妈妈打电话', status: 'todo' },
      ];
      const database = { seqs: {}, meta: { seeded: true, rosterSeeded: 1 }, teachers: [], todos };
      localStorage.setItem('wb_static_db_v1', JSON.stringify(database));
    });
    const base = process.env.BASE_URL || 'http://127.0.0.1:4189';
    await page.goto(base + '/?e2e=1#/daily/notes');
    await expect(page.locator('.sticky-card')).toHaveCount(5);
    await expect(page.locator('.sidebar [data-nav-toggle="materials"]')).toHaveCount(0);
    for (const id of ['selfstudy', 'textbook', 'pick', 'mystery']) await expect(page.locator(`.sidebar [data-nav="${id}"]`)).toHaveCount(1);
    await expect(page.locator('.sidebar [data-nav="daily"]')).toContainText('便签');
    await page.locator('#sticky-query').fill('周末');
    await expect(page.locator('.sticky-card')).toHaveCount(5);
    await page.locator('.sticky-search button[type="submit"]').click();
    await expect(page.locator('.sticky-card')).toHaveCount(4);
    await expect(page.locator('.sticky-card mark')).toHaveCount(4);
    await page.locator('#sticky-query').fill('没有此内容');
    await page.locator('#sticky-query').press('Enter');
    await expect(page.locator('.sticky-card')).toHaveCount(0);
    await page.locator('#sticky-reset').click();
    await expect(page.locator('.sticky-card')).toHaveCount(5);
    await page.locator('#sticky-input').fill('买水果\n苹果两斤');
    await page.locator('#sticky-input').press('Control+Enter');
    const note = page.locator('.sticky-card').filter({ has: page.locator('h3', { hasText: '买水果' }) });
    await expect(note).toContainText('苹果两斤');
    await page.locator('#sticky-input').fill('尚未提交的草稿');
    await note.locator('select').selectOption('doing');
    await expect(page.locator('[data-note-column="doing"]').locator(note)).toHaveCount(1);
    await expect(page.locator('#sticky-input')).toHaveValue('尚未提交的草稿');
    if (width <= 720) await page.locator('[data-note-tab="doing"]').click();
    await note.locator('summary').click();
    await note.locator('[data-note-edit]').click();
    await page.locator('#sticky-edit-title').fill('已编辑的便签');
    await page.locator('.sticky-editor [data-save]').click();
    await expect(page.locator('.sticky-editor')).toBeHidden();
    const edited = page.locator('.sticky-card').filter({ hasText: '已编辑的便签' });
    await edited.locator('summary').click();
    await edited.locator('[data-note-delete]').click();
    await page.locator('.sheet-mask [data-a="ok"]').click();
    await expect(edited).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.goto(base + '/?e2e=1#/materials/pick');
    await page.waitForURL('**#/pick');
    await expect(page.locator('#materials-body')).toBeVisible();
    await expect(page.locator('.sidebar [data-nav="pick"]')).toHaveClass(/active/);
    await context.close();
  });
}

