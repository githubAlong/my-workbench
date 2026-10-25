"""静态版冒烟测试：在真浏览器里把每个页面走一遍，抓住「白屏 / 报错 / 空数据」。

为什么单独写一份而不是复用 regress.py：
    服务端那套跑法要登录、要 token、要造接口数据；静态版没有服务端，
    所有数据都在 localStorage 里，用浏览器直接点最省事、也最接近用户真实操作。

    python3 tools/static_smoke.py
"""
import os
import sys
import json
import time

from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE", "http://127.0.0.1:8899")
SHOT = os.path.join(os.path.dirname(__file__), "..", "screenshots", "static")
os.makedirs(SHOT, exist_ok=True)

R = []


def add(no, title, ok, ev=""):
    R.append({"no": no, "title": title, "ok": bool(ok), "ev": str(ev)})
    print(f"{'PASS' if ok else 'FAIL'}  {no:>2}. {title}   {ev}")


PAGES = [
    ("home", "首页", None),
    ("work/lessons", "工作-上课", None),
    ("work/prep", "工作-备课", None),
    ("work/timetable", "工作-课表", None),
    ("work/attendance", "工作-考勤", None),
    ("work/invigilation", "工作-监考", None),
    ("work/trips", "工作-出差", None),
    ("work/materials", "工作-课件", None),
    ("work/notes", "工作-笔记", None),
    ("daily", "日常", None),
    ("study", "学习", None),
    ("selfstudy", "自习", None),
    ("repairs", "维修", None),
    ("me", "我的", None),
    ("recycle", "回收站", None),
    ("messages", "消息", None),
]


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(viewport={"width": 1440, "height": 900}, locale="zh-CN")
        page = ctx.new_page()
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        page.on("console", lambda m: errs.append("console." + m.type + ": " + m.text) if m.type == "error" else None)

        # 1. 打开首页
        page.goto(BASE + "/", wait_until="networkidle")
        page.wait_for_timeout(1200)
        title = page.title()
        main_html = page.eval_on_selector("#app", "e => e.innerHTML.length") if page.query_selector("#app") else 0
        add(1, "首页能打开且有内容", main_html > 400, f"title={title} html={main_html}")

        # 2. 种子数据到位
        seed = page.evaluate("""() => {
            const raw = localStorage.getItem('wb_static_db_v1');
            if (!raw) return null;
            const d = JSON.parse(raw);
            return { periods: (d.periods||[]).length, courses: (d.courses||[]).length,
                     students: (d.students||[]).length, materials: (d.materials||[]).length,
                     punishments: (d.punishments||[]).length, todos: (d.todos||[]).length,
                     items: (d.items||[]).length, attendance: (d.attendance_tables||[]).length };
        }""")
        ok = seed and seed["periods"] == 10 and seed["courses"] >= 15 and seed["students"] == 78 and seed["materials"] == 3
        add(2, "示例数据已灌入（节次/课表/学生/课件）", ok, json.dumps(seed, ensure_ascii=False))

        # 3. 逐个页面
        for i, (path, name, _) in enumerate(PAGES, start=3):
            errs.clear()
            page.goto(BASE + "/#/" + path, wait_until="domcontentloaded")
            page.wait_for_timeout(900)
            html_len = page.eval_on_selector("#app", "e => e.innerText.replace(/\\s+/g,'').length") if page.query_selector("#app") else 0
            # 空态/加载失败都算不通过；正常页面正文至少 60 个字
            bad = html_len < 60
            add(i, f"页面「{name}」有内容且无报错", not bad and not errs,
                f"字数={html_len} 报错={errs[:2]}")
            if bad:
                page.screenshot(path=os.path.join(SHOT, f"fail-{path.replace('/', '-')}.png"), full_page=True)

        # 4. 关键接口：课时汇总的金额算得对
        res = page.evaluate("""async () => {
            const { handle } = window.__wbLocalApi || await import('./js/localapi.js');
            // 造三条代课记录验证汇总口径
            const mk = (sub, hours, price) => handle('POST','/lessons',{},{
                date: '2026-01-05', class_name: '高二(3)班', subject: '语文',
                sub_type: sub, hours, pay_hours: hours, pay_amount: price,
                peer_name: '王老师', content: '测试'
            });
            await mk('normal', 1, 0);
            await mk('替他人上', 2, 60);
            await mk('他人替我上', 0, 0);
            const r = await handle('GET','/lessons/summary',{month:'2026-01'},undefined);
            return r.data;
        }""")
        s = res["summary"]
        # total_hours 是 Σ hours，无条件累加所有行（含「他人替我上」存 0 的那条）
        # 1(normal) + 2(替他人上) + 0(他人替我上) = 3，与服务端 buildLessonSummary 一致
        ok = (s["total_hours"] == 3 and s["lesson_count"] == 3
              and s["normal_count"] == 1
              and s["sub_out"]["count"] == 1 and s["sub_out"]["hours"] == 2
              and s["sub_in"]["count"] == 1 and s["sub_in"]["hours"] == 0
              and s["net"]["amount"] == 60 and s["net"]["direction"] == "receivable")
        add(4, "课时汇总口径正确（代课分开算、净额只算未结）", ok,
            f"总课时={s['total_hours']} 条数={s['lesson_count']} 应收={s['net']['amount']}")

        # 5. 结清后净额归零
        res2 = page.evaluate("""async () => {
            const { handle } = window.__wbLocalApi || await import('./js/localapi.js');
            await handle('POST','/lessons/settle',{},{month:'2026-01',name:'王老师',direction:'out'});
            const r = await handle('GET','/lessons/summary',{month:'2026-01'},undefined);
            return r.data.summary;
        }""")
        add(5, "结清后净额归零", res2["net"]["amount"] == 0, f"净额={res2['net']['amount']} 状态={res2['net']['direction']}")

        # 6. 出差报销：手填与明细取较大者，不重复相加
        res3 = page.evaluate("""async () => {
            const { handle } = window.__wbLocalApi || await import('./js/localapi.js');
            const t = await handle('POST','/trips',{},{start_date:'2026-02-01',end_date:'2026-02-03',
                to_place:'市教研室', reason:'培训', transport:200, hotel:0});
            const id = t.data.id;
            await handle('POST','/trip/'+id+'/items',{},{kind:'hotel', amount:100, has_invoice:1});
            await handle('POST','/trip/'+id+'/items',{},{kind:'hotel', amount:150, has_invoice:1});
            const r = await handle('GET','/trip/'+id,{},undefined);
            return r.data.calc;
        }""")
        # 住宿手填 0、明细 100+150 → 取较大者 250（不是 0+250，也不是 250 记两遍）
        # 合计 = 实报实销(200+250) + 餐饮补贴(100×3) + 市内补贴(40×3)
        ok3 = (res3["real"]["transport"] == 200 and res3["real"]["hotel"] == 250
               and res3["days"] == 3 and res3["food"] == 300
               and res3["total"] == res3["realTotal"] + res3["subsidyTotal"]
               and res3["total"] == 870)
        add(6, "出差报销：明细汇总不被重复相加、补贴按天算", ok3,
            f"交通={res3['real']['transport']} 住宿={res3['real']['hotel']} 天数={res3['days']} "
            f"餐补={res3['food']} 市补={res3['local']} 合计={res3['total']}")

        # 7. 考勤统计
        res4 = page.evaluate("""async () => {
            const { handle } = window.__wbLocalApi || await import('./js/localapi.js');
            const list = await handle('GET','/attendance',{},undefined);
            const first = (list.data||[])[0];
            if (!first) return null;
            const st = await handle('GET','/attendance/'+first.id+'/stats',{},undefined);
            return { name: first.name, teachers: st.data.stats.length, row: st.data.stats[0] };
        }""")
        add(7, "考勤表列表与统计可用", res4 and res4["teachers"] >= 4,
            f"表={res4['name'] if res4 else '-'} 统计人数={res4['teachers'] if res4 else 0}")

        # 8. 回收站：删了能还原
        res5 = page.evaluate("""async () => {
            const { handle } = window.__wbLocalApi || await import('./js/localapi.js');
            const c = await handle('POST','/notes',{},{title:'待删笔记', content:'x'});
            if (!c || c.ok === false || !c.data) return { error: String(c && c.error), step: 'create' };
            const id = c.data.id;
            await handle('DELETE','/notes/'+id,{},undefined);
            const rc = await handle('GET','/recycle',{},undefined);
            if (!rc || rc.ok === false || !rc.data || !Array.isArray(rc.data.list)) {
                return { error: String(rc && rc.error), step: 'recycle', raw: JSON.stringify(rc).slice(0, 200) };
            }
            const hit = rc.data.list.find(x => x.entity === 'notes' && x.entity_id === id);
            if (!hit) return { error: '删了但没进回收站', step: 'find' };
            await handle('POST','/recycle/restore',{},{ids:[hit.id]});
            const back = await handle('GET','/notes',{},undefined);
            return { recycled: true, restored: (back.data||[]).some(n => n.id === id), keep: rc.data.keepDays };
        }""")
        add(8, "回收站：软删除 + 还原 + 保留 30 天",
            bool(res5) and res5.get("recycled") and res5.get("restored") and res5.get("keep") == 30,
            json.dumps(res5, ensure_ascii=False))

        # 9. 学生短链页能打开
        code = page.evaluate("""async () => {
            const { handle } = window.__wbLocalApi || await import('./js/localapi.js');
            const r = await handle('GET','/links',{},undefined);
            return ((r && r.data) || [])[0]?.code || '';
        }""")
        # 静态版用 ?code= 传短链编码（/s/<code> 是服务端路由，Pages 上没有）
        stxt = ""
        if code:
            page.goto(f"{BASE}/student.html?code={code}", wait_until="networkidle")
            page.wait_for_timeout(1500)
            stxt = page.inner_text("#s-app") if page.query_selector("#s-app") else ""
        add(9, "学生端短链页能渲染（课件/抽人/抽任务）", bool(code) and len(stxt.strip()) > 10,
            f"code={code or '(无)'} 内容={stxt[:40]!r}")

        # 10. 控制台全程无 JS 报错
        add(10, "全程无未捕获 JS 异常", not errs, str(errs[:3]))

        page.screenshot(path=os.path.join(SHOT, "home.png"), full_page=False)
        browser.close()

    total = len(R)
    passed = sum(1 for x in R if x["ok"])
    print(f"\n=== {passed}/{total} 通过 ===")
    with open(os.path.join(SHOT, "result.json"), "w", encoding="utf-8") as f:
        json.dump(R, f, ensure_ascii=False, indent=2)
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())
