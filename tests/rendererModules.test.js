const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

test('compiled renderer uses browser-resolvable module specifiers', async () => {
  const renderer = await readFile(path.join(__dirname, '..', 'dist', 'renderer', 'renderer.js'), 'utf8');

  assert.match(renderer, /from ['"]\.\/html\.js['"]/);
  assert.match(renderer, /from ['"]\.\/status\.js['"]/);
  assert.doesNotMatch(renderer, /from ['"]\.\/(?:html|status)['"]/);
});
