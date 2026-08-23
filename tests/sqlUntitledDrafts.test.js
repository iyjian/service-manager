const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

async function loadDrafts() {
  return import(pathToFileURL(
    path.join(__dirname, '..', 'dist', 'renderer', 'models', 'sqlUntitledDrafts.js'),
  ).href);
}

test('Untitled SQL drafts round-trip per environment with active-tab order and tab normalization', async () => {
  const {
    emptySqlUntitledDraftState,
    parseSqlUntitledDraftState,
    serializeSqlUntitledDraftState,
  } = await loadDrafts();
  const state = emptySqlUntitledDraftState();
  state.production.sources = ['SELECT\t1;', 'SELECT 2;'];
  state.production.activeIndex = 1;
  state.development.sources = ['UPDATE\tusers SET active = 1;'];

  const restored = parseSqlUntitledDraftState(serializeSqlUntitledDraftState(state));

  assert.deepEqual(restored.production, {
    sources: ['SELECT  1;', 'SELECT 2;'],
    activeIndex: 1,
  });
  assert.deepEqual(restored.development, {
    sources: ['UPDATE  users SET active = 1;'],
    activeIndex: 0,
  });
});

test('Untitled SQL draft restore fails closed for malformed, unsupported, and oversized snapshots', async () => {
  const {
    emptySqlUntitledDraftState,
    parseSqlUntitledDraftState,
    serializeSqlUntitledDraftState,
    SQL_UNTITLED_DRAFT_MAX_SOURCE_CHARACTERS,
    SQL_UNTITLED_DRAFT_MAX_TABS_PER_ENVIRONMENT,
  } = await loadDrafts();
  const empty = emptySqlUntitledDraftState();

  assert.deepEqual(parseSqlUntitledDraftState('{bad json'), empty);
  assert.deepEqual(parseSqlUntitledDraftState(JSON.stringify({ version: 2, environments: {} })), empty);
  assert.deepEqual(parseSqlUntitledDraftState(JSON.stringify({
    version: 1,
    environments: {
      production: { sources: ['SELECT 1;'], activeIndex: 4 },
      development: { sources: [], activeIndex: 0 },
    },
  })), empty);

  const tooMany = emptySqlUntitledDraftState();
  tooMany.production.sources = Array.from(
    { length: SQL_UNTITLED_DRAFT_MAX_TABS_PER_ENVIRONMENT + 1 },
    (_, index) => `SELECT ${index};`,
  );
  assert.throws(() => serializeSqlUntitledDraftState(tooMany), /Too many Untitled SQL drafts/);

  const tooLarge = emptySqlUntitledDraftState();
  tooLarge.production.sources = ['x'.repeat(SQL_UNTITLED_DRAFT_MAX_SOURCE_CHARACTERS + 1)];
  assert.throws(() => serializeSqlUntitledDraftState(tooLarge), /too large to save locally/);

  const tooLargeTogether = emptySqlUntitledDraftState();
  tooLargeTogether.production.sources = ['x'.repeat(700_000), 'y'.repeat(700_000)];
  tooLargeTogether.development.sources = ['z'.repeat(700_000)];
  assert.throws(() => serializeSqlUntitledDraftState(tooLargeTogether), /drafts are too large/);
});
