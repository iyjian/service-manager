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

function nonNegativeFinite(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

export function calculateSqlResultVirtualWindow(
  input: SqlResultVirtualWindowInput,
): SqlResultVirtualWindow {
  const rowCount = Math.max(0, Math.floor(nonNegativeFinite(input.rowCount)));
  const rowHeight = Math.max(1, nonNegativeFinite(input.rowHeight));
  if (rowCount <= SQL_RESULT_VIRTUALIZE_AFTER_ROWS) {
    return {
      start: 0,
      end: rowCount,
      topSpacerHeight: 0,
      bottomSpacerHeight: 0,
    };
  }

  const scrollTop = nonNegativeFinite(input.scrollTop);
  const viewportHeight = Math.max(rowHeight, nonNegativeFinite(input.viewportHeight));
  const firstVisible = Math.min(
    rowCount - 1,
    Math.floor(Math.max(0, scrollTop - SQL_RESULT_HEADER_HEIGHT) / rowHeight),
  );
  const visibleRows = Math.max(1, Math.ceil(viewportHeight / rowHeight) + 1);
  const rawStart = Math.max(0, firstVisible - SQL_RESULT_OVERSCAN_ROWS);
  const start = Math.floor(rawStart / SQL_RESULT_WINDOW_CHUNK_ROWS)
    * SQL_RESULT_WINDOW_CHUNK_ROWS;
  const rawEnd = Math.min(
    rowCount,
    firstVisible + visibleRows + SQL_RESULT_OVERSCAN_ROWS,
  );
  const end = Math.min(
    rowCount,
    Math.max(
      start,
      Math.ceil(rawEnd / SQL_RESULT_WINDOW_CHUNK_ROWS) * SQL_RESULT_WINDOW_CHUNK_ROWS,
    ),
  );

  return {
    start,
    end,
    topSpacerHeight: start * rowHeight,
    bottomSpacerHeight: (rowCount - end) * rowHeight,
  };
}

