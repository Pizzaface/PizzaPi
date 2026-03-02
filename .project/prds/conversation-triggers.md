---
name: conversation-triggers
description: Declarative event-driven triggers that let agent sessions react to lifecycle events, monitoring conditions, and custom pub/sub signals across sessions on the same runner
status: backlog
created: 2026-03-02T15:37:15Z
---

# PRD: Conversation Triggers

## Executive Summary

PizzaPi's inter-session messaging today is entirely pull-based — agents must actively call `wait_for_message` (blocking) or `check_messages` (polling) to receive communication from other sessions. This creates a fundamental gap: **agents can only converse when they voluntarily stop working to listen**.

Conversation Triggers introduce a declarative, event-driven mechanism that lets sessions register interest in specific events and automatically receive notifications when those events fire. Triggers are **session-based and runner-locked** — they can only watch and fire for sessions on the same runner, keeping the blast radius contained and avoiding cross-server complexity.

This enables three core capabilities:
1. **Orchestration** — Parent agents react when child sessions complete without blocking
2. **Monitoring** — Watch for well-known conditions like cost thresholds, errors, or idle states
3. **Pub/Sub Coordination** — Sessions broadcast custom events that peers with matching triggers receive

Combined with a new **inject** delivery mode (context automatically prepended to the agent's next turn), triggers make multi-agent workflows reactive instead of poll-based.

## Problem Statement

### Current State

When a parent agent spawns child sessions today, it has two options for getting results back:

1. **Blocking wait**: `wait_for_message(childSessionId)` — the parent does nothing until the child responds. With multiple children, waits are sequential (can't react to whichever finishes first).

2. **Polling**: Repeatedly call `check_messages()` between work steps — wasteful, adds latency, and clutters the agent's tool call history.

Neither approach scales to real multi-agent workflows where a parent orchestrates 3-5+ parallel sub-agents and needs to react incrementally as each completes.

Additionally, there is no way to:
- Get notified when a session hits an error or exceeds a cost threshold
- Broadcast coordination signals between peer sessions (e.g., "the build broke, stop deploying")
- Subscribe to system-level events without continuous polling

### Why Now

PizzaPi already has the infrastructure for multi-agent work: `spawn_session`, inter-session messaging via the relay, and the runner daemon managing worker processes. The messaging primitives work but are too low-level for practical orchestration. As users adopt parallel agent workflows, the lack of reactive triggers is the primary friction point.

## User Stories

### Persona: Power User (Multi-Agent Orchestrator)

**US-1: Fan-Out/Fan-In Orchestration**
> As a parent agent orchestrating parallel sub-agents, I want to register a trigger that fires when any of my spawned sessions finishes, so I can react to each completion incrementally without blocking.

Acceptance Criteria:
- Parent registers a trigger for `session_ended` targeting spawned child session IDs
- When a child session ends, the parent receives a notification with the child's session ID
- Parent can continue doing work while waiting — notification arrives via inject delivery on the next turn
- Works for 1-N child sessions with a single trigger registration (wildcard or list)

**US-2: Error Monitoring**
> As a parent agent, I want to be notified immediately when any of my child sessions encounters an error, so I can decide whether to retry, abort, or reassign work.

Acceptance Criteria:
- Parent registers a `session_error` trigger scoped to the current runner
- When any session on the runner emits a CLI error or provider error, the trigger fires
- Notification includes the erroring session ID and error message
- Trigger can optionally filter to specific session IDs

**US-3: Cost Threshold Alerts**
> As a session owner, I want to set a cost threshold trigger so my session is alerted when cumulative spend across my spawned sessions exceeds a limit.

Acceptance Criteria:
- Register a `cost_exceeded` trigger with a dollar threshold
- System evaluates against heartbeat data from sessions on the same runner
- Fires once when the threshold is crossed (one-shot by default)
- Notification includes the current cost and which session(s) contributed

**US-4: Custom Event Coordination**
> As a peer agent in a multi-agent workflow, I want to emit custom events (e.g., "build_complete", "tests_passing") that other sessions on the same runner can subscribe to.

Acceptance Criteria:
- Session A emits `emit_event("build_complete", { status: "success" })`
- Session B, which registered a trigger for custom event `"build_complete"`, receives the notification
- Payload data from the event is included in the notification message
- Works between any sessions on the same runner under the same user

**US-5: Session Idle Detection**
> As a monitoring session, I want to be notified when a specific session becomes idle (finishes its agent loop), so I can send it follow-up work.

Acceptance Criteria:
- Register a `session_idle` trigger targeting a specific session ID
- Fires when the target session's heartbeat transitions from `active: true` to `active: false`
- Can be configured as recurring (fire every time it goes idle) or one-shot

### Persona: Web UI User

**US-6: Trigger Visibility**
> As a PizzaPi web user, I want to see active triggers for the sessions I'm viewing, so I understand what automation is configured and when triggers have fired.

Acceptance Criteria:
- Basic "Triggers" panel in the session viewer showing active triggers
- Each trigger shows: type, target, delivery mode, firing count, last fired timestamp
- Trigger firing history is visible (last N firings)
- Panel updates in real-time as triggers are registered/fired/cancelled

## Requirements

### Functional Requirements

#### FR-1: Trigger Registry (Server-Side)

A `TriggerRegistry` service on the relay server manages trigger lifecycle:

- **Register**: Create a new trigger with type, config, delivery mode, and constraints
- **Evaluate**: On each relevant event, check all registered triggers for matches
- **Fire**: When a trigger matches, deliver the notification via the configured mode
- **Cancel**: Remove a trigger by ID
- **List**: Return all triggers owned by a session
- **Expire**: Auto-remove triggers when `maxFirings` is reached or `expiresAt` passes
- **Cleanup**: Remove all triggers when the owning session disconnects

Backed by Redis for persistence across server restarts.

#### FR-2: Trigger Types

Well-known trigger conditions (simple, fixed set — no custom expressions):

| Trigger Type | Fires When | Config Fields |
|---|---|---|
| `session_ended` | Target session(s) disconnect / end | `sessionIds: string[]` or `"*"` (all on runner) |
| `session_idle` | Target session transitions active→idle | `sessionIds: string[]` or `"*"` |
| `session_error` | Target session emits a CLI or provider error | `sessionIds: string[]` or `"*"` |
| `cost_exceeded` | Cumulative cost across target sessions exceeds threshold | `sessionIds: string[]` or `"*"`, `threshold: number` |
| `custom_event` | A session emits a named custom event | `eventName: string`, `fromSessionIds: string[]` or `"*"` |
| `timer` | Fixed delay or recurring interval elapses | `delaySec: number`, `recurring?: boolean` |

#### FR-3: Delivery Modes

| Mode | Behavior | Use Case |
|---|---|---|
| `queue` | Notification added to the session's message queue (existing `messageBus.receive()`) | Agent picks it up via `check_messages` / `wait_for_message` |
| `inject` | Notification prepended as context to the agent's next turn (via `before_agent_start` hook) | Agent sees it automatically without polling — the key unlock for reactive workflows |

Both modes include a formatted message with trigger metadata (type, source session, payload).

#### FR-4: Agent Tools

New tools registered by a `conversation-triggers.ts` extension:

- **`register_trigger`** — Register a new trigger. Returns trigger ID.
  - Parameters: `type`, `config`, `delivery` (default: `"inject"`), `message` (template), `maxFirings`, `expiresAt`
- **`cancel_trigger`** — Cancel an active trigger by ID.
- **`list_triggers`** — List all triggers owned by this session.
- **`emit_event`** — Emit a custom event (for other sessions' `custom_event` triggers).
  - Parameters: `eventName`, `payload` (optional JSON object)

#### FR-5: Runner-Locked Scope

**All triggers are locked to the runner where the owning session lives.**

- A trigger can only watch sessions that are registered on the same runner
- Custom events are only visible to sessions on the same runner
- The server enforces this by filtering trigger evaluation to the runner's session set
- No cross-runner trigger registration, event delivery, or session messaging
- Sessions can message/trigger sessions they spawned (which are always on the same runner)
- A session's triggers are identified by the session's runner ID, stored in the trigger record

#### FR-6: Session-Based Ownership

- Triggers are owned by the session that registered them
- A session can only cancel/list its own triggers
- When a session disconnects, all its triggers are automatically cleaned up
- The `register_trigger` tool validates that target session IDs (if specific) are on the same runner

#### FR-7: Structured Message Payloads

Trigger notifications use a structured envelope (not raw strings):

```typescript
interface TriggerNotification {
  triggerId: string;
  triggerType: TriggerType;
  message: string;           // Human-readable, from template
  sourceSessionId?: string;  // Session that caused the trigger to fire
  payload?: unknown;         // Type-specific data (error message, cost, custom event payload)
  firedAt: string;           // ISO timestamp
}
```

The `message` field supports simple template interpolation: `{sessionId}`, `{eventName}`, `{payload}`, `{cost}`, `{error}`.

#### FR-8: Web UI Trigger Panel

Basic trigger visibility in the session viewer:

- Show active triggers for the viewed session (type, target, delivery, firing count)
- Show recent firing history (last 10 per trigger)
- Real-time updates via heartbeat or dedicated `trigger_update` events
- Read-only in v1 (no UI for creating/cancelling triggers — that's agent-only)

#### FR-9: Protocol Events

New Socket.IO events in the `/relay` namespace:

**Client → Server:**
- `register_trigger` — Register a trigger (validated server-side)
- `cancel_trigger` — Cancel a trigger by ID
- `list_triggers` — Request trigger list for this session
- `emit_custom_event` — Publish a custom event to the runner's sessions

**Server → Client:**
- `trigger_registered` — Confirm registration with trigger ID
- `trigger_cancelled` — Confirm cancellation
- `trigger_list` — Response with active triggers
- `trigger_fired` — Notification that a trigger matched and fired
- `trigger_error` — Error registering/cancelling a trigger

### Non-Functional Requirements

#### NFR-1: Performance
- Trigger evaluation must not block the main event pipeline
- Heartbeat-based triggers (cost_exceeded, session_idle) are evaluated at heartbeat frequency (every 10s) — not on every event
- Event-based triggers (session_ended, session_error, custom_event) are evaluated inline but must complete in <10ms
- Timer triggers use server-side `setTimeout`/`setInterval`, not polling

#### NFR-2: Reliability
- Triggers are persisted in Redis and survive server restarts
- On server restart, active triggers are rehydrated and timer triggers are rescheduled
- If a target session is temporarily disconnected, trigger firings for `queue` delivery are buffered (up to 100 per session) and delivered on reconnect
- `inject` delivery notifications are held until the next agent turn starts

#### NFR-3: Scalability
- Support up to 100 active triggers per session
- Support up to 1000 active triggers per runner
- Trigger evaluation should be O(triggers_for_event_type), not O(all_triggers)
- Index triggers by type and runner ID for fast lookup

#### NFR-4: Security
- Runner-lock enforcement is server-side (cannot be bypassed by a malicious client)
- A session can only register triggers for sessions on its own runner
- API key / user identity is validated on trigger registration
- Custom event names are namespaced by runner ID to prevent cross-runner leakage

#### NFR-5: Observability
- Server logs trigger registrations, firings, and errors at info level
- Trigger firing count and last-fired timestamp are included in heartbeat data
- Web UI panel provides real-time visibility without log access

## Success Criteria

| Metric | Target |
|---|---|
| Fan-out/fan-in orchestration with 3+ sub-agents works without `wait_for_message` blocking | Demonstrated in integration test |
| Trigger evaluation latency (event-based) | p99 < 10ms |
| Trigger evaluation latency (heartbeat-based) | Evaluated within one heartbeat cycle (10s) |
| Trigger persistence survives server restart | Verified in integration test |
| Zero triggers leak across runners | Verified by security test |
| Web UI shows trigger state within 2s of change | Verified manually |
| Agent can register, fire, and receive trigger notification in < 3 tool calls | Demonstrated in workflow test |

## Constraints & Assumptions

### Constraints

- **Single relay server**: The current architecture runs one relay server instance. Triggers are evaluated on this single server. Multi-server relay (Redis Streams cross-server routing) is out of scope.
- **No steer delivery in v1**: Interrupting agents mid-turn is risky and deferred to a future iteration.
- **pi agent core is a dependency**: Inject delivery depends on `before_agent_start` hook or equivalent in the pi agent core. If this hook point doesn't exist or doesn't support injecting context, inject delivery will need an alternative approach (e.g., prepending to the next user message).
- **Redis required**: The trigger registry requires Redis, which is already a server dependency.

### Assumptions

- Sessions on the same runner share a user/API key (enforced by the runner daemon)
- The runner daemon's `POST /api/runners/spawn` always places child sessions on the same runner as the parent
- Heartbeat events continue to be emitted every 10s and contain `tokenUsage`, `active`, and `cwd` fields
- The existing `session_message` relay pathway is reliable for same-server delivery
- Agent LLMs can understand and use 4 new tools (`register_trigger`, `cancel_trigger`, `list_triggers`, `emit_event`) with clear descriptions

## Out of Scope

- **Cross-runner triggers**: Triggers that watch or fire across different runners. Requires Redis pub/sub plumbing and cross-runner session discovery.
- **Steer delivery mode**: Interrupting an agent mid-turn with a trigger notification. Deferred due to risk of confusing agent context.
- **Custom predicate expressions**: No user-defined expressions like `"cost > 5.0 AND active == false"`. Only well-known trigger types with fixed conditions.
- **Trigger chaining**: Automatic trigger-fires-trigger cascades. Users can achieve this manually by having a trigger notification cause an agent to register a new trigger.
- **Message delivery guarantees for existing messaging**: The current `send_message`/`wait_for_message` system remains as-is. No ACKs, no persistence, no retry.
- **Cross-server message routing**: `getLocalTuiSocket()` limitation remains. Messages and triggers only work within a single server process.
- **Trigger creation from the web UI**: v1 is agent-only trigger management. The web UI is read-only for triggers.
- **File-change triggers**: Watching filesystem events. Too complex for v1 and would require a file watcher daemon.

## Dependencies

### Internal

| Dependency | Description |
|---|---|
| `packages/protocol` | New Socket.IO event types for trigger registration/firing |
| `packages/server` (relay namespace) | Trigger registry, evaluation engine, timer scheduler |
| `packages/server` (Redis) | Trigger persistence and rehydration |
| `packages/cli` (extensions) | New `conversation-triggers.ts` extension with agent tools |
| `packages/cli` (remote extension) | Wire trigger events through the relay connection, inject delivery integration |
| `packages/cli` (message bus) | Extend `SessionMessage` to carry structured trigger notification metadata |
| `packages/ui` (session viewer) | New trigger panel component |
| `pi` agent core | `before_agent_start` hook (or equivalent) for inject delivery |

### External

| Dependency | Description |
|---|---|
| Redis | Trigger persistence (already required by server) |
| Socket.IO | Transport for trigger events (already in use) |

## Technical Notes

### Trigger Registry Data Model (Redis)

```
Key: triggers:{runnerId}:{triggerId}
Value: JSON TriggerRecord

Index: triggers:by-runner:{runnerId} → Set of triggerIds
Index: triggers:by-session:{sessionId} → Set of triggerIds
Index: triggers:by-type:{runnerId}:{triggerType} → Set of triggerIds
```

### Inject Delivery Mechanism

When a trigger fires with `inject` delivery:
1. Server sends `trigger_fired` to the owning session's Socket.IO socket
2. CLI remote extension receives it and stores the notification in an `injectQueue`
3. On the next `before_agent_start` event (or next user message processing), the queued notifications are formatted and prepended as system context
4. If the agent is currently idle (not in a turn), the inject is held until the next turn starts

### Evaluation Pipeline

```
Event arrives at relay server
  ↓
Identify event type → map to trigger types to check
  ↓
Look up triggers by (runnerId, triggerType) from Redis index
  ↓
For each matching trigger:
  - Validate still active (not expired, not exceeded maxFirings)
  - Evaluate condition (e.g., sessionId match, cost threshold)
  ↓
For each trigger that fires:
  - Increment firing count
  - Record last-fired timestamp
  - Format notification message (template interpolation)
  - Deliver via configured mode (queue → session_message, inject → trigger_fired)
  - If maxFirings reached → auto-expire trigger
```

### Migration Path

This feature is purely additive. No changes to existing messaging behavior. Existing `send_message`/`wait_for_message`/`check_messages` tools continue to work unchanged. Agents that don't use triggers see no difference.

## Appendix: Example Workflows

### A. Fan-Out/Fan-In with 3 Sub-Agents

```
Parent:
  1. get_session_id → "parent-001"
  2. spawn_session("Implement auth module") → "child-A"
  3. spawn_session("Write API tests") → "child-B"
  4. spawn_session("Update docs") → "child-C"
  5. register_trigger({
       type: "session_ended",
       config: { sessionIds: ["child-A", "child-B", "child-C"] },
       delivery: { mode: "inject" },
       message: "Sub-agent {sourceSessionId} has finished.",
       maxFirings: 3
     })
  6. Continue working on other tasks...

  [child-A finishes]
  → Next turn, parent sees injected context:
    "[Trigger] Sub-agent child-A has finished."
  → Parent: check_messages("child-A") to get detailed results

  [child-C finishes]
  → Next turn: "[Trigger] Sub-agent child-C has finished."

  [child-B finishes]
  → Next turn: "[Trigger] Sub-agent child-B has finished."
  → Parent: "All 3 sub-agents complete. Merging results..."
```

### B. Cost Monitoring

```
Monitoring session:
  1. register_trigger({
       type: "cost_exceeded",
       config: { sessionIds: "*", threshold: 10.0 },
       delivery: { mode: "inject" },
       message: "⚠️ Cost threshold exceeded: ${cost} across runner sessions.",
       maxFirings: 1
     })
  2. Do other work...

  [cumulative cost hits $10.23]
  → Next turn: "[Trigger] ⚠️ Cost threshold exceeded: $10.23 across runner sessions."
  → Monitoring session decides to cancel remaining work
```

### C. Pub/Sub Build Coordination

```
Builder session:
  1. Run build...
  2. emit_event({ eventName: "build_complete", payload: { status: "success", sha: "abc123" } })

Deployer session (registered earlier):
  1. register_trigger({
       type: "custom_event",
       config: { eventName: "build_complete", fromSessionIds: "*" },
       delivery: { mode: "inject" },
       message: "Build completed by {sourceSessionId}: {payload}"
     })
  2. Waiting for build...

  [builder emits event]
  → Deployer's next turn: "[Trigger] Build completed by builder-session: { status: success, sha: abc123 }"
  → Deployer proceeds with deployment
```
