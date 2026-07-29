export type SqlResultRow = Record<string, unknown>;

export type SqlDisplayResult =
  | { kind: 'table'; title: string; rows: SqlResultRow[]; columns: string[] }
  | { kind: 'summary'; title: string; items: Array<{ label: string; value: unknown }>; message?: string }
  | { kind: 'scalar'; title: string; value: string | number | boolean | null }
  | { kind: 'empty'; title: string; message: string; rowCount?: 0 }
  | { kind: 'json'; title: string; value: unknown }
  | { kind: 'multi'; title: string; results: SqlDisplayResult[] };

export interface SqlCellPresentation {
  raw: string;
  display: string;
  kind: 'json' | 'html' | 'text';
  formatted?: string;
}

const MUTATION_KEYS = [
  'affectedRows',
  'changedRows',
  'insertId',
  'warningStatus',
  'fieldCount',
  'serverStatus',
  'message',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isPrimitive(value: unknown): value is string | number | boolean | null {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

function tableResult(rows: SqlResultRow[], title: string, preferredColumns: string[] = []): SqlDisplayResult {
  const columns = new Set(preferredColumns);
  for (const row of rows) for (const key of Object.keys(row)) columns.add(key);
  if (rows.length === 0 || columns.size === 0) {
    return { kind: 'empty', title, message: 'No rows returned.', rowCount: 0 };
  }
  return { kind: 'table', title, rows, columns: [...columns] };
}

export function normalizeSqlResult(value: unknown, title = 'Result'): SqlDisplayResult {
  if (value === undefined || value === null) {
    return { kind: 'empty', title, message: 'No data returned.' };
  }
  if (isPrimitive(value)) return { kind: 'scalar', title, value };
  if (Array.isArray(value)) {
    if (value.length === 0) return { kind: 'empty', title, message: 'No rows returned.', rowCount: 0 };
    if (value.every(isRecord)) return tableResult(value, title);
    return {
      kind: 'multi',
      title,
      results: value.map((item, index) => normalizeSqlResult(item, `Result ${index + 1}`)),
    };
  }
  if (isRecord(value)) {
    const rows = Array.isArray(value.rows) && value.rows.every(isRecord) ? value.rows : undefined;
    if (rows) {
      const columns = Array.isArray(value.fields)
        ? value.fields
          .map((field) => isRecord(field) && typeof field.name === 'string' ? field.name : '')
          .filter(Boolean)
        : [];
      return tableResult(rows, title, columns);
    }
    const summaryKeys = MUTATION_KEYS.filter((key) => key in value);
    if (summaryKeys.length > 0) {
      return {
        kind: 'summary',
        title,
        items: summaryKeys.filter((key) => key !== 'message').map((key) => ({ label: key, value: value[key] })),
        ...(typeof value.message === 'string' ? { message: value.message } : {}),
      };
    }
  }
  return { kind: 'json', title, value };
}

export function formatSqlCell(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'string') {
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
      const date = new Date(value);
      if (Number.isFinite(date.getTime())) {
        const pad = (part: number): string => String(part).padStart(2, '0');
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
      }
    }
    return value.replace(/[\t\r\n]+/g, ' ');
  }
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value).replace(/[\t\r\n]+/g, ' ');
  }
}

function parsedJsonContainer(value: string): unknown | undefined {
  const trimmed = value.trim();
  if (!(trimmed.startsWith('{') && trimmed.endsWith('}'))
    && !(trimmed.startsWith('[') && trimmed.endsWith(']'))) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

const HTML_CONTENT_PATTERN = /<(?:!doctype\s+html|html|head|body|title|main|section|article|header|footer|nav|div|span|p|br|hr|h[1-6]|ul|ol|li|dl|dt|dd|table|thead|tbody|tfoot|tr|th|td|blockquote|pre|code|strong|em|b|i|u|s|a|img|figure|figcaption)\b/i;

export function sqlCellPresentation(value: unknown): SqlCellPresentation {
  if (value !== null && typeof value === 'object') {
    try {
      const raw = JSON.stringify(value);
      return {
        raw,
        display: raw,
        kind: 'json',
        formatted: JSON.stringify(value, null, 2),
      };
    } catch {
      const raw = String(value);
      return { raw, display: raw.replace(/[\t\r\n]+/g, ' '), kind: 'text' };
    }
  }

  const raw = value === null || value === undefined ? 'NULL' : String(value);
  if (typeof value === 'string') {
    const parsed = parsedJsonContainer(value);
    if (parsed !== undefined) {
      return {
        raw,
        display: formatSqlCell(value),
        kind: 'json',
        formatted: JSON.stringify(parsed, null, 2),
      };
    }
    if (HTML_CONTENT_PATTERN.test(value)) {
      return { raw, display: formatSqlCell(value), kind: 'html' };
    }
  }
  return { raw, display: formatSqlCell(value), kind: 'text' };
}

export function formatSqlDuration(durationMs: number | undefined): string {
  if (!Number.isFinite(durationMs) || durationMs === undefined || durationMs < 0) return '';
  if (durationMs < 1_000) return `${Math.round(durationMs)} ms`;
  if (durationMs < 10_000) return `${(durationMs / 1_000).toFixed(2)} s`;
  return `${(durationMs / 1_000).toFixed(1)} s`;
}

export function sqlResultRowCount(result: SqlDisplayResult): number {
  if (result.kind === 'table') return result.rows.length;
  if (result.kind === 'multi') return result.results.reduce((total, item) => total + sqlResultRowCount(item), 0);
  return 0;
}

export function sqlResultRowCountInfo(result: SqlDisplayResult): number | undefined {
  if (result.kind === 'table') return result.rows.length;
  if (result.kind === 'empty') return result.rowCount;
  if (result.kind !== 'multi') return undefined;
  const counts = result.results.map(sqlResultRowCountInfo).filter((count): count is number => count !== undefined);
  return counts.length ? counts.reduce((total, count) => total + count, 0) : undefined;
}
