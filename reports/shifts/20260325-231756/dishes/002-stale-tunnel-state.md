# Dish 002: Stale Tunnel State on Reconnect

- **Cook Type:** sonnet
- **Complexity:** S
- **Band:** A (clarityScore=93, riskScore=9, confidenceScore=88)
- **Godmother ID:** X85Kp2tX
- **Pairing:** tunnel-overhaul (role: related — cooks simultaneously with Dish 001)
- **Paired:** true
- **Pairing Partners:** 001-tunnel-overhaul-core
- **Dependencies:** none (independent files from Dish 001)
- **dispatchPriority:** high
- **Files:**
  - `packages/ui/src/components/TunnelPanel.tsx` (find exact path — may be in service-panels/)
  - `packages/ui/src/components/TunnelPanel.test.tsx` (create if not exists)
- **Verification:** `bun run typecheck && bun test packages/ui` + sandbox visual check
- **Status:** ramsey-cleared
- **Session:** 8a5e9877-12f4-441b-ba7f-06aace77354c

## Ramsey Report — 2026-03-26 03:49 UTC
- **Verdict:** pass
- **Demerits found:** 3 (P0: 0, P1: 0, P2: 1, P3: 2)
- **Automated gates:** typecheck: pass, tests: 4/4 + 650/0 full suite, sandbox: screenshot taken

### Demerits
- P2: JSDoc on `const send` invisible to consumers — should be on `ServiceChannel.send` interface property
- P3: No test for rapid available toggling (true→false→true in same tick)
- P3: `iframeLoading` not reset alongside `previewPort` in disconnect branch

### Summary
Core fix correct and well-targeted. State cleared atomically in the same render pass. Zero window for stale flash. Test 3 correctly proves the reconnect cycle. No P0/P1.

## Task Description

### Objective
Fix TunnelPanel showing stale tunnel entries briefly after socket reconnect. Health Inspector citation on PR #319.

### Branch Setup
```bash
git checkout main
git checkout -b nightshift/dish-002-stale-tunnel-state
```

### Find the File
```bash
find packages/ui/src -name "TunnelPanel*" -o -name "tunnel-panel*"
```

### The Bug
`TunnelPanel` keeps `tunnels` state across disconnect/reconnect because the component is never unmounted — it just returns `null` when `available=false`. When `available` flips back to `true` on reconnect, the old `tunnels` array is still in state and renders stale entries until the `tunnel_list_result` response arrives.

### Current Code
```typescript
useEffect(() => {
  if (available) send("tunnel_list", {});
}, [available, send]);
```

### Fix
```typescript
useEffect(() => {
  if (available) {
    send("tunnel_list", {});
  } else {
    setTunnels([]);          // clear stale list on disconnect
    setPreviewPort(null);    // clear iframe — stale port URL is dead
  }
}, [available, send]);
```

**Also:** Add a comment to `useServiceChannel.ts` (or the relevant hook) noting that `send()` should only be called when `available=true`, to prevent future consumers from silently emitting to a disconnected socket.

Find `useServiceChannel` and check if it documents the `available` guard pattern.

### Tests
Create `TunnelPanel.test.tsx` (or update existing):
- Mock `useServiceChannel` returning `{available: true/false, send: mockSend, on: mockOn}`
- Test 1: When `available` goes false → `tunnels` should become `[]`
- Test 2: When `available` goes true → `send("tunnel_list", {})` should be called
- Test 3: No stale tunnels visible after reconnect cycle

### Sandbox Verification (MANDATORY)
```bash
# Build
bun run build

# Start sandbox
screen -dmS sandbox bash -c 'cd packages/server && exec bun tests/harness/sandbox.ts --headless --redis=memory > /tmp/sandbox-out.log 2>&1'
sleep 8
grep "UI (HMR)" /tmp/sandbox-out.log

# Log in and navigate to a session
playwright-cli open http://127.0.0.1:<VITE_PORT>
playwright-cli snapshot && playwright-cli fill <email-ref> "testuser@pizzapi-harness.test"
playwright-cli fill <password-ref> "HarnessPass123"
playwright-cli snapshot && playwright-cli click <sign-in-button-ref>
playwright-cli screenshot  # confirm logged in

# If the sandbox exposes a tunnel via the mock runner, verify TunnelPanel shows it
# Then simulate disconnect: screenshot before and after panel state change
playwright-cli screenshot

# Clean up
playwright-cli close
screen -S sandbox -X quit
```

Attach screenshot confirming the app runs and no console errors related to TunnelPanel.

### Commit Message
```
fix(ui): clear stale tunnel state on socket disconnect

TunnelPanel retains tunnels[] across disconnect/reconnect because
the component never unmounts. Clear tunnels and previewPort when
available goes false so stale entries don't flash on reconnect.

Closes: X85Kp2tX (Health Inspector citation on PR #319)
```
