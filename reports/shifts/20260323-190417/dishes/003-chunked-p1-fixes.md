# Dish 003: Fix P1 Chunked Delivery Bugs

- **Cook Type:** sonnet
- **Complexity:** L
- **Godmother ID:** vS9rgojz
- **Dependencies:** 001 (cleaner to fix after extraction)
- **Files:**
  - packages/server/src/ws/namespaces/relay.ts
  - packages/server/src/ws/namespaces/viewer.ts
  - packages/ui/src/App.tsx
- **Verification:** bun test, bun run typecheck, manual test with large session
- **Status:** queued

## Task Description

Fix all 4 confirmed P1 bugs in chunked delivery. Even though the delta architecture will eventually replace chunking, these bugs affect users NOW.

### Bug 1: Live events dropped during chunked hydration
**File:** App.tsx
**Problem:** While chunked snapshot is loading, the guard returns early for every `message_*`, `turn_end`, and `tool_execution_*` event. Events advance `lastSeqRef` but are never buffered.
**Fix:** Buffer live events during hydration in a `pendingLiveEvents` ref. After final chunk assembly, replay buffered events in seq order. If any event has a seq gap, trigger resync instead.

### Bug 2: Viewer connect race — runner notified before addViewer()
**File:** viewer.ts
**Problem:** Server emits `connected` to browser before `addViewer()`. Browser echoes back immediately, runner pushes snapshot before viewer joins room.
**Fix:** Already partially fixed (viewerReadyForRunnerSignal). Verify the fix is complete — the "connected" signal should not fire until addViewer resolves.

### Bug 3: Resync during chunked delivery replays stale lastState
**File:** viewer.ts
**Problem:** Resync calls `sendSnapshotToViewer()` which replays `lastState`. During chunked delivery, `lastState` is intentionally stale.
**Fix:** Already has a guard for `resyncChunkedPending`. Verify it works correctly. If chunked delivery is in-flight, resync should either wait for chunk completion or request a fresh chunked delivery.

### Bug 4: pendingChunkedStates process-local breaks multi-node
**File:** relay.ts
**Problem:** Chunked state is in process memory, not Redis.
**Fix:** Short-term: document as known limitation. Long-term: the delta architecture removes the need for chunked delivery entirely.

### Test Strategy
- Unit tests for event buffering during hydration
- Test resync during chunked delivery
- Test viewer connect timing relative to addViewer()
