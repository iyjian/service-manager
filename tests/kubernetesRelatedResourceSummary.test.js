const test = require('node:test');
const assert = require('node:assert/strict');

const {
  mapKubernetesEndpointsSummary,
  mapKubernetesEndpointSliceSummaries,
} = require('../dist/main/kubernetes/relatedResourceSummary.js');

test('Service Endpoints summary exposes readiness, ports, and targets but never addresses', () => {
  const source = {
    metadata: { name: 'api' },
    subsets: [{
      addresses: [{ ip: '10.42.0.10', targetRef: { kind: 'Pod', name: 'api-a' } }],
      notReadyAddresses: [{ ip: '10.42.0.11', targetRef: { kind: 'Pod', name: 'api-b' } }],
      ports: [{ name: 'http', port: 8080, protocol: 'TCP' }],
    }],
  };
  const result = mapKubernetesEndpointsSummary(source);
  assert.deepEqual(result, {
    kind: 'Endpoints',
    name: 'api',
    ready: 1,
    notReady: 1,
    ports: ['http · 8080/TCP'],
    portCount: 1,
    targets: ['Pod/api-a', 'Pod/api-b'],
    targetCount: 2,
  });
  assert.doesNotMatch(JSON.stringify(result), /10\.42\.0\./);
});

test('Service EndpointSlice summaries treat an omitted ready condition as ready and strip addresses', () => {
  const result = mapKubernetesEndpointSliceSummaries([{
    metadata: { name: 'api-4kd7z' },
    ports: [{ name: 'http', port: 8080, protocol: 'TCP' }],
    endpoints: [
      { addresses: ['10.42.0.10'], targetRef: { kind: 'Pod', name: 'api-a' }, conditions: { ready: true } },
      { addresses: ['10.42.0.11'], targetRef: { kind: 'Pod', name: 'api-b' }, conditions: { ready: false } },
      { addresses: ['10.42.0.12'], targetRef: { kind: 'Pod', name: 'api-c' } },
    ],
  }]);
  assert.deepEqual(result, [{
    kind: 'EndpointSlice',
    name: 'api-4kd7z',
    ready: 2,
    notReady: 1,
    ports: ['http · 8080/TCP'],
    portCount: 1,
    targets: ['Pod/api-a', 'Pod/api-b', 'Pod/api-c'],
    targetCount: 3,
  }]);
  assert.doesNotMatch(JSON.stringify(result), /10\.42\.0\./);
});

test('Service backend summaries report bounded target totals without exposing addresses', () => {
  const addresses = Array.from({ length: 70 }, (_, index) => ({
    ip: `10.42.0.${index + 1}`,
    targetRef: { kind: 'Pod', name: `api-${String(index).padStart(2, '0')}` },
  }));
  const result = mapKubernetesEndpointsSummary({
    metadata: { name: 'api' },
    subsets: [{ addresses }],
  });
  assert.equal(result.targets.length, 64);
  assert.equal(result.targetCount, 70);
  assert.doesNotMatch(JSON.stringify(result), /10\.42\.0\./);
});
