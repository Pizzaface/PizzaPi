// packages/desktop/src/main/notifications.ts
import { Notification, type BrowserWindow } from "electron";
import log from "./logger.js";

export interface NotificationOptions {
  title: string;
  body: string;
  /** If set, clicking the notification focuses the window. */
  window?: BrowserWindow;
}

export function showNotification(opts: NotificationOptions): void {
  if (!Notification.isSupported()) {
    log.warn("Notifications not supported on this platform");
    return;
  }

  const notification = new Notification({
    title: opts.title,
    body: opts.body,
    silent: false,
  });

  if (opts.window) {
    notification.on("click", () => {
      opts.window!.show();
      opts.window!.focus();
    });
  }

  notification.show();
}

export function notifySessionComplete(window: BrowserWindow, sessionName: string, duration: string): void {
  showNotification({
    title: "Session Complete",
    body: `Agent finished "${sessionName}" in ${duration}`,
    window,
  });
}

export function notifyAgentNeedsInput(window: BrowserWindow, sessionName: string): void {
  showNotification({
    title: "Agent Needs Input",
    body: `Session "${sessionName}" is waiting for your response`,
    window,
  });
}

export function notifyServiceError(window: BrowserWindow, error: string): void {
  showNotification({
    title: "Service Error",
    body: error,
    window,
  });
}
