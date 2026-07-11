import { contextBridge, ipcRenderer } from 'electron';
import type {
  HostDraft,
  ProxyApi,
  ProxyExceptionDraft,
  ProxyMode,
  ProxyState,
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
  refreshService: (hostId: string, serviceId: string) =>
    ipcRenderer.invoke('service:refresh', { hostId, serviceId }),
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
  startProxy: () => ipcRenderer.invoke('proxy:start'),
  stopProxy: () => ipcRenderer.invoke('proxy:stop'),
  saveAndFetchSubscription: (url: string) => ipcRenderer.invoke('proxy:save-and-fetch-subscription', url),
  setMode: (mode: ProxyMode) => ipcRenderer.invoke('proxy:set-mode', mode),
  setMixedPort: (port: number) => ipcRenderer.invoke('proxy:set-mixed-port', port),
  setSystemProxy: (enabled: boolean) => ipcRenderer.invoke('proxy:set-system-proxy', enabled),
  setTun: (enabled: boolean) => ipcRenderer.invoke('proxy:set-tun', enabled),
  addException: (draft: ProxyExceptionDraft) => ipcRenderer.invoke('proxy:add-exception', draft),
  updateException: (id: string, draft: ProxyExceptionDraft) =>
    ipcRenderer.invoke('proxy:update-exception', { id, draft }),
  deleteException: (id: string) => ipcRenderer.invoke('proxy:delete-exception', id),
  grantTunPermission: () => ipcRenderer.invoke('proxy:grant-tun'),
  revokeTunPermission: () => ipcRenderer.invoke('proxy:revoke-tun'),
  listProxies: () => ipcRenderer.invoke('proxy:list-proxies'),
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
};

contextBridge.exposeInMainWorld('serviceApi', api);
contextBridge.exposeInMainWorld('proxyApi', proxyApi);
