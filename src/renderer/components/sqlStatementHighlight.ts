import { StateField, type EditorState } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';
import {
  findSqlStatementBoundaries,
  resolveSqlStatementBoundary,
  type SqlStatementBoundary,
} from '../models/sqlStatement.js';

interface SqlStatementHighlightState {
  statements: readonly SqlStatementBoundary[];
  active?: SqlStatementBoundary;
  decorations: DecorationSet;
}

const currentStatementMark = Decoration.mark({
  class: 'cm-sql-current-statement',
});

function createHighlightState(
  state: EditorState,
  statements: readonly SqlStatementBoundary[],
): SqlStatementHighlightState {
  const selection = state.selection.main;
  const resolution = resolveSqlStatementBoundary(
    state.doc.length,
    statements,
    selection.from,
    selection.to,
    (from, to) => state.sliceDoc(from, to),
  );
  const active = resolution.ok
    ? { from: resolution.statement.from, to: resolution.statement.to }
    : undefined;
  return {
    statements,
    ...(active ? { active } : {}),
    decorations: active
      ? Decoration.set([currentStatementMark.range(active.from, active.to)])
      : Decoration.none,
  };
}

export const sqlCurrentStatementHighlight = StateField.define<SqlStatementHighlightState>({
  create(state) {
    return createHighlightState(state, findSqlStatementBoundaries(state.doc.toString()));
  },
  update(value, transaction) {
    if (!transaction.docChanged && !transaction.selection) return value;
    const statements = transaction.docChanged
      ? findSqlStatementBoundaries(transaction.newDoc.toString())
      : value.statements;
    return createHighlightState(transaction.state, statements);
  },
  provide(field) {
    return EditorView.decorations.from(field, (value) => value.decorations);
  },
});

