const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const Database = require('better-sqlite3');
const { SqliteNotesStore, NOTES_DATABASE_MAX_BYTES } = require('../dist/main/notes/sqliteNotesStore');
const { NotesStore, NOTE_LIMITS } = require('../dist/main/notes/notesStore');
const { NotesTreeStore } = require('../dist/main/notes/notesTreeStore');
const { NotesTreeViewStore } = require('../dist/main/notes/notesTreeViewStore');
const { NotesWorkspaceApplyCoordinator } = require('../dist/main/notes/notesWorkspaceApply');
const { EMPTY_RICH_TEXT_CONTENT } = require('../dist/shared/noteRichText');

const timestamp = '2026-09-12T00:00:00.000Z';
const draft = (overrides = {}) => ({ name: 'Example', content: 'body', language: 'text', tags: ['work'], ...overrides });
const note = (id, overrides = {}) => ({ id, ...draft(), createdAt: timestamp, updatedAt: timestamp, ...overrides });
const snapshot = (notes) => ({ schemaVersion: 1, notes });
const emptyTree = () => ({ schemaVersion: 1, nodes: [] });

async function workspace(t, load = true) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'service-manager-sqlite-notes-'));
  const store = new SqliteNotesStore(directory);
  t.after(async () => {
    await store.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  if (load) await store.load();
  return { directory, store };
}

async function legacyWorkspace(directory) {
  const notes = new NotesStore(path.join(directory, 'notes-v4'));
  await notes.load();
  const tree = new NotesTreeStore(path.join(directory, 'notes-tree.json'));
  const view = new NotesTreeViewStore(path.join(directory, 'notes-tree-view.json'));
  const ids = notes.list().map((item) => item.id);
  await tree.load(ids);
  await view.load(ids);
  return { notes, tree, view, coordinator: new NotesWorkspaceApplyCoordinator(directory, notes, tree, view) };
}

async function mutatedSnapshot(directory, bytes, mutation) {
  const temporaryDirectory = await fs.mkdtemp(path.join(directory, 'test-database-'));
  const file = path.join(temporaryDirectory, 'notes.sqlite3');
  let db;
  try {
    await fs.writeFile(file, bytes);
    db = new Database(file);
    mutation(db);
    db.close();
    db = undefined;
    return await fs.readFile(file);
  } finally {
    db?.close();
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

test('SQLite Notes migrate notes, tombstones and hierarchy, retaining legacy files and local preferences', async (t) => {
  const { directory, store } = await workspace(t, false);
  const legacy = await legacyWorkspace(directory);
  const state = {
    notes: snapshot([note('child'), note('parent')]),
    tombstones: [{ id: 'deleted', deletedAt: timestamp }],
    tree: { schemaVersion: 1, nodes: [
      { noteId: 'parent', parentId: null, order: 1024 },
      { noteId: 'child', parentId: 'parent', order: 1024 },
    ] },
  };
  await legacy.coordinator.replace(state);
  const preferences = { schemaVersion: 1, expandedNoteIds: ['parent'] };
  await fs.writeFile(path.join(directory, 'notes-tree-view.json'), JSON.stringify(preferences));
  await fs.writeFile(path.join(directory, 'notes-share-settings.json'), 'local-share-secret-marker');
  const legacyNames = await fs.readdir(path.join(directory, 'notes-v4'));
  const before = await Promise.all(legacyNames.map((name) => fs.readFile(path.join(directory, 'notes-v4', name))));

  await store.load();
  assert.ok(store instanceof NotesStore);
  assert.equal(store.databasePath, path.join(directory, 'notes.sqlite3'));
  assert.deepEqual(store.exportSnapshot(), state.notes);
  assert.deepEqual(store.exportTombstones(), state.tombstones);
  const tree = store.createTreeStore();
  assert.equal(tree, store.createTreeStore());
  await tree.load(['child', 'parent']);
  assert.deepEqual(tree.exportSnapshot(), state.tree);
  assert.deepEqual(await fs.readdir(path.join(directory, 'notes-v4')), legacyNames);
  assert.deepEqual(await Promise.all(legacyNames.map((name) => fs.readFile(path.join(directory, 'notes-v4', name)))), before);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, 'notes-tree-view.json'), 'utf8')), preferences);

  const bytes = await store.snapshotBytes();
  assert.deepEqual(await SqliteNotesStore.decodeSnapshot(bytes, directory), state);
  assert.equal(bytes.includes(Buffer.from('expandedNoteIds')), false);
  assert.equal(bytes.includes(Buffer.from('local-share-secret-marker')), false);
  assert.equal(bytes.includes(Buffer.from('notes-share-settings')), false);
  const schema = store.database.prepare('SELECT name FROM sqlite_schema ORDER BY name').all();
  assert.deepEqual(schema.map((row) => row.name), ['meta', 'notes', 'tombstones', 'tree']);
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
    for (const suffix of ['', '-wal', '-shm']) {
      assert.equal((await fs.stat(`${store.databasePath}${suffix}`)).mode & 0o777, 0o600);
    }
  }
});

test('migration replays a committed legacy apply and workspace journal before publishing SQLite', async (t) => {
  const { directory, store } = await workspace(t, false);
  const legacy = await legacyWorkspace(directory);
  const target = {
    notes: snapshot([note('child'), note('parent')]), tombstones: [],
    tree: { schemaVersion: 1, nodes: [
      { noteId: 'parent', parentId: null, order: 1024 },
      { noteId: 'child', parentId: 'parent', order: 1024 },
    ] },
  };
  // Leave the durable manifest and workspace marker while memory is stale.
  const original = legacy.notes.applyIncrementalManifest;
  legacy.notes.applyIncrementalManifest = async () => { throw new Error('interrupted legacy install'); };
  await assert.rejects(legacy.coordinator.replace(target), /interrupted legacy install/);
  legacy.notes.applyIncrementalManifest = original;
  await fs.stat(path.join(directory, '.notes-v4.apply', 'manifest.json'));
  await store.load();
  assert.deepEqual(store.exportSnapshot(), target.notes);
  const tree = store.createTreeStore();
  await tree.load(['child', 'parent']);
  assert.deepEqual(tree.snapshot(), target.tree);
  await assert.rejects(fs.stat(path.join(directory, '.notes-workspace-apply.json')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(directory, '.notes-v4.apply')), { code: 'ENOENT' });
});

test('migration recovers a legacy directory swap and ignores abandoned SQLite staging', async (t) => {
  const { directory, store } = await workspace(t, false);
  const legacy = await legacyWorkspace(directory);
  await legacy.notes.replaceSnapshot(snapshot([note('kept')]));
  await fs.rename(path.join(directory, 'notes-v4'), path.join(directory, '.notes-v4.previous'));
  const abandoned = await fs.mkdtemp(path.join(directory, '.notes-migrate-'));
  await fs.writeFile(path.join(abandoned, 'notes.sqlite3'), 'incomplete');
  await store.load();
  assert.deepEqual(store.exportSnapshot(), snapshot([note('kept')]));
  assert.equal(await fs.readFile(path.join(abandoned, 'notes.sqlite3'), 'utf8'), 'incomplete');
  await fs.stat(path.join(directory, 'notes-v4'));
});

test('migration flushes a writable database before publication and preserves legacy data on flush failure', async (t) => {
  const { directory, store } = await workspace(t, false);
  const legacy = await legacyWorkspace(directory);
  const expected = snapshot([note('legacy')]);
  await legacy.notes.replaceSnapshot(expected);
  const open = fs.open;
  let failFlush = true;
  let flushes = 0;
  fs.open = async (file, flags, ...args) => {
    const handle = await open(file, flags, ...args);
    if (path.basename(file) === 'notes.sqlite3' && path.basename(path.dirname(file)).startsWith('.notes-migrate-')) {
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        // Match Windows FlushFileBuffers: read-only descriptors cannot sync.
        if (flags === 'r') throw Object.assign(new Error('read-only fsync'), { code: 'EPERM' });
        flushes++;
        if (failFlush) throw Object.assign(new Error('simulated disk flush failure'), { code: 'EIO' });
        return sync();
      };
    }
    return handle;
  };
  try {
    await assert.rejects(store.load(), { code: 'EIO' });
    await assert.rejects(fs.stat(store.databasePath), { code: 'ENOENT' });
    assert.equal((await fs.readdir(directory)).some((entry) => entry.startsWith('.notes-migrate-')), false);
    await legacy.notes.load();
    assert.deepEqual(legacy.notes.exportSnapshot(), expected);
    failFlush = false;
    await store.load();
    assert.equal(flushes, 2);
    assert.deepEqual(store.exportSnapshot(), expected);
    await store.close();
    await store.load();
    assert.deepEqual(store.exportSnapshot(), expected);
  } finally {
    fs.open = open;
  }
});

test('failed migration publication is retryable and an existing database is authoritative', async (t) => {
  const { directory, store } = await workspace(t, false);
  const legacy = await legacyWorkspace(directory);
  await legacy.notes.replaceSnapshot(snapshot([note('legacy')]));
  const rename = fs.rename;
  fs.rename = async (source, target) => {
    if (target === store.databasePath) throw new Error('simulated publication interruption');
    return rename(source, target);
  };
  try { await assert.rejects(store.load(), /publication interruption/); } finally { fs.rename = rename; }
  await assert.rejects(fs.stat(store.databasePath), { code: 'ENOENT' });
  assert.equal((await fs.readdir(directory)).some((entry) => entry.startsWith('.notes-migrate-')), false);
  await store.load();
  await store.update('legacy', draft({ content: 'SQLite is authoritative' }));
  await store.close();
  await legacy.notes.update('legacy', draft({ content: 'old JSON' }));
  await store.load();
  assert.equal(store.get('legacy').content, 'SQLite is authoritative');
  await store.load();
  assert.equal(store.list().length, 1);
});

test('CRUD preserves defaults, normalization, isolated return values and durable row writes', async (t) => {
  const { store } = await workspace(t);
  assert.equal(store.database.pragma('journal_mode', { simple: true }), 'wal');
  assert.equal(store.database.pragma('synchronous', { simple: true }), 2);
  const created = await store.create();
  assert.equal(created.name, 'Untitled note');
  assert.equal(created.language, 'richtext');
  assert.equal(created.content, EMPTY_RICH_TEXT_CONTENT);
  const updated = await store.update(` ${created.id} `, draft({ name: '  ', tags: [' A ', 'a', '', 'B'] }));
  assert.equal(updated.name, 'Untitled note');
  assert.deepEqual(updated.tags, ['A', 'B']);
  assert.equal(updated.createdAt, created.createdAt);
  updated.tags.push('external');
  store.list()[0].tags.push('also external');
  assert.deepEqual(store.get(created.id).tags, ['A', 'B']);
  assert.equal(store.get('missing'), undefined);
  const second = await store.create();
  const rawBefore = store.database.prepare('SELECT data FROM notes WHERE id = ?').get(second.id);
  const changesBefore = store.database.prepare('SELECT total_changes() AS count').get().count;
  await store.update(created.id, draft({ content: 'one row only' }));
  assert.equal(store.database.prepare('SELECT total_changes() AS count').get().count - changesBefore, 1);
  assert.deepEqual(store.database.prepare('SELECT data FROM notes WHERE id = ?').get(second.id), rawBefore);
  const expected = store.exportSnapshot();
  await store.close();
  await store.load();
  assert.deepEqual(store.exportSnapshot(), expected);
  assert.deepEqual(await store.deleteMany([second.id, created.id, second.id, 'absent']), [second.id, created.id].sort());
  const tombstones = store.exportTombstones();
  tombstones[0].id = 'external';
  assert.equal(store.exportTombstones().some((item) => item.id === 'external'), false);
  assert.deepEqual(await store.deleteMany([created.id]), []);
  await store.delete('absent');
  await store.close();
  await store.load();
  assert.deepEqual(store.list(), []);
  assert.equal(store.exportTombstones().length, 2);
});

test('compareAndUpdate rejects stale and deleted bases, including an already matching draft', async (t) => {
  const { store } = await workspace(t);
  const base = await store.create();
  const edited = await store.compareAndUpdate(base.id, base, draft());
  await assert.rejects(store.compareAndUpdate(base.id, base, draft()), /changed after the editor/);
  await assert.rejects(store.compareAndUpdate(base.id, { ...edited, id: 'other' }, draft()), /base is invalid/);
  await store.delete(base.id);
  await assert.rejects(store.compareAndUpdate(base.id, edited, draft()), /changed after the editor/);
  await assert.rejects(store.update(base.id, draft()), /Note not found/);
});

test('SQLite and legacy stores reject the same invalid drafts and replacements', async (t) => {
  const { directory, store } = await workspace(t);
  const legacy = new NotesStore(path.join(directory, 'parity-legacy'));
  await legacy.load();
  for (const target of [legacy, store]) await target.replaceSnapshot(snapshot([note('base')]));
  const cases = [
    (target) => target.get(' '),
    (target) => target.get(null),
    (target) => target.update('base', draft({ language: 'unsupported' })),
    (target) => target.update('base', draft({ name: 'n'.repeat(NOTE_LIMITS.nameCharacters + 1) })),
    (target) => target.update('base', draft({ content: 'x'.repeat(NOTE_LIMITS.contentCharacters + 1) })),
    (target) => target.update('base', draft({ tags: Array.from({ length: 33 }, (_, index) => String(index)) })),
    (target) => target.update('base', draft({ tags: [false] })),
    (target) => target.update('base', draft({ language: 'richtext', content: 'not JSON' })),
    (target) => target.deleteMany('base'),
    (target) => target.deleteMany([' ']),
    (target) => target.deleteMany(Array(NOTE_LIMITS.notes + 1).fill('base')),
    (target) => target.replaceSnapshot({ schemaVersion: 2, notes: [] }),
    (target) => target.replaceSnapshot(snapshot([note('same'), note(' same ')])),
    (target) => target.replaceSnapshot(snapshot([note('bad', { updatedAt: 'invalid' })])),
    (target) => target.replaceSnapshot(snapshot([note('base')]), [{ id: 'base', deletedAt: timestamp }]),
    (target) => target.replaceSnapshot(snapshot([]), [{ id: 'x', deletedAt: 'bad' }]),
    (target) => target.replaceSnapshot(snapshot([]), [{ id: 'x', deletedAt: timestamp }, { id: ' x ', deletedAt: timestamp }]),
  ];
  for (const operation of cases) {
    const errors = [];
    for (const target of [legacy, store]) {
      try { await operation(target); } catch (error) { errors.push(error.message); }
    }
    assert.equal(errors.length, 2);
    assert.equal(errors[1], errors[0]);
  }
  assert.deepEqual(store.exportSnapshot(), snapshot([note('base')]));
});

test('note and tombstone count limits are enforced without partial deletion', async (t) => {
  const { store } = await workspace(t);
  await store.replaceSnapshot(snapshot(Array.from({ length: NOTE_LIMITS.notes }, (_, index) => note(`n-${index}`))));
  await assert.rejects(store.create(), /No more than 10000 notes/);
  const tombstones = Array.from({ length: NOTE_LIMITS.tombstones }, (_, index) => ({ id: `d-${index}`, deletedAt: timestamp }));
  await store.replaceSnapshot(snapshot([note('keep')]), tombstones);
  await assert.rejects(store.delete('keep'), /No more than 50000 deleted Note records/);
  assert.equal(store.get('keep').id, 'keep');
  assert.equal(store.exportTombstones().length, NOTE_LIMITS.tombstones);
});

test('failed row writes roll back entire transactions and do not poison the queue', async (t) => {
  const { store } = await workspace(t);
  await store.replaceSnapshot(snapshot([note('a'), note('b')]));
  const prepare = store.database.prepare.bind(store.database);
  let inserts = 0;
  store.database.prepare = (sql) => {
    const statement = prepare(sql);
    if (sql.startsWith('INSERT INTO tombstones')) {
      const run = statement.run.bind(statement);
      statement.run = (...args) => {
        if (++inserts === 2) throw new Error('simulated full disk');
        return run(...args);
      };
    }
    return statement;
  };
  try { await assert.rejects(store.deleteMany(['a', 'b']), /simulated full disk/); }
  finally { store.database.prepare = prepare; }
  assert.deepEqual(store.exportSnapshot(), snapshot([note('a'), note('b')]));
  assert.deepEqual(store.exportTombstones(), []);
  await store.update('a', draft({ content: 'queue recovered' }));
  assert.equal(store.get('a').content, 'queue recovered');
  await store.close();
  await store.load();
  assert.equal(store.list().length, 2);
});

test('SQLite tree backend keeps validation and persists tree changes without writing legacy JSON', async (t) => {
  const { directory, store } = await workspace(t);
  const legacyTree = await fs.readFile(path.join(directory, 'notes-tree.json'));
  await store.replaceSnapshot(snapshot([note('a'), note('b')]));
  const tree = store.createTreeStore();
  await tree.load(['a', 'b']);
  await tree.move('b', 'a');
  await assert.rejects(tree.move('a', 'b'), /descendant/);
  const expected = tree.snapshot();
  const bytes = await store.snapshotBytes();
  assert.deepEqual((await SqliteNotesStore.decodeSnapshot(bytes, directory)).tree, expected);
  assert.deepEqual(await fs.readFile(path.join(directory, 'notes-tree.json')), legacyTree);
  await store.close();
  await store.load();
  await tree.load(['a', 'b']);
  assert.deepEqual(tree.snapshot(), expected);
  const pendingMove = tree.move('b', null);
  await store.close();
  await pendingMove;
  await store.load();
  await tree.load(['a', 'b']);
  assert.equal(tree.get('b').parentId, null);
});

test('concurrent updates serialize and compareAndUpdate checks the base inside its transaction', async (t) => {
  const { store } = await workspace(t);
  const base = await store.create();
  const results = await Promise.allSettled([
    store.compareAndUpdate(base.id, base, draft({ content: 'first' })),
    store.compareAndUpdate(base.id, base, draft({ content: 'second' })),
  ]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.match(results[1].reason.message, /changed after the editor/);
  await Promise.all([
    store.update(base.id, draft({ content: 'queued first' })),
    store.update(base.id, draft({ content: 'queued last' })),
  ]);
  assert.equal(store.get(base.id).content, 'queued last');
});

test('bulk replacement rolls back failed installs and skips unchanged rows on retry', async (t) => {
  const { store } = await workspace(t);
  const initial = snapshot([note('a'), note('b')]);
  const initialTombstones = [{ id: 'deleted', deletedAt: timestamp }];
  await store.replaceSnapshot(initial, initialTombstones);
  const target = snapshot([note('a', { content: 'changed' }), note('c')]);
  const prepare = store.database.prepare.bind(store.database);
  store.database.prepare = (sql) => {
    const statement = prepare(sql);
    if (sql.startsWith('INSERT INTO notes')) {
      const run = statement.run.bind(statement);
      statement.run = (...args) => {
        if (args[0] === 'c') throw new Error('interrupted replacement');
        return run(...args);
      };
    }
    return statement;
  };
  try { await assert.rejects(store.replaceSnapshot(target), /interrupted replacement/); }
  finally { store.database.prepare = prepare; }
  assert.deepEqual(store.exportSnapshot(), initial);
  assert.deepEqual(store.exportTombstones(), initialTombstones);
  await store.replaceSnapshot(target);
  assert.deepEqual(store.exportSnapshot(), target);
  assert.deepEqual(store.exportTombstones(), []);
  const before = prepare('SELECT total_changes() AS count').get().count;
  await store.replaceSnapshot(target);
  assert.equal(prepare('SELECT total_changes() AS count').get().count, before);
  await store.close();
  await store.load();
  assert.deepEqual(store.exportSnapshot(), target);
});

test('optional tree backend propagates read/write failures without changing in-memory state', async () => {
  let persisted = emptyTree();
  let failWrite = false;
  const tree = new NotesTreeStore('unused', {
    read: async () => persisted,
    write: async (value) => {
      if (failWrite) throw new Error('backend unavailable');
      persisted = value;
    },
  });
  await tree.load(['a', 'b']);
  const before = tree.snapshot();
  failWrite = true;
  await assert.rejects(tree.move('b', 'a'), /backend unavailable/);
  assert.deepEqual(tree.snapshot(), before);
  failWrite = false;
  await tree.move('b', 'a');
  assert.deepEqual(tree.snapshot(), persisted);
  persisted = { schemaVersion: 5, nodes: [] };
  await assert.rejects(tree.load(['a', 'b']), /tree data is invalid/);
});

test('SQLite bulk apply retains workspace journal recovery across a tree-write interruption', async (t) => {
  const { directory, store } = await workspace(t);
  const tree = store.createTreeStore();
  const view = new NotesTreeViewStore(path.join(directory, 'notes-tree-view.json'));
  await tree.load([]);
  await view.load([]);
  const coordinator = new NotesWorkspaceApplyCoordinator(directory, store, tree, view);
  const target = {
    notes: snapshot([note('a'), note('b')]), tombstones: [{ id: 'gone', deletedAt: timestamp }],
    tree: { schemaVersion: 1, nodes: [
      { noteId: 'b', parentId: null, order: 1024 },
      { noteId: 'a', parentId: 'b', order: 1024 },
    ] },
  };
  const replaceTree = tree.replaceSnapshot.bind(tree);
  tree.replaceSnapshot = async () => { throw new Error('interrupted tree apply'); };
  try { await assert.rejects(coordinator.replace(target), /interrupted tree apply/); }
  finally { tree.replaceSnapshot = replaceTree; }
  await store.close();
  await store.load();
  await tree.load(['a', 'b']);
  await coordinator.recover();
  assert.deepEqual(store.exportSnapshot(), target.notes);
  assert.deepEqual(store.exportTombstones(), target.tombstones);
  assert.deepEqual(tree.snapshot(), target.tree);
  await coordinator.recover();
  assert.equal(await store.recoverPendingApply(), false);
  await assert.rejects(fs.stat(path.join(directory, '.notes-workspace-apply.json')), { code: 'ENOENT' });
});

test('backup captures committed WAL content as a standalone database and cleans up on failure', async (t) => {
  const { directory, store } = await workspace(t);
  store.database.pragma('wal_autocheckpoint = 0');
  const created = await store.create();
  await store.update(created.id, draft({ content: 'committed only in WAL' }));
  assert.ok((await fs.stat(`${store.databasePath}-wal`)).size > 0);
  const bytes = await store.snapshotBytes();
  assert.equal(bytes.subarray(0, 16).toString(), 'SQLite format 3\0');
  assert.equal(bytes[18], 1, 'standalone snapshot uses rollback-journal format');
  assert.equal((await SqliteNotesStore.decodeSnapshot(bytes, directory)).notes.notes[0].content, 'committed only in WAL');
  const backup = store.database.backup;
  store.database.backup = async () => { throw new Error('backup interrupted'); };
  try { await assert.rejects(store.snapshotBytes(), /backup interrupted/); }
  finally { store.database.backup = backup; }
  assert.equal((await fs.readdir(directory)).some((name) => /^\.notes-(snapshot|import)-/.test(name)), false);
  assert.equal(store.get(created.id).content, 'committed only in WAL');
});

test('committed WAL survives process termination without an explicit close', async (t) => {
  const { directory, store } = await workspace(t);
  await store.close();
  const modulePath = require.resolve('../dist/main/notes/sqliteNotesStore');
  const child = spawnSync(process.execPath, ['-e', `
    const { SqliteNotesStore } = require(process.argv[1]);
    (async () => {
      const store = new SqliteNotesStore(process.argv[2]);
      await store.load();
      store.database.pragma('wal_autocheckpoint = 0');
      await store.replaceSnapshot(JSON.parse(process.argv[3]));
      process.exit(0);
    })().catch(() => process.exit(1));
  `, modulePath, directory, JSON.stringify(snapshot([note('durable')]))], { encoding: 'utf8', timeout: 15_000 });
  assert.equal(child.status, 0, child.stderr);
  await store.load();
  assert.deepEqual(store.exportSnapshot(), snapshot([note('durable')]));
});

test('existing corrupt, empty, or foreign databases fail closed without consulting legacy data', async (t) => {
  for (const contents of [Buffer.from('not SQLite'), Buffer.alloc(0)]) {
    const { directory, store } = await workspace(t, false);
    const legacy = await legacyWorkspace(directory);
    await legacy.notes.replaceSnapshot(snapshot([note('legacy')]));
    await fs.writeFile(store.databasePath, contents);
    await assert.rejects(store.load());
    assert.throws(() => store.list(), /not open/);
    assert.deepEqual(await fs.readFile(store.databasePath), contents);
    assert.deepEqual(legacy.notes.exportSnapshot(), snapshot([note('legacy')]));
  }
  const { store } = await workspace(t, false);
  const db = new Database(store.databasePath);
  db.exec('CREATE TABLE foreign_data (secret TEXT)');
  db.close();
  await assert.rejects(store.load(), /schema/);
});

test('symlink database paths and orphan recovery files are rejected', async (t) => {
  const { directory, store } = await workspace(t, false);
  const outside = path.join(directory, 'unrelated');
  await fs.writeFile(outside, 'untouched');
  await fs.symlink(outside, store.databasePath);
  await assert.rejects(store.load(), /regular file/);
  assert.equal(await fs.readFile(outside, 'utf8'), 'untouched');
  await fs.unlink(store.databasePath);
  await fs.writeFile(`${store.databasePath}-wal`, 'orphan');
  await assert.rejects(store.load(), /recovery files remain/);
  await assert.rejects(fs.stat(store.databasePath), { code: 'ENOENT' });
});

test('malformed legacy notes prevent publishing an incomplete migration', async (t) => {
  const { directory, store } = await workspace(t, false);
  const legacy = await legacyWorkspace(directory);
  await legacy.notes.replaceSnapshot(snapshot([note('a')]));
  const name = `${createHash('sha256').update('a').digest('hex')}.json`;
  await fs.writeFile(path.join(directory, 'notes-v4', name), '{');
  await assert.rejects(store.load());
  await assert.rejects(fs.stat(store.databasePath), { code: 'ENOENT' });
});

test('snapshot import bounds bytes, validates the header and removes temporary files on rejection', async (t) => {
  const { directory, store } = await workspace(t);
  assert.equal(NOTES_DATABASE_MAX_BYTES, 128 * 1024 * 1024);
  await assert.rejects(SqliteNotesStore.decodeSnapshot(Buffer.alloc(NOTES_DATABASE_MAX_BYTES + 1), directory), /128 MiB/);
  await assert.rejects(SqliteNotesStore.decodeSnapshot(Buffer.from('SQLite format 3\0'), directory), /invalid/);
  await assert.rejects(SqliteNotesStore.decodeSnapshot(Buffer.alloc(512), directory), /invalid/);
  const bytes = await store.snapshotBytes();
  const broken = Buffer.from(bytes);
  broken.fill(0, 100);
  await assert.rejects(SqliteNotesStore.decodeSnapshot(broken, directory));
  assert.equal((await fs.readdir(directory)).some((name) => name.startsWith('.notes-import-')), false);
});

test('snapshot import rejects unapproved schemas, executable objects, metadata, and invalid rows', async (t) => {
  const { directory, store } = await workspace(t);
  await store.replaceSnapshot(snapshot([note('a')]));
  await store.createTreeStore().load(['a']);
  const bytes = await store.snapshotBytes();
  const mutations = [
    (db) => db.exec('CREATE TABLE preferences (token TEXT)'),
    (db) => db.exec('CREATE VIEW arbitrary_view AS SELECT load_extension(\'untrusted\')'),
    (db) => db.exec('CREATE TRIGGER arbitrary_trigger AFTER INSERT ON notes BEGIN DELETE FROM notes; END'),
    (db) => db.exec('CREATE INDEX extra_index ON notes (data)'),
    (db) => db.exec('ALTER TABLE notes ADD COLUMN extra TEXT'),
    (db) => db.pragma('user_version = 2'),
    (db) => db.pragma('application_id = 0'),
    (db) => db.prepare('UPDATE meta SET value = ?').run('2'),
    (db) => db.prepare('INSERT INTO meta VALUES (?, ?)').run('preferences', 'secret'),
    (db) => db.prepare('UPDATE notes SET data = ?').run('{'),
    (db) => db.prepare('UPDATE notes SET data = ?').run(JSON.stringify(note('mismatched-id'))),
    (db) => db.prepare('UPDATE notes SET data = ?').run(JSON.stringify(note('a', { language: 'unsupported' }))),
    (db) => db.prepare('UPDATE notes SET data = ?').run(JSON.stringify(note('a', { createdAt: 'bad' }))),
    (db) => db.prepare('UPDATE notes SET data = ?').run(Buffer.alloc(16)),
    (db) => db.prepare('INSERT INTO tombstones VALUES (?, ?)').run('a', timestamp),
    (db) => db.prepare('INSERT INTO tombstones VALUES (?, ?)').run('deleted', 'bad'),
    (db) => db.prepare('UPDATE tree SET sort_order = ?').run(-1),
    (db) => db.prepare('UPDATE tree SET parent_id = ?').run(' parent '),
    (db) => db.prepare('UPDATE tree SET position = ?').run(3),
  ];
  for (const mutation of mutations) {
    const malformed = await mutatedSnapshot(directory, bytes, mutation);
    await assert.rejects(SqliteNotesStore.decodeSnapshot(malformed, directory));
    assert.equal((await fs.readdir(directory)).some((name) => name.startsWith('.notes-import-')), false);
  }
  assert.deepEqual(store.exportSnapshot(), snapshot([note('a')]));
});

test('close waits for queued writes, is idempotent, and rejects operations until reopened', async (t) => {
  const { store } = await workspace(t);
  const pending = store.replaceSnapshot(snapshot([note('queued')]));
  await store.close();
  await pending;
  await store.close();
  await assert.rejects(store.create(), /not open/);
  await store.load();
  assert.deepEqual(store.exportSnapshot(), snapshot([note('queued')]));
});
