const test = require('node:test');
const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');

const distRenderer = path.join(__dirname, '..', 'dist', 'renderer');

test('Kubernetes documentation states the supported read-only, bounded drawer-workspace contract', async () => {
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
    assert.match(document, /full-width.*Kubernetes|Kubernetes.*full-width/i);
    assert.match(document, /compact.*label-free.*Context.*Namespace|label-free.*Context.*Namespace.*compact/i);
    assert.match(document, /non-?wrapping.*(?:categor(?:y|ies)|resource)|(?:categor(?:y|ies)|resource).*non-?wrapping/i);
    assert.match(document, /no UI Cluster category/i);
    assert.match(document, /All Namespaces.*selected Namespaces|selected Namespaces.*All Namespaces/i);
    assert.match(document, /200(?:-item| items?| resource)? (?:page|paging)|page(?:s)? of 200/i);
    assert.match(document, /virtual (?:scrolling|table|list)/i);
    assert.match(document, /Namespace.*Name.*CPU.*Memory.*Restarts.*Status.*Node.*Age/i);
    assert.match(document, /per-resource.*eight columns|eight-column.*per-resource|resource-specific.*eight columns/i);
    assert.match(document, /searchable.*Namespace|Namespace.*searchable/i);
    assert.match(document, /Context.*Namespace.*matching.*selector|matching.*Context.*Namespace.*selector/i);
    assert.match(document, /ordinary containers.*resources\.requests|resources\.requests.*ordinary containers/i);
    assert.match(document, /not limits.*live metrics|not live metrics.*limits/i);
    assert.match(document, /active(?:-view| view) Watch/i);
    assert.match(document, /Version (?:endpoint )?(?:reachability )?probe|Version reachability probe/i);
    assert.match(document, /(?:probe-before-connected|before.*publish.*connected|before.*connected.*probe)/i);
    assert.match(document, /Context-scoped.*(?:recovery|retry)|(?:recovery|retry).*Context-scoped/i);
    assert.match(document, /no resource LIST|without resource LIST|sends no resource LIST/i);
    assert.match(document, /2,000(?:-line| lines?) log/i);
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

test('Kubernetes documentation describes overlay drawers and reusable bottom workspaces', async () => {
  const root = path.join(__dirname, '..');
  const documents = await Promise.all([
    readFile(path.join(root, 'README.md'), 'utf8'),
    readFile(path.join(root, 'AGENTS.md'), 'utf8'),
  ]);

  for (const document of documents) {
    assert.match(document, /right-side.*overlay drawer|overlay drawer.*right-side/i);
    assert.match(document, /(?:list )?Watch.*scroll.*(?:active|beneath)|scroll.*(?:list )?Watch.*(?:active|beneath)/i);
    assert.match(document, /labels.*Env.*collaps|Env.*labels.*collaps/i);
    assert.match(document, /YAML.*icon|icon.*YAML/i);
    assert.match(document, /Events.*read-only.*on-demand|read-only.*on-demand.*Events/i);
    assert.match(document, /multiple.*closable.*Logs.*Shell|Logs.*Shell.*multiple.*closable/i);
    assert.match(document, /namespace.*Pod.*container.*type|Pod.*container.*type.*namespace/i);
    assert.match(document, /(?:closing|close).*drawer.*preserv(?:es|e).*tabs|preserv(?:es|e).*tabs.*(?:closing|close).*drawer/i);
    assert.match(document, /Context.*page.*shutdown.*(?:close|clean)|(?:close|clean).*Context.*page.*shutdown/i);
    assert.match(document, /bottom workspace/i);
    assert.match(document, /Overview.*Kind.*Namespace.*Status.*Name.*Pod IP/i);
    assert.match(document, /pause icon.*play icon|play icon.*pause icon/i);
    assert.match(document, /(?:Logs|Shell).*(?:open|focus).*tab|(?:open|focus).*tab.*(?:Logs|Shell)/i);
    assert.match(document, /terminal input.*(?:spaces|whitespace).*Enter|(?:spaces|whitespace).*Enter.*terminal input/i);
    assert.match(document, /\/bin\/sh.*ash.*bash/i);
    assert.match(document, /header.*Port Forward.*replac(?:es|ing).*Copy/i);
    assert.match(document, /regular containers.*restartable(?: native)? sidecar.*TCP/i);
    assert.doesNotMatch(document, /detail-page close/i);
    assert.match(document, /(?:detail )?drawer close/i);
    assert.match(document, /Service.*spec\.ports\[\]\.port/i);
    assert.match(document, /zero.*manual.*one.*prefill.*multiple.*select/i);
    assert.match(document, /declared.*not proof.*listener/i);
    assert.match(document, /src\/renderer\/kubernetesDetailModel\.ts/);
    assert.doesNotMatch(document, /Kubernetes YAML[^.\n]*(?:Copy|copy)|kubernetesPage\.ts[^.\n]*(?:Copy|copy)/i);
  }
});

test('Kubernetes environment bridge exposes only the active Pod resolver and validates its IPC target', async () => {
  const root = path.join(__dirname, '..');
  const [preload, main, client, runtime] = await Promise.all([
    readFile(path.join(root, 'dist', 'main', 'preload.js'), 'utf8'),
    readFile(path.join(root, 'dist', 'main', 'main.js'), 'utf8'),
    readFile(path.join(root, 'dist', 'main', 'kubernetes', 'kubernetesClient.js'), 'utf8'),
    readFile(path.join(root, 'dist', 'main', 'kubernetes', 'kubernetesRuntime.js'), 'utf8'),
  ]);

  assert.match(preload, /getPodContainerEnvironment:\s*\(input\)\s*=>[\s\S]*?ipcRenderer\.invoke\('kubernetes:get-pod-environment', input\)/);
  assert.match(main, /kubernetesGetPodEnvironment:\s*'kubernetes:get-pod-environment'/);
  const handlerStart = main.indexOf('IPC_CHANNELS.kubernetesGetPodEnvironment');
  const handlerEnd = main.indexOf('IPC_CHANNELS.kubernetesOpenLogs', handlerStart);
  assert.ok(handlerStart >= 0 && handlerEnd > handlerStart);
  const handler = main.slice(handlerStart, handlerEnd);
  assert.match(handler, /validateKubernetesPodTarget\(input\)/);

  const clientStart = client.indexOf('async getPodContainerEnvironment(input)');
  const clientEnd = client.indexOf('async listEvents', clientStart);
  assert.ok(clientStart >= 0 && clientEnd > clientStart);
  const clientMethod = client.slice(clientStart, clientEnd);
  assert.match(clientMethod, /readNamespacedPod/);
  assert.match(clientMethod, /readNamespacedSecret/);
  assert.doesNotMatch(clientMethod, /sanitizeSecretForCache|ResourceCoordinator|ResourceCache/);
  assert.match(runtime, /async getPodContainerEnvironment\(input\)[\s\S]*?entries:\s*environment\.entries\.map\(\(entry\)\s*=>\s*\(\{\s*\.\.\.entry\s*\}\)\)/);
});

test('Kubernetes page provides a read-only resource browser shell', async () => {
  const html = await readFile(path.join(distRenderer, 'index.html'), 'utf8');
  const page = await readFile(path.join(distRenderer, 'kubernetesPage.js'), 'utf8');

  assert.match(html, /<main class="app-shell hidden" data-page="kubernetes">/);
  assert.match(html, /class="kubernetes-page"/);
  assert.match(html, /id="kubernetes-context-toggle"/);
  assert.match(html, /id="kubernetes-context-value"/);
  assert.match(html, /id="kubernetes-context-menu"/);
  assert.doesNotMatch(html, /<select[^>]+id="kubernetes-context"/);
  assert.match(html, /id="kubernetes-reconnect"/);
  assert.match(html, /id="kubernetes-namespace-search"[^>]+type="search"/);
  assert.match(html, /id="kubernetes-namespace-options"/);
  assert.match(html, /id="kubernetes-namespace-menu"/);
  assert.match(html, /id="kubernetes-namespace-toggle"[^>]+aria-haspopup="dialog"/);
  assert.match(html, /id="kubernetes-namespace-menu"[^>]+role="dialog"/);
  assert.match(html, /id="kubernetes-namespace-options"[^>]+role="group"/);
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
  assert.match(page, /allLabel\.append\(all, document\.createTextNode\('All'\)\)/);
  assert.doesNotMatch(page, /allLabel\.append\(all, document\.createTextNode\('All Namespaces'\)\)/);
  assert.match(page, /if \(contextChanged\)\s*this\.invalidateNamespaceOptions\(\)/);
  assert.match(page, /this\.namespaceContext !== state\.selectedContext[\s\S]*?this\.loadNamespaces\(state\.selectedContext\)/);
  assert.match(page, /generation !== this\.namespaceRequestGeneration[\s\S]*?this\.state\?\.selectedContext !== context/);
  assert.match(page, /context\.supported \? context\.displayName : `\$\{context\.displayName\} \(unsupported\)`/);
  assert.match(page, /option\.dataset\.context = context\.name/);
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

test('Kubernetes Namespace filtering is compact, case-insensitive, and preserves sorted unique values', async () => {
  const { filterKubernetesNamespaces } = await import(path.join(distRenderer, 'kubernetesPage.js'));

  assert.deepEqual(filterKubernetesNamespaces(
    ['monitoring', 'ai-dev', 'kube-system', 'ai-dev'],
    ' DEV ',
  ), ['ai-dev']);
  assert.deepEqual(filterKubernetesNamespaces(
    ['monitoring', 'ai-dev', 'kube-system'],
    '',
  ), ['ai-dev', 'kube-system', 'monitoring']);
  assert.deepEqual(filterKubernetesNamespaces(['ai-dev'], 'missing'), []);
});

test('Kubernetes Context activation waits for the matching delayed connection exactly until it is usable', async () => {
  const { decideKubernetesContextActivation } = await import(path.join(distRenderer, 'kubernetesPage.js'));
  const intent = { id: 7, context: 'tunneled', pageGeneration: 3 };
  const decision = (selectedContext, connection, visible = true, pageGeneration = 3) => (
    decideKubernetesContextActivation(intent, { selectedContext, connection }, visible, pageGeneration)
  );

  assert.equal(decision('tunneled', 'connecting'), 'wait');
  assert.equal(decision('tunneled', 'reconnecting'), 'wait');
  assert.equal(decision('tunneled', 'connected'), 'activate');
  assert.equal(decision('tunneled', 'disconnected'), 'terminal');
  assert.equal(decision('tunneled', 'unsupported-auth'), 'terminal');
  assert.equal(decision('older-context', 'connected'), 'wait');
  assert.equal(decision('tunneled', 'connected', false), 'stale');
  assert.equal(decision('tunneled', 'connected', true, 4), 'stale');
});

test('Kubernetes renderer never sends a resource LIST while a Context is reconnecting', async () => {
  const page = await readFile(path.join(distRenderer, 'kubernetesPage.js'), 'utf8');
  const currentQueryStart = page.indexOf('    currentQuery() {');
  const selectContextStart = page.indexOf('    async selectContext(context) {', currentQueryStart);
  const reloadStart = page.indexOf('    async reloadKubeconfig() {', selectContextStart);
  const settleStart = page.indexOf('    settleContextActivation(state) {');
  const connectionStateStart = page.indexOf('    renderConnectionListState(state) {', settleStart);
  const activateStart = page.indexOf('    async activateCurrentList() {');
  const renderListStart = page.indexOf('    renderList() {', activateStart);

  assert.ok(currentQueryStart >= 0 && selectContextStart > currentQueryStart);
  assert.ok(reloadStart > selectContextStart && connectionStateStart > settleStart);
  assert.ok(activateStart >= 0 && renderListStart > activateStart);
  const currentQuery = page.slice(currentQueryStart, selectContextStart);
  const selectContext = page.slice(selectContextStart, reloadStart);
  const settle = page.slice(settleStart, connectionStateStart);
  const activate = page.slice(activateStart, renderListStart);

  assert.match(currentQuery, /this\.state\?\.connection !== 'connected'[\s\S]*?return undefined/);
  assert.doesNotMatch(selectContext, /activateCurrentList/);
  assert.ok(settle.indexOf('this.pendingContextActivation = undefined') < settle.indexOf('this.activateCurrentList()'));
  assert.ok(activate.indexOf('if (!query)') < activate.indexOf('window.kubernetesApi.listResources(query)'));
  assert.ok(activate.indexOf('return;', activate.indexOf('if (!query)')) < activate.indexOf('window.kubernetesApi.listResources(query)'));
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
  const renderer = await import(path.join(distRenderer, 'kubernetesPage.js'));

  assert.match(page, /SEARCH_DEBOUNCE_MS = 200/);
  assert.match(page, /nameFilter:/);
  assert.doesNotMatch(page, /Sorted loaded items only/);
  assert.deepEqual(renderer.getKubernetesResourceRowValues('services', {
    uid: 'service-1',
    name: '<unsafe-service>',
    namespace: 'apps',
    resourceVersion: '1',
    columns: {
      type: 'ClusterIP',
      clusterIP: '10.96.0.1',
      externalIP: '—',
      ports: '80→8080/TCP',
      selector: 'app=api',
    },
  }), ['apps', '<unsafe-service>', 'ClusterIP', '10.96.0.1', '—', '80→8080/TCP', 'app=api', '—']);
  assert.match(page, /getKubernetesResourceRowValues\(this\.resourceKind, item\)/);
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
  const expected = {
    pods: [['namespace', 'Namespace'], ['name', 'Name'], ['cpu', 'CPU'], ['memory', 'Memory'], ['restarts', 'Restarts'], ['status', 'Status'], ['node', 'Node'], ['age', 'Age']],
    deployments: [['namespace', 'Namespace'], ['name', 'Name'], ['ready', 'Ready'], ['updated', 'Up-to-date'], ['available', 'Available'], ['unavailable', 'Unavailable'], ['strategy', 'Strategy'], ['age', 'Age']],
    statefulsets: [['namespace', 'Namespace'], ['name', 'Name'], ['ready', 'Ready'], ['current', 'Current'], ['updated', 'Updated'], ['service', 'Service'], ['strategy', 'Strategy'], ['age', 'Age']],
    services: [['namespace', 'Namespace'], ['name', 'Name'], ['type', 'Type'], ['clusterIP', 'Cluster IP'], ['externalIP', 'External IP'], ['ports', 'Ports'], ['selector', 'Selector'], ['age', 'Age']],
    ingresses: [['namespace', 'Namespace'], ['name', 'Name'], ['class', 'Class'], ['hosts', 'Hosts'], ['address', 'Address'], ['ports', 'Ports'], ['tls', 'TLS'], ['age', 'Age']],
    configmaps: [['namespace', 'Namespace'], ['name', 'Name'], ['data', 'Data'], ['binary', 'Binary Data'], ['immutable', 'Immutable'], ['labels', 'Labels'], ['annotations', 'Annotations'], ['age', 'Age']],
    secrets: [['namespace', 'Namespace'], ['name', 'Name'], ['type', 'Type'], ['data', 'Data Keys'], ['immutable', 'Immutable'], ['labels', 'Labels'], ['annotations', 'Annotations'], ['age', 'Age']],
    persistentvolumeclaims: [['namespace', 'Namespace'], ['name', 'Name'], ['status', 'Status'], ['volume', 'Volume'], ['capacity', 'Capacity'], ['accessModes', 'Access Modes'], ['storageClass', 'Storage Class'], ['age', 'Age']],
    'custom-resources': [['namespace', 'Namespace'], ['name', 'Name'], ['kind', 'Kind'], ['apiVersion', 'API Version'], ['status', 'Status'], ['generation', 'Generation'], ['labels', 'Labels'], ['age', 'Age']],
  };
  for (const [kind, columns] of Object.entries(expected)) {
    assert.deepEqual(page.getKubernetesListColumns(kind).map(({ key, label }) => [key, label]), columns);
    assert.equal(page.getKubernetesListColumns(kind).length, 8);
  }
  assert.doesNotMatch(html, /data-kubernetes-sort=/);
  assert.match(pageSource, /createElementNS/);
  assert.match(pageSource, /aria-sort/);
  assert.match(pageSource, /nextKubernetesSort/);
  assert.match(styles, /\.kubernetes-table-sort\s*\{/);
  assert.match(styles, /\.kubernetes-sort-icon\s*\{/);
  assert.match(styles, /--kubernetes-table-columns/);
  assert.match(styles, /--kubernetes-table-min-width/);
  assert.match(styles, /\.kubernetes-table-shell\s*\{[\s\S]*?overflow-x:\s*auto;/);
  assert.match(styles, /\.kubernetes-table-viewport\s*\{[\s\S]*?overflow-y:\s*auto;/);
  assert.doesNotMatch(html, /kubernetes-sort-column|kubernetes-sort-direction|kubernetes-sort-hint|Sorted loaded items only/);
});

test('Kubernetes query transitions synchronously clear stale virtual rows and fence delayed menu focus', async () => {
  const page = await readFile(path.join(distRenderer, 'kubernetesPage.js'), 'utf8');
  const method = (name, after) => {
    const start = [page.indexOf(`    ${name}(`), page.indexOf(`    async ${name}(`)].find((index) => index >= 0) ?? -1;
    const end = [page.indexOf(`    ${after}(`, start), page.indexOf(`    async ${after}(`, start)]
      .filter((index) => index > start)
      .sort((left, right) => left - right)[0] ?? -1;
    assert.ok(start >= 0 && end > start, `${name} method bounds`);
    return page.slice(start, end);
  };

  for (const [name, after] of [
    ['selectCategory', 'selectResource'],
    ['selectResource', 'currentScope'],
    ['selectCustomResourceDefinition', 'currentQuery'],
    ['selectContext', 'reloadKubeconfig'],
    ['setNamespaceScope', 'debounceSearch'],
  ]) {
    assert.match(method(name, after), /this\.clearResourceTable\(\);/, `${name} must clear stale rows`);
  }
  const clear = method('clearResourceTable', 'waitForPriorDeactivation');
  assert.match(clear, /this\.requestGeneration \+= 1/);
  assert.match(clear, /this\.table\?\.setWindow\(\{ start: 0, end: 0, total: 0, items: \[\] \}\)/);
  assert.match(clear, /this\.tableViewport\.scrollTop = 0/);
  assert.match(page, /if \(this\.contextMenu\.classList\.contains\('hidden'\)\)\s*return;/);
  assert.match(page, /if \(!this\.namespaceMenu\.classList\.contains\('hidden'\)\)\s*this\.namespaceSearch\.focus\(\)/);
  assert.match(page, /this\.contextControl\.addEventListener\('focusout'/);
  assert.match(page, /this\.namespaceControl\.addEventListener\('focusout'/);
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

test('Kubernetes resource details use a read-only overlay drawer and clear active Secret data on close', async () => {
  const html = await readFile(path.join(distRenderer, 'index.html'), 'utf8');
  const page = await readFile(path.join(distRenderer, 'kubernetesPage.js'), 'utf8');

  assert.match(html, /id="kubernetes-detail-drawer"/);
  assert.match(html, /id="kubernetes-detail-drawer-scrim"/);
  assert.match(html, /id="kubernetes-detail-close"/);
  assert.match(html, /id="kubernetes-detail-yaml-toggle"/);
  assert.match(html, /id="kubernetes-detail-yaml"/);
  assert.doesNotMatch(html, /id="kubernetes-detail-page"/);
  assert.match(page, /getResourceDetail\(/);
  assert.match(page, /getResourceEvents\(/);
  assert.match(page, /serializeKubernetesDetailYaml\(detail\)/);
  assert.match(page, /detailYaml\.textContent/);
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
  assert.match(page, /detailYaml\.textContent = serializeKubernetesDetailYaml\(detail\)/);
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

test('Kubernetes drawer request identity ignores stale detail completions after replacement or close', async () => {
  const module = await import(path.join(distRenderer, 'kubernetesPage.js'));
  const { isCurrentKubernetesDrawerRequest } = module;
  assert.equal(typeof isCurrentKubernetesDrawerRequest, 'function');
  const active = { visible: true, pageGeneration: 8, drawerGeneration: 12, uid: 'service-a' };
  assert.equal(isCurrentKubernetesDrawerRequest(active, active), true);
  assert.equal(isCurrentKubernetesDrawerRequest(active, {
    visible: true, pageGeneration: 8, drawerGeneration: 13, uid: 'pod-a',
  }), false);
  assert.equal(isCurrentKubernetesDrawerRequest(active, {
    visible: false, pageGeneration: 8, drawerGeneration: 12, uid: 'service-a',
  }), false);

  const page = await readFile(path.join(distRenderer, 'kubernetesPage.js'), 'utf8');
  const closeStart = page.indexOf('    closeDetail() {');
  const closeEnd = page.indexOf('    displayDetail() {', closeStart);
  const close = page.slice(closeStart, closeEnd);

  assert.ok(closeStart >= 0 && closeEnd > closeStart);
  assert.match(close, /this\.drawerRequest = \{/);
  assert.match(close, /visible: false/);
  assert.match(close, /this\.detailDrawer\.classList\.add\('hidden'\)/);
  assert.doesNotMatch(close, /await |closeDetailLogs|closeTerminal|stopPortForward/);
});

test('Kubernetes related Pod navigation accepts a Pod fetch under a current workload list and suppresses stale drawers', async () => {
  const {
    isCurrentKubernetesDrawerListRequest,
    runKubernetesDrawerDetailRequest,
  } = await import(path.join(distRenderer, 'kubernetesPage.js'));

  for (const kind of ['deployments', 'statefulsets']) {
    const originListQuery = {
      context: 'development',
      kind,
      scope: 'namespaced',
      namespaceScope: { mode: 'selected', namespaces: ['apps'] },
      sort: { column: 'name', direction: 'asc' },
    };
    const podFetchQuery = {
      context: 'development',
      kind: 'pods',
      scope: 'namespaced',
      namespaceScope: { mode: 'selected', namespaces: ['apps'] },
    };
    const request = { visible: true, pageGeneration: 3, drawerGeneration: 8, uid: `${kind}-pod` };
    let pageVisible = true;
    let currentDrawer = request;
    let currentListQuery = originListQuery;
    const isCurrent = () => isCurrentKubernetesDrawerListRequest(
      pageVisible,
      currentDrawer,
      request,
      currentListQuery,
      originListQuery,
    );
    const renders = [];
    const fetchedKinds = [];

    await runKubernetesDrawerDetailRequest(
      async () => {
        fetchedKinds.push(podFetchQuery.kind);
        return { kind: 'Pod', metadata: { name: `${kind}-pod` } };
      },
      {
        isCurrent,
        onSuccess: (detail) => renders.push(`drawer:${detail.kind}`),
        onError: (error) => { throw error; },
      },
    );

    assert.deepEqual(fetchedKinds, ['pods']);
    assert.deepEqual(renders, ['drawer:Pod']);

    for (const staleDrawer of [
      { visible: true, pageGeneration: 3, drawerGeneration: 9, uid: 'replacement-pod' },
      { visible: false, pageGeneration: 3, drawerGeneration: 8, uid: `${kind}-pod` },
    ]) {
      const pending = deferred();
      const staleRenders = [];
      currentDrawer = request;
      pageVisible = true;
      const navigation = runKubernetesDrawerDetailRequest(
        () => pending.promise,
        {
          isCurrent,
          onSuccess: (detail) => staleRenders.push(`drawer:${detail.kind}`),
          onError: (error) => { throw error; },
        },
      );
      currentDrawer = staleDrawer;
      if (!staleDrawer.visible) pageVisible = false;
      pending.resolve({ kind: 'Pod' });
      await navigation;
      assert.deepEqual(staleRenders, []);
    }

    const listChange = deferred();
    const listChangeRenders = [];
    currentDrawer = request;
    pageVisible = true;
    currentListQuery = originListQuery;
    const navigation = runKubernetesDrawerDetailRequest(
      () => listChange.promise,
      {
        isCurrent,
        onSuccess: (detail) => listChangeRenders.push(`drawer:${detail.kind}`),
        onError: (error) => { throw error; },
      },
    );
    currentListQuery = { ...originListQuery, sort: { column: 'name', direction: 'desc' } };
    listChange.resolve({ kind: 'Pod' });
    await navigation;
    assert.deepEqual(listChangeRenders, []);
    currentListQuery = originListQuery;
  }
});

test('Kubernetes Task 5 keeps port forwards while moving Logs and Shell into the persistent workspace', async () => {
  const html = await readFile(path.join(distRenderer, 'index.html'), 'utf8');
  const page = await readFile(path.join(distRenderer, 'kubernetesPage.js'), 'utf8');

  assert.match(html, /id="kubernetes-detail-port-forward"/);
  assert.match(html, /id="kubernetes-port-forward-dialog"/);
  assert.match(html, /id="kubernetes-port-forwards"/);
  assert.match(html, /id="kubernetes-workspace"/);
  assert.doesNotMatch(html, /id="kubernetes-log-panel"|id="kubernetes-terminal-drawer"/);
  assert.match(page, /startPortForward/);
  assert.match(page, /stopPortForward/);
  assert.match(page, /createKubernetesWorkspace/);
  assert.match(page, /onLogChanged\(\(state\) => this\.workspace\?\.onLogChanged\(state\)\)/);
  assert.match(page, /onTerminalChanged\(\(state\) => this\.workspace\?\.onTerminalChanged\(state\)\)/);
  assert.match(page, /onTerminalOutput\(\(output\) => this\.workspace\?\.onTerminalOutput\(output\)\)/);
  assert.doesNotMatch(page, /createKubernetesTerminalDrawer|openLogsForSelectedContainer/);
});

test('Kubernetes drawer rendering keeps YAML opt-in and Events guarded to the active request', async () => {
  const page = await readFile(path.join(distRenderer, 'kubernetesPage.js'), 'utf8');
  const renderDetail = page.slice(
    page.indexOf('    renderDetail() {'),
    page.indexOf('    renderOverview(detail, active) {'),
  );

  const yaml = page.slice(
    page.indexOf('    toggleDrawerYaml() {'),
    page.indexOf('    requestDrawerEvents(active) {'),
  );
  const events = page.slice(
    page.indexOf('    requestDrawerEvents(active) {'),
    page.indexOf('    renderDrawerEvents(active) {'),
  );

  assert.match(renderDetail, /if \(!this\.detailYaml\.classList\.contains\('hidden'\)\)\s*this\.renderDrawerYaml\(detail\)/);
  assert.match(yaml, /this\.detailYaml\.classList\.toggle\('hidden', !opening\)/);
  assert.match(yaml, /this\.detailYaml\.textContent = ''/);
  assert.match(events, /if \(!this\.isCurrentActiveDrawer\(active\)\)\s*return/);
  assert.match(events, /window\.kubernetesApi\.getResourceEvents/);
});

test('Kubernetes drawer Events render dynamic values through textContent', async () => {
  const page = await readFile(path.join(distRenderer, 'kubernetesPage.js'), 'utf8');
  const events = page.slice(
    page.indexOf('    renderDrawerEvents(active) {'),
    page.indexOf('    renderDrawerPortForward(detail, active) {'),
  );

  assert.match(events, /reason\.textContent = /);
  assert.match(events, /type\.textContent = /);
  assert.match(events, /time\.textContent = /);
  assert.match(events, /message\.textContent = /);
  assert.match(events, /count\.textContent = /);
  assert.doesNotMatch(events, /innerHTML/);
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
  const followAttributes = new Map();
  const elements = {
    followButton: {
      disabled: false,
      setAttribute(name, value) { followAttributes.set(name, value); },
      getAttribute(name) { return followAttributes.get(name) ?? null; },
    },
    pauseIcon: { classList: new FakeKubernetesLogClassList() },
    playIcon: { classList: new FakeKubernetesLogClassList() },
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

test('Kubernetes terminal open reuses an exact target and marks Terminal active before focus', async () => {
  const { openKubernetesTerminalWorkspace } = await import(path.join(distRenderer, 'kubernetesPage.js'));
  const requests = new Map();
  const steps = [];
  let requestCount = 0;
  const target = { namespace: 'apps', podName: 'api', container: 'app' };

  await openKubernetesTerminalWorkspace({
    target,
    requests,
    selectWorkspace: (workspace) => steps.push(`workspace:${workspace}`),
    focusTarget: (candidate) => {
      steps.push(`focus:${candidate.namespace}/${candidate.podName}/${candidate.container}`);
      return 'terminal-existing';
    },
    focusSession: () => assert.fail('an existing target must not require a second focus lookup'),
    claimSession: (id) => steps.push(`claim:${id}`),
    openDrawer: () => steps.push('drawer'),
    requestTerminal: async () => {
      requestCount += 1;
      throw new Error('must not open');
    },
    isCurrent: () => true,
    reportError: (error) => steps.push(`error:${error}`),
  });

  assert.deepEqual(steps, ['workspace:terminal', 'focus:apps/api/app', 'claim:terminal-existing']);
  assert.equal(requestCount, 0);
  assert.equal(requests.size, 0);
});

test('Kubernetes terminal open guards a pending exact target and focuses its successful session', async () => {
  const { openKubernetesTerminalWorkspace } = await import(path.join(distRenderer, 'kubernetesPage.js'));
  const requests = new Map();
  const request = deferred();
  const target = { namespace: 'apps', podName: 'api', container: 'app' };
  const terminal = { id: 'terminal-app', ...target, shell: '/bin/sh', state: 'open' };
  const steps = [];
  let requestCount = 0;
  let stored;
  const options = {
    target,
    requests,
    selectWorkspace: (workspace) => steps.push(`workspace:${workspace}`),
    focusTarget: (candidate) => {
      steps.push(`focus-target:${candidate.container}`);
      return undefined;
    },
    focusSession: (id) => {
      steps.push(`focus-session:${id}`);
      return stored?.id === id;
    },
    claimSession: (id) => steps.push(`claim:${id}`),
    openDrawer: (state) => {
      steps.push(`drawer:${state.id}`);
      stored = state;
    },
    requestTerminal: () => {
      requestCount += 1;
      steps.push('request');
      return request.promise;
    },
    isCurrent: () => true,
    reportError: (error) => steps.push(`error:${error}`),
  };

  const first = openKubernetesTerminalWorkspace(options);
  const duplicate = openKubernetesTerminalWorkspace(options);
  await duplicate;
  assert.equal(requestCount, 1);
  assert.equal(requests.size, 1);
  request.resolve(terminal);
  await first;

  assert.equal(requests.size, 0);
  assert.equal(stored, terminal);
  assert.deepEqual(steps, [
    'workspace:terminal',
    'focus-target:app',
    'request',
    'workspace:terminal',
    'focus-target:app',
    'drawer:terminal-app',
    'focus-session:terminal-app',
    'claim:terminal-app',
  ]);
});

test('Kubernetes terminal open failure returns the current workspace to Logs and reports the error', async () => {
  const { openKubernetesTerminalWorkspace } = await import(path.join(distRenderer, 'kubernetesPage.js'));
  const workspaces = [];
  const errors = [];

  await openKubernetesTerminalWorkspace({
    target: { namespace: 'apps', podName: 'api', container: 'app' },
    requests: new Map(),
    selectWorkspace: (workspace) => workspaces.push(workspace),
    focusTarget: () => undefined,
    focusSession: () => false,
    claimSession: () => assert.fail('failed terminal must not claim a session'),
    openDrawer: () => assert.fail('failed terminal must not open the drawer'),
    requestTerminal: async () => { throw new Error('exec forbidden'); },
    isCurrent: () => true,
    reportError: (error) => errors.push(error instanceof Error ? error.message : String(error)),
  });

  assert.deepEqual(workspaces, ['terminal', 'logs']);
  assert.deepEqual(errors, ['exec forbidden']);
});

test('Kubernetes terminal stale completion after a container switch cannot activate the old target', async () => {
  const { openKubernetesTerminalWorkspace } = await import(path.join(distRenderer, 'kubernetesPage.js'));
  const request = deferred();
  const workspaces = [];
  const drawer = [];
  let current = true;
  let targetFocusCount = 0;
  let sessionFocusCount = 0;
  const claimed = [];
  const opening = openKubernetesTerminalWorkspace({
    target: { namespace: 'apps', podName: 'api', container: 'app' },
    requests: new Map(),
    selectWorkspace: (workspace) => workspaces.push(workspace),
    focusTarget: () => { targetFocusCount += 1; return undefined; },
    focusSession: () => { sessionFocusCount += 1; return true; },
    claimSession: (id) => claimed.push(id),
    openDrawer: (state) => drawer.push(state.id),
    requestTerminal: () => request.promise,
    isCurrent: () => current,
    reportError: () => assert.fail('stale completion must not report an active error'),
  });
  current = false;
  workspaces.push('logs');
  request.resolve({
    id: 'terminal-app',
    namespace: 'apps',
    podName: 'api',
    container: 'app',
    shell: '/bin/sh',
    state: 'open',
  });
  await opening;

  assert.deepEqual(workspaces, ['terminal', 'logs']);
  assert.deepEqual(drawer, ['terminal-app']);
  assert.equal(targetFocusCount, 1);
  assert.equal(sessionFocusCount, 0);
  assert.deepEqual(claimed, []);
});

test('Kubernetes terminal stale failure after a detail switch cannot change the current workspace', async () => {
  const { openKubernetesTerminalWorkspace } = await import(path.join(distRenderer, 'kubernetesPage.js'));
  const request = deferred();
  const workspaces = [];
  const errors = [];
  let current = true;
  const opening = openKubernetesTerminalWorkspace({
    target: { namespace: 'apps', podName: 'api', container: 'app' },
    requests: new Map(),
    selectWorkspace: (workspace) => workspaces.push(workspace),
    focusTarget: () => undefined,
    focusSession: () => false,
    claimSession: () => assert.fail('stale failure must not claim a session'),
    openDrawer: () => assert.fail('failed terminal must not open the drawer'),
    requestTerminal: () => request.promise,
    isCurrent: () => current,
    reportError: (error) => errors.push(error),
  });
  current = false;
  workspaces.push('logs');
  request.reject(new Error('late failure'));
  await opening;

  assert.deepEqual(workspaces, ['terminal', 'logs']);
  assert.deepEqual(errors, []);
});

test('Kubernetes terminal final matching state falls back to Logs only when no replacement remains', async () => {
  const { routeKubernetesTerminalFinalState } = await import(path.join(distRenderer, 'kubernetesPage.js'));
  const selectedTarget = { namespace: 'apps', podName: 'api', container: 'app' };
  const workspaces = [];
  const errors = [];
  const base = {
    selectedTarget,
    workspace: 'terminal',
    selectLogs: () => workspaces.push('logs'),
    reportError: (message) => errors.push(message),
  };
  const claimed = [];

  assert.equal(routeKubernetesTerminalFinalState({
    ...base,
    state: { id: 'one', ...selectedTarget, shell: '/bin/sh', state: 'closed' },
    workspaceSessionId: 'one',
    replacementSessionId: undefined,
    claimSession: (id) => claimed.push(id),
  }), 'fallback');
  assert.equal(routeKubernetesTerminalFinalState({
    ...base,
    state: { id: 'two', ...selectedTarget, shell: '/bin/sh', state: 'error', error: 'stream lost' },
    workspaceSessionId: 'two',
    replacementSessionId: undefined,
    claimSession: (id) => claimed.push(id),
  }), 'fallback');
  assert.deepEqual(workspaces, ['logs', 'logs']);
  assert.deepEqual(errors, ['stream lost']);

  assert.equal(routeKubernetesTerminalFinalState({
    ...base,
    state: { id: 'three', ...selectedTarget, shell: '/bin/sh', state: 'closed' },
    workspaceSessionId: 'three',
    replacementSessionId: 'replacement',
    claimSession: (id) => claimed.push(id),
  }), 'retained');
  assert.equal(routeKubernetesTerminalFinalState({
    ...base,
    state: { id: 'sidecar', ...selectedTarget, container: 'sidecar', shell: '/bin/sh', state: 'error', error: 'old' },
    workspaceSessionId: 'sidecar',
    replacementSessionId: undefined,
    claimSession: (id) => claimed.push(id),
  }), 'background');
  assert.equal(routeKubernetesTerminalFinalState({
    ...base,
    state: { id: 'old-same-target', ...selectedTarget, shell: '/bin/sh', state: 'error', error: 'stale' },
    workspaceSessionId: 'current-same-target',
    replacementSessionId: undefined,
    claimSession: (id) => claimed.push(id),
  }), 'background');
  assert.deepEqual(workspaces, ['logs', 'logs']);
  assert.deepEqual(errors, ['stream lost']);
  assert.deepEqual(claimed, ['replacement']);
});

test('Kubernetes terminal exact session ownership prevents same-target ABA finals before and after claim', async () => {
  const {
    openKubernetesTerminalWorkspace,
    routeKubernetesTerminalFinalState,
  } = await import(path.join(distRenderer, 'kubernetesPage.js'));
  const target = { namespace: 'apps', podName: 'api', container: 'app' };
  const requests = new Map();
  const oldRequest = deferred();
  const newRequest = deferred();
  const workspaces = [];
  const errors = [];
  const drawerStates = new Map();
  const focused = [];
  let owner;
  let generation = 1;

  const options = (request, requestGeneration) => ({
    target,
    requests,
    selectWorkspace: (workspace) => {
      workspaces.push(workspace);
      if (workspace === 'logs') owner = undefined;
    },
    focusTarget: () => undefined,
    focusSession: (id) => {
      focused.push(id);
      return drawerStates.has(id);
    },
    claimSession: (id) => { owner = id; },
    openDrawer: (state) => drawerStates.set(state.id, state),
    requestTerminal: () => request.promise,
    isCurrent: () => generation === requestGeneration && workspaces.at(-1) === 'terminal',
    reportError: (error) => errors.push(error instanceof Error ? error.message : String(error)),
  });

  const oldOpening = openKubernetesTerminalWorkspace(options(oldRequest, generation));
  requests.clear();
  owner = undefined;
  workspaces.push('logs');
  generation += 1;
  const newOpening = openKubernetesTerminalWorkspace(options(newRequest, generation));

  const oldFinal = { id: 'terminal-old', ...target, shell: '/bin/sh', state: 'error', error: 'old failed' };
  assert.equal(routeKubernetesTerminalFinalState({
    state: oldFinal,
    selectedTarget: target,
    workspace: workspaces.at(-1),
    workspaceSessionId: owner,
    replacementSessionId: undefined,
    claimSession: (id) => { owner = id; },
    selectLogs: () => workspaces.push('logs'),
    reportError: (message) => errors.push(message),
  }), 'background');
  assert.equal(workspaces.at(-1), 'terminal');
  assert.deepEqual(errors, []);

  newRequest.resolve({ id: 'terminal-new', ...target, shell: '/bin/sh', state: 'open' });
  await newOpening;
  assert.equal(owner, 'terminal-new');
  assert.deepEqual(focused, ['terminal-new']);
  assert.equal(workspaces.at(-1), 'terminal');

  assert.equal(routeKubernetesTerminalFinalState({
    state: { ...oldFinal, state: 'closed', error: undefined },
    selectedTarget: target,
    workspace: workspaces.at(-1),
    workspaceSessionId: owner,
    replacementSessionId: undefined,
    claimSession: (id) => { owner = id; },
    selectLogs: () => workspaces.push('logs'),
    reportError: (message) => errors.push(message),
  }), 'background');
  assert.equal(owner, 'terminal-new');
  assert.equal(workspaces.at(-1), 'terminal');
  assert.deepEqual(errors, []);

  oldRequest.reject(new Error('old request rejected'));
  await oldOpening;
  assert.equal(owner, 'terminal-new');
  assert.equal(workspaces.at(-1), 'terminal');
  assert.deepEqual(errors, []);
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
  assert.equal(harness.elements.pauseIcon.classList.contains('hidden'), false);
  assert.equal(harness.elements.playIcon.classList.contains('hidden'), true);
  assert.equal(harness.elements.followButton.getAttribute('aria-label'), 'Pause log follow');
  assert.equal(harness.elements.followButton.getAttribute('title'), 'Pause log follow');
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
  assert.equal(harness.elements.pauseIcon.classList.contains('hidden'), true);
  assert.equal(harness.elements.playIcon.classList.contains('hidden'), false);
  assert.equal(harness.elements.followButton.getAttribute('aria-label'), 'Resume log follow');
  assert.equal(harness.elements.followButton.getAttribute('title'), 'Resume log follow');
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

test('Kubernetes Pause applies local state and cancels queued auto-scroll before follow IPC settles', async () => {
  const pageModule = await import(path.join(distRenderer, 'kubernetesPage.js'));
  const harness = createKubernetesLogViewportHarness(pageModule);
  const sessions = new Map([['app', kubernetesLogState()]]);
  const mutations = new Map();
  const request = deferred();
  const calls = [];
  harness.setState({ sessions, log: undefined });
  harness.viewport.render('follow');
  harness.elements.output.scrollTop = 37;

  const toggling = pageModule.runKubernetesLogFollowToggle({
    sessions,
    mutations,
    getSelectedContainer: () => harness.state.selectedContainer,
    viewport: harness.viewport,
    setFollowing: (sessionId, following) => {
      calls.push([sessionId, following]);
      return request.promise;
    },
    onError: () => assert.fail('Pause should not report an error'),
  });

  assert.equal(sessions.get('app').following, false);
  assert.ok(mutations.get('session-app'));
  assert.deepEqual(calls, [['session-app', false]]);
  assert.deepEqual(harness.cancelled, [1]);
  assert.equal(harness.frames.size, 0);
  assert.equal(harness.elements.output.scrollTop, 37);
  assert.equal(harness.elements.pauseIcon.classList.contains('hidden'), true);
  assert.equal(harness.elements.playIcon.classList.contains('hidden'), false);

  request.resolve(kubernetesLogState({ following: false }));
  await toggling;
  assert.equal(mutations.size, 0);
});

test('Kubernetes Resume applies local state and schedules bottom follow before IPC settles', async () => {
  const pageModule = await import(path.join(distRenderer, 'kubernetesPage.js'));
  const paused = kubernetesLogState({ following: false });
  const sessions = new Map([['app', paused]]);
  const mutations = new Map();
  const harness = createKubernetesLogViewportHarness(pageModule);
  const request = deferred();
  harness.setState({ sessions, log: undefined });
  harness.elements.output.scrollTop = 31;
  harness.elements.output.scrollHeight = 640;

  const toggling = pageModule.runKubernetesLogFollowToggle({
    sessions,
    mutations,
    getSelectedContainer: () => harness.state.selectedContainer,
    viewport: harness.viewport,
    setFollowing: () => request.promise,
    onError: () => assert.fail('Resume should not report an error'),
  });

  assert.equal(sessions.get('app').following, true);
  assert.deepEqual(harness.requested, [1]);
  assert.equal(harness.frames.size, 1);
  assert.equal(harness.elements.pauseIcon.classList.contains('hidden'), false);
  assert.equal(harness.elements.playIcon.classList.contains('hidden'), true);
  harness.runFrame(1);
  assert.equal(harness.elements.output.scrollTop, 640);

  request.resolve(kubernetesLogState({ following: true }));
  await toggling;
  assert.equal(mutations.size, 0);
});

test('Kubernetes followed output returns to bottom after manual upward scroll', async () => {
  const pageModule = await import(path.join(distRenderer, 'kubernetesPage.js'));
  const state = kubernetesLogState();
  const sessions = new Map([['app', state]]);
  const harness = createKubernetesLogViewportHarness(pageModule);
  harness.setState({ sessions, log: undefined });
  harness.viewport.render('follow');
  harness.runFrame(1);
  harness.elements.output.scrollTop = 46;
  harness.elements.output.scrollHeight = 800;

  const update = { ...state, lines: [...state.lines, 'new output'] };
  assert.equal(
    pageModule.applyKubernetesLogUpdate(sessions, 'app', update, harness.viewport, 'follow'),
    'selected',
  );
  assert.equal(harness.elements.output.scrollTop, 46);
  harness.runFrame(2);
  assert.equal(harness.elements.output.scrollTop, 800);
});

test('Kubernetes failed Follow mutation rolls the optimistic state back and reports the error', async () => {
  const pageModule = await import(path.join(distRenderer, 'kubernetesPage.js'));
  const original = kubernetesLogState();
  const sessions = new Map([['app', original]]);
  const mutations = new Map();
  const harness = createKubernetesLogViewportHarness(pageModule);
  const request = deferred();
  const errors = [];
  harness.setState({ sessions, log: undefined });

  const toggling = pageModule.runKubernetesLogFollowToggle({
    sessions,
    mutations,
    getSelectedContainer: () => harness.state.selectedContainer,
    viewport: harness.viewport,
    setFollowing: () => request.promise,
    onError: (error) => errors.push(error.message),
  });
  assert.equal(sessions.get('app').following, false);

  request.reject(new Error('follow rejected'));
  await toggling;

  assert.equal(sessions.get('app'), original);
  assert.equal(sessions.get('app').following, true);
  assert.deepEqual(errors, ['follow rejected']);
  assert.equal(mutations.size, 0);
});

test('Kubernetes failed Follow mutation does not roll back a newer owned log state', async () => {
  const pageModule = await import(path.join(distRenderer, 'kubernetesPage.js'));
  const sessions = new Map([['app', kubernetesLogState()]]);
  const mutations = new Map();
  const harness = createKubernetesLogViewportHarness(pageModule);
  const request = deferred();
  harness.setState({ sessions, log: undefined });

  const toggling = pageModule.runKubernetesLogFollowToggle({
    sessions,
    mutations,
    getSelectedContainer: () => harness.state.selectedContainer,
    viewport: harness.viewport,
    setFollowing: () => request.promise,
    onError: () => undefined,
  });
  const newer = kubernetesLogState({ lines: ['newer'], following: false });
  sessions.set('app', newer);
  request.reject(new Error('late rejection'));
  await toggling;

  assert.equal(sessions.get('app'), newer);
});

test('Kubernetes rapid Pause then Resume keeps the newer Follow mutation authoritative', async () => {
  const pageModule = await import(path.join(distRenderer, 'kubernetesPage.js'));
  const sessions = new Map([['app', kubernetesLogState()]]);
  const mutations = new Map();
  const harness = createKubernetesLogViewportHarness(pageModule);
  const pauseRequest = deferred();
  const resumeRequest = deferred();
  const requests = [pauseRequest, resumeRequest];
  const errors = [];
  let call = 0;
  harness.setState({ sessions, log: undefined });
  const options = {
    sessions,
    mutations,
    getSelectedContainer: () => harness.state.selectedContainer,
    viewport: harness.viewport,
    setFollowing: () => requests[call++].promise,
    onError: (error) => errors.push(error.message),
  };

  const pause = pageModule.runKubernetesLogFollowToggle(options);
  assert.equal(sessions.get('app').following, false);
  const resume = pageModule.runKubernetesLogFollowToggle(options);
  assert.equal(sessions.get('app').following, true);
  const resumeToken = mutations.get('session-app');
  assert.ok(resumeToken);

  pauseRequest.reject(new Error('stale pause failure'));
  await pause;
  assert.equal(sessions.get('app').following, true);
  assert.deepEqual(errors, []);
  assert.equal(mutations.get('session-app'), resumeToken);

  resumeRequest.resolve(kubernetesLogState({ following: true }));
  await resume;
  assert.equal(sessions.get('app').following, true);
  assert.deepEqual(errors, []);
  assert.equal(mutations.size, 0);
});

test('Kubernetes rapid Resume then Pause ignores a stale Follow success', async () => {
  const pageModule = await import(path.join(distRenderer, 'kubernetesPage.js'));
  const sessions = new Map([['app', kubernetesLogState({ following: false })]]);
  const mutations = new Map();
  const harness = createKubernetesLogViewportHarness(pageModule);
  const resumeRequest = deferred();
  const pauseRequest = deferred();
  const requests = [resumeRequest, pauseRequest];
  const errors = [];
  let call = 0;
  harness.setState({ sessions, log: undefined });
  const options = {
    sessions,
    mutations,
    getSelectedContainer: () => harness.state.selectedContainer,
    viewport: harness.viewport,
    setFollowing: () => requests[call++].promise,
    onError: (error) => errors.push(error.message),
  };

  const resume = pageModule.runKubernetesLogFollowToggle(options);
  assert.equal(sessions.get('app').following, true);
  const pause = pageModule.runKubernetesLogFollowToggle(options);
  assert.equal(sessions.get('app').following, false);
  const pauseToken = mutations.get('session-app');
  assert.ok(pauseToken);

  resumeRequest.resolve(kubernetesLogState({ following: true }));
  await resume;
  assert.equal(sessions.get('app').following, false);
  assert.equal(mutations.get('session-app'), pauseToken);

  pauseRequest.resolve(kubernetesLogState({ following: false }));
  await pause;
  assert.equal(sessions.get('app').following, false);
  assert.deepEqual(errors, []);
  assert.equal(mutations.size, 0);
});

test('Kubernetes Follow broadcasts respect the latest rapid Resume then Pause intent', async () => {
  const pageModule = await import(path.join(distRenderer, 'kubernetesPage.js'));
  const sessions = new Map([['app', kubernetesLogState({ following: false })]]);
  const mutations = new Map();
  const harness = createKubernetesLogViewportHarness(pageModule);
  const resumeRequest = deferred();
  const pauseRequest = deferred();
  const requests = [resumeRequest, pauseRequest];
  const errors = [];
  let call = 0;
  harness.setState({ sessions, log: undefined });
  const options = {
    sessions,
    mutations,
    getSelectedContainer: () => harness.state.selectedContainer,
    viewport: harness.viewport,
    setFollowing: () => requests[call++].promise,
    onError: (error) => errors.push(error.message),
  };

  const resume = pageModule.runKubernetesLogFollowToggle(options);
  assert.equal(sessions.get('app').following, true);
  const pause = pageModule.runKubernetesLogFollowToggle(options);
  assert.equal(sessions.get('app').following, false);

  const oldResumeBroadcast = kubernetesLogState({ following: true, lines: ['old resume'] });
  assert.equal(pageModule.shouldApplyKubernetesLogBroadcast(mutations, oldResumeBroadcast), false);
  const pausedState = sessions.get('app');
  if (pageModule.shouldApplyKubernetesLogBroadcast(mutations, oldResumeBroadcast)) {
    pageModule.applyKubernetesLogUpdate(sessions, 'app', oldResumeBroadcast, harness.viewport, 'follow');
  }
  assert.equal(sessions.get('app'), pausedState);
  assert.equal(sessions.get('app').following, false);

  const matchingPauseBroadcast = kubernetesLogState({ following: false, lines: ['pause confirmed'] });
  assert.equal(pageModule.shouldApplyKubernetesLogBroadcast(mutations, matchingPauseBroadcast), true);
  if (pageModule.shouldApplyKubernetesLogBroadcast(mutations, matchingPauseBroadcast)) {
    pageModule.applyKubernetesLogUpdate(sessions, 'app', matchingPauseBroadcast, harness.viewport, 'follow');
  }
  assert.equal(sessions.get('app'), matchingPauseBroadcast);
  assert.equal(sessions.get('app').following, false);

  const otherSession = kubernetesLogState({ sessionId: 'session-sidecar', container: 'sidecar', following: true });
  assert.equal(pageModule.shouldApplyKubernetesLogBroadcast(mutations, otherSession), true);

  resumeRequest.resolve(kubernetesLogState({ following: true }));
  await resume;
  assert.equal(sessions.get('app').following, false);

  pauseRequest.resolve(kubernetesLogState({ following: false }));
  await pause;
  assert.deepEqual(errors, []);
  assert.equal(mutations.size, 0);
});

test('Kubernetes replaced log session suppresses a stale Follow failure', async () => {
  const pageModule = await import(path.join(distRenderer, 'kubernetesPage.js'));
  const sessions = new Map([['app', kubernetesLogState()]]);
  const mutations = new Map();
  const harness = createKubernetesLogViewportHarness(pageModule);
  const request = deferred();
  const errors = [];
  harness.setState({ sessions, log: undefined });

  const toggling = pageModule.runKubernetesLogFollowToggle({
    sessions,
    mutations,
    getSelectedContainer: () => harness.state.selectedContainer,
    viewport: harness.viewport,
    setFollowing: () => request.promise,
    onError: (error) => errors.push(error.message),
  });
  const replacement = kubernetesLogState({ sessionId: 'session-replacement', following: true });
  sessions.set('app', replacement);
  request.reject(new Error('closed old session'));
  await toggling;

  assert.equal(sessions.get('app'), replacement);
  assert.deepEqual(errors, []);
  assert.equal(mutations.size, 0);
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

test('Kubernetes layout uses a full-width list with a bounded overlay drawer and independent workspace', async () => {
  const root = path.join(__dirname, '..');
  const html = await readFile(path.join(distRenderer, 'index.html'), 'utf8');
  const page = await readFile(path.join(distRenderer, 'kubernetesPage.js'), 'utf8');
  const styles = await readFile(path.join(root, 'src', 'renderer', 'tailwind.css'), 'utf8');

  assert.match(html, /id="kubernetes-list-page" class="kubernetes-list-page"/);
  assert.match(html, /id="kubernetes-detail-drawer"/);
  assert.match(html, /id="kubernetes-workspace"/);
  assert.match(page, /description\.title = field\.value/);
  assert.match(page, /portForwardPanel\.classList\.toggle\('hidden', forwards\.length === 0\)/);
  assert.match(styles, /\.app-shell\[data-page='kubernetes'\][\s\S]*?@apply[^;]*mx-0[^;]*max-w-none/);
  assert.match(styles, /\.app-shell\[data-page='kubernetes'\][\s\S]*?height:\s*100dvh/);
  const listRule = styles.match(/\.kubernetes-list-page\s*\{([^}]*)\}/);
  const drawerRule = styles.match(/\.kubernetes-detail-drawer\s*\{([^}]*)\}/);
  const panelRule = styles.match(/\.kubernetes-detail-drawer-panel\s*\{([^}]*)\}/);
  const drawerBodyRule = styles.match(/\.kubernetes-detail-drawer-body\s*\{([^}]*)\}/);
  const tableRule = styles.match(/\.kubernetes-table-shell\s*\{([^}]*)\}/);
  const workspaceRule = styles.match(/\.kubernetes-workspace\s*\{([^}]*)\}/);
  const overviewRule = styles.match(/\.kubernetes-detail-overview-grid\s*\{([^}]*)\}/);

  assert.ok(listRule);
  assert.ok(drawerRule);
  assert.ok(panelRule);
  assert.ok(drawerBodyRule);
  assert.ok(tableRule);
  assert.ok(workspaceRule);
  assert.ok(overviewRule);
  assert.match(listRule[1], /grid-template-rows:\s*auto auto minmax\(0, 1fr\) auto;/);
  assert.match(drawerRule[1], /@apply[^;]*absolute[^;]*inset-0/);
  assert.match(panelRule[1], /width:\s*clamp\(560px,\s*38vw,\s*720px\)/);
  assert.match(panelRule[1], /@apply[^;]*right-0[^;]*grid[^;]*min-h-0/);
  assert.match(drawerBodyRule[1], /overflow-y-auto/);
  assert.match(drawerBodyRule[1], /grid-auto-rows:\s*max-content/);
  assert.match(tableRule[1], /grid-template-rows:\s*auto minmax\(0, 1fr\)/);
  assert.match(workspaceRule[1], /grid-template-rows:\s*6px auto minmax\(0,\s*1fr\)/);
  assert.doesNotMatch(styles, /\.kubernetes-detail-page\s*\{/);
  assert.doesNotMatch(styles, /\.kubernetes-detail-copy\s*\{/);
  assert.match(styles, /\.kubernetes-port-forwards\s*\{[\s\S]*?absolute/);
  assert.match(styles, /\.kubernetes-related-list\s*\{/);
  assert.match(styles, /\.kubernetes-related-row\s*\{/);
  assert.match(styles, /\.kubernetes-related-pod-link\s*\{/);
});

test('Kubernetes drawer narrows while Namespace menus remain unclipped and other controls scroll internally', async () => {
  const styles = await readFile(path.join(__dirname, '..', 'src', 'renderer', 'tailwind.css'), 'utf8');
  const responsiveStart = styles.indexOf('@media (max-width: 640px)');
  assert.ok(responsiveStart >= 0);
  const responsiveStyles = styles.slice(responsiveStart);
  const controlRowRule = styles.match(/\.kubernetes-control-row\s*\{([^}]*)\}/);
  assert.ok(controlRowRule);
  assert.match(responsiveStyles, /\.kubernetes-detail-drawer-panel\s*\{\s*width:\s*min\(100%,\s*560px\)/);
  assert.match(responsiveStyles, /\.kubernetes-drawer-header-grid\s*\{[\s\S]*?grid-cols-1/);
  assert.match(controlRowRule[1], /overflow-visible/);
  assert.doesNotMatch(controlRowRule[1], /overflow-[xy]-auto/);
  assert.match(styles, /\.kubernetes-secondary-row\s*\{[\s\S]*?overflow-x-auto/);
  assert.match(styles, /\.kubernetes-category-tabs\s*\{[\s\S]*?flex-nowrap[^;]*overflow-x-auto/);
  assert.match(styles, /\.kubernetes-resource-tabs\s*\{[\s\S]*?flex-nowrap[^;]*overflow-x-auto/);
});

test('Kubernetes workspace owns a bounded Shell pane while port forwards stay independent', async () => {
  const styles = await readFile(path.join(__dirname, '..', 'src', 'renderer', 'tailwind.css'), 'utf8');
  const forwardRule = styles.match(/\.kubernetes-port-forwards\s*\{([^}]*)\}/);
  const workspaceRule = styles.match(/\.kubernetes-workspace\s*\{([^}]*)\}/);
  const logPanelRule = styles.match(/\.kubernetes-log-panel\s*\{([^}]*)\}/);
  const logOutputRule = styles.match(/\.kubernetes-log-output\s*\{([^}]*)\}/);
  const shellRule = styles.match(/\.kubernetes-shell-panel\s*\{([^}]*)\}/);
  const shellHostRule = styles.match(/\.kubernetes-shell-pane-host\s*\{([^}]*)\}/);
  const resizeHandleRule = styles.match(/\.kubernetes-workspace-resize-handle\s*\{([^}]*)\}/);
  assert.ok(forwardRule);
  assert.ok(workspaceRule);
  assert.ok(logPanelRule);
  assert.ok(logOutputRule);
  assert.ok(shellRule);
  assert.ok(shellHostRule);
  assert.ok(resizeHandleRule);
  assert.match(workspaceRule[1], /height:\s*min\(30dvh,\s*240px\)/);
  assert.match(workspaceRule[1], /max-height:\s*80dvh/);
  assert.match(workspaceRule[1], /min-height:\s*120px/);
  assert.match(workspaceRule[1], /grid-template-rows:\s*6px auto minmax\(0,\s*1fr\)/);
  assert.match(resizeHandleRule[1], /cursor-ns-resize/);
  assert.match(resizeHandleRule[1], /touch-none/);
  assert.match(logPanelRule[1], /@apply[^;]*h-full[^;]*min-h-0/);
  assert.match(logPanelRule[1], /grid-template-rows:\s*auto minmax\(0, 1fr\) auto;/);
  assert.match(logOutputRule[1], /min-h-0[^;]*overflow-y-auto/);
  assert.doesNotMatch(shellRule[1], /grid-rows-\[auto_minmax\(0,1fr\)\]/);
  assert.match(shellHostRule[1], /h-full/);
  assert.match(forwardRule[1], /absolute/);
  assert.doesNotMatch(styles, /\.kubernetes-terminal-drawer\s*\{/);
  assert.doesNotMatch(styles, /kubernetes-terminal-drawer:not/);
});

test('Kubernetes workspace tabs and Pod container actions use semantic typed palettes', async () => {
  const styles = await readFile(path.join(__dirname, '..', 'src', 'renderer', 'tailwind.css'), 'utf8');
  const builtStyles = await readFile(path.join(distRenderer, 'tailwind.css'), 'utf8');
  const logsTabRule = styles.match(/\.kubernetes-workspace-tab-logs\s*\{([^}]*)\}/);
  const shellTabRule = styles.match(/\.kubernetes-workspace-tab-shell\s*\{([^}]*)\}/);
  const selectedLogsTabRule = styles.match(/\.kubernetes-workspace-tab-logs:has\(\.kubernetes-workspace-tab-select\[aria-selected='true'\]\)\s*\{([^}]*)\}/);
  const selectedShellTabRule = styles.match(/\.kubernetes-workspace-tab-shell:has\(\.kubernetes-workspace-tab-select\[aria-selected='true'\]\)\s*\{([^}]*)\}/);
  const tabSelectRule = styles.match(/\.kubernetes-workspace-tab-select\s*\{([^}]*)\}/);
  const closeRule = styles.match(/\.kubernetes-workspace-tab-close\s*\{([^}]*)\}/);
  const tabsRule = styles.match(/\.kubernetes-workspace-tabs\s*\{([^}]*)\}/);
  const logToolbarRule = styles.match(/\.kubernetes-log-toolbar\s*\{([^}]*)\}/);
  const logSearchRule = styles.match(/\.kubernetes-log-toolbar \.kubernetes-log-search-field\s*\{([^}]*)\}/);
  const logScopeRule = styles.match(/\.kubernetes-log-scope-switch\s*\{([^}]*)\}/);
  const activeLogScopeRule = styles.match(/\.kubernetes-log-scope-switch\[aria-checked='true'\]\s*\{([^}]*)\}/);
  const containersContentRule = styles.match(/\.kubernetes-drawer-containers-content\s*\{([^}]*)\}/);
  const containerRule = styles.match(/\.kubernetes-drawer-container\s*\{([^}]*)\}/);
  const primaryRule = styles.match(/\.kubernetes-drawer-container-primary\s*\{([^}]*)\}/);
  const actionsRule = styles.match(/\.kubernetes-drawer-container-actions\s*\{([^}]*)\}/);
  const logsActionRule = styles.match(/\.kubernetes-drawer-container-action-logs\s*\{([^}]*)\}/);
  const shellActionRule = styles.match(/\.kubernetes-drawer-container-action-shell\s*\{([^}]*)\}/);

  assert.ok(logsTabRule);
  assert.ok(shellTabRule);
  assert.ok(selectedLogsTabRule);
  assert.ok(selectedShellTabRule);
  assert.ok(tabSelectRule);
  assert.ok(closeRule);
  assert.ok(tabsRule);
  assert.ok(logToolbarRule);
  assert.ok(logSearchRule);
  assert.ok(logScopeRule);
  assert.ok(activeLogScopeRule);
  assert.ok(containersContentRule);
  assert.ok(containerRule);
  assert.ok(primaryRule);
  assert.ok(actionsRule);
  assert.ok(logsActionRule);
  assert.ok(shellActionRule);
  assert.match(logsTabRule[1], /amber/);
  assert.match(shellTabRule[1], /blue/);
  assert.match(builtStyles, /\.kubernetes-workspace-tab-logs(?:\{|,)/);
  assert.match(builtStyles, /\.kubernetes-workspace-tab-shell(?:\{|,)/);
  assert.match(selectedLogsTabRule[1], /amber-700/);
  assert.match(selectedShellTabRule[1], /blue/);
  assert.match(tabSelectRule[1], /h-6/);
  assert.match(tabSelectRule[1], /max-w-\[140px\]/);
  assert.match(tabSelectRule[1], /px-1\.5/);
  assert.match(tabsRule[1], /gap-0\.5/);
  assert.match(tabsRule[1], /px-1\.5[^;]*py-0\.5/);
  assert.match(logToolbarRule[1], /gap-1/);
  assert.match(logToolbarRule[1], /px-1\.5[^;]*py-1/);
  assert.match(logSearchRule[1], /h-6/);
  assert.match(logScopeRule[1], /h-6/);
  assert.match(logScopeRule[1], /shrink-0/);
  assert.match(activeLogScopeRule[1], /amber/);
  assert.match(builtStyles, /\.kubernetes-log-scope-switch\[aria-checked=true\]/);
  assert.match(closeRule[1], /text-inherit/);
  assert.match(closeRule[1], /bg-transparent/);
  assert.match(closeRule[1], /!h-6/);
  assert.match(closeRule[1], /!rounded-none/);
  assert.doesNotMatch(closeRule[1], /\bborder-l\b/);
  const builtCloseRule = builtStyles.match(/\.kubernetes-workspace-tab-close\{([^}]*)\}/);
  assert.ok(builtCloseRule);
  assert.match(builtCloseRule[1], /height:1\.5rem!important/);
  assert.match(builtCloseRule[1], /border-radius:0!important/);
  assert.match(containersContentRule[1], /gap-0[^;]*p-0/);
  assert.match(containerRule[1], /border-0/);
  assert.match(containerRule[1], /border-b/);
  assert.doesNotMatch(containerRule[1], /rounded/);
  assert.match(primaryRule[1], /flex[^;]*min-w-0[^;]*flex-1[^;]*items-center[^;]*gap-1/);
  assert.match(actionsRule[1], /gap-0\.5/);
  assert.match(logsActionRule[1], /amber/);
  assert.match(shellActionRule[1], /blue/);
});

/* The Task 4 floating-drawer test body is retained below only as historical
 * context. Task 5 removes that component entirely in favor of the pane test
 * that follows this block. */
/*
test('Kubernetes terminal drawer disposes final closed or errored sessions and ignores late revival events', async () => {
  const originalWindow = global.window;
  const originalDocument = global.document;
  const instances = [];
  const listeners = new Map();
  const fits = [];
  const frames = [];
  const closeCalls = [];
  let scrollIntoViewCount = 0;
  const runFrame = () => {
    const callback = frames.shift();
    assert.ok(callback, 'expected a queued terminal animation frame');
    callback(0);
  };

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
    constructor() {
      this.fitCount = 0;
      fits.push(this);
    }

    fit() { this.fitCount += 1; }
  }

  global.window = {
    Terminal: FakeTerminal,
    FitAddon: { FitAddon: FakeFitAddon },
    addEventListener(name, listener) { listeners.set(name, listener); },
    removeEventListener(name) { listeners.delete(name); },
    requestAnimationFrame(callback) {
      frames.push(callback);
      return frames.length;
    },
  };
  global.document = { createElement: () => new FakeElement() };

  try {
    const { createKubernetesTerminalDrawer, createKubernetesTerminalPane } = await import(path.join(distRenderer, 'kubernetesTerminal.js'));
    const root = new FakeElement();
    const drawer = createKubernetesTerminalDrawer({
      root,
      onInput: async () => {},
      onResize: async () => {},
      onClose: async (id) => { closeCalls.push(id); },
    });
    const normal = { id: 'terminal-normal', namespace: 'apps', podName: 'api', container: 'api', shell: '/bin/sh', state: 'open' };
    const failed = { ...normal, id: 'terminal-error' };

    drawer.open(normal);
    runFrame();
    assert.equal(instances[0].focusCount, 1);
    assert.equal(scrollIntoViewCount, 1);
    assert.equal(fits[0].fitCount, 1);
    drawer.hide();
    assert.equal(root.classList.contains('hidden'), true);
    assert.equal(root.children.length, 1);
    assert.equal(instances[0].disposeCount, 0);
    assert.equal(drawer.focusTarget({ namespace: 'apps', podName: 'api', container: 'api' }), normal.id);
    runFrame();
    assert.equal(root.classList.contains('hidden'), false);
    assert.equal(instances.length, 1);
    assert.equal(instances[0].focusCount, 2);
    assert.equal(scrollIntoViewCount, 2);
    assert.equal(fits[0].fitCount, 2);
    assert.equal(drawer.focusTarget({ namespace: 'apps', podName: 'api', container: 'sidecar' }), undefined);
    assert.equal(instances[0].focusCount, 2);
    assert.equal(scrollIntoViewCount, 2);
    assert.equal(fits[0].fitCount, 2);
    drawer.write(normal.id, 'visible');
    drawer.open({ ...normal, state: 'closed' });
    drawer.write(normal.id, 'late');
    drawer.open(normal);

    assert.equal(instances.length, 1);
    assert.equal(instances[0].disposeCount, 1);
    assert.deepEqual(instances[0].writes, ['visible']);
    assert.equal(root.children.length, 0);
    assert.equal(root.classList.contains('hidden'), true);

    const background = { ...normal, id: 'terminal-background', container: 'sidecar' };
    drawer.open(background, false);
    assert.equal(instances.length, 2);
    assert.equal(instances[1].focusCount, 0);
    assert.equal(scrollIntoViewCount, 2);
    assert.equal(fits[1].fitCount, 0);
    assert.equal(root.classList.contains('hidden'), true);
    drawer.open(background);
    assert.equal(instances.length, 2);
    drawer.hide();
    runFrame();
    assert.equal(instances[1].focusCount, 0);
    assert.equal(scrollIntoViewCount, 2);
    assert.equal(fits[1].fitCount, 0);
    assert.equal(root.classList.contains('hidden'), true);
    assert.equal(drawer.sessionIdForTarget({ namespace: 'apps', podName: 'api', container: 'sidecar' }), background.id);
    assert.equal(drawer.focusSession(background.id), true);
    runFrame();
    assert.equal(instances.length, 2);
    assert.equal(instances[1].focusCount, 1);
    assert.equal(scrollIntoViewCount, 3);
    assert.equal(fits[1].fitCount, 1);
    assert.equal(root.classList.contains('hidden'), false);
    drawer.open({ ...background, state: 'closed' });
    assert.equal(instances[1].disposeCount, 1);
    assert.equal(root.classList.contains('hidden'), true);

    drawer.open(failed);
    runFrame();
    drawer.write(failed.id, 'visible error');
    drawer.open({ ...failed, state: 'error', error: 'exec stream lost' });
    drawer.write(failed.id, 'late error');
    drawer.open(failed);

    assert.equal(instances.length, 3);
    assert.equal(instances[2].disposeCount, 1);
    assert.deepEqual(instances[2].writes, ['visible error']);
    assert.equal(root.children.length, 0);
    assert.equal(root.classList.contains('hidden'), true);

    const locallyClosed = { ...normal, id: 'terminal-local-close', container: 'worker' };
    drawer.open(locallyClosed);
    runFrame();
    const instanceCountBeforeLateEvents = instances.length;
    drawer.close(locallyClosed.id);
    assert.deepEqual(closeCalls, [locallyClosed.id]);
    assert.equal(root.children.length, 0);
    assert.equal(root.classList.contains('hidden'), true);

    drawer.open({ ...locallyClosed, state: 'connecting' });
    drawer.open({ ...locallyClosed, state: 'open' });

    assert.equal(instances.length, instanceCountBeforeLateEvents);
    assert.equal(root.children.length, 0);
    assert.equal(root.classList.contains('hidden'), true);
    assert.equal(drawer.focusTarget({
      namespace: locallyClosed.namespace,
      podName: locallyClosed.podName,
      container: locallyClosed.container,
    }), undefined);
    assert.equal(drawer.focusSession(locallyClosed.id), false);
    assert.deepEqual(closeCalls, [locallyClosed.id]);

    const buttonClosed = { ...normal, id: 'terminal-button-close', container: 'metrics' };
    drawer.open(buttonClosed);
    runFrame();
    const closeButton = root.children[0].children[0].children[1];
    const click = closeButton.listeners.get('click');
    assert.equal(typeof click, 'function');
    const instanceCountBeforeButtonLateEvents = instances.length;
    click();
    assert.deepEqual(closeCalls, [locallyClosed.id, buttonClosed.id]);
    assert.equal(root.children.length, 0);
    assert.equal(root.classList.contains('hidden'), true);

    drawer.open({ ...buttonClosed, state: 'connecting' });
    drawer.open({ ...buttonClosed, state: 'open' });

    assert.equal(instances.length, instanceCountBeforeButtonLateEvents);
    assert.equal(root.children.length, 0);
    assert.equal(root.classList.contains('hidden'), true);
    assert.equal(drawer.focusTarget({
      namespace: buttonClosed.namespace,
      podName: buttonClosed.podName,
      container: buttonClosed.container,
    }), undefined);
    assert.equal(drawer.focusSession(buttonClosed.id), false);
    assert.deepEqual(closeCalls, [locallyClosed.id, buttonClosed.id]);

    const paneCloseCalls = [];
    const pane = createKubernetesTerminalPane({
      onInput: async () => {},
      onResize: async () => {},
      onClose: async (id) => { paneCloseCalls.push(id); },
    });
    const paneHost = new FakeElement();
    const paneOld = { ...normal, id: 'terminal-pane-old', container: 'worker' };
    const paneNew = { ...normal, id: 'terminal-pane-new', container: 'worker' };
    pane.mount(paneOld, paneHost);
    const oldTerminal = instances.at(-1);
    pane.write({ id: paneOld.id, data: 'old visible' });
    assert.deepEqual(oldTerminal.writes, ['old visible']);
    assert.equal(pane.finalize({ id: paneOld.id, state: 'closed' }), true);
    pane.mount(paneNew, paneHost);
    const newTerminal = instances.at(-1);
    assert.notEqual(newTerminal, oldTerminal);
    assert.equal(pane.write({ id: paneOld.id, data: 'stale output' }), false);
    assert.deepEqual(newTerminal.writes, []);
    assert.equal(pane.write({ id: paneNew.id, data: 'new output' }), true);
    assert.deepEqual(newTerminal.writes, ['new output']);
    assert.equal(pane.finalize({ id: paneOld.id, state: 'closed' }), false);
    assert.equal(pane.finalize({ id: paneNew.id, state: 'closed' }), true);
    assert.equal(pane.write({ id: paneNew.id, data: 'late output' }), false);
    assert.deepEqual(paneCloseCalls, []);
    pane.dispose();

    const beforeMount = createKubernetesTerminalPane({
      onInput: async () => {},
      onResize: async () => {},
      onClose: async () => {},
    });
    const beforeMountState = { ...normal, id: 'terminal-final-before-mount', container: 'worker' };
    assert.equal(beforeMount.finalize({ id: beforeMountState.id, state: 'closed' }), false);
    assert.equal(beforeMount.mount(beforeMountState, new FakeElement()), false);
    assert.equal(beforeMount.write({ id: beforeMountState.id, data: 'stale output' }), false);

    drawer.dispose();
  } finally {
    global.window = originalWindow;
    global.document = originalDocument;
  }
});
*/

test('Kubernetes workspace terminal pane finalizes exact IDs and never owns a floating drawer', async () => {
  const terminal = await readFile(path.join(distRenderer, 'kubernetesTerminal.js'), 'utf8');
  const page = await readFile(path.join(distRenderer, 'kubernetesPage.js'), 'utf8');

  assert.match(terminal, /createKubernetesTerminalPane/);
  assert.match(terminal, /finalizedIds\.add\(state\.id\)/);
  assert.match(terminal, /current\.state\.id !== output\.id/);
  assert.match(terminal, /next\.state\.state !== 'open'/);
  assert.match(terminal, /current\.state\.state !== 'open'/);
  assert.doesNotMatch(terminal, /createKubernetesTerminalDrawer|kubernetes-terminal-drawer/);
  assert.match(page, /this\.workspace\?\.onTerminalChanged\(state\)/);
  assert.match(page, /this\.workspace\?\.onTerminalOutput\(output\)/);
  assert.doesNotMatch(page, /createKubernetesTerminalDrawer/);
});

test('Kubernetes Task 5 page delegates terminal runtime callbacks to the workspace', async () => {
  const page = await readFile(path.join(distRenderer, 'kubernetesPage.js'), 'utf8');

  assert.match(page, /onTerminalChanged\(\(state\) => this\.workspace\?\.onTerminalChanged\(state\)\)/);
  assert.match(page, /onTerminalOutput\(\(output\) => this\.workspace\?\.onTerminalOutput\(output\)\)/);
  assert.doesNotMatch(page, /createKubernetesTerminalDrawer/);
  assert.match(page, /openPortForwardDialog\(\)/);
});

test('Kubernetes shell has label-free compact controls, no Cluster category, and one eight-column table', async () => {
  const html = await readFile(path.join(distRenderer, 'index.html'), 'utf8');
  const pageSource = await readFile(path.join(distRenderer, 'kubernetesPage.js'), 'utf8');
  const page = await import(path.join(distRenderer, 'kubernetesPage.js'));
  const controlStart = html.indexOf('class="kubernetes-control-row"');
  const controlEnd = html.indexOf('class="kubernetes-secondary-row"', controlStart);
  const controls = html.slice(controlStart, controlEnd);

  assert.match(html, /id="kubernetes-context-toggle"[^>]*aria-label="Kubernetes Context"/);
  assert.match(html, /id="kubernetes-namespace-toggle"[^>]*aria-label="Kubernetes Namespace scope"/);
  assert.doesNotMatch(controls, />Context\s*</);
  assert.doesNotMatch(controls, />Namespace\s*</);
  assert.doesNotMatch(pageSource, /Cluster:\s*\[/);
  assert.deepEqual(page.getKubernetesListColumns('pods').map(({ label }) => label),
    ['Namespace', 'Name', 'CPU', 'Memory', 'Restarts', 'Status', 'Node', 'Age']);
  assert.match(html, /id="kubernetes-table-header"[^>]*><\/div>/);
  assert.match(html, /id="kubernetes-detail-drawer"/);
  assert.doesNotMatch(html, /id="kubernetes-detail-page"/);
  assert.doesNotMatch(html, />Search loaded resources\s*</);
  assert.match(html, /id="kubernetes-resource-search"[^>]*aria-label="Search loaded resources"/);
});

test('Kubernetes drawer request identity fences stale replacement completions', async () => {
  const { isCurrentKubernetesDrawerRequest } = await import(path.join(distRenderer, 'kubernetesPage.js'));
  const current = { visible: true, pageGeneration: 2, drawerGeneration: 4, uid: 'pod-a' };

  assert.equal(isCurrentKubernetesDrawerRequest(current, current), true);
  assert.equal(isCurrentKubernetesDrawerRequest(current, {
    visible: true, pageGeneration: 2, drawerGeneration: 5, uid: 'pod-b',
  }), false);
  assert.equal(isCurrentKubernetesDrawerRequest(current, {
    visible: true, pageGeneration: 3, drawerGeneration: 4, uid: 'pod-a',
  }), false);
  assert.equal(isCurrentKubernetesDrawerRequest(current, {
    visible: false, pageGeneration: 2, drawerGeneration: 4, uid: 'pod-a',
  }), false);
});

test('Kubernetes drawer Env completion applies only to its current drawer generation and exact target', async () => {
  const { isCurrentKubernetesEnvironmentRequest } = await import(path.join(distRenderer, 'kubernetesPage.js'));
  const target = { namespace: 'apps', podName: 'api', container: 'api' };
  const current = { visible: true, drawerGeneration: 7, target };

  assert.equal(isCurrentKubernetesEnvironmentRequest(current, { visible: true, drawerGeneration: 7, target: { ...target } }), true);
  assert.equal(isCurrentKubernetesEnvironmentRequest(current, { visible: true, drawerGeneration: 8, target }), false);
  assert.equal(isCurrentKubernetesEnvironmentRequest(current, {
    visible: true, drawerGeneration: 7, target: { ...target, namespace: 'other' },
  }), false);
  assert.equal(isCurrentKubernetesEnvironmentRequest(current, {
    visible: true, drawerGeneration: 7, target: { ...target, podName: 'worker' },
  }), false);
  assert.equal(isCurrentKubernetesEnvironmentRequest(current, {
    visible: true, drawerGeneration: 7, target: { ...target, container: 'sidecar' },
  }), false);
  assert.equal(isCurrentKubernetesEnvironmentRequest(current, { visible: false, drawerGeneration: 7, target }), false);
});

test('Kubernetes active drawer Env remains lazy, local, and text-safe', async () => {
  const page = await readFile(path.join(distRenderer, 'kubernetesPage.js'), 'utf8');
  const styles = await readFile(path.join(__dirname, '..', 'src', 'renderer', 'tailwind.css'), 'utf8');
  const environmentStart = page.indexOf('    renderContainerEnvironment(');
  const environmentEnd = page.indexOf('    createDrawerSection(', environmentStart);
  const environment = page.slice(environmentStart, environmentEnd);
  const searchHandlerStart = environment.indexOf("search.addEventListener('input'");
  const searchHandlerEnd = environment.indexOf('content.appendChild(search)', searchHandlerStart);
  const searchHandler = environment.slice(searchHandlerStart, searchHandlerEnd);
  const envListRule = styles.match(/\.kubernetes-env-list\s*\{([^}]*)\}/);
  const envRowRule = styles.match(/\.kubernetes-env-row\s*\{([^}]*)\}/);
  const envValueRule = styles.match(/\.kubernetes-env-row pre\s*\{([^}]*)\}/);
  const factRowRule = styles.match(/\.kubernetes-drawer-facts > div\s*\{([^}]*)\}/);
  const containerBlockRule = styles.match(/\.kubernetes-drawer-container-block\s*\{([^}]*)\}/);
  const infoTitleRule = styles.match(/\.kubernetes-drawer-container-info-title\s*\{([^}]*)\}/);
  const envTitleRule = styles.match(/\.kubernetes-drawer-container-env-toggle\s*\{([^}]*)\}/);
  const labelKeyRule = styles.match(/\.kubernetes-drawer-label-row > span:first-child\s*\{([^}]*)\}/);
  const labelValueRule = styles.match(/\.kubernetes-drawer-label-row > span:last-child\s*\{([^}]*)\}/);

  assert.ok(environmentStart >= 0 && environmentEnd > environmentStart);
  assert.ok(envListRule);
  assert.ok(envRowRule);
  assert.ok(envValueRule);
  assert.ok(factRowRule);
  assert.ok(containerBlockRule);
  assert.ok(infoTitleRule);
  assert.ok(envTitleRule);
  assert.ok(labelKeyRule);
  assert.ok(labelValueRule);
  assert.ok(searchHandlerStart >= 0 && searchHandlerEnd > searchHandlerStart);
  assert.match(page, /drawerEnvironment/);
  assert.match(environment, /expanded:\s*false/);
  assert.match(page, /state\.result \|\| state\.loading \|\| state\.error/);
  assert.match(page, /getPodContainerEnvironment\(state\.target\)/);
  assert.match(environment, /aria-label', 'Search environment'/);
  assert.match(environment, /filterKubernetesEnvironmentEntries\(result\.entries, state\.search\)/);
  assert.match(searchHandler, /while \(search\.nextSibling\)\s*search\.nextSibling\.remove\(\)/);
  assert.doesNotMatch(searchHandler, /this\.renderDetail\(\)/);
  assert.match(environment, /value\.textContent = entry\.value \?\? environmentUnavailableLabel\(entry\.unavailable\)/);
  assert.match(environment, /row\.append\(name, value\)/);
  assert.doesNotMatch(environment, /environmentSourceLabel|kubernetes-env-reference|source\.textContent/);
  assert.doesNotMatch(envListRule[1], /max-h-|overflow-y-auto/);
  assert.match(factRowRule[1], /grid-template-columns:\s*minmax\(0,\s*1fr\) minmax\(0,\s*2fr\)/);
  assert.match(envRowRule[1], /grid-template-columns:\s*minmax\(0,\s*1fr\) minmax\(0,\s*2fr\)/);
  assert.match(envRowRule[1], /items-center/);
  assert.doesNotMatch(envRowRule[1], /items-start|p-1\.5/);
  assert.match(infoTitleRule[1], /bg-sky-100/);
  assert.match(envTitleRule[1], /bg-emerald-100/);
  assert.doesNotMatch(envValueRule[1], /col-span-2/);
  assert.doesNotMatch(envValueRule[1], /py-1/);
  assert.match(envValueRule[1], /whitespace-pre-wrap/);
  assert.match(labelKeyRule[1], /justify-self-start[^;]*text-left|text-left[^;]*justify-self-start/);
  assert.match(labelValueRule[1], /justify-self-stretch[^;]*text-right|text-right[^;]*justify-self-stretch/);
  assert.match(environment, /No permission to read referenced Secret/);
  assert.match(environment, /Unable to load environment/);
  assert.match(environment, /Environment values truncated for safe display/);
  assert.match(page, /isCurrentKubernetesEnvironmentRequest\(/);
  assert.doesNotMatch(environment, /innerHTML|toErrorMessage\(error\)|setMessage\(/);
});

test('Kubernetes list updates render behind an active drawer and drawer values remain text-safe', async () => {
  const page = await readFile(path.join(distRenderer, 'kubernetesPage.js'), 'utf8');
  const listStart = page.indexOf('    onListChanged(snapshot) {');
  const listEnd = page.indexOf('    renderState() {', listStart);
  const onListChanged = page.slice(listStart, listEnd);
  const drawerStart = page.indexOf('    renderPodDrawer(detail, active) {');
  const drawerEnd = page.indexOf('    renderRelatedDetail(detail, active) {', drawerStart);
  const drawer = page.slice(drawerStart, drawerEnd);

  assert.ok(listStart >= 0 && listEnd > listStart);
  assert.match(onListChanged, /this\.renderList\(\);/);
  assert.doesNotMatch(onListChanged, /if \(!this\.activeDetail\) this\.renderList\(\)/);
  assert.ok(drawerStart >= 0 && drawerEnd > drawerStart);
  assert.match(drawer, /buildKubernetesDrawerModel\(detail,/);
  assert.match(drawer, /\.textContent = /);
  assert.doesNotMatch(drawer, /innerHTML/);
});
