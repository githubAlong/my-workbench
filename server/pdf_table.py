#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把考勤表渲染成横版 A4 PDF。Node 侧通过 stdin 传 JSON，stdout 回写文件路径。
用法：echo '{...}' | python3 pdf_table.py /path/out.pdf
JSON 结构：{title, subtitle, grade, date_text, weekday, periods, columns:[{label,type}], rows:[{no,name,subject,marks:[...]}], summary:[{label,value}], footer}
"""
import sys
import json
import html as _html

from weasyprint import HTML

CJK = '"Noto Sans CJK SC", "Noto Serif CJK SC", "WenQuanYi Zen Hei", sans-serif'
SERIF = '"Noto Serif CJK SC", "Noto Sans CJK SC", serif'


def esc(v):
    return _html.escape(str(v if v is not None else ""))


def build_html(d):
    cols = d.get("columns") or []
    rows = d.get("rows") or []
    summary = d.get("summary") or []
    check_cols = [c for c in cols if c.get("type") == "check"]
    other_cols = [c for c in cols if c.get("type") != "check"]

    # 表头：序号 姓名 学科 + 勾选列 + 备注
    head = ['<th class="c-no">序号</th>', '<th class="c-name">姓名</th>', '<th class="c-subj">学科</th>']
    head += [f'<th class="c-chk">{esc(c.get("label"))}</th>' for c in check_cols]
    head += [f'<th class="c-remark">{esc(c.get("label"))}</th>' for c in other_cols]

    body_rows = []
    for r in rows:
        marks = r.get("marks") or []
        tds = [f'<td class="c-no">{esc(r.get("no"))}</td>',
               f'<td class="c-name">{esc(r.get("name"))}</td>',
               f'<td class="c-subj">{esc(r.get("subject"))}</td>']
        for i, c in enumerate(check_cols):
            v = marks[i] if i < len(marks) else ""
            cls = "tick-ok" if v == "1" else "tick-no" if v == "0" else "tick-blank"
            sym = "✓" if v == "1" else "×" if v == "0" else ""
            tds.append(f'<td class="c-chk"><span class="{cls}">{sym}</span></td>')
        for j in range(len(other_cols)):
            idx = len(check_cols) + j
            tds.append(f'<td class="c-remark">{esc(marks[idx] if idx < len(marks) else "")}</td>')
        body_rows.append("<tr>" + "".join(tds) + "</tr>")

    # 行数多时自动两栏排版（横版 A4 有空间）
    html_rows = "\n".join(body_rows)

    meta_bits = []
    for k in ("grade", "date_text", "weekday", "periods"):
        if d.get(k):
            meta_bits.append(f'<span class="meta-i">{esc(d.get(k))}</span>')

    summary_html = ""
    if summary:
        items = "".join(
            f'<div class="sm-item"><span class="sm-l">{esc(s.get("label"))}</span>'
            f'<span class="sm-v">{esc(s.get("value"))}</span></div>'
            for s in summary
        )
        summary_html = f'<div class="summary">{items}</div>'

    return f"""<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>{esc(d.get("title"))}</title>
<style>
@page {{
  size: A4 landscape;
  margin: 8mm 8mm 10mm;
  @bottom-center {{
    content: "第 " counter(page) " / " counter(pages) " 页";
    font-family: {CJK}; font-size: 8pt; color: #9a9a9a;
  }}
}}
* {{ box-sizing: border-box; }}
body {{ font-family: {CJK}; color: #1b1b1f; margin: 0; }}
.head {{ text-align: center; margin-bottom: 4.5mm; }}
.title {{ font-family: {SERIF}; font-size: 19pt; font-weight: 700; letter-spacing: .06em; margin: 0 0 2.2mm; }}
.meta {{ display: flex; justify-content: center; gap: 5mm; flex-wrap: wrap; font-size: 10.5pt; color: #4a4a52; }}
.meta-i {{ position: relative; }}
.meta-i + .meta-i::before {{
  content: ""; position: absolute; left: -2.6mm; top: .6mm; height: 3.6mm;
  border-left: .3mm solid #d4d4d8;
}}
table {{ width: 100%; border-collapse: collapse; font-size: 10pt; }}
tr {{ break-inside: avoid; page-break-inside: avoid; }}
thead {{ break-after: avoid; }}
thead {{ display: table-header-group; }}
th {{
  background: #f2f2f5; font-weight: 700; font-size: 9.5pt; color: #3a3a42;
  border: .3mm solid #c8c8d0; padding: 1.8mm .5mm; text-align: center;
}}
td {{
  border: .25mm solid #dcdce2; padding: .6mm .5mm; text-align: center;
  height: 4.6mm; line-height: 1.15; vertical-align: middle;
}}
tbody tr:nth-child(even) td {{ background: #fafafc; }}
.c-no {{ width: 11mm; color: #9a9aa2; font-size: 8.5pt; }}
.c-name {{ width: 24mm; text-align: left; padding-left: 2.4mm; font-weight: 600; letter-spacing: .03em; }}
.c-subj {{ width: 16mm; color: #55555f; }}
.c-chk {{ width: 22mm; }}
.c-remark {{ width: auto; text-align: left; padding-left: 2mm; font-size: 9pt; color: #4a4a52; }}
.tick-ok {{ display: inline-block; font-size: 13pt; font-weight: 700; color: #1b1b1f; line-height: 1; }}
.tick-no {{ display: inline-block; font-size: 12pt; color: #b8b8c0; line-height: 1; }}
.tick-blank {{ display: inline-block; }}
.summary {{
  margin-top: 3.5mm; padding: 3mm 5mm; border: .3mm solid #d8d8de; border-radius: 2mm;
  background: #fafafb; display: flex; flex-wrap: nowrap; gap: 7mm; font-size: 9.5pt;
  break-inside: avoid; page-break-inside: avoid;
}}
.sm-item {{ display: flex; align-items: baseline; gap: 2mm; white-space: nowrap; flex: 0 0 auto; }}
.sm-l {{ color: #77777f; white-space: nowrap; }}
.sm-v {{ font-weight: 700; font-size: 11pt; color: #1b1b1f; white-space: nowrap; }}
.footer {{ margin-top: 3mm; font-size: 8pt; color: #a5a5ad; text-align: right; }}
</style></head>
<body>
  <div class="head">
    <div class="title">{esc(d.get("title"))}</div>
    <div class="meta">{"".join(meta_bits)}</div>
  </div>
  <table>
    <thead><tr>{"".join(head)}</tr></thead>
    <tbody>
{html_rows}
    </tbody>
  </table>
  {summary_html}
  <div class="footer">{esc(d.get("footer") or "")}</div>
</body></html>"""


def main():
    raw = sys.stdin.read()
    data = json.loads(raw)
    out = sys.argv[1]
    HTML(string=build_html(data)).write_pdf(out)
    sys.stdout.write("OK")


if __name__ == "__main__":
    main()
