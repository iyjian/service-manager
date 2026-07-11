const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildManagedShellLauncher,
  buildSystemdUnitListCommand,
  buildSystemdUnitName,
  buildSystemdUnitSearchPattern,
  parseSystemdState,
  parseSystemdUnitNames,
  selectSystemdUnitName,
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

test('buildSystemdUnitSearchPattern ignores host id and sanitizes service id', () => {
  const pattern = buildSystemdUnitSearchPattern({ id: 'svc id', name: 'api' });

  assert.equal(pattern, 'service-manager-*-svc_id.service');
  assert.equal(
    buildSystemdUnitListCommand({ id: 'svc id', name: 'api' }),
    "systemctl --user list-units --all --type=service --full --plain --no-legend 'service-manager-*-svc_id.service'"
  );
});

test('parseSystemdUnitNames extracts the unit column and ignores blank output', () => {
  const units = parseSystemdUnitNames([
    'service-manager-old-host-service-1.service loaded active running Service Manager',
    '',
    'service-manager-other-host-service-2.service loaded failed failed Service Manager',
  ].join('\n'));

  assert.deepEqual(units, [
    'service-manager-old-host-service-1.service',
    'service-manager-other-host-service-2.service',
  ]);
});

test('selectSystemdUnitName matches service id under a different host id', () => {
  const serviceId = '33333333-3333-4333-8333-333333333333';
  const resolved = selectSystemdUnitName(
    { id: '11111111-1111-4111-8111-111111111111', name: 'dev' },
    { id: serviceId, name: 'api' },
    [`service-manager-22222222-2222-4222-8222-222222222222-${serviceId}.service`]
  );

  assert.deepEqual(resolved, {
    unit: `service-manager-22222222-2222-4222-8222-222222222222-${serviceId}.service`,
    exists: true,
  });
});

test('selectSystemdUnitName rejects similar suffixes and falls back to current host id', () => {
  const resolved = selectSystemdUnitName(
    { id: 'current-host', name: 'dev' },
    { id: 'service-1', name: 'api' },
    [
      'service-manager-old-host-other-service-1-extra.service',
      'unrelated-old-host-service-1.service',
    ]
  );

  assert.deepEqual(resolved, {
    unit: 'service-manager-current-host-service-1.service',
    exists: false,
  });
});

test('selectSystemdUnitName rejects multiple units for the same service id', () => {
  const serviceId = '33333333-3333-4333-8333-333333333333';
  assert.throws(
    () => selectSystemdUnitName(
      { id: '11111111-1111-4111-8111-111111111111', name: 'dev' },
      { id: serviceId, name: 'api' },
      [
        `service-manager-22222222-2222-4222-8222-222222222222-${serviceId}.service`,
        `service-manager-44444444-4444-4444-8444-444444444444-${serviceId}.service`,
      ]
    ),
    new RegExp(`Multiple systemd units match service ID ${serviceId}`)
  );
});

test('resolved old-host unit remains the selected lifecycle target', () => {
  const host = { id: '11111111-1111-4111-8111-111111111111', name: 'dev' };
  const service = { id: '33333333-3333-4333-8333-333333333333', name: 'api' };
  const resolved = selectSystemdUnitName(host, service, [
    buildSystemdUnitName({ ...host, id: '22222222-2222-4222-8222-222222222222' }, service),
  ]);

  assert.equal(resolved.exists, true);
  assert.equal(
    resolved.unit,
    'service-manager-22222222-2222-4222-8222-222222222222-33333333-3333-4333-8333-333333333333.service'
  );
  assert.notEqual(resolved.unit, buildSystemdUnitName(host, service));
});

test('selectSystemdUnitName does not suffix-match arbitrary imported service ids', () => {
  const resolved = selectSystemdUnitName(
    { id: 'current-host', name: 'dev' },
    { id: 'bar', name: 'api' },
    ['service-manager-22222222-2222-4222-8222-222222222222-foo-bar.service']
  );

  assert.deepEqual(resolved, {
    unit: 'service-manager-current-host-bar.service',
    exists: false,
  });
});

test('selectSystemdUnitName rejects UUID suffixes on noncanonical candidate names', () => {
  const serviceId = '33333333-3333-4333-8333-333333333333';
  const resolved = selectSystemdUnitName(
    { id: '11111111-1111-4111-8111-111111111111', name: 'dev' },
    { id: serviceId, name: 'api' },
    [`service-manager-imported-prefix-${serviceId}.service`]
  );

  assert.deepEqual(resolved, {
    unit: `service-manager-11111111-1111-4111-8111-111111111111-${serviceId}.service`,
    exists: false,
  });
});

test('buildManagedShellLauncher launches command through login shell', () => {
  const launcher = buildManagedShellLauncher('cd /app && yarn dev');

  assert.match(launcher, /^\/bin\/bash -lc /);
  assert.match(launcher, /SHELL_BIN/);
  assert.match(launcher, /yarn dev/);
});
