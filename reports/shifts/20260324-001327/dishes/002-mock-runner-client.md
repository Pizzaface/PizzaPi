# Dish 002: Mock Runner Client

- **Cook Type:** sonnet
- **Complexity:** M
- **Godmother ID:** Q88RyiEr
- **Dependencies:** 001
- **Files:** `packages/server/tests/harness/mock-runner.ts`
- **Verification:** `cd packages/server && bun test tests/harness/mock-runner.test.ts`, `bun run typecheck`
- **Status:** queued
- **dispatchPriority:** high

## Task Description

Create a mock runner client that connects to a test server's `/runner` Socket.IO namespace, mimicking a real PizzaPi runner daemon.

### Requirements

1. **`createMockRunner(server, opts?)`** — factory that:
   - Connects a `socket.io-client` to `server.baseUrl/runner` with the API key in auth handshake
   - Emits `register_runner` with configurable runner metadata:
     - `runnerId` (auto-generated UUID if not provided)
     - `name` (default: `"test-runner"`)
     - `roots` (default: `["/tmp/test"]`)
     - `skills`, `agents`, `plugins`, `hooks` (default: empty arrays)
     - `version` (default: `"1.0.0-test"`)
     - `platform` (default: `"linux"`)
   - Waits for `runner_registered` acknowledgment
   - Returns a `MockRunner` object

2. **`MockRunner` interface:**
   - `runnerId: string`
   - `socket: Socket` — the raw socket.io-client socket
   - `emitSessionReady(sessionId)` — fires `session_ready`
   - `emitSessionError(sessionId, error)` — fires `session_error`
   - `emitSessionEvent(sessionId, event)` — fires `runner_session_event`
   - `emitSessionEnded(sessionId)` — fires `session_ended` from runner side
   - `respondToSkillRequest(handler)` — registers a handler for `list_skills` / `skill_result` patterns
   - `respondToFileRequest(handler)` — registers a handler for `file_list` / `file_read` patterns
   - `waitForEvent(eventName, timeout?)` — promise that resolves when the runner receives a specific event
   - `disconnect()` — clean disconnect

3. **Multiple runners**: Tests should be able to create multiple mock runners connected to the same test server.

4. **Builder pattern** for runner metadata:
   ```ts
   createMockRunner(server)
     .withName("my-runner")
     .withSkills([{ name: "test", description: "A test skill", filePath: "/tmp/test.md" }])
     .connect()
   ```

### Implementation Notes

- Look at `packages/protocol/src/runner.ts` for the exact event shapes (`RunnerClientToServerEvents`, `RunnerServerToClientEvents`)
- The `/runner` namespace uses `apiKeyAuthMiddleware` — pass the API key from the test server
- Auth handshake format: `{ auth: { apiKey: server.apiKey } }` in socket.io-client options
- The `register_runner` event requires specific fields — see `packages/server/src/ws/namespaces/runner.ts`

### Verification

```bash
cd packages/server && bun test tests/harness/mock-runner.test.ts
bun run typecheck
```

Write tests that:
1. Create a test server + mock runner
2. Verify the runner appears in the runners list (via REST API or hub feed)
3. Test `emitSessionReady` / `emitSessionEvent` flows
4. Test multiple runners on the same server
5. Test clean disconnect

---

## Kitchen Disconnect — Fixer Report

**Filed by:** Fixer session  
**Date:** 2026-03-24  
**Commit:** b8b685b

### Root Cause

Incomplete assertions and missing cleanup in async event helpers. The cook built the right API surface but:
1. Didn't close the loop on assertions — `emitSessionReady` test was smoke-only
2. Missed the standard socket.io `once`-listener cleanup pattern on timeout
3. Left the registration promise without a timeout guard
4. Omitted tests for several emission helpers and auth failure

**Category:** missing-context  
**Prevention:** Cook prompts for test harness code should explicitly require assertion-per-behavior and listener cleanup patterns.

### Fixes Applied

| Issue | Severity | Fix |
|-------|----------|-----|
| `waitForEvent` leaks `once` listener on timeout | P2 | Store handler ref; call `socket.off(eventName, handler)` before rejecting |
| `emitSessionReady` test never asserts propagation | P2 | Restructured test to set up server-side listener **before** runner connects; added `expect(receivedSessionIds).toContain(sessionId)` |
| Registration waits indefinitely if server never responds | P3 | Added 5 000 ms timeout with `settled` guard; cleans up and disconnects on timeout |
| No tests for `emitSessionError`, `emitSessionEvent`, `emitSessionEnded`, auth failure | P3 | Added sections 7 and 8 with 4 new tests (server-side listener pattern + `apiKey` option) |

### Verification

- 16 / 16 tests pass (`bun test tests/harness/mock-runner.test.ts`)
- Typecheck clean (`bun run typecheck`)
- Pushed to branch `nightshift/dish-002-mock-runner`
