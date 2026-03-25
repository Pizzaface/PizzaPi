---
name: creating-service-panels
description: Use when building a new runner service that needs a UI panel in the PizzaPi web interface, or when packaging a service as a folder-based plugin with an iframe dashboard
---

# Creating Service Panels

Build runner services that ship their own UI panel, rendered as an iframe in the PizzaPi web interface. No React compilation needed — the panel is a self-contained HTML page served by the service's own HTTP server and proxied through the tunnel system.

## Folder Structure

```
~/.pizzapi/services/<service-name>/
  manifest.json       # Required — declares metadata and panel config
  index.ts            # ServiceHandler module (default export)
  panel/
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
  }
}
```

| Field       | Required | Default        | Description |
|-------------|----------|----------------|-------------|
| `id`        | Yes      |                | Unique service ID (must match `ServiceHandler.id`) |
| `label`     | Yes      |                | Button label shown in the PizzaPi header bar |
| `icon`      | No       | `"square"`     | [Lucide](https://lucide.dev/icons) icon name (kebab-case) |
| `entry`     | No       | `./index.ts`   | Service module path relative to folder |
| `panel.dir` | No       | `./panel`      | Panel static files directory |

## ServiceHandler Template

```typescript
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "bun";

class MyService {
    get id() { return "my-service"; }

    #server: Server | null = null;

    init(socket: any, { isShuttingDown, announcePanel }: any) {
        // Resolve panel directory relative to this file
        const panelDir = join(dirname(fileURLToPath(import.meta.url)), "panel");
        const indexHtml = readFileSync(join(panelDir, "index.html"), "utf-8");

        // Start HTTP server on a random available port
        this.#server = Bun.serve({
            port: 0,
            fetch: async (req) => {
                const url = new URL(req.url);

                // API endpoints
                if (url.pathname.endsWith("/api/data")) {
                    const data = { /* your data */ };
                    return new Response(JSON.stringify(data), {
                        headers: {
                            "Content-Type": "application/json",
                            "Access-Control-Allow-Origin": "*",
                        },
                    });
                }

                // Serve panel HTML for everything else
                return new Response(indexHtml, {
                    headers: { "Content-Type": "text/html; charset=utf-8" },
                });
            },
        });

        // Announce panel port — triggers tunnel auto-registration
        if (announcePanel) {
            announcePanel(this.#server.port);
        }

        // Socket-based events (optional, for non-panel consumers)
        socket.on("service_message", async (envelope: any) => {
            if (envelope?.serviceId !== "my-service") return;
            // Handle socket messages...
        });
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

## How It Works

```
1. Daemon discovers folder in ~/.pizzapi/services/
2. Reads manifest.json → extracts panel metadata (label, icon)
3. Loads service module → calls init(socket, { announcePanel })
4. Service starts Bun.serve() on port 0 → calls announcePanel(port)
5. Daemon auto-registers port with TunnelService
6. Daemon emits service_announce with panels array
7. UI renders iframe at /api/tunnel/{sessionId}/{port}/
```

## Quick Reference

| Task | How |
|------|-----|
| Serve static files | `Bun.serve()` with `readFileSync` for index.html |
| Expose an API | Add route checks in the `fetch` handler |
| Get a random port | `Bun.serve({ port: 0 })` then read `.port` |
| Announce the panel | Call `announcePanel(server.port)` in `init()` |
| Match PizzaPi theme | Use `#0a0a0b` bg, `#e4e4e7` text, `#27272a` borders |
| Choose an icon | Browse [lucide.dev/icons](https://lucide.dev/icons), use kebab-case name |

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Forgetting `announcePanel()` | Panel won't appear in UI — always call it after server starts |
| Using absolute API URLs | Tunnel proxy rewrites paths; use relative URLs (`./api/...`) |
| Not cleaning up server in `dispose()` | Call `server.stop(true)` to avoid port leaks |
| Large panel height assumptions | Panel container is 280px tall — design accordingly |
| Missing `Access-Control-Allow-Origin` | Iframe requests need CORS headers on API responses |
