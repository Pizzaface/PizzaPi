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
  match: Record<string, unknown>; // flat dot-path equality matching
  action: TriggerAction;
}

interface TriggerAction {
  type: "spawn" | "inject";
  prompt?: string;              // supports {event.*} interpolation
  cwd?: string;
  agent?: string;               // agent definition name
  sessionId?: string;           // for "inject" — target session
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

### Control Messages (Runner → Plugin)

```jsonc
// Subscribe (narrow event scope)
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "subscribe",
  "params": {
    "filter": { "repo": "Pizzaface/PizzaPi" }
  }
}

// Unsubscribe
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
  context?: {
    repo?: string;
    pr?: number;
    issue?: number;
    channel?: string;
    path?: string;
  };
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

### Routing Priority

1. **Session triggers** — most recently registered wins if multiple match
2. **Runner triggers** — first matching rule wins (config order)
3. **Dead letter log** — no match, event logged for debugging

If both a session trigger and a runner trigger match, session trigger wins (the session explicitly asked for this event).

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

**Repo:** Pizzaface/PizzaPi
**PR:** #42
**Author:** reviewer
**Body:**
Can you fix the null check on line 87?
```

The agent processes it like any other user message.

### CLI Mode (Local Sessions)

Same tools work with constraints:
- Event sources configured in local `~/.pizzapi/plugins.json`
- CLI manages its own event source processes
- Session must stay alive — if it exits, triggers die
- No `spawn` action — events always inject into the current session

---

## 8. Runtime Management

### CLI Commands

Mirror MCP server management:

```bash
pizza plugin list                    # List event sources and status
pizza plugin add <name> [opts]       # Add a new event source
pizza plugin remove <name>           # Remove an event source
pizza plugin enable <name>           # Enable (set disabled: false)
pizza plugin disable <name>          # Disable (set disabled: true)
pizza plugin start <name>            # Runtime start (doesn't change config)
pizza plugin stop <name>             # Runtime stop (doesn't change config)
pizza plugin restart <name>          # Restart
pizza plugin status <name>           # Details: config, status, event counts
pizza plugin logs <name>             # View plugin logs
pizza plugin logs <name> --follow    # Tail logs
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
| Event matches but session is busy | Queue event. Max 10 per session, oldest dropped. |

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

### Out of scope (future)
- Agent-side plugin management (start/stop from within sessions)
- Glob/regex matching in trigger rules
- Event persistence across runner restarts
- Cross-runner event routing
- Plugin marketplace / registry
- Web UI extension rendering for events (integrate with WqK3N8Ft later)
