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
        kill(signal) { this.killed = true; this.signal = signal; this.killCount = (this.killCount || 0) + 1; this.end(); },
        pause() { this.paused = true; }, resume() { this.paused = false; },
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
  const h = fixture({ platform: 'linux' }); t.after(() => h.runtime.shutdown()); h.runtime.open(1, 'exit'); await tick(); h.spawned[0].end();
  assert.equal(h.states.at(-1).closeReason, 'shell-exit'); assert.equal(h.spawned[0].killed, false);
  h.runtime.shutdown(); assert.throws(() => h.runtime.open(1, 'late'), /shutting down/);
});

test('Windows shell exit releases its PTY and WinPTY output worker exactly once without closing another session', async (t) => {
  const f = fixture({ platform: 'win32' }); t.after(() => f.runtime.shutdown());
  f.runtime.open(1, 'exited'); f.runtime.open(1, 'still-open'); await tick();
  const pty = f.spawned[0]; let disposed = 0;
  pty._agent = { _useConpty: false, _conoutSocketWorker: { dispose() { disposed++; } } };
  pty.emit('final output'); pty.end();
  f.runtime.close(1, 'exited'); pty.end(); pty.emit('late output');
  assert.equal(pty.killCount, 1); assert.equal(pty.signal, undefined); assert.equal(disposed, 1);
  assert.equal(f.spawned[1].killed, false);
  assert.deepEqual(f.outputs.map((event) => event.data), ['final output']);
  assert.deepEqual(f.states.filter((state) => state.id === 'exited').map((state) => [state.state, state.closeReason]),
    [['open', undefined], ['closed', 'shell-exit']]);
  f.runtime.write(1, 'still-open', 'echo alive\r');
  assert.deepEqual(f.spawned[1].writes, ['echo alive\r']);
});

test('WinPTY cleanup also runs for tab close, window close, shutdown and errors, even when native kill throws', async () => {
  for (const reason of ['tab', 'window', 'shutdown', 'output-error', 'native-error']) {
    const f = fixture({ platform: 'win32' }); f.runtime.open(1, reason); await tick();
    const pty = f.spawned[0]; let disposed = 0;
    pty._agent = { _useConpty: false, _conoutSocketWorker: { dispose() { disposed++; } } };
    if (reason === 'native-error') pty.kill = () => { throw new Error('already closed'); };
    if (reason === 'window') f.runtime.closeOwner(1);
    else if (reason === 'shutdown') f.runtime.shutdown();
    else if (reason === 'output-error') pty.emit('x'.repeat(1024 * 1024 + 1));
    else f.runtime.close(1, reason);
    f.runtime.shutdown();
    assert.equal(disposed, 1, reason);
    assert.equal(f.states.filter((state) => state.state !== 'open').length, 1, reason);
    assert.equal(f.states.at(-1).closeReason, undefined, reason);
  }
});

test('ConPTY uses its own worker cleanup and POSIX only kills shells that have not exited', async () => {
  const win = fixture({ platform: 'win32' }); win.runtime.open(1, 'conpty'); await tick();
  win.spawned[0]._agent = { _useConpty: true, _conoutSocketWorker: { dispose() { assert.fail('ConPTY owns its worker disposal'); } } };
  win.spawned[0].end(); assert.equal(win.spawned[0].killCount, 1); win.runtime.shutdown();
  for (const platform of ['linux', 'darwin']) {
    const f = fixture({ platform });
    f.runtime.open(1, 'exit'); f.runtime.open(1, 'close'); await tick();
    f.spawned[0].end(); f.runtime.close(1, 'close'); f.runtime.shutdown();
    assert.equal(f.spawned[0].killed, false);
    assert.equal(f.spawned[1].killCount, 1); assert.equal(f.spawned[1].signal, 'SIGKILL');
  }
});

test('startup failures keep a sanitized diagnostic and shutdown kills all live shells', async () => {
  const f = fixture({ loadPty: async () => { throw new Error('private environment'); } });
  f.runtime.open(1, 'failed'); await tick();
  assert.equal(f.states.at(-1).state, 'error'); assert.doesNotMatch(f.states.at(-1).error, /private environment/);
  const g = fixture(); g.runtime.open(1, 'a'); g.runtime.open(2, 'b'); await tick(); g.runtime.shutdown();
  assert.ok(g.spawned.every((pty) => pty.killed));
});

test('POSIX local shells get a UTF-8 character locale even without a desktop launcher locale', () => {
  for (const [platform, fallback] of [['darwin', 'en_US.UTF-8'], ['linux', 'C.UTF-8']]) {
    for (const source of [{}, { LANG: '' }, { LANG: 'C' }, { LANG: 'en_US.UTF-8', LC_CTYPE: 'C' },
      { LANG: 'zh_CN.UTF-8', LC_CTYPE: 'UTF-8', LC_ALL: 'POSIX' }]) {
      const original = { ...source };
      const env = localShellEnvironment(source, platform);
      assert.equal(env.LC_ALL || env.LC_CTYPE || env.LANG, fallback);
      assert.deepEqual(source, original);
    }
    for (const source of [{ LANG: 'zh_CN.UTF-8' }, { LANG: 'C', LC_CTYPE: 'UTF-8' },
      { LANG: 'C', LC_ALL: 'ja_JP.utf8' }]) {
      const env = localShellEnvironment(source, platform);
      for (const key of ['LANG', 'LC_CTYPE', 'LC_ALL']) assert.equal(env[key], source[key]);
    }
    const env = localShellEnvironment({ LANG: 'fr_FR.ISO8859-1', LC_TIME: 'de_DE.UTF-8' }, platform);
    assert.equal(env.LANG, 'fr_FR.ISO8859-1');
    assert.equal(env.LC_TIME, 'de_DE.UTF-8');
    assert.equal(env.LC_CTYPE, fallback);
  }
  const windows = localShellEnvironment({ LANG: 'C' }, 'win32');
  assert.equal(windows.LANG, 'C');
  assert.equal(windows.LC_CTYPE, undefined);
});

test('macOS zsh echoes Chinese input intact with a desktop launcher environment', {
  skip: process.platform !== 'darwin', timeout: 5000,
}, async (t) => {
  for (const locale of [{}, { LANG: 'C.UTF-8' }, { LC_CTYPE: 'C.UTF-8' }, { LC_ALL: 'C.UTF-8' }]) {
    await t.test(JSON.stringify(locale), async (t) => {
      const pty = require('node-pty').spawn('/bin/zsh', ['-f', '-i'], {
        name: 'xterm-256color', cols: 80, rows: 24, encoding: 'utf8',
        env: localShellEnvironment({ PATH: '/usr/bin:/bin', PS1: 'SM_READY> ', ...locale }, 'darwin'),
      });
      t.after(() => pty.kill());
      await new Promise((resolve, reject) => {
        let output = '', sent = false;
        const listener = pty.onData((data) => {
          output += data;
          if (!sent && output.includes('SM_READY> ')) {
            sent = true; output = ''; pty.write('理论');
          } else if (sent && output.includes('理论')) {
            assert.doesNotMatch(output, /�|<0090>|<0086>/);
            resolve();
          }
        });
        const exit = pty.onExit(() => reject(new Error('Shell exited before echoing Chinese input.')));
        t.after(() => { listener.dispose(); exit.dispose(); });
      });
    });
  }
});

test('Linux UTF-8 C locales fall back on macOS while remaining intact on Linux', () => {
  for (const value of ['C.UTF-8', 'C.utf8', 'POSIX.UTF-8']) {
    for (const key of ['LANG', 'LC_CTYPE', 'LC_ALL']) {
      const source = { [key]: value };
      const mac = localShellEnvironment(source, 'darwin');
      assert.equal(mac.LC_ALL || mac.LC_CTYPE || mac.LANG, 'en_US.UTF-8');
      const linux = localShellEnvironment(source, 'linux');
      assert.equal(linux[key], value);
    }
  }
});
