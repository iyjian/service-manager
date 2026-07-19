const assert = require('node:assert/strict');
const test = require('node:test');

const {
  NOTES_IMAGE_LIMITS,
  NotesImageS3Store,
  buildNotesImageS3ObjectUrl,
  createEncryptedNotesImageObject,
  decryptNotesImageObject,
  inspectNotesImage,
  parseEncryptedNotesImageObject,
  parseNotesImageReference,
} = require('../dist/main/notesImageS3');

function png(width = 320, height = 180, length = 24) {
  const bytes = Buffer.alloc(Math.max(24, length));
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

function jpeg(width = 640, height = 480) {
  return Buffer.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x0b, 0x08,
    (height >>> 8) & 0xff, height & 0xff,
    (width >>> 8) & 0xff, width & 0xff,
    0x01, 0x01, 0x11, 0x00,
    0xff, 0xd9,
  ]);
}

function webp(width = 800, height = 600) {
  const bytes = Buffer.alloc(30);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(bytes.byteLength - 8, 4);
  bytes.write('WEBP', 8, 'ascii');
  bytes.write('VP8X', 12, 'ascii');
  bytes.writeUInt32LE(10, 16);
  bytes.writeUIntLE(width - 1, 24, 3);
  bytes.writeUIntLE(height - 1, 27, 3);
  return bytes;
}

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
    mimeType: 'image/png',
    byteLength: 24,
    width: 320,
    height: 180,
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
    now: () => new Date('2026-07-19T00:00:00.000Z'),
    createRandomBytes: deterministicRandom(),
    ...overrides,
  };
}

test('Notes image inspection derives PNG, JPEG, and WebP MIME types and dimensions from bytes', () => {
  assert.deepEqual(inspectNotesImage(png(), 'image/png'), {
    mimeType: 'image/png',
    byteLength: 24,
    width: 320,
    height: 180,
  });
  assert.deepEqual(inspectNotesImage(jpeg(), 'image/jpeg'), {
    mimeType: 'image/jpeg',
    byteLength: 17,
    width: 640,
    height: 480,
  });
  assert.deepEqual(inspectNotesImage(webp(), 'image/webp'), {
    mimeType: 'image/webp',
    byteLength: 30,
    width: 800,
    height: 600,
  });
});

test('Notes image inspection rejects MIME spoofing, malformed data, excessive bytes, dimensions, and pixels', () => {
  assert.throws(() => inspectNotesImage('not binary image data'), /image data is invalid/);
  assert.throws(() => inspectNotesImage(png(), 'image/jpeg'), /type does not match/);
  assert.throws(() => inspectNotesImage(Buffer.from('<svg onload=alert(1)>')), /Only PNG, JPEG, and WebP/);
  assert.throws(() => inspectNotesImage(png(320, 180, NOTES_IMAGE_LIMITS.bytes + 1)), /must not exceed 10 MiB/);
  assert.throws(() => inspectNotesImage(png(NOTES_IMAGE_LIMITS.dimension + 1, 1)), /dimensions are not supported/);
  assert.throws(() => inspectNotesImage(png(7_000, 7_000)), /dimensions are not supported/);
  assert.throws(() => inspectNotesImage(Buffer.from([0xff, 0xd8, 0xff, 0xd9])), /dimensions are unavailable/);
  const malformedWebp = webp();
  malformedWebp.writeUInt32LE(2, 4);
  assert.throws(() => inspectNotesImage(malformedWebp), /WebP image header is invalid/);
});

test('Notes image objects use opaque random identities, independent asset keys, AES-GCM, and bound digests', () => {
  const source = png(1_024, 768);
  const created = createEncryptedNotesImageObject(
    source,
    'image/png',
    'Architecture diagram',
    deterministicRandom(),
  );

  assert.equal(Buffer.from(created.reference.objectId, 'base64url').byteLength, 24);
  assert.equal(Buffer.from(created.reference.assetKey, 'base64url').byteLength, 32);
  assert.equal(created.reference.alt, 'Architecture diagram');
  assert.equal(created.encrypted.encryption.algorithm, 'AES-256-GCM');
  assert.equal(created.encrypted.objectId, created.reference.objectId);
  assert.notEqual(created.encrypted.ciphertext, source.toString('base64'));
  assert.deepEqual(parseEncryptedNotesImageObject(JSON.parse(created.body)), created.encrypted);
  assert.throws(() => parseEncryptedNotesImageObject({
    ...created.encrypted,
    url: 'https://should-not-be-accepted.example/image',
  }), /object is invalid/);
  assert.deepEqual(decryptNotesImageObject(created.reference, created.encrypted), source);

  const changedId = Buffer.alloc(24, 0x7f).toString('base64url');
  assert.throws(() => decryptNotesImageObject(
    { ...created.reference, objectId: changedId },
    { ...created.encrypted, objectId: changedId },
  ), /could not be decrypted/);

  const changedCiphertext = Buffer.from(created.encrypted.ciphertext, 'base64');
  changedCiphertext[0] ^= 0x01;
  assert.throws(() => decryptNotesImageObject(created.reference, {
    ...created.encrypted,
    ciphertext: changedCiphertext.toString('base64'),
  }), /could not be decrypted/);
});

test('Notes image reference parsing is exact and cannot carry credentials, URLs, or unbounded attributes', () => {
  const canonical = referenceFixture({ alt: 'Diagram' });
  assert.deepEqual(parseNotesImageReference(canonical), canonical);
  for (const candidate of [
    { ...canonical, url: 'https://signed.example/private' },
    { ...canonical, accessKeyId: 'leak' },
    { ...canonical, secretAccessKey: 'leak' },
    { ...canonical, objectId: 'short' },
    { ...canonical, assetKey: Buffer.alloc(31).toString('base64url') },
    { ...canonical, contentSha256: 'A'.repeat(64) },
    { ...canonical, byteLength: NOTES_IMAGE_LIMITS.bytes + 1 },
    { ...canonical, width: 7_000, height: 7_000 },
    { ...canonical, alt: '\u0000unsafe' },
    { ...canonical, alt: 'x'.repeat(NOTES_IMAGE_LIMITS.altCharacters + 1) },
  ]) {
    assert.throws(() => parseNotesImageReference(candidate), /reference is invalid/);
  }
});

test('Notes image object URL has the fixed opaque v3 path', () => {
  const objectId = Buffer.alloc(24, 0xab).toString('base64url');
  assert.equal(
    buildNotesImageS3ObjectUrl('https://s3.example.com', 'notes-bucket', objectId),
    `https://s3.example.com/notes-bucket/service-manager/v3/images/${objectId}.json`,
  );
  assert.throws(
    () => buildNotesImageS3ObjectUrl('https://s3.example.com', 'notes-bucket', '../secret'),
    /object ID is invalid/,
  );
});

test('Notes image S3 store signs immutable PUT and private GET without exposing configuration in its reference', async () => {
  const calls = [];
  let storedBody = '';
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (init.method === 'PUT') {
      storedBody = String(init.body);
      return new Response(null, { status: 200, headers: { etag: '"image"' } });
    }
    return new Response(storedBody, { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const store = new NotesImageS3Store(storeOptions({ fetchImpl }));
  const source = png(400, 300);
  const reference = await store.uploadImage(source, 'image/png', 'Preview');
  const loaded = await store.downloadImage(reference);

  assert.deepEqual(loaded, source);
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/notes-bucket\/service-manager\/v3\/images\/[A-Za-z0-9_-]{32}\.json$/);
  assert.equal(calls[0].init.method, 'PUT');
  assert.equal(calls[0].init.redirect, 'manual');
  assert.equal(calls[0].init.headers['if-none-match'], '*');
  assert.match(calls[0].init.headers.authorization, /^AWS4-HMAC-SHA256 /);
  assert.equal(calls[1].init.method, 'GET');
  assert.equal(calls[1].init.redirect, 'manual');
  assert.equal(Object.hasOwn(calls[1].init.headers, 'if-none-match'), false);
  assert.equal(Object.hasOwn(reference, 'url'), false);
  assert.equal(Object.hasOwn(reference, 'accessKeyId'), false);
  assert.equal(Object.hasOwn(reference, 'secretAccessKey'), false);
  assert.doesNotMatch(JSON.stringify(reference), /test-access-key|test-secret-key|s3\.example\.com/);
  assert.doesNotMatch(storedBody, /test-access-key|test-secret-key|s3\.example\.com|Preview/);
  await store.shutdown();
});

test('Notes image S3 store keeps HTTP failures bounded and renderer-safe', async () => {
  const source = png();
  const denied = new NotesImageS3Store(storeOptions({
    fetchImpl: async () => new Response(
      '<Error><Code>AccessDenied</Code><Message>do-not-expose-this-body</Message></Error>',
      { status: 403 },
    ),
  }));
  await assert.rejects(
    denied.uploadImage(source, 'image/png'),
    (error) => /403 AccessDenied/.test(error.message) && !/do-not-expose/.test(error.message),
  );

  const conflict = new NotesImageS3Store(storeOptions({
    fetchImpl: async () => new Response(null, { status: 412 }),
  }));
  await assert.rejects(conflict.uploadImage(source, 'image/png'), /upload conflicted/);

  const created = createEncryptedNotesImageObject(source, 'image/png', undefined, deterministicRandom());
  const missing = new NotesImageS3Store(storeOptions({
    fetchImpl: async () => new Response(null, { status: 404 }),
  }));
  await assert.rejects(missing.downloadImage(created.reference), /image is unavailable/);

  const oversized = new NotesImageS3Store(storeOptions({
    fetchImpl: async () => new Response('{}', {
      status: 200,
      headers: { 'content-length': String(20 * 1024 * 1024) },
    }),
  }));
  await assert.rejects(oversized.downloadImage(created.reference), /response is too large/);

  await Promise.all([denied.shutdown(), conflict.shutdown(), missing.shutdown(), oversized.shutdown()]);
});

test('Notes image S3 requests time out and shutdown aborts and owns active work', async () => {
  const waitForAbort = (_url, init) => new Promise((_resolve, reject) => {
    if (init.signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  const timed = new NotesImageS3Store(storeOptions({ fetchImpl: waitForAbort, timeoutMs: 10 }));
  await assert.rejects(timed.uploadImage(png(), 'image/png'), /request timed out/);
  await timed.shutdown();

  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const abortable = new NotesImageS3Store(storeOptions({
    fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
      markStarted();
      if (init.signal.aborted) {
        reject(new Error('aborted'));
        return;
      }
      init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }),
  }));
  const pending = abortable.uploadImage(png(), 'image/png');
  await started;
  const shutdown = abortable.shutdown();
  await assert.rejects(pending, /request was cancelled/);
  await shutdown;
  await assert.rejects(abortable.uploadImage(png(), 'image/png'), /storage is shutting down/);
});
