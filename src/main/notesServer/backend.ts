import { validateWorkspace } from './workspace';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { SqliteNotesStore } from '../notes/sqliteNotesStore';
import { NotesTreeViewStore } from '../notes/notesTreeViewStore';
import { NotesWorkspaceApplyCoordinator } from '../notes/notesWorkspaceApply';
import { normalizeNoteDraft, normalizeNoteSnapshot, type NoteTombstone } from '../notes/notesStore';
import type { NotesTreeStore } from '../notes/notesTreeStore';
import type { Note, NoteDraft, NotesServerStatus, NotesTreeSnapshot } from '../../shared/types';
import { NotesServerDeployment, type ServerHealth } from './deployment';

export interface RemoteWorkspace { instanceId: string; revision: number; notes: Note[]; tombstones: NoteTombstone[]; tree: NotesTreeSnapshot; }
export interface NotesDataBackend { run<T>(operation: () => Promise<T>, mutation?: boolean): Promise<T>; }
export class LocalNotesBackend implements NotesDataBackend {
  run<T>(operation: () => Promise<T>): Promise<T> { return operation(); }
}
/** A disposable read cache and transaction staging area, never the server's authority or a sync source. */
export class RemoteNotesBackend implements NotesDataBackend {
  store!: SqliteNotesStore;
  tree!: NotesTreeStore;
  view!: NotesTreeViewStore;
  coordinator!: NotesWorkspaceApplyCoordinator;
  private queue: Promise<unknown> = Promise.resolve();
  private current?: ServerHealth;
  private connected = false;
  private drafts = new Map<string, { id: string; expectedNote: Note; draft: NoteDraft }>();
  private directory = '';
  private message = 'Disconnected';
  constructor(readonly deployment: NotesServerDeployment, private readonly root: string, private readonly changed: (state: NotesServerStatus) => void) {}
  get enabled(): boolean { return this.deployment.settings.enabled; }
  status(): NotesServerStatus {
    return { enabled: this.enabled, connected: this.connected, version: this.current?.version, instanceId: this.current?.instanceId ?? this.deployment.settings.instanceId,
      revision: this.current?.revision, pendingDrafts: this.drafts.size, message: this.enabled ? this.message : 'Local Notes' };
  }
  private publish(): void { this.changed(this.status()); }
  async initialize(): Promise<void> {
    if (!this.deployment.settings.identity) return;
    const directory = path.join(this.root, 'notes-server-cache', this.deployment.settings.identity);
    if (this.directory === directory) return;
    if (this.store) await this.store.close();
    this.directory = directory; this.current = undefined; this.connected = false; this.drafts.clear();
    this.store = new SqliteNotesStore(directory); await this.store.load();
    this.tree = this.store.createTreeStore(); await this.tree.load(this.store.list().map(n => n.id));
    this.view = new NotesTreeViewStore(path.join(directory, 'view.json')); await this.view.load(this.store.list().map(n => n.id));
    this.coordinator = new NotesWorkspaceApplyCoordinator(directory, this.store, this.tree, this.view); await this.coordinator.recover();
    try {
      const raw = JSON.parse(await fs.readFile(path.join(directory, 'drafts.json'), 'utf8'));
      if (raw.instanceId !== this.deployment.settings.instanceId && raw.drafts?.length) throw new Error('Draft instance does not match.');
      for (const value of raw.drafts) { const expectedNote = normalizeNoteSnapshot(value.expectedNote); const draft = normalizeNoteDraft(value.draft); this.drafts.set(expectedNote.id, { id: expectedNote.id, expectedNote, draft }); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Saved Notes drafts could not be recovered.'); }
  }
  snapshot(): RemoteWorkspace {
    return { instanceId: this.current?.instanceId ?? this.deployment.settings.instanceId ?? '', revision: this.current?.revision ?? 0,
      notes: this.store.list(), tombstones: this.store.exportTombstones(), tree: this.tree.snapshot() };
  }
  private async apply(state: RemoteWorkspace): Promise<void> {
    if (!state || typeof state.instanceId !== 'string' || !Number.isSafeInteger(state.revision)
      || !Array.isArray(state.notes) || !Array.isArray(state.tombstones) || state.tree?.schemaVersion !== 1) throw new Error('Invalid server workspace.');
    if (this.deployment.settings.instanceId && state.instanceId !== this.deployment.settings.instanceId) throw new Error('The server database identity changed. Reconnect explicitly before editing.');
    const validated = await validateWorkspace(state);
    await this.coordinator.replace({ notes: { schemaVersion: 1, notes: validated.notes }, tombstones: validated.tombstones, tree: validated.tree });
  }
  private async refresh(): Promise<void> {
    const health = await this.deployment.health();
    if (this.deployment.settings.instanceId && health.instanceId !== this.deployment.settings.instanceId) throw new Error('The server database identity changed.');
    // Resolve a possibly committed request before starting another operation.
    let pending: any;
    try { pending = JSON.parse(await fs.readFile(path.join(this.directory, 'pending.json'), 'utf8')); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    if (pending) {
      try { await this.deployment.api('/v1/transactions', pending); }
      catch (error) { if ((error as { status?: number }).status !== 409) throw error; }
      await fs.unlink(path.join(this.directory, 'pending.json')); this.current = undefined;
    }
    if (!this.current || health.revision !== this.current.revision || pending) {
      const snapshot = await this.deployment.api<RemoteWorkspace>('/v1/workspace'); await this.apply(snapshot);
      this.current = { ...health, revision: snapshot.revision };
    } else this.current = health;
    this.connected = true; this.message = this.drafts.size ? 'Connected · local drafts pending' : 'Connected'; this.publish();
  }
  run<T>(operation: () => Promise<T>, mutation = false, refresh = false): Promise<T> {
    const work = this.queue.then(async () => {
      await this.initialize();
      try { if (mutation || refresh || !this.current) await this.refresh(); }
      catch (error) { this.connected = false; this.message = 'Disconnected · local drafts are preserved'; this.publish(); if (mutation) throw error; }
      // Reads and device-local expansion state cannot change the server workspace.
      if (!mutation) return operation();
      const before = this.snapshot();
      try {
        const result = await operation(); const after = this.snapshot();
        if (!isDeepStrictEqual(before, after)) {
          if (!this.connected) throw new Error('Notes Server is disconnected.');
          const byId = new Map(before.notes.map(n => [n.id, n])); const ids = new Set(after.notes.map(n => n.id));
          const payload = { requestId: randomUUID(), expectedRevision: before.revision,
            upserts: after.notes.filter(n => !isDeepStrictEqual(byId.get(n.id), n)), deletedIds: before.notes.filter(n => !ids.has(n.id)).map(n => n.id),
            ...(isDeepStrictEqual(before.tombstones, after.tombstones) ? {} : { tombstones: after.tombstones }),
            ...(isDeepStrictEqual(before.tree, after.tree) ? {} : { tree: after.tree }) };
          await this.atomic('pending.json', payload);
          const committed = await this.deployment.api<{ revision: number; instanceId: string }>('/v1/transactions', payload);
          if (committed.instanceId !== before.instanceId || !Number.isSafeInteger(committed.revision)) throw new Error('Invalid commit response.');
          this.current = { ...this.current!, revision: committed.revision }; await fs.unlink(path.join(this.directory, 'pending.json'));
        }
        this.publish(); return result;
      } catch (error) {
        await this.apply(before); this.current = undefined;
        this.message = (error as { status?: number }).status === 409 ? 'Conflict · local draft preserved' : 'Disconnected · local draft preserved';
        this.connected = false; this.publish(); throw error;
      }
    });
    this.queue = work.catch(() => undefined); return work;
  }
  async preserve(id: string, expected: Note, input: NoteDraft): Promise<boolean> {
    if (!this.enabled) return false;
    const expectedNote = normalizeNoteSnapshot(expected); if (expectedNote.id !== id) throw new Error('Invalid draft base.');
    await this.initialize(); this.drafts.set(id, { id, expectedNote, draft: normalizeNoteDraft(input) });
    await this.saveDrafts(); this.publish(); return true;
  }
  async clearDraft(id: string): Promise<void> { this.drafts.delete(id); await this.saveDrafts(); this.publish(); }
  draft(id: string): { expectedNote: Note; draft: NoteDraft } | undefined { return this.drafts.get(id); }
  async reconnectDrafts(): Promise<void> {
    await this.run(async () => {
      for (const [id, saved] of this.drafts) {
        const current = this.store.get(id); if (!current) continue;
        if (isDeepStrictEqual(normalizeNoteDraft(current), saved.draft)) continue;
        await this.store.compareAndUpdate(id, saved.expectedNote, saved.draft);
      }
    }, true);
    // Missing/deleted notes remain recoverable; never discard their drafts.
    for (const [id, saved] of this.drafts) if (this.store.get(id) && isDeepStrictEqual(normalizeNoteDraft(this.store.get(id)!), saved.draft)) this.drafts.delete(id);
    await this.saveDrafts(); this.publish();
  }
  async recoverDrafts(): Promise<void> {
    await this.run(async () => {
      for (const [id, saved] of this.drafts) {
        const current = this.store.get(id);
        if (current && isDeepStrictEqual(normalizeNoteDraft(current), saved.draft)) continue;
        if (current && isDeepStrictEqual(current, saved.expectedNote)) await this.store.compareAndUpdate(id, saved.expectedNote, saved.draft);
        else {
          const conflictDraft = { ...saved.draft, name: `Conflict - ${saved.draft.name}`.slice(0, 200) };
          if (this.store.list().some(note => isDeepStrictEqual(normalizeNoteDraft(note), conflictDraft))) continue;
          const note = await this.store.create();
          await this.store.update(note.id, conflictDraft);
          await this.tree.insert(note.id, null);
        }
      }
    }, true);
    this.drafts.clear(); await this.saveDrafts(); this.publish();
  }
  assertNoDrafts(): void { if (this.drafts.size) throw new Error('Reconnect and resolve the saved Notes drafts before switching data sources.'); }
  private saveDrafts(): Promise<void> { return this.atomic('drafts.json', { instanceId: this.deployment.settings.instanceId, drafts: [...this.drafts.values()] }); }
  private async atomic(name: string, value: unknown): Promise<void> {
    const file = path.join(this.directory, name); const temp = `${file}.${randomUUID()}.tmp`;
    const handle = await fs.open(temp, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temp, file);
  }
  async idle(): Promise<void> { await this.queue; }
  async close(): Promise<void> { this.deployment.cancel(); await this.queue; if (this.store) await this.store.close(); }
}
