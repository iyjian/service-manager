import {
  formatSqlCell,
  sqlCellPresentation,
  type SqlCellPresentation,
  type SqlDisplayResult,
} from './sqlResult.js';
import {
  calculateSqlResultVirtualWindow,
  SQL_RESULT_ESTIMATED_ROW_HEIGHT,
  SQL_RESULT_VIRTUALIZE_AFTER_ROWS,
} from './sqlResultVirtualWindow.js';

type SqlTableResult = Extract<SqlDisplayResult, { kind: 'table' }>;

export interface SqlVirtualResultTableOptions {
  host: HTMLElement;
  result: SqlTableResult;
  onOpenValue: (
    column: string,
    presentation: SqlCellPresentation,
    row: Readonly<Record<string, unknown>>,
  ) => void;
  onWindowRendered: () => void;
  onSort?: (column: string) => void;
  sortColumn?: string;
  sortDirection?: 'asc' | 'desc';
  initialColumnWidths?: (number | undefined)[];
  onColumnWidthsChange?: (widths: (number | undefined)[]) => void;
}

const SQL_RESULT_MIN_COLUMN_WIDTH = 64;
const SQL_RESULT_MAX_COLUMN_WIDTH = 720;
const SQL_RESULT_DEFAULT_COLUMN_WIDTH = 180;
const SQL_RESULT_MEASURED_COLUMN_CAP = 320;

function clampColumnWidth(value: number): number {
  return Math.min(
    SQL_RESULT_MAX_COLUMN_WIDTH,
    Math.max(SQL_RESULT_MIN_COLUMN_WIDTH, Math.round(value)),
  );
}

export class SqlVirtualResultTable {
  private readonly host: HTMLElement;
  private readonly result: SqlTableResult;
  private readonly onOpenValue: SqlVirtualResultTableOptions['onOpenValue'];
  private readonly onWindowRendered: SqlVirtualResultTableOptions['onWindowRendered'];
  private readonly onSort: SqlVirtualResultTableOptions['onSort'];
  private readonly sortColumn: string | undefined;
  private readonly sortDirection: 'asc' | 'desc' | undefined;
  private readonly onColumnWidthsChange: SqlVirtualResultTableOptions['onColumnWidthsChange'];
  private readonly wrap: HTMLDivElement;
  private readonly table: HTMLTableElement;
  private readonly columnElements: HTMLTableColElement[];
  private readonly body: HTMLTableSectionElement;
  private readonly resizeObserver: ResizeObserver;
  private columnWidths: number[];
  private rowHeight = SQL_RESULT_ESTIMATED_ROW_HEIGHT;
  private renderedStart = -1;
  private renderedEnd = -1;
  private selectedRowIndex: number | undefined;
  private renderFrame?: number;
  private measureFrame?: number;
  private destroyed = false;

  public constructor(options: SqlVirtualResultTableOptions) {
    this.host = options.host;
    this.result = options.result;
    this.onOpenValue = options.onOpenValue;
    this.onWindowRendered = options.onWindowRendered;
    this.onSort = options.onSort;
    this.sortColumn = options.sortColumn;
    this.sortDirection = options.sortDirection;
    this.onColumnWidthsChange = options.onColumnWidthsChange;
    this.wrap = document.createElement('div');
    this.wrap.className = 'sql-result-table-wrap';

    this.table = document.createElement('table');
    this.table.className = 'sql-result-table';
    this.table.style.tableLayout = 'fixed';
    this.table.setAttribute('aria-rowcount', String(this.result.rows.length + 1));
    this.table.setAttribute('aria-colcount', String(this.result.columns.length));

    this.columnElements = [];
    const columnGroup = document.createElement('colgroup');
    for (let index = 0; index < this.result.columns.length; index += 1) {
      const columnElement = document.createElement('col');
      this.columnElements.push(columnElement);
      columnGroup.append(columnElement);
    }
    this.table.append(columnGroup);

    const head = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const [columnIndex, column] of this.result.columns.entries()) {
      headRow.append(this.createHeaderCell(column, columnIndex));
    }
    head.append(headRow);

    this.body = document.createElement('tbody');
    this.table.append(head, this.body);
    this.wrap.append(this.table);
    this.host.replaceChildren(this.wrap);

    this.columnWidths = this.resolveInitialColumnWidths(options.initialColumnWidths);
    this.applyAllColumnWidths();
    this.applyTableWidth();

    this.host.addEventListener('scroll', this.handleScroll, { passive: true });
    this.host.addEventListener('click', this.handleClick);
    this.host.addEventListener('dblclick', this.handleDblClick);
    this.resizeObserver = new ResizeObserver(() => this.scheduleRender());
    this.resizeObserver.observe(this.host);
    this.renderWindow(true);
  }

  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.host.removeEventListener('scroll', this.handleScroll);
    this.host.removeEventListener('click', this.handleClick);
    this.host.removeEventListener('dblclick', this.handleDblClick);
    this.resizeObserver.disconnect();
    if (this.renderFrame !== undefined) window.cancelAnimationFrame(this.renderFrame);
    if (this.measureFrame !== undefined) window.cancelAnimationFrame(this.measureFrame);
    this.renderFrame = undefined;
    this.measureFrame = undefined;
  }

  private readonly handleScroll = (): void => {
    this.scheduleRender();
  };

  private readonly handleClick = (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const clickedRow = target.closest<HTMLTableRowElement>('tr[data-sql-result-row]');
    if (clickedRow && this.host.contains(clickedRow)) {
      const rowIndex = Number(clickedRow.dataset.sqlResultRow);
      this.selectRow(Number.isInteger(rowIndex) ? rowIndex : undefined);
    }
    const detail = target.closest<HTMLButtonElement>('[data-sql-cell-detail="true"]');
    if (!detail || !this.host.contains(detail)) return;
    const rowIndex = Number(detail.dataset.sqlRowIndex);
    const columnIndex = Number(detail.dataset.sqlColumnIndex);
    const row = this.result.rows[rowIndex];
    const column = this.result.columns[columnIndex];
    if (!row || column === undefined) return;
    this.onOpenValue(column, sqlCellPresentation(row[column]), row);
  };

  private readonly handleDblClick = (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const cell = target.closest<HTMLTableCellElement>('td');
    if (!cell || !this.host.contains(cell)) return;
    const row = cell.closest<HTMLTableRowElement>('tr[data-sql-result-row]');
    if (!row) return;
    const rowIndex = Number(row.dataset.sqlResultRow);
    const dataRow = this.result.rows[rowIndex];
    if (!dataRow) return;
    const columnIndex = Array.from(row.cells).indexOf(cell);
    const column = this.result.columns[columnIndex];
    if (column === undefined) return;
    this.onOpenValue(column, sqlCellPresentation(dataRow[column]), dataRow);
  };

  private createHeaderCell(column: string, columnIndex: number): HTMLTableCellElement {
    const cell = document.createElement('th');
    cell.scope = 'col';
    cell.setAttribute('aria-colindex', String(columnIndex + 1));
    if (this.sortColumn === column && this.sortDirection) {
      cell.setAttribute('aria-sort', this.sortDirection === 'desc' ? 'descending' : 'ascending');
    }

    const sort = document.createElement('button');
    sort.type = 'button';
    sort.className = 'sql-result-column-sort';
    sort.disabled = this.onSort === undefined;
    if (this.onSort) {
      sort.setAttribute('aria-label', `Sort by ${column}`);
      sort.title = `Sort by ${column}`;
      sort.addEventListener('click', () => this.onSort?.(column));
    }

    const label = document.createElement('span');
    label.className = 'sql-result-column-name';
    label.textContent = column;
    label.title = column;
    sort.append(label);

    if (this.sortColumn === column && this.sortDirection) {
      const indicator = document.createElement('span');
      indicator.className = 'sql-result-column-sort-indicator';
      indicator.setAttribute('aria-hidden', 'true');
      indicator.textContent = this.sortDirection === 'desc' ? '↓' : '↑';
      sort.append(indicator);
    }

    const resizer = document.createElement('span');
    resizer.className = 'sql-result-column-resizer';
    resizer.setAttribute('aria-hidden', 'true');
    resizer.addEventListener('pointerdown', (event) => this.startColumnResize(columnIndex, event));

    cell.append(sort, resizer);
    return cell;
  }

  private resolveInitialColumnWidths(
    initial: readonly (number | undefined)[] | undefined,
  ): number[] {
    const measured = this.measureColumnWidths();
    if (!initial || initial.length !== this.result.columns.length) return measured;
    return this.result.columns.map((_, index) => {
      const width = initial[index];
      return typeof width === 'number' && Number.isFinite(width)
        ? clampColumnWidth(width)
        : measured[index] ?? SQL_RESULT_DEFAULT_COLUMN_WIDTH;
    });
  }

  private measureColumnWidths(): number[] {
    const longest = this.result.columns.map(() => '');
    for (const row of this.result.rows) {
      for (let index = 0; index < this.result.columns.length; index += 1) {
        const column = this.result.columns[index] ?? '';
        const display = formatSqlCell(row[column]);
        if (display.length > (longest[index]?.length ?? 0)) longest[index] = display;
      }
    }
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) return this.result.columns.map(() => SQL_RESULT_DEFAULT_COLUMN_WIDTH);
    const style = getComputedStyle(this.table);
    context.font = style.font || `${style.fontSize} ${style.fontFamily}`;
    return this.result.columns.map((column, index) => {
      const textWidth = Math.max(
        context.measureText(column).width,
        context.measureText(longest[index] ?? '').width,
      );
      return clampColumnWidth(Math.ceil(Math.min(SQL_RESULT_MEASURED_COLUMN_CAP, textWidth) + 24));
    });
  }

  private applyAllColumnWidths(): void {
    for (let index = 0; index < this.columnElements.length; index += 1) {
      this.applyColumnWidth(index);
    }
  }

  private applyColumnWidth(index: number): void {
    const column = this.columnElements[index];
    if (!column) return;
    column.style.width = `${this.columnWidths[index] ?? SQL_RESULT_DEFAULT_COLUMN_WIDTH}px`;
  }

  private applyTableWidth(): void {
    const total = this.columnWidths.reduce(
      (sum, width) => sum + (width ?? SQL_RESULT_DEFAULT_COLUMN_WIDTH),
      0,
    );
    this.table.style.width = `${total}px`;
  }

  private startColumnResize(columnIndex: number, event: PointerEvent): void {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget as HTMLElement;
    const startX = event.clientX;
    const startWidth = this.columnWidths[columnIndex] ?? SQL_RESULT_DEFAULT_COLUMN_WIDTH;
    handle.setPointerCapture(event.pointerId);

    const move = (moveEvent: PointerEvent): void => {
      const width = clampColumnWidth(startWidth + moveEvent.clientX - startX);
      this.columnWidths[columnIndex] = width;
      this.applyColumnWidth(columnIndex);
      this.applyTableWidth();
    };
    const stop = (stopEvent: PointerEvent): void => {
      handle.releasePointerCapture(stopEvent.pointerId);
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', stop);
      handle.removeEventListener('pointercancel', stop);
      this.onColumnWidthsChange?.(this.columnWidths.slice());
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
  }

  private selectRow(rowIndex: number | undefined): void {
    if (this.selectedRowIndex === rowIndex) return;
    const previous = this.selectedRowIndex;
    this.selectedRowIndex = rowIndex;
    if (previous !== undefined) {
      this.body
        .querySelector<HTMLTableRowElement>(`tr[data-sql-result-row="${previous}"]`)
        ?.classList.remove('sql-result-row-selected');
    }
    if (rowIndex !== undefined) {
      this.body
        .querySelector<HTMLTableRowElement>(`tr[data-sql-result-row="${rowIndex}"]`)
        ?.classList.add('sql-result-row-selected');
    }
  }

  private scheduleRender(): void {
    if (this.destroyed || this.renderFrame !== undefined) return;
    this.renderFrame = window.requestAnimationFrame(() => {
      this.renderFrame = undefined;
      this.renderWindow(false);
    });
  }

  private renderWindow(force: boolean): void {
    if (this.destroyed) return;
    const range = calculateSqlResultVirtualWindow({
      rowCount: this.result.rows.length,
      scrollTop: this.host.scrollTop,
      viewportHeight: this.host.clientHeight,
      rowHeight: this.rowHeight,
    });
    if (!force && range.start === this.renderedStart && range.end === this.renderedEnd) return;
    this.renderedStart = range.start;
    this.renderedEnd = range.end;

    const nodes: HTMLTableRowElement[] = [];
    if (range.topSpacerHeight > 0) {
      nodes.push(this.createSpacerRow(range.topSpacerHeight));
    }
    for (let rowIndex = range.start; rowIndex < range.end; rowIndex += 1) {
      const row = this.result.rows[rowIndex];
      if (row) nodes.push(this.createDataRow(rowIndex, row));
    }
    if (range.bottomSpacerHeight > 0) {
      nodes.push(this.createSpacerRow(range.bottomSpacerHeight));
    }
    this.body.replaceChildren(...nodes);

    if (this.measureFrame !== undefined) window.cancelAnimationFrame(this.measureFrame);
    this.measureFrame = window.requestAnimationFrame(() => {
      this.measureFrame = undefined;
      if (this.destroyed) return;
      const renderedRow = this.body.querySelector<HTMLTableRowElement>('tr[data-sql-result-row]');
      const measuredHeight = renderedRow?.getBoundingClientRect().height ?? 0;
      if (measuredHeight > 0 && Math.abs(measuredHeight - this.rowHeight) >= 0.5) {
        this.rowHeight = measuredHeight;
        this.renderWindow(true);
        return;
      }
      this.onWindowRendered();
    });
  }

  private createSpacerRow(height: number): HTMLTableRowElement {
    const row = document.createElement('tr');
    row.setAttribute('aria-hidden', 'true');
    const cell = document.createElement('td');
    cell.colSpan = Math.max(1, this.result.columns.length);
    cell.style.height = `${height}px`;
    cell.style.padding = '0';
    cell.style.border = '0';
    cell.style.background = 'transparent';
    row.append(cell);
    return row;
  }

  private createDataRow(
    rowIndex: number,
    row: Readonly<Record<string, unknown>>,
  ): HTMLTableRowElement {
    const rowNode = document.createElement('tr');
    rowNode.dataset.sqlResultRow = String(rowIndex);
    rowNode.setAttribute('aria-selected', String(rowIndex === this.selectedRowIndex));
    rowNode.setAttribute('aria-rowindex', String(rowIndex + 2));
    if (rowIndex === this.selectedRowIndex) {
      rowNode.classList.add('sql-result-row-selected');
    }
    for (const [columnIndex, column] of this.result.columns.entries()) {
      const cell = document.createElement('td');
      cell.setAttribute('aria-colindex', String(columnIndex + 1));
      const presentation = sqlCellPresentation(row[column]);
      const content = document.createElement('div');
      content.className = 'sql-result-cell';
      const text = document.createElement('span');
      text.className = 'sql-result-cell-value';
      text.textContent = presentation.display;
      const detail = document.createElement('button');
      detail.type = 'button';
      detail.className = 'sql-result-cell-detail hidden';
      detail.dataset.sqlCellDetail = 'true';
      detail.dataset.sqlRowIndex = String(rowIndex);
      detail.dataset.sqlColumnIndex = String(columnIndex);
      detail.setAttribute('aria-label', `View full ${column} value`);
      detail.title = `View full ${column} value`;
      detail.innerHTML = '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="3.25" cy="8" r="1.15"></circle><circle cx="8" cy="8" r="1.15"></circle><circle cx="12.75" cy="8" r="1.15"></circle></svg>';
      content.append(text, detail);
      cell.append(content);
      rowNode.append(cell);
    }
    return rowNode;
  }
}
