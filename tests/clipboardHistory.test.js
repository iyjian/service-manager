const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createRequire } = require('node:module');
const vm = require('node:vm');
const { ClipboardHistoryStore, MAX_CLIPBOARD_BYTES } = require('../dist/main/core/clipboardHistoryStore');

function fixture(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'clipboard-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'clipboard-local', 'history.json');
  return { dir, file, store: new ClipboardHistoryStore(file, 'Control+Alt+V') };
}

test('history retains the latest 20 unique entries, moves repeated content first, and survives restart', t => {
  const { store, file } = fixture(t);
  for (let i = 0; i < 25; i++) store.capture('text', `entry ${i}`);
  assert.equal(store.entries.length, 20);
  assert.equal(store.entries[19].value, 'entry 5');
  assert.equal(store.capture('text', 'entry 24'), false);
  store.capture('text', 'entry 5');
  assert.equal(store.entries[0].value, 'entry 5');
  assert.equal(store.entries.length, 20);
  const restored = new ClipboardHistoryStore(file, 'Control+Alt+V');
  assert.deepEqual(restored.entries, store.entries);
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('deleting or clearing does not recapture unchanged system clipboard content', t => {
  const { store, file } = fixture(t);
  store.capture('text', 'first');
  store.forget(store.entries[0].id);
  assert.equal(store.capture('text', 'first'), false);
  store.capture('text', 'second');
  store.forget();
  assert.equal(store.capture('text', 'second'), false);
  assert.equal(new ClipboardHistoryStore(file, '').entries.length, 0);
  store.capture('text', '');
  assert.equal(store.capture('text', 'second'), true);
});

test('invalid images and oversized content are rejected and invalid persisted entries are filtered', t => {
  const { store, file } = fixture(t);
  assert.equal(store.capture('text', 'x'.repeat(MAX_CLIPBOARD_BYTES + 1)), false);
  assert.equal(store.capture('image', 'https://example.com/image.png'), false);
  store.save();
  writeFileSync(file, JSON.stringify({ entries: [null, { id: 'bad', createdAt: 0, kind: 'html', value: '<script>' }] }));
  assert.deepEqual(new ClipboardHistoryStore(file, '').entries, []);
});

test('settings and image payloads persist through an encryption adapter; unreadable data is preserved', t => {
  const { file } = fixture(t);
  const encode = value => Buffer.from(value).map(byte => byte ^ 123);
  const decode = value => Buffer.from(value).map(byte => byte ^ 123).toString();
  const store = new ClipboardHistoryStore(file, 'Control+Alt+V', encode, decode);
  store.enabled = false;
  store.accelerator = 'Control+Shift+H';
  store.capture('image', 'data:image/png;base64,YQ==');
  assert.equal(readFileSync(file).includes(Buffer.from('data:image')), false);
  const reopened = new ClipboardHistoryStore(file, '', encode, decode);
  assert.equal(reopened.enabled, false);
  assert.equal(reopened.accelerator, 'Control+Shift+H');
  assert.equal(reopened.entries.length, 1);
  const original = readFileSync(file);
  assert.throws(() => new ClipboardHistoryStore(file, ''));
  assert.deepEqual(readFileSync(file), original);
});

function runtime(t, platform = 'darwin') {
  const { dir } = fixture(t);
  const handlers = new Map();
  const shortcuts = new Map();
  let capture;
  let popup;
  let written;
  const commands = [];
  const targets = [];
  class Popup {
    constructor() { popup = this; this.webContents = { send() {}, setWindowOpenHandler() {}, on() {} }; }
    setVisibleOnAllWorkspaces() {}
    on() {}
    isDestroyed() { return false; }
    isVisible() { return Boolean(this.visible); }
    async loadURL() {}
    setPosition(x, y) { this.position = { x, y }; }
    show() { this.visible = true; }
    hide() { this.visible = false; }
    focus() {}
  }
  const mock = {
    BrowserWindow: Popup,
    screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }), getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1000, height: 800 } }) },
    systemPreferences: { isTrustedAccessibilityClient: () => true },
    dialog: { showMessageBox: async () => ({}) },
    app: { getPath: () => dir, on() {}, focus() {} },
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    safeStorage: { isEncryptionAvailable: () => false },
    clipboard: { availableFormats: () => [], readText: () => 'copied text', writeText: text => { written = text; } },
    globalShortcut: {
      register(key, callback) { if (key === 'Control+X') return false; shortcuts.set(key, callback); return true; },
      unregister: key => shortcuts.delete(key),
    },
  };
  const filename = path.resolve(__dirname, '../dist/main/core/clipboardHistory.js');
  const realRequire = createRequire(filename);
  const exports = {};
  vm.runInNewContext(readFileSync(filename, 'utf8'), {
    exports, require: name => name === 'electron' ? mock : name === './clipboardPasteTarget' ? {
      clipboardPopupPosition: realRequire('./clipboardPasteTarget').clipboardPopupPosition,
      captureClipboardPasteTarget: async () => {
        const target = { anchor: { x: 180, y: 100, width: 1, height: 20 }, disposed: false,
          async paste() { commands.push('paste'); }, async restore() { commands.push('restore'); },
          dispose() { this.disposed = true; } };
        targets.push(target);
        return target;
      },
    } : name === 'node:child_process'
      ? { execFile: (file, args, _options, callback) => { commands.push([file, args]); callback(null, '123'); } } : realRequire(name),
    process: { platform, env: {} }, Buffer, __dirname: path.dirname(filename),
    setInterval: callback => { capture = callback; }, clearInterval() {},
  });
  exports.registerClipboardHistory(id => id === 1);
  const invoke = (channel, value, sender = 1) => handlers.get(channel)({ sender: { id: sender } }, value);
  return { invoke, shortcuts, capture, mock, dir, commands, targets, getPopup: () => popup, getWritten: () => written,
    invokePopup: (action, id) => handlers.get('clipboard-history:action')({ sender: popup?.webContents }, action, id) };
}

test('shortcut conflict rolls back registration and unauthorized settings calls are rejected', t => {
  const { invoke, shortcuts } = runtime(t);
  assert.equal(shortcuts.has('Control+Alt+V'), true);
  assert.throws(() => invoke('settings:shortcuts:get', undefined, 99));
  assert.throws(() => invoke('settings:shortcuts:save', { enabled: true, accelerator: 'V' }));
  assert.throws(() => invoke('settings:shortcuts:save', { enabled: true, accelerator: 'Control+X' }));
  assert.equal(shortcuts.has('Control+Alt+V'), true);
  invoke('settings:shortcuts:save', { enabled: false, accelerator: 'Control+Alt+V' });
  assert.equal(shortcuts.size, 0);
  invoke('settings:shortcuts:save', { enabled: true, accelerator: 'Control+Shift+H' });
  assert.equal(shortcuts.has('Control+Shift+H'), true);
});

test('Windows never registers shortcuts or monitors the clipboard', t => {
  const { invoke, capture, shortcuts } = runtime(t, 'win32');
  assert.equal(invoke('settings:shortcuts:get').supported, false);
  assert.equal(capture, undefined);
  assert.equal(shortcuts.size, 0);
});

test('concealed clipboard formats and paused collection are not persisted', t => {
  const { invoke, capture, mock, dir } = runtime(t);
  mock.clipboard.availableFormats = () => ['org.nspasteboard.ConcealedType'];
  capture();
  const file = path.join(dir, 'clipboard-local', 'history.json');
  assert.equal(new ClipboardHistoryStore(file, '').entries.length, 0);
  mock.clipboard.availableFormats = () => [];
  capture();
  assert.equal(new ClipboardHistoryStore(file, '').entries.length, 1);
  invoke('settings:shortcuts:save', { enabled: false, accelerator: 'Control+Alt+V' });
  mock.clipboard.readText = () => 'paused text';
  capture();
  assert.equal(new ClipboardHistoryStore(file, '').entries.length, 1);
});

test('picker pastes the selected entry to its original target and restores the global shortcut', async t => {
  const runtimeState = runtime(t);
  const { shortcuts, invokePopup, commands, getWritten } = runtimeState;
  await assert.rejects(invokePopup('list'));
  shortcuts.get('Control+Alt+V')();
  await new Promise(resolve => setImmediate(resolve));
  const entries = await invokePopup('list');
  assert.equal(entries.length, 1);
  await invokePopup('paste', entries[0].id);
  assert.equal(getWritten(), 'copied text');
  assert.equal(shortcuts.has('Control+Alt+V'), true);
  assert.deepEqual(commands, ['paste']);
  assert.equal(runtimeState.targets[0].disposed, true);
  assert.deepEqual(runtimeState.getPopup().position, { x: 180, y: 126 });
  assert.equal(runtimeState.getPopup().visible, false);
});

test('permission denial is reported before showing a picker that cannot paste', async t => {
  const { shortcuts, invokePopup, mock, getWritten, commands, getPopup } = runtime(t);
  mock.systemPreferences.isTrustedAccessibilityClient = () => false;
  shortcuts.get('Control+Alt+V')();
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(invokePopup('list'));
  assert.equal(getPopup(), undefined);
  assert.equal(getWritten(), undefined);
  assert.equal(shortcuts.has('Control+Alt+V'), true);
  assert.equal(commands.length, 0);
});

test('Escape restores the target without pasting, and hidden picker cannot paste again', async t => {
  const { shortcuts, invokePopup, commands, targets } = runtime(t);
  shortcuts.get('Control+Alt+V')();
  await new Promise(resolve => setImmediate(resolve));
  const entries = await invokePopup('list');
  await invokePopup('close');
  assert.deepEqual(commands, ['restore']);
  assert.equal(targets[0].disposed, true);
  await assert.rejects(invokePopup('paste', entries[0].id));
});

test('failed target focus keeps the picker open with an error and restores its shortcut', async t => {
  const { shortcuts, invokePopup, targets, getPopup } = runtime(t);
  shortcuts.get('Control+Alt+V')();
  await new Promise(resolve => setImmediate(resolve));
  const entries = await invokePopup('list');
  targets[0].paste = async () => { throw new Error('Target closed'); };
  await assert.rejects(invokePopup('paste', entries[0].id), /Target closed/);
  assert.equal(getPopup().isVisible(), true);
  assert.equal(targets[0].disposed, true);
  assert.equal(shortcuts.has('Control+Alt+V'), true);
  await assert.rejects(invokePopup('paste', entries[0].id));
});

test('popup positioning follows the caret and stays inside offset monitor work areas', () => {
  const { clipboardPopupPosition } = require('../dist/main/core/clipboardPasteTarget');
  assert.deepEqual(clipboardPopupPosition({ x: 200, y: 100, width: 1, height: 20 },
    { x: 0, y: 0, width: 1000, height: 800 }), { x: 200, y: 126 });
  assert.deepEqual(clipboardPopupPosition({ x: -10, y: 750, width: 1, height: 20 },
    { x: -1200, y: 0, width: 1200, height: 800 }), { x: -360, y: 284 });
});
