# Dish 005: BDD Scenario Helpers & Integration Tests

- **Cook Type:** sonnet
- **Complexity:** M
- **Godmother ID:** uTWRUjFU
- **Dependencies:** 001, 002, 003, 004
- **Files:** `packages/server/tests/harness/scenario.ts`, `packages/server/tests/harness/integration.test.ts`
- **Verification:** `cd packages/server && bun test tests/harness/integration.test.ts`, `bun run typecheck`
- **Status:** plated
- **dispatchPriority:** normal

## Task Description

Create BDD-style scenario helpers that compose the harness primitives into readable test scenarios, plus a comprehensive integration test suite demonstrating the harness.

### Requirements

#### Part A: Scenario Helpers (`scenario.ts`)

1. **`TestScenario`** class with fluent API:
   ```ts
   const scenario = new TestScenario()
     .withServer()                    // creates test server
     .withRunner({ name: "r1" })      // creates + connects mock runner
     .withRunner({ name: "r2" })      // second runner
     .withSession({ cwd: "/project" }) // creates session via relay
     .withViewer("session-0")          // connects viewer to first session
     .withHubClient()                  // connects hub client
   
   await scenario.setup()  // executes all the above
   // ... test assertions ...
   await scenario.teardown()  // cleans up everything in reverse order
   ```

2. **Accessors on `TestScenario`:**
   - `server` — the `TestServer`
   - `runners` — array of `MockRunner` (by index or name)
   - `runner(nameOrIndex)` — get a specific runner
   - `sessions` — array of `{ sessionId, token, relay: MockRelay }`
   - `session(index)` — get a specific session
   - `viewers` — array of `MockViewer`
   - `viewer(index)` — get a specific viewer
   - `hub` — the `MockHubClient` (if created)

3. **Scenario actions** — methods that perform multi-step operations:
   - `sendConversation(sessionIndex, turns)` — uses builders to send a full conversation through the relay
   - `simulateAgentWork(sessionIndex, events)` — sends a sequence of events with realistic timing
   - `waitForViewerToReceive(viewerIndex, count, timeout?)` — waits until the viewer has received N events
   - `verifySessionInHub(sessionId)` — asserts the session appears in the hub client's list

4. **Lifecycle helpers:**
   - `given()` / `when()` / `then()` — optional BDD aliases that return the scenario for chaining (they're just semantic sugar, same as direct method calls)

#### Part B: Integration Tests (`integration.test.ts`)

Comprehensive demo tests using the full harness:

1. **"Full session lifecycle"** — runner registers → session created → events flow → viewer receives → session ends → hub updated

2. **"Multi-runner environment"** — 2 runners, sessions on each, verify isolation

3. **"Conversation replay"** — create session, send conversation, connect late viewer, verify it gets replay

4. **"Inter-session messaging"** — create 2 sessions, send message between them, verify delivery

5. **"Trigger flow"** — create parent + child session, child sends trigger, parent receives it

6. **"Session meta state"** — send heartbeats with todo lists, verify meta state updates propagate to hub subscribers

### Implementation Notes

- Use `describe` / `test` from `bun:test`
- Each test should use its own `TestScenario` for isolation
- The scenario `setup()` should be idempotent — calling it twice should be safe
- `teardown()` should be robust — if setup fails partway, teardown should clean up what was created
- Use `beforeAll` / `afterAll` at the suite level if sharing a scenario is needed for performance
- Timeouts: use generous timeouts (5s) for Socket.IO operations since they involve async I/O

### Verification

```bash
cd packages/server && bun test tests/harness/integration.test.ts
bun run typecheck
```

---

## Kitchen Disconnect Log

### Fixer pass — 2026-03-24

**Root cause:** missing-context — cook focused on happy-path flows; missed error-path resource cleanup in `addSession()` and used a sender-side assertion instead of verifying delivery on the receiver.

#### P2 — Partial setup failure leaks relay socket in `addSession()`

**File:** `packages/server/tests/harness/scenario.ts`

**Problem:** `addSession()` creates a relay socket via `createIsolatedRelay()`, then calls `relay.registerSession()`. If `registerSession()` throws, the relay socket was never pushed to `_sessions`, meaning `reset()`/`teardown()` would never disconnect it — socket leak on every failed registration.

**Fix:** Wrapped the `registerSession()` call in try/catch. On failure, `relay.disconnect()` is called before re-throwing, ensuring the orphaned socket is always cleaned up regardless of registration outcome.

#### P3 — Weak trigger assertion in integration test

**File:** `packages/server/tests/harness/integration.test.ts` (Suite 4, "child session emits trigger targeting parent session")

**Problem:** The test set `const triggerId = \`trigger-${Date.now()}\`` and after emitting called `expect(triggerId).toBeTruthy()`. This is a tautology — `triggerId` is a non-empty string literal set before the emit; it can never be falsy. The test never verified the trigger was actually routed and delivered to the parent session.

**Fix:** Added `parentSession.relay.waitForEvent("session_trigger", 5_000)` before emitting (server emits `session_trigger` to target relay socket per `messaging.ts:199`). After emitting, the test now awaits this promise and asserts `deliveredTrigger.triggerId === triggerId`, `deliveredTrigger.sourceSessionId`, and `deliveredTrigger.targetSessionId` — confirming end-to-end routing through the server.

**Verification:** All 16 integration tests pass (`bun test tests/harness/integration.test.ts`), typecheck clean.

**Commit:** `0b84b1e` — fix: cleanup relay on addSession failure, strengthen trigger assertion
