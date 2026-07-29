import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type {
  Note,
  NoteSummary,
  NotesTreeNode,
  NotesTreeSnapshot,
  NotesWorkspaceDelta,
} from '../shared/types';
import type { NoteTombstone, NotesSnapshot } from './notesStore';
import { NotesStore } from './notesStore';
import { NotesTreeStore } from './notesTreeStore';
import { NotesTreeViewStore } from './notesTreeViewStore';

const JOURNAL_SCHEMA_VERSION = 1 as const;
const JOURNAL_FILE_NAME = '.notes-workspace-apply.json';
const MAX_JOURNAL_BYTES = 8 * 1024 * 1024;

interface NotesWorkspaceApplyJournal {
  schemaVersion: typeof JOURNAL_SCHEMA_VERSION;
  transactionId: string;
  targetNotesSha256: string;
  tree: NotesTreeSnapshot;
}

export interface NotesWorkspaceApplyInput {
  notes: NotesSnapshot;
  tombstones: NoteTombstone[];
  tree: NotesTreeSnapshot;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cloneNote(note: Note): Note {
  return { ...note, tags: [...note.tags] };
}

function noteSummary(note: Note): NoteSummary {
  const { content: _content, ...summary } = note;
  return { ...summary, tags: [...summary.tags] };
}

function cloneTreeNode(node: NotesTreeNode): NotesTreeNode {
  return { ...node };
}

function notesStateSha256(notes: NotesSnapshot, tombstones: readonly NoteTombstone[]): string {
  const canonical = {
    notes: {
      schemaVersion: notes.schemaVersion,
      notes: notes.notes.map(cloneNote).sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
    },
    tombstones: [...tombstones]
      .map((tombstone) => ({ ...tombstone }))
      .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
  };
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}

function createDelta(
  previousNotes: NotesSnapshot,
  previousTree: NotesTreeSnapshot,
  nextNotes: NotesSnapshot,
  nextTree: NotesTreeSnapshot,
  expandedNoteIds: readonly string[],
): NotesWorkspaceDelta {
  const previousNoteMap = new Map(previousNotes.notes.map((note) => [note.id, note]));
  const nextNoteMap = new Map(nextNotes.notes.map((note) => [note.id, note]));
  const previousTreeMap = new Map(previousTree.nodes.map((node) => [node.noteId, node]));
  const nextTreeMap = new Map(nextTree.nodes.map((node) => [node.noteId, node]));
  return {
    upsertedNotes: nextNotes.notes
      .filter((note) => !isDeepStrictEqual(previousNoteMap.get(note.id), note))
      .map(noteSummary),
    removedNoteIds: previousNotes.notes
      .filter((note) => !nextNoteMap.has(note.id))
      .map((note) => note.id)
      .sort(),
    upsertedTreeNodes: nextTree.nodes
      .filter((node) => !isDeepStrictEqual(previousTreeMap.get(node.noteId), node))
      .map(cloneTreeNode),
    removedTreeNodeIds: previousTree.nodes
      .filter((node) => !nextTreeMap.has(node.noteId))
      .map((node) => node.noteId)
      .sort(),
    expandedNoteIds: [...expandedNoteIds].sort(),
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

export class NotesWorkspaceApplyCoordinator {
  private readonly journalPath: string;
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(
    userDataPath: string,
    private readonly notesStore: NotesStore,
    private readonly treeStore: NotesTreeStore,
    private readonly treeViewStore: NotesTreeViewStore,
  ) {
    this.journalPath = path.join(userDataPath, JOURNAL_FILE_NAME);
  }

  recover(): Promise<void> {
    return this.enqueue(async () => this.recoverUnlocked());
  }

  replace(input: NotesWorkspaceApplyInput): Promise<NotesWorkspaceDelta> {
    return this.enqueue(async () => {
      await this.recoverUnlocked();
      const previousNotes = this.notesStore.exportSnapshot();
      const previousTombstones = this.notesStore.exportTombstones();
      const previousTree = this.treeStore.snapshot();
      if (isDeepStrictEqual(previousNotes, input.notes)
        && isDeepStrictEqual(previousTombstones, input.tombstones)
        && isDeepStrictEqual(previousTree, input.tree)) {
        return createDelta(
          previousNotes,
          previousTree,
          previousNotes,
          previousTree,
          this.treeViewStore.snapshot().expandedNoteIds,
        );
      }

      const journal: NotesWorkspaceApplyJournal = {
        schemaVersion: JOURNAL_SCHEMA_VERSION,
        transactionId: randomUUID(),
        targetNotesSha256: notesStateSha256(input.notes, input.tombstones),
        tree: {
          schemaVersion: 1,
          nodes: input.tree.nodes.map(cloneTreeNode),
        },
      };
      await this.persistJournal(journal);
      await this.notesStore.replaceSnapshot(input.notes, input.tombstones);
      const nextNotes = this.notesStore.exportSnapshot();
      const nextTombstones = this.notesStore.exportTombstones();
      if (notesStateSha256(nextNotes, nextTombstones) !== journal.targetNotesSha256) {
        throw new Error('The incremental Notes apply did not reach its target state.');
      }
      const activeIds = nextNotes.notes.map((note) => note.id);
      const nextTree = await this.treeStore.replaceSnapshot(journal.tree, activeIds);
      const nextView = await this.treeViewStore.replaceActiveIds(activeIds);
      await this.clearJournal();
      return createDelta(previousNotes, previousTree, nextNotes, nextTree, nextView.expandedNoteIds);
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async recoverUnlocked(): Promise<void> {
    // A failed apply can leave its durable Notes manifest committed while the
    // in-memory store still describes the previous state. Finish that manifest
    // before deciding whether the workspace journal reached its target.
    await this.notesStore.recoverPendingApply();
    const journal = await this.readJournal();
    if (!journal) return;
    const notes = this.notesStore.exportSnapshot();
    const tombstones = this.notesStore.exportTombstones();
    if (notesStateSha256(notes, tombstones) !== journal.targetNotesSha256) {
      // The workspace marker is written before the Notes store starts. If the
      // Notes store has no committed/recoverable delta, the old complete
      // workspace remains authoritative and the cloud reconcile will retry.
      await this.clearJournal();
      return;
    }
    const activeIds = notes.notes.map((note) => note.id);
    await this.treeStore.replaceSnapshot(journal.tree, activeIds);
    await this.treeViewStore.replaceActiveIds(activeIds);
    await this.clearJournal();
  }

  private parseJournal(value: unknown): NotesWorkspaceApplyJournal {
    if (!isRecord(value)
      || value.schemaVersion !== JOURNAL_SCHEMA_VERSION
      || typeof value.transactionId !== 'string'
      || value.transactionId.length === 0
      || value.transactionId.length > 128
      || typeof value.targetNotesSha256 !== 'string'
      || !/^[a-f0-9]{64}$/.test(value.targetNotesSha256)
      || !isRecord(value.tree)
      || value.tree.schemaVersion !== 1
      || !Array.isArray(value.tree.nodes)) {
      throw new Error('The Notes workspace apply journal is invalid.');
    }
    return {
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      transactionId: value.transactionId,
      targetNotesSha256: value.targetNotesSha256,
      tree: value.tree as unknown as NotesTreeSnapshot,
    };
  }

  private async readJournal(): Promise<NotesWorkspaceApplyJournal | undefined> {
    let metadata;
    try {
      metadata = await fs.lstat(this.journalPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > MAX_JOURNAL_BYTES) {
      throw new Error('The Notes workspace apply journal is invalid.');
    }
    let handle: FileHandle | undefined;
    try {
      handle = await fs.open(this.journalPath, 'r');
      const opened = await handle.stat();
      if (!opened.isFile()
        || opened.size > MAX_JOURNAL_BYTES
        || (metadata.ino !== 0 && opened.ino !== 0 && metadata.ino !== opened.ino)
        || metadata.dev !== opened.dev) {
        throw new Error('The Notes workspace apply journal is invalid.');
      }
      const contents = await handle.readFile();
      if (contents.byteLength > MAX_JOURNAL_BYTES) {
        throw new Error('The Notes workspace apply journal is invalid.');
      }
      return this.parseJournal(JSON.parse(contents.toString('utf8')) as unknown);
    } catch (error) {
      if (error instanceof Error && error.message === 'The Notes workspace apply journal is invalid.') throw error;
      throw new Error('The Notes workspace apply journal is invalid.');
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async persistJournal(journal: NotesWorkspaceApplyJournal): Promise<void> {
    const directory = path.dirname(this.journalPath);
    const temporaryPath = `${this.journalPath}.${process.pid}.${randomUUID()}.tmp`;
    let handle: FileHandle | undefined;
    try {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const directoryMetadata = await fs.lstat(directory);
      if (directoryMetadata.isSymbolicLink() || !directoryMetadata.isDirectory()) {
        throw new Error('The Notes workspace apply journal directory is invalid.');
      }
      handle = await fs.open(temporaryPath, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(journal), 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.rename(temporaryPath, this.journalPath);
      await fs.chmod(this.journalPath, 0o600).catch(() => undefined);
      await syncDirectory(directory);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async clearJournal(): Promise<void> {
    await fs.rm(this.journalPath, { force: true });
    await syncDirectory(path.dirname(this.journalPath));
  }
}
