const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  NOTE_LIMITS,
  NOTES_SCHEMA_VERSION,
  NotesStore,
  classifyNoteDraftRecovery,
  rankNoteIdsForSearch,
} = require('../dist/main/notesStore');
const { EMPTY_RICH_TEXT_CONTENT, normalizeRichTextContent } = require('../dist/shared/noteRichText');

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

test('late Note draft recovery updates only an unchanged base and preserves cloud divergence', () => {
  const base = {
    id: 'note-1',
    ...draft({ content: 'base' }),
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const lateDraft = draft({ content: 'late local edit' });
  const alreadySaved = { ...base, ...lateDraft, updatedAt: '2026-01-01T00:00:01.000Z' };
  const cloud = { ...base, content: 'cloud edit', updatedAt: '2026-01-01T00:00:02.000Z' };

  assert.equal(classifyNoteDraftRecovery(base, base, lateDraft), 'update');
  assert.equal(classifyNoteDraftRecovery(alreadySaved, base, lateDraft), 'already-saved');
  assert.equal(classifyNoteDraftRecovery(cloud, base, lateDraft), 'conflict');
  assert.equal(classifyNoteDraftRecovery(undefined, base, lateDraft), 'conflict');
});

test('main-process Note search preserves name, metadata, content, and Rich Text ranking', () => {
  const timestamp = '2026-01-01T00:00:00.000Z';
  const notes = [
    storedNote({ id: 'content', name: 'Runbook', content: 'deploy api server' }),
    storedNote({ id: 'tag', name: 'Operations', content: '', tags: ['api'] }),
    storedNote({ id: 'prefix', name: 'API examples', content: '' }),
    storedNote({
      id: 'rich',
      name: 'Formatted',
      language: 'richtext',
      content: normalizeRichTextContent({
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'api body' }] }],
      }),
    }),
  ].map((note) => ({ ...note, createdAt: timestamp, updatedAt: timestamp }));

  assert.deepEqual(rankNoteIdsForSearch(notes, ' api '), ['prefix', 'tag', 'content', 'rich']);
  assert.deepEqual(rankNoteIdsForSearch(notes, 'unrelated'), []);
});

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
  assert.equal(note.content, EMPTY_RICH_TEXT_CONTENT);
  assert.equal(note.language, 'richtext');
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
  const internalNotes = store.notes;
  const internalFirst = internalNotes.find((note) => note.id === first.id);
  const internalSecond = internalNotes.find((note) => note.id === second.id);
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
  assert.equal(store.notes, internalNotes);
  assert.notEqual(store.notes.find((note) => note.id === first.id), internalFirst);
  assert.equal(store.notes.find((note) => note.id === second.id), internalSecond);

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

test('NotesStore compare-and-update checks the base inside the serialized mutation queue', async (t) => {
  const { notesDirectory, store } = await createStore(t);
  const note = await store.create();
  const expected = store.get(note.id);

  const precedingUpdate = store.update(note.id, draft({ content: 'preceding update' }));
  const staleUpdate = store.compareAndUpdate(
    note.id,
    expected,
    draft({ content: 'must not overwrite the preceding update' }),
  );

  const persisted = await precedingUpdate;
  await assert.rejects(staleUpdate, /This Note changed after the editor loaded it/);
  assert.equal(store.get(note.id).content, 'preceding update');
  assert.deepEqual((await readEnvelope(notesDirectory, note.id)).note, persisted);

  const current = store.get(note.id);
  const comparedPromise = store.compareAndUpdate(
    note.id,
    current,
    draft({ content: 'atomic compared update', tags: ['detached'] }),
  );
  current.content = 'mutated after the call';
  current.tags.push('mutated');
  const compared = await comparedPromise;
  compared.tags.push('mutated');
  assert.equal(store.get(note.id).content, 'atomic compared update');
  assert.deepEqual(store.get(note.id).tags, ['detached']);
});

test('NotesStore canonicalizes rich text and rejects unsafe rich text nodes before persistence', async (t) => {
  const { notesDirectory, store } = await createStore(t);
  const note = await store.create();
  const input = JSON.stringify({
    content: [{
      content: [{ marks: [{ type: 'italic' }, { type: 'bold' }], text: 'Hello', type: 'text' }],
      type: 'paragraph',
    }],
    type: 'doc',
  }, null, 2);
  const updated = await store.update(note.id, draft({ language: 'richtext', content: input }));

  assert.equal(updated.language, 'richtext');
  assert.equal(updated.content, '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","marks":[{"type":"bold"},{"type":"italic"}],"text":"Hello"}]}]}');
  assert.equal((await readEnvelope(notesDirectory, note.id)).note.content, updated.content);
  await assert.rejects(
    store.update(note.id, draft({
      language: 'richtext',
      content: JSON.stringify({ type: 'doc', content: [{ type: 'html', text: '<script />' }] }),
    })),
    /node is not supported/,
  );
  assert.equal((await readEnvelope(notesDirectory, note.id)).note.content, updated.content);
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

test('NotesStore batch delete rewrites only requested envelopes and leaves unrelated Notes untouched', async (t) => {
  const { directory, notesDirectory, store } = await createStore(t);
  const first = await store.create();
  const second = await store.create();
  const retained = await store.create();
  const retainedPath = noteFilePath(notesDirectory, retained.id);
  const retainedBefore = await fs.readFile(retainedPath, 'utf8');
  const retainedMetadataBefore = await fs.stat(retainedPath);
  const originalLink = fs.link;
  let linkCalls = 0;
  fs.link = async (...args) => {
    linkCalls += 1;
    return originalLink(...args);
  };
  t.after(() => {
    fs.link = originalLink;
  });

  const deletedIds = await store.deleteMany([second.id, first.id, second.id]);
  await store.flush();

  assert.deepEqual(new Set(deletedIds), new Set([first.id, second.id]));
  assert.deepEqual(store.list().map((note) => note.id), [retained.id]);
  const tombstones = store.exportTombstones();
  assert.deepEqual(new Set(tombstones.map((item) => item.id)), new Set([first.id, second.id]));
  assert.equal(new Set(tombstones.map((item) => item.deletedAt)).size, 1);
  assert.ok((await readEnvelope(notesDirectory, first.id)).tombstone);
  assert.ok((await readEnvelope(notesDirectory, second.id)).tombstone);
  assert.equal(await fs.readFile(retainedPath, 'utf8'), retainedBefore);
  assert.equal((await fs.stat(retainedPath)).ino, retainedMetadataBefore.ino);
  assert.equal((await fs.stat(retainedPath)).mtimeMs, retainedMetadataBefore.mtimeMs);
  assert.equal(linkCalls, 0);
  await assertPathMissing(path.join(directory, '.notes.next'));
  await assertPathMissing(path.join(directory, '.notes.previous'));
  assert.equal(store.get(retained.id).id, retained.id);
  const detached = store.get(retained.id);
  detached.name = 'mutated';
  assert.equal(store.get(retained.id).name, retained.name);

  const reloaded = new NotesStore(notesDirectory);
  await reloaded.load();
  assert.deepEqual(reloaded.list().map((note) => note.id), [retained.id]);
});

test('NotesStore batch delete restores every target when a later tombstone write fails after rename', async (t) => {
  const { notesDirectory, store } = await createStore(t);
  const first = await store.create();
  const second = await store.create();
  const retained = await store.create();
  const before = await directoryFileSnapshot(notesDirectory);
  const sortedTargets = [first.id, second.id].sort();
  const failingDestination = path.resolve(noteFilePath(notesDirectory, sortedTargets[1]));
  const originalRename = fs.rename;
  let injectedFailure = false;

  fs.rename = async (source, destination) => {
    if (!injectedFailure && path.resolve(String(destination)) === failingDestination) {
      await originalRename(source, destination);
      injectedFailure = true;
      throw new Error('injected post-rename failure');
    }
    return originalRename(source, destination);
  };
  t.after(() => {
    fs.rename = originalRename;
  });

  await assert.rejects(
    store.deleteMany([first.id, second.id]),
    /injected post-rename failure/,
  );
  assert.equal(injectedFailure, true);
  assert.deepEqual(new Set(store.list().map((note) => note.id)), new Set([first.id, second.id, retained.id]));
  assert.deepEqual(store.exportTombstones(), []);
  assert.deepEqual(await directoryFileSnapshot(notesDirectory), before);
  assert.equal((await fs.readdir(notesDirectory)).some((name) => name.endsWith('.tmp')), false);

  const reloaded = new NotesStore(notesDirectory);
  await reloaded.load();
  assert.deepEqual(new Set(reloaded.list().map((note) => note.id)), new Set([first.id, second.id, retained.id]));
  assert.deepEqual(reloaded.exportTombstones(), []);
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

test('NotesStore incremental replacement leaves unchanged Note files untouched', async (t) => {
  const { directory, notesDirectory, store } = await createStore(t);
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
        content: normalizeRichTextContent({
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'changed in cloud' }] }],
        }),
        updatedAt: '2026-07-19T03:04:05.000Z',
      },
    ],
  }, []);

  assert.equal(
    store.list().find((note) => note.id === second.id).content,
    normalizeRichTextContent({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'changed in cloud' }] }],
    }),
  );
  if (process.platform !== 'win32' && before.ino !== 0) {
    const after = await fs.stat(noteFilePath(notesDirectory, first.id));
    assert.equal(after.ino, before.ino, 'the unchanged Note should retain its existing inode');
  }
  await assertPathMissing(path.join(directory, '.notes.apply'));
});

test('NotesStore copies only a changed staged envelope when hard links are unavailable', async (t) => {
  const { directory, notesDirectory, store } = await createStore(t);
  const created = await store.create();
  const replacement = {
    schemaVersion: NOTES_SCHEMA_VERSION,
    notes: [{
      ...created,
      content: normalizeRichTextContent({
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'copied change' }] }],
      }),
      updatedAt: '2026-07-29T03:04:05.000Z',
    }],
  };
  const originalLink = fs.link;
  let linkCalls = 0;
  fs.link = async () => {
    linkCalls += 1;
    const error = new Error('hard links are unavailable');
    error.code = 'EOPNOTSUPP';
    throw error;
  };
  try {
    await store.replaceSnapshot(replacement, []);
  } finally {
    fs.link = originalLink;
  }

  assert.equal(linkCalls, 1);
  assert.equal(store.get(created.id).content, replacement.notes[0].content);
  const reloaded = new NotesStore(notesDirectory);
  await reloaded.load();
  assert.deepEqual(reloaded.exportSnapshot(), replacement);
  await assertPathMissing(path.join(directory, '.notes.apply'));
});

test('NotesStore does not scan or rewrite an unchanged envelope during incremental apply', async (t) => {
  const { notesDirectory, store } = await createStore(t);
  const created = await store.create();
  const expected = store.exportSnapshot();
  const drifted = {
    ...created,
    content: normalizeRichTextContent({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'changed by another process' }] }],
    }),
  };
  await fs.writeFile(
    noteFilePath(notesDirectory, created.id),
    JSON.stringify({ schemaVersion: NOTES_SCHEMA_VERSION, note: drifted }),
    { mode: 0o600 },
  );

  await store.replaceSnapshot(expected, []);

  assert.equal(store.list()[0].content, EMPTY_RICH_TEXT_CONTENT);
  assert.equal((await readEnvelope(notesDirectory, created.id)).note.content, drifted.content);
  const reloaded = new NotesStore(notesDirectory);
  await reloaded.load();
  assert.equal(reloaded.get(created.id).content, drifted.content);
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

test('NotesStore resumes a committed incremental apply after a target install failure', async (t) => {
  const { directory, notesDirectory, store } = await createStore(t);
  const created = await store.create();
  await store.update(created.id, draft({ content: 'original durable content' }));
  const beforeNotes = store.exportSnapshot();
  const beforeTombstones = store.exportTombstones();
  const originalRename = fs.rename;
  let injectedFailure = false;

  fs.rename = async (source, destination) => {
    if (!injectedFailure
      && path.dirname(path.resolve(String(source))) === path.resolve(notesDirectory)
      && path.dirname(path.resolve(String(destination))) === path.resolve(notesDirectory)
      && /^[a-f0-9]{64}\.json$/.test(path.basename(String(destination)))) {
      injectedFailure = true;
      throw new Error('simulated incremental Note install failure');
    }
    return originalRename(source, destination);
  };
  const replacement = { schemaVersion: NOTES_SCHEMA_VERSION, notes: [storedNote()] };
  const tombstones = [{ id: 'cloud-deleted', deletedAt: '2026-07-19T01:02:03Z' }];
  try {
    await assert.rejects(
      store.replaceSnapshot(replacement, tombstones),
      /simulated incremental Note install failure/,
    );
  } finally {
    fs.rename = originalRename;
  }

  assert.equal(injectedFailure, true);
  assert.deepEqual(store.exportSnapshot(), beforeNotes);
  assert.deepEqual(store.exportTombstones(), beforeTombstones);
  assert.equal((await fs.lstat(path.join(directory, '.notes.apply'))).isDirectory(), true);
  const reloaded = new NotesStore(notesDirectory);
  await reloaded.load();
  assert.deepEqual(reloaded.exportSnapshot(), replacement);
  assert.deepEqual(reloaded.exportTombstones(), [{
    id: 'cloud-deleted',
    deletedAt: '2026-07-19T01:02:03.000Z',
  }]);
  await assertPathMissing(path.join(directory, '.notes.apply'));
});

test('NotesStore discards incremental staging that never committed a manifest', async (t) => {
  const { directory, notesDirectory, store } = await createStore(t);
  const created = await store.create();
  const staging = path.join(directory, '.notes.apply');
  await fs.mkdir(staging, { mode: 0o700 });
  await fs.writeFile(
    noteFilePath(staging, 'uncommitted'),
    JSON.stringify({ schemaVersion: NOTES_SCHEMA_VERSION, note: storedNote({ id: 'uncommitted' }) }),
    { mode: 0o600 },
  );

  const reloaded = new NotesStore(notesDirectory);
  await reloaded.load();

  assert.deepEqual(reloaded.list().map((note) => note.id), [created.id]);
  await assertPathMissing(staging);
});

test('NotesStore rejects a symlinked incremental apply directory', async (t) => {
  if (process.platform === 'win32') {
    t.skip('directory symlink permissions vary on Windows');
    return;
  }
  const { directory, notesDirectory, store } = await createStore(t);
  await store.create();
  const target = path.join(directory, 'staging-target');
  await fs.mkdir(target, { mode: 0o700 });
  await fs.symlink(target, path.join(directory, '.notes.apply'), 'dir');

  const reloaded = new NotesStore(notesDirectory);
  await assert.rejects(reloaded.load(), /must be a real directory/);
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
