import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('clipboardHistory', {
  action: (action: string, id?: string) => ipcRenderer.invoke('clipboard-history:action', action, id),
  onChanged: (callback: () => void) => ipcRenderer.on('clipboard-history:changed', () => callback()),
});
