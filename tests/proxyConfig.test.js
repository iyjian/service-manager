const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { promises: fs } = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  parseSubscription,
  buildRuntimeConfig,
  dumpRuntimeConfig,
  PROXY_GROUP_MAIN,
} = require('../dist/main/proxy/configBuilder.js');
const {
  serializeSubscriptionCache,
  parseSubscriptionCache,
} = require('../dist/main/proxy/subscriptionCache.js');
const { selectCoreAsset, coreArch, corePlatform, coreBinaryName } = require('../dist/main/proxy/coreManager.js');
const { ProxyRuntime } = require('../dist/main/proxy/proxyRuntime.js');

let proxyExceptions = {};
try {
  proxyExceptions = require('../dist/main/proxy/proxyExceptions.js');
} catch {
  // The RED test run intentionally starts before the exception module exists.
}

function getProxyCustomRules() {
  assert.equal(typeof proxyExceptions.normalizeProxyCustomRules, 'function');
  assert.equal(typeof proxyExceptions.buildCustomRuleRules, 'function');
  return proxyExceptions;
}

// Minimal subscription with no groups/rules — triggers the synthesized policy.
const SAMPLE_SUBSCRIPTION = `
proxies:
  - { name: "HK-01", type: ss, server: hk.example.com, port: 443, cipher: aes-128-gcm, password: x }
  - { name: "US-01", type: ss, server: us.example.com, port: 443, cipher: aes-128-gcm, password: y }
`;

// Full subscription with its own groups + rules (like a real provider).
const FULL_SUBSCRIPTION = `
mixed-port: 7890
allow-lan: true
mode: rule
proxies:
  - { name: "HK-01", type: ss, server: hk.example.com, port: 443, cipher: aes-128-gcm, password: x }
  - { name: "US-01", type: ss, server: us.example.com, port: 443, cipher: aes-128-gcm, password: y }
proxy-groups:
  - { name: "🚀 节点选择", type: select, proxies: ["HK-01", "US-01", DIRECT] }
  - { name: "🎯 全球直连", type: select, proxies: [DIRECT, "🚀 节点选择"] }
  - { name: "🐟 漏网之鱼", type: select, proxies: ["🚀 节点选择", DIRECT] }
rules:
  - DOMAIN-SUFFIX,tracker.example.com,REJECT
  - GEOIP,CN,🎯 全球直连
  - MATCH,🐟 漏网之鱼
`;

const AUTOMATIC_GROUPS_ONLY_SUBSCRIPTION = `
proxies:
  - { name: "HK-01", type: ss, server: hk.example.com, port: 443, cipher: aes-128-gcm, password: x }
proxy-groups:
  - { name: "自动选择", type: url-test, proxies: ["HK-01"], url: "https://www.gstatic.com/generate_204" }
rules:
  - MATCH,自动选择
`;

const BASE_SETTINGS = {
  mode: 'rule',
  mixedPort: 7890,
  tunEnabled: false,
  systemProxyEnabled: false,
};

test('normalizeProxyCustomRules normalizes every supported match type with a DIRECT legacy default', () => {
  const { normalizeProxyCustomRules } = getProxyCustomRules();
  const rules = normalizeProxyCustomRules([
    { type: 'DOMAIN', value: ' example.com ' },
    { type: 'DOMAIN-SUFFIX', value: ' example.org ' },
    { type: 'DOMAIN-KEYWORD', value: ' internal ' },
    { type: 'IP-CIDR', value: ' 192.0.2.0/24 ' },
    { type: 'IP-CIDR6', value: ' 2001:db8::/32 ' },
    { type: 'SRC-IP-CIDR', value: ' 10.0.0.0/8 ' },
    { type: 'GEOIP', value: ' cn ' },
    { type: 'DST-PORT', value: ' 8000-8080 ' },
    { type: 'SRC-PORT', value: ' 53 ' },
  ]);

  assert.equal(rules.length, 9);
  assert.ok(rules.every((rule) => typeof rule.id === 'string' && rule.id.length > 0));
  assert.deepEqual(
    rules.map(({ id, ...rule }) => rule),
    [
      { type: 'DOMAIN', value: 'example.com', target: 'DIRECT' },
      { type: 'DOMAIN-SUFFIX', value: 'example.org', target: 'DIRECT' },
      { type: 'DOMAIN-KEYWORD', value: 'internal', target: 'DIRECT' },
      { type: 'IP-CIDR', value: '192.0.2.0/24', target: 'DIRECT' },
      { type: 'IP-CIDR6', value: '2001:db8::/32', target: 'DIRECT' },
      { type: 'SRC-IP-CIDR', value: '10.0.0.0/8', target: 'DIRECT' },
      { type: 'GEOIP', value: 'CN', target: 'DIRECT' },
      { type: 'DST-PORT', value: '8000-8080', target: 'DIRECT' },
      { type: 'SRC-PORT', value: '53', target: 'DIRECT' },
    ]
  );
});

test('normalizeProxyCustomRules accepts PROXY and rejects malformed targets and values', () => {
  const { normalizeProxyCustomRules } = getProxyCustomRules();

  assert.deepEqual(
    normalizeProxyCustomRules([{ id: 'proxy-rule', type: 'DOMAIN', value: ' example.com ', target: 'PROXY' }]),
    [{ id: 'proxy-rule', type: 'DOMAIN', value: 'example.com', target: 'PROXY' }]
  );
  assert.throws(
    () => normalizeProxyCustomRules([{ type: 'DOMAIN', value: 'example.com', target: 'REJECT' }]),
    /target/
  );

  assert.throws(
    () => normalizeProxyCustomRules([{ type: 'IP-CIDR', value: '192.0.2.1/33' }]),
    /IPv4 CIDR/
  );
  assert.throws(
    () => normalizeProxyCustomRules([{ type: 'DST-PORT', value: '65536' }]),
    /port/
  );
});

test('normalizeProxyCustomRules rejects commas and newlines before trimming values', () => {
  const { normalizeProxyCustomRules } = getProxyCustomRules();

  assert.throws(
    () => normalizeProxyCustomRules([{ type: 'DOMAIN', value: 'example.com\n' }]),
    /commas or newlines/
  );
  assert.throws(
    () => normalizeProxyCustomRules([{ type: 'DOMAIN', value: 'example,com' }]),
    /commas or newlines/
  );
});

test('buildCustomRuleRules resolves PROXY and DIRECT targets', () => {
  const { normalizeProxyCustomRules, buildCustomRuleRules } = getProxyCustomRules();
  const rules = normalizeProxyCustomRules([
    { type: 'DOMAIN-SUFFIX', value: ' example.com ', target: 'PROXY' },
    { type: 'DOMAIN', value: ' direct.example ', target: 'DIRECT' },
  ]);

  assert.deepEqual(buildCustomRuleRules(rules, '🚀 节点选择'), [
    'DOMAIN-SUFFIX,example.com,🚀 节点选择',
    'DOMAIN,direct.example,DIRECT',
  ]);
});

test('buildRuntimeConfig prepends Custom Rules before subscription rules', () => {
  const { normalizeProxyCustomRules } = getProxyCustomRules();
  const subscription = parseSubscription(FULL_SUBSCRIPTION);
  const config = buildRuntimeConfig(
    {
      ...BASE_SETTINGS,
      customRules: normalizeProxyCustomRules([
        { type: 'DOMAIN-SUFFIX', value: ' example.com ', target: 'PROXY' },
        { type: 'DOMAIN', value: ' direct.example ', target: 'DIRECT' },
      ]),
    },
    subscription,
    { controllerPort: 9123, secret: 'abc' }
  );

  const firstSubscriptionRule = config.rules.indexOf('DOMAIN-SUFFIX,tracker.example.com,REJECT');
  assert.ok(firstSubscriptionRule > 0);
  assert.deepEqual(config.rules.slice(0, 2), [
    'DOMAIN-SUFFIX,example.com,🚀 节点选择',
    'DOMAIN,direct.example,DIRECT',
  ]);
});

test('buildRuntimeConfig skips malformed persisted Custom Rules while retaining valid precedence', () => {
  const subscription = parseSubscription(FULL_SUBSCRIPTION);
  const config = buildRuntimeConfig(
    {
      ...BASE_SETTINGS,
      customRules: [
        { id: 'valid', type: 'DOMAIN-SUFFIX', value: 'example.com', target: 'DIRECT' },
        { id: 'wrong-family', type: 'IP-CIDR', value: '2001:db8::/32' },
        { id: 'injected', type: 'DOMAIN', value: 'example,com' },
        null,
      ],
    },
    subscription,
    { controllerPort: 9123, secret: 'abc' }
  );

  const firstSubscriptionRule = config.rules.indexOf('DOMAIN-SUFFIX,tracker.example.com,REJECT');
  assert.ok(firstSubscriptionRule > 0);
  assert.equal(config.rules[0], 'DOMAIN-SUFFIX,example.com,DIRECT');
  assert.equal(config.rules.length, 4);
});

test('buildRuntimeConfig omits PROXY Custom Rules without a selectable proxy group', () => {
  const subscription = parseSubscription(AUTOMATIC_GROUPS_ONLY_SUBSCRIPTION);
  const config = buildRuntimeConfig(
    {
      ...BASE_SETTINGS,
      customRules: [{ id: 'proxy-only', type: 'DOMAIN-SUFFIX', value: 'example.com', target: 'PROXY' }],
    },
    subscription,
    { controllerPort: 9123, secret: 'abc' }
  );

  assert.deepEqual(config.rules, ['MATCH,自动选择']);
});

test('parseSubscription extracts proxies from Clash YAML', () => {
  const info = parseSubscription(SAMPLE_SUBSCRIPTION);
  assert.equal(info.proxies.length, 2);
  assert.equal(info.proxies[0].name, 'HK-01');
});

test('parseSubscription supports base64-encoded Clash YAML', () => {
  const encoded = Buffer.from(SAMPLE_SUBSCRIPTION, 'utf8').toString('base64');
  const info = parseSubscription(encoded);
  assert.equal(info.proxies.length, 2);
});

test('parseSubscription rejects payloads without a proxies list', () => {
  assert.throws(() => parseSubscription('rules:\n  - MATCH,DIRECT\n'), /proxies/);
  assert.throws(() => parseSubscription('proxies: []\n'), /no usable proxy nodes/);
});

test('subscription cache round-trips a parsed subscription', () => {
  const subscription = parseSubscription(FULL_SUBSCRIPTION);
  const cache = serializeSubscriptionCache(subscription);

  assert.deepEqual(parseSubscriptionCache(cache), subscription);
});

test('subscription cache rejects an empty object', () => {
  assert.throws(() => parseSubscriptionCache('{}'));
});

test('subscription cache rejects an unsupported version', () => {
  assert.throws(() => parseSubscriptionCache(JSON.stringify({ version: 2, subscription: {} })));
});

test('subscription cache rejects malformed version-1 subscription fields', () => {
  assert.throws(() =>
    parseSubscriptionCache(
      JSON.stringify({
        version: 1,
        subscription: { base: {}, proxies: [{ name: 'HK-01' }], synthesized: true },
      })
    )
  );
  assert.throws(() =>
    parseSubscriptionCache(
      JSON.stringify({
        version: 1,
        subscription: { base: { proxies: [{ name: 'HK-01' }] }, proxies: [{}], synthesized: true },
      })
    )
  );
  assert.throws(() =>
    parseSubscriptionCache(
      JSON.stringify({
        version: 1,
        subscription: { base: { proxies: [{ name: 'HK-01' }] }, proxies: [{ name: 'HK-01' }], synthesized: 'true' },
      })
    )
  );
  assert.throws(() =>
    parseSubscriptionCache(
      JSON.stringify({
        version: 1,
        subscription: {
          base: { proxies: [{ name: 'HK-01' }] },
          proxies: [{ name: 'HK-01' }],
          synthesized: true,
          primaryGroup: 1,
        },
      })
    )
  );
});

test('loadCachedSubscription rebuilds an invalid parsed cache from raw YAML', async (t) => {
  const proxyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'service-manager-proxy-cache-'));
  t.after(() => fs.rm(proxyDir, { recursive: true, force: true }));
  await Promise.all([
    fs.writeFile(
      path.join(proxyDir, 'subscription.parsed.json'),
      JSON.stringify({ version: 1, subscription: { base: {}, proxies: [{}], synthesized: true } }),
      'utf8'
    ),
    fs.writeFile(path.join(proxyDir, 'subscription.yaml'), SAMPLE_SUBSCRIPTION, 'utf8'),
  ]);

  const runtime = new ProxyRuntime(proxyDir);
  const subscription = await runtime.loadCachedSubscription();

  assert.equal(subscription.proxies[0].name, 'HK-01');
  assert.equal(parseSubscriptionCache(await fs.readFile(path.join(proxyDir, 'subscription.parsed.json'), 'utf8')).proxies.length, 2);
});

test('ProxyRuntime init removes a malformed legacy exceptions value from its state snapshot', async (t) => {
  const proxyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'service-manager-proxy-settings-'));
  t.after(() => fs.rm(proxyDir, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(proxyDir, 'proxy-config.json'),
    JSON.stringify({ ...BASE_SETTINGS, exceptions: { type: 'DOMAIN-SUFFIX', value: 'example.com' } }),
    'utf8'
  );

  const runtime = new ProxyRuntime(proxyDir);
  await runtime.init();
  const state = await runtime.getState();

  assert.equal('exceptions' in state.settings, false);
  assert.deepEqual(state.settings.customRules, []);
  const config = buildRuntimeConfig(state.settings, parseSubscription(FULL_SUBSCRIPTION), {
    controllerPort: 9123,
    secret: 'abc',
  });
  assert.equal(config.rules[0], 'DOMAIN-SUFFIX,tracker.example.com,REJECT');
});

test('ProxyRuntime init drops a legacy subscription URL and removes it after the next persisted mutation', async (t) => {
  const proxyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'service-manager-proxy-settings-'));
  t.after(() => fs.rm(proxyDir, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(proxyDir, 'proxy-config.json'),
    JSON.stringify({
      ...BASE_SETTINGS,
      subscriptionUrl: 'https://subscription.example.test/legacy',
    }),
    'utf8'
  );

  const runtime = new ProxyRuntime(proxyDir);
  await runtime.init();
  assert.equal('subscriptionUrl' in (await runtime.getState()).settings, false);

  await runtime.setMode('global');
  const persisted = JSON.parse(await fs.readFile(path.join(proxyDir, 'proxy-config.json'), 'utf8'));
  assert.equal('subscriptionUrl' in persisted, false);
  assert.equal(persisted.mode, 'global');
});

test('ProxyRuntime sanitizes persisted startup intent', async (t) => {
  const proxyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'service-manager-proxy-start-intent-'));
  t.after(() => fs.rm(proxyDir, { recursive: true, force: true }));

  const runtimeWithoutSetting = new ProxyRuntime(path.join(proxyDir, 'missing'));
  await runtimeWithoutSetting.init();
  assert.equal((await runtimeWithoutSetting.getState()).settings.startOnLaunch, false);

  const malformedDir = path.join(proxyDir, 'malformed');
  await fs.mkdir(malformedDir, { recursive: true });
  await fs.writeFile(
    path.join(malformedDir, 'proxy-config.json'),
    JSON.stringify({ ...BASE_SETTINGS, startOnLaunch: 'yes' }),
    'utf8'
  );
  const runtimeWithMalformedSetting = new ProxyRuntime(malformedDir);
  await runtimeWithMalformedSetting.init();
  assert.equal((await runtimeWithMalformedSetting.getState()).settings.startOnLaunch, false);

  const enabledDir = path.join(proxyDir, 'enabled');
  await fs.mkdir(enabledDir, { recursive: true });
  await fs.writeFile(
    path.join(enabledDir, 'proxy-config.json'),
    JSON.stringify({ ...BASE_SETTINGS, startOnLaunch: true }),
    'utf8'
  );
  const runtimeWithEnabledSetting = new ProxyRuntime(enabledDir);
  await runtimeWithEnabledSetting.init();
  assert.equal((await runtimeWithEnabledSetting.getState()).settings.startOnLaunch, true);
});

test('ProxyRuntime Stop clears enabled startup intent even when already stopped', async (t) => {
  const proxyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'service-manager-proxy-stop-intent-'));
  t.after(() => fs.rm(proxyDir, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(proxyDir, 'proxy-config.json'),
    JSON.stringify({ ...BASE_SETTINGS, startOnLaunch: true }),
    'utf8'
  );

  const runtime = new ProxyRuntime(proxyDir);
  await runtime.init();
  const state = await runtime.stop();

  assert.equal(state.running, 'stopped');
  assert.equal(state.settings.startOnLaunch, false);
  assert.equal(
    JSON.parse(await fs.readFile(path.join(proxyDir, 'proxy-config.json'), 'utf8')).startOnLaunch,
    false
  );
});

test('ProxyRuntime shutdown preserves enabled startup intent', async (t) => {
  const proxyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'service-manager-proxy-shutdown-intent-'));
  t.after(() => fs.rm(proxyDir, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(proxyDir, 'proxy-config.json'),
    JSON.stringify({ ...BASE_SETTINGS, startOnLaunch: true }),
    'utf8'
  );

  const runtime = new ProxyRuntime(proxyDir);
  await runtime.init();
  await runtime.shutdown();

  assert.equal((await runtime.getState()).settings.startOnLaunch, true);
  assert.equal(
    JSON.parse(await fs.readFile(path.join(proxyDir, 'proxy-config.json'), 'utf8')).startOnLaunch,
    true
  );
});

test('ProxyRuntime restores startup intent in memory when Stop persistence fails', async (t) => {
  const proxyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'service-manager-proxy-stop-rollback-'));
  t.after(() => fs.rm(proxyDir, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(proxyDir, 'proxy-config.json'),
    JSON.stringify({ ...BASE_SETTINGS, startOnLaunch: true }),
    'utf8'
  );

  const runtime = new ProxyRuntime(proxyDir);
  await runtime.init();
  runtime.persistSettings = async () => {
    throw new Error('injected intent persistence failure');
  };

  await assert.rejects(runtime.stop(), /injected intent persistence failure/);
  assert.equal((await runtime.getState()).settings.startOnLaunch, true);
});

test('ProxyRuntime persists enabled startup intent transactionally', async (t) => {
  const proxyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'service-manager-proxy-enable-intent-'));
  t.after(() => fs.rm(proxyDir, { recursive: true, force: true }));

  const runtime = new ProxyRuntime(proxyDir);
  await runtime.init();
  await runtime.setStartOnLaunch(true);
  assert.equal((await runtime.getState()).settings.startOnLaunch, true);
  assert.equal(
    JSON.parse(await fs.readFile(path.join(proxyDir, 'proxy-config.json'), 'utf8')).startOnLaunch,
    true
  );

  await runtime.setStartOnLaunch(false);
  runtime.persistSettings = async () => {
    throw new Error('injected enable persistence failure');
  };
  await assert.rejects(runtime.setStartOnLaunch(true), /injected enable persistence failure/);
  assert.equal((await runtime.getState()).settings.startOnLaunch, false);
});

test('ProxyRuntime restoreRunningIntent delegates only when enabled', async (t) => {
  const proxyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'service-manager-proxy-restore-intent-'));
  t.after(() => fs.rm(proxyDir, { recursive: true, force: true }));

  const disabled = new ProxyRuntime(path.join(proxyDir, 'disabled'));
  await disabled.init();
  let disabledStarts = 0;
  disabled.start = async () => {
    disabledStarts += 1;
    return disabled.getState();
  };
  await disabled.restoreRunningIntent();
  assert.equal(disabledStarts, 0);

  const enabledDir = path.join(proxyDir, 'enabled');
  await fs.mkdir(enabledDir, { recursive: true });
  await fs.writeFile(
    path.join(enabledDir, 'proxy-config.json'),
    JSON.stringify({ ...BASE_SETTINGS, startOnLaunch: true }),
    'utf8'
  );
  const enabled = new ProxyRuntime(enabledDir);
  await enabled.init();
  let enabledStarts = 0;
  enabled.start = async () => {
    enabledStarts += 1;
    return enabled.getState();
  };
  await enabled.restoreRunningIntent();
  assert.equal(enabledStarts, 1);
});

test('ProxyRuntime serializes a later explicit Stop behind an in-flight Start', async (t) => {
  const proxyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'service-manager-proxy-start-stop-order-'));
  t.after(() => fs.rm(proxyDir, { recursive: true, force: true }));
  const runtime = new ProxyRuntime(proxyDir);
  await runtime.init();

  const events = [];
  let releaseStart;
  const startGate = new Promise((resolve) => {
    releaseStart = resolve;
  });
  runtime.startNow = async () => {
    events.push('start:begin');
    await startGate;
    await runtime.setStartOnLaunch(true);
    events.push('start:end');
    return runtime.getState();
  };
  runtime.stopNow = async () => {
    events.push('stop');
    await runtime.setStartOnLaunch(false);
    return runtime.getState();
  };

  const startPromise = runtime.start();
  startPromise.catch(() => undefined);
  await new Promise((resolve) => setImmediate(resolve));
  const stopPromise = runtime.stop();
  stopPromise.catch(() => undefined);
  await new Promise((resolve) => setImmediate(resolve));
  const beforeRelease = [...events];
  releaseStart();
  const results = await Promise.allSettled([startPromise, stopPromise]);

  assert.deepEqual(beforeRelease, ['start:begin']);
  assert.ok(results.every((result) => result.status === 'fulfilled'));
  assert.deepEqual(events, ['start:begin', 'start:end', 'stop']);
  assert.equal((await runtime.getState()).settings.startOnLaunch, false);
});

test('ProxyRuntime serializes shutdown behind an in-flight Start', async (t) => {
  const proxyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'service-manager-proxy-start-shutdown-order-'));
  t.after(() => fs.rm(proxyDir, { recursive: true, force: true }));
  const runtime = new ProxyRuntime(proxyDir);
  await runtime.init();

  const events = [];
  let releaseStart;
  const startGate = new Promise((resolve) => {
    releaseStart = resolve;
  });
  runtime.startNow = async () => {
    events.push('start:begin');
    await startGate;
    events.push('start:end');
    return runtime.getState();
  };
  runtime.shutdownNow = async () => {
    events.push('shutdown');
  };

  const startPromise = runtime.start();
  startPromise.catch(() => undefined);
  await new Promise((resolve) => setImmediate(resolve));
  const shutdownPromise = runtime.shutdown();
  shutdownPromise.catch(() => undefined);
  await new Promise((resolve) => setImmediate(resolve));
  const beforeRelease = [...events];
  releaseStart();
  const results = await Promise.allSettled([startPromise, shutdownPromise]);

  assert.deepEqual(beforeRelease, ['start:begin']);
  assert.ok(results.every((result) => result.status === 'fulfilled'));
  assert.deepEqual(events, ['start:begin', 'start:end', 'shutdown']);
});

test('ProxyRuntime serializes settings file writes in invocation order', async (t) => {
  const proxyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'service-manager-proxy-settings-write-order-'));
  t.after(() => fs.rm(proxyDir, { recursive: true, force: true }));
  const runtime = new ProxyRuntime(proxyDir);
  await runtime.init();

  const events = [];
  let call = 0;
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  runtime.persistSettingsNow = async () => {
    call += 1;
    const current = call;
    events.push(`${current}:begin`);
    if (current === 1) await firstGate;
    events.push(`${current}:end`);
  };

  const first = runtime.persistSettings();
  first.catch(() => undefined);
  await new Promise((resolve) => setImmediate(resolve));
  const second = runtime.persistSettings();
  second.catch(() => undefined);
  await new Promise((resolve) => setImmediate(resolve));
  const beforeRelease = [...events];
  releaseFirst();
  await Promise.all([first, second]);

  assert.deepEqual(beforeRelease, ['1:begin']);
  assert.deepEqual(events, ['1:begin', '1:end', '2:begin', '2:end']);
});

test('ProxyRuntime keeps a later Stop authoritative over a pending settings restart', async (t) => {
  const proxyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'service-manager-proxy-setting-stop-order-'));
  t.after(() => fs.rm(proxyDir, { recursive: true, force: true }));
  const runtime = new ProxyRuntime(proxyDir);
  await runtime.init();
  runtime.runStatus = 'running';
  runtime.settings.startOnLaunch = true;
  runtime.systemProxyActive = true;

  const writeEvents = [];
  let writes = 0;
  let releaseFirstWrite;
  const firstWriteGate = new Promise((resolve) => {
    releaseFirstWrite = resolve;
  });
  runtime.persistSettingsNow = async () => {
    writes += 1;
    const current = writes;
    writeEvents.push(`${current}:begin`);
    if (current === 1) await firstWriteGate;
    writeEvents.push(`${current}:end`);
  };
  let starts = 0;
  let systemProxyActivations = 0;
  runtime.startNow = async () => {
    starts += 1;
    return runtime.getState();
  };
  runtime.deactivateSystemProxyIfNeeded = async () => {
    runtime.systemProxyActive = false;
  };
  runtime.activateSystemProxy = async () => {
    systemProxyActivations += 1;
    runtime.systemProxyActive = true;
  };

  const portPromise = runtime.setMixedPort(7891);
  portPromise.catch(() => undefined);
  for (let attempt = 0; attempt < 20 && writeEvents.length === 0; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(writeEvents, ['1:begin']);
  const stopPromise = runtime.stop();
  stopPromise.catch(() => undefined);
  await new Promise((resolve) => setImmediate(resolve));
  releaseFirstWrite();
  await Promise.all([portPromise, stopPromise]);

  const state = await runtime.getState();
  assert.equal(starts, 0);
  assert.equal(systemProxyActivations, 0);
  assert.equal(runtime.systemProxyActive, false);
  assert.equal(state.running, 'stopped');
  assert.equal(state.settings.startOnLaunch, false);
});

test('ProxyRuntime reports missing core as Proxy error state', async (t) => {
  const proxyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'service-manager-proxy-missing-core-state-'));
  t.after(() => fs.rm(proxyDir, { recursive: true, force: true }));
  const runtime = new ProxyRuntime(proxyDir);
  await runtime.init();

  await assert.rejects(runtime.start(), /mihomo core is not installed/);
  const state = await runtime.getState();
  assert.equal(state.running, 'error');
  assert.match(state.error, /mihomo core is not installed/);
  assert.equal(state.settings.startOnLaunch, false);
});

test('ProxyRuntime accepts an injected child-process spawn implementation', async (t) => {
  const proxyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'service-manager-proxy-spawn-seam-'));
  t.after(() => fs.rm(proxyDir, { recursive: true, force: true }));
  const spawnProcess = () => {
    throw new Error('not called');
  };
  const getControllerPort = async () => 9123;

  const runtime = new ProxyRuntime(proxyDir, spawnProcess, getControllerPort);

  assert.equal(runtime.spawnProcess, spawnProcess);
  assert.equal(runtime.getControllerPort, getControllerPort);
});

test('ProxyRuntime reports child spawn errors through Proxy error state', async (t) => {
  const proxyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'service-manager-proxy-spawn-error-'));
  t.after(() => fs.rm(proxyDir, { recursive: true, force: true }));
  const child = new EventEmitter();
  child.stdout = null;
  child.stderr = null;
  child.kill = () => true;
  const runtime = new ProxyRuntime(proxyDir, () => child, async () => 9123);
  await runtime.init();
  runtime.coreManager.getInstalledInfo = async () => ({ binaryPath: '/missing/mihomo', version: 'test' });
  runtime.loadCachedSubscription = async () => parseSubscription(SAMPLE_SUBSCRIPTION);
  runtime.waitForController = async () => new Promise(() => undefined);

  const startPromise = runtime.start();
  const rejection = assert.rejects(startPromise, /injected spawn failure/);
  for (let attempt = 0; attempt < 20 && child.listenerCount('error') === 0; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(child.listenerCount('error') > 0);
  child.emit('error', new Error('injected spawn failure'));
  await rejection;

  const state = await runtime.getState();
  assert.equal(state.running, 'error');
  assert.match(state.error, /injected spawn failure/);
  assert.equal(state.settings.startOnLaunch, false);
});

test('ProxyRuntime successful public Start persists enabled intent', async (t) => {
  const proxyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'service-manager-proxy-public-start-'));
  t.after(() => fs.rm(proxyDir, { recursive: true, force: true }));
  const child = new EventEmitter();
  child.pid = 12345;
  child.stdout = null;
  child.stderr = null;
  child.kill = () => {
    queueMicrotask(() => child.emit('exit', 0));
    return true;
  };
  const runtime = new ProxyRuntime(proxyDir, () => child, async () => 9123);
  await runtime.init();
  runtime.coreManager.getInstalledInfo = async () => ({ binaryPath: '/fake/mihomo', version: 'test' });
  runtime.loadCachedSubscription = async () => parseSubscription(SAMPLE_SUBSCRIPTION);
  runtime.waitForController = async () => undefined;
  runtime.applySelectionsQuietly = async () => undefined;

  const state = await runtime.start();

  assert.equal(state.running, 'running');
  assert.equal(state.settings.startOnLaunch, true);
  assert.equal(
    JSON.parse(await fs.readFile(path.join(proxyDir, 'proxy-config.json'), 'utf8')).startOnLaunch,
    true
  );
  await runtime.shutdown();
});

test('ProxyRuntime tears down a successful child when enabling intent cannot persist', async (t) => {
  const proxyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'service-manager-proxy-start-persist-failure-'));
  t.after(() => fs.rm(proxyDir, { recursive: true, force: true }));
  const child = new EventEmitter();
  child.stdout = null;
  child.stderr = null;
  let killed = false;
  child.kill = () => {
    killed = true;
    queueMicrotask(() => child.emit('exit', 0));
    return true;
  };
  const runtime = new ProxyRuntime(proxyDir, () => child, async () => 9123);
  await runtime.init();
  runtime.coreManager.getInstalledInfo = async () => ({ binaryPath: '/fake/mihomo', version: 'test' });
  runtime.loadCachedSubscription = async () => parseSubscription(SAMPLE_SUBSCRIPTION);
  runtime.waitForController = async () => undefined;
  runtime.applySelectionsQuietly = async () => undefined;
  runtime.persistSettings = async () => {
    throw new Error('injected start intent persistence failure');
  };

  await assert.rejects(runtime.start(), /injected start intent persistence failure/);

  const state = await runtime.getState();
  assert.equal(killed, true);
  assert.equal(state.running, 'error');
  assert.equal(state.settings.startOnLaunch, false);
});

test('ProxyRuntime migrates legacy exceptions to Custom Rules and removes exceptions on the next settings write', async (t) => {
  const proxyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'service-manager-proxy-settings-'));
  t.after(() => fs.rm(proxyDir, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(proxyDir, 'proxy-config.json'),
    JSON.stringify({
      ...BASE_SETTINGS,
      exceptions: [
        // `exceptions` is the historical Direct Exceptions field. Even a manually
        // edited legacy record must not acquire the new PROXY behavior.
        { id: 'saved-valid', type: 'DOMAIN-SUFFIX', value: 'saved.example', target: 'PROXY' },
        null,
        { id: 'saved-invalid', type: 'IP-CIDR', value: '2001:db8::/32' },
      ],
    }),
    'utf8'
  );

  const runtime = new ProxyRuntime(proxyDir);
  await runtime.init();
  assert.deepEqual((await runtime.getState()).settings.customRules, [
    { id: 'saved-valid', type: 'DOMAIN-SUFFIX', value: 'saved.example', target: 'DIRECT' },
  ]);
  assert.equal('exceptions' in (await runtime.getState()).settings, false);

  await runtime.setMode('global');
  const migratedSettings = JSON.parse(await fs.readFile(path.join(proxyDir, 'proxy-config.json'), 'utf8'));
  assert.equal('exceptions' in migratedSettings, false);
  assert.deepEqual(migratedSettings.customRules, [
    { id: 'saved-valid', type: 'DOMAIN-SUFFIX', value: 'saved.example', target: 'DIRECT' },
  ]);

  const afterAdd = await runtime.addException({ type: 'DOMAIN', value: 'added.example', target: 'PROXY' });
  const added = afterAdd.settings.customRules.find((rule) => rule.value === 'added.example');
  assert.ok(added);
  assert.equal(added.target, 'PROXY');

  const afterUpdate = await runtime.updateException('saved-valid', {
    type: 'DOMAIN-SUFFIX',
    value: 'updated.example',
  });
  assert.equal(afterUpdate.settings.customRules.find((rule) => rule.id === 'saved-valid').value, 'updated.example');

  const afterDelete = await runtime.deleteException(added.id);
  assert.deepEqual(afterDelete.settings.customRules, [
    { id: 'saved-valid', type: 'DOMAIN-SUFFIX', value: 'updated.example', target: 'DIRECT' },
  ]);
  const persisted = JSON.parse(await fs.readFile(path.join(proxyDir, 'proxy-config.json'), 'utf8'));
  assert.equal('exceptions' in persisted, false);
  assert.deepEqual(persisted.customRules, [
    { id: 'saved-valid', type: 'DOMAIN-SUFFIX', value: 'updated.example', target: 'DIRECT' },
  ]);

  const config = buildRuntimeConfig(afterDelete.settings, parseSubscription(FULL_SUBSCRIPTION), {
    controllerPort: 9123,
    secret: 'abc',
  });
  assert.equal(config.rules[0], 'DOMAIN-SUFFIX,updated.example,DIRECT');
  assert.equal(config.rules[1], 'DOMAIN-SUFFIX,tracker.example.com,REJECT');
});

test('ProxyRuntime rejects System Proxy activation before Mihomo has started with setup guidance', async (t) => {
  const proxyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'service-manager-proxy-system-proxy-'));
  t.after(() => fs.rm(proxyDir, { recursive: true, force: true }));

  const runtime = new ProxyRuntime(proxyDir);
  await runtime.init();

  await assert.rejects(
    runtime.setSystemProxy(true),
    (error) => {
      assert.equal(error.message, 'Start the proxy first. When its status is running, enable System Proxy.');
      return true;
    }
  );
});

test('saveAndFetchSubscription caches a fetched subscription without persisting its URL or restarting Mihomo', async (t) => {
  const proxyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'service-manager-proxy-fetch-'));
  const originalFetch = globalThis.fetch;
  t.after(async () => {
    globalThis.fetch = originalFetch;
    await fs.rm(proxyDir, { recursive: true, force: true });
  });
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => SAMPLE_SUBSCRIPTION });

  const runtime = new ProxyRuntime(proxyDir);
  runtime.restart = async () => {
    throw new Error('Save & Fetch must not restart Mihomo.');
  };
  runtime.runStatus = 'running';

  const state = await runtime.saveAndFetchSubscription(' https://subscription.example.test/config ');
  const persistedSettings = JSON.parse(await fs.readFile(path.join(proxyDir, 'proxy-config.json'), 'utf8'));

  assert.equal(state.settings.proxyCount, 2);
  assert.equal(typeof state.settings.subscriptionUpdatedAt, 'string');
  assert.equal('subscriptionUrl' in state.settings, false);
  assert.equal('subscriptionUrl' in persistedSettings, false);
  assert.equal(await fs.readFile(path.join(proxyDir, 'subscription.yaml'), 'utf8'), SAMPLE_SUBSCRIPTION);
  assert.equal(
    parseSubscriptionCache(await fs.readFile(path.join(proxyDir, 'subscription.parsed.json'), 'utf8')).proxies.length,
    2
  );
});

test('saveAndFetchSubscription preserves a concurrent explicit Stop intent', async (t) => {
  const proxyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'service-manager-proxy-fetch-stop-order-'));
  const originalFetch = globalThis.fetch;
  t.after(async () => {
    globalThis.fetch = originalFetch;
    await fs.rm(proxyDir, { recursive: true, force: true });
  });
  globalThis.fetch = async () => new Response(SAMPLE_SUBSCRIPTION, { status: 200 });

  const runtime = new ProxyRuntime(proxyDir);
  await runtime.init();
  runtime.runStatus = 'running';
  runtime.settings.startOnLaunch = true;

  let replacementStarted;
  const replacementStartedPromise = new Promise((resolve) => {
    replacementStarted = resolve;
  });
  let releaseReplacement;
  const replacementGate = new Promise((resolve) => {
    releaseReplacement = resolve;
  });
  runtime.replaceSubscriptionCaches = async () => {
    replacementStarted();
    await replacementGate;
  };

  const fetchPromise = runtime.saveAndFetchSubscription('https://subscription.example.test/config');
  fetchPromise.catch(() => undefined);
  await replacementStartedPromise;
  await runtime.stop();
  releaseReplacement();
  await fetchPromise;

  const state = await runtime.getState();
  const persistedSettings = JSON.parse(await fs.readFile(path.join(proxyDir, 'proxy-config.json'), 'utf8'));
  assert.equal(state.running, 'stopped');
  assert.equal(state.settings.startOnLaunch, false);
  assert.equal(persistedSettings.startOnLaunch, false);
  assert.equal(state.settings.proxyCount, 2);
});

test('saveAndFetchSubscription restores caches and settings metadata when settings persistence fails', async (t) => {
  const proxyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'service-manager-proxy-cache-'));
  const rawCachePath = path.join(proxyDir, 'subscription.yaml');
  const parsedCachePath = path.join(proxyDir, 'subscription.parsed.json');
  const previousRaw = SAMPLE_SUBSCRIPTION;
  const previousParsed = serializeSubscriptionCache(parseSubscription(previousRaw));
  const previousSettings = {
    ...BASE_SETTINGS,
    proxyCount: 1,
    subscriptionUpdatedAt: '2024-01-01T00:00:00.000Z',
  };
  const updatedRaw = SAMPLE_SUBSCRIPTION.replace('HK-01', 'JP-01');
  await Promise.all([
    fs.writeFile(rawCachePath, previousRaw, 'utf8'),
    fs.writeFile(parsedCachePath, previousParsed, 'utf8'),
    fs.writeFile(path.join(proxyDir, 'proxy-config.json'), JSON.stringify(previousSettings), 'utf8'),
  ]);

  const originalFetch = globalThis.fetch;
  t.after(async () => {
    globalThis.fetch = originalFetch;
    await fs.rm(proxyDir, { recursive: true, force: true });
  });
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => updatedRaw });

  const runtime = new ProxyRuntime(proxyDir);
  await runtime.init();
  const previousState = await runtime.getState();
  runtime.persistSettings = async () => {
    throw new Error('injected settings persistence failure');
  };

  await assert.rejects(
    runtime.saveAndFetchSubscription('https://subscription.example.test/config'),
    /injected settings persistence failure/
  );
  assert.equal(await fs.readFile(rawCachePath, 'utf8'), previousRaw);
  assert.equal(await fs.readFile(parsedCachePath, 'utf8'), previousParsed);
  assert.deepEqual(await runtime.getState(), previousState);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(proxyDir, 'proxy-config.json'), 'utf8')), previousSettings);
  assert.equal((await fs.readdir(proxyDir)).some((name) => name.endsWith('.tmp')), false);
});

test('saveAndFetchSubscription removes new cache files when settings persistence fails without prior caches', async (t) => {
  const proxyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'service-manager-proxy-cache-'));
  const originalFetch = globalThis.fetch;
  t.after(async () => {
    globalThis.fetch = originalFetch;
    await fs.rm(proxyDir, { recursive: true, force: true });
  });
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => SAMPLE_SUBSCRIPTION });

  const runtime = new ProxyRuntime(proxyDir);
  await runtime.init();
  const previousState = await runtime.getState();
  runtime.persistSettings = async () => {
    throw new Error('injected settings persistence failure');
  };

  await assert.rejects(
    runtime.saveAndFetchSubscription('https://subscription.example.test/config'),
    /injected settings persistence failure/
  );
  await assert.rejects(fs.readFile(path.join(proxyDir, 'subscription.yaml'), 'utf8'), { code: 'ENOENT' });
  await assert.rejects(
    fs.readFile(path.join(proxyDir, 'subscription.parsed.json'), 'utf8'),
    { code: 'ENOENT' }
  );
  assert.deepEqual(await runtime.getState(), previousState);
  assert.equal((await fs.readdir(proxyDir)).some((name) => name.endsWith('.tmp')), false);
});

test('saveAndFetchSubscription restores both caches when parsed-cache replacement fails', async (t) => {
  const proxyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'service-manager-proxy-cache-'));
  const rawCachePath = path.join(proxyDir, 'subscription.yaml');
  const parsedCachePath = path.join(proxyDir, 'subscription.parsed.json');
  const previousRaw = SAMPLE_SUBSCRIPTION;
  const previousParsed = serializeSubscriptionCache(parseSubscription(previousRaw));
  const updatedRaw = SAMPLE_SUBSCRIPTION.replace('HK-01', 'JP-01');
  await Promise.all([
    fs.writeFile(rawCachePath, previousRaw, 'utf8'),
    fs.writeFile(parsedCachePath, previousParsed, 'utf8'),
  ]);

  const originalRename = fs.rename;
  const originalFetch = globalThis.fetch;
  let parsedRenameFailed = false;
  fs.rename = async (source, destination) => {
    if (destination === parsedCachePath && !parsedRenameFailed) {
      parsedRenameFailed = true;
      throw new Error('injected parsed cache rename failure');
    }
    return originalRename(source, destination);
  };
  globalThis.fetch = async () => ({ ok: true, text: async () => updatedRaw });
  t.after(async () => {
    fs.rename = originalRename;
    globalThis.fetch = originalFetch;
    await fs.rm(proxyDir, { recursive: true, force: true });
  });

  const runtime = new ProxyRuntime(proxyDir);

  await assert.rejects(
    runtime.saveAndFetchSubscription('https://subscription.example.test/config'),
    /injected parsed cache rename failure/
  );
  assert.equal(await fs.readFile(rawCachePath, 'utf8'), previousRaw);
  assert.equal(await fs.readFile(parsedCachePath, 'utf8'), previousParsed);
  assert.equal((await runtime.loadCachedSubscription()).proxies[0].name, 'HK-01');
  assert.equal((await fs.readdir(proxyDir)).some((name) => name.endsWith('.tmp')), false);
});

test('buildRuntimeConfig injects mode, port and controller settings', () => {
  const subscription = parseSubscription(SAMPLE_SUBSCRIPTION);
  const config = buildRuntimeConfig(
    { ...BASE_SETTINGS, mode: 'global', mixedPort: 7999 },
    subscription,
    { controllerPort: 9123, secret: 'abc' }
  );

  assert.equal(config['mixed-port'], 7999);
  assert.equal(config.mode, 'global');
  assert.equal(config['external-controller'], '127.0.0.1:9123');
  assert.equal(config.secret, 'abc');
  assert.equal(config.tun, undefined);
});

test('buildRuntimeConfig synthesizes a group + rules when the subscription has none', () => {
  const subscription = parseSubscription(SAMPLE_SUBSCRIPTION);
  assert.equal(subscription.synthesized, true);
  assert.equal(subscription.primaryGroup, PROXY_GROUP_MAIN);

  const config = buildRuntimeConfig(BASE_SETTINGS, subscription, { controllerPort: 9123, secret: 'abc' });
  const groups = config['proxy-groups'];
  assert.equal(groups.length, 1);
  assert.equal(groups[0].name, PROXY_GROUP_MAIN);
  assert.deepEqual(groups[0].proxies, ['HK-01', 'US-01']);
  assert.equal(config.rules[config.rules.length - 1], `MATCH,${PROXY_GROUP_MAIN}`);
});

test('parseSubscription detects the primary select group with real nodes', () => {
  const subscription = parseSubscription(FULL_SUBSCRIPTION);
  assert.equal(subscription.synthesized, false);
  assert.equal(subscription.primaryGroup, '🚀 节点选择');
});

test('parseSubscription does not infer a primary selector from automatic-only groups', () => {
  const subscription = parseSubscription(AUTOMATIC_GROUPS_ONLY_SUBSCRIPTION);
  assert.equal(subscription.synthesized, false);
  assert.equal(subscription.primaryGroup, undefined);
});

test('buildRuntimeConfig preserves the subscription own groups and rules', () => {
  const subscription = parseSubscription(FULL_SUBSCRIPTION);
  const config = buildRuntimeConfig(BASE_SETTINGS, subscription, { controllerPort: 9123, secret: 'abc' });

  // The subscription's three groups are kept verbatim, not replaced.
  const groupNames = config['proxy-groups'].map((g) => g.name);
  assert.deepEqual(groupNames, ['🚀 节点选择', '🎯 全球直连', '🐟 漏网之鱼']);

  // Its own rules survive, including GEOIP,CN and the tracker REJECT.
  assert.ok(config.rules.includes('GEOIP,CN,🎯 全球直连'));
  assert.ok(config.rules.includes('DOMAIN-SUFFIX,tracker.example.com,REJECT'));
  assert.equal(config.rules[config.rules.length - 1], 'MATCH,🐟 漏网之鱼');

  // Control fields are still overridden by the app.
  assert.equal(config['mixed-port'], 7890);
  assert.equal(config['external-controller'], '127.0.0.1:9123');
  assert.equal(config['allow-lan'], false);
});

test('buildRuntimeConfig enables tun with fake-ip dns when requested', () => {
  const subscription = parseSubscription(SAMPLE_SUBSCRIPTION);
  const config = buildRuntimeConfig(
    { ...BASE_SETTINGS, tunEnabled: true },
    subscription,
    { controllerPort: 9123, secret: 'abc' }
  );

  assert.equal(config.tun.enable, true);
  assert.equal(config.tun['auto-route'], true);
  assert.equal(config.dns['enhanced-mode'], 'fake-ip');
});

test('dumpRuntimeConfig produces YAML that round-trips', () => {
  const subscription = parseSubscription(SAMPLE_SUBSCRIPTION);
  const config = buildRuntimeConfig(BASE_SETTINGS, subscription, { controllerPort: 9123, secret: 'abc' });
  const text = dumpRuntimeConfig(config);
  assert.match(text, /mixed-port: 7890/);
  assert.match(text, /external-controller: 127\.0\.0\.1:9123/);
  const reparsed = require('js-yaml').load(text);
  assert.deepEqual(reparsed['proxy-groups'], config['proxy-groups']);
});

test('selectCoreAsset picks the plain build for the current platform/arch', () => {
  const assets = [
    { name: 'mihomo-darwin-arm64-cgo-v1.19.2.gz', browser_download_url: 'u1' },
    { name: 'mihomo-darwin-arm64-v1.19.2.gz', browser_download_url: 'u2' },
    { name: 'mihomo-linux-amd64-compatible-v1.19.2.gz', browser_download_url: 'u3' },
    { name: 'mihomo-linux-amd64-v1.19.2.gz', browser_download_url: 'u4' },
    { name: 'mihomo-windows-amd64-v1.19.2.zip', browser_download_url: 'u5' },
  ];

  assert.equal(selectCoreAsset(assets, 'darwin', 'arm64').name, 'mihomo-darwin-arm64-v1.19.2.gz');
  assert.equal(selectCoreAsset(assets, 'linux', 'x64').name, 'mihomo-linux-amd64-v1.19.2.gz');
  assert.equal(selectCoreAsset(assets, 'win32', 'x64').name, 'mihomo-windows-amd64-v1.19.2.zip');
  assert.equal(selectCoreAsset(assets, 'linux', 'arm64'), null);
});

test('core platform/arch helpers map Node identifiers to mihomo asset names', () => {
  assert.equal(corePlatform('win32'), 'windows');
  assert.equal(corePlatform('darwin'), 'darwin');
  assert.equal(coreArch('x64'), 'amd64');
  assert.equal(coreArch('arm64'), 'arm64');
  assert.equal(coreBinaryName('win32'), 'mihomo.exe');
  assert.equal(coreBinaryName('darwin'), 'mihomo');
});
