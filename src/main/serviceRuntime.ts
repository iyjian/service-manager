import { promises as fs } from 'node:fs';
import { Client, type ClientChannel, type ConnectConfig } from 'ssh2';
import type { HostConfig, ServiceConfig, ServiceLogsResult, ServiceStatus } from '../shared/types';

interface SshResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number;
}

export interface StartResult {
  ok: boolean;
  pid?: number;
  error?: string;
}

interface SystemdServiceState {
  exists: boolean;
  activeState?: string;
  subState?: string;
  result?: string;
  mainPid?: number;
  invocationId?: string;
}

async function resolvePrivateKey(host: HostConfig): Promise<string | undefined> {
  if (host.privateKey?.trim()) return host.privateKey;
  if (!host.privateKeyPath) return undefined;
  return fs.readFile(host.privateKeyPath, 'utf8');
}

async function buildTargetConnectConfig(host: HostConfig): Promise<ConnectConfig> {
  const base: ConnectConfig = {
    host: host.sshHost,
    port: host.sshPort,
    username: host.username,
    readyTimeout: 10000,
    keepaliveInterval: 5000,
    keepaliveCountMax: 2,
  };

  if (host.authType === 'password') {
    base.password = host.password;
    return base;
  }

  const privateKey = await resolvePrivateKey(host);
  if (!privateKey) {
    throw new Error('Private key is required for private key authentication.');
  }
  base.privateKey = privateKey;
  if (host.passphrase) {
    base.passphrase = host.passphrase;
  }
  return base;
}

function buildJumpConnectConfig(host: HostConfig): ConnectConfig | undefined {
  if (!host.jumpHost) return undefined;

  const base: ConnectConfig = {
    host: host.jumpHost.sshHost,
    port: host.jumpHost.sshPort,
    username: host.jumpHost.username,
    readyTimeout: 10000,
    keepaliveInterval: 5000,
    keepaliveCountMax: 2,
  };

  if (host.jumpHost.authType === 'password') {
    base.password = host.jumpHost.password;
    return base;
  }

  if (!host.jumpHost.privateKey?.trim()) {
    throw new Error('Jump host private key is required for private key auth.');
  }

  base.privateKey = host.jumpHost.privateKey;
  if (host.jumpHost.passphrase) {
    base.passphrase = host.jumpHost.passphrase;
  }
  return base;
}

function connectClient(client: Client, connectConfig: ConnectConfig): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;

    const onReady = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };

    const onError = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const onClose = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('SSH connection closed before ready.'));
    };

    const cleanup = (): void => {
      client.off('ready', onReady);
      client.off('error', onError);
      client.off('close', onClose);
    };

    client.once('ready', onReady);
    client.once('error', onError);
    client.on('close', onClose);
    client.connect(connectConfig);
  });
}

async function connectTargetClient(host: HostConfig): Promise<{ targetClient: Client; jumpClient?: Client }> {
  const targetClient = new Client();
  const targetConfig = await buildTargetConnectConfig(host);
  const jumpConfig = buildJumpConnectConfig(host);

  if (!jumpConfig) {
    await connectClient(targetClient, targetConfig);
    return { targetClient };
  }

  const jumpClient = new Client();
  await connectClient(jumpClient, jumpConfig);

  const sock = await new Promise<ConnectConfig['sock']>((resolve, reject) => {
    jumpClient.forwardOut('127.0.0.1', 0, host.sshHost, host.sshPort, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stream);
    });
  });

  await connectClient(targetClient, {
    ...targetConfig,
    sock,
  });

  return { targetClient, jumpClient };
}

export async function runSsh(host: HostConfig, command: string): Promise<SshResult> {
  return new Promise<SshResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let targetClient: Client | undefined;
    let jumpClient: Client | undefined;

    const settle = (result: SshResult): void => {
      if (settled) return;
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      try {
        targetClient?.end();
      } catch {
        // no-op
      }
      try {
        jumpClient?.end();
      } catch {
        // no-op
      }
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
        targetClient = connected.targetClient;
        jumpClient = connected.jumpClient;

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

function buildSystemdUnitName(host: HostConfig, service: ServiceConfig): string {
  return `service-manager-${safeUnitFragment(host.id)}-${safeUnitFragment(service.id)}.service`;
}

function shellQuoteSingle(raw: string): string {
  return `'${raw.replace(/'/g, `'"'"'`)}'`;
}

function buildManagedShellLauncher(command: string): string {
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

function parseSystemdState(raw: string): SystemdServiceState {
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
const SYSTEMD_SUPPORT_CACHE_MS = 15_000;

async function ensureSystemdSupport(host: HostConfig): Promise<void> {
  const cacheKey = host.id;
  const cached = systemdSupportCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    if (cached.error) {
      throw new Error(cached.error);
    }
    return;
  }

  const toolsRet = await runSsh(
    host,
    `bash -lc ${shellQuoteSingle(
      'command -v systemd-run >/dev/null 2>&1 && command -v systemctl >/dev/null 2>&1 && command -v journalctl >/dev/null 2>&1 && command -v loginctl >/dev/null 2>&1'
    )}`
  );
  if (!toolsRet.ok) {
    const error =
      'Remote host does not provide usable systemd tooling. Please install systemd so systemd-run, systemctl, journalctl, and loginctl are available.';
    systemdSupportCache.set(cacheKey, { expiresAt: Date.now() + SYSTEMD_SUPPORT_CACHE_MS, error });
    throw new Error(error);
  }

  const userManagerRet = await runSsh(
    host,
    `bash -lc ${shellQuoteSingle('systemctl --user show-environment >/dev/null 2>&1')}`
  );
  if (!userManagerRet.ok) {
    const error =
      'Remote host requires a working systemd user session. Please install/configure systemd and make sure `systemctl --user` works for this SSH account.';
    systemdSupportCache.set(cacheKey, { expiresAt: Date.now() + SYSTEMD_SUPPORT_CACHE_MS, error });
    throw new Error(error);
  }

  const lingerRet = await runSsh(
    host,
    `bash -lc ${shellQuoteSingle('loginctl show-user "$USER" -p Linger --value 2>/dev/null')}`
  );
  if (!lingerRet.ok || lingerRet.stdout.trim() !== 'yes') {
    const error =
      'Remote host requires systemd user lingering for this SSH account. Please run `sudo loginctl enable-linger <username>` on the remote host so services survive after SSH disconnects.';
    systemdSupportCache.set(cacheKey, { expiresAt: Date.now() + SYSTEMD_SUPPORT_CACHE_MS, error });
    throw new Error(error);
  }

  systemdSupportCache.set(cacheKey, { expiresAt: Date.now() + SYSTEMD_SUPPORT_CACHE_MS });
}

async function querySystemdServiceState(host: HostConfig, service: ServiceConfig): Promise<SystemdServiceState> {
  await ensureSystemdSupport(host);

  const unit = buildSystemdUnitName(host, service);
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

async function waitForSystemdMainPid(
  host: HostConfig,
  service: ServiceConfig,
  timeoutMs = 5000
): Promise<SystemdServiceState> {
  const startedAt = Date.now();
  let latest: SystemdServiceState = { exists: false };

  while (Date.now() - startedAt < timeoutMs) {
    latest = await querySystemdServiceState(host, service);
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

function buildSystemdFailureMessage(host: HostConfig, service: ServiceConfig, state: SystemdServiceState): string {
  const unit = buildSystemdUnitName(host, service);
  const result = state.result || state.subState || state.activeState || 'unknown';
  return `systemd unit ${unit} failed (${result}).`;
}

export async function startService(host: HostConfig, service: ServiceConfig): Promise<StartResult> {
  try {
    const unit = buildSystemdUnitName(host, service);
    const current = await querySystemdServiceState(host, service);
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

    const state = await waitForSystemdMainPid(host, service);
    if (!state.exists) {
      return {
        ok: false,
        error: `systemd unit ${unit} did not become available after start.`,
      };
    }
    if (state.activeState === 'failed') {
      return {
        ok: false,
        error: buildSystemdFailureMessage(host, service, state),
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
    const unit = buildSystemdUnitName(host, service);
    const state = await querySystemdServiceState(host, service);
    if (!state.exists || state.activeState === 'inactive') {
      return { ok: true };
    }

    const stopCmd = `systemctl --user stop ${shellQuoteSingle(unit)}`;
    const ret = await runSsh(host, `bash -lc ${shellQuoteSingle(stopCmd)}`);
    if (!ret.ok) {
      return { ok: false, error: formatCommandFailure(`systemctl stop ${unit}`, ret) };
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
    const state = await querySystemdServiceState(host, service);
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
        error: buildSystemdFailureMessage(host, service, state),
      };
    }

    return {
      status: 'unknown',
      pid: state.mainPid,
      error: `Unknown systemd state: ${state.activeState ?? 'unknown'}/${state.subState ?? 'unknown'}`,
    };
  } catch (error) {
    return {
      status: 'error',
      pid: service.pid,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function getServiceLogs(host: HostConfig, service: ServiceConfig): Promise<ServiceLogsResult> {
  const unit = buildSystemdUnitName(host, service);
  const state = await querySystemdServiceState(host, service);
  const journalCmd = state.invocationId
    ? `journalctl --user --no-pager -n 200 -o cat _SYSTEMD_INVOCATION_ID=${shellQuoteSingle(state.invocationId)}`
    : `journalctl --user --no-pager -n 200 -o cat -u ${shellQuoteSingle(unit)}`;
  const mergedRet = await runSsh(host, `bash -lc ${shellQuoteSingle(journalCmd)}`);
  if (!mergedRet.ok) {
    throw new Error(formatCommandFailure('journalctl', mergedRet));
  }

  return {
    stdout: mergedRet.stdout,
    stderr: '',
  };
}
