const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm, readFile } = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { NotesServerSettings } = require('../dist/main/notesServer/settings');
const { RemoteNotesBackend } = require('../dist/main/notesServer/backend');
const { NotesServerConnection } = require('../dist/main/notesServer/connection');
const protector = { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s.split('').reverse().join('')), decryptString: b => b.toString().split('').reverse().join('') };
const note = { id: 'one', name: 'one', content: 'original', language: 'markdown', tags: [], createdAt: '2026-09-25T00:00:00.000Z', updatedAt: '2026-09-25T00:00:00.000Z' };
async function fixture(t) {
 const root = await mkdtemp(path.join(os.tmpdir(), 'notes-client-'));
 const settings = new NotesServerSettings(path.join(root, 'settings.json'), protector);
 await settings.save({ name: 'test', sshHost: 'example.org', sshPort: 22, username: 'user', authType: 'password', password: 'test-secret' });
 await settings.setMode(true, 'instance');
 let state = { instanceId: 'instance', revision: 1, notes: [note], tombstones: [], tree: { schemaVersion: 1, nodes: [{ noteId: 'one', parentId: null, order: 0 }] } };
 let offline = false, conflict = false, lostAck = false; const requests = new Map();
 const deployment = { settings, cancel() {}, health: async () => { if (offline) throw new Error('offline'); return { protocol: 1, version: 'test', instanceId: 'instance', revision: state.revision }; },
 api: async (route, body) => {
  if (offline) throw new Error('offline'); if (route === '/v1/workspace') return structuredClone(state);
  if (route === '/v1/transactions') {
    if (requests.has(body.requestId)) return requests.get(body.requestId);
    if (conflict || body.expectedRevision !== state.revision) throw Object.assign(new Error('conflict'), { status: 409 });
    const notes = new Map(state.notes.map(n => [n.id, n])); for (const id of body.deletedIds) notes.delete(id); for (const n of body.upserts) notes.set(n.id, n);
    state = { ...state, revision: state.revision + 1, notes: [...notes.values()], tree: body.tree ?? state.tree, tombstones: body.tombstones ?? state.tombstones };
    const result = { revision: state.revision, instanceId: state.instanceId }; requests.set(body.requestId, result);
    if (lostAck) { lostAck = false; throw new Error('lost acknowledgment'); } return result;
  } throw new Error('unexpected route');
 }};
 const backend = new RemoteNotesBackend(deployment, root, () => {}); await backend.initialize();
 t.after(async () => { await backend.close(); await rm(root, { recursive: true, force: true }); });
 return { backend, settings, root, deployment, setOffline: v => offline = v, setConflict: v => conflict = v, loseAck: () => lostAck = true, state: () => structuredClone(state) };
}
test('settings expose only credential presence and reject insecure persistence', async t => {
 const f = await fixture(t); assert.equal(f.settings.view().hasPassword, true); assert.equal('password' in f.settings.view(), false);
 const saved = await readFile(path.join(f.root, 'settings.json'), 'utf8'); assert.ok(!saved.includes('test-secret'));
 const loaded = new NotesServerSettings(path.join(f.root, 'settings.json'), protector); await loaded.load(); assert.equal(loaded.endpoint().password, 'test-secret');
 await assert.rejects(f.settings.save({}), /cannot be replaced/);
 const insecure = new NotesServerSettings(path.join(f.root, 'bad.json'), { ...protector, getSelectedStorageBackend: () => 'basic_text' });
 await assert.rejects(insecure.save({ name: 'x', sshHost: 'host', sshPort: 22, username: 'u', authType: 'password', password: 'x' }), /Secure credential/);
});
test('remote writes commit and a conflict restores the read cache without losing the draft', async t => {
 const f = await fixture(t); await f.backend.run(async () => undefined);
 const draft = { name: 'one', content: 'edited', tags: [], language: 'markdown' };
 await f.backend.preserve('one', note, draft); f.setConflict(true);
 await assert.rejects(f.backend.run(() => f.backend.store.compareAndUpdate('one', note, draft), true), /conflict/);
 assert.equal(f.backend.store.get('one').content, 'original'); assert.equal(f.backend.draft('one').draft.content, 'edited');
 f.setConflict(false); await f.backend.reconnectDrafts(); assert.equal(f.state().notes[0].content, 'edited'); assert.equal(f.backend.status().pendingDrafts, 0);
});
test('offline reads use cache, writes are blocked, durable drafts survive reopening', async t => {
 const f = await fixture(t); await f.backend.run(async () => undefined); f.setOffline(true);
 assert.equal(await f.backend.run(async () => f.backend.store.get('one').content), 'original');
 await assert.rejects(f.backend.run(async () => f.backend.store.create(), true), /offline/);
 await f.backend.preserve('one', note, { ...note, content: 'offline edit' });
 const raw = JSON.parse(await readFile(path.join(f.root, 'notes-server-cache', f.settings.identity, 'drafts.json'), 'utf8'));
 assert.equal(raw.instanceId, 'instance'); assert.equal(raw.drafts[0].draft.content, 'offline edit');
 assert.throws(() => f.backend.assertNoDrafts(), /drafts/);
 await f.backend.close();
 const reopened = new RemoteNotesBackend(f.deployment, f.root, () => {});
 try { await reopened.initialize(); assert.equal(reopened.draft('one').draft.content, 'offline edit'); } finally { await reopened.close(); }

});
test('lost commit acknowledgments replay the durable request without duplicate mutations', async t => {
 const f = await fixture(t); await f.backend.run(async () => undefined); f.loseAck();
 await assert.rejects(f.backend.run(async () => { const n = await f.backend.store.create(); await f.backend.tree.insert(n.id, null); }, true), /acknowledgment/);
 assert.equal(f.state().notes.length, 2); await f.backend.run(async () => undefined); assert.equal(f.backend.store.list().length, 2); assert.equal(f.state().revision, 2);
});
test('HTTP transport uses the SSH channel rather than a local TCP connection', async t => {
 const http = require('node:http'); const net = require('node:net');
 const server = http.createServer((req,res) => { assert.equal(req.headers.authorization, 'Bearer test'); res.end(JSON.stringify({ ok: true })); });
 await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
 t.after(() => new Promise(resolve => server.close(resolve)));
 let forwarded = false;
 const client = { forwardOut: (_a,_b,host,port,callback) => { forwarded = true; assert.equal(port, 65001); const socket = net.connect(server.address().port, '127.0.0.1'); const { Duplex } = require('node:stream'); const channel = new Duplex({ read() {}, write(chunk, enc, cb) { socket.write(chunk, enc, cb); }, destroy(error, cb) { socket.destroy(); cb(error); } }); socket.on('data', chunk => channel.push(chunk)); socket.on('end', () => channel.push(null)); socket.on('error', error => channel.destroy(error)); socket.on('connect', () => callback(undefined, channel)); }, end() {} };
 const connection = new NotesServerConnection(client, new AbortController().signal);
 assert.deepEqual(await connection.api(65001, 'test', '/v1/health'), { ok: true }); assert.equal(forwarded, true);
});

test('server identity changes block writes and preserve the previous cache', async t => {
 const f = await fixture(t); await f.backend.run(async () => undefined);
 f.deployment.health = async () => ({ protocol: 1, version: 'test', instanceId: 'other-instance', revision: 0 });
 await assert.rejects(f.backend.run(async () => f.backend.store.create(), true), /identity changed/);
 assert.equal(f.backend.store.get('one').content, 'original');
});

test('startup setup remains locked across restart until migration explicitly completes', async t => {
 const f = await fixture(t);
 assert.equal(f.settings.setupComplete, false);
 const restored = new NotesServerSettings(path.join(f.root, 'settings.json'), protector);
 await restored.load(); assert.equal(restored.setupComplete, false);
 await restored.completeSetup();
 const finished = new NotesServerSettings(path.join(f.root, 'settings.json'), protector);
 await finished.load(); assert.equal(finished.view().setupComplete, true);
 await assert.rejects(finished.setMode(false), /retired after migration/);
 assert.equal(finished.enabled, true);
 await finished.load(); assert.equal(finished.setupComplete, true);
});

test('previously completed profiles cannot reactivate the retired local database on restart', async t => {
 const f = await fixture(t);
 const file = path.join(f.root, 'settings.json');
 const raw = JSON.parse(await readFile(file, 'utf8'));
 const saved = JSON.parse(protector.decryptString(Buffer.from(raw.encrypted, 'base64')));
 saved.setupComplete = true; saved.enabled = false;
 raw.encrypted = protector.encryptString(JSON.stringify(saved)).toString('base64');
 await require('node:fs/promises').writeFile(file, JSON.stringify(raw));
 const restored = new NotesServerSettings(file, protector); await restored.load();
 assert.equal(restored.setupComplete, true); assert.equal(restored.enabled, true);
 await assert.rejects(restored.setMode(false), /retired after migration/);
});
