const assert = require('node:assert/strict');
const test = require('node:test');

const {
  TRILIUM_IMPORT_MAX_RESPONSE_BYTES,
  mergeTriliumImport,
  normalizeTriliumEndpoint,
  normalizeTriliumToken,
  prepareTriliumImport,
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
  assert.equal(plan.placeholders, 1);
  assert.equal(plan.truncated, false);
  assert.equal(plan.notes[0].content.kind, 'html');
  assert.deepEqual(plan.notes[1].content, {
    kind: 'ready', language: 'javascript', content: 'console.log("hello")',
  });
  assert.equal(plan.notes[2].content.kind, 'placeholder');
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

test('known source versions avoid refetching and reconverting unchanged content', async () => {
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
  assert.equal(observations.paths.some((pathname) => pathname.endsWith('/content')), false);
  assert.equal(repeated.placeholders, 0);
});

test('text, code, and non-binary Trilium note types retain content while binary notes become placeholders', async () => {
  const cases = [
    ['nt01', 'text', 'text/markdown', 'markdown'],
    ['nt02', 'code', 'application/x-sh', 'bash'],
    ['nt03', 'code', 'application/typescript', 'typescript'],
    ['nt04', 'code', 'text/x-sql', 'sql'],
    ['nt05', 'code', 'application/json', 'json'],
    ['nt06', 'code', 'application/yaml', 'yaml'],
    ['nt07', 'code', 'text/x-python', 'text'],
    ['nt08', 'mermaid', 'text/plain', 'text'],
    ['nt09', 'search', 'application/json', 'text'],
    ['nt10', 'book', 'text/html', 'text'],
    ['nt11', 'render', 'text/html', 'text'],
    ['nt12', 'webView', 'text/plain', 'text'],
    ['nt13', 'doc', 'text/html', 'text'],
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
    routes.set(`/base/etapi/notes/${noteId}/content`, new Response(`content-${noteId}`));
  }
  routes.set('/base/etapi/branches/bimg', jsonResponse(remoteBranch('bimg', 'nimg', 'root', 100)));
  routes.set('/base/etapi/branches/bfil', jsonResponse(remoteBranch('bfil', 'nfil', 'root', 101)));
  routes.set('/base/etapi/notes/nimg', jsonResponse(remoteNote('nimg', [], { type: 'image', mime: 'image/png' })));
  routes.set('/base/etapi/notes/nfil', jsonResponse(remoteNote('nfil', [], { type: 'file', mime: 'application/pdf' })));
  const root = remoteNote('root', [...branchIds, 'bimg', 'bfil']);
  routes.set('/base/etapi/notes/root', jsonResponse(root));

  const plan = await prepareTriliumImport({ endpoint: ENDPOINT, token: TOKEN, fetchImpl: fakeFetch(routes) });
  assert.deepEqual(
    plan.notes.slice(0, cases.length).map((note) => note.content.language),
    cases.map((entry) => entry[3]),
  );
  assert.ok(plan.notes.slice(0, cases.length).every((note) => note.content.kind === 'ready'));
  assert.ok(plan.notes.slice(-2).every((note) => note.content.kind === 'placeholder'));
  assert.equal(plan.placeholders, 2);
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

function emptyNotes() {
  return { schemaVersion: 1, notes: [] };
}

function emptyTree() {
  return { schemaVersion: 1, nodes: [] };
}

const RICH_ALPHA = '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Alpha"}]}]}';

test('snapshot merge creates Notes, removes matching tombstones, and refreshes first clone placement', async () => {
  const plan = await prepareTriliumImport({
    endpoint: ENDPOINT,
    token: TOKEN,
    fetchImpl: fakeFetch(hierarchyRoutes()),
  });
  const merged = mergeTriliumImport({
    plan,
    convertedHtml: { [plan.notes[0].localNoteId]: RICH_ALPHA },
    notes: emptyNotes(),
    tombstones: [
      { id: plan.notes[0].localNoteId, deletedAt: CREATED },
      { id: 'unrelated-deleted', deletedAt: CREATED },
    ],
    tree: emptyTree(),
  });

  assert.deepEqual(merged.summary, {
    created: 3, updated: 0, unchanged: 0, placeholders: 1, clones: 1, imported: 3,
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
    convertedHtml: { [plan.notes[0].localNoteId]: RICH_ALPHA },
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
    convertedHtml: { [plan.notes[0].localNoteId]: RICH_ALPHA },
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
