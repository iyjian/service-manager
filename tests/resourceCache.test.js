const assert = require('node:assert/strict');
const test = require('node:test');

const { ResourceCache } = require('../dist/main/kubernetes/resourceCache');

test('ResourceCache deduplicates an in-flight request and expires inactive data', async () => {
  let calls = 0;
  let clock = 0;
  const cache = new ResourceCache(2, 120_000, () => clock);
  const load = async () => ({ value: ++calls });

  const results = await Promise.all([cache.getOrCreate('pods', load), cache.getOrCreate('pods', load)]);
  assert.equal(results[0].value, 1);
  assert.equal(results[1].value, 1);
  assert.equal(calls, 1);

  clock = 120_001;
  cache.evictExpired();
  assert.equal(cache.get('pods'), undefined);
});

test('ResourceCache refreshes LRU position on a hit before evicting the oldest value', () => {
  const cache = new ResourceCache(2, 120_000, () => 0);
  cache.set('a', 1);
  cache.set('b', 2);
  assert.equal(cache.get('a'), 1);
  cache.set('c', 3);

  assert.equal(cache.get('a'), 1);
  assert.equal(cache.get('b'), undefined);
  assert.equal(cache.get('c'), 3);
});

test('ResourceCache does not retain a rejected load', async () => {
  const cache = new ResourceCache(2, 120_000);
  let attempts = 0;

  await assert.rejects(cache.getOrCreate('pods', async () => {
    attempts += 1;
    throw new Error('temporary failure');
  }), /temporary failure/);

  assert.equal(cache.get('pods'), undefined);
  assert.equal((await cache.getOrCreate('pods', async () => ({ attempt: ++attempts }))).attempt, 2);
});

test('ResourceCache removes a rejected pending load before a caller retries the same key', async () => {
  const cache = new ResourceCache(2, 120_000);
  let attempts = 0;

  const first = cache.getOrCreate('pods', async () => {
    attempts += 1;
    throw new Error('temporary failure');
  });

  const retried = first.catch(() => cache.getOrCreate('pods', async () => ({ attempt: ++attempts })));
  assert.deepEqual(await retried, { attempt: 2 });
  assert.equal(attempts, 2);
});

test('ResourceCache direct set supersedes an older pending load', async () => {
  const cache = new ResourceCache(2, 120_000);
  let resolveLoad;
  const pending = cache.getOrCreate('pods', () => new Promise((resolve) => {
    resolveLoad = resolve;
  }));

  await Promise.resolve();
  cache.set('pods', { value: 'newer' });
  resolveLoad({ value: 'older' });
  await pending;

  assert.deepEqual(cache.get('pods'), { value: 'newer' });
});

test('ResourceCache clear prevents in-flight work from repopulating cleared values', async () => {
  const cache = new ResourceCache(2, 120_000);
  let resolveLoad;
  const load = new Promise((resolve) => {
    resolveLoad = resolve;
  });
  const pending = cache.getOrCreate('pods', () => load);

  cache.clear();
  resolveLoad({ value: 'late' });
  await pending;
  assert.equal(cache.get('pods'), undefined);
});
