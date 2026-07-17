const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const net = require('node:net');
const test = require('node:test');

const {
  buildKubeVirtVncWebSocketPath,
  createEphemeralVncPassword,
  createVncAuthResponse,
  isMatchingKubeVirtVmi,
  loadKubernetesPackageWebSocket,
  openKubeVirtVncBridge,
  parseKubeVirtVncTargetFromPod,
} = require('../dist/main/kubernetes/kubeVirtVnc.js');

const POD = {
  metadata: {
    name: 'virt-launcher-kb-kmzyssjmw-mpvwz',
    namespace: 'kvm-builder-dev',
    uid: 'pod-uid',
    labels: {
      'kubevirt.io': 'virt-launcher',
      'kubevirt.io/created-by': 'vmi-uid',
      'vm.kubevirt.io/name': 'kb-kmzyssjmw',
    },
    annotations: {
      'kubevirt.io/domain': 'kb-kmzyssjmw',
    },
    ownerReferences: [{
      apiVersion: 'kubevirt.io/v1',
      kind: 'VirtualMachineInstance',
      name: 'kb-kmzyssjmw',
      uid: 'vmi-uid',
      controller: true,
    }],
  },
  status: { phase: 'Running' },
};

const TARGET = {
  namespace: 'kvm-builder-dev',
  podName: 'virt-launcher-kb-kmzyssjmw-mpvwz',
  podUid: 'pod-uid',
  vmiName: 'kb-kmzyssjmw',
  vmiUid: 'vmi-uid',
};

function connect(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

class SocketReader {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.pending = [];
    this.closed = false;
    this.error = undefined;
    this.onData = (data) => {
      this.buffer = Buffer.concat([this.buffer, data]);
      this.pump();
    };
    this.onError = (error) => {
      this.error = error;
      this.rejectPending(error);
    };
    this.onClose = () => {
      this.closed = true;
      this.rejectPending(this.error ?? new Error('Socket closed before enough data arrived.'));
    };
    socket.on('data', this.onData);
    socket.on('error', this.onError);
    socket.on('close', this.onClose);
  }

  read(length) {
    assert.ok(Number.isInteger(length) && length >= 0);
    if (length === 0) return Promise.resolve(Buffer.alloc(0));
    if (this.buffer.length >= length) {
      const value = Buffer.from(this.buffer.subarray(0, length));
      this.buffer = this.buffer.subarray(length);
      return Promise.resolve(value);
    }
    if (this.closed) {
      return Promise.reject(this.error ?? new Error('Socket is closed.'));
    }
    return new Promise((resolve, reject) => {
      this.pending.push({ length, resolve, reject });
      this.pump();
    });
  }

  pump() {
    while (this.pending.length > 0 && this.buffer.length >= this.pending[0].length) {
      const pending = this.pending.shift();
      const value = Buffer.from(this.buffer.subarray(0, pending.length));
      this.buffer = this.buffer.subarray(pending.length);
      pending.resolve(value);
    }
  }

  rejectPending(error) {
    for (const pending of this.pending.splice(0)) pending.reject(error);
  }

  dispose() {
    this.socket.off('data', this.onData);
    this.socket.off('error', this.onError);
    this.socket.off('close', this.onClose);
    this.rejectPending(new Error('Socket reader disposed.'));
  }
}

function waitForSocketClose(socket) {
  if (socket.destroyed) return Promise.resolve();
  return new Promise((resolve) => socket.once('close', resolve));
}

function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) {
        resolve();
      } else if (Date.now() >= deadline) {
        reject(new Error('Timed out waiting for condition.'));
      } else {
        setTimeout(check, 2);
      }
    };
    check();
  });
}

class FakeWebSocket extends EventEmitter {
  constructor() {
    super();
    this.protocol = 'plain.kubevirt.io';
    this.readyState = 0;
    this.sent = [];
    this.closeCount = 0;
    this.terminateCount = 0;
  }

  send(data, options, callback) {
    this.sent.push({ data: Buffer.from(data), options });
    callback();
  }

  close() {
    this.closeCount += 1;
    this.readyState = 3;
  }

  terminate() {
    this.terminateCount += 1;
    this.readyState = 3;
  }
}

class RfbNoneWebSocket extends FakeWebSocket {
  constructor(minor = 8) {
    super();
    this.minor = minor;
    this.handshakeState = 'version';
    this.protocolErrors = [];
    this.applicationData = [];
    queueMicrotask(() => {
      if (this.readyState === 3) return;
      this.readyState = 1;
      this.emit('open');
      this.emitBinary(Buffer.from(`RFB 003.${String(minor).padStart(3, '0')}\n`, 'ascii'));
    });
  }

  emitBinary(data) {
    queueMicrotask(() => {
      if (this.readyState === 1) this.emit('message', Buffer.from(data), true);
    });
  }

  send(data, options, callback) {
    const buffer = Buffer.from(data);
    super.send(buffer, options, callback);
    if (this.handshakeState === 'version') {
      const expected = Buffer.from(`RFB 003.${String(this.minor).padStart(3, '0')}\n`, 'ascii');
      if (!buffer.equals(expected)) {
        this.protocolErrors.push(`unexpected version ${buffer.toString('hex')}`);
        return;
      }
      if (this.minor === 3) {
        const securityType = Buffer.alloc(4);
        securityType.writeUInt32BE(1);
        this.handshakeState = 'application';
        this.emitBinary(securityType);
      } else {
        this.handshakeState = 'security-selection';
        // Include an unsupported alternative to prove the bridge explicitly
        // selects SecurityType None instead of relying on list position.
        this.emitBinary(Buffer.from([2, 2, 1]));
      }
      return;
    }
    if (this.handshakeState === 'security-selection') {
      if (!buffer.equals(Buffer.from([1]))) {
        this.protocolErrors.push(`unexpected security selection ${buffer.toString('hex')}`);
        return;
      }
      this.handshakeState = 'application';
      if (this.minor === 8) this.emitBinary(Buffer.alloc(4));
      return;
    }
    this.applicationData.push(buffer);
  }

  pushServerData(data) {
    assert.equal(this.handshakeState, 'application');
    this.emitBinary(data);
  }
}

function kubeConfig() {
  return {
    getCurrentCluster: () => ({ server: 'https://cluster.example.test/prefix/' }),
    applyToHTTPSOptions: async (options) => {
      options.headers = { Authorization: 'Bearer test-only' };
      options.rejectUnauthorized = false;
    },
  };
}

test('parseKubeVirtVncTargetFromPod requires a running UID-linked virt-launcher owner', () => {
  assert.deepEqual(parseKubeVirtVncTargetFromPod(POD), TARGET);
  assert.equal(parseKubeVirtVncTargetFromPod({
    ...POD,
    metadata: { ...POD.metadata, name: 'virt-launcher-lookalike', ownerReferences: [] },
  }), undefined);
  assert.equal(parseKubeVirtVncTargetFromPod({
    ...POD,
    metadata: {
      ...POD.metadata,
      labels: { ...POD.metadata.labels, 'kubevirt.io/created-by': 'different-vmi' },
    },
  }), undefined);
  assert.equal(parseKubeVirtVncTargetFromPod({ ...POD, status: { phase: 'Pending' } }), undefined);
  assert.equal(parseKubeVirtVncTargetFromPod({
    ...POD,
    metadata: { ...POD.metadata, deletionTimestamp: '2026-07-17T00:00:00Z' },
  }), undefined);
  assert.equal(parseKubeVirtVncTargetFromPod({
    ...POD,
    metadata: {
      ...POD.metadata,
      ownerReferences: [
        ...POD.metadata.ownerReferences,
        { apiVersion: 'apps/v1', kind: 'ReplicaSet', name: 'other', uid: 'other', controller: true },
      ],
    },
  }), undefined);
  assert.equal(parseKubeVirtVncTargetFromPod({
    ...POD,
    metadata: {
      ...POD.metadata,
      labels: {
        'kubevirt.io': 'virt-launcher',
        'kubevirt.io/created-by': 'vmi-uid',
      },
      annotations: {},
    },
  }), undefined);
});

test('isMatchingKubeVirtVmi checks identity, running phase, and graphics availability', () => {
  const vmi = {
    apiVersion: 'kubevirt.io/v1',
    kind: 'VirtualMachineInstance',
    metadata: { name: TARGET.vmiName, namespace: TARGET.namespace, uid: TARGET.vmiUid },
    spec: { domain: { devices: {} } },
    status: { phase: 'Running', activePods: { [TARGET.podUid]: 'worker-1' } },
  };
  assert.equal(isMatchingKubeVirtVmi(TARGET, vmi), true);
  assert.equal(isMatchingKubeVirtVmi(TARGET, {
    ...vmi,
    metadata: { ...vmi.metadata, uid: 'replacement-vmi' },
  }), false);
  assert.equal(isMatchingKubeVirtVmi(TARGET, {
    ...vmi,
    spec: { domain: { devices: { autoattachGraphicsDevice: false } } },
  }), false);
  assert.equal(isMatchingKubeVirtVmi(TARGET, {
    ...vmi,
    status: { phase: 'Running', activePods: { 'replacement-pod': 'worker-1' } },
  }), false);
});

test('buildKubeVirtVncWebSocketPath encodes only validated path components', () => {
  assert.equal(
    buildKubeVirtVncWebSocketPath('namespace', 'vm name/one'),
    '/apis/subresources.kubevirt.io/v1/namespaces/namespace/virtualmachineinstances/vm%20name%2Fone/vnc?preserveSession=true'
  );
  assert.equal(
    buildKubeVirtVncWebSocketPath('namespace', 'vm', false),
    '/apis/subresources.kubevirt.io/v1/namespaces/namespace/virtualmachineinstances/vm/vnc?preserveSession=false'
  );
  assert.throws(() => buildKubeVirtVncWebSocketPath(' ', 'vm'), /Namespace is invalid/);
});

test('loadKubernetesPackageWebSocket resolves ws from the client-node package scope', () => {
  assert.equal(typeof loadKubernetesPackageWebSocket(), 'function');
});

test('createVncAuthResponse matches the classic bit-reversed DES challenge vector', () => {
  const challenge = Buffer.from('a489c9790fb7c3ce2e56868c788641fc', 'hex');
  assert.equal(
    createVncAuthResponse(challenge, 'AAAAAAAA').toString('hex'),
    'd33bad35b07ef500a82329749cee9192'
  );
  assert.throws(
    () => createVncAuthResponse(Buffer.alloc(15), 'password'),
    /exactly 16 bytes/
  );
  assert.throws(
    () => createVncAuthResponse(Buffer.alloc(16), 'password9'),
    /1 to 8 printable ASCII/
  );
});

test('createEphemeralVncPassword returns eight URL-safe VNCAuth characters', () => {
  for (let index = 0; index < 16; index += 1) {
    assert.match(createEphemeralVncPassword(), /^[A-Za-z0-9_-]{8}$/);
  }
});

test('openKubeVirtVncBridge authenticates a macOS-style RFB 3.3 viewer and cleans every handle', async (t) => {
  let fakeWebSocket;
  let request;
  const errors = [];
  const viewerPassword = 'MacVNC_1';
  const bridge = await openKubeVirtVncBridge({
    kubeConfig: kubeConfig(),
    namespace: TARGET.namespace,
    vmiName: TARGET.vmiName,
    startupTimeoutMs: 1_000,
    viewerPassword,
    onError: (error) => errors.push(error.message),
    createWebSocket: (url, protocol, options) => {
      request = { url, protocol, options };
      fakeWebSocket = new RfbNoneWebSocket(8);
      return fakeWebSocket;
    },
  });
  t.after(() => bridge.close());

  const viewer = await connect(bridge.localPort);
  t.after(() => viewer.destroy());
  const reader = new SocketReader(viewer);
  t.after(() => reader.dispose());
  await bridge.connected;
  assert.equal(
    request.url,
    'wss://cluster.example.test/prefix/apis/subresources.kubevirt.io/v1/namespaces/kvm-builder-dev/virtualmachineinstances/kb-kmzyssjmw/vnc?preserveSession=true'
  );
  assert.equal(request.protocol, 'plain.kubevirt.io');
  assert.equal(request.options.headers.Authorization, 'Bearer test-only');
  assert.equal(request.options.rejectUnauthorized, false);
  assert.equal(request.options.followRedirects, false);

  assert.deepEqual(await reader.read(12), Buffer.from('RFB 003.008\n'));
  viewer.write(Buffer.from('RFB 003.003\n'));
  const securityType = await reader.read(4);
  assert.equal(securityType.readUInt32BE(0), 2);
  const challenge = await reader.read(16);
  viewer.write(createVncAuthResponse(challenge, viewerPassword));
  assert.deepEqual(await reader.read(4), Buffer.alloc(4));

  const viewerBytes = Buffer.from([0x01, 0x00, 0xff, 0x41, 0x80]);
  viewer.write(viewerBytes);
  await waitFor(() => fakeWebSocket.applicationData.length === 1);
  assert.deepEqual(fakeWebSocket.applicationData[0], viewerBytes);
  assert.deepEqual(
    fakeWebSocket.sent.slice(0, 2).map((entry) => entry.data),
    [Buffer.from('RFB 003.008\n'), Buffer.from([1])]
  );
  assert.deepEqual(fakeWebSocket.protocolErrors, []);

  const remoteBytes = Buffer.from([0x52, 0x46, 0x42, 0x20, 0x00, 0xff]);
  fakeWebSocket.pushServerData(remoteBytes);
  assert.deepEqual(await reader.read(remoteBytes.length), remoteBytes);

  await bridge.close();
  await bridge.completed;
  await waitFor(() => viewer.destroyed);
  assert.equal(viewer.destroyed, true);
  assert.equal(fakeWebSocket.closeCount, 1);
  assert.equal(fakeWebSocket.terminateCount, 1);
  assert.deepEqual(errors, []);
});

test('openKubeVirtVncBridge keeps the no-password RFB 3.8 viewer path', async (t) => {
  let fakeWebSocket;
  const bridge = await openKubeVirtVncBridge({
    kubeConfig: kubeConfig(),
    namespace: TARGET.namespace,
    vmiName: TARGET.vmiName,
    startupTimeoutMs: 1_000,
    createWebSocket: () => {
      fakeWebSocket = new RfbNoneWebSocket(8);
      return fakeWebSocket;
    },
  });
  t.after(() => bridge.close());

  const viewer = await connect(bridge.localPort);
  t.after(() => viewer.destroy());
  const reader = new SocketReader(viewer);
  t.after(() => reader.dispose());
  assert.deepEqual(await reader.read(12), Buffer.from('RFB 003.008\n'));
  viewer.write(Buffer.from('RFB 003.008\n'));
  assert.deepEqual(await reader.read(2), Buffer.from([1, 1]));
  viewer.write(Buffer.from([1]));
  assert.deepEqual(await reader.read(4), Buffer.alloc(4));

  const viewerBytes = Buffer.from([0x01, 0x05, 0x04, 0x03, 0x02]);
  viewer.write(viewerBytes);
  await waitFor(() => fakeWebSocket.applicationData.length === 1);
  assert.deepEqual(fakeWebSocket.applicationData[0], viewerBytes);
  assert.deepEqual(fakeWebSocket.protocolErrors, []);
});

test('openKubeVirtVncBridge supports the RFB 3.7 None and VNCAuth key paths', async (t) => {
  let fakeWebSocket;
  const viewerPassword = 'RFB37_pw';
  const bridge = await openKubeVirtVncBridge({
    kubeConfig: kubeConfig(),
    namespace: TARGET.namespace,
    vmiName: TARGET.vmiName,
    viewerPassword,
    startupTimeoutMs: 1_000,
    createWebSocket: () => {
      fakeWebSocket = new RfbNoneWebSocket(7);
      return fakeWebSocket;
    },
  });
  t.after(() => bridge.close());

  const viewer = await connect(bridge.localPort);
  t.after(() => viewer.destroy());
  const reader = new SocketReader(viewer);
  t.after(() => reader.dispose());
  assert.deepEqual(await reader.read(12), Buffer.from('RFB 003.008\n'));
  viewer.write(Buffer.from('RFB 003.007\n'));
  assert.deepEqual(await reader.read(2), Buffer.from([1, 2]));
  viewer.write(Buffer.from([2]));
  const challenge = await reader.read(16);
  const viewerBytes = Buffer.from([0x01, 0x07, 0x07]);
  viewer.write(Buffer.concat([
    createVncAuthResponse(challenge, viewerPassword),
    viewerBytes,
  ]));
  assert.deepEqual(await reader.read(4), Buffer.alloc(4));

  await waitFor(() => fakeWebSocket.applicationData.length === 1);
  assert.deepEqual(fakeWebSocket.applicationData[0], viewerBytes);
  assert.deepEqual(
    fakeWebSocket.sent.slice(0, 2).map((entry) => entry.data),
    [Buffer.from('RFB 003.007\n'), Buffer.from([1])]
  );
  assert.deepEqual(fakeWebSocket.protocolErrors, []);
});

test('openKubeVirtVncBridge rejects a wrong viewer password and releases all transports', async () => {
  let fakeWebSocket;
  const errors = [];
  const bridge = await openKubeVirtVncBridge({
    kubeConfig: kubeConfig(),
    namespace: TARGET.namespace,
    vmiName: TARGET.vmiName,
    viewerPassword: 'correct1',
    startupTimeoutMs: 1_000,
    onError: (error) => errors.push(error.message),
    createWebSocket: () => {
      fakeWebSocket = new RfbNoneWebSocket(8);
      return fakeWebSocket;
    },
  });

  const viewer = await connect(bridge.localPort);
  const reader = new SocketReader(viewer);
  const closed = waitForSocketClose(viewer);
  assert.deepEqual(await reader.read(12), Buffer.from('RFB 003.008\n'));
  viewer.write(Buffer.from('RFB 003.008\n'));
  assert.deepEqual(await reader.read(2), Buffer.from([1, 2]));
  viewer.write(Buffer.from([2]));
  await reader.read(16);
  viewer.write(Buffer.alloc(16));

  await bridge.completed;
  await closed;
  reader.dispose();
  assert.deepEqual(errors, ['The system VNC viewer authentication failed.']);
  assert.equal(fakeWebSocket.closeCount, 1);
  assert.equal(fakeWebSocket.terminateCount, 1);
  assert.equal(viewer.destroyed, true);
});

test('an early authenticated viewer cannot clear the independent upstream RFB timeout', async () => {
  const viewerPassword = 'early_v1';
  let server;
  let viewer;
  let reader;
  let fakeWebSocket;
  const opening = openKubeVirtVncBridge({
    kubeConfig: kubeConfig(),
    namespace: TARGET.namespace,
    vmiName: TARGET.vmiName,
    viewerPassword,
    startupTimeoutMs: 40,
    createServer: (listener) => {
      server = net.createServer(listener);
      server.once('listening', () => {
        void (async () => {
          viewer = await connect(server.address().port);
          reader = new SocketReader(viewer);
          assert.deepEqual(await reader.read(12), Buffer.from('RFB 003.008\n'));
          viewer.write(Buffer.from('RFB 003.003\n'));
          const securityType = await reader.read(4);
          assert.equal(securityType.readUInt32BE(0), 2);
          const challenge = await reader.read(16);
          viewer.write(createVncAuthResponse(challenge, viewerPassword));
          assert.deepEqual(await reader.read(4), Buffer.alloc(4));
        })();
      });
      return server;
    },
    createWebSocket: () => {
      fakeWebSocket = new FakeWebSocket();
      queueMicrotask(() => {
        fakeWebSocket.readyState = 1;
        fakeWebSocket.emit('open');
        // Deliberately never send the upstream RFB banner.
      });
      return fakeWebSocket;
    },
  });

  await assert.rejects(opening, /Timed out opening the KubeVirt VNC stream/);
  reader?.dispose();
  await waitFor(() => !!viewer?.destroyed);
  assert.equal(server.listening, false);
  assert.equal(fakeWebSocket.closeCount, 1);
  assert.equal(fakeWebSocket.terminateCount, 1);
});

test('openKubeVirtVncBridge times out an unclaimed listener and reports a safe error', async () => {
  const errors = [];
  let fakeWebSocket;
  const bridge = await openKubeVirtVncBridge({
    kubeConfig: kubeConfig(),
    namespace: TARGET.namespace,
    vmiName: TARGET.vmiName,
    startupTimeoutMs: 20,
    onError: (error) => errors.push(error.message),
    createWebSocket: () => {
      fakeWebSocket = new RfbNoneWebSocket(8);
      return fakeWebSocket;
    },
  });

  await bridge.completed;
  assert.deepEqual(errors, ['Timed out waiting for the system VNC viewer.']);
  assert.equal(fakeWebSocket.closeCount, 1);
  assert.equal(fakeWebSocket.terminateCount, 1);
});

test('openKubeVirtVncBridge rejects an upstream denial before a viewer can be launched', async () => {
  const errors = [];
  await assert.rejects(openKubeVirtVncBridge({
    kubeConfig: kubeConfig(),
    namespace: TARGET.namespace,
    vmiName: TARGET.vmiName,
    startupTimeoutMs: 1_000,
    onError: (error) => errors.push(error),
    createWebSocket: () => {
      const webSocket = new FakeWebSocket();
      queueMicrotask(() => webSocket.emit('unexpected-response', {}, {
        statusCode: 403,
        resume() {},
      }));
      return webSocket;
    },
  }), (error) => error.message === 'No permission to open this KubeVirt VNC console.'
    && error.statusCode === 403);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].statusCode, 403);
});

test('openKubeVirtVncBridge preserves only a safe transport code for Context recovery', async () => {
  await assert.rejects(openKubeVirtVncBridge({
    kubeConfig: kubeConfig(),
    namespace: TARGET.namespace,
    vmiName: TARGET.vmiName,
    startupTimeoutMs: 1_000,
    createWebSocket: () => {
      const webSocket = new FakeWebSocket();
      queueMicrotask(() => webSocket.emit('error', Object.assign(
        new Error('sensitive API URL and headers'),
        { code: 'ECONNRESET' }
      )));
      return webSocket;
    },
  }), (error) => error.message === 'Unable to open the KubeVirt VNC stream.'
    && error.code === 'ECONNRESET'
    && !error.message.includes('sensitive'));
});

test('openKubeVirtVncBridge redacts credential file errors before they cross IPC', async () => {
  await assert.rejects(openKubeVirtVncBridge({
    kubeConfig: {
      getCurrentCluster: () => ({ server: 'https://cluster.example.test' }),
      applyToHTTPSOptions: async () => {
        throw Object.assign(new Error('ENOENT /Users/example/.kube/private-client.key'), { code: 'ENOENT' });
      },
    },
    namespace: TARGET.namespace,
    vmiName: TARGET.vmiName,
  }), (error) => error.message === 'Unable to open the KubeVirt VNC stream.'
    && error.code === 'ENOENT'
    && !error.message.includes('/Users/'));
});

test('openKubeVirtVncBridge bounds upstream bytes buffered before the viewer connects', async () => {
  const errors = [];
  let fakeWebSocket;
  const bridge = await openKubeVirtVncBridge({
    kubeConfig: kubeConfig(),
    namespace: TARGET.namespace,
    vmiName: TARGET.vmiName,
    startupTimeoutMs: 1_000,
    onError: (error) => errors.push(error.message),
    createWebSocket: () => {
      fakeWebSocket = new RfbNoneWebSocket(8);
      return fakeWebSocket;
    },
  });
  fakeWebSocket.pushServerData(Buffer.alloc((1024 * 1024) + 1));
  await bridge.completed;
  assert.deepEqual(errors, ['KubeVirt VNC sent too much data before the viewer connected.']);
});

test('openKubeVirtVncBridge aborts an in-flight upstream handshake and closes its listener', async () => {
  const controller = new AbortController();
  let fakeWebSocket;
  const opening = openKubeVirtVncBridge({
    kubeConfig: kubeConfig(),
    namespace: TARGET.namespace,
    vmiName: TARGET.vmiName,
    startupTimeoutMs: 1_000,
    signal: controller.signal,
    createWebSocket: () => {
      fakeWebSocket = new FakeWebSocket();
      return fakeWebSocket;
    },
  });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(opening, (error) => error.code === 'ABORT_ERR');
  assert.equal(fakeWebSocket.closeCount, 1);
  assert.equal(fakeWebSocket.terminateCount, 1);
});

test('openKubeVirtVncBridge closes a listener aborted between listen call and listening event', async () => {
  const controller = new AbortController();
  let server;
  await assert.rejects(openKubeVirtVncBridge({
    kubeConfig: kubeConfig(),
    namespace: TARGET.namespace,
    vmiName: TARGET.vmiName,
    startupTimeoutMs: 1_000,
    signal: controller.signal,
    createServer: (listener) => {
      server = net.createServer(listener);
      const listen = server.listen.bind(server);
      server.listen = (...args) => {
        const result = listen(...args);
        controller.abort();
        return result;
      };
      return server;
    },
    createWebSocket: () => {
      throw new Error('the upstream must not open after cancellation');
    },
  }), (error) => error.code === 'ABORT_ERR');

  assert.equal(server.listening, false);
  assert.equal(server.address(), null);
});
