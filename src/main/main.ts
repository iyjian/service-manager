import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type {
  HostConfig,
  HostDraft,
  HostView,
  PrivateKeyImportResult,
  ServiceLogsResult,
  ServiceConfig,
  ServiceDraft,
  ServiceStatus,
} from '../shared/types';
import { ServiceStore } from './store';
import { checkServiceStatus, getServiceLogs, startService, stopService } from './serviceRuntime';
import { PortForwardManager } from './portForwardManager';

const IPC_CHANNELS = {
  listHosts: 'host:list',
  saveHost: 'host:save',
  deleteHost: 'host:delete',
  deleteService: 'service:delete',
  startService: 'service:start',
  stopService: 'service:stop',
  refreshService: 'service:refresh',
  getServiceLogs: 'service:logs',
  statusChanged: 'service:status',
  importPrivateKey: 'auth:import-private-key',
} as const;

const runtimeStatus = new Map<string, { status: ServiceStatus; pid?: number; error?: string; updatedAt?: string }>();
let store: ServiceStore | null = null;
const portForwardManager = new PortForwardManager();

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

function toView(hosts: HostConfig[]): HostView[] {
  return hosts.map((host) => ({
    ...host,
    services: host.services.map((service) => {
      const status = getStatus(host.id, service.id, service.pid);
      return {
        ...service,
        status: status.status,
        pid: status.pid,
        error: status.error,
        updatedAt: status.updatedAt,
      };
    }),
  }));
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

function validateHostDraft(input: HostDraft): HostConfig {
  const host: HostConfig = {
    id: input.id?.trim() || randomUUID(),
    name: input.name.trim(),
    sshHost: input.sshHost.trim(),
    sshPort: Number(input.sshPort),
    username: input.username.trim(),
    authType: input.authType,
    password: input.password?.trim() || undefined,
    privateKey: input.privateKey || undefined,
    passphrase: input.passphrase?.trim() || undefined,
    privateKeyPath: input.privateKeyPath?.trim() || undefined,
    services: (input.services ?? []).map((service) => validateServiceDraft(service)),
  };

  if (!host.name) throw new Error('Host name is required.');
  if (!host.sshHost) throw new Error('SSH host is required.');
  if (!host.username) throw new Error('SSH username is required.');
  if (!Number.isInteger(host.sshPort) || host.sshPort < 1 || host.sshPort > 65535) {
    throw new Error('SSH port must be an integer in range 1-65535.');
  }
  if (host.authType === 'password' && !host.password) {
    throw new Error('Password is required when auth type is password.');
  }
  if (host.authType === 'privateKey' && !host.privateKey?.trim() && !host.privateKeyPath) {
    throw new Error('Private key is required when auth type is private key.');
  }
  if (host.authType === 'password') {
    host.privateKey = undefined;
    host.privateKeyPath = undefined;
    host.passphrase = undefined;
  } else {
    host.password = undefined;
  }

  return host;
}

function emitStatus(hostId: string, serviceId: string, status: ServiceStatus, pid?: number, error?: string): void {
  const payload = {
    hostId,
    serviceId,
    status,
    pid,
    error,
    updatedAt: new Date().toISOString(),
  };
  runtimeStatus.set(serviceKey(hostId, serviceId), payload);

  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IPC_CHANNELS.statusChanged, payload);
  }
}

function logRuntimeError(scope: string, error: unknown, context?: Record<string, unknown>): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[${scope}] ${message}`, context ?? {});
  if (error instanceof Error && error.stack) {
    console.error(error.stack);
  }
}

function registerIpcHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.listHosts, async () => {
    return toView(getStore().listHosts());
  });

  ipcMain.handle(IPC_CHANNELS.saveHost, async (_event, hostDraft: HostDraft) => {
    const previous = hostDraft.id ? getStore().findHostById(hostDraft.id) : undefined;
    if (previous) {
      await portForwardManager.stopMany(previous.services.map((service) => serviceForwardKey(previous.id, service.id)));
    }

    const host = validateHostDraft(hostDraft);
    await getStore().upsertHost(host);

    for (const service of host.services) {
      if (!service.pid || !service.forwardLocalPort) {
        continue;
      }
      const status = await checkServiceStatus(host, service);
      if (status.status === 'running') {
        if (status.pid) {
          service.pid = status.pid;
        }
        try {
          await portForwardManager.start(serviceForwardKey(host.id, service.id), host, service);
        } catch (error) {
          logRuntimeError('port-forward:start', error, {
            hostId: host.id,
            serviceId: service.id,
            localPort: service.forwardLocalPort,
            remotePort: service.port,
          });
        }
      }
    }
    await getStore().upsertHost(host);
    return toView([host])[0];
  });

  ipcMain.handle(IPC_CHANNELS.deleteHost, async (_event, hostId: string) => {
    const host = getStore().findHostById(hostId);
    if (host) {
      await portForwardManager.stopMany(host.services.map((service) => serviceForwardKey(host.id, service.id)));
    }
    await getStore().removeHost(hostId);
  });

  ipcMain.handle(IPC_CHANNELS.deleteService, async (_event, payload: { hostId: string; serviceId: string }) => {
    await portForwardManager.stop(serviceForwardKey(payload.hostId, payload.serviceId));
    await getStore().removeService(payload.hostId, payload.serviceId);
  });

  ipcMain.handle(IPC_CHANNELS.refreshService, async (_event, payload: { hostId: string; serviceId: string }) => {
    try {
      const host = getStore().findHostById(payload.hostId);
      if (!host) throw new Error('Host not found.');
      const service = host.services.find((item) => item.id === payload.serviceId);
      if (!service) throw new Error('Service not found.');

      const result = await checkServiceStatus(host, service);
      if (result.status === 'running' && result.pid && result.pid !== service.pid) {
        service.pid = result.pid;
        await getStore().upsertHost(host);
      }
      if (result.status === 'running' && service.forwardLocalPort) {
        try {
          await portForwardManager.start(serviceForwardKey(host.id, service.id), host, service);
        } catch (error) {
          logRuntimeError('port-forward:start', error, {
            hostId: host.id,
            serviceId: service.id,
            localPort: service.forwardLocalPort,
            remotePort: service.port,
          });
        }
      }
      if (result.status === 'stopped' && service.pid) {
        await portForwardManager.stop(serviceForwardKey(host.id, service.id));
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
          } catch (error) {
            logRuntimeError('port-forward:start', error, {
              hostId: host.id,
              serviceId: service.id,
              localPort: service.forwardLocalPort,
              remotePort: service.port,
            });
          }
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
      filters: [
        { name: 'All Files', extensions: ['*'] },
      ],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    const filePath = result.filePaths[0];
    const content = await fs.readFile(filePath, 'utf8');
    return { path: filePath, content };
  });
}

app.whenReady().then(async () => {
  const filePath = path.join(app.getPath('userData'), 'service-manager.json');
  store = new ServiceStore(filePath);
  await store.load();

  registerIpcHandlers();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    void portForwardManager.stopAll();
    app.quit();
  }
});

app.on('before-quit', () => {
  void portForwardManager.stopAll();
});
