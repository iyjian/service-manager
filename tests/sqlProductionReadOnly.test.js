const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

test('Production SQL relies on the read-only database account without a mutation confirmation', async () => {
  const page = await readFile(
    path.join(__dirname, '..', 'dist', 'renderer', 'pages', 'sqlPage.js'),
    'utf8',
  );

  assert.match(page, /window\.sqlApi\.execute/);
  assert.doesNotMatch(page, /isLikelyReadOnlySql/);
  assert.doesNotMatch(page, /Run in Production\?/);
  assert.doesNotMatch(page, /may change Production data/);
});
