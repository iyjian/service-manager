import type {
  Note,
  NoteDeletePreview,
  NoteDraft,
  NoteDraftRecoveryInput,
  NoteImageReference,
  NoteLanguage,
  NotesTreeNode,
  NotesWorkspaceSnapshot,
} from '../shared/types';
import { basicSetup, EditorView } from 'codemirror';
import { javascript, javascriptLanguage, typescriptLanguage } from '@codemirror/lang-javascript';
import { json, jsonLanguage } from '@codemirror/lang-json';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { yaml, yamlLanguage } from '@codemirror/lang-yaml';
import {
  defaultHighlightStyle,
  HighlightStyle,
  StreamLanguage,
  syntaxHighlighting,
  type Language,
  type TagStyle,
} from '@codemirror/language';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { standardSQL } from '@codemirror/legacy-modes/mode/sql';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import {
  EMPTY_RICH_TEXT_CONTENT,
  extractRichTextPlainText,
  normalizeRichTextContent,
  parseRichTextContent,
} from './noteRichText.js';
import { registerPage } from './nav.js';
import { NotesRichTextEditor } from './notesRichTextEditor.js';

const NOTE_SAVE_DEBOUNCE_MS = 250;
const NOTE_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_NOTES_SIDEBAR_WIDTH = 280;
const MIN_NOTES_SIDEBAR_WIDTH = 240;
const MAX_NOTES_SIDEBAR_WIDTH = 520;
const NOTES_SIDEBAR_KEYBOARD_STEP = 8;
const NOTES_SIDEBAR_KEYBOARD_SAVE_DEBOUNCE_MS = 180;

export function clampNotesSidebarWidth(value: number): number {
  const rounded = Number.isFinite(value) ? Math.round(value) : DEFAULT_NOTES_SIDEBAR_WIDTH;
  return Math.min(MAX_NOTES_SIDEBAR_WIDTH, Math.max(MIN_NOTES_SIDEBAR_WIDTH, rounded));
}

const bashLanguage = StreamLanguage.define(shell);
const sqlLanguage = StreamLanguage.define(standardSQL);

const markdownFenceLanguages: Readonly<Record<string, Language>> = {
  bash: bashLanguage,
  javascript: javascriptLanguage,
  js: javascriptLanguage,
  json: jsonLanguage,
  node: javascriptLanguage,
  sh: bashLanguage,
  shell: bashLanguage,
  shellscript: bashLanguage,
  sql: sqlLanguage,
  ts: typescriptLanguage,
  typescript: typescriptLanguage,
  yaml: yamlLanguage,
  yml: yamlLanguage,
};

const noteLanguageExtensions: Readonly<Record<NoteLanguage, Extension>> = {
  markdown: markdown({
    base: markdownLanguage,
    codeLanguages: (info) => markdownFenceLanguages[info.trim().split(/\s+/, 1)[0]?.toLocaleLowerCase() ?? ''] ?? null,
  }),
  richtext: [],
  bash: bashLanguage,
  javascript: javascript(),
  typescript: javascript({ typescript: true }),
  sql: sqlLanguage,
  json: json(),
  yaml: yaml(),
  text: [],
};

const darkSyntaxColors: Readonly<Record<string, string>> = {
  '#404740': '#94a3b8',
  '#708': '#c084fc',
  '#219': '#93c5fd',
  '#164': '#86efac',
  '#a11': '#fca5a5',
  '#e40': '#fb923c',
  '#00f': '#60a5fa',
  '#30a': '#a78bfa',
  '#085': '#5eead4',
  '#167': '#67e8f9',
  '#256': '#f0abfc',
  '#00c': '#38bdf8',
  '#940': '#a1a1aa',
  '#f00': '#f87171',
};

const darkHighlightStyle = HighlightStyle.define(
  defaultHighlightStyle.specs.map((spec): TagStyle => {
    const mappedColor = typeof spec.color === 'string' ? darkSyntaxColors[spec.color] : undefined;
    return mappedColor ? { ...spec, color: mappedColor } : { ...spec };
  }),
  { themeType: 'dark' },
);

const darkEditorTheme = EditorView.theme({
  '&': {
    backgroundColor: '#09090b',
    color: '#f4f4f5',
  },
}, { dark: true });

const lightHighlightStyle = HighlightStyle.define(defaultHighlightStyle.specs, { themeType: 'light' });
const lightEditorTheme = EditorView.theme({
  '&': {
    backgroundColor: '#ffffff',
    color: '#18181b',
  },
}, { dark: false });

function editorThemeExtensions(theme: 'light' | 'dark'): Extension[] {
  return theme === 'dark'
    ? [darkEditorTheme, syntaxHighlighting(darkHighlightStyle)]
    : [lightEditorTheme, syntaxHighlighting(lightHighlightStyle)];
}

/** Returns parser-backed CodeMirror support for the selected Notes language. */
export function noteLanguageExtension(language: NoteLanguage): Extension {
  return noteLanguageExtensions[language];
}

const NOTES_NAV_ICON = `
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M4 2.5h6l2 2v9H4z"></path>
    <path d="M10 2.5v2h2"></path>
    <path d="M6 7h4M6 9.5h4M6 12h2.5"></path>
  </svg>
`;

interface RankedNote {
  note: Note;
  score: number;
  index: number;
}

function timestampValue(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function noteSearchScore(note: Note, query: string): number {
  const name = note.name.trim().toLocaleLowerCase();
  if (name === query) return 1_000;
  if (name.startsWith(query)) return 900;
  if (name.includes(query)) return 800;

  const tags = note.tags.map((tag) => tag.toLocaleLowerCase());
  if (tags.some((tag) => tag === query)) return 600;
  if (tags.some((tag) => tag.includes(query))) return 500;

  const language = note.language.toLocaleLowerCase();
  if (language === query) return 400;
  if (language.includes(query)) return 350;

  return searchableNoteContent(note).toLocaleLowerCase().includes(query) ? 200 : 0;
}

const richTextPlainTextCache = new WeakMap<Note, { content: string; text: string }>();

function searchableNoteContent(note: Note): string {
  if (note.language !== 'richtext') return note.content;
  const cached = richTextPlainTextCache.get(note);
  if (cached?.content === note.content) return cached.text;
  let text = '';
  try {
    text = extractRichTextPlainText(note.content);
  } catch {
    // Main-process validation normally prevents this. A damaged note remains
    // visible by name and metadata without letting search parse arbitrary HTML.
  }
  richTextPlainTextCache.set(note, { content: note.content, text });
  return text;
}

/** Converts plain note text into safe, canonical Tiptap JSON. */
export function plainTextToRichTextContent(value: string): string {
  if (!value) return EMPTY_RICH_TEXT_CONTENT;
  const inlineContent: Array<{ type: 'text'; text: string } | { type: 'hardBreak' }> = [];
  const lines = value.split('\n');
  lines.forEach((line, index) => {
    if (line) inlineContent.push({ type: 'text', text: line });
    if (index < lines.length - 1) inlineContent.push({ type: 'hardBreak' });
  });
  return normalizeRichTextContent({
    type: 'doc',
    content: [{
      type: 'paragraph',
      ...(inlineContent.length > 0 ? { content: inlineContent } : {}),
    }],
  });
}

function appendImageToRichTextContent(content: string, reference: NoteImageReference): string {
  const document = parseRichTextContent(content);
  return normalizeRichTextContent({
    ...document,
    content: [...(document.content ?? []), { type: 's3Image', attrs: reference }],
  });
}

function setMessage(text: string, level: 'default' | 'success' | 'error' = 'default'): void {
  window.dispatchEvent(new CustomEvent('service-manager:toast', { detail: { text, level } }));
}

/**
 * Returns a new array ranked by search relevance. Name matches always precede
 * tag, language, and content matches. An empty query shows the newest notes.
 */
export function rankNotes(notes: readonly Note[], query: string): Note[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const ranked: RankedNote[] = notes.map((note, index) => ({
    note,
    index,
    score: normalizedQuery ? noteSearchScore(note, normalizedQuery) : 1,
  }));

  return ranked
    .filter(({ score }) => score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      const updatedDifference = timestampValue(right.note.updatedAt) - timestampValue(left.note.updatedAt);
      return updatedDifference || left.index - right.index;
    })
    .map(({ note }) => note);
}

export function noteSaveIndicatorState(
  dirty: boolean,
  failed: boolean,
): 'saving' | 'error' | undefined {
  if (failed) return 'error';
  return dirty ? 'saving' : undefined;
}

export type NoteTreeDropPosition = 'before' | 'inside' | 'after';

export interface NoteTreeRow {
  note: Note;
  node: NotesTreeNode;
  depth: number;
}

export interface NoteTreePlacement {
  parentId: string | null;
  beforeNoteId?: string;
}

function compareTreeNodes(left: NotesTreeNode, right: NotesTreeNode): number {
  return left.order - right.order
    || (left.noteId < right.noteId ? -1 : left.noteId > right.noteId ? 1 : 0);
}

/** Builds stable sibling groups without changing the workspace snapshot. */
export function noteTreeChildren(nodes: readonly NotesTreeNode[]): Map<string | null, NotesTreeNode[]> {
  const groups = new Map<string | null, NotesTreeNode[]>();
  for (const node of nodes) {
    const children = groups.get(node.parentId) ?? [];
    children.push(node);
    groups.set(node.parentId, children);
  }
  for (const children of groups.values()) children.sort(compareTreeNodes);
  return groups;
}

/** Returns the visible pre-order tree while respecting device-local expansion state. */
export function visibleNoteTreeRows(
  notes: readonly Note[],
  nodes: readonly NotesTreeNode[],
  expandedNoteIds: ReadonlySet<string>,
): NoteTreeRow[] {
  const notesById = new Map(notes.map((note) => [note.id, note]));
  const children = noteTreeChildren(nodes);
  const visited = new Set<string>();
  const rows: NoteTreeRow[] = [];
  const append = (parentId: string | null, depth: number): void => {
    for (const node of children.get(parentId) ?? []) {
      if (visited.has(node.noteId)) continue;
      visited.add(node.noteId);
      const note = notesById.get(node.noteId);
      if (!note) continue;
      rows.push({ note, node, depth });
      if (expandedNoteIds.has(node.noteId)) append(node.noteId, depth + 1);
    }
  };
  append(null, 0);
  return rows;
}

/** Returns only ancestor names for compact global-search context. */
export function noteTreeBreadcrumb(
  noteId: string,
  notes: readonly Note[],
  nodes: readonly NotesTreeNode[],
): string {
  const nodesById = new Map(nodes.map((node) => [node.noteId, node]));
  const notesById = new Map(notes.map((note) => [note.id, note]));
  const names: string[] = [];
  const visited = new Set<string>([noteId]);
  let parentId = nodesById.get(noteId)?.parentId ?? null;
  while (parentId !== null && names.length < 32 && !visited.has(parentId)) {
    visited.add(parentId);
    names.unshift(notesById.get(parentId)?.name || 'Untitled');
    parentId = nodesById.get(parentId)?.parentId ?? null;
  }
  return names.join(' / ');
}

/** Returns a bounded deterministic subtree, including the requested root. */
export function noteTreeSubtreeIds(rootId: string, nodes: readonly NotesTreeNode[]): string[] {
  if (!nodes.some((node) => node.noteId === rootId)) return [];
  const children = noteTreeChildren(nodes);
  const result: string[] = [];
  const visited = new Set<string>();
  const append = (noteId: string): void => {
    if (visited.has(noteId)) return;
    visited.add(noteId);
    result.push(noteId);
    for (const child of children.get(noteId) ?? []) append(child.noteId);
  };
  append(rootId);
  return result;
}

/** Compares confirmed subtree membership without treating a harmless reorder as a change. */
export function sameNoteIdSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const ids = new Set(left);
  return ids.size === left.length && right.every((id) => ids.has(id));
}

/** Rejects self/descendant parents before a drag operation reaches IPC. */
export function isValidNoteTreeParent(
  nodes: readonly NotesTreeNode[],
  movingNoteId: string,
  parentId: string | null,
): boolean {
  const nodesById = new Map(nodes.map((node) => [node.noteId, node]));
  if (!nodesById.has(movingNoteId)) return false;
  if (parentId === null) return true;
  if (!nodesById.has(parentId)) return false;
  const visited = new Set<string>();
  let currentId: string | null = parentId;
  while (currentId !== null && !visited.has(currentId)) {
    if (currentId === movingNoteId) return false;
    visited.add(currentId);
    currentId = nodesById.get(currentId)?.parentId ?? null;
  }
  return true;
}

/** Resolves Notion-style before/inside/after placement or rejects an invalid descendant drop. */
export function resolveNoteTreeDropPlacement(
  nodes: readonly NotesTreeNode[],
  movingNoteId: string,
  targetNoteId: string,
  position: NoteTreeDropPosition,
): NoteTreePlacement | undefined {
  if (movingNoteId === targetNoteId) return undefined;
  const target = nodes.find((node) => node.noteId === targetNoteId);
  if (!target || !nodes.some((node) => node.noteId === movingNoteId)) return undefined;

  let placement: NoteTreePlacement;
  if (position === 'inside') {
    placement = { parentId: target.noteId };
  } else if (position === 'before') {
    placement = { parentId: target.parentId, beforeNoteId: target.noteId };
  } else {
    const siblings = (noteTreeChildren(nodes).get(target.parentId) ?? [])
      .filter((node) => node.noteId !== movingNoteId);
    const index = siblings.findIndex((node) => node.noteId === target.noteId);
    if (index < 0) return undefined;
    const next = siblings[index + 1];
    placement = { parentId: target.parentId, ...(next ? { beforeNoteId: next.noteId } : {}) };
  }
  return isValidNoteTreeParent(nodes, movingNoteId, placement.parentId) ? placement : undefined;
}

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing required element: ${selector}`);
  return element;
}

function toErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : String(error);
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
}

function cloneNote(note: Note): Note {
  return { ...note, tags: [...note.tags] };
}

function createRemoveIcon(): SVGSVGElement {
  const namespace = 'http://www.w3.org/2000/svg';
  const icon = document.createElementNS(namespace, 'svg');
  icon.setAttribute('viewBox', '0 0 16 16');
  icon.setAttribute('fill', 'none');
  icon.setAttribute('stroke', 'currentColor');
  icon.setAttribute('stroke-width', '1.5');
  icon.setAttribute('stroke-linecap', 'round');
  icon.setAttribute('stroke-linejoin', 'round');
  icon.setAttribute('aria-hidden', 'true');

  const lid = document.createElementNS(namespace, 'path');
  lid.setAttribute('d', 'M3.25 4.5h9.5M6 2.75h4M5 4.5l.5 8.25h5l.5-8.25');
  icon.appendChild(lid);
  return icon;
}

function createTreeIcon(pathData: string): SVGSVGElement {
  const namespace = 'http://www.w3.org/2000/svg';
  const icon = document.createElementNS(namespace, 'svg');
  icon.setAttribute('viewBox', '0 0 16 16');
  icon.setAttribute('fill', 'none');
  icon.setAttribute('stroke', 'currentColor');
  icon.setAttribute('stroke-width', '1.5');
  icon.setAttribute('stroke-linecap', 'round');
  icon.setAttribute('stroke-linejoin', 'round');
  icon.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(namespace, 'path');
  path.setAttribute('d', pathData);
  icon.appendChild(path);
  return icon;
}

class NotesPage {
  private readonly pageRoot = requireElement<HTMLElement>('.notes-page');
  private readonly sidebarResizeHandle = requireElement<HTMLElement>('#notes-sidebar-resizer');
  private readonly newButton = requireElement<HTMLButtonElement>('#notes-new-root-btn');
  private readonly searchInput = requireElement<HTMLInputElement>('#notes-search');
  private readonly list = requireElement<HTMLElement>('#notes-list');
  private readonly emptyState = requireElement<HTMLElement>('#notes-empty');
  private readonly editor = requireElement<HTMLElement>('#notes-editor');
  private readonly nameInput = requireElement<HTMLInputElement>('#note-name');
  private readonly languageSelect = requireElement<HTMLSelectElement>('#note-language');
  private readonly contentHost = requireElement<HTMLElement>('#note-content');
  private readonly codeContentHost = requireElement<HTMLElement>('#note-code-content');
  private readonly richTextShell = requireElement<HTMLElement>('#note-richtext-editor');
  private readonly richTextHost = requireElement<HTMLElement>('#note-richtext-content');
  private readonly richTextToolbar = requireElement<HTMLElement>('#note-richtext-toolbar');
  private readonly imageInput = requireElement<HTMLInputElement>('#note-richtext-image-input');
  private readonly copyButton = requireElement<HTMLButtonElement>('#note-copy-btn');
  private readonly copyLabel = requireElement<HTMLElement>('#note-copy-label');
  private readonly saveStatus = requireElement<HTMLElement>('#note-save-status');
  private readonly languageCompartment = new Compartment();
  private readonly themeCompartment = new Compartment();
  private readonly codeEditor: EditorView;
  private readonly richTextEditor: NotesRichTextEditor;

  private notes: Note[] = [];
  private treeNodes: NotesTreeNode[] = [];
  private expandedNoteIds = new Set<string>();
  private selectedId: string | undefined;
  private loaded = false;
  private loadPromise: Promise<void> | undefined;
  private loadError: string | undefined;
  private creating = false;
  private readonly editVersions = new Map<string, number>();
  private readonly persistedVersions = new Map<string, number>();
  private readonly queuedVersions = new Map<string, number>();
  private readonly saveTimers = new Map<string, number>();
  private readonly saveQueues = new Map<string, Promise<void>>();
  private readonly persistedNotes = new Map<string, Note>();
  private readonly deletedIds = new Set<string>();
  private readonly deletingNoteIds = new Set<string>();
  private readonly saveErrorNoteIds = new Set<string>();
  private editorLanguage: NoteLanguage = 'markdown';
  private editorNoteId: string | undefined;
  private replacingEditorDocument = false;
  private switchingLanguage = false;
  private uploadingImage = false;
  private editorTheme: 'light' | 'dark' = 'light';
  private draggingNoteId: string | undefined;
  private selectionVersion = 0;
  private saveGeneration = 0;
  private sidebarWidth = DEFAULT_NOTES_SIDEBAR_WIDTH;
  private sidebarResizeDrag: { pointerId: number; startX: number; startWidth: number } | undefined;
  private sidebarMeasureFrame: number | undefined;
  private sidebarKeyboardSaveTimer: number | undefined;
  private readonly sidebarWidthSaveTasks = new Set<Promise<void>>();

  constructor() {
    this.codeEditor = new EditorView({
      state: this.createEditorState('', 'markdown'),
      parent: this.codeContentHost,
    });
    this.richTextEditor = new NotesRichTextEditor({
      host: this.richTextHost,
      toolbar: this.richTextToolbar,
      onUpdate: (content) => this.updateSelectedRichTextContent(content),
      onError: (message) => setMessage(message, 'error'),
      onRequestImage: (file, position) => {
        if (file) void this.uploadImageFile(file, position);
        else this.imageInput.click();
      },
    });
    this.contentHost.dataset.theme = this.editorTheme;
    this.setSidebarWidth(this.sidebarWidth);
    this.updateEditorEmptyState();
    this.newButton.addEventListener('click', () => void this.createNote(null));
    this.searchInput.addEventListener('input', () => this.renderList());
    this.list.addEventListener('keydown', (event) => this.handleListKeydown(event));
    this.list.addEventListener('dragover', (event) => {
      if (!this.draggingNoteId || this.searchInput.value.trim() || event.target !== this.list) return;
      event.preventDefault();
      this.list.dataset.rootDrop = 'true';
    });
    this.list.addEventListener('dragleave', (event) => {
      if (event.target === this.list) delete this.list.dataset.rootDrop;
    });
    this.list.addEventListener('drop', (event) => {
      if (!this.draggingNoteId || this.searchInput.value.trim() || event.target !== this.list) return;
      event.preventDefault();
      const movingId = this.draggingNoteId;
      delete this.list.dataset.rootDrop;
      void this.moveNote(movingId, null);
    });

    this.nameInput.addEventListener('input', () => this.updateSelectedMetadata());
    this.languageSelect.addEventListener('change', () => void this.changeSelectedLanguage());
    this.copyButton.addEventListener('click', () => void this.copySelectedNote());
    this.imageInput.addEventListener('change', () => void this.uploadSelectedImage());
    this.sidebarResizeHandle.addEventListener('pointerdown', this.handleSidebarResizePointerDown);
    this.sidebarResizeHandle.addEventListener('pointermove', this.handleSidebarResizePointerMove);
    this.sidebarResizeHandle.addEventListener('pointerup', this.handleSidebarResizePointerEnd);
    this.sidebarResizeHandle.addEventListener('pointercancel', this.handleSidebarResizePointerEnd);
    this.sidebarResizeHandle.addEventListener('lostpointercapture', this.handleSidebarResizeLostCapture);
    this.sidebarResizeHandle.addEventListener('keydown', this.handleSidebarResizeKeyDown);
  }

  show(): void {
    void this.ensureLoaded();
  }

  hide(): void {
    void this.flush().catch(() => undefined);
  }

  async flush(): Promise<void> {
    this.finishSidebarResize();
    this.flushQueuedSidebarWidthSave();
    await Promise.all([this.flushAllPendingSaves(), this.waitForSidebarWidthSaves()]);
  }

  requestEditorMeasure(): void {
    this.codeEditor.requestMeasure();
    this.richTextEditor.requestMeasure();
  }

  applyPersistedSidebarWidth(width: number): void {
    if (this.sidebarResizeDrag
      || this.sidebarKeyboardSaveTimer !== undefined
      || this.sidebarWidthSaveTasks.size > 0) return;
    this.setSidebarWidth(width);
  }

  private setSidebarWidth(value: number): void {
    const width = clampNotesSidebarWidth(value);
    this.sidebarWidth = width;
    document.documentElement.style.setProperty('--notes-sidebar-width', `${width}px`);
    this.sidebarResizeHandle.setAttribute('aria-valuenow', String(width));
    if (this.sidebarMeasureFrame !== undefined) return;
    this.sidebarMeasureFrame = window.requestAnimationFrame(() => {
      this.sidebarMeasureFrame = undefined;
      this.requestEditorMeasure();
    });
  }

  private persistSidebarWidth(width: number): void {
    const task = window.settingsApi.saveNotesSidebarWidth(width).then(
      () => undefined,
      (error) => {
        setMessage(`Unable to save Notes sidebar width: ${toErrorMessage(error)}`, 'error');
      },
    );
    this.sidebarWidthSaveTasks.add(task);
    void task.finally(() => this.sidebarWidthSaveTasks.delete(task));
  }

  private queueSidebarWidthSave(): void {
    if (this.sidebarKeyboardSaveTimer !== undefined) {
      window.clearTimeout(this.sidebarKeyboardSaveTimer);
    }
    this.sidebarKeyboardSaveTimer = window.setTimeout(() => {
      this.sidebarKeyboardSaveTimer = undefined;
      this.persistSidebarWidth(this.sidebarWidth);
    }, NOTES_SIDEBAR_KEYBOARD_SAVE_DEBOUNCE_MS);
  }

  private flushQueuedSidebarWidthSave(): void {
    if (this.sidebarKeyboardSaveTimer === undefined) return;
    window.clearTimeout(this.sidebarKeyboardSaveTimer);
    this.sidebarKeyboardSaveTimer = undefined;
    this.persistSidebarWidth(this.sidebarWidth);
  }

  private async waitForSidebarWidthSaves(): Promise<void> {
    while (this.sidebarWidthSaveTasks.size > 0) {
      await Promise.all([...this.sidebarWidthSaveTasks]);
    }
  }

  private finishSidebarResize(pointerId?: number, releaseCapture = true): void {
    const drag = this.sidebarResizeDrag;
    if (!drag || (pointerId !== undefined && pointerId !== drag.pointerId)) return;
    this.sidebarResizeDrag = undefined;
    delete this.pageRoot.dataset.sidebarResizing;
    if (releaseCapture && this.sidebarResizeHandle.hasPointerCapture(drag.pointerId)) {
      try {
        this.sidebarResizeHandle.releasePointerCapture(drag.pointerId);
      } catch {
        // Native cancellation can release pointer capture before this callback.
      }
    }
    if (this.sidebarWidth !== drag.startWidth) this.persistSidebarWidth(this.sidebarWidth);
  }

  private readonly handleSidebarResizePointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || event.isPrimary === false) return;
    this.finishSidebarResize();
    this.flushQueuedSidebarWidthSave();
    this.sidebarResizeDrag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: this.sidebarWidth,
    };
    this.pageRoot.dataset.sidebarResizing = 'true';
    try {
      this.sidebarResizeHandle.setPointerCapture(event.pointerId);
    } catch {
      this.sidebarResizeDrag = undefined;
      delete this.pageRoot.dataset.sidebarResizing;
      return;
    }
    event.preventDefault();
  };

  private readonly handleSidebarResizePointerMove = (event: PointerEvent): void => {
    const drag = this.sidebarResizeDrag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    this.setSidebarWidth(drag.startWidth + event.clientX - drag.startX);
    event.preventDefault();
  };

  private readonly handleSidebarResizePointerEnd = (event: PointerEvent): void => {
    this.finishSidebarResize(event.pointerId);
  };

  private readonly handleSidebarResizeLostCapture = (event: PointerEvent): void => {
    this.finishSidebarResize(event.pointerId, false);
  };

  private readonly handleSidebarResizeKeyDown = (event: KeyboardEvent): void => {
    const step = event.shiftKey ? NOTES_SIDEBAR_KEYBOARD_STEP * 4 : NOTES_SIDEBAR_KEYBOARD_STEP;
    let requestedWidth: number | undefined;
    if (event.key === 'ArrowLeft') requestedWidth = this.sidebarWidth - step;
    if (event.key === 'ArrowRight') requestedWidth = this.sidebarWidth + step;
    if (event.key === 'Home') requestedWidth = MIN_NOTES_SIDEBAR_WIDTH;
    if (event.key === 'End') requestedWidth = MAX_NOTES_SIDEBAR_WIDTH;
    if (requestedWidth === undefined) return;
    const previousWidth = this.sidebarWidth;
    this.setSidebarWidth(requestedWidth);
    if (this.sidebarWidth !== previousWidth) this.queueSidebarWidthSave();
    event.preventDefault();
  };

  applyEditorTheme(theme: 'light' | 'dark'): void {
    if (theme === this.editorTheme) {
      this.contentHost.dataset.theme = theme;
      return;
    }
    this.editorTheme = theme;
    this.contentHost.dataset.theme = theme;
    this.codeEditor.dispatch({
      effects: this.themeCompartment.reconfigure(editorThemeExtensions(theme)),
    });
    this.requestEditorMeasure();
  }

  async reload(): Promise<void> {
    // A user can type during the short main-process apply window after the
    // final pre-apply flush. Freeze this page and recover every such draft
    // with its last persisted Note as a compare-and-swap base. If the cloud
    // changed or deleted that base, preserve the late draft as a Conflict
    // Note instead of overwriting the newly applied cloud value.
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement && this.pageRoot.contains(activeElement)) activeElement.blur();
    this.pageRoot.inert = true;
    this.selectionVersion += 1;
    const selectedBeforeReload = this.selectedId;
    let selectedAfterRecovery: string | undefined;
    let conflictCount = 0;
    try {
      const pending = this.notes
        .filter((note) => !this.deletedIds.has(note.id) && this.isDirty(note.id))
        .map((note): NoteDraftRecoveryInput => {
          const expectedNote = this.persistedNotes.get(note.id);
          if (!expectedNote) throw new Error('A Note draft has no persisted recovery base.');
          return {
            originalId: note.id,
            draft: {
              name: note.name,
              content: note.content,
              language: note.language,
              tags: [...note.tags],
            },
            expectedNote: cloneNote(expectedNote),
          };
        });
      this.saveGeneration += 1;
      for (const timer of this.saveTimers.values()) window.clearTimeout(timer);
      this.saveTimers.clear();
      if (pending.length > 0) {
        const result = await window.notesApi.recoverDrafts(pending);
        const selectedRecovery = result.recovered.find((item) => item.originalId === selectedBeforeReload);
        selectedAfterRecovery = selectedRecovery?.noteId;
        conflictCount = result.recovered.filter((item) => item.conflict).length;
      }

      this.saveQueues.clear();
      this.editVersions.clear();
      this.persistedVersions.clear();
      this.queuedVersions.clear();
      this.persistedNotes.clear();
      this.deletedIds.clear();
      this.saveErrorNoteIds.clear();
      this.loaded = false;
      this.loadPromise = undefined;
      this.loadError = undefined;
      this.selectedId = selectedAfterRecovery ?? selectedBeforeReload;
      await this.ensureLoaded();
      if (conflictCount > 0) {
        setMessage(
          `${conflictCount} late ${conflictCount === 1 ? 'draft was' : 'drafts were'} preserved as Conflict ${conflictCount === 1 ? 'Note' : 'Notes'}.`,
          'success',
        );
      }
    } finally {
      this.pageRoot.inert = false;
    }
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) {
      this.render();
      return;
    }
    if (this.loadPromise) return this.loadPromise;

    this.loadError = undefined;
    this.newButton.disabled = true;
    this.emptyState.textContent = 'Loading notes…';
    this.emptyState.dataset.state = 'loading';
    this.loadPromise = window.notesApi.getWorkspace().then((workspace) => {
      this.notes = workspace.notes;
      this.treeNodes = workspace.tree.nodes.map((node) => ({ ...node }));
      this.expandedNoteIds = new Set(workspace.expandedNoteIds);
      for (const note of workspace.notes) {
        this.editVersions.set(note.id, 0);
        this.persistedVersions.set(note.id, 0);
        this.persistedNotes.set(note.id, cloneNote(note));
      }
      this.selectedId = workspace.notes.some((note) => note.id === this.selectedId)
        ? this.selectedId
        : this.treeNodes[0]?.noteId;
      this.loaded = true;
      this.render();
      this.setSaveStatus(this.selectedId ? 'Saved' : '', 'saved');
    }).catch((error) => {
      this.loadError = `Unable to load notes: ${toErrorMessage(error)}`;
      this.renderEditor();
    }).finally(() => {
      this.loadPromise = undefined;
      this.newButton.disabled = this.creating;
    });
    return this.loadPromise;
  }

  private render(): void {
    this.renderList();
    this.renderEditor();
  }

  private applyWorkspace(
    workspace: NotesWorkspaceSnapshot,
    editVersionBaseline?: ReadonlyMap<string, number>,
  ): void {
    const localNotes = new Map(this.notes.map((note) => [note.id, note]));
    this.notes = workspace.notes.map((note) => {
      const local = localNotes.get(note.id);
      const baselineVersion = editVersionBaseline?.get(note.id);
      const editedDuringRequest = local
        && baselineVersion !== undefined
        && (this.editVersions.get(note.id) ?? 0) > baselineVersion;
      return editedDuringRequest
        ? { ...local, tags: [...local.tags] }
        : { ...note, tags: [...note.tags] };
    });
    this.treeNodes = workspace.tree.nodes.map((node) => ({ ...node }));
    this.expandedNoteIds = new Set(workspace.expandedNoteIds);
    for (const note of workspace.notes) this.persistedNotes.set(note.id, cloneNote(note));
    const activeIds = new Set(this.notes.map((note) => note.id));
    for (const note of this.notes) {
      if (!this.editVersions.has(note.id)) this.editVersions.set(note.id, 0);
      if (!this.persistedVersions.has(note.id)) this.persistedVersions.set(note.id, 0);
      if (!this.queuedVersions.has(note.id)) this.queuedVersions.set(note.id, 0);
    }
    for (const id of [...this.editVersions.keys()]) {
      if (activeIds.has(id)) continue;
      this.editVersions.delete(id);
      this.persistedVersions.delete(id);
      this.queuedVersions.delete(id);
      this.saveQueues.delete(id);
      this.persistedNotes.delete(id);
      this.saveErrorNoteIds.delete(id);
      this.clearSaveTimer(id);
    }
    if (this.selectedId && !activeIds.has(this.selectedId)) this.selectedId = undefined;
  }

  private treeChildren(): Map<string | null, NotesTreeNode[]> {
    return noteTreeChildren(this.treeNodes.filter((node) => !this.deletedIds.has(node.noteId)));
  }

  private breadcrumb(noteId: string): string {
    return noteTreeBreadcrumb(noteId, this.notes, this.treeNodes);
  }

  private visibleTreeRows(): NoteTreeRow[] {
    return visibleNoteTreeRows(
      this.notes.filter((note) => !this.deletedIds.has(note.id)),
      this.treeNodes.filter((node) => !this.deletedIds.has(node.noteId)),
      this.expandedNoteIds,
    );
  }

  private clearTreeDropMarkers(): void {
    delete this.list.dataset.rootDrop;
    for (const row of Array.from(this.list.querySelectorAll<HTMLElement>('.notes-tree-row'))) {
      delete row.dataset.dropPosition;
    }
  }

  private dropPlacement(target: NotesTreeNode, position: NoteTreeDropPosition): NoteTreePlacement | undefined {
    if (!this.draggingNoteId) return undefined;
    return resolveNoteTreeDropPlacement(this.treeNodes, this.draggingNoteId, target.noteId, position);
  }

  private renderListSaveIndicator(
    nameRow: HTMLElement,
    state: 'saving' | 'error' | undefined,
  ): void {
    nameRow.querySelector('.notes-list-save-indicator')?.remove();
    nameRow.querySelector('.notes-list-save-label')?.remove();
    if (!state) return;

    const saveIndicator = document.createElement('span');
    saveIndicator.className = 'notes-list-save-indicator';
    saveIndicator.dataset.state = state;
    saveIndicator.title = state === 'error' ? 'Save failed' : 'Saving';
    saveIndicator.setAttribute('aria-hidden', 'true');

    const saveLabel = document.createElement('span');
    saveLabel.className = 'notes-list-save-label';
    saveLabel.textContent = state === 'error' ? 'Save failed' : 'Saving';
    nameRow.append(saveIndicator, saveLabel);
  }

  private updateListSaveIndicator(noteId: string): void {
    const row = Array.from(this.list.querySelectorAll<HTMLElement>('.notes-tree-row'))
      .find((candidate) => candidate.dataset.noteId === noteId);
    const nameRow = row?.querySelector<HTMLElement>('.notes-list-item-name-row');
    if (!nameRow) return;
    this.renderListSaveIndicator(
      nameRow,
      noteSaveIndicatorState(this.isDirty(noteId), this.saveErrorNoteIds.has(noteId)),
    );
  }

  private renderList(focusId?: string): void {
    const activeItem = document.activeElement instanceof HTMLButtonElement
      && document.activeElement.classList.contains('notes-list-item')
      ? document.activeElement
      : undefined;
    const restoreFocusId = focusId ?? activeItem?.dataset.noteId;
    const searchActive = Boolean(this.searchInput.value.trim());
    const children = this.treeChildren();
    const rows = searchActive
      ? rankNotes(
        this.notes.filter((note) => !this.deletedIds.has(note.id)),
        this.searchInput.value,
      ).map((note) => ({
        note,
        node: this.treeNodes.find((node) => node.noteId === note.id) ?? { noteId: note.id, parentId: null, order: 0 },
        depth: 0,
      }))
      : this.visibleTreeRows();
    this.list.replaceChildren();

    for (const { note, node, depth } of rows) {
      const row = document.createElement('div');
      row.className = 'notes-list-row notes-tree-row';
      row.dataset.noteId = note.id;
      row.dataset.selected = String(note.id === this.selectedId);
      row.style.setProperty('--notes-tree-depth', String(depth));

      const childNodes = children.get(note.id) ?? [];
      let toggle: HTMLElement;
      if (childNodes.length > 0 && !searchActive) {
        const toggleButton = document.createElement('button');
        toggleButton.type = 'button';
        toggleButton.className = 'notes-tree-toggle';
        toggleButton.dataset.expanded = String(this.expandedNoteIds.has(note.id));
        toggleButton.setAttribute('aria-label', `${this.expandedNoteIds.has(note.id) ? 'Collapse' : 'Expand'} ${note.name}`);
        toggleButton.setAttribute('aria-expanded', String(this.expandedNoteIds.has(note.id)));
        toggleButton.appendChild(createTreeIcon('m6 3 5 5-5 5'));
        toggleButton.addEventListener('click', (event) => {
          event.stopPropagation();
          void this.toggleTreeExpanded(note.id);
        });
        toggle = toggleButton;
      } else {
        toggle = document.createElement('span');
        toggle.className = 'notes-tree-toggle-spacer';
        toggle.setAttribute('aria-hidden', 'true');
      }

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'notes-list-item';
      button.dataset.noteId = note.id;
      button.setAttribute('aria-current', note.id === this.selectedId ? 'true' : 'false');
      if (childNodes.length > 0 && !searchActive) {
        button.setAttribute('aria-expanded', String(this.expandedNoteIds.has(note.id)));
      }

      const nameRow = document.createElement('span');
      nameRow.className = 'notes-list-item-name-row';

      const name = document.createElement('span');
      name.className = 'notes-list-item-name';
      name.textContent = note.name || 'Untitled';
      nameRow.appendChild(name);

      this.renderListSaveIndicator(
        nameRow,
        noteSaveIndicatorState(this.isDirty(note.id), this.saveErrorNoteIds.has(note.id)),
      );
      button.appendChild(nameRow);

      if (searchActive) {
        const path = this.breadcrumb(note.id);
        if (path) {
          const breadcrumb = document.createElement('span');
          breadcrumb.className = 'notes-tree-breadcrumb';
          breadcrumb.textContent = path;
          button.appendChild(breadcrumb);
        }
      }

      button.addEventListener('click', () => {
        void this.selectNote(note.id);
        if (childNodes.length > 0 && !searchActive) {
          void this.toggleTreeExpanded(note.id);
        }
      });

      const actions = document.createElement('span');
      actions.className = 'notes-tree-actions';

      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'notes-tree-add';
      add.setAttribute('aria-label', `New child Note under ${note.name || 'Untitled'}`);
      add.title = 'New child Note';
      add.appendChild(createTreeIcon('M8 3v10M3 8h10'));
      add.addEventListener('click', (event) => {
        event.stopPropagation();
        void this.createNote(note.id);
      });

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'notes-list-remove';
      remove.dataset.noteId = note.id;
      remove.disabled = this.deletingNoteIds.has(note.id);
      remove.setAttribute('aria-label', `Remove ${note.name || 'Untitled'}`);
      remove.title = `Remove ${note.name || 'Untitled'}`;
      remove.appendChild(createRemoveIcon());
      remove.addEventListener('click', (event) => {
        event.stopPropagation();
        void this.deleteNote(note.id);
      });

      actions.append(add, remove);
      row.append(toggle, button, actions);

      if (!searchActive) {
        row.draggable = true;
        row.addEventListener('dragstart', (event) => {
          this.draggingNoteId = note.id;
          this.list.dataset.dragging = 'true';
          row.dataset.dragging = 'true';
          event.dataTransfer?.setData('text/plain', note.id);
          if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
        });
        row.addEventListener('dragend', () => {
          this.draggingNoteId = undefined;
          delete this.list.dataset.dragging;
          delete row.dataset.dragging;
          this.clearTreeDropMarkers();
        });
        row.addEventListener('dragover', (event) => {
          if (!this.draggingNoteId || this.draggingNoteId === note.id) return;
          const bounds = row.getBoundingClientRect();
          const ratio = (event.clientY - bounds.top) / Math.max(1, bounds.height);
          const position: NoteTreeDropPosition = ratio < 0.28 ? 'before' : ratio > 0.72 ? 'after' : 'inside';
          this.clearTreeDropMarkers();
          if (!this.dropPlacement(node, position)) {
            if (event.dataTransfer) event.dataTransfer.dropEffect = 'none';
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          row.dataset.dropPosition = position;
        });
        row.addEventListener('drop', (event) => {
          if (!this.draggingNoteId || this.draggingNoteId === note.id) return;
          event.preventDefault();
          event.stopPropagation();
          const movingId = this.draggingNoteId;
          const position = (row.dataset.dropPosition as 'before' | 'inside' | 'after' | undefined) ?? 'inside';
          const placement = this.dropPlacement(node, position);
          this.clearTreeDropMarkers();
          if (!placement) return;
          void this.moveNote(movingId, placement.parentId, placement.beforeNoteId);
        });
      }

      this.list.appendChild(row);
    }
    if (rows.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'notes-list-empty';
      empty.textContent = this.notes.length > 0 ? 'No notes match your search.' : 'No notes yet.';
      this.list.appendChild(empty);
    }

    if (!searchActive && this.notes.length > 0) {
      const rootDrop = document.createElement('div');
      rootDrop.className = 'notes-tree-root-drop';
      rootDrop.textContent = 'Move to top level';
      rootDrop.addEventListener('dragover', (event) => {
        if (!this.draggingNoteId) return;
        event.preventDefault();
        event.stopPropagation();
        this.clearTreeDropMarkers();
        this.list.dataset.rootDrop = 'true';
      });
      rootDrop.addEventListener('drop', (event) => {
        if (!this.draggingNoteId) return;
        event.preventDefault();
        event.stopPropagation();
        const movingId = this.draggingNoteId;
        this.clearTreeDropMarkers();
        void this.moveNote(movingId, null);
      });
      this.list.appendChild(rootDrop);
    }
    if (restoreFocusId) {
      Array.from(this.list.querySelectorAll<HTMLButtonElement>('.notes-list-item'))
        .find((button) => button.dataset.noteId === restoreFocusId)
        ?.focus();
    }
  }

  private renderEditor(): void {
    const note = this.selectedNote();
    this.emptyState.classList.toggle('hidden', Boolean(note));
    this.editor.classList.toggle('hidden', !note);
    if (!note) {
      this.editorNoteId = undefined;
      this.showEditorMode('markdown');
      this.replaceRichTextDocument(EMPTY_RICH_TEXT_CONTENT);
      this.emptyState.textContent = this.loadError ?? (this.loaded ? 'Create or select a note.' : 'Loading notes…');
      this.emptyState.dataset.state = this.loadError ? 'error' : this.loaded ? 'empty' : 'loading';
      return;
    }

    this.nameInput.value = note.name;
    this.languageSelect.value = note.language;
    const noteChanged = this.editorNoteId !== note.id;
    if (noteChanged) {
      this.editorNoteId = note.id;
      if (note.language === 'richtext') {
        this.replaceRichTextDocument(note.content);
      } else {
        this.codeEditor.setState(this.createEditorState(note.content, note.language));
      }
    } else {
      if (note.language === 'richtext') {
        this.replaceRichTextDocument(note.content);
      } else {
        this.setEditorLanguage(note.language);
        this.replaceEditorDocument(note.content);
      }
    }
    this.showEditorMode(note.language);
    this.updateEditorEmptyState();
  }

  private selectedNote(): Note | undefined {
    return this.notes.find((note) => note.id === this.selectedId);
  }

  private async selectNote(id: string): Promise<void> {
    if (id === this.selectedId || !this.notes.some((note) => note.id === id)) return;
    const selectionVersion = ++this.selectionVersion;
    const previousId = this.selectedId;
    if (previousId) {
      await this.flushNote(previousId);
      if (this.isDirty(previousId)) {
        setMessage('Save the current Note before switching.', 'error');
        return;
      }
    }
    if (selectionVersion !== this.selectionVersion || !this.notes.some((note) => note.id === id)) return;
    this.selectedId = id;
    const selectedDirty = this.isDirty(id);
    if (selectedDirty) this.saveErrorNoteIds.delete(id);
    this.renderList(id);
    this.renderEditor();
    if (selectedDirty) {
      this.setSaveStatus('Saving…', 'saving');
      this.scheduleSave(id);
    } else {
      this.setSaveStatus('Saved', 'saved');
    }
  }

  private updateSelectedMetadata(): void {
    const note = this.selectedNote();
    if (!note) return;

    note.name = this.nameInput.value;
    this.markNoteEdited(note, document.activeElement === this.nameInput || Boolean(this.searchInput.value.trim()));
  }

  private updateSelectedCodeContent(): void {
    if (this.replacingEditorDocument) return;
    const note = this.selectedNote();
    if (!note || note.language === 'richtext') return;
    note.content = this.codeEditor.state.doc.toString();
    this.updateEditorEmptyState();
    this.markNoteEdited(note, Boolean(this.searchInput.value.trim()));
  }

  private updateSelectedRichTextContent(content: string): void {
    if (this.replacingEditorDocument) return;
    const note = this.selectedNote();
    if (!note || note.language !== 'richtext') return;
    note.content = content;
    this.updateEditorEmptyState();
    this.markNoteEdited(note, Boolean(this.searchInput.value.trim()));
  }

  private markNoteEdited(note: Note, refreshList: boolean): void {
    const wasDirty = this.isDirty(note.id);
    const hadSaveError = this.saveErrorNoteIds.delete(note.id);
    this.editVersions.set(note.id, (this.editVersions.get(note.id) ?? 0) + 1);
    if (this.selectedId === note.id) this.setSaveStatus('Saving…', 'saving');
    if (refreshList) this.renderList();
    else if (!wasDirty || hadSaveError) this.updateListSaveIndicator(note.id);
    this.scheduleSave(note.id);
  }

  private async changeSelectedLanguage(): Promise<void> {
    if (this.switchingLanguage) return;
    const note = this.selectedNote();
    if (!note) return;
    const sourceLanguage = note.language;
    const targetLanguage = this.languageSelect.value as NoteLanguage;
    if (!(targetLanguage in noteLanguageExtensions) || targetLanguage === sourceLanguage) {
      this.languageSelect.value = sourceLanguage;
      return;
    }

    const crossesRichTextBoundary = sourceLanguage === 'richtext' || targetLanguage === 'richtext';
    let hasContent = note.content.length > 0;
    if (sourceLanguage === 'richtext') {
      try {
        const document = parseRichTextContent(note.content);
        hasContent = (document.content ?? []).some((node) =>
          node.type !== 'paragraph' || Boolean(node.content?.length)
        );
      } catch {
        hasContent = true;
      }
    }

    this.switchingLanguage = true;
    this.languageSelect.disabled = true;
    try {
      if (crossesRichTextBoundary && hasContent) {
        const leavingRichText = sourceLanguage === 'richtext';
        const confirmed = await window.serviceApi.confirmAction({
          title: leavingRichText ? 'Leave Rich Text?' : 'Switch to Rich Text?',
          message: leavingRichText
            ? 'Switching to a code mode removes rich text formatting and embedded images.'
            : 'The current plain text will be converted to a rich text document.',
          detail: leavingRichText
            ? 'Only the readable text will be kept.'
            : 'Switching back later may discard rich text formatting.',
          kind: 'warning',
          confirmLabel: 'Switch',
          cancelLabel: 'Cancel',
        });
        if (!confirmed) {
          this.languageSelect.value = sourceLanguage;
          return;
        }
      }

      const current = this.selectedNote();
      if (!current || current.id !== note.id || current.language !== sourceLanguage) return;
      if (targetLanguage === 'richtext') {
        current.content = plainTextToRichTextContent(current.content);
      } else if (sourceLanguage === 'richtext') {
        current.content = extractRichTextPlainText(current.content);
      }
      current.language = targetLanguage;
      this.markNoteEdited(current, Boolean(this.searchInput.value.trim()));
      this.renderEditor();
      if (targetLanguage === 'richtext') this.richTextEditor.focus();
      else this.codeEditor.focus();
    } catch (error) {
      this.languageSelect.value = sourceLanguage;
      this.setSaveStatus(`Mode change failed: ${toErrorMessage(error)}`, 'error');
    } finally {
      this.switchingLanguage = false;
      this.languageSelect.disabled = false;
    }
  }

  private async uploadSelectedImage(): Promise<void> {
    const file = this.imageInput.files?.[0];
    this.imageInput.value = '';
    if (!file) return;
    await this.uploadImageFile(file);
  }

  private async uploadImageFile(file: File, position?: number): Promise<void> {
    if (this.uploadingImage) return;
    const note = this.selectedNote();
    if (!note || note.language !== 'richtext') return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      setMessage('Only PNG, JPEG, and WebP images are supported.', 'error');
      return;
    }
    if (file.size < 1 || file.size > NOTE_IMAGE_MAX_BYTES) {
      setMessage('A Notes image must not exceed 10 MiB.', 'error');
      return;
    }

    this.uploadingImage = true;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const alt = file.name
        .replace(/\.(?:png|jpe?g|webp)$/i, '')
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .trim()
        .slice(0, 500);
      const result = await window.notesApi.uploadImage({
        bytes,
        mimeType: file.type,
        ...(alt ? { alt } : {}),
      });
      if (result.status === 'not-configured') {
        setMessage('Configure S3 in Settings before adding images.', 'error');
        return;
      }

      const destination = this.notes.find((candidate) => candidate.id === note.id);
      if (!destination || destination.language !== 'richtext' || this.deletedIds.has(destination.id)) {
        setMessage('The image was uploaded, but its Note is no longer available.', 'error');
        return;
      }
      if (this.selectedId === destination.id) {
        if (!this.richTextEditor.insertImage(result.reference, position)) {
          throw new Error('The uploaded image could not be inserted.');
        }
      } else {
        destination.content = appendImageToRichTextContent(destination.content, result.reference);
        this.markNoteEdited(destination, Boolean(this.searchInput.value.trim()));
      }
      setMessage('Image added.', 'success');
    } catch (error) {
      setMessage(`Unable to add image: ${toErrorMessage(error)}`, 'error');
    } finally {
      this.uploadingImage = false;
    }
  }

  private scheduleSave(id: string): void {
    this.clearSaveTimer(id);
    const timer = window.setTimeout(() => {
      this.saveTimers.delete(id);
      void this.flushNote(id);
    }, NOTE_SAVE_DEBOUNCE_MS);
    this.saveTimers.set(id, timer);
  }

  private clearSaveTimer(id: string): void {
    const timer = this.saveTimers.get(id);
    if (timer !== undefined) window.clearTimeout(timer);
    this.saveTimers.delete(id);
  }

  private isDirty(id: string): boolean {
    return (this.editVersions.get(id) ?? 0) > (this.persistedVersions.get(id) ?? 0);
  }

  private flushNote(id: string): Promise<void> {
    this.clearSaveTimer(id);
    const note = this.notes.find((item) => item.id === id);
    const version = this.editVersions.get(id) ?? 0;
    const completedVersion = this.persistedVersions.get(id) ?? 0;
    const queuedVersion = this.queuedVersions.get(id) ?? 0;
    if (!note || this.deletedIds.has(id) || version <= Math.max(completedVersion, queuedVersion)) {
      return this.saveQueues.get(id) ?? Promise.resolve();
    }
    this.queuedVersions.set(id, version);

    const draft: NoteDraft = {
      name: note.name,
      language: note.language,
      tags: [...note.tags],
      content: note.content,
    };
    const previous = this.saveQueues.get(id) ?? Promise.resolve();
    const saveGeneration = this.saveGeneration;
    const queued = previous.catch(() => undefined).then(async () => {
      if (saveGeneration !== this.saveGeneration || this.deletedIds.has(id)) return;
      const expectedNote = this.persistedNotes.get(id);
      if (!expectedNote) throw new Error('This Note has no persisted save base. Reload Notes and try again.');
      const saved = await window.notesApi.updateNote(id, draft, cloneNote(expectedNote));
      if (saveGeneration !== this.saveGeneration || this.deletedIds.has(id)) return;

      this.persistedNotes.set(id, cloneNote(saved));
      this.persistedVersions.set(id, Math.max(this.persistedVersions.get(id) ?? 0, version));
      this.saveErrorNoteIds.delete(id);
      const current = this.notes.find((item) => item.id === id);
      let normalizedNameChanged = false;
      if (current && (this.editVersions.get(id) ?? 0) === version) {
        normalizedNameChanged = current.name !== saved.name;
        Object.assign(current, saved, { tags: [...saved.tags] });
      }
      if (normalizedNameChanged) this.renderList();
      else this.updateListSaveIndicator(id);
      if (this.selectedId === id) {
        this.setSaveStatus(this.isDirty(id) ? 'Saving…' : 'Saved', this.isDirty(id) ? 'saving' : 'saved');
      }
    }).catch((error) => {
      if (saveGeneration !== this.saveGeneration) return;
      if ((this.queuedVersions.get(id) ?? 0) === version) {
        this.queuedVersions.set(id, this.persistedVersions.get(id) ?? 0);
      }
      if (!this.deletedIds.has(id)) {
        this.saveErrorNoteIds.add(id);
        this.updateListSaveIndicator(id);
        if (this.selectedId === id) {
          this.setSaveStatus(`Save failed: ${toErrorMessage(error)}`, 'error');
        }
      }
    });
    this.saveQueues.set(id, queued);
    return queued;
  }

  private async flushAllPendingSaves(): Promise<void> {
    const ids = new Set([...this.saveTimers.keys(), ...this.notes.filter((note) => this.isDirty(note.id)).map((note) => note.id)]);
    await Promise.all([...ids].map((id) => this.flushNote(id)));
    if (this.notes.some((note) => !this.deletedIds.has(note.id) && this.isDirty(note.id))) {
      throw new Error('Some notes could not be saved. Fix the save error before syncing.');
    }
  }

  private async toggleTreeExpanded(noteId: string): Promise<void> {
    const expanded = !this.expandedNoteIds.has(noteId);
    try {
      const ids = await window.notesApi.setTreeExpanded({ noteId, expanded });
      this.expandedNoteIds = new Set(ids);
      this.renderList(noteId);
    } catch (error) {
      setMessage(`Unable to update the Notes tree: ${toErrorMessage(error)}`, 'error');
    }
  }

  private async moveNote(noteId: string, parentId: string | null, beforeNoteId?: string): Promise<void> {
    if (!isValidNoteTreeParent(this.treeNodes, noteId, parentId)) {
      setMessage('A Note cannot be moved into its own subtree.', 'error');
      this.renderList(noteId);
      return;
    }
    try {
      await this.flushAllPendingSaves();
      const editVersionBaseline = new Map(this.editVersions);
      const workspace = await window.notesApi.moveNote({
        noteId,
        parentId,
        ...(beforeNoteId ? { beforeNoteId } : {}),
      });
      this.applyWorkspace(workspace, editVersionBaseline);
      this.renderList(noteId);
    } catch (error) {
      setMessage(`Unable to move Note: ${toErrorMessage(error)}`, 'error');
      this.renderList(noteId);
    }
  }

  private async createNote(parentId: string | null): Promise<void> {
    if (this.creating) return;
    await this.ensureLoaded();
    if (!this.loaded) return;
    this.creating = true;
    this.newButton.disabled = true;
    try {
      await this.flushAllPendingSaves();
      const editVersionBaseline = new Map(this.editVersions);
      const previousIds = new Set(this.notes.map((note) => note.id));
      const workspace = await window.notesApi.createNote({ parentId });
      const note = workspace.notes.find((candidate) => !previousIds.has(candidate.id));
      if (!note) throw new Error('The new Note was not returned.');
      this.applyWorkspace(workspace, editVersionBaseline);
      this.selectedId = note.id;
      this.searchInput.value = '';
      this.render();
      this.setSaveStatus('Saved', 'saved');
      window.requestAnimationFrame(() => {
        this.nameInput.focus();
        this.nameInput.select();
      });
    } catch (error) {
      setMessage(`Unable to create Note: ${toErrorMessage(error)}`, 'error');
    } finally {
      this.creating = false;
      this.newButton.disabled = false;
    }
  }

  private async copySelectedNote(): Promise<void> {
    const note = this.selectedNote();
    if (!note) return;
    try {
      const content = note.language === 'richtext'
        ? extractRichTextPlainText(note.content)
        : note.content;
      await window.serviceApi.writeClipboardText(content);
      this.copyLabel.textContent = 'Copied';
      this.copyButton.dataset.copied = 'true';
      window.setTimeout(() => {
        this.copyLabel.textContent = 'Copy';
        delete this.copyButton.dataset.copied;
      }, 1_200);
    } catch (error) {
      this.setSaveStatus(`Copy failed: ${toErrorMessage(error)}`, 'error');
    }
  }

  private async deleteNote(id: string): Promise<void> {
    if (this.deletingNoteIds.has(id)) return;
    this.deletingNoteIds.add(id);
    this.renderList(id);

    try {
      await this.flushAllPendingSaves();
      let promptUsesUpdatedScope = false;
      let pendingPreview: NoteDeletePreview | null | undefined;

      while (true) {
        const preview = pendingPreview === undefined
          ? await window.notesApi.previewNoteDelete(id)
          : pendingPreview;
        pendingPreview = undefined;
        if (!preview || preview.expectedIds.length === 0) {
          await this.reload();
          return;
        }

        const scopeDetail = preview.expectedIds.length > 1
          ? `This will permanently delete ${preview.expectedIds.length} Notes in this subtree.`
          : 'This action cannot be undone.';
        const confirmed = await window.serviceApi.confirmAction({
          title: 'Delete Note',
          message: `Delete “${preview.name || 'Untitled'}”?`,
          detail: promptUsesUpdatedScope
            ? `Updated deletion scope: ${scopeDetail}`
            : scopeDetail,
          kind: 'warning',
          confirmLabel: 'Delete',
          cancelLabel: 'Cancel',
        });
        if (!confirmed) return;

        // Recheck only the lightweight authoritative scope after the native
        // dialog. No complete Note bodies cross IPC for a confirmation retry.
        const confirmedPreview = await window.notesApi.previewNoteDelete(id);
        if (!confirmedPreview
          || !sameNoteIdSet(preview.expectedIds, confirmedPreview.expectedIds)) {
          pendingPreview = confirmedPreview;
          promptUsesUpdatedScope = true;
          continue;
        }

        const visibleBeforeDelete = this.searchInput.value.trim()
          ? rankNotes(this.notes, this.searchInput.value).map((item) => item.id)
          : this.visibleTreeRows().map((item) => item.note.id);
        const deletedIndex = visibleBeforeDelete.indexOf(id);
        const focusAfterDelete = visibleBeforeDelete.slice(deletedIndex + 1)
          .find((candidate) => !confirmedPreview.expectedIds.includes(candidate))
          ?? [...visibleBeforeDelete.slice(0, deletedIndex)].reverse()
            .find((candidate) => !confirmedPreview.expectedIds.includes(candidate));
        const selectedBeforeDelete = this.selectedId;
        const editVersionBaseline = new Map(this.editVersions);
        for (const noteId of confirmedPreview.expectedIds) {
          this.deletedIds.add(noteId);
          this.clearSaveTimer(noteId);
        }
        if (this.selectedId && this.deletedIds.has(this.selectedId)) {
          this.selectedId = focusAfterDelete
            ?? this.treeNodes.find((node) => !this.deletedIds.has(node.noteId))?.noteId;
        }
        this.render();

        try {
          const result = await window.notesApi.deleteNote({
            id,
            expectedIds: confirmedPreview.expectedIds,
          });
          if (result.status === 'changed') {
            for (const noteId of confirmedPreview.expectedIds) this.deletedIds.delete(noteId);
            this.selectedId = selectedBeforeDelete;
            this.render();
            pendingPreview = result.preview;
            promptUsesUpdatedScope = true;
            continue;
          }

          this.applyWorkspace({
            notes: this.notes.filter((note) => !result.deletedIds.includes(note.id)),
            tree: result.tree,
            expandedNoteIds: result.expandedNoteIds,
          }, editVersionBaseline);
          for (const deletedId of result.deletedIds) this.deletedIds.delete(deletedId);
          if (!this.selectedId) this.selectedId = focusAfterDelete ?? this.treeNodes[0]?.noteId;
          this.render();
          this.renderList(focusAfterDelete ?? this.selectedId);
          if (!this.selectedId) this.newButton.focus();
          const selectedDirty = Boolean(this.selectedId && this.isDirty(this.selectedId));
          this.setSaveStatus(
            this.selectedId ? selectedDirty ? 'Saving…' : 'Saved' : '',
            selectedDirty ? 'saving' : 'saved',
          );
          setMessage(
            result.deletedIds.length === 1
              ? 'Note deleted.'
              : `${result.deletedIds.length} Notes deleted.`,
            'success',
          );
          return;
        } catch (error) {
          for (const noteId of confirmedPreview.expectedIds) {
            this.deletedIds.delete(noteId);
            if (this.isDirty(noteId)) this.scheduleSave(noteId);
          }
          this.selectedId = selectedBeforeDelete;
          this.render();
          throw error;
        }
      }
    } catch (error) {
      this.setSaveStatus(`Delete failed: ${toErrorMessage(error)}`, 'error');
    } finally {
      this.deletingNoteIds.delete(id);
      this.renderList(this.selectedId);
    }
  }

  private handleListKeydown(event: KeyboardEvent): void {
    const items = Array.from(this.list.querySelectorAll<HTMLButtonElement>('.notes-list-item'));
    if (items.length === 0) return;
    const current = document.activeElement instanceof HTMLButtonElement
      ? items.indexOf(document.activeElement)
      : -1;
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      const item = current >= 0 ? items[current] : undefined;
      const noteId = item?.dataset.noteId;
      if (!item || !noteId || this.searchInput.value.trim()) return;
      const children = this.treeChildren().get(noteId) ?? [];
      if (event.key === 'ArrowRight') {
        if (children.length === 0) return;
        event.preventDefault();
        if (!this.expandedNoteIds.has(noteId)) void this.toggleTreeExpanded(noteId);
        else items.find((candidate) => candidate.dataset.noteId === children[0]?.noteId)?.focus();
        return;
      }
      const node = this.treeNodes.find((candidate) => candidate.noteId === noteId);
      event.preventDefault();
      if (children.length > 0 && this.expandedNoteIds.has(noteId)) void this.toggleTreeExpanded(noteId);
      else if (node?.parentId) items.find((candidate) => candidate.dataset.noteId === node.parentId)?.focus();
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const direction = event.key === 'ArrowDown' ? 1 : -1;
    const next = current < 0 ? 0 : (current + direction + items.length) % items.length;
    event.preventDefault();
    items[next]?.focus();
  }

  private replaceEditorDocument(content: string): void {
    const current = this.codeEditor.state.doc.toString();
    if (current === content) {
      this.updateEditorEmptyState();
      return;
    }
    this.replacingEditorDocument = true;
    try {
      this.codeEditor.dispatch({
        changes: { from: 0, to: this.codeEditor.state.doc.length, insert: content },
      });
    } finally {
      this.replacingEditorDocument = false;
    }
    this.updateEditorEmptyState();
  }

  private createEditorState(content: string, language: NoteLanguage): EditorState {
    this.editorLanguage = language;
    return EditorState.create({
      doc: content,
      extensions: [
        basicSetup,
        this.themeCompartment.of(editorThemeExtensions(this.editorTheme)),
        this.languageCompartment.of(noteLanguageExtension(language)),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({
          'aria-label': 'Note content',
          'aria-multiline': 'true',
          spellcheck: 'false',
        }),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged || this.replacingEditorDocument) return;
          this.updateSelectedCodeContent();
        }),
      ],
    });
  }

  private setEditorLanguage(language: NoteLanguage): void {
    if (language === 'richtext') return;
    if (language === this.editorLanguage) return;
    this.editorLanguage = language;
    this.codeEditor.dispatch({
      effects: this.languageCompartment.reconfigure(noteLanguageExtension(language)),
    });
  }

  private updateEditorEmptyState(): void {
    const note = this.selectedNote();
    if (!note) {
      this.contentHost.dataset.empty = 'true';
      return;
    }
    if (note.language !== 'richtext') {
      this.contentHost.dataset.empty = String(this.codeEditor.state.doc.length === 0);
      return;
    }
    try {
      const document = parseRichTextContent(note.content);
      const hasContent = (document.content ?? []).some((node) =>
        node.type !== 'paragraph' || Boolean(node.content?.length)
      );
      this.contentHost.dataset.empty = String(!hasContent);
    } catch {
      this.contentHost.dataset.empty = 'false';
    }
  }

  private replaceRichTextDocument(content: string): void {
    const normalized = normalizeRichTextContent(content || EMPTY_RICH_TEXT_CONTENT);
    if (this.richTextEditor.getContent() === normalized) return;
    this.replacingEditorDocument = true;
    try {
      this.richTextEditor.setContent(normalized);
    } finally {
      this.replacingEditorDocument = false;
    }
  }

  private showEditorMode(language: NoteLanguage): void {
    const richText = language === 'richtext';
    this.codeContentHost.classList.toggle('hidden', richText);
    this.richTextShell.classList.toggle('hidden', !richText);
    this.contentHost.dataset.mode = richText ? 'richtext' : 'code';
    this.contentHost.dataset.language = language;
    if (!richText) this.replaceRichTextDocument(EMPTY_RICH_TEXT_CONTENT);
  }

  private setSaveStatus(text: string, state: 'saving' | 'saved' | 'error'): void {
    if (this.saveStatus.textContent === text && this.saveStatus.dataset.state === state) return;
    this.saveStatus.textContent = text;
    this.saveStatus.dataset.state = state;
    if (state === 'error' && text) setMessage(text, 'error');
  }
}

let page: NotesPage | undefined;
let flushListenerRegistered = false;

export function applyNotesFontSize(fontSize: number): void {
  const normalized = Number.isInteger(fontSize) && fontSize >= 12 && fontSize <= 24 ? fontSize : 14;
  document.documentElement.style.setProperty('--notes-editor-font-size', `${normalized}px`);
  window.requestAnimationFrame(() => page?.requestEditorMeasure());
}

export function applyNotesEditorTheme(theme: 'light' | 'dark'): void {
  const normalized = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.notesEditorTheme = normalized;
  page?.applyEditorTheme(normalized);
}

export function applyNotesSidebarWidth(width: number): void {
  const normalized = clampNotesSidebarWidth(width);
  if (page) {
    page.applyPersistedSidebarWidth(normalized);
    return;
  }
  document.documentElement.style.setProperty('--notes-sidebar-width', `${normalized}px`);
}

export function registerNotesPage(): void {
  page ??= new NotesPage();
  if (!flushListenerRegistered) {
    window.notesApi.onFlushRequested(() => page?.flush() ?? Promise.resolve());
    flushListenerRegistered = true;
  }
  registerPage({
    id: 'notes',
    title: 'Notes',
    icon: NOTES_NAV_ICON,
    onShow: () => page?.show(),
    onHide: () => page?.hide(),
  });
}

export function flushNotesPage(): Promise<void> {
  return page?.flush() ?? Promise.resolve();
}

export function reloadNotesPage(): Promise<void> {
  return page?.reload() ?? Promise.resolve();
}
