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

test('compiled Proxy traffic contract keeps Mihomo controller data in the main process', async () => {
  const dist = path.join(__dirname, '..', 'dist');
  const html = await readFile(path.join(dist, 'renderer', 'index.html'), 'utf8');
  const proxyPage = await readFile(path.join(dist, 'renderer', 'proxyPage.js'), 'utf8');
  const preload = await readFile(path.join(dist, 'main', 'preload.js'), 'utf8');
  const main = await readFile(path.join(dist, 'main', 'main.js'), 'utf8');

  assert.match(html, /id="proxy-traffic"/);
  assert.match(preload, /onProxyTrafficChanged/);
  assert.match(main, /proxy:traffic/);
  assert.match(proxyPage, /onProxyTrafficChanged/);
  assert.match(proxyPage, /↓ \$\{formatTrafficRate\(traffic\.downBytesPerSecond\)\} · ↑ \$\{formatTrafficRate\(traffic\.upBytesPerSecond\)\}/);
  assert.match(proxyPage, /trafficReadout\.textContent/);
  assert.doesNotMatch(proxyPage, /trafficReadout\.innerHTML/);
});

test('compiled renderer marks automatic service refreshes silent and does not toast silent status errors', async () => {
  const dist = path.join(__dirname, '..', 'dist');
  const renderer = await readFile(path.join(dist, 'renderer', 'renderer.js'), 'utf8');
  const preload = await readFile(path.join(dist, 'main', 'preload.js'), 'utf8');

  assert.match(renderer, /refreshService\(host\.id, service\.id, \{ silent \}\)/);
  assert.match(renderer, /!change\.silent && change\.status === 'error'/);
  assert.match(preload, /refreshService: \(hostId, serviceId, options\)/);
});

test('compiled main preserves silent refreshes through every forward-status re-emission', async () => {
  const main = await readFile(path.join(__dirname, '..', 'dist', 'main', 'main.js'), 'utf8');
  const refreshStart = main.indexOf('IPC_CHANNELS.refreshService');
  const refreshEnd = main.indexOf('IPC_CHANNELS.startService', refreshStart);
  const refreshHandler = main.slice(refreshStart, refreshEnd);
  const forwardReemissions = refreshHandler.match(/emitForwardStatus\([^;]*?\);/g) ?? [];

  assert.match(
    main,
    /function emitForwardStatus\(hostId, serviceId, state, error, silent = false\) \{[\s\S]*?emitStatus\(hostId, serviceId, current\.status, current\.pid, current\.error, silent\);/
  );
  assert.equal(forwardReemissions.length, 4);
  for (const reemission of forwardReemissions) {
    assert.match(reemission, /, Boolean\(payload\.silent\)\);$/);
  }
});

test('compiled main waits for runtime diagnostics before every normal quit continues', async () => {
  const main = await readFile(path.join(__dirname, '..', 'dist', 'main', 'main.js'), 'utf8');
  const beforeQuitStart = main.indexOf("app.on('before-quit'");
  const beforeQuit = main.slice(beforeQuitStart, beforeQuitStart + 800);

  assert.ok(beforeQuitStart >= 0);
  assert.match(beforeQuit, /event\.preventDefault\(\)/);
  assert.match(beforeQuit, /requestQuitAfterRuntimeShutdown\(\)/);
  assert.match(main, /await flushRuntimeLog\(\);[\s\S]*?allowQuitAfterRuntimeShutdown = true;[\s\S]*?app\.quit\(\);/);
  assert.match(
    main,
    /quitShutdownPromise = shutdownRuntimesForQuit\(\)\.catch\(async \(error\) => \{[\s\S]*?logRuntimeError\('app:shutdown', error, \{ operation: 'runtime-stop' \}\);[\s\S]*?await flushRuntimeLog\(\);/
  );
  assert.match(main, /app\.on\('window-all-closed', \(\) => \{[\s\S]*?app\.quit\(\);/);
});

test('compiled main shares one guarded cleanup path for normal quits and terminal signals', async () => {
  const main = await readFile(path.join(__dirname, '..', 'dist', 'main', 'main.js'), 'utf8');

  assert.match(main, /process\.once\('SIGINT'/);
  assert.match(main, /process\.once\('SIGTERM'/);
  assert.match(main, /function requestQuitAfterRuntimeShutdown\(signal = false\)/);
  assert.match(main, /await flushRuntimeLog\(\);[\s\S]*?allowQuitAfterRuntimeShutdown = true;[\s\S]*?app\.exit\(0\);/);
  assert.match(main, /if \(signal\) \{[\s\S]*?app\.exit\(0\);[\s\S]*?\}\s*else \{[\s\S]*?app\.quit\(\);/);
});

test('compiled main aborts auto-start retries before proxy shutdown begins', async () => {
  const main = await readFile(path.join(__dirname, '..', 'dist', 'main', 'main.js'), 'utf8');

  assert.match(main, /autoStartAbortController\.abort\(\);[\s\S]*?shutdownRuntimesForQuit\(\)/);
  assert.match(main, /scheduleProxyAutoStart\)\(initializedProxyRuntime,[\s\S]*?autoStartAbortController\.signal\)/);
});
