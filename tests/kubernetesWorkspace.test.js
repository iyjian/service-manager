const assert = require('node:assert/strict');
const test = require('node:test');
const { readFile } = require('node:fs/promises');
const path = require('node:path');

const distRenderer = path.join(__dirname, '..', 'dist', 'renderer');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

class FakeClassList {
  constructor() {
    this.values = new Set();
  }

  add(value) { this.values.add(value); }
  remove(value) { this.values.delete(value); }
  contains(value) { return this.values.has(value); }
  toggle(value, force) {
    const enabled = force === undefined ? !this.values.has(value) : force;
    if (enabled) this.values.add(value);
    else this.values.delete(value);
    return enabled;
  }
}

class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.classList = new FakeClassList();
    this.listeners = new Map();
    this.attributes = new Map();
    this.className = '';
    this.textContent = '';
    this.value = '';
    this.title = '';
    this.disabled = false;
    this.scrollTop = 0;
    this.scrollHeight = 400;
    this.clientHeight = 0;
    this.rectHeight = 0;
    this.style = { height: '', maxHeight: '' };
    this.capturedPointers = new Set();
  }

  append(...children) {
    for (const child of children) this.appendChild(child);
  }

  appendChild(child) {
    child.remove();
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  replaceChildren(...children) {
    for (const child of this.children) child.parentElement = null;
    this.children = [];
    this.append(...children);
  }

  remove() {
    if (!this.parentElement) return;
    const index = this.parentElement.children.indexOf(this);
    if (index >= 0) this.parentElement.children.splice(index, 1);
    this.parentElement = null;
  }

  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  removeEventListener(name, listener) {
    if (this.listeners.get(name) === listener) this.listeners.delete(name);
  }
  setPointerCapture(pointerId) { this.capturedPointers.add(pointerId); }
  releasePointerCapture(pointerId) { this.capturedPointers.delete(pointerId); }
  hasPointerCapture(pointerId) { return this.capturedPointers.has(pointerId); }
  getBoundingClientRect() {
    const inlineHeight = Number.parseFloat(this.style.height);
    return { height: Number.isFinite(inlineHeight) ? inlineHeight : this.rectHeight };
  }
  scrollIntoView() {}
}

class FakeTerminal {
  static instances = [];

  constructor(options) {
    this.options = options;
    this.writes = [];
    this.disposed = false;
    this.cols = 80;
    this.rows = 24;
    this.dataListener = undefined;
    FakeTerminal.instances.push(this);
  }

  loadAddon(addon) { this.addon = addon; }
  open(host) { this.host = host; }
  onData(listener) {
    this.dataListener = listener;
    return { dispose: () => { this.dataListener = undefined; } };
  }
  write(data) { this.writes.push(data); }
  focus() { this.focused = true; }
  dispose() { this.disposed = true; }
}

class FakeFitAddon {
  constructor() {
    this.fitCount = 0;
  }

  fit() { this.fitCount += 1; }
}

function findByAriaLabel(root, label) {
  if (root.getAttribute?.('aria-label') === label) return root;
  for (const child of root.children ?? []) {
    const found = findByAriaLabel(child, label);
    if (found) return found;
  }
  return undefined;
}

function findByClassName(root, className) {
  if ((root.className ?? '').split(/\s+/).includes(className)) return root;
  for (const child of root.children ?? []) {
    const found = findByClassName(child, className);
    if (found) return found;
  }
  return undefined;
}

async function withWorkspaceDom(run, { xterm = false, deferAnimationFrames = false } = {}) {
  const originalWindow = global.window;
  const originalDocument = global.document;
  const listeners = new Map();
  const frames = new Map();
  let nextFrameId = 0;
  const fakeWindow = {
    addEventListener(name, listener) {
      const handlers = listeners.get(name) ?? new Set();
      handlers.add(listener);
      listeners.set(name, handlers);
    },
    removeEventListener(name, listener) { listeners.get(name)?.delete(listener); },
    requestAnimationFrame(callback) {
      const id = ++nextFrameId;
      if (deferAnimationFrames) frames.set(id, callback);
      else callback(0);
      return id;
    },
    cancelAnimationFrame(id) { frames.delete(id); },
    innerHeight: 800,
  };
  if (xterm) {
    FakeTerminal.instances = [];
    fakeWindow.Terminal = FakeTerminal;
    fakeWindow.FitAddon = { FitAddon: FakeFitAddon };
  }
  global.window = fakeWindow;
  global.document = {
    createElement: (tagName) => new FakeElement(tagName),
    createElementNS: (_namespace, tagName) => new FakeElement(tagName),
  };
  try {
    const controls = {
      ...(xterm ? { Terminal: FakeTerminal, FitAddon: FakeFitAddon } : {}),
      listenerCount: (name) => listeners.get(name)?.size ?? 0,
      dispatchWindowEvent: (name, event = {}) => {
        for (const listener of listeners.get(name) ?? []) listener(event);
      },
      flushAnimationFrames: () => {
        const queued = [...frames.values()];
        frames.clear();
        for (const callback of queued) callback(0);
      },
    };
    return await run(controls);
  } finally {
    global.window = originalWindow;
    global.document = originalDocument;
  }
}

test('active drawer Env clears page-local values before drawer and page lifecycle transitions', async () => {
  const page = await readFile(path.join(distRenderer, 'kubernetesPage.js'), 'utf8');
  const method = (name, after) => {
    const start = page.indexOf(`    ${name}(`);
    const end = page.indexOf(`    ${after}(`, start);
    assert.ok(start >= 0 && end > start, `${name} method bounds`);
    return page.slice(start, end);
  };
  const hide = method('hide', 'destroy');
  const beginReplacement = method('beginDrawerReplacement', 'createDrawerRequest');
  const close = method('closeDetail', 'displayDetail');
  const state = method('onStateChanged', 'onListChanged');
  const environmentStart = page.indexOf('    renderContainerEnvironment(');
  const environmentEnd = page.indexOf('    createDrawerSection(', environmentStart);
  const environment = page.slice(environmentStart, environmentEnd);

  assert.match(hide, /this\.clearDrawerEnvironment\(\);/);
  assert.match(beginReplacement, /this\.clearDrawerEnvironment\(\);/);
  assert.match(close, /this\.clearDrawerEnvironment\(\);/);
  assert.match(state, /if \(contextChanged \|\| disconnected\) \{\s*this\.clearDrawerEnvironment\(\);/);
  assert.match(environment, /this\.clearDrawerEnvironment\(\);/);
  assert.match(page, /clearDrawerEnvironment\(\) \{/);
  assert.match(page, /this\.drawerEnvironment = undefined/);
});

test('same target and type reuses one tab while different types and Pods stay distinct', async () => {
  const { kubernetesWorkspaceTabKey, createKubernetesWorkspaceState } = await import('../dist/renderer/kubernetesWorkspace.js');
  const target = { namespace: 'apps', podName: 'api', container: 'web' };
  const state = createKubernetesWorkspaceState();
  const first = state.open('logs', target);
  const reused = state.open('logs', target);

  assert.equal(first.created, true);
  assert.equal(reused.created, false);
  assert.equal(reused.tab.id, first.tab.id);
  assert.equal(kubernetesWorkspaceTabKey('logs', target), 'logs\u0000apps\u0000api\u0000web');
  assert.notEqual(kubernetesWorkspaceTabKey('logs', target), kubernetesWorkspaceTabKey('shell', target));
  assert.notEqual(kubernetesWorkspaceTabKey('logs', target), kubernetesWorkspaceTabKey('logs', { ...target, podName: 'api-2' }));
  assert.notEqual(kubernetesWorkspaceTabKey('logs', target), kubernetesWorkspaceTabKey('logs', { ...target, container: 'worker' }));
});

test('workspace rejects stale log revisions and old terminal final events after close and reopen', async () => {
  const { createKubernetesWorkspaceState } = await import('../dist/renderer/kubernetesWorkspace.js');
  const target = { namespace: 'apps', podName: 'api', container: 'web' };
  const state = createKubernetesWorkspaceState();
  const first = state.open('shell', target).tab;
  assert.equal(state.bindTerminal(first.id, 'terminal-old'), true);
  assert.equal(state.close(first.id), true);
  const second = state.open('shell', target).tab;
  assert.notEqual(second.id, first.id);
  assert.equal(state.bindTerminal(second.id, 'terminal-new'), true);
  assert.equal(state.routeTerminalFinal({ id: 'terminal-old', state: 'closed' }), false);
  assert.deepEqual(state.tabs().map((tab) => tab.id), [second.id]);

  const logTab = state.open('logs', target).tab;
  assert.equal(state.bindLog(logTab.id, {
    sessionId: 'log-1', ...target, lines: ['new'], following: false, hasOlder: false, revision: 8,
  }), true);
  assert.equal(state.applyLog({
    sessionId: 'log-1', ...target, lines: ['old'], following: true, hasOlder: false, revision: 7,
  }), false);
  assert.equal(state.logForSession('log-1')?.following, false);
  assert.deepEqual(state.logForSession('log-1')?.lines, ['new']);
  assert.equal(state.applyLog({
    sessionId: 'log-1', ...target, lines: ['new'], following: false, hasOlder: false, revision: 8,
  }), true);
  assert.equal(state.applyLog({
    sessionId: 'unknown', ...target, lines: ['ignored'], following: true, hasOlder: false, revision: 99,
  }), false);
});

test('workspace disposal closes each live log and terminal session once through the direct seam', async () => {
  const { disposeKubernetesWorkspaceSessions } = await import('../dist/renderer/kubernetesWorkspace.js');
  const calls = [];
  await disposeKubernetesWorkspaceSessions([
    { type: 'logs', log: { sessionId: 'log-1', namespace: 'apps', podName: 'api', container: 'a', lines: [], following: true, hasOlder: false, revision: 1 } },
    { type: 'logs', log: { sessionId: 'log-1', namespace: 'apps', podName: 'api', container: 'a', lines: [], following: true, hasOlder: false, revision: 1 } },
    { type: 'shell', terminalId: 'terminal-1' },
    { type: 'shell', terminalId: 'terminal-1' },
  ], {
    closeLogs: async (id) => { calls.push(`log:${id}`); },
    closeTerminal: async (id) => { calls.push(`terminal:${id}`); },
  });
  assert.deepEqual(calls.sort(), ['log:log-1', 'terminal:terminal-1']);
});

test('workspace keeps reusable Logs and Shell tabs independent from the drawer and closes only the selected remote session', async () => {
  await withWorkspaceDom(async () => {
    const { createKubernetesWorkspace } = await import('../dist/renderer/kubernetesWorkspace.js');
    const root = new FakeElement('section');
    const tabList = new FakeElement('div');
    const pane = new FakeElement('div');
    const target = { namespace: 'apps', podName: 'api', container: 'web' };
    const otherPod = { ...target, podName: 'api-2' };
    const openedLogs = [];
    const openedShells = [];
    const closedLogs = [];
    const closedShells = [];
    const closeGate = deferred();
    const workspace = createKubernetesWorkspace({
      root,
      tabList,
      pane,
      openLogs: async (input) => {
        openedLogs.push(input);
        return {
          sessionId: `log-${input.podName}`,
          ...input,
          lines: ['ready'],
          following: true,
          hasOlder: false,
          revision: 1,
        };
      },
      setLogFollowing: async () => assert.fail('not used'),
      clearLogs: async () => assert.fail('not used'),
      closeLogs: async (id) => {
        closedLogs.push(id);
        await closeGate.promise;
      },
      openTerminal: async (input) => {
        openedShells.push(input);
        return { id: `terminal-${input.podName}`, ...input, shell: '/bin/sh', state: 'open' };
      },
      writeTerminal: async () => assert.fail('not used'),
      resizeTerminal: async () => assert.fail('not used'),
      closeTerminal: async (id) => { closedShells.push(id); },
      reportError: (error) => assert.fail(String(error)),
    });

    await workspace.openLogs(target);
    await workspace.openShell(target);
    await workspace.openLogs(target);
    await workspace.openLogs(otherPod);

    assert.equal(openedLogs.length, 2, 'same Logs target reuses its exact tab');
    assert.equal(openedShells.length, 1, 'Logs and Shell are separate target types');
    assert.equal(tabList.children.length, 3, 'different Pod target receives its own tab');
    assert.equal(root.classList.contains('hidden'), false);

    // Closing the drawer is intentionally not a workspace operation: the tab
    // list remains populated until its individual close control is used.
    assert.equal(tabList.children.length, 3);
    const closeLogs = findByAriaLabel(tabList, 'Close Logs apps/api · web');
    assert.ok(closeLogs);
    closeLogs.listeners.get('click')();
    assert.equal(tabList.children.length, 2, 'local tab is removed before remote close resolves');
    assert.deepEqual(closedLogs, ['log-api']);
    assert.equal(closedShells.length, 0, 'closing a Logs tab leaves Shell alive');
    closeGate.resolve();
    await Promise.resolve();

    await workspace.dispose();
    assert.deepEqual(closedLogs.sort(), ['log-api', 'log-api-2']);
    assert.deepEqual(closedShells, ['terminal-api']);
  });
});

test('workspace closes a remote session returned after its local tab closed and cannot attach it to a reopened same-key tab', async () => {
  await withWorkspaceDom(async () => {
    const { createKubernetesWorkspace } = await import('../dist/renderer/kubernetesWorkspace.js');
    const root = new FakeElement('section');
    const tabList = new FakeElement('div');
    const pane = new FakeElement('div');
    const target = { namespace: 'apps', podName: 'api', container: 'web' };
    const firstOpen = deferred();
    const secondOpen = deferred();
    const closeCalls = [];
    let opens = 0;
    const workspace = createKubernetesWorkspace({
      root,
      tabList,
      pane,
      openLogs: () => (++opens === 1 ? firstOpen.promise : secondOpen.promise),
      setLogFollowing: async () => assert.fail('not used'),
      clearLogs: async () => assert.fail('not used'),
      closeLogs: async (id) => { closeCalls.push(id); },
      openTerminal: async () => assert.fail('not used'),
      writeTerminal: async () => assert.fail('not used'),
      resizeTerminal: async () => assert.fail('not used'),
      closeTerminal: async () => assert.fail('not used'),
      reportError: (error) => assert.fail(String(error)),
    });

    const first = workspace.openLogs(target);
    const firstClose = findByAriaLabel(tabList, 'Close Logs apps/api · web');
    assert.ok(firstClose);
    firstClose.listeners.get('click')();
    const second = workspace.openLogs(target);
    assert.equal(tabList.children.length, 1, 'reopen creates one new unique tab instance');

    firstOpen.resolve({
      sessionId: 'late-log', ...target, lines: [], following: true, hasOlder: false, revision: 1,
    });
    await first;
    assert.deepEqual(closeCalls, ['late-log']);
    assert.equal(tabList.children.length, 1, 'late result cannot recreate or attach to the new tab');

    secondOpen.resolve({
      sessionId: 'fresh-log', ...target, lines: ['fresh'], following: true, hasOlder: false, revision: 1,
    });
    await second;
    await workspace.dispose();
    assert.deepEqual(closeCalls.sort(), ['fresh-log', 'late-log']);
  });
});

test('workspace tombstones terminal finals before a pending Shell open binds and routes output only to the active exact terminal', async () => {
  await withWorkspaceDom(async () => {
    const { createKubernetesWorkspace } = await import('../dist/renderer/kubernetesWorkspace.js');
    const root = new FakeElement('section');
    const tabList = new FakeElement('div');
    const pane = new FakeElement('div');
    const target = { namespace: 'apps', podName: 'api', container: 'web' };
    const opening = deferred();
    const terminalCloses = [];
    const workspace = createKubernetesWorkspace({
      root,
      tabList,
      pane,
      openLogs: async () => assert.fail('not used'),
      setLogFollowing: async () => assert.fail('not used'),
      clearLogs: async () => assert.fail('not used'),
      closeLogs: async () => assert.fail('not used'),
      openTerminal: () => opening.promise,
      writeTerminal: async () => assert.fail('not used'),
      resizeTerminal: async () => assert.fail('not used'),
      closeTerminal: async (id) => { terminalCloses.push(id); },
      reportError: (error) => assert.fail(String(error)),
    });

    const open = workspace.openShell(target);
    workspace.onTerminalChanged({ id: 'terminal-late', ...target, shell: '/bin/sh', state: 'closed' });
    workspace.onTerminalOutput({ id: 'terminal-other', data: 'must not mount a pane' });
    opening.resolve({ id: 'terminal-late', ...target, shell: '/bin/sh', state: 'open' });
    await open;

    assert.equal(tabList.children.length, 0, 'pre-bind final removes the stale Shell tab');
    assert.deepEqual(terminalCloses, ['terminal-late']);
  });
});

test('workspace reports a Shell open error after finalizing and closing only that Shell tab', async () => {
  await withWorkspaceDom(async () => {
    const { createKubernetesWorkspace } = await import('../dist/renderer/kubernetesWorkspace.js');
    const root = new FakeElement('section');
    const tabList = new FakeElement('div');
    const pane = new FakeElement('div');
    const target = { namespace: 'apps', podName: 'api', container: 'web' };
    const errors = [];
    const terminalCloses = [];
    const workspace = createKubernetesWorkspace({
      root,
      tabList,
      pane,
      openLogs: async () => assert.fail('not used'),
      setLogFollowing: async () => assert.fail('not used'),
      clearLogs: async () => assert.fail('not used'),
      closeLogs: async () => assert.fail('not used'),
      openTerminal: async () => ({
        id: 'terminal-failed', ...target, shell: '/bin/sh', state: 'error', error: 'exec forbidden',
      }),
      writeTerminal: async () => assert.fail('not used'),
      resizeTerminal: async () => assert.fail('not used'),
      closeTerminal: async (id) => { terminalCloses.push(id); },
      reportError: (error) => errors.push(error instanceof Error ? error.message : String(error)),
    });

    await workspace.openShell(target);

    assert.equal(tabList.children.length, 0, 'the final Shell result removes only its own local tab');
    assert.deepEqual(terminalCloses, ['terminal-failed']);
    assert.deepEqual(errors, ['exec forbidden']);
  });
});

test('workspace replays terminal output emitted before its Shell open result binds', async () => {
  await withWorkspaceDom(async ({ Terminal }) => {
    const { createKubernetesWorkspace } = await import('../dist/renderer/kubernetesWorkspace.js');
    const root = new FakeElement('section');
    const tabList = new FakeElement('div');
    const pane = new FakeElement('div');
    const target = { namespace: 'apps', podName: 'api', container: 'web' };
    const opening = deferred();
    const workspace = createKubernetesWorkspace({
      root,
      tabList,
      pane,
      openLogs: async () => assert.fail('not used'),
      setLogFollowing: async () => assert.fail('not used'),
      clearLogs: async () => assert.fail('not used'),
      closeLogs: async () => assert.fail('not used'),
      openTerminal: () => opening.promise,
      writeTerminal: async () => {},
      resizeTerminal: async () => {},
      closeTerminal: async () => {},
      reportError: (error) => assert.fail(String(error)),
    });

    const open = workspace.openShell(target);
    workspace.onTerminalOutput({ id: 'terminal-early', data: '# ' });
    opening.resolve({ id: 'terminal-early', ...target, shell: '/bin/sh', state: 'open' });
    await open;

    assert.equal(Terminal.instances.length, 1);
    assert.deepEqual(Terminal.instances[0].writes, ['# ']);
    workspace.onTerminalOutput({ id: 'terminal-early', data: 'ready\r\n' });
    assert.deepEqual(Terminal.instances[0].writes, ['# ', 'ready\r\n']);

    await workspace.dispose();
  }, { xterm: true });
});

test('workspace retains one shared resize listener plus the active Shell listener without duplicate refits', async () => {
  await withWorkspaceDom(async ({ Terminal, listenerCount, dispatchWindowEvent, flushAnimationFrames }) => {
    const { createKubernetesWorkspace } = await import('../dist/renderer/kubernetesWorkspace.js');
    const root = new FakeElement('section');
    const resizeHandle = new FakeElement('div');
    const tabList = new FakeElement('div');
    const pane = new FakeElement('div');
    const api = { namespace: 'apps', podName: 'api', container: 'web' };
    const api2 = { ...api, podName: 'api-2' };
    const workspace = createKubernetesWorkspace({
      root,
      resizeHandle,
      tabList,
      pane,
      openLogs: async (target) => ({
        sessionId: `log-${target.podName}`,
        ...target,
        lines: [],
        following: true,
        hasOlder: false,
        revision: 1,
      }),
      setLogFollowing: async () => assert.fail('not used'),
      clearLogs: async () => assert.fail('not used'),
      closeLogs: async () => {},
      openTerminal: async (target) => ({
        id: `terminal-${target.podName}`,
        ...target,
        shell: '/bin/sh',
        state: 'open',
      }),
      writeTerminal: async () => {},
      resizeTerminal: async () => {},
      closeTerminal: async () => {},
      reportError: (error) => assert.fail(String(error)),
    });

    assert.equal(listenerCount('resize'), 1, 'resizable workspace owns one baseline listener');
    await workspace.openShell(api);
    const first = Terminal.instances[0];
    assert.equal(listenerCount('resize'), 2);
    await workspace.openShell(api2);
    const second = Terminal.instances[1];
    assert.equal(listenerCount('resize'), 2);
    flushAnimationFrames();
    assert.equal(first.focused, undefined, 'first Shell focus callback was invalidated after selection changed');
    assert.equal(second.focused, true);

    root.style.height = '240px';
    const fitCountBeforeResize = second.addon.fitCount;
    dispatchWindowEvent('resize');
    flushAnimationFrames();
    assert.equal(second.addon.fitCount, fitCountBeforeResize + 1, 'window resize refits the active xterm once');

    await workspace.openLogs(api2);
    assert.equal(listenerCount('resize'), 1, 'Logs selection keeps only the workspace listener');
    await workspace.dispose();
    assert.equal(listenerCount('resize'), 0);
  }, { xterm: true, deferAnimationFrames: true });
});

test('workspace retains exact Shell xterms across tab changes and disposes only the closed terminal', async () => {
  await withWorkspaceDom(async ({ Terminal }) => {
    const { createKubernetesWorkspace } = await import('../dist/renderer/kubernetesWorkspace.js');
    const root = new FakeElement('section');
    const tabList = new FakeElement('div');
    const pane = new FakeElement('div');
    const api = { namespace: 'apps', podName: 'api', container: 'web' };
    const api2 = { ...api, podName: 'api-2' };
    const workspace = createKubernetesWorkspace({
      root,
      tabList,
      pane,
      openLogs: async (target) => ({
        sessionId: `log-${target.podName}`,
        ...target,
        lines: [],
        following: true,
        hasOlder: false,
        revision: 1,
      }),
      setLogFollowing: async () => assert.fail('not used'),
      clearLogs: async () => assert.fail('not used'),
      closeLogs: async () => {},
      openTerminal: async (target) => ({
        id: `terminal-${target.podName}`,
        ...target,
        shell: '/bin/sh',
        state: 'open',
      }),
      writeTerminal: async () => {},
      resizeTerminal: async () => {},
      closeTerminal: async () => {},
      reportError: (error) => assert.fail(String(error)),
    });

    await workspace.openShell(api);
    const selectedShell = findByAriaLabel(tabList, 'Shell apps/api · web');
    assert.ok(selectedShell);
    assert.equal(selectedShell.getAttribute('aria-selected'), 'true');
    assert.equal(selectedShell.textContent, 'apps/api · web');
    assert.match(selectedShell.parentElement?.className ?? '', /kubernetes-workspace-tab-shell/);
    const selectedShellClose = findByAriaLabel(tabList, 'Close Shell apps/api · web');
    assert.ok(selectedShellClose);
    assert.equal(selectedShellClose.children[0]?.tagName, 'SVG');
    workspace.onTerminalOutput({ id: 'terminal-api', data: '# ' });
    await workspace.openLogs(api);
    workspace.onTerminalOutput({ id: 'terminal-api', data: 'echo retained\r\n' });
    const selectApi = findByAriaLabel(tabList, 'Shell apps/api · web');
    assert.ok(selectApi);
    selectApi.listeners.get('click')();

    assert.equal(Terminal.instances.length, 1, 'returning to Shell reparents its retained xterm');
    const apiTerminal = Terminal.instances[0];
    assert.equal(apiTerminal.disposed, false);
    assert.deepEqual(apiTerminal.writes, ['# ', 'echo retained\r\n']);

    await workspace.openShell(api2);
    const api2Terminal = Terminal.instances[1];
    workspace.onTerminalOutput({ id: 'terminal-api', data: 'api background\r\n' });
    workspace.onTerminalOutput({ id: 'terminal-api-2', data: 'api-2 foreground\r\n' });
    const selectFirstApi = findByAriaLabel(tabList, 'Shell apps/api · web');
    assert.ok(selectFirstApi);
    selectFirstApi.listeners.get('click')();

    assert.deepEqual(apiTerminal.writes, ['# ', 'echo retained\r\n', 'api background\r\n']);
    assert.deepEqual(api2Terminal.writes, ['api-2 foreground\r\n']);
    const closeApi = findByAriaLabel(tabList, 'Close Shell apps/api · web');
    assert.ok(closeApi);
    closeApi.listeners.get('click')();

    assert.equal(apiTerminal.disposed, true);
    assert.equal(api2Terminal.disposed, false);
    workspace.onTerminalOutput({ id: 'terminal-api', data: 'late output\r\n' });
    assert.equal(Terminal.instances.length, 2);
    assert.deepEqual(apiTerminal.writes, ['# ', 'echo retained\r\n', 'api background\r\n']);

    await workspace.dispose();
  }, { xterm: true });
});

test('workspace height clamps between a compact minimum and eighty percent of its page', async () => {
  const { clampKubernetesWorkspaceHeight } = await import('../dist/renderer/kubernetesWorkspace.js');

  assert.equal(clampKubernetesWorkspaceHeight(20, 800), 120);
  assert.equal(clampKubernetesWorkspaceHeight(500, 800), 500);
  assert.equal(clampKubernetesWorkspaceHeight(900, 800), 640);
  assert.equal(clampKubernetesWorkspaceHeight(200, 100), 80, 'small pages keep the maximum authoritative');
});

test('workspace resize handle clamps pointer, keyboard, and window resize height, refits Shell, and cleans up listeners', async () => {
  await withWorkspaceDom(async ({ Terminal, listenerCount, dispatchWindowEvent, flushAnimationFrames }) => {
    const { createKubernetesWorkspace } = await import('../dist/renderer/kubernetesWorkspace.js');
    const page = new FakeElement('div');
    page.clientHeight = 800;
    const root = new FakeElement('section');
    root.rectHeight = 240;
    const resizeHandle = new FakeElement('div');
    const tabList = new FakeElement('div');
    const pane = new FakeElement('div');
    page.append(root);
    const target = { namespace: 'apps', podName: 'api', container: 'web' };
    const terminalResizes = [];
    const workspace = createKubernetesWorkspace({
      root,
      resizeHandle,
      tabList,
      pane,
      openLogs: async () => assert.fail('not used'),
      setLogFollowing: async () => assert.fail('not used'),
      clearLogs: async () => assert.fail('not used'),
      closeLogs: async () => assert.fail('not used'),
      openTerminal: async () => ({ id: 'terminal-api', ...target, shell: '/bin/sh', state: 'open' }),
      writeTerminal: async () => {},
      resizeTerminal: async (id, cols, rows) => { terminalResizes.push({ id, cols, rows }); },
      closeTerminal: async () => {},
      reportError: (error) => assert.fail(String(error)),
    });

    await workspace.openShell(target);
    flushAnimationFrames();
    const initialFitCount = Terminal.instances[0].addon.fitCount;
    const preventDefault = () => {};
    resizeHandle.listeners.get('pointerdown')({ pointerId: 7, clientY: 300, button: 0, isPrimary: true, preventDefault });
    resizeHandle.listeners.get('pointermove')({ pointerId: 7, clientY: -1000, preventDefault });
    assert.equal(root.style.height, '640px');
    assert.equal(root.style.maxHeight, '640px');
    assert.equal(resizeHandle.getAttribute('aria-valuemax'), '640');
    assert.equal(resizeHandle.getAttribute('aria-valuenow'), '640');
    assert.equal(resizeHandle.hasPointerCapture(7), true);
    flushAnimationFrames();
    assert.equal(Terminal.instances[0].addon.fitCount, initialFitCount + 1, 'drag refits without recreating xterm');
    assert.equal(terminalResizes.at(-1)?.id, 'terminal-api');

    resizeHandle.listeners.get('pointerup')({ pointerId: 7 });
    assert.equal(resizeHandle.hasPointerCapture(7), false);
    const heightAfterRelease = root.style.height;
    resizeHandle.listeners.get('pointermove')({ pointerId: 7, clientY: 500, preventDefault });
    assert.equal(root.style.height, heightAfterRelease, 'released pointer no longer changes workspace height');

    let prevented = false;
    resizeHandle.listeners.get('keydown')({ key: 'ArrowDown', preventDefault: () => { prevented = true; } });
    assert.equal(root.style.height, '620px');
    assert.equal(prevented, true);
    resizeHandle.listeners.get('keydown')({ key: 'Home', preventDefault });
    assert.equal(root.style.height, '120px');
    resizeHandle.listeners.get('keydown')({ key: 'End', preventDefault });
    assert.equal(root.style.height, '640px');

    page.clientHeight = 500;
    dispatchWindowEvent('resize');
    assert.equal(root.style.height, '400px');
    assert.equal(root.style.maxHeight, '400px');
    assert.equal(resizeHandle.getAttribute('aria-valuemax'), '400');
    assert.equal(resizeHandle.getAttribute('aria-valuenow'), '400');

    await workspace.dispose();
    assert.equal(resizeHandle.listeners.has('pointerdown'), false);
    assert.equal(listenerCount('resize'), 0);
    assert.equal(root.style.height, '');
    assert.equal(root.style.maxHeight, '');
  }, { xterm: true, deferAnimationFrames: true });
});

test('workspace panes omit duplicate target titles while tab accessible names remain complete', async () => {
  await withWorkspaceDom(async () => {
    const { createKubernetesWorkspace } = await import('../dist/renderer/kubernetesWorkspace.js');
    const root = new FakeElement('section');
    const resizeHandle = new FakeElement('div');
    const tabList = new FakeElement('div');
    const pane = new FakeElement('div');
    const target = { namespace: 'apps', podName: 'api', container: 'web' };
    const workspace = createKubernetesWorkspace({
      root,
      resizeHandle,
      tabList,
      pane,
      openLogs: async () => ({ sessionId: 'log-api', ...target, lines: ['ready'], following: true, hasOlder: false, revision: 1 }),
      setLogFollowing: async () => assert.fail('not used'),
      clearLogs: async () => assert.fail('not used'),
      closeLogs: async () => {},
      openTerminal: async () => ({ id: 'terminal-api', ...target, shell: '/bin/sh', state: 'open' }),
      writeTerminal: async () => {},
      resizeTerminal: async () => {},
      closeTerminal: async () => {},
      reportError: (error) => assert.fail(String(error)),
    });

    await workspace.openLogs(target);
    const logsTab = findByAriaLabel(tabList, 'Logs apps/api · web');
    assert.ok(logsTab);
    assert.equal(logsTab.textContent, 'apps/api · web');
    assert.equal(findByClassName(pane, 'kubernetes-workspace-pane-title'), undefined);
    assert.equal(pane.getAttribute('aria-label'), 'Logs apps/api · web');
    const toolbar = findByClassName(pane, 'kubernetes-log-toolbar');
    assert.ok(toolbar);
    assert.equal(toolbar.children.length, 3, 'toolbar contains only search, follow, and clear');

    await workspace.openShell(target);
    assert.equal(pane.getAttribute('aria-label'), 'Shell apps/api · web');
    assert.equal(findByClassName(pane, 'kubernetes-shell-panel-head'), undefined);
    const shellPanel = findByClassName(pane, 'kubernetes-shell-panel');
    assert.ok(shellPanel);
    assert.equal(shellPanel.children.length, 1, 'Shell pane gives all remaining space to xterm');

    await workspace.dispose();
  });
});
