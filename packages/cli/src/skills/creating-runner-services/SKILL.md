---
name: creating-runner-services
description: Use when building a new runner service — background processes with optional UI panels, custom triggers agents can subscribe to, or sigils that render inline references in the UI
---

# Creating Runner Services

Runner services are background processes on the runner daemon. They can:

- **Expose a UI panel** — an iframe in the PizzaPi web interface (no React needed)
- **Advertise custom triggers** — agents discover and subscribe to them at runtime
- **Define sigils** — teach the UI how to render `[[type:id]]` inline references
- **Fire triggers** — broadcast events to all subscribed agent sessions via the relay API

## Folder Structure

```
~/.pizzapi/services/<service-name>/
  manifest.json       # Required — core identity (id, label, icon, entry, panel)
  triggers.json       # Optional — trigger definitions (overrides manifest.triggers)
  sigils.json         # Optional — sigil type definitions (overrides manifest.sigils)
  index.ts            # ServiceHandler module (default export)
  panel/              # Optional — only needed if the service has a UI panel
    index.html        # Self-contained UI (HTML/CSS/JS)
    ...               # Any additional static assets
```

## manifest.json

```json
{
  "id": "my-service",
  "label": "My Service",
  "icon": "activity",
  "entry": "./index.ts",
  "panel": {
    "dir": "./panel"
  },
  "triggers": [
    {
      "type": "my-service:something_happened",
      "label": "Something Happened",
      "description": "Emitted when something noteworthy occurs",
      "schema": {
        "type": "object",
        "properties": {
          "itemId": { "type": "string" },
          "timestamp": { "type": "number" }
        }
      },
      "params": [
        {
          "name": "itemId",
          "label": "Item ID",
          "type": "string",
          "description": "Only receive events for this specific item",
          "required": false
        }
      ]
    }
  ],
  "sigils": [
    {
      "type": "item",
      "label": "Item",
      "description": "Reference an item from My Service",
      "resolve": "/api/resolve/item/{id}"
    }
  ]
}
```

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `id` | Yes | | Unique service ID (must match `ServiceHandler.id`) |
| `label` | Yes | | Button label shown in the PizzaPi header bar |
| `icon` | No | `"square"` | [Lucide](https://lucide.dev/icons) icon name (kebab-case) |
| `entry` | No | `./index.ts` | Service module path relative to folder |
| `panel.dir` | No | `./panel` | Panel static files directory (omit if no panel) |
| `triggers` | No | `[]` | Array of trigger type definitions (see below). Can also live in `triggers.json`. |
| `sigils` | No | `[]` | Array of sigil type definitions (see below). Can also live in `sigils.json`. |

### Trigger Definitions

Each entry in `triggers` declares a trigger type this service can emit:

| Field | Required | Description |
|-------|----------|-------------|
| `type` | Yes | Namespaced trigger type, e.g. `"my-service:event_name"` |
| `label` | Yes | Human-readable label for the UI and agent tools |
| `description` | No | When/why this trigger fires |
| `schema` | No | JSON Schema describing the trigger payload |
| `params` | No | Array of configurable parameters for subscriber filtering (see below) |

### Trigger Parameters

Triggers can declare **params** — configurable values that subscribers provide when subscribing. At broadcast time, delivery is filtered: a subscriber only receives the trigger if every param they specified matches the corresponding field in the trigger payload. Subscribers with no params receive all events (wildcard).

Each entry in `params`:

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Parameter name — must match a key in the trigger payload |
| `label` | Yes | Human-readable label for the UI |
| `type` | No | Value type: `"string"` (default), `"number"`, `"boolean"`, or `"json"` |
| `description` | No | Help text for the subscriber |
| `required` | No | If `true`, subscriber must provide this param |
| `default` | No | Default value if not provided |
| `enum` | No | Array of allowed values — renders as a dropdown in the UI |
| `multiselect` | No | If `true` (requires `enum`), subscriber can pick multiple values. Subscribers send an actual JSON array, the UI renders selected values as chips, and delivery matches if the payload value is **in** the selected set (OR semantics). |
+
+Use `type: "json"` when the subscription param should carry an arbitrary JSON value such as an object or array. The UI renders a JSON textarea for these params and forwards the parsed value to the service unchanged.

**Example — scalar param with enum:**

```json
{
  "type": "github:pr_comment_added",
  "label": "PR Comment Added",
  "params": [
    { "name": "prNumber", "label": "PR Number", "type": "number", "required": true },
    { "name": "repo", "label": "Repository", "type": "string", "enum": ["pizzapi", "pi-mono", "docs"] }
  ]
}
```

An agent subscribes with: `subscribe_trigger(triggerType: "github:pr_comment_added", params: { prNumber: 42, repo: "pizzapi" })`

Only events with `prNumber: 42` **and** `repo: "pizzapi"` in their payload are delivered.

**Example — JSON param:**

```json
{
  "type": "review:requested",
  "label": "Review Requested",
  "params": [
    { "name": "config", "label": "Config", "type": "json", "description": "Arbitrary review routing config" }
  ]
}
```

An agent subscribes with: `subscribe_trigger(triggerType: "review:requested", params: { config: { reviewers: ["jordanpizza"], labels: ["bug"], dryRun: true } })`

The service receives the parsed object exactly as provided.

**Example — multiselect param:**

```json
{
  "type": "demo:message_sent",
  "label": "Message Sent",
  "params": [
    { "name": "channel", "label": "Channels", "type": "string", "enum": ["general", "alerts", "debug"], "multiselect": true }
  ]
}
```

An agent subscribes with: `subscribe_trigger(triggerType: "demo:message_sent", params: { channel: ["alerts", "debug"] })`

Events with `channel: "alerts"` **or** `channel: "debug"` in their payload are delivered. Events with `channel: "general"` are not. Sessions subscribed without specifying `channel` receive all events.

**Important contract:**
- `multiselect` only works when `enum` is also declared
- subscribers send a real JSON array, not a comma-separated string
- matching is currently **subscriber array vs payload scalar** (`params.channel = ["alerts", "debug"]` matches payload `channel: "alerts"`)
- array-valued payload fields also work with scalar subscription params: if the payload has `labels: ["bug", "urgent"]`, a subscriber with `labels: "bug"` receives the event
- if you need arbitrary freeform lists (for example usernames not known ahead of time), `multiselect` is the wrong fit today unless you can declare those values in `enum`

For substring filtering, name the param with a `Contains` suffix. For example, a trigger with `bodyContains` will match when the payload's `body` field includes the subscriber's text.

Trigger types are advertised to agents via `service_announce` so they can be discovered with `list_available_triggers()` and subscribed to with `subscribe_trigger()`.

> **Split file note:** Triggers can live in a separate `triggers.json` file (bare array or `{ "triggers": [...] }` format). When `triggers.json` exists, it takes precedence over inline `triggers` in `manifest.json`.

## sigils.json

Define sigil types the service teaches the UI to render as `[[type:id]]` inline tokens.
Can be a bare array or wrapped in `{ "sigils": [...] }`.

```json
[
  {
    "type": "pr",
    "label": "Pull Request",
    "description": "A GitHub pull request reference",
    "resolve": "/api/resolve/pr/{id}",
    "aliases": ["pull-request", "mr"]
  },
  {
    "type": "commit",
    "label": "Commit",
    "resolve": "/api/resolve/commit/{id}"
  }
]
```

| Field | Required | Description |
|-------|----------|-------------|
| `type` | Yes | Sigil type name used in `[[type:id]]` syntax |
| `label` | Yes | Human-readable label for the UI |
| `description` | No | What this sigil represents |
| `resolve` | No | API path to resolve a sigil ID to display data (e.g. PR number → title) |
| `schema` | No | JSON Schema for valid sigil params |
| `aliases` | No | Alternative type names that resolve to this sigil |

When `sigils.json` exists, it takes precedence over inline `sigils` in `manifest.json`.

## ServiceHandler Template

```typescript
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import type { Server } from "bun";

// ── Relay helpers (needed for firing triggers) ────────────────────────────

function readRunnerId(): string | null {
    try {
        const home = process.env.HOME || homedir();
        const raw = JSON.parse(readFileSync(join(home, ".pizzapi", "runner.json"), "utf-8"));
        return typeof raw?.runnerId === "string" ? raw.runnerId : null;
    } catch { return null; }
}

function resolveRelayUrl(): string {
    const home = process.env.HOME || homedir();
    let raw = process.env.PIZZAPI_RELAY_URL?.trim();
    if (!raw) {
        try {
            const cfg = JSON.parse(readFileSync(join(home, ".pizzapi", "config.json"), "utf-8"));
            if (typeof cfg?.relayUrl === "string" && cfg.relayUrl !== "off") raw = cfg.relayUrl.trim();
        } catch { /* ignore */ }
    }
    raw = raw || "http://localhost:7492";
    if (raw.startsWith("ws://"))  return raw.replace(/^ws:/, "http:").replace(/\/$/, "");
    if (raw.startsWith("wss://")) return raw.replace(/^wss:/, "https:").replace(/\/$/, "");
    return raw.replace(/\/$/, "");
}

function getApiKey(): string | null {
    return process.env.PIZZAPI_RUNNER_API_KEY ?? process.env.PIZZAPI_API_KEY ?? null;
}

/** Broadcast a trigger to all subscribed sessions on this runner. */
async function broadcastTrigger(
    type: string,
    payload: Record<string, unknown>,
    opts?: { deliverAs?: "steer" | "followUp"; summary?: string },
): Promise<void> {
    const runnerId = readRunnerId();
    const apiKey = getApiKey();
    if (!runnerId || !apiKey) return;

    await fetch(`${resolveRelayUrl()}/api/runners/${runnerId}/trigger-broadcast`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": apiKey },
        body: JSON.stringify({
            type,
            payload,
            source: "my-service",
            deliverAs: opts?.deliverAs ?? "followUp",
            summary: opts?.summary,
        }),
    }).catch(err => console.error("[my-service] trigger broadcast failed:", err));
}

// ── Service ───────────────────────────────────────────────────────────────

class MyService {
    get id() { return "my-service"; }

    #server: Server | null = null;

    init(_socket: any, { announcePanel }: any) {
        const panelDir = join(dirname(fileURLToPath(import.meta.url)), "panel");
        const indexHtml = readFileSync(join(panelDir, "index.html"), "utf-8");

        this.#server = Bun.serve({
            port: 0,
            fetch: async (req) => {
                const url = new URL(req.url);

                if (url.pathname.endsWith("/api/data")) {
                    return Response.json({ hello: "world" }, {
                        headers: { "Access-Control-Allow-Origin": "*" },
                    });
                }

                if (url.pathname.endsWith("/api/resolve/item/abc-123")) {
                    return Response.json({
                        id: "abc-123",
                        title: "Example Item",
                        href: "https://example.com/items/abc-123",
                        subtitle: "Open in My Service",
                    }, {
                        headers: { "Access-Control-Allow-Origin": "*" },
                    });
                }

                if (url.pathname.endsWith("/api/do-thing") && req.method === "POST") {
                    // Fire a trigger when something happens
                    void broadcastTrigger("my-service:something_happened", {
                        itemId: "abc-123",
                        timestamp: Date.now(),
                    }, { summary: "A thing happened" });

                    return Response.json({ ok: true }, {
                        headers: { "Access-Control-Allow-Origin": "*" },
                    });
                }

                return new Response(indexHtml, {
                    headers: { "Content-Type": "text/html; charset=utf-8" },
                });
            },
        });

        if (announcePanel) {
            announcePanel(this.#server.port);
        }
    }

    dispose() {
        if (this.#server) {
            this.#server.stop(true);
            this.#server = null;
        }
    }
}

export default MyService;
```

## Firing Triggers

Triggers are broadcast via the relay's HTTP API:

```
POST /api/runners/{runnerId}/trigger-broadcast
Headers: x-api-key: {apiKey}, Content-Type: application/json
Body: {
    "type": "my-service:something_happened",
    "payload": { "itemId": "abc-123", "timestamp": 1711600000 },
    "source": "my-service",
    "deliverAs": "followUp",
    "summary": "Human-readable description"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `type` | Yes | Must match a type declared in manifest `triggers[]` |
| `payload` | Yes | Arbitrary JSON object delivered to subscribers |
| `source` | No | Identifier shown in trigger history (e.g. service name) |
| `deliverAs` | No | `"steer"` (interrupts current turn) or `"followUp"` (queues after turn, default) |
| `summary` | No | Human-readable one-liner for trigger history |

The relay fans out to all sessions subscribed to that trigger type on this runner.

**Where to get runnerId and apiKey:**
- `runnerId` — read from `~/.pizzapi/runner.json` (written by the daemon on startup)
- `apiKey` — from `PIZZAPI_API_KEY` or `PIZZAPI_RUNNER_API_KEY` env vars
- `relayUrl` — from `PIZZAPI_RELAY_URL` env var or `relayUrl` in `~/.pizzapi/config.json`

## Agent Interaction

Once a service advertises triggers, agents can:

1. **Discover** — `list_available_triggers()` returns all triggers from runner services
2. **Subscribe** — `subscribe_trigger("my-service:something_happened")` starts receiving events
3. **Receive** — triggers arrive as injected messages in the agent's conversation
4. **Unsubscribe** — `unsubscribe_trigger("my-service:something_happened")` stops delivery

## Panel HTML Guidelines

The panel renders inside a 280px-tall iframe. Key constraints:

- **Self-contained** — all CSS and JS inline (no build step)
- **Dark theme** — match PizzaPi's dark UI:
  ```css
  body { background: #0a0a0b; color: #e4e4e7; font-size: 11px; }
  ```
- **Relative API URLs** — use `./api/data` (the tunnel proxy preserves the path)
- **Polling** — use `setInterval` + `fetch` for live data (typically 3–5s)
- **No external dependencies** — the iframe is sandboxed; CDN scripts may be blocked

## Services Without Panels

A service doesn't need a panel. Omit `panel` from manifest.json and skip the `announcePanel()` call. The service still runs in the background and can fire triggers:

```json
{
  "id": "my-watcher",
  "label": "File Watcher",
  "entry": "./index.ts",
  "triggers": [
    { "type": "my-watcher:file_changed", "label": "File Changed" }
  ]
}
```

## How It Works

```
1. Daemon discovers folder in ~/.pizzapi/services/
2. Reads manifest.json → extracts panel metadata + trigger definitions
3. Loads service module → calls init(socket, { announcePanel })
4. Service starts Bun.serve() on port 0 → calls announcePanel(port)
5. Daemon aggregates all trigger defs and sigil defs from all services
6. Daemon emits service_announce with panels[] + triggerDefs[] + sigilDefs[]
7. UI renders iframe; agents discover triggers via list_available_triggers()
8. Service fires triggers via POST /api/runners/{runnerId}/trigger-broadcast
9. Relay fans out to all subscribed sessions
```

## Quick Reference

| Task | How |
|------|-----|
| Declare triggers | Add `triggers[]` to `manifest.json` or `triggers.json` |
| Declare sigils | Add `sigils[]` to `manifest.json` or `sigils.json` |
| Resolve sigils | Expose an API route matching each sigil's `resolve` template |
| Fire a trigger | `POST /api/runners/{runnerId}/trigger-broadcast` with API key |
| Serve static files | `Bun.serve()` with `readFileSync` for index.html |
| Expose an API | Add route checks in the `fetch` handler |
| Get a random port | `Bun.serve({ port: 0 })` then read `.port` |
| Announce the panel | Call `announcePanel(server.port)` in `init()` |
| Match PizzaPi theme | Use `#0a0a0b` bg, `#e4e4e7` text, `#27272a` borders |
| Choose an icon | Browse [lucide.dev/icons](https://lucide.dev/icons), use kebab-case name |

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Triggers declared but never fired | Use the relay broadcast API — `console.log` doesn't deliver triggers |
| Sigils declared but not resolvable | Implement the `resolve` API route or omit `resolve` until you have one |
| Missing runnerId or apiKey | Read from `~/.pizzapi/runner.json` and env vars at call time, not init time |
| Forgetting `announcePanel()` | Panel won't appear in UI — always call it after server starts |
| Using absolute API URLs | Tunnel proxy rewrites paths; use relative URLs (`./api/...`) |
| Not cleaning up server in `dispose()` | Call `server.stop(true)` to avoid port leaks |
| Large panel height assumptions | Panel container is 280px tall — design accordingly |
| Missing `Access-Control-Allow-Origin` | Iframe requests need CORS headers on API responses |
