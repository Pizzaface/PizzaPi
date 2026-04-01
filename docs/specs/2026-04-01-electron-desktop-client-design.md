# Electron Desktop Client — Design Spec

**Date:** 2026-04-01
**Status:** Draft
**Package:** `packages/desktop`

---

## Overview

A native macOS desktop application that wraps PizzaPi into a self-contained experience. Users launch the app and get a fully working PizzaPi environment — relay server, runner daemon, and web UI — without touching a terminal.

The Electron main process orchestrates child processes (relay server, runner daemon) and provides native OS integration (system tray, notifications, auto-launch). The renderer loads the existing `@pizzapi/ui` web app in a BrowserWindow, unchanged.

## Goals

- **Self-contained**: launch the app, everything starts automatically
- **Zero UI duplication**: renderer IS the existing web UI
- **Native feel**: system tray, OS notifications, login item
- **macOS first**: target macOS (arm64) for v1, expand later

## Non-Goals (v1)

- Windows or Linux support
- Bundled Redis (user must have Redis installed)
- Custom desktop-specific UI modifications
- Auto-updates or code signing
- Global hotkeys or deep links (pizzapi:// protocol)

---

## Architecture

### Process Model

Four processes at runtime:

| Process | Role | Implementation |
|---------|------|----------------|
| **Main** | App lifecycle, window management, tray, IPC | Electron main process (Node.js) |
| **Renderer** | Web UI | BrowserWindow loading `@pizzapi/ui` |
| **Relay Server** | HTTP + WebSocket relay, auth, sessions | `child_process.fork()` running `@pizzapi/server` |
| **Runner Daemon** | Agent execution | `child_process.spawn()` running `pizzapi runner` |

### Startup Sequence

1. `app.whenReady()` fires
2. Check Redis connectivity (fail with dialog if unavailable)
3. Spawn relay server on `localhost:3001` (or next available port)
4. Health-check the server (poll `/api/health` until 200)
5. Spawn runner daemon, connecting to the local relay
6. Create BrowserWindow, load UI pointing at `localhost:3001`
7. Initialize system tray with status indicators
8. Register IPC handlers

### Shutdown Sequence

1. User clicks Quit (or Cmd+Q)
2. Send SIGTERM to runner daemon, wait up to 5s
3. Send SIGTERM to relay server, wait up to 5s
4. Force-kill any remaining child processes
5. `app.quit()`

### Window Behavior

- Closing the window hides it (app stays in tray), doesn't quit
- Cmd+Q or tray "Quit" actually exits
- Window state (size, position) persisted via `electron-window-state` or manual `localStorage`

---

## Package Structure

```
packages/desktop/
├── package.json
├── electron-builder.yml
├── tsconfig.json
└── src/
    ├── main/
    │   ├── index.ts              ← app entry, window creation
    │   ├── server-manager.ts     ← spawn/stop relay server
    │   ├── runner-manager.ts     ← spawn/stop runner daemon
    │   ├── tray.ts               ← system tray icon + menu
    │   ├── notifications.ts      ← native OS notifications
    │   ├── auto-launch.ts        ← login item registration
    │   └── ipc.ts                ← IPC handlers (main↔renderer)
    └── preload/
        └── index.ts              ← contextBridge exposing safe APIs
```

---

## Native OS Features

### System Tray

- **Tray icon**: Pizza emoji or custom icon, color-coded by status:
  - Green: all services healthy
  - Yellow: starting or degraded
  - Red: error (server crashed, Redis down)
- **Click**: toggles window visibility
- **Context menu**:
  - Show Window
  - New Session
  - ─── (separator)
  - Server: localhost:3001 ✓ (status indicator)
  - Runner: Connected ✓
  - Redis: Connected ✓
  - ─── (separator)
  - Preferences…
  - Quit PizzaPi

### Native Notifications

Delivered via Electron's `Notification` API. Three notification types:

| Event | Title | Body | Click Action |
|-------|-------|------|-------------|
| Session complete | "Session Complete" | Agent finished task "{name}" in {duration} | Focus window, navigate to session |
| Agent needs input | "Agent Needs Input" | Session "{name}" is waiting for your response | Focus window, navigate to session |
| Service error | "Service Error" | {error description} | Focus window |

Notifications are triggered by listening to the relay server's Socket.IO events from the main process.

### Auto-Launch

- Uses `app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true })` on macOS
- Launches minimized to tray (no window shown)
- Toggled via a setting in tray Preferences or a future settings page
- Persisted in Electron's `app.getPath('userData')` config

---

## Dev Workflow

### Development Mode

```bash
bun run dev:desktop
```

Uses `concurrently` to run:
1. Vite dev server (`packages/ui`) → `localhost:5173`
2. Relay server (`packages/server`) → `localhost:3001`
3. Electron main process with `--dev` flag

In dev mode:
- BrowserWindow loads `http://localhost:5173` (Vite HMR)
- Vite proxies `/api` and `/socket.io` to `localhost:3001`
- Main process TypeScript compiled on-the-fly by Electron (via `tsx` or `electron-vite`)

### Production Build

```bash
bun run build:desktop
```

Steps:
1. Build `packages/ui` → `dist/` (static assets)
2. Build `packages/server` → `dist/` (compiled server)
3. Build `packages/cli` → `dist/` (runner daemon)
4. Compile `packages/desktop/src/main` → JS
5. `electron-builder` packages everything into `PizzaPi.app`

In production mode:
- BrowserWindow loads UI assets from bundled `packages/ui/dist`
- Main process spawns server from bundled `packages/server/dist`
- Runner uses bundled `packages/cli/dist`

### New Root Scripts

```json
{
  "dev:desktop": "cd packages/desktop && bun run dev",
  "build:desktop": "bun run build:ui && bun run build:server && bun run build:cli && cd packages/desktop && bun run build",
  "package:desktop": "cd packages/desktop && bun run package"
}
```

---

## Dependencies

### Runtime
- `electron` — app runtime

### Dev / Build
- `electron-builder` — packaging into `.app` / `.dmg`
- `electron-log` — structured logging for main process

### Workspace Dependencies
- `@pizzapi/ui` — renderer content (built assets)
- `@pizzapi/server` — relay server (spawned as child process)
- `@pizzapi/cli` — runner daemon (spawned as child process)
- `@pizzapi/protocol` — shared types for Socket.IO events

---

## IPC Contract

The preload script exposes a minimal API via `contextBridge`:

```typescript
interface DesktopAPI {
  // App info
  getVersion(): string;
  getPlatform(): string;

  // Service status
  onServiceStatus(callback: (status: ServiceStatus) => void): void;

  // Window controls
  minimizeToTray(): void;

  // Settings
  getAutoLaunch(): Promise<boolean>;
  setAutoLaunch(enabled: boolean): Promise<void>;
}

interface ServiceStatus {
  server: 'starting' | 'running' | 'error' | 'stopped';
  runner: 'starting' | 'running' | 'error' | 'stopped';
  redis: 'connected' | 'disconnected';
}
```

The renderer doesn't need to call most of these directly — the existing UI already connects to the server via Socket.IO. The IPC layer is primarily for desktop-specific features (tray status, auto-launch toggle).

---

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Redis not available | Show dialog: "Redis is required. Please install and start Redis." with link to install instructions. Don't start server. |
| Server crashes | Tray goes red. Notification: "Server crashed — restarting…". Auto-restart up to 3 times, then show error dialog. |
| Runner crashes | Tray shows degraded. Notification: "Runner disconnected — restarting…". Auto-restart up to 3 times. |
| Port 3001 in use | Try next available port (3002, 3003…). Pass port to UI via query param or env. |
| Electron crash | Standard Electron crash reporter. Log to `~/Library/Logs/PizzaPi/`. |

---

## File Locations (macOS)

| Purpose | Path |
|---------|------|
| App data | `~/Library/Application Support/PizzaPi/` |
| Logs | `~/Library/Logs/PizzaPi/` |
| Config | `~/.pizzapi/config.json` (shared with CLI) |
| Database | `~/Library/Application Support/PizzaPi/auth.db` |

---

## Testing Strategy

- **Unit tests**: server-manager, runner-manager lifecycle logic (spawn, health-check, restart, shutdown)
- **Integration tests**: full startup/shutdown sequence with mocked child processes
- **Manual testing**: tray behavior, notifications, auto-launch, window state persistence

Test files co-located: `server-manager.test.ts`, `runner-manager.test.ts`, etc.

---

## Future Considerations (Not in v1)

- Windows and Linux support
- Bundled Redis (embed redis-server binary)
- Auto-updates via `electron-updater`
- Code signing and notarization for macOS distribution
- `.dmg` installer and Homebrew cask
- Global hotkeys (toggle visibility, new session)
- Deep links (`pizzapi://` protocol handler)
- Custom titlebar with traffic-light integration
