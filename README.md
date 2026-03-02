# PizzaPi

A self-hosted web interface and relay server for the [pi coding agent](https://github.com/badlogic/pi-mono). Stream live AI coding sessions to any browser and interact remotely from mobile or desktop — no terminal required.

---

## Table of Contents

- [How It Works](#how-it-works)
- [Installation](#installation)
  - [Option A — Use the Hosted Relay (Quickest)](#option-a--use-the-hosted-relay-quickest)
  - [Option B — Self-Host the Relay Server](#option-b--self-host-the-relay-server)
- [CLI Reference](#cli-reference)
  - [`pizza web` — One-Command Self-Hosting](#pizza-web--one-command-self-hosting)
- [Configuration](#configuration)
- [Runner Daemon](#runner-daemon)
- [Development](#development)
- [License](#license)

---

## How It Works

```
┌─────────────────────┐        WebSocket        ┌──────────────────────┐
│   pizzapi CLI       │ ──────────────────────► │  PizzaPi Relay Server │
│  (your dev machine) │                          │  (self-hosted / cloud)│
└─────────────────────┘                          └──────────┬───────────┘
                                                            │  HTTP / WS
                                                  ┌─────────▼──────────┐
                                                  │   Browser / Mobile  │
                                                  │   Web UI            │
                                                  └─────────────────────┘
```

- **CLI** (`pizzapi`) — wraps `pi` and streams every agent event to the relay
- **Relay Server** — buffers and broadcasts events; hosts the web UI
- **Web UI** — watch sessions live, send messages, manage runners, all from a browser

---

## Installation

### Option A — Use the Hosted Relay (Quickest)

Install the CLI, point it at an existing relay server (one you or someone else hosts), and start coding.

**Requirements:** Node 18+ or Bun

```bash
# Run without installing (npx)
npx @pizzapi/pizza

# — or — install globally
npm install -g @pizzapi/pizza
pizzapi
```

On first run, the setup wizard will ask for your relay URL, email, and password:

```
┌─────────────────────────────────────────┐
│        PizzaPi — first-run setup        │
└─────────────────────────────────────────┘

Connect this node to a PizzaPi relay server so your sessions
can be monitored from the web UI.

Relay server URL [http://localhost:7492]: https://your-server.example.com
Email: you@example.com
Password: ••••••••

Connecting to relay server… ✓
✓ API key saved to ~/.pizzapi/config.json
✓ Relay: wss://your-server.example.com
```

You can re-run setup any time:

```bash
pizzapi setup
```

---

### Option B — Self-Host the Relay Server

Run the relay + web UI yourself with Docker Compose. You need Docker and Docker Compose installed.

#### 1. Clone the repository

```bash
git clone https://github.com/Pizzaface/PizzaPi.git
cd PizzaPi
```

#### 2. Start the server stack

> **💡 Tip:** If you just want to get up and running quickly, skip the manual Docker setup and use [`pizza web`](#pizza-web--one-command-self-hosting) instead — it handles everything automatically.

```bash
docker compose -f docker/compose.yml up -d
```

This starts two services:

| Service | Port | Description |
|---------|------|-------------|
| `redis` | 6379 | Session event buffer |
| `server` | 7492 | Relay API + Web UI |

The web UI is now available at **http://localhost:7492**.

#### 3. Install the CLI

```bash
npm install -g @pizzapi/pizza
```

#### 4. Connect the CLI to your server

```bash
pizzapi setup
# Relay server URL: http://localhost:7492
# Email: you@example.com
# Password: your-password
```

#### 5. Start a session

```bash
pizzapi
```

Open **http://localhost:7492** in your browser to watch the session live.

---

#### Environment Variables (Server)

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `7492` | HTTP/WS listen port |
| `PIZZAPI_REDIS_URL` | — | Redis connection URL (e.g. `redis://localhost:6379`) |

---

## CLI Reference

```bash
# Show help
pizzapi --help

# Start an interactive coding session
pizzapi

# Run the headless runner daemon (spawns sessions on demand)
pizzapi runner

# Stop the runner daemon
pizzapi runner stop

# First-run setup (connect to relay server)
pizzapi setup

# Show API usage across providers
pizzapi usage
pizzapi usage anthropic
pizzapi usage gemini
pizzapi usage --json

# List available models
pizzapi models
pizzapi models --json

# Start the web hub (relay server + UI) via Docker
pizzapi web
pizzapi web --port 8080
pizzapi web --origins "https://example.com"
pizzapi web stop
pizzapi web logs
pizzapi web status
pizzapi web config
pizzapi web config set port 9000

# Show version
pizzapi --version
```

### `pizza web` — One-Command Self-Hosting

`pizza web` is the easiest way to self-host the PizzaPi relay server and web UI. It manages Docker Compose for you — no need to clone the repo or write config files.

**Requirements:** Docker with Docker Compose

```bash
# Show help
pizzapi web --help

# Start the hub on the default port (7492)
pizzapi web

# Start on a custom port (persisted for future runs)
pizzapi web --port 8080

# Set extra CORS origins (persisted)
pizzapi web --origins "https://example.com,https://other.com"

# Run in the foreground (useful for debugging)
pizzapi web --foreground
```

On first run, if you're not inside the PizzaPi repo, the command will automatically clone it to `~/.pizzapi/web/repo`. On subsequent runs it pulls the latest changes.

All settings and persistent data are stored in `~/.pizzapi/web/`:

| File | Purpose |
|------|---------|
| `config.json` | All web hub settings (port, VAPID keys, origins, etc.) |
| `compose.yml` | Auto-generated Docker Compose config (regenerated each run) |
| `data/` | Persistent auth database |

#### Configuration

Settings are persisted in `~/.pizzapi/web/config.json` and applied on every `pizza web` start. CLI flags like `--port` and `--origins` update the config automatically.

```bash
# View current configuration
pizzapi web config

# Set a config value
pizzapi web config set port 9000
pizzapi web config set extraOrigins "https://example.com"
pizzapi web config set vapidSubject "mailto:ops@example.com"
```

| Key | Default | Description |
|-----|---------|-------------|
| `port` | `7492` | Host port to expose the web UI on |
| `vapidSubject` | `mailto:admin@pizzapi.local` | VAPID subject for push notifications |
| `extraOrigins` | (none) | Extra allowed CORS origins, comma-separated |

VAPID keys for push notifications are generated on first run and stored in `config.json`. They persist across restarts and config changes — push notification subscriptions won't break.

> **Custom Docker overrides:** The `compose.yml` is regenerated on each run from the template + config. For additional Docker customizations (extra volumes, networks, etc.), create a `compose.override.yml` in the same directory — Docker Compose picks it up automatically.

#### Management Commands

```bash
# View live logs
pizzapi web logs

# Check running status
pizzapi web status

# Stop the hub
pizzapi web stop
```

#### How It Works

1. Checks for Docker and Docker Compose
2. Locates (or clones) the PizzaPi repository
3. Loads settings from `~/.pizzapi/web/config.json` (creating with defaults on first run)
4. Generates a `compose.yml` from the config (idempotent — only writes if changed)
5. Runs `docker compose up` to build and start Redis + the server
6. The web UI is available at `http://localhost:<port>`

---

### Exposing the Web UI over HTTPS with Tailscale

If you're running PizzaPi on a machine in your [Tailscale](https://tailscale.com) network, you can use **Tailscale Serve** to expose the web UI over HTTPS with a valid TLS certificate — no reverse proxy or manual cert management needed.

#### 1. Generate a TLS certificate

Tailscale can provision a Let's Encrypt certificate for your machine's Tailscale hostname:

```bash
tailscale cert your-hostname.tail12345.ts.net
```

This writes `your-hostname.tail12345.ts.net.crt` and `.key` to the current directory. Tailscale Serve uses these automatically — you don't need to configure them manually.

#### 2. Start Tailscale Serve

Proxy HTTPS traffic to the local PizzaPi port (default 7492 if using `pizza web`):

```bash
tailscale serve --bg http://localhost:7492
```

The web UI is now available at:

```
https://your-hostname.tail12345.ts.net/
```

Tailscale handles TLS termination and certificate renewal automatically.

#### 3. Update allowed origins

The server validates request origins for security. Add your Tailscale HTTPS URL:

```bash
pizzapi web config set extraOrigins "https://your-hostname.tail12345.ts.net"
```

> **Important:** Do not include a trailing slash — browser origins never have one.

Then restart the server:

```bash
pizzapi web stop && pizzapi web
```

#### 4. Verify

Open `https://your-hostname.tail12345.ts.net/` in your browser. You should see a valid certificate issued by Let's Encrypt.

#### Tailscale Serve management

```bash
# Check current serve config
tailscale serve status

# Stop serving
tailscale serve --https=443 off
```

#### Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| SSL/certificate error in browser | Tailscale Serve not running, or accessing `:7492` directly over HTTPS | Use the default HTTPS URL (port 443) and ensure `tailscale serve` is active |
| Blank page | Serve configured with `https+insecure://` backend | Use `http://localhost:7492` (plain HTTP) as the backend — the server doesn't speak TLS |
| "Invalid origin" error | `extraOrigins` doesn't match the URL, or has a trailing slash | Run `pizzapi web config set extraOrigins "https://your-hostname.tail12345.ts.net"` (no trailing slash) and restart |
| 502 Bad Gateway | Tailscale Serve config was lost (e.g. after reboot) | Re-run `tailscale serve --bg http://localhost:7492` |
| Port already allocated | Another container or process is using the port | Run `docker ps -a --filter "publish=7492"` to find the conflict, stop it, then retry |

---

## Configuration

Config is merged from two JSON files — project-local overrides global:

| File | Scope |
|------|-------|
| `~/.pizzapi/config.json` | Global (all projects) |
| `.pizzapi/config.json` | Project-local |

**Example:**

```json
{
  "apiKey": "your-relay-api-key",
  "relayUrl": "wss://your-server.example.com",
  "systemPrompt": "You are a helpful coding assistant.",
  "appendSystemPrompt": "Always write tests."
}
```

You can also use environment variables:

```bash
export PIZZAPI_API_KEY="your-relay-api-key"
export PIZZAPI_RELAY_URL="wss://your-server.example.com"
pizzapi
```

---

## Runner Daemon

The runner daemon lets you spawn **headless agent sessions on demand** from the web UI or via the `spawn_session` tool — no terminal needed.

```bash
# Start the runner
pizzapi runner

# Stop the runner
pizzapi runner stop
```

The runner registers itself with the relay server under a stable ID (stored in `~/.pizzapi/runner.json`) and spawns worker processes when requested.

---

## Platform Support

Pre-built binaries are available for:

| Platform | Architectures |
|----------|--------------|
| Linux | x64, arm64 |
| macOS | x64, arm64 (Apple Silicon) |
| Windows | x64 |

---

## Development

See [AGENTS.md](./AGENTS.md) for full developer documentation including build commands, package layout, and contribution notes.

**Prerequisites:** [Bun](https://bun.sh) (required — not Node/npm/yarn)

```bash
# Install dependencies
bun install

# Build all packages
bun run build

# Start dev server + UI with hot-reload
bun run dev

# Type-check all packages
bun run typecheck
```

The dev server runs at **http://localhost:3001** (API) and **http://localhost:5173** (Vite UI).

---

## License

MIT
