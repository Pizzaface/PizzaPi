# Dish 006: sio-state.ts Simplification

- **Cook Type:** sonnet
- **Complexity:** M
- **Godmother ID:** (new)
- **Dependencies:** none
- **Files:**
  - packages/server/src/ws/sio-state.ts (refactor)
  - packages/server/src/ws/sio-state/session.ts (new)
  - packages/server/src/ws/sio-state/runner.ts (new)
  - packages/server/src/ws/sio-state/terminal.ts (new)
  - packages/server/src/ws/sio-state/child-tracking.ts (new)
  - packages/server/src/ws/sio-state/redis-helpers.ts (new)
- **Verification:** bun test packages/server, bun run typecheck
- **Status:** queued

## Task Description

**sio-state.ts is 1,046 lines** of manual Redis hash CRUD with repetitive patterns. Extract into typed modules with shared helpers.

### Current Problems

1. Every Redis operation manually builds key names, serializes/deserializes, handles TTLs
2. Session, runner, terminal, and child-tracking operations are all mixed together
3. No consistent error handling — some operations swallow errors, others throw
4. TTL refresh logic is scattered and inconsistent

### Solution

1. **redis-helpers.ts** — Typed generic helpers:
   - `hashGet<T>(key, field, deserialize)` / `hashSet(key, field, value, ttl)`
   - `hashGetAll<T>(key, deserialize)` / `hashDel(key, fields)`
   - `setAdd(key, member, ttl)` / `setRembers(key)` / `setRemove(key, member)`
   - `withTtlRefresh(key, ttl, fn)` — wrap any operation with TTL refresh

2. **session.ts** — Session CRUD:
   - `getSession()`, `setSession()`, `updateSession()`, `deleteSession()`
   - `getSessionField()`, `setSessionField()`
   - Typed `SessionData` interface

3. **runner.ts** — Runner CRUD (same pattern)

4. **terminal.ts** — Terminal CRUD

5. **child-tracking.ts** — Parent-child relationship management:
   - `addChild()`, `removeChild()`, `getChildren()`
   - `isChildOfParent()`, `markChildAsDelinked()`
   - The delink retry set operations

### Estimated Reduction

From 1,046 lines to ~600 lines total across 5 files, with much better readability and type safety.
