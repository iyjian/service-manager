const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  DEFAULT_NOTES_FONT_SIZE,
  MAX_NOTES_FONT_SIZE,
  MIN_NOTES_FONT_SIZE,
  UI_PREFERENCES_SCHEMA_VERSION,
  UiPreferencesStore,
  normalizeUiPreferencesDraft,
} = require('../dist/main/uiPreferencesStore');

async function createStore(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'service-manager-ui-preferences-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'ui-preferences.json');
  const store = new UiPreferencesStore(filePath);
  return { directory, filePath, store };
}

test('UI preferences use a stable 14px Notes default when the file is missing', async (t) => {
  const { filePath, store } = await createStore(t);
  await store.load();

  assert.deepEqual(store.get(), { notesFontSize: DEFAULT_NOTES_FONT_SIZE });
  await assert.rejects(fs.stat(filePath), { code: 'ENOENT' });
});

test('UI preferences persist atomically with a versioned private JSON shape', async (t) => {
  const { directory, filePath, store } = await createStore(t);
  await store.load();
  assert.deepEqual(await store.save({ notesFontSize: 17 }), { notesFontSize: 17 });
  await store.flush();

  assert.deepEqual(JSON.parse(await fs.readFile(filePath, 'utf8')), {
    schemaVersion: UI_PREFERENCES_SCHEMA_VERSION,
    notes: { fontSize: 17 },
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
  assert.deepEqual(reloaded.get(), { notesFontSize: 17 });
});

test('damaged UI preferences safely fall back and a default Save repairs the file', async (t) => {
  const { filePath, store } = await createStore(t);
  await fs.writeFile(filePath, '{not-json', 'utf8');
  await store.load();
  assert.deepEqual(store.get(), { notesFontSize: DEFAULT_NOTES_FONT_SIZE });

  await store.save({ notesFontSize: DEFAULT_NOTES_FONT_SIZE });
  assert.deepEqual(JSON.parse(await fs.readFile(filePath, 'utf8')), {
    schemaVersion: UI_PREFERENCES_SCHEMA_VERSION,
    notes: { fontSize: DEFAULT_NOTES_FONT_SIZE },
  });
});

test('Notes font size validation accepts only bounded whole pixels', () => {
  assert.deepEqual(
    normalizeUiPreferencesDraft({ notesFontSize: MIN_NOTES_FONT_SIZE }),
    { notesFontSize: MIN_NOTES_FONT_SIZE },
  );
  assert.deepEqual(
    normalizeUiPreferencesDraft({ notesFontSize: MAX_NOTES_FONT_SIZE }),
    { notesFontSize: MAX_NOTES_FONT_SIZE },
  );

  for (const notesFontSize of [11, 12.5, 25, Number.NaN, '14', undefined]) {
    assert.throws(
      () => normalizeUiPreferencesDraft({ notesFontSize }),
      /Notes font size must be a whole number from 12 to 24\./,
    );
  }
  assert.throws(() => normalizeUiPreferencesDraft(null), /Notes font size/);
});

test('concurrent UI preference saves remain serialized in invocation order', async (t) => {
  const { filePath, store } = await createStore(t);
  await store.load();

  const results = await Promise.all([
    store.save({ notesFontSize: 16 }),
    store.save({ notesFontSize: 18 }),
    store.save({ notesFontSize: 20 }),
  ]);

  assert.deepEqual(results, [
    { notesFontSize: 16 },
    { notesFontSize: 18 },
    { notesFontSize: 20 },
  ]);
  assert.deepEqual(store.get(), { notesFontSize: 20 });
  const reloaded = new UiPreferencesStore(filePath);
  await reloaded.load();
  assert.deepEqual(reloaded.get(), { notesFontSize: 20 });
});
