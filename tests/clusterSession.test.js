const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  ClusterSession,
  DEFAULT_KUBERNETES_RETRY_DELAYS_MS,
  classifyKubernetesConnectionError,
} = require('../dist/main/kubernetes/clusterSession');
const {
  createKubernetesClient,
  mapCustomResourceDefinitions,
  mapKubernetesResourceSummary,
} = require('../dist/main/kubernetes/kubernetesClient');

const SUPPORTED_A = {
  name: 'a',
  clusterName: 'cluster-a',
  userName: 'user-a',
  supported: true,
  tlsVerificationDisabled: false,
};

const SUPPORTED_B = {
  name: 'b',
  clusterName: 'cluster-b',
  userName: 'user-b',
  supported: true,
  tlsVerificationDisabled: true,
};

const UNSUPPORTED_EXEC = {
  name: 'exec',
  clusterName: 'cluster-exec',
  userName: 'user-exec',
  supported: false,
  unsupportedReason: 'exec-auth',
  tlsVerificationDisabled: false,
};

function createClient(name, calls) {
  return {
    list: async () => ({ items: [], resourceVersion: '' }),
    get: async () => ({}),
    listEvents: async () => [],
    watch: async () => new AbortController(),
    close: async () => calls.push(`close:${name}`),
  };
}

async function waitFor(predicate, timeoutMs = 250) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for session retry.');
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function createPortForwardClient(t, portForward) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'service-manager-port-forward-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const kubeconfigPath = path.join(directory, 'config.yaml');
  await fs.writeFile(kubeconfigPath, [
    'apiVersion: v1',
    'kind: Config',
    'clusters:',
    '- name: local',
    '  cluster:',
    '    server: https://127.0.0.1:6443',
    'users:',
    '- name: token-user',
    '  user:',
    '    token: test-token',
    'contexts:',
    '- name: token',
    '  context:',
    '    cluster: local',
    '    user: token-user',
    'current-context: token',
    '',
  ].join('\n'));

  class KubeConfig {
    loadFromString() {}
    makePathsAbsolute() {}
    setCurrentContext() {}
    getContextObject() {
      return { name: 'token' };
    }
    getCurrentUser() {
      return { token: 'test-token' };
    }
    makeApiClient() {
      return {};
    }
  }

  class PortForward {
    portForward(...args) {
      return portForward(...args);
    }
  }

  return createKubernetesClient({ kubeconfigPath, context: 'token' }, {
    loadKubernetesNode: async () => ({
      KubeConfig,
      CoreV1Api: class CoreV1Api {},
      AppsV1Api: class AppsV1Api {},
      NetworkingV1Api: class NetworkingV1Api {},
      CustomObjectsApi: class CustomObjectsApi {},
      Watch: class Watch {},
      Log: class Log {},
      Exec: class Exec {},
      PortForward,
    }),
  });
}

async function createRelatedResourceClient(t, calls) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'service-manager-related-resources-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const kubeconfigPath = path.join(directory, 'config.yaml');
  await fs.writeFile(kubeconfigPath, [
    'apiVersion: v1',
    'kind: Config',
    'clusters:',
    '- name: local',
    '  cluster:',
    '    server: https://127.0.0.1:6443',
    'users:',
    '- name: token-user',
    '  user:',
    '    token: test-token',
    'contexts:',
    '- name: token',
    '  context:',
    '    cluster: local',
    '    user: token-user',
    'current-context: token',
    '',
  ].join('\n'));

  const core = {
    async readNamespacedEndpoints(params) {
      calls.endpointCalls.push(params);
      return { metadata: { uid: 'endpoint-api', name: 'api', namespace: 'team-a', resourceVersion: '7' } };
    },
    async listNamespacedPod(params) {
      calls.podCalls.push(params);
      return {
        items: [{
          metadata: { uid: 'pod-api', name: 'api-7b8c9d', namespace: 'team-a', resourceVersion: '8' },
          status: { phase: 'Running' },
        }],
      };
    },
  };
  const discovery = {
    async listNamespacedEndpointSlice(params) {
      calls.endpointSliceCalls.push(params);
      return {
        items: [{
          metadata: { uid: 'slice-api', name: 'api-h9czv', namespace: 'team-a', resourceVersion: '9' },
        }],
      };
    },
  };
  class CoreV1Api {}
  class DiscoveryV1Api {}
  class KubeConfig {
    loadFromString() {}
    makePathsAbsolute() {}
    setCurrentContext() {}
    getContextObject() { return { name: 'token' }; }
    getCurrentUser() { return { token: 'test-token' }; }
    makeApiClient(Api) {
      if (Api === CoreV1Api) return core;
      if (Api === DiscoveryV1Api) return discovery;
      return {};
    }
  }

  return createKubernetesClient({ kubeconfigPath, context: 'token' }, {
    loadKubernetesNode: async () => ({
      KubeConfig,
      CoreV1Api,
      DiscoveryV1Api,
      AppsV1Api: class AppsV1Api {},
      NetworkingV1Api: class NetworkingV1Api {},
      CustomObjectsApi: class CustomObjectsApi {},
      Watch: class Watch {},
      Log: class Log {},
      Exec: class Exec {},
      PortForward: class PortForward {},
    }),
  });
}

function connectLocalPort(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const onError = (error) => {
      socket.off('connect', onConnect);
      reject(error);
    };
    const onConnect = () => {
      socket.off('error', onError);
      resolve(socket);
    };
    socket.once('error', onError);
    socket.once('connect', onConnect);
  });
}

test('Kubernetes port forward absorbs a remote rejection before destroying its local socket', async (t) => {
  const remoteOpening = deferred();
  let forwardedSocket;
  const client = await createPortForwardClient(t, (_namespace, _podName, _ports, socket) => {
    forwardedSocket = socket;
    return remoteOpening.promise;
  });
  const forward = await client.openPortForward({
    targetKind: 'pod',
    namespace: 'apps',
    targetName: 'api-7b8c9d',
    remotePort: 8080,
  });
  const localSocket = await connectLocalPort(forward.localPort);
  t.after(async () => {
    localSocket.destroy();
    await forward.close();
    await client.close();
  });

  await waitFor(() => forwardedSocket !== undefined);
  assert.ok(forwardedSocket.listenerCount('error') > 0, 'the local socket must always own an error listener');

  const uncaught = [];
  const onUncaughtExceptionMonitor = (error) => uncaught.push(error);
  process.on('uncaughtExceptionMonitor', onUncaughtExceptionMonitor);
  t.after(() => process.off('uncaughtExceptionMonitor', onUncaughtExceptionMonitor));
  remoteOpening.reject(new Error('remote port forward rejected'));

  await new Promise((resolve) => localSocket.once('close', resolve));
  assert.deepEqual(uncaught, []);
});

test('Kubernetes port forward closes a remote handle that resolves after its local socket closes', async (t) => {
  const remoteOpening = deferred();
  let forwardedSocket;
  let remoteClosed = 0;
  const client = await createPortForwardClient(t, (_namespace, _podName, _ports, socket) => {
    forwardedSocket = socket;
    return remoteOpening.promise;
  });
  const forward = await client.openPortForward({
    targetKind: 'pod',
    namespace: 'apps',
    targetName: 'api-7b8c9d',
    remotePort: 8080,
  });
  const localSocket = await connectLocalPort(forward.localPort);
  t.after(async () => {
    localSocket.destroy();
    await forward.close();
    await client.close();
  });

  await waitFor(() => forwardedSocket !== undefined);
  const forwardedClosed = new Promise((resolve) => forwardedSocket.once('close', resolve));
  localSocket.destroy();
  await Promise.all([
    new Promise((resolve) => localSocket.once('close', resolve)),
    forwardedClosed,
  ]);
  remoteOpening.resolve({
    close() {
      remoteClosed += 1;
    },
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(remoteClosed, 1);
});

test('ClusterSession disposes the former Context before activating the next Context', async () => {
  const calls = [];
  const session = new ClusterSession({
    createClient: async (name) => createClient(name, calls),
    disposeOwnedResources: async () => calls.push('dispose'),
  });

  session.setContexts([SUPPORTED_A, SUPPORTED_B]);
  await session.selectContext('a');
  const state = await session.selectContext('b');

  assert.deepEqual(calls, ['dispose', 'close:a']);
  assert.equal(state.connection, 'connected');
  assert.equal(state.selectedContext, 'b');
  assert.equal(session.getClient().constructor, Object);
});

test('ClusterSession refuses unsupported exec Contexts without creating a client', async () => {
  let createCalls = 0;
  const session = new ClusterSession({
    createClient: async () => {
      createCalls += 1;
      return createClient('unexpected', []);
    },
    disposeOwnedResources: async () => undefined,
  });

  session.setContexts([UNSUPPORTED_EXEC]);
  const state = await session.selectContext('exec');

  assert.equal(createCalls, 0);
  assert.equal(state.connection, 'unsupported-auth');
  assert.equal(state.selectedContext, 'exec');
  assert.match(state.error, /exec credentials/i);
  assert.throws(() => session.getClient(), /No active Kubernetes Context/);
});

test('ClusterSession disposes the active Context before rejecting an unknown selection', async () => {
  const calls = [];
  const session = new ClusterSession({
    createClient: async (name) => createClient(name, calls),
    disposeOwnedResources: async () => calls.push('dispose'),
  });
  session.setContexts([SUPPORTED_A]);
  await session.selectContext('a');

  const state = await session.selectContext('missing');

  assert.deepEqual(calls, ['dispose', 'close:a']);
  assert.equal(state.connection, 'disconnected');
  assert.equal(state.selectedContext, undefined);
  assert.match(state.error, /no longer available/i);
  assert.throws(() => session.getClient(), /No active Kubernetes Context/);
});

test('ClusterSession disposes a removed active Context before publishing it as disconnected', async () => {
  const calls = [];
  const session = new ClusterSession({
    createClient: async (name) => createClient(name, calls),
    disposeOwnedResources: async () => calls.push('dispose'),
  });
  session.setContexts([SUPPORTED_A]);
  await session.selectContext('a');

  session.setContexts([]);
  await waitFor(() => session.getState().connection === 'disconnected');

  const state = session.getState();
  assert.deepEqual(calls, ['dispose', 'close:a']);
  assert.equal(state.connection, 'disconnected');
  assert.equal(state.selectedContext, undefined);
  assert.deepEqual(state.contexts, []);
});

test('ClusterSession closes a stale connecting Context before applying a newer Context catalog', async () => {
  const calls = [];
  let resolveFirstClient;
  const firstClient = new Promise((resolve) => {
    resolveFirstClient = resolve;
  });
  const session = new ClusterSession({
    createClient: async (name) => {
      if (name === 'a') {
        return firstClient;
      }
      return createClient(name, calls);
    },
    disposeOwnedResources: async () => calls.push('dispose'),
  });
  session.setContexts([SUPPORTED_A, SUPPORTED_B]);

  const selectingA = session.selectContext('a');
  await waitFor(() => session.getState().connection === 'connecting');
  session.setContexts([SUPPORTED_B]);
  resolveFirstClient(createClient('a', calls));

  await selectingA;
  await waitFor(() => {
    const state = session.getState();
    return state.connection === 'disconnected'
      && state.selectedContext === undefined
      && state.contexts.length === 1
      && state.contexts[0].name === 'b';
  });
  assert.deepEqual(calls, ['dispose', 'close:a']);
  await session.selectContext('b');

  assert.deepEqual(calls, ['dispose', 'close:a']);
  assert.equal(session.getState().connection, 'connected');
  assert.equal(session.getState().selectedContext, 'b');
  assert.ok(session.getClient());
});

test('ClusterSession still closes its active client when owned-resource disposal fails', async () => {
  const calls = [];
  const session = new ClusterSession({
    createClient: async () => createClient('a', calls),
    disposeOwnedResources: async () => {
      calls.push('dispose');
      throw new Error('resource cleanup failed');
    },
  });
  session.setContexts([SUPPORTED_A]);
  await session.selectContext('a');

  await assert.rejects(session.disconnect('Disconnected by user.'), /resource cleanup failed/);
  assert.deepEqual(calls, ['dispose', 'close:a']);
  assert.equal(session.getState().connection, 'disconnected');
});

test('ClusterSession retries only transient connection failures using the configured backoff', async () => {
  let attempts = 0;
  const session = new ClusterSession({
    createClient: async () => {
      attempts += 1;
      if (attempts < 3) {
        const error = new Error('connection reset');
        error.code = 'ECONNRESET';
        throw error;
      }
      return createClient('a', []);
    },
    disposeOwnedResources: async () => undefined,
    retryDelaysMs: [1, 1],
  });

  session.setContexts([SUPPORTED_A]);
  const initial = await session.selectContext('a');
  assert.equal(initial.connection, 'reconnecting');
  await waitFor(() => session.getState().connection === 'connected');

  assert.equal(attempts, 3);
  assert.deepEqual(DEFAULT_KUBERNETES_RETRY_DELAYS_MS, [200, 500, 1_000, 2_000, 5_000]);
});

test('ClusterSession leaves authentication and TLS failures disconnected without automatic retry', async () => {
  for (const error of [
    Object.assign(new Error('forbidden'), { statusCode: 403 }),
    Object.assign(new Error('certificate verify failed'), { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }),
  ]) {
    let attempts = 0;
    const session = new ClusterSession({
      createClient: async () => {
        attempts += 1;
        throw error;
      },
      disposeOwnedResources: async () => undefined,
      retryDelaysMs: [1, 1],
    });
    session.setContexts([SUPPORTED_A]);

    const state = await session.selectContext('a');
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(state.connection, 'disconnected');
    assert.equal(attempts, 1);
  }
});

test('classifyKubernetesConnectionError recognizes transport, authentication, TLS, and other failures', () => {
  assert.equal(classifyKubernetesConnectionError({ code: 'ECONNRESET' }), 'transient');
  assert.equal(classifyKubernetesConnectionError({ code: 'ETIMEDOUT' }), 'transient');
  assert.equal(classifyKubernetesConnectionError({ statusCode: 401 }), 'authentication');
  assert.equal(classifyKubernetesConnectionError({ status: 403 }), 'authentication');
  assert.equal(classifyKubernetesConnectionError({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' }), 'tls');
  assert.equal(classifyKubernetesConnectionError(new Error('certificate verify failed')), 'tls');
  assert.equal(classifyKubernetesConnectionError(new Error('unexpected')), 'other');
});

test('mapKubernetesResourceSummary normalizes Date creation timestamps and strips Secret payloads', () => {
  const summary = mapKubernetesResourceSummary('secrets', {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      uid: 'secret-uid',
      name: 'database',
      namespace: 'apps',
      resourceVersion: '12',
      creationTimestamp: new Date('2026-07-12T08:00:00+08:00'),
    },
    type: 'Opaque',
    data: { password: 'c2VjcmV0' },
    stringData: { password: 'secret' },
  });

  assert.deepEqual(summary, {
    uid: 'secret-uid',
    name: 'database',
    namespace: 'apps',
    resourceVersion: '12',
    createdAt: '2026-07-12T00:00:00.000Z',
    status: 'Opaque',
    columns: { type: 'Opaque', data: '1', immutable: 'No', labels: '0', annotations: '0' },
  });
  assert.doesNotMatch(JSON.stringify(summary), /c2VjcmV0|"password":"secret"/);
  assert.equal(Object.hasOwn(summary, 'data'), false);
  assert.equal(Object.hasOwn(summary, 'stringData'), false);
});

test('Pod summary ignores invalid or negative requests and renders missing requests as em dashes', () => {
  const { summarizePodListColumns } = require('../dist/main/kubernetes/podSummary');
  const invalid = summarizePodListColumns({
    spec: {
      containers: [
        { resources: { requests: { cpu: '-2', memory: '-2Mi' } } },
        { resources: { requests: { cpu: 'not-a-quantity', memory: 'infinity' } } },
      ],
    },
    status: {},
  });
  assert.deepEqual(invalid, { cpu: '—', memory: '—', restarts: '0', node: '—' });

  const missing = summarizePodListColumns({ spec: { containers: [{}] }, status: {} });
  assert.deepEqual(missing, { cpu: '—', memory: '—', restarts: '0', node: '—' });
});

test('mapKubernetesResourceSummary normalizes valid string creation timestamps to ISO', () => {
  const summary = mapKubernetesResourceSummary('pods', {
    metadata: {
      uid: 'pod-uid',
      name: 'web',
      namespace: 'apps',
      resourceVersion: '13',
      creationTimestamp: '2026-07-12T08:00:00+08:00',
    },
  });

  assert.equal(summary.createdAt, '2026-07-12T00:00:00.000Z');
});

test('mapKubernetesResourceSummary omits invalid creation timestamps', () => {
  for (const creationTimestamp of ['not-a-timestamp', new Date('not-a-timestamp')]) {
    const summary = mapKubernetesResourceSummary('pods', {
      metadata: {
        uid: 'pod-uid',
        name: 'web',
        resourceVersion: '14',
        creationTimestamp,
      },
    });

    assert.equal(Object.hasOwn(summary, 'createdAt'), false);
  }
});

test('mapCustomResourceDefinitions exposes only served Group Version Kind plural and scope', () => {
  const definitions = mapCustomResourceDefinitions([
    {
      metadata: { name: 'widgets.example.test', annotations: { secret: 'must-not-cross' } },
      spec: {
        group: 'example.test',
        scope: 'Namespaced',
        names: { kind: 'Widget', plural: 'widgets', shortNames: ['wdg'] },
        versions: [
          { name: 'v1alpha1', served: false },
          { name: 'v1', served: true },
        ],
      },
    },
    {
      spec: {
        group: 'infra.example.test',
        scope: 'Cluster',
        names: { kind: 'ClusterWidget', plural: 'clusterwidgets' },
        versions: [{ name: 'v1beta1', served: true }],
      },
    },
    { spec: { group: 'invalid', scope: 'Namespaced', names: { kind: 'Broken', plural: 'broken' }, versions: [] } },
  ]);

  assert.deepEqual(definitions, [
    { group: 'example.test', version: 'v1', kind: 'Widget', plural: 'widgets', scope: 'namespaced' },
    { group: 'infra.example.test', version: 'v1beta1', kind: 'ClusterWidget', plural: 'clusterwidgets', scope: 'cluster' },
  ]);
  assert.doesNotMatch(JSON.stringify(definitions), /secret|annotations|shortNames/i);
});

test('KubernetesClient discovers CRDs through ApiextensionsV1Api without opening a Watch', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'service-manager-crd-discovery-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const kubeconfigPath = path.join(directory, 'config.yaml');
  await fs.writeFile(kubeconfigPath, [
    'apiVersion: v1', 'kind: Config',
    'clusters:', '- name: local', '  cluster:', '    server: https://127.0.0.1:6443',
    'users:', '- name: token-user', '  user:', '    token: test-token',
    'contexts:', '- name: token', '  context:', '    cluster: local', '    user: token-user', '',
  ].join('\n'));
  const calls = [];
  class ApiextensionsV1Api {}
  class KubeConfig {
    loadFromString() {}
    makePathsAbsolute() {}
    setCurrentContext() {}
    getContextObject() { return { name: 'token' }; }
    getCurrentUser() { return { token: 'test-token' }; }
    makeApiClient(Api) {
      if (Api === ApiextensionsV1Api) {
        return {
          async listCustomResourceDefinition(params) {
            calls.push(params);
            return { items: [{ spec: {
              group: 'example.test', scope: 'Namespaced', names: { kind: 'Widget', plural: 'widgets' },
              versions: [{ name: 'v1', served: true }],
            } }] };
          },
        };
      }
      return {};
    }
  }
  const client = await createKubernetesClient({ kubeconfigPath, context: 'token' }, {
    loadKubernetesNode: async () => ({
      KubeConfig,
      CoreV1Api: class CoreV1Api {}, AppsV1Api: class AppsV1Api {}, NetworkingV1Api: class NetworkingV1Api {},
      DiscoveryV1Api: class DiscoveryV1Api {}, ApiextensionsV1Api, CustomObjectsApi: class CustomObjectsApi {},
      Watch: class Watch {}, Log: class Log {}, Exec: class Exec {}, PortForward: class PortForward {},
    }),
  });

  assert.deepEqual(await client.listCustomResourceDefinitions(), [
    { group: 'example.test', version: 'v1', kind: 'Widget', plural: 'widgets', scope: 'namespaced' },
  ]);
  assert.deepEqual(calls, [{}]);
  await client.close();
});

test('KubernetesClient preserves generated Object API receivers for read-only lists', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'service-manager-bound-kubernetes-api-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const kubeconfigPath = path.join(directory, 'config.yaml');
  await fs.writeFile(kubeconfigPath, [
    'apiVersion: v1', 'kind: Config',
    'clusters:', '- name: local', '  cluster:', '    server: https://127.0.0.1:6443',
    'users:', '- name: token-user', '  user:', '    token: test-token',
    'contexts:', '- name: token', '  context:', '    cluster: local', '    user: token-user', '',
  ].join('\n'));
  const calls = [];
  const core = {
    marker: 'bound',
    async listServiceForAllNamespaces(params) {
      assert.equal(this.marker, 'bound');
      calls.push(params);
      return { items: [], metadata: { resourceVersion: '7' } };
    },
  };
  class CoreV1Api {}
  class KubeConfig {
    loadFromString() {}
    makePathsAbsolute() {}
    setCurrentContext() {}
    getContextObject() { return { name: 'token' }; }
    getCurrentUser() { return { token: 'test-token' }; }
    makeApiClient(Api) { return Api === CoreV1Api ? core : {}; }
  }
  const client = await createKubernetesClient({ kubeconfigPath, context: 'token' }, {
    loadKubernetesNode: async () => ({
      KubeConfig, CoreV1Api,
      DiscoveryV1Api: class DiscoveryV1Api {}, AppsV1Api: class AppsV1Api {},
      NetworkingV1Api: class NetworkingV1Api {}, ApiextensionsV1Api: class ApiextensionsV1Api {},
      CustomObjectsApi: class CustomObjectsApi {}, Watch: class Watch {}, Log: class Log {},
      Exec: class Exec {}, PortForward: class PortForward {},
    }),
  });

  const page = await client.list({
    context: 'token',
    kind: 'services',
    scope: 'namespaced',
    namespaceScope: { mode: 'all', namespaces: [] },
  });

  assert.equal(page.resourceVersion, '7');
  assert.deepEqual(calls, [{ limit: 200 }]);
  await client.close();
});

test('KubernetesClient reads Service backends and Workload Pods on demand without creating a Watch', async (t) => {
  const calls = { endpointCalls: [], endpointSliceCalls: [], podCalls: [] };
  const client = await createRelatedResourceClient(t, calls);

  const service = await client.getRelatedResources({ kind: 'service', namespace: 'team-a', name: 'api' });
  const workload = await client.getRelatedResources({
    kind: 'statefulset', namespace: 'team-a', name: 'api', selector: 'app=api',
  });

  assert.deepEqual(calls.endpointCalls, [{ name: 'api', namespace: 'team-a' }]);
  assert.deepEqual(calls.endpointSliceCalls, [{
    namespace: 'team-a', labelSelector: 'kubernetes.io/service-name=api', limit: 200,
  }]);
  assert.deepEqual(calls.podCalls, [{ namespace: 'team-a', labelSelector: 'app=api', limit: 200 }]);
  assert.deepEqual(service.endpoints.map((item) => item.name), ['api']);
  assert.deepEqual(service.endpointSlices.map((item) => item.name), ['api-h9czv']);
  assert.deepEqual(workload.pods.map((item) => item.name), ['api-7b8c9d']);
  await client.close();
});

test('KubernetesClient turns a client-node Watch done(null) into one recoverable stream error', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'service-manager-kubeconfig-watch-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const kubeconfigPath = path.join(directory, 'config.yaml');
  await fs.writeFile(kubeconfigPath, [
    'apiVersion: v1',
    'kind: Config',
    'clusters:',
    '- name: local',
    '  cluster:',
    '    server: https://127.0.0.1:6443',
    'users:',
    '- name: token-user',
    '  user:',
    '    token: test-token',
    'contexts:',
    '- name: token',
    '  context:',
    '    cluster: local',
    '    user: token-user',
    'current-context: token',
    '',
  ].join('\n'));

  let finishWatch;
  class KubeConfig {
    loadFromString() {}
    makePathsAbsolute() {}
    setCurrentContext() {}
    getContextObject() { return { name: 'token' }; }
    getCurrentUser() { return { token: 'test-token' }; }
    makeApiClient() { return {}; }
  }
  class Watch {
    async watch(_path, _parameters, _onEvent, done) {
      finishWatch = done;
      return new AbortController();
    }
  }
  const client = await createKubernetesClient({ kubeconfigPath, context: 'token' }, {
    loadKubernetesNode: async () => ({
      KubeConfig,
      CoreV1Api: class CoreV1Api {},
      DiscoveryV1Api: class DiscoveryV1Api {},
      AppsV1Api: class AppsV1Api {},
      NetworkingV1Api: class NetworkingV1Api {},
      ApiextensionsV1Api: class ApiextensionsV1Api {},
      CustomObjectsApi: class CustomObjectsApi {},
      Watch,
      Log: class Log {},
      Exec: class Exec {},
      PortForward: class PortForward {},
    }),
  });
  const events = [];

  await client.watch({
    context: 'token',
    kind: 'pods',
    namespaceScope: { mode: 'all', namespaces: [] },
  }, '7', (event) => events.push(event));
  finishWatch(null);
  finishWatch(null);

  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'ERROR');
  assert.equal(events[0].error.code, 'ECONNRESET');
  assert.match(events[0].error.message, /stream ended/i);
  await client.close();
});

test('createKubernetesClient loads the ESM Kubernetes adapter only for supported local credentials', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'service-manager-kubeconfig-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const kubeconfigPath = path.join(directory, 'config.yaml');
  await fs.writeFile(kubeconfigPath, [
    'apiVersion: v1',
    'kind: Config',
    'clusters:',
    '- name: local',
    '  cluster:',
    '    server: https://127.0.0.1:6443',
    'users:',
    '- name: token-user',
    '  user:',
    '    token: test-token',
    'contexts:',
    '- name: token',
    '  context:',
    '    cluster: local',
    '    user: token-user',
    'current-context: token',
    '',
  ].join('\n'));

  const client = await createKubernetesClient({ kubeconfigPath, context: 'token' });
  assert.equal(typeof client.list, 'function');
  await client.close();
});

test('createKubernetesClient rejects auth-provider credentials before loading or constructing client-node', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'service-manager-kubeconfig-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const kubeconfigPath = path.join(directory, 'config.yaml');
  await fs.writeFile(kubeconfigPath, [
    'apiVersion: v1',
    'kind: Config',
    'clusters:',
    '- name: local',
    '  cluster:',
    '    server: https://127.0.0.1:6443',
    'users:',
    '- name: auth-provider-user',
    '  user:',
    '    token: token-that-must-not-bypass-the-provider',
    '    auth-provider:',
    '      name: gcp',
    'contexts:',
    '- name: auth-provider',
    '  context:',
    '    cluster: local',
    '    user: auth-provider-user',
    'current-context: auth-provider',
    '',
  ].join('\n'));

  const originalFunction = globalThis.Function;
  let loaderCalls = 0;
  let constructorCalls = 0;
  globalThis.Function = function interceptedNativeImport() {
    return async () => {
      loaderCalls += 1;
      return {
        KubeConfig: class KubeConfig {
          constructor() {
            constructorCalls += 1;
          }

          loadFromFile() {}
          setCurrentContext() {}
          getContextObject() {
            return { name: 'auth-provider' };
          }
          getCurrentUser() {
            return { token: 'token-that-must-not-bypass-the-provider', authProvider: { name: 'gcp' } };
          }
          makeApiClient() {
            throw new Error('must not create an API client');
          }
        },
      };
    };
  };
  t.after(() => {
    globalThis.Function = originalFunction;
  });

  await assert.rejects(
    createKubernetesClient({ kubeconfigPath, context: 'auth-provider' }),
    /unsupported auth-provider credentials/i
  );
  assert.equal(loaderCalls, 0);
  assert.equal(constructorCalls, 0);
});

test('createKubernetesClient accepts complete inline and file certificate pairs but rejects incomplete and auth-provider credentials', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'service-manager-kubeconfig-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const kubeconfigPath = path.join(directory, 'config.yaml');
  const certificatePath = path.join(directory, 'certificate.pem');
  const keyPath = path.join(directory, 'key.pem');
  const authProviderMarker = path.join(directory, 'auth-provider-ran');
  await Promise.all([
    fs.writeFile(certificatePath, 'not-used-without-a-request'),
    fs.writeFile(keyPath, 'not-used-without-a-request'),
  ]);
  await fs.writeFile(kubeconfigPath, [
    'apiVersion: v1',
    'kind: Config',
    'clusters:',
    '- name: local',
    '  cluster:',
    '    server: https://127.0.0.1:6443',
    'users:',
    '- name: inline-user',
    '  user:',
    '    client-certificate-data: inline-certificate',
    '    client-key-data: inline-key',
    '- name: file-user',
    '  user:',
    '    client-certificate: certificate.pem',
    '    client-key: key.pem',
    '- name: incomplete-inline-user',
    '  user:',
    '    client-certificate-data: inline-certificate',
    '- name: incomplete-file-user',
    '  user:',
    '    client-key: key.pem',
    '- name: mixed-user',
    '  user:',
    '    client-certificate-data: inline-certificate',
    '    client-key: key.pem',
    '- name: auth-provider-user',
    '  user:',
    '    token: allowed-only-without-auth-provider',
    '    auth-provider:',
    '      name: exec',
    '      config:',
    '        exec:',
    '          command: /usr/bin/touch',
    '          args:',
    `          - ${authProviderMarker}`,
    '- name: auth-provider-certificate-user',
    '  user:',
    '    client-certificate-data: certificate-must-not-bypass-auth-provider',
    '    client-key-data: key-must-not-bypass-auth-provider',
    '    auth-provider:',
    '      name: gcp',
    'contexts:',
    '- name: inline',
    '  context:',
    '    cluster: local',
    '    user: inline-user',
    '- name: file',
    '  context:',
    '    cluster: local',
    '    user: file-user',
    '- name: incomplete-inline',
    '  context:',
    '    cluster: local',
    '    user: incomplete-inline-user',
    '- name: incomplete-file',
    '  context:',
    '    cluster: local',
    '    user: incomplete-file-user',
    '- name: mixed',
    '  context:',
    '    cluster: local',
    '    user: mixed-user',
    '- name: auth-provider',
    '  context:',
    '    cluster: local',
    '    user: auth-provider-user',
    '- name: auth-provider-certificate',
    '  context:',
    '    cluster: local',
    '    user: auth-provider-certificate-user',
    'current-context: inline',
    '',
  ].join('\n'));

  for (const context of ['inline', 'file']) {
    const client = await createKubernetesClient({ kubeconfigPath, context });
    assert.equal(typeof client.list, 'function');
    await client.close();
  }
  for (const context of ['incomplete-inline', 'incomplete-file', 'mixed']) {
    await assert.rejects(
      createKubernetesClient({ kubeconfigPath, context }),
      /supported token or client-certificate credentials/i
    );
  }
  await assert.rejects(
    createKubernetesClient({ kubeconfigPath, context: 'auth-provider' }),
    /unsupported auth-provider credentials/i
  );
  await assert.rejects(
    createKubernetesClient({ kubeconfigPath, context: 'auth-provider-certificate' }),
    /unsupported auth-provider credentials/i
  );
  await assert.rejects(fs.access(authProviderMarker), /ENOENT/);
});
