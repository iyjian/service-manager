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
  stdoutPath?: string;
  stderrPath?: string;
  error?: string;
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

function safeFileFragment(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function shellQuoteSingle(raw: string): string {
  return `'${raw.replace(/'/g, `'"'"'`)}'`;
}

export async function startService(host: HostConfig, service: ServiceConfig): Promise<StartResult> {
  const safeHost = safeFileFragment(host.name || host.sshHost);
  const safeService = safeFileFragment(service.name);
  const stdoutPath = `/tmp/service-manager/${safeHost}_${safeService}.log`;
  const stderrPath = stdoutPath;
  const detachedCmd = shellQuoteSingle(service.startCommand);
  const inner = `mkdir -p /tmp/service-manager && OUT=${shellQuoteSingle(stdoutPath)} && : >"$OUT" && SHELL_BIN="\${SHELL:-/bin/bash}" && setsid "$SHELL_BIN" -ilc ${detachedCmd} >"$OUT" 2>&1 < /dev/null & PID=$! && echo "__PID:$PID"`;
  const wrapped = `bash -lc ${shellQuoteSingle(inner)}`;
  const ret = await runSsh(host, wrapped);

  const lines = ret.stdout.split('\n').map((line) => line.trim());
  const pidLine = lines.find((line) => line.startsWith('__PID:'));
  const pid = Number(pidLine?.replace('__PID:', ''));

  if (!ret.ok && (!Number.isInteger(pid) || pid <= 0)) {
    return {
      ok: false,
      error: `start command failed\nstdout:\n${ret.stdout || '(empty)'}\nstderr:\n${ret.stderr || '(empty)'}`,
    };
  }

  if (!Number.isInteger(pid) || pid <= 0) {
    return {
      ok: false,
      error: `Failed to capture started PID.\nstdout:\n${ret.stdout || '(empty)'}\nstderr:\n${ret.stderr || '(empty)'}`,
    };
  }

  return {
    ok: true,
    pid,
    stdoutPath,
    stderrPath,
  };
}

export async function stopService(host: HostConfig, service: ServiceConfig): Promise<{ ok: boolean; error?: string }> {
  if (!service.pid) {
    return { ok: false, error: 'PID is empty; cannot stop service.' };
  }

  const ret = await runSsh(
    host,
    `bash -lc 'PGID=$(ps -o pgid= -p ${service.pid} | tr -d " "); if [ -n "$PGID" ]; then kill -TERM -"$PGID"; else kill -TERM ${service.pid}; fi'`
  );
  if (!ret.ok) {
    return { ok: false, error: ret.stderr.trim() || `kill ${service.pid} (process group) failed` };
  }
  return { ok: true };
}

export async function checkServiceStatus(
  host: HostConfig,
  service: ServiceConfig
): Promise<{ status: ServiceStatus; pid?: number; error?: string }> {
  const pidByPortRet = await runSsh(
    host,
    `bash -lc "lsof -tiTCP:${service.port} -sTCP:LISTEN 2>/dev/null | head -n 1"`
  );
  const pidByPort = Number(pidByPortRet.stdout.trim());
  if (Number.isInteger(pidByPort) && pidByPort > 0) {
    return { status: 'running', pid: pidByPort };
  }

  if (!service.pid) {
    return { status: 'stopped' };
  }

  const ret = await runSsh(host, `kill -0 ${service.pid} >/dev/null 2>&1`);
  if (ret.ok) {
    return { status: 'running', pid: service.pid };
  }

  if (ret.code === 1) {
    return { status: 'stopped' };
  }

  return { status: 'error', error: ret.stderr.trim() || 'status check failed' };
}

export async function getServiceLogs(host: HostConfig, service: ServiceConfig): Promise<ServiceLogsResult> {
  if (!service.pid || !service.stdoutPath || !service.stderrPath) {
    return { stdout: '', stderr: '' };
  }

  if (service.stdoutPath === service.stderrPath) {
    const mergedRet = await runSsh(host, `tail -n 200 ${JSON.stringify(service.stdoutPath)}`);
    return {
      stdout: mergedRet.stdout || (mergedRet.ok ? '' : mergedRet.stderr),
      stderr: '',
    };
  }

  const stdoutRet = await runSsh(host, `tail -n 200 ${JSON.stringify(service.stdoutPath)}`);
  const stderrRet = await runSsh(host, `tail -n 200 ${JSON.stringify(service.stderrPath)}`);

  return {
    stdout: stdoutRet.stdout || (stdoutRet.ok ? '' : stdoutRet.stderr),
    stderr: stderrRet.stdout || (stderrRet.ok ? '' : stderrRet.stderr),
  };
}
