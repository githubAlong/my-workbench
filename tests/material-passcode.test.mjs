import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installBrowser } from './test-browser.mjs';
import { createMaterialHandler, passcodeAccepted, studentMaterial } from '../supabase/functions/material-sharing/handler.mjs';
import { createStudentApiHandler } from '../supabase/functions/student-api/handler.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFile(path.join(root, file), 'utf8');

/* ============================ 教材服务（真正发文件的那一层） ============================ */
const CODE = 'passcode-link';
const PASSWORD = 'wb5ban';

function fixture() {
  return {
    meta: { user: { nickname: '测试老师' } },
    links: [{ code: CODE, enabled: 1, grades: [], title: '班级资料站' }],
    materials: [
      { id: 1, public: 1, grade: '高二', title: '全班可看', descr: '' },
      { id: 2, public: 1, grade: '高二', title: '只发五班', descr: '', passcode: PASSWORD },
    ],
    attachments: [
      { id: 21, owner_type: 'material', owner_id: 2, name: '五班练习.dps', mime: 'application/octet-stream', size: 10, url: 'wb-material:teacher-1/2/file-21' },
    ],
  };
}

function service(payload = fixture()) {
  const calls = [];
  const handler = createMaterialHandler({
    backendUrl: 'https://backend.example', serviceKey: 'server-only-secret',
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, method: options.method || 'GET' });
      if (url.includes('/rest/v1/wb_user_data')) return Response.json([{ user_id: 'teacher-1', payload }]);
      if (url.includes('/object/sign/')) {
        return options.method === 'POST'
          ? Response.json({ signedURL: '/object/sign/teaching-materials/teacher-1/2/file-21?token=temporary' })
          : new Response('FILE-BYTES');
      }
      throw new Error('Unexpected backend request: ' + url);
    },
  });
  return { calls, handler };
}
const get = (handler, query) => handler(new Request('https://edge.example/material-sharing?code=' + CODE + query));
/* 口令改走请求头之后的发法：URL 里搜不到口令，等价于学生端的真实请求。
   注意 Headers 会吃掉首尾空格，所以这一路测的是大小写而不是手滑多打的空格。 */
const headed = (handler, query, passcode) => handler(new Request('https://edge.example/material-sharing?code=' + CODE + query,
  passcode === undefined ? {} : { headers: { 'X-Material-Passcode': passcode } }));
const signed = (calls) => calls.filter((c) => c.method === 'POST' && c.url.includes('/object/sign/')).length;

test('口令比对：没设口令一律放行，设了就要忽略首尾空格与大小写对上', () => {
  assert.equal(passcodeAccepted({ passcode: '' }, ''), true);
  assert.equal(passcodeAccepted({}, undefined), true, '老数据没有 passcode 字段也要放行');
  assert.equal(passcodeAccepted({ passcode: PASSWORD }, undefined), false);
  assert.equal(passcodeAccepted({ passcode: PASSWORD }, 'wrong'), false);
  assert.equal(passcodeAccepted({ passcode: PASSWORD }, PASSWORD), true);
  assert.equal(passcodeAccepted({ passcode: PASSWORD }, '  WB5BAN  '), true, '学生打字多带空格、开大写锁定不该算错');
});

test('下发给学生的资料字段：只说要不要口令，不带口令本身', () => {
  const row = { id: 2, title: '只发五班', grade: '高二', class_name: '', descr: '', created_at: 'x', passcode: PASSWORD };
  const out = studentMaterial(row);
  assert.equal(out.locked, true);
  assert.equal('passcode' in out, false);
  assert.equal(JSON.stringify(out).includes(PASSWORD), false);
  assert.equal(studentMaterial({ id: 1, title: '全班可看' }).locked, false);
});

test('教材服务列表标出 locked，且整份响应搜不到口令', async () => {
  const response = await get(service().handler, '');
  assert.equal(response.status, 200);
  const text = await response.text();
  const data = JSON.parse(text);
  assert.deepEqual(data.materials.map((m) => [m.id, m.locked]), [[1, false], [2, true]]);
  for (const secret of [PASSWORD, 'server-only-secret', 'wb-material:']) assert.ok(!text.includes(secret));
});

test('口令不对：资料详情不给文件清单，并告诉前端「要口令」', async () => {
  const { handler, calls } = service();
  const response = await get(handler, '&material_id=2');
  assert.equal(response.status, 401);
  const data = await response.json();
  assert.equal(data.need_passcode, true);
  assert.equal(data.files, undefined);
  assert.equal(signed(calls), 0);
});

test('口令不对：下载请求换不到签名地址，一个字节都拿不到', async () => {
  for (const query of ['', '&passcode=wrong', '&passcode=%20%20']) {
    const { handler, calls } = service();
    const response = await get(handler, '&material_id=2&file_id=21&mode=download' + query);
    assert.equal(response.status, 401);
    assert.equal(signed(calls), 0, '没过口令不该去签名');
    assert.doesNotMatch(JSON.stringify(await response.json()), /FILE-BYTES/);
  }
});

test('口令正确才放行详情与文件，预览和下载走同一道门', async () => {
  const typed = '&passcode=' + encodeURIComponent(' WB5BAN ');
  const detail = service();
  const detailResponse = await get(detail.handler, '&material_id=2' + typed);
  assert.equal(detailResponse.status, 200);
  const data = await detailResponse.json();
  assert.equal(data.material.locked, true);
  assert.equal(data.files.length, 1);
  const file = service();
  const response = await get(file.handler, '&material_id=2&file_id=21&mode=view' + typed);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'FILE-BYTES');
  assert.equal(signed(file.calls), 1);
});

test('口令放请求头一样过闸：对的放行详情与字节，错的照旧 401 且不签名', async () => {
  const detail = service();
  const detailResponse = await headed(detail.handler, '&material_id=2', PASSWORD.toUpperCase());
  assert.equal(detailResponse.status, 200);
  assert.equal(signed(detail.calls), 0, '只看清单不该去签名');
  const file = service();
  const bytes = await headed(file.handler, '&material_id=2&file_id=21&mode=download', PASSWORD);
  assert.equal(bytes.status, 200);
  assert.equal(await bytes.text(), 'FILE-BYTES');
  assert.equal(signed(file.calls), 1);
  for (const passcode of [undefined, '', 'wrong']) {
    assert.equal((await headed(service().handler, '&material_id=2', passcode)).status, 401, `头里是「${passcode}」不该放行`);
  }
});

test('函数与静态站不能原子换版：先认请求头，暂时也认旧页面的查询串', async () => {
  assert.equal((await get(service().handler, '&material_id=2&passcode=' + PASSWORD)).status, 200,
    '换版前就打开的学生页仍发 query，只认头会让它永远卡在「口令已失效」');
  assert.equal((await get(service().handler, '&material_id=2&passcode=wrong')).status, 401, '兜底不等于放行');
});

test('自定义头必须先过 CORS 预检，否则学生浏览器根本发不出这个请求', async () => {
  const response = await service().handler(new Request('https://edge.example/material-sharing', { method: 'OPTIONS' }));
  assert.equal(response.status, 204);
  assert.match(response.headers.get('Access-Control-Allow-Headers'), /x-material-passcode/i);
});

test('没设口令的资料照旧直接可看，设了口令但未发布的资料仍然查不到', async () => {
  const { handler } = service();
  assert.equal((await get(handler, '&material_id=1')).status, 200);
  const hidden = fixture();
  hidden.materials[1].public = 0;
  const locked = createMaterialHandler({
    backendUrl: 'https://backend.example', serviceKey: 'k',
    fetchImpl: async () => Response.json([{ user_id: 'teacher-1', payload: hidden }]),
  });
  assert.equal((await get(locked, '&material_id=2&passcode=' + PASSWORD)).status, 404, '收回的资料不该靠口令打开');
});

/* ============================ 本机接口（老师机上预览学生端走这里） ============================ */
installBrowser({ href: 'http://localhost/' });
const { handle } = await import('../js/localapi.js?material-passcode=1');
const { TABLES } = await import('../js/localdb.js');

async function api(method, url, query, body) {
  const [pathOnly, qs] = String(url).split('?');
  const merged = { ...Object.fromEntries(new URLSearchParams(qs || '')), ...query };
  const response = await handle(method, pathOnly, merged, body);
  assert.equal(response.ok, true, response.error || `${method} ${url}`);
  return response.data;
}

test('passcode 在资料表的可写字段里，才会跟着快照同步到教材服务', () => {
  assert.ok(TABLES.materials.includes('passcode'));
});

test('本机接口：口令挡住详情，列表只给 locked，老师端仍能看到口令原文', async () => {
  const link = await api('POST', '/links', {}, { title: '口令测试班' });
  const open = await api('POST', '/materials', {}, { title: '全班可看', public: 1 });
  const locked = await api('POST', '/materials', {}, { title: '只发五班', public: 1, passcode: PASSWORD });

  const list = await api('GET', `/public/link/${link.code}`);
  const byId = new Map(list.materials.map((m) => [m.id, m]));
  assert.equal(byId.get(open.id).locked, false);
  assert.equal(byId.get(locked.id).locked, true);
  assert.equal(JSON.stringify(list).includes(PASSWORD), false, '学生端列表里搜不到口令');

  const denied = await handle('GET', `/public/link/${link.code}/materials/${locked.id}`, {});
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 401);
  assert.equal(denied.extra.need_passcode, true);

  const detail = await api('GET', `/public/link/${link.code}/materials/${locked.id}`, { passcode: ' ' + PASSWORD.toUpperCase() });
  assert.equal(detail.material.locked, true);
  assert.equal('passcode' in detail.material, false);

  const teacher = await api('GET', '/materials');
  assert.equal(teacher.find((m) => m.id === locked.id).passcode, PASSWORD);

  /* 清空口令 = 这份资料重新变成直接可看 */
  await api('PATCH', '/materials/' + locked.id, {}, { passcode: '' });
  assert.equal((await handle('GET', `/public/link/${link.code}/materials/${locked.id}`, {})).ok, true);
});

/* ============================ 两端接线 ============================ */
test('教师端：上传/编辑课件有口令输入框，保存与列表都带上它', async () => {
  const src = await read('js/work.js');
  assert.match(src, /for="pc">班级口令/);
  assert.match(src, /passcode: body\.querySelector\('#pc'\)\.value\.trim\(\)/);
  assert.match(src, /value="\$\{esc\(m\?\.passcode \|\| ''\)\}"/, '编辑时要回填原口令');
  assert.match(src, /icon\('lock', 13\)\} 口令 \$\{esc\(m\.passcode\)\}/);
});

test('学生端：口令记在当前标签页，取详情和取文件都要带上', async () => {
  const src = await read('student.html');
  assert.match(src, /sessionStorage\.getItem\(PC_KEY\)/);
  assert.doesNotMatch(src, /localStorage\.setItem\(PC_KEY/, '存 localStorage 会让第一个学生把口令永久留给全班');
  assert.match(src, /getStudentMaterials\(materialRoute\[1\], materialRoute\[2\], String\(ctx\.query\.passcode \|\| ''\)\)/);
  assert.match(src, /if \(local\?\.extra\?\.need_passcode === true\) throw/, '本机已判定口令不对，不该再等云端一个来回');
  assert.match(src, /fetch\(materialEndpoint\(code, cur, id, mode\), \{ headers: passcodeHeaders\(passcodeFor\(cur\)\) \}\)/);
  assert.doesNotMatch(src, /materialEndpoint\([^)]*passcode/, '文件地址是要发出去的 URL，不能带口令');
  assert.match(src, /function paintPasscodeGate/);
  assert.match(src, /if \(m\?\.locked && !passcodeFor\(cur\)\) return paintPasscodeGate\(\)/);
  assert.match(src, /res\.status === 401/, '文件请求被口令挡住时要给出可恢复的提示');
  assert.doesNotMatch(src, /无需账号密码/);
});

test('教材服务与本机接口用同一套判断，口令不从字段白名单漏出去', async () => {
  const edge = await read('supabase/functions/material-sharing/handler.mjs');
  const local = await read('js/localapi.js');
  const shared = await read('js/material-sharing.mjs');
  assert.match(edge, /const materialKeys = \['id', 'title', 'grade', 'class_name', 'descr', 'created_at'\]/);
  assert.doesNotMatch(edge, /materialKeys[^\n]*passcode/);
  assert.match(edge, /requireMaterialPasscode\(material, request\.headers\.get\('x-material-passcode'\) \|\| url\.searchParams\.get\('passcode'\)\)/);
  assert.match(local, /function requireMaterialPasscode/);
  assert.match(shared, /export const PASSCODE_HEADER = 'X-Material-Passcode'/);
  assert.doesNotMatch(shared, /searchParams\.set\('passcode'/, '教材服务客户端一旦把口令写进查询串，它就会出现在服务端访问日志里');
  assert.match(shared, /headers: passcodeHeaders\(passcode\)/);
  assert.match(shared, /needPasscode: !!result\.need_passcode/);
});

/* ================= 学生端主视图：入口分给谁，取决于谁组装这份数据 ================= */
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const scoped = () => ({
  meta: { user: { nickname: '测试老师' } },
  links: [{ code: CODE, enabled: 1, deleted_at: null, grades: ['高二'], title: '班级资料站' }],
  materials: [
    { id: 1, public: 1, grade: '高二', title: '班里都在看', descr: '' },
    { id: 2, public: 1, grade: '高二', title: '只发五班', descr: '', passcode: PASSWORD },
    { id: 3, public: 1, grade: '高一', title: '隔壁班的', descr: '' },
    { id: 4, public: 0, grade: '高二', title: '仅自己可见', descr: '' },
  ],
  roll_sessions: [{ id: 5, status: 'open', grade: '高二', date: today(), deleted_at: null }],
  selfstudy_tasks: [{ id: 7, status: 'published', grade: '高二', date: today(), title: '今晚自习任务', deleted_at: null }],
});

function apiService(payload = scoped()) {
  const calls = [];
  const handler = createStudentApiHandler({
    backendUrl: 'https://backend.example', serviceKey: 'server-only-secret',
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, method: options.method || 'GET' });
      if (url.includes('/rest/v1/wb_user_data')) return Response.json([{ user_id: 'teacher-1', payload, revision: 3 }]);
      throw new Error('Unexpected backend request: ' + url);
    },
  });
  return { calls, handler };
}
const mainView = (handler) => handler(new Request('https://edge.example/student-api?path=' + encodeURIComponent('/public/link/' + CODE)));

test('主视图：标出 locked、不泄露口令，也绝不提供文件与签名地址', async () => {
  const { handler, calls } = apiService();
  const response = await mainView(handler);
  assert.equal(response.status, 200);
  const text = await response.text();
  const data = JSON.parse(text);
  assert.deepEqual(data.materials.map((m) => [m.id, m.locked]), [[2, true], [1, false]], '按 id 倒序，带口令的标 locked');
  for (const secret of [PASSWORD, 'server-only-secret', 'wb-material:']) assert.ok(!text.includes(secret));
  assert.equal(text.includes('"files"'), false, '主视图不该出现文件清单字段');
  assert.equal(calls.filter((c) => c.url.includes('/object/sign/')).length, 0);
});

test('主视图：点名/自习这些 material-sharing 给空的模块，学生页要能拿到', async () => {
  const { handler } = apiService();
  const data = await (await mainView(handler)).json();
  assert.ok(data.roll.length, '没有 roll 就没有「签到」页签：visibleTabs 靠它判断');
  assert.ok(data.selfstudyTasks.length, '自习任务同理');
  assert.ok(Array.isArray(data.punishments) && Array.isArray(data.misconduct) && Array.isArray(data.bulletin));
});

test('主视图与教材服务的教材列表必须一模一样，不能列表里有、点开说不存在', async () => {
  const fromApi = await (await mainView(apiService().handler)).json();
  const fromSharing = await (await get(service(scoped()).handler, '')).json();
  const ids = (list) => list.map((m) => m.id).sort((a, b) => a - b);
  const lockedOf = (list) => list.slice().sort((a, b) => a.id - b.id).map((m) => m.locked);
  assert.deepEqual(ids(fromApi.materials), ids(fromSharing.materials), '年级不对口或不该给学生看的，两边都要滤掉');
  assert.deepEqual(lockedOf(fromApi.materials), lockedOf(fromSharing.materials));
});

test('入口分工：只有资料详情进教材服务，链接主视图归 student-api', async () => {
  const src = await read('student.html');
  assert.ok(src.includes('/^\\/public\\/link\\/([^/]+)\\/materials\\/(\\d+)$/'),
    '匹配必须要求 /materials/:id，否则主视图会被一起送进只组装教材的 material-sharing');
  assert.ok(!src.includes('(?:\\/materials'), '链接主视图不该落进这个分支');
  assert.ok(!src.includes("new URL('/api/student-api'"), '同源代理那一跳指向已退役的 ngrok，只剩一个白等的 404');
});
