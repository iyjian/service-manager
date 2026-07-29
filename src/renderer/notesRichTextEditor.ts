import {
  Editor,
  Extension,
  generateJSON,
  Mark,
  Node,
  posToDOMRect,
  type ChainedCommands,
  type Extensions,
  type NodeViewRendererProps,
} from '@tiptap/core';
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import Image from '@tiptap/extension-image';
import { TableKit } from '@tiptap/extension-table';
import StarterKit from '@tiptap/starter-kit';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { NodeSelection, Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { common, createLowlight } from 'lowlight';
import {
  CODE_HIGHLIGHT_LANGUAGES,
  CODE_HIGHLIGHT_LIMITS,
  codeHighlightSearchText,
  findCodeHighlightLanguage,
} from './codeHighlight.js';
import {
  EMPTY_RICH_TEXT_CONTENT,
  extractRichTextPlainText,
  isAllowedRichTextLinkHref,
  normalizeRichTextContent,
  noteAttachmentPreviewKind,
  parseNoteAttachmentReference,
  parseNoteImageNodeAttributes,
  parseNoteImageReference,
  parseRichTextContent,
  RICH_TEXT_LIMITS,
  type NoteImageAlignment,
  type NoteAttachmentReference,
  type NoteImageNodeAttributes,
  type NoteImageReference,
  type RichTextNode,
} from './noteRichText.js';
import { revealMenuItemScrollTop } from './notesRichTextMenuScroll.js';
import {
  findNotesTextMatches,
  NOTES_FIND_MATCH_LIMIT,
  type NotesFindMatch,
  type NotesFindResult,
} from './notesFind.js';
import {
  calculateRichTextImageDisplayWidth,
  RICH_TEXT_IMAGE_MIN_DISPLAY_WIDTH,
} from './notesRichTextImageResize.js';
import { NotesRichTextTableControls } from './notesRichTextTable.js';
import type {
  TriliumImportImageAsset,
  TriliumImportImagePlaceholderReason,
} from '../shared/types';
import {
  isTriliumTodoCheckboxType,
  isTriliumTodoDescriptionClass,
  isTriliumTodoLabelClass,
  isTriliumTodoListClass,
  mapTriliumTableCellColumnWidths,
  normalizeTriliumTableColumnWidths,
  parseTriliumImageSource,
  triliumImageAlignment,
  triliumImagePixelWidth,
  triliumTodoChecked,
  type TriliumTableCellSpan,
} from './triliumRichText.js';

export type RichTextToolbarCommand =
  | 'undo'
  | 'redo'
  | 'bold'
  | 'italic'
  | 'underline'
  | 'strike'
  | 'code'
  | 'math'
  | 'heading'
  | 'bulletList'
  | 'orderedList'
  | 'blockquote';

export interface NotesRichTextEditorOptions {
  host: HTMLElement;
  toolbar: HTMLElement;
  onChange: () => void;
  onError: (message: string) => void;
  onRequestImage: (file?: File, position?: number) => void;
  onRequestAttachment: (file?: File, position?: number) => void;
  onAttachmentAction: (
    action: 'view' | 'download',
    reference: NoteAttachmentReference,
    opener: HTMLButtonElement,
  ) => void;
}

type NotesImageLoadResult =
  | { status: 'loaded'; bytes: Uint8Array; mimeType: NoteImageReference['mimeType'] }
  | { status: 'not-configured' | 'missing' | 'error' };

const TOOLBAR_COMMANDS = new Set<RichTextToolbarCommand>([
  'undo',
  'redo',
  'bold',
  'italic',
  'underline',
  'strike',
  'code',
  'math',
  'heading',
  'bulletList',
  'orderedList',
  'blockquote',
]);

const TOGGLE_COMMANDS = new Set<RichTextToolbarCommand>([
  'bold',
  'italic',
  'underline',
  'strike',
  'code',
  'math',
  'heading',
  'bulletList',
  'orderedList',
  'blockquote',
]);

interface RichTextFindDecorationState {
  matches: readonly NotesFindMatch[];
  activeIndex: number;
}

interface RichTextFindRunChunk {
  textFrom: number;
  textTo: number;
  documentFrom: number;
}

interface RichTextFindRun {
  text: string;
  chunks: readonly RichTextFindRunChunk[];
}

const richTextFindPluginKey = new PluginKey<DecorationSet>('notesInNoteFind');

function richTextFindDecorations(
  document: ProseMirrorNode,
  state: RichTextFindDecorationState,
): DecorationSet {
  const maximum = document.content.size;
  const decorations = state.matches.flatMap((match, index) => (
    match.from >= 0 && match.to > match.from && match.to <= maximum
      ? [Decoration.inline(match.from, match.to, {
        class: index === state.activeIndex
          ? 'notes-find-match notes-find-match-active'
          : 'notes-find-match',
      })]
      : []
  ));
  return DecorationSet.create(document, decorations);
}

const notesRichTextFindExtension = Extension.create({
  name: 'notesInNoteFind',
  addProseMirrorPlugins() {
    return [new Plugin<DecorationSet>({
      key: richTextFindPluginKey,
      state: {
        init: () => DecorationSet.empty,
        apply: (transaction, decorations) => {
          const requested = transaction.getMeta(richTextFindPluginKey) as RichTextFindDecorationState | undefined;
          if (requested) return richTextFindDecorations(transaction.doc, requested);
          return transaction.docChanged ? decorations.map(transaction.mapping, transaction.doc) : decorations;
        },
      },
      props: {
        decorations: (state) => richTextFindPluginKey.getState(state),
      },
    })];
  },
});

function richTextFindRuns(node: ProseMirrorNode, documentFrom: number): RichTextFindRun[] {
  const runs: RichTextFindRun[] = [];
  let text = '';
  let chunks: RichTextFindRunChunk[] = [];
  const flush = (): void => {
    if (text) runs.push({ text, chunks });
    text = '';
    chunks = [];
  };
  node.forEach((child, offset) => {
    if (!child.isText || !child.text) {
      flush();
      return;
    }
    const textFrom = text.length;
    text += child.text;
    chunks.push({
      textFrom,
      textTo: text.length,
      documentFrom: documentFrom + offset,
    });
  });
  flush();
  return runs;
}

function richTextFindRunPosition(run: RichTextFindRun, offset: number): number {
  const chunk = run.chunks.find((candidate) => offset <= candidate.textTo)
    ?? run.chunks[run.chunks.length - 1];
  if (!chunk) return 0;
  return chunk.documentFrom + Math.max(0, offset - chunk.textFrom);
}

export function findRichTextMatches(document: ProseMirrorNode, query: string): NotesFindResult {
  if (!query) return { matches: [], truncated: false };
  const matches: NotesFindMatch[] = [];
  let truncated = false;
  document.descendants((node, position) => {
    if (truncated) return false;
    if (!node.isTextblock) return true;
    for (const run of richTextFindRuns(node, position + 1)) {
      const remaining = NOTES_FIND_MATCH_LIMIT - matches.length;
      if (remaining <= 0) {
        if (findNotesTextMatches(run.text, query, 1).matches.length > 0) truncated = true;
        continue;
      }
      const result = findNotesTextMatches(run.text, query, remaining);
      for (const match of result.matches) {
        matches.push({
          from: richTextFindRunPosition(run, match.from),
          to: richTextFindRunPosition(run, match.to),
        });
      }
      if (result.truncated) truncated = true;
    }
    return false;
  });
  return { matches, truncated };
}

interface SlashCommandRange {
  from: number;
  to: number;
}

interface SlashCommandItem {
  title: string;
  description: string;
  searchTerms: readonly string[];
  icon: EditorIconName;
  run: (editor: Editor, range: SlashCommandRange) => void;
}

let slashMenuIdSequence = 0;
let codeLanguageMenuIdSequence = 0;

type EditorIconName =
  | 'text'
  | 'todo'
  | 'heading1'
  | 'heading2'
  | 'heading3'
  | 'bulletList'
  | 'numberedList'
  | 'quote'
  | 'code'
  | 'image'
  | 'file'
  | 'table';

interface RichTextBlockItem {
  name: string;
  label: string;
  icon: EditorIconName;
}

const RICH_TEXT_BLOCK_ITEMS: readonly RichTextBlockItem[] = [
  { name: 'paragraph', label: 'Text', icon: 'text' },
  { name: 'heading1', label: 'Heading 1', icon: 'heading1' },
  { name: 'heading2', label: 'Heading 2', icon: 'heading2' },
  { name: 'heading3', label: 'Heading 3', icon: 'heading3' },
  { name: 'taskList', label: 'To-do List', icon: 'todo' },
  { name: 'bulletList', label: 'Bullet List', icon: 'bulletList' },
  { name: 'orderedList', label: 'Numbered List', icon: 'numberedList' },
  { name: 'blockquote', label: 'Quote', icon: 'quote' },
  { name: 'codeBlock', label: 'Code', icon: 'code' },
] as const;

interface RichTextColorItem {
  name: string;
  color?: string;
}

const RICH_TEXT_COLORS: readonly RichTextColorItem[] = [
  { name: 'Default' },
  { name: 'Purple', color: '#9333EA' },
  { name: 'Red', color: '#E00000' },
  { name: 'Yellow', color: '#EAB308' },
  { name: 'Blue', color: '#2563EB' },
  { name: 'Green', color: '#008A00' },
  { name: 'Orange', color: '#FFA500' },
  { name: 'Pink', color: '#BA4081' },
  { name: 'Gray', color: '#A8A29E' },
] as const;

const RICH_TEXT_HIGHLIGHTS: readonly RichTextColorItem[] = [
  { name: 'Default' },
  { name: 'Purple', color: '#F3E8FF' },
  { name: 'Red', color: '#FEE2E2' },
  { name: 'Yellow', color: '#FEF9C3' },
  { name: 'Blue', color: '#DBEAFE' },
  { name: 'Green', color: '#DCFCE7' },
  { name: 'Orange', color: '#FFEDD5' },
  { name: 'Pink', color: '#FCE7F3' },
  { name: 'Gray', color: '#E4E4E7' },
] as const;

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const NOTE_IMAGE_ALIGNMENTS: readonly NoteImageAlignment[] = ['left', 'center', 'right'];
const NOTE_IMAGE_ALIGNMENT_ICONS: Readonly<Record<NoteImageAlignment, readonly string[]>> = {
  left: ['M2.5 3.25h11', 'M2.5 6.75h7', 'M2.5 10.25h11', 'M2.5 13.75h7'],
  center: ['M2.5 3.25h11', 'M4.5 6.75h7', 'M2.5 10.25h11', 'M4.5 13.75h7'],
  right: ['M2.5 3.25h11', 'M6.5 6.75h7', 'M2.5 10.25h11', 'M6.5 13.75h7'],
};

const notesCodeLowlightBase = createLowlight(common);
type NotesCodeLowlight = ReturnType<typeof createLowlight>;
type NotesCodeHighlightRoot = ReturnType<NotesCodeLowlight['highlightAuto']>;
const notesCodeLanguageNames = Object.freeze([
  ...notesCodeLowlightBase.listLanguages(),
  ...CODE_HIGHLIGHT_LANGUAGES.flatMap((item) => item.aliases),
]);

function plainCodeHighlightRoot(value: string): NotesCodeHighlightRoot {
  return {
    type: 'root',
    children: [{ type: 'text', value }],
    data: { language: undefined, relevance: 0 },
  };
}

const notesCodeLowlight: NotesCodeLowlight = {
  ...notesCodeLowlightBase,
  highlight(language, value, options) {
    if (value.length > CODE_HIGHLIGHT_LIMITS.explicitCharacters) return plainCodeHighlightRoot(value);
    return notesCodeLowlightBase.highlight(
      findCodeHighlightLanguage(language)?.value ?? language,
      value,
      options,
    );
  },
  highlightAuto(value, options) {
    if (value.length > CODE_HIGHLIGHT_LIMITS.automaticCharacters) return plainCodeHighlightRoot(value);
    return notesCodeLowlightBase.highlightAuto(value, options);
  },
  listLanguages() {
    return [...notesCodeLanguageNames];
  },
};
const ICON_PATHS: Readonly<Record<Exclude<EditorIconName, 'heading1' | 'heading2' | 'heading3'>, readonly string[]>> = {
  text: ['M4 4h8', 'M8 4v8', 'M6 12h4'],
  todo: ['M2.5 4.25 4 5.75l2.25-3', 'M7.75 4.5h5.75', 'M2.5 10.25 4 11.75l2.25-3', 'M7.75 10.5h5.75'],
  bulletList: ['M6 4h7.5', 'M6 8h7.5', 'M6 12h7.5', 'M2.75 4h.01', 'M2.75 8h.01', 'M2.75 12h.01'],
  numberedList: ['M6 4h7.5', 'M6 8h7.5', 'M6 12h7.5', 'M2.25 3.25h1v2', 'M2.25 7.25h1a.75.75 0 0 1 0 1.5h-1l1.25 1.5h-1.5'],
  quote: ['M3 5.5h3v3H4.25a2 2 0 0 1-2 2', 'M9.5 5.5h3v3h-1.75a2 2 0 0 1-2 2'],
  code: ['m5.25 4-3.5 4 3.5 4', 'm10.75 4 3.5 4-3.5 4', 'm9.5 2.75-3 10.5'],
  image: ['M2.5 3.25h11v9.5h-11z', 'm3.5 11 3-3 2.25 2.25L10.5 8.5l2 2', 'M5.25 6.25h.01'],
  file: ['M4 2.25h5l3 3v8.5H4z', 'M9 2.25v3h3', 'M6 8h4', 'M6 10.5h4'],
  table: [
    'M3.75 2.5h8.5c.69 0 1.25.56 1.25 1.25v8.5c0 .69-.56 1.25-1.25 1.25h-8.5c-.69 0-1.25-.56-1.25-1.25v-8.5c0-.69.56-1.25 1.25-1.25z',
    'M8 2.5v11',
    'M2.5 6.25h11',
    'M2.5 9.75h11',
  ],
};

function createEditorIcon(name: EditorIconName): HTMLElement {
  const wrapper = document.createElement('span');
  wrapper.className = 'notes-richtext-command-icon';
  if (name.startsWith('heading')) {
    const label = document.createElement('span');
    label.className = 'notes-richtext-heading-icon';
    label.textContent = `H${name.slice(-1)}`;
    wrapper.append(label);
    return wrapper;
  }
  const icon = document.createElementNS(SVG_NAMESPACE, 'svg');
  icon.setAttribute('viewBox', '0 0 16 16');
  icon.setAttribute('fill', 'none');
  icon.setAttribute('stroke', 'currentColor');
  icon.setAttribute('stroke-width', '1.45');
  icon.setAttribute('stroke-linecap', 'round');
  icon.setAttribute('stroke-linejoin', 'round');
  icon.setAttribute('aria-hidden', 'true');
  const pathDataItems = ICON_PATHS[name as Exclude<EditorIconName, 'heading1' | 'heading2' | 'heading3'>];
  for (const pathData of pathDataItems) {
    const path = document.createElementNS(SVG_NAMESPACE, 'path');
    path.setAttribute('d', pathData);
    icon.append(path);
  }
  wrapper.append(icon);
  return wrapper;
}

function createStrokeIcon(pathDataItems: readonly string[]): SVGSVGElement {
  const icon = document.createElementNS(SVG_NAMESPACE, 'svg');
  icon.setAttribute('viewBox', '0 0 16 16');
  icon.setAttribute('fill', 'none');
  icon.setAttribute('stroke', 'currentColor');
  icon.setAttribute('stroke-width', '1.5');
  icon.setAttribute('stroke-linecap', 'round');
  icon.setAttribute('stroke-linejoin', 'round');
  icon.setAttribute('aria-hidden', 'true');
  for (const pathData of pathDataItems) {
    const path = document.createElementNS(SVG_NAMESPACE, 'path');
    path.setAttribute('d', pathData);
    icon.append(path);
  }
  return icon;
}

function isSupportedImageFile(file: File): boolean {
  return file.type === 'image/png'
    || file.type === 'image/jpeg'
    || file.type === 'image/webp';
}

function firstSupportedImageFile(files: FileList | null | undefined): File | undefined {
  return Array.from(files ?? []).find(isSupportedImageFile);
}

function hasFormattableSelection(editor: Editor): boolean {
  const selection = editor.state.selection;
  if (selection.empty || (selection as typeof selection & { node?: unknown }).node) return false;
  let hasFormattableContent = false;
  let intersectsCodeBlock = false;
  editor.state.doc.nodesBetween(selection.from, selection.to, (node) => {
    if (node.type.name === 'codeBlock') {
      intersectsCodeBlock = true;
      return false;
    }
    if ((node.isText && Boolean(node.text?.length)) || node.type.name === 'math') {
      hasFormattableContent = true;
      return false;
    }
    return true;
  });
  return hasFormattableContent && !intersectsCodeBlock;
}

function isToolbarCommand(value: unknown): value is RichTextToolbarCommand {
  return typeof value === 'string' && TOOLBAR_COMMANDS.has(value as RichTextToolbarCommand);
}

function safelyReport(onError: (message: string) => void, message: string): void {
  try {
    onError(message);
  } catch {
    // An error presentation callback must not break the editor or a NodeView.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Tiptap's Link schema always serializes its built-in `class: null` default.
 * It is not part of the durable canonical model. Strip only that exact schema
 * artifact; a non-null class or any other foreign attribute must reach and be
 * rejected by normalizeRichTextContent.
 */
function stripTiptapLinkDefaults(value: unknown, depth = 0): unknown {
  if (depth > 70 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => stripTiptapLinkDefaults(item, depth + 1));

  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = stripTiptapLinkDefaults(item, depth + 1);
  }
  if (result.type === 'link' && isRecord(result.attrs) && result.attrs.class === null) {
    const { class: _class, ...attrs } = result.attrs;
    result.attrs = attrs;
  }
  return result;
}

function normalizeEditorContent(value: unknown): string {
  return normalizeRichTextContent(stripTiptapLinkDefaults(value));
}

function loadNoteImage(reference: NoteImageReference): Promise<NotesImageLoadResult> {
  // Keep the renderer adapter independently type-checkable while the narrow
  // preload contract remains the sole bridge to the main-process image store.
  const api = window.notesApi as typeof window.notesApi & {
    loadImage(value: NoteImageReference): Promise<NotesImageLoadResult>;
  };
  return api.loadImage(reference);
}

function createTaskListExtension() {
  return Node.create({
    name: 'taskList',
    group: 'block',
    content: 'taskItem+',
    parseHTML() {
      return [{ tag: 'ul[data-type="taskList"]', priority: 60 }];
    },
    renderHTML() {
      return ['ul', { 'data-type': 'taskList' }, 0];
    },
  });
}

function createTaskItemExtension() {
  return Node.create({
    name: 'taskItem',
    content: 'paragraph block*',
    defining: true,
    addAttributes() {
      return {
        checked: {
          default: false,
          parseHTML: (element) => element.getAttribute('data-checked') === 'true',
          renderHTML: (attributes) => ({ 'data-checked': attributes.checked ? 'true' : 'false' }),
        },
      };
    },
    parseHTML() {
      return [{ tag: 'li[data-task-item]', priority: 60 }];
    },
    renderHTML({ HTMLAttributes }) {
      return ['li', { ...HTMLAttributes, 'data-task-item': '' }, 0];
    },
    addKeyboardShortcuts() {
      return {
        Enter: () => this.editor.commands.splitListItem(this.name),
        Tab: () => this.editor.commands.sinkListItem(this.name),
        'Shift-Tab': () => this.editor.commands.liftListItem(this.name),
      };
    },
    addNodeView() {
      return ({ node, getPos, editor }) => {
        const dom = document.createElement('li');
        dom.dataset.taskItem = '';
        const label = document.createElement('label');
        label.contentEditable = 'false';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.setAttribute('aria-label', 'Mark task complete');
        label.append(checkbox);
        const contentDOM = document.createElement('div');
        dom.append(label, contentDOM);

        const reflect = (nextNode: NodeViewRendererProps['node']): void => {
          const checked = nextNode.attrs.checked === true;
          checkbox.checked = checked;
          dom.dataset.checked = String(checked);
        };
        reflect(node);
        checkbox.addEventListener('change', () => {
          const position = getPos();
          if (typeof position !== 'number' || editor.isDestroyed) return;
          editor.view.dispatch(editor.state.tr.setNodeMarkup(position, undefined, {
            ...node.attrs,
            checked: checkbox.checked,
          }));
        });
        return {
          dom,
          contentDOM,
          update(updatedNode) {
            if (updatedNode.type.name !== 'taskItem') return false;
            node = updatedNode;
            reflect(node);
            return true;
          },
          ignoreMutation: (mutation) => mutation.type === 'attributes' && mutation.target === checkbox,
        };
      };
    },
  });
}

function createTextStyleExtension() {
  return Mark.create({
    name: 'textStyle',
    excludes: 'code',
    addAttributes() {
      return { color: { default: null } };
    },
    parseHTML() {
      return [];
    },
    renderHTML({ mark }) {
      const color = typeof mark.attrs.color === 'string' ? mark.attrs.color : '';
      return ['span', { style: `color: ${color}` }, 0];
    },
  });
}

function createHighlightExtension() {
  return Mark.create({
    name: 'highlight',
    excludes: 'code',
    addAttributes() {
      return { color: { default: null } };
    },
    parseHTML() {
      return [];
    },
    renderHTML({ mark }) {
      const color = typeof mark.attrs.color === 'string' ? mark.attrs.color : '';
      return ['mark', { style: `background-color: ${color}` }, 0];
    },
  });
}

function createMathExtension() {
  return Node.create({
    name: 'math',
    inline: true,
    group: 'inline',
    atom: true,
    selectable: true,
    marks: '',
    addAttributes() {
      return { latex: { default: '' } };
    },
    parseHTML() {
      return [];
    },
    renderHTML({ node }) {
      const latex = typeof node.attrs.latex === 'string' ? node.attrs.latex : '';
      return ['span', { class: 'notes-richtext-math', 'data-type': 'math' }, latex];
    },
    renderText({ node }) {
      return typeof node.attrs.latex === 'string' ? node.attrs.latex : '';
    },
    addNodeView() {
      return ({ node, editor, getPos }) => {
        const dom = document.createElement('span');
        dom.className = 'notes-richtext-math';
        dom.dataset.type = 'math';
        dom.contentEditable = 'false';
        dom.textContent = typeof node.attrs.latex === 'string' ? node.attrs.latex : '';
        dom.setAttribute('aria-label', `Math: ${dom.textContent}`);
        dom.addEventListener('click', () => {
          const position = getPos();
          if (!editor.isEditable || typeof position !== 'number') return;
          editor.commands.setNodeSelection(position);
        });
        return { dom };
      };
    },
  });
}

function findSlashCommandRange(editor: Editor): { range: SlashCommandRange; query: string } | undefined {
  if (editor.isActive('codeBlock')) return undefined;
  const { $from, empty } = editor.state.selection;
  if (!empty) return undefined;
  const text = $from.parent.textBetween(0, $from.parentOffset, '\0', '\0');
  const match = /(?:^|\s)\/([^\s/]*)$/.exec(text);
  if (!match) return undefined;
  return {
    range: { from: $from.pos - match[1].length - 1, to: $from.pos },
    query: match[1].toLocaleLowerCase(),
  };
}

class NotesRichTextSlashMenu {
  private readonly element = document.createElement('div');
  public readonly elementId = `notes-richtext-slash-menu-${++slashMenuIdSequence}`;
  private readonly commandItems: readonly SlashCommandItem[];
  private items: readonly SlashCommandItem[] = [];
  private range: SlashCommandRange | undefined;
  private selectedIndex = 0;
  private suppressedQuery: string | undefined;
  private currentQuery: string | undefined;
  private manualOpen = false;
  private manualTrigger: HTMLElement | undefined;
  private manualSelection: { from: number; to: number } | undefined;

  public constructor(
    private readonly editor: Editor,
    private readonly overlayRoot: HTMLElement,
    requestImage: (file?: File, position?: number) => void,
    requestAttachment: (file?: File, position?: number) => void,
  ) {
    this.commandItems = [
      {
        title: 'Text', description: 'Just start typing with plain text.', searchTerms: ['p', 'paragraph'], icon: 'text',
        run: (editor, range) => { editor.chain().focus().deleteRange(range).clearNodes().setParagraph().run(); },
      },
      {
        title: 'To-do List', description: 'Track tasks with a to-do list.', searchTerms: ['todo', 'task', 'list', 'check', 'checkbox'], icon: 'todo',
        run: (editor, range) => { editor.chain().focus().deleteRange(range).toggleList('taskList', 'taskItem').run(); },
      },
      {
        title: 'Heading 1', description: 'Big section heading.', searchTerms: ['h1', 'heading1', 'title', 'big', 'large'], icon: 'heading1',
        run: (editor, range) => { editor.chain().focus().deleteRange(range).setHeading({ level: 1 }).run(); },
      },
      {
        title: 'Heading 2', description: 'Medium section heading.', searchTerms: ['h2', 'heading2', 'subtitle', 'medium'], icon: 'heading2',
        run: (editor, range) => { editor.chain().focus().deleteRange(range).setHeading({ level: 2 }).run(); },
      },
      {
        title: 'Heading 3', description: 'Small section heading.', searchTerms: ['h3', 'heading3', 'subtitle', 'small'], icon: 'heading3',
        run: (editor, range) => { editor.chain().focus().deleteRange(range).setHeading({ level: 3 }).run(); },
      },
      {
        title: 'Bullet List', description: 'Create a simple bullet list.', searchTerms: ['ul', 'unordered', 'point'], icon: 'bulletList',
        run: (editor, range) => { editor.chain().focus().deleteRange(range).toggleBulletList().run(); },
      },
      {
        title: 'Numbered List', description: 'Create a list with numbering.', searchTerms: ['ol', 'ordered'], icon: 'numberedList',
        run: (editor, range) => { editor.chain().focus().deleteRange(range).toggleOrderedList().run(); },
      },
      {
        title: 'Quote', description: 'Capture a quote.', searchTerms: ['blockquote'], icon: 'quote',
        run: (editor, range) => { editor.chain().focus().deleteRange(range).toggleBlockquote().run(); },
      },
      {
        title: 'Code', description: 'Capture a code snippet.', searchTerms: ['codeblock'], icon: 'code',
        run: (editor, range) => { editor.chain().focus().deleteRange(range).toggleCodeBlock().run(); },
      },
      {
        title: 'Table', description: 'Insert a table', searchTerms: ['grid', 'rows', 'columns'], icon: 'table',
        run: (editor, range) => {
          editor.chain().focus().deleteRange(range).insertTable({
            rows: 3,
            cols: 3,
            withHeaderRow: true,
          }).run();
        },
      },
      {
        title: 'Image', description: 'Upload an image from your computer.', searchTerms: ['photo', 'picture', 'media'], icon: 'image',
        run: (editor, range) => {
          editor.chain().focus().deleteRange(range).run();
          window.requestAnimationFrame(() => requestImage(undefined, range.from));
        },
      },
      {
        title: 'File', description: 'Upload a file attachment.', searchTerms: ['attachment', 'upload', 'document'], icon: 'file',
        run: (editor, range) => {
          editor.chain().focus().deleteRange(range).run();
          window.requestAnimationFrame(() => requestAttachment(undefined, range.from));
        },
      },
    ];
    this.element.id = this.elementId;
    this.element.className = 'notes-richtext-slash-menu hidden';
    this.element.setAttribute('role', 'listbox');
    this.element.setAttribute('aria-label', 'Insert block');
    this.element.addEventListener('mousedown', (event) => event.preventDefault());
    this.element.addEventListener('click', (event) => {
      const source = event.target;
      if (!(source instanceof Element)) return;
      const item = source.closest<HTMLElement>('[data-slash-command-index]');
      const index = Number(item?.dataset.slashCommandIndex);
      if (Number.isInteger(index)) this.select(index);
    });
    document.addEventListener('pointerdown', this.handleOutsidePointerDown, true);
    this.overlayRoot.append(this.element);
  }

  public sync(): void {
    if (this.manualOpen) {
      const selection = this.editor.state.selection;
      if (!this.manualSelection
        || selection.from !== this.manualSelection.from
        || selection.to !== this.manualSelection.to) {
        this.hide();
        return;
      }
      this.position();
      return;
    }
    const found = findSlashCommandRange(this.editor);
    if (!found) {
      this.suppressedQuery = undefined;
      this.hide();
      return;
    }
    if (found.query === this.suppressedQuery) {
      this.hide();
      return;
    }
    if (found.query !== this.currentQuery) this.selectedIndex = 0;
    this.suppressedQuery = undefined;
    this.currentQuery = found.query;
    this.range = found.range;
    this.items = this.commandItems.filter((item) => {
      const haystack = [item.title, item.description, ...item.searchTerms].join(' ').toLocaleLowerCase();
      return haystack.includes(found.query);
    });
    this.selectedIndex = this.items.length > 0 ? Math.min(this.selectedIndex, this.items.length - 1) : 0;
    this.render();
  }

  public handleKeyDown(event: KeyboardEvent): boolean {
    if (this.element.classList.contains('hidden')) return false;
    if (event.key === 'Escape') {
      this.suppressedQuery = findSlashCommandRange(this.editor)?.query;
      this.hide();
      return true;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (this.items.length === 0) return true;
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      this.selectedIndex = (this.selectedIndex + direction + this.items.length) % this.items.length;
      this.updateSelection();
      return true;
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      if (this.items.length === 0) return true;
      this.select(this.selectedIndex);
      return true;
    }
    return false;
  }

  public destroy(): void {
    document.removeEventListener('pointerdown', this.handleOutsidePointerDown, true);
    this.element.remove();
  }

  public openForCurrentBlock(trigger: HTMLElement): void {
    const selection = this.editor.state.selection;
    this.manualOpen = true;
    this.manualTrigger = trigger;
    this.manualSelection = { from: selection.from, to: selection.to };
    this.range = { from: selection.from, to: selection.from };
    this.items = this.commandItems;
    this.selectedIndex = 0;
    this.currentQuery = '';
    this.render();
  }

  public isOpenForCurrentBlock(): boolean {
    return this.manualOpen && !this.element.classList.contains('hidden');
  }

  public closeCurrentBlock(): void {
    if (this.manualOpen) this.hide();
  }

  public repositionCurrentBlock(): void {
    if (this.manualOpen) this.position();
  }

  private hide(): void {
    this.manualOpen = false;
    this.manualTrigger = undefined;
    this.manualSelection = undefined;
    this.range = undefined;
    this.items = [];
    this.currentQuery = undefined;
    this.selectedIndex = 0;
    this.element.replaceChildren();
    this.element.classList.add('hidden');
    this.editor.view.dom.removeAttribute('aria-controls');
    this.editor.view.dom.removeAttribute('aria-activedescendant');
    this.editor.view.dom.removeAttribute('aria-expanded');
  }

  private render(): void {
    const children: HTMLElement[] = this.items.map((item, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'notes-richtext-slash-item';
      button.id = `${this.elementId}-option-${index}`;
      button.dataset.slashCommandIndex = String(index);
      button.setAttribute('role', 'option');
      button.setAttribute('aria-selected', String(index === this.selectedIndex));
      const icon = document.createElement('span');
      icon.className = 'notes-richtext-slash-icon';
      icon.append(createEditorIcon(item.icon));
      const copy = document.createElement('span');
      copy.className = 'notes-richtext-slash-copy';
      const title = document.createElement('strong');
      title.textContent = item.title;
      const description = document.createElement('small');
      description.textContent = item.description;
      copy.append(title, description);
      button.append(icon, copy);
      return button;
    });
    if (children.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'notes-richtext-slash-empty';
      empty.setAttribute('role', 'status');
      empty.textContent = 'No results';
      children.push(empty);
    }
    this.element.replaceChildren(...children);
    this.element.classList.remove('hidden');
    this.editor.view.dom.setAttribute('aria-controls', this.elementId);
    this.editor.view.dom.setAttribute('aria-expanded', 'true');
    this.element.scrollTop = 0;
    this.position();
    this.updateSelection();
  }

  private updateSelection(): void {
    const options = Array.from(this.element.querySelectorAll<HTMLElement>('[data-slash-command-index]'));
    for (const [index, option] of options.entries()) {
      option.setAttribute('aria-selected', String(index === this.selectedIndex));
    }

    const selected = options[this.selectedIndex];
    if (!selected) {
      this.editor.view.dom.removeAttribute('aria-activedescendant');
      return;
    }
    this.editor.view.dom.setAttribute('aria-activedescendant', selected.id);
    const styles = window.getComputedStyle(this.element);
    this.element.scrollTop = revealMenuItemScrollTop({
      scrollTop: this.element.scrollTop,
      scrollHeight: this.element.scrollHeight,
      clientHeight: this.element.clientHeight,
      itemTop: selected.offsetTop,
      itemHeight: selected.offsetHeight,
      paddingTop: Number.parseFloat(styles.paddingTop) || 0,
      paddingBottom: Number.parseFloat(styles.paddingBottom) || 0,
    });
  }

  private position(): void {
    if (!this.range || this.element.classList.contains('hidden')) return;
    const overlayBounds = this.overlayRoot.getBoundingClientRect();
    const cursor = this.manualTrigger?.getBoundingClientRect()
      ?? this.editor.view.coordsAtPos(this.range.to);
    const menuBounds = this.element.getBoundingClientRect();
    const inset = 8;
    const left = Math.max(inset, Math.min(cursor.left - overlayBounds.left, overlayBounds.width - menuBounds.width - inset));
    let top = cursor.bottom - overlayBounds.top + inset;
    if (top + menuBounds.height > overlayBounds.height - inset) {
      top = cursor.top - overlayBounds.top - menuBounds.height - inset;
    }
    this.element.style.left = `${left}px`;
    this.element.style.top = `${Math.max(inset, top)}px`;
  }

  private select(index: number): void {
    const item = this.items[index];
    const range = this.range;
    if (!item || !range) return;
    this.hide();
    item.run(this.editor, range);
  }

  private readonly handleOutsidePointerDown = (event: PointerEvent): void => {
    if (!this.manualOpen) return;
    const source = event.target;
    if (source instanceof window.Node
      && (this.element.contains(source) || this.manualTrigger?.contains(source))) return;
    this.hide();
  };
}

interface RichTextTopLevelBlock {
  from: number;
  to: number;
  anchor: number;
  node: ProseMirrorNode;
  dom: HTMLElement;
}

function firstTextPosition(node: ProseMirrorNode, from: number): number {
  let current = node;
  let position = from;
  while (!current.isTextblock && current.childCount > 0) {
    current = current.firstChild!;
    position += 1;
  }
  return current.isTextblock ? position + 1 : from;
}

function topLevelBlockAtPosition(editor: Editor, rawPosition: number): RichTextTopLevelBlock | undefined {
  const doc = editor.state.doc;
  if (doc.childCount === 0) return undefined;
  const position = Math.max(0, Math.min(rawPosition, doc.content.size));
  const resolved = doc.resolve(position);
  let from: number | undefined;
  if (resolved.depth > 0) {
    from = resolved.before(1);
  } else if (resolved.nodeAfter) {
    from = resolved.pos;
  } else if (resolved.nodeBefore) {
    from = resolved.pos - resolved.nodeBefore.nodeSize;
  }
  if (from === undefined) return undefined;
  const node = doc.nodeAt(from);
  const dom = editor.view.nodeDOM(from);
  if (!node || !(dom instanceof HTMLElement)) return undefined;
  return {
    from,
    to: from + node.nodeSize,
    anchor: firstTextPosition(node, from),
    node,
    dom,
  };
}

class NotesRichTextBlockHandle {
  private readonly element = document.createElement('button');
  private hoveredBlock: RichTextTopLevelBlock | undefined;
  private dragging = false;
  private suppressClick = false;

  public constructor(
    private readonly editor: Editor,
    private readonly overlayRoot: HTMLElement,
    private readonly menu: NotesRichTextSlashMenu,
  ) {
    this.element.type = 'button';
    this.element.className = 'notes-richtext-block-handle hidden';
    this.element.draggable = true;
    this.element.setAttribute('aria-label', 'Drag block or open block commands');
    this.element.setAttribute('aria-haspopup', 'listbox');
    this.element.setAttribute('aria-controls', this.menu.elementId);
    this.element.setAttribute('aria-expanded', 'false');
    this.element.title = 'Drag to move · Click for commands';
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 20 20');
    icon.setAttribute('aria-hidden', 'true');
    icon.setAttribute('focusable', 'false');
    const iconPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    iconPath.setAttribute(
      'd',
      'M5 3.25a1.5 1.5 0 1 0 3 0 1.5 1.5 0 1 0-3 0m7 0a1.5 1.5 0 1 0 3 0 1.5 1.5 0 1 0-3 0M5 10a1.5 1.5 0 1 0 3 0 1.5 1.5 0 1 0-3 0m7 0a1.5 1.5 0 1 0 3 0 1.5 1.5 0 1 0-3 0m-7 6.75a1.5 1.5 0 1 0 3 0 1.5 1.5 0 1 0-3 0m7 0a1.5 1.5 0 1 0 3 0 1.5 1.5 0 1 0-3 0',
    );
    iconPath.setAttribute('fill', 'currentColor');
    icon.append(iconPath);
    this.element.append(icon);
    this.element.addEventListener('click', () => {
      if (this.suppressClick) return;
      this.selectActiveBlock();
      if (this.menu.isOpenForCurrentBlock()) {
        this.menu.closeCurrentBlock();
      } else {
        this.menu.openForCurrentBlock(this.element);
        this.editor.commands.focus();
      }
      this.sync();
    });
    this.element.addEventListener('keydown', (event) => {
      // Focus restoration may be scheduled by Tiptap. Keep the same Arrow,
      // Escape, Enter, and Tab behavior usable while the handle still owns focus.
      if (!this.menu.handleKeyDown(event)) return;
      event.preventDefault();
      event.stopPropagation();
      this.sync();
    });
    this.element.addEventListener('dragstart', this.handleDragStart);
    this.element.addEventListener('dragend', this.handleDragEnd);
    this.overlayRoot.addEventListener('pointermove', this.handlePointerMove);
    this.overlayRoot.addEventListener('pointerleave', this.handlePointerLeave);
    this.overlayRoot.append(this.element);
  }

  public sync(): void {
    if (this.editor.isDestroyed) return;
    const menuOpen = this.menu.isOpenForCurrentBlock();
    const hoveredBlock = this.validHoveredBlock();
    const target = hoveredBlock ?? this.selectionBlock();
    const visible = Boolean(
      target
      && (hoveredBlock || this.editor.isFocused || menuOpen || document.activeElement === this.element),
    );
    this.element.classList.toggle('hidden', !visible);
    this.element.setAttribute('aria-expanded', String(menuOpen));
    if (!visible || !target) return;
    const overlayBounds = this.overlayRoot.getBoundingClientRect();
    const anchor = this.blockAnchorBounds(target);
    const anchorVisible = anchor.bottom > overlayBounds.top && anchor.top < overlayBounds.bottom;
    if (!anchorVisible && !menuOpen && document.activeElement !== this.element) {
      this.element.classList.add('hidden');
      return;
    }
    const buttonBounds = this.element.getBoundingClientRect();
    const editableBounds = this.editor.view.dom.getBoundingClientRect();
    const writingPadding = Number.parseFloat(window.getComputedStyle(this.editor.view.dom).paddingLeft) || 0;
    const writingLeft = editableBounds.left - overlayBounds.left + writingPadding;
    const inset = 2;
    const left = Math.max(
      inset,
      Math.min(writingLeft - buttonBounds.width - 4, overlayBounds.width - buttonBounds.width - inset),
    );
    const lineMiddle = (anchor.top + anchor.bottom) / 2 - overlayBounds.top;
    const top = Math.max(
      inset,
      Math.min(lineMiddle - buttonBounds.height / 2, overlayBounds.height - buttonBounds.height - inset),
    );
    this.element.style.left = `${left}px`;
    this.element.style.top = `${top}px`;
    this.element.dataset.blockType = target.node.type.name;
    if (menuOpen) this.menu.repositionCurrentBlock();
  }

  public destroy(): void {
    this.overlayRoot.removeEventListener('pointermove', this.handlePointerMove);
    this.overlayRoot.removeEventListener('pointerleave', this.handlePointerLeave);
    this.element.removeEventListener('dragstart', this.handleDragStart);
    this.element.removeEventListener('dragend', this.handleDragEnd);
    if (!this.editor.isDestroyed) this.editor.view.dragging = null;
    this.element.remove();
  }

  private selectionBlock(): RichTextTopLevelBlock | undefined {
    const selection = this.editor.state.selection;
    const position = selection instanceof NodeSelection ? selection.from : selection.head;
    return topLevelBlockAtPosition(this.editor, position);
  }

  private validHoveredBlock(): RichTextTopLevelBlock | undefined {
    const target = this.hoveredBlock;
    if (!target || this.editor.state.doc.nodeAt(target.from) !== target.node) {
      this.hoveredBlock = undefined;
      return undefined;
    }
    return target;
  }

  private blockAtGutterPoint(clientX: number, clientY: number): RichTextTopLevelBlock | undefined {
    const editableBounds = this.editor.view.dom.getBoundingClientRect();
    if (clientY < editableBounds.top || clientY > editableBounds.bottom) return undefined;
    const writingPadding = Number.parseFloat(
      window.getComputedStyle(this.editor.view.dom).paddingLeft,
    ) || 0;
    const writingLeft = editableBounds.left + writingPadding;
    const gutterLeft = editableBounds.left;
    const gutterRight = writingLeft + 4;
    if (clientX < gutterLeft || clientX > gutterRight) return undefined;
    const position = this.editor.view.posAtCoords({
      left: Math.min(editableBounds.right - 1, writingLeft + 1),
      top: clientY,
    })?.pos;
    return position === undefined ? undefined : topLevelBlockAtPosition(this.editor, position);
  }

  private blockAnchorBounds(target: RichTextTopLevelBlock): {
    top: number;
    bottom: number;
    left: number;
    right: number;
  } {
    if (target.anchor > target.from) {
      try {
        return this.editor.view.coordsAtPos(target.anchor);
      } catch {
        // Atom blocks and custom node views use their DOM surface below.
      }
    }
    const bounds = target.dom.getBoundingClientRect();
    const lineHeight = Number.parseFloat(window.getComputedStyle(target.dom).lineHeight) || 24;
    return {
      top: bounds.top,
      bottom: Math.min(bounds.bottom, bounds.top + lineHeight),
      left: bounds.left,
      right: bounds.right,
    };
  }

  private selectActiveBlock(): void {
    const target = this.validHoveredBlock() ?? this.selectionBlock();
    if (!target) return;
    if (target.anchor > target.from) {
      this.editor.commands.setTextSelection(target.anchor);
    } else {
      this.editor.commands.setNodeSelection(target.from);
    }
  }

  private readonly handlePointerMove = (event: PointerEvent): void => {
    if (this.dragging || this.menu.isOpenForCurrentBlock()) return;
    const source = event.target;
    const target = source instanceof globalThis.Node && this.element.contains(source)
      ? this.validHoveredBlock()
      : this.blockAtGutterPoint(event.clientX, event.clientY);
    if (target && this.hoveredBlock
      && target.from === this.hoveredBlock.from
      && target.node === this.hoveredBlock.node) return;
    if (!target && !this.hoveredBlock) return;
    this.hoveredBlock = target;
    this.sync();
  };

  private readonly handlePointerLeave = (): void => {
    if (this.dragging || this.menu.isOpenForCurrentBlock()) return;
    this.hoveredBlock = undefined;
    this.sync();
  };

  private readonly handleDragStart = (event: DragEvent): void => {
    const target = this.validHoveredBlock() ?? this.selectionBlock();
    const dataTransfer = event.dataTransfer;
    if (!target || !dataTransfer || !this.editor.isEditable) {
      event.preventDefault();
      return;
    }
    this.menu.closeCurrentBlock();
    const selection = NodeSelection.create(this.editor.state.doc, target.from);
    this.editor.view.dispatch(this.editor.state.tr.setSelection(selection));
    const serialized = this.editor.view.serializeForClipboard(selection.content());
    dataTransfer.clearData();
    dataTransfer.setData('text/html', serialized.dom.innerHTML);
    dataTransfer.setData('text/plain', serialized.text);
    dataTransfer.effectAllowed = 'copyMove';
    this.editor.view.dragging = { slice: serialized.slice, move: true };
    this.dragging = true;
    this.suppressClick = true;
    this.element.dataset.dragging = 'true';

    const preview = target.dom.cloneNode(true);
    if (preview instanceof HTMLElement) {
      preview.classList.add('notes-richtext-block-drag-preview');
      preview.removeAttribute('contenteditable');
      preview.setAttribute('aria-hidden', 'true');
      document.body.append(preview);
      dataTransfer.setDragImage(preview, 12, 12);
      window.setTimeout(() => preview.remove(), 0);
    }
  };

  private readonly handleDragEnd = (): void => {
    if (!this.editor.isDestroyed) this.editor.view.dragging = null;
    this.dragging = false;
    this.element.removeAttribute('data-dragging');
    this.hoveredBlock = undefined;
    window.setTimeout(() => {
      this.suppressClick = false;
    }, 0);
    this.sync();
  };
}

interface RichTextCodeBlockTarget {
  position: number;
  node: ProseMirrorNode;
  dom: HTMLElement;
}

interface RichTextCodeLanguageChoice {
  value: string | null;
  label: string;
  searchText: string;
}

const RICH_TEXT_CODE_LANGUAGE_CHOICES: readonly RichTextCodeLanguageChoice[] = Object.freeze([
  { value: null, label: 'Auto', searchText: 'auto automatic detect' },
  ...CODE_HIGHLIGHT_LANGUAGES.map((item) => ({
    value: item.value,
    label: item.label,
    searchText: codeHighlightSearchText(item),
  })),
]);

function codeBlockTargetAtPosition(editor: Editor, rawPosition: number): RichTextCodeBlockTarget | undefined {
  const doc = editor.state.doc;
  const position = Math.max(0, Math.min(rawPosition, doc.content.size));
  const resolved = doc.resolve(position);
  for (let depth = resolved.depth; depth > 0; depth -= 1) {
    const node = resolved.node(depth);
    if (node.type.name !== 'codeBlock') continue;
    const nodePosition = resolved.before(depth);
    const dom = editor.view.nodeDOM(nodePosition);
    return dom instanceof HTMLElement ? { position: nodePosition, node, dom } : undefined;
  }
  const adjacent = resolved.nodeAfter?.type.name === 'codeBlock'
    ? { position: resolved.pos, node: resolved.nodeAfter }
    : resolved.nodeBefore?.type.name === 'codeBlock'
      ? { position: resolved.pos - resolved.nodeBefore.nodeSize, node: resolved.nodeBefore }
      : undefined;
  if (!adjacent) return undefined;
  const dom = editor.view.nodeDOM(adjacent.position);
  return dom instanceof HTMLElement ? { ...adjacent, dom } : undefined;
}

interface RichTextCodeBlockTextRange {
  position: number;
  from: number;
  to: number;
}

function codeBlockTextRangeAtPosition(
  editor: Editor,
  rawPosition: number,
): RichTextCodeBlockTextRange | undefined {
  const doc = editor.state.doc;
  const position = Math.max(0, Math.min(rawPosition, doc.content.size));
  const resolved = doc.resolve(position);
  for (let depth = resolved.depth; depth > 0; depth -= 1) {
    const node = resolved.node(depth);
    if (node.type.name !== 'codeBlock') continue;
    const nodePosition = resolved.before(depth);
    return {
      position: nodePosition,
      from: nodePosition + 1,
      to: nodePosition + 1 + node.content.size,
    };
  }
  return undefined;
}

function handleScopedCodeBlockSelectAll(editor: Editor, event: KeyboardEvent): boolean {
  const modifier = event.metaKey || event.ctrlKey;
  if (!modifier
    || event.altKey
    || event.shiftKey
    || event.isComposing
    || event.key.toLocaleLowerCase() !== 'a') return false;

  const selection = editor.state.selection;
  if (!(selection instanceof TextSelection)) return false;
  const start = codeBlockTextRangeAtPosition(editor, selection.from);
  const end = codeBlockTextRangeAtPosition(editor, selection.to);
  if (!start
    || !end
    || start.position !== end.position
    || selection.from < start.from
    || selection.to > start.to
    || start.from === start.to) return false;

  const alreadySelected = selection.from === start.from && selection.to === start.to;
  if (alreadySelected) {
    if (!event.repeat) return false;
    event.preventDefault();
    return true;
  }

  const selected = editor.commands.setTextSelection({ from: start.from, to: start.to });
  if (selected) event.preventDefault();
  return selected;
}

class NotesRichTextCodeLanguageMenu {
  private readonly trigger = document.createElement('button');
  private readonly triggerLabel = document.createElement('span');
  private readonly menu = document.createElement('div');
  private readonly search = document.createElement('input');
  private readonly options = document.createElement('div');
  private readonly menuId = `notes-richtext-code-language-${++codeLanguageMenuIdSequence}`;
  private filteredChoices: readonly RichTextCodeLanguageChoice[] = RICH_TEXT_CODE_LANGUAGE_CHOICES;
  private selectedIndex = 0;
  private hoveredTarget: RichTextCodeBlockTarget | undefined;
  private menuTarget: RichTextCodeBlockTarget | undefined;

  public constructor(
    private readonly editor: Editor,
    private readonly overlayRoot: HTMLElement,
  ) {
    this.trigger.type = 'button';
    this.trigger.className = 'notes-richtext-code-language-trigger hidden';
    this.trigger.setAttribute('aria-label', 'Choose code language');
    this.trigger.setAttribute('aria-haspopup', 'dialog');
    this.trigger.setAttribute('aria-controls', this.menuId);
    this.trigger.setAttribute('aria-expanded', 'false');
    this.triggerLabel.className = 'notes-richtext-code-language-label';
    const chevron = createStrokeIcon(['m4.25 6.25 3.75 3.5 3.75-3.5']);
    chevron.classList.add('notes-richtext-code-language-chevron');
    this.trigger.append(this.triggerLabel, chevron);

    this.menu.id = this.menuId;
    this.menu.className = 'notes-richtext-code-language-menu hidden';
    this.menu.setAttribute('role', 'dialog');
    this.menu.setAttribute('aria-label', 'Code language');
    const searchWrap = document.createElement('label');
    searchWrap.className = 'notes-richtext-code-language-search-wrap';
    searchWrap.append(createStrokeIcon([
      'M7 2.75a4.25 4.25 0 1 0 0 8.5 4.25 4.25 0 0 0 0-8.5z',
      'm10.25 10.25 3 3',
    ]));
    this.search.type = 'search';
    this.search.className = 'notes-richtext-code-language-search';
    this.search.placeholder = 'Search languages';
    this.search.autocomplete = 'off';
    this.search.spellcheck = false;
    this.search.setAttribute('aria-label', 'Search code languages');
    this.search.setAttribute('aria-controls', `${this.menuId}-options`);
    searchWrap.append(this.search);
    this.options.id = `${this.menuId}-options`;
    this.options.className = 'notes-richtext-code-language-options';
    this.options.setAttribute('role', 'listbox');
    this.options.setAttribute('aria-label', 'Code languages');
    this.menu.append(searchWrap, this.options);

    this.trigger.addEventListener('pointerdown', this.handleTriggerPointerDown);
    this.trigger.addEventListener('click', this.handleTriggerClick);
    this.trigger.addEventListener('keydown', this.handleTriggerKeyDown);
    this.search.addEventListener('input', this.handleSearchInput);
    this.search.addEventListener('keydown', this.handleSearchKeyDown);
    this.options.addEventListener('click', this.handleOptionsClick);
    this.menu.addEventListener('focusout', this.handleMenuFocusOut);
    document.addEventListener('pointerdown', this.handleOutsidePointerDown, true);
    this.overlayRoot.addEventListener('pointermove', this.handlePointerMove);
    this.overlayRoot.addEventListener('pointerleave', this.handlePointerLeave);
    this.overlayRoot.append(this.trigger, this.menu);
  }

  public sync(): void {
    if (this.editor.isDestroyed) return;
    const menuOpen = this.isOpen();
    const hovered = this.validTarget(this.hoveredTarget);
    if (!hovered) this.hoveredTarget = undefined;
    const target = menuOpen
      ? this.validTarget(this.menuTarget)
      : hovered ?? this.selectionTarget();
    if (menuOpen && !target) {
      this.close();
      return;
    }
    const controlFocused = document.activeElement === this.trigger || this.menu.contains(document.activeElement);
    const visible = Boolean(
      this.editor.isEditable
      && target
      && (hovered || this.editor.isFocused || menuOpen || controlFocused),
    );
    this.trigger.classList.toggle('hidden', !visible);
    if (!visible || !target) return;
    this.updateTrigger(target);
    this.positionTrigger(target);
    if (menuOpen) this.positionMenu();
  }

  public handleKeyDown(event: KeyboardEvent): boolean {
    if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.key !== 'F10') return false;
    const target = this.selectionTarget();
    if (!target || !this.editor.isEditable) return false;
    event.preventDefault();
    this.hoveredTarget = undefined;
    this.menuTarget = target;
    this.sync();
    this.trigger.focus();
    return true;
  }

  public destroy(): void {
    this.trigger.removeEventListener('pointerdown', this.handleTriggerPointerDown);
    this.trigger.removeEventListener('click', this.handleTriggerClick);
    this.trigger.removeEventListener('keydown', this.handleTriggerKeyDown);
    this.search.removeEventListener('input', this.handleSearchInput);
    this.search.removeEventListener('keydown', this.handleSearchKeyDown);
    this.options.removeEventListener('click', this.handleOptionsClick);
    this.menu.removeEventListener('focusout', this.handleMenuFocusOut);
    document.removeEventListener('pointerdown', this.handleOutsidePointerDown, true);
    this.overlayRoot.removeEventListener('pointermove', this.handlePointerMove);
    this.overlayRoot.removeEventListener('pointerleave', this.handlePointerLeave);
    this.trigger.remove();
    this.menu.remove();
  }

  private isOpen(): boolean {
    return !this.menu.classList.contains('hidden');
  }

  private selectionTarget(): RichTextCodeBlockTarget | undefined {
    const selection = this.editor.state.selection;
    const position = selection instanceof NodeSelection ? selection.from : selection.head;
    return codeBlockTargetAtPosition(this.editor, position);
  }

  private validTarget(target: RichTextCodeBlockTarget | undefined): RichTextCodeBlockTarget | undefined {
    if (!target || this.editor.state.doc.nodeAt(target.position) !== target.node) return undefined;
    const dom = this.editor.view.nodeDOM(target.position);
    return dom instanceof HTMLElement ? { ...target, dom } : undefined;
  }

  private targetAtPointer(event: PointerEvent): RichTextCodeBlockTarget | undefined {
    const source = event.target;
    if (!(source instanceof Element) || !this.editor.view.dom.contains(source)) return undefined;
    const block = source.closest('pre');
    if (!block || !this.editor.view.dom.contains(block)) return undefined;
    try {
      return codeBlockTargetAtPosition(this.editor, this.editor.view.posAtDOM(block, 0));
    } catch {
      return undefined;
    }
  }

  private rawLanguage(target: RichTextCodeBlockTarget): string | undefined {
    const value = target.node.attrs.language;
    return typeof value === 'string' && value ? value : undefined;
  }

  private selectedLanguageValue(target: RichTextCodeBlockTarget): string | null {
    return findCodeHighlightLanguage(this.rawLanguage(target))?.value ?? null;
  }

  private updateTrigger(target: RichTextCodeBlockTarget): void {
    const rawLanguage = this.rawLanguage(target);
    const knownLanguage = findCodeHighlightLanguage(rawLanguage);
    this.triggerLabel.textContent = knownLanguage?.label ?? 'Auto';
    this.trigger.title = rawLanguage && !knownLanguage
      ? `Unsupported saved language “${rawLanguage}”; using Auto`
      : `${knownLanguage?.label ?? 'Auto-detect'} code language`;
  }

  private open(): void {
    const target = this.validTarget(this.menuTarget) ?? this.validTarget(this.hoveredTarget) ?? this.selectionTarget();
    if (!target || !this.editor.isEditable) return;
    this.menuTarget = target;
    this.search.value = '';
    this.filteredChoices = RICH_TEXT_CODE_LANGUAGE_CHOICES;
    const selectedValue = this.selectedLanguageValue(target);
    this.selectedIndex = Math.max(
      0,
      this.filteredChoices.findIndex((choice) => choice.value === selectedValue),
    );
    this.renderOptions();
    this.menu.classList.remove('hidden');
    this.trigger.setAttribute('aria-expanded', 'true');
    this.positionTrigger(target);
    this.positionMenu();
    window.requestAnimationFrame(() => {
      if (!this.isOpen()) return;
      this.search.focus();
      this.updateActiveDescendant();
    });
  }

  private close(): void {
    this.menu.classList.add('hidden');
    this.trigger.setAttribute('aria-expanded', 'false');
    this.search.removeAttribute('aria-activedescendant');
    this.menuTarget = undefined;
  }

  private renderOptions(): void {
    if (this.filteredChoices.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'notes-richtext-code-language-empty';
      empty.setAttribute('role', 'status');
      empty.textContent = 'No languages found';
      this.options.replaceChildren(empty);
      this.search.removeAttribute('aria-activedescendant');
      return;
    }
    const selectedValue = this.menuTarget ? this.selectedLanguageValue(this.menuTarget) : null;
    this.options.replaceChildren(...this.filteredChoices.map((choice, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'notes-richtext-code-language-option';
      button.id = `${this.menuId}-option-${index}`;
      button.dataset.codeLanguageIndex = String(index);
      button.setAttribute('role', 'option');
      button.setAttribute('aria-selected', String(choice.value === selectedValue));
      button.dataset.active = String(index === this.selectedIndex);
      const label = document.createElement('span');
      label.textContent = choice.label;
      const check = document.createElement('span');
      check.className = 'notes-richtext-code-language-check';
      check.setAttribute('aria-hidden', 'true');
      check.textContent = '✓';
      button.append(label, check);
      return button;
    }));
    this.updateActiveDescendant();
  }

  private updateActiveDescendant(): void {
    const buttons = Array.from(this.options.querySelectorAll<HTMLElement>('[data-code-language-index]'));
    for (const [index, button] of buttons.entries()) {
      button.dataset.active = String(index === this.selectedIndex);
    }
    const active = buttons[this.selectedIndex];
    if (!active) {
      this.search.removeAttribute('aria-activedescendant');
      return;
    }
    this.search.setAttribute('aria-activedescendant', active.id);
    const styles = window.getComputedStyle(this.options);
    this.options.scrollTop = revealMenuItemScrollTop({
      scrollTop: this.options.scrollTop,
      scrollHeight: this.options.scrollHeight,
      clientHeight: this.options.clientHeight,
      itemTop: active.offsetTop,
      itemHeight: active.offsetHeight,
      paddingTop: Number.parseFloat(styles.paddingTop) || 0,
      paddingBottom: Number.parseFloat(styles.paddingBottom) || 0,
    });
  }

  private select(index: number): void {
    const choice = this.filteredChoices[index];
    const target = this.validTarget(this.menuTarget);
    if (!choice || !target) {
      this.close();
      return;
    }
    const attributes: Record<string, unknown> = { ...target.node.attrs, language: choice.value };
    this.close();
    this.editor.view.dispatch(
      this.editor.state.tr.setNodeMarkup(target.position, undefined, attributes),
    );
    this.editor.commands.focus();
    this.sync();
  }

  private positionTrigger(target: RichTextCodeBlockTarget): void {
    const overlayBounds = this.overlayRoot.getBoundingClientRect();
    const blockBounds = target.dom.getBoundingClientRect();
    if (blockBounds.bottom <= overlayBounds.top || blockBounds.top >= overlayBounds.bottom) {
      if (!this.isOpen() && document.activeElement !== this.trigger) this.trigger.classList.add('hidden');
      return;
    }
    const triggerBounds = this.trigger.getBoundingClientRect();
    const inset = 10;
    const visibleTop = Math.max(blockBounds.top, overlayBounds.top);
    const visibleRight = Math.min(blockBounds.right, overlayBounds.right);
    const left = Math.max(
      inset,
      Math.min(
        visibleRight - overlayBounds.left - triggerBounds.width - inset,
        overlayBounds.width - triggerBounds.width - inset,
      ),
    );
    const preferredTop = visibleTop - overlayBounds.top + inset;
    const top = Math.max(inset, Math.min(preferredTop, overlayBounds.height - triggerBounds.height - inset));
    this.trigger.style.left = `${left}px`;
    this.trigger.style.top = `${top}px`;
  }

  private positionMenu(): void {
    if (!this.isOpen()) return;
    const overlayBounds = this.overlayRoot.getBoundingClientRect();
    const triggerBounds = this.trigger.getBoundingClientRect();
    const menuBounds = this.menu.getBoundingClientRect();
    const inset = 8;
    const left = Math.max(
      inset,
      Math.min(triggerBounds.right - overlayBounds.left - menuBounds.width, overlayBounds.width - menuBounds.width - inset),
    );
    let top = triggerBounds.bottom - overlayBounds.top + 6;
    if (top + menuBounds.height > overlayBounds.height - inset) {
      top = triggerBounds.top - overlayBounds.top - menuBounds.height - 6;
    }
    this.menu.style.left = `${left}px`;
    this.menu.style.top = `${Math.max(inset, top)}px`;
  }

  private readonly handleTriggerPointerDown = (event: PointerEvent): void => {
    event.preventDefault();
  };

  private readonly handleTriggerClick = (): void => {
    if (this.isOpen()) this.close();
    else this.open();
    this.sync();
  };

  private readonly handleTriggerKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && this.isOpen()) {
      event.preventDefault();
      this.close();
      this.trigger.focus();
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    if (!this.isOpen()) this.open();
  };

  private readonly handleSearchInput = (): void => {
    const query = this.search.value.trim().toLocaleLowerCase();
    this.filteredChoices = query
      ? RICH_TEXT_CODE_LANGUAGE_CHOICES.filter((choice) => choice.searchText.includes(query))
      : RICH_TEXT_CODE_LANGUAGE_CHOICES;
    this.selectedIndex = 0;
    this.renderOptions();
  };

  private readonly handleSearchKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.close();
      this.trigger.focus();
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      if (this.filteredChoices.length === 0) return;
      event.preventDefault();
      this.selectedIndex = event.key === 'Home' ? 0 : this.filteredChoices.length - 1;
      this.updateActiveDescendant();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (this.filteredChoices.length === 0) return;
      event.preventDefault();
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      this.selectedIndex = (this.selectedIndex + direction + this.filteredChoices.length)
        % this.filteredChoices.length;
      this.updateActiveDescendant();
      return;
    }
    if (event.key === 'Enter' && this.filteredChoices.length > 0) {
      event.preventDefault();
      this.select(this.selectedIndex);
    }
  };

  private readonly handleOptionsClick = (event: MouseEvent): void => {
    const source = event.target;
    if (!(source instanceof Element)) return;
    const button = source.closest<HTMLElement>('[data-code-language-index]');
    const index = Number(button?.dataset.codeLanguageIndex);
    if (!Number.isInteger(index)) return;
    event.preventDefault();
    this.select(index);
  };

  private readonly handleMenuFocusOut = (): void => {
    window.setTimeout(() => {
      if (!this.isOpen()) return;
      const active = document.activeElement;
      if (active === this.trigger || this.menu.contains(active)) return;
      this.close();
      this.sync();
    }, 0);
  };

  private readonly handleOutsidePointerDown = (event: PointerEvent): void => {
    if (!this.isOpen()) return;
    const source = event.target;
    if (source instanceof globalThis.Node
      && (this.trigger.contains(source) || this.menu.contains(source))) return;
    this.close();
    this.sync();
  };

  private readonly handlePointerMove = (event: PointerEvent): void => {
    if (this.isOpen()) return;
    const source = event.target;
    if (source instanceof globalThis.Node
      && (this.trigger.contains(source) || this.menu.contains(source))) return;
    const target = this.targetAtPointer(event);
    if (target && this.hoveredTarget
      && target.position === this.hoveredTarget.position
      && target.node === this.hoveredTarget.node) return;
    if (!target && !this.hoveredTarget) return;
    this.hoveredTarget = target;
    this.sync();
  };

  private readonly handlePointerLeave = (): void => {
    if (this.isOpen() || document.activeElement === this.trigger || this.menu.contains(document.activeElement)) return;
    this.hoveredTarget = undefined;
    this.sync();
  };
}

class NotesRichTextBubbleMenu {
  private readonly blockTrigger: HTMLButtonElement;
  private readonly blockLabel: HTMLElement;
  private readonly linkTrigger: HTMLButtonElement;
  private readonly colorTrigger: HTMLButtonElement;
  private readonly colorPreview: HTMLElement;
  private readonly blockMenu = document.createElement('div');
  private readonly linkForm = document.createElement('form');
  private readonly linkInput = document.createElement('input');
  private readonly applyLinkButton = document.createElement('button');
  private readonly removeLinkButton = document.createElement('button');
  private readonly colorMenu = document.createElement('div');

  public constructor(
    private readonly editor: Editor,
    private readonly toolbar: HTMLElement,
    private readonly overlayRoot: HTMLElement,
    private readonly onError: (message: string) => void,
  ) {
    const blockTrigger = toolbar.querySelector<HTMLButtonElement>('[data-richtext-block-trigger]');
    const blockLabel = toolbar.querySelector<HTMLElement>('[data-richtext-block-label]');
    const linkTrigger = toolbar.querySelector<HTMLButtonElement>('[data-richtext-link-trigger]');
    const colorTrigger = toolbar.querySelector<HTMLButtonElement>('[data-richtext-color-trigger]');
    const colorPreview = toolbar.querySelector<HTMLElement>('[data-richtext-color-preview]');
    if (!blockTrigger || !blockLabel || !linkTrigger || !colorTrigger || !colorPreview) {
      throw new Error('The Rich Text selection toolbar is incomplete.');
    }
    this.blockTrigger = blockTrigger;
    this.blockLabel = blockLabel;
    this.linkTrigger = linkTrigger;
    this.colorTrigger = colorTrigger;
    this.colorPreview = colorPreview;

    this.blockMenu.className = 'notes-richtext-block-menu hidden';
    this.blockMenu.setAttribute('role', 'listbox');
    this.blockMenu.setAttribute('aria-label', 'Block type');
    for (const item of RICH_TEXT_BLOCK_ITEMS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'notes-richtext-block-item';
      button.dataset.richtextBlock = item.name;
      button.setAttribute('role', 'option');
      const iconFrame = document.createElement('span');
      iconFrame.className = 'notes-richtext-block-icon';
      iconFrame.append(createEditorIcon(item.icon));
      const label = document.createElement('span');
      label.className = 'notes-richtext-block-item-label';
      label.textContent = item.label;
      const check = document.createElement('span');
      check.className = 'notes-richtext-block-check';
      check.setAttribute('aria-hidden', 'true');
      check.textContent = '✓';
      button.append(iconFrame, label, check);
      this.blockMenu.append(button);
    }

    this.linkForm.className = 'notes-richtext-link-popover hidden';
    this.linkForm.setAttribute('role', 'dialog');
    this.linkForm.setAttribute('aria-label', 'Edit link');
    this.linkInput.className = 'notes-richtext-link-input';
    this.linkInput.type = 'url';
    this.linkInput.placeholder = 'Paste a link';
    this.linkInput.setAttribute('aria-label', 'Link URL');
    this.linkInput.autocomplete = 'off';
    this.linkInput.spellcheck = false;
    this.applyLinkButton.type = 'submit';
    this.applyLinkButton.className = 'notes-richtext-link-action notes-richtext-link-apply';
    this.applyLinkButton.setAttribute('aria-label', 'Apply link');
    this.applyLinkButton.title = 'Apply link';
    this.applyLinkButton.append(createStrokeIcon(['m3 8 3 3 7-7']));
    this.removeLinkButton.type = 'button';
    this.removeLinkButton.className = 'notes-richtext-link-action notes-richtext-link-remove';
    this.removeLinkButton.dataset.richtextLinkRemove = '';
    this.removeLinkButton.setAttribute('aria-label', 'Remove link');
    this.removeLinkButton.title = 'Remove link';
    this.removeLinkButton.append(createStrokeIcon(['M4.5 5.5v7h7v-7', 'M3.5 3.5h9', 'M6 3.5v-1h4v1', 'M7 7v3.5', 'M9 7v3.5']));
    this.linkForm.append(this.linkInput, this.applyLinkButton, this.removeLinkButton);

    this.colorMenu.className = 'notes-richtext-color-menu hidden';
    this.colorMenu.setAttribute('role', 'dialog');
    this.colorMenu.setAttribute('aria-label', 'Text color and background');
    this.appendColorSection('Color', 'text', RICH_TEXT_COLORS);
    this.appendColorSection('Background', 'background', RICH_TEXT_HIGHLIGHTS);
    this.toolbar.append(this.blockMenu, this.linkForm, this.colorMenu);

    this.toolbar.addEventListener('mousedown', this.handleMouseDown);
    this.toolbar.addEventListener('click', this.handleClick);
    this.toolbar.addEventListener('keydown', this.handleToolbarKeyDown);
    this.linkForm.addEventListener('submit', this.handleLinkSubmit);
    document.addEventListener('pointerdown', this.handleDocumentPointerDown, true);
  }

  public sync(): void {
    if (this.editor.isDestroyed) return;
    const hasTextSelection = this.editor.isEditable && hasFormattableSelection(this.editor);
    const editingLink = !this.linkForm.classList.contains('hidden')
      && (this.toolbar.contains(document.activeElement) || this.editor.isFocused);
    if (!hasTextSelection && !editingLink) {
      this.hide();
      return;
    }
    this.updateBlockState();
    this.updateColorState();
    this.toolbar.classList.remove('hidden');
    this.position();
  }

  public destroy(): void {
    this.toolbar.removeEventListener('mousedown', this.handleMouseDown);
    this.toolbar.removeEventListener('click', this.handleClick);
    this.toolbar.removeEventListener('keydown', this.handleToolbarKeyDown);
    this.linkForm.removeEventListener('submit', this.handleLinkSubmit);
    document.removeEventListener('pointerdown', this.handleDocumentPointerDown, true);
    this.blockMenu.remove();
    this.linkForm.remove();
    this.colorMenu.remove();
  }

  private appendColorSection(
    title: string,
    kind: 'text' | 'background',
    items: readonly RichTextColorItem[],
  ): void {
    const section = document.createElement('section');
    section.className = 'notes-richtext-color-section';
    const heading = document.createElement('h3');
    heading.textContent = title;
    section.append(heading);
    for (const item of items) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'notes-richtext-color-item';
      button.dataset.richtextColorKind = kind;
      if (item.color) button.dataset.richtextColor = item.color;
      const swatch = document.createElement('span');
      swatch.className = 'notes-richtext-color-swatch';
      swatch.textContent = 'A';
      if (kind === 'text' && item.color) swatch.style.color = item.color;
      if (kind === 'background' && item.color) swatch.style.backgroundColor = item.color;
      const label = document.createElement('span');
      label.className = 'notes-richtext-color-label';
      label.textContent = item.name;
      const check = document.createElement('span');
      check.className = 'notes-richtext-color-check';
      check.setAttribute('aria-hidden', 'true');
      check.textContent = '✓';
      button.append(swatch, label, check);
      section.append(button);
    }
    this.colorMenu.append(section);
  }

  private readonly handleMouseDown = (event: MouseEvent): void => {
    if (!(event.target instanceof HTMLInputElement)) event.preventDefault();
  };

  private readonly handleClick = (event: MouseEvent): void => {
    const source = event.target;
    if (!(source instanceof Element)) return;
    if (source.closest('[data-richtext-block-trigger]')) {
      event.preventDefault();
      const opening = this.blockMenu.classList.contains('hidden');
      this.closePopovers();
      if (opening) {
        this.blockMenu.classList.remove('hidden');
        this.blockTrigger.setAttribute('aria-expanded', 'true');
        this.positionPopover(this.blockMenu, this.blockTrigger);
      }
      return;
    }
    const blockItem = source.closest<HTMLElement>('[data-richtext-block]');
    if (blockItem?.dataset.richtextBlock) {
      event.preventDefault();
      this.applyBlock(blockItem.dataset.richtextBlock);
      return;
    }
    if (source.closest('[data-richtext-link-trigger]')) {
      event.preventDefault();
      const opening = this.linkForm.classList.contains('hidden');
      this.closePopovers();
      if (opening) this.openLinkForm();
      return;
    }
    if (source.closest('[data-richtext-link-remove]')) {
      event.preventDefault();
      this.editor.chain().focus().extendMarkRange('link').unsetLink().run();
      this.closePopovers();
      return;
    }
    if (source.closest('[data-richtext-color-trigger]')) {
      event.preventDefault();
      const opening = this.colorMenu.classList.contains('hidden');
      this.closePopovers();
      if (opening) {
        this.colorMenu.classList.remove('hidden');
        this.colorTrigger.setAttribute('aria-expanded', 'true');
        this.positionPopover(this.colorMenu, this.colorTrigger);
      }
      return;
    }
    const colorItem = source.closest<HTMLElement>('[data-richtext-color-kind]');
    if (colorItem?.dataset.richtextColorKind) {
      event.preventDefault();
      const kind = colorItem.dataset.richtextColorKind;
      if (kind === 'text' || kind === 'background') {
        this.applyColor(kind, colorItem.dataset.richtextColor);
      }
    }
  };

  private readonly handleToolbarKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    this.closePopovers();
    this.editor.commands.focus();
  };

  private readonly handleLinkSubmit = (event: SubmitEvent): void => {
    event.preventDefault();
    const href = this.linkInput.value.trim();
    if (!href) {
      this.editor.chain().focus().extendMarkRange('link').unsetLink().run();
      this.closePopovers();
      return;
    }
    if (!isAllowedRichTextLinkHref(href)) {
      safelyReport(this.onError, 'Enter an absolute HTTP or HTTPS link.');
      this.linkInput.focus();
      this.linkInput.select();
      return;
    }
    const chain = this.editor.chain().focus();
    if (this.editor.isActive('link')) chain.extendMarkRange('link');
    chain.setLink({ href }).run();
    this.closePopovers();
  };

  private readonly handleDocumentPointerDown = (event: PointerEvent): void => {
    const source = event.target;
    if (source instanceof globalThis.Node && this.toolbar.contains(source)) return;
    this.closePopovers();
  };

  private applyBlock(name: string): void {
    const chain = this.editor.chain().focus().clearNodes();
    switch (name) {
      case 'paragraph': chain.setParagraph().run(); break;
      case 'taskList': chain.toggleList('taskList', 'taskItem').run(); break;
      case 'heading1': chain.toggleHeading({ level: 1 }).run(); break;
      case 'heading2': chain.toggleHeading({ level: 2 }).run(); break;
      case 'heading3': chain.toggleHeading({ level: 3 }).run(); break;
      case 'bulletList': chain.toggleBulletList().run(); break;
      case 'orderedList': chain.toggleOrderedList().run(); break;
      case 'blockquote': chain.toggleBlockquote().run(); break;
      case 'codeBlock': chain.toggleCodeBlock().run(); break;
      default: return;
    }
    this.closePopovers();
  }

  private applyColor(kind: 'text' | 'background', color?: string): void {
    const mark = kind === 'text' ? 'textStyle' : 'highlight';
    const chain = this.editor.chain().focus();
    if (color) chain.setMark(mark, { color }).run();
    else chain.unsetMark(mark).run();
    this.closePopovers();
    this.updateColorState();
  }

  private openLinkForm(): void {
    const href = this.editor.getAttributes('link').href;
    const linkActive = this.editor.isActive('link');
    this.linkInput.value = typeof href === 'string' ? href : '';
    this.applyLinkButton.hidden = linkActive;
    this.removeLinkButton.hidden = !linkActive;
    this.linkForm.classList.remove('hidden');
    this.linkTrigger.setAttribute('aria-expanded', 'true');
    this.positionPopover(this.linkForm, this.linkTrigger);
    window.requestAnimationFrame(() => {
      this.linkInput.focus();
      this.linkInput.select();
    });
  }

  private isBlockActive(name: string): boolean {
    if (name.startsWith('heading')) {
      return this.editor.isActive('heading', { level: Number(name.slice(-1)) });
    }
    if (name === 'paragraph') {
      return this.editor.isActive('paragraph')
        && !this.editor.isActive('taskList')
        && !this.editor.isActive('bulletList')
        && !this.editor.isActive('orderedList')
        && !this.editor.isActive('blockquote')
        && !this.editor.isActive('codeBlock');
    }
    return this.editor.isActive(name);
  }

  private updateBlockState(): void {
    const activeItems: RichTextBlockItem[] = [];
    for (const item of RICH_TEXT_BLOCK_ITEMS) {
      const active = this.isBlockActive(item.name);
      const button = this.blockMenu.querySelector<HTMLElement>(`[data-richtext-block="${item.name}"]`);
      button?.setAttribute('aria-selected', String(active));
      if (active) activeItems.push(item);
    }
    const activeItem = activeItems.length === 1 ? activeItems[0] : undefined;
    this.blockLabel.textContent = activeItem?.label ?? 'Multiple';
    this.blockTrigger.dataset.activeBlock = activeItem?.name ?? 'multiple';
    const linkActive = this.editor.isActive('link');
    this.linkTrigger.dataset.active = String(linkActive);
    this.linkTrigger.setAttribute('aria-pressed', String(linkActive));
  }

  private updateColorState(): void {
    const rawTextColor = this.editor.getAttributes('textStyle').color;
    const rawBackgroundColor = this.editor.getAttributes('highlight').color;
    const textColor = typeof rawTextColor === 'string' ? rawTextColor : undefined;
    const backgroundColor = typeof rawBackgroundColor === 'string' ? rawBackgroundColor : undefined;
    this.colorPreview.style.color = textColor ?? '';
    this.colorPreview.style.backgroundColor = backgroundColor ?? '';
    for (const button of Array.from(this.colorMenu.querySelectorAll<HTMLElement>('[data-richtext-color-kind]'))) {
      const kind = button.dataset.richtextColorKind;
      const selectedColor = kind === 'text' ? textColor : backgroundColor;
      button.setAttribute('aria-selected', String((button.dataset.richtextColor ?? undefined) === selectedColor));
    }
  }

  private position(): void {
    const selection = this.editor.state.selection;
    if (!hasFormattableSelection(this.editor)) return;
    const selectionBounds = posToDOMRect(this.editor.view, selection.from, selection.to);
    const overlayBounds = this.overlayRoot.getBoundingClientRect();
    const toolbarBounds = this.toolbar.getBoundingClientRect();
    const inset = 8;
    const left = Math.max(
      inset,
      Math.min(
        selectionBounds.left - overlayBounds.left + (selectionBounds.width - toolbarBounds.width) / 2,
        overlayBounds.width - toolbarBounds.width - inset,
      ),
    );
    let top = selectionBounds.top - overlayBounds.top - toolbarBounds.height - inset;
    if (top < inset) top = selectionBounds.bottom - overlayBounds.top + inset;
    this.toolbar.style.left = `${left}px`;
    this.toolbar.style.top = `${Math.min(top, overlayBounds.height - toolbarBounds.height - inset)}px`;
  }

  private positionPopover(popover: HTMLElement, trigger: HTMLElement): void {
    const toolbarBounds = this.toolbar.getBoundingClientRect();
    const triggerBounds = trigger.getBoundingClientRect();
    const overlayBounds = this.overlayRoot.getBoundingClientRect();
    const popoverBounds = popover.getBoundingClientRect();
    const inset = 8;
    const preferredLeft = triggerBounds.left - toolbarBounds.left;
    const minimumLeft = overlayBounds.left - toolbarBounds.left + inset;
    const maximumLeft = overlayBounds.right - toolbarBounds.left - popoverBounds.width - inset;
    popover.style.left = `${Math.max(minimumLeft, Math.min(preferredLeft, maximumLeft))}px`;
    const below = toolbarBounds.height + 6;
    const above = -popoverBounds.height - 6;
    popover.style.top = `${toolbarBounds.bottom + popoverBounds.height + 6 <= overlayBounds.bottom - inset ? below : above}px`;
  }

  private hide(): void {
    this.closePopovers();
    this.toolbar.classList.add('hidden');
  }

  private closePopovers(): void {
    this.blockMenu.classList.add('hidden');
    this.linkForm.classList.add('hidden');
    this.colorMenu.classList.add('hidden');
    this.blockTrigger.setAttribute('aria-expanded', 'false');
    this.linkTrigger.setAttribute('aria-expanded', 'false');
    this.colorTrigger.setAttribute('aria-expanded', 'false');
  }
}

class NotesRichTextImageBubbleMenu {
  private readonly element = document.createElement('div');

  public constructor(
    private readonly editor: Editor,
    private readonly overlayRoot: HTMLElement,
  ) {
    this.element.className = 'notes-richtext-image-toolbar hidden';
    this.element.setAttribute('role', 'toolbar');
    this.element.setAttribute('aria-label', 'Image alignment');
    for (const alignment of NOTE_IMAGE_ALIGNMENTS) {
      const button = document.createElement('button');
      const label = `Align image ${alignment}`;
      button.type = 'button';
      button.className = 'notes-richtext-image-align-button';
      button.dataset.richtextImageAlignment = alignment;
      button.setAttribute('aria-label', label);
      button.setAttribute('aria-pressed', 'false');
      button.title = label;
      button.append(createStrokeIcon(NOTE_IMAGE_ALIGNMENT_ICONS[alignment]));
      this.element.append(button);
    }
    this.element.addEventListener('mousedown', this.handleMouseDown);
    this.element.addEventListener('click', this.handleClick);
    this.overlayRoot.append(this.element);
  }

  public sync(): void {
    if (this.editor.isDestroyed || !this.editor.isEditable) {
      this.hide();
      return;
    }
    const selected = this.selectedImage();
    if (!selected) {
      this.hide();
      return;
    }
    for (const button of Array.from(
      this.element.querySelectorAll<HTMLButtonElement>('[data-richtext-image-alignment]'),
    )) {
      const active = button.dataset.richtextImageAlignment === selected.alignment;
      button.dataset.active = String(active);
      button.setAttribute('aria-pressed', String(active));
    }
    this.element.classList.remove('hidden');
    this.position(selected.dom);
  }

  public destroy(): void {
    this.element.removeEventListener('mousedown', this.handleMouseDown);
    this.element.removeEventListener('click', this.handleClick);
    this.element.remove();
  }

  private selectedImage(): {
    alignment: NoteImageAlignment;
    dom: HTMLElement;
    node: NodeViewRendererProps['node'];
    position: number;
  } | undefined {
    const selection = this.editor.state.selection;
    const node = (selection as typeof selection & { node?: NodeViewRendererProps['node'] }).node;
    if (node?.type.name !== 's3Image') return undefined;
    const dom = this.editor.view.nodeDOM(selection.from);
    if (!(dom instanceof HTMLElement)) return undefined;
    try {
      const attributes = parseNoteImageNodeAttributes(node.attrs);
      return {
        alignment: attributes.alignment ?? 'left',
        dom,
        node,
        position: selection.from,
      };
    } catch {
      return undefined;
    }
  }

  private readonly handleMouseDown = (event: MouseEvent): void => {
    event.preventDefault();
  };

  private readonly handleClick = (event: MouseEvent): void => {
    const source = event.target;
    if (!(source instanceof Element)) return;
    const button = source.closest<HTMLElement>('[data-richtext-image-alignment]');
    const alignment = button?.dataset.richtextImageAlignment;
    if (alignment !== 'left' && alignment !== 'center' && alignment !== 'right') return;
    event.preventDefault();
    this.applyAlignment(alignment);
  };

  private applyAlignment(alignment: NoteImageAlignment): void {
    const selected = this.selectedImage();
    if (!selected) return;
    const nextAttributes: Record<string, unknown> = { ...selected.node.attrs };
    if (alignment === 'left') delete nextAttributes.alignment;
    else nextAttributes.alignment = alignment;
    this.editor.view.dispatch(
      this.editor.state.tr.setNodeMarkup(selected.position, undefined, nextAttributes),
    );
    this.editor.commands.setNodeSelection(selected.position);
    this.sync();
  }

  private position(image: HTMLElement): void {
    const overlayBounds = this.overlayRoot.getBoundingClientRect();
    const imageBounds = image.getBoundingClientRect();
    if (imageBounds.bottom <= overlayBounds.top || imageBounds.top >= overlayBounds.bottom) {
      this.hide();
      return;
    }
    const toolbarBounds = this.element.getBoundingClientRect();
    const inset = 8;
    const preferredLeft = imageBounds.left - overlayBounds.left
      + (imageBounds.width - toolbarBounds.width) / 2;
    const maximumLeft = Math.max(inset, overlayBounds.width - toolbarBounds.width - inset);
    const left = Math.max(inset, Math.min(preferredLeft, maximumLeft));
    let top = imageBounds.top - overlayBounds.top - toolbarBounds.height - inset;
    if (top < inset) top = imageBounds.bottom - overlayBounds.top + inset;
    const maximumTop = Math.max(inset, overlayBounds.height - toolbarBounds.height - inset);
    this.element.style.left = `${left}px`;
    this.element.style.top = `${Math.max(inset, Math.min(top, maximumTop))}px`;
  }

  private hide(): void {
    this.element.classList.add('hidden');
  }
}

function createS3ImageNodeView(
  initialNode: NodeViewRendererProps['node'],
  editor: Editor,
  getPos: NodeViewRendererProps['getPos'],
  onError: (message: string) => void,
  onLayoutChange: () => void,
): {
  dom: HTMLElement;
  update: (node: NodeViewRendererProps['node']) => boolean;
  selectNode: () => void;
  deselectNode: () => void;
  stopEvent: (event: Event) => boolean;
  ignoreMutation: () => boolean;
  destroy: () => void;
} {
  const dom = document.createElement('figure');
  dom.className = 'notes-richtext-image';
  dom.contentEditable = 'false';
  const frame = document.createElement('div');
  frame.className = 'notes-richtext-image-frame';
  const westHandle = document.createElement('button');
  westHandle.type = 'button';
  westHandle.className = 'notes-richtext-image-handle notes-richtext-image-handle-west';
  westHandle.dataset.resizeDirection = 'west';
  westHandle.setAttribute('aria-label', 'Resize image from left');
  westHandle.title = 'Resize image';
  const eastHandle = document.createElement('button');
  eastHandle.type = 'button';
  eastHandle.className = 'notes-richtext-image-handle notes-richtext-image-handle-east';
  eastHandle.dataset.resizeDirection = 'east';
  eastHandle.setAttribute('aria-label', 'Resize image from right');
  eastHandle.title = 'Resize image';
  dom.append(frame, westHandle, eastHandle);

  let node = initialNode;
  let objectUrl: string | undefined;
  let requestedReferenceKey: string | undefined;
  let loadGeneration = 0;
  let destroyed = false;
  let activeResize: {
    pointerId: number;
    direction: 'west' | 'east';
    startX: number;
    startWidth: number;
    maximumWidth: number;
    previewWidth: number;
    handle: HTMLButtonElement;
  } | undefined;

  const revokeObjectUrl = (): void => {
    if (!objectUrl) return;
    URL.revokeObjectURL(objectUrl);
    objectUrl = undefined;
  };

  const showState = (state: 'loading' | 'not-configured' | 'missing' | 'error', text: string): void => {
    dom.dataset.state = state;
    const status = document.createElement('span');
    status.className = 'notes-richtext-image-status';
    status.dataset.state = state;
    status.setAttribute('role', 'status');
    status.textContent = text;
    frame.replaceChildren(status);
    onLayoutChange();
  };

  const applyLayout = (attributes: NoteImageNodeAttributes): void => {
    const displayWidth = attributes.displayWidth ?? attributes.width;
    dom.style.width = `${displayWidth}px`;
    dom.dataset.displayWidth = String(displayWidth);
    dom.dataset.alignment = attributes.alignment ?? 'left';
    onLayoutChange();
  };

  const availableWidth = (): number => {
    const editorElement = editor.view.dom;
    const style = getComputedStyle(editorElement);
    const horizontalPadding = Number.parseFloat(style.paddingLeft || '0') + Number.parseFloat(style.paddingRight || '0');
    return Math.max(
      RICH_TEXT_IMAGE_MIN_DISPLAY_WIDTH,
      Math.min(RICH_TEXT_LIMITS.imageDimension, editorElement.getBoundingClientRect().width - horizontalPadding),
    );
  };

  const reload = async (): Promise<void> => {
    let attributes: NoteImageNodeAttributes;
    let reference: NoteImageReference;
    try {
      attributes = parseNoteImageNodeAttributes(node.attrs);
      const {
        displayWidth: _displayWidth,
        alignment: _alignment,
        ...assetReference
      } = attributes;
      reference = parseNoteImageReference(assetReference);
    } catch {
      if (destroyed) return;
      loadGeneration += 1;
      requestedReferenceKey = undefined;
      revokeObjectUrl();
      showState('error', 'Unable to load image.');
      safelyReport(onError, 'The embedded image reference is invalid.');
      return;
    }
    applyLayout(attributes);
    const referenceKey = JSON.stringify(reference);
    if (referenceKey === requestedReferenceKey) return;
    requestedReferenceKey = referenceKey;

    const generation = ++loadGeneration;
    revokeObjectUrl();
    showState('loading', 'Loading image…');

    let result: NotesImageLoadResult;
    try {
      result = await loadNoteImage(reference);
    } catch {
      result = { status: 'error' };
    }
    if (destroyed || generation !== loadGeneration) return;

    if (result.status === 'not-configured') {
      showState('not-configured', 'Configure S3 to view this image.');
      return;
    }
    if (result.status === 'missing') {
      showState('missing', 'Image is unavailable.');
      safelyReport(onError, 'An embedded image is unavailable.');
      return;
    }
    if (
      result.status !== 'loaded'
      || !(result.bytes instanceof Uint8Array)
      || result.bytes.byteLength !== reference.byteLength
      || result.mimeType !== reference.mimeType
    ) {
      showState('error', 'Unable to load image.');
      safelyReport(onError, 'An embedded image could not be loaded.');
      return;
    }

    let nextObjectUrl: string;
    try {
      const imageBytes = Uint8Array.from(result.bytes);
      nextObjectUrl = URL.createObjectURL(new Blob([imageBytes], { type: reference.mimeType }));
    } catch {
      showState('error', 'Unable to load image.');
      safelyReport(onError, 'An embedded image could not be displayed.');
      return;
    }
    if (destroyed || generation !== loadGeneration) {
      URL.revokeObjectURL(nextObjectUrl);
      return;
    }
    objectUrl = nextObjectUrl;

    const image = document.createElement('img');
    image.className = 'notes-richtext-image-content';
    image.alt = reference.alt ?? '';
    image.width = reference.width;
    image.height = reference.height;
    image.draggable = false;
    image.addEventListener('load', () => {
      if (!destroyed && generation === loadGeneration) {
        delete dom.dataset.state;
        frame.replaceChildren(image);
        onLayoutChange();
      }
    }, { once: true });
    image.addEventListener('error', () => {
      if (destroyed || generation !== loadGeneration) return;
      revokeObjectUrl();
      showState('error', 'Unable to load image.');
      safelyReport(onError, 'An embedded image could not be displayed.');
    }, { once: true });
    image.src = nextObjectUrl;
  };

  const finishResize = (commit: boolean): void => {
    const resize = activeResize;
    if (!resize) return;
    activeResize = undefined;
    window.removeEventListener('pointermove', handlePointerMove, true);
    window.removeEventListener('pointerup', handlePointerUp, true);
    window.removeEventListener('pointercancel', handlePointerCancel, true);
    dom.classList.remove('notes-richtext-image-resizing');
    try {
      if (resize.handle.hasPointerCapture(resize.pointerId)) resize.handle.releasePointerCapture(resize.pointerId);
    } catch {
      // Losing pointer capture during window changes is harmless.
    }
    if (!commit || destroyed) {
      try {
        applyLayout(parseNoteImageNodeAttributes(node.attrs));
      } catch {
        // The normal reload path owns invalid-node error presentation.
      }
      return;
    }
    const position = getPos();
    if (typeof position !== 'number' || resize.previewWidth === resize.startWidth) return;
    const nextAttrs: Record<string, unknown> = { ...node.attrs };
    if (resize.previewWidth === Number(node.attrs.width)) delete nextAttrs.displayWidth;
    else nextAttrs.displayWidth = resize.previewWidth;
    editor.view.dispatch(editor.state.tr.setNodeMarkup(position, undefined, nextAttrs));
    editor.commands.setNodeSelection(position);
  };

  const handlePointerMove = (event: PointerEvent): void => {
    const resize = activeResize;
    if (!resize || event.pointerId !== resize.pointerId) return;
    event.preventDefault();
    resize.previewWidth = calculateRichTextImageDisplayWidth(
      resize.startWidth,
      event.clientX - resize.startX,
      resize.direction,
      resize.maximumWidth,
    );
    dom.style.width = `${resize.previewWidth}px`;
    dom.dataset.displayWidth = String(resize.previewWidth);
    onLayoutChange();
  };

  const handlePointerUp = (event: PointerEvent): void => {
    if (!activeResize || event.pointerId !== activeResize.pointerId) return;
    event.preventDefault();
    finishResize(true);
  };

  const handlePointerCancel = (event: PointerEvent): void => {
    if (!activeResize || event.pointerId !== activeResize.pointerId) return;
    finishResize(false);
  };

  const beginResize = (event: PointerEvent): void => {
    const source = event.currentTarget;
    if (!(source instanceof HTMLButtonElement) || event.button !== 0 || destroyed) return;
    const direction = source.dataset.resizeDirection;
    if (direction !== 'west' && direction !== 'east') return;
    event.preventDefault();
    event.stopPropagation();
    finishResize(false);
    const position = getPos();
    if (typeof position !== 'number') return;
    editor.commands.setNodeSelection(position);
    const startWidth = Math.round(Math.max(
      RICH_TEXT_IMAGE_MIN_DISPLAY_WIDTH,
      dom.getBoundingClientRect().width,
    ));
    activeResize = {
      pointerId: event.pointerId,
      direction,
      startX: event.clientX,
      startWidth,
      maximumWidth: availableWidth(),
      previewWidth: Math.round(startWidth),
      handle: source,
    };
    dom.classList.add('notes-richtext-image-resizing');
    try {
      source.setPointerCapture(event.pointerId);
    } catch {
      // Window-level listeners below retain ownership if capture is unavailable.
    }
    window.addEventListener('pointermove', handlePointerMove, true);
    window.addEventListener('pointerup', handlePointerUp, true);
    window.addEventListener('pointercancel', handlePointerCancel, true);
  };

  westHandle.addEventListener('pointerdown', beginResize);
  eastHandle.addEventListener('pointerdown', beginResize);

  void reload();
  return {
    dom,
    update(updatedNode): boolean {
      if (updatedNode.type.name !== 's3Image') return false;
      node = updatedNode;
      void reload();
      return true;
    },
    selectNode(): void {
      dom.classList.add('ProseMirror-selectednode');
    },
    deselectNode(): void {
      finishResize(false);
      dom.classList.remove('ProseMirror-selectednode');
    },
    stopEvent: (event) => event.target instanceof globalThis.Node
      && (westHandle.contains(event.target) || eastHandle.contains(event.target)),
    ignoreMutation: () => true,
    destroy(): void {
      finishResize(false);
      destroyed = true;
      loadGeneration += 1;
      westHandle.removeEventListener('pointerdown', beginResize);
      eastHandle.removeEventListener('pointerdown', beginResize);
      revokeObjectUrl();
      dom.replaceChildren();
    },
  };
}

function createS3ImageExtension(
  onError: (message: string) => void,
  onLayoutChange: () => void,
  importImages?: readonly NoteImageNodeAttributes[],
  importToken?: string,
) {
  return Image.extend({
    name: 's3Image',
    addAttributes() {
      return {
        objectId: { default: null },
        assetKey: { default: null },
        ciphertextSha256: { default: null },
        contentSha256: { default: null },
        mimeType: { default: null },
        byteLength: { default: null },
        width: { default: null },
        height: { default: null },
        alt: { default: null },
        displayWidth: { default: null },
        alignment: { default: null },
      };
    },
    // Rich text is loaded only from validated JSON. In particular, pasted or
    // dropped <img src> elements and Markdown image URLs must not create nodes.
    parseHTML() {
      if (!importImages || !importToken) return [];
      return [{
        tag: 'div[data-trilium-import-image]',
        getAttrs: (element) => {
          if (!(element instanceof HTMLElement)) return false;
          const marker = element.getAttribute('data-trilium-import-image');
          const prefix = `${importToken}:`;
          if (!marker?.startsWith(prefix)) return false;
          const rawIndex = marker.slice(prefix.length);
          if (!/^\d+$/.test(rawIndex)) return false;
          const attributes = importImages[Number(rawIndex)];
          return attributes ? { ...attributes } : false;
        },
      }];
    },
    addInputRules() {
      return [];
    },
    addPasteRules() {
      return [];
    },
    addCommands() {
      // Do not inherit Image.setImage({ src }); insertion is reference-only.
      return {};
    },
    parseMarkdown() {
      return [];
    },
    renderMarkdown() {
      return '[Embedded image]';
    },
    renderHTML() {
      // Clipboard/HTML serialization intentionally contains no S3 reference.
      return ['span', { class: 'notes-richtext-image-serialized', 'aria-label': 'Embedded image' }];
    },
    addNodeView() {
      return ({ node, editor, getPos }) => createS3ImageNodeView(
        node,
        editor,
        getPos,
        onError,
        onLayoutChange,
      );
    },
  });
}

export type NoteAttachmentIconKind =
  | 'pdf' | 'document' | 'spreadsheet' | 'presentation' | 'archive'
  | 'image' | 'audio' | 'video' | 'code' | 'file';

const NOTE_ATTACHMENT_ICON_SOURCES: Readonly<Record<NoteAttachmentIconKind, string>> = {
  pdf: '../../assets/note-file-icons/pdf.svg',
  document: '../../assets/note-file-icons/document.svg',
  spreadsheet: '../../assets/note-file-icons/spreadsheet.svg',
  presentation: '../../assets/note-file-icons/presentation.svg',
  archive: '../../assets/note-file-icons/archive.svg',
  image: '../../assets/note-file-icons/image.svg',
  audio: '../../assets/note-file-icons/audio.svg',
  video: '../../assets/note-file-icons/video.svg',
  code: '../../assets/note-file-icons/code.svg',
  file: '../../assets/note-file-icons/file.svg',
};

function createAttachmentTypeIcon(kind: NoteAttachmentIconKind): HTMLImageElement {
  const image = document.createElement('img');
  image.className = 'notes-richtext-attachment-type-image';
  image.src = NOTE_ATTACHMENT_ICON_SOURCES[kind];
  image.alt = '';
  image.draggable = false;
  image.decoding = 'async';
  return image;
}

export function noteAttachmentIconKind(reference: Pick<NoteAttachmentReference, 'fileName' | 'mimeType'>): NoteAttachmentIconKind {
  const extension = reference.fileName.slice(reference.fileName.lastIndexOf('.')).toLocaleLowerCase();
  const mimeType = reference.mimeType.toLocaleLowerCase();
  if (mimeType === 'application/pdf' || extension === '.pdf') return 'pdf';
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('video/')) return 'video';
  if (/spreadsheet|excel|csv/.test(mimeType) || ['.csv', '.xls', '.xlsx', '.ods'].includes(extension)) {
    return 'spreadsheet';
  }
  if (/presentation|powerpoint/.test(mimeType) || ['.key', '.odp', '.ppt', '.pptx'].includes(extension)) {
    return 'presentation';
  }
  if (/word|document|opendocument\.text/.test(mimeType) || ['.doc', '.docx', '.odt', '.pages', '.rtf'].includes(extension)) {
    return 'document';
  }
  if (/zip|compressed|archive|tar|gzip|7z/.test(mimeType)
    || ['.7z', '.bz2', '.gz', '.rar', '.tar', '.tgz', '.xz', '.zip'].includes(extension)) return 'archive';
  if (mimeType.startsWith('text/')
    || ['.c', '.cpp', '.css', '.go', '.html', '.java', '.js', '.json', '.md', '.py', '.rs', '.sh', '.sql', '.ts', '.tsx', '.xml', '.yaml', '.yml'].includes(extension)) return 'code';
  return 'file';
}

function attachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MiB`;
}

function createAttachmentActionIcon(action: 'view' | 'download'): SVGSVGElement {
  return createStrokeIcon(action === 'view'
    ? ['M1.75 8s2.25-3.75 6.25-3.75S14.25 8 14.25 8 12 11.75 8 11.75 1.75 8 1.75 8', 'M8 6.25a1.75 1.75 0 1 0 0 3.5 1.75 1.75 0 0 0 0-3.5']
    : ['M8 2.25v7.25', 'm5.25 7 2.75 2.75L10.75 7', 'M3 12.75h10']);
}

function createS3AttachmentExtension(
  onError: (message: string) => void,
  onAction: (
    action: 'view' | 'download',
    reference: NoteAttachmentReference,
    opener: HTMLButtonElement,
  ) => void,
) {
  return Node.create({
    name: 's3Attachment',
    group: 'block',
    atom: true,
    selectable: true,
    draggable: false,
    addAttributes() {
      return {
        objectId: { default: null },
        assetKey: { default: null },
        ciphertextSha256: { default: null },
        contentSha256: { default: null },
        fileName: { default: null },
        mimeType: { default: null },
        byteLength: { default: null },
      };
    },
    parseHTML() {
      return [];
    },
    renderHTML() {
      return ['span', { class: 'notes-richtext-attachment-serialized', 'aria-label': 'File attachment' }];
    },
    addNodeView() {
      return ({ node, editor, getPos }) => {
        const dom = document.createElement('article');
        dom.className = 'notes-richtext-attachment';
        dom.contentEditable = 'false';
        const icon = document.createElement('span');
        icon.className = 'notes-richtext-attachment-type';
        icon.setAttribute('aria-hidden', 'true');
        const copy = document.createElement('span');
        copy.className = 'notes-richtext-attachment-copy';
        const name = document.createElement('strong');
        const metadata = document.createElement('small');
        const footer = document.createElement('span');
        footer.className = 'notes-richtext-attachment-footer';
        const actions = document.createElement('span');
        actions.className = 'notes-richtext-attachment-actions';
        footer.append(metadata, actions);
        copy.append(name, footer);
        const createActionButton = (
          action: 'view' | 'download',
          reference: NoteAttachmentReference,
        ): HTMLButtonElement => {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'notes-richtext-attachment-action';
          button.dataset.action = action;
          const actionLabel = action === 'view' ? 'Preview' : 'Download';
          button.setAttribute('aria-label', `${actionLabel} ${reference.fileName}`);
          button.title = actionLabel;
          button.append(createAttachmentActionIcon(action));
          button.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            try {
              onAction(action, parseNoteAttachmentReference(node.attrs), button);
            } catch {
              safelyReport(onError, 'The file attachment is invalid.');
            }
          });
          return button;
        };
        dom.append(icon, copy);

        const render = (): void => {
          const reference = parseNoteAttachmentReference(node.attrs);
          const kind = noteAttachmentIconKind(reference);
          dom.dataset.kind = kind;
          icon.dataset.kind = kind;
          icon.replaceChildren(createAttachmentTypeIcon(kind));
          name.textContent = reference.fileName;
          name.title = reference.fileName;
          metadata.textContent = attachmentSize(reference.byteLength);
          actions.replaceChildren(
            ...(noteAttachmentPreviewKind(reference) ? [createActionButton('view', reference)] : []),
            createActionButton('download', reference),
          );
          dom.setAttribute('aria-label', `Attachment: ${reference.fileName}`);
        };
        render();
        dom.addEventListener('click', () => {
          const position = getPos();
          if (typeof position === 'number' && editor.isEditable) editor.commands.setNodeSelection(position);
        });
        return {
          dom,
          update(updatedNode) {
            if (updatedNode.type.name !== 's3Attachment') return false;
            node = updatedNode;
            try {
              render();
              return true;
            } catch {
              return false;
            }
          },
          selectNode: () => dom.classList.add('ProseMirror-selectednode'),
          deselectNode: () => dom.classList.remove('ProseMirror-selectednode'),
          stopEvent: (event) => event.target instanceof window.Node && actions.contains(event.target),
          ignoreMutation: () => true,
        };
      };
    },
  });
}

function createNotesRichTextExtensions(
  onError: (message: string) => void,
  onLayoutChange: () => void,
  onAttachmentAction: (
    action: 'view' | 'download',
    reference: NoteAttachmentReference,
    opener: HTMLButtonElement,
  ) => void,
  importImages?: readonly NoteImageNodeAttributes[],
  importToken?: string,
): Extensions {
  return [StarterKit.configure({
    codeBlock: false,
    dropcursor: {
      color: '#3b82f6',
      width: 2,
      class: 'notes-richtext-block-dropcursor',
    },
    link: {
      openOnClick: false,
      enableClickSelection: false,
      autolink: true,
      linkOnPaste: true,
      protocols: [],
      defaultProtocol: 'https',
      HTMLAttributes: {
        target: '_blank',
        rel: 'nofollow noopener noreferrer',
      },
      isAllowedUri: (url) => isAllowedRichTextLinkHref(url),
      shouldAutoLink: (url) => isAllowedRichTextLinkHref(url),
    },
  }),
  CodeBlockLowlight.configure({ lowlight: notesCodeLowlight }),
  TableKit.configure({
    table: {
      cellMinWidth: 96,
      resizable: true,
    },
  }),
  createTextStyleExtension(),
  createHighlightExtension(),
  createMathExtension(),
  createTaskListExtension(),
  createTaskItemExtension(),
  notesRichTextFindExtension,
  createS3ImageExtension(onError, onLayoutChange, importImages, importToken),
  createS3AttachmentExtension(onError, onAttachmentAction)];
}

export interface TriliumHtmlConversionResult {
  content: string;
  embeddedImageCount: number;
  imagePlaceholderCount: number;
  usedPlainTextFallback: boolean;
}

function richTextPlainTextFallback(value: string): string {
  const safeText = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .slice(0, 750_000);
  if (!safeText.trim()) return EMPTY_RICH_TEXT_CONTENT;
  const paragraphs = safeText.split(/\n{2,}/).slice(0, 4_000).map((paragraph) => ({
    type: 'paragraph',
    ...(paragraph ? { content: [{ type: 'text', text: paragraph }] } : {}),
  }));
  return normalizeRichTextContent({ type: 'doc', content: paragraphs });
}

function directElementChildren(element: Element, tagName: string): Element[] {
  const normalizedTagName = tagName.toUpperCase();
  return Array.from(element.children).filter((child) => child.tagName === normalizedTagName);
}

function triliumTodoLabel(item: Element): HTMLLabelElement | undefined {
  return directElementChildren(item, 'label').find((candidate): candidate is HTMLLabelElement => (
    candidate instanceof HTMLLabelElement
    && isTriliumTodoLabelClass(candidate.getAttribute('class'))
  ));
}

function triliumTodoCheckbox(label: HTMLLabelElement): HTMLInputElement | undefined {
  return Array.from(label.querySelectorAll('input')).find((candidate) => (
    isTriliumTodoCheckboxType(candidate.getAttribute('type'))
  ));
}

function unwrapTriliumTodoLabel(
  label: HTMLLabelElement,
  checkbox: HTMLInputElement | undefined,
): HTMLParagraphElement {
  const paragraph = label.ownerDocument.createElement('p');
  checkbox?.remove();
  for (const child of Array.from(label.childNodes)) {
    if (child instanceof Element
      && isTriliumTodoDescriptionClass(child.getAttribute('class'))) {
      while (child.firstChild) paragraph.append(child.firstChild);
      continue;
    }
    paragraph.append(child);
  }
  label.replaceWith(paragraph);
  return paragraph;
}

function ensureTriliumTaskItemStartsWithParagraph(item: HTMLLIElement): void {
  const firstElement = Array.from(item.children)[0];
  if (firstElement?.tagName === 'P') return;
  item.insertBefore(item.ownerDocument.createElement('p'), item.firstChild);
}

/** Rewrites CKEditor's checklist DOM into the exact TaskList DOM parsed by Notes. */
function adaptTriliumTodoLists(root: ParentNode): void {
  const lists = Array.from(root.querySelectorAll('ul')).filter((candidate) => (
    isTriliumTodoListClass(candidate.getAttribute('class'))
  ));
  for (const list of lists) list.setAttribute('data-type', 'taskList');

  for (const list of lists) {
    for (const candidate of directElementChildren(list, 'li')) {
      if (!(candidate instanceof HTMLLIElement)) continue;
      const label = triliumTodoLabel(candidate);
      const checkbox = label ? triliumTodoCheckbox(label) : undefined;
      candidate.setAttribute('data-task-item', '');
      candidate.setAttribute(
        'data-checked',
        String(triliumTodoChecked(
          checkbox?.checked === true,
          checkbox?.hasAttribute('checked') === true,
        )),
      );
      if (label) unwrapTriliumTodoLabel(label, checkbox);
      ensureTriliumTaskItemStartsWithParagraph(candidate);
    }
  }
}

function positiveTriliumTableSpan(value: string | null, maximum: number): number | undefined {
  if (value === null) return 1;
  if (!/^\d+$/.test(value.trim())) return undefined;
  const span = Number(value);
  return Number.isSafeInteger(span) && span >= 1 && span <= maximum ? span : undefined;
}

function triliumTableColumnWidthSource(column: HTMLTableColElement): string | null {
  const styleWidth = column.style.getPropertyValue('width').trim();
  return styleWidth || column.getAttribute('width');
}

/** Adds only the bounded width attributes consumed by Tiptap's official TableKit parser. */
function adaptTriliumTableColumnWidths(root: ParentNode): void {
  const tables = Array.from(root.querySelectorAll('table'));
  for (const candidate of tables) {
    if (!(candidate instanceof HTMLTableElement)) continue;
    const columns = directElementChildren(candidate, 'colgroup')
      .flatMap((group) => directElementChildren(group, 'col'))
      .filter((column): column is HTMLTableColElement => column instanceof HTMLTableColElement);
    if (columns.some((column) => positiveTriliumTableSpan(column.getAttribute('span'), 1) !== 1)) {
      continue;
    }
    const columnWidths = normalizeTriliumTableColumnWidths(
      columns.map(triliumTableColumnWidthSource),
    );
    if (!columnWidths) continue;

    const cellsByRow = Array.from(candidate.rows, (row) => Array.from(row.cells));
    const spanRows: TriliumTableCellSpan[][] = [];
    let validSpans = true;
    for (const cells of cellsByRow) {
      const spans: TriliumTableCellSpan[] = [];
      for (const cell of cells) {
        const colspan = positiveTriliumTableSpan(
          cell.getAttribute('colspan'),
          RICH_TEXT_LIMITS.tableColumns,
        );
        const rowspan = positiveTriliumTableSpan(
          cell.getAttribute('rowspan'),
          RICH_TEXT_LIMITS.tableRows,
        );
        if (colspan === undefined || rowspan === undefined) {
          validSpans = false;
          break;
        }
        spans.push({ colspan, rowspan });
      }
      if (!validSpans) break;
      spanRows.push(spans);
    }
    if (!validSpans) continue;
    const cellWidths = mapTriliumTableCellColumnWidths(spanRows, columnWidths);
    if (!cellWidths) continue;

    for (const [index, column] of columns.entries()) {
      const width = columnWidths[index];
      if (width !== undefined) column.setAttribute('width', String(width));
    }
    for (const [rowIndex, cells] of cellsByRow.entries()) {
      for (const [cellIndex, cell] of cells.entries()) {
        const widths = cellWidths[rowIndex]?.[cellIndex];
        if (widths) cell.setAttribute('colwidth', widths.join(','));
      }
    }
  }
}

interface AdaptedTriliumImages {
  attributes: NoteImageNodeAttributes[];
  embeddedImageCount: number;
  imagePlaceholderCount: number;
}

function triliumImageAlt(image: HTMLImageElement): string | undefined {
  const value = image.getAttribute('alt')
    ?.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim()
    .slice(0, RICH_TEXT_LIMITS.imageAltCharacters);
  return value || undefined;
}

function triliumImagePlaceholder(
  document: Document,
  alt: string | undefined,
  reason: TriliumImportImagePlaceholderReason,
): Text {
  const detail = alt || (reason === 'protected'
    ? 'protected'
    : reason === 'oversized'
      ? 'too large'
      : reason === 'missing'
        ? 'not found'
        : 'unsupported format or source');
  return document.createTextNode(`[Image unavailable: ${detail}]`);
}

function unwrapTriliumImageFigures(root: ParentNode): void {
  for (const figure of Array.from(root.querySelectorAll('figure'))) {
    if (!figure.classList.contains('image')
      && !figure.querySelector('[data-trilium-import-image]')) continue;
    const fragment = figure.ownerDocument.createDocumentFragment();
    for (const child of Array.from(figure.childNodes)) {
      if (child instanceof HTMLElement && child.tagName === 'FIGCAPTION') {
        const paragraph = figure.ownerDocument.createElement('p');
        while (child.firstChild) paragraph.append(child.firstChild);
        fragment.append(paragraph);
      } else {
        fragment.append(child);
      }
    }
    figure.replaceWith(fragment);
  }
  for (const anchor of Array.from(root.querySelectorAll('a'))) {
    if (!anchor.querySelector('[data-trilium-import-image]')) continue;
    anchor.replaceWith(...Array.from(anchor.childNodes));
  }
}

function adaptTriliumImages(
  root: ParentNode,
  endpoint: string,
  assets: readonly TriliumImportImageAsset[] | Map<string, TriliumImportImageAsset>,
  importToken: string,
): AdaptedTriliumImages {
  const assetsBySource = assets instanceof Map
    ? assets
    : new Map(assets.map((asset) => [asset.sourceKey, asset]));
  const attributes: NoteImageNodeAttributes[] = [];
  let embeddedImageCount = 0;
  let imagePlaceholderCount = 0;

  for (const candidate of Array.from(root.querySelectorAll('img'))) {
    if (!(candidate instanceof HTMLImageElement)) continue;
    embeddedImageCount += 1;
    const alt = triliumImageAlt(candidate);
    const figure = candidate.closest('figure');
    const source = parseTriliumImageSource(candidate.getAttribute('src'), endpoint);
    const asset = source ? assetsBySource.get(source.sourceKey) : undefined;
    if (!asset || asset.status === 'placeholder') {
      imagePlaceholderCount += 1;
      candidate.replaceWith(triliumImagePlaceholder(
        candidate.ownerDocument,
        alt,
        asset?.status === 'placeholder' ? asset.reason : 'unsupported',
      ));
      continue;
    }

    const reference = parseNoteImageReference(asset.reference);
    const alignment = triliumImageAlignment(
      figure?.getAttribute('class'),
      candidate.getAttribute('class'),
    );
    const displayWidth = triliumImagePixelWidth(
      figure instanceof HTMLElement ? figure.style.getPropertyValue('width') : undefined,
      candidate.style.getPropertyValue('width'),
      candidate.getAttribute('width'),
    );
    const imageAttributes = parseNoteImageNodeAttributes({
      ...reference,
      ...(alt ? { alt } : {}),
      ...(displayWidth !== undefined ? { displayWidth } : {}),
      ...(alignment !== 'left' ? { alignment } : {}),
    });
    const marker = candidate.ownerDocument.createElement('div');
    marker.setAttribute('data-trilium-import-image', `${importToken}:${attributes.length}`);
    attributes.push(imageAttributes);
    candidate.replaceWith(marker);
  }
  unwrapTriliumImageFigures(root);
  return { attributes, embeddedImageCount, imagePlaceholderCount };
}

function importedImageAttributes(value: unknown): NoteImageNodeAttributes[] {
  const document = parseRichTextContent(value);
  const images: NoteImageNodeAttributes[] = [];
  const visit = (node: RichTextNode): void => {
    if (node.type === 's3Image') images.push(parseNoteImageNodeAttributes(node.attrs));
    for (const child of node.content ?? []) visit(child);
  };
  visit(document);
  return images;
}

function assertImportedImagesRetained(
  content: string,
  expected: readonly NoteImageNodeAttributes[],
): void {
  const actual = importedImageAttributes(content);
  if (actual.length !== expected.length
    || actual.some((attributes, index) => (
      JSON.stringify(attributes) !== JSON.stringify(expected[index])
    ))) {
    throw new Error('The Trilium Rich Text conversion did not retain every imported image.');
  }
}

/** Convert a Trilium HTML fragment through the exact schema and canonical validator used by Notes. */
export function convertTriliumHtmlToRichText(
  html: string,
  endpoint: string,
  imageAssets: readonly TriliumImportImageAsset[] | Map<string, TriliumImportImageAsset> = [],
): TriliumHtmlConversionResult {
  const endpointBase = `${endpoint.replace(/\/+$/, '')}/`;
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  parsed.body.querySelectorAll('[data-trilium-import-image]').forEach((element) => {
    element.removeAttribute('data-trilium-import-image');
  });
  adaptTriliumTodoLists(parsed.body);
  adaptTriliumTableColumnWidths(parsed.body);
  parsed.body.querySelectorAll(
    'script,style,iframe,object,embed,form,input,button,textarea,select,meta,link',
  ).forEach((unsafe) => unsafe.remove());
  const importToken = crypto.randomUUID();
  const adaptedImages = adaptTriliumImages(parsed.body, endpoint, imageAssets, importToken);

  parsed.body.querySelectorAll('a[href]').forEach((anchor) => {
    const href = anchor.getAttribute('href')?.trim();
    if (!href) {
      anchor.removeAttribute('href');
      return;
    }
    try {
      const absolute = new URL(href, endpointBase);
      if (!isAllowedRichTextLinkHref(absolute.href)) throw new Error('unsupported link');
      anchor.setAttribute('href', absolute.href);
      anchor.setAttribute('target', '_blank');
      anchor.setAttribute('rel', 'nofollow noopener noreferrer');
    } catch {
      anchor.removeAttribute('href');
      anchor.removeAttribute('target');
      anchor.removeAttribute('rel');
    }
  });

  try {
    const generated = generateJSON(
      parsed.body.innerHTML,
      createNotesRichTextExtensions(
        () => undefined,
        () => undefined,
        () => undefined,
        adaptedImages.attributes,
        importToken,
      ),
    );
    const content = normalizeEditorContent(generated);
    assertImportedImagesRetained(content, adaptedImages.attributes);
    return {
      content,
      embeddedImageCount: adaptedImages.embeddedImageCount,
      imagePlaceholderCount: adaptedImages.imagePlaceholderCount,
      usedPlainTextFallback: false,
    };
  } catch {
    if (adaptedImages.attributes.length > 0) {
      throw new Error('A Trilium Rich Text Note could not be converted without losing an imported image.');
    }
    return {
      content: richTextPlainTextFallback(parsed.body.textContent ?? ''),
      embeddedImageCount: adaptedImages.embeddedImageCount,
      imagePlaceholderCount: adaptedImages.imagePlaceholderCount,
      usedPlainTextFallback: true,
    };
  }
}

/** Small renderer adapter that keeps Tiptap JSON behind the Notes string API. */
export class NotesRichTextEditor {
  private readonly editor: Editor;
  private readonly toolbar: HTMLElement;
  private readonly onChange: () => void;
  private readonly onError: (message: string) => void;
  private readonly slashMenu!: NotesRichTextSlashMenu;
  private readonly blockHandle!: NotesRichTextBlockHandle;
  private readonly bubbleMenu!: NotesRichTextBubbleMenu;
  private readonly imageBubbleMenu!: NotesRichTextImageBubbleMenu;
  private readonly codeLanguageMenu!: NotesRichTextCodeLanguageMenu;
  private readonly tableControls!: NotesRichTextTableControls;
  private readonly host: HTMLElement;
  private readonly overlayRoot: HTMLElement;
  private lastCanonicalContent = EMPTY_RICH_TEXT_CONTENT;
  private restoringCanonicalContent = false;
  private viewSyncFrame?: number;

  public constructor(options: NotesRichTextEditorOptions) {
    this.toolbar = options.toolbar;
    this.host = options.host;
    this.onChange = options.onChange;
    this.onError = options.onError;
    const overlayRoot = options.toolbar.parentElement;
    if (!overlayRoot) throw new Error('The Rich Text editor overlay root is missing.');
    this.overlayRoot = overlayRoot;
    this.editor = new Editor({
      element: options.host,
      content: parseRichTextContent(EMPTY_RICH_TEXT_CONTENT),
      // HTML paste, plain-text paste, autolink, and Trilium import share the
      // exact absolute http/https-only policy enforced by canonical persistence.
      extensions: createNotesRichTextExtensions(
        this.onError,
        () => this.imageBubbleMenu?.sync(),
        options.onAttachmentAction,
      ),
      injectCSS: false,
      editorProps: {
        attributes: {
          class: 'notes-richtext-editor-content',
          spellcheck: 'true',
        },
        handleClick: (_view, _position, event) => {
          const source = event.target;
          if (!(source instanceof Element)) return false;
          const link = source.closest('a[href]');
          if (!link || !options.host.contains(link)) return false;
          event.preventDefault();
          return true;
        },
        handleKeyDown: (_view, event) => {
          if (handleScopedCodeBlockSelectAll(this.editor, event)) return true;
          if (this.codeLanguageMenu?.handleKeyDown(event)) return true;
          if (this.tableControls?.handleKeyDown(event)) return true;
          return this.slashMenu?.handleKeyDown(event) ?? false;
        },
        handlePaste: (view, event) => {
          const files = Array.from(event.clipboardData?.files ?? []);
          const file = firstSupportedImageFile(event.clipboardData?.files) ?? files[0];
          if (!file) return false;
          event.preventDefault();
          if (isSupportedImageFile(file)) options.onRequestImage(file, view.state.selection.to);
          else options.onRequestAttachment(file, view.state.selection.to);
          return true;
        },
        handleDrop: (view, event, _slice, moved) => {
          if (moved) return false;
          const files = Array.from(event.dataTransfer?.files ?? []);
          const file = firstSupportedImageFile(event.dataTransfer?.files) ?? files[0];
          if (!file) return false;
          const position = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
          event.preventDefault();
          if (isSupportedImageFile(file)) options.onRequestImage(file, position);
          else options.onRequestAttachment(file, position);
          return true;
        },
      },
      onUpdate: () => {
        this.onChange();
        this.queueViewSync();
      },
      onSelectionUpdate: () => {
        this.queueViewSync();
      },
      onTransaction: () => {
        this.queueViewSync();
      },
      onFocus: () => {
        this.queueViewSync();
      },
      onBlur: () => {
        this.queueViewSync();
      },
    });
    this.slashMenu = new NotesRichTextSlashMenu(
      this.editor,
      this.overlayRoot,
      options.onRequestImage,
      options.onRequestAttachment,
    );
    this.blockHandle = new NotesRichTextBlockHandle(this.editor, this.overlayRoot, this.slashMenu);
    this.bubbleMenu = new NotesRichTextBubbleMenu(
      this.editor,
      this.toolbar,
      this.overlayRoot,
      this.onError,
    );
    this.imageBubbleMenu = new NotesRichTextImageBubbleMenu(this.editor, this.overlayRoot);
    this.codeLanguageMenu = new NotesRichTextCodeLanguageMenu(this.editor, this.overlayRoot);
    this.tableControls = new NotesRichTextTableControls(this.editor, this.host, this.overlayRoot);
    this.toolbar.addEventListener('click', this.handleToolbarClick);
    this.host.addEventListener('scroll', this.handleViewportChange, { passive: true });
    window.addEventListener('resize', this.handleViewportChange);
    this.updateEmptyState();
    this.updateToolbarState();
  }

  public setContent(value: unknown): void {
    try {
      const normalized = normalizeRichTextContent(
        value === undefined || value === null ? EMPTY_RICH_TEXT_CONTENT : value,
      );
      const replaced = this.editor.commands.setContent(parseRichTextContent(normalized), {
        emitUpdate: false,
        errorOnInvalidContent: true,
      });
      if (!replaced) throw new Error('Rich text content could not be opened.');
      this.lastCanonicalContent = normalized;
      this.updateEmptyState();
      this.updateToolbarState();
      this.bubbleMenu.sync();
      this.imageBubbleMenu.sync();
      this.codeLanguageMenu.sync();
      this.tableControls.sync();
      this.slashMenu.sync();
      this.blockHandle.sync();
    } catch (error) {
      safelyReport(this.onError, error instanceof Error ? error.message : 'Rich text content could not be opened.');
      throw error;
    }
  }

  public getContent(): string {
    try {
      const content = normalizeEditorContent(this.editor.getJSON());
      this.lastCanonicalContent = content;
      return content;
    } catch (error) {
      this.restoreLastCanonicalContent();
      safelyReport(this.onError, error instanceof Error ? error.message : 'Rich text content could not be saved.');
      throw error;
    }
  }

  public getPlainText(): string {
    return extractRichTextPlainText(this.getContent());
  }

  public focus(): void {
    this.editor.commands.focus();
  }

  public findText(query: string): NotesFindResult {
    return findRichTextMatches(this.editor.state.doc, query);
  }

  public findAnchor(): number {
    return this.editor.state.selection.from;
  }

  public setFindMatches(matches: readonly NotesFindMatch[], activeIndex: number): void {
    if (this.editor.isDestroyed) return;
    this.editor.view.dispatch(this.editor.state.tr.setMeta(richTextFindPluginKey, {
      matches,
      activeIndex,
    } satisfies RichTextFindDecorationState));
  }

  public revealFindMatch(): void {
    if (this.editor.isDestroyed) return;
    window.requestAnimationFrame(() => {
      if (this.editor.isDestroyed) return;
      const active = this.host.querySelector<HTMLElement>('.notes-find-match-active');
      if (!active) return;
      const activeBounds = active.getBoundingClientRect();
      const hostBounds = this.host.getBoundingClientRect();
      if (activeBounds.top >= hostBounds.top && activeBounds.bottom <= hostBounds.bottom) return;
      this.host.scrollTop += activeBounds.top
        - hostBounds.top
        - Math.max(0, (this.host.clientHeight - activeBounds.height) / 2);
    });
  }

  public clearFind(): void {
    this.setFindMatches([], -1);
  }

  public requestMeasure(): void {
    if (this.editor.isDestroyed) return;
    window.requestAnimationFrame(() => {
      if (this.editor.isDestroyed) return;
      this.editor.view.updateState(this.editor.state);
      this.handleViewportChange();
    });
  }

  public insertImage(value: NoteImageReference, position?: number): boolean {
    let reference: NoteImageReference;
    try {
      reference = parseNoteImageReference(value);
    } catch (error) {
      safelyReport(this.onError, error instanceof Error ? error.message : 'The embedded image reference is invalid.');
      return false;
    }
    const content = {
      type: 's3Image',
      attrs: reference,
    };
    const insertAt = Number.isInteger(position)
      && Number(position) >= 0
      && Number(position) <= this.editor.state.doc.content.size
      ? Number(position)
      : undefined;
    const inserted = insertAt !== undefined
      ? this.editor.chain().focus().insertContentAt(insertAt, content).run()
      : this.editor.chain().focus().insertContent(content).run();
    this.updateToolbarState();
    return inserted;
  }

  public insertAttachment(value: NoteAttachmentReference, position?: number): boolean {
    let reference: NoteAttachmentReference;
    try {
      reference = parseNoteAttachmentReference(value);
    } catch (error) {
      safelyReport(this.onError, error instanceof Error ? error.message : 'The file attachment reference is invalid.');
      return false;
    }
    const content = { type: 's3Attachment', attrs: reference };
    const insertAt = Number.isInteger(position)
      && Number(position) >= 0
      && Number(position) <= this.editor.state.doc.content.size
      ? Number(position)
      : undefined;
    const inserted = insertAt !== undefined
      ? this.editor.chain().focus().insertContentAt(insertAt, content).run()
      : this.editor.chain().focus().insertContent(content).run();
    this.updateToolbarState();
    return inserted;
  }

  public run(command: RichTextToolbarCommand): boolean {
    const completed = command === 'math'
      ? this.convertSelectionToMath()
      : this.commandChain(command, this.editor.chain().focus()).run();
    this.updateToolbarState();
    return completed;
  }

  public runToolbarCommand(command: RichTextToolbarCommand): boolean {
    return this.run(command);
  }

  public destroy(): void {
    if (this.viewSyncFrame !== undefined) window.cancelAnimationFrame(this.viewSyncFrame);
    this.toolbar.removeEventListener('click', this.handleToolbarClick);
    this.host.removeEventListener('scroll', this.handleViewportChange);
    window.removeEventListener('resize', this.handleViewportChange);
    this.bubbleMenu.destroy();
    this.imageBubbleMenu.destroy();
    this.codeLanguageMenu.destroy();
    this.tableControls.destroy();
    this.blockHandle.destroy();
    this.slashMenu.destroy();
    this.editor.destroy();
  }

  private readonly handleToolbarClick = (event: Event): void => {
    const source = event.target;
    if (!(source instanceof Element)) return;
    const control = source.closest<HTMLElement>('[data-richtext-command]');
    if (!control || !this.toolbar.contains(control)) return;
    const command = control.dataset.richtextCommand;
    if (!isToolbarCommand(command)) return;
    event.preventDefault();
    this.run(command);
  };

  private readonly handleViewportChange = (): void => {
    this.bubbleMenu.sync();
    this.imageBubbleMenu.sync();
    this.codeLanguageMenu.sync();
    this.tableControls.sync();
    this.slashMenu.sync();
    this.blockHandle.sync();
  };

  private queueViewSync(): void {
    if (this.editor.isDestroyed || this.viewSyncFrame !== undefined) return;
    this.viewSyncFrame = window.requestAnimationFrame(() => {
      this.viewSyncFrame = undefined;
      if (this.editor.isDestroyed) return;
      if (hasFormattableSelection(this.editor)) this.updateToolbarState();
      this.updateEmptyState();
      this.bubbleMenu.sync();
      this.imageBubbleMenu.sync();
      this.codeLanguageMenu.sync();
      this.tableControls.sync();
      this.slashMenu.sync();
      this.blockHandle.sync();
    });
  }

  private commandChain(command: RichTextToolbarCommand, chain: ChainedCommands): ChainedCommands {
    switch (command) {
      case 'undo': return chain.undo();
      case 'redo': return chain.redo();
      case 'bold': return chain.toggleBold();
      case 'italic': return chain.toggleItalic();
      case 'underline': return chain.toggleUnderline();
      case 'strike': return chain.toggleStrike();
      case 'code': return chain.toggleCode();
      case 'math': return chain;
      case 'heading': return chain.toggleHeading({ level: 2 });
      case 'bulletList': return chain.toggleBulletList();
      case 'orderedList': return chain.toggleOrderedList();
      case 'blockquote': return chain.toggleBlockquote();
    }
  }

  private canRun(command: RichTextToolbarCommand): boolean {
    if (command === 'math') {
      const selection = this.editor.state.selection;
      if (selection.empty || this.editor.isActive('codeBlock')) return false;
      if (this.editor.isActive('math')) {
        const latex = this.editor.getAttributes('math').latex;
        return typeof latex === 'string' && Boolean(latex);
      }
      const latex = this.editor.state.doc.textBetween(selection.from, selection.to, ' ', ' ');
      return Boolean(latex) && latex.length <= RICH_TEXT_LIMITS.mathCharacters;
    }
    return this.commandChain(command, this.editor.can().chain()).run();
  }

  private isActive(command: RichTextToolbarCommand): boolean {
    switch (command) {
      case 'bold': return this.editor.isActive('bold');
      case 'italic': return this.editor.isActive('italic');
      case 'underline': return this.editor.isActive('underline');
      case 'strike': return this.editor.isActive('strike');
      case 'code': return this.editor.isActive('code');
      case 'math': return this.editor.isActive('math');
      case 'heading': return this.editor.isActive('heading', { level: 2 });
      case 'bulletList': return this.editor.isActive('bulletList');
      case 'orderedList': return this.editor.isActive('orderedList');
      case 'blockquote': return this.editor.isActive('blockquote');
      case 'undo':
      case 'redo':
        return false;
    }
  }

  private convertSelectionToMath(): boolean {
    const selection = this.editor.state.selection;
    if (selection.empty || this.editor.isActive('codeBlock')) return false;
    if (this.editor.isActive('math')) {
      const latex = this.editor.getAttributes('math').latex;
      if (typeof latex !== 'string' || !latex) return false;
      return this.editor.chain()
        .focus()
        .command(({ tr }) => {
          tr.insertText(latex, selection.from, selection.to);
          return true;
        })
        .setTextSelection({ from: selection.from, to: selection.from + latex.length })
        .run();
    }
    const latex = this.editor.state.doc.textBetween(selection.from, selection.to, ' ', ' ');
    if (!latex || latex.length > RICH_TEXT_LIMITS.mathCharacters) return false;
    const inserted = this.editor.chain()
      .focus()
      .insertContentAt({ from: selection.from, to: selection.to }, {
        type: 'math',
        attrs: { latex },
      })
      .run();
    if (!inserted) return false;
    return this.editor.commands.setTextSelection({
      from: selection.from,
      to: selection.from + 1,
    });
  }

  private updateToolbarState(): void {
    if (this.editor.isDestroyed) return;
    for (const control of Array.from(this.toolbar.querySelectorAll<HTMLElement>('[data-richtext-command]'))) {
      const command = control.dataset.richtextCommand;
      if (!isToolbarCommand(command)) {
        control.setAttribute('aria-disabled', 'true');
        if (control instanceof HTMLButtonElement) control.disabled = true;
        control.classList.remove('is-active');
        delete control.dataset.active;
        control.removeAttribute('aria-pressed');
        continue;
      }
      const disabled = !this.canRun(command);
      const active = TOGGLE_COMMANDS.has(command) && this.isActive(command);
      control.setAttribute('aria-disabled', String(disabled));
      if (control instanceof HTMLButtonElement) control.disabled = disabled;
      control.classList.toggle('is-active', active);
      if (TOGGLE_COMMANDS.has(command)) {
        control.dataset.active = String(active);
        control.setAttribute('aria-pressed', String(active));
      } else {
        delete control.dataset.active;
        control.removeAttribute('aria-pressed');
      }
    }
  }

  private updateEmptyState(): void {
    if (this.editor.isDestroyed) return;
    const editorElement = this.editor.view.dom;
    const documentNode = this.editor.state.doc;
    const showRootPlaceholder = this.editor.isEmpty
      && documentNode.childCount === 1
      && documentNode.firstChild?.type.name === 'paragraph';
    editorElement.classList.toggle('is-editor-empty', showRootPlaceholder);
    if (showRootPlaceholder) editorElement.dataset.placeholder = "Press '/' for commands";
    else delete editorElement.dataset.placeholder;
  }

  private restoreLastCanonicalContent(): void {
    if (this.editor.isDestroyed || this.restoringCanonicalContent) return;
    this.restoringCanonicalContent = true;
    try {
      const restored = this.editor.commands.setContent(
        parseRichTextContent(this.lastCanonicalContent),
        { emitUpdate: false, errorOnInvalidContent: true },
      );
      if (!restored) throw new Error('The last saved rich text content could not be restored.');
      this.updateEmptyState();
      this.updateToolbarState();
    } catch (error) {
      safelyReport(
        this.onError,
        error instanceof Error ? error.message : 'The last saved rich text content could not be restored.',
      );
    } finally {
      this.restoringCanonicalContent = false;
    }
  }
}
