const assert = require('node:assert/strict');
const { mkdtemp, readFile, rm, stat } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  DEVELOPMENT_USER_DATA_DIRECTORY_NAME,
  configureRuntimeDataProfile,
} = require('../dist/main/core/appRuntimeProfile');

test('packaged runtime leaves Electron data paths untouched', () => {
  const calls = [];
  const result = configureRuntimeDataProfile({
    isPackaged: true,
    getPath: (name) => {
      calls.push(['getPath', name]);
      return '/unused';
    },
    setPath: (name, value) => calls.push(['setPath', name, value]),
  });

  assert.equal(result, undefined);
  assert.deepEqual(calls, []);
});

test('development runtime owns a private userData and sessionData root', async (t) => {
  const appDataPath = await mkdtemp(
    path.join(os.tmpdir(), 'service-manager-runtime-profile-'),
  );
  t.after(() => rm(appDataPath, { recursive: true, force: true }));
  const calls = [];
  const expectedRoot = path.join(appDataPath, DEVELOPMENT_USER_DATA_DIRECTORY_NAME);

  const result = configureRuntimeDataProfile({
    isPackaged: false,
    getPath: (name) => {
      calls.push(['getPath', name]);
      return appDataPath;
    },
    setPath: (name, value) => calls.push(['setPath', name, value]),
  });

  assert.equal(result, expectedRoot);
  assert.deepEqual(calls, [
    ['getPath', 'appData'],
    ['setPath', 'userData', expectedRoot],
    ['setPath', 'sessionData', expectedRoot],
  ]);
  assert.equal((await stat(expectedRoot)).isDirectory(), true);
  if (process.platform !== 'win32') {
    assert.equal((await stat(expectedRoot)).mode & 0o777, 0o700);
  }
});

test('Electron entry selects its runtime profile before loading main', async () => {
  const packageManifest = require('../package.json');
  const bootstrap = await readFile(path.join(__dirname, '../dist/main/core/bootstrap.js'), 'utf8');
  const profileSelection = bootstrap.lastIndexOf('configureRuntimeDataProfile');
  const mainLoad = bootstrap.indexOf("require('./main')");

  assert.equal(packageManifest.main, 'dist/main/core/bootstrap.js');
  assert.ok(profileSelection >= 0);
  assert.ok(mainLoad > profileSelection);
});
