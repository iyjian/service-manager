const test = require('node:test');
const assert = require('node:assert/strict');
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function fixture(platform = 'Win32', extra = {}) {
  const { bindTerminalClipboard } = await import('../dist/renderer/components/terminalClipboard.js');
  const host = new EventTarget();
  const state = { selection: '理论中文', clipboard: '', active: true, open: true, focused: 0, pasted: [], copied: [] };
  const terminal = {
    getSelection: () => state.selection,
    clearSelection: () => { state.selection = ''; },
    focus: () => { state.focused++; },
    paste: (text) => state.pasted.push(text),
  };
  const clipboard = {
    writeClipboardText: async (text) => { state.clipboard = text; state.copied.push(text); },
    readClipboardText: async () => state.clipboard,
    ...extra,
  };
  const dispose = bindTerminalClipboard(host, terminal, clipboard, () => state.active, () => state.open, platform);
  const fire = (type = 'contextmenu', button = 2) => {
    const event = new Event(type, { cancelable: true });
    Object.defineProperty(event, 'button', { value: button });
    host.dispatchEvent(event);
    return event;
  };
  return { state, host, fire, dispose };
}

test('Windows right-click copies the highlighted Chinese text, clears selection, then pastes', async () => {
  const f = await fixture();
  assert.equal(f.fire().defaultPrevented, true);
  await tick();
  assert.deepEqual(f.state.copied, ['理论中文']);
  assert.equal(f.state.selection, '');
  assert.deepEqual(f.state.pasted, []);
  f.fire(); await tick();
  assert.deepEqual(f.state.pasted, ['理论中文']);
  assert.equal(f.state.focused, 1);
  f.dispose();
});

test('rapid Windows right-clicks wait for clipboard copy before paste', async () => {
  let finishCopy;
  const f = await fixture('Win32', { writeClipboardText: (text) => new Promise((resolve) => {
    finishCopy = () => { f.state.clipboard = text; resolve(); };
  }) });
  f.fire(); f.fire(); await tick();
  assert.deepEqual(f.state.pasted, []);
  finishCopy(); await tick();
  assert.deepEqual(f.state.pasted, ['理论中文']);
  f.dispose();
});

test('Windows paste delegates multiline text to xterm for bracketed paste', async () => {
  const f = await fixture();
  f.state.selection = ''; f.state.clipboard = 'echo 理论\r\necho 中文\n';
  f.fire(); await tick();
  assert.deepEqual(f.state.pasted, [f.state.clipboard]);
  f.dispose();
});

test('right mouse events cannot alter the selection or reach terminal mouse reporting', async () => {
  const f = await fixture();
  for (const name of ['mousedown', 'mouseup', 'auxclick']) {
    assert.equal(f.fire(name).defaultPrevented, true);
    assert.equal(f.fire(name, 0).defaultPrevented, false);
  }
  f.dispose();
  assert.equal(f.fire().defaultPrevented, false);
});

test('closed terminal output can be copied but cannot receive pasted input', async () => {
  const f = await fixture(); f.state.open = false;
  f.fire(); await tick(); f.fire(); await tick();
  assert.deepEqual(f.state.copied, ['理论中文']);
  assert.deepEqual(f.state.pasted, []);
  f.dispose();
});

test('pending clipboard reads cannot paste into an inactive, closed or disposed terminal', async () => {
  for (const change of [(f) => { f.state.active = false; }, (f) => { f.state.open = false; }, (f) => f.dispose()]) {
    let finishRead;
    const f = await fixture('Win32', { readClipboardText: () => new Promise((resolve) => { finishRead = resolve; }) });
    f.state.selection = ''; f.fire(); await tick(); change(f); finishRead('stale input'); await tick();
    assert.deepEqual(f.state.pasted, []);
    f.dispose();
  }
});

test('clipboard failure preserves the selection and does not block the next attempt', async () => {
  let tries = 0;
  const f = await fixture('Win32', { writeClipboardText: async () => { if (++tries === 1) throw new Error('unavailable'); } });
  f.fire(); await tick(); assert.equal(f.state.selection, '理论中文');
  f.fire(); await tick(); assert.equal(f.state.selection, '');
  f.dispose();
});

test('macOS and Linux retain xterm native clipboard and mouse event behavior', async () => {
  for (const platform of ['MacIntel', 'Linux x86_64']) {
    const f = await fixture(platform);
    for (const type of ['copy', 'paste', 'keydown', 'contextmenu', 'mousedown']) assert.equal(f.fire(type).defaultPrevented, false);
    await tick(); assert.deepEqual(f.state.copied, []); assert.deepEqual(f.state.pasted, []);
    f.dispose();
  }
});
