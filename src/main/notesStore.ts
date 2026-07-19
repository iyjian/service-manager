import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { normalizeRichTextContent } from '../shared/noteRichText';
import type { Note, NoteDraft, NoteLanguage } from '../shared/types';

export const NOTES_SCHEMA_VERSION = 1 as const;

export const NOTE_LIMITS = Object.freeze({
  notes: 10_000,
  tombstones: 50_000,
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

export interface NoteTombstone {
  id: string;
  deletedAt: string;
}

type StoredNoteEnvelope = {
  schemaVersion: typeof NOTES_SCHEMA_VERSION;
  note: Note;
} | {
  schemaVersion: typeof NOTES_SCHEMA_VERSION;
  tombstone: NoteTombstone;
};

type StoredNoteState =
  | { kind: 'note'; note: Note }
  | { kind: 'tombstone'; tombstone: NoteTombstone };

const DEFAULT_NOTE_NAME = 'Untitled note';
const NOTE_FILE_PATTERN = /^[a-f0-9]{64}\.json$/;
const NOTE_TEMPORARY_FILE_PATTERN = /^\.[a-f0-9]{64}\.json\.\d+\.[a-f0-9-]+\.tmp$/;
const REPLACEMENT_COMPLETE_FILE = '.replacement-complete.json';
const MAX_NOTE_ENVELOPE_BYTES = 8 * 1024 * 1024;
const MAX_REPLACEMENT_COMPLETE_BYTES = 8 * 1024 * 1024;
const FILE_READ_CHUNK_BYTES = 64 * 1024;
const NOTE_LANGUAGES = new Set<NoteLanguage>([
  'markdown',
  'richtext',
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

function cloneTombstone(tombstone: NoteTombstone): NoteTombstone {
  return { ...tombstone };
}

function compareIds(left: { id: string }, right: { id: string }): number {
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}

function sortNotes(notes: Note[]): Note[] {
  return notes.sort(compareIds);
}

function sortTombstones(tombstones: NoteTombstone[]): NoteTombstone[] {
  return tombstones.sort(compareIds);
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

function normalizeContentForLanguage(value: unknown, language: NoteLanguage): string {
  const content = normalizeContent(value);
  return language === 'richtext' ? normalizeRichTextContent(content) : content;
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
  const language = normalizeLanguage(value.language);
  return {
    name: normalizeName(value.name),
    content: normalizeContentForLanguage(value.content, language),
    language,
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

function normalizeTombstone(value: unknown): NoteTombstone | null {
  if (!isRecord(value)) return null;
  try {
    return {
      id: normalizeId(value.id),
      deletedAt: normalizeTimestamp(value.deletedAt),
    };
  } catch {
    return null;
  }
}

function normalizeStoredEnvelope(value: unknown): StoredNoteState {
  if (!isRecord(value) || value.schemaVersion !== NOTES_SCHEMA_VERSION) {
    throw new Error('Unsupported Note file schema.');
  }
  const hasNote = Object.prototype.hasOwnProperty.call(value, 'note');
  const hasTombstone = Object.prototype.hasOwnProperty.call(value, 'tombstone');
  if (hasNote === hasTombstone) throw new Error('Note file is invalid.');
  if (hasNote) {
    const note = normalizeStoredNote(value.note);
    if (!note) throw new Error('Note file is invalid.');
    return { kind: 'note', note };
  }
  const tombstone = normalizeTombstone(value.tombstone);
  if (!tombstone) throw new Error('Note tombstone file is invalid.');
  return { kind: 'tombstone', tombstone };
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
  return sortNotes(notes);
}

function normalizeReplacementTombstones(value: unknown, reservedIds: ReadonlySet<string>): NoteTombstone[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > NOTE_LIMITS.tombstones) {
    throw new Error('Synced Note tombstones are invalid.');
  }
  const ids = new Set(reservedIds);
  const tombstones: NoteTombstone[] = [];
  for (const candidate of value) {
    const tombstone = normalizeTombstone(candidate);
    if (!tombstone || ids.has(tombstone.id)) throw new Error('Synced Note tombstones are invalid.');
    ids.add(tombstone.id);
    tombstones.push(tombstone);
  }
  return sortTombstones(tombstones);
}

function noteFileName(id: string): string {
  return `${createHash('sha256').update(id, 'utf8').digest('hex')}.json`;
}

function stateId(state: StoredNoteState): string {
  return state.kind === 'note' ? state.note.id : state.tombstone.id;
}

interface StoredDirectoryState {
  notes: Note[];
  tombstones: NoteTombstone[];
}

interface ReplacementCompleteFile {
  schemaVersion: typeof NOTES_SCHEMA_VERSION;
  files: string[];
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(directory, 'r');
    await handle.sync();
  } catch {
    // Directory handles cannot be flushed on every supported filesystem,
    // particularly on Windows. The file itself is still flushed first.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export class NotesStore {
  private notes: Note[] = [];
  private tombstones: NoteTombstone[] = [];
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly directoryPath: string) {}

  async load(): Promise<void> {
    await this.flush();
    const state = await this.recoverInterruptedReplacement();
    this.notes = state.notes.map(cloneNote);
    this.tombstones = state.tombstones.map(cloneTombstone);
  }

  list(): Note[] {
    return this.notes.map(cloneNote);
  }

  create(): Promise<Note> {
    return this.enqueue(async () => {
      if (this.notes.length >= NOTE_LIMITS.notes) {
        throw new Error(`No more than ${NOTE_LIMITS.notes} notes can be stored.`);
      }
      const reservedIds = new Set([
        ...this.notes.map((note) => note.id),
        ...this.tombstones.map((tombstone) => tombstone.id),
      ]);
      let id = randomUUID();
      while (reservedIds.has(id)) id = randomUUID();
      const timestamp = new Date().toISOString();
      const note: Note = {
        id,
        name: DEFAULT_NOTE_NAME,
        content: '',
        language: 'markdown',
        tags: [],
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await this.writeEnvelope(this.directoryPath, { schemaVersion: NOTES_SCHEMA_VERSION, note });
      this.notes = sortNotes([...this.notes, note]);
      return cloneNote(note);
    });
  }

  async update(id: string, draft: NoteDraft): Promise<Note> {
    const normalizedId = normalizeId(id);
    const normalizedDraft = normalizeDraft(draft);
    return this.enqueue(async () => {
      const index = this.notes.findIndex((note) => note.id === normalizedId);
      if (index < 0) throw new Error('Note not found.');
      const note: Note = {
        ...this.notes[index],
        ...normalizedDraft,
        tags: [...normalizedDraft.tags],
        updatedAt: new Date().toISOString(),
      };
      await this.writeEnvelope(this.directoryPath, { schemaVersion: NOTES_SCHEMA_VERSION, note });
      const nextNotes = this.notes.map(cloneNote);
      nextNotes[index] = note;
      this.notes = sortNotes(nextNotes);
      return cloneNote(note);
    });
  }

  async delete(id: string): Promise<void> {
    const normalizedId = normalizeId(id);
    return this.enqueue(async () => {
      const index = this.notes.findIndex((note) => note.id === normalizedId);
      if (index < 0) return;
      if (this.tombstones.length >= NOTE_LIMITS.tombstones) {
        throw new Error(`No more than ${NOTE_LIMITS.tombstones} deleted Note records can be stored.`);
      }
      const tombstone: NoteTombstone = {
        id: normalizedId,
        deletedAt: new Date().toISOString(),
      };
      await this.writeEnvelope(this.directoryPath, { schemaVersion: NOTES_SCHEMA_VERSION, tombstone });
      const nextNotes = this.notes.map(cloneNote);
      nextNotes.splice(index, 1);
      this.notes = sortNotes(nextNotes);
      this.tombstones = sortTombstones([
        ...this.tombstones.filter((candidate) => candidate.id !== normalizedId),
        tombstone,
      ]);
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

  exportTombstones(): NoteTombstone[] {
    return this.tombstones.map(cloneTombstone);
  }

  replaceSnapshot(value: unknown, tombstoneValue?: unknown): Promise<void> {
    const replacement = normalizeReplacementFile(value).map(cloneNote);
    const replacementTombstones = normalizeReplacementTombstones(
      tombstoneValue,
      new Set(replacement.map((note) => note.id)),
    ).map(cloneTombstone);
    return this.enqueue(async () => {
      await this.persistReplacement(replacement, replacementTombstones);
      this.notes = replacement.map(cloneNote);
      this.tombstones = replacementTombstones.map(cloneTombstone);
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation);
    this.operationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private replacementPath(kind: 'next' | 'previous'): string {
    return path.join(path.dirname(this.directoryPath), `.${path.basename(this.directoryPath)}.${kind}`);
  }

  private async requireRealDirectory(directory: string, allowMissing = false): Promise<boolean> {
    let metadata;
    try {
      metadata = await fs.lstat(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && allowMissing) return false;
      throw error;
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error(`Notes path ${path.basename(directory)} must be a real directory.`);
    }
    return true;
  }

  private async ensurePrivateDirectory(directory: string): Promise<void> {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await this.requireRealDirectory(directory);
    await fs.chmod(directory, 0o700);
  }

  private async readBoundedRegularFile(filePath: string, maximumBytes: number): Promise<Buffer> {
    const pathMetadata = await fs.lstat(filePath);
    if (pathMetadata.isSymbolicLink() || !pathMetadata.isFile()) {
      throw new Error(`Notes file ${path.basename(filePath)} must be a regular file.`);
    }
    if (pathMetadata.size > maximumBytes) {
      throw new Error(`Notes file ${path.basename(filePath)} is too large.`);
    }

    let handle: FileHandle | undefined;
    try {
      handle = await fs.open(filePath, 'r');
      const openedMetadata = await handle.stat();
      if (!openedMetadata.isFile()
        || openedMetadata.size > maximumBytes
        || (pathMetadata.ino !== 0 && openedMetadata.ino !== 0 && pathMetadata.ino !== openedMetadata.ino)
        || pathMetadata.dev !== openedMetadata.dev) {
        throw new Error(`Notes file ${path.basename(filePath)} changed while it was being opened.`);
      }

      const chunks: Buffer[] = [];
      let total = 0;
      while (true) {
        const remaining = maximumBytes + 1 - total;
        if (remaining <= 0) throw new Error(`Notes file ${path.basename(filePath)} is too large.`);
        const buffer = Buffer.allocUnsafe(Math.min(FILE_READ_CHUNK_BYTES, remaining));
        const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
        if (bytesRead === 0) break;
        total += bytesRead;
        if (total > maximumBytes) throw new Error(`Notes file ${path.basename(filePath)} is too large.`);
        chunks.push(buffer.subarray(0, bytesRead));
      }
      return Buffer.concat(chunks, total);
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async readStoredEnvelope(
    directory: string,
    fileName: string,
  ): Promise<{ raw: unknown; state: StoredNoteState }> {
    let raw: unknown;
    let state: StoredNoteState;
    try {
      const contents = await this.readBoundedRegularFile(
        path.join(directory, fileName),
        MAX_NOTE_ENVELOPE_BYTES,
      );
      raw = JSON.parse(contents.toString('utf8')) as unknown;
      state = normalizeStoredEnvelope(raw);
    } catch {
      throw new Error(`Stored Note file ${fileName} is invalid.`);
    }
    if (fileName !== noteFileName(stateId(state))) {
      throw new Error(`Stored Note file ${fileName} has an invalid identity.`);
    }
    return { raw, state };
  }

  private async readReplacementCompleteFile(directory: string): Promise<ReplacementCompleteFile> {
    let value: unknown;
    try {
      const contents = await this.readBoundedRegularFile(
        path.join(directory, REPLACEMENT_COMPLETE_FILE),
        MAX_REPLACEMENT_COMPLETE_BYTES,
      );
      value = JSON.parse(contents.toString('utf8')) as unknown;
    } catch {
      throw new Error('The staged Notes replacement completion record is invalid.');
    }
    if (!isRecord(value)
      || value.schemaVersion !== NOTES_SCHEMA_VERSION
      || !Array.isArray(value.files)
      || value.files.length > NOTE_LIMITS.notes + NOTE_LIMITS.tombstones) {
      throw new Error('The staged Notes replacement completion record is invalid.');
    }
    const files: string[] = [];
    const unique = new Set<string>();
    for (const candidate of value.files) {
      if (typeof candidate !== 'string' || !NOTE_FILE_PATTERN.test(candidate) || unique.has(candidate)) {
        throw new Error('The staged Notes replacement completion record is invalid.');
      }
      unique.add(candidate);
      files.push(candidate);
    }
    files.sort();
    return { schemaVersion: NOTES_SCHEMA_VERSION, files };
  }

  private async readDirectoryState(
    directory: string,
    requireCompletion = false,
  ): Promise<StoredDirectoryState> {
    await this.requireRealDirectory(directory);
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const notes: Note[] = [];
    const tombstones: NoteTombstone[] = [];
    const ids = new Set<string>();
    const storedFiles: string[] = [];
    let hasCompletionFile = false;

    for (const entry of entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
      if (entry.name === REPLACEMENT_COMPLETE_FILE) {
        hasCompletionFile = true;
        continue;
      }
      if (NOTE_TEMPORARY_FILE_PATTERN.test(entry.name)) {
        const temporaryPath = path.join(directory, entry.name);
        const metadata = await fs.lstat(temporaryPath);
        if (metadata.isSymbolicLink() || !metadata.isFile()) {
          throw new Error(`Notes file ${entry.name} must be a regular file.`);
        }
        await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
        continue;
      }
      if (!NOTE_FILE_PATTERN.test(entry.name)) continue;

      const { state } = await this.readStoredEnvelope(directory, entry.name);
      const id = stateId(state);
      if (ids.has(id)) throw new Error(`Stored Note file ${entry.name} has a duplicate identity.`);
      ids.add(id);
      storedFiles.push(entry.name);
      if (state.kind === 'note') {
        if (notes.length >= NOTE_LIMITS.notes) throw new Error('Stored Notes exceed the supported limit.');
        notes.push(state.note);
      } else {
        if (tombstones.length >= NOTE_LIMITS.tombstones) {
          throw new Error('Stored Note tombstones exceed the supported limit.');
        }
        tombstones.push(state.tombstone);
      }
    }

    if (requireCompletion && !hasCompletionFile) {
      throw new Error('The staged Notes replacement is incomplete.');
    }
    if (hasCompletionFile) {
      const completion = await this.readReplacementCompleteFile(directory);
      storedFiles.sort();
      if (!isDeepStrictEqual(completion.files, storedFiles)) {
        throw new Error('The staged Notes replacement is incomplete.');
      }
    }
    return {
      notes: sortNotes(notes),
      tombstones: sortTombstones(tombstones),
    };
  }

  private async removeCompletionFile(directory: string): Promise<void> {
    await fs.rm(path.join(directory, REPLACEMENT_COMPLETE_FILE), { force: true }).catch(() => undefined);
    await syncDirectory(directory);
  }

  private async cleanupStaleDirectory(directory: string): Promise<void> {
    if (!await this.requireRealDirectory(directory, true)) return;
    await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
    await syncDirectory(path.dirname(directory));
  }

  private async restorePreviousDirectory(
    previousDirectory: string,
    nextDirectory: string,
    previousState: StoredDirectoryState,
  ): Promise<StoredDirectoryState> {
    const parent = path.dirname(this.directoryPath);
    const invalidDirectory = path.join(
      parent,
      `.${path.basename(this.directoryPath)}.invalid.${process.pid}.${randomUUID()}`,
    );
    await fs.rename(this.directoryPath, invalidDirectory);
    await syncDirectory(parent);
    try {
      await fs.rename(previousDirectory, this.directoryPath);
      await syncDirectory(parent);
    } catch (error) {
      await fs.rename(invalidDirectory, this.directoryPath).catch(() => undefined);
      await syncDirectory(parent);
      throw error;
    }
    await this.cleanupStaleDirectory(nextDirectory);
    await this.removeCompletionFile(this.directoryPath);
    return previousState;
  }

  private async recoverInterruptedReplacement(): Promise<StoredDirectoryState> {
    const nextDirectory = this.replacementPath('next');
    const previousDirectory = this.replacementPath('previous');
    const parent = path.dirname(this.directoryPath);
    if (await this.requireRealDirectory(this.directoryPath, true)) {
      let canonicalState: StoredDirectoryState;
      try {
        canonicalState = await this.readDirectoryState(this.directoryPath);
      } catch (canonicalError) {
        if (!await this.requireRealDirectory(previousDirectory, true)) throw canonicalError;
        let previousState: StoredDirectoryState;
        try {
          previousState = await this.readDirectoryState(previousDirectory);
        } catch {
          throw canonicalError;
        }
        return this.restorePreviousDirectory(previousDirectory, nextDirectory, previousState);
      }
      await this.cleanupStaleDirectory(nextDirectory);
      await this.cleanupStaleDirectory(previousDirectory);
      await this.removeCompletionFile(this.directoryPath);
      return canonicalState;
    }

    if (await this.requireRealDirectory(previousDirectory, true)) {
      const previousState = await this.readDirectoryState(previousDirectory);
      await fs.rename(previousDirectory, this.directoryPath);
      await syncDirectory(parent);
      await this.cleanupStaleDirectory(nextDirectory);
      await this.removeCompletionFile(this.directoryPath);
      return previousState;
    }

    if (await this.requireRealDirectory(nextDirectory, true)) {
      const nextState = await this.readDirectoryState(nextDirectory, true);
      await fs.rename(nextDirectory, this.directoryPath);
      await syncDirectory(parent);
      await this.removeCompletionFile(this.directoryPath);
      return nextState;
    }

    await this.ensurePrivateDirectory(this.directoryPath);
    return { notes: [], tombstones: [] };
  }

  private async writeAtomicPrivateFile(directory: string, fileName: string, payload: string): Promise<void> {
    await this.ensurePrivateDirectory(directory);
    const temporaryPath = path.join(directory, `.${fileName}.${process.pid}.${randomUUID()}.tmp`);
    const destinationPath = path.join(directory, fileName);
    let handle: FileHandle | undefined;
    try {
      handle = await fs.open(temporaryPath, 'wx', 0o600);
      await handle.writeFile(payload, 'utf8');
      await handle.chmod(0o600);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.rename(temporaryPath, destinationPath);
      await syncDirectory(directory);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async writeEnvelope(directory: string, envelope: StoredNoteEnvelope): Promise<void> {
    const id = 'note' in envelope ? envelope.note.id : envelope.tombstone.id;
    await this.writeAtomicPrivateFile(
      directory,
      noteFileName(id),
      JSON.stringify(envelope, null, 2),
    );
  }

  private async writeReplacementCompleteFile(directory: string, files: string[]): Promise<void> {
    const completion: ReplacementCompleteFile = {
      schemaVersion: NOTES_SCHEMA_VERSION,
      files: [...files].sort(),
    };
    await this.writeAtomicPrivateFile(
      directory,
      REPLACEMENT_COMPLETE_FILE,
      JSON.stringify(completion),
    );
  }

  private async linkEnvelope(directory: string, envelope: StoredNoteEnvelope): Promise<boolean> {
    const id = 'note' in envelope ? envelope.note.id : envelope.tombstone.id;
    const fileName = noteFileName(id);
    const destination = path.join(directory, fileName);
    try {
      const sourceMetadata = await fs.lstat(path.join(this.directoryPath, fileName));
      if (sourceMetadata.isSymbolicLink()
        || !sourceMetadata.isFile()
        || sourceMetadata.size > MAX_NOTE_ENVELOPE_BYTES) {
        return false;
      }
      await fs.link(
        path.join(this.directoryPath, fileName),
        destination,
      );
      const linked = await this.readStoredEnvelope(directory, fileName);
      if (!isDeepStrictEqual(linked.raw, envelope)) throw new Error('linked envelope differs');
      await fs.chmod(destination, 0o600);
      await syncDirectory(directory);
      return true;
    } catch {
      await fs.rm(destination, { force: true }).catch(() => undefined);
      await syncDirectory(directory);
      return false;
    }
  }

  private async persistReplacement(notes: Note[], tombstones: NoteTombstone[]): Promise<void> {
    await this.recoverInterruptedReplacement();
    await this.ensurePrivateDirectory(this.directoryPath);
    const nextDirectory = this.replacementPath('next');
    const previousDirectory = this.replacementPath('previous');
    await fs.rm(nextDirectory, { recursive: true, force: true });
    await fs.rm(previousDirectory, { recursive: true, force: true });
    await this.ensurePrivateDirectory(nextDirectory);

    let currentMoved = false;
    let replacementPromoted = false;
    try {
      const currentNotes = new Map(this.notes.map((note) => [note.id, note]));
      const currentTombstones = new Map(this.tombstones.map((tombstone) => [tombstone.id, tombstone]));
      for (const note of notes) {
        const envelope: StoredNoteEnvelope = { schemaVersion: NOTES_SCHEMA_VERSION, note };
        if (!isDeepStrictEqual(currentNotes.get(note.id), note)
          || !await this.linkEnvelope(nextDirectory, envelope)) {
          await this.writeEnvelope(nextDirectory, envelope);
        }
      }
      for (const tombstone of tombstones) {
        const envelope: StoredNoteEnvelope = { schemaVersion: NOTES_SCHEMA_VERSION, tombstone };
        if (!isDeepStrictEqual(currentTombstones.get(tombstone.id), tombstone)
          || !await this.linkEnvelope(nextDirectory, envelope)) {
          await this.writeEnvelope(nextDirectory, envelope);
        }
      }
      await this.writeReplacementCompleteFile(nextDirectory, [
        ...notes.map((note) => noteFileName(note.id)),
        ...tombstones.map((tombstone) => noteFileName(tombstone.id)),
      ]);

      await fs.rename(this.directoryPath, previousDirectory);
      currentMoved = true;
      await syncDirectory(path.dirname(this.directoryPath));
      await fs.rename(nextDirectory, this.directoryPath);
      replacementPromoted = true;
      await syncDirectory(path.dirname(this.directoryPath));
    } catch (error) {
      if (currentMoved && !replacementPromoted) {
        try {
          await fs.rename(previousDirectory, this.directoryPath);
          currentMoved = false;
          await syncDirectory(path.dirname(this.directoryPath));
        } catch (rollbackError) {
          const replacementMessage = error instanceof Error ? error.message : String(error);
          const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
          throw new Error(
            `Notes replacement failed and the previous directory could not be restored: ${replacementMessage}; ${rollbackMessage}`,
          );
        }
      }
      throw error;
    } finally {
      if (!replacementPromoted) {
        await fs.rm(nextDirectory, { recursive: true, force: true }).catch(() => undefined);
        await syncDirectory(path.dirname(this.directoryPath));
      }
    }

    await this.removeCompletionFile(this.directoryPath);
    await fs.rm(previousDirectory, { recursive: true, force: true }).catch(() => undefined);
    await syncDirectory(path.dirname(this.directoryPath));
  }
}
