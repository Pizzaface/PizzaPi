---
name: Server relay Socket.IO handlers for triggers
status: open
created: 2026-03-02T15:47:12Z
updated: 2026-03-02T15:53:44Z
beads_id: PizzaPi-huz.6
depends_on: [PizzaPi-huz.3, PizzaPi-huz.4, PizzaPi-huz.5]
parallel: false
conflicts_with: []
---

# Task: Server relay Socket.IO handlers for triggers

## Description

Wire up the trigger system to the relay Socket.IO namespace by adding handlers for the new trigger protocol events. This connects the CLI tools (via relay socket) to the server-side trigger registry, evaluator, and timer scheduler.

Also integrate trigger evaluation into the existing relay event pipeline (heartbeat, session_end, disconnect) and add `emit_custom_event` support.

## Acceptance Criteria

- [ ] `register_trigger` handler — validates input, enforces runner-lock (target sessionIds must be on same runner), creates trigger via registry, schedules timers if type is `timer`, emits `trigger_registered` ack
- [ ] `cancel_trigger` handler — validates ownership, cancels trigger via registry, cancels timer if applicable, emits `trigger_cancelled` ack
- [ ] `list_triggers` handler — returns all triggers owned by the calling session via `trigger_list` event
- [ ] `emit_custom_event` handler — validates token, resolves runnerId from session, calls evaluator for custom_event matching
- [ ] Heartbeat integration: in the existing `event` handler, when event type is `heartbeat`, call evaluator for cost_exceeded and session_idle triggers
- [ ] Session end integration: in `session_end` and `disconnect` handlers, call evaluator for session_ended triggers, then cleanup owned triggers and timers
- [ ] Error handling: emit `trigger_error` for validation failures, invalid tokens, runner-lock violations
- [ ] Runner-lock enforcement: server validates that all target sessionIds in the trigger config share the same runnerId as the registering session
- [ ] Initialize trigger system on server startup: call registry rehydration and timer rehydration

## Technical Details

### Files to modify

- **Modify**: `packages/server/src/ws/namespaces/relay.ts` — add new socket handlers, integrate evaluator into existing event pipeline
- **Modify**: `packages/server/src/ws/sio-registry.ts` — add helper to look up runnerId for a session (if not already exposed)
- **Modify**: `packages/server/src/ws/namespaces/index.ts` — initialize trigger system on namespace setup

### Handler implementations

```typescript
// register_trigger handler
socket.on("register_trigger", async (data) => {
  // 1. Validate token
  // 2. Resolve runnerId for this session
  // 3. Runner-lock: validate target sessionIds are on same runner
  // 4. Check limits (100/session, 1000/runner)
  // 5. registry.registerTrigger(...)
  // 6. If type === "timer", timerScheduler.scheduleTimer(trigger)
  // 7. socket.emit("trigger_registered", { triggerId, type })
});
```

### Runner-lock validation

For triggers with `sessionIds` config (not `"*"`):
1. Look up each target sessionId via `getSharedSession()`
2. Verify `session.runnerId === callerRunnerId`
3. If any target is on a different runner, emit `trigger_error`

For `"*"` wildcard: no validation needed — evaluation is scoped to the runner at evaluation time.

### Existing pipeline integration points

- **Heartbeat**: After `updateSessionHeartbeat()` in the `event` handler, call `evaluator.evaluateHeartbeat(runnerId, sessionId, event)`
- **Session end**: After `endSharedSession()` in both `session_end` and `disconnect`, call `evaluator.evaluateSessionEnded(runnerId, sessionId)` then `registry.cleanupSessionTriggers(sessionId)` and `timerScheduler.cleanupSessionTimers(sessionId)`
- **CLI error**: When event type is `cli_error`, call `evaluator.evaluateSessionError(runnerId, sessionId, event.message)`

## Dependencies

- [ ] Task 002 (Registry) — for trigger CRUD
- [ ] Task 003 (Evaluator) — for event evaluation
- [ ] Task 004 (Timers) — for timer scheduling

## Effort Estimate

- Size: M
- Hours: 3
- Parallel: false (depends on 002, PizzaPi-huz.4, 004)

## Definition of Done

- [ ] Code implemented
- [ ] Runner-lock enforcement verified
- [ ] Trigger lifecycle works end-to-end: register → fire → notify → cleanup
- [ ] `bun run typecheck` passes
- [ ] Server builds and starts without errors
