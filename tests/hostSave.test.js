const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const ts = require('typescript');
const { isDeepStrictEqual } = require('node:util');
const { HostRuntimeReconciler, planHostRuntimeChanges, sameServiceRuntime } = require('../dist/main/ssh/hostRuntimeReconcile');
const { KeyedOperationQueue } = require('../dist/main/core/operationQueue');
const { validateHostDraft, preserveServiceRuntimeFields } = require('../dist/main/ssh/validation');

const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function host() {
  return validateHostDraft({ id: 'fixture', name: 'Fixture', sshHost: 'example.invalid', sshPort: 22,
    username: 'fixture', authType: 'password', password: 'fixture', jumpHosts: [],
    forwards: [{ id: 'rule', name: 'Rule', localHost: '127.0.0.1', localPort: 33221,
      remoteHost: '127.0.0.1', remotePort: 8080, autoStart: true }],
    services: [{ id: 'service', name: 'Service', port: 8080, forwardLocalPort: 33222, startCommand: 'sleep 60' }] });
}

// Execute the real IPC/refresh functions with isolated storage and deferred network operations.
function mainHarness(overrides = {}) {
  const file = fs.readFileSync(path.join(__dirname, '../src/main/core/main.ts'), 'utf8');
  const source = ts.createSourceFile('main.ts', file, ts.ScriptTarget.Latest, true);
  const names = new Set(['runS3SharedDataMutation', 'mutateS3SharedData', 'refreshHostServicesRuntime',
    'hasSameServiceStatusEndpoint', 'serviceKey', 'serviceForwardKey', 'reconcileSavedHostRuntime']);
  const parts = [];
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && names.has(node.name?.text)) parts.push(node.getText(source));
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'ipcMain.handle'
      && node.arguments[0]?.getText(source) === 'IPC_CHANNELS.saveHost') parts.push(node.getText(source));
    ts.forEachChild(node, visit);
  }
  visit(source);
  let stored = host();
  stored.services[0].pid = 123;
  let save;
  const events = [];
  const context = vm.createContext({
    AbortController, isDeepStrictEqual, sameServiceRuntime, planHostRuntimeChanges,
    ipcMain: { handle: (_channel, handler) => { save = handler; } }, IPC_CHANNELS: { saveHost: 'save' },
    getStore: () => ({ findHostById: () => structuredClone(stored), listHosts: () => [structuredClone(stored)],
      upsertHost: async value => { stored = structuredClone(value); events.push('persist'); } }),
    privateKeyVault: { resolve: value => value }, validateHostDraft, preserveServiceRuntimeFields,
    tunnelManager: { setKnownTunnel() {}, stop: async () => events.push('stop-rule'), clearTunnel() {},
      start: async () => events.push('start-rule') },
    portForwardManager: { stopMany: async ids => { if (ids.length) events.push('stop-services'); },
      stop: async () => events.push('stop-service'), start: async () => events.push('start-service') },
    forwardOwners: new Map(), forwardToRuntimeConfig: async (_host, rule) => rule,
    sshTerminalRuntime: { reconcileHosts() {} }, toView: value => value,
    s3SyncRuntime: { markLocalChange() {} }, serviceOperationQueue: new KeyedOperationQueue(),
    autoStartAbortController: new AbortController(),
    checkHostServicesStatus: async (_host, services) => services.map(service => ({ serviceId: service.id, status: 'running', pid: 456 })),
    runtimeRegistry: { setServiceForwardStatus() {}, setServiceStatus: (...args) => args },
    serviceStatusChangeWithSilent: value => value, broadcast() {}, emitForwardStatus() {},
    logRuntimeError: (_scope, error) => { events.push(error.message); },
    ...overrides,
  });
  const reconciler = new HostRuntimeReconciler((...args) => context.reconcileSavedHostRuntime(...args),
    (_id, error) => events.push(error.message));
  context.hostRuntimeReconciler = reconciler;
  vm.runInContext(ts.transpileModule('let s3SharedDataMutationQueue = Promise.resolve();\n' + parts.join('\n'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  return { context, events, reconciler, save: draft => save({}, draft),
    get stored() { return structuredClone(stored); }, set stored(value) { stored = structuredClone(value); } };
}

test('adding or renaming a service preserves unchanged forwards', () => {
  const previous = host();
  const next = structuredClone(previous);
  next.name = 'Renamed';
  next.forwards[0].name = 'Renamed rule';
  next.services[0].name = 'Renamed service';
  next.services[0].pid = 999;
  next.services.push({ ...next.services[0], id: 'new' });
  assert.deepEqual(planHostRuntimeChanges(previous, next), {
    stopForwardIds: [], startForwards: [], stopServiceIds: [], refreshServiceIds: ['new'],
  });
});

test('changed, removed and endpoint-dependent connections are reconciled', () => {
  const previous = host();
  const next = structuredClone(previous);
  next.services[0].forwardLocalPort++;
  next.forwards[0].remotePort++;
  const plan = planHostRuntimeChanges(previous, next);
  assert.deepEqual(plan.stopServiceIds, ['service']);
  assert.deepEqual(plan.refreshServiceIds, ['service']);
  assert.deepEqual(plan.stopForwardIds, ['rule']);
  assert.equal(plan.startForwards.length, 1);
  next.services = []; next.forwards = [];
  assert.deepEqual(planHostRuntimeChanges(previous, next), {
    stopForwardIds: ['rule'], startForwards: [], stopServiceIds: ['service'], refreshServiceIds: [],
  });
  const endpoint = { ...previous, password: 'changed' };
  assert.deepEqual(planHostRuntimeChanges(previous, endpoint).stopServiceIds, ['service']);
});

test('Save Host and the next shared mutation finish while SSH is blocked', async () => {
  const remote = deferred();
  const harness = mainHarness({ checkHostServicesStatus: () => remote.promise });
  const draft = harness.stored;
  draft.services.push({ id: 'new', name: 'New', port: 8081, startCommand: 'sleep 60' });
  const saved = await harness.save(draft);
  assert.equal(saved.services.length, 2);
  assert.equal(saved.services[0].pid, 123);
  await tick();
  let mutationRan = false;
  await harness.context.mutateS3SharedData(async () => { mutationRan = true; });
  assert.equal(mutationRan, true);
  assert.deepEqual(harness.events, ['persist']);
  remote.resolve([{ serviceId: 'new', status: 'running', pid: 456 }]);
  await harness.reconciler.drain();
  assert.equal(harness.stored.services[1].pid, 456);
  assert.ok(!harness.events.includes('stop-rule'));
  assert.ok(!harness.events.includes('stop-service'));
});

test('invalid service causes no persistence or connection changes', async () => {
  const harness = mainHarness();
  const draft = harness.stored;
  draft.services.push({ name: 'Invalid', port: 8081, startCommand: '' });
  await assert.rejects(harness.save(draft), /Service/);
  await harness.reconciler.drain();
  assert.deepEqual(harness.events, []);
});

test('a slow forward does not hold the data queue and stale refresh results are discarded', async () => {
  const network = deferred();
  const started = deferred();
  let stopped = false;
  const harness = mainHarness({ portForwardManager: {
    start: () => { started.resolve(); return network.promise; }, stop: async () => { stopped = true; },
  } });
  const refresh = harness.context.refreshHostServicesRuntime('fixture', ['service'], false);
  await started.promise;
  await harness.context.mutateS3SharedData(async () => {
    const latest = harness.stored;
    latest.services[0].startCommand = 'new command';
    harness.stored = latest;
  });
  network.resolve();
  await refresh;
  assert.equal(stopped, true);
  assert.equal(harness.stored.services[0].pid, 123);
  assert.deepEqual(harness.events, []);
});

test('consecutive saves are serialized and queued targets coalesce', async () => {
  const blocked = deferred();
  const calls = [];
  const reconciler = new HostRuntimeReconciler(async (previous, next) => {
    calls.push([previous?.name, next.name]);
    if (calls.length === 1) await blocked.promise;
  }, assert.fail);
  const initial = host();
  const first = { ...initial, name: 'First' };
  reconciler.schedule(initial, first);
  await tick();
  reconciler.schedule(first, { ...initial, name: 'Second' });
  reconciler.schedule(first, { ...initial, name: 'Final' });
  assert.equal(calls.length, 1);
  blocked.resolve();
  await reconciler.drain();
  assert.deepEqual(calls, [['Fixture', 'First'], ['First', 'Final']]);
});

test('cancel and shutdown abort in-flight work and discard queued work', async () => {
  const blocked = deferred();
  const signals = [];
  const reconciler = new HostRuntimeReconciler(async (_previous, _next, signal) => {
    signals.push(signal); await blocked.promise;
  }, assert.fail);
  reconciler.schedule(undefined, host());
  await tick();
  reconciler.schedule(host(), { ...host(), name: 'Queued' });
  const cancelled = reconciler.cancel('fixture');
  assert.equal(signals[0].aborted, true);
  blocked.resolve();
  await cancelled;
  await reconciler.shutdown();
  reconciler.schedule(undefined, host());
  await tick();
  assert.equal(signals.length, 1);
});

test('host form blocks duplicate submissions and restores controls after failure or success', async () => {
  const source = ts.createSourceFile('renderer.ts', fs.readFileSync(path.join(__dirname, '../src/renderer/renderer.ts'), 'utf8'),
    ts.ScriptTarget.Latest, true);
  const parts = [];
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && ['setHostSavePending', 'closeHostDialog'].includes(node.name?.text)) {
      parts.push(node.getText(source));
    }
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'form.addEventListener'
      && node.arguments[0]?.getText(source) === "'submit'") parts.push(node.getText(source));
    ts.forEachChild(node, visit);
  }
  visit(source);
  let submit;
  let requests = 0;
  let closed = false;
  let errorMessage;
  let complete;
  let fail;
  const form = { inert: false, setAttribute() {}, addEventListener: (_event, listener) => { submit = listener; } };
  const context = vm.createContext({
    form, hostDialog: {}, saveHostButton: {}, closeHostDialogButton: {},
    targetNodeCard: { dataset: { nodeAuth: 'password' } },
    editingPrivateKeyPath: undefined, forwardAgentInput: { checked: true },
    collectJumpHostsDraft: () => [], collectForwardsFromEditor: () => [], collectServicesFromEditor: () => [],
    clearHostDialogMessage() {}, setHostDialogMessage: message => { errorMessage = message; },
    setActiveHostEditSection() {}, setMessage() {}, loadHosts: async () => {},
    closeDialog: () => { closed = true; },
    window: { serviceApi: { saveHost: () => {
      requests++;
      return new Promise((resolve, reject) => { complete = resolve; fail = reject; });
    } } },
  });
  for (const name of ['hostIdInput', 'nameInput', 'sshHostInput', 'sshPortInput', 'usernameInput',
    'passwordInput', 'hostVaultKey', 'privateKeyInput', 'passphraseInput']) context[name] = { value: 'fixture' };
  vm.runInContext(ts.transpileModule("let hostSavePending = false; let hostDialogMode = 'edit';\n" + parts.join('\n'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  const event = { preventDefault() {} };
  const first = submit(event);
  assert.equal(form.inert, true);
  assert.equal(context.saveHostButton.textContent, 'Saving...');
  await submit(event);
  assert.equal(requests, 1);
  context.closeHostDialog();
  assert.equal(closed, false);
  fail(new Error('Save failed'));
  await first;
  assert.equal(errorMessage, 'Save failed');
  assert.equal(form.inert, false);
  assert.equal(context.saveHostButton.disabled, false);
  assert.equal(closed, false);
  const retry = submit(event);
  complete();
  await retry;
  assert.equal(requests, 2);
  assert.equal(closed, true);
  assert.equal(form.inert, false);
  assert.equal(context.saveHostButton.textContent, 'Save Host');
});
