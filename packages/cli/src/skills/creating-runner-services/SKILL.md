---
name: creating-runner-services
description: Use when building a new runner service — background processes with optional UI panels and custom triggers that agents can subscribe to
---

# Creating Runner Services

Runner services are background processes on the runner daemon. They can:

- **Expose a UI panel** — an iframe in the PizzaPi web interface (no React needed)
- **Advertise custom triggers** — agents discover and subscribe to them at runtime
- **Fire triggers** — broadcast events to all subscribed agent sessions via the relay API

## Folder Structure

```
~/.pizzapi/services/<service-name>/
  manifest.json       # Required — declares metadata, panel config, and triggers
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
      }
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
| `triggers` | No | `[]` | Array of trigger type definitions (see below) |

### Trigger Definitions

Each entry in `triggers` declares a trigger type this service can emit:

| Field | Required | Description |
|-------|----------|-------------|
| `type` | Yes | Namespaced trigger type, e.g. `"my-service:event_name"` |
| `label` | Yes | Human-readable label for the UI and agent tools |
| `description` | No | When/why this trigger fires |
| `schema` | No | JSON Schema describing the trigger payload |

Trigger types are advertised to agents via `service_announce` so they can be discovered with `list_available_triggers()` and subscribed to with `subscribe_trigger()`.

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
5. Daemon aggregates all trigger defs from all services
6. Daemon emits service_announce with panels[] + triggerDefs[]
7. UI renders iframe; agents discover triggers via list_available_triggers()
8. Service fires triggers via POST /api/runners/{runnerId}/trigger-broadcast
9. Relay fans out to all subscribed sessions
```

## Quick Reference

| Task | How |
|------|-----|
| Declare triggers | Add `triggers[]` array to `manifest.json` |
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
| Missing runnerId or apiKey | Read from `~/.pizzapi/runner.json` and env vars at call time, not init time |
| Forgetting `announcePanel()` | Panel won't appear in UI — always call it after server starts |
| Using absolute API URLs | Tunnel proxy rewrites paths; use relative URLs (`./api/...`) |
| Not cleaning up server in `dispose()` | Call `server.stop(true)` to avoid port leaks |
| Large panel height assumptions | Panel container is 280px tall — design accordingly |
| Missing `Access-Control-Allow-Origin` | Iframe requests need CORS headers on API responses |
