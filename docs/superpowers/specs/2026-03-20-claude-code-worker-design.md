# Claude Code Worker — Design Specification

**Date:** 2026-03-20  
**Status:** Draft  
**Author:** Brainstorming session  

## Summary

Add a new "Claude Code worker" type to PizzaPi that runs the official Claude Code CLI as a subprocess, translates its events into PizzaPi's relay protocol, and surfaces them in the existing web UI — fully indistinguishable from a pi-based session. The design uses three data capture channels (NDJSON stream, plugin hooks, MCP server) feeding into a bridge process that maintains the relay connection.

## Goals

1. **Full UI parity** — Claude Code sessions appear in the PizzaPi web UI with all features: streaming messages, model info, input/collab, abort/interrupt, todo list, AskUserQuestion, permission approval, triggers, session messaging, and attachments.
2. **Native-first** — Intercept Claude Code's native tools (TodoWrite, AskUserQuestion, permissions) rather than replacing them with PizzaPi equivalents. Claude Code runs unmodified; the bridge and plugin only observe and translate.
3. **Same runner daemon** — The existing runner daemon spawns Claude Code workers alongside pi workers. The server/UI passes a flag indicating which worker type to use.
4. **Minimal MCP surface** — The plugin's MCP server only provides tools Claude Code genuinely doesn't have (inter-session messaging, triggers, session spawning).

## Non-Goals

- Replacing the pi-based worker entirely (both coexist)
- Supporting Claude Code's interactive terminal mode (we use headless `-p` mode)
- Supporting non-Claude-Code agents (Codex, Gemini, etc.) — future work
- Modifying Claude Code's source or requiring patches to it

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────┐
│                    Bridge Process                         │
│                 (claude-code-bridge.ts)                   │
│                                                           │
│  ┌───────────────┐   ┌────────────────────┐              │
│  │ NDJSON Parser  │   │ Socket.IO Client   │              │
│  │ (stdout)       │──▶│ → PizzaPi Relay    │              │
│  │ Channel 1      │   │                    │              │
│  └───────────────┘   └────────┬───────────┘              │
│                               │                           │
│  ┌───────────────┐            │   ┌────────────────────┐ │
│  │ IPC Server     │───────────┤   │ Input Injector     │ │
│  │ (unix socket)  │           │   │ (stdin → claude)   │ │
│  │ ← hooks/MCP    │           │   │ ← relay input      │ │
│  │   talk to this  │           │   └────────────────────┘ │
│  └───────────────┘            │                           │
│         ▲                     │                           │
│  ┌──────┴─────────────────────┴────────────────────────┐ │
│  │            claude CLI subprocess                     │ │
│  │  -p <initial-prompt>                                 │ │
│  │  --input-format stream-json                          │ │
│  │  --output-format stream-json                         │ │
│  │  --include-partial-messages                          │ │
│  │  --verbose                                           │ │
│  │  --replay-user-messages                              │ │
│  │  --plugin-dir <pizzapi-plugin-path>                  │ │
│  │  --permission-mode default                           │ │
│  │  --session-id <uuid>                                 │ │
│  │                                                      │ │
│  │  ┌────────────────────────────────────────────────┐  │ │
│  │  │  PizzaPi Plugin (loaded by Claude Code)         │  │ │
│  │  │                                                  │  │ │
│  │  │  🪝 Hooks (Channel 2)                           │  │ │
│  │  │    SessionStart → IPC: register                  │  │ │
│  │  │    SessionEnd → IPC: cleanup                     │  │ │
│  │  │    PreToolUse → IPC: tool about to run           │  │ │
│  │  │    PostToolUse → IPC: tool completed             │  │ │
│  │  │    PostToolUseFailure → IPC: tool failed         │  │ │
│  │  │    PermissionRequest → IPC → web UI → respond    │  │ │
│  │  │    Notification → IPC: forward                   │  │ │
│  │  │    Stop → IPC: turn complete                     │  │ │
│  │  │    SubagentStart/Stop → IPC: subagent lifecycle  │  │ │
│  │  │    UserPromptSubmit → IPC: user prompt logged    │  │ │
│  │  │    PreCompact → IPC: compaction event            │  │ │
│  │  │                                                  │  │ │
│  │  │  📦 MCP Server (Channel 3) — stdio transport     │  │ │
│  │  │    spawn_session → IPC → bridge → runner daemon  │  │ │
│  │  │    send_message → IPC → bridge → relay           │  │ │
│  │  │    wait_for_message → IPC → bridge (blocks)      │  │ │
│  │  │    check_messages → IPC → bridge                 │  │ │
│  │  │    respond_to_trigger → IPC → bridge → relay     │  │ │
│  │  │    tell_child → IPC → bridge → relay             │  │ │
│  │  │    escalate_trigger → IPC → bridge → relay       │  │ │
│  │  │    get_session_id → returns session ID            │  │ │
│  │  │    list_models → IPC → bridge → runner           │  │ │
│  │  │                                                  │  │ │
│  │  │  📋 Skills                                       │  │ │
│  │  │    PizzaPi workflow documentation                │  │ │
│  │  │    Inter-session communication guide             │  │ │
│  │  │                                                  │  │ │
│  │  │  🤖 Agents                                       │  │ │
│  │  │    (passthrough from user's agent definitions)   │  │ │
│  │  └────────────────────────────────────────────────┘  │ │
│  └──────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────┘
```

---

## Components

### 1. Bridge Process (`packages/cli/src/runner/claude-code-bridge.ts`)

The bridge is the central orchestrator. It is spawned by the runner daemon instead of `worker.ts` when a Claude Code session is requested.

**Responsibilities:**

- **Subprocess management** — Spawns `claude` CLI with appropriate flags, manages its lifecycle (startup, restart on exit code 43, graceful shutdown via SIGINT/SIGTERM).
- **NDJSON parsing (Channel 1)** — Reads newline-delimited JSON from claude's stdout. Each line is a message object with a `type` field. Translates these into PizzaPi relay events.
- **Relay connection** — Maintains a Socket.IO connection to the PizzaPi relay server (reuses patterns from `remote.ts`). Registers the session, streams events, handles heartbeats, chunked delivery for large sessions.
- **IPC server** — Listens on a Unix domain socket for messages from the plugin's hooks and MCP server. The socket path is passed to the plugin via environment variable.
- **Input injection** — Receives user input from the relay (web UI) and writes it to claude's stdin as stream-json formatted messages.
- **Interrupt/abort** — Sends SIGINT to the claude subprocess when the user clicks abort in the web UI.
- **Session state accumulation** — Maintains the full message history translated into PizzaPi's format for `session_active` snapshots.

**Environment variables received from daemon:**

| Variable | Purpose |
|---|---|
| `PIZZAPI_SESSION_ID` | Stable session identity |
| `PIZZAPI_WORKER_CWD` | Working directory |
| `PIZZAPI_API_KEY` | Relay authentication |
| `PIZZAPI_RELAY_URL` | Relay server URL |
| `PIZZAPI_WORKER_PARENT_SESSION_ID` | Parent session for child linking |
| `PIZZAPI_CC_BRIDGE_IPC` | Unix socket path for plugin IPC |
| `PIZZAPI_CC_PLUGIN_DIR` | Path to the PizzaPi plugin directory |

### 2. PizzaPi Claude Code Plugin (`packages/cli/src/claude-code-plugin/`)

A standard Claude Code plugin directory that the bridge generates/references at spawn time.

**Directory structure:**

```
claude-code-plugin/
├── .claude-plugin/
│   └── plugin.json
├── hooks/
│   └── hooks.json          # All lifecycle hooks
├── scripts/
│   ├── hook-handler.ts     # Single hook script handling all events
│   └── mcp-server.ts       # PizzaPi MCP server (stdio transport)
├── skills/
│   └── pizzapi-tools/
│       └── SKILL.md        # Documents PizzaPi-specific tools
└── .mcp.json               # MCP server configuration
```

**plugin.json:**
```json
{
  "name": "pizzapi",
  "version": "1.0.0",
  "description": "PizzaPi integration for Claude Code sessions"
}
```

#### 2a. Hook Handler (`scripts/hook-handler.ts`)

A single Bun script that handles all hook events. It reads JSON from stdin, determines the event type, and forwards relevant data to the bridge via the IPC unix socket.

**Key behaviors:**

- **SessionStart** — Sends a registration message to the bridge with the session ID and transcript path.
- **PermissionRequest** — Forwards the permission request to the bridge. The bridge relays it to the web UI. The hook script **blocks** (waits on the IPC socket) until the bridge sends back the user's decision (`allow` / `deny`). Returns the decision as JSON to Claude Code.
- **PostToolUse** — Forwards tool completion data. For `TodoWrite` calls, extracts the todo list and sends it as a dedicated todo update.
- **Stop** — Signals turn completion. Optionally reads the transcript for turn summary.
- **Notification** — Forwards notification data (type, message) for web UI display.
- **SubagentStart/SubagentStop** — Forwards subagent lifecycle events.
- **All other events** — Logged and forwarded for observability.

**IPC protocol (bridge ↔ hooks):**

The hook script connects to the Unix socket at `$PIZZAPI_CC_BRIDGE_IPC` and sends/receives newline-delimited JSON messages:

```typescript
// Hook → Bridge
interface HookEvent {
  type: "hook_event";
  event: string;           // "SessionStart", "PostToolUse", etc.
  sessionId: string;
  data: Record<string, unknown>;  // Full hook input
  requestId?: string;      // For events that need a response (PermissionRequest)
}

// Bridge → Hook (for blocking events like PermissionRequest)
interface HookResponse {
  requestId: string;
  decision: "allow" | "deny" | "ask";
  reason?: string;
}
```

#### 2b. MCP Server (`scripts/mcp-server.ts`)

A stdio-transport MCP server providing PizzaPi-specific tools. Claude Code spawns it automatically based on `.mcp.json`.

**Tools provided:**

| Tool | Description |
|---|---|
| `pizzapi_spawn_session` | Spawn a new session on the PizzaPi runner |
| `pizzapi_send_message` | Send a message to another agent session |
| `pizzapi_wait_for_message` | Wait for a message from another session |
| `pizzapi_check_messages` | Non-blocking check for pending messages |
| `pizzapi_respond_to_trigger` | Respond to a trigger from a child session |
| `pizzapi_tell_child` | Send a message to a linked child session |
| `pizzapi_escalate_trigger` | Escalate a trigger to the human viewer |
| `pizzapi_get_session_id` | Get this session's PizzaPi session ID |
| `pizzapi_list_models` | List models available on the runner |

Each tool call is forwarded to the bridge via IPC, which handles the actual relay communication and returns the result.

**`.mcp.json`:**
```json
{
  "mcpServers": {
    "pizzapi": {
      "command": "bun",
      "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/mcp-server.ts"],
      "env": {
        "PIZZAPI_CC_BRIDGE_IPC": "${PIZZAPI_CC_BRIDGE_IPC}",
        "PIZZAPI_SESSION_ID": "${PIZZAPI_SESSION_ID}"
      }
    }
  }
}
```

### 3. Runner Daemon Changes (`packages/cli/src/runner/daemon.ts`)

**New method: `spawnClaudeCodeSession()`**

Parallel to the existing `spawnWorkerSession()`. It:

1. Generates a session ID (UUID)
2. Creates the IPC socket path (`/tmp/pizzapi-cc-<session-id>.sock`)
3. Spawns the bridge process (`claude-code-bridge.ts`) with environment variables
4. Reports `session_ready` to the relay when the bridge registers successfully

**Session type flag:**

The server's spawn API accepts a new field `workerType: "pi" | "claude-code"` to determine which spawn method to use. Default is `"pi"` for backward compatibility.

### 4. Server Changes (`packages/server/`)

**Minimal changes needed:**

- The spawn session API route accepts `workerType` in the request body
- The runner namespace forwards `workerType` in the `spawn_session` event to the daemon
- Session metadata in Redis includes `workerType` for display purposes

The relay protocol is **unchanged** — the bridge translates everything into standard PizzaPi events. The server and web UI don't need to know whether events come from a pi worker or a Claude Code bridge.

### 5. Web UI Changes (`packages/ui/`)

**Minimal changes needed:**

- Session list shows a badge/icon indicating "Claude Code" vs "pi" sessions
- The "New Session" dialog offers a choice of worker type (if the runner supports Claude Code)
- Permission approval cards for PermissionRequest events (new event type from the bridge)

All existing UI components (message rendering, todo list, AskUserQuestion cards, model display, heartbeat) work unchanged because the bridge translates events into the same format.

---

## Data Flow Details

### NDJSON Event Translation (Channel 1)

Claude Code's `--output-format stream-json` emits NDJSON lines. Each line has a `type` field:

| Claude Code NDJSON type | PizzaPi relay event | Notes |
|---|---|---|
| `system` (subtype: `init`) | `session_active` | Initial session state with model info |
| `assistant` | `message_update` | Complete assistant message with content blocks |
| `user` | `message_update` | User message (when `--replay-user-messages`) |
| `result` | `agent_end` | Final result with usage, cost, duration |
| `stream_event` | Partial message updates | Token-level deltas (with `--include-partial-messages`) |

**Message format translation:**

PizzaPi expects messages in the format used by `buildSessionContext()` — an array of `{role, content}` objects. Claude Code's NDJSON messages use a compatible format (Anthropic API message structure with `role`, `content` blocks of `text`, `tool_use`, `tool_result` types).

The bridge maintains an accumulator that builds the full message history from NDJSON events, translating tool names and content block structures as needed.

### Native Tool Interception

#### TodoWrite

When Claude Code calls its built-in `TodoWrite` tool:
1. The NDJSON stream emits a `tool_use` event with `name: "TodoWrite"` and `input: { todos: [...] }`
2. The bridge extracts the todo list from the tool input
3. The bridge emits a `todo_update` PizzaPi relay event
4. The web UI renders the todo list in the sidebar

#### AskUserQuestion

When Claude Code calls its built-in `AskUserQuestion` tool:
1. The NDJSON stream emits a `tool_use` event with the question data
2. The bridge translates this into a PizzaPi `ask_user_question` event
3. The relay forwards to the web UI, which renders the interactive question card
4. The user selects an answer in the web UI
5. The relay sends the answer back to the bridge
6. The bridge writes a stream-json user message to claude's stdin with the answer
7. Claude Code receives the answer as the tool result and continues

**Important:** In `-p` mode with `--input-format stream-json`, Claude Code accepts multi-turn input. The bridge writes the user's response as a new user message, which Claude Code processes as the next turn.

#### PermissionRequest

When Claude Code encounters a tool call requiring permission:
1. The `PermissionRequest` hook fires with `tool_name` and `tool_input`
2. The hook script forwards to the bridge via IPC
3. The bridge emits a `permission_request` event to the relay
4. The web UI shows an approve/deny card with the tool details
5. The user clicks approve or deny
6. The bridge sends the decision back to the hook script via IPC
7. The hook returns `{"hookSpecificOutput": {"permissionDecision": "allow"}}` or `"deny"`
8. Claude Code proceeds or skips the tool call

#### Session Name

Claude Code's `set_session_name` (if available) or the bridge monitors the NDJSON stream for session name changes. The bridge periodically checks and broadcasts name changes via `session_active` events, similar to the existing `startSessionNameSync()` pattern.

### Inter-Session Communication (via MCP)

When Claude Code calls `pizzapi_spawn_session`:
1. The MCP server receives the tool call
2. It sends a `spawn_session` IPC message to the bridge
3. The bridge communicates with the runner daemon via the relay to spawn a new session
4. The new session's ID and share URL are returned to the MCP server
5. The MCP server returns the result to Claude Code

The trigger system works similarly — the bridge maintains the trigger registry and translates between MCP tool calls and relay events.

---

## IPC Protocol

The bridge runs a Unix domain socket server. Both the hook handler and MCP server connect to it.

**Message format:** Newline-delimited JSON over the socket.

**Bridge → Plugin messages:**

```typescript
type BridgeMessage =
  | { type: "hook_response"; requestId: string; decision: string; reason?: string }
  | { type: "mcp_response"; requestId: string; result: unknown; error?: string }
  | { type: "relay_input"; text: string; attachments?: unknown[] }
  | { type: "session_message"; fromSessionId: string; message: string }
  | { type: "trigger"; trigger: unknown }
  | { type: "shutdown" }
```

**Plugin → Bridge messages:**

```typescript
type PluginMessage =
  | { type: "hook_event"; event: string; sessionId: string; data: unknown; requestId?: string }
  | { type: "mcp_call"; tool: string; args: unknown; requestId: string }
  | { type: "ready"; component: "hooks" | "mcp" }
```

---

## Session Lifecycle

### Startup

1. Runner daemon receives `spawn_session` with `workerType: "claude-code"`
2. Daemon calls `spawnClaudeCodeSession()`:
   - Generates session ID, IPC socket path
   - Spawns bridge process with env vars
3. Bridge process starts:
   - Creates IPC Unix socket server
   - Connects to PizzaPi relay via Socket.IO
   - Registers session with relay
   - Spawns `claude` CLI subprocess with plugin dir, stream-json flags
   - Begins parsing NDJSON from stdout
4. Claude Code starts:
   - Loads PizzaPi plugin (hooks, MCP server, skills)
   - SessionStart hook fires → IPC → bridge confirms registration
   - MCP server connects to IPC socket
5. Bridge emits `session_ready` to daemon
6. Bridge emits `session_active` to relay with initial state

### Steady State

- NDJSON events flow: claude stdout → bridge → relay → web UI
- User input flows: web UI → relay → bridge → claude stdin
- Hook events flow: claude → hook script → IPC → bridge → relay
- MCP tool calls flow: claude → MCP server → IPC → bridge → relay → response → IPC → MCP → claude

### Shutdown

1. User clicks "End Session" in web UI, or claude finishes naturally
2. Bridge receives shutdown signal (or NDJSON `result` message)
3. Bridge emits `session_complete` trigger (if child session)
4. Bridge sends SIGINT to claude subprocess (if still running)
5. Claude Code's SessionEnd hook fires → cleanup
6. Bridge disconnects from relay
7. Bridge removes IPC socket
8. Bridge process exits
9. Daemon records session as killed

### Restart (exit code 43)

Claude Code uses exit code 43 to signal "restart requested" (e.g., after model change). The bridge:
1. Detects exit code 43
2. Re-spawns claude CLI with the same flags
3. Re-sends session state to relay
4. Session continues without disconnecting from the relay

---

## System Prompt Integration

The bridge injects PizzaPi's `BUILTIN_SYSTEM_PROMPT` (or a Claude-Code-adapted version) via `--append-system-prompt`. This prompt teaches Claude Code about:

- The PizzaPi MCP tools available (spawn_session, send_message, etc.)
- The trigger system and linked sessions
- Session completion conventions
- How to use AskUserQuestion effectively for the web UI

The plugin's skills provide additional context about PizzaPi workflows that Claude Code can reference on demand.

---

## Error Handling

| Scenario | Behavior |
|---|---|
| Claude CLI not found | Bridge logs error, emits `session_error` to daemon, exits |
| Claude CLI crashes | Bridge emits error event to relay, attempts restart (max 3 retries) |
| Relay connection lost | Bridge reconnects with exponential backoff (same as pi worker) |
| IPC socket unavailable | Hook scripts fail gracefully (exit 0), MCP calls return errors |
| Permission timeout | Hook script returns `deny` after 5-minute timeout |
| Large session | Same chunked delivery as pi worker (`CHUNK_THRESHOLD`, `CHUNK_SIZE`) |

---

## Testing Strategy

### Unit Tests

- NDJSON parser: test translation of every Claude Code event type to PizzaPi format
- IPC protocol: test message serialization/deserialization
- Hook handler: test each hook event type with mock IPC
- MCP server: test each tool with mock IPC responses

### Integration Tests

- End-to-end: spawn bridge → connect to relay → verify events appear in viewer
- AskUserQuestion flow: verify question appears in UI, answer flows back
- Permission flow: verify PermissionRequest → approve → tool executes
- Spawn session: verify child session creation from Claude Code session

### Manual Testing

- Side-by-side comparison: same task in pi worker vs Claude Code worker
- Verify web UI is visually indistinguishable between worker types
- Test model switching, abort, session resume

---

## Migration & Compatibility

- **No breaking changes** — existing pi workers are unaffected
- **Feature flag** — Claude Code worker support can be gated behind a config flag initially
- **Gradual rollout** — users can opt into Claude Code sessions while pi sessions remain the default
- **Protocol unchanged** — the relay protocol is not modified; the bridge translates everything

---

## Future Work

- Support for Claude Code's interactive mode (non-headless) with terminal forwarding
- Support for other CLI agents (Codex, Gemini) using the same bridge pattern
- Channels integration (Claude Code's built-in channel system as an alternative to the plugin approach)
- Claude Code's built-in worktree/git management surfaced in the PizzaPi UI
- Plugin marketplace distribution of the PizzaPi plugin
