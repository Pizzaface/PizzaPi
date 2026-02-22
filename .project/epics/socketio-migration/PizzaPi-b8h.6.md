---
name: Migrate UI WebSocket Connections to socket.io-client
status: open
created: 2026-02-22T20:50:58Z
updated: 2026-02-22T22:45:27Z
beads_id: PizzaPi-b8h.6
depends_on: [PizzaPi-b8h.5]
parallel: true
conflicts_with: []
---

# Task: Migrate UI WebSocket Connections to socket.io-client

## Description

Replace all `new WebSocket(...)` usage in the React UI with `socket.io-client` namespace connections. Remove manual reconnection logic and leverage Socket.IO's built-in reconnection, typed events, and connection status.

## Acceptance Criteria

- [ ] `App.tsx` viewer connection uses `io("/viewer", { query: { sessionId } })` instead of raw WS
- [ ] `SessionSidebar.tsx` hub connection uses `io("/hub")` instead of raw WS
- [ ] `WebTerminal.tsx` terminal connection uses `io("/terminal", { query: { terminalId } })` instead of raw WS
- [ ] All manual reconnection/backoff code removed (~100+ lines across 3 files)
- [ ] Connection status UI uses Socket.IO events (`connect`, `disconnect`, `reconnect_attempt`, `reconnect`)
- [ ] All events typed via `@pizzapi/protocol` imports
- [ ] `socket.io-client` added to UI package dependencies
- [ ] UI bundle size increase < 50KB gzipped (verified with build output)
- [ ] Vite proxy config updated for Socket.IO transport negotiation if needed

## Technical Details

### Files to Modify
- `packages/ui/package.json` — add `socket.io-client`
- `packages/ui/src/App.tsx` — replace viewer WS with socket.io-client
- `packages/ui/src/components/SessionSidebar.tsx` — replace hub WS with socket.io-client
- `packages/ui/src/components/WebTerminal.tsx` — replace terminal WS with socket.io-client
- `packages/ui/vite.config.ts` — update proxy for Socket.IO (if needed)

### Migration Pattern (per component)
```typescript
// Before
const ws = new WebSocket(`${wsUrl}/ws/sessions/${sessionId}`);
ws.onmessage = (e) => { /* parse JSON, handle types */ };
ws.onclose = () => { /* manual reconnect with backoff */ };

// After
import { io, Socket } from "socket.io-client";
import type { ViewerServerToClient, ViewerClientToServer } from "@pizzapi/protocol";

const socket: Socket<ViewerServerToClient, ViewerClientToServer> = io("/viewer", {
  query: { sessionId },
  withCredentials: true,
});
socket.on("session_event", (event) => { /* fully typed */ });
socket.on("disconnect", (reason) => { /* auto-reconnect built in */ });
```

### Items to Remove
- `reconnectTimeout` / `reconnectDelay` / exponential backoff variables
- `scheduleReconnect()` functions
- Manual `onclose` → `setTimeout` → `new WebSocket()` chains
- `readyState` polling checks

## Dependencies

- [ ] Task 005 (server namespace handlers must be in place)

## Effort Estimate

- Size: M
- Hours: 8
- Parallel: true (independent of Tasks 007, 008)

## Definition of Done

- [ ] All 3 UI components use socket.io-client
- [ ] No remaining `new WebSocket` in UI source
- [ ] Manual reconnection code removed
- [ ] Events fully typed (no `any` casts)
- [ ] `bun run build:ui` succeeds
- [ ] `bun run typecheck` passes
- [ ] Bundle size verified < 50KB gzipped increase
