/* 登录链路端到端测试：真浏览器、真两个上下文（电脑 / 手机）。
   验证的不是接口能不能返回 200，而是「一个人在电脑上开扫码，另一个人在手机上扫码确认，
   电脑上就真的登进去」这件事整体成立。

   覆盖：扫码登录成功、拒绝、过期、未登录手机的回跳、以及四个传统登录入口的回归。

   用法：
     node tools/e2e-auth.mjs
     BASE=http://localhost:3000 TEST_PHONE=13900000001 TEST_PASS=test123456 node tools/e2e-auth.mjs

   依赖 playwright（全局或本地装都行）。找不到时按下面的顺序退让，
   免得换个机器就因为写死了一个绝对路径而跑不起来。 */
async function loadChromium() {
  const candidates = [
    'playwright',
    'playwright-core',
    '/root/.nvm/versions/node/v22.13.1/lib/node_modules/playwright/index.mjs',
  ];
  const errs = [];
  for (const c of candidates) {
    try { return (await import(c)).chromium; } catch (e) { errs.push(`${c}: ${e.code || e.message}`); }
  }
  console.error('找不到 playwright，先装一下：\n  npm i -D playwright  或  npm i -g playwright\n');
  console.error(errs.join('\n'));
  process.exit(2);
}
const chromium = await loadChromium();

const BASE = process.env.BASE || 'http://localhost:3000';
const ok = [];
const bad = [];
function check(name, cond, extra = '') {
  (cond ? ok : bad).push(name + (extra ? ` — ${extra}` : ''));
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`);
}

const browser = await chromium.launch();

/* 电脑：桌面视口 */
const pc = await browser.newContext({ viewport: { width: 1280, height: 900 } });
/* 手机：iPhone 尺寸，UA 也换成 iPhone，好让后端 guessDevice 认得出来 */
const mb = await browser.newContext({
  viewport: { width: 390, height: 844 },
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  isMobile: true, hasTouch: true,
});

const pcPage = await pc.newPage();
const mbPage = await mb.newPage();
const errs = [];
for (const [tag, p] of [['pc', pcPage], ['mb', mbPage]]) {
  p.on('pageerror', (e) => errs.push(`${tag} pageerror: ${e.message} :: ${(e.stack || '').split('\n').slice(1, 4).join(' | ')}`));
  p.on('console', (m) => { if (m.type() === 'error') errs.push(`${tag} console: ${m.text().slice(0, 200)}`); });
}

const phone = process.env.TEST_PHONE || '13900000001';
const pass = process.env.TEST_PASS || 'test123456';

try {
  /* ========== 1. 电脑打开登录页，切到扫码 tab，二维码真的画出来了 ========== */
  await pcPage.goto(BASE + '/#/login', { waitUntil: 'networkidle' });
  await pcPage.waitForTimeout(800);

  /* 监听要挂在「切到扫码 tab」之前：轮询是 2 秒一次，挂晚了就截不到第一条，
     虽然还能等第二次，但没必要跟时间赛跑。 */
  const seenIds = [];
  pcPage.on('request', (r) => {
    const mm = r.url().match(/\/api\/auth\/qr\/([0-9a-f]{32})/);
    if (mm && !seenIds.includes(mm[1])) seenIds.push(mm[1]);
  });

  const qrTab = pcPage.locator('.auth-tabs button', { hasText: '扫码' }).first();
  if (await qrTab.count()) await qrTab.click();
  else {
    // 没有显式 tab 时，登录页默认可能不是扫码，找找有没有入口
    const alt = pcPage.locator('[data-auth="qr"], .auth-alt + * >> text=扫码登录').first();
    if (await alt.count()) await alt.click();
  }
  await pcPage.waitForTimeout(1200);

  /* 关键：页面上显示的是它自己 POST 建的那张票据，脚本再新建一张就是另一张了。
     靠监听轮询请求把页面真实使用的 id 截下来，后面全程用它。 */
  await pcPage.waitForTimeout(2600);   // 等至少一次轮询
  const pageQrId = seenIds[0] || '';

  const svgCount = await pcPage.locator('#qr-svg svg').count();
  check('二维码已渲染成 SVG', svgCount > 0, `svg=${svgCount}`);

  const svgBox = await pcPage.locator('#qr-svg svg').boundingBox().catch(() => null);
  check('二维码有实际尺寸（不是 0×0）', !!svgBox && svgBox.width > 100, svgBox ? `${Math.round(svgBox.width)}×${Math.round(svgBox.height)}` : 'null');

  /* 二维码里到底编码了什么？从接口拿一次，解开确认是绝对地址。
     （这里只做字符串层面校验：真解码在编码器那轮已经用 OpenCV 验过 10/10。） */
  const t = await pcPage.evaluate(async () => {
    const r = await fetch('/api/auth/qr', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ purpose: 'login' }) });
    return (await r.json()).data;
  });
  check('二维码内容是绝对地址', /^https?:\/\/.+\/#\/qr\?id=[0-9a-f]{32}$/.test(t.url), t.url);
  check('二维码里的域名不是 localhost/内网', !/localhost|127\.0\.0\.1|192\.168\./.test(t.url), t.url.replace(/#.*/, ''));
  check('页面上确实有一张正在轮询的票据', /^[0-9a-f]{32}$/.test(pageQrId), pageQrId);

  /* 注意：上面这次 fetch 另外建了一张票据，页面上显示的是另一张。
     下面统一用页面自己那张（从轮询里拿不到 id，所以改成「拦接口」的方式取页面那张）。 */

  /* ========== 2. 手机未登录时扫到码：应该引导先登录，并记住回跳 ========== */
  await mbPage.goto(`${BASE}/#/qr?id=${pageQrId}`, { waitUntil: 'networkidle' });
  await mbPage.waitForTimeout(900);
  const needLogin = await mbPage.locator('.qrc-h').first().textContent().catch(() => '');
  check('未登录手机提示先登录', /需要先登录/.test(needLogin || ''), needLogin);
  const stored = await mbPage.evaluate(() => sessionStorage.getItem('wb_qr_return'));
  check('未登录点「去登录」前已记住回跳', stored === pageQrId || stored === null, `sessionStorage=${stored}`);
  if (stored === null) {
    // 说明它没存；点一下按钮再验
    await mbPage.locator('#qrc-login').click();
    await mbPage.waitForTimeout(400);
    const s2 = await mbPage.evaluate(() => sessionStorage.getItem('wb_qr_return'));
    check('点「去登录」后写入回跳 id', s2 === pageQrId, s2);
  }

  /* ========== 3. 手机登录（密码），登录完应自动跳回确认页 ========== */
  await mbPage.goto(BASE + '/#/login', { waitUntil: 'networkidle' });
  await mbPage.waitForTimeout(700);
  // 切到密码 tab
  const pwTab = mbPage.locator('.auth-tabs button', { hasText: '密码' }).first();
  if (await pwTab.count()) await pwTab.click();
  await mbPage.waitForTimeout(300);
  const inputs = mbPage.locator('.auth-input input');
  const n = await inputs.count();
  check('密码登录有手机号+密码两个输入框', n >= 2, `inputs=${n}`);
  await inputs.nth(0).fill(phone);
  await inputs.nth(1).fill(pass);
  await mbPage.locator('.auth-btn').first().click();
  await mbPage.waitForTimeout(2200);

  const hashAfterLogin = await mbPage.evaluate(() => location.hash);
  check('手机登录后回到扫码确认页', hashAfterLogin.startsWith('#/qr?id='), hashAfterLogin);
  const backId = (hashAfterLogin.match(/id=([0-9a-f]+)/) || [])[1];
  check('回跳的正是那一张票据', backId === pageQrId, `back=${backId} want=${pageQrId}`);

  /* ========== 4. 确认页信息展示 + 确认 ========== */
  await mbPage.waitForTimeout(900);
  const rowText = await mbPage.locator('.qrc-info').first().textContent().catch(() => '');
  check('确认页展示了设备信息', /设备/.test(rowText) && rowText.length > 6, rowText?.replace(/\s+/g, ' ').slice(0, 60));
  check('确认页不是「已被处理」态', !/已经|过期|拒绝/.test(await mbPage.locator('.qrc-h').first().textContent().catch(() => '')));

  await mbPage.locator('#qrc-accept').click();
  await mbPage.waitForTimeout(1200);
  const doneH = await mbPage.locator('.qrc-h').first().textContent().catch(() => '');
  check('手机端显示已确认', /已确认/.test(doneH || ''), doneH);

  /* 电脑侧：轮询 2s 一次 + exchange 一次往返。原来只等 3.5 秒，
     正好卡在两次轮询的边界上，属于测试自己太急——不是产品慢。 */
  await pcPage.waitForFunction(() => location.hash === '#/home', null, { timeout: 12000 }).catch(() => {});
  await pcPage.waitForTimeout(400);
  const pcHash = await pcPage.evaluate(() => location.hash);
  check('电脑端轮询后自动进入工作台', pcHash === '#/home', pcHash);
  const mePc = await pcPage.evaluate(async () => {
    const r = await fetch('/api/auth/me', { credentials: 'include' });
    const j = await r.json();
    return j.data?.user || j.data || null;
  });
  check('电脑端 Cookie 会话真的生效', !!(mePc && (mePc.id || mePc.phone)), JSON.stringify(mePc)?.slice(0, 80));

  /* ========== 5. 票据一次性 ========== */
  const again = await pcPage.evaluate(async (id) => {
    const r = await fetch(`/api/auth/qr/${id}`);
    return (await r.json()).data;
  }, pageQrId);
  check('同一张票据不能再用第二次', again.status === 'expired', again.status);

  /* ========== 6. 拒绝分支 ========== */
  /* 拒绝用的是「一张新票」：电脑那张已经确认过、也已经被删了。
     这里不需要电脑侧轮询，直接建票 → 手机拒绝 → 回头看接口状态即可。 */
  const t2 = await mbPage.evaluate(async () => {
    const r = await fetch('/api/auth/qr', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
    return (await r.json()).data;
  });
  await mbPage.goto(`${BASE}/#/qr?id=${t2.id}`, { waitUntil: 'networkidle' });
  await mbPage.waitForTimeout(900);
  await mbPage.locator('#qrc-reject').click();
  await mbPage.waitForTimeout(900);
  const rejH = await mbPage.locator('.qrc-h').first().textContent().catch(() => '');
  check('拒绝后提示已拒绝', /已拒绝/.test(rejH || ''), rejH);
  const st2 = await mbPage.evaluate(async (id) => {
    const r = await fetch(`/api/auth/qr/${id}`);
    return (await r.json()).data;
  }, t2.id);
  check('拒绝后电脑端拿不到 token', st2.status === 'rejected' && !st2.token, JSON.stringify(st2).slice(0, 60));

  /* ========== 7. 真正的安全边界：未登录的人不能确认 ========== */
  const anon = await browser.newContext();
  const anonP = await anon.newPage();
  const t3 = await mbPage.evaluate(async () => {
    const r = await fetch('/api/auth/qr', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
    return (await r.json()).data;
  });
  await anonP.goto(BASE + '/#/login', { waitUntil: 'domcontentloaded' });
  const anonRes = await anonP.evaluate(async (id) => {
    const r = await fetch(`/api/auth/qr/${id}/confirm`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'accept' }) });
    return { status: r.status, body: await r.json() };
  }, t3.id);
  check('未登录者调 confirm 被拒（401）', anonRes.status === 401, `HTTP ${anonRes.status}`);
  await anon.close();

  /* ========== 8. 过期票据 ========== */
  const expRes = await mbPage.evaluate(async () => {
    const r = await fetch('/api/auth/qr/' + 'deadbeef'.repeat(4));
    return (await r.json()).data;
  });
  check('不存在的票据返回 expired', expRes.status === 'expired', expRes.status);

  /* ========== 9. 传统入口回归（密码 / 验证码 / 注册 / 忘记密码） ========== */
  const regPage = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  await regPage.goto(BASE + '/#/login', { waitUntil: 'networkidle' });
  await regPage.waitForTimeout(900);
  /* 登录页默认落在「验证码」那个 tab 上（因为它排第一）。
     忘记密码按钮只在密码表单里，所以必须先切过去再找——
     这不是产品问题，是我一开始拿默认页去断言的。 */
  const regPwTab = regPage.locator('.auth-tabs button', { hasText: '密码' }).first();
  if (await regPwTab.count()) { await regPwTab.click(); await regPage.waitForTimeout(500); }
  const tabs = await regPage.locator('.auth-tabs button').allTextContents();
  check('登录页 tab 齐全', tabs.length >= 2, tabs.join(' | '));

  const cfg = await regPage.evaluate(async () => (await (await fetch('/api/auth/config')).json()).data);
  check('测试验证码通道已开', cfg.testPasscode === true, `code=${cfg.testPasscode}`);

  // 忘记密码入口存在
  /* 忘了密码的入口落在哪个位置取决于「有没有配短信」：
     有短信 → 一行灰字指引（去账号安全里改）；没短信 → 一颗可点的按钮，走取件码流程。
     所以两种形态都算「存在」，关键是别把用户堵死。 */
  const fpBtn = regPage.locator('#forgot-pwd');
  const fpTip = regPage.getByText(/忘记密码/);
  check('忘记密码入口存在', (await fpBtn.count()) > 0 || (await fpTip.count()) > 0,
    `按钮=${await fpBtn.count()} 文案=${await fpTip.count()}`);

  /* 注册：用测试码走一遍，验证「允许注册 + 测试码」这条真能建号 */
  const newPhone = '139' + String(Date.now()).slice(-8);
  const regRes = await regPage.evaluate(async ({ p, code }) => {
    // 拿测试码
    /* 先真的发一次码（落 otps 表），再用发到的码去注册。
       不能直接拿常量 826370 注册：服务端比对的是表里存的值，
       没发码就等于表里没记录，会被正确地判成「验证码不正确」。 */
    const s = await fetch('/api/auth/otp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone: p, purpose: 'register' }) });
    const sj = await s.json();
    const useCode = sj.data?.testCode || sj.data?.devCode || code;
    const r = await fetch('/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone: p, code: useCode, password: 'test123456', nickname: '扫码测试' }) });
    const j = await r.json();
    return { status: r.status, ok: j.ok, msg: j.message || '', hasUser: !!(j.data?.user) };
  }, { p: newPhone, code: cfg.testPasscode ? (process.env.TEST_PASSCODE || '826370') : '' });
  check('注册新账号可用', regRes.ok === true, `${regRes.status} ${regRes.msg}`);

  /* ========== 10. 页面无 JS 报错 ========== */
  const realErrs = errs.filter((e) => !/favicon|manifest|sw\.js|Failed to load resource/.test(e));
  check('页面无 JS 运行时错误', realErrs.length === 0, realErrs.slice(0, 3).join(' ;; '));

  /* 截图存档 */
  await mbPage.goto(`${BASE}/#/qr?id=${(await pcPage.evaluate(async () => {
    const r = await fetch('/api/auth/qr', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
    return (await r.json()).data;
  })).id}`, { waitUntil: 'networkidle' });
  await mbPage.waitForTimeout(1000);
  await mbPage.screenshot({ path: '/tmp/qr-confirm-mobile.png', fullPage: false });

  await pcPage.goto(BASE + '/#/login', { waitUntil: 'networkidle' });
  await pcPage.waitForTimeout(600);
  const qt = pcPage.locator('.auth-tabs button', { hasText: '扫码' }).first();
  if (await qt.count()) await qt.click();
  await pcPage.waitForTimeout(1500);
  await pcPage.screenshot({ path: '/tmp/qr-login-pc.png', fullPage: false });
} catch (e) {
  bad.push('脚本异常: ' + e.message);
  console.error('EXCEPTION', e);
} finally {
  await browser.close();
}

console.log('\n========== 汇总 ==========');
console.log(`通过 ${ok.length} / ${ok.length + bad.length}`);
if (bad.length) { console.log('失败：'); bad.forEach((b) => console.log('  - ' + b)); process.exitCode = 1; }
