const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildManagedShellLauncher,
  buildSystemdUnitName,
  parseSystemdState,
  shellQuoteSingle,
} = require('../dist/main/serviceRuntime');

test('shellQuoteSingle quotes single quotes safely for shell commands', () => {
  assert.equal(shellQuoteSingle("cd '/tmp/app' && yarn dev"), `'cd '"'"'/tmp/app'"'"' && yarn dev'`);
});

test('parseSystemdState extracts systemd show output', () => {
  const state = parseSystemdState([
    'LoadState=loaded',
    'ActiveState=active',
    'SubState=running',
    'Result=success',
    'MainPID=12345',
    'InvocationID=abc123',
  ].join('\n'));

  assert.equal(state.exists, true);
  assert.equal(state.activeState, 'active');
  assert.equal(state.subState, 'running');
  assert.equal(state.result, 'success');
  assert.equal(state.mainPid, 12345);
  assert.equal(state.invocationId, 'abc123');
});

test('parseSystemdState detects missing units', () => {
  const state = parseSystemdState('LoadState=not-found\nMainPID=0');

  assert.equal(state.exists, false);
  assert.equal(state.mainPid, undefined);
});

test('buildSystemdUnitName sanitizes host and service ids', () => {
  const unit = buildSystemdUnitName({ id: 'host/id', name: 'dev' }, { id: 'svc id', name: 'api' });

  assert.equal(unit, 'service-manager-host_id-svc_id.service');
});

test('buildManagedShellLauncher launches command through login shell', () => {
  const launcher = buildManagedShellLauncher('cd /app && yarn dev');

  assert.match(launcher, /^\/bin\/bash -lc /);
  assert.match(launcher, /SHELL_BIN/);
  assert.match(launcher, /yarn dev/);
});
