import { EventEmitter } from 'node:events';
import net from 'node:net';
import { Client, type ConnectConfig } from 'ssh2';
import type { AuthType, TunnelStatusChange } from '../shared/types';

export interface ForwardRuntimeConfig {
  id: string;
  sshHost: string;
  sshPort: number;
  username: string;
  authType: AuthType;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  localHost: string;
  localPort: number;
  remoteHost: string;
  remotePort: number;
}

interface RunningTunnel {
  client: Client;
  server: net.Server;
}

type StartStage = 'local-port-precheck' | 'target-connect' | 'local-listen';

const RECONNECT_DELAY_MS = 5000;

export class TunnelManager extends EventEmitter {
  private readonly running = new Map<string, RunningTunnel>();
  private readonly statuses = new Map<string, TunnelStatusChange>();
  private readonly configs = new Map<string, ForwardRuntimeConfig>();
  private readonly reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();

  getStatus(id: string): TunnelStatusChange {
    return this.statuses.get(id) ?? { hostId: '', forwardId: id, status: 'stopped' };
  }

  setKnownTunnel(id: string): void {
    if (!this.statuses.has(id)) {
      this.statuses.set(id, { hostId: '', forwardId: id, status: 'stopped' });
    }
  }

  clearTunnel(id: string): void {
    this.clearReconnectTimer(id);
    this.configs.delete(id);
    this.statuses.delete(id);
  }

  async start(config: ForwardRuntimeConfig): Promise<void> {
    this.configs.set(config.id, { ...config });
    this.clearReconnectTimer(config.id);

    if (this.running.has(config.id)) return;

    this.updateStatus({ forwardId: config.id, status: 'starting' });

    const client = new Client();
    let server: net.Server | undefined;

    try {
      try {
        await this.assertLocalEndpointAvailable(config.localHost, config.localPort);
      } catch (error) {
        throw this.buildStartError('local-port-precheck', config, error);
      }

      try {
        await this.connectClient(client, this.toConnectConfig(config));
      } catch (error) {
        throw this.buildStartError('target-connect', config, error);
      }

      try {
        server = await this.createLocalServer(config, client);
      } catch (error) {
        throw this.buildStartError('local-listen', config, error);
      }

      this.running.set(config.id, { client, server });
      this.bindRuntimeHandlers(config.id, client, server);
      this.updateStatus({ forwardId: config.id, status: 'running' });
    } catch (error) {
      this.safeCloseServer(server);
      this.safeEndClient(client);
      this.cleanup(config.id, { keepStatus: true });
      const message = error instanceof Error ? error.message : String(error);
      this.markErrorAndScheduleReconnect(config.id, message);
      throw new Error(message);
    }
  }

  async stop(id: string): Promise<void> {
    this.clearReconnectTimer(id);
    if (!this.running.has(id)) {
      this.updateStatus({ forwardId: id, status: 'stopped' });
      return;
    }
    this.updateStatus({ forwardId: id, status: 'stopping' });
    this.cleanup(id, { keepStatus: true });
    this.updateStatus({ forwardId: id, status: 'stopped' });
  }

  async stopAll(): Promise<void> {
    for (const id of this.reconnectTimers.keys()) this.clearReconnectTimer(id);
    await Promise.all([...this.running.keys()].map((id) => this.stop(id)));
  }

  private toConnectConfig(config: ForwardRuntimeConfig): ConnectConfig {
    const ret: ConnectConfig = {
      host: config.sshHost,
      port: config.sshPort,
      username: config.username,
      keepaliveInterval: 10000,
      keepaliveCountMax: 6,
      readyTimeout: 20000,
    };
    if (config.authType === 'password') {
      ret.password = config.password ?? '';
    } else {
      ret.privateKey = config.privateKey ?? '';
      if (config.passphrase) ret.passphrase = config.passphrase;
    }
    return ret;
  }

  private connectClient(client: Client, connectConfig: ConnectConfig): Promise<void> {
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

  private createLocalServer(config: ForwardRuntimeConfig, client: Client): Promise<net.Server> {
    const server = net.createServer((socket) => {
      client.forwardOut(
        socket.localAddress ?? '127.0.0.1',
        socket.localPort ?? 0,
        config.remoteHost,
        config.remotePort,
        (error, stream) => {
          if (error) {
            socket.once('error', () => undefined);
            socket.destroy();
            return;
          }
          socket.pipe(stream).pipe(socket);
          stream.on('error', () => socket.destroy());
          socket.on('error', () => stream.destroy());
        }
      );
    });

    return new Promise((resolve, reject) => {
      const onListening = (): void => {
        cleanup();
        resolve(server);
      };
      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const cleanup = (): void => {
        server.off('listening', onListening);
        server.off('error', onError);
      };
      server.once('listening', onListening);
      server.once('error', onError);
      server.listen(config.localPort, config.localHost);
    });
  }

  private assertLocalEndpointAvailable(localHost: string, localPort: number): Promise<void> {
    const probe = net.createServer();
    return new Promise((resolve, reject) => {
      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const onListening = (): void => {
        probe.close(() => {
          cleanup();
          resolve();
        });
      };
      const cleanup = (): void => {
        probe.off('error', onError);
        probe.off('listening', onListening);
      };
      probe.once('error', onError);
      probe.once('listening', onListening);
      probe.listen(localPort, localHost);
    });
  }

  private buildStartError(stage: StartStage, config: ForwardRuntimeConfig, error: unknown): Error {
    const rawMessage = error instanceof Error ? error.message : String(error);
    const code = this.getErrorCode(error);
    if (stage === 'local-port-precheck' || stage === 'local-listen') {
      if (code === 'EADDRINUSE') {
        return new Error(`Local port ${config.localPort} on ${config.localHost} is already in use.`);
      }
      if (code === 'EACCES') {
        return new Error(`Permission denied when binding ${config.localHost}:${config.localPort}.`);
      }
      return new Error(`Failed to bind local listener on ${config.localHost}:${config.localPort}: ${rawMessage}`);
    }
    return new Error(`Unable to connect SSH ${config.sshHost}:${config.sshPort}. ${rawMessage}`);
  }

  private getErrorCode(error: unknown): string | undefined {
    if (!error || typeof error !== 'object') return undefined;
    const code = (error as NodeJS.ErrnoException).code;
    return typeof code === 'string' ? code : undefined;
  }

  private bindRuntimeHandlers(id: string, client: Client, server: net.Server): void {
    const handleRuntimeError = (prefix: string, error: Error): void => {
      if (!this.running.has(id)) return;
      this.cleanup(id, { keepStatus: true });
      this.markErrorAndScheduleReconnect(id, `${prefix}: ${error.message}`);
    };

    server.on('error', (error) => handleRuntimeError('Local listener error', error as Error));
    client.on('error', (error) => handleRuntimeError('SSH error', error));
    client.on('close', () => {
      if (!this.running.has(id)) return;
      this.cleanup(id, { keepStatus: true });
      this.markErrorAndScheduleReconnect(id, 'SSH connection closed unexpectedly.');
    });
  }

  private cleanup(id: string, options?: { keepStatus?: boolean }): void {
    const running = this.running.get(id);
    if (!running) return;
    this.running.delete(id);
    try {
      running.server.close();
    } catch {
      // no-op
    }
    try {
      running.client.end();
    } catch {
      // no-op
    }
    if (!options?.keepStatus) {
      this.updateStatus({ forwardId: id, status: 'stopped' });
    }
  }

  private updateStatus(change: Omit<TunnelStatusChange, 'hostId'> & { hostId?: string }): void {
    const prev = this.statuses.get(change.forwardId);
    const next: TunnelStatusChange = {
      hostId: change.hostId ?? prev?.hostId ?? '',
      forwardId: change.forwardId,
      status: change.status,
      error: change.error,
      reconnectAt: change.reconnectAt,
    };
    this.statuses.set(change.forwardId, next);
    this.emit('status-changed', next);
  }

  private markErrorAndScheduleReconnect(id: string, error: string): void {
    const reconnectAt = Date.now() + RECONNECT_DELAY_MS;
    this.updateStatus({ forwardId: id, status: 'error', error, reconnectAt });
    this.scheduleReconnect(id, reconnectAt);
  }

  private scheduleReconnect(id: string, reconnectAt: number): void {
    const config = this.configs.get(id);
    if (!config) return;
    this.clearReconnectTimer(id);
    const delay = Math.max(0, reconnectAt - Date.now());
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(id);
      const current = this.statuses.get(id);
      if (current?.status === 'stopped' || current?.status === 'stopping') return;
      void this.start(config).catch(() => undefined);
    }, delay);
    this.reconnectTimers.set(id, timer);
  }

  private clearReconnectTimer(id: string): void {
    const timer = this.reconnectTimers.get(id);
    if (!timer) return;
    clearTimeout(timer);
    this.reconnectTimers.delete(id);
  }

  private safeEndClient(client: Client | undefined): void {
    if (!client) return;
    try {
      client.end();
    } catch {
      // no-op
    }
  }

  private safeCloseServer(server: net.Server | undefined): void {
    if (!server) return;
    try {
      server.close();
    } catch {
      // no-op
    }
  }
}
