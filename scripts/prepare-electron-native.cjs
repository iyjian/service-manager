// pnpm isolates transitive executables; resolve the installed prebuild tool from
// better-sqlite3 instead of depending on a hoisted prebuild-install command.
const { spawnSync } = require('node:child_process');
const { dirname } = require('node:path');

const electron = require('electron');
const environment = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
const probe = () => spawnSync(electron, ['-e',
  'const Database = require("better-sqlite3"); const db = new Database(":memory:"); db.prepare("SELECT 1").get(); db.close();',
], { env: environment, stdio: 'ignore' });

if (probe().status !== 0) {
  const moduleRoot = dirname(require.resolve('better-sqlite3/package.json'));
  const installer = require.resolve('prebuild-install/bin.js', { paths: [moduleRoot] });
  const version = require('electron/package.json').version;
  const result = spawnSync(process.execPath, [installer, '--runtime=electron', `--target=${version}`,
    `--platform=${process.platform}`, `--arch=${process.arch}`], {
    cwd: moduleRoot, stdio: 'inherit', env: process.env,
  });
  if (result.status !== 0 || probe().status !== 0) {
    console.error('SQLite could not be prepared for Electron. Rebuild better-sqlite3 for the installed Electron version before starting or testing the app.');
    process.exitCode = 1;
  }
}
