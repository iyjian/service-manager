const assert = require('node:assert/strict');
const test = require('node:test');
const { createCipheriv, hkdfSync, createHash } = require('node:crypto');
const { ReadableStream } = require('node:stream/web');
const {
  NOTES_DATABASE_OBJECT_KEY, NotesDatabaseS3Store, encryptNotesDatabase, decryptNotesDatabase,
} = require('../dist/main/s3/notesDatabaseS3');
const { getS3SyncEncryptionKeyId } = require('../dist/main/s3/s3SyncV4');
const { signS3Request } = require('../dist/main/s3/s3Request');

const KEY = Buffer.alloc(32, 0x11).toString('base64url');
const OLD_KEY = 'previous shared passphrase';
const SOURCE = Buffer.from([0, 255, 128, 1, 0, 42]);
const HEADER = 108;
const LIMIT = 128 * 1024 * 1024;
const fixedRandom = (size) => Buffer.alloc(size, size);
const encrypted = (bytes = SOURCE, key = KEY) => encryptNotesDatabase(bytes, key, fixedRandom);
const options = (overrides = {}) => ({
  endpoint: 'http://localhost:9000/', bucket: ' notes-bucket ', region: 'us-east-1',
  accessKeyId: 'test-access', secretAccessKey: 'test-secret', syncEncryptionKey: KEY,
  now: () => new Date('2026-09-12T00:00:00Z'), ...overrides,
});
const store = (fetchImpl, overrides = {}) => new NotesDatabaseS3Store(options({ fetchImpl, ...overrides }));
const response = (body = encrypted(), headers = {}) => new Response(body, {
  headers: { etag: '"database-etag"', ...headers },
});

test('binary v5 envelope round trips arbitrary bytes and has a stable authenticated wire format', () => {
  const envelope = encrypted();
  assert.equal(NOTES_DATABASE_OBJECT_KEY, 'service-manager-sync-v5/notes/database.sqlite3.enc');
  assert.equal(envelope.length, SOURCE.length + HEADER);
  assert.equal(envelope.subarray(0, 8).toString('ascii'), 'SMNDBS3\0');
  assert.equal(envelope.readUInt16BE(8), 5);
  assert.equal(envelope.readUInt16BE(10), HEADER);
  assert.equal(envelope.readUInt32BE(12), SOURCE.length);
  assert.equal(envelope.subarray(16, 48).toString('hex'), getS3SyncEncryptionKeyId(KEY));
  // Independently derive and encrypt to pin domain separation, key material, AAD and offsets.
  const key = hkdfSync('sha256', Buffer.alloc(32, 0x11),
    Buffer.concat([Buffer.from('service-manager-sync-v5/notes/database/salt\0'), Buffer.alloc(32, 32)]),
    Buffer.from(`${NOTES_DATABASE_OBJECT_KEY}\0AES-256-GCM`), 32);
  const cipher = createCipheriv('aes-256-gcm', key, Buffer.alloc(12, 12));
  cipher.setAAD(envelope.subarray(0, 92));
  assert.deepEqual(Buffer.concat([cipher.update(SOURCE), cipher.final()]), envelope.subarray(HEADER));
  assert.deepEqual(cipher.getAuthTag(), envelope.subarray(92, HEADER));
  assert.deepEqual(decryptNotesDatabase(envelope, KEY), {
    bytes: SOURCE, encryptionKeyId: getS3SyncEncryptionKeyId(KEY),
  });
  assert.deepEqual(decryptNotesDatabase(encrypted(Buffer.alloc(0)), KEY).bytes, Buffer.alloc(0));
});

test('random encryption is fresh and passphrases normalize consistently', () => {
  assert.notDeepEqual(encryptNotesDatabase(SOURCE, KEY), encryptNotesDatabase(SOURCE, KEY));
  const envelope = encrypted(SOURCE, `  ${OLD_KEY}  `);
  assert.deepEqual(decryptNotesDatabase(envelope, OLD_KEY).bytes, SOURCE);
  assert.equal(decryptNotesDatabase(envelope, OLD_KEY).encryptionKeyId, getS3SyncEncryptionKeyId(OLD_KEY));
  for (const bad of ['', '12345678', null]) {
    assert.throws(() => encryptNotesDatabase(SOURCE, bad), /Encryption Key/);
    assert.throws(() => decryptNotesDatabase(encrypted(), bad), /Encryption Key/);
  }
  for (const badRandom of [() => Buffer.alloc(1), () => new Uint8Array(32)]) {
    assert.throws(() => encryptNotesDatabase(SOURCE, KEY, badRandom), /randomness/);
  }
});

test('rotation reads the previous key and reports its identity; writes always use the current key', async () => {
  const old = encrypted(SOURCE, OLD_KEY);
  assert.throws(() => decryptNotesDatabase(old, KEY), /key does not match/);
  assert.deepEqual(decryptNotesDatabase(old, KEY, OLD_KEY), {
    bytes: SOURCE, encryptionKeyId: getS3SyncEncryptionKeyId(OLD_KEY),
  });
  assert.deepEqual(decryptNotesDatabase(encrypted(), KEY, OLD_KEY).bytes, SOURCE);
  assert.throws(() => decryptNotesDatabase(old, KEY, 'another passphrase'), /key does not match/);
  const client = store(async (_url, init) => {
    if (init.method === 'GET') return response(old);
    assert.equal(decryptNotesDatabase(init.body, KEY).encryptionKeyId, getS3SyncEncryptionKeyId(KEY));
    assert.throws(() => decryptNotesDatabase(init.body, OLD_KEY), /key does not match/);
    return new Response(null, { status: 200 });
  }, { previousSyncEncryptionKey: OLD_KEY });
  assert.equal((await client.get()).encryptionKeyId, getS3SyncEncryptionKeyId(OLD_KEY));
  await client.put(SOURCE, '"previous"');
});

test('all header fields, tag and ciphertext resist tampering; truncation and trailing bytes fail', () => {
  const envelope = encrypted();
  for (let offset = 0; offset < envelope.length; offset += 1) {
    const tampered = Buffer.from(envelope);
    tampered[offset] ^= 1;
    assert.throws(() => decryptNotesDatabase(tampered, KEY), /invalid|key does not match|authenticated/);
  }
  for (const length of [0, 7, 16, HEADER - 1, envelope.length - 1]) {
    assert.throws(() => decryptNotesDatabase(envelope.subarray(0, length), KEY), /invalid/);
  }
  assert.throws(() => decryptNotesDatabase(Buffer.concat([envelope, Buffer.alloc(1)]), KEY), /invalid/);
  const relabelled = Buffer.from(envelope);
  Buffer.from(getS3SyncEncryptionKeyId(OLD_KEY), 'hex').copy(relabelled, 16);
  assert.throws(() => decryptNotesDatabase(relabelled, KEY, OLD_KEY), /authenticated/);
  for (const value of [null, 'not binary', new Uint8Array(2)]) {
    assert.throws(() => encryptNotesDatabase(value, KEY), /invalid/);
    assert.throws(() => decryptNotesDatabase(value, KEY), /invalid/);
  }
});

test('128 MiB plaintext is supported; larger plaintext and declared lengths are rejected', () => {
  const bytes = Buffer.alloc(LIMIT, 0x61);
  const envelope = encrypted(bytes);
  assert.equal(envelope.length, LIMIT + HEADER);
  const decrypted = decryptNotesDatabase(envelope, KEY).bytes;
  assert.equal(createHash('sha256').update(decrypted).digest('hex'), createHash('sha256').update(bytes).digest('hex'));
  assert.throws(() => encryptNotesDatabase(Buffer.alloc(LIMIT + 1), KEY), /size is invalid/);
  const oversizedHeader = Buffer.from(encrypted().subarray(0, HEADER));
  oversizedHeader.writeUInt32BE(LIMIT + 1, 12);
  assert.throws(() => decryptNotesDatabase(oversizedHeader, KEY), /size is invalid/);
});

test('GET streams binary chunks and signs the MinIO path including its port', async () => {
  const envelope = encrypted();
  let index = 0;
  const client = store(async (url, init) => {
    assert.equal(url, `http://localhost:9000/notes-bucket/${NOTES_DATABASE_OBJECT_KEY}`);
    const signed = signS3Request({
      ...options(), method: 'GET', objectUrl: url, now: options().now(),
    });
    assert.deepEqual(init.headers, signed.headers);
    assert.match(signed.canonicalRequest, /host:localhost:9000/);
    assert.equal(init.redirect, 'manual');
    assert.equal(init.body, undefined);
    return response(new ReadableStream({
      pull(controller) {
        if (index === envelope.length) controller.close();
        else controller.enqueue(envelope.subarray(index, ++index));
      },
    }), { 'content-length': String(envelope.length) });
  });
  assert.deepEqual(await client.get(), {
    status: 'found', bytes: SOURCE, etag: '"database-etag"', encryptionKeyId: getS3SyncEncryptionKeyId(KEY),
  });
});

test('conditional GET signs the exact known ETag in the MinIO request and accepts 304', async () => {
  const knownEtag = '"previous-database-2"';
  let calls = 0;
  const client = store(async (url, init) => {
    calls += 1;
    assert.equal(url, `http://localhost:9000/notes-bucket/${NOTES_DATABASE_OBJECT_KEY}`);
    assert.equal(init.method, 'GET');
    assert.equal(init.headers['if-none-match'], knownEtag);
    assert.equal(init.headers['if-match'], undefined);
    assert.equal(init.body, undefined);
    const signed = signS3Request({
      ...options(), method: 'GET', objectUrl: url, now: options().now(), ifNoneMatch: knownEtag,
    });
    assert.deepEqual(init.headers, signed.headers);
    assert.match(signed.canonicalRequest, /host:localhost:9000\nif-none-match:"previous-database-2"\n/);
    assert.match(init.headers.authorization, /SignedHeaders=host;if-none-match;x-amz-content-sha256;x-amz-date/);
    return new Response(null, { status: 304 });
  });
  assert.deepEqual(await client.get(knownEtag), { status: 'not-modified' });
  assert.equal(calls, 1);
});

test('304 skips response metadata, body reads and decryption, and does not await body cancellation', async () => {
  let cancelled = false;
  const client = store(async () => ({
    status: 304,
    headers: { get() { assert.fail('304 must not inspect response metadata'); } },
    body: {
      getReader() { assert.fail('304 must not read a database body'); },
      cancel() { cancelled = true; return new Promise(() => {}); },
    },
  }), { timeoutMs: 1000 });
  assert.deepEqual(await client.get('"cached"'), { status: 'not-modified' });
  assert.equal(cancelled, true);
});

test('unconditional GET and PUT reject unsolicited 304; default GET remains unconditional', async () => {
  const client = store(async (_url, init) => {
    if (init.method === 'GET') assert.equal(init.headers['if-none-match'], undefined);
    return new Response(null, { status: 304 });
  });
  await assert.rejects(client.get(), /HTTP 304/);
  await assert.rejects(client.get(undefined), /HTTP 304/);
  await assert.rejects(client.put(SOURCE), /HTTP 304/);
  await assert.rejects(client.put(SOURCE, '"old"'), /HTTP 304/);
});

test('conditional GET still decrypts changed objects, reports 404 missing, and rejects errors and corrupt bodies', async () => {
  const knownEtag = '"old"';
  const changed = Buffer.from('updated database bytes');
  const client = store(async (_url, init) => {
    assert.equal(init.headers['if-none-match'], knownEtag);
    return response(encrypted(changed), { etag: '"new"' });
  });
  assert.deepEqual(await client.get(knownEtag), {
    status: 'found', bytes: changed, etag: '"new"', encryptionKeyId: getS3SyncEncryptionKeyId(KEY),
  });
  assert.deepEqual(await store(async () => new Response(null, { status: 404 })).get(knownEtag), { status: 'missing' });
  for (const status of [204, 206, 403, 412, 500]) {
    await assert.rejects(store(async () => new Response(null, { status })).get(knownEtag), new RegExp(`HTTP ${status}`));
  }
  const corrupt = encrypted();
  corrupt[92] ^= 1;
  await assert.rejects(store(async () => response(corrupt)).get(knownEtag), /authenticated/);
  await assert.rejects(store(async () => new Response(encrypted())).get(knownEtag), /missing an ETag/);
});

test('conditional GET validates its known ETag before fetching and signer rejects unsafe exact conditions', async () => {
  let calls = 0;
  const client = store(async () => { calls += 1; return new Response(null, { status: 304 }); });
  for (const value of ['', '*', 'W/"weak"', 'plain', '"one", "two"', ' "padded" ',
    '"x"\r\nsecret', `"${'x'.repeat(512)}"`, null, 123]) {
    await assert.rejects(client.get(value), /ETag/);
  }
  assert.equal(calls, 0);
  for (const value of ['', '\r\nsecret', 'x'.repeat(513), null]) {
    assert.throws(() => signS3Request({
      ...options(), method: 'GET', now: options().now(),
      objectUrl: `http://localhost:9000/notes-bucket/${NOTES_DATABASE_OBJECT_KEY}`, ifNoneMatch: value,
    }), /ETag/);
  }
});

test('conditional GET retains cancellation and timeout protection', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(store(async () => { assert.fail('must not fetch'); }, {
    signal: controller.signal,
  }).get('"cached"'), /cancelled/);
  await assert.rejects(store(async () => new Promise(() => {}), { timeoutMs: 20 }).get('"cached"'), /timed out/);
  const duringRequest = new AbortController();
  await assert.rejects(store(async () => {
    duringRequest.abort();
    return new Response(null, { status: 304 });
  }, { signal: duringRequest.signal }).get('"cached"'), /cancelled/);
});

test('PUT signs octet-stream payload and either If-None-Match or the exact If-Match', async () => {
  for (const expectedEtag of [undefined, '"old-etag-2"']) {
    const client = store(async (url, init) => {
      assert.equal(init.method, 'PUT');
      assert.equal(init.headers['content-type'], 'application/octet-stream');
      assert.equal(init.headers['if-match'], expectedEtag);
      assert.equal(init.headers['if-none-match'], expectedEtag === undefined ? '*' : undefined);
      assert.ok(Buffer.isBuffer(init.body));
      assert.deepEqual(decryptNotesDatabase(init.body, KEY).bytes, SOURCE);
      const signed = signS3Request({
        ...options(), objectUrl: url, now: options().now(), method: 'PUT', payload: init.body,
        contentType: 'application/octet-stream',
        ...(expectedEtag === undefined ? { ifNoneMatch: '*' } : { ifMatch: expectedEtag }),
      });
      assert.deepEqual(init.headers, signed.headers);
      return new Response(null, { status: 200, headers: { etag: '"new-etag"' } });
    });
    assert.deepEqual(await client.put(SOURCE, expectedEtag), {
      status: 'written', etag: '"new-etag"', byteLength: SOURCE.length + HEADER,
    });
  }
  assert.deepEqual(await store(async () => new Response(null, { status: 204 })).put(SOURCE), {
    status: 'written', byteLength: SOURCE.length + HEADER,
  });
});

test('GET 404 alone is missing; PUT 409/412 conflict without retries; error bodies are discarded', async () => {
  for (const method of ['get', 'put']) {
    for (const status of [200, 301, 307, 400, 401, 403, 404, 409, 412, 429, 500, 503]) {
      if (method === 'get' && status === 200) continue;
      let cancelled = false;
      let calls = 0;
      const client = store(async () => {
        calls += 1;
        return new Response(new ReadableStream({
          cancel() { cancelled = true; return new Promise(() => {}); },
        }), { status });
      }, { timeoutMs: 1000 });
      const pending = method === 'get' ? client.get() : client.put(SOURCE);
      if (method === 'get' && status === 404) assert.deepEqual(await pending, { status: 'missing' });
      else if (method === 'put' && [409, 412].includes(status)) assert.deepEqual(await pending, { status: 'conflict' });
      else if (method === 'put' && status === 200) assert.equal((await pending).status, 'written');
      else await assert.rejects(pending, new RegExp(`HTTP ${status}`));
      assert.equal(calls, 1);
      assert.equal(cancelled, true);
    }
  }
  await assert.rejects(store(async () => new Response('SQL password secret', { status: 403 })).get(),
    (error) => !/SQL|password|secret/.test(error.message) && /403/.test(error.message));
  await assert.rejects(store(async () => { throw new Error('SQL password secret'); }).get(),
    { message: 'The S3 Notes database request failed.' });
  await assert.rejects(store(async () => response(new ReadableStream({
    start(controller) { controller.error(new Error('SQL password secret')); },
  }))).get(), { message: 'The S3 Notes database request failed.' });
});

test('GET rejects unexpected success statuses and absent or unsafe ETags', async () => {
  for (const status of [201, 204, 206]) {
    await assert.rejects(store(async () => new Response(null, { status })).get(), new RegExp(`HTTP ${status}`));
  }
  await assert.rejects(store(async () => new Response(encrypted())).get(), /missing an ETag/);
  for (const value of ['', '*', 'W/"weak"', '"one", "two"', 'plain', `"${'x'.repeat(512)}"`]) {
    await assert.rejects(store(async () => response(encrypted(), { etag: value })).get(), /ETag is invalid/);
    await assert.rejects(store(async () => { assert.fail('must not fetch'); }).put(SOURCE, value), /ETag is invalid/);
  }
  await assert.rejects(store(async () => { assert.fail('must not fetch'); }).put(SOURCE, '"x"\r\nsecret'), /ETag is invalid/);
});

test('streaming bounds reject invalid metadata, oversized headers, truncation and extra chunks', async () => {
  for (const contentLength of ['-1', 'NaN', '1.1', '0', String(LIMIT + HEADER + 1), '999999999999999999999']) {
    let cancelled = false;
    await assert.rejects(store(async () => response(new ReadableStream({
      cancel() { cancelled = true; },
    }), { 'content-length': contentLength })).get(), /size is invalid/);
    assert.equal(cancelled, true);
  }
  const oversized = Buffer.from(encrypted().subarray(0, HEADER));
  oversized.writeUInt32BE(LIMIT + 1, 12);
  let cancelled = false;
  await assert.rejects(store(async () => response(new ReadableStream({
    start(controller) { controller.enqueue(oversized); },
    cancel() { cancelled = true; },
  }))).get(), /size is invalid/);
  assert.equal(cancelled, true);
  for (const body of [Buffer.alloc(0), encrypted().subarray(0, HEADER - 1), encrypted().subarray(0, HEADER),
    Buffer.concat([encrypted(), Buffer.alloc(1)])]) {
    await assert.rejects(store(async () => response(body)).get(), /size is invalid/);
  }
  await assert.rejects(store(async () => response(encrypted(), { 'content-length': String(HEADER) })).get(), /size is invalid/);
  await assert.rejects(store(async () => response(null)).get(), /size is invalid/);
  await assert.rejects(store(async () => response(new ReadableStream({
    start(controller) { controller.enqueue(encrypted()); controller.enqueue(Buffer.alloc(1)); controller.close(); },
  }))).get(), /size is invalid/);
});

test('already cancelled operations never encrypt or fetch', async () => {
  const controller = new AbortController();
  controller.abort(new Error('private reason'));
  const client = store(async () => { assert.fail('must not fetch'); }, { signal: controller.signal });
  await assert.rejects(client.get(), /cancelled/);
  await assert.rejects(client.put(null), /cancelled/);
});

test('owner cancellation interrupts fetch and stalled streams even when transport ignores abort', async () => {
  for (const phase of ['fetch', 'stream']) {
    const controller = new AbortController();
    let entered;
    const ready = new Promise((resolve) => { entered = resolve; });
    let cancelled = false;
    let requestSignal;
    const client = store(async (_url, init) => {
      requestSignal = init.signal;
      if (phase === 'fetch') { entered(); return new Promise(() => {}); }
      return response(new ReadableStream({
        pull() { entered(); },
        cancel() { cancelled = true; return new Promise(() => {}); },
      }));
    }, { signal: controller.signal });
    const pending = client.get();
    await ready;
    controller.abort(new Error('SQL private reason'));
    await assert.rejects(pending, { message: 'The S3 Notes database request was cancelled.' });
    assert.equal(requestSignal.aborted, true);
    if (phase === 'stream') assert.equal(cancelled, true);
  }
});

test('deadlines bound stalled GET/PUT fetches, streamed reads, and late response cleanup', async () => {
  for (const method of ['get', 'put']) {
    let finish;
    let signal;
    const client = store((_url, init) => {
      signal = init.signal;
      return new Promise((resolve) => { finish = resolve; });
    }, { timeoutMs: 20 });
    await assert.rejects(method === 'get' ? client.get() : client.put(SOURCE), /timed out/);
    assert.equal(signal.aborted, true);
    let cancelled = false;
    finish(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cancelled, true);
  }
  let cancelled = false;
  await assert.rejects(store(async () => response(new ReadableStream({
    start(controller) { controller.enqueue(encrypted().subarray(0, HEADER)); },
    cancel() { cancelled = true; return new Promise(() => {}); },
  })), { timeoutMs: 20 }).get(), /timed out/);
  assert.equal(cancelled, true);
});

test('deadline is checked after synchronous signing work and before network dispatch', async () => {
  await assert.rejects(store(async () => { assert.fail('must not fetch'); }, {
    timeoutMs: 10,
    now: () => {
      const end = performance.now() + 30;
      while (performance.now() < end) { /* Simulate a blocking callback. */ }
      return new Date();
    },
  }).get(), /timed out/);
});

test('constructor validates endpoint, bucket, keys, credentials, region and timeout', () => {
  for (const override of [
    { endpoint: 'http://remote.example' }, { endpoint: 'https://user:secret@example.test' },
    { endpoint: 'https://example.test/bucket' }, { bucket: 'INVALID' },
    { syncEncryptionKey: 'short' }, { previousSyncEncryptionKey: '' },
    { accessKeyId: '' }, { accessKeyId: 'key\nsecret' }, { secretAccessKey: '' },
    { region: 'bad/region' }, { timeoutMs: 0 }, { timeoutMs: -1 }, { timeoutMs: NaN },
    { timeoutMs: Infinity }, { timeoutMs: 1.5 }, { timeoutMs: 300001 },
  ]) assert.throws(() => new NotesDatabaseS3Store(options(override)));
});
