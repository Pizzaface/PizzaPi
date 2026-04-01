// packages/desktop/src/main/index.ts
import { app, BrowserWindow, dialog } from "electron";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
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
    if (!isQuitting) {
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

  // Start relay server — try ports 3001-3010
  let serverPort = DEFAULT_SERVER_PORT;
  tray?.updateStatus({ server: "starting" });

  let serverStarted = false;
  for (let port = DEFAULT_SERVER_PORT; port < DEFAULT_SERVER_PORT + 10; port++) {
    serverManager = new ServerManager({ port, isDev });
    try {
      await serverManager.start();
      serverPort = port;
      serverStarted = true;
      break;
    } catch (err) {
      const msg = String(err);
      if (msg.includes("already in use") && port < DEFAULT_SERVER_PORT + 9) {
        log.warn(`Port ${port} in use, trying ${port + 1}...`);
        continue;
      }
      log.error("Failed to start server:", err);
      tray?.updateStatus({ server: "error" });
      notifyServiceError(mainWindow!, `Server failed to start: ${err}`);
      return;
    }
  }

  if (!serverStarted) {
    tray?.updateStatus({ server: "error" });
    notifyServiceError(mainWindow!, "Could not find an available port for the server.");
    return;
  }

  log.info(`Server started on port ${serverPort}`);
  tray?.updateStatus({ server: "running" });
  if (mainWindow) {
    sendServiceStatus(mainWindow, {
      server: "running",
      runner: "starting",
      redis: "connected",
    });
  }

  // Start runner daemon
  runnerManager = new RunnerManager({ serverPort, isDev });
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
    try {
      // Try Vite dev server first (for HMR)
      await mainWindow!.loadURL(VITE_DEV_URL);
      mainWindow!.webContents.openDevTools();
    } catch {
      // Vite not running — fall back to built UI assets or server URL
      log.warn("Vite dev server not available, falling back to relay server UI");
      try {
        await mainWindow!.loadURL(`http://localhost:${serverPort}`);
      } catch (err) {
        log.error("Failed to load UI:", err);
      }
    }
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

// Track whether the app is in the process of quitting
let isQuitting = false;

app.on("before-quit", () => {
  isQuitting = true;
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
