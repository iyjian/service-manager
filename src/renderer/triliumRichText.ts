const TRILIUM_TODO_LIST_CLASS = 'todo-list';
const TRILIUM_TODO_LABEL_CLASS = 'todo-list__label';
const TRILIUM_TODO_DESCRIPTION_CLASS = 'todo-list__label__description';
const TRILIUM_TABLE_PERCENTAGE_WIDTH = 1_000;
const TRILIUM_TABLE_CELL_MIN_WIDTH = 96;
const TRILIUM_TABLE_CELL_MAX_WIDTH = 8_192;
const TRILIUM_TABLE_MAX_COLUMNS = 200;
const TRILIUM_TABLE_MAX_ROWS = 1_000;
const TRILIUM_REMOTE_ID_PATTERN = /^[A-Za-z0-9_]{4,32}$/;
const TRILIUM_IMAGE_PERCENTAGE_BASE_WIDTH = 1_000;

interface ParsedTriliumTableWidth {
  value: number;
  unit: 'percent' | 'pixel';
}

export interface TriliumTableCellSpan {
  colspan: number;
  rowspan: number;
}

export interface TriliumImageSource {
  sourceKey: string;
  kind: 'attachment' | 'note';
  remoteId: string;
}

function classTokens(value: string | null | undefined): string[] {
  return (value ?? '').split(/\s+/).filter(Boolean);
}

function containsEncodedPathTraversal(value: string): boolean {
  const pathname = value.split(/[?#]/, 1)[0] ?? '';
  return pathname.split('/').some((segment) => {
    let decoded = segment;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return true;
    }
    return decoded === '.' || decoded === '..' || decoded.includes('\\');
  });
}

/** Maps a Trilium UI image URL to the only matching read-only ETAPI resource. */
export function parseTriliumImageSource(
  value: string | null | undefined,
  endpoint: string,
): TriliumImageSource | undefined {
  const source = value?.trim();
  if (!source || source.length > 2_048 || source.includes('\\') || containsEncodedPathTraversal(source)) {
    return undefined;
  }

  let endpointUrl: URL;
  let sourceUrl: URL;
  try {
    endpointUrl = new URL(endpoint);
    const endpointBase = `${endpoint.replace(/\/+$/, '')}/`;
    sourceUrl = new URL(source, endpointBase);
  } catch {
    return undefined;
  }
  if ((sourceUrl.protocol !== 'https:' && sourceUrl.protocol !== 'http:')
    || sourceUrl.origin !== endpointUrl.origin
    || sourceUrl.username
    || sourceUrl.password
    || sourceUrl.hash) {
    return undefined;
  }

  const endpointPath = endpointUrl.pathname.replace(/\/+$/, '');
  const apiPrefix = `${endpointPath}/api/`.replace(/\/{2,}/g, '/');
  if (!sourceUrl.pathname.startsWith(apiPrefix)) return undefined;
  const encodedSegments = sourceUrl.pathname.slice(apiPrefix.length).split('/');
  const segments: string[] = [];
  try {
    for (const segment of encodedSegments) segments.push(decodeURIComponent(segment));
  } catch {
    return undefined;
  }
  if (segments.some((segment) => segment === '.' || segment === '..' || segment.includes('\\'))) {
    return undefined;
  }

  if (segments[0] === 'attachments'
    && segments.length >= 4
    && segments[2] === 'image'
    && segments.slice(3).every(Boolean)
    && TRILIUM_REMOTE_ID_PATTERN.test(segments[1] ?? '')) {
    const remoteId = segments[1] as string;
    return { sourceKey: `attachment:${remoteId}`, kind: 'attachment', remoteId };
  }
  if (segments[0] === 'images'
    && segments.length >= 2
    && segments.slice(2).every(Boolean)
    && TRILIUM_REMOTE_ID_PATTERN.test(segments[1] ?? '')) {
    const remoteId = segments[1] as string;
    return { sourceKey: `note:${remoteId}`, kind: 'note', remoteId };
  }
  return undefined;
}

export function triliumImageAlignment(
  figureClass: string | null | undefined,
  imageClass: string | null | undefined,
): 'left' | 'center' | 'right' {
  const figureClasses = classTokens(figureClass);
  const classes = new Set([...figureClasses, ...classTokens(imageClass)]);
  if (classes.has('image-style-align-right')
    || classes.has('image-style-block-align-right')
    || classes.has('image-style-side')) return 'right';
  if (classes.has('image-style-align-center')
    || classes.has('image-style-block-align-center')) return 'center';
  if (classes.has('image-style-align-left')
    || classes.has('image-style-block-align-left')) return 'left';
  // CKEditor renders a plain figure.image as a centered display-table block.
  if (figureClasses.includes('image')) return 'center';
  return 'left';
}

/** Maps CKEditor percentage widths to the same stable 1,000px import canvas used by table columns. */
export function triliumImagePixelWidth(...values: Array<string | null | undefined>): number | undefined {
  for (const value of values) {
    const match = (value ?? '').trim().match(/^(\d+(?:\.\d+)?)\s*(%|px)?$/i);
    if (!match) continue;
    const numericValue = Number(match[1]);
    const width = Math.round(match[2] === '%'
      ? numericValue * TRILIUM_IMAGE_PERCENTAGE_BASE_WIDTH / 100
      : numericValue);
    if (!Number.isSafeInteger(width) || width <= 0) return undefined;
    if (match[2] === '%') return Math.min(8_192, Math.max(48, width));
    return width >= 48 && width <= 8_192 ? width : undefined;
  }
  return undefined;
}

/** Matches one exact CKEditor class token without accepting lookalike names. */
export function hasTriliumHtmlClass(
  value: string | null | undefined,
  expected: string,
): boolean {
  return classTokens(value).includes(expected);
}

export function isTriliumTodoListClass(value: string | null | undefined): boolean {
  return hasTriliumHtmlClass(value, TRILIUM_TODO_LIST_CLASS);
}

export function isTriliumTodoLabelClass(value: string | null | undefined): boolean {
  return hasTriliumHtmlClass(value, TRILIUM_TODO_LABEL_CLASS);
}

export function isTriliumTodoDescriptionClass(value: string | null | undefined): boolean {
  return hasTriliumHtmlClass(value, TRILIUM_TODO_DESCRIPTION_CLASS);
}

export function isTriliumTodoCheckboxType(value: string | null | undefined): boolean {
  return (value ?? '').trim().toLocaleLowerCase() === 'checkbox';
}

/** DOMParser normally reflects the checked attribute through the property; retain either signal. */
export function triliumTodoChecked(
  checkedProperty: boolean,
  hasCheckedAttribute: boolean,
): boolean {
  return checkedProperty || hasCheckedAttribute;
}

function parseTriliumTableWidth(value: string | null | undefined): ParsedTriliumTableWidth | undefined {
  const match = (value ?? '').trim().match(/^(\d+(?:\.\d+)?)\s*(%|px)?$/i);
  if (!match) return undefined;
  const numericValue = Number(match[1]);
  if (!Number.isFinite(numericValue) || numericValue <= 0) return undefined;
  return {
    value: numericValue,
    unit: match[2]?.toLocaleLowerCase() === '%' ? 'percent' : 'pixel',
  };
}

/**
 * Converts one complete CKEditor colgroup to the bounded integer pixel widths
 * consumed by Tiptap's official table parser. A uniform scale preserves the
 * source proportions while respecting TableKit's minimum and canonical limit.
 */
export function normalizeTriliumTableColumnWidths(
  values: readonly (string | null | undefined)[],
): number[] | undefined {
  if (values.length === 0 || values.length > TRILIUM_TABLE_MAX_COLUMNS) return undefined;
  const parsed = values.map(parseTriliumTableWidth);
  if (parsed.some((value) => value === undefined)) return undefined;
  const widths = parsed as ParsedTriliumTableWidth[];
  const unit = widths[0]?.unit;
  if (!unit || widths.some((width) => width.unit !== unit)) return undefined;

  const rawWidths = widths.map((width) => width.value);
  const total = rawWidths.reduce((sum, width) => sum + width, 0);
  const smallest = Math.min(...rawWidths);
  const largest = Math.max(...rawWidths);
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(smallest) || !Number.isFinite(largest)) {
    return undefined;
  }

  const sourceScale = unit === 'percent' ? TRILIUM_TABLE_PERCENTAGE_WIDTH / total : 1;
  const minimumScale = TRILIUM_TABLE_CELL_MIN_WIDTH / smallest;
  const maximumScale = TRILIUM_TABLE_CELL_MAX_WIDTH / largest;
  const scale = Math.min(Math.max(sourceScale, minimumScale), maximumScale);
  if (!Number.isFinite(scale) || scale <= 0) return undefined;

  return rawWidths.map((width) => Math.max(
    1,
    Math.min(TRILIUM_TABLE_CELL_MAX_WIDTH, Math.round(width * scale)),
  ));
}

/**
 * Resolves cell widths against the logical table grid, including row/column
 * spans. Returning undefined leaves the source table untouched rather than
 * attaching a malformed colwidth vector that canonical validation would reject.
 */
export function mapTriliumTableCellColumnWidths(
  rows: readonly (readonly TriliumTableCellSpan[])[],
  columnWidths: readonly number[],
): number[][][] | undefined {
  if (
    rows.length === 0
    || rows.length > TRILIUM_TABLE_MAX_ROWS
    || columnWidths.length === 0
    || columnWidths.length > TRILIUM_TABLE_MAX_COLUMNS
    || columnWidths.some((width) => (
      !Number.isInteger(width)
      || width < 1
      || width > TRILIUM_TABLE_CELL_MAX_WIDTH
    ))
  ) return undefined;

  const occupiedUntil = Array.from({ length: columnWidths.length }, () => 0);
  const result: number[][][] = [];
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    if (!row) return undefined;
    let columnIndex = 0;
    const mappedRow: number[][] = [];
    for (const cell of row) {
      if (
        !Number.isInteger(cell.colspan)
        || cell.colspan < 1
        || cell.colspan > TRILIUM_TABLE_MAX_COLUMNS
        || !Number.isInteger(cell.rowspan)
        || cell.rowspan < 1
        || cell.rowspan > TRILIUM_TABLE_MAX_ROWS
      ) return undefined;
      while (
        columnIndex < columnWidths.length
        && (occupiedUntil[columnIndex] ?? 0) > rowIndex
      ) columnIndex += 1;
      const endColumn = columnIndex + cell.colspan;
      if (endColumn > columnWidths.length || rowIndex + cell.rowspan > rows.length) return undefined;
      for (let column = columnIndex; column < endColumn; column += 1) {
        if ((occupiedUntil[column] ?? 0) > rowIndex) return undefined;
      }
      mappedRow.push(columnWidths.slice(columnIndex, endColumn));
      for (let column = columnIndex; column < endColumn; column += 1) {
        occupiedUntil[column] = rowIndex + cell.rowspan;
      }
      columnIndex = endColumn;
    }
    if (occupiedUntil.some((until) => until <= rowIndex)) return undefined;
    result.push(mappedRow);
  }
  if (occupiedUntil.some((until) => until > rows.length)) return undefined;
  return result;
}
