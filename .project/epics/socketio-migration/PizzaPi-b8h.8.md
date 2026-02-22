---
name: Migrate Runner daemon.ts to socket.io-client
status: open
created: 2026-02-22T20:50:58Z
updated: 2026-02-22T22:45:27Z
beads_id: PizzaPi-b8h.8
depends_on: [PizzaPi-b8h.5]
parallel: true
conflicts_with: []
---

# Task: Migrate Runner daemon.ts to socket.io-client

## Description

Replace the raw WebSocket connection in `packages/cli/src/runner/daemon.ts` (975 lines) with `socket.io-client` using the `/runner` namespace. Remove manual reconnection logic and use typed events for runner registration, session management, and skill commands.

## Acceptance Criteria

- [ ] `daemon.ts` connects to `/runner` namespace with `auth: { apiKey, runnerId, runnerSecret }` and `transports: ["websocket"]`
- [ ] Runner registration uses Socket.IO connection auth (replacing manual `register` message)
- [ ] `new_session`, `kill_session`, skill commands received via typed events
- [ ] Manual reconnection with exponential backoff removed
- [ ] Runner heartbeat and usage data sent via typed events
- [ ] All events typed via `@pizzapi/protocol` imports
- [ ] `socket.io-client` already in CLI package (shared with remote.ts from Task 007)

## Technical Details

### Files to Modify
- `packages/cli/src/runner/daemon.ts` — refactor WS connection logic

### Key Changes in daemon.ts
1. **Connection setup**: Replace `new WebSocket(...)` with `io(relayUrl + "/runner", { auth: { apiKey, runnerId, runnerSecret }, transports: ["websocket"] })`
2. **Registration**: Move from explicit `register` message to connection auth + `socket.on("connect")`
3. **Command handling**: Replace `ws.onmessage` switch on `type` with `socket.on("new_session", ...)`, `socket.on("kill_session", ...)`, etc.
4. **Reconnection**: Remove manual backoff — Socket.IO handles this
5. **Status reporting**: Replace `ws.send(JSON.stringify(...))` with `socket.emit(eventName, payload)`

### Estimated Line Reduction
- ~60 lines of reconnection logic removed
- ~15 lines of JSON serialization simplified
- Net: ~60-75 lines removed

## Dependencies

- [ ] Task 005 (server `/runner` namespace handler must be in place)

## Effort Estimate

- Size: S
- Hours: 5
- Parallel: true (independent of Tasks 006, 007)

## Definition of Done

- [ ] Runner daemon connects via Socket.IO `/runner` namespace
- [ ] Registration, session spawning, and skill commands work correctly
- [ ] No remaining raw `WebSocket` usage in daemon.ts
- [ ] Manual reconnection code removed
- [ ] `bun run build:cli` succeeds
- [ ] `bun run typecheck` passes
