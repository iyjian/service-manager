const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

async function readRendererSource() {
  return readFile(path.join(__dirname, '..', 'src', 'renderer', 'renderer.ts'), 'utf8');
}

function section(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.ok(startIndex >= 0, `Missing section start: ${start}`);
  assert.ok(endIndex > startIndex, `Missing section end: ${end}`);
  return source.slice(startIndex, endIndex);
}

test('Hosts runtime status updates coalesce per resource and replace only the matching row', async () => {
  const renderer = await readRendererSource();
  const localUpdates = section(renderer, 'function findRenderedHostPanel', 'function renderPageStats');

  assert.match(renderer, /const pendingRuntimeStatusDomUpdates = new Map<string, RuntimeStatusDomTarget>\(\)/);
  assert.match(localUpdates, /pendingRuntimeStatusDomUpdates\.set\(key, target\)/);
  assert.match(localUpdates, /window\.requestAnimationFrame\(flushRuntimeStatusDomUpdates\)/);
  assert.match(localUpdates, /replaceRenderedServiceRow\(update\.hostId, update\.itemId\)/);
  assert.match(localUpdates, /replaceRenderedForwardRow\(update\.hostId, update\.itemId\)/);
  assert.match(localUpdates, /currentRow\.replaceWith\(createServiceRuntimeRow\(host, service\)\)/);
  assert.match(localUpdates, /currentRow\.replaceWith\(createForwardRuntimeRow\(host, host\.forwards\[forwardIndex\], forwardIndex\)\)/);
  assert.match(localUpdates, /panel\.classList\.contains\('host-panel-collapsed'\)/);
  assert.match(localUpdates, /needsFullRender \|\|= !updated/);
  assert.match(localUpdates, /renderSafely\('runtime-status-fallback-render'\)/);
});

test('Hosts runtime row builders retain status details and action behavior after local replacement', async () => {
  const renderer = await readRendererSource();
  const forwardRow = section(renderer, 'function createForwardRuntimeRow', 'function createServiceRuntimeRow');
  const serviceRow = section(renderer, 'function createServiceRuntimeRow', 'function findRenderedHostPanel');
  const renderHosts = section(renderer, 'function render(): void', 'const HOSTS_NAV_ICON');

  assert.match(renderHosts, /panel\.dataset\.hostId = host\.id/);
  assert.match(renderHosts, /createForwardRuntimeRow\(host, forward, index\)/);
  assert.match(renderHosts, /createServiceRuntimeRow\(host, service\)/);

  assert.match(forwardRow, /item\.dataset\.forwardId = forward\.id/);
  assert.match(forwardRow, /status-retry/);
  assert.match(forwardRow, /data-tooltip/);
  assert.match(forwardRow, /renderTunnelPort\(forward\)/);
  assert.match(forwardRow, /renderRuntimeActionButton\('start-forward'/);
  assert.match(forwardRow, /window\.serviceApi\.startForward\(host\.id, forward\.id\)/);
  assert.match(forwardRow, /window\.serviceApi\.stopForward\(host\.id, forward\.id\)/);

  assert.match(serviceRow, /item\.dataset\.serviceId = service\.id/);
  assert.match(serviceRow, /Open logs \(PID \$\{service\.pid\}, \$\{formatStatus\(service\.status\)\}\)/);
  assert.match(serviceRow, /data-tooltip/);
  assert.match(serviceRow, /renderServicePort\(service\)/);
  assert.match(serviceRow, /renderRuntimeActionButton\('start'/);
  assert.match(serviceRow, /window\.serviceApi\.startService\(host\.id, service\.id\)/);
  assert.match(serviceRow, /window\.serviceApi\.stopService\(host\.id, service\.id\)/);
  assert.match(serviceRow, /openServiceLogDialog\(host, service\.id\)/);
});

test('Service and forward status IPC handlers schedule local updates without direct full renders', async () => {
  const renderer = await readRendererSource();
  const serviceHandler = section(
    renderer,
    'window.serviceApi.onServiceStatusChanged',
    'window.serviceApi.onForwardStatusChanged',
  );
  const forwardHandler = section(
    renderer,
    'window.serviceApi.onForwardStatusChanged',
    'window.serviceApi.onUpdateStateChanged',
  );

  assert.match(serviceHandler, /scheduleRuntimeStatusDomUpdate\(\{[\s\S]*?kind: 'service'/);
  assert.match(serviceHandler, /serviceLogTitle\.textContent/);
  assert.doesNotMatch(serviceHandler, /renderSafely\(/);
  assert.match(forwardHandler, /scheduleRuntimeStatusDomUpdate\(\{[\s\S]*?kind: 'forward'/);
  assert.doesNotMatch(forwardHandler, /renderSafely\(/);
});
