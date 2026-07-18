const assert = require('node:assert/strict');
const { mkdtemp, readFile, rm, stat } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  S3SyncRuntime,
  canonicalizeS3Path,
  createServiceManagerSnapshot,
  decryptS3Snapshot,
  encryptS3Snapshot,
  measureBoundedJsonBytes,
  signS3PutRequest,
  validateS3SyncSettingsDraft,
} = require('../dist/main/s3Sync');

const ACCESS_KEY = 'AKIDEXAMPLE';
const SECRET_KEY = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';
const ENDPOINT = 'https://s3.example.test/example-bucket/service-manager/snapshot.json';

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
    region: 'us-east-1',
    syncVersion: 1,
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET_KEY,
    ...overrides,
  };
}

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'service-manager-s3-sync-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('S3 settings validation requires a full secure object URL and paired credentials', () => {
  assert.deepEqual(validateS3SyncSettingsDraft(settingsDraft()), settingsDraft());
  assert.equal(
    validateS3SyncSettingsDraft(settingsDraft({ endpoint: 'http://localhost:9000/bucket/data.json' })).endpoint,
    'http://localhost:9000/bucket/data.json',
  );
  assert.equal(
    validateS3SyncSettingsDraft(settingsDraft({ endpoint: 'http://127.0.0.1:9000/bucket/data.json' })).endpoint,
    'http://127.0.0.1:9000/bucket/data.json',
  );

  assert.throws(
    () => validateS3SyncSettingsDraft(settingsDraft({ endpoint: 'http://s3.example.test/bucket/data.json' })),
    /must use HTTPS unless it targets localhost/,
  );
  assert.throws(
    () => validateS3SyncSettingsDraft(settingsDraft({ endpoint: 'https://user:pass@s3.example.test/bucket/data.json' })),
    /cannot contain credentials/,
  );
  assert.throws(
    () => validateS3SyncSettingsDraft(settingsDraft({ endpoint: 'https://s3.example.test/bucket/data.json?token=secret' })),
    /cannot contain credentials, a query, or a fragment/,
  );
  assert.throws(
    () => validateS3SyncSettingsDraft(settingsDraft({ endpoint: 'https://s3.example.test/' })),
    /include an object path/,
  );
  assert.throws(
    () => validateS3SyncSettingsDraft({ ...settingsDraft(), secretAccessKey: undefined }),
    /Both the S3 access key ID and secret access key/,
  );
  assert.throws(
    () => validateS3SyncSettingsDraft({ ...settingsDraft(), syncVersion: 2 }),
    /Only S3 sync version 1/,
  );
});

test('S3 SigV4 signing has a fixed canonical request and signature', () => {
  const signed = signS3PutRequest({
    endpoint: 'https://s3.example.test/example-bucket/folder/hello world+中文.json',
    region: 'us-east-1',
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET_KEY,
    payload: '{"hello":"world"}',
    now: new Date('2026-07-18T04:05:06.000Z'),
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

test('S3 snapshot encryption round-trips and rejects authenticated-data tampering', () => {
  const snapshot = createServiceManagerSnapshot(
    { notes: [{ name: 'deploy', content: 'echo hello' }], hosts: [{ password: 'host-password' }] },
    '0.3.19',
    'fixed-revision',
    '2026-07-18T04:05:06.000Z',
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

test('S3 snapshot size is rejected during a bounded walk before whole-snapshot serialization', () => {
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
  const nativeStringify = JSON.stringify;
  JSON.stringify = (value, ...arguments_) => {
    if (typeof value === 'string' && value.length > 16) throw new Error('unexpected large string allocation');
    return nativeStringify(value, ...arguments_);
  };
  try {
    assert.throws(
      () => measureBoundedJsonBytes({ content: '\u0000'.repeat(128) }, 64),
      /snapshot is too large to sync/,
    );
    assert.throws(
      () => measureBoundedJsonBytes(new Array(1_000_000), 64),
      /snapshot is too large to sync/,
    );
  } finally {
    JSON.stringify = nativeStringify;
  }
  const circular = {};
  circular.self = circular;
  assert.throws(() => measureBoundedJsonBytes(circular, 1_024), /could not be serialized/);
});

test('S3SyncRuntime encrypts credentials at rest and uploads one signed encrypted snapshot', async (t) => {
  const userDataPath = await temporaryDirectory(t);
  const calls = [];
  const runtime = new S3SyncRuntime({
    userDataPath,
    appVersion: '0.3.19',
    credentialProtector: fakeProtector(),
    snapshotProvider: async () => ({
      hosts: [{ name: 'production', password: 'host-password' }],
      notes: [{ name: 'release', content: 'pnpm run build' }],
    }),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response('', { status: 200, headers: { etag: '"snapshot-etag"' } });
    },
    now: () => new Date('2026-07-18T04:05:06.000Z'),
    createRevision: () => 'revision-1',
    createRandomBytes: (size) => Buffer.alloc(size, size),
  });

  const saved = await runtime.saveSettings(settingsDraft());
  assert.deepEqual(saved, {
    endpoint: ENDPOINT,
    region: 'us-east-1',
    syncVersion: 1,
    hasCredentials: true,
  });
  assert.doesNotMatch(JSON.stringify(saved), /AKIDEXAMPLE|wJalr|encrypted/i);

  const settingsPath = path.join(userDataPath, 's3-sync.json');
  const persistedBeforeSync = await readFile(settingsPath, 'utf8');
  assert.doesNotMatch(persistedBeforeSync, /AKIDEXAMPLE|wJalr|host-password/);
  if (process.platform !== 'win32') {
    assert.equal((await stat(settingsPath)).mode & 0o777, 0o600);
  }

  const result = await runtime.syncAllDataToS3();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, ENDPOINT);
  assert.equal(calls[0].options.method, 'PUT');
  assert.equal(calls[0].options.redirect, 'manual');
  assert.match(calls[0].options.headers.authorization, /Credential=AKIDEXAMPLE\//);
  assert.equal(calls[0].options.headers['x-amz-content-sha256'].length, 64);

  const uploaded = JSON.parse(calls[0].options.body);
  const snapshot = decryptS3Snapshot(uploaded, SECRET_KEY);
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.syncVersion, 1);
  assert.equal(snapshot.appVersion, '0.3.19');
  assert.equal(snapshot.revision, 'revision-1');
  assert.equal(snapshot.createdAt, '2026-07-18T04:05:06.000Z');
  assert.equal(snapshot.data.hosts[0].password, 'host-password');
  assert.equal(snapshot.data.notes[0].content, 'pnpm run build');
  assert.doesNotMatch(calls[0].options.body, /host-password|pnpm run build/);

  assert.deepEqual(result, {
    syncedAt: '2026-07-18T04:05:06.000Z',
    revision: 'revision-1',
    byteLength: Buffer.byteLength(calls[0].options.body),
    etag: '"snapshot-etag"',
  });
  assert.deepEqual(await runtime.getSettings(), {
    endpoint: ENDPOINT,
    region: 'us-east-1',
    syncVersion: 1,
    hasCredentials: true,
    lastSyncedAt: '2026-07-18T04:05:06.000Z',
    lastRevision: 'revision-1',
  });
  assert.deepEqual(await runtime.saveSettings({
    endpoint: ENDPOINT,
    region: 'us-east-1',
    syncVersion: 1,
  }), {
    endpoint: ENDPOINT,
    region: 'us-east-1',
    syncVersion: 1,
    hasCredentials: true,
    lastSyncedAt: '2026-07-18T04:05:06.000Z',
    lastRevision: 'revision-1',
  });
  const persistedAfterSync = await readFile(settingsPath, 'utf8');
  assert.doesNotMatch(persistedAfterSync, /AKIDEXAMPLE|wJalr|host-password|pnpm run build/);
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
    snapshotProvider: async () => ({}),
  });

  await assert.rejects(
    runtime.saveS3SyncSettings(settingsDraft()),
    /Secure credential storage is unavailable/,
  );
  assert.deepEqual(await runtime.getS3SyncSettings(), {
    endpoint: '',
    region: 'us-east-1',
    syncVersion: 1,
    hasCredentials: false,
  });
});

test('S3SyncRuntime reloads protected settings and clears credentials durably', async (t) => {
  const userDataPath = await temporaryDirectory(t);
  const options = {
    userDataPath,
    appVersion: '0.3.19',
    credentialProtector: fakeProtector(),
    snapshotProvider: async () => ({}),
  };
  await new S3SyncRuntime(options).saveSettings(settingsDraft());

  const reloaded = new S3SyncRuntime(options);
  assert.deepEqual(await reloaded.getSettings(), {
    endpoint: ENDPOINT,
    region: 'us-east-1',
    syncVersion: 1,
    hasCredentials: true,
  });
  await reloaded.saveSettings({
    endpoint: ENDPOINT,
    region: 'us-east-1',
    syncVersion: 1,
    clearCredentials: true,
  });

  assert.deepEqual(await new S3SyncRuntime(options).getSettings(), {
    endpoint: ENDPOINT,
    region: 'us-east-1',
    syncVersion: 1,
    hasCredentials: false,
  });
  assert.doesNotMatch(await readFile(path.join(userDataPath, 's3-sync.json'), 'utf8'), /encryptedAccessKeyId|encryptedSecretAccessKey/);
});

test('S3SyncRuntime coalesces concurrent sync requests into one PUT', async (t) => {
  const userDataPath = await temporaryDirectory(t);
  let release;
  let requestCount = 0;
  let providerCount = 0;
  const response = new Promise((resolve) => { release = resolve; });
  const runtime = new S3SyncRuntime({
    userDataPath,
    appVersion: '0.3.19',
    credentialProtector: fakeProtector(),
    snapshotProvider: async () => {
      providerCount += 1;
      return { notes: [] };
    },
    fetchImpl: async () => {
      requestCount += 1;
      return response;
    },
    now: () => new Date('2026-07-18T04:05:06.000Z'),
    createRevision: () => 'single-flight',
  });
  await runtime.saveSettings(settingsDraft());

  const first = runtime.syncAllDataToS3();
  const second = runtime.syncAllDataToS3();
  assert.strictEqual(first, second);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requestCount, 1);
  assert.equal(providerCount, 1);

  release(new Response('', { status: 200 }));
  await Promise.all([first, second]);
  assert.equal(requestCount, 1);
});

test('S3SyncRuntime times out a stalled PUT and shutdown aborts an active PUT', async (t) => {
  const createStalledFetch = (onStart) => async (_url, options) => {
    onStart();
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('request body with secret material')), { once: true });
    });
  };

  const timeoutDirectory = await temporaryDirectory(t);
  const timeoutRuntime = new S3SyncRuntime({
    userDataPath: timeoutDirectory,
    appVersion: '0.3.19',
    credentialProtector: fakeProtector(),
    snapshotProvider: async () => ({}),
    fetchImpl: createStalledFetch(() => undefined),
    timeoutMs: 5,
  });
  await timeoutRuntime.saveSettings(settingsDraft());
  await assert.rejects(timeoutRuntime.syncAllDataToS3(), /^Error: S3 sync timed out\.$/);

  const shutdownDirectory = await temporaryDirectory(t);
  let started;
  const requestStarted = new Promise((resolve) => { started = resolve; });
  const shutdownRuntime = new S3SyncRuntime({
    userDataPath: shutdownDirectory,
    appVersion: '0.3.19',
    credentialProtector: fakeProtector(),
    snapshotProvider: async () => ({}),
    fetchImpl: createStalledFetch(started),
  });
  await shutdownRuntime.saveSettings(settingsDraft());
  const sync = shutdownRuntime.syncAllDataToS3();
  await requestStarted;
  await shutdownRuntime.shutdown();
  await assert.rejects(sync, /^Error: S3 sync was cancelled\.$/);
});

test('S3SyncRuntime keeps timeout ownership while reading an error response body', async (t) => {
  const userDataPath = await temporaryDirectory(t);
  let bodyCancelled = false;
  const runtime = new S3SyncRuntime({
    userDataPath,
    appVersion: '0.3.19',
    credentialProtector: fakeProtector(),
    snapshotProvider: async () => ({}),
    fetchImpl: async () => new Response(new ReadableStream({
      cancel: () => { bodyCancelled = true; },
    }), { status: 500 }),
    timeoutMs: 5,
  });
  await runtime.saveSettings(settingsDraft());

  await assert.rejects(runtime.syncAllDataToS3(), /^Error: S3 sync timed out\.$/);
  assert.equal(bodyCancelled, true);
});

test('S3SyncRuntime returns bounded safe request errors without leaking server or credential content', async (t) => {
  const userDataPath = await temporaryDirectory(t);
  const runtime = new S3SyncRuntime({
    userDataPath,
    appVersion: '0.3.19',
    credentialProtector: fakeProtector(),
    snapshotProvider: async () => ({ hosts: [{ password: 'host-password' }] }),
    fetchImpl: async () => new Response(
      `<Error><Code>AccessDenied</Code><Message>${SECRET_KEY} host-password</Message></Error>`,
      { status: 403 },
    ),
  });
  await runtime.saveSettings(settingsDraft());

  await assert.rejects(runtime.syncAllDataToS3(), (error) => {
    assert.equal(error.message, 'S3 sync failed (403 AccessDenied).');
    assert.doesNotMatch(error.message, /wJalr|host-password|s3\.example/);
    return true;
  });
});
