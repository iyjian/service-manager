const assert = require('node:assert/strict');
const test = require('node:test');

const { ResourceCoordinator } = require('../dist/main/kubernetes/resourceCoordinator');
const { ResourceCache } = require('../dist/main/kubernetes/resourceCache');

const POD_QUERY = {
  context: 'development',
  kind: 'pods',
  namespaceScope: { mode: 'selected', namespaces: ['apps'] },
};

function pod(uid, name, resourceVersion) {
  return {
    uid,
    name,
    namespace: 'apps',
    resourceVersion,
    columns: {},
  };
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

function flushMicrotasks() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function waitFor(predicate, message = 'Timed out waiting for coordinator work.') {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) {
      return;
    }
    await flushMicrotasks();
  }
  throw new Error(message);
}

function createFakeClient(pages = []) {
  const listCalls = [];
  const watchCalls = [];
  const detailCalls = [];
  const eventCalls = [];
  let abortedWatchCount = 0;

  return {
    listCalls,
    watchCalls,
    detailCalls,
    eventCalls,
    get abortedWatchCount() {
      return abortedWatchCount;
    },
    async list(query, continueToken) {
      listCalls.push({ query, continueToken });
      const next = pages.shift();
      if (!next) {
        throw new Error('Unexpected Kubernetes LIST.');
      }
      return typeof next.then === 'function' ? next : next;
    },
    async watch(query, resourceVersion, onEvent) {
      const abortController = new AbortController();
      abortController.signal.addEventListener('abort', () => {
        abortedWatchCount += 1;
      }, { once: true });
      watchCalls.push({ query, resourceVersion, onEvent, abortController });
      return abortController;
    },
    async get(query, name, namespace) {
      detailCalls.push({ query, name, namespace });
      return { metadata: { name, namespace }, data: { password: 'secret' } };
    },
    async listEvents(reference) {
      eventCalls.push(reference);
      return [pod('event-1', 'started', '1')];
    },
    async close() {},
    emitWatch(resourceVersion, event) {
      const call = [...watchCalls].reverse().find((candidate) => candidate.resourceVersion === resourceVersion);
      assert.ok(call, `No Watch registered for resourceVersion ${resourceVersion}.`);
      call.onEvent(event);
    },
  };
}

function createCoordinator(fakeClient) {
  return new ResourceCoordinator({
    client: () => fakeClient,
    cache: new ResourceCache(20, 120_000),
  });
}

test('ResourceCoordinator shares one initial LIST and Watch and pages only with the returned continuation', async () => {
  const fakeClient = createFakeClient([
    { items: [pod('pod-1', 'api', '10')], continueToken: 'next-page', resourceVersion: '10' },
    { items: [pod('pod-2', 'worker', '11')], resourceVersion: '11' },
  ]);
  const coordinator = createCoordinator(fakeClient);

  const [first, second] = await Promise.all([
    coordinator.activate(POD_QUERY),
    coordinator.activate({ ...POD_QUERY, nameFilter: 'api', sort: { column: 'name', direction: 'asc' } }),
  ]);

  assert.equal(fakeClient.listCalls.length, 1);
  assert.equal(fakeClient.listCalls[0].continueToken, undefined);
  assert.equal(fakeClient.watchCalls.length, 1);
  assert.equal(first.watchActive, true);
  assert.equal(second.watchActive, true);

  const paged = await coordinator.loadNextPage(POD_QUERY);
  assert.equal(fakeClient.listCalls.length, 2);
  assert.equal(fakeClient.listCalls[1].continueToken, 'next-page');
  assert.deepEqual(paged.items.map((item) => item.uid), ['pod-1', 'pod-2']);
  assert.equal(paged.loadedCount, 2);

  await coordinator.loadNextPage(POD_QUERY);
  assert.equal(fakeClient.listCalls.length, 2);

  await coordinator.deactivate(POD_QUERY);
  assert.equal(fakeClient.abortedWatchCount, 0);
  await coordinator.deactivate(POD_QUERY);
  assert.equal(fakeClient.abortedWatchCount, 1);
});

test('ResourceCoordinator creates one all-namespace Pod Watch, not one Watch per Namespace', async () => {
  const fakeClient = createFakeClient([
    { items: [], resourceVersion: '10' },
  ]);
  const coordinator = createCoordinator(fakeClient);
  const allNamespaces = {
    ...POD_QUERY,
    namespaceScope: { mode: 'all', namespaces: [] },
  };

  await coordinator.activate(allNamespaces);

  assert.equal(fakeClient.watchCalls.length, 1);
  assert.equal(fakeClient.watchCalls[0].query.namespaceScope.mode, 'all');
});

test('ResourceCoordinator reconciles Watch resource versions and relists only an active query after 410', async () => {
  const relist = deferred();
  const fakeClient = createFakeClient([
    { items: [pod('pod-1', 'old', '10')], resourceVersion: '10' },
    relist.promise,
  ]);
  const coordinator = createCoordinator(fakeClient);
  const snapshot = await coordinator.activate(POD_QUERY);

  fakeClient.emitWatch('10', { type: 'MODIFIED', object: pod('pod-1', 'new', '11') });
  fakeClient.emitWatch('10', { type: 'ADDED', object: pod('pod-2', 'added', '12') });
  fakeClient.emitWatch('10', { type: 'DELETED', object: pod('pod-2', 'added', '13') });
  fakeClient.emitWatch('10', { type: 'BOOKMARK', resourceVersion: '14' });
  await flushMicrotasks();
  assert.equal(snapshot.items[0].name, 'new');
  assert.deepEqual(snapshot.items.map((item) => item.uid), ['pod-1']);
  assert.equal(snapshot.resourceVersion, '14');

  fakeClient.emitWatch('10', { type: 'ERROR', statusCode: 410 });
  await waitFor(() => fakeClient.listCalls.length === 2);
  assert.equal(fakeClient.abortedWatchCount, 1);
  await coordinator.deactivate(POD_QUERY);
  relist.resolve({ items: [pod('pod-2', 'relisted', '20')], resourceVersion: '20' });
  await flushMicrotasks();

  assert.equal(fakeClient.watchCalls.length, 1);
  assert.deepEqual(snapshot.items.map((item) => item.uid), ['pod-1']);

  const activeClient = createFakeClient([
    { items: [pod('pod-1', 'old', '10')], resourceVersion: '10' },
    { items: [pod('pod-2', 'relisted', '20')], resourceVersion: '20' },
  ]);
  const activeCoordinator = createCoordinator(activeClient);
  const activeSnapshot = await activeCoordinator.activate(POD_QUERY);
  activeClient.emitWatch('10', { type: 'ERROR', statusCode: 410 });
  await waitFor(() => activeClient.watchCalls.length === 2);

  assert.equal(activeClient.listCalls.length, 2);
  assert.equal(activeClient.abortedWatchCount, 1);
  assert.equal(activeClient.watchCalls[1].resourceVersion, '20');
  assert.deepEqual(activeSnapshot.items.map((item) => item.uid), ['pod-2']);
});

test('ResourceCoordinator coalesces a Watch burst into one loaded-page reconciliation', async () => {
  const fakeClient = createFakeClient([
    { items: [pod('pod-1', 'initial', '1')], resourceVersion: '1' },
  ]);
  const cache = new ResourceCache(20, 120_000);
  const originalSet = cache.set.bind(cache);
  let cacheWrites = 0;
  cache.set = (...args) => {
    cacheWrites += 1;
    return originalSet(...args);
  };
  const coordinator = new ResourceCoordinator({ client: () => fakeClient, cache });
  const snapshot = await coordinator.activate(POD_QUERY);
  const writesBeforeBurst = cacheWrites;

  for (let index = 0; index < 100; index += 1) {
    fakeClient.emitWatch('1', {
      type: 'MODIFIED',
      object: pod('pod-1', `api-${index}`, String(index + 2)),
      resourceVersion: String(index + 2),
    });
  }
  await flushMicrotasks();

  assert.equal(snapshot.items.length, 1);
  assert.equal(snapshot.items[0].name, 'api-99');
  assert.equal(snapshot.resourceVersion, '101');
  assert.equal(cacheWrites - writesBeforeBurst, 1, 'a burst publishes one reconciled cache snapshot');
});

test('ResourceCoordinator stops non-410 Watches and reports resource-local permission and transient failures', async () => {
  const errors = [];
  const fakeClient = createFakeClient([
    { items: [pod('pod-1', 'api', '10')], resourceVersion: '10' },
  ]);
  const coordinator = new ResourceCoordinator({
    client: () => fakeClient,
    cache: new ResourceCache(20, 120_000),
    onWatchError: (event) => errors.push(event),
  });
  const snapshot = await coordinator.activate(POD_QUERY);

  fakeClient.emitWatch('10', { type: 'ERROR', statusCode: 403 });
  await flushMicrotasks();

  assert.equal(fakeClient.abortedWatchCount, 1);
  assert.equal(snapshot.watchActive, false);
  assert.equal(snapshot.permissionDenied, true);
  assert.match(snapshot.error, /permission/i);
  assert.deepEqual(errors.map((event) => event.statusCode), [403]);

  const transientClient = createFakeClient([
    { items: [pod('pod-2', 'worker', '20')], resourceVersion: '20' },
  ]);
  const transientErrors = [];
  const transient = new ResourceCoordinator({
    client: () => transientClient,
    cache: new ResourceCache(20, 120_000),
    onWatchError: (event) => transientErrors.push(event),
  });
  const transientSnapshot = await transient.activate(POD_QUERY);
  transientClient.emitWatch('20', { type: 'ERROR', error: Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }) });
  await flushMicrotasks();

  assert.equal(transientClient.abortedWatchCount, 1);
  assert.equal(transientSnapshot.watchActive, false);
  assert.equal(transientSnapshot.permissionDenied, undefined);
  assert.match(transientSnapshot.error, /stopped/i);
  assert.equal(transientErrors[0].error.code, 'ECONNRESET');
});

test('ResourceCoordinator drops a stale page response after 410 replaces its LIST snapshot', async () => {
  const delayedPage = deferred();
  const fakeClient = createFakeClient([
    { items: [pod('pod-1', 'old', '10')], continueToken: 'page-2', resourceVersion: '10' },
    delayedPage.promise,
    { items: [pod('pod-3', 'fresh', '20')], resourceVersion: '20' },
  ]);
  const coordinator = createCoordinator(fakeClient);
  const snapshot = await coordinator.activate(POD_QUERY);

  const pendingPage = coordinator.loadNextPage(POD_QUERY);
  await waitFor(() => fakeClient.listCalls.length === 2);

  fakeClient.emitWatch('10', { type: 'ERROR', statusCode: 410 });
  await waitFor(() => fakeClient.watchCalls.length === 2);
  assert.deepEqual(snapshot.items.map((item) => item.uid), ['pod-3']);
  assert.equal(snapshot.resourceVersion, '20');

  delayedPage.resolve({ items: [pod('pod-2', 'stale-page', '11')], resourceVersion: '11' });
  const afterStalePage = await pendingPage;

  assert.deepEqual(afterStalePage.items.map((item) => item.uid), ['pod-3']);
  assert.equal(afterStalePage.resourceVersion, '20');
  assert.deepEqual(snapshot.items.map((item) => item.uid), ['pod-3']);
  assert.equal(snapshot.resourceVersion, '20');
});

test('ResourceCoordinator aborts all Watches on page leave and refuses requests after disposal', async () => {
  const fakeClient = createFakeClient([
    { items: [], resourceVersion: '10' },
    { items: [], resourceVersion: '11' },
  ]);
  const coordinator = createCoordinator(fakeClient);
  const deploymentQuery = { ...POD_QUERY, kind: 'deployments' };

  await coordinator.activate(POD_QUERY);
  await coordinator.activate(deploymentQuery);
  await coordinator.deactivate();
  assert.equal(fakeClient.abortedWatchCount, 2);

  await coordinator.dispose();
  assert.throws(() => coordinator.activate(POD_QUERY), /disposed/i);
  assert.throws(() => coordinator.getDetail(POD_QUERY, 'api', 'apps'), /disposed/i);
  assert.equal(fakeClient.listCalls.length, 2);
  assert.equal(fakeClient.detailCalls.length, 0);
});

test('ResourceCoordinator deduplicates non-Secret detail and Event reads but never retains a Secret detail', async () => {
  const fakeClient = createFakeClient();
  const coordinator = createCoordinator(fakeClient);
  const secretQuery = { ...POD_QUERY, kind: 'secrets' };

  const [firstDetail, secondDetail] = await Promise.all([
    coordinator.getDetail(POD_QUERY, 'api', 'apps'),
    coordinator.getDetail(POD_QUERY, 'api', 'apps'),
  ]);
  assert.deepEqual(firstDetail, secondDetail);
  assert.equal(fakeClient.detailCalls.length, 1);

  await coordinator.getDetail(secretQuery, 'database', 'apps');
  await coordinator.getDetail(secretQuery, 'database', 'apps');
  assert.equal(fakeClient.detailCalls.length, 3);

  await Promise.all([
    coordinator.getEvents({ uid: 'pod-1', namespace: 'apps' }),
    coordinator.getEvents({ uid: 'pod-1', namespace: 'apps' }),
  ]);
  assert.equal(fakeClient.eventCalls.length, 1);
});
