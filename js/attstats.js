/* ============ 考勤统计表（PRD FR-STAT） ============
 *
 * 按年级独立、按老师汇总：上课节数 / 教研次数 / 请假（次数、病假、事假、
 * 上午/下午/全天、累计时长）。临时老师单独成行，末尾给一条合计。
 *
 * 时间维度两套：
 *  · 近 12 个月（滚动，默认）：一排月份 chips，点哪个看哪个月；
 *  · 按年归档：年份左右翻页，年内 1~12 月再点。
 * 数据本身存后端算（localapi /attendance/stats），这里只做展示和导出 Excel。
 */

import { api, el, esc, toast, sheet, saving, saveBlob } from './core.js';
import { icon } from './ui.js';
import { makeXlsx } from './attendance.js';
import { recentMonthKeys } from './attendance-export.mjs';

const pad2 = (n) => String(n).padStart(2, '0');
const ymKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
const monthCN = (k) => `${Number(k.slice(5))}`; /* '2026-03' → '3' */

/* 最近 n 个月（含本月），从旧到新 */
function recentMonths(n) {
  return recentMonthKeys(new Date(), n);
}

const COLS = [
  /* 「坐班天数」跟「上课节数」不是一个口径：坐班表按节次一天可能好几张，
     直接数张数会把一个人算成三四次。天数按日期去重，交财务看的是这个。 */
  ['姓名', 'name'], ['学科', 'subject'], ['上课节数', 'classes'], ['教研次数', 'research'], ['坐班天数', 'days'],
  ['请假次数', 'leaves'], ['未到', 'absent'], ['病假', 'sick'], ['事假', 'personal'], ['未注明', 'unknown'],
  ['上午', 'am'], ['下午', 'pm'], ['全天', 'full'], ['请假时长(天)', 'hours'],
];

export async function statsSheet(grade, container = null) {
  const thisYear = String(new Date().getFullYear());
  let year = thisYear;
  let mode = 'recent';            /* recent | year */
  let sel = 'ALL';                /* 'ALL' = 全年汇总；'YYYY-MM' = 某个月 */
  let data = null;
  let loading = false;

  const markup = `<div class="stt-body">
    <div class="stt-bar">
      <button class="btn ghost sm" id="stt-prev" title="上一年">${icon('left', 14)}</button>
      <div class="stt-ym" id="stt-ym"></div>
      <button class="btn ghost sm" id="stt-next" title="下一年">${icon('right', 14)}</button>
      <div class="seg stt-mode" id="stt-mode">
        <button class="seg-btn on" data-m="recent">近 12 个月</button>
        <button class="seg-btn" data-m="year">按年归档</button>
      </div>
      <span style="flex:1"></span>
      <button class="btn ghost sm" id="stt-xlsx">${icon('download', 14)} 导出 Excel</button>
    </div>
    <div class="stt-months" id="stt-months"></div>
    <div class="stt-note tiny muted" id="stt-note"></div>
    <div class="table-wrap stt-table" id="stt-table"></div>
  </div>`;
  const body = container || el(markup);
  if (container) body.innerHTML = markup;
  const s = container ? null : sheet({ title: `${grade} · 考勤统计`, body, wide: true, cls: 'stt-sheet' });
  const $ = (x) => body.querySelector(x);

  const monthKeys = () => (mode === 'recent' ? recentMonths(12) : Array.from({ length: 12 }, (_, i) => `${year}-${pad2(i + 1)}`));

  const rowsOf = () => {
    if (!data) return { rows: [], agg: null };
    if (sel === 'ALL') return { rows: data.year_rows || [], agg: data.year_temp_agg };
    const m = (data.months || []).find((x) => x.month === sel);
    return { rows: m ? m.rows : [], agg: m ? m.temp_agg : null };
  };

  const currentRows = () => rowsOf().rows;

  const load = async () => {
    loading = true;
    paintBar();
    $('#stt-note').textContent = '读取中…';
    try {
      if (mode === 'recent') {
        const previous = String(Number(year) - 1);
        const [currentYearData, previousYearData] = await Promise.all([
          api.get('/attendance/stats', { grade, year }),
          api.get('/attendance/stats', { grade, year: previous }),
        ]);
        const byMonth = new Map();
        for (const row of [...(previousYearData.months || []), ...(currentYearData.months || [])]) {
          byMonth.set(row.month, row);
        }
        data = {
          ...currentYearData,
          months: [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month)),
        };
      } else {
        data = await api.get('/attendance/stats', { grade, year });
      }
    } catch (e) {
      data = null;
      toast(e.message || '统计读取失败', 'err');
    }
    loading = false;
    paint();
  };

  const paintBar = () => {
    $('#stt-ym').textContent = mode === 'recent' ? `${year} 年及前后` : `${year} 年`;
    $('#stt-note').textContent = loading ? '读取中…' : '';
  };

  const paint = () => {
    paintBar();
    const has = new Set((data?.months || []).map((m) => m.month));
    const keys = monthKeys();
    /* 默认选中：近 12 月模式选本月；按年模式选年内有数据的最近一个月 */
    if (sel === 'AUTO') {
      const cur = ymKey(new Date());
      if (mode === 'recent') sel = keys.includes(cur) ? cur : keys[keys.length - 1];
      else {
        const withData = keys.filter((k) => has.has(k));
        sel = withData.length ? withData[withData.length - 1] : 'ALL';
      }
    }
    $('#stt-months').innerHTML = keys.map((k) => {
      const on = sel === k;
      const dot = has.has(k);
      const label = mode === 'recent' ? `${monthCN(k)}月` : `${monthCN(k)}月`;
      return `<button class="stt-chip${on ? ' on' : ''}${dot ? ' has' : ''}" data-k="${k}">${label}${dot ? '<i></i>' : ''}</button>`;
    }).join('') + (mode === 'year'
      ? `<button class="stt-chip stt-chip-all${sel === 'ALL' ? ' on' : ''}" data-k="ALL">全年汇总</button>`
      : '');
    $('#stt-months').querySelectorAll('[data-k]').forEach((b) => {
      b.onclick = () => { sel = b.dataset.k; paint(); };
    });
    paintTable();
  };

  const paintTable = () => {
    const { rows, agg } = rowsOf();
    if (!data) { $('#stt-table').innerHTML = '<div class="att-empty">没有读到统计数据</div>'; return; }
    if (!rows.length) {
      $('#stt-table').innerHTML = `<div class="att-empty">${sel === 'ALL'
        ? `${year} 年「${esc(grade)}」还没有任何考勤表`
        : `${esc(sel)} 这个月没有考勤记录`}</div>`;
      return;
    }
    const rangeText = sel === 'ALL' ? `${year} 年全年` : `${sel}`;
    const trs = rows.map((r) => `<tr${r.temp ? ' class="stt-temp"' : ''}>
      <td class="bold">${esc(r.name)}${r.temp ? ' <span class="stt-badge">临时</span>' : ''}</td>
      <td>${esc(r.subject || '')}</td>
      <td>${r.classes}</td><td>${r.research}</td><td>${r.days || ''}</td>
      <td${r.leaves ? ' style="color:var(--red);font-weight:700"' : ''}>${r.leaves}</td>
      <td${r.absent ? ' style="color:var(--amber);font-weight:700"' : ''}>${r.absent}</td>
      <td>${r.sick}</td><td>${r.personal}</td><td>${r.unknown}</td>
      <td>${r.am}</td><td>${r.pm}</td><td>${r.full}</td>
      <td>${r.hours ? String(Math.round(r.hours * 10) / 10) : ''}</td>
    </tr>`).join('');
    const aggTr = agg ? `<tr class="stt-agg">
      <td class="bold">${esc(agg.name)}</td><td>—</td>
      <td>${agg.classes}</td><td>${agg.research}</td><td>${agg.days || ''}</td><td>${agg.leaves}</td><td>${agg.absent}</td>
      <td>${agg.sick}</td><td>${agg.personal}</td><td>${agg.unknown}</td>
      <td>${agg.am}</td><td>${agg.pm}</td><td>${agg.full}</td>
      <td>${Math.round(agg.hours * 10) / 10}</td></tr>` : '';
    $('#stt-table').innerHTML = `<table class="tbl">
      <thead><tr>${COLS.map(([h]) => `<th>${h}</th>`).join('')}</tr></thead>
      <tbody>${trs}${aggTr}</tbody></table>`;
    $('#stt-note').textContent = `${rangeText} · ${rows.filter((r) => !r.temp).length} 位在册老师`
      + `${agg ? ` · ${rows.filter((r) => r.temp).length} 位临时老师` : ''} · 「未到」只算格子上明确划了 ×、或已确认却仍然空着的`;
  };

  body.querySelectorAll('#stt-mode .seg-btn').forEach((b) => {
    b.onclick = () => {
      if (b.dataset.m === mode) return;
      body.querySelectorAll('#stt-mode .seg-btn').forEach((x) => x.classList.toggle('on', x === b));
      mode = b.dataset.m;
      sel = 'AUTO';
      paint();
    };
  });
  $('#stt-prev').onclick = () => { year = String(Number(year) - 1); mode = 'year'; body.querySelectorAll('#stt-mode .seg-btn').forEach((x) => x.classList.toggle('on', x.dataset.m === 'year')); sel = 'AUTO'; load(); };
  $('#stt-next').onclick = () => { year = String(Number(year) + 1); mode = 'year'; body.querySelectorAll('#stt-mode .seg-btn').forEach((x) => x.classList.toggle('on', x.dataset.m === 'year')); sel = 'AUTO'; load(); };

  $('#stt-xlsx').onclick = saving($('#stt-xlsx'), async () => {
    const { rows, agg } = rowsOf();
    if (!rows.length) return toast('当前视图没有数据，先选个有记录的月份', 'warn');
    const range = sel === 'ALL' ? `${year}年` : `${sel.replace('-', '年')}月`;
    const grid = [
      [`${grade} 教师考勤统计 · ${range}`],
      COLS.map(([h]) => h),
      ...rows.map((r) => COLS.map(([, k]) => (k === 'hours' ? (r.hours ? Math.round(r.hours * 10) / 10 : '') : r[k] ?? ''))),
      ...(agg ? [COLS.map(([, k]) => (k === 'name' ? agg.name : k === 'subject' ? '—' : k === 'hours' ? Math.round(agg.hours * 10) / 10 : agg[k]))] : []),
    ];
    const blob = makeXlsx({ title: `${grade}考勤统计${range}`, grid });
    saveBlob(blob, `${grade}考勤统计-${range}.xlsx`);
    toast('Excel 已生成，可直接交财务或存档');
  });

  sel = 'AUTO';
  await load();
}
