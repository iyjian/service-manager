const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const handlers = new Map();
let confirm;
const original = Module._load;
Module._load = function (name, ...args) {
  if (name === 'electron') return { ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, dialog: { showMessageBox: options => confirm(options) } };
  return original.call(this, name, ...args);
};
let registerNotesServerIpc;
try { ({ registerNotesServerIpc } = require('../dist/main/notesServer/ipc')); }
finally { Module._load = original; }

for (const scenario of ['accept', 'cancel', 'backup failure', 'connection failure']) {
  test(`existing workspace: ${scenario} preserves both datasets`, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'notes-existing-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    let enabled = false, complete = false, released = false, prompts = 0;
    const local = { notes: [{ id: 'local', content: 'local text' }], tombstones: [], tree: {} };
    const remote = { instanceId: 'server', revision: 7, notes: [{ id: 'remote', content: 'server text' }], tombstones: [], tree: {} };
    const before = JSON.stringify({ local, remote });
    confirm = async options => {
      prompts++;
      assert.equal(options.defaultId, 0);
      const files = await fs.readdir(path.join(root, 'notes-server-migration-backups'));
      assert.equal(await fs.readFile(path.join(root, 'notes-server-migration-backups', files[0]), 'utf8'), 'sqlite backup');
      return { response: scenario === 'cancel' ? 0 : 1 };
    };
    registerNotesServerIpc({ userData: root, hosts: () => [], snapshot: () => local,
      backup: async () => { if (scenario === 'backup failure') throw Error('disk full'); return Buffer.from('sqlite backup'); },
      freeze: async () => ({ release() { released = true; }, reload() {} }),
      settings: { setupComplete: false, setMode: async mode => { enabled = mode; }, completeSetup: async () => { complete = true; } },
      deployment: { health: async () => ({ instanceId: 'server' }), api: async route => { assert.equal(route, '/v1/workspace', 'must never import or mutate server'); return remote; } },
      backend: { enabled: false, idle: async () => {}, assertNoDrafts() {}, initialize: async () => { if (scenario === 'connection failure') throw Error('offline'); }, run: async () => {} },
    });
    const action = handlers.get('notes-server:action')({ sender: { isDestroyed: () => false, send() {} } }, 'migrate');
    if (scenario === 'accept') await action;
    else await assert.rejects(action, scenario === 'cancel' ? /cancelled/ : scenario === 'backup failure' ? /disk full/ : /offline/);
    assert.equal(enabled, scenario === 'accept');
    assert.equal(complete, scenario === 'accept');
    assert.equal(prompts, scenario === 'backup failure' ? 0 : 1);
    assert.equal(released, true);
    assert.equal(JSON.stringify({ local, remote }), before);
  });
}
