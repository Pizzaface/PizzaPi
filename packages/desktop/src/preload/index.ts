// packages/desktop/src/preload/index.ts
import { contextBridge, ipcRenderer } from "electron";

export interface DesktopAPI {
  getVersion(): Promise<string>;
  getPlatform(): Promise<string>;
  getAutoLaunch(): Promise<boolean>;
  setAutoLaunch(enabled: boolean): Promise<void>;
  onServiceStatus(callback: (status: any) => void): () => void;
}

const desktopAPI: DesktopAPI = {
  getVersion: () => ipcRenderer.invoke("desktop:getVersion"),
  getPlatform: () => ipcRenderer.invoke("desktop:getPlatform"),
  getAutoLaunch: () => ipcRenderer.invoke("desktop:getAutoLaunch"),
  setAutoLaunch: (enabled) => ipcRenderer.invoke("desktop:setAutoLaunch", enabled),
  onServiceStatus: (callback) => {
    const handler = (_event: any, status: any) => callback(status);
    ipcRenderer.on("desktop:serviceStatus", handler);
    // Return cleanup function
    return () => ipcRenderer.removeListener("desktop:serviceStatus", handler);
  },
};

contextBridge.exposeInMainWorld("desktopAPI", desktopAPI);
