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

test('compiled renderer keeps page toasts visible for exactly ten seconds and manually dismissible', async () => {
  const renderer = await readFile(path.join(__dirname, '..', 'dist', 'renderer', 'renderer.js'), 'utf8');

  assert.match(renderer, /const PAGE_TOAST_DURATION_MS = 10_?000;/);
  assert.match(renderer, /window\.setTimeout\(\(\) => \{[\s\S]{0,320}\}, PAGE_TOAST_DURATION_MS\);/);
  assert.match(renderer, /pageMessageCloseButton\.addEventListener\('click', \(\) => setMessage\(''\)\)/);
});

test('compiled renderer clears stale toast actions and opens only the last Note export capability', async () => {
  const renderer = await readFile(path.join(__dirname, '..', 'dist', 'renderer', 'renderer.js'), 'utf8');
  const html = await readFile(path.join(__dirname, '..', 'dist', 'renderer', 'index.html'), 'utf8');

  assert.match(html, /id="page-message-text"[^>]*type="button"[^>]*disabled/);
  assert.match(renderer, /function configurePageMessageAction\(action\)[\s\S]*?pageMessageTextElement\.disabled = !actionable/);
  assert.match(renderer, /let pageMessageGeneration = 0/);
  assert.match(renderer, /const generation = \+\+pageMessageGeneration[\s\S]*?pageMessageGeneration !== generation[\s\S]*?pageMessageGeneration \+= 1/);
  assert.match(renderer, /configurePageMessageAction\(text \? action : undefined\)[\s\S]*?renderMessage\(pageMessageView/);
  assert.match(renderer, /window\.setTimeout\(\(\) => \{[\s\S]*?configurePageMessageAction\(\)[\s\S]*?renderMessage\(pageMessageView, '', 'default'\)/);
  assert.match(renderer, /pageMessageTextElement\.addEventListener\('click'[\s\S]*?const generation = pageMessageGeneration[\s\S]*?notesApi\.openLastExport\(\)[\s\S]*?pageMessageGeneration !== generation/);
});
