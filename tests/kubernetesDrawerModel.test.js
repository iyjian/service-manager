const assert = require('node:assert/strict');
const test = require('node:test');

test('buildKubernetesDrawerModel exposes compact Pod header and container values without evaluating Env', async () => {
  const { buildKubernetesDrawerModel } = await import('../dist/renderer/kubernetesDrawerModel.js');
  const model = buildKubernetesDrawerModel({
    metadata: { name: 'api', namespace: 'apps', labels: { tier: 'backend', app: 'api' } },
    spec: {
      nodeName: 'worker-a',
      containers: [{
        name: 'api',
        image: 'example/api:v1',
        imagePullPolicy: 'IfNotPresent',
        command: ['node'],
        args: ['server.js'],
        volumeMounts: [{ mountPath: '/work' }],
        env: [{ name: 'PASSWORD', valueFrom: { secretKeyRef: { name: 'db', key: 'password' } } }],
      }],
    },
    status: {
      phase: 'Running',
      podIP: '10.0.0.5',
      podIPs: [{ ip: '10.0.0.5' }],
      containerStatuses: [{
        name: 'api',
        ready: true,
        state: { running: { startedAt: '2026-08-10T03:04:05Z' } },
      }],
    },
  }, { name: 'api', namespace: 'apps', status: 'Running' });

  assert.deepEqual(model.header, [
    ['Name', 'api'],
    ['Namespace', 'apps'],
    ['Status', 'Running'],
    ['Node', 'worker-a'],
    ['Pod IP', '10.0.0.5'],
    ['Pod IPs', '10.0.0.5'],
  ]);
  assert.deepEqual(model.labels, [['app', 'api'], ['tier', 'backend']]);
  assert.deepEqual(model.containers[0].target, {
    namespace: 'apps',
    podName: 'api',
    container: 'api',
    containerStartedAt: '2026-08-10T03:04:05.000Z',
  });
  assert.equal(model.containers[0].status, 'Running');
  assert.equal(model.containers[0].environmentDeclared, true);
  assert.doesNotMatch(JSON.stringify(model), /db|password|PASSWORD/);
});

test('detectKubeVirtVncTarget requires a running launcher with matching VMI identity and controller owner', async () => {
  const { detectKubeVirtVncTarget } = await import('../dist/renderer/kubernetesDrawerModel.js');
  const detail = {
    metadata: {
      name: 'virt-launcher-kb-kmzyssjmw-mpvwz',
      namespace: 'kvm-builder-dev',
      uid: 'pod-uid',
      labels: {
        'kubevirt.io': 'virt-launcher',
        'kubevirt.io/created-by': 'vmi-uid',
        'kubevirt.io/domain': 'kb-kmzyssjmw',
        'vm.kubevirt.io/name': 'kb-kmzyssjmw',
      },
      annotations: { 'kubevirt.io/domain': 'kb-kmzyssjmw' },
      ownerReferences: [{
        apiVersion: 'kubevirt.io/v1',
        kind: 'VirtualMachineInstance',
        name: 'kb-kmzyssjmw',
        uid: 'vmi-uid',
        controller: true,
      }],
    },
    spec: { containers: [{ name: 'compute', image: 'virt-launcher:test' }] },
    status: { phase: 'Running' },
  };

  assert.deepEqual(detectKubeVirtVncTarget(detail), {
    namespace: 'kvm-builder-dev',
    podName: 'virt-launcher-kb-kmzyssjmw-mpvwz',
    podUid: 'pod-uid',
    vmiName: 'kb-kmzyssjmw',
  });
  assert.deepEqual(detectKubeVirtVncTarget({
    ...detail,
    metadata: {
      ...detail.metadata,
      labels: {
        'kubevirt.io': 'virt-launcher',
        'kubevirt.io/created-by': 'vmi-uid',
      },
    },
  }), detectKubeVirtVncTarget(detail), 'the matching domain annotation is sufficient');
  assert.deepEqual(detectKubeVirtVncTarget({
    ...detail,
    metadata: { ...detail.metadata, annotations: {} },
  }), detectKubeVirtVncTarget(detail), 'the matching VMI name label is sufficient');
});

test('detectKubeVirtVncTarget rejects names and incomplete or conflicting KubeVirt metadata', async () => {
  const { detectKubeVirtVncTarget } = await import('../dist/renderer/kubernetesDrawerModel.js');
  const metadata = {
    name: 'virt-launcher-demo-abcde',
    namespace: 'vms',
    uid: 'pod-uid',
    labels: {
      'kubevirt.io': 'virt-launcher',
      'kubevirt.io/created-by': 'vmi-uid',
      'kubevirt.io/domain': 'demo',
      'vm.kubevirt.io/name': 'demo',
    },
    annotations: { 'kubevirt.io/domain': 'demo' },
    ownerReferences: [{
      apiVersion: 'kubevirt.io/v1',
      kind: 'VirtualMachineInstance',
      name: 'demo',
      uid: 'vmi-uid',
      controller: true,
    }],
  };
  const variants = [
    { name: metadata.name, namespace: metadata.namespace, uid: metadata.uid },
    { ...metadata, labels: { ...metadata.labels, 'kubevirt.io': 'other' } },
    { ...metadata, labels: { ...metadata.labels, 'kubevirt.io/created-by': undefined } },
    {
      ...metadata,
      labels: {
        'kubevirt.io': 'virt-launcher',
        'kubevirt.io/created-by': 'vmi-uid',
        'kubevirt.io/domain': 'demo',
      },
      annotations: {},
    },
    { ...metadata, ownerReferences: [] },
    { ...metadata, ownerReferences: [...metadata.ownerReferences, { ...metadata.ownerReferences[0], uid: 'other-vmi-uid' }] },
    { ...metadata, ownerReferences: [{ ...metadata.ownerReferences[0], controller: false }] },
    { ...metadata, ownerReferences: [{ ...metadata.ownerReferences[0], apiVersion: 'example.io/v1' }] },
    { ...metadata, ownerReferences: [{ ...metadata.ownerReferences[0], apiVersion: 'kubevirt.io' }] },
    { ...metadata, ownerReferences: [{ ...metadata.ownerReferences[0], name: 'another-vmi' }] },
    { ...metadata, labels: { ...metadata.labels, 'kubevirt.io/created-by': 'another-vmi-uid' } },
    { ...metadata, labels: { ...metadata.labels, 'vm.kubevirt.io/name': 'another-vmi' } },
    { ...metadata, annotations: { 'kubevirt.io/domain': 'another-vmi' } },
    { ...metadata, deletionTimestamp: '2026-07-17T00:00:00Z' },
    { ...metadata, uid: '' },
  ];

  for (const candidate of variants) {
    assert.equal(detectKubeVirtVncTarget({ metadata: candidate, status: { phase: 'Running' } }), undefined);
  }
  assert.equal(detectKubeVirtVncTarget({ metadata, status: { phase: 'Pending' } }), undefined);
});

test('buildKubernetesDrawerModel keeps normal containers before init containers and uses display defaults', async () => {
  const { buildKubernetesDrawerModel } = await import('../dist/renderer/kubernetesDrawerModel.js');
  const model = buildKubernetesDrawerModel({
    metadata: { name: 'api', namespace: 'apps' },
    spec: {
      containers: [{ name: 'api', image: 'example/api:v1' }],
      initContainers: [{ name: 'setup', image: 'example/setup:v1', command: ['prepare'], args: ['--quiet'] }],
    },
    status: {
      containerStatuses: [{ name: 'api', state: { waiting: { reason: 'ImagePullBackOff' } } }],
      initContainerStatuses: [{ name: 'setup', state: { terminated: { reason: 'Completed' } } }],
    },
  }, { name: 'fallback', namespace: 'fallback', status: 'Unknown' });

  assert.deepEqual(model.containers.map((container) => [container.name, container.init, container.status]), [
    ['api', false, 'Waiting: ImagePullBackOff'],
    ['setup', true, 'Terminated: Completed'],
  ]);
  assert.equal(model.containers[0].imagePullPolicy, 'Default');
  assert.equal(model.containers[0].mounts, '—');
  assert.equal(model.containers[1].command, 'prepare --quiet');
  assert.equal(model.containers[1].environmentDeclared, false);
});

test('filterKubernetesEnvironmentEntries searches only the active entry fields', async () => {
  const { filterKubernetesEnvironmentEntries } = await import('../dist/renderer/kubernetesDrawerModel.js');
  const entries = [
    { name: 'API_URL', source: 'literal', value: 'https://service.internal' },
    { name: 'CONFIG_MODE', source: 'configMapKeyRef', reference: 'configmap/settings/mode', value: 'production' },
    { name: 'TOKEN', source: 'secretKeyRef', reference: 'secret/app-env/token', value: 'rendered-locally' },
  ];

  assert.deepEqual(filterKubernetesEnvironmentEntries(entries, 'api').map((entry) => entry.name), ['API_URL']);
  assert.deepEqual(filterKubernetesEnvironmentEntries(entries, 'configmap').map((entry) => entry.name), ['CONFIG_MODE']);
  assert.deepEqual(filterKubernetesEnvironmentEntries(entries, 'app-env/token').map((entry) => entry.name), ['TOKEN']);
  assert.deepEqual(filterKubernetesEnvironmentEntries(entries, 'rendered-locally').map((entry) => entry.name), ['TOKEN']);
  assert.deepEqual(filterKubernetesEnvironmentEntries(entries, '').map((entry) => entry.name), ['API_URL', 'CONFIG_MODE', 'TOKEN']);
});

test('shouldRenderKubernetesEnvironment hides only absent or successfully resolved empty Env', async () => {
  const { shouldRenderKubernetesEnvironment } = await import('../dist/renderer/kubernetesDrawerModel.js');

  assert.equal(shouldRenderKubernetesEnvironment(false), false);
  assert.equal(shouldRenderKubernetesEnvironment(true), true, 'declared Env remains available before lazy loading');
  assert.equal(shouldRenderKubernetesEnvironment(true, {
    entries: [],
    truncated: false,
    permissionDenied: false,
  }), false, 'a successful empty resolution removes the Env section');
  assert.equal(shouldRenderKubernetesEnvironment(true, {
    entries: [],
    truncated: true,
    permissionDenied: false,
  }), true, 'a truncated response keeps its safety notice visible');
  assert.equal(shouldRenderKubernetesEnvironment(true, {
    entries: [],
    truncated: false,
    permissionDenied: true,
  }), true, 'a permission failure keeps its warning visible');
  assert.equal(shouldRenderKubernetesEnvironment(true, {
    entries: [{ name: 'MODE', source: 'literal', value: 'production' }],
    truncated: false,
    permissionDenied: false,
  }), true);
});
