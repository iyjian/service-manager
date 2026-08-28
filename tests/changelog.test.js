const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  ChangelogSeenStore,
  isChangelogVersionInRange,
  parseChangelog,
} = require('../dist/main/core/changelog');

const SAMPLE = `# Changelog

Intro paragraph that is ignored.

## [1.2.0] - 2026-01-02

### Added
- First new feature
- Second new feature

### Fixed
- A bug

## [1.1.0] - 2025-12-01

### Changed
- Something changed

`;

test('parseChangelog extracts releases, dates, sections, and bullets newest-first', () => {
  const entries = parseChangelog(SAMPLE);
  assert.equal(entries.length, 2);

  assert.equal(entries[0].version, '1.2.0');
  assert.equal(entries[0].date, '2026-01-02');
  assert.equal(entries[0].sections.length, 2);
  assert.deepEqual(entries[0].sections[0], {
    title: 'Added',
    items: ['First new feature', 'Second new feature'],
  });
  assert.deepEqual(entries[0].sections[1], { title: 'Fixed', items: ['A bug'] });

  assert.equal(entries[1].version, '1.1.0');
  assert.equal(entries[1].date, '2025-12-01');
  assert.deepEqual(entries[1].sections, [{ title: 'Changed', items: ['Something changed'] }]);
});

test('parseChangelog ignores bullet lines that precede any section', () => {
  const entries = parseChangelog('## [2.0.0]\n- orphan bullet\n### Added\n- real item\n');
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].sections, [{ title: 'Added', items: ['real item'] }]);
});

test('parseChangelog accepts releases without a date', () => {
  const entries = parseChangelog('## [3.0.0]\n### Added\n- item\n');
  assert.equal(entries[0].version, '3.0.0');
  assert.equal(entries[0].date, undefined);
});

test('isChangelogVersionInRange includes releases after the previous version through current', () => {
  assert.equal(isChangelogVersionInRange('1.2.0', '1.3.0', '1.1.0'), true);
  assert.equal(isChangelogVersionInRange('1.3.0', '1.3.0', '1.1.0'), true);
  assert.equal(isChangelogVersionInRange('1.1.0', '1.3.0', '1.1.0'), false);
  assert.equal(isChangelogVersionInRange('1.4.0', '1.3.0', '1.1.0'), false);
});

test('isChangelogVersionInRange falls back to the current release without a usable previous version', () => {
  assert.equal(isChangelogVersionInRange('1.3.0', '1.3.0', null), true);
  assert.equal(isChangelogVersionInRange('1.2.0', '1.3.0', null), false);
  assert.equal(isChangelogVersionInRange('1.3.0', '1.3.0', 'not-a-version'), true);
  assert.equal(isChangelogVersionInRange('1.4.0', '1.3.0', 'not-a-version'), false);
  assert.equal(isChangelogVersionInRange('1.3.0', '1.3.0', '1.4.0'), true);
  assert.equal(isChangelogVersionInRange('1.4.0', '1.3.0', '1.4.0'), false);
});

async function createStore(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'changelog-seen-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return new ChangelogSeenStore(path.join(directory, 'changelog-seen.json'));
}

test('ChangelogSeenStore reports null before a version has been seen', async (t) => {
  const store = await createStore(t);
  await store.load();
  assert.equal(store.getSeenVersion(), null);
});

test('ChangelogSeenStore persists and returns the last seen version', async (t) => {
  const store = await createStore(t);
  await store.load();
  await store.markSeen('0.3.67');
  assert.equal(store.getSeenVersion(), '0.3.67');

  const reloaded = new ChangelogSeenStore(store.filePath);
  await reloaded.load();
  assert.equal(reloaded.getSeenVersion(), '0.3.67');
});

test('ChangelogSeenStore preserves the previous run version until the current changelog is seen', async (t) => {
  const store = await createStore(t);
  await store.load();
  await store.recordRun('0.3.78');
  assert.equal(store.getPreviousRunVersion(), null);

  await store.recordRun('0.3.79');
  assert.equal(store.getPreviousRunVersion(), '0.3.78');

  const reloaded = new ChangelogSeenStore(store.filePath);
  await reloaded.load();
  assert.equal(reloaded.getPreviousRunVersion(), '0.3.78');

  await reloaded.recordRun('0.3.79');
  assert.equal(reloaded.getPreviousRunVersion(), '0.3.78');

  await reloaded.markSeen('0.3.79');
  assert.equal(reloaded.getSeenVersion(), '0.3.79');
  assert.equal(reloaded.getPreviousRunVersion(), null);
});

test('ChangelogSeenStore migrates the previous seen-only store shape for upgrade highlighting', async (t) => {
  const store = await createStore(t);
  await fs.writeFile(store.filePath, JSON.stringify({ version: '0.3.67' }), 'utf8');

  await store.load();
  assert.equal(store.getSeenVersion(), '0.3.67');
  assert.equal(store.getPreviousRunVersion(), null);

  await store.recordRun('0.3.68');
  assert.equal(store.getPreviousRunVersion(), '0.3.67');
});

test('ChangelogSeenStore treats a damaged file as unseen', async (t) => {
  const store = await createStore(t);
  await fs.writeFile(store.filePath, 'not json', 'utf8');
  await store.load();
  assert.equal(store.getSeenVersion(), null);
  assert.equal(store.getPreviousRunVersion(), null);
});
