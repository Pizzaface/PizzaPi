# Web UI Extension Platform — Design Spec

**Date:** 2026-03-13  
**Status:** Draft  
**Godmother ID:** WqK3N8Ft

## Overview

A runtime extension system for the PizzaPi web UI. **Tool Services** are long-running processes on the runner that expose structured data. **Extensions** are sandboxed iframe-based UI components that consume that data and render visualizations in the web UI. Agents (or humans) author both.

**Example:** A "System Monitor" Tool Service pushes CPU/memory/disk metrics from the runner. A "System Monitor Dashboard" Extension subscribes to that stream and renders a live dashboard in the CombinedPanel.

## Architecture

**Layered Hybrid** — Tool Services register via the existing `/runner` Socket.IO namespace. Extensions get a thin server-side metadata registry. Data flows through the `/viewer` namespace on multiplexed `ext:*` channels. Extensions render in sandboxed iframes as CombinedPanel tabs.

```
┌──────────────────────────────────────────────────────────────────┐
│ Browser                                                          │
│  ┌──────────────────────┐  ┌──────────────────────────────────┐  │
│  │ CombinedPanel        │  │ Session Viewer                   │  │
│  │  [Terminal] [Files]  │  │                                  │  │
│  │  [📊 SysMon] [🔌 …] │  │  (existing, unchanged)           │  │
│  │  ┌────────────────┐  │  │                                  │  │
│  │  │ <iframe>       │  │  │                                  │  │
│  │  │  Extension UI  │◄─┤──┤─── ext:data (postMessage)       │  │
│  │  │  (sandboxed)   │  │  │                                  │  │
│  │  └────────────────┘  │  │                                  │  │
│  └──────────┬───────────┘  └──────────────────────────────────┘  │
│             │ Socket.IO /viewer (ext:* events)                   │
└─────────────┼────────────────────────────────────────────────────┘
              │
┌─────────────┼────────────────────────────────────────────────────┐
│ Server      │                                                    │
│  ┌──────────▼───────────┐  ┌──────────────────────────────────┐  │
│  │ Extension Registry   │  │ Subscription Fan-out             │  │
│  │ (metadata + trust)   │  │ (viewer ↔ runner stream mgmt)   │  │
│  └──────────┬───────────┘  └──────────────┬───────────────────┘  │
│             │ Socket.IO /runner (ext:* events)                   │
└─────────────┼─────────────────────────────┼──────────────────────┘
              │                             │
┌─────────────┼─────────────────────────────┼──────────────────────┐
│ Runner      │                             │                      │
│  ┌──────────▼───────────┐  ┌──────────────▼───────────────────┐  │
│  │ Extension Manager    │  │ Service Manager                  │  │
│  │ (files, fs watcher)  │  │ (spawn, health, stdin/stdout)    │  │
│  └──────────────────────┘  └──────────────┬───────────────────┘  │
│                                           │ JSON-line stdio      │
│                            ┌──────────────▼───────────────────┐  │
│                            │ Tool Service Process              │  │
│                            │ (system-monitor, etc.)            │  │
│                            └──────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

## 1. Tool Service Definition

A Tool Service is a long-running process on the runner that exposes structured data through a defined schema.

### Manifest

Location: `~/.pizzapi/services/<name>/service.json`

```json
{
  "name": "system-monitor",
  "version": "1.0.0",
  "description": "Live system metrics (CPU, memory, disk, network)",
  "schema": {
    "streams": {
      "metrics": {
        "description": "Real-time system metrics",
        "interval": 2000,
        "shape": {
          "cpu": "number",
          "memory": { "used": "number", "total": "number" },
          "disk": { "used": "number", "total": "number" },
          "network": { "up": "number", "down": "number" }
        }
      }
    },
    "queries": {
      "process-list": {
        "description": "List running processes",
        "params": { "sortBy": "string", "limit": "number" },
        "returns": "array"
      }
    }
  },
  "entrypoint": "./monitor.js"
}
```

- **Streams:** Continuous data push. The service declares the shape and suggested interval.
- **Queries:** Request/response. Extensions call them on demand.
- **Entrypoint:** A script the runner daemon spawns and manages.

### Service ↔ Daemon Protocol (stdin/stdout JSON-lines)

**Daemon → Service:**
```jsonl
{"type":"subscribe","stream":"metrics"}
{"type":"unsubscribe","stream":"metrics"}
{"type":"query","id":"q1","query":"process-list","params":{"sortBy":"cpu","limit":10}}
```

**Service → Daemon:**
```jsonl
{"type":"data","stream":"metrics","data":{"cpu":42,"memory":{"used":8.2,"total":16}}}
{"type":"query-result","id":"q1","data":[{"pid":1234,"name":"node","cpu":12.3}]}
{"type":"query-error","id":"q1","error":"invalid sort field"}
```

### Lifecycle

- Runner daemon discovers services in `~/.pizzapi/services/` on startup.
- Spawns each service's entrypoint as a child process.
- Health monitoring: restart on crash with exponential backoff (base delay 1s, doubling each retry, max 3 retries, then mark as failed). Retry counter resets after 60s of healthy uptime.
- Streaming is demand-driven: only starts when the server reports active subscribers (`ext_subscribe`). Idle services stay spawned but don't produce stream data.
- Services register with the server via the existing `/runner` namespace.

## 2. Extension Manifest & Authoring

An Extension is a sandboxed iframe-based UI component that consumes data from one or more Tool Services.

### Manifest

Location: `~/.pizzapi/extensions/<name>/extension.json`

```json
{
  "name": "system-monitor-ui",
  "version": "1.0.0",
  "description": "Dashboard for system metrics",
  "icon": "📊",
  "entrypoint": "./index.html",
  "services": ["system-monitor"],
  "subscriptions": {
    "system-monitor": {
      "streams": ["metrics"],
      "queries": ["process-list"]
    }
  },
  "trust": "user"
}
```

- `services`: Tool Services this extension requires. PizzaPi validates availability before loading.
- `subscriptions`: Specific streams/queries the extension uses. The bridge only exposes these (least privilege).
- `entrypoint`: HTML file. Self-contained HTML/CSS/JS bundle — no build step required.
- `trust`: Set by the system — `"user"` (from known dirs, auto-loads), `"agent"` (created mid-session, needs approval), `"verified"` (future: signed/reviewed).
- `icon`: Emoji or icon identifier for the CombinedPanel tab.

### Authoring Paths

**File-based (human):** Create a directory in `~/.pizzapi/extensions/`, write the manifest and HTML. Runner detects it on next scan or via fs watcher for hot-reload.

**Agent API:** Agent calls `create_extension` tool with manifest + HTML content. Runner writes files, registers with server, and notifies the web UI. An approval prompt appears for `"agent"` trust tier. Once approved, the extension loads and is trusted for future sessions.

### Hot-Reload

When extension files change on disk, the runner detects it (fs watcher), bumps a version counter, and notifies the server via `ext_extension_updated`. The server tells the browser, which reloads the iframe with a cache-busting version parameter. For agents iterating, changes appear in seconds.

## 3. Data Bridge (postMessage API)

The bridge is how the iframe extension communicates with PizzaPi. A postMessage-based protocol — the iframe sends requests, PizzaPi responds and pushes data.

### iframe → Host

```js
// Subscribe to a stream
window.parent.postMessage({
  type: 'ext:subscribe',
  service: 'system-monitor',
  stream: 'metrics'
}, '*');

// Execute a query
window.parent.postMessage({
  type: 'ext:query',
  id: 'q1',
  service: 'system-monitor',
  query: 'process-list',
  params: { sortBy: 'cpu', limit: 10 }
}, '*');

// Unsubscribe
window.parent.postMessage({
  type: 'ext:unsubscribe',
  service: 'system-monitor',
  stream: 'metrics'
}, '*');
```

### Host → iframe

```js
// Stream data push
{ type: 'ext:data', service: 'system-monitor', stream: 'metrics',
  data: { cpu: 42, memory: { used: 8.2, total: 16 }, ... } }

// Query response
{ type: 'ext:query-result', id: 'q1',
  data: [{ pid: 1234, name: 'node', cpu: 12.3 }, ...] }

// Query error
{ type: 'ext:query-error', id: 'q1', error: 'Service unavailable' }

// Theme update (on load + when user toggles dark/light)
{ type: 'ext:theme', theme: 'dark',
  vars: { '--bg': '#1c1917', '--accent': '#f97316', ... } }

// Service status change
{ type: 'ext:service-status', service: 'system-monitor',
  status: 'connected' | 'disconnected' }
```

### SDK (Optional Helper)

A small `pizzapi-ext.js` library that extensions can include for convenience. Available as a `<script>` tag (exposes `window.PizzaPiExt` global — the zero-build-step path agents use) or as an ES module import for extensions with a build step:

```html
<!-- Script tag (no build step) -->
<script src="/api/extensions/sdk/pizzapi-ext.js"></script>
<script>
  const { subscribe, query, onTheme } = PizzaPiExt;
</script>
```

```js
// ES module import (with build step)
import { subscribe, query, onTheme } from 'pizzapi-ext';

subscribe('system-monitor', 'metrics', (data) => {
  updateDashboard(data);
});

const procs = await query('system-monitor', 'process-list', { sortBy: 'cpu' });

onTheme((theme) => {
  document.body.className = theme.theme;
});
```

Thin wrapper around postMessage. Extensions can use raw postMessage if preferred.

### End-to-End Data Flow

```
Tool Service process → (stdin/stdout JSON-lines) → Runner daemon
  → (Socket.IO /runner: ext_service_data) → Server
  → (Socket.IO /viewer: ext_data) → Browser host
  → (postMessage: ext:data) → Extension iframe
```

## 4. Security Model

### iframe Sandbox

```html
<iframe sandbox="allow-scripts"
        src="..."
        csp="default-src 'self' 'unsafe-inline'; connect-src none;">
```

- `allow-scripts` but NOT `allow-same-origin`: extension runs JS but gets an opaque unique origin. Cannot access PizzaPi's cookies, localStorage, or DOM.
- No `allow-top-navigation`: cannot redirect PizzaPi.
- No `allow-popups`: cannot open new windows.
- CSP `connect-src none`: cannot make network requests to arbitrary servers.

### postMessage Validation

- Host validates `event.source` — only accepts messages from the specific iframe window reference.
- Messages checked against declared `subscriptions` — undeclared service access is rejected.
- Query correlation IDs prevent response spoofing between extensions.

### Trust Tiers

| Tier | Source | Behavior |
|------|--------|----------|
| `user` | `~/.pizzapi/extensions/` | Auto-loads on startup |
| `agent` | Created via agent API mid-session | Requires one-time user approval; trusted for future sessions once approved |
| `verified` | Future: signed/reviewed | Auto-loads, extended capabilities (deferred — see V1 Scope Boundary) |

### Residual Risks

- Extension can consume CPU within its sandbox (crypto mining, spin loops). Mitigation: trust tiers, future resource monitoring.
- No network exfiltration due to CSP, but this depends on correct header configuration.

## 5. Protocol Extensions

All new Socket.IO events are prefixed with `ext_` to avoid collision.

### Runner Namespace Additions (`/runner`)

**Runner → Server:**

| Event | Purpose |
|-------|---------|
| `ext_services_list` | Report available Tool Services |
| `ext_service_data` | Forward stream data from a service |
| `ext_query_result` | Forward query response from a service |
| `ext_extensions_list` | Report available extensions |
| `ext_extension_result` | Extension CRUD operation result |
| `ext_extension_updated` | Hot-reload notification (name + version) |

**Server → Runner:**

| Event | Purpose |
|-------|---------|
| `list_services` | Request service list |
| `list_extensions` | Request extension list |
| `create_extension` | Write extension files (agent-created) |
| `update_extension` | Update extension files |
| `delete_extension` | Remove extension |
| `ext_query` | Forward query from viewer to service |
| `ext_subscribe` | Viewer subscribed to a stream |
| `ext_unsubscribe` | Last viewer unsubscribed from a stream |

### Viewer Namespace Additions (`/viewer`)

**Server → Viewer:**

| Event | Purpose |
|-------|---------|
| `ext_extensions` | Available extensions for this runner |
| `ext_data` | Stream data pushed to viewer |
| `ext_query_result` | Query result forwarded to viewer |
| `ext_updated` | Extension updated (trigger iframe reload) |
| `ext_service_status` | Service connected/disconnected |
| `ext_approval_request` | Agent-created extension needs approval |

**Viewer → Server:**

| Event | Purpose |
|-------|---------|
| `ext_subscribe` | Subscribe to a stream |
| `ext_unsubscribe` | Unsubscribe from a stream |
| `ext_query` | Execute a query on a service |
| `ext_approve` | Approve/reject agent-created extension |

### Extension Asset Serving

REST endpoint: `GET /api/extensions/:runnerId/:extensionName/*`

Proxies to the runner to fetch extension files. The server requests file content via a Socket.IO `ext_get_file` event on the `/runner` namespace; the runner responds with the file content as a base64-encoded payload. The server caches the response keyed by `extensionName + path + version` to avoid repeated round-trips. The iframe `src` points here with a `?v=<version>` cache-busting parameter.

### Smart Subscription Fan-out

The server tracks which viewer sockets are subscribed to which streams. First subscriber triggers `ext_subscribe` to the runner. Last unsubscriber triggers `ext_unsubscribe`. Streams only produce data when there are active viewers.

## 6. UI Integration

### CombinedPanel

Extensions render as additional tabs alongside Terminal and File Explorer.

- Tabs show extension `icon` + `name`.
- Agent-created extensions pending approval show dimmed with a 🔒 badge.
- Iframes are lazy-loaded on first tab click.
- iframe `src`: `/api/extensions/:runnerId/:extensionName/index.html?v=<version>`
- On `ext_updated`, the iframe src is updated to trigger reload.
- On `ext_service_status: disconnected`, the tab shows a warning indicator.

### Approval Flow

1. Agent calls `create_extension` tool.
2. Runner writes files, notifies server.
3. Server sends `ext_approval_request` to connected viewers.
4. Web UI shows toast: "Agent created extension 'System Monitor'. Enable it?" with Accept/Reject.
5. Accept → `ext_approve` → server marks trusted → tab becomes active.
6. Extension auto-loads on future sessions (now in trusted registry). Trust state is persisted server-side in the extension metadata registry (same DB as auth/sessions) keyed by extension name + runner ID. The runner also retains the files on disk, but the server is the source of truth for trust decisions.

### New Components

- `ExtensionHost`: Manages iframe lifecycle, postMessage bridge, subscription forwarding. One instance per loaded extension tab.
- `ExtensionTab`: Tab UI with icon, name, status badge, close button.
- `ExtensionApprovalToast`: Notification for agent-created extensions.

## 7. Runner-side Implementation

### Directory Structure

```
~/.pizzapi/
  services/                    # Tool Service definitions
    system-monitor/
      service.json             # Manifest
      monitor.js               # Entrypoint
  extensions/                  # Extension definitions
    system-monitor-ui/
      extension.json           # Manifest
      index.html               # UI entrypoint
      style.css                # Optional assets
```

### Service Manager

- Scans `~/.pizzapi/services/` on daemon startup.
- Spawns entrypoints as child processes with JSON-line stdio protocol.
- Health monitoring: restart on crash with exponential backoff (max 3, then mark failed).
- Demand-driven streaming: only active when subscribers exist.
- Reports service list to server on registration.

### Extension Manager

- Scans `~/.pizzapi/extensions/` on startup, registers with server.
- Watches directories with `fs.watch` for changes.
- On change: re-read manifest, bump version, notify server.
- Handles CRUD from agent API (create/update/delete extension files).

### Agent Authoring Tools

| Tool | Description |
|------|-------------|
| `create_extension(name, manifest, files)` | Write extension to disk, register |
| `update_extension(name, files)` | Update files, trigger hot-reload |
| `delete_extension(name)` | Remove from disk and registry |
| `list_extensions()` | Return available extensions |
| `list_services()` | Return available Tool Services |

These follow the same server → runner → server pattern as existing `create_agent`, `update_skill`, etc.

## 8. Error Handling

| Scenario | Handling |
|----------|----------|
| Tool Service crashes | Runner restarts with backoff (3 retries). Extensions get `ext:service-status: disconnected`. Marked failed after max retries. |
| Extension iframe errors | Contained by sandbox. Host shows error badge on tab. No leak to parent. |
| Runner disconnects | Server sends `ext_service_status: disconnected` for all services. Tabs show offline. Auto-restores on reconnect. |
| Invalid manifest | Rejected at registration. Runner logs error. Agent gets error from `create_extension`. |
| Undeclared service request | Host-side validation rejects postMessage. Extension gets `ext:query-error: not authorized`. |
| Hot-reload during active stream | Iframe reloads. Extension re-subscribes on init (SDK auto-reconnects). Brief data gap expected in v1. |

## 9. Testing Strategy

- **Protocol events:** Unit tests for new Socket.IO events in the protocol package (schema validation, routing).
- **Service Manager:** Unit tests for service lifecycle (spawn, health, restart, teardown). Mock child processes.
- **Extension Manager:** Unit tests for file watching, CRUD, version bumping.
- **postMessage bridge:** Unit tests for `ExtensionHost` component. jsdom/happy-dom for iframe simulation. Verify message validation, subscription scoping, theme forwarding.
- **Integration test:** Minimal `echo-service` + `echo-extension` proving the full loop.
- **Security test:** Verify iframe sandbox attributes. Verify undeclared subscriptions rejected. Verify CSP headers on extension assets.

## 10. V1 Scope Boundary

**In scope (v1):**
- Tool Service manifest, process management, stdio protocol
- Extension manifest, file-based + agent API authoring
- iframe rendering in CombinedPanel tabs
- postMessage data bridge (subscribe, query, theme)
- Trust tiers (user auto-load, agent approval gate)
- Hot-reload via fs watcher + version bump
- One example: system-monitor service + dashboard extension

**Out of scope (future):**
- Web Component extensions (v2 upgrade path)
- Extension marketplace / sharing
- `verified` trust tier with signing
- Resource monitoring for runaway iframes
- Extension-to-extension communication
- Extension access to session/conversation data
- Extension settings/configuration UI
