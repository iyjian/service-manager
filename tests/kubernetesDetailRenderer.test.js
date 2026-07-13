const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const modelPath = path.join(__dirname, '..', 'dist', 'renderer', 'kubernetesDetailModel.js');

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
