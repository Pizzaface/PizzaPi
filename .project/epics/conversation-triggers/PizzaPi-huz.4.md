---
name: Server trigger evaluator and event pipeline
status: open
created: 2026-03-02T15:47:12Z
updated: 2026-03-02T15:53:44Z
beads_id: PizzaPi-huz.4
depends_on: [PizzaPi-huz.3]
parallel: false
conflicts_with: []
---

# Task: Server trigger evaluator and event pipeline

## Description

Implement the trigger evaluation engine that processes events from the relay pipeline and fires matching triggers. This is the core logic that connects events (session lifecycle, heartbeats, custom events) to registered triggers and delivers notifications.

The evaluator hooks into the existing relay event pipeline in `packages/server/src/ws/namespaces/relay.ts` and the runner namespace for session lifecycle events.

## Acceptance Criteria

- [ ] New `packages/server/src/ws/triggers/evaluator.ts` module
- [ ] `evaluateSessionEnded(runnerId, sessionId)` — fires matching `session_ended` triggers
- [ ] `evaluateSessionError(runnerId, sessionId, errorMessage)` — fires matching `session_error` triggers
- [ ] `evaluateHeartbeat(runnerId, sessionId, heartbeatData)` — evaluates `cost_exceeded` and `session_idle` triggers against heartbeat data
- [ ] `evaluateCustomEvent(runnerId, sourceSessionId, eventName, payload)` — fires matching `custom_event` triggers
- [ ] Trigger condition matching: sessionId filter (specific IDs or `"*"` wildcard), cost threshold comparison, active→idle transition detection
- [ ] Message template interpolation: `{sessionId}`, `{sourceSessionId}`, `{eventName}`, `{payload}`, `{cost}`, `{error}`
- [ ] Notification delivery dispatch: `queue` mode → send via `session_message` event to owning session; `inject` mode → send via `trigger_fired` event
- [ ] Auto-expire triggers when `maxFirings` is reached
- [ ] Event-based evaluation completes in <10ms (no Redis round-trips in the hot path — use in-memory cache if needed)
- [ ] Unit tests for each evaluation function and template interpolation

## Technical Details

### Files to create/modify

- **Create**: `packages/server/src/ws/triggers/evaluator.ts`
- **Create**: `packages/server/src/ws/triggers/evaluator.test.ts`
- **Modify**: `packages/server/src/ws/namespaces/relay.ts` — call evaluator from event pipeline and session_end/disconnect handlers
- **Modify**: `packages/server/src/ws/triggers/index.ts` — export evaluator

### Evaluation pipeline

```
Event arrives at relay
  → Identify trigger types to check based on event type:
      heartbeat → [cost_exceeded, session_idle]
      session_end/disconnect → [session_ended]
      cli_error → [session_error]
      emit_custom_event → [custom_event]
  → Look up matching triggers from registry by (runnerId, type)
  → For each trigger:
      - Check still active (not expired, firingCount < maxFirings)
      - Evaluate condition (sessionId filter, cost threshold, idle transition)
      - If matches: fire trigger via registry, deliver notification
```

### Delivery dispatch

- **`queue` mode**: Use existing `getLocalTuiSocket(ownerSessionId)` and emit `session_message` with formatted notification text — reuses the existing message bus pathway
- **`inject` mode**: Emit new `trigger_fired` event to the owning session's relay socket with full `TriggerNotification` payload + delivery mode

### Idle detection

Track per-session active state: maintain an in-memory map `sessionActiveStates: Map<string, boolean>` updated on each heartbeat. Fire `session_idle` triggers only on transition from `true` → `false`.

### Performance considerations

- Use `registry.getTriggersByType(runnerId, type)` for O(matching_triggers) lookup
- Heartbeat evaluation runs at heartbeat frequency (every ~10s) — acceptable latency
- Event-based evaluation (session_ended, session_error, custom_event) should be non-blocking — fire-and-forget with error logging

## Dependencies

- [ ] Task 002 (Trigger registry) — `TriggerRegistry` for lookups and firing
- [ ] Task 001 (Protocol types) — `TriggerNotification`, delivery types

## Effort Estimate

- Size: M
- Hours: 4
- Parallel: false (depends on 002)

## Definition of Done

- [ ] Code implemented
- [ ] Unit tests written and passing
- [ ] Evaluator integrated into relay event pipeline
- [ ] `bun run typecheck` passes
- [ ] Event-based evaluation benchmarked at <10ms
