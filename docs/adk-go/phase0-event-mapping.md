# Phase 0 — Relay/UI Event Mapping Contract

## PizzaPi Message Assumptions

> Source files:
> - `packages/ui/src/lib/message-helpers.ts`
> - `packages/ui/src/components/session-viewer/types.ts`
> - `packages/server/tests/harness/builders.ts`

### 1. Role Normalization

All relay messages are normalized through `toRelayMessage()`.  The raw `role`
field is read as-is, with one normalization:

- `tool_result` → `toolResult`
- `toolresult` → `toolResult`

All other roles pass through unchanged (e.g. `assistant`, `user`, `message`,
`compactionSummary`, `branchSummary`, `subAgentConversation`).

### 2. Message Keying (Deduplication Identity)

The UI assigns a `key` to each message using this priority chain:

| Priority | Condition | Key Format |
|----------|-----------|------------|
| 1 (highest) | `role` is `tool` or `toolResult` AND `toolCallId` present | `tool-call:{toolCallId}` |
| 2 | `id` field present | `{role}:id:{id}` |
| 3 | `toolCallId` present (non-tool role) | `{role}:tool:{toolCallId}` |
| 4 | `timestamp` present | `{role}:ts:{timestamp}` |
| 5 (lowest) | Fallback | `{role}:fallback:{fallbackId}` |

**Implication for Go wrapper:** Every emitted relay message MUST include
either a stable `id`, `toolCallId`, or `timestamp` to avoid key collisions
and enable proper deduplication.

### 3. Compaction / Branch Summary Messages

Messages with `role: "compactionSummary"` or `role: "branchSummary"` use:

| Field | Type | Purpose |
|-------|------|---------|
| `summary` | `string` | Human-readable summary text |
| `tokensBefore` | `number` | Token count before compaction (compactionSummary only) |

### 4. Streaming Partial Markers

`isStreamingPartial: true` marks tool result messages that are **in-flight**
(produced by `tool_execution_update` events).  These are synthetic streaming
updates and MUST NOT be treated as terminal results by dedup logic.

### 5. Structured Details

The `details` field preserves structured data from tool results.  Used by:
- Subagent results (`SubagentDetails`)
- Any tool that returns structured metadata alongside text output

### 6. Deduplication Rules

`deduplicateMessages()` removes no-timestamp assistant messages that are
superseded by timestamped ones.  Three heuristics:

1. **Adjacent:** No-timestamp assistant immediately followed by timestamped assistant → drop the no-timestamp one.
2. **Shared toolCallIds:** No-timestamp assistant shares a `toolCallId` with any later timestamped assistant → drop.
3. **Text prefix:** No-timestamp assistant (with no toolCallIds) whose text is a prefix of a later timestamped assistant → drop.

**Implication for Go wrapper:** Final assistant messages MUST include a
`timestamp`.  Streaming partials SHOULD omit `timestamp` so dedup works
correctly.

### 7. Protocol Event Types (from builders.ts)

The relay protocol uses these event types:

| Event Type | Builder | Shape |
|------------|---------|-------|
| `heartbeat` | `buildHeartbeat()` | `{ type, active, isCompacting, ts, model, sessionName, uptime, cwd }` |
| `message_update` | `buildAssistantMessage()` | `{ type, role: "assistant", content: [{type: "text", text}], messageId }` |
| `tool_use` block | `buildToolUseEvent()` | `{ type: "tool_use", id, name, input }` — embedded in `message_update` content |
| `tool_result` block | `buildToolResultEvent()` | `{ type: "tool_result", tool_use_id, content }` — embedded in `tool_result_message` |
| `tool_result_message` | `buildConversation()` | `{ type: "tool_result_message", content: [ToolResultBlock] }` |

### 8. RelayMessage Shape

```typescript
interface RelayMessage {
  key: string;                    // Dedup key (computed by toRelayMessage)
  role: string;                   // Normalized role
  timestamp?: number;             // Epoch ms — presence affects dedup
  content?: unknown;              // Content blocks (text, tool_use, etc.)
  toolName?: string;              // Tool name for tool messages
  toolCallId?: string;            // Links tool_use ↔ tool_result
  toolInput?: unknown;            // Tool input args
  isError?: boolean;              // Error indicator
  stopReason?: string;            // "error", "stop", "aborted", etc.
  errorMessage?: string;          // Error description when stopReason=error
  summary?: string;               // For compaction/branch summaries
  tokensBefore?: number;          // Pre-compaction token count
  details?: unknown;              // Structured metadata (subagent results, etc.)
  isStreamingPartial?: boolean;   // In-flight tool execution update
}
```

---

## Claude CLI → PizzaPi Event Mapping Table

The Claude CLI with `--output-format stream-json` emits NDJSON (one JSON
object per line).  The top-level `type` field discriminates event kinds.

### Claude CLI NDJSON Event Types

| `type` value | Description |
|-------------|-------------|
| `system` | Session init metadata: session ID, tools list, cwd, model |
| `stream_event` | Wraps Anthropic streaming API events; subtype in `event` field |
| `assistant` | Complete assistant message with all content blocks |
| `tool_use` | Tool call details: name, input, id |
| `tool_result` | Tool execution result |
| `result` | Final session result: cost, usage, session ID, duration |

### `stream_event` Subtypes

| `event` value | Description |
|---------------|-------------|
| `message_start` | New assistant turn starting |
| `content_block_start` | New content block (text or tool_use) begins |
| `content_block_delta` | Incremental content (text_delta or input_json_delta) |
| `content_block_stop` | Content block complete |
| `message_delta` | Message-level update (stop_reason, usage) |
| `message_stop` | Assistant message complete |

### Full Mapping

| Claude NDJSON Type | Go Struct | PizzaPi Relay Event | UI Consumer | Notes |
|---|---|---|---|---|
| `system` | `SystemEvent` | `heartbeat` + session_active metadata | session-viewer header, model selector | Extract `session_id`, `model`, `cwd`, `tools`. Populate initial heartbeat with `active: true`, `model`, `cwd`. |
| `stream_event` (`message_start`) | `MessageStartEvent` | (internal state) | — | Initialize message accumulator. Not directly emitted to relay. |
| `stream_event` (`content_block_start`, type=text) | `TextBlockStartEvent` | (internal state) | — | Start accumulating text block. |
| `stream_event` (`content_block_start`, type=tool_use) | `ToolStartEvent` | `message_update` with partial `tool_use` block | tool cards | Emit immediately so UI shows tool card with name before input arrives. |
| `stream_event` (`content_block_delta`, type=text_delta) | `TextDeltaEvent` | `message_update` (role: assistant, partial content) | message-item | Append to accumulated text. Emit `message_update` with current text for streaming display. |
| `stream_event` (`content_block_delta`, type=input_json_delta) | `ToolInputDelta` | `message_update` (tool_use block with partial input) | tool cards | Append to accumulated tool input JSON string. Emit `message_update` with tool_use block. |
| `stream_event` (`content_block_stop`) | `BlockStopEvent` | (internal state) | — | Finalize accumulated block. |
| `stream_event` (`message_delta`) | `MessageDeltaEvent` | (internal state) | — | Capture `stop_reason`, `usage` for final message. |
| `stream_event` (`message_stop`) | `MessageStopEvent` | (internal state) | — | Mark message complete. Prepare for `assistant` event. |
| `assistant` | `AssistantMessage` | `message_update` (role: assistant, complete) | message-item | Full assistant turn with all content blocks. MUST include `timestamp`. Supersedes any streaming partials. |
| `tool_use` | `ToolCallEvent` | Part of `message_update` assistant content | tool cards | May arrive as standalone event (non-streaming mode) or be redundant with `assistant` content blocks. Deduplicate by `toolCallId`. |
| `tool_result` | `ToolResultEvent` | `tool_result_message` | tool cards | Map `tool_use_id` → `toolCallId`. Set `role: "toolResult"`. Include `content`, `is_error`. |
| `result` | `ResultEvent` | `session_metadata_update` + final `heartbeat` | context-donut, footer, cost display | Extract `cost_usd`, `total_cost_usd`, `duration_ms`, `duration_api_ms`, `num_turns`, `session_id`. Emit heartbeat with `active: false`. |

### Accumulator State Machine

The Go wrapper MUST maintain an accumulator to assemble streaming events
into complete relay messages:

```
States:
  IDLE → MESSAGE_START → CONTENT_BLOCK → IDLE

On message_start:
  → Create new message accumulator (role: assistant)
  → Transition to MESSAGE_START

On content_block_start:
  → Add block to accumulator (text or tool_use)
  → If tool_use: emit message_update immediately (shows tool card)
  → Transition to CONTENT_BLOCK

On content_block_delta:
  → Append delta to current block
  → Emit message_update with accumulated content (streaming display)

On content_block_stop:
  → Finalize current block
  → Transition back to MESSAGE_START

On message_delta:
  → Capture stop_reason, usage on accumulator

On message_stop:
  → Transition to IDLE

On assistant (complete message):
  → Emit message_update with timestamp (final, supersedes partials)
  → Clear accumulator
```

### Heartbeat Mapping

The Go wrapper emits heartbeats at these points:

| Trigger | Heartbeat Fields |
|---------|-----------------|
| `system` event received | `active: true`, `model`, `cwd`, `sessionName: null` |
| Periodic (every 5–10s while active) | `active: true`, current model/cwd |
| `result` event received | `active: false`, final model/cwd |
| Process exit (no result) | `active: false` |

---

## Phase 0 Non-Goals (Explicitly Deferred)

These features exist in the current Bun worker but have **no Claude CLI
equivalent** — they require custom Go infrastructure built in later phases.

| Feature | Why Deferred | Phase |
|---------|-------------|-------|
| **Compaction events** | The Claude CLI may handle compaction internally, but doesn't emit compaction events. Custom Go compaction middleware needed. | Phase 1+ |
| **Trigger delivery** | Custom Go infrastructure for service triggers (time, git, etc.) to inject messages into sessions. | Phase 2+ |
| **Plan mode** | Custom Go callback loop where the agent proposes a plan and waits for approval before executing. | Phase 1+ |
| **Service metadata** | Custom Go service registry for announcing panels, tunnels, sigils to the relay. | Phase 2+ |
| **Follow-up / steering queues** | Custom Go agent loop that accepts user messages mid-session and injects them as follow-up prompts. | Phase 1+ |
| **Session tree / branching** | Custom Go session management for parent/child relationships, spawn_session, trigger forwarding. | Phase 2+ |
| **Model switching mid-session** | The Claude CLI doesn't support changing models without restarting. Would require restart-in-place with `--resume`. | Phase 1+ |
| **MCP server management** | The Claude CLI manages its own MCP servers. Go wrapper has no visibility into MCP state. | Phase 2+ |
| **Custom tool injection** | The Claude CLI uses its own tool set. Custom PizzaPi tools (subagent, spawn_session, etc.) not available. | Phase 1+ |

---

## What Must Be Stubbed

These capabilities should be **parsed and stored** from Claude CLI events but
NOT actively emitted as full relay features in Phase 0.

### Usage / Token Tracking

- **Parse:** Extract `cost_usd`, `total_cost_usd`, `duration_ms`, `duration_api_ms`,
  `num_turns` from the `result` NDJSON event.
- **Store:** Keep in session-local state for future consumption.
- **Don't emit:** Session meta events for real-time token tracking (the current
  Bun worker emits these via the `pi` agent's internal hooks — not available
  from the Claude CLI).
- **Do emit:** Final cost in the `result`-triggered heartbeat and metadata update.

### Model Change Events

- **Parse:** Read the `model` field from the `system` NDJSON event at session start.
- **Store:** Set on initial heartbeat and session metadata.
- **Don't support:** Runtime model switching (would require process restart).
- **Stub behavior:** If a model change is requested via the relay, respond with
  an error message indicating model changes require session restart.

### Session Name

- **Parse:** Not available from the Claude CLI directly.
- **Stub:** Use a generated name or accept one from the `new_session` event.
- **Future:** The Go agent loop (Phase 1+) will generate session names from
  conversation content.
