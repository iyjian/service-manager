const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  kubeconfigDirectoryForHome,
  resolveKubeconfigContext,
  scanKubeconfigDirectory,
} = require('../dist/main/kubernetes/kubeconfigCatalog');

function kubeconfig(contexts, token = 'token-secret') {
  const clusters = [...new Set(contexts.map(({ cluster }) => cluster))];
  const users = [...new Set(contexts.map(({ user }) => user))];
  return [
    'apiVersion: v1',
    'kind: Config',
    'clusters:',
    ...clusters.flatMap((name) => [
      `  - name: ${name}`,
      '    cluster:',
      `      server: https://${name}.api.example.test`,
    ]),
    'users:',
    ...users.flatMap((name) => [
      `  - name: ${name}`,
      '    user:',
      `      token: ${token}`,
    ]),
    'contexts:',
    ...contexts.flatMap(({ name, cluster, user }) => [
      `  - name: ${name}`,
      '    context:',
      `      cluster: ${cluster}`,
      `      user: ${user}`,
    ]),
    '',
  ].join('\n');
}

test('scanKubeconfigDirectory discovers direct valid files and safely disambiguates duplicate Context names', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'service-manager-kubeconfigs-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const eastPath = path.join(directory, 'east.config');
  const westPath = path.join(directory, 'west.config');

  await fs.writeFile(eastPath, kubeconfig([
    { name: 'shared', cluster: 'east-cluster', user: 'east-user' },
  ], 'token-east-secret'));
  await fs.writeFile(westPath, kubeconfig([
    { name: 'development', cluster: 'development-cluster', user: 'development-user' },
    { name: 'shared', cluster: 'west-cluster', user: 'west-user' },
  ], 'token-west-secret'));
  await fs.writeFile(path.join(directory, 'certificate.pem'), '-----BEGIN CERTIFICATE-----\nsecret\n');
  await fs.writeFile(path.join(directory, 'broken.yaml'), 'contexts: [unterminated');
  await fs.writeFile(path.join(directory, 'invalid-structure.json'), JSON.stringify({
    clusters: [{ name: 'invalid-cluster', cluster: {} }],
    users: [{ name: 'invalid-user', user: { token: 'invalid-secret' } }],
    contexts: [{ context: { cluster: 'invalid-cluster', user: 'invalid-user' } }],
  }));
  await fs.mkdir(path.join(directory, 'cache'));
  await fs.writeFile(path.join(directory, 'cache', 'ignored.config'), kubeconfig([
    { name: 'nested', cluster: 'nested-cluster', user: 'nested-user' },
  ]));
  await fs.symlink(eastPath, path.join(directory, 'linked.config'));

  const catalog = await scanKubeconfigDirectory(directory);

  assert.deepEqual(
    catalog.contexts.map(({ contextName, displayName }) => ({ contextName, displayName })),
    [
      { contextName: 'development', displayName: 'development' },
      { contextName: 'shared', displayName: 'shared — east.config' },
      { contextName: 'shared', displayName: 'shared — west.config' },
    ]
  );
  assert.notEqual(catalog.contexts[1].name, catalog.contexts[2].name);
  assert.deepEqual(resolveKubeconfigContext(catalog, catalog.contexts[1].name), {
    kubeconfigPath: eastPath,
    contextName: 'shared',
  });
  assert.deepEqual(resolveKubeconfigContext(catalog, catalog.contexts[2].name), {
    kubeconfigPath: westPath,
    contextName: 'shared',
  });
  assert.doesNotMatch(
    JSON.stringify(catalog.contexts),
    /token-(?:east|west)-secret|\.api\.example\.test|service-manager-kubeconfigs-/
  );
});

test('scanKubeconfigDirectory returns an empty catalog for a missing directory and fingerprints credential changes', async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'service-manager-kubeconfig-fingerprint-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const missing = await scanKubeconfigDirectory(path.join(parent, 'missing'));
  assert.deepEqual(missing.contexts, []);
  assert.equal(missing.sources.size, 0);

  const filePath = path.join(parent, 'config');
  const contexts = [{ name: 'development', cluster: 'cluster', user: 'user' }];
  await fs.writeFile(filePath, kubeconfig(contexts, 'first-secret'));
  const first = await scanKubeconfigDirectory(parent);
  await fs.writeFile(filePath, kubeconfig(contexts, 'second-secret'));
  const second = await scanKubeconfigDirectory(parent);

  assert.notEqual(first.fingerprint, second.fingerprint);
  assert.deepEqual(first.contexts, second.contexts);
});

test('kubeconfigDirectoryForHome uses the supplied platform path implementation', () => {
  assert.equal(
    kubeconfigDirectoryForHome('C:\\Users\\operator', path.win32),
    'C:\\Users\\operator\\.kube'
  );
  assert.equal(kubeconfigDirectoryForHome('/Users/operator', path.posix), '/Users/operator/.kube');
});
