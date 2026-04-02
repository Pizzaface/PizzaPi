# Phase 0 — Claude CLI Wrapper Lifecycle Contract

## Purpose / Non-Goals

### Purpose

Document the exact contract a Go Claude CLI wrapper must satisfy to replace
the current Bun worker subprocess model.  This is the **parity target**: a
future Go implementation that satisfies every MUST in this document can
replace the Bun worker without relay, UI, or daemon changes.

### Non-Goals

This document does **not** design:

- The Go daemon process manager or relay client
- The compaction / context-overflow system
- The trigger delivery or plan-mode callback infrastructure
- The inter-session messaging protocol

It captures **what exists today** so the Go implementation has an
unambiguous specification to build against.

---

## Current Bun Runner Lifecycle

> Source files:
> - `packages/cli/src/runner/session-spawner.ts`
> - `packages/cli/src/runner/daemon.ts` (first ~920 lines)
> - `packages/protocol/src/runner.ts`

### 1. Daemon Spawns One Bun Child Process Per Session

The daemon calls Node's `spawn()` to create one child process per logical
agent session.  The child is the `worker.ts` entrypoint (or the `_worker`
subcommand in compiled-binary mode).

```
spawn(process.execPath, workerArgs, {
    env,
    stdio: ["ignore", "inherit", "inherit", "ipc"],
})
```

Key details:

- **stdin** is `"ignore"` — the worker receives its initial prompt via env var, not stdin.
- **stdout / stderr** are `"inherit"` — worker logs appear in the daemon's output.
- **fd[3]** is an IPC channel used exclusively for the `pre_restart` signal.

### 2. Session Environment Propagation

The daemon constructs the child's environment using a **denylist** approach:
forward the daemon's entire `process.env` minus a specific set of secrets and
injection vectors, then overlay session-specific vars.

#### Always-set session vars

| Env Var | Source | Purpose |
|---------|--------|---------|
| `PIZZAPI_RELAY_URL` | Daemon's resolved relay URL | Worker connects to relay |
| `PIZZAPI_API_KEY` | Per-worker API key | Worker authenticates with relay |
| `PIZZAPI_SESSION_ID` | From `new_session` event | Unique session identifier |
| `PIZZAPI_RUNNER_USAGE_CACHE_PATH` | `runnerUsageCacheFilePath()` | Shared usage/quota cache |

#### Conditionally-set session vars

| Env Var | Condition | Purpose |
|---------|-----------|---------|
| `PIZZAPI_WORKER_CWD` | `cwd` specified in `new_session` | Working directory override |
| `PIZZAPI_WORKER_INITIAL_PROMPT` | `prompt` specified | First user message |
| `PIZZAPI_WORKER_INITIAL_MODEL_PROVIDER` | `model` specified | Model provider (e.g. `anthropic`) |
| `PIZZAPI_WORKER_INITIAL_MODEL_ID` | `model` specified | Model ID (e.g. `claude-sonnet-4-20250514`) |
| `PIZZAPI_HIDDEN_MODELS` | Non-empty array | JSON array of `"provider/modelId"` strings hidden from `list_models` |
| `PIZZAPI_WORKER_PARENT_SESSION_ID` | `parentSessionId` specified | Links child → parent for trigger system |
| `PIZZAPI_WORKER_AGENT_NAME` | Agent config provided | Agent identity name |
| `PIZZAPI_WORKER_AGENT_SYSTEM_PROMPT` | Agent config provided | Agent system prompt override |
| `PIZZAPI_WORKER_AGENT_TOOLS` | Agent config provided | Agent tool allowlist |
| `PIZZAPI_WORKER_AGENT_DISALLOWED_TOOLS` | Agent config provided | Agent tool denylist |
| `PIZZAPI_WORKER_RESUME_PATH` | Resuming a session | Path to session to resume |

#### Inherited from daemon environment

All other env vars pass through **unless** they are in the denylist.
This includes provider API keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`GITHUB_TOKEN`, MCP tokens, etc.) which workers legitimately need.

### 3. Worker Environment Denylist

These vars are **stripped** from the child's environment:

| Env Var | Reason |
|---------|--------|
| `PIZZAPI_RUNNER_TOKEN` | Daemon-only relay auth token |
| `PIZZAPI_RUNNER_API_KEY` | Daemon-level API key (workers get their own) |
| `NODE_OPTIONS` | Code injection via `--require` |
| `BUN_OPTIONS` | Code injection via `--preload` |
| `LD_PRELOAD` | Shared-library injection (Linux) |
| `DYLD_INSERT_LIBRARIES` | Shared-library injection (macOS) |
| `DYLD_FORCE_FLAT_NAMESPACE` | macOS dyld override |

### 4. Restart-In-Place (Exit Code 43)

The worker signals a restart request by:

1. Sending `{ type: "pre_restart" }` over the IPC channel (fd[3])
2. Calling `process.exit(43)`

The daemon handles this as:

1. On IPC message: add `sessionId` to `restartingSessions` set **synchronously**
   (before the process exits, before any relay events arrive).
2. On child exit with code 43: call `doSpawn()` to re-spawn under the **same
   session ID** — unless `killedSessions` contains this ID.
3. The `restartingSessions` guard prevents the relay's `session_ended` event
   (fired when the new worker tears down the old connection) from cleaning up
   the session entry prematurely.

Session attachments (`~/.pizzapi/session-attachments/{sessionId}`) are
**preserved** across restarts — they are only cleaned up on true termination.

### 5. Runner Protocol Events

The daemon emits these events to the relay over Socket.IO `/runner` namespace:

| Event | When | Payload |
|-------|------|---------|
| `session_ready` | Worker successfully started | `{ sessionId }` |
| `session_error` | Worker failed to start | `{ sessionId, message }` |
| `session_killed` | Worker killed via `kill_session` | `{ sessionId }` |
| `runner_session_event` | Worker forwards an agent event | `{ sessionId, event }` |
| `disconnect_session` | Request relay disconnect adopted session | `{ sessionId }` |

### 6. Session Adoption

When the daemon restarts, the relay may still have active worker connections
from the previous daemon instance.  On `runner_registered`, the relay sends
`existingSessions` — an array of `{ sessionId, cwd }` for orphaned sessions.

The daemon adopts these by creating `RunnerSession` entries with:
- `child: null` (no process handle — the old worker is still running independently)
- `adopted: true`

Adopted sessions:
- Cannot be killed via `child.kill()` — the daemon instead emits `disconnect_session`
  to ask the relay to force-disconnect the worker's socket.
- Are cleaned up when `session_ended` arrives from the relay.

### 7. Kill Semantics

```
kill_session(sessionId)
  → killedSessions.add(sessionId)           // prevents exit-43 respawn race
  → entry.child.kill("SIGTERM")              // for spawned sessions
  → socket.emit("disconnect_session", ...)   // for adopted sessions
  → runningSessions.delete(sessionId)
  → socket.emit("session_killed", ...)
  → cleanupSessionAttachments(sessionId)
```

The `killedSessions` set is critical: if the worker calls `process.exit(43)`
(restart-in-place) **before** SIGTERM is delivered, the exit handler checks
`killedSessions` and refuses to respawn — preventing zombie sessions.

---

## Required Go Wrapper Lifecycle Semantics

### One Claude subprocess per logical agent session

Phase 0 wraps the `claude` CLI binary (one process per session), communicating
via `--output-format stream-json` (NDJSON on stdout).

```
claude --output-format stream-json \
       --model <model> \
       --prompt <initial-prompt> \
       [--resume <session-id>] \
       [--continue]
```

### Typed event channel

The Go wrapper MUST expose a typed event channel:

```go
type ClaudeWrapper struct {
    Events  <-chan ClaudeEvent  // consumer reads parsed NDJSON events
    Done    <-chan error         // signals process exit + exit code
}
```

This channel is consumed by the future Go session host (Phase 1+), which
translates events into PizzaPi relay messages.

### Graceful stop / forced kill

| Operation | Behavior |
|-----------|----------|
| Graceful stop | Send `SIGTERM` → wait up to N seconds → `SIGKILL` if still alive |
| Forced kill | Immediate `SIGKILL`, no grace period |

The wrapper MUST drain remaining stdout after `SIGTERM` before closing the
`Events` channel — the CLI may emit a final `result` event during shutdown.

### Resume support

| Flag | Behavior |
|------|----------|
| `--resume <session-id>` | Resume a specific prior session by Claude's internal session ID |
| `--continue` | Resume the most recent session in the working directory |

The wrapper reads the Claude session ID from the initial `system` NDJSON event
and exposes it for the session host to track.

### Parser failure semantics

- Malformed NDJSON lines (not valid JSON) MUST be logged as warnings but
  MUST NOT crash the wrapper or close the `Events` channel.
- Lines with an unrecognized `type` field MUST be forwarded as a generic
  `UnknownEvent` struct so no data is silently dropped.
- Empty lines MUST be silently skipped (the CLI may emit trailing newlines).

---

## Session Ownership / Restart / Kill Semantics

### Restart-in-place

The Go equivalent of exit-code-43 restart:

1. The session host detects a restart condition (model change, config reload, etc.)
2. The wrapper's `Stop()` method is called, draining the current process.
3. A **new** wrapper instance is created with the same session ID (via `--resume`).
4. The session host swaps the old wrapper for the new one, keeping the same
   session ID and relay connection.

MUST: The session ID MUST be preserved across restarts.
MUST: The relay connection MUST NOT be torn down during restart.
MUST: Session-local state (attachments, cwd) MUST survive restart.

### Kill prevents respawn

When a kill is requested:

1. Set a `killed` flag on the session **before** sending any signal.
2. Send `SIGTERM` (or `SIGKILL` for forced kill).
3. On process exit, check the `killed` flag — if set, do NOT restart regardless
   of exit code.
4. Clean up session resources (attachments, cwd tracking).

### Adopted sessions

After a Go daemon restart, sessions from the prior daemon instance may still
be running.  The Go daemon MUST:

1. Accept `existingSessions` from the relay's `runner_registered` response.
2. Create session entries with no process handle (`adopted` flag).
3. Kill adopted sessions by requesting relay disconnect (`disconnect_session`).
4. Clean up adopted sessions when `session_ended` arrives from the relay.

---

## Environment / Config Inputs

### Vars set on the `claude` subprocess by the Go wrapper

The Go wrapper sets these on the Claude CLI subprocess's environment.
Not all are Claude CLI flags — some are consumed by PizzaPi-specific
middleware that may run alongside or be injected later.

| Env Var | Source | Required? |
|---------|--------|-----------|
| `PIZZAPI_RELAY_URL` | Daemon config / env | Yes |
| `PIZZAPI_API_KEY` | Per-session key from relay | Yes |
| `PIZZAPI_SESSION_ID` | From `new_session` event | Yes |
| `PIZZAPI_RUNNER_USAGE_CACHE_PATH` | Daemon runtime | Yes |
| `PIZZAPI_WORKER_CWD` | `new_session` cwd field | If specified |
| `PIZZAPI_WORKER_INITIAL_PROMPT` | `new_session` prompt field | If specified |
| `PIZZAPI_WORKER_INITIAL_MODEL_PROVIDER` | `new_session` model field | If specified |
| `PIZZAPI_WORKER_INITIAL_MODEL_ID` | `new_session` model field | If specified |
| `PIZZAPI_HIDDEN_MODELS` | `new_session` hiddenModels field | If non-empty |
| `PIZZAPI_WORKER_PARENT_SESSION_ID` | `new_session` parentSessionId | If specified |
| `PIZZAPI_WORKER_AGENT_NAME` | `new_session` agent config | If specified |
| `PIZZAPI_WORKER_AGENT_SYSTEM_PROMPT` | `new_session` agent config | If specified |
| `PIZZAPI_WORKER_AGENT_TOOLS` | `new_session` agent config | If specified |
| `PIZZAPI_WORKER_AGENT_DISALLOWED_TOOLS` | `new_session` agent config | If specified |
| `PIZZAPI_WORKER_RESUME_PATH` | `new_session` resume path | If resuming |
| `ANTHROPIC_API_KEY` | Inherited from daemon env | Provider auth |
| `OPENAI_API_KEY` | Inherited from daemon env | Provider auth |

### Vars that MUST NOT be inherited

Same denylist as the current Bun implementation (see §3 above).

### Config file inputs

| Config | Path | Purpose |
|--------|------|---------|
| PizzaPi global config | `~/.pizzapi/config.json` | `relayUrl`, `apiKey`, model defaults |
| PizzaPi agent dir | `~/.pizzapi/` | Skills, agents, hooks, AGENTS.md |
| Claude CLI config | `~/.claude/` | Claude's own settings, session history |

---

## Open Questions

### Does `claude --resume` work reliably for long-running sessions?

The Claude CLI maintains session state in `~/.claude/projects/`.  It is
unclear whether `--resume` handles sessions that have been idle for hours or
days, or whether internal state (MCP connections, tool handles) is properly
restored.

**Action:** Empirical testing required before Phase 0 ship.

### Does `--output-format stream-json` emit events for ALL tool calls?

The Claude CLI documentation says stream-json emits tool_use and tool_result
events.  It is not confirmed whether:
- MCP tool calls produce the same event shape
- Custom tools (bash, read, write, etc.) vs MCP tools have different schemas
- Tool execution updates (streaming partial results) are emitted

**Action:** Capture NDJSON output for various tool types and compare.

### Can stdin be used to send follow-up prompts mid-session?

The current Bun worker uses the `pi` agent's input handling.  The Claude CLI
in `--output-format stream-json` mode may accept follow-up prompts on stdin
after a `result` event.  If not, each "turn" would require a new process
invocation with `--resume`.

**Action:** Test stdin behavior in stream-json mode.

### What happens on context overflow?

When the conversation exceeds the model's context window:
- Does the CLI handle compaction internally?
- Does it emit a specific error event?
- Does it exit with a specific exit code?

The current Bun worker has custom compaction logic.  The Go wrapper may need
to detect overflow and implement its own compaction via `--resume` with a
compacted conversation.

**Action:** Test with conversations approaching context limits.

---

## Go Event Type Catalog

These are design-level type sketches — illustrative Go structs defining the
types the Phase 0 prototype will implement.  They are intentionally narrow,
covering only fields PizzaPi needs to relay and render sessions.

The Claude CLI `--output-format stream-json` emits NDJSON (newline-delimited
JSON).  Each line is a JSON object with a `type` discriminator field.

### First-Pass Decode

```go
// RawEvent is the first-pass decode of any NDJSON line.
// Two-phase parsing: decode "type" to route, then decode into the specific struct.
type RawEvent struct {
    Type string          `json:"type"`
    Raw  json.RawMessage `json:"-"` // preserved for unknown event fallback
}
```

### Session Events

```go
// SystemEvent — session initialization metadata.
// Emitted once at the start of a session.
type SystemEvent struct {
    Type      string   `json:"type"` // "system"
    SessionID string   `json:"session_id"`
    Tools     []string `json:"tools"`
    Cwd       string   `json:"cwd"`
    Model     string   `json:"model"`
}

// AssistantMessage — complete assembled assistant turn.
// Emitted after all streaming deltas for a turn have been received.
type AssistantMessage struct {
    Type    string          `json:"type"` // "assistant"
    Message json.RawMessage `json:"message"` // full Anthropic message object
}

// ResultEvent — final session summary, emitted when the session ends.
type ResultEvent struct {
    Type      string  `json:"type"` // "result"
    SessionID string  `json:"session_id"`
    Cost      float64 `json:"cost_usd"`
    Duration  float64 `json:"duration_secs"`
    Usage     struct {
        InputTokens  int `json:"input_tokens"`
        OutputTokens int `json:"output_tokens"`
    } `json:"usage"`
}
```

### Anthropic Streaming Events

These are wrapped inside `StreamEvent` — the outer NDJSON line has
`"type": "stream_event"` and an inner `"event"` object with Anthropic's
streaming API event.

```go
// StreamEvent wraps Anthropic streaming API events.
type StreamEvent struct {
    Type  string          `json:"type"` // "stream_event"
    Event json.RawMessage `json:"event"`
}

// --- Anthropic streaming subtypes (inner event shapes) ---

type MessageStart struct {
    Type    string `json:"type"` // "message_start"
    Message struct {
        ID    string `json:"id"`
        Role  string `json:"role"`
        Model string `json:"model"`
        Usage struct {
            InputTokens  int `json:"input_tokens"`
            OutputTokens int `json:"output_tokens"`
        } `json:"usage"`
    } `json:"message"`
}

type ContentBlockStart struct {
    Type         string `json:"type"` // "content_block_start"
    Index        int    `json:"index"`
    ContentBlock struct {
        Type string `json:"type"` // "text" or "tool_use"
        Text string `json:"text,omitempty"`
        ID   string `json:"id,omitempty"`
        Name string `json:"name,omitempty"`
    } `json:"content_block"`
}

type ContentBlockDelta struct {
    Type  string `json:"type"` // "content_block_delta"
    Index int    `json:"index"`
    Delta struct {
        Type        string `json:"type"` // "text_delta" or "input_json_delta"
        Text        string `json:"text,omitempty"`
        PartialJSON string `json:"partial_json,omitempty"`
    } `json:"delta"`
}

type ContentBlockStop struct {
    Type  string `json:"type"` // "content_block_stop"
    Index int    `json:"index"`
}

type MessageDelta struct {
    Type  string `json:"type"` // "message_delta"
    Delta struct {
        StopReason string `json:"stop_reason"`
    } `json:"delta"`
    Usage struct {
        OutputTokens int `json:"output_tokens"`
    } `json:"usage"`
}
```

### Tool Events

```go
// ToolUseEvent — emitted when the assistant invokes a tool.
// Note: In the streaming protocol, tool calls also appear as
// ContentBlockStart (type=tool_use) + ContentBlockDelta (input_json_delta).
// This top-level event may be a post-hoc summary.
type ToolUseEvent struct {
    Type  string          `json:"type"` // "tool_use"
    ID    string          `json:"id"`
    Name  string          `json:"name"`
    Input json.RawMessage `json:"input"`
}

// ToolResultEvent — emitted after a tool completes execution.
type ToolResultEvent struct {
    Type      string          `json:"type"` // "tool_result"
    ToolUseID string          `json:"tool_use_id"`
    Content   json.RawMessage `json:"content"`
    IsError   bool            `json:"is_error,omitempty"`
}
```

### Fallback / Error Types

```go
// UnknownEvent — fallback for unrecognized event types.
// The parser MUST forward these rather than silently dropping them.
type UnknownEvent struct {
    Type string          `json:"type"`
    Raw  json.RawMessage `json:"-"`
}

// ParseError — structured error for malformed NDJSON lines.
// Malformed lines MUST NOT crash the parser or close the event channel.
type ParseError struct {
    Line    string `json:"line"`
    Offset  int    `json:"offset"`
    Message string `json:"message"`
}
```

---

## Validation Questions

These are questions the Phase 0 prototype must answer empirically.  Each maps
to a concrete test the prototype should run against a live Claude CLI.

1. Does `claude --output-format stream-json` emit stable event discriminators across versions?
2. Can we distinguish partial vs final assistant output reliably?
3. Can tool calls be intercepted/customized, or only observed?
4. Does `--resume <session-id>` preserve enough session identity for PizzaPi?
5. What appears on stdout vs stderr during failures (auth errors, network errors, context overflow)?
6. Does the `system` event always include the full tools list?
7. Are `assistant` and `result` events always emitted, or only under certain flags?
8. Does `--include-partial-messages` affect the event types or just add more deltas?
9. Can `--input-format stream-json` on stdin send follow-up prompts mid-session?
10. What is the exact process exit code on success vs failure vs context overflow?

## Prototype Verdict

**Status: Viable — proceed to Phase 0 implementation**

### What Worked

1. **NDJSON parser** — Two-phase decode (discriminator → typed struct) handles all known Claude CLI stream-json event types. Table-driven tests cover 13 event shapes including unknown-event tolerance and malformed-line recovery.

2. **PizzaPi relay adapter** — Maps parsed Claude events to PizzaPi's relay event shapes (heartbeat, message_update, tool_result_message, session_metadata_update). Accumulator state machine handles streaming text assembly and tool input buffering correctly. 8 test cases covering the full conversation lifecycle.

3. **Subprocess lifecycle** — Go wrapper manages process start, stop (context cancellation), stderr collection, and exit code tracking. Integration tested with real subprocess (bash) emitting fake NDJSON. Context cancellation kills the process within expected bounds.

4. **Event fidelity** — The adapter produces JSON shapes compatible with PizzaPi's existing web UI expectations (role normalization, toolCallId keying, timestamp injection, content block assembly). The shapes match what `packages/ui/src/lib/message-helpers.ts` and `packages/server/tests/harness/builders.ts` expect.

### What Remains Unknown

1. **Live Claude CLI validation** — All tests use synthetic NDJSON fixtures. The prototype has not been tested against actual `claude --output-format stream-json` output. Field names, nesting, and optional fields may differ from assumptions.

2. **Bidirectional communication** — `--input-format stream-json` is undocumented (see Anthropic issue #24594). Follow-up prompt injection via stdin is unvalidated.

3. **Custom tool injection** — The CLI handles tool execution internally. PizzaPi's custom tools (plan_mode, AskUserQuestion, subagent, spawn_session, etc.) cannot be injected through the CLI wrapper alone. This is the highest-risk open question.

4. **Session resume reliability** — `--resume <session-id>` behavior under long interruptions, session size limits, and cross-version compatibility is unknown.

5. **Streaming partial fidelity** — Whether `--include-partial-messages` changes the event types or just adds more granular deltas is unconfirmed.

### Decision Point

The prototype proves the observation/parsing/adaptation pipeline is sound. The next decision is:

- **If custom tool injection is NOT required for Phase 0**: Proceed with CLI wrapper for built-in tools, custom tools via separate channel later.
- **If custom tool injection IS required**: Evaluate Anthropic API direct integration or hybrid architecture (CLI for sessions + API for custom tools).

This decision blocks the architecture of the Phase 0 prototype (idea L5IOag95) and must be made before implementation begins.
