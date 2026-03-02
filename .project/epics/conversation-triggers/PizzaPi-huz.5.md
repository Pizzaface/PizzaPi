---
name: Server timer trigger scheduler
status: open
created: 2026-03-02T15:47:12Z
updated: 2026-03-02T15:53:44Z
beads_id: PizzaPi-huz.5
depends_on: [PizzaPi-huz.3]
parallel: true
conflicts_with: []
---

# Task: Server timer trigger scheduler

## Description

Implement the timer trigger scheduler that manages `setTimeout`/`setInterval` for `timer` type triggers. Timer triggers fire after a fixed delay or on a recurring interval, independent of any external event. The scheduler must rehydrate active timers from Redis on server restart.

## Acceptance Criteria

- [ ] New `packages/server/src/ws/triggers/timers.ts` module
- [ ] `scheduleTimer(trigger: TriggerRecord)` — creates a setTimeout (one-shot) or setInterval (recurring) for a timer trigger
- [ ] `cancelTimer(triggerId: string)` — clears the scheduled timer
- [ ] `rehydrateTimers()` — on server startup, scans timer triggers from Redis and reschedules them (adjusting delay for elapsed time)
- [ ] `cleanupSessionTimers(sessionId: string)` — cancels all timers owned by a session
- [ ] One-shot timers auto-expire after firing (set maxFirings: 1)
- [ ] Recurring timers fire at the specified interval until cancelled or maxFirings reached
- [ ] Timer firing uses the same evaluator delivery dispatch (queue or inject mode)
- [ ] Unit tests for scheduling, cancellation, and rehydration logic

## Technical Details

### Files to create

- **Create**: `packages/server/src/ws/triggers/timers.ts`
- **Create**: `packages/server/src/ws/triggers/timers.test.ts`
- **Modify**: `packages/server/src/ws/triggers/index.ts` — export timer scheduler

### Implementation approach

- Maintain an in-memory map: `activeTimers: Map<triggerId, NodeJS.Timeout>`
- On registration: calculate delay, create setTimeout/setInterval, store handle
- On cancellation: clearTimeout/clearInterval, remove from map
- On firing: call `registry.fireTrigger()` then deliver notification via the evaluator's delivery dispatch
- On server restart rehydration:
  - Scan all `timer` triggers from Redis via `registry.getTriggersByType(runnerId, "timer")`
  - For one-shot: calculate remaining delay = `delaySec - (now - createdAt)`. If ≤ 0, fire immediately
  - For recurring: calculate next firing based on `lastFiredAt` or `createdAt` + interval

### Edge cases

- If a timer's owning session has disconnected during a server restart, skip scheduling (cleanup will handle it)
- If remaining delay is negative for one-shot timers, fire immediately on rehydration
- Prevent timer drift for recurring triggers by using `setInterval` from the last known firing time

## Dependencies

- [ ] Task 002 (Trigger registry) — `TriggerRegistry` for persistence and lookup
- [ ] Task 003 (Evaluator) — delivery dispatch for firing notifications (can be developed in parallel, wired up later)

## Effort Estimate

- Size: S
- Hours: 2
- Parallel: true (can develop alongside Task 003)

## Definition of Done

- [ ] Code implemented
- [ ] Unit tests written and passing
- [ ] Timer rehydration logic tested with mock Redis data
- [ ] `bun run typecheck` passes
