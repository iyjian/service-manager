const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  DEFAULT_NOTES_FONT_SIZE,
  DEFAULT_NOTES_SIDEBAR_WIDTH,
  MAX_NOTES_FONT_SIZE,
  MAX_NOTES_SIDEBAR_WIDTH,
  MIN_NOTES_FONT_SIZE,
  MIN_NOTES_SIDEBAR_WIDTH,
  UI_PREFERENCES_SCHEMA_VERSION,
  UiPreferencesStore,
  normalizeNotesSidebarWidth,
  normalizeUiPreferencesDraft,
} = require('../dist/main/uiPreferencesStore');

async function createStore(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'service-manager-ui-preferences-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'ui-preferences.json');
  const store = new UiPreferencesStore(filePath);
  return { directory, filePath, store };
}

test('UI preferences use stable Notes defaults when the file is missing', async (t) => {
  const { filePath, store } = await createStore(t);
  await store.load();

  assert.deepEqual(store.get(), {
    notesFontSize: DEFAULT_NOTES_FONT_SIZE,
    notesEditorTheme: 'light',
    notesSidebarWidth: DEFAULT_NOTES_SIDEBAR_WIDTH,
  });
  await assert.rejects(fs.stat(filePath), { code: 'ENOENT' });
});

test('Notes defaults to the running Novel editor font size', () => {
  assert.equal(DEFAULT_NOTES_FONT_SIZE, 18);
});

test('UI preferences persist atomically with a versioned private JSON shape', async (t) => {
  const { directory, filePath, store } = await createStore(t);
  await store.load();
  assert.deepEqual(
    await store.save({ notesFontSize: 17, notesEditorTheme: 'dark' }),
    {
      notesFontSize: 17,
      notesEditorTheme: 'dark',
      notesSidebarWidth: DEFAULT_NOTES_SIDEBAR_WIDTH,
    },
  );
  await store.flush();

  assert.deepEqual(JSON.parse(await fs.readFile(filePath, 'utf8')), {
    schemaVersion: UI_PREFERENCES_SCHEMA_VERSION,
    notes: {
      fontSize: 17,
      editorTheme: 'dark',
      sidebarWidth: DEFAULT_NOTES_SIDEBAR_WIDTH,
    },
  });
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(filePath)).mode & 0o777, 0o600);
  }
  assert.deepEqual(
    (await fs.readdir(directory)).filter((name) => name.endsWith('.tmp')),
    [],
  );

  const reloaded = new UiPreferencesStore(filePath);
  await reloaded.load();
  assert.deepEqual(reloaded.get(), {
    notesFontSize: 17,
    notesEditorTheme: 'dark',
    notesSidebarWidth: DEFAULT_NOTES_SIDEBAR_WIDTH,
  });
});

test('damaged UI preferences safely fall back and a default Save repairs the file', async (t) => {
  const { filePath, store } = await createStore(t);
  await fs.writeFile(filePath, '{not-json', 'utf8');
  await store.load();
  assert.deepEqual(store.get(), {
    notesFontSize: DEFAULT_NOTES_FONT_SIZE,
    notesEditorTheme: 'light',
    notesSidebarWidth: DEFAULT_NOTES_SIDEBAR_WIDTH,
  });

  await store.save({ notesFontSize: DEFAULT_NOTES_FONT_SIZE, notesEditorTheme: 'light' });
  assert.deepEqual(JSON.parse(await fs.readFile(filePath, 'utf8')), {
    schemaVersion: UI_PREFERENCES_SCHEMA_VERSION,
    notes: {
      fontSize: DEFAULT_NOTES_FONT_SIZE,
      editorTheme: 'light',
      sidebarWidth: DEFAULT_NOTES_SIDEBAR_WIDTH,
    },
  });
});

test('schema 1 UI preferences migrate to the default light Notes editor theme', async (t) => {
  const { filePath, store } = await createStore(t);
  await fs.writeFile(filePath, JSON.stringify({
    schemaVersion: 1,
    notes: { fontSize: 18 },
  }), 'utf8');

  await store.load();
  assert.deepEqual(store.get(), {
    notesFontSize: 18,
    notesEditorTheme: 'light',
    notesSidebarWidth: DEFAULT_NOTES_SIDEBAR_WIDTH,
  });
});

test('schema 2 UI preferences migrate to the default Notes sidebar width', async (t) => {
  const { filePath, store } = await createStore(t);
  await fs.writeFile(filePath, JSON.stringify({
    schemaVersion: 2,
    notes: { fontSize: 16, editorTheme: 'dark' },
  }), 'utf8');

  await store.load();
  assert.deepEqual(store.get(), {
    notesFontSize: 16,
    notesEditorTheme: 'dark',
    notesSidebarWidth: DEFAULT_NOTES_SIDEBAR_WIDTH,
  });
});

test('Notes font size validation accepts only bounded whole pixels', () => {
  assert.deepEqual(
    normalizeUiPreferencesDraft({ notesFontSize: MIN_NOTES_FONT_SIZE, notesEditorTheme: 'light' }),
    { notesFontSize: MIN_NOTES_FONT_SIZE, notesEditorTheme: 'light' },
  );
  assert.deepEqual(
    normalizeUiPreferencesDraft({ notesFontSize: MAX_NOTES_FONT_SIZE, notesEditorTheme: 'dark' }),
    { notesFontSize: MAX_NOTES_FONT_SIZE, notesEditorTheme: 'dark' },
  );

  for (const notesFontSize of [11, 12.5, 25, Number.NaN, '14', undefined]) {
    assert.throws(
      () => normalizeUiPreferencesDraft({ notesFontSize, notesEditorTheme: 'light' }),
      /Notes preferences are invalid\./,
    );
  }
  for (const notesEditorTheme of ['', 'system', undefined]) {
    assert.throws(
      () => normalizeUiPreferencesDraft({ notesFontSize: 14, notesEditorTheme }),
      /Notes preferences are invalid\./,
    );
  }
  assert.throws(() => normalizeUiPreferencesDraft(null), /Notes preferences/);
});

test('Notes sidebar width accepts only bounded whole pixels', () => {
  assert.equal(normalizeNotesSidebarWidth(MIN_NOTES_SIDEBAR_WIDTH), MIN_NOTES_SIDEBAR_WIDTH);
  assert.equal(normalizeNotesSidebarWidth(MAX_NOTES_SIDEBAR_WIDTH), MAX_NOTES_SIDEBAR_WIDTH);

  for (const value of [
    MIN_NOTES_SIDEBAR_WIDTH - 1,
    MIN_NOTES_SIDEBAR_WIDTH + 0.5,
    MAX_NOTES_SIDEBAR_WIDTH + 1,
    Number.NaN,
    String(DEFAULT_NOTES_SIDEBAR_WIDTH),
    undefined,
  ]) {
    assert.throws(() => normalizeNotesSidebarWidth(value), /Notes sidebar width is invalid\./);
  }
});

test('sidebar and editor preference saves merge against the latest queued state', async (t) => {
  const { filePath, store } = await createStore(t);
  await store.load();

  await Promise.all([
    store.saveNotesSidebarWidth(420),
    store.save({ notesFontSize: 18, notesEditorTheme: 'dark' }),
  ]);
  assert.deepEqual(store.get(), {
    notesFontSize: 18,
    notesEditorTheme: 'dark',
    notesSidebarWidth: 420,
  });

  await Promise.all([
    store.save({ notesFontSize: 16, notesEditorTheme: 'light' }),
    store.saveNotesSidebarWidth(360),
  ]);
  assert.deepEqual(store.get(), {
    notesFontSize: 16,
    notesEditorTheme: 'light',
    notesSidebarWidth: 360,
  });

  const reloaded = new UiPreferencesStore(filePath);
  await reloaded.load();
  assert.deepEqual(reloaded.get(), store.get());
});

test('concurrent UI preference saves remain serialized in invocation order', async (t) => {
  const { filePath, store } = await createStore(t);
  await store.load();

  const results = await Promise.all([
    store.save({ notesFontSize: 16, notesEditorTheme: 'light' }),
    store.save({ notesFontSize: 18, notesEditorTheme: 'dark' }),
    store.save({ notesFontSize: 20, notesEditorTheme: 'light' }),
  ]);

  assert.deepEqual(results, [
    {
      notesFontSize: 16,
      notesEditorTheme: 'light',
      notesSidebarWidth: DEFAULT_NOTES_SIDEBAR_WIDTH,
    },
    {
      notesFontSize: 18,
      notesEditorTheme: 'dark',
      notesSidebarWidth: DEFAULT_NOTES_SIDEBAR_WIDTH,
    },
    {
      notesFontSize: 20,
      notesEditorTheme: 'light',
      notesSidebarWidth: DEFAULT_NOTES_SIDEBAR_WIDTH,
    },
  ]);
  assert.deepEqual(store.get(), {
    notesFontSize: 20,
    notesEditorTheme: 'light',
    notesSidebarWidth: DEFAULT_NOTES_SIDEBAR_WIDTH,
  });
  const reloaded = new UiPreferencesStore(filePath);
  await reloaded.load();
  assert.deepEqual(reloaded.get(), {
    notesFontSize: 20,
    notesEditorTheme: 'light',
    notesSidebarWidth: DEFAULT_NOTES_SIDEBAR_WIDTH,
  });
});
