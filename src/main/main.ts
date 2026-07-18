import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, safeStorage, shell } from 'electron';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import type {
  ConfigTransferResult,
  ConfirmDialogOptions,
  ForwardState,
  HostConfig,
  HostDraft,
  NoteDraft,
  PrivateKeyImportResult,
  ServiceRefreshOptions,
  ServiceLogsResult,
  ServiceStatus,
  TunnelStatusChange,
  UpdateState,
  KubernetesLogState,
  KubernetesLogScope,
  KubernetesNamespaceScope,
  KubernetesPodTarget,
  KubernetesPortForwardInput,
  KubernetesRelatedResourceRequest,
  KubernetesResourceQuery,
  KubernetesState,
  KubernetesTerminalState,
  KubernetesTerminalOutput,
  KubernetesListSnapshot,
  KubernetesPortForwardState,
  KubernetesVncLaunchResult,
  KubernetesVncTarget,
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
import type { ProxyExceptionDraft, ProxyMode, ProxyState, ProxyTraffic } from '../shared/types';
import { KubernetesRuntime } from './kubernetes/kubernetesRuntime';
import { FileKubernetesContextPreference } from './kubernetes/contextPreference';
import { validateKubernetesTerminalInput } from './kubernetes/terminalInput';
import { AppQuitCoordinator } from './quitCoordinator';
import { NotesStore } from './notesStore';
import { collectPersistentAppData } from './appDataSnapshot';
import { S3SyncRuntime } from './s3Sync';

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
  notesList: 'notes:list',
  notesCreate: 'notes:create',
  notesUpdate: 'notes:update',
  notesDelete: 'notes:delete',
  notesFlushRequest: 'notes:flush-request',
  notesFlushResult: 'notes:flush-result',
  s3SettingsGet: 'settings:s3:get',
  s3SettingsSave: 'settings:s3:save',
  s3Sync: 'settings:s3:sync',
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
  proxyTestDelays: 'proxy:test-delays',
  proxySelectProxy: 'proxy:select-proxy',
  proxyGetLogs: 'proxy:get-logs',
  proxyStateChanged: 'proxy:state',
  proxyTrafficChanged: 'proxy:traffic',
  kubernetesGetState: 'kubernetes:get-state',
  kubernetesSelectContext: 'kubernetes:select-context',
  kubernetesReconnect: 'kubernetes:reconnect',
  kubernetesReloadKubeconfig: 'kubernetes:reload-kubeconfig',
  kubernetesSetNamespaceScope: 'kubernetes:set-namespace-scope',
  kubernetesListNamespaces: 'kubernetes:list-namespaces',
  kubernetesListResources: 'kubernetes:list-resources',
  kubernetesGetResourceWindow: 'kubernetes:get-resource-window',
  kubernetesLoadMoreResources: 'kubernetes:load-more-resources',
  kubernetesListCustomResourceDefinitions: 'kubernetes:list-custom-resource-definitions',
  kubernetesGetResourceDetail: 'kubernetes:get-resource-detail',
  kubernetesGetResourceEvents: 'kubernetes:get-resource-events',
  kubernetesGetRelatedResources: 'kubernetes:related-resources',
  kubernetesGetPodEnvironment: 'kubernetes:get-pod-environment',
  kubernetesOpenLogs: 'kubernetes:open-logs',
  kubernetesLoadOlderLogs: 'kubernetes:load-older-logs',
  kubernetesSetLogScope: 'kubernetes:set-log-scope',
  kubernetesSetLogStartTime: 'kubernetes:set-log-start-time',
  kubernetesSetLogFollowing: 'kubernetes:set-log-following',
  kubernetesClearLogs: 'kubernetes:clear-logs',
  kubernetesCloseLogs: 'kubernetes:close-logs',
  kubernetesOpenTerminal: 'kubernetes:open-terminal',
  kubernetesWriteTerminal: 'kubernetes:write-terminal',
  kubernetesResizeTerminal: 'kubernetes:resize-terminal',
  kubernetesCloseTerminal: 'kubernetes:close-terminal',
  kubernetesOpenVnc: 'kubernetes:open-vnc',
  kubernetesStartPortForward: 'kubernetes:start-port-forward',
  kubernetesStopPortForward: 'kubernetes:stop-port-forward',
  kubernetesStopAllPortForwards: 'kubernetes:stop-all-port-forwards',
  kubernetesListPortForwards: 'kubernetes:list-port-forwards',
  kubernetesDeactivatePage: 'kubernetes:deactivate-page',
  kubernetesStateChanged: 'kubernetes:state',
  kubernetesListChanged: 'kubernetes:list',
  kubernetesLogChanged: 'kubernetes:log',
  kubernetesTerminalChanged: 'kubernetes:terminal',
  kubernetesTerminalOutput: 'kubernetes:terminal-output',
  kubernetesPortForwardChanged: 'kubernetes:port-forward',
} as const;

const forwardOwners = new Map<string, string>();
let store: ServiceStore | null = null;
let notesStore: NotesStore | null = null;
let s3SyncRuntime: S3SyncRuntime | null = null;
let proxyRuntime: ProxyRuntime | null = null;
let kubernetesRuntime: KubernetesRuntime | null = null;
let runtimeLogWriter: RuntimeLogWriter | null = null;
const RENDERER_NOTES_FLUSH_TIMEOUT_MS = 2_000;
const pendingRendererNotesFlushes = new Map<string, {
  senderId: number;
  timeout: ReturnType<typeof setTimeout>;
  resolve: () => void;
  reject: (error: Error) => void;
}>();
const autoStartAbortController = new AbortController();
const runtimeRegistry = new RuntimeRegistry();
const serviceOperationQueue = new KeyedOperationQueue();
const portForwardManager = new PortForwardManager();
const tunnelManager = new TunnelManager();
let updater: AppUpdater;
let quitCoordinator: AppQuitCoordinator;
const APP_DISPLAY_NAME = 'Service Manager';
const APP_ICON_PATH = path.join(__dirname, '..', '..', 'assets', 'icon.png');
const FINAL_PROCESS_EXIT_DELAY_MS = 1_500;

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

function getNotesStore(): NotesStore {
  if (!notesStore) {
    throw new Error('Notes store is not initialized.');
  }
  return notesStore;
}

function getS3SyncRuntime(): S3SyncRuntime {
  if (!s3SyncRuntime) {
    throw new Error('S3 sync is not initialized.');
  }
  return s3SyncRuntime;
}

function requestRendererNotesFlush(window: BrowserWindow): Promise<void> {
  if (window.isDestroyed() || window.webContents.isDestroyed()) return Promise.resolve();
  const requestId = randomUUID();
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRendererNotesFlushes.delete(requestId);
      reject(new Error('The renderer did not finish saving Notes before the timeout.'));
    }, RENDERER_NOTES_FLUSH_TIMEOUT_MS);
    timeout.unref();
    pendingRendererNotesFlushes.set(requestId, {
      senderId: window.webContents.id,
      timeout,
      resolve,
      reject,
    });
    try {
      window.webContents.send(IPC_CHANNELS.notesFlushRequest, requestId);
    } catch {
      clearTimeout(timeout);
      pendingRendererNotesFlushes.delete(requestId);
      reject(new Error('The renderer could not be asked to save Notes.'));
    }
  });
}

async function flushRendererNotes(): Promise<void> {
  const windows = BrowserWindow.getAllWindows().filter((window) =>
    !window.isDestroyed() && !window.webContents.isDestroyed()
  );
  await Promise.all(windows.map((window) => requestRendererNotesFlush(window)));
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

const KUBERNETES_RESOURCE_KINDS = new Set([
  'pods', 'deployments', 'statefulsets', 'services', 'ingresses', 'configmaps',
  'secrets', 'persistentvolumeclaims', 'nodes', 'namespaces', 'custom-resources',
]);
const KUBERNETES_CUSTOM_RESOURCE_PART = /^[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?$/;
const KUBERNETES_CUSTOM_RESOURCE_VERSION = /^v[0-9]+(?:alpha[0-9]+|beta[0-9]+)?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validateKubernetesText(value: unknown, label: string, maximum = 16_384): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum) {
    throw new Error(`Kubernetes ${label} is required and must be within the allowed size.`);
  }
  return value;
}

function validateKubernetesNamespaceScope(value: unknown): KubernetesNamespaceScope {
  if (!isRecord(value) || (value.mode !== 'all' && value.mode !== 'selected') || !Array.isArray(value.namespaces)) {
    throw new Error('Kubernetes Namespace scope is invalid.');
  }
  if (value.namespaces.some((namespace) => typeof namespace !== 'string' || namespace.length > 253)) {
    throw new Error('Kubernetes Namespace names must be text within the allowed size.');
  }
  return { mode: value.mode, namespaces: [...value.namespaces] as string[] };
}

function validateKubernetesQuery(value: unknown): KubernetesResourceQuery {
  if (!isRecord(value) || !KUBERNETES_RESOURCE_KINDS.has(value.kind as string)) {
    throw new Error('Kubernetes resource query is invalid.');
  }
  const query: KubernetesResourceQuery = {
    context: validateKubernetesText(value.context, 'Context name'),
    kind: value.kind as KubernetesResourceQuery['kind'],
    namespaceScope: validateKubernetesNamespaceScope(value.namespaceScope),
  };
  for (const field of ['apiVersion', 'plural', 'labelSelector', 'fieldSelector', 'nameFilter'] as const) {
    if (value[field] !== undefined) {
      query[field] = validateKubernetesText(value[field], field);
    }
  }
  if (value.scope !== undefined) {
    if (value.scope !== 'namespaced' && value.scope !== 'cluster') {
      throw new Error('Kubernetes resource scope is invalid.');
    }
    query.scope = value.scope;
  }
  if (value.sort !== undefined) {
    if (!isRecord(value.sort) || (value.sort.direction !== 'asc' && value.sort.direction !== 'desc')) {
      throw new Error('Kubernetes resource sort is invalid.');
    }
    query.sort = { column: validateKubernetesText(value.sort.column, 'sort column'), direction: value.sort.direction };
  }
  if (query.kind === 'custom-resources') {
    const apiVersion = validateKubernetesText(query.apiVersion, 'custom resource API version');
    const plural = validateKubernetesText(query.plural, 'custom resource plural');
    const [group, version, ...extra] = apiVersion.split('/');
    if (!group || !version || extra.length > 0 || !KUBERNETES_CUSTOM_RESOURCE_PART.test(group)
      || !KUBERNETES_CUSTOM_RESOURCE_VERSION.test(version) || !KUBERNETES_CUSTOM_RESOURCE_PART.test(plural)) {
      throw new Error('Kubernetes custom resource query is invalid.');
    }
  }
  return query;
}

function validateKubernetesWindowRange(value: unknown): { start: number; end: number } {
  if (!isRecord(value)) {
    throw new Error('Kubernetes resource window is invalid.');
  }
  const start = value.start;
  const end = value.end;
  if (typeof start !== 'number' || typeof end !== 'number'
    || !Number.isInteger(start) || !Number.isInteger(end)
    || start < 0 || end < start || end - start > 256) {
    throw new Error('Kubernetes resource window is invalid.');
  }
  return { start, end };
}

function validateKubernetesPodTarget(value: unknown): KubernetesPodTarget {
  if (!isRecord(value)) {
    throw new Error('Kubernetes Pod target is invalid.');
  }
  return {
    namespace: validateKubernetesText(value.namespace, 'Namespace'),
    podName: validateKubernetesText(value.podName, 'Pod name'),
    container: validateKubernetesText(value.container, 'container'),
  };
}

function validateKubernetesVncTarget(value: unknown): KubernetesVncTarget {
  if (!isRecord(value)) {
    throw new Error('Kubernetes VNC target is invalid.');
  }
  return {
    namespace: validateKubernetesText(value.namespace, 'Namespace', 253),
    podName: validateKubernetesText(value.podName, 'Pod name', 253),
    podUid: validateKubernetesText(value.podUid, 'Pod UID', 253),
  };
}

function validateKubernetesPortForward(value: unknown): KubernetesPortForwardInput {
  if (!isRecord(value) || (value.targetKind !== 'pod' && value.targetKind !== 'service')) {
    throw new Error('Kubernetes port forward is invalid.');
  }
  if (typeof value.remotePort !== 'number' || !Number.isInteger(value.remotePort)
    || value.remotePort < 1 || value.remotePort > 65_535) {
    throw new Error('Kubernetes remote port must be an integer between 1 and 65535.');
  }
  const remotePort = value.remotePort;
  const input: KubernetesPortForwardInput = {
    targetKind: value.targetKind,
    namespace: validateKubernetesText(value.namespace, 'Namespace'),
    targetName: validateKubernetesText(value.targetName, 'port forward target name'),
    remotePort,
  };
  if (value.localPort !== undefined) {
    if (typeof value.localPort !== 'number' || !Number.isInteger(value.localPort) || value.localPort < 0 || value.localPort > 65_535) {
      throw new Error('Kubernetes local port must be an integer between 0 and 65535.');
    }
    input.localPort = value.localPort;
  }
  return input;
}

function validateKubernetesRelatedResourceRequest(value: unknown): KubernetesRelatedResourceRequest {
  if (!isRecord(value) || (value.kind !== 'service' && value.kind !== 'deployment' && value.kind !== 'statefulset')) {
    throw new Error('Kubernetes related resource request is invalid.');
  }
  const request: KubernetesRelatedResourceRequest = {
    kind: value.kind,
    namespace: validateKubernetesText(value.namespace, 'Namespace'),
    name: validateKubernetesText(value.name, 'resource name'),
  };
  if (value.selector !== undefined) {
    request.selector = validateKubernetesText(value.selector, 'Workload selector');
  }
  if ((request.kind === 'deployment' || request.kind === 'statefulset') && !request.selector) {
    throw new Error('Kubernetes Workload selector is required.');
  }
  return request;
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

  let allowStandaloneWindowClose = false;
  let standaloneWindowClosePending = false;
  window.on('close', (event) => {
    if (quitCoordinator.canQuitImmediately() || allowStandaloneWindowClose) return;
    event.preventDefault();
    if (process.platform !== 'darwin') {
      requestQuitAfterRuntimeShutdown();
      return;
    }
    if (standaloneWindowClosePending) return;
    standaloneWindowClosePending = true;
    void requestRendererNotesFlush(window).then(() => {
      allowStandaloneWindowClose = true;
      if (!window.isDestroyed()) window.close();
    }).catch((error) => {
      standaloneWindowClosePending = false;
      logRuntimeError('notes:window-close-flush', error);
      if (!window.isDestroyed()) {
        void dialog.showMessageBox(window, {
          type: 'error',
          title: 'Notes Could Not Be Saved',
          message: 'The window was kept open because the latest Notes changes could not be saved.',
          detail: 'Try saving again before closing the window.',
        });
      }
    });
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

  try {
    await flushRendererNotes();
  } catch (error) {
    logRuntimeError('app:shutdown', error, { operation: 'renderer-notes-flush' });
  }

  const shutdownResults = await Promise.allSettled([
    Promise.resolve().then(() => notesStore?.flush()),
    Promise.resolve().then(() => s3SyncRuntime?.shutdown()),
    Promise.resolve().then(() => portForwardManager.shutdown()),
    Promise.resolve().then(() => tunnelManager.stopAll()),
    Promise.resolve().then(() => proxyRuntime?.shutdown()),
    Promise.resolve().then(() => kubernetesRuntime?.shutdown()),
  ]);
  for (const result of shutdownResults) {
    if (result.status === 'rejected') {
      logRuntimeError('app:shutdown', result.reason, { operation: 'runtime-stop' });
    }
  }

  await flushRuntimeLog();
}

function requestQuitAfterRuntimeShutdown(signal = false): void {
  void quitCoordinator.request(signal ? 'signal' : 'normal');
}

function runFinalExitAction(action: () => void): void {
  const forcedExit = setTimeout(() => process.exit(0), FINAL_PROCESS_EXIT_DELAY_MS);
  forcedExit.unref();
  action();
}

updater = new AppUpdater(
  () => BrowserWindow.getAllWindows()[0] ?? null,
  () => { void quitCoordinator.request('install-update'); },
);
quitCoordinator = new AppQuitCoordinator({
  abortAutoStart: () => autoStartAbortController.abort(),
  cleanup: shutdownRuntimesForQuit,
  reportCleanupError: async (error) => {
    logRuntimeError('app:shutdown', error, { operation: 'runtime-stop' });
    await flushRuntimeLog();
  },
  quit: () => runFinalExitAction(() => app.quit()),
  installUpdate: () => runFinalExitAction(() => updater.installDownloadedUpdate()),
  exit: () => runFinalExitAction(() => app.exit(0)),
});

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

  ipcMain.handle(IPC_CHANNELS.notesList, async () => getNotesStore().list());
  ipcMain.handle(IPC_CHANNELS.notesCreate, async () => getNotesStore().create());
  ipcMain.handle(IPC_CHANNELS.notesUpdate, async (_event, payload: unknown) => {
    if (!isRecord(payload) || typeof payload.id !== 'string') {
      throw new Error('Note update is invalid.');
    }
    return getNotesStore().update(payload.id, payload.draft as NoteDraft);
  });
  ipcMain.handle(IPC_CHANNELS.notesDelete, async (_event, id: unknown) => {
    if (typeof id !== 'string') throw new Error('Note ID is invalid.');
    await getNotesStore().delete(id);
  });
  ipcMain.on(IPC_CHANNELS.notesFlushResult, (event, payload: unknown) => {
    if (!isRecord(payload) || typeof payload.requestId !== 'string' || typeof payload.ok !== 'boolean') return;
    const pending = pendingRendererNotesFlushes.get(payload.requestId);
    if (!pending || pending.senderId !== event.sender.id) return;
    pendingRendererNotesFlushes.delete(payload.requestId);
    clearTimeout(pending.timeout);
    if (payload.ok) {
      pending.resolve();
    } else {
      pending.reject(new Error('The renderer could not save the latest Notes changes.'));
    }
  });
  ipcMain.handle(IPC_CHANNELS.s3SettingsGet, async () => getS3SyncRuntime().getS3SyncSettings());
  ipcMain.handle(IPC_CHANNELS.s3SettingsSave, async (_event, draft: unknown) =>
    getS3SyncRuntime().saveS3SyncSettings(draft)
  );
  ipcMain.handle(IPC_CHANNELS.s3Sync, async () => getS3SyncRuntime().syncAllDataToS3());

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

  const getKubernetesRuntime = (): KubernetesRuntime => {
    if (!kubernetesRuntime) {
      throw new Error('Kubernetes runtime is not initialized.');
    }
    return kubernetesRuntime;
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
  ipcMain.handle(IPC_CHANNELS.proxyTestDelays, async () => getProxyRuntime().testProxyDelays());
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

  ipcMain.handle(IPC_CHANNELS.kubernetesGetState, async () => getKubernetesRuntime().getState());
  ipcMain.handle(IPC_CHANNELS.kubernetesSelectContext, async (_event, name: unknown) =>
    getKubernetesRuntime().selectContext(validateKubernetesText(name, 'Context name'))
  );
  ipcMain.handle(IPC_CHANNELS.kubernetesReconnect, async () => getKubernetesRuntime().reconnect());
  ipcMain.handle(IPC_CHANNELS.kubernetesReloadKubeconfig, async () => getKubernetesRuntime().reloadKubeconfig());
  ipcMain.handle(IPC_CHANNELS.kubernetesSetNamespaceScope, async (_event, scope: unknown) =>
    getKubernetesRuntime().setNamespaceScope(validateKubernetesNamespaceScope(scope))
  );
  ipcMain.handle(IPC_CHANNELS.kubernetesListNamespaces, async () =>
    getKubernetesRuntime().listNamespaces()
  );
  ipcMain.handle(IPC_CHANNELS.kubernetesListResources, async (_event, query: unknown) =>
    getKubernetesRuntime().listResources(validateKubernetesQuery(query))
  );
  ipcMain.handle(IPC_CHANNELS.kubernetesGetResourceWindow, async (_event, payload: unknown) => {
    if (!isRecord(payload)) throw new Error('Kubernetes resource window request is invalid.');
    return getKubernetesRuntime().getResourceWindow(
      validateKubernetesQuery(payload.query),
      validateKubernetesWindowRange(payload.range)
    );
  });
  ipcMain.handle(IPC_CHANNELS.kubernetesLoadMoreResources, async (_event, query: unknown) =>
    getKubernetesRuntime().loadMoreResources(validateKubernetesQuery(query))
  );
  ipcMain.handle(IPC_CHANNELS.kubernetesListCustomResourceDefinitions, async () =>
    getKubernetesRuntime().listCustomResourceDefinitions()
  );
  ipcMain.handle(
    IPC_CHANNELS.kubernetesGetResourceDetail,
    async (_event, payload: unknown) => {
      if (!isRecord(payload)) throw new Error('Kubernetes resource detail request is invalid.');
      return getKubernetesRuntime().getResourceDetail(
        validateKubernetesQuery(payload.query),
        validateKubernetesText(payload.name, 'resource name'),
        payload.namespace === undefined ? undefined : validateKubernetesText(payload.namespace, 'Namespace')
      );
    }
  );
  ipcMain.handle(
    IPC_CHANNELS.kubernetesGetResourceEvents,
    async (_event, payload: unknown) => {
      if (!isRecord(payload)) throw new Error('Kubernetes Events request is invalid.');
      return getKubernetesRuntime().getResourceEvents(
        validateKubernetesText(payload.uid, 'resource UID'),
        payload.namespace === undefined ? undefined : validateKubernetesText(payload.namespace, 'Namespace')
      );
    }
  );
  ipcMain.handle(
    IPC_CHANNELS.kubernetesGetRelatedResources,
    async (_event, request: unknown) => getKubernetesRuntime().getRelatedResources(
      validateKubernetesRelatedResourceRequest(request)
    )
  );
  ipcMain.handle(IPC_CHANNELS.kubernetesGetPodEnvironment, async (_event, input: unknown) =>
    getKubernetesRuntime().getPodContainerEnvironment(validateKubernetesPodTarget(input))
  );
  ipcMain.handle(IPC_CHANNELS.kubernetesOpenLogs, async (_event, input: unknown) =>
    getKubernetesRuntime().openLogs(validateKubernetesPodTarget(input))
  );
  ipcMain.handle(IPC_CHANNELS.kubernetesLoadOlderLogs, async (_event, id: unknown) =>
    getKubernetesRuntime().loadOlderLogs(validateKubernetesText(id, 'log session ID'))
  );
  ipcMain.handle(
    IPC_CHANNELS.kubernetesSetLogScope,
    async (_event, payload: unknown) => {
      if (!isRecord(payload) || (payload.scope !== 'pod' && payload.scope !== 'deployment')) {
        throw new Error('Kubernetes log scope request is invalid.');
      }
      return getKubernetesRuntime().setLogScope(
        validateKubernetesText(payload.id, 'log session ID'),
        payload.scope as KubernetesLogScope
      );
    }
  );
  ipcMain.handle(
    IPC_CHANNELS.kubernetesSetLogFollowing,
    async (_event, payload: unknown) => {
      if (!isRecord(payload) || typeof payload.following !== 'boolean') throw new Error('Kubernetes log following request is invalid.');
      return getKubernetesRuntime().setLogFollowing(validateKubernetesText(payload.id, 'log session ID'), payload.following);
    }
  );
  ipcMain.handle(
    IPC_CHANNELS.kubernetesSetLogStartTime,
    async (_event, payload: unknown) => {
      if (!isRecord(payload) || (payload.startTime !== undefined && typeof payload.startTime !== 'string')) {
        throw new Error('Kubernetes log start time request is invalid.');
      }
      return getKubernetesRuntime().setLogStartTime(
        validateKubernetesText(payload.id, 'log session ID'),
        payload.startTime === undefined
          ? undefined
          : validateKubernetesText(payload.startTime, 'log start time', 64)
      );
    }
  );
  ipcMain.handle(IPC_CHANNELS.kubernetesClearLogs, async (_event, id: unknown) =>
    getKubernetesRuntime().clearLogs(validateKubernetesText(id, 'log session ID'))
  );
  ipcMain.handle(IPC_CHANNELS.kubernetesCloseLogs, async (_event, id: unknown) =>
    getKubernetesRuntime().closeLogs(validateKubernetesText(id, 'log session ID'))
  );
  ipcMain.handle(IPC_CHANNELS.kubernetesOpenTerminal, async (_event, input: unknown) =>
    getKubernetesRuntime().openTerminal(validateKubernetesPodTarget(input))
  );
  ipcMain.handle(
    IPC_CHANNELS.kubernetesWriteTerminal,
    async (_event, payload: unknown) => {
      if (!isRecord(payload)) throw new Error('Kubernetes terminal input is invalid.');
      return getKubernetesRuntime().writeTerminal(
        validateKubernetesText(payload.id, 'terminal ID'),
        validateKubernetesTerminalInput(payload.data)
      );
    }
  );
  ipcMain.handle(
    IPC_CHANNELS.kubernetesResizeTerminal,
    async (_event, payload: unknown) => {
      if (!isRecord(payload) || typeof payload.cols !== 'number' || !Number.isInteger(payload.cols) || payload.cols < 1
        || typeof payload.rows !== 'number' || !Number.isInteger(payload.rows) || payload.rows < 1) {
        throw new Error('Kubernetes terminal dimensions are invalid.');
      }
      return getKubernetesRuntime().resizeTerminal(
        validateKubernetesText(payload.id, 'terminal ID'),
        payload.cols,
        payload.rows
      );
    }
  );
  ipcMain.handle(IPC_CHANNELS.kubernetesCloseTerminal, async (_event, id: unknown) =>
    getKubernetesRuntime().closeTerminal(validateKubernetesText(id, 'terminal ID'))
  );
  ipcMain.handle(
    IPC_CHANNELS.kubernetesOpenVnc,
    async (_event, input: unknown): Promise<KubernetesVncLaunchResult> => {
      const handle = await getKubernetesRuntime().openVnc(validateKubernetesVncTarget(input));
      const viewerPassword = handle.takeViewerPassword();
      const authority = viewerPassword
        ? `vnc:${encodeURIComponent(viewerPassword)}@127.0.0.1`
        : '127.0.0.1';
      try {
        await shell.openExternal(`vnc://${authority}:${handle.localPort}`);
      } catch {
        await handle.close().catch(() => undefined);
        throw new Error('Unable to open the system VNC client. Install or configure a VNC client that handles vnc:// links.');
      }
      return {
        namespace: handle.namespace,
        podName: handle.podName,
        vmiName: handle.vmiName,
        localPort: handle.localPort,
      };
    }
  );
  ipcMain.handle(IPC_CHANNELS.kubernetesStartPortForward, async (_event, input: unknown) =>
    getKubernetesRuntime().startPortForward(validateKubernetesPortForward(input))
  );
  ipcMain.handle(IPC_CHANNELS.kubernetesStopPortForward, async (_event, id: unknown) =>
    getKubernetesRuntime().stopPortForward(validateKubernetesText(id, 'port forward ID'))
  );
  ipcMain.handle(IPC_CHANNELS.kubernetesStopAllPortForwards, async () =>
    getKubernetesRuntime().stopAllPortForwards()
  );
  ipcMain.handle(IPC_CHANNELS.kubernetesListPortForwards, async () => getKubernetesRuntime().listPortForwards());
  ipcMain.handle(IPC_CHANNELS.kubernetesDeactivatePage, async () => getKubernetesRuntime().deactivatePage());
}

function wireProxyStateBroadcast(): void {
  proxyRuntime?.on('state-changed', (state: ProxyState) => {
    broadcast(IPC_CHANNELS.proxyStateChanged, state);
  });
  proxyRuntime?.on('traffic-changed', (traffic: ProxyTraffic | null) => {
    broadcast(IPC_CHANNELS.proxyTrafficChanged, traffic);
  });
}

function wireKubernetesBroadcast(): void {
  kubernetesRuntime?.onStateChanged((state: KubernetesState) => {
    broadcast(IPC_CHANNELS.kubernetesStateChanged, state);
  });
  kubernetesRuntime?.onListChanged((snapshot: KubernetesListSnapshot) => {
    broadcast(IPC_CHANNELS.kubernetesListChanged, snapshot);
  });
  kubernetesRuntime?.onLogChanged((state: KubernetesLogState) => {
    broadcast(IPC_CHANNELS.kubernetesLogChanged, state);
  });
  kubernetesRuntime?.onTerminalChanged((state: KubernetesTerminalState) => {
    broadcast(IPC_CHANNELS.kubernetesTerminalChanged, state);
  });
  kubernetesRuntime?.onTerminalOutput((output: KubernetesTerminalOutput) => {
    broadcast(IPC_CHANNELS.kubernetesTerminalOutput, output);
  });
  kubernetesRuntime?.onPortForwardChanged((state: KubernetesPortForwardState) => {
    broadcast(IPC_CHANNELS.kubernetesPortForwardChanged, state);
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
process.once('SIGINT', () => {
  requestQuitAfterRuntimeShutdown(true);
});
process.once('SIGTERM', () => {
  requestQuitAfterRuntimeShutdown(true);
});

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

    notesStore = new NotesStore(path.join(app.getPath('userData'), 'notes.json'));
    await notesStore.load();

    const userDataPath = app.getPath('userData');
    const initializedProxyRuntime = new ProxyRuntime(path.join(userDataPath, 'proxy'));
    proxyRuntime = initializedProxyRuntime;
    await initializedProxyRuntime.init();

    const contextPreference = new FileKubernetesContextPreference(
      path.join(userDataPath, 'kubernetes-context.json')
    );
    const initializedKubernetesRuntime = new KubernetesRuntime({
      kubeconfigDirectory: path.join(app.getPath('home'), '.kube'),
      contextPreference,
      onDiagnostic: (scope, error, context) => logRuntimeError(scope, error, context),
    });
    kubernetesRuntime = initializedKubernetesRuntime;
    await initializedKubernetesRuntime.init();

    s3SyncRuntime = new S3SyncRuntime({
      userDataPath,
      appVersion: app.getVersion(),
      credentialProtector: {
        isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
        encryptString: (value) => safeStorage.encryptString(value),
        decryptString: (value) => safeStorage.decryptString(value),
        getSelectedStorageBackend: () => process.platform === 'linux'
          ? safeStorage.getSelectedStorageBackend()
          : 'unknown',
      },
      snapshotProvider: async () => {
        const activeNotesStore = getNotesStore();
        await activeNotesStore.flush();
        const [proxy, kubernetesContextSelection] = await Promise.all([
          initializedProxyRuntime.exportPersistentSnapshot(),
          contextPreference.load(),
        ]);
        return collectPersistentAppData({
          hosts: getStore().listHosts(),
          notes: activeNotesStore.exportSnapshot(),
          proxy,
          kubernetesContextSelection,
        });
      },
    });

    applyAppIcon();
    registerIpcHandlers();
    wireForwardStatusBroadcast();
    wireUpdaterBroadcast();
    wireProxyStateBroadcast();
    wireKubernetesBroadcast();
    applyAppMenu();
    for (const host of hosts) {
      await autoStartHostRules(host);
    }
    updater.start();
    createWindow();
    scheduleProxyAutoStart(
      initializedProxyRuntime,
      (error) => logRuntimeError('proxy:auto-start', error),
      autoStartAbortController.signal
    );

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
  if (quitCoordinator.canQuitImmediately()) {
    return;
  }

  event.preventDefault();
  requestQuitAfterRuntimeShutdown();
});
