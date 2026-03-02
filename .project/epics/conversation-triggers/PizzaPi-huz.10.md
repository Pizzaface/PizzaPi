---
name: Integration tests for trigger system
status: open
created: 2026-03-02T15:47:12Z
updated: 2026-03-02T15:53:44Z
beads_id: PizzaPi-huz.10
depends_on: [PizzaPi-huz.6, PizzaPi-huz.8]
parallel: false
conflicts_with: []
---

# Task: Integration tests for trigger system

## Description

Write integration tests that verify end-to-end trigger workflows: registration, evaluation, firing, delivery, and cleanup. Tests should cover the key scenarios from the PRD (fan-out/fan-in, cost monitoring, pub/sub coordination) and critical safety properties (runner-lock isolation, server restart rehydration).

## Acceptance Criteria

- [ ] Fan-out/fan-in test: parent registers `session_ended` trigger for 3 child sessions, children end one by one, parent receives 3 notifications
- [ ] Cost monitoring test: register `cost_exceeded` trigger, simulate heartbeats with increasing cost, trigger fires when threshold crossed (one-shot)
- [ ] Custom event pub/sub test: session A registers `custom_event` trigger, session B emits event, session A receives notification
- [ ] Timer test: register one-shot timer trigger, verify it fires after delay; register recurring timer, verify multiple firings
- [ ] Session idle test: register `session_idle` trigger, simulate heartbeat transitioning active→idle, trigger fires
- [ ] Runner-lock isolation test: session on runner A cannot register trigger targeting session on runner B — server rejects with `trigger_error`
- [ ] Trigger cleanup test: session registers triggers then disconnects — all triggers are removed from Redis
- [ ] Server restart rehydration test: register triggers, simulate server restart (reinitialize registry from Redis), verify triggers still active and timers rescheduled
- [ ] Max firings test: register trigger with maxFirings=2, fire 3 events, verify only 2 notifications delivered and trigger auto-expires
- [ ] Queue vs inject delivery test: verify `queue` mode delivers via message bus, `inject` mode queues for next turn

## Technical Details

### Files to create

- **Create**: `packages/server/src/ws/triggers/integration.test.ts` — server-side integration tests
- **Create**: `packages/cli/src/extensions/conversation-triggers.test.ts` — CLI extension tests (tool execution with mock relay)

### Test infrastructure

Tests should use:
- **Mock Redis**: Use an in-memory Map-based mock that implements the same interface as the Redis client (or use `ioredis-mock` if available in the project)
- **Mock Socket.IO**: Create mock socket objects that record emitted events for assertion
- **Test helpers**: Factory functions for creating `TriggerRecord` instances with sensible defaults

### Test scenarios in detail

**Fan-out/fan-in**:
1. Create mock sessions: parent (runner-1), child-A (runner-1), child-B (runner-1), child-C (runner-1)
2. Parent registers `session_ended` trigger with `sessionIds: ["child-A", "child-B", "child-C"]`, `maxFirings: 3`
3. Simulate child-A disconnect → evaluator fires → verify parent receives notification
4. Simulate child-B disconnect → verify second notification
5. Simulate child-C disconnect → verify third notification → verify trigger auto-expired

**Runner-lock isolation**:
1. Create session-X on runner-1, session-Y on runner-2
2. Session-X tries to register trigger targeting session-Y
3. Verify server emits `trigger_error` with runner-lock violation message

**Server restart rehydration**:
1. Register triggers (including a timer)
2. Clear in-memory state (simulate restart)
3. Call `rehydrateTriggers()` and `rehydrateTimers()`
4. Verify triggers are back in registry
5. Verify timer is rescheduled with adjusted delay

## Dependencies

- [ ] Task 005 (Server handlers) — full server-side trigger pipeline
- [ ] Task 007 (CLI inject delivery) — client-side delivery mechanism

## Effort Estimate

- Size: M
- Hours: 4
- Parallel: false (requires all server + CLI tasks complete)

## Definition of Done

- [ ] All integration tests written and passing
- [ ] Tests cover all PRD success criteria scenarios
- [ ] Tests run in <30s total (no real Redis/network dependencies)
- [ ] `bun test` passes for all trigger test files
