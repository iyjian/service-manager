const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { ProxyRuntime } = require('../dist/main/proxy/proxyRuntime');
const { parseSubscriptionCache } = require('../dist/main/proxy/subscriptionCache');

const OLD_SUBSCRIPTION = [
  'proxies:',
  '  - name: old-node',
  '    type: http',
  '    server: old.example.test',
  '    port: 8080',
  '',
].join('\n');

const SYNCED_SUBSCRIPTION = [
  'proxies:',
  '  - name: synced-a',
  '    type: http',
  '    server: a.example.test',
  '    port: 8080',
  '  - name: synced-b',
  '    type: http',
  '    server: b.example.test',
  '    port: 8081',
  'proxy-groups:',
  '  - name: Synced Select',
  '    type: select',
  '    proxies: [synced-a, synced-b]',
  '',
].join('\n');

function localProxySettings(overrides = {}) {
  return {
    startOnLaunch: true,
    mode: 'direct',
    mixedPort: 8899,
    tunEnabled: false,
    systemProxyEnabled: false,
    selectedProxies: { 'Old Select': 'old-node' },
    selectedProxy: 'old-node',
    customRules: [{ id: 'old-rule', type: 'DOMAIN', value: 'old.example.test', target: 'DIRECT' }],
    subscriptionUpdatedAt: '2026-07-17T01:02:03.000Z',
    proxyCount: 1,
    ...overrides,
  };
}

function syncedProxySnapshot() {
  return {
    settings: {
      // These four fields are device-local and must not be imported.
      startOnLaunch: false,
      mixedPort: 17890,
      tunEnabled: true,
      systemProxyEnabled: true,
      mode: 'global',
      selectedProxies: { 'Synced Select': 'synced-b' },
      selectedProxy: 'synced-b',
      customRules: [{ id: 'synced-rule', type: 'DOMAIN-SUFFIX', value: 'example.org', target: 'PROXY' }],
      subscriptionUpdatedAt: '2026-07-18T03:04:05.000Z',
      proxyCount: 999,
    },
    subscriptionYaml: SYNCED_SUBSCRIPTION,
  };
}

async function createProxyRuntime(t, prefix = 'service-manager-proxy-import-') {
  const proxyDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(proxyDir, { recursive: true, force: true }));
  await fs.writeFile(path.join(proxyDir, 'proxy-config.json'), JSON.stringify(localProxySettings()));
  await fs.writeFile(path.join(proxyDir, 'subscription.yaml'), OLD_SUBSCRIPTION);
  await fs.writeFile(path.join(proxyDir, 'subscription.parsed.json'), '{"oldParsedCache":true}');
  const runtime = new ProxyRuntime(proxyDir);
  await runtime.init();
  t.after(() => runtime.shutdown());
  return { proxyDir, runtime };
}

test('Proxy backup export is consistent, strictly allowlisted, and source-size bounded', async (t) => {
  const proxyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'service-manager-proxy-backup-'));
  t.after(() => fs.rm(proxyDir, { recursive: true, force: true }));
  await fs.writeFile(path.join(proxyDir, 'proxy-config.json'), JSON.stringify({
    startOnLaunch: true,
    mode: 'global',
    mixedPort: 8899,
    tunEnabled: false,
    systemProxyEnabled: false,
    customRules: [{ id: 'rule-1', type: 'DOMAIN', value: 'example.com', target: 'DIRECT' }],
    subscriptionUrl: 'https://legacy.example.test/private',
    token: 'must-not-leave-the-device',
    absolutePath: '/Users/example/.ssh/id_ed25519',
  }));
  const subscriptionPath = path.join(proxyDir, 'subscription.yaml');
  await fs.writeFile(subscriptionPath, 'proxies: []\n');

  const runtime = new ProxyRuntime(proxyDir);
  await runtime.init();
  t.after(() => runtime.shutdown());

  const snapshot = await runtime.exportPersistentSnapshot();
  assert.deepEqual(snapshot, {
    settings: {
      startOnLaunch: true,
      mode: 'global',
      mixedPort: 8899,
      tunEnabled: false,
      systemProxyEnabled: false,
      customRules: [{ id: 'rule-1', type: 'DOMAIN', value: 'example.com', target: 'DIRECT' }],
    },
    subscriptionYaml: 'proxies: []\n',
  });
  assert.doesNotMatch(JSON.stringify(snapshot), /subscriptionUrl|token|legacy\.example|absolutePath|id_ed25519/);

  await fs.truncate(subscriptionPath, 20 * 1024 * 1024 + 1);
  await assert.rejects(runtime.exportPersistentSnapshot(), /retained Proxy subscription is too large/);
});

test('Proxy snapshot import applies shared data while preserving device-local runtime settings', async (t) => {
  const { proxyDir, runtime } = await createProxyRuntime(t);

  const state = await runtime.importPersistentSnapshot(syncedProxySnapshot());

  assert.equal(state.settings.startOnLaunch, true);
  assert.equal(state.settings.mixedPort, 8899);
  assert.equal(state.settings.tunEnabled, false);
  assert.equal(state.settings.systemProxyEnabled, false);
  assert.equal(state.settings.mode, 'global');
  assert.deepEqual(state.settings.customRules, [
    { id: 'synced-rule', type: 'DOMAIN-SUFFIX', value: 'example.org', target: 'PROXY' },
  ]);
  assert.deepEqual(state.settings.selectedProxies, { 'Synced Select': 'synced-b' });
  assert.equal(state.settings.selectedProxy, 'synced-b');
  assert.equal(state.settings.subscriptionUpdatedAt, '2026-07-18T03:04:05.000Z');
  assert.equal(state.settings.proxyCount, 2);

  const persisted = JSON.parse(await fs.readFile(path.join(proxyDir, 'proxy-config.json'), 'utf8'));
  assert.deepEqual(persisted, state.settings);
  assert.equal(await fs.readFile(path.join(proxyDir, 'subscription.yaml'), 'utf8'), SYNCED_SUBSCRIPTION);
  const parsed = parseSubscriptionCache(await fs.readFile(path.join(proxyDir, 'subscription.parsed.json'), 'utf8'));
  assert.deepEqual(parsed.proxies.map((proxy) => proxy.name), ['synced-a', 'synced-b']);
  assert.equal(parsed.primaryGroup, 'Synced Select');
});

test('Proxy snapshot import rolls settings and both subscription caches back after a persistence failure', async (t) => {
  const { proxyDir, runtime } = await createProxyRuntime(t, 'service-manager-proxy-import-rollback-');
  const settingsPath = path.join(proxyDir, 'proxy-config.json');
  const rawPath = path.join(proxyDir, 'subscription.yaml');
  const parsedPath = path.join(proxyDir, 'subscription.parsed.json');
  const beforeState = await runtime.getState();
  const beforeSettings = await fs.readFile(settingsPath, 'utf8');
  const beforeRaw = await fs.readFile(rawPath, 'utf8');
  const beforeParsed = await fs.readFile(parsedPath, 'utf8');
  const originalWriteFile = fs.writeFile;
  let injectedFailure = false;

  fs.writeFile = async (target, ...args) => {
    if (!injectedFailure && path.resolve(String(target)) === path.resolve(settingsPath)) {
      injectedFailure = true;
      throw new Error('simulated proxy settings persistence failure');
    }
    return originalWriteFile(target, ...args);
  };
  try {
    await assert.rejects(
      runtime.importPersistentSnapshot(syncedProxySnapshot()),
      /simulated proxy settings persistence failure/,
    );
  } finally {
    fs.writeFile = originalWriteFile;
  }

  assert.equal(injectedFailure, true);
  assert.deepEqual((await runtime.getState()).settings, beforeState.settings);
  assert.deepEqual(JSON.parse(await fs.readFile(settingsPath, 'utf8')), JSON.parse(beforeSettings));
  assert.equal(await fs.readFile(rawPath, 'utf8'), beforeRaw);
  assert.equal(await fs.readFile(parsedPath, 'utf8'), beforeParsed);
  assert.equal((await fs.readdir(proxyDir)).some((name) => name.endsWith('.tmp')), false);

  const retried = await runtime.importPersistentSnapshot(syncedProxySnapshot());
  assert.equal(retried.settings.mode, 'global');
  assert.equal(retried.settings.mixedPort, 8899);
});
