const assert = require('node:assert/strict');
const { mkdtemp, rm, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  forwardToRuntimeConfig,
  resolveHostPrivateKey,
} = require('../dist/main/hostConnection');

async function withPrivateKeyFile(content, run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'service-manager-'));
  const keyPath = path.join(dir, 'id_ed25519');
  await writeFile(keyPath, content, 'utf8');
  try {
    return await run(keyPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function host(overrides = {}) {
  return {
    id: 'host-1',
    name: 'dev',
    sshHost: 'example.com',
    sshPort: 22,
    username: 'alice',
    authType: 'privateKey',
    privateKey: undefined,
    privateKeyPath: undefined,
    jumpHosts: [],
    forwards: [],
    services: [],
    ...overrides,
  };
}

test('resolveHostPrivateKey prefers pasted key content over file path', async () => {
  await withPrivateKeyFile('from-file', async (keyPath) => {
    const key = await resolveHostPrivateKey(host({ privateKey: 'from-form', privateKeyPath: keyPath }));

    assert.equal(key, 'from-form');
  });
});

test('resolveHostPrivateKey reads private key from configured path', async () => {
  await withPrivateKeyFile('from-file', async (keyPath) => {
    const key = await resolveHostPrivateKey(host({ privateKeyPath: keyPath }));

    assert.equal(key, 'from-file');
  });
});

test('forwardToRuntimeConfig resolves private key and preserves forwarding endpoints', async () => {
  await withPrivateKeyFile('target-key', async (keyPath) => {
    const config = await forwardToRuntimeConfig(
      host({
        privateKeyPath: keyPath,
        jumpHosts: [
          {
            sshHost: 'jump.example.com',
            sshPort: 22,
            username: 'jump',
            authType: 'password',
            password: 'secret',
            privateKey: 'ignored',
          },
        ],
      }),
      {
        id: 'forward-1',
        localHost: '127.0.0.1',
        localPort: 9000,
        remoteHost: '10.0.0.10',
        remotePort: 9001,
        autoStart: false,
      }
    );

    assert.equal(config.privateKey, 'target-key');
    assert.equal(config.localHost, '127.0.0.1');
    assert.equal(config.localPort, 9000);
    assert.equal(config.remoteHost, '10.0.0.10');
    assert.equal(config.remotePort, 9001);
    assert.equal(config.jumpHosts[0].privateKey, undefined);
  });
});
