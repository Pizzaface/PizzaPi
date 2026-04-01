import { app } from "electron";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Whether we're running in dev mode (passed via --dev flag). */
export const isDev = process.argv.includes("--dev");

/** Default port for the relay server. */
export const DEFAULT_SERVER_PORT = 3001;

/** Vite dev server URL (used in dev mode only). */
export const VITE_DEV_URL = "http://localhost:5173";

/**
 * Root of the packaged app. Uses app.getAppPath() which correctly resolves
 * inside app.asar when asar packaging is enabled.
 */
function getAppRoot(): string {
  return app.getAppPath();
}

/** Path to the bundled UI dist assets (production). */
export function getUIDistPath(): string {
  if (isDev) {
    return join(__dirname, "..", "..", "..", "ui", "dist");
  }
  return join(getAppRoot(), "ui-dist");
}

/** Path to the bundled server entry (production). */
export function getServerEntryPath(): string {
  if (isDev) {
    return join(__dirname, "..", "..", "..", "server", "src", "index.ts");
  }
  return join(getAppRoot(), "server-dist", "index.js");
}

/** Path to the bundled CLI entry for runner (production). */
export function getRunnerEntryPath(): string {
  if (isDev) {
    return join(__dirname, "..", "..", "..", "cli", "src", "index.ts");
  }
  return join(getAppRoot(), "cli-dist", "index.js");
}

/**
 * Resolve the path to the Bun binary. Checks common locations and falls back
 * to `which bun`. Throws a descriptive error if Bun is not found.
 */
export function getBunPath(): string {
  // In dev, "bun" on PATH is fine
  if (isDev) return "bun";

  // Check well-known install locations
  const candidates = [
    join(process.env.HOME ?? "", ".bun", "bin", "bun"),
    "/usr/local/bin/bun",
    "/opt/homebrew/bin/bun",
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }

  // Try `which bun` as a fallback
  try {
    const result = execFileSync("which", ["bun"], { encoding: "utf8", timeout: 3000 });
    const resolved = result.trim();
    if (resolved && existsSync(resolved)) return resolved;
  } catch {
    // which not available or bun not found
  }

  throw new Error(
    "Bun runtime not found. PizzaPi requires Bun to run the relay server and runner daemon.\n\n" +
    "Install Bun: curl -fsSL https://bun.sh/install | bash\n\n" +
    "Then relaunch PizzaPi.",
  );
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
