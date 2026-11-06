export const RETIRED_RESET_PARAM = 'reset-dev-data';

/* URL 参数只能用于清理旧维护标记，不参与任何数据操作。 */
export function takeRetiredResetParam(href) {
  const url = new URL(href);
  const requested = url.searchParams.has(RETIRED_RESET_PARAM);
  if (requested) url.searchParams.delete(RETIRED_RESET_PARAM);
  return {
    requested,
    next: `${url.pathname}${url.search}${url.hash}`,
  };
}
