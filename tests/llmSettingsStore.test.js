const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  LLM_SETTINGS_SCHEMA_VERSION,
  LlmSettingsStore,
  normalizeLlmEndpoint,
  normalizeLlmSettingsDraft,
} = require('../dist/main/llmSettingsStore');

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
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'service-manager-llm-settings-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'llm-settings.json');
  const store = new LlmSettingsStore({ filePath, credentialProtector });
  return { directory, filePath, store };
}

function draft(overrides = {}) {
  return {
    endpoint: 'https://llm.example.test/v1',
    selectedModel: 'gpt-test',
    ...overrides,
  };
}

test('LLM settings default to an empty local-only view when missing', async (t) => {
  const { filePath, store } = await createStore(t);
  await store.load();

  assert.deepEqual(store.get(), { endpoint: '', selectedModel: '', hasToken: false });
  assert.equal('token' in store.get(), false);
  await assert.rejects(fs.stat(filePath), { code: 'ENOENT' });
});

test('LLM settings normalize HTTP(S) API bases and reject unsafe URL components', () => {
  assert.equal(normalizeLlmEndpoint(' https://LLM.example.test/v1/// '), 'https://llm.example.test/v1');
  assert.equal(normalizeLlmEndpoint('http://127.0.0.1:11434/v1/'), 'http://127.0.0.1:11434/v1');
  assert.equal(normalizeLlmEndpoint(''), '');

  for (const endpoint of [
    'ftp://llm.example.test/v1',
    'https://user:secret@llm.example.test/v1',
    'https://llm.example.test/v1?tenant=private',
    'https://llm.example.test/v1#private',
    'not a URL',
  ]) {
    assert.throws(() => normalizeLlmEndpoint(endpoint), /LLM endpoint/);
  }
});

test('LLM settings persist schema 1 atomically while exposing only token presence', async (t) => {
  const { directory, filePath, store } = await createStore(t);
  await store.load();

  assert.deepEqual(await store.save(draft({
    endpoint: ' https://LLM.example.test/v1/ ',
    selectedModel: ' gpt-test ',
    token: 'private-token',
  })), {
    endpoint: 'https://llm.example.test/v1',
    selectedModel: 'gpt-test',
    hasToken: true,
  });
  await store.flush();

  const raw = await fs.readFile(filePath, 'utf8');
  assert.doesNotMatch(raw, /private-token/);
  assert.deepEqual(JSON.parse(raw), {
    schemaVersion: LLM_SETTINGS_SCHEMA_VERSION,
    endpoint: 'https://llm.example.test/v1',
    selectedModel: 'gpt-test',
    encryptedToken: Buffer.from('protected:private-token', 'utf8').toString('base64'),
  });
  assert.equal(await store.revealToken(), 'private-token');
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(filePath)).mode & 0o777, 0o600);
  }
  assert.deepEqual((await fs.readdir(directory)).filter((name) => name.endsWith('.tmp')), []);

  const reloaded = new LlmSettingsStore({ filePath, credentialProtector: protector() });
  await reloaded.load();
  assert.deepEqual(reloaded.get(), {
    endpoint: 'https://llm.example.test/v1',
    selectedModel: 'gpt-test',
    hasToken: true,
  });
  assert.equal(await reloaded.revealToken(), 'private-token');
});

test('LLM token is preserved by omission or an empty draft and removed only explicitly', async (t) => {
  const { filePath, store } = await createStore(t);
  await store.load();
  await store.save(draft({ token: 'keep-me' }));

  await store.save(draft({ endpoint: 'https://second.example.test/api', token: '' }));
  assert.equal(await store.revealToken(), 'keep-me');
  assert.equal(JSON.parse(await fs.readFile(filePath, 'utf8')).encryptedToken,
    Buffer.from('protected:keep-me').toString('base64'));

  assert.deepEqual(await store.save(draft({ clearToken: true })), {
    endpoint: 'https://llm.example.test/v1',
    selectedModel: 'gpt-test',
    hasToken: false,
  });
  await assert.rejects(store.revealToken(), /unavailable/);
  assert.equal('encryptedToken' in JSON.parse(await fs.readFile(filePath, 'utf8')), false);

  assert.throws(
    () => normalizeLlmSettingsDraft(draft({ token: 'replacement', clearToken: true })),
    /cannot be replaced and cleared/,
  );
});

test('damaged LLM settings safely fall back and a valid Save repairs the file', async (t) => {
  const { filePath, store } = await createStore(t);
  await fs.writeFile(filePath, '{private broken content', 'utf8');
  await store.load();
  assert.deepEqual(store.get(), { endpoint: '', selectedModel: '', hasToken: false });

  await store.save(draft());
  assert.deepEqual(JSON.parse(await fs.readFile(filePath, 'utf8')), {
    schemaVersion: LLM_SETTINGS_SCHEMA_VERSION,
    endpoint: 'https://llm.example.test/v1',
    selectedModel: 'gpt-test',
  });
});

test('LLM settings reject unavailable and Linux basic_text protection for new tokens', async (t) => {
  for (const credentialProtector of [
    protector({ isEncryptionAvailable: () => false }),
    protector({ getSelectedStorageBackend: () => 'basic_text' }),
  ]) {
    const { filePath, store } = await createStore(t, credentialProtector);
    await store.load();
    await assert.rejects(store.save(draft({ token: 'must-not-persist' })), /Secure credential storage is unavailable/);
    await assert.rejects(fs.stat(filePath), { code: 'ENOENT' });

    assert.deepEqual(await store.save(draft()), {
      endpoint: 'https://llm.example.test/v1',
      selectedModel: 'gpt-test',
      hasToken: false,
    });
  }
});

test('an unreadable protected token stays secret and fails only the dedicated reveal', async (t) => {
  const { filePath, store } = await createStore(t, protector({
    decryptString: () => { throw new Error('private decrypt details'); },
  }));
  await fs.writeFile(filePath, JSON.stringify({
    schemaVersion: LLM_SETTINGS_SCHEMA_VERSION,
    endpoint: 'https://llm.example.test/v1',
    selectedModel: 'gpt-test',
    encryptedToken: Buffer.from('opaque-ciphertext').toString('base64'),
  }));
  await store.load();

  assert.deepEqual(store.get(), {
    endpoint: 'https://llm.example.test/v1',
    selectedModel: 'gpt-test',
    hasToken: true,
  });
  await assert.rejects(store.revealToken(), (error) => {
    assert.equal(error.message, 'The LLM token is unavailable. Save it again.');
    assert.doesNotMatch(error.message, /private decrypt details|opaque-ciphertext/);
    return true;
  });
});

test('concurrent LLM settings saves remain serialized in invocation order', async (t) => {
  const { filePath, store } = await createStore(t);
  await store.load();

  const results = await Promise.all([
    store.save(draft({ selectedModel: 'model-a' })),
    store.save(draft({ selectedModel: 'model-b', token: 'new-token' })),
    store.save(draft({ selectedModel: 'model-c' })),
  ]);

  assert.deepEqual(results.map((value) => value.selectedModel), ['model-a', 'model-b', 'model-c']);
  assert.equal(store.get().selectedModel, 'model-c');
  assert.equal(await store.revealToken(), 'new-token');
  assert.equal(JSON.parse(await fs.readFile(filePath, 'utf8')).selectedModel, 'model-c');
});
