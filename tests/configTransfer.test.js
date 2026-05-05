const assert = require('node:assert/strict');
const test = require('node:test');

const {
  countRules,
  countServices,
  ensureUniqueImportedIds,
  parseImportedHostDrafts,
} = require('../dist/main/configTransfer');

function host(id) {
  return {
    id,
    name: id,
    sshHost: `${id}.example.com`,
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
      },
    ],
  };
}

test('parseImportedHostDrafts accepts array and object wrapper', () => {
  const hosts = [host('host-1')];
  assert.deepEqual(parseImportedHostDrafts(hosts), hosts);
  assert.deepEqual(parseImportedHostDrafts({ hosts }), hosts);
  assert.throws(() => parseImportedHostDrafts({ bad: hosts }), /Invalid config file format/);
});

test('ensureUniqueImportedIds normalizes duplicate host and child ids', () => {
  const normalized = ensureUniqueImportedIds([host('host-1'), host('host-1')]);

  assert.notEqual(normalized[0].id, normalized[1].id);
  assert.notEqual(normalized[0].forwards[0].id, normalized[1].forwards[0].id);
  assert.equal(normalized[0].services[0].id, 'service-1');
  assert.equal(normalized[1].services[0].id, 'service-1');
});

test('count helpers summarize rules and services', () => {
  const hosts = [host('host-1'), host('host-2')];
  assert.equal(countRules(hosts), 2);
  assert.equal(countServices(hosts), 2);
});
