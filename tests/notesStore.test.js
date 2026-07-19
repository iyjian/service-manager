const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { NOTE_LIMITS, NOTES_SCHEMA_VERSION, NotesStore } = require('../dist/main/notesStore');

function noteFileName(id) {
  return `${createHash('sha256').update(id, 'utf8').digest('hex')}.json`;
}

function noteFilePath(notesDirectory, id) {
  return path.join(notesDirectory, noteFileName(id));
}

async function createStore(t, prefix = 'service-manager-notes-') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const notesDirectory = path.join(directory, 'notes');
  const store = new NotesStore(notesDirectory);
  await store.load();
  return { directory, notesDirectory, store };
}

function draft(overrides = {}) {
  return {
    name: 'Deploy API',
    content: 'pnpm deploy',
    language: 'bash',
    tags: ['production', 'release'],
    ...overrides,
  };
}

function storedNote(overrides = {}) {
  return {
    id: 'synced-note',
    name: 'Cloud note',
    content: '# synced',
    language: 'markdown',
    tags: ['shared'],
    createdAt: '2026-07-18T01:02:03.000Z',
    updatedAt: '2026-07-18T01:02:04.000Z',
    ...overrides,
  };
}

async function readEnvelope(notesDirectory, id) {
  return JSON.parse(await fs.readFile(noteFilePath(notesDirectory, id), 'utf8'));
}

async function noteFileNames(notesDirectory) {
  return (await fs.readdir(notesDirectory))
    .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
    .sort();
}

async function writeReplacementCompleteFile(notesDirectory) {
  await fs.writeFile(
    path.join(notesDirectory, '.replacement-complete.json'),
    JSON.stringify({ schemaVersion: NOTES_SCHEMA_VERSION, files: await noteFileNames(notesDirectory) }),
    { mode: 0o600 },
  );
}

async function directoryFileSnapshot(notesDirectory) {
  const snapshot = {};
  for (const name of (await fs.readdir(notesDirectory)).sort()) {
    const metadata = await fs.lstat(path.join(notesDirectory, name));
    if (metadata.isFile()) snapshot[name] = await fs.readFile(path.join(notesDirectory, name), 'utf8');
  }
  return snapshot;
}

async function assertPathMissing(candidate) {
  await assert.rejects(
    fs.lstat(candidate),
    (error) => error && error.code === 'ENOENT',
  );
}

test('NotesStore creates one private SHA-256-addressed active envelope per Note ID', async (t) => {
  const { notesDirectory, store } = await createStore(t);
  const note = await store.create();

  assert.equal(note.name, 'Untitled note');
  assert.equal(note.content, '');
  assert.equal(note.language, 'markdown');
  assert.deepEqual(note.tags, []);
  assert.ok(note.id);
  assert.equal(note.createdAt, note.updatedAt);
  assert.deepEqual(await noteFileNames(notesDirectory), [noteFileName(note.id)]);
  assert.deepEqual(await readEnvelope(notesDirectory, note.id), {
    schemaVersion: NOTES_SCHEMA_VERSION,
    note,
  });

  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(notesDirectory)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(noteFilePath(notesDirectory, note.id))).mode & 0o777, 0o600);
  }
});

test('NotesStore updates only the target envelope, normalizes fields, and returns detached values', async (t) => {
  const { notesDirectory, store } = await createStore(t);
  const first = await store.create();
  const second = await store.create();
  const untouchedBefore = await fs.readFile(noteFilePath(notesDirectory, second.id), 'utf8');
  const originalRename = fs.rename;
  const renameDestinations = [];
  fs.rename = async (source, destination) => {
    renameDestinations.push(path.resolve(String(destination)));
    return originalRename(source, destination);
  };

  let updated;
  try {
    updated = await store.update(first.id, draft({
      name: '  Deploy API  ',
      tags: [' production ', '', 'Release', 'release'],
    }));
  } finally {
    fs.rename = originalRename;
  }

  assert.deepEqual(renameDestinations, [path.resolve(noteFilePath(notesDirectory, first.id))]);
  assert.equal(await fs.readFile(noteFilePath(notesDirectory, second.id), 'utf8'), untouchedBefore);
  assert.equal(updated.name, 'Deploy API');
  assert.equal(updated.content, 'pnpm deploy');
  assert.equal(updated.language, 'bash');
  assert.deepEqual(updated.tags, ['production', 'Release']);
  assert.equal(updated.createdAt, first.createdAt);
  assert.deepEqual((await readEnvelope(notesDirectory, first.id)).note, updated);

  updated.name = 'mutated';
  updated.tags.push('mutated');
  const listed = store.list();
  listed.find((note) => note.id === first.id).content = 'mutated';
  const snapshot = store.exportSnapshot();
  snapshot.notes.find((note) => note.id === first.id).tags.length = 0;
  const durable = store.list().find((note) => note.id === first.id);
  assert.equal(durable.name, 'Deploy API');
  assert.equal(durable.content, 'pnpm deploy');
  assert.deepEqual(durable.tags, ['production', 'Release']);
});

test('NotesStore loads independent envelopes in deterministic Note-ID order and normalizes stored fields', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'service-manager-notes-order-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const notesDirectory = path.join(directory, 'notes');
  await fs.mkdir(notesDirectory, { recursive: true });
  const candidates = [
    storedNote({ id: 'z-note', name: 'Zulu' }),
    storedNote({
      id: 'a-note',
      name: '   ',
      tags: [' docs ', 'DOCS', ''],
      createdAt: '2026-07-18T01:02:03Z',
      updatedAt: '2026-07-18T01:02:04Z',
    }),
    storedNote({ id: 'm-note', name: 'Middle' }),
  ];
  for (const note of candidates) {
    await fs.writeFile(noteFilePath(notesDirectory, note.id), JSON.stringify({
      schemaVersion: NOTES_SCHEMA_VERSION,
      note,
    }));
  }
  const deletedAt = '2026-07-19T02:03:04Z';
  await fs.writeFile(noteFilePath(notesDirectory, 'b-deleted'), JSON.stringify({
    schemaVersion: NOTES_SCHEMA_VERSION,
    tombstone: { id: 'b-deleted', deletedAt },
  }));

  const store = new NotesStore(notesDirectory);
  await store.load();

  assert.deepEqual(store.list().map((note) => note.id), ['a-note', 'm-note', 'z-note']);
  assert.deepEqual(store.list()[0], {
    ...candidates[1],
    name: 'Untitled note',
    tags: ['docs'],
    createdAt: '2026-07-18T01:02:03.000Z',
    updatedAt: '2026-07-18T01:02:04.000Z',
  });
  assert.deepEqual(store.exportTombstones(), [{
    id: 'b-deleted',
    deletedAt: '2026-07-19T02:03:04.000Z',
  }]);

  const reloaded = new NotesStore(notesDirectory);
  await reloaded.load();
  assert.deepEqual(reloaded.list(), store.list());
  assert.deepEqual(reloaded.exportTombstones(), store.exportTombstones());
});

test('NotesStore ignores and preserves the retired sibling notes.json without migrating it', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'service-manager-notes-legacy-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const notesDirectory = path.join(directory, 'notes');
  const legacyPath = path.join(directory, 'notes.json');
  const legacyPayload = JSON.stringify({ schemaVersion: 1, notes: [storedNote()] }, null, 2);
  await fs.writeFile(legacyPath, legacyPayload);

  const store = new NotesStore(notesDirectory);
  await store.load();

  assert.deepEqual(store.list(), []);
  assert.deepEqual(store.exportTombstones(), []);
  assert.equal(await fs.readFile(legacyPath, 'utf8'), legacyPayload);
  assert.deepEqual(await noteFileNames(notesDirectory), []);
});

test('NotesStore rejects unsupported drafts and bounded fields', async (t) => {
  const { store } = await createStore(t);
  const note = await store.create();

  await assert.rejects(store.update(note.id, draft({ language: 'python' })), /language is not supported/);
  await assert.rejects(
    store.update(note.id, draft({ content: 'x'.repeat(NOTE_LIMITS.contentCharacters + 1) })),
    /content must not exceed/,
  );
  await assert.rejects(store.update(note.id, draft({ tags: ['valid', 3] })), /tags must contain only text/);
  await assert.rejects(
    store.update(note.id, draft({ tags: Array.from({ length: NOTE_LIMITS.tags + 1 }, (_, index) => `tag-${index}`) })),
    /must not have more than/,
  );
  await assert.rejects(store.update('missing', draft()), /Note not found/);
});

test('NotesStore accepts and durably reloads SQL notes', async (t) => {
  const { notesDirectory, store } = await createStore(t);
  const note = await store.create();
  const sql = 'SELECT id, name FROM users WHERE enabled = TRUE;';
  const updated = await store.update(note.id, draft({
    name: 'Active users',
    content: sql,
    language: 'sql',
    tags: ['database'],
  }));
  await store.flush();

  assert.equal(updated.language, 'sql');
  assert.equal((await readEnvelope(notesDirectory, note.id)).note.content, sql);
  const reloaded = new NotesStore(notesDirectory);
  await reloaded.load();
  assert.equal(reloaded.list()[0].language, 'sql');
  assert.equal(reloaded.list()[0].content, sql);
});

test('NotesStore serializes concurrent updates so the last invocation wins in the target file', async (t) => {
  const { notesDirectory, store } = await createStore(t);
  const note = await store.create();

  const first = store.update(note.id, draft({ content: 'first' }));
  const second = store.update(note.id, draft({ content: 'second', language: 'typescript' }));
  const third = store.update(note.id, draft({ content: 'third', language: 'javascript' }));
  await Promise.all([first, second, third]);
  await store.flush();

  assert.equal(store.list()[0].content, 'third');
  assert.equal(store.list()[0].language, 'javascript');
  assert.equal((await readEnvelope(notesDirectory, note.id)).note.content, 'third');
  assert.equal((await fs.readdir(notesDirectory)).some((name) => name.endsWith('.tmp')), false);
});

test('NotesStore delete atomically replaces only the active envelope with a durable tombstone', async (t) => {
  const { notesDirectory, store } = await createStore(t);
  const first = await store.create();
  const second = await store.create();
  const secondBefore = await fs.readFile(noteFilePath(notesDirectory, second.id), 'utf8');
  const fileNamesBefore = await noteFileNames(notesDirectory);

  await store.delete(first.id);
  await store.delete(first.id);
  await store.delete('already-deleted');
  await store.flush();

  assert.deepEqual(store.list().map((note) => note.id), [second.id]);
  const tombstones = store.exportTombstones();
  assert.equal(tombstones.length, 1);
  assert.equal(tombstones[0].id, first.id);
  assert.ok(Number.isFinite(Date.parse(tombstones[0].deletedAt)));
  assert.deepEqual(await readEnvelope(notesDirectory, first.id), {
    schemaVersion: NOTES_SCHEMA_VERSION,
    tombstone: tombstones[0],
  });
  assert.deepEqual(await noteFileNames(notesDirectory), fileNamesBefore);
  assert.equal(await fs.readFile(noteFilePath(notesDirectory, second.id), 'utf8'), secondBefore);

  tombstones[0].id = 'mutated';
  const reloaded = new NotesStore(notesDirectory);
  await reloaded.load();
  assert.deepEqual(reloaded.list().map((note) => note.id), [second.id]);
  assert.equal(reloaded.exportTombstones()[0].id, first.id);
});

test('NotesStore staged replacement persists active Notes and tombstones and detaches caller data', async (t) => {
  const { directory, notesDirectory, store } = await createStore(t);
  const local = await store.create();
  await store.delete(local.id);
  const replacement = {
    schemaVersion: NOTES_SCHEMA_VERSION,
    notes: [
      storedNote({ id: 'z-cloud', name: '  Shared SQL  ', language: 'sql', content: 'SELECT id FROM users;' }),
      storedNote({ id: 'a-cloud', name: 'First cloud Note' }),
    ],
  };
  const tombstones = [{ id: 'deleted-cloud', deletedAt: '2026-07-19T01:02:03Z' }];

  await store.replaceSnapshot(replacement, tombstones);
  replacement.notes[0].name = 'mutated after apply';
  replacement.notes[0].tags.push('mutated');
  tombstones[0].id = 'mutated-after-apply';

  assert.deepEqual(store.list().map((note) => note.id), ['a-cloud', 'z-cloud']);
  assert.equal(store.list()[1].name, 'Shared SQL');
  assert.deepEqual(store.exportTombstones(), [{
    id: 'deleted-cloud',
    deletedAt: '2026-07-19T01:02:03.000Z',
  }]);
  assert.deepEqual(await noteFileNames(notesDirectory), [
    noteFileName('a-cloud'),
    noteFileName('deleted-cloud'),
    noteFileName('z-cloud'),
  ].sort());
  await assertPathMissing(path.join(directory, '.notes.next'));
  await assertPathMissing(path.join(directory, '.notes.previous'));

  const reloaded = new NotesStore(notesDirectory);
  await reloaded.load();
  assert.deepEqual(reloaded.list(), store.list());
  assert.deepEqual(reloaded.exportTombstones(), store.exportTombstones());
});

test('NotesStore staged replacement hard-links unchanged Note files instead of rewriting their bodies', async (t) => {
  const { notesDirectory, store } = await createStore(t);
  const first = await store.create();
  const second = await store.create();
  const before = await fs.stat(noteFilePath(notesDirectory, first.id));
  const snapshots = new Map(store.list().map((note) => [note.id, note]));
  const firstSnapshot = snapshots.get(first.id);
  const secondSnapshot = snapshots.get(second.id);

  await store.replaceSnapshot({
    schemaVersion: NOTES_SCHEMA_VERSION,
    notes: [
      firstSnapshot,
      {
        ...secondSnapshot,
        content: 'changed in cloud',
        updatedAt: '2026-07-19T03:04:05.000Z',
      },
    ],
  }, []);

  assert.equal(store.list().find((note) => note.id === second.id).content, 'changed in cloud');
  if (process.platform !== 'win32' && before.ino !== 0) {
    const after = await fs.stat(noteFilePath(notesDirectory, first.id));
    assert.equal(after.ino, before.ino, 'the unchanged Note should retain its existing inode');
  }
});

test('NotesStore verifies a reused hard link and rewrites disk content that drifted from memory', async (t) => {
  const { notesDirectory, store } = await createStore(t);
  const created = await store.create();
  const expected = store.exportSnapshot();
  const drifted = { ...created, content: 'changed by another process' };
  await fs.writeFile(
    noteFilePath(notesDirectory, created.id),
    JSON.stringify({ schemaVersion: NOTES_SCHEMA_VERSION, note: drifted }),
    { mode: 0o600 },
  );

  await store.replaceSnapshot(expected, []);

  assert.equal(store.list()[0].content, '');
  assert.equal((await readEnvelope(notesDirectory, created.id)).note.content, '');
  const reloaded = new NotesStore(notesDirectory);
  await reloaded.load();
  assert.deepEqual(reloaded.exportSnapshot(), expected);
});

test('NotesStore rejects invalid replacement Notes or tombstones without partially applying them', async (t) => {
  const { notesDirectory, store } = await createStore(t);
  const created = await store.create();
  await store.update(created.id, draft({ content: 'keep this local value' }));
  const beforeNotes = store.exportSnapshot();
  const beforeTombstones = store.exportTombstones();
  const beforeFiles = await directoryFileSnapshot(notesDirectory);

  const invalidReplacements = [
    [{ schemaVersion: NOTES_SCHEMA_VERSION, notes: [storedNote({ language: 'python' })] }],
    [{ schemaVersion: NOTES_SCHEMA_VERSION, notes: [storedNote(), storedNote({ name: 'duplicate ID' })] }],
    [{ schemaVersion: NOTES_SCHEMA_VERSION, notes: [storedNote(), null] }],
    [{ schemaVersion: NOTES_SCHEMA_VERSION, notes: [storedNote()] }, [
      { id: 'synced-note', deletedAt: '2026-07-19T01:02:03Z' },
    ]],
    [{ schemaVersion: NOTES_SCHEMA_VERSION, notes: [] }, [
      { id: 'bad-timestamp', deletedAt: 'not-a-date' },
    ]],
  ];

  for (const [snapshot, tombstones] of invalidReplacements) {
    await assert.rejects(async () => store.replaceSnapshot(snapshot, tombstones));
    assert.deepEqual(store.exportSnapshot(), beforeNotes);
    assert.deepEqual(store.exportTombstones(), beforeTombstones);
    assert.deepEqual(await directoryFileSnapshot(notesDirectory), beforeFiles);
  }
});

test('NotesStore restores the previous directory when staged replacement promotion fails', async (t) => {
  const { directory, notesDirectory, store } = await createStore(t);
  const created = await store.create();
  await store.update(created.id, draft({ content: 'original durable content' }));
  const beforeNotes = store.exportSnapshot();
  const beforeTombstones = store.exportTombstones();
  const beforeFiles = await directoryFileSnapshot(notesDirectory);
  const originalRename = fs.rename;
  const nextDirectory = path.join(directory, '.notes.next');
  let injectedFailure = false;

  fs.rename = async (source, destination) => {
    if (!injectedFailure
      && path.resolve(String(source)) === path.resolve(nextDirectory)
      && path.resolve(String(destination)) === path.resolve(notesDirectory)) {
      injectedFailure = true;
      throw new Error('simulated Notes directory promotion failure');
    }
    return originalRename(source, destination);
  };
  try {
    await assert.rejects(
      store.replaceSnapshot(
        { schemaVersion: NOTES_SCHEMA_VERSION, notes: [storedNote()] },
        [{ id: 'cloud-deleted', deletedAt: '2026-07-19T01:02:03Z' }],
      ),
      /simulated Notes directory promotion failure/,
    );
  } finally {
    fs.rename = originalRename;
  }

  assert.equal(injectedFailure, true);
  assert.deepEqual(store.exportSnapshot(), beforeNotes);
  assert.deepEqual(store.exportTombstones(), beforeTombstones);
  assert.deepEqual(await directoryFileSnapshot(notesDirectory), beforeFiles);
  await assertPathMissing(path.join(directory, '.notes.next'));
  await assertPathMissing(path.join(directory, '.notes.previous'));
  const reloaded = new NotesStore(notesDirectory);
  await reloaded.load();
  assert.deepEqual(reloaded.exportSnapshot(), beforeNotes);
});

test('NotesStore recovers interrupted directory swaps without exposing a partial staged set', async (t) => {
  const { directory, notesDirectory, store } = await createStore(t);
  const canonical = await store.create();
  const nextDirectory = path.join(directory, '.notes.next');
  const previousDirectory = path.join(directory, '.notes.previous');

  await fs.cp(notesDirectory, nextDirectory, { recursive: true });
  await fs.rename(notesDirectory, previousDirectory);
  const restoredPrevious = new NotesStore(notesDirectory);
  await restoredPrevious.load();
  assert.deepEqual(restoredPrevious.list().map((note) => note.id), [canonical.id]);
  await assertPathMissing(previousDirectory);
  await assertPathMissing(nextDirectory);

  await fs.cp(notesDirectory, previousDirectory, { recursive: true });
  await fs.cp(notesDirectory, nextDirectory, { recursive: true });
  const currentOnly = await restoredPrevious.create();
  const canonicalWins = new NotesStore(notesDirectory);
  await canonicalWins.load();
  assert.deepEqual(canonicalWins.list().map((note) => note.id).sort(), [canonical.id, currentOnly.id].sort());
  await assertPathMissing(previousDirectory);
  await assertPathMissing(nextDirectory);

  await fs.rename(notesDirectory, nextDirectory);
  await assert.rejects(
    new NotesStore(notesDirectory).load(),
    /staged Notes replacement is incomplete/,
  );
  await writeReplacementCompleteFile(nextDirectory);
  const promotedNext = new NotesStore(notesDirectory);
  await promotedNext.load();
  assert.deepEqual(promotedNext.list(), canonicalWins.list());
  await assertPathMissing(nextDirectory);
});

test('NotesStore validates canonical before removing previous and restores a valid previous directory', async (t) => {
  const { directory, notesDirectory, store } = await createStore(t);
  const created = await store.create();
  const expected = store.exportSnapshot();
  const previousDirectory = path.join(directory, '.notes.previous');
  await fs.cp(notesDirectory, previousDirectory, { recursive: true });
  await fs.writeFile(noteFilePath(notesDirectory, created.id), '{invalid json');

  const recovered = new NotesStore(notesDirectory);
  await recovered.load();

  assert.deepEqual(recovered.exportSnapshot(), expected);
  assert.deepEqual((await readEnvelope(notesDirectory, created.id)).note, created);
  await assertPathMissing(previousDirectory);
  assert.ok(
    (await fs.readdir(directory)).some((name) => /^\.notes\.invalid\.\d+\./.test(name)),
    'the invalid promoted directory should be retained for manual recovery',
  );
});

test('NotesStore loads valid canonical data when stale previous cleanup is temporarily blocked', async (t) => {
  const { directory, notesDirectory, store } = await createStore(t);
  const created = await store.create();
  const previousDirectory = path.join(directory, '.notes.previous');
  await fs.cp(notesDirectory, previousDirectory, { recursive: true });
  const originalRm = fs.rm;
  let blocked = false;
  fs.rm = async (candidate, options) => {
    if (path.resolve(String(candidate)) === path.resolve(previousDirectory)) {
      blocked = true;
      const error = new Error('simulated Windows directory lock');
      error.code = 'EBUSY';
      throw error;
    }
    return originalRm(candidate, options);
  };
  let reloaded;
  try {
    reloaded = new NotesStore(notesDirectory);
    await reloaded.load();
  } finally {
    fs.rm = originalRm;
  }

  assert.equal(blocked, true);
  assert.deepEqual(reloaded.list(), [created]);
  assert.equal((await fs.lstat(previousDirectory)).isDirectory(), true);
});

test('NotesStore hashes unsafe IDs into bounded paths and rejects corrupt recognized Note files', async (t) => {
  const { directory, notesDirectory, store } = await createStore(t);
  const unsafeId = '../../CON / unsafe:name 中文';
  const note = storedNote({ id: unsafeId, name: 'Unsafe identifier stays data' });
  await store.replaceSnapshot({ schemaVersion: NOTES_SCHEMA_VERSION, notes: [note] });

  const expectedName = noteFileName(unsafeId);
  assert.match(expectedName, /^[a-f0-9]{64}\.json$/);
  assert.deepEqual(await noteFileNames(notesDirectory), [expectedName]);
  assert.equal(path.dirname(noteFilePath(notesDirectory, unsafeId)), notesDirectory);
  assert.deepEqual((await readEnvelope(notesDirectory, unsafeId)).note, note);
  assert.deepEqual((await fs.readdir(directory)).sort(), ['notes']);

  const corruptName = `${'f'.repeat(64)}.json`;
  await fs.writeFile(path.join(notesDirectory, corruptName), '{not valid json');
  await assert.rejects(
    new NotesStore(notesDirectory).load(),
    new RegExp(`Stored Note file ${corruptName} is invalid`),
  );
  assert.deepEqual(store.list(), [note]);
});

test('NotesStore rejects symlinked storage paths and recognized Note files', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'service-manager-notes-symlink-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const realDirectory = path.join(directory, 'real-notes');
  const notesDirectory = path.join(directory, 'notes');
  await fs.mkdir(realDirectory);
  try {
    await fs.symlink(realDirectory, notesDirectory, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (error && (error.code === 'EPERM' || error.code === 'EACCES')) {
      t.skip('Creating directory links is not permitted on this host.');
      return;
    }
    throw error;
  }
  await assert.rejects(new NotesStore(notesDirectory).load(), /must be a real directory/);

  await fs.unlink(notesDirectory);
  await fs.mkdir(notesDirectory);
  const linkedId = 'linked-note';
  const target = path.join(directory, 'outside-note.json');
  await fs.writeFile(target, JSON.stringify({
    schemaVersion: NOTES_SCHEMA_VERSION,
    note: storedNote({ id: linkedId }),
  }));
  try {
    await fs.symlink(target, noteFilePath(notesDirectory, linkedId), 'file');
  } catch (error) {
    if (error && (error.code === 'EPERM' || error.code === 'EACCES')) {
      t.skip('Creating file links is not permitted on this host.');
      return;
    }
    throw error;
  }
  await assert.rejects(new NotesStore(notesDirectory).load(), /Stored Note file .* is invalid/);
});

test('NotesStore bounds a recognized Note file before reading its JSON payload', async (t) => {
  const { notesDirectory } = await createStore(t);
  const oversizedId = 'oversized-note';
  await fs.writeFile(
    noteFilePath(notesDirectory, oversizedId),
    Buffer.alloc(8 * 1024 * 1024 + 1, 0x20),
  );

  await assert.rejects(
    new NotesStore(notesDirectory).load(),
    /Stored Note file .* is invalid/,
  );
});

test('NotesStore rejects symlinked staged and previous replacement directories', async (t) => {
  const { directory, notesDirectory, store } = await createStore(t);
  await store.create();
  const outside = path.join(directory, 'outside');
  await fs.mkdir(outside);
  const previousDirectory = path.join(directory, '.notes.previous');
  try {
    await fs.symlink(outside, previousDirectory, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (error && (error.code === 'EPERM' || error.code === 'EACCES')) {
      t.skip('Creating directory links is not permitted on this host.');
      return;
    }
    throw error;
  }
  await assert.rejects(new NotesStore(notesDirectory).load(), /must be a real directory/);

  await fs.unlink(previousDirectory);
  const nextDirectory = path.join(directory, '.notes.next');
  await fs.symlink(outside, nextDirectory, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(new NotesStore(notesDirectory).load(), /must be a real directory/);
});
