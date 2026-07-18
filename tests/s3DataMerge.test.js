const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createS3SharedAppDataV2,
  mergeS3SharedAppDataV2,
  parseS3SharedAppDataV2,
  stageS3SharedAppDataForLocalApply,
} = require('../dist/main/s3DataMerge');

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

function data(notes, overrides = {}) {
  return createS3SharedAppDataV2({
    hosts: [host()],
    notes: { schemaVersion: 1, notes },
    proxy: proxy(),
    ...overrides,
  });
}

test('v2 shared projection strips device-only Host, Forward, Service, Proxy, and unrelated fields', () => {
  const shared = createS3SharedAppDataV2({
    hosts: [host()],
    notes: { schemaVersion: 1, notes: [note('note-1', '# deploy')] },
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
  assert.match(JSON.stringify(shared), /PRIVATE KEY/);
  assert.doesNotMatch(
    JSON.stringify(shared),
    /privateKeyPath|autoStart|"pid"|startOnLaunch|mixedPort|tunEnabled|systemProxyEnabled|must-not-sync/,
  );
});

test('strict v2 parsing rejects duplicate Note IDs and note/tombstone collisions', () => {
  const duplicate = data([note('note-1', 'base')]);
  duplicate.notes.notes.push(note('note-1', 'duplicate'));
  assert.throws(() => parseS3SharedAppDataV2(duplicate), /duplicate ID/);

  const collision = data([note('note-1', 'base')]);
  collision.notes.tombstones.push({ id: 'note-1', deletedAt: T1 });
  assert.throws(() => parseS3SharedAppDataV2(collision), /duplicate ID/);
  assert.throws(() => parseS3SharedAppDataV2({ ...collision, schemaVersion: 1 }), /invalid/);
});

test('three-way merge combines independent cloud additions and local Note edits', () => {
  const base = data([note('note-1', 'base')]);
  const local = data([note('note-1', 'local edit', T1)]);
  const cloud = data([note('note-1', 'base'), note('note-2', 'cloud addition', T1)]);

  const result = mergeS3SharedAppDataV2({ base, local, cloud, now: T2 });

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

  const result = mergeS3SharedAppDataV2({
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

test('cloud deletion wins over a local edit while preserving that edit as a conflict Note', () => {
  const base = data([note('note-1', 'base')]);
  const local = data([note('note-1', 'offline edit', T1)]);
  const cloud = data([], {
    noteTombstones: [{ id: 'note-1', deletedAt: T1 }],
  });

  const result = mergeS3SharedAppDataV2({
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
});

test('cloud deletion removes an unchanged local Note without creating a false conflict', () => {
  const base = data([note('note-1', 'base')]);
  const local = data([note('note-1', 'base')]);
  const cloud = data([], { noteTombstones: [{ id: 'note-1', deletedAt: T1 }] });

  const result = mergeS3SharedAppDataV2({ base, local, cloud, now: T2 });

  assert.deepEqual(result.data.notes.notes, []);
  assert.deepEqual(result.data.notes.tombstones, [{ id: 'note-1', deletedAt: T1 }]);
  assert.equal(result.conflictCount, 0);
});

test('a local deletion becomes a tombstone when cloud has not changed', () => {
  const base = data([note('note-1', 'base')]);
  const local = data([]);
  const cloud = data([note('note-1', 'base')]);

  const result = mergeS3SharedAppDataV2({ base, local, cloud, now: T2 });

  assert.deepEqual(result.data.notes.notes, []);
  assert.deepEqual(result.data.notes.tombstones, [{ id: 'note-1', deletedAt: T2 }]);
  assert.equal(result.conflictCount, 0);
});

test('an established cloud tombstone cannot be resurrected with the same stable Note ID', () => {
  const base = data([], { noteTombstones: [{ id: 'note-1', deletedAt: T1 }] });
  const local = data([note('note-1', 'attempted restore', T2)]);
  const cloud = data([], { noteTombstones: [{ id: 'note-1', deletedAt: T1 }] });

  const result = mergeS3SharedAppDataV2({
    base,
    local,
    cloud,
    now: T2,
    createId: () => 'restored-conflict',
  });

  assert.deepEqual(result.data.notes.tombstones, [{ id: 'note-1', deletedAt: T1 }]);
  assert.deepEqual(result.data.notes.notes.map((item) => [item.id, item.content]), [
    ['restored-conflict', 'attempted restore'],
  ]);
  assert.equal(result.conflictCount, 1);
});

test('singleton sections accept one-sided edits but cloud wins true divergence', () => {
  const base = data([note('note-1', 'base')]);
  const localOnly = data([note('note-1', 'base')], { hosts: [host({ name: 'Local name' })] });
  const unchangedCloud = data([note('note-1', 'base')]);
  const localResult = mergeS3SharedAppDataV2({ base, local: localOnly, cloud: unchangedCloud, now: T2 });
  assert.equal(localResult.data.hosts.items[0].name, 'Local name');
  assert.deepEqual(localResult.discardedLocalSections, []);

  const changedCloud = data([note('note-1', 'base')], { hosts: [host({ name: 'Cloud name' })] });
  const conflictResult = mergeS3SharedAppDataV2({ base, local: localOnly, cloud: changedCloud, now: T2 });
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

  stage.hosts[0].name = 'mutated';
  stage.notes.notes[0].tags.push('mutated');
  assert.equal(cloud.hosts.items[0].name, 'Development');
  assert.deepEqual(cloud.notes.notes[0].tags, ['shared']);
});
