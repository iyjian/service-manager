import net from 'node:net';
import { Client } from 'ssh2';
import type { HostConfig, ServiceConfig } from '../../shared/types';
import { hostToEndpoint, jumpHostsToEndpoints } from './hostConnection';
import { closeSshClients, connectSshChain } from './sshChain';

interface RunningForward {
  targetClient: Client;
  jumpClients: Client[];
  server: net.Server;
  sockets: Set<net.Socket>;
  localPort: number;
}

interface PendingStart {
  cancelled: boolean;
  promise: Promise<void>;
}

function cancelledStartError(): Error {
  return new Error('Port forward start was cancelled.');
}

function shutdownStartError(): Error {
  return new Error('Port forward manager is shut down.');
}

export class PortForwardManager {
  private readonly running = new Map<string, RunningForward>();
  private readonly pendingStarts = new Map<string, PendingStart>();
  private stopAllPromise?: Promise<void>;
  private shutdownPromise?: Promise<void>;
  private shutdownRequested = false;

  constructor(
    private readonly connect: typeof connectSshChain = connectSshChain,
    private readonly createServer: typeof net.createServer = net.createServer
  ) {}

  start(id: string, host: HostConfig, service: ServiceConfig): Promise<void> {
    if (this.shutdownRequested) {
      return Promise.reject(shutdownStartError());
    }

    const localPort = service.forwardLocalPort;
    if (!localPort || service.port <= 0) {
      return Promise.resolve();
    }

    // A start requested while a global stop is in progress belongs to the next
    // lifecycle (for example, imported hosts being auto-started after reset).
    // Re-enter after the barrier so stopAll never races this request while also
    // keeping the manager reusable once that barrier has completed.
    if (this.stopAllPromise) {
      return this.stopAllPromise.then(() => this.start(id, host, service));
    }

    const existing = this.running.get(id);
    if (existing && existing.localPort === localPort) {
      return Promise.resolve();
    }

    const pending = this.pendingStarts.get(id);
    if (pending) {
      if (pending.cancelled) {
        return pending.promise.catch(() => undefined).then(() => this.start(id, host, service));
      }
      return pending.promise;
    }

    const next = {} as PendingStart;
    next.cancelled = false;
    next.promise = Promise.resolve().then(() => this.startPending(id, host, service, localPort, next));
    this.pendingStarts.set(id, next);
    void next.promise.then(
      () => this.clearPendingStart(id, next),
      () => this.clearPendingStart(id, next)
    );
    return next.promise;
  }

  private async startPending(
    id: string,
    host: HostConfig,
    service: ServiceConfig,
    localPort: number,
    pending: PendingStart
  ): Promise<void> {
    const existing = this.running.get(id);
    if (existing) {
      await this.stopRunning(id, existing);
    }
    this.assertStartActive(pending);

    let targetClient: Client | undefined;
    let jumpClients: Client[] = [];
    let server: net.Server | undefined;
    const sockets = new Set<net.Socket>();

    try {
      const connected = await this.connect(
        await hostToEndpoint(host),
        jumpHostsToEndpoints(host),
        {
          readyTimeout: 20000,
          keepaliveInterval: 10000,
          keepaliveCountMax: 6,
        }
      );
      const connectedTargetClient = connected.targetClient;
      targetClient = connectedTargetClient;
      jumpClients = connected.jumpClients;
      this.assertStartActive(pending);

      const localServer = this.createServer((socket) => {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
        try {
          connectedTargetClient.forwardOut(
            socket.localAddress ?? '127.0.0.1',
            socket.localPort ?? 0,
            '127.0.0.1',
            service.port,
            (forwardError, stream) => {
              if (forwardError) {
                socket.destroy();
                return;
              }
              if (socket.destroyed) {
                stream.destroy();
                return;
              }
              socket.pipe(stream).pipe(socket);
              socket.on('error', () => stream.destroy());
              stream.on('error', () => socket.destroy());
            }
          );
        } catch {
          socket.destroy();
        }
      });
      server = localServer;

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
          localServer.off('listening', onListening);
          localServer.off('error', onError);
        };

        localServer.once('listening', onListening);
        localServer.once('error', onError);
        localServer.listen(localPort, '127.0.0.1');
      });
      this.assertStartActive(pending);

      const running: RunningForward = {
        targetClient: connectedTargetClient,
        jumpClients,
        server: localServer,
        sockets,
        localPort,
      };
      const onClose = (): void => {
        if (this.running.get(id) !== running) return;
        void this.stopRunning(id, running);
      };

      this.running.set(id, running);
      connectedTargetClient.on('close', onClose);
      connectedTargetClient.on('error', onClose);
      for (const jumpClient of jumpClients) {
        jumpClient.on('close', onClose);
        jumpClient.on('error', onClose);
      }
      localServer.on('error', onClose);
    } catch (error) {
      await this.closeServer(server, sockets);
      try {
        targetClient?.end();
      } catch {
        // no-op
      }
      closeSshClients(jumpClients);
      throw pending.cancelled ? cancelledStartError() : error;
    }
  }

  async stop(id: string): Promise<void> {
    const pending = this.pendingStarts.get(id);
    if (pending) {
      pending.cancelled = true;
      await pending.promise.catch(() => undefined);
    }
    await this.stopRunning(id);
  }

  private async stopRunning(id: string, expected?: RunningForward): Promise<void> {
    const running = this.running.get(id);
    if (!running || (expected && running !== expected)) {
      return;
    }

    this.running.delete(id);
    await this.closeServer(running.server, running.sockets);

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

  stopAll(): Promise<void> {
    if (this.stopAllPromise) {
      return this.stopAllPromise;
    }

    const pending = [...this.pendingStarts.values()];
    for (const start of pending) {
      start.cancelled = true;
    }
    const running = [...this.running.entries()];
    const operation = this.stopAllCurrent(pending, running);
    let tracked!: Promise<void>;
    tracked = operation.finally(() => {
      if (this.stopAllPromise === tracked) {
        this.stopAllPromise = undefined;
      }
    });
    this.stopAllPromise = tracked;
    return tracked;
  }

  /** Permanently fences new starts and releases every owned or pending forward. */
  shutdown(): Promise<void> {
    this.shutdownRequested = true;
    if (!this.shutdownPromise) {
      this.shutdownPromise = this.stopAll();
    }
    return this.shutdownPromise;
  }

  private async stopAllCurrent(
    pending: PendingStart[],
    running: Array<[string, RunningForward]>
  ): Promise<void> {
    await Promise.allSettled([
      ...pending.map((start) => start.promise),
      ...running.map(([id, forward]) => this.stopRunning(id, forward)),
    ]);

    // A start may have completed immediately before it observed cancellation.
    // Sweep once more after every captured start has settled so stopAll owns a
    // complete barrier over all work that existed when it was requested.
    await Promise.all(
      [...this.running.entries()].map(([id, forward]) => this.stopRunning(id, forward))
    );
  }

  private clearPendingStart(id: string, pending: PendingStart): void {
    if (this.pendingStarts.get(id) === pending) {
      this.pendingStarts.delete(id);
    }
  }

  private assertStartActive(pending: PendingStart): void {
    if (pending.cancelled) {
      throw cancelledStartError();
    }
  }

  private closeServer(server: net.Server | undefined, sockets: Set<net.Socket>): Promise<void> {
    if (!server) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      try {
        server.close(() => resolve());
      } catch {
        resolve();
      }
      for (const socket of sockets) {
        socket.destroy();
      }
    });
  }
}
