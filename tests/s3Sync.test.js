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
  buildS3V2HeadObjectUrl,
  buildS3V2RevisionObjectUrl,
  decryptS3RevisionV2,
} = require('../dist/main/s3SyncV2');

const ACCESS_KEY = 'AKIDEXAMPLE';
const SECRET_KEY = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';
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

function sharedData(notes = [], hosts = []) {
  return createS3SharedAppDataV2({
    hosts,
    notes: { schemaVersion: 1, notes },
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

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'service-manager-s3-sync-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function writeConfiguredSettings(directory, clientId, overrides = {}) {
  const protector = fakeProtector();
  await writeFile(path.join(directory, 's3-sync.json'), JSON.stringify({
    schemaVersion: 3,
    endpoint: ENDPOINT,
    bucket: BUCKET,
    region: 'us-east-1',
    clientId,
    encryptedAccessKeyId: protector.encryptString(ACCESS_KEY).toString('base64'),
    encryptedSecretAccessKey: protector.encryptString(SECRET_KEY).toString('base64'),
    ...overrides,
  }));
}

function createRevisionFactory(clientId) {
  let revision = 0;
  return () => `${clientId}-revision-${++revision}`;
}

async function createRuntime(t, options) {
  const userDataPath = await temporaryDirectory(t);
  await writeConfiguredSettings(userDataPath, options.clientId, options.persistedSettings);
  const state = { data: clone(options.data), applied: [] };
  const runtime = new S3SyncRuntime({
    userDataPath,
    appVersion: '0.3.19',
    credentialProtector: fakeProtector(),
    snapshotProvider: async () => clone(state.data),
    snapshotApplier: async (data) => {
      state.data = clone(data);
      state.applied.push(clone(data));
    },
    fetchImpl: options.fetchImpl,
    now: options.now ?? (() => new Date(T0)),
    createRevision: options.createRevision ?? createRevisionFactory(options.clientId),
    createClientId: () => options.clientId,
    createRandomBytes: (size) => Buffer.alloc(size, size),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
  });
  t.after(() => runtime.shutdown());
  return { runtime, state, userDataPath };
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
    return buildS3V2HeadObjectUrl(ENDPOINT, BUCKET);
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

test('S3 settings validation accepts a root endpoint and a separate bucket', () => {
  assert.deepEqual(validateS3SyncSettingsDraft(settingsDraft()), settingsDraft());
  assert.equal(
    validateS3SyncSettingsDraft(settingsDraft({ endpoint: `${ENDPOINT}/` })).endpoint,
    ENDPOINT,
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
  assert.equal(saved.syncState.status, 'pending');
  assert.doesNotMatch(JSON.stringify(saved), /AKIDEXAMPLE|wJalr|encrypted/i);
  assert.deepEqual(await runtime.revealS3SyncCredentials(), {
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET_KEY,
  });

  const settingsPath = path.join(userDataPath, 's3-sync.json');
  const persistedText = await readFile(settingsPath, 'utf8');
  const persisted = JSON.parse(persistedText);
  assert.equal(persisted.schemaVersion, 3);
  assert.equal(persisted.endpoint, ENDPOINT);
  assert.equal(persisted.bucket, BUCKET);
  assert.equal(persisted.clientId, 'client-1');
  assert.equal('bucketUrl' in persisted, false);
  assert.equal('syncVersion' in persisted, false);
  assert.doesNotMatch(persistedText, /AKIDEXAMPLE|wJalr/);
  if (process.platform !== 'win32') assert.equal((await stat(settingsPath)).mode & 0o777, 0o600);
  await runtime.shutdown();
});

test('S3SyncRuntime migrates schema 1 and 2 settings to schema 3', async (t) => {
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
      });

      const view = await runtime.getSettings();
      assert.equal(view.endpoint, ENDPOINT);
      assert.equal(view.bucket, BUCKET);
      assert.equal(view.hasCredentials, true);
      assert.equal(view.lastRevision, undefined, 'v1 backup state is not a v2 shared-head base');
      const migrated = JSON.parse(await readFile(settingsPath, 'utf8'));
      assert.equal(migrated.schemaVersion, 3);
      assert.equal(migrated.endpoint, ENDPOINT);
      assert.equal(migrated.bucket, BUCKET);
      assert.equal(migrated.clientId, migration.expectedClientId);
      assert.equal('bucketUrl' in migrated, false);
      assert.equal('syncVersion' in migrated, false);
      assert.equal('lastRevision' in migrated, false);
      assert.deepEqual(await runtime.revealS3SyncCredentials(), {
        accessKeyId: ACCESS_KEY,
        secretAccessKey: SECRET_KEY,
      });
      await runtime.shutdown();
    });
  }
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
  assert.equal(settings.syncState.status, 'not-configured');
  await assert.rejects(runtime.revealS3SyncCredentials(), /credentials are unavailable/);
  await runtime.shutdown();
});

test('v2 reconcile performs an initial conditional push', async (t) => {
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
  assert.ok(s3.objects.has(buildS3V2RevisionObjectUrl(ENDPOINT, BUCKET, result.revision)));
  assert.ok(s3.objects.has(buildS3V2HeadObjectUrl(ENDPOINT, BUCKET)));
  assert.equal(s3.calls.filter((call) => call.method === 'PUT').length, 2);
  assert.equal(s3.calls.find((call) => call.url.endsWith('/revisions/home-revision-1.json')).headers.get('if-none-match'), '*');
  assert.equal(s3.calls.find((call) => call.url.endsWith('/head.json') && call.method === 'PUT').headers.get('if-none-match'), '*');
  assert.doesNotMatch([...s3.objects.values()].map((value) => value.body).join('\n'), /# deploy/);

  const persisted = await readFile(path.join(userDataPath, 's3-sync.json'), 'utf8');
  assert.doesNotMatch(persisted, /AKIDEXAMPLE|wJalr|# deploy/);
  const view = await runtime.getSettings();
  assert.equal(view.lastRevision, result.revision);
  assert.equal(view.syncState.status, 'synced');
  assert.equal(view.syncState.pending, false);
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
  await waitFor(() => work.state.applied.length === 1, 'the second client did not automatically pull cloud data');

  assert.deepEqual(work.state.data.notes.notes, cloudData.notes.notes);
  assert.equal(work.runtime.getSyncState().status, 'synced');
  assert.equal(work.runtime.getSyncState().lastRevision, 'home-revision-1');
  assert.equal(
    s3.calls.filter((call) => call.url.includes('/service-manager/v1/clients/')).length,
    0,
    'v2 clients must coordinate through one shared head',
  );
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

test('v2 reconcile automatically merges edits to different Notes from two clients', async (t) => {
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

test('a synced Note deletion remains deleted when a stale client reconnects', async (t) => {
  const s3 = new MemoryS3();
  const base = sharedData([note('deleted-note', 'remove me')]);
  const home = await createRuntime(t, { clientId: 'home', data: base, fetchImpl: s3.fetch });
  const work = await createRuntime(t, { clientId: 'work', data: sharedData(), fetchImpl: s3.fetch });
  await home.runtime.syncAllDataToS3();
  await work.runtime.syncAllDataToS3();

  home.state.data = sharedData();
  assert.equal((await home.runtime.syncAllDataToS3()).action, 'pushed');
  assert.equal((await work.runtime.syncAllDataToS3()).action, 'pulled');
  assert.deepEqual(work.state.data.notes.notes, []);
  assert.equal((await work.runtime.syncAllDataToS3()).action, 'up-to-date');
  assert.deepEqual(work.state.data.notes.notes, []);
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
  const recovery = decryptS3RevisionV2(envelope, SECRET_KEY);
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
  assert.equal(timeout.runtime.getSyncState().status, 'offline');
  assert.doesNotMatch(timeout.runtime.getSyncState().message, /wJalr/);

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
