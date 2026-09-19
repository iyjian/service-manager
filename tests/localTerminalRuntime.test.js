const test = require('node:test');
const assert = require('node:assert/strict');
const { LocalTerminalRuntime, localShell, localShellEnvironment } = require('../dist/main/terminal/localTerminalRuntime');
const tick = () => new Promise((resolve) => setImmediate(resolve));

function fixture(extra = {}) {
  const states = [], outputs = [], spawned = [];
  const runtime = new LocalTerminalRuntime({
    state: (owner, state) => states.push({ owner, ...state }),
    output: (owner, output) => outputs.push({ owner, ...output }),
    loadPty: async () => ({ spawn: (file, args, options) => {
      const data = new Set(), exit = new Set();
      const pty = { file, args, options, writes: [], sizes: [], killed: false, paused: false,
        onData(fn) { data.add(fn); return { dispose: () => data.delete(fn) }; },
        onExit(fn) { exit.add(fn); return { dispose: () => exit.delete(fn) }; },
        emit(value) { for (const fn of data) fn(value); },
        end() { for (const fn of [...exit]) fn({ exitCode: 0 }); },
        write(value) { this.writes.push(value); }, resize(...value) { this.sizes.push(value); },
        kill() { this.killed = true; this.end(); }, pause() { this.paused = true; }, resume() { this.paused = false; },
      };
      spawned.push(pty); return pty;
    } }), ...extra,
  });
  return { runtime, states, outputs, spawned };
}

test('platform shells use the login shell and Windows PowerShell without renderer commands', () => {
  assert.deepEqual(localShell('darwin', { SHELL: '/bin/bash' }, '/bin/zsh'), { file: '/bin/zsh', args: ['-l'], name: 'zsh' });
  assert.equal(localShell('linux', { SHELL: '/usr/bin/fish' }).file, '/usr/bin/fish');
  assert.deepEqual(localShell('win32', { SystemRoot: 'D:\\Windows', SHELL: '/bin/bash' }), {
    file: 'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', args: ['-NoLogo'], name: 'PowerShell',
  });
  const source = { PATH: '/bin', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--inspect', LANG: 'en_US.UTF-8' };
  const env = localShellEnvironment(source);
  assert.equal(env.PATH, '/bin'); assert.equal(env.LANG, source.LANG);
  assert.equal(env.TERM, 'xterm-256color'); assert.equal(env.ELECTRON_RUN_AS_NODE, undefined); assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(source.ELECTRON_RUN_AS_NODE, '1');
});

test('local sessions preserve input, resize before/after startup and enforce window ownership', async (t) => {
  const f = fixture(); t.after(() => f.runtime.shutdown());
  f.runtime.open(1, 'one'); f.runtime.resize(1, 'one', 99, 33); f.runtime.open(2, 'two'); await tick();
  assert.equal(f.spawned[0].options.cols, 99); assert.equal(f.spawned[0].options.rows, 33);
  const input = '中文\r\x1b[A\t\x03'; f.runtime.write(1, 'one', input); f.runtime.resize(1, 'one', 100, 40);
  assert.deepEqual(f.spawned[0].writes, [input]); assert.deepEqual(f.spawned[0].sizes, [[100, 40]]);
  for (const action of [() => f.runtime.write(2, 'one', 'x'), () => f.runtime.resize(2, 'one', 80, 24),
    () => f.runtime.close(2, 'one'), () => f.runtime.acknowledge(2, 'one', 1)]) assert.throws(action, /another window/);
  assert.throws(() => f.runtime.resize(1, 'one', NaN, 24), /dimensions/);
  assert.throws(() => f.runtime.write(1, 'one', 'x'.repeat(65537)), /input/);
  assert.throws(() => f.runtime.acknowledge(1, 'one', -1), /acknowledgement/);
  f.runtime.closeOwner(1); assert.ok(f.spawned[0].killed); assert.equal(f.spawned[1].killed, false);
  f.spawned[0].emit('late'); assert.deepEqual(f.outputs, []);
});

test('local output is bounded, Unicode-safe and resumes only after consumed output', async (t) => {
  const f = fixture(); t.after(() => f.runtime.shutdown()); f.runtime.open(1, 'one'); await tick();
  const text = 'x'.repeat(16383) + '😀中文' + 'x'.repeat(140000);
  f.spawned[0].emit(text);
  assert.equal(f.outputs.map((value) => value.data).join(''), text);
  assert.ok(f.outputs.every((value) => value.data.length <= 16384 && !/[\uD800-\uDBFF]$/.test(value.data)));
  assert.ok(f.spawned[0].paused);
  for (const value of f.outputs) f.runtime.acknowledge(1, 'one', value.data.length);
  assert.equal(f.spawned[0].paused, false);
  f.spawned[0].emit('x'.repeat(1024 * 1024 + 1));
  assert.equal(f.states.at(-1).state, 'error'); assert.ok(f.spawned[0].killed);
});

test('closing or timing out during startup prevents a late PTY, shell exit reports exact tab lifecycle', async (t) => {
  let resolve, calls = 0;
  const f = fixture({ loadPty: () => new Promise((done) => { resolve = done; }) });
  t.after(() => f.runtime.shutdown()); f.runtime.open(1, 'cancelled'); f.runtime.close(1, 'cancelled');
  resolve({ spawn() { calls++; } }); await tick(); assert.equal(calls, 0);
  const g = fixture({ timeoutMs: 5, loadPty: () => new Promise(() => {}) }); t.after(() => g.runtime.shutdown());
  g.runtime.open(1, 'timeout'); await new Promise((done) => setTimeout(done, 15));
  assert.equal(g.states.at(-1).state, 'error'); assert.match(g.states.at(-1).error, /timed out/);
  const h = fixture(); t.after(() => h.runtime.shutdown()); h.runtime.open(1, 'exit'); await tick(); h.spawned[0].end();
  assert.equal(h.states.at(-1).closeReason, 'shell-exit'); assert.equal(h.spawned[0].killed, false);
  h.runtime.shutdown(); assert.throws(() => h.runtime.open(1, 'late'), /shutting down/);
});

test('startup failures keep a sanitized diagnostic and shutdown kills all live shells', async () => {
  const f = fixture({ loadPty: async () => { throw new Error('private environment'); } });
  f.runtime.open(1, 'failed'); await tick();
  assert.equal(f.states.at(-1).state, 'error'); assert.doesNotMatch(f.states.at(-1).error, /private environment/);
  const g = fixture(); g.runtime.open(1, 'a'); g.runtime.open(2, 'b'); await tick(); g.runtime.shutdown();
  assert.ok(g.spawned.every((pty) => pty.killed));
});
