const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');

async function fixture(t) {
  const { NotesPage } = await import(path.join(__dirname, '../dist/renderer/pages/notesPage.js'));
  const page = Object.create(NotesPage.prototype);
  const note = id => ({ id, name: id, language: 'richtext', content: `body-${id}`, tags: [],
    createdAt: '2026-09-29T00:00:00.000Z', updatedAt: '2026-09-29T00:00:00.000Z' });
  const notes = [note('active'), note('other')];
  Object.assign(page, {
    active: true, loaded: true, notes, selectedId: 'active', noteBodyGeneration: 0,
    treeNodes: notes.map((n, order) => ({ noteId: n.id, parentId: null, order })),
    expandedNoteIds: new Set(), persistentApplyIds: new Set(), deletedIds: new Set(),
    loadedNoteIds: new Set(notes.map(n => n.id)), openNoteIds: notes.map(n => n.id),
    searchInput: { value: '' }, syncMessage: {}, syncBanner: { classList: { toggle() {}, remove() {} } },
    newButton: {}, calls: [],
  });
  for (const key of ['editVersions', 'persistedVersions', 'queuedVersions']) page[key] = new Map(notes.map(n => [n.id, 0]));
  for (const key of ['saveQueues', 'saveTimers', 'noteBodyErrors', 'notesById', 'treeNodesById', 'breadcrumbCache']) page[key] = new Map();
  page.saveErrorNoteIds = new Set();
  page.persistedNotes = new Map(notes.map(n => [n.id, structuredClone(n)]));
  page.rebuildWorkspaceIndexes();
  for (const key of ['renderList', 'renderEditor', 'renderTabs', 'updateSelectedSaveStatus', 'updateTabNoteName', 'queueSearchRender', 'applySyncGuard', 'updateCloudStatus']) {
    page[key] = () => page.calls.push(key);
  }
  const workspace = {
    notes: notes.map(({ content, ...summary }) => structuredClone(summary)),
    tree: { schemaVersion: 1, nodes: structuredClone(page.treeNodes) }, expandedNoteIds: [],
  };
  const previousWindow = global.window;
  global.window = { notesApi: {
    getWorkspace: async () => structuredClone(workspace),
    getNote: async id => ({ ...workspace.notes.find(n => n.id === id), content: `remote-${id}` }),
  }, clearTimeout() {} };
  t.after(() => { global.window = previousWindow; });
  return { page, workspace };
}

test('own save acknowledgements do not render or replace the active document', async t => {
  const { page } = await fixture(t);
  const body = page.notesById.get('active');
  assert.equal(await page.refreshServerWorkspace(), true);
  assert.deepEqual(page.calls, []);
  assert.equal(page.notesById.get('active'), body);
  assert.equal(page.loadedNoteIds.has('active'), true);
});

test('changes to another note refresh its metadata without rendering the active editor', async t => {
  const { page, workspace } = await fixture(t);
  workspace.notes[1].updatedAt = '2026-09-29T01:00:00.000Z';
  workspace.notes[1].name = 'Remote rename';
  assert.equal(await page.refreshServerWorkspace(), true);
  assert.equal(page.notesById.get('active').content, 'body-active');
  assert.equal(page.persistedNotes.get('active').content, 'body-active');
  assert.equal(page.loadedNoteIds.has('active'), true);
  assert.equal(page.loadedNoteIds.has('other'), false);
  assert.equal(page.notesById.get('other').name, 'Remote rename');
  assert.deepEqual(page.calls, ['renderList', 'updateTabNoteName']);
});

test('a remote active-note change loads its body before rendering, without a blank loading state', async t => {
  const { page, workspace } = await fixture(t);
  workspace.notes[0].updatedAt = '2026-09-29T01:00:00.000Z';
  page.renderEditor = () => {
    assert.equal(page.loadedNoteIds.has('active'), true);
    assert.equal(page.notesById.get('active').content, 'remote-active');
    page.calls.push('renderEditor');
  };
  assert.equal(await page.refreshServerWorkspace(), true);
  assert.equal(page.persistedNotes.get('active').content, 'remote-active');
  assert.ok(page.calls.includes('renderEditor'));
});

test('edits during workspace fetch defer refresh even if the edit already finished saving', async t => {
  const { page, workspace } = await fixture(t);
  global.window.notesApi.getWorkspace = async () => {
    page.editVersions.set('active', 1);
    page.persistedVersions.set('active', 1);
    return workspace;
  };
  assert.equal(await page.refreshServerWorkspace(), false);
  assert.deepEqual(page.calls, []);
});

test('typing during the remote body fetch preserves the local draft and its save base', async t => {
  const { page, workspace } = await fixture(t);
  workspace.notes[0].updatedAt = '2026-09-29T01:00:00.000Z';
  global.window.notesApi.getNote = async () => {
    page.editVersions.set('active', 1);
    page.notesById.get('active').content = 'new local draft';
    return { ...workspace.notes[0], content: 'remote body' };
  };
  assert.equal(await page.refreshServerWorkspace(), false);
  assert.equal(page.notesById.get('active').content, 'new local draft');
  assert.equal(page.persistedNotes.get('active').content, 'body-active');
  assert.deepEqual(page.calls, []);
});

test('remote deletions remove stale tabs without reloading an unaffected editor', async t => {
  const { page, workspace } = await fixture(t);
  workspace.notes.pop(); workspace.tree.nodes.pop();
  assert.equal(await page.refreshServerWorkspace(), true);
  assert.deepEqual(page.openNoteIds, ['active']);
  assert.equal(page.calls.includes('renderEditor'), false);
  assert.equal(page.calls.includes('renderTabs'), true);
});

test('polling does not acknowledge a revision until pending local edits and refresh are complete', async t => {
  const { page } = await fixture(t);
  page.serverRevision = 1;
  page.editVersions.set('active', 1);
  global.window.notesServerApi = {
    status: async () => ({ enabled: true }),
    poll: async () => ({ enabled: true, connected: true, revision: 2, pendingDrafts: 0 }),
  };
  page.flushAllPendingSaves = async () => page.persistedVersions.set('active', 1);
  await page.checkRemoteNotes();
  assert.equal(page.serverRevision, 1);
  await page.checkRemoteNotes();
  assert.equal(page.serverRevision, 2);
  assert.equal(page.calls.includes('renderEditor'), false);
});

test('remote deletion of the active note selects a remaining open tab', async t => {
  const { page, workspace } = await fixture(t);
  workspace.notes.shift(); workspace.tree.nodes.shift();
  assert.equal(await page.refreshServerWorkspace(), true);
  assert.equal(page.selectedId, 'other');
  assert.deepEqual(page.openNoteIds, ['other']);
  assert.equal(page.calls.includes('renderEditor'), true);
});
