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
    await expect(page.locator('#side-brand')).not.toHaveClass(/home-side-profile/);
    await expect(page.locator('#side-brand')).not.toContainText('用户');

    if (viewport.width > 900) {
      await expect(page.locator('#side-brand .brand-logo svg')).toBeVisible();
    } else {
      await expect(page.locator('.sidebar')).toBeHidden();
    }
    await expect(page.locator('#side-user .side-user-label strong')).toHaveText('我的');
    await expect(page.locator('[data-hcard="profile"]')).toBeVisible({ timeout: 20000 });
    await expect(page.locator('#home-grid')).toBeVisible();
    await expect(page.locator('.home-profile-actions #teacher-layout')).toBeVisible();
    await expect(page.locator('#home-new-item')).toBeVisible();
    await expect(page.locator('#home-new-timetable')).toHaveCount(0);
    await expect(page.locator('.sidebar-foot #teacher-layout')).toHaveCount(0);
    await expect(page.locator('[data-hcard]')).toHaveCount(10);
    await expect(page.locator('[data-hcard]:visible')).toHaveCount(6);
    for (const id of ['profile', 'timeline', 'todayCourse', 'todayTodo', 'weather', 'calendar']) {
      await expect(page.locator('[data-hcard="' + id + '"]')).toBeVisible();
    }
    for (const id of ['weekLessons', 'invigilation', 'prepDeadline', 'recentNotes']) {
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
  await expect(page.locator('.me-accordion')).toHaveCount(8);
  for (const section of ['profile','workbench','account','messages','theme','wide','layout','logout']) {
    await expect(page.locator('[data-me-accordion="'+section+'"] summary')).toBeVisible();
  }
  await expect(page.locator('[data-me-accordion="profile"]')).toHaveJSProperty('open',false);
  await page.locator('[data-me-accordion="wide"] summary').click();
  await page.locator('#me-wide-toggle').click();
  await expect(page.locator('body')).toHaveClass(/is-wide/);
  await expect(page.locator('#me-wide-value')).toHaveText('已开启平铺');
  await page.locator('#me-wide-toggle').click();
  await expect(page.locator('body')).not.toHaveClass(/is-wide/);
  await expect(page.locator('#me-wide-value')).toHaveText('舒适宽度');

  await page.locator('[data-me-accordion="theme"] summary').click();
  await page.locator('#me-theme-open').click();
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


test('首页右上角布局编辑按钮可进入和退出编辑状态', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await context.newPage();
  await page.goto(`${baseURL}?e2e=1#/home`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#home-grid')).toBeVisible({ timeout: 20000 });

  const editButton = page.locator('.home-profile-actions #teacher-layout');
  await expect(editButton).toBeVisible();
  await expect(editButton).toHaveAttribute('aria-pressed', 'false');
  await expect(editButton).toContainText('编辑布局');
  await expect(page.locator('#home-new-timetable')).toHaveCount(0);
  await expect(page.locator('.sidebar-foot #teacher-layout')).toHaveCount(0);

  await editButton.click();
  await expect(page.locator('#hg-toolbar')).toBeVisible();
  await expect(editButton).toHaveAttribute('aria-pressed', 'true');
  await expect(editButton).toContainText('退出编辑');

  await editButton.click();
  await expect(page.locator('#hg-toolbar')).toBeHidden();
  await expect(editButton).toHaveAttribute('aria-pressed', 'false');
  await expect(editButton).toContainText('编辑布局');
  await context.close();
});

test('首页和工作页面共用后台品牌，首页不把品牌替换为个人资料', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await context.newPage();
  await page.goto(`${baseURL}?e2e=1#/home`, { waitUntil: 'domcontentloaded' });
  const brand = page.locator('#side-brand');
  await expect(brand.locator('.brand-name')).toHaveText('我的工作台', { timeout: 20000 });
  await expect(brand.locator('.brand-sub')).toHaveText('Workbench');
  await expect(brand).not.toHaveClass(/home-side-profile/);
  await page.locator('.sidebar [data-nav="lessons"]').click();
  await expect(page.locator('#main')).not.toBeEmpty();
  await expect(brand.locator('.brand-name')).toHaveText('我的工作台');
  await expect(brand.locator('.brand-sub')).toHaveText('Workbench');
  await expect(brand).not.toHaveClass(/home-side-profile/);
  await context.close();
});

test('个人信息页按确认稿显示字段，联系电话可编辑且保存按钮为保存', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await context.newPage();
  await page.goto(`${baseURL}?e2e=1#/profile`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.page-me-profile')).toBeVisible({ timeout: 20000 });
  await expect(page.locator('.profile-banner')).toBeVisible();
  await expect(page.locator('.profile-section-title')).toHaveText(['基本信息', '工作信息']);
  await expect(page.locator('#f-email')).toHaveCount(0);

  const gender = page.locator('#f-gender');
  await expect(gender.locator('option[value="男"]')).toHaveCount(1);
  await expect(gender.locator('option[value="女"]')).toHaveCount(1);
  await expect(gender.locator('option[value="保密"]')).toHaveCount(1);
  await expect(gender.locator('option[value="其他"]')).toHaveCount(0);

  const phone = page.locator('#f-contact_phone');
  await expect(phone).toBeEditable();
  await phone.fill('13800138000');
  await expect(phone).toHaveValue('13800138000');
  await expect(page.locator('#p-save')).toContainText('保存');
  await expect(page.locator('#p-save')).not.toContainText('保存修改');

  const areas = await page.locator('.profile-fields').evaluate(el => getComputedStyle(el).gridTemplateAreas);
  expect(areas).toContain('name gender');
  expect(areas).toContain('phone subject');
  expect(areas).toContain('title grade');
  await expect(page.locator('#f-school')).toBeVisible();
  await context.close();
});
