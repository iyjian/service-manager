export interface AntlrCaretPosition {
  readonly lineNumber: number;
  readonly column: number;
}

export interface AntlrToken {
  readonly text?: string | null;
  readonly type: number;
  readonly channel: number;
  readonly start: number;
  readonly stop: number;
  readonly line: number;
  readonly column: number;
  readonly tokenIndex: number;
}

export interface AntlrEntityPosition {
  readonly startIndex: number;
  readonly endIndex: number;
  readonly line: number;
  readonly startColumn: number;
  readonly endColumn: number;
  readonly startTokenIndex?: number;
  readonly endTokenIndex?: number;
}

export interface AntlrSyntaxError {
  readonly startLine: number;
  readonly endLine: number;
  readonly startColumn: number;
  readonly endColumn: number;
  readonly message: string;
}

export interface AntlrEntityContext {
  readonly entityContextType: string;
  readonly text: string;
  readonly position: AntlrEntityPosition;
  readonly declareType?: number;
  readonly _alias?: {
    readonly text: string;
    readonly startIndex: number;
    readonly endIndex: number;
    readonly startColumn: number;
    readonly endColumn: number;
    readonly line?: number;
  } | null;
}

export class MySQL {
  parse(input: string, errorListener?: unknown): unknown;
  validate(input: string): AntlrSyntaxError[];
  getAllTokens(input: string): AntlrToken[];
  getAllEntities(input: string, caretPosition?: AntlrCaretPosition): AntlrEntityContext[] | null;
  getSuggestionAtCaretPosition(input: string, caretPosition: AntlrCaretPosition): {
    readonly syntax: readonly unknown[];
    readonly keywords: readonly string[];
  } | null;
}
