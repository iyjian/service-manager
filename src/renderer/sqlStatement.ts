export interface SqlStatementBoundary {
  from: number;
  to: number;
}

export interface SqlStatementRange extends SqlStatementBoundary {
  sql: string;
}

export type SqlStatementResolution =
  | { ok: true; statement: SqlStatementRange }
  | { ok: false; message: string };

export type SqlStatementBoundaryResolution =
  | { ok: true; statement: SqlStatementBoundary }
  | { ok: false; message: string };

type ScanState = 'normal' | 'single' | 'double' | 'backtick' | 'line-comment' | 'block-comment';

function trimRange(source: string, from: number, to: number): SqlStatementBoundary | undefined {
  let start = from;
  let end = to;
  while (start < end && /\s/.test(source[start] ?? '')) start += 1;
  while (end > start && /\s/.test(source[end - 1] ?? '')) end -= 1;
  if (start >= end) return undefined;
  return { from: start, to: end };
}

/**
 * Splits on semicolons outside MySQL strings, identifiers, and comments.
 * Comment-only fragments are ignored, while comments attached to a statement
 * remain part of the submitted source.
 */
export function findSqlStatementBoundaries(source: string): SqlStatementBoundary[] {
  const ranges: SqlStatementBoundary[] = [];
  let state: ScanState = 'normal';
  let segmentStart = 0;
  let hasExecutableToken = false;

  const finishSegment = (end: number): void => {
    if (hasExecutableToken) {
      const range = trimRange(source, segmentStart, end);
      if (range) ranges.push(range);
    }
    segmentStart = end;
    hasExecutableToken = false;
  };

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] ?? '';
    const next = source[index + 1] ?? '';

    if (state === 'line-comment') {
      if (character === '\n' || character === '\r') state = 'normal';
      continue;
    }
    if (state === 'block-comment') {
      if (character === '*' && next === '/') {
        state = 'normal';
        index += 1;
      }
      continue;
    }
    if (state === 'single' || state === 'double' || state === 'backtick') {
      const delimiter = state === 'single' ? "'" : state === 'double' ? '"' : '`';
      if (character === '\\') {
        index += 1;
        continue;
      }
      if (character === delimiter) {
        if (next === delimiter) index += 1;
        else state = 'normal';
      }
      continue;
    }

    if (character === '-' && next === '-' && /\s/.test(source[index + 2] ?? ' ')) {
      state = 'line-comment';
      index += 1;
      continue;
    }
    if (character === '#') {
      state = 'line-comment';
      continue;
    }
    if (character === '/' && next === '*') {
      state = 'block-comment';
      index += 1;
      continue;
    }
    if (character === "'") {
      state = 'single';
      hasExecutableToken = true;
      continue;
    }
    if (character === '"') {
      state = 'double';
      hasExecutableToken = true;
      continue;
    }
    if (character === '`') {
      state = 'backtick';
      hasExecutableToken = true;
      continue;
    }
    if (character === ';') {
      finishSegment(index + 1);
      continue;
    }
    if (!/\s/.test(character)) hasExecutableToken = true;
  }

  finishSegment(source.length);
  return ranges;
}

export function splitSqlStatements(source: string): SqlStatementRange[] {
  return findSqlStatementBoundaries(source).map(({ from, to }) => ({
    from,
    to,
    sql: source.slice(from, to),
  }));
}

export function resolveSqlStatementFromBoundaries(
  source: string,
  statements: readonly SqlStatementBoundary[],
  from: number,
  to = from,
): SqlStatementResolution {
  const resolution = resolveSqlStatementBoundary(
    source.length,
    statements,
    from,
    to,
    (sliceFrom, sliceTo) => source.slice(sliceFrom, sliceTo),
  );
  if (!resolution.ok) return resolution;
  return {
    ok: true,
    statement: {
      ...resolution.statement,
      sql: source.slice(resolution.statement.from, resolution.statement.to),
    },
  };
}

export function resolveSqlStatementBoundary(
  sourceLength: number,
  statements: readonly SqlStatementBoundary[],
  from: number,
  to: number,
  readSource: (from: number, to: number) => string,
): SqlStatementBoundaryResolution {
  const safeLength = Math.max(0, Math.trunc(sourceLength));
  const safeFrom = Math.max(0, Math.min(safeLength, Math.trunc(from)));
  const safeTo = Math.max(safeFrom, Math.min(safeLength, Math.trunc(to)));
  if (safeTo > safeFrom) {
    const selectedSource = readSource(safeFrom, safeTo);
    const selectedStatements = findSqlStatementBoundaries(selectedSource);
    if (selectedStatements.length !== 1) {
      return { ok: false, message: 'Select exactly one SQL statement to run.' };
    }
    const selected = selectedStatements[0];
    if (!selected) return { ok: false, message: 'Select a single SQL statement to run.' };
    return {
      ok: true,
      statement: {
        from: safeFrom + selected.from,
        to: safeFrom + selected.to,
      },
    };
  }

  if (statements.length === 0) {
    return { ok: false, message: 'Enter a SQL statement to run.' };
  }
  const containing = statements.find((statement) => safeFrom >= statement.from && safeFrom <= statement.to);
  if (containing) return { ok: true, statement: containing };
  const next = statements.find((statement) => statement.from > safeFrom);
  const statement = next ?? statements[statements.length - 1]!;
  return { ok: true, statement };
}

export function resolveSqlStatement(source: string, from: number, to = from): SqlStatementResolution {
  return resolveSqlStatementFromBoundaries(
    source,
    findSqlStatementBoundaries(source),
    from,
    to,
  );
}

function firstSqlKeyword(statement: string): string {
  let index = 0;
  while (index < statement.length) {
    while (/\s/.test(statement[index] ?? '')) index += 1;
    if ((statement.startsWith('--', index) && /\s/.test(statement[index + 2] ?? ' '))
      || statement[index] === '#') {
      const newline = statement.indexOf('\n', index + 1);
      index = newline < 0 ? statement.length : newline + 1;
      continue;
    }
    if (statement.startsWith('/*', index)) {
      const end = statement.indexOf('*/', index + 2);
      index = end < 0 ? statement.length : end + 2;
      continue;
    }
    break;
  }
  return /^[a-z]+/i.exec(statement.slice(index))?.[0]?.toLocaleUpperCase() ?? '';
}

/** Conservative production guard: unknown and CTE statements require confirmation. */
export function isLikelyReadOnlySql(statement: string): boolean {
  return ['SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN'].includes(firstSqlKeyword(statement));
}

const SQL_TEMPLATE_PARAM_PATTERN = /\{\{\s*([^{}\s]+)\s*\}\}/g;

export function extractSqlTemplateParamNames(sql: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const match of sql.matchAll(SQL_TEMPLATE_PARAM_PATTERN)) {
    const name = match[1]?.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

export function replaceSqlTemplateParams(sql: string, params: Readonly<Record<string, string>>): string {
  return sql.replace(SQL_TEMPLATE_PARAM_PATTERN, (_match, name: string) => params[name.trim()] ?? '');
}
