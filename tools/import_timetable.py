"""把 2026 秋季信息课表导入线上工作台。

为什么要在真浏览器里跑：
    数据存在 localStorage，只有真浏览器才有。用 node 跑是另一份空库，
    导完用户刷新页面什么都看不到。
"""
import json
import sys

from playwright.sync_api import sync_playwright

BASE = "https://githubalong.github.io/my-workbench"

# 节次表：完全照用户给的那张课表
PERIODS = [
    (1, "第一节", "08:00", "08:40"),
    (2, "第二节", "08:50", "09:30"),
    (3, "第三节", "10:00", "10:40"),
    (4, "第四节", "10:50", "11:30"),
    (5, "第五节", "11:40", "12:20"),
    (6, "第六节", "14:10", "14:50"),
    (7, "第七节", "15:20", "16:00"),
    (8, "第八节", "16:15", "16:55"),
    (9, "第九节", "17:05", "17:45"),
    (10, "晚一", "18:25", "18:40"),
    (11, "晚二", "19:30", "20:10"),
    (12, "晚三", "20:20", "21:00"),
    (13, "晚四", "21:10", "21:55"),
]

# 课表：(星期, 节次, 班级)  1=周一 … 5=周五
PLAN = [
    (3, 1, "11班"), (5, 1, "13班"),
    (1, 3, "5班"), (3, 3, "12班"),
    (1, 5, "7班"), (2, 5, "6班"), (4, 5, "10班"),
    (4, 6, "9班"),
    (4, 7, "16班"),
    (2, 9, "15班"), (3, 9, "8班"), (4, 9, "14班"), (5, 9, "18班"),
]

SUBJECT = "信息技术"
GRADE = ""  # 用户选的是「不分年级」

JS = """
async ([periods, plan, subject, grade]) => {
  const { handle } = window.__wbLocalApi;
  const log = { oldPeriods: 0, oldCourses: 0, newPeriods: 0, newCourses: 0, errors: [] };

  // 1. 删掉旧的节次与课表（软删除，进回收站，可还原）
  const oldP = (await handle('GET', '/periods', {})).data || [];
  const oldC = (await handle('GET', '/courses', {})).data || [];
  for (const p of oldP) await handle('DELETE', '/periods/' + p.id, {});
  for (const c of oldC) await handle('DELETE', '/courses/' + c.id, {});
  log.oldPeriods = oldP.length;
  log.oldCourses = oldC.length;

  // 2. 写新节次
  for (const [no, name, st, et] of periods) {
    const r = await handle('POST', '/periods', {}, {
      period_no: no, name, start_time: st, end_time: et,
    });
    if (r.ok === false) log.errors.push('period ' + no + ': ' + r.error);
    else log.newPeriods++;
  }

  // 3. 写新课表
  const pmap = new Map(periods.map((p) => [p[0], p]));
  for (const [wd, pn, cls] of plan) {
    const p = pmap.get(pn);
    const r = await handle('POST', '/courses', {}, {
      weekday: wd, period_no: pn,
      start_time: p[2], end_time: p[3],
      grade, class_name: cls, subject,
      room: '', color: '',
    });
    if (r.ok === false) log.errors.push('course ' + wd + '-' + pn + ': ' + r.error);
    else log.newCourses++;
  }

  // 4. 读回来验证
  const back = (await handle('GET', '/courses', {})).data || [];
  log.backCount = back.length;
  log.back = back.map((c) => `周${c.weekday} 第${c.period_no}节 ${c.class_name} ${c.start_time}-${c.end_time} ${c.subject}`);
  return log;
}
"""


def main():
    with sync_playwright() as p:
        br = p.chromium.launch()
        ctx = br.new_context(viewport={"width": 1440, "height": 900}, locale="zh-CN")
        pg = ctx.new_page()
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)[:200]))
        pg.goto(BASE + "/", wait_until="load")
        # 等应用初始化完（seed 灌完、localapi 挂到 window）
        pg.wait_for_function("!!(window.__wbLocalApi && typeof window.__wbLocalApi.handle === 'function')", timeout=120000)
        pg.wait_for_timeout(1500)

        r = pg.evaluate(JS, [PERIODS, PLAN, SUBJECT, GRADE])
        print("清理旧节次:", r["oldPeriods"], "旧课程:", r["oldCourses"])
        print("写入新节次:", r["newPeriods"], "新课程:", r["newCourses"])
        print("读回课程数:", r["backCount"])
        for line in r["back"]:
            print("   ", line)
        if r["errors"]:
            print("错误:", r["errors"])
        print("页面 JS 错误:", errs)
        br.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
