const test = require('node:test');
const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');

const rendererPath = path.join(__dirname, '..', 'dist', 'renderer');
const modelPath = path.join(rendererPath, 'kubernetesDetailModel.js');

test('Kubernetes drawer-workspace documentation preserves the secret boundary and architecture map', async () => {
  const root = path.join(__dirname, '..');
  const documents = await Promise.all([
    readFile(path.join(root, 'README.md'), 'utf8'),
    readFile(path.join(root, 'AGENTS.md'), 'utf8'),
  ]);

  for (const document of documents) {
    assert.match(document, /secretKeyRef.*envFrom.*active drawer|active drawer.*secretKeyRef.*envFrom/i);
    assert.match(document, /main process.*(?:narrow|active-drawer) request|(?:narrow|active-drawer) request.*main process/i);
    assert.match(document, /bound(?:ed|).*local(?:ly)? searchable|local(?:ly)? searchable.*bound(?:ed)/i);
    assert.match(document, /never.*cache.*settings.*diagnostics.*disk|cache.*settings.*diagnostics.*disk.*never/i);
    assert.match(document, /src\/main\/kubernetes\/podSummary\.ts/);
    assert.match(document, /src\/main\/kubernetes\/podEnvironment\.ts/);
    assert.match(document, /src\/renderer\/kubernetesDrawerModel\.ts/);
    assert.match(document, /src\/renderer\/kubernetesWorkspace\.ts/);
    assert.match(document, /src\/renderer\/kubernetesTerminal\.ts.*reusable xterm pane|reusable xterm pane.*src\/renderer\/kubernetesTerminal\.ts/i);
  }
});

test('detectKubernetesForwardPorts extracts stable deduplicated Pod TCP declarations with provenance', async () => {
  const { detectKubernetesForwardPorts } = await import(modelPath);
  const detail = {
    spec: {
      containers: [
        {
          name: 'app',
          ports: [
            { name: 'http', containerPort: 3000, protocol: 'TCP', hostPort: 13000, hostIP: '127.0.0.1' },
            { name: 'metrics', containerPort: 9090 },
            { containerPort: 3000, protocol: 'TCP' },
            { name: 'dns', containerPort: 53, protocol: 'UDP' },
            { name: 'sctp', containerPort: 54, protocol: 'SCTP' },
            { name: 'unknown', containerPort: 55, protocol: 'tcp' },
            { name: 'string', containerPort: '8080' },
            { name: 'fraction', containerPort: 80.5 },
            { name: 'zero', containerPort: 0 },
            { name: 'too-high', containerPort: 65536 },
          ],
        },
        'not-a-container',
        {
          name: 'sidecar',
          ports: [
            { name: 'admin', containerPort: 9090, protocol: 'TCP' },
            { containerPort: 443 },
          ],
        },
      ],
      initContainers: [
        { name: 'setup', ports: [{ name: 'ignored-init', containerPort: 1111 }] },
        {
          name: 'native-sidecar',
          restartPolicy: 'Always',
          ports: [
            { name: 'proxy', containerPort: 15000, protocol: 'TCP' },
            { name: 'shared', containerPort: 3000 },
          ],
        },
        {
          name: 'wrong-case',
          restartPolicy: 'always',
          ports: [{ name: 'ignored-policy', containerPort: 2222 }],
        },
      ],
      ephemeralContainers: [
        { name: 'debug', ports: [{ name: 'ignored-ephemeral', containerPort: 3333 }] },
      ],
    },
  };

  assert.deepEqual(detectKubernetesForwardPorts(detail, 'pod'), [
    {
      remotePort: 3000,
      declarations: [
        { owner: 'app', name: 'http', source: 'container' },
        { owner: 'app', source: 'container' },
        { owner: 'native-sidecar', name: 'shared', source: 'restartable-init' },
      ],
    },
    {
      remotePort: 9090,
      declarations: [
        { owner: 'app', name: 'metrics', source: 'container' },
        { owner: 'sidecar', name: 'admin', source: 'container' },
      ],
    },
    {
      remotePort: 443,
      declarations: [{ owner: 'sidecar', source: 'container' }],
    },
    {
      remotePort: 15000,
      declarations: [{ owner: 'native-sidecar', name: 'proxy', source: 'restartable-init' }],
    },
  ]);
  assert.deepEqual(detectKubernetesForwardPorts({ spec: { containers: 'invalid' } }, 'pod'), []);
});

test('detectKubernetesForwardPorts extracts Service port values without targetPort or nodePort', async () => {
  const { detectKubernetesForwardPorts } = await import(modelPath);
  const detail = {
    spec: {
      ports: [
        { name: 'web', port: 80, targetPort: 8080, nodePort: 30080 },
        { name: 'metrics', port: 9090, protocol: 'TCP', targetPort: 19090 },
        { name: 'web-alias', port: 80, protocol: 'TCP' },
        { name: 'dns', port: 53, protocol: 'UDP' },
        { name: 'sctp', port: 54, protocol: 'SCTP' },
        { name: 'unknown', port: 55, protocol: 'tcp' },
        { name: 'string', port: '443' },
        { name: 'fraction', port: 443.5 },
        { name: 'zero', port: 0 },
        { name: 'too-high', port: 65536 },
        { name: 'not-a-port', targetPort: 7000, nodePort: 31000 },
        'not-a-service-port',
      ],
    },
  };

  assert.deepEqual(detectKubernetesForwardPorts(detail, 'service'), [
    {
      remotePort: 80,
      declarations: [
        { name: 'web', source: 'service' },
        { name: 'web-alias', source: 'service' },
      ],
    },
    {
      remotePort: 9090,
      declarations: [{ name: 'metrics', source: 'service' }],
    },
  ]);
  assert.deepEqual(detectKubernetesForwardPorts({ spec: { ports: 'invalid' } }, 'service'), []);
});

test('buildKubernetesPortForwardDialogModel leaves zero blank, prefills one, and requires selection for many', async () => {
  const { buildKubernetesPortForwardDialogModel } = await import(modelPath);
  const declared = { remotePort: 3000, declarations: [] };
  const another = { remotePort: 8080, declarations: [] };

  assert.deepEqual(buildKubernetesPortForwardDialogModel([]), {
    remotePort: '',
    selectorVisible: false,
    hint: 'No TCP port is declared. Enter a Remote Port manually.',
  });
  assert.deepEqual(buildKubernetesPortForwardDialogModel([declared]), {
    remotePort: '3000',
    selectorVisible: false,
    hint: 'The declared port is prefilled. You can edit the Remote Port.',
  });
  assert.deepEqual(buildKubernetesPortForwardDialogModel([declared, another]), {
    remotePort: '',
    selectorVisible: true,
    hint: 'Select a declared port or enter a Remote Port manually.',
  });
});

test('formatKubernetesDeclaredPortLabel returns plain display text', async () => {
  const { formatKubernetesDeclaredPortLabel } = await import(modelPath);

  assert.equal(formatKubernetesDeclaredPortLabel({
    remotePort: 3000,
    declarations: [
      { owner: 'aigc-lms-ui', name: 'http', source: 'container' },
      { owner: 'metrics-sidecar', name: 'metrics', source: 'restartable-init' },
    ],
  }), '3000 · http (aigc-lms-ui), metrics (metrics-sidecar)');
  assert.equal(formatKubernetesDeclaredPortLabel({
    remotePort: 443,
    declarations: [
      { owner: 'api & worker', source: 'container' },
      { name: '<external>', source: 'service' },
    ],
  }), '443 · api & worker, <external>');
  assert.equal(formatKubernetesDeclaredPortLabel({ remotePort: 8080, declarations: [] }), '8080');
});

test('buildKubernetesOverviewFields returns only Kind Namespace Status Name and Pod IP in order', async () => {
  const { buildKubernetesOverviewFields } = await import(modelPath);
  const podDetail = {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: 'ai-aigc-lms-ui-56877dd45b-6wv4s',
      namespace: 'ai-dev',
      creationTimestamp: '2026-07-13T00:00:00.000Z',
      resourceVersion: '123456',
    },
    status: {
      phase: 'Running',
      podIP: '10.244.173.30',
    },
  };

  assert.deepEqual(buildKubernetesOverviewFields(podDetail, {
    kind: 'Fallback Kind',
    name: 'fallback-name',
    namespace: 'fallback-namespace',
    status: 'Fallback Status',
  }), [
    { label: 'Kind', value: 'Pod' },
    { label: 'Namespace', value: 'ai-dev' },
    { label: 'Status', value: 'Running' },
    { label: 'Name', value: 'ai-aigc-lms-ui-56877dd45b-6wv4s' },
    { label: 'Pod IP', value: '10.244.173.30' },
  ]);

  assert.deepEqual(buildKubernetesOverviewFields({
    kind: 'Service',
    metadata: { name: 'frontend', namespace: 'ai-dev' },
    status: { phase: 'Ready', podIP: '10.244.99.99' },
  }, {
    kind: 'Fallback Kind',
    name: 'fallback-name',
  }), [
    { label: 'Kind', value: 'Service' },
    { label: 'Namespace', value: 'ai-dev' },
    { label: 'Status', value: 'Ready' },
    { label: 'Name', value: 'frontend' },
  ]);

  assert.deepEqual(buildKubernetesOverviewFields({ metadata: null, status: [] }, {
    kind: 'Deployment',
    name: 'fallback-name',
    namespace: 'fallback-namespace',
    status: 'Fallback Status',
  }), [
    { label: 'Kind', value: 'Deployment' },
    { label: 'Namespace', value: 'fallback-namespace' },
    { label: 'Status', value: 'Fallback Status' },
    { label: 'Name', value: 'fallback-name' },
  ]);
});

test('Kubernetes resource detail uses an overlay drawer header with Port Forward and YAML controls', async () => {
  const html = await readFile(path.join(rendererPath, 'index.html'), 'utf8');
  const detailStart = html.indexOf('id="kubernetes-detail-drawer"');
  const detailEnd = html.indexOf('id="kubernetes-port-forwards"', detailStart);
  const detail = html.slice(detailStart, detailEnd);

  assert.ok(detailStart >= 0);
  assert.ok(detailEnd > detailStart);
  assert.match(detail, /id="kubernetes-detail-drawer-scrim"/);
  assert.match(detail, /id="kubernetes-detail-close"/);
  assert.match(detail, /id="kubernetes-detail-yaml-toggle"/);
  assert.match(detail, /id="kubernetes-detail-port-forward"/);
  assert.match(detail, /id="kubernetes-detail-port-summary"/);
  assert.match(detail, /id="kubernetes-detail-overview"/);
  assert.match(detail, /id="kubernetes-detail-yaml"/);
  assert.doesNotMatch(detail, /id="kubernetes-detail-copy"/);
  assert.doesNotMatch(html, /id="kubernetes-detail-page"/);
  assert.doesNotMatch(html, /id="kubernetes-terminal-drawer"/);
  assert.doesNotMatch(html, /id="kubernetes-log-panel"/);
});

test('Kubernetes reserves a hidden workspace shell for the later Logs and Shell integration', async () => {
  const html = await readFile(path.join(rendererPath, 'index.html'), 'utf8');
  const workspaceStart = html.indexOf('id="kubernetes-workspace"');
  const workspaceEnd = html.indexOf('</section>', workspaceStart);
  const workspace = html.slice(workspaceStart, workspaceEnd);

  assert.ok(workspaceStart >= 0 && workspaceEnd > workspaceStart);
  assert.match(workspace, /class="kubernetes-workspace hidden"/);
  assert.match(workspace, /id="kubernetes-workspace-tabs"/);
  assert.match(workspace, /id="kubernetes-workspace-pane"/);
  assert.doesNotMatch(workspace, /kubernetes-log-|kubernetes-terminal-/);
});

test('Kubernetes terminal workspace selection keeps tab state accessible and hides sessions only for Logs', async () => {
  const { applyKubernetesPodWorkspace } = await import(path.join(rendererPath, 'kubernetesPage.js'));
  const button = () => {
    const classes = new Set();
    const attributes = new Map();
    return {
      classes,
      attributes,
      classList: {
        toggle(name, force) {
          if (force) classes.add(name);
          else classes.delete(name);
        },
      },
      setAttribute(name, value) { attributes.set(name, value); },
    };
  };
  const logsTab = button();
  const terminalTab = button();
  let hideCount = 0;
  const tabs = {
    logsTab,
    terminalTab,
    hideTerminalDrawer: () => { hideCount += 1; },
  };

  applyKubernetesPodWorkspace('terminal', tabs);
  assert.equal(logsTab.classes.has('kubernetes-log-view-tab-active'), false);
  assert.equal(logsTab.attributes.get('aria-selected'), 'false');
  assert.equal(terminalTab.classes.has('kubernetes-log-view-tab-active'), true);
  assert.equal(terminalTab.attributes.get('aria-selected'), 'true');
  assert.equal(hideCount, 0);

  applyKubernetesPodWorkspace('logs', tabs);
  assert.equal(logsTab.classes.has('kubernetes-log-view-tab-active'), true);
  assert.equal(logsTab.attributes.get('aria-selected'), 'true');
  assert.equal(terminalTab.classes.has('kubernetes-log-view-tab-active'), false);
  assert.equal(terminalTab.attributes.get('aria-selected'), 'false');
  assert.equal(hideCount, 1);
});

test('Kubernetes drawer binds local close, scrim, and YAML controls without starting workspace sessions', async () => {
  const page = await readFile(path.join(rendererPath, 'kubernetesPage.js'), 'utf8');
  const bindings = page.slice(
    page.indexOf("this.detailCloseButton.addEventListener('click'"),
    page.indexOf("this.portForwardDeclaredPort.addEventListener('change'"),
  );

  assert.match(bindings, /this\.detailCloseButton\.addEventListener\('click', \(\) => this\.closeDetail\(\)\)/);
  assert.match(bindings, /this\.detailDrawerScrim\.addEventListener\('click', \(\) => this\.closeDetail\(\)\)/);
  assert.match(bindings, /this\.detailYamlToggle\.addEventListener\('click', \(\) => this\.toggleDrawerYaml\(\)\)/);
  assert.doesNotMatch(page, /createKubernetesTerminalDrawer/);
  assert.doesNotMatch(page, /openLogsForSelectedContainer/);
});

test('drawer container actions target the persistent workspace while drawer close leaves tabs alone', async () => {
  const page = await readFile(path.join(rendererPath, 'kubernetesPage.js'), 'utf8');
  const drawer = page.slice(
    page.indexOf('    renderPodDrawer(detail, active) {'),
    page.indexOf('    createDrawerSection(', page.indexOf('    renderPodDrawer(detail, active) {')),
  );
  const closeDetail = page.slice(
    page.indexOf('    closeDetail() {'),
    page.indexOf('    displayDetail() {'),
  );

  assert.match(drawer, /this\.workspace\.openLogs\(container\.target\)/);
  assert.match(drawer, /this\.workspace\.openShell\(container\.target\)/);
  assert.match(drawer, /aria-label.*View logs for/);
  assert.match(drawer, /aria-label.*Open shell for/);
  assert.doesNotMatch(closeDetail, /workspace\.dispose|closeLogs|closeTerminal/);
});

test('Kubernetes page owns one workspace and awaits it before hide, Context change, disconnect, and deactivation', async () => {
  const page = await readFile(path.join(rendererPath, 'kubernetesPage.js'), 'utf8');
  const show = page.slice(page.indexOf('    show() {'), page.indexOf('    hide() {'));
  const hide = page.slice(page.indexOf('    hide() {'), page.indexOf('    destroy() {'));
  const workspace = page.slice(page.indexOf('    ensureWorkspace() {'), page.indexOf('    disposeWorkspace() {'));
  const state = page.slice(page.indexOf('    onStateChanged(state) {'), page.indexOf('    onListChanged(snapshot) {'));

  assert.match(show, /this\.ensureWorkspace\(\)/);
  assert.match(workspace, /createKubernetesWorkspace\(/);
  assert.match(show, /onLogChanged\(\(state\) => this\.workspace\?\.onLogChanged\(state\)\)/);
  assert.match(show, /onTerminalChanged\(\(state\) => this\.workspace\?\.onTerminalChanged\(state\)\)/);
  assert.match(show, /onTerminalOutput\(\(output\) => this\.workspace\?\.onTerminalOutput\(output\)\)/);
  assert.match(hide, /this\.disposeWorkspace\(\)/);
  assert.match(state, /disposeWorkspace/);
  assert.match(page, /deactivatePage\(\)[\s\S]{0,500}disposeWorkspace|disposeWorkspace[\s\S]{0,500}deactivatePage\(\)/);
  assert.doesNotMatch(page, /kubernetes-terminal-drawer/);
});

test('Kubernetes drawer close invalidates only the active detail and preserves runtime resources', async () => {
  const page = await readFile(path.join(rendererPath, 'kubernetesPage.js'), 'utf8');
  const closeDetail = page.slice(
    page.indexOf('    closeDetail() {'),
    page.indexOf('    displayDetail() {'),
  );

  assert.match(closeDetail, /this\.activeDetail = undefined/);
  assert.match(closeDetail, /this\.decodedSecretDetail = undefined/);
  assert.match(closeDetail, /this\.detailDrawer\.classList\.add\('hidden'\)/);
  assert.match(closeDetail, /this\.closePortForwardDialog\(\)/);
  assert.doesNotMatch(closeDetail, /closeLogs|closeTerminal|stopPortForward|deactivatePage/);
  assert.doesNotMatch(closeDetail, /await /);
});

test('Kubernetes Pod drawer renders static containers and safe text-only values', async () => {
  const page = await readFile(path.join(rendererPath, 'kubernetesPage.js'), 'utf8');
  const drawer = page.slice(
    page.indexOf('    renderPodDrawer(detail, active) {'),
    page.indexOf('    createDrawerSection(', page.indexOf('    renderPodDrawer(detail, active) {')),
  );

  assert.match(page, /buildKubernetesDrawerModel/);
  assert.match(drawer, /this\.createDrawerSection\('Labels'/);
  assert.match(drawer, /this\.createDrawerSection\('Containers'/);
  for (const label of ['Status', 'Image', 'Pull policy', 'Mounts', 'Command', 'Environment']) {
    assert.match(drawer, new RegExp(`\\['${label}'`));
  }
  assert.match(drawer, /container\.environmentDeclared \? 'Declared' : 'Not declared'/);
  assert.match(drawer, /\.textContent = /);
  assert.doesNotMatch(drawer, /innerHTML|getPodContainerEnvironment/);
  assert.match(drawer, /logs\.setAttribute\('aria-label', `View logs for \$\{container\.name\}`\)/);
  assert.match(drawer, /shell\.setAttribute\('aria-label', `Open shell for \$\{container\.name\}`\)/);
  assert.match(drawer, /this\.workspace\.openLogs\(container\.target\)/);
  assert.match(drawer, /this\.workspace\.openShell\(container\.target\)/);
});

test('Kubernetes Port Forward dialog declares a hidden safe candidate selector before manual ports', async () => {
  const html = await readFile(path.join(rendererPath, 'index.html'), 'utf8');
  const dialogStart = html.indexOf('id="kubernetes-port-forward-dialog"');
  const dialogEnd = html.indexOf('</dialog>', dialogStart);
  const dialog = html.slice(dialogStart, dialogEnd);

  assert.ok(dialogStart >= 0);
  assert.match(dialog, /id="kubernetes-port-forward-declared-field"[^>]*class="[^"]*hidden/);
  assert.match(dialog, /<select id="kubernetes-port-forward-declared-port"/);
  assert.match(dialog, /id="kubernetes-port-forward-hint"/);
  assert.ok(dialog.indexOf('id="kubernetes-port-forward-declared-port"')
    < dialog.indexOf('id="kubernetes-port-forward-remote-port"'));
  assert.ok(dialog.indexOf('id="kubernetes-port-forward-hint"')
    < dialog.indexOf('id="kubernetes-port-forward-remote-port"'));
});

test('Kubernetes detail controller safely integrates Overview and declared Port Forward models', async () => {
  const page = await readFile(path.join(rendererPath, 'kubernetesPage.js'), 'utf8');
  const overviewStart = page.indexOf('    renderOverview(detail, active) {');
  const overviewEnd = page.indexOf('    toggleDrawerYaml() {', overviewStart);
  const overview = page.slice(overviewStart, overviewEnd);
  const dialogStart = page.indexOf('    openPortForwardDialog() {');
  const dialogEnd = page.indexOf('    closePortForwardDialog() {', dialogStart);
  const dialog = page.slice(dialogStart, dialogEnd);
  const detailRuntimeStart = page.indexOf('    renderDrawerPortForward(detail, active) {');
  const detailRuntimeEnd = page.indexOf('    renderPodDrawer(detail, active) {', detailRuntimeStart);
  const detailRuntime = page.slice(detailRuntimeStart, detailRuntimeEnd);

  assert.match(page, /buildKubernetesOverviewFields/);
  assert.match(page, /buildKubernetesPortForwardDialogModel/);
  assert.match(page, /detectKubernetesForwardPorts/);
  assert.match(page, /formatKubernetesDeclaredPortLabel/);
  assert.match(overview, /buildKubernetesOverviewFields\(detail,/);
  assert.match(overview, /term\.textContent = field\.label/);
  assert.match(overview, /description\.textContent = field\.value/);
  assert.match(overview, /description\.title = field\.value/);

  assert.match(detailRuntime, /active\.query\.kind === 'pods' \? 'pod'/);
  assert.match(detailRuntime, /active\.query\.kind === 'services' \? 'service'/);
  assert.match(detailRuntime, /detectKubernetesForwardPorts\(detail, targetKind\)/);
  assert.match(detailRuntime, /detailPortForwardButton\.classList\.toggle\('hidden', !targetKind\)/);
  assert.doesNotMatch(detailRuntime, /detailPortForwardButton\.disabled[\s\S]{0,120}selectedContainer/);
  assert.match(detailRuntime, /No declared TCP ports/);
  assert.match(detailRuntime, /1 declared ·/);

  assert.match(dialog, /this\.portForwards\.size >= 10/);
  assert.match(dialog, /buildKubernetesPortForwardDialogModel\(declaredPorts\)/);
  assert.match(dialog, /document\.createElement\('option'\)/);
  assert.match(dialog, /option\.textContent = formatKubernetesDeclaredPortLabel\(port\)/);
  assert.match(dialog, /portForwardHint\.textContent/);
  assert.doesNotMatch(dialog, /innerHTML/);
  assert.match(page, /portForwardDeclaredPort\.addEventListener\('change'/);
  assert.match(page, /portForwardRemotePort\.addEventListener\('input'[\s\S]*?portForwardDeclaredPort\.value = ''/);
});

test('Kubernetes detail loading synchronously fences stale actions for direct and related Pod navigation', async () => {
  const page = await readFile(path.join(rendererPath, 'kubernetesPage.js'), 'utf8');
  const resetStart = page.indexOf('    beginDrawerReplacement() {');
  const resetEnd = page.indexOf('    createDrawerRequest(', resetStart);
  const openDetailStart = page.indexOf('    async openDetail(summary) {');
  const openDetailEnd = page.indexOf('    closeDetail() {', openDetailStart);
  const openDetail = page.slice(openDetailStart, openDetailEnd);
  const relatedStart = page.indexOf('    async openRelatedPod(active, summary) {');
  const relatedEnd = page.indexOf('    openPortForwardDialog() {', relatedStart);
  const openRelatedPod = page.slice(relatedStart, relatedEnd);
  const reset = page.slice(resetStart, resetEnd);
  const dialogStart = page.indexOf('    openPortForwardDialog() {');
  const closeDialogStart = page.indexOf('    closePortForwardDialog() {');
  const closeDialogEnd = page.indexOf('    async submitPortForward() {', closeDialogStart);
  const dialog = page.slice(dialogStart, closeDialogStart);
  const closeDialog = page.slice(closeDialogStart, closeDialogEnd);
  const detailRequestStart = openDetail.indexOf('await window.kubernetesApi.getResourceDetail');
  const relatedRequestStart = openRelatedPod.indexOf('await runKubernetesDrawerDetailRequest');
  const relatedFetchStart = openRelatedPod.indexOf('window.kubernetesApi.getResourceDetail');
  const detailResetStart = openDetail.indexOf('this.beginDrawerReplacement()');
  const relatedResetStart = openRelatedPod.indexOf('this.beginDrawerReplacement()');

  assert.ok(resetStart >= 0);
  assert.ok(resetEnd > resetStart);
  assert.ok(openDetailStart >= 0);
  assert.ok(openDetailEnd > openDetailStart);
  assert.ok(relatedStart >= 0);
  assert.ok(relatedEnd > relatedStart);
  assert.ok(dialogStart >= 0);
  assert.ok(closeDialogStart > dialogStart);
  assert.ok(closeDialogEnd > closeDialogStart);
  assert.ok(detailRequestStart >= 0);
  assert.ok(relatedRequestStart >= 0);
  assert.ok(relatedFetchStart > relatedRequestStart);
  assert.ok(detailResetStart >= 0);
  assert.ok(relatedResetStart >= 0);
  assert.match(reset, /const generation = \+\+this\.detailGeneration/);
  assert.match(reset, /this\.invalidateRelatedDetail\(\)/);
  assert.match(reset, /this\.activeDetail = undefined/);
  assert.match(reset, /this\.detailPortForwardButton\.classList\.add\('hidden'\)/);
  assert.match(reset, /this\.detailPortForwardButton\.disabled = true/);
  assert.match(reset, /this\.detailPortSummary\.textContent = ''/);
  assert.match(reset, /this\.closePortForwardDialog\(\)/);
  assert.match(closeDialog, /this\.portForwardDraft = undefined/);
  assert.match(reset, /this\.detailOverview\.replaceChildren\(\)/);
  assert.match(reset, /this\.detailYaml\.textContent = ''/);
  assert.match(reset, /this\.detailDrawer\.classList\.remove\('hidden'\)/);
  assert.match(dialog, /if \(this\.detailPortForwardButton\.disabled\)\s*return/);
  assert.ok(detailResetStart < detailRequestStart);
  assert.ok(relatedResetStart < relatedRequestStart);
});

test('Kubernetes related-Pod drawer navigation guards stale results and leaves the resource list active', async () => {
  const page = await readFile(path.join(rendererPath, 'kubernetesPage.js'), 'utf8');
  const openDetailStart = page.indexOf('    async openDetail(summary) {');
  const openDetailEnd = page.indexOf('    closeDetail() {', openDetailStart);
  const renderDetailStart = page.indexOf('    renderDetail() {');
  const renderDetailEnd = page.indexOf('    renderOverview(detail, active) {', renderDetailStart);
  const relatedStart = page.indexOf('    async openRelatedPod(active, summary) {');
  const relatedEnd = page.indexOf('    openPortForwardDialog() {', relatedStart);
  const openDetail = page.slice(openDetailStart, openDetailEnd);
  const renderDetail = page.slice(renderDetailStart, renderDetailEnd);
  const related = page.slice(relatedStart, relatedEnd);

  for (const index of [openDetailStart, openDetailEnd, renderDetailStart, renderDetailEnd, relatedStart, relatedEnd]) {
    assert.ok(index >= 0);
  }
  assert.match(openDetail, /this\.createDrawerRequest\(summary, detailGeneration\)/);
  assert.match(openDetail, /if \(!this\.isCurrentDrawerRequest\(request, query\)\)\s*return/);
  assert.match(related, /const originQuery = active\.originQuery/);
  assert.match(related, /this\.createDrawerRequest\(summary, generation\)/);
  assert.match(related, /runKubernetesDrawerDetailRequest\(/);
  assert.match(related, /isCurrent:\s*\(\)\s*=> this\.isCurrentDrawerRequest\(request, originQuery\)/);
  assert.match(related, /const next = \{ originQuery, query, summary, detail, request \}/);
  assert.match(related, /this\.renderDetail\(\)[\s\S]*?this\.requestDrawerEvents\(next\)/);
  assert.match(renderDetail, /this\.renderDrawerPortForward\(detail, active\)/);
  assert.doesNotMatch(openDetail, /listPage\.classList\.add\('hidden'\)/);
  assert.doesNotMatch(related, /listPage\.classList\.add\('hidden'\)/);
});

test('Kubernetes drawer replacement synchronously clears stale Service actions before related Pod loading', async () => {
  const page = await readFile(path.join(rendererPath, 'kubernetesPage.js'), 'utf8');
  const replacementStart = page.indexOf('    beginDrawerReplacement() {');
  const replacementEnd = page.indexOf('    async openDetail(summary) {', replacementStart);
  const openDetailStart = page.indexOf('    async openDetail(summary) {');
  const openDetailEnd = page.indexOf('    closeDetail() {', openDetailStart);
  const relatedStart = page.indexOf('    async openRelatedPod(active, summary) {');
  const relatedEnd = page.indexOf('    openPortForwardDialog() {', relatedStart);
  const replacement = page.slice(replacementStart, replacementEnd);
  const openDetail = page.slice(openDetailStart, openDetailEnd);
  const related = page.slice(relatedStart, relatedEnd);

  assert.ok(replacementStart >= 0 && replacementEnd > replacementStart);
  assert.ok(openDetailStart >= 0 && openDetailEnd > openDetailStart);
  assert.ok(relatedStart >= 0 && relatedEnd > relatedStart);
  assert.match(replacement, /const generation = \+\+this\.detailGeneration/);
  assert.match(replacement, /this\.invalidateRelatedDetail\(\)/);
  assert.match(replacement, /this\.activeDetail = undefined/);
  assert.match(replacement, /this\.detailPortForwardButton\.disabled = true/);
  assert.match(replacement, /this\.detailPortForwardButton\.classList\.add\('hidden'\)/);
  assert.match(replacement, /this\.detailPortSummary\.textContent = ''/);
  assert.match(replacement, /this\.detailOverview\.replaceChildren\(\)/);
  assert.match(replacement, /this\.detailYaml\.textContent = ''/);
  assert.match(replacement, /this\.detailDrawer\.classList\.remove\('hidden'\)/);
  assert.ok(openDetail.indexOf('this.beginDrawerReplacement()')
    < openDetail.indexOf('await window.kubernetesApi.getResourceDetail'));
  assert.ok(related.indexOf('this.beginDrawerReplacement()')
    < related.indexOf('await runKubernetesDrawerDetailRequest'));
  assert.ok(related.indexOf('await runKubernetesDrawerDetailRequest')
    < related.indexOf('window.kubernetesApi.getResourceDetail'));
});
