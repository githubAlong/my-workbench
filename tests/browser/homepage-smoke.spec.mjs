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
    await expect(page.locator('.home-shortcut')).toHaveCount(8, { timeout: 20000 });
    await expect(page.locator('#home-grid')).toBeVisible();
    await expect(page.locator('[data-hcard]')).toHaveCount(11);

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
