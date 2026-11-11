import { test, expect } from '@playwright/test';

for (const width of [1600, 900, 390]) {
  test(`班级时间双重点、午休居中及课程状态（${width}px）`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, timezoneId: 'Asia/Shanghai' });
    const page = await context.newPage();
    await page.clock.install({ time: new Date('2026-11-10T15:36:24+08:00') });
    await page.addInitScript(() => {
      const database = { seqs: {}, meta: { seeded: true, rosterSeeded: 1 }, teachers: [], repairs: [],
        periods: [{ id: 1, period_no: 9, name: '第九节', start_time: '17:05', end_time: '17:45' },
          { id: 2, period_no: 5.5, name: '午休', start_time: '12:20', end_time: '14:10' }],
        courses: [{ id: 1, weekday: 2, period_no: 9, grade: '高二', class_name: '15班', subject: '信息技术', start_time: '17:05', end_time: '17:45' }] };
      for (const key of ['wb_static_db_v1', 'wb_static_db_v1:user:e2e-local-only']) localStorage.setItem(key, JSON.stringify(database));
      localStorage.setItem('wb_timetable_view_v1', JSON.stringify({ type: '夏令时课表', grade: '全部' }));
    });
    await page.goto((process.env.BASE_URL || 'http://127.0.0.1:4189') + '/?e2e=1#/work/timetable');
    await expect(page.locator('.tt-focus-class')).toContainText('15班');
    await expect(page.locator('.tt-focus-time')).toHaveText('17:05–17:45');
    await expect(page.locator('.tt-focus-kicker')).toHaveText('下一节课');
    await expect(page.locator('.tt-lunch-content strong')).toHaveText('12:20–14:10');
    await expect(page.locator('.tt-lunch-cell')).toHaveAttribute('colspan', '8');
    const layout = await page.evaluate(() => {
      const size = selector => parseFloat(getComputedStyle(document.querySelector(selector)).fontSize);
      const cell = document.querySelector('.tt-lunch-cell').getBoundingClientRect();
      const content = document.querySelector('.tt-lunch-content').getBoundingClientRect();
      return { classSize: size('.tt-focus-class'), timeSize: size('.tt-focus-time'), countdownSize: size('.tt-focus-countdown'),
        centered: innerWidth > 720 ? Math.abs(cell.x + cell.width / 2 - content.x - content.width / 2) < 2 : content.x >= 0 && content.right <= innerWidth,
        overflow: document.documentElement.scrollWidth > innerWidth };
    });
    expect(layout.classSize).toBe(layout.timeSize);
    expect(layout.classSize).toBeGreaterThan(layout.countdownSize);
    expect(layout.centered).toBe(true);
    expect(layout.overflow).toBe(false);
    await page.locator('#tt-add').click();
    await expect(page.locator('#tt-course-name')).toBeVisible();
    await page.locator('#tt-course-cancel').click();
    await page.clock.setSystemTime(new Date('2026-11-10T17:10:00+08:00'));
    await page.clock.runFor(1000);
    await expect(page.locator('.tt-focus-kicker')).toHaveText('正在上课');
    await expect(page.locator('.tt-focus-countdown-label')).toHaveText('距离下课');
    await page.clock.setSystemTime(new Date('2026-11-10T18:00:00+08:00'));
    await page.clock.runFor(1000);
    await expect(page.locator('.tt-focus-kicker')).toHaveText('今日课程已结束');
    await page.clock.setSystemTime(new Date('2026-11-11T08:00:00+08:00'));
    await page.clock.runFor(1000);
    await expect(page.locator('.tt-focus-kicker')).toHaveText('今日无课');
    await context.close();
  });
}

