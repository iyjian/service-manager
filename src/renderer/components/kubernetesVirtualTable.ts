import type { KubernetesResourceSummary } from '../../shared/types';
import { calculateFixedVirtualWindow } from './virtualScroll.js';

export interface KubernetesVirtualWindowInput {
  itemCount: number;
  rowHeight: number;
  viewportHeight: number;
  scrollTop: number;
  overscan: number;
}

export interface KubernetesVirtualWindow {
  start: number;
  end: number;
  offsetTop: number;
  totalHeight: number;
}

export interface KubernetesVirtualTableOptions {
  container: HTMLElement;
  rowHeight: number;
  overscan: number;
  renderRow: (item: KubernetesResourceSummary) => HTMLElement;
  onNearEnd: () => void;
  onWindowChange: (range: { start: number; end: number }) => void;
}

export interface KubernetesVirtualTable {
  setWindow(window: {
    start: number;
    end: number;
    total: number;
    items: KubernetesResourceSummary[];
  }): void;
  dispose(): void;
}

/**
 * The DOM-free portion of the list projection. Keeping this separate makes
 * the 10k-row performance boundary testable without a browser renderer.
 */
export function calculateVirtualWindow(input: KubernetesVirtualWindowInput): KubernetesVirtualWindow {
  const window = calculateFixedVirtualWindow({
    itemCount: input.itemCount,
    rowHeight: input.rowHeight,
    viewportHeight: input.viewportHeight,
    scrollTop: input.scrollTop,
    overscan: input.overscan,
    clampScrollTop: true,
    minimumVisibleRows: 0,
  });

  return {
    start: window.start,
    end: window.end,
    offsetTop: window.offsetTop,
    totalHeight: window.totalHeight,
  };
}

/**
 * Fixed-row-height virtual table. Its rows are a bounded main-process window,
 * not a local copy of every loaded resource. Scroll updates are coalesced by
 * requestAnimationFrame before asking the main process for the next range.
 */
export function createKubernetesVirtualTable(options: KubernetesVirtualTableOptions): KubernetesVirtualTable {
  const spacer = options.container.querySelector<HTMLElement>('#kubernetes-table-spacer');
  const rows = options.container.querySelector<HTMLElement>('#kubernetes-table-rows');
  if (!spacer || !rows) {
    throw new Error('Kubernetes virtual table is missing its viewport children.');
  }

  let items: KubernetesResourceSummary[] = [];
  let windowStart = 0;
  let windowEnd = 0;
  let total = 0;
  let frame: number | undefined;
  let disposed = false;
  let nearEndSignature: string | undefined;
  let requestedWindowSignature: string | undefined;

  const render = (): void => {
    frame = undefined;
    if (disposed) return;

    const window = calculateVirtualWindow({
      itemCount: total,
      rowHeight: options.rowHeight,
      viewportHeight: options.container.clientHeight,
      scrollTop: options.container.scrollTop,
      overscan: options.overscan,
    });
    spacer.style.height = `${total * options.rowHeight}px`;
    rows.style.transform = `translateY(${window.offsetTop}px)`;
    const signature = `${window.start}:${window.end}`;
    if (requestedWindowSignature !== signature) {
      requestedWindowSignature = signature;
      options.onWindowChange({ start: window.start, end: window.end });
    }
    const relativeStart = window.start - windowStart;
    const relativeEnd = window.end - windowStart;
    const rowsInWindow = relativeStart >= 0 && relativeEnd <= items.length && windowEnd >= window.end
      ? items.slice(relativeStart, relativeEnd)
      : [];
    rows.replaceChildren(...rowsInWindow.map(options.renderRow));

    if (window.end >= Math.max(0, total - 20)) {
      const nearEnd = `${total}:${window.end}`;
      if (nearEndSignature !== nearEnd) {
        nearEndSignature = nearEnd;
        options.onNearEnd();
      }
    }
  };

  const scheduleRender = (): void => {
    if (disposed || frame !== undefined) return;
    frame = window.requestAnimationFrame(render);
  };

  const onScroll = (): void => scheduleRender();
  options.container.addEventListener('scroll', onScroll, { passive: true });

  return {
    setWindow(nextWindow): void {
      total = Math.max(0, Math.floor(nextWindow.total));
      windowStart = Math.min(Math.max(0, Math.floor(nextWindow.start)), total);
      windowEnd = Math.min(Math.max(windowStart, Math.floor(nextWindow.end)), total);
      items = nextWindow.items.slice(0, Math.max(0, windowEnd - windowStart));
      nearEndSignature = undefined;
      if (total === 0) {
        if (frame !== undefined) {
          window.cancelAnimationFrame(frame);
          frame = undefined;
        }
        requestedWindowSignature = undefined;
        spacer.style.height = '0px';
        rows.style.transform = 'translateY(0px)';
        rows.replaceChildren();
        return;
      }
      scheduleRender();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      options.container.removeEventListener('scroll', onScroll);
      if (frame !== undefined) {
        window.cancelAnimationFrame(frame);
      }
      rows.replaceChildren();
      spacer.style.height = '0px';
    },
  };
}
