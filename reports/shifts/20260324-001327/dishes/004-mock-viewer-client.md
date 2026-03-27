# Dish 004: Mock Viewer Client

- **Cook Type:** sonnet
- **Complexity:** M
- **Godmother ID:** uTWRUjFU
- **Dependencies:** 001
- **Files:** `packages/server/tests/harness/mock-viewer.ts`
- **Verification:** `cd packages/server && bun test tests/harness/mock-viewer.test.ts`, `bun run typecheck`
- **Status:** plated
- **dispatchPriority:** normal

## Task Description

Create mock clients for the `/viewer` and `/hub` Socket.IO namespaces.

### Requirements

#### Part A: Mock Viewer (`MockViewer`)

1. **`createMockViewer(server, sessionId, opts?)`** — factory that:
   - Connects to `server.baseUrl/viewer` with API key auth and `{ sessionId }` in handshake query
   - Waits for `connected` event from server
   - Returns a `MockViewer` object

2. **`MockViewer` interface:**
   - `socket: Socket`
   - `sessionId: string`
   - `sendInput(text, attachments?)` — emits `input` event
   - `sendExec(id, command)` — emits `exec` event
   - `sendTriggerResponse(triggerId, response, targetSessionId, action?)` — emits `trigger_response`
   - `sendResync()` — emits `resync` event
   - `events: ReceivedEvent[]` — array of all received `event` payloads (auto-collected)
   - `waitForEvent(predicate?, timeout?)` — promise that resolves when an event matching the predicate arrives
   - `waitForDisconnected(timeout?)` — waits for `disconnected` event
   - `getReceivedEvents()` — returns all collected events
   - `clearEvents()` — resets the collected events array
   - `disconnect()`

#### Part B: Mock Hub Client (`MockHubClient`)

1. **`createMockHubClient(server, opts?)`** — factory that:
   - Connects to `server.baseUrl/hub` with API key auth
   - Waits for initial `sessions` snapshot
   - Returns a `MockHubClient` object

2. **`MockHubClient` interface:**
   - `socket: Socket`
   - `sessions: SessionInfo[]` — auto-updated session list
   - `waitForSessionAdded(predicate?, timeout?)` — promise
   - `waitForSessionRemoved(sessionId, timeout?)` — promise
   - `waitForSessionStatus(sessionId, predicate?, timeout?)` — promise
   - `subscribeSessionMeta(sessionId)` — emits `subscribe_session_meta`
   - `unsubscribeSessionMeta(sessionId)` — emits `unsubscribe_session_meta`
   - `disconnect()`

### Implementation Notes

- Look at `packages/protocol/src/viewer.ts` for viewer event shapes
- Look at `packages/protocol/src/hub.ts` for hub event shapes
- The `/viewer` namespace uses `apiKeyAuthMiddleware` + session validation
- The viewer handshake needs `{ sessionId }` in the query params — see `packages/server/src/ws/namespaces/viewer.ts`
- The hub auto-broadcasts session_added/session_removed/session_status — the mock should auto-update its internal `sessions` array
- Use typed Socket.IO client generics matching the protocol types

### Verification

```bash
cd packages/server && bun test tests/harness/mock-viewer.test.ts
bun run typecheck
```

Write tests that:
1. Create server + relay session, then connect a viewer and verify `connected` event
2. Send events through relay, verify viewer receives them
3. Connect hub client, verify it sees the session list
4. Create a second session, verify hub gets `session_added`
5. End a session via relay, verify hub gets `session_removed`

---

## Kitchen Disconnect (Fixer Report)

**Date:** 2026-03-24  
**Commit:** 6ddb334

### Root Cause

Classic Socket.IO listener-ordering race: the original cook structured both harness files as "connect → wait for handshake → attach data listeners", when the correct pattern is "connect → attach ALL listeners → wait for handshake". This left a window — however small — where server events emitted after the handshake event but before listener attachment would be silently dropped.

- **Category:** wrong-approach  
- **Pattern:** Async handshake await before listener registration

### Issues Fixed

**P1 — MockViewer event listener race**  
`socket.on("event")` and `socket.on("disconnected")` were registered in `buildMockViewer()`, called only after `attemptViewerConnection()` resolved. Events between the `connected` handshake and listener attachment were lost.  
**Fix:** Merged `attemptViewerConnection` + `buildMockViewer` into a single `attemptBuildViewer` function. All listeners are now attached before the `connectedPromise` await.

**P2 — MockHubClient snapshot→listener race**  
`session_added`, `session_removed`, and `session_status` listeners were registered in `buildMockHubClient()`, after the initial `sessions` snapshot arrived. Update events during that window were lost.  
**Fix:** Merged `attemptHubConnection` + `buildMockHubClient` into a single `attemptBuildHubClient` function. All update listeners are now attached before `snapshotPromise` is awaited. The initial `sessions` event is handled by both the persistent `socket.on("sessions")` handler (which populates the array) and a `once("sessions")` trigger inside `snapshotPromise` (which resolves the await) — no duplicate population.

**P3 — disconnect() leaves pending waiters hanging**  
`waitForEvent`, `waitForSessionAdded`, `waitForSessionRemoved`, and `waitForSessionStatus` promises would remain pending indefinitely after `disconnect()`, causing noisy test timeouts.  
**Fix:** Added `isDisconnected` flag and `rejectAllWaiters()` helper to both files. `disconnect()` now sets the flag, rejects and clears all pending waiters (clearing their timers), then proceeds to close the socket. New `waitFor*` calls made after disconnect immediately reject with `"already disconnected"`.

### Verification

- `bun run typecheck` — clean (0 errors)
- `bun test packages/server/tests/harness/mock-viewer.test.ts` — 8/8 pass

### Prevention Note

Cook prompts for Socket.IO integration code should explicitly state: *"Attach all persistent event listeners before any await on a handshake or snapshot event. Never register data listeners after an await."*
