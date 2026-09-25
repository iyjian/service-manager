const test = require('node:test');
const assert = require('node:assert/strict');
const { kubernetesPodStatus } = require('../dist/shared/kubernetesPodStatus');
const { mapKubernetesResourceSummary } = require('../dist/main/kubernetes/resourceSummary');
const pod = (status, spec = {}, metadata = {}) => ({ metadata: { uid: 'test', name: 'test', namespace: 'test', resourceVersion: '1', ...metadata }, spec, status });

test('Pod display lifecycle includes pending, init, startup, readiness, completion and deletion', () => {
  const cases = [
    [pod({ phase: 'Pending' }), 'Pending'],
    [pod({ phase: 'Pending', conditions: [{ type: 'PodScheduled', reason: 'SchedulingGated', status: 'False' }] }), 'SchedulingGated'],
    [pod({ phase: 'Pending' }, { initContainers: [{ name: 'setup' }] }), 'Init:0/1'],
    [pod({ phase: 'Pending', initContainerStatuses: [{ name: 'setup', state: { terminated: { exitCode: 0 } } }], containerStatuses: [{ state: { waiting: { reason: 'ContainerCreating' } } }] }, { initContainers: [{ name: 'setup' }] }), 'ContainerCreating'],
    [pod({ phase: 'Running', conditions: [{ type: 'Ready', status: 'False' }], containerStatuses: [{ state: { running: {} }, ready: false }] }), 'NotReady'],
    [pod({ phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }], containerStatuses: [{ state: { running: {} }, ready: true }] }), 'Running'],
    [pod({ phase: 'Succeeded' }), 'Completed'],
    [pod({ phase: 'Failed', reason: 'Evicted' }), 'Evicted'],
    [pod({ phase: 'Running' }, {}, { deletionTimestamp: new Date() }), 'Terminating'],
    [pod({ phase: 'Succeeded' }, {}, { deletionTimestamp: '2026-09-25T00:00:00Z' }), 'Terminating'],
    [pod({ phase: 'Running', reason: 'NodeLost' }, {}, { deletionTimestamp: '2026-09-25T00:00:00Z' }), 'Unknown'],
  ];
  for (const [value, expected] of cases) {
    assert.equal(kubernetesPodStatus(value), expected);
    const summary = mapKubernetesResourceSummary('pods', value);
    assert.equal(summary.status, expected);
    assert.equal(summary.columns.status, expected);
  }
});
test('container failures are not hidden by the API Running/Pending phase', () => {
  for (const reason of ['ErrImagePull', 'ImagePullBackOff', 'CrashLoopBackOff', 'CreateContainerConfigError']) {
    assert.equal(kubernetesPodStatus(pod({ phase: 'Running', containerStatuses: [{ state: { running: {} } }, { state: { waiting: { reason } } }] })), reason);
  }
  assert.equal(kubernetesPodStatus(pod({ phase: 'Failed', containerStatuses: [{ state: { terminated: { reason: 'OOMKilled', exitCode: 137 } } }] })), 'OOMKilled');
  assert.equal(kubernetesPodStatus(pod({ phase: 'Failed', containerStatuses: [{ state: { terminated: { exitCode: 2 } } }] })), 'ExitCode:2');
  assert.equal(kubernetesPodStatus(pod({ phase: 'Pending', initContainerStatuses: [{ name: 'setup', state: { waiting: { reason: 'CrashLoopBackOff' } } }] }, { initContainers: [{ name: 'setup' }] })), 'Init:CrashLoopBackOff');
});
test('restartable init sidecars do not keep a started Pod in Init status', () => {
  const status = { phase: 'Running', initContainerStatuses: [{ name: 'sidecar', started: true, state: { running: {} } }], containerStatuses: [{ state: { running: {} } }] };
  assert.equal(kubernetesPodStatus(pod(status, { initContainers: [{ name: 'sidecar', restartPolicy: 'Always' }] })), 'Running');
});
test('mixed completed and running containers remain Running; all completed containers show Completed', () => {
  const done = { state: { terminated: { exitCode: 0, reason: 'Completed' } } };
  assert.equal(kubernetesPodStatus(pod({ phase: 'Running', containerStatuses: [done, { state: { running: {} } }] })), 'Running');
  assert.equal(kubernetesPodStatus(pod({ phase: 'Running', containerStatuses: [done] })), 'Completed');
});
