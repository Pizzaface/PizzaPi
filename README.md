# PizzaPi

A self-hosted web interface and relay server for the [pi coding agent](https://github.com/mariozechner/pi). Stream live AI coding sessions to any browser and interact remotely from mobile or desktop — no terminal required.

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

Relay server URL [http://localhost:3000]: https://your-server.example.com
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
| `server` | 3000 | Relay API + Web UI |

The web UI is now available at **http://localhost:3000**.

#### 3. Install the CLI

```bash
npm install -g @pizzapi/pizza
```

#### 4. Connect the CLI to your server

```bash
pizzapi setup
# Relay server URL: http://localhost:3000
# Email: you@example.com
# Password: your-password
```

#### 5. Start a session

```bash
pizzapi
```

Open **http://localhost:3000** in your browser to watch the session live.

---

#### Environment Variables (Server)

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3000` | HTTP/WS listen port |
| `PIZZAPI_REDIS_URL` | — | Redis connection URL (e.g. `redis://localhost:6379`) |

---

## CLI Reference

```bash
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
pizzapi web stop
pizzapi web logs
pizzapi web status

# Show version
pizzapi --version
```

### `pizza web` — One-Command Self-Hosting

`pizza web` is the easiest way to self-host the PizzaPi relay server and web UI. It manages Docker Compose for you — no need to clone the repo or write config files.

**Requirements:** Docker with Docker Compose

```bash
# Start the hub on the default port (3000)
pizzapi web

# Start on a custom port
pizzapi web --port 8080

# Run in the foreground (useful for debugging)
pizzapi web --foreground
```

On first run, if you're not inside the PizzaPi repo, the command will automatically clone it to `~/.pizzapi/web/repo`. On subsequent runs it pulls the latest changes.

The generated Docker Compose config and persistent data (auth database) are stored in `~/.pizzapi/web/`.

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
3. Generates a `compose.yml` in `~/.pizzapi/web/` with your chosen port
4. Runs `docker compose up` to build and start Redis + the server
5. The web UI is available at `http://localhost:<port>`

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
