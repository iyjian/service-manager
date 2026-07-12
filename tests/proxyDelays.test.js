const test = require('node:test');
const assert = require('node:assert/strict');

const { collectDelayTestTargets, runBoundedDelayTests } = require('../dist/main/proxy/proxyDelays');
const { MihomoApi } = require('../dist/main/proxy/mihomoApi');
const { ProxyRuntime } = require('../dist/main/proxy/proxyRuntime');

const RECORDS = {
  GLOBAL: { name: 'GLOBAL', type: 'Selector', all: ['Node Selection'] },
  'Node Selection': {
    name: 'Node Selection',
    type: 'Selector',
    all: ['HK-01', 'US-01', 'DIRECT', 'Nested Selector', 'Automatic'],
  },
  'Global Direct': {
    name: 'Global Direct',
    type: 'Selector',
    all: ['US-01', 'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE'],
  },
  'Automatic': { name: 'Automatic', type: 'URLTest', all: ['HK-01'] },
  'Nested Selector': { name: 'Nested Selector', type: 'Selector', all: ['HK-01'] },
  'HK-01': { name: 'HK-01', type: 'Shadowsocks' },
  'US-01': { name: 'US-01', type: 'Trojan' },
  DIRECT: { name: 'DIRECT', type: 'Direct' },
  REJECT: { name: 'REJECT', type: 'Reject' },
  'REJECT-DROP': { name: 'REJECT-DROP', type: 'RejectDrop' },
  PASS: { name: 'PASS', type: 'Pass' },
  COMPATIBLE: { name: 'COMPATIBLE', type: 'Compatible' },
};

test('collectDelayTestTargets deduplicates concrete selector candidates and skips routing actions and groups', () => {
  assert.deepEqual(collectDelayTestTargets(RECORDS), ['HK-01', 'US-01']);
});

test('runBoundedDelayTests limits concurrency and retains unavailable candidates', async () => {
  let active = 0;
  let peak = 0;
  const result = await runBoundedDelayTests(['HK-01', 'US-01', 'JP-01'], 2, async (name) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    if (name === 'US-01') throw new Error('timeout');
    return name === 'HK-01' ? 42 : 84;
  });

  assert.equal(peak, 2);
  assert.deepEqual([...result.entries()], [
    ['HK-01', { delayMs: 42, status: 'ready' }],
    ['US-01', { status: 'unavailable' }],
    ['JP-01', { delayMs: 84, status: 'ready' }],
  ]);
});

test('MihomoApi requests an encoded ten-second proxy delay measurement', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });

  let request;
  global.fetch = async (input, init) => {
    request = { input: String(input), init };
    return new Response(JSON.stringify({ delay: 42 }), { status: 200 });
  };

  const api = new MihomoApi(19090, 'main-process-only-secret');
  assert.equal(await api.getProxyDelay('HK / 01', 'http://cp.cloudflare.com/generate_204', 10_000), 42);
  assert.match(request.input, /\/proxies\/HK%20%2F%2001\/delay\?url=http%3A%2F%2Fcp\.cloudflare\.com%2Fgenerate_204&timeout=10000$/);
  assert.equal(request.init.headers.authorization, 'Bearer main-process-only-secret');
});

test('ProxyRuntime returns selector groups with only the current batch delay results', async () => {
  const runtime = new ProxyRuntime('/tmp/proxy-delay-test');
  runtime.runStatus = 'running';
  runtime.api = {
    getProxies: async () => RECORDS,
    getProxyDelay: async (name) => {
      if (name === 'US-01') throw new Error('timeout');
      return 33;
    },
  };

  const groups = await runtime.testProxyDelays();
  assert.deepEqual(groups.groups[0].options, [
    { name: 'HK-01', type: 'Shadowsocks', delayMs: 33, delayStatus: 'ready' },
    { name: 'US-01', type: 'Trojan', delayStatus: 'unavailable' },
    { name: 'DIRECT', type: 'Direct' },
    { name: 'Nested Selector', type: 'Selector' },
    { name: 'Automatic', type: 'URLTest' },
  ]);
});

test('ProxyRuntime returns fresh selector records after a delay test while retaining its delay overlay', async () => {
  const runtime = new ProxyRuntime('/tmp/proxy-delay-test');
  runtime.runStatus = 'running';
  let selected = 'HK-01';
  let releaseDelays;
  let notifyDelaysStarted;
  const delaysStarted = new Promise((resolve) => {
    notifyDelaysStarted = resolve;
  });
  let startedDelays = 0;
  const recordsFor = (now) => ({
    Selector: { name: 'Selector', type: 'Selector', now, all: ['HK-01', 'US-01'] },
    'HK-01': { name: 'HK-01', type: 'Shadowsocks' },
    'US-01': { name: 'US-01', type: 'Trojan' },
  });
  const waitForDelays = new Promise((resolve) => {
    releaseDelays = resolve;
  });
  runtime.api = {
    getProxies: async () => recordsFor(selected),
    getProxyDelay: async () => {
      startedDelays += 1;
      if (startedDelays === 2) {
        notifyDelaysStarted();
      }
      await waitForDelays;
      return 47;
    },
  };

  const testPromise = runtime.testProxyDelays();
  await delaysStarted;
  selected = 'US-01';
  releaseDelays();

  const groups = await testPromise;
  assert.equal(groups.groups[0].now, 'US-01');
  assert.deepEqual(groups.groups[0].options, [
    { name: 'HK-01', type: 'Shadowsocks', delayMs: 47, delayStatus: 'ready' },
    { name: 'US-01', type: 'Trojan', delayMs: 47, delayStatus: 'ready' },
  ]);
});

test('clearing delay results for a subscription replacement prevents an in-flight batch from restoring them', async () => {
  const runtime = new ProxyRuntime('/tmp/proxy-delay-test');
  runtime.runStatus = 'running';
  let resolveDelay;
  let notifyDelayStarted;
  const delayStarted = new Promise((resolve) => {
    notifyDelayStarted = resolve;
  });
  runtime.api = {
    getProxies: async () => ({
      Selector: { name: 'Selector', type: 'Selector', all: ['HK-01'] },
      'HK-01': { name: 'HK-01', type: 'Shadowsocks' },
    }),
    getProxyDelay: async () =>
      new Promise((release) => {
        resolveDelay = release;
        notifyDelayStarted();
      }),
  };

  const testPromise = runtime.testProxyDelays();
  await delayStarted;
  runtime.clearDelayResults();
  resolveDelay(31);

  await assert.rejects(testPromise, /superseded/);
  assert.deepEqual([...runtime.delayResults.entries()], []);
});

test('a newer node delay batch retains its results after an older batch completes', async () => {
  const runtime = new ProxyRuntime('/tmp/proxy-delay-test');
  runtime.runStatus = 'running';
  let batch = 'first';
  const firstResolvers = [];
  let firstStarted = 0;
  let resolveFirstStarted;
  const firstStartedPromise = new Promise((resolve) => {
    resolveFirstStarted = resolve;
  });
  runtime.api = {
    getProxies: async () => RECORDS,
    getProxyDelay: async () => {
      if (batch === 'second') {
        return 77;
      }
      return new Promise((resolve) => {
        firstResolvers.push(resolve);
        firstStarted += 1;
        if (firstStarted === 2) {
          resolveFirstStarted();
        }
      });
    },
  };

  const firstBatch = runtime.testProxyDelays();
  await firstStartedPromise;
  batch = 'second';
  const secondGroups = await runtime.testProxyDelays();
  firstResolvers.forEach((resolve) => resolve(19));

  await assert.rejects(firstBatch, /superseded/);
  assert.deepEqual(secondGroups.groups[0].options.slice(0, 2), [
    { name: 'HK-01', type: 'Shadowsocks', delayMs: 77, delayStatus: 'ready' },
    { name: 'US-01', type: 'Trojan', delayMs: 77, delayStatus: 'ready' },
  ]);
  assert.deepEqual([...runtime.delayResults.entries()], [
    ['HK-01', { delayMs: 77, status: 'ready' }],
    ['US-01', { delayMs: 77, status: 'ready' }],
  ]);
});
