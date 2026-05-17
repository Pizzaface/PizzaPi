# Unified Extension System — Design Spec

**Status:** Design draft, pending spec review
**Date:** 2026-04-30
**Priority:** P1

---

## 1. Problem

PizzaPi currently has fragmented, incomplete extensibility across its three surfaces:

| Surface | Extensibility Today | Gaps |
|---------|-------------------|------|
| **Agent** | Skills, hooks (shell scripts), MCP servers, subagent definitions | No custom tools, no turn-hooks (PreToolUse/PostToolUse), no prompt injection hooks, no session lifecycle hooks |
| **Web UI** | Service panel iframes, sigil pills | No sidebar contributions, no session toolbar buttons, no custom routes, no inline components in session view, no notification channels |
| **Runner Services** | Folder-based services with iframe panels, triggers, and sigils | Boilerplate epidemic (30+ lines of relay helpers copied per service), no hot reload, file-based and plugin-manifest services are second-class (no metadata, panels, triggers, or sigils), errors invisible in UI, no service-to-service communication |

A full audit uncovered **42 capabilities** across 5 categories (agent, web UI, services, messaging, data & security). **30 don't exist today.**

The goal is a unified extension system where a single manifest can declare capabilities across all three surfaces, backed by a typed SDK and a central event bus for cross-surface communication.

---

## 2. Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│                      Extension Manifest                           │
│  manifest.json (id, label, icon, permissions, capabilities)       │
├────────────┬─────────────────────┬───────────────────────────────┤
│   Agent    │      Web UI         │        Services               │
│  tools.ts  │  panel.html         │  triggers / sigils             │
│  hooks.ts  │  sidebar config     │  background processes          │
│  prompts   │  toolbar buttons    │  event handlers                │
├────────────┴─────────────────────┴───────────────────────────────┤
│              Extension SDK (@pizzapi/extension-sdk)                │
│  defineExtension()  defineTool()  defineHook()  definePrompt()    │
│  ExtensionContext (typed: config, bus, storage, logger, sockets)   │
├───────────────────────────────────────────────────────────────────┤
│                       Event Bus (Relay Server)                     │
│  Publish / Subscribe / RPC — fire-and-forget + request-response   │
│  session:*  tool:*  ui:*  trigger:*  extension:*  storage:*       │
└───────────────────────────────────────────────────────────────────┘
```

### Key Principles

1. **Manifest-driven.** Every extension is a folder with `manifest.json`. Bare `.ts` files are deprecated.
2. **SDK-first.** `@pizzapi/extension-sdk` provides typed contracts. Plugin authors don't import internal daemon paths.
3. **Event bus foundation.** All cross-surface communication flows through the relay's typed event bus.
4. **Permissions gated.** Extensions declare required permissions. Project-local extensions require opt-in (like `allowProjectHooks`).
5. **Phased rollout.** Event bus (Phase 1) → Agent extensions (Phase 2) → Web UI extensions (Phase 3).

### 2.1 Extension Directory Layout

Extensions are folders with a `manifest.json` at the root. There are two layers:

1. **manifest.json** — Declarative identity and capability declarations (id, label, icon, permissions, which modules to load). The daemon reads this first for discovery and validation.
2. **index.ts** — Imperative entry point. Default-exports an `ExtensionDefinition` (created by calling `defineExtension()` from the SDK) or a legacy `ServiceHandler` for backward compatibility.

**How they relate:** The daemon reads `manifest.json` to populate `panelEntries` (labels, icons, panel metadata, trigger/sigil defs). It then imports `index.ts` (or the configured `entry`) to get the runtime handler. When using the SDK, `manifest.json` and the `defineExtension()` call should declare the same metadata — the manifest is the authority for discovery; the SDK call provides the runtime `init()` function and typed capability modules.

The daemon scans these directories:

| Directory | Scope | Trust |
|-----------|-------|-------|
| `~/.pizzapi/extensions/` | Global (all sessions on this runner) | Trusted — user explicitly installed |
| `<cwd>/.pizzapi/extensions/` | Project-local (sessions in this workspace) | Untrusted — requires opt-in (see §3.2) |

Each extension folder contains:

```
~/.pizzapi/extensions/<extension-id>/
  manifest.json       # Required — identity, permissions, capability declarations
  index.ts            # Optional — default-exported ExtensionDefinition (via defineExtension()) or legacy ServiceHandler
  tools.ts            # Optional — agent tool definitions (if agent.tools is set)
  hooks.ts            # Optional — lifecycle hook definitions (if agent.hooks is set)
  prompts.ts          # Optional — prompt injection definitions (if agent.prompts is set)
  routes.ts           # Optional — web UI route handlers (if ui.routes is set)
  panel/              # Optional — static UI assets (if ui.panel is set)
    index.html
```

The daemon discovers extensions at startup by scanning the directories above. Each directory containing a `manifest.json` is loaded as an extension. Extension IDs must match the folder name.

**Module loading:** TypeScript files (`.ts`) referenced in `manifest.json` (tools, hooks, prompts, routes) are loaded via Bun's native ESM `import()` using the daemon's built-in TypeScript transpiler. The import path is resolved relative to the extension folder. Module resolution follows standard ESM semantics — no special path mapping or bundling required.

---

## 3. Phase 0: Permissions & Security Model

**Must be implemented before any extension code executes user-visible behavior.**

### 3.1 Permission Declarations (G1)

Extensions declare permissions in `manifest.json`:

```json
{
    "id": "my-deployer",
    "label": "Vercel Deployer",
    "permissions": {
        "network": ["api.vercel.com"],
        "filesystem": { "read": true, "write": [".vercel", "vercel.json"] },
        "process": ["vercel", "git"],
        "sessions": { "read": true, "spawn": true, "inject": true },
        "storage": { "quota": "10mb" },
        "bus": { "publish": ["extension:*", "ui:*"], "subscribe": ["session:*", "trigger:*"] },
        "rateLimits": { "toolExecutions": 120, "busPublishes": 600 }
    }
}
```

| Permission | Controls |
|-----------|----------|
| `network` | Domains extension can reach (empty = none, `"*"` = all) |
| `filesystem` | Read/write paths relative to workspace roots |
| `process` | Allowed child process commands |
| `sessions` | Can read session list, spawn new sessions, inject messages |
| `storage` | KV store quota |
| `bus` | Which event types extension can publish and subscribe to |
| `rateLimits` | Per-operation rate limits (overrides defaults from §3.5) |

### 3.2 Trust Gates (G5)

| Extension location | Trust model |
|-------------------|-------------|
| `~/.pizzapi/extensions/` | **Trusted** — user explicitly installed. Full permissions granted on load. |
| `<cwd>/.pizzapi/extensions/` | **Untrusted** — requires `allowProjectExtensions: true` in `~/.pizzapi/config.json`. On first load, the daemon emits a `runner:extension_permission_prompt` bus event with the extension's manifest permissions. The user approves or denies via a web UI dialog (or CLI prompt if no web UI is connected). Denied extensions are skipped entirely (not loaded). If the manifest changes to request new permissions, the prompt re-triggers. The decision is persisted in `~/.pizzapi/extension-trust.json`. |
| `node_modules/` (npm package) | **Untrusted** — same as project-local. Extension IDs are derived from the package name (without version). Prompt on first load. |

### 3.3 Sandbox Enforcement (G2)

Extension code runs in the daemon process with the same privileges. Phase 0 enforces permissions at the SDK API boundary (not OS-level):

- `ctx.bash()` checks `permissions.process` allowlist by matching the first executable token (before any arguments) against the allowlist. Shell builtins (`cd`, `export`) are always allowed. Shell metacharacters (`&&`, `|`, `;`) are rejected unless the allowlist includes `"sh"` or `"bash"` (which grants full shell access).
- `ctx.fetch()` checks `permissions.network` allowlist by matching the URL hostname. Relative URLs and `localhost` are always allowed.
- `ctx.storage` enforces quota — writes exceeding quota throw `QuotaExceededError`.
- `ctx.publish()` / `ctx.subscribe()` check bus permissions.

Full OS sandboxing (Landlock on Linux, Seatbelt on macOS) is deferred beyond Phase 3.

### 3.4 Audit Logging (G4)

All extension actions are logged by the daemon:

```typescript
export interface ExtensionAuditEntry {
    timestamp: number;
    extensionId: string;
    action: string;        // e.g., "tool:executed", "bus:publish", "storage:set"
    details: Record<string, unknown>;
}
```

Audit log is write-only, retained in `~/.pizzapi/extension-audit.log`, rotated at 10MB.

### 3.5 Rate Limiting (G3)

Defaults per extension, overridable via `permissions.rateLimits` in manifest:

| Operation | Default limit | Manifest key |
|-----------|--------------|-------------|
| Tool executions | 60/min | `toolExecutions` |
| Bus publishes | 300/min | `busPublishes` |
| Storage reads/writes | 120/min | `storageOps` |
| Session spawns | 10/min | `sessionSpawns` |

### 3.6 Extension Lifecycle (Load / Unload / Reload)

**Load:** Extensions are loaded once at daemon startup (Phase 0). The daemon scans extension directories, validates manifests, checks permissions, and calls `init(ctx)`. If `init` resolves successfully, the extension is `"loaded"` and emits `extension:loaded` on the bus.

**Unload:** Extensions are unloaded when:
1. The extension folder is removed and the file watcher detects it (see §3.7)
2. The daemon receives a `/extensions unload <id>` command
3. The daemon is shutting down

On unload, the daemon calls the cleanup function returned by `init()`. In-flight tool calls are allowed to complete with a 5-second grace period. Bus subscriptions owned by the extension are removed. The extension emits `extension:unloaded`.

**Reload:** When a file watcher detects changes to the extension folder or its manifest, the daemon queues a pending reload. The reload is deferred to the next turn boundary (between `turn:ended` and the next `turn:started`) to avoid removing tools while the agent may be mid-turn and about to call them. If the daemon is idle (no active turns), the reload happens immediately. The `service_announce_delta` protocol message communicates the change to the UI.

A pending reload during an active turn is indicated in `serviceHealth` as `status: "loaded", message: "reload pending"`.

**Health transitions:**
- `"loaded"` → `"degraded"`: any unhandled rejection in a hook handler or per-turn prompt injector
- `"degraded"` → `"failed"`: three consecutive errors in the same hook/tool, or `init()` throws
- `"failed"` → `"loaded"`: successful reload
- `"disabled"`: manually disabled via `/extensions disable <id>` (persists across daemon restarts in config). Re-enabled via `/extensions enable <id>`.

**File watcher (§3.7):** The daemon watches extension directories for changes using `fs.watch` (recursive on the extension folder). Changes are debounced at 500ms. When detected, the extension is reloaded.

---

## 4. Phase 1: Event Bus

### 4.1 Protocol Types (additions to `shared.ts`)

```typescript
/** Who/what sent the event */
export interface BusEventSource {
    kind: "session" | "runner" | "ui" | "extension";
    id: string;
    label?: string;
}

/** Target routing */
export interface BusEventTarget {
    kind: "direct" | "broadcast";
    id?: string;            // sessionId or runnerId for "direct"
}

/** A single event on the bus */
export interface BusEvent {
    type: string;            // Namespace.type, e.g. "session:started", "tool:preUse"
    source: BusEventSource;
    target?: BusEventTarget;
    payload: Record<string, unknown>;
    timestamp: number;
    eventId: string;         // Crypto-random UUID — for deduplication

    /** RPC fields */
    correlationId?: string;  // Links request ↔ response
    kind?: "event" | "request" | "response" | "error";
    errorCode?: string;      // For "error" responses
}

/** Subscription filter */
export interface BusEventFilter {
    type: string;            // Exact match or prefix-wildcard, e.g. "session:*"
    sourceKind?: BusEventSource["kind"];
    sourceId?: string;
    broadcastOnly?: boolean;
}

export interface BusSubscription {
    subscriptionId: string;
    sessionId: string;
    filter: BusEventFilter;
    createdAt: number;
}
```

### 4.2 Relay Server — Endpoints

The relay handles bus traffic over existing Socket.IO connections:

```
// Publish an event
Client → relay: { type: "bus_publish", event: BusEvent }
Relay: validate source, check permissions, resolve matching subscriptions
Relay: reject events with payload exceeding 256KB (responds with error code `payload_too_large`)
Relay → matched subscribers: { type: "bus_event", event: BusEvent }

// Subscribe with filter
Client → relay: { type: "bus_subscribe", filter: BusEventFilter }
Relay: create subscription → { subscriptionId }

// Unsubscribe
Client → relay: { type: "bus_unsubscribe", subscriptionId: string }
Relay: remove subscription → { ok: true }

// List subscriptions
Client → relay: { type: "bus_list_subscriptions" }
Relay: return BusSubscription[]
```

Subscriptions are **server-authoritative** — the relay's subscription registry is the source of truth. On reconnect, subscriptions are rebuilt from the server snapshot (existing pattern from trigger reconciliation).

### 4.3 Event Type Catalog (Phase 1)

**Session lifecycle** (emitted by daemon):
- `session:starting` — before agent loop begins
- `session:started` — agent loop running
- `session:ended` — agent loop stopped cleanly
- `session:error` — fatal error / crash
- `session:message` — agent-to-agent messages (M1)

**Turn lifecycle** (emitted by daemon/agent):
- `turn:started` — agent begins processing user input
- `turn:ended` — agent produces final response
- `tool:preUse` — before tool execution (A2)
- `tool:postUse` — after tool execution (A2)
- `tool:error` — tool execution failed

**UI actions** (emitted by relay from web client):
- `ui:action` — user clicked button, entered command (M3)
- `ui:navigate` — user navigated to route
- `ui:notification` — agent-triggered UI notification (M4)

**Extension lifecycle** (emitted by daemon):
- `extension:loaded` — extension successfully loaded
- `extension:unloaded` — extension removed
- `extension:error` — extension health change (health update)

**Trigger events** (emitted by services):
- `trigger:<service-id>:<type>` — service-specific triggers, e.g. `trigger:github:pr_created` (S2)

### 4.4 RPC Pattern (M7)

Extensions can make request-response calls over the bus:

```typescript
// SDK helper
interface ExtensionContext {
    request(type: string, payload: Record<string, unknown>, opts?: {
        timeoutMs?: number;        // default 30s
        targetSessionId?: string;
    }): Promise<BusEvent>;
}
```

**Flow:**
1. Requester publishes `{ kind: "request", correlationId: "abc", type: "git:status", ... }`
2. Responder subscribes to `git:status`, receives request
3. Responder publishes `{ kind: "response", correlationId: "abc", type: "git:status", payload: {...} }`
4. Requester's SDK resolves the promise with the response event
5. On timeout: requester rejects with `TimeoutError`. The daemon publishes a synthetic `{ kind: "error", errorCode: "timeout" }` response on the bus — the responder's subscription for that correlationId sees the error and the SDK cleans up the one-shot subscription automatically.

**Standard system RPC endpoints:**

| Endpoint | Responder | Request | Response |
|----------|-----------|---------|----------|
| `runner:list_sessions` | daemon | `{}` | `{ sessions: RunnerSession[] }` |
| `runner:get_config` | daemon | `{ key?: string }` | `{ config }` |
| `runner:spawn_session` | daemon | `{ prompt, model? }` | `{ sessionId }` |
| `storage:get` | daemon | `{ key }` | `{ value }` |
| `storage:set` | daemon | `{ key, value }` | `{ ok }` |
| `storage:delete` | daemon | `{ key }` | `{ ok }` |

### 4.5 ServiceTriggerDef Changes

`ServiceTriggerDef` gains a `serviceId` field stamped by the daemon during aggregation. This replaces the fragile convention of parsing `:` from trigger type strings:

```typescript
export interface ServiceTriggerDef {
    type: string;
    label: string;
    serviceId: string;     // NEW — stamped by daemon
    description?: string;
    schema?: Record<string, unknown>;
    params?: ServiceTriggerParamDef[];
}
```

### 4.6 ServiceAnnounceData — Add Health & Errors

```typescript
export interface ServiceAnnounceData {
    serviceIds: string[];
    panels?: ServicePanelInfo[];
    triggerDefs?: ServiceTriggerDef[];
    sigilDefs?: ServiceSigilDef[];

    // NEW
    serviceHealth?: Record<string, ServiceHealth>;
    loadErrors?: ServiceLoadError[];
}
```

```typescript
export interface ServiceHealth {
    status: "loaded" | "degraded" | "failed" | "disabled";
    message?: string;
    loadedAt?: number;
}

export interface ServiceLoadError {
    serviceId: string;
    path: string;
    code: "manifest_invalid" | "entry_missing" | "module_import_failed" |
          "invalid_handler" | "duplicate_id" | "timeout";
    message: string;
}
```

---

## 5. Phase 2: Agent Extensions

Extensions register into the agent loop through `manifest.json`:

```json
{
    "agent": {
        "tools": "./tools.ts",
        "hooks": "./hooks.ts",
        "prompts": "./prompts.ts"
    }
}
```

### 5.1 Custom Tools (A1)

```typescript
// tools.ts
import { defineTool } from "@pizzapi/extension-sdk";

export default [
    defineTool({
        name: "deploy_to_vercel",
        description: "Deploy the current project to Vercel. Use when the user asks to deploy.",
        schema: {
            type: "object",
            properties: {
                projectName: { type: "string", description: "Vercel project name" },
                env: { type: "string", enum: ["production", "preview"] },
            },
            required: ["projectName"],
        },
        async handler(params, ctx) {
            const result = await ctx.bash(`vercel deploy --prod ${params.projectName}`);
            return { ok: true, url: result.stdout.trim() };
        },
    }),
];
```

**Registration:** The daemon merges extension tools with built-in tools. They appear in the tool list, are callable by the agent, and stream output back through the existing tool execution pipeline.

**Naming:** Extension tools are namespaced: `extension:<extension-id>:<tool-name>`. The agent prompt lists them with their namespace for disambiguation.

**Tool result format:** Tool handlers return arbitrary JSON-serializable values. The daemon passes the result through the existing pi agent tool execution pipeline, which JSON-stringifies the return value and presents it to the model as the tool output. Standard convention: return `{ ok: true, ... }` for success, `{ ok: false, error: "..." }` for failures.

**Permissions check:** Tool execution validates against `permissions.process` and `permissions.network` before running.

**Module loading:** When `manifest.json` declares `agent.tools: "./tools.ts"`, the daemon uses `import(join(extensionDir, "./tools.ts"))` at extension load time. Bun's built-in TypeScript transpiler handles `.ts` files natively — no build step required. The module's default export must be an array of `ToolDefinition` objects. Module resolution follows standard ESM semantics relative to the extension folder.

### 5.2 Lifecycle Hooks (A2-A4)

```typescript
// hooks.ts
import { defineHook } from "@pizzapi/extension-sdk";

export default [
    defineHook({
        event: "tool:preUse",
        priority: 50,
        async handler(event, ctx) {
            // Inspect or block tool calls
            if (event.payload.toolName === "bash") {
                const cmd = event.payload.args.command;
                if (cmd.includes("rm -rf /")) {
                    return { allow: false, reason: "Dangerous command blocked" };
                }
            }
            return { allow: true };
        },
    }),
    defineHook({
        event: "tool:postUse",
        priority: 100,
        handler(event, ctx) {
            // Log all tool usage
            ctx.logger.info(`Tool ${event.payload.toolName} completed`);
            return { allow: true };
        },
    }),
    defineHook({
        event: "session:started",
        handler(event, ctx) {
            ctx.logger.info(`Extension active in session ${event.source.id}`);
        },
    }),
];
```

**Execution order:**
1. Built-in hooks run first (priority 0-9)
2. Extensions run in priority order (lowest first, within same priority = registration order)
3. A hook returning `{ allow: false }` halts the chain; subsequent hooks don't run

**Exception handling:** If a hook handler throws an unhandled exception, the error is caught by the daemon, logged, and the extension transitions to `"degraded"` health status. For `tool:preUse` hooks: a thrown exception is treated as `{ allow: false, reason: "hook error" }` — the tool call is BLOCKED for safety. For all other hook events (`tool:postUse`, `session:*`, `turn:*`): the exception is logged but the chain continues to the next hook.

**Supported hook events:**
- `tool:preUse` — before any tool executes (can block/modify). The `allow` field controls execution.
- `tool:postUse` — after tool executes (read-only). The `allow` field is ignored — always treated as true.
- `session:started` — agent loop initialized (read-only). `allow` is ignored.
- `session:ended` — agent loop shutting down (read-only). `allow` is ignored.
- `turn:started` — before agent processes input (read-only). `allow` is ignored.
- `turn:ended` — after agent produces response (read-only). `allow` is ignored.

### 5.3 Prompt Injection (A5)

```typescript
// prompts.ts
import { definePrompt } from "@pizzapi/extension-sdk";

export default [
    definePrompt({
        inject: "system",          // appended to system prompt
        priority: 15,
        content: "You have access to the deploy_to_vercel tool. Use it when deploying.",
    }),
    definePrompt({
        inject: "per_turn",        // refreshed each turn
        async content(ctx) {
            const status = await ctx.request("git:status", { cwd: process.cwd() });
            return `Current branch: ${status.payload.branch}, changes: ${status.payload.changes.length}`;
        },
    }),
];
```

Injection points:
- `system` — appended to the built-in system prompt (after `appendSystemPrompt`). Ordered by `priority`.
- `per_turn` — injected before the user's message at the start of each assistant turn, as a system-level context message. The model sees it as additional context preceding the user's actual input. Refreshed each turn (supports async content functions).

### 5.4 Extension KV Storage (D1)

```typescript
// Accessible via ExtensionContext
interface ExtensionContext {
    storage: {
        get(key: string): Promise<unknown | undefined>;
        set(key: string, value: unknown): Promise<void>;
        delete(key: string): Promise<void>;
        list(prefix?: string): Promise<string[]>;
    };
}
```

**Implementation:** Backed by a SQLite table in the daemon's state directory (`~/.pizzapi/extension-storage.db`). Scoped per extension ID. Quota enforced (default 10MB, configurable in manifest `permissions.storage.quota`).

Keys are extension-scoped — extension A cannot read extension B's keys.

---

## 6. Phase 3: Web UI Extensions

Extensions declare UI contributions in `manifest.json`:

```json
{
    "ui": {
        "panel": { "dir": "./panel" },
        "sidebar": { "label": "Deployments", "icon": "rocket", "route": "/ext/my-deployer/dashboard" },
        "sessionToolbar": [{ "label": "Deploy", "icon": "rocket", "command": "deploy" }],
        "routes": "./routes.ts"
    }
}
```

### 6.1 Sidebar Items (W2)

Extensions declare sidebar entries with label, icon, optional badge (dynamically updated via event bus), and route:

```typescript
export interface SidebarItem {
    label: string;
    icon: string;           // Lucide icon name
    badge?: {
        source: string;     // event type to subscribe for count, e.g. "extension:deployment_count"
    };
    route: string;          // /ext/<id>/<path>
}
```

The UI renders sidebar items from `ExtensionAnnounceData.ui.sidebar[]`. Badge counts update via bus subscriptions when the source event fires.

### 6.2 Session Toolbar (W3)

Buttons rendered in the session view header. When clicked, the UI publishes a `ui:action` event targeting the current session:

```typescript
export interface ToolbarButton {
    label: string;
    icon: string;
    command: string;        // published as ui:action with { command }
}
```

The agent session receives this as an injected message (via existing trigger delivery mechanism).

### 6.3 Custom Routes (W4)

Extensions serve their UI from their panel HTTP server (the same `Bun.serve()` instance used for the iframe panel, if any). If the extension has no panel, it spins up an HTTP server solely for routes and API endpoints:

```typescript
// routes.ts
import { defineRoute } from "@pizzapi/extension-sdk";

export default [
    defineRoute({
        path: "/dashboard",
        handler(req) {
            return new Response(dashboardHtml, {
                headers: { "Content-Type": "text/html; charset=utf-8" },
            });
        },
    }),
    defineRoute({
        path: "/api/stats",
        handler(req) {
            return Response.json({ deployed: 42, failed: 3 });
        },
    }),
];
```

**Hosting model:** The daemon aggregates route handlers into the extension's HTTP server. The extension calls `ctx.announcePanel(port)` (if it has a panel) or `ctx.announceSigilServer(port)` (panel-less). Route handlers register on that server's `fetch` handler alongside any panel HTML serving and API endpoints.

The web UI router has a catch-all: `/ext/:extensionId/*` proxies to the extension's panel HTTP server via the existing tunnel proxy. Route paths declared in `routes.ts` are relative to `/ext/<extensionId>`.

### 6.4 Iframe Panels (W1, existing)

No changes. Folder-based extensions with `panel.dir` serve their panel content via `Bun.serve()` and `ctx.announcePanel(port)`. The existing 280px iframe grid in the web UI continues to work.

### 6.5 Inline Session View Components (W7) — Deferred to Phase 3b

Inline session components are architecturally novel (postMessage bridge, auto-resize, match-on-event semantics) and are deferred to Phase 3b. The sidebar, toolbar, and route surfaces ship first in Phase 3.

### 6.6 Web UI Extension Announce Protocol

Extension UI contributions (sidebar items, toolbar buttons, routes, inline components) are communicated to web clients via the existing `service_announce` protocol event. The `ServiceAnnounceData` payload is extended with a `ui` field:

```typescript
export interface ServiceAnnounceData {
    serviceIds: string[];
    panels?: ServicePanelInfo[];
    triggerDefs?: ServiceTriggerDef[];
    sigilDefs?: ServiceSigilDef[];
    serviceHealth?: Record<string, ServiceHealth>;
    loadErrors?: ServiceLoadError[];

    /** NEW — UI contributions from all loaded extensions */
    ui?: ExtensionUIContributions;
}

/**
 * NOTE: ServiceAnnounceDelta (§4.2) is extended with matching `added.ui`,
 * `removed.ui`, and `updated.ui` fields carrying partial UI contribution
 * changes. Similarly, `added.serviceHealth` / `removed.serviceHealth`
 * carry health updates. The full delta schema mirrors the announce schema.
 */

export interface ExtensionUIContributions {
    sidebar: SidebarItem[];
    sessionToolbar: ToolbarButton[];
    routes: { extensionId: string; paths: string[] }[];
    inlineComponents: InlineComponent[];
}
```

The daemon aggregates UI contributions from all loaded extensions and includes them in `service_announce`. Web UI clients receive this over the same Socket.IO connection they use for session data. On extension load/unload/reload, a `service_announce_delta` carries only the changed contributions.

### 6.7 Toast / Alert Notifications (W11)

Extensions can trigger transient notifications in the web UI:

```typescript
// From agent or extension code
ctx.publish({
    type: "ui:toast",
    source: { kind: "extension", id: "deployer" },
    target: { kind: "broadcast" },
    payload: {
        level: "success",               // "info" | "success" | "warning" | "error"
        title: "Deploy complete",
        message: "v2.3.1 deployed to production",
        duration: 5000,                 // auto-dismiss ms (0 = sticky)
        action: { label: "View", route: "/ext/deployer/history/42" },
    },
});
```

The UI's toast system subscribes to `ui:toast` and renders them using the existing shadcn/ui toast component.

---

## 7. SDK Package: `@pizzapi/extension-sdk`

### 7.1 Package location

New package at `packages/extension-sdk/` alongside existing packages (`cli`, `server`, `ui`, `tools`, `protocol`).

### 7.2 Exports

```typescript
// ── Extension definition ──
export function defineExtension(config: ExtensionConfig): ExtensionDefinition;

/** Opaque token returned by defineExtension(). Wrapped into ServiceHandler by the daemon. */
export interface ExtensionDefinition {
    readonly __brand: "ExtensionDefinition";
    id: string;
    manifest: ExtensionConfig;
    init(ctx: ExtensionContext): Promise<void | (() => void)>;
    /** Cleanup function returned by init(), if any. Called on unload. */
    cleanup?: () => void;
}

/**
 * defineExtension() wraps ExtensionConfig into an ExtensionDefinition.
 * It normalizes the init function (always returns Promise), wires up
 * permission checks, emits extension:loaded on success, and stores the
 * cleanup function for the daemon to call on unload.
 */

export interface ExtensionPermissions {
    network?: string[];
    filesystem?: { read?: boolean; write?: string[] };
    process?: string[];
    sessions?: { read?: boolean; spawn?: boolean; inject?: boolean };
    storage?: { quota?: string };
    bus?: { publish?: string[]; subscribe?: string[] };
    rateLimits?: {
        toolExecutions?: number;
        busPublishes?: number;
        storageOps?: number;
        sessionSpawns?: number;
    };
}

export interface ExtensionConfig {
    id: string;
    label: string;
    icon?: string;
    permissions?: ExtensionPermissions;  // see above

    agent?: {
        tools?: string;      // path to tools module
        hooks?: string;      // path to hooks module
        prompts?: string;    // path to prompts module
    };

    ui?: {
        panel?: { dir: string };
        sidebar?: SidebarItem[];          // array — extensions can declare multiple sidebar items
        sessionToolbar?: ToolbarButton[];
        routes?: string;     // path to routes module
        inlineComponents?: InlineComponent[];
    };

    init(ctx: ExtensionContext): void | (() => void) | Promise<void | (() => void)>;
}

// ── Extension context ──
export interface ExtensionContext {
    // Identity & config
    runnerId: string;
    apiKey: string;
    relayUrl: string;
    config: PizzaPiConfig;

    // Event bus
    publish(event: Omit<BusEvent, "eventId" | "timestamp">): Promise<void>;
    subscribe(filter: BusEventFilter, handler: (event: BusEvent) => void): () => void;
    request(type: string, payload: Record<string, unknown>, opts?: {
        timeoutMs?: number;
        targetSessionId?: string;
    }): Promise<BusEvent>;

    // Panel / sigil server
    announcePanel(port: number): void;
    announceSigilServer(port: number): void;

    // Session control
    spawnSession(prompt: string, opts?: { model?: { provider: string; id: string } }): Promise<string>;
    /** Inject a message into an agent session's conversation (requires sessions.inject permission). */
    sendToSession(sessionId: string, message: string): Promise<void>;

    // Storage
    storage: ExtensionStorage;

    // Execution
    bash(command: string, opts?: { cwd?: string; timeout?: number }): Promise<{ stdout: string; stderr: string }>;
    fetch(url: string, init?: RequestInit): Promise<Response>;

    // Logging
    logger: Logger;
}

/** Shape of PizzaPi's config (from ~/.pizzapi/config.json). Re-exported from protocol. */
export interface PizzaPiConfig {
    relayUrl?: string;
    appendSystemPrompt?: string;
    allowProjectHooks?: boolean;
    allowProjectExtensions?: boolean;
    [key: string]: unknown;
}

/** KV store interface. Backed by SQLite in the daemon. */
export interface ExtensionStorage {
    get(key: string): Promise<unknown | undefined>;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
    list(prefix?: string): Promise<string[]>;
}

// ── Tool definition ──
export function defineTool(config: ToolConfig): ToolDefinition;

export interface ToolConfig {
    name: string;
    description: string;
    schema: Record<string, unknown>;   // JSON Schema for params
    handler(params: Record<string, unknown>, ctx: ToolContext): Promise<unknown>;
}

/** Context passed to tool handlers. Subset of ExtensionContext scoped to the tool invocation. */
export interface ToolContext {
    bash(command: string, opts?: { cwd?: string; timeout?: number }): Promise<{ stdout: string; stderr: string }>;
    fetch(url: string, init?: RequestInit): Promise<Response>;
    logger: Logger;
    config: PizzaPiConfig;
    request(type: string, payload: Record<string, unknown>, opts?: {
        timeoutMs?: number;
    }): Promise<BusEvent>;
    /**
     * KV storage intentionally omitted from ToolContext.
     * Tools are stateless by design — persistent state belongs in
     * init() lifecycle or per-turn prompt injection. Tools that need
     * scratch data use the bash tool's filesystem or return values.
     */
}

// ── Hook definition ──
export function defineHook(config: HookConfig): HookDefinition;

export interface HookConfig {
    event: "tool:preUse" | "tool:postUse" | "session:started" | "session:ended" | "turn:started" | "turn:ended";
    priority?: number;  // default 50, lower = earlier
    handler(event: BusEvent, ctx: ExtensionContext): Promise<{ allow: boolean; reason?: string }>;
}

// ── Prompt definition ──
export function definePrompt(config: PromptConfig): PromptDefinition;

export interface PromptConfig {
    inject: "system" | "per_turn";
    priority?: number;
    content: string | ((ctx: ExtensionContext) => Promise<string>);
}

// ── Route definition ──
export function defineRoute(config: RouteConfig): RouteDefinition;

export interface RouteConfig {
    path: string;
    handler(req: Request): Response | Promise<Response>;
}

// ── Test utilities ──
export function createTestContext(overrides?: Partial<ExtensionContext>): ExtensionContext;
/** Creates an in-memory test bus for unit testing. Returns a mock publish/subscribe system with an events array for assertions. */
export function createTestBus(): {
    publish(event: Omit<BusEvent, "eventId" | "timestamp">): Promise<void>;
    subscribe(filter: BusEventFilter, handler: (event: BusEvent) => void): () => void;
    /** Accumulated events published through this test bus. */
    events: BusEvent[];
};
```

### 7.3 ExtensionDefinition → ServiceHandler Bridge

The SDK's `defineExtension()` returns an `ExtensionDefinition` that the daemon's `service-loader.ts` wraps into a `ServiceHandler`. This is backward-compatible — all existing services can be incrementally migrated to the SDK:

```typescript
// Internal bridge (in daemon, not user-facing)
function extensionToServiceHandler(def: ExtensionDefinition): ServiceHandler {
    return {
        id: def.id,
        async init(socket, options) {
            const ctx = buildExtensionContext(socket, options, def);
            await def.init(ctx);
        },
        dispose() {
            def.cleanup?.();
        },
    };
}
```

---

## 8. Manifest Changes — Migration

### 8.1 File-based services: deprecated

Bare `.ts`/`.js` files in `~/.pizzapi/services/` generate a **deprecation warning** in daemon logs and a `ServiceLoadError` in the protocol. They still load (for backward compatibility) but have no metadata, panels, triggers, or sigils.

Migration path: wrap the file in a folder with `manifest.json`.

### 8.2 Plugin-manifest services: upgraded

Services declared in `pizzapi.services` inside `package.json` or plugin `manifest.json` now support a `manifest` field pointing to a service manifest file:

```json
{
    "pizzapi": {
        "services": [
            {
                "entry": "./services/deployer.js",
                "manifest": "./services/manifest.json"
            }
        ]
    }
}
```

This gives plugin-bundled services full metadata, panels, triggers, and sigils — matching folder-based services.

### 8.3 ID override wrapper: fixed

The wrapper in `service-loader.ts` that overrides `ServiceHandler.id` from a plugin manifest declaration no longer drops `reconcileSubscriptions` (the optional lifecycle method on `ServiceHandler` that rebuilds per-subscription runtime state after reconnect):

```typescript
// Before (broken): only forwards init, dispose
// After (fixed): forwards ALL ServiceHandler methods
const wrappedHandler: ServiceHandler = new Proxy(handler, {
    get(target, prop) {
        if (prop === "id") return decl.id;
        return Reflect.get(target, prop);
    },
});
```

---

## 9. Implementation Phases

### Phase 0: Permissions & Security
- Manifest `permissions` field schema and validation
- `allowProjectExtensions` config gate
- SDK API permission checks (bash, fetch, publish, subscribe, storage)
- Audit logging infrastructure
- Rate limiter

### Phase 1: Event Bus
- Protocol types (`BusEvent`, `BusEventFilter`, `BusSubscription`)
- Relay server: publish, subscribe, unsubscribe, list endpoints
- Standard lifecycle events (session:*, tool:*, extension:*)
- RPC request/response pattern with timeout
- `ServiceTriggerDef.serviceId` field
- `ServiceAnnounceData` health/error fields
- Deprecation warning for file-based services

### Phase 2: Agent Extensions
- `@pizzapi/extension-sdk` package scaffold
- `defineExtension()`, `ExtensionContext`, `defineTool()`, `defineHook()`, `definePrompt()`
- Tool registration and execution pipeline
- Hook registration and priority-based execution chain
- Prompt injection (system + per_turn)
- KV storage (SQLite backend, quotas)
- Test utilities (`createTestContext`, `createTestBus`)

### Phase 3: Web UI Extensions
- Sidebar items from extension announce data
- Session toolbar buttons → `ui:action` events
- Custom route proxying (`/ext/:extensionId/*`) via panel HTTP server
- Toast/alert notifications via `ui:toast` events
- Extension health grid in services panel UI

---

## 10. Risks & Open Questions

| Risk | Mitigation |
|------|-----------|
| Event bus relay load with many subscribers | Server-side filtering; subscriptions are per-session, not per-agent-turn |
| Permissions model too coarse | Start with allowlist model; add scoped permissions later |
| SDK versioning vs daemon version drift | SDK is a separate package; daemon validates SDK version at extension load time |
| Migration breaking existing services | All existing services are wrapper-compatible; migration is opt-in |
| TUI surface not covered | TUI extensions deferred beyond Phase 3. Extension tools/hooks/prompts ARE visible in TUI sessions (same agent loop). Only web UI contributions (sidebar, toolbar, routes, toasts) are web-only. |
| Dynamic tool refresh dependency | Relies on upstream `pi-agent-core` patch (see `patches/README.md`) that refreshes tools/system prompt on turn boundaries. Without this patch, extension load/unload during active sessions won't take effect until session restart. |
| Multiple web clients | Broadcast events (`ui:toast`, `ui:notification`) deliver to ALL connected web clients viewing the same runner. Sidebar items and toolbar buttons render identically on every client. |
| Event bus durability | Events are ephemeral — no persistence across relay restarts. Services that rely on `session:started` to set up state must handle missing events (daemon re-emits `session:started` for all active sessions on reconnect). |
| In-flight tool abort on unload | After the 5-second grace period expires, in-flight tool calls from the unloaded extension are aborted. The agent receives an error result: `{ ok: false, error: "Extension unloaded" }`. The model can recover by asking the user or trying an alternative approach. |

---

## 11. References

- [Event-Driven Plugin System (2026-03-18)](./2026-03-18-event-driven-plugin-system-design.md) — predecessor design
- [Sigils Design (2026-03-29)](./2026-03-29-sigils-design.md) — sigil system design
- [Plugin Service Panels (2026-03-25)](./2026-03-25-plugin-service-panels-design.md) — panel iframe design
- [Creating Runner Services Skill](../../packages/cli/src/skills/creating-runner-services/SKILL.md)
- [Runner Services Docs](../../packages/docs/src/content/docs/customization/runner-services.mdx)
- `packages/cli/src/runner/service-handler.ts` — ServiceHandler interface
- `packages/cli/src/runner/service-loader.ts` — service discovery
- `packages/protocol/src/shared.ts` — protocol types
