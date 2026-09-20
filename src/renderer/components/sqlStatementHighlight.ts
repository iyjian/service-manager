import { RangeSetBuilder, StateField, type EditorState } from '@codemirror/state';
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

const currentStatementLine = Decoration.line({
  class: 'cm-sql-current-statement',
});

function highlightStatementLines(state: EditorState, active: SqlStatementBoundary): DecorationSet {
  const firstLine = state.doc.lineAt(active.from).number;
  const lastLine = state.doc.lineAt(active.to - 1).number;
  const decorations = new RangeSetBuilder<Decoration>();
  for (let number = firstLine; number <= lastLine; number += 1) {
    const from = state.doc.line(number).from;
    decorations.add(from, from, currentStatementLine);
  }
  return decorations.finish();
}

function createHighlightState(
  state: EditorState,
  statements: readonly SqlStatementBoundary[],
  previous?: SqlStatementHighlightState,
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
  if (previous && previous.active?.from === active?.from && previous.active?.to === active?.to) {
    return previous;
  }
  return {
    statements,
    ...(active ? { active } : {}),
    decorations: active
      ? highlightStatementLines(state, active)
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
    return createHighlightState(transaction.state, statements, transaction.docChanged ? undefined : value);
  },
  provide(field) {
    return EditorView.decorations.from(field, (value) => value.decorations);
  },
});
