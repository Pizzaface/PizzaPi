# Event-Driven Plugin System — Design Spec

**Status:** Design complete, pending implementation planning
**Priority:** P1
**Godmother ID:** NhmvLzqj
**Date:** 2026-03-18

---

## 1. Problem

PizzaPi sessions are currently human-initiated — someone types a prompt or spawns a child session. There's no way for external events (GitHub PR comments, Slack messages, file changes, cron schedules) to automatically trigger agent sessions.

**Primary use case:** A GitHub PR gets a comment → an agent picks it up and continues the conversation (or spawns a new one).

**Generalized:** Any external event source should be able to trigger agent work, either by spawning a new session on a runner or injecting input into an existing session.

---

## 2. Architecture Overview

```
                                      ┌──────────────────────┐
[github plugin]  ──events──┐          │   Trigger Router      │
[slack plugin]   ──events──┤          │                       │
[cron plugin]    ──events──┤──► Bus ──│  1. Session triggers   │──► inject into session
[webhook plugin] ──events──┤          │  2. Runner triggers    │──► spawn new session
[custom plugin]  ──events──┘          │  3. Dead letter log    │
                                      └──────────────────────┘
```

**Event Bus Architecture** was chosen over:
- **Hook-based** — hooks are fire-and-forget scripts, not long-lived listeners
- **MCP-as-event-source** — MCP is request/response (pull); events are push-based

The plugin process model mirrors MCP for familiarity, but the semantics are push-based event notifications.

---

## 3. Plugin Config (`~/.pizzapi/plugins.json`)

Event sources and trigger rules live in a dedicated config file, separate from `config.json`.

```jsonc
{
  "eventSources": {
    // stdio transport — runner manages the process
    "github-pr": {
      "transport": "stdio",
      "command": "pizzapi-plugin-github",
      "args": ["--mode", "pr-comments"],
      "env": {
        "GITHUB_TOKEN": "${GITHUB_TOKEN}"
      },
      "disabled": false
    },

    // HTTP streamable transport — runner connects to remote service
    "slack-mentions": {
      "transport": "http",
      "url": "https://my-slack-bridge.example.com/sse",
      "headers": {
        "Authorization": "Bearer ${SLACK_BRIDGE_TOKEN}"
      }
    },

    "file-watcher": {
      "transport": "stdio",
      "command": "pizzapi-plugin-fswatcher",
      "args": ["--watch", "./src"],
      "disabled": true
    }
  },

  // Runner-level trigger rules (persistent, survive restarts)
  "triggers": [
    {
      "name": "pr-review-bot",
      "source": "github-pr",
      "match": {
        "eventType": "comment_created",
        "context.repo": "Pizzaface/PizzaPi"
      },
      "action": {
        "type": "spawn",
        "prompt": "Handle this PR comment:\n\nRepo: {event.context.repo}\nPR: #{event.context.pr}\nAuthor: {event.payload.author}\n\n{event.payload.body}",
        "cwd": "/path/to/repo",
        "agent": "pr-reviewer"
      }
    }
  ]
}
```

### Config shape

```typescript
interface PluginsConfig {
  eventSources: Record<string, EventSourceConfig>;
  triggers: RunnerTrigger[];
}

interface EventSourceConfigBase {
  disabled?: boolean;           // won't start even with autoStart
}

interface StdioEventSource extends EventSourceConfigBase {
  transport: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>; // supports ${ENV_VAR} interpolation
  restart?: "always" | "on-failure" | "never";  // default: "on-failure"
  maxRestarts?: number;         // within restartWindow, default: 5
  restartWindow?: number;       // seconds, default: 300
}

interface HttpEventSource extends EventSourceConfigBase {
  transport: "http";
  url: string;
  headers?: Record<string, string>;
  reconnect?: boolean;          // default: true
}

type EventSourceConfig = StdioEventSource | HttpEventSource;

interface RunnerTrigger {
  name: string;
  source: string;               // event source name
  match: Record<string, string | number | boolean>; // flat dot-path equality, primitives only
  action: TriggerAction;
}

interface TriggerAction {
  type: "spawn" | "inject";
  prompt?: string;              // supports {event.*} interpolation
  cwd?: string;
  agent?: string;               // agent definition name
  sessionTag?: string;           // REQUIRED for "inject" — target session tag
  // When type is "inject", sessionTag must be provided. Sessions opt in
  // to receiving injected events by setting a tag (e.g., "pr-bot") via
  // the register_trigger tool or at spawn time. The runner matches by tag,
  // not by ephemeral session ID, so runner triggers survive session restarts.
  // If no session with the matching tag is found, the event falls through
  // to the next matching trigger or dead letter log.
}
```

---

## 4. Plugin Interface (MCP-aligned JSON-RPC 2.0)

### Transports

| Transport | Direction | Mechanism |
|-----------|-----------|-----------|
| **stdio** | Plugin → Runner | stdout JSON-lines |
| | Runner → Plugin | stdin JSON-lines |
| **HTTP** | Plugin → Runner | SSE stream (`GET /events`) |
| | Runner → Plugin | POST requests (`POST /control`) |

Both transports use identical JSON-RPC 2.0 messages.

**HTTP transport topology:** The **plugin hosts** the HTTP server. The runner is the client — it connects to the plugin's SSE endpoint and sends control messages via POST. This mirrors MCP's streamable-http where the server (plugin) hosts and the client (runner) connects. The `url` in config points to the plugin's base URL.

**Fixed HTTP paths (required for all HTTP transport plugins):**
- `GET {url}/events` — SSE event stream
- `POST {url}/control` — JSON-RPC 2.0 control messages (initialize, subscribe, shutdown)

### Handshake

```jsonc
// Runner → Plugin (request)
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "2025-03-01",
    "runner": { "name": "pizzapi", "version": "0.3.1" }
  }
}

// Plugin → Runner (response)
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": "2025-03-01",
    "name": "github-pr",
    "version": "1.0.0",
    "capabilities": {
      "events": ["comment_created", "comment_edited", "review_submitted"],
      "subscribe": true,
      "backfill": true
    }
  }
}

// Runner → Plugin (notification)
{ "jsonrpc": "2.0", "method": "notifications/initialized" }
```

### Event Notifications (Plugin → Runner)

```jsonc
{
  "jsonrpc": "2.0",
  "method": "notifications/event",
  "params": {
    "source": "github-pr",
    "eventType": "comment_created",
    "id": "evt_abc123",
    "timestamp": "2026-03-18T14:30:00Z",
    "payload": {
      "repo": "Pizzaface/PizzaPi",
      "pr": 42,
      "author": "reviewer",
      "body": "Can you fix the null check on line 87?"
    },
    "context": {
      "repo": "Pizzaface/PizzaPi",
      "pr": 42
    }
  }
}
```

> **Note on `context`:** The `context` field is `Record<string, unknown>` — plugins define whatever keys make sense for their domain. The matching system uses dot-path resolution, so `"context.repo": "Pizzaface/PizzaPi"` works regardless of what keys a plugin uses.

### Control Messages (Runner → Plugin)

```jsonc
// Subscribe (narrow event scope) — RESERVED FOR FUTURE USE
// Defined in the protocol for forward-compatibility. The v1 runner does NOT
// send these messages. Plugin authors MAY implement them but SHOULD NOT
// depend on receiving them. Future versions will send subscribe when the
// first trigger for a source is registered.
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "subscribe",
  "params": {
    "filter": { "repo": "Pizzaface/PizzaPi" }
  }
}

// Unsubscribe — RESERVED FOR FUTURE USE (same as subscribe)
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "unsubscribe",
  "params": {
    "filter": { "repo": "Pizzaface/PizzaPi" }
  }
}

// Shutdown
{ "jsonrpc": "2.0", "id": 4, "method": "shutdown" }
```

### Error Messages (Plugin → Runner)

```jsonc
{
  "jsonrpc": "2.0",
  "method": "notifications/error",
  "params": {
    "message": "GitHub API rate limited",
    "fatal": false
  }
}
```

### Type Definitions

```typescript
// Plugin → Runner
type PluginMessage =
  | { jsonrpc: "2.0"; id: number; result: PluginInitResult }
  | { jsonrpc: "2.0"; method: "notifications/event"; params: PluginEvent }
  | { jsonrpc: "2.0"; method: "notifications/error"; params: PluginError }

interface PluginInitResult {
  protocolVersion: string;
  name: string;
  version: string;
  capabilities: {
    events: string[];
    subscribe?: boolean;
    backfill?: boolean;
  };
}

interface PluginEvent {
  source: string;
  eventType: string;
  id: string;
  timestamp: string;
  payload: Record<string, unknown>;
  context?: Record<string, unknown>;  // plugin-defined routing hints (e.g. { repo, pr, channel })
}

interface PluginError {
  message: string;
  fatal?: boolean;
}

// Runner → Plugin
type ControlMessage =
  | { jsonrpc: "2.0"; id: number; method: "initialize"; params: InitParams }
  | { jsonrpc: "2.0"; method: "notifications/initialized" }
  | { jsonrpc: "2.0"; id: number; method: "subscribe"; params: { filter: Record<string, unknown> } }
  | { jsonrpc: "2.0"; id: number; method: "unsubscribe"; params: { filter: Record<string, unknown> } }
  | { jsonrpc: "2.0"; id: number; method: "shutdown" }

interface InitParams {
  protocolVersion: string;
  runner: { name: string; version: string };
}
```

### Minimal Plugin Example

```bash
#!/bin/bash
# Minimal cron plugin — emits a tick every 60 seconds

# Read initialize request
read -r init
# Respond with capabilities
echo '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-03-01","name":"cron","version":"1.0.0","capabilities":{"events":["tick"]}}}'
# Read initialized notification
read -r _

while true; do
  sleep 60
  echo "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/event\",\"params\":{\"source\":\"cron\",\"eventType\":\"tick\",\"id\":\"$(uuidgen)\",\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"payload\":{}}}"
done
```

---

## 5. Event Bus

The event bus is an in-process event emitter on the runner. No external infrastructure (no Redis, no message queue).

```typescript
interface EventBus {
  emit(event: PluginEvent): void;
  onEvent(handler: (event: PluginEvent) => void): void;
  getStats(): { received: number; deduped: number; routed: number };
}
```

**Deduplication:** Ring buffer of last 1000 event IDs. If a plugin re-sends an event (e.g., after reconnect with backfill), it's silently dropped. Best-effort — not a guarantee across runner restarts.

---

## 6. Trigger Router

The router checks incoming events against two registries in priority order.

### Session Triggers (ephemeral)

Registered by live sessions via tools. Die when the session disconnects.

```typescript
interface SessionTrigger {
  triggerId: string;
  sessionId: string;
  source: string;
  filter: Record<string, unknown>;
  label?: string;
  registeredAt: number;
}
```

### Runner Triggers (persistent)

Configured in `plugins.json`. Survive runner restarts.

### Matching Logic

Flat dot-path equality against event fields:

```jsonc
{
  "match": {
    "eventType": "comment_created",
    "context.repo": "Pizzaface/PizzaPi",
    "payload.author": "reviewer"
  }
}
```

All keys in `match` must be present and equal in the event. Missing keys in the event = no match. No regex or glob in v1.

**Match value types:** Only primitives — `string | number | boolean`. Arrays and nested objects in `match` are not supported. The dot-path resolves into the event structure (e.g., `"context.repo"` looks up `event.context.repo`), and the resolved value must strictly equal the match value.

### Routing Priority

1. **Session triggers** — if multiple session triggers match, **all matching sessions receive the event** (fan-out). This is intentional: two sessions watching the same PR both get notified.
2. **Runner triggers** — **all matching rules fire** (fan-out, same as session triggers). Multiple runner triggers can react to the same event (e.g., spawn a review session AND log to Slack). Runner triggers fire **only if no session trigger matched** — session triggers take priority. **Rationale:** A session that explicitly registers for an event has claimed ownership — it's actively working on that context (e.g., an agent watching PR #42). Runner triggers are the default automation; session triggers are the override. This prevents duplicate work (runner spawning a new session for an event an existing session already handles).
3. **Dead letter log** — no match from either tier, event logged for debugging.

### Actions

- **`spawn`** — create a new session with prompt template (supports `{event.*}` interpolation)
- **`inject`** — send event as input to an existing session

Session triggers always inject into the registering session.

### Busy Session Handling

If the target session is mid-turn, the event is queued. Max queue depth: 10 per session, oldest dropped when full. Delivered when the session's turn completes.

---

## 7. Agent-Facing Tools

### `list_event_sources`

```typescript
list_event_sources()
// Returns:
{
  sources: [
    { name: "github-pr", status: "connected", events: ["comment_created", "comment_edited"] },
    { name: "slack-mentions", status: "connected", events: ["message", "reaction_added"] },
    { name: "cron", status: "disabled", events: ["tick"] }
  ]
}
```

### `register_trigger`

```typescript
register_trigger({
  source: "github-pr",
  filter: {
    "eventType": "comment_created",
    "context.repo": "Pizzaface/PizzaPi",
    "context.pr": 42
  },
  label: "PR #42 comments"
})
// Returns:
{ triggerId: "st_abc123", message: "Registered: will inject events matching PR #42 comments" }
```

### `unregister_trigger`

```typescript
unregister_trigger({ triggerId: "st_abc123" })
```

### `list_triggers`

```typescript
list_triggers()
// Returns:
{
  triggers: [
    {
      triggerId: "st_abc123",
      source: "github-pr",
      filter: { "eventType": "comment_created", "context.pr": 42 },
      label: "PR #42 comments",
      registeredAt: "2026-03-18T14:30:00Z"
    }
  ]
}
```

### Event Delivery Format

Events are injected as conversation input using the same mechanism as `tell_child` (`deliverAs: "input"`):

```markdown
<!-- event:github-pr:comment_created -->
📩 Event from github-pr: comment_created

**context:**
```json
{"repo":"Pizzaface/PizzaPi","pr":42}
```

**payload:**
```json
{"author":"reviewer","body":"Can you fix the null check on line 87?"}
```
```

The delivery format is generic — `context` and `payload` are serialized as JSON blocks from the `PluginEvent`. No per-plugin rendering in v1. The agent processes it like any other user message and extracts what it needs.

If a runner trigger has a `prompt` template with `{event.*}` interpolation, the rendered prompt replaces the generic format above. This allows trigger authors to produce human-readable messages for specific use cases.

**Interpolation behavior:** `{event.payload.body}` resolves via dot-path into the event object. If the path doesn't resolve (field missing), it renders as an empty string. Nested objects render as JSON. This is intentionally simple — no conditionals, no loops, no expressions.

### CLI Mode (Local Sessions)

Same tools work with constraints:
- Event sources configured in local `~/.pizzapi/plugins.json`
- CLI manages its own event source processes
- Session must stay alive — if it exits, triggers die
- No `spawn` action — events always inject into the current session
- **Config validation:** If `plugins.json` contains runner triggers with `"type": "spawn"`, they are ignored in CLI mode with a warning logged at startup: `"Trigger '{name}' uses spawn action — ignored in CLI mode (no runner)"`. Runner triggers with `"type": "inject"` are also ignored in CLI mode — the CLI session uses session triggers (registered via tools) exclusively.

---

## 8. Runtime Management

### CLI Commands

Mirror MCP server management:

```bash
pizza plugin list                    # List event sources and status

# Add a new event source (stdio)
pizza plugin add <name> --transport stdio --command <cmd> [--args "arg1,arg2"] [--env "KEY=val"]
# Add a new event source (http)
pizza plugin add <name> --transport http --url <url> [--header "Key: Value"]

pizza plugin remove <name>           # Remove an event source
pizza plugin enable <name>           # Enable (set disabled: false)
pizza plugin disable <name>          # Disable (set disabled: true)
pizza plugin start <name>            # Runtime start (doesn't change config)
pizza plugin stop <name>             # Runtime stop (doesn't change config)
pizza plugin restart <name>          # Restart
pizza plugin status <name>           # Details: config, status, event counts
pizza plugin logs <name>             # View plugin logs
pizza plugin logs <name> --follow    # Tail logs

# Trigger management is manual (edit plugins.json) in v1.
# CLI trigger commands (pizza trigger list/add/remove) are future scope.
```

### `disabled` Flag

`disabled: true` in config takes precedence over everything — `autoStart`, manual `pizza plugin start`, etc. Must `pizza plugin enable` first.

### Runner Dashboard (Web UI)

Event sources shown in runner panel:

```
Event Sources
─────────────
● github-pr        connected   142 events   last: 2m ago
● slack-mentions   connected    38 events   last: 15m ago
○ cron             disabled
○ file-watcher     stopped
```

With controls to start/stop/restart/enable/disable from the UI.

### Agent-Side Management

Read-only in v1. Agents can see sources and register triggers, but cannot start/stop plugins. Infrastructure management stays with humans and CLI.

---

## 9. Error Handling & Lifecycle

### Plugin Lifecycle

```
Runner starts
  ↓
For each eventSource (not disabled):
  ├─ stdio: spawn process / http: connect
  ├─ Send initialize → wait for ready (5s timeout)
  ├─ On success: mark "connected", begin receiving events
  └─ On failure: mark "errored", log, apply restart policy

Runner shutdown:
  ├─ Send shutdown to all connected plugins
  ├─ Wait 3s for graceful exit
  └─ SIGKILL any remaining (stdio only)
```

### Restart Policies

**stdio:**

| Setting | Default | Description |
|---------|---------|-------------|
| `restart` | `"on-failure"` | `"always"`, `"on-failure"`, `"never"` |
| `maxRestarts` | `5` | Within `restartWindow` |
| `restartWindow` | `300` | Seconds — resets the restart counter |

**HTTP:** `reconnect: true` (default) with exponential backoff: 1s, 2s, 4s, 8s, max 60s.

### Failure Modes

| Failure | Behavior |
|---------|----------|
| Plugin crashes (stdio) | Restart per policy. Events during downtime lost unless plugin supports `backfill`. |
| HTTP connection drops | Reconnect with backoff. |
| Malformed JSON-RPC | Log warning, skip message, keep connection alive. |
| `initialize` times out (5s) | Mark errored, apply restart policy. |
| Plugin sends `fatal: true` error | Disconnect, don't restart. Surface in runner UI. |
| Event matches dead session trigger | Clean up stale registration, fall through to runner triggers. |
| Event matches but session is busy | Queue event (FIFO). Max 10 per session, **newest dropped** when full — preserves earliest context. Warning log: `"Event {id} dropped for session {sessionId}: queue full"`. |

### Session Trigger Cleanup

- Session disconnects → all its triggers removed immediately
- Safety sweep every 60s for stale registrations

### Observability

- **Runner UI dashboard:** connected sources, status, event counts, last event time
- **Dead letter log:** `~/.pizzapi/logs/events-dead-letter.jsonl` — rotating, max 1MB
- **Plugin stderr:** `~/.pizzapi/logs/plugin-{name}.log` — rotating, max 5MB per plugin

---

## 10. V1 Scope

### In scope
- Plugin config (`plugins.json`) with stdio and HTTP transports
- JSON-RPC 2.0 plugin protocol (initialize, events, subscribe, shutdown)
- Event bus with dedup
- Trigger router with session triggers + runner triggers
- Agent tools: `list_event_sources`, `register_trigger`, `unregister_trigger`, `list_triggers`
- Event delivery as conversation input
- CLI management: `pizza plugin list|add|remove|enable|disable|start|stop|restart|status|logs`
- Runner dashboard UI for event source status
- Error handling, restart policies, observability logs
- At least one reference plugin implementation (GitHub PR comments)

### Notes

- **Config hot-reload:** Changes to `plugins.json` require a runner restart in v1. No file watching.
- **Security model:** Plugins are trusted — stdio plugins run with the runner's permissions, HTTP plugins receive whatever headers are configured. No sandboxing in v1. This is the same trust model as MCP servers.
- **Protocol version mismatch:** If the plugin responds to `initialize` with a `protocolVersion` the runner doesn't support, the runner logs a warning and disconnects. The plugin should be updated.
- **`context` vs `payload` guidance for plugin authors:** `context` contains routing hints — fields that triggers match against (e.g., repo, PR number, channel). `payload` contains the full event body passed to the agent. Some fields may appear in both — that's fine.

### Out of scope (future)
- Agent-side plugin management (start/stop from within sessions)
- Glob/regex matching in trigger rules
- Event persistence across runner restarts
- Cross-runner event routing
- Plugin marketplace / registry
- Web UI extension rendering for events (integrate with WqK3N8Ft later)
- **`backfill` capability**: declared in the handshake for forward-compatibility, but no control message or behavior is defined in v1. Plugins that support backfill should advertise it; the runner will use it in a future version to request missed events after reconnect.
- **`subscribe`/`unsubscribe` semantics**: the control messages are defined in the protocol, but v1 does not send them automatically. They exist for plugins that want to support scope narrowing. Future versions may send `subscribe` when the first trigger for a source is registered.
