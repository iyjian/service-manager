const test = require('node:test');
const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');

const rendererPath = path.join(__dirname, '..', 'dist', 'renderer');
const modelPath = path.join(rendererPath, 'kubernetesDetailModel.js');
const customResourceModelPath = path.join(rendererPath, 'kubernetesCustomResourceModel.js');

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
  });
  assert.deepEqual(buildKubernetesPortForwardDialogModel([declared]), {
    remotePort: '3000',
    selectorVisible: false,
  });
  assert.deepEqual(buildKubernetesPortForwardDialogModel([declared, another]), {
    remotePort: '',
    selectorVisible: true,
  });
});

test('hasActiveKubernetesPortForward matches only a live forward for the exact drawer target', async () => {
  const { hasActiveKubernetesPortForward } = await import(modelPath);
  const target = { targetKind: 'pod', namespace: 'ai-dev', targetName: 'api-abc' };
  const forward = (overrides = {}) => ({
    id: 'forward-1',
    targetKind: 'pod',
    namespace: 'ai-dev',
    targetName: 'api-abc',
    remotePort: 3000,
    localPort: 53000,
    state: 'running',
    ...overrides,
  });

  assert.equal(hasActiveKubernetesPortForward([forward()], target), true);
  assert.equal(hasActiveKubernetesPortForward([forward({ state: 'starting' })], target), true);
  assert.equal(hasActiveKubernetesPortForward([forward({ state: 'error' })], target), false);
  assert.equal(hasActiveKubernetesPortForward([forward({ state: 'stopped' })], target), false);
  assert.equal(hasActiveKubernetesPortForward([forward({ targetKind: 'service' })], target), false);
  assert.equal(hasActiveKubernetesPortForward([forward({ namespace: 'other' })], target), false);
  assert.equal(hasActiveKubernetesPortForward([forward({ targetName: 'api-def' })], target), false);
  assert.equal(hasActiveKubernetesPortForward([
    forward({ id: 'stopped', state: 'stopped' }),
    forward({ id: 'other', namespace: 'other' }),
  ], target), false);
  assert.equal(hasActiveKubernetesPortForward([
    forward({ id: 'other', namespace: 'other' }),
    forward({ id: 'matching' }),
  ], target), true);
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

test('Custom Resource detail model mirrors Lens Properties and condition fallback from CRD printer columns', async () => {
  const { buildKubernetesCustomResourceDetailModel } = await import(customResourceModelPath);
  const definition = {
    group: 'argoproj.io', version: 'v1alpha1', kind: 'Application', plural: 'applications', scope: 'namespaced',
    printerColumns: [
      { name: 'Sync Status', type: 'string', jsonPath: '.status.sync.status', priority: 0 },
      { name: 'Health Status', type: 'string', jsonPath: '.status.health.status', priority: 0 },
      { name: 'Revision', type: 'string', jsonPath: '.status.sync.revision', priority: 1 },
      { name: 'Project', type: 'string', jsonPath: '.spec.project', priority: 1 },
    ],
  };
  const model = buildKubernetesCustomResourceDetailModel({
    apiVersion: 'argoproj.io/v1alpha1',
    kind: 'Application',
    metadata: {
      name: 'ai-dev', namespace: 'argocd', creationTimestamp: '2026-07-16T01:00:00Z',
      labels: { team: 'platform', app: 'ai' }, annotations: { owner: 'ops' },
    },
    spec: { project: 'default' },
    status: {
      sync: { status: 'Synced', revision: 'main@sha1:abc' },
      health: { status: 'Healthy' },
      conditions: [{ type: 'Reconciled', status: 'True', reason: 'Success', message: '<safe-text>' }],
    },
  }, definition);

  assert.deepEqual(model.properties.map(({ name, value }) => [name, value]), [
    ['Created', '2026-07-16T01:00:00Z'], ['Name', 'ai-dev'], ['Namespace', 'argocd'],
    ['Sync Status', 'Synced'], ['Health Status', 'Healthy'], ['Revision', 'main@sha1:abc'], ['Project', 'default'],
  ]);
  assert.deepEqual(model.labels, [['app', 'ai'], ['team', 'platform']]);
  assert.deepEqual(model.annotations, [['owner', 'ops']]);
  assert.deepEqual(model.conditions, [{
    type: 'Reconciled', status: 'True', reason: 'Success', message: '<safe-text>',
  }]);

  const statusDefinition = {
    ...definition,
    printerColumns: [{ name: 'Status', type: 'string', jsonPath: '.status.phase', priority: 0 }],
  };
  assert.deepEqual(buildKubernetesCustomResourceDetailModel({
    metadata: { name: 'one' }, status: { phase: 'Ready', conditions: [{ type: 'Ready', status: 'True' }] },
  }, statusDefinition).conditions, []);

  const boundedMetadata = buildKubernetesCustomResourceDetailModel({
    metadata: {
      name: 'bounded',
      annotations: Object.fromEntries(Array.from({ length: 140 }, (_, index) => [
        `annotation-${String(index).padStart(3, '0')}`,
        index === 0 ? 'x'.repeat(10_000) : 'value',
      ])),
    },
  }, { ...definition, printerColumns: [] });
  assert.ok(boundedMetadata.annotations[0][1].length <= 4_096);
  assert.deepEqual(boundedMetadata.annotations.at(-1), ['…', '12 more entries not shown']);
});

test('Kubernetes resource detail uses an overlay drawer header with Port Forward and YAML controls', async () => {
  const html = await readFile(path.join(rendererPath, 'index.html'), 'utf8');
  const detailStart = html.indexOf('id="kubernetes-detail-drawer"');
  const detailEnd = html.indexOf('</aside>', detailStart);
  const detail = html.slice(detailStart, detailEnd);

  assert.ok(detailStart >= 0);
  assert.ok(detailEnd > detailStart);
  assert.match(detail, /id="kubernetes-detail-drawer-scrim"/);
  assert.match(detail, /id="kubernetes-detail-close"/);
  assert.match(detail, /id="kubernetes-detail-yaml-toggle"/);
  assert.match(detail, /id="kubernetes-detail-vnc"[^>]*class="[^"]*hidden[^"]*"[^>]*disabled/);
  assert.match(detail, /id="kubernetes-detail-vnc-label">VNC</);
  assert.match(detail, /id="kubernetes-detail-port-forward"[^>]*aria-label="Port Forward"[^>]*>Port Forward<\/button>/);
  assert.doesNotMatch(detail, /kubernetes-detail-port-summary|declared TCP ports/);
  assert.match(detail, /id="kubernetes-detail-overview"/);
  assert.match(detail, /id="kubernetes-detail-yaml"/);
  assert.match(detail, /id="kubernetes-detail-yaml-copy"/);
  assert.match(detail, /id="kubernetes-detail-yaml-find"/);
  assert.doesNotMatch(html, /id="kubernetes-detail-page"/);
  assert.doesNotMatch(html, /id="kubernetes-terminal-drawer"/);
  assert.doesNotMatch(html, /id="kubernetes-log-panel"/);
});

test('Kubernetes built-in drawers dispatch to resource-specific text-safe sections with lazy collapsed content', async () => {
  const page = await readFile(path.join(rendererPath, 'kubernetesPage.js'), 'utf8');
  const renderDetailStart = page.indexOf('    renderDetail() {');
  const renderDetailEnd = page.indexOf('    renderOverview(detail, active) {', renderDetailStart);
  const builtInStart = page.indexOf('    renderBuiltinResourceDrawer(detail, active) {');
  const builtInEnd = page.indexOf('    renderCustomResourceDrawer(', builtInStart);
  const persistentStart = page.indexOf('    createPersistentDrawerSection(', builtInStart);
  const persistentEnd = page.indexOf('    renderCustomResourceDrawer(', persistentStart);
  const renderDetail = page.slice(renderDetailStart, renderDetailEnd);
  const builtIn = page.slice(builtInStart, builtInEnd);
  const persistent = page.slice(persistentStart, persistentEnd);

  assert.ok(renderDetailStart >= 0 && renderDetailEnd > renderDetailStart);
  assert.ok(builtInStart >= 0 && builtInEnd > builtInStart);
  assert.ok(persistentStart >= 0 && persistentEnd > persistentStart);
  assert.match(renderDetail, /isKubernetesBuiltinDetailKind\(active\.query\.kind\)/);
  assert.match(renderDetail, /this\.renderBuiltinResourceDrawer\(detail, active\)/);
  assert.match(builtIn, /buildKubernetesBuiltinDetailModel\(active\.query\.kind, detail, active\.summary\)/);
  assert.match(builtIn, /description\.textContent = field\.value/);
  assert.match(builtIn, /cell\.textContent = value/);
  assert.match(builtIn, /text\.textContent = value/);
  assert.doesNotMatch(builtIn, /innerHTML/);
  assert.match(persistent, /let rendered = false/);
  assert.match(persistent, /const ensureContent = \(\) => \{[\s\S]*?renderContent\(content\)[\s\S]*?const update = \(\) => \{[\s\S]*?if \(expanded\)\s*ensureContent\(\)/);
});

test('Kubernetes Pod drawer exposes a fenced direct system VNC action only for detected KubeVirt launchers', async () => {
  const page = await readFile(path.join(rendererPath, 'kubernetesPage.js'), 'utf8');
  const renderStart = page.indexOf('    renderDrawerVnc(detail, active) {');
  const openStart = page.indexOf('    async openVnc() {', renderStart);
  const podStart = page.indexOf('    renderPodDrawer(detail, active) {', openStart);
  const render = page.slice(renderStart, openStart);
  const open = page.slice(openStart, podStart);
  const replacementStart = page.indexOf('    beginDrawerReplacement() {');
  const replacementEnd = page.indexOf('    createDrawerRequest(', replacementStart);
  const closeStart = page.indexOf('    closeDetail() {');
  const closeEnd = page.indexOf('    displayDetail() {', closeStart);

  for (const index of [renderStart, openStart, podStart, replacementStart, replacementEnd, closeStart, closeEnd]) {
    assert.ok(index >= 0);
  }
  assert.match(render, /active\.query\.kind === 'pods' \? detectKubeVirtVncTarget\(detail\) : undefined/);
  assert.match(render, /detailVncButton\.classList\.toggle\('hidden', !target\)/);
  assert.match(render, /detailVncButton\.disabled = !target \|\| busy/);
  assert.match(render, /detailVncLabel\.textContent = busy \? 'Opening…' : 'VNC'/);
  assert.doesNotMatch(render, /innerHTML/);
  assert.match(open, /if \(!active \|\| !this\.isCurrentActiveDrawer\(active\) \|\| this\.vncOpening\)\s*return/);
  assert.match(open, /window\.kubernetesApi\.openVnc\(\{[\s\S]*?namespace: target\.namespace,[\s\S]*?podName: target\.podName,[\s\S]*?podUid: target\.podUid/);
  assert.doesNotMatch(open, /vmiName:|url:|vnc:\/\//);
  assert.match(open, /setMessage\('VNC client opened\.', 'success'\)/);
  assert.match(open, /setMessage\(toErrorMessage\(error\), 'error'\)/);
  assert.match(page.slice(replacementStart, replacementEnd), /this\.resetDrawerVncAction\(\)/);
  assert.match(page.slice(closeStart, closeEnd), /this\.resetDrawerVncAction\(\)/);
});

test('Kubernetes reserves a hidden workspace shell for the later Logs and Shell integration', async () => {
  const html = await readFile(path.join(rendererPath, 'index.html'), 'utf8');
  const workspaceStart = html.indexOf('id="kubernetes-workspace"');
  const workspaceEnd = html.indexOf('</section>', workspaceStart);
  const workspace = html.slice(workspaceStart, workspaceEnd);

  assert.ok(workspaceStart >= 0 && workspaceEnd > workspaceStart);
  assert.match(workspace, /class="kubernetes-workspace hidden"/);
  assert.match(workspace, /id="kubernetes-workspace-resize-handle"/);
  assert.match(workspace, /role="separator"/);
  assert.match(workspace, /aria-orientation="horizontal"/);
  assert.match(workspace, /tabindex="0"/);
  assert.match(workspace, /id="kubernetes-workspace-tabs"/);
  assert.match(workspace, /id="kubernetes-workspace-pane"/);
  assert.match(workspace, /id="kubernetes-workspace-pane" class="kubernetes-workspace-pane" role="tabpanel"/);
  assert.doesNotMatch(workspace, /kubernetes-log-|kubernetes-terminal-/);
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
  assert.doesNotMatch(closeDetail, /closeLogs|closeTerminal|stop(?:All)?PortForwards?|deactivatePage/);
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
  assert.match(drawer, /header\.className = 'kubernetes-drawer-header-grid'/);
  assert.match(drawer, /description\.title = value/);
  for (const label of ['Status', 'Image', 'Pull policy', 'Mounts', 'Command']) {
    assert.match(drawer, new RegExp(`\\['${label}'`));
  }
  assert.doesNotMatch(drawer, /\['Environment'|'Not declared'|'Declared'/);
  assert.match(drawer, /info\.className = 'kubernetes-drawer-container-block kubernetes-drawer-container-info'/);
  assert.match(drawer, /infoTitle\.className = 'kubernetes-drawer-container-subtitle kubernetes-drawer-container-info-title'/);
  assert.match(drawer, /infoTitle\.textContent = 'Info'/);
  assert.match(drawer, /info\.append\(infoTitle, facts\)/);
  assert.match(drawer, /shouldRenderKubernetesEnvironment\(container\.environmentDeclared, environmentState\?\.result\)/);
  assert.match(drawer, /card\.appendChild\(this\.renderContainerEnvironment\(container, active\)\)/);
  assert.match(drawer, /\.textContent = /);
  assert.doesNotMatch(drawer, /innerHTML|getPodContainerEnvironment/);
  assert.match(drawer, /content\.classList\.add\('kubernetes-drawer-containers-content'\)/);
  assert.match(drawer, /primary\.className = 'kubernetes-drawer-container-primary'/);
  assert.match(drawer, /actions\.className = 'kubernetes-drawer-container-actions'/);
  assert.match(drawer, /logs\.className = 'icon-btn kubernetes-drawer-container-action-logs'/);
  assert.match(drawer, /shell\.className = 'icon-btn kubernetes-drawer-container-action-shell'/);
  assert.match(drawer, /primary\.append\(name, actions\)/);
  assert.match(drawer, /head\.append\(primary, kind\)/);
  assert.match(drawer, /logs\.setAttribute\('aria-label', `View logs for \$\{container\.name\}`\)/);
  assert.match(drawer, /shell\.setAttribute\('aria-label', `Open shell for \$\{container\.name\}`\)/);
  assert.match(drawer, /this\.workspace\.openLogs\(container\.target\)/);
  assert.match(drawer, /this\.workspace\.openLogs\(container\.target\);\s*this\.closeDetail\(\)/);
  assert.match(drawer, /this\.workspace\.openShell\(container\.target\)/);
});

test('Kubernetes Pod drawer starts Labels collapsed and Containers expanded', async () => {
  const page = await readFile(path.join(rendererPath, 'kubernetesPage.js'), 'utf8');
  const drawerStart = page.indexOf('    renderPodDrawer(detail, active) {');
  const sectionStart = page.indexOf('    createDrawerSection(', drawerStart);
  const sectionEnd = page.indexOf('    requestDrawerEnvironment(', sectionStart);
  const drawer = page.slice(drawerStart, sectionStart);
  const section = page.slice(sectionStart, sectionEnd);

  assert.ok(drawerStart >= 0 && sectionStart > drawerStart && sectionEnd > sectionStart);
  assert.match(drawer, /this\.createDrawerSection\('Labels', false, \(content\) => \{/);
  assert.match(drawer, /this\.createDrawerSection\('Containers', true, \(content\) => \{/);
  assert.match(section, /createDrawerSection\(title, initiallyExpanded, renderContent\)/);
  assert.match(section, /let expanded = initiallyExpanded/);
  assert.match(section, /toggle\.setAttribute\('aria-expanded', String\(expanded\)\)/);
  assert.match(section, /content\.classList\.toggle\('hidden', !expanded\)/);
});

test('Kubernetes Port Forward dialog keeps only port controls and defaults browser opening on', async () => {
  const html = await readFile(path.join(rendererPath, 'index.html'), 'utf8');
  const dialogStart = html.indexOf('id="kubernetes-port-forward-dialog"');
  const dialogEnd = html.indexOf('</dialog>', dialogStart);
  const dialog = html.slice(dialogStart, dialogEnd);

  assert.ok(dialogStart >= 0);
  assert.match(dialog, /id="kubernetes-port-forward-declared-field"[^>]*class="[^"]*hidden/);
  assert.match(dialog, /<select id="kubernetes-port-forward-declared-port"/);
  assert.match(dialog, /id="kubernetes-port-forward-open-browser"[^>]*type="checkbox"[^>]*checked/);
  assert.match(dialog, /Open in default browser/);
  assert.doesNotMatch(dialog, /id="kubernetes-port-forward-target"|id="kubernetes-port-forward-hint"/);
  assert.ok(dialog.indexOf('id="kubernetes-port-forward-declared-port"')
    < dialog.indexOf('id="kubernetes-port-forward-remote-port"'));
  assert.ok(dialog.indexOf('id="kubernetes-port-forward-local-port"')
    < dialog.indexOf('id="kubernetes-port-forward-open-browser"'));
});

test('Kubernetes detail controller safely integrates Overview and declared Port Forward models', async () => {
  const page = await readFile(path.join(rendererPath, 'kubernetesPage.js'), 'utf8');
  const overviewStart = page.indexOf('    renderOverview(detail, active) {');
  const overviewEnd = page.indexOf('    toggleDrawerYaml() {', overviewStart);
  const overview = page.slice(overviewStart, overviewEnd);
  const dialogStart = page.indexOf('    openPortForwardDialog() {');
  const dialogEnd = page.indexOf('    closePortForwardDialog() {', dialogStart);
  const dialog = page.slice(dialogStart, dialogEnd);
  const submitStart = page.indexOf('    async submitPortForward() {', dialogEnd);
  const submitEnd = page.indexOf('    parsePort(', submitStart);
  const submit = page.slice(submitStart, submitEnd);
  const browserStart = page.indexOf('    async openPortForwardEndpoint(', submitEnd);
  const browserEnd = page.indexOf('    renderPortForwards() {', browserStart);
  const browser = page.slice(browserStart, browserEnd);
  const detailRuntimeStart = page.indexOf('    renderDrawerPortForward(active) {');
  const detailRuntimeEnd = page.indexOf('    renderPodDrawer(detail, active) {', detailRuntimeStart);
  const detailRuntime = page.slice(detailRuntimeStart, detailRuntimeEnd);
  const forwardListStart = page.indexOf('    renderPortForwards() {');
  const forwardListEnd = page.indexOf('    renderRow(item) {', forwardListStart);
  const forwardList = page.slice(forwardListStart, forwardListEnd);

  assert.match(page, /buildKubernetesOverviewFields/);
  assert.match(page, /buildKubernetesPortForwardDialogModel/);
  assert.match(page, /detectKubernetesForwardPorts/);
  assert.match(overview, /buildKubernetesOverviewFields\(detail,/);
  assert.match(overview, /term\.textContent = field\.label/);
  assert.match(overview, /description\.textContent = field\.value/);
  assert.match(overview, /description\.title = field\.value/);

  assert.match(detailRuntime, /active\.query\.kind === 'pods' \? 'pod'/);
  assert.match(detailRuntime, /active\.query\.kind === 'services' \? 'service'/);
  assert.match(detailRuntime, /hasActiveKubernetesPortForward\(/);
  assert.match(detailRuntime, /targetKind, namespace, targetName: active\.summary\.name/);
  assert.match(detailRuntime, /detailPortForwardButton\.classList\.toggle\('hidden', !targetKind\)/);
  assert.match(detailRuntime, /detailPortForwardButton\.classList\.toggle\('kubernetes-detail-port-forward-active', activeForward\)/);
  assert.match(detailRuntime, /setAttribute\('aria-label', activeForward \? 'Port Forward \(active\)' : 'Port Forward'\)/);
  assert.doesNotMatch(detailRuntime, /detailPortForwardButton\.disabled[\s\S]{0,120}selectedContainer/);
  assert.doesNotMatch(detailRuntime, /declaredPorts|No declared TCP ports|declared ·/);
  assert.ok(forwardList.indexOf('this.renderDrawerPortForward(active)')
    < forwardList.indexOf('if (forwards.length === 0)'));

  const loadStart = page.indexOf('    async loadPortForwards() {');
  const loadEnd = page.indexOf('    onPortForwardChanged(state) {', loadStart);
  const load = page.slice(loadStart, loadEnd);
  assert.match(load, /const pageGeneration = this\.pageGeneration/);
  assert.match(load, /const revision = this\.portForwardRevision/);
  assert.match(load, /!this\.visible \|\| pageGeneration !== this\.pageGeneration \|\| revision !== this\.portForwardRevision/);
  assert.match(page, /onPortForwardChanged\(state\) \{[\s\S]{0,120}this\.portForwardRevision \+= 1/);

  assert.match(dialog, /this\.portForwards\.size >= 10/);
  assert.match(dialog, /buildKubernetesPortForwardDialogModel\(declaredPorts\)/);
  assert.match(dialog, /document\.createElement\('option'\)/);
  assert.match(dialog, /option\.textContent = String\(port\.remotePort\)/);
  assert.doesNotMatch(dialog, /formatKubernetesDeclaredPortLabel|declarations|http \(/);
  assert.match(dialog, /portForwardOpenBrowser\.checked = true/);
  assert.doesNotMatch(dialog, /portForwardHint|portForwardTarget/);
  assert.doesNotMatch(dialog, /innerHTML/);
  assert.match(page, /portForwardDeclaredPort\.addEventListener\('change'/);
  assert.match(page, /portForwardRemotePort\.addEventListener\('input'[\s\S]*?portForwardDeclaredPort\.value = ''/);
  assert.match(submit, /const openInBrowser = this\.portForwardOpenBrowser\.checked/);
  assert.match(submit, /state = await window\.kubernetesApi\.startPortForward\(input\)/);
  assert.match(submit, /catch \(error\)[\s\S]*?return;[\s\S]*?this\.portForwardLocalPort\.value = String\(state\.localPort\)/);
  assert.match(submit, /if \(openInBrowser\)[\s\S]*?await this\.openPortForwardEndpoint\(state\.localPort, true\)/);
  assert.match(browser, /window\.serviceApi\.openExternal\(`http:\/\/127\.0\.0\.1:\$\{localPort\}`\)/);
  assert.match(browser, /catch \(error\)[\s\S]*?Port forward started, but the browser could not be opened/);
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
  assert.match(reset, /this\.detailPortForwardButton\.classList\.remove\('kubernetes-detail-port-forward-active'\)/);
  assert.match(reset, /this\.detailPortForwardButton\.disabled = true/);
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
  assert.match(related, /this\.renderDetail\(\)/);
  assert.doesNotMatch(openDetail, /requestDrawerEvents/);
  assert.doesNotMatch(related, /requestDrawerEvents/);
  assert.match(renderDetail, /this\.renderDrawerPortForward\(active\)/);
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
  assert.match(replacement, /this\.detailPortForwardButton\.classList\.remove\('kubernetes-detail-port-forward-active'\)/);
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
