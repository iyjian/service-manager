const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  SQL_CREDENTIALS_SCHEMA_VERSION,
  SqlCredentialsStore,
} = require('../dist/main/sql/sqlCredentialsStore');

function protector(overrides = {}) {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`protected:${value}`, 'utf8'),
    decryptString: (value) => {
      const text = value.toString('utf8');
      if (!text.startsWith('protected:')) throw new Error('unreadable');
      return text.slice('protected:'.length);
    },
    ...overrides,
  };
}

async function createStore(t, credentialProtector = protector()) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'service-manager-sql-login-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'sql-login.json');
  const store = new SqlCredentialsStore({ filePath, credentialProtector });
  await store.load();
  return { filePath, store };
}

const productionCredential = {
  userName: 'operator@example.test',
  passwd: 'a'.repeat(32),
};

test('SQL relogin credentials are protected per environment and explicit removal is narrow', async (t) => {
  const { filePath, store } = await createStore(t);
  await store.save('production', productionCredential);
  await store.save('development', { userName: 'developer', passwd: 'b'.repeat(32) });
  await store.flush();

  const raw = await fs.readFile(filePath, 'utf8');
  assert.doesNotMatch(raw, /operator@example|developer|a{32}|b{32}/);
  assert.equal(JSON.parse(raw).schemaVersion, SQL_CREDENTIALS_SCHEMA_VERSION);
  assert.deepEqual(await store.reveal('production'), productionCredential);
  assert.equal(store.has('production'), true);
  assert.equal(store.has('development'), true);

  await store.remove('production');
  assert.equal(store.has('production'), false);
  assert.equal(store.has('development'), true);
  await assert.rejects(store.reveal('production'), /unavailable/);
  assert.deepEqual(await store.reveal('development'), { userName: 'developer', passwd: 'b'.repeat(32) });
});

test('SQL credentials reload and permit Linux-style basic-text fallback', async (t) => {
  const { filePath, store } = await createStore(t);
  await store.save('production', productionCredential);
  const reloaded = new SqlCredentialsStore({ filePath, credentialProtector: protector() });
  await reloaded.load();
  assert.deepEqual(await reloaded.reveal('production'), productionCredential);

  const fallback = new SqlCredentialsStore({
    filePath: `${filePath}.fallback`,
    credentialProtector: protector({
      isEncryptionAvailable: () => false,
      encryptString: () => { throw new Error('safeStorage failed'); },
      decryptString: () => { throw new Error('safeStorage failed'); },
      getSelectedStorageBackend: () => 'basic_text',
    }),
  });
  await fallback.load();
  await fallback.save('production', productionCredential);
  assert.deepEqual(await fallback.reveal('production'), productionCredential);

  const fallbackRaw = JSON.parse(await fs.readFile(`${filePath}.fallback`, 'utf8'));
  const fallbackPayload = Buffer.from(
    fallbackRaw.environments.production.encryptedCredential,
    'base64',
  ).toString('utf8');
  assert.match(fallbackPayload, /^service-manager-sql-basic-text-v1:/);
});

test('SQL credentials use the explicit Linux fallback when safeStorage encryption fails', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'service-manager-sql-login-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'sql-login.json');
  const store = new SqlCredentialsStore({
    filePath,
    credentialProtector: protector({
      encryptString: () => { throw new Error('safeStorage failed'); },
      decryptString: () => { throw new Error('safeStorage failed'); },
      getSelectedStorageBackend: () => 'unknown',
    }),
    allowBasicTextFallback: true,
  });
  await store.load();
  await store.save('production', productionCredential);
  assert.deepEqual(await store.reveal('production'), productionCredential);

  const raw = JSON.parse(await fs.readFile(filePath, 'utf8'));
  const payload = Buffer.from(raw.environments.production.encryptedCredential, 'base64').toString('utf8');
  assert.match(payload, /^service-manager-sql-basic-text-v1:/);
});

test('SQL credentials reject unavailable non-fallback protection', async (t) => {
  const { filePath } = await createStore(t);
  const blocked = new SqlCredentialsStore({
    filePath: `${filePath}.blocked`,
    credentialProtector: protector({
      isEncryptionAvailable: () => false,
      getSelectedStorageBackend: () => 'unknown',
    }),
  });
  await blocked.load();
  await assert.rejects(blocked.save('production', productionCredential), /Secure credential storage is unavailable/);
});

test('damaged SQL credential files fail closed without revealing protected details', async (t) => {
  const { filePath, store } = await createStore(t);
  await fs.writeFile(filePath, '{broken protected content', 'utf8');
  await store.load();
  assert.equal(store.has('production'), false);
  await assert.rejects(store.reveal('production'), (error) => {
    assert.equal(error.message, 'The saved SQL login is unavailable. Sign in again.');
    assert.doesNotMatch(error.message, /broken protected content/);
    return true;
  });
});
