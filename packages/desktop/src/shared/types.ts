/**
 * Shared types between main, preload, and renderer processes.
 * Keep this file free of Electron imports so it can be used in any context.
 */

/** Service status sent from main → renderer via IPC. */
export interface ServiceStatus {
  server: "starting" | "running" | "error" | "stopped";
  runner: "starting" | "running" | "error" | "stopped";
  redis: "connected" | "disconnected";
}
