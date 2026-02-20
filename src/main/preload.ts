import { contextBridge, ipcRenderer } from 'electron';
import type { HostDraft, ServiceApi, ServiceStatusChange } from '../shared/types';

const api: ServiceApi = {
  listHosts: () => ipcRenderer.invoke('host:list'),
  saveHost: (host: HostDraft) => ipcRenderer.invoke('host:save', host),
  deleteHost: (id: string) => ipcRenderer.invoke('host:delete', id),
  deleteService: (hostId: string, serviceId: string) =>
    ipcRenderer.invoke('service:delete', { hostId, serviceId }),
  startService: (hostId: string, serviceId: string) =>
    ipcRenderer.invoke('service:start', { hostId, serviceId }),
  stopService: (hostId: string, serviceId: string) =>
    ipcRenderer.invoke('service:stop', { hostId, serviceId }),
  refreshService: (hostId: string, serviceId: string) =>
    ipcRenderer.invoke('service:refresh', { hostId, serviceId }),
  getServiceLogs: (hostId: string, serviceId: string) =>
    ipcRenderer.invoke('service:logs', { hostId, serviceId }),
  importPrivateKey: () => ipcRenderer.invoke('auth:import-private-key'),
  openExternal: (url: string) => ipcRenderer.invoke('app:open-external', url),
  onStatusChanged: (listener: (change: ServiceStatusChange) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, change: ServiceStatusChange): void => {
      listener(change);
    };

    ipcRenderer.on('service:status', wrapped);
    return () => ipcRenderer.removeListener('service:status', wrapped);
  },
};

contextBridge.exposeInMainWorld('serviceApi', api);
