// Use the app's Node ABI for native SQLite in both development and tests.
const { readdirSync } = require('node:fs');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

const root = join(__dirname, '..');
const selected = process.argv.slice(2);
const files = selected.length ? selected : readdirSync(join(root, 'tests'))
  .filter((name) => name.endsWith('.test.js')).sort().map((name) => join(root, 'tests', name));
const result = spawnSync(require('electron'), ['--experimental-detect-module', '--test', ...files], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
});
if (result.error) {
  console.error('The Electron test runtime could not start.');
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
