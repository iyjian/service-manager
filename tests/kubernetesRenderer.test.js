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
    assert.match(document, /Namespace.*multi-select|multi-select.*Namespace/i);
    assert.match(document, /All Namespaces/);
    assert.match(document, /no manual Namespace|manual Namespace.*removed|without manual Namespace/i);
    assert.match(document, /Namespace.*(?:(?:outside.*(?:close|dismiss))|(?:(?:close|dismiss).*outside))/i);
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
    assert.match(document, /Pod logs.*automatically|automatically.*Pod logs/i);
    assert.match(document, /Logs.*search.*Follow.*Clear|search.*Follow.*Clear.*Logs/i);
    assert.match(document, /Overview.*single-line|single-line.*Overview/i);
    assert.match(document, /Age.*creation timestamp|creation timestamp.*Age/i);
    assert.match(document, /table-header.*sort|sort.*table-header/i);
    assert.match(document, /Custom Resources.*(?:directly|immediately).*select|select.*(?:directly|immediately).*Custom Resources/i);
    assert.match(document, /terminal.*(?:(?:focus|focused).*(?:visible|view)|(?:visible|view).*(?:focus|focused))/i);
    assert.match(document, /terminal input.*(?:spaces|whitespace).*Enter|(?:spaces|whitespace).*Enter.*terminal input/i);
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
  assert.doesNotMatch(html, /kubernetes-namespace-add|kubernetes-namespace-tags/);
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
  assert.match(page, /window\.kubernetesApi\.listNamespaces\(\)/);
  assert.match(page, /Loading Namespaces/);
  assert.match(page, /input\.type = 'checkbox'/);
  assert.match(page, /context\.supported \? context\.displayName : `\$\{context\.displayName\} \(unsupported\)`/);
  assert.doesNotMatch(page, /option\.textContent = context\.supported \? context\.name/);
  assert.match(page, /listCustomResourceDefinitions\(\)/);
  assert.match(page, /apiVersion: `\$\{definition\.group\}\/\$\{definition\.version\}`/);
  for (const mutation of ['Delete', 'Scale', 'Apply', 'Restart']) {
    assert.doesNotMatch(html, new RegExp(`>${mutation}<`));
    assert.doesNotMatch(page, new RegExp(`['\"]${mutation}['\"]`));
  }
});

test('Kubernetes Namespace multi-selection is sorted and falls back to All Namespaces', async () => {
  const { updateNamespaceSelection } = await import(path.join(distRenderer, 'kubernetesPage.js'));

  assert.deepEqual(updateNamespaceSelection(['monitoring'], 'apps', true), {
    mode: 'selected',
    namespaces: ['apps', 'monitoring'],
  });
  assert.deepEqual(updateNamespaceSelection(['apps'], 'apps', false), {
    mode: 'all',
    namespaces: [],
  });
  assert.deepEqual(updateNamespaceSelection(['apps'], 'monitoring', false), {
    mode: 'selected',
    namespaces: ['apps'],
  });
});

test('Kubernetes Namespace menu closes only for an outside pointer target', async () => {
  const { shouldCloseNamespaceMenu } = await import(path.join(distRenderer, 'kubernetesPage.js'));
  const inside = {};
  const outside = {};
  const control = { contains: (target) => target === inside };

  assert.equal(shouldCloseNamespaceMenu(control, inside), false);
  assert.equal(shouldCloseNamespaceMenu(control, outside), true);
  assert.equal(shouldCloseNamespaceMenu(control, null), false);
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
  assert.doesNotMatch(page, /Sorted loaded items only/);
  assert.match(page, /const fields = \[item\.name,/);
  assert.match(page, /cell\.textContent = value/);
  assert.doesNotMatch(page, /innerHTML\s*=\s*[^;]*(?:item|summary)\.(?:name|namespace)/);
  assert.doesNotMatch(page, /snapshot\.items\.filter\(/);
  assert.match(table, /requestAnimationFrame/);
  assert.match(table, /total \* options\.rowHeight/);
  assert.match(table, /onWindowChange/);
  assert.doesNotMatch(table, /localeCompare/);
});

test('Kubernetes table sorting is controlled by accessible header icons', async () => {
  const html = await readFile(path.join(distRenderer, 'index.html'), 'utf8');
  const page = await import(path.join(distRenderer, 'kubernetesPage.js'));
  const pageSource = await readFile(path.join(distRenderer, 'kubernetesPage.js'), 'utf8');
  const styles = await readFile(path.join(__dirname, '..', 'src', 'renderer', 'tailwind.css'), 'utf8');

  assert.deepEqual(page.nextKubernetesSort({ column: 'name', direction: 'asc' }, 'name'), {
    column: 'name',
    direction: 'desc',
  });
  assert.deepEqual(page.nextKubernetesSort({ column: 'name', direction: 'desc' }, 'name'), {
    column: 'name',
    direction: 'asc',
  });
  assert.deepEqual(page.nextKubernetesSort({ column: 'name', direction: 'desc' }, 'age'), {
    column: 'age',
    direction: 'asc',
  });
  for (const column of ['name', 'namespace', 'status', 'age']) {
    assert.match(html, new RegExp(`data-kubernetes-sort="${column}"`));
  }
  assert.match(html, /class="kubernetes-sort-icon"/);
  assert.match(pageSource, /aria-sort/);
  assert.match(pageSource, /nextKubernetesSort/);
  assert.match(styles, /\.kubernetes-table-sort\s*\{/);
  assert.match(styles, /\.kubernetes-sort-icon\s*\{/);
  assert.doesNotMatch(html, /kubernetes-sort-column|kubernetes-sort-direction|kubernetes-sort-hint|Sorted loaded items only/);
});

test('Custom Resources opens its discovery select without a redundant resource tab', async () => {
  const html = await readFile(path.join(distRenderer, 'index.html'), 'utf8');
  const page = await import(path.join(distRenderer, 'kubernetesPage.js'));

  assert.equal(page.categoryUsesResourceTabs('Workloads'), true);
  assert.equal(page.categoryUsesResourceTabs('Custom Resources'), false);
  assert.match(html, /id="kubernetes-custom-resource-select"/);
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

test('Kubernetes detail YAML uses the copied browser serializer and text-safe rendering without Copy', async () => {
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
    const { serializeKubernetesDetailYaml } = await import(path.join(distRenderer, 'kubernetesPage.js'));
    const detail = {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: 'example', namespace: 'apps' },
      data: { feature: 'enabled' },
    };
    const rendered = serializeKubernetesDetailYaml(detail);

    assert.match(rendered, /^apiVersion: v1$/m);
    assert.match(rendered, /^kind: ConfigMap$/m);
    assert.match(rendered, /^metadata:$/m);
    assert.doesNotMatch(rendered, /^\{/);
  } finally {
    globalThis.jsyaml = previousYaml;
  }

  assert.match(copyRenderer, /'js-yaml', 'dist', 'browser', 'js-yaml\.umd\.min\.js'/);
  assert.match(html, /<script src="\.\/js-yaml\.umd\.min\.js"><\/script>/);
  assert.match(browserYaml, /jsyaml/);
  assert.match(page, /serializeKubernetesDetailYaml/);
  assert.match(page, /yaml\.textContent = serializeKubernetesDetailYaml\(detail\)/);
  assert.doesNotMatch(page, /copyKubernetesDetailYaml/);
  assert.doesNotMatch(html, /id="kubernetes-detail-copy"/);
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
  const preload = await readFile(path.join(__dirname, '..', 'dist', 'main', 'preload.js'), 'utf8');
  const sharedTypes = await readFile(path.join(__dirname, '..', 'src', 'shared', 'types.ts'), 'utf8');
  const copyRenderer = await readFile(path.join(__dirname, '..', 'scripts', 'copy-renderer.cjs'), 'utf8');

  assert.match(html, /id="kubernetes-log-panel"/);
  assert.match(html, /id="kubernetes-log-terminal-tab"/);
  assert.match(html, /id="kubernetes-log-count"/);
  assert.match(html, /id="kubernetes-log-state"/);
  assert.match(html, /class="kubernetes-log-view-tabs"/);
  const logHeadStart = html.indexOf('<header class="kubernetes-log-head">');
  const logHead = html.slice(logHeadStart, html.indexOf('</header>', logHeadStart));
  assert.ok(logHeadStart >= 0);
  assert.match(logHead, /id="kubernetes-log-search"/);
  assert.match(logHead, /id="kubernetes-log-follow"/);
  assert.match(logHead, /id="kubernetes-log-clear"/);
  assert.doesNotMatch(html, /500 initial lines|2,000 retained lines|Search current 2,000-line buffer/);
  assert.doesNotMatch(html, /kubernetes-log-load-older|Load older 500/);
  assert.doesNotMatch(html, /id="kubernetes-log-open"|>Open logs</i);
  assert.doesNotMatch(html, /id="kubernetes-detail-pod-actions"|id="kubernetes-detail-service-actions"/);
  assert.match(html, /id="kubernetes-detail-port-forward"/);
  assert.match(html, /id="kubernetes-terminal-drawer"/);
  assert.ok(html.indexOf('id="kubernetes-terminal-drawer"') < html.indexOf('id="kubernetes-port-forwards"'));
  assert.match(html, /id="kubernetes-port-forward-dialog"/);
  assert.match(html, /id="kubernetes-port-forwards"/);
  assert.match(page, /setLogFollowing/);
  assert.doesNotMatch(page, /loadOlderLogs/);
  assert.doesNotMatch(preload, /loadOlderLogs|kubernetes:load-older-logs/);
  assert.doesNotMatch(sharedTypes, /interface KubernetesLogApi \{[\s\S]*?loadOlderLogs/);
  assert.match(page, /clearLogs/);
  assert.match(page, /closeLogs/);
  assert.match(page, /void this\.openLogsForSelectedContainer\(\)/);
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

test('Kubernetes detail tab rerenders keep existing log sessions incidental while real log actions follow', async () => {
  const page = await readFile(path.join(distRenderer, 'kubernetesPage.js'), 'utf8');
  const selectDetailTab = page.slice(
    page.indexOf('    async selectDetailTab(tab) {'),
    page.indexOf('    renderEvents(events) {'),
  );
  const renderDetail = page.slice(
    page.indexOf('    renderDetail() {'),
    page.indexOf('    renderDetailTabs(tab) {'),
  );
  const podActions = page.slice(
    page.indexOf('    renderPodActions(detail, active) {'),
    page.indexOf('    appendContainerOption(value, label, init) {'),
  );
  const openLogs = page.slice(
    page.indexOf('async openLogsForSelectedContainer()'),
    page.indexOf('async toggleLogFollowing()'),
  );
  const containerChange = page.slice(
    page.indexOf("this.containerSelect.addEventListener('change'"),
    page.indexOf("this.logFollowButton.addEventListener('click'"),
  );
  const logChanged = page.slice(
    page.indexOf('    onLogChanged(state) {'),
    page.indexOf('    selectedPodTarget() {'),
  );

  assert.match(selectDetailTab, /this\.renderDetail\(\)/);
  assert.match(renderDetail, /this\.renderPodActions\(detail, active\)/);
  assert.match(podActions, /this\.renderLogPanel\(\);[\s\S]*?void this\.openLogsForSelectedContainer\(\)/);
  assert.match(openLogs, /const existing = this\.logsByContainer\.get\(target\.container\);\s*if \(existing\)\s*return;/);
  assert.doesNotMatch(openLogs, /if \(existing\)[\s\S]{0,120}renderLogPanel\('follow'\)/);
  assert.match(containerChange, /this\.renderLogPanel\('follow'\);\s*void this\.openLogsForSelectedContainer\(\)/);
  assert.match(openLogs, /applyKubernetesLogUpdate\([\s\S]*?'follow',\s*true,?\s*\)/);
  assert.match(logChanged, /applyKubernetesLogUpdate\([\s\S]*?'follow',?\s*\)/);
});

class FakeKubernetesLogClassList {
  constructor() {
    this.values = new Set();
  }

  toggle(value, force) {
    if (force === undefined ? !this.values.has(value) : force) this.values.add(value);
    else this.values.delete(value);
  }

  remove(value) {
    this.values.delete(value);
  }

  contains(value) {
    return this.values.has(value);
  }
}

function kubernetesLogState(overrides = {}) {
  return {
    sessionId: 'session-app',
    podName: 'pod-1',
    namespace: 'apps',
    container: 'app',
    lines: ['first', 'second'],
    following: true,
    hasOlder: false,
    ...overrides,
  };
}

function createKubernetesLogViewportHarness(pageModule) {
  const frames = new Map();
  const requested = [];
  const cancelled = [];
  let nextFrame = 1;
  let state = {
    visible: true,
    detailGeneration: 1,
    selectedContainer: 'app',
    log: kubernetesLogState(),
    search: '',
  };
  const elements = {
    followButton: { disabled: false, textContent: '' },
    clearButton: { disabled: false },
    output: { textContent: '', scrollTop: 17, scrollHeight: 480 },
    count: { textContent: '' },
    state: { classList: new FakeKubernetesLogClassList() },
    stateLabel: { textContent: '' },
  };
  const viewport = pageModule.createKubernetesLogViewport({
    getState: () => state.sessions
      ? { ...state, log: state.sessions.get(state.selectedContainer) }
      : state,
    elements,
    requestFrame: (callback) => {
      const frame = nextFrame++;
      requested.push(frame);
      frames.set(frame, callback);
      return frame;
    },
    cancelFrame: (frame) => {
      cancelled.push(frame);
      frames.delete(frame);
    },
  });

  return {
    viewport,
    elements,
    frames,
    requested,
    cancelled,
    get state() { return state; },
    setState(next) { state = { ...state, ...next }; },
    runFrame(frame = requested.at(-1)) {
      const callback = frames.get(frame);
      assert.ok(callback, `expected animation frame ${frame}`);
      frames.delete(frame);
      callback(0);
    },
  };
}

test('Kubernetes log count label reports filtered and total retained lines', async () => {
  const pageModule = await import(path.join(distRenderer, 'kubernetesPage.js'));
  assert.equal(pageModule.formatKubernetesLogCount(0, 0), '0 lines');
  assert.equal(pageModule.formatKubernetesLogCount(1, 1), '1 line');
  assert.equal(pageModule.formatKubernetesLogCount(0, 1), '0 of 1 line');
  assert.equal(pageModule.formatKubernetesLogCount(12, 12), '12 lines');
  assert.equal(pageModule.formatKubernetesLogCount(3, 12), '3 of 12 lines');
});

test('Kubernetes log updates cache owned background sessions without granting repaint authority', async () => {
  const pageModule = await import(path.join(distRenderer, 'kubernetesPage.js'));
  const sessions = new Map();
  const selected = kubernetesLogState();
  assert.equal(pageModule.routeKubernetesLogUpdate(sessions, 'app', selected), 'stale');
  assert.equal(sessions.has('app'), false);
  assert.equal(pageModule.routeKubernetesLogUpdate(sessions, 'app', selected, true), 'selected');
  assert.equal(sessions.get('app'), selected);

  const sidecar = kubernetesLogState({
    sessionId: 'session-sidecar',
    container: 'sidecar',
    lines: ['sidecar-1'],
  });
  sessions.set('sidecar', sidecar);
  const background = { ...sidecar, lines: ['sidecar-1', 'sidecar-2'] };
  assert.equal(pageModule.routeKubernetesLogUpdate(sessions, 'app', background), 'background');
  assert.equal(sessions.get('sidecar'), background);

  const unowned = kubernetesLogState({ sessionId: 'session-metrics', container: 'metrics' });
  assert.equal(pageModule.routeKubernetesLogUpdate(sessions, 'app', unowned), 'stale');
  assert.equal(sessions.has('metrics'), false);

  const stale = { ...background, sessionId: 'old-sidecar-session', lines: ['stale'] };
  assert.equal(pageModule.routeKubernetesLogUpdate(sessions, 'app', stale), 'stale');
  assert.equal(sessions.get('sidecar'), background);
});

test('Kubernetes log open ownership survives a late completion from a closed detail', async () => {
  const pageModule = await import(path.join(distRenderer, 'kubernetesPage.js'));
  const requests = new Map();
  const key = 'apps\u0000pod-1\u0000app';
  const closedDetailRequest = pageModule.claimKubernetesLogOpen(requests, key);
  assert.ok(closedDetailRequest);
  assert.equal(pageModule.claimKubernetesLogOpen(requests, key), undefined);

  requests.clear();
  const reopenedDetailRequest = pageModule.claimKubernetesLogOpen(requests, key);
  assert.ok(reopenedDetailRequest);
  assert.notEqual(reopenedDetailRequest, closedDetailRequest);

  pageModule.releaseKubernetesLogOpen(requests, key, closedDetailRequest);
  assert.equal(requests.get(key), reopenedDetailRequest);
  pageModule.releaseKubernetesLogOpen(requests, key, reopenedDetailRequest);
  assert.equal(requests.has(key), false);
});

test('Kubernetes log open failure does not repaint the selected container after a switch', async () => {
  const pageModule = await import(path.join(distRenderer, 'kubernetesPage.js'));
  const harness = createKubernetesLogViewportHarness(pageModule);
  const requests = new Map();
  const key = 'apps\u0000pod-1\u0000app';
  const token = pageModule.claimKubernetesLogOpen(requests, key);
  assert.ok(token);
  harness.setState({
    selectedContainer: 'sidecar',
    log: kubernetesLogState({ sessionId: 'session-sidecar', container: 'sidecar' }),
  });
  harness.viewport.render('follow');

  const cached = [];
  let selectedEffects = 0;
  assert.equal(pageModule.applyKubernetesLogOpenFailure({
    requests,
    key,
    token,
    selectedContainer: 'sidecar',
    targetContainer: 'app',
    cache: () => cached.push('app'),
    renderSelected: () => { selectedEffects += 1; },
  }), 'background');
  assert.deepEqual(cached, ['app']);
  assert.equal(selectedEffects, 0);
  assert.equal(harness.frames.size, 1);
  assert.deepEqual(harness.cancelled, []);
  harness.runFrame(1);
  assert.equal(harness.elements.output.scrollTop, 480);

  requests.clear();
  assert.equal(pageModule.applyKubernetesLogOpenFailure({
    requests,
    key,
    token,
    selectedContainer: 'app',
    targetContainer: 'app',
    cache: () => cached.push('stale'),
    renderSelected: () => { selectedEffects += 1; },
  }), 'stale');
  assert.deepEqual(cached, ['app']);
  assert.equal(selectedEffects, 0);
});

test('Kubernetes log update routing renders only the selected owned session', async () => {
  const pageModule = await import(path.join(distRenderer, 'kubernetesPage.js'));
  const harness = createKubernetesLogViewportHarness(pageModule);
  const app = kubernetesLogState();
  const sidecar = kubernetesLogState({ sessionId: 'session-sidecar', container: 'sidecar' });
  const sessions = new Map([['app', app], ['sidecar', sidecar]]);
  harness.setState({ sessions, log: undefined });
  harness.elements.output.textContent = 'selected output';

  const background = { ...sidecar, lines: ['sidecar-only'] };
  assert.equal(
    pageModule.applyKubernetesLogUpdate(sessions, 'app', background, harness.viewport, 'follow'),
    'background',
  );
  assert.equal(harness.elements.output.textContent, 'selected output');
  assert.deepEqual(harness.requested, []);

  const selected = { ...app, lines: ['selected-new'] };
  assert.equal(
    pageModule.applyKubernetesLogUpdate(sessions, 'app', selected, harness.viewport, 'follow'),
    'selected',
  );
  assert.equal(harness.elements.output.textContent, 'selected-new');
  assert.deepEqual(harness.requested, [1]);

  sessions.clear();
  harness.elements.output.textContent = 'detail closed';
  assert.equal(
    pageModule.applyKubernetesLogUpdate(sessions, 'app', selected, harness.viewport, 'follow'),
    'stale',
  );
  assert.equal(sessions.size, 0);
  assert.equal(harness.elements.output.textContent, 'detail closed');
  assert.deepEqual(harness.requested, [1]);
});

test('Kubernetes log viewport follows selected output and preserves incidental, search, and paused renders', async () => {
  const pageModule = await import(path.join(distRenderer, 'kubernetesPage.js'));
  const harness = createKubernetesLogViewportHarness(pageModule);

  harness.viewport.render('follow');
  assert.equal(harness.elements.output.textContent, 'first\nsecond');
  assert.equal(harness.elements.count.textContent, '2 lines');
  assert.equal(harness.elements.followButton.textContent, 'Pause Follow');
  assert.equal(harness.elements.stateLabel.textContent, 'Live');
  assert.equal(harness.elements.state.classList.contains('kubernetes-log-state-live'), true);
  assert.deepEqual(harness.requested, [1]);
  assert.equal(harness.elements.output.scrollTop, 17);
  harness.runFrame(1);
  assert.equal(harness.elements.output.scrollTop, 480);

  harness.elements.output.scrollTop = 41;
  harness.setState({ search: 'first' });
  harness.viewport.render('preserve');
  assert.equal(harness.elements.output.textContent, 'first');
  assert.equal(harness.elements.count.textContent, '1 of 2 lines');
  assert.equal(harness.elements.output.scrollTop, 41);
  assert.deepEqual(harness.requested, [1]);

  harness.setState({
    search: '',
    log: kubernetesLogState({ lines: ['first', 'second', 'paused'], following: false }),
  });
  harness.elements.output.scrollTop = 29;
  harness.viewport.render('follow');
  assert.equal(harness.elements.followButton.textContent, 'Resume Follow');
  assert.equal(harness.elements.stateLabel.textContent, 'Paused');
  assert.equal(harness.elements.state.classList.contains('kubernetes-log-state-live'), false);
  assert.equal(harness.elements.output.scrollTop, 29);
  assert.deepEqual(harness.requested, [1]);

  harness.setState({ log: kubernetesLogState({ lines: ['first', 'second', 'resumed'] }) });
  harness.elements.output.scrollHeight = 720;
  harness.viewport.render('follow');
  assert.deepEqual(harness.requested, [1, 2]);
  harness.runFrame(2);
  assert.equal(harness.elements.output.scrollTop, 720);
});

test('Kubernetes log viewport preserves selected follow work through incidental renders and coalesces bursts', async () => {
  const pageModule = await import(path.join(distRenderer, 'kubernetesPage.js'));
  const harness = createKubernetesLogViewportHarness(pageModule);

  harness.viewport.render('follow');
  harness.elements.output.scrollTop = 23;
  harness.viewport.render();
  assert.deepEqual(harness.cancelled, []);
  assert.equal(harness.frames.size, 1);
  assert.equal(harness.elements.output.scrollTop, 23);
  harness.runFrame(1);
  assert.equal(harness.elements.output.scrollTop, 480);

  harness.elements.output.scrollTop = 23;
  harness.viewport.render('follow');
  harness.viewport.render('preserve');
  assert.deepEqual(harness.cancelled, [2]);
  assert.equal(harness.frames.size, 0);
  assert.equal(harness.elements.output.scrollTop, 23);

  harness.viewport.render('follow');
  harness.setState({ selectedContainer: 'sidecar' });
  harness.runFrame(3);
  assert.equal(harness.elements.output.scrollTop, 23);

  harness.setState({ selectedContainer: 'app' });
  for (let update = 0; update < 500; update += 1) {
    harness.setState({ log: kubernetesLogState({ lines: [`line-${update}`] }) });
    harness.viewport.render('follow');
  }
  assert.deepEqual(harness.requested, [1, 2, 3, 4]);
  assert.equal(harness.frames.size, 1);
  assert.equal(harness.elements.output.textContent, 'line-499');
  harness.elements.output.scrollHeight = 960;
  harness.runFrame(4);
  assert.equal(harness.elements.output.scrollTop, 960);
});

test('Kubernetes log auto-scroll coalesces high-frequency updates without starving the pending frame', async () => {
  const pageModule = await import(path.join(distRenderer, 'kubernetesPage.js'));
  const frames = new Map();
  const requested = [];
  const cancelled = [];
  let nextFrame = 1;
  const runFrame = (frame) => {
    const callback = frames.get(frame);
    frames.delete(frame);
    callback(0);
  };
  const scheduler = pageModule.createKubernetesLogAutoScrollScheduler(
    (callback) => {
      const frame = nextFrame++;
      requested.push(frame);
      frames.set(frame, callback);
      return frame;
    },
    (frame) => {
      cancelled.push(frame);
      frames.delete(frame);
    },
  );

  let applied = -1;
  for (let update = 0; update < 500; update += 1) {
    scheduler.schedule('session-1\u0000container-1\u00001', () => { applied = update; });
  }

  assert.deepEqual(requested, [1]);
  assert.deepEqual(cancelled, []);
  assert.equal(frames.size, 1);
  runFrame(1);
  assert.equal(applied, 499);

  scheduler.schedule('session-1\u0000container-1\u00001', () => { applied = 500; });
  scheduler.cancel();
  assert.deepEqual(cancelled, [2]);
  assert.equal(frames.size, 0);
  assert.equal(applied, 499);

  scheduler.schedule('session-1\u0000container-1\u00001', () => { applied = 501; });
  scheduler.schedule('session-2\u0000container-2\u00002', () => { applied = 502; });
  assert.deepEqual(cancelled, [2, 3]);
  assert.equal(frames.size, 1);
  runFrame(4);
  assert.equal(applied, 502);
});

test('Kubernetes list and detail layout use aligned controls and a compact visual hierarchy', async () => {
  const root = path.join(__dirname, '..');
  const html = await readFile(path.join(distRenderer, 'index.html'), 'utf8');
  const page = await readFile(path.join(distRenderer, 'kubernetesPage.js'), 'utf8');
  const styles = await readFile(path.join(root, 'src', 'renderer', 'tailwind.css'), 'utf8');

  assert.match(html, /id="kubernetes-list-page" class="kubernetes-list-page"/);
  assert.match(html, /class="kubernetes-detail-content-stack"/);
  assert.match(page, /description\.title = field\.value/);
  assert.match(page, /portForwardPanel\.classList\.toggle\('hidden', forwards\.length === 0\)/);
  assert.match(page, /detailPage\.classList\.toggle\('kubernetes-detail-pod', isPod\)/);
  assert.match(styles, /\.app-shell\[data-page='kubernetes'\][\s\S]*?height:\s*100dvh/);
  assert.match(styles, /\.kubernetes-detail-page\s*\{[\s\S]*?bg-white/);
  assert.match(styles, /\.kubernetes-detail-page\s*\{[^}]*grid-template-rows:\s*auto auto minmax\(0, 1fr\);/);
  assert.match(styles, /\.kubernetes-detail-pod\s*\{[\s\S]*?grid-template-rows/);
  assert.match(styles, /\.kubernetes-log-output\s*\{[\s\S]*?white-space:\s*pre;/);
  assert.match(styles, /\.kubernetes-terminal-drawer\s*\{[\s\S]*?absolute/);
  assert.match(styles, /\.kubernetes-port-forwards\s*\{[\s\S]*?absolute/);
  assert.doesNotMatch(styles, /\.kubernetes-detail-page\s*\{[\s\S]*?bg-zinc-100\/70/);
  assert.match(styles, /\.kubernetes-list-page\s*\{[\s\S]*?@apply[^;]*grid[^;]*gap-3/);
  assert.match(styles, /\.kubernetes-detail-overview-grid\s*\{[\s\S]*?@apply[^;]*m-0/);
  assert.match(styles, /\.kubernetes-detail-overview-grid > div\s*\{[\s\S]*?grid-cols-\[max-content_minmax\(0,1fr\)\]/);
  assert.match(styles, /\.kubernetes-detail-overview-grid dt\s*\{[\s\S]*?whitespace-nowrap/);
  assert.match(styles, /\.kubernetes-detail-overview-grid dd\s*\{[\s\S]*?m-0[^;]*whitespace-nowrap/);
  assert.match(styles, /\.kubernetes-namespace-control > \.btn\s*\{[\s\S]*?h-8/);
  assert.match(styles, /\.kubernetes-detail-actions\s*\{[\s\S]*?flex-nowrap/);
  assert.match(styles, /\.kubernetes-related-list\s*\{/);
  assert.match(styles, /\.kubernetes-related-row\s*\{/);
  assert.match(styles, /\.kubernetes-related-pod-link\s*\{/);
});

test('Kubernetes minimum viewport keeps Pod actions and log controls on bounded single rows', async () => {
  const styles = await readFile(path.join(__dirname, '..', 'src', 'renderer', 'tailwind.css'), 'utf8');
  const responsiveStart = styles.indexOf('@media (max-width: 900px)');
  assert.ok(responsiveStart >= 0);
  const responsiveStyles = styles.slice(responsiveStart);
  const podRows = responsiveStyles.match(
    /\.kubernetes-detail-pod\s*\{[\s\S]*?grid-template-rows:\s*auto auto minmax\((\d+)px,[^)]+\) auto minmax\((\d+)px,[^)]+\)/,
  );
  assert.ok(podRows);

  const contentMinimum = Number(podRows[1]);
  const logMinimum = Number(podRows[2]);
  const minimumMiddleTrackBudget = 260;
  const fixedLogChrome = 40 + 53 + 32;
  const minimumUsefulLogOutput = 48;
  assert.ok(contentMinimum + logMinimum <= minimumMiddleTrackBudget);
  assert.ok(logMinimum - fixedLogChrome >= minimumUsefulLogOutput);
  assert.doesNotMatch(responsiveStyles, /\.kubernetes-detail-actions\s*\{[^}]*@apply[^;]*flex-wrap/);
  assert.doesNotMatch(responsiveStyles, /\.kubernetes-log-head\s*\{[^}]*@apply[^;]*flex-wrap/);
  assert.match(styles, /\.kubernetes-detail-actions\s*\{[^}]*@apply[^;]*flex-nowrap[^;]*overflow-x-auto/);
  assert.match(styles, /\.kubernetes-log-head\s*\{[^}]*@apply[^;]*flex-nowrap[^;]*overflow-x-auto/);
});

test('Kubernetes simultaneous runtime layers share the page containing-block height budget', async () => {
  const styles = await readFile(path.join(__dirname, '..', 'src', 'renderer', 'tailwind.css'), 'utf8');
  const terminalRule = styles.match(/\.kubernetes-terminal-drawer\s*\{([^}]*)\}/);
  const forwardRule = styles.match(/\.kubernetes-port-forwards\s*\{([^}]*)\}/);
  const stackedRule = styles.match(
    /\.kubernetes-terminal-drawer:not\(\.hidden\) ~ \.kubernetes-port-forwards\s*\{([^}]*)\}/,
  );
  assert.ok(terminalRule);
  assert.ok(forwardRule);
  assert.ok(stackedRule);

  const terminalBudget = terminalRule[1].match(
    /max-height:\s*min\(420px,\s*calc\((\d+)%\s*-\s*(\d+)px\)\)/,
  );
  const standaloneForwardBudget = forwardRule[1].match(
    /max-height:\s*min\(12rem,\s*calc\(100%\s*-\s*(\d+)px\)\)/,
  );
  const stackedBottom = stackedRule[1].match(/bottom:\s*(\d+)%/);
  const stackedForwardBudget = stackedRule[1].match(
    /max-height:\s*min\(12rem,\s*calc\((\d+)%\s*-\s*(\d+)px\)\)/,
  );
  assert.ok(terminalBudget);
  assert.ok(standaloneForwardBudget);
  assert.ok(stackedBottom);
  assert.ok(stackedForwardBudget);

  const terminalPercent = Number(terminalBudget[1]);
  const terminalReserve = Number(terminalBudget[2]);
  const forwardPercent = Number(stackedForwardBudget[1]);
  const forwardReserve = Number(stackedForwardBudget[2]);
  assert.equal(terminalPercent + forwardPercent, 100);
  assert.equal(Number(stackedBottom[1]), terminalPercent);
  assert.ok(Number(standaloneForwardBudget[1]) >= 24);
  assert.ok(terminalReserve + forwardReserve >= 36);
  assert.doesNotMatch(terminalRule[1], /vh/);
});

test('Kubernetes terminal drawer disposes final closed or errored sessions and ignores late revival events', async () => {
  const originalWindow = global.window;
  const originalDocument = global.document;
  const instances = [];
  const listeners = new Map();
  let scrollIntoViewCount = 0;

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
    scrollIntoView() { scrollIntoViewCount += 1; }
  }

  class FakeTerminal {
    constructor() {
      this.cols = 80;
      this.rows = 24;
      this.writes = [];
      this.disposeCount = 0;
      this.focusCount = 0;
      instances.push(this);
    }

    loadAddon() {}
    open() {}
    onData(listener) { this.onDataListener = listener; }
    write(data) { this.writes.push(data); }
    focus() { this.focusCount += 1; }
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
    assert.equal(instances[0].focusCount, 1);
    assert.equal(scrollIntoViewCount, 1);
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
