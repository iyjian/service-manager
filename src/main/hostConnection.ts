import { promises as fs } from 'node:fs';
import type { ForwardRule, HostConfig } from '../shared/types';
import type { SshEndpointConfig } from './sshChain';
import type { ForwardRuntimeConfig } from './tunnelManager';

export async function resolveHostPrivateKey(host: HostConfig): Promise<string | undefined> {
  if (host.privateKey?.trim()) return host.privateKey;
  if (!host.privateKeyPath) return undefined;
  return fs.readFile(host.privateKeyPath, 'utf8');
}

export async function hostToEndpoint(host: HostConfig): Promise<SshEndpointConfig> {
  return {
    sshHost: host.sshHost,
    sshPort: host.sshPort,
    username: host.username,
    authType: host.authType,
    password: host.password,
    privateKey: await resolveHostPrivateKey(host),
    passphrase: host.passphrase,
  };
}

export function jumpHostsToEndpoints(host: HostConfig): SshEndpointConfig[] {
  return host.jumpHosts.map((jumpHost) => ({
    sshHost: jumpHost.sshHost,
    sshPort: jumpHost.sshPort,
    username: jumpHost.username,
    authType: jumpHost.authType,
    password: jumpHost.password,
    privateKey: jumpHost.privateKey,
    passphrase: jumpHost.passphrase,
  }));
}

export async function forwardToRuntimeConfig(host: HostConfig, forward: ForwardRule): Promise<ForwardRuntimeConfig> {
  return {
    id: forward.id,
    sshHost: host.sshHost,
    sshPort: host.sshPort,
    username: host.username,
    authType: host.authType,
    password: host.password,
    privateKey: await resolveHostPrivateKey(host),
    passphrase: host.passphrase,
    jumpHosts: host.jumpHosts.map((jumpHost) => ({
      ...jumpHost,
      privateKey: jumpHost.authType === 'privateKey' ? jumpHost.privateKey : undefined,
    })),
    localHost: forward.localHost,
    localPort: forward.localPort,
    remoteHost: forward.remoteHost,
    remotePort: forward.remotePort,
  };
}
