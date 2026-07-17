import { contextBridge, ipcRenderer } from 'electron';
import type {
  HostDraft,
  KubernetesApi,
  KubernetesListSnapshot,
  KubernetesLogScope,
  KubernetesLogState,
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
  ServiceApi,
  ServiceStatusChange,
  TunnelStatusChange,
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

    ipcRenderer.on('service:status', wrapped);
    return () => ipcRenderer.removeListener('service:status', wrapped);
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
  listPortForwards: () => ipcRenderer.invoke('kubernetes:list-port-forwards'),
  deactivatePage: () => ipcRenderer.invoke('kubernetes:deactivate-page'),
  onStateChanged: (listener: (state: KubernetesState) => void) => subscribe('kubernetes:state', listener),
  onListChanged: (listener: (snapshot: KubernetesListSnapshot) => void) => subscribe('kubernetes:list', listener),
  onLogChanged: (listener: (state: KubernetesLogState) => void) => subscribe('kubernetes:log', listener),
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
contextBridge.exposeInMainWorld('proxyApi', proxyApi);
contextBridge.exposeInMainWorld('kubernetesApi', kubernetesApi);
