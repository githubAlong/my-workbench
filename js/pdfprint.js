/* ============================================================================
   pdfprint.js —— 静态版里替代「服务端生成 PDF」的那一步

   原来这两个功能是服务端跑 Python + WeasyPrint 吐真 PDF：
     · 考勤表导出 PDF（GET /api/attendance/:id/pdf）
     · 课时对账单 A4 竖版（GET /api/lessons/statement）
   GitHub Pages 上跑不了 Python，所以改成「本地拼一份 A4 排版的 HTML，
   新窗口打开 + 自动调起打印」。用户点「打印 → 另存为 PDF」拿到的就是原效果，
   @page 尺寸、页边距、签字栏都按 A4 写死了，打印出来和原来一致。

   为什么不用 jsPDF 在前端硬生成 PDF：
   中文字体要嵌 5MB 以上的 TTF，静态站点首屏会为这个功能多下好几兆，
   而浏览器自带的「打印为 PDF」既免费又保真。
   ========================================================================== */

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function openPrint(html, title) {
  const w = window.open('', '_blank');
  if (!w) return false;
  w.document.open();
  w.document.write(html);
  w.document.close();
  w.document.title = title;
  // 等字体和布局就绪再弹打印框，否则会打出半截空白页
  const go = () => { try { w.focus(); w.print(); } catch { /* 用户可能已经关了 */ } };
  if (w.document.readyState === 'complete') setTimeout(go, 320);
  else w.addEventListener('load', () => setTimeout(go, 320));
  return true;
}

const BASE_CSS = `
@page { size: A4; margin: 14mm 12mm; }
* { box-sizing: border-box; }
body { font-family: -apple-system, "PingFang SC", "Microsoft YaHei", "Source Han Sans SC", sans-serif;
       color: #1b2333; margin: 0; font-size: 12.5px; line-height: 1.5; }
h1 { font-size: 20px; margin: 0 0 6px; letter-spacing: .5px; }
.meta { color: #667085; font-size: 11.5px; margin-bottom: 12px; }
table { width: 100%; border-collapse: collapse; font-size: 11.5px; }
th, td { border: 1px solid #c8d0dd; padding: 5px 7px; text-align: left; vertical-align: top; }
th { background: #eff3fa; font-weight: 600; }
tr:nth-child(even) td { background: #fafbfd; }
.sec { font-weight: 700; margin: 14px 0 6px; font-size: 13px; }
.sum { margin-top: 10px; font-size: 12.5px; font-weight: 600; }
.sign { margin-top: 30px; display: flex; justify-content: space-between; font-size: 12px; color: #344054; }
.tip { margin-top: 18px; padding: 10px 12px; background: #f2f6ff; border-left: 3px solid #3c7bf6;
       font-size: 11.5px; color: #344054; border-radius: 4px; }
@media print { .tip { display: none; } }
`;

const TIP = '<div class="tip">这份内容是浏览器直接排版的：在打印对话框里选择「另存为 PDF / 保存为 PDF」即可得到文件。'
  + '如果表格被切断，把缩放调成「适合页面宽度」。</div>';

/* ---------------- 考勤表 PDF ---------------- */
/* payload 与 server/index.mjs 里 /api/attendance/:id/pdf 拼的一样，
   所以样式和原来服务端 Python 出的那份基本对齐。 */
export function printAttendance(payload) {
  const cols = payload.columns || [];
  const checkCols = cols.filter((c) => c.type === 'check');
  const otherCols = cols.filter((c) => c.type !== 'check');
  const head = ['序号', '姓名', '学科', ...cols.map((c) => c.label)];
  const body = (payload.rows || []).map((r) => [r.no, r.name, r.subject, ...(r.marks || [])]);

  const summary = (payload.summary || [])
    .map((s) => `<span style="margin-right:18px">${esc(s.label)}：<b>${esc(s.value)}</b></span>`).join('');

  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(payload.title)}</title>
<style>${BASE_CSS}
.hd { text-align: center; margin-bottom: 14px; }
.hd .t { font-size: 19px; font-weight: 700; letter-spacing: 2px; }
.hd .s { font-size: 12px; color: #475467; margin-top: 6px; }
.mark { text-align: center; }
</style></head><body>
<div class="hd">
  <div class="t">${esc(payload.title || '考勤表')}</div>
  <div class="s">${esc(payload.grade || '')}　${esc(payload.date_text || '')}　${esc(payload.weekday || '')}　${esc(payload.periods || '')}</div>
</div>
<table>
  <thead><tr>${head.map((h, i) => `<th${i >= 3 ? ' class="mark"' : ''}>${esc(h)}</th>`).join('')}</tr></thead>
  <tbody>${body.map((r, i) => `<tr>${r.map((c, j) => `<td${j >= 3 ? ' class="mark"' : ''}>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody>
</table>
<div class="sum">${summary}</div>
<div class="sign"><span>制表人：__________</span><span>审核人：__________</span><span>${esc(payload.footer || '')}</span></div>
${TIP}
</body></html>`;
  return openPrint(html, payload.title || '考勤表');
}

/* ---------------- 课时对账单（A4 竖版，可签字） ---------------- */
export function printStatement(p) {
  const s = p.summary || {};
  const net = s.net || { amount: 0, direction: 'even' };
  const netTxt = net.direction === 'even' ? '已平' : `${net.direction === 'receivable' ? '应收' : '应付'} ¥${Math.abs(net.amount || 0).toFixed(2)}`;

  const peopleRows = (p.people || []).map((x) => `<tr>
    <td>${esc(x.name)}</td>
    <td>${x.direction === 'out' ? '我代他人' : '他人代我'}</td>
    <td style="text-align:right">${x.hours}</td>
    <td style="text-align:right">¥${Number(x.amount || 0).toFixed(2)}</td>
    <td>${x.settled ? '已结清' : '未结清'}</td>
  </tr>`).join('') || '<tr><td colspan="5" style="text-align:center;color:#98a2b3">本月没有代课往来</td></tr>';

  const lessonRows = (p.rows || []).map((r) => `<tr>
    <td>${esc(r.date)}</td>
    <td>${esc(r.period)}</td>
    <td>${esc(r.class_name)}</td>
    <td>${esc(r.subject)}</td>
    <td>${esc(r.content)}</td>
    <td style="text-align:right">${esc(r.hours)}</td>
    <td>${esc(r.sub_type === 'normal' ? '' : r.sub_type)}${r.peer_name ? ' ' + esc(r.peer_name) : ''}</td>
  </tr>`).join('');

  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(p.month_label)}课时对账单</title>
<style>${BASE_CSS}
.hd { text-align: center; margin-bottom: 16px; }
.hd .t { font-size: 21px; font-weight: 700; letter-spacing: 4px; }
.hd .s { font-size: 12px; color: #475467; margin-top: 8px; }
.kv { display: flex; flex-wrap: wrap; gap: 6px 26px; font-size: 12.5px; margin-bottom: 12px; }
.kv b { font-weight: 600; }
.net { margin-top: 14px; padding: 10px 14px; background: #eff3fa; border-radius: 6px; font-size: 14px; font-weight: 700; }
</style></head><body>
<div class="hd">
  <div class="t">课时对账单</div>
  <div class="s">${esc(p.month_label)}　${esc(p.teacher || '')}${p.school ? '　' + esc(p.school) : ''}${p.subject ? '　' + esc(p.subject) : ''}</div>
</div>
<div class="kv">
  <span>课时单价：<b>¥${esc(p.price)}</b>/节</span>
  <span>实际授课：<b>${esc(s.lesson_count || 0)}</b> 节 / <b>${esc(s.total_hours || 0)}</b> 课时</span>
  <span>课表排课：<b>${esc(p.scheduled?.total ?? 0)}</b> 节</span>
  <span>制表日期：${esc(p.created || '')}</span>
</div>

<div class="sec">一、代课往来</div>
<table>
  <thead><tr><th>对方</th><th>方向</th><th style="text-align:right">课时</th><th style="text-align:right">金额</th><th>状态</th></tr></thead>
  <tbody>${peopleRows}</tbody>
</table>
<div class="net">本月净额：${netTxt}（只算未结清部分）</div>

<div class="sec">二、逐节明细</div>
<table>
  <thead><tr><th>日期</th><th>节次</th><th>班级</th><th>科目</th><th>上课内容</th><th style="text-align:right">课时</th><th>代课</th></tr></thead>
  <tbody>${lessonRows || '<tr><td colspan="7" style="text-align:center;color:#98a2b3">本月没有上课记录</td></tr>'}</tbody>
</table>

<div class="sign"><span>任课教师签字：__________</span><span>教研组长签字：__________</span><span>日期：${esc(p.created || '')}</span></div>
${TIP}
</body></html>`;
  return openPrint(html, `${p.month_label}课时对账单`);
}
