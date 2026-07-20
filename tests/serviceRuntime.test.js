const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

const {
  SYSTEMD_SUPPORT_FAILURE_CACHE_MS,
  SYSTEMD_SUPPORT_SUCCESS_CACHE_MS,
  buildHostServicesStatusCommand,
  buildManagedShellLauncher,
  buildSystemdUnitListCommand,
  buildSystemdUnitName,
  buildSystemdUnitSearchPattern,
  checkHostServicesStatus,
  classifySystemdSupportFailure,
  mapHostServiceStatuses,
  parseSystemdState,
  parseSystemdUnitStates,
  parseSystemdUnitNames,
  selectSystemdUnitName,
  shellQuoteSingle,
  shouldRetrySystemdSupportCheck,
} = require('../dist/main/serviceRuntime');

function host(id = 'host-1') {
  return {
    id,
    name: 'Development',
    sshHost: 'example.test',
    sshPort: 22,
    username: 'developer',
    authType: 'password',
    password: 'secret',
    jumpHosts: [],
    forwards: [],
    services: [],
  };
}

function service(id, pid) {
  return {
    id,
    name: id,
    startCommand: `run ${id}`,
    port: 3000,
    pid,
  };
}

function sshResult(stdout = '') {
  return { ok: true, stdout, stderr: '', code: 0 };
}

test('shellQuoteSingle quotes single quotes safely for shell commands', () => {
  assert.equal(shellQuoteSingle("cd '/tmp/app' && yarn dev"), `'cd '"'"'/tmp/app'"'"' && yarn dev'`);
});

test('classifySystemdSupportFailure preserves an SSH timeout instead of calling it a user session failure', () => {
  assert.match(
    classifySystemdSupportFailure('user-manager', { code: -1, stderr: 'SSH command timeout', stdout: '', ok: false }),
    /Remote SSH check timed out/
  );
});

test('classifySystemdSupportFailure recognizes ssh2 handshake timeout wording', () => {
  assert.match(
    classifySystemdSupportFailure('user-manager', {
      code: -1,
      stderr: 'Timed out while waiting for handshake',
      stdout: '',
      ok: false,
    }),
    /Remote SSH check timed out/
  );
});

test('classifySystemdSupportFailure recognizes SSH ETIMEDOUT failures', () => {
  assert.match(
    classifySystemdSupportFailure('user-manager', { code: -1, stderr: 'connect ETIMEDOUT 192.0.2.10:22', stdout: '', ok: false }),
    /Remote SSH check timed out/
  );
});

test('classifySystemdSupportFailure keeps non-timeout SSH failures distinct', () => {
  assert.match(
    classifySystemdSupportFailure('user-manager', { code: -1, stderr: 'All configured authentication methods failed', stdout: '', ok: false }),
    /Remote SSH check failed/
  );
  assert.doesNotMatch(
    classifySystemdSupportFailure('user-manager', { code: -1, stderr: 'All configured authentication methods failed', stdout: '', ok: false }),
    /timed out/i
  );
});

test('classifySystemdSupportFailure distinguishes missing tooling, user-bus failure, and linger failure', () => {
  assert.match(
    classifySystemdSupportFailure('tools', { code: 127, stderr: 'systemd-run journalctl', stdout: '', ok: false }),
    /missing required systemd tools: systemd-run, journalctl/i
  );
  assert.match(
    classifySystemdSupportFailure('user-manager', { code: 1, stderr: 'Failed to connect to bus: No medium found', stdout: '', ok: false }),
    /systemd user session is unavailable/i
  );
  assert.match(
    classifySystemdSupportFailure('linger', { code: 1, stderr: 'Access denied', stdout: '', ok: false }),
    /linger check failed/i
  );
  assert.match(
    classifySystemdSupportFailure('tools', { code: 1, stderr: 'Access denied', stdout: '', ok: false }),
    /systemd tooling check failed/i
  );
});

test('classifySystemdSupportFailure applies runtime-log redaction to linger diagnostics', () => {
  const failure = classifySystemdSupportFailure('linger', {
    code: 1,
    stderr: 'loginctl access denied for --token supersecret; systemd-run failed: pnpm run serve --api-token another-secret',
    stdout: '',
    ok: false,
  });

  assert.match(failure, /Remote linger check failed/i);
  assert.match(failure, /--token=\[redacted\]/i);
  assert.match(failure, /systemd-run failed: \[redacted-command\]/i);
  assert.doesNotMatch(failure, /pnpm run serve|supersecret|another-secret/i);
});

test('compiled service runtime keeps linger probe stderr for safe failure classification', async () => {
  const runtime = await readFile(path.join(__dirname, '..', 'dist', 'main', 'serviceRuntime.js'), 'utf8');
  const lingerProbeStart = runtime.indexOf('loginctl show-user');
  const lingerProbe = runtime.slice(lingerProbeStart, lingerProbeStart + 400);

  assert.ok(lingerProbeStart >= 0);
  assert.match(lingerProbe, /loginctl show-user/);
  assert.doesNotMatch(lingerProbe, /2>\/dev\/null/);
});

test('only transient user-manager transport or user-bus failures are retryable', () => {
  assert.equal(
    shouldRetrySystemdSupportCheck('user-manager', { code: -1, stderr: 'SSH command timeout', stdout: '', ok: false }),
    true
  );
  assert.equal(
    shouldRetrySystemdSupportCheck('user-manager', { code: 1, stderr: 'Failed to connect to bus', stdout: '', ok: false }), true);
  assert.equal(shouldRetrySystemdSupportCheck('tools', { code: -1, stderr: 'SSH command timeout', stdout: '', ok: false }), false);
  assert.equal(shouldRetrySystemdSupportCheck('linger', { code: 1, stderr: 'Access denied', stdout: '', ok: false }), false);
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

test('buildHostServicesStatusCommand lists target patterns and batches all states into one systemctl show', () => {
  const targetHost = host('11111111-1111-4111-8111-111111111111');
  const uuidService = service('33333333-3333-4333-8333-333333333333');
  const importedService = service('imported/service');
  const command = buildHostServicesStatusCommand(targetHost, [uuidService, importedService]);

  assert.equal((command.match(/systemctl --user list-units/g) ?? []).length, 1);
  assert.equal((command.match(/systemctl --user show/g) ?? []).length, 1);
  assert.match(command, /service-manager-\*-33333333-3333-4333-8333-333333333333\.service/);
  assert.match(command, /service-manager-11111111-1111-4111-8111-111111111111-imported_service\.service/);
  assert.match(command, /\$\{units\[@\]\}/);
  assert.match(command, /--property=Id/);
  assert.match(command, /--property=InvocationID/);
  assert.throws(
    () => buildHostServicesStatusCommand(targetHost, []),
    /At least one service is required/
  );
});

test('parseSystemdUnitStates parses bounded property blocks by systemd Id', () => {
  const states = parseSystemdUnitStates([
    'Id=service-manager-host-api.service',
    'LoadState=loaded',
    'ActiveState=active',
    'SubState=running',
    'Result=success',
    'MainPID=1234',
    'InvocationID=one',
    '',
    'Id=service-manager-host-worker.service',
    'LoadState=loaded',
    'ActiveState=failed',
    'SubState=failed',
    'Result=exit-code',
    'MainPID=0',
    'InvocationID=two',
    '',
  ].join('\n'));

  assert.deepEqual(states.get('service-manager-host-api.service'), {
    exists: true,
    activeState: 'active',
    subState: 'running',
    result: 'success',
    mainPid: 1234,
    invocationId: 'one',
  });
  assert.deepEqual(states.get('service-manager-host-worker.service'), {
    exists: true,
    activeState: 'failed',
    subState: 'failed',
    result: 'exit-code',
    mainPid: undefined,
    invocationId: 'two',
  });
});

test('mapHostServiceStatuses preserves lifecycle mappings, missing units, and old-host UUID ownership', () => {
  const targetHost = host('11111111-1111-4111-8111-111111111111');
  const running = service('33333333-3333-4333-8333-333333333333');
  const missing = service('missing');
  const stopping = service('stopping', 2200);
  const failed = service('failed', 3300);
  const unknown = service('unknown');
  const oldHost = { ...targetHost, id: '22222222-2222-4222-8222-222222222222' };
  const states = new Map([
    [buildSystemdUnitName(oldHost, running), { exists: true, activeState: 'active', mainPid: 1100 }],
    [buildSystemdUnitName(targetHost, stopping), { exists: true, activeState: 'deactivating' }],
    [buildSystemdUnitName(targetHost, failed), {
      exists: true,
      activeState: 'failed',
      subState: 'failed',
      result: 'exit-code',
    }],
    [buildSystemdUnitName(targetHost, unknown), {
      exists: true,
      activeState: 'reloading',
      subState: 'reload',
      mainPid: 4400,
    }],
  ]);

  const results = mapHostServiceStatuses(targetHost, [running, missing, stopping, failed, unknown], states);

  assert.deepEqual(results[0], { serviceId: running.id, status: 'running', pid: 1100 });
  assert.deepEqual(results[1], { serviceId: missing.id, status: 'stopped' });
  assert.deepEqual(results[2], { serviceId: stopping.id, status: 'stopping', pid: 2200 });
  assert.equal(results[3].serviceId, failed.id);
  assert.equal(results[3].status, 'error');
  assert.match(results[3].error, /failed \(exit-code\)/);
  assert.deepEqual(results[4], {
    serviceId: unknown.id,
    status: 'unknown',
    pid: 4400,
    error: 'Unknown systemd state: reloading/reload',
  });
});

test('mapHostServiceStatuses isolates ambiguous migrated units to their matching service', () => {
  const targetHost = host('11111111-1111-4111-8111-111111111111');
  const ambiguous = service('33333333-3333-4333-8333-333333333333', 99);
  const healthy = service('healthy');
  const states = new Map([
    [buildSystemdUnitName(host('22222222-2222-4222-8222-222222222222'), ambiguous), {
      exists: true,
      activeState: 'active',
      mainPid: 1,
    }],
    [buildSystemdUnitName(host('44444444-4444-4444-8444-444444444444'), ambiguous), {
      exists: true,
      activeState: 'active',
      mainPid: 2,
    }],
    [buildSystemdUnitName(targetHost, healthy), { exists: true, activeState: 'active', mainPid: 3 }],
  ]);

  const results = mapHostServiceStatuses(targetHost, [ambiguous, healthy], states);

  assert.equal(results[0].status, 'error');
  assert.equal(results[0].pid, 99);
  assert.match(results[0].error, /Multiple systemd units match service ID/);
  assert.deepEqual(results[1], { serviceId: 'healthy', status: 'running', pid: 3 });
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

test('checkHostServicesStatus performs one combined status exec and reuses the longer positive preflight cache', async () => {
  const targetHost = host('batch-success-host');
  const api = service('api', 90);
  const unit = buildSystemdUnitName(targetHost, api);
  const calls = [];
  const runner = async (_host, command) => {
    calls.push(command);
    if (command.includes('loginctl show-user')) {
      return sshResult('yes\n');
    }
    if (command.includes('list_output=')) {
      return sshResult([
        `Id=${unit}`,
        'LoadState=loaded',
        'ActiveState=active',
        'SubState=running',
        'Result=success',
        'MainPID=1234',
        'InvocationID=abc',
      ].join('\n'));
    }
    return sshResult();
  };

  const first = await checkHostServicesStatus(targetHost, [api], runner);
  assert.deepEqual(first, [{ serviceId: 'api', status: 'running', pid: 1234 }]);
  assert.equal(calls.length, 4);
  const firstStatusCalls = calls.filter((command) => command.includes('list_output='));
  assert.equal(firstStatusCalls.length, 1);
  assert.equal((firstStatusCalls[0].match(/systemctl --user list-units/g) ?? []).length, 1);
  assert.equal((firstStatusCalls[0].match(/systemctl --user show/g) ?? []).length, 1);

  const second = await checkHostServicesStatus(targetHost, [api], runner);
  assert.deepEqual(second, first);
  assert.equal(calls.length, 5);
  assert.equal(calls.filter((command) => command.includes('list_output=')).length, 2);

  const editedEndpoint = { ...targetHost, sshHost: 'other.example.test' };
  const third = await checkHostServicesStatus(editedEndpoint, [api], runner);
  assert.deepEqual(third, first);
  assert.equal(calls.length, 9);
  assert.equal(calls.filter((command) => command.includes('list_output=')).length, 3);
  assert.ok(SYSTEMD_SUPPORT_SUCCESS_CACHE_MS > SYSTEMD_SUPPORT_FAILURE_CACHE_MS);
});

test('checkHostServicesStatus caches preflight failures briefly and returns one error per service', async () => {
  const targetHost = host('batch-failure-host');
  const api = service('api', 91);
  const worker = service('worker', 92);
  let calls = 0;
  const runner = async () => {
    calls += 1;
    return { ok: false, stdout: '', stderr: 'systemctl', code: 127 };
  };

  const first = await checkHostServicesStatus(targetHost, [api, worker], runner);
  const second = await checkHostServicesStatus(targetHost, [api, worker], runner);

  assert.equal(calls, 1);
  assert.deepEqual(first, second);
  assert.deepEqual(first.map((result) => [result.serviceId, result.status, result.pid]), [
    ['api', 'error', 91],
    ['worker', 'error', 92],
  ]);
  assert.match(first[0].error, /missing required systemd tools: systemctl/i);
  assert.equal(SYSTEMD_SUPPORT_FAILURE_CACHE_MS, 15_000);
});

test('checkHostServicesStatus skips SSH for an empty host batch and fans out status command failure', async () => {
  const emptyHost = host('batch-empty-host');
  let emptyCalls = 0;
  assert.deepEqual(await checkHostServicesStatus(emptyHost, [], async () => {
    emptyCalls += 1;
    return sshResult();
  }), []);
  assert.equal(emptyCalls, 0);

  const targetHost = host('batch-command-failure-host');
  const api = service('api', 101);
  const worker = service('worker', 102);
  let calls = 0;
  const runner = async (_host, command) => {
    calls += 1;
    if (command.includes('loginctl show-user')) {
      return sshResult('yes\n');
    }
    if (command.includes('list_output=')) {
      return { ok: false, stdout: '', stderr: 'Failed to connect to bus', code: 1 };
    }
    return sshResult();
  };

  const results = await checkHostServicesStatus(targetHost, [api, worker], runner);
  assert.equal(calls, 4);
  assert.deepEqual(results.map((result) => [result.serviceId, result.status, result.pid]), [
    ['api', 'error', 101],
    ['worker', 'error', 102],
  ]);
  assert.match(results[0].error, /systemctl list\/show managed services failed/);
});

test('buildManagedShellLauncher launches command through login shell', () => {
  const launcher = buildManagedShellLauncher('cd /app && yarn dev');

  assert.match(launcher, /^\/bin\/bash -lc /);
  assert.match(launcher, /SHELL_BIN/);
  assert.match(launcher, /yarn dev/);
});
