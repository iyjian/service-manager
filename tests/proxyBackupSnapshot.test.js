const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { ProxyRuntime } = require('../dist/main/proxy/proxyRuntime');

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
