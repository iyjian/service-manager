export interface RevealMenuItemMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  itemTop: number;
  itemHeight: number;
  paddingTop?: number;
  paddingBottom?: number;
}

/**
 * Keep one menu item inside its own padded scrolling viewport without asking
 * the browser to scroll any ancestor containers.
 */
export function revealMenuItemScrollTop(metrics: RevealMenuItemMetrics): number {
  const scrollTop = Number.isFinite(metrics.scrollTop) ? Math.max(0, metrics.scrollTop) : 0;
  const scrollHeight = Number.isFinite(metrics.scrollHeight) ? Math.max(0, metrics.scrollHeight) : 0;
  const clientHeight = Number.isFinite(metrics.clientHeight) ? Math.max(0, metrics.clientHeight) : 0;
  const itemTop = Number.isFinite(metrics.itemTop) ? Math.max(0, metrics.itemTop) : 0;
  const itemHeight = Number.isFinite(metrics.itemHeight) ? Math.max(0, metrics.itemHeight) : 0;
  const paddingTop = Number.isFinite(metrics.paddingTop) ? Math.max(0, metrics.paddingTop ?? 0) : 0;
  const paddingBottom = Number.isFinite(metrics.paddingBottom) ? Math.max(0, metrics.paddingBottom ?? 0) : 0;
  const maximumScrollTop = Math.max(0, scrollHeight - clientHeight);
  const itemBottom = itemTop + itemHeight;
  const visibleTop = scrollTop + paddingTop;
  const visibleBottom = scrollTop + clientHeight - paddingBottom;

  let nextScrollTop = scrollTop;
  if (itemTop < visibleTop) nextScrollTop = itemTop - paddingTop;
  else if (itemBottom > visibleBottom) nextScrollTop = itemBottom - clientHeight + paddingBottom;

  return Math.min(maximumScrollTop, Math.max(0, nextScrollTop));
}
