const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const modelPath = pathToFileURL(path.join(
  __dirname,
  '..',
  'dist',
  'renderer',
  'models',
  'kubernetesBuiltinResourceModel.js',
)).href;

const fallback = {
  name: 'fallback',
  namespace: 'team-a',
  createdAt: '2026-07-18T01:02:03.000Z',
};

function properties(model) {
  return Object.fromEntries(model.properties.map(({ label, value }) => [label, value]));
}

test('built-in Deployment and StatefulSet drawers expose compact rollout state and sections', async () => {
  const { buildKubernetesBuiltinDetailModel } = await import(modelPath);
  const deployment = buildKubernetesBuiltinDetailModel('deployments', {
    metadata: { name: 'api', namespace: 'team-a', labels: { app: 'api' } },
    spec: {
      replicas: 4,
      selector: { matchLabels: { app: 'api' } },
      strategy: { type: 'RollingUpdate' },
      template: { spec: { containers: [{ name: 'api', image: 'example/api:v2' }] } },
    },
    status: {
      readyReplicas: 3,
      updatedReplicas: 4,
      availableReplicas: 3,
      unavailableReplicas: 1,
      conditions: [{ type: 'Available', status: 'False', reason: 'MinimumReplicasUnavailable' }],
    },
  }, fallback);
  assert.deepEqual(properties(deployment), {
    Name: 'api', Namespace: 'team-a', Created: '2026-07-18T01:02:03.000Z',
    Ready: '3 / 4', Updated: '4', Available: '3', Unavailable: '1', Strategy: 'RollingUpdate',
  });
  assert.deepEqual(deployment.labels, [['app', 'api']]);
  assert.deepEqual(deployment.sections.map(({ key }) => key), ['selector', 'images', 'conditions']);
  assert.deepEqual(deployment.sections.find(({ key }) => key === 'images').rows, [
    ['api', 'example/api:v2', 'Container'],
  ]);

  const statefulSet = buildKubernetesBuiltinDetailModel('statefulsets', {
    metadata: { name: 'db', namespace: 'team-a' },
    spec: {
      replicas: 3,
      serviceName: 'db-headless',
      podManagementPolicy: 'Parallel',
      updateStrategy: { type: 'OnDelete' },
    },
    status: { readyReplicas: 2, currentReplicas: 3, updatedReplicas: 1 },
  }, fallback);
  assert.deepEqual(properties(statefulSet), {
    Name: 'db', Namespace: 'team-a', Created: '2026-07-18T01:02:03.000Z',
    Ready: '2 / 3', Current: '3', Updated: '1', Service: 'db-headless',
    Strategy: 'OnDelete', 'Pod management': 'Parallel',
  });
});

test('built-in Service drawer models connection, ports, and selectors without a fake Status', async () => {
  const { buildKubernetesBuiltinDetailModel } = await import(modelPath);
  const model = buildKubernetesBuiltinDetailModel('services', {
    metadata: { name: 'api', namespace: 'team-a' },
    spec: {
      type: 'LoadBalancer',
      clusterIPs: ['10.0.0.12', 'fd00::12'],
      externalIPs: ['203.0.113.9'],
      sessionAffinity: 'ClientIP',
      selector: { app: 'api' },
      ports: [{ name: 'http', port: 80, targetPort: 'web', nodePort: 30080, protocol: 'TCP' }],
    },
    status: { loadBalancer: { ingress: [{ hostname: 'api.example.test' }] } },
  }, fallback);
  assert.deepEqual(properties(model), {
    Name: 'api', Namespace: 'team-a', Created: '2026-07-18T01:02:03.000Z',
    Type: 'LoadBalancer', 'Cluster IPs': '10.0.0.12, fd00::12',
    'External IPs': '203.0.113.9, api.example.test', 'Session affinity': 'ClientIP',
  });
  assert.equal(model.properties.some(({ label }) => label === 'Status'), false);
  assert.deepEqual(model.sections.find(({ key }) => key === 'ports').rows, [
    ['http', '80', 'web', '30080', 'TCP'],
  ]);
  assert.deepEqual(model.sections.find(({ key }) => key === 'selector').entries, [['app', 'api']]);

  const manyPorts = buildKubernetesBuiltinDetailModel('services', {
    metadata: { name: 'many-ports', namespace: 'team-a' },
    spec: {
      ports: Array.from({ length: 102 }, (_, index) => ({
        name: `port-${String(index).padStart(3, '0')}`,
        port: 10_000 + index,
      })),
    },
  }, fallback);
  const boundedPorts = manyPorts.sections.find(({ key }) => key === 'ports').rows;
  assert.equal(boundedPorts.length, 100);
  assert.deepEqual(boundedPorts.at(-1), ['…', '+3 more', '', '', '']);
});

test('built-in Ingress drawer normalizes default backends, rules, TLS, and load-balancer addresses', async () => {
  const { buildKubernetesBuiltinDetailModel } = await import(modelPath);
  const model = buildKubernetesBuiltinDetailModel('ingresses', {
    metadata: { name: 'web', namespace: 'team-a' },
    spec: {
      ingressClassName: 'nginx',
      defaultBackend: { service: { name: 'fallback', port: { number: 8080 } } },
      rules: [{
        host: 'app.example.test',
        http: { paths: [{ path: '/api', pathType: 'Prefix', backend: {
          service: { name: 'api', port: { name: 'http' } },
        } }] },
      }],
      tls: [{ hosts: ['app.example.test'], secretName: 'app-tls' }],
    },
    status: { loadBalancer: { ingress: [{ ip: '192.0.2.10' }] } },
  }, fallback);
  assert.equal(properties(model).Address, '192.0.2.10');
  assert.equal(properties(model).TLS, '1 configuration');
  assert.deepEqual(model.sections.find(({ key }) => key === 'rules').rows, [
    ['*', 'Default', '—', 'fallback:8080'],
    ['app.example.test', '/api', 'Prefix', 'api:http'],
  ]);
  assert.deepEqual(model.sections.find(({ key }) => key === 'tls').rows, [
    ['app.example.test', 'app-tls'],
  ]);

  const empty = buildKubernetesBuiltinDetailModel('ingresses', {
    metadata: { name: 'empty', namespace: 'team-a' },
    spec: {},
    status: {},
  }, fallback);
  assert.equal(properties(empty).Ports, '—');
  assert.equal(properties(empty).TLS, '—');
  assert.deepEqual(empty.sections, []);
});

test('built-in ConfigMap exposes read-only data while Secret never emits key names or values', async () => {
  const { buildKubernetesBuiltinDetailModel } = await import(modelPath);
  const configMap = buildKubernetesBuiltinDetailModel('configmaps', {
    metadata: { name: 'settings', namespace: 'team-a' },
    immutable: true,
    data: { 'app.yaml': 'feature: true\nreplicas: 2' },
    binaryData: { logo: 'aGVsbG8=' },
  }, fallback);
  assert.equal(properties(configMap)['Data entries'], '1');
  assert.equal(properties(configMap)['Binary entries'], '1');
  assert.deepEqual(configMap.sections.find(({ key }) => key === 'data').rows, [
    ['app.yaml', 'feature: true\nreplicas: 2'],
  ]);
  assert.deepEqual(configMap.sections.find(({ key }) => key === 'binary-data').rows, [['logo', '5 B']]);

  const emptyValue = buildKubernetesBuiltinDetailModel('configmaps', {
    metadata: { name: 'empty-value', namespace: 'team-a', labels: { optional: '' } },
    data: { EMPTY: '' },
  }, fallback);
  assert.deepEqual(emptyValue.labels, [['optional', '(empty)']]);
  assert.deepEqual(emptyValue.sections.find(({ key }) => key === 'data').rows, [['EMPTY', '(empty)']]);

  const manyEntries = buildKubernetesBuiltinDetailModel('configmaps', {
    metadata: { name: 'many', namespace: 'team-a' },
    data: Object.fromEntries(Array.from({ length: 101 }, (_, index) => [
      `key-${String(index).padStart(3, '0')}`,
      `value-${index}`,
    ])),
  }, fallback);
  const boundedRows = manyEntries.sections.find(({ key }) => key === 'data').rows;
  assert.equal(boundedRows.length, 100);
  assert.deepEqual(boundedRows.at(-1), ['…', '+2 more']);

  const secret = buildKubernetesBuiltinDetailModel('secrets', {
    metadata: {
      name: 'credentials', namespace: 'team-a', labels: { app: 'api' },
      annotations: { 'kubectl.kubernetes.io/last-applied-configuration': '{"data":{"PASSWORD":"leak"}}' },
    },
    type: 'Opaque',
    data: { PASSWORD: 'decoded-value-that-must-not-render' },
  }, fallback);
  assert.equal(properties(secret)['Data entries'], '1');
  assert.deepEqual(secret.sections, []);
  assert.deepEqual(secret.annotations, []);
  assert.doesNotMatch(JSON.stringify(secret), /PASSWORD|decoded-value-that-must-not-render|leak/);
});

test('built-in PVC drawer keeps requested and bound capacity distinct', async () => {
  const { buildKubernetesBuiltinDetailModel } = await import(modelPath);
  const model = buildKubernetesBuiltinDetailModel('persistentvolumeclaims', {
    metadata: { name: 'data', namespace: 'team-a' },
    spec: {
      volumeName: 'pvc-123',
      storageClassName: 'fast',
      accessModes: ['ReadWriteOnce'],
      volumeMode: 'Filesystem',
      resources: { requests: { storage: '20Gi' } },
      selector: { matchLabels: { disk: 'ssd' } },
    },
    status: { phase: 'Bound', capacity: { storage: '25Gi' }, accessModes: ['ReadWriteOnce'] },
  }, fallback);
  assert.deepEqual(properties(model), {
    Name: 'data', Namespace: 'team-a', Created: '2026-07-18T01:02:03.000Z',
    Status: 'Bound', Volume: 'pvc-123', Capacity: '25Gi', Requested: '20Gi',
    'Access modes': 'ReadWriteOnce', 'Storage class': 'fast', 'Volume mode': 'Filesystem',
  });
  assert.deepEqual(model.sections.find(({ key }) => key === 'selector').entries, [['disk', 'ssd']]);

  const legacyStorageClass = buildKubernetesBuiltinDetailModel('persistentvolumeclaims', {
    metadata: {
      name: 'legacy',
      namespace: 'team-a',
      annotations: { 'volume.beta.kubernetes.io/storage-class': 'legacy-fast' },
    },
    spec: {},
    status: {},
  }, fallback);
  assert.equal(properties(legacyStorageClass)['Storage class'], 'legacy-fast');
});
