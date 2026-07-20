const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const test = require('node:test');

const {
  TRILIUM_IMPORTER_VERSION,
  TRILIUM_IMPORT_MAX_RESPONSE_BYTES,
  mergeTriliumImport,
  normalizeTriliumEndpoint,
  normalizeTriliumToken,
  prepareTriliumImport,
  resolveTriliumImportImages,
  scanTriliumHtmlImages,
  triliumImageTargetFingerprint,
  triliumLocalNoteId,
  triliumSourceId,
  triliumSourceVersion,
  triliumStoredSourceVersion,
  triliumVersionTag,
} = require('../dist/main/triliumImport');

const ENDPOINT = 'https://notes.example.test/base';
const TOKEN = 'test_ETAPI+/token=';
const CREATED = '2026-07-01T01:02:03.000Z';
const MODIFIED = '2026-07-02T01:02:03.000Z';

function legacyV1SourceVersion(value) {
  return createHash('sha256').update(JSON.stringify([
    'trilium-etapi-v1',
    value.title,
    value.type,
    value.mime,
    value.blobId,
    value.utcDateModified,
  ]), 'utf8').digest('base64url');
}

function remoteNote(noteId, childBranchIds = [], overrides = {}) {
  return {
    noteId,
    title: noteId,
    type: 'text',
    mime: 'text/html',
    isProtected: false,
    blobId: `blob-${noteId}`,
    childBranchIds,
    utcDateCreated: CREATED,
    utcDateModified: MODIFIED,
    ...overrides,
  };
}

function remoteBranch(branchId, noteId, parentNoteId, notePosition) {
  return {
    branchId,
    noteId,
    parentNoteId,
    prefix: '',
    notePosition,
    isExpanded: true,
    utcDateModified: MODIFIED,
  };
}

function remoteAttachment(attachmentId, overrides = {}) {
  return {
    attachmentId,
    ownerId: 'noteA',
    role: 'image',
    mime: 'image/png',
    title: `${attachmentId}.png`,
    position: 0,
    blobId: `blob-${attachmentId}`,
    utcDateModified: MODIFIED,
    contentLength: 68,
    ...overrides,
  };
}

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

const JPEG_1X1 = Buffer.from([
  0xff, 0xd8,
  0xff, 0xc0, 0x00, 0x0b, 0x08,
  0x00, 0x01,
  0x00, 0x01,
  0x01, 0x01, 0x11, 0x00,
  0xff, 0xd9,
]);

function uploadedReference(bytes = PNG_1X1, overrides = {}) {
  return {
    objectId: Buffer.alloc(24, 1).toString('base64url'),
    assetKey: Buffer.alloc(32, 2).toString('base64url'),
    ciphertextSha256: '1'.repeat(64),
    contentSha256: createHash('sha256').update(bytes).digest('hex'),
    mimeType: 'image/png',
    byteLength: bytes.byteLength,
    width: 1,
    height: 1,
    ...overrides,
  };
}

function jsonResponse(value, init = {}) {
  return new Response(JSON.stringify(value), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

function hierarchyRoutes() {
  const routes = new Map();
  routes.set('/base/etapi/notes/root', jsonResponse(remoteNote('root', ['braA', 'braB', 'brsy'])));
  routes.set('/base/etapi/branches/braA', jsonResponse(remoteBranch('braA', 'noteA', 'root', 10)));
  routes.set('/base/etapi/branches/braB', jsonResponse(remoteBranch('braB', 'noteB', 'root', 20)));
  routes.set('/base/etapi/branches/brsy', jsonResponse(remoteBranch('brsy', '_sys', 'root', 30)));
  routes.set('/base/etapi/notes/noteA', jsonResponse(remoteNote('noteA', ['brAC'], { title: 'Alpha' })));
  routes.set('/base/etapi/notes/noteB', jsonResponse(remoteNote('noteB', ['brBC'], {
    title: 'Script',
    type: 'code',
    mime: 'application/javascript',
  })));
  routes.set('/base/etapi/branches/brAC', jsonResponse(remoteBranch('brAC', 'noteC', 'noteA', 5)));
  routes.set('/base/etapi/branches/brBC', jsonResponse(remoteBranch('brBC', 'noteC', 'noteB', 8)));
  routes.set('/base/etapi/notes/noteC', jsonResponse(remoteNote('noteC', [], {
    title: 'Picture',
    type: 'image',
    mime: 'image/png',
  })));
  routes.set('/base/etapi/notes/noteA/content', new Response('<p>Alpha</p>'));
  routes.set('/base/etapi/notes/noteB/content', new Response('console.log("hello")'));
  return routes;
}

function fakeFetch(routes, observations = {}) {
  return async (input, init = {}) => {
    const url = new URL(String(input));
    observations.requests = (observations.requests ?? 0) + 1;
    observations.paths = [...(observations.paths ?? []), url.pathname];
    const headers = new Headers(init.headers);
    assert.equal(headers.get('authorization'), `Bearer ${TOKEN}`);
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'manual');
    if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const response = routes.get(url.pathname);
    if (!response) throw new Error(`Unexpected request: ${url.pathname}`);
    return response.clone();
  };
}

test('Trilium endpoint, token, deterministic IDs, and source tags are canonical and bounded', () => {
  assert.equal(normalizeTriliumEndpoint(' HTTPS://Notes.Example.Test:443/base/etapi/ '), ENDPOINT);
  assert.equal(normalizeTriliumEndpoint('https://notes.example.test/base///'), ENDPOINT);
  assert.equal(normalizeTriliumToken(TOKEN), TOKEN);
  assert.throws(() => normalizeTriliumEndpoint('file:///tmp/notes'), /endpoint is invalid/);
  assert.throws(() => normalizeTriliumEndpoint('https://user:secret@notes.example.test'), /endpoint is invalid/);
  assert.throws(() => normalizeTriliumEndpoint('https://notes.example.test?token=secret'), /endpoint is invalid/);
  assert.throws(() => normalizeTriliumToken(` ${TOKEN}`), /token is invalid/);
  assert.throws(() => normalizeTriliumToken('line\nbreak'), /token is invalid/);

  const localId = triliumLocalNoteId(`${ENDPOINT}/etapi`, 'noteA');
  assert.equal(localId, triliumLocalNoteId(ENDPOINT, 'noteA'));
  assert.match(localId, /^trilium:[A-Za-z0-9_-]{22}:noteA$/);
  assert.equal(triliumSourceId(`${ENDPOINT}/etapi`), triliumSourceId(ENDPOINT));
  const version = triliumSourceVersion({
    title: 'Alpha', type: 'text', mime: 'text/html', blobId: 'blob-noteA', utcDateModified: MODIFIED,
  });
  const tag = triliumVersionTag(version);
  assert.equal(triliumStoredSourceVersion(['personal', tag]), version);
  assert.equal(triliumStoredSourceVersion(['trilium:v:short']), undefined);
});

test('Trilium traversal is deterministic BFS, skips system roots, and deduplicates clone placement', async () => {
  const observations = {};
  const progress = [];
  const plan = await prepareTriliumImport({
    endpoint: `${ENDPOINT}/etapi`,
    token: TOKEN,
    fetchImpl: fakeFetch(hierarchyRoutes(), observations),
    onProgress: (value) => progress.push(value),
  });

  assert.equal(plan.endpoint, ENDPOINT);
  assert.deepEqual(plan.notes.map((note) => note.remoteNoteId), ['noteA', 'noteB', 'noteC']);
  assert.deepEqual(plan.notes.map((note) => note.depth), [0, 0, 1]);
  assert.equal(plan.notes[2].parentLocalNoteId, plan.notes[0].localNoteId);
  assert.equal(plan.clones, 1);
  assert.equal(plan.skippedSystemTrees, 1);
  assert.equal(plan.placeholders, 0);
  assert.equal(plan.truncated, false);
  assert.equal(plan.notes[0].content.kind, 'html');
  assert.deepEqual(plan.notes[1].content, {
    kind: 'ready', language: 'javascript', content: 'console.log("hello")',
  });
  assert.equal(plan.notes[2].content.kind, 'image');
  assert.deepEqual(plan.imageTargets.map((target) => target.sourceKey), ['note:noteC']);
  assert.equal(observations.paths.includes('/base/etapi/notes/_sys'), false);
  assert.equal(progress.at(-1).processed, 3);
});

test('an explicit maxNotes returns a connected BFS sample without treating the remaining tree as an error', async () => {
  const plan = await prepareTriliumImport({
    endpoint: ENDPOINT,
    token: TOKEN,
    maxNotes: 2,
    fetchImpl: fakeFetch(hierarchyRoutes()),
  });
  assert.deepEqual(plan.notes.map((note) => note.remoteNoteId), ['noteA', 'noteB']);
  assert.ok(plan.notes.every((note) => note.parentLocalNoteId === null));
  assert.equal(plan.truncated, true);
  await assert.rejects(
    prepareTriliumImport({ endpoint: ENDPOINT, token: TOKEN, maxNotes: 0, fetchImpl: fakeFetch(new Map()) }),
    /sample must contain/,
  );
});

test('known source versions still rescan HTML image metadata but avoid fetching unchanged non-HTML content', async () => {
  const initial = await prepareTriliumImport({
    endpoint: ENDPOINT,
    token: TOKEN,
    fetchImpl: fakeFetch(hierarchyRoutes()),
  });
  const knownSourceVersions = Object.fromEntries(initial.notes.map((note, index) => [
    note.localNoteId,
    index === 0 ? triliumVersionTag(note.sourceVersion) : note.sourceVersion,
  ]));
  const observations = {};
  const repeated = await prepareTriliumImport({
    endpoint: ENDPOINT,
    token: TOKEN,
    knownSourceVersions,
    fetchImpl: fakeFetch(hierarchyRoutes(), observations),
  });

  assert.ok(repeated.notes.every((note) => note.content.kind === 'unchanged-source'));
  assert.deepEqual(observations.paths.filter((pathname) => pathname.endsWith('/content')), [
    '/base/etapi/notes/noteA/content',
  ]);
  assert.deepEqual(repeated.imageTargets, []);
  assert.equal(repeated.placeholders, 0);
});

test('the v3 importer invalidates v1 source versions so existing Notes are fetched and remapped', async () => {
  assert.equal(TRILIUM_IMPORTER_VERSION, 'trilium-etapi-v3');
  const localNoteId = triliumLocalNoteId(ENDPOINT, 'noteA');
  const legacyVersion = legacyV1SourceVersion({
    title: 'Alpha',
    type: 'text',
    mime: 'text/html',
    blobId: 'blob-noteA',
    utcDateModified: MODIFIED,
  });
  const observations = {};
  const plan = await prepareTriliumImport({
    endpoint: ENDPOINT,
    token: TOKEN,
    knownSourceVersions: { [localNoteId]: legacyVersion },
    fetchImpl: fakeFetch(hierarchyRoutes(), observations),
  });

  const alpha = plan.notes.find((note) => note.localNoteId === localNoteId);
  assert.equal(alpha.content.kind, 'html');
  assert.notEqual(alpha.sourceVersion, legacyVersion);
  assert.ok(observations.paths.includes('/base/etapi/notes/noteA/content'));
});

test('Trilium Text Notes always use HTML conversion while supported Code Notes retain source content', async () => {
  const cases = [
    ['nt01', 'text', 'text/markdown', 'html', 'richtext'],
    ['nt02', 'text', 'text/plain', 'html', 'richtext'],
    ['nt03', 'code', 'text/markdown', 'ready', 'markdown'],
    ['nt04', 'code', 'text/x-markdown', 'ready', 'markdown'],
    ['nt05', 'code', 'text/x-gfm', 'ready', 'markdown'],
    ['nt06', 'code', 'application/x-sh', 'ready', 'bash'],
    ['nt07', 'code', 'application/typescript', 'ready', 'typescript'],
    ['nt08', 'code', 'application/javascript', 'ready', 'javascript'],
    ['nt09', 'code', 'text/x-sql', 'ready', 'sql'],
    ['nt10', 'code', 'application/json', 'ready', 'json'],
    ['nt11', 'code', 'application/yaml', 'ready', 'yaml'],
    ['nt12', 'code', 'text/x-python', 'ready', 'text'],
    ['nt13', 'mermaid', 'text/vnd.mermaid', 'ready', 'markdown'],
    ['nt14', 'code', 'application/markdown', 'ready', 'text'],
  ];
  const branchIds = cases.map((_, index) => `b${String(index).padStart(3, '0')}`);
  const routes = new Map([
    ['/base/etapi/notes/root', jsonResponse(remoteNote('root', branchIds))],
  ]);
  for (let index = 0; index < cases.length; index += 1) {
    const [noteId, type, mime] = cases[index];
    routes.set(`/base/etapi/branches/${branchIds[index]}`, jsonResponse(
      remoteBranch(branchIds[index], noteId, 'root', index),
    ));
    routes.set(`/base/etapi/notes/${noteId}`, jsonResponse(remoteNote(noteId, [], { type, mime })));
    routes.set(`/base/etapi/notes/${noteId}/content`, new Response(
      type === 'text'
        ? `<p>content-${noteId}</p>`
        : type === 'mermaid'
          ? 'graph TD\nA[```]'
          : `content-${noteId}`,
    ));
  }

  const plan = await prepareTriliumImport({ endpoint: ENDPOINT, token: TOKEN, fetchImpl: fakeFetch(routes) });
  assert.deepEqual(
    plan.notes.map((note) => [note.content.kind, note.content.language]),
    cases.map((entry) => entry.slice(3)),
  );
  assert.deepEqual(plan.notes.slice(0, 2).map((note) => note.content.html), [
    '<p>content-nt01</p>',
    '<p>content-nt02</p>',
  ]);
  assert.equal(
    plan.notes.find((note) => note.localNoteId === triliumLocalNoteId(ENDPOINT, 'nt13')).content.content,
    '````mermaid\ngraph TD\nA[```]\n````',
  );
  assert.equal(plan.placeholders, 0);
});

test('structured, rendered, file, and unknown Trilium Note types become Markdown placeholders', async () => {
  const cases = [
    ['nt02', 'file', 'application/pdf'],
    ['nt03', 'search', 'application/json'],
    ['nt04', 'relationMap', 'application/json'],
    ['nt05', 'book', 'text/html'],
    ['nt06', 'render', 'text/html'],
    ['nt07', 'webView', 'text/plain'],
    ['nt08', 'doc', 'text/html'],
    ['nt09', 'canvas', 'application/json'],
    ['nt10', 'noteMap', 'application/json'],
    ['nt11', 'mindMap', 'application/json'],
    ['nt12', 'spreadsheet', 'application/json'],
    ['nt13', 'futureType', 'application/json'],
  ];
  const branchIds = cases.map((_, index) => `u${String(index).padStart(3, '0')}`);
  const routes = new Map([
    ['/base/etapi/notes/root', jsonResponse(remoteNote('root', branchIds))],
  ]);
  for (let index = 0; index < cases.length; index += 1) {
    const [noteId, type, mime] = cases[index];
    routes.set(`/base/etapi/branches/${branchIds[index]}`, jsonResponse(
      remoteBranch(branchIds[index], noteId, 'root', index),
    ));
    routes.set(`/base/etapi/notes/${noteId}`, jsonResponse(remoteNote(noteId, [], { type, mime })));
  }
  const observations = {};
  const plan = await prepareTriliumImport({
    endpoint: ENDPOINT,
    token: TOKEN,
    fetchImpl: fakeFetch(routes, observations),
  });

  assert.equal(plan.placeholders, cases.length);
  assert.ok(plan.notes.every((note) => (
    note.content.kind === 'placeholder'
    && note.content.language === 'markdown'
    && note.content.reason === 'unsupported'
  )));
  assert.equal(observations.paths.some((pathname) => pathname.endsWith('/content')), false);
});

test('protected and oversized contents become bounded placeholders', async () => {
  const routes = new Map();
  routes.set('/base/etapi/notes/root', jsonResponse(remoteNote('root', ['bpr1', 'bov1'])));
  routes.set('/base/etapi/branches/bpr1', jsonResponse(remoteBranch('bpr1', 'npro', 'root', 1)));
  routes.set('/base/etapi/branches/bov1', jsonResponse(remoteBranch('bov1', 'nover', 'root', 2)));
  routes.set('/base/etapi/notes/npro', jsonResponse(remoteNote('npro', [], { isProtected: true })));
  routes.set('/base/etapi/notes/nover', jsonResponse(remoteNote('nover')));
  routes.set('/base/etapi/notes/nover/content', new Response('too large', {
    headers: { 'content-length': String(TRILIUM_IMPORT_MAX_RESPONSE_BYTES + 1) },
  }));
  const observations = {};
  const plan = await prepareTriliumImport({
    endpoint: ENDPOINT,
    token: TOKEN,
    fetchImpl: fakeFetch(routes, observations),
  });
  assert.deepEqual(plan.notes.map((note) => note.content.reason), ['protected', 'oversized']);
  assert.equal(observations.paths.includes('/base/etapi/notes/npro/content'), false);
});

test('redirects, oversized metadata, malformed responses, and cancellation fail safely', async () => {
  await assert.rejects(
    prepareTriliumImport({
      endpoint: ENDPOINT,
      token: TOKEN,
      fetchImpl: fakeFetch(new Map([['/base/etapi/notes/root', new Response(null, {
        status: 302, headers: { location: 'https://other.example.test' },
      })]])),
    }),
    /redirected/,
  );
  await assert.rejects(
    prepareTriliumImport({
      endpoint: ENDPOINT,
      token: TOKEN,
      fetchImpl: fakeFetch(new Map([['/base/etapi/notes/root', new Response('{}', {
        headers: { 'content-length': String(TRILIUM_IMPORT_MAX_RESPONSE_BYTES + 1) },
      })]])),
    }),
    /response is too large/,
  );
  await assert.rejects(
    prepareTriliumImport({
      endpoint: ENDPOINT,
      token: TOKEN,
      fetchImpl: fakeFetch(new Map([['/base/etapi/notes/root', jsonResponse({ noteId: 'root' })]])),
    }),
    /Note response is invalid/,
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    prepareTriliumImport({
      endpoint: ENDPOINT,
      token: TOKEN,
      signal: controller.signal,
      fetchImpl: fakeFetch(new Map()),
    }),
    /cancelled/,
  );
});

test('a response that sends a prefix and then stalls fails at the request deadline', async () => {
  const routes = new Map();
  routes.set('/base/etapi/notes/root', jsonResponse(remoteNote('root', ['b001'])));
  routes.set('/base/etapi/branches/b001', jsonResponse(remoteBranch('b001', 'noteA', 'root', 1)));
  routes.set('/base/etapi/notes/noteA', jsonResponse(remoteNote('noteA', [], {
    type: 'text',
    mime: 'text/plain',
  })));
  const regularFetch = fakeFetch(routes);
  const streamingFetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname !== '/base/etapi/notes/noteA/content') return regularFetch(input, init);
    const headers = new Headers(init.headers);
    assert.equal(headers.get('authorization'), `Bearer ${TOKEN}`);
    assert.equal(init.redirect, 'manual');
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('partial content'));
      },
    }));
  };

  await assert.rejects(
    prepareTriliumImport({
      endpoint: ENDPOINT,
      token: TOKEN,
      requestTimeoutMs: 20,
      fetchImpl: streamingFetch,
    }),
    /timed out/,
  );
});

test('Trilium HTML image scanning accepts only canonical same-endpoint routes and rejects traversal or remote sources', () => {
  const html = [
    '<img src="api/attachments/attA/image/a.png">',
    '<img src="/base/api/images/imgA/picture.png?timestamp=1">',
    '<img src="https://notes.example.test/base/api/images/imgB">',
    '<img src="https://other.example.test/base/api/images/imgC/x.png">',
    '<img src="data:image/png;base64,AAAA">',
    '<img src="blob:https://notes.example.test/id">',
    '<img src="api/images/imgD/%2e%2e/secret.png">',
    '<img src="../api/images/imgE/x.png">',
    '<img src="/wrong/api/images/imgF/x.png">',
    '<img src="api/images/imgG/x.png" src="api/images/imgH/y.png">',
    '<img alt="missing">',
  ].join('');
  const scanned = scanTriliumHtmlImages(ENDPOINT, html);

  assert.deepEqual(scanned.slice(0, 3).map((image) => [image.kind, image.remoteId, image.sourceKey]), [
    ['attachment', 'attA', 'attachment:attA'],
    ['note', 'imgA', 'note:imgA'],
    ['note', 'imgB', 'note:imgB'],
  ]);
  assert.ok(scanned.slice(3).every((image) => (
    image.kind === 'invalid'
    && image.status === 'invalid'
    && /^invalid:[A-Za-z0-9_-]{43}$/.test(image.sourceKey)
  )));
});

test('embedded attachment metadata participates in v3 source identity and changed targets only', async () => {
  const html = '<p>Before</p><figure><img src="api/attachments/attA/image/a.png"></figure>';
  const routes = new Map([
    ['/base/etapi/notes/root', jsonResponse(remoteNote('root', ['b001']))],
    ['/base/etapi/branches/b001', jsonResponse(remoteBranch('b001', 'noteA', 'root', 1))],
    ['/base/etapi/notes/noteA', jsonResponse(remoteNote('noteA'))],
    ['/base/etapi/notes/noteA/content', new Response(html)],
    ['/base/etapi/attachments/attA', jsonResponse(remoteAttachment('attA'))],
  ]);
  const initial = await prepareTriliumImport({ endpoint: ENDPOINT, token: TOKEN, fetchImpl: fakeFetch(routes) });
  assert.equal(initial.notes[0].content.kind, 'html');
  assert.deepEqual(initial.notes[0].content.images.map((image) => image.sourceKey), ['attachment:attA']);
  assert.deepEqual(initial.imageTargets.map((target) => target.sourceKey), ['attachment:attA']);
  assert.equal(JSON.stringify(initial).includes(TOKEN), false);
  assert.equal(Object.hasOwn(initial.imageTargets[0], 'bytes'), false);

  const observations = {};
  const unchanged = await prepareTriliumImport({
    endpoint: ENDPOINT,
    token: TOKEN,
    knownSourceVersions: { [initial.notes[0].localNoteId]: initial.notes[0].sourceVersion },
    fetchImpl: fakeFetch(routes, observations),
  });
  assert.equal(unchanged.notes[0].content.kind, 'unchanged-source');
  assert.deepEqual(unchanged.imageTargets, []);
  assert.ok(observations.paths.includes('/base/etapi/notes/noteA/content'));
  assert.ok(observations.paths.includes('/base/etapi/attachments/attA'));

  const changedRoutes = new Map(routes);
  changedRoutes.set('/base/etapi/attachments/attA', jsonResponse(remoteAttachment('attA', {
    blobId: 'blob-attA-v2',
    utcDateModified: '2026-07-19T00:00:00.000Z',
  })));
  const changed = await prepareTriliumImport({
    endpoint: ENDPOINT,
    token: TOKEN,
    knownSourceVersions: { [initial.notes[0].localNoteId]: initial.notes[0].sourceVersion },
    fetchImpl: fakeFetch(changedRoutes),
  });
  assert.equal(changed.notes[0].content.kind, 'html');
  assert.notEqual(changed.notes[0].sourceVersion, initial.notes[0].sourceVersion);
  assert.equal(changed.imageTargets[0].blobId, 'blob-attA-v2');
});

test('image Notes become resolvable Rich Text image content without reading binary content during prepare', async () => {
  const routes = new Map([
    ['/base/etapi/notes/root', jsonResponse(remoteNote('root', ['b001']))],
    ['/base/etapi/branches/b001', jsonResponse(remoteBranch('b001', 'imgA', 'root', 1))],
    ['/base/etapi/notes/imgA', jsonResponse(remoteNote('imgA', [], {
      type: 'image',
      mime: 'image/jpg',
      blobId: 'sharedBlob',
      contentLength: JPEG_1X1.byteLength,
    }))],
  ]);
  const observations = {};
  const plan = await prepareTriliumImport({
    endpoint: ENDPOINT,
    token: TOKEN,
    fetchImpl: fakeFetch(routes, observations),
  });
  assert.deepEqual(plan.notes[0].content, {
    kind: 'image', language: 'richtext', sourceKey: 'note:imgA',
  });
  assert.deepEqual(plan.imageTargets.map((target) => [
    target.kind,
    target.remoteId,
    target.mimeType,
    target.status,
  ]), [
    ['note', 'imgA', 'image/jpeg', 'ready'],
  ]);
  assert.equal(observations.paths.includes('/base/etapi/notes/imgA/content'), false);
});

test('Trilium image/jpg metadata canonicalizes to JPEG across prepare and resolve', async () => {
  const html = '<figure><img src="api/attachments/attA/image/a.jpg"></figure>';
  const noteMetadata = remoteNote('noteA');
  const oldAliasTarget = {
    sourceKey: 'attachment:attA', kind: 'attachment', remoteId: 'attA', blobId: 'blob-attA',
    mimeType: 'image/jpg', utcDateModified: MODIFIED, contentLength: JPEG_1X1.byteLength,
    status: 'unsupported',
  };
  const oldAliasVersion = triliumSourceVersion(noteMetadata, [
    triliumImageTargetFingerprint(oldAliasTarget),
  ]);
  const preparedVersions = [];
  const cases = [
    [' Image/JPG; charset=binary', 'image/jpeg'],
    ['image/jpeg', ' IMAGE/JPG; charset=binary'],
  ];

  for (const [index, [prepareMime, resolveMime]] of cases.entries()) {
    const prepareRoutes = new Map([
      ['/base/etapi/notes/root', jsonResponse(remoteNote('root', ['b001']))],
      ['/base/etapi/branches/b001', jsonResponse(remoteBranch('b001', 'noteA', 'root', 1))],
      ['/base/etapi/notes/noteA', jsonResponse(noteMetadata)],
      ['/base/etapi/notes/noteA/content', new Response(html)],
      ['/base/etapi/attachments/attA', jsonResponse(remoteAttachment('attA', {
        mime: prepareMime,
        title: 'a.jpg',
        contentLength: JPEG_1X1.byteLength,
      }))],
    ]);
    const plan = await prepareTriliumImport({
      endpoint: ENDPOINT,
      token: TOKEN,
      ...(index === 0 ? {
        knownSourceVersions: { [triliumLocalNoteId(ENDPOINT, 'noteA')]: oldAliasVersion },
      } : {}),
      fetchImpl: fakeFetch(prepareRoutes),
    });

    assert.equal(plan.notes[0].content.kind, 'html');
    assert.notEqual(plan.notes[0].sourceVersion, oldAliasVersion);
    assert.deepEqual(plan.imageTargets.map(({ mimeType, status }) => [mimeType, status]), [
      ['image/jpeg', 'ready'],
    ]);
    preparedVersions.push(plan.notes[0].sourceVersion);

    let uploads = 0;
    const resolved = await resolveTriliumImportImages(
      { endpoint: ENDPOINT, imageTargets: plan.imageTargets },
      TOKEN,
      async (input) => {
        uploads += 1;
        assert.deepEqual(Buffer.from(input.bytes), JPEG_1X1);
        assert.equal(input.mimeType, 'image/jpeg');
        return {
          status: 'uploaded',
          reference: uploadedReference(input.bytes, { mimeType: 'image/jpeg' }),
        };
      },
      { fetchImpl: fakeFetch(new Map([
        ['/base/etapi/attachments/attA', jsonResponse(remoteAttachment('attA', {
          mime: resolveMime,
          title: 'a.jpg',
          contentLength: JPEG_1X1.byteLength,
        }))],
        ['/base/etapi/attachments/attA/content', new Response(JPEG_1X1)],
      ])) },
    );

    assert.equal(uploads, 1);
    assert.equal(resolved[0].status, 'uploaded');
    assert.equal(resolved[0].reference.mimeType, 'image/jpeg');
  }

  assert.equal(preparedVersions[0], preparedVersions[1]);
});

test('image resolution uses exact read-only ETAPI content routes and deduplicates blobs and uploaded content', async () => {
  const targets = [
    {
      sourceKey: 'attachment:attA', kind: 'attachment', remoteId: 'attA', blobId: 'blobSame',
      mimeType: 'image/png', utcDateModified: MODIFIED, contentLength: PNG_1X1.byteLength, status: 'ready',
    },
    {
      sourceKey: 'note:imgA', kind: 'note', remoteId: 'imgA', blobId: 'blobSame',
      mimeType: 'image/png', utcDateModified: MODIFIED, contentLength: PNG_1X1.byteLength, status: 'ready',
    },
    {
      sourceKey: 'attachment:attB', kind: 'attachment', remoteId: 'attB', blobId: 'differentBlob',
      mimeType: 'image/png', utcDateModified: MODIFIED, contentLength: PNG_1X1.byteLength, status: 'ready',
    },
  ];
  const observations = {};
  const routes = new Map([
    ['/base/etapi/attachments/attA', jsonResponse(remoteAttachment('attA', {
      blobId: 'blobSame', contentLength: PNG_1X1.byteLength,
    }))],
    ['/base/etapi/notes/imgA', jsonResponse(remoteNote('imgA', [], {
      type: 'image', mime: 'image/png', blobId: 'blobSame', contentLength: PNG_1X1.byteLength,
    }))],
    ['/base/etapi/attachments/attB', jsonResponse(remoteAttachment('attB', {
      blobId: 'differentBlob', contentLength: PNG_1X1.byteLength,
    }))],
    ['/base/etapi/attachments/attA/content', new Response(PNG_1X1)],
    ['/base/etapi/attachments/attB/content', new Response(PNG_1X1)],
  ]);
  let uploads = 0;
  const resolved = await resolveTriliumImportImages(
    { endpoint: ENDPOINT, imageTargets: targets },
    TOKEN,
    async (input, context) => {
      assert.equal(context.signal.aborted, false);
      assert.deepEqual(Buffer.from(input.bytes), PNG_1X1);
      assert.equal(input.mimeType, 'image/png');
      uploads += 1;
      return { status: 'uploaded', reference: uploadedReference(input.bytes) };
    },
    { fetchImpl: fakeFetch(routes, observations) },
  );

  assert.equal(observations.requests, 5);
  assert.deepEqual(observations.paths.sort(), [
    '/base/etapi/attachments/attA',
    '/base/etapi/attachments/attA/content',
    '/base/etapi/attachments/attB',
    '/base/etapi/attachments/attB/content',
    '/base/etapi/notes/imgA',
  ]);
  assert.equal(uploads, 1);
  assert.ok(resolved.every((asset) => asset.status === 'uploaded'));
  assert.equal(new Set(resolved.map((asset) => asset.reference.objectId)).size, 1);
});

test('image resolution emits explicit placeholders for unavailable or invalid assets but fails closed on auth and S3', async () => {
  const baseTarget = {
    sourceKey: 'attachment:attA', kind: 'attachment', remoteId: 'attA', blobId: 'blob-attA',
    mimeType: 'image/png', utcDateModified: MODIFIED, contentLength: PNG_1X1.byteLength, status: 'ready',
  };
  const missing = await resolveTriliumImportImages(
    { endpoint: ENDPOINT, imageTargets: [baseTarget] },
    TOKEN,
    async () => ({ status: 'uploaded', reference: uploadedReference() }),
    { fetchImpl: fakeFetch(new Map([
      ['/base/etapi/attachments/attA', jsonResponse(remoteAttachment('attA', {
        contentLength: PNG_1X1.byteLength,
      }))],
      ['/base/etapi/attachments/attA/content', new Response(null, { status: 404 })],
    ])) },
  );
  assert.deepEqual(missing, [{ sourceKey: 'attachment:attA', status: 'placeholder', reason: 'missing' }]);

  const invalid = await resolveTriliumImportImages(
    { endpoint: ENDPOINT, imageTargets: [baseTarget] },
    TOKEN,
    async () => { throw new Error('must not upload'); },
    { fetchImpl: fakeFetch(new Map([
      ['/base/etapi/attachments/attA', jsonResponse(remoteAttachment('attA', {
        contentLength: PNG_1X1.byteLength,
      }))],
      ['/base/etapi/attachments/attA/content', new Response('not an image')],
    ])) },
  );
  assert.deepEqual(invalid, [{ sourceKey: 'attachment:attA', status: 'placeholder', reason: 'invalid' }]);

  let spoofedUploads = 0;
  const spoofed = await resolveTriliumImportImages(
    {
      endpoint: ENDPOINT,
      imageTargets: [{
        ...baseTarget,
        mimeType: 'image/jpeg',
        contentLength: PNG_1X1.byteLength,
      }],
    },
    TOKEN,
    async () => {
      spoofedUploads += 1;
      return { status: 'uploaded', reference: uploadedReference() };
    },
    { fetchImpl: fakeFetch(new Map([
      ['/base/etapi/attachments/attA', jsonResponse(remoteAttachment('attA', {
        mime: 'image/jpg',
        contentLength: PNG_1X1.byteLength,
      }))],
      ['/base/etapi/attachments/attA/content', new Response(PNG_1X1)],
    ])) },
  );
  assert.equal(spoofedUploads, 0);
  assert.deepEqual(spoofed, [{ sourceKey: 'attachment:attA', status: 'placeholder', reason: 'invalid' }]);

  await assert.rejects(
    resolveTriliumImportImages(
      { endpoint: ENDPOINT, imageTargets: [baseTarget] },
      TOKEN,
      async () => ({ status: 'uploaded', reference: uploadedReference() }),
      { fetchImpl: fakeFetch(new Map([
        ['/base/etapi/attachments/attA', new Response(null, { status: 401 })],
      ])) },
    ),
    /failed \(401\)/,
  );

  await assert.rejects(
    resolveTriliumImportImages(
      { endpoint: ENDPOINT, imageTargets: [baseTarget] },
      TOKEN,
      async () => ({ status: 'not-configured' }),
      { fetchImpl: fakeFetch(new Map([
        ['/base/etapi/attachments/attA', jsonResponse(remoteAttachment('attA', {
          contentLength: PNG_1X1.byteLength,
        }))],
        ['/base/etapi/attachments/attA/content', new Response(PNG_1X1)],
      ])) },
    ),
    /Configure Notes S3/,
  );
});

test('image resolution rejects a prepare-to-resolve metadata race before downloading or uploading bytes', async () => {
  const target = {
    sourceKey: 'attachment:attA', kind: 'attachment', remoteId: 'attA', blobId: 'blob-attA',
    mimeType: 'image/png', utcDateModified: MODIFIED, contentLength: PNG_1X1.byteLength, status: 'ready',
  };
  const observations = {};
  let uploads = 0;
  await assert.rejects(
    resolveTriliumImportImages(
      { endpoint: ENDPOINT, imageTargets: [target] },
      TOKEN,
      async () => {
        uploads += 1;
        return { status: 'uploaded', reference: uploadedReference() };
      },
      { fetchImpl: fakeFetch(new Map([
        ['/base/etapi/attachments/attA', jsonResponse(remoteAttachment('attA', {
          blobId: 'changed-after-prepare',
          contentLength: PNG_1X1.byteLength,
        }))],
      ]), observations) },
    ),
    /changed while the import was being resolved/,
  );
  assert.equal(uploads, 0);
  assert.deepEqual(observations.paths, ['/base/etapi/attachments/attA']);
});

test('image resolution distinguishes protected, oversized, and unsupported placeholders without S3 writes', async () => {
  const targets = [
    {
      sourceKey: 'attachment:attA', kind: 'attachment', remoteId: 'attA', blobId: 'blob-attA',
      mimeType: 'image/png', utcDateModified: MODIFIED, contentLength: PNG_1X1.byteLength, status: 'ready',
    },
    {
      sourceKey: 'attachment:attB', kind: 'attachment', remoteId: 'attB', blobId: 'blob-attB',
      mimeType: 'image/png', utcDateModified: MODIFIED, contentLength: PNG_1X1.byteLength, status: 'ready',
    },
    {
      sourceKey: 'attachment:attC', kind: 'attachment', remoteId: 'attC', blobId: 'blob-attC',
      mimeType: 'image/gif', utcDateModified: MODIFIED, contentLength: 32, status: 'unsupported',
    },
  ];
  let uploads = 0;
  const result = await resolveTriliumImportImages(
    { endpoint: ENDPOINT, imageTargets: targets },
    TOKEN,
    async () => {
      uploads += 1;
      return { status: 'uploaded', reference: uploadedReference() };
    },
    { fetchImpl: fakeFetch(new Map([
      ['/base/etapi/attachments/attA', jsonResponse(remoteAttachment('attA', {
        contentLength: PNG_1X1.byteLength,
      }))],
      ['/base/etapi/attachments/attB', jsonResponse(remoteAttachment('attB', {
        contentLength: PNG_1X1.byteLength,
      }))],
      ['/base/etapi/attachments/attA/content', new Response(null, { status: 400 })],
      ['/base/etapi/attachments/attB/content', new Response(null, {
        headers: { 'content-length': String(10 * 1024 * 1024 + 1) },
      })],
    ])) },
  );
  assert.deepEqual(result.map((asset) => asset.reason), ['protected', 'oversized', 'unsupported']);
  assert.equal(uploads, 0);
});

test('image resolution honors cancellation before issuing any ETAPI or S3 operation', async () => {
  const controller = new AbortController();
  controller.abort();
  let uploads = 0;
  await assert.rejects(
    resolveTriliumImportImages(
      { endpoint: ENDPOINT, imageTargets: [] },
      TOKEN,
      async () => {
        uploads += 1;
        return { status: 'uploaded', reference: uploadedReference() };
      },
      { signal: controller.signal, fetchImpl: fakeFetch(new Map()) },
    ),
    /cancelled/,
  );
  assert.equal(uploads, 0);
});

function emptyNotes() {
  return { schemaVersion: 1, notes: [] };
}

function emptyTree() {
  return { schemaVersion: 1, nodes: [] };
}

const RICH_ALPHA = '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Alpha"}]}]}';

function convertedRichText(plan) {
  return Object.fromEntries(plan.notes
    .filter((note) => note.content.kind === 'html' || note.content.kind === 'image')
    .map((note) => [note.localNoteId, RICH_ALPHA]));
}

test('snapshot merge creates Notes, removes matching tombstones, and refreshes first clone placement', async () => {
  const plan = await prepareTriliumImport({
    endpoint: ENDPOINT,
    token: TOKEN,
    fetchImpl: fakeFetch(hierarchyRoutes()),
  });
  const merged = mergeTriliumImport({
    plan,
    convertedHtml: convertedRichText(plan),
    notes: emptyNotes(),
    tombstones: [
      { id: plan.notes[0].localNoteId, deletedAt: CREATED },
      { id: 'unrelated-deleted', deletedAt: CREATED },
    ],
    tree: emptyTree(),
  });

  assert.deepEqual(merged.summary, {
    created: 3, updated: 0, unchanged: 0, placeholders: 0, clones: 1, imported: 3,
  });
  assert.deepEqual(merged.tombstones.map((value) => value.id), ['unrelated-deleted']);
  const alpha = merged.notes.notes.find((note) => note.id === plan.notes[0].localNoteId);
  assert.equal(alpha.language, 'richtext');
  assert.equal(alpha.content, RICH_ALPHA);
  assert.equal(triliumStoredSourceVersion(alpha.tags), plan.notes[0].sourceVersion);
  assert.equal(
    merged.tree.nodes.find((node) => node.noteId === plan.notes[2].localNoteId).parentId,
    plan.notes[0].localNoteId,
  );
});

test('same source version preserves all local edits while still refreshing tree placement', async () => {
  const plan = await prepareTriliumImport({
    endpoint: ENDPOINT,
    token: TOKEN,
    fetchImpl: fakeFetch(hierarchyRoutes()),
  });
  const first = mergeTriliumImport({
    plan,
    convertedHtml: convertedRichText(plan),
    notes: emptyNotes(),
    tombstones: [],
    tree: emptyTree(),
  });
  const alpha = first.notes.notes.find((note) => note.id === plan.notes[0].localNoteId);
  const locallyEdited = {
    ...alpha,
    name: 'Local title',
    content: '# locally edited',
    language: 'markdown',
    tags: [...alpha.tags, 'personal'],
    updatedAt: '2026-07-10T00:00:00.000Z',
  };
  const notes = {
    schemaVersion: 1,
    notes: first.notes.notes.map((note) => note.id === alpha.id ? locallyEdited : note),
  };
  const movedTree = {
    schemaVersion: 1,
    nodes: first.tree.nodes.map((node) => node.noteId === plan.notes[2].localNoteId
      ? { ...node, parentId: null, order: 999999 }
      : node),
  };
  const repeated = mergeTriliumImport({ plan, notes, tombstones: [], tree: movedTree });

  assert.deepEqual(repeated.notes.notes.find((note) => note.id === alpha.id), locallyEdited);
  assert.equal(repeated.summary.unchanged, 3);
  assert.equal(
    repeated.tree.nodes.find((node) => node.noteId === plan.notes[2].localNoteId).parentId,
    plan.notes[0].localNoteId,
  );
});

test('remote source changes overwrite the imported body, while remote omissions never delete local Notes', async () => {
  const plan = await prepareTriliumImport({
    endpoint: ENDPOINT,
    token: TOKEN,
    fetchImpl: fakeFetch(hierarchyRoutes()),
  });
  const first = mergeTriliumImport({
    plan,
    convertedHtml: convertedRichText(plan),
    notes: emptyNotes(),
    tombstones: [],
    tree: emptyTree(),
  });
  const changed = structuredClone(plan);
  const script = changed.notes[1];
  script.title = 'Changed remotely';
  script.sourceVersion = triliumSourceVersion({
    title: script.title,
    type: 'code',
    mime: 'application/typescript',
    blobId: 'changed-blob',
    utcDateModified: '2026-07-20T00:00:00.000Z',
  });
  script.sourceModifiedAt = '2026-07-20T00:00:00.000Z';
  script.content = { kind: 'ready', language: 'typescript', content: 'const changed: boolean = true;' };
  const absentId = triliumLocalNoteId(ENDPOINT, 'gone1');
  const absent = {
    id: absentId,
    name: 'Not returned this time',
    content: 'keep me',
    language: 'text',
    tags: [],
    createdAt: CREATED,
    updatedAt: MODIFIED,
  };
  const currentNotes = {
    schemaVersion: 1,
    notes: [...first.notes.notes, absent],
  };
  const currentTree = {
    schemaVersion: 1,
    nodes: [...first.tree.nodes, { noteId: absentId, parentId: null, order: 999_999 }],
  };
  const merged = mergeTriliumImport({
    plan: changed,
    notes: currentNotes,
    tombstones: [],
    tree: currentTree,
  });

  const updated = merged.notes.notes.find((note) => note.id === script.localNoteId);
  assert.equal(updated.name, 'Changed remotely');
  assert.equal(updated.language, 'typescript');
  assert.equal(updated.content, 'const changed: boolean = true;');
  assert.equal(merged.summary.updated, 1);
  assert.deepEqual(merged.notes.notes.find((note) => note.id === absentId), absent);
  assert.ok(merged.tree.nodes.some((node) => node.noteId === absentId));
});
