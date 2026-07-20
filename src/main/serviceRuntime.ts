import { Client, type ClientChannel } from 'ssh2';
import type { HostConfig, ServiceConfig, ServiceLogsQuery, ServiceLogsResult, ServiceStatus } from '../shared/types';
import { hostToEndpoint, jumpHostsToEndpoints } from './hostConnection';
import { sanitizeRuntimeDiagnosticString } from './runtimeLog';
import { closeSshClients, connectSshChain } from './sshChain';

export interface SshResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number;
}

export type SshRunner = (host: HostConfig, command: string) => Promise<SshResult>;

export type SystemdSupportCheck = 'tools' | 'user-manager' | 'linger';

export interface SystemdPreflightDiagnostic {
  hostId: string;
  check: SystemdSupportCheck;
  attempt: number;
  category: string;
  exitCode: number;
  elapsedMs: number;
  stderr: string;
}

export type ServiceRuntimeDiagnosticsSink = (event: SystemdPreflightDiagnostic) => void | Promise<void>;

let serviceRuntimeDiagnostics: ServiceRuntimeDiagnosticsSink | undefined;

export function setServiceRuntimeDiagnostics(sink?: ServiceRuntimeDiagnosticsSink): void {
  serviceRuntimeDiagnostics = sink;
}

export interface StartResult {
  ok: boolean;
  pid?: number;
  error?: string;
}

export interface SystemdServiceState {
  exists: boolean;
  activeState?: string;
  subState?: string;
  result?: string;
  mainPid?: number;
  invocationId?: string;
}

export interface HostServiceStatusResult {
  serviceId: string;
  status: ServiceStatus;
  pid?: number;
  error?: string;
}

async function connectTargetClient(host: HostConfig): Promise<{ targetClient: Client; jumpClients: Client[]; allClients: Client[] }> {
  return connectSshChain(await hostToEndpoint(host), jumpHostsToEndpoints(host), {
    readyTimeout: 10000,
    keepaliveInterval: 5000,
    keepaliveCountMax: 2,
  });
}

export async function runSsh(host: HostConfig, command: string): Promise<SshResult> {
  return new Promise<SshResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let sshClients: Client[] = [];

    const settle = (result: SshResult): void => {
      if (settled) return;
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      closeSshClients(sshClients);
      resolve(result);
    };

    const timer = setTimeout(() => {
      settle({
        ok: false,
        stdout,
        stderr: stderr || 'SSH command timeout',
        code: -1,
      });
    }, 20000);

    void (async () => {
      try {
        const connected = await connectTargetClient(host);
        const { targetClient } = connected;
        sshClients = connected.allClients;

        targetClient.exec(command, (execError: Error | undefined, stream: ClientChannel) => {
          if (execError) {
            settle({
              ok: false,
              stdout,
              stderr: execError.message || 'SSH exec failed',
              code: -1,
            });
            return;
          }

          stream
            .on('close', (code?: number) => {
              settle({
                ok: (code ?? 0) === 0,
                stdout,
                stderr,
                code: code ?? 0,
              });
            })
            .on('data', (data: Buffer | string) => {
              stdout += data.toString();
            });

          stream.stderr.on('data', (data: Buffer | string) => {
            stderr += data.toString();
          });
        });
      } catch (error) {
        settle({
          ok: false,
          stdout,
          stderr: error instanceof Error ? error.message : String(error),
          code: -1,
        });
      }
    })();
  });
}

function safeUnitFragment(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_.@-]/g, '_');
}

export function buildSystemdUnitName(host: HostConfig, service: ServiceConfig): string {
  return `service-manager-${safeUnitFragment(host.id)}-${safeUnitFragment(service.id)}.service`;
}

export interface ResolvedSystemdUnitName {
  unit: string;
  exists: boolean;
}

export function buildSystemdUnitSearchPattern(service: ServiceConfig): string {
  return `service-manager-*-${safeUnitFragment(service.id)}.service`;
}

export function buildSystemdUnitListCommand(service: ServiceConfig): string {
  return [
    'systemctl --user list-units --all --type=service --full --plain --no-legend',
    shellQuoteSingle(buildSystemdUnitSearchPattern(service)),
  ].join(' ');
}

export function parseSystemdUnitNames(raw: string): string[] {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/\s+/, 1)[0]);
}

const CANONICAL_UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const CANONICAL_UUID_PATTERN = new RegExp(`^${CANONICAL_UUID_SOURCE}$`);
const UUID_SYSTEMD_UNIT_PATTERN = new RegExp(
  `^service-manager-(${CANONICAL_UUID_SOURCE})-(${CANONICAL_UUID_SOURCE})\\.service$`
);

const SYSTEMD_STATE_PROPERTIES = [
  'Id',
  'LoadState',
  'ActiveState',
  'SubState',
  'Result',
  'MainPID',
  'InvocationID',
];

export function buildHostServicesStatusCommand(host: HostConfig, services: ServiceConfig[]): string {
  if (services.length === 0) {
    throw new Error('At least one service is required for a host status query.');
  }

  const patterns = new Set<string>();
  for (const service of services) {
    if (CANONICAL_UUID_PATTERN.test(service.id)) {
      patterns.add(buildSystemdUnitSearchPattern(service));
    } else {
      patterns.add(buildSystemdUnitName(host, service));
    }
  }

  const listCommand = [
    'systemctl --user list-units --all --type=service --full --plain --no-legend',
    ...[...patterns].map(shellQuoteSingle),
  ].join(' ');
  const showCommand = [
    'systemctl --user show "${units[@]}" --no-pager',
    ...SYSTEMD_STATE_PROPERTIES.map((property) => `--property=${property}`),
  ].join(' ');
  const script = [
    `list_output="$(${listCommand})" || exit $?`,
    'units=()',
    'while read -r unit next _; do',
    '  if [[ "$unit" != *.service && "$next" = *.service ]]; then unit="$next"; fi',
    '  if [ -n "$unit" ]; then units+=("$unit"); fi',
    'done <<< "$list_output"',
    'if [ "${#units[@]}" -eq 0 ]; then exit 0; fi',
    showCommand,
  ].join('\n');

  return `bash -lc ${shellQuoteSingle(script)}`;
}

export function selectSystemdUnitName(
  host: HostConfig,
  service: ServiceConfig,
  unitNames: string[]
): ResolvedSystemdUnitName {
  const conventionalUnit = buildSystemdUnitName(host, service);
  const matches = new Set(unitNames.filter((unit) => unit === conventionalUnit));

  if (CANONICAL_UUID_PATTERN.test(service.id)) {
    for (const unit of unitNames) {
      const parsed = UUID_SYSTEMD_UNIT_PATTERN.exec(unit);
      if (parsed?.[2] === service.id) {
        matches.add(unit);
      }
    }
  }

  const sortedMatches = [...matches].sort();

  if (sortedMatches.length > 1) {
    throw new Error(`Multiple systemd units match service ID ${service.id}: ${sortedMatches.join(', ')}`);
  }

  if (sortedMatches.length === 1) {
    return { unit: sortedMatches[0], exists: true };
  }

  return { unit: conventionalUnit, exists: false };
}

export function shellQuoteSingle(raw: string): string {
  return `'${raw.replace(/'/g, `'"'"'`)}'`;
}

export function buildManagedShellLauncher(command: string): string {
  const launcher = [
    'SHELL_BIN="${SHELL:-}"',
    'if [ -z "$SHELL_BIN" ] || [ ! -x "$SHELL_BIN" ]; then',
    '  if command -v getent >/dev/null 2>&1; then',
    '    SHELL_BIN="$(getent passwd "$USER" | cut -d: -f7)"',
    '  fi',
    'fi',
    'if [ -z "$SHELL_BIN" ] || [ ! -x "$SHELL_BIN" ]; then',
    '  SHELL_BIN=/bin/bash',
    'fi',
    'SHELL_NAME="$(basename "$SHELL_BIN")"',
    'case "$SHELL_NAME" in',
    `  bash|zsh|fish) exec "$SHELL_BIN" -i -l -c ${shellQuoteSingle(command)} ;;`,
    `  *) exec "$SHELL_BIN" -l -c ${shellQuoteSingle(command)} ;;`,
    'esac',
  ].join('\n');

  return `/bin/bash -lc ${shellQuoteSingle(launcher)}`;
}

export function parseSystemdState(raw: string): SystemdServiceState {
  const state: SystemdServiceState = { exists: true };

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const idx = trimmed.indexOf('=');
    if (idx < 0) {
      continue;
    }

    const key = trimmed.slice(0, idx);
    const value = trimmed.slice(idx + 1);
    if (key === 'LoadState' && value === 'not-found') {
      state.exists = false;
      continue;
    }
    if (key === 'ActiveState') {
      state.activeState = value;
      continue;
    }
    if (key === 'SubState') {
      state.subState = value;
      continue;
    }
    if (key === 'Result') {
      state.result = value || undefined;
      continue;
    }
    if (key === 'InvocationID') {
      state.invocationId = value || undefined;
      continue;
    }
    if (key === 'MainPID') {
      const pid = Number(value);
      state.mainPid = Number.isInteger(pid) && pid > 0 ? pid : undefined;
    }
  }

  return state;
}

export function parseSystemdUnitStates(raw: string): Map<string, SystemdServiceState> {
  const states = new Map<string, SystemdServiceState>();

  for (const block of raw.split(/\r?\n[\t ]*\r?\n/)) {
    const unitLine = block
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.startsWith('Id='));
    const unit = unitLine?.slice('Id='.length).trim();
    if (!unit) {
      continue;
    }
    states.set(unit, parseSystemdState(block));
  }

  return states;
}

function isMissingUnitMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes('could not be found') || normalized.includes('not-found');
}

function formatCommandFailure(action: string, ret: SshResult): string {
  const stderr = ret.stderr.trim();
  const stdout = ret.stdout.trim();
  if (stderr) {
    return `${action} failed: ${stderr}`;
  }
  if (stdout) {
    return `${action} failed: ${stdout}`;
  }
  return `${action} failed.`;
}

const systemdSupportCache = new Map<string, { expiresAt: number; error?: string }>();
export const SYSTEMD_SUPPORT_SUCCESS_CACHE_MS = 5 * 60_000;
export const SYSTEMD_SUPPORT_FAILURE_CACHE_MS = 15_000;
const SYSTEMD_PREFLIGHT_RETRY_DELAY_MS = 500;
const REQUIRED_SYSTEMD_TOOLS = ['systemd-run', 'systemctl', 'journalctl', 'loginctl'];

export function systemdSupportCacheKey(host: HostConfig): string {
  return JSON.stringify([
    host.id,
    host.sshHost,
    host.sshPort,
    host.username,
    host.jumpHosts.map((jumpHost) => [jumpHost.sshHost, jumpHost.sshPort, jumpHost.username]),
  ]);
}

function sanitizeSystemdSupportStderr(stderr: string): string {
  return sanitizeRuntimeDiagnosticString(stderr.trim()) || 'no diagnostic output';
}

function isSshTimeout(stderr: string): boolean {
  return /\b(?:ssh\s+command\s+)?timeout\b|\btimed out\b|\betimedout\b/i.test(stderr);
}

function isSystemdUserBusFailure(stderr: string): boolean {
  return /failed to connect to bus|failed to get d-bus connection|no medium found/i.test(stderr);
}

function systemdSupportCheckLabel(check: SystemdSupportCheck): string {
  switch (check) {
    case 'tools':
      return 'required systemd tools';
    case 'user-manager':
      return 'the systemd user session';
    case 'linger':
      return 'remote user lingering';
  }
}

function missingSystemdTools(stderr: string): string[] {
  const reported = new Set(stderr.match(/systemd-run|systemctl|journalctl|loginctl/gi)?.map((tool) => tool.toLowerCase()));
  return REQUIRED_SYSTEMD_TOOLS.filter((tool) => reported.has(tool));
}

function systemdSupportFailureCategory(check: SystemdSupportCheck, result: SshResult): string {
  if (result.code === -1) {
    return isSshTimeout(result.stderr) ? 'ssh-timeout' : 'ssh-failure';
  }
  if (check === 'tools' && result.code === 127) {
    return 'missing-tools';
  }
  if (check === 'user-manager' && isSystemdUserBusFailure(result.stderr)) {
    return 'user-bus-unavailable';
  }
  if (check === 'tools') {
    return 'tooling-check-failed';
  }
  return check === 'user-manager' ? 'user-manager-check-failed' : 'linger-check-failed';
}

export function classifySystemdSupportFailure(check: SystemdSupportCheck, result: SshResult): string {
  const safeStderr = sanitizeSystemdSupportStderr(result.stderr);

  if (result.code === -1) {
    if (isSshTimeout(result.stderr)) {
      return `Remote SSH check timed out while verifying ${systemdSupportCheckLabel(check)}.`;
    }
    return `Remote SSH check failed while verifying ${systemdSupportCheckLabel(check)}: ${safeStderr}`;
  }

  if (check === 'tools' && result.code === 127) {
    const tools = missingSystemdTools(result.stderr);
    return `Remote host is missing required systemd tools: ${tools.join(', ') || safeStderr}`;
  }

  if (check === 'user-manager' && isSystemdUserBusFailure(result.stderr)) {
    return `Remote systemd user session is unavailable: ${safeStderr}`;
  }

  if (check === 'user-manager') {
    return `Remote systemctl --user check failed (exit ${result.code}): ${safeStderr}`;
  }

  if (check === 'tools') {
    return `Remote systemd tooling check failed (exit ${result.code}): ${safeStderr}`;
  }

  return `Remote linger check failed (exit ${result.code}): ${safeStderr}`;
}

export function shouldRetrySystemdSupportCheck(check: SystemdSupportCheck, result: SshResult): boolean {
  return check === 'user-manager' && (result.code === -1 || isSystemdUserBusFailure(result.stderr));
}

function emitSystemdPreflightDiagnostic(event: SystemdPreflightDiagnostic): void {
  try {
    void Promise.resolve(serviceRuntimeDiagnostics?.(event)).catch(() => undefined);
  } catch {
    // Diagnostics must never interfere with service lifecycle operations.
  }
}

async function runSystemdSupportCheck(
  host: HostConfig,
  check: SystemdSupportCheck,
  command: string,
  runner: SshRunner = runSsh
): Promise<SshResult> {
  const runProbe = async (attempt: number): Promise<SshResult> => {
    const startedAt = Date.now();
    const result = await runner(host, command);
    if (!result.ok) {
      emitSystemdPreflightDiagnostic({
        hostId: host.id,
        check,
        attempt,
        category: systemdSupportFailureCategory(check, result),
        exitCode: result.code,
        elapsedMs: Math.max(0, Date.now() - startedAt),
        stderr: sanitizeSystemdSupportStderr(result.stderr),
      });
    }
    return result;
  };

  const firstResult = await runProbe(1);
  if (!firstResult.ok && shouldRetrySystemdSupportCheck(check, firstResult)) {
    await new Promise<void>((resolve) => setTimeout(resolve, SYSTEMD_PREFLIGHT_RETRY_DELAY_MS));
    return runProbe(2);
  }
  return firstResult;
}

async function ensureSystemdSupport(host: HostConfig, runner: SshRunner = runSsh): Promise<void> {
  const cacheKey = systemdSupportCacheKey(host);
  const cached = systemdSupportCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    if (cached.error) {
      throw new Error(cached.error);
    }
    return;
  }

  const toolsRet = await runSystemdSupportCheck(
    host,
    'tools',
    `bash -lc ${shellQuoteSingle(
      [
        'missing_tools=""',
        'for tool in systemd-run systemctl journalctl loginctl; do',
        '  if ! command -v "$tool" >/dev/null 2>&1; then',
        '    missing_tools="${missing_tools}${missing_tools:+, }$tool"',
        '  fi',
        'done',
        'if [ -n "$missing_tools" ]; then',
        '  printf "%s\\n" "$missing_tools" >&2',
        '  exit 127',
        'fi',
      ].join('\n')
    )}`,
    runner
  );
  if (!toolsRet.ok) {
    const error = classifySystemdSupportFailure('tools', toolsRet);
    systemdSupportCache.set(cacheKey, { expiresAt: Date.now() + SYSTEMD_SUPPORT_FAILURE_CACHE_MS, error });
    throw new Error(error);
  }

  const userManagerRet = await runSystemdSupportCheck(
    host,
    'user-manager',
    `bash -lc ${shellQuoteSingle('systemctl --user show-environment >/dev/null')}`,
    runner
  );
  if (!userManagerRet.ok) {
    const error = classifySystemdSupportFailure('user-manager', userManagerRet);
    systemdSupportCache.set(cacheKey, { expiresAt: Date.now() + SYSTEMD_SUPPORT_FAILURE_CACHE_MS, error });
    throw new Error(error);
  }

  const lingerRet = await runSystemdSupportCheck(
    host,
    'linger',
    `bash -lc ${shellQuoteSingle('loginctl show-user "$USER" -p Linger --value')}`,
    runner
  );
  if (!lingerRet.ok) {
    const error = classifySystemdSupportFailure('linger', lingerRet);
    systemdSupportCache.set(cacheKey, { expiresAt: Date.now() + SYSTEMD_SUPPORT_FAILURE_CACHE_MS, error });
    throw new Error(error);
  }
  if (lingerRet.stdout.trim() !== 'yes') {
    const error =
      'Remote host requires systemd user lingering for this SSH account. Please run `sudo loginctl enable-linger <username>` on the remote host so services survive after SSH disconnects.';
    systemdSupportCache.set(cacheKey, { expiresAt: Date.now() + SYSTEMD_SUPPORT_FAILURE_CACHE_MS, error });
    throw new Error(error);
  }

  systemdSupportCache.set(cacheKey, { expiresAt: Date.now() + SYSTEMD_SUPPORT_SUCCESS_CACHE_MS });
}

async function resolveSystemdUnitName(host: HostConfig, service: ServiceConfig): Promise<ResolvedSystemdUnitName> {
  await ensureSystemdSupport(host);

  const listCmd = buildSystemdUnitListCommand(service);
  const ret = await runSsh(host, `bash -lc ${shellQuoteSingle(listCmd)}`);
  if (!ret.ok) {
    throw new Error(formatCommandFailure('systemctl list-units', ret));
  }

  return selectSystemdUnitName(host, service, parseSystemdUnitNames(ret.stdout));
}

async function querySystemdUnitState(host: HostConfig, unit: string): Promise<SystemdServiceState> {
  await ensureSystemdSupport(host);

  const showCmd = `systemctl --user show ${shellQuoteSingle(unit)} --no-pager --property=LoadState --property=ActiveState --property=SubState --property=Result --property=MainPID --property=InvocationID`;
  const ret = await runSsh(host, `bash -lc ${shellQuoteSingle(showCmd)}`);

  const combined = `${ret.stdout}\n${ret.stderr}`.trim();
  if (!ret.ok && isMissingUnitMessage(combined)) {
    return { exists: false };
  }

  const state = parseSystemdState(ret.stdout);
  if (!ret.ok && !state.exists) {
    return { exists: false };
  }
  if (!ret.ok) {
    throw new Error(formatCommandFailure(`systemctl show ${unit}`, ret));
  }

  return state.exists ? state : { exists: false };
}

async function resolveSystemdServiceState(
  host: HostConfig,
  service: ServiceConfig
): Promise<{ unit: string; state: SystemdServiceState }> {
  const resolved = await resolveSystemdUnitName(host, service);
  if (!resolved.exists) {
    return { unit: resolved.unit, state: { exists: false } };
  }

  return {
    unit: resolved.unit,
    state: await querySystemdUnitState(host, resolved.unit),
  };
}

async function waitForSystemdMainPid(
  host: HostConfig,
  unit: string,
  timeoutMs = 5000
): Promise<SystemdServiceState> {
  const startedAt = Date.now();
  let latest: SystemdServiceState = { exists: false };

  while (Date.now() - startedAt < timeoutMs) {
    latest = await querySystemdUnitState(host, unit);
    if (!latest.exists) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      continue;
    }
    if (latest.activeState === 'failed') {
      return latest;
    }
    if (latest.mainPid) {
      return latest;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return latest;
}

async function waitForSystemdStop(
  host: HostConfig,
  unit: string,
  timeoutMs = 5000
): Promise<SystemdServiceState> {
  const startedAt = Date.now();
  let latest: SystemdServiceState = { exists: false };

  while (Date.now() - startedAt < timeoutMs) {
    latest = await querySystemdUnitState(host, unit);
    if (!latest.exists || latest.activeState === 'inactive' || latest.activeState === 'failed') {
      return latest;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return latest;
}

function buildSystemdFailureMessage(unit: string, state: SystemdServiceState): string {
  const result = state.result || state.subState || state.activeState || 'unknown';
  return `systemd unit ${unit} failed (${result}).`;
}

export function systemdServiceStateToStatus(
  unit: string,
  state: SystemdServiceState,
  service: ServiceConfig
): Omit<HostServiceStatusResult, 'serviceId'> {
  if (!state.exists || state.activeState === 'inactive') {
    return { status: 'stopped' };
  }
  if (state.activeState === 'active') {
    return { status: 'running', pid: state.mainPid };
  }
  if (state.activeState === 'activating') {
    return { status: 'starting', pid: state.mainPid };
  }
  if (state.activeState === 'deactivating') {
    return { status: 'stopping', pid: state.mainPid ?? service.pid };
  }
  if (state.activeState === 'failed') {
    return {
      status: 'error',
      pid: state.mainPid,
      error: buildSystemdFailureMessage(unit, state),
    };
  }

  return {
    status: 'unknown',
    pid: state.mainPid,
    error: `Unknown systemd state: ${state.activeState ?? 'unknown'}/${state.subState ?? 'unknown'}`,
  };
}

export function mapHostServiceStatuses(
  host: HostConfig,
  services: ServiceConfig[],
  statesByUnit: ReadonlyMap<string, SystemdServiceState>
): HostServiceStatusResult[] {
  const unitNames = [...statesByUnit.keys()];

  return services.map((service) => {
    try {
      const resolved = selectSystemdUnitName(host, service, unitNames);
      const state = resolved.exists
        ? statesByUnit.get(resolved.unit) ?? { exists: false }
        : { exists: false };
      return {
        serviceId: service.id,
        ...systemdServiceStateToStatus(resolved.unit, state, service),
      };
    } catch (error) {
      return {
        serviceId: service.id,
        status: 'error',
        pid: service.pid,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
}

export async function checkHostServicesStatus(
  host: HostConfig,
  services: ServiceConfig[],
  runner: SshRunner = runSsh
): Promise<HostServiceStatusResult[]> {
  if (services.length === 0) {
    return [];
  }

  try {
    await ensureSystemdSupport(host, runner);
    const result = await runner(host, buildHostServicesStatusCommand(host, services));
    if (!result.ok) {
      throw new Error(formatCommandFailure('systemctl list/show managed services', result));
    }
    return mapHostServiceStatuses(host, services, parseSystemdUnitStates(result.stdout));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return services.map((service) => ({
      serviceId: service.id,
      status: 'error',
      pid: service.pid,
      error: message,
    }));
  }
}

export async function startService(host: HostConfig, service: ServiceConfig): Promise<StartResult> {
  try {
    const { unit, state: current } = await resolveSystemdServiceState(host, service);
    if (current.exists && (current.activeState === 'active' || current.activeState === 'activating')) {
      return {
        ok: false,
        error: `Service is already managed by systemd unit ${unit}.`,
      };
    }

    const startCmd = [
      `systemctl --user stop ${shellQuoteSingle(unit)} >/dev/null 2>&1 || true`,
      `systemctl --user reset-failed ${shellQuoteSingle(unit)} >/dev/null 2>&1 || true`,
      `systemd-run --user --unit ${shellQuoteSingle(unit)} --quiet --property=KillMode=control-group --property=Restart=no --property=Type=exec --description=${shellQuoteSingle(`Service Manager: ${host.name} / ${service.name}`)} ${buildManagedShellLauncher(service.startCommand)}`,
    ].join(' && ');

    const ret = await runSsh(host, `bash -lc ${shellQuoteSingle(startCmd)}`);
    if (!ret.ok) {
      return {
        ok: false,
        error: formatCommandFailure(`systemd-run ${unit}`, ret),
      };
    }

    const state = await waitForSystemdMainPid(host, unit);
    if (!state.exists) {
      return {
        ok: false,
        error: `systemd unit ${unit} did not become available after start.`,
      };
    }
    if (state.activeState === 'failed') {
      return {
        ok: false,
        error: buildSystemdFailureMessage(unit, state),
      };
    }
    if (!state.mainPid) {
      return {
        ok: false,
        error: `systemd unit ${unit} started but MainPID is not available yet.`,
      };
    }

    return {
      ok: true,
      pid: state.mainPid,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function stopService(host: HostConfig, service: ServiceConfig): Promise<{ ok: boolean; error?: string }> {
  try {
    const { unit, state } = await resolveSystemdServiceState(host, service);
    if (!state.exists || state.activeState === 'inactive') {
      return { ok: true };
    }

    const stopCmd = `systemctl --user stop ${shellQuoteSingle(unit)}`;
    const ret = await runSsh(host, `bash -lc ${shellQuoteSingle(stopCmd)}`);
    if (!ret.ok) {
      return { ok: false, error: formatCommandFailure(`systemctl stop ${unit}`, ret) };
    }

    const stoppedState = await waitForSystemdStop(host, unit);
    if (stoppedState.exists && stoppedState.activeState === 'failed') {
      const resetFailedCmd = `systemctl --user reset-failed ${shellQuoteSingle(unit)}`;
      const resetRet = await runSsh(host, `bash -lc ${shellQuoteSingle(resetFailedCmd)}`);
      if (!resetRet.ok) {
        return { ok: false, error: formatCommandFailure(`systemctl reset-failed ${unit}`, resetRet) };
      }
    }

    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function checkServiceStatus(
  host: HostConfig,
  service: ServiceConfig
): Promise<{ status: ServiceStatus; pid?: number; error?: string }> {
  try {
    const { unit, state } = await resolveSystemdServiceState(host, service);
    return systemdServiceStateToStatus(unit, state, service);
  } catch (error) {
    return {
      status: 'error',
      pid: service.pid,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function getServiceLogs(
  host: HostConfig,
  service: ServiceConfig,
  query?: ServiceLogsQuery
): Promise<ServiceLogsResult> {
  const { unit, state } = await resolveSystemdServiceState(host, service);
  const requestedLineLimit = Number.isFinite(query?.lineLimit) ? Math.trunc(query?.lineLimit as number) : 200;
  const lineLimit = Math.max(50, requestedLineLimit);
  const journalCmd = state.invocationId
    ? `journalctl --user --no-pager -n ${lineLimit} -o cat _SYSTEMD_INVOCATION_ID=${shellQuoteSingle(state.invocationId)}`
    : `journalctl --user --no-pager -n ${lineLimit} -o cat -u ${shellQuoteSingle(unit)}`;
  const mergedRet = await runSsh(host, `bash -lc ${shellQuoteSingle(journalCmd)}`);
  if (!mergedRet.ok) {
    throw new Error(formatCommandFailure('journalctl', mergedRet));
  }

  return {
    stdout: mergedRet.stdout,
    stderr: '',
  };
}
