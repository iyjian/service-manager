import { contextBridge, ipcRenderer } from 'electron';
import type { HostDraft, ServiceApi, ServiceStatusChange, TunnelStatusChange } from '../shared/types';

const api: ServiceApi = {
  listHosts: () => ipcRenderer.invoke('host:list'),
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
  getServiceLogs: (hostId: string, serviceId: string) =>
    ipcRenderer.invoke('service:logs', { hostId, serviceId }),
  importPrivateKey: () => ipcRenderer.invoke('auth:import-private-key'),
  openExternal: (url: string) => ipcRenderer.invoke('app:open-external', url),
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
};

contextBridge.exposeInMainWorld('serviceApi', api);
