const assert = require('node:assert/strict');
const { existsSync } = require('node:fs');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

const modulePath = path.join(__dirname, '..', 'dist', 'main', 'updateError.js');
const { classifyUpdateFailure } = existsSync(modulePath) ? require(modulePath) : {};

function getClassifier() {
  assert.equal(typeof classifyUpdateFailure, 'function');
  return classifyUpdateFailure;
}

test('automatic network failure retries once without surfacing an error', () => {
  const result = getClassifier()('net::ERR_NETWORK_CHANGED', 'auto', false);

  assert.deepEqual(result, {
    message: 'Update check failed because the network changed. Retrying shortly.',
    isNetworkError: true,
    shouldRetry: true,
    shouldShowError: false,
  });
});

test('automatic network failure stays quiet after its retry is exhausted', () => {
  const result = getClassifier()('net::ERR_NETWORK_CHANGED', 'auto', true);

  assert.deepEqual(result, {
    message: 'Update check failed because the network changed.',
    isNetworkError: true,
    shouldRetry: false,
    shouldShowError: false,
  });
});

test('manual network failure remains visible to the user', () => {
  const result = getClassifier()('net::ERR_NAME_NOT_RESOLVED', 'manual', false);

  assert.deepEqual(result, {
    message: 'Update check failed: DNS lookup failed.',
    isNetworkError: true,
    shouldRetry: false,
    shouldShowError: true,
  });
});

test('automatic download network failure remains visible instead of retrying the check', () => {
  const result = getClassifier()('net::ERR_NETWORK_CHANGED', 'auto', false, false);

  assert.deepEqual(result, {
    message: 'Update check failed because the network changed.',
    isNetworkError: true,
    shouldRetry: false,
    shouldShowError: true,
  });
});

test('automatic release metadata errors remain visible', () => {
  const result = getClassifier()('Cannot download latest.yml, status code 404', 'auto', false);

  assert.deepEqual(result, {
    message: 'Update metadata was not found in the release assets.',
    isNetworkError: false,
    shouldRetry: false,
    shouldShowError: true,
  });
});

test('renderer shows manual update failures as a toast instead of a header error', async () => {
  const renderer = await readFile(path.join(__dirname, '..', 'src', 'renderer', 'renderer.ts'), 'utf8');

  assert.match(renderer, /state\.status === 'error' && state\.trigger === 'manual'\)[\s\S]{0,80}setMessage\(state\.message \?\? 'Update check failed\.', 'error'\)/);
  assert.match(renderer, /state\.status === 'error' && state\.trigger === 'manual'\)[\s\S]{0,180}updateStatusHintElement\.classList\.add\('hidden'\)/);
});
