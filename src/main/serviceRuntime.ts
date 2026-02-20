import { promises as fs } from 'node:fs';
import { Client, type ClientChannel } from 'ssh2';
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

async function buildConnectionConfig(host: HostConfig): Promise<{
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
}> {
  if (host.authType === 'password') {
    return {
      host: host.sshHost,
      port: host.sshPort,
      username: host.username,
      password: host.password,
    };
  }

  const privateKey = host.privateKey?.trim()
    ? host.privateKey
    : host.privateKeyPath
      ? await fs.readFile(host.privateKeyPath, 'utf8')
      : undefined;

  if (!privateKey) {
    throw new Error('Private key is required for private key authentication.');
  }

  return {
    host: host.sshHost,
    port: host.sshPort,
    username: host.username,
    privateKey,
    passphrase: host.passphrase,
  };
}

export async function runSsh(host: HostConfig, command: string): Promise<SshResult> {
  const config = await buildConnectionConfig(host);

  return new Promise<SshResult>((resolve) => {
    const client = new Client();
    let stdout = '';
    let stderr = '';
    let settled = false;

    const settle = (result: SshResult): void => {
      if (settled) return;
      settled = true;
      client.end();
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

    client
      .on('ready', () => {
        client.exec(command, (execError: Error | undefined, stream: ClientChannel) => {
          if (execError) {
            clearTimeout(timer);
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
              clearTimeout(timer);
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
      })
      .on('error', (error: Error) => {
        clearTimeout(timer);
        settle({
          ok: false,
          stdout,
          stderr: error.message || 'SSH connection failed',
          code: -1,
        });
      })
      .connect({
        ...config,
        readyTimeout: 10000,
        keepaliveInterval: 5000,
        keepaliveCountMax: 2,
      });
  });
}

function safeFileFragment(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function shellQuoteSingle(raw: string): string {
  return `'${raw.replace(/'/g, `'\"'\"'`)}'`;
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

  // Some commands (like yarn start:dev) need warm-up time before binding ports.
  for (let i = 0; i < 15; i += 1) {
    const pidByPortRet = await runSsh(
      host,
      `bash -lc "lsof -tiTCP:${service.port} -sTCP:LISTEN 2>/dev/null | head -n 1"`
    );
    const pidByPort = Number(pidByPortRet.stdout.trim());
    if (Number.isInteger(pidByPort) && pidByPort > 0) {
      return {
        ok: true,
        pid: pidByPort,
        stdoutPath,
        stderrPath,
      };
    }

    const aliveCheck = await runSsh(host, `kill -0 ${pid} >/dev/null 2>&1`);
    if (aliveCheck.ok) {
      return {
        ok: true,
        pid,
        stdoutPath,
        stderrPath,
      };
    }

    await runSsh(host, 'sleep 1');
  }

  const earlyStdout = await runSsh(host, `tail -n 120 ${JSON.stringify(stdoutPath)}`);
  const earlyStderr = await runSsh(host, `tail -n 120 ${JSON.stringify(stderrPath)}`);
  const envDiag = await runSsh(
    host,
    `bash -ilc 'echo "SHELL=$SHELL"; echo "PATH=$PATH"; command -v yarn || true; command -v node || true; node -v || true; yarn -v || true'`
  );
  return {
    ok: false,
    error: `Process failed to become running within 15s.\nstdout:\n${earlyStdout?.stdout || '(empty)'}\nstderr:\n${earlyStderr?.stdout || earlyStderr?.stderr || '(empty)'}\nenv-stdout:\n${envDiag.stdout || '(empty)'}\nenv-stderr:\n${envDiag.stderr || '(empty)'}`,
  };

  return { ok: true, pid, stdoutPath, stderrPath };
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
