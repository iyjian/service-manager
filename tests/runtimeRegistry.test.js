const assert = require('node:assert/strict');
const test = require('node:test');

const { RuntimeRegistry } = require('../dist/main/runtimeRegistry');

function host() {
  return {
    id: 'host-1',
    name: 'dev',
    sshHost: 'example.com',
    sshPort: 22,
    username: 'alice',
    authType: 'password',
    password: 'secret',
    jumpHosts: [],
    forwards: [
      {
        id: 'forward-1',
        localHost: '127.0.0.1',
        localPort: 9000,
        remoteHost: '127.0.0.1',
        remotePort: 9000,
        autoStart: false,
      },
    ],
    services: [
      {
        id: 'service-1',
        name: 'api',
        startCommand: 'yarn dev',
        port: 3000,
        forwardLocalPort: 13000,
        pid: 4321,
      },
      {
        id: 'service-2',
        name: 'worker',
        startCommand: 'node worker.js',
        port: 0,
        forwardLocalPort: undefined,
      },
    ],
  };
}

test('RuntimeRegistry includes service forward state in emitted status payload', () => {
  const registry = new RuntimeRegistry();
  registry.setServiceForwardStatus('host-1', 'service-1', 'ok');

  const payload = registry.setServiceStatus('host-1', 'service-1', 'running', 1234);

  assert.equal(payload.forwardState, 'ok');
  assert.equal(payload.status, 'running');
  assert.equal(payload.pid, 1234);
});

test('RuntimeRegistry builds HostView from config plus runtime state', () => {
  const registry = new RuntimeRegistry();
  registry.setServiceForwardStatus('host-1', 'service-1', 'error', 'port busy');

  const view = registry.toView([host()], (forwardId) => ({
    hostId: 'host-1',
    forwardId,
    status: 'running',
  }));

  assert.equal(view[0].forwards[0].status, 'running');
  assert.equal(view[0].services[0].status, 'running');
  assert.equal(view[0].services[0].pid, 4321);
  assert.equal(view[0].services[0].forwardState, 'error');
  assert.equal(view[0].services[0].forwardError, 'port busy');
  assert.equal(view[0].services[1].status, 'stopped');
  assert.equal(view[0].services[1].forwardState, 'none');
});
