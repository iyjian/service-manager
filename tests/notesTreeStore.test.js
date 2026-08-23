const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  NOTES_TREE_MAX_DEPTH,
  NOTES_TREE_SCHEMA_VERSION,
  NotesTreeStore,
} = require('../dist/main/notes/notesTreeStore');

async function createStore(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'service-manager-notes-tree-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'notes-tree.json');
  return { directory, filePath, store: new NotesTreeStore(filePath) };
}

async function writeTree(filePath, nodes, schemaVersion = NOTES_TREE_SCHEMA_VERSION) {
  await fs.writeFile(filePath, JSON.stringify({ schemaVersion, nodes }, null, 2), { mode: 0o600 });
}

async function readTree(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

function node(noteId, parentId, order) {
  return { noteId, parentId, order };
}

test('missing Notes tree creates deterministic private roots for every active Note', async (t) => {
  const { directory, filePath, store } = await createStore(t);
  const snapshot = await store.load(['z-note', 'a-note', 'm-note']);

  assert.deepEqual(snapshot, {
    schemaVersion: NOTES_TREE_SCHEMA_VERSION,
    nodes: [
      node('a-note', null, 1024),
      node('m-note', null, 2048),
      node('z-note', null, 3072),
    ],
  });
  assert.deepEqual(await readTree(filePath), snapshot);
  assert.deepEqual(
    (await fs.readdir(directory)).filter((name) => name.endsWith('.tmp')),
    [],
  );
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(filePath)).mode & 0o777, 0o600);
  }

  snapshot.nodes[0].noteId = 'mutated';
  store.snapshot().nodes[0].order = 99;
  store.get('a-note').parentId = 'mutated';
  assert.deepEqual(store.get(), {
    schemaVersion: NOTES_TREE_SCHEMA_VERSION,
    nodes: [
      node('a-note', null, 1024),
      node('m-note', null, 2048),
      node('z-note', null, 3072),
    ],
  });
});

test('missing Notes tree assigns a large active set in one deterministic order pass', async (t) => {
  const { store } = await createStore(t);
  const activeIds = Array.from({ length: 10_000 }, (_, index) => `note-${String(index).padStart(5, '0')}`);
  const snapshot = await store.load(activeIds);

  assert.equal(snapshot.nodes.length, activeIds.length);
  assert.deepEqual(snapshot.nodes.slice(0, 2), [
    node('note-00000', null, 1024),
    node('note-00001', null, 2048),
  ]);
  assert.deepEqual(snapshot.nodes.slice(-2), [
    node('note-09998', null, 10_238_976),
    node('note-09999', null, 10_240_000),
  ]);
});

test('load drops extras, deduplicates, appends missing roots, and repairs dangling parents and cycles', async (t) => {
  const { filePath, store } = await createStore(t);
  await writeTree(filePath, [
    node('extra', null, 1),
    node('a', 'b', 10),
    node('a', null, 100),
    node('b', 'a', 20),
    node('c', 'removed-parent', 30),
    node('e', 'd', 40),
  ]);

  const snapshot = await store.load(['e', 'd', 'c', 'b', 'a']);
  assert.deepEqual(snapshot.nodes, [
    node('a', null, 10),
    node('b', null, 20),
    node('c', null, 30),
    node('d', null, 1054),
    node('e', 'd', 40),
  ]);
  assert.deepEqual(await readTree(filePath), snapshot);

  const reloaded = new NotesTreeStore(filePath);
  assert.deepEqual(await reloaded.load(['a', 'b', 'c', 'd', 'e']), snapshot);
});

test('repair rebalances existing roots once before a missing-root batch would exhaust safe order space', async (t) => {
  const { filePath, store } = await createStore(t);
  await writeTree(filePath, [
    node('a', null, Number.MAX_SAFE_INTEGER - 1),
    node('b', null, Number.MAX_SAFE_INTEGER),
  ]);

  const snapshot = await store.load(['a', 'b', 'c', 'd']);
  assert.deepEqual(snapshot.nodes, [
    node('a', null, 1024),
    node('b', null, 2048),
    node('c', null, 3072),
    node('d', null, 4096),
  ]);
});

test('load deterministically roots every stored node beyond depth 32', async (t) => {
  const { filePath, store } = await createStore(t);
  const ids = Array.from({ length: NOTES_TREE_MAX_DEPTH + 3 }, (_, index) => `n${String(index).padStart(2, '0')}`);
  await writeTree(filePath, ids.map((noteId, index) => node(
    noteId,
    index === 0 ? null : ids[index - 1],
    index + 1,
  )));

  const snapshot = await store.load(ids);
  assert.equal(store.get(ids[NOTES_TREE_MAX_DEPTH]).parentId, ids[NOTES_TREE_MAX_DEPTH - 1]);
  assert.equal(store.get(ids[NOTES_TREE_MAX_DEPTH + 1]).parentId, null);
  assert.equal(store.get(ids[NOTES_TREE_MAX_DEPTH + 2]).parentId, null);
  assert.equal(snapshot.nodes.length, ids.length);
  assert.deepEqual(await readTree(filePath), snapshot);
});

test('invalid JSON, schema, node fields, and symlinks fail closed without replacement', async (t) => {
  const { directory } = await createStore(t);
  const cases = [
    ['broken.json', '{not-json'],
    ['schema.json', JSON.stringify({ schemaVersion: 2, nodes: [] })],
    ['shape.json', JSON.stringify({ schemaVersion: 1, nodes: [node('a', null, 1.5)] })],
    ['parent.json', JSON.stringify({ schemaVersion: 1, nodes: [node('a', undefined, 1)] })],
  ];
  for (const [fileName, contents] of cases) {
    const filePath = path.join(directory, fileName);
    await fs.writeFile(filePath, contents);
    const store = new NotesTreeStore(filePath);
    await assert.rejects(store.load(['a']), /Notes tree data is invalid/);
    assert.equal(await fs.readFile(filePath, 'utf8'), contents);
  }

  const targetPath = path.join(directory, 'target.json');
  const linkPath = path.join(directory, 'link.json');
  await writeTree(targetPath, []);
  await fs.symlink(targetPath, linkPath);
  const linkedStore = new NotesTreeStore(linkPath);
  await assert.rejects(linkedStore.load([]), /Notes tree data is invalid/);
  assert.deepEqual(await readTree(targetPath), { schemaVersion: 1, nodes: [] });
});

test('active Note IDs and replacement snapshots are fully validated before mutation', async (t) => {
  const { filePath, store } = await createStore(t);
  await store.load(['a']);
  const before = await fs.readFile(filePath, 'utf8');

  assert.throws(() => store.load(['a', 'a']), /duplicate/);
  assert.throws(() => store.load([' a']), /Note ID is invalid/);
  assert.throws(
    () => store.replaceSnapshot({ schemaVersion: 1, nodes: [{ noteId: 'a', parentId: null, order: -1 }] }, ['a']),
    /Notes tree data is invalid/,
  );
  assert.throws(() => store.replaceSnapshot({ schemaVersion: 2, nodes: [] }, ['a']), /invalid/);
  assert.equal(await fs.readFile(filePath, 'utf8'), before);
  assert.deepEqual(store.snapshot().nodes, [node('a', null, 1024)]);
});

test('insert and move support sparse before-placement and canonical tree order', async (t) => {
  const { filePath, store } = await createStore(t);
  await store.load(['a', 'b']);
  await store.insert('c', 'a');
  await store.insert('d', null, 'b');
  const moved = await store.move('b', 'a', 'c');

  assert.deepEqual(moved.nodes, [
    node('a', null, 1024),
    node('b', 'a', 511),
    node('c', 'a', 1024),
    node('d', null, 1536),
  ]);
  assert.deepEqual(await readTree(filePath), moved);

  await assert.rejects(store.insert('c', null), /already exists/);
  await assert.rejects(store.insert('e', 'missing'), /parent Note was not found/);
  await assert.rejects(store.insert('e', null, 'c'), /target sibling was not found/);
  await assert.rejects(store.move('missing', null), /Note was not found/);
  await assert.rejects(store.move('a', 'a'), /own parent/);
  await assert.rejects(store.move('a', 'c'), /own descendant/);
  await assert.rejects(store.move('c', 'a', 'c'), /before itself/);
  assert.deepEqual(await readTree(filePath), moved);
});

test('insert and move enforce maximum depth for the complete moved subtree', async (t) => {
  const { store } = await createStore(t);
  const chain = Array.from({ length: NOTES_TREE_MAX_DEPTH + 1 }, (_, index) => `chain-${index}`);
  const source = [
    ...chain.map((noteId, index) => node(noteId, index === 0 ? null : chain[index - 1], index + 1)),
    node('branch', null, 500),
    node('branch-child', 'branch', 1),
  ];
  await store.replaceSnapshot(
    { schemaVersion: NOTES_TREE_SCHEMA_VERSION, nodes: source },
    [...chain, 'branch', 'branch-child'],
  );

  await assert.rejects(
    store.insert('too-deep', chain[chain.length - 1]),
    /maximum depth of 32/,
  );
  await assert.rejects(
    store.move('branch', chain[chain.length - 1]),
    /maximum depth of 32/,
  );
  assert.equal(store.get('branch').parentId, null);
  assert.equal(store.get('branch-child').parentId, 'branch');
});

test('removeIds removes selected nodes, roots surviving children, and ignores absent IDs', async (t) => {
  const { filePath, store } = await createStore(t);
  await store.replaceSnapshot({
    schemaVersion: NOTES_TREE_SCHEMA_VERSION,
    nodes: [
      node('a', null, 10),
      node('b', 'a', 10),
      node('c', 'b', 10),
      node('d', null, 20),
    ],
  }, ['a', 'b', 'c', 'd']);

  const result = await store.removeIds(['a']);
  assert.deepEqual(result.nodes, [
    node('b', null, 10),
    node('c', 'b', 10),
    node('d', null, 20),
  ]);
  const beforeAbsentRemoval = await fs.readFile(filePath, 'utf8');
  assert.deepEqual(await store.removeIds(['absent']), result);
  assert.equal(await fs.readFile(filePath, 'utf8'), beforeAbsentRemoval);
  assert.throws(() => store.removeIds(['b', 'b']), /duplicate/);
});

test('replaceSnapshot repairs against active IDs, persists canonical data, and clones input', async (t) => {
  const { filePath, store } = await createStore(t);
  const input = {
    schemaVersion: NOTES_TREE_SCHEMA_VERSION,
    nodes: [
      node('removed', null, 1),
      node('child', 'parent', 5),
      node('parent', null, 10),
    ],
  };
  const snapshot = await store.replaceSnapshot(input, ['parent', 'child', 'missing']);
  input.nodes[1].parentId = null;
  snapshot.nodes[0].order = 999;

  assert.deepEqual(store.snapshot().nodes, [
    node('parent', null, 10),
    node('child', 'parent', 5),
    node('missing', null, 1034),
  ]);
  assert.deepEqual(await readTree(filePath), store.snapshot());
});

test('order allocation rebalances safely at exhausted and adjacent sparse positions', async (t) => {
  const { store } = await createStore(t);
  await store.replaceSnapshot({
    schemaVersion: NOTES_TREE_SCHEMA_VERSION,
    nodes: [
      node('a', null, Number.MAX_SAFE_INTEGER - 1),
      node('b', null, Number.MAX_SAFE_INTEGER),
    ],
  }, ['a', 'b']);
  await store.insert('c', null);
  assert.deepEqual(store.snapshot().nodes, [
    node('a', null, 1024),
    node('b', null, 2048),
    node('c', null, 3072),
  ]);

  await store.replaceSnapshot({
    schemaVersion: NOTES_TREE_SCHEMA_VERSION,
    nodes: [node('a', null, 0), node('b', null, 1)],
  }, ['a', 'b']);
  await store.insert('c', null, 'b');
  assert.deepEqual(store.snapshot().nodes, [
    node('a', null, 1024),
    node('c', null, 1536),
    node('b', null, 2048),
  ]);
});

test('mutations serialize in invocation order and a failed atomic write leaves memory unchanged', async (t) => {
  const { filePath, store } = await createStore(t);
  await store.load(['a', 'b', 'c']);

  const results = await Promise.all([
    store.move('c', 'a'),
    store.move('b', 'c'),
  ]);
  assert.equal(results[0].nodes.find((candidate) => candidate.noteId === 'c').parentId, 'a');
  assert.equal(results[1].nodes.find((candidate) => candidate.noteId === 'b').parentId, 'c');
  assert.deepEqual(store.snapshot().nodes.map((candidate) => candidate.noteId), ['a', 'c', 'b']);

  const durableBeforeFailure = await fs.readFile(filePath, 'utf8');
  const memoryBeforeFailure = store.snapshot();
  const originalRename = fs.rename;
  fs.rename = async () => {
    throw new Error('simulated rename failure');
  };
  try {
    await assert.rejects(store.insert('failed', null), /could not be saved/);
  } finally {
    fs.rename = originalRename;
  }
  assert.deepEqual(store.snapshot(), memoryBeforeFailure);
  assert.equal(await fs.readFile(filePath, 'utf8'), durableBeforeFailure);

  await store.insert('recovered', null);
  await store.flush();
  assert.ok(store.get('recovered'));
});
