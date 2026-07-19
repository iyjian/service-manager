import { Editor, type ChainedCommands, type NodeViewRendererProps } from '@tiptap/core';
import Image from '@tiptap/extension-image';
import StarterKit from '@tiptap/starter-kit';
import {
  EMPTY_RICH_TEXT_CONTENT,
  extractRichTextPlainText,
  isAllowedRichTextLinkHref,
  normalizeRichTextContent,
  parseNoteImageReference,
  parseRichTextContent,
  type NoteImageReference,
} from './noteRichText.js';

export type RichTextToolbarCommand =
  | 'undo'
  | 'redo'
  | 'bold'
  | 'italic'
  | 'strike'
  | 'code'
  | 'heading'
  | 'bulletList'
  | 'orderedList'
  | 'blockquote';

export interface NotesRichTextEditorOptions {
  host: HTMLElement;
  toolbar: HTMLElement;
  onUpdate: (content: string) => void;
  onError: (message: string) => void;
}

type NotesImageLoadResult =
  | { status: 'loaded'; bytes: Uint8Array; mimeType: NoteImageReference['mimeType'] }
  | { status: 'not-configured' | 'missing' | 'error' };

const TOOLBAR_COMMANDS = new Set<RichTextToolbarCommand>([
  'undo',
  'redo',
  'bold',
  'italic',
  'strike',
  'code',
  'heading',
  'bulletList',
  'orderedList',
  'blockquote',
]);

const TOGGLE_COMMANDS = new Set<RichTextToolbarCommand>([
  'bold',
  'italic',
  'strike',
  'code',
  'heading',
  'bulletList',
  'orderedList',
  'blockquote',
]);

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

function createS3ImageNodeView(
  initialNode: NodeViewRendererProps['node'],
  onError: (message: string) => void,
): {
  dom: HTMLElement;
  update: (node: NodeViewRendererProps['node']) => boolean;
  ignoreMutation: () => boolean;
  destroy: () => void;
} {
  const dom = document.createElement('figure');
  dom.className = 'notes-richtext-image';
  dom.contentEditable = 'false';

  let node = initialNode;
  let objectUrl: string | undefined;
  let requestedReferenceKey: string | undefined;
  let loadGeneration = 0;
  let destroyed = false;

  const revokeObjectUrl = (): void => {
    if (!objectUrl) return;
    URL.revokeObjectURL(objectUrl);
    objectUrl = undefined;
  };

  const showState = (state: 'loading' | 'not-configured' | 'missing' | 'error', text: string): void => {
    const status = document.createElement('span');
    status.className = 'notes-richtext-image-status';
    status.dataset.state = state;
    status.setAttribute('role', 'status');
    status.textContent = text;
    dom.replaceChildren(status);
  };

  const reload = async (): Promise<void> => {
    let reference: NoteImageReference;
    try {
      reference = parseNoteImageReference(node.attrs);
    } catch {
      if (destroyed) return;
      loadGeneration += 1;
      requestedReferenceKey = undefined;
      revokeObjectUrl();
      showState('error', 'Unable to load image.');
      safelyReport(onError, 'The embedded image reference is invalid.');
      return;
    }
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
      if (!destroyed && generation === loadGeneration) dom.replaceChildren(image);
    }, { once: true });
    image.addEventListener('error', () => {
      if (destroyed || generation !== loadGeneration) return;
      revokeObjectUrl();
      showState('error', 'Unable to load image.');
      safelyReport(onError, 'An embedded image could not be displayed.');
    }, { once: true });
    image.src = nextObjectUrl;
  };

  void reload();
  return {
    dom,
    update(updatedNode): boolean {
      if (updatedNode.type.name !== 's3Image') return false;
      node = updatedNode;
      void reload();
      return true;
    },
    ignoreMutation: () => true,
    destroy(): void {
      destroyed = true;
      loadGeneration += 1;
      revokeObjectUrl();
      dom.replaceChildren();
    },
  };
}

function createS3ImageExtension(onError: (message: string) => void) {
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
      return ({ node }) => createS3ImageNodeView(node, onError);
    },
  });
}

/** Small renderer adapter that keeps Tiptap JSON behind the Notes string API. */
export class NotesRichTextEditor {
  private readonly editor: Editor;
  private readonly toolbar: HTMLElement;
  private readonly onUpdate: (content: string) => void;
  private readonly onError: (message: string) => void;
  private lastCanonicalContent = EMPTY_RICH_TEXT_CONTENT;
  private restoringCanonicalContent = false;

  public constructor(options: NotesRichTextEditorOptions) {
    this.toolbar = options.toolbar;
    this.onUpdate = options.onUpdate;
    this.onError = options.onError;
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
      }), createS3ImageExtension(this.onError)],
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
      },
      onUpdate: () => this.emitUpdate(),
      onSelectionUpdate: () => this.updateToolbarState(),
      onTransaction: () => this.updateToolbarState(),
      onFocus: () => this.updateToolbarState(),
      onBlur: () => this.updateToolbarState(),
    });
    this.toolbar.addEventListener('click', this.handleToolbarClick);
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
      this.updateToolbarState();
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

  public insertImage(value: NoteImageReference): boolean {
    let reference: NoteImageReference;
    try {
      reference = parseNoteImageReference(value);
    } catch (error) {
      safelyReport(this.onError, error instanceof Error ? error.message : 'The embedded image reference is invalid.');
      return false;
    }
    const inserted = this.editor.chain().focus().insertContent({
      type: 's3Image',
      attrs: reference,
    }).run();
    this.updateToolbarState();
    return inserted;
  }

  public run(command: RichTextToolbarCommand): boolean {
    const completed = this.commandChain(command, this.editor.chain().focus()).run();
    this.updateToolbarState();
    return completed;
  }

  public runToolbarCommand(command: RichTextToolbarCommand): boolean {
    return this.run(command);
  }

  public destroy(): void {
    this.toolbar.removeEventListener('click', this.handleToolbarClick);
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

  private commandChain(command: RichTextToolbarCommand, chain: ChainedCommands): ChainedCommands {
    switch (command) {
      case 'undo': return chain.undo();
      case 'redo': return chain.redo();
      case 'bold': return chain.toggleBold();
      case 'italic': return chain.toggleItalic();
      case 'strike': return chain.toggleStrike();
      case 'code': return chain.toggleCode();
      case 'heading': return chain.toggleHeading({ level: 2 });
      case 'bulletList': return chain.toggleBulletList();
      case 'orderedList': return chain.toggleOrderedList();
      case 'blockquote': return chain.toggleBlockquote();
    }
  }

  private canRun(command: RichTextToolbarCommand): boolean {
    return this.commandChain(command, this.editor.can().chain().focus()).run();
  }

  private isActive(command: RichTextToolbarCommand): boolean {
    switch (command) {
      case 'bold': return this.editor.isActive('bold');
      case 'italic': return this.editor.isActive('italic');
      case 'strike': return this.editor.isActive('strike');
      case 'code': return this.editor.isActive('code');
      case 'heading': return this.editor.isActive('heading', { level: 2 });
      case 'bulletList': return this.editor.isActive('bulletList');
      case 'orderedList': return this.editor.isActive('orderedList');
      case 'blockquote': return this.editor.isActive('blockquote');
      case 'undo':
      case 'redo':
        return false;
    }
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
