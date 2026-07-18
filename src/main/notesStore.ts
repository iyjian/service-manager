import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Note, NoteDraft, NoteLanguage } from '../shared/types';

export const NOTES_SCHEMA_VERSION = 1 as const;

export const NOTE_LIMITS = Object.freeze({
  notes: 10_000,
  nameCharacters: 200,
  contentCharacters: 1_048_576,
  tags: 32,
  tagCharacters: 64,
  idCharacters: 128,
});

export interface NotesSnapshot {
  schemaVersion: typeof NOTES_SCHEMA_VERSION;
  notes: Note[];
}

const DEFAULT_NOTE_NAME = 'Untitled note';
const NOTE_LANGUAGES = new Set<NoteLanguage>([
  'markdown',
  'bash',
  'javascript',
  'typescript',
  'sql',
  'json',
  'yaml',
  'text',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cloneNote(note: Note): Note {
  return { ...note, tags: [...note.tags] };
}

function normalizeName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('Note name must be text.');
  }
  const name = value.trim() || DEFAULT_NOTE_NAME;
  if (name.length > NOTE_LIMITS.nameCharacters) {
    throw new Error(`Note name must not exceed ${NOTE_LIMITS.nameCharacters} characters.`);
  }
  return name;
}

function normalizeContent(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('Note content must be text.');
  }
  if (value.length > NOTE_LIMITS.contentCharacters) {
    throw new Error(`Note content must not exceed ${NOTE_LIMITS.contentCharacters} characters.`);
  }
  return value;
}

function normalizeLanguage(value: unknown): NoteLanguage {
  if (typeof value !== 'string' || !NOTE_LANGUAGES.has(value as NoteLanguage)) {
    throw new Error('Note language is not supported.');
  }
  return value as NoteLanguage;
}

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error('Note tags must be a list of text values.');
  }

  const tags: string[] = [];
  const normalizedTags = new Set<string>();
  for (const rawTag of value) {
    if (typeof rawTag !== 'string') {
      throw new Error('Note tags must contain only text values.');
    }
    const tag = rawTag.trim();
    if (!tag) {
      continue;
    }
    if (tag.length > NOTE_LIMITS.tagCharacters) {
      throw new Error(`Note tags must not exceed ${NOTE_LIMITS.tagCharacters} characters.`);
    }
    const key = tag.toLocaleLowerCase();
    if (normalizedTags.has(key)) {
      continue;
    }
    normalizedTags.add(key);
    tags.push(tag);
  }

  if (tags.length > NOTE_LIMITS.tags) {
    throw new Error(`A note must not have more than ${NOTE_LIMITS.tags} tags.`);
  }
  return tags;
}

function normalizeDraft(value: unknown): NoteDraft {
  if (!isRecord(value)) {
    throw new Error('Note data is invalid.');
  }
  return {
    name: normalizeName(value.name),
    content: normalizeContent(value.content),
    language: normalizeLanguage(value.language),
    tags: normalizeTags(value.tags),
  };
}

function normalizeId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > NOTE_LIMITS.idCharacters) {
    throw new Error('Note ID is invalid.');
  }
  return value.trim();
}

function normalizeTimestamp(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('Note timestamp is invalid.');
  }
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) {
    throw new Error('Note timestamp is invalid.');
  }
  return timestamp.toISOString();
}

function normalizeStoredNote(value: unknown): Note | null {
  if (!isRecord(value)) {
    return null;
  }
  try {
    const draft = normalizeDraft(value);
    return {
      id: normalizeId(value.id),
      ...draft,
      createdAt: normalizeTimestamp(value.createdAt),
      updatedAt: normalizeTimestamp(value.updatedAt),
    };
  } catch {
    return null;
  }
}

function normalizeFile(value: unknown): Note[] {
  if (!isRecord(value) || value.schemaVersion !== NOTES_SCHEMA_VERSION) {
    throw new Error('Unsupported notes file schema.');
  }
  if (!Array.isArray(value.notes)) {
    throw new Error('Notes file is invalid.');
  }

  const notes: Note[] = [];
  const ids = new Set<string>();
  for (const valueNote of value.notes.slice(0, NOTE_LIMITS.notes)) {
    const note = normalizeStoredNote(valueNote);
    if (!note || ids.has(note.id)) {
      continue;
    }
    ids.add(note.id);
    notes.push(note);
  }
  return notes;
}

function normalizeReplacementFile(value: unknown): Note[] {
  if (!isRecord(value) || value.schemaVersion !== NOTES_SCHEMA_VERSION || !Array.isArray(value.notes)) {
    throw new Error('Synced Notes data is invalid.');
  }
  if (value.notes.length > NOTE_LIMITS.notes) throw new Error('Synced Notes data exceeds the supported limit.');
  const notes: Note[] = [];
  const ids = new Set<string>();
  for (const candidate of value.notes) {
    const note = normalizeStoredNote(candidate);
    if (!note || ids.has(note.id)) throw new Error('Synced Notes data is invalid.');
    ids.add(note.id);
    notes.push(note);
  }
  return notes;
}

export class NotesStore {
  private notes: Note[] = [];
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    await this.flush();
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      this.notes = normalizeFile(JSON.parse(raw));
    } catch (error) {
      const filesystemError = error as NodeJS.ErrnoException;
      if (filesystemError.code !== 'ENOENT') {
        throw error;
      }
      this.notes = [];
      await this.persist(this.notes);
    }
  }

  list(): Note[] {
    return this.notes.map(cloneNote);
  }

  create(): Promise<Note> {
    return this.mutate((notes) => {
      if (notes.length >= NOTE_LIMITS.notes) {
        throw new Error(`No more than ${NOTE_LIMITS.notes} notes can be stored.`);
      }
      const timestamp = new Date().toISOString();
      const note: Note = {
        id: randomUUID(),
        name: DEFAULT_NOTE_NAME,
        content: '',
        language: 'markdown',
        tags: [],
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      notes.push(note);
      return note;
    });
  }

  async update(id: string, draft: NoteDraft): Promise<Note> {
    const normalizedId = normalizeId(id);
    const normalizedDraft = normalizeDraft(draft);
    return this.mutate((notes) => {
      const index = notes.findIndex((note) => note.id === normalizedId);
      if (index < 0) {
        throw new Error('Note not found.');
      }
      const note: Note = {
        ...notes[index],
        ...normalizedDraft,
        tags: [...normalizedDraft.tags],
        updatedAt: new Date().toISOString(),
      };
      notes[index] = note;
      return note;
    });
  }

  async delete(id: string): Promise<void> {
    const normalizedId = normalizeId(id);
    return this.mutate((notes) => {
      const index = notes.findIndex((note) => note.id === normalizedId);
      if (index >= 0) {
        notes.splice(index, 1);
      }
    });
  }

  async flush(): Promise<void> {
    await this.operationQueue;
  }

  exportSnapshot(): NotesSnapshot {
    return {
      schemaVersion: NOTES_SCHEMA_VERSION,
      notes: this.list(),
    };
  }

  replaceSnapshot(value: unknown): Promise<void> {
    const replacement = normalizeReplacementFile(value).map(cloneNote);
    const operation = this.operationQueue.then(async () => {
      await this.persist(replacement);
      this.notes = replacement.map(cloneNote);
    });
    this.operationQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private mutate<T>(mutation: (notes: Note[]) => T): Promise<T> {
    const operation = this.operationQueue.then(async () => {
      const nextNotes = this.notes.map(cloneNote);
      const result = mutation(nextNotes);
      await this.persist(nextNotes);
      this.notes = nextNotes;
      return result;
    });
    this.operationQueue = operation.then(() => undefined, () => undefined);
    return operation.then((result) => {
      if (isRecord(result) && Array.isArray(result.tags)) {
        return cloneNote(result as unknown as Note) as T;
      }
      return result;
    });
  }

  private async persist(notes: Note[]): Promise<void> {
    const directory = path.dirname(this.filePath);
    await fs.mkdir(directory, { recursive: true });
    const temporaryPath = path.join(directory, `.${path.basename(this.filePath)}.${process.pid}.${randomUUID()}.tmp`);
    const payload: NotesSnapshot = {
      schemaVersion: NOTES_SCHEMA_VERSION,
      notes: notes.map(cloneNote),
    };

    try {
      await fs.writeFile(temporaryPath, JSON.stringify(payload, null, 2), {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
      await fs.chmod(temporaryPath, 0o600);
      await fs.rename(temporaryPath, this.filePath);
      await fs.chmod(this.filePath, 0o600);
    } catch (error) {
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
