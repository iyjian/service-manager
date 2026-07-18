const assert = require('node:assert/strict');
const test = require('node:test');

const {
  S3V2ObjectStore,
  assertS3SyncHeadMatchesRevisionV2,
  buildS3BucketUrl,
  buildS3V2HeadObjectUrl,
  buildS3V2RevisionObjectUrl,
  createS3SyncHeadV2,
  createServiceManagerSyncRevisionV2,
  decryptS3RevisionV2,
  encryptS3RevisionV2,
  hashS3V2RevisionObject,
  normalizeS3Bucket,
  normalizeS3Endpoint,
  parseEncryptedS3RevisionV2,
  parseS3SyncHeadV2,
  serializeEncryptedS3RevisionV2,
  signS3V2Request,
  splitLegacyS3BucketUrl,
} = require('../dist/main/s3SyncV2');

const ENDPOINT = 'https://s3.example.test';
const BUCKET = 'service-manager';
const ACCESS_KEY = 'AKIDEXAMPLE';
const SECRET_KEY = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';
const NOW = new Date('2026-07-18T04:05:06.000Z');

function createRevision(overrides = {}) {
  return createServiceManagerSyncRevisionV2(
    { notes: [{ id: 'note-1', name: 'Deploy', content: 'echo hello' }] },
    {
      appVersion: '0.3.19',
      revision: 'revision-2',
      parentRevision: 'revision-1',
      clientId: 'client-home',
      createdAt: NOW.toISOString(),
      ...overrides,
    },
  );
}

test('S3 v2 separates a root endpoint from a DNS-compatible bucket', () => {
  assert.equal(normalizeS3Endpoint(`${ENDPOINT}/`), ENDPOINT);
  assert.equal(normalizeS3Endpoint('http://localhost:9000/'), 'http://localhost:9000');
  assert.equal(normalizeS3Bucket(' service-manager.backup '), 'service-manager.backup');
  assert.equal(buildS3BucketUrl(ENDPOINT, BUCKET), `${ENDPOINT}/${BUCKET}`);
  assert.deepEqual(splitLegacyS3BucketUrl(`${ENDPOINT}/${BUCKET}/`), {
    endpoint: ENDPOINT,
    bucket: BUCKET,
  });

  assert.throws(() => normalizeS3Endpoint(`${ENDPOINT}/${BUCKET}`), /cannot contain a bucket path/);
  assert.throws(() => normalizeS3Endpoint('http://s3.example.test'), /must use HTTPS unless it targets localhost/);
  assert.throws(() => normalizeS3Endpoint('https://user:secret@s3.example.test'), /cannot contain credentials/);
  assert.throws(() => normalizeS3Bucket('UPPERCASE'), /DNS-compatible/);
  assert.throws(() => normalizeS3Bucket('ab'), /DNS-compatible/);
  assert.throws(() => normalizeS3Bucket('192.168.1.1'), /DNS-compatible/);
  assert.throws(() => normalizeS3Bucket('invalid..bucket'), /DNS-compatible/);
  assert.throws(() => splitLegacyS3BucketUrl(`${ENDPOINT}/bucket/prefix`), /exactly one bucket path/);
});

test('S3 v2 uses one shared head and immutable global revision paths', () => {
  assert.equal(
    buildS3V2HeadObjectUrl(ENDPOINT, BUCKET),
    `${ENDPOINT}/${BUCKET}/service-manager/v2/head.json`,
  );
  assert.equal(
    buildS3V2RevisionObjectUrl(ENDPOINT, BUCKET, 'revision-2'),
    `${ENDPOINT}/${BUCKET}/service-manager/v2/revisions/revision-2.json`,
  );
  assert.throws(
    () => buildS3V2RevisionObjectUrl(ENDPOINT, BUCKET, '../revision'),
    /snapshot revision is invalid/,
  );
});

test('S3 v2 encryption binds the revision identity and validates the head digest', () => {
  const revision = createRevision();
  const encrypted = encryptS3RevisionV2(revision, SECRET_KEY, (size) => Buffer.alloc(size, size));
  const serialized = serializeEncryptedS3RevisionV2(encrypted);
  const digest = hashS3V2RevisionObject(serialized);
  const head = createS3SyncHeadV2(revision, digest);

  assert.deepEqual(decryptS3RevisionV2(encrypted, SECRET_KEY), revision);
  assert.deepEqual(parseS3SyncHeadV2(head), head);
  assert.doesNotThrow(() => assertS3SyncHeadMatchesRevisionV2(head, revision, digest));
  assert.equal(head.snapshotSha256, digest);
  assert.doesNotMatch(serialized, /Deploy|echo hello/);

  assert.throws(
    () => decryptS3RevisionV2({ ...encrypted, revision: 'different-revision' }, SECRET_KEY),
    /could not be decrypted/,
  );
  assert.throws(
    () => decryptS3RevisionV2(encrypted, 'different-secret'),
    /could not be decrypted/,
  );
  assert.throws(
    () => parseEncryptedS3RevisionV2({ ...encrypted, ciphertext: `${encrypted.ciphertext.slice(0, -1)}!` }),
    /encrypted S3 revision is invalid/,
  );
  assert.throws(
    () => parseS3SyncHeadV2({ ...head, snapshotSha256: 'not-a-digest' }),
    /sync head is invalid/,
  );
  assert.throws(
    () => assertS3SyncHeadMatchesRevisionV2(head, { ...revision, clientId: 'client-work' }, digest),
    /does not match the shared head/,
  );
});

test('S3 v2 SigV4 signs GET and conditional PUT headers', () => {
  const get = signS3V2Request({
    method: 'GET',
    objectUrl: buildS3V2HeadObjectUrl(ENDPOINT, BUCKET),
    region: 'us-east-1',
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET_KEY,
    now: NOW,
  });
  assert.match(get.canonicalRequest, /^GET\n\/service-manager\/service-manager\/v2\/head\.json\n/m);
  assert.match(get.headers.authorization, /SignedHeaders=host;x-amz-content-sha256;x-amz-date/);
  assert.equal(get.headers['x-amz-content-sha256'], hashS3V2RevisionObject(''));

  const put = signS3V2Request({
    method: 'PUT',
    objectUrl: buildS3V2HeadObjectUrl(ENDPOINT, BUCKET),
    region: 'us-east-1',
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET_KEY,
    payload: '{"revision":"revision-2"}',
    ifMatch: '"head-etag"',
    now: NOW,
  });
  assert.equal(put.headers['if-match'], '"head-etag"');
  assert.match(
    put.headers.authorization,
    /SignedHeaders=content-type;host;if-match;x-amz-content-sha256;x-amz-date/,
  );
  assert.throws(
    () => signS3V2Request({
      method: 'PUT',
      objectUrl: buildS3V2HeadObjectUrl(ENDPOINT, BUCKET),
      region: 'us-east-1',
      accessKeyId: ACCESS_KEY,
      secretAccessKey: SECRET_KEY,
      ifMatch: '"etag"',
      ifNoneMatch: '*',
      now: NOW,
    }),
    /Conflicting S3 request conditions/,
  );
});

test('S3 v2 object store uses conditional writes and reads the shared head and revision', async () => {
  const calls = [];
  const objects = new Map();
  let headEtag;
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const headers = options.headers;
    if (options.method === 'GET') {
      const body = objects.get(url);
      if (body === undefined) return new Response('', { status: 404 });
      return new Response(body, { status: 200, headers: { etag: url.endsWith('/head.json') ? headEtag : '"revision-etag"' } });
    }
    if (url.endsWith('/head.json')) {
      if (headEtag === undefined) {
        if (headers['if-none-match'] !== '*') return new Response('', { status: 412 });
      } else if (headers['if-match'] !== headEtag) {
        return new Response('', { status: 412 });
      }
      objects.set(url, options.body);
      headEtag = headEtag === undefined ? '"head-1"' : '"head-2"';
      return new Response('', { status: 200, headers: { etag: headEtag } });
    }
    if (objects.has(url) || headers['if-none-match'] !== '*') return new Response('', { status: 412 });
    objects.set(url, options.body);
    return new Response('', { status: 200, headers: { etag: '"revision-etag"' } });
  };
  const store = new S3V2ObjectStore({
    endpoint: ENDPOINT,
    bucket: BUCKET,
    region: 'us-east-1',
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET_KEY,
    fetchImpl,
    now: () => NOW,
    createRandomBytes: (size) => Buffer.alloc(size, size),
  });

  assert.deepEqual(await store.getHead(), { status: 'missing' });
  const revision = createRevision();
  const written = await store.putRevision(revision);
  assert.equal(written.status, 'written');
  assert.equal(written.snapshotSha256.length, 64);
  assert.equal(calls.at(-1).options.headers['if-none-match'], '*');
  assert.match(calls.at(-1).options.headers.authorization, /if-none-match/);

  assert.equal((await store.putRevision(revision)).status, 'conflict');
  const head = createS3SyncHeadV2(revision, written.snapshotSha256);
  assert.deepEqual(await store.putHead(head), { status: 'written', etag: '"head-1"' });
  assert.equal(calls.at(-1).options.headers['if-none-match'], '*');

  const remoteHead = await store.getHead();
  assert.deepEqual(remoteHead, { status: 'found', head, etag: '"head-1"' });
  const remoteRevision = await store.getRevision(head.revision, head.snapshotSha256);
  assert.equal(remoteRevision.status, 'found');
  assert.deepEqual(remoteRevision.revision, revision);

  assert.deepEqual(await store.putHead(head, '"stale-etag"'), { status: 'conflict' });
  assert.deepEqual(await store.putHead(head, '"head-1"'), { status: 'written', etag: '"head-2"' });
  assert.equal(calls.at(-1).options.headers['if-match'], '"head-1"');
});

test('S3 v2 object store rejects a revision whose bytes do not match the shared head', async () => {
  const revision = createRevision();
  const body = serializeEncryptedS3RevisionV2(
    encryptS3RevisionV2(revision, SECRET_KEY, (size) => Buffer.alloc(size, size)),
  );
  const store = new S3V2ObjectStore({
    endpoint: ENDPOINT,
    bucket: BUCKET,
    region: 'us-east-1',
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET_KEY,
    fetchImpl: async () => new Response(body, { status: 200 }),
  });
  await assert.rejects(
    store.getRevision(revision.revision, '0'.repeat(64)),
    /digest does not match the shared head/,
  );
});

test('S3 v2 object store can abort an active request during shutdown', async () => {
  let requestStarted;
  const started = new Promise((resolve) => { requestStarted = resolve; });
  const owner = new AbortController();
  const store = new S3V2ObjectStore({
    endpoint: ENDPOINT,
    bucket: BUCKET,
    region: 'us-east-1',
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET_KEY,
    fetchImpl: async (_url, options) => {
      requestStarted();
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('credential-bearing request')), { once: true });
      });
    },
    signal: owner.signal,
  });
  const pending = store.getHead();
  await started;
  owner.abort();
  await assert.rejects(pending, /^Error: S3 sync was cancelled\.$/);

  const alreadyAborted = new S3V2ObjectStore({
    endpoint: ENDPOINT,
    bucket: BUCKET,
    region: 'us-east-1',
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET_KEY,
    signal: owner.signal,
    fetchImpl: async (_url, options) => {
      assert.equal(options.signal.aborted, true);
      throw new Error('aborted');
    },
  });
  await assert.rejects(alreadyAborted.getHead(), /^Error: S3 sync was cancelled\.$/);
});
