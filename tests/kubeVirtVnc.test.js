const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const net = require('node:net');
const test = require('node:test');

const {
  buildKubeVirtVncWebSocketPath,
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

function nextData(socket) {
  return new Promise((resolve, reject) => {
    socket.once('data', resolve);
    socket.once('error', reject);
  });
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

test('openKubeVirtVncBridge transparently bridges one loopback viewer and cleans every handle', async (t) => {
  let fakeWebSocket;
  let request;
  const errors = [];
  const bridge = await openKubeVirtVncBridge({
    kubeConfig: kubeConfig(),
    namespace: TARGET.namespace,
    vmiName: TARGET.vmiName,
    startupTimeoutMs: 1_000,
    onError: (error) => errors.push(error.message),
    createWebSocket: (url, protocol, options) => {
      request = { url, protocol, options };
      fakeWebSocket = new FakeWebSocket();
      queueMicrotask(() => {
        fakeWebSocket.readyState = 1;
        fakeWebSocket.emit('open');
        fakeWebSocket.emit('message', Buffer.from('RFB EARLY\n'), true);
      });
      return fakeWebSocket;
    },
  });
  t.after(() => bridge.close());

  const viewer = await connect(bridge.localPort);
  t.after(() => viewer.destroy());
  await bridge.connected;
  assert.equal(
    request.url,
    'wss://cluster.example.test/prefix/apis/subresources.kubevirt.io/v1/namespaces/kvm-builder-dev/virtualmachineinstances/kb-kmzyssjmw/vnc?preserveSession=true'
  );
  assert.equal(request.protocol, 'plain.kubevirt.io');
  assert.equal(request.options.headers.Authorization, 'Bearer test-only');
  assert.equal(request.options.rejectUnauthorized, false);
  assert.equal(request.options.followRedirects, false);

  assert.deepEqual(await nextData(viewer), Buffer.from('RFB EARLY\n'));

  const viewerBytes = Buffer.from([0x00, 0xff, 0x41, 0x80]);
  viewer.write(viewerBytes);
  await waitFor(() => fakeWebSocket.sent.length === 1);
  assert.deepEqual(fakeWebSocket.sent[0], { data: viewerBytes, options: { binary: true } });

  const remoteBytes = Buffer.from([0x52, 0x46, 0x42, 0x20, 0x00, 0xff]);
  const received = nextData(viewer);
  fakeWebSocket.emit('message', remoteBytes, true);
  assert.deepEqual(await received, remoteBytes);

  await bridge.close();
  await bridge.completed;
  await waitFor(() => viewer.destroyed);
  assert.equal(viewer.destroyed, true);
  assert.equal(fakeWebSocket.closeCount, 1);
  assert.equal(fakeWebSocket.terminateCount, 1);
  assert.deepEqual(errors, []);
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
      fakeWebSocket = new FakeWebSocket();
      queueMicrotask(() => {
        fakeWebSocket.readyState = 1;
        fakeWebSocket.emit('open');
      });
      return fakeWebSocket;
    },
  });

  await bridge.completed;
  assert.deepEqual(errors, ['Timed out waiting for the system VNC viewer.']);
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
  await assert.rejects(openKubeVirtVncBridge({
    kubeConfig: kubeConfig(),
    namespace: TARGET.namespace,
    vmiName: TARGET.vmiName,
    startupTimeoutMs: 1_000,
    onError: (error) => errors.push(error.message),
    createWebSocket: () => {
      const webSocket = new FakeWebSocket();
      queueMicrotask(() => {
        webSocket.readyState = 1;
        webSocket.emit('open');
        webSocket.emit('message', Buffer.alloc((1024 * 1024) + 1), true);
      });
      return webSocket;
    },
  }), /sent too much data before the viewer connected/);
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
