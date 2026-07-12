const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  classifyKubeconfig,
  diffKubeconfigContexts,
  normalizeNamespaceScope,
} = require('../dist/main/kubernetes/kubeconfigStore');
const { FileKubernetesContextPreference } = require('../dist/main/kubernetes/contextPreference');

const FIXTURE = {
  clusters: [
    { name: 'default', cluster: {} },
    { name: 'insecure', cluster: { 'insecure-skip-tls-verify': true } },
  ],
  users: [
    { name: 'token-user', user: { token: 'should-not-be-exposed' } },
    {
      name: 'certificate-user',
      user: {
        'client-certificate-data': 'certificate-should-not-be-exposed',
        'client-key-data': 'key-should-not-be-exposed',
      },
    },
    {
      name: 'certificate-without-key-user',
      user: { 'client-certificate-data': 'certificate-without-key-should-not-be-exposed' },
    },
    {
      name: 'key-without-certificate-user',
      user: { 'client-key-data': 'key-without-certificate-should-not-be-exposed' },
    },
    {
      name: 'certificate-file-user',
      user: {
        'client-certificate': '/private/certificate-should-not-be-exposed.pem',
        'client-key': '/private/key-should-not-be-exposed.pem',
      },
    },
    {
      name: 'certificate-file-without-key-user',
      user: { 'client-certificate': '/private/certificate-without-key.pem' },
    },
    {
      name: 'mixed-certificate-user',
      user: {
        'client-certificate-data': 'inline-certificate-should-not-be-exposed',
        'client-key': '/private/mixed-key-should-not-be-exposed.pem',
      },
    },
    { name: 'exec-user', user: { exec: { command: 'must-not-run' } } },
    { name: 'empty-user', user: {} },
    { name: 'basic-user', user: { username: 'operator', password: 'not-supported' } },
    { name: 'auth-provider-user', user: { 'auth-provider': { name: 'gcp' } } },
    {
      name: 'auth-provider-token-user',
      user: {
        token: 'auth-provider-token-should-not-be-exposed',
        'auth-provider': { name: 'exec', config: { exec: { command: 'must-not-run' } } },
      },
    },
    {
      name: 'auth-provider-certificate-user',
      user: {
        'client-certificate-data': 'auth-provider-certificate-should-not-be-exposed',
        'client-key-data': 'auth-provider-key-should-not-be-exposed',
        'auth-provider': { name: 'gcp' },
      },
    },
  ],
  contexts: [
    { name: 'token', context: { cluster: 'default', user: 'token-user' } },
    { name: 'cert', context: { cluster: 'insecure', user: 'certificate-user' } },
    { name: 'cert-without-key', context: { cluster: 'default', user: 'certificate-without-key-user' } },
    { name: 'key-without-cert', context: { cluster: 'default', user: 'key-without-certificate-user' } },
    { name: 'certificate-file', context: { cluster: 'default', user: 'certificate-file-user' } },
    { name: 'certificate-file-without-key', context: { cluster: 'default', user: 'certificate-file-without-key-user' } },
    { name: 'mixed-certificate', context: { cluster: 'default', user: 'mixed-certificate-user' } },
    { name: 'exec', context: { cluster: 'default', user: 'exec-user' } },
    { name: 'missing-user', context: { cluster: 'default', user: 'does-not-exist' } },
    { name: 'empty-user', context: { cluster: 'default', user: 'empty-user' } },
    { name: 'basic', context: { cluster: 'default', user: 'basic-user' } },
    { name: 'auth-provider', context: { cluster: 'default', user: 'auth-provider-user' } },
    { name: 'auth-provider-token', context: { cluster: 'default', user: 'auth-provider-token-user' } },
    { name: 'auth-provider-certificate', context: { cluster: 'default', user: 'auth-provider-certificate-user' } },
  ],
  'current-context': 'token',
};

test('classifyKubeconfig keeps token and certificate contexts but marks exec credentials unsupported', () => {
  const contexts = classifyKubeconfig(FIXTURE);

  assert.deepEqual(
    contexts.map(({ name, supported, unsupportedReason, tlsVerificationDisabled }) => ({
      name,
      supported,
      unsupportedReason,
      tlsVerificationDisabled,
    })),
    [
      { name: 'token', supported: true, unsupportedReason: undefined, tlsVerificationDisabled: false },
      { name: 'cert', supported: true, unsupportedReason: undefined, tlsVerificationDisabled: true },
      { name: 'cert-without-key', supported: false, unsupportedReason: 'unsupported-auth', tlsVerificationDisabled: false },
      { name: 'key-without-cert', supported: false, unsupportedReason: 'unsupported-auth', tlsVerificationDisabled: false },
      { name: 'certificate-file', supported: true, unsupportedReason: undefined, tlsVerificationDisabled: false },
      { name: 'certificate-file-without-key', supported: false, unsupportedReason: 'unsupported-auth', tlsVerificationDisabled: false },
      { name: 'mixed-certificate', supported: false, unsupportedReason: 'unsupported-auth', tlsVerificationDisabled: false },
      { name: 'exec', supported: false, unsupportedReason: 'exec-auth', tlsVerificationDisabled: false },
      { name: 'missing-user', supported: false, unsupportedReason: 'missing-auth', tlsVerificationDisabled: false },
      { name: 'empty-user', supported: false, unsupportedReason: 'missing-auth', tlsVerificationDisabled: false },
      { name: 'basic', supported: false, unsupportedReason: 'unsupported-auth', tlsVerificationDisabled: false },
      { name: 'auth-provider', supported: false, unsupportedReason: 'unsupported-auth', tlsVerificationDisabled: false },
      { name: 'auth-provider-token', supported: false, unsupportedReason: 'unsupported-auth', tlsVerificationDisabled: false },
      { name: 'auth-provider-certificate', supported: false, unsupportedReason: 'unsupported-auth', tlsVerificationDisabled: false },
    ]
  );

  assert.doesNotMatch(JSON.stringify(contexts), /should-not-be-exposed|must-not-run|\/private\//);
});

test('diffKubeconfigContexts requests confirmation only when context metadata changes', () => {
  const [tokenContext] = classifyKubeconfig(FIXTURE);

  assert.equal(diffKubeconfigContexts([tokenContext], [tokenContext]), false);
  assert.equal(
    diffKubeconfigContexts([tokenContext], [{ ...tokenContext, clusterName: 'changed-cluster' }]),
    true
  );
});

test('normalizeNamespaceScope makes All Namespaces exclusive and canonicalizes selected names', () => {
  assert.deepEqual(normalizeNamespaceScope({ mode: 'all', namespaces: ['ignored'] }), {
    mode: 'all',
    namespaces: [],
  });
  assert.deepEqual(normalizeNamespaceScope({ mode: 'selected', namespaces: [' apps ', 'default', 'apps'] }), {
    mode: 'selected',
    namespaces: ['apps', 'default'],
  });
  assert.throws(
    () => normalizeNamespaceScope({ mode: 'selected', namespaces: ['  '] }),
    /at least one Namespace/
  );
  assert.throws(
    () => normalizeNamespaceScope({ mode: 'selected', namespaces: ['default', 42] }),
    /Namespace names must be strings/
  );
});

test('FileKubernetesContextPreference persists only a safe selection ID and clears stale state', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'service-manager-kubernetes-preference-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const preferencePath = path.join(directory, 'context.json');
  const first = new FileKubernetesContextPreference(preferencePath);

  await first.save('development');
  const persisted = await fs.readFile(preferencePath, 'utf8');
  const second = new FileKubernetesContextPreference(preferencePath);

  assert.equal(await second.load(), 'development');
  assert.deepEqual(JSON.parse(persisted), { selectedContext: 'development' });
  assert.doesNotMatch(persisted, /token|certificate|key|server|\/Users\/|C:\\/i);
  await second.clear();
  assert.equal(await first.load(), undefined);
});
