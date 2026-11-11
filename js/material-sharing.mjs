import { resolveEnvironmentProfile } from './environment-config.mjs';

export const MAX_MATERIAL_SIZE = 50 * 1024 * 1024;
export function materialEndpoint(code, materialId = '', fileId = '', mode = '') {
  const profile = resolveEnvironmentProfile(globalThis.location);
  const url = new URL(profile.supabaseUrl + '/functions/v1/material-sharing');
  url.searchParams.set('code', code);
  if (materialId) url.searchParams.set('material_id', materialId);
  if (fileId) url.searchParams.set('file_id', fileId);
  if (mode) url.searchParams.set('mode', mode);
  return url.href;
}
export async function getStudentMaterials(code, materialId = '') {
  const response = await fetch(materialEndpoint(code, materialId), { signal: AbortSignal.timeout(20000) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '教材加载失败，请稍后重试');
  return result;
}
export async function syncMaterialSharing() {
  const cloud = await import('./cloud.js');
  if (!cloud.session()?.uid) return;
  const { pushNow } = await import('./cloudsync.js');
  await pushNow();
}

