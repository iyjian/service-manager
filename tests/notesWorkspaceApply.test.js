const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { NOTES_SCHEMA_VERSION, NotesStore } = require('../dist/main/notesStore');
const { NotesTreeStore } = require('../dist/main/notesTreeStore');
const { NotesTreeViewStore } = require('../dist/main/notesTreeViewStore');
const { NotesWorkspaceApplyCoordinator } = require('../dist/main/notesWorkspaceApply');

function note(id, content, updatedAt = '2026-07-28T00:00:00.000Z') {
  return {
    id,
    name: id,
    content,
    language: 'markdown',
    tags: [],
    createdAt: '2026-07-27T00:00:00.000Z',
    updatedAt,
  };
}

async function createWorkspace(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'service-manager-notes-workspace-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const notesStore = new NotesStore(path.join(directory, 'notes-v4'));
  await notesStore.load();
  const treeStore = new NotesTreeStore(path.join(directory, 'notes-tree.json'));
  await treeStore.load([]);
  const viewStore = new NotesTreeViewStore(path.join(directory, 'notes-tree-view.json'));
  await viewStore.load([]);
  const coordinator = new NotesWorkspaceApplyCoordinator(directory, notesStore, treeStore, viewStore);
  return { directory, notesStore, treeStore, viewStore, coordinator };
}

test('incremental workspace apply returns exact Note and tree deltas', async (t) => {
  const work = await createWorkspace(t);
  const initial = {
    notes: { schemaVersion: NOTES_SCHEMA_VERSION, notes: [note('a', 'A'), note('b', 'B')] },
    tombstones: [],
    tree: {
      schemaVersion: 1,
      nodes: [
        { noteId: 'a', parentId: null, order: 1024 },
        { noteId: 'b', parentId: null, order: 2048 },
      ],
    },
  };
  await work.coordinator.replace(initial);
  const next = {
    notes: {
      schemaVersion: NOTES_SCHEMA_VERSION,
      notes: [note('a', 'changed', '2026-07-29T00:00:00.000Z'), note('c', 'C')],
    },
    tombstones: [{ id: 'b', deletedAt: '2026-07-29T00:00:00.000Z' }],
    tree: {
      schemaVersion: 1,
      nodes: [
        { noteId: 'a', parentId: null, order: 1024 },
        { noteId: 'c', parentId: 'a', order: 1024 },
      ],
    },
  };

  const delta = await work.coordinator.replace(next);

  assert.deepEqual(delta.upsertedNotes.map((item) => item.id), ['a', 'c']);
  assert.deepEqual(delta.removedNoteIds, ['b']);
  assert.deepEqual(delta.upsertedTreeNodes, [{ noteId: 'c', parentId: 'a', order: 1024 }]);
  assert.deepEqual(delta.removedTreeNodeIds, ['b']);
  assert.deepEqual(work.notesStore.exportSnapshot(), next.notes);
  assert.deepEqual(work.treeStore.snapshot(), next.tree);
  await assert.rejects(fs.lstat(path.join(work.directory, '.notes-workspace-apply.json')), { code: 'ENOENT' });
});

test('startup recovery finishes the target tree after Notes were committed', async (t) => {
  const work = await createWorkspace(t);
  const initial = {
    notes: { schemaVersion: NOTES_SCHEMA_VERSION, notes: [note('parent', 'parent')] },
    tombstones: [],
    tree: { schemaVersion: 1, nodes: [{ noteId: 'parent', parentId: null, order: 1024 }] },
  };
  await work.coordinator.replace(initial);
  const target = {
    notes: {
      schemaVersion: NOTES_SCHEMA_VERSION,
      notes: [note('child', 'child'), note('parent', 'parent')],
    },
    tombstones: [],
    tree: {
      schemaVersion: 1,
      nodes: [
        { noteId: 'parent', parentId: null, order: 1024 },
        { noteId: 'child', parentId: 'parent', order: 1024 },
      ],
    },
  };
  const originalReplace = work.treeStore.replaceSnapshot.bind(work.treeStore);
  let failed = false;
  work.treeStore.replaceSnapshot = async () => {
    failed = true;
    throw new Error('simulated tree write interruption');
  };
  await assert.rejects(work.coordinator.replace(target), /simulated tree write interruption/);
  assert.equal(failed, true);
  work.treeStore.replaceSnapshot = originalReplace;
  assert.deepEqual(work.notesStore.exportSnapshot(), target.notes);

  const notesStore = new NotesStore(path.join(work.directory, 'notes-v4'));
  await notesStore.load();
  const activeIds = notesStore.list().map((item) => item.id);
  const treeStore = new NotesTreeStore(path.join(work.directory, 'notes-tree.json'));
  await treeStore.load(activeIds);
  const viewStore = new NotesTreeViewStore(path.join(work.directory, 'notes-tree-view.json'));
  await viewStore.load(activeIds);
  const recovered = new NotesWorkspaceApplyCoordinator(
    work.directory,
    notesStore,
    treeStore,
    viewStore,
  );
  await recovered.recover();

  assert.deepEqual(treeStore.snapshot(), target.tree);
  await assert.rejects(fs.lstat(path.join(work.directory, '.notes-workspace-apply.json')), { code: 'ENOENT' });
});

test('a retry observes a committed Notes manifest before rolling the workspace back', async (t) => {
  const work = await createWorkspace(t);
  const initial = {
    notes: { schemaVersion: NOTES_SCHEMA_VERSION, notes: [note('a', 'initial')] },
    tombstones: [],
    tree: { schemaVersion: 1, nodes: [{ noteId: 'a', parentId: null, order: 1024 }] },
  };
  const target = {
    notes: { schemaVersion: NOTES_SCHEMA_VERSION, notes: [note('b', 'target')] },
    tombstones: [{ id: 'a', deletedAt: '2026-07-29T00:00:00.000Z' }],
    tree: { schemaVersion: 1, nodes: [{ noteId: 'b', parentId: null, order: 1024 }] },
  };
  await work.coordinator.replace(initial);

  const originalApply = work.notesStore.applyIncrementalManifest.bind(work.notesStore);
  let interrupted = false;
  work.notesStore.applyIncrementalManifest = async (...args) => {
    await originalApply(...args);
    if (!interrupted) {
      interrupted = true;
      throw new Error('simulated post-install interruption');
    }
  };
  await assert.rejects(work.coordinator.replace(target), /simulated post-install interruption/);
  work.notesStore.applyIncrementalManifest = originalApply;

  await work.coordinator.replace(initial);

  assert.equal(interrupted, true);
  assert.deepEqual(work.notesStore.exportSnapshot(), initial.notes);
  assert.deepEqual(work.notesStore.exportTombstones(), initial.tombstones);
  assert.deepEqual(work.treeStore.snapshot(), initial.tree);
  await assert.rejects(fs.lstat(path.join(work.directory, '.notes-workspace-apply.json')), { code: 'ENOENT' });
  await assert.rejects(fs.lstat(path.join(work.directory, '.notes-v4.apply')), { code: 'ENOENT' });
});

test('a corrupt committed workspace journal fails closed', async (t) => {
  const work = await createWorkspace(t);
  await fs.writeFile(path.join(work.directory, '.notes-workspace-apply.json'), '{bad json', { mode: 0o600 });
  await assert.rejects(work.coordinator.recover(), /workspace apply journal is invalid/);
  assert.equal(await fs.readFile(path.join(work.directory, '.notes-workspace-apply.json'), 'utf8'), '{bad json');
});
