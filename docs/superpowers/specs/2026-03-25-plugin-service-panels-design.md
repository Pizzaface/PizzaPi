# Plugin Service Panels

**Date:** 2026-03-25  
**Status:** Approved  
**Proof-of-concept:** System Monitor

## Problem

Adding a UI panel for a runner service requires editing the compiled React bundle (`registry.tsx`). There's no way for plugins or user-authored services to ship their own UI without modifying and rebuilding the PizzaPi UI source.

## Solution

Services packaged as **folders** in `~/.pizzapi/services/` can ship a self-contained web UI alongside their runner logic. The panel is served by the service's own HTTP server, proxied through the existing tunnel infrastructure, and rendered in the PizzaPi UI as an iframe panel — no bundle compilation needed.

## Folder Structure

```
~/.pizzapi/services/<service-name>/
  manifest.json       # Metadata: id, label, icon, entry, panel config
  index.ts            # ServiceHandler module (default export)
  panel/              # Static files served by the service's HTTP server
    index.html
    ...
```

File-based services (`~/.pizzapi/services/foo.ts`) continue to work unchanged.

## manifest.json

```json
{
  "id": "system-monitor",
  "label": "System Monitor",
  "icon": "activity",
  "entry": "./index.ts",
  "panel": {
    "dir": "./panel"
  }
}
```

| Field       | Required | Description |
|-------------|----------|-------------|
| `id`        | Yes      | Unique service ID (must match ServiceHandler.id) |
| `label`     | Yes      | Human-readable panel button label |
| `icon`      | Yes      | Lucide icon name (string, e.g. `"activity"`, `"cpu"`) |
| `entry`     | No       | Service module path relative to folder (default: `./index.ts` or `./index.js`) |
| `panel.dir` | No       | Panel static files directory relative to folder (default: `./panel`) |

## Service-Loader Changes

`service-loader.ts` currently skips directories. Extended behavior:

1. When an entry in the services directory is a **directory**, look for `manifest.json` inside it.
2. Read and validate the manifest (id, label required; icon defaults to `"square"`).
3. Resolve `entry` to an absolute path, load the module via the existing `loadServiceModule()`.
4. Attach manifest metadata to the `ServicePluginResult` so the daemon can access it.

New type:

```ts
interface ServiceManifest {
  id: string;
  label: string;
  icon: string;
  entry?: string;
  panel?: {
    dir?: string;
  };
}

// Extended ServicePluginResult
interface ServicePluginResult {
  handler: ServiceHandler;
  source: ServicePluginSource;
  manifest?: ServiceManifest;  // Present for folder-based services
}
```

## ServiceInitOptions Extension

```ts
interface ServiceInitOptions {
  isShuttingDown: () => boolean;
  announcePanel?: (port: number) => void;  // New
}
```

Only provided to services that have a `panel` section in their manifest. When the service calls `announcePanel(port)`:

1. The daemon internally calls `TunnelService.registerPort(port, label)` to make the port proxiable.
2. The daemon stores the panel mapping: `serviceId → { port, label, icon }`.
3. The daemon re-emits `service_announce` with the updated `panels` array.

## TunnelService Internal API

New method on `TunnelService`:

```ts
/** Register a port for proxying without a UI-initiated tunnel_expose. */
registerPort(port: number, name?: string): void
```

This adds the port to the internal registered set so `tunnel_request` events for it are accepted and proxied. The port is also announced back to the server via the existing `tunnel_registered` event.

## Protocol: service_announce Extension

Current payload:
```ts
{ serviceIds: string[] }
```

Extended:
```ts
interface ServiceAnnounce {
  serviceIds: string[];
  panels?: Array<{
    serviceId: string;
    port: number;
    label: string;
    icon: string;
  }>;
}
```

The `panels` array is only present when at least one service has announced a panel.

## UI Changes

### useRunnerServices hook
- Also tracks `panels` from `service_announce`.
- Exposes `panels: PanelInfo[]` alongside `services: Set<string>`.

### ServicePanelButtons / ServicePanelContainer
- Renders buttons for both **hardcoded** panels (existing registry entries like Tunnel) and **dynamic** panels (from announce).
- Dynamic panels use a generic `IframeServicePanel` component.

### IframeServicePanel component
```tsx
function IframeServicePanel({ sessionId, port }: { sessionId: string; port: number }) {
  return (
    <iframe
      src={`/api/tunnel/${sessionId}/${port}/`}
      className="w-full h-full border-0"
      sandbox="allow-scripts allow-forms allow-same-origin"
    />
  );
}
```

### Lucide icon mapping
Utility to map icon name strings to Lucide React components:
```ts
import * as icons from "lucide-react";
function getLucideIcon(name: string): React.ComponentType { ... }
```

## System Monitor (Proof-of-Concept)

### Restructure
Move `~/.pizzapi/services/system-monitor.js` → `~/.pizzapi/services/system-monitor/`

### manifest.json
```json
{
  "id": "system-monitor",
  "label": "System Monitor",
  "icon": "activity",
  "entry": "./index.ts",
  "panel": { "dir": "./panel" }
}
```

### index.ts
- Starts `Bun.serve()` on port 0 (random available port)
- Serves `panel/` directory as static files
- Exposes `/api/stats` JSON endpoint (CPU, memory, disk, network, top processes)
- Socket events: `subscribe`, `unsubscribe`, `get_stats` (kept for non-panel consumers)
- Calls `announcePanel(server.port)` during init

### panel/index.html
Self-contained HTML/CSS/JS dashboard:
- Polls `/api/stats` at configurable interval (default 3s)
- Displays: CPU load averages, per-core usage bars, memory gauge, disk usage, network I/O throughput, top 5 processes by CPU
- Styled to match PizzaPi's dark theme (CSS variables)
- Responsive within the 280px panel height constraint

## Implementation Order

1. `service-loader.ts` — folder discovery + manifest parsing
2. `TunnelService` — `registerPort()` internal API
3. Daemon — `announcePanel` callback, `service_announce` panels extension
4. Protocol types — extend `ServiceAnnounce`
5. UI — dynamic iframe panels, Lucide icon mapping, hook changes
6. System Monitor — restructure to folder, build panel UI
7. Tests + typecheck

## Future Work

- **Approach C refactor** — Extract tunnel proxy into shared `httpProxy()` engine, add `/api/panel/{sessionId}/{serviceId}/` route (tracked in Godmother)
- **Skill** — Create service-panel authoring skill for building new panels
