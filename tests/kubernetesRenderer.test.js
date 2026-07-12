const test = require('node:test');
const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');

const distRenderer = path.join(__dirname, '..', 'dist', 'renderer');

test('Kubernetes documentation states the supported read-only, bounded runtime contract', async () => {
  const root = path.join(__dirname, '..');
  const documents = await Promise.all([
    readFile(path.join(root, 'README.md'), 'utf8'),
    readFile(path.join(root, 'AGENTS.md'), 'utf8'),
  ]);

  for (const document of documents) {
    assert.match(document, /\.kube/i);
    assert.match(document, /first level.*direct regular files|direct regular files.*first level|first-level.*regular files/i);
    assert.match(document, /duplicate Context.*filename|filename.*duplicate Context/i);
    assert.match(document, /Windows/);
    assert.match(document, /token.*client-certificate|client-certificate.*token/i);
    assert.match(document, /token(?: authentication)? or (?:a )?complete matching client-certificate\/client-key pair/i);
    assert.match(document, /exec.*not supported|not supported.*exec/i);
    assert.match(document, /auth-provider.*not supported|not supported.*auth-provider/i);
    assert.match(document, /Kubernetes 1\.28\+/);
    assert.match(document, /strictly read-only/i);
    assert.match(document, /one active Context/i);
    assert.match(document, /All Namespaces.*selected Namespaces|selected Namespaces.*All Namespaces/i);
    assert.match(document, /200(?:-item| items?| resource)? (?:page|paging)|page(?:s)? of 200/i);
    assert.match(document, /virtual (?:scrolling|table|list)/i);
    assert.match(document, /active(?:-view| view) Watch/i);
    assert.match(document, /2,000(?:-line| lines?) log/i);
    assert.match(document, /ten (?:active )?port forwards|10 (?:active )?port forwards/i);
    assert.match(document, /Secret.*(?:never|not).*persist|Secret.*non-persist/i);
    assert.match(document, /pnpm install.*(?:Kubernetes|xterm)|(?:Kubernetes|xterm).*pnpm install/i);
  }
});

test('Kubernetes page provides a read-only resource browser shell', async () => {
  const html = await readFile(path.join(distRenderer, 'index.html'), 'utf8');
  const page = await readFile(path.join(distRenderer, 'kubernetesPage.js'), 'utf8');

  assert.match(html, /<main class="app-shell hidden" data-page="kubernetes">/);
  assert.match(html, /class="kubernetes-page"/);
  assert.match(html, /id="kubernetes-context"/);
  assert.match(html, /id="kubernetes-reconnect"/);
  assert.match(html, /id="kubernetes-namespace-menu"/);
  assert.match(html, /All Namespaces/);
  assert.match(html, /id="kubernetes-category-tabs"/);
  assert.match(html, /id="kubernetes-resource-tabs"/);
  assert.match(html, /id="kubernetes-custom-resource-select"/);
  assert.match(html, /id="kubernetes-loaded-count"/);
  assert.match(html, /id="kubernetes-table-viewport"/);
  assert.match(html, /id="kubernetes-table-spacer"/);
  assert.match(html, /id="kubernetes-no-permission"/);
  assert.match(page, /tlsVerificationDisabled/);
  assert.match(page, /registerPage\(\{[\s\S]*?id: 'kubernetes'/);
  assert.match(page, /onShow:/);
  assert.match(page, /onHide:/);
  assert.match(page, /deactivatePage\(\)/);
  assert.match(page, /window\.kubernetesApi\.reconnect\(\)/);
  assert.match(page, /state\?\.connection === 'disconnected'/);
  assert.match(page, /this\.reconnecting/);
  assert.match(page, /context\.supported \? context\.displayName : `\$\{context\.displayName\} \(unsupported\)`/);
  assert.doesNotMatch(page, /option\.textContent = context\.supported \? context\.name/);
  assert.match(page, /listCustomResourceDefinitions\(\)/);
  assert.match(page, /apiVersion: `\$\{definition\.group\}\/\$\{definition\.version\}`/);
  for (const mutation of ['Delete', 'Scale', 'Apply', 'Restart']) {
    assert.doesNotMatch(html, new RegExp(`>${mutation}<`));
    assert.doesNotMatch(page, new RegExp(`['\"]${mutation}['\"]`));
  }
});

test('Kubernetes virtual table calculates a bounded render window for ten thousand items', async () => {
  const { calculateVirtualWindow } = await import(path.join(distRenderer, 'kubernetesVirtualTable.js'));
  const window = calculateVirtualWindow({
    itemCount: 10_000,
    rowHeight: 36,
    viewportHeight: 720,
    scrollTop: 180_000,
    overscan: 8,
  });

  assert.ok(window.start > 0);
  assert.ok(window.end <= 10_000);
  assert.ok(window.end - window.start < 50);
  assert.equal(window.offsetTop, window.start * 36);
});

test('Kubernetes renderer keeps dynamic resource names text-safe and debounces loaded-only filtering', async () => {
  const page = await readFile(path.join(distRenderer, 'kubernetesPage.js'), 'utf8');
  const table = await readFile(path.join(distRenderer, 'kubernetesVirtualTable.js'), 'utf8');

  assert.match(page, /SEARCH_DEBOUNCE_MS = 200/);
  assert.match(page, /nameFilter:/);
  assert.match(page, /Sorted loaded items only/);
  assert.match(page, /const fields = \[item\.name,/);
  assert.match(page, /cell\.textContent = value/);
  assert.doesNotMatch(page, /innerHTML\s*=\s*[^;]*(?:item|summary)\.(?:name|namespace)/);
  assert.doesNotMatch(page, /snapshot\.items\.filter\(/);
  assert.match(table, /requestAnimationFrame/);
  assert.match(table, /total \* options\.rowHeight/);
  assert.match(table, /onWindowChange/);
  assert.doesNotMatch(table, /localeCompare/);
});

test('Kubernetes virtual table renders a bounded main-process window for ten thousand loaded rows', async () => {
  const originalWindow = global.window;
  const frames = [];
  const spacer = { style: {} };
  const rows = {
    style: {},
    children: [],
    replaceChildren(...children) {
      this.children = children;
    },
  };
  const container = {
    clientHeight: 720,
    scrollTop: 0,
    querySelector(selector) {
      if (selector === '#kubernetes-table-spacer') return spacer;
      if (selector === '#kubernetes-table-rows') return rows;
      return null;
    },
    addEventListener() {},
    removeEventListener() {},
  };
  global.window = {
    requestAnimationFrame(callback) {
      frames.push(callback);
      return frames.length;
    },
    cancelAnimationFrame() {},
  };
  try {
    const { createKubernetesVirtualTable } = await import(path.join(distRenderer, 'kubernetesVirtualTable.js'));
    let rendered = 0;
    const table = createKubernetesVirtualTable({
      container,
      rowHeight: 36,
      overscan: 8,
      renderRow(item) {
        rendered += 1;
        return { name: item.name };
      },
      onNearEnd() {},
      onWindowChange() {},
    });

    // The table sees only the requested window; it receives the total for
    // spacer height and scroll math, never the other 9,960 summaries.
    table.setWindow({
      start: 0,
      end: 40,
      total: 10_000,
      items: Array.from({ length: 40 }, (_, index) => ({
      uid: String(index), name: `pod-${index}`, resourceVersion: '1', columns: {},
      })),
    });
    while (frames.length > 0) frames.shift()();

    assert.ok(rendered < 50, `expected fewer than 50 rendered rows, received ${rendered}`);
    assert.equal(rows.children.length, rendered);
    assert.equal(rows.children[0].name, 'pod-0');
    table.dispose();
  } finally {
    global.window = originalWindow;
  }
});

test('Kubernetes page never auto-loads more pages for an active name filter', async () => {
  const { shouldAutomaticallyLoadMore } = await import(path.join(distRenderer, 'kubernetesPage.js'));
  const page = await readFile(path.join(distRenderer, 'kubernetesPage.js'), 'utf8');

  assert.equal(shouldAutomaticallyLoadMore({ ...{
    context: 'development', kind: 'pods', namespaceScope: { mode: 'selected', namespaces: ['apps'] },
  }, nameFilter: 'no-match' }), false);
  assert.equal(shouldAutomaticallyLoadMore({
    context: 'development', kind: 'pods', namespaceScope: { mode: 'selected', namespaces: ['apps'] },
  }), true);
  assert.match(page, /if \(!shouldAutomaticallyLoadMore\(query\)\)\s+return;/);
});

test('Kubernetes resource details are full-page, read-only, render YAML, and clear active Secret data on close', async () => {
  const html = await readFile(path.join(distRenderer, 'index.html'), 'utf8');
  const page = await readFile(path.join(distRenderer, 'kubernetesPage.js'), 'utf8');

  assert.match(html, /id="kubernetes-detail-page"/);
  assert.match(html, />Overview</);
  assert.match(html, />YAML</);
  assert.match(html, />Events</);
  assert.match(html, /id="kubernetes-detail-yaml"/);
  assert.match(page, /detailBackStack/);
  assert.match(page, /getResourceDetail\(/);
  assert.match(page, /getResourceEvents\(/);
  assert.match(page, /serializeKubernetesDetailYaml\(detail\)/);
  assert.match(page, /yaml\.textContent/);
  assert.match(page, /decodedSecretDetail\s*=\s*undefined/);
  assert.match(page, /this\.detailYaml\.textContent = ''/);
  assert.match(page, /Backend resources/);
  assert.match(page, /Related Pods/);
  assert.match(page, /getRelatedResources/);
  assert.match(page, /No permission/);
  assert.match(page, /name\.textContent/);
  assert.doesNotMatch(html, />Delete</);
  assert.doesNotMatch(html, />Scale</);
  assert.doesNotMatch(html, />Apply</);
  assert.doesNotMatch(html, />Restart</);
});

test('Kubernetes detail YAML uses the copied browser serializer and clipboard text matches rendered YAML', async () => {
  const html = await readFile(path.join(distRenderer, 'index.html'), 'utf8');
  const page = await readFile(path.join(distRenderer, 'kubernetesPage.js'), 'utf8');
  const copyRenderer = await readFile(path.join(__dirname, '..', 'scripts', 'copy-renderer.cjs'), 'utf8');
  const browserYaml = await readFile(path.join(distRenderer, 'js-yaml.umd.min.js'), 'utf8');
  const previousYaml = globalThis.jsyaml;
  const browserContext = { Object };
  browserContext.globalThis = browserContext;
  vm.runInNewContext(browserYaml, browserContext);
  globalThis.jsyaml = browserContext.jsyaml;

  try {
    const {
      serializeKubernetesDetailYaml,
      copyKubernetesDetailYaml,
    } = await import(path.join(distRenderer, 'kubernetesPage.js'));
    const detail = {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: 'example', namespace: 'apps' },
      data: { feature: 'enabled' },
    };
    const rendered = serializeKubernetesDetailYaml(detail);
    let copied = '';
    const returned = await copyKubernetesDetailYaml(detail, async (text) => {
      copied = text;
    });

    assert.match(rendered, /^apiVersion: v1$/m);
    assert.match(rendered, /^kind: ConfigMap$/m);
    assert.match(rendered, /^metadata:$/m);
    assert.doesNotMatch(rendered, /^\{/);
    assert.equal(copied, rendered);
    assert.equal(returned, rendered);
  } finally {
    globalThis.jsyaml = previousYaml;
  }

  assert.match(copyRenderer, /'js-yaml', 'dist', 'browser', 'js-yaml\.umd\.min\.js'/);
  assert.match(html, /<script src="\.\/js-yaml\.umd\.min\.js"><\/script>/);
  assert.match(browserYaml, /jsyaml/);
  assert.match(page, /serializeKubernetesDetailYaml/);
  assert.match(page, /copyKubernetesDetailYaml/);
  assert.doesNotMatch(page, /JSON\.stringify\(detail/);
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

test('Kubernetes related-resource loading does not render a closed detail after a deferred request resolves', async () => {
  const { runRelatedResourceRequest } = await import(path.join(distRenderer, 'kubernetesPage.js'));
  const request = deferred();
  let current = true;
  const updates = [];

  const loading = runRelatedResourceRequest(
    () => request.promise,
    {
      isCurrent: () => current,
      onLoading: () => updates.push('loading'),
      onSuccess: () => updates.push('render:old-detail'),
      onError: () => updates.push('error:old-detail'),
      onComplete: () => updates.push('complete'),
    },
  );
  current = false; // closeDetail synchronously invalidates the old detail.
  request.resolve({ pods: [] });
  await loading;

  assert.deepEqual(updates, ['loading']);
});

test('Kubernetes related-resource loading does not render or report an old detail after linked-Pod navigation', async () => {
  const { runRelatedResourceRequest } = await import(path.join(distRenderer, 'kubernetesPage.js'));
  const request = deferred();
  let current = true;
  const updates = [];

  const loading = runRelatedResourceRequest(
    () => request.promise,
    {
      isCurrent: () => current,
      onLoading: () => updates.push('loading'),
      onSuccess: () => updates.push('render:old-workload'),
      onError: () => updates.push('error:old-workload'),
      onComplete: () => updates.push('complete'),
    },
  );
  current = false; // openRelatedPod synchronously invalidates the workload relation.
  request.reject(new Error('forbidden'));
  await loading;

  assert.deepEqual(updates, ['loading']);
});

test('Kubernetes Pod interactions expose bounded logs, an xterm drawer, and read-only forward controls', async () => {
  const html = await readFile(path.join(distRenderer, 'index.html'), 'utf8');
  const page = await readFile(path.join(distRenderer, 'kubernetesPage.js'), 'utf8');
  const terminal = await readFile(path.join(distRenderer, 'kubernetesTerminal.js'), 'utf8');
  const copyRenderer = await readFile(path.join(__dirname, '..', 'scripts', 'copy-renderer.cjs'), 'utf8');

  assert.match(html, /id="kubernetes-log-panel"/);
  assert.match(html, /500 initial lines/);
  assert.match(html, /2,000 retained lines/);
  assert.match(html, /id="kubernetes-terminal-drawer"/);
  assert.match(html, /id="kubernetes-port-forward-dialog"/);
  assert.match(html, /id="kubernetes-port-forwards"/);
  assert.match(page, /setLogFollowing/);
  assert.match(page, /loadOlderLogs/);
  assert.match(page, /clearLogs/);
  assert.match(page, /closeLogs/);
  assert.match(page, /openTerminal/);
  assert.match(page, /startPortForward/);
  assert.match(page, /stopPortForward/);
  assert.match(page, /setMessage\(message, 'error'\)/);
  assert.match(terminal, /new runtime\.Terminal/);
  assert.match(terminal, /new runtime\.FitAddon/);
  assert.match(terminal, /terminal\.write/);
  assert.match(terminal, /onData/);
  assert.match(copyRenderer, /'@xterm', 'xterm', 'css', 'xterm\.css'/);
  assert.match(html, /xterm\.css/);
});

test('Kubernetes terminal drawer disposes final closed or errored sessions and ignores late revival events', async () => {
  const originalWindow = global.window;
  const originalDocument = global.document;
  const instances = [];
  const listeners = new Map();

  class FakeClassList {
    constructor() {
      this.values = new Set();
    }

    add(value) { this.values.add(value); }
    remove(value) { this.values.delete(value); }
    contains(value) { return this.values.has(value); }
  }

  class FakeElement {
    constructor() {
      this.children = [];
      this.parentElement = null;
      this.classList = new FakeClassList();
      this.listeners = new Map();
      this.textContent = '';
      this.className = '';
    }

    append(...children) {
      for (const child of children) this.appendChild(child);
    }

    appendChild(child) {
      child.parentElement = this;
      this.children.push(child);
      return child;
    }

    remove() {
      if (!this.parentElement) return;
      const index = this.parentElement.children.indexOf(this);
      if (index >= 0) this.parentElement.children.splice(index, 1);
      this.parentElement = null;
    }

    replaceChildren(...children) {
      this.children = [];
      this.append(...children);
    }

    setAttribute() {}
    addEventListener(name, listener) { this.listeners.set(name, listener); }
  }

  class FakeTerminal {
    constructor() {
      this.cols = 80;
      this.rows = 24;
      this.writes = [];
      this.disposeCount = 0;
      instances.push(this);
    }

    loadAddon() {}
    open() {}
    onData(listener) { this.onDataListener = listener; }
    write(data) { this.writes.push(data); }
    dispose() { this.disposeCount += 1; }
  }

  class FakeFitAddon {
    fit() {}
  }

  global.window = {
    Terminal: FakeTerminal,
    FitAddon: { FitAddon: FakeFitAddon },
    addEventListener(name, listener) { listeners.set(name, listener); },
    removeEventListener(name) { listeners.delete(name); },
    requestAnimationFrame(callback) {
      callback();
      return 1;
    },
  };
  global.document = { createElement: () => new FakeElement() };

  try {
    const { createKubernetesTerminalDrawer } = await import(path.join(distRenderer, 'kubernetesTerminal.js'));
    const root = new FakeElement();
    const drawer = createKubernetesTerminalDrawer({
      root,
      onInput: async () => {},
      onResize: async () => {},
      onClose: async () => {},
    });
    const normal = { id: 'terminal-normal', namespace: 'apps', podName: 'api', container: 'api', shell: '/bin/sh', state: 'open' };
    const failed = { ...normal, id: 'terminal-error' };

    drawer.open(normal);
    drawer.write(normal.id, 'visible');
    drawer.open({ ...normal, state: 'closed' });
    drawer.write(normal.id, 'late');
    drawer.open(normal);

    assert.equal(instances.length, 1);
    assert.equal(instances[0].disposeCount, 1);
    assert.deepEqual(instances[0].writes, ['visible']);
    assert.equal(root.children.length, 0);
    assert.equal(root.classList.contains('hidden'), true);

    drawer.open(failed);
    drawer.write(failed.id, 'visible error');
    drawer.open({ ...failed, state: 'error', error: 'exec stream lost' });
    drawer.write(failed.id, 'late error');
    drawer.open(failed);

    assert.equal(instances.length, 2);
    assert.equal(instances[1].disposeCount, 1);
    assert.deepEqual(instances[1].writes, ['visible error']);
    assert.equal(root.children.length, 0);
    assert.equal(root.classList.contains('hidden'), true);

    drawer.dispose();
  } finally {
    global.window = originalWindow;
    global.document = originalDocument;
  }
});

test('Kubernetes terminal errors dispose the drawer before the page reports the error', async () => {
  const page = await readFile(path.join(distRenderer, 'kubernetesPage.js'), 'utf8');
  const handlerStart = page.indexOf('onTerminalChanged(state) {');
  const handlerEnd = page.indexOf('onTerminalOutput', handlerStart);
  const handler = page.slice(handlerStart, handlerEnd);

  assert.match(handler, /state\.state === 'closed' \|\| state\.state === 'error'/);
  assert.ok(handler.indexOf('terminalDrawer?.open(state)') < handler.indexOf('setMessage(state.error'));
});
