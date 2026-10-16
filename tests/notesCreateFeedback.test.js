const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function harness() {
  const source = fs.readFileSync(path.join(__dirname, '../dist/renderer/pages/notesPage.js'), 'utf8');
  const start = source.indexOf('    async createNote(parentId)');
  const end = source.indexOf('    showShareDialog(', start);
  assert.ok(start >= 0 && end > start);
  const errors = [];
  const api = { calls: 0, createNote: async () => { api.calls++; throw new Error('Offline'); } };
  const create = new Function('window', 'toast', 'toErrorMessage',
    'return ({' + source.slice(start, end) + '}).createNote;'
  )({ notesApi: api }, (message) => errors.push(message), String);
  const load = deferred();
  const upload = deferred();
  const save = deferred();
  const messages = [];
  const page = {
    syncGuard: { editable: true }, creating: false, loaded: true, selectionVersion: 0,
    editVersions: new Map(), notes: [],
    ensureLoaded: () => load.promise,
    waitForEditorUploads: () => upload.promise,
    flushAllPendingSaves: () => save.promise,
    updateCreateFeedback: (message = '') => messages.push(message),
  };
  return { page, create, load, upload, save, messages, errors, api };
}

test('creation locks before loading, reports each wait, and recovers after request failure', async () => {
  const h = harness();
  const pending = h.create.call(h.page, null);
  assert.equal(h.page.creating, true);
  assert.deepEqual(h.messages, ['Preparing new Note…']);
  await h.create.call(h.page, null);
  assert.equal(h.messages.length, 1);
  h.load.resolve();
  await Promise.resolve();
  assert.equal(h.messages.at(-1), 'Waiting for uploads…');
  h.upload.resolve();
  await Promise.resolve();
  assert.equal(h.messages.at(-1), 'Saving changes…');
  h.save.resolve();
  await pending;
  assert.equal(h.api.calls, 1);
  assert.ok(h.messages.includes('Creating Note…'));
  assert.equal(h.messages.at(-1), '');
  assert.equal(h.page.creating, false);
  assert.match(h.errors[0], /Unable to create Note:.*Offline/);
  await h.create.call(h.page, null);
  assert.equal(h.api.calls, 2);
});

test('loading failure clears creation feedback without sending a create request', async () => {
  const h = harness();
  h.page.loaded = false;
  const pending = h.create.call(h.page, null);
  h.load.resolve();
  await pending;
  assert.equal(h.page.creating, false);
  assert.equal(h.messages.at(-1), '');
  assert.equal(h.api.calls, 0);
});
