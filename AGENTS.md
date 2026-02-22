# PizzaPi — Agent Guide

PizzaPi is a self-hosted web interface and relay server for the [`pi` coding agent](https://github.com/mariozechner/pi) (`@mariozechner/pi-coding-agent`). It streams live agent sessions to any browser and allows remote interaction from mobile or desktop without needing terminal access.

---

## Repository Layout

```
packages/
  cli/      CLI wrapper — launches pi with PizzaPi extensions and the runner daemon
  server/   Bun HTTP + WebSocket relay server (auth, session relay, attachments)
  ui/       React 19 PWA web interface (Vite, TailwindCSS v4, Radix UI / shadcn)
  tools/    Shared agent tools (bash, read-file, write-file, search, toolkit)

docker/     Docker Compose (redis + server services)
patches/    Bun patches for upstream pi packages (auto-applied on bun install)
```

The build order matters: `tools` → `server` → `ui` → `cli`. Each package depends on the previous ones.

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Runtime / package manager | **Bun** (required — not Node/npm/yarn) |
| Language | TypeScript (strict mode, ESM throughout) |
| Server | Bun.serve, better-auth, Kysely + SQLite, Redis, web-push |
| UI | React 19, Vite 6, TailwindCSS v4, Radix UI, shadcn/ui, streamdown |
| Agent core | `@mariozechner/pi-coding-agent`, `@mariozechner/pi-ai`, `@mariozechner/pi-tui` |

---

## Common Commands

```bash
# Install dependencies (also re-applies patches)
bun install

# Build everything (tools → server → ui → cli)
bun run build

# Build individual packages
bun run build:tools
bun run build:server
bun run build:ui
bun run build:cli

# Development (server + UI in parallel, hot-reload)
bun run dev

# Type-check all packages
bun run typecheck

# Run DB migrations (server package)
bun run migrate

# Run the CLI directly from source
bun run dev:cli

# Run the runner daemon from source
bun run dev:runner

# Clean all dist/ directories
bun run clean
```

---

## Key Concepts

### Extensions (`packages/cli/src/extensions/`)

PizzaPi wraps `pi` with custom extensions loaded via `DefaultResourceLoader`:

- **`remote.ts`** — Connects to the relay over WebSocket and streams every agent event. Handles remote exec commands from the web UI (abort, set model, new/resume session, compact, MCP reload, etc.). Also gathers provider usage (Anthropic, Gemini, OpenAI Codex) and heartbeats to keep web viewers in sync.
- **`mcp-extension.ts` / `mcp-bridge.ts`** — MCP server management; the bridge is a singleton that `remote.ts` queries for status/reload.
- **`restart.ts`** — `/restart` command that self-restarts the CLI process.
- **`set-session-name.ts`** — `/name` command to rename the current session; synced to web viewers.

### Runner Daemon (`packages/cli/src/runner/`)

`bun run dev:runner` starts a long-running daemon that:
1. Registers with the relay server under a stable `runnerId` (stored in `~/.pizzapi/runner.json`).
2. Spawns headless `worker.ts` processes on demand when the relay sends `new_session`.
3. Refreshes provider usage data to a shared cache file (`~/.pizzapi/usage-cache.json`) every 5 minutes so all worker sessions can read it without redundant API calls.
4. Exits with code `42` to signal the outer loop to restart it.

### Relay Server (`packages/server/src/`)

A single Bun.serve instance handles:
- **`/api/auth/*`** — better-auth endpoints (OAuth, session cookies)
- **`/ws/sessions`** — WebSocket endpoint for CLI clients; events are buffered in Redis and replayed to web viewers that connect late
- **`/ws/runner`** — WebSocket endpoint for runner daemons registering and receiving `new_session` commands
- **REST API** (`/api/*`) — sessions list, attachments upload/download, runner management, skills CRUD, push notification subscriptions

Session events are stored ephemerally in Redis (with TTL) and purged by a background sweep.

### Configuration

Config is merged from two JSON files (project overrides global):

| File | Scope |
|------|-------|
| `~/.pizzapi/config.json` | Global (all projects) |
| `<cwd>/.pizzapi/config.json` | Project-local |

Relevant fields: `apiKey`, `relayUrl`, `agentDir`, `systemPrompt`, `appendSystemPrompt`, `skills`.

### Skills

Skills are discovered from (in order):
1. `~/.pizzapi/skills/` — global PizzaPi skills
2. `<cwd>/.pizzapi/skills/` — project-local skills
3. Any paths listed in `config.skills`

Skills follow the standard `SKILL.md` layout (subdirectory) or a flat `.md` file in the skills root.

### AGENTS.md / `.agents/` Loading

On startup the CLI automatically injects:
- `<cwd>/AGENTS.md` (this file) if it exists
- All `*.md` files found in `<cwd>/.agents/`

These are appended to the agent's context alongside the built-in system prompt.

---

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `PIZZAPI_API_KEY` | — | API key used by the CLI to authenticate with the relay |
| `PIZZAPI_RELAY_URL` | `ws://localhost:3001` | WebSocket URL of the relay. Set to `off` to disable. Accepts `ws://`, `wss://`, `http://`, `https://` |
| `PIZZAPI_SESSION_ID` | random UUID | Fixed session ID for headless worker processes |
| `PIZZAPI_RUNNER_USAGE_CACHE_PATH` | — | Path to runner-managed usage cache file; set by daemon on spawned workers |
| `PIZZAPI_RUNNER_NAME` | system hostname | Display name shown in the web UI for this runner |
| `PIZZAPI_RUNNER_STATE_PATH` | `~/.pizzapi/runner.json` | Runner lock + identity file |
| `PIZZAPI_RUNNER_API_KEY` | falls back to `PIZZAPI_API_KEY` | API key used by the runner daemon |
| `PIZZAPI_WORKSPACE_ROOTS` | — | Comma-separated list of allowed `cwd` roots for runner-spawned sessions |
| `PIZZAPI_WORKER_CWD` | — | Working directory for a headless worker, set by the runner daemon |
| `PORT` | `3000` | Server HTTP/WS port |
| `PIZZAPI_REDIS_URL` | — | Redis connection URL (e.g. `redis://localhost:6379`) |

---

## Patches

Two upstream packages are patched via Bun's `patchedDependencies` mechanism and are **automatically re-applied on every `bun install`**. Never edit files inside `node_modules` directly.

### `@mariozechner/pi-coding-agent@0.53.0`

Exposes `newSession()` and `switchSession()` on the `ExtensionAPI` object so the remote extension can trigger session-control flows from outside a command handler. See `patches/README.md` for full details.

### `@mariozechner/pi-ai@0.53.0`

See `patches/@mariozechner%2Fpi-ai@0.53.0.patch` for specifics.

---

## Development URLs

| Environment | URL |
|-------------|-----|
| Vite dev server (Tailscale HTTPS) | `https://jordans-mac-mini.tail65556b.ts.net:5173` |
| Bun API server (local) | `http://localhost:3001` |

The Vite dev server proxies `/api` and `/ws` to the Bun server on port 3001.

---

## Development Notes

- **Always use `bun`** — no Node, npm, yarn, or pnpm.
- **Build order**: `tools` must be built before `server` or `cli`; `ui` can be built in parallel with `server`. The root `bun run build` script handles ordering correctly.
- **TypeScript**: run `bun run typecheck` (`tsc --build`) to check all packages at once. Each package has its own `tsconfig.json` that extends `tsconfig.base.json`.
- **Upstream patch compatibility**: If you upgrade `@mariozechner/pi-coding-agent` or `@mariozechner/pi-ai`, verify the patches still apply cleanly. Bun will fail `bun install` with a clear error if they don't.
- **Redis is required** for the server in production. For local dev without Docker, start Redis separately (`redis-server`) or use `docker compose up redis`.
- **TLS certs** in `certs/` (`ts.crt`, `ts.key`) are for local HTTPS dev (e.g. Tailscale). They are not committed with real private keys; replace them for your environment.
- **Database migrations**: run `bun run migrate` inside `packages/server` (or `bun run migrate` from root) after schema changes. The DB file is `packages/server/auth.db` (SQLite).
- **PWA**: The UI is a Progressive Web App. `vite-plugin-pwa` generates the service worker and manifest. Icons live in `packages/ui/public/`.

---

## Docker

```bash
# Production stack (Redis + server)
docker compose -f docker/compose.yml up

# Dev stack (hot-reload, bind-mounts source)
docker compose -f docker/compose.yml --profile dev up
```

The server image is built from the root `Dockerfile` using a multi-stage build. The `builder` target is reused by the dev profile.
