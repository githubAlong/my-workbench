import { resolveEnvironmentProfile } from './environment-config.mjs';

/* passcode：这份资料的班级口令，由学生端带上。
   服务端不认它就拿不到文件清单，也换不到签名下载地址。 */
export function materialEndpoint(code, materialId = '', fileId = '', mode = '', passcode = '') {
  const profile = resolveEnvironmentProfile(globalThis.location);
  const url = new URL(profile.supabaseUrl + '/functions/v1/material-sharing');
  url.searchParams.set('code', code);
  if (materialId) url.searchParams.set('material_id', materialId);
  if (fileId) url.searchParams.set('file_id', fileId);
  if (mode) url.searchParams.set('mode', mode);
  if (passcode) url.searchParams.set('passcode', passcode);
  return url.href;
}
export async function getStudentMaterials(code, materialId = '', passcode = '') {
  const response = await fetch(materialEndpoint(code, materialId, '', '', passcode), { signal: AbortSignal.timeout(20000) });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error || '教材加载失败，请稍后重试'), { needPasscode: !!result.need_passcode });
  return result;
}
export async function syncMaterialSharing() {
  const cloud = await import('./cloud.js');
  if (!cloud.session()?.uid) return;
  const { pushNow } = await import('./cloudsync.js');
  await pushNow();
}

