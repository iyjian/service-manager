const assert = require('node:assert/strict');
const { mkdtemp, readFile, readdir, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  S3SyncRuntime,
  validateS3ConnectionTestDraft,
} = require('../dist/main/s3Sync');
const {
  buildS3V3HeadObjectUrl,
  testS3V3Connection,
} = require('../dist/main/s3SyncV3');

const ENDPOINT = 'https://s3.example.test';
const BUCKET = 'service-manager';
const ACCESS_KEY = 'AKIDEXAMPLE';
const SECRET_KEY = 'very-private-secret';
const NOW = new Date('2026-07-19T04:05:06.000Z');

function draft(overrides = {}) {
  return {
    endpoint: ENDPOINT,
    bucket: BUCKET,
    region: 'us-east-1',
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET_KEY,
    ...overrides,
  };
}

function probeOptions(fetchImpl, overrides = {}) {
  return {
    ...draft(),
    fetchImpl,
    now: () => NOW,
    timeoutMs: 100,
    ...overrides,
  };
}

function runtimeOptions(userDataPath, fetchImpl, overrides = {}) {
  return {
    userDataPath,
    appVersion: '0.3.19',
    credentialProtector: {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(value, 'utf8'),
      decryptString: (value) => value.toString('utf8'),
    },
    snapshotProvider: async () => {
      throw new Error('A connectivity test must not collect application data.');
    },
    fetchImpl,
    now: () => NOW,
    timeoutMs: 100,
    ...overrides,
  };
}

test('Settings preload and main IPC expose the draft-only S3 connection Test', async () => {
  const [preload, main] = await Promise.all([
    readFile(path.join(__dirname, '../dist/main/preload.js'), 'utf8'),
    readFile(path.join(__dirname, '../dist/main/main.js'), 'utf8'),
  ]);
  assert.match(
    preload,
    /testS3Connection:\s*\(draft\)\s*=>\s*[^\n]*invoke\('settings:s3:test', draft\)/,
  );
  assert.match(main, /s3SettingsTest:\s*'settings:s3:test'/);
  assert.match(
    main,
    /ipcMain\.handle\(IPC_CHANNELS\.s3SettingsTest,[\s\S]*?\.testS3Connection\(draft\)/,
  );
});

test('S3 connection draft validation ignores Sync Encryption Key and requires draft credentials', () => {
  assert.deepEqual(
    validateS3ConnectionTestDraft({
      ...draft(),
      syncEncryptionKey: 'intentionally-not-a-key',
      clearCredentials: true,
    }),
    draft(),
  );
  assert.throws(
    () => validateS3ConnectionTestDraft({ ...draft(), secretAccessKey: undefined }),
    /Both the S3 access key ID and secret access key are required/,
  );
});

test('S3 connection probe signs exactly one canonical v4 head GET and accepts 200', async () => {
  let request;
  await testS3V3Connection(probeOptions(async (url, options) => {
    request = { url, options };
    return new Response('head content is not parsed', { status: 200 });
  }));

  assert.equal(request.url, buildS3V3HeadObjectUrl(ENDPOINT, BUCKET));
  assert.equal(request.options.method, 'GET');
  assert.equal(request.options.redirect, 'manual');
  assert.match(request.options.headers.authorization, /^AWS4-HMAC-SHA256 /);
  assert.equal(request.options.body, undefined);
});

test('S3 connection probe accepts a missing head but rejects a missing bucket', async () => {
  await testS3V3Connection(probeOptions(async () => new Response(
    '<Error><Code>NoSuchKey</Code></Error>',
    { status: 404 },
  )));

  await assert.rejects(
    testS3V3Connection(probeOptions(async () => new Response(null, { status: 404 }))),
    { message: 'S3 connection test failed (404).' },
  );

  await assert.rejects(
    testS3V3Connection(probeOptions(async () => new Response(
      '<Error><Code>NoSuchBucket</Code><Message>private details</Message></Error>',
      { status: 404 },
    ))),
    (error) => {
      assert.equal(error.message, 'S3 connection test failed (404 NoSuchBucket).');
      assert.doesNotMatch(error.message, /private details|s3\.example|AKID|very-private/);
      return true;
    },
  );
});

test('S3 connection probe reports bounded authentication, server, network, and timeout errors', async () => {
  await assert.rejects(
    testS3V3Connection(probeOptions(async () => new Response(
      '<Error><Code>AccessDenied</Code><Message>do not expose me</Message></Error>',
      { status: 403 },
    ))),
    { message: 'S3 connection test failed (403 AccessDenied).' },
  );
  await assert.rejects(
    testS3V3Connection(probeOptions(async () => new Response('server details', { status: 503 }))),
    { message: 'S3 connection test failed (503).' },
  );
  await assert.rejects(
    testS3V3Connection(probeOptions(async () => {
      throw new Error(`${ENDPOINT} ${ACCESS_KEY} ${SECRET_KEY}`);
    })),
    { message: 'S3 connection test request failed.' },
  );
  await assert.rejects(
    testS3V3Connection(probeOptions((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }), { timeoutMs: 5 })),
    { message: 'S3 connection test timed out.' },
  );
});

test('runtime connectivity Test neither saves Settings nor starts synchronization', async (t) => {
  const userDataPath = await mkdtemp(path.join(os.tmpdir(), 'service-manager-s3-test-'));
  t.after(() => rm(userDataPath, { recursive: true, force: true }));
  let requests = 0;
  const runtime = new S3SyncRuntime(runtimeOptions(userDataPath, async () => {
    requests += 1;
    return new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 });
  }));

  await runtime.testS3Connection(draft());

  assert.equal(requests, 1);
  assert.deepEqual(await readdir(userDataPath), []);
  assert.equal(runtime.getSyncState().status, 'not-configured');
  await runtime.shutdown();
});

test('runtime shutdown cancels and awaits an active connectivity Test', async (t) => {
  const userDataPath = await mkdtemp(path.join(os.tmpdir(), 'service-manager-s3-test-'));
  t.after(() => rm(userDataPath, { recursive: true, force: true }));
  let requestStarted;
  const started = new Promise((resolve) => { requestStarted = resolve; });
  const runtime = new S3SyncRuntime(runtimeOptions(userDataPath, (_url, options) => new Promise((_resolve, reject) => {
    requestStarted();
    options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }), { timeoutMs: 1_000 }));

  const testing = runtime.testS3Connection(draft());
  const rejected = assert.rejects(testing, { message: 'S3 connection test was cancelled.' });
  await started;
  await runtime.shutdown();

  await rejected;
});
