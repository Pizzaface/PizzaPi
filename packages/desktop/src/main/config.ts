import { app } from "electron";
import { join } from "node:path";

/** Whether we're running in dev mode (passed via --dev flag). */
export const isDev = process.argv.includes("--dev");

/** Default port for the relay server. */
export const DEFAULT_SERVER_PORT = 3001;

/** Vite dev server URL (used in dev mode only). */
export const VITE_DEV_URL = "http://localhost:5173";

/** Path to the bundled UI dist assets (production). */
export function getUIDistPath(): string {
  if (isDev) {
    return join(__dirname, "..", "..", "..", "ui", "dist");
  }
  // In packaged app, electron-builder places them at ui-dist/
  return join(process.resourcesPath, "app", "ui-dist");
}

/** Path to the bundled server entry (production). */
export function getServerEntryPath(): string {
  if (isDev) {
    return join(__dirname, "..", "..", "..", "server", "src", "index.ts");
  }
  return join(process.resourcesPath, "app", "server-dist", "index.js");
}

/** Path to the bundled CLI entry for runner (production). */
export function getRunnerEntryPath(): string {
  if (isDev) {
    return join(__dirname, "..", "..", "..", "cli", "src", "index.ts");
  }
  return join(process.resourcesPath, "app", "cli-dist", "index.js");
}

/** App data directory. */
export function getAppDataPath(): string {
  return app.getPath("userData");
}

/** Logs directory. */
export function getLogsPath(): string {
  return app.getPath("logs");
}

/** Max restart attempts for child processes before showing error. */
export const MAX_RESTART_ATTEMPTS = 3;

/** Health check polling interval in ms. */
export const HEALTH_CHECK_INTERVAL = 500;

/** Health check timeout in ms. */
export const HEALTH_CHECK_TIMEOUT = 30_000;
