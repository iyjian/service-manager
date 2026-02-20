import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type {
  AuthType,
  ConfigTransferResult,
  ForwardRule,
  ForwardRuleDraft,
  ForwardState,
  HostConfig,
  HostDraft,
  HostView,
  JumpHostConfig,
  PrivateKeyImportResult,
  ServiceLogsResult,
  ServiceConfig,
  ServiceDraft,
  ServiceStatus,
  TunnelStatusChange,
} from '../shared/types';
import { ServiceStore } from './store';
import { checkServiceStatus, getServiceLogs, startService, stopService } from './serviceRuntime';
import { PortForwardManager } from './portForwardManager';
import { TunnelManager, type ForwardRuntimeConfig } from './tunnelManager';

const IPC_CHANNELS = {
  listHosts: 'host:list',
  saveHost: 'host:save',
  deleteHost: 'host:delete',
  exportConfig: 'config:export',
  importConfig: 'config:import',
  deleteService: 'service:delete',
  deleteForward: 'forward:delete',
  startService: 'service:start',
  stopService: 'service:stop',
  startForward: 'forward:start',
  stopForward: 'forward:stop',
  refreshService: 'service:refresh',
  getServiceLogs: 'service:logs',
  serviceStatusChanged: 'service:status',
  forwardStatusChanged: 'forward:status',
  importPrivateKey: 'auth:import-private-key',
  openExternal: 'app:open-external',
} as const;

interface SshEndpointDraft {
  sshHost: string;
  sshPort: number | string;
  username: string;
  authType: AuthType;
  password?: string;
  privateKey?: string;
  passphrase?: string;
}

interface ExportedConfigFile {
  schemaVersion: number;
  exportedAt: string;
  app: string;
  hosts: HostConfig[];
}

const runtimeStatus = new Map<string, { status: ServiceStatus; pid?: number; error?: string; updatedAt?: string }>();
const runtimeForwardStatus = new Map<string, { state: ForwardState; error?: string }>();
const forwardOwners = new Map<string, string>();
let store: ServiceStore | null = null;
const portForwardManager = new PortForwardManager();
const tunnelManager = new TunnelManager();

function getStore(): ServiceStore {
  if (!store) {
    throw new Error('Service store is not initialized.');
  }
  return store;
}

function serviceKey(hostId: string, serviceId: string): string {
  return `${hostId}:${serviceId}`;
}

function serviceForwardKey(hostId: string, serviceId: string): string {
  return serviceKey(hostId, serviceId);
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 900,
    minHeight: 620,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  void window.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  return window;
}

function getStatus(
  hostId: string,
  serviceId: string,
  defaultPid?: number
): { status: ServiceStatus; pid?: number; error?: string; updatedAt?: string } {
  const status = runtimeStatus.get(serviceKey(hostId, serviceId));
  return {
    status: status?.status ?? (defaultPid ? 'running' : 'stopped'),
    pid: status?.pid ?? defaultPid,
    error: status?.error,
    updatedAt: status?.updatedAt,
  };
}

function getForwardStatus(hostId: string, serviceId: string): { state: ForwardState; error?: string } {
  return runtimeForwardStatus.get(serviceKey(hostId, serviceId)) ?? { state: 'none' };
}

function toView(hosts: HostConfig[]): HostView[] {
  return hosts.map((host) => ({
    ...host,
    forwards: host.forwards.map((forward) => {
      const status = tunnelManager.getStatus(forward.id);
      return {
        ...forward,
        status: status.status,
        error: status.error,
        reconnectAt: status.reconnectAt,
      };
    }),
    services: host.services.map((service) => {
      const status = getStatus(host.id, service.id, service.pid);
      const forward = getForwardStatus(host.id, service.id);
      return {
        ...service,
        status: status.status,
        pid: status.pid,
        error: status.error,
        updatedAt: status.updatedAt,
        forwardState: service.forwardLocalPort ? forward.state : 'none',
        forwardError: service.forwardLocalPort ? forward.error : undefined,
      };
    }),
  }));
}

function validateForwardDraft(input: ForwardRuleDraft): ForwardRule {
  const forward: ForwardRule = {
    id: input.id?.trim() || randomUUID(),
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

function validateServiceDraft(input: ServiceDraft): ServiceConfig {
  const service: ServiceConfig = {
    id: input.id?.trim() || randomUUID(),
    name: input.name.trim(),
    startCommand: input.startCommand.trim(),
    port: Number(input.port),
    forwardLocalPort: input.forwardLocalPort ? Number(input.forwardLocalPort) : undefined,
    pid: undefined,
    stdoutPath: undefined,
    stderrPath: undefined,
  };

  if (!service.name) throw new Error('Service name is required.');
  if (!service.startCommand) throw new Error('Service start command is required.');
  if (!Number.isInteger(service.port) || service.port < 1 || service.port > 65535) {
    throw new Error('Service port must be an integer in range 1-65535.');
  }
  if (
    service.forwardLocalPort !== undefined &&
    (!Number.isInteger(service.forwardLocalPort) || service.forwardLocalPort < 1 || service.forwardLocalPort > 65535)
  ) {
    throw new Error('Forward local port must be an integer in range 1-65535.');
  }

  return service;
}

function validateSshEndpoint(
  input: SshEndpointDraft,
  scope: 'target' | 'jump',
  options?: { allowMissingPrivateKey?: boolean }
): JumpHostConfig {
  const label = scope === 'target' ? 'Target' : 'Jump host';
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

function validateHostDraft(input: HostDraft): HostConfig {
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
    jumpHost: input.jumpHost ? validateSshEndpoint(input.jumpHost, 'jump') : undefined,
    forwards: (input.forwards ?? []).map((forward) => validateForwardDraft(forward)),
    services: (input.services ?? []).map((service) => validateServiceDraft(service)),
  };

  if (!host.name) throw new Error('Host name is required.');
  if (host.authType === 'privateKey' && !host.privateKey?.trim() && !host.privateKeyPath) {
    throw new Error('Target private key is required when auth type is private key.');
  }

  return host;
}

function emitStatus(hostId: string, serviceId: string, status: ServiceStatus, pid?: number, error?: string): void {
  const forward = getForwardStatus(hostId, serviceId);
  const payload = {
    hostId,
    serviceId,
    status,
    pid,
    error,
    updatedAt: new Date().toISOString(),
    forwardState: forward.state,
    forwardError: forward.error,
  };
  runtimeStatus.set(serviceKey(hostId, serviceId), payload);

  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IPC_CHANNELS.serviceStatusChanged, payload);
  }
}

function emitForwardStatus(hostId: string, serviceId: string, state: ForwardState, error?: string): void {
  runtimeForwardStatus.set(serviceKey(hostId, serviceId), { state, error });
  const current = runtimeStatus.get(serviceKey(hostId, serviceId));
  emitStatus(hostId, serviceId, current?.status ?? 'unknown', current?.pid, current?.error);
}

function logRuntimeError(scope: string, error: unknown, context?: Record<string, unknown>): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[${scope}] ${message}`, context ?? {});
  if (error instanceof Error && error.stack) {
    console.error(error.stack);
  }
}

function syncKnownForwards(hosts: HostConfig[]): void {
  const next = new Map<string, string>();
  for (const host of hosts) {
    for (const forward of host.forwards) {
      tunnelManager.setKnownTunnel(forward.id);
      next.set(forward.id, host.id);
    }
  }

  for (const [forwardId] of forwardOwners) {
    if (!next.has(forwardId)) {
      forwardOwners.delete(forwardId);
    }
  }

  for (const [forwardId, hostId] of next) {
    forwardOwners.set(forwardId, hostId);
  }
}

async function resolveHostPrivateKey(host: HostConfig): Promise<string | undefined> {
  if (host.privateKey?.trim()) return host.privateKey;
  if (!host.privateKeyPath) return undefined;
  return fs.readFile(host.privateKeyPath, 'utf8');
}

async function toRuntimeConfig(host: HostConfig, forward: ForwardRule): Promise<ForwardRuntimeConfig> {
  const jumpHost = host.jumpHost
    ? {
        ...host.jumpHost,
        privateKey: host.jumpHost.authType === 'privateKey' ? host.jumpHost.privateKey : undefined,
      }
    : undefined;

  return {
    id: forward.id,
    sshHost: host.sshHost,
    sshPort: host.sshPort,
    username: host.username,
    authType: host.authType,
    password: host.password,
    privateKey: await resolveHostPrivateKey(host),
    passphrase: host.passphrase,
    jumpHost,
    localHost: forward.localHost,
    localPort: forward.localPort,
    remoteHost: forward.remoteHost,
    remotePort: forward.remotePort,
  };
}

async function stopAllHostRules(host: HostConfig): Promise<void> {
  await Promise.all(host.forwards.map((forward) => tunnelManager.stop(forward.id)));
}

async function clearRemovedRules(previous: HostConfig, next: HostConfig): Promise<void> {
  const nextIds = new Set(next.forwards.map((item) => item.id));
  const removed = previous.forwards.filter((item) => !nextIds.has(item.id));
  for (const forward of removed) {
    await tunnelManager.stop(forward.id);
    tunnelManager.clearTunnel(forward.id);
    forwardOwners.delete(forward.id);
  }
}

async function autoStartHostRules(host: HostConfig): Promise<void> {
  for (const forward of host.forwards) {
    if (!forward.autoStart) continue;
    try {
      const config = await toRuntimeConfig(host, forward);
      void tunnelManager.start(config).catch(() => undefined);
    } catch (error) {
      logRuntimeError('forward:auto-start', error, { hostId: host.id, forwardId: forward.id });
    }
  }
}

function countRules(hosts: HostConfig[]): number {
  return hosts.reduce((total, host) => total + host.forwards.length, 0);
}

function countServices(hosts: HostConfig[]): number {
  return hosts.reduce((total, host) => total + host.services.length, 0);
}

function parseImportedHostDrafts(data: unknown): HostDraft[] {
  if (Array.isArray(data)) {
    return data as HostDraft[];
  }
  if (data && typeof data === 'object') {
    const hosts = (data as { hosts?: unknown }).hosts;
    if (Array.isArray(hosts)) {
      return hosts as HostDraft[];
    }
  }
  throw new Error('Invalid config file format. Expected an array of hosts or an object with "hosts".');
}

function ensureUniqueImportedIds(hosts: HostConfig[]): HostConfig[] {
  const hostIds = new Set<string>();
  const forwardIds = new Set<string>();
  const serviceIdsByHost = new Map<string, Set<string>>();

  return hosts.map((host) => {
    const nextHostId = host.id && !hostIds.has(host.id) ? host.id : randomUUID();
    hostIds.add(nextHostId);

    const forwards = host.forwards.map((forward) => {
      const nextForwardId = forward.id && !forwardIds.has(forward.id) ? forward.id : randomUUID();
      forwardIds.add(nextForwardId);
      return { ...forward, id: nextForwardId };
    });

    const serviceIds = serviceIdsByHost.get(nextHostId) ?? new Set<string>();
    serviceIdsByHost.set(nextHostId, serviceIds);
    const services = host.services.map((service) => {
      const nextServiceId = service.id && !serviceIds.has(service.id) ? service.id : randomUUID();
      serviceIds.add(nextServiceId);
      return { ...service, id: nextServiceId };
    });

    return {
      ...host,
      id: nextHostId,
      forwards,
      services,
    };
  });
}

function registerIpcHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.listHosts, async () => {
    const hosts = getStore().listHosts();
    syncKnownForwards(hosts);
    return toView(hosts);
  });

  ipcMain.handle(IPC_CHANNELS.exportConfig, async (): Promise<ConfigTransferResult | null> => {
    const hosts = getStore().listHosts();
    const suggestedName = `service-manager-config-${new Date().toISOString().slice(0, 10)}.json`;
    const result = await dialog.showSaveDialog({
      title: 'Export Service Manager Config',
      defaultPath: path.join(app.getPath('documents'), suggestedName),
      filters: [{ name: 'JSON Files', extensions: ['json'] }],
    });

    if (result.canceled || !result.filePath) {
      return null;
    }

    const payload: ExportedConfigFile = {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      app: 'service-manager',
      hosts,
    };
    await fs.writeFile(result.filePath, JSON.stringify(payload, null, 2), 'utf8');
    return {
      path: result.filePath,
      hostCount: hosts.length,
      ruleCount: countRules(hosts),
      serviceCount: countServices(hosts),
    };
  });

  ipcMain.handle(IPC_CHANNELS.importConfig, async (): Promise<ConfigTransferResult | null> => {
    const result = await dialog.showOpenDialog({
      title: 'Import Service Manager Config',
      defaultPath: app.getPath('documents'),
      properties: ['openFile'],
      filters: [
        { name: 'JSON Files', extensions: ['json'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    const selectedPath = result.filePaths[0];
    const raw = await fs.readFile(selectedPath, 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('Invalid JSON file.');
    }

    const importedDrafts = parseImportedHostDrafts(parsed);
    const validatedHosts = ensureUniqueImportedIds(
      importedDrafts.map((draft, index) => {
        try {
          return validateHostDraft(draft);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`Host ${index + 1}: ${message}`);
        }
      })
    );

    const existingHosts = getStore().listHosts();
    await portForwardManager.stopAll();
    await tunnelManager.stopAll();
    for (const host of existingHosts) {
      for (const forward of host.forwards) {
        tunnelManager.clearTunnel(forward.id);
        forwardOwners.delete(forward.id);
      }
      for (const service of host.services) {
        emitForwardStatus(host.id, service.id, 'none');
      }
    }

    await getStore().replaceHosts(validatedHosts);
    syncKnownForwards(validatedHosts);
    for (const host of validatedHosts) {
      await autoStartHostRules(host);
    }

    return {
      path: selectedPath,
      hostCount: validatedHosts.length,
      ruleCount: countRules(validatedHosts),
      serviceCount: countServices(validatedHosts),
    };
  });

  ipcMain.handle(IPC_CHANNELS.saveHost, async (_event, hostDraft: HostDraft) => {
    const previous = hostDraft.id ? getStore().findHostById(hostDraft.id) : undefined;
    if (previous) {
      await portForwardManager.stopMany(previous.services.map((service) => serviceForwardKey(previous.id, service.id)));
      await stopAllHostRules(previous);
      for (const service of previous.services) {
        emitForwardStatus(previous.id, service.id, 'none');
      }
    }

    const host = validateHostDraft(hostDraft);

    if (previous) {
      await clearRemovedRules(previous, host);
    }

    for (const forward of host.forwards) {
      tunnelManager.setKnownTunnel(forward.id);
      forwardOwners.set(forward.id, host.id);
    }

    await getStore().upsertHost(host);
    await autoStartHostRules(host);

    for (const service of host.services) {
      if (!service.pid || !service.forwardLocalPort) {
        emitForwardStatus(host.id, service.id, 'none');
        continue;
      }
      const status = await checkServiceStatus(host, service);
      if (status.status === 'running') {
        if (status.pid) {
          service.pid = status.pid;
        }
        try {
          await portForwardManager.start(serviceForwardKey(host.id, service.id), host, service);
          emitForwardStatus(host.id, service.id, 'ok');
        } catch (error) {
          logRuntimeError('port-forward:start', error, {
            hostId: host.id,
            serviceId: service.id,
            localPort: service.forwardLocalPort,
            remotePort: service.port,
          });
          emitForwardStatus(host.id, service.id, 'error', error instanceof Error ? error.message : String(error));
        }
      } else {
        emitForwardStatus(host.id, service.id, 'none');
      }
    }

    await getStore().upsertHost(host);
    return toView([host])[0];
  });

  ipcMain.handle(IPC_CHANNELS.deleteHost, async (_event, hostId: string) => {
    const host = getStore().findHostById(hostId);
    if (!host) return;

    await portForwardManager.stopMany(host.services.map((service) => serviceForwardKey(host.id, service.id)));
    await stopAllHostRules(host);
    for (const forward of host.forwards) {
      tunnelManager.clearTunnel(forward.id);
      forwardOwners.delete(forward.id);
    }
    for (const service of host.services) {
      emitForwardStatus(host.id, service.id, 'none');
    }

    await getStore().removeHost(hostId);
  });

  ipcMain.handle(IPC_CHANNELS.deleteService, async (_event, payload: { hostId: string; serviceId: string }) => {
    await portForwardManager.stop(serviceForwardKey(payload.hostId, payload.serviceId));
    emitForwardStatus(payload.hostId, payload.serviceId, 'none');
    await getStore().removeService(payload.hostId, payload.serviceId);
  });

  ipcMain.handle(IPC_CHANNELS.deleteForward, async (_event, payload: { hostId: string; forwardId: string }) => {
    await tunnelManager.stop(payload.forwardId);
    tunnelManager.clearTunnel(payload.forwardId);
    forwardOwners.delete(payload.forwardId);
    await getStore().removeForward(payload.hostId, payload.forwardId);
  });

  ipcMain.handle(IPC_CHANNELS.startForward, async (_event, payload: { hostId: string; forwardId: string }) => {
    const host = getStore().findHostById(payload.hostId);
    if (!host) throw new Error('Host not found.');
    const forward = host.forwards.find((item) => item.id === payload.forwardId);
    if (!forward) throw new Error('Forward rule not found.');

    const config = await toRuntimeConfig(host, forward);
    await tunnelManager.start(config);
  });

  ipcMain.handle(IPC_CHANNELS.stopForward, async (_event, payload: { hostId: string; forwardId: string }) => {
    const host = getStore().findHostById(payload.hostId);
    if (!host) throw new Error('Host not found.');
    const forward = host.forwards.find((item) => item.id === payload.forwardId);
    if (!forward) throw new Error('Forward rule not found.');

    await tunnelManager.stop(forward.id);
  });

  ipcMain.handle(IPC_CHANNELS.refreshService, async (_event, payload: { hostId: string; serviceId: string }) => {
    try {
      const host = getStore().findHostById(payload.hostId);
      if (!host) throw new Error('Host not found.');
      const service = host.services.find((item) => item.id === payload.serviceId);
      if (!service) throw new Error('Service not found.');
      const currentState = runtimeStatus.get(serviceKey(host.id, service.id));

      const result = await checkServiceStatus(host, service);
      if (currentState?.status === 'starting' && result.status === 'stopped') {
        emitStatus(host.id, service.id, 'starting', service.pid);
        return;
      }
      if (result.status === 'running' && result.pid && result.pid !== service.pid) {
        service.pid = result.pid;
        await getStore().upsertHost(host);
      }
      if (result.status === 'running' && service.forwardLocalPort) {
        try {
          await portForwardManager.start(serviceForwardKey(host.id, service.id), host, service);
          emitForwardStatus(host.id, service.id, 'ok');
        } catch (error) {
          logRuntimeError('port-forward:start', error, {
            hostId: host.id,
            serviceId: service.id,
            localPort: service.forwardLocalPort,
            remotePort: service.port,
          });
          emitForwardStatus(host.id, service.id, 'error', error instanceof Error ? error.message : String(error));
        }
      } else if (!service.forwardLocalPort) {
        emitForwardStatus(host.id, service.id, 'none');
      }
      if (result.status === 'stopped' && service.pid) {
        await portForwardManager.stop(serviceForwardKey(host.id, service.id));
        emitForwardStatus(host.id, service.id, 'none');
        service.pid = undefined;
        await getStore().upsertHost(host);
      }
      emitStatus(host.id, service.id, result.status, result.pid, result.error);
    } catch (error) {
      logRuntimeError('service:refresh', error, payload);
      throw error;
    }
  });

  ipcMain.handle(
    IPC_CHANNELS.startService,
    async (_event, payload: { hostId: string; serviceId: string }) => {
      try {
        const host = getStore().findHostById(payload.hostId);
        if (!host) throw new Error('Host not found.');
        const service = host.services.find((item) => item.id === payload.serviceId);
        if (!service) throw new Error('Service not found.');

        emitStatus(host.id, service.id, 'starting');
        const ret = await startService(host, service);
        if (!ret.ok) {
          logRuntimeError('service:start', ret.error ?? 'unknown start failure', payload);
          emitStatus(host.id, service.id, 'error', undefined, ret.error);
          return;
        }

        service.pid = ret.pid;
        service.stdoutPath = ret.stdoutPath;
        service.stderrPath = ret.stderrPath;
        await getStore().upsertHost(host);

        const status = await checkServiceStatus(host, service);
        if (status.pid && status.pid !== service.pid) {
          service.pid = status.pid;
          await getStore().upsertHost(host);
        }
        if (status.status === 'running' && service.forwardLocalPort) {
          try {
            await portForwardManager.start(serviceForwardKey(host.id, service.id), host, service);
            emitForwardStatus(host.id, service.id, 'ok');
          } catch (error) {
            logRuntimeError('port-forward:start', error, {
              hostId: host.id,
              serviceId: service.id,
              localPort: service.forwardLocalPort,
              remotePort: service.port,
            });
            emitForwardStatus(host.id, service.id, 'error', error instanceof Error ? error.message : String(error));
          }
        } else if (!service.forwardLocalPort) {
          emitForwardStatus(host.id, service.id, 'none');
        }
        emitStatus(host.id, service.id, status.status, service.pid, status.error);
      } catch (error) {
        logRuntimeError('service:start', error, payload);
        throw error;
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.stopService,
    async (_event, payload: { hostId: string; serviceId: string }) => {
      try {
        const host = getStore().findHostById(payload.hostId);
        if (!host) throw new Error('Host not found.');
        const service = host.services.find((item) => item.id === payload.serviceId);
        if (!service) throw new Error('Service not found.');

        emitStatus(host.id, service.id, 'stopping', service.pid);
        const ret = await stopService(host, service);
        if (!ret.ok) {
          logRuntimeError('service:stop', ret.error ?? 'unknown stop failure', payload);
          emitStatus(host.id, service.id, 'error', service.pid, ret.error);
          return;
        }

        await portForwardManager.stop(serviceForwardKey(host.id, service.id));
        emitForwardStatus(host.id, service.id, 'none');
        service.pid = undefined;
        await getStore().upsertHost(host);
        emitStatus(host.id, service.id, 'stopped', undefined);
      } catch (error) {
        logRuntimeError('service:stop', error, payload);
        throw error;
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.getServiceLogs,
    async (_event, payload: { hostId: string; serviceId: string }): Promise<ServiceLogsResult> => {
      try {
        const host = getStore().findHostById(payload.hostId);
        if (!host) throw new Error('Host not found.');
        const service = host.services.find((item) => item.id === payload.serviceId);
        if (!service) throw new Error('Service not found.');
        return getServiceLogs(host, service);
      } catch (error) {
        logRuntimeError('service:logs', error, payload);
        throw error;
      }
    }
  );

  ipcMain.handle(IPC_CHANNELS.importPrivateKey, async (): Promise<PrivateKeyImportResult | null> => {
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const sshDefaultDir = path.join(app.getPath('home'), '.ssh');
    let dialogDefaultPath = sshDefaultDir;
    try {
      await fs.access(sshDefaultDir);
    } catch {
      dialogDefaultPath = app.getPath('home');
    }

    const result = await dialog.showOpenDialog(window, {
      title: 'Import Private Key',
      defaultPath: dialogDefaultPath,
      properties: ['openFile'],
      filters: [{ name: 'All Files', extensions: ['*'] }],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    const filePath = result.filePaths[0];
    const content = await fs.readFile(filePath, 'utf8');
    return { path: filePath, content };
  });

  ipcMain.handle(IPC_CHANNELS.openExternal, async (_event, rawUrl: string) => {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new Error('Invalid URL.');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Only http/https URLs are allowed.');
    }
    await shell.openExternal(parsed.toString());
  });
}

function wireForwardStatusBroadcast(): void {
  tunnelManager.on('status-changed', (change: TunnelStatusChange) => {
    const hostId = forwardOwners.get(change.forwardId) ?? change.hostId;
    const payload: TunnelStatusChange = {
      hostId,
      forwardId: change.forwardId,
      status: change.status,
      error: change.error,
      reconnectAt: change.reconnectAt,
    };
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC_CHANNELS.forwardStatusChanged, payload);
    }
  });
}

app.whenReady().then(async () => {
  const filePath = path.join(app.getPath('userData'), 'service-manager.json');
  store = new ServiceStore(filePath);
  await store.load();
  const hosts = store.listHosts();
  syncKnownForwards(hosts);

  registerIpcHandlers();
  wireForwardStatusBroadcast();
  for (const host of hosts) {
    await autoStartHostRules(host);
  }
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    void Promise.all([portForwardManager.stopAll(), tunnelManager.stopAll()]).finally(() => app.quit());
  }
});

app.on('before-quit', () => {
  void Promise.all([portForwardManager.stopAll(), tunnelManager.stopAll()]);
});
