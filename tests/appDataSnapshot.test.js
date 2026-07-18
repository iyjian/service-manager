const assert = require('node:assert/strict');
const test = require('node:test');

const { collectPersistentAppData } = require('../dist/main/appDataSnapshot');

test('persistent app snapshot uses strict field allowlists for Proxy and Kubernetes data', async () => {
  const data = await collectPersistentAppData({
    hosts: [{
      id: 'host-1', name: 'Dev', sshHost: 'host', sshPort: 22, username: 'user',
      authType: 'password', password: 'host-password', jumpHosts: [], forwards: [], services: [],
    }],
    notes: {
      schemaVersion: 1,
      notes: [{
        id: 'note-1', name: 'Deploy', content: 'pnpm deploy', language: 'bash', tags: ['release'],
        createdAt: '2026-07-18T00:00:00.000Z', updatedAt: '2026-07-18T00:00:00.000Z',
      }],
    },
    proxy: {
      settings: {
        startOnLaunch: true,
        mode: 'rule',
        mixedPort: 7890,
        tunEnabled: false,
        systemProxyEnabled: false,
        customRules: [{ id: 'rule-1', type: 'DOMAIN', value: 'example.com', target: 'DIRECT' }],
        subscriptionUrl: 'https://legacy.example.test/token',
        accessToken: 'proxy-secret',
        absolutePath: '/Users/example/.config/private',
      },
      subscriptionYaml: 'proxies: []\n',
      runtimeConfig: 'secret: runtime-only',
    },
    kubernetesContextSelection: 'context-1',
  });

  assert.equal(data.hosts.items[0].password, 'host-password');
  assert.equal(data.notes.notes[0].content, 'pnpm deploy');
  assert.deepEqual(data.proxy.settings, {
    startOnLaunch: true,
    mode: 'rule',
    mixedPort: 7890,
    tunEnabled: false,
    systemProxyEnabled: false,
    customRules: [{ id: 'rule-1', type: 'DOMAIN', value: 'example.com', target: 'DIRECT' }],
  });
  assert.equal(data.proxy.subscriptionYaml, 'proxies: []\n');
  assert.deepEqual(data.kubernetes, { schemaVersion: 1, selectedContext: 'context-1' });
  const serialized = JSON.stringify(data);
  assert.doesNotMatch(serialized, /subscriptionUrl|accessToken|proxy-secret|absolutePath|runtime-only|legacy\.example|Users\/example/);
});

test('persistent app snapshot tolerates absent optional Proxy source and Kubernetes selection', async () => {
  const data = await collectPersistentAppData({
    hosts: [],
    notes: { schemaVersion: 1, notes: [] },
    proxy: { settings: {} },
  });

  assert.deepEqual(data, {
    hosts: { schemaVersion: 1, items: [] },
    notes: { schemaVersion: 1, notes: [] },
    proxy: {
      schemaVersion: 1,
      settings: {
        startOnLaunch: false,
        mode: 'rule',
        mixedPort: 7890,
        tunEnabled: false,
        systemProxyEnabled: false,
        customRules: [],
      },
    },
    kubernetes: { schemaVersion: 1 },
  });
});
