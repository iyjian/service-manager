const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm, readFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomBytes, randomUUID } = require('node:crypto');
const { startNotesServer } = require('../dist/notes-server/notes-server/server');
const note = (id = 'one', content = 'original') => ({ id, name: id, content, language: 'markdown', tags: [], createdAt: '2026-09-25T00:00:00.000Z', updatedAt: '2026-09-25T00:00:00.000Z' });
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'notes-server-')); const token = randomBytes(32).toString('hex');
  const instance = await startNotesServer({ directory, token, port: 0, version: 'test' });
  const base = `http://127.0.0.1:${instance.server.address().port}`;
  t.after(async () => { await instance.close(); await rm(directory, { recursive: true, force: true }); });
  const call = async (route, input, auth = token) => {
    const response = await fetch(base + route, { method: input === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' }, body: input === undefined ? undefined : JSON.stringify(input) });
    return { status: response.status, data: response.headers.get('content-type').includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer()) };
  };
  const migrate = (notes = [note()], tree = notes.map((n, order) => ({ noteId: n.id, parentId: null, order }))) => call('/v1/import', {
    requestId: randomUUID(), expectedRevision: 0, workspace: { notes, tombstones: [], tree: { schemaVersion: 1, nodes: tree } },
  });
  return { call, migrate, directory };
}
test('API requires authentication and exposes a stable identity', async t => {
  const f = await fixture(t); assert.equal((await f.call('/v1/health', undefined, 'bad')).status, 401);
  const health = await f.call('/v1/health'); assert.equal(health.data.protocol, 1); assert.equal(health.data.vaultSchema, 3); assert.equal(health.data.revision, 0);
  assert.equal((await f.call('/v1/workspace')).data.instanceId, health.data.instanceId);
});
test('migration preserves IDs and hierarchy and cannot overwrite a populated server', async t => {
  const f = await fixture(t); const notes = [note('a'), note('b')];
  assert.equal((await f.migrate(notes, [{ noteId: 'a', parentId: null, order: 0 }, { noteId: 'b', parentId: 'a', order: 0 }])).status, 200);
  const workspace = (await f.call('/v1/workspace')).data; assert.deepEqual(workspace.notes, notes); assert.equal(workspace.tree.nodes[1].parentId, 'a');
  assert.equal((await f.migrate()).status, 409); assert.deepEqual((await f.call('/v1/workspace')).data, workspace);
});
test('invalid trees and duplicate IDs do not partially import', async t => {
  const f = await fixture(t); assert.equal((await f.migrate([note('a'), note('a')])).status, 400);
  assert.equal((await f.migrate([note('a'), note('b')], [{ noteId: 'a', parentId: 'b', order: 0 }, { noteId: 'b', parentId: 'a', order: 0 }])).status, 400);
  assert.equal((await f.call('/v1/workspace')).data.revision, 0);
});
test('transaction retries are idempotent and concurrent writes conflict', async t => {
  const f = await fixture(t); await f.migrate();
  const payload = { requestId: randomUUID(), expectedRevision: 1, upserts: [note('one', 'edited')], deletedIds: [] };
  assert.equal((await f.call('/v1/transactions', payload)).data.revision, 2);
  assert.equal((await f.call('/v1/transactions', payload)).data.revision, 2);
  assert.equal((await f.call('/v1/transactions', { ...payload, upserts: [note('one', 'other')] })).status, 409);
  const results = await Promise.all(['left', 'right'].map(content => f.call('/v1/transactions', { requestId: randomUUID(), expectedRevision: 2, upserts: [note('one', content)], deletedIds: [] })));
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
});
test('transaction validation rolls back all changes', async t => {
  const f = await fixture(t); await f.migrate(); const before = (await f.call('/v1/workspace')).data;
  assert.equal((await f.call('/v1/transactions', { requestId: randomUUID(), expectedRevision: 1, deletedIds: ['one'], upserts: [] })).status, 400);
  assert.deepEqual((await f.call('/v1/workspace')).data, before);
});
test('CRUD endpoints support search, moving and guarded subtree deletion', async t => {
  const f = await fixture(t); await f.migrate([note('one', '中文笔记')]);
  assert.deepEqual((await f.call('/v1/search?q=' + encodeURIComponent('中文'))).data, ['one']);
  assert.equal((await f.call('/v1/notes/one')).data.content, '中文笔记');
  await f.call('/v1/notes/create', { requestId: randomUUID(), expectedRevision: 1, parentId: 'one' });
  const workspace = (await f.call('/v1/workspace')).data; const child = workspace.notes.find(n => n.id !== 'one');
  assert.equal((await f.call('/v1/notes/update', { requestId: randomUUID(), expectedRevision: 2, id: child.id, draft: { name: 'Child', content: 'edit', tags: [], language: 'markdown' } })).status, 200);
  assert.equal((await f.call('/v1/notes/move', { requestId: randomUUID(), expectedRevision: 3, id: child.id, parentId: null })).status, 200);
  assert.deepEqual((await f.call('/v1/notes/delete-preview', { id: 'one' })).data, ['one']);
  assert.equal((await f.call('/v1/notes/delete', { requestId: randomUUID(), expectedRevision: 4, id: 'one', expectedIds: [] })).status, 409);
  assert.equal((await f.call('/v1/notes/delete', { requestId: randomUUID(), expectedRevision: 4, id: 'one', expectedIds: ['one'] })).status, 200);
  const remaining = (await f.call('/v1/workspace')).data; assert.equal(remaining.notes.length, 1); assert.equal(remaining.tombstones[0].id, 'one');
});
test('backup download is a valid SQLite database and rejects traversal', async t => {
  const f = await fixture(t); await f.migrate();
  const result = await f.call('/v1/backups', {}); assert.equal(result.status, 200);
  const downloaded = await f.call('/v1/backups/' + result.data.name); assert.equal(downloaded.data.subarray(0, 15).toString(), 'SQLite format 3');
  const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(path.join(f.directory, 'backups', result.data.name), { readOnly: true });
  try { assert.equal(JSON.parse(db.prepare('SELECT data FROM workspace').get().data).notes[0].id, 'one'); } finally { db.close(); }
  assert.equal((await f.call('/v1/backups/%2e%2e%2fserver.json')).status, 400);
});

test('upgrading an existing v1 database preserves content, hierarchy, identity and request deduplication', async t => {
  const { DatabaseSync } = require('node:sqlite');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'notes-server-upgrade-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const token = randomBytes(32).toString('hex');
  const existing = { instanceId: 'existing-instance', revision: 8, notes: [note('parent'), note('child')],
    tombstones: [], tree: { schemaVersion: 1, nodes: [{ noteId: 'parent', parentId: null, order: 0 }, { noteId: 'child', parentId: 'parent', order: 0 }] } };
  const payload = { requestId: 'already-committed', expectedRevision: 7, upserts: [], deletedIds: [] };
  const db = new DatabaseSync(path.join(directory, 'notes.sqlite3'));
  db.exec('PRAGMA user_version=1; CREATE TABLE workspace (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL); CREATE TABLE requests (id TEXT PRIMARY KEY, hash TEXT NOT NULL, revision INTEGER NOT NULL);');
  db.prepare('INSERT INTO workspace VALUES(1,?)').run(JSON.stringify(existing));
  db.prepare('INSERT INTO requests VALUES(?,?,?)').run(payload.requestId, require('node:crypto').createHash('sha256').update(JSON.stringify(payload)).digest('hex'), 8);
  db.close();
  for (let restart = 0; restart < 2; restart++) {
    const instance = await startNotesServer({ directory, token, port: 0, version: '0.3.91' });
    try {
      const base = `http://127.0.0.1:${instance.server.address().port}`;
      const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
      assert.deepEqual(await (await fetch(`${base}/v1/workspace`, { headers })).json(), existing);
      const result = await fetch(`${base}/v1/transactions`, { method: 'POST', headers, body: JSON.stringify(payload) });
      assert.equal(result.status, 200); assert.equal((await result.json()).revision, 8);
      assert.equal((await (await fetch(`${base}/v1/health`, { headers })).json()).revision, 8);
    } finally { await instance.close(); }
  }
});

test('Vault authenticates, encrypts database contents, merges migration idempotently and rejects stale writes', async t => {
 const f = await fixture(t);
 const instanceId = (await f.call('/v1/health')).data.instanceId;
 const record = { id: 'login-one', type: 'login', name: 'Account', application: 'Example', username: 'alice', password: 'never-plaintext-password', urls: ['https://example.com'], tags: ['work'], notes: 'private account note', createdAt: '2026-10-05T00:00:00.000Z', revision: 0 };
 assert.equal((await f.call('/v1/vault', undefined, 'bad')).status, 401);
 assert.equal((await f.call('/v1/vault/import', { instanceId: 'wrong', records: [record] })).status, 409);
 const first = await f.call('/v1/vault/import', { instanceId, records: [record] }); assert.equal(first.status, 200);
 assert.equal((await f.call('/v1/vault/import', { instanceId, records: [record] })).data.revision, first.data.revision);
 assert.equal((await f.call('/v1/vault/import', { instanceId, records: [{ ...record, password: 'conflict' }] })).status, 409);
 const snapshot = (await f.call('/v1/vault')).data; assert.equal(snapshot.records[0].accounts[0].password, record.password);
 assert.equal((await f.call('/v1/vault/write', { instanceId, expectedRevision: 0, records: [record] })).status, 409);
 assert.equal((await f.call('/v1/vault/write', { instanceId, expectedRevision: snapshot.revision, records: [] })).status, 409);
 assert.equal((await f.call('/v1/vault/write', { instanceId, expectedRevision: snapshot.revision, records: [{ ...record, name: 'Updated', revision: 1 }] })).status, 200);
 const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(path.join(f.directory, 'notes.sqlite3'));
 const raw = db.prepare('SELECT encrypted FROM vault').get().encrypted; db.close();
 assert.ok(!raw.includes(record.password)); assert.ok(!raw.includes(record.username)); assert.ok(!raw.includes(record.notes));
 const backup = await f.call('/v1/backups', {});
 const backupBytes = (await f.call('/v1/backups/' + backup.data.name)).data;
 assert.ok(!backupBytes.includes(Buffer.from(record.password)));
 assert.equal((await readFile(path.join(f.directory, 'vault-encryption.key'))).length, 32);
 assert.equal((await f.call('/v1/workspace')).data.notes.length, 0);
});

test('Vault survives restart and refuses to replace a missing encryption key', async t => {
 const directory = await mkdtemp(path.join(os.tmpdir(), 'vault-restart-')); const token = randomBytes(32).toString('hex');
 t.after(() => rm(directory, { recursive: true, force: true }));
 let server = await startNotesServer({ directory, token, port: 0, version: 'test' });
 const call = async (route, payload) => {
  const response = await fetch(`http://127.0.0.1:${server.server.address().port}` + route, { method: payload ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: payload ? JSON.stringify(payload) : undefined });
  assert.equal(response.status, 200); return response.json();
 };
 try {
  const { instanceId } = await call('/v1/health');
  const record = { id: 'secure-note', type: 'secureNote', name: 'Recovery', application: '', username: '', urls: [], tags: [], notes: 'secret', createdAt: '2026-10-05T00:00:00.000Z' };
  await call('/v1/vault/import', { instanceId, records: [record] });
  await server.close(); server = await startNotesServer({ directory, token, port: 0, version: 'test' });
  assert.equal((await call('/v1/vault')).records[0].notes, 'secret');
 } finally { await server.close(); }
 await rm(path.join(directory, 'vault-encryption.key'));
 await assert.rejects(startNotesServer({ directory, token, port: 0, version: 'test' }), /encryption key is missing/);
});

test('deleted Logins cannot be resurrected by stale writes or migration', async t => {
 const f=await fixture(t); const {instanceId}= (await f.call('/v1/health')).data;
 const original={id:'delete-me',type:'login',name:'Website',loginUrl:'https://example.com/',accounts:[{id:'a',username:'alice',password:'secret',notes:'note'}],createdAt:'2026-10-06T00:00:00.000Z',revision:0};
 await f.call('/v1/vault/import',{instanceId,records:[original]});
 const before=(await f.call('/v1/vault')).data;
 const marker={...original,deletedAt:'2026-10-06T01:00:00.000Z',revision:1};
 assert.equal((await f.call('/v1/vault/write',{instanceId,expectedRevision:before.revision,records:[marker]})).status,200);
 const after=(await f.call('/v1/vault')).data;
 assert.equal(after.records[0].name,'Deleted login'); assert.equal(after.records[0].loginUrl,''); assert.deepEqual(after.records[0].accounts,[]);
 assert.equal((await f.call('/v1/vault/write',{instanceId,expectedRevision:after.revision,records:[original]})).status,409);
 assert.equal((await f.call('/v1/vault/import',{instanceId,records:[original]})).status,409);
});
