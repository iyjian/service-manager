export interface FixedVirtualWindowInput {
  itemCount: number;
  rowHeight: number;
  viewportHeight: number;
  scrollTop: number;
  overscan: number;
  headerHeight?: number;
  chunkSize?: number;
  virtualizeAfter?: number;
  clampScrollTop?: boolean;
  extraVisibleRows?: number;
  minimumVisibleRows?: number;
}

export interface FixedVirtualWindow {
  start: number;
  end: number;
  offsetTop: number;
  totalHeight: number;
}

function nonNegativeFinite(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

export function calculateFixedVirtualWindow(input: FixedVirtualWindowInput): FixedVirtualWindow {
  const itemCount = Math.max(0, Math.floor(nonNegativeFinite(input.itemCount)));
  const rowHeight = Math.max(1, nonNegativeFinite(input.rowHeight));
  const totalHeight = itemCount * rowHeight;
  if (itemCount === 0) return { start: 0, end: 0, offsetTop: 0, totalHeight };
  if (input.virtualizeAfter !== undefined && itemCount <= input.virtualizeAfter) {
    return { start: 0, end: itemCount, offsetTop: 0, totalHeight };
  }

  const viewportHeight = Math.max(0, nonNegativeFinite(input.viewportHeight));
  const overscan = Math.max(0, Math.floor(nonNegativeFinite(input.overscan)));
  const chunkSize = Math.max(1, Math.floor(nonNegativeFinite(input.chunkSize ?? 1)));
  const headerHeight = nonNegativeFinite(input.headerHeight ?? 0);
  const scrollTop = input.clampScrollTop
    ? clamp(nonNegativeFinite(input.scrollTop), 0, Math.max(0, totalHeight - viewportHeight))
    : nonNegativeFinite(input.scrollTop);
  const firstVisible = Math.min(
    itemCount - 1,
    Math.floor(Math.max(0, scrollTop - headerHeight) / rowHeight),
  );
  const visibleRows = Math.max(
    Math.max(0, Math.floor(nonNegativeFinite(input.minimumVisibleRows ?? 1))),
    Math.ceil(viewportHeight / rowHeight) + Math.floor(nonNegativeFinite(input.extraVisibleRows ?? 0)),
  );
  const rawStart = Math.max(0, firstVisible - overscan);
  const start = Math.floor(rawStart / chunkSize) * chunkSize;
  const rawEnd = Math.min(itemCount, firstVisible + visibleRows + overscan);
  const end = Math.min(
    itemCount,
    Math.max(start, Math.ceil(rawEnd / chunkSize) * chunkSize),
  );

  return {
    start,
    end,
    offsetTop: start * rowHeight,
    totalHeight,
  };
}
