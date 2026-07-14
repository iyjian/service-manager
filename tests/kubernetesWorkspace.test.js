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
  }

  append(...children) {
    for (const child of children) this.appendChild(child);
  }

  appendChild(child) {
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
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  scrollIntoView() {}
}

function findByAriaLabel(root, label) {
  if (root.getAttribute?.('aria-label') === label) return root;
  for (const child of root.children ?? []) {
    const found = findByAriaLabel(child, label);
    if (found) return found;
  }
  return undefined;
}

async function withWorkspaceDom(run) {
  const originalWindow = global.window;
  const originalDocument = global.document;
  const listeners = new Map();
  global.window = {
    addEventListener(name, listener) { listeners.set(name, listener); },
    removeEventListener(name) { listeners.delete(name); },
    requestAnimationFrame(callback) { callback(0); return 1; },
    cancelAnimationFrame() {},
  };
  global.document = {
    createElement: (tagName) => new FakeElement(tagName),
  };
  try {
    return await run();
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
