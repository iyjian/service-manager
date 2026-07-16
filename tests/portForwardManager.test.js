const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const net = require('node:net');
const test = require('node:test');

const { PortForwardManager } = require('../dist/main/portForwardManager.js');

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function completeWithin(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('operation timed out')), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function fakeClient() {
  const client = new EventEmitter();
  client.endCount = 0;
  client.end = () => { client.endCount += 1; };
  client.forwardOut = () => { throw new Error('No local client was expected.'); };
  return client;
}

function hostConfig() {
  return {
    id: 'host-1',
    name: 'Host',
    sshHost: 'example.test',
    sshPort: 22,
    username: 'tester',
    authType: 'password',
    password: 'secret',
    jumpHosts: [],
    forwards: [],
    services: [],
  };
}

function serviceConfig(forwardLocalPort) {
  return {
    id: 'service-1',
    name: 'Service',
    startCommand: 'run',
    port: 3000,
    forwardLocalPort,
  };
}

async function unusedLocalPort() {
  const server = net.createServer();
  await listen(server);
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await close(server);
  return address.port;
}

test('PortForwardManager stop destroys owned active sockets before waiting for server close', async (t) => {
  const server = net.createServer();
  await listen(server);
  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  const accepted = new Promise((resolve) => server.once('connection', resolve));
  const client = net.connect(address.port, '127.0.0.1');
  t.after(() => client.destroy());
  const serverSocket = await accepted;
  const sockets = new Set([serverSocket]);
  serverSocket.once('close', () => sockets.delete(serverSocket));

  let targetEndCount = 0;
  const manager = new PortForwardManager();
  manager.running.set('forward-1', {
    targetClient: { end: () => { targetEndCount += 1; } },
    jumpClients: [],
    server,
    sockets,
    localPort: address.port,
  });

  await completeWithin(manager.stop('forward-1'), 1_000);

  assert.equal(serverSocket.destroyed, true);
  assert.equal(targetEndCount, 1);
  assert.equal(manager.running.size, 0);
});

test('PortForwardManager releases SSH clients when the local listen fails', async (t) => {
  const occupied = net.createServer();
  await listen(occupied);
  t.after(() => occupied.close());
  const address = occupied.address();
  assert.ok(address && typeof address !== 'string');

  let targetEndCount = 0;
  let jumpEndCount = 0;
  const connect = async () => ({
    targetClient: { end: () => { targetEndCount += 1; } },
    jumpClients: [{ end: () => { jumpEndCount += 1; } }],
    allClients: [],
  });
  const manager = new PortForwardManager(connect);

  await assert.rejects(
    manager.start(
      'forward-1',
      hostConfig(),
      serviceConfig(address.port),
    ),
    (error) => error && error.code === 'EADDRINUSE',
  );

  assert.equal(targetEndCount, 1);
  assert.equal(jumpEndCount, 1);
  assert.equal(manager.running.size, 0);
});

test('PortForwardManager closes a local socket when SSH forwardOut throws synchronously', async (t) => {
  const target = fakeClient();
  const connect = async () => ({
    targetClient: target,
    jumpClients: [],
    allClients: [target],
  });
  const manager = new PortForwardManager(connect);
  t.after(() => manager.shutdown());
  const port = await unusedLocalPort();
  await manager.start('forward-1', hostConfig(), serviceConfig(port));

  const socket = net.connect(port, '127.0.0.1');
  socket.on('error', () => undefined);
  await Promise.race([
    new Promise((resolve) => socket.once('close', resolve)),
    new Promise((_, reject) => setTimeout(() => reject(new Error('local socket remained open')), 1_000)),
  ]);

  assert.equal(socket.destroyed, true);
  assert.equal(manager.running.size, 1);
  await manager.shutdown();
  assert.equal(target.endCount, 1);
});

test('PortForwardManager stopAll fences a late connect, deduplicates the start, and remains reusable', async (t) => {
  const firstConnection = deferred();
  const firstTarget = fakeClient();
  const firstJump = fakeClient();
  const secondTarget = fakeClient();
  const secondJump = fakeClient();
  let connectCount = 0;
  const connect = async () => {
    connectCount += 1;
    if (connectCount === 1) {
      return firstConnection.promise;
    }
    return {
      targetClient: secondTarget,
      jumpClients: [secondJump],
      allClients: [secondJump, secondTarget],
    };
  };
  let serverCreateCount = 0;
  const createServer = (listener) => {
    serverCreateCount += 1;
    return net.createServer(listener);
  };
  const manager = new PortForwardManager(connect, createServer);
  t.after(() => manager.stopAll());
  const port = await unusedLocalPort();
  const host = hostConfig();
  const service = serviceConfig(port);

  const first = manager.start('forward-1', host, service);
  const duplicate = manager.start('forward-1', host, service);
  assert.equal(first, duplicate);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(connectCount, 1);

  let stopSettled = false;
  const stopping = manager.stopAll().then(() => { stopSettled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopSettled, false);

  firstConnection.resolve({
    targetClient: firstTarget,
    jumpClients: [firstJump],
    allClients: [firstJump, firstTarget],
  });
  const starts = await Promise.allSettled([first, duplicate]);
  await stopping;

  assert.equal(starts.every((result) => result.status === 'rejected'), true);
  assert.match(starts[0].reason.message, /cancelled/i);
  assert.equal(serverCreateCount, 0);
  assert.equal(firstTarget.endCount, 1);
  assert.equal(firstJump.endCount, 1);
  assert.equal(manager.running.size, 0);

  await manager.start('forward-1', host, service);
  assert.equal(connectCount, 2);
  assert.equal(serverCreateCount, 1);
  assert.equal(manager.running.size, 1);

  const shutdown = manager.shutdown();
  await assert.rejects(
    manager.start('forward-2', host, service),
    /shut down/i,
  );
  await shutdown;
  assert.equal(secondTarget.endCount, 1);
  assert.equal(secondJump.endCount, 1);
  assert.equal(connectCount, 2);
  assert.equal(serverCreateCount, 1);
  assert.equal(manager.running.size, 0);
});
