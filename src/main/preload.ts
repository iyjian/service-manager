import { contextBridge, ipcRenderer } from 'electron';
import type {
  HostDraft,
  Note,
  NoteDraft,
  NotesApi,
  NotesFlushRequest,
  KubernetesApi,
  KubernetesListSnapshot,
  KubernetesLogScope,
  KubernetesLogUpdate,
  KubernetesNamespaceScope,
  KubernetesPodTarget,
  KubernetesPortForwardInput,
  KubernetesVncTarget,
  KubernetesPortForwardState,
  KubernetesRelatedResourceRequest,
  KubernetesResourceQuery,
  KubernetesResourceWindowRange,
  KubernetesResourceSummary,
  KubernetesState,
  KubernetesTerminalState,
  KubernetesTerminalOutput,
  ProxyApi,
  ProxyExceptionDraft,
  ProxyMode,
  ProxyState,
  ProxyTraffic,
  PersistentDataReloaded,
  S3ConnectionTestDraft,
  ServiceApi,
  SqlApi,
  SqlEnvironment,
  SqlLoginInput,
  SqlQueryDraft,
  S3SyncState,
  S3SyncSettingsDraft,
  StartupS3SyncState,
  SettingsApi,
  ServiceStatusChange,
  ServiceStatusChangeBatch,
  TunnelStatusChange,
  TriliumImportApplyInput,
  TriliumImportPrepareInput,
  TriliumImportProgress,
  TriliumImportResolveImagesInput,
  UiPreferences,
  UiPreferencesDraft,
  UpdateState,
} from '../shared/types';

const api: ServiceApi = {
  listHosts: () => ipcRenderer.invoke('host:list'),
  getAppMemoryUsage: () => ipcRenderer.invoke('app:memory-usage'),
  saveHost: (host: HostDraft) => ipcRenderer.invoke('host:save', host),
  deleteHost: (id: string) => ipcRenderer.invoke('host:delete', id),
  exportConfig: () => ipcRenderer.invoke('config:export'),
  importConfig: () => ipcRenderer.invoke('config:import'),
  deleteService: (hostId: string, serviceId: string) =>
    ipcRenderer.invoke('service:delete', { hostId, serviceId }),
  deleteForward: (hostId: string, forwardId: string) =>
    ipcRenderer.invoke('forward:delete', { hostId, forwardId }),
  startService: (hostId: string, serviceId: string) =>
    ipcRenderer.invoke('service:start', { hostId, serviceId }),
  stopService: (hostId: string, serviceId: string) =>
    ipcRenderer.invoke('service:stop', { hostId, serviceId }),
  startForward: (hostId: string, forwardId: string) =>
    ipcRenderer.invoke('forward:start', { hostId, forwardId }),
  stopForward: (hostId: string, forwardId: string) =>
    ipcRenderer.invoke('forward:stop', { hostId, forwardId }),
  refreshService: (hostId: string, serviceId: string, options) =>
    ipcRenderer.invoke('service:refresh', { hostId, serviceId, ...options }),
  refreshHostServices: (hostId: string, serviceIds: string[], options) =>
    ipcRenderer.invoke('service:refresh-host', { hostId, serviceIds, ...options }),
  getServiceLogs: (hostId: string, serviceId: string, query) =>
    ipcRenderer.invoke('service:logs', { hostId, serviceId, query }),
  importPrivateKey: () => ipcRenderer.invoke('auth:import-private-key'),
  getUpdateState: () => ipcRenderer.invoke('updater:get-state'),
  checkForUpdates: () => ipcRenderer.invoke('updater:check'),
  openExternal: (url: string) => ipcRenderer.invoke('app:open-external', url),
  readClipboardText: () => ipcRenderer.invoke('clipboard:read-text'),
  writeClipboardText: (text: string) => ipcRenderer.invoke('clipboard:write-text', text),
  confirmAction: (options) => ipcRenderer.invoke('dialog:confirm', options),
  onServiceStatusChanged: (listener: (change: ServiceStatusChange) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, change: ServiceStatusChange): void => {
      listener(change);
    };
    const wrappedBatch = (_event: Electron.IpcRendererEvent, batch: ServiceStatusChangeBatch): void => {
      for (const change of batch.changes) listener(change);
    };

    ipcRenderer.on('service:status', wrapped);
    ipcRenderer.on('service:status-batch', wrappedBatch);
    return () => {
      ipcRenderer.removeListener('service:status', wrapped);
      ipcRenderer.removeListener('service:status-batch', wrappedBatch);
    };
  },
  onForwardStatusChanged: (listener: (change: TunnelStatusChange) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, change: TunnelStatusChange): void => {
      listener(change);
    };
    ipcRenderer.on('forward:status', wrapped);
    return () => ipcRenderer.removeListener('forward:status', wrapped);
  },
  onUpdateStateChanged: (listener: (state: UpdateState) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, state: UpdateState): void => {
      listener(state);
    };
    ipcRenderer.on('updater:state', wrapped);
    return () => ipcRenderer.removeListener('updater:state', wrapped);
  },
};

const notesApi: NotesApi = {
  listNotes: () => ipcRenderer.invoke('notes:list'),
  getWorkspace: () => ipcRenderer.invoke('notes:workspace'),
  getNote: (id) => ipcRenderer.invoke('notes:get', id),
  searchNotes: (query, activeNote) => ipcRenderer.invoke('notes:search', { query, activeNote }),
  createNote: (placement) => ipcRenderer.invoke('notes:create', placement),
  updateNote: (id: string, draft: NoteDraft, expectedNote: Note) =>
    ipcRenderer.invoke('notes:update', { id, draft, expectedNote }),
  moveNote: (input) => ipcRenderer.invoke('notes:move', input),
  setTreeExpanded: (input) => ipcRenderer.invoke('notes:tree-expanded', input),
  previewNoteDelete: (id) => ipcRenderer.invoke('notes:delete-preview', id),
  deleteNote: (input) => ipcRenderer.invoke('notes:delete', input),
  recoverDrafts: (input) => ipcRenderer.invoke('notes:recover-drafts', input),
  uploadImage: (input) => ipcRenderer.invoke('notes:image:upload', input),
  loadImage: (reference) => ipcRenderer.invoke('notes:image:load', reference),
  uploadAttachment: (input) => ipcRenderer.invoke('notes:attachment:upload', input),
  viewAttachment: (reference) => ipcRenderer.invoke('notes:attachment:view', reference),
  downloadAttachment: (reference) => ipcRenderer.invoke('notes:attachment:download', reference),
  exportNote: (input) => ipcRenderer.invoke('notes:export', input),
  openLastExport: () => ipcRenderer.invoke('notes:export:open-last'),
  onFlushRequested: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, value: unknown): void => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return;
      const { requestId, persistentApplyId } = value as {
        requestId?: unknown;
        persistentApplyId?: unknown;
      };
      if (typeof requestId !== 'string' || requestId.length === 0 || requestId.length > 128) return;
      if (persistentApplyId !== undefined
        && (typeof persistentApplyId !== 'string'
          || persistentApplyId.length === 0
          || persistentApplyId.length > 128)) return;
      const request: NotesFlushRequest = {
        ...(typeof persistentApplyId === 'string' ? { persistentApplyId } : {}),
      };
      void Promise.resolve()
        .then(() => listener(request))
        .then(
          () => ipcRenderer.send('notes:flush-result', { requestId, ok: true }),
          () => ipcRenderer.send('notes:flush-result', { requestId, ok: false }),
        );
    };
    ipcRenderer.on('notes:flush-request', handler);
    return () => ipcRenderer.removeListener('notes:flush-request', handler);
  },
  onPersistentApplyReleased: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, persistentApplyId: unknown): void => {
      if (typeof persistentApplyId !== 'string'
        || persistentApplyId.length === 0
        || persistentApplyId.length > 128) return;
      listener(persistentApplyId);
    };
    ipcRenderer.on('notes:persistent-apply-release', handler);
    return () => ipcRenderer.removeListener('notes:persistent-apply-release', handler);
  },
};

const settingsApi: SettingsApi = {
  getUiPreferences: () => ipcRenderer.invoke('settings:ui:get'),
  saveUiPreferences: (draft: UiPreferencesDraft) => ipcRenderer.invoke('settings:ui:save', draft),
  saveNotesSidebarWidth: (width: number) =>
    ipcRenderer.invoke('settings:ui:notes-sidebar-width:save', width),
  prepareTriliumImport: (input: TriliumImportPrepareInput) =>
    ipcRenderer.invoke('settings:notes:trilium-import:prepare', input),
  resolveTriliumImportImages: (input: TriliumImportResolveImagesInput) =>
    ipcRenderer.invoke('settings:notes:trilium-import:resolve-images', input),
  applyTriliumImport: (input: TriliumImportApplyInput) =>
    ipcRenderer.invoke('settings:notes:trilium-import:apply', input),
  cancelTriliumImport: (requestId: string) =>
    ipcRenderer.invoke('settings:notes:trilium-import:cancel', requestId),
  onTriliumImportProgress: (listener: (progress: TriliumImportProgress) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, progress: TriliumImportProgress): void => listener(progress);
    ipcRenderer.on('settings:notes:trilium-import:progress', wrapped);
    return () => ipcRenderer.removeListener('settings:notes:trilium-import:progress', wrapped);
  },
  getS3SyncSettings: () => ipcRenderer.invoke('settings:s3:get'),
  saveS3SyncSettings: (draft: S3SyncSettingsDraft) => ipcRenderer.invoke('settings:s3:save', draft),
  testS3Connection: (draft: S3ConnectionTestDraft) => ipcRenderer.invoke('settings:s3:test', draft),
  revealS3SyncCredentials: () => ipcRenderer.invoke('settings:s3:reveal-credentials'),
  syncAllDataToS3: () => ipcRenderer.invoke('settings:s3:sync'),
  getLlmSettings: () => ipcRenderer.invoke('settings:llm:get'),
  saveLlmSettings: (draft) => ipcRenderer.invoke('settings:llm:save', draft),
  revealLlmToken: () => ipcRenderer.invoke('settings:llm:reveal-token'),
  listLlmModels: (draft) => ipcRenderer.invoke('settings:llm:list-models', draft),
  onS3SyncStateChanged: (listener: (state: S3SyncState) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, state: S3SyncState): void => listener(state);
    ipcRenderer.on('settings:s3:state', wrapped);
    return () => ipcRenderer.removeListener('settings:s3:state', wrapped);
  },
  getStartupS3SyncState: () => ipcRenderer.invoke('app:startup-s3-sync:get'),
  onStartupS3SyncStateChanged: (listener: (state: StartupS3SyncState) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, state: StartupS3SyncState): void => listener(state);
    ipcRenderer.on('app:startup-s3-sync:state', wrapped);
    return () => ipcRenderer.removeListener('app:startup-s3-sync:state', wrapped);
  },
  onUiPreferencesChanged: (listener: (preferences: UiPreferences) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, preferences: UiPreferences): void => listener(preferences);
    ipcRenderer.on('settings:ui:changed', wrapped);
    return () => ipcRenderer.removeListener('settings:ui:changed', wrapped);
  },
  onPersistentDataReloaded: (listener: (event: PersistentDataReloaded) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, event: PersistentDataReloaded): void => listener(event);
    ipcRenderer.on('app:persistent-data-reloaded', wrapped);
    return () => ipcRenderer.removeListener('app:persistent-data-reloaded', wrapped);
  },
};

const proxyApi: ProxyApi = {
  getState: () => ipcRenderer.invoke('proxy:get-state'),
  downloadCore: () => ipcRenderer.invoke('proxy:download-core'),
  startProxy: (mixedPort: number) => ipcRenderer.invoke('proxy:start', mixedPort),
  stopProxy: () => ipcRenderer.invoke('proxy:stop'),
  saveAndFetchSubscription: (url: string) => ipcRenderer.invoke('proxy:save-and-fetch-subscription', url),
  setMode: (mode: ProxyMode) => ipcRenderer.invoke('proxy:set-mode', mode),
  setSystemProxy: (enabled: boolean) => ipcRenderer.invoke('proxy:set-system-proxy', enabled),
  setTun: (enabled: boolean) => ipcRenderer.invoke('proxy:set-tun', enabled),
  addException: (draft: ProxyExceptionDraft) => ipcRenderer.invoke('proxy:add-exception', draft),
  updateException: (id: string, draft: ProxyExceptionDraft) =>
    ipcRenderer.invoke('proxy:update-exception', { id, draft }),
  deleteException: (id: string) => ipcRenderer.invoke('proxy:delete-exception', id),
  grantTunPermission: () => ipcRenderer.invoke('proxy:grant-tun'),
  revokeTunPermission: () => ipcRenderer.invoke('proxy:revoke-tun'),
  listProxies: () => ipcRenderer.invoke('proxy:list-proxies'),
  testProxyDelays: () => ipcRenderer.invoke('proxy:test-delays'),
  selectProxy: (groupName: string, optionName: string) =>
    ipcRenderer.invoke('proxy:select-proxy', { groupName, optionName }),
  getProxyLogs: () => ipcRenderer.invoke('proxy:get-logs'),
  onProxyStateChanged: (listener: (state: ProxyState) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, state: ProxyState): void => {
      listener(state);
    };
    ipcRenderer.on('proxy:state', wrapped);
    return () => ipcRenderer.removeListener('proxy:state', wrapped);
  },
  onProxyTrafficChanged: (listener: (traffic: ProxyTraffic | null) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, traffic: ProxyTraffic | null): void => {
      listener(traffic);
    };
    ipcRenderer.on('proxy:traffic', wrapped);
    return () => ipcRenderer.removeListener('proxy:traffic', wrapped);
  },
};

const sqlApi: SqlApi = {
  getAuthState: (environment: SqlEnvironment) => ipcRenderer.invoke('sql:auth-state', environment),
  login: (input: SqlLoginInput) => ipcRenderer.invoke('sql:login', input),
  logout: (environment: SqlEnvironment) => ipcRenderer.invoke('sql:logout', environment),
  listQueries: (environment: SqlEnvironment, search?: string) =>
    ipcRenderer.invoke('sql:queries:list', { environment, ...(search ? { search } : {}) }),
  getQuery: (environment: SqlEnvironment, id: number) =>
    ipcRenderer.invoke('sql:query:get', { environment, id }),
  createQuery: (environment: SqlEnvironment, draft: SqlQueryDraft) =>
    ipcRenderer.invoke('sql:query:create', { environment, draft }),
  updateQuery: (environment: SqlEnvironment, id: number, draft: SqlQueryDraft) =>
    ipcRenderer.invoke('sql:query:update', { environment, id, draft }),
  renameQuery: (environment: SqlEnvironment, id: number, name: string) =>
    ipcRenderer.invoke('sql:query:rename', { environment, id, name }),
  deleteQuery: (environment: SqlEnvironment, id: number) =>
    ipcRenderer.invoke('sql:query:delete', { environment, id }),
  execute: (environment: SqlEnvironment, statement: string) =>
    ipcRenderer.invoke('sql:execute', { environment, statement }),
};

const kubernetesApi: KubernetesApi = {
  getState: () => ipcRenderer.invoke('kubernetes:get-state'),
  selectContext: (name: string) => ipcRenderer.invoke('kubernetes:select-context', name),
  reconnect: () => ipcRenderer.invoke('kubernetes:reconnect'),
  reloadKubeconfig: () => ipcRenderer.invoke('kubernetes:reload-kubeconfig'),
  setNamespaceScope: (scope: KubernetesNamespaceScope) => ipcRenderer.invoke('kubernetes:set-namespace-scope', scope),
  listNamespaces: () => ipcRenderer.invoke('kubernetes:list-namespaces'),
  listResources: (query: KubernetesResourceQuery) => ipcRenderer.invoke('kubernetes:list-resources', query),
  getResourceWindow: (query: KubernetesResourceQuery, range: KubernetesResourceWindowRange) =>
    ipcRenderer.invoke('kubernetes:get-resource-window', { query, range }),
  loadMoreResources: (query: KubernetesResourceQuery) => ipcRenderer.invoke('kubernetes:load-more-resources', query),
  listCustomResourceDefinitions: () => ipcRenderer.invoke('kubernetes:list-custom-resource-definitions'),
  getResourceDetail: (query: KubernetesResourceQuery, name: string, namespace?: string) =>
    ipcRenderer.invoke('kubernetes:get-resource-detail', { query, name, ...(namespace ? { namespace } : {}) }),
  getResourceEvents: (uid: string, namespace?: string) =>
    ipcRenderer.invoke('kubernetes:get-resource-events', { uid, ...(namespace ? { namespace } : {}) }),
  getRelatedResources: (request: KubernetesRelatedResourceRequest) =>
    ipcRenderer.invoke('kubernetes:related-resources', request),
  getPodContainerEnvironment: (input: KubernetesPodTarget) =>
    ipcRenderer.invoke('kubernetes:get-pod-environment', input),
  openLogs: (input: KubernetesPodTarget) => ipcRenderer.invoke('kubernetes:open-logs', input),
  setLogScope: (id: string, scope: KubernetesLogScope) => ipcRenderer.invoke('kubernetes:set-log-scope', { id, scope }),
  setLogStartTime: (id: string, startTime?: string) => ipcRenderer.invoke('kubernetes:set-log-start-time', { id, startTime }),
  setLogFollowing: (id: string, following: boolean) => ipcRenderer.invoke('kubernetes:set-log-following', { id, following }),
  clearLogs: (id: string) => ipcRenderer.invoke('kubernetes:clear-logs', id),
  closeLogs: (id: string) => ipcRenderer.invoke('kubernetes:close-logs', id),
  openTerminal: (input: KubernetesPodTarget) => ipcRenderer.invoke('kubernetes:open-terminal', input),
  writeTerminal: (id: string, data: string) => ipcRenderer.invoke('kubernetes:write-terminal', { id, data }),
  resizeTerminal: (id: string, cols: number, rows: number) =>
    ipcRenderer.invoke('kubernetes:resize-terminal', { id, cols, rows }),
  closeTerminal: (id: string) => ipcRenderer.invoke('kubernetes:close-terminal', id),
  openVnc: (input: KubernetesVncTarget) => ipcRenderer.invoke('kubernetes:open-vnc', input),
  startPortForward: (input: KubernetesPortForwardInput) => ipcRenderer.invoke('kubernetes:start-port-forward', input),
  stopPortForward: (id: string) => ipcRenderer.invoke('kubernetes:stop-port-forward', id),
  stopAllPortForwards: () => ipcRenderer.invoke('kubernetes:stop-all-port-forwards'),
  listPortForwards: () => ipcRenderer.invoke('kubernetes:list-port-forwards'),
  deactivatePage: () => ipcRenderer.invoke('kubernetes:deactivate-page'),
  onStateChanged: (listener: (state: KubernetesState) => void) => subscribe('kubernetes:state', listener),
  onListChanged: (listener: (snapshot: KubernetesListSnapshot) => void) => subscribe('kubernetes:list', listener),
  onLogChanged: (listener: (update: KubernetesLogUpdate) => void) => subscribe('kubernetes:log', listener),
  onTerminalChanged: (listener: (state: KubernetesTerminalState) => void) => subscribe('kubernetes:terminal', listener),
  onTerminalOutput: (listener: (output: KubernetesTerminalOutput) => void) => subscribe('kubernetes:terminal-output', listener),
  onPortForwardChanged: (listener: (state: KubernetesPortForwardState) => void) => subscribe('kubernetes:port-forward', listener),
};

function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  const wrapped = (_event: Electron.IpcRendererEvent, value: T): void => listener(value);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

contextBridge.exposeInMainWorld('serviceApi', api);
contextBridge.exposeInMainWorld('notesApi', notesApi);
contextBridge.exposeInMainWorld('settingsApi', settingsApi);
contextBridge.exposeInMainWorld('proxyApi', proxyApi);
contextBridge.exposeInMainWorld('kubernetesApi', kubernetesApi);
contextBridge.exposeInMainWorld('sqlApi', sqlApi);
