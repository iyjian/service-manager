import net from 'node:net';
import { promises as fs } from 'node:fs';
import { Client } from 'ssh2';
import type { HostConfig, ServiceConfig } from '../shared/types';
import { closeSshClients, connectSshChain, type SshEndpointConfig } from './sshChain';

interface RunningForward {
  targetClient: Client;
  jumpClients: Client[];
  server: net.Server;
  localPort: number;
}

export class PortForwardManager {
  private readonly running = new Map<string, RunningForward>();

  async start(id: string, host: HostConfig, service: ServiceConfig): Promise<void> {
    if (!service.forwardLocalPort || service.port <= 0) {
      return;
    }

    const existing = this.running.get(id);
    if (existing && existing.localPort === service.forwardLocalPort) {
      return;
    }

    if (existing) {
      await this.stop(id);
    }

    const { targetClient, jumpClients } = await connectSshChain(
      await this.toConnectableEndpoint(host),
      host.jumpHosts.map((jumpHost) => this.toConnectableJumpEndpoint(jumpHost)),
      {
        readyTimeout: 20000,
        keepaliveInterval: 10000,
        keepaliveCountMax: 6,
      }
    );

    const server = net.createServer((socket) => {
      targetClient.forwardOut(
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

    targetClient.on('close', onClose);
    targetClient.on('error', onClose);
    for (const jumpClient of jumpClients) {
      jumpClient.on('close', onClose);
      jumpClient.on('error', onClose);
    }
    server.on('error', onClose);

    this.running.set(id, {
      targetClient,
      jumpClients,
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
      running.targetClient.end();
    } catch {
      // no-op
    }
    closeSshClients(running.jumpClients);
  }

  async stopMany(ids: string[]): Promise<void> {
    for (const id of ids) {
      await this.stop(id);
    }
  }

  async stopAll(): Promise<void> {
    await this.stopMany([...this.running.keys()]);
  }

  private async toConnectableEndpoint(host: HostConfig): Promise<SshEndpointConfig> {
    const privateKey = host.privateKey?.trim()
      ? host.privateKey
      : host.privateKeyPath
        ? await fs.readFile(host.privateKeyPath, 'utf8')
        : undefined;
    return {
      sshHost: host.sshHost,
      sshPort: host.sshPort,
      username: host.username,
      authType: host.authType,
      password: host.password,
      privateKey,
      passphrase: host.passphrase,
    };
  }

  private toConnectableJumpEndpoint(jumpHost: HostConfig['jumpHosts'][number]): SshEndpointConfig {
    return {
      sshHost: jumpHost.sshHost,
      sshPort: jumpHost.sshPort,
      username: jumpHost.username,
      authType: jumpHost.authType,
      password: jumpHost.password,
      privateKey: jumpHost.privateKey,
      passphrase: jumpHost.passphrase,
    };
  }
}
