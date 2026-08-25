import { calculateFixedVirtualWindow } from '../components/virtualScroll.js';

export const SQL_RESULT_VIRTUALIZE_AFTER_ROWS = 100;
export const SQL_RESULT_ESTIMATED_ROW_HEIGHT = 31;
export const SQL_RESULT_HEADER_HEIGHT = 34;
export const SQL_RESULT_OVERSCAN_ROWS = 8;
export const SQL_RESULT_WINDOW_CHUNK_ROWS = 8;

export interface SqlResultVirtualWindowInput {
  rowCount: number;
  scrollTop: number;
  viewportHeight: number;
  rowHeight: number;
}

export interface SqlResultVirtualWindow {
  start: number;
  end: number;
  topSpacerHeight: number;
  bottomSpacerHeight: number;
}

export function calculateSqlResultVirtualWindow(
  input: SqlResultVirtualWindowInput,
): SqlResultVirtualWindow {
  const rowHeight = Math.max(1, Number.isFinite(input.rowHeight) ? Math.max(0, input.rowHeight) : 0);
  const window = calculateFixedVirtualWindow({
    itemCount: input.rowCount,
    scrollTop: input.scrollTop,
    viewportHeight: Math.max(rowHeight, Number.isFinite(input.viewportHeight) ? Math.max(0, input.viewportHeight) : 0),
    rowHeight,
    overscan: SQL_RESULT_OVERSCAN_ROWS,
    headerHeight: SQL_RESULT_HEADER_HEIGHT,
    chunkSize: SQL_RESULT_WINDOW_CHUNK_ROWS,
    virtualizeAfter: SQL_RESULT_VIRTUALIZE_AFTER_ROWS,
    extraVisibleRows: 1,
  });

  return {
    start: window.start,
    end: window.end,
    topSpacerHeight: window.offsetTop,
    bottomSpacerHeight: window.totalHeight - (window.end * rowHeight),
  };
}
