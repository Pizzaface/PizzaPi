# Dish 006: Chunk Retransmit Idempotency Fix

- **Cook Type:** sonnet
- **Complexity:** M
- **Godmother ID:** 9PvLhca4
- **Pairing:** ui-stability-p1
- **Paired:** true
- **Service:** 3
- **Files:** packages/server/src/ws/namespaces/relay/event-pipeline.ts, packages/ui/src/App.tsx
- **Verification:** bun test packages/server, bun run typecheck
- **Status:** ramsey-cleared
- **Band:** A

## Task Description
Make chunk delivery idempotent per {snapshotId, chunkIndex}. Only count first-seen chunk indexes. Verify all chunks 0..N-1 present before finalizing. Add regression tests for duplicate retransmits.

## Health Inspection — 13:03 UTC
- **Inspector Model:** claude-sonnet-4-6
- **Verdict:** VIOLATION
- **Findings:** P1: out-of-order finalization silently skips patchSessionCache + setActiveToolCalls — session cache stale after chunked reconnect; P2: dedupedForSideEffects mutation from inside updater violates React model; cross-chunk dedup skipped in out-of-order case
- **Critic Missed:** N/A (no critic ran)
- **Note:** Server-side event-pipeline.ts idempotency fix is clean; bug is in App.tsx integration path
- **Action:** Fixer to be dispatched
