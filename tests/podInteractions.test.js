const assert = require('node:assert/strict');
const test = require('node:test');

const {
  appendBoundedLogLines,
  PodInteractionManager,
  shellFallbacks,
} = require('../dist/main/kubernetes/podInteractions');

const POD_INPUT = {
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

function createFakeClient(options = {}) {
  const logInputs = [];
  const terminalInputs = [];
  const forwardInputs = [];
  const logLineBatches = options.logLineBatches ?? [options.logLines ?? []];
  const shellFailures = new Set(options.shellFailures ?? []);
  let closedLogCount = 0;
  let closedTerminalCount = 0;
  let closedForwardCount = 0;

  return {
    logInputs,
    terminalInputs,
    forwardInputs,
    get closedLogCount() {
      return closedLogCount;
    },
    get closedTerminalCount() {
      return closedTerminalCount;
    },
    get closedForwardCount() {
      return closedForwardCount;
    },
    async openPodLog(input, callbacks) {
      logInputs.push(input);
      const batchIndex = Math.min(logInputs.length - 1, logLineBatches.length - 1);
      for (const line of logLineBatches[batchIndex] ?? []) {
        callbacks.onLine(line);
      }
      return {
        completed: Promise.resolve(),
        async close() {
          closedLogCount += 1;
        },
      };
    },
    async openPodExec(input) {
      terminalInputs.push(input);
      if (shellFailures.has(input.shell)) {
        throw new Error(`${input.shell} is not available`);
      }
      return {
        write() {},
        resize() {},
        async close() {
          closedTerminalCount += 1;
        },
      };
    },
    async openPortForward(input) {
      forwardInputs.push(input);
      return {
        localPort: input.localPort ?? 40000 + forwardInputs.length,
        async close() {
          closedForwardCount += 1;
        },
      };
    },
  };
}

function createManager(fakeClient) {
  let identifier = 0;
  return new PodInteractionManager({
    client: () => fakeClient,
    createId: () => `interaction-${++identifier}`,
  });
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

function createHandle(onClose) {
  return {
    completed: Promise.resolve(),
    async close() {
      onClose?.();
    },
  };
}

test('appendBoundedLogLines retains only the newest 2,000 complete lines', () => {
  const current = Array.from({ length: 1_999 }, (_, index) => `old-${index}`);
  const next = appendBoundedLogLines(current, ['new-1\nnew-2\n']);

  assert.equal(next.length, 2_000);
  assert.equal(next[0], 'old-1');
  assert.equal(next.at(-1), 'new-2');
});

test('PodInteractionManager opens following logs with the 500-line initial tail', async () => {
  const fakeClient = createFakeClient({ logLines: ['first', 'second'] });
  const manager = createManager(fakeClient);

  const logs = await manager.openLogs(POD_INPUT);

  assert.deepEqual(fakeClient.logInputs[0], {
    ...POD_INPUT,
    tailLines: 500,
    follow: true,
  });
  assert.deepEqual(logs.lines, ['first', 'second']);
  assert.equal(logs.following, true);
  await manager.closeLogs(logs.sessionId);
  assert.equal(fakeClient.closedLogCount, 1);
});

test('PodInteractionManager defaults Deployment-owned Pods to bounded aggregate container logs', async () => {
  const streams = [];
  const manager = createManager({
    async resolvePodDeploymentLogTargets(input) {
      assert.deepEqual(input, POD_INPUT);
      return {
        name: 'api',
        pods: [
          { uid: 'pod-a', podName: 'api-a' },
          { uid: 'pod-b', podName: 'api-b' },
        ],
      };
    },
    async openPodLog(input, callbacks) {
      streams.push({ input, callbacks });
      callbacks.onLine(input.podName === 'api-a'
        ? '2026-07-15T08:00:02.000Z second'
        : '2026-07-15T08:00:01.000Z first');
      return createHandle();
    },
  });

  const logs = await manager.openLogs(POD_INPUT);

  assert.equal(logs.scope, 'deployment');
  assert.deepEqual(logs.deployment, { name: 'api', podCount: 2 });
  assert.deepEqual(streams.map(({ input }) => input), [
    { namespace: 'apps', podName: 'api-a', container: 'api', tailLines: 250, follow: true },
    { namespace: 'apps', podName: 'api-b', container: 'api', tailLines: 250, follow: true },
  ]);
  assert.deepEqual(logs.lines, [
    '2026-07-15T08:00:01.000Z [api-b] first',
    '2026-07-15T08:00:02.000Z [api-a] second',
  ]);
});

test('PodInteractionManager Clear drops the Deployment aggregate backing buffer permanently', async () => {
  const streams = [];
  const states = [];
  const manager = createManager({
    async resolvePodDeploymentLogTargets() {
      return {
        name: 'api',
        pods: [
          { uid: 'pod-a', podName: 'api-a' },
          { uid: 'pod-b', podName: 'api-b' },
        ],
      };
    },
    async openPodLog(input, callbacks) {
      streams.push({ input, callbacks });
      return createHandle();
    },
  });
  manager.onLogChanged((state) => states.push(state));
  const opened = await manager.openLogs(POD_INPUT);
  streams[0].callbacks.onLine('2026-07-15T08:00:00.000Z before clear');

  assert.deepEqual(manager.clearLogs(opened.sessionId).lines, []);
  streams[1].callbacks.onLine('2026-07-15T08:00:01.000Z after clear');

  assert.deepEqual(states.at(-1).lines, [
    '2026-07-15T08:00:01.000Z [api-b] after clear',
  ]);
  await manager.closeLogs(opened.sessionId);
});

test('PodInteractionManager switches Deployment logs to the current Pod and fences old aggregate streams', async () => {
  const streams = [];
  let closed = 0;
  let resolutions = 0;
  const manager = createManager({
    async resolvePodDeploymentLogTargets() {
      resolutions += 1;
      return {
        name: 'api',
        pods: [
          { uid: 'pod-a', podName: 'api-a' },
          { uid: 'pod-b', podName: POD_INPUT.podName },
        ],
      };
    },
    async openPodLog(input, callbacks) {
      streams.push({ input, callbacks });
      return createHandle(() => { closed += 1; });
    },
  });
  const opened = await manager.openLogs(POD_INPUT);
  streams[0].callbacks.onLine('2026-07-15T08:00:00.000Z aggregate');

  const podOnly = await manager.setLogScope(opened.sessionId, 'pod');
  assert.equal(podOnly.scope, 'pod');
  assert.deepEqual(podOnly.deployment, { name: 'api', podCount: 2 });
  assert.deepEqual(podOnly.lines, []);
  assert.equal(closed, 2);
  assert.deepEqual(streams[2].input, {
    ...POD_INPUT,
    tailLines: 500,
    follow: true,
  });
  streams[0].callbacks.onLine('2026-07-15T08:00:01.000Z stale');
  streams[2].callbacks.onLine('2026-07-15T08:00:02.000Z current');
  assert.deepEqual(manager.clearLogs(opened.sessionId).lines, []);

  const deployment = await manager.setLogScope(opened.sessionId, 'deployment');
  assert.equal(deployment.scope, 'deployment');
  assert.equal(resolutions, 2, 'Deployment membership is refreshed when scope is enabled again');
  assert.equal(streams.length, 5);
});

test('PodInteractionManager rolls a failed Deployment scope refresh back to a coherent paused Pod state', async () => {
  const streams = [];
  const states = [];
  let resolutions = 0;
  const manager = createManager({
    async resolvePodDeploymentLogTargets() {
      resolutions += 1;
      return resolutions === 1
        ? {
            name: 'api',
            pods: [
              { uid: 'pod-a', podName: 'api-a' },
              { uid: 'pod-b', podName: POD_INPUT.podName },
            ],
          }
        : undefined;
    },
    async openPodLog(input, callbacks) {
      streams.push({ input, callbacks });
      return createHandle();
    },
  });
  manager.onLogChanged((state) => states.push(state));
  const opened = await manager.openLogs(POD_INPUT);
  await manager.setLogScope(opened.sessionId, 'pod');
  const podStream = streams.at(-1);
  podStream.callbacks.onLine('2026-07-15T08:00:00.000Z retained Pod line');

  await assert.rejects(
    manager.setLogScope(opened.sessionId, 'deployment'),
    /Deployment log scope is no longer available/i
  );

  const rollback = states.at(-1);
  assert.equal(rollback.scope, 'pod');
  assert.equal(rollback.following, false, 'a failed switch owns no hidden live stream');
  assert.deepEqual(rollback.deployment, { name: 'api', podCount: 2 });
  assert.deepEqual(rollback.lines, ['2026-07-15T08:00:00.000Z retained Pod line']);
  const revisionAfterRollback = rollback.revision;
  podStream.callbacks.onLine('2026-07-15T08:00:01.000Z stale Pod stream');
  assert.equal(states.at(-1).revision, revisionAfterRollback, 'the detached prior stream stays fenced');

  const resumed = await manager.setLogFollowing(opened.sessionId, true);
  assert.equal(resumed.scope, 'pod');
  assert.equal(resumed.following, true);
  await manager.closeLogs(opened.sessionId);
});

test('PodInteractionManager emits a coherent stopped rollback when the requested scope stream cannot open', async () => {
  const streams = [];
  const states = [];
  const manager = createManager({
    async resolvePodDeploymentLogTargets() {
      return {
        name: 'api',
        pods: [
          { uid: 'pod-a', podName: 'api-a' },
          { uid: 'pod-b', podName: POD_INPUT.podName },
        ],
      };
    },
    async openPodLog(input, callbacks) {
      streams.push({ input, callbacks });
      if (streams.length === 3) throw new Error('Pod log transport failed');
      return createHandle();
    },
  });
  manager.onLogChanged((state) => states.push(state));
  const opened = await manager.openLogs(POD_INPUT);
  streams[0].callbacks.onLine('2026-07-15T08:00:00.000Z retained aggregate line');

  await assert.rejects(manager.setLogScope(opened.sessionId, 'pod'), /transport failed/i);

  const rollback = states.at(-1);
  assert.equal(rollback.scope, 'deployment');
  assert.equal(rollback.following, false);
  assert.deepEqual(rollback.lines, [
    '2026-07-15T08:00:00.000Z [api-a] retained aggregate line',
  ]);
  await manager.closeLogs(opened.sessionId);
});

test('PodInteractionManager pause remains authoritative when an aggregate stream close fails', async () => {
  const streams = [];
  const manager = createManager({
    async resolvePodDeploymentLogTargets() {
      return {
        name: 'api',
        pods: [
          { uid: 'pod-a', podName: 'api-a' },
          { uid: 'pod-b', podName: 'api-b' },
        ],
      };
    },
    async openPodLog(input, callbacks) {
      const index = streams.length;
      streams.push({ input, callbacks });
      return {
        completed: Promise.resolve(),
        async close() {
          if (index === 0) throw new Error('close failed');
        },
      };
    },
  });
  const opened = await manager.openLogs(POD_INPUT);
  streams[0].callbacks.onLine('2026-07-15T08:00:00.000Z before pause');

  const paused = await manager.setLogFollowing(opened.sessionId, false);
  streams[0].callbacks.onLine('2026-07-15T08:00:01.000Z late');

  assert.equal(paused.following, false);
  assert.deepEqual(paused.lines, ['2026-07-15T08:00:00.000Z [api-a] before pause']);
});

test('PodInteractionManager emits monotonic log revisions for appended lines, older loads, Follow changes, and Clear', async () => {
  const streams = [];
  let calls = 0;
  const manager = createManager({
    async openPodLog(input, callbacks) {
      calls += 1;
      streams.push({ input, callbacks });
      if (calls === 2) {
        callbacks.onLine('older');
        callbacks.onLine('first');
      }
      return createHandle();
    },
  });
  const revisions = [];
  manager.onLogChanged((state) => revisions.push(state.revision));

  const opened = await manager.openLogs(POD_INPUT);
  assert.equal(opened.revision, 0);
  assert.deepEqual(revisions, [0]);

  streams[0].callbacks.onLine('first');
  assert.equal(revisions.at(-1), 1);
  const older = await manager.loadOlderLogs(opened.sessionId);
  assert.equal(older.revision, 2);
  const paused = await manager.setLogFollowing(opened.sessionId, false);
  assert.equal(paused.revision, 3);
  const cleared = manager.clearLogs(opened.sessionId);
  assert.equal(cleared.revision, 4);
  const resumed = await manager.setLogFollowing(opened.sessionId, true);
  assert.equal(resumed.revision, 5);
  assert.deepEqual(revisions, [0, 1, 2, 3, 4, 5]);
});

test('PodInteractionManager publishes bounded follow-log and terminal-output events without late delivery after disposal', async () => {
  let logCallbacks;
  let terminalCallbacks;
  const manager = createManager({
    async openPodLog(_input, callbacks) {
      logCallbacks = callbacks;
      return createHandle();
    },
    async openPodExec(_input, callbacks) {
      terminalCallbacks = callbacks;
      return {
        write() {},
        resize() {},
        async close() {},
      };
    },
  });
  const logStates = [];
  const terminalOutput = [];
  manager.onLogChanged((state) => logStates.push(state));
  manager.onTerminalOutput((event) => terminalOutput.push(event));

  const logs = await manager.openLogs(POD_INPUT);
  const terminal = await manager.openTerminal(POD_INPUT);
  logCallbacks.onLine('followed line');
  const output = 'x'.repeat(20_000);
  terminalCallbacks.onData(output);

  assert.deepEqual(logStates.at(-1).lines, ['followed line']);
  assert.ok(terminalOutput.length > 1);
  assert.ok(terminalOutput.every((event) => event.id === terminal.id && event.data.length <= 16_384));
  assert.equal(terminalOutput.map((event) => event.data).join(''), output);

  const eventCount = logStates.length + terminalOutput.length;
  await manager.disposePageScoped();
  logCallbacks.onLine('late log line');
  terminalCallbacks.onData('late terminal output');
  assert.equal(logStates.length + terminalOutput.length, eventCount);
  await assert.rejects(manager.loadOlderLogs(logs.sessionId), /not active/i);
});

test('PodInteractionManager requests a growing tail snapshot without sinceTime and prepends its older prefix', async () => {
  const olderPrefix = '2026-07-12T01:02:02.000Z older';
  const first = '2026-07-12T01:02:03.000Z first';
  const fakeClient = createFakeClient({
    logLineBatches: [[first], [olderPrefix, first]],
  });
  const manager = createManager(fakeClient);
  const logs = await manager.openLogs(POD_INPUT);

  const older = await manager.loadOlderLogs(logs.sessionId);

  assert.deepEqual(fakeClient.logInputs[1], {
    ...POD_INPUT,
    tailLines: 501,
    follow: false,
  });
  assert.equal(fakeClient.logInputs[1].tailLines > logs.lines.length, true);
  assert.equal('sinceTime' in fakeClient.logInputs[1], false);
  assert.deepEqual(older.lines, [olderPrefix, first]);
  assert.equal(older.hasOlder, false);
});

test('PodInteractionManager coalesces concurrent older-log requests into one snapshot and prepend', async () => {
  const olderPrefix = '2026-07-12T01:02:02.000Z older';
  const first = '2026-07-12T01:02:03.000Z first';
  const snapshotComplete = deferred();
  let calls = 0;
  const manager = createManager({
    async openPodLog(_input, callbacks) {
      calls += 1;
      if (calls === 1) {
        callbacks.onLine(first);
        return createHandle();
      }
      callbacks.onLine(olderPrefix);
      callbacks.onLine(first);
      return {
        completed: snapshotComplete.promise,
        async close() {},
      };
    },
  });
  const logs = await manager.openLogs(POD_INPUT);

  const firstLoad = manager.loadOlderLogs(logs.sessionId);
  const secondLoad = manager.loadOlderLogs(logs.sessionId);
  assert.equal(calls, 2, 'only the initial follow stream and one older snapshot should open');
  snapshotComplete.resolve();

  const [firstResult, secondResult] = await Promise.all([firstLoad, secondLoad]);
  assert.deepEqual(firstResult.lines, [olderPrefix, first]);
  assert.deepEqual(secondResult.lines, [olderPrefix, first]);
  assert.equal(calls, 2);
  await manager.closeLogs(logs.sessionId);
});

test('PodInteractionManager opens the default shell and closes page-scoped streams', async () => {
  const fakeClient = createFakeClient();
  const manager = createManager(fakeClient);
  const terminal = await manager.openTerminal(POD_INPUT);

  assert.deepEqual(shellFallbacks(), ['/bin/sh', 'ash', 'bash']);
  assert.equal(terminal.shell, '/bin/sh');
  assert.deepEqual(fakeClient.terminalInputs.map((input) => input.shell), ['/bin/sh']);

  await manager.disposePageScoped();
  assert.equal(fakeClient.closedTerminalCount, 1);
  assert.equal(fakeClient.closedLogCount, 0);
});

test('PodInteractionManager propagates a synchronous exec rejection without shell fallback', async () => {
  const rejection = Object.assign(new Error('forbidden by Kubernetes RBAC'), { statusCode: 403 });
  const attempts = [];
  const manager = createManager({
    async openPodExec(input) {
      attempts.push(input.shell);
      throw rejection;
    },
  });

  await assert.rejects(
    manager.openTerminal(POD_INPUT),
    (error) => error === rejection
  );
  assert.deepEqual(attempts, ['/bin/sh']);
});

test('PodInteractionManager retains forwards on page leave and stops them on complete disposal', async () => {
  const fakeClient = createFakeClient();
  const manager = createManager(fakeClient);
  const forward = await manager.startPortForward(FORWARD);

  await manager.disposePageScoped();
  assert.equal(fakeClient.closedForwardCount, 0);
  await manager.disposeAll();
  assert.equal(fakeClient.closedForwardCount, 1);
  await assert.rejects(manager.stopPortForward(forward.id), /not active/i);
});

test('PodInteractionManager rejects invalid port values before opening a client forward', async () => {
  const fakeClient = createFakeClient();
  const manager = createManager(fakeClient);

  await assert.rejects(
    manager.startPortForward({ ...FORWARD, remotePort: 8080.5 }),
    /remote port/i
  );
  await assert.rejects(
    manager.startPortForward({ ...FORWARD, localPort: 12.5 }),
    /local port/i
  );
  assert.equal(fakeClient.forwardInputs.length, 0);
});

test('PodInteractionManager rejects an eleventh active port forward before client handle creation', async () => {
  const fakeClient = createFakeClient();
  const manager = createManager(fakeClient);

  await Promise.all(Array.from({ length: 10 }, (_, index) => manager.startPortForward({
    ...FORWARD,
    localPort: 31_000 + index,
  })));
  await assert.rejects(manager.startPortForward(FORWARD), /10 active port forwards/);
  assert.equal(fakeClient.forwardInputs.length, 10);
});

test('PodInteractionManager closes a log handle that resolves after page disposal', async () => {
  const opening = deferred();
  let closed = 0;
  const manager = createManager({
    openPodLog() {
      return opening.promise;
    },
  });

  const openingLogs = manager.openLogs(POD_INPUT);
  await manager.disposePageScoped();
  opening.resolve(createHandle(() => { closed += 1; }));

  await assert.rejects(openingLogs, /closed before it could open/i);
  assert.equal(closed, 1);
});

test('PodInteractionManager closes an older log handle that resolves after page disposal', async () => {
  const olderOpening = deferred();
  const initialHandle = createHandle();
  let olderClosed = 0;
  let calls = 0;
  const manager = createManager({
    async openPodLog(_input, callbacks) {
      calls += 1;
      if (calls === 1) {
        callbacks.onLine('2026-07-12T01:02:03.000Z first');
        return initialHandle;
      }
      return olderOpening.promise;
    },
  });
  const logs = await manager.openLogs(POD_INPUT);
  const loadingOlder = manager.loadOlderLogs(logs.sessionId);
  await manager.disposePageScoped();
  olderOpening.resolve(createHandle(() => { olderClosed += 1; }));

  await assert.rejects(loadingOlder, /closed before it could load older logs/i);
  assert.equal(olderClosed, 1);
});

test('PodInteractionManager closes a terminal handle that resolves after page disposal', async () => {
  const opening = deferred();
  let closed = 0;
  const manager = createManager({
    openPodExec() {
      return opening.promise;
    },
  });

  const openingTerminal = manager.openTerminal(POD_INPUT);
  await manager.disposePageScoped();
  opening.resolve({
    write() {},
    resize() {},
    async close() {
      closed += 1;
    },
  });

  await assert.rejects(openingTerminal, /closed before it could open/i);
  assert.equal(closed, 1);
});

test('PodInteractionManager closes a port forward handle that resolves after complete disposal', async () => {
  const opening = deferred();
  let closed = 0;
  const manager = createManager({
    openPortForward() {
      return opening.promise;
    },
  });

  const openingForward = manager.startPortForward(FORWARD);
  await manager.disposeAll();
  opening.resolve({
    localPort: 41000,
    async close() {
      closed += 1;
    },
  });

  await assert.rejects(openingForward, /closed before it could start/i);
  assert.equal(closed, 1);
});

test('PodInteractionManager stops log mutation while paused, creates a new stream on resume, and clears the buffer', async () => {
  const streams = [];
  let closed = 0;
  const manager = createManager({
    async openPodLog(input, callbacks) {
      streams.push({ input, callbacks });
      return createHandle(() => { closed += 1; });
    },
  });
  const logs = await manager.openLogs(POD_INPUT);
  streams[0].callbacks.onLine('first');

  const paused = await manager.setLogFollowing(logs.sessionId, false);
  streams[0].callbacks.onLine('ignored while paused');
  assert.equal(paused.following, false);
  assert.deepEqual(paused.lines, ['first']);
  assert.equal(closed, 1);

  const resumed = await manager.setLogFollowing(logs.sessionId, true);
  assert.equal(resumed.following, true);
  assert.deepEqual(streams[1].input, {
    ...POD_INPUT,
    tailLines: 1,
    follow: true,
  });
  streams[1].callbacks.onLine('second');
  assert.deepEqual(manager.clearLogs(logs.sessionId).lines, []);
  assert.deepEqual((await manager.setLogFollowing(logs.sessionId, false)).lines, []);
});

test('PodInteractionManager Resume retrieves a bounded timestamped backlog instead of only its newest line', async () => {
  const streams = [];
  const anchor = '2026-07-15T08:00:00.000Z before pause';
  const missedFirst = '2026-07-15T08:00:01.000Z missed first';
  const missedSecond = '2026-07-15T08:00:02.000Z missed second';
  const manager = createManager({
    async openPodLog(input, callbacks) {
      streams.push({ input, callbacks });
      if (streams.length === 2) {
        callbacks.onLine(anchor);
        callbacks.onLine(missedFirst);
        callbacks.onLine(missedSecond);
      }
      return createHandle();
    },
  });
  const opened = await manager.openLogs(POD_INPUT);
  streams[0].callbacks.onLine(anchor);
  await manager.setLogFollowing(opened.sessionId, false);

  const resumed = await manager.setLogFollowing(opened.sessionId, true);

  assert.deepEqual(streams[1].input, {
    ...POD_INPUT,
    tailLines: 500,
    follow: true,
    sinceTime: '2026-07-15T08:00:00.000Z',
  });
  assert.deepEqual(resumed.lines, [anchor, missedFirst, missedSecond]);
  await manager.closeLogs(opened.sessionId);
});

test('PodInteractionManager prepends older lines without replacing concurrent follow lines', async () => {
  const oldest = '2026-07-12T01:02:03.000Z first';
  const newer = '2026-07-12T01:02:04.000Z new';
  const older = '2026-07-12T01:02:02.000Z older';
  const olderComplete = deferred();
  const streams = [];
  let call = 0;
  const manager = createManager({
    async openPodLog(input, callbacks) {
      call += 1;
      streams.push({ input, callbacks });
      if (call === 1) {
        callbacks.onLine(oldest);
        return createHandle();
      }
      return {
        completed: olderComplete.promise,
        async close() {},
      };
    },
  });
  const logs = await manager.openLogs(POD_INPUT);
  const loadingOlder = manager.loadOlderLogs(logs.sessionId);
  assert.equal('sinceTime' in streams[1].input, false);
  assert.equal(streams[1].input.tailLines > logs.lines.length, true);
  streams[0].callbacks.onLine(newer);
  streams[1].callbacks.onLine(older);
  streams[1].callbacks.onLine(oldest);
  olderComplete.resolve();

  const state = await loadingOlder;
  assert.deepEqual(state.lines, [older, oldest, newer]);
});

test('PodInteractionManager finds the newest repeated-line overlap while retaining a concurrent suffix within the cap', async () => {
  const olderPrefix = 'older-prefix';
  const repeated = 'repeated-anchor';
  const anchorTail = 'anchor-tail';
  const concurrentSuffix = 'concurrent-follow-suffix';
  const retained = [
    repeated,
    anchorTail,
    ...Array.from({ length: 1_996 }, (_, index) => `retained-${index}`),
  ];
  const snapshot = [olderPrefix, repeated, ...retained];
  const snapshotComplete = deferred();
  const streams = [];
  let calls = 0;
  const manager = createManager({
    async openPodLog(input, callbacks) {
      calls += 1;
      streams.push({ input, callbacks });
      if (calls === 1) {
        for (const line of retained) {
          callbacks.onLine(line);
        }
        return createHandle();
      }
      return {
        completed: snapshotComplete.promise,
        async close() {},
      };
    },
  });
  const logs = await manager.openLogs(POD_INPUT);
  const loadingOlder = manager.loadOlderLogs(logs.sessionId);

  assert.equal(streams[1].input.tailLines, 2_000);
  streams[0].callbacks.onLine(concurrentSuffix);
  for (const line of snapshot) {
    streams[1].callbacks.onLine(line);
  }
  snapshotComplete.resolve();

  const state = await loadingOlder;
  assert.equal(state.lines.length, 2_000);
  assert.deepEqual(state.lines.slice(0, 3), [repeated, repeated, anchorTail]);
  assert.equal(state.lines.includes(olderPrefix), false);
  assert.equal(state.lines.at(-1), concurrentSuffix);
  await manager.closeLogs(logs.sessionId);
});

test('PodInteractionManager retries an asynchronous shell-status failure but not a normal terminal close', async () => {
  const attempts = [];
  let closed = 0;
  const manager = createManager({
    async openPodExec(input, callbacks) {
      attempts.push({ input, callbacks });
      return {
        write() {},
        resize() {},
        async close() {
          closed += 1;
        },
      };
    },
  });
  const terminal = await manager.openTerminal(POD_INPUT);
  assert.equal(terminal.shell, '/bin/sh');

  attempts[0].callbacks.onStatusFailure(new Error('/bin/sh: not found'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(attempts.map(({ input }) => input.shell), ['/bin/sh', 'ash']);
  assert.equal(closed, 1);

  attempts[1].callbacks.onStatusFailure(new Error('ash: not found'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(attempts.map(({ input }) => input.shell), ['/bin/sh', 'ash', 'bash']);
  assert.equal(closed, 2);

  attempts[2].callbacks.onClose();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(attempts.map(({ input }) => input.shell), ['/bin/sh', 'ash', 'bash']);
});

test('PodInteractionManager finalizes remotely closed and failed terminals once without late output revival', async () => {
  const attempts = [];
  let closed = 0;
  const manager = createManager({
    async openPodExec(_input, callbacks) {
      attempts.push(callbacks);
      return {
        write() {},
        resize() {},
        async close() {
          closed += 1;
        },
      };
    },
  });
  const states = [];
  const output = [];
  manager.onTerminalChanged((state) => states.push(state));
  manager.onTerminalOutput((event) => output.push(event));

  const normallyClosed = await manager.openTerminal(POD_INPUT);
  attempts[0].onClose();
  await new Promise((resolve) => setImmediate(resolve));
  attempts[0].onClose();
  attempts[0].onError(new Error('late failure'));
  attempts[0].onData('late normal-close output');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(states.filter((state) => state.id === normallyClosed.id && state.state === 'closed').length, 1);
  assert.equal(closed, 1);
  assert.equal(output.length, 0);
  assert.throws(() => manager.writeTerminal(normallyClosed.id, 'late input'), /not active/i);
  assert.throws(() => manager.resizeTerminal(normallyClosed.id, 80, 24), /not active/i);

  const failed = await manager.openTerminal(POD_INPUT);
  attempts[1].onError(new Error('exec stream lost'));
  await new Promise((resolve) => setImmediate(resolve));
  attempts[1].onError(new Error('late duplicate failure'));
  attempts[1].onClose();
  attempts[1].onData('late error output');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(states.filter((state) => state.id === failed.id && state.state === 'error').length, 1);
  assert.equal(states.find((state) => state.id === failed.id && state.state === 'error').error, 'exec stream lost');
  assert.equal(closed, 2);
  assert.equal(output.length, 0);
  assert.throws(() => manager.writeTerminal(failed.id, 'late input'), /not active/i);
  assert.throws(() => manager.resizeTerminal(failed.id, 80, 24), /not active/i);

  await manager.disposePageScoped();
  assert.equal(closed, 2, 'finalized sessions must be removed before page cleanup');
});
