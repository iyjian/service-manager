const assert = require('node:assert/strict');
const test = require('node:test');

const {
  S3V4ObjectStore,
  assertS3SyncHeadMatchesManifestV4,
  buildS3V4HeadObjectUrl,
  buildS3V4ManifestObjectUrl,
  buildS3V4NoteObjectUrl,
  buildS3V4NotesTreeObjectUrl,
  createS3SyncHeadV4,
  createS3SyncEncryptionKey,
  createS3V4ObjectId,
  createServiceManagerNoteObjectV4,
  createServiceManagerNotesTreeObjectV4,
  createServiceManagerSyncManifestV4,
  decryptS3ManifestV4,
  decryptS3NoteV4,
  decryptS3NotesTreeV4,
  encryptS3ManifestV4,
  encryptS3NoteV4,
  encryptS3NotesTreeV4,
  hashS3V4NoteContent,
  hashS3V4NotesTreeContent,
  hashS3V4Object,
  getS3SyncEncryptionKeyId,
  normalizeS3SyncEncryptionKey,
  parseS3V4ManifestData,
  parseS3V4NotesTreePayload,
  serializeEncryptedS3ObjectV4,
  signS3V4Request,
} = require('../dist/main/s3/s3SyncV4');
const { NOTE_LIMITS } = require('../dist/main/notes/notesStore');

const ENDPOINT = 'https://s3.example.test';
const BUCKET = 'service-manager';
const ACCESS_KEY = 'AKIDEXAMPLE';
const SECRET_KEY = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';
const SYNC_KEY = Buffer.alloc(32, 0x5a).toString('base64url');
const NOW = new Date('2026-07-19T04:05:06.000Z');

function note(overrides = {}) {
  return {
    id: 'note-private-stable-id',
    name: 'Deploy production',
    content: 'echo highly-sensitive-command',
    language: 'bash',
    tags: ['production'],
    createdAt: '2026-07-19T01:02:03.000Z',
    updatedAt: '2026-07-19T01:02:04.000Z',
    ...overrides,
  };
}

function treePayload(noteIds = []) {
  return {
    schemaVersion: 1,
    root: [...noteIds],
    order: Object.fromEntries(noteIds.map((id, index) => [id, (index + 1) * 1024])),
    parent: Object.fromEntries(noteIds.map((id) => [id, null])),
  };
}

const EMPTY_TREE_REFERENCE = {
  objectId: 'empty-tree-object',
  sha256: '1'.repeat(64),
  contentHash: '2'.repeat(64),
  encryptionKeyId: getS3SyncEncryptionKeyId(SYNC_KEY),
};

function manifestData(items = [], tombstones = [], tree = EMPTY_TREE_REFERENCE) {
  return {
    schemaVersion: 4,
    hosts: { schemaVersion: 1, items: [] },
    notes: { schemaVersion: 4, items, tombstones, tree },
    proxy: { schemaVersion: 1, settings: { mode: 'rule', customRules: [] } },
  };
}

function manifest(data, overrides = {}) {
  return createServiceManagerSyncManifestV4(data, {
    appVersion: '0.3.19',
    revision: 'manifest-revision-2',
    parentRevision: 'manifest-revision-1',
    clientId: 'client-home',
    createdAt: NOW.toISOString(),
    ...overrides,
  });
}

const deterministicBytes = (size) => Buffer.alloc(size, size);

test('S3 v4 uses an isolated head and opaque immutable object paths', () => {
  const objectId = createS3V4ObjectId((size) => Buffer.alloc(size, 0xfb));
  assert.match(objectId, /^[A-Za-z0-9_-]{32}$/);
  assert.doesNotMatch(objectId, /[+/=]/);
  assert.equal(
    buildS3V4HeadObjectUrl(ENDPOINT, BUCKET),
    `${ENDPOINT}/${BUCKET}/service-manager/v4/head.json`,
  );
  assert.equal(
    buildS3V4ManifestObjectUrl(ENDPOINT, BUCKET, 'manifest-revision-2'),
    `${ENDPOINT}/${BUCKET}/service-manager/v4/manifests/manifest-revision-2.json`,
  );
  assert.equal(
    buildS3V4NoteObjectUrl(ENDPOINT, BUCKET, objectId),
    `${ENDPOINT}/${BUCKET}/service-manager/v4/notes/${objectId}.json`,
  );
  assert.equal(
    buildS3V4NotesTreeObjectUrl(ENDPOINT, BUCKET, objectId),
    `${ENDPOINT}/${BUCKET}/service-manager/v4/notes-trees/${objectId}.json`,
  );
  assert.doesNotMatch(buildS3V4NoteObjectUrl(ENDPOINT, BUCKET, objectId), /note-private-stable-id/);
  assert.throws(() => buildS3V4NoteObjectUrl(ENDPOINT, BUCKET, '../note'), /identity is invalid/);
  assert.throws(() => buildS3V4NotesTreeObjectUrl(ENDPOINT, BUCKET, '../tree'), /identity is invalid/);
  assert.throws(() => buildS3V4ManifestObjectUrl(ENDPOINT, BUCKET, '../revision'), /revision is invalid/);
  for (const url of [
    buildS3V4HeadObjectUrl(ENDPOINT, BUCKET),
    buildS3V4ManifestObjectUrl(ENDPOINT, BUCKET, 'manifest-revision-2'),
    buildS3V4NoteObjectUrl(ENDPOINT, BUCKET, objectId),
    buildS3V4NotesTreeObjectUrl(ENDPOINT, BUCKET, objectId),
  ]) {
    assert.doesNotMatch(url, /service-manager\/v[1-3]\//);
  }
});

test('Sync Encryption Keys accept user passphrases while generated keys retain stable identities', () => {
  const generated = createS3SyncEncryptionKey((size) => Buffer.alloc(size, 0xa5));
  assert.equal(generated, Buffer.alloc(32, 0xa5).toString('base64url'));
  assert.equal(normalizeS3SyncEncryptionKey(generated), generated);
  assert.equal(getS3SyncEncryptionKeyId(generated), getS3SyncEncryptionKeyId(generated));
  assert.equal(getS3SyncEncryptionKeyId(generated).length, 64);
  assert.equal(normalizeS3SyncEncryptionKey('  shared key 2026!  '), 'shared key 2026!');
  assert.equal(normalizeS3SyncEncryptionKey('九个字符的同步密钥示例'), '九个字符的同步密钥示例');
  assert.equal(getS3SyncEncryptionKeyId('shared key 2026!').length, 64);
  for (const invalid of ['', '12345678', '  12345678  ', null]) {
    assert.throws(() => normalizeS3SyncEncryptionKey(invalid), /at least 9 characters/);
  }
  assert.throws(
    () => createS3SyncEncryptionKey(() => Buffer.alloc(31)),
    /randomness is unavailable/,
  );
});

test('S3 v4 encrypts and decrypts with a user-defined Sync Encryption Key', () => {
  const object = createServiceManagerNoteObjectV4(note(), createS3V4ObjectId(deterministicBytes));
  const passphrase = 'shared key 2026!';
  const encrypted = encryptS3NoteV4(object, passphrase, deterministicBytes);
  assert.equal(encrypted.encryption.keyId, getS3SyncEncryptionKeyId(passphrase));
  assert.deepEqual(decryptS3NoteV4(encrypted, passphrase), object);
  assert.throws(() => decryptS3NoteV4(encrypted, 'different key 2026!'), /could not be decrypted/);
});

test('S3 v4 Note objects canonicalize rich text and reject unsafe rich text payloads', () => {
  const objectId = createS3V4ObjectId(deterministicBytes);
  const object = createServiceManagerNoteObjectV4(note({
    language: 'richtext',
    content: JSON.stringify({
      content: [{ type: 'paragraph', content: [{ text: 'Shared', type: 'text' }] }],
      type: 'doc',
    }, null, 2),
  }), objectId);
  assert.equal(
    object.note.content,
    '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Shared"}]}]}',
  );
  assert.throws(
    () => createServiceManagerNoteObjectV4(note({
      language: 'richtext',
      content: JSON.stringify({ type: 'doc', content: [{ type: 'html', text: '<img src=x>' }] }),
    }), objectId),
    /rich text content is invalid/,
  );
});

test('S3 v4 encrypts each Note independently and binds its type and opaque object identity', () => {
  const objectId = createS3V4ObjectId((size) => Buffer.alloc(size, 7));
  const object = createServiceManagerNoteObjectV4(note(), objectId);
  const encrypted = encryptS3NoteV4(object, SYNC_KEY, deterministicBytes);
  const serialized = serializeEncryptedS3ObjectV4(encrypted);

  assert.deepEqual(decryptS3NoteV4(encrypted, SYNC_KEY), object);
  assert.equal(encrypted.encryption.keySource, 'sync-key-v1');
  assert.equal(encrypted.encryption.keyId, getS3SyncEncryptionKeyId(SYNC_KEY));
  const { keySource: _keySource, keyId: _keyId, ...encryptionWithoutKeyIdentity } = encrypted.encryption;
  assert.throws(
    () => decryptS3NoteV4({ ...encrypted, encryption: encryptionWithoutKeyIdentity }, SYNC_KEY),
    /could not be decrypted/,
  );
  assert.equal(hashS3V4NoteContent(object), hashS3V4NoteContent(note()));
  assert.equal(hashS3V4NoteContent(object).length, 64);
  assert.doesNotMatch(serialized, /Deploy production|highly-sensitive-command|note-private-stable-id/);
  assert.throws(
    () => decryptS3NoteV4({ ...encrypted, objectId: createS3V4ObjectId((size) => Buffer.alloc(size, 8)) }, SECRET_KEY),
    /could not be decrypted/,
  );
  assert.throws(() => decryptS3NoteV4(encrypted, 'different-secret'), /could not be decrypted/);
  assert.throws(() => decryptS3ManifestV4(encrypted, SYNC_KEY), /manifest could not be decrypted/);
});

test('S3 v4 validates a bounded Notes tree with exact root, order, and parent key sets', () => {
  const value = {
    schemaVersion: 1,
    root: ['root-note', 'second-root'],
    order: {
      'child-note': 1024,
      'root-note': 1024,
      'second-root': 2048,
    },
    parent: {
      'child-note': 'root-note',
      'root-note': null,
      'second-root': null,
    },
  };
  assert.deepEqual(parseS3V4NotesTreePayload(value), value);
  assert.throws(
    () => parseS3V4NotesTreePayload({ ...value, root: ['second-root', 'root-note'] }),
    /roots are invalid/,
  );
  assert.throws(
    () => parseS3V4NotesTreePayload({ ...value, parent: { ...value.parent, 'child-note': 'missing' } }),
    /parent is invalid/,
  );
  assert.throws(
    () => parseS3V4NotesTreePayload({
      schemaVersion: 1,
      root: [],
      order: { a: 1024, b: 1024 },
      parent: { a: 'b', b: 'a' },
    }),
    /cycle/,
  );
  assert.throws(
    () => parseS3V4NotesTreePayload({
      ...value,
      order: { ...value.order, 'second-root': 1024 },
    }),
    /sibling order is invalid/,
  );
  const deepIds = Array.from({ length: 34 }, (_, index) => `depth-${index}`);
  assert.throws(
    () => parseS3V4NotesTreePayload({
      schemaVersion: 1,
      root: [deepIds[0]],
      order: Object.fromEntries(deepIds.map((id) => [id, 1024])),
      parent: Object.fromEntries(deepIds.map((id, index) => [id, index === 0 ? null : deepIds[index - 1]])),
    }),
    /maximum depth of 32/,
  );
});

test('S3 v4 encrypts the Notes tree independently and binds its content digest', () => {
  const tree = treePayload(['root-note', 'second-root']);
  const object = createServiceManagerNotesTreeObjectV4(
    tree,
    createS3V4ObjectId((size) => Buffer.alloc(size, 0x2a)),
  );
  const encrypted = encryptS3NotesTreeV4(object, SYNC_KEY, deterministicBytes);
  const serialized = serializeEncryptedS3ObjectV4(encrypted);

  assert.deepEqual(decryptS3NotesTreeV4(encrypted, SYNC_KEY), object);
  assert.equal(hashS3V4NotesTreeContent(object), hashS3V4NotesTreeContent(tree));
  assert.equal(encrypted.schemaVersion, 4);
  assert.equal(encrypted.syncVersion, 4);
  assert.equal(encrypted.layoutVersion, 4);
  assert.doesNotMatch(serialized, /root-note|second-root/);
  assert.throws(() => decryptS3NoteV4(encrypted, SYNC_KEY), /note could not be decrypted/);
  assert.throws(
    () => decryptS3NotesTreeV4({ ...encrypted, layoutVersion: 3 }, SYNC_KEY),
    /could not be decrypted/,
  );
});

test('S3 v4 round-trips a maximum-length Note when JSON escaping expands every character', async () => {
  const objects = new Map();
  const fetchImpl = async (url, options) => {
    if (options.method === 'PUT') {
      objects.set(url, options.body);
      return new Response(null, { status: 200, headers: { etag: '"note-etag"' } });
    }
    const body = objects.get(url);
    if (body === undefined) return new Response(null, { status: 404 });
    return new Response(body, {
      status: 200,
      headers: { 'content-length': String(Buffer.byteLength(body, 'utf8')) },
    });
  };
  const store = new S3V4ObjectStore({
    endpoint: ENDPOINT,
    bucket: BUCKET,
    region: 'us-east-1',
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET_KEY,
    syncEncryptionKey: SYNC_KEY,
    fetchImpl,
    now: () => NOW,
    createRandomBytes: deterministicBytes,
  });
  // NUL is one valid Note character but is serialized as six JSON bytes.
  // This covers the legitimate worst case where JSON escaping expands each
  // stored character and pushes the encrypted object above a small-object bound.
  const content = '\0'.repeat(NOTE_LIMITS.contentCharacters);
  const objectId = createS3V4ObjectId((size) => Buffer.alloc(size, 11));
  const object = createServiceManagerNoteObjectV4(note({ content }), objectId);

  const written = await store.putNote(object);
  assert.equal(written.status, 'written');
  assert.ok(written.byteLength > 8 * 1024 * 1024, 'escaped encrypted body should exceed the lower bound');
  const loaded = await store.getNote(written.reference);
  assert.equal(loaded.status, 'found');
  assert.equal(loaded.object.note.content.length, NOTE_LIMITS.contentCharacters);
  assert.equal(hashS3V4NoteContent(loaded.object), hashS3V4NoteContent(object));
});

test('S3 v4 manifest contains only Note and tree references and is bound to its head digest', () => {
  const objectId = createS3V4ObjectId((size) => Buffer.alloc(size, 9));
  const noteObject = createServiceManagerNoteObjectV4(note(), objectId);
  const encryptedNote = encryptS3NoteV4(noteObject, SYNC_KEY, deterministicBytes);
  const noteBody = serializeEncryptedS3ObjectV4(encryptedNote);
  const reference = {
    id: noteObject.note.id,
    objectId,
    sha256: hashS3V4Object(noteBody),
    contentHash: hashS3V4NoteContent(noteObject),
    encryptionKeyId: getS3SyncEncryptionKeyId(SYNC_KEY),
  };
  const value = manifest(manifestData([reference], [{ id: 'deleted-note', deletedAt: NOW.toISOString() }]));
  const encrypted = encryptS3ManifestV4(value, SYNC_KEY, deterministicBytes);
  const serialized = serializeEncryptedS3ObjectV4(encrypted);
  const sha256 = hashS3V4Object(serialized);
  const head = createS3SyncHeadV4(value, sha256, getS3SyncEncryptionKeyId(SYNC_KEY));

  assert.deepEqual(decryptS3ManifestV4(encrypted, SYNC_KEY), value);
  assert.equal(value.schemaVersion, 4);
  assert.equal(value.syncVersion, 4);
  assert.equal(value.layoutVersion, 4);
  assert.equal(value.data.notes.tree.objectId, EMPTY_TREE_REFERENCE.objectId);
  assert.equal('root' in value.data.notes.tree, false);
  assert.doesNotMatch(serialized, /Deploy production|highly-sensitive-command|deleted-note/);
  assert.doesNotThrow(() => assertS3SyncHeadMatchesManifestV4(head, value, sha256));
  assert.throws(
    () => assertS3SyncHeadMatchesManifestV4({ ...head, encryptionKeyId: undefined }, value, sha256),
    /Key identity is invalid/,
  );
  assert.throws(
    () => assertS3SyncHeadMatchesManifestV4({ ...head, manifestSha256: '0'.repeat(64) }, value, sha256),
    /does not match the shared head/,
  );
  assert.throws(
    () => parseS3V4ManifestData(manifestData([reference], [{ id: reference.id, deletedAt: NOW.toISOString() }])),
    /active and deleted copy/,
  );
  assert.throws(
    () => parseS3V4ManifestData(manifestData([reference, { ...reference }])),
    /duplicate identities/,
  );
  const { encryptionKeyId: _referenceKeyId, ...referenceWithoutKeyIdentity } = reference;
  assert.throws(
    () => parseS3V4ManifestData(manifestData([referenceWithoutKeyIdentity])),
    /Key identity is invalid/,
  );
  const withoutTree = manifestData();
  delete withoutTree.notes.tree;
  assert.throws(() => parseS3V4ManifestData(withoutTree), /tree reference is invalid/);
  assert.throws(
    () => createServiceManagerSyncManifestV4({ ...manifestData(), schemaVersion: 3 }, {
      appVersion: '0.3.19',
      revision: 'invalid-wire',
      clientId: 'invalid-client',
      createdAt: NOW.toISOString(),
    }),
    /manifest data is invalid/,
  );
});

test('S3 v4 SigV4 signs only v4 object paths and conditional writes', () => {
  const signed = signS3V4Request({
    method: 'PUT',
    objectUrl: buildS3V4HeadObjectUrl(ENDPOINT, BUCKET),
    region: 'us-east-1',
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET_KEY,
    syncEncryptionKey: SYNC_KEY,
    payload: '{"revision":"manifest-revision-2"}',
    ifMatch: '"head-etag"',
    now: NOW,
  });
  assert.match(signed.canonicalRequest, /\/service-manager\/service-manager\/v4\/head\.json/);
  assert.doesNotMatch(signed.canonicalRequest, /\/v[1-3]\//);
  assert.equal(signed.headers['if-match'], '"head-etag"');
  assert.match(signed.headers.authorization, /if-match/);
});

test('S3 v4 object store writes immutable Notes, tree, and manifests then CAS-publishes the head', async () => {
  const calls = [];
  const objects = new Map();
  let headEtag;
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (options.method === 'GET') {
      const body = objects.get(url);
      if (body === undefined) return new Response('', { status: 404 });
      return new Response(body, {
        status: 200,
        headers: { etag: url.endsWith('/head.json') ? headEtag : '"immutable-etag"' },
      });
    }
    if (url.endsWith('/head.json')) {
      if (headEtag === undefined) {
        if (options.headers['if-none-match'] !== '*') return new Response('', { status: 412 });
      } else if (options.headers['if-match'] !== headEtag) {
        return new Response('', { status: 412 });
      }
      objects.set(url, options.body);
      headEtag = headEtag === undefined ? '"head-1"' : '"head-2"';
      return new Response('', { status: 200, headers: { etag: headEtag } });
    }
    if (objects.has(url) || options.headers['if-none-match'] !== '*') {
      return new Response('', { status: 412 });
    }
    objects.set(url, options.body);
    return new Response('', { status: 200, headers: { etag: '"immutable-etag"' } });
  };
  const store = new S3V4ObjectStore({
    endpoint: ENDPOINT,
    bucket: BUCKET,
    region: 'us-east-1',
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET_KEY,
    syncEncryptionKey: SYNC_KEY,
    fetchImpl,
    now: () => NOW,
    createRandomBytes: deterministicBytes,
  });

  assert.deepEqual(await store.getHead(), { status: 'missing' });
  const objectId = createS3V4ObjectId((size) => Buffer.alloc(size, 10));
  const noteObject = createServiceManagerNoteObjectV4(note(), objectId);
  const noteWrite = await store.putNote(noteObject);
  assert.equal(noteWrite.status, 'written');
  assert.equal(
    calls.at(-1).options.body,
    serializeEncryptedS3ObjectV4(encryptS3NoteV4(noteObject, SYNC_KEY, deterministicBytes)),
    'the optimized owned PUT path must preserve the exact Note wire envelope',
  );
  assert.deepEqual(
    Object.keys(noteWrite.reference),
    ['id', 'objectId', 'sha256', 'contentHash', 'encryptionKeyId'],
  );
  assert.equal(calls.at(-1).options.headers['if-none-match'], '*');
  assert.equal((await store.putNote(noteObject)).status, 'conflict');

  const treeObject = createServiceManagerNotesTreeObjectV4(
    treePayload([noteObject.note.id]),
    createS3V4ObjectId((size) => Buffer.alloc(size, 12)),
  );
  const treeWrite = await store.putNotesTree(treeObject);
  assert.equal(treeWrite.status, 'written');
  assert.equal(
    calls.at(-1).options.body,
    serializeEncryptedS3ObjectV4(encryptS3NotesTreeV4(treeObject, SYNC_KEY, deterministicBytes)),
    'the optimized owned PUT path must preserve the exact tree wire envelope',
  );
  assert.deepEqual(
    Object.keys(treeWrite.reference),
    ['objectId', 'sha256', 'contentHash', 'encryptionKeyId'],
  );
  assert.equal(calls.at(-1).options.headers['if-none-match'], '*');
  assert.equal((await store.putNotesTree(treeObject)).status, 'conflict');

  const manifestValue = manifest(manifestData([noteWrite.reference], [], treeWrite.reference));
  const manifestWrite = await store.putManifest(manifestValue);
  assert.equal(manifestWrite.status, 'written');
  assert.equal(
    calls.at(-1).options.body,
    serializeEncryptedS3ObjectV4(encryptS3ManifestV4(manifestValue, SYNC_KEY, deterministicBytes)),
    'the optimized owned PUT path must preserve the exact manifest wire envelope',
  );
  assert.equal(calls.at(-1).options.headers['if-none-match'], '*');
  assert.equal((await store.putManifest(manifestValue)).status, 'conflict');

  const head = createS3SyncHeadV4(
    manifestValue,
    manifestWrite.manifestSha256,
    getS3SyncEncryptionKeyId(SYNC_KEY),
  );
  assert.deepEqual(await store.putHead(head), { status: 'written', etag: '"head-1"' });
  assert.deepEqual(await store.putHead(head, '"stale"'), { status: 'conflict' });
  assert.deepEqual(await store.putHead(head, '"head-1"'), { status: 'written', etag: '"head-2"' });

  const remoteHead = await store.getHead();
  assert.equal(remoteHead.status, 'found');
  assert.deepEqual(remoteHead.head, head);
  const remoteManifest = await store.getManifest(head.revision, head.manifestSha256);
  assert.equal(remoteManifest.status, 'found');
  assert.deepEqual(remoteManifest.manifest, manifestValue);
  const remoteNote = await store.getNote(noteWrite.reference);
  assert.equal(remoteNote.status, 'found');
  assert.deepEqual(remoteNote.object, noteObject);
  const remoteTree = await store.getNotesTree(treeWrite.reference);
  assert.equal(remoteTree.status, 'found');
  assert.deepEqual(remoteTree.object, treeObject);

  await assert.rejects(
    store.getNote({ ...noteWrite.reference, sha256: '0'.repeat(64) }),
    /digest does not match its manifest reference/,
  );
  await assert.rejects(
    store.getNote({ ...noteWrite.reference, contentHash: '0'.repeat(64) }),
    /does not match its manifest reference/,
  );
  await assert.rejects(
    store.getNotesTree({ ...treeWrite.reference, sha256: '0'.repeat(64) }),
    /digest does not match its manifest reference/,
  );
  await assert.rejects(
    store.getNotesTree({ ...treeWrite.reference, contentHash: '0'.repeat(64) }),
    /does not match its manifest reference/,
  );
  assert.equal(calls.every(({ url }) => url.includes('/service-manager/v4/')), true);
  assert.equal(calls.some(({ url }) => /\/service-manager\/v[1-3]\//.test(url)), false);
});

test('S3 v4 object store validates manifest digests and bounds response bodies', async () => {
  const value = manifest(manifestData());
  const body = serializeEncryptedS3ObjectV4(encryptS3ManifestV4(value, SYNC_KEY, deterministicBytes));
  const digestStore = new S3V4ObjectStore({
    endpoint: ENDPOINT,
    bucket: BUCKET,
    region: 'us-east-1',
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET_KEY,
    syncEncryptionKey: SYNC_KEY,
    fetchImpl: async () => new Response(body, { status: 200 }),
  });
  await assert.rejects(
    digestStore.getManifest(value.revision, '0'.repeat(64)),
    /digest does not match the shared head/,
  );

  const boundedStore = new S3V4ObjectStore({
    endpoint: ENDPOINT,
    bucket: BUCKET,
    region: 'us-east-1',
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET_KEY,
    syncEncryptionKey: SYNC_KEY,
    fetchImpl: async () => new Response('{}', {
      status: 200,
      headers: { 'content-length': String(73 * 1024 * 1024) },
    }),
  });
  await assert.rejects(boundedStore.getManifest(value.revision), /response is too large/);
});

test('S3 v4 object store cancels owned requests and enforces its timeout', async () => {
  let requestStarted;
  const started = new Promise((resolve) => { requestStarted = resolve; });
  const owner = new AbortController();
  const store = new S3V4ObjectStore({
    endpoint: ENDPOINT,
    bucket: BUCKET,
    region: 'us-east-1',
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET_KEY,
    syncEncryptionKey: SYNC_KEY,
    signal: owner.signal,
    fetchImpl: async (_url, options) => {
      requestStarted();
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('credential-bearing request')), { once: true });
      });
    },
  });
  const pending = store.getHead();
  await started;
  owner.abort();
  await assert.rejects(pending, /^Error: S3 sync was cancelled\.$/);

  const timed = new S3V4ObjectStore({
    endpoint: ENDPOINT,
    bucket: BUCKET,
    region: 'us-east-1',
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET_KEY,
    syncEncryptionKey: SYNC_KEY,
    timeoutMs: 10,
    fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('timed out')), { once: true });
    }),
  });
  await assert.rejects(timed.getHead(), /^Error: S3 sync timed out\.$/);
});
