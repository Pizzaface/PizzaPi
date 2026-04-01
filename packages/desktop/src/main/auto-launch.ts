// packages/desktop/src/main/auto-launch.ts
import { app } from "electron";
import log from "./logger.js";

export function getAutoLaunchEnabled(): boolean {
  const settings = app.getLoginItemSettings();
  return settings.openAtLogin;
}

export function setAutoLaunchEnabled(enabled: boolean): void {
  log.info(`Setting auto-launch: ${enabled}`);
  app.setLoginItemSettings({
    openAtLogin: enabled,
    openAsHidden: true, // Start minimized to tray
  });
}
