const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');

function fixture(registry) {
  const handlers = new Map(), surfaces = new Set();
  let nextId = 0, focused;
  class Contents extends EventEmitter {
    id = ++nextId; destroyed = false; loads = []; messages = [];
    isDestroyed() { return this.destroyed; }
    setWindowOpenHandler(handler) { this.windowOpen = handler; }
    async loadURL(url) { this.loads.push(url); }
    send(...message) { this.messages.push(message); }
    focus() {}
    close() { if (!this.destroyed) { this.destroyed = true; this.emit('destroyed'); } }
  }
  class Container {
    children = [];
    addChildView(view) { assert.ok(!this.children.includes(view)); this.children.push(view); }
    removeChildView(view) { this.children = this.children.filter(child => child !== view); }
  }
  class Window extends EventEmitter {
    static getFocusedWindow() { return focused; }
    contentView = new Container(); webContents = new Contents(); destroyed = false;
    constructor(options) { super(); this.options = options; focused = this; }
    loadURL(url) { return this.webContents.loadURL(url); }
    getContentSize() { return [1100, 700]; }
    show() { this.visible = true; }
    hide() { this.visible = false; }
    focus() { focused = this; }
    isDestroyed() { return this.destroyed; }
    isMinimized() { return false; }
    restore() {}
    close() { const event = { prevented: false, preventDefault() { this.prevented = true; } }; this.emit('close', event); if (!event.prevented) this.destroy(); }
    destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('closed'); } }
  }
  class WebContentsView { webContents = new Contents(); setBounds(bounds) { this.bounds = bounds; } }
  const electron = { BrowserWindow: Window, WebContentsView, ipcMain: { handle: (key, action) => handlers.set(key, action), removeHandler: key => handlers.delete(key) } };
  const original = Module._load;
  const modulePath = require.resolve('../dist/main/core/panelWindows');
  delete require.cache[modulePath];
  Module._load = function(name, parent, ...rest) {
    if (name === 'electron') return electron;
    if (name === './appWindow' && parent?.filename === modulePath) return { APP_ICON_PATH: '/test/icon.png' };
    return original.call(this, name, parent, ...rest);
  };
  let exports; try { exports = require(modulePath); } finally { Module._load = original; }
  const closed = [], created = [];
  const manager = new exports.PanelWindowManager({ registry, rendererWindows: surfaces,
    onSurfaceCreated: s => created.push(s), onSurfaceClosed: s => closed.push(s), canQuitImmediately: () => false,
    requestQuit() {}, startSync() {}, closeShortcut: () => false, requestCloseShortcut: async () => false, report: (_scope, e) => { throw e; },
  });
  const state = sender => handlers.get('panels:get-state')({ sender });
  return { manager, handlers, surfaces, created, closed, state, validatePanelId: exports.validatePanelId };
}

test('all panels detach and merge the exact live view, without reloads or session disposal', () => {
  const f = fixture();
  try {
    for (const id of ['hosts', 'proxy', 'kubernetes', 'sql', 'notes']) {
      f.manager.activate(id);
      const view = f.manager.mainWindow.contentView.children[0];
      view.webContents.unsavedDraft = 'in-progress';
      f.manager.detach(id);
      assert.equal(f.manager.mainWindow.contentView.children.length, 0);
      assert.equal(f.state(view.webContents).detached, true);
      f.manager.merge(id);
      assert.equal(f.manager.mainWindow.contentView.children[0], view);
      assert.equal(view.webContents.loads.length, 1);
      assert.equal(view.webContents.unsavedDraft, 'in-progress');
      assert.equal(view.webContents.isDestroyed(), false);
      assert.equal(f.state(view.webContents).detached, false);
    }
    assert.equal(f.surfaces.size, 5);
    assert.equal(f.closed.length, 0);
  } finally { f.manager.dispose(); }
  assert.equal(f.surfaces.size, 0);
  assert.equal(f.closed.length, 5);
});
test('closing an independent window merges it back and switching docked panels preserves both views', () => {
  const f = fixture();
  try {
    f.manager.activate('hosts'); const hosts = f.manager.mainWindow.contentView.children[0];
    f.manager.activate('notes'); const notes = f.manager.mainWindow.contentView.children[0];
    f.manager.detach('notes'); const detached = f.manager.primaryWindow();
    f.manager.activate('hosts'); assert.equal(f.manager.mainWindow.contentView.children[0], hosts);
    detached.close();
    assert.equal(f.manager.mainWindow.contentView.children[0], notes);
    assert.equal(notes.webContents.isDestroyed(), false);
    assert.equal(notes.webContents.loads.length, 1);
  } finally { f.manager.dispose(); }
});
test('window IPC rejects unknown senders and panel identifiers', () => {
  const f = fixture();
  try {
    assert.throws(() => f.handlers.get('panels:activate')({ sender: {} }, 'hosts'), /Unknown panel window/);
    for (const id of ['__proto__', 'constructor', '../notes', null]) assert.throws(() => f.validatePanelId(id), /Unknown panel/);
    assert.throws(() => f.handlers.get('panels:detach')({ sender: f.manager.mainWindow.webContents }), /Select a panel/);
  } finally { f.manager.dispose(); }
});

test('a future registered panel automatically supports listing, detach and merge', () => {
  const { PanelRegistry } = require('../dist/main/core/panelRegistry');
  const registry = new PanelRegistry([{ id: 'future-panel', title: 'Future Panel' }]);
  const f = fixture(registry);
  try {
    const sender = f.manager.mainWindow.webContents;
    assert.deepEqual(f.handlers.get('panels:list')({ sender }), [{ id: 'future-panel', title: 'Future Panel' }]);
    assert.throws(() => f.handlers.get('panels:list')({ sender: {} }), /Unknown panel window/);
    f.handlers.get('panels:activate')({ sender }, 'future-panel');
    const view = f.manager.mainWindow.contentView.children[0];
    f.handlers.get('panels:detach')({ sender: view.webContents });
    assert.equal(f.state(view.webContents).detached, true);
    f.handlers.get('panels:merge')({ sender: view.webContents });
    assert.equal(f.manager.mainWindow.contentView.children[0], view);
    assert.equal(view.webContents.loads.length, 1);
  } finally { f.manager.dispose(); }
});

test('registry rejects invalid definitions and does not retain mutable caller metadata', () => {
  const { PanelRegistry } = require('../dist/main/core/panelRegistry');
  for (const definitions of [[], [{ id: '../bad', title: 'Bad' }], [{ id: 'ok', title: '' }], [{ id: 'ok', title: 'One' }, { id: 'ok', title: 'Two' }]]) {
    assert.throws(() => new PanelRegistry(definitions));
  }
  const definition = { id: 'future', title: 'Future' };
  const registry = new PanelRegistry([definition]);
  definition.title = 'Changed';
  assert.equal(registry.title('future'), 'Future');
  assert.throws(() => registry.validate('constructor'), /Unknown panel/);
});
