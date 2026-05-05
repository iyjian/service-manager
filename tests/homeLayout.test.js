const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

test('home page header stays sticky above long host lists', async () => {
  const styles = await readFile(path.join(__dirname, '..', 'dist', 'renderer', 'tailwind.css'), 'utf8');

  assert.match(styles, /\.page-head[^{]*\{[^}]*position:sticky/);
  assert.match(styles, /\.page-head[^{]*\{[^}]*top:0/);
  assert.match(styles, /\.page-head[^{]*\{[^}]*z-index:40/);
});
