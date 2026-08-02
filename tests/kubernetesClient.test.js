const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const distMain = path.join(__dirname, '..', 'dist', 'main');

test('Kubernetes LIST continuation reads the client-node _continue field', async () => {
  const { listContinueToken } = await import(path.join(distMain, 'kubernetes', 'kubernetesClient.js'));

  // @kubernetes/client-node deserializes the API's metadata.continue to _continue.
  assert.equal(listContinueToken({ metadata: { _continue: 'page-2' } }), 'page-2');
  // Raw wire-shaped responses keep the original key.
  assert.equal(listContinueToken({ metadata: { continue: 'page-2' } }), 'page-2');
  // _continue wins when both exist.
  assert.equal(listContinueToken({ metadata: { _continue: 'a', continue: 'b' } }), 'a');
  // Empty, missing, or non-string values never produce a continuation.
  assert.equal(listContinueToken({ metadata: {} }), undefined);
  assert.equal(listContinueToken({}), undefined);
  assert.equal(listContinueToken({ metadata: { _continue: '' } }), undefined);
  assert.equal(listContinueToken({ metadata: { _continue: 123 } }), undefined);
});
