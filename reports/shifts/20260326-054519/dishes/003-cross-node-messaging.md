# Dish 003: Cross-Node Messaging Fallback — session_message and session_trigger

- **Cook Type:** sonnet
- **Complexity:** S
- **Godmother ID:** i9uAYsf7
- **Dependencies:** none
- **Pairing:** none
- **Paired:** false
- **Files:** packages/server/src/ws/namespaces/relay/messaging.ts
- **Verification:** cd packages/server && bun run typecheck; bun test packages/server
- **Status:** cooking
- **Session:** 68b7ff75-6f37-4a40-b477-a26d295c861f
- **dispatchPriority:** high

## Task Description

### Problem
In multi-process (multi-node) deployments, `session_message` and `session_trigger` events fail silently when the target TUI socket is on a different server node. The handler calls `getLocalTuiSocket(targetSessionId)` — if null (target is on another node), it emits `session_message_error` with no cross-node delivery attempt.

`trigger_response` (line 262) already has the correct cross-node fallback pattern:
```ts
const targetSocket = getLocalTuiSocket(targetSessionId);
if (targetSocket) {
    targetSocket.emit("trigger_response" as any, triggerPayload);
    // ...
} else if (!await emitToRelaySessionVerified(targetSessionId, "trigger_response", triggerPayload)) {
    socket.emit("session_message_error", { ... });
}
```

### Fix

Apply the identical pattern to `session_message` (around line 87) and `session_trigger` (around line 180).

**For session_message (~line 87):**
Current code (approximately):
```ts
const targetSocket = getLocalTuiSocket(targetSessionId);
// targetSocket is null → falls through to error
socket.emit("session_message_error", { message: "Target session not found" });
```
After fix:
```ts
const targetSocket = getLocalTuiSocket(targetSessionId);
if (targetSocket) {
    targetSocket.emit("session_message" as string, { ... payload ... });
    socket.emit("session_message_ack", { ... });
} else if (!await emitToRelaySessionVerified(targetSessionId, "session_message", { ... payload ... })) {
    socket.emit("session_message_error", {
        message: "Target session not found on any node",
        targetSessionId,
    });
}
```

**For session_trigger (~line 180):**
Apply the same pattern — check `getLocalTuiSocket` first, then `emitToRelaySessionVerified` as fallback, then error only if both fail.

### Important Notes
- Read the trigger_response handler (lines 209–280) carefully to understand the exact emitToRelaySessionVerified call signature, the existing verification checks (parent-child relationship, session existence), and how the fallback payload is constructed.
- Preserve all existing authorization checks before the delivery code — the only change is: replace "null socket → immediate error" with "null socket → try relay → error if relay also fails".
- This is a single-file change to messaging.ts.

### Verification
```bash
cd packages/server && bun run typecheck
bun test packages/server
```
TypeScript must be clean. Tests must pass (especially any messaging tests).

## Status History
| Time | Status | Notes |
|------|--------|-------|
| 05:52 | queued | Created in Prep — Band A, high priority |
