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
}

export class SqlVirtualResultTable {
  private readonly host: HTMLElement;
  private readonly result: SqlTableResult;
  private readonly onOpenValue: SqlVirtualResultTableOptions['onOpenValue'];
  private readonly onWindowRendered: SqlVirtualResultTableOptions['onWindowRendered'];
  private readonly wrap: HTMLDivElement;
  private readonly body: HTMLTableSectionElement;
  private readonly resizeObserver: ResizeObserver;
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
    this.wrap = document.createElement('div');
    this.wrap.className = 'sql-result-table-wrap';

    const table = document.createElement('table');
    table.className = 'sql-result-table';
    table.setAttribute('aria-rowcount', String(this.result.rows.length + 1));
    table.setAttribute('aria-colcount', String(this.result.columns.length));

    const head = document.createElement('thead');
    const columnElements: HTMLTableColElement[] = [];
    if (this.result.rows.length > SQL_RESULT_VIRTUALIZE_AFTER_ROWS) {
      const columnGroup = document.createElement('colgroup');
      for (const _column of this.result.columns) {
        const columnElement = document.createElement('col');
        columnElements.push(columnElement);
        columnGroup.append(columnElement);
      }
      table.append(columnGroup);
    }
    const headRow = document.createElement('tr');
    for (const [columnIndex, column] of this.result.columns.entries()) {
      const cell = document.createElement('th');
      cell.scope = 'col';
      cell.setAttribute('aria-colindex', String(columnIndex + 1));
      const label = document.createElement('span');
      label.className = 'sql-result-column-name';
      label.textContent = column;
      label.title = column;
      cell.append(label);
      headRow.append(cell);
    }
    head.append(headRow);

    this.body = document.createElement('tbody');
    table.append(head, this.body);
    this.wrap.append(table);
    this.host.replaceChildren(this.wrap);
    if (columnElements.length > 0) this.applyStableColumnWidths(table, columnElements);
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

  private applyStableColumnWidths(
    table: HTMLTableElement,
    columnElements: readonly HTMLTableColElement[],
  ): void {
    const longestValues = this.result.columns.map(() => '');
    for (const row of this.result.rows) {
      for (const [columnIndex, column] of this.result.columns.entries()) {
        const display = formatSqlCell(row[column]);
        if (display.length > (longestValues[columnIndex]?.length ?? 0)) {
          longestValues[columnIndex] = display;
        }
      }
    }
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) return;
    const style = getComputedStyle(table);
    context.font = style.font || `${style.fontSize} ${style.fontFamily}`;
    for (const [columnIndex, columnElement] of columnElements.entries()) {
      const header = this.result.columns[columnIndex] ?? '';
      const value = longestValues[columnIndex] ?? '';
      const textWidth = Math.max(
        context.measureText(header).width,
        context.measureText(value).width,
      );
      columnElement.style.width = `${Math.ceil(Math.min(320, textWidth) + 24)}px`;
    }
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
