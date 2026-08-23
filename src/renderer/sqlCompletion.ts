import type { Completion } from '@codemirror/autocomplete';
import type { SQLNamespace } from '@codemirror/lang-sql';
import type { SqlDatabaseSchema, SqlSchemaColumn } from '../shared/types';
import { findSqlStatementBoundaries } from './sqlStatement.js';
import {
  MySQL as AntlrMySQL,
  type AntlrEntityContext,
  type AntlrToken,
} from './vendor/dt-sql-parser/parser/mysql/index.js';

export const SQL_COMPLETION_CONTEXT_CHARACTERS = 50_000;

const sqlAntlrParser = new AntlrMySQL();
const SQL_VISIBLE_TOKEN_CHANNEL = 0;
const SQL_STATEMENT_COMMAND_KEYWORDS = new Set(['select', 'update', 'delete', 'insert', 'replace']);
const SQL_FROM_CLAUSE_OWNER_KEYWORDS = new Set(['delete', 'select']);
const SQL_INSERT_INTO_OWNER_KEYWORDS = new Set(['insert', 'replace']);
const SQL_DEFAULT_TABLE_CONTEXT_KEYWORDS = new Set(['where', 'having', 'on', 'order', 'group']);
const SQL_TABLE_ENTITY_TYPE = 'table';
const SQL_LITERAL_TABLE_DECLARE_TYPE = 0;
const SQL_FROM_CLAUSE_END_KEYWORDS = new Set([
  'where',
  'group',
  'having',
  'order',
  'union',
  'intersect',
  'except',
  'limit',
  'offset',
  'fetch',
  'for',
  'into',
  'returning',
]);
const SQL_UPDATE_MODIFIER_KEYWORDS = new Set(['ignore', 'low_priority']);
const SQL_ALIAS_STOP_KEYWORDS = new Set([
  ...SQL_FROM_CLAUSE_END_KEYWORDS,
  'as',
  'cross',
  'inner',
  'join',
  'left',
  'natural',
  'on',
  'right',
  'set',
  'straight_join',
  'using',
]);
const SQL_TABLE_REFERENCE_STOP_TOKENS = new Set(['(', ')', ',', ';', '=', '+', '-', '*', '/', '%']);

export interface SqlTableReference {
  tableName: string;
  from: number;
  to: number;
}

export interface SqlTextRange {
  from: number;
  to: number;
}

export interface SqlEnumValuePart {
  value: string;
  description: string;
  isDefault: boolean;
}

export interface SqlEnumCommentDetails {
  description: string;
  values: readonly SqlEnumValuePart[];
}

export interface SqlQualifiedColumnCompletion {
  from: number;
  tableName: string;
  options: readonly Completion[];
}

export interface SqlEnumValueCompletion {
  from: number;
  tableName: string;
  columnName: string;
  description: string;
  options: readonly Completion[];
}

interface SqlAntlrTableReference extends SqlTableReference {
  alias?: string;
}

interface SqlStatementModel {
  references: SqlAntlrTableReference[];
  aliases: Map<string, string>;
}

function completionApplyText(label: string): string | undefined {
  return /^[a-z_][a-z_\d]*$/i.test(label)
    ? undefined
    : `\`${label.replace(/`/g, '``')}\``;
}

function columnCompletion(column: SqlSchemaColumn): {
  label: string;
  type: string;
  detail?: string;
  apply?: string;
  boost: number;
} {
  const apply = completionApplyText(column.name);
  return {
    label: column.name,
    type: 'property',
    ...(column.dataType ? { detail: column.dataType } : {}),
    ...(apply ? { apply } : {}),
    boost: 30,
  };
}

function namespaceKey(name: string): string {
  return name.replace(/\\/g, '\\\\').replace(/\./g, '\\.');
}

export function buildSqlCompletionNamespace(schema: SqlDatabaseSchema): SQLNamespace {
  const namespace: Record<string, SQLNamespace> = Object.create(null);
  for (const table of schema.tables) {
    const apply = completionApplyText(table.name);
    namespace[namespaceKey(table.name)] = {
      self: {
        label: table.name,
        type: 'type',
        detail: 'Table',
        ...(apply ? { apply } : {}),
        boost: 20,
      },
      children: table.columns.map(columnCompletion),
    };
  }
  return namespace;
}

function unquoteSqlIdentifier(identifier: string): string {
  if (identifier.startsWith('`') && identifier.endsWith('`')) {
    return identifier.slice(1, -1).replace(/``/g, '`');
  }
  if (identifier.startsWith('"') && identifier.endsWith('"')) {
    return identifier.slice(1, -1).replace(/""/g, '"');
  }
  return identifier;
}

function normalizeSqlLookupName(name: string): string {
  return name.toLowerCase();
}

function sqlTokenText(token: AntlrToken | undefined): string {
  return token?.text ?? '';
}

function sqlTokenLower(token: AntlrToken | undefined): string {
  return sqlTokenText(token).toLowerCase();
}

function isSqlVisibleToken(token: AntlrToken): boolean {
  return token.channel === SQL_VISIBLE_TOKEN_CHANNEL
    && typeof token.text === 'string'
    && token.text.length > 0
    && token.start >= 0
    && token.stop >= token.start;
}

function runSqlAntlrParser<T>(operation: () => T): T {
  const originalError = console.error;
  console.error = () => undefined;
  try {
    return operation();
  } finally {
    console.error = originalError;
  }
}

function sqlVisibleTokens(source: string): AntlrToken[] {
  try {
    return runSqlAntlrParser(() => sqlAntlrParser.getAllTokens(source))
      .filter(isSqlVisibleToken);
  } catch {
    return [];
  }
}

function isSqlIdentifierCandidate(token: AntlrToken | undefined): token is AntlrToken {
  const text = sqlTokenText(token);
  return /^`(?:``|[^`])+`$/.test(text)
    || /^"(?:[^"]|"")+"$/.test(text)
    || /^[A-Za-z_][\w$]*$/.test(text);
}

function sqlTokenEnd(token: AntlrToken): number {
  return token.stop + 1;
}

function sqlTokenDepths(tokens: readonly AntlrToken[]): number[] {
  const depths: number[] = [];
  let depth = 0;
  for (const token of tokens) {
    const text = sqlTokenText(token);
    if (text === ')') depth = Math.max(0, depth - 1);
    depths.push(depth);
    if (text === '(') depth += 1;
  }
  return depths;
}

function readSqlIdentifierChain(
  tokens: readonly AntlrToken[],
  index: number,
): { name: string; from: number; to: number; nextIndex: number } | undefined {
  let currentIndex = index;
  let current = tokens[currentIndex];
  if (!isSqlIdentifierCandidate(current)) return undefined;
  while (
    sqlTokenText(tokens[currentIndex + 1]) === '.'
    && isSqlIdentifierCandidate(tokens[currentIndex + 2])
  ) {
    currentIndex += 2;
    current = tokens[currentIndex];
  }
  if (!current) return undefined;
  return {
    name: unquoteSqlIdentifier(sqlTokenText(current)),
    from: current.start,
    to: sqlTokenEnd(current),
    nextIndex: currentIndex + 1,
  };
}

function isSqlAliasCandidate(token: AntlrToken | undefined): token is AntlrToken {
  if (!isSqlIdentifierCandidate(token)) return false;
  const lower = sqlTokenLower(token);
  return !SQL_ALIAS_STOP_KEYWORDS.has(lower)
    && !SQL_TABLE_REFERENCE_STOP_TOKENS.has(sqlTokenText(token));
}

function readSqlTableReference(
  tokens: readonly AntlrToken[],
  index: number,
): SqlAntlrTableReference | undefined {
  const identifier = readSqlIdentifierChain(tokens, index);
  if (!identifier) return undefined;
  let nextIndex = identifier.nextIndex;
  let alias: string | undefined;
  if (sqlTokenLower(tokens[nextIndex]) === 'as') nextIndex += 1;
  if (isSqlAliasCandidate(tokens[nextIndex])) {
    alias = unquoteSqlIdentifier(sqlTokenText(tokens[nextIndex]));
  }
  return {
    tableName: identifier.name,
    from: identifier.from,
    to: identifier.to,
    ...(alias ? { alias } : {}),
  };
}

function readSqlTableReferenceFromEntity(
  entity: AntlrEntityContext,
  tokens: readonly AntlrToken[],
): SqlAntlrTableReference | undefined {
  const from = entity.position.startIndex;
  const to = entity.position.endIndex + 1;
  const entityTokens = tokens.filter((token) => token.start >= from && sqlTokenEnd(token) <= to);
  const identifier = readSqlIdentifierChain(entityTokens, 0);
  if (!identifier) return undefined;
  const alias = entity._alias?.text
    ? unquoteSqlIdentifier(entity._alias.text)
    : undefined;
  return {
    tableName: identifier.name,
    from: identifier.from,
    to: identifier.to,
    ...(alias ? { alias } : {}),
  };
}

function isSqlLiteralTableEntity(entity: AntlrEntityContext): boolean {
  return entity.entityContextType === SQL_TABLE_ENTITY_TYPE
    && entity.declareType === SQL_LITERAL_TABLE_DECLARE_TYPE;
}

function collectSqlAntlrEntityTableReferences(
  source: string,
  tokens: readonly AntlrToken[],
): SqlAntlrTableReference[] {
  try {
    if (runSqlAntlrParser(() => sqlAntlrParser.validate(source)).length > 0) return [];
    return (runSqlAntlrParser(() => sqlAntlrParser.getAllEntities(source)) ?? [])
      .filter(isSqlLiteralTableEntity)
      .map((entity) => readSqlTableReferenceFromEntity(entity, tokens))
      .filter((reference): reference is SqlAntlrTableReference => reference !== undefined);
  } catch {
    return [];
  }
}

function nextSqlTableIndexAfterUpdate(
  tokens: readonly AntlrToken[],
  index: number,
): number {
  let next = index;
  while (SQL_UPDATE_MODIFIER_KEYWORDS.has(sqlTokenLower(tokens[next]))) next += 1;
  return next;
}

function addSqlAntlrTableReference(
  references: SqlAntlrTableReference[],
  tokens: readonly AntlrToken[],
  index: number,
): void {
  const reference = readSqlTableReference(tokens, index);
  if (reference) references.push(reference);
}

function collectSqlAntlrTableReferences(tokens: readonly AntlrToken[]): SqlAntlrTableReference[] {
  const references: SqlAntlrTableReference[] = [];
  const depths = sqlTokenDepths(tokens);
  const commandByDepth = new Map<number, string>();
  const fromClauseDepths = new Set<number>();
  const updateTargetDepths = new Set<number>();

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    const lower = sqlTokenLower(token);
    const depth = depths[index] ?? 0;

    if (fromClauseDepths.has(depth) && SQL_FROM_CLAUSE_END_KEYWORDS.has(lower)) {
      fromClauseDepths.delete(depth);
    }
    if (updateTargetDepths.has(depth) && lower === 'set') {
      updateTargetDepths.delete(depth);
    }

    if (SQL_STATEMENT_COMMAND_KEYWORDS.has(lower)) {
      commandByDepth.set(depth, lower);
      if (lower === 'update') {
        updateTargetDepths.add(depth);
        addSqlAntlrTableReference(
          references,
          tokens,
          nextSqlTableIndexAfterUpdate(tokens, index + 1),
        );
      }
      continue;
    }

    if (
      lower === 'from'
      && SQL_FROM_CLAUSE_OWNER_KEYWORDS.has(commandByDepth.get(depth) ?? '')
    ) {
      fromClauseDepths.add(depth);
      addSqlAntlrTableReference(references, tokens, index + 1);
      continue;
    }

    if (
      lower === 'join'
      && (fromClauseDepths.has(depth) || updateTargetDepths.has(depth))
    ) {
      addSqlAntlrTableReference(references, tokens, index + 1);
      continue;
    }

    if (
      lower === 'into'
      && SQL_INSERT_INTO_OWNER_KEYWORDS.has(commandByDepth.get(depth) ?? '')
    ) {
      addSqlAntlrTableReference(references, tokens, index + 1);
      continue;
    }

    if (sqlTokenText(token) === ',' && (fromClauseDepths.has(depth) || updateTargetDepths.has(depth))) {
      addSqlAntlrTableReference(references, tokens, index + 1);
    }
  }

  return references;
}

function canonicalSqlTableName(schema: SqlDatabaseSchema, tableName: string): string | undefined {
  const lower = normalizeSqlLookupName(tableName);
  return schema.tables.find(
    (table) => normalizeSqlLookupName(table.name) === lower,
  )?.name;
}

function findSqlSchemaTable(schema: SqlDatabaseSchema, tableName: string): SqlDatabaseSchema['tables'][number] | undefined {
  const canonical = canonicalSqlTableName(schema, tableName);
  return canonical
    ? schema.tables.find((table) => table.name === canonical)
    : undefined;
}

function findSqlSchemaColumn(
  table: SqlDatabaseSchema['tables'][number],
  columnName: string,
): SqlSchemaColumn | undefined {
  const lower = normalizeSqlLookupName(columnName);
  return table.columns.find((column) => normalizeSqlLookupName(column.name) === lower);
}

function sqlStatementModel(statementSource: string, schema?: SqlDatabaseSchema): SqlStatementModel {
  const tokens = sqlVisibleTokens(statementSource);
  const entityReferences = collectSqlAntlrEntityTableReferences(statementSource, tokens);
  const references = entityReferences.length > 0
    ? entityReferences
    : collectSqlAntlrTableReferences(tokens);
  const aliases = new Map<string, string>();
  for (const reference of references) {
    const canonical = schema
      ? canonicalSqlTableName(schema, reference.tableName)
      : reference.tableName;
    if (!canonical) continue;
    aliases.set(normalizeSqlLookupName(canonical), canonical);
    if (reference.alias) aliases.set(normalizeSqlLookupName(reference.alias), canonical);
  }
  return { references, aliases };
}

function executableSqlStatementSource(
  source: string,
  position: number,
  offset: number,
): { source: string; position: number; offset: number } | undefined {
  const firstToken = sqlVisibleTokens(source)[0];
  if (!firstToken) return undefined;
  if (position < firstToken.start) return undefined;
  return {
    source: source.slice(firstToken.start),
    position: position - firstToken.start,
    offset: offset + firstToken.start,
  };
}

function currentSqlStatementSource(
  source: string,
  position: number,
): { source: string; position: number; offset: number } | undefined {
  const safePosition = Math.max(0, Math.min(source.length, Math.trunc(position)));
  const statements = findSqlStatementBoundaries(source);
  const statement = statements
    .find((candidate) => safePosition >= candidate.from && safePosition <= candidate.to);
  const trailingStatement = statement ?? statements.find((candidate, index) => {
    const next = statements[index + 1];
    return safePosition > candidate.to
      && (!next || safePosition < next.from)
      && /^\s*$/.test(source.slice(candidate.to, safePosition));
  });
  if (!trailingStatement) return undefined;
  return executableSqlStatementSource(
    source.slice(trailingStatement.from, trailingStatement.to),
    safePosition - trailingStatement.from,
    trailingStatement.from,
  );
}

function previousSqlVisibleTokenIndex(tokens: readonly AntlrToken[], position: number): number {
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index];
    if (token && sqlTokenEnd(token) <= position) return index;
  }
  return -1;
}

function sqlTokenAtCursor(tokens: readonly AntlrToken[], position: number): { token: AntlrToken; index: number } | undefined {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    if (token.start < position && position <= sqlTokenEnd(token)) return { token, index };
  }
  return undefined;
}

function resolveSqlTableFromQualifier(
  model: SqlStatementModel,
  qualifier: string,
): string | undefined {
  return model.aliases.get(normalizeSqlLookupName(unquoteSqlIdentifier(qualifier)));
}

function hasSqlDefaultTableContext(tokens: readonly AntlrToken[]): boolean {
  return tokens.some((token) => SQL_DEFAULT_TABLE_CONTEXT_KEYWORDS.has(sqlTokenLower(token)));
}

export function resolveSqlTableReferenceAt(
  source: string,
  position: number,
  schema: SqlDatabaseSchema,
): SqlTableReference | undefined {
  if (!Number.isFinite(position)) return undefined;
  const statement = currentSqlStatementSource(source, position);
  if (!statement) return undefined;
  const model = sqlStatementModel(statement.source);
  for (const reference of model.references) {
    if (statement.position < reference.from || statement.position > reference.to) continue;
    const canonicalName = canonicalSqlTableName(schema, reference.tableName);
    if (!canonicalName) return undefined;
    return {
      tableName: canonicalName,
      from: statement.offset + reference.from,
      to: statement.offset + reference.to,
    };
  }
  return undefined;
}

export function resolveSqlTableReferenceNear(
  source: string,
  position: number,
  schema: SqlDatabaseSchema,
  range?: SqlTextRange,
): SqlTableReference | undefined {
  const candidates: number[] = [];
  if (range && Number.isFinite(range.from) && Number.isFinite(range.to)) {
    const from = Math.max(0, Math.min(source.length, Math.trunc(Math.min(range.from, range.to))));
    const to = Math.max(from, Math.min(source.length, Math.trunc(Math.max(range.from, range.to))));
    if (to > from) {
      candidates.push(from, Math.max(from, to - 1), Math.floor((from + to) / 2));
    }
  }
  candidates.push(position);

  const seen = new Set<number>();
  for (const candidate of candidates) {
    if (!Number.isFinite(candidate)) continue;
    const safePosition = Math.max(0, Math.min(source.length, Math.trunc(candidate)));
    if (seen.has(safePosition)) continue;
    seen.add(safePosition);
    const reference = resolveSqlTableReferenceAt(source, safePosition, schema);
    if (reference) return reference;
  }
  return undefined;
}

function normalizeSqlEnumValue(value: string): string | undefined {
  const trimmed = value.trim();
  if (!/^[0-9]+$/.test(trimmed)) return undefined;
  return trimmed.replace(/^0+(?=[0-9])/, '');
}

export function parseSqlEnumComment(
  comment: string,
  defaultValue?: string,
): SqlEnumCommentDetails {
  const separator = comment.indexOf('-');
  const description = (separator >= 0 ? comment.slice(0, separator) : comment).trim();
  const enumSource = separator >= 0 ? comment.slice(separator + 1).trim() : '';
  const normalizedDefault = defaultValue === undefined
    ? undefined
    : normalizeSqlEnumValue(defaultValue);
  const values: SqlEnumValuePart[] = [];
  const pattern = /(^|\s)([0-9]+)\s*-\s*([\s\S]*?)(?=\s+[0-9]+\s*-|$)/g;
  for (const match of enumSource.matchAll(pattern)) {
    const value = match[2]?.trim();
    const enumDescription = match[3]?.trim();
    if (!value || !enumDescription) continue;
    values.push({
      value,
      description: enumDescription,
      isDefault: normalizedDefault !== undefined
        && normalizeSqlEnumValue(value) === normalizedDefault,
    });
  }
  return { description, values };
}

export function resolveSqlDefaultTable(
  sourceBeforeCursor: string,
  schema: SqlDatabaseSchema,
): string | undefined {
  const window = sourceBeforeCursor.slice(-SQL_COMPLETION_CONTEXT_CHARACTERS);
  const statements = findSqlStatementBoundaries(window);
  const statement = statements[statements.length - 1];
  if (!statement) return undefined;
  const statementSource = window.slice(statement.from, statement.to);
  const tokens = sqlVisibleTokens(statementSource);
  if (!hasSqlDefaultTableContext(tokens)) return undefined;
  const model = sqlStatementModel(statementSource, schema);
  const references = new Set<string>(
    model.references
      .map((reference) => canonicalSqlTableName(schema, reference.tableName))
      .filter((tableName): tableName is string => tableName !== undefined),
  );
  return references.size === 1 ? [...references][0] : undefined;
}

export function resolveSqlSelectTables(statement: string): string[] {
  const model = sqlStatementModel(statement);
  const references: string[] = [];
  const seen = new Set<string>();
  for (const reference of model.references) {
    const key = normalizeSqlLookupName(reference.tableName);
    if (seen.has(key)) continue;
    seen.add(key);
    references.push(reference.tableName);
  }
  return references;
}

function columnCompletionOptions(
  schema: SqlDatabaseSchema,
  tableName: string | undefined,
): ReturnType<typeof columnCompletion>[] {
  if (!tableName) return [];
  return schema.tables.find((table) => table.name === tableName)?.columns.map(columnCompletion) ?? [];
}

function sqlQualifiedColumnPrefix(
  tokens: readonly AntlrToken[],
  position: number,
): { qualifier: string; from: number } | undefined {
  const current = sqlTokenAtCursor(tokens, position);
  if (
    current
    && isSqlIdentifierCandidate(current.token)
    && sqlTokenText(tokens[current.index - 1]) === '.'
    && isSqlIdentifierCandidate(tokens[current.index - 2])
  ) {
    return {
      qualifier: unquoteSqlIdentifier(sqlTokenText(tokens[current.index - 2])),
      from: current.token.start,
    };
  }

  const previousIndex = previousSqlVisibleTokenIndex(tokens, position);
  if (
    sqlTokenText(tokens[previousIndex]) === '.'
    && isSqlIdentifierCandidate(tokens[previousIndex - 1])
  ) {
    return {
      qualifier: unquoteSqlIdentifier(sqlTokenText(tokens[previousIndex - 1])),
      from: position,
    };
  }
  return undefined;
}

export function resolveSqlQualifiedColumnCompletion(
  source: string,
  position: number,
  schema: SqlDatabaseSchema,
): SqlQualifiedColumnCompletion | undefined {
  const statement = currentSqlStatementSource(source, position);
  if (!statement) return undefined;
  const tokens = sqlVisibleTokens(statement.source);
  const prefix = sqlQualifiedColumnPrefix(tokens, statement.position);
  if (!prefix) return undefined;
  const model = sqlStatementModel(statement.source, schema);
  const tableName = resolveSqlTableFromQualifier(model, prefix.qualifier);
  const options = columnCompletionOptions(schema, tableName);
  if (!tableName || options.length === 0) return undefined;
  return {
    from: statement.offset + prefix.from,
    tableName,
    options,
  };
}

function sqlColumnBeforeEquals(
  tokens: readonly AntlrToken[],
  position: number,
): { columnName: string; qualifier?: string; valueFrom: number } | undefined {
  let previousIndex = previousSqlVisibleTokenIndex(tokens, position);
  let valueFrom = position;
  if (
    previousIndex >= 1
    && sqlTokenText(tokens[previousIndex]) !== '='
    && sqlTokenText(tokens[previousIndex - 1]) === '='
  ) {
    valueFrom = tokens[previousIndex]!.start;
    previousIndex -= 1;
  }
  if (sqlTokenText(tokens[previousIndex]) !== '=') return undefined;

  const columnIndex = previousIndex - 1;
  const column = tokens[columnIndex];
  if (!isSqlIdentifierCandidate(column)) return undefined;
  if (
    sqlTokenText(tokens[columnIndex - 1]) === '.'
    && isSqlIdentifierCandidate(tokens[columnIndex - 2])
  ) {
    return {
      columnName: unquoteSqlIdentifier(sqlTokenText(column)),
      qualifier: unquoteSqlIdentifier(sqlTokenText(tokens[columnIndex - 2])),
      valueFrom,
    };
  }
  return {
    columnName: unquoteSqlIdentifier(sqlTokenText(column)),
    valueFrom,
  };
}

function enumValueCompletions(column: SqlSchemaColumn): { description: string; options: Completion[] } | undefined {
  if (!column.enum) return undefined;
  const parsed = parseSqlEnumComment(column.enum.comment, column.enum.defaultValue);
  if (parsed.values.length === 0) return undefined;
  return {
    description: parsed.description,
    options: parsed.values.map((part) => ({
      label: part.value,
      apply: part.value,
      type: 'constant',
      detail: `${part.description}${part.isDefault ? ' default' : ''}`,
      boost: part.isDefault ? 95 : 90,
    })),
  };
}

export function resolveSqlEnumValueCompletion(
  source: string,
  position: number,
  schema: SqlDatabaseSchema,
): SqlEnumValueCompletion | undefined {
  const statement = currentSqlStatementSource(source, position);
  if (!statement) return undefined;
  const tokens = sqlVisibleTokens(statement.source);
  const columnTarget = sqlColumnBeforeEquals(tokens, statement.position);
  if (!columnTarget) return undefined;
  const model = sqlStatementModel(statement.source, schema);
  const tableName = columnTarget.qualifier
    ? resolveSqlTableFromQualifier(model, columnTarget.qualifier)
    : resolveSqlDefaultTable(statement.source.slice(0, statement.position), schema);
  if (!tableName) return undefined;
  const table = findSqlSchemaTable(schema, tableName);
  if (!table) return undefined;
  const column = findSqlSchemaColumn(table, columnTarget.columnName);
  if (!column?.enum) return undefined;
  const completions = enumValueCompletions(column);
  if (!completions) return undefined;
  return {
    from: statement.offset + columnTarget.valueFrom,
    tableName: table.name,
    columnName: column.name,
    description: completions.description,
    options: completions.options,
  };
}

export function defaultTableColumnCompletions(
  schema: SqlDatabaseSchema,
  tableName: string | undefined,
): ReturnType<typeof columnCompletion>[] {
  return columnCompletionOptions(schema, tableName);
}
