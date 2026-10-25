#!/usr/bin/env python3
"""在真浏览器里跑 detectTimetable，验证班号识别。
用法: python3 tools/test_ttimage.py [图片路径]"""
import sys, os, json, base64, threading, http.server, socketserver, functools, time
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRVDIR = os.path.join(ROOT, 'static')
SRC_IMG = sys.argv[1] if len(sys.argv) > 1 else '/root/uploads/wb-img-24f69abae5235a189c0cad78/16e80407dd8506659f4ff944687e8793.png'
PORT = 8897

def serve():
    h = functools.partial(http.server.SimpleHTTPRequestHandler, directory=SRVDIR)
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(('127.0.0.1', PORT), h) as httpd:
        httpd.serve_forever()

threading.Thread(target=serve, daemon=True).start()
time.sleep(0.6)

with open(SRC_IMG, 'rb') as f:
    b64 = base64.b64encode(f.read()).decode()
dataurl = 'data:image/png;base64,' + b64

JS = """
async () => {
  const mod = await import('./js/ttimage.js');
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = window.__IMG; });
  const r = mod.detectTimetable(img);
  return r;
}
"""

with sync_playwright() as p:
    b = p.chromium.launch(args=['--no-sandbox'])
    pg = b.new_page()
    pg.goto(f'http://127.0.0.1:{PORT}/index.html', wait_until='domcontentloaded')
    pg.evaluate("u => { window.__IMG = u; }", dataurl)
    r = pg.evaluate(JS)
    b.close()

if not r.get('ok'):
    print('识别失败:', r)
    sys.exit(1)

print(f"rows={r['rows']} cols={r['cols']} headerRow={r['headerRow']} firstDayCol={r['firstDayCol']}")
print(f"{'row':>4}{'col':>4}{'星期':>5}{'节次':>5}  {'班号':<6}{'置信':>6}")
truth = {(2,3):'11',(2,5):'13',(4,1):'5',(4,3):'12',(6,1):'7',(6,2):'6',(6,4):'10',
         (8,4):'9',(9,4):'16',(11,2):'15',(11,3):'8',(11,4):'14',(11,5):'18'}
ok = bad = 0
for c in r['cells']:
    k = (c['row'], c['col'])
    t = truth.get(k, '?')
    g = c.get('classGuess', '')
    mark = '✓' if g == t else ('·' if not g else '✗')
    if g == t: ok += 1
    elif g: bad += 1
    print(f"{c['row']:>4}{c['col']:>4}{c['weekday']:>5}{c['periodGuess']:>5}  {g or '-':<6}{c.get('classConfidence',0):>6.2f}  期望 {t} {mark}")
print(f"\n命中 {ok} / 共 {len(r['cells'])} 格，识别错 {bad} 格，未识别 {len(r['cells'])-ok-bad} 格")
