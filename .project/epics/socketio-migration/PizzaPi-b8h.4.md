---
name: Migrate Registry to Redis-Backed State and Socket.IO Rooms
status: done
created: 2026-02-22T20:50:58Z
updated: 2026-02-22T22:45:27Z
beads_id: PizzaPi-b8h.4
depends_on: [PizzaPi-b8h.3]
parallel: false
conflicts_with: [PizzaPi-b8h.5]
---

# Task: Migrate Registry to Redis-Backed State and Socket.IO Rooms

## Description

Rewrite `packages/server/src/ws/registry.ts` (~796 lines) to replace in-memory `Map`/`Set` state with Redis hashes for cross-server visibility and Socket.IO rooms for viewer/hub tracking. This is the core data layer change enabling horizontal scaling.

## Acceptance Criteria

- [ ] Session metadata stored in Redis hashes (`pizzapi:sessions:{id}`) instead of in-memory `Map`
- [ ] Runner registry stored in Redis hashes (`pizzapi:runners:{id}`) instead of in-memory `Map`
- [ ] Terminal registry stored in Redis hashes (`pizzapi:terminals:{id}`) instead of in-memory `Map`
- [ ] Viewer tracking uses Socket.IO rooms (`session:{id}`) instead of `Set<ServerWebSocket>`
- [ ] Hub client tracking uses Socket.IO rooms (`hub`) instead of `Set<ServerWebSocket>`
- [ ] `thinkingStartTimes`/`thinkingDurations` remain in-memory (socket-scoped)
- [ ] All registry functions updated with async signatures where Redis calls are needed
- [ ] `broadcastToViewers()` replaced by `io.to(sessionId).emit()`
- [ ] `broadcastToHub()` replaced by `io.to("hub").emit()`
- [ ] Cross-server viewer count available via `io.of("/viewer").adapter.sockets()`
- [ ] Push notification logic uses cross-server viewer count

## Technical Details

### State Migration Map
| Current | Target | Mechanism |
|---------|--------|-----------|
| `sharedSessions` Map | Redis hash per session | `HSET/HGET/HDEL` |
| `session.viewers` Set | Socket.IO room | `socket.join("session:{id}")` |
| `session.tuiWs` | Socket reference on `/relay` namespace | Socket instance |
| `hubClients` Set | Socket.IO room "hub" | `socket.join("hub")` |
| `runners` Map | Redis hash per runner | `HSET/HGET/HDEL` |
| `terminals` Map | Redis hash per terminal | `HSET/HGET/HDEL` |
| `seq` counter | Redis INCR or Socket.IO acks | `INCR pizzapi:seq:{id}` |

### Files to Modify
- `packages/server/src/ws/registry.ts` — major rewrite (all functions)

### Files to Create
- `packages/server/src/ws/redis-state.ts` — Redis hash helpers for session/runner/terminal CRUD

### Key Considerations
- Registry functions become async (callers in relay.ts / namespace handlers must await)
- Redis serialization: store JSON in hash fields, parse on read
- Session `tuiWs` socket reference stays local (it's the connection to this specific server)
- TTL on Redis keys for auto-cleanup of stale sessions
- Sweep logic (`sweepExpiredSharedSessions`) adapts to check Redis instead of local Map

## Dependencies

- [ ] Task 003 (Socket.IO server + Redis adapter must be in place)

## Effort Estimate

- Size: L
- Hours: 10
- Parallel: false (modifies the core data layer)

## Definition of Done

- [ ] All registry functions work with Redis + rooms
- [ ] Cross-server fan-out verified (viewer on server B sees events from TUI on server A)
- [ ] No remaining in-memory `Map`/`Set` for shared state (except thinking tracking)
- [ ] Existing sweep/cleanup logic works with Redis state
- [ ] `bun run typecheck` passes
- [ ] `bun run build:server` succeeds
