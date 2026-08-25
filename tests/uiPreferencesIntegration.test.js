const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

test('UI preferences use narrow get, save, and change-notification IPC channels', async () => {
  const [mainEntry, ipcChannels, preload] = await Promise.all([
    fs.readFile(path.join(root, 'dist', 'main', 'core', 'main.js'), 'utf8'),
    fs.readFile(path.join(root, 'dist', 'main', 'core', 'ipcChannels.js'), 'utf8'),
    fs.readFile(path.join(root, 'dist', 'main', 'core', 'preload.js'), 'utf8'),
  ]);
  const main = `${mainEntry}\n${ipcChannels}`;

  assert.match(main, /settings:ui:get/);
  assert.match(main, /settings:ui:save/);
  assert.match(main, /settings:ui:notes-sidebar-width:save/);
  assert.match(main, /settings:ui:changed/);
  assert.match(main, /ui-preferences\.json/);
  assert.match(preload, /getUiPreferences:\s*\(\)\s*=>[^\n]+settings:ui:get/);
  assert.match(preload, /saveUiPreferences:\s*\(draft\)\s*=>[^\n]+settings:ui:save/);
  assert.match(preload, /saveNotesSidebarWidth:\s*\(width\)\s*=>[\s\S]+?settings:ui:notes-sidebar-width:save/);
  assert.match(preload, /onUiPreferencesChanged/);
  assert.doesNotMatch(preload, /ui-preferences\.json/);
});
