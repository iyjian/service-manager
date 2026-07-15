const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createKubernetesClient } = require('../dist/main/kubernetes/kubernetesClient');

const TARGET = { namespace: 'apps', podName: 'api-current', container: 'api' };

function controllerOwner(kind, name, uid) {
  return { apiVersion: 'apps/v1', kind, name, uid, controller: true };
}

function ownedPod() {
  return {
    metadata: {
      uid: 'pod-current',
      name: TARGET.podName,
      namespace: TARGET.namespace,
      ownerReferences: [controllerOwner('ReplicaSet', 'api-7b8c9d', 'rs-uid')],
    },
    spec: { containers: [{ name: TARGET.container }] },
  };
}

function ownedReplicaSet(overrides = {}) {
  return {
    metadata: {
      uid: 'rs-uid',
      name: 'api-7b8c9d',
      namespace: TARGET.namespace,
      ownerReferences: [controllerOwner('Deployment', 'api', 'deployment-uid')],
      ...overrides,
    },
  };
}

function deployment(overrides = {}) {
  return {
    metadata: { uid: 'deployment-uid', name: 'api', namespace: TARGET.namespace },
    spec: {
      selector: {
        matchLabels: { app: 'api' },
        matchExpressions: [
          { key: 'tier', operator: 'In', values: ['backend', 'worker'] },
          { key: 'track', operator: 'NotIn', values: ['canary'] },
          { key: 'debug', operator: 'Exists' },
          { key: 'legacy', operator: 'DoesNotExist' },
        ],
      },
    },
    ...overrides,
  };
}

function pod(uid, name, container = TARGET.container, init = false) {
  return {
    metadata: { uid, name, namespace: TARGET.namespace },
    spec: init
      ? { initContainers: [{ name: container }] }
      : { containers: [{ name: container }] },
  };
}

async function createDeploymentTargetClient(t, { core = {}, apps = {} }) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'service-manager-deployment-logs-'));
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
  class AppsV1Api {}
  class KubeConfig {
    loadFromString() {}
    makePathsAbsolute() {}
    setCurrentContext() {}
    getContextObject() { return { name: 'token' }; }
    getCurrentUser() { return { token: 'test-token' }; }
    makeApiClient(Api) {
      if (Api === CoreV1Api) return core;
      if (Api === AppsV1Api) return apps;
      return {};
    }
  }

  return createKubernetesClient({ kubeconfigPath, context: 'token' }, {
    loadKubernetesNode: async () => ({
      KubeConfig,
      CoreV1Api,
      AppsV1Api,
      DiscoveryV1Api: class DiscoveryV1Api {},
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

test('KubernetesClient resolves a Deployment log target through controller UIDs, selector forms, pages, and container declarations', async (t) => {
  const calls = { pod: [], replicaSet: [], deployment: [], list: [] };
  const core = {
    async readNamespacedPod(input) {
      calls.pod.push(input);
      return ownedPod();
    },
    async listNamespacedPod(input) {
      calls.list.push(input);
      if (!input._continue) {
        return {
          items: [
            pod('pod-b', 'api-b'),
            pod('pod-wrong-container', 'api-worker', 'worker'),
            pod('pod-a', 'api-a', TARGET.container, true),
            { metadata: { name: 'missing-uid' }, spec: { containers: [{ name: TARGET.container }] } },
          ],
          metadata: { continue: 'page-2' },
        };
      }
      return {
        items: [
          pod('pod-b', 'api-b'),
          pod('pod-c', 'api-c'),
        ],
        metadata: {},
      };
    },
  };
  const apps = {
    async readNamespacedReplicaSet(input) {
      calls.replicaSet.push(input);
      return ownedReplicaSet();
    },
    async readNamespacedDeployment(input) {
      calls.deployment.push(input);
      return deployment();
    },
  };
  const client = await createDeploymentTargetClient(t, { core, apps });

  const result = await client.resolvePodDeploymentLogTargets(TARGET);

  assert.deepEqual(result, {
    name: 'api',
    pods: [
      { uid: 'pod-a', podName: 'api-a' },
      { uid: 'pod-b', podName: 'api-b' },
      { uid: 'pod-c', podName: 'api-c' },
    ],
  });
  assert.deepEqual(calls.pod, [{ name: 'api-current', namespace: 'apps' }]);
  assert.deepEqual(calls.replicaSet, [{ name: 'api-7b8c9d', namespace: 'apps' }]);
  assert.deepEqual(calls.deployment, [{ name: 'api', namespace: 'apps' }]);
  const labelSelector = 'app=api,tier in (backend,worker),track notin (canary),debug,!legacy';
  assert.deepEqual(calls.list, [
    { namespace: 'apps', labelSelector, limit: 200 },
    { namespace: 'apps', labelSelector, limit: 200, _continue: 'page-2' },
  ]);
  await client.close();
});

test('KubernetesClient rejects stale or non-controller owner chains without listing Deployment Pods', async (t) => {
  const listCalls = [];
  const client = await createDeploymentTargetClient(t, {
    core: {
      async readNamespacedPod() { return ownedPod(); },
      async listNamespacedPod(input) { listCalls.push(input); return { items: [] }; },
    },
    apps: {
      async readNamespacedReplicaSet() { return ownedReplicaSet({ uid: 'replacement-rs-uid' }); },
      async readNamespacedDeployment() { throw new Error('Deployment must not be read after a ReplicaSet UID mismatch.'); },
    },
  });

  assert.equal(await client.resolvePodDeploymentLogTargets(TARGET), undefined);
  assert.deepEqual(listCalls, []);
  await client.close();
});

test('KubernetesClient requires the resolved Deployment UID to match its ReplicaSet controller owner', async (t) => {
  const client = await createDeploymentTargetClient(t, {
    core: {
      async readNamespacedPod() { return ownedPod(); },
      async listNamespacedPod() { throw new Error('Pods must not be listed after a Deployment UID mismatch.'); },
    },
    apps: {
      async readNamespacedReplicaSet() { return ownedReplicaSet(); },
      async readNamespacedDeployment() {
        return deployment({ metadata: { uid: 'replacement-deployment-uid', name: 'api' } });
      },
    },
  });

  assert.equal(await client.resolvePodDeploymentLogTargets(TARGET), undefined);
  await client.close();
});

test('KubernetesClient returns no Deployment log target for a Pod without a ReplicaSet controller', async (t) => {
  const client = await createDeploymentTargetClient(t, {
    core: {
      async readNamespacedPod() {
        return {
          metadata: {
            uid: 'pod-current',
            ownerReferences: [{ ...controllerOwner('ReplicaSet', 'api-7b8c9d', 'rs-uid'), controller: false }],
          },
        };
      },
    },
    apps: {
      async readNamespacedReplicaSet() { throw new Error('A non-controller owner must not be followed.'); },
    },
  });

  assert.equal(await client.resolvePodDeploymentLogTargets(TARGET), undefined);
  await client.close();
});

test('KubernetesClient treats 401, 403, and 404 during Deployment log discovery as unavailable', async (t) => {
  const cases = [
    {
      name: 'Pod 401',
      core: { async readNamespacedPod() { throw Object.assign(new Error('unauthorized'), { statusCode: 401 }); } },
      apps: {},
    },
    {
      name: 'ReplicaSet 403',
      core: { async readNamespacedPod() { return ownedPod(); } },
      apps: { async readNamespacedReplicaSet() { throw { response: { statusCode: 403 } }; } },
    },
    {
      name: 'Deployment 404',
      core: { async readNamespacedPod() { return ownedPod(); } },
      apps: {
        async readNamespacedReplicaSet() { return ownedReplicaSet(); },
        async readNamespacedDeployment() { throw { status: 404 }; },
      },
    },
    {
      name: 'Pod list 403',
      core: {
        async readNamespacedPod() { return ownedPod(); },
        async listNamespacedPod() { throw { response: { status: 403 } }; },
      },
      apps: {
        async readNamespacedReplicaSet() { return ownedReplicaSet(); },
        async readNamespacedDeployment() { return deployment(); },
      },
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async (t) => {
      const client = await createDeploymentTargetClient(t, entry);
      assert.equal(await client.resolvePodDeploymentLogTargets(TARGET), undefined);
      await client.close();
    });
  }
});

test('KubernetesClient propagates non-RBAC Deployment log discovery failures', async (t) => {
  const expected = Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
  const client = await createDeploymentTargetClient(t, {
    core: { async readNamespacedPod() { return ownedPod(); } },
    apps: { async readNamespacedReplicaSet() { throw expected; } },
  });

  await assert.rejects(client.resolvePodDeploymentLogTargets(TARGET), (error) => error === expected);
  await client.close();
});
