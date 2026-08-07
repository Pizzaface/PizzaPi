---
name: creating-runner-services
description: Use when building a runner service — a daemon background process that ships inside a pi package (pi.pizzapi.services), exposes a UI panel, advertises triggers agents subscribe to, or defines sigils the UI renders inline. Covers panels, triggers, sigils, connectivity bridges, trust grants, and graceful degradation.
---

# Creating Runner Services

A runner service is a background process on the runner daemon. It can expose an
interactive **UI panel** in the web interface, advertise **custom triggers**
agent sessions subscribe to, and define **sigils** the UI renders as `[[type:id]]`
inline tokens.

**A service loads exactly one way: inside a pi package that declares it under
`pi.pizzapi.services`, granted daemon-service trust.** There is no loose-file
discovery — no `~/.pizzapi/services/` directory, no `manifest.json`, and the old
`ExtensionProvider` / `~/.pizzapi/providers/` API is gone. Service code runs on
the daemon, outside any session sandbox, so it needs an explicit trust grant that
a package install can carry and a loose file cannot.

> **Authoritative docs** (keep in sync when you change behavior):
> `packages/docs/src/content/docs/customization/runner-services.mdx` and
> `.../overlay-packages.mdx`. This skill is the practical distillation.

---

## Mental model

```
pi package (package.json → pi.pizzapi.services[])
  └─ granted daemon-service trust (overlayServiceGrants in ~/.pizzapi/config.json)
       └─ daemon discoverPackageServices() → imports entry → registry.init()
            ├─ panel HTTP server        → announcePanel(port)   → UI iframe
            ├─ sigil-only HTTP server   → announceSigilServer(port)
            ├─ triggers[] + sigils[]    → service_announce → agents/UI discover
            └─ fires triggers           → POST /api/runners/{id}/trigger-broadcast
```

Rules the loader enforces:
- **User-scope only.** Project-scope packages install but their services stay
  inactive in schema v1 (one global registry can't safely run one project's code
  for unrelated sessions).
- **Built-in ids are reserved** and always win a collision: `terminal`,
  `file-explorer`, `git`, `memory`, `process`, `time`, `tunnel`.
- **First package to claim an id wins**; later claimants are skipped with a warning.
- **The handler's runtime `id` must equal the declared `id`**, or the service is
  rejected. Trigger types must be namespaced by the service id (`my-service:thing`)
  — the daemon routes on `type.split(":")[0]`, so an unnamespaced trigger is dropped.

---

## Quick start

```bash
mkdir -p ~/my-service/service/panel && cd ~/my-service
```

`package.json` — everything PizzaPi-specific lives under `pi.pizzapi`:

```json
{
  "name": "@me/my-service",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "pi": {
    "pizzapi": {
      "schemaVersion": 1,
      "services": [
        {
          "id": "my-service",
          "label": "My Service",
          "icon": "activity",
          "entry": "./service/index.ts",
          "panel": { "dir": "./service/panel" },
          "triggers": [
            {
              "type": "my-service:something_happened",
              "label": "Something Happened",
              "description": "Emitted when something noteworthy occurs"
            }
          ]
        }
      ]
    }
  }
}
```

```bash
pizza install ~/my-service --allow-daemon-services   # install + grant in one step
# restart the runner — grants apply on daemon start
pizza list                                            # verify: services:[my-service:granted]
grep "loaded package service" ~/.pizzapi/logs/runner.log
```

Install without the grant to defer trust, then grant later:

```bash
pizza install ~/my-service --no-allow-daemon-services
pizza config grant  ~/my-service              # grant every declared service
pizza config grant  ~/my-service my-service   # grant one service by id
pizza config revoke ~/my-service my-service
```

Agents, rules, skills and MCP servers in the package still load without the
grant — only the daemon services stay inactive until trusted.

---

## Folder structure

```
my-service/
  package.json          # the pi.pizzapi.services declaration
  service/
    index.ts            # ServiceHandler (default export)
    triggers.json       # optional — see Split files
    sigils.json         # optional
    panel/
      index.html        # self-contained HTML/CSS/JS
```

Layout is up to you — only the paths named in the declaration matter, and they
are confined to the package root.

---

## Service declaration fields

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `id` | Yes | — | Unique id; must match `ServiceHandler.id`; cannot collide with a built-in |
| `label` | Yes | — | Button label in the header bar |
| `icon` | No | `"square"` | [Lucide](https://lucide.dev/icons) icon name, kebab-case |
| `entry` | No | `"./index.ts"` | Service module path, relative to package root |
| `panel.dir` | No | — | Panel static-files directory (omit for no panel) |
| `panel.requires` | No | `[]` | Vars resolved and passed to the panel iframe as query params. One or more of `PWD`, `SESSION_ID`, `HOME`, `USER`, `PROJECT_DIR` |
| `triggers` | No | `[]` | Inline `ServiceTriggerDef[]` **or** a path to a JSON file |
| `sigils` | No | `[]` | Inline `ServiceSigilDef[]` **or** a path to a JSON file |

### Split files

For large lists, point `triggers`/`sigils` at their own files instead of inlining:

```json
{ "triggers": "./service/triggers.json", "sigils": "./service/sigils.json" }
```

Each file is a bare array or `{ "triggers": [...] }` / `{ "sigils": [...] }`.

---

## The ServiceHandler

The `entry` module must default-export a handler matching this contract (from
`@pizzapi/extension-sdk`):

```ts
interface ServiceHandler {
  readonly id: string;
  init(socket: PizzaPiSocket, options: ServiceInitOptions): void;
  dispose(): void;
  handleSessionEnded?(sessionId: string): void;                 // per-session state cleanup
  reconcileSubscriptions?(subs, opts?): ReconcileResult;        // per-subscription state rebuild
}

interface ServiceInitOptions {
  isShuttingDown(): boolean;
  announcePanel?(port: number): void;        // provided only if the declaration has a panel
  announceSigilServer?(port: number): void;  // for sigil resolve with NO panel
}
```

- `init` runs once at daemon startup. Socket.IO reconnects reuse the same socket,
  so listeners stay attached across transient reconnects.
- `dispose` must release **everything** — HTTP servers, listeners, child
  processes, timers — or ports leak after the service is disabled or removed.
- `handleSessionEnded` — implement if you hold per-session state (processes,
  buffers, bindings, temp files).
- `reconcileSubscriptions` — implement if you hold per-subscription runtime state
  (timers, watchers). Called after runner reconnect with a `snapshot`, and on
  individual `delta` changes.

> `@pizzapi/extension-sdk` is the authoring contract. It's **not published to npm
> yet** — this doesn't block you: the overlay is plain JSON and the handler only
> has to match the structural interface. Import the types for checking when you
> can; match by hand until it ships.

### Handler template

```typescript
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import type { Server } from "bun";

// ── Relay helpers (needed only to FIRE triggers) ─────────────────────────
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
async function broadcastTrigger(
    type: string,
    payload: Record<string, unknown>,
    opts?: { deliverAs?: "steer" | "followUp"; summary?: string; expectsResponse?: boolean },
): Promise<void> {
    const runnerId = readRunnerId();
    const apiKey = getApiKey();
    if (!runnerId || !apiKey) return;
    await fetch(`${resolveRelayUrl()}/api/runners/${runnerId}/trigger-broadcast`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": apiKey },
        body: JSON.stringify({ type, payload, source: "my-service", deliverAs: opts?.deliverAs ?? "followUp", summary: opts?.summary, expectsResponse: opts?.expectsResponse }),
    }).catch((err) => console.error("[my-service] trigger broadcast failed:", err));
}

// ── Service ──────────────────────────────────────────────────────────────
class MyService {
    get id() { return "my-service"; }
    #server: Server | null = null;

    init(_socket: any, { announcePanel }: any) {
        const panelDir = join(dirname(fileURLToPath(import.meta.url)), "panel");
        const indexHtml = readFileSync(join(panelDir, "index.html"), "utf-8");

        this.#server = Bun.serve({
            port: 0, // OS picks a free port
            fetch: async (req) => {
                const url = new URL(req.url);
                const cors = { "Access-Control-Allow-Origin": "*" };

                // Panel context arrives as query params (from panel.requires)
                if (url.pathname.endsWith("/api/data")) {
                    return Response.json({ sessionId: url.searchParams.get("sessionId") }, { headers: cors });
                }
                // Sigil resolve: match each sigil's `resolve` template
                if (url.pathname.includes("/api/resolve/item/")) {
                    const id = url.pathname.split("/").pop();
                    return Response.json({ id, title: "Example Item", href: `https://example.com/${id}`, subtitle: "Open" }, { headers: cors });
                }
                if (url.pathname.endsWith("/api/do-thing") && req.method === "POST") {
                    void broadcastTrigger("my-service:something_happened", { itemId: "abc-123", timestamp: Date.now() }, { summary: "A thing happened" });
                    return Response.json({ ok: true }, { headers: cors });
                }
                return new Response(indexHtml, { headers: { "Content-Type": "text/html; charset=utf-8" } });
            },
        });

        announcePanel?.(this.#server.port);      // panel service
        // announceSigilServer?.(this.#server.port);  // sigil-only service (no panel)
    }

    dispose() { this.#server?.stop(true); this.#server = null; }
}

export default MyService;
```

---

## Triggers

Triggers push service events into agent conversations. Agents discover and
subscribe; the service fires; the relay fans out to subscribers.

### Declare

| Field | Required | Description |
|-------|----------|-------------|
| `type` | Yes | Namespaced, `"my-service:event_name"` |
| `label` | Yes | Human-readable, for UI and agent tools |
| `description` | No | When/why it fires |
| `schema` | No | JSON Schema of the payload. **Its properties are the filterable fields** subscribers can target with `filters` |
| `params` | No | Subscription params **forwarded to the service** (e.g. "which repo to watch"). See the params-vs-filters note below |

### Fire

```
POST /api/runners/{runnerId}/trigger-broadcast     (header: x-api-key)
```

| Body field | Required | Description |
|------------|----------|-------------|
| `type` | Yes | Must match a declared trigger type |
| `payload` | Yes | Arbitrary JSON delivered to subscribers |
| `source` | No | Label in trigger history (usually the service name) |
| `deliverAs` | No | `"followUp"` (default, queues after the turn) or `"steer"` (interrupts now) |
| `summary` | No | One-liner for trigger history |
| `expectsResponse` | No | Whether the delivery expects a reply |

Read `runnerId`/`apiKey`/`relayUrl` **at call time**, not in `init()` — they can
change on daemon reconnect (see the helpers in the template).

### params vs filters — get this right

These are two different mechanisms. The old model conflated them.

| Concept | Where it runs | What it's for |
|---------|---------------|---------------|
| `params` | Forwarded **to the service** | Tell the service *what to emit* (which repo, which channel). **Not** a delivery filter in the modern model. |
| `filters` | **Server-side, on delivery** | Tell the relay *what to deliver* — matched against the trigger payload before it reaches the agent. |

A subscriber sets `filters: [{ field, value, op? }]` (`op` = `"eq"` default or
`"contains"` substring) plus `filterMode` (`"and"` default / `"or"`). `field` is a
dot-path into the payload; array payload fields match by set membership.

```
subscribe_trigger("orders:status_changed", {
  filters: [{ field: "status", value: "shipped" }],
  filterMode: "and"
})
```

> **Legacy compat:** a subscription that has `params` but **no** `filters` still
> gets its params converted to filters at delivery time (exact match; a
> `...Contains` param name → substring; AND semantics). Prefer `filters` for new
> code; reserve `params` for values the service actually consumes.

### Agent tools

| Action | Tool |
|--------|------|
| Discover | `list_available_triggers()` |
| Subscribe | `subscribe_trigger("my-service:file_changed", { filters, filterMode, params })` |
| Edit a sub | `update_trigger_subscription({ subscriptionId, filters, filterMode })` |
| Unsubscribe | `unsubscribe_trigger({ subscriptionId })` (prefer id; type-only is legacy bulk) |

Subscribed triggers arrive as injected messages in the agent's conversation.

> **Advanced (see runner-services.mdx):** *Runner trigger listeners*
> (`POST /api/runners/{id}/trigger-listeners`) spawn a fresh session per matching
> trigger instead of delivering into an existing one. *Trigger history* is a
> per-session Redis log (`GET /api/sessions/{id}/triggers`, 200 entries, 24h TTL)
> shown live in the UI Triggers panel.

---

## Sigils

Sigils are `[[type:id]]` tokens in agent output that the UI renders as clickable
chips, status badges, or rich previews. A service declares sigil types so the UI
recognizes them.

```json
[
  { "type": "pr", "label": "Pull Request", "description": "GitHub PR chip",
    "resolve": "/api/resolve/pr/{id}", "aliases": ["pull-request", "mr"], "icon": "git-pull-request" },
  { "type": "commit", "label": "Commit", "resolve": "/api/resolve/commit/{id}" }
]
```

| Field | Required | Description |
|-------|----------|-------------|
| `type` | Yes | Token name in `[[type:id]]` |
| `label` | Yes | Human-readable |
| `description` | No | What it represents |
| `resolve` | No | HTTP path to enrich an id → display data (`/api/resolve/pr/{id}`) |
| `schema` | No | JSON Schema for params (`[[type:id key=val]]`) |
| `aliases` | No | Alt type names resolving to this sigil |
| `icon` | No | Lucide icon name |

To resolve sigils, expose a matching HTTP route. If the service has **no panel**,
call `announceSigilServer(port)` (instead of `announcePanel`) so the tunnel routes
resolve calls without listing the service in the panels grid. Sigil defs are
advertised via `service_announce`, the same as triggers.

---

## Panels

Panels render in a sandboxed iframe. Bottom dock is **280px tall**, side dock
**320px wide**.

- **Self-contained** — inline all CSS/JS, no build step, no CDN (CSP may block it).
- **Dark theme** — `background:#0a0a0b; color:#e4e4e7;` borders `#27272a`, `font-size:11px`.
- **Relative API URLs** — `./api/data` (the tunnel proxy preserves the path;
  absolute URLs break).
- **CORS** — API responses need `Access-Control-Allow-Origin: *`.
- **Live data** — `setInterval` + `fetch`, 3–5s.
- **Panel context** — vars in `panel.requires` arrive as camelCase query params:

```html
<script>
  const p = new URLSearchParams(location.search);
  const sessionId = p.get("sessionId");   // from requires: ["SESSION_ID"]
  const projectDir = p.get("projectDir"); // from requires: ["PROJECT_DIR"]
  fetch(`./api/state?${p.toString()}`).then(r => r.json()).then(render);
</script>
```

A service without a panel omits `panel` from the declaration and skips
`announcePanel()` — it still runs and can fire triggers.

---

## Connectivity services (Discord, Slack, MQTT, webhooks…)

When sessions need to talk to an external network that keeps a persistent
connection, **the daemon owns the one connection; sessions never open their own.**
A per-session connection object does not survive contact with reality — N sessions
means N connections on one token, duplicate inbound, credential spread, and no
routing authority.

Two directions, two transports:

**Inbound (outside → session).** The service owns the session↔conversation
mapping, so deliver straight to the one session over HTTP:

```typescript
await fetch(`${relayUrl}/api/sessions/${sessionId}/trigger`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify({ type: "discord:message", payload: { threadId, text }, source: "discord", deliverAs: "steer" }),
});
```

Use `trigger-broadcast` only when an event has **no** single owner (a CI result, a
repo push) and any subscriber should hear it.

**Outbound (session → outside).** The service can't see a session's in-process
events, so the package ships a **session-side extension** that observes them and
forwards over the `service_message` channel:

```typescript
import { sendServiceMessage } from "@pizzapi/extension-sdk";
sendServiceMessage(pi, "discord", "discord_post", { sessionId, content }); // in the extension
```

```typescript
init(socket, opts) {                                  // in the service handler
    this.onMessage = (env) => {
        if (opts.isShuttingDown() || env.serviceId !== "discord") return;
        if (this.#isDuplicate(env.id)) return;        // see below
        if (env.type === "discord_post") void this.post(env.payload);
    };
    socket.on("service_message", this.onMessage);
}
```

**`service_message` delivery is at-least-once** — the relay emits to the per-runner
room *and* the local runner socket, so a local runner sees **every envelope twice**.
Idempotent ops don't care; side effects (posting, emailing, charging) must dedupe
on the host-stamped `env.id`:

```typescript
#seen = new Set<string>();
#isDuplicate(id: unknown): boolean {
    if (typeof id !== "string" || !id) return false;
    if (this.#seen.has(id)) return true;
    this.#seen.add(id);
    if (this.#seen.size > 500) { const o = this.#seen.values().next().value; if (o !== undefined) this.#seen.delete(o); }
    return false;
}
```

Mapping lifecycle the service owns: persist bindings (write-temp-then-rename) so a
restart doesn't orphan conversations; index both ways; drop the binding in
`handleSessionEnded(sessionId)` and on a `404` from the trigger endpoint (session
gone). To *drive* a session, most controls already exist over HTTP with API-key
auth: spawn `POST /api/runners/:id/spawn`, input `POST /api/sessions/:id/trigger`,
switch model `POST /api/sessions/:id/model`, stop `POST /api/sessions/:id/abort`,
list `GET /api/sessions`.

Worked example: the Discord bridge —
`packages/cli/src/extensions/discord-mirror.ts` (session-side) plus its service.

---

## Graceful degradation

The same package may load in **vanilla pi**, where no daemon, relay, or UI exists.
Guard PizzaPi-only code with host detection from `@pizzapi/extension-sdk`. Package
load order vs host startup is not guaranteed, so prefer `onPizzaPiHost` (fires
immediately if the host is up, else waits for its ready event; at most once) over
a top-level `detectPizzaPiHost` probe:

```typescript
import { onPizzaPiHost } from "@pizzapi/extension-sdk";
export default function myExtension(pi) {
    const unsubscribe = onPizzaPiHost(pi, (host) => {
        if (!host.capabilities.includes("services")) return;
        // safe to use PizzaPi capabilities
    });
    return { dispose: unsubscribe };
}
```

Check `host.capabilities` before relying on a feature; don't assume `apiVersion`
implies it.

---

## Path placeholders

`entry`, `panel.dir`, and overlay MCP definitions expand these at load time:

| Token | Expands to |
|-------|-----------|
| `@PACKAGE_ROOT@` | Installed package root (use for shipped binaries/scripts — makes the package relocatable) |
| `@HOME@` | User home |
| `@PWD@` | Current working directory |
| `@PROJECT_DIR@` | Project directory |
| `@SESSION_ID@` | Active session id |
| `@USER@` | Username |

Keep durable state (configs, DBs) under `@HOME@/...`, never `@PACKAGE_ROOT@` — a
package can be reinstalled, moved, or resolved from a different checkout.

---

## Quick reference

| Task | How |
|------|-----|
| Ship a service | Declare it in `package.json` → `pi.pizzapi.services[]`, `pizza install --allow-daemon-services`, restart runner |
| Grant / revoke | `pizza config grant\|revoke <pkg> [serviceId]` (recorded in `overlayServiceGrants`) |
| Declare triggers/sigils | Inline array or a path to `triggers.json` / `sigils.json` |
| Fire a trigger | `POST /api/runners/{runnerId}/trigger-broadcast` with `x-api-key` |
| Filter delivery | Subscriber sets `filters` + `filterMode`, not `params` |
| Deliver to one session | `POST /api/sessions/{sessionId}/trigger` |
| Session → service | `sendServiceMessage(pi, id, type, payload)` + `socket.on("service_message")` |
| Resolve sigils w/o panel | `announceSigilServer(port)` instead of `announcePanel` |
| Random port | `Bun.serve({ port: 0 })` then read `.port` |
| Match theme | `#0a0a0b` bg, `#e4e4e7` text, `#27272a` borders |

## Common mistakes

| Mistake | Fix |
|---------|-----|
| Loose file in `~/.pizzapi/services/` | Removed. Ship a package with `pi.pizzapi.services` |
| Using the old `ExtensionProvider` API | Removed. Implement `ServiceHandler` in a package |
| Service installed but never mounts | Missing grant, or project-scope (user-scope only). `pizza list`, restart runner |
| Handler id ≠ declared id | Loader rejects it — they must match exactly |
| Unnamespaced trigger type | Route is `type.split(":")[0]`; use `my-service:event` |
| Filtering via `params` | Modern delivery filtering is `filters`; params go to the service |
| Reading runnerId/apiKey in `init()` | Read at call time — they change on reconnect |
| Triggers declared but not delivered | Declaring only advertises; you must fire via broadcast |
| Missing CORS on panel API | Add `Access-Control-Allow-Origin: *` |
| No dedupe on side effects | `service_message` is at-least-once — dedupe on `env.id` |
| Not cleaning up in `dispose()` | `server.stop(true)`; release listeners/timers/processes |
| Absolute panel API URLs | Use relative `./api/...` — the tunnel rewrites paths |
| Panel designed too big | Bottom dock 280px tall, side dock 320px wide |
