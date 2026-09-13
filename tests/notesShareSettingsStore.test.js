const assert = require('node:assert/strict');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  NotesShareSettingsStore,
  createShlinkShortUrl,
  shortenNoteShareViewUrls,
} = require('../dist/main/notes/notesShareSettingsStore');

function protector() {
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'keychain',
    encryptString: (value) => Buffer.from(`sealed:${value}`, 'utf8'),
    decryptString: (value) => {
      const raw = value.toString('utf8');
      if (!raw.startsWith('sealed:')) throw new Error('invalid seal');
      return raw.slice('sealed:'.length);
    },
  };
}

test('Notes share settings stores the Shlink API key encrypted and reveals it only through the credential API', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'service-manager-note-share-settings-'));
  try {
    const filePath = path.join(directory, 'settings.json');
    const store = new NotesShareSettingsStore({ filePath, credentialProtector: protector() });
    await store.load();

    const saved = await store.save({
      shortenerBaseUrl: 'https://s.tltr.top/',
      shortenerApiKey: 'secret-shlink-key',
    });
    assert.deepEqual(saved, {
      shortenerBaseUrl: 'https://s.tltr.top',
      hasShortenerApiKey: true,
    });
    assert.equal(await store.revealShortenerApiKey(), 'secret-shlink-key');
    assert.deepEqual(await store.getShortenerConfig(), {
      baseUrl: 'https://s.tltr.top',
      apiKey: 'secret-shlink-key',
    });

    const persisted = await readFile(filePath, 'utf8');
    assert.doesNotMatch(persisted, /secret-shlink-key/);
    assert.match(persisted, /encryptedShortenerApiKey/);

    const reloaded = new NotesShareSettingsStore({ filePath, credentialProtector: protector() });
    await reloaded.load();
    assert.deepEqual(reloaded.get(), saved);
    assert.equal(await reloaded.revealShortenerApiKey(), 'secret-shlink-key');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('createShlinkShortUrl posts authenticated JSON and returns the short URL', async () => {
  const calls = [];
  const shortUrl = await createShlinkShortUrl('https://s3.example.com/bucket/share?X-Amz-Signature=abc', {
    baseUrl: 'https://s.tltr.top/',
    apiKey: 'shlink-key',
  }, {
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ shortUrl: 'https://s.tltr.top/A1b2' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  assert.equal(shortUrl, 'https://s.tltr.top/A1b2');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://s.tltr.top/rest/v3/short-urls');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Accept, 'application/json');
  assert.equal(calls[0].init.headers['X-Api-Key'], 'shlink-key');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    longUrl: 'https://s3.example.com/bucket/share?X-Amz-Signature=abc',
    findIfExists: true,
  });
});

test('shortenNoteShareViewUrls leaves expired and unconfigured shares unchanged', async () => {
  const shares = [
    {
      shareId: 'share-1',
      title: 'Active',
      createdAt: '2026-09-02T00:00:00.000Z',
      expiresAt: '2026-09-03T00:00:00.000Z',
      status: 'active',
      url: 'https://s3.example.com/long',
    },
    {
      shareId: 'share-2',
      title: 'Expired',
      createdAt: '2026-09-01T00:00:00.000Z',
      expiresAt: '2026-09-01T01:00:00.000Z',
      status: 'expired',
    },
  ];

  assert.deepEqual(await shortenNoteShareViewUrls(shares, undefined), shares);
  assert.deepEqual(await shortenNoteShareViewUrls(shares, {
    baseUrl: 'https://s.tltr.top',
    apiKey: 'shlink-key',
  }, {
    fetchImpl: async () => new Response(JSON.stringify({ shortUrl: 'https://s.tltr.top/x' }), { status: 200 }),
  }), [
    { ...shares[0], url: 'https://s.tltr.top/x' },
    shares[1],
  ]);
});

test('shortenNoteShareViewUrls keeps original share URLs when Shlink fails', async () => {
  const shares = [
    {
      shareId: 'share-1',
      title: 'Active',
      createdAt: '2026-09-02T00:00:00.000Z',
      expiresAt: '2026-09-03T00:00:00.000Z',
      status: 'active',
      url: 'https://s3.example.com/long',
    },
  ];

  assert.deepEqual(await shortenNoteShareViewUrls(shares, {
    baseUrl: 'https://s.tltr.top',
    apiKey: 'shlink-key',
  }, {
    fetchImpl: async () => new Response(JSON.stringify({ detail: 'invalid API key' }), { status: 401 }),
  }), shares);
});
