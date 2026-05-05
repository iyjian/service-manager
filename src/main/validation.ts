import { randomUUID } from 'node:crypto';
import type {
  AuthType,
  ForwardRule,
  ForwardRuleDraft,
  HostConfig,
  HostDraft,
  JumpHostConfig,
  ServiceConfig,
  ServiceDraft,
} from '../shared/types';

export interface SshEndpointDraft {
  sshHost: string;
  sshPort: number | string;
  username: string;
  authType: AuthType;
  password?: string;
  privateKey?: string;
  passphrase?: string;
}

export function validateForwardDraft(input: ForwardRuleDraft): ForwardRule {
  const forward: ForwardRule = {
    id: input.id?.trim() || randomUUID(),
    name: input.name?.trim() || undefined,
    localHost: input.localHost.trim(),
    localPort: Number(input.localPort),
    remoteHost: input.remoteHost.trim(),
    remotePort: Number(input.remotePort),
    autoStart: Boolean(input.autoStart),
  };

  if (!forward.localHost) throw new Error('Forward local host is required.');
  if (!forward.remoteHost) throw new Error('Forward remote host is required.');
  if (!Number.isInteger(forward.localPort) || forward.localPort < 1 || forward.localPort > 65535) {
    throw new Error('Forward local port must be an integer in range 1-65535.');
  }
  if (!Number.isInteger(forward.remotePort) || forward.remotePort < 1 || forward.remotePort > 65535) {
    throw new Error('Forward remote port must be an integer in range 1-65535.');
  }

  return forward;
}

export function validateServiceDraft(input: ServiceDraft): ServiceConfig {
  const service: ServiceConfig = {
    id: input.id?.trim() || randomUUID(),
    name: input.name.trim(),
    startCommand: input.startCommand.trim(),
    port: Number(input.port),
    forwardLocalPort: input.forwardLocalPort ? Number(input.forwardLocalPort) : undefined,
    pid: undefined,
  };

  if (!service.name) throw new Error('Service name is required.');
  if (!service.startCommand) throw new Error('Service start command is required.');
  if (!Number.isInteger(service.port) || service.port < 0 || service.port > 65535) {
    throw new Error('Service port must be an integer in range 0-65535.');
  }
  if (
    service.forwardLocalPort !== undefined &&
    (!Number.isInteger(service.forwardLocalPort) || service.forwardLocalPort < 1 || service.forwardLocalPort > 65535)
  ) {
    throw new Error('Forward local port must be an integer in range 1-65535.');
  }
  if (service.port === 0) {
    service.forwardLocalPort = undefined;
  }

  return service;
}

export function validateSshEndpoint(
  input: SshEndpointDraft,
  scope: 'target' | 'jump',
  options?: { allowMissingPrivateKey?: boolean; label?: string }
): JumpHostConfig {
  const label = options?.label ?? (scope === 'target' ? 'Target' : 'Jump host');
  const endpoint: JumpHostConfig = {
    sshHost: input.sshHost.trim(),
    sshPort: Number(input.sshPort),
    username: input.username.trim(),
    authType: input.authType,
    password: input.password,
    privateKey: input.privateKey,
    passphrase: input.passphrase,
  };

  if (!endpoint.sshHost) throw new Error(`${label} SSH host is required.`);
  if (!endpoint.username) throw new Error(`${label} SSH username is required.`);
  if (!Number.isInteger(endpoint.sshPort) || endpoint.sshPort < 1 || endpoint.sshPort > 65535) {
    throw new Error(`${label} SSH port must be an integer in range 1-65535.`);
  }

  if (endpoint.authType === 'password') {
    if (!endpoint.password) throw new Error(`${label} password is required for password auth.`);
    endpoint.privateKey = undefined;
    endpoint.passphrase = undefined;
  } else {
    if (!endpoint.privateKey?.trim() && !options?.allowMissingPrivateKey) {
      throw new Error(`${label} private key is required for private key auth.`);
    }
    endpoint.password = undefined;
  }

  return endpoint;
}

export function validateHostDraft(input: HostDraft): HostConfig {
  const target = validateSshEndpoint(
    {
      sshHost: input.sshHost,
      sshPort: input.sshPort,
      username: input.username,
      authType: input.authType,
      password: input.password,
      privateKey: input.privateKey,
      passphrase: input.passphrase,
    },
    'target',
    { allowMissingPrivateKey: Boolean(input.privateKeyPath) }
  );

  const rawJumpHosts = Array.isArray(input.jumpHosts)
    ? input.jumpHosts
    : input.jumpHost
      ? [input.jumpHost]
      : [];

  const host: HostConfig = {
    id: input.id?.trim() || randomUUID(),
    name: input.name.trim(),
    sshHost: target.sshHost,
    sshPort: target.sshPort,
    username: target.username,
    authType: target.authType,
    password: target.password,
    privateKey: target.privateKey,
    passphrase: target.passphrase,
    privateKeyPath: input.privateKeyPath?.trim() || undefined,
    jumpHosts: rawJumpHosts.map((jumpHost, index) =>
      validateSshEndpoint(jumpHost, 'jump', { allowMissingPrivateKey: false, label: `Jump server ${index + 1}` })
    ),
    forwards: (input.forwards ?? []).map((forward) => validateForwardDraft(forward)),
    services: (input.services ?? []).map((service) => validateServiceDraft(service)),
  };

  if (!host.name) throw new Error('Host name is required.');
  if (host.authType === 'privateKey' && !host.privateKey?.trim() && !host.privateKeyPath) {
    throw new Error('Target private key is required when auth type is private key.');
  }

  return host;
}

export function preserveServiceRuntimeFields(previous: HostConfig | undefined, next: HostConfig): HostConfig {
  if (!previous) {
    return next;
  }

  const previousById = new Map(previous.services.map((service) => [service.id, service]));
  return {
    ...next,
    services: next.services.map((service) => {
      const old = previousById.get(service.id);
      if (!old) {
        return service;
      }

      const sameRuntimeShape = old.startCommand === service.startCommand && old.port === service.port;
      if (!sameRuntimeShape) {
        return service;
      }

      return {
        ...service,
        pid: old.pid,
      };
    }),
  };
}
