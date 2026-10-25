#!/usr/bin/env python3
"""端到端 UI 测试：打开课表页 → 点「导入课表」→ 传图片 → 看预览 → 确认导入 → 校验结果。
用法: python3 tools/test_tt_ui.py"""
import os, sys, time, threading, http.server, socketserver, functools
from playwright.sync_api import sync_playwright

ROOT = '/workspace/myworkbench'
SRVDIR = os.path.join(ROOT, 'static')
PORT = 8888
IMG = '/root/uploads/wb-img-24f69abae5235a189c0cad78/16e80407dd8506659f4ff944687e8793.png'

def serve():
    class Q(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a): pass
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(('127.0.0.1', PORT), functools.partial(Q, directory=SRVDIR)) as s:
        s.serve_forever()

threading.Thread(target=serve, daemon=True).start()
time.sleep(0.6)

with sync_playwright() as p:
    b = p.chromium.launch(args=['--no-sandbox'])
    ctx = b.new_context(viewport={'width': 1280, 'height': 900}, bypass_csp=True)
    ctx.set_extra_http_headers({'Cache-Control': 'no-cache'})
    pg = ctx.new_page()
    errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.on('console', lambda m: errs.append('console.' + m.type + ': ' + m.text) if m.type == 'error' else None)

    pg.goto(f'http://127.0.0.1:{PORT}/index.html#/work/timetable?_=1', wait_until='domcontentloaded')
    pg.evaluate("()=>{ try{ navigator.serviceWorker.getRegistrations().then(rs=>rs.forEach(r=>r.unregister())); }catch(e){} }")
    pg.wait_for_function("!!(window.__wbLocalApi && typeof window.__wbLocalApi.handle === 'function')", timeout=20000)
    time.sleep(1.2)

    # 进课表页
    pg.evaluate("location.hash='#/work/timetable'")
    pg.evaluate("window.dispatchEvent(new HashChangeEvent('hashchange'))")
    time.sleep(1.0)

    # 点「导入课表」
    btn = pg.query_selector('#import-tt')
    assert btn, '找不到「导入课表」按钮'
    btn.click()
    time.sleep(0.6)

    # 传图片
    fi = pg.query_selector('#tt-file')
    assert fi, '找不到文件输入框'
    fi.set_input_files(IMG)
    time.sleep(2.0)

    # 看预览表格有几行、每行班号是什么
    rows = pg.evaluate("""() => {
      const out=[];
      document.querySelectorAll('#tt-work tbody tr').forEach(tr=>{
        const sel=tr.querySelector('[data-k=weekday]');
        const per=tr.querySelector('[data-k=period]');
        const cl=tr.querySelector('[data-k=class_name]');
        const need=tr.querySelector('.tiny');
        out.push({wd:sel?sel.value:'', p:per?per.value:'', cls:cl?cl.value:'', need:need?need.textContent:'', bg:tr.getAttribute('style')||''});
      });
      return out;
    }""")
    raw = pg.evaluate("""() => { const g = window.__wbDetect; return null; }""")
    print(f'预览表格 {len(rows)} 行：')
    for r in rows:
        print(f"  周{r['wd']} 第{r['p']:>2}节  {r['cls']:<6} {r['need']}")

    tip = pg.evaluate("() => document.querySelector('#tt-work .small')?.innerText || ''")
    print('\n提示：', tip.replace('\n', ' | '))

    # 截图
    pg.screenshot(path='/tmp/tt_ui_1.png', full_page=False)

    # 找「导入到课表」按钮
    confirm_btn = pg.evaluate("""() => {
      const bs=[...document.querySelectorAll('button')];
      const t=bs.find(b=>/导入到课表|确定导入|导入$/.test(b.textContent.trim()));
      return t? t.textContent.trim() : null;
    }""")
    print('\n底部按钮：', confirm_btn)
    shot = '/tmp/tt_ui_dialog.png'
    pg.screenshot(path=shot)
    print('\n错误日志：', errs[:5] if errs else '无')
    b.close()
print('\n截图: /tmp/tt_ui_1.png /tmp/tt_ui_dialog.png')

# ---- 第二段：真正点「导入到课表」，校验落库 ----
with sync_playwright() as p:
    b = p.chromium.launch(args=['--no-sandbox'])
    pg = b.new_context(viewport={'width': 1280, 'height': 900}).new_page()
    errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(f'http://127.0.0.1:{PORT}/index.html#/work/timetable', wait_until='domcontentloaded')
    pg.wait_for_function("!!(window.__wbLocalApi && typeof window.__wbLocalApi.handle === 'function')", timeout=20000)
    time.sleep(1.0)
    pg.evaluate("location.hash='#/work/timetable'")
    pg.evaluate("window.dispatchEvent(new HashChangeEvent('hashchange'))")
    time.sleep(0.8)
    pg.query_selector('#import-tt').click(); time.sleep(0.5)
    pg.query_selector('#tt-file').set_input_files(IMG); time.sleep(2.0)

    # 把最后那个需核对的 12 改成 14（模拟用户核对）
    pg.evaluate("""() => {
      const trs=[...document.querySelectorAll('#tt-work tbody tr')];
      const t=trs.find(tr=>tr.querySelector('.tiny'));
      if(t){ const i=t.querySelector('[data-k=class_name]'); i.value='14'; i.dispatchEvent(new Event('input',{bubbles:true})); }
    }""")
    time.sleep(0.3)

    # 点底部「导入到课表」
    clicked = pg.evaluate("""() => {
      const t = document.querySelector('#tt-ok');
      if(!t) return 'no-#tt-ok';
      t.click(); return t.textContent.trim();
    }""")
    print('点击导入:', clicked)
    time.sleep(4.0)

    raw = pg.evaluate("""async () => { const r = await window.__wbLocalApi.handle('GET','/courses',{},null); return JSON.stringify(r).slice(0,300); }""")
    print('原始返回:', raw)

    got = pg.evaluate("""async () => {
      const api = window.__wbLocalApi;
      const r = await api.handle('GET', '/courses', {}, null);
      const list = Array.isArray(r) ? r : (r && (r.data || r.body)) || [];
      return list.map(x => ({ d: x.weekday, p: x.period_no, c: x.class_name }));
    }""")
    print(f'\n课表里现在有 {len(got)} 条：')
    for x in got:
        print(f'  周{x["d"]} 第{x["p"]}节  {x["c"]}班')
    per = pg.evaluate("""async () => {
      const r = await window.__wbLocalApi.handle('GET','/periods',{},null);
      const list = (r && r.data) || [];
      return list.sort((a,b)=>a.period_no-b.period_no).map(x=>`第${x.period_no}节 ${x.start_time}-${x.end_time}`);
    }""")
    print('\n节次时间:')
    for x in per: print('  ', x)
    print('错误:', errs[:3] if errs else '无')
    pg.screenshot(path='/tmp/tt_after_import.png', full_page=False)
    b.close()
