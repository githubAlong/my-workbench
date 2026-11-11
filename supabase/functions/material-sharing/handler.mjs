export const MAX_MATERIAL_SIZE = 50 * 1024 * 1024;
const BUCKET = 'teaching-materials';
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
const live = row => row && !row.deleted_at;
const fields = (row, keys) => Object.fromEntries(keys.map(key => [key, row[key] ?? '']));
const materialKeys = ['id', 'title', 'grade', 'class_name', 'descr', 'created_at'];
const fileKeys = ['id', 'name', 'mime', 'size'];
function failure(status, message) { return Object.assign(new Error(message), { status }); }
export function validateFiles(files) {
  if (!files.length || files.length > 20) throw failure(400, '请选择教材文件，每次最多 20 个');
  if (files.some(file => !file.name || !Number.isFinite(file.size) || file.size < 0 || file.size > MAX_MATERIAL_SIZE)) throw failure(413, '教材单个文件不能超过 50 MB');
  if (files.reduce((total, file) => total + file.size, 0) > MAX_MATERIAL_SIZE) throw failure(413, '每批文件合计不能超过 50 MB，请分批上传');
}
export function previewType(name) {
  const extension = String(name || '').split('.').pop().toLowerCase();
  return extension === 'pdf' ? 'application/pdf' : ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }[extension] || 'application/octet-stream');
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
        if (!/^\d+$/.test(ownerId) || !files.length || files.length > 20) throw failure(400, '请选择教材文件，每次最多 20 个');
        for (const file of files) {
          if (typeof file === 'string' || !file.name || file.size > MAX_MATERIAL_SIZE) throw failure(413, '教材单个文件不能超过 50 MB');
        }
        validateFiles(files);
        const bucketResponse = await backend('/storage/v1/bucket/' + BUCKET);
        if (bucketResponse.ok) {
          if ((await bucketResponse.json()).public) throw failure(503, '教材存储配置异常');
        } else if (bucketResponse.status === 404 || bucketResponse.status === 400) {
          const created = await backend('/storage/v1/bucket', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: BUCKET, name: BUCKET, public: false, file_size_limit: MAX_MATERIAL_SIZE }) });
          if (!created.ok && created.status !== 409) throw failure(503, '无法初始化教材存储，请稍后重试');
        } else throw failure(503, '教材存储暂时不可用');
        const uploaded = [];
        try {
          for (const file of files) {
            const path = user.id + '/' + ownerId + '/' + crypto.randomUUID();
            const response = await backend('/storage/v1/object/' + BUCKET + '/' + path, { method: 'POST', headers: { 'Content-Type': previewType(file.name), 'x-upsert': 'false' }, body: file });
            if (!response.ok) throw failure(502, '文件上传失败，请检查网络后重试');
            uploaded.push({ name: file.name, mime: previewType(file.name), size: file.size, url: 'wb-material:' + path });
          }
        } catch (error) {
          if (uploaded.length) await backend('/storage/v1/object/' + BUCKET, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prefixes: uploaded.map(file => file.url.slice('wb-material:'.length)) }) }).catch(() => {});
          throw error;
        }
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
      if (!materialId) return json({ link: { code, title: String(link.title || '班级资料站') }, teacher: fields(payload.meta?.user || {}, ['nickname', 'school', 'subject']), materials: materials.map(row => fields(row, materialKeys)), categories: [], rosters: [], punishments: [], roll: [] });
      const material = materials.find(row => String(row.id) === materialId);
      if (!material) throw failure(404, '教材已收回或不存在');
      const files = (Array.isArray(payload.attachments) ? payload.attachments : []).filter(row => live(row) && row.owner_type === 'material' && String(row.owner_id) === materialId);
      const fileId = url.searchParams.get('file_id');
      if (!fileId) return json({ material: fields(material, materialKeys), files: files.map(row => ({ ...fields(row, fileKeys), preview: previewType(row.name) !== 'application/octet-stream' })) });
      const file = files.find(row => String(row.id) === fileId);
      if (!file) throw failure(404, '文件不存在或已删除');
      const download = url.searchParams.get('mode') !== 'view' || previewType(file.name) === 'application/octet-stream';
      if (String(file.url).startsWith('wb-material:')) {
        const path = file.url.slice('wb-material:'.length);
        if (!path.startsWith(account.user_id + '/' + materialId + '/') || path.includes('..')) throw failure(404, '文件不可用');
        const signed = await backend('/storage/v1/object/sign/' + BUCKET + '/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expiresIn: 120 }) });
        if (!signed.ok) throw failure(404, '文件暂时不可用，请联系老师');
        const value = await signed.json();
        const destination = new URL(base + '/storage/v1' + value.signedURL);
        if (download) destination.searchParams.set('download', String(file.name || '教材'));
        return new Response(null, { status: 302, headers: { ...cors, Location: destination.href, 'Cache-Control': 'no-store' } });
      }
      const legacy = String(file.url || '').match(/^data:[^,]*;base64,([A-Za-z0-9+/=\s]+)$/);
      if (!legacy) throw failure(404, '旧文件需要老师重新上传后才能下载');
      const bytes = Uint8Array.from(atob(legacy[1].replace(/\s/g, '')), character => character.charCodeAt(0));
      return new Response(bytes, { headers: { ...cors, 'Content-Type': download ? 'application/octet-stream' : previewType(file.name), 'Content-Disposition': (download ? 'attachment' : 'inline') + "; filename*=UTF-8''" + encodeURIComponent(String(file.name || '教材')), 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' } });
    } catch (error) { return json({ error: error.status ? error.message : '教材服务暂时不可用，请稍后重试' }, error.status || 500); }
  };
}

