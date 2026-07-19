import {
  Editor,
  Mark,
  Node,
  posToDOMRect,
  type ChainedCommands,
  type NodeViewRendererProps,
} from '@tiptap/core';
import Image from '@tiptap/extension-image';
import { TableKit } from '@tiptap/extension-table';
import StarterKit from '@tiptap/starter-kit';
import {
  EMPTY_RICH_TEXT_CONTENT,
  extractRichTextPlainText,
  isAllowedRichTextLinkHref,
  normalizeRichTextContent,
  parseNoteImageNodeAttributes,
  parseNoteImageReference,
  parseRichTextContent,
  RICH_TEXT_LIMITS,
  type NoteImageAlignment,
  type NoteImageNodeAttributes,
  type NoteImageReference,
} from './noteRichText.js';
import { revealMenuItemScrollTop } from './notesRichTextMenuScroll.js';
import {
  calculateRichTextImageDisplayWidth,
  RICH_TEXT_IMAGE_MIN_DISPLAY_WIDTH,
} from './notesRichTextImageResize.js';
import { NotesRichTextTableControls } from './notesRichTextTable.js';

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
  onUpdate: (content: string) => void;
  onError: (message: string) => void;
  onRequestImage: (file?: File, position?: number) => void;
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
const ICON_PATHS: Readonly<Record<Exclude<EditorIconName, 'heading1' | 'heading2' | 'heading3'>, readonly string[]>> = {
  text: ['M4 4h8', 'M8 4v8', 'M6 12h4'],
  todo: ['M2.5 4.25 4 5.75l2.25-3', 'M7.75 4.5h5.75', 'M2.5 10.25 4 11.75l2.25-3', 'M7.75 10.5h5.75'],
  bulletList: ['M6 4h7.5', 'M6 8h7.5', 'M6 12h7.5', 'M2.75 4h.01', 'M2.75 8h.01', 'M2.75 12h.01'],
  numberedList: ['M6 4h7.5', 'M6 8h7.5', 'M6 12h7.5', 'M2.25 3.25h1v2', 'M2.25 7.25h1a.75.75 0 0 1 0 1.5h-1l1.25 1.5h-1.5'],
  quote: ['M3 5.5h3v3H4.25a2 2 0 0 1-2 2', 'M9.5 5.5h3v3h-1.75a2 2 0 0 1-2 2'],
  code: ['m5.25 4-3.5 4 3.5 4', 'm10.75 4 3.5 4-3.5 4', 'm9.5 2.75-3 10.5'],
  image: ['M2.5 3.25h11v9.5h-11z', 'm3.5 11 3-3 2.25 2.25L10.5 8.5l2 2', 'M5.25 6.25h.01'],
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

function firstImageFile(files: FileList | null | undefined): File | undefined {
  return Array.from(files ?? []).find((file) => file.type.startsWith('image/'));
}

function hasFormattableSelection(editor: Editor): boolean {
  const selection = editor.state.selection;
  if (selection.empty || (selection as typeof selection & { node?: unknown }).node) return false;
  let hasFormattableContent = false;
  editor.state.doc.nodesBetween(selection.from, selection.to, (node) => {
    if ((node.isText && Boolean(node.text?.length)) || node.type.name === 'math') {
      hasFormattableContent = true;
      return false;
    }
    return !hasFormattableContent;
  });
  return hasFormattableContent;
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
      return [{ tag: 'ul[data-type="taskList"]' }];
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
      return [{ tag: 'li[data-task-item]' }];
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
  private readonly commandItems: readonly SlashCommandItem[];
  private items: readonly SlashCommandItem[] = [];
  private range: SlashCommandRange | undefined;
  private selectedIndex = 0;
  private suppressedQuery: string | undefined;
  private currentQuery: string | undefined;

  public constructor(
    private readonly editor: Editor,
    private readonly overlayRoot: HTMLElement,
    requestImage: (file?: File, position?: number) => void,
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
    ];
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
    this.overlayRoot.append(this.element);
  }

  public sync(): void {
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
    this.element.remove();
  }

  private hide(): void {
    this.range = undefined;
    this.items = [];
    this.currentQuery = undefined;
    this.selectedIndex = 0;
    this.element.replaceChildren();
    this.element.classList.add('hidden');
  }

  private render(): void {
    const children: HTMLElement[] = this.items.map((item, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'notes-richtext-slash-item';
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
    if (!selected) return;
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
    const cursor = this.editor.view.coordsAtPos(this.range.to);
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
    this.updateBlockState();
    this.updateColorState();
    const hasTextSelection = this.editor.isEditable && hasFormattableSelection(this.editor);
    const editingLink = !this.linkForm.classList.contains('hidden')
      && (this.toolbar.contains(document.activeElement) || this.editor.isFocused);
    if (!hasTextSelection && !editingLink) {
      this.hide();
      return;
    }
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
      return [];
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

/** Small renderer adapter that keeps Tiptap JSON behind the Notes string API. */
export class NotesRichTextEditor {
  private readonly editor: Editor;
  private readonly toolbar: HTMLElement;
  private readonly onUpdate: (content: string) => void;
  private readonly onError: (message: string) => void;
  private readonly slashMenu!: NotesRichTextSlashMenu;
  private readonly bubbleMenu!: NotesRichTextBubbleMenu;
  private readonly imageBubbleMenu!: NotesRichTextImageBubbleMenu;
  private readonly tableControls!: NotesRichTextTableControls;
  private readonly host: HTMLElement;
  private readonly overlayRoot: HTMLElement;
  private lastCanonicalContent = EMPTY_RICH_TEXT_CONTENT;
  private restoringCanonicalContent = false;

  public constructor(options: NotesRichTextEditorOptions) {
    this.toolbar = options.toolbar;
    this.host = options.host;
    this.onUpdate = options.onUpdate;
    this.onError = options.onError;
    const overlayRoot = options.toolbar.parentElement;
    if (!overlayRoot) throw new Error('The Rich Text editor overlay root is missing.');
    this.overlayRoot = overlayRoot;
    this.editor = new Editor({
      element: options.host,
      content: parseRichTextContent(EMPTY_RICH_TEXT_CONTENT),
      extensions: [StarterKit.configure({
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
          // HTML paste, plain-text paste, and autolink all share the exact
          // absolute http/https-only policy enforced by canonical persistence.
          isAllowedUri: (url) => isAllowedRichTextLinkHref(url),
          shouldAutoLink: (url) => isAllowedRichTextLinkHref(url),
        },
      }),
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
      createS3ImageExtension(this.onError, () => this.imageBubbleMenu?.sync())],
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
          if (this.tableControls?.handleKeyDown(event)) return true;
          return this.slashMenu?.handleKeyDown(event) ?? false;
        },
        handlePaste: (view, event) => {
          const file = firstImageFile(event.clipboardData?.files);
          if (!file) return false;
          event.preventDefault();
          options.onRequestImage(file, view.state.selection.to);
          return true;
        },
        handleDrop: (view, event, _slice, moved) => {
          if (moved) return false;
          const file = firstImageFile(event.dataTransfer?.files);
          if (!file) return false;
          const position = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
          event.preventDefault();
          options.onRequestImage(file, position);
          return true;
        },
      },
      onUpdate: () => {
        this.emitUpdate();
        this.updateEmptyState();
        this.bubbleMenu?.sync();
        this.imageBubbleMenu?.sync();
        this.tableControls?.sync();
        this.slashMenu?.sync();
      },
      onSelectionUpdate: () => {
        this.updateToolbarState();
        this.bubbleMenu?.sync();
        this.imageBubbleMenu?.sync();
        this.tableControls?.sync();
        this.slashMenu?.sync();
      },
      onTransaction: () => {
        this.updateToolbarState();
        this.updateEmptyState();
        this.bubbleMenu?.sync();
        this.imageBubbleMenu?.sync();
        this.tableControls?.sync();
        this.slashMenu?.sync();
      },
      onFocus: () => {
        this.updateToolbarState();
        this.bubbleMenu?.sync();
        this.imageBubbleMenu?.sync();
        this.tableControls?.sync();
        this.slashMenu?.sync();
      },
      onBlur: () => {
        window.requestAnimationFrame(() => {
          if (this.editor.isDestroyed) return;
          this.updateToolbarState();
          this.bubbleMenu?.sync();
          this.imageBubbleMenu?.sync();
          this.tableControls?.sync();
          this.slashMenu?.sync();
        });
      },
    });
    this.slashMenu = new NotesRichTextSlashMenu(this.editor, this.overlayRoot, options.onRequestImage);
    this.bubbleMenu = new NotesRichTextBubbleMenu(
      this.editor,
      this.toolbar,
      this.overlayRoot,
      this.onError,
    );
    this.imageBubbleMenu = new NotesRichTextImageBubbleMenu(this.editor, this.overlayRoot);
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
      this.tableControls.sync();
      this.slashMenu.sync();
    } catch (error) {
      safelyReport(this.onError, error instanceof Error ? error.message : 'Rich text content could not be opened.');
      throw error;
    }
  }

  public getContent(): string {
    return normalizeEditorContent(this.editor.getJSON());
  }

  public getPlainText(): string {
    return extractRichTextPlainText(this.getContent());
  }

  public focus(): void {
    this.editor.commands.focus();
  }

  public requestMeasure(): void {
    if (this.editor.isDestroyed) return;
    window.requestAnimationFrame(() => {
      if (!this.editor.isDestroyed) this.editor.view.updateState(this.editor.state);
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
    this.toolbar.removeEventListener('click', this.handleToolbarClick);
    this.host.removeEventListener('scroll', this.handleViewportChange);
    window.removeEventListener('resize', this.handleViewportChange);
    this.bubbleMenu.destroy();
    this.imageBubbleMenu.destroy();
    this.tableControls.destroy();
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
    this.tableControls.sync();
    this.slashMenu.sync();
  };

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
    return this.commandChain(command, this.editor.can().chain().focus()).run();
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

  private emitUpdate(): void {
    if (this.restoringCanonicalContent) return;
    try {
      const content = this.getContent();
      this.onUpdate(content);
      this.lastCanonicalContent = content;
    } catch (error) {
      this.restoreLastCanonicalContent();
      safelyReport(this.onError, error instanceof Error ? error.message : 'Rich text content could not be saved.');
    }
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
