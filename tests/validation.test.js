const assert = require('node:assert/strict');
const test = require('node:test');

const {
  preserveServiceRuntimeFields,
  validateHostDraft,
  validateServiceDraft,
} = require('../dist/main/validation');

test('validateServiceDraft treats exposed port 0 as no forwarding', () => {
  const service = validateServiceDraft({
    name: 'worker',
    startCommand: 'node worker.js',
    port: 0,
    forwardLocalPort: 3000,
  });

  assert.equal(service.port, 0);
  assert.equal(service.forwardLocalPort, undefined);
});

test('validateHostDraft allows private key path without pasted private key content', () => {
  const host = validateHostDraft({
    name: 'dev',
    sshHost: 'example.com',
    sshPort: 22,
    username: 'alice',
    authType: 'privateKey',
    privateKeyPath: '/Users/alice/.ssh/id_ed25519',
    forwards: [],
    services: [],
  });

  assert.equal(host.privateKey, undefined);
  assert.equal(host.privateKeyPath, '/Users/alice/.ssh/id_ed25519');
});

test('preserveServiceRuntimeFields keeps pid only when runtime shape is unchanged', () => {
  const previous = validateHostDraft({
    id: 'host-1',
    name: 'dev',
    sshHost: 'example.com',
    sshPort: 22,
    username: 'alice',
    authType: 'password',
    password: 'secret',
    forwards: [],
    services: [{ id: 'svc-1', name: 'api', startCommand: 'yarn dev', port: 3000 }],
  });
  previous.services[0].pid = 1234;

  const unchanged = validateHostDraft({
    ...previous,
    services: [{ id: 'svc-1', name: 'api', startCommand: 'yarn dev', port: 3000 }],
  });
  const changed = validateHostDraft({
    ...previous,
    services: [{ id: 'svc-1', name: 'api', startCommand: 'node server.js', port: 3000 }],
  });

  assert.equal(preserveServiceRuntimeFields(previous, unchanged).services[0].pid, 1234);
  assert.equal(preserveServiceRuntimeFields(previous, changed).services[0].pid, undefined);
});
