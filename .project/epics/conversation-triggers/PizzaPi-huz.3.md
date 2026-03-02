---
name: Server trigger registry with Redis persistence
status: open
created: 2026-03-02T15:47:12Z
updated: 2026-03-02T15:53:44Z
beads_id: PizzaPi-huz.3
depends_on: [PizzaPi-huz.2]
parallel: false
conflicts_with: []
---

# Task: Server trigger registry with Redis persistence

## Description

Implement the `TriggerRegistry` class that manages CRUD operations for trigger records in Redis. This is the core data layer for the trigger system — all trigger operations (register, cancel, list, fire, expire, cleanup) go through the registry.

Uses the existing Redis client from `packages/server/src/sessions/redis.ts` and follows the same patterns for key management and error handling.

## Acceptance Criteria

- [ ] New `packages/server/src/ws/triggers/registry.ts` module
- [ ] `registerTrigger()` — creates a trigger record in Redis with proper indices
- [ ] `cancelTrigger()` — removes a trigger by ID (validates ownership by sessionId)
- [ ] `listTriggers()` — returns all triggers owned by a session
- [ ] `getTriggersByType()` — returns all triggers of a given type on a runner (for evaluation)
- [ ] `fireTrigger()` — increments firingCount, updates lastFiredAt, auto-expires if maxFirings reached
- [ ] `cleanupSessionTriggers()` — removes all triggers owned by a disconnected session
- [ ] Redis key scheme: `triggers:{runnerId}:{triggerId}` with indices `triggers:by-runner:{runnerId}`, `triggers:by-session:{sessionId}`, `triggers:by-type:{runnerId}:{type}`
- [ ] Trigger records survive server restart (persisted in Redis)
- [ ] `rehydrateTriggers()` — on server startup, scan and validate existing triggers
- [ ] Unit tests for all registry operations
- [ ] Max 100 triggers per session enforced, max 1000 per runner

## Technical Details

### Files to create

- **Create**: `packages/server/src/ws/triggers/registry.ts`
- **Create**: `packages/server/src/ws/triggers/registry.test.ts`
- **Create**: `packages/server/src/ws/triggers/index.ts` (barrel export)

### Redis key scheme

```
# Trigger record (JSON)
triggers:{runnerId}:{triggerId} → TriggerRecord

# Index: all triggers on a runner
triggers:by-runner:{runnerId} → Set<triggerId>

# Index: all triggers owned by a session
triggers:by-session:{sessionId} → Set<triggerId>

# Index: triggers by type on a runner (for fast evaluation lookup)
triggers:by-type:{runnerId}:{type} → Set<triggerId>
```

### Key implementation details

- Use the existing `getRelayRedisClient()` from `sessions/redis.ts` for the Redis client
- Trigger IDs: use `crypto.randomUUID()` for unique identifiers
- All Redis operations should be atomic where possible (use MULTI/EXEC for register/cancel)
- Index cleanup must be consistent — if a trigger is removed, all its index entries must also be removed
- `rehydrateTriggers()` scans `triggers:by-runner:*` keys and validates each trigger still has a valid record
- Enforce limits: reject registration if session has ≥100 triggers or runner has ≥1000

### Error handling

- Return structured error objects (not thrown exceptions) for validation failures
- Log warnings for orphaned index entries found during rehydration
- Graceful fallback if Redis is unavailable (log and return empty results)

## Dependencies

- [ ] Task 001 (Protocol types) — `TriggerRecord`, `TriggerType`, `TriggerConfig` interfaces

## Effort Estimate

- Size: M
- Hours: 4
- Parallel: false (depends on 001)

## Definition of Done

- [ ] Code implemented
- [ ] Unit tests written and passing (`bun test packages/server/src/ws/triggers/registry.test.ts`)
- [ ] `bun run typecheck` passes
- [ ] Registry handles Redis unavailability gracefully
