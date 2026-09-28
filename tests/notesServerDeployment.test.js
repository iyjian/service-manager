const test = require('node:test');
const assert = require('node:assert/strict');
const { NotesServerDeployment } = require('../dist/main/notesServer/deployment');
const { NotesServerConnection } = require('../dist/main/notesServer/connection');

function settings(overrides = {}) {
  return { enabled: true, identity: 'profile', instanceId: 'instance', endpoint: () => ({}), ...overrides };
}

test('API reuses SSH and config, discards failed sessions, and reconnects after cancellation', async t => {
  let opens = 0, reads = 0, executions = 0, closed = 0, fail = false;
  t.mock.method(NotesServerConnection, 'open', async (_endpoint, signal) => {
    opens++;
    const connection = {
      usable: true,
      exec: async () => { executions++; return '/home/test'; },
      read: async () => { reads++; return Buffer.from(JSON.stringify({ port: 47831, token: 'a'.repeat(64) })); },
      api: async () => { if (fail) throw new Error('disconnected'); return { ok: true }; },
      close: () => { closed++; connection.usable = false; },
    };
    signal.addEventListener('abort', connection.close, { once: true });
    return connection;
  });
  const deployment = new NotesServerDeployment(settings(), '/unused', '0.3.91', false);
  t.after(() => deployment.cancel());
  await deployment.api('/v1/health'); await deployment.api('/v1/workspace');
  assert.deepEqual([opens, reads, executions], [1, 1, 1]);
  fail = true; await assert.rejects(deployment.api('/v1/transactions', {}), /disconnected/);
  assert.equal(closed, 1);
  fail = false; await deployment.api('/v1/health'); assert.equal(opens, 2);
  deployment.cancel(); await deployment.api('/v1/health'); assert.equal(opens, 3);
});

test('cancelling an in-flight connection never silently opens a replacement', async t => {
  let release;
  let opens = 0;
  t.mock.method(NotesServerConnection, 'open', () => { opens++; return new Promise(resolve => { release = resolve; }); });
  const deployment = new NotesServerDeployment(settings(), '/unused', '0.3.91', false);
  const request = deployment.api('/v1/health');
  deployment.cancel();
  release({ usable: false, close() {}, exec: async () => '/home/test', read: async () => Buffer.from(JSON.stringify({ port: 47831, token: 'a'.repeat(64) })) });
  await assert.rejects(request, /cancelled/);
  assert.equal(opens, 1);
});

test('a newer desktop automatically upgrades only its matching older server and verifies identity', async t => {
  const deployment = new NotesServerDeployment(settings(), '/unused', '0.3.91', false);
  let health = { version: '0.3.90', protocol: 1, instanceId: 'instance', revision: 12 };
  let upgrades = 0;
  t.mock.method(deployment, 'api', async () => health);
  t.mock.method(deployment, 'deploy', async () => { upgrades++; health = { ...health, version: '0.3.91' }; });
  assert.equal((await deployment.health()).version, '0.3.91');
  await deployment.health(); assert.equal(upgrades, 1);
});

test('automatic upgrades never downgrade or replace an unknown database', async t => {
  for (const remote of [
    { version: '0.3.92', instanceId: 'instance' }, { version: '0.3.91', instanceId: 'instance' },
    { version: '0.3.90', instanceId: 'different' }, { version: 'development', instanceId: 'instance' },
  ]) {
    const deployment = new NotesServerDeployment(settings(), '/unused', '0.3.91', false);
    t.mock.method(deployment, 'api', async () => ({ protocol: 1, revision: 1, ...remote }));
    t.mock.method(deployment, 'deploy', async () => { assert.fail('Unexpected deployment'); });
    await deployment.health();
  }
});

test('failed automatic upgrades are attempted once per launch and cannot claim success', async t => {
  const deployment = new NotesServerDeployment(settings(), '/unused', '0.3.91', false);
  t.mock.method(deployment, 'api', async () => ({ version: '0.3.90', protocol: 1, instanceId: 'instance', revision: 12 }));
  let upgrades = 0;
  t.mock.method(deployment, 'deploy', async () => { upgrades++; throw new Error('backup failed'); });
  await assert.rejects(deployment.health(), /backup failed/);
  assert.equal((await deployment.health()).version, '0.3.90');
  assert.equal(upgrades, 1);
});

test('schema-compatible rollback restores the program without overwriting newer note commits', async () => {
  const deployment = new NotesServerDeployment(settings(), '/unused', '0.3.91', false);
  const base = '/home/test/.local/share/service-manager-notes';
  const commands = [];
  const connection = {
    exec: async command => { commands.push(command); return commands.length === 1 ? 'yes' : ''; },
    read: async () => Buffer.from(JSON.stringify({ previous: `${base}/releases/old`, backup: `${base}/data/backups/upgrade.sqlite3`, config: '{}', unit: 'old', preserveDatabase: true })),
    write: async () => {},
  };
  await deployment.restoreUpgrade(connection, base);
  assert.ok(commands.some(command => command.includes('systemctl --user stop')));
  assert.ok(commands.some(command => command.includes('ln -sfn')));
  assert.ok(commands.every(command => !command.includes('cp --') && !command.includes('notes.sqlite3-wal')));
});
