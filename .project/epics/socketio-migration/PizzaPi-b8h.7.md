---
name: Migrate CLI remote.ts to socket.io-client
status: open
created: 2026-02-22T20:50:58Z
updated: 2026-02-22T22:45:27Z
beads_id: PizzaPi-b8h.7
depends_on: [PizzaPi-b8h.5]
parallel: true
conflicts_with: []
---

# Task: Migrate CLI remote.ts to socket.io-client

## Description

Replace the raw WebSocket connection in `packages/cli/src/extensions/remote.ts` (1,769 lines) with `socket.io-client` using the `/relay` namespace. Remove manual reconnection with exponential backoff and the custom `seq`/`event_ack` mechanism, replacing them with Socket.IO's built-in reconnection and acknowledgements.

## Acceptance Criteria

- [ ] `remote.ts` connects to `/relay` namespace with `auth: { apiKey }` and `transports: ["websocket"]`
- [ ] TUI registration handshake uses Socket.IO connection auth + initial emit (replacing `register` → `registered` flow)
- [ ] Session events sent via typed `socket.emit()` calls instead of `ws.send(JSON.stringify(...))`
- [ ] Manual reconnection with exponential backoff removed
- [ ] `seq` counter and `event_ack` handling removed (use Socket.IO acks)
- [ ] Remote exec commands (abort, set model, new session, compact, etc.) received via typed events
- [ ] Provider usage and heartbeat events sent via typed events
- [ ] All events typed via `@pizzapi/protocol` imports
- [ ] `socket.io-client` added to CLI package dependencies

## Technical Details

### Files to Modify
- `packages/cli/package.json` — add `socket.io-client`
- `packages/cli/src/extensions/remote.ts` — major refactor of WS connection logic

### Key Changes in remote.ts
1. **Connection setup**: Replace `new WebSocket(relayUrl)` with `io(relayUrl + "/relay", { auth, transports: ["websocket"] })`
2. **Registration**: Move from explicit `register` message to connection auth + `socket.on("connect")` callback
3. **Event sending**: Replace `ws.send(JSON.stringify({ type, ...payload }))` with `socket.emit(eventName, payload)`
4. **Event receiving**: Replace `ws.onmessage` JSON parse + switch on `type` with `socket.on(eventName, handler)`
5. **Reconnection**: Remove `scheduleReconnect()`, backoff timers — Socket.IO handles this
6. **Acks**: Replace `seq`/`event_ack` with Socket.IO callback acks where delivery confirmation needed
7. **Disconnect handling**: Use `socket.on("disconnect")` and `socket.on("reconnect")` events

### Estimated Line Reduction
- ~80 lines of reconnection logic removed
- ~30 lines of seq/ack tracking removed
- ~20 lines of JSON serialization simplified
- Net: ~100-130 lines removed

## Dependencies

- [ ] Task 005 (server `/relay` namespace handler must be in place)

## Effort Estimate

- Size: M
- Hours: 8
- Parallel: true (independent of Tasks 006, 008)

## Definition of Done

- [ ] CLI connects to relay via Socket.IO `/relay` namespace
- [ ] All session events flow correctly (register, events, heartbeat, state)
- [ ] Remote exec commands work (abort, set model, new session, etc.)
- [ ] No remaining raw `WebSocket` usage in remote.ts
- [ ] Manual reconnection code removed
- [ ] `bun run build:cli` succeeds
- [ ] `bun run typecheck` passes
