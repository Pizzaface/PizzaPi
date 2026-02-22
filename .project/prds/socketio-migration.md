---
name: socketio-migration
description: Migrate custom WebSocket relay to Socket.IO with Redis adapter for multi-server horizontal scaling
status: backlog
created: 2026-02-22T20:26:43Z
---

# PRD: Socket.IO Migration

## Executive Summary

Migrate PizzaPi's custom WebSocket relay layer to Socket.IO with the Redis adapter to enable multi-server horizontal scaling. The current implementation stores all session, viewer, runner, and terminal state in process-local `Map`s and `Set`s — fundamentally incompatible with running multiple server instances behind a load balancer. Socket.IO's `@socket.io/redis-adapter` provides battle-tested cross-server room broadcasts, automatic reconnection, namespace-based auth, and typed events, eliminating the need to build these primitives from scratch.

## Problem Statement

### Current Limitations

1. **Single-server bottleneck**: All relay state (shared sessions, viewer sets, runner registry, terminal entries, hub clients) lives in in-memory JavaScript `Map`/`Set` objects in `packages/server/src/ws/registry.ts` (~800 lines). A second server instance would have no awareness of sessions or viewers on the first.

2. **No cross-server fan-out**: `broadcastToViewers()` and `broadcastToHub()` iterate local `Set`s. If a TUI client connects to server A and a browser viewer connects to server B, the viewer receives nothing.

3. **Manual reconnection logic**: All three clients (UI in `App.tsx`/`SessionSidebar.tsx`/`WebTerminal.tsx`, CLI in `remote.ts`, runner in `daemon.ts`) implement their own reconnection with exponential backoff — ~200+ lines of duplicated retry logic.

4. **Untyped protocol**: Messages use a `{ type: string, ...payload }` convention with no compile-time validation. Protocol mismatches between server and clients are caught only at runtime.

5. **Manual room management**: Viewer tracking, hub client sets, terminal viewer assignment, and session-to-runner links are all hand-rolled with `Set.add()`/`Set.delete()` — code that Socket.IO rooms handle natively.

6. **Manual sequencing**: A custom `seq` counter + cumulative `event_ack` mechanism handles backpressure between TUI and server. Socket.IO provides built-in acknowledgements.

### Why This Matters Now

- Users are requesting the ability to run multiple relay servers for availability and geographic distribution
- The current architecture requires sticky sessions at the load balancer level even for basic operation, and still breaks cross-server viewer scenarios
- Redis is already in the stack (used for event caching), making the Socket.IO Redis adapter a natural fit

## User Stories

### Operator: Multi-Server Deployment
> As a self-hosted PizzaPi operator, I want to run 2+ relay servers behind a load balancer so that the system stays available if one server goes down, and I can scale horizontally as my team grows.

**Acceptance Criteria:**
- A TUI client connected to server A can have its events seen by a browser viewer on server B
- Runner daemons can connect to any server instance and receive `new_session` commands regardless of which server the browser request arrived on
- Hub clients on any server see a unified session list
- No data loss when a server instance restarts (viewers reconnect to another instance)

### Developer: Typed Protocol
> As a PizzaPi contributor, I want all WebSocket messages to be typed at compile time so that protocol changes are caught by `tsc` before they reach production.

**Acceptance Criteria:**
- A shared `packages/protocol/` package defines all event interfaces
- Server, UI, CLI, and runner all import from this package
- Adding a new event type without updating all consumers produces a type error

### Developer: Simplified Client Code
> As a PizzaPi contributor, I want automatic reconnection and room management so I don't have to maintain hand-rolled retry logic and viewer sets.

**Acceptance Criteria:**
- UI, CLI, and runner clients use Socket.IO client with built-in reconnection
- Manual `Set<ServerWebSocket>` viewer tracking replaced by Socket.IO rooms
- Net reduction in WebSocket-related code

### User: Seamless Reconnection
> As a PizzaPi web user, I want my session viewer to automatically reconnect and resume where I left off if my network drops momentarily.

**Acceptance Criteria:**
- Socket.IO's connection state recovery resumes event delivery after a brief disconnect
- No manual "resync" needed for gaps < 2 minutes (Socket.IO's default buffer window)

## Requirements

### Functional Requirements

#### FR-1: Shared Protocol Types Package
- Create `packages/protocol/` with TypeScript interfaces for all server↔client events
- Define separate event maps per namespace (sessions, viewer, runner, hub, terminal)
- Export `ServerToClientEvents`, `ClientToServerEvents`, `InterServerEvents`, and `SocketData` per namespace
- All packages (`server`, `ui`, `cli`) depend on `protocol`

#### FR-2: Socket.IO Server with Namespaces
- Replace Bun.serve's `websocket: { open, message, close }` handler with Socket.IO `Server`
- Map the 5 current WS endpoints to Socket.IO namespaces:
  | Current Endpoint | Namespace | Purpose |
  |------------------|-----------|---------|
  | `/ws/sessions` | `/relay` | TUI (CLI) clients registering live sessions |
  | `/ws/sessions/:id` | `/viewer` | Browser viewers watching a session |
  | `/ws/runner` | `/runner` | Runner daemon registration + commands |
  | `/ws/terminal/:id` | `/terminal` | Browser terminal PTY streams |
  | `/ws/hub` | `/hub` | Session list live feed |
- Each namespace has its own auth middleware (API key for relay/runner, session cookie for viewer/hub/terminal)
- The HTTP server (`Bun.serve`) continues to serve REST API routes alongside Socket.IO

#### FR-3: Redis Adapter for Cross-Server State
- Install `@socket.io/redis-adapter` (or `@socket.io/redis-streams-adapter`)
- Use the existing `PIZZAPI_REDIS_URL` connection for adapter pub/sub
- Room broadcasts (`io.to(sessionId).emit(...)`) automatically fan out across servers
- Shared state that's currently in-memory (`Map`s in `registry.ts`) migrates to Redis hashes/sets where needed for cross-server visibility:
  - Session metadata (owner, cwd, name, active status, heartbeat)
  - Runner registry (runnerId → capabilities, roots, skills)
  - Terminal registry (terminalId → runnerId, userId)

#### FR-4: Client Migration — Web UI
- Replace `new WebSocket(...)` in `App.tsx`, `SessionSidebar.tsx`, `WebTerminal.tsx` with `socket.io-client`
- Use namespace connections: `io("/viewer", { query: { sessionId } })`
- Remove manual reconnection, `onclose` retry timers, and sequence tracking
- Leverage Socket.IO's built-in `connect_error`, `reconnect`, `reconnect_attempt` events for status UI

#### FR-5: Client Migration — CLI Remote Extension
- Replace `new WebSocket(...)` in `remote.ts` with `socket.io-client`
- Use `/relay` namespace with `auth: { apiKey }` in handshake
- Replace `register` → `registered` handshake with Socket.IO connection auth + initial emit
- Remove manual reconnection with exponential backoff
- Use Socket.IO acknowledgements for event delivery confirmation (replacing `event_ack`)

#### FR-6: Client Migration — Runner Daemon
- Replace `new WebSocket(...)` in `daemon.ts` with `socket.io-client`
- Use `/runner` namespace with `auth: { apiKey, runnerId, runnerSecret }` in handshake
- Forward `new_session`, `kill_session`, skill commands via typed events
- Remove manual reconnection logic

#### FR-7: Connection State Recovery
- Enable Socket.IO v4's [Connection State Recovery](https://socket.io/docs/v4/connection-state-recovery) so that short disconnects (< 2 min) resume without full replay
- This replaces the current `resync` flow for brief interruptions
- For longer disconnects, fall back to Redis event cache replay (existing behavior)

#### FR-8: Thinking Duration Tracking
- Preserve the existing `thinkingStartTimes` / `thinkingDurations` tracking
- This is server-local state (tied to the TUI connection), so it stays in-memory but scoped to the socket instance
- The `augmentMessageThinkingDurations` logic moves into the `/relay` namespace handler

#### FR-9: Push Notification Integration
- Push notification triggers (`notifyAgentFinished`, `notifyAgentNeedsInput`, `notifyAgentError`) currently check `session.viewers.size > 0`
- With Socket.IO, replace this with `io.of("/viewer").adapter.sockets(new Set([sessionId]))` to get cross-server viewer count
- Only send push when the room is empty across all servers

### Non-Functional Requirements

#### NFR-1: Performance
- Throughput: Handle ≥ 1,000 concurrent sessions across a 3-server cluster without message loss
- Latency: < 50ms added latency for event relay compared to current direct WS (Socket.IO framing overhead is typically < 5ms)
- Memory: Redis adapter adds ~2KB per socket for pub/sub metadata — acceptable at scale

#### NFR-2: Bun Compatibility
- Socket.IO server must work with `Bun.serve`. As of Socket.IO v4.8+, Bun is supported via the `bun` adapter or by wrapping in a Node-compatible HTTP server
- Verify compatibility before starting implementation; if issues arise, consider using Bun's native `node:http` compatibility layer
- Run the existing test suite (if any) plus new integration tests under Bun

#### NFR-3: Bundle Size
- `socket.io-client` adds ~45KB gzipped to the UI bundle
- This is acceptable given the features gained; verify with `vite-bundle-visualizer`

#### NFR-4: Backward Compatibility (During Rollout)
- Support a transition period where old CLI versions using raw WS can still connect
- Option A: Keep the raw WS `/ws/sessions` endpoint active alongside Socket.IO for 1-2 releases
- Option B: Gate behind a feature flag / config version check
- The server detects protocol version on connection and routes accordingly

#### NFR-5: Observability
- Socket.IO's built-in `DEBUG=socket.io:*` logging for development
- Emit metrics (connections, rooms, adapter events) to structured logs
- Redis adapter errors surfaced in server health endpoint

#### NFR-6: Security
- Auth middleware per namespace (no change in auth model, just in where it's enforced)
- CORS configuration via Socket.IO's `cors` option (replaces manual headers)
- WebSocket-only transport (`transports: ["websocket"]`) for CLI/runner clients (skip HTTP long-polling overhead)
- Browser clients use default transport negotiation (polling → websocket upgrade) for maximum compatibility

## Success Criteria

| Metric | Target |
|--------|--------|
| Multi-server viewer fan-out | Viewer on server B receives events from TUI on server A within 100ms |
| Zero-downtime server restart | Viewers reconnect to surviving instance within Socket.IO's default reconnection window (1s) |
| Code reduction | Net reduction of ≥ 300 lines in WebSocket-related code (reconnection, viewer sets, seq tracking) |
| Type safety | 100% of WS events are typed; no `as any` casts in event handlers |
| Bundle size increase | UI bundle grows by < 50KB gzipped |
| All existing features preserved | Session viewing, collab mode, runner management, terminals, hub, push notifications all work identically |

## Constraints & Assumptions

### Constraints
- **Bun runtime**: Must continue using Bun.serve — cannot switch to Node.js. Socket.IO's Bun support must be verified first (spike task)
- **Redis required**: The Redis adapter requires a Redis instance; already a dependency in production
- **Patch compatibility**: The existing Bun patches for `@mariozechner/pi-coding-agent` and `@mariozechner/pi-ai` are unaffected (they don't touch WS code)

### Assumptions
- Socket.IO v4.8+ supports Bun (needs verification spike)
- The Redis adapter can share the same Redis instance used for event caching (separate key prefixes)
- `socket.io-client` works in both browser and Bun environments (Bun has `WebSocket` global)
- The TUI client (`remote.ts`) can use `socket.io-client` in a Bun process (not just Node)

## Out of Scope

- **Rewriting the Redis event cache** (`sessions/redis.ts`): The existing event caching for replay stays as-is. Socket.IO's adapter handles real-time cross-server fan-out; Redis caching is for historical replay.
- **Changing auth model**: Auth remains API key for CLI/runner and session cookie for browser. Only the enforcement point moves to Socket.IO middleware.
- **HTTP long-polling removal**: Socket.IO includes polling as a fallback. We won't disable it for browser clients (useful behind restrictive proxies), but CLI/runner clients will be configured as WS-only.
- **Migrating REST API to Socket.IO**: REST endpoints (`/api/*`) are unchanged. Only the 5 WS endpoints are migrated.
- **Load balancer configuration**: This PRD covers the application layer. Sticky sessions / cookie affinity at the LB level is an operational concern documented separately.

## Dependencies

### External
- `socket.io` (server) — v4.8+ for Bun support
- `socket.io-client` — matching version for UI, CLI, runner
- `@socket.io/redis-adapter` — for cross-server state
- Redis 6+ (already in stack)

### Internal
- `packages/protocol/` — new package, must be built before server/ui/cli
- Build order becomes: `protocol` → `tools` → `server` → `ui` → `cli`
- Vite proxy config may need updates for Socket.IO's transport negotiation

## Technical Notes

### Current File Inventory (to be modified)

| File | Lines | Changes |
|------|-------|---------|
| `packages/server/src/ws/relay.ts` | 710 | **Major rewrite** → namespace handlers |
| `packages/server/src/ws/registry.ts` | 796 | **Major rewrite** → Redis-backed state + Socket.IO rooms |
| `packages/server/src/routes/ws.ts` | 96 | **Remove** → replaced by Socket.IO middleware |
| `packages/server/src/index.ts` | ~80 | **Modify** → attach Socket.IO to Bun server |
| `packages/ui/src/App.tsx` | 2057 | **Modify** → replace WS with socket.io-client (~100 lines) |
| `packages/ui/src/components/SessionSidebar.tsx` | — | **Modify** → replace hub WS with socket.io-client |
| `packages/ui/src/components/WebTerminal.tsx` | — | **Modify** → replace terminal WS with socket.io-client |
| `packages/cli/src/extensions/remote.ts` | 1769 | **Modify** → replace WS with socket.io-client (~80 lines) |
| `packages/cli/src/runner/daemon.ts` | 975 | **Modify** → replace WS with socket.io-client (~60 lines) |
| `packages/protocol/` (new) | ~200 | **New** → typed event interfaces |

### Bun + Socket.IO Integration Pattern

```typescript
// packages/server/src/index.ts
import { Server } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import { createClient } from "redis";

const httpServer = Bun.serve({ /* existing fetch handler for REST */ });
const io = new Server(httpServer, {
  cors: { origin: process.env.PIZZAPI_BASE_URL, credentials: true },
  connectionStateRecovery: { maxDisconnectionDuration: 2 * 60 * 1000 },
});

// Redis adapter
const pubClient = createClient({ url: process.env.PIZZAPI_REDIS_URL });
const subClient = pubClient.duplicate();
await Promise.all([pubClient.connect(), subClient.connect()]);
io.adapter(createAdapter(pubClient, subClient));
```

### State Migration Summary

| Current (in-memory) | Target (Redis-backed) | Socket.IO Feature |
|----------------------|-----------------------|-------------------|
| `sharedSessions` Map | Redis hash `pizzapi:sessions:{id}` | — |
| `session.viewers` Set | Socket.IO room `session:{id}` | `socket.join()` / `io.to().emit()` |
| `hubClients` Set | Socket.IO room `hub:{userId}` | `socket.join()` |
| `runners` Map | Redis hash `pizzapi:runners:{id}` | — |
| `terminals` Map | Redis hash `pizzapi:terminals:{id}` | — |
| `thinkingStartTimes/Durations` | Stays in-memory (socket-scoped) | — |
| `seq` counter | Socket.IO ack or Redis INCR | Built-in acks |
| `pendingSkillRequests` | Stays in-memory (request-scoped) | Socket.IO acks |

## Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| Socket.IO doesn't work reliably with Bun.serve | Blocker | Spike task to verify before committing to migration |
| `socket.io-client` doesn't work in Bun CLI processes | Blocker | Test in spike; fallback: use `ws`-based engine.io client |
| Performance regression from Socket.IO framing overhead | Medium | Benchmark before/after; use WS-only transport for CLI/runner |
| Breaking change for existing CLI versions | High | Backward-compat WS endpoint during transition period |
| Redis adapter adds latency to broadcasts | Low | Redis is already local/low-latency; adapter overhead is ~1-2ms |
