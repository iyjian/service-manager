import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, shell } from 'electron';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import type {
  ConfigTransferResult,
  ConfirmDialogOptions,
  ForwardState,
  HostConfig,
  HostDraft,
  PrivateKeyImportResult,
  ServiceRefreshOptions,
  ServiceLogsResult,
  ServiceStatus,
  TunnelStatusChange,
  UpdateState,
} from '../shared/types';
import { ServiceStore } from './store';
import { checkServiceStatus, getServiceLogs, setServiceRuntimeDiagnostics, startService, stopService } from './serviceRuntime';
import { RuntimeLogWriter } from './runtimeLog';
import { PortForwardManager } from './portForwardManager';
import { TunnelManager } from './tunnelManager';
import { AppUpdater } from './updater';
import { forwardToRuntimeConfig } from './hostConnection';
import { KeyedOperationQueue } from './operationQueue';
import {
  countRules,
  countServices,
  ensureUniqueImportedIds,
  type ExportedConfigFile,
  parseImportedHostDrafts,
} from './configTransfer';
import { RuntimeRegistry } from './runtimeRegistry';
import { preserveServiceRuntimeFields, validateHostDraft } from './validation';
import { ProxyRuntime } from './proxy/proxyRuntime';
import { scheduleProxyAutoStart } from './proxy/proxyAutoStart';
import { collectAppMemoryUsage } from './appMemory';
import type { ProxyExceptionDraft, ProxyMode, ProxyState } from '../shared/types';

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
  readClipboardText: 'clipboard:read-text',
  writeClipboardText: 'clipboard:write-text',
  confirmAction: 'dialog:confirm',
  getUpdateState: 'updater:get-state',
  checkUpdates: 'updater:check',
  updateState: 'updater:state',
  appMemoryUsage: 'app:memory-usage',
  proxyGetState: 'proxy:get-state',
  proxyDownloadCore: 'proxy:download-core',
  proxyStart: 'proxy:start',
  proxyStop: 'proxy:stop',
  proxySaveAndFetchSubscription: 'proxy:save-and-fetch-subscription',
  proxySetMode: 'proxy:set-mode',
  proxySetSystemProxy: 'proxy:set-system-proxy',
  proxySetTun: 'proxy:set-tun',
  proxyAddException: 'proxy:add-exception',
  proxyUpdateException: 'proxy:update-exception',
  proxyDeleteException: 'proxy:delete-exception',
  proxyGrantTun: 'proxy:grant-tun',
  proxyRevokeTun: 'proxy:revoke-tun',
  proxyListProxies: 'proxy:list-proxies',
  proxySelectProxy: 'proxy:select-proxy',
  proxyGetLogs: 'proxy:get-logs',
  proxyStateChanged: 'proxy:state',
} as const;

const forwardOwners = new Map<string, string>();
let store: ServiceStore | null = null;
let proxyRuntime: ProxyRuntime | null = null;
let runtimeLogWriter: RuntimeLogWriter | null = null;
let allowQuitAfterRuntimeShutdown = false;
let quitShutdownPromise: Promise<void> | null = null;
const runtimeRegistry = new RuntimeRegistry();
const serviceOperationQueue = new KeyedOperationQueue();
const portForwardManager = new PortForwardManager();
const tunnelManager = new TunnelManager();
const updater = new AppUpdater(() => BrowserWindow.getAllWindows()[0] ?? null);
const APP_DISPLAY_NAME = 'Service Manager';
const APP_ICON_PATH = path.join(__dirname, '..', '..', 'assets', 'icon.png');

app.setName(APP_DISPLAY_NAME);
app.setAboutPanelOptions({
  applicationName: APP_DISPLAY_NAME,
});

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

function validateProxyExceptionDraft(value: unknown): ProxyExceptionDraft {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('A custom rule type and value are required.');
  }

  const draft = value as { type?: unknown; value?: unknown; target?: unknown };
  if (typeof draft.type !== 'string' || typeof draft.value !== 'string') {
    throw new Error('A custom rule type and value are required.');
  }
  if (draft.target !== undefined && typeof draft.target !== 'string') {
    throw new Error('A custom rule target must be a string.');
  }

  return {
    type: draft.type as ProxyExceptionDraft['type'],
    value: draft.value,
    ...(typeof draft.target === 'string' ? { target: draft.target as ProxyExceptionDraft['target'] } : {}),
  };
}

function validateProxyExceptionId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('A custom rule ID is required.');
  }
  return value;
}

function validateProxyMixedPort(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error('Mixed port must be an integer between 1 and 65535.');
  }
  return value;
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1230,
    height: 820,
    minWidth: 900,
    minHeight: 620,
    icon: APP_ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  window.on('unresponsive', () => {
    logRuntimeError('window:unresponsive', new Error('Renderer became unresponsive.'));
  });

  void window.loadFile(path.join(__dirname, '..', 'renderer', 'index.html')).catch((error) => {
    logRuntimeError('window:load-file', error);
  });
  return window;
}

function getAppIconImage(): Electron.NativeImage | null {
  const icon = nativeImage.createFromPath(APP_ICON_PATH);
  return icon.isEmpty() ? null : icon;
}

function applyAppIcon(): void {
  if (process.platform !== 'darwin') {
    return;
  }

  const icon = getAppIconImage();
  if (icon) {
    app.dock.setIcon(icon);
  }
}

function applyAppMenu(): void {
  if (process.platform !== 'darwin') {
    return;
  }

  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: APP_DISPLAY_NAME,
      submenu: [
        { role: 'about' },
        {
          label: 'Check for Updates...',
          click: () => {
            void updater.checkForUpdates('manual');
          },
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [{ role: 'close' }],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'delete' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }],
    },
    {
      label: 'Help',
      submenu: [],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function toView(hosts: HostConfig[]) {
  return runtimeRegistry.toView(hosts, (forwardId) => tunnelManager.getStatus(forwardId));
}

function emitStatus(
  hostId: string,
  serviceId: string,
  status: ServiceStatus,
  pid?: number,
  error?: string,
  silent = false
): void {
  const payload = runtimeRegistry.setServiceStatus(hostId, serviceId, status, pid, error);
  broadcast(IPC_CHANNELS.serviceStatusChanged, silent ? { ...payload, silent: true } : payload);
}

function emitForwardStatus(hostId: string, serviceId: string, state: ForwardState, error?: string, silent = false): void {
  const current = runtimeRegistry.setServiceForwardStatus(hostId, serviceId, state, error);
  emitStatus(hostId, serviceId, current.status, current.pid, current.error, silent);
}

function logRuntimeError(scope: string, error: unknown, context?: Record<string, unknown>): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[${scope}] ${message}`, context ?? {});
  if (error instanceof Error && error.stack) {
    console.error(error.stack);
  }

  try {
    void runtimeLogWriter?.record(scope, error, context).catch(() => undefined);
  } catch {
    // Runtime logging is best effort and must not disrupt the app lifecycle.
  }
}

async function flushRuntimeLog(): Promise<void> {
  try {
    await runtimeLogWriter?.flush();
  } catch (error) {
    console.error('[runtime-log:flush]', error);
  }
}

async function shutdownRuntimesForQuit(): Promise<void> {
  try {
    updater.stop();
  } catch (error) {
    logRuntimeError('app:shutdown', error, { operation: 'updater-stop' });
  }

  const shutdownResults = await Promise.allSettled([
    Promise.resolve().then(() => portForwardManager.stopAll()),
    Promise.resolve().then(() => tunnelManager.stopAll()),
    Promise.resolve().then(() => proxyRuntime?.shutdown()),
  ]);
  for (const result of shutdownResults) {
    if (result.status === 'rejected') {
      logRuntimeError('app:shutdown', result.reason, { operation: 'runtime-stop' });
    }
  }

  await flushRuntimeLog();
}

function requestQuitAfterRuntimeShutdown(): void {
  if (allowQuitAfterRuntimeShutdown || quitShutdownPromise) {
    return;
  }

  quitShutdownPromise = shutdownRuntimesForQuit().catch(async (error) => {
    logRuntimeError('app:shutdown', error, { operation: 'runtime-stop' });
    await flushRuntimeLog();
  });
  void quitShutdownPromise.then(() => {
    allowQuitAfterRuntimeShutdown = true;
    app.quit();
  });
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) {
      continue;
    }

    try {
      win.webContents.send(channel, payload);
    } catch (error) {
      logRuntimeError('ipc:broadcast', error, { channel });
    }
  }
}

function registerProcessErrorHandlers(): void {
  process.on('uncaughtException', (error) => {
    logRuntimeError('process:uncaughtException', error);
  });

  process.on('unhandledRejection', (reason) => {
    logRuntimeError('process:unhandledRejection', reason);
  });

  app.on('render-process-gone', (_event, _webContents, details) => {
    logRuntimeError('app:render-process-gone', new Error(`Renderer process exited: ${details.reason}`), {
      reason: details.reason,
      exitCode: details.exitCode,
    });
  });

  app.on('child-process-gone', (_event, details) => {
    logRuntimeError('app:child-process-gone', new Error(`Child process exited: ${details.type}`), {
      type: details.type,
      reason: details.reason,
      exitCode: details.exitCode,
      name: details.name,
    });
  });
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
      const config = await forwardToRuntimeConfig(host, forward);
      void tunnelManager.start(config).catch(() => undefined);
    } catch (error) {
      logRuntimeError('forward:auto-start', error, { hostId: host.id, forwardId: forward.id });
    }
  }
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

    const validated = validateHostDraft(hostDraft);
    const host = preserveServiceRuntimeFields(previous, validated);

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
      if (!service.pid || !service.forwardLocalPort || service.port === 0) {
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
    await serviceOperationQueue.run(serviceKey(payload.hostId, payload.serviceId), async () => {
      await portForwardManager.stop(serviceForwardKey(payload.hostId, payload.serviceId));
      emitForwardStatus(payload.hostId, payload.serviceId, 'none');
      await getStore().removeService(payload.hostId, payload.serviceId);
    });
  });

  ipcMain.handle(IPC_CHANNELS.deleteForward, async (_event, payload: { hostId: string; forwardId: string }) => {
    await tunnelManager.stop(payload.forwardId);
    tunnelManager.clearTunnel(payload.forwardId);
    forwardOwners.delete(payload.forwardId);
    await getStore().removeForward(payload.hostId, payload.forwardId);
  });

  ipcMain.handle(IPC_CHANNELS.confirmAction, async (event, options: ConfirmDialogOptions) => {
    const parentWindow = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const icon = getAppIconImage();
    const messageBoxOptions = {
      type: options.kind ?? 'question',
      title: options.title,
      message: options.message,
      detail: options.detail,
      buttons: [options.cancelLabel ?? 'Cancel', options.confirmLabel ?? 'Confirm'],
      defaultId: 1,
      cancelId: 0,
      noLink: true,
      ...(icon ? { icon } : {}),
    };
    const result = parentWindow
      ? await dialog.showMessageBox(parentWindow, messageBoxOptions)
      : await dialog.showMessageBox(messageBoxOptions);

    return result.response === 1;
  });

  ipcMain.handle(IPC_CHANNELS.startForward, async (_event, payload: { hostId: string; forwardId: string }) => {
    const host = getStore().findHostById(payload.hostId);
    if (!host) throw new Error('Host not found.');
    const forward = host.forwards.find((item) => item.id === payload.forwardId);
    if (!forward) throw new Error('Forward rule not found.');

    const config = await forwardToRuntimeConfig(host, forward);
    await tunnelManager.start(config);
  });

  ipcMain.handle(IPC_CHANNELS.stopForward, async (_event, payload: { hostId: string; forwardId: string }) => {
    const host = getStore().findHostById(payload.hostId);
    if (!host) throw new Error('Host not found.');
    const forward = host.forwards.find((item) => item.id === payload.forwardId);
    if (!forward) throw new Error('Forward rule not found.');

    await tunnelManager.stop(forward.id);
  });

  ipcMain.handle(
    IPC_CHANNELS.refreshService,
    async (_event, payload: { hostId: string; serviceId: string } & ServiceRefreshOptions) => {
      return serviceOperationQueue.run(serviceKey(payload.hostId, payload.serviceId), async () => {
        try {
          const host = getStore().findHostById(payload.hostId);
          if (!host) throw new Error('Host not found.');
          const service = host.services.find((item) => item.id === payload.serviceId);
          if (!service) throw new Error('Service not found.');
          const currentState = runtimeRegistry.getServiceStatus(host.id, service.id, service.pid);

          const result = await checkServiceStatus(host, service);
          if (currentState?.status === 'starting' && result.status === 'stopped') {
            emitStatus(host.id, service.id, 'starting', service.pid);
            return;
          }
          if (result.pid && result.pid !== service.pid) {
            service.pid = result.pid;
            await getStore().upsertHost(host);
          }
          if (result.status === 'running' && service.forwardLocalPort && service.port > 0) {
            try {
              await portForwardManager.start(serviceForwardKey(host.id, service.id), host, service);
              emitForwardStatus(host.id, service.id, 'ok', undefined, Boolean(payload.silent));
            } catch (error) {
              logRuntimeError('port-forward:start', error, {
                hostId: host.id,
                serviceId: service.id,
                localPort: service.forwardLocalPort,
                remotePort: service.port,
              });
              emitForwardStatus(
                host.id,
                service.id,
                'error',
                error instanceof Error ? error.message : String(error),
                Boolean(payload.silent)
              );
            }
          } else if (!service.forwardLocalPort || service.port === 0) {
            emitForwardStatus(host.id, service.id, 'none', undefined, Boolean(payload.silent));
          }
          if (result.status === 'stopped' && service.pid) {
            await portForwardManager.stop(serviceForwardKey(host.id, service.id));
            emitForwardStatus(host.id, service.id, 'none', undefined, Boolean(payload.silent));
            service.pid = undefined;
            await getStore().upsertHost(host);
          }
          emitStatus(host.id, service.id, result.status, service.pid, result.error, Boolean(payload.silent));
        } catch (error) {
          logRuntimeError('service:refresh', error, {
            hostId: payload.hostId,
            serviceId: payload.serviceId,
            silent: Boolean(payload.silent),
          });
          throw error;
        }
      });
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.startService,
    async (_event, payload: { hostId: string; serviceId: string }) => {
      return serviceOperationQueue.run(serviceKey(payload.hostId, payload.serviceId), async () => {
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
          await getStore().upsertHost(host);
          if (!service.forwardLocalPort || service.port === 0) {
            emitForwardStatus(host.id, service.id, 'none');
          }
          emitStatus(host.id, service.id, 'running', service.pid);
        } catch (error) {
          logRuntimeError('service:start', error, payload);
          throw error;
        }
      });
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.stopService,
    async (_event, payload: { hostId: string; serviceId: string }) => {
      return serviceOperationQueue.run(serviceKey(payload.hostId, payload.serviceId), async () => {
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
      });
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.getServiceLogs,
    async (_event, payload: { hostId: string; serviceId: string; query?: { lineLimit?: number } }): Promise<ServiceLogsResult> => {
      try {
        const host = getStore().findHostById(payload.hostId);
        if (!host) throw new Error('Host not found.');
        const service = host.services.find((item) => item.id === payload.serviceId);
        if (!service) throw new Error('Service not found.');
        return getServiceLogs(host, service, payload.query);
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

  ipcMain.handle(IPC_CHANNELS.readClipboardText, async () => {
    return clipboard.readText();
  });

  ipcMain.handle(IPC_CHANNELS.writeClipboardText, async (_event, text: string) => {
    clipboard.writeText(text ?? '');
  });

  ipcMain.handle(IPC_CHANNELS.getUpdateState, async () => {
    return updater.getState();
  });

  ipcMain.handle(IPC_CHANNELS.checkUpdates, async () => {
    return updater.checkForUpdates('manual');
  });

  const getProxyRuntime = (): ProxyRuntime => {
    if (!proxyRuntime) {
      throw new Error('Proxy runtime is not initialized.');
    }
    return proxyRuntime;
  };

  ipcMain.handle(IPC_CHANNELS.appMemoryUsage, async () => {
    const proxyState = await getProxyRuntime().getState();
    return collectAppMemoryUsage({
      metrics: () => app.getAppMetrics(),
      platform: process.platform,
      mihomoPid: proxyState.pid,
    });
  });

  ipcMain.handle(IPC_CHANNELS.proxyGetState, async () => getProxyRuntime().getState());
  ipcMain.handle(IPC_CHANNELS.proxyDownloadCore, async () => getProxyRuntime().downloadCore());
  ipcMain.handle(IPC_CHANNELS.proxyStart, async (_event, mixedPort: unknown) =>
    getProxyRuntime().start(validateProxyMixedPort(mixedPort))
  );
  ipcMain.handle(IPC_CHANNELS.proxyStop, async () => getProxyRuntime().stop());
  ipcMain.handle(IPC_CHANNELS.proxySaveAndFetchSubscription, async (_event, url: string) =>
    getProxyRuntime().saveAndFetchSubscription(url)
  );
  ipcMain.handle(IPC_CHANNELS.proxySetMode, async (_event, mode: ProxyMode) => getProxyRuntime().setMode(mode));
  ipcMain.handle(IPC_CHANNELS.proxySetSystemProxy, async (_event, enabled: boolean) =>
    getProxyRuntime().setSystemProxy(enabled)
  );
  ipcMain.handle(IPC_CHANNELS.proxySetTun, async (_event, enabled: boolean) => getProxyRuntime().setTun(enabled));
  ipcMain.handle(IPC_CHANNELS.proxyAddException, async (_event, draft: unknown) =>
    getProxyRuntime().addException(validateProxyExceptionDraft(draft))
  );
  ipcMain.handle(
    IPC_CHANNELS.proxyUpdateException,
    async (_event, payload: { id?: unknown; draft?: unknown }) =>
      getProxyRuntime().updateException(
        validateProxyExceptionId(payload?.id),
        validateProxyExceptionDraft(payload?.draft)
      )
  );
  ipcMain.handle(IPC_CHANNELS.proxyDeleteException, async (_event, id: unknown) =>
    getProxyRuntime().deleteException(validateProxyExceptionId(id))
  );
  ipcMain.handle(IPC_CHANNELS.proxyGrantTun, async () => getProxyRuntime().grantTun());
  ipcMain.handle(IPC_CHANNELS.proxyRevokeTun, async () => getProxyRuntime().revokeTun());
  ipcMain.handle(IPC_CHANNELS.proxyListProxies, async () => getProxyRuntime().listProxies());
  ipcMain.handle(
    IPC_CHANNELS.proxySelectProxy,
    async (_event, selection: { groupName?: unknown; optionName?: unknown }) => {
      if (typeof selection?.groupName !== 'string' || typeof selection.optionName !== 'string') {
        throw new Error('A strategy group and candidate name are required.');
      }
      return getProxyRuntime().selectProxy(selection.groupName, selection.optionName);
    }
  );
  ipcMain.handle(IPC_CHANNELS.proxyGetLogs, async () => getProxyRuntime().getLogs());
}

function wireProxyStateBroadcast(): void {
  proxyRuntime?.on('state-changed', (state: ProxyState) => {
    broadcast(IPC_CHANNELS.proxyStateChanged, state);
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
    broadcast(IPC_CHANNELS.forwardStatusChanged, payload);
  });
}

function wireUpdaterBroadcast(): void {
  updater.on('state-changed', (state: UpdateState) => {
    broadcast(IPC_CHANNELS.updateState, state);
  });
}

registerProcessErrorHandlers();

app.whenReady()
  .then(async () => {
    const initializedRuntimeLogWriter = new RuntimeLogWriter(path.join(app.getPath('userData'), 'logs'));
    runtimeLogWriter = initializedRuntimeLogWriter;
    setServiceRuntimeDiagnostics((event) =>
      initializedRuntimeLogWriter.record('service:systemd-preflight', new Error('Systemd preflight probe failed'), {
        hostId: event.hostId,
        check: event.check,
        attempt: event.attempt,
        category: event.category,
        exitCode: event.exitCode,
        elapsedMs: event.elapsedMs,
        stderr: event.stderr,
      })
    );

    const filePath = path.join(app.getPath('userData'), 'service-manager.json');
    store = new ServiceStore(filePath);
    await store.load();
    const hosts = store.listHosts();
    syncKnownForwards(hosts);

    const initializedProxyRuntime = new ProxyRuntime(path.join(app.getPath('userData'), 'proxy'));
    proxyRuntime = initializedProxyRuntime;
    await initializedProxyRuntime.init();

    applyAppIcon();
    registerIpcHandlers();
    wireForwardStatusBroadcast();
    wireUpdaterBroadcast();
    wireProxyStateBroadcast();
    applyAppMenu();
    for (const host of hosts) {
      await autoStartHostRules(host);
    }
    updater.start();
    createWindow();
    scheduleProxyAutoStart(initializedProxyRuntime, (error) => logRuntimeError('proxy:auto-start', error));

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  })
  .catch((error) => {
    logRuntimeError('app:startup', error);
    dialog.showErrorBox(
      APP_DISPLAY_NAME,
      `Failed to initialize application.\n\n${error instanceof Error ? error.message : String(error)}`
    );
    app.quit();
  });

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', (event) => {
  if (allowQuitAfterRuntimeShutdown) {
    return;
  }

  event.preventDefault();
  requestQuitAfterRuntimeShutdown();
});
