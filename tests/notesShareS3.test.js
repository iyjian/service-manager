const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const test = require('node:test');

const { NotesShareS3Store } = require('../dist/main/notes/notesShareS3');

const ENDPOINT = 'https://s3.example.com';
const BUCKET = 'notes-bucket';
const ACCESS_KEY = 'test-access-key';
const SECRET_KEY = 'test-secret-key';

function deterministicRandom() {
  let counter = 0;
  return (size) => {
    counter += 1;
    return Buffer.alloc(size, 0x10 + counter);
  };
}

function imageReference(overrides = {}) {
  return {
    objectId: Buffer.alloc(24, 0x01).toString('base64url'),
    assetKey: Buffer.alloc(32, 0x02).toString('base64url'),
    ciphertextSha256: 'a'.repeat(64),
    contentSha256: 'b'.repeat(64),
    mimeType: 'image/png',
    byteLength: 4,
    width: 10,
    height: 10,
    alt: 'Diagram',
    ...overrides,
  };
}

function attachmentReference(overrides = {}) {
  return {
    objectId: Buffer.alloc(24, 0x03).toString('base64url'),
    assetKey: Buffer.alloc(32, 0x04).toString('base64url'),
    ciphertextSha256: 'c'.repeat(64),
    contentSha256: 'd'.repeat(64),
    fileName: 'report.pdf',
    mimeType: 'application/pdf',
    byteLength: 7,
    ...overrides,
  };
}

function richTextNote(id = 'note-1') {
  return {
    id,
    name: 'Release Notes',
    language: 'richtext',
    content: JSON.stringify({
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Release Notes' }] },
        { type: 's3Image', attrs: imageReference() },
        { type: 's3Attachment', attrs: attachmentReference() },
      ],
    }),
    tags: [],
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
  };
}

function noteShareRoot(noteId, shareId) {
  return `service-manager/v4/shares/${createHash('sha256').update(noteId).digest('hex')}/${shareId}`;
}

function xmlEscape(value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function bodyBuffer(body) {
  if (body === undefined || body === null) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (body instanceof Uint8Array) return Buffer.from(body);
  throw new Error('unexpected request body');
}

function createMockS3(options = {}) {
  const objects = new Map();
  const calls = [];
  const keyFromUrl = (rawUrl) => {
    const url = new URL(rawUrl);
    const pathPrefix = `/${BUCKET}/`;
    assert.ok(url.pathname === `/${BUCKET}` || url.pathname.startsWith(pathPrefix), url.pathname);
    return decodeURIComponent(url.pathname.slice(pathPrefix.length));
  };
  const listXml = (prefix, delimiter, continuationToken, maxKeys) => {
    const keys = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort();
    const start = continuationToken ? Number(continuationToken) : 0;
    assert.ok(Number.isInteger(start) && start >= 0, `invalid continuation token: ${continuationToken}`);
    if (delimiter === '/') {
      const prefixes = new Set();
      for (const key of keys) {
        const rest = key.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash >= 0) prefixes.add(`${prefix}${rest.slice(0, slash + 1)}`);
      }
      const items = [...prefixes];
      const page = items.slice(start, start + maxKeys);
      const next = start + page.length < items.length ? String(start + page.length) : undefined;
      return `<ListBucketResult><IsTruncated>${next ? 'true' : 'false'}</IsTruncated>${page.map((item) => `<CommonPrefixes><Prefix>${xmlEscape(item)}</Prefix></CommonPrefixes>`).join('')}${next ? `<NextContinuationToken>${xmlEscape(next)}</NextContinuationToken>` : ''}</ListBucketResult>`;
    }
    const page = keys.slice(start, start + maxKeys);
    const next = start + page.length < keys.length ? String(start + page.length) : undefined;
    return `<ListBucketResult><IsTruncated>${next ? 'true' : 'false'}</IsTruncated>${page.map((key) => `<Contents><Key>${xmlEscape(key)}</Key></Contents>`).join('')}${next ? `<NextContinuationToken>${xmlEscape(next)}</NextContinuationToken>` : ''}</ListBucketResult>`;
  };
  const fetchImpl = async (rawUrl, init = {}) => {
    const method = init.method ?? 'GET';
    const url = new URL(rawUrl);
    calls.push({ url: rawUrl, init });
    if (method === 'GET' && url.searchParams.get('list-type') === '2') {
      return new Response(listXml(
        url.searchParams.get('prefix') ?? '',
        url.searchParams.get('delimiter'),
        url.searchParams.get('continuation-token'),
        Number(url.searchParams.get('max-keys') ?? '1000'),
      ), {
        status: 200,
        headers: { 'content-type': 'application/xml' },
      });
    }
    const key = keyFromUrl(rawUrl);
    if (method === 'PUT') {
      if (options.failManifestPut && key.endsWith('/manifest.json')) {
        return new Response('<Error><Code>AccessDenied</Code></Error>', { status: 500 });
      }
      objects.set(key, bodyBuffer(init.body));
      return new Response('', { status: 200, headers: { etag: '"stored"' } });
    }
    if (method === 'GET') {
      const body = objects.get(key);
      return body === undefined
        ? new Response('', { status: 404 })
        : new Response(body, { status: 200 });
    }
    if (method === 'DELETE') {
      objects.delete(key);
      return new Response(null, { status: 204 });
    }
    return new Response('', { status: 405 });
  };
  return { objects, calls, fetchImpl };
}

function storeOptions(mock, nowRef) {
  return {
    endpoint: ENDPOINT,
    bucket: BUCKET,
    region: 'us-east-1',
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET_KEY,
    fetchImpl: mock.fetchImpl,
    now: () => nowRef.value,
    createRandomBytes: deterministicRandom(),
  };
}

test('Notes share S3 store creates static snapshots, signs media, lists history, re-signs, and deletes', async () => {
  const mock = createMockS3();
  const nowRef = { value: new Date('2026-07-20T00:00:00.000Z') };
  const store = new NotesShareS3Store(storeOptions(mock, nowRef));
  const note = richTextNote();

  const created = await store.create(note, 24, {
    loadImage: async () => Buffer.from('imag'),
    loadAttachment: async () => Buffer.from('pdfdata'),
  });
  assert.equal(created.status, 'active');
  assert.match(created.url, /X-Amz-Expires=86400/);
  assert.doesNotMatch(created.url, new RegExp(SECRET_KEY));

  const root = noteShareRoot(note.id, created.shareId);
  const manifestKey = `${root}/manifest.json`;
  const manifest = JSON.parse(mock.objects.get(manifestKey).toString('utf8'));
  assert.equal(manifest.snapshot.name, 'Release Notes');
  assert.match(manifest.indexKey, new RegExp(`^${root}/versions/[A-Za-z0-9_-]+/index\\.html$`));
  assert.deepEqual(
    [manifest.images[0].key, manifest.attachments[0].key],
    [`${root}/assets/images/001.png`, `${root}/assets/attachments/001`],
  );

  const page = mock.objects.get(manifest.indexKey).toString('utf8');
  assert.match(page, /<!doctype html>/);
  assert.match(page, /<img src="https:\/\/s3\.example\.com\/notes-bucket\/service-manager\/v4\/shares\/[^"]+\?X-Amz-Algorithm=AWS4-HMAC-SHA256[^"]*X-Amz-Expires=86400/);
  assert.match(page, /<a class="attachment" href="https:\/\/s3\.example\.com\/notes-bucket\/service-manager\/v4\/shares\/[^"]+\?X-Amz-Algorithm=AWS4-HMAC-SHA256[^"]*X-Amz-Expires=86400[^"]*" download>/);
  assert.doesNotMatch(page, new RegExp(imageReference().objectId));
  assert.doesNotMatch(page, new RegExp(imageReference().assetKey));
  assert.doesNotMatch(page, new RegExp(attachmentReference().objectId));
  assert.doesNotMatch(page, new RegExp(attachmentReference().assetKey));

  const history = await store.list(note.id);
  assert.equal(history.length, 1);
  assert.equal(history[0].shareId, created.shareId);
  assert.match(history[0].url, /X-Amz-Expires=86400/);

  nowRef.value = new Date('2026-07-20T01:00:00.000Z');
  const resigned = await store.resign(note.id, created.shareId, 72);
  assert.equal(resigned.shareId, created.shareId);
  assert.match(resigned.url, /X-Amz-Expires=259200/);
  const nextManifest = JSON.parse(mock.objects.get(manifestKey).toString('utf8'));
  assert.notEqual(nextManifest.indexKey, manifest.indexKey);
  assert.equal(nextManifest.expiresAt, '2026-07-23T01:00:00.000Z');

  await store.delete(note.id, created.shareId);
  assert.equal([...mock.objects.keys()].some((key) => key.startsWith(`${root}/`)), false);
});

test('Notes share creation removes copied assets when publishing fails', async () => {
  const mock = createMockS3({ failManifestPut: true });
  const nowRef = { value: new Date('2026-07-20T00:00:00.000Z') };
  const store = new NotesShareS3Store(storeOptions(mock, nowRef));
  const note = richTextNote('note-cleanup');

  await assert.rejects(
    store.create(note, 24, {
      loadImage: async () => Buffer.from('imag'),
      loadAttachment: async () => Buffer.from('pdfdata'),
    }),
    /Unable to store the Note share/,
  );
  assert.equal([...mock.objects.keys()].some((key) => key.includes('/shares/')), false);
  assert.ok(mock.calls.some((call) => call.init.method === 'DELETE'));
});

test('Notes share S3 store writes highlighted code into the single static HTML page', async () => {
  const mock = createMockS3();
  const nowRef = { value: new Date('2026-07-20T00:00:00.000Z') };
  const store = new NotesShareS3Store(storeOptions(mock, nowRef));
  const note = {
    id: 'note-code-share',
    name: 'Code Share',
    language: 'typescript',
    content: 'const answer: number = 42;\nconsole.log(answer);',
    tags: [],
    createdAt: '2026-07-20T00:00:00.000Z',
    updatedAt: '2026-07-20T00:00:00.000Z',
  };

  const created = await store.create(note, 24, {
    loadImage: async () => { throw new Error('unexpected image load'); },
    loadAttachment: async () => { throw new Error('unexpected attachment load'); },
  });

  const root = noteShareRoot(note.id, created.shareId);
  const manifest = JSON.parse(mock.objects.get(`${root}/manifest.json`).toString('utf8'));
  const page = mock.objects.get(manifest.indexKey).toString('utf8');
  assert.match(page, /<style>[\s\S]*\.hljs-keyword/);
  assert.match(page, /<pre><code class="hljs language-typescript">/);
  assert.match(page, /hljs-keyword/);
  assert.match(page, /hljs-built_in/);
  assert.doesNotMatch(page, /<link\b|rel="stylesheet"|<script\b/);
});

test('Notes share deletion paginates share-prefix object listing', async () => {
  const mock = createMockS3();
  const nowRef = { value: new Date('2026-07-20T00:00:00.000Z') };
  const store = new NotesShareS3Store(storeOptions(mock, nowRef));
  const noteId = 'note-paged-delete';
  const shareId = 'share_paged_0001';
  const root = noteShareRoot(noteId, shareId);
  for (let index = 0; index < 1005; index += 1) {
    mock.objects.set(`${root}/assets/item-${String(index).padStart(4, '0')}`, Buffer.from('x'));
  }

  await store.delete(noteId, shareId);

  assert.equal([...mock.objects.keys()].some((key) => key.startsWith(`${root}/`)), false);
  const listCalls = mock.calls.filter((call) => call.init.method === 'GET' && new URL(call.url).searchParams.get('list-type') === '2');
  assert.equal(listCalls.length, 2);
  assert.equal(new URL(listCalls[1].url).searchParams.get('continuation-token'), '1000');
});

test('Notes share deletion refuses overlarge prefixes before deleting any object', async () => {
  const mock = createMockS3();
  const nowRef = { value: new Date('2026-07-20T00:00:00.000Z') };
  const store = new NotesShareS3Store(storeOptions(mock, nowRef));
  const noteId = 'note-overlarge-delete';
  const shareId = 'share_over_00001';
  const root = noteShareRoot(noteId, shareId);
  for (let index = 0; index < 2001; index += 1) {
    mock.objects.set(`${root}/assets/item-${String(index).padStart(4, '0')}`, Buffer.from('x'));
  }

  await assert.rejects(
    store.delete(noteId, shareId),
    /too many objects/,
  );

  assert.equal([...mock.objects.keys()].filter((key) => key.startsWith(`${root}/`)).length, 2001);
  assert.equal(mock.calls.some((call) => call.init.method === 'DELETE'), false);
});
