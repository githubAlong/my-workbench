const BUCKET = 'teaching-materials';
/* ngrok-skip-browser-warning 必须放行：自建 Supabase 走 ngrok 固定域名，
   前端给所有 ngrok 请求都加了这个头（环境配置里的 fetch 补丁）。
   少写它，预检就会失败，浏览器整条请求报 Failed to fetch，看不出是 CORS 问题。 */
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info, ngrok-skip-browser-warning', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
const live = row => row && !row.deleted_at;
const fields = (row, keys) => Object.fromEntries(keys.map(key => [key, row[key] ?? '']));
const materialKeys = ['id', 'title', 'grade', 'class_name', 'descr', 'created_at'];
const fileKeys = ['id', 'name', 'mime', 'size'];
function failure(status, message) { return Object.assign(new Error(message), { status }); }
/* 资料口令：老师单独发给某个班的短码，空 = 这份资料不设口令。
   比对忽略首尾空格和大小写：学生在手机上打字，多一个空格不该被当成口令不对。 */
const materialPasscode = row => String(row?.passcode || '').trim();
export function passcodeAccepted(row, input) {
  const want = materialPasscode(row);
  return !want || want.toLowerCase() === String(input || '').trim().toLowerCase();
}
function requireMaterialPasscode(row, input) {
  if (passcodeAccepted(row, input)) return;
  throw Object.assign(failure(401, '这份资料需要口令，请输入老师给的班级口令'), { needPasscode: true });
}
/* 学生能看到的资料字段：白名单写法，passcode 不会下发，只告诉他「这份要不要口令」。 */
export function studentMaterial(row) { return { ...fields(row, materialKeys), locked: !!materialPasscode(row) }; }
export function validateFiles(files) {
  /* 课件要支持整文件夹上传，文件数量和大小不再设限（单文件上限由存储桶决定）。 */
  if (!files.length) throw failure(400, '请选择教材文件');
}
export function previewType(name) {
  const extension = String(name || '').split('.').pop().toLowerCase();
  /* 视频 / 音频也要给出真实类型：之前只认 pdf 和图片，mp4 会被当成附件，
     学生点开时浏览器直接存成一个没有扩展名的 blob 文件，既不能播放也看不出是什么。 */
  return ({
    pdf: 'application/pdf',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
    mp4: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg',
    mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav'
  }[extension] || 'application/octet-stream');
}
export function publicMaterials(payload, code) {
  const links = Array.isArray(payload.links) ? payload.links : [];
  const link = links.find(row => live(row) && row.code === code && Number(row.enabled) === 1);
  if (!link) throw failure(404, '学生链接不存在或已关闭');
  let grades = link.grades || [];
  if (typeof grades === 'string') { try { grades = JSON.parse(grades); } catch { throw failure(404, '学生链接配置不正确'); } }
  if (!Array.isArray(grades)) throw failure(404, '学生链接配置不正确');
  const materials = (Array.isArray(payload.materials) ? payload.materials : []).filter(row => live(row) && Number(row.public) === 1 && (!grades.length || grades.includes(row.grade)));
  return { link, materials };
}

export function createMaterialHandler({ backendUrl, serviceKey, fetchImpl = fetch }) {
  const base = backendUrl.replace(/\/$/, '');
  const headers = { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey };
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
  const backend = (path, options = {}) => fetchImpl(base + path, { ...options, headers: { ...headers, ...options.headers }, signal: AbortSignal.timeout(90000) });

  /* bucket 状态缓存：同一实例内 30 秒内只检查一次。
     前端改成并行 4 个请求后，每个请求都调一次 bucket 检查是纯浪费。 */
  let cachedBucketOk = null;
  let cachedBucketAt = 0;
  const BUCKET_CACHE_MS = 30000;
  async function ensureBucket() {
    if (cachedBucketOk && Date.now() - cachedBucketAt < BUCKET_CACHE_MS) return;
    const bucketResponse = await backend('/storage/v1/bucket/' + BUCKET);
    if (bucketResponse.ok) {
      const bucket = await bucketResponse.json();
      if (bucket.public) throw failure(503, '教材存储配置异常');
      /* 早期建桶时写死了 50 MB 的单文件上限，现在不限大小，遇到旧配置顺手清掉。 */
      if (bucket.file_size_limit) {
        await backend('/storage/v1/bucket/' + BUCKET, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: BUCKET, name: BUCKET, public: false, file_size_limit: null, allowed_mime_types: null }) }).catch(() => {});
      }
    } else if (bucketResponse.status === 404 || bucketResponse.status === 400) {
      const created = await backend('/storage/v1/bucket', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: BUCKET, name: BUCKET, public: false }) });
      if (!created.ok && created.status !== 409) throw failure(503, '无法初始化教材存储，请稍后重试');
    } else throw failure(503, '教材存储暂时不可用');
    cachedBucketOk = true;
    cachedBucketAt = Date.now();
  }

  /* 并发上传：最多 4 个同时写 storage。
     前端改成并行发多请求后，每个请求通常只带 1 个文件，
     但保留并发 + 错误收集逻辑以兼容"旧版前端 / 内部测试"一次带多个文件。 */
  const FILE_CONCURRENCY = 4;
  async function uploadFiles(user, ownerId, files) {
    const results = new Array(files.length).fill(null);
    const errors = new Array(files.length).fill(null);
    let idx = 0;
    const runNext = async () => {
      while (idx < files.length) {
        const i = idx++;
        const file = files[i];
        const path = user.id + '/' + ownerId + '/' + crypto.randomUUID();
        try {
          const response = await backend('/storage/v1/object/' + BUCKET + '/' + path, { method: 'POST', headers: { 'Content-Type': previewType(file.name), 'x-upsert': 'false' }, body: file });
          if (!response.ok) throw failure(502, '「' + file.name + '」上传失败，请检查网络后重试');
          results[i] = { name: file.name, mime: previewType(file.name), size: file.size, url: 'wb-material:' + path };
        } catch (err) {
          errors[i] = err;
        }
      }
    };
    const workers = [];
    for (let i = 0; i < Math.min(FILE_CONCURRENCY, files.length); i++) workers.push(runNext());
    await Promise.all(workers);
    const errIndex = errors.findIndex(Boolean);
    if (errIndex >= 0) {
      /* 清理成功的文件：已经写上去的别留孤儿，免得下次有人以为这是完整的 */
      const prefixes = results.filter(Boolean).map(f => f.url.slice('wb-material:'.length));
      if (prefixes.length) await backend('/storage/v1/object/' + BUCKET, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prefixes }) }).catch(() => {});
      throw errors[errIndex];
    }
    return results;
  }

  return async request => {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      if (!base || !serviceKey) throw failure(503, '教材服务尚未配置');
      if (request.method === 'POST') {
        const token = request.headers.get('authorization') || '';
        if (!/^Bearer .+/i.test(token)) throw failure(401, '请先登录教师账号后上传');
        const auth = await backend('/auth/v1/user', { headers: { Authorization: token } });
        if (!auth.ok) throw failure(401, '教师登录已失效，请重新登录');
        const user = await auth.json();
        if (!user.id) throw failure(401, '无法确认教师身份');
        const form = await request.formData();
        const ownerId = String(form.get('owner_id') || '');
        const files = form.getAll('files');
        if (!/^\d+$/.test(ownerId) || !files.length) throw failure(400, '请选择教材文件');
        validateFiles(files);
        await ensureBucket();
        const uploaded = await uploadFiles(user, ownerId, files);
        return json({ files: uploaded });
      }
      if (request.method !== 'GET') throw failure(405, '不支持此操作');
      const url = new URL(request.url), code = url.searchParams.get('code') || '';
      if (!/^[A-Za-z0-9_-]{4,128}$/.test(code)) throw failure(404, '学生链接不存在或已关闭');
      const query = new URLSearchParams({ select: 'user_id,payload', payload: 'cs.' + JSON.stringify({ links: [{ code }] }), limit: '2' });
      const found = await backend('/rest/v1/wb_user_data?' + query);
      if (!found.ok) throw failure(503, '教材暂时加载失败，请稍后重试');
      const accounts = await found.json();
      if (!Array.isArray(accounts) || accounts.length !== 1) throw failure(404, '学生链接不存在或已关闭');
      const account = accounts[0], payload = account.payload || {};
      const { link, materials } = publicMaterials(payload, code);
      const materialId = url.searchParams.get('material_id');
      if (!materialId) return json({ link: { code, title: String(link.title || '班级资料站') }, teacher: fields(payload.meta?.user || {}, ['nickname', 'school', 'subject']), materials: materials.map(studentMaterial), categories: [], rosters: [], punishments: [], roll: [] });
      const material = materials.find(row => String(row.id) === materialId);
      if (!material) throw failure(404, '教材已收回或不存在');
      /* 口令卡在这里：详情、文件清单、文件字节三条路都从这一句后面走，
         口令不对就换不到签名地址，学生拿不到原文件。 */
      requireMaterialPasscode(material, url.searchParams.get('passcode'));
      const files = (Array.isArray(payload.attachments) ? payload.attachments : []).filter(row => live(row) && row.owner_type === 'material' && String(row.owner_id) === materialId);
      const fileId = url.searchParams.get('file_id');
      if (!fileId) return json({ material: studentMaterial(material), files: files.map(row => ({ ...fields(row, fileKeys), preview: previewType(row.name) !== 'application/octet-stream' })) });
      const file = files.find(row => String(row.id) === fileId);
      if (!file) throw failure(404, '文件不存在或已删除');
      const download = url.searchParams.get('mode') !== 'view' || previewType(file.name) === 'application/octet-stream';
      if (String(file.url).startsWith('wb-material:')) {
        const path = file.url.slice('wb-material:'.length);
        if (!path.startsWith(account.user_id + '/' + materialId + '/') || path.includes('..')) throw failure(404, '文件不可用');
        const signed = await backend('/storage/v1/object/sign/' + BUCKET + '/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expiresIn: 120 }) });
        if (!signed.ok) throw failure(404, '文件暂时不可用，请联系老师');
        const value = await signed.json();
        /* 原来 302 到签名地址，但签名地址是内网主机名（SUPABASE_URL 形如 http://api-gw:8000），
           学生浏览器根本解析不了，所以「查看」「下载」全都打不开。
           现在由函数把文件内容转发出去，前端用 fetch 拿到 blob 再打开或保存。 */
        const object = await backend('/storage/v1' + value.signedURL);
        if (!object.ok) throw failure(404, '文件暂时不可用，请联系老师');
        const responseHeaders = new Headers({ ...cors, 'Content-Type': download ? 'application/octet-stream' : previewType(file.name), 'Content-Disposition': (download ? 'attachment' : 'inline') + "; filename*=UTF-8''" + encodeURIComponent(String(file.name || '教材')), 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
        const length = object.headers.get('content-length');
        if (length) responseHeaders.set('Content-Length', length);
        return new Response(object.body, { status: 200, headers: responseHeaders });
      }
      const legacy = String(file.url || '').match(/^data:[^,]*;base64,([A-Za-z0-9+/=\s]+)$/);
      if (!legacy) throw failure(404, '旧文件需要老师重新上传后才能下载');
      const bytes = Uint8Array.from(atob(legacy[1].replace(/\s/g, '')), character => character.charCodeAt(0));
      return new Response(bytes, { headers: { ...cors, 'Content-Type': download ? 'application/octet-stream' : previewType(file.name), 'Content-Disposition': (download ? 'attachment' : 'inline') + "; filename*=UTF-8''" + encodeURIComponent(String(file.name || '教材')), 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' } });
    } catch (error) {
      /* need_passcode 让学生端分得清「要口令」和「资料没了」：前者弹输入框，后者只报错。 */
      const body = { error: error.status ? error.message : '教材服务暂时不可用，请稍后重试' };
      if (error.needPasscode) body.need_passcode = true;
      return json(body, error.status || 500);
    }
  };
}

