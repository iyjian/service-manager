const test = require('node:test');
const assert = require('node:assert/strict');

const summaryPath = '../dist/main/kubernetes/podSummary';
const clientPath = '../dist/main/kubernetes/kubernetesClient';

test('Pod LIST summaries reserve CPU and Memory for live metrics while retaining restart and node fields', () => {
  const { summarizePodListColumns } = require(summaryPath);
  assert.deepEqual(summarizePodListColumns({
    spec: {
      nodeName: 'worker-a',
      containers: [
        { resources: { requests: { cpu: '250m', memory: '128Mi' } } },
        { resources: { requests: { cpu: '0.75', memory: '1Gi' } } },
      ],
      initContainers: [{ resources: { requests: { cpu: '8', memory: '8Gi' } } }],
    },
    status: {
      containerStatuses: [{ restartCount: 2 }, { restartCount: 1 }],
      initContainerStatuses: [{ restartCount: 3 }],
    },
  }), { cpu: '—', memory: '—', restarts: '6', node: 'worker-a' });
});

test('summarizePodMetric aggregates bounded live container usage from metrics.k8s.io', () => {
  const { summarizePodMetric } = require(summaryPath);
  assert.deepEqual(summarizePodMetric({
    metadata: { namespace: 'apps', name: 'api' },
    containers: [
      { name: 'api', usage: { cpu: '250m', memory: '128Mi' } },
      { name: 'sidecar', usage: { cpu: '0.75', memory: '1Gi' } },
    ],
  }), { namespace: 'apps', name: 'api', cpu: '1', memory: '1152Mi' });
  assert.equal(summarizePodMetric({ metadata: { namespace: 'apps', name: 'empty' }, containers: [] }), undefined);
});

test('summary mapper applies Pod columns to both List and Watch objects and keeps Event messages safe', () => {
  const { mapKubernetesResourceSummary } = require(clientPath);
  const pod = mapKubernetesResourceSummary('pods', {
    metadata: { uid: 'pod-1', name: 'api', namespace: 'apps', resourceVersion: '9' },
    spec: { containers: [{ resources: { requests: { cpu: '500m', memory: '256Mi' } } }] },
    status: { phase: 'Running', containerStatuses: [{ restartCount: 0 }] },
  });
  assert.deepEqual(pod.columns, { status: 'Running', cpu: '—', memory: '—', restarts: '0', node: '—' });

  const event = mapKubernetesResourceSummary('events', {
    metadata: { uid: 'event-1', name: 'api.1', namespace: 'apps', resourceVersion: '10' },
    reason: 'BackOff', type: 'Warning', message: 'retrying <unsafe>', count: 4,
    lastTimestamp: '2026-07-14T00:00:00.000Z',
  });
  assert.equal(event.columns.message, 'retrying <unsafe>');
  assert.equal(event.columns.type, 'Warning');
  assert.equal(event.columns.count, '4');
});
