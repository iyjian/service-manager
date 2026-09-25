const test = require('node:test');
const assert = require('node:assert/strict');
const { collectKubernetesOverview, podOverviewRequests, overviewQuantity } = require('../dist/main/kubernetes/overview');

const node = (name, extra = {}) => ({ metadata: { name }, spec: {}, status: { capacity: { cpu: '8', memory: '32Gi', 'ephemeral-storage': '100Gi', 'nvidia.com/gpu': '4' }, allocatable: { cpu: '7500m', memory: '30Gi', 'ephemeral-storage': '90Gi', 'nvidia.com/gpu': '4', pods: '110' }, conditions: [{ type: 'Ready', status: 'True' }] }, ...extra });
const pod = (phase, spec = {}) => ({ spec: { nodeName: 'a', containers: [{ resources: { requests: { cpu: '500m', memory: '1Gi' }, limits: { 'nvidia.com/gpu': '1' } } }], ...spec }, status: { phase } });
function reader(overrides = {}) {
  return async (group, method, params, signal) => {
    signal.throwIfAborted();
    if (overrides[method]) return overrides[method](params, signal);
    if (method === 'listNode') return { items: [node('a'), node('b', { spec: { unschedulable: true } })] };
    if (method === 'listPodForAllNamespaces') return { items: [pod('Running'), pod('Succeeded'), pod('Failed'), pod('Pending', { nodeName: undefined })] };
    if (method === 'listClusterCustomObject') return { items: [{ metadata: { name: 'a' }, usage: { cpu: '250000000n', memory: '2Gi' } }, { metadata: { name: 'b' }, usage: { cpu: '1', memory: '1Gi' } }] };
    if (method === 'connectGetNodeProxyWithPath') return JSON.stringify({ node: { fs: { capacityBytes: 1000, usedBytes: 400, availableBytes: 550 } } });
    if (method === 'listPersistentVolume') return { items: [{ spec: { capacity: { storage: '10Gi' } }, status: { phase: 'Bound' } }, { spec: { capacity: { storage: '5Gi' } }, status: { phase: 'Available' } }] };
    if (method === 'listPersistentVolumeClaimForAllNamespaces') return { items: [{ spec: { resources: { requests: { storage: '8Gi' } } } }] };
    return { items: [] };
  };
}
test('Kubernetes quantities support CPU fractions, binary storage and scientific notation', () => {
  assert.equal(overviewQuantity('750m'), .75);
  assert.equal(overviewQuantity('1.5Gi'), 1.5 * 1024 ** 3);
  assert.equal(overviewQuantity('250000000n'), .25);
  assert.equal(overviewQuantity('2e3'), 2000);
  for (const value of ['garbage', '-1', '1e9999', null, Infinity]) assert.equal(overviewQuantity(value), null);
});
test('effective requests handle init peaks, restartable sidecars, overhead and pod-level budgets', () => {
  const spec = { containers: [{ resources: { requests: { cpu: '2' } } }], initContainers: [
    { restartPolicy: 'Always', resources: { requests: { cpu: '1' } } },
    { resources: { requests: { cpu: '4' } } },
  ], overhead: { cpu: '100m' } };
  assert.equal(podOverviewRequests({ spec }).cpu, 5.1);
  spec.resources = { requests: { cpu: '6' } };
  assert.equal(podOverviewRequests({ spec }).cpu, 6.1);
});
test('overview aggregates all nodes, active assigned pod requests, GPU slots and separate storage sources', async () => {
  const result = await collectKubernetesOverview(reader(), new AbortController().signal);
  assert.equal(result.counts.find(c => c.label === 'Pods').count, 4);
  assert.equal(result.nodes[0].pods, 1);
  assert.equal(result.nodes[1].unschedulable, true);
  assert.deepEqual(result.resources.find(r => r.key === 'nvidia.com/gpu'), { key: 'nvidia.com/gpu', capacity: 8, allocatable: 8, requested: 1, available: 7, used: null });
  assert.equal(result.resources.find(r => r.key === 'cpu').used, 1.25);
  assert.deepEqual(result.disk, { capacity: 2000, used: 800, available: 1100 });
  assert.equal(result.volumes.capacity, 15 * 1024 ** 3);
  assert.equal(result.volumes.available, 5 * 1024 ** 3);
  assert.equal(result.volumes.requested, 8 * 1024 ** 3);
  assert.equal(result.issues.length, 0);
});
test('denied, missing and partial metrics are unavailable rather than zero or partial totals', async () => {
  const denied = () => { throw { code: 403, body: 'sensitive response omitted' }; };
  const result = await collectKubernetesOverview(reader({ listPodForAllNamespaces: denied, listSecretForAllNamespaces: denied,
    listClusterCustomObject: () => ({ items: [{ metadata: { name: 'a' }, usage: { cpu: '1', memory: '1Gi' } }] }),
    connectGetNodeProxyWithPath: params => params.name === 'a' ? { node: { fs: { capacityBytes: 10, usedBytes: 5, availableBytes: 4 } } } : denied(),
  }), new AbortController().signal);
  assert.equal(result.resources[0].requested, null);
  assert.equal(result.resources[0].available, null);
  assert.equal(result.resources[0].used, null);
  assert.equal(result.disk, null);
  assert.equal(result.nodes[0].disk.available, 4);
  assert.equal(result.nodes[1].diskError, 'No permission');
  assert.equal(result.counts.find(c => c.label === 'Secrets').count, null);
  assert.ok(!JSON.stringify(result).includes('sensitive'));
});
test('pagination reads all retained pods and metadata totals, while repeated continuations fail safely', async () => {
  const result = await collectKubernetesOverview(reader({
    listPodForAllNamespaces: params => params._continue ? { items: [pod('Running')] } : { items: [pod('Running')], metadata: { _continue: 'next' } },
    listServiceForAllNamespaces: () => ({ items: [{}], metadata: { remainingItemCount: 50, _continue: 'next' } }),
    listConfigMapForAllNamespaces: () => ({ items: [], metadata: { _continue: 'loop' } }),
  }), new AbortController().signal);
  assert.equal(result.nodes[0].pods, 2);
  assert.equal(result.counts.find(c => c.label === 'Services').count, 51);
  assert.equal(result.counts.find(c => c.label === 'ConfigMaps').count, null);
});
test('cancellation reaches active overview calls and stops queued work', async () => {
  const controller = new AbortController(); let started = 0;
  const promise = collectKubernetesOverview(async (_g, _m, _p, signal) => {
    started++;
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
  }, controller.signal);
  controller.abort();
  await assert.rejects(promise, /cancelled/);
  assert.equal(started, 4);
});
