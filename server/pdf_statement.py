#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把课时对账单渲染成竖版 A4 PDF（正式单据，可打印签字）。

用法：echo '{...}' | python3 pdf_statement.py /path/out.pdf

JSON 结构：
{
  month_label: "2026年10月",
  teacher: "王老师", school: "XX中学", subject: "语文",
  created: "2026-11-01",
  price: 60,
  scheduled: {total, actual, substitute_out},
  summary: {total_hours, lesson_count, normal_count,
            sub_out:{count,hours,amount}, sub_in:{count,hours,amount},
            swap:{count}, net:{hours,amount,direction}},
  people: [{name, direction, hours, amount, settled}],
  rows: [{date, period, class_name, subject, content, hours, amount, sub}]
}
"""
import sys
import json
import html as _html

from weasyprint import HTML

CJK = '"Noto Sans CJK SC", "Noto Serif CJK SC", "WenQuanYi Zen Hei", sans-serif'
SERIF = '"Noto Serif CJK SC", "Noto Sans CJK SC", serif'


def esc(v):
    return _html.escape(str(v if v is not None else ""))


def money(n):
    try:
        v = float(n or 0)
    except Exception:
        return "0"
    if abs(v - round(v)) < 0.005:
        return f"{int(round(v)):,}"
    return f"{v:,.2f}"


CSS = """
@page {
  size: A4 portrait;
  margin: 16mm 15mm 14mm;
  @bottom-center {
    content: "第 " counter(page) " / " counter(pages) " 页";
    font-family: %(cjk)s; font-size: 8pt; color: #999;
  }
}
* { box-sizing: border-box; }
body { font-family: %(cjk)s; font-size: 9pt; color: #1a1a1a; margin: 0; line-height: 1.5; }

.head { text-align: center; border-bottom: 1.2pt solid #1a1a1a; padding-bottom: 3mm; margin-bottom: 4mm; }
.head h1 { font-family: %(serif)s; font-size: 17pt; font-weight: 700; margin: 0 0 1.6mm; letter-spacing: .06em; }
.head .meta { font-size: 9.5pt; color: #444; }
.head .meta span { margin: 0 3mm; }

.sec-t { font-size: 10.5pt; font-weight: 700; margin: 4mm 0 2mm; padding-left: 2mm;
         border-left: 2.4pt solid #1a1a1a; line-height: 1.3; }

/* 三口径 */
.tri { width: 100%%; border-collapse: collapse; margin-bottom: 1mm; }
.tri td { border: .3mm solid #d5d5db; padding: 2mm 3mm; text-align: center; }
.tri .k { font-size: 8.5pt; color: #666; display: block; margin-bottom: .8mm; }
.tri .v { font-size: 14pt; font-weight: 700; }
.tri .u { font-size: 8.5pt; color: #666; font-weight: 400; margin-left: .8mm; }
.tri .note { font-size: 7.8pt; color: #888; text-align: left; border: none; padding: 1.5mm 0 0; }

/* 汇总小表 */
.kv { width: 100%%; border-collapse: collapse; }
.kv td { padding: 1.5mm 2mm; border-bottom: .2mm solid #e8e8ec; }
.kv td.k { color: #444; width: 46%%; }
.kv td.v { text-align: right; font-weight: 600; }
.kv tr.total td { border-bottom: none; border-top: .5mm solid #1a1a1a; font-weight: 700; font-size: 10.5pt; padding-top: 2.2mm; }
.pos { color: #1c7a35; }
.neg { color: #b3341f; }

/* 分人明细 */
.pt { width: 100%%; border-collapse: collapse; margin-top: 1mm; }
.pt th { background: #f2f2f5; font-size: 8.6pt; font-weight: 600; color: #444;
         padding: 1.6mm 2mm; border: .25mm solid #d8d8de; text-align: left; }
.pt td { padding: 1.5mm 2mm; border: .25mm solid #e2e2e8; }
.pt td.r { text-align: right; }
.pt td.c { text-align: center; }
.pt .box { display: inline-block; width: 3.4mm; height: 3.4mm; border: .3mm solid #888; vertical-align: -.4mm; }
.pt tr.done td { color: #999; }
.pt tr.done td:first-child { text-decoration: line-through; }

/* 逐节明细 */
.dt { width: 100%%; border-collapse: collapse; }
.dt th { background: #f2f2f5; font-size: 8.2pt; font-weight: 600; color: #444;
         padding: 1.8mm 1.6mm; border: .25mm solid #d8d8de; }
.dt td { padding: 1.3mm 1.6mm; border: .25mm solid #e2e2e8; font-size: 8.6pt; vertical-align: top; }
.dt td.r { text-align: right; }
.dt td.c { text-align: center; }
.dt td.ct { font-size: 8.2pt; color: #666; }
.dt tr { break-inside: avoid; page-break-inside: avoid; }
.dt thead { display: table-header-group; }
.tag { display: inline-block; padding: .3mm 1.4mm; border-radius: 1mm; font-size: 7.6pt; white-space: nowrap; }
.tag.out { background: #e8f8ec; color: #1c7a35; }
.tag.in  { background: #fff3e0; color: #9a6206; }
.tag.swap{ background: #f7ebfc; color: #8534ad; }

.sign { margin-top: 7mm; display: flex; justify-content: space-between; font-size: 9.5pt;
        break-inside: avoid; page-break-inside: avoid; }
.sign div { width: 46%%; }
.sign .line { border-bottom: .3mm solid #999; height: 8mm; }
.sign .lb { color: #666; font-size: 8.6pt; margin-top: 1mm; }
.foot { margin-top: 4mm; font-size: 7.8pt; color: #999; text-align: center; line-height: 1.6; }
.tail { break-inside: avoid; page-break-inside: avoid; }
""" % {"cjk": CJK, "serif": SERIF}


def build_html(d):
    s = d.get("summary") or {}
    sch = d.get("scheduled") or {}
    people = d.get("people") or []
    rows = d.get("rows") or []
    net = s.get("net") or {}
    direction = net.get("direction") or "even"
    net_amt = abs(float(net.get("amount") or 0))
    net_hours = abs(float(net.get("hours") or 0))

    if direction == "even":
        net_txt = "已平（无需互相转账）"
        net_cls = ""
    else:
        net_txt = ("应收" if direction == "receivable" else "应付") + " " + money(net_amt) + " 元"
        net_cls = "pos" if direction == "receivable" else "neg"

    # 分人明细
    p_html = ""
    if people:
        prs = []
        for p in people:
            done = " done" if p.get("settled") else ""
            dir_txt = "应收" if p.get("direction") == "out" else "应付"
            dir_cls = "pos" if p.get("direction") == "out" else "neg"
            box = '<span class="box"></span>' if p.get("settled") else ""
            prs.append(
                f'<tr class="pt-row{done}"><td>{esc(p.get("name"))}</td>'
                f'<td class="c"><span class="{dir_cls}">{dir_txt}</span></td>'
                f'<td class="r">{esc(p.get("hours"))}</td>'
                f'<td class="r">{money(p.get("amount"))}</td>'
                f'<td class="c">{box}</td></tr>')
        p_html = f"""
        <div class="sec-t">二、分人结算明细</div>
        <table class="pt">
          <thead><tr><th>对象</th><th style="width:16mm;text-align:center">方向</th>
            <th style="width:18mm;text-align:right">课时</th><th style="width:24mm;text-align:right">金额(元)</th>
            <th style="width:16mm;text-align:center">已结清</th></tr></thead>
          <tbody>{''.join(prs)}</tbody>
        </table>
        <div style="font-size:7.8pt;color:#888;margin-top:1.5mm">※ 已结清的记录不再计入本期净额，避免重复结算。</div>
        """
    else:
        p_html = """
        <div class="sec-t">二、分人结算明细</div>
        <div style="color:#888;font-size:9pt;padding:2mm 0">本期没有代课，无需与任何人结算。</div>
        """

    # 逐节明细
    trs = []
    for r in rows:
        t = r.get("sub_type") or "normal"
        if t == "替他人上":
            tag = f'<span class="tag out">我代 {esc(r.get("peer_name"))}</span>'
        elif t == "他人替我上":
            tag = f'<span class="tag in">{esc(r.get("peer_name"))} 代我</span>'
        elif t == "换课":
            tag = f'<span class="tag swap">与 {esc(r.get("peer_name"))} 互换</span>'
        else:
            tag = '<span style="color:#bbb">—</span>'
        # 课时为 0（别人代我）时浅灰显示，避免被误认为漏填
        h_cell = f'<span style="color:#b0b0b6">0</span>' if float(r.get("hours") or 0) == 0 else esc(r.get("hours"))
        trs.append(
            f'<tr><td class="c">{esc(str(r.get("date") or "")[5:])}</td>'
            f'<td class="c">{esc(r.get("period") or "")}</td>'
            f'<td>{esc(r.get("class_name") or "")}</td>'
            f'<td class="ct">{esc(r.get("content") or "")}</td>'
            f'<td class="c">{h_cell}</td>'
            f'<td class="c">{tag}</td></tr>')

    rows_html = f"""
    <div class="sec-t">三、逐节明细（{len(rows)} 条）</div>
    <table class="dt">
      <thead><tr><th style="width:14mm">日期</th><th style="width:12mm">节次</th>
        <th style="width:24mm">班级</th><th>上课内容</th>
        <th style="width:12mm">课时</th><th style="width:30mm">代课说明</th></tr></thead>
      <tbody>{''.join(trs) if trs else '<tr><td colspan="6" style="text-align:center;color:#999;padding:6mm">本月没有上课记录</td></tr>'}</tbody>
    </table>
    <div style="font-size:7.8pt;color:#888;margin-top:1.5mm">
      ※ 课时列为 0 的，表示这节课由他人代上，课时归代课人，不计入本人。
    </div>
    """

    return f"""<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<style>{CSS}</style></head><body>
  <div class="head">
    <h1>{esc(d.get("month_label"))} 课时对账单</h1>
    <div class="meta">
      <span>{esc(d.get("teacher") or "")}</span>
      {('<span>' + esc(d.get("school")) + '</span>') if d.get("school") else ''}
      {('<span>' + esc(d.get("subject")) + '</span>') if d.get("subject") else ''}
      <span>制表日期 {esc(d.get("created"))}</span>
    </div>
  </div>

  <div class="sec-t">一、课时汇总</div>
  <table class="tri">
    <tr>
      <td><span class="k">课表排课</span><span class="v">{esc(sch.get("total", 0))}<span class="u">节</span></span></td>
      <td><span class="k">实际授课</span><span class="v">{esc(s.get("total_hours", 0))}<span class="u">节</span></span></td>
      <td><span class="k">请假代课</span><span class="v">{esc(s.get("sub_in", {}).get("count", 0))}<span class="u">节</span></span></td>
    </tr>
    <tr><td class="note" colspan="3">
      排课按课表整月推算；实际授课 = 正常上课 + 我代他人 + 换课；请假代课的课时归代课人，不计入本人。
    </td></tr>
  </table>

  <table class="kv">
    <tr><td class="k">正常上课</td><td class="v">{esc(s.get("normal_count", 0))} 节</td></tr>
    <tr><td class="k">我代他人上课（应收）</td><td class="v pos">{esc(s.get("sub_out", {}).get("hours", 0))} 节 / {money(s.get("sub_out", {}).get("amount"))} 元</td></tr>
    <tr><td class="k">他人代我上课（应付）</td><td class="v neg">{esc(s.get("sub_in", {}).get("hours", 0))} 节 / {money(s.get("sub_in", {}).get("amount"))} 元</td></tr>
    <tr><td class="k">换课（不计账，仅备查）</td><td class="v">{esc(s.get("swap", {}).get("count", 0))} 次</td></tr>
    <tr><td class="k">课时单价</td><td class="v">{money(d.get("price"))} 元 / 节</td></tr>
    <tr class="total"><td class="k">本期净额（未结清部分）</td><td class="v {net_cls}">{net_txt}</td></tr>
  </table>

  {p_html}
  {rows_html}

  <div class="tail">
    <div class="sign">
      <div><div class="line"></div><div class="lb">本人签字 / 日期</div></div>
      <div><div class="line"></div><div class="lb">财务核对 / 日期</div></div>
    </div>
    <div class="foot">
      本单由「我的工作台」自动生成，课时与金额均以系统记录为准。<br>
      如有异议，请在签字前与制表人核对逐节明细。
    </div>
  </div>
</body></html>"""


def main():
    out = sys.argv[1]
    raw = sys.stdin.read()
    data = json.loads(raw or "{}")
    HTML(string=build_html(data), base_url=".").write_pdf(out)
    print(out)


if __name__ == "__main__":
    main()
