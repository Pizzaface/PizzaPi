# Dish 003: Mock Session & Conversation Builders

- **Cook Type:** sonnet
- **Complexity:** M
- **Godmother ID:** uTWRUjFU
- **Dependencies:** 001
- **Files:** `packages/server/tests/harness/mock-relay.ts`, `packages/server/tests/harness/builders.ts`
- **Verification:** `cd packages/server && bun test tests/harness/builders.test.ts`, `bun run typecheck`
- **Status:** queued
- **dispatchPriority:** high

## Task Description

Create factory builders for sessions (via the `/relay` namespace) and conversation events (heartbeats, messages, tool calls, etc.).

### Requirements

#### Part A: Mock Relay Client (`mock-relay.ts`)

1. **`createMockRelay(server, opts?)`** — factory that:
   - Connects a `socket.io-client` to `server.baseUrl/relay` with API key auth
   - Returns a `MockRelay` object

2. **`MockRelay` interface:**
   - `socket: Socket`
   - `registerSession(opts?)` — emits `register` event, waits for `registered` response. Returns `{ sessionId, token, shareUrl }`
   - `emitEvent(sessionId, token, event, seq?)` — sends an agent event through the relay
   - `emitSessionEnd(sessionId, token)` — signals session end
   - `emitTrigger(data)` — fires a `session_trigger`
   - `emitTriggerResponse(data)` — fires a `trigger_response`
   - `emitSessionMessage(data)` — fires a `session_message`
   - `waitForEvent(eventName, timeout?)` — promise
   - `disconnect()`

#### Part B: Event Builders (`builders.ts`)

Factory functions that produce correctly-shaped agent events. All builders return plain objects matching the protocol shapes.

1. **`buildHeartbeat(overrides?)`** — creates a heartbeat event with sensible defaults:
   - `type: "heartbeat"`
   - `sessionId`, `model`, `cwd`, `tokenUsage`, `isStreaming`, etc.
   - Supports overrides for any field

2. **`buildMessageEvent(overrides?)`** — creates a `message_update` or `message_delta` event:
   - `role: "assistant"` with `content` blocks (text, tool_use, tool_result)
   - Supports building multi-turn conversations

3. **`buildToolCallEvent(toolName, input, overrides?)`** — shorthand for tool_use content blocks

4. **`buildToolResultEvent(toolCallId, output, overrides?)`** — shorthand for tool_result content blocks

5. **`buildConversation(turns)`** — builds a full conversation history as a sequence of events:
   ```ts
   buildConversation([
     { role: "user", text: "Hello" },
     { role: "assistant", text: "Hi there!" },
     { role: "assistant", toolCall: { name: "bash", input: { command: "ls" } } },
     { role: "tool", result: "file1.ts\nfile2.ts" },
   ])
   ```

6. **`buildSessionInfo(overrides?)`** — creates a `SessionInfo` object

7. **`buildRunnerInfo(overrides?)`** — creates a `RunnerInfo` object

8. **`buildMetaState(overrides?)`** — creates a `SessionMetaState` object with defaults from `defaultMetaState()`

9. **`buildTodoList(items)`** — shorthand for `MetaTodoItem[]`

### Implementation Notes

- Look at `packages/protocol/src/relay.ts` for relay event shapes
- Look at `packages/protocol/src/meta.ts` for `SessionMetaState`, `MetaTodoItem`, etc.
- Look at `packages/protocol/src/shared.ts` for `SessionInfo`, `RunnerInfo`, `ModelInfo`
- The relay `register` event expects `{ sessionId?, cwd, ephemeral?, collabMode?, sessionName?, parentSessionId? }`
- The relay responds with `registered` event containing `{ sessionId, token, shareUrl }`
- Event builders should use `Date.now()` for timestamps but allow overrides for deterministic tests
- All builders should be pure functions (no side effects, no server dependency)

### Verification

```bash
cd packages/server && bun test tests/harness/builders.test.ts
bun run typecheck
```

Write tests that:
1. Build a heartbeat and verify shape
2. Build a full conversation and verify sequence
3. Create a mock relay, register a session, emit events, verify they're stored
4. Build meta state with todos and verify structure

---

## Kitchen Disconnect — Fixer Report

**Root Cause:** Concurrent-unsafe event correlation + invented protocol event type

**Category:** missing-context

**Issues Fixed:**

### P2 — `registerSession()` race condition (serialized)
Concurrent `registerSession()` calls on the same socket both listened on `once("registered")`, meaning the first event resolved both. Fixed by adding `_registerLock`: a promise-chain queue that serializes all registration calls. Each call chains off the previous via `.then(doRegister, doRegister)`; the lock swallows errors so failures don't jam future calls.

### P2 — `buildConversation()` emitted non-protocol `user_message` events
`user_message` doesn't exist in the relay protocol — user input flows through the `/viewer` namespace as `input` events, not through relay event emissions. Fixed by renaming to `harness:user_turn` with a comment clearly marking it as test scaffolding only, not a protocol event. Callers should not emit these to the relay.

### P3 — JSDoc claimed builders were "pure functions"
Builders use a module-level `_blockIdCounter`, `Math.random()`, and `Date.now()` — they are stateful and non-deterministic. Updated the module docblock to remove the "pure" claim and document the non-determinism with guidance to use overrides for deterministic tests.

### P3 — `buildAssistantMessage` overrides used `Record<string, unknown>`
`as AssistantMessageEvent` cast allowed malformed overrides to bypass type checking. Changed to `Partial<AssistantMessageEvent>` so the spread is type-safe and no cast is needed.

**Tests Updated:** `builders.test.ts` — two tests updated to expect `harness:user_turn` instead of `user_message`.

**Verification:** 31/31 tests pass, typecheck clean.

**Prevention:** Cook prompts for relay work should explicitly note that relay only carries server→client events; user input arrives via the viewer namespace. This would have prevented the `user_message` invention.
