# PizzaPi

A self-hosted web interface and relay server for the [pi coding agent](https://github.com/badlogic/pi-mono). Stream live AI coding sessions to any browser and interact remotely from mobile or desktop — no terminal required.

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

## Quick Start

```bash
# Install the CLI
npm install -g @pizzapi/pizza

# Start a coding session
pizzapi

# Self-host the relay server (requires Docker)
pizzapi web

# Show help
pizzapi --help
pizzapi web --help
```

---

## Documentation

Full documentation is available at **[pizzaface.github.io/PizzaPi](https://pizzaface.github.io/PizzaPi/)**.

- [Getting Started](https://pizzaface.github.io/PizzaPi/getting-started/)
- [Installation](https://pizzaface.github.io/PizzaPi/guides/installation/)
- [CLI Reference](https://pizzaface.github.io/PizzaPi/guides/cli-reference/)
- [Configuration](https://pizzaface.github.io/PizzaPi/guides/configuration/)
- [Self-Hosting](https://pizzaface.github.io/PizzaPi/guides/self-hosting/)
- [Tailscale Setup](https://pizzaface.github.io/PizzaPi/guides/tailscale/)
- [Runner Daemon](https://pizzaface.github.io/PizzaPi/guides/runner-daemon/)
- [Architecture](https://pizzaface.github.io/PizzaPi/reference/architecture/)

---

## Development

See [AGENTS.md](./AGENTS.md) for full developer documentation including build commands, package layout, and contribution notes.

**Prerequisites:** [Bun](https://bun.sh) (required — not Node/npm/yarn)

```bash
bun install
bun run build
bun run dev        # Hot-reload dev server
bun run typecheck  # Type-check all packages
```

---

## License

MIT
