const assert = require('node:assert/strict');
const test = require('node:test');

const {
  NOTES_ATTACHMENT_LIMITS,
  NotesAttachmentS3Store,
  buildNotesAttachmentS3ObjectUrl,
  createEncryptedNotesAttachmentObject,
  decryptNotesAttachmentObject,
  parseEncryptedNotesAttachmentObject,
  parseNotesAttachmentReference,
} = require('../dist/main/notes/notesAttachmentS3');

function deterministicRandom() {
  const fill = new Map([[24, 0x11], [32, 0x22], [12, 0x33]]);
  return (size) => Buffer.alloc(size, fill.get(size) ?? 0x44);
}

function referenceFixture(overrides = {}) {
  return {
    objectId: Buffer.alloc(24, 0x01).toString('base64url'),
    assetKey: Buffer.alloc(32, 0x02).toString('base64url'),
    ciphertextSha256: 'a'.repeat(64),
    contentSha256: 'b'.repeat(64),
    fileName: 'design-notes.pdf',
    mimeType: 'application/pdf',
    byteLength: 42,
    ...overrides,
  };
}

function storeOptions(overrides = {}) {
  return {
    endpoint: 'https://s3.example.com',
    bucket: 'notes-bucket',
    region: 'us-east-1',
    accessKeyId: 'test-access-key',
    secretAccessKey: 'test-secret-key',
    now: () => new Date('2026-07-22T00:00:00.000Z'),
    createRandomBytes: deterministicRandom(),
    ...overrides,
  };
}

test('Notes attachment objects use independent keys, AES-GCM, and bound plaintext/ciphertext digests', () => {
  const source = Buffer.from('private attachment bytes');
  const created = createEncryptedNotesAttachmentObject(
    source,
    'design-notes.pdf',
    'application/pdf',
    deterministicRandom(),
  );

  assert.equal(Buffer.from(created.reference.objectId, 'base64url').byteLength, 24);
  assert.equal(Buffer.from(created.reference.assetKey, 'base64url').byteLength, 32);
  assert.equal(created.reference.fileName, 'design-notes.pdf');
  assert.equal(created.reference.byteLength, source.byteLength);
  assert.equal(created.encrypted.encryption.algorithm, 'AES-256-GCM');
  assert.notEqual(created.encrypted.ciphertext, source.toString('base64'));
  assert.deepEqual(parseEncryptedNotesAttachmentObject(JSON.parse(created.body)), created.encrypted);
  assert.deepEqual(decryptNotesAttachmentObject(created.reference, created.encrypted), source);
  assert.doesNotMatch(created.body, /design-notes|application\/pdf|private attachment bytes/);

  const tampered = Buffer.from(created.encrypted.ciphertext, 'base64');
  tampered[0] ^= 0x01;
  assert.throws(() => decryptNotesAttachmentObject(created.reference, {
    ...created.encrypted,
    ciphertext: tampered.toString('base64'),
  }), /could not be decrypted/);
  assert.throws(() => decryptNotesAttachmentObject(
    { ...created.reference, contentSha256: 'c'.repeat(64) },
    created.encrypted,
  ), /could not be decrypted/);
  for (const relabelled of [
    { ...created.reference, fileName: 'design-notes.txt' },
    { ...created.reference, mimeType: 'text/plain' },
    { ...created.reference, byteLength: created.reference.byteLength + 1 },
  ]) {
    assert.throws(
      () => decryptNotesAttachmentObject(relabelled, created.encrypted),
      /could not be decrypted/,
    );
  }
});

test('Notes attachment references reject paths, credentials, URLs, reserved names, unsafe MIME, and excess bytes', () => {
  const canonical = referenceFixture();
  assert.deepEqual(parseNotesAttachmentReference(canonical), canonical);
  for (const candidate of [
    { ...canonical, url: 'https://signed.example/private' },
    { ...canonical, accessKeyId: 'leak' },
    { ...canonical, secretAccessKey: 'leak' },
    { ...canonical, fileName: '../secret.txt' },
    { ...canonical, fileName: 'folder/file.txt' },
    { ...canonical, fileName: 'CON.txt' },
    { ...canonical, fileName: 'trailing. ' },
    { ...canonical, mimeType: 'text/html; charset=utf-8' },
    { ...canonical, byteLength: NOTES_ATTACHMENT_LIMITS.bytes + 1 },
  ]) {
    assert.throws(() => parseNotesAttachmentReference(candidate), /reference is invalid/);
  }
});

test('Notes attachment creation rejects empty and oversized files', () => {
  assert.throws(
    () => createEncryptedNotesAttachmentObject(Buffer.alloc(0), 'empty.txt', 'text/plain'),
    /must not exceed 25 MiB/,
  );
  assert.throws(
    () => createEncryptedNotesAttachmentObject(
      Buffer.alloc(NOTES_ATTACHMENT_LIMITS.bytes + 1),
      'large.bin',
      'application/octet-stream',
    ),
    /must not exceed 25 MiB/,
  );
});

test('Notes attachment object URL has a fixed opaque v4 path', () => {
  const objectId = Buffer.alloc(24, 0xab).toString('base64url');
  assert.equal(
    buildNotesAttachmentS3ObjectUrl('https://s3.example.com', 'notes-bucket', objectId),
    `https://s3.example.com/notes-bucket/service-manager/v4/attachments/${objectId}.json`,
  );
  assert.throws(
    () => buildNotesAttachmentS3ObjectUrl('https://s3.example.com', 'notes-bucket', '../secret'),
    /object ID is invalid/,
  );
});

test('Notes attachment S3 store signs immutable PUT and private GET without leaking configuration', async () => {
  const calls = [];
  let storedBody = '';
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (init.method === 'PUT') {
      storedBody = String(init.body);
      return new Response(null, { status: 200, headers: { etag: '"attachment"' } });
    }
    return new Response(storedBody, { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const store = new NotesAttachmentS3Store(storeOptions({ fetchImpl }));
  const source = Buffer.from('attachment body');
  const reference = await store.uploadAttachment(source, 'report.csv', 'text/csv');
  const loaded = await store.downloadAttachment(reference);

  assert.deepEqual(loaded, source);
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/notes-bucket\/service-manager\/v4\/attachments\/[A-Za-z0-9_-]{32}\.json$/);
  assert.equal(calls[0].init.method, 'PUT');
  assert.equal(calls[0].init.redirect, 'manual');
  assert.equal(calls[0].init.headers['if-none-match'], '*');
  assert.match(calls[0].init.headers.authorization, /^AWS4-HMAC-SHA256 /);
  assert.equal(calls[1].init.method, 'GET');
  assert.equal(calls[1].init.redirect, 'manual');
  assert.doesNotMatch(JSON.stringify(reference), /test-access-key|test-secret-key|s3\.example\.com/);
  assert.doesNotMatch(storedBody, /test-access-key|test-secret-key|s3\.example\.com|report\.csv|attachment body/);
  await store.shutdown();
});

test('Notes attachment S3 failures are bounded and missing objects remain distinguishable', async () => {
  const denied = new NotesAttachmentS3Store(storeOptions({
    fetchImpl: async () => new Response(
      '<Error><Code>AccessDenied</Code><Message>do-not-expose-this-body</Message></Error>',
      { status: 403 },
    ),
  }));
  await assert.rejects(
    denied.uploadAttachment(Buffer.from('x'), 'a.txt', 'text/plain'),
    (error) => /403 AccessDenied/.test(error.message) && !/do-not-expose/.test(error.message),
  );

  const created = createEncryptedNotesAttachmentObject(
    Buffer.from('x'),
    'a.txt',
    'text/plain',
    deterministicRandom(),
  );
  const missing = new NotesAttachmentS3Store(storeOptions({
    fetchImpl: async () => new Response(null, { status: 404 }),
  }));
  await assert.rejects(missing.downloadAttachment(created.reference), /attachment is unavailable/);

  const oversized = new NotesAttachmentS3Store(storeOptions({
    fetchImpl: async () => new Response('{}', {
      status: 200,
      headers: { 'content-length': String(40 * 1024 * 1024) },
    }),
  }));
  await assert.rejects(oversized.downloadAttachment(created.reference), /response is too large/);
  await Promise.all([denied.shutdown(), missing.shutdown(), oversized.shutdown()]);
});

test('Notes attachment requests time out and shutdown aborts owned work', async () => {
  const waitForAbort = (_url, init) => new Promise((_resolve, reject) => {
    if (init.signal.aborted) return reject(new Error('aborted'));
    init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  const timed = new NotesAttachmentS3Store(storeOptions({ fetchImpl: waitForAbort, timeoutMs: 10 }));
  await assert.rejects(timed.uploadAttachment(Buffer.from('x'), 'a.txt', 'text/plain'), /request timed out/);
  await timed.shutdown();

  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const abortable = new NotesAttachmentS3Store(storeOptions({
    fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
      markStarted();
      if (init.signal.aborted) return reject(new Error('aborted'));
      init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }),
  }));
  const pending = abortable.uploadAttachment(Buffer.from('x'), 'a.txt', 'text/plain');
  await started;
  const shutdown = abortable.shutdown();
  await assert.rejects(pending, /request was cancelled/);
  await shutdown;
  await assert.rejects(
    abortable.uploadAttachment(Buffer.from('x'), 'a.txt', 'text/plain'),
    /storage is shutting down/,
  );
});
