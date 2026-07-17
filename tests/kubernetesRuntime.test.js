const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { KubernetesRuntime } = require('../dist/main/kubernetes/kubernetesRuntime');
const { catalogFromDocument } = require('../dist/main/kubernetes/kubeconfigCatalog');
const { PodInteractionManager } = require('../dist/main/kubernetes/podInteractions');

const POD_QUERY = {
  context: 'development',
  kind: 'pods',
  namespaceScope: { mode: 'selected', namespaces: ['apps'] },
};

const POD_TARGET = {
  namespace: 'apps',
  podName: 'api-7b8c9d',
  container: 'api',
};

const FORWARD = {
  targetKind: 'pod',
  namespace: 'apps',
  targetName: 'api-7b8c9d',
  remotePort: 8080,
};

const VNC_TARGET = {
  namespace: 'apps',
  podName: 'virt-launcher-demo-abcde',
  podUid: 'pod-vnc-uid',
};

function currentState(overrides = {}) {
  return {
    contexts: [{
      name: 'development',
      clusterName: 'development',
      userName: 'developer',
      supported: true,
      tlsVerificationDisabled: false,
    }],
    selectedContext: 'development',
    connection: 'connected',
    kubeconfigReloadAvailable: false,
    ...overrides,
  };
}

function kubeconfigFixture() {
  return {
    clusters: [{
      name: 'development-cluster',
      cluster: {
        server: 'https://api.development.example.test',
        'certificate-authority-data': 'initial-ca-data',
      },
    }],
    users: [
      { name: 'token-user', user: { token: 'initial-token' } },
      {
        name: 'certificate-user',
        user: {
          'client-certificate-data': 'initial-certificate-data',
          'client-key-data': 'initial-key-data',
        },
      },
    ],
    contexts: [
      { name: 'development', context: { cluster: 'development-cluster', user: 'token-user' } },
      { name: 'certificate', context: { cluster: 'development-cluster', user: 'certificate-user' } },
    ],
  };
}

function emptyClient(onClose = () => undefined) {
  return {
    async probeConnection() {},
    async list() { return { items: [], resourceVersion: '1' }; },
    async get() { return {}; },
    async listEvents() { return []; },
    async watch() { return new AbortController(); },
    async openPodLog() { throw new Error('not used'); },
    async openPodExec() { throw new Error('not used'); },
    async openVnc() { throw new Error('not used'); },
    async openPortForward() { throw new Error('not used'); },
    async close() { onClose(); },
  };
}

async function waitFor(predicate, timeoutMs = 250) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for Kubernetes runtime state.');
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

function createRuntime(options = {}) {
  const calls = [];
  const client = options.client ?? {};
  let state = currentState();
  let forwards = [];
  const interactionListeners = {
    logs: new Set(),
    terminals: new Set(),
    output: new Set(),
  };
  const fakeSession = {
    getState: () => ({ ...state, contexts: state.contexts.map((context) => ({ ...context })) }),
    replaceState(next) { state = next; },
    getClient: () => client,
    async selectContext(name) {
      calls.push(`select:${name}`);
      state = currentState({ selectedContext: name });
      return this.getState();
    },
    async reconnect() {
      calls.push('reconnect');
      state = currentState();
      return this.getState();
    },
    async disconnect(reason) {
      calls.push(`disconnect:${reason}`);
      state = currentState({ connection: 'disconnected', error: reason });
    },
    setContexts(contexts) {
      calls.push(`contexts:${contexts.length}`);
      state = { ...state, contexts };
    },
  };
  const fakeCoordinator = {
    disposePageScopedCalls: 0,
    async activate(query) {
      options.onActivate?.(query);
      calls.push(`activate:${query.kind}`);
      return {
        query,
        items: [{ uid: 'pod-1', name: 'api', namespace: 'apps', resourceVersion: '1', columns: {} }],
        loadedCount: 1,
        resourceVersion: '1',
        watchActive: true,
      };
    },
    async loadNextPage(query) {
      calls.push(`more:${query.kind}`);
      return this.activate(query);
    },
    async deactivate() {
      this.disposePageScopedCalls += 1;
      calls.push('deactivate-watches');
    },
    async getDetail() { return { metadata: { name: 'api' } }; },
    async getEvents() { return []; },
    async dispose() { calls.push('dispose-coordinator'); },
  };
  const fakeInteractions = {
    disposePageScopedCalls: 0,
    async openLogs() {
      calls.push('open-logs');
      return { sessionId: 'log-1', ...POD_TARGET, lines: [], following: true, hasOlder: true, scope: 'pod', revision: 0 };
    },
    async loadOlderLogs() { return { sessionId: 'log-1', ...POD_TARGET, lines: [], following: true, hasOlder: false, scope: 'pod', revision: 1 }; },
    async setLogScope(_id, scope) {
      calls.push(`log-scope:${scope}`);
      return {
        sessionId: 'log-1', ...POD_TARGET, lines: [], following: true, hasOlder: scope === 'pod',
        scope, deployment: { name: 'api', podCount: 2 }, revision: 2,
      };
    },
    async setLogStartTime(_id, startTime) {
      calls.push(`log-start-time:${startTime ?? 'none'}`);
      return {
        sessionId: 'log-1', ...POD_TARGET, lines: ['snapshot'], following: false,
        startTime, hasOlder: false, scope: 'pod', revision: 3,
      };
    },
    async setLogFollowing() { return { sessionId: 'log-1', ...POD_TARGET, lines: [], following: false, hasOlder: false, scope: 'pod', revision: 3 }; },
    clearLogs() { return { sessionId: 'log-1', ...POD_TARGET, lines: [], following: false, hasOlder: false, scope: 'pod', revision: 4 }; },
    async closeLogs() { calls.push('close-logs'); },
    async openTerminal() {
      calls.push('open-terminal');
      return { id: 'terminal-1', ...POD_TARGET, shell: '/bin/sh', state: 'open' };
    },
    writeTerminal() { calls.push('write-terminal'); },
    resizeTerminal() { calls.push('resize-terminal'); },
    async closeTerminal() { calls.push('close-terminal'); },
    async startPortForward(input) {
      const forward = { id: `forward-${forwards.length + 1}`, ...input, localPort: 41000 + forwards.length, state: 'running' };
      forwards = [...forwards, forward];
      calls.push('start-forward');
      return forward;
    },
    async stopPortForward(id) {
      forwards = forwards.filter((forward) => forward.id !== id);
      calls.push('stop-forward');
    },
    listPortForwards() { return forwards.map((forward) => ({ ...forward })); },
    onLogChanged(listener) {
      interactionListeners.logs.add(listener);
      return () => interactionListeners.logs.delete(listener);
    },
    onTerminalChanged(listener) {
      interactionListeners.terminals.add(listener);
      return () => interactionListeners.terminals.delete(listener);
    },
    onTerminalOutput(listener) {
      interactionListeners.output.add(listener);
      return () => interactionListeners.output.delete(listener);
    },
    emitLog(state) { interactionListeners.logs.forEach((listener) => listener(state)); },
    emitTerminal(state) { interactionListeners.terminals.forEach((listener) => listener(state)); },
    emitTerminalOutput(event) { interactionListeners.output.forEach((listener) => listener(event)); },
    async disposePageScoped() {
      this.disposePageScopedCalls += 1;
      calls.push('dispose-page-streams');
    },
    async disposeAll() {
      forwards = [];
      calls.push('dispose-all-interactions');
    },
  };
  const runtime = new KubernetesRuntime({
    session: fakeSession,
    createCoordinator: () => fakeCoordinator,
    createInteractions: () => fakeInteractions,
    readKubeconfig: async () => ({ contexts: [], users: [], clusters: [] }),
    watchKubeconfig: () => () => undefined,
    ...options,
  });
  return { runtime, fakeCoordinator, fakeInteractions, fakeSession, calls };
}

test('KubernetesRuntime loads Service backends on demand without replacing the active list or opening a Watch', async () => {
  const relationRequests = [];
  let watchCalls = 0;
  const client = {
    async getRelatedResources(request) {
      relationRequests.push(request);
      return {
        endpoints: [{ uid: 'endpoint-api', name: 'api', namespace: 'team-a', resourceVersion: '1', columns: {} }],
        endpointSlices: [{ uid: 'slice-api', name: 'api-9qzjv', namespace: 'team-a', resourceVersion: '2', columns: {} }],
      };
    },
    async watch() {
      watchCalls += 1;
      return new AbortController();
    },
  };
  const { runtime, calls } = createRuntime({ client });
  const listEvents = [];
  runtime.onListChanged((snapshot) => listEvents.push(snapshot));
  await runtime.activateResources(POD_QUERY);
  listEvents.length = 0;
  calls.length = 0;

  const [first, second] = await Promise.all([
    runtime.getRelatedResources({ kind: 'service', namespace: 'team-a', name: 'api' }),
    runtime.getRelatedResources({ kind: 'service', namespace: 'team-a', name: 'api' }),
  ]);

  assert.equal(relationRequests.length, 1, 'duplicate detail expansions share one in-flight read');
  assert.deepEqual(relationRequests[0], { kind: 'service', namespace: 'team-a', name: 'api' });
  assert.deepEqual(first.endpoints.map((item) => item.name), ['api']);
  assert.deepEqual(second.endpointSlices.map((item) => item.name), ['api-9qzjv']);
  assert.equal(watchCalls, 0);
  assert.deepEqual(listEvents, []);
  assert.deepEqual(calls, []);
});

test('KubernetesRuntime resolves active Pod environment through the client without using the list coordinator and copies the response', async () => {
  const clientCalls = [];
  const source = {
    entries: [{ name: 'PASSWORD', source: 'secretKeyRef', value: 'secret', reference: 'secret/app-env/password' }],
    truncated: false,
    permissionDenied: false,
  };
  const { runtime, calls, fakeCoordinator } = createRuntime({
    client: {
      async getPodContainerEnvironment(input) {
        clientCalls.push(input);
        return source;
      },
    },
  });
  await runtime.activateResources(POD_QUERY);
  calls.length = 0;
  const coordinatorCallsBefore = fakeCoordinator.disposePageScopedCalls;

  const first = await runtime.getPodContainerEnvironment(POD_TARGET);

  assert.deepEqual(clientCalls, [POD_TARGET]);
  assert.deepEqual(calls, []);
  assert.equal(fakeCoordinator.disposePageScopedCalls, coordinatorCallsBefore);
  assert.notEqual(first, source);
  assert.notEqual(first.entries, source.entries);
  assert.notEqual(first.entries[0], source.entries[0]);
  first.entries[0].value = 'changed';
  assert.equal(source.entries[0].value, 'secret');

  const second = await runtime.getPodContainerEnvironment(POD_TARGET);
  assert.equal(clientCalls.length, 2, 'environment reads are never cached by the runtime');
  assert.equal(second.entries[0].value, 'secret');
  await runtime.shutdown();
});

test('KubernetesRuntime keeps Pod environment authorization errors local but forwards non-authorization failures to connection handling', async () => {
  const authorizationError = Object.assign(new Error('forbidden'), { statusCode: 403 });
  const transportError = Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
  let attempt = 0;
  const { runtime } = createRuntime({
    client: {
      async getPodContainerEnvironment() {
        attempt += 1;
        throw attempt === 1 ? authorizationError : transportError;
      },
    },
  });
  const failures = [];
  runtime.onOperationFailure = (error) => failures.push(error);

  await assert.rejects(runtime.getPodContainerEnvironment(POD_TARGET), (error) => error === authorizationError);
  assert.deepEqual(failures, []);
  await assert.rejects(runtime.getPodContainerEnvironment(POD_TARGET), (error) => error === transportError);
  assert.deepEqual(failures, [transportError]);
  await runtime.shutdown();
});

test('KubernetesRuntime discovers Custom Resources on demand and shares the active Context result', async () => {
  let calls = 0;
  let activatedQuery;
  const { runtime } = createRuntime({
    onActivate: (query) => { activatedQuery = query; },
    client: {
      async listCustomResourceDefinitions() {
        calls += 1;
        return [{
          group: 'example.test', version: 'v1', kind: 'Widget', plural: 'widgets', scope: 'namespaced',
          printerColumns: [{ name: 'Ready', type: 'string', jsonPath: '.status.ready', priority: 0 }],
        }];
      },
    },
  });

  const [first, second] = await Promise.all([
    runtime.listCustomResourceDefinitions(),
    runtime.listCustomResourceDefinitions(),
  ]);

  assert.equal(calls, 1);
  assert.deepEqual(first, second);
  assert.notEqual(first[0].printerColumns, second[0].printerColumns);
  assert.deepEqual(first, [{
    group: 'example.test', version: 'v1', kind: 'Widget', plural: 'widgets', scope: 'namespaced',
    printerColumns: [{ name: 'Ready', type: 'string', jsonPath: '.status.ready', priority: 0 }],
  }]);
  const snapshot = await runtime.activateResources({
    context: 'development', kind: 'custom-resources', apiVersion: 'example.test/v1', plural: 'widgets',
    scope: 'namespaced', namespaceScope: { mode: 'all', namespaces: [] },
    customResourcePrinterColumns: [{ name: 'Injected', type: 'string', jsonPath: '.spec.secret', priority: 0 }],
    sort: { column: 'name', direction: 'asc' },
  });
  assert.deepEqual(activatedQuery.customResourcePrinterColumns, [
    { name: 'Ready', type: 'string', jsonPath: '.status.ready', priority: 0, sourceIndex: 0 },
  ]);
  assert.equal(Object.hasOwn(snapshot.query, 'customResourcePrinterColumns'), false);
  await runtime.handleConnectionLoss(Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }));
  assert.deepEqual(activatedQuery.customResourcePrinterColumns, [
    { name: 'Ready', type: 'string', jsonPath: '.status.ready', priority: 0, sourceIndex: 0 },
  ]);
  await runtime.shutdown();
});

test('KubernetesRuntime fences stale Custom Resource discovery across a confirmed kubeconfig reload', async () => {
  const firstDiscovery = deferred();
  let attempts = 0;
  const oldDefinition = {
    group: 'old.example.test', version: 'v1', kind: 'OldWidget', plural: 'oldwidgets', scope: 'namespaced',
    printerColumns: [],
  };
  const newDefinition = {
    group: 'new.example.test', version: 'v1', kind: 'NewWidget', plural: 'newwidgets', scope: 'namespaced',
    printerColumns: [],
  };
  const { runtime } = createRuntime({
    client: {
      async listCustomResourceDefinitions() {
        attempts += 1;
        return attempts === 1 ? firstDiscovery.promise : [newDefinition];
      },
    },
  });

  const staleRequest = runtime.listCustomResourceDefinitions();
  await waitFor(() => attempts === 1);
  await runtime.reloadKubeconfig();
  firstDiscovery.resolve([oldDefinition]);

  await assert.rejects(staleRequest, /invalidated by a Context reload/i);
  assert.deepEqual(await runtime.listCustomResourceDefinitions(), [newDefinition]);
  assert.equal(attempts, 2);
  await runtime.shutdown();
});

test('KubernetesRuntime keeps CRD discovery permission denial local while restoring after reload', async () => {
  const definition = {
    group: 'example.test', version: 'v1', kind: 'Widget', plural: 'widgets', scope: 'namespaced',
    printerColumns: [{ name: 'Ready', type: 'string', jsonPath: '.status.ready', priority: 0 }],
  };
  let discoveries = 0;
  const { runtime, calls } = createRuntime({
    client: {
      async listCustomResourceDefinitions() {
        discoveries += 1;
        if (discoveries === 1) return [definition];
        throw Object.assign(new Error('API endpoint details must stay in the main process'), { statusCode: 403 });
      },
    },
  });
  await runtime.listCustomResourceDefinitions();
  await runtime.activateResources({
    context: 'development', kind: 'custom-resources', apiVersion: 'example.test/v1', plural: 'widgets',
    scope: 'namespaced', namespaceScope: { mode: 'all', namespaces: [] },
  });
  calls.length = 0;

  const state = await runtime.reloadKubeconfig();

  assert.equal(state.connection, 'connected');
  assert.equal(discoveries, 2);
  assert.equal(calls.includes('activate:custom-resources'), false);
  await assert.rejects(
    runtime.listCustomResourceDefinitions(),
    /No permission to list Custom Resource Definitions/i,
  );
  await runtime.shutdown();
});

test('KubernetesRuntime lists every Namespace page without activating the resource coordinator', async () => {
  const listCalls = [];
  const client = {
    async list(query, continueToken) {
      listCalls.push({ query, continueToken });
      if (!continueToken) {
        return {
          items: [
            { uid: 'default', name: 'default', resourceVersion: '1', columns: {} },
            { uid: 'apps', name: ' apps ', resourceVersion: '1', columns: {} },
          ],
          continueToken: 'next',
          resourceVersion: '1',
        };
      }
      return {
        items: [
          { uid: 'apps-copy', name: 'apps', resourceVersion: '2', columns: {} },
          { uid: 'monitoring', name: 'monitoring', resourceVersion: '2', columns: {} },
          { uid: 'empty', name: ' ', resourceVersion: '2', columns: {} },
        ],
        resourceVersion: '2',
      };
    },
  };
  const { runtime, calls } = createRuntime({ client });

  assert.deepEqual(await runtime.listNamespaces(), ['apps', 'default', 'monitoring']);
  assert.deepEqual(listCalls.map(({ query, continueToken }) => ({
    kind: query.kind,
    context: query.context,
    scope: query.scope,
    namespaceScope: query.namespaceScope,
    continueToken,
  })), [
    {
      kind: 'namespaces', context: 'development', scope: 'cluster',
      namespaceScope: { mode: 'all', namespaces: [] }, continueToken: undefined,
    },
    {
      kind: 'namespaces', context: 'development', scope: 'cluster',
      namespaceScope: { mode: 'all', namespaces: [] }, continueToken: 'next',
    },
  ]);
  assert.equal(calls.some((call) => call.startsWith('activate:')), false);
  await runtime.shutdown();
});

test('KubernetesRuntime lists selector-matched Workload Pods once without a Watch and keeps 403 relation failures local', async () => {
  const relationRequests = [];
  const client = {
    async getRelatedResources(request) {
      relationRequests.push(request);
      if (request.name === 'forbidden') {
        throw Object.assign(new Error('403 Forbidden'), { statusCode: 403 });
      }
      return {
        pods: [{ uid: 'pod-api', name: 'api-7b8c9d', namespace: 'team-a', resourceVersion: '3', columns: {} }],
      };
    },
  };
  const { runtime, fakeSession, calls } = createRuntime({ client });
  await runtime.activateResources(POD_QUERY);
  calls.length = 0;
  const request = { kind: 'deployment', namespace: 'team-a', name: 'api', selector: 'app=api' };

  const [first, second] = await Promise.all([
    runtime.getRelatedResources(request),
    runtime.getRelatedResources(request),
  ]);

  assert.equal(relationRequests.length, 1);
  assert.deepEqual(relationRequests[0], request);
  assert.deepEqual(first.pods.map((item) => item.name), ['api-7b8c9d']);
  assert.deepEqual(second.pods.map((item) => item.name), ['api-7b8c9d']);
  await assert.rejects(
    runtime.getRelatedResources({ ...request, name: 'forbidden' }),
    /403 Forbidden/
  );
  assert.equal(fakeSession.getState().connection, 'connected');
  assert.deepEqual(calls, []);
  await assert.rejects(
    runtime.getRelatedResources({ kind: 'statefulset', namespace: 'team-a', name: 'database' }),
    /selector is required/i
  );
});

test('KubernetesRuntime page deactivation stops watches/logs/terminals but retains explicit port forwards', async () => {
  const { runtime, fakeCoordinator, fakeInteractions } = createRuntime();

  await runtime.startPortForward(FORWARD);
  await runtime.activateResources(POD_QUERY);
  await runtime.openLogs(POD_TARGET);
  await runtime.openTerminal(POD_TARGET);
  await runtime.deactivatePage();

  assert.equal(fakeCoordinator.disposePageScopedCalls, 1);
  assert.equal(fakeInteractions.disposePageScopedCalls, 1);
  assert.equal((await runtime.listPortForwards()).length, 1);
});

test('KubernetesRuntime Close All stops one main-process snapshot and publishes every stopped forward', async () => {
  const { runtime, calls } = createRuntime();
  const changed = [];
  runtime.onPortForwardChanged((state) => changed.push(state));
  const first = await runtime.startPortForward(FORWARD);
  const second = await runtime.startPortForward({ ...FORWARD, targetName: 'worker', remotePort: 9090 });
  calls.length = 0;
  changed.length = 0;

  await runtime.stopAllPortForwards();

  assert.deepEqual(calls, ['stop-forward', 'stop-forward']);
  assert.deepEqual(await runtime.listPortForwards(), []);
  assert.deepEqual(
    changed.map(({ id, state }) => [id, state]),
    [[first.id, 'stopped'], [second.id, 'stopped']]
  );
});

test('KubernetesRuntime page deactivation closes active VNC and rejects a delayed stale opening', async () => {
  const delayed = deferred();
  const completed = deferred();
  let closeCalls = 0;
  const makeHandle = () => {
    let viewerPassword = 'temporary';
    return {
      ...VNC_TARGET,
      vmiName: 'demo',
      localPort: 41001,
      takeViewerPassword() {
        const password = viewerPassword;
        viewerPassword = undefined;
        return password;
      },
      completed: completed.promise,
      async close() {
        closeCalls += 1;
        completed.resolve();
      },
    };
  };
  let openingCount = 0;
  const { runtime } = createRuntime({
    client: {
      openVnc() {
        openingCount += 1;
        return openingCount === 1 ? Promise.resolve(makeHandle()) : delayed.promise;
      },
    },
  });

  const active = await runtime.openVnc(VNC_TARGET);
  assert.equal(active.takeViewerPassword(), 'temporary');
  assert.equal(active.takeViewerPassword(), undefined, 'the launch credential is consumed once');
  await runtime.deactivatePage();
  assert.equal(closeCalls, 1, 'page leave closes the active loopback VNC bridge');

  const stale = runtime.openVnc(VNC_TARGET);
  const deactivating = runtime.deactivatePage();
  delayed.resolve(makeHandle());
  await assert.rejects(stale, /changed|cancelled|closed/i);
  await deactivating;
  assert.equal(closeCalls, 2, 'a VNC handle resolving across page leave is closed before launch');
});

test('KubernetesRuntime emits display-safe state and list snapshots through typed listeners', async () => {
  const { runtime } = createRuntime();
  const states = [];
  const lists = [];
  const stopState = runtime.onStateChanged((state) => states.push(state));
  const stopList = runtime.onListChanged((snapshot) => lists.push(snapshot));

  await runtime.setNamespaceScope({ mode: 'selected', namespaces: [' apps ', 'apps'] });
  await runtime.activateResources(POD_QUERY);

  stopState();
  stopList();
  assert.deepEqual(states.at(-1).namespaceScope, { mode: 'selected', namespaces: ['apps'] });
  assert.equal(lists.at(-1).items[0].name, 'api');
  assert.doesNotMatch(JSON.stringify(states), /token|client-certificate-data|exec\.command/i);
});

test('KubernetesRuntime resets Namespace scope only when the selected Context changes', async () => {
  const { runtime } = createRuntime();
  const states = [];
  const stopState = runtime.onStateChanged((state) => states.push(state));

  await runtime.setNamespaceScope({ mode: 'selected', namespaces: ['apps'] });
  const changed = await runtime.selectContext('staging');

  assert.deepEqual(changed.namespaceScope, { mode: 'all', namespaces: [] });
  assert.deepEqual(states.at(-1).namespaceScope, { mode: 'all', namespaces: [] });

  await runtime.setNamespaceScope({ mode: 'selected', namespaces: ['monitoring'] });
  const unchanged = await runtime.selectContext('staging');

  stopState();
  assert.deepEqual(unchanged.namespaceScope, { mode: 'selected', namespaces: ['monitoring'] });
  assert.deepEqual(states.at(-1).namespaceScope, { mode: 'selected', namespaces: ['monitoring'] });
});

test('KubernetesRuntime shares a pending same-query activation and preserves the latest loaded-only view', async () => {
  const initial = deferred();
  let activations = 0;
  const coordinator = {
    activate() {
      activations += 1;
      return initial.promise;
    },
    async loadNextPage() { throw new Error('not used'); },
    async deactivate() {},
    async getDetail() { return {}; },
    async getEvents() { return []; },
    async dispose() {},
  };
  const { runtime } = createRuntime({ createCoordinator: () => coordinator });
  const first = runtime.activateResources({ ...POD_QUERY, nameFilter: 'worker' });
  const second = runtime.activateResources({ ...POD_QUERY, nameFilter: 'api' });

  assert.equal(activations, 1, 'same resource key shares the in-flight initial LIST');
  initial.resolve({
    query: POD_QUERY,
    items: [
      { uid: 'api', name: 'api', namespace: 'apps', resourceVersion: '1', columns: {} },
      { uid: 'worker', name: 'worker', namespace: 'apps', resourceVersion: '1', columns: {} },
    ],
    loadedCount: 2,
    resourceVersion: '1',
    watchActive: true,
  });

  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.query.nameFilter, 'api');
  assert.equal(secondResult.query.nameFilter, 'api');
  assert.deepEqual(secondResult.items.map((item) => item.name), ['api']);
  await runtime.shutdown();
});

test('KubernetesRuntime reconnects only a disconnected Context through the read-only bridge', async () => {
  const { runtime, fakeSession, calls } = createRuntime();
  fakeSession.replaceState(currentState({
    connection: 'disconnected',
    error: 'The Kubernetes API is temporarily unavailable.',
  }));
  const states = [];
  runtime.onStateChanged((state) => states.push(state));

  const state = await runtime.reconnect();

  assert.equal(state.connection, 'connected');
  assert.ok(calls.includes('reconnect'));
  assert.equal(calls.some((call) => /forward|terminal|logs|activate/.test(call)), false);
  assert.equal(states.at(-1).connection, 'connected');
  assert.throws(() => runtime.reconnect(), /not disconnected/i);
  await runtime.shutdown();
});

test('KubernetesRuntime restores only a supported saved Context and clears a removed preference', async () => {
  const saved = [];
  const developmentId = catalogFromDocument('/test-home/.kube/config', kubeconfigFixture())
    .contexts.find((context) => context.contextName === 'development').name;
  const { runtime, fakeSession, calls } = createRuntime({
    readKubeconfig: async () => kubeconfigFixture(),
    contextPreference: {
      async load() { return developmentId; },
      async save(value) { saved.push(value); },
      async clear() { saved.push('cleared'); },
    },
  });
  fakeSession.replaceState({ contexts: [], connection: 'idle', kubeconfigReloadAvailable: false });

  await runtime.init();

  assert.ok(calls.includes(`select:${developmentId}`));
  assert.deepEqual(saved, [developmentId]);
  await runtime.shutdown();

  const removed = [];
  const second = createRuntime({
    readKubeconfig: async () => kubeconfigFixture(),
    contextPreference: {
      async load() { return 'removed-context'; },
      async save(value) { removed.push(value); },
      async clear() { removed.push('cleared'); },
    },
  });
  second.fakeSession.replaceState({ contexts: [], connection: 'idle', kubeconfigReloadAvailable: false });

  await second.runtime.init();

  assert.equal(second.runtime.getState().selectedContext, undefined);
  assert.deepEqual(removed, ['cleared']);
  await second.runtime.shutdown();
});

test('KubernetesRuntime batches a Watch burst into one bounded active-view broadcast', async () => {
  const listQueries = [];
  let sendWatchEvent;
  const client = {
    async list(query) {
      listQueries.push(query);
      return {
        items: [
          { uid: 'z', name: 'zebra', namespace: 'apps', resourceVersion: '1', columns: {} },
          { uid: 'a', name: 'api', namespace: 'apps', resourceVersion: '1', columns: {} },
          { uid: 'b', name: 'backend', namespace: 'apps', resourceVersion: '1', columns: {} },
        ],
        resourceVersion: '1',
      };
    },
    async get() { return {}; },
    async listEvents() { return []; },
    async watch(_query, _resourceVersion, onEvent) {
      sendWatchEvent = onEvent;
      return new AbortController();
    },
    async openPodLog() { throw new Error('not used'); },
    async openPodExec() { throw new Error('not used'); },
    async openPortForward() { throw new Error('not used'); },
    async close() {},
  };
  let state = currentState();
  const runtime = new KubernetesRuntime({
    session: {
      getState: () => state,
      getClient: () => client,
      async setContexts() {},
      async selectContext(name) {
        state = currentState({ selectedContext: name });
        return state;
      },
      async reconnect() { return state; },
      async disconnect() { state = currentState({ connection: 'disconnected' }); },
    },
    createInteractions: () => ({
      async openLogs() { throw new Error('not used'); }, async loadOlderLogs() { throw new Error('not used'); },
      async setLogFollowing() { throw new Error('not used'); }, clearLogs() { throw new Error('not used'); },
      async closeLogs() {}, async openTerminal() { throw new Error('not used'); }, writeTerminal() {}, resizeTerminal() {},
      async closeTerminal() {}, async startPortForward() { throw new Error('not used'); }, async stopPortForward() {},
      listPortForwards() { return []; }, async disposePageScoped() {}, async disposeAll() {},
      onLogChanged() { return () => {}; }, onTerminalChanged() { return () => {}; }, onTerminalOutput() { return () => {}; },
    }),
    readKubeconfig: async () => ({ contexts: [], users: [], clusters: [] }),
    watchKubeconfig: () => () => undefined,
  });
  const broadcasts = [];
  runtime.onListChanged((snapshot) => broadcasts.push(snapshot));
  const viewQuery = {
    ...POD_QUERY,
    nameFilter: 'api',
    sort: { column: 'name', direction: 'desc' },
  };

  const initial = await runtime.listResources(viewQuery);

  assert.deepEqual(initial.items.map((item) => item.name), ['api']);
  assert.deepEqual(listQueries, [{ ...POD_QUERY }]);
  assert.deepEqual(broadcasts.at(-1).items.map((item) => item.name), ['api']);

  const broadcastsBeforeBurst = broadcasts.length;
  for (let index = 0; index < 100; index += 1) {
    sendWatchEvent({
      type: 'MODIFIED',
      object: { uid: 'a', name: `api-${index}`, namespace: 'apps', resourceVersion: String(index + 2), columns: {} },
      resourceVersion: String(index + 2),
    });
  }
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(broadcasts.at(-1).query, viewQuery);
  assert.deepEqual(broadcasts.at(-1).items.map((item) => item.name), ['api-99']);
  assert.ok(
    broadcasts.length <= broadcastsBeforeBurst + 1,
    `expected one bounded projection/broadcast for the burst, received ${broadcasts.length - broadcastsBeforeBurst}`
  );
  await runtime.shutdown();
});

test('KubernetesRuntime retains a ten-thousand-row list in main and sends only bounded virtual windows', async () => {
  const rows = Array.from({ length: 10_000 }, (_, index) => ({
    uid: `pod-${index}`,
    name: `pod-${index}`,
    namespace: 'apps',
    resourceVersion: '1',
    columns: {},
  }));
  const { runtime, fakeCoordinator } = createRuntime();
  fakeCoordinator.activate = async (query) => ({
    query,
    items: rows,
    loadedCount: rows.length,
    resourceVersion: '1',
    watchActive: true,
  });
  const broadcasts = [];
  runtime.onListChanged((snapshot) => broadcasts.push(snapshot));

  const initial = await runtime.listResources(POD_QUERY);
  const distant = await runtime.getResourceWindow(POD_QUERY, { start: 9_000, end: 9_400 });

  assert.equal(initial.total, 10_000);
  assert.ok(initial.items.length <= 128);
  assert.equal(distant.start, 9_000);
  assert.equal(distant.end, 9_256);
  assert.ok(distant.items.length <= 256);
  assert.equal(distant.items[0].name, 'pod-9000');
  assert.ok(broadcasts.every((snapshot) => snapshot.items.length <= 256));
  await runtime.shutdown();
});

test('KubernetesRuntime sends a transient non-410 Watch failure through Context cleanup and reconnect', async () => {
  let emitWatchError;
  const client = {
    async list() {
      return {
        items: [{ uid: 'pod-1', name: 'api', namespace: 'apps', resourceVersion: '1', columns: {} }],
        resourceVersion: '1',
      };
    },
    async get() { return {}; },
    async listEvents() { return []; },
    async listCustomResourceDefinitions() { return []; },
    async watch(_query, _resourceVersion, onEvent) {
      emitWatchError = onEvent;
      return new AbortController();
    },
    async openPodLog() { throw new Error('not used'); },
    async openPodExec() { throw new Error('not used'); },
    async openPortForward() { throw new Error('not used'); },
    async close() {},
  };
  const { runtime, calls } = createRuntime({ client, createCoordinator: undefined });

  await runtime.activateResources(POD_QUERY);
  emitWatchError({ type: 'ERROR', error: Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }) });
  await waitFor(() => calls.includes('reconnect'));

  assert.ok(calls.includes('disconnect:The Kubernetes API connection was lost.'));
  assert.ok(calls.filter((call) => call === 'reconnect').length === 1);
  await runtime.shutdown();
});

test('KubernetesRuntime keeps one connection-loss recovery through a delayed retry', async () => {
  const { runtime, fakeSession, calls } = createRuntime();
  const states = [];
  runtime.onStateChanged((state) => states.push(state));
  await runtime.activateResources(POD_QUERY);
  fakeSession.reconnect = async function reconnectLater() {
    calls.push('reconnect');
    this.replaceState(currentState({ connection: 'reconnecting' }));
    return this.getState();
  };
  calls.length = 0;

  const first = runtime.handleConnectionLoss(Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }));
  await waitFor(() => calls.includes('reconnect'));
  const second = runtime.handleConnectionLoss(Object.assign(new Error('socket closed'), { code: 'ECONNRESET' }));

  assert.equal(second, first);
  fakeSession.replaceState(currentState());
  await first;

  assert.equal(calls.filter((call) => call === 'reconnect').length, 1);
  assert.equal(calls.filter((call) => call.startsWith('disconnect:')).length, 1);
  assert.equal(calls.filter((call) => call === 'activate:pods').length, 1);
  assert.equal(states.filter((state) => state.connection === 'connected').length, 1);
  await runtime.shutdown();
});

test('KubernetesRuntime replaces an old Context reconnect monitor with the new Context monitor', async () => {
  const { runtime, fakeSession, calls } = createRuntime();
  const contexts = [
    ...currentState().contexts,
    { name: 'staging', clusterName: 'staging', userName: 'developer', supported: true, tlsVerificationDisabled: false },
  ];
  fakeSession.replaceState(currentState({ contexts }));
  fakeSession.selectContext = async function selectReconnectingContext(name) {
    calls.push(`select:${name}`);
    this.replaceState(currentState({ contexts, selectedContext: name, connection: 'reconnecting' }));
    return this.getState();
  };
  const states = [];
  runtime.onStateChanged((state) => states.push(state));

  await runtime.selectContext('development');
  await runtime.selectContext('staging');
  fakeSession.replaceState(currentState({ contexts, selectedContext: 'staging' }));
  await waitFor(() => states.some((state) => state.selectedContext === 'staging' && state.connection === 'connected'));

  assert.deepEqual(calls.filter((call) => call.startsWith('select:')), ['select:development', 'select:staging']);
  assert.equal(
    states.filter((state) => state.selectedContext === 'staging' && state.connection === 'connected').length,
    1
  );
  await runtime.shutdown();
});

test('KubernetesRuntime suppresses a superseded Context selection broadcast', async () => {
  const { runtime, fakeSession, calls } = createRuntime();
  const releaseFirst = deferred();
  const contexts = [
    ...currentState().contexts,
    { name: 'staging', clusterName: 'staging', userName: 'developer', supported: true, tlsVerificationDisabled: false },
  ];
  fakeSession.replaceState(currentState({ contexts }));
  fakeSession.selectContext = async function selectWithDelayedFirst(name) {
    calls.push(`select:${name}`);
    if (name === 'development') await releaseFirst.promise;
    this.replaceState(currentState({ contexts, selectedContext: name }));
    return this.getState();
  };
  const states = [];
  runtime.onStateChanged((state) => states.push(state));

  const first = runtime.selectContext('development');
  await waitFor(() => calls.includes('select:development'));
  const second = runtime.selectContext('staging');
  releaseFirst.resolve();
  await Promise.all([first, second]);

  assert.equal(states.some((state) => state.selectedContext === 'development'), false);
  assert.equal(states.filter((state) => state.selectedContext === 'staging').length, 1);
  assert.equal(runtime.getState().selectedContext, 'staging');
  await runtime.shutdown();
});

test('KubernetesRuntime does not reconnect a superseded Context after cleanup finishes', async () => {
  const { runtime, fakeSession, fakeInteractions, calls } = createRuntime();
  const cleanupStarted = deferred();
  const releaseCleanup = deferred();
  const contexts = [
    ...currentState().contexts,
    { name: 'staging', clusterName: 'staging', userName: 'developer', supported: true, tlsVerificationDisabled: false },
  ];
  fakeSession.replaceState(currentState({ contexts }));
  fakeInteractions.disposeAll = async () => {
    calls.push('dispose-all-interactions');
    cleanupStarted.resolve();
    await releaseCleanup.promise;
  };
  await runtime.activateResources(POD_QUERY);
  calls.length = 0;

  const recovery = runtime.handleConnectionLoss(Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }));
  await cleanupStarted.promise;
  const switching = runtime.selectContext('staging');
  releaseCleanup.resolve();
  await Promise.all([recovery, switching]);

  assert.equal(calls.includes('reconnect'), false);
  assert.ok(calls.includes('select:staging'));
  assert.equal(runtime.getState().selectedContext, 'staging');
  assert.equal(runtime.getState().connection, 'connected');
  await runtime.shutdown();
});

test('KubernetesRuntime publishes the relisted active view after a 410 Watch recovery', async () => {
  let emitWatchEvent;
  let listCalls = 0;
  const client = {
    async list() {
      listCalls += 1;
      return listCalls === 1
        ? {
          items: [{ uid: 'pod-1', name: 'old', namespace: 'apps', resourceVersion: '1', columns: {} }],
          resourceVersion: '1',
        }
        : {
          items: [{ uid: 'pod-2', name: 'fresh', namespace: 'apps', resourceVersion: '2', columns: {} }],
          resourceVersion: '2',
        };
    },
    async get() { return {}; },
    async listEvents() { return []; },
    async listCustomResourceDefinitions() { return []; },
    async watch(_query, _resourceVersion, onEvent) {
      emitWatchEvent = onEvent;
      return new AbortController();
    },
    async openPodLog() { throw new Error('not used'); },
    async openPodExec() { throw new Error('not used'); },
    async openPortForward() { throw new Error('not used'); },
    async close() {},
  };
  const { runtime } = createRuntime({ client, createCoordinator: undefined });
  const broadcasts = [];
  runtime.onListChanged((snapshot) => broadcasts.push(snapshot));

  await runtime.activateResources(POD_QUERY);
  broadcasts.length = 0;
  emitWatchEvent({ type: 'ERROR', statusCode: 410 });
  await waitFor(() => broadcasts.some((snapshot) => snapshot.items[0]?.name === 'fresh'));

  assert.equal(broadcasts.at(-1).items[0].name, 'fresh');
  assert.equal(broadcasts.at(-1).watchActive, true);
  await runtime.shutdown();
});

test('KubernetesRuntime forwards interaction stream events and detaches subscriptions during page disposal', async () => {
  const { runtime, fakeInteractions } = createRuntime();
  const logs = [];
  const terminalOutput = [];
  runtime.onLogChanged((state) => logs.push(state));
  runtime.onTerminalOutput((event) => terminalOutput.push(event));

  const opened = await runtime.openLogs(POD_TARGET);
  assert.equal(opened.revision, 0);
  await runtime.openTerminal(POD_TARGET);
  fakeInteractions.emitLog({ sessionId: 'log-1', ...POD_TARGET, lines: ['followed'], following: true, hasOlder: true, revision: 4 });
  fakeInteractions.emitTerminalOutput({ id: 'terminal-1', data: 'hello' });
  assert.deepEqual(logs.at(-1).lines, ['followed']);
  assert.equal(logs.at(-1).revision, 4);
  assert.deepEqual(terminalOutput.at(-1), { id: 'terminal-1', data: 'hello' });

  const received = logs.length + terminalOutput.length;
  await runtime.deactivatePage();
  fakeInteractions.emitLog({ sessionId: 'log-1', ...POD_TARGET, lines: ['late'], following: true, hasOlder: true, revision: 5 });
  fakeInteractions.emitTerminalOutput({ id: 'terminal-1', data: 'late' });
  assert.equal(logs.length + terminalOutput.length, received);
});

test('KubernetesRuntime forwards only validated log scopes and copies Deployment capability metadata', async () => {
  const { runtime, calls } = createRuntime();
  const state = await runtime.setLogScope('log-1', 'deployment');

  assert.equal(state.scope, 'deployment');
  assert.deepEqual(state.deployment, { name: 'api', podCount: 2 });
  assert.ok(calls.includes('log-scope:deployment'));
  state.deployment.podCount = 99;
  await assert.rejects(runtime.setLogScope('log-1', 'all'), /scope must be pod or deployment/i);
  assert.equal(calls.filter((call) => call.startsWith('log-scope:')).length, 1);
});

test('KubernetesRuntime normalizes and forwards only RFC3339 log start times', async () => {
  const { runtime, calls } = createRuntime();
  const state = await runtime.setLogStartTime('log-1', '2026-07-17T16:30:45+08:00');

  assert.equal(state.startTime, '2026-07-17T08:30:45.000Z');
  assert.equal(state.following, false);
  assert.ok(calls.includes('log-start-time:2026-07-17T08:30:45.000Z'));
  await assert.rejects(runtime.setLogStartTime('log-1', '2026-07-17 16:30'), /RFC3339/i);
  assert.equal(calls.filter((call) => call.startsWith('log-start-time:')).length, 1);

  const cleared = await runtime.setLogStartTime('log-1');
  assert.equal(cleared.startTime, undefined);
  assert.ok(calls.includes('log-start-time:none'));
});

test('KubernetesRuntime routes transient log scope failures through Context cleanup and reconnect', async () => {
  const transportError = Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
  const { runtime, fakeInteractions, calls } = createRuntime();
  fakeInteractions.setLogScope = async () => { throw transportError; };

  await assert.rejects(runtime.setLogScope('log-1', 'deployment'), (error) => error === transportError);
  await waitFor(() => calls.includes('reconnect'));

  assert.ok(calls.includes('disconnect:The Kubernetes API connection was lost.'));
  assert.equal(calls.filter((call) => call === 'reconnect').length, 1);
  await runtime.shutdown();
});

test('KubernetesRuntime does not duplicate synchronous onClose or onError terminal finals during open', async () => {
  let attempt = 0;
  const manager = new PodInteractionManager({
    client: () => ({
      async openPodExec(_input, callbacks) {
        attempt += 1;
        if (attempt === 1) {
          callbacks.onClose();
        } else {
          callbacks.onError(new Error('exec stream lost during open'));
        }
        return {
          write() {},
          resize() {},
          async close() {},
        };
      },
    }),
    createId: () => `terminal-${attempt + 1}`,
  });
  const { runtime } = createRuntime({ createInteractions: () => manager });
  const terminalStates = [];
  runtime.onTerminalChanged((state) => terminalStates.push(state));

  const closed = await runtime.openTerminal(POD_TARGET);
  const errored = await runtime.openTerminal(POD_TARGET);

  assert.equal(closed.state, 'closed');
  assert.equal(errored.state, 'error');
  assert.equal(
    terminalStates.filter((state) => state.id === closed.id && state.state === 'closed').length,
    1,
    'a synchronous onClose final is published by the interaction subscription exactly once'
  );
  assert.equal(
    terminalStates.filter((state) => state.id === errored.id && state.state === 'error').length,
    1,
    'a synchronous onError final is published by the interaction subscription exactly once'
  );
  assert.equal(
    terminalStates.filter((state) => state.state === 'open' || state.state === 'connecting').length,
    0
  );

  await runtime.shutdown();
});

test('KubernetesRuntime validates renderer inputs before calling resource interactions', async () => {
  const { runtime, calls } = createRuntime();

  await assert.rejects(runtime.selectContext(''), /Context name is required/i);
  await assert.rejects(runtime.activateResources({ ...POD_QUERY, context: 'other' }), /selected Context/i);
  await assert.rejects(runtime.openTerminal({ ...POD_TARGET, container: '  ' }), /container is required/i);
  await assert.rejects(runtime.startPortForward({ ...FORWARD, remotePort: 0 }), /remote port/i);
  await assert.rejects(runtime.writeTerminal('terminal-1', 42), /input must be text/i);
  await assert.rejects(runtime.resizeTerminal('terminal-1', 0, 24), /dimensions/i);
  await assert.rejects(runtime.setLogScope('log-1', 'all'), /scope must be pod or deployment/i);
  assert.deepEqual(calls, []);
});

test('KubernetesRuntime reload and transient reconnect restore only the current list query without forwards', async () => {
  const { runtime, fakeSession, calls } = createRuntime();
  await runtime.activateResources(POD_QUERY);
  await runtime.startPortForward(FORWARD);
  calls.length = 0;

  await runtime.reloadKubeconfig();
  await runtime.handleConnectionLoss(Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }));

  assert.ok(calls.includes('contexts:0'));
  assert.ok(calls.includes('disconnect:The Kubernetes API connection was lost.'));
  assert.ok(calls.includes('reconnect'));
  assert.ok(calls.includes('activate:pods'));
  assert.equal((await runtime.listPortForwards()).length, 0);
  assert.equal(fakeSession.getState().connection, 'connected');
});

test('KubernetesRuntime shutdown disposes all Kubernetes-owned resources once', async () => {
  const { runtime, calls } = createRuntime();
  await runtime.shutdown();
  await runtime.shutdown();

  assert.equal(calls.filter((call) => call === 'dispose-coordinator').length, 1);
  assert.equal(calls.filter((call) => call === 'dispose-all-interactions').length, 1);
});

test('KubernetesRuntime rejects delayed stale list results after selecting a new Context', async () => {
  let resolveDevelopment;
  const developmentList = new Promise((resolve) => { resolveDevelopment = resolve; });
  let state = {
    contexts: [
      ...currentState().contexts,
      { name: 'staging', clusterName: 'staging', userName: 'developer', supported: true, tlsVerificationDisabled: false },
    ],
    selectedContext: 'development',
    connection: 'connected',
    kubeconfigReloadAvailable: false,
  };
  const activations = [];
  const runtime = new KubernetesRuntime({
    session: {
      getState: () => ({ ...state, contexts: state.contexts.map((context) => ({ ...context })) }),
      getClient: () => ({}),
      async selectContext(name) {
        state = { ...state, selectedContext: name };
        return this.getState();
      },
      async reconnect() { return this.getState(); },
      async disconnect() { state = { ...state, connection: 'disconnected' }; },
      async setContexts(contexts) { state = { ...state, contexts }; },
    },
    createCoordinator: () => ({
      activate(query) {
        activations.push(query.context);
        if (query.context === 'development') return developmentList;
        return Promise.resolve({ query, items: [], loadedCount: 0, resourceVersion: '2', watchActive: true });
      },
      async loadNextPage() { throw new Error('not used'); },
      async deactivate() {},
      async getDetail() { return {}; },
      async getEvents() { return []; },
      async dispose() {},
    }),
    createInteractions: () => ({
      async openLogs() { throw new Error('not used'); }, async loadOlderLogs() { throw new Error('not used'); },
      async setLogFollowing() { throw new Error('not used'); }, clearLogs() { throw new Error('not used'); },
      async closeLogs() {}, async openTerminal() { throw new Error('not used'); }, writeTerminal() {}, resizeTerminal() {},
      async closeTerminal() {}, async startPortForward() { throw new Error('not used'); }, async stopPortForward() {},
      listPortForwards() { return []; }, async disposePageScoped() {}, async disposeAll() {},
      onLogChanged() { return () => {}; }, onTerminalChanged() { return () => {}; }, onTerminalOutput() { return () => {}; },
    }),
    readKubeconfig: async () => ({ contexts: [], users: [], clusters: [] }),
    watchKubeconfig: () => () => undefined,
  });
  const lists = [];
  runtime.onListChanged((snapshot) => lists.push(snapshot));

  const stale = runtime.activateResources(POD_QUERY);
  await runtime.selectContext('staging');
  resolveDevelopment({ query: POD_QUERY, items: [{ uid: 'old', name: 'old', resourceVersion: '1', columns: {} }], loadedCount: 1, resourceVersion: '1', watchActive: true });

  await assert.rejects(stale, /no longer active|changed|invalidated/i);
  const next = await runtime.activateResources({ ...POD_QUERY, context: 'staging' });
  assert.equal(next.query.context, 'staging');
  assert.deepEqual(activations, ['development', 'staging']);
  assert.equal(lists.every((snapshot) => snapshot.query.context === 'staging'), true);
});

test('KubernetesRuntime does not restore a query after reconnecting to a different Context', async () => {
  const { runtime, fakeSession, calls } = createRuntime();
  await runtime.activateResources(POD_QUERY);
  fakeSession.reconnect = async function reconnectToDifferentContext() {
    calls.push('reconnect');
    this.replaceState(currentState({ selectedContext: 'staging' }));
    return this.getState();
  };
  calls.length = 0;

  await runtime.handleConnectionLoss(Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }));

  assert.ok(calls.includes('reconnect'));
  assert.equal(calls.includes('activate:pods'), false);
});

test('KubernetesRuntime disconnects even when interaction cleanup fails', async () => {
  const { runtime, fakeInteractions, calls } = createRuntime();
  fakeInteractions.disposeAll = async () => {
    calls.push('dispose-all-interactions');
    throw new Error('stream cleanup failed');
  };

  await assert.rejects(runtime.shutdown(), /stream cleanup failed/i);
  assert.ok(calls.includes('disconnect:'));
});

test('KubernetesRuntime broadcasts disconnected and starts reconnect after cleanup failure', async () => {
  const { runtime, fakeInteractions, calls } = createRuntime();
  const states = [];
  runtime.onStateChanged((state) => states.push(state));
  await runtime.activateResources(POD_QUERY);
  fakeInteractions.disposeAll = async () => {
    calls.push('dispose-all-interactions');
    throw new Error('stream cleanup failed');
  };
  calls.length = 0;

  await assert.rejects(
    runtime.handleConnectionLoss(Object.assign(new Error('connection reset'), { code: 'ECONNRESET' })),
    /stream cleanup failed/i
  );

  const disconnectedIndex = states.findIndex((state) => state.connection === 'disconnected');
  const reconnectedIndex = states.findIndex((state, index) => index > disconnectedIndex && state.connection === 'connected');
  assert.ok(calls.includes('disconnect:The Kubernetes API connection was lost.'));
  assert.ok(calls.includes('reconnect'));
  assert.ok(calls.includes('activate:pods'));
  assert.ok(disconnectedIndex >= 0, 'the renderer must observe the disconnected state before retrying');
  assert.ok(reconnectedIndex > disconnectedIndex, 'the transient retry must continue after cleanup failure');
});

test('KubernetesRuntime marks content-only kubeconfig credential, certificate, CA, and server changes reloadable', async () => {
  const mutations = [
    ['token', (document) => { document.users[0].user.token = 'rotated-token'; }],
    ['certificate', (document) => { document.users[1].user['client-certificate-data'] = 'rotated-certificate-data'; }],
    ['certificate authority', (document) => { document.clusters[0].cluster['certificate-authority-data'] = 'rotated-ca-data'; }],
    ['API server', (document) => { document.clusters[0].cluster.server = 'https://api.changed.example.test'; }],
  ];

  for (const [label, mutate] of mutations) {
    let source = kubeconfigFixture();
    let notifyKubeconfigChange;
    const { runtime } = createRuntime({
      readKubeconfig: async () => source,
      watchKubeconfig(listener) {
        notifyKubeconfigChange = listener;
        return () => undefined;
      },
    });
    await runtime.init();
    mutate(source);
    notifyKubeconfigChange();
    await waitFor(() => runtime.getState().kubeconfigReloadAvailable);

    const state = runtime.getState();
    assert.equal(state.kubeconfigReloadAvailable, true, `${label} changes must request a kubeconfig reload`);
    assert.doesNotMatch(JSON.stringify(state), /rotated-|initial-token|initial-key-data|example\.test/);
    await runtime.shutdown();
  }
});

test('KubernetesRuntime resolves duplicate Context selections to their own kubeconfig source files', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'service-manager-runtime-kubeconfigs-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const eastPath = path.join(directory, 'east.config');
  const westPath = path.join(directory, 'west.config');
  const documentFor = (suffix) => ({
    clusters: [{ name: `${suffix}-cluster`, cluster: { server: `https://${suffix}.invalid` } }],
    users: [{ name: `${suffix}-user`, user: { token: `${suffix}-secret` } }],
    contexts: [{ name: 'shared', context: { cluster: `${suffix}-cluster`, user: `${suffix}-user` } }],
  });
  await fs.writeFile(eastPath, JSON.stringify(documentFor('east')));
  await fs.writeFile(westPath, JSON.stringify(documentFor('west')));
  const created = [];
  const runtime = new KubernetesRuntime({
    kubeconfigDirectory: directory,
    createClient: async (source) => {
      created.push(source);
      return emptyClient();
    },
    watchKubeconfigDirectory: () => () => undefined,
  });

  const initial = await runtime.init();
  assert.deepEqual(initial.contexts.map((context) => context.displayName), [
    'shared — east.config',
    'shared — west.config',
  ]);
  await runtime.selectContext(initial.contexts[0].name);
  await runtime.selectContext(initial.contexts[1].name);

  assert.deepEqual(created, [
    { kubeconfigPath: eastPath, contextName: 'shared' },
    { kubeconfigPath: westPath, contextName: 'shared' },
  ]);
  assert.doesNotMatch(JSON.stringify(runtime.getState()), /east\.invalid|west\.invalid|secret|service-manager-runtime-kubeconfigs/);
  await runtime.shutdown();
});

test('KubernetesRuntime keeps the active catalog until confirmed reload and clears a removed selection', async () => {
  const sourcePath = '/safe-test-home/.kube/config';
  let catalog = catalogFromDocument(sourcePath, kubeconfigFixture());
  let notifyChange;
  const preferenceEvents = [];
  const closed = [];
  const runtime = new KubernetesRuntime({
    readKubeconfigCatalog: async () => catalog,
    watchKubeconfigDirectory(listener) {
      notifyChange = listener;
      return () => undefined;
    },
    createClient: async () => emptyClient(() => closed.push('closed')),
    contextPreference: {
      async load() { return undefined; },
      async save(value) { preferenceEvents.push(`save:${value}`); },
      async clear() { preferenceEvents.push('clear'); },
    },
  });

  const initial = await runtime.init();
  const selected = initial.contexts[0].name;
  await runtime.selectContext(selected);
  catalog = catalogFromDocument(sourcePath, { clusters: [], users: [], contexts: [] });
  notifyChange();
  await waitFor(() => runtime.getState().kubeconfigReloadAvailable);

  assert.equal(runtime.getState().selectedContext, selected);
  await runtime.reloadKubeconfig();

  assert.equal(runtime.getState().selectedContext, undefined);
  assert.equal(runtime.getState().connection, 'disconnected');
  assert.deepEqual(closed, ['closed']);
  assert.equal(preferenceEvents.at(-1), 'clear');
  await runtime.shutdown();
});

test('KubernetesRuntime rebuilds the active client after a confirmed content-only kubeconfig reload', async () => {
  let source = kubeconfigFixture();
  const createdClients = [];
  const closedClients = [];
  const listClients = [];
  let coordinatorInstances = 0;
  const runtime = new KubernetesRuntime({
    createClient: async () => {
      const id = createdClients.length + 1;
      createdClients.push(id);
      return {
        async probeConnection() {},
        async list(query) {
          listClients.push(id);
          return {
            items: [],
            resourceVersion: String(id),
          };
        },
        async get() { return {}; },
        async listEvents() { return []; },
        async watch() { return new AbortController(); },
        async openPodLog() { throw new Error('not used'); },
        async openPodExec() { throw new Error('not used'); },
        async openPortForward() { throw new Error('not used'); },
        async close() { closedClients.push(id); },
      };
    },
    createCoordinator: (client) => {
      coordinatorInstances += 1;
      return {
        async activate(query) {
          const page = await client().list(query);
          return {
            query,
            items: page.items,
            loadedCount: page.items.length,
            resourceVersion: page.resourceVersion,
            watchActive: true,
          };
        },
        async loadNextPage() { throw new Error('not used'); },
        async deactivate() {},
        async getDetail() { return {}; },
        async getEvents() { return []; },
        async dispose() {},
      };
    },
    createInteractions: () => ({
      async openLogs() { throw new Error('not used'); }, async loadOlderLogs() { throw new Error('not used'); },
      async setLogFollowing() { throw new Error('not used'); }, clearLogs() { throw new Error('not used'); },
      async closeLogs() {}, async openTerminal() { throw new Error('not used'); }, writeTerminal() {}, resizeTerminal() {},
      async closeTerminal() {}, async startPortForward() { throw new Error('not used'); }, async stopPortForward() {},
      listPortForwards() { return []; }, async disposePageScoped() {}, async disposeAll() {},
      onLogChanged() { return () => {}; }, onTerminalChanged() { return () => {}; }, onTerminalOutput() { return () => {}; },
    }),
    readKubeconfig: async () => source,
    watchKubeconfig: () => () => undefined,
  });

  const initial = await runtime.init();
  const developmentId = initial.contexts.find((context) => context.contextName === 'development').name;
  const query = { ...POD_QUERY, context: developmentId };
  await runtime.selectContext(developmentId);
  await runtime.activateResources(query);
  source.users[0].user.token = 'rotated-token';

  await runtime.reloadKubeconfig();

  assert.deepEqual(createdClients, [1, 2]);
  assert.deepEqual(closedClients, [1]);
  assert.deepEqual(listClients, [1, 2]);
  assert.equal(coordinatorInstances, 2);
  assert.doesNotMatch(JSON.stringify(runtime.getState()), /rotated-token|initial-token/);
  await runtime.shutdown();
});

test('KubernetesRuntime restores the matching list after a reload-created client is reconnecting', async () => {
  const { runtime, fakeSession, calls } = createRuntime();
  await runtime.activateResources(POD_QUERY);
  fakeSession.setContexts = async function setContextsWhileReconnecting() {
    this.replaceState(currentState({ connection: 'reconnecting' }));
    setTimeout(() => this.replaceState(currentState()), 0);
  };
  calls.length = 0;

  await runtime.reloadKubeconfig();
  await waitFor(() => calls.includes('activate:pods'));

  assert.equal(runtime.getState().connection, 'connected');
  await runtime.shutdown();
});

test('KubernetesRuntime reports a safe diagnostic when asynchronous connection cleanup fails', async () => {
  const diagnostics = [];
  const { runtime, fakeCoordinator, fakeInteractions } = createRuntime({
    onDiagnostic: (scope, error, context) => diagnostics.push({ scope, error, context }),
  });
  let failList = true;
  fakeCoordinator.activate = async (query) => {
    if (failList) {
      failList = false;
      throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
    }
    return {
      query,
      items: [],
      loadedCount: 0,
      resourceVersion: '2',
      watchActive: true,
    };
  };
  fakeInteractions.disposeAll = async () => {
    throw new Error('stream cleanup failed');
  };

  await assert.rejects(runtime.activateResources(POD_QUERY), /connection reset/i);
  await waitFor(() => diagnostics.length === 1);

  assert.deepEqual(diagnostics[0], {
    scope: 'kubernetes:connection-loss',
    error: new Error('Kubernetes connection recovery cleanup failed.'),
    context: { operation: 'connection-loss-cleanup' },
  });
  assert.equal(runtime.getState().connection, 'connected');
  await runtime.shutdown();
});
