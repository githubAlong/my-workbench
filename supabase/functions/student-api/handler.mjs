/* 学生端全量 API —— 从 wb_user_data payload 读取，与 localapi.js 的 /public/link/:code* 路由对等。
   部署到自建 Supabase Edge Function 后，Cloudflare Pages 上的学生端就能从云端拿到老师同步的数据。 */

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info, ngrok-skip-browser-warning',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

function failure(status, message) { return Object.assign(new Error(message), { status }); }
const live = (row) => row && !row.deleted_at;
const num = (v) => Number(v) || 0;
function safeJSON(v, fallback = []) { try { return typeof v === 'string' ? JSON.parse(v) : v || fallback; } catch { return fallback; } }
function nowISO() { return new Date().toISOString(); }
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const LINK_MODULE_KEYS = ['material', 'roll', 'punish', 'misconduct', 'bulletin'];
function linkModules(l) {
  let raw = {};
  try { raw = JSON.parse(l?.modules || '{}') || {}; } catch { raw = {}; }
  const out = {};
  for (const k of LINK_MODULE_KEYS) out[k] = Number(raw[k]) === 0 ? 0 : 1;
  return out;
}
const stuKey = (s) => String(s || '')
  .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
  .replace(/\s+/g, '')
  .toLowerCase()
  .slice(0, 40);
const ROLL_STATUS = ['present', 'late', 'leave', 'absent'];

function findLink(payload, code) {
  const links = Array.isArray(payload.links) ? payload.links : [];
  return links.find((row) => live(row) && row.code === code && num(row.enabled) === 1);
}

function rollSessions(payload, date) {
  const sessions = Array.isArray(payload.roll_sessions) ? payload.roll_sessions : [];
  return sessions
    .filter((s) => live(s) && s.date === date)
    .sort((a, b) => (num(a.period_no) - num(b.period_no)) || a.id - b.id);
}

function rollCount(payload, sessionId) {
  const recs = (payload.roll_records || []).filter((r) => String(r.session_id) === String(sessionId));
  const c = { total: recs.length, present: 0, late: 0, leave: 0, absent: 0 };
  for (const r of recs) if (r.status in c) c[r.status] += 1;
  return c;
}

export function createStudentApiHandler({ backendUrl, serviceKey, fetchImpl = fetch }) {
  const base = backendUrl.replace(/\/$/, '');
  const headers = { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey };
  const json = (value, status = 200) => new Response(JSON.stringify(value), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
  const backend = (path, options = {}) => fetchImpl(base + path, {
    ...options, headers: { ...headers, ...options?.headers }, signal: AbortSignal.timeout(90000),
  });

  /* 路由表：按 pathname 分段匹配 */
  function matchRoute(pathname) {
    const segs = pathname.split('/').filter(Boolean);
    // /functions/v1/student-api → segs = ["functions","v1","student-api"]
    // 或直接 /public/link/:code/... → 不同部署方式
    // 兼容两种模式：Edge Function 的 pathname 是 /functions/v1/student-api?path=/public/link/xxx
    // 或者前端直接 /public/link/xxx 代理过来
    return segs;
  }

  async function lookupPayload(code) {
    if (!/^[A-Za-z0-9_-]{4,128}$/.test(code)) throw failure(404, '学生链接不存在或已关闭');
    const query = new URLSearchParams({
      select: 'user_id,payload,revision',
      payload: 'cs.' + JSON.stringify({ links: [{ code }] }),
      limit: '2',
    });
    const found = await backend('/rest/v1/wb_user_data?' + query);
    if (!found.ok) throw failure(503, '服务暂时不可用，请稍后重试');
    const accounts = await found.json();
    if (!Array.isArray(accounts) || accounts.length !== 1) throw failure(404, '学生链接不存在或已关闭');
    const account = accounts[0];
    const payload = account.payload || {};
    const link = findLink(payload, code);
    if (!link) throw failure(404, '学生链接不存在或已关闭');
    return { account, payload, link };
  }

  /* 学生端写入统一走这里：payload 改了，revision 必须一起 +1。
     教师端靠 revision 判断「云端有新数据」——只改 payload 不推进 revision 的话，
     老师刷新拉不到学生提交，下一次保存还会把这条记录覆盖掉。
     并发提交用 revision 做乐观锁，冲突就重新读取再改一次。 */
  async function mutatePayload(code, apply) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { account, payload } = await lookupPayload(code);
      const result = apply(payload);
      const rev = num(account.revision);
      const res = await backend('/rest/v1/wb_user_data?user_id=eq.' + encodeURIComponent(account.user_id) + '&revision=eq.' + rev, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
        body: JSON.stringify({ payload, revision: rev + 1 }),
      });
      if (!res.ok) throw failure(503, '数据保存失败，请稍后重试');
      const rows = await res.json().catch(() => null);
      if (Array.isArray(rows) && rows.length) return result;
    }
    throw failure(409, '同时提交的人太多，请再点一次提交');
  }

  /* 计算自习截止时间：简化版，用 payload 里的 periods 第六节结束时间 */
  function computeDeadline(payload) {
    const periods = Array.isArray(payload.periods) ? payload.periods : [];
    const p6 = periods.find((p) => num(p.period_no) === 6);
    return String(p6?.end_time || '');
  }

  /* GET /public/link/:code —— 主接口 */
  async function handleMain(code, query) {
    const { payload, link } = await lookupPayload(code);
    const grades = safeJSON(link.grades, []);
    const mats = (payload.materials || [])
      .filter((m) => live(m) && num(m.public) === 1)
      .sort((a, b) => b.id - a.id)
      .map((m) => ({ id: m.id, seq: m.seq, title: m.title, grade: m.grade, class_name: m.class_name, descr: m.descr, created_at: m.created_at }));
    const cats = (payload.categories || [])
      .filter((c) => c.scope === 'material')
      .sort((a, b) => num(a.sort) - num(b.sort))
      .map((c) => ({ id: c.id, name: c.name }));
    const rosters = (payload.rosters || [])
      .filter((r) => live(r) && (!grades.length || grades.includes(r.grade)))
      .map((r) => ({ id: r.id, grade: r.grade, class_name: r.class_name, count: r.count, names: safeJSON(r.names, []) }));
    const punish = (payload.punishments || [])
      .filter((p) => live(p) && num(p.active) === 1)
      .map((p) => ({ id: p.id, text: p.text, level: p.level }));

    const date = String(query.date || todayStr());
    const sessions = rollSessions(payload, date);
    const roll = sessions.filter((s) => s.status === 'open').map((s) => {
      const all = payload.rosters || [];
      const roster = all.find((r) => String(r.id) === String(s.roster_id));
      return {
        id: s.id, grade: s.grade, class_name: s.class_name, period_no: s.period_no,
        subject: s.subject, expect: num(s.expect) || num(roster?.count),
      };
    });

    /* 自习任务：和 localapi.js 的 publicSelfstudyTasks 保持一致的筛选逻辑 */
    const deadlineFallback = computeDeadline(payload);
    const u = payload.meta?.user || {};
    const selfstudyTasks = (payload.selfstudy_tasks || [])
      .filter((t) => t.status === 'published')
      .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || (b.id - a.id))
      .map((t) => ({
        id: t.id, title: t.title, class_scope: t.class_scope, class_label: t.class_label,
        date: t.date, period: t.period, content: t.content,
        task_image: t.task_image || '', generated_image: t.generated_image || '',
        pc_visible: num(t.pc_visible), creator: t.creator || u.nickname,
        end_time: deadlineFallback, deadline_time: deadlineFallback,
        updated_at: t.updated_at,
      }));

    const misconduct = (payload.misconduct_records || [])
      .filter((m) => live(m) && (!grades.length || !m.grade || grades.includes(m.grade)))
      .map((m) => ({ id: m.id, grade: m.grade, class_name: m.class_name, student_name: m.student_name, student_no: m.student_no, content: m.content, created_at: m.created_at }));
    const bulletin = (payload.bulletin_records || [])
      .filter((b) => live(b) && (!grades.length || !b.grade || grades.includes(b.grade)))
      .map((b) => ({ id: b.id, grade: b.grade, class_name: b.class_name, content: b.content, created_at: b.created_at }));

    /* 学生端「年级 / 班级」下拉：以老师课表里的班级为准，课表为空时退回花名册 */
    const classPairs = new Map();
    const addPair = (row) => {
      const grade = String(row?.grade || '').trim();
      const class_name = String(row?.class_name || '').trim();
      if (!grade && !class_name) return;
      if (grades.length && grade && !grades.includes(grade)) return;
      classPairs.set(grade + '\u0000' + class_name, { grade, class_name });
    };
    (payload.courses || []).filter(live).forEach(addPair);
    if (!classPairs.size) (payload.rosters || []).filter(live).forEach(addPair);
    const classes = [...classPairs.values()]
      .sort((a, b) => a.grade.localeCompare(b.grade, 'zh-Hans-CN') || a.class_name.localeCompare(b.class_name, 'zh-Hans-CN'));

    return json({
      link: { code: link.code, title: link.title, grades, modules: linkModules(link) },
      teacher: { nickname: u.nickname, subject: u.subject, school: u.school },
      materials: mats, categories: cats, rosters, classes, punishments: punish, roll, date,
      selfstudyTasks, misconduct, bulletin,
    });
  }

  /* GET /public/link/:code/roll —— 点名会话列表 */
  async function handleRollList(code, query) {
    const { payload } = await lookupPayload(code);
    const date = String(query.date || todayStr());
    const sessions = rollSessions(payload, date);
    const roll = sessions.filter((s) => s.status === 'open').map((s) => {
      const all = payload.rosters || [];
      const roster = all.find((r) => String(r.id) === String(s.roster_id));
      return {
        id: s.id, grade: s.grade, class_name: s.class_name, period_no: s.period_no,
        subject: s.subject, expect: num(s.expect) || num(roster?.count),
      };
    });
    return json({ date, sessions: roll });
  }

  /* POST /public/link/:code/roll/:id —— 签到登记 */
  async function handleRollRecord(code, sessionId, body) {
    const status = ROLL_STATUS.includes(body?.status) ? body.status : 'present';
    const name = String(body?.name || '').trim().slice(0, 20);
    const no = String(body?.stu_no || '').trim().slice(0, 20);
    const key = stuKey(no || name);
    if (!key) throw failure(400, '请先填写你的学号或姓名');

    return json(await mutatePayload(code, (payload) => {
      const sessions = payload.roll_sessions || [];
      const s = sessions.find((x) => String(x.id) === String(sessionId) && live(x));
      if (!s) throw failure(404, '这场点名不存在');
      if (s.status !== 'open') throw failure(400, '这场点名已经结束了');

      const all = payload.rosters || [];
      const roster = s.roster_id ? all.find((r) => String(r.id) === String(s.roster_id)) : null;
      const names = roster ? safeJSON(roster.names, []).filter(Boolean) : [];
      let matched = '';
      if (names.length) {
        const hit = names.find((n) => stuKey(n) === key);
        if (!hit) {
          const fuzzy = names.filter((n) => stuKey(n).includes(key) || key.includes(stuKey(n)));
          if (!fuzzy.length) throw failure(400, '名单里没有「' + (name || no) + '」，请核对姓名或学号');
          if (fuzzy.length > 1) throw failure(400, '有 ' + fuzzy.length + ' 个相近的名字（' + fuzzy.slice(0, 3).join('、') + '），请填学号区分');
          matched = fuzzy[0];
        } else matched = hit;
      }
      const finalKey = matched ? stuKey(matched) : key;

      if (!Array.isArray(payload.roll_records)) payload.roll_records = [];
      const records = payload.roll_records;
      const old = records.find((r) => String(r.session_id) === String(s.id) && r.stu_key === finalKey);
      if (old) {
        old.status = status;
        old.stu_name = matched || name || old.stu_name;
        old.stu_no = no || old.stu_no;
        old.updated_at = nowISO();
      } else {
        const id = records.reduce((mx, x) => Math.max(mx, num(x.id)), 0) + 1;
        records.push({
          id, session_id: s.id, stu_key: finalKey, stu_name: matched || name, stu_no: no,
          status, source: 'student', ip: '', created_at: nowISO(), updated_at: nowISO(),
        });
      }
      const c = rollCount(payload, s.id);
      return { ok: true, status, mine: status, total: c.total, present: c.present, late: c.late, leave: c.leave };
    }));
  }

  /* POST /public/link/:code/punish —— 盲盒记录 */
  async function handlePunish(code, body) {
    const text = String(body?.text || '').trim().slice(0, 200);
    if (!text) throw failure(400, '缺少任务内容');
    return json(await mutatePayload(code, (payload) => {
      if (!Array.isArray(payload.punish_records)) payload.punish_records = [];
      const id = payload.punish_records.reduce((mx, x) => Math.max(mx, num(x.id)), 0) + 1;
      payload.punish_records.push({
        id, roster_id: body?.roster_id || null, grade: String(body?.grade || ''),
        class_name: String(body?.class_name || ''), stu_name: String(body?.stu_name || '').slice(0, 20),
        text, source: 'student', date: todayStr(), note: '', created_at: nowISO(),
      });
      return { id };
    }));
  }

  /* POST /public/link/:code/misconduct —— 学生提交违纪 */
  async function handleMisconductSubmit(code, body) {
    const grade = String(body?.grade || '').trim().slice(0, 20);
    const className = String(body?.class_name || '').trim().slice(0, 20);
    const content = String(body?.content || '').trim().slice(0, 500);
    if (!content) throw failure(400, '请填写违纪内容');
    if (!grade && !className) throw failure(400, '请选择年级和班级');
    return json(await mutatePayload(code, (payload) => {
      if (!Array.isArray(payload.misconduct_records)) payload.misconduct_records = [];
      const records = payload.misconduct_records;
      const id = records.reduce((mx, x) => Math.max(mx, num(x.id)), 0) + 1;
      records.push({
        id, grade, class_name: className,
        student_name: String(body?.student_name || '').trim().slice(0, 20),
        student_no: String(body?.student_no || '').trim().slice(0, 20),
        content, source: 'student', created_at: nowISO(),
      });
      return { id };
    }));
  }

  /* POST /public/link/:code/bulletin —— 学生提交留言 */
  async function handleBulletinSubmit(code, body) {
    const grade = String(body?.grade || '').trim().slice(0, 20);
    const className = String(body?.class_name || '').trim().slice(0, 20);
    const content = String(body?.content || '').trim().slice(0, 500);
    if (!content) throw failure(400, '请填写留言内容');
    if (!grade && !className) throw failure(400, '请填写年级或班级');
    return json(await mutatePayload(code, (payload) => {
      if (!Array.isArray(payload.bulletin_records)) payload.bulletin_records = [];
      const records = payload.bulletin_records;
      const id = records.reduce((mx, x) => Math.max(mx, num(x.id)), 0) + 1;
      records.push({
        id, grade, class_name: className,
        student_name: String(body?.student_name || '').trim().slice(0, 20),
        content, source: 'student', created_at: nowISO(),
      });
      return { id };
    }));
  }

  /* GET /public/link/:code/selfstudy —— 自习任务 */
  async function handleSelfstudy(code) {
    const { payload } = await lookupPayload(code);
    const deadlineFallback = computeDeadline(payload);
    const u = payload.meta?.user || {};
    const tasks = (payload.selfstudy_tasks || [])
      .filter((t) => t.status === 'published')
      .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || (b.id - a.id))
      .map((t) => ({
        id: t.id, title: t.title, class_scope: t.class_scope, class_label: t.class_label,
        date: t.date, period: t.period, content: t.content,
        task_image: t.task_image || '', generated_image: t.generated_image || '',
        creator: t.creator || u.nickname,
        end_time: deadlineFallback, deadline_time: deadlineFallback,
        updated_at: t.updated_at,
      }));
    return json({ tasks });
  }

  /* 主路由分发 */
  return async (request) => {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      if (!base || !serviceKey) throw failure(503, '学生服务尚未配置');
      const url = new URL(request.url);
      let pathname = url.pathname;
      // 尝试从 query 里拿 path（Cloudflare Pages Functions / Edge Functions 代理场景）
      const queryPath = url.searchParams.get('path');
      if (queryPath) pathname = queryPath;

      const segs = pathname.split('/').filter(Boolean);
      // 去掉可能的前缀
      let start = 0;
      if (segs[0] === 'functions' && segs[1] === 'v1') start = 2;
      if (segs[start] === 'student-api') start++;
      const tail = segs.slice(start);
      // 期望 tail[0]='public', tail[1]='link', tail[2]=code
      if (tail[0] !== 'public' || tail[1] !== 'link' || !tail[2]) throw failure(404, '路径不存在');

      const code = tail[2];
      const sub = tail.slice(3);

      if (request.method === 'GET') {
        if (sub.length === 0) return await handleMain(code, Object.fromEntries(url.searchParams));
        if (sub[0] === 'roll' && sub.length === 1) return await handleRollList(code, Object.fromEntries(url.searchParams));
        if (sub[0] === 'selfstudy' && sub.length === 1) return await handleSelfstudy(code);
        /* materials/:id 和 file/:id 由 material-sharing 负责，前端有对应兜底 */
        throw failure(404, '接口不存在');
      }
      if (request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        if (sub[0] === 'roll' && sub[1]) return await handleRollRecord(code, sub[1], body);
        if (sub[0] === 'punish' && sub.length === 1) return await handlePunish(code, body);
        if (sub[0] === 'misconduct' && sub.length === 1) return await handleMisconductSubmit(code, body);
        if (sub[0] === 'bulletin' && sub.length === 1) return await handleBulletinSubmit(code, body);
        throw failure(404, '接口不存在');
      }
      throw failure(405, '不支持此操作');
    } catch (error) {
      if (error instanceof Response) return error;
      const status = error.status || 500;
      const msg = status >= 500 ? '学生服务暂时不可用，请稍后重试' : (error.message || '未知错误');
      return json({ error: msg }, status);
    }
  };
}
