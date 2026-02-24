# PizzaPi

A self-hosted web interface and relay server for the [pi coding agent](https://github.com/mariozechner/pi). Stream live AI coding sessions to any browser and interact remotely from mobile or desktop.

## Quick Start

```bash
npx @pizzapi/pizza
```

Or install globally:

```bash
npm install -g @pizzapi/pizza
pizza
```

## What is PizzaPi?

PizzaPi wraps the `pi` coding agent with:

- **Web UI** — Monitor and interact with coding sessions from any browser
- **Relay Server** — Stream sessions in real-time over WebSocket
- **Runner Daemon** — Spawn headless agent sessions on demand
- **Multi-model** — Works with Anthropic Claude, Google Gemini, OpenAI, and more

## Commands

```bash
# Start an interactive coding session
pizzapi

# Run the headless runner daemon
pizzapi runner

# Stop the runner daemon
pizzapi runner stop

# First-run setup (connect to relay server)
pizzapi setup

# Show API usage
pizzapi usage
pizzapi usage anthropic
pizzapi usage gemini
pizzapi usage --json

# List available models
pizzapi models
pizzapi models --json

# Show version
pizzapi --version
```

## Self-Hosting

PizzaPi is designed to be self-hosted. You'll need:

1. A PizzaPi relay server (the web UI + API)
2. One or more PizzaPi CLI nodes connected to the relay

See the [full documentation](https://github.com/Pizzaface/PizzaPi) for server setup instructions.

## Configuration

Config is stored in `~/.pizzapi/config.json` (global) and `.pizzapi/config.json` (project-local).

```json
{
  "apiKey": "your-relay-api-key",
  "relayUrl": "wss://your-server.example.com"
}
```

## Platform Support

PizzaPi provides prebuilt binaries for:

- Linux x64 / arm64
- macOS x64 / arm64 (Apple Silicon)
- Windows x64

## License

MIT
