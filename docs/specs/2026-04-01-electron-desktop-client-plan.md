# Electron Desktop Client — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a native macOS Electron desktop app that embeds the PizzaPi relay server, runner daemon, and web UI into a self-contained application with system tray, native notifications, and auto-launch.

**Architecture:** New `packages/desktop` workspace. Electron main process spawns the relay server and runner daemon as child processes. The renderer loads the existing `@pizzapi/ui` in a BrowserWindow — zero UI duplication. Native features (tray, notifications, auto-launch) live in the main process.

**Tech Stack:** Electron 35+, electron-builder, TypeScript, `child_process` for server/runner lifecycle.

---

## File Structure

```
packages/desktop/
├── package.json                    ← workspace package, electron + electron-builder deps
├── electron-builder.yml            ← electron-builder config (macOS arm64)
├── tsconfig.json                   ← extends root tsconfig.base.json
├── assets/
│   ├── icon.png                    ← app icon (1024x1024)
│   ├── tray-default.png            ← tray icon default (22x22 @2x template)
│   ├── tray-warning.png            ← tray icon warning state
│   └── tray-error.png              ← tray icon error state
├── src/
│   ├── main/
│   │   ├── index.ts                ← app entry: ready, quit, window creation
│   │   ├── server-manager.ts       ← spawn/stop/health-check relay server
│   │   ├── runner-manager.ts       ← spawn/stop runner daemon
│   │   ├── tray.ts                 ← system tray icon + context menu
│   │   ├── notifications.ts        ← native OS notification dispatch
│   │   ├── auto-launch.ts          ← login item settings
│   │   ├── ipc.ts                  ← IPC channel handlers
│   │   ├── config.ts               ← paths, ports, constants
│   │   └── logger.ts               ← electron-log setup
│   └── preload/
│       └── index.ts                ← contextBridge API
└── tests/
    ├── server-manager.test.ts      ← server lifecycle tests
    └── runner-manager.test.ts      ← runner lifecycle tests
```

---

### Task 1: Scaffold the `packages/desktop` workspace

**Files:**
- Create: `packages/desktop/package.json`
- Create: `packages/desktop/tsconfig.json`
- Create: `packages/desktop/electron-builder.yml`
- Modify: root `package.json` (add workspace + scripts)

- [ ] **Step 1: Create `packages/desktop/package.json`**

```json
{
  "name": "@pizzapi/desktop",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/main/index.js",
  "scripts": {
    "dev": "concurrently \"bun run dev:electron\" \"bun run --cwd ../ui dev\" \"bun run --cwd ../server dev\" --kill-others-on-exit",
    "dev:electron": "electron --inspect . --dev",
    "build": "tsc --build",
    "package": "electron-builder --mac",
    "start": "electron ."
  },
  "dependencies": {
    "@pizzapi/protocol": "workspace:*",
    "electron-log": "^5.3.0"
  },
  "devDependencies": {
    "electron": "^35.0.0",
    "electron-builder": "^26.0.0",
    "concurrently": "^9.2.1",
    "typescript": "^5.7.0"
  }
}
```

- [ ] **Step 2: Create `packages/desktop/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "target": "ES2022",
    "declaration": true,
    "sourceMap": true
  },
  "include": ["src"],
  "references": [
    { "path": "../protocol" }
  ]
}
```

- [ ] **Step 3: Create `packages/desktop/electron-builder.yml`**

```yaml
appId: com.pizzapi.desktop
productName: PizzaPi
copyright: Copyright © 2026 PizzaPi

directories:
  output: release

mac:
  category: public.app-category.developer-tools
  target:
    - target: dir
      arch:
        - arm64
  icon: assets/icon.png

files:
  - dist/**/*
  - assets/**/*
  - package.json
  # Bundle the built UI assets
  - from: ../ui/dist
    to: ui-dist
    filter:
      - "**/*"
  # Bundle the built server
  - from: ../server/dist
    to: server-dist
    filter:
      - "**/*"
  # Bundle the built CLI (runner)
  - from: ../cli/dist
    to: cli-dist
    filter:
      - "**/*"

extraMetadata:
  main: dist/main/index.js
```

- [ ] **Step 4: Add workspace and scripts to root `package.json`**

Add `"packages/desktop"` to the `workspaces` array. Add these scripts:

```json
{
  "dev:desktop": "cd packages/desktop && bun run dev",
  "build:desktop": "bun run build:ui && bun run build:server && bun run build:cli && cd packages/desktop && bun run build",
  "package:desktop": "bun run build:desktop && cd packages/desktop && bun run package"
}
```

- [ ] **Step 5: Run `bun install` to link the new workspace**

```bash
bun install
```

Expected: installs electron and electron-builder, links workspace deps.

- [ ] **Step 6: Commit**

```bash
git add packages/desktop/package.json packages/desktop/tsconfig.json packages/desktop/electron-builder.yml package.json bun.lock
git commit -m "feat(desktop): scaffold Electron workspace"
```

---

### Task 2: Config and logger modules

**Files:**
- Create: `packages/desktop/src/main/config.ts`
- Create: `packages/desktop/src/main/logger.ts`

- [ ] **Step 1: Create `packages/desktop/src/main/config.ts`**

```typescript
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
```

- [ ] **Step 2: Create `packages/desktop/src/main/logger.ts`**

```typescript
import log from "electron-log/main";

log.initialize();
log.transports.file.level = "info";
log.transports.console.level = "debug";

export default log;
```

- [ ] **Step 3: Commit**

```bash
git add packages/desktop/src/main/config.ts packages/desktop/src/main/logger.ts
git commit -m "feat(desktop): add config and logger modules"
```

---

### Task 3: Server manager — spawn, health-check, stop

**Files:**
- Create: `packages/desktop/src/main/server-manager.ts`
- Create: `packages/desktop/tests/server-manager.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/desktop/tests/server-manager.test.ts
import { describe, test, expect, mock, beforeEach } from "bun:test";

// We test the pure logic by mocking child_process and fetch
const mockSpawn = mock(() => ({
  pid: 1234,
  on: mock(() => {}),
  kill: mock(() => true),
  stdout: { on: mock(() => {}) },
  stderr: { on: mock(() => {}) },
}));

mock.module("node:child_process", () => ({
  spawn: mockSpawn,
}));

describe("ServerManager", () => {
  test("start() spawns a child process with the correct entry path", async () => {
    const { ServerManager } = await import("../src/main/server-manager.js");
    const mgr = new ServerManager({ port: 3001, isDev: true });

    // Mock fetch for health check
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() => Promise.resolve(new Response("ok", { status: 200 }))) as any;

    await mgr.start();

    expect(mockSpawn).toHaveBeenCalled();
    expect(mgr.isRunning()).toBe(true);

    globalThis.fetch = originalFetch;
  });

  test("stop() sends SIGTERM to the child process", async () => {
    const { ServerManager } = await import("../src/main/server-manager.js");
    const mgr = new ServerManager({ port: 3001, isDev: true });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() => Promise.resolve(new Response("ok", { status: 200 }))) as any;

    await mgr.start();
    mgr.stop();

    expect(mgr.isRunning()).toBe(false);

    globalThis.fetch = originalFetch;
  });

  test("getPort() returns the configured port", () => {
    const { ServerManager } = await import("../src/main/server-manager.js");
    const mgr = new ServerManager({ port: 3042, isDev: true });
    expect(mgr.getPort()).toBe(3042);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/desktop && bun test tests/server-manager.test.ts
```

Expected: FAIL — module `../src/main/server-manager.js` not found.

- [ ] **Step 3: Implement `server-manager.ts`**

```typescript
// packages/desktop/src/main/server-manager.ts
import { spawn, type ChildProcess } from "node:child_process";
import {
  getServerEntryPath,
  HEALTH_CHECK_INTERVAL,
  HEALTH_CHECK_TIMEOUT,
  MAX_RESTART_ATTEMPTS,
} from "./config.js";
import log from "./logger.js";

export interface ServerManagerOptions {
  port: number;
  isDev: boolean;
}

export class ServerManager {
  private child: ChildProcess | null = null;
  private port: number;
  private isDev: boolean;
  private restartCount = 0;
  private stopping = false;

  constructor(opts: ServerManagerOptions) {
    this.port = opts.port;
    this.isDev = opts.isDev;
  }

  /** Spawn the relay server and wait for it to become healthy. */
  async start(): Promise<void> {
    this.stopping = false;
    const entry = getServerEntryPath();
    log.info(`Starting relay server on port ${this.port}...`);

    const env = {
      ...process.env,
      PORT: String(this.port),
      NODE_ENV: this.isDev ? "development" : "production",
    };

    this.child = spawn("bun", ["run", entry], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.child.stdout?.on("data", (data: Buffer) => {
      log.info(`[server] ${data.toString().trim()}`);
    });

    this.child.stderr?.on("data", (data: Buffer) => {
      log.warn(`[server] ${data.toString().trim()}`);
    });

    this.child.on("exit", (code, signal) => {
      log.info(`Server exited: code=${code} signal=${signal}`);
      this.child = null;
      if (!this.stopping && this.restartCount < MAX_RESTART_ATTEMPTS) {
        this.restartCount++;
        log.warn(`Restarting server (attempt ${this.restartCount}/${MAX_RESTART_ATTEMPTS})...`);
        this.start().catch((err) => log.error("Server restart failed:", err));
      }
    });

    await this.waitForHealthy();
    this.restartCount = 0;
    log.info(`Relay server healthy on port ${this.port}`);
  }

  /** Poll /health until 200 or timeout. */
  private async waitForHealthy(): Promise<void> {
    const deadline = Date.now() + HEALTH_CHECK_TIMEOUT;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://localhost:${this.port}/health`);
        if (res.ok) return;
      } catch {
        // Server not ready yet
      }
      await new Promise((r) => setTimeout(r, HEALTH_CHECK_INTERVAL));
    }
    throw new Error(`Server failed to become healthy within ${HEALTH_CHECK_TIMEOUT}ms`);
  }

  /** Gracefully stop the server. */
  stop(): void {
    this.stopping = true;
    if (this.child) {
      log.info("Stopping relay server...");
      this.child.kill("SIGTERM");
      this.child = null;
    }
  }

  /** Force-kill if still running. */
  forceKill(): void {
    this.stopping = true;
    if (this.child) {
      this.child.kill("SIGKILL");
      this.child = null;
    }
  }

  isRunning(): boolean {
    return this.child !== null;
  }

  getPort(): number {
    return this.port;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd packages/desktop && bun test tests/server-manager.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/main/server-manager.ts packages/desktop/tests/server-manager.test.ts
git commit -m "feat(desktop): add server manager with health check and auto-restart"
```

---

### Task 4: Runner manager — spawn, stop

**Files:**
- Create: `packages/desktop/src/main/runner-manager.ts`
- Create: `packages/desktop/tests/runner-manager.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/desktop/tests/runner-manager.test.ts
import { describe, test, expect, mock } from "bun:test";

const mockSpawn = mock(() => ({
  pid: 5678,
  on: mock(() => {}),
  kill: mock(() => true),
  stdout: { on: mock(() => {}) },
  stderr: { on: mock(() => {}) },
}));

mock.module("node:child_process", () => ({
  spawn: mockSpawn,
}));

describe("RunnerManager", () => {
  test("start() spawns the runner daemon pointing at the local server", async () => {
    const { RunnerManager } = await import("../src/main/runner-manager.js");
    const mgr = new RunnerManager({ serverPort: 3001, isDev: true });

    mgr.start();

    expect(mockSpawn).toHaveBeenCalled();
    expect(mgr.isRunning()).toBe(true);
  });

  test("stop() sends SIGTERM to runner", () => {
    const { RunnerManager } = await import("../src/main/runner-manager.js");
    const mgr = new RunnerManager({ serverPort: 3001, isDev: true });

    mgr.start();
    mgr.stop();

    expect(mgr.isRunning()).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/desktop && bun test tests/runner-manager.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `runner-manager.ts`**

```typescript
// packages/desktop/src/main/runner-manager.ts
import { spawn, type ChildProcess } from "node:child_process";
import { getRunnerEntryPath, MAX_RESTART_ATTEMPTS } from "./config.js";
import log from "./logger.js";

export interface RunnerManagerOptions {
  serverPort: number;
  isDev: boolean;
}

export class RunnerManager {
  private child: ChildProcess | null = null;
  private serverPort: number;
  private isDev: boolean;
  private restartCount = 0;
  private stopping = false;

  constructor(opts: RunnerManagerOptions) {
    this.serverPort = opts.serverPort;
    this.isDev = opts.isDev;
  }

  /** Spawn the runner daemon. */
  start(): void {
    this.stopping = false;
    const entry = getRunnerEntryPath();
    log.info("Starting runner daemon...");

    const env = {
      ...process.env,
      PIZZAPI_SERVER_URL: `http://localhost:${this.serverPort}`,
    };

    this.child = spawn("bun", ["run", entry, "runner"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.child.stdout?.on("data", (data: Buffer) => {
      log.info(`[runner] ${data.toString().trim()}`);
    });

    this.child.stderr?.on("data", (data: Buffer) => {
      log.warn(`[runner] ${data.toString().trim()}`);
    });

    this.child.on("exit", (code, signal) => {
      log.info(`Runner exited: code=${code} signal=${signal}`);
      this.child = null;
      if (!this.stopping && this.restartCount < MAX_RESTART_ATTEMPTS) {
        this.restartCount++;
        log.warn(`Restarting runner (attempt ${this.restartCount}/${MAX_RESTART_ATTEMPTS})...`);
        this.start();
      }
    });
  }

  /** Gracefully stop the runner. */
  stop(): void {
    this.stopping = true;
    if (this.child) {
      log.info("Stopping runner daemon...");
      this.child.kill("SIGTERM");
      this.child = null;
    }
  }

  /** Force-kill if still running. */
  forceKill(): void {
    this.stopping = true;
    if (this.child) {
      this.child.kill("SIGKILL");
      this.child = null;
    }
  }

  isRunning(): boolean {
    return this.child !== null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd packages/desktop && bun test tests/runner-manager.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/main/runner-manager.ts packages/desktop/tests/runner-manager.test.ts
git commit -m "feat(desktop): add runner manager with auto-restart"
```

---

### Task 5: System tray

**Files:**
- Create: `packages/desktop/src/main/tray.ts`
- Create: `packages/desktop/assets/tray-default.png` (placeholder)
- Create: `packages/desktop/assets/tray-warning.png` (placeholder)
- Create: `packages/desktop/assets/tray-error.png` (placeholder)

- [ ] **Step 1: Create placeholder tray icon assets**

Create 44x44 PNG images (22pt @2x macOS template images). For now, use simple colored circles. The filenames must end in `Template.png` for macOS to treat them as template images (auto-adapts to dark/light menu bar).

```bash
# Create assets directory
mkdir -p packages/desktop/assets
```

Generate minimal 44x44 placeholder PNGs (or copy from existing PizzaPi assets):

```bash
# Use the existing pizza.svg as a base, or create placeholders
cp packages/ui/public/pwa-64x64.png packages/desktop/assets/tray-default.png
cp packages/ui/public/pwa-64x64.png packages/desktop/assets/tray-warning.png
cp packages/ui/public/pwa-64x64.png packages/desktop/assets/tray-error.png
cp packages/ui/public/pwa-512x512.png packages/desktop/assets/icon.png
```

- [ ] **Step 2: Implement `tray.ts`**

```typescript
// packages/desktop/src/main/tray.ts
import { Tray, Menu, nativeImage, type BrowserWindow } from "electron";
import { join } from "node:path";
import log from "./logger.js";

export type ServiceHealth = "healthy" | "degraded" | "error";

export interface TrayStatus {
  server: "starting" | "running" | "error" | "stopped";
  runner: "starting" | "running" | "error" | "stopped";
  redis: "connected" | "disconnected";
}

export class AppTray {
  private tray: Tray;
  private window: BrowserWindow;
  private status: TrayStatus = {
    server: "stopped",
    runner: "stopped",
    redis: "disconnected",
  };

  constructor(window: BrowserWindow) {
    this.window = window;

    const iconPath = join(__dirname, "..", "..", "assets", "tray-default.png");
    const icon = nativeImage.createFromPath(iconPath).resize({ width: 22, height: 22 });
    icon.setTemplateImage(true);

    this.tray = new Tray(icon);
    this.tray.setToolTip("PizzaPi");

    this.tray.on("click", () => {
      if (this.window.isVisible()) {
        this.window.hide();
      } else {
        this.window.show();
        this.window.focus();
      }
    });

    this.rebuildMenu();
  }

  updateStatus(status: Partial<TrayStatus>): void {
    Object.assign(this.status, status);
    this.updateIcon();
    this.rebuildMenu();
  }

  private getOverallHealth(): ServiceHealth {
    const { server, runner, redis } = this.status;
    if (server === "error" || redis === "disconnected") return "error";
    if (server === "starting" || runner === "starting") return "degraded";
    if (server === "running" && runner === "running" && redis === "connected") return "healthy";
    return "degraded";
  }

  private updateIcon(): void {
    const health = this.getOverallHealth();
    const iconName =
      health === "error" ? "tray-error.png" :
      health === "degraded" ? "tray-warning.png" :
      "tray-default.png";

    const iconPath = join(__dirname, "..", "..", "assets", iconName);
    const icon = nativeImage.createFromPath(iconPath).resize({ width: 22, height: 22 });
    icon.setTemplateImage(true);
    this.tray.setImage(icon);
  }

  private statusIcon(val: string): string {
    if (val === "running" || val === "connected") return "✓";
    if (val === "starting") return "…";
    return "✕";
  }

  private rebuildMenu(): void {
    const menu = Menu.buildFromTemplate([
      {
        label: this.window.isVisible() ? "Hide Window" : "Show Window",
        click: () => {
          if (this.window.isVisible()) {
            this.window.hide();
          } else {
            this.window.show();
            this.window.focus();
          }
        },
      },
      { type: "separator" },
      {
        label: `Server: localhost ${this.statusIcon(this.status.server)}`,
        enabled: false,
      },
      {
        label: `Runner: ${this.status.runner} ${this.statusIcon(this.status.runner)}`,
        enabled: false,
      },
      {
        label: `Redis: ${this.status.redis} ${this.statusIcon(this.status.redis)}`,
        enabled: false,
      },
      { type: "separator" },
      {
        label: "Quit PizzaPi",
        role: "quit",
      },
    ]);

    this.tray.setContextMenu(menu);
  }

  destroy(): void {
    this.tray.destroy();
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add packages/desktop/src/main/tray.ts packages/desktop/assets/
git commit -m "feat(desktop): add system tray with health status"
```

---

### Task 6: Native notifications

**Files:**
- Create: `packages/desktop/src/main/notifications.ts`

- [ ] **Step 1: Implement `notifications.ts`**

```typescript
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
```

- [ ] **Step 2: Commit**

```bash
git add packages/desktop/src/main/notifications.ts
git commit -m "feat(desktop): add native notification helpers"
```

---

### Task 7: Auto-launch

**Files:**
- Create: `packages/desktop/src/main/auto-launch.ts`

- [ ] **Step 1: Implement `auto-launch.ts`**

```typescript
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
```

- [ ] **Step 2: Commit**

```bash
git add packages/desktop/src/main/auto-launch.ts
git commit -m "feat(desktop): add auto-launch login item support"
```

---

### Task 8: IPC handlers and preload script

**Files:**
- Create: `packages/desktop/src/main/ipc.ts`
- Create: `packages/desktop/src/preload/index.ts`

- [ ] **Step 1: Implement `ipc.ts`**

```typescript
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
```

- [ ] **Step 2: Implement `preload/index.ts`**

```typescript
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
```

- [ ] **Step 3: Commit**

```bash
git add packages/desktop/src/main/ipc.ts packages/desktop/src/preload/index.ts
git commit -m "feat(desktop): add IPC handlers and preload bridge"
```

---

### Task 9: Main process entry — tie everything together

**Files:**
- Create: `packages/desktop/src/main/index.ts`

- [ ] **Step 1: Implement `index.ts`**

```typescript
// packages/desktop/src/main/index.ts
import { app, BrowserWindow, dialog } from "electron";
import { join } from "node:path";
import { ServerManager } from "./server-manager.js";
import { RunnerManager } from "./runner-manager.js";
import { AppTray } from "./tray.js";
import { registerIpcHandlers, sendServiceStatus } from "./ipc.js";
import { notifyServiceError } from "./notifications.js";
import { isDev, DEFAULT_SERVER_PORT, VITE_DEV_URL, getUIDistPath } from "./config.js";
import log from "./logger.js";

let mainWindow: BrowserWindow | null = null;
let tray: AppTray | null = null;
let serverManager: ServerManager | null = null;
let runnerManager: RunnerManager | null = null;

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: "PizzaPi",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: join(__dirname, "..", "preload", "index.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Hide instead of close (app lives in tray)
  win.on("close", (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      win.hide();
    }
  });

  return win;
}

async function checkRedis(): Promise<boolean> {
  try {
    // Quick TCP connect check to default Redis port
    const net = await import("node:net");
    return new Promise((resolve) => {
      const socket = net.createConnection({ port: 6379, host: "127.0.0.1" });
      socket.on("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.on("error", () => {
        resolve(false);
      });
      socket.setTimeout(2000, () => {
        socket.destroy();
        resolve(false);
      });
    });
  } catch {
    return false;
  }
}

async function startServices(): Promise<void> {
  if (!mainWindow) return;

  // Check Redis first
  tray?.updateStatus({ redis: "disconnected", server: "starting" });

  const redisAvailable = await checkRedis();
  if (!redisAvailable) {
    tray?.updateStatus({ redis: "disconnected" });
    notifyServiceError(mainWindow, "Redis is not available. Please start Redis and relaunch.");
    dialog.showErrorBox(
      "Redis Required",
      "PizzaPi requires Redis to be running.\n\nInstall with: brew install redis\nStart with: redis-server\n\nPlease start Redis and relaunch PizzaPi."
    );
    return;
  }

  tray?.updateStatus({ redis: "connected" });

  // Start relay server
  serverManager = new ServerManager({ port: DEFAULT_SERVER_PORT, isDev });
  tray?.updateStatus({ server: "starting" });

  try {
    await serverManager.start();
    tray?.updateStatus({ server: "running" });
    if (mainWindow) {
      sendServiceStatus(mainWindow, {
        server: "running",
        runner: "starting",
        redis: "connected",
      });
    }
  } catch (err) {
    log.error("Failed to start server:", err);
    tray?.updateStatus({ server: "error" });
    notifyServiceError(mainWindow!, `Server failed to start: ${err}`);
    return;
  }

  // Start runner daemon
  runnerManager = new RunnerManager({ serverPort: DEFAULT_SERVER_PORT, isDev });
  tray?.updateStatus({ runner: "starting" });
  runnerManager.start();
  tray?.updateStatus({ runner: "running" });

  if (mainWindow) {
    sendServiceStatus(mainWindow, {
      server: "running",
      runner: "running",
      redis: "connected",
    });
  }

  // Load the UI
  if (isDev) {
    await mainWindow!.loadURL(VITE_DEV_URL);
    mainWindow!.webContents.openDevTools();
  } else {
    const uiPath = getUIDistPath();
    await mainWindow!.loadFile(join(uiPath, "index.html"));
  }
}

async function shutdown(): Promise<void> {
  log.info("Shutting down...");

  if (runnerManager) {
    runnerManager.stop();
    // Wait briefly for graceful shutdown
    await new Promise((r) => setTimeout(r, 2000));
    runnerManager.forceKill();
  }

  if (serverManager) {
    serverManager.stop();
    await new Promise((r) => setTimeout(r, 2000));
    serverManager.forceKill();
  }

  tray?.destroy();
}

// ── App lifecycle ─────────────────────────────────────────────────────────────

// Extend app type to track quitting state
declare module "electron" {
  interface App {
    isQuitting: boolean;
  }
}
app.isQuitting = false;

app.on("before-quit", () => {
  app.isQuitting = true;
});

app.whenReady().then(async () => {
  log.info(`PizzaPi Desktop starting (dev=${isDev})...`);

  registerIpcHandlers();

  mainWindow = createWindow();
  tray = new AppTray(mainWindow);

  await startServices();
});

app.on("will-quit", async (event) => {
  event.preventDefault();
  await shutdown();
  app.exit(0);
});

app.on("window-all-closed", () => {
  // On macOS, don't quit when all windows are closed (app lives in tray)
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  // On macOS, re-show the window when dock icon is clicked
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  }
});
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd packages/desktop && npx tsc --noEmit
```

Expected: no errors (or only errors related to electron types which we'll fix with the build).

- [ ] **Step 3: Commit**

```bash
git add packages/desktop/src/main/index.ts
git commit -m "feat(desktop): add main process entry with full lifecycle orchestration"
```

---

### Task 10: Dev smoke test — launch the Electron app

- [ ] **Step 1: Build the desktop TypeScript**

```bash
cd packages/desktop && bun run build
```

Expected: compiles to `dist/`.

- [ ] **Step 2: Start Redis (if not running)**

```bash
redis-server --daemonize yes
```

- [ ] **Step 3: Launch in dev mode**

```bash
cd packages/desktop && bun run dev
```

Expected: Vite dev server starts, relay server starts, Electron window opens showing the PizzaPi UI. System tray icon appears with green status.

- [ ] **Step 4: Verify tray menu**

Click the tray icon → context menu should show server/runner/Redis status as connected.

- [ ] **Step 5: Verify window hide/show**

Close the window → app should stay in tray. Click tray icon → window reappears. Cmd+Q → app quits, all child processes cleaned up.

- [ ] **Step 6: Commit any fixes from smoke test**

```bash
git add -A
git commit -m "fix(desktop): smoke test fixes"
```

---

### Task 11: Run all tests and typecheck

- [ ] **Step 1: Run desktop tests**

```bash
cd packages/desktop && bun test
```

Expected: all tests pass.

- [ ] **Step 2: Run full repo typecheck**

```bash
bun run typecheck
```

Expected: no new type errors.

- [ ] **Step 3: Run full repo tests**

```bash
bun run test
```

Expected: all existing tests still pass.

- [ ] **Step 4: Final commit and push**

```bash
git add -A
git commit -m "feat(desktop): Electron desktop client v1"
git push -u origin feat/electron-desktop-client
```
