/* ============ 考勤语音录入（PRD FR-VOICE） ============
 *
 * 场景：管理员站在教室门口，用手机说一句「张三 语文 上课」，
 * 连着说几个人的，说完看一眼识别列表，改掉错字再确认入库。
 *
 * 识别用浏览器自带的 Web Speech API（Chrome / 部分安卓 WebView 支持），
 * 不引任何库；没有麦克风的设备（或接口被禁）自动落到「打字版」：
 * 同样的话术，手打或粘贴进来也能解析。
 *
 * 话术：姓名 [学科] 状态，连续多条。标点可有可无——
 * 语音识别通常自己会加逗号句号，但「张三上课李四请假」这种
 * 连着说的也得能拆，解析器按「第一个状态词」切段循环处理。
 */

import { el, esc, toast, sheet } from './core.js';
import { icon } from './ui.js';

/* 状态词表：re 用来在话里找词；colRe 用来把这个词对到当前表的哪一列。
   顺序即优先级——「按时上课」要在「上课」之前，「病假/事假」要在「请假」之前，
   否则「李四病假」会先被「请假」截走，假别就丢了。 */
const STATUS_WORDS = [
  { re: /按时上课|准时|按时/, colRe: /上课|准时|按时/ },
  { re: /上完课|上课|有课/, colRe: /^上课$/ },
  { re: /坐班|在班|在办公室/, colRe: /坐班/ },
  { re: /听课/, colRe: /听课/ },
  { re: /教研/, colRe: /教研/ },
  { re: /签到|出席|到了/, colRe: /签到|出席/ },
  { re: /病假|生病|病了/, colRe: /请假/, leave: true, leaveType: '病假' },
  { re: /事假|有事/, colRe: /请假/, leave: true, leaveType: '事假' },
  { re: /请假|休假|休息/, colRe: /请假/, leave: true, leaveType: '' },
];

/* 去掉空格：语音识别偶尔会在中文中间塞空格，「张三 上课」和「张三上课」要一视同仁 */
const clean = (s) => String(s || '').replace(/[\s\u3000]+/g, '');

/**
 * 解析一段话术为条目列表（纯函数，方便单测）。
 * @param {string} text 识别出的整段文字
 * @param {{cols?: Array, subjects?: string[]}} opts cols=当前表的勾选列，subjects=名册学科
 * @returns Array<{name, subject, statusKey, statusLabel, leave, leaveType}>
 */
export function parseVoicePhrases(text, { cols = [], subjects = [] } = {}) {
  const items = [];
  const put = (it) => {
    /* 同一个人说了两遍，以最后一遍为准（说错了重说很常见） */
    const i = items.findIndex((x) => x.name === it.name);
    if (i >= 0) items[i] = it; else items.push(it);
  };
  const segs = clean(text).split(/[。；;，,、!！?？\n]+/).filter(Boolean);
  const subjList = [...new Set(subjects.filter(Boolean))].sort((a, b) => b.length - a.length);
  for (let seg of segs) {
    /* 段内还可能连着好几个人（没标点的情况），循环切 */
    let guard = 0;
    while (seg && guard++ < 40) {
      /* 找最早出现的状态词；同位置取更长的（「病假」优先于「请假」） */
      let best = null;
      for (const w of STATUS_WORDS) {
        const m = w.re.exec(seg);
        if (!m) continue;
        if (!best || m.index < best.m.index || (m.index === best.m.index && m[0].length > best.m[0].length)) {
          best = { w, m };
        }
      }
      if (!best) break; /* 剩下的不是状态话术，丢弃 */
      let namePart = seg.slice(0, best.m.index);
      seg = seg.slice(best.m.index + best.m[0].length);
      /* 段尾可能拖着「了」「的」「是在」这类尾巴，先剥掉 */
      namePart = namePart.replace(/(是在|就是|的话)+$/g, '');
      /* 学科：通常跟在姓名后面。只有剥掉学科后姓名还剩 ≥2 个字才剥，
         否则「王语」这种名字会被拆成 王 + 语文。 */
      let subject = '';
      for (const s of subjList) {
        const i = namePart.indexOf(s);
        if (i >= 0 && namePart.length - s.length >= 2) {
          subject = s;
          namePart = namePart.slice(0, i) + namePart.slice(i + s.length);
          break;
        }
      }
      const name = namePart.replace(/^(说|那个|还有|以及)+/g, '');
      if (name.length < 2) continue; /* 不到两个字不算人名 */
      /* 状态对到列：按 colRe 匹配当前表的列；匹配不上（比如教研表里说「坐班」）就置空，
         让用户在确认列表里自己选。 */
      let statusKey = null;
      let statusLabel = best.w.leave ? '请假' : (best.m[0] || '');
      if (!best.w.leave) {
        const col = cols.find((c) => c.type === 'check' && best.w.colRe.test(c.label));
        if (col) { statusKey = col.key; statusLabel = col.label; }
      }
      put({ name, subject, statusKey, statusLabel, leave: !!best.w.leave, leaveType: best.w.leaveType || '' });
    }
  }
  return items;
}

/* ============ 语音录入弹层 ============ */
/**
 * @param {{rows: Array, cols: Array, isClass?: boolean, onApply: (items)=>void}} opts
 * rows=当前表的人（提供学科列表和姓名 datalist），cols=勾选列
 */
export function voiceSheet({ rows = [], cols = [], isClass = false, onApply }) {
  const checkCols = cols.filter((c) => c.type === 'check');
  const subjects = [...new Set(rows.map((r) => r.subject).filter(Boolean))];
  const names = rows.map((r) => r.teacher).filter(Boolean);
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let items = [];
  let listening = false;
  let fullText = '';
  let rec = null;

  const body = el(`<div class="vv-body">
    <div class="vv-mic-zone">
      <button class="vv-mic" id="vv-mic" title="点击开始/停止">${icon('speak', 26)}</button>
      <div class="vv-state" id="vv-state">点击麦克风，说「张三 语文 上课」「李四 请假」，可以连着说多个人</div>
    </div>
    <div class="vv-live" id="vv-live" hidden></div>
    <div class="vv-fallback">
      <button class="link-btn" id="vv-toggle-manual">没有麦克风 / 接口不可用？打字或粘贴也行 →</button>
      <textarea class="input" id="vv-manual" rows="3" hidden placeholder="每条一句：张三 语文 上课&#10;李四 请假&#10;王五 数学 上课"></textarea>
      <button class="btn ghost sm" id="vv-parse" hidden>解析这些话</button>
    </div>
    <div class="vv-list-head" id="vv-lh" hidden>识别结果（核对后再应用）　<b id="vv-count"></b></div>
    <div class="vv-list" id="vv-list"></div>
    <div class="confirm-actions">
      <button class="btn ghost" id="vv-close">关闭</button>
      <button class="btn primary" id="vv-apply" disabled>应用到表格</button>
    </div>
  </div>`);
  const s = sheet({ title: '语音录入', body, wide: true, cls: 'vv-sheet' });
  const $ = (x) => body.querySelector(x);

  const statusOptions = (cur) => checkCols.map((c) =>
    `<option value="${esc(c.key)}" ${cur === c.key ? 'selected' : ''}>${esc(c.label)}</option>`).join('')
    + `<option value="__leave" ${cur === '__leave' ? 'selected' : ''}>请假</option>`;

  const paintList = () => {
    $('#vv-lh').hidden = !items.length;
    $('#vv-count').textContent = items.length ? `${items.length} 条` : '';
    $('#vv-apply').disabled = !items.length;
    $('#vv-list').innerHTML = items.map((it, i) => `<div class="vv-row" data-i="${i}">
      <input class="input vv-name" data-i="${i}" value="${esc(it.name)}" list="vv-names" placeholder="姓名">
      <input class="input vv-subj" data-i="${i}" value="${esc(it.subject || '')}" list="vv-subjs" placeholder="学科">
      <select class="input vv-st" data-i="${i}">
        ${statusOptions(it.leave ? '__leave' : it.statusKey)}
      </select>
      ${it.leave ? `<span class="vv-lv" data-i="${i}" title="点开选假别/时段/时长">${esc(it.leaveType || '假别未注明')} · ${esc(it.period || '全天')}</span>` : ''}
      <button class="icon-btn sm" data-rm="${i}" title="删除这条">${icon('close', 13)}</button>
    </div>`).join('') || `<div class="vv-empty">还没有识别到内容${SR ? '' : '（这台设备不支持语音，用上面的打字入口）'}</div>`;
    /* 打字版/语音识别都没有时直接展开手动入口 */
    if (!SR) { $('#vv-manual').hidden = false; $('#vv-parse').hidden = false; }
    body.querySelectorAll('.vv-name').forEach((inp) => {
      inp.oninput = () => { items[Number(inp.dataset.i)].name = inp.value.trim(); };
    });
    body.querySelectorAll('.vv-subj').forEach((inp) => {
      inp.oninput = () => { items[Number(inp.dataset.i)].subject = inp.value.trim(); };
    });
    body.querySelectorAll('.vv-st').forEach((sel) => {
      sel.onchange = () => {
        const it = items[Number(sel.dataset.i)];
        if (sel.value === '__leave') { it.leave = true; it.statusKey = null; it.statusLabel = '请假'; }
        else {
          it.leave = false; it.statusKey = sel.value;
          it.statusLabel = (checkCols.find((c) => c.key === sel.value) || {}).label || '';
        }
        paintList();
      };
    });
    body.querySelectorAll('.vv-lv').forEach((sp) => {
      sp.onclick = () => leaveQuick(items[Number(sp.dataset.i)], paintList);
    });
    body.querySelectorAll('[data-rm]').forEach((b) => {
      b.onclick = () => { items.splice(Number(b.dataset.rm), 1); paintList(); };
    });
  };

  const renderText = (interim) => {
    const live = $('#vv-live');
    if (!fullText && !interim) { live.hidden = true; live.textContent = ''; return; }
    live.hidden = false;
    live.innerHTML = `${esc(fullText)}<span class="vv-interim">${esc(interim || '')}</span>`;
  };

  const feed = (text) => {
    if (!text) return;
    const got = parseVoicePhrases(text, { cols: checkCols, subjects });
    /* 逐条合并：同名的覆盖（parseVoicePhrases 内部已按整段去重，
       这里再把增量结果合进现有列表） */
    for (const it of got) {
      const i = items.findIndex((x) => x.name === it.name);
      if (i >= 0) items[i] = it; else items.push(it);
    }
    paintList();
  };

  const startRec = () => {
    try {
      rec = new SR();
      rec.lang = 'zh-CN';
      rec.continuous = true;
      rec.interimResults = true;
      rec.onresult = (e) => {
        let interim = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          if (r.isFinal) { fullText += r[0].transcript; feed(fullText); }
          else interim += r[0].transcript;
        }
        renderText(interim);
      };
      rec.onerror = (e) => {
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
          toast('麦克风权限被拒绝了，去浏览器地址栏的权限里允许一下；或改用打字入口', 'err', 6000);
          stopRec();
        } else if (e.error !== 'no-speech' && e.error !== 'aborted') {
          toast('语音识别出错：' + e.error, 'warn', 4000);
        }
      };
      rec.onend = () => {
        /* 静音一会儿浏览器会自动停；用户还没喊停就接着录 */
        if (listening) { try { rec.start(); } catch { /* 连续重启偶发异常，忽略 */ } }
      };
      rec.start();
      listening = true;
      $('#vv-mic').classList.add('on');
      $('#vv-state').textContent = '正在听…（说完点麦克风结束）';
    } catch (e) {
      toast('语音识别启动不了：' + (e.message || e), 'err');
      $('#vv-manual').hidden = false;
      $('#vv-parse').hidden = false;
    }
  };
  const stopRec = () => {
    listening = false;
    $('#vv-mic').classList.remove('on');
    $('#vv-state').textContent = fullText ? '已停止。识别结果在下面，核对后应用。' : '点击麦克风开始';
    try { rec && rec.stop(); } catch { /* */ }
  };

  $('#vv-mic').onclick = () => { if (listening) stopRec(); else startRec(); };
  $('#vv-toggle-manual').onclick = () => {
    const ta = $('#vv-manual');
    ta.hidden = !ta.hidden;
    $('#vv-parse').hidden = ta.hidden;
    if (!ta.hidden) ta.focus();
  };
  $('#vv-parse').onclick = () => {
    const t = $('#vv-manual').value;
    if (!t.trim()) return toast('先打几句话进来', 'warn');
    feed(t);
  };
  $('#vv-close').onclick = () => { stopRec(); s.close(); };
  $('#vv-apply').onclick = () => {
    if (!items.length) return;
    const bad = items.filter((x) => !x.name || x.name.length < 2);
    if (bad.length) return toast('有姓名没填完整，先补上', 'warn');
    stopRec();
    s.close();
    onApply(items);
  };
  paintList();
}

/* 请假细化快捷选择：病假/事假 + 上午/下午/全天。
   时长默认按时段给（全天 1 天、半天 0.5 天），应用后还能在表格里点开改。 */
function leaveQuick(it, repaint) {
  const body = el(`<div class="sheet-body">
    <div class="field"><label class="field-label">假别</label>
      <div class="seg" style="width:100%">
        ${['病假', '事假', '未注明'].map((t) => `<button class="seg-btn${it.leaveType === t ? ' on' : ''}" data-t="${t}" style="flex:1;justify-content:center">${t}</button>`).join('')}
      </div></div>
    <div class="field"><label class="field-label">时段</label>
      <div class="seg" style="width:100%">
        ${['上午', '下午', '全天'].map((p) => `<button class="seg-btn${(it.period || '全天') === p ? ' on' : ''}" data-p="${p}" style="flex:1;justify-content:center">${p}</button>`).join('')}
      </div></div>
    <div class="field"><label class="field-label">时长（天）</label>
      <input class="input" type="number" min="0.5" step="0.5" id="lq-d" value="${esc(String(it.duration ?? ((it.period || '全天') === '全天' ? 1 : 0.5)))}"></div>
    <div class="confirm-actions"><button class="btn ghost" id="c">取消</button><button class="btn primary" id="k">好了</button></div>
  </div>`);
  const s2 = sheet({ title: '请假细化', body });
  let type = it.leaveType || '';
  let period = it.period || '全天';
  body.querySelectorAll('[data-t]').forEach((b) => {
    b.onclick = () => {
      body.querySelectorAll('[data-t]').forEach((x) => x.classList.toggle('on', x === b));
      type = b.dataset.t === '未注明' ? '' : b.dataset.t;
    };
  });
  body.querySelectorAll('[data-p]').forEach((b) => {
    b.onclick = () => {
      body.querySelectorAll('[data-p]').forEach((x) => x.classList.toggle('on', x === b));
      period = b.dataset.p;
      const d = body.querySelector('#lq-d');
      if (d) d.value = String(period === '全天' ? 1 : 0.5);
    };
  });
  body.querySelector('#c').onclick = s2.close;
  body.querySelector('#k').onclick = () => {
    it.leaveType = type;
    it.period = period;
    it.duration = Number(body.querySelector('#lq-d').value) || (period === '全天' ? 1 : 0.5);
    s2.close();
    repaint();
  };
}
