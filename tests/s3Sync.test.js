const assert = require('node:assert/strict');
const { mkdtemp, readFile, readdir, rm, stat, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  S3SyncRuntime,
  buildS3SnapshotObjectUrl,
  canonicalizeS3Path,
  createServiceManagerSnapshot,
  decryptS3Snapshot,
  encryptS3Snapshot,
  measureBoundedJsonBytes,
  signS3PutRequest,
  validateS3SyncSettingsDraft,
} = require('../dist/main/s3Sync');
const { createS3SharedAppDataV2 } = require('../dist/main/s3DataMerge');
const {
  decryptS3RevisionV2,
} = require('../dist/main/s3SyncV2');
const {
  createS3SyncHeadV3,
  createServiceManagerNoteObjectV3,
  createServiceManagerNotesTreeObjectV3,
  createServiceManagerSyncManifestV3,
  buildS3V3HeadObjectUrl,
  buildS3V3ManifestObjectUrl,
  buildS3V3NoteObjectUrl,
  buildS3V3NotesTreeObjectUrl,
  encryptS3ManifestV3,
  encryptS3NoteV3,
  encryptS3NotesTreeV3,
  getS3SyncEncryptionKeyId,
  hashS3V3NoteContent,
  hashS3V3NotesTreeContent,
  hashS3V3Object,
  serializeEncryptedS3ObjectV3,
} = require('../dist/main/s3SyncV3');

const ACCESS_KEY = 'AKIDEXAMPLE';
const SECRET_KEY = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';
const SYNC_KEY = Buffer.alloc(32, 0x5a).toString('base64url');
const ENDPOINT = 'https://s3.example.test';
const BUCKET = 'example-bucket';
const BUCKET_URL = `${ENDPOINT}/${BUCKET}`;
const T0 = '2026-07-18T04:05:06.000Z';
const T1 = '2026-07-18T05:05:06.000Z';
const T2 = '2026-07-18T06:05:06.000Z';

function fakeProtector() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`protected:${value}`, 'utf8'),
    decryptString: (value) => {
      const text = value.toString('utf8');
      if (!text.startsWith('protected:')) throw new Error('unreadable');
      return text.slice('protected:'.length);
    },
  };
}

function settingsDraft(overrides = {}) {
  return {
    endpoint: ENDPOINT,
    bucket: BUCKET,
    region: 'us-east-1',
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET_KEY,
    ...overrides,
  };
}

function note(id, content, updatedAt = T0, overrides = {}) {
  return {
    id,
    name: `Note ${id}`,
    content,
    language: 'markdown',
    tags: ['shared'],
    createdAt: T0,
    updatedAt,
    ...overrides,
  };
}

function sharedData(notes = [], hosts = [], noteTombstones = [], notesTree) {
  return createS3SharedAppDataV2({
    hosts,
    notes: { schemaVersion: 1, notes },
    notesTree: notesTree ?? {
      schemaVersion: 1,
      nodes: notes.map((item, index) => ({
        noteId: item.id,
        parentId: null,
        order: (index + 1) * 1024,
      })),
    },
    noteTombstones,
    proxy: {
      settings: {
        mode: 'rule',
        customRules: [],
      },
    },
  });
}

function host(id, name) {
  return {
    id,
    name,
    sshHost: 'host.example.test',
    sshPort: 22,
    username: 'developer',
    authType: 'password',
    password: 'host-password',
    jumpHosts: [],
    forwards: [],
    services: [],
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function png(width = 320, height = 180) {
  const bytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'service-manager-s3-sync-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function writeConfiguredSettings(directory, clientId, overrides = {}) {
  const protector = fakeProtector();
  await writeFile(path.join(directory, 's3-sync.json'), JSON.stringify({
    schemaVersion: 6,
    endpoint: ENDPOINT,
    bucket: BUCKET,
    region: 'us-east-1',
    clientId,
    encryptedAccessKeyId: protector.encryptString(ACCESS_KEY).toString('base64'),
    encryptedSecretAccessKey: protector.encryptString(SECRET_KEY).toString('base64'),
    encryptedSyncEncryptionKey: protector.encryptString(SYNC_KEY).toString('base64'),
    ...overrides,
  }));
}

function createRevisionFactory(clientId) {
  let revision = 0;
  return () => `${clientId}-revision-${++revision}`;
}

function createObjectIdFactory(clientId) {
  let object = 0;
  return () => `${clientId}-note-${++object}`;
}

async function createRuntime(t, options) {
  const userDataPath = await temporaryDirectory(t);
  await writeConfiguredSettings(userDataPath, options.clientId, options.persistedSettings);
  const state = { data: clone(options.data), applied: [] };
  const syncStates = [];
  const runtime = new S3SyncRuntime({
    userDataPath,
    appVersion: '0.3.19',
    credentialProtector: fakeProtector(),
    snapshotProvider: async () => clone(state.data),
    snapshotApplier: async (data, expectedLocal) => {
      if (options.snapshotApplier) {
        return options.snapshotApplier({ data, expectedLocal, state });
      }
      state.data = clone(data);
      state.applied.push(clone(data));
    },
    fetchImpl: options.fetchImpl,
    now: options.now ?? (() => new Date(T0)),
    createRevision: options.createRevision ?? createRevisionFactory(options.clientId),
    createObjectId: options.createObjectId ?? createObjectIdFactory(options.clientId),
    createClientId: () => options.clientId,
    createRandomBytes: (size) => Buffer.alloc(size, size),
    onStateChanged: (next) => {
      const snapshot = clone(next);
      syncStates.push(snapshot);
      options.onStateChanged?.(snapshot);
    },
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
  });
  t.after(() => runtime.shutdown());
  return { runtime, state, syncStates, userDataPath };
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

class MemoryS3 {
  constructor() {
    this.calls = [];
    this.objects = new Map();
    this.nextEtag = 1;
    this.headBarrier = undefined;
    this.fetch = this.fetch.bind(this);
  }

  get headUrl() {
    return buildS3V3HeadObjectUrl(ENDPOINT, BUCKET);
  }

  get head() {
    return this.objects.get(this.headUrl);
  }

  raceNextConditionalHeadWrites(count = 2) {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const timer = setTimeout(() => release(), 1_000);
    this.headBarrier = {
      remaining: count,
      gate,
      release: () => {
        clearTimeout(timer);
        release();
      },
    };
  }

  async fetch(url, options = {}) {
    const request = {
      url: String(url),
      method: options.method ?? 'GET',
      headers: new Headers(options.headers),
      body: options.body,
    };
    this.calls.push(request);
    if (options.signal?.aborted) throw new Error('aborted request');

    if (request.method === 'GET') {
      const object = this.objects.get(request.url);
      if (!object) return new Response('', { status: 404 });
      return new Response(object.body, {
        status: 200,
        headers: { etag: object.etag },
      });
    }

    if (request.method !== 'PUT') return new Response('', { status: 405 });
    const ifMatch = request.headers.get('if-match');
    const ifNoneMatch = request.headers.get('if-none-match');
    if (request.url === this.headUrl && ifMatch && this.headBarrier) {
      const barrier = this.headBarrier;
      barrier.remaining -= 1;
      if (barrier.remaining === 0) {
        this.headBarrier = undefined;
        barrier.release();
      }
      await barrier.gate;
    }

    const current = this.objects.get(request.url);
    if (ifNoneMatch === '*' && current) return new Response('', { status: 412 });
    if (ifMatch !== null && (!current || current.etag !== ifMatch)) {
      return new Response('', { status: 412 });
    }
    const etag = `"memory-etag-${this.nextEtag++}"`;
    this.objects.set(request.url, { body: String(request.body ?? ''), etag });
    return new Response('', { status: 200, headers: { etag } });
  }
}

function serializedRemoteNote(entry) {
  return serializeEncryptedS3ObjectV3(encryptS3NoteV3(
    createServiceManagerNoteObjectV3(entry.note, entry.objectId),
    SYNC_KEY,
    (size) => Buffer.alloc(size, size),
  ));
}

function seedRemoteNotesTree(s3, noteIds, objectId, syncKey = SYNC_KEY) {
  const tree = {
    schemaVersion: 1,
    root: [...noteIds],
    order: Object.fromEntries(noteIds.map((noteId, index) => [noteId, (index + 1) * 1024])),
    parent: Object.fromEntries(noteIds.map((noteId) => [noteId, null])),
  };
  const object = createServiceManagerNotesTreeObjectV3(tree, objectId);
  const body = serializeEncryptedS3ObjectV3(encryptS3NotesTreeV3(
    object,
    syncKey,
    (size) => Buffer.alloc(size, size),
  ));
  const reference = {
    objectId,
    sha256: hashS3V3Object(body),
    contentHash: hashS3V3NotesTreeContent(tree),
    encryptionKeyId: getS3SyncEncryptionKeyId(syncKey),
  };
  s3.objects.set(buildS3V3NotesTreeObjectUrl(ENDPOINT, BUCKET, objectId), {
    body,
    etag: '"seed-tree"',
  });
  return reference;
}

function seedGeneratedV3Manifest(s3, entries, revision = 'remote-revision-1') {
  const references = entries.map((entry) => {
    const body = serializedRemoteNote(entry);
    return {
      id: entry.note.id,
      objectId: entry.objectId,
      sha256: hashS3V3Object(body),
      contentHash: hashS3V3NoteContent(entry.note),
      encryptionKeyId: getS3SyncEncryptionKeyId(SYNC_KEY),
    };
  });
  const tree = seedRemoteNotesTree(
    s3,
    entries.map((entry) => entry.note.id),
    `${revision}-tree`,
  );
  const manifest = createServiceManagerSyncManifestV3({
    schemaVersion: 4,
    hosts: { schemaVersion: 1, items: [] },
    notes: { schemaVersion: 4, items: references, tombstones: [], tree },
    proxy: { schemaVersion: 1, settings: { mode: 'rule', customRules: [] } },
  }, {
    appVersion: '0.3.19',
    revision,
    clientId: 'remote-client',
    createdAt: T0,
  });
  const manifestBody = serializeEncryptedS3ObjectV3(encryptS3ManifestV3(
    manifest,
    SYNC_KEY,
    (size) => Buffer.alloc(size, size),
  ));
  const head = createS3SyncHeadV3(
    manifest,
    hashS3V3Object(manifestBody),
    getS3SyncEncryptionKeyId(SYNC_KEY),
  );
  s3.objects.set(buildS3V3ManifestObjectUrl(ENDPOINT, BUCKET, revision), {
    body: manifestBody,
    etag: '"seed-manifest"',
  });
  s3.objects.set(buildS3V3HeadObjectUrl(ENDPOINT, BUCKET), {
    body: JSON.stringify(head),
    etag: '"seed-head"',
  });
  return references;
}

function generatedNoteFetch(s3, entries, missingObjectIds = new Set()) {
  const entryByUrl = new Map(entries.map((entry) => [
    buildS3V3NoteObjectUrl(ENDPOINT, BUCKET, entry.objectId),
    entry,
  ]));
  const stats = { noteGets: 0 };
  return {
    stats,
    fetch: async (url, options = {}) => {
      const objectUrl = String(url);
      const entry = entryByUrl.get(objectUrl);
      if ((options.method ?? 'GET') === 'GET' && entry) {
        stats.noteGets += 1;
        if (missingObjectIds.has(entry.objectId)) return new Response('', { status: 404 });
        return new Response(serializedRemoteNote(entry), {
          status: 200,
          headers: { etag: '"generated-note"' },
        });
      }
      return s3.fetch(url, options);
    },
  };
}

test('S3 runtime keeps Notes image upload and load on the configured private target', async (t) => {
  const s3 = new MemoryS3();
  const work = await createRuntime(t, {
    clientId: 'notes-image-client',
    data: sharedData(),
    fetchImpl: s3.fetch,
  });
  const source = png(640, 360);
  const uploaded = await work.runtime.uploadNoteImage({
    bytes: new Uint8Array(source),
    mimeType: 'image/png',
    alt: 'Preview',
  });
  assert.equal(uploaded.status, 'uploaded');
  assert.match(
    s3.calls.at(-1).url,
    /\/example-bucket\/service-manager\/v4\/images\/[A-Za-z0-9_-]{32}\.json$/,
  );
  assert.equal(s3.calls.at(-1).headers.get('if-none-match'), '*');
  assert.doesNotMatch(JSON.stringify(uploaded), /AKIDEXAMPLE|EXAMPLEKEY|s3\.example/);

  const loaded = await work.runtime.loadNoteImage(uploaded.reference);
  assert.equal(loaded.status, 'loaded');
  assert.equal(loaded.mimeType, 'image/png');
  assert.deepEqual(Buffer.from(loaded.bytes), source);

  const objectUrl = s3.calls.at(-1).url;
  s3.objects.delete(objectUrl);
  assert.deepEqual(await work.runtime.loadNoteImage(uploaded.reference), { status: 'missing' });
  assert.deepEqual(
    await work.runtime.loadNoteImage({ ...uploaded.reference, objectId: 'invalid' }),
    { status: 'error' },
  );
});

test('S3 runtime reports Notes image storage as unavailable until Endpoint, Bucket, AK, and SK are saved', async (t) => {
  const userDataPath = await temporaryDirectory(t);
  let fetchCalls = 0;
  const runtime = new S3SyncRuntime({
    userDataPath,
    appVersion: '0.3.20',
    credentialProtector: fakeProtector(),
    snapshotProvider: async () => sharedData(),
    fetchImpl: async () => {
      fetchCalls += 1;
      return new Response('', { status: 500 });
    },
  });
  t.after(() => runtime.shutdown());
  assert.deepEqual(
    await runtime.uploadNoteImage({ bytes: new Uint8Array(png()), mimeType: 'image/png' }),
    { status: 'not-configured' },
  );
  assert.equal(fetchCalls, 0);
});

test('S3 settings validation accepts a root endpoint and a separate bucket', () => {
  assert.deepEqual(validateS3SyncSettingsDraft(settingsDraft()), settingsDraft());
  assert.equal(
    validateS3SyncSettingsDraft(settingsDraft({ endpoint: `${ENDPOINT}/` })).endpoint,
    ENDPOINT,
  );
  assert.deepEqual(
    validateS3SyncSettingsDraft(settingsDraft({ syncEncryptionKey: SECRET_KEY })),
    settingsDraft({ syncEncryptionKey: SECRET_KEY }),
  );
  assert.throws(
    () => validateS3SyncSettingsDraft(settingsDraft({ syncEncryptionKey: '12345678' })),
    /at least 9 characters/,
  );
  assert.deepEqual(
    validateS3SyncSettingsDraft(settingsDraft({
      endpoint: 'http://localhost:9000',
      bucket: 'service-manager.backup',
    })),
    settingsDraft({ endpoint: 'http://localhost:9000', bucket: 'service-manager.backup' }),
  );

  assert.throws(
    () => validateS3SyncSettingsDraft(settingsDraft({ endpoint: 'http://s3.example.test' })),
    /must use HTTPS unless it targets localhost/,
  );
  assert.throws(
    () => validateS3SyncSettingsDraft(settingsDraft({ endpoint: `${ENDPOINT}/${BUCKET}` })),
    /cannot contain a bucket path/,
  );
  assert.throws(
    () => validateS3SyncSettingsDraft(settingsDraft({ endpoint: 'https://user:pass@s3.example.test' })),
    /cannot contain credentials/,
  );
  assert.throws(
    () => validateS3SyncSettingsDraft(settingsDraft({ bucket: 'UPPERCASE' })),
    /DNS-compatible/,
  );
  assert.throws(
    () => validateS3SyncSettingsDraft(settingsDraft({ bucket: 'ab' })),
    /DNS-compatible/,
  );
  assert.throws(
    () => validateS3SyncSettingsDraft({ ...settingsDraft(), secretAccessKey: undefined }),
    /Both the S3 access key ID and secret access key/,
  );
  assert.deepEqual(
    validateS3SyncSettingsDraft({ ...settingsDraft(), syncVersion: 99 }),
    settingsDraft(),
    'the object layout version is internal and cannot be selected by the renderer',
  );
});

test('legacy v1 object layout still isolates clients and immutable revisions', () => {
  const first = buildS3SnapshotObjectUrl(`${BUCKET_URL}/`, 'client-a', 'revision-1');
  const secondRevision = buildS3SnapshotObjectUrl(BUCKET_URL, 'client-a', 'revision-2');
  const secondClient = buildS3SnapshotObjectUrl(BUCKET_URL, 'client-b', 'revision-1');

  assert.equal(first, `${BUCKET_URL}/service-manager/v1/clients/client-a/revision-1.json`);
  assert.equal(new Set([first, secondRevision, secondClient]).size, 3);
  assert.throws(
    () => buildS3SnapshotObjectUrl(BUCKET_URL, '../client', 'revision-1'),
    /client identity is invalid/,
  );
  assert.throws(
    () => buildS3SnapshotObjectUrl(BUCKET_URL, 'client-a', '../revision'),
    /snapshot revision is invalid/,
  );
});

test('legacy v1 S3 SigV4 signing has a fixed canonical request and signature', () => {
  const signed = signS3PutRequest({
    endpoint: 'https://s3.example.test/example-bucket/folder/hello world+中文.json',
    region: 'us-east-1',
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET_KEY,
    payload: '{"hello":"world"}',
    now: new Date(T0),
  });

  assert.equal(
    canonicalizeS3Path('/example-bucket/folder/hello world+中文.json'),
    '/example-bucket/folder/hello%20world%2B%E4%B8%AD%E6%96%87.json',
  );
  assert.equal(
    signed.url,
    'https://s3.example.test/example-bucket/folder/hello%20world%2B%E4%B8%AD%E6%96%87.json',
  );
  assert.equal(signed.headers['x-amz-date'], '20260718T040506Z');
  assert.equal(signed.headers['x-amz-content-sha256'], '93a23971a914e5eacbf0a8d25154cda309c3c1c72fbb9914d47c60f3cb681588');
  assert.equal(signed.signature, '40acdd6f330996e93b4f6eb383c6787c4e3483253ccf1dfc03fa9397cf64b7f1');
  assert.match(
    signed.headers.authorization,
    /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20260718\/us-east-1\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=40acdd/,
  );
});

test('legacy v1 snapshot encryption round-trips and rejects authenticated-data tampering', () => {
  const snapshot = createServiceManagerSnapshot(
    { notes: [{ name: 'deploy', content: 'echo hello' }], hosts: [{ password: 'host-password' }] },
    '0.3.19',
    'fixed-revision',
    T0,
  );
  const encrypted = encryptS3Snapshot(snapshot, SECRET_KEY, (size) => Buffer.alloc(size, size));

  assert.deepEqual(decryptS3Snapshot(encrypted, SECRET_KEY), snapshot);
  assert.doesNotMatch(JSON.stringify(encrypted), /host-password|echo hello|deploy/);

  const bytes = Buffer.from(encrypted.ciphertext, 'base64');
  bytes[0] ^= 0xff;
  const tampered = { ...encrypted, ciphertext: bytes.toString('base64') };
  assert.throws(
    () => decryptS3Snapshot(tampered, SECRET_KEY),
    /^Error: Encrypted S3 snapshot could not be decrypted\.$/,
  );
  assert.throws(
    () => decryptS3Snapshot(encrypted, 'wrong-secret'),
    /^Error: Encrypted S3 snapshot could not be decrypted\.$/,
  );
});

test('legacy v1 snapshot size is rejected before whole-snapshot serialization', () => {
  assert.equal(measureBoundedJsonBytes({ notes: [{ content: 'hello' }] }, 64), 31);
  for (const value of ['quote"slash\\', '\u0000\b\t\n\f\r', '中文🙂', '\ud800']) {
    assert.equal(measureBoundedJsonBytes({ value }, 1_024), Buffer.byteLength(JSON.stringify({ value }), 'utf8'));
  }
  for (const value of [new Array(3), Object.assign(new Array(3), { 1: 'x' })]) {
    assert.equal(measureBoundedJsonBytes(value, 1_024), Buffer.byteLength(JSON.stringify(value), 'utf8'));
  }
  assert.throws(
    () => measureBoundedJsonBytes({ notes: [{ content: 'x'.repeat(128) }] }, 64),
    /snapshot is too large to sync/,
  );
  const circular = {};
  circular.self = circular;
  assert.throws(() => measureBoundedJsonBytes(circular, 1_024), /could not be serialized/);
});

test('S3SyncRuntime stores Endpoint and Bucket separately with protected credentials', async (t) => {
  const userDataPath = await temporaryDirectory(t);
  const runtime = new S3SyncRuntime({
    userDataPath,
    appVersion: '0.3.19',
    credentialProtector: fakeProtector(),
    snapshotProvider: async () => sharedData(),
    createClientId: () => 'client-1',
  });

  const saved = await runtime.saveSettings(settingsDraft());
  assert.equal(saved.endpoint, ENDPOINT);
  assert.equal(saved.bucket, BUCKET);
  assert.equal(saved.region, 'us-east-1');
  assert.equal(saved.hasCredentials, true);
  assert.equal(saved.hasSyncEncryptionKey, true);
  assert.equal(saved.syncState.status, 'pending');
  assert.doesNotMatch(JSON.stringify(saved), /AKIDEXAMPLE|wJalr|encrypted/i);
  const revealed = await runtime.revealS3SyncCredentials();
  assert.equal(revealed.accessKeyId, ACCESS_KEY);
  assert.equal(revealed.secretAccessKey, SECRET_KEY);
  assert.match(revealed.syncEncryptionKey, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(saved.syncEncryptionKey, undefined);

  const settingsPath = path.join(userDataPath, 's3-sync.json');
  const persistedText = await readFile(settingsPath, 'utf8');
  const persisted = JSON.parse(persistedText);
  assert.equal(persisted.schemaVersion, 6);
  assert.equal(persisted.endpoint, ENDPOINT);
  assert.equal(persisted.bucket, BUCKET);
  assert.equal(persisted.clientId, 'client-1');
  assert.equal(typeof persisted.encryptedSyncEncryptionKey, 'string');
  assert.equal(typeof persisted.pendingSince, 'string');
  assert.equal('bucketUrl' in persisted, false);
  assert.equal('syncVersion' in persisted, false);
  assert.doesNotMatch(persistedText, /AKIDEXAMPLE|wJalr/);
  assert.doesNotMatch(persistedText, new RegExp(revealed.syncEncryptionKey));
  if (process.platform !== 'win32') assert.equal((await stat(settingsPath)).mode & 0o777, 0o600);
  await runtime.shutdown();
});

test('S3SyncRuntime lets Settings replace a corrupt local settings file', async (t) => {
  const userDataPath = await temporaryDirectory(t);
  const settingsPath = path.join(userDataPath, 's3-sync.json');
  await writeFile(settingsPath, '{not-json');
  const runtime = new S3SyncRuntime({
    userDataPath,
    appVersion: '0.3.19',
    credentialProtector: fakeProtector(),
    snapshotProvider: async () => sharedData(),
    createClientId: () => 'recovered-client',
  });

  const brokenView = await runtime.getSettings();
  assert.equal(brokenView.endpoint, '');
  assert.equal(brokenView.hasCredentials, false);
  assert.equal(brokenView.syncState.status, 'error');
  assert.match(brokenView.syncState.message, /could not be loaded/);

  const saved = await runtime.saveSettings(settingsDraft());
  assert.equal(saved.hasCredentials, true);
  assert.equal(saved.syncState.status, 'pending');
  await runtime.shutdown();

  const persisted = JSON.parse(await readFile(settingsPath, 'utf8'));
  assert.equal(persisted.schemaVersion, 6);
  assert.equal(persisted.clientId, 'recovered-client');
  assert.equal(persisted.endpoint, ENDPOINT);
  assert.equal(persisted.bucket, BUCKET);
});

test('S3SyncRuntime preserves its merge base across AK, Region, and temporary credential clearing', async (t) => {
  const userDataPath = await temporaryDirectory(t);
  const settingsPath = path.join(userDataPath, 's3-sync.json');
  await writeConfiguredSettings(userDataPath, 'stable-client', {
    lastRevision: 'stable-v3-base',
    lastSyncedAt: T0,
  });
  const createRuntime = () => new S3SyncRuntime({
    userDataPath,
    appVersion: '0.3.19',
    credentialProtector: fakeProtector(),
    snapshotProvider: async () => sharedData(),
    createClientId: () => 'must-not-replace-stable-client',
  });

  let runtime = createRuntime();
  await runtime.saveSettings(settingsDraft({
    region: 'eu-west-1',
    accessKeyId: 'ROTATEDAK',
  }));
  await runtime.shutdown();
  let persisted = JSON.parse(await readFile(settingsPath, 'utf8'));
  assert.equal(persisted.lastRevision, 'stable-v3-base');
  assert.equal(persisted.lastSyncedAt, T0);
  assert.equal(typeof persisted.encryptedSyncEncryptionKey, 'string');

  runtime = createRuntime();
  await runtime.saveSettings({
    endpoint: ENDPOINT,
    bucket: BUCKET,
    region: 'eu-west-1',
    clearCredentials: true,
  });
  await runtime.shutdown();
  persisted = JSON.parse(await readFile(settingsPath, 'utf8'));
  assert.equal(persisted.lastRevision, 'stable-v3-base');
  assert.equal('encryptedAccessKeyId' in persisted, false);
  assert.equal('encryptedSecretAccessKey' in persisted, false);
  assert.equal(typeof persisted.encryptedSyncEncryptionKey, 'string');
  assert.deepEqual(await runtime.revealS3SyncCredentials(), { syncEncryptionKey: SYNC_KEY });
  assert.doesNotMatch(JSON.stringify(persisted), new RegExp(SECRET_KEY.replace(/[+]/g, '\\+')));

  runtime = createRuntime();
  await runtime.saveSettings(settingsDraft({ region: 'eu-west-1', accessKeyId: 'RESTOREDAK' }));
  await runtime.shutdown();
  persisted = JSON.parse(await readFile(settingsPath, 'utf8'));
  assert.equal(persisted.lastRevision, 'stable-v3-base');

  runtime = createRuntime();
  await runtime.saveSettings(settingsDraft({
    region: 'eu-west-1',
    accessKeyId: 'DIFFERENTAK',
    secretAccessKey: 'different-encryption-secret',
  }));
  await runtime.shutdown();
  persisted = JSON.parse(await readFile(settingsPath, 'utf8'));
  assert.equal(persisted.lastRevision, 'stable-v3-base');
  assert.equal(persisted.lastSyncedAt, T0);
});

test('changing Endpoint or Bucket creates a fresh key unless an explicit shared key is supplied', async (t) => {
  const userDataPath = await temporaryDirectory(t);
  await writeConfiguredSettings(userDataPath, 'target-client', {
    lastRevision: 'old-target-revision',
    lastSyncedAt: T0,
  });
  const runtime = new S3SyncRuntime({
    userDataPath,
    appVersion: '0.3.19',
    credentialProtector: fakeProtector(),
    snapshotProvider: async () => sharedData(),
    createRandomBytes: (size) => Buffer.alloc(size, 0x33),
  });

  await runtime.saveSettings(settingsDraft({
    endpoint: 'https://other-s3.example.test',
    syncEncryptionKey: SYNC_KEY,
  }));
  let revealed = await runtime.revealS3SyncCredentials();
  assert.equal(revealed.syncEncryptionKey, Buffer.alloc(32, 0x33).toString('base64url'));
  let persisted = JSON.parse(await readFile(path.join(userDataPath, 's3-sync.json'), 'utf8'));
  assert.equal('lastRevision' in persisted, false);
  assert.equal('lastSyncedAt' in persisted, false);

  const supplied = Buffer.alloc(32, 0x44).toString('base64url');
  await runtime.saveSettings(settingsDraft({
    endpoint: 'https://third-s3.example.test',
    syncEncryptionKey: supplied,
  }));
  revealed = await runtime.revealS3SyncCredentials();
  assert.equal(revealed.syncEncryptionKey, supplied);
  persisted = JSON.parse(await readFile(path.join(userDataPath, 's3-sync.json'), 'utf8'));
  assert.equal('encryptedPreviousSyncEncryptionKey' in persisted, false);
  await runtime.shutdown();
});

test('S3SyncRuntime persists pending local intent across shutdown and clears it after success', async (t) => {
  const s3 = new MemoryS3();
  const work = await createRuntime(t, {
    clientId: 'pending-client',
    data: sharedData([note('note-1', 'initial')]),
    fetchImpl: s3.fetch,
  });
  await work.runtime.syncAllDataToS3();
  const settingsPath = path.join(work.userDataPath, 's3-sync.json');
  let persisted = JSON.parse(await readFile(settingsPath, 'utf8'));
  assert.equal('pendingSince' in persisted, false);

  work.state.data = sharedData([note('note-1', 'offline edit', T1)]);
  work.runtime.markLocalChange();
  await work.runtime.shutdown();
  persisted = JSON.parse(await readFile(settingsPath, 'utf8'));
  assert.equal(typeof persisted.pendingSince, 'string');

  const reopened = new S3SyncRuntime({
    userDataPath: work.userDataPath,
    appVersion: '0.3.19',
    credentialProtector: fakeProtector(),
    snapshotProvider: async () => clone(work.state.data),
    snapshotApplier: async (data) => { work.state.data = clone(data); },
    fetchImpl: s3.fetch,
    now: () => new Date(T1),
    createRevision: createRevisionFactory('pending-reopened'),
    createObjectId: createObjectIdFactory('pending-reopened'),
    createClientId: () => 'must-not-replace-pending-client',
    createRandomBytes: (size) => Buffer.alloc(size, size),
  });
  const reopenedView = await reopened.getSettings();
  assert.equal(reopenedView.syncState.status, 'pending');
  assert.equal(reopenedView.syncState.pending, true);
  await reopened.syncAllDataToS3();
  await reopened.shutdown();
  persisted = JSON.parse(await readFile(settingsPath, 'utf8'));
  assert.equal('pendingSince' in persisted, false);
});

test('S3SyncRuntime persists a new local pending intent while an S3 request is still active', async (t) => {
  const s3 = new MemoryS3();
  let releaseRequest;
  let markRequestStarted;
  const requestGate = new Promise((resolve) => { releaseRequest = resolve; });
  const requestStarted = new Promise((resolve) => { markRequestStarted = resolve; });
  let requestBlocked = false;
  const fetchImpl = async (url, options) => {
    if (
      !requestBlocked
      && (options.method ?? 'GET') === 'PUT'
      && String(url).includes('/service-manager/v4/notes-trees/')
    ) {
      requestBlocked = true;
      markRequestStarted();
      await requestGate;
    }
    return s3.fetch(url, options);
  };
  const work = await createRuntime(t, {
    clientId: 'pending-during-request',
    data: sharedData([note('note-1', 'initial')]),
    fetchImpl,
  });

  const syncing = work.runtime.syncAllDataToS3();
  await requestStarted;
  try {
    const progressBeforeEdit = work.runtime.getSyncState();
    assert.equal(progressBeforeEdit.status, 'syncing');
    assert.equal(progressBeforeEdit.phase, 'uploading');
    assert.deepEqual(
      [progressBeforeEdit.completedItems, progressBeforeEdit.totalItems],
      [1, 4],
    );
    work.state.data = sharedData([note('note-1', 'edited while syncing', T1)]);
    work.runtime.markLocalChange();

    const settingsPath = path.join(work.userDataPath, 's3-sync.json');
    const deadline = Date.now() + 2_000;
    let persisted;
    while (!persisted?.pendingSince && Date.now() < deadline) {
      persisted = JSON.parse(await readFile(settingsPath, 'utf8'));
      if (!persisted.pendingSince) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(typeof persisted?.pendingSince, 'string');
    const progressAfterEdit = work.runtime.getSyncState();
    assert.equal(progressAfterEdit.pending, true);
    assert.equal(progressAfterEdit.status, 'syncing');
    assert.equal(progressAfterEdit.phase, progressBeforeEdit.phase);
    assert.equal(progressAfterEdit.completedItems, progressBeforeEdit.completedItems);
    assert.equal(progressAfterEdit.totalItems, progressBeforeEdit.totalItems);
  } finally {
    releaseRequest();
    await syncing;
  }
});

test('S3SyncRuntime migrates schema 1 through 4 settings without retaining an old cloud merge base', async (t) => {
  const protector = fakeProtector();
  const encryptedAccessKeyId = protector.encryptString(ACCESS_KEY).toString('base64');
  const encryptedSecretAccessKey = protector.encryptString(SECRET_KEY).toString('base64');
  const cases = [
    {
      name: 'schema 1',
      value: {
        schemaVersion: 1,
        endpoint: `${BUCKET_URL}/service-manager/snapshot.json`,
        region: 'us-east-1',
        syncVersion: 1,
        encryptedAccessKeyId,
        encryptedSecretAccessKey,
        lastSyncedAt: T0,
        lastRevision: 'legacy-revision',
      },
      expectedClientId: 'migrated-client',
      createClientId: () => 'migrated-client',
    },
    {
      name: 'schema 2',
      value: {
        schemaVersion: 2,
        bucketUrl: BUCKET_URL,
        region: 'us-east-1',
        clientId: 'stable-schema-2-client',
        encryptedAccessKeyId,
        encryptedSecretAccessKey,
        lastSyncedAt: T0,
        lastRevision: 'legacy-revision',
      },
      expectedClientId: 'stable-schema-2-client',
      createClientId: () => {
        throw new Error('schema 2 must preserve its stable client identity');
      },
    },
    {
      name: 'schema 3',
      value: {
        schemaVersion: 3,
        endpoint: ENDPOINT,
        bucket: BUCKET,
        region: 'us-east-1',
        clientId: 'stable-schema-3-client',
        encryptedAccessKeyId,
        encryptedSecretAccessKey,
        lastSyncedAt: T0,
        lastRevision: 'legacy-v2-head-revision',
      },
      expectedClientId: 'stable-schema-3-client',
      createClientId: () => {
        throw new Error('schema 3 must preserve its stable client identity');
      },
    },
    {
      name: 'schema 4',
      value: {
        schemaVersion: 4,
        endpoint: ENDPOINT,
        bucket: BUCKET,
        region: 'us-east-1',
        clientId: 'stable-schema-4-client',
        encryptedAccessKeyId,
        encryptedSecretAccessKey,
        encryptedSecretKeyFingerprint: protector.encryptString('0'.repeat(64)).toString('base64'),
        lastSyncedAt: T0,
        lastRevision: 'retired-sk-encrypted-v3-revision',
      },
      expectedClientId: 'stable-schema-4-client',
      createClientId: () => {
        throw new Error('schema 4 must preserve its stable client identity');
      },
    },
  ];

  for (const migration of cases) {
    await t.test(migration.name, async () => {
      const userDataPath = await temporaryDirectory(t);
      const settingsPath = path.join(userDataPath, 's3-sync.json');
      await writeFile(settingsPath, JSON.stringify(migration.value));
      const runtime = new S3SyncRuntime({
        userDataPath,
        appVersion: '0.3.19',
        credentialProtector: protector,
        snapshotProvider: async () => sharedData(),
        createClientId: migration.createClientId,
        createRandomBytes: (size) => Buffer.alloc(size, 0x37),
      });

      const view = await runtime.getSettings();
      assert.equal(view.endpoint, ENDPOINT);
      assert.equal(view.bucket, BUCKET);
      assert.equal(view.hasCredentials, true);
      assert.equal(view.hasSyncEncryptionKey, true);
      assert.equal(view.lastRevision, undefined, 'older cloud-layout state is not a v3 manifest base');
      const migrated = JSON.parse(await readFile(settingsPath, 'utf8'));
      assert.equal(migrated.schemaVersion, 6);
      assert.equal(migrated.endpoint, ENDPOINT);
      assert.equal(migrated.bucket, BUCKET);
      assert.equal(migrated.clientId, migration.expectedClientId);
      assert.equal('bucketUrl' in migrated, false);
      assert.equal('syncVersion' in migrated, false);
      assert.equal('lastRevision' in migrated, false);
      const revealed = await runtime.revealS3SyncCredentials();
      assert.equal(revealed.accessKeyId, ACCESS_KEY);
      assert.equal(revealed.secretAccessKey, SECRET_KEY);
      assert.equal(revealed.syncEncryptionKey, Buffer.alloc(32, 0x37).toString('base64url'));
      assert.equal('encryptedSecretKeyFingerprint' in migrated, false);
      await runtime.shutdown();
    });
  }
});

test('schema 5 migration keeps credentials and the independent Sync Key but clears every v3 merge marker', async (t) => {
  const userDataPath = await temporaryDirectory(t);
  const protector = fakeProtector();
  const settingsPath = path.join(userDataPath, 's3-sync.json');
  await writeFile(settingsPath, JSON.stringify({
    schemaVersion: 5,
    endpoint: ENDPOINT,
    bucket: BUCKET,
    region: 'us-east-1',
    clientId: 'v3-client',
    encryptedAccessKeyId: protector.encryptString(ACCESS_KEY).toString('base64'),
    encryptedSecretAccessKey: protector.encryptString(SECRET_KEY).toString('base64'),
    encryptedSyncEncryptionKey: protector.encryptString(SYNC_KEY).toString('base64'),
    encryptedPreviousSyncEncryptionKey: 'retired-v3-state-is-not-validated',
    lastSyncedAt: T0,
    lastRevision: 'v3-merge-base',
    pendingSince: T1,
  }));
  const runtime = new S3SyncRuntime({
    userDataPath,
    appVersion: '0.3.19',
    credentialProtector: protector,
    snapshotProvider: async () => sharedData(),
    createClientId: () => { throw new Error('the stable client ID must be retained'); },
  });

  const view = await runtime.getSettings();
  assert.equal(view.hasCredentials, true);
  assert.equal(view.hasSyncEncryptionKey, true);
  assert.equal(view.lastSyncedAt, undefined);
  assert.equal(view.lastRevision, undefined);
  const revealed = await runtime.revealS3SyncCredentials();
  assert.equal(revealed.syncEncryptionKey, SYNC_KEY);
  const migrated = JSON.parse(await readFile(settingsPath, 'utf8'));
  assert.equal(migrated.schemaVersion, 6);
  assert.equal(migrated.clientId, 'v3-client');
  assert.equal('encryptedPreviousSyncEncryptionKey' in migrated, false);
  assert.equal('lastSyncedAt' in migrated, false);
  assert.equal('lastRevision' in migrated, false);
  assert.equal('pendingSince' in migrated, false);
  await runtime.shutdown();
});

test('S3SyncRuntime refuses Electron basic_text credential storage', async (t) => {
  const userDataPath = await temporaryDirectory(t);
  const protector = {
    ...fakeProtector(),
    getSelectedStorageBackend: () => 'basic_text',
  };
  const runtime = new S3SyncRuntime({
    userDataPath,
    appVersion: '0.3.19',
    credentialProtector: protector,
    snapshotProvider: async () => sharedData(),
  });

  await assert.rejects(runtime.saveSettings(settingsDraft()), /Secure credential storage is unavailable/);
  const settings = await runtime.getSettings();
  assert.equal(settings.endpoint, '');
  assert.equal(settings.bucket, '');
  assert.equal(settings.hasCredentials, false);
  assert.equal(settings.hasSyncEncryptionKey, false);
  assert.equal(settings.syncState.status, 'not-configured');
  await assert.rejects(runtime.revealS3SyncCredentials(), /unavailable/);
  await runtime.shutdown();
});

test('S3 reconciliation publishes concise bounded progress and clears it at completion', async (t) => {
  const s3 = new MemoryS3();
  const work = await createRuntime(t, {
    clientId: 'progress-push',
    data: sharedData([note('private-note-id', 'private content')]),
    fetchImpl: s3.fetch,
  });

  const result = await work.runtime.syncAllDataToS3();
  assert.equal(result.action, 'pushed');
  const syncingStates = work.syncStates.filter((state) => state.status === 'syncing');
  const phases = syncingStates.map((state) => state.phase);
  assert.equal(phases[0], 'checking');
  assert.ok(phases.includes('reading-local'));
  assert.ok(phases.includes('uploading'));
  assert.equal(phases.at(-1), 'finishing');

  const uploadStates = syncingStates.filter((state) => state.phase === 'uploading');
  assert.deepEqual(
    [uploadStates[0].completedItems, uploadStates[0].totalItems],
    [0, 4],
  );
  assert.deepEqual(
    [uploadStates.at(-1).completedItems, uploadStates.at(-1).totalItems],
    [4, 4],
  );
  for (const state of uploadStates) {
    assert.ok(Number.isSafeInteger(state.completedItems));
    assert.ok(Number.isSafeInteger(state.totalItems));
    assert.ok(state.completedItems >= 0 && state.completedItems <= state.totalItems);
  }
  assert.doesNotMatch(
    JSON.stringify(syncingStates),
    /s3\.example|example-bucket|private-note-id|private content|progress-push-revision/,
  );

  const finalState = work.runtime.getSyncState();
  assert.equal(finalState.status, 'synced');
  assert.equal('phase' in finalState, false);
  assert.equal('completedItems' in finalState, false);
  assert.equal('totalItems' in finalState, false);
});

test('S3 pull progress counts every cloud Note and tree before applying data', async (t) => {
  const s3 = new MemoryS3();
  const entries = [
    { note: note('remote-a', 'A'), objectId: 'remote-object-a' },
    { note: note('remote-b', 'B'), objectId: 'remote-object-b' },
  ];
  seedGeneratedV3Manifest(s3, entries);
  const remote = generatedNoteFetch(s3, entries);
  const work = await createRuntime(t, {
    clientId: 'progress-pull',
    data: sharedData(),
    fetchImpl: remote.fetch,
  });

  const result = await work.runtime.syncAllDataToS3();
  assert.equal(result.action, 'pulled');
  const readStates = work.syncStates.filter((state) => state.phase === 'reading-cloud');
  assert.deepEqual(
    readStates.map((state) => [state.completedItems, state.totalItems]),
    [[0, 3], [1, 3], [2, 3], [3, 3]],
  );
  assert.ok(work.syncStates.some((state) => state.phase === 'merging'));
  assert.ok(work.syncStates.some((state) => state.phase === 'applying'));
  assert.equal(work.syncStates.at(-1).status, 'synced');
  assert.equal('phase' in work.syncStates.at(-1), false);
});

test('v4 reconcile uploads each Note and the tree independently before its manifest and conditional head', async (t) => {
  const s3 = new MemoryS3();
  const data = sharedData([note('note-1', '# deploy')]);
  const { runtime, userDataPath } = await createRuntime(t, {
    clientId: 'home',
    data,
    fetchImpl: s3.fetch,
  });

  const result = await runtime.syncAllDataToS3();
  assert.equal(result.action, 'pushed');
  assert.equal(result.revision, 'home-revision-1');
  assert.ok(result.byteLength > 0);
  assert.ok(s3.objects.has(buildS3V3NoteObjectUrl(ENDPOINT, BUCKET, 'home-note-1')));
  assert.ok(s3.objects.has(buildS3V3ManifestObjectUrl(ENDPOINT, BUCKET, result.revision)));
  assert.ok(s3.objects.has(buildS3V3HeadObjectUrl(ENDPOINT, BUCKET)));
  assert.ok(s3.objects.has(buildS3V3NotesTreeObjectUrl(ENDPOINT, BUCKET, 'home-note-2')));
  assert.equal(s3.calls.filter((call) => call.method === 'PUT').length, 4);
  assert.equal(s3.calls.find((call) => call.url.endsWith('/notes/home-note-1.json')).headers.get('if-none-match'), '*');
  assert.equal(s3.calls.find((call) => call.url.endsWith('/manifests/home-revision-1.json')).headers.get('if-none-match'), '*');
  assert.equal(s3.calls.find((call) => call.url.endsWith('/head.json') && call.method === 'PUT').headers.get('if-none-match'), '*');
  assert.equal(s3.calls.some((call) => /\/service-manager\/v[123]\//.test(call.url)), false);
  assert.doesNotMatch([...s3.objects.values()].map((value) => value.body).join('\n'), /# deploy/);

  const persisted = await readFile(path.join(userDataPath, 's3-sync.json'), 'utf8');
  assert.doesNotMatch(persisted, /AKIDEXAMPLE|wJalr|# deploy/);
  const view = await runtime.getSettings();
  assert.equal(view.lastRevision, result.revision);
  assert.equal(view.syncState.status, 'synced');
  assert.equal(view.syncState.pending, false);
});

test('v4 reconciliation reuses unchanged Note and tree references and transfers only the edited Note object', async (t) => {
  const s3 = new MemoryS3();
  const client = await createRuntime(t, {
    clientId: 'home',
    data: sharedData([
      note('note-a', 'A base'),
      note('note-b', 'B base'),
    ]),
    fetchImpl: s3.fetch,
  });
  await client.runtime.syncAllDataToS3();

  const initialNotePuts = s3.calls.filter((call) =>
    call.method === 'PUT' && call.url.includes('/service-manager/v4/notes/')
  );
  assert.equal(initialNotePuts.length, 2);

  client.state.data = sharedData([
    note('note-a', 'A edited', T1),
    note('note-b', 'B base'),
  ]);
  const result = await client.runtime.syncAllDataToS3();
  assert.equal(result.action, 'pushed');

  const notePuts = s3.calls.filter((call) =>
    call.method === 'PUT' && call.url.includes('/service-manager/v4/notes/')
  );
  assert.equal(notePuts.length, 3, 'only one new immutable Note object should be uploaded');
  assert.match(notePuts.at(-1).url, /\/notes\/home-note-4\.json$/);
  assert.equal(
    s3.calls.filter((call) => call.method === 'GET' && call.url.includes('/service-manager/v4/notes/')).length,
    1,
    'only the edited Note needs its previous cloud body for the three-way merge',
  );
});

test('v4 uploads a changed Notes tree without rewriting unchanged Note objects', async (t) => {
  const s3 = new MemoryS3();
  const notes = [note('parent', 'Parent'), note('child', 'Child')];
  const client = await createRuntime(t, {
    clientId: 'tree-client',
    data: sharedData(notes),
    fetchImpl: s3.fetch,
  });
  await client.runtime.syncAllDataToS3();
  const notePutsBefore = s3.calls.filter((call) =>
    call.method === 'PUT' && call.url.includes('/service-manager/v4/notes/')
  ).length;
  const treePutsBefore = s3.calls.filter((call) =>
    call.method === 'PUT' && call.url.includes('/service-manager/v4/notes-trees/')
  ).length;

  client.state.data = sharedData(notes, [], [], {
    schemaVersion: 1,
    nodes: [
      { noteId: 'parent', parentId: null, order: 1024 },
      { noteId: 'child', parentId: 'parent', order: 1024 },
    ],
  });
  assert.equal((await client.runtime.syncAllDataToS3()).action, 'pushed');

  assert.equal(s3.calls.filter((call) =>
    call.method === 'PUT' && call.url.includes('/service-manager/v4/notes/')
  ).length, notePutsBefore);
  assert.equal(s3.calls.filter((call) =>
    call.method === 'PUT' && call.url.includes('/service-manager/v4/notes-trees/')
  ).length, treePutsBefore + 1);
});

test('v4 pull downloads only the one remotely changed Note object', async (t) => {
  const s3 = new MemoryS3();
  const base = sharedData([
    note('note-a', 'A base'),
    note('note-b', 'B base'),
    note('note-c', 'C base'),
  ]);
  const home = await createRuntime(t, { clientId: 'home', data: base, fetchImpl: s3.fetch });
  const work = await createRuntime(t, { clientId: 'work', data: sharedData(), fetchImpl: s3.fetch });
  await home.runtime.syncAllDataToS3();
  await work.runtime.syncAllDataToS3();

  home.state.data = sharedData([
    note('note-a', 'A changed remotely', T1),
    note('note-b', 'B base'),
    note('note-c', 'C base'),
  ]);
  await home.runtime.syncAllDataToS3();
  const getsBeforePull = s3.calls.filter((call) =>
    call.method === 'GET' && call.url.includes('/service-manager/v4/notes/')
  ).length;

  const result = await work.runtime.syncAllDataToS3();
  const pullNoteGets = s3.calls.filter((call) =>
    call.method === 'GET' && call.url.includes('/service-manager/v4/notes/')
  ).length - getsBeforePull;
  assert.equal(result.action, 'pulled');
  assert.equal(pullNoteGets, 1, 'unchanged local Note bodies must satisfy their immutable cloud references');
  assert.deepEqual(
    work.state.data.notes.notes.map((item) => [item.id, item.content]),
    [['note-a', 'A changed remotely'], ['note-b', 'B base'], ['note-c', 'C base']],
  );
});

test('v4 materialization stops before downloading all Notes after the 50 MiB aggregate budget is exceeded', async (t) => {
  const s3 = new MemoryS3();
  // NUL occupies one JavaScript character but six JSON bytes ("\\u0000").
  // Every Note shares the same string allocation; encrypted bodies are
  // generated only when requested, so this exercises the wire-size budget
  // without retaining a large fixture in memory.
  const escapedContent = '\0'.repeat(200_000);
  const entries = Array.from({ length: 56 }, (_, index) => ({
    objectId: `oversized-object-${index}`,
    note: note(`oversized-note-${index}`, escapedContent),
  }));
  seedGeneratedV3Manifest(s3, entries);
  const generated = generatedNoteFetch(s3, entries);
  const client = await createRuntime(t, {
    clientId: 'bounded-reader',
    data: sharedData(),
    fetchImpl: generated.fetch,
  });

  await assert.rejects(
    client.runtime.syncAllDataToS3(),
    /application data snapshot is too large to sync/,
  );
  await new Promise((resolve) => setTimeout(resolve, 100));

  const oneNoteBytes = Buffer.byteLength(JSON.stringify(entries[0].note), 'utf8');
  const notesWithinBudget = Math.floor((50 * 1024 * 1024) / oneNoteBytes);
  assert.ok(
    generated.stats.noteGets <= notesWithinBudget + 4,
    `expected at most one four-request in-flight window past the byte budget, got ${generated.stats.noteGets}`,
  );
  assert.ok(generated.stats.noteGets < entries.length, 'the remaining manifest references must not be fetched');
});

test('v4 materialization stops dispatching work after the first missing Note object', async (t) => {
  const s3 = new MemoryS3();
  const entries = Array.from({ length: 24 }, (_, index) => ({
    objectId: `missing-batch-object-${index}`,
    note: note(`missing-batch-note-${index}`, `body ${index}`),
  }));
  seedGeneratedV3Manifest(s3, entries);
  const generated = generatedNoteFetch(s3, entries, new Set([entries[0].objectId]));
  const client = await createRuntime(t, {
    clientId: 'missing-reader',
    data: sharedData(),
    fetchImpl: generated.fetch,
  });

  await assert.rejects(
    client.runtime.syncAllDataToS3(),
    /manifest points to a missing Note object/,
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(
    generated.stats.noteGets <= 4,
    `only the initial concurrency window may start, got ${generated.stats.noteGets} Note GETs`,
  );
});

test('v4 reconciliation leaves legacy v1, v2, and v3 cloud objects untouched and unread', async (t) => {
  const s3 = new MemoryS3();
  const legacyObjects = new Map([
    [`${BUCKET_URL}/service-manager/v1/clients/old/revision.json`, { body: 'legacy-v1', etag: '"v1"' }],
    [`${BUCKET_URL}/service-manager/v2/head.json`, { body: 'legacy-v2', etag: '"v2"' }],
    [`${BUCKET_URL}/service-manager/v3/head.json`, { body: 'legacy-v3', etag: '"v3"' }],
  ]);
  for (const [url, value] of legacyObjects) s3.objects.set(url, { ...value });
  const client = await createRuntime(t, {
    clientId: 'current',
    data: sharedData([note('current-note', 'v4 only')]),
    fetchImpl: s3.fetch,
  });

  assert.equal((await client.runtime.syncAllDataToS3()).action, 'pushed');
  assert.equal(s3.calls.some((call) => /\/service-manager\/v[123]\//.test(call.url)), false);
  for (const [url, value] of legacyObjects) assert.deepEqual(s3.objects.get(url), value);
});

test('a second independent client automatically pulls the shared cloud head', async (t) => {
  const s3 = new MemoryS3();
  const cloudData = sharedData([note('cloud-note', 'created at home')]);
  const home = await createRuntime(t, {
    clientId: 'home',
    data: cloudData,
    fetchImpl: s3.fetch,
  });
  assert.equal((await home.runtime.syncAllDataToS3()).action, 'pushed');

  const work = await createRuntime(t, {
    clientId: 'work',
    data: sharedData(),
    fetchImpl: s3.fetch,
  });
  await work.runtime.startAutoSync();
  await waitFor(
    () => work.state.applied.length === 1 && work.runtime.getSyncState().status === 'synced',
    'the second client did not automatically finish pulling cloud data',
  );

  assert.deepEqual(work.state.data.notes.notes, cloudData.notes.notes);
  assert.deepEqual(work.state.data.notes.tree, cloudData.notes.tree);
  assert.equal(work.runtime.getSyncState().status, 'synced');
  assert.equal(work.runtime.getSyncState().lastRevision, 'home-revision-1');
  assert.equal(
    s3.calls.filter((call) => call.url.includes('/service-manager/v1/clients/')).length,
    0,
    'v4 clients must coordinate through one shared head without reading v1 objects',
  );
});

test('two clients keep syncing after one rotates only its S3 AK and SK', async (t) => {
  const s3 = new MemoryS3();
  const home = await createRuntime(t, {
    clientId: 'home-key-rotation',
    data: sharedData([note('shared-key-note', 'before rotation')]),
    fetchImpl: s3.fetch,
  });
  const work = await createRuntime(t, {
    clientId: 'work-key-rotation',
    data: sharedData(),
    fetchImpl: s3.fetch,
  });
  await home.runtime.syncAllDataToS3();
  await work.runtime.syncAllDataToS3();
  const baseRevision = work.runtime.getSyncState().lastRevision;

  await work.runtime.saveSettings(settingsDraft({
    accessKeyId: 'ROTATEDACCESSKEY',
    secretAccessKey: 'rotated-s3-signing-secret',
  }));
  assert.equal((await work.runtime.getSettings()).lastRevision, baseRevision);
  assert.equal((await work.runtime.revealS3SyncCredentials()).syncEncryptionKey, SYNC_KEY);

  home.state.data = sharedData([note('shared-key-note', 'after rotation', T1)]);
  await home.runtime.syncAllDataToS3();
  assert.equal((await work.runtime.syncAllDataToS3()).action, 'pulled');
  assert.equal(work.state.data.notes.notes[0].content, 'after rotation');
  await Promise.all([home.runtime.shutdown(), work.runtime.shutdown()]);
});

test('a client with a different Sync Encryption Key fails closed without replacing cloud data', async (t) => {
  const s3 = new MemoryS3();
  const home = await createRuntime(t, {
    clientId: 'correct-key-client',
    data: sharedData([note('cloud-key-note', 'must survive')]),
    fetchImpl: s3.fetch,
  });
  await home.runtime.syncAllDataToS3();
  const originalHead = s3.head.body;
  const protector = fakeProtector();
  const wrongKey = Buffer.alloc(32, 0x7f).toString('base64url');
  const work = await createRuntime(t, {
    clientId: 'wrong-key-client',
    data: sharedData([note('local-key-note', 'must not overwrite')]),
    fetchImpl: s3.fetch,
    persistedSettings: {
      encryptedSyncEncryptionKey: protector.encryptString(wrongKey).toString('base64'),
    },
  });

  await assert.rejects(work.runtime.syncAllDataToS3(), /Sync Encryption Key does not match/);
  assert.equal(s3.head.body, originalHead);
  assert.equal(work.state.applied.length, 0);
  assert.equal(work.runtime.getSyncState().status, 'error');
  await Promise.all([home.runtime.shutdown(), work.runtime.shutdown()]);
});

test('an explicit Sync Key repairs unreadable current and previous safeStorage values without losing the merge base', async (t) => {
  const s3 = new MemoryS3();
  const data = sharedData([note('repair-key-note', 'cloud remains canonical')]);
  const home = await createRuntime(t, {
    clientId: 'repair-key-home',
    data,
    fetchImpl: s3.fetch,
  });
  const pushed = await home.runtime.syncAllDataToS3();
  const originalHead = s3.head.body;
  const unreadableCiphertext = Buffer.from('not-a-fake-protector-value', 'utf8').toString('base64');

  const repaired = await createRuntime(t, {
    clientId: 'repair-key-client',
    data,
    fetchImpl: s3.fetch,
    persistedSettings: {
      encryptedSyncEncryptionKey: unreadableCiphertext,
      encryptedPreviousSyncEncryptionKey: unreadableCiphertext,
      lastRevision: pushed.revision,
      lastSyncedAt: T0,
    },
  });
  const saved = await repaired.runtime.saveSettings(settingsDraft({ syncEncryptionKey: SYNC_KEY }));
  assert.equal(saved.lastRevision, pushed.revision);
  let persisted = JSON.parse(await readFile(path.join(repaired.userDataPath, 's3-sync.json'), 'utf8'));
  assert.equal('encryptedPreviousSyncEncryptionKey' in persisted, false);
  assert.equal(
    fakeProtector().decryptString(Buffer.from(persisted.encryptedSyncEncryptionKey, 'base64')),
    SYNC_KEY,
  );
  assert.equal((await repaired.runtime.syncAllDataToS3()).action, 'up-to-date');
  assert.equal(s3.head.body, originalHead);

  const wrongKey = Buffer.alloc(32, 0x6d).toString('base64url');
  const wrong = await createRuntime(t, {
    clientId: 'repair-key-wrong-client',
    data,
    fetchImpl: s3.fetch,
    persistedSettings: {
      encryptedSyncEncryptionKey: unreadableCiphertext,
      encryptedPreviousSyncEncryptionKey: unreadableCiphertext,
      lastRevision: pushed.revision,
      lastSyncedAt: T0,
    },
  });
  const wrongSaved = await wrong.runtime.saveSettings(settingsDraft({ syncEncryptionKey: wrongKey }));
  assert.equal(wrongSaved.lastRevision, pushed.revision);
  persisted = JSON.parse(await readFile(path.join(wrong.userDataPath, 's3-sync.json'), 'utf8'));
  assert.equal('encryptedPreviousSyncEncryptionKey' in persisted, false);
  await assert.rejects(wrong.runtime.syncAllDataToS3(), /Sync Encryption Key does not match/);
  assert.equal(s3.head.body, originalHead);

  await Promise.all([home.runtime.shutdown(), repaired.runtime.shutdown(), wrong.runtime.shutdown()]);
});

test('an intentional Sync Encryption Key change retains the old key until all live objects are rewritten', async (t) => {
  const s3 = new MemoryS3();
  const client = await createRuntime(t, {
    clientId: 'encryption-key-rotation',
    data: sharedData([note('rotation-note', 'rotate me')]),
    fetchImpl: s3.fetch,
  });
  await client.runtime.syncAllDataToS3();
  const rotatedKey = Buffer.alloc(32, 0x61).toString('base64url');
  await client.runtime.saveSettings(settingsDraft({ syncEncryptionKey: rotatedKey }));
  let persisted = JSON.parse(await readFile(path.join(client.userDataPath, 's3-sync.json'), 'utf8'));
  assert.equal(typeof persisted.encryptedPreviousSyncEncryptionKey, 'string');

  const result = await client.runtime.syncAllDataToS3();
  assert.equal(result.action, 'pushed');
  const head = JSON.parse(s3.head.body);
  assert.equal(head.encryptionKeyId, getS3SyncEncryptionKeyId(rotatedKey));
  const manifestEnvelope = JSON.parse(
    s3.objects.get(buildS3V3ManifestObjectUrl(ENDPOINT, BUCKET, result.revision)).body,
  );
  assert.equal(manifestEnvelope.encryption.keyId, getS3SyncEncryptionKeyId(rotatedKey));
  persisted = JSON.parse(await readFile(path.join(client.userDataPath, 's3-sync.json'), 'utf8'));
  assert.equal('encryptedPreviousSyncEncryptionKey' in persisted, false);
  assert.equal((await client.runtime.revealS3SyncCredentials()).syncEncryptionKey, rotatedKey);
  await client.runtime.shutdown();
});

test('a manifest cannot mix Note references encrypted under another key identity', async (t) => {
  const s3 = new MemoryS3();
  const mixedNote = note('mixed-note', 'mixed encryption must fail');
  const objectId = 'mixed-note-object';
  const noteBody = serializedRemoteNote({ objectId, note: mixedNote });
  s3.objects.set(buildS3V3NoteObjectUrl(ENDPOINT, BUCKET, objectId), {
    body: noteBody,
    etag: '"mixed-note"',
  });
  const tree = seedRemoteNotesTree(s3, [mixedNote.id], 'mixed-notes-tree');
  const manifest = createServiceManagerSyncManifestV3({
    schemaVersion: 4,
    hosts: { schemaVersion: 1, items: [] },
    notes: {
      schemaVersion: 4,
      items: [{
        id: mixedNote.id,
        objectId,
        sha256: hashS3V3Object(noteBody),
        contentHash: hashS3V3NoteContent(mixedNote),
        encryptionKeyId: getS3SyncEncryptionKeyId(Buffer.alloc(32, 0x7e).toString('base64url')),
      }],
      tombstones: [],
      tree,
    },
    proxy: { schemaVersion: 1, settings: { mode: 'rule', customRules: [] } },
  }, {
    appVersion: '0.3.19',
    revision: 'mixed-encryption-revision',
    clientId: 'malformed-client',
    createdAt: T0,
  });
  const manifestBody = serializeEncryptedS3ObjectV3(encryptS3ManifestV3(
    manifest,
    SYNC_KEY,
    (size) => Buffer.alloc(size, size),
  ));
  s3.objects.set(buildS3V3ManifestObjectUrl(ENDPOINT, BUCKET, manifest.revision), {
    body: manifestBody,
    etag: '"mixed-manifest"',
  });
  s3.objects.set(buildS3V3HeadObjectUrl(ENDPOINT, BUCKET), {
    body: JSON.stringify(createS3SyncHeadV3(
      manifest,
      hashS3V3Object(manifestBody),
      getS3SyncEncryptionKeyId(SYNC_KEY),
    )),
    etag: '"mixed-head"',
  });
  const client = await createRuntime(t, {
    clientId: 'mixed-reader',
    data: sharedData([mixedNote]),
    fetchImpl: s3.fetch,
  });

  await assert.rejects(client.runtime.syncAllDataToS3(), /mixes Note objects encrypted with a different key/);
  assert.equal(
    s3.calls.filter((call) => call.method === 'GET' && call.url.includes('/notes/')).length,
    0,
    'reference identity validation must run even when the local Note body matches',
  );
});

test('a manifest cannot reference a Notes tree encrypted under another key identity', async (t) => {
  const s3 = new MemoryS3();
  const wrongKey = Buffer.alloc(32, 0x7d).toString('base64url');
  const tree = seedRemoteNotesTree(s3, [], 'mixed-key-tree', wrongKey);
  const manifest = createServiceManagerSyncManifestV3({
    schemaVersion: 4,
    hosts: { schemaVersion: 1, items: [] },
    notes: { schemaVersion: 4, items: [], tombstones: [], tree },
    proxy: { schemaVersion: 1, settings: { mode: 'rule', customRules: [] } },
  }, {
    appVersion: '0.3.19',
    revision: 'mixed-tree-encryption-revision',
    clientId: 'malformed-tree-client',
    createdAt: T0,
  });
  const manifestBody = serializeEncryptedS3ObjectV3(encryptS3ManifestV3(
    manifest,
    SYNC_KEY,
    (size) => Buffer.alloc(size, size),
  ));
  s3.objects.set(buildS3V3ManifestObjectUrl(ENDPOINT, BUCKET, manifest.revision), {
    body: manifestBody,
    etag: '"mixed-tree-manifest"',
  });
  s3.objects.set(buildS3V3HeadObjectUrl(ENDPOINT, BUCKET), {
    body: JSON.stringify(createS3SyncHeadV3(
      manifest,
      hashS3V3Object(manifestBody),
      getS3SyncEncryptionKeyId(SYNC_KEY),
    )),
    etag: '"mixed-tree-head"',
  });
  const client = await createRuntime(t, {
    clientId: 'mixed-tree-reader',
    data: sharedData(),
    fetchImpl: s3.fetch,
  });

  await assert.rejects(
    client.runtime.syncAllDataToS3(),
    /Notes tree encrypted with a different key/,
  );
  assert.equal(s3.calls.filter((call) => call.url.includes('/notes-trees/')).length, 0);
});

test('a late local edit fences cloud apply and is reconciled before advancing the local base', async (t) => {
  const s3 = new MemoryS3();
  const home = await createRuntime(t, {
    clientId: 'home',
    data: sharedData([note('cloud-note', 'cloud body')]),
    fetchImpl: s3.fetch,
  });
  await home.runtime.syncAllDataToS3();

  const userDataPath = await temporaryDirectory(t);
  await writeConfiguredSettings(userDataPath, 'work');
  const state = { data: sharedData(), applyAttempts: 0 };
  const runtime = new S3SyncRuntime({
    userDataPath,
    appVersion: '0.3.19',
    credentialProtector: fakeProtector(),
    snapshotProvider: async () => clone(state.data),
    snapshotApplier: async (data, expectedLocal) => {
      state.applyAttempts += 1;
      if (state.applyAttempts === 1) {
        assert.deepEqual(expectedLocal, sharedData());
        state.data = sharedData([note('late-note', 'typed during apply', T1)]);
        return false;
      }
      state.data = clone(data);
      return true;
    },
    fetchImpl: s3.fetch,
    now: () => new Date(T2),
    createRevision: createRevisionFactory('work'),
    createClientId: () => 'work',
    createRandomBytes: (size) => Buffer.alloc(size, size),
  });
  t.after(() => runtime.shutdown());

  const result = await runtime.syncAllDataToS3();
  assert.equal(result.action, 'pushed');
  assert.equal(state.applyAttempts, 2);
  assert.deepEqual(
    state.data.notes.notes.map((item) => [item.id, item.content]),
    [['cloud-note', 'cloud body'], ['late-note', 'typed during apply']],
  );
  assert.equal(runtime.getSyncState().lastRevision, result.revision);
});

test('a late unrelated edit does not duplicate a published same-Note Conflict on retry', async (t) => {
  const s3 = new MemoryS3();
  const parent = note('parent-note', 'parent');
  const baseTree = {
    schemaVersion: 1,
    nodes: [
      { noteId: parent.id, parentId: null, order: 1024 },
      { noteId: 'shared-note', parentId: parent.id, order: 1024 },
    ],
  };
  const base = sharedData([parent, note('shared-note', 'base')], [], [], baseTree);
  const home = await createRuntime(t, { clientId: 'home', data: base, fetchImpl: s3.fetch });
  let rejectNextApply = false;
  const work = await createRuntime(t, {
    clientId: 'work',
    data: sharedData(),
    fetchImpl: s3.fetch,
    now: () => new Date(T2),
    snapshotApplier: async ({ data, expectedLocal, state }) => {
      if (rejectNextApply) {
        rejectNextApply = false;
        assert.equal(expectedLocal.notes.notes.find((item) => item.id === 'shared-note').content, 'work edit');
        state.data = sharedData([
          parent,
          note('shared-note', 'work edit', T1),
          note('late-note', 'typed during apply', T2),
        ], [], [], {
          schemaVersion: 1,
          nodes: [
            ...baseTree.nodes,
            { noteId: 'late-note', parentId: null, order: 2048 },
          ],
        });
        return false;
      }
      state.data = clone(data);
      state.applied.push(clone(data));
      return true;
    },
  });
  await home.runtime.syncAllDataToS3();
  await work.runtime.syncAllDataToS3();

  home.state.data = sharedData([parent, note('shared-note', 'home edit', T1)], [], [], baseTree);
  await home.runtime.syncAllDataToS3();
  work.state.data = sharedData([parent, note('shared-note', 'work edit', T1)], [], [], baseTree);
  rejectNextApply = true;

  const result = await work.runtime.syncAllDataToS3();
  assert.equal(result.action, 'conflict');
  assert.equal(work.state.data.notes.notes.find((item) => item.id === 'shared-note').content, 'home edit');
  assert.equal(work.state.data.notes.notes.find((item) => item.id === 'late-note').content, 'typed during apply');
  const conflicts = work.state.data.notes.notes.filter((item) => item.tags.includes('Conflict'));
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].content, 'work edit');
  assert.match(conflicts[0].id, /^s3-conflict-[A-Za-z0-9_-]{43}$/);
  assert.doesNotMatch(conflicts[0].id, /work|edit|shared-note/);
  assert.equal(
    work.state.data.notes.tree.nodes.find((item) => item.noteId === conflicts[0].id).parentId,
    parent.id,
  );

  await home.runtime.syncAllDataToS3();
  assert.equal(home.state.data.notes.notes.filter((item) => item.tags.includes('Conflict')).length, 1);
  assert.equal(
    home.state.data.notes.tree.nodes.find((item) => item.noteId === conflicts[0].id).parentId,
    parent.id,
  );
});

test('a second loser Note version during fenced apply keeps one Conflict for each distinct version', async (t) => {
  const s3 = new MemoryS3();
  const base = sharedData([note('shared-note', 'base')]);
  const home = await createRuntime(t, { clientId: 'home', data: base, fetchImpl: s3.fetch });
  let rejectNextApply = false;
  const work = await createRuntime(t, {
    clientId: 'work',
    data: sharedData(),
    fetchImpl: s3.fetch,
    now: () => new Date(T2),
    snapshotApplier: async ({ data, state }) => {
      if (rejectNextApply) {
        rejectNextApply = false;
        state.data = sharedData([note('shared-note', 'work edit v2', T2)]);
        return false;
      }
      state.data = clone(data);
      state.applied.push(clone(data));
      return true;
    },
  });
  await home.runtime.syncAllDataToS3();
  await work.runtime.syncAllDataToS3();

  home.state.data = sharedData([note('shared-note', 'home edit', T1)]);
  await home.runtime.syncAllDataToS3();
  work.state.data = sharedData([note('shared-note', 'work edit v1', T1)]);
  rejectNextApply = true;

  const result = await work.runtime.syncAllDataToS3();
  assert.equal(result.action, 'conflict');
  const conflicts = work.state.data.notes.notes.filter((item) => item.tags.includes('Conflict'));
  assert.equal(conflicts.length, 2);
  assert.deepEqual(conflicts.map((item) => item.content).sort(), ['work edit v1', 'work edit v2']);
  assert.equal(new Set(conflicts.map((item) => item.id)).size, 2);

  await home.runtime.syncAllDataToS3();
  assert.deepEqual(
    home.state.data.notes.notes
      .filter((item) => item.tags.includes('Conflict'))
      .map((item) => item.content)
      .sort(),
    ['work edit v1', 'work edit v2'],
  );
});

test('v4 reconcile automatically merges edits to different Notes from two clients', async (t) => {
  const s3 = new MemoryS3();
  const base = sharedData([
    note('note-a', 'A base'),
    note('note-b', 'B base'),
  ]);
  const home = await createRuntime(t, { clientId: 'home', data: base, fetchImpl: s3.fetch });
  const work = await createRuntime(t, { clientId: 'work', data: sharedData(), fetchImpl: s3.fetch });
  await home.runtime.syncAllDataToS3();
  assert.equal((await work.runtime.syncAllDataToS3()).action, 'pulled');

  home.state.data = sharedData([
    note('note-a', 'A changed at home', T1),
    note('note-b', 'B base'),
  ]);
  assert.equal((await home.runtime.syncAllDataToS3()).action, 'pushed');

  work.state.data = sharedData([
    note('note-a', 'A base'),
    note('note-b', 'B changed at work', T1),
  ]);
  assert.equal((await work.runtime.syncAllDataToS3()).action, 'pushed');
  assert.deepEqual(
    work.state.data.notes.notes.map((item) => [item.id, item.content]),
    [['note-a', 'A changed at home'], ['note-b', 'B changed at work']],
  );

  const homePull = await home.runtime.syncAllDataToS3();
  assert.equal(homePull.action, 'pulled');
  assert.deepEqual(home.state.data.notes.notes, work.state.data.notes.notes);
});

test('v4 CAS retry reuses immutable Note and tree objects uploaded by the losing head writer', async (t) => {
  const s3 = new MemoryS3();
  const base = sharedData([
    note('note-a', 'A base'),
    note('note-b', 'B base'),
  ]);
  const home = await createRuntime(t, { clientId: 'home', data: base, fetchImpl: s3.fetch });
  const work = await createRuntime(t, { clientId: 'work', data: sharedData(), fetchImpl: s3.fetch });
  await home.runtime.syncAllDataToS3();
  await work.runtime.syncAllDataToS3();

  home.state.data = sharedData([
    note('note-a', 'A changed at home', T1),
    note('note-b', 'B base'),
  ]);
  work.state.data = sharedData([
    note('note-a', 'A base'),
    note('note-b', 'B changed at work', T1),
  ]);
  const putsBeforeRace = s3.calls.filter((call) =>
    call.method === 'PUT' && call.url.includes('/service-manager/v4/notes/')
  ).length;
  s3.raceNextConditionalHeadWrites(2);
  const results = await Promise.all([
    home.runtime.syncAllDataToS3(),
    work.runtime.syncAllDataToS3(),
  ]);

  assert.deepEqual(results.map((result) => result.action), ['pushed', 'pushed']);
  const racedNotePuts = s3.calls.filter((call) =>
    call.method === 'PUT' && call.url.includes('/service-manager/v4/notes/')
  ).slice(putsBeforeRace);
  assert.equal(
    racedNotePuts.length,
    2,
    'each client uploads its changed Note once; the CAS loser must reuse that object on retry',
  );
  await Promise.all([
    home.runtime.syncAllDataToS3(),
    work.runtime.syncAllDataToS3(),
  ]);
  assert.deepEqual(home.state.data.notes.notes, work.state.data.notes.notes);
});

test('a synced Note deletion remains deleted when a stale client reconnects', async (t) => {
  const s3 = new MemoryS3();
  const base = sharedData([note('deleted-note', 'remove me')]);
  const home = await createRuntime(t, { clientId: 'home', data: base, fetchImpl: s3.fetch });
  const work = await createRuntime(t, { clientId: 'work', data: sharedData(), fetchImpl: s3.fetch });
  await home.runtime.syncAllDataToS3();
  await work.runtime.syncAllDataToS3();

  home.state.data = sharedData([], [], [{ id: 'deleted-note', deletedAt: T2 }]);
  assert.equal((await home.runtime.syncAllDataToS3()).action, 'pushed');
  assert.equal((await work.runtime.syncAllDataToS3()).action, 'pulled');
  assert.deepEqual(work.state.data.notes.notes, []);
  assert.equal((await work.runtime.syncAllDataToS3()).action, 'up-to-date');
  assert.deepEqual(work.state.data.notes.notes, []);
});

test('a client can explicitly restore a Note after synchronizing its exact tombstone', async (t) => {
  const s3 = new MemoryS3();
  const original = note('restored-note', 'original body');
  const home = await createRuntime(t, { clientId: 'home', data: sharedData([original]), fetchImpl: s3.fetch });
  const work = await createRuntime(t, { clientId: 'work', data: sharedData(), fetchImpl: s3.fetch });
  await home.runtime.syncAllDataToS3();
  await work.runtime.syncAllDataToS3();

  const tombstone = { id: original.id, deletedAt: T2 };
  home.state.data = sharedData([], [], [tombstone]);
  assert.equal((await home.runtime.syncAllDataToS3()).action, 'pushed');
  assert.equal((await work.runtime.syncAllDataToS3()).action, 'pulled');
  assert.deepEqual(work.state.data.notes.tombstones, [tombstone]);

  const restored = note(original.id, 'deliberately restored body', T2);
  work.state.data = sharedData([restored]);
  const restoredResult = await work.runtime.syncAllDataToS3();
  assert.equal(restoredResult.action, 'pushed');
  assert.deepEqual(work.state.data.notes.notes, [restored]);
  assert.deepEqual(work.state.data.notes.tombstones, []);
  assert.equal(work.runtime.getSyncState().conflictCount, undefined);

  assert.equal((await home.runtime.syncAllDataToS3()).action, 'pulled');
  assert.deepEqual(home.state.data.notes.notes, [restored]);
  assert.deepEqual(home.state.data.notes.tombstones, []);
});

test('same-Note concurrent edits use CAS, keep cloud canonical, and preserve the loser as a Conflict copy', async (t) => {
  const s3 = new MemoryS3();
  const base = sharedData([note('shared-note', 'base')]);
  const home = await createRuntime(t, { clientId: 'home', data: base, fetchImpl: s3.fetch, now: () => new Date(T2) });
  const work = await createRuntime(t, { clientId: 'work', data: sharedData(), fetchImpl: s3.fetch, now: () => new Date(T2) });
  await home.runtime.syncAllDataToS3();
  await work.runtime.syncAllDataToS3();

  home.state.data = sharedData([note('shared-note', 'home edit', T1)]);
  work.state.data = sharedData([note('shared-note', 'work edit', T1)]);
  s3.raceNextConditionalHeadWrites(2);
  const [homeResult, workResult] = await Promise.all([
    home.runtime.syncAllDataToS3(),
    work.runtime.syncAllDataToS3(),
  ]);

  assert.deepEqual(
    [homeResult.action, workResult.action].sort(),
    ['conflict', 'pushed'],
    'one CAS winner must become cloud and the loser must reconcile as a conflict',
  );
  const loser = homeResult.action === 'conflict' ? home : work;
  const winner = homeResult.action === 'pushed' ? home : work;
  const winnerContent = winner === home ? 'home edit' : 'work edit';
  const loserContent = loser === home ? 'home edit' : 'work edit';
  const canonical = loser.state.data.notes.notes.find((item) => item.id === 'shared-note');
  const conflict = loser.state.data.notes.notes.find((item) => item.id !== 'shared-note');
  assert.equal(canonical.content, winnerContent, 'the CAS winner remains canonical cloud data');
  assert.equal(conflict.content, loserContent);
  assert.match(conflict.name, / \(Conflict\)$/);
  assert.ok(conflict.tags.includes('Conflict'));
  assert.equal(loser.runtime.getSyncState().status, 'conflict');
  assert.equal(loser.runtime.getSyncState().conflictCount, 1);

  assert.equal((await winner.runtime.syncAllDataToS3()).action, 'pulled');
  assert.deepEqual(winner.state.data.notes.notes, loser.state.data.notes.notes);
});

test('a true Hosts conflict keeps cloud canonical and saves an encrypted local recovery', async (t) => {
  const s3 = new MemoryS3();
  const base = sharedData([], [host('shared-host', 'Base Host')]);
  const home = await createRuntime(t, { clientId: 'home', data: base, fetchImpl: s3.fetch, now: () => new Date(T2) });
  const work = await createRuntime(t, { clientId: 'work', data: sharedData(), fetchImpl: s3.fetch, now: () => new Date(T2) });
  await home.runtime.syncAllDataToS3();
  await work.runtime.syncAllDataToS3();

  home.state.data = sharedData([], [host('shared-host', 'Cloud Host')]);
  await home.runtime.syncAllDataToS3();
  work.state.data = sharedData([], [host('shared-host', 'Local Host')]);
  const result = await work.runtime.syncAllDataToS3();

  assert.equal(result.action, 'conflict');
  assert.equal(work.state.data.hosts.items[0].name, 'Cloud Host');
  const recoveryDirectory = path.join(work.userDataPath, 's3-sync-recovery');
  const recoveryFiles = await readdir(recoveryDirectory);
  assert.equal(recoveryFiles.length, 1);
  const envelope = JSON.parse(await readFile(path.join(recoveryDirectory, recoveryFiles[0]), 'utf8'));
  const recovery = decryptS3RevisionV2(envelope, SYNC_KEY);
  assert.equal(recovery.data.hosts.items[0].name, 'Local Host');
  assert.doesNotMatch(JSON.stringify(envelope), /Local Host|host-password/);
});

test('S3SyncRuntime keeps one in-flight reconcile for concurrent manual requests', async (t) => {
  const s3 = new MemoryS3();
  let release;
  let providerCount = 0;
  let firstRequest = true;
  const gate = new Promise((resolve) => { release = resolve; });
  const fetchImpl = async (url, options) => {
    if (firstRequest) {
      firstRequest = false;
      await gate;
    }
    return s3.fetch(url, options);
  };
  const userDataPath = await temporaryDirectory(t);
  await writeConfiguredSettings(userDataPath, 'single-flight');
  const runtime = new S3SyncRuntime({
    userDataPath,
    appVersion: '0.3.19',
    credentialProtector: fakeProtector(),
    snapshotProvider: async () => {
      providerCount += 1;
      return sharedData();
    },
    snapshotApplier: async () => undefined,
    fetchImpl,
    createRevision: () => 'single-flight-revision',
  });

  const first = runtime.syncAllDataToS3();
  const second = runtime.syncAllDataToS3();
  assert.strictEqual(first, second);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(s3.calls.length, 0, 'the shared GET is still blocked');
  release();
  await Promise.all([first, second]);
  assert.equal(providerCount, 1);
  assert.equal(s3.calls.filter((call) => call.method === 'GET').length, 1);
  await runtime.shutdown();
});

test('S3SyncRuntime times out a stalled reconcile and shutdown aborts an active reconcile', async (t) => {
  const createStalledFetch = (onStart) => async (_url, options) => {
    onStart();
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener(
        'abort',
        () => reject(new Error(`request body with ${SECRET_KEY}`)),
        { once: true },
      );
    });
  };

  const timeout = await createRuntime(t, {
    clientId: 'timeout',
    data: sharedData(),
    fetchImpl: createStalledFetch(() => undefined),
    timeoutMs: 5,
  });
  await assert.rejects(timeout.runtime.syncAllDataToS3(), /^Error: S3 sync timed out\.$/);
  const timeoutState = timeout.runtime.getSyncState();
  assert.equal(timeoutState.status, 'offline');
  assert.equal('phase' in timeoutState, false);
  assert.equal('completedItems' in timeoutState, false);
  assert.equal('totalItems' in timeoutState, false);
  assert.doesNotMatch(timeoutState.message, /wJalr/);

  let started;
  const requestStarted = new Promise((resolve) => { started = resolve; });
  const shutdown = await createRuntime(t, {
    clientId: 'shutdown',
    data: sharedData(),
    fetchImpl: createStalledFetch(started),
  });
  const pending = shutdown.runtime.syncAllDataToS3();
  await requestStarted;
  await shutdown.runtime.shutdown();
  await assert.rejects(pending, /^Error: S3 sync was cancelled\.$/);
});

test('S3SyncRuntime does not recreate its auto-sync interval after shutdown starts', async (t) => {
  const userDataPath = await temporaryDirectory(t);
  let releaseSettings;
  const settingsGate = new Promise((resolve) => { releaseSettings = resolve; });
  const runtime = new S3SyncRuntime({
    userDataPath,
    appVersion: '0.3.19',
    credentialProtector: fakeProtector(),
    snapshotProvider: async () => sharedData(),
    createClientId: () => 'shutdown-settings-client',
  });
  runtime.loadSettings = () => settingsGate;

  const starting = runtime.startAutoSync();
  await new Promise((resolve) => setImmediate(resolve));
  await runtime.shutdown();
  releaseSettings({
    schemaVersion: 6,
    endpoint: '',
    bucket: '',
    region: 'us-east-1',
    clientId: 'shutdown-settings-client',
  });
  await starting;

  assert.equal(runtime.intervalTimer, undefined);
  assert.equal(runtime.debounceTimer, undefined);
});

test('S3SyncRuntime returns bounded safe errors without leaking endpoint, data, or credentials', async (t) => {
  const secretContent = 'host-password-and-private-note';
  const runtime = await createRuntime(t, {
    clientId: 'safe-error',
    data: sharedData([note('private-note', secretContent)]),
    fetchImpl: async () => new Response(
      `<Error><Code>AccessDenied</Code><Message>${SECRET_KEY} ${secretContent} ${ENDPOINT}</Message></Error>`,
      { status: 403 },
    ),
  });

  await assert.rejects(runtime.runtime.syncAllDataToS3(), (error) => {
    assert.equal(error.message, 'S3 sync failed (403 AccessDenied).');
    assert.doesNotMatch(error.message, /wJalr|host-password|private-note|s3\.example/);
    return true;
  });
  const state = runtime.runtime.getSyncState();
  assert.equal(state.status, 'error');
  assert.equal(state.message, 'S3 sync failed (403 AccessDenied).');
  assert.doesNotMatch(JSON.stringify(state), /wJalr|host-password|private-note|s3\.example/);
});
