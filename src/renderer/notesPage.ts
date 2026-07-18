import type { Note, NoteDraft, NoteLanguage } from '../shared/types';
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
import { registerPage } from './nav.js';

const NOTE_SAVE_DEBOUNCE_MS = 250;

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

  return note.content.toLocaleLowerCase().includes(query) ? 200 : 0;
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

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing required element: ${selector}`);
  return element;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : String(error);
}

function normalizeTags(value: string): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const part of value.split(',')) {
    const tag = part.trim();
    const key = tag.toLocaleLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
  }
  return tags;
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

class NotesPage {
  private readonly newButton = requireElement<HTMLButtonElement>('#notes-new-btn');
  private readonly searchInput = requireElement<HTMLInputElement>('#notes-search');
  private readonly list = requireElement<HTMLElement>('#notes-list');
  private readonly emptyState = requireElement<HTMLElement>('#notes-empty');
  private readonly editor = requireElement<HTMLElement>('#notes-editor');
  private readonly nameInput = requireElement<HTMLInputElement>('#note-name');
  private readonly languageSelect = requireElement<HTMLSelectElement>('#note-language');
  private readonly tagsInput = requireElement<HTMLInputElement>('#note-tags');
  private readonly contentHost = requireElement<HTMLElement>('#note-content');
  private readonly copyButton = requireElement<HTMLButtonElement>('#note-copy-btn');
  private readonly copyLabel = requireElement<HTMLElement>('#note-copy-label');
  private readonly saveStatus = requireElement<HTMLElement>('#note-save-status');
  private readonly languageCompartment = new Compartment();
  private readonly codeEditor: EditorView;

  private notes: Note[] = [];
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
  private readonly deletedIds = new Set<string>();
  private editorLanguage: NoteLanguage = 'markdown';
  private editorNoteId: string | undefined;
  private replacingEditorDocument = false;

  constructor() {
    this.codeEditor = new EditorView({
      state: this.createEditorState('', 'markdown'),
      parent: this.contentHost,
    });
    this.updateEditorEmptyState();
    this.newButton.addEventListener('click', () => void this.createNote());
    this.searchInput.addEventListener('input', () => this.renderList());
    this.list.addEventListener('keydown', (event) => this.handleListKeydown(event));

    this.nameInput.addEventListener('input', () => this.updateSelectedFromEditor());
    this.languageSelect.addEventListener('change', () => this.updateSelectedFromEditor());
    this.tagsInput.addEventListener('input', () => this.updateSelectedFromEditor());
    this.copyButton.addEventListener('click', () => void this.copySelectedNote());
  }

  show(): void {
    void this.ensureLoaded();
  }

  hide(): void {
    void this.flushAllPendingSaves().catch(() => undefined);
  }

  flush(): Promise<void> {
    return this.flushAllPendingSaves();
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
    this.loadPromise = window.notesApi.listNotes().then((notes) => {
      this.notes = notes;
      for (const note of notes) {
        this.editVersions.set(note.id, 0);
        this.persistedVersions.set(note.id, 0);
      }
      this.selectedId = notes.some((note) => note.id === this.selectedId)
        ? this.selectedId
        : rankNotes(notes, '')[0]?.id;
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

  private renderList(focusId?: string): void {
    const activeItem = document.activeElement instanceof HTMLButtonElement
      && document.activeElement.classList.contains('notes-list-item')
      ? document.activeElement
      : undefined;
    const restoreFocusId = focusId ?? activeItem?.dataset.noteId;
    const visible = rankNotes(this.notes, this.searchInput.value);
    this.list.replaceChildren();

    for (const note of visible) {
      const row = document.createElement('div');
      row.className = 'notes-list-row';
      row.dataset.noteId = note.id;
      row.dataset.selected = String(note.id === this.selectedId);

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'notes-list-item';
      button.dataset.noteId = note.id;
      button.setAttribute('aria-current', note.id === this.selectedId ? 'true' : 'false');

      const name = document.createElement('span');
      name.className = 'notes-list-item-name';
      name.textContent = note.name || 'Untitled';
      button.appendChild(name);

      button.addEventListener('click', () => this.selectNote(note.id));

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'notes-list-remove';
      remove.dataset.noteId = note.id;
      remove.setAttribute('aria-label', `Remove ${note.name || 'Untitled'}`);
      remove.title = `Remove ${note.name || 'Untitled'}`;
      remove.appendChild(createRemoveIcon());
      remove.addEventListener('click', () => void this.deleteNote(note.id));

      row.append(button, remove);
      this.list.appendChild(row);
    }
    if (visible.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'notes-list-empty';
      empty.textContent = this.notes.length > 0 ? 'No notes match your search.' : 'No notes yet.';
      this.list.appendChild(empty);
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
      this.emptyState.textContent = this.loadError ?? (this.loaded ? 'Create or select a note.' : 'Loading notes…');
      this.emptyState.dataset.state = this.loadError ? 'error' : this.loaded ? 'empty' : 'loading';
      return;
    }

    this.nameInput.value = note.name;
    this.languageSelect.value = note.language;
    this.tagsInput.value = note.tags.join(', ');
    if (this.editorNoteId !== note.id) {
      this.editorNoteId = note.id;
      this.codeEditor.setState(this.createEditorState(note.content, note.language));
      this.updateEditorEmptyState();
    } else {
      this.setEditorLanguage(note.language);
      this.replaceEditorDocument(note.content);
    }
    this.contentHost.dataset.language = note.language;
  }

  private selectedNote(): Note | undefined {
    return this.notes.find((note) => note.id === this.selectedId);
  }

  private selectNote(id: string): void {
    if (id === this.selectedId || !this.notes.some((note) => note.id === id)) return;
    if (this.selectedId) void this.flushNote(this.selectedId);
    this.selectedId = id;
    this.renderList(id);
    this.renderEditor();
    this.setSaveStatus(this.isDirty(id) ? 'Saving…' : 'Saved', this.isDirty(id) ? 'saving' : 'saved');
  }

  private updateSelectedFromEditor(): void {
    const note = this.selectedNote();
    if (!note) return;

    const language = this.languageSelect.value as NoteLanguage;
    note.name = this.nameInput.value;
    note.language = language;
    note.tags = normalizeTags(this.tagsInput.value);
    note.content = this.codeEditor.state.doc.toString();
    this.setEditorLanguage(language);
    this.contentHost.dataset.language = language;
    this.editVersions.set(note.id, (this.editVersions.get(note.id) ?? 0) + 1);
    this.setSaveStatus('Saving…', 'saving');
    if (document.activeElement === this.nameInput || this.searchInput.value.trim()) {
      this.renderList();
    }
    this.scheduleSave(note.id);
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
    const queued = previous.catch(() => undefined).then(async () => {
      if (this.deletedIds.has(id)) return;
      const saved = await window.notesApi.updateNote(id, draft);
      if (this.deletedIds.has(id)) return;

      this.persistedVersions.set(id, Math.max(this.persistedVersions.get(id) ?? 0, version));
      const current = this.notes.find((item) => item.id === id);
      if (current && (this.editVersions.get(id) ?? 0) === version) {
        Object.assign(current, saved, { tags: [...saved.tags] });
      }
      this.renderList();
      if (this.selectedId === id) {
        this.setSaveStatus(this.isDirty(id) ? 'Saving…' : 'Saved', this.isDirty(id) ? 'saving' : 'saved');
      }
    }).catch((error) => {
      if ((this.queuedVersions.get(id) ?? 0) === version) {
        this.queuedVersions.set(id, this.persistedVersions.get(id) ?? 0);
      }
      if (this.selectedId === id && !this.deletedIds.has(id)) {
        this.setSaveStatus(`Save failed: ${toErrorMessage(error)}`, 'error');
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

  private async createNote(): Promise<void> {
    if (this.creating) return;
    await this.ensureLoaded();
    if (!this.loaded) return;
    this.creating = true;
    this.newButton.disabled = true;
    if (this.selectedId) void this.flushNote(this.selectedId);
    try {
      const note = await window.notesApi.createNote();
      this.notes = [note, ...this.notes.filter((item) => item.id !== note.id)];
      this.editVersions.set(note.id, 0);
      this.persistedVersions.set(note.id, 0);
      this.queuedVersions.set(note.id, 0);
      this.selectedId = note.id;
      this.searchInput.value = '';
      this.render();
      this.setSaveStatus('Saved', 'saved');
      window.requestAnimationFrame(() => {
        this.nameInput.focus();
        this.nameInput.select();
      });
    } catch (error) {
      this.loadError = `Unable to create note: ${toErrorMessage(error)}`;
      this.selectedId = undefined;
      this.renderEditor();
    } finally {
      this.creating = false;
      this.newButton.disabled = false;
    }
  }

  private async copySelectedNote(): Promise<void> {
    const note = this.selectedNote();
    if (!note) return;
    try {
      await window.serviceApi.writeClipboardText(note.content);
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
    const note = this.notes.find((item) => item.id === id);
    if (!note) return;
    let confirmed = false;
    try {
      confirmed = await window.serviceApi.confirmAction({
        title: 'Delete Note',
        message: `Delete “${note.name || 'Untitled'}”?`,
        detail: 'This action cannot be undone.',
        kind: 'warning',
        confirmLabel: 'Delete',
        cancelLabel: 'Cancel',
      });
    } catch (error) {
      this.setSaveStatus(`Delete failed: ${toErrorMessage(error)}`, 'error');
      return;
    }
    if (!confirmed) return;

    const visibleBeforeDelete = rankNotes(this.notes, this.searchInput.value);
    const deletedIndex = visibleBeforeDelete.findIndex((item) => item.id === note.id);
    const focusAfterDelete = visibleBeforeDelete[deletedIndex + 1]?.id
      ?? visibleBeforeDelete[deletedIndex - 1]?.id;

    await this.flushNote(note.id);
    this.deletedIds.add(note.id);
    this.clearSaveTimer(note.id);
    try {
      await window.notesApi.deleteNote(note.id);
      this.notes = this.notes.filter((item) => item.id !== note.id);
      this.editVersions.delete(note.id);
      this.persistedVersions.delete(note.id);
      this.queuedVersions.delete(note.id);
      this.saveQueues.delete(note.id);
      if (this.selectedId === note.id) {
        this.selectedId = rankNotes(this.notes, this.searchInput.value)[0]?.id ?? rankNotes(this.notes, '')[0]?.id;
        this.renderEditor();
      }
      this.renderList(focusAfterDelete ?? this.selectedId);
      if (!this.selectedId) this.newButton.focus();
      this.setSaveStatus(this.selectedId ? 'Saved' : '', 'saved');
    } catch (error) {
      this.deletedIds.delete(note.id);
      this.setSaveStatus(`Delete failed: ${toErrorMessage(error)}`, 'error');
    }
  }

  private handleListKeydown(event: KeyboardEvent): void {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const items = Array.from(this.list.querySelectorAll<HTMLButtonElement>('.notes-list-item'));
    if (items.length === 0) return;
    const current = document.activeElement instanceof HTMLButtonElement
      ? items.indexOf(document.activeElement)
      : -1;
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
        darkEditorTheme,
        syntaxHighlighting(darkHighlightStyle),
        this.languageCompartment.of(noteLanguageExtension(language)),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({
          'aria-label': 'Note content',
          'aria-multiline': 'true',
          spellcheck: 'false',
        }),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged || this.replacingEditorDocument) return;
          this.updateSelectedFromEditor();
          this.updateEditorEmptyState();
        }),
      ],
    });
  }

  private setEditorLanguage(language: NoteLanguage): void {
    if (language === this.editorLanguage) return;
    this.editorLanguage = language;
    this.codeEditor.dispatch({
      effects: this.languageCompartment.reconfigure(noteLanguageExtension(language)),
    });
  }

  private updateEditorEmptyState(): void {
    this.contentHost.dataset.empty = String(this.codeEditor.state.doc.length === 0);
  }

  private setSaveStatus(text: string, state: 'saving' | 'saved' | 'error'): void {
    this.saveStatus.textContent = text;
    this.saveStatus.dataset.state = state;
  }
}

let page: NotesPage | undefined;
let flushListenerRegistered = false;

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
