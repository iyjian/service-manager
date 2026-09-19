const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const { Duplex, PassThrough } = require('node:stream');
const { generateKeyPairSync } = require('node:crypto');
const net = require('node:net');
const test = require('node:test');
const { Server } = require('ssh2');
const { SshTerminalRuntime, sshConnectionFingerprint } = require('../dist/main/ssh/sshTerminalRuntime');
const { connectSshChain } = require('../dist/main/ssh/sshChain');

const host = (id = 'host-a') => ({
  id, name: id, sshHost: '127.0.0.1', sshPort: 22, username: 'test',
  authType: 'password', password: 'test-password', jumpHosts: [], services: [], forwards: [],
});
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function until(predicate) {
  for (let i = 0; i < 150; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail('Timed out waiting for SSH test state');
}

function fakeConnection() {
  const input = [];
  const channel = new Duplex({ read() {}, write(chunk, _encoding, done) { input.push(chunk.toString()); done(); } });
  channel.stderr = new PassThrough();
  channel.windows = [];
  channel.setWindow = (...size) => channel.windows.push(size);
  const client = new EventEmitter();
  client.destroyed = false;
  client.destroy = () => { if (!client.destroyed) { client.destroyed = true; client.emit('close'); } };
  client.shell = (size, callback) => { client.pty = size; callback(undefined, channel); };
  return { input, channel, client, chain: { targetClient: client, allClients: [client], jumpClients: [] } };
}

function fixture(extra = {}) {
  const states = [], outputs = [], connections = [];
  const hosts = [host(), host('host-b')];
  const runtime = new SshTerminalRuntime({
    getHost: (id) => hosts.find((value) => value.id === id),
    state: (owner, state) => states.push({ owner, ...state }),
    output: (owner, output) => outputs.push({ owner, ...output }),
    connect: async () => { const connection = fakeConnection(); connections.push(connection); return connection.chain; },
    ...extra,
  });
  return { runtime, hosts, states, outputs, connections };
}

test('independent SSH sessions preserve exact input, resize and restrict every operation to their owner', async (t) => {
  const f = fixture(); t.after(() => f.runtime.shutdown());
  f.runtime.open(1, 'host-a', 'one'); f.runtime.open(1, 'host-a', 'two');
  await tick();
  assert.equal(f.connections.length, 2);
  const input = '  中文\r\x1b[A\t\x03';
  f.runtime.write(1, 'one', input);
  f.runtime.resize(1, 'one', 140, 35);
  assert.deepEqual(f.connections[0].input, [input]);
  assert.deepEqual(f.connections[0].channel.windows, [[35, 140, 0, 0]]);
  assert.deepEqual(f.connections[1].input, []);
  for (const operation of [
    () => f.runtime.write(2, 'one', 'x'), () => f.runtime.resize(2, 'one', 80, 24),
    () => f.runtime.close(2, 'one'), () => f.runtime.acknowledge(2, 'one', 1),
  ]) assert.throws(operation, /another window/);
  f.runtime.close(1, 'one');
  assert.equal(f.connections[0].client.destroyed, true);
  assert.equal(f.connections[1].client.destroyed, false);
  assert.ok(f.states.every((state) => !JSON.stringify(state).includes('test-password')));
});

test('stream decoding preserves split UTF-8 and backpressure resumes only after renderer consumption', async (t) => {
  const f = fixture(); t.after(() => f.runtime.shutdown()); f.runtime.open(1, 'host-a', 'one'); await tick();
  const { channel } = f.connections[0];
  const bytes = Buffer.from('中文🙂');
  channel.emit('data', bytes.subarray(0, 2));
  channel.stderr.emit('data', Buffer.from('stderr'));
  channel.emit('data', bytes.subarray(2));
  assert.equal(f.outputs.map((output) => output.data).join(''), 'stderr中文🙂');
  const beforeEmoji = f.outputs.length;
  channel.emit('data', Buffer.from('x'.repeat(16383) + '🙂'));
  assert.deepEqual(f.outputs.slice(beforeEmoji).map((output) => output.data), ['x'.repeat(16383), '🙂']);
  channel.emit('data', Buffer.alloc(140 * 1024, 120));
  assert.ok(f.outputs.every((output) => output.data.length <= 16384));
  assert.equal(channel.isPaused(), true);
  for (const output of f.outputs) f.runtime.acknowledge(1, 'one', output.data.length);
  assert.equal(channel.isPaused(), false);
  const count = f.outputs.length;
  f.runtime.close(1, 'one'); channel.emit('data', Buffer.from('late'));
  assert.equal(f.outputs.length, count);
});

test('remote shell closure is distinct from transport loss and releases only that session', async (t) => {
  const f = fixture(); t.after(() => f.runtime.shutdown());
  f.runtime.open(1, 'host-a', 'one'); f.runtime.open(1, 'host-a', 'two'); await tick();
  f.runtime.write(1, 'one', 'exit\r');
  assert.equal(f.connections[0].client.destroyed, false, 'input alone cannot prove a shell has ended');
  f.connections[0].channel.emit('close', 1);
  assert.deepEqual(f.states.filter((state) => state.id === 'one' && state.state === 'closed'), [
    { owner: 1, id: 'one', hostId: 'host-a', state: 'closed', error: undefined, closeReason: 'shell-exit' },
  ]);
  assert.equal(f.connections[0].client.destroyed, true);
  assert.equal(f.connections[1].client.destroyed, false);
  f.connections[1].client.destroy();
  await tick();
  const disconnected = f.states.find((state) => state.id === 'two' && state.state === 'closed');
  assert.equal(disconnected.closeReason, undefined);
  assert.match(disconnected.error, /connection closed/);
  f.runtime.open(1, 'host-a', 'three'); await tick();
  f.connections[2].channel.emit('exit', 0);
  f.connections[2].channel.emit('close', 0);
  assert.equal(f.connections[2].client.destroyed, true);
  assert.deepEqual(f.states.filter((state) => state.id === 'three' && state.state === 'closed'), [
    { owner: 1, id: 'three', hostId: 'host-a', state: 'closed', error: undefined, closeReason: 'shell-exit' },
  ]);
});

test('closing a pending connection cancels its signal and disposes a late successful chain', async () => {
  let complete, signal;
  const f = fixture({ connect: (_host, abortSignal) => { signal = abortSignal; return new Promise((resolve) => { complete = resolve; }); } });
  f.runtime.open(1, 'host-a', 'one'); f.runtime.close(1, 'one');
  assert.equal(signal.aborted, true);
  const connection = fakeConnection(); complete(connection.chain); await tick();
  assert.equal(connection.client.destroyed, true);
  assert.deepEqual(f.states.map((value) => value.state), ['closed']);
  f.runtime.shutdown();
});

test('timeout includes shell startup, errors are display safe, and final state is published once', async () => {
  const f = fixture({ timeoutMs: 20, connect: async () => {
    const connection = fakeConnection(); connection.client.shell = () => undefined; return connection.chain;
  } });
  f.runtime.open(1, 'host-a', 'one');
  await until(() => f.states.length > 0);
  assert.match(f.states[0].error, /timed out/);
  f.runtime.close(1, 'one'); f.runtime.shutdown();
  assert.equal(f.states.length, 1);
  const bad = fixture({ connect: async () => { throw new Error('server echoed PRIVATE_SECRET'); } });
  bad.runtime.open(1, 'host-a', 'bad'); await tick();
  assert.equal(bad.states[0].state, 'error');
  assert.doesNotMatch(JSON.stringify(bad.states), /PRIVATE_SECRET/);
  bad.runtime.shutdown();
});

test('host rename and service edits retain sessions; changed connections, deletions and owner loss close exact sessions', async (t) => {
  const f = fixture(); t.after(() => f.runtime.shutdown());
  f.runtime.open(1, 'host-a', 'one'); f.runtime.open(2, 'host-b', 'two'); await tick();
  const renamed = { ...f.hosts[0], name: 'Renamed', services: [{ id: 'service' }] };
  assert.equal(sshConnectionFingerprint(renamed), sshConnectionFingerprint(f.hosts[0]));
  f.runtime.reconcileHosts([renamed, f.hosts[1]]);
  assert.equal(f.connections[0].client.destroyed, false);
  f.runtime.reconcileHosts([{ ...renamed, password: 'new-password' }, f.hosts[1]]);
  assert.equal(f.connections[0].client.destroyed, true);
  assert.equal(f.connections[1].client.destroyed, false);
  f.runtime.closeOwner(1);
  assert.equal(f.connections[1].client.destroyed, false);
  f.runtime.reconcileHosts([]);
  assert.equal(f.connections[1].client.destroyed, true);
});

test('SSH rejects malformed identifiers, oversized input and invalid dimensions', async (t) => {
  const f = fixture(); t.after(() => f.runtime.shutdown());
  assert.throws(() => f.runtime.open(1, '', 'one'));
  assert.throws(() => f.runtime.open(1, 'missing', 'one'));
  f.runtime.open(1, 'host-a', 'one'); await tick();
  for (const data of ['', null, 'x'.repeat(65537)]) assert.throws(() => f.runtime.write(1, 'one', data));
  for (const size of [[0, 2], [2.5, 2], [2, Infinity], ['80', 24], [1001, 24]]) {
    assert.throws(() => f.runtime.resize(1, 'one', ...size));
  }
  assert.throws(() => f.runtime.acknowledge(1, 'one', -1));
});

test('SSH chain cancellation before the first microtask never starts a socket; stalled handshakes time out and release sockets', async (t) => {
  const sockets = new Set();
  let accepts = 0;
  const server = net.createServer((socket) => {
    accepts += 1; sockets.add(socket); socket.on('error', () => undefined);
    socket.on('data', () => undefined); socket.on('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise((resolve) => server.close(resolve)); });
  const endpoint = { ...host(), sshPort: server.address().port };
  const controller = new AbortController();
  const pending = connectSshChain(endpoint, [], { signal: controller.signal, readyTimeout: 100 });
  controller.abort();
  await assert.rejects(pending, /cancelled/);
  await tick();
  assert.equal(accepts, 0);
  await assert.rejects(connectSshChain(endpoint, [], { readyTimeout: 30 }), /timed out|timeout/i);
  await until(() => accepts === 1 && sockets.size === 0);
  const activeController = new AbortController();
  const active = connectSshChain(endpoint, [], { signal: activeController.signal, readyTimeout: 1000 });
  const rejected = assert.rejects(active, /cancelled/);
  await until(() => sockets.size === 1);
  activeController.abort(); await rejected;
  await until(() => sockets.size === 0);
});

test('ssh2 connects to a local password/key SSH server through two jump hosts and opens a PTY', async (t) => {
  const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
  const encryptedKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'key-passphrase' });
  const clients = new Set(), inputs = [], sizes = [];
  const server = new Server({ hostKeys: [privateKey] }, (client) => {
    clients.add(client); client.on('error', () => undefined); client.on('close', () => clients.delete(client));
    client.on('authentication', (ctx) => {
      if ((ctx.method === 'password' && ctx.password === 'test-password') || ctx.method === 'publickey') ctx.accept();
      else ctx.reject();
    });
    client.on('ready', () => {
      client.on('tcpip', (accept, reject, info) => {
        const socket = net.connect(info.destPort, info.destIP, () => { const stream = accept(); stream.pipe(socket).pipe(stream); });
        socket.on('error', () => reject());
      });
      client.on('session', (accept) => {
        const session = accept();
        session.on('pty', (acceptPty, _reject, size) => { sizes.push(size); acceptPty(); });
        session.on('window-change', (_accept, _reject, size) => sizes.push(size));
        session.on('shell', (acceptShell) => {
          const stream = acceptShell(); stream.write('Welcome 中文\r\n$ ');
          stream.on('data', (data) => { inputs.push(data.toString()); stream.write(data); });
        });
      });
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const endpoint = { ...host(), sshPort: server.address().port };
  const keyHost = { ...endpoint, id: 'key', authType: 'privateKey', password: undefined, privateKey: encryptedKey, passphrase: 'key-passphrase' };
  const jumped = { ...endpoint, id: 'jumped', jumpHosts: [endpoint, endpoint] };
  const states = [], outputs = [];
  const runtime = new SshTerminalRuntime({
    getHost: (id) => [endpoint, keyHost, jumped].find((value) => value.id === id),
    state: (_owner, state) => states.push(state), output: (_owner, output) => outputs.push(output),
  });
  t.after(async () => { runtime.shutdown(); for (const client of clients) client.end(); await new Promise((resolve) => server.close(resolve)); });
  for (const value of [endpoint, keyHost, jumped]) runtime.open(1, value.id, value.id);
  await until(() => states.filter((state) => state.state === 'open').length === 3);
  await until(() => outputs.filter((value) => value.data.includes('Welcome')).length === 3);
  runtime.write(1, 'jumped', '  中文\r\x1b[A\t\x03'); runtime.resize(1, 'jumped', 120, 40);
  await until(() => inputs.length === 1 && sizes.some((size) => size.cols === 120 && size.rows === 40));
  assert.equal(inputs[0], '  中文\r\x1b[A\t\x03');
  assert.ok(sizes.some((size) => size.term === 'xterm-256color'));
});
