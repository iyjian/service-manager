const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const projectRoot = path.join(__dirname, '..');
const rendererRoot = path.join(projectRoot, 'dist', 'renderer');
const mainRoot = path.join(projectRoot, 'dist', 'main');

async function loadGate() {
  return import(pathToFileURL(path.join(rendererRoot, 'utils', 'startupS3SyncGate.js')).href);
}

test('startup S3 loading detail follows the current bounded sync phase and count', async () => {
  const { startupS3SyncDetail } = await loadGate();

  assert.equal(startupS3SyncDetail({
    status: 'checking',
    syncState: { status: 'pending', pending: true },
  }), 'Checking S3 synchronization status…');
  assert.equal(startupS3SyncDetail({
    status: 'syncing',
    syncState: {
      status: 'syncing',
      pending: false,
      phase: 'uploading',
      completedItems: 3,
      totalItems: 8,
    },
  }), 'Uploading synchronized data… 3 of 8');
  assert.equal(startupS3SyncDetail({
    status: 'syncing',
    syncState: { status: 'syncing', pending: false, phase: 'applying' },
  }), 'Applying synchronized data…');
});

test('application startup owns an inert S3 overlay until main sync and renderer apply settle', async () => {
  const [html, styles, renderer, gate, preload, mainEntry, ipcChannels] = await Promise.all([
    readFile(path.join(rendererRoot, 'index.html'), 'utf8'),
    readFile(path.join(rendererRoot, 'tailwind.css'), 'utf8'),
    readFile(path.join(rendererRoot, 'renderer.js'), 'utf8'),
    readFile(path.join(rendererRoot, 'utils', 'startupS3SyncGate.js'), 'utf8'),
    readFile(path.join(mainRoot, 'core', 'preload.js'), 'utf8'),
    readFile(path.join(mainRoot, 'core', 'main.js'), 'utf8'),
    readFile(path.join(mainRoot, 'core', 'ipcChannels.js'), 'utf8'),
  ]);
  const main = `${mainEntry}\n${ipcChannels}`;

  assert.match(html, /id="app-startup-sync"[^>]*role="status"[^>]*aria-busy="true"/);
  assert.match(html, /id="app-layout" class="app-layout" inert aria-hidden="true"/);
  assert.match(styles, /\.app-startup-sync\{[^}]*position:fixed[^}]*z-index:200/);
  assert.match(gate, /onStartupS3SyncStateChanged\(renderStartupState\)/);
  assert.match(gate, /pendingRendererWork > 0/);
  assert.match(gate, /appLayout\.inert = false/);
  assert.match(renderer, /await startupS3SyncReady;\s*initNav\('hosts'\);/);
  assert.match(renderer, /trackStartupS3SyncWork\(reload\)/);
  assert.match(preload, /getStartupS3SyncState:[\s\S]*?invoke\('app:startup-s3-sync:get'\)/);
  assert.match(preload, /onStartupS3SyncStateChanged:[\s\S]*?on\('app:startup-s3-sync:state'/);
  assert.match(main, /app:startup-s3-sync:get/);
  assert.match(main, /app:startup-s3-sync:state/);
});
