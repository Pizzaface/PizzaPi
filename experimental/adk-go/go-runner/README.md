# go-runner — Phase 0 PizzaPi Go Runner

A minimal Go binary that connects to the PizzaPi relay server and drives agent
sessions using the Claude CLI subprocess.

## What It Does

```
┌─────────────────────────────────────┐
│  PizzaPi Web UI (React 19)          │ ← renders sessions from relay events
├─────────────────────────────────────┤
│  Relay Server (Bun + Redis)         │ ← existing PizzaPi server
├─────────────────────────────────────┤
│  go-runner (this binary)            │ ← NEW: Go replacement for Bun daemon
│  ├── Socket.IO v4 client            │    custom EIO4 implementation
│  ├── Per-session: claude subprocess  │    via claude-wrapper package
│  └── Adapter: NDJSON → relay events │    heartbeat, message_update, etc.
└─────────────────────────────────────┘
```

## Usage

```bash
# Required environment
export PIZZAPI_API_KEY="your-api-key"

# Optional (defaults shown)
export PIZZAPI_RELAY_URL="http://localhost:7492"

# Build and run
cd experimental/adk-go/go-runner
go build -o go-runner .
./go-runner

# Or run directly
go run . --runner-name "my-go-runner"
```

### Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--relay-url` | `$PIZZAPI_RELAY_URL` or `http://localhost:7492` | Relay server URL |
| `--runner-name` | hostname | Display name in PizzaPi UI |
| `--runner-id` | `go-runner-<hostname>` | Unique runner identifier |

## Architecture

### Socket.IO v4 Client

Custom implementation of the Engine.IO v4 + Socket.IO v4 client protocol over
WebSocket. Supports:

- Engine.IO handshake (open packet, ping/pong keepalive)
- Socket.IO namespace connection with auth payload
- Event emission and reception
- Automatic reconnection (TODO: not yet implemented)

### Session Management

On `new_session` from the relay:

1. Spawn `claude --print --output-format stream-json --verbose -p <prompt>`
2. Parse NDJSON stdout via `claudewrapper.ParseStream()`
3. Convert to relay events via `claudewrapper.Adapter.HandleEvent()`
4. Forward each `RelayEvent` as `runner_session_event` to the relay
5. Emit periodic heartbeats (every 10s)
6. On process exit: emit inactive heartbeat, clean up

On `kill_session`:
1. Cancel the session context (sends SIGTERM to subprocess)
2. Wait for process exit (10s timeout)
3. Emit `session_killed` to relay

### Relay Protocol (Subset)

Phase 0 implements the minimum viable relay protocol:

| Event | Direction | Purpose |
|-------|-----------|---------|
| `register_runner` | runner → relay | Register with name, roots, version |
| `runner_registered` | relay → runner | Confirm registration, report orphans |
| `new_session` | relay → runner | Spawn a Claude session |
| `kill_session` | relay → runner | Kill a running session |
| `session_ready` | runner → relay | Session subprocess started |
| `session_error` | runner → relay | Session failed to start |
| `session_killed` | runner → relay | Session was killed |
| `runner_session_event` | runner → relay | Forward adapter events |
| `session_ended` | relay → runner | Clean up session entry |

### What's NOT Implemented (Phase 0 Scope)

- Session adoption on reconnect
- Trigger subscription reconciliation
- Service registry (panels, sigils, triggers)
- Terminal management
- Agent/skill/plugin CRUD
- File operations
- Settings management
- Tunnel client
- Reconnection with exponential backoff
- Multi-turn sessions via stdin (validated, deferred to Phase 1)

## Tests

```bash
go test ./... -v
```

9 tests covering:
- Socket.IO client: connect, emit, receive, ping/pong, disconnect
- Runner: registration, new_session handling, kill_session safety, session_ended cleanup
- Serialization: relay event payload correctness

## Related

- `../claude-wrapper/` — Claude CLI NDJSON parser, relay adapter, subprocess manager
- `../../docs/adk-go/phase0-wrapper-contract.md` — lifecycle contract
- `../../docs/adk-go/phase0-event-mapping.md` — event mapping table
- `../../docs/adk-go/phase0-stdin-protocol.md` — stdin multi-turn protocol research
- `../../docs/adk-go/phase0-risk-register.md` — risk register
