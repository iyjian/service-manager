const assert = require('node:assert/strict');
const test = require('node:test');

class Element {
  constructor() {
    this.children = []; this.listeners = new Map(); this.attributes = new Map();
    this.style = { height: '', maxHeight: '' }; this.clientHeight = 800; this.textContent = '';
    const classes = new Set();
    this.classList = { add: (v) => classes.add(v), remove: (v) => classes.delete(v), contains: (v) => classes.has(v), toggle: (v, on) => on ? classes.add(v) : classes.delete(v) };
  }
  append(...children) { for (const child of children) { child.remove(); child.parentElement = this; this.children.push(child); } }
  appendChild(child) { this.append(child); return child; }
  replaceChildren(...children) { for (const child of [...this.children]) child.remove(); this.append(...children); }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((child) => child !== this); this.parentElement = undefined; }
  setAttribute(k, v) { this.attributes.set(k, v); }
  getAttribute(k) { return this.attributes.get(k); }
  addEventListener(k, v) { this.listeners.set(k, v); }
  removeEventListener(k) { this.listeners.delete(k); }
  getBoundingClientRect() { return { height: parseFloat(this.style.height) || 300 }; }
  focus() {} scrollIntoView() {} hasPointerCapture() { return false; } setPointerCapture() {} releasePointerCapture() {}
}

async function harness(run) {
  const previous = { window: global.window, document: global.document };
  const instances = [], frames = [], sent = [], resized = [], closed = [], opened = [], consumed = [];
  let stateListener, outputListener, localStateListener, localOutputListener;
  const localOpened = [], localSent = [], localResized = [], localClosed = [];
  class Terminal {
    constructor(options) { this.options = options; this.writes = []; this.cols = 80; this.rows = 24; instances.push(this); }
    loadAddon() {} open() {} onData(listener) { this.input = listener; } focus() { this.focused = true; }
    write(data, done) { this.writes.push(data); done?.(); }
    dispose() { this.disposed = true; }
  }
  global.window = {
    Terminal, FitAddon: { FitAddon: class { fit() {} } }, innerHeight: 800,
    addEventListener() {}, removeEventListener() {}, requestAnimationFrame(fn) { frames.push(fn); return frames.length; }, cancelAnimationFrame() {},
  };
  global.document = {
    createElement: () => new Element(), createElementNS: () => new Element(), getElementById: () => undefined,
    createTextNode: (text) => Object.assign(new Element(), { textContent: text }),
  };
  const { createSshWorkspace } = await import('../dist/renderer/components/sshWorkspace.js');
  const root = new Element(), parent = new Element(), tabList = new Element(), pane = new Element(), resizeHandle = new Element();
  parent.append(root);
  const api = {
    openLocalTerminal: async (id) => { localOpened.push({ id, shell: 'zsh' }); return { id, shell: 'zsh', state: 'connecting' }; },
    writeLocalTerminal: async (...args) => localSent.push(args), resizeLocalTerminal: async (...args) => localResized.push(args),
    closeLocalTerminal: async (id) => localClosed.push(id), acknowledgeLocalTerminalOutput: async (...args) => consumed.push(args),
    onLocalTerminalChanged: (fn) => { localStateListener = fn; return () => {}; },
    onLocalTerminalOutput: (fn) => { localOutputListener = fn; return () => {}; },
    openSshTerminal: async (hostId, id) => { opened.push({ hostId, id }); return { hostId, id, state: 'connecting' }; },
    writeSshTerminal: async (...args) => sent.push(args), resizeSshTerminal: async (...args) => resized.push(args),
    closeSshTerminal: async (id) => closed.push(id), acknowledgeSshTerminalOutput: async (...args) => consumed.push(args),
    onSshTerminalChanged: (fn) => { stateListener = fn; return () => { stateListener = undefined; }; },
    onSshTerminalOutput: (fn) => { outputListener = fn; return () => { outputListener = undefined; }; },
  };
  const workspace = createSshWorkspace({ root, tabList, pane, resizeHandle, api, reportError: (error) => { throw error; } });
  const flush = () => { for (const fn of frames.splice(0)) fn(); };
  const captions = () => tabList.children.map((item) => item.children[0].children[0].children.map((child) => child.textContent).join(''));
  const change = (index, state, error, closeReason) => stateListener({ ...opened[index], state, error, closeReason });
  const output = (index, data) => outputListener({ id: opened[index].id, data });
  const click = (index, close = false) => tabList.children[index].children[close ? 1 : 0].listeners.get('click')();
  const localChange = (index, state, closeReason) => localStateListener({ ...localOpened[index], state, closeReason });
  const localOutput = (index, data) => localOutputListener({ id: localOpened[index].id, data });
  try { await run({ workspace, api, root, pane, resizeHandle, instances, sent, resized, opened, closed, consumed, captions, change, output, click, flush,
    localOpened, localSent, localResized, localClosed, localChange, localOutput }); }
  finally { workspace.dispose(); Object.assign(global, previous); }
}

test('local and SSH tabs share a panel but keep independent numbering, input routes and lifecycles', async () => harness(async (h) => {
  h.workspace.setVisible(true);
  await h.workspace.openLocal(); h.localChange(0, 'open');
  await h.workspace.open({ id: 'a', name: 'Alpha' }); h.change(0, 'open');
  await h.workspace.openLocal(); h.localChange(1, 'open'); h.flush();
  assert.deepEqual(h.captions(), ['Local Terminal #1', 'Alpha #1', 'Local Terminal #2']);
  h.instances[2].input('echo local\r');
  assert.deepEqual(h.localSent, [[h.localOpened[1].id, 'echo local\r']]); assert.deepEqual(h.sent, []);
  h.workspace.setVisible(false); h.localOutput(0, 'background'); h.workspace.setVisible(true);
  assert.deepEqual(h.localClosed, []); assert.deepEqual(h.instances[0].writes, ['background']);
  h.localChange(1, 'closed', 'shell-exit');
  assert.deepEqual(h.captions(), ['Local Terminal #1', 'Alpha #1']);
  h.click(0, true); assert.deepEqual(h.localClosed, [h.localOpened[0].id]); assert.deepEqual(h.closed, []);
  await h.workspace.openLocal(); assert.deepEqual(h.captions(), ['Alpha #1', 'Local Terminal #3']);
}));

test('each click creates a distinct SSH tab with independent monotonic host numbering', async () => harness(async (h) => {
  h.workspace.setVisible(true);
  await h.workspace.open({ id: 'a', name: 'Alpha' }); await h.workspace.open({ id: 'a', name: 'Alpha' });
  await h.workspace.open({ id: 'b', name: 'Beta' });
  assert.deepEqual(h.captions(), ['Alpha #1', 'Alpha #2', 'Beta #1']);
  assert.equal(new Set(h.opened.map((value) => value.id)).size, 3);
  h.click(0, true); await h.workspace.open({ id: 'a', name: 'Alpha' });
  assert.deepEqual(h.captions(), ['Alpha #2', 'Beta #1', 'Alpha #3']);
  h.workspace.updateHosts([{ id: 'a', name: 'Renamed' }]);
  assert.deepEqual(h.captions(), ['Renamed #2', 'Beta #1', 'Renamed #3']);
}));

test('tab switching and page hiding retain exact xterm views, background output and scrollback', async () => harness(async (h) => {
  h.workspace.setVisible(true);
  await h.workspace.open({ id: 'a', name: 'Alpha' }); h.change(0, 'open'); h.output(0, '$ ');
  await h.workspace.open({ id: 'a', name: 'Alpha' }); h.change(1, 'open'); h.flush();
  h.workspace.setVisible(false); h.output(0, 'background 中文'); h.output(1, 'other');
  assert.deepEqual(h.closed, []);
  h.workspace.setVisible(true); h.click(0); h.flush();
  assert.equal(h.instances.length, 2);
  assert.deepEqual(h.instances[0].writes, ['$ ', 'background 中文']);
  assert.equal(h.instances[0].options.scrollback, 2000);
  h.instances[0].input(' \r\x1b[A\t\x03');
  assert.deepEqual(h.sent, [[h.opened[0].id, ' \r\x1b[A\t\x03']]);
  assert.equal(h.consumed.length, 3);
}));

test('initial output before open response is retained; final tabs are read-only and stale events cannot revive closed tabs', async () => harness(async (h) => {
  h.workspace.setVisible(true);
  let complete;
  h.api.openSshTerminal = (hostId, id) => {
    h.opened.push({ hostId, id }); h.change(0, 'open'); h.output(0, 'first prompt');
    return new Promise((resolve) => { complete = resolve; });
  };
  const opening = h.workspace.open({ id: 'a', name: 'Alpha' });
  complete({ ...h.opened[0], state: 'connecting' }); await opening;
  h.instances[0].input('echo x'); assert.equal(h.sent.length, 1);
  h.change(0, 'closed', 'SSH session ended.');
  assert.deepEqual(h.captions(), ['Alpha #1']);
  assert.equal(h.instances[0].options.disableStdin, true);
  h.instances[0].input('ignored'); assert.equal(h.sent.length, 1);
  assert.deepEqual(h.instances[0].writes, ['first prompt']);
  h.click(0, true); h.change(0, 'open'); h.output(0, 'late');
  assert.deepEqual(h.captions(), []);
  assert.ok(h.root.classList.contains('hidden'));
  assert.equal(h.instances[0].disposed, true);
}));

test('close during asynchronous open cleans both current and late remote results', async () => harness(async (h) => {
  let complete;
  h.api.openSshTerminal = (hostId, id) => { h.opened.push({ hostId, id }); return new Promise((resolve) => { complete = resolve; }); };
  const opening = h.workspace.open({ id: 'a', name: 'Alpha' });
  h.click(0, true); complete({ ...h.opened[0], state: 'open' }); await opening;
  assert.ok(h.closed.every((id) => id === h.opened[0].id));
  assert.equal(h.instances[0].disposed, true);
  assert.deepEqual(h.captions(), []);
}));

test('shell exit removes only the finished tab, fences late events and hides the last pane even while away', async () => harness(async (h) => {
  h.workspace.setVisible(true);
  await h.workspace.open({ id: 'a', name: 'Alpha' }); h.change(0, 'open');
  await h.workspace.open({ id: 'a', name: 'Alpha' }); h.change(1, 'open');
  h.change(0, 'closed', undefined, 'shell-exit');
  assert.deepEqual(h.captions(), ['Alpha #2']);
  assert.equal(h.instances[0].disposed, true);
  assert.equal(h.instances[1].disposed, undefined);
  assert.deepEqual(h.closed, [], 'the main process already released the finished session');
  h.change(0, 'open'); h.output(0, 'late');
  assert.deepEqual(h.captions(), ['Alpha #2']);
  h.workspace.setVisible(false);
  h.change(1, 'closed', undefined, 'shell-exit');
  assert.equal(h.instances[1].disposed, true);
  h.workspace.setVisible(true);
  assert.deepEqual(h.captions(), []);
  assert.ok(h.root.classList.contains('hidden'));
  await h.workspace.open({ id: 'a', name: 'Alpha' });
  assert.deepEqual(h.captions(), ['Alpha #3']);
}));

test('SSH workspace starts at half height, supports keyboard resizing and preserves height across visibility changes', async () => harness(async (h) => {
  h.workspace.setVisible(true); await h.workspace.open({ id: 'a', name: 'Alpha' });
  assert.equal(h.root.style.height, '400px');
  h.resizeHandle.listeners.get('keydown')({ key: 'ArrowUp', preventDefault() {} });
  assert.equal(h.root.style.height, '420px');
  h.workspace.setVisible(false); h.workspace.setVisible(true);
  await h.workspace.open({ id: 'a', name: 'Alpha' });
  assert.equal(h.root.style.height, '420px');
  h.resizeHandle.listeners.get('keydown')({ key: 'End', preventDefault() {} });
  assert.equal(h.root.style.height, '640px');
  h.resizeHandle.listeners.get('keydown')({ key: 'Home', preventDefault() {} });
  assert.equal(h.root.style.height, '120px');
}));
