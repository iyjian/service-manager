const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { NOTE_LIMITS, NOTES_SCHEMA_VERSION, NotesStore } = require('../dist/main/notesStore');

async function createStore(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'service-manager-notes-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'notes.json');
  const store = new NotesStore(filePath);
  await store.load();
  return { directory, filePath, store };
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

test('NotesStore creates a private versioned notes file and a default Markdown note', async (t) => {
  const { filePath, store } = await createStore(t);
  const note = await store.create();

  assert.equal(note.name, 'Untitled note');
  assert.equal(note.content, '');
  assert.equal(note.language, 'markdown');
  assert.deepEqual(note.tags, []);
  assert.ok(note.id);
  assert.equal(note.createdAt, note.updatedAt);

  const persisted = JSON.parse(await fs.readFile(filePath, 'utf8'));
  assert.equal(persisted.schemaVersion, NOTES_SCHEMA_VERSION);
  assert.deepEqual(persisted.notes, [note]);
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(filePath)).mode & 0o777, 0o600);
  }
});

test('NotesStore updates normalized note fields, clones returns, and exports a detached snapshot', async (t) => {
  const { store } = await createStore(t);
  const created = await store.create();
  const updated = await store.update(created.id, draft({
    name: '  Deploy API  ',
    tags: [' production ', '', 'Release', 'release'],
  }));

  assert.equal(updated.name, 'Deploy API');
  assert.equal(updated.content, 'pnpm deploy');
  assert.equal(updated.language, 'bash');
  assert.deepEqual(updated.tags, ['production', 'Release']);
  assert.equal(updated.createdAt, created.createdAt);

  updated.name = 'mutated';
  updated.tags.push('mutated');
  const listed = store.list();
  listed[0].content = 'mutated';
  listed[0].tags.length = 0;
  const snapshot = store.exportSnapshot();
  snapshot.notes[0].name = 'mutated again';

  assert.deepEqual(store.list(), [{
    ...updated,
    name: 'Deploy API',
    content: 'pnpm deploy',
    tags: ['production', 'Release'],
  }]);
  assert.equal(snapshot.schemaVersion, 1);
});

test('NotesStore normalizes persisted notes and ignores invalid and duplicate records', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'service-manager-notes-normalize-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'notes.json');
  await fs.writeFile(filePath, JSON.stringify({
    schemaVersion: 1,
    notes: [
      {
        id: 'note-1',
        name: '   ',
        content: '# note',
        language: 'markdown',
        tags: [' docs ', 'DOCS', ''],
        createdAt: '2026-07-18T01:02:03Z',
        updatedAt: '2026-07-18T01:02:04Z',
      },
      {
        id: 'note-1',
        name: 'duplicate',
        content: '',
        language: 'text',
        tags: [],
        createdAt: '2026-07-18T01:02:03Z',
        updatedAt: '2026-07-18T01:02:04Z',
      },
      { id: 'invalid', name: 'bad language', content: '', language: 'python', tags: [] },
      null,
    ],
  }));

  const store = new NotesStore(filePath);
  await store.load();

  assert.deepEqual(store.list(), [{
    id: 'note-1',
    name: 'Untitled note',
    content: '# note',
    language: 'markdown',
    tags: ['docs'],
    createdAt: '2026-07-18T01:02:03.000Z',
    updatedAt: '2026-07-18T01:02:04.000Z',
  }]);
});

test('NotesStore rejects unsupported drafts and bounded fields', async (t) => {
  const { store } = await createStore(t);
  const note = await store.create();

  await assert.rejects(store.update(note.id, draft({ language: 'python' })), /language is not supported/);
  await assert.rejects(store.update(note.id, draft({ content: 'x'.repeat(NOTE_LIMITS.contentCharacters + 1) })), /content must not exceed/);
  await assert.rejects(store.update(note.id, draft({ tags: ['valid', 3] })), /tags must contain only text/);
  await assert.rejects(store.update(note.id, draft({ tags: Array.from({ length: NOTE_LIMITS.tags + 1 }, (_, index) => `tag-${index}`) })), /must not have more than/);
  await assert.rejects(store.update('missing', draft()), /Note not found/);
});

test('NotesStore serializes concurrent updates so the last invocation wins on disk', async (t) => {
  const { filePath, store } = await createStore(t);
  const note = await store.create();

  const first = store.update(note.id, draft({ content: 'first' }));
  const second = store.update(note.id, draft({ content: 'second', language: 'typescript' }));
  const third = store.update(note.id, draft({ content: 'third', language: 'javascript' }));
  await Promise.all([first, second, third]);
  await store.flush();

  assert.equal(store.list()[0].content, 'third');
  assert.equal(store.list()[0].language, 'javascript');
  assert.equal(JSON.parse(await fs.readFile(filePath, 'utf8')).notes[0].content, 'third');
  assert.equal((await fs.readdir(path.dirname(filePath))).some((name) => name.endsWith('.tmp')), false);
});

test('NotesStore reloads persisted changes and deletes notes durably', async (t) => {
  const { filePath, store } = await createStore(t);
  const first = await store.create();
  const second = await store.create();
  await store.update(first.id, draft({ name: 'First', content: '# first', language: 'markdown' }));
  await store.flush();

  const reloaded = new NotesStore(filePath);
  await reloaded.load();
  assert.deepEqual(reloaded.list(), store.list());

  await reloaded.delete(first.id);
  await reloaded.delete('already-deleted');
  await reloaded.flush();
  assert.deepEqual(reloaded.list().map((note) => note.id), [second.id]);

  const finalReload = new NotesStore(filePath);
  await finalReload.load();
  assert.deepEqual(finalReload.list().map((note) => note.id), [second.id]);
});

test('NotesStore requires the versioned envelope', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'service-manager-notes-schema-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'notes.json');
  await fs.writeFile(filePath, JSON.stringify([]));

  await assert.rejects(new NotesStore(filePath).load(), /Unsupported notes file schema/);
});
