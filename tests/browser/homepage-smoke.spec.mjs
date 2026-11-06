import { test, expect } from '@playwright/test';

const baseURL = process.env.BASE_URL || 'http://127.0.0.1:4173';

for (const viewport of [
  { name: 'desktop', width: 1440, height: 1000 },
  { name: 'tablet', width: 900, height: 1000 },
  { name: 'mobile', width: 390, height: 844 },
]) {
  test(`应用启动与页面无横向溢出（${viewport.name}）`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    await page.goto(`${baseURL}?e2e=1`, { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveTitle(/教师个人工作台/);
    await expect(page.locator('#app')).not.toBeEmpty({ timeout: 20000 });
    await expect(page.locator('#side-brand .brand-name')).toHaveText('我的工作台');
    await expect(page.locator('#side-brand .brand-sub')).toHaveText('Workbench');
    if (viewport.width > 900) {
      await expect(page.locator('#side-brand .brand-logo svg')).toBeVisible();
    } else {
      await expect(page.locator('.sidebar')).toBeHidden();
    }
    await expect(page.locator('#side-user .side-user-label strong')).toHaveText('我的');
    await expect(page.locator('[data-hcard="profile"]')).toBeVisible({ timeout: 20000 });
    await expect(page.locator('#home-grid')).toBeVisible();
    await expect(page.locator('[data-hcard]')).toHaveCount(11);
    await expect(page.locator('[data-hcard]:visible')).toHaveCount(5);
    for (const id of ['profile', 'todayCourse', 'todayTodo', 'weather', 'calendar']) {
      await expect(page.locator('[data-hcard="' + id + '"]')).toBeVisible();
    }
    for (const id of ['timeline', 'dailyQuote', 'weekLessons', 'invigilation', 'prepDeadline', 'recentNotes']) {
      await expect(page.locator('[data-hcard="' + id + '"]')).toBeHidden();
    }
    await expect(page.locator('#wx-card')).toBeVisible();
    await expect(page.locator('#today-courses')).toBeVisible();
    await expect(page.locator('#today-items')).toBeVisible();
    await expect(page.locator('#cal-grid')).toBeVisible();

    const metrics = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      document: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
      appText: document.querySelector('#app')?.innerText?.trim().slice(0, 120) || '',
    }));
    expect(metrics.document, JSON.stringify(metrics)).toBeLessThanOrEqual(metrics.viewport + 1);
    expect(metrics.body, JSON.stringify(metrics)).toBeLessThanOrEqual(metrics.viewport + 1);
    expect(pageErrors, pageErrors.join('\n')).toEqual([]);

    await page.screenshot({ path: `artifacts/homepage-${viewport.name}.png`, fullPage: true });
    await context.close();
  });
}


test('我的页面统一管理外观与布局设置，侧栏不再重复显示', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await context.newPage();
  await page.goto(`${baseURL}?e2e=1#/me`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.page-me-home')).toBeVisible({ timeout: 20000 });

  await expect(page.locator('#side-user')).toHaveCount(1);
  for (const id of ['side-theme', 'side-wide', 'side-layout']) {
    await expect(page.locator('#' + id)).toHaveCount(0);
  }
  await expect(page.locator('.me-home-section')).toHaveCount(1);
  await expect(page.locator('.me-home-section-head')).toHaveCount(0);

  for (const action of ['profile', 'workbench-settings', 'account-settings', 'messages', 'theme', 'wide', 'reset-layout']) {
    await expect(page.locator('[data-act="' + action + '"]')).toBeVisible();
  }
  await expect(page.locator('[data-act="theme"]')).toContainText('主题外观');
  await expect(page.locator('[data-act="messages"]')).toContainText('消息中心');

  await page.locator('[data-act="wide"]').click();
  await expect(page.locator('body')).toHaveClass(/is-wide/);
  await expect(page.locator('#me-wide-value')).toHaveText('开');
  await page.locator('[data-act="wide"]').click();
  await expect(page.locator('body')).not.toHaveClass(/is-wide/);
  await expect(page.locator('#me-wide-value')).toHaveText('关');

  await page.locator('[data-act="theme"]').click();
  await expect(page.locator('[data-theme-id="ocean"]')).toBeVisible();
  await page.locator('[data-theme-id="ocean"]').click();
  await expect(page.locator('#me-theme-value')).toHaveText('海洋蓝');

  const metrics = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  expect(metrics.document, JSON.stringify(metrics)).toBeLessThanOrEqual(metrics.viewport + 1);
  expect(metrics.body, JSON.stringify(metrics)).toBeLessThanOrEqual(metrics.viewport + 1);
  await context.close();
});
