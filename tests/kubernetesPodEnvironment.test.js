const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const resolverPath = '../dist/main/kubernetes/podEnvironment';
const { createKubernetesClient } = require('../dist/main/kubernetes/kubernetesClient');

function podWithContainer(container) {
  return { spec: { containers: [container] } };
}

function base64(value) {
  return Buffer.from(value, 'utf8').toString('base64');
}

async function createPodEnvironmentClient(t, readNamespacedPod) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'service-manager-pod-environment-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const kubeconfigPath = path.join(directory, 'config.yaml');
  await fs.writeFile(kubeconfigPath, [
    'apiVersion: v1',
    'kind: Config',
    'clusters:',
    '- name: local',
    '  cluster:',
    '    server: https://127.0.0.1:6443',
    'users:',
    '- name: token-user',
    '  user:',
    '    token: test-token',
    'contexts:',
    '- name: token',
    '  context:',
    '    cluster: local',
    '    user: token-user',
    'current-context: token',
    '',
  ].join('\n'));

  class CoreV1Api {}
  class KubeConfig {
    loadFromString() {}
    makePathsAbsolute() {}
    setCurrentContext() {}
    getContextObject() { return { name: 'token' }; }
    getCurrentUser() { return { token: 'test-token' }; }
    makeApiClient(Api) {
      return Api === CoreV1Api ? { readNamespacedPod } : {};
    }
  }

  return createKubernetesClient({ kubeconfigPath, context: 'token' }, {
    loadKubernetesNode: async () => ({
      KubeConfig,
      CoreV1Api,
      DiscoveryV1Api: class DiscoveryV1Api {},
      AppsV1Api: class AppsV1Api {},
      NetworkingV1Api: class NetworkingV1Api {},
      ApiextensionsV1Api: class ApiextensionsV1Api {},
      CustomObjectsApi: class CustomObjectsApi {},
      Watch: class Watch {},
      Log: class Log {},
      Exec: class Exec {},
      PortForward: class PortForward {},
    }),
  });
}

test('resolves active Pod environment literals, Secret keys, and prefixed Secret imports with one Secret read', async () => {
  const { resolvePodContainerEnvironment } = require(resolverPath);
  let reads = 0;
  const pod = podWithContainer({
    name: 'api',
    env: [
      { name: 'MODE', value: 'prod' },
      { name: 'PASSWORD', valueFrom: { secretKeyRef: { name: 'app-env', key: 'password' } } },
    ],
    envFrom: [{ prefix: 'APP_', secretRef: { name: 'app-env' } }],
  });

  const result = await resolvePodContainerEnvironment(pod, 'api', {
    async readSecret(name) {
      reads += 1;
      assert.equal(name, 'app-env');
      return { data: { password: 'c2VjcmV0', host: 'ZGI=' } };
    },
    isPermissionError: () => false,
  });

  assert.equal(reads, 1);
  assert.deepEqual(result, {
    entries: [
      { name: 'MODE', source: 'literal', value: 'prod' },
      {
        name: 'PASSWORD', source: 'secretKeyRef', value: 'secret', reference: 'secret/app-env/password', optional: false,
      },
      {
        name: 'APP_host', source: 'secretEnvFrom', value: 'db', reference: 'secret/app-env/host', optional: false,
      },
      {
        name: 'APP_password', source: 'secretEnvFrom', value: 'secret', reference: 'secret/app-env/password', optional: false,
      },
    ],
    truncated: false,
    permissionDenied: false,
  });
  assert.deepEqual(pod.spec.containers[0].env[1].valueFrom.secretKeyRef, { name: 'app-env', key: 'password' });
});

test('labels declared Pod environment values that cannot be evaluated without ConfigMap or runtime state', async () => {
  const { resolvePodContainerEnvironment } = require(resolverPath);
  const result = await resolvePodContainerEnvironment(podWithContainer({
    name: 'api',
    env: [
      { name: 'CONFIG_MODE', valueFrom: { configMapKeyRef: { name: 'settings', key: 'mode' } } },
      { name: 'POD_NAME', valueFrom: { fieldRef: { fieldPath: 'metadata.name' } } },
      { name: 'CPU_LIMIT', valueFrom: { resourceFieldRef: { resource: 'limits.cpu', containerName: 'api' } } },
      { name: 'UNKNOWN', valueFrom: {} },
    ],
    envFrom: [
      { prefix: 'CFG_', configMapRef: { name: 'settings' } },
      { prefix: 'UNKNOWN_', somethingElse: { name: 'not-supported' } },
    ],
  }), 'api', {
    async readSecret() {
      throw new Error('Secret reads are not expected for non-Secret declarations.');
    },
    isPermissionError: () => false,
  });

  assert.deepEqual(result, {
    entries: [
      {
        name: 'CONFIG_MODE', source: 'configMapKeyRef', reference: 'configmap/settings/mode', optional: false,
        unavailable: 'unsupported',
      },
      { name: 'POD_NAME', source: 'fieldRef', reference: 'field/metadata.name', unavailable: 'unsupported' },
      { name: 'CPU_LIMIT', source: 'resourceFieldRef', reference: 'resource/limits.cpu', unavailable: 'unsupported' },
      { name: 'UNKNOWN', source: 'unknown', unavailable: 'unsupported' },
      {
        name: 'CFG_*', source: 'configMapEnvFrom', reference: 'configmap/settings', optional: false,
        unavailable: 'unsupported',
      },
      { name: 'UNKNOWN_*', source: 'unknown', unavailable: 'unsupported' },
    ],
    truncated: false,
    permissionDenied: false,
  });
});

test('marks missing, permission-denied, and oversized active Pod environment Secret declarations without returning hidden data', async () => {
  const {
    resolvePodContainerEnvironment,
    MAX_POD_ENVIRONMENT_VALUE_BYTES,
  } = require(resolverPath);
  const result = await resolvePodContainerEnvironment(podWithContainer({
    name: 'api',
    env: [
      { name: 'MISSING', valueFrom: { secretKeyRef: { name: 'missing', key: 'password' } } },
      { name: 'OPTIONAL', valueFrom: { secretKeyRef: { name: 'missing', key: 'optional', optional: true } } },
      { name: 'DENIED', valueFrom: { secretKeyRef: { name: 'denied', key: 'token' } } },
      { name: 'LARGE', valueFrom: { secretKeyRef: { name: 'large', key: 'value' } } },
    ],
  }), 'api', {
    async readSecret(name) {
      if (name === 'missing') return { data: {} };
      if (name === 'denied') throw Object.assign(new Error('forbidden secret data'), { statusCode: 403 });
      return { data: { value: base64('x'.repeat(MAX_POD_ENVIRONMENT_VALUE_BYTES + 1)) } };
    },
    isPermissionError: (error) => error?.statusCode === 403,
  });

  assert.deepEqual(result.entries.map(({ name, unavailable }) => [name, unavailable]), [
    ['MISSING', 'missing'],
    ['OPTIONAL', 'missing'],
    ['DENIED', 'no-permission'],
    ['LARGE', 'too-large'],
  ]);
  assert.equal(result.permissionDenied, true);
  assert.equal(result.truncated, true);
  assert.doesNotMatch(JSON.stringify(result), /x{100}|forbidden secret data/);
});

test('preserves optional state for required and optional Secret and ConfigMap key and envFrom declarations', async () => {
  const { resolvePodContainerEnvironment } = require(resolverPath);
  const result = await resolvePodContainerEnvironment(podWithContainer({
    name: 'api',
    env: [
      { name: 'REQUIRED_SECRET', valueFrom: { secretKeyRef: { name: 'missing-key', key: 'required' } } },
      { name: 'OPTIONAL_SECRET', valueFrom: { secretKeyRef: { name: 'missing-key', key: 'optional', optional: true } } },
      { name: 'REQUIRED_CONFIG', valueFrom: { configMapKeyRef: { name: 'settings', key: 'mode' } } },
      { name: 'OPTIONAL_CONFIG', valueFrom: { configMapKeyRef: { name: 'settings', key: 'mode', optional: true } } },
    ],
    envFrom: [
      { prefix: 'REQUIRED_SECRET_', secretRef: { name: 'missing-required' } },
      { prefix: 'OPTIONAL_SECRET_', secretRef: { name: 'missing-optional', optional: true } },
      { prefix: 'REQUIRED_CONFIG_', configMapRef: { name: 'settings' } },
      { prefix: 'OPTIONAL_CONFIG_', configMapRef: { name: 'settings', optional: true } },
    ],
  }), 'api', {
    async readSecret(name) {
      if (name === 'missing-key') return { data: {} };
      throw Object.assign(new Error('not found'), { statusCode: 404 });
    },
    isPermissionError: () => false,
  });

  assert.deepEqual(result.entries, [
    {
      name: 'REQUIRED_SECRET', source: 'secretKeyRef', reference: 'secret/missing-key/required',
      optional: false, unavailable: 'missing',
    },
    {
      name: 'OPTIONAL_SECRET', source: 'secretKeyRef', reference: 'secret/missing-key/optional',
      optional: true, unavailable: 'missing',
    },
    {
      name: 'REQUIRED_CONFIG', source: 'configMapKeyRef', reference: 'configmap/settings/mode',
      optional: false, unavailable: 'unsupported',
    },
    {
      name: 'OPTIONAL_CONFIG', source: 'configMapKeyRef', reference: 'configmap/settings/mode',
      optional: true, unavailable: 'unsupported',
    },
    {
      name: 'REQUIRED_SECRET_*', source: 'secretEnvFrom', reference: 'secret/missing-required',
      optional: false, unavailable: 'missing',
    },
    {
      name: 'OPTIONAL_SECRET_*', source: 'secretEnvFrom', reference: 'secret/missing-optional',
      optional: true, unavailable: 'missing',
    },
    {
      name: 'REQUIRED_CONFIG_*', source: 'configMapEnvFrom', reference: 'configmap/settings',
      optional: false, unavailable: 'unsupported',
    },
    {
      name: 'OPTIONAL_CONFIG_*', source: 'configMapEnvFrom', reference: 'configmap/settings',
      optional: true, unavailable: 'unsupported',
    },
  ]);
});

test('treats inherited Secret data keys as missing instead of resolving prototype values', async () => {
  const { resolvePodContainerEnvironment } = require(resolverPath);
  const inheritedData = Object.create({ toString: base64('must-not-leak') });
  const result = await resolvePodContainerEnvironment(podWithContainer({
    name: 'api',
    env: [{ name: 'INHERITED', valueFrom: { secretKeyRef: { name: 'app-env', key: 'toString' } } }],
  }), 'api', {
    async readSecret() { return { data: inheritedData }; },
    isPermissionError: () => false,
  });

  assert.deepEqual(result.entries, [{
    name: 'INHERITED',
    source: 'secretKeyRef',
    reference: 'secret/app-env/toString',
    optional: false,
    unavailable: 'missing',
  }]);
  assert.doesNotMatch(JSON.stringify(result), /must-not-leak/);
});

test('KubernetesClient returns a fixed no-permission result and sanitizes other Pod-read failures', async (t) => {
  const noPermissionClient = await createPodEnvironmentClient(t, async () => {
    throw Object.assign(new Error('forbidden Pod body should never escape'), { statusCode: 403 });
  });
  t.after(() => noPermissionClient.close());

  const noPermission = await noPermissionClient.getPodContainerEnvironment({
    namespace: 'team-a', podName: 'api-1', container: 'api',
  });
  assert.deepEqual(noPermission, {
    entries: [{ name: '(unavailable)', source: 'unknown', unavailable: 'no-permission' }],
    truncated: false,
    permissionDenied: true,
  });
  assert.doesNotMatch(JSON.stringify(noPermission), /forbidden|api-1|team-a/i);

  const rawFailure = Object.assign(new Error('Pod response leaked-secret-value'), {
    code: 'ECONNRESET',
    statusCode: 500,
    response: { body: 'leaked-secret-value' },
  });
  const failedClient = await createPodEnvironmentClient(t, async () => { throw rawFailure; });
  t.after(() => failedClient.close());

  await assert.rejects(
    failedClient.getPodContainerEnvironment({ namespace: 'team-a', podName: 'api-1', container: 'api' }),
    (error) => {
      assert.notEqual(error, rawFailure);
      assert.equal(error.message, 'Unable to read Kubernetes Pod environment.');
      assert.equal(error.code, 'ECONNRESET');
      assert.equal(error.statusCode, 500);
      assert.doesNotMatch(JSON.stringify(error), /leaked-secret-value|Pod response/i);
      return true;
    },
  );
});

test('resolves environment declarations from an init container and rejects an absent selected container', async () => {
  const { resolvePodContainerEnvironment } = require(resolverPath);
  const pod = {
    spec: {
      containers: [{ name: 'api' }],
      initContainers: [{ name: 'setup', env: [{ name: 'READY', value: 'yes' }] }],
    },
  };

  const result = await resolvePodContainerEnvironment(pod, 'setup', {
    async readSecret() {
      throw new Error('Secret reads are not expected.');
    },
    isPermissionError: () => false,
  });

  assert.deepEqual(result.entries, [{ name: 'READY', source: 'literal', value: 'yes' }]);
  await assert.rejects(
    resolvePodContainerEnvironment(pod, 'missing', {
      async readSecret() { return {}; },
      isPermissionError: () => false,
    }),
    /container is not available/i,
  );
});

test('truncates active Pod environment imports at the entry and total response bounds', async () => {
  const {
    resolvePodContainerEnvironment,
    MAX_POD_ENVIRONMENT_ENTRIES,
  } = require(resolverPath);
  const manyKeys = Object.fromEntries(Array.from({ length: MAX_POD_ENVIRONMENT_ENTRIES + 1 }, (_value, index) => [
    `KEY_${String(index).padStart(3, '0')}`,
    base64('value'),
  ]));
  const entryBound = await resolvePodContainerEnvironment(podWithContainer({
    name: 'api',
    envFrom: [{ prefix: 'APP_', secretRef: { name: 'many' } }],
  }), 'api', {
    async readSecret() { return { data: manyKeys }; },
    isPermissionError: () => false,
  });

  assert.equal(entryBound.entries.length, MAX_POD_ENVIRONMENT_ENTRIES);
  assert.equal(entryBound.entries[0].name, 'APP_KEY_000');
  assert.equal(entryBound.entries.at(-1).name, 'APP_KEY_511');
  assert.equal(entryBound.truncated, true);

  const value = 'v'.repeat(15_000);
  const totalBound = await resolvePodContainerEnvironment(podWithContainer({
    name: 'api',
    envFrom: [{ secretRef: { name: 'large-total' } }],
  }), 'api', {
    async readSecret() {
      return {
        data: Object.fromEntries(Array.from({ length: 9 }, (_entry, index) => [
          `VALUE_${String(index).padStart(2, '0')}`,
          base64(value),
        ])),
      };
    },
    isPermissionError: () => false,
  });

  assert.equal(totalBound.entries.length, 8);
  assert.equal(totalBound.entries.every((entry) => entry.value === value), true);
  assert.equal(totalBound.truncated, true);
});

test('marks malformed and non-UTF-8 active Pod environment Secret data as too large without storing the decoded bytes', async () => {
  const { resolvePodContainerEnvironment } = require(resolverPath);
  const result = await resolvePodContainerEnvironment(podWithContainer({
    name: 'api',
    env: [
      { name: 'MALFORMED', valueFrom: { secretKeyRef: { name: 'bad', key: 'malformed' } } },
      { name: 'BINARY', valueFrom: { secretKeyRef: { name: 'bad', key: 'binary' } } },
      { name: 'OVERPADDED', valueFrom: { secretKeyRef: { name: 'bad', key: 'overpadded' } } },
    ],
  }), 'api', {
    async readSecret() {
      return {
        data: {
          malformed: 'not*base64',
          binary: Buffer.from([0xff, 0xfe, 0x00]).toString('base64'),
          overpadded: 'YQ===',
        },
      };
    },
    isPermissionError: () => false,
  });

  assert.deepEqual(result.entries, [
    {
      name: 'MALFORMED', source: 'secretKeyRef', reference: 'secret/bad/malformed', optional: false,
      unavailable: 'too-large',
    },
    {
      name: 'BINARY', source: 'secretKeyRef', reference: 'secret/bad/binary', optional: false,
      unavailable: 'too-large',
    },
    {
      name: 'OVERPADDED', source: 'secretKeyRef', reference: 'secret/bad/overpadded', optional: false,
      unavailable: 'too-large',
    },
  ]);
  assert.equal(result.truncated, true);
  assert.doesNotMatch(JSON.stringify(result), /\uFFFD|not\*base64/);
});

test('sanitizes active Pod environment transport failures before they can expose Secret data', async () => {
  const { resolvePodContainerEnvironment } = require(resolverPath);
  const failure = Object.assign(new Error('Kubernetes transport leaked-secret-value'), {
    code: 'ECONNRESET',
    response: { body: 'leaked-secret-value' },
  });

  await assert.rejects(
    resolvePodContainerEnvironment(podWithContainer({
      name: 'api',
      env: [{ name: 'PASSWORD', valueFrom: { secretKeyRef: { name: 'app-env', key: 'password' } } }],
    }), 'api', {
      async readSecret() { throw failure; },
      isPermissionError: () => false,
    }),
    (error) => {
      assert.notEqual(error, failure);
      assert.equal(error.message, 'Unable to read referenced Kubernetes Secret.');
      assert.equal(error.code, 'ECONNRESET');
      assert.doesNotMatch(JSON.stringify(error), /leaked-secret-value/);
      return true;
    },
  );
});
