const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  NOTES_TREE_VIEW_MAX_IDS,
  NOTES_TREE_VIEW_SCHEMA_VERSION,
  NotesTreeViewStore,
} = require('../dist/main/notesTreeViewStore');

async function createStore(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'service-manager-notes-tree-view-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'notes-tree-view.json');
  return { directory, filePath, store: new NotesTreeViewStore(filePath) };
}

async function writeView(filePath, expandedNoteIds, schemaVersion = NOTES_TREE_VIEW_SCHEMA_VERSION) {
  await fs.writeFile(filePath, JSON.stringify({ schemaVersion, expandedNoteIds }, null, 2), { mode: 0o600 });
}

async function readView(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

test('missing Notes tree view loads an empty detached default without creating a file', async (t) => {
  const { filePath, store } = await createStore(t);
  const loaded = await store.load(['a', 'b']);

  assert.deepEqual(loaded, {
    schemaVersion: NOTES_TREE_VIEW_SCHEMA_VERSION,
    expandedNoteIds: [],
  });
  await assert.rejects(fs.stat(filePath), { code: 'ENOENT' });
  loaded.expandedNoteIds.push('mutated');
  store.get().expandedNoteIds.push('also-mutated');
  assert.deepEqual(store.snapshot().expandedNoteIds, []);
});

test('load filters inactive IDs, canonicalizes order, and repairs the durable file', async (t) => {
  const { filePath, store } = await createStore(t);
  await writeView(filePath, ['z', 'removed', 'a']);

  const loaded = await store.load(['z', 'a', 'other']);
  assert.deepEqual(loaded.expandedNoteIds, ['a', 'z']);
  assert.deepEqual(await readView(filePath), loaded);

  const reloaded = new NotesTreeViewStore(filePath);
  assert.deepEqual(await reloaded.load(['a', 'z']), loaded);
});

test('invalid JSON, schemas, fields, duplicates, and symlinks fail closed', async (t) => {
  const { directory } = await createStore(t);
  const cases = [
    ['broken.json', '{not-json'],
    ['schema.json', JSON.stringify({ schemaVersion: 2, expandedNoteIds: [] })],
    ['shape.json', JSON.stringify({ schemaVersion: 1, expandedNoteIds: 'a' })],
    ['entry.json', JSON.stringify({ schemaVersion: 1, expandedNoteIds: [' a'] })],
    ['duplicate.json', JSON.stringify({ schemaVersion: 1, expandedNoteIds: ['a', 'a'] })],
  ];
  for (const [name, contents] of cases) {
    const filePath = path.join(directory, name);
    await fs.writeFile(filePath, contents);
    const store = new NotesTreeViewStore(filePath);
    await assert.rejects(store.load(['a']), /Notes tree view data is invalid/);
    assert.equal(await fs.readFile(filePath, 'utf8'), contents);
  }

  const targetPath = path.join(directory, 'target.json');
  const linkPath = path.join(directory, 'link.json');
  await writeView(targetPath, []);
  await fs.symlink(targetPath, linkPath, 'file');
  await assert.rejects(new NotesTreeViewStore(linkPath).load([]), /Notes tree view data is invalid/);
  assert.deepEqual(await readView(targetPath), { schemaVersion: 1, expandedNoteIds: [] });
});

test('save filters against active IDs and writes a private atomic schema-1 file', async (t) => {
  const { directory, filePath, store } = await createStore(t);
  await store.load(['a', 'b']);
  const input = ['b', 'inactive', 'a'];
  const saved = await store.save(input, ['a', 'b']);
  input[0] = 'mutated';
  saved.expandedNoteIds.length = 0;

  assert.deepEqual(store.snapshot(), {
    schemaVersion: NOTES_TREE_VIEW_SCHEMA_VERSION,
    expandedNoteIds: ['a', 'b'],
  });
  assert.deepEqual(await readView(filePath), store.snapshot());
  assert.deepEqual(
    (await fs.readdir(directory)).filter((name) => name.endsWith('.tmp')),
    [],
  );
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(filePath)).mode & 0o777, 0o600);
  }

  assert.deepEqual(
    await store.save({ expandedNoteIds: ['b'] }, ['a', 'b']),
    { schemaVersion: 1, expandedNoteIds: ['b'] },
  );
});

test('set expands and collapses active Notes while rejecting invalid targets', async (t) => {
  const { filePath, store } = await createStore(t);
  await store.load(['a', 'b']);

  assert.deepEqual((await store.set('b', true, ['a', 'b'])).expandedNoteIds, ['b']);
  assert.deepEqual((await store.set('a', true, ['a', 'b'])).expandedNoteIds, ['a', 'b']);
  assert.deepEqual((await store.set('b', false, ['a', 'b'])).expandedNoteIds, ['a']);
  assert.deepEqual(await readView(filePath), store.snapshot());

  assert.throws(() => store.set('inactive', true, ['a', 'b']), /not active/);
  assert.throws(() => store.set('a', 'yes', ['a', 'b']), /Expanded state is invalid/);
  assert.throws(() => store.set('a', true, ['a', 'a']), /duplicate/);
  assert.deepEqual(store.snapshot().expandedNoteIds, ['a']);
});

test('replaceActiveIds removes stale expansion state and preserves active state', async (t) => {
  const { filePath, store } = await createStore(t);
  await store.save(['a', 'b', 'c'], ['a', 'b', 'c']);

  const replaced = await store.replaceActiveIds(['c', 'a', 'new']);
  assert.deepEqual(replaced.expandedNoteIds, ['a', 'c']);
  assert.deepEqual(await readView(filePath), replaced);

  const contents = await fs.readFile(filePath, 'utf8');
  assert.deepEqual(await store.replaceActiveIds(['a', 'c']), replaced);
  assert.equal(await fs.readFile(filePath, 'utf8'), contents);
});

test('IDs and collection sizes are bounded and validated before writes', async (t) => {
  const { filePath, store } = await createStore(t);
  await store.save([], []);
  const before = await fs.readFile(filePath, 'utf8');

  assert.throws(() => store.save(['a', 'a'], ['a']), /duplicate/);
  assert.throws(() => store.save(['x'.repeat(129)], []), /Note ID is invalid/);
  assert.throws(
    () => store.replaceActiveIds(Array.from({ length: NOTES_TREE_VIEW_MAX_IDS + 1 }, (_, index) => `id-${index}`)),
    /Active Note IDs are invalid/,
  );
  assert.equal(await fs.readFile(filePath, 'utf8'), before);
});

test('mutations serialize in invocation order and recover after an atomic write failure', async (t) => {
  const { filePath, store } = await createStore(t);
  await store.load(['a', 'b', 'c']);
  const results = await Promise.all([
    store.set('a', true, ['a', 'b', 'c']),
    store.set('b', true, ['a', 'b', 'c']),
    store.set('a', false, ['a', 'b', 'c']),
  ]);
  assert.deepEqual(results.map((result) => result.expandedNoteIds), [
    ['a'],
    ['a', 'b'],
    ['b'],
  ]);

  const durableBefore = await fs.readFile(filePath, 'utf8');
  const memoryBefore = store.snapshot();
  const originalRename = fs.rename;
  fs.rename = async () => {
    throw new Error('simulated rename failure');
  };
  try {
    await assert.rejects(store.set('c', true, ['a', 'b', 'c']), /could not be saved/);
  } finally {
    fs.rename = originalRename;
  }
  assert.deepEqual(store.snapshot(), memoryBefore);
  assert.equal(await fs.readFile(filePath, 'utf8'), durableBefore);

  await store.set('c', true, ['a', 'b', 'c']);
  await store.flush();
  assert.deepEqual(store.snapshot().expandedNoteIds, ['b', 'c']);
});
