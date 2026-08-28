import type { SqlCellPresentation } from './sqlResult.js';

/**
 * Builds UPDATE statements for the SQL cell-value editor.
 *
 * These helpers are renderer-only and deterministic: they escape identifiers
 * and string literals and infer a SQL literal from a cell's runtime value so
 * the generated statement mirrors what the user sees before executing it.
 */

function escapeSqlStringLiteral(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

export function quoteSqlIdentifier(identifier: string): string {
  return `\`${identifier.replace(/`/g, '``')}\``;
}

/**
 * Builds the SET value literal from the cell's original runtime value and the
 * user's edited text. Editing a NULL cell to a value produces a string literal;
 * leaving it blank (or the word NULL) keeps it NULL. Numeric and boolean cells
 * keep their type unless the user enters something that no longer parses.
 */
export function buildSqlSetLiteral(originalValue: unknown, editedText: string): string {
  const trimmed = editedText.trim();
  if (originalValue === null || originalValue === undefined) {
    if (trimmed === '' || trimmed.toLocaleUpperCase() === 'NULL') return 'NULL';
    return escapeSqlStringLiteral(editedText);
  }
  if (typeof originalValue === 'number') {
    if (trimmed === '') return 'NULL';
    if (Number.isFinite(Number(trimmed))) return trimmed;
    return escapeSqlStringLiteral(editedText);
  }
  if (typeof originalValue === 'boolean') {
    const lower = trimmed.toLocaleLowerCase();
    if (lower === 'true' || lower === '1') return 'TRUE';
    if (lower === 'false' || lower === '0') return 'FALSE';
    if (lower === '' || lower === 'null') return 'NULL';
    return escapeSqlStringLiteral(editedText);
  }
  return escapeSqlStringLiteral(editedText);
}

export function sqlEditedTextForUpdate(
  presentation: Pick<SqlCellPresentation, 'kind'>,
  editedText: string,
): string {
  if (presentation.kind !== 'json') return editedText;
  try {
    return JSON.stringify(JSON.parse(editedText.trim())) ?? editedText;
  } catch {
    return editedText;
  }
}

function parseJsonText(value: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(value) as unknown };
  } catch {
    return { ok: false };
  }
}

function jsonComparable(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

export function sqlEditedRuntimeValue(
  currentValue: unknown,
  presentation: Pick<SqlCellPresentation, 'kind'>,
  editedText: string,
): unknown {
  const normalizedText = sqlEditedTextForUpdate(presentation, editedText);
  const trimmed = normalizedText.trim();
  if (currentValue === null || currentValue === undefined) {
    if (trimmed === '' || trimmed.toLocaleUpperCase() === 'NULL') return null;
    return normalizedText;
  }
  if (typeof currentValue === 'number') {
    if (trimmed === '') return null;
    const numeric = Number(trimmed);
    return Number.isFinite(numeric) ? numeric : normalizedText;
  }
  if (typeof currentValue === 'boolean') {
    const lower = trimmed.toLocaleLowerCase();
    if (lower === 'true' || lower === '1') return true;
    if (lower === 'false' || lower === '0') return false;
    if (lower === '' || lower === 'null') return null;
    return normalizedText;
  }
  if (presentation.kind === 'json' && typeof currentValue === 'object') {
    const parsed = parseJsonText(normalizedText);
    if (parsed.ok) return parsed.value;
  }
  return normalizedText;
}

export function sqlCellRuntimeValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if ((left === null || left === undefined) && (right === null || right === undefined)) return true;
  if (typeof left !== typeof right) return false;
  if (typeof left === 'object' && left !== null && right !== null) {
    const leftJson = jsonComparable(left);
    const rightJson = jsonComparable(right);
    return leftJson !== undefined && leftJson === rightJson;
  }
  return false;
}

export function isSqlEditedValueChanged(
  currentValue: unknown,
  presentation: Pick<SqlCellPresentation, 'kind'>,
  editedText: string,
): boolean {
  if (presentation.kind === 'json') {
    const editedJson = parseJsonText(editedText.trim());
    if (editedJson.ok) {
      if (typeof currentValue === 'string') {
        const currentJson = parseJsonText(currentValue.trim());
        if (currentJson.ok) {
          return jsonComparable(currentJson.value) !== jsonComparable(editedJson.value);
        }
      }
      if (typeof currentValue === 'object' && currentValue !== null) {
        return jsonComparable(currentValue) !== jsonComparable(editedJson.value);
      }
    }
  }
  return !sqlCellRuntimeValuesEqual(
    currentValue,
    sqlEditedRuntimeValue(currentValue, presentation, editedText),
  );
}

/** Builds a WHERE primary-key literal directly from the stored value type. */
export function buildSqlWhereLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return escapeSqlStringLiteral(String(value));
}

export interface SqlUpdatePrimaryKey {
  column: string;
  value: unknown;
}

export interface SqlUpdateStatementInput {
  table: string;
  column: string;
  originalValue: unknown;
  editedText: string;
  primaryKey: SqlUpdatePrimaryKey[];
}

export function buildUpdateStatement(input: SqlUpdateStatementInput): string {
  const set = `${quoteSqlIdentifier(input.column)} = ${buildSqlSetLiteral(
    input.originalValue,
    input.editedText,
  )}`;
  const where = input.primaryKey
    .map((entry) => `${quoteSqlIdentifier(entry.column)} = ${buildSqlWhereLiteral(entry.value)}`)
    .join(' AND ');
  return `UPDATE ${quoteSqlIdentifier(input.table)} SET ${set} WHERE ${where};`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Produces safe, lightly-highlighted HTML for a generated UPDATE statement.
 * The statement is HTML-escaped first, so cell values can never inject markup.
 */
export function highlightUpdateSql(statement: string): string {
  const escaped = escapeHtml(statement);
  return escaped.replace(
    /(`[^`]+`)|('(?:''|[^'])*')|\b(UPDATE|SET|WHERE|AND|NULL|TRUE|FALSE)\b|(\b\d+(?:\.\d+)?\b)/gi,
    (match, identifier, stringLiteral, keyword, number) => {
      if (identifier !== undefined) return `<span class="sql-ident">${identifier}</span>`;
      if (stringLiteral !== undefined) return `<span class="sql-value">${stringLiteral}</span>`;
      if (keyword !== undefined) return `<span class="sql-keyword">${keyword}</span>`;
      if (number !== undefined) return `<span class="sql-value">${number}</span>`;
      return match;
    },
  );
}
