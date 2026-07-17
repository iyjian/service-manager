const assert = require('node:assert/strict');
const test = require('node:test');

const summaryModule = '../dist/main/kubernetes/resourceSummary';
const clientModule = '../dist/main/kubernetes/kubernetesClient';
const printerColumnsModule = '../dist/main/kubernetes/customResourcePrinterColumns';

function metadata(name, overrides = {}) {
  return {
    uid: `uid-${name}`,
    name,
    namespace: 'apps',
    resourceVersion: '17',
    creationTimestamp: '2026-07-15T00:00:00.000Z',
    ...overrides,
  };
}

test('KubernetesClient re-exports the shared LIST and Watch summary mapper', () => {
  const direct = require(summaryModule).mapKubernetesResourceSummary;
  const reExported = require(clientModule).mapKubernetesResourceSummary;
  assert.equal(reExported, direct);
});

test('per-kind Kubernetes summaries expose stable operational list columns', () => {
  const { mapKubernetesResourceSummary } = require(summaryModule);
  const cases = [
    {
      kind: 'deployments',
      value: {
        metadata: metadata('api'),
        spec: {
          replicas: 3,
          strategy: { type: 'RollingUpdate' },
        },
        status: { replicas: 3, readyReplicas: 2, updatedReplicas: 3, availableReplicas: 2, unavailableReplicas: 1 },
      },
      status: '2/3',
      columns: {
        ready: '2/3', updated: '3', available: '2', unavailable: '1', strategy: 'RollingUpdate',
      },
    },
    {
      kind: 'statefulsets',
      value: {
        metadata: metadata('database'),
        spec: {
          replicas: 5,
          serviceName: 'database-headless',
          updateStrategy: { type: 'RollingUpdate' },
        },
        status: { replicas: 5, readyReplicas: 4, currentReplicas: 5, updatedReplicas: 4 },
      },
      status: '4/5',
      columns: {
        ready: '4/5', current: '5', updated: '4', service: 'database-headless', strategy: 'RollingUpdate',
      },
    },
    {
      kind: 'services',
      value: {
        metadata: metadata('gateway'),
        spec: {
          type: 'LoadBalancer',
          clusterIPs: ['10.0.0.8', 'fd00::8'],
          externalIPs: ['198.51.100.8'],
          selector: { tier: 'edge', app: 'gateway' },
          ports: [{ name: 'http', port: 80, targetPort: 'web', nodePort: 30080, protocol: 'TCP' }],
        },
        status: { loadBalancer: { ingress: [{ hostname: 'gateway.example.test' }] } },
      },
      status: 'LoadBalancer',
      columns: {
        type: 'LoadBalancer',
        clusterIP: '10.0.0.8, fd00::8',
        externalIP: '198.51.100.8, gateway.example.test',
        ports: 'http:80→web:30080/TCP',
        selector: 'app=gateway, tier=edge',
      },
    },
    {
      kind: 'ingresses',
      value: {
        metadata: metadata('public'),
        spec: {
          ingressClassName: 'nginx',
          rules: [{ host: 'app.example.test' }, {}],
          tls: [{ secretName: 'not-rendered-a' }, { secretName: 'not-rendered-b' }],
        },
        status: { loadBalancer: { ingress: [{ ip: '192.0.2.10' }] } },
      },
      status: 'nginx',
      columns: {
        class: 'nginx', hosts: 'app.example.test, *', address: '192.0.2.10', ports: '80, 443', tls: 'Yes (2)',
      },
    },
    {
      kind: 'configmaps',
      value: {
        metadata: metadata('settings', {
          labels: { app: 'api', managed: 'true' },
          annotations: { checksum: 'abc' },
        }),
        data: { first: 'value-one', second: 'value-two' },
        binaryData: { bundle: 'not-forwarded' },
        immutable: true,
      },
      status: undefined,
      columns: { data: '2', binary: '1', immutable: 'Yes', labels: '2', annotations: '1' },
    },
    {
      kind: 'secrets',
      value: {
        metadata: metadata('credentials', {
          labels: { app: 'api' },
          annotations: { managed: 'true', rotated: 'today' },
        }),
        type: 'Opaque',
        data: {
          'never-leak-secret-key-a': 'never-leak-secret-value-a',
          'never-leak-secret-key-b': 'never-leak-secret-value-b',
        },
        stringData: { 'never-leak-string-key': 'never-leak-string-value' },
        immutable: false,
      },
      status: 'Opaque',
      columns: { type: 'Opaque', data: '2', immutable: 'No', labels: '1', annotations: '2' },
    },
    {
      kind: 'persistentvolumeclaims',
      value: {
        metadata: metadata('database-data'),
        spec: {
          volumeName: 'pvc-123',
          storageClassName: 'fast-ssd',
          accessModes: ['ReadWriteOnce'],
        },
        status: {
          phase: 'Bound',
          capacity: { storage: '20Gi' },
          accessModes: ['ReadWriteOnce', 'ReadOnlyMany'],
        },
      },
      status: 'Bound',
      columns: {
        status: 'Bound', volume: 'pvc-123', capacity: '20Gi', accessModes: 'RWO, ROX', storageClass: 'fast-ssd',
      },
    },
    {
      kind: 'custom-resources',
      value: {
        metadata: metadata('widget', {
          generation: 6,
          labels: { app: 'widgets', tier: 'control' },
        }),
        apiVersion: 'example.test/v1',
        kind: 'Widget',
        status: { phase: 'Reconciling', health: { status: 'Progressing' }, sync: { status: 'OutOfSync' } },
      },
      status: 'Reconciling · Progressing · OutOfSync',
      columns: {
        kind: 'Widget', apiVersion: 'example.test/v1', status: 'Reconciling · Progressing · OutOfSync', generation: '6', labels: '2',
      },
    },
  ];

  for (const fixture of cases) {
    const summary = mapKubernetesResourceSummary(fixture.kind, fixture.value);
    assert.equal(summary.status, fixture.status, fixture.kind);
    assert.deepEqual(summary.columns, fixture.columns, fixture.kind);
    assert.equal(summary.name, fixture.value.metadata.name, fixture.kind);
    assert.equal(summary.namespace, 'apps', fixture.kind);
    assert.equal(summary.createdAt, '2026-07-15T00:00:00.000Z', fixture.kind);
  }
});

test('Secret summaries expose only a data count and never retain key, value, or stringData text', () => {
  const { mapKubernetesResourceSummary } = require(summaryModule);
  const input = {
    metadata: metadata('private', {
      nested: { data: { 'nested-secret-key': 'nested-secret-value' } },
    }),
    type: 'kubernetes.io/tls',
    data: {
      'top-secret-key-one': 'top-secret-value-one',
      'top-secret-key-two': 'top-secret-value-two',
    },
    stringData: { 'plain-secret-key': 'plain-secret-value' },
  };

  const summary = mapKubernetesResourceSummary('secrets', input);
  assert.equal(summary.columns.data, '2');
  assert.deepEqual(Object.keys(summary.columns), ['type', 'data', 'immutable', 'labels', 'annotations']);
  const serialized = JSON.stringify(summary);
  for (const forbidden of [
    'top-secret-key-one', 'top-secret-value-one', 'top-secret-key-two', 'top-secret-value-two',
    'plain-secret-key', 'plain-secret-value', 'nested-secret-key', 'nested-secret-value', 'stringData',
  ]) {
    assert.doesNotMatch(serialized, new RegExp(forbidden));
  }
  assert.equal(input.data['top-secret-key-one'], 'top-secret-value-one');
  assert.equal(input.stringData['plain-secret-key'], 'plain-secret-value');
});

test('per-kind summaries use stable placeholders for absent optional fields', () => {
  const { mapKubernetesResourceSummary } = require(summaryModule);
  const cases = [
    ['deployments', { ready: '—', updated: '0', available: '0', unavailable: '0', strategy: '—' }],
    ['statefulsets', { ready: '—', current: '0', updated: '0', service: '—', strategy: '—' }],
    ['services', { type: 'ClusterIP', clusterIP: '—', externalIP: '—', ports: '—', selector: '—' }],
    ['ingresses', { class: '—', hosts: '—', address: '—', ports: '—', tls: 'No' }],
    ['configmaps', { data: '0', binary: '0', immutable: 'No', labels: '0', annotations: '0' }],
    ['secrets', { type: '—', data: '0', immutable: 'No', labels: '0', annotations: '0' }],
    ['persistentvolumeclaims', { status: '—', volume: '—', capacity: '—', accessModes: '—', storageClass: '—' }],
    ['custom-resources', { kind: '—', apiVersion: '—', status: '—', generation: '—', labels: '0' }],
  ];

  for (const [kind, columns] of cases) {
    assert.deepEqual(mapKubernetesResourceSummary(kind, { metadata: metadata(kind) }).columns, columns, kind);
  }
});

test('Custom Resource summaries evaluate bounded CRD printer columns for LIST and Watch projections', () => {
  const { mapKubernetesResourceSummary } = require(summaryModule);
  const printerColumns = [
    { name: 'Sync Status', type: 'string', jsonPath: '.status.sync.status', priority: 0 },
    { name: 'Ready', type: 'string', jsonPath: '.status.conditions[?(@.type=="Ready")].status', priority: 0 },
    { name: 'Status', type: 'string', jsonPath: '.status.health.status', priority: 1 },
  ];
  const summary = mapKubernetesResourceSummary('custom-resources', {
    metadata: metadata('application', { generation: 4 }),
    apiVersion: 'argoproj.io/v1alpha1',
    kind: 'Application',
    status: {
      sync: { status: 'Synced' },
      health: { status: 'Healthy' },
      conditions: [{ type: 'Ready', status: 'True' }, { type: 'Other', status: 'False' }],
    },
  }, printerColumns);

  assert.equal(summary.columns.printer0, 'Synced');
  assert.equal(summary.columns.printer1, 'True');
  assert.equal(summary.columns.printer2, 'Healthy');
  assert.equal(summary.columns.status, 'Healthy');
  assert.equal(summary.status, 'Healthy');
});

test('Custom Resource printer JSONPath support is non-executable, bounded, and handles common Kubernetes filters', () => {
  const {
    formatKubernetesPrinterColumnValue,
    normalizeKubernetesPrinterColumns,
    readKubernetesPrinterColumnValue,
  } = require(printerColumnsModule);
  const value = {
    metadata: { labels: { 'app.example/name': 'api' } },
    status: {
      conditions: [
        { type: 'Ready', status: 'True' },
        { type: 'Synced', status: 'False' },
      ],
    },
  };

  assert.equal(readKubernetesPrinterColumnValue(value, '.metadata.labels["app.example/name"]'), 'api');
  assert.equal(readKubernetesPrinterColumnValue(value, '.status.conditions[?(@.type=="Ready")].status'), 'True');
  assert.equal(readKubernetesPrinterColumnValue(value, '.status.conditions[*].type'), 'Ready');
  assert.equal(readKubernetesPrinterColumnValue({
    items: [{ values: ['x'], name: 'matched' }, { values: ['y'], name: 'other' }],
  }, '.items[?(@.values[0]=="x")].name'), 'matched');
  for (const unsafe of ['$..status', '.constructor.name', '.status.conditions[?(@.type)]', '{.status}']) {
    assert.equal(readKubernetesPrinterColumnValue(value, unsafe), undefined, unsafe);
  }
  assert.deepEqual(normalizeKubernetesPrinterColumns([
    { name: 'Ready', type: 'string', jsonPath: '.status.conditions[?(@.type=="Ready")].status' },
    { name: 'Age', type: 'date', jsonPath: '.metadata.creationTimestamp' },
    { name: 'Unsafe', type: 'string', jsonPath: '$..status' },
  ]), [
    { name: 'Ready', type: 'string', jsonPath: '.status.conditions[?(@.type=="Ready")].status', priority: 0 },
  ]);
  assert.equal(formatKubernetesPrinterColumnValue('x'.repeat(600)).length, 512);
  assert.equal(formatKubernetesPrinterColumnValue(3.5, { type: 'integer' }), '—');
  assert.equal(formatKubernetesPrinterColumnValue(-3, { type: 'integer' }), '-3');
  assert.equal(formatKubernetesPrinterColumnValue('true', { type: 'boolean' }), '—');
  assert.equal(
    formatKubernetesPrinterColumnValue('2026-07-17T01:02:03Z', { type: 'date' }),
    '2026-07-17T01:02:03.000Z',
  );

  const large = Array.from({ length: 1_000 }, () => ({ type: 'Other', status: 'False' }));
  Object.defineProperty(large, 400, { get() { throw new Error('visited beyond budget'); } });
  assert.doesNotThrow(() => readKubernetesPrinterColumnValue(
    { status: { conditions: large } },
    '.status.conditions[?(@.type=="Ready")].status',
  ));
});

test('Custom Resource list printer projection retains only visible CRD indices', () => {
  const {
    selectKubernetesPrinterColumnsForList,
  } = require(printerColumnsModule);
  const columns = Array.from({ length: 8 }, (_, index) => ({
    name: `Column ${index}`,
    type: 'string',
    jsonPath: `.status.column${index}`,
    priority: index % 2,
  }));
  const selected = selectKubernetesPrinterColumnsForList(columns, 'namespaced');
  assert.equal(selected.length, 5);
  assert.deepEqual(selected.map(({ sourceIndex }) => sourceIndex), [0, 2, 4, 6, 1]);

  const { mapKubernetesResourceSummary } = require(summaryModule);
  const summary = mapKubernetesResourceSummary('custom-resources', {
    metadata: metadata('bounded'),
    status: Object.fromEntries(columns.map((_, index) => [`column${index}`, `value-${index}`])),
  }, selected);
  assert.deepEqual(
    Object.keys(summary.columns).filter((key) => key.startsWith('printer')).sort(),
    ['printer0', 'printer1', 'printer2', 'printer4', 'printer6'],
  );
});

test('default-backend-only Ingress summarizes its catch-all host and HTTP port', () => {
  const { mapKubernetesResourceSummary } = require(summaryModule);
  const summary = mapKubernetesResourceSummary('ingresses', {
    metadata: metadata('fallback'),
    spec: { defaultBackend: { service: { name: 'fallback', port: { number: 8080 } } } },
  });

  assert.equal(summary.columns.hosts, '*');
  assert.equal(summary.columns.ports, '80');
});

test('Pod and Event summaries retain their existing columns and Event message bound', () => {
  const { mapKubernetesResourceSummary } = require(summaryModule);
  const pod = mapKubernetesResourceSummary('pods', {
    metadata: metadata('pod'),
    spec: { nodeName: 'worker-a', containers: [{ resources: { requests: { cpu: '250m', memory: '128Mi' } } }] },
    status: { phase: 'Running', containerStatuses: [{ restartCount: 2 }] },
  });
  assert.deepEqual(pod.columns, { cpu: '250m', memory: '128Mi', restarts: '2', node: 'worker-a', status: 'Running' });

  const message = 'x'.repeat(20_000);
  const event = mapKubernetesResourceSummary('events', {
    metadata: metadata('event'),
    reason: 'BackOff', type: 'Warning', message, count: 4,
    lastTimestamp: '2026-07-15T01:00:00.000Z',
  });
  assert.equal(event.columns.message.length, 16_384);
  assert.equal(event.columns.observedAt, '2026-07-15T01:00:00.000Z');
  assert.equal(event.status, 'BackOff');
});
