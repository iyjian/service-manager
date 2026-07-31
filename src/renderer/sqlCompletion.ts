import type { SQLNamespace } from '@codemirror/lang-sql';
import type { SqlDatabaseSchema, SqlSchemaColumn } from '../shared/types';

export const SQL_COMPLETION_CONTEXT_CHARACTERS = 50_000;

const SQL_IDENTIFIER = String.raw`(?:\`(?:\`\`|[^\`])+\`|[A-Za-z_][\w$]*)`;
const SQL_TABLE_REFERENCE = new RegExp(
  String.raw`\b(?:from|join)\s+(${SQL_IDENTIFIER}(?:\s*\.\s*${SQL_IDENTIFIER})?)`,
  'gi',
);
const SQL_DIRECT_TABLE_REFERENCE = new RegExp(
  String.raw`\b(?:from|join|update|into)\s+(${SQL_IDENTIFIER}(?:\s*\.\s*${SQL_IDENTIFIER})?)`,
  'gi',
);

export interface SqlTableReference {
  tableName: string;
  from: number;
  to: number;
}

export interface SqlEnumCommentPart {
  text: string;
  isDefault: boolean;
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

function maskSqlLiteralsAndComments(source: string): string {
  const output = [...source];
  let state: 'normal' | 'single' | 'double' | 'backtick' | 'line-comment' | 'block-comment' = 'normal';
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] ?? '';
    const next = source[index + 1] ?? '';

    if (state === 'line-comment') {
      if (character === '\n' || character === '\r') {
        state = 'normal';
      } else {
        output[index] = ' ';
      }
      continue;
    }
    if (state === 'block-comment') {
      output[index] = ' ';
      if (character === '*' && next === '/') {
        output[index + 1] = ' ';
        state = 'normal';
        index += 1;
      }
      continue;
    }
    if (state === 'single' || state === 'double') {
      output[index] = ' ';
      const delimiter = state === 'single' ? "'" : '"';
      if (character === '\\') {
        if (index + 1 < output.length) output[index + 1] = ' ';
        index += 1;
      } else if (character === delimiter) {
        if (next === delimiter) {
          output[index + 1] = ' ';
          index += 1;
        } else {
          state = 'normal';
        }
      }
      continue;
    }
    if (state === 'backtick') {
      if (character === '`') {
        if (next === '`') index += 1;
        else state = 'normal';
      }
      continue;
    }

    if (character === '-' && next === '-' && /\s/.test(source[index + 2] ?? ' ')) {
      output[index] = output[index + 1] = ' ';
      state = 'line-comment';
      index += 1;
    } else if (character === '#') {
      output[index] = ' ';
      state = 'line-comment';
    } else if (character === '/' && next === '*') {
      output[index] = output[index + 1] = ' ';
      state = 'block-comment';
      index += 1;
    } else if (character === "'") {
      output[index] = ' ';
      state = 'single';
    } else if (character === '"') {
      output[index] = ' ';
      state = 'double';
    } else if (character === '`') {
      state = 'backtick';
    }
  }
  return output.join('');
}

function unquoteLastIdentifier(reference: string): string | undefined {
  const identifiers = reference.match(/`(?:``|[^`])+`|[A-Za-z_][\w$]*/g);
  const identifier = identifiers?.at(-1);
  if (!identifier) return undefined;
  return identifier.startsWith('`') && identifier.endsWith('`')
    ? identifier.slice(1, -1).replace(/``/g, '`')
    : identifier;
}

function lastSqlIdentifierPart(
  reference: string,
  sourceOffset: number,
): SqlTableReference | undefined {
  const identifiers = [...reference.matchAll(new RegExp(SQL_IDENTIFIER, 'g'))];
  const match = identifiers.at(-1);
  const identifier = match?.[0];
  if (!identifier || match?.index === undefined) return undefined;
  const tableName = identifier.startsWith('`') && identifier.endsWith('`')
    ? identifier.slice(1, -1).replace(/``/g, '`')
    : identifier;
  return {
    tableName,
    from: sourceOffset + match.index,
    to: sourceOffset + match.index + identifier.length,
  };
}

export function resolveSqlTableReferenceAt(
  source: string,
  position: number,
  schema: SqlDatabaseSchema,
): SqlTableReference | undefined {
  if (!Number.isFinite(position)) return undefined;
  const safePosition = Math.max(0, Math.min(source.length, Math.trunc(position)));
  const windowFrom = Math.max(0, safePosition - SQL_COMPLETION_CONTEXT_CHARACTERS);
  const windowTo = Math.min(source.length, safePosition + 1_024);
  const sourceWindow = source.slice(windowFrom, windowTo);
  const masked = maskSqlLiteralsAndComments(sourceWindow);
  const canonicalNames = new Map(
    schema.tables.map((table) => [table.name.toLowerCase(), table.name]),
  );
  SQL_DIRECT_TABLE_REFERENCE.lastIndex = 0;
  for (const match of masked.matchAll(SQL_DIRECT_TABLE_REFERENCE)) {
    const reference = match[1];
    if (!reference || match.index === undefined) continue;
    const referenceOffset = windowFrom + match.index + match[0].lastIndexOf(reference);
    const part = lastSqlIdentifierPart(reference, referenceOffset);
    if (!part || safePosition < part.from || safePosition > part.to) continue;
    const canonicalName = canonicalNames.get(part.tableName.toLowerCase());
    if (!canonicalName) return undefined;
    return {
      tableName: canonicalName,
      from: part.from,
      to: part.to,
    };
  }
  return undefined;
}

function normalizeSqlEnumValue(value: string): string | undefined {
  const trimmed = value.trim();
  if (!/^[0-9]+$/.test(trimmed)) return undefined;
  return trimmed.replace(/^0+(?=[0-9])/, '');
}

export function sqlEnumCommentParts(
  comment: string,
  defaultValue?: string,
): readonly SqlEnumCommentPart[] {
  const normalizedDefault = defaultValue === undefined
    ? undefined
    : normalizeSqlEnumValue(defaultValue);
  if (normalizedDefault === undefined) return [{ text: comment, isDefault: false }];

  const pattern = /(^|[^0-9])([0-9]+)(?=\s*-\s*)/g;
  for (const match of comment.matchAll(pattern)) {
    const prefix = match[1] ?? '';
    const enumValue = match[2];
    if (
      enumValue === undefined
      || normalizeSqlEnumValue(enumValue) !== normalizedDefault
      || match.index === undefined
    ) continue;
    const valueFrom = match.index + prefix.length;
    const valueTo = valueFrom + enumValue.length;
    return [
      ...(valueFrom > 0 ? [{ text: comment.slice(0, valueFrom), isDefault: false }] : []),
      { text: enumValue, isDefault: true },
      ...(valueTo < comment.length ? [{ text: comment.slice(valueTo), isDefault: false }] : []),
    ];
  }
  return [{ text: comment, isDefault: false }];
}

export function resolveSqlDefaultTable(
  sourceBeforeCursor: string,
  schema: SqlDatabaseSchema,
): string | undefined {
  const canonicalNames = new Map(
    schema.tables.map((table) => [table.name.toLocaleLowerCase(), table.name]),
  );
  const references = new Set<string>();
  const source = maskSqlLiteralsAndComments(
    sourceBeforeCursor.slice(-SQL_COMPLETION_CONTEXT_CHARACTERS),
  );
  if (!/\b(?:where|having|on|order\s+by|group\s+by)\b[\s\S]*$/i.test(source)) {
    return undefined;
  }
  SQL_TABLE_REFERENCE.lastIndex = 0;
  for (const match of source.matchAll(SQL_TABLE_REFERENCE)) {
    const identifier = unquoteLastIdentifier(match[1] ?? '');
    const canonical = identifier
      ? canonicalNames.get(identifier.toLocaleLowerCase())
      : undefined;
    if (canonical) references.add(canonical);
  }
  return references.size === 1 ? references.values().next().value : undefined;
}

export function defaultTableColumnCompletions(
  schema: SqlDatabaseSchema,
  tableName: string | undefined,
): ReturnType<typeof columnCompletion>[] {
  if (!tableName) return [];
  return schema.tables.find((table) => table.name === tableName)?.columns.map(columnCompletion) ?? [];
}
