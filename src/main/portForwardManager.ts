import net from 'node:net';
import { promises as fs } from 'node:fs';
import { Client, type ConnectConfig } from 'ssh2';
import type { HostConfig, ServiceConfig } from '../shared/types';

interface RunningForward {
  client: Client;
  server: net.Server;
  localPort: number;
}

export class PortForwardManager {
  private readonly running = new Map<string, RunningForward>();

  async start(id: string, host: HostConfig, service: ServiceConfig): Promise<void> {
    if (!service.forwardLocalPort) {
      return;
    }

    const existing = this.running.get(id);
    if (existing && existing.localPort === service.forwardLocalPort) {
      return;
    }

    if (existing) {
      await this.stop(id);
    }

    const client = new Client();
    const connectConfig = await this.toConnectConfig(host);
    await this.connectClient(client, connectConfig);

    const server = net.createServer((socket) => {
      client.forwardOut(
        socket.localAddress ?? '127.0.0.1',
        socket.localPort ?? 0,
        '127.0.0.1',
        service.port,
        (forwardError, stream) => {
          if (forwardError) {
            socket.destroy();
            return;
          }
          socket.pipe(stream).pipe(socket);
          socket.on('error', () => stream.destroy());
          stream.on('error', () => socket.destroy());
        }
      );
    });

    await new Promise<void>((resolve, reject) => {
      const onListening = (): void => {
        cleanup();
        resolve();
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
      server.listen(service.forwardLocalPort, '127.0.0.1');
    });

    const onClose = (): void => {
      if (!this.running.has(id)) return;
      this.stop(id).catch(() => undefined);
    };

    client.on('close', onClose);
    client.on('error', onClose);
    server.on('error', onClose);

    this.running.set(id, {
      client,
      server,
      localPort: service.forwardLocalPort,
    });
  }

  async stop(id: string): Promise<void> {
    const running = this.running.get(id);
    if (!running) {
      return;
    }

    this.running.delete(id);

    await new Promise<void>((resolve) => {
      try {
        running.server.close(() => resolve());
      } catch {
        resolve();
      }
    });

    try {
      running.client.end();
    } catch {
      // no-op
    }
  }

  async stopMany(ids: string[]): Promise<void> {
    for (const id of ids) {
      await this.stop(id);
    }
  }

  async stopAll(): Promise<void> {
    await this.stopMany([...this.running.keys()]);
  }

  private async toConnectConfig(host: HostConfig): Promise<ConnectConfig> {
    const config: ConnectConfig = {
      host: host.sshHost,
      port: host.sshPort,
      username: host.username,
      keepaliveInterval: 10000,
      keepaliveCountMax: 6,
      readyTimeout: 20000,
    };

    if (host.authType === 'password') {
      config.password = host.password;
      return config;
    }

    const privateKey = host.privateKey?.trim()
      ? host.privateKey
      : host.privateKeyPath
        ? await fs.readFile(host.privateKeyPath, 'utf8')
        : undefined;

    if (!privateKey) {
      throw new Error('Private key is required for port forward.');
    }

    config.privateKey = privateKey;
    if (host.passphrase) {
      config.passphrase = host.passphrase;
    }

    return config;
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
}
