const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { SqliteNotesStore } = require('../dist/main/notes/sqliteNotesStore');
const { NotesStore } = require('../dist/main/notes/notesStore');
const { NotesTreeStore } = require('../dist/main/notes/notesTreeStore');
const { NotesTreeViewStore } = require('../dist/main/notes/notesTreeViewStore');
const { NotesWorkspaceApplyCoordinator } = require('../dist/main/notes/notesWorkspaceApply');
const { NotesDatabaseSync, hashNotesDatabaseState } = require('../dist/main/s3/notesDatabaseSync');
const { encryptNotesDatabase, decryptNotesDatabase } = require('../dist/main/s3/notesDatabaseS3');

const KEY = Buffer.alloc(32, 0x61).toString('base64url');
const TIME = '2026-09-12T00:00:00.000Z';
const note = (id, content = id) => ({
  id, name: `Note ${id}`, content, language: 'text', tags: ['integration'], createdAt: TIME, updatedAt: TIME,
});
const initial = () => ({
  schemaVersion: 2,
  notes: [note('a'), note('b'), note('z')],
  tombstones: [],
  tree: { schemaVersion: 1, nodes: [
    { noteId: 'z', parentId: null, order: 10 },
    { noteId: 'a', parentId: 'z', order: 10 },
    { noteId: 'b', parentId: null, order: 30 },
  ] },
});
const imported = () => ({
  schemaVersion: 2,
  notes: [note('a', 'remote changed a'), note('c', 'remote new c'), note('z')],
  tombstones: [{ id: 'b', deletedAt: TIME }],
  tree: { schemaVersion: 1, nodes: [
    { noteId: 'z', parentId: null, order: 5 },
    { noteId: 'c', parentId: 'z', order: 10 },
    { noteId: 'a', parentId: 'z', order: 20 },
  ] },
});
const input = (state) => ({ notes: { schemaVersion: 1, notes: state.notes }, tombstones: state.tombstones, tree: state.tree });
const shared = (decoded) => ({ schemaVersion: 2, notes: decoded.notes.notes, tombstones: decoded.tombstones, tree: decoded.tree });

class FakeS3 {
  remote;
  revision = 0;
  puts = 0;

  seed(bytes) {
    this.remote = { bytes: encryptNotesDatabase(bytes, KEY), etag: `"r${++this.revision}"` };
  }

  connection() {
    return {
      endpoint: 'http://localhost:9000', bucket: 'notes', region: 'us-east-1',
      accessKeyId: 'test-access', secretAccessKey: 'test-secret', syncEncryptionKey: KEY,
      fetchImpl: async (_url, init) => {
        if (init.method === 'GET') {
          return this.remote
            ? new Response(Buffer.from(this.remote.bytes), { headers: { etag: this.remote.etag } })
            : new Response(null, { status: 404 });
        }
        assert.equal(init.method, 'PUT');
        if (this.remote ? init.headers['if-match'] !== this.remote.etag : init.headers['if-none-match'] !== '*') {
          return new Response(null, { status: 412 });
        }
        this.puts += 1;
        this.remote = { bytes: Buffer.from(init.body), etag: `"r${++this.revision}"` };
        return new Response(null, { headers: { etag: this.remote.etag } });
      },
    };
  }

  bytes() { return decryptNotesDatabase(this.remote.bytes, KEY).bytes; }
}

async function device(t, state = initial()) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'notes-database-integration-'));
  let store;
  let tree;
  let view;
  let coordinator;
  let queue = Promise.resolve();
  const run = (operation) => {
    const result = queue.then(operation, operation);
    queue = result.then(() => undefined, () => undefined);
    return result;
  };
  const current = () => ({ schemaVersion: 2, notes: store.list(), tombstones: store.exportTombstones(), tree: tree.snapshot() });
  const open = async () => {
    store = new SqliteNotesStore(directory);
    await store.load();
    tree = store.createTreeStore();
    await tree.load(store.list().map((item) => item.id));
    view = new NotesTreeViewStore(path.join(directory, 'notes-tree-view.json'));
    await view.load(store.list().map((item) => item.id));
    coordinator = new NotesWorkspaceApplyCoordinator(directory, store, tree, view);
    await coordinator.recover();
  };
  t.after(async () => {
    await queue;
    await store?.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  // Exercise the same legacy files that main migrates before opening the window.
  const legacy = new NotesStore(path.join(directory, 'notes-v4'));
  await legacy.load();
  await legacy.replaceSnapshot(input(state).notes, state.tombstones);
  const legacyTree = new NotesTreeStore(path.join(directory, 'notes-tree.json'));
  await legacyTree.replaceSnapshot(state.tree, state.notes.map((item) => item.id));
  await open();
  const local = {
    directory, current, engine: undefined, beforeApply: undefined, afterImport: undefined,
    capture: () => run(async () => {
      await store.flush();
      await tree.flush();
      const bytes = await store.snapshotBytes();
      return { bytes, hash: hashNotesDatabaseState(current()) };
    }),
    replace: (next) => run(() => coordinator.replace(input(next))),
    expand: (ids) => run(() => view.save(ids, store.list().map((item) => item.id))),
    view: () => view.snapshot(),
    checkpoint: async () => JSON.parse(await fs.readFile(path.join(directory, 'notes-database-sync.json'), 'utf8')),
    async restart() {
      await queue;
      await store.close();
      await open();
      local.engine = new NotesDatabaseSync(adapter);
      await local.engine.initialize();
    },
    sync: (cloud, legacySource = async () => undefined) => local.engine.sync(cloud.connection(), legacySource),
  };
  const apply = async (next, expectedHash) => {
    await local.beforeApply?.();
    return run(async () => {
      if (hashNotesDatabaseState(current()) !== expectedHash) return false;
      await coordinator.replace(input(next));
      return true;
    });
  };
  const adapter = {
    userDataPath: directory,
    capture: local.capture,
    inspect: async (bytes) => hashNotesDatabaseState(shared(await SqliteNotesStore.decodeSnapshot(bytes, directory))),
    apply: async (bytes, expectedHash) => apply(shared(await SqliteNotesStore.decodeSnapshot(bytes, directory)), expectedHash),
    importLegacy: async (next, expectedHash) => {
      const applied = await apply(next, expectedHash);
      if (applied) await local.afterImport?.();
      return applied;
    },
  };
  local.engine = new NotesDatabaseSync(adapter);
  await local.engine.initialize();
  return local;
}

async function assertCapturedState(local, expected) {
  const capture = await local.capture();
  const decoded = shared(await SqliteNotesStore.decodeSnapshot(capture.bytes, local.directory));
  assert.deepEqual(local.current(), expected);
  assert.deepEqual(decoded, expected);
  assert.equal(capture.hash, hashNotesDatabaseState(decoded));
  assert.equal(capture.hash, hashNotesDatabaseState(expected));
  assert.equal(capture.bytes[18], 1, 'snapshot can be read without a separate WAL');
  return capture;
}

test('real SQLite legacy import preserves deletion, tombstones and sibling order without an upload echo', async (t) => {
  const local = await device(t);
  const cloud = new FakeS3();
  const next = imported();
  await local.expand(['z']);
  assert.equal(await local.sync(cloud, async () => ({ base: initial(), cloud: next })), 'pushed');
  const capture = await assertCapturedState(local, next);
  assert.equal((await local.checkpoint()).syncedHash, capture.hash);
  assert.deepEqual(shared(await SqliteNotesStore.decodeSnapshot(cloud.bytes(), local.directory)), next);
  assert.deepEqual(local.view().expandedNoteIds, ['z']);
  const writes = cloud.puts;
  await local.expand([]);
  await local.restart();
  assert.equal(await local.sync(cloud, async () => assert.fail('legacy already imported')), 'up-to-date');
  assert.equal(cloud.puts, writes);
  await assertCapturedState(local, next);
});

test('real SQLite remote pull and local delete/reorder produce identical hashes after restart', async (t) => {
  const publisher = await device(t, imported());
  const receiver = await device(t);
  const cloud = new FakeS3();
  cloud.seed((await publisher.capture()).bytes);
  assert.equal(await receiver.sync(cloud), 'pulled');
  await assertCapturedState(receiver, imported());
  assert.equal(cloud.puts, 0);
  await receiver.restart();
  assert.equal(await receiver.sync(cloud), 'up-to-date');
  const changed = imported();
  changed.notes = changed.notes.filter((item) => item.id !== 'a');
  changed.tombstones.unshift({ id: 'a', deletedAt: TIME });
  changed.tree.nodes = [
    { noteId: 'c', parentId: null, order: 1 },
    { noteId: 'z', parentId: null, order: 2 },
  ];
  await receiver.replace(changed);
  assert.equal(await receiver.sync(cloud), 'pushed');
  await assertCapturedState(receiver, changed);
  assert.equal((await receiver.checkpoint()).syncedHash, hashNotesDatabaseState(changed));
  assert.deepEqual(shared(await SqliteNotesStore.decodeSnapshot(cloud.bytes(), receiver.directory)), changed);
  const writes = cloud.puts;
  await receiver.restart();
  assert.equal(await receiver.sync(cloud), 'up-to-date');
  assert.equal(cloud.puts, writes);
});

test('real SQLite late local changes fence a remote pull inside the mutation queue', async (t) => {
  const publisher = await device(t, imported());
  const receiver = await device(t);
  const cloud = new FakeS3();
  cloud.seed((await publisher.capture()).bytes);
  const typed = initial();
  typed.notes[0].content = 'typed after remote GET';
  receiver.beforeApply = async () => {
    receiver.beforeApply = undefined;
    await receiver.replace(typed);
  };
  assert.equal(await receiver.sync(cloud), 'diverged');
  await assertCapturedState(receiver, typed);
  assert.deepEqual(shared(await SqliteNotesStore.decodeSnapshot(cloud.bytes(), receiver.directory)), imported());
  assert.equal(await receiver.sync(cloud), 'diverged');
});

test('restart after legacy import interruption must not publish the imported workspace over a newer remote', async (t) => {
  const local = await device(t);
  const cloud = new FakeS3();
  const legacyCloud = imported();
  local.afterImport = async () => { throw new Error('simulated termination after legacy apply'); };
  await assert.rejects(local.sync(cloud, async () => ({ base: initial(), cloud: legacyCloud })), /simulated termination/);
  await assertCapturedState(local, legacyCloud);
  assert.equal(cloud.puts, 0, 'the interrupted client has never published');
  local.afterImport = undefined;
  const newest = imported();
  newest.notes[0].content = 'newer publisher while stopped';
  const publisher = await device(t, newest);
  cloud.seed((await publisher.capture()).bytes);
  await local.restart();
  const action = await local.sync(cloud);
  assert.deepEqual(shared(await SqliteNotesStore.decodeSnapshot(cloud.bytes(), local.directory)), newest,
    'an imported remote snapshot is not an unsynced local edit');
  assert.equal(action, 'pulled');
  assert.equal(cloud.puts, 0);
  await assertCapturedState(local, newest);
});
