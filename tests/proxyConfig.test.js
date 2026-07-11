const test = require('node:test');
const assert = require('node:assert/strict');
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

function getProxyExceptions() {
  assert.equal(typeof proxyExceptions.normalizeProxyExceptions, 'function');
  assert.equal(typeof proxyExceptions.buildDirectExceptionRules, 'function');
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

test('normalizeProxyExceptions normalizes every supported exception type', () => {
  const { normalizeProxyExceptions } = getProxyExceptions();
  const exceptions = normalizeProxyExceptions([
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

  assert.equal(exceptions.length, 9);
  assert.ok(exceptions.every((exception) => typeof exception.id === 'string' && exception.id.length > 0));
  assert.deepEqual(
    exceptions.map(({ id, ...exception }) => exception),
    [
      { type: 'DOMAIN', value: 'example.com' },
      { type: 'DOMAIN-SUFFIX', value: 'example.org' },
      { type: 'DOMAIN-KEYWORD', value: 'internal' },
      { type: 'IP-CIDR', value: '192.0.2.0/24' },
      { type: 'IP-CIDR6', value: '2001:db8::/32' },
      { type: 'SRC-IP-CIDR', value: '10.0.0.0/8' },
      { type: 'GEOIP', value: 'CN' },
      { type: 'DST-PORT', value: '8000-8080' },
      { type: 'SRC-PORT', value: '53' },
    ]
  );
});

test('normalizeProxyExceptions rejects malformed IPv4 CIDR and out-of-range port', () => {
  const { normalizeProxyExceptions } = getProxyExceptions();

  assert.throws(
    () => normalizeProxyExceptions([{ type: 'IP-CIDR', value: '192.0.2.1/33' }]),
    /IPv4 CIDR/
  );
  assert.throws(
    () => normalizeProxyExceptions([{ type: 'DST-PORT', value: '65536' }]),
    /port/
  );
});

test('normalizeProxyExceptions rejects commas and newlines before trimming values', () => {
  const { normalizeProxyExceptions } = getProxyExceptions();

  assert.throws(
    () => normalizeProxyExceptions([{ type: 'DOMAIN', value: 'example.com\n' }]),
    /commas or newlines/
  );
  assert.throws(
    () => normalizeProxyExceptions([{ type: 'DOMAIN', value: 'example,com' }]),
    /commas or newlines/
  );
});

test('buildDirectExceptionRules converts a suffix exception to a DIRECT rule', () => {
  const { normalizeProxyExceptions, buildDirectExceptionRules } = getProxyExceptions();
  const exceptions = normalizeProxyExceptions([{ type: 'DOMAIN-SUFFIX', value: ' example.com ' }]);

  assert.deepEqual(buildDirectExceptionRules(exceptions), ['DOMAIN-SUFFIX,example.com,DIRECT']);
});

test('buildRuntimeConfig prepends direct exception rules before subscription rules', () => {
  const { normalizeProxyExceptions } = getProxyExceptions();
  const subscription = parseSubscription(FULL_SUBSCRIPTION);
  const config = buildRuntimeConfig(
    {
      ...BASE_SETTINGS,
      exceptions: normalizeProxyExceptions([{ type: 'DOMAIN-SUFFIX', value: ' example.com ' }]),
    },
    subscription,
    { controllerPort: 9123, secret: 'abc' }
  );

  const firstSubscriptionRule = config.rules.indexOf('DOMAIN-SUFFIX,tracker.example.com,REJECT');
  assert.ok(firstSubscriptionRule > 0);
  assert.equal(config.rules[0], 'DOMAIN-SUFFIX,example.com,DIRECT');
});

test('buildRuntimeConfig skips malformed persisted exceptions while retaining valid direct precedence', () => {
  const subscription = parseSubscription(FULL_SUBSCRIPTION);
  const config = buildRuntimeConfig(
    {
      ...BASE_SETTINGS,
      exceptions: [
        { id: 'valid', type: 'DOMAIN-SUFFIX', value: 'example.com' },
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

test('ProxyRuntime init sanitizes a non-array persisted exceptions value before state snapshot', async (t) => {
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

  assert.deepEqual(state.settings.exceptions, []);
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

test('ProxyRuntime mutations clean mixed persisted exceptions and preserve valid DIRECT precedence', async (t) => {
  const proxyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'service-manager-proxy-settings-'));
  t.after(() => fs.rm(proxyDir, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(proxyDir, 'proxy-config.json'),
    JSON.stringify({
      ...BASE_SETTINGS,
      exceptions: [
        { id: 'saved-valid', type: 'DOMAIN-SUFFIX', value: 'saved.example' },
        null,
        { id: 'saved-invalid', type: 'IP-CIDR', value: '2001:db8::/32' },
      ],
    }),
    'utf8'
  );

  const runtime = new ProxyRuntime(proxyDir);
  await runtime.init();
  assert.deepEqual((await runtime.getState()).settings.exceptions, [
    { id: 'saved-valid', type: 'DOMAIN-SUFFIX', value: 'saved.example' },
  ]);

  const afterAdd = await runtime.addException({ type: 'DOMAIN', value: 'added.example' });
  const added = afterAdd.settings.exceptions.find((exception) => exception.value === 'added.example');
  assert.ok(added);

  const afterUpdate = await runtime.updateException('saved-valid', {
    type: 'DOMAIN-SUFFIX',
    value: 'updated.example',
  });
  assert.equal(afterUpdate.settings.exceptions.find((exception) => exception.id === 'saved-valid').value, 'updated.example');

  const afterDelete = await runtime.deleteException(added.id);
  assert.deepEqual(afterDelete.settings.exceptions, [
    { id: 'saved-valid', type: 'DOMAIN-SUFFIX', value: 'updated.example' },
  ]);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(proxyDir, 'proxy-config.json'), 'utf8')).exceptions, [
    { id: 'saved-valid', type: 'DOMAIN-SUFFIX', value: 'updated.example' },
  ]);

  const config = buildRuntimeConfig(afterDelete.settings, parseSubscription(FULL_SUBSCRIPTION), {
    controllerPort: 9123,
    secret: 'abc',
  });
  assert.equal(config.rules[0], 'DOMAIN-SUFFIX,updated.example,DIRECT');
  assert.equal(config.rules[1], 'DOMAIN-SUFFIX,tracker.example.com,REJECT');
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
