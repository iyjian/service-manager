import type {
  SqlAuthState,
  SqlDatabaseSchema,
  SqlEnvironment,
  SqlJsonValue,
  SqlQueryDraft,
  SqlQueryRecord,
  SqlSchemaColumn,
  SqlSchemaEnumMetadata,
  SqlSchemaTable,
} from '../shared/types';
import { acceptCompletion } from '@codemirror/autocomplete';
import { basicSetup, EditorView } from 'codemirror';
import { json } from '@codemirror/lang-json';
import { indentUnit } from '@codemirror/language';
import { MySQL, schemaCompletionSource, sql } from '@codemirror/lang-sql';
import { EditorState, Prec, StateEffect, StateField } from '@codemirror/state';
import {
  activateHover,
  closeHoverTooltip,
  Decoration,
  hoverTooltip,
  keymap,
  type DecorationSet,
  type Tooltip,
} from '@codemirror/view';
import { common, createLowlight } from 'lowlight';
import { CODE_HIGHLIGHT_LIMITS, findCodeHighlightLanguage } from './codeHighlight.js';
import { registerPage } from './nav.js';
import {
  findNotesTextMatches,
  initialNotesFindIndex,
  moveNotesFindIndex,
  type NotesFindMatch,
} from './notesFind.js';
import {
  buildSqlCompletionNamespace,
  defaultTableColumnCompletions,
  resolveSqlDefaultTable,
  resolveSqlSelectTables,
  resolveSqlTableReferenceAt,
  sqlEnumCommentParts,
  SQL_COMPLETION_CONTEXT_CHARACTERS,
  type SqlTableReference,
} from './sqlCompletion.js';
import {
  buildUpdateStatement,
  highlightUpdateSql,
  type SqlUpdatePrimaryKey,
} from './sqlCellEdit.js';
import {
  extractSqlTemplateParamNames,
  replaceSqlTemplateParams,
  resolveSqlStatement,
} from './sqlStatement.js';
import { sqlCurrentStatementHighlight } from './sqlStatementHighlight.js';
import {
  formatSqlDuration,
  formatSqlCell,
  normalizeSqlResult,
  sqlCellPresentation,
  sqlResultRowCountInfo,
  type SqlCellPresentation,
  type SqlDisplayResult,
} from './sqlResult.js';
import {
  emptySqlUntitledDraftState,
  normalizeSqlEditorSource,
  parseSqlUntitledDraftState,
  serializeSqlUntitledDraftState,
  SQL_UNTITLED_DRAFTS_STORAGE_KEY,
  type SqlUntitledDraftState,
} from './sqlUntitledDrafts.js';
import { SqlVirtualResultTable } from './sqlVirtualResultTable.js';

export { normalizeSqlEditorSource } from './sqlUntitledDrafts.js';

const SQL_NAV_ICON = `
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <ellipse cx="8" cy="3.5" rx="5" ry="2"></ellipse>
    <path d="M3 3.5v4c0 1.1 2.24 2 5 2s5-.9 5-2v-4"></path>
    <path d="M3 7.5v4c0 1.1 2.24 2 5 2s5-.9 5-2v-4"></path>
  </svg>
`;

const ACTIVE_ENVIRONMENT_KEY = 'sql:active-environment';
const SIDEBAR_WIDTH_KEY = 'sql:sidebar-width';
const EDITOR_HEIGHT_KEY = 'sql:editor-height';
const EDITOR_FONT_SIZE_KEY = 'sql:editor-font-size';
const EDITOR_FONT_FAMILY_KEY = 'sql:editor-font-family';
const DEFAULT_SIDEBAR_WIDTH = 300;
const MIN_SIDEBAR_WIDTH = 240;
const MAX_SIDEBAR_WIDTH = 520;
const DEFAULT_EDITOR_HEIGHT = 320;
const MIN_EDITOR_HEIGHT = 180;
const MIN_RESULTS_HEIGHT = 120;
const DEFAULT_EDITOR_FONT_SIZE = 21;
const MIN_EDITOR_FONT_SIZE = 12;
const MAX_EDITOR_FONT_SIZE = 24;
const SQL_DEFAULT_SELECT_LIMIT = 100;
const SQL_MIN_SELECT_LIMIT = 1;
const SQL_MAX_SELECT_LIMIT = 10_000;
const SQL_VALUE_PREVIEW_CHARACTERS = 1_000_000;
const SQL_ENUM_TOOLTIP_MAX_ROWS = 100;
const SQL_ENUM_TOOLTIP_CLOSE_DELAY_MS = 180;
const SQL_UNTITLED_DRAFT_PERSIST_DELAY_MS = 250;
const SQL_INDENT = '  ';
const SQL_VALUE_DETECT_LANGUAGES: ReadonlySet<string> = new Set(['markdown']);
const SQL_VALUE_DETECT_MIN_RELEVANCE = 5;
const SQL_VALUE_MARKDOWN_PATTERNS: readonly RegExp[] = Object.freeze([
  /^#{1,6}\s+\S/m,
  /^\s*>\s?/m,
  /^\s*[-*+]\s+\S/m,
  /^\s*(?:\d{1,3})[.)]\s+\S/m,
  /^```/m,
  /^~~~/m,
  /!\[[^\]]*\]\([^)\s]+\)/,
  /\[[^\]\n]*[A-Za-z\u4e00-\u9fa5][^\]\n]*\]\([^)\s]+\)/,
  /^\s*\|.*\|/m,
  /\*\*[^*\n]+\*\*/,
  /^\s*([-*_])\s*\1\s*\1\s*$/m,
  /^[^\n]+\n\s*(?:={3,}|-{3,})\s*$/m,
]);
const sqlValueLowlight = createLowlight(common);

const SQL_VALUE_FIND_DECORATION = StateEffect.define<DecorationSet>();
const sqlValueFindDecorationField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, transaction) {
    let next = decorations.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (effect.is(SQL_VALUE_FIND_DECORATION)) next = effect.value;
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

interface SqlQueryTab {
  key: string;
  recordId?: number;
  title: string;
  source: string;
  savedSource: string;
  params: Record<string, string>;
  lastResponseText: string;
  executedStatement?: string;
  executedAt?: string;
  durationMs?: number;
  result?: SqlDisplayResult;
  resultError?: string;
  executing: boolean;
  saving: boolean;
  executionVersion: number;
}

interface SqlEnvironmentState {
  auth?: SqlAuthState;
  schema?: SqlDatabaseSchema;
  schemaCompletion?: ReturnType<typeof schemaCompletionSource>;
  records: SqlQueryRecord[];
  tabs: SqlQueryTab[];
  activeTabKey?: string;
  listLoading: boolean;
  schemaLoading: boolean;
  loadVersion: number;
  recordLoadVersion: number;
}

interface SqlTableEnumHoverTarget extends SqlTableReference {
  environment: SqlEnvironment;
  tabKey?: string;
}

interface SqlSchemaFlight {
  loadVersion: number;
  promise: Promise<void>;
}

type SqlEnumColumn = SqlSchemaColumn & { enum: SqlSchemaEnumMetadata };

type SqlShortcutEvent = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>;
export type SqlEditorFontFamily = 'default' | 'comic-mono';
export type SqlValueModeId = 'formatted' | 'preview' | 'highlighted' | 'raw';

interface SqlValueMode {
  id: SqlValueModeId;
  label: string;
}

const SQL_JSON_VALUE_MODES: readonly SqlValueMode[] = Object.freeze([
  { id: 'formatted', label: 'Formatted' },
  { id: 'raw', label: 'Raw' },
]);
const SQL_HTML_VALUE_MODES: readonly SqlValueMode[] = Object.freeze([
  { id: 'preview', label: 'Preview' },
  { id: 'raw', label: 'Raw' },
]);
const SQL_TEXT_VALUE_MODES: readonly SqlValueMode[] = Object.freeze([
  { id: 'raw', label: 'Raw' },
]);

let tabSequence = 0;
let queryNameDialogSequence = 0;

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing required element: ${selector}`);
  return element;
}

function newEnvironmentState(): SqlEnvironmentState {
  return {
    records: [],
    tabs: [],
    listLoading: false,
    schemaLoading: false,
    loadVersion: 0,
    recordLoadVersion: 0,
  };
}

function newQueryTab(environment: SqlEnvironment): SqlQueryTab {
  tabSequence += 1;
  return {
    key: `${environment}-${tabSequence}`,
    title: 'Untitled',
    source: '',
    savedSource: '',
    params: {},
    lastResponseText: '',
    executing: false,
    saving: false,
    executionVersion: 0,
  };
}

function environmentLabel(environment: SqlEnvironment): string {
  return environment === 'production' ? 'Production' : 'Development';
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim().replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
  }
  return 'The SQL operation failed.';
}

function toast(text: string, level: 'default' | 'success' | 'error' = 'default'): void {
  window.dispatchEvent(new CustomEvent('service-manager:toast', { detail: { text, level } }));
}

function readStoredNumber(key: string, fallback: number): number {
  try {
    const value = Number(localStorage.getItem(key));
    return Number.isFinite(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function writeStoredValue(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Device-local SQL UI preference persistence is optional.
  }
}

function readStoredValue(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function clampSqlSidebarWidth(value: number): number {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(value)));
}

export function clampSqlEditorFontSize(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_EDITOR_FONT_SIZE;
  return Math.min(MAX_EDITOR_FONT_SIZE, Math.max(MIN_EDITOR_FONT_SIZE, Math.round(value)));
}

export function normalizeSqlEditorFontFamily(value: unknown): SqlEditorFontFamily {
  return value === 'comic-mono' ? value : 'default';
}

export function normalizeSqlSelectLimit(value: unknown): number {
  if (typeof value === 'string' && value.trim() === '') return SQL_DEFAULT_SELECT_LIMIT;
  const numeric = typeof value === 'string' ? Number(value.trim()) : Number(value);
  if (!Number.isFinite(numeric)) return SQL_DEFAULT_SELECT_LIMIT;
  return Math.min(SQL_MAX_SELECT_LIMIT, Math.max(SQL_MIN_SELECT_LIMIT, Math.trunc(numeric)));
}

function selectedSqlLineStarts(state: EditorState): number[] {
  const starts = new Set<number>();
  for (const range of state.selection.ranges) {
    const firstLine = state.doc.lineAt(range.from).number;
    let lastLine = state.doc.lineAt(range.to).number;
    if (!range.empty && range.to === state.doc.line(lastLine).from) lastLine -= 1;
    for (let lineNumber = firstLine; lineNumber <= lastLine; lineNumber += 1) {
      starts.add(state.doc.line(lineNumber).from);
    }
  }
  return [...starts].sort((left, right) => left - right);
}

function insertSqlIndent(view: EditorView): boolean {
  const { state } = view;
  if (state.selection.ranges.every((range) => range.empty)) {
    view.dispatch(state.update(
      state.replaceSelection(SQL_INDENT),
      { scrollIntoView: true, userEvent: 'input' },
    ));
    return true;
  }
  view.dispatch({
    changes: selectedSqlLineStarts(state).map((from) => ({ from, insert: SQL_INDENT })),
    scrollIntoView: true,
    userEvent: 'input.indent',
  });
  return true;
}

function removeSqlIndent(view: EditorView): boolean {
  const { state } = view;
  const changes = selectedSqlLineStarts(state).flatMap((from) => {
    const line = state.doc.lineAt(from);
    if (line.text.startsWith(SQL_INDENT)) return [{ from, to: from + SQL_INDENT.length }];
    if (line.text.startsWith(' ') || line.text.startsWith('\t')) return [{ from, to: from + 1 }];
    return [];
  });
  if (changes.length > 0) {
    view.dispatch({ changes, scrollIntoView: true, userEvent: 'delete.dedent' });
  }
  return true;
}

function insertSqlNewline(view: EditorView): boolean {
  view.dispatch(view.state.update(
    view.state.replaceSelection(view.state.lineBreak),
    { scrollIntoView: true, userEvent: 'input' },
  ));
  return true;
}

function acceptSqlCompletionOrInsertNewline(view: EditorView): boolean {
  return acceptCompletion(view) || insertSqlNewline(view);
}

export function sqlValueModesForKind(
  kind: SqlCellPresentation['kind'],
  detectedLanguage?: string,
): readonly SqlValueMode[] {
  if (kind === 'json') return SQL_JSON_VALUE_MODES;
  if (kind === 'html') return SQL_HTML_VALUE_MODES;
  const detected = findCodeHighlightLanguage(detectedLanguage);
  return detected && detected.value !== 'plaintext'
    ? Object.freeze([
      { id: 'highlighted', label: detected.label },
      { id: 'raw', label: 'Raw' },
    ])
    : SQL_TEXT_VALUE_MODES;
}

export function sqlShortcutLabel(platform: string): string {
  return /mac/i.test(platform) ? '⌘Enter' : 'Ctrl+Enter';
}

export function sqlSaveShortcutLabel(platform: string): string {
  return /mac/i.test(platform) ? '⌘S' : 'Ctrl+S';
}

export function isSqlRunShortcut(event: SqlShortcutEvent, isMac: boolean): boolean {
  if (event.altKey || event.shiftKey) return false;
  if (isMac) {
    return event.key === 'Enter' && event.metaKey && !event.ctrlKey;
  }
  return event.key === 'Enter' && event.ctrlKey && !event.metaKey;
}

export function isSqlSaveShortcut(event: SqlShortcutEvent, isMac: boolean): boolean {
  if (event.key.toLocaleLowerCase() !== 's' || event.altKey || event.shiftKey) return false;
  return isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

function parseConfigParams(config: SqlQueryRecord['config']): Record<string, string> {
  if (!config || Array.isArray(config) || typeof config !== 'object') return {};
  const value = config as Record<string, SqlJsonValue>;
  const params = value.params;
  if (!params || Array.isArray(params) || typeof params !== 'object') return {};
  const result: Record<string, string> = {};
  for (const [name, item] of Object.entries(params)) {
    if (typeof item === 'string') result[name] = item;
  }
  return result;
}

function configForSource(source: string, params: Readonly<Record<string, string>>): SqlJsonValue {
  return {
    params: Object.fromEntries(
      extractSqlTemplateParamNames(source).map((name) => [name, params[name] ?? '']),
    ),
  };
}

function lastRunLabel(value?: string | null): string {
  if (!value) return 'Never run';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Never run';
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? '';
  } catch {
    return String(value);
  }
}

interface SqlHighlightNode {
  type?: unknown;
  value?: unknown;
  tagName?: unknown;
  properties?: unknown;
  children?: unknown;
}

function appendSqlHighlightNode(parent: Node, value: unknown): void {
  if (!value || typeof value !== 'object') return;
  const node = value as SqlHighlightNode;
  if (node.type === 'text' && typeof node.value === 'string') {
    parent.appendChild(document.createTextNode(node.value));
    return;
  }
  if (node.type !== 'element' || node.tagName !== 'span' || !Array.isArray(node.children)) return;
  const span = document.createElement('span');
  if (node.properties && typeof node.properties === 'object') {
    const classNames = (node.properties as { className?: unknown }).className;
    if (Array.isArray(classNames)) {
      for (const className of classNames) {
        if (typeof className === 'string' && /^hljs-[a-z0-9_-]+$/.test(className)) span.classList.add(className);
      }
    }
  }
  for (const child of node.children) appendSqlHighlightNode(span, child);
  parent.appendChild(span);
}

function boundedSqlValue(value: string): { text: string; truncated: boolean } {
  if (value.length <= SQL_VALUE_PREVIEW_CHARACTERS) return { text: value, truncated: false };
  return {
    text: value.slice(0, SQL_VALUE_PREVIEW_CHARACTERS),
    truncated: true,
  };
}

function isMarkdownStructure(value: string): boolean {
  return SQL_VALUE_MARKDOWN_PATTERNS.some((pattern) => pattern.test(value));
}

export function detectSqlValueLanguage(value: string): string | undefined {
  const bounded = boundedSqlValue(value);
  if (bounded.text.length > CODE_HIGHLIGHT_LIMITS.automaticCharacters) return undefined;
  if (isMarkdownStructure(bounded.text)) return 'markdown';
  try {
    const root = sqlValueLowlight.highlightAuto(bounded.text);
    const candidate = typeof root.data?.language === 'string'
      ? findCodeHighlightLanguage(root.data.language)?.value
      : undefined;
    if (!candidate || !SQL_VALUE_DETECT_LANGUAGES.has(candidate)) return undefined;
    const relevance = typeof root.data?.relevance === 'number' ? root.data.relevance : 0;
    if (relevance < SQL_VALUE_DETECT_MIN_RELEVANCE) return undefined;
    return candidate;
  } catch {
    return undefined;
  }
}

function sqlValueLineNumbers(lineCount: number): string {
  const numbers = new Array<string>(lineCount);
  for (let index = 0; index < lineCount; index += 1) numbers[index] = String(index + 1);
  return numbers.join('\n');
}

function highlightedSqlValue(
  value: string,
  language?: string,
  detectAutomatically = language === undefined,
): { node: HTMLElement; language?: string } {
  const pre = document.createElement('pre');
  pre.className = 'sql-value-code';
  pre.tabIndex = 0;
  const lineNumbers = document.createElement('div');
  lineNumbers.className = 'sql-value-line-numbers';
  lineNumbers.setAttribute('aria-hidden', 'true');
  const code = document.createElement('code');
  code.className = 'hljs';
  pre.append(lineNumbers, code);
  const bounded = boundedSqlValue(value);
  lineNumbers.textContent = sqlValueLineNumbers(bounded.text.split('\n').length);
  let detectedLanguage: string | undefined = language;
  try {
    let root: ReturnType<typeof sqlValueLowlight.highlight> | undefined;
    if (language) {
      root = bounded.text.length <= CODE_HIGHLIGHT_LIMITS.explicitCharacters
        ? sqlValueLowlight.highlight(language, bounded.text)
        : undefined;
    } else if (detectAutomatically && bounded.text.length <= CODE_HIGHLIGHT_LIMITS.automaticCharacters) {
      const detected = detectSqlValueLanguage(bounded.text);
      if (detected) root = sqlValueLowlight.highlight(detected, bounded.text);
    }
    if (root) {
      detectedLanguage = typeof root.data?.language === 'string' ? root.data.language : detectedLanguage;
      for (const child of root.children) appendSqlHighlightNode(code, child);
    } else {
      code.textContent = bounded.text;
    }
  } catch {
    code.textContent = bounded.text;
  }
  if (bounded.truncated) {
    const notice = document.createElement('div');
    notice.className = 'sql-value-truncated';
    notice.textContent = `Preview limited to ${SQL_VALUE_PREVIEW_CHARACTERS.toLocaleString()} characters.`;
    const wrapper = document.createElement('div');
    wrapper.className = 'sql-value-code-wrap';
    wrapper.append(notice, pre);
    return { node: wrapper, language: detectedLanguage };
  }
  return { node: pre, language: detectedLanguage };
}

function sqlHighlightLabel(language: string | undefined): string {
  if (!language) return 'Text';
  return findCodeHighlightLanguage(language)?.label ?? language.toLocaleUpperCase();
}

function sanitizeSqlHtmlPreview(value: string): string {
  const parsed = new DOMParser().parseFromString(value, 'text/html');
  for (const blocked of Array.from(parsed.body.querySelectorAll(
    'script,noscript,style,meta,base,link,iframe,frame,frameset,object,embed,applet,form,input,button,select,textarea,video,audio,source,track,portal,svg,math',
  ))) blocked.remove();
  const urlAttributes = new Set([
    'action',
    'background',
    'cite',
    'data',
    'formaction',
    'href',
    'poster',
    'src',
    'srcset',
    'xlink:href',
  ]);
  for (const element of Array.from(parsed.body.querySelectorAll('*'))) {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLocaleLowerCase();
      if (name.startsWith('on') || urlAttributes.has(name)) {
        if (element.tagName === 'IMG'
          && name === 'src'
          && /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/]+=*$/i.test(attribute.value)) continue;
        element.removeAttribute(attribute.name);
        continue;
      }
      if (name === 'style' && /(?:url\s*\(|@import|expression\s*\()/i.test(attribute.value)) {
        element.removeAttribute(attribute.name);
      }
    }
  }
  return parsed.body.innerHTML;
}

function sandboxedHtmlDocument(value: string): string {
  const bounded = boundedSqlValue(value);
  const sanitized = sanitizeSqlHtmlPreview(bounded.text);
  const truncation = bounded.truncated
    ? `<p class="sql-preview-limit">Preview limited to ${SQL_VALUE_PREVIEW_CHARACTERS.toLocaleString()} characters.</p>`
    : '';
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:; form-action 'none'; base-uri 'none'"><style>html{color-scheme:light}body{box-sizing:border-box;margin:0;padding:16px;color:#27272a;background:#fff;font:14px/1.55 system-ui,sans-serif;overflow:auto}img,table,pre{max-width:100%}table{border-collapse:collapse}td,th{border:1px solid #d4d4d8;padding:4px 6px}pre{overflow:auto;white-space:pre-wrap}.sql-preview-limit{padding:8px;border:1px solid #fde68a;background:#fffbeb;color:#92400e}</style></head><body>${truncation}${sanitized}</body></html>`;
}

function tabFromRecord(environment: SqlEnvironment, record: SqlQueryRecord): SqlQueryTab {
  const tab = newQueryTab(environment);
  const normalizedSource = normalizeSqlEditorSource(record.sql);
  tab.recordId = record.id;
  tab.title = record.name;
  tab.source = normalizedSource;
  tab.savedSource = record.sql;
  tab.params = parseConfigParams(record.config);
  tab.lastResponseText = record.lastQueryResult ?? '';
  tab.executedAt = record.lastQueryDate ?? undefined;
  if (tab.lastResponseText) {
    try {
      tab.result = normalizeSqlResult(JSON.parse(tab.lastResponseText) as unknown);
    } catch {
      tab.resultError = 'The saved result could not be read.';
    }
  }
  return tab;
}

class SqlPage {
  private readonly page = requireElement<HTMLElement>('#sql-page');
  private readonly loadingView = requireElement<HTMLElement>('#sql-loading');
  private readonly signedOutView = requireElement<HTMLElement>('#sql-signed-out');
  private readonly workspace = requireElement<HTMLElement>('#sql-workspace');
  private readonly productionTab = requireElement<HTMLButtonElement>('#sql-production-tab');
  private readonly developmentTab = requireElement<HTMLButtonElement>('#sql-development-tab');
  private readonly fontControls = requireElement<HTMLElement>('#sql-editor-font-controls');
  private readonly decreaseFontSizeButton = requireElement<HTMLButtonElement>('#sql-font-size-decrease');
  private readonly increaseFontSizeButton = requireElement<HTMLButtonElement>('#sql-font-size-increase');
  private readonly fontFamilySwitch = requireElement<HTMLButtonElement>('#sql-font-family-switch');
  private readonly sessionActions = requireElement<HTMLElement>('#sql-session-actions');
  private readonly selectLimitInput = requireElement<HTMLInputElement>('#sql-select-limit');
  private readonly saveActionButton = requireElement<HTMLButtonElement>('#sql-save-action');
  private readonly runActionButton = requireElement<HTMLButtonElement>('#sql-run-action');
  private readonly sessionUser = requireElement<HTMLElement>('#sql-session-user');
  private readonly signOutButton = requireElement<HTMLButtonElement>('#sql-sign-out');
  private readonly loginForm = requireElement<HTMLFormElement>('#sql-login-form');
  private readonly loginEnvironment = requireElement<HTMLElement>('#sql-login-environment');
  private readonly loginUsername = requireElement<HTMLInputElement>('#sql-login-username');
  private readonly loginPassword = requireElement<HTMLInputElement>('#sql-login-password');
  private readonly loginSubmit = requireElement<HTMLButtonElement>('#sql-login-submit');
  private readonly loginError = requireElement<HTMLElement>('#sql-login-error');
  private readonly refreshButton = requireElement<HTMLButtonElement>('#sql-refresh-queries');
  private readonly newButton = requireElement<HTMLButtonElement>('#sql-new-query');
  private readonly collapseButton = requireElement<HTMLButtonElement>('#sql-sidebar-collapse');
  private readonly searchInput = requireElement<HTMLInputElement>('#sql-query-search');
  private readonly queryList = requireElement<HTMLElement>('#sql-query-list');
  private readonly queryTabs = requireElement<HTMLElement>('#sql-query-tabs');
  private readonly saveShortcut = requireElement<HTMLElement>('#sql-save-shortcut');
  private readonly runShortcut = requireElement<HTMLElement>('#sql-run-shortcut');
  private readonly editorHost = requireElement<HTMLElement>('#sql-editor');
  private readonly resultContent = requireElement<HTMLElement>('#sql-result-content');
  private readonly resultMeta = requireElement<HTMLElement>('#sql-result-meta');
  private readonly valueDialog = requireElement<HTMLDialogElement>('#sql-value-dialog');
  private readonly valueDialogTitle = requireElement<HTMLElement>('#sql-value-dialog-title');
  private readonly valueCopyRaw = requireElement<HTMLButtonElement>('#sql-value-copy-raw');
  private readonly valueKind = requireElement<HTMLElement>('#sql-value-kind');
  private readonly valueModes = requireElement<HTMLElement>('#sql-value-modes');
  private readonly valueContent = requireElement<HTMLElement>('#sql-value-content');
  private readonly valueClose = requireElement<HTMLButtonElement>('#sql-value-close');
  private readonly valueFindBar = requireElement<HTMLElement>('#sql-value-find-bar');
  private readonly valueFindInput = requireElement<HTMLInputElement>('#sql-value-find-input');
  private readonly valueFindCounter = requireElement<HTMLElement>('#sql-value-find-counter');
  private readonly valueFindPrevious = requireElement<HTMLButtonElement>('#sql-value-find-previous');
  private readonly valueFindNext = requireElement<HTMLButtonElement>('#sql-value-find-next');
  private readonly valueFindClose = requireElement<HTMLButtonElement>('#sql-value-find-close');
  private readonly valueEdit = requireElement<HTMLElement>('#sql-value-edit');
  private readonly valueEditInput = requireElement<HTMLTextAreaElement>('#sql-value-edit-input');
  private readonly valueSqlPanel = requireElement<HTMLElement>('#sql-value-sql-panel');
  private readonly valueSqlResizer = requireElement<HTMLElement>('#sql-value-sql-resizer');
  private readonly valueSqlBody = requireElement<HTMLElement>('#sql-value-sql-body');
  private readonly valueSqlCopy = requireElement<HTMLButtonElement>('#sql-value-sql-copy');
  private readonly valueSqlCode = requireElement<HTMLElement>('#sql-value-sql-code');
  private readonly valueSqlExecute = requireElement<HTMLButtonElement>('#sql-value-sql-execute');
  private readonly valueSqlStatus = requireElement<HTMLElement>('#sql-value-sql-status');
  private readonly valueSqlNotice = requireElement<HTMLElement>('#sql-value-sql-notice');
  private readonly sidebarResizer = requireElement<HTMLElement>('#sql-sidebar-resizer');
  private readonly resultResizer = requireElement<HTMLElement>('#sql-result-resizer');
  private readonly queryWorkspace = requireElement<HTMLElement>('#sql-query-workspace');
  private readonly isMac = /mac/i.test(navigator.platform);
  private readonly states: Record<SqlEnvironment, SqlEnvironmentState> = {
    production: newEnvironmentState(),
    development: newEnvironmentState(),
  };
  private readonly contextualSchemaCompletion: ReturnType<typeof schemaCompletionSource> = async (context) => {
    const state = this.currentState();
    if (!state.schema || !state.schemaCompletion) return null;
    const base = await state.schemaCompletion(context);
    if (!base) return null;
    const sourceBeforeCursor = context.state.sliceDoc(
      Math.max(0, context.pos - SQL_COMPLETION_CONTEXT_CHARACTERS),
      context.pos,
    );
    const defaultTable = resolveSqlDefaultTable(sourceBeforeCursor, state.schema);
    const columns = defaultTableColumnCompletions(state.schema, defaultTable);
    if (columns.length === 0) return base;
    const existing = new Set(base.options.map((option) => option.label.toLocaleLowerCase()));
    return {
      ...base,
      options: [
        ...columns.filter((option) => !existing.has(option.label.toLocaleLowerCase())),
        ...base.options,
      ],
    };
  };
  private readonly tableEnumHover: ReturnType<typeof hoverTooltip>;
  private readonly editor: EditorView;
  private valueEditor?: EditorView;
  private environment: SqlEnvironment = 'production';
  private replacingDocument = false;
  private active = false;
  private sidebarPointerId?: number;
  private resultPointerId?: number;
  private resultTable?: SqlVirtualResultTable;
  private valueDialogGeneration = 0;
  private valueRaw = '';
  private valueFormatted?: string;
  private valuePresentation?: SqlCellPresentation;
  private valueMode: SqlValueModeId = 'raw';
  private valueDetectedLanguage?: string;
  private valueFindOpen = false;
  private valueFindMatches: readonly NotesFindMatch[] = [];
  private valueFindActiveIndex = -1;
  private valueFindTruncated = false;
  private valueFindFrame?: number;
  private valueFindEscapeGuard = false;
  private valueCopyResetTimer?: number;
  private sidebarCollapsed = false;
  private valueEditContext?: {
    table: string;
    column: string;
    originalValue: unknown;
    primaryKey: SqlUpdatePrimaryKey[];
  };
  private valueSqlCopyResetTimer?: number;
  private valueSqlPointerId?: number;
  private valueSqlExecuting = false;
  private valueSqlExecuted = false;
  private valueSqlOriginalText = '';
  private untitledDraftPersistTimer?: number;
  private untitledDraftPersistWarningShown = false;
  private tableEnumHoverTarget?: SqlTableEnumHoverTarget;
  private tableEnumHoverCloseTimer?: number;
  private tableEnumPendingPosition?: {
    view: EditorView;
    source: string;
    position: number;
    environment: SqlEnvironment;
    tabKey?: string;
  };
  private schemaFlights = new Map<SqlEnvironment, SqlSchemaFlight>();

  public constructor() {
    try {
      const stored = localStorage.getItem(ACTIVE_ENVIRONMENT_KEY);
      if (stored === 'development') this.environment = 'development';
    } catch {
      // Default to Production if local storage is unavailable.
    }
    this.restoreUntitledDrafts();
    this.tableEnumHover = hoverTooltip(
      (view, position) => this.tableEnumTooltipAt(view, position),
      // Native double-click selection can be committed after the dblclick handler.
      // Keep the explicitly opened tooltip through that selection transaction;
      // document edits and the owned pointer/Escape handlers still close it.
      { hideOnChange: false },
    );
    this.editor = new EditorView({
      state: EditorState.create({
        doc: '',
        extensions: [
          // CodeMirror's completion Enter binding also uses the highest precedence.
          // Register SQL editing keys first: Enter accepts the selected completion
          // (including the default-selected first item) when the popup is open,
          // and otherwise inserts a plain newline.
          Prec.highest(keymap.of([
            { key: 'Enter', run: acceptSqlCompletionOrInsertNewline, shift: insertSqlNewline },
            { key: 'Tab', run: insertSqlIndent },
            { key: 'Shift-Tab', run: removeSqlIndent },
          ])),
          basicSetup,
          sql({ dialect: MySQL, upperCaseKeywords: true }),
          EditorState.tabSize.of(SQL_INDENT.length),
          indentUnit.of(SQL_INDENT),
          EditorView.clipboardInputFilter.of((text) => normalizeSqlEditorSource(text)),
          MySQL.language.data.of({ autocomplete: this.contextualSchemaCompletion }),
          sqlCurrentStatementHighlight,
          this.tableEnumHover,
          EditorView.domEventHandlers({
            dblclick: (event, view) => {
              this.handleTableEnumDoubleClick(event, view);
              return false;
            },
            pointermove: (event, view) => {
              this.handleTableEnumPointerMove(event, view);
              return false;
            },
            pointerleave: () => {
              this.scheduleTableEnumHoverClose();
              return false;
            },
          }),
          // Escape is bound to simplifySelection in CodeMirror's default keymap, so a
          // domEventHandlers keydown would be consumed before it can close the tooltip.
          // An observer runs unconditionally and, without consuming the key, closes the
          // tooltip while simplifySelection still clears the double-click selection.
          EditorView.domEventObservers({
            keydown: (event) => {
              if (event.key !== 'Escape' || !this.tableEnumHoverTarget) return;
              this.closeTableEnumHover();
            },
          }),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({
            'aria-label': 'SQL source',
            'aria-multiline': 'true',
            autocapitalize: 'off',
            autocomplete: 'off',
            autocorrect: 'off',
            spellcheck: 'false',
            translate: 'no',
          }),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged || this.replacingDocument) return;
            const tab = this.currentTab();
            if (!tab) return;
            const wasDirty = this.isTabDirty(tab);
            tab.source = normalizeSqlEditorSource(update.state.doc.toString());
            if (tab.recordId === undefined) this.scheduleUntitledDraftPersistence();
            if (wasDirty !== this.isTabDirty(tab)) this.renderTabs();
          }),
        ],
      }),
      parent: this.editorHost,
    });
    const saveShortcut = sqlSaveShortcutLabel(navigator.platform);
    const runShortcut = sqlShortcutLabel(navigator.platform);
    this.saveShortcut.textContent = saveShortcut;
    this.runShortcut.textContent = runShortcut;
    this.saveActionButton.title = `Save query (${saveShortcut})`;
    this.runActionButton.title = `Run query (${runShortcut})`;
    this.saveActionButton.setAttribute('aria-keyshortcuts', this.isMac ? 'Meta+S' : 'Control+S');
    this.runActionButton.setAttribute('aria-keyshortcuts', this.isMac ? 'Meta+Enter' : 'Control+Enter');
    this.applySidebarWidth(clampSqlSidebarWidth(readStoredNumber(SIDEBAR_WIDTH_KEY, DEFAULT_SIDEBAR_WIDTH)));
    this.applyEditorHeight(readStoredNumber(EDITOR_HEIGHT_KEY, DEFAULT_EDITOR_HEIGHT));
    this.applyEditorFontSize(readStoredNumber(EDITOR_FONT_SIZE_KEY, DEFAULT_EDITOR_FONT_SIZE));
    this.applyEditorFontFamily(normalizeSqlEditorFontFamily(readStoredValue(EDITOR_FONT_FAMILY_KEY)));
    this.bindEvents();
    this.renderEnvironmentChrome();
  }

  public show(): void {
    this.active = true;
    void this.loadEnvironment();
    window.requestAnimationFrame(() => this.editor.requestMeasure());
  }

  public hide(): void {
    this.active = false;
    this.tableEnumPendingPosition = undefined;
    this.closeTableEnumHover();
    this.destroyResultTable();
    this.resultContent.replaceChildren();
    this.closeValueDialog();
  }

  private bindEvents(): void {
    // Close the enum tooltip on any click outside its own DOM so a plain click
    // away (not just a pointer move) dismisses it, matching pointer-exit/Escape.
    document.addEventListener('pointerdown', (event) => {
      if (!this.active || !this.tableEnumHoverTarget) return;
      if (event.target instanceof Element && event.target.closest('.sql-table-enum-tooltip')) return;
      this.closeTableEnumHover();
    });
    this.productionTab.addEventListener('click', () => void this.switchEnvironment('production'));
    this.developmentTab.addEventListener('click', () => void this.switchEnvironment('development'));
    this.decreaseFontSizeButton.addEventListener('click', () => this.adjustEditorFontSize(-1));
    this.increaseFontSizeButton.addEventListener('click', () => this.adjustEditorFontSize(1));
    this.fontFamilySwitch.addEventListener('click', () => {
      const fontFamily: SqlEditorFontFamily = this.page.dataset.editorFont === 'comic-mono'
        ? 'default'
        : 'comic-mono';
      this.applyEditorFontFamily(fontFamily);
      writeStoredValue(EDITOR_FONT_FAMILY_KEY, fontFamily);
    });
    this.selectLimitInput.addEventListener('change', () => this.normalizeSelectLimitInput());
    this.selectLimitInput.addEventListener('blur', () => this.normalizeSelectLimitInput());
    this.saveActionButton.addEventListener('click', () => void this.saveCurrentQuery());
    this.runActionButton.addEventListener('click', () => void this.runCurrentStatement());
    this.loginForm.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.login();
    });
    this.signOutButton.addEventListener('click', () => void this.logout());
    this.refreshButton.addEventListener('click', () => void this.fetchRecords(true));
    this.newButton.addEventListener('click', () => this.createNewTab(true));
    this.collapseButton.addEventListener('click', () => this.toggleSidebarCollapse());
    this.searchInput.addEventListener('input', () => this.renderRecordList());
    this.valueCopyRaw.addEventListener('click', () => void this.copyRawValue());
    this.valueClose.addEventListener('click', () => this.closeValueDialog());
    this.valueEditInput.addEventListener('input', () => this.refreshUpdateSql());
    this.valueSqlCopy.addEventListener('click', () => void this.copyUpdateSql());
    this.valueSqlExecute.addEventListener('click', () => void this.executeUpdateSql());
    this.bindValueSqlResizer();
    this.valueFindInput.addEventListener('input', () => this.scheduleValueFind());
    this.valueFindPrevious.addEventListener('click', () => this.moveValueFind(-1));
    this.valueFindNext.addEventListener('click', () => this.moveValueFind(1));
    this.valueFindClose.addEventListener('click', () => this.closeValueFind());
    this.valueFindInput.addEventListener('keydown', (event) => {
      if (event.isComposing) return;
      if (event.key === 'Enter') {
        event.preventDefault();
        this.moveValueFind(event.shiftKey ? -1 : 1);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        this.closeValueFind();
      }
    });
    this.valueDialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      if (this.valueFindEscapeGuard) {
        this.valueFindEscapeGuard = false;
        return;
      }
      this.closeValueDialog();
    });
    window.addEventListener('keydown', (event) => this.handleValueDialogFindShortcut(event), true);
    this.valueDialog.addEventListener('keydown', (event) => this.handleValueDialogSelectAll(event), true);
    this.valueDialog.addEventListener('close', () => this.clearValueDialog());
    window.serviceApi.onCloseShortcutRequested(() => this.handleCloseShortcut());
    window.addEventListener('keydown', (event) => {
      if (!this.active || this.currentState().auth?.status !== 'signed-in') return;
      if (document.querySelector('dialog[open]')) return;
      if (isSqlSaveShortcut(event, this.isMac)) {
        event.preventDefault();
        event.stopPropagation();
        void this.saveCurrentQuery();
        return;
      }
      if (isSqlRunShortcut(event, this.isMac)) {
        event.preventDefault();
        event.stopPropagation();
        void this.runCurrentStatement();
      }
    }, true);
    window.addEventListener('beforeunload', () => this.persistUntitledDrafts());
    this.bindSidebarResizer();
    this.bindResultResizer();
  }

  private async handleCloseShortcut(): Promise<boolean> {
    if (!this.active) return false;
    const state = this.currentState();
    if (state.tabs.length <= 1) return false;
    const key = state.activeTabKey;
    if (!key) return false;
    await this.closeTab(key);
    return true;
  }

  private enumTableDetails(
    target: SqlTableEnumHoverTarget,
  ): { table: SqlSchemaTable; columns: SqlEnumColumn[] } | undefined {
    const state = this.currentState();
    if (
      target.environment !== this.environment
      || target.tabKey !== state.activeTabKey
      || state.auth?.status !== 'signed-in'
    ) return undefined;
    const table = state.schema?.tables.find((candidate) => candidate.name === target.tableName);
    if (!table) return undefined;
    const columns = table.columns.filter(
      (column): column is SqlEnumColumn => column.enum !== undefined,
    );
    return columns.length > 0 ? { table, columns } : undefined;
  }

  private handleTableEnumDoubleClick(event: MouseEvent, view: EditorView): void {
    if (event.button !== 0 || !this.active || this.currentState().auth?.status !== 'signed-in') {
      this.closeTableEnumHover();
      return;
    }
    const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (position === null) {
      this.closeTableEnumHover();
      return;
    }
    if (!this.currentState().schema) {
      // The schema is not loaded yet: trigger a deduplicated reload and retry
      // the tooltip once it arrives instead of failing silently.
      this.closeTableEnumHover();
      this.retryTableEnumAfterSchemaLoad(view, position);
      return;
    }
    this.tryOpenTableEnumTooltip(view, position);
  }

  private tryOpenTableEnumTooltip(view: EditorView, position: number): void {
    const schema = this.currentState().schema;
    if (!schema || !this.active || this.currentState().auth?.status !== 'signed-in') {
      this.closeTableEnumHover();
      return;
    }
    const reference = resolveSqlTableReferenceAt(view.state.doc.toString(), position, schema);
    if (!reference) {
      this.closeTableEnumHover();
      return;
    }
    const table = schema.tables.find((candidate) => candidate.name === reference.tableName);
    if (!table?.columns.some((column) => column.enum)) {
      this.closeTableEnumHover();
      return;
    }
    this.closeTableEnumHover();
    const target: SqlTableEnumHoverTarget = {
      ...reference,
      environment: this.environment,
      tabKey: this.currentState().activeTabKey,
    };
    this.tableEnumHoverTarget = target;
    window.requestAnimationFrame(() => {
      if (this.tableEnumHoverTarget !== target || !this.active) return;
      activateHover(view, target.from, 1, {
        tooltip: this.tableEnumHover,
        until: (transaction) => transaction.docChanged,
      });
    });
  }

  private retryTableEnumAfterSchemaLoad(view: EditorView, position: number): void {
    const environment = this.environment;
    const pending = {
      view,
      source: view.state.doc.toString(),
      position,
      environment,
      tabKey: this.currentState().activeTabKey,
    };
    this.tableEnumPendingPosition = pending;
    void this.ensureSchemaLoaded(environment, true).then(() => {
      if (
        this.tableEnumPendingPosition !== pending
        || pending.view !== this.editor
        || pending.source !== view.state.doc.toString()
        || pending.environment !== this.environment
        || pending.tabKey !== this.currentState().activeTabKey
        || !this.active
      ) {
        return;
      }
      this.tableEnumPendingPosition = undefined;
      this.tryOpenTableEnumTooltip(view, pending.position);
    });
  }

  private handleTableEnumPointerMove(event: PointerEvent, view: EditorView): void {
    const target = this.tableEnumHoverTarget;
    if (!target) return;
    if (
      event.target instanceof Element
      && event.target.closest('.sql-table-enum-tooltip')
    ) {
      this.cancelTableEnumHoverClose();
      return;
    }
    const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (position !== null && position >= target.from && position <= target.to) {
      this.cancelTableEnumHoverClose();
      return;
    }
    this.scheduleTableEnumHoverClose();
  }

  private tableEnumTooltipAt(view: EditorView, position: number): Tooltip | null {
    const target = this.tableEnumHoverTarget;
    if (
      view !== this.editor
      || !target
      || position < target.from
      || position > target.to
    ) return null;
    const details = this.enumTableDetails(target);
    if (!details) return null;
    return {
      pos: target.from,
      end: target.to,
      above: false,
      create: () => {
        const dom = this.createTableEnumTooltipDom(details.table, details.columns);
        const handlePointerEnter = (): void => this.cancelTableEnumHoverClose();
        const handlePointerLeave = (): void => this.scheduleTableEnumHoverClose();
        dom.addEventListener('pointerenter', handlePointerEnter);
        dom.addEventListener('pointerleave', handlePointerLeave);
        return {
          dom,
          destroy: () => {
            dom.removeEventListener('pointerenter', handlePointerEnter);
            dom.removeEventListener('pointerleave', handlePointerLeave);
            if (this.tableEnumHoverTarget === target) {
              this.tableEnumHoverTarget = undefined;
              this.cancelTableEnumHoverClose();
            }
          },
        };
      },
    };
  }

  private createTableEnumTooltipDom(
    schemaTable: SqlSchemaTable,
    columns: readonly SqlEnumColumn[],
  ): HTMLElement {
    const root = document.createElement('section');
    root.className = 'sql-table-enum-tooltip';
    root.setAttribute('aria-label', `${schemaTable.name} enum field details`);

    const heading = document.createElement('div');
    heading.className = 'sql-table-enum-tooltip-heading';
    const title = document.createElement('strong');
    title.textContent = schemaTable.name;
    const count = document.createElement('span');
    count.textContent = `${columns.length} enum field${columns.length === 1 ? '' : 's'}`;
    heading.append(title, count);

    const scroll = document.createElement('div');
    scroll.className = 'sql-table-enum-tooltip-scroll';
    const table = document.createElement('table');
    const head = document.createElement('thead');
    const headingRow = document.createElement('tr');
    for (const label of ['Field', 'Type', 'Nullable', 'Comment']) {
      const cell = document.createElement('th');
      cell.scope = 'col';
      cell.textContent = label;
      headingRow.append(cell);
    }
    head.append(headingRow);

    const body = document.createElement('tbody');
    for (const column of columns.slice(0, SQL_ENUM_TOOLTIP_MAX_ROWS)) {
      const row = document.createElement('tr');
      const field = document.createElement('td');
      field.className = 'sql-table-enum-tooltip-identifier';
      field.textContent = column.name;
      const dataType = document.createElement('td');
      dataType.className = 'sql-table-enum-tooltip-type';
      dataType.textContent = column.dataType ?? '—';
      const nullable = document.createElement('td');
      nullable.className = 'sql-table-enum-tooltip-nullable';
      nullable.textContent = column.enum.nullable ? 'Yes' : 'No';
      const comment = document.createElement('td');
      comment.className = 'sql-table-enum-tooltip-comment';
      for (const part of sqlEnumCommentParts(column.enum.comment, column.enum.defaultValue)) {
        if (!part.isDefault) {
          comment.append(document.createTextNode(part.text));
          continue;
        }
        const value = document.createElement('span');
        value.className = 'sql-table-enum-tooltip-default-value';
        value.textContent = part.text;
        const badge = document.createElement('span');
        badge.className = 'sql-table-enum-tooltip-default-badge';
        badge.textContent = '(default)';
        badge.title = 'Database default value';
        comment.append(value, badge);
      }
      row.append(field, dataType, nullable, comment);
      body.append(row);
    }
    table.append(head, body);
    scroll.append(table);
    root.append(heading, scroll);

    if (columns.length > SQL_ENUM_TOOLTIP_MAX_ROWS) {
      const bounded = document.createElement('p');
      bounded.className = 'sql-table-enum-tooltip-bounded';
      bounded.textContent = `${columns.length - SQL_ENUM_TOOLTIP_MAX_ROWS} more enum fields are not shown.`;
      root.append(bounded);
    }
    return root;
  }

  private cancelTableEnumHoverClose(): void {
    if (this.tableEnumHoverCloseTimer === undefined) return;
    window.clearTimeout(this.tableEnumHoverCloseTimer);
    this.tableEnumHoverCloseTimer = undefined;
  }

  private scheduleTableEnumHoverClose(): void {
    if (!this.tableEnumHoverTarget || this.tableEnumHoverCloseTimer !== undefined) return;
    this.tableEnumHoverCloseTimer = window.setTimeout(() => {
      this.tableEnumHoverCloseTimer = undefined;
      this.closeTableEnumHover();
    }, SQL_ENUM_TOOLTIP_CLOSE_DELAY_MS);
  }

  private closeTableEnumHover(): void {
    this.cancelTableEnumHoverClose();
    if (!this.tableEnumHoverTarget) return;
    this.tableEnumHoverTarget = undefined;
    this.editor.dispatch({ effects: closeHoverTooltip(this.tableEnumHover) });
  }

  private currentState(): SqlEnvironmentState {
    return this.states[this.environment];
  }

  private currentTab(): SqlQueryTab | undefined {
    const state = this.currentState();
    return state.tabs.find((tab) => tab.key === state.activeTabKey);
  }

  private isTabDirty(tab: SqlQueryTab): boolean {
    return tab.source !== tab.savedSource;
  }

  private restoreUntitledDrafts(): void {
    let restored = emptySqlUntitledDraftState();
    try {
      restored = parseSqlUntitledDraftState(localStorage.getItem(SQL_UNTITLED_DRAFTS_STORAGE_KEY));
    } catch {
      // A missing or unavailable renderer store simply starts with no drafts.
    }
    for (const environment of ['production', 'development'] as const) {
      const draftState = restored[environment];
      const tabs = draftState.sources.map((source) => {
        const tab = newQueryTab(environment);
        tab.source = source;
        return tab;
      });
      this.states[environment].tabs = tabs;
      this.states[environment].activeTabKey = tabs[draftState.activeIndex]?.key;
    }
  }

  private collectUntitledDrafts(): SqlUntitledDraftState {
    const drafts = emptySqlUntitledDraftState();
    for (const environment of ['production', 'development'] as const) {
      const state = this.states[environment];
      const tabs = state.tabs.filter((tab) => tab.recordId === undefined);
      drafts[environment].sources = tabs.map((tab) => normalizeSqlEditorSource(tab.source));
      const activeIndex = tabs.findIndex((tab) => tab.key === state.activeTabKey);
      drafts[environment].activeIndex = activeIndex >= 0 ? activeIndex : 0;
    }
    return drafts;
  }

  private scheduleUntitledDraftPersistence(): void {
    if (this.untitledDraftPersistTimer !== undefined) {
      window.clearTimeout(this.untitledDraftPersistTimer);
    }
    this.untitledDraftPersistTimer = window.setTimeout(() => {
      this.untitledDraftPersistTimer = undefined;
      this.persistUntitledDrafts();
    }, SQL_UNTITLED_DRAFT_PERSIST_DELAY_MS);
  }

  private persistUntitledDrafts(): void {
    if (this.untitledDraftPersistTimer !== undefined) {
      window.clearTimeout(this.untitledDraftPersistTimer);
      this.untitledDraftPersistTimer = undefined;
    }
    try {
      localStorage.setItem(
        SQL_UNTITLED_DRAFTS_STORAGE_KEY,
        serializeSqlUntitledDraftState(this.collectUntitledDrafts()),
      );
      this.untitledDraftPersistWarningShown = false;
    } catch {
      if (this.untitledDraftPersistWarningShown) return;
      this.untitledDraftPersistWarningShown = true;
      toast('Untitled SQL drafts could not be saved locally.', 'error');
    }
  }

  private async switchEnvironment(environment: SqlEnvironment): Promise<void> {
    if (environment === this.environment) return;
    this.environment = environment;
    writeStoredValue(ACTIVE_ENVIRONMENT_KEY, environment);
    this.searchInput.value = '';
    this.loginError.classList.add('hidden');
    this.loginError.textContent = '';
    this.renderEnvironmentChrome();
    this.renderTabs();
    this.replaceEditorDocument(this.currentTab()?.source ?? '');
    this.renderRecordList();
    this.renderResult();
    await this.loadEnvironment();
  }

  private renderEnvironmentChrome(): void {
    const label = environmentLabel(this.environment);
    this.page.dataset.environment = this.environment;
    this.productionTab.setAttribute('aria-selected', String(this.environment === 'production'));
    this.developmentTab.setAttribute('aria-selected', String(this.environment === 'development'));
    this.loginEnvironment.textContent = label;
  }

  private setAuthenticatedHeaderVisible(visible: boolean): void {
    this.fontControls.classList.toggle('hidden', !visible);
    this.sessionActions.classList.toggle('hidden', !visible);
  }

  private async loadEnvironment(): Promise<void> {
    const environment = this.environment;
    const state = this.states[environment];
    const version = ++state.loadVersion;
    this.renderLoading();
    try {
      const auth = await window.sqlApi.getAuthState(environment);
      if (version !== state.loadVersion) return;
      state.auth = auth;
      if (!this.active || environment !== this.environment) return;
      if (auth.status === 'signed-in') {
        this.renderAuthenticated();
        void this.ensureSchemaLoaded(environment, false);
        await this.fetchRecords(false, environment, version);
      } else {
        this.renderSignedOut(auth.message);
      }
    } catch (error) {
      if (version !== state.loadVersion) return;
      state.auth = {
        environment,
        status: 'signed-out',
        hasSavedCredentials: false,
        message: toErrorMessage(error),
      };
      if (this.active && environment === this.environment) {
        this.renderSignedOut(toErrorMessage(error));
      }
    }
  }

  private renderLoading(): void {
    this.setAuthenticatedHeaderVisible(false);
    this.loadingView.classList.remove('hidden');
    this.signedOutView.classList.add('hidden');
    this.workspace.classList.add('hidden');
    this.sessionUser.classList.add('hidden');
    this.signOutButton.classList.add('hidden');
    this.loadingView.textContent = `Connecting to ${environmentLabel(this.environment)}…`;
  }

  private renderSignedOut(message?: string): void {
    this.closeTableEnumHover();
    this.setAuthenticatedHeaderVisible(false);
    this.loadingView.classList.add('hidden');
    this.workspace.classList.add('hidden');
    this.signedOutView.classList.remove('hidden');
    this.sessionUser.classList.add('hidden');
    this.signOutButton.classList.add('hidden');
    if (message) {
      this.loginError.textContent = message;
      this.loginError.classList.remove('hidden');
    } else {
      this.loginError.textContent = '';
      this.loginError.classList.add('hidden');
    }
    window.requestAnimationFrame(() => this.loginUsername.focus());
  }

  private renderAuthenticated(): void {
    const state = this.currentState();
    const user = state.auth?.user;
    if (state.tabs.length === 0) this.createNewTab(false);
    this.setAuthenticatedHeaderVisible(true);
    this.loadingView.classList.add('hidden');
    this.signedOutView.classList.add('hidden');
    this.workspace.classList.remove('hidden');
    this.sessionUser.textContent = user?.userName ?? '';
    this.sessionUser.classList.toggle('hidden', !user);
    this.signOutButton.classList.remove('hidden');
    this.renderTabs();
    this.replaceEditorDocument(this.currentTab()?.source ?? '');
    this.renderRecordList();
    this.renderResult();
    this.renderBusyState();
    window.requestAnimationFrame(() => this.editor.requestMeasure());
  }

  private async login(): Promise<void> {
    const userName = this.loginUsername.value.trim();
    const password = this.loginPassword.value;
    if (!userName || !password) {
      this.renderSignedOut('Enter your username and password.');
      return;
    }
    const environment = this.environment;
    const state = this.states[environment];
    const version = ++state.loadVersion;
    this.loginSubmit.disabled = true;
    this.loginSubmit.textContent = 'Signing in…';
    this.loginError.classList.add('hidden');
    try {
      const auth = await window.sqlApi.login({ environment, userName, password });
      if (version !== state.loadVersion) return;
      state.auth = auth;
      this.renderAuthenticated();
      void this.ensureSchemaLoaded(environment, false);
      await this.fetchRecords(false, environment, version);
    } catch (error) {
      if (version === state.loadVersion) this.renderSignedOut(toErrorMessage(error));
    } finally {
      this.loginPassword.value = '';
      this.loginSubmit.disabled = false;
      this.loginSubmit.textContent = 'Sign in';
    }
  }

  private async logout(): Promise<void> {
    const environment = this.environment;
    const state = this.states[environment];
    try {
      const auth = await window.sqlApi.logout(environment);
      state.loadVersion += 1;
      state.recordLoadVersion += 1;
      state.auth = auth;
      state.schema = undefined;
      state.schemaCompletion = undefined;
      state.schemaLoading = false;
      state.records = [];
      state.tabs = [];
      state.activeTabKey = undefined;
      this.replaceEditorDocument('');
      this.renderSignedOut();
      toast(`Signed out of ${environmentLabel(environment)}.`, 'success');
    } catch (error) {
      toast(toErrorMessage(error), 'error');
    }
  }

  private async fetchRecords(
    announce: boolean,
    environment = this.environment,
    loadVersion = this.states[environment].loadVersion,
  ): Promise<void> {
    const state = this.states[environment];
    if (state.listLoading) return;
    state.listLoading = true;
    if (environment === this.environment) this.renderBusyState();
    try {
      const records = await window.sqlApi.listQueries(environment);
      if (loadVersion !== state.loadVersion) return;
      state.records = records;
      if (environment === this.environment) {
        this.renderRecordList();
        if (announce) toast('Saved queries refreshed.', 'success');
      }
    } catch (error) {
      if (environment === this.environment) this.handleOperationError(error, true, environment);
    } finally {
      state.listLoading = false;
      if (environment === this.environment) this.renderBusyState();
    }
  }

  /** Loads a missing schema at most once per environment; callers await the shared flight. */
  private ensureSchemaLoaded(environment: SqlEnvironment, userInitiated: boolean): Promise<void> {
    const state = this.states[environment];
    if (state.schema) return Promise.resolve();
    const loadVersion = state.loadVersion;
    const existing = this.schemaFlights.get(environment);
    if (existing?.loadVersion === loadVersion) return existing.promise;
    const promise = this.fetchSchema(environment, loadVersion, userInitiated);
    const flight: SqlSchemaFlight = { loadVersion, promise };
    this.schemaFlights.set(environment, flight);
    void promise.finally(() => {
      if (this.schemaFlights.get(environment) === flight) {
        this.schemaFlights.delete(environment);
      }
    }).catch(() => undefined);
    return promise;
  }

  private async fetchSchema(
    environment = this.environment,
    loadVersion = this.states[environment].loadVersion,
    userInitiated = false,
  ): Promise<void> {
    const state = this.states[environment];
    state.schemaLoading = true;
    try {
      const schema = await window.sqlApi.getSchema(environment);
      if (loadVersion !== state.loadVersion || schema.environment !== environment) return;
      state.schema = schema;
      state.schemaCompletion = schemaCompletionSource({
        dialect: MySQL,
        schema: buildSqlCompletionNamespace(schema),
      });
    } catch {
      if (loadVersion === state.loadVersion) {
        console.warn('[renderer:sql-schema] SQL schema completion is temporarily unavailable.');
        if (this.active && environment === this.environment) {
          toast('The SQL schema could not be loaded. Double-click a table name to retry.', 'error');
        }
      }
    } finally {
      if (loadVersion === state.loadVersion) state.schemaLoading = false;
    }
  }

  private renderRecordList(): void {
    const state = this.currentState();
    const selectedId = this.currentTab()?.recordId;
    const search = this.searchInput.value.trim().toLocaleLowerCase();
    const records = search
      ? state.records.filter((record) => record.name.toLocaleLowerCase().includes(search))
      : state.records;
    const nodes: HTMLElement[] = records.map((record) => {
      const selected = record.id === selectedId;
      const row = document.createElement('div');
      row.className = 'sql-query-row';
      row.dataset.queryId = String(record.id);
      row.dataset.selected = String(selected);
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(selected));

      const main = document.createElement('button');
      main.type = 'button';
      main.className = 'sql-query-row-main';
      main.addEventListener('click', () => void this.openRecord(record.id));
      const name = document.createElement('span');
      name.className = 'sql-query-row-name';
      name.textContent = record.name;
      const meta = document.createElement('span');
      meta.className = 'sql-query-row-meta';
      meta.textContent = lastRunLabel(record.lastQueryDate);
      main.append(name, meta);

      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'sql-query-row-action sql-query-row-edit';
      edit.setAttribute('aria-label', `Rename ${record.name}`);
      edit.title = 'Rename saved query';
      edit.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3 11.75-.5 2 2-.5L12 5.75 10.25 4z"></path><path d="m9.5 4.75 1.75 1.75"></path></svg>';
      edit.addEventListener('click', () => void this.renameRecord(record));

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'sql-query-row-action sql-query-row-delete';
      remove.setAttribute('aria-label', `Delete ${record.name}`);
      remove.title = 'Delete saved query';
      remove.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M3 4.5h10M6 2.5h4M5 4.5l.5 9h5l.5-9M6.75 7v4M9.25 7v4"></path></svg>';
      remove.addEventListener('click', () => void this.deleteRecord(record));
      row.append(main, edit, remove);
      return row;
    });
    if (nodes.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'sql-query-list-empty';
      empty.textContent = state.listLoading
        ? 'Loading saved queries…'
        : search
          ? 'No matching saved queries.'
          : 'No saved queries yet.';
      nodes.push(empty);
    }
    this.queryList.replaceChildren(...nodes);
  }

  private async openRecord(id: number): Promise<void> {
    const environment = this.environment;
    const state = this.states[environment];
    const existing = state.tabs.find((tab) => tab.recordId === id);
    if (existing) {
      this.selectTab(existing.key, true);
      return;
    }
    const version = ++state.recordLoadVersion;
    try {
      const record = await window.sqlApi.getQuery(environment, id);
      if (version !== state.recordLoadVersion) return;
      const openedWhileLoading = state.tabs.find((tab) => tab.recordId === record.id);
      if (openedWhileLoading) {
        if (environment === this.environment) this.selectTab(openedWhileLoading.key, true);
        return;
      }
      const tab = tabFromRecord(environment, record);
      state.tabs.push(tab);
      state.activeTabKey = tab.key;
      this.upsertRecord(state, record);
      if (environment === this.environment) {
        this.replaceEditorDocument(tab.source);
        this.renderTabs();
        this.renderRecordList();
        this.renderResult();
        this.renderBusyState();
        this.editor.focus();
      }
    } catch (error) {
      if (version === state.recordLoadVersion) this.handleOperationError(error, true, environment);
    }
  }

  private createNewTab(focus: boolean): void {
    const state = this.currentState();
    const tab = newQueryTab(this.environment);
    state.tabs.push(tab);
    state.activeTabKey = tab.key;
    this.persistUntitledDrafts();
    this.replaceEditorDocument('');
    this.renderTabs();
    this.renderRecordList();
    this.renderResult();
    this.renderBusyState();
    if (focus) this.editor.focus();
  }

  private selectTab(key: string, focus: boolean): void {
    const state = this.currentState();
    const tab = state.tabs.find((item) => item.key === key);
    if (!tab) return;
    state.activeTabKey = key;
    if (tab.recordId === undefined) this.persistUntitledDrafts();
    this.replaceEditorDocument(tab.source);
    this.renderTabs();
    this.renderRecordList();
    this.renderResult();
    this.renderBusyState();
    if (focus) this.focusTab(key);
  }

  private renderTabs(): void {
    const state = this.currentState();
    const nodes: HTMLElement[] = [];
    let activeButton: HTMLButtonElement | undefined;
    for (const tab of state.tabs) {
      const active = tab.key === state.activeTabKey;
      const dirty = this.isTabDirty(tab);
      const item = document.createElement('div');
      item.className = 'sql-query-tab';
      item.dataset.active = String(active);
      item.dataset.dirty = String(dirty);

      const select = document.createElement('button');
      select.type = 'button';
      select.className = 'sql-query-tab-select';
      select.setAttribute('role', 'tab');
      select.setAttribute('aria-selected', String(active));
      select.setAttribute('aria-label', `Open ${tab.title}${dirty ? ', unsaved changes' : ''}`);
      select.tabIndex = active ? 0 : -1;
      select.title = tab.title;
      const title = document.createElement('span');
      title.className = 'sql-query-tab-title';
      title.textContent = tab.title;
      select.append(title);
      select.addEventListener('click', () => this.selectTab(tab.key, false));
      select.addEventListener('keydown', (event) => this.handleTabKeydown(event, tab.key));

      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'sql-query-tab-close';
      close.setAttribute('aria-label', `Close ${tab.title}`);
      close.title = `Close ${tab.title}`;
      close.disabled = tab.executing || tab.saving;
      if (dirty) {
        const dot = document.createElement('span');
        dot.className = 'sql-query-tab-dirty';
        dot.setAttribute('aria-hidden', 'true');
        close.append(dot);
      }
      const closeIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      closeIcon.classList.add('sql-query-tab-close-icon');
      closeIcon.setAttribute('viewBox', '0 0 16 16');
      closeIcon.setAttribute('fill', 'none');
      closeIcon.setAttribute('stroke', 'currentColor');
      closeIcon.setAttribute('stroke-width', '1.5');
      closeIcon.setAttribute('stroke-linecap', 'round');
      closeIcon.setAttribute('aria-hidden', 'true');
      const closePath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      closePath.setAttribute('d', 'm4 4 8 8M12 4l-8 8');
      closeIcon.append(closePath);
      close.append(closeIcon);
      close.addEventListener('pointerenter', () => { item.dataset.closeHovered = 'true'; });
      close.addEventListener('pointerleave', () => { delete item.dataset.closeHovered; });
      close.addEventListener('focus', () => { item.dataset.closeHovered = 'true'; });
      close.addEventListener('blur', () => { delete item.dataset.closeHovered; });
      close.addEventListener('click', () => void this.closeTab(tab.key));
      item.append(select, close);
      nodes.push(item);
      if (active) activeButton = select;
    }
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'sql-query-tab-add';
    add.setAttribute('aria-label', 'New query');
    add.title = 'New query';
    add.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M8 3v10M3 8h10"></path></svg>';
    add.addEventListener('click', () => this.createNewTab(true));
    nodes.push(add);
    this.queryTabs.replaceChildren(...nodes);
    if (activeButton) {
      window.requestAnimationFrame(() => {
        if (activeButton?.isConnected) activeButton.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      });
    }
  }

  private handleTabKeydown(event: KeyboardEvent, key: string): void {
    const tabs = this.currentState().tabs;
    const index = tabs.findIndex((tab) => tab.key === key);
    if (index < 0) return;
    let target: SqlQueryTab | undefined;
    if (event.key === 'ArrowLeft') target = tabs[index - 1] ?? tabs.at(-1);
    if (event.key === 'ArrowRight') target = tabs[index + 1] ?? tabs[0];
    if (event.key === 'Home') target = tabs[0];
    if (event.key === 'End') target = tabs.at(-1);
    if (!target) return;
    event.preventDefault();
    this.selectTab(target.key, true);
  }

  private focusTab(key: string): void {
    window.requestAnimationFrame(() => {
      this.queryTabs.querySelector<HTMLButtonElement>(`.sql-query-tab[data-active='true'] .sql-query-tab-select`)?.focus({
        preventScroll: true,
      });
    });
  }

  private async closeTab(key: string): Promise<boolean> {
    const state = this.currentState();
    const index = state.tabs.findIndex((tab) => tab.key === key);
    if (index < 0) return false;
    const tab = state.tabs[index];
    if (!tab || tab.executing || tab.saving) {
      toast('Wait for the current query operation to finish.', 'error');
      return true;
    }
    if (this.isTabDirty(tab)) {
      let confirmed = false;
      try {
        confirmed = await window.serviceApi.confirmAction({
          title: 'Close Unsaved Query?',
          message: `Discard unsaved changes in “${tab.title}”?`,
          detail: 'The SQL text in this tab has not been saved.',
          kind: 'warning',
          confirmLabel: 'Discard',
        });
      } catch (error) {
        toast(toErrorMessage(error), 'error');
        return true;
      }
      if (!confirmed) return true;
    }
    const wasActive = state.activeTabKey === key;
    state.tabs.splice(index, 1);
    if (state.tabs.length === 0) {
      this.createNewTab(false);
      return true;
    }
    if (wasActive) state.activeTabKey = state.tabs[Math.min(index, state.tabs.length - 1)]?.key;
    this.persistUntitledDrafts();
    if (wasActive) this.replaceEditorDocument(this.currentTab()?.source ?? '');
    this.renderTabs();
    this.renderRecordList();
    this.renderResult();
    this.renderBusyState();
    return true;
  }

  private replaceEditorDocument(source: string): void {
    this.closeTableEnumHover();
    source = normalizeSqlEditorSource(source);
    const current = this.editor.state.doc.toString();
    if (current === source) return;
    this.replacingDocument = true;
    try {
      this.editor.dispatch({ changes: { from: 0, to: current.length, insert: source } });
    } finally {
      this.replacingDocument = false;
    }
  }

  private async saveCurrentQuery(): Promise<void> {
    const environment = this.environment;
    const state = this.states[environment];
    const tab = this.currentTab();
    if (!tab || tab.saving) return;
    tab.source = normalizeSqlEditorSource(this.editor.state.doc.toString());
    if (!tab.source.trim()) {
      toast('Enter SQL before saving.', 'error');
      this.editor.focus();
      return;
    }
    let name = tab.title;
    if (tab.recordId === undefined) {
      const requestedName = await this.promptForQueryName(
        'Save Query',
        'Enter a name for this saved query.',
        '',
        'Save',
      );
      if (requestedName === null) return;
      name = requestedName;
    }
    const sourceAtSave = tab.source;
    const draft = this.buildDraft(tab, name, sourceAtSave);
    const wasCreating = tab.recordId === undefined;
    tab.saving = true;
    this.renderTabs();
    this.renderBusyState();
    try {
      const saved = tab.recordId === undefined
        ? await window.sqlApi.createQuery(environment, draft)
        : await window.sqlApi.updateQuery(environment, tab.recordId, draft);
      tab.recordId = saved.id;
      tab.title = saved.name;
      tab.savedSource = normalizeSqlEditorSource(saved.sql);
      this.persistUntitledDrafts();
      if (tab.source === sourceAtSave) {
        tab.params = parseConfigParams(saved.config ?? draft.config);
      }
      this.upsertRecord(state, saved);
      if (environment === this.environment) {
        this.renderTabs();
        this.renderRecordList();
      }
      await this.fetchRecords(false, environment, state.loadVersion);
      toast(wasCreating ? 'Saved query created.' : 'Saved query updated.', 'success');
    } catch (error) {
      this.handleOperationError(error, true, environment);
    } finally {
      tab.saving = false;
      if (environment === this.environment) {
        this.renderTabs();
        this.renderBusyState();
      }
    }
  }

  private buildDraft(tab: SqlQueryTab, name = tab.title, source = tab.source): SqlQueryDraft {
    return {
      name: name.trim(),
      sql: source,
      config: configForSource(source, tab.params),
      ...(tab.lastResponseText && tab.executedAt
        ? { lastQueryResult: tab.lastResponseText, lastQueryDate: tab.executedAt }
        : {}),
    };
  }

  private async renameRecord(record: SqlQueryRecord): Promise<void> {
    const environment = this.environment;
    const state = this.states[environment];
    if (state.tabs.some((tab) => tab.recordId === record.id && tab.saving)) {
      toast('Wait for the query to finish saving before renaming it.', 'error');
      return;
    }
    const name = await this.promptForQueryName(
      'Rename Query',
      'Change the name shown in Saved Queries and open tabs.',
      record.name,
      'Rename',
    );
    if (name === null || name === record.name) return;
    try {
      const updated = await window.sqlApi.renameQuery(environment, record.id, name);
      this.upsertRecord(state, updated);
      for (const tab of state.tabs) {
        if (tab.recordId === updated.id) tab.title = updated.name;
      }
      if (environment === this.environment) {
        this.renderTabs();
        this.renderRecordList();
      }
      toast('Saved query renamed.', 'success');
    } catch (error) {
      this.handleOperationError(error, true, environment);
    }
  }

  private async deleteRecord(record: SqlQueryRecord): Promise<void> {
    const environment = this.environment;
    const state = this.states[environment];
    const matchingTabs = state.tabs.filter((tab) => tab.recordId === record.id);
    if (matchingTabs.some((tab) => tab.executing || tab.saving)) {
      toast('Wait for the query operation to finish before deleting it.', 'error');
      return;
    }
    const hasUnsavedChanges = matchingTabs.some((tab) => this.isTabDirty(tab));
    const confirmed = await window.serviceApi.confirmAction({
      title: 'Delete Saved Query?',
      message: `Delete “${record.name}”?`,
      detail: hasUnsavedChanges
        ? 'This removes the saved query and discards its open unsaved changes.'
        : 'This removes the saved query from the selected environment.',
      kind: 'warning',
      confirmLabel: 'Delete',
    });
    if (!confirmed) return;
    try {
      await window.sqlApi.deleteQuery(environment, record.id);
      state.records = state.records.filter((item) => item.id !== record.id);
      const activeIndex = state.tabs.findIndex((tab) => tab.key === state.activeTabKey);
      state.tabs = state.tabs.filter((tab) => tab.recordId !== record.id);
      if (!state.tabs.some((tab) => tab.key === state.activeTabKey)) {
        state.activeTabKey = state.tabs[Math.min(Math.max(activeIndex, 0), state.tabs.length - 1)]?.key;
      }
      if (environment === this.environment) {
        if (state.tabs.length === 0) this.createNewTab(false);
        else {
          this.replaceEditorDocument(this.currentTab()?.source ?? '');
          this.renderTabs();
          this.renderRecordList();
          this.renderResult();
          this.renderBusyState();
        }
      }
      toast('Saved query deleted.', 'success');
    } catch (error) {
      this.handleOperationError(error, true, environment);
    }
  }

  private upsertRecord(state: SqlEnvironmentState, record: SqlQueryRecord): void {
    state.records = [...state.records.filter((item) => item.id !== record.id), record]
      .sort((left, right) => right.name.localeCompare(left.name));
  }

  private async runCurrentStatement(): Promise<void> {
    const environment = this.environment;
    const tab = this.currentTab();
    if (!tab || tab.executing) return;
    const selection = this.editor.state.selection.main;
    const source = normalizeSqlEditorSource(this.editor.state.doc.toString());
    tab.source = source;
    const resolution = resolveSqlStatement(source, selection.from, selection.to);
    if (!resolution.ok) {
      toast(resolution.message, 'error');
      return;
    }
    const paramNames = extractSqlTemplateParamNames(resolution.statement.sql);
    const params = paramNames.length ? await this.promptForParameters(paramNames, tab.params) : {};
    if (params === null) return;
    tab.params = { ...tab.params, ...params };
    const executableSql = replaceSqlTemplateParams(resolution.statement.sql, tab.params);

    const version = ++tab.executionVersion;
    tab.executing = true;
    tab.result = undefined;
    tab.resultError = undefined;
    tab.lastResponseText = '';
    tab.executedStatement = undefined;
    tab.executedAt = undefined;
    tab.durationMs = undefined;
    this.renderTabs();
    this.renderBusyState();
    this.renderResult();
    try {
      const response = await window.sqlApi.execute(environment, executableSql, {
        limit: this.normalizeSelectLimitInput(),
      });
      if (version !== tab.executionVersion) return;
      tab.result = normalizeSqlResult(response.value);
      tab.lastResponseText = jsonText(response.value);
      tab.executedStatement = executableSql;
      tab.executedAt = response.executedAt;
      tab.durationMs = response.durationMs;
      if (this.active && environment === this.environment && this.currentTab()?.key === tab.key) {
        this.renderResult();
      }
    } catch (error) {
      if (version !== tab.executionVersion) return;
      tab.resultError = toErrorMessage(error);
      if (this.active && environment === this.environment && this.currentTab()?.key === tab.key) {
        this.renderResult();
      }
      this.handleOperationError(error, false, environment);
    } finally {
      tab.executing = false;
      if (this.active && environment === this.environment) {
        this.renderTabs();
        this.renderBusyState();
        if (this.currentTab()?.key === tab.key) this.renderResult();
      }
    }
  }

  private promptForQueryName(
    titleText: string,
    descriptionText: string,
    initialValue: string,
    submitLabel: string,
  ): Promise<string | null> {
    return new Promise((resolve) => {
      queryNameDialogSequence += 1;
      const titleId = `sql-query-name-dialog-title-${queryNameDialogSequence}`;
      const dialog = document.createElement('dialog');
      dialog.className = 'sql-parameter-dialog sql-query-name-dialog';
      dialog.setAttribute('aria-labelledby', titleId);
      const form = document.createElement('form');
      form.className = 'sql-parameter-form';
      form.method = 'dialog';

      const head = document.createElement('div');
      head.className = 'sql-parameter-head';
      const title = document.createElement('h2');
      title.id = titleId;
      title.textContent = titleText;
      const description = document.createElement('p');
      description.textContent = descriptionText;
      head.append(title, description);

      const label = document.createElement('label');
      label.className = 'field field-xs';
      label.append(document.createTextNode('Query name'));
      const input = document.createElement('input');
      input.className = 'input';
      input.type = 'text';
      input.value = initialValue;
      input.placeholder = 'Query name';
      input.required = true;
      input.maxLength = 300;
      input.autocomplete = 'off';
      input.spellcheck = false;
      label.append(input);

      const actions = document.createElement('div');
      actions.className = 'sql-parameter-actions';
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'btn btn-secondary';
      cancel.textContent = 'Cancel';
      const submit = document.createElement('button');
      submit.type = 'submit';
      submit.className = 'btn btn-primary';
      submit.textContent = submitLabel;
      actions.append(cancel, submit);
      form.append(head, label, actions);
      dialog.append(form);
      document.body.append(dialog);

      let settled = false;
      const finish = (value: string | null): void => {
        if (settled) return;
        settled = true;
        if (dialog.open) dialog.close();
        dialog.remove();
        resolve(value);
      };
      cancel.addEventListener('click', () => finish(null));
      dialog.addEventListener('cancel', (event) => {
        event.preventDefault();
        finish(null);
      });
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        input.setCustomValidity(input.value.trim() ? '' : 'Enter a query name.');
        if (!form.reportValidity()) return;
        finish(input.value.trim());
      });
      input.addEventListener('input', () => input.setCustomValidity(''));
      dialog.showModal();
      window.requestAnimationFrame(() => {
        input.focus();
        input.select();
      });
    });
  }

  private promptForParameters(
    names: string[],
    current: Readonly<Record<string, string>>,
  ): Promise<Record<string, string> | null> {
    return new Promise((resolve) => {
      const dialog = document.createElement('dialog');
      dialog.className = 'sql-parameter-dialog';
      dialog.setAttribute('aria-labelledby', 'sql-parameter-title');
      const form = document.createElement('form');
      form.className = 'sql-parameter-form';
      form.method = 'dialog';

      const head = document.createElement('div');
      head.className = 'sql-parameter-head';
      const title = document.createElement('h2');
      title.id = 'sql-parameter-title';
      title.textContent = 'Query Parameters';
      const description = document.createElement('p');
      description.textContent = 'Values replace matching {{parameter}} placeholders before execution.';
      head.append(title, description);

      const fields = document.createElement('div');
      fields.className = 'sql-parameter-fields';
      const inputs = new Map<string, HTMLInputElement>();
      for (const name of names) {
        const label = document.createElement('label');
        label.className = 'field field-xs';
        label.append(document.createTextNode(name));
        const input = document.createElement('input');
        input.className = 'input';
        input.type = 'text';
        input.value = current[name] ?? '';
        input.required = true;
        input.autocomplete = 'off';
        input.spellcheck = false;
        input.maxLength = 100_000;
        label.append(input);
        fields.append(label);
        inputs.set(name, input);
      }

      const actions = document.createElement('div');
      actions.className = 'sql-parameter-actions';
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'btn btn-secondary';
      cancel.textContent = 'Cancel';
      const run = document.createElement('button');
      run.type = 'submit';
      run.className = 'btn btn-primary';
      run.textContent = 'Run';
      actions.append(cancel, run);
      form.append(head, fields, actions);
      dialog.append(form);
      document.body.append(dialog);

      let settled = false;
      const finish = (value: Record<string, string> | null): void => {
        if (settled) return;
        settled = true;
        if (dialog.open) dialog.close();
        dialog.remove();
        resolve(value);
      };
      cancel.addEventListener('click', () => finish(null));
      dialog.addEventListener('cancel', (event) => {
        event.preventDefault();
        finish(null);
      });
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        if (!form.reportValidity()) return;
        finish(Object.fromEntries([...inputs].map(([name, input]) => [name, input.value])));
      });
      dialog.showModal();
      window.requestAnimationFrame(() => inputs.get(names[0] ?? '')?.focus());
    });
  }

  private renderBusyState(): void {
    const state = this.currentState();
    const tab = this.currentTab();
    this.refreshButton.disabled = state.listLoading;
    this.newButton.disabled = state.auth?.status !== 'signed-in';
    this.selectLimitInput.disabled = state.auth?.status !== 'signed-in' || !tab || tab.executing;
    this.saveActionButton.disabled = state.auth?.status !== 'signed-in' || !tab || tab.saving;
    this.runActionButton.disabled = state.auth?.status !== 'signed-in' || !tab || tab.executing;
  }

  private normalizeSelectLimitInput(): number {
    const limit = normalizeSqlSelectLimit(this.selectLimitInput.value);
    this.selectLimitInput.value = String(limit);
    return limit;
  }

  private renderResult(): void {
    this.destroyResultTable();
    const tab = this.currentTab();
    if (tab?.executing) {
      this.resultMeta.textContent = '';
      const node = document.createElement('div');
      node.className = 'sql-result-empty';
      node.textContent = 'Executing the selected statement…';
      this.resultContent.replaceChildren(node);
      return;
    }
    if (tab?.resultError) {
      this.resultMeta.textContent = '';
      const node = document.createElement('div');
      node.className = 'sql-result-error';
      node.textContent = tab.resultError;
      this.resultContent.replaceChildren(node);
      return;
    }
    if (!tab?.result) {
      this.resultMeta.textContent = '';
      const node = document.createElement('div');
      node.className = 'sql-result-empty';
      node.textContent = 'Run a statement to see its result.';
      this.resultContent.replaceChildren(node);
      return;
    }
    const rowCount = sqlResultRowCountInfo(tab.result);
    const duration = formatSqlDuration(tab.durationMs);
    this.resultMeta.textContent = [
      rowCount === undefined ? '' : `${rowCount} row${rowCount === 1 ? '' : 's'}`,
      duration,
    ].filter(Boolean).join(' · ');
    if (tab.result.kind === 'table') {
      this.resultTable = new SqlVirtualResultTable({
        host: this.resultContent,
        result: tab.result,
        onOpenValue: (column, presentation, row) => this.openValueDialog(column, presentation, row),
        onWindowRendered: () => this.refreshCellOverflowButtons(),
      });
      return;
    }
    this.resultContent.replaceChildren(this.createResultNode(tab.result));
    window.requestAnimationFrame(() => this.refreshCellOverflowButtons());
  }

  private destroyResultTable(): void {
    this.resultTable?.destroy();
    this.resultTable = undefined;
  }

  private createResultNode(result: SqlDisplayResult): HTMLElement {
    if (result.kind === 'table') {
      const wrap = document.createElement('div');
      wrap.className = 'sql-result-table-wrap';
      const table = document.createElement('table');
      table.className = 'sql-result-table';
      const head = document.createElement('thead');
      const headRow = document.createElement('tr');
      for (const column of result.columns) {
        const cell = document.createElement('th');
        cell.scope = 'col';
        const label = document.createElement('span');
        label.className = 'sql-result-column-name';
        label.textContent = column;
        label.title = column;
        cell.append(label);
        headRow.append(cell);
      }
      head.append(headRow);
      const body = document.createElement('tbody');
      for (const row of result.rows) {
        const rowNode = document.createElement('tr');
        rowNode.setAttribute('aria-selected', 'false');
        rowNode.addEventListener('click', () => {
          for (const sibling of Array.from(body.rows)) {
            sibling.classList.remove('sql-result-row-selected');
            sibling.setAttribute('aria-selected', 'false');
          }
          rowNode.classList.add('sql-result-row-selected');
          rowNode.setAttribute('aria-selected', 'true');
        });
        rowNode.addEventListener('dblclick', (event) => {
          const target = event.target;
          if (!(target instanceof Element)) return;
          const cell = target.closest<HTMLTableCellElement>('td');
          if (!cell || !rowNode.contains(cell)) return;
          const columnIndex = Array.from(rowNode.cells).indexOf(cell);
          const column = result.columns[columnIndex];
          if (column === undefined) return;
          this.openValueDialog(column, sqlCellPresentation(row[column]), row);
        });
        for (const column of result.columns) {
          const cell = document.createElement('td');
          const presentation = sqlCellPresentation(row[column]);
          const content = document.createElement('div');
          content.className = 'sql-result-cell';
          const text = document.createElement('span');
          text.className = 'sql-result-cell-value';
          text.textContent = presentation.display;
          const detail = document.createElement('button');
          detail.type = 'button';
          detail.className = 'sql-result-cell-detail hidden';
          detail.dataset.sqlCellDetail = 'true';
          detail.setAttribute('aria-label', `View full ${column} value`);
          detail.title = `View full ${column} value`;
          detail.innerHTML = '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="3.25" cy="8" r="1.15"></circle><circle cx="8" cy="8" r="1.15"></circle><circle cx="12.75" cy="8" r="1.15"></circle></svg>';
          detail.addEventListener('click', () => this.openValueDialog(column, presentation, row));
          content.append(text, detail);
          cell.append(content);
          rowNode.append(cell);
        }
        body.append(rowNode);
      }
      table.append(head, body);
      wrap.append(table);
      return wrap;
    }
    if (result.kind === 'empty') {
      const node = document.createElement('div');
      node.className = 'sql-result-empty';
      node.textContent = result.message;
      return node;
    }
    if (result.kind === 'scalar') {
      const node = document.createElement('pre');
      node.className = 'sql-result-scalar';
      node.textContent = formatSqlCell(result.value);
      return node;
    }
    if (result.kind === 'json') {
      const node = document.createElement('pre');
      node.className = 'sql-result-json';
      node.textContent = jsonText(result.value);
      return node;
    }
    if (result.kind === 'summary') {
      const section = document.createElement('section');
      section.className = 'sql-result-section';
      const title = document.createElement('h3');
      title.textContent = result.title;
      const list = document.createElement('dl');
      list.className = 'sql-result-summary';
      for (const item of result.items) {
        const term = document.createElement('dt');
        term.textContent = item.label;
        const detail = document.createElement('dd');
        detail.textContent = formatSqlCell(item.value);
        list.append(term, detail);
      }
      section.append(title, list);
      if (result.message) {
        const message = document.createElement('p');
        message.textContent = result.message;
        section.append(message);
      }
      return section;
    }
    const container = document.createElement('div');
    for (const child of result.results) {
      const section = document.createElement('section');
      section.className = 'sql-result-section';
      const title = document.createElement('h3');
      title.textContent = child.title;
      section.append(title, this.createResultNode(child));
      container.append(section);
    }
    return container;
  }

  private refreshCellOverflowButtons(): void {
    const updates: Array<{ detail: HTMLButtonElement; overflowing: boolean }> = [];
    for (const cell of Array.from(this.resultContent.querySelectorAll<HTMLElement>('.sql-result-cell'))) {
      const text = cell.querySelector<HTMLElement>('.sql-result-cell-value');
      const detail = cell.querySelector<HTMLButtonElement>('.sql-result-cell-detail');
      if (!text || !detail) continue;
      updates.push({ detail, overflowing: text.scrollWidth > text.clientWidth });
    }
    for (const { detail, overflowing } of updates) {
      detail.classList.toggle('hidden', !overflowing);
    }
  }

  private openValueDialog(
    column: string,
    presentation: SqlCellPresentation,
    row: Readonly<Record<string, unknown>>,
  ): void {
    this.clearValueDialog();
    this.valueDialogTitle.textContent = column;
    this.valueRaw = presentation.raw;
    this.valueFormatted = presentation.kind === 'json' ? presentation.formatted : undefined;
    this.valuePresentation = presentation;
    this.valueCopyRaw.disabled = false;
    this.resetRawCopyFeedback();

    const edit = this.resolveCellEditContext(column, row);
    let focusTarget: HTMLElement = this.valueClose;
    if (edit.kind === 'edit') {
      this.valueEditContext = {
        table: edit.table,
        column,
        originalValue: edit.originalValue,
        primaryKey: edit.primaryKey,
      };
      this.renderValueEdit(presentation);
      focusTarget = this.valueEditInput;
    } else {
      const detectedLanguage = presentation.kind === 'text'
        ? detectSqlValueLanguage(presentation.raw)
        : undefined;
      this.valueDetectedLanguage = detectedLanguage;
      focusTarget = this.renderValueView(presentation, detectedLanguage);
      this.applyValuePanelForView(edit.kind === 'multi' ? 'multi' : 'view');
    }

    this.valueDialog.showModal();
    window.requestAnimationFrame(() => focusTarget.focus());
  }

  private resolveCellEditContext(
    column: string,
    row: Readonly<Record<string, unknown>>,
  ): { kind: 'edit'; table: string; originalValue: unknown; primaryKey: SqlUpdatePrimaryKey[] }
    | { kind: 'multi' }
    | { kind: 'none' } {
    const statement = this.currentTab()?.executedStatement;
    const schema = this.currentState().schema;
    if (!statement || !schema) return { kind: 'none' };
    const tables = resolveSqlSelectTables(statement);
    if (tables.length > 1) return { kind: 'multi' };
    if (tables.length !== 1) return { kind: 'none' };
    const table = schema.tables.find(
      (candidate) => candidate.name.toLocaleLowerCase() === (tables[0] ?? '').toLocaleLowerCase(),
    );
    if (!table) return { kind: 'none' };
    const primaryKeyColumns = table.columns.filter((candidate) => candidate.primaryKey);
    if (primaryKeyColumns.length === 0) return { kind: 'none' };
    const primaryKey: SqlUpdatePrimaryKey[] = [];
    for (const pkColumn of primaryKeyColumns) {
      const value = row[pkColumn.name];
      if (value === undefined || value === null) return { kind: 'none' };
      primaryKey.push({ column: pkColumn.name, value });
    }
    return { kind: 'edit', table: table.name, originalValue: row[column], primaryKey };
  }

  private renderValueView(
    presentation: SqlCellPresentation,
    detectedLanguage?: string,
  ): HTMLElement {
    this.valueEdit.classList.add('hidden');
    this.valueContent.classList.remove('hidden');
    const modes = sqlValueModesForKind(presentation.kind, detectedLanguage);
    const buttons = modes.map((mode, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'sql-value-mode';
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-controls', 'sql-value-content');
      button.setAttribute('aria-selected', String(index === 0));
      button.tabIndex = index === 0 ? 0 : -1;
      button.textContent = mode.label;
      button.addEventListener('click', () => {
        for (const candidate of buttons) {
          const selected = candidate === button;
          candidate.setAttribute('aria-selected', String(selected));
          candidate.tabIndex = selected ? 0 : -1;
        }
        this.valueMode = mode.id;
        this.renderValueMode(presentation, mode.id, detectedLanguage);
        if (this.valueFindOpen) this.scheduleValueFind();
      });
      return button;
    });
    this.valueModes.classList.remove('hidden');
    this.valueModes.replaceChildren(...buttons);
    this.valueMode = modes[0]?.id ?? 'raw';
    this.renderValueMode(presentation, modes[0]?.id ?? 'raw', detectedLanguage);
    return buttons[0] ?? this.valueClose;
  }

  private applyValuePanelForView(kind: 'view' | 'multi'): void {
    this.valueDialog.dataset.mode = kind;
    this.valueSqlPanel.classList.toggle('hidden', kind !== 'multi');
    this.valueSqlResizer.classList.add('hidden');
    this.valueSqlBody.classList.add('hidden');
    this.valueSqlNotice.classList.toggle('hidden', kind !== 'multi');
  }

  private renderValueEdit(presentation: SqlCellPresentation): void {
    this.valueDialog.dataset.mode = 'edit';
    this.valueKind.textContent = 'Edit';
    this.valueModes.classList.add('hidden');
    this.valueContent.classList.add('hidden');
    this.valueEdit.classList.remove('hidden');
    this.valueEditInput.value = presentation.raw;
    this.valueSqlPanel.classList.remove('hidden');
    this.valueSqlResizer.classList.remove('hidden');
    this.valueSqlBody.classList.remove('hidden');
    this.valueSqlNotice.classList.add('hidden');
    this.valueSqlExecuting = false;
    this.valueSqlExecuted = false;
    this.valueSqlOriginalText = presentation.raw;
    this.valueSqlStatus.textContent = '';
    delete this.valueSqlStatus.dataset.error;
    delete this.valueSqlStatus.dataset.success;
    this.resetUpdateSqlCopyFeedback();
    this.refreshUpdateSql();
  }

  private currentUpdateSql(): string | undefined {
    const context = this.valueEditContext;
    if (!context) return undefined;
    return buildUpdateStatement({
      table: context.table,
      column: context.column,
      originalValue: context.originalValue,
      editedText: this.valueEditInput.value,
      primaryKey: context.primaryKey,
    });
  }

  private refreshUpdateSql(): void {
    if (!this.valueEditContext) return;
    this.valueSqlExecuted = false;
    const sql = this.currentUpdateSql();
    if (sql !== undefined) this.valueSqlCode.innerHTML = highlightUpdateSql(sql);
    this.updateSqlExecuteButton();
  }

  private updateSqlExecuteButton(): void {
    if (!this.valueEditContext) return;
    if (this.valueSqlExecuting) {
      this.valueSqlExecute.disabled = true;
      this.clearSqlExecuteHint();
      return;
    }
    const dirty = this.valueEditInput.value !== this.valueSqlOriginalText;
    if (!dirty) {
      this.valueSqlExecute.disabled = true;
      this.valueSqlExecute.dataset.hint = 'No changes to execute.';
      return;
    }
    if (this.valueSqlExecuted) {
      this.valueSqlExecute.disabled = true;
      this.valueSqlExecute.dataset.hint = 'Changes applied successfully.';
      return;
    }
    this.valueSqlExecute.disabled = false;
    this.clearSqlExecuteHint();
  }

  private clearSqlExecuteHint(): void {
    delete this.valueSqlExecute.dataset.hint;
  }

  private setUpdateSqlCopyIcon(copied: boolean): void {
    this.valueSqlCopy.innerHTML = copied
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M20 6L9 17l-5-5"></path></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
  }

  private resetUpdateSqlCopyFeedback(): void {
    this.setUpdateSqlCopyIcon(false);
    delete this.valueSqlCopy.dataset.copied;
    this.valueSqlCopy.setAttribute('aria-label', 'Copy SQL');
    this.valueSqlCopy.title = 'Copy SQL';
  }

  private async copyUpdateSql(): Promise<void> {
    if (!this.valueEditContext) return;
    const sql = this.currentUpdateSql();
    if (!sql || this.valueSqlCopy.disabled) return;
    this.valueSqlCopy.disabled = true;
    try {
      await window.serviceApi.writeClipboardText(sql);
      this.valueSqlCopy.dataset.copied = 'true';
      this.setUpdateSqlCopyIcon(true);
      this.valueSqlCopy.setAttribute('aria-label', 'Copied');
      this.valueSqlCopy.title = 'Copied';
      if (this.valueSqlCopyResetTimer !== undefined) window.clearTimeout(this.valueSqlCopyResetTimer);
      this.valueSqlCopyResetTimer = window.setTimeout(() => {
        this.valueSqlCopyResetTimer = undefined;
        if (this.valueEditContext) this.resetUpdateSqlCopyFeedback();
      }, 1_200);
    } catch (error) {
      toast(`Unable to copy SQL: ${toErrorMessage(error)}`, 'error');
    } finally {
      this.valueSqlCopy.disabled = false;
    }
  }

  private async executeUpdateSql(): Promise<void> {
    if (!this.valueEditContext || this.valueSqlExecuting || this.valueSqlExecute.disabled) return;
    const sql = this.currentUpdateSql();
    if (!sql) return;
    const environment = this.environment;
    this.valueSqlExecuting = true;
    this.valueSqlStatus.textContent = 'Executing…';
    delete this.valueSqlStatus.dataset.error;
    delete this.valueSqlStatus.dataset.success;
    this.updateSqlExecuteButton();
    try {
      await window.sqlApi.execute(environment, sql);
      this.valueSqlExecuted = true;
      this.valueSqlStatus.textContent = 'Updated successfully';
      this.valueSqlStatus.dataset.success = 'true';
      delete this.valueSqlStatus.dataset.error;
    } catch (error) {
      this.valueSqlStatus.textContent = toErrorMessage(error);
      this.valueSqlStatus.dataset.error = 'true';
      delete this.valueSqlStatus.dataset.success;
    } finally {
      this.valueSqlExecuting = false;
      this.updateSqlExecuteButton();
    }
  }

  private bindValueSqlResizer(): void {
    this.valueSqlResizer.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      this.valueSqlPointerId = event.pointerId;
      this.valueSqlResizer.setPointerCapture(event.pointerId);
      this.valueDialog.dataset.resizing = 'sql';
      event.preventDefault();
    });
    this.valueSqlResizer.addEventListener('pointermove', (event) => {
      if (this.valueSqlPointerId !== event.pointerId) return;
      const dialogBottom = this.valueDialog.getBoundingClientRect().bottom;
      this.applyValueSqlHeight(dialogBottom - event.clientY);
    });
    const stop = (event: PointerEvent): void => {
      if (this.valueSqlPointerId !== event.pointerId) return;
      this.valueSqlPointerId = undefined;
      delete this.valueDialog.dataset.resizing;
    };
    this.valueSqlResizer.addEventListener('pointerup', stop);
    this.valueSqlResizer.addEventListener('pointercancel', stop);
    this.valueSqlResizer.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
      event.preventDefault();
      const delta = event.key === 'ArrowUp' ? 24 : -24;
      this.applyValueSqlHeight(this.valueSqlPanelHeight() + delta);
    });
  }

  private valueSqlPanelHeight(): number {
    return Number.parseFloat(getComputedStyle(this.valueSqlPanel).getPropertyValue('--sql-value-sql-height'))
      || 160;
  }

  private applyValueSqlHeight(value: number): void {
    const maxHeight = this.valueDialog.getBoundingClientRect().height * 0.8;
    const height = Math.round(Math.min(maxHeight, Math.max(64, value)));
    this.valueSqlPanel.style.setProperty('--sql-value-sql-height', `${height}px`);
  }

  private renderValueMode(
    presentation: SqlCellPresentation,
    mode: SqlValueModeId,
    detectedLanguage?: string,
  ): void {
    this.clearValueContent();
    if (mode === 'preview' && presentation.kind === 'html') {
      this.valueKind.textContent = 'HTML';
      const frame = document.createElement('iframe');
      frame.className = 'sql-value-html-frame';
      frame.title = 'Rendered HTML cell value';
      frame.setAttribute('sandbox', '');
      frame.referrerPolicy = 'no-referrer';
      frame.tabIndex = -1;
      frame.srcdoc = sandboxedHtmlDocument(presentation.raw);
      this.valueContent.replaceChildren(frame);
      return;
    }

    if (mode === 'formatted' && presentation.kind === 'json') {
      this.valueKind.textContent = 'JSON';
      const bounded = boundedSqlValue(presentation.formatted ?? presentation.raw);
      const host = document.createElement('div');
      host.className = 'sql-value-json-editor';
      if (bounded.truncated) {
        const notice = document.createElement('div');
        notice.className = 'sql-value-truncated';
        notice.textContent = `Preview limited to ${SQL_VALUE_PREVIEW_CHARACTERS.toLocaleString()} characters.`;
        const wrapper = document.createElement('div');
        wrapper.className = 'sql-value-code-wrap';
        wrapper.append(notice, host);
        this.valueContent.append(wrapper);
      } else {
        this.valueContent.append(host);
      }
      this.valueEditor = new EditorView({
        state: EditorState.create({
          doc: bounded.text,
          extensions: [
            basicSetup,
            json(),
            sqlValueFindDecorationField,
            EditorState.readOnly.of(true),
            EditorView.editable.of(false),
            EditorView.contentAttributes.of({
              'aria-label': 'Formatted JSON cell value',
              'aria-readonly': 'true',
              spellcheck: 'false',
            }),
          ],
        }),
        parent: host,
      });
      return;
    }

    const source = presentation.kind === 'json' && presentation.formatted !== undefined
      ? presentation.formatted
      : presentation.raw;
    const language = mode === 'highlighted'
      ? detectedLanguage
      : presentation.kind === 'json'
        ? 'json'
        : presentation.kind === 'html'
          ? 'xml'
          : undefined;
    const highlighted = highlightedSqlValue(source, language, false);
    this.valueKind.textContent = presentation.kind === 'json'
      ? 'JSON'
      : presentation.kind === 'html'
        ? 'HTML'
        : sqlHighlightLabel(detectedLanguage);
    this.valueContent.replaceChildren(highlighted.node);
  }

  private handleValueDialogSelectAll(event: KeyboardEvent): void {
    const modifier = event.metaKey || event.ctrlKey;
    if (!this.valueDialog.open
      || !modifier
      || event.altKey
      || event.shiftKey
      || event.isComposing
      || event.key.toLocaleLowerCase() !== 'a') return;

    if (document.activeElement === this.valueFindInput) return;

    if (this.valueEditor) {
      const selection = this.valueEditor.state.selection;
      const documentLength = this.valueEditor.state.doc.length;
      if (documentLength === 0 || selection.ranges.length !== 1) return;
      const range = selection.main;
      const alreadySelected = range.from === 0 && range.to === documentLength;
      if (alreadySelected) {
        event.stopPropagation();
        if (!event.repeat) return;
        event.preventDefault();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      this.valueEditor.focus();
      this.valueEditor.dispatch({
        selection: { anchor: 0, head: documentLength },
        scrollIntoView: true,
      });
      return;
    }

    const code = this.valueContent.querySelector<HTMLElement>('.sql-value-code > code');
    if (!code || !code.textContent) return;
    const selected = window.getSelection();
    if (!selected) return;
    const contentRange = document.createRange();
    contentRange.selectNodeContents(code);
    const selectedRange = selected.rangeCount === 1 ? selected.getRangeAt(0) : undefined;
    const alreadySelected = selectedRange !== undefined
      && selectedRange.compareBoundaryPoints(Range.START_TO_START, contentRange) === 0
      && selectedRange.compareBoundaryPoints(Range.END_TO_END, contentRange) === 0;
    if (alreadySelected) {
      event.stopPropagation();
      if (!event.repeat) return;
      event.preventDefault();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    code.parentElement?.focus({ preventScroll: true });
    selected.removeAllRanges();
    selected.addRange(contentRange);
  }

  private handleValueDialogFindShortcut(event: KeyboardEvent): void {
    if (!this.valueDialog.open || event.isComposing || this.valueEditContext) return;
    const modifier = event.metaKey || event.ctrlKey;
    if (modifier && !event.altKey && !event.shiftKey
      && event.key.toLocaleLowerCase() === 'f') {
      event.preventDefault();
      event.stopPropagation();
      this.openValueFind();
      return;
    }
    if (event.key === 'F3') {
      event.preventDefault();
      event.stopPropagation();
      if (this.valueFindOpen) {
        this.moveValueFind(event.shiftKey ? -1 : 1);
      } else {
        this.openValueFind();
      }
      return;
    }
    if (event.key === 'Escape' && this.valueFindOpen) {
      event.preventDefault();
      event.stopPropagation();
      this.valueFindEscapeGuard = true;
      this.closeValueFind();
    }
  }

  private openValueFind(): void {
    if (!this.valueDialog.open || this.valueEditContext) return;
    this.valueFindOpen = true;
    this.valueFindBar.classList.remove('hidden');
    this.valueFindBar.setAttribute('aria-hidden', 'false');
    this.valueFindInput.focus({ preventScroll: true });
    this.valueFindInput.select();
    window.requestAnimationFrame(() => {
      if (this.valueFindOpen && this.valueDialog.open) {
        this.valueFindInput.focus({ preventScroll: true });
        this.valueFindInput.select();
      }
    });
    this.refreshValueFind(false);
  }

  private scheduleValueFind(): void {
    if (!this.valueFindOpen || this.valueFindFrame !== undefined) return;
    this.valueFindFrame = window.requestAnimationFrame(() => {
      this.valueFindFrame = undefined;
      this.refreshValueFind(true);
    });
  }

  private refreshValueFind(reveal: boolean): void {
    if (!this.valueFindOpen) return;
    const anchor = this.valueFindActiveIndex >= 0
      ? (this.valueFindMatches[this.valueFindActiveIndex]?.from ?? 0)
      : 0;
    const result = findNotesTextMatches(this.currentValueFindText(), this.valueFindInput.value);
    this.valueFindMatches = result.matches;
    this.valueFindTruncated = result.truncated;
    this.valueFindActiveIndex = initialNotesFindIndex(this.valueFindMatches, anchor);
    this.applyValueFindHighlights();
    this.updateValueFindControls();
    if (reveal) this.revealValueFindMatch();
  }

  private currentValueFindText(): string {
    if (this.valueEditor) return this.valueEditor.state.doc.toString();
    const code = this.valueContent.querySelector<HTMLElement>('.sql-value-code > code');
    if (code?.textContent) return code.textContent;
    if (this.valueMode === 'preview') return this.valueRaw;
    return '';
  }

  private applyValueFindHighlights(): void {
    if (this.valueEditor) {
      this.applyValueEditorFindHighlights();
      return;
    }
    const code = this.valueContent.querySelector<HTMLElement>('.sql-value-code > code');
    if (!code) return;
    const text = code.textContent ?? '';
    const fragment = document.createDocumentFragment();
    let cursor = 0;
    for (const [index, match] of this.valueFindMatches.entries()) {
      if (match.from < cursor || match.from > text.length || match.to > text.length) continue;
      if (match.from > cursor) fragment.append(text.slice(cursor, match.from));
      const mark = document.createElement('mark');
      mark.className = index === this.valueFindActiveIndex
        ? 'sql-value-find-match-active'
        : 'sql-value-find-match';
      mark.textContent = text.slice(match.from, match.to);
      fragment.append(mark);
      cursor = match.to;
    }
    if (cursor < text.length) fragment.append(text.slice(cursor));
    code.replaceChildren(fragment);
  }

  private applyValueEditorFindHighlights(): void {
    const editor = this.valueEditor;
    if (!editor) return;
    const decorations = this.valueFindMatches.map((match, index) =>
      Decoration.mark({
        class: index === this.valueFindActiveIndex
          ? 'sql-value-find-match-active'
          : 'sql-value-find-match',
      }).range(match.from, match.to),
    );
    editor.dispatch({
      effects: SQL_VALUE_FIND_DECORATION.of(Decoration.set(decorations, true)),
    });
  }

  private moveValueFind(direction: 1 | -1): void {
    if (!this.valueFindOpen) return;
    this.valueFindActiveIndex = moveNotesFindIndex(
      this.valueFindActiveIndex,
      this.valueFindMatches.length,
      direction,
    );
    this.applyValueFindHighlights();
    this.updateValueFindControls();
    this.revealValueFindMatch();
    this.valueFindInput.focus({ preventScroll: true });
  }

  private revealValueFindMatch(): void {
    const match = this.valueFindMatches[this.valueFindActiveIndex];
    if (!match) return;
    if (this.valueEditor) {
      this.valueEditor.dispatch({
        effects: EditorView.scrollIntoView(match.from, { y: 'center' }),
      });
      return;
    }
    const active = this.valueContent.querySelector<HTMLElement>('.sql-value-find-match-active');
    const container = this.valueContent.querySelector<HTMLElement>('.sql-value-code');
    if (!active || !container) return;
    const containerRect = container.getBoundingClientRect();
    const activeRect = active.getBoundingClientRect();
    if (activeRect.top < containerRect.top + 16 || activeRect.bottom > containerRect.bottom - 16) {
      container.scrollTop += activeRect.top - containerRect.top - 24;
    }
    if (activeRect.left < containerRect.left + 8 || activeRect.right > containerRect.right - 8) {
      container.scrollLeft += activeRect.left - containerRect.left - 24;
    }
  }

  private updateValueFindControls(): void {
    const count = this.valueFindMatches.length;
    const current = this.valueFindActiveIndex >= 0 ? this.valueFindActiveIndex + 1 : 0;
    const total = `${count.toLocaleString('en-US')}${this.valueFindTruncated ? '+' : ''}`;
    this.valueFindCounter.textContent = `${current.toLocaleString('en-US')} / ${total}`;
    this.valueFindCounter.setAttribute(
      'aria-label',
      count > 0
        ? `${current.toLocaleString('en-US')} of ${total} matches`
        : 'No matches',
    );
    this.valueFindPrevious.disabled = count === 0;
    this.valueFindNext.disabled = count === 0;
    this.valueFindBar.dataset.noResults = String(Boolean(this.valueFindInput.value) && count === 0);
  }

  private closeValueFind(): void {
    if (!this.valueFindOpen) return;
    this.valueFindOpen = false;
    if (this.valueFindFrame !== undefined) {
      window.cancelAnimationFrame(this.valueFindFrame);
      this.valueFindFrame = undefined;
    }
    this.valueFindInput.value = '';
    this.valueFindInput.blur();
    if (this.valuePresentation) {
      this.renderValueMode(this.valuePresentation, this.valueMode, this.valueDetectedLanguage);
    }
    this.resetValueFindControls();
  }

  private resetValueFind(): void {
    this.valueFindEscapeGuard = false;
    this.valueFindOpen = false;
    this.valueFindMatches = [];
    this.valueFindActiveIndex = -1;
    this.valueFindTruncated = false;
    if (this.valueFindFrame !== undefined) {
      window.cancelAnimationFrame(this.valueFindFrame);
      this.valueFindFrame = undefined;
    }
    this.valueFindInput.value = '';
    this.resetValueFindControls();
    this.valuePresentation = undefined;
    this.valueMode = 'raw';
    this.valueDetectedLanguage = undefined;
  }

  private resetValueFindControls(): void {
    this.valueFindBar.classList.add('hidden');
    this.valueFindBar.setAttribute('aria-hidden', 'true');
    this.valueFindCounter.textContent = '0 / 0';
    this.valueFindCounter.setAttribute('aria-label', 'No matches');
    this.valueFindPrevious.disabled = true;
    this.valueFindNext.disabled = true;
    delete this.valueFindBar.dataset.noResults;
  }

  private closeValueDialog(): void {
    if (this.valueDialog.open) {
      this.valueDialog.close();
    } else {
      this.clearValueDialog();
    }
  }

  private async copyRawValue(): Promise<void> {
    if (!this.valueDialog.open || this.valueCopyRaw.disabled) return;
    const generation = this.valueDialogGeneration;
    const text = this.valueFormatted ?? this.valueRaw;
    this.valueCopyRaw.disabled = true;
    try {
      await window.serviceApi.writeClipboardText(text);
      if (generation !== this.valueDialogGeneration || !this.valueDialog.open) return;
      this.valueCopyRaw.dataset.copied = 'true';
      const copiedLabel = this.valueFormatted !== undefined ? 'Formatted value copied' : 'Raw value copied';
      this.valueCopyRaw.setAttribute('aria-label', copiedLabel);
      this.valueCopyRaw.title = copiedLabel;
      if (this.valueCopyResetTimer !== undefined) window.clearTimeout(this.valueCopyResetTimer);
      this.valueCopyResetTimer = window.setTimeout(() => {
        this.valueCopyResetTimer = undefined;
        if (generation === this.valueDialogGeneration) this.resetRawCopyFeedback();
      }, 1_200);
    } catch (error) {
      if (generation === this.valueDialogGeneration) {
        toast(`Unable to copy raw value: ${toErrorMessage(error)}`, 'error');
      }
    } finally {
      if (generation === this.valueDialogGeneration && this.valueDialog.open) {
        this.valueCopyRaw.disabled = false;
      }
    }
  }

  private resetRawCopyFeedback(): void {
    delete this.valueCopyRaw.dataset.copied;
    const column = this.valueDialogTitle.textContent?.trim();
    const verb = this.valueFormatted !== undefined ? 'formatted' : 'raw';
    const label = column && column !== 'Cell value'
      ? `Copy ${verb} ${column} value`
      : `Copy ${verb} cell value`;
    this.valueCopyRaw.setAttribute('aria-label', label);
    this.valueCopyRaw.title = label;
  }

  private clearValueDialog(): void {
    this.valueDialogGeneration += 1;
    this.valueRaw = '';
    this.valueFormatted = undefined;
    this.valueEditContext = undefined;
    this.valueSqlExecuting = false;
    this.valueSqlExecuted = false;
    this.valueSqlOriginalText = '';
    this.valueSqlExecute.disabled = false;
    this.clearSqlExecuteHint();
    this.valueSqlStatus.textContent = '';
    delete this.valueSqlStatus.dataset.error;
    delete this.valueSqlStatus.dataset.success;
    this.resetValueFind();
    if (this.valueCopyResetTimer !== undefined) {
      window.clearTimeout(this.valueCopyResetTimer);
      this.valueCopyResetTimer = undefined;
    }
    if (this.valueSqlCopyResetTimer !== undefined) {
      window.clearTimeout(this.valueSqlCopyResetTimer);
      this.valueSqlCopyResetTimer = undefined;
    }
    this.clearValueContent();
    this.valueModes.replaceChildren();
    this.valueModes.classList.add('hidden');
    this.valueKind.textContent = 'Text';
    this.valueDialogTitle.textContent = 'Cell value';
    this.valueCopyRaw.disabled = true;
    this.resetRawCopyFeedback();
    this.valueEdit.classList.add('hidden');
    this.valueEditInput.value = '';
    this.valueSqlPanel.classList.add('hidden');
    this.valueSqlResizer.classList.add('hidden');
    this.valueSqlBody.classList.add('hidden');
    this.valueSqlNotice.classList.add('hidden');
    this.valueContent.classList.remove('hidden');
    delete this.valueDialog.dataset.mode;
  }

  private clearValueContent(): void {
    this.valueEditor?.destroy();
    this.valueEditor = undefined;
    const frame = this.valueContent.querySelector<HTMLIFrameElement>('iframe');
    if (frame) frame.srcdoc = '';
    this.valueContent.replaceChildren();
  }

  private handleOperationError(
    error: unknown,
    showToast = true,
    environment: SqlEnvironment = this.environment,
  ): void {
    const message = toErrorMessage(error);
    if (/sign in again|sign in to .* first|session expired/i.test(message)) {
      const state = this.states[environment];
      state.auth = {
        environment,
        status: 'signed-out',
        hasSavedCredentials: true,
        message,
      };
      if (environment === this.environment) this.renderSignedOut(message);
    }
    if (showToast) toast(message, 'error');
  }

  private bindSidebarResizer(): void {
    this.sidebarResizer.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || this.sidebarCollapsed) return;
      this.sidebarPointerId = event.pointerId;
      this.sidebarResizer.setPointerCapture(event.pointerId);
      this.page.dataset.resizing = 'sidebar';
      event.preventDefault();
    });
    this.sidebarResizer.addEventListener('pointermove', (event) => {
      if (this.sidebarPointerId !== event.pointerId) return;
      const left = this.workspace.getBoundingClientRect().left;
      this.applySidebarWidth(clampSqlSidebarWidth(event.clientX - left));
    });
    const stop = (event: PointerEvent): void => {
      if (this.sidebarPointerId !== event.pointerId) return;
      this.sidebarPointerId = undefined;
      delete this.page.dataset.resizing;
      writeStoredValue(SIDEBAR_WIDTH_KEY, String(this.sidebarWidth()));
    };
    this.sidebarResizer.addEventListener('pointerup', stop);
    this.sidebarResizer.addEventListener('pointercancel', stop);
    this.sidebarResizer.addEventListener('keydown', (event) => {
      if (this.sidebarCollapsed) return;
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      const delta = event.key === 'ArrowLeft' ? -8 : 8;
      this.applySidebarWidth(clampSqlSidebarWidth(this.sidebarWidth() + delta));
      writeStoredValue(SIDEBAR_WIDTH_KEY, String(this.sidebarWidth()));
    });
  }

  private bindResultResizer(): void {
    this.resultResizer.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      this.resultPointerId = event.pointerId;
      this.resultResizer.setPointerCapture(event.pointerId);
      this.page.dataset.resizing = 'result';
      event.preventDefault();
    });
    this.resultResizer.addEventListener('pointermove', (event) => {
      if (this.resultPointerId !== event.pointerId) return;
      const editorTop = this.editorHost.getBoundingClientRect().top;
      this.applyEditorHeight(event.clientY - editorTop);
    });
    const stop = (event: PointerEvent): void => {
      if (this.resultPointerId !== event.pointerId) return;
      this.resultPointerId = undefined;
      delete this.page.dataset.resizing;
      writeStoredValue(EDITOR_HEIGHT_KEY, String(this.editorHeight()));
    };
    this.resultResizer.addEventListener('pointerup', stop);
    this.resultResizer.addEventListener('pointercancel', stop);
    this.resultResizer.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
      event.preventDefault();
      const delta = event.key === 'ArrowUp' ? -12 : 12;
      this.applyEditorHeight(this.editorHeight() + delta);
      writeStoredValue(EDITOR_HEIGHT_KEY, String(this.editorHeight()));
    });
  }

  private sidebarWidth(): number {
    return Number.parseFloat(getComputedStyle(this.page).getPropertyValue('--sql-sidebar-width'))
      || DEFAULT_SIDEBAR_WIDTH;
  }

  private applySidebarWidth(value: number): void {
    const width = clampSqlSidebarWidth(value);
    this.page.style.setProperty('--sql-sidebar-width', `${width}px`);
    this.sidebarResizer.setAttribute('aria-valuenow', String(width));
  }

  private toggleSidebarCollapse(): void {
    this.sidebarCollapsed = !this.sidebarCollapsed;
    this.page.dataset.sidebarCollapsed = String(this.sidebarCollapsed);
    this.collapseButton.setAttribute('aria-expanded', String(!this.sidebarCollapsed));
    const label = this.sidebarCollapsed ? 'Expand saved queries' : 'Collapse saved queries';
    this.collapseButton.setAttribute('aria-label', label);
    this.collapseButton.title = label;
  }

  private editorHeight(): number {
    return Number.parseFloat(getComputedStyle(this.page).getPropertyValue('--sql-editor-height'))
      || DEFAULT_EDITOR_HEIGHT;
  }

  private applyEditorHeight(value: number): void {
    const measuredAvailable = this.queryWorkspace.clientHeight - 45 - 6 - MIN_RESULTS_HEIGHT;
    const available = measuredAvailable > MIN_EDITOR_HEIGHT
      ? measuredAvailable
      : Math.max(MIN_EDITOR_HEIGHT, value);
    const height = Math.round(Math.min(available, Math.max(MIN_EDITOR_HEIGHT, value)));
    this.page.style.setProperty('--sql-editor-height', `${height}px`);
    this.resultResizer.setAttribute('aria-valuenow', String(height));
    this.editor.requestMeasure();
  }

  private editorFontSize(): number {
    return Number.parseFloat(getComputedStyle(this.page).getPropertyValue('--sql-editor-font-size'))
      || DEFAULT_EDITOR_FONT_SIZE;
  }

  private adjustEditorFontSize(delta: -1 | 1): void {
    const next = clampSqlEditorFontSize(this.editorFontSize() + delta);
    this.applyEditorFontSize(next);
    writeStoredValue(EDITOR_FONT_SIZE_KEY, String(next));
  }

  private applyEditorFontSize(value: number): void {
    const fontSize = clampSqlEditorFontSize(value);
    const renderedFontSize = Number((fontSize * 0.8888889).toFixed(1));
    this.page.style.setProperty('--sql-editor-font-size', `${fontSize}px`);
    this.valueDialog.style.setProperty('--sql-editor-font-size', `${fontSize}px`);
    this.decreaseFontSizeButton.disabled = fontSize <= MIN_EDITOR_FONT_SIZE;
    this.increaseFontSizeButton.disabled = fontSize >= MAX_EDITOR_FONT_SIZE;
    this.decreaseFontSizeButton.title = `Decrease SQL editor font size (currently ${renderedFontSize}px)`;
    this.increaseFontSizeButton.title = `Increase SQL editor font size (currently ${renderedFontSize}px)`;
    this.editor.requestMeasure();
  }

  private applyEditorFontFamily(value: unknown): void {
    const fontFamily = normalizeSqlEditorFontFamily(value);
    this.page.dataset.editorFont = fontFamily;
    const comic = fontFamily === 'comic-mono';
    const actionLabel = comic ? 'Use Default font' : 'Use Comic font';
    this.fontFamilySwitch.setAttribute('aria-checked', String(comic));
    this.fontFamilySwitch.setAttribute('aria-label', actionLabel);
    this.fontFamilySwitch.title = actionLabel;
    this.editor.requestMeasure();
  }
}

let sqlPage: SqlPage | undefined;

export function registerSqlPage(): void {
  sqlPage ??= new SqlPage();
  registerPage({
    id: 'sql',
    title: 'SQL',
    icon: SQL_NAV_ICON,
    onShow: () => sqlPage?.show(),
    onHide: () => sqlPage?.hide(),
  });
}
