const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createS3SharedAppData,
  mergeS3SharedAppData,
  normalizeS3NotesTreeSnapshot,
  parseS3SharedAppData,
  stageS3SharedAppDataForLocalApply,
} = require('../dist/main/s3/s3DataMerge');

const T0 = '2026-07-18T00:00:00.000Z';
const T1 = '2026-07-18T01:00:00.000Z';
const T2 = '2026-07-18T02:00:00.000Z';

function note(id, content, updatedAt = T0, overrides = {}) {
  return {
    id,
    name: `Note ${id}`,
    content,
    language: 'markdown',
    tags: ['shared'],
    createdAt: T0,
    updatedAt,
    ...overrides,
  };
}

function host(overrides = {}) {
  return {
    id: 'host-1',
    name: 'Development',
    sshHost: 'dev.example.test',
    sshPort: 22,
    username: 'developer',
    authType: 'privateKey',
    privateKey: 'PRIVATE KEY',
    privateKeyPath: '/Users/local/.ssh/id_ed25519',
    jumpHosts: [],
    forwards: [{
      id: 'forward-1',
      name: 'Web',
      localHost: '127.0.0.1',
      localPort: 8080,
      remoteHost: '127.0.0.1',
      remotePort: 80,
      autoStart: true,
    }],
    services: [{
      id: 'service-1',
      name: 'API',
      startCommand: 'pnpm start',
      port: 3000,
      forwardLocalPort: 33000,
      pid: 12345,
    }],
    ...overrides,
  };
}

function proxy(overrides = {}) {
  return {
    settings: {
      startOnLaunch: true,
      mode: 'rule',
      mixedPort: 7890,
      tunEnabled: true,
      systemProxyEnabled: true,
      selectedProxies: { Main: 'Hong Kong' },
      customRules: [{ id: 'rule-1', type: 'DOMAIN', value: 'example.com', target: 'DIRECT' }],
      ...overrides,
    },
    subscriptionYaml: 'proxies: []\n',
  };
}

function notesTree(notes, placements = {}) {
  return {
    schemaVersion: 1,
    nodes: notes.map((item, index) => ({
      noteId: item.id,
      parentId: placements[item.id]?.parentId ?? null,
      order: placements[item.id]?.order ?? (index + 1) * 1024,
    })),
  };
}

function data(notes, overrides = {}) {
  return createS3SharedAppData({
    hosts: [host()],
    notes: { schemaVersion: 1, notes },
    notesTree: notesTree(notes),
    proxy: proxy(),
    ...overrides,
  });
}

test('shared data projection strips device-only Host, Forward, Service, Proxy, and unrelated fields', () => {
  const shared = createS3SharedAppData({
    hosts: [host()],
    notes: { schemaVersion: 1, notes: [note('note-1', '# deploy')] },
    notesTree: notesTree([note('note-1', '# deploy')]),
    proxy: proxy(),
    kubernetes: { selectedContext: 'must-not-sync' },
  });

  assert.equal(shared.schemaVersion, 2);
  assert.equal(shared.hosts.items[0].privateKeyPath, undefined);
  assert.equal(shared.hosts.items[0].forwards[0].autoStart, undefined);
  assert.equal(shared.hosts.items[0].services[0].pid, undefined);
  assert.equal(shared.proxy.settings.startOnLaunch, undefined);
  assert.equal(shared.proxy.settings.mixedPort, undefined);
  assert.equal(shared.proxy.settings.tunEnabled, undefined);
  assert.equal(shared.proxy.settings.systemProxyEnabled, undefined);
  assert.equal(shared.kubernetes, undefined);
  assert.deepEqual(shared.notes.tree, notesTree([note('note-1', '# deploy')]));
  assert.match(JSON.stringify(shared), /PRIVATE KEY/);
  assert.doesNotMatch(
    JSON.stringify(shared),
    /privateKeyPath|autoStart|"pid"|startOnLaunch|mixedPort|tunEnabled|systemProxyEnabled|must-not-sync/,
  );
});

test('shared Notes projection canonicalizes rich text and rejects unsafe rich text', () => {
  const shared = data([note('rich-note', JSON.stringify({
    content: [{ type: 'paragraph', content: [{ text: 'Cloud rich text', type: 'text' }] }],
    type: 'doc',
  }, null, 2), T0, { language: 'richtext' })]);
  assert.equal(
    shared.notes.notes[0].content,
    '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Cloud rich text"}]}]}',
  );

  const unsafe = structuredClone(shared);
  unsafe.notes.notes[0].content = JSON.stringify({
    type: 'doc',
    content: [{ type: 'html', text: '<img src="data:image/png;base64,AA==">' }],
  });
  assert.throws(() => parseS3SharedAppData(unsafe), /rich text content is invalid/);
});

test('strict shared data parsing rejects duplicate Note IDs and note/tombstone collisions', () => {
  const duplicate = data([note('note-1', 'base')]);
  duplicate.notes.notes.push(note('note-1', 'duplicate'));
  assert.throws(() => parseS3SharedAppData(duplicate), /duplicate ID/);

  const collision = data([note('note-1', 'base')]);
  collision.notes.tombstones.push({ id: 'note-1', deletedAt: T1 });
  assert.throws(() => parseS3SharedAppData(collision), /duplicate ID/);
  assert.throws(() => parseS3SharedAppData({ ...collision, schemaVersion: 1 }), /invalid/);
});

test('three-way merge combines independent cloud additions and local Note edits', () => {
  const base = data([note('note-1', 'base')]);
  const local = data([note('note-1', 'local edit', T1)]);
  const cloud = data([note('note-1', 'base'), note('note-2', 'cloud addition', T1)]);

  const result = mergeS3SharedAppData({ base, local, cloud, now: T2 });

  assert.equal(result.conflictCount, 0);
  assert.deepEqual(
    result.data.notes.notes.map((item) => [item.id, item.content]),
    [['note-1', 'local edit'], ['note-2', 'cloud addition']],
  );
  assert.deepEqual(result.data.notes.tombstones, []);
});

test('same-Note divergence keeps cloud canonical and creates a tagged local conflict copy', () => {
  const base = data([note('note-1', 'base')]);
  const local = data([note('note-1', 'local edit', T1, { name: 'Deploy instructions' })]);
  const cloud = data([note('note-1', 'cloud edit', T1)]);

  const result = mergeS3SharedAppData({
    base,
    local,
    cloud,
    now: T2,
    createId: () => 'conflict-1',
  });

  assert.equal(result.conflictCount, 1);
  assert.deepEqual(result.noteConflicts, [{ sourceNoteId: 'note-1', conflictNoteId: 'conflict-1' }]);
  assert.equal(result.data.notes.notes[0].content, 'cloud edit');
  assert.deepEqual(result.data.notes.notes[1], {
    ...local.notes.notes[0],
    id: 'conflict-1',
    name: 'Deploy instructions (Conflict)',
    tags: ['shared', 'Conflict'],
    createdAt: T2,
    updatedAt: T2,
  });
});

test('Notes tree merges independent moves and lets cloud win a same-node placement conflict', () => {
  const notes = [note('a', 'A'), note('b', 'B'), note('c', 'C')];
  const base = data(notes);
  const local = data(notes, {
    notesTree: notesTree(notes, { b: { parentId: 'a', order: 1024 } }),
  });
  const cloud = data(notes, {
    notesTree: notesTree(notes, { c: { parentId: 'a', order: 1024 } }),
  });
  const merged = mergeS3SharedAppData({ base, local, cloud, now: T2 });
  assert.deepEqual(merged.data.notes.tree.nodes.map(({ noteId, parentId }) => [noteId, parentId]), [
    ['a', null],
    ['b', 'a'],
    ['c', 'a'],
  ]);

  const localConflict = data(notes, {
    notesTree: notesTree(notes, { b: { parentId: 'a', order: 1024 } }),
  });
  const cloudConflict = data(notes, {
    notesTree: notesTree(notes, { b: { parentId: 'c', order: 1024 } }),
  });
  const conflicted = mergeS3SharedAppData({ base, local: localConflict, cloud: cloudConflict, now: T2 });
  assert.equal(conflicted.data.notes.tree.nodes.find((node) => node.noteId === 'b').parentId, 'c');
});

test('Notes tree repair roots orphans and cycles, restores missing active nodes, and normalizes order', () => {
  const repaired = normalizeS3NotesTreeSnapshot({
    schemaVersion: 1,
    nodes: [
      { noteId: 'a', parentId: 'b', order: 9 },
      { noteId: 'b', parentId: 'a', order: 9 },
      { noteId: 'c', parentId: 'missing', order: Number.MAX_SAFE_INTEGER },
      { noteId: 'stale', parentId: null, order: 1 },
    ],
  }, ['a', 'b', 'c', 'd']);

  assert.deepEqual(repaired.nodes, [
    { noteId: 'a', parentId: null, order: 1024 },
    { noteId: 'b', parentId: null, order: 2048 },
    { noteId: 'c', parentId: null, order: 3072 },
    { noteId: 'd', parentId: null, order: 4096 },
  ]);
});

test('conflict Note copies preserve the corresponding local tree hierarchy', () => {
  const baseNotes = [note('parent', 'base parent'), note('child', 'base child')];
  const base = data(baseNotes, {
    notesTree: notesTree(baseNotes, { child: { parentId: 'parent', order: 1024 } }),
  });
  const localNotes = [note('parent', 'local parent', T1), note('child', 'local child', T1)];
  const local = data(localNotes, {
    notesTree: notesTree(localNotes, { child: { parentId: 'parent', order: 1024 } }),
  });
  const cloudNotes = [note('parent', 'cloud parent', T1), note('child', 'cloud child', T1)];
  const cloud = data(cloudNotes, {
    notesTree: notesTree(cloudNotes, { child: { parentId: 'parent', order: 1024 } }),
  });
  const ids = ['conflict-parent', 'conflict-child'];
  const merged = mergeS3SharedAppData({
    base,
    local,
    cloud,
    now: T2,
    createId: () => ids.shift(),
  });
  const treeById = new Map(merged.data.notes.tree.nodes.map((node) => [node.noteId, node]));
  assert.equal(treeById.get('conflict-child').parentId, 'conflict-parent');
});

test('a new child Conflict stays under its reused parent Conflict after a fenced retry', () => {
  const baseNotes = [note('parent', 'base parent'), note('child', 'base child')];
  const base = data(baseNotes, {
    notesTree: notesTree(baseNotes, { child: { parentId: 'parent', order: 1024 } }),
  });
  const firstLocalNotes = [note('parent', 'local parent first', T1), note('child', 'local child first', T1)];
  const firstLocal = data(firstLocalNotes, {
    notesTree: notesTree(firstLocalNotes, { child: { parentId: 'parent', order: 1024 } }),
  });
  const cloudNotes = [note('parent', 'cloud parent', T1), note('child', 'cloud child', T1)];
  const cloud = data(cloudNotes, {
    notesTree: notesTree(cloudNotes, { child: { parentId: 'parent', order: 1024 } }),
  });
  const published = mergeS3SharedAppData({ base, local: firstLocal, cloud, now: T2 });
  const publishedBySource = new Map(published.noteConflicts.map((conflict) => [
    conflict.sourceNoteId,
    conflict.conflictNoteId,
  ]));

  const retryLocalNotes = [note('parent', 'local parent first', T1), note('child', 'local child second', T2)];
  const retryLocal = data(retryLocalNotes, {
    notesTree: notesTree(retryLocalNotes, { child: { parentId: 'parent', order: 1024 } }),
  });
  const retried = mergeS3SharedAppData({
    base,
    local: retryLocal,
    cloud: published.data,
    now: T2,
  });
  const retriedBySource = new Map(retried.noteConflicts.map((conflict) => [
    conflict.sourceNoteId,
    conflict.conflictNoteId,
  ]));
  const reusedParentId = publishedBySource.get('parent');
  const firstChildId = publishedBySource.get('child');
  const secondChildId = retriedBySource.get('child');
  assert.equal(retriedBySource.get('parent'), reusedParentId);
  assert.notEqual(secondChildId, firstChildId);

  const treeById = new Map(retried.data.notes.tree.nodes.map((node) => [node.noteId, node]));
  assert.equal(treeById.get(reusedParentId).parentId, null);
  assert.equal(treeById.get(firstChildId).parentId, reusedParentId);
  assert.equal(treeById.get(secondChildId).parentId, reusedParentId);
});

test('a cloud tombstone defeats a same-ID local Note when the base still contains that Note', () => {
  const base = data([note('note-1', 'base')]);
  const local = data([note('note-1', 'offline edit', T1)]);
  const cloud = data([], {
    noteTombstones: [{ id: 'note-1', deletedAt: T1 }],
  });

  const result = mergeS3SharedAppData({
    base,
    local,
    cloud,
    now: T2,
    createId: () => 'conflict-deleted',
  });

  assert.equal(result.conflictCount, 1);
  assert.deepEqual(result.data.notes.tombstones, [{ id: 'note-1', deletedAt: T1 }]);
  assert.deepEqual(result.data.notes.notes.map((item) => [item.id, item.content]), [
    ['conflict-deleted', 'offline edit'],
  ]);
  assert.deepEqual(result.noteConflicts, [{
    sourceNoteId: 'note-1',
    conflictNoteId: 'conflict-deleted',
  }]);
});

test('cloud deletion removes an unchanged local Note without creating a false conflict', () => {
  const base = data([note('note-1', 'base')]);
  const local = data([note('note-1', 'base')]);
  const cloud = data([], { noteTombstones: [{ id: 'note-1', deletedAt: T1 }] });

  const result = mergeS3SharedAppData({ base, local, cloud, now: T2 });

  assert.deepEqual(result.data.notes.notes, []);
  assert.deepEqual(result.data.notes.tombstones, [{ id: 'note-1', deletedAt: T1 }]);
  assert.equal(result.conflictCount, 0);
});

test('a local deletion becomes a tombstone when cloud has not changed', () => {
  const base = data([note('note-1', 'base')]);
  const local = data([], { noteTombstones: [{ id: 'note-1', deletedAt: T2 }] });
  const cloud = data([note('note-1', 'base')]);

  const result = mergeS3SharedAppData({ base, local, cloud, now: T2 });

  assert.deepEqual(result.data.notes.notes, []);
  assert.deepEqual(result.data.notes.tombstones, [{ id: 'note-1', deletedAt: T2 }]);
  assert.equal(result.conflictCount, 0);
});

test('a cloud edit that overrides a local deletion is reported as a conflict', () => {
  const base = data([note('note-1', 'base')]);
  const local = data([], { noteTombstones: [{ id: 'note-1', deletedAt: T1 }] });
  const cloud = data([note('note-1', 'cloud edit', T2)]);

  const result = mergeS3SharedAppData({ base, local, cloud, now: T2 });

  assert.deepEqual(result.data.notes.notes, [note('note-1', 'cloud edit', T2)]);
  assert.deepEqual(result.data.notes.tombstones, []);
  assert.equal(result.conflictCount, 1);
  assert.deepEqual(result.noteConflicts, []);
});

test('a missing local per-Note file is not inferred as a deletion without a tombstone', () => {
  const base = data([note('note-1', 'base')]);
  const local = data([]);
  const cloud = data([note('note-1', 'base')]);

  const result = mergeS3SharedAppData({ base, local, cloud, now: T2 });

  assert.deepEqual(result.data.notes.notes, [note('note-1', 'base')]);
  assert.deepEqual(result.data.notes.tombstones, []);
  assert.equal(result.conflictCount, 0);
});

test('a local restore wins when its base already contains the unchanged cloud tombstone', () => {
  const base = data([], { noteTombstones: [{ id: 'note-1', deletedAt: T1 }] });
  const restored = note('note-1', 'intentional restore', T2);
  const local = data([restored]);
  const cloud = data([], { noteTombstones: [{ id: 'note-1', deletedAt: T1 }] });

  const result = mergeS3SharedAppData({
    base,
    local,
    cloud,
    now: T2,
    createId: () => {
      throw new Error('an acknowledged local restore must not create a Conflict Note');
    },
  });

  assert.deepEqual(result.data.notes.notes, [restored]);
  assert.deepEqual(result.data.notes.tombstones, []);
  assert.equal(result.conflictCount, 0);
  assert.deepEqual(result.noteConflicts, []);
});

test('a cloud tombstone defeats a same-ID local Note when no merge base is known', () => {
  const local = data([note('note-1', 'unknown local restore', T2)]);
  const cloud = data([], { noteTombstones: [{ id: 'note-1', deletedAt: T1 }] });

  const result = mergeS3SharedAppData({
    local,
    cloud,
    now: T2,
    createId: () => 'unknown-base-conflict',
  });

  assert.deepEqual(result.data.notes.tombstones, [{ id: 'note-1', deletedAt: T1 }]);
  assert.deepEqual(result.data.notes.notes.map((item) => [item.id, item.content]), [
    ['unknown-base-conflict', 'unknown local restore'],
  ]);
  assert.equal(result.conflictCount, 1);
  assert.deepEqual(result.noteConflicts, [{
    sourceNoteId: 'note-1',
    conflictNoteId: 'unknown-base-conflict',
  }]);
});

test('a newer cloud tombstone defeats a restore based on an earlier deletion event', () => {
  const base = data([], { noteTombstones: [{ id: 'note-1', deletedAt: T1 }] });
  const local = data([note('note-1', 'restore from earlier deletion', T2)]);
  const cloud = data([], { noteTombstones: [{ id: 'note-1', deletedAt: T2 }] });

  const result = mergeS3SharedAppData({
    base,
    local,
    cloud,
    now: T2,
    createId: () => 'new-deletion-conflict',
  });

  assert.deepEqual(result.data.notes.tombstones, [{ id: 'note-1', deletedAt: T2 }]);
  assert.deepEqual(result.data.notes.notes.map((item) => [item.id, item.content]), [
    ['new-deletion-conflict', 'restore from earlier deletion'],
  ]);
  assert.equal(result.conflictCount, 1);
});

test('singleton sections accept one-sided edits but cloud wins true divergence', () => {
  const base = data([note('note-1', 'base')]);
  const localOnly = data([note('note-1', 'base')], { hosts: [host({ name: 'Local name' })] });
  const unchangedCloud = data([note('note-1', 'base')]);
  const localResult = mergeS3SharedAppData({ base, local: localOnly, cloud: unchangedCloud, now: T2 });
  assert.equal(localResult.data.hosts.items[0].name, 'Local name');
  assert.deepEqual(localResult.discardedLocalSections, []);

  const changedCloud = data([note('note-1', 'base')], { hosts: [host({ name: 'Cloud name' })] });
  const conflictResult = mergeS3SharedAppData({ base, local: localOnly, cloud: changedCloud, now: T2 });
  assert.equal(conflictResult.data.hosts.items[0].name, 'Cloud name');
  assert.deepEqual(conflictResult.discardedLocalSections, ['hosts']);
});

test('staged local apply overlays device-only values and never accepts them from cloud', () => {
  const cloud = data([note('note-1', 'cloud')], {
    hosts: [host({
      privateKeyPath: '/remote/path',
      forwards: [{ ...host().forwards[0], autoStart: false }],
      services: [{ ...host().services[0], pid: 99999 }],
    })],
    proxy: proxy({
      startOnLaunch: false,
      mixedPort: 9999,
      tunEnabled: false,
      systemProxyEnabled: false,
    }),
  });
  const stage = stageS3SharedAppDataForLocalApply(cloud, {
    hosts: [host()],
    proxy: proxy({ mode: 'global' }),
  });

  assert.equal(stage.hosts[0].privateKeyPath, '/Users/local/.ssh/id_ed25519');
  assert.equal(stage.hosts[0].forwards[0].autoStart, true);
  assert.equal(stage.hosts[0].services[0].pid, 12345);
  assert.equal(stage.proxy.settings.startOnLaunch, true);
  assert.equal(stage.proxy.settings.mixedPort, 7890);
  assert.equal(stage.proxy.settings.tunEnabled, true);
  assert.equal(stage.proxy.settings.systemProxyEnabled, true);
  assert.equal(stage.proxy.settings.mode, 'rule');
  assert.deepEqual(stage.notesTree, cloud.notes.tree);

  stage.hosts[0].name = 'mutated';
  stage.notes.notes[0].tags.push('mutated');
  stage.notesTree.nodes[0].order = 999;
  assert.equal(cloud.hosts.items[0].name, 'Development');
  assert.deepEqual(cloud.notes.notes[0].tags, ['shared']);
  assert.equal(cloud.notes.tree.nodes[0].order, 1024);
});
