#!/usr/bin/env python3
"""线上验收：在真实 GitHub Pages 站点上跑「导入课表」全流程。

和 test_tt_ui.py 的区别：
    test_tt_ui.py 打本地 static/，验证代码正确性；
    本脚本打 https://githubalong.github.io/my-workbench/，验证**部署产物**正确性
    （打包后的 app.js 里 ttimage.js 是否真的被并入、SW 是否返回新文件）。

验收标准：
    1. 页面能打开、无 JS 报错
    2. 点「导入课表」→ 传图 → 出现 13 行预览
    3. 12 行是识别结果（紫色），1 行标「需核对」（橙色）
    4. 点确认后 13 条课程落库，班号与人工核对一致
    5. 13 条节次时间与课表截图一致

用法: python3 tools/verify_live.py
"""
import os
import sys
import time

from playwright.sync_api import sync_playwright

LIVE = os.environ.get('LIVE', 'https://githubalong.github.io/my-workbench/')
IMG = '/root/uploads/wb-img-24f69abae5235a189c0cad78/16e80407dd8506659f4ff944687e8793.png'

# 人工核对的真值：(星期, 节次, 班号)，从课表截图逐格抄录
#
# 【坑·务必留意】午休「12:20-14:10」是**跨整行的合并单元格，物理上占一行**。
# 所以表格行号不能直接当节次：r2..r6 = 第1..5节，r7 = 午休（无节次），r8..r15 = 第6..13节。
# 我一度以为 r7 是「空行被跳过」，把 r8 当成第 7 节，整张真值表偏了一节 —— 程序反而是对的。
TRUTH = [
    (1, 3, '5'), (1, 5, '7'),
    (2, 5, '6'), (2, 10, '15'),
    (3, 1, '11'), (3, 3, '12'), (3, 10, '8'),
    (4, 5, '10'), (4, 7, '9'), (4, 8, '16'), (4, 10, '14'),
    (5, 1, '13'), (5, 10, '18'),
]
PERIODS = [
    (1, '08:00', '08:40'), (2, '08:50', '09:30'), (3, '10:00', '10:40'),
    (4, '10:50', '11:30'), (5, '11:40', '12:20'), (6, '14:10', '14:50'),
    (7, '15:20', '16:00'), (8, '16:15', '16:55'), (9, '17:05', '17:45'),
    (10, '18:25', '18:40'), (11, '19:30', '20:10'), (12, '20:20', '21:00'),
    (13, '21:10', '21:55'),
]

fails = []


def check(ok, label, detail=''):
    print(('PASS  ' if ok else 'FAIL  ') + label + (('   ' + str(detail)) if detail else ''))
    if not ok:
        fails.append(label)


with sync_playwright() as p:
    b = p.chromium.launch(args=['--no-sandbox'])
    ctx = b.new_context(viewport={'width': 1280, 'height': 900}, bypass_csp=True)
    pg = ctx.new_page()
    errs = []
    pg.on('pageerror', lambda e: errs.append('pageerror: ' + str(e)))
    pg.on('console', lambda m: errs.append('console.error: ' + m.text) if m.type == 'error' else None)

    # 1. 打开线上首页（加 query 绕开 SW 缓存）
    pg.goto(LIVE + '?live=1#/work/timetable', wait_until='domcontentloaded', timeout=60000)
    pg.wait_for_function(
        "!!(window.__wbLocalApi && typeof window.__wbLocalApi.handle === 'function')",
        timeout=30000,
    )
    time.sleep(1.5)
    check(len(pg.content()) > 5000, '线上首页打开', f'html={len(pg.content())}')

    # 2. 进课表页
    pg.evaluate("location.hash='#/work/timetable'")
    pg.evaluate("window.dispatchEvent(new HashChangeEvent('hashchange'))")
    time.sleep(1.2)
    check(pg.query_selector('#import-tt') is not None, '课表页有「导入课表」按钮')

    # 3. 传课表图片
    pg.query_selector('#import-tt').click()
    time.sleep(0.6)
    fi = pg.query_selector('#tt-file')
    check(fi is not None, '弹窗里有文件选择框')
    fi.set_input_files(IMG)
    time.sleep(2.5)

    rows = pg.evaluate("""() => Array.from(document.querySelectorAll('#tt-work tbody tr')).map(tr => ({
        wd: tr.querySelector('[data-k=weekday]').value,
        p:  tr.querySelector('[data-k=period]').value,
        cn: tr.querySelector('[data-k=class_name]').value,
        ph: tr.querySelector('[data-k=class_name]').placeholder || '',
        need: !!tr.querySelector('.tiny') && tr.querySelector('.tiny').textContent.includes('待填'),
    }))""")
    check(len(rows) == 13, '识别出 13 个有课格子', f'实际 {len(rows)}')
    nneed = sum(1 for r in rows if r['need'])
    # 这张课表已能全自动认完（含曾认不出的「14班」），所以期望 0 格待填。
    # 若哪天又冒出待填，说明识别退化了 —— 这里要能报警，不能放宽成「无所谓」。
    check(nneed == 0, '13 格全部自动认出，无待填', f'待填 {nneed} 格')

    # 【关键】没认出来的那格必须是**空**，不能填一个看起来像真班号的数字
    # 早先填的是顺序号，14 班那格显示「12」，老师极易当成识别结果直接确认
    blanks = [r for r in rows if r['need']]
    check(all(r['cn'].strip() == '' for r in blanks),
          '「待填」那格班号为空（不填假数据）',
          f"实际值={[r['cn'] for r in blanks]}")

    # 4. 逐行打印识别结果，方便肉眼比对
    print('  --- 识别结果 ---')
    for r in rows:
        print(f"    周{r['wd']} 第{r['p']}节  {r['cn'] + '班' if r['cn'].strip() else '(空，待填)'}"
              f"{'  ← 待填' if r['need'] else ''}")

    # 4b. 主动清空一格，验证「空班号不许静默丢课」这条防线还在
    # 自动识别现在能填满 13 格，所以得自己造一个空格来测。
    # 清空时记住原值，测完要原样填回去 —— 否则后面「13 条落库」的断言会拿脏数据比。
    # （不能用「库里少于 13 条」判断——首次打开会灌示例数据，本来就有十几条）
    orig = pg.evaluate("""() => {
        const inp = document.querySelector('#tt-work tbody tr [data-k=class_name]');
        const v = inp.value;
        inp.value = '';
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        return v;
    }""")
    time.sleep(0.3)
    before = pg.evaluate("""async () => {
        const r = await window.__wbLocalApi.handle('GET', '/courses', {}, null);
        return ((r && r.data) || []).length;
    }""")
    pg.query_selector('#tt-ok').click()
    time.sleep(1.5)
    after = pg.evaluate("""async () => {
        const r = await window.__wbLocalApi.handle('GET', '/courses', {}, null);
        return ((r && r.data) || []).length;
    }""")
    hint = pg.evaluate("""() => {
        const t = document.body.innerText || '';
        const m = t.match(/还有\\s*\\d+\\s*行没填班号[^\\n]*/);
        return m ? m[0] : '';
    }""")
    check(after == before and '没填班号' in hint,
          '班号空着时点导入被拦下（提示 + 不落库）',
          f'课程数 {before}→{after}，提示={hint[:40]!r}')

    # 5. 把刚才清空的那格原样填回去（测「空着能拦住」这件事，不该改动识别结果）
    fixed = pg.evaluate("""(orig) => {
        const rows = Array.from(document.querySelectorAll('#tt-work tbody tr'));
        const tr = rows.find(t => !t.querySelector('[data-k=class_name]').value.trim());
        if (!tr) return false;
        const inp = tr.querySelector('[data-k=class_name]');
        inp.value = orig;
        inp.dispatchEvent(new Event('input', {bubbles: true}));
        inp.dispatchEvent(new Event('change', {bubbles: true}));
        return true;
    }""", orig)
    check(fixed, '空着的格子可以手工填上班号')

    # 6. 点「导入到课表」
    pg.query_selector('#tt-ok').click()
    time.sleep(3.0)

    # 7. 校验落库的课程
    res = pg.evaluate("""async () => {
        const r = await window.__wbLocalApi.handle('GET', '/courses', {}, null);
        return (r && r.data) || [];
    }""")
    got = sorted((int(c['weekday']), int(c['period_no']), str(c['class_name']).replace('班', ''))
                 for c in res)
    want = sorted(TRUTH)
    check(got == want, '13 条课程全部落库且班号正确', '' if got == want else f'实际={got}')

    # 8. 校验节次时间
    pres = pg.evaluate("""async () => {
        const r = await window.__wbLocalApi.handle('GET', '/periods', {}, null);
        return (r && r.data) || [];
    }""")
    pmap = {int(x['period_no']): (x['start_time'], x['end_time']) for x in pres}
    bad = [(n, s, e, pmap.get(n)) for n, s, e in PERIODS if pmap.get(n) != (s, e)]
    check(not bad, '13 条节次时间与课表一致', '' if not bad else f'不符={bad}')

    # 9. 刷新一次，确认数据真的持久化了（不是内存里的假象）
    pg.goto(LIVE + '?live=2#/work/timetable', wait_until='domcontentloaded', timeout=60000)
    pg.wait_for_function(
        "!!(window.__wbLocalApi && typeof window.__wbLocalApi.handle === 'function')",
        timeout=30000,
    )
    time.sleep(1.2)
    res2 = pg.evaluate("""async () => {
        const r = await window.__wbLocalApi.handle('GET', '/courses', {}, null);
        return (r && r.data) || [];
    }""")
    check(len(res2) == 13, '刷新后数据仍在（真持久化）', f'{len(res2)} 条')

    # 10. 无未捕获异常
    check(len(errs) == 0, '全程无 JS 报错', errs[:3] if errs else '')

    pg.screenshot(path='/workspace/myworkbench/screenshots/live-timetable-imported.png', full_page=True)
    b.close()

print()
if fails:
    print(f'=== {len(fails)} 项未通过 ===')
    for f in fails:
        print('  - ' + f)
    sys.exit(1)
print('=== 线上验收全部通过 ===')
