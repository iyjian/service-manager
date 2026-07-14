const assert = require('node:assert/strict');
const test = require('node:test');

const resolverPath = '../dist/main/kubernetes/podEnvironment';

function podWithContainer(container) {
  return { spec: { containers: [container] } };
}

function base64(value) {
  return Buffer.from(value, 'utf8').toString('base64');
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
      { name: 'PASSWORD', source: 'secretKeyRef', value: 'secret', reference: 'secret/app-env/password' },
      { name: 'APP_host', source: 'secretEnvFrom', value: 'db', reference: 'secret/app-env/host' },
      { name: 'APP_password', source: 'secretEnvFrom', value: 'secret', reference: 'secret/app-env/password' },
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
      { name: 'CONFIG_MODE', source: 'configMapKeyRef', reference: 'configmap/settings/mode', unavailable: 'unsupported' },
      { name: 'POD_NAME', source: 'fieldRef', reference: 'field/metadata.name', unavailable: 'unsupported' },
      { name: 'CPU_LIMIT', source: 'resourceFieldRef', reference: 'resource/limits.cpu', unavailable: 'unsupported' },
      { name: 'UNKNOWN', source: 'unknown', unavailable: 'unsupported' },
      { name: 'CFG_*', source: 'configMapEnvFrom', reference: 'configmap/settings', unavailable: 'unsupported' },
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
    { name: 'MALFORMED', source: 'secretKeyRef', reference: 'secret/bad/malformed', unavailable: 'too-large' },
    { name: 'BINARY', source: 'secretKeyRef', reference: 'secret/bad/binary', unavailable: 'too-large' },
    { name: 'OVERPADDED', source: 'secretKeyRef', reference: 'secret/bad/overpadded', unavailable: 'too-large' },
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
