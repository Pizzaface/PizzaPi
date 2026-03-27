# Dish 002: Quick-Win Heartbeat Optimization

- **Cook Type:** sonnet
- **Complexity:** M
- **Godmother ID:** 8uphsUaD (quick win portion)
- **Dependencies:** none
- **Files:**
  - packages/cli/src/extensions/remote/chunked-delivery.ts
  - packages/cli/src/extensions/remote-heartbeat.ts
  - packages/server/src/ws/namespaces/relay.ts (event handler)
  - packages/server/src/ws/namespaces/viewer.ts (connected handler)
  - packages/ui/src/App.tsx (handleRelayEvent)
- **Verification:** bun test, bun run typecheck
- **Status:** queued

## Task Description

**Skip full-snapshot session_active emissions when only metadata changed.**

### Current Problem

Every heartbeat cycle, the CLI calls `emitSessionActive()` which serializes and sends the entire message history (10-50MB for large sessions). This happens every few seconds, even when no messages changed.

### Solution

1. **Track message content hash** — After each `emitSessionActive()`, store a hash of the messages array length + last message ID/timestamp.

2. **Emit lightweight `session_metadata_update`** — When the heartbeat fires and messages haven't changed, emit a new lightweight event containing only metadata (model, cwd, sessionName, todoList, thinkingLevel, availableModels) instead of the full session_active.

3. **Server handling** — In relay.ts, `session_metadata_update` events:
   - Update the session heartbeat (existing path)
   - Broadcast to viewers (existing path)
   - Do NOT update `lastState` (messages haven't changed)
   - Do NOT append to Redis event cache

4. **UI handling** — In App.tsx, `session_metadata_update`:
   - Update metadata state (model, cwd, name, todo) without touching messages
   - Much cheaper than processing full session_active

### Estimated Impact

- **80% reduction** in relay bandwidth for idle/thinking sessions
- **Eliminates** unnecessary chunked delivery triggers during heartbeats
- **Reduces** Redis event cache bloat (no more full snapshots for metadata-only changes)

### Backward Compatibility

Old CLI versions will continue sending full session_active on every heartbeat. The server and UI will handle both event types. No breaking changes.

## Health Inspection — 2026-03-23
- **Inspector Models:** gpt-5.3-codex + gemini-3.1-pro (reconciled)
- **Verdict:** CITATION
- **Findings:**
  - P2: Stale metadata on reconnect — `session_metadata_update` skips `updateSessionState`, so `lastState` in Redis doesn't reflect metadata changes. Reconnecting viewers see old todoList/thinkingLevel until next full session_active.
  - P2: No tests for new `session_metadata_update` path or message-change detection helpers.
  - P3: `cwd` included in payload but never read by UI handler.
- **Critic Missed:** Stale metadata on reconnect, test coverage gap for new code paths.
- **Inspector Disagreement:** Codex called VIOLATION (P1 — stale transcripts during streaming). Gemini rebutted: event replay cache reconstructs streaming text on reconnect. Reconciled to CITATION — the transcript concern is mitigated by event replay; the real issue is stale metadata only.
