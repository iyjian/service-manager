import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';

export const NOTES_TREE_VIEW_SCHEMA_VERSION = 1 as const;
export const NOTES_TREE_VIEW_MAX_IDS = 10_000;

const MAX_NOTE_ID_CHARACTERS = 128;
const MAX_VIEW_FILE_BYTES = 2 * 1024 * 1024;

export interface NotesTreeViewSnapshot {
  schemaVersion: typeof NOTES_TREE_VIEW_SCHEMA_VERSION;
  expandedNoteIds: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeNoteId(value: unknown): string {
  if (typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_NOTE_ID_CHARACTERS
    || value.trim() !== value) {
    throw new Error('Notes tree view Note ID is invalid.');
  }
  return value;
}

function normalizeIds(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > NOTES_TREE_VIEW_MAX_IDS) {
    throw new Error(`${label} are invalid.`);
  }
  const result: string[] = [];
  const unique = new Set<string>();
  for (const candidate of value) {
    const noteId = normalizeNoteId(candidate);
    if (unique.has(noteId)) throw new Error(`${label} contain a duplicate.`);
    unique.add(noteId);
    result.push(noteId);
  }
  return result.sort(compareText);
}

function parseSnapshot(value: unknown): string[] {
  if (!isRecord(value)
    || value.schemaVersion !== NOTES_TREE_VIEW_SCHEMA_VERSION
    || !Object.prototype.hasOwnProperty.call(value, 'expandedNoteIds')) {
    throw new Error('Notes tree view data is invalid.');
  }
  try {
    return normalizeIds(value.expandedNoteIds, 'Expanded Note IDs');
  } catch {
    throw new Error('Notes tree view data is invalid.');
  }
}

function normalizeSaveValue(value: unknown): string[] {
  if (Array.isArray(value)) return normalizeIds(value, 'Expanded Note IDs');
  if (isRecord(value) && Object.prototype.hasOwnProperty.call(value, 'expandedNoteIds')) {
    return normalizeIds(value.expandedNoteIds, 'Expanded Note IDs');
  }
  throw new Error('Expanded Note IDs are invalid.');
}

function filterActive(expandedNoteIds: readonly string[], activeNoteIds: readonly string[]): string[] {
  const active = new Set(activeNoteIds);
  return expandedNoteIds.filter((noteId) => active.has(noteId)).sort(compareText);
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function snapshot(expandedNoteIds: readonly string[]): NotesTreeViewSnapshot {
  return {
    schemaVersion: NOTES_TREE_VIEW_SCHEMA_VERSION,
    expandedNoteIds: [...expandedNoteIds],
  };
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(directory, 'r');
    await handle.sync();
  } catch {
    // Directory handles cannot be flushed on every supported filesystem.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export class NotesTreeViewStore {
  private expandedNoteIds: string[] = [];
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  load(activeNoteIds: readonly string[]): Promise<NotesTreeViewSnapshot> {
    const normalizedActiveIds = normalizeIds(activeNoteIds, 'Active Note IDs');
    return this.enqueue(async () => {
      let stored: string[];
      try {
        stored = await this.readSnapshot();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        this.expandedNoteIds = [];
        return this.snapshot();
      }

      const filtered = filterActive(stored, normalizedActiveIds);
      if (!sameIds(stored, filtered)) await this.persist(filtered);
      this.expandedNoteIds = filtered;
      return this.snapshot();
    });
  }

  snapshot(): NotesTreeViewSnapshot {
    return snapshot(this.expandedNoteIds);
  }

  get(): NotesTreeViewSnapshot {
    return this.snapshot();
  }

  save(value: unknown, activeNoteIds: readonly string[]): Promise<NotesTreeViewSnapshot> {
    const normalizedExpandedIds = normalizeSaveValue(value);
    const normalizedActiveIds = normalizeIds(activeNoteIds, 'Active Note IDs');
    const filtered = filterActive(normalizedExpandedIds, normalizedActiveIds);
    return this.enqueue(async () => {
      await this.persist(filtered);
      this.expandedNoteIds = [...filtered];
      return this.snapshot();
    });
  }

  set(
    noteId: string,
    expanded: boolean,
    activeNoteIds: readonly string[],
  ): Promise<NotesTreeViewSnapshot> {
    const normalizedId = normalizeNoteId(noteId);
    if (typeof expanded !== 'boolean') throw new Error('Expanded state is invalid.');
    const normalizedActiveIds = normalizeIds(activeNoteIds, 'Active Note IDs');
    const active = new Set(normalizedActiveIds);
    if (!active.has(normalizedId)) throw new Error('The Note is not active.');

    return this.enqueue(async () => {
      const nextSet = new Set(filterActive(this.expandedNoteIds, normalizedActiveIds));
      if (expanded) nextSet.add(normalizedId);
      else nextSet.delete(normalizedId);
      const next = [...nextSet].sort(compareText);
      if (!sameIds(next, this.expandedNoteIds)) {
        await this.persist(next);
        this.expandedNoteIds = next;
      }
      return this.snapshot();
    });
  }

  replaceActiveIds(activeNoteIds: readonly string[]): Promise<NotesTreeViewSnapshot> {
    const normalizedActiveIds = normalizeIds(activeNoteIds, 'Active Note IDs');
    return this.enqueue(async () => {
      const filtered = filterActive(this.expandedNoteIds, normalizedActiveIds);
      if (!sameIds(filtered, this.expandedNoteIds)) {
        await this.persist(filtered);
        this.expandedNoteIds = filtered;
      }
      return this.snapshot();
    });
  }

  async flush(): Promise<void> {
    await this.operationQueue;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation);
    this.operationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async readSnapshot(): Promise<string[]> {
    let metadata;
    try {
      metadata = await fs.lstat(this.filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw error;
      throw new Error('Notes tree view data could not be read.');
    }
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > MAX_VIEW_FILE_BYTES) {
      throw new Error('Notes tree view data is invalid.');
    }

    let handle: FileHandle | undefined;
    try {
      handle = await fs.open(this.filePath, 'r');
      const opened = await handle.stat();
      if (!opened.isFile()
        || opened.size > MAX_VIEW_FILE_BYTES
        || (metadata.ino !== 0 && opened.ino !== 0 && metadata.ino !== opened.ino)
        || metadata.dev !== opened.dev) {
        throw new Error('Notes tree view data is invalid.');
      }
      const contents = await handle.readFile();
      if (contents.byteLength > MAX_VIEW_FILE_BYTES) throw new Error('Notes tree view data is invalid.');
      let value: unknown;
      try {
        value = JSON.parse(contents.toString('utf8')) as unknown;
      } catch {
        throw new Error('Notes tree view data is invalid.');
      }
      return parseSnapshot(value);
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async persist(expandedNoteIds: readonly string[]): Promise<void> {
    const directory = path.dirname(this.filePath);
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    let handle: FileHandle | undefined;
    try {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const directoryMetadata = await fs.lstat(directory);
      if (directoryMetadata.isSymbolicLink() || !directoryMetadata.isDirectory()) {
        throw new Error('Notes tree view directory is invalid.');
      }
      handle = await fs.open(temporaryPath, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(snapshot(expandedNoteIds), null, 2), 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.rename(temporaryPath, this.filePath);
      await fs.chmod(this.filePath, 0o600).catch(() => undefined);
      await syncDirectory(directory);
    } catch {
      await handle?.close().catch(() => undefined);
      await fs.unlink(temporaryPath).catch(() => undefined);
      throw new Error('Notes tree view data could not be saved.');
    }
  }
}
