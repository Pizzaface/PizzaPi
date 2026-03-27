# Dish 001: Relay Module Decomposition

- **Cook Type:** sonnet
- **Complexity:** L
- **Godmother ID:** (new — captures relay.ts god module)
- **Dependencies:** none
- **Files:**
  - packages/server/src/ws/namespaces/relay.ts (extract from)
  - packages/server/src/ws/relay/thinking-tracker.ts (new)
  - packages/server/src/ws/relay/push-tracker.ts (new)
  - packages/server/src/ws/relay/chunked-assembly.ts (new)
  - packages/server/src/ws/relay/event-pipeline.ts (new)
  - packages/server/src/ws/relay/session-messaging.ts (new)
  - packages/server/src/ws/relay/session-lifecycle.ts (new)
  - packages/server/src/ws/relay/ack-tracker.ts (new)
- **Verification:** bun test packages/server, bun run typecheck
- **Status:** queued

## Task Description

**Pure refactor** — extract relay.ts from 1,184 lines into focused modules. No behavior changes.

### Extraction Plan

1. **thinking-tracker.ts** (~80 lines)
   - `thinkingStartTimes`, `thinkingDurations` maps
   - `clearThinkingMaps()`, `trackThinkingDeltas()`, `augmentMessageThinkingDurations()`
   - Export: `ThinkingTracker` class or module functions

2. **push-tracker.ts** (~120 lines)
   - `trackPushPendingState()`, `checkPushNotifications()`
   - All push notification logic (agent_end, AskUserQuestion, cli_error)
   - Export: `trackPushState()`, `checkPush()`

3. **chunked-assembly.ts** (~100 lines)
   - `pendingChunkedStates` map, `ChunkedSessionState` interface
   - `getPendingChunkedSnapshot()`
   - Chunk accumulation logic from event handler
   - Export: `ChunkedAssembler` class

4. **event-pipeline.ts** (~100 lines)
   - `enqueueSessionEvent()` serialization
   - The core event processing logic (session_active, session_messages_chunk, heartbeat, meta events)
   - Composable middleware: receive → thinking tracking → image stripping → persist → broadcast → push

5. **session-messaging.ts** (~200 lines)
   - `session_message` handler (inter-session send_message)
   - `session_trigger` handler (child-to-parent triggers)
   - `trigger_response` handler (parent-to-child responses)
   - All delink validation, ownership checks

6. **session-lifecycle.ts** (~300 lines)
   - `register` handler
   - `session_end` handler
   - `cleanup_child_session` handler
   - `delink_children` handler
   - `delink_own_parent` handler
   - `disconnect` handler

7. **ack-tracker.ts** (~30 lines)
   - `socketAckedSeqs` map
   - `sendCumulativeEventAck()`

### relay.ts becomes the wiring

After extraction, relay.ts becomes ~100 lines: namespace registration, socket.on() handlers that delegate to the extracted modules. It's the wiring, not the logic.

### Test Strategy

All existing tests must pass unchanged. Add unit tests for extracted modules:
- thinking-tracker: test duration tracking, clearing, augmentation
- chunked-assembly: test chunk accumulation, stale snapshot ID rejection
- ack-tracker: test cumulative ack logic

## Health Inspection — 2026-03-23
- **Inspector Model:** gpt-5.3-codex
- **Verdict:** CLEAN_BILL
- **Findings:** None. All handlers preserved, imports acyclic, 901 tests pass.
- **Critic Missed:** Nothing — critic was right.
