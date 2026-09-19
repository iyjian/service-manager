import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import Database from 'better-sqlite3';
import { EMPTY_RICH_TEXT_CONTENT } from '../../shared/noteRichText';
import type { Note, NoteDraft } from '../../shared/types';
import {
  NOTE_LIMITS,
  NOTES_SCHEMA_VERSION,
  NotesStore,
  normalizeNoteDraft,
  normalizeNoteSnapshot,
  type NotesSnapshot,
  type NoteTombstone,
} from './notesStore';
import { NotesTreeStore, type NotesTreeSnapshot } from './notesTreeStore';
import { NotesTreeViewStore } from './notesTreeViewStore';
import { NotesWorkspaceApplyCoordinator } from './notesWorkspaceApply';

export const NOTES_DATABASE_MAX_BYTES = 128 * 1024 * 1024;

const DATABASE_VERSION = 1;
const APPLICATION_ID = 0x534d4e31;
const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'ascii');
const MAX_NOTE_ROW_BYTES = 8 * 1024 * 1024;
// Exact definitions also form the import allowlist. No stored SQL is executed.
const SCHEMA = {
  notes: 'CREATE TABLE notes (id TEXT PRIMARY KEY NOT NULL, data TEXT NOT NULL) WITHOUT ROWID',
  tombstones: 'CREATE TABLE tombstones (id TEXT PRIMARY KEY NOT NULL, deleted_at TEXT NOT NULL) WITHOUT ROWID',
  tree: 'CREATE TABLE tree (note_id TEXT PRIMARY KEY NOT NULL, parent_id TEXT, sort_order INTEGER NOT NULL, position INTEGER NOT NULL) WITHOUT ROWID',
  meta: 'CREATE TABLE meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL) WITHOUT ROWID',
} as const;

interface DatabaseState {
  notes: NotesSnapshot;
  tombstones: NoteTombstone[];
  tree: NotesTreeSnapshot;
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function noteId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > NOTE_LIMITS.idCharacters) {
    throw new Error('Note ID is invalid.');
  }
  return value.trim();
}

function compareIds(left: { id: string }, right: { id: string }): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

// Keep the legacy replacement contract without exposing its file-format parsers.
function replacement(value: unknown, tombstoneValue?: unknown): Pick<DatabaseState, 'notes' | 'tombstones'> {
  if (!record(value) || value.schemaVersion !== NOTES_SCHEMA_VERSION || !Array.isArray(value.notes)) {
    throw new Error('Synced Notes data is invalid.');
  }
  if (value.notes.length > NOTE_LIMITS.notes) throw new Error('Synced Notes data exceeds the supported limit.');
  const ids = new Set<string>();
  const notes = value.notes.map((candidate) => {
    let note: Note;
    try { note = normalizeNoteSnapshot(candidate); } catch { throw new Error('Synced Notes data is invalid.'); }
    if (ids.has(note.id)) throw new Error('Synced Notes data is invalid.');
    ids.add(note.id);
    return note;
  }).sort(compareIds);
  const rawTombstones = tombstoneValue === undefined ? [] : tombstoneValue;
  if (!Array.isArray(rawTombstones) || rawTombstones.length > NOTE_LIMITS.tombstones) {
    throw new Error('Synced Note tombstones are invalid.');
  }
  const tombstones = rawTombstones.map((candidate): NoteTombstone => {
    try {
      if (!record(candidate) || typeof candidate.deletedAt !== 'string') throw new Error();
      const id = noteId(candidate.id);
      const deletedAt = new Date(candidate.deletedAt).toISOString();
      if (ids.has(id)) throw new Error();
      ids.add(id);
      return { id, deletedAt };
    } catch { throw new Error('Synced Note tombstones are invalid.'); }
  }).sort(compareIds);
  return { notes: { schemaVersion: NOTES_SCHEMA_VERSION, notes }, tombstones };
}

async function privateDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await fs.lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('Notes database directory is invalid.');
  await fs.chmod(directory, 0o700);
}

async function privateFile(filePath: string, allowMissing = false): Promise<boolean> {
  try {
    const metadata = await fs.lstat(filePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('Notes database must be a regular file.');
    await fs.chmod(filePath, 0o600);
    return true;
  } catch (error) {
    if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, 'r').catch(() => undefined);
  try { await handle?.sync().catch(() => undefined); } finally { await handle?.close(); }
}

function configureReader(db: Database.Database): void {
  db.pragma('trusted_schema = OFF');
  db.pragma('query_only = ON');
  db.pragma('cell_size_check = ON');
}

function validateSchema(db: Database.Database): void {
  const entries = db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema LIMIT 5').all() as {
    type: string; name: string; tbl_name: string; sql: string;
  }[];
  if (entries.length !== Object.keys(SCHEMA).length
    || entries.some((entry) => entry.type !== 'table'
      || !Object.prototype.hasOwnProperty.call(SCHEMA, entry.name)
      || entry.tbl_name !== entry.name
      || entry.sql !== SCHEMA[entry.name as keyof typeof SCHEMA])
    || db.pragma('user_version', { simple: true }) !== DATABASE_VERSION
    || db.pragma('application_id', { simple: true }) !== APPLICATION_ID) {
    throw new Error('Unsupported Notes database schema.');
  }
  const integrity = db.pragma('integrity_check(1)') as { integrity_check: string }[];
  if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') {
    throw new Error('Notes database integrity check failed.');
  }
  const meta = db.prepare('SELECT key, value FROM meta LIMIT 2').all();
  if (!isDeepStrictEqual(meta, [{ key: 'schemaVersion', value: String(DATABASE_VERSION) }])) {
    throw new Error('Unsupported Notes database metadata.');
  }
}

function readNote(row: unknown): Note {
  if (!record(row) || typeof row.data !== 'string' || Buffer.byteLength(row.data) > MAX_NOTE_ROW_BYTES) {
    throw new Error('Notes database Note row is invalid.');
  }
  let value: unknown;
  try { value = JSON.parse(row.data) as unknown; } catch { throw new Error('Notes database Note row is invalid.'); }
  const note = normalizeNoteSnapshot(value);
  if (note.id !== row.id) throw new Error('Notes database Note ID is invalid.');
  return note;
}

function readTree(db: Database.Database): NotesTreeSnapshot {
  const rows = db.prepare('SELECT note_id, parent_id, sort_order, position FROM tree ORDER BY position LIMIT 50001').all() as {
    note_id: string; parent_id: string | null; sort_order: number; position: number;
  }[];
  if (rows.length > 50_000 || rows.some((row, index) => row.position !== index)) {
    throw new Error('Notes database tree rows are invalid.');
  }
  return {
    schemaVersion: 1,
    nodes: rows.map((row) => ({ noteId: row.note_id, parentId: row.parent_id, order: row.sort_order })),
  };
}

async function readState(db: Database.Database): Promise<DatabaseState> {
  validateSchema(db);
  const count = db.prepare('SELECT count(*) AS count FROM notes').get() as { count: number };
  if (count.count > NOTE_LIMITS.notes) throw new Error('Synced Notes data exceeds the supported limit.');
  // Check sizes before materializing strings; a malformed database may contain huge blobs.
  const oversized = db.prepare('SELECT 1 FROM notes WHERE length(CAST(data AS BLOB)) > ? LIMIT 1').get(MAX_NOTE_ROW_BYTES);
  if (oversized) throw new Error('Notes database Note row is too large.');
  const notes = [...db.prepare('SELECT id, data FROM notes').iterate()].map(readNote);
  const tombstones = db.prepare('SELECT id, deleted_at AS deletedAt FROM tombstones LIMIT ?').all(NOTE_LIMITS.tombstones + 1);
  const state = replacement({ schemaVersion: NOTES_SCHEMA_VERSION, notes }, tombstones);
  const rawTree = readTree(db);
  // Reuse the legacy parser/repair rules, including the temporary Notes/tree
  // mismatch allowed while the workspace journal is being recovered.
  const validator = new NotesTreeStore('', {
    read: async () => rawTree,
    write: async () => undefined,
  });
  const tree = await validator.load(state.notes.notes.map((note) => note.id));
  return { ...state, tree };
}

function writeTree(db: Database.Database, tree: NotesTreeSnapshot): void {
  db.prepare('DELETE FROM tree').run();
  const insert = db.prepare('INSERT INTO tree (note_id, parent_id, sort_order, position) VALUES (?, ?, ?, ?)');
  tree.nodes.forEach((node, index) => insert.run(node.noteId, node.parentId, node.order, index));
}

function writeReplacement(db: Database.Database, state: Pick<DatabaseState, 'notes' | 'tombstones'>): void {
  const noteIds = new Set(state.notes.notes.map((note) => note.id));
  const tombstoneIds = new Set(state.tombstones.map((item) => item.id));
  const removeNote = db.prepare('DELETE FROM notes WHERE id = ?');
  const removeTombstone = db.prepare('DELETE FROM tombstones WHERE id = ?');
  for (const row of db.prepare('SELECT id FROM notes').all() as { id: string }[]) {
    if (!noteIds.has(row.id)) removeNote.run(row.id);
  }
  for (const row of db.prepare('SELECT id FROM tombstones').all() as { id: string }[]) {
    if (!tombstoneIds.has(row.id)) removeTombstone.run(row.id);
  }
  const upsertNote = db.prepare('INSERT INTO notes (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data WHERE notes.data != excluded.data');
  const upsertTombstone = db.prepare('INSERT INTO tombstones (id, deleted_at) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET deleted_at = excluded.deleted_at WHERE tombstones.deleted_at != excluded.deleted_at');
  for (const note of state.notes.notes) upsertNote.run(note.id, JSON.stringify(note));
  for (const item of state.tombstones) upsertTombstone.run(item.id, item.deletedAt);
}

/** Main-process SQLite storage. NotesStore remains the legacy migration reader. */
export class SqliteNotesStore extends NotesStore {
  readonly databasePath: string;
  private database: Database.Database | undefined;
  private sqlQueue: Promise<void> = Promise.resolve();
  private treeStore: NotesTreeStore | undefined;

  constructor(private readonly userDataPath: string) {
    super(path.join(userDataPath, 'notes-v4'));
    this.databasePath = path.join(userDataPath, 'notes.sqlite3');
  }

  override load(): Promise<void> {
    return this.serialize(async () => {
      if (this.database) return;
      await privateDirectory(this.userDataPath);
      const exists = await privateFile(this.databasePath, true);
      for (const suffix of ['-wal', '-shm', '-journal']) {
        if (await privateFile(`${this.databasePath}${suffix}`, true) && !exists) {
          throw new Error('Notes database is missing but recovery files remain.');
        }
      }
      if (!exists) await this.migrateLegacy();
      const db = new Database(this.databasePath, { fileMustExist: true, timeout: 5_000 });
      try {
        configureReader(db);
        await readState(db);
        db.pragma('query_only = OFF');
        db.pragma('journal_mode = WAL');
        db.pragma('synchronous = FULL');
        // Finish opening the WAL read transaction after switching journal mode.
        // SQLite 3.53 otherwise reports SQLITE_LOCKED on an immediate checkpoint
        // when the connection has not accessed a table in WAL mode yet.
        db.prepare('SELECT count(*) FROM notes').get();
        for (const suffix of ['', '-wal', '-shm']) await privateFile(`${this.databasePath}${suffix}`, true);
        this.database = db;
      } catch (error) {
        db.close();
        throw error;
      }
    });
  }

  override list(): Note[] {
    return this.connection().prepare('SELECT id, data FROM notes').all().map(readNote).sort(compareIds);
  }

  override get(id: string): Note | undefined {
    const normalizedId = noteId(id);
    const row = this.connection().prepare('SELECT id, data FROM notes WHERE id = ?').get(normalizedId);
    return row ? readNote(row) : undefined;
  }

  override create(): Promise<Note> {
    return this.serialize(() => {
      const db = this.connection();
      return db.transaction(() => {
        const count = db.prepare('SELECT count(*) AS count FROM notes').get() as { count: number };
        if (count.count >= NOTE_LIMITS.notes) throw new Error(`No more than ${NOTE_LIMITS.notes} notes can be stored.`);
        let id = randomUUID();
        const reserved = db.prepare('SELECT id FROM notes WHERE id = ? UNION ALL SELECT id FROM tombstones WHERE id = ?');
        while (reserved.get(id, id)) id = randomUUID();
        const timestamp = new Date().toISOString();
        const note: Note = {
          id, name: 'Untitled note', content: EMPTY_RICH_TEXT_CONTENT, language: 'richtext',
          tags: [], createdAt: timestamp, updatedAt: timestamp,
        };
        db.prepare('INSERT INTO notes (id, data) VALUES (?, ?)').run(id, JSON.stringify(note));
        return note;
      }).immediate();
    });
  }

  override async update(id: string, draft: NoteDraft): Promise<Note> {
    const normalizedId = noteId(id);
    const normalizedDraft = normalizeNoteDraft(draft);
    return this.serialize(() => this.connection().transaction(() => {
      const current = this.get(normalizedId);
      if (!current) throw new Error('Note not found.');
      return this.writeUpdatedNote(current, normalizedDraft);
    }).immediate());
  }

  override async compareAndUpdate(id: string, expectedNote: Note, draft: NoteDraft): Promise<Note> {
    const normalizedId = noteId(id);
    const expected = normalizeNoteSnapshot(expectedNote);
    const normalizedDraft = normalizeNoteDraft(draft);
    if (expected.id !== normalizedId) throw new Error('Note update base is invalid.');
    return this.serialize(() => this.connection().transaction(() => {
      const current = this.get(normalizedId);
      if (!current || !isDeepStrictEqual(current, expected)) {
        throw new Error('This Note changed after the editor loaded it. Reload Notes to preserve both versions.');
      }
      return this.writeUpdatedNote(current, normalizedDraft);
    }).immediate());
  }

  override async delete(id: string): Promise<void> { await this.deleteMany([id]); }

  override deleteMany(ids: readonly string[]): Promise<string[]> {
    if (!Array.isArray(ids) || ids.length > NOTE_LIMITS.notes) throw new Error('Deleted Note IDs are invalid.');
    const requested = [...new Set(ids.map(noteId))].sort();
    return this.serialize(() => this.connection().transaction(() => {
      const db = this.connection();
      const exists = db.prepare('SELECT id FROM notes WHERE id = ?');
      const deleted = requested.filter((id) => exists.get(id));
      if (deleted.length === 0) return [];
      const count = db.prepare('SELECT count(*) AS count FROM tombstones').get() as { count: number };
      if (count.count + deleted.length > NOTE_LIMITS.tombstones) {
        throw new Error(`No more than ${NOTE_LIMITS.tombstones} deleted Note records can be stored.`);
      }
      const deletedAt = new Date().toISOString();
      const remove = db.prepare('DELETE FROM notes WHERE id = ?');
      const insert = db.prepare('INSERT INTO tombstones (id, deleted_at) VALUES (?, ?)');
      for (const id of deleted) { remove.run(id); insert.run(id, deletedAt); }
      return deleted;
    }).immediate());
  }

  override async flush(): Promise<void> {
    await this.treeStore?.flush();
    await this.sqlQueue;
  }

  override recoverPendingApply(): Promise<boolean> {
    // SQLite commits each replacement atomically. The workspace coordinator
    // still recovers the Notes/tree boundary using its existing journal.
    return this.serialize(() => { this.connection(); return false; });
  }

  override exportSnapshot(): NotesSnapshot { return { schemaVersion: NOTES_SCHEMA_VERSION, notes: this.list() }; }

  override exportTombstones(): NoteTombstone[] {
    const rows = this.connection().prepare('SELECT id, deleted_at AS deletedAt FROM tombstones').all();
    return replacement({ schemaVersion: NOTES_SCHEMA_VERSION, notes: [] }, rows).tombstones;
  }

  override replaceSnapshot(value: unknown, tombstoneValue?: unknown): Promise<void> {
    const state = replacement(value, tombstoneValue);
    return this.serialize(() => {
      const db = this.connection();
      db.transaction(() => writeReplacement(db, state)).immediate();
    });
  }

  createTreeStore(): NotesTreeStore {
    this.treeStore ??= new NotesTreeStore(path.join(this.userDataPath, 'notes-tree.json'), {
      read: () => this.serialize(() => readTree(this.connection())),
      write: (snapshot) => this.serialize(() => {
        const db = this.connection();
        db.transaction(() => writeTree(db, snapshot)).immediate();
      }),
    });
    return this.treeStore;
  }

  async snapshotBytes(): Promise<Buffer> {
    await this.flush();
    return this.serialize(async () => {
      const db = this.connection();
      const temporaryDirectory = await fs.mkdtemp(path.join(this.userDataPath, '.notes-snapshot-'));
      const temporaryPath = path.join(temporaryDirectory, 'notes.sqlite3');
      let snapshot: Database.Database | undefined;
      try {
        await fs.writeFile(temporaryPath, '', { flag: 'wx', mode: 0o600 });
        // SQLite backup includes committed WAL frames and closes its destination
        // connection before resolving. Never copy the live database file.
        await db.backup(temporaryPath);
        snapshot = new Database(temporaryPath, { fileMustExist: true });
        snapshot.pragma('trusted_schema = OFF');
        snapshot.pragma('journal_mode = DELETE');
        snapshot.close();
        snapshot = undefined;
        const size = (await fs.stat(temporaryPath)).size;
        if (size > NOTES_DATABASE_MAX_BYTES) throw new Error('Notes database snapshot exceeds 128 MiB.');
        return await fs.readFile(temporaryPath);
      } finally {
        try { snapshot?.close(); } finally { await fs.rm(temporaryDirectory, { recursive: true, force: true }); }
      }
    });
  }

  static async decodeSnapshot(bytes: Buffer, userDataPath: string): Promise<DatabaseState> {
    if (!Buffer.isBuffer(bytes) || bytes.length > NOTES_DATABASE_MAX_BYTES
      || bytes.length < 512 || !bytes.subarray(0, SQLITE_HEADER.length).equals(SQLITE_HEADER)) {
      throw new Error('Notes database snapshot is invalid or exceeds 128 MiB.');
    }
    // Take ownership before the first await so the caller cannot mutate input
    // between header validation and writing the private temporary file.
    const input = Buffer.from(bytes);
    await privateDirectory(userDataPath);
    const temporaryDirectory = await fs.mkdtemp(path.join(userDataPath, '.notes-import-'));
    let db: Database.Database | undefined;
    try {
      const temporaryPath = path.join(temporaryDirectory, 'notes.sqlite3');
      await fs.writeFile(temporaryPath, input, { flag: 'wx', mode: 0o600 });
      db = new Database(temporaryPath, { readonly: true, fileMustExist: true, timeout: 5_000 });
      configureReader(db);
      return await readState(db);
    } finally {
      try { db?.close(); } finally { await fs.rm(temporaryDirectory, { recursive: true, force: true }); }
    }
  }

  async close(): Promise<void> {
    await this.flush();
    await this.serialize(() => {
      const db = this.database;
      if (!db) return;
      try { db.pragma('wal_checkpoint(TRUNCATE)'); } finally {
        db.close();
        this.database = undefined;
      }
    });
  }

  private connection(): Database.Database {
    if (!this.database) throw new Error('Notes database is not open.');
    return this.database;
  }

  private serialize<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.sqlQueue.then(operation);
    this.sqlQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private writeUpdatedNote(current: Note, draft: NoteDraft): Note {
    const next = { ...current, ...draft, tags: [...draft.tags], updatedAt: new Date().toISOString() };
    this.connection().prepare('UPDATE notes SET data = ? WHERE id = ?').run(JSON.stringify(next), current.id);
    return next;
  }

  private async migrateLegacy(): Promise<void> {
    const legacy = new NotesStore(path.join(this.userDataPath, 'notes-v4'));
    await legacy.load();
    const activeIds = legacy.list().map((note) => note.id);
    const tree = new NotesTreeStore(path.join(this.userDataPath, 'notes-tree.json'));
    const view = new NotesTreeViewStore(path.join(this.userDataPath, 'notes-tree-view.json'));
    await tree.load(activeIds);
    await view.load(activeIds);
    await new NotesWorkspaceApplyCoordinator(this.userDataPath, legacy, tree, view).recover();
    await legacy.flush();
    await tree.flush();
    await view.flush();

    const temporaryDirectory = await fs.mkdtemp(path.join(this.userDataPath, '.notes-migrate-'));
    const temporaryPath = path.join(temporaryDirectory, 'notes.sqlite3');
    let db: Database.Database | undefined;
    try {
      await fs.writeFile(temporaryPath, '', { flag: 'wx', mode: 0o600 });
      db = new Database(temporaryPath, { fileMustExist: true });
      db.pragma('trusted_schema = OFF');
      db.pragma('journal_mode = DELETE');
      db.pragma('synchronous = FULL');
      db.exec(Object.values(SCHEMA).join(';'));
      db.pragma(`application_id = ${APPLICATION_ID}`);
      db.pragma(`user_version = ${DATABASE_VERSION}`);
      const writer = db;
      writer.transaction(() => {
        writer.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schemaVersion', String(DATABASE_VERSION));
        writeReplacement(writer, { notes: legacy.exportSnapshot(), tombstones: legacy.exportTombstones() });
        writeTree(writer, tree.exportSnapshot());
      }).immediate();
      configureReader(db);
      await readState(db);
      db.close();
      db = undefined;
      // Windows requires a writable handle for fsync. Keep the flush before
      // publication so a failed migration never replaces the active database.
      const handle = await fs.open(temporaryPath, 'r+');
      try { await handle.sync(); } finally { await handle.close(); }
      await fs.rename(temporaryPath, this.databasePath);
      await syncDirectory(this.userDataPath);
    } finally {
      try { db?.close(); } finally { await fs.rm(temporaryDirectory, { recursive: true, force: true }); }
    }
  }
}
