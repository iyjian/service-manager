import { Client, type ConnectConfig } from 'ssh2';
import type { AuthType } from '../shared/types';

export interface SshEndpointConfig {
  sshHost: string;
  sshPort: number;
  username: string;
  authType: AuthType;
  password?: string;
  privateKey?: string;
  passphrase?: string;
}

export interface SshConnectOptions {
  readyTimeout?: number;
  keepaliveInterval?: number;
  keepaliveCountMax?: number;
}

export type SshChainStage = 'jump-connect' | 'jump-forward' | 'target-connect';

export class SshChainError extends Error {
  readonly stage: SshChainStage;
  readonly hopIndex?: number;

  constructor(stage: SshChainStage, message: string, hopIndex?: number) {
    super(message);
    this.name = 'SshChainError';
    this.stage = stage;
    this.hopIndex = hopIndex;
  }
}

export interface ConnectedSshChain {
  targetClient: Client;
  jumpClients: Client[];
  allClients: Client[];
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === 'string' ? error : String(error);
}

export function buildConnectConfig(endpoint: SshEndpointConfig, options?: SshConnectOptions): ConnectConfig {
  const connectConfig: ConnectConfig = {
    host: endpoint.sshHost,
    port: endpoint.sshPort,
    username: endpoint.username,
    readyTimeout: options?.readyTimeout ?? 20000,
    keepaliveInterval: options?.keepaliveInterval ?? 10000,
    keepaliveCountMax: options?.keepaliveCountMax ?? 6,
  };

  if (endpoint.authType === 'password') {
    if (!endpoint.password) {
      throw new Error(`Password is required for SSH user ${endpoint.username}.`);
    }
    connectConfig.password = endpoint.password;
    return connectConfig;
  }

  if (!endpoint.privateKey?.trim()) {
    throw new Error(`Private key is required for SSH user ${endpoint.username}.`);
  }

  connectConfig.privateKey = endpoint.privateKey;
  if (endpoint.passphrase) {
    connectConfig.passphrase = endpoint.passphrase;
  }
  return connectConfig;
}

export function connectClient(client: Client, connectConfig: ConnectConfig): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;

    const onReady = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve();
    };

    const onError = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };

    const onClose = (): void => {
      if (settled) {
        return;
      }
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

export function closeSshClients(clients: Iterable<Client | undefined>): void {
  for (const client of clients) {
    if (!client) {
      continue;
    }
    try {
      client.end();
    } catch {
      // no-op
    }
  }
}

async function forwardThroughClient(client: Client, targetHost: string, targetPort: number): Promise<ConnectConfig['sock']> {
  return new Promise((resolve, reject) => {
    client.forwardOut('127.0.0.1', 0, targetHost, targetPort, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stream);
    });
  });
}

export async function connectSshChain(
  target: SshEndpointConfig,
  jumpHosts: SshEndpointConfig[],
  options?: SshConnectOptions
): Promise<ConnectedSshChain> {
  const jumpClients: Client[] = [];
  const allClients: Client[] = [];
  let upstreamClient: Client | undefined;

  try {
    for (let index = 0; index < jumpHosts.length; index += 1) {
      const jumpHost = jumpHosts[index];
      const jumpClient = new Client();
      const jumpConfig = buildConnectConfig(jumpHost, options);

      if (upstreamClient) {
        try {
          jumpConfig.sock = await forwardThroughClient(upstreamClient, jumpHost.sshHost, jumpHost.sshPort);
        } catch (error) {
          throw new SshChainError('jump-forward', toErrorMessage(error), index);
        }
      }

      try {
        await connectClient(jumpClient, jumpConfig);
      } catch (error) {
        throw new SshChainError('jump-connect', toErrorMessage(error), index);
      }

      jumpClients.push(jumpClient);
      allClients.push(jumpClient);
      upstreamClient = jumpClient;
    }

    const targetClient = new Client();
    const targetConfig = buildConnectConfig(target, options);

    if (upstreamClient) {
      try {
        targetConfig.sock = await forwardThroughClient(upstreamClient, target.sshHost, target.sshPort);
      } catch (error) {
        throw new SshChainError('jump-forward', toErrorMessage(error), jumpHosts.length);
      }
    }

    try {
      await connectClient(targetClient, targetConfig);
    } catch (error) {
      throw new SshChainError('target-connect', toErrorMessage(error), jumpHosts.length);
    }

    allClients.push(targetClient);
    return { targetClient, jumpClients, allClients };
  } catch (error) {
    closeSshClients(allClients);
    if (error instanceof SshChainError) {
      throw error;
    }

    throw new SshChainError(jumpHosts.length > 0 ? 'jump-connect' : 'target-connect', toErrorMessage(error));
  }
}
