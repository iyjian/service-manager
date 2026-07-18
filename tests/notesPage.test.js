const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const distRenderer = path.join(root, 'dist', 'renderer');

function note(overrides) {
  return {
    id: overrides.id,
    name: overrides.name ?? 'Untitled',
    content: overrides.content ?? '',
    language: overrides.language ?? 'markdown',
    tags: overrides.tags ?? [],
    createdAt: overrides.createdAt ?? '2026-01-01T00:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-01-01T00:00:00.000Z',
  };
}

test('Notes search ranks name matches ahead of global metadata and content matches', async () => {
  const { rankNotes } = await import(path.join(distRenderer, 'notesPage.js'));
  const notes = [
    note({ id: 'content', name: 'Runbook', content: 'deploy api server' }),
    note({ id: 'tag', name: 'Operations', tags: ['api'] }),
    note({ id: 'name-contains', name: 'Internal API client' }),
    note({ id: 'name-prefix', name: 'API examples' }),
    note({ id: 'name-exact', name: 'api' }),
  ];

  assert.deepEqual(
    rankNotes(notes, ' API ').map(({ id }) => id),
    ['name-exact', 'name-prefix', 'name-contains', 'tag', 'content'],
  );
});

test('Notes search includes lower-priority language matches and drops unrelated notes', async () => {
  const { rankNotes } = await import(path.join(distRenderer, 'notesPage.js'));
  const notes = [
    note({ id: 'language', name: 'Typed helper', language: 'typescript' }),
    note({ id: 'content', name: 'Compiler note', content: 'typescript narrowing' }),
    note({ id: 'unrelated', name: 'Shell aliases', language: 'bash' }),
  ];

  assert.deepEqual(rankNotes(notes, 'typescript').map(({ id }) => id), ['language', 'content']);
});

test('Notes empty search sorts by updated time descending and stays stable for ties', async () => {
  const { rankNotes } = await import(path.join(distRenderer, 'notesPage.js'));
  const notes = [
    note({ id: 'old', updatedAt: '2026-01-01T00:00:00.000Z' }),
    note({ id: 'new-a', updatedAt: '2026-03-01T00:00:00.000Z' }),
    note({ id: 'new-b', updatedAt: '2026-03-01T00:00:00.000Z' }),
  ];

  assert.deepEqual(rankNotes(notes, '  ').map(({ id }) => id), ['new-a', 'new-b', 'old']);
  assert.deepEqual(notes.map(({ id }) => id), ['old', 'new-a', 'new-b']);
});

test('Notes page wires CRUD, copy, confirmation, and debounced flushes without unsafe dynamic HTML', async () => {
  const source = await readFile(path.join(root, 'src', 'renderer', 'notesPage.ts'), 'utf8');

  assert.match(source, /registerPage\(\{\s*id: 'notes'/);
  assert.match(source, /window\.notesApi\.listNotes\(\)/);
  assert.match(source, /window\.notesApi\.createNote\(\)/);
  assert.match(source, /window\.notesApi\.updateNote\(id, draft\)/);
  assert.match(source, /window\.notesApi\.deleteNote\(note\.id\)/);
  assert.match(source, /window\.serviceApi\.writeClipboardText\(note\.content\)/);
  assert.match(source, /window\.serviceApi\.confirmAction\(\{/);
  assert.match(source, /NOTE_SAVE_DEBOUNCE_MS = 250/);
  assert.match(source, /setTimeout\([\s\S]*NOTE_SAVE_DEBOUNCE_MS/);
  assert.match(source, /hide\(\): void \{\s*void this\.flushAllPendingSaves\(\)\.catch\(\(\) => undefined\);/);
  assert.match(source, /if \(this\.selectedId\) void this\.flushNote\(this\.selectedId\);/);
  assert.match(source, /this\.notes\.some\(\(note\) => !this\.deletedIds\.has\(note\.id\) && this\.isDirty\(note\.id\)\)/);
  assert.match(source, /throw new Error\('Some notes could not be saved\. Fix the save error before syncing\.'\)/);
  assert.match(source, /const restoreFocusId = focusId \?\? activeItem\?\.dataset\.noteId/);
  assert.match(source, /if \(!this\.selectedId\) this\.newButton\.focus\(\)/);
  assert.match(source, /window\.notesApi\.onFlushRequested\(\(\) => page\?\.flush\(\) \?\? Promise\.resolve\(\)\)/);
  assert.match(source, /name\.textContent = note\.name \|\| 'Untitled'/);
  assert.match(source, /this\.saveStatus\.textContent = text/);
  assert.doesNotMatch(source, /\.innerHTML\s*=/);
});

test('Notes page keeps user content in form values and list nodes created through DOM APIs', async () => {
  const source = await readFile(path.join(root, 'src', 'renderer', 'notesPage.ts'), 'utf8');

  assert.match(source, /document\.createElement\('button'\)/);
  assert.match(source, /document\.createElement\('span'\)/);
  assert.match(source, /this\.nameInput\.value = note\.name/);
  assert.match(source, /this\.contentInput\.value = note\.content/);
  assert.match(source, /note\.content = this\.contentInput\.value/);
  assert.match(source, /note\.tags = normalizeTags\(this\.tagsInput\.value\)/);
});
