const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs').promises;
const os = require('node:os');
const path = require('node:path');
const { NotesDatabaseSync, hashNotesDatabaseState } = require('../dist/main/s3/notesDatabaseSync');
const {
  NOTES_DATABASE_OBJECT_KEY, encryptNotesDatabase, decryptNotesDatabase,
} = require('../dist/main/s3/notesDatabaseS3');
const { normalizeS3EndpointBucket } = require('../dist/main/s3/s3Request');
const { getS3SyncEncryptionKeyId } = require('../dist/main/s3/s3SyncV4');

const KEY = Buffer.alloc(32, 0x41).toString('base64url');
const OLD_KEY = Buffer.alloc(32, 0x42).toString('base64url');
const TIME = '2026-09-12T00:00:00.000Z';
const clone = (value) => structuredClone(value);
const noLegacy = async () => undefined;

function workspace(contents = { a: 'original a', b: 'original b' }, deleted = []) {
  return {
    schemaVersion: 2,
    notes: Object.entries(contents).map(([id, content]) => ({
      id, name: `Note ${id}`, content, language: 'markdown', tags: [], createdAt: TIME, updatedAt: TIME,
    })),
    tombstones: deleted.map((id) => ({ id, deletedAt: TIME })),
    tree: {
      schemaVersion: 1,
      nodes: Object.keys(contents).map((noteId, index) => ({ noteId, parentId: null, order: index * 1024 })),
    },
  };
}

// These stand-in database bytes intentionally avoid SQLite/native modules. Only
// capture/inspect/apply know this format; the actual encrypted S3 store sees bytes.
function serialize(notes, layout = 'default') {
  return Buffer.from(JSON.stringify({ format: 'test-notes-database', layout, notes }));
}

function deserialize(bytes) {
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { /* Sanitized adapter error below. */ }
  if (value?.format !== 'test-notes-database' || !Array.isArray(value.notes?.notes)
    || !Array.isArray(value.notes?.tombstones) || !Array.isArray(value.notes?.tree?.nodes)) {
    throw new Error('Invalid Notes database contents.');
  }
  return value.notes;
}

class FakeS3 {
  objects = new Map();
  requests = [];
  writes = [];
  downloads = [];
  revision = 0;
  beforeRequest;
  beforePut;
  afterPut;

  connection(overrides = {}) {
    return {
      endpoint: 'http://localhost:9000', bucket: 'notes-one', region: 'us-east-1',
      accessKeyId: 'test-access', secretAccessKey: 'test-secret', syncEncryptionKey: KEY,
      fetchImpl: this.fetch, now: () => new Date(TIME), ...overrides,
    };
  }

  url(connection = this.connection()) {
    const target = normalizeS3EndpointBucket(connection.endpoint, connection.bucket);
    return `${target.endpoint}/${target.bucket}/${NOTES_DATABASE_OBJECT_KEY}`;
  }

  seed(notes, connection = this.connection(), bytes = serialize(notes)) {
    const object = { body: encryptNotesDatabase(bytes, connection.syncEncryptionKey), etag: `"v${++this.revision}"` };
    this.objects.set(this.url(connection), object);
    return object;
  }

  remote(connection = this.connection()) {
    const object = this.objects.get(this.url(connection));
    assert.ok(object, 'expected a published database');
    const decrypted = decryptNotesDatabase(object.body, connection.syncEncryptionKey, connection.previousSyncEncryptionKey);
    return { ...object, ...decrypted, notes: deserialize(decrypted.bytes) };
  }

  fetch = async (url, init) => {
    const request = {
      url, method: init.method, headers: { ...init.headers },
      ...(init.body ? { body: Buffer.from(init.body) } : {}),
    };
    this.requests.push(request);
    assert.equal(init.redirect, 'manual');
    assert.ok(init.signal instanceof AbortSignal);
    assert.match(init.headers.authorization, /^AWS4-HMAC-SHA256 /);
    const override = await this.beforeRequest?.(request);
    if (override) return override;
    if (init.method === 'GET') {
      const current = this.objects.get(url);
      if (!current) {
        request.status = 404;
        return new Response(null, { status: 404 });
      }
      if (init.headers['if-none-match'] === current.etag) {
        request.status = 304;
        return new Response(null, { status: 304 });
      }
      request.status = 200;
      this.downloads.push({ url, etag: current.etag, byteLength: current.body.length });
      return new Response(Buffer.from(current.body), { headers: { etag: current.etag } });
    }
    assert.equal(init.method, 'PUT');
    assert.equal(init.headers['content-type'], 'application/octet-stream');
    await this.beforePut?.(request);
    const current = this.objects.get(url);
    if (init.headers['if-none-match'] === '*') {
      assert.equal(init.headers['if-match'], undefined);
      if (current) return new Response(null, { status: 412 });
    } else {
      assert.ok(init.headers['if-match'], 'writes must be conditional');
      if (!current || init.headers['if-match'] !== current.etag) return new Response(null, { status: 412 });
    }
    const object = { body: Buffer.from(init.body), etag: `"v${++this.revision}"` };
    this.objects.set(url, object);
    this.writes.push({ url, ...object });
    await this.afterPut?.(request, object);
    return new Response(null, { headers: { etag: object.etag } });
  };
}

async function device(t, initial = workspace(), { currentHash = false } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'notes-database-sync-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const local = {
    directory, notes: clone(initial), layout: 'default', applies: [], imports: [],
    captures: 0, hashReads: 0, inspections: 0,
    beforeApply: undefined, beforeImport: undefined,
    edit(id, content) { this.notes.notes.find((note) => note.id === id).content = content; },
    async checkpoint() { return JSON.parse(await fs.readFile(path.join(directory, 'notes-database-sync.json'), 'utf8')); },
    async backups(key = KEY) {
      const location = path.join(directory, 'notes-database-recovery');
      const names = await fs.readdir(location).catch((error) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
      return Promise.all(names.map(async (name) => {
        const filename = path.join(location, name);
        const encrypted = await fs.readFile(filename);
        const decrypted = decryptNotesDatabase(encrypted, key);
        assert.doesNotMatch(encrypted.toString('utf8'), /test-notes-database/);
        assert.equal((await fs.stat(filename)).mode & 0o777, 0o600);
        assert.equal((await fs.stat(location)).mode & 0o777, 0o700);
        return { name, ...decrypted, notes: deserialize(decrypted.bytes) };
      }));
    },
    restart() { this.engine = new NotesDatabaseSync(adapter); },
    sync(connection, legacy = noLegacy) { return this.engine.sync(connection, legacy); },
  };
  const adapter = {
    userDataPath: directory,
    ...(currentHash ? { currentHash: async () => {
      local.hashReads += 1;
      return hashNotesDatabaseState(local.notes);
    } } : {}),
    capture: async () => {
      local.captures += 1;
      return { bytes: serialize(local.notes, local.layout), hash: hashNotesDatabaseState(local.notes) };
    },
    inspect: async (bytes) => {
      local.inspections += 1;
      return hashNotesDatabaseState(deserialize(bytes));
    },
    apply: async (bytes, expectedHash) => {
      await local.beforeApply?.();
      const accepted = hashNotesDatabaseState(local.notes) === expectedHash;
      local.applies.push({ bytes: Buffer.from(bytes), expectedHash, accepted });
      if (accepted) local.notes = clone(deserialize(bytes));
      return accepted;
    },
    importLegacy: async (notes, expectedHash) => {
      await local.beforeImport?.();
      const accepted = hashNotesDatabaseState(local.notes) === expectedHash;
      local.imports.push({ notes: clone(notes), expectedHash, accepted });
      if (accepted) local.notes = clone(notes);
      return accepted;
    },
  };
  local.restart();
  await local.engine.initialize();
  return local;
}

function failCheckpoint(t, local, predicate) {
  const rename = fs.rename;
  let failures = 0;
  const replacement = t.mock.method(fs, 'rename', async (source, destination) => {
    if (destination === path.join(local.directory, 'notes-database-sync.json')
      && predicate(JSON.parse(await fs.readFile(source, 'utf8')))) {
      failures += 1;
      throw new Error('Simulated checkpoint acknowledgement failure.');
    }
    return rename(source, destination);
  });
  return { restore: () => replacement.mock.restore(), failures: () => failures };
}

test('checks never transfer local changes and remote changes require manual sync', async (t) => {
  const cloud = new FakeS3();
  const local = await device(t, undefined, { currentHash: true });
  await local.sync(cloud.connection());
  const remote = workspace({ a: 'remote update', b: 'original b' });
  cloud.seed(remote);
  const before = clone(local.notes);
  const writes = cloud.writes.length;
  assert.equal(await local.engine.sync(cloud.connection(), noLegacy, 'check'), 'remote-updated');
  const downloads = cloud.downloads.length;
  assert.equal(await local.engine.sync(cloud.connection(), noLegacy, 'check'), 'remote-updated');
  assert.equal(cloud.downloads.length, downloads);
  assert.equal(await local.engine.sync(cloud.connection(), noLegacy, 'auto'), 'remote-updated');
  assert.deepEqual(local.notes, before);
  assert.equal(cloud.writes.length, writes);
  assert.equal(await local.engine.sync(cloud.connection(), noLegacy, 'manual'), 'pulled');
  assert.deepEqual(local.notes, remote);
  local.edit('b', 'only local update');
  assert.equal(await local.engine.sync(cloud.connection(), noLegacy, 'check'), 'up-to-date');
  assert.equal(cloud.writes.length, writes);
  assert.equal(await local.engine.sync(cloud.connection(), noLegacy, 'auto'), 'pushed');
});

test('checking a missing database never imports legacy or publishes; removed known database blocks sync', async (t) => {
  const cloud = new FakeS3();
  const local = await device(t);
  const legacy = async () => { throw new Error('check must not load legacy'); };
  assert.equal(await local.engine.sync(cloud.connection(), legacy, 'check'), 'up-to-date');
  assert.equal(cloud.writes.length, 0);
  await local.sync(cloud.connection());
  cloud.objects.clear();
  assert.equal(await local.engine.sync(cloud.connection(), legacy, 'check'), 'diverged');
  assert.equal(await local.engine.sync(cloud.connection(), legacy, 'manual'), 'diverged');
});

test('an identical observed database advances the common base and changed keys cannot reuse cached verification', async (t) => {
  const cloud = new FakeS3();
  const local = await device(t, undefined, { currentHash: true });
  await local.sync(cloud.connection());
  local.edit('a', 'identical change on both devices');
  cloud.seed(local.notes);
  assert.equal(await local.engine.sync(cloud.connection(), noLegacy, 'check'), 'up-to-date');
  assert.equal((await local.checkpoint()).syncedHash, hashNotesDatabaseState(local.notes));
  await assert.rejects(local.engine.sync(cloud.connection({ syncEncryptionKey: OLD_KEY }), noLegacy, 'check'));
  local.edit('b', 'new local-only change');
  assert.equal(await local.engine.sync(cloud.connection(), noLegacy, 'auto'), 'pushed');
});

test('pending upload detection includes unsaved cloud targets and clears only for matching acknowledged contents', async (t) => {
  const cloud = new FakeS3();
  const local = await device(t, undefined, { currentHash: true });
  assert.equal(await local.engine.hasPendingChanges(cloud.connection()), true);
  await local.sync(cloud.connection());
  assert.equal(await local.engine.hasPendingChanges(cloud.connection()), false);
  assert.equal(await local.engine.hasPendingChanges(cloud.connection({ bucket: 'new-bucket' })), true);
  local.edit('a', 'local changes awaiting upload');
  assert.equal(await local.engine.hasPendingChanges(cloud.connection()), true);
});

test('logical hash ignores record array ordering and binary layout but includes deletion and tree changes', async (t) => {
  const original = workspace(undefined, ['deleted-1', 'deleted-2']);
  const reordered = clone(original);
  reordered.notes.reverse();
  reordered.tombstones.reverse();
  reordered.tree.nodes.reverse();
  assert.equal(hashNotesDatabaseState(original), hashNotesDatabaseState(reordered));
  assert.deepEqual(original.notes.map((note) => note.id), ['a', 'b']);
  for (const mutate of [
    (notes) => { notes.notes[0].content = 'edited'; },
    (notes) => { notes.tombstones.pop(); },
    (notes) => { notes.tree.nodes[1].parentId = 'a'; },
    (notes) => { notes.tree.nodes[0].order += 1; },
  ]) {
    const changed = clone(original);
    mutate(changed);
    assert.notEqual(hashNotesDatabaseState(changed), hashNotesDatabaseState(original));
  }
  const cloud = new FakeS3();
  cloud.seed(reordered, cloud.connection(), serialize(reordered, 'different SQLite page layout'));
  const local = await device(t, original);
  assert.equal(await local.sync(cloud.connection()), 'up-to-date');
  assert.equal(cloud.writes.length, 0);
  assert.equal(local.applies.length, 0);
});

test('clean conditional polling downloads no database and currentHash avoids snapshot capture', async (t) => {
  for (const currentHash of [true, false]) {
    for (const restart of [true, false]) {
      await t.test(`${currentHash ? 'cheap currentHash' : 'capture fallback'}, ${restart ? 'restart' : 'same engine'}`, async (t) => {
        const cloud = new FakeS3();
        const local = await device(t, workspace(), { currentHash });
        const connection = cloud.connection();
        assert.equal(await local.sync(connection), 'pushed');
        const checkpoint = await local.checkpoint();
        assert.equal(checkpoint.remoteEtag, cloud.remote().etag);
        assert.equal(checkpoint.remoteKeyId, getS3SyncEncryptionKeyId(KEY));
        const before = {
          requests: cloud.requests.length, downloads: cloud.downloads.length, writes: cloud.writes.length,
          captures: local.captures, hashReads: local.hashReads, inspections: local.inspections,
        };
        if (restart) local.restart();
        for (let poll = 0; poll < 2; poll += 1) {
          assert.equal(await local.sync(connection), 'up-to-date');
        }
        const polls = cloud.requests.slice(before.requests);
        assert.deepEqual(polls.map((request) => [request.method, request.status]), [['GET', 304], ['GET', 304]]);
        assert.ok(polls.every((request) => request.headers['if-none-match'] === checkpoint.remoteEtag));
        assert.equal(cloud.downloads.length, before.downloads);
        assert.equal(cloud.writes.length, before.writes);
        assert.equal(local.captures - before.captures, currentHash ? 0 : 2);
        assert.equal(local.hashReads - before.hashReads, currentHash ? 2 : 0);
        assert.equal(local.inspections, before.inspections);
        assert.equal(local.applies.length, 0);
        assert.deepEqual(await local.backups(), []);
        assert.deepEqual(await local.checkpoint(), checkpoint);
      });
    }
  }
});

test('dirty conditional polling fetches the full remote after 304 and backs it up before PUT', async (t) => {
  const cloud = new FakeS3();
  const original = workspace();
  const remoteBytes = serialize(original, 'remote layout preserved in backup');
  const remote = cloud.seed(original, cloud.connection(), remoteBytes);
  const local = await device(t, original, { currentHash: true });
  assert.equal(await local.sync(cloud.connection()), 'up-to-date');
  local.edit('a', 'new local edit');
  const edited = clone(local.notes);
  const before = {
    requests: cloud.requests.length, downloads: cloud.downloads.length,
    captures: local.captures, hashReads: local.hashReads,
  };
  cloud.beforePut = async (request) => {
    assert.equal(request.headers['if-match'], remote.etag);
    const backups = await local.backups();
    assert.equal(backups.length, 1);
    assert.match(backups[0].name, /^before-push-/);
    assert.deepEqual(backups[0].bytes, remoteBytes);
    const checkpoint = await local.checkpoint();
    assert.equal(checkpoint.remoteEtag, remote.etag, 'pending publication must not change the acknowledged remote ETag');
    assert.equal(checkpoint.publishingHash, hashNotesDatabaseState(edited));
  };
  assert.equal(await local.sync(cloud.connection()), 'pushed');
  const requests = cloud.requests.slice(before.requests);
  assert.deepEqual(requests.map((request) => request.method), ['GET', 'GET', 'PUT']);
  assert.equal(requests[0].status, 304);
  assert.equal(requests[0].headers['if-none-match'], remote.etag);
  assert.equal(requests[1].status, 200);
  assert.equal(requests[1].headers['if-none-match'], undefined);
  assert.equal(cloud.downloads.length, before.downloads + 1);
  assert.equal(local.captures, before.captures + 1);
  assert.equal(local.hashReads, before.hashReads + 1);
  assert.deepEqual(cloud.remote().notes, edited);
  const checkpoint = await local.checkpoint();
  assert.equal(checkpoint.remoteEtag, cloud.remote().etag);
  assert.notEqual(checkpoint.remoteEtag, remote.etag);
  assert.equal(checkpoint.remoteKeyId, getS3SyncEncryptionKeyId(KEY));
});

test('key rotation after 304 still downloads the full database, backs it up and re-encrypts it', async (t) => {
  const cloud = new FakeS3();
  const oldConnection = cloud.connection({ syncEncryptionKey: OLD_KEY });
  const original = workspace();
  const remoteBytes = serialize(original, 'old-key remote database layout');
  const remote = cloud.seed(original, oldConnection, remoteBytes);
  const local = await device(t, original, { currentHash: true });
  assert.equal(await local.sync(oldConnection), 'up-to-date');
  assert.equal((await local.checkpoint()).remoteKeyId, getS3SyncEncryptionKeyId(OLD_KEY));
  const before = {
    requests: cloud.requests.length, downloads: cloud.downloads.length,
    captures: local.captures, hashReads: local.hashReads,
  };
  cloud.beforePut = async (request) => {
    assert.equal(request.headers['if-match'], remote.etag);
    assert.deepEqual(deserialize(decryptNotesDatabase(request.body, KEY).bytes), original);
    const backups = await local.backups(KEY);
    assert.equal(backups.length, 1);
    assert.match(backups[0].name, /^before-push-/);
    assert.deepEqual(backups[0].bytes, remoteBytes);
    assert.equal((await local.checkpoint()).remoteKeyId, getS3SyncEncryptionKeyId(OLD_KEY));
  };
  const connection = cloud.connection({ previousSyncEncryptionKey: OLD_KEY });
  assert.equal(await local.sync(connection), 'pushed');
  const requests = cloud.requests.slice(before.requests);
  assert.deepEqual(requests.map((request) => request.method), ['GET', 'GET', 'PUT']);
  assert.equal(requests[0].status, 304);
  assert.equal(requests[0].headers['if-none-match'], remote.etag);
  assert.equal(requests[1].status, 200);
  assert.equal(requests[1].headers['if-none-match'], undefined);
  assert.equal(cloud.downloads.length, before.downloads + 1);
  assert.equal(local.captures, before.captures + 1);
  assert.equal(local.hashReads, before.hashReads + 1);
  assert.equal(local.applies.length, 0);
  assert.deepEqual(cloud.remote().notes, original);
  assert.equal(cloud.remote().encryptionKeyId, getS3SyncEncryptionKeyId(KEY));
  const checkpoint = await local.checkpoint();
  assert.equal(checkpoint.remoteEtag, cloud.remote().etag);
  assert.notEqual(checkpoint.remoteEtag, remote.etag);
  assert.equal(checkpoint.remoteKeyId, getS3SyncEncryptionKeyId(KEY));
  const downloads = cloud.downloads.length;
  const captures = local.captures;
  assert.equal(await local.sync(cloud.connection()), 'up-to-date');
  assert.equal(cloud.downloads.length, downloads);
  assert.equal(local.captures, captures);
});

test('two devices editing different notes diverge and preserve both databases across restart', async (t) => {
  const cloud = new FakeS3();
  const first = await device(t);
  const second = await device(t);
  assert.equal(await first.sync(cloud.connection()), 'pushed');
  assert.equal(await second.sync(cloud.connection()), 'up-to-date');
  first.edit('a', 'device one edit');
  second.edit('b', 'device two edit');
  const lastWorkspace = clone(second.notes);
  assert.equal(await first.sync(cloud.connection()), 'pushed');
  assert.equal(await second.sync(cloud.connection()), 'diverged');
  assert.deepEqual(cloud.remote().notes, first.notes);
  assert.deepEqual(second.notes, lastWorkspace);
  second.restart();
  assert.equal(await second.sync(cloud.connection()), 'diverged');
  assert.equal(await first.sync(cloud.connection()), 'up-to-date');
});

test('remote overwrite saves exact encrypted recovery bytes before both push and pull', async (t) => {
  const cloud = new FakeS3();
  const remote = workspace({ a: 'remote a' }, ['b']);
  const remoteBytes = serialize(remote, 'remote database page layout');
  cloud.seed(remote, cloud.connection(), remoteBytes);
  const local = await device(t);
  const initialBytes = serialize(local.notes);
  assert.equal(await local.sync(cloud.connection()), 'pulled');
  const pulledBackups = await local.backups();
  assert.equal(pulledBackups.length, 1);
  assert.match(pulledBackups[0].name, /^before-pull-/);
  assert.deepEqual(pulledBackups[0].bytes, initialBytes);
  local.edit('a', 'local later edit');
  assert.equal(await local.sync(cloud.connection()), 'pushed');
  const backups = await local.backups();
  const pushedBackup = backups.find((entry) => entry.name.startsWith('before-push-'));
  assert.deepEqual(pushedBackup.bytes, remoteBytes);
  assert.deepEqual(pushedBackup.notes, remote);
  assert.deepEqual(cloud.remote().notes, local.notes);
});

test('typing after capture during publish remains dirty and is sent on the next round', async (t) => {
  const cloud = new FakeS3();
  const local = await device(t);
  await local.sync(cloud.connection());
  local.edit('a', 'captured edit');
  const captured = clone(local.notes);
  cloud.beforePut = () => { cloud.beforePut = undefined; local.edit('b', 'typed during upload'); };
  assert.equal(await local.sync(cloud.connection()), 'pushed');
  assert.deepEqual(cloud.remote().notes, captured);
  assert.equal((await local.checkpoint()).syncedHash, hashNotesDatabaseState(captured));
  assert.notEqual((await local.checkpoint()).syncedHash, hashNotesDatabaseState(local.notes));
  const latest = clone(local.notes);
  assert.equal(await local.sync(cloud.connection()), 'pushed');
  assert.deepEqual(cloud.remote().notes, latest);
  assert.equal(await local.sync(cloud.connection()), 'up-to-date');
});

test('a late editor change fences apply and blocks divergent synchronization', async (t) => {
  const cloud = new FakeS3();
  cloud.seed(workspace({ a: 'remote edit', b: 'remote b' }));
  const local = await device(t);
  const expectedHash = hashNotesDatabaseState(local.notes);
  local.beforeApply = () => { local.beforeApply = undefined; local.edit('b', 'late typed edit'); };
  assert.equal(await local.sync(cloud.connection()), 'diverged');
  assert.equal(local.applies.length, 1);
  assert.equal(local.applies[0].accepted, false);
  assert.equal(local.applies[0].expectedHash, expectedHash);
  assert.equal(local.notes.notes[0].content, 'original a');
  assert.equal(local.notes.notes[1].content, 'late typed edit');
  assert.equal(cloud.remote().notes.notes[0].content, 'remote edit');
  assert.equal(cloud.writes.length, 0);
  assert.equal(cloud.requests.filter((request) => request.method === 'GET').length, 2);
  assert.equal((await local.checkpoint()).applyingHash, undefined);
});

test('CAS collision discovers divergence instead of overwriting the competing publisher', async (t) => {
  const cloud = new FakeS3();
  const original = workspace();
  const firstRemote = cloud.seed(original);
  const local = await device(t);
  await local.sync(cloud.connection());
  local.edit('a', 'local winner');
  const intervening = workspace({ a: 'another publisher', b: 'another b' });
  let interveningEtag;
  cloud.beforePut = () => {
    cloud.beforePut = undefined;
    interveningEtag = cloud.seed(intervening).etag;
  };
  assert.equal(await local.sync(cloud.connection()), 'diverged');
  const puts = cloud.requests.filter((request) => request.method === 'PUT');
  assert.equal(puts.length, 1);
  assert.equal(puts[0].headers['if-match'], firstRemote.etag);
  assert.equal(cloud.remote().etag, interveningEtag);
  assert.equal(cloud.writes.length, 0);
  assert.deepEqual(cloud.remote().notes, intervening);
  const backups = await local.backups();
  assert.equal(backups.length, 1);
  assert.ok(backups.some((entry) => hashNotesDatabaseState(entry.notes) === hashNotesDatabaseState(original)));
});

test('a changed remote stops CAS retries immediately and retains unsynced local edits', async (t) => {
  const cloud = new FakeS3();
  cloud.seed(workspace());
  const local = await device(t);
  await local.sync(cloud.connection());
  const checkpoint = await local.checkpoint();
  local.edit('a', 'still dirty');
  const dirty = clone(local.notes);
  cloud.beforePut = () => cloud.seed(workspace({ a: `competing ${cloud.revision}`, b: 'b' }));
  assert.equal(await local.sync(cloud.connection()), 'diverged');
  assert.equal(cloud.requests.filter((request) => request.method === 'PUT').length, 1);
  assert.equal(cloud.writes.length, 0);
  assert.deepEqual(local.notes, dirty);
  assert.equal((await local.checkpoint()).syncedHash, checkpoint.syncedHash);
});

for (const failure of ['lost S3 acknowledgement', 'checkpoint acknowledgement']) {
  test(`restart recognizes its own successful publish after ${failure} failure without replay`, async (t) => {
    const cloud = new FakeS3();
    const local = await device(t);
    await local.sync(cloud.connection());
    const baseline = await local.checkpoint();
    local.edit('a', 'published before crash');
    const publishedHash = hashNotesDatabaseState(local.notes);
    let fault;
    if (failure === 'lost S3 acknowledgement') {
      cloud.afterPut = () => { cloud.afterPut = undefined; throw new Error('private transport detail'); };
    } else fault = failCheckpoint(t, local, (state) => state.syncedHash === publishedHash);
    await assert.rejects(local.sync(cloud.connection()), /request failed|acknowledgement failure/);
    assert.deepEqual(cloud.remote().notes, local.notes);
    assert.equal((await local.checkpoint()).syncedHash, baseline.syncedHash);
    if (fault) { assert.equal(fault.failures(), 1); fault.restore(); }
    const requestsBefore = cloud.requests.length;
    local.restart();
    assert.equal(await local.sync(cloud.connection()), 'up-to-date');
    assert.deepEqual(cloud.requests.slice(requestsBefore).map((request) => request.method), ['GET']);
    assert.equal((await local.checkpoint()).syncedHash, publishedHash);
  });
}

test('restart after a successful publish with failed checkpoint acknowledgement does not replay over a newer publisher', async (t) => {
  const cloud = new FakeS3();
  const local = await device(t);
  await local.sync(cloud.connection());
  local.edit('a', 'successfully published before crash');
  const publishedHash = hashNotesDatabaseState(local.notes);
  const fault = failCheckpoint(t, local, (state) => state.syncedHash === publishedHash);
  await assert.rejects(local.sync(cloud.connection()), /acknowledgement failure/);
  assert.equal(fault.failures(), 1);
  fault.restore();
  assert.deepEqual(cloud.remote().notes, local.notes);
  // Another device publishes while this device is stopped. No new local edit
  // occurred after our successful PUT, so restarting must not make us a writer.
  const newest = workspace({ a: 'newest publisher a', b: 'newest publisher b' });
  cloud.seed(newest);
  const writes = cloud.writes.length;
  local.restart();
  const result = await local.sync(cloud.connection());
  assert.deepEqual(cloud.remote().notes, newest, 'restart must preserve the later whole-database publication');
  assert.equal(hashNotesDatabaseState(local.notes), publishedHash);
  assert.equal(result, 'diverged');
  assert.equal(cloud.writes.length, writes);
});

test('failed PUT without remote advance retains local pending changes and retries the original condition', async (t) => {
  for (const existingRemote of [true, false]) {
    for (const restart of [true, false]) {
      await t.test(`${existingRemote ? 'existing remote' : 'missing remote'}, ${restart ? 'restart' : 'same engine'}`, async (t) => {
        const cloud = new FakeS3();
        const connection = cloud.connection();
        const local = await device(t);
        if (existingRemote) await local.sync(connection);
        const baseline = await local.checkpoint();
        const before = cloud.objects.get(cloud.url());
        const originalBody = before && Buffer.from(before.body);
        const originalEtag = before?.etag;
        const writes = cloud.writes.length;
        local.edit('a', 'local edit never accepted by S3');
        const pendingNotes = clone(local.notes);
        const pendingHash = hashNotesDatabaseState(pendingNotes);
        let intentAtDispatch;
        cloud.beforePut = async () => {
          intentAtDispatch = await local.checkpoint();
          throw new Error('Connection lost before S3 changed the object.');
        };

        await assert.rejects(local.sync(connection), /request failed/);
        assert.equal(intentAtDispatch.publishingHash, pendingHash, 'publish intent must be durable before dispatch');
        assert.equal(intentAtDispatch.publishingEtag, originalEtag);
        assert.equal(intentAtDispatch.syncedHash, baseline.syncedHash);
        const pending = await local.checkpoint();
        assert.equal(pending.publishingHash, pendingHash);
        assert.equal(pending.publishingEtag, originalEtag);
        assert.equal(pending.syncedHash, baseline.syncedHash, 'failed upload must not pre-acknowledge local edits');
        assert.deepEqual(local.notes, pendingNotes);
        assert.equal(local.applies.length, 0);
        assert.equal(cloud.writes.length, writes);
        assert.deepEqual(cloud.objects.get(cloud.url())?.body, originalBody);

        cloud.beforePut = undefined;
        const requests = cloud.requests.length;
        if (restart) local.restart();
        assert.equal(await local.sync(connection), 'pushed');
        const retry = cloud.requests.slice(requests);
        assert.deepEqual(retry.map((request) => request.method), existingRemote ? ['GET', 'GET', 'PUT'] : ['GET', 'PUT']);
        if (existingRemote) {
          assert.equal(retry[0].status, 304);
          assert.equal(retry[1].headers['if-none-match'], undefined);
        }
        const put = retry[retry.length - 1];
        assert.equal(put.headers['if-match'], originalEtag);
        assert.equal(put.headers['if-none-match'], existingRemote ? undefined : '*');
        assert.deepEqual(cloud.remote().notes, pendingNotes);
        assert.deepEqual(local.notes, pendingNotes);
        assert.equal(cloud.writes.length, writes + 1);
        const acknowledged = await local.checkpoint();
        assert.equal(acknowledged.syncedHash, pendingHash);
        assert.equal(acknowledged.publishingHash, undefined);
        assert.equal(acknowledged.publishingEtag, undefined);
        assert.equal(await local.sync(connection), 'up-to-date');
        assert.equal(cloud.writes.length, writes + 1);
      });
    }
  }
});

test('unknown PUT outcome followed by a later remote blocks sync and preserves both databases', async (t) => {
  for (const existingRemote of [true, false]) {
    for (const restart of [true, false]) {
      await t.test(`${existingRemote ? 'existing remote' : 'missing remote'}, ${restart ? 'restart' : 'same engine'}`, async (t) => {
        const cloud = new FakeS3();
        const connection = cloud.connection();
        const local = await device(t);
        if (existingRemote) await local.sync(connection);
        const originalEtag = cloud.objects.get(cloud.url())?.etag;
        local.edit('a', 'unpublished local edit preserved for recovery');
        local.layout = 'attempted database layout';
        const attempted = clone(local.notes);
        const attemptedBytes = serialize(attempted, local.layout);
        const writes = cloud.writes.length;
        // The server never accepts this PUT, but the engine only sees a transport
        // failure. A later publisher makes the outcome intentionally ambiguous.
        cloud.beforePut = () => { throw new Error('Upload connection lost.'); };
        await assert.rejects(local.sync(connection), /request failed/);
        const pending = await local.checkpoint();
        assert.equal(pending.publishingHash, hashNotesDatabaseState(attempted));
        assert.equal(pending.publishingEtag, originalEtag);
        assert.equal(cloud.writes.length, writes);
        cloud.beforePut = undefined;

        const later = workspace({ b: 'later publisher b', c: 'later publisher c' }, ['a']);
        const published = cloud.seed(later);
        const remoteBytes = Buffer.from(published.body);
        assert.notEqual(published.etag, originalEtag);
        const requests = cloud.requests.length;
        local.beforeApply = async () => {
          const backups = await local.backups();
          const recovery = backups.filter((entry) => entry.name.startsWith('before-pull-'));
          assert.equal(recovery.length, 1, 'local recovery must exist before applying the remote');
          assert.deepEqual(recovery[0].bytes, attemptedBytes);
          assert.deepEqual(local.notes, attempted);
        };
        if (restart) local.restart();
        assert.equal(await local.sync(connection), 'diverged');
        assert.deepEqual(cloud.requests.slice(requests).map((request) => request.method), ['GET']);
        assert.equal(cloud.writes.length, writes, 'uncertain attempt must not replay over the later publication');
        assert.deepEqual(cloud.remote().body, remoteBytes);
        assert.deepEqual(local.notes, attempted);
        assert.equal(local.applies.length, 0);
        const recovered = await local.checkpoint();
        assert.notEqual(recovered.syncedHash, hashNotesDatabaseState(later));
        assert.equal(recovered.publishingHash, hashNotesDatabaseState(attempted));
        assert.equal(recovered.publishingEtag, originalEtag);
        assert.equal(recovered.applyingHash, undefined);
        assert.equal(await local.sync(connection), 'diverged');
        assert.equal(cloud.writes.length, writes);
      });
    }
  }
});

test('restart completes an interrupted pull acknowledgement and pulls a newer remote without replaying it', async (t) => {
  const cloud = new FakeS3();
  const pulled = workspace({ a: 'pulled before crash', b: 'b' });
  cloud.seed(pulled);
  const local = await device(t);
  const pulledHash = hashNotesDatabaseState(pulled);
  const fault = failCheckpoint(t, local, (state) => state.syncedHash === pulledHash && state.applyingHash === undefined);
  await assert.rejects(local.sync(cloud.connection()), /acknowledgement failure/);
  assert.equal(fault.failures(), 1);
  fault.restore();
  assert.deepEqual(local.notes, pulled);
  assert.equal((await local.checkpoint()).applyingHash, pulledHash);
  const newer = workspace({ a: 'newest remote', b: 'newest b' });
  cloud.seed(newer);
  local.restart();
  assert.equal(await local.sync(cloud.connection()), 'pulled');
  assert.deepEqual(local.notes, newer);
  assert.equal(cloud.writes.length, 0);
  assert.equal((await local.checkpoint()).applyingHash, undefined);
});

test('failed pull intent checkpoint never applies the database or uploads', async (t) => {
  const cloud = new FakeS3();
  cloud.seed(workspace({ a: 'remote', b: 'b' }));
  const local = await device(t);
  const original = clone(local.notes);
  const fault = failCheckpoint(t, local, (state) => state.applyingHash !== undefined);
  await assert.rejects(local.sync(cloud.connection()), /acknowledgement failure/);
  fault.restore();
  assert.deepEqual(local.notes, original);
  assert.equal(local.applies.length, 0);
  assert.equal(cloud.writes.length, 0);
});

for (const withBase of [true, false]) {
  test(`legacy migration ${withBase ? 'with a committed base' : 'without a base'} imports cloud deletions instead of stale local Notes`, async (t) => {
    const cloud = new FakeS3();
    const base = workspace();
    const latest = workspace({ b: 'cloud retained b', c: 'cloud new c' }, ['a']);
    latest.tree.nodes[1].parentId = 'b';
    const local = await device(t, base);
    let loads = 0;
    const legacy = async () => { loads += 1; return { cloud: latest, ...(withBase ? { base } : {}) }; };
    assert.equal(await local.sync(cloud.connection(), legacy), 'pushed');
    assert.deepEqual(local.notes, latest);
    assert.deepEqual(cloud.remote().notes, latest);
    assert.equal(local.imports.length, 1);
    assert.equal(local.imports[0].accepted, true);
    const backups = await local.backups();
    assert.equal(backups.length, 1);
    assert.match(backups[0].name, /^migration-/);
    assert.deepEqual(backups[0].notes, base);
    local.restart();
    assert.equal(await local.sync(cloud.connection(), legacy), 'up-to-date');
    assert.equal(loads, 1);
  });
}

test('legacy migration retains local deletes and edits since the committed legacy base', async (t) => {
  const cloud = new FakeS3();
  const base = workspace();
  const edited = workspace({ b: 'local edited b' }, ['a']);
  const local = await device(t, edited);
  const legacyCloud = workspace({ a: 'stale cloud a', b: 'cloud b', c: 'cloud only' });
  const legacyBefore = clone(legacyCloud);
  assert.equal(await local.sync(cloud.connection(), async () => ({ cloud: legacyCloud, base })), 'pushed');
  assert.deepEqual(cloud.remote().notes, edited);
  assert.equal(local.imports.length, 0);
  assert.deepEqual(legacyCloud, legacyBefore);
  assert.equal((await local.checkpoint()).legacyImported, true);
  assert.deepEqual((await local.backups())[0].notes, edited);
});

test('a late edit fences legacy import and survives the migration retry', async (t) => {
  const cloud = new FakeS3();
  const local = await device(t);
  const base = clone(local.notes);
  const legacyCloud = workspace({ a: 'legacy cloud a', b: 'legacy cloud b' });
  let loads = 0;
  local.beforeImport = () => { local.beforeImport = undefined; local.edit('a', 'typed during import'); };
  assert.equal(await local.sync(cloud.connection(), async () => {
    loads += 1;
    return { cloud: legacyCloud, base };
  }), 'pushed');
  assert.equal(loads, 2);
  assert.equal(local.imports[0].accepted, false);
  assert.equal(local.notes.notes[0].content, 'typed during import');
  assert.deepEqual(cloud.remote().notes, local.notes);
});

test('existing v5 database bypasses legacy data and wins over an unchanged stale local workspace', async (t) => {
  const cloud = new FakeS3();
  const newest = workspace({ b: 'v5 retained b' }, ['a']);
  cloud.seed(newest);
  const local = await device(t);
  assert.equal(await local.sync(cloud.connection(), async () => { assert.fail('must not load legacy'); }), 'pulled');
  assert.deepEqual(local.notes, newest);
  assert.equal(cloud.writes.length, 0);
});

test('wrong key, broken authentication, malformed envelope and invalid database contents never upload', async (t) => {
  for (const scenario of ['key', 'tag', 'format', 'contents']) {
    await t.test(scenario, async (t) => {
      const cloud = new FakeS3();
      const remote = cloud.seed(workspace(), scenario === 'key' ? cloud.connection({ syncEncryptionKey: OLD_KEY }) : cloud.connection());
      if (scenario === 'tag') remote.body[92] ^= 1;
      if (scenario === 'format') remote.body = Buffer.from('malformed remote private SQL data');
      if (scenario === 'contents') remote.body = encryptNotesDatabase(Buffer.from('not a database'), KEY);
      const local = await device(t);
      local.edit('a', 'unsynced local edit');
      const unchanged = clone(local.notes);
      const originalRemote = Buffer.from(remote.body);
      await assert.rejects(local.sync(cloud.connection(), async () => { assert.fail('must not migrate'); }),
        /key does not match|authenticated|format or size is invalid|Invalid Notes database/);
      assert.deepEqual(local.notes, unchanged);
      assert.equal(local.applies.length, 0);
      assert.equal(cloud.requests.filter((request) => request.method === 'PUT').length, 0);
      assert.deepEqual(cloud.objects.get(cloud.url()).body, originalRemote);
      assert.deepEqual(await local.backups(), []);
    });
  }
});

test('key rotation first pulls a clean remote workspace then publishes it under the current key', async (t) => {
  const cloud = new FakeS3();
  const remote = workspace({ a: 'remote old-key edit', b: 'remote b' });
  cloud.seed(remote, cloud.connection({ syncEncryptionKey: OLD_KEY }));
  const local = await device(t);
  const original = clone(local.notes);
  cloud.beforePut = (request) => {
    assert.deepEqual(local.notes, remote);
    assert.equal(local.applies.length, 1);
    assert.deepEqual(deserialize(decryptNotesDatabase(request.body, KEY).bytes), remote);
  };
  const connection = cloud.connection({ previousSyncEncryptionKey: OLD_KEY });
  assert.equal(await local.sync(connection), 'pushed');
  assert.deepEqual(cloud.remote().notes, remote);
  assert.equal(cloud.remote().encryptionKeyId, getS3SyncEncryptionKeyId(KEY));
  assert.throws(() => decryptNotesDatabase(cloud.remote().body, OLD_KEY), /key does not match/);
  const backups = await local.backups();
  assert.equal(backups.length, 2);
  assert.deepEqual(backups.find((backup) => backup.name.startsWith('before-pull-')).notes, original);
  assert.deepEqual(backups.find((backup) => backup.name.startsWith('before-push-')).notes, remote);
  assert.equal(await local.sync(cloud.connection()), 'up-to-date');
});

test('rotation also re-encrypts a matching clean workspace without applying it', async (t) => {
  const cloud = new FakeS3();
  cloud.seed(workspace(), cloud.connection({ syncEncryptionKey: OLD_KEY }));
  const local = await device(t);
  assert.equal(await local.sync(cloud.connection({ previousSyncEncryptionKey: OLD_KEY })), 'pushed');
  assert.equal(local.applies.length, 0);
  assert.equal(cloud.remote().encryptionKeyId, getS3SyncEncryptionKeyId(KEY));
});

test('offline and non-404 GET errors preserve local changes and never attempt migration or upload', async (t) => {
  for (const status of ['offline', 403, 500, 503]) {
    await t.test(String(status), async (t) => {
      const cloud = new FakeS3();
      const local = await device(t);
      await local.sync(cloud.connection());
      const baseline = await local.checkpoint();
      local.edit('a', 'offline edit');
      const expected = clone(local.notes);
      const before = cloud.requests.length;
      cloud.beforeRequest = () => {
        if (status === 'offline') throw new Error('private credentials and network URL');
        return new Response('private SQL and response data', { status });
      };
      await assert.rejects(local.sync(cloud.connection(), async () => { assert.fail('must not migrate'); }),
        (error) => /request failed/.test(error.message) && !/private|credentials|SQL/.test(error.message));
      assert.deepEqual(local.notes, expected);
      assert.equal((await local.checkpoint()).syncedHash, baseline.syncedHash);
      assert.deepEqual(cloud.requests.slice(before).map((request) => request.method), ['GET']);
      cloud.beforeRequest = undefined;
      assert.equal(await local.sync(cloud.connection()), 'pushed');
      assert.deepEqual(cloud.remote().notes, expected);
    });
  }
});

test('offline legacy loading and cancelled sync cannot publish an apparently missing database', async (t) => {
  const cloud = new FakeS3();
  const local = await device(t);
  await assert.rejects(local.sync(cloud.connection(), async () => { throw new Error('Legacy cloud unavailable.'); }), /Legacy cloud unavailable/);
  assert.equal(cloud.writes.length, 0);
  assert.notEqual((await local.checkpoint()).legacyImported, true);
  const controller = new AbortController();
  controller.abort();
  const before = cloud.requests.length;
  await assert.rejects(local.sync(cloud.connection({ signal: controller.signal })), /cancelled/);
  assert.equal(cloud.requests.length, before);
});

for (const changedTarget of [{ endpoint: 'http://localhost:9001' }, { bucket: 'notes-two' }]) {
  test(`switching ${Object.keys(changedTarget)[0]} isolates its baseline and pulls instead of replaying a clean old-target publish`, async (t) => {
    const cloud = new FakeS3();
    const local = await device(t);
    const firstConnection = cloud.connection();
    await local.sync(firstConnection);
    local.edit('a', 'published to first target');
    await local.sync(firstConnection);
    const firstBytes = Buffer.from(cloud.remote(firstConnection).body);
    const nextConnection = cloud.connection(changedTarget);
    const nextWorkspace = workspace({ a: 'second target a', b: 'second target b' });
    cloud.seed(nextWorkspace, nextConnection);
    const result = await local.sync(nextConnection);
    assert.deepEqual(cloud.remote(nextConnection).notes, nextWorkspace);
    assert.deepEqual(local.notes, nextWorkspace);
    assert.equal(result, 'pulled');
    assert.deepEqual(cloud.remote(firstConnection).body, firstBytes);
  });
}

test('equivalent normalized endpoint/bucket spellings retain the current clean baseline', async (t) => {
  const cloud = new FakeS3();
  const local = await device(t);
  await local.sync(cloud.connection());
  local.edit('a', 'already published');
  await local.sync(cloud.connection());
  const newer = workspace({ a: 'newer remote a', b: 'newer remote b' });
  cloud.seed(newer);
  const writes = cloud.writes.length;
  const result = await local.sync(cloud.connection({ endpoint: 'http://LOCALHOST:9000/', bucket: ' notes-one ' }));
  assert.deepEqual(cloud.remote().notes, newer);
  assert.deepEqual(local.notes, newer);
  assert.equal(result, 'pulled');
  assert.equal(cloud.writes.length, writes);
});
