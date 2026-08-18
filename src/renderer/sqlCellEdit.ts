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

/**
 * Computes the runtime cell value an update will store, mirroring the type
 * inference in {@link buildSqlSetLiteral}. The result is used to sync the
 * edited cell back into the in-memory result after a successful UPDATE.
 */
export function editedSqlCellValue(originalValue: unknown, editedText: string): unknown {
  const trimmed = editedText.trim();
  if (originalValue === null || originalValue === undefined) {
    if (trimmed === '' || trimmed.toLocaleUpperCase() === 'NULL') return null;
    return editedText;
  }
  if (typeof originalValue === 'number') {
    if (trimmed === '') return null;
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) return numeric;
    return editedText;
  }
  if (typeof originalValue === 'boolean') {
    const lower = trimmed.toLocaleLowerCase();
    if (lower === 'true' || lower === '1') return true;
    if (lower === 'false' || lower === '0') return false;
    if (lower === '' || lower === 'null') return null;
    return editedText;
  }
  return editedText;
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
