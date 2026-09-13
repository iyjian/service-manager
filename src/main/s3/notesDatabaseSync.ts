import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { S3SharedAppData } from './s3DataMerge';
import { encryptNotesDatabase, NotesDatabaseS3Store, type NotesDatabaseS3Options } from './notesDatabaseS3';
import { getS3SyncEncryptionKeyId } from './s3SyncV4';
import { normalizeS3EndpointBucket } from './s3Request';

export type SharedNotes = S3SharedAppData['notes'];
export type NotesDatabaseAction = 'up-to-date' | 'pulled' | 'pushed' | 'remote-updated' | 'diverged';

/** Compare records, not SQLite page layout, timestamps or device clocks. */
export function hashNotesDatabaseState(notes: SharedNotes): string {
  const byId = (a: { id: string }, b: { id: string }): number => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  return createHash('sha256').update(JSON.stringify({
    notes: [...notes.notes].sort(byId).map((note) => ({
      id: note.id, name: note.name, content: note.content, language: note.language,
      tags: [...note.tags], createdAt: note.createdAt, updatedAt: note.updatedAt,
    })),
    tombstones: [...notes.tombstones].sort(byId).map(({ id, deletedAt }) => ({ id, deletedAt })),
    tree: [...notes.tree.nodes].sort((a, b) => byId({ id: a.noteId }, { id: b.noteId }))
      .map(({ noteId, parentId, order }) => ({ noteId, parentId, order })),
  })).digest('hex');
}

export interface NotesDatabaseSnapshot {
  bytes: Buffer;
  hash: string;
}

export interface NotesDatabaseSyncOptions {
  userDataPath: string;
  /** Optional cheap path for unchanged cloud checks; avoids creating a backup file. */
  currentHash?(): Promise<string>;
  capture(): Promise<NotesDatabaseSnapshot>;
  inspect(bytes: Buffer): Promise<string>;
  /** Must freeze/flush the editor, then compare expectedHash inside the mutation queue. */
  apply(bytes: Buffer, expectedHash: string): Promise<boolean>;
  importLegacy(notes: SharedNotes, expectedHash: string): Promise<boolean>;
}

interface SyncCheckpoint {
  schemaVersion: 1;
  initialHash: string;
  target?: string;
  syncedHash?: string;
  applyingHash?: string;
  publishingHash?: string;
  publishingEtag?: string;
  remoteEtag?: string;
  remoteKeyId?: string;
  legacyImported?: boolean;
}

export interface LegacyNotesSource {
  cloud: SharedNotes;
  base?: SharedNotes;
}

const HASH = /^[a-f0-9]{64}$/;

/** A database is the conflict unit. Divergence blocks both upload and download. */
export class NotesDatabaseSync {
  private checkpoint?: SyncCheckpoint;
  private readonly statePath: string;
  private readonly recoveryPath: string;
  private observed?: { target: string; etag: string; hash: string; keyId: string };

  constructor(private readonly options: NotesDatabaseSyncOptions) {
    this.statePath = path.join(options.userDataPath, 'notes-database-sync.json');
    this.recoveryPath = path.join(options.userDataPath, 'notes-database-recovery');
  }

  async initialize(): Promise<void> {
    if (this.checkpoint) return;
    try {
      const stat = await fs.lstat(this.statePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16_384) throw new Error('Invalid checkpoint');
      const value: unknown = JSON.parse(await fs.readFile(this.statePath, 'utf8'));
      if (!value || typeof value !== 'object') throw new Error('Invalid checkpoint');
      const state = value as SyncCheckpoint;
      if (state.schemaVersion !== 1 || !HASH.test(state.initialHash)
        || (state.target !== undefined && !HASH.test(state.target))
        || (state.syncedHash !== undefined && !HASH.test(state.syncedHash))
        || (state.applyingHash !== undefined && !HASH.test(state.applyingHash))
        || (state.publishingHash !== undefined && !HASH.test(state.publishingHash))
        || (state.publishingEtag !== undefined && (typeof state.publishingEtag !== 'string'
          || state.publishingEtag.length > 512 || !/^"[\x21\x23-\x7e\x80-\xff]*"$/.test(state.publishingEtag)))
        || (state.remoteKeyId !== undefined && !HASH.test(state.remoteKeyId))
        || (state.remoteEtag !== undefined && (typeof state.remoteEtag !== 'string'
          || state.remoteEtag.length > 512 || !/^"[\x21\x23-\x7e\x80-\xff]*"$/.test(state.remoteEtag)))
        || (state.legacyImported !== undefined && typeof state.legacyImported !== 'boolean')) {
        throw new Error('Invalid checkpoint');
      }
      this.checkpoint = state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error('The Notes database sync checkpoint is invalid. Local Notes were preserved.');
      }
      const hash = this.options.currentHash ? await this.options.currentHash() : (await this.options.capture()).hash;
      await this.commit({ schemaVersion: 1, initialHash: hash });
    }
  }

  async sync(
    connection: NotesDatabaseS3Options,
    loadLegacy: () => Promise<LegacyNotesSource | undefined>,
    mode: 'auto' | 'manual' | 'check' = 'manual',
    onUpload?: () => void,
  ): Promise<NotesDatabaseAction> {
    await this.initialize();
    const normalized = normalizeS3EndpointBucket(connection.endpoint, connection.bucket);
    const target = createHash('sha256').update(`${normalized.endpoint}\0${normalized.bucket}`).digest('hex');
    let state = this.checkpoint as SyncCheckpoint;
    if (state.target !== target) {
      state = { schemaVersion: 1, initialHash: state.syncedHash ?? state.initialHash, target };
      await this.commit(state);
    }
    const store = new NotesDatabaseS3Store(connection);
    let action: 'up-to-date' | 'pulled' | 'pushed' = 'up-to-date';
    for (let attempt = 0; attempt < 4; attempt += 1) {
      this.assertActive(connection);
      state = this.checkpoint as SyncCheckpoint;
      const currentKeyId = getS3SyncEncryptionKeyId(connection.syncEncryptionKey);
      const knownEtag = mode === 'check'
        ? this.observed?.target === target && this.observed.keyId === currentKeyId
          ? this.observed.etag : state.remoteKeyId === currentKeyId ? state.remoteEtag : undefined
        : state.remoteEtag;
      let remote = await store.get(knownEtag);
      if (remote.status === 'not-modified') {
        const hash = this.options.currentHash ? await this.options.currentHash() : (await this.options.capture()).hash;
        this.assertActive(connection);
        if (mode === 'check') {
          const cached = this.observed?.target === target && this.observed.etag === knownEtag ? this.observed : undefined;
          const remoteHash = cached ? cached.hash : state.syncedHash;
          if (hash === remoteHash && cached) {
            await this.commit(this.acknowledged(state, hash, cached.etag, cached.keyId));
          }
          if (remoteHash) return this.classify(state, hash, remoteHash);
        }
        if (hash === state.syncedHash
          && state.remoteKeyId === getS3SyncEncryptionKeyId(connection.syncEncryptionKey)) return action;
        // A replacement needs the exact previous bytes for its recovery backup.
        remote = await store.get();
        if (remote.status === 'not-modified') throw new Error('The Notes database response is invalid.');
      }
      let local = await this.options.capture();
      if (remote.status === 'missing') this.observed = undefined;
      state = this.checkpoint as SyncCheckpoint;
      // Complete an interrupted pull without misclassifying it as a local edit.
      if (state.applyingHash === local.hash) {
        state = { ...state, syncedHash: local.hash, applyingHash: undefined };
        await this.commit(state);
      }
      if (remote.status === 'missing' && mode === 'check') {
        return state.remoteEtag ? 'diverged' : 'up-to-date';
      }
      if (remote.status === 'missing' && state.remoteEtag) return 'diverged';
      if (remote.status === 'missing' && !state.legacyImported) {
        const legacy = await loadLegacy();
        this.assertActive(connection);
        if (legacy) {
          // Local changes since the old committed manifest are retained. Otherwise
          // import the latest legacy cloud workspace, including deletions and tree.
          const localChanged = legacy.base
            ? local.hash !== hashNotesDatabaseState(legacy.base)
            : local.hash !== state.initialHash;
          if (!localChanged || local.hash === hashNotesDatabaseState(legacy.cloud)) {
            await this.backup(local.bytes, connection, 'migration');
            const importedHash = hashNotesDatabaseState(legacy.cloud);
            await this.commit({ ...state, applyingHash: importedHash });
            if (!await this.options.importLegacy(legacy.cloud, local.hash)) {
              await this.commit({ ...state, applyingHash: undefined });
              continue;
            }
            state = this.acknowledged(state, importedHash);
            local = await this.options.capture();
          } else {
            // Preserve the remote legacy workspace in S3; its immutable objects
            // are never deleted when the local workspace is the migration winner.
            await this.backup(local.bytes, connection, 'migration');
          }
        }
        state = { ...state, legacyImported: true };
        await this.commit(state);
      }

      if (remote.status === 'found') {
        const remoteHash = await this.options.inspect(remote.bytes);
        this.observed = { target, etag: remote.etag, hash: remoteHash, keyId: remote.encryptionKeyId };
        this.assertActive(connection);
        if (state.publishingHash && remoteHash === state.publishingHash) {
          // Only the exact attempted contents prove an interrupted PUT succeeded.
          // A different remote remains divergent instead of silently accepting it.
          state = this.acknowledged(state, state.publishingHash);
          await this.commit(state);
        }
        const needsRotation = remote.encryptionKeyId !== getS3SyncEncryptionKeyId(connection.syncEncryptionKey);
        const classification = this.classify(state, local.hash, remoteHash);
        if (mode === 'check' && remoteHash === local.hash) {
          await this.commit(this.acknowledged(state, local.hash, remote.etag, remote.encryptionKeyId));
        }
        if (mode === 'check' || classification === 'diverged'
          || (classification === 'remote-updated' && mode !== 'manual')) return classification;
        if (remoteHash === local.hash && !needsRotation) {
          await this.commit(this.acknowledged(state, local.hash, remote.etag, remote.encryptionKeyId));
          return action;
        }
        const dirty = local.hash !== (state.syncedHash ?? state.initialHash);
        if (!dirty && remoteHash !== local.hash) {
          await this.backup(local.bytes, connection, 'before-pull');
          // Record the intended result before touching the local workspace.
          await this.commit({ ...state, applyingHash: remoteHash });
          if (!await this.options.apply(remote.bytes, local.hash)) {
            await this.commit({ ...state, applyingHash: undefined });
            continue;
          }
          state = this.acknowledged(state, remoteHash, remote.etag, remote.encryptionKeyId);
          await this.commit(state);
          action = 'pulled';
          if (!needsRotation) return action;
          local = await this.options.capture();
        }
        // Back up exactly the remote version guarded by this ETag. If another
        // device publishes, retry from GET and back up that version as well.
        await this.backup(remote.bytes, connection, 'before-push');
      }
      this.assertActive(connection);
      await this.commit({ ...state, publishingHash: local.hash,
        publishingEtag: remote.status === 'found' ? remote.etag : undefined });
      onUpload?.();
      const written = await store.put(local.bytes, remote.status === 'found' ? remote.etag : undefined);
      if (written.status === 'conflict') {
        await this.commit({ ...state, publishingHash: undefined, publishingEtag: undefined });
        continue;
      }
      await this.commit(this.acknowledged(state, local.hash, written.etag,
        getS3SyncEncryptionKeyId(connection.syncEncryptionKey)));
      return 'pushed';
    }
    throw new Error('The Notes database changed repeatedly during sync. Local changes remain saved; retry sync.');
  }

  private assertActive(connection: NotesDatabaseS3Options): void {
    if (connection.signal?.aborted) throw new Error('Notes database sync was cancelled.');
  }

  private classify(state: SyncCheckpoint, localHash: string, remoteHash: string): NotesDatabaseAction {
    if (localHash === remoteHash) return 'up-to-date';
    const base = state.syncedHash ?? state.initialHash;
    if (remoteHash === base) return 'up-to-date';
    return localHash === base ? 'remote-updated' : 'diverged';
  }

  async classifyObserved(): Promise<NotesDatabaseAction> {
    if (!this.observed || !this.checkpoint || this.observed.target !== this.checkpoint.target) return 'diverged';
    const hash = this.options.currentHash ? await this.options.currentHash() : (await this.options.capture()).hash;
    return this.classify(this.checkpoint, hash, this.observed.hash);
  }

  async hasPendingChanges(connection?: Pick<NotesDatabaseS3Options, 'endpoint' | 'bucket'>): Promise<boolean> {
    await this.initialize();
    if (connection) {
      const normalized = normalizeS3EndpointBucket(connection.endpoint, connection.bucket);
      const target = createHash('sha256').update(`${normalized.endpoint}\0${normalized.bucket}`).digest('hex');
      if (this.checkpoint?.target !== target) return true;
    }
    const hash = this.options.currentHash ? await this.options.currentHash() : (await this.options.capture()).hash;
    return hash !== this.checkpoint?.syncedHash;
  }

  private acknowledged(state: SyncCheckpoint, hash: string, etag?: string, keyId?: string): SyncCheckpoint {
    return { ...state, syncedHash: hash, applyingHash: undefined,
      publishingHash: undefined, publishingEtag: undefined, legacyImported: true,
      ...(keyId ? { remoteEtag: etag, remoteKeyId: keyId } : {}) };
  }

  private async backup(bytes: Buffer, connection: NotesDatabaseS3Options, reason: string): Promise<void> {
    await fs.mkdir(this.recoveryPath, { recursive: true, mode: 0o700 });
    const directory = await fs.lstat(this.recoveryPath);
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('The Notes recovery directory is invalid.');
    await fs.chmod(this.recoveryPath, 0o700);
    const file = path.join(this.recoveryPath, `${reason}-${Date.now()}-${randomUUID()}.sqlite3.enc`);
    await this.writePrivate(file, encryptNotesDatabase(bytes, connection.syncEncryptionKey));
    // Initial migration backups are retained separately. Bound routine whole-DB
    // backups so repeated automatic sync cannot grow without limit.
    const files = (await fs.readdir(this.recoveryPath, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && /^before-(?:pull|push)-\d+-[a-f0-9-]+\.sqlite3\.enc$/.test(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => Number(b.split('-')[2]) - Number(a.split('-')[2]));
    for (const name of files.slice(20)) {
      await fs.unlink(path.join(this.recoveryPath, name)).catch(() => undefined);
    }
  }

  private async commit(state: SyncCheckpoint): Promise<void> {
    await this.writePrivate(this.statePath, Buffer.from(JSON.stringify(state)));
    this.checkpoint = { ...state };
  }

  private async writePrivate(file: string, bytes: Buffer): Promise<void> {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      const handle = await fs.open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temporary, file);
      const directory = await fs.open(path.dirname(file), 'r').catch(() => undefined);
      if (directory) {
        try { await directory.sync().catch(() => undefined); } finally { await directory.close(); }
      }
    } finally {
      await fs.unlink(temporary).catch(() => undefined);
    }
  }
}
