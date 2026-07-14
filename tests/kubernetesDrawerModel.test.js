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
      containerStatuses: [{ name: 'api', ready: true, state: { running: {} } }],
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
  assert.deepEqual(model.containers[0].target, { namespace: 'apps', podName: 'api', container: 'api' });
  assert.equal(model.containers[0].status, 'Running');
  assert.equal(model.containers[0].environmentDeclared, true);
  assert.doesNotMatch(JSON.stringify(model), /db|password|PASSWORD/);
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
