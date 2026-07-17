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

test('compiled Kubernetes bridge exposes only typed renderer-safe channels', async () => {
  const dist = path.join(__dirname, '..', 'dist');
  const preload = await readFile(path.join(dist, 'main', 'preload.js'), 'utf8');
  const main = await readFile(path.join(dist, 'main', 'main.js'), 'utf8');

  assert.match(preload, /const kubernetesApi =/);
  assert.match(preload, /kubernetes:get-state/);
  assert.match(preload, /kubernetes:list-namespaces/);
  assert.match(preload, /kubernetes:reconnect/);
  assert.match(preload, /kubernetes:state/);
  assert.match(preload, /onTerminalOutput/);
  assert.match(preload, /kubernetes:terminal-output/);
  assert.match(preload, /setLogScope/);
  assert.match(preload, /kubernetes:set-log-scope/);
  assert.match(preload, /kubernetes:set-log-start-time/);
  assert.match(preload, /kubernetes:stop-all-port-forwards/);
  assert.match(main, /kubernetes:get-state/);
  assert.match(main, /kubernetes:list-namespaces/);
  assert.match(main, /kubernetes:reconnect/);
  assert.match(main, /kubernetes:state/);
  assert.match(main, /kubernetes:terminal-output/);
  assert.match(main, /kubernetes:set-log-scope/);
  assert.match(main, /kubernetes:set-log-start-time/);
  assert.match(main, /kubernetes:stop-all-port-forwards/);
  const scopeHandlerStart = main.indexOf('IPC_CHANNELS.kubernetesSetLogScope');
  const scopeHandlerEnd = main.indexOf('IPC_CHANNELS.kubernetesSetLogFollowing', scopeHandlerStart);
  assert.ok(scopeHandlerStart >= 0 && scopeHandlerEnd > scopeHandlerStart);
  const scopeHandler = main.slice(scopeHandlerStart, scopeHandlerEnd);
  assert.match(scopeHandler, /payload\.scope !== 'pod'.*payload\.scope !== 'deployment'/s);
  assert.doesNotMatch(scopeHandler, /selector|deploymentName/);
  const startTimeHandlerStart = main.indexOf('IPC_CHANNELS.kubernetesSetLogStartTime');
  const startTimeHandlerEnd = main.indexOf('IPC_CHANNELS.kubernetesClearLogs', startTimeHandlerStart);
  assert.ok(startTimeHandlerStart >= 0 && startTimeHandlerEnd > startTimeHandlerStart);
  const startTimeHandler = main.slice(startTimeHandlerStart, startTimeHandlerEnd);
  assert.match(startTimeHandler, /payload\.startTime/);
  assert.match(startTimeHandler, /validateKubernetesText\(payload\.startTime, 'log start time', 64\)/);
  assert.doesNotMatch(startTimeHandler, /podName|container|deploymentName|selector/);
  assert.doesNotMatch(preload, /client-certificate-data|exec\.command|token/);
});

test('compiled KubeVirt VNC bridge derives its loopback URL only in main and closes on launcher failure', async () => {
  const dist = path.join(__dirname, '..', 'dist');
  const preload = await readFile(path.join(dist, 'main', 'preload.js'), 'utf8');
  const main = await readFile(path.join(dist, 'main', 'main.js'), 'utf8');

  assert.match(preload, /openVnc:\s*\(input\)\s*=>\s*electron_1\.ipcRenderer\.invoke\('kubernetes:open-vnc', input\)/);
  const handlerStart = main.indexOf('IPC_CHANNELS.kubernetesOpenVnc');
  const handlerEnd = main.indexOf('IPC_CHANNELS.kubernetesStartPortForward', handlerStart);
  assert.ok(handlerStart >= 0 && handlerEnd > handlerStart);
  const handler = main.slice(handlerStart, handlerEnd);
  assert.match(handler, /openVnc\(validateKubernetesVncTarget\(input\)\)/);
  assert.match(handler, /viewerPassword = handle\.takeViewerPassword\(\)/);
  assert.match(handler, /`vnc:\$\{encodeURIComponent\(viewerPassword\)\}@127\.0\.0\.1`/);
  assert.match(handler, /shell\.openExternal\(`vnc:\/\/\$\{authority\}:\$\{handle\.localPort\}`\)/);
  assert.match(handler, /catch\s*\{[\s\S]*?handle\.close\(\)/);
  assert.doesNotMatch(handler, /input\.(?:url|vmiName|localPort)/);
  assert.doesNotMatch(preload, /viewerPassword|takeViewerPassword/);
  assert.doesNotMatch(handler.slice(handler.indexOf('return {')), /viewerPassword|authority/);
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

test('compiled main routes every normal quit through the asynchronous coordinator', async () => {
  const main = await readFile(path.join(__dirname, '..', 'dist', 'main', 'main.js'), 'utf8');
  const beforeQuitStart = main.indexOf("app.on('before-quit'");
  const beforeQuit = main.slice(beforeQuitStart, beforeQuitStart + 800);

  assert.ok(beforeQuitStart >= 0);
  assert.match(beforeQuit, /quitCoordinator\.canQuitImmediately\(\)/);
  assert.match(beforeQuit, /event\.preventDefault\(\)/);
  assert.match(beforeQuit, /requestQuitAfterRuntimeShutdown\(\)/);
  assert.match(main, /cleanup: shutdownRuntimesForQuit/);
  assert.match(main, /reportCleanupError: async \(error\) => \{[\s\S]*?await flushRuntimeLog\(\);/);
  assert.match(main, /function runFinalExitAction\(action\)/);
  assert.match(main, /setTimeout\(\(\) => process\.exit\(0\), FINAL_PROCESS_EXIT_DELAY_MS\)/);
  assert.match(main, /quit: \(\) => runFinalExitAction\(\(\) => electron_1\.app\.quit\(\)\)/);
  assert.match(main, /app\.on\('window-all-closed', \(\) => \{[\s\S]*?app\.quit\(\);/);
});

test('compiled main shares one guarded cleanup path for normal quits and terminal signals', async () => {
  const main = await readFile(path.join(__dirname, '..', 'dist', 'main', 'main.js'), 'utf8');

  assert.match(main, /process\.once\('SIGINT'/);
  assert.match(main, /process\.once\('SIGTERM'/);
  assert.match(main, /function requestQuitAfterRuntimeShutdown\(signal = false\)/);
  assert.match(main, /quitCoordinator\.request\(signal \? 'signal' : 'normal'\)/);
  assert.match(main, /exit: \(\) => runFinalExitAction\(\(\) => electron_1\.app\.exit\(0\)\)/);
});

test('compiled main aborts auto-start retries before proxy shutdown begins', async () => {
  const dist = path.join(__dirname, '..', 'dist', 'main');
  const main = await readFile(path.join(dist, 'main.js'), 'utf8');
  const coordinator = await readFile(path.join(dist, 'quitCoordinator.js'), 'utf8');

  assert.match(main, /abortAutoStart: \(\) => autoStartAbortController\.abort\(\)/);
  assert.ok(coordinator.indexOf('abortAutoStart()') < coordinator.indexOf('await this.options.cleanup()'));
  assert.match(main, /scheduleProxyAutoStart\)\(initializedProxyRuntime,[\s\S]*?autoStartAbortController\.signal\)/);
});

test('compiled updater requests cleanup before the coordinator launches NSIS', async () => {
  const dist = path.join(__dirname, '..', 'dist', 'main');
  const main = await readFile(path.join(dist, 'main.js'), 'utf8');
  const updater = await readFile(path.join(dist, 'updater.js'), 'utf8');

  assert.match(updater, /this\.requestInstall\(\);/);
  assert.match(updater, /installDownloadedUpdate\(\) \{[\s\S]*?autoUpdater\.quitAndInstall\(false, true\);/);
  assert.match(main, /quitCoordinator\.request\('install-update'\)/);
  assert.match(main, /installUpdate: \(\) => runFinalExitAction\(\(\) => updater\.installDownloadedUpdate\(\)\)/);
});
