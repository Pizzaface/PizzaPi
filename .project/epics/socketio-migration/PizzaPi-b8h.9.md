---
name: Backward Compatibility Shim for Raw WS Clients
status: open
created: 2026-02-22T20:50:58Z
updated: 2026-02-22T22:45:27Z
beads_id: PizzaPi-b8h.9
depends_on: [PizzaPi-b8h.5]
parallel: true
conflicts_with: []
---

# Task: Backward Compatibility Shim for Raw WS Clients

## Description

Keep the existing raw WebSocket `/ws/sessions` endpoint alive alongside Socket.IO for 1-2 releases so older CLI versions (pre-migration) can still connect. The server detects the protocol on connection and routes to either the legacy handler or Socket.IO namespace.

## Acceptance Criteria

- [ ] Raw WS `/ws/sessions` endpoint still accepts connections from old CLI versions
- [ ] Server detects whether a connection is Socket.IO (EIO protocol) or raw WS
- [ ] Legacy connections route to a thin compatibility handler that bridges to the new registry
- [ ] New Socket.IO connections route to namespace handlers as normal
- [ ] Both connection types can coexist on the same server instance
- [ ] Legacy handler reads/writes to the same Redis-backed state as Socket.IO handlers
- [ ] Console warning logged when legacy client connects: "Legacy WS client detected, consider upgrading"
- [ ] Feature flag or config option to disable legacy support when ready

## Technical Details

### Approach
- Socket.IO uses the `/socket.io/` path prefix by default for its HTTP handshake
- Raw WS connections to `/ws/sessions` use the original Bun `websocket` handler
- Keep the Bun.serve `websocket: { open, message, close }` handler but scope it to legacy paths only
- Legacy handler calls into the new Redis-backed registry functions (same data layer)

### Files to Modify
- `packages/server/src/index.ts` — keep Bun WS handler for legacy paths, Socket.IO for `/socket.io/`
- `packages/server/src/routes/ws.ts` — keep but mark as deprecated, simplify to only handle `/ws/sessions`

### Files to Create
- `packages/server/src/ws/legacy-shim.ts` — thin adapter bridging old `{ type, ...payload }` messages to new registry calls

### Deprecation Plan
- Log warning on every legacy connection
- Add `PIZZAPI_LEGACY_WS=true|false` env var (default `true` for 1-2 releases)
- After transition period, set default to `false`, then remove entirely

## Dependencies

- [ ] Task 005 (namespace handlers must be in place for Socket.IO path)

## Effort Estimate

- Size: S
- Hours: 4
- Parallel: true (independent of client migrations)

## Definition of Done

- [ ] Old CLI version can connect via raw WS and function correctly
- [ ] New CLI version connects via Socket.IO and functions correctly
- [ ] Both work simultaneously on the same server
- [ ] Deprecation warning logged for legacy connections
- [ ] Feature flag to disable legacy support works
- [ ] `bun run build:server` succeeds
