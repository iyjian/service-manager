const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { RuntimeLogWriter, createRuntimeLogEntry } = require('../dist/main/core/runtimeLog');

test('createRuntimeLogEntry redacts sensitive and command context-key variants', () => {
  const entry = JSON.parse(createRuntimeLogEntry('service:diagnostic', new Error('failed'), {
    db_password: 'database password value',
    apiToken: 'api token value',
    'client-secret': 'client secret value',
    sshPrivateKey: 'private key value',
    startCommand: 'pnpm run start',
    remoteCommand: 'node remote-server.js',
    shellCommand: 'bash -lc diagnostic-command',
    hostId: 'host-1',
  }, new Date('2026-07-12T00:00:00.000Z')));

  assert.equal(entry.context.db_password, '[redacted]');
  assert.equal(entry.context.apiToken, '[redacted]');
  assert.equal(entry.context['client-secret'], '[redacted]');
  assert.equal(entry.context.sshPrivateKey, '[redacted]');
  assert.equal(entry.context.startCommand, '[redacted]');
  assert.equal(entry.context.remoteCommand, '[redacted]');
  assert.equal(entry.context.shellCommand, '[redacted]');
  assert.equal(entry.context.hostId, 'host-1');
  assert.doesNotMatch(JSON.stringify(entry), /database password value|api token value|client secret value|private key value|pnpm run start|node remote-server\.js|diagnostic-command/);
});

test('createRuntimeLogEntry redacts complete whitespace-bearing secret assignments through delimiters', () => {
  const entry = JSON.parse(createRuntimeLogEntry(
    'service:diagnostic',
    new Error('apiToken=alpha bravo charlie, client-secret=delta echo foxtrot; db_password=golf hotel india\npassword=juliet kilo lima'),
  ));

  assert.match(entry.message, /apiToken=\[redacted\],/i);
  assert.match(entry.message, /client-secret=\[redacted\];/i);
  assert.match(entry.message, /db_password=\[redacted\]\n/i);
  assert.match(entry.message, /password=\[redacted\]$/i);
  assert.doesNotMatch(entry.message, /alpha|bravo|charlie|delta|echo|foxtrot|golf|hotel|india|juliet|kilo|lima/i);
});

test('createRuntimeLogEntry redacts credentials in every URI scheme', () => {
  const entry = JSON.parse(createRuntimeLogEntry(
    'service:diagnostic',
    new Error('ssh://deploy:ssh-password@ssh.example.invalid/repo ftp://user:ftp-password@ftp.example.invalid/archive git+ssh://git:git-password@git.example.invalid/project'),
  ));

  assert.match(entry.message, /\[redacted-url\]/g);
  assert.doesNotMatch(entry.message, /deploy|ssh-password|ssh\.example\.invalid|user|ftp-password|ftp\.example\.invalid|git-password|git\.example\.invalid/);
});

test('createRuntimeLogEntry redacts opaque URIs without changing ordinary text', () => {
  const entry = JSON.parse(createRuntimeLogEntry(
    'service:diagnostic',
    new Error('data:text/plain;base64,opaque-data-secret mailto:owner@example.invalid?token=opaque-mail-secret urn:example:opaque-urn-secret ordinary diagnostic text remains visible'),
  ));

  assert.match(entry.message, /\[redacted-url\]/g);
  assert.match(entry.message, /ordinary diagnostic text remains visible/);
  assert.doesNotMatch(entry.message, /data:|opaque-data-secret|mailto:|owner@example\.invalid|opaque-mail-secret|urn:|opaque-urn-secret/);
});

test('createRuntimeLogEntry redacts complete quoted secret assignments containing escaped quotes', () => {
  const entry = JSON.parse(createRuntimeLogEntry(
    'service:diagnostic',
    new Error('password="alpha \\"bravo\\" charlie" token=\'delta \\\'echo\\\' foxtrot\''),
  ));

  assert.match(entry.message, /password=\[redacted\]/i);
  assert.match(entry.message, /token=\[redacted\]/i);
  assert.doesNotMatch(entry.message, /alpha|bravo|charlie|delta|echo|foxtrot/i);
});

test('createRuntimeLogEntry redacts standard command-failure output while preserving ordinary diagnostics', () => {
  const commandFailure = JSON.parse(createRuntimeLogEntry(
    'service:diagnostic',
    new Error('Command failed: pnpm run serve --token secret'),
  ));
  const diagnostic = JSON.parse(createRuntimeLogEntry(
    'service:diagnostic',
    new Error('Remote service status probe timed out after 30 seconds'),
  ));

  assert.match(commandFailure.message, /^Command failed: \[redacted-command\]$/);
  assert.doesNotMatch(commandFailure.message, /pnpm run serve|--token|secret/);
  assert.equal(diagnostic.message, 'Remote service status probe timed out after 30 seconds');
});

test('createRuntimeLogEntry redacts flag-style secrets and systemd command-failure tails', () => {
  const entry = JSON.parse(createRuntimeLogEntry(
    'service:diagnostic',
    new Error('systemd-run failed: pnpm run serve --token supersecret --api-token=another-secret'),
  ));

  assert.equal(entry.message, 'systemd-run failed: [redacted-command]');
  assert.doesNotMatch(entry.message, /pnpm run serve|--token|supersecret|api-token|another-secret/i);
});

test('createRuntimeLogEntry sanitizes unsafe context property names and caps safe keys', () => {
  const longSafeKey = `diagnostic-${'x'.repeat(2100)}`;
  const entry = JSON.parse(createRuntimeLogEntry('service:diagnostic', new Error('failed'), {
    hostId: 'host-1',
    'password=key-secret': 'password value',
    'mailto:owner@example.invalid': 'ordinary value',
    [longSafeKey]: 'long-key value',
  }));

  assert.equal(entry.context.hostId, 'host-1');
  assert.equal(entry.context['password=[redacted]'], '[redacted]');
  assert.equal(entry.context['[redacted-url]'], 'ordinary value');
  assert.equal(entry.context[longSafeKey.slice(0, 2000)], 'long-key value');
  assert.ok(Object.keys(entry.context).every((key) => key.length <= 2000));
  assert.doesNotMatch(JSON.stringify(entry), /key-secret|mailto:|owner@example\.invalid/);
});

test('RuntimeLogWriter persists a sanitized JSONL runtime error', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'service-manager-log-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const writer = new RuntimeLogWriter(directory, { now: () => new Date('2026-07-12T00:00:00.000Z') });

  await writer.record('service:refresh', new Error('Bearer abc https://example.invalid/sub?token=secret'), {
    hostId: 'host-1',
    password: 'not-for-disk',
  });
  await writer.flush();

  const entry = JSON.parse(await fs.readFile(path.join(directory, 'runtime.jsonl'), 'utf8'));
  assert.equal(entry.timestamp, '2026-07-12T00:00:00.000Z');
  assert.equal(entry.context.hostId, 'host-1');
  assert.equal(entry.context.password, '[redacted]');
  assert.doesNotMatch(JSON.stringify(entry), /abc|example\.invalid|not-for-disk/);
});

test('RuntimeLogWriter redacts private keys, URLs, exact secret assignments, and command assignments from errors', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'service-manager-log-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const writer = new RuntimeLogWriter(directory);
  const privateKey = '-----BEGIN OPENSSH PRIVATE KEY-----\nprivate-key-material\n-----END OPENSSH PRIVATE KEY-----';

  await writer.record('service:start', new Error(
    `${privateKey} https://example.invalid/subscription password=password-value; token=token-value; secret=secret-value; db_password=db-password-value; apiToken=api-token-value; client-secret=client-secret-value; command=pnpm run service; serviceCommand='node server.js --port 8080'`,
  ));
  await writer.flush();

  const entry = JSON.parse(await fs.readFile(path.join(directory, 'runtime.jsonl'), 'utf8'));
  assert.doesNotMatch(JSON.stringify(entry), /private-key-material|example\.invalid|password-value|token-value|secret-value|db-password-value|api-token-value|client-secret-value|pnpm run service|node server\.js/);
  assert.match(entry.message, /password=\[redacted\]/i);
  assert.match(entry.message, /token=\[redacted\]/i);
  assert.match(entry.message, /secret=\[redacted\]/i);
  assert.match(entry.message, /command=\[redacted\]/i);
  assert.match(entry.message, /serviceCommand=\[redacted\]/i);
});

test('RuntimeLogWriter redacts command context and omits structured context values', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'service-manager-log-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const writer = new RuntimeLogWriter(directory);

  await writer.record('service:start', new Error('start failed'), {
    command: 'pnpm run service',
    serviceCommand: 'node server.js --port 8080',
    nested: { token: 'object-secret' },
    arguments: ['--token', 'array-secret'],
  });
  await writer.flush();

  const entry = JSON.parse(await fs.readFile(path.join(directory, 'runtime.jsonl'), 'utf8'));
  assert.equal(entry.context.command, '[redacted]');
  assert.equal(entry.context.serviceCommand, '[redacted]');
  assert.equal(entry.context.nested, '[omitted]');
  assert.equal(entry.context.arguments, '[omitted]');
  assert.doesNotMatch(JSON.stringify(entry), /pnpm run service|node server\.js|object-secret|array-secret/);
});

test('RuntimeLogWriter rotates the active JSONL file before appending past its size limit', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'service-manager-log-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const writer = new RuntimeLogWriter(directory, { maxBytes: 80 });

  await writer.record('first', new Error('first diagnostic message that exceeds the test limit'));
  await writer.record('second', new Error('second diagnostic message that exceeds the test limit'));
  await writer.flush();

  const previous = await fs.readFile(path.join(directory, 'runtime.previous.jsonl'), 'utf8');
  const active = await fs.readFile(path.join(directory, 'runtime.jsonl'), 'utf8');
  assert.match(previous, /first diagnostic message/);
  assert.match(active, /second diagnostic message/);
});
