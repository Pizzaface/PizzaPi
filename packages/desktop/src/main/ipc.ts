// packages/desktop/src/main/ipc.ts
import { ipcMain, type BrowserWindow } from "electron";
import { app } from "electron";
import { getAutoLaunchEnabled, setAutoLaunchEnabled } from "./auto-launch.js";
import type { TrayStatus } from "./tray.js";
import log from "./logger.js";

/**
 * Register all IPC handlers. Call once at app startup.
 */
export function registerIpcHandlers(): void {
  ipcMain.handle("desktop:getVersion", () => app.getVersion());
  ipcMain.handle("desktop:getPlatform", () => process.platform);
  ipcMain.handle("desktop:getAutoLaunch", () => getAutoLaunchEnabled());
  ipcMain.handle("desktop:setAutoLaunch", (_event, enabled: boolean) => {
    setAutoLaunchEnabled(enabled);
  });

  log.info("IPC handlers registered");
}

/**
 * Send service status update to all renderer windows.
 */
export function sendServiceStatus(window: BrowserWindow, status: TrayStatus): void {
  window.webContents.send("desktop:serviceStatus", status);
}
