import { resolveEnvironmentProfile } from './environment-config.mjs';

/* 口令走请求头，不进 URL：查询串会原样落到服务端访问日志里，
   而这个口令的全部意义就是「只有本班学生知道」。 */
export const PASSCODE_HEADER = 'X-Material-Passcode';
export const passcodeHeaders = (passcode) => (passcode ? { [PASSCODE_HEADER]: String(passcode) } : {});

export function materialEndpoint(code, materialId = '', fileId = '', mode = '') {
  const profile = resolveEnvironmentProfile(globalThis.location);
  const url = new URL(profile.supabaseUrl + '/functions/v1/material-sharing');
  url.searchParams.set('code', code);
  if (materialId) url.searchParams.set('material_id', materialId);
  if (fileId) url.searchParams.set('file_id', fileId);
  if (mode) url.searchParams.set('mode', mode);
  return url.href;
}
export async function getStudentMaterials(code, materialId = '', passcode = '') {
  const response = await fetch(materialEndpoint(code, materialId), { headers: passcodeHeaders(passcode), signal: AbortSignal.timeout(20000) });
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

