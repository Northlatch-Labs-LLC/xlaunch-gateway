// Built to build/preload-popover.cjs. Exposes the minimal IPC surface the
// popover UI needs — no Node access in the renderer.
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('xlaunch_gateway', {
  snapshot: () => ipcRenderer.invoke('xlaunch-gateway:snapshot'),
  openDashboard: () => ipcRenderer.invoke('xlaunch-gateway:open-dashboard'),
  copyBaseUrl: () => ipcRenderer.invoke('xlaunch-gateway:copy-base-url'),
  copyApiKey: () => ipcRenderer.invoke('xlaunch-gateway:copy-api-key'),
  setLoginItem: (open: boolean) => ipcRenderer.invoke('xlaunch-gateway:set-login-item', open),
  quit: () => ipcRenderer.invoke('xlaunch-gateway:quit'),
  onRefresh: (cb: () => void) => ipcRenderer.on('xlaunch-gateway:refresh', cb),
});
