const test = require('node:test');
const assert = require('node:assert/strict');

const {
  sumElectronWorkingSetBytes,
  childMemoryCommand,
  parseChildWorkingSetBytes,
  collectAppMemoryUsage,
} = require('../dist/main/appMemory.js');

test('sumElectronWorkingSetBytes converts Electron KiB working sets to bytes', () => {
  assert.equal(
    sumElectronWorkingSetBytes([
      { memory: { workingSetSize: 1024 } },
      { memory: { workingSetSize: 512 } },
    ]),
    1572864
  );
});

test('childMemoryCommand selects safe platform-specific commands', () => {
  assert.deepEqual(childMemoryCommand('darwin', 1234), {
    file: 'ps',
    args: ['-o', 'rss=', '-p', '1234'],
  });
  assert.deepEqual(childMemoryCommand('linux', 1234), {
    file: 'ps',
    args: ['-o', 'rss=', '-p', '1234'],
  });
  assert.deepEqual(childMemoryCommand('win32', 1234), {
    file: 'powershell.exe',
    args: [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '(Get-Process -Id 1234 -ErrorAction Stop).WorkingSet64',
    ],
  });
  assert.equal(childMemoryCommand('freebsd', 1234), undefined);
  assert.equal(childMemoryCommand('linux', 0), undefined);
  assert.equal(childMemoryCommand('linux', 1.5), undefined);
});

test('parseChildWorkingSetBytes converts POSIX KiB and Windows byte output', () => {
  assert.equal(parseChildWorkingSetBytes('linux', ' 512\n'), 524288);
  assert.equal(parseChildWorkingSetBytes('darwin', '512'), 524288);
  assert.equal(parseChildWorkingSetBytes('win32', '524288'), 524288);
  assert.equal(parseChildWorkingSetBytes('linux', '512 KiB'), undefined);
  assert.equal(parseChildWorkingSetBytes('win32', '-1'), undefined);
  assert.equal(parseChildWorkingSetBytes('linux', '1.5'), undefined);
});

test('collectAppMemoryUsage combines Electron working sets and Mihomo RSS', async () => {
  const result = await collectAppMemoryUsage({
    metrics: () => [{ memory: { workingSetSize: 1024 } }],
    platform: 'linux',
    mihomoPid: 4321,
    run: async (file, args) => {
      assert.equal(file, 'ps');
      assert.deepEqual(args, ['-o', 'rss=', '-p', '4321']);
      return '512\n';
    },
  });

  assert.deepEqual(result, { bytes: 1572864 });
});

test('collectAppMemoryUsage returns Electron-only bytes when Mihomo lookup fails', async () => {
  const result = await collectAppMemoryUsage({
    metrics: () => [{ memory: { workingSetSize: 1024 } }],
    platform: 'linux',
    mihomoPid: 4321,
    run: async () => {
      throw new Error('process exited');
    },
  });

  assert.deepEqual(result, { bytes: 1048576 });
});

test('collectAppMemoryUsage returns empty data when Electron metrics fail', async () => {
  const result = await collectAppMemoryUsage({
    metrics: () => {
      throw new Error('metrics unavailable');
    },
    platform: 'linux',
  });

  assert.deepEqual(result, {});
});
