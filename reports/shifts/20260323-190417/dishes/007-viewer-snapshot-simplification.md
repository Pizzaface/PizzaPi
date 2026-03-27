# Dish 007: Viewer Snapshot & Reconnect Simplification

- **Cook Type:** sonnet
- **Complexity:** M
- **Godmother ID:** vS9rgojz (related)
- **Dependencies:** 001
- **Files:**
  - packages/server/src/ws/namespaces/viewer.ts
  - packages/server/src/ws/viewer/snapshot-provider.ts (new)
  - packages/server/src/ws/viewer/reconnect-handler.ts (new)
- **Verification:** bun test, bun run typecheck
- **Status:** queued

## Task Description

Simplify viewer.ts by extracting the three-layer snapshot fallback into a clean `SnapshotProvider` abstraction.

### Current Problem

viewer.ts on connect has a deeply nested sequence:
1. Check if session is live → if not, try persisted snapshot replay
2. Register all event handlers synchronously (to avoid race)
3. addViewer() → join room
4. Fetch fresh session + seq after addViewer
5. Emit connected + heartbeat snapshot
6. If chunked delivery in-flight → skip lastState → check event cache → maybe request fresh from runner
7. If no chunked delivery → try lastState → try event cache → request from runner

### Solution

**SnapshotProvider** — single abstraction for "get the best available snapshot":

```typescript
interface Snapshot {
  type: 'live' | 'replay';
  state?: unknown;
  seq?: number;
  source: 'lastState' | 'eventCache' | 'sqlite' | 'runnerRequest';
  chunkedPending?: boolean;
}

async function getBestSnapshot(sessionId: string, userId: string): Promise<Snapshot | null>;
```

The provider encapsulates the fallback logic. viewer.ts becomes:
1. Get snapshot → emit to viewer → if live, register handlers
2. No more deeply nested conditionals
3. Each snapshot source is a separate, testable function

### Test Strategy

Unit test each snapshot source independently:
- `getSnapshotFromLastState(sessionId)`
- `getSnapshotFromEventCache(sessionId)`
- `getSnapshotFromSQLite(sessionId, userId)`
- `getBestSnapshot(sessionId, userId)` — integration test for fallback order
