import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopApi, DesktopEvent, DesktopRequest } from '../../../../src/shared/desktop-contracts.ts';

const api: DesktopApi = {
  request: (value: DesktopRequest) => ipcRenderer.invoke('jarvis:request', value),
  subscribe: listener => {
    const handler = (_event: unknown, payload: DesktopEvent) => listener(payload);
    ipcRenderer.on('jarvis:event', handler);
    return () => ipcRenderer.removeListener('jarvis:event', handler);
  },
};
contextBridge.exposeInMainWorld('jarvis', Object.freeze(api));
