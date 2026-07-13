const test = require('node:test');
const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');

const rendererPath = path.join(__dirname, '..', 'dist', 'renderer');
const modelPath = path.join(rendererPath, 'kubernetesDetailModel.js');

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

test('Kubernetes detail markup replaces Copy and separate action rows with one header Port Forward', async () => {
  const html = await readFile(path.join(rendererPath, 'index.html'), 'utf8');
  const detailStart = html.indexOf('id="kubernetes-detail-page"');
  const detailEnd = html.indexOf('id="kubernetes-terminal-drawer"', detailStart);
  const detail = html.slice(detailStart, detailEnd);

  assert.ok(detailStart >= 0);
  assert.ok(detailEnd > detailStart);
  assert.match(detail, /id="kubernetes-detail-port-forward"/);
  assert.match(detail, /id="kubernetes-detail-port-summary"/);
  assert.match(detail, /id="kubernetes-detail-port-forward"[\s\S]*?<svg[\s\S]*?>Port Forward</);
  assert.doesNotMatch(detail, /id="kubernetes-detail-copy"/);
  assert.doesNotMatch(detail, /id="kubernetes-terminal-open"/);
  assert.doesNotMatch(detail, /id="kubernetes-detail-pod-actions"/);
  assert.doesNotMatch(detail, /id="kubernetes-detail-service-actions"/);
});

test('Kubernetes Pod interactions use one ordered log toolbar with static Follow icons', async () => {
  const html = await readFile(path.join(rendererPath, 'index.html'), 'utf8');
  const panelStart = html.indexOf('id="kubernetes-log-panel"');
  const panelEnd = html.indexOf('</section>', panelStart);
  const panel = html.slice(panelStart, panelEnd);
  const toolbarStart = panel.indexOf('<header class="kubernetes-log-toolbar">');
  const toolbarEnd = panel.indexOf('</header>', toolbarStart);
  const toolbar = panel.slice(toolbarStart, toolbarEnd);

  assert.ok(panelStart >= 0);
  assert.ok(panelEnd > panelStart);
  assert.ok(toolbarStart >= 0);
  assert.ok(toolbarEnd > toolbarStart);
  assert.equal(panel.match(/class="kubernetes-log-toolbar"/g)?.length, 1);
  assert.doesNotMatch(panel, /kubernetes-log-view-tabs|kubernetes-log-head/);

  const orderedControls = [
    '<span>Logs</span>',
    'id="kubernetes-log-terminal-tab"',
    'id="kubernetes-log-search"',
    'id="kubernetes-log-follow"',
    'id="kubernetes-log-clear"',
    'id="kubernetes-container-select"',
  ];
  let previous = -1;
  for (const control of orderedControls) {
    const index = toolbar.indexOf(control);
    assert.ok(index > previous, `${control} should follow the previous toolbar control`);
    previous = index;
  }

  const followStart = toolbar.indexOf('id="kubernetes-log-follow"');
  const followEnd = toolbar.indexOf('</button>', followStart);
  const follow = toolbar.slice(followStart, followEnd);
  assert.match(follow, /aria-label="Pause log follow"/);
  assert.match(follow, /title="Pause log follow"/);
  assert.match(follow, /id="kubernetes-log-follow-pause-icon"/);
  assert.match(follow, /id="kubernetes-log-follow-play-icon"[^>]*class="hidden"/);
  assert.doesNotMatch(follow, /Pause Follow|Resume Follow/);
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

test('Kubernetes terminal tab click selects Terminal before opening and Logs hides without closing sessions', async () => {
  const page = await readFile(path.join(rendererPath, 'kubernetesPage.js'), 'utf8');
  const bindings = page.slice(
    page.indexOf("this.containerSelect.addEventListener('change'"),
    page.indexOf("this.portForwardDeclaredPort.addEventListener('change'"),
  );
  const openStart = page.indexOf('    async openTerminal() {');
  const openEnd = page.indexOf('    onTerminalChanged(state) {', openStart);
  const openTerminal = page.slice(openStart, openEnd);

  assert.match(bindings, /this\.logTab\.addEventListener\('click',[\s\S]*?this\.selectPodWorkspace\('logs'\)/);
  assert.match(bindings, /this\.logTerminalTab\.addEventListener\('click',[\s\S]*?this\.openTerminal\(\)/);
  assert.ok(openTerminal.indexOf("this.selectPodWorkspace('terminal')")
    < openTerminal.indexOf('openKubernetesTerminalWorkspace'));
  assert.doesNotMatch(bindings, /closeTerminal/);
});

test('Kubernetes terminal workspace resets to Logs and invalidates pending ownership on target transitions', async () => {
  const page = await readFile(path.join(rendererPath, 'kubernetesPage.js'), 'utf8');
  const containerChange = page.slice(
    page.indexOf("this.containerSelect.addEventListener('change'"),
    page.indexOf("this.logFollowButton.addEventListener('click'"),
  );
  const openDetail = page.slice(
    page.indexOf('    async openDetail(summary) {'),
    page.indexOf('    async closeDetail() {'),
  );
  const closeDetail = page.slice(
    page.indexOf('    async closeDetail() {'),
    page.indexOf('    displayDetail() {'),
  );
  const openRelatedPod = page.slice(
    page.indexOf('    async openRelatedPod(active, summary) {'),
    page.indexOf('    activeLog() {'),
  );

  for (const transition of [containerChange, openDetail, openRelatedPod]) {
    assert.match(transition, /this\.openingTerminals\.clear\(\)[\s\S]*?this\.selectPodWorkspace\('logs'\)/);
  }
  assert.match(closeDetail, /this\.openingTerminals\.clear\(\)[\s\S]*?await this\.closeDetailLogs\(\)/);
});

test('Kubernetes terminal page binds final-state authority to an exact session ID', async () => {
  const page = await readFile(path.join(rendererPath, 'kubernetesPage.js'), 'utf8');
  const workspaceStart = page.indexOf('    selectPodWorkspace(workspace) {');
  const workspaceEnd = page.indexOf('    cancelLogAutoScroll() {', workspaceStart);
  const workspace = page.slice(workspaceStart, workspaceEnd);
  const openStart = page.indexOf('    async openTerminal() {');
  const openEnd = page.indexOf('    onTerminalChanged(state) {', openStart);
  const openTerminal = page.slice(openStart, openEnd);
  const finalStart = page.indexOf('    onTerminalChanged(state) {');
  const finalEnd = page.indexOf('    onTerminalOutput(output) {', finalStart);
  const finalHandler = page.slice(finalStart, finalEnd);

  assert.match(page, /terminalWorkspaceSessionId/);
  assert.match(workspace, /workspace === 'logs'[\s\S]*?this\.terminalWorkspaceSessionId = undefined/);
  assert.match(openTerminal, /claimSession: \(id\) => \{\s*this\.terminalWorkspaceSessionId = id/);
  assert.match(finalHandler, /workspaceSessionId: this\.terminalWorkspaceSessionId/);
  assert.match(finalHandler, /claimSession: \(id\) => \{\s*this\.terminalWorkspaceSessionId = id/);
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
  const overviewEnd = page.indexOf('    async selectDetailTab(tab) {', overviewStart);
  const overview = page.slice(overviewStart, overviewEnd);
  const dialogStart = page.indexOf('    openPortForwardDialog() {');
  const dialogEnd = page.indexOf('    closePortForwardDialog() {', dialogStart);
  const dialog = page.slice(dialogStart, dialogEnd);
  const detailRuntimeStart = page.indexOf('    renderPodActions(detail, active) {');
  const detailRuntimeEnd = page.indexOf('    appendContainerOption(value, label, init) {', detailRuntimeStart);
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

test('Kubernetes detail loading immediately clears stale Port Forward header state', async () => {
  const page = await readFile(path.join(rendererPath, 'kubernetesPage.js'), 'utf8');
  const openDetailStart = page.indexOf('    async openDetail(summary) {');
  const openDetailEnd = page.indexOf('    async closeDetail() {', openDetailStart);
  const openDetail = page.slice(openDetailStart, openDetailEnd);
  const requestStart = openDetail.indexOf('await window.kubernetesApi.getResourceDetail');
  const beforeRequest = openDetail.slice(0, requestStart);

  assert.ok(openDetailStart >= 0);
  assert.ok(openDetailEnd > openDetailStart);
  assert.ok(requestStart >= 0);
  assert.match(beforeRequest, /this\.detailPortForwardButton\.classList\.add\('hidden'\)/);
  assert.match(beforeRequest, /this\.detailPortForwardButton\.disabled = true/);
  assert.match(beforeRequest, /this\.detailPortSummary\.textContent = ''/);
});
