# Dish 002: Relay Generic Service Envelope

- **Cook Type:** claude-sonnet-4-6
- **Complexity:** L
- **Godmother ID:** 9mOLVdjU (Phase 2)
- **Dependencies:** 001 (ServiceHandler pattern in daemon)
- **Band:** A (dispatchPriority=high)
- **Status:** served ✅

## Task Description

Add a generic `service_message` event to the relay protocol so runner services can communicate with viewers without the relay needing to understand service semantics.

This is ADDITIVE — no existing named events change. The `service_message` channel sits alongside them.

### Step 1: Update protocol types

In `packages/protocol/src/runner.ts`, add to `RunnerClientToServerEvents` (events runner sends to relay):
```typescript
/** Generic service message from runner to relay → viewer */
service_message: (envelope: ServiceEnvelope) => void;
/** Announce which services this runner supports (on connect) */
service_announce: (data: { serviceIds: string[] }) => void;
```

Add to `RunnerServerToClientEvents` (events relay sends to runner):
```typescript
/** Generic service message from viewer → relay → runner */
service_message: (envelope: ServiceEnvelope) => void;
```

In `packages/protocol/src/viewer.ts` (or shared.ts), add to viewer events:
```typescript
/** Generic service message from runner → relay → viewer */
service_message: (envelope: ServiceEnvelope) => void;
/** Runner announces supported services */
service_announce: (data: { serviceIds: string[] }) => void;
```

Viewer → relay (viewer sends these):
```typescript
/** Generic service message from viewer → relay → runner */
service_message: (envelope: ServiceEnvelope) => void;
```

Add to `packages/protocol/src/shared.ts` (or create a new export in runner.ts):
```typescript
export interface ServiceEnvelope {
    serviceId: string;
    type: string;
    requestId?: string;
    payload: unknown;
}
```

### Step 2: Update relay runner namespace

In `packages/server/src/ws/namespaces/runner.ts`, add after the existing event handlers:

```typescript
// ── Generic service message relay: runner → viewers ────────────────────────
socket.on("service_message", (envelope) => {
    if (!socket.data.runnerId) return;
    // Forward to all viewers watching this runner's sessions
    // Use the existing broadcast mechanism for the runner's sessions
    // (similar to how terminal_data is forwarded to terminal viewers)
    const runnerId = socket.data.runnerId;
    // Broadcast to all viewers connected to this runner
    io.of("/viewer").to(`runner:${runnerId}`).emit("service_message", envelope);
});

socket.on("service_announce", (data) => {
    if (!socket.data.runnerId) return;
    const runnerId = socket.data.runnerId;
    io.of("/viewer").to(`runner:${runnerId}`).emit("service_announce", { 
        runnerId, 
        serviceIds: data.serviceIds 
    });
});
```

Note: You need to study the existing `sendToTerminalViewer` and viewer broadcast patterns in runner.ts to use the correct room naming. The runner namespace joins rooms and broadcasts to viewers — follow the same pattern.

### Step 3: Update relay viewer namespace

In `packages/server/src/ws/namespaces/viewer.ts`, add:

```typescript
// ── Generic service message relay: viewer → runner ─────────────────────────
socket.on("service_message", async (envelope) => {
    const sessionId = socket.data.sessionId;
    if (!sessionId) return;
    // Forward to the runner handling this session
    // Use the existing `emitToRelaySession` or runner socket lookup pattern
    await emitToRelaySession(sessionId, "service_message", envelope);
});
```

Follow the same pattern as `exec` or `input` forwarding in viewer.ts.

### Step 4: Update daemon.ts to announce services on connect

In `packages/cli/src/runner/daemon.ts` (after Phase 1 wires the registry):

After calling `registry.initAll(...)`, emit a service announcement:
```typescript
socket.emit("service_announce", { 
    serviceIds: registry.getAll().map(s => s.id) 
});
```

This tells viewers which services are available on this runner.

### Step 5: Update services to also emit via envelope

For each of the three extracted services (TerminalService, FileExplorerService, GitService), add envelope emission alongside existing named events for key response messages. This is so the `useServiceChannel` hook in Phase 3 can receive them.

Example for TerminalService - when emitting `terminal_data`:
```typescript
// Existing:
(socket as any).emit("terminal_data", { terminalId, data: chunk });

// Also emit via service envelope (for useServiceChannel consumers):
socket.emit("service_message", {
    serviceId: "terminal",
    type: "terminal_data",
    payload: { terminalId, data: chunk }
});
```

Do this for the primary events:
- TerminalService: terminal_data, terminal_ready, terminal_exit, terminal_error, terminals_list
- FileExplorerService: file_result
- GitService: file_result (for git responses)

Keep the original named events — DO NOT remove them. Dual-emit is intentional for backward compatibility.

### Constraints
- ADDITIVE only — no existing events removed
- No changes to daemon.ts beyond service_announce emission (Phase 1 cook handles daemon)
- Run: `bun run typecheck && bun test packages/server packages/protocol`
- daemon.ts changes must be made AFTER confirming Phase 1 is complete
## Result
- **PR:** https://github.com/Pizzaface/PizzaPi/pull/317
- **Files:** 12 changed, 180 insertions(+), 9 deletions(-)
- **Notes:** Additive only — service_message + service_announce added to protocol, relay, services

## Critic Review (Round 1)
- **Critic:** gpt-5.3-codex (03abef66) — SEND BACK
- **P1-1:** runnerSessionIds not seeded from register_runner getConnectedSessionsForRunner — adopted sessions miss service_message forwarding
- **P1-2:** kill_terminal in TerminalService doesn't dual-emit terminal_exit/terminal_error via service_message
- **P3:** No tests for new relay paths (not blocking)
- **Fixer dispatched:** 13943029

## Kitchen Disconnect Diagnosis

**Category:** `prompt-gap`

The cook implemented dual-emit correctly for the `termSend` callback path (used for async pty events), but missed two orthogonal emission paths:

1. **`kill_terminal` / `list_terminals`** are event handlers that emit responses directly via `socket.emit()`, not through `termSend`. The task spec said "dual-emit for key response messages" and listed `terminal_exit`, `terminal_error`, `terminals_list` — but the cook only applied the pattern where `termSend` was already being used. The handlers that use raw `socket.emit()` (kill_terminal, list_terminals, new_terminal validation errors) were overlooked because they're structurally distinct and easy to miss when scanning for "emit" calls.

2. **`runnerSessionIds` not seeded** — the cook added session tracking in `session_ready` (correct) but didn't connect the dots to `register_runner`, where `getConnectedSessionsForRunner()` already fetches prior sessions. The sessions were fetched but only used for the `runner_registered` response payload, not for populating the tracking map.

Both are scope omissions: the cook understood the pattern but missed applying it to all emission sites.

## Fixer Actions (Round 1 → Replated)

**Commit:** `c1b57d6` — `fix(relay): seed runnerSessionIds from register_runner; fix kill_terminal dual-emit`

### P1-1 Fix
`packages/server/src/ws/namespaces/runner.ts` — After `getConnectedSessionsForRunner(result)` in the `register_runner` handler, iterate `existingSessions` and seed `runnerSessionIds` map so forwarding works on reconnect/re-register without waiting for `session_ready` events.

### P1-2 Fix
`packages/cli/src/runner/services/terminal-service.ts` — Added `service_message` dual-emit to:
- `kill_terminal` → `terminal_exit` and `terminal_error` responses
- `list_terminals` → `terminals_list` response
- `new_terminal` validation error paths (missing terminalId, bad cwd) → `terminal_error` responses

All direct `socket.emit()` calls in TerminalService are now at parity with the `termSend()` callback path.

**Verification:** Pre-existing typecheck errors (23) and test failures (47/47) unchanged by fixes. No regressions introduced.

## Critic Review (Round 2)
- **Critic:** gpt-5.3-codex (797823ae) — SEND BACK (3xP1)
- **P1-1:** service_announce emitted before register_runner completes — server drops it (runnerId not set yet)
- **P1-2:** FileExplorerService file_result error/validation paths don't dual-emit service_message
- **P1-3:** GitService file_result error/validation paths don't dual-emit service_message
- **Fixer dispatched:** round 2 (FINAL retry — food poisoning if this fails)

## Kitchen Disconnect (Round 2)
- **Root cause:** Systematic incomplete dual-emit — helper pattern not used, leaving error/validation paths uncovered
- **Category:** prompt-gap (spec didn't require a helper; cook applied dual-emit ad-hoc and missed non-happy paths)
- **Detail:** Cook dual-emitted on success paths but forgot error/validation early-returns. service_announce timing bug was a missing-context issue — spec said "after initAll()" but didn't explain that runnerId isn't set until register_runner completes.
- **Prevention:** Spec should require a helper function pattern explicitly; timing dependency on registration handshake should be called out.

## Fix Applied (Round 2)
- service_announce moved to runner_registered handler (after runnerId is confirmed set)
- emitFileResult helper in FileExplorerService replaces all direct file_result emits (error + success paths)
- emitFileResult helper in GitService replaces all direct file_result emits (error + success paths)
- Verified: grep shows zero remaining direct file_result emits in both services (only emit is inside helper itself)
- Commit: f5bbe72 — pushed to nightshift/dish-002-relay-service-envelope

## Additional Fix (Dish 003 cross-finding)
- **Issue:** service_announce emitted at runner_registered time may have no sessions in runnerSessionIds yet — relay drops it silently for any viewers awaiting a specific session
- **Fix:** Re-emit service_announce inside doSpawn() immediately after session_ready — by that point the session is in the relay's tracking map, so the announce is guaranteed to reach the session's viewer
- **Commit:** fb299b8 — pushed

## Fixer Result (Round 2 — commit fb299b8)
- service_announce moved to runner_registered (P1-1 from round 2)
- emitFileResult helper in FileExplorerService covers ALL paths (P1-2)  
- emitFileResult helper in GitService covers ALL paths (P1-3)
- ADDITIONAL: service_announce re-emitted at session_ready (two-point strategy)

## Critic Review (Round 3 — FINAL)
- **Critic:** gpt-5.3-codex (d3e405ec) — **LGTM ✅**
- service_announce timing correct (runner_registered + session_ready)
- FileExplorer: 1 hit = only the helper definition, zero scattered direct emits
- Git: same — all paths through helper
- runnerSessionIds seeding confirmed
- No regressions

## Health Inspection — 2026-03-25
- **Inspector Model:** claude-opus-4-6
- **Verdict:** VIOLATION ⚠️
- **Findings:**
  - **P1 (critical):** Viewer → runner `service_message` routing broken — `emitToRelaySession` sends to `/relay` namespace (TUI worker), not `/runner` namespace (daemon). All viewer-initiated service requests are silently dropped. Fix: use `emitToRunner(runnerId, "service_message", envelope)` in viewer.ts.
  - P2: No runtime validation on service_message envelope fields before forwarding
  - P2: `requestId` buried inside payload instead of hoisted to ServiceEnvelope top level in file/git emitFileResult helpers
  - P3: ServiceEnvelope type duplicated in 4 locations
  - P3: Unnecessary `(socket as any)` casts for service_message (now typed)
- **Critic Missed:** P1 routing namespace mismatch (3 rounds of critics confirmed partial patterns but never traced full message path)
- **Action:** BLOCK-MERGE until P1 fix lands
