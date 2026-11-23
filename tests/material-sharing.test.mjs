import test from 'node:test';
import assert from 'node:assert/strict';
import { createMaterialHandler, publicMaterials, previewType, validateFiles } from '../supabase/functions/material-sharing/handler.mjs';

const code = 'test-student-link';
function fixture() {
  return { meta: { user: { nickname: '测试老师', pwd: 'private-password', phone: 'private-phone' } }, todos: [{ title: 'private-note' }],
    links: [{ code, enabled: 1, grades: '["高二"]', title: '班级资料站' }],
    materials: [{ id: 1, public: 1, grade: '高二', title: '公开教材' }, { id: 2, public: 0, grade: '高二', title: 'private-material' }, { id: 3, public: 1, grade: '高二', title: 'deleted', deleted_at: '2026-11-10' }, { id: 4, public: 1, grade: '高一', title: 'other-grade' }],
    attachments: [{ id: 11, owner_type: 'material', owner_id: 1, name: '语文课件.dps', url: 'wb-material:teacher-1/1/file-1', size: 123 },
      { id: 12, owner_type: 'material', owner_id: 1, name: '阅读.pdf', url: 'data:application/pdf;base64,JVBERg==' },
      { id: 13, owner_type: 'material', owner_id: 2, name: 'private.wps', url: 'wb-material:teacher-1/2/private' },
      { id: 14, owner_type: 'material', owner_id: 1, name: '跳舞视频.mp4', url: 'wb-material:teacher-1/1/video', size: 200 }] };
}
function service({ payload = fixture(), failUpload = 0, bucketExists = true, failStatus = 500, failBody = {} } = {}) {
  const calls = []; let uploads = 0;
  const handler = createMaterialHandler({ backendUrl: 'https://backend.example', serviceKey: 'server-only-secret', fetchImpl: async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith('/auth/v1/user')) return options.headers.Authorization === 'Bearer teacher-token' ? Response.json({ id: 'teacher-1' }) : Response.json({}, { status: 401 });
    if (url.includes('/rest/v1/wb_user_data')) return Response.json([{ user_id: 'teacher-1', payload }]);
    if (url.includes('/object/sign/')) return options.method === 'POST' ? Response.json({ signedURL: '/object/sign/teaching-materials/teacher-1/1/file-1?token=temporary' }) : new Response('%PDF-file-bytes', { headers: { 'content-type': 'application/pdf', 'content-length': '15' } });
    if (url.endsWith('/bucket/teaching-materials')) return Response.json({ public: false }, { status: bucketExists ? 200 : 404 });
    if (url.endsWith('/bucket')) return Response.json({ id: 'teaching-materials' });
    if (options.method === 'DELETE') return Response.json({});
    if (url.includes('/object/teaching-materials/')) { uploads += 1; return Response.json(failBody, { status: uploads === failUpload ? failStatus : 200 }); }
    throw new Error('Unexpected backend request');
  } });
  return { calls, handler };
}
const get = (handler, query) => handler(new Request('https://edge.example/material-sharing?code=' + code + query));

test('anonymous students receive only published, live, permitted-grade materials and public teacher fields', async () => {
  const { handler } = service();
  const response = await get(handler, '');
  assert.equal(response.status, 200);
  const text = await response.text(), data = JSON.parse(text);
  assert.deepEqual(data.materials.map(row => row.id), [1]);
  assert.equal(data.teacher.nickname, '测试老师');
  for (const secret of ['private-password', 'private-phone', 'private-note', 'private-material', 'server-only-secret', 'wb-material:']) assert.ok(!text.includes(secret));
});
test('disabled and unknown links cannot read materials', async () => {
  const payload = fixture(); payload.links[0].enabled = 0;
  assert.equal((await get(service({ payload }).handler, '')).status, 404);
  assert.throws(() => publicMaterials(fixture(), 'unknown'), /不存在/);
});
test('private, deleted and wrong-grade material IDs cannot be guessed through the detail endpoint', async () => {
  const { handler } = service();
  for (const id of [2, 3, 4, 999]) assert.equal((await get(handler, '&material_id=' + id)).status, 404);
});
test('anonymous details reveal file names but never private storage pointers or file bodies', async () => {
  const response = await get(service().handler, '&material_id=1');
  const text = await response.text(), data = JSON.parse(text);
  assert.equal(data.files.length, 3);
  assert.equal(data.files[0].name, '语文课件.dps');
  assert.equal(data.files[0].preview, false);
  assert.equal(data.files[2].preview, true);
  assert.ok(!text.includes('wb-material:'));
  assert.ok(!text.includes('base64'));
});
test('anonymous WPS download streams the file with the original filename', async () => {
  const { handler, calls } = service();
  const response = await get(handler, '&material_id=1&file_id=11&mode=download');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/octet-stream');
  assert.match(response.headers.get('content-disposition'), /attachment; filename\*=UTF-8''/);
  assert.equal(await response.text(), '%PDF-file-bytes');
  assert.equal(JSON.parse(calls.find(call => call.url.includes('/object/sign/') && call.options.method === 'POST').options.body).expiresIn, 120);
});
test('WPS view also streams as a download, while existing PDF data can preview without a login', async () => {
  const { handler } = service();
  const office = await get(handler, '&material_id=1&file_id=11&mode=view');
  assert.equal(office.status, 200);
  assert.match(office.headers.get('content-disposition'), /^attachment;/);
  const pdf = await get(handler, '&material_id=1&file_id=12&mode=view');
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.equal(await pdf.text(), '%PDF');
});
test('video files stay playable inline instead of turning into unnamed downloads', async () => {
  const { handler } = service();
  const video = await get(handler, '&material_id=1&file_id=14&mode=view');
  assert.equal(video.status, 200);
  assert.equal(video.headers.get('content-type'), 'video/mp4');
  assert.match(video.headers.get('content-disposition'), /^inline;/);
});
test('files belonging to another material or account cannot be downloaded', async () => {
  const payload = fixture(); payload.attachments[0].url = 'wb-material:other-teacher/1/file';
  const { handler } = service({ payload });
  assert.equal((await get(handler, '&material_id=1&file_id=11')).status, 404);
  assert.equal((await get(handler, '&material_id=1&file_id=13')).status, 404);
});
test('revoking visibility immediately rejects new student download requests', async () => {
  const payload = fixture(), { handler } = service({ payload });
  assert.equal((await get(handler, '&material_id=1')).status, 200);
  payload.materials[0].public = 0;
  assert.equal((await get(handler, '&material_id=1&file_id=11')).status, 404);
});
test('file type handling supports native WPS formats without treating them as executable browser content', () => {
  for (const extension of ['wps', 'wpt', 'et', 'ett', 'dps', 'dpt', 'docm', 'xlsx', 'pptx', 'html', 'svg']) assert.equal(previewType('文件.' + extension), 'application/octet-stream');
  assert.equal(previewType('文件.PDF'), 'application/pdf');
  assert.equal(previewType('图片.png'), 'image/png');
});
test('anonymous upload is rejected before touching storage', async () => {
  const { handler, calls } = service();
  const response = await handler(new Request('https://edge.example', { method: 'POST', body: new FormData() }));
  assert.equal(response.status, 401);
  assert.equal(calls.length, 0);
});
test('upload accepts any number and size of files for folder uploads', () => {
  assert.doesNotThrow(() => validateFiles(Array.from({ length: 200 }, () => ({ name: '文件.wps', size: 1 }))));
  assert.doesNotThrow(() => validateFiles([{ name: '大视频.mp4', size: 800 * 1024 * 1024 }]));
  assert.throws(() => validateFiles([]), /请选择教材文件/);
});
test('authenticated teachers upload WPS files above the old 1.5 MB limit into private storage', async () => {
  const { handler, calls } = service({ bucketExists: false });
  const form = new FormData(); form.append('owner_id', '1');
  form.append('files', new Blob([new Uint8Array(2 * 1024 * 1024)]), '原文件.wps');
  const response = await handler(new Request('https://edge.example', { method: 'POST', headers: { Authorization: 'Bearer teacher-token' }, body: form }));
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.files[0].name, '原文件.wps');
  assert.match(data.files[0].url, /^wb-material:teacher-1\/1\//);
  const bucket = JSON.parse(calls.find(call => call.url.endsWith('/bucket')).options.body);
  assert.equal(bucket.public, false);
});
test('partial upload failure cleans up only the newly uploaded private files', async () => {
  const { handler, calls } = service({ failUpload: 2 });
  const form = new FormData(); form.append('owner_id', '1');
  for (const name of ['一.et', '二.dps']) form.append('files', new Blob(['test']), name);
  const response = await handler(new Request('https://edge.example', { method: 'POST', headers: { Authorization: 'Bearer teacher-token' }, body: form }));
  /* 状态码原样透出去：以前不分青红皂白报 502「请检查网络」，
     超尺寸、桶被删、权限不对全是一句话，老师只能反复重试。
     mock 里存储回的是 500，所以这里必须看到 500 而不是 502。 */
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.match(body.error, /「二\.dps」云端拒绝（HTTP 500）/);
  const cleanup = calls.find(call => call.options.method === 'DELETE');
  assert.equal(JSON.parse(cleanup.options.body).prefixes.length, 1);
  assert.match(JSON.parse(cleanup.options.body).prefixes[0], /^teacher-1\/1\//);
});

/* 客户端收到 413 或带「尺寸」字样的拒绝，才会在本地压一遍再重传。
   云端原话一旦被改写成「请检查网络后重试」，那条自动压缩的路就永远走不到，
   所以这里卡的是「真实状态码 + 真实文案必须原样到达教师端」。 */
test('size rejection keeps the real status and wording so the client can auto-compress', async () => {
  const { handler } = service({ failUpload: 1, failStatus: 413, failBody: { error: 'The uploaded file is larger than the maximum allowed size of 52428800 bytes' } });
  const form = new FormData(); form.append('owner_id', '1');
  form.append('files', new Blob(['test']), '开学第一课.pptx');
  const response = await handler(new Request('https://edge.example', { method: 'POST', headers: { Authorization: 'Bearer teacher-token' }, body: form }));
  assert.equal(response.status, 413);
  const text = (await response.json()).error;
  assert.match(text, /「开学第一课\.pptx」云端拒绝（HTTP 413）/);
  assert.match(text, /maximum allowed size/);
  assert.doesNotMatch(text, /检查网络/);
});

