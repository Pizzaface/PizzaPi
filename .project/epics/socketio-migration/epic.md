---
name: socketio-migration
status: backlog
created: 2026-02-22T20:47:24Z
progress: 0%
prd: .project/prds/socketio-migration.md
beads_id: PizzaPi-b8h
---

# Epic: socketio-migration

## Overview

Migrate PizzaPi's custom Bun WebSocket relay to Socket.IO with the Redis adapter, enabling multi-server horizontal scaling. The current architecture stores all session/viewer/runner/terminal state in process-local `Map`/`Set` objects across ~1,500 lines in `registry.ts` and `relay.ts`. Socket.IO replaces hand-rolled room management, reconnection logic, and cross-server fan-out with battle-tested primitives, while a new `packages/protocol/` package provides compile-time type safety for all WebSocket events.

## Architecture Decisions

- **Socket.IO v4.8+ on Bun**: Socket.IO supports Bun via its `node:http` compatibility layer. A spike task verifies this before committing to the migration. CLI/runner clients use `transports: ["websocket"]` (skip HTTP polling); browser clients use default transport negotiation.
- **Namespace-per-concern**: Map the 5 current WS endpoints to Socket.IO namespaces (`/relay`, `/viewer`, `/runner`, `/terminal`, `/hub`). Each namespace has its own typed event maps and auth middleware.
- **Redis adapter for fan-out**: Use `@socket.io/redis-adapter` on the existing `PIZZAPI_REDIS_URL`. Room broadcasts automatically span servers. Session metadata, runner registry, and terminal registry move to Redis hashes for cross-server visibility.
- **Shared protocol package**: New `packages/protocol/` exports `ServerToClientEvents`, `ClientToServerEvents`, `InterServerEvents`, and `SocketData` per namespace. All packages depend on it, giving compile-time safety.
- **Backward compatibility shim**: Keep raw WS `/ws/sessions` endpoint alive for 1–2 releases so older CLI versions still connect. Server detects protocol on connection and routes accordingly.
- **Connection State Recovery**: Enable Socket.IO v4's built-in recovery (2-min window) to replace the manual `resync` flow for brief disconnects. Longer gaps fall back to Redis event cache replay.

## Technical Approach

### New Package: `packages/protocol/`

- TypeScript interfaces for all event maps, organized by namespace
- Shared `SocketData` type (replacing `WsData` for Socket.IO metadata)
- Exported as ESM; added to build order before `server`, `ui`, `cli`
- ~200 lines total, derived from the existing `{ type: string }` message protocol in `relay.ts`

### Server Changes (`packages/server/`)

- **`src/index.ts`**: Attach `Socket.IO Server` to the Bun HTTP server. Configure Redis adapter, CORS, connection state recovery. Keep existing `fetch` handler for REST routes.
- **`src/ws/relay.ts` → `src/ws/namespaces/`**: Split the monolithic 710-line relay handler into per-namespace modules (`relay.ts`, `viewer.ts`, `runner.ts`, `terminal.ts`, `hub.ts`). Each module registers event handlers on its namespace.
- **`src/ws/registry.ts`**: Replace in-memory `Map`/`Set` state with:
  - Socket.IO rooms for viewer sets, hub clients, terminal viewers (eliminates `Set<ServerWebSocket>` tracking)
  - Redis hashes for session metadata, runner registry, terminal registry (cross-server visibility)
  - Keep `thinkingStartTimes`/`thinkingDurations` as socket-scoped in-memory state
- **`src/routes/ws.ts`**: Remove entirely (Socket.IO handles upgrade + auth via namespace middleware)
- **Auth middleware**: Per-namespace Socket.IO middleware replaces `handleWsUpgrade` auth checks. API key auth for `/relay` and `/runner`; session cookie auth for `/viewer`, `/hub`, `/terminal`.
- **Push notifications**: Replace `session.viewers.size > 0` with `io.of("/viewer").adapter.sockets(new Set([sessionId]))` for cross-server viewer count.

### UI Changes (`packages/ui/`)

- Replace `new WebSocket(...)` in `App.tsx`, `SessionSidebar.tsx`, `WebTerminal.tsx` with `socket.io-client` namespace connections
- Remove all manual reconnection/backoff logic (~100+ lines across 3 files)
- Use Socket.IO's `connect_error`, `reconnect`, `reconnect_attempt` events for connection status UI
- Import typed event maps from `packages/protocol/`

### CLI Changes (`packages/cli/`)

- **`remote.ts`**: Replace `new WebSocket(...)` with `io("/relay", { auth: { apiKey }, transports: ["websocket"] })`. Remove manual reconnection with exponential backoff. Use Socket.IO acks instead of `seq`/`event_ack`.
- **`daemon.ts`**: Replace `new WebSocket(...)` with `io("/runner", { auth: { apiKey, runnerId, runnerSecret }, transports: ["websocket"] })`. Remove manual reconnection logic.

### Infrastructure

- No new infrastructure required — Redis is already in the stack
- Redis adapter uses separate pub/sub connections with distinct key prefixes (no conflict with event cache)
- Docker Compose config unchanged (same Redis service)

## Implementation Strategy

1. **Spike first**: Verify Socket.IO + Bun compatibility before any production code changes
2. **Protocol package**: Build the shared types package (unblocks all other work)
3. **Server-side migration**: Refactor registry + relay into namespace handlers with Redis-backed state
4. **Client migration**: Update UI, CLI, and runner clients (can proceed in parallel once server namespaces are up)
5. **Backward compat**: Add shim for raw WS clients during transition
6. **Validation**: End-to-end testing of multi-server fan-out, reconnection, and all existing features

## Task Breakdown Preview

- [ ] Task 1: Bun + Socket.IO compatibility spike (verify server + client work under Bun)
- [ ] Task 2: Create `packages/protocol/` with typed event interfaces for all 5 namespaces
- [ ] Task 3: Server — integrate Socket.IO server with Bun.serve, Redis adapter, and connection state recovery
- [ ] Task 4: Server — migrate registry.ts to Redis-backed state + Socket.IO rooms
- [ ] Task 5: Server — implement namespace handlers (relay, viewer, runner, terminal, hub) with auth middleware
- [ ] Task 6: Client — migrate UI WebSocket connections to socket.io-client
- [ ] Task 7: Client — migrate CLI remote.ts to socket.io-client
- [ ] Task 8: Client — migrate runner daemon.ts to socket.io-client
- [ ] Task 9: Backward compatibility shim for raw WS CLI clients
- [ ] Task 10: End-to-end validation and multi-server fan-out testing

## Dependencies

### External
- `socket.io` v4.8+ (server)
- `socket.io-client` (UI, CLI, runner)
- `@socket.io/redis-adapter` (server)
- Redis 6+ (already in stack)

### Internal
- `packages/protocol/` must be built before `server`, `ui`, `cli`
- Build order becomes: `protocol` → `tools` → `server` → `ui` → `cli`
- Vite proxy config may need adjustment for Socket.IO transport negotiation

### Task Dependencies
- Task 1 (spike) gates all other tasks
- Task 2 (protocol) gates Tasks 3–8
- Tasks 3–5 (server) gate Tasks 6–8 (clients)
- Tasks 6, 7, 8 can proceed in parallel
- Task 9 can proceed after Task 5
- Task 10 requires all other tasks complete

## Success Criteria (Technical)

- **Multi-server fan-out**: Viewer on server B receives events from TUI on server A within 100ms
- **Zero-downtime restart**: Viewers reconnect to surviving instance within 1s
- **Code reduction**: Net ≥ 300 lines removed from WebSocket-related code
- **Type safety**: 100% of WS events typed; zero `as any` casts in event handlers
- **Bundle size**: UI bundle grows by < 50KB gzipped
- **Feature parity**: Session viewing, collab mode, runner management, terminals, hub, push notifications all work identically
- **Bun compatibility**: All tests pass under Bun runtime

## Tasks Created
- [ ] PizzaPi-b8h.1 - Bun + Socket.IO Compatibility Spike (parallel: false)
- [ ] PizzaPi-b8h.10 - End-to-End Validation and Multi-Server Fan-Out Testing (parallel: false)
- [ ] PizzaPi-b8h.2 - Create packages/protocol with Typed Event Interfaces (parallel: false)
- [ ] PizzaPi-b8h.3 - Integrate Socket.IO Server with Bun.serve and Redis Adapter (parallel: false)
- [ ] PizzaPi-b8h.4 - Migrate Registry to Redis-Backed State and Socket.IO Rooms (parallel: false)
- [ ] PizzaPi-b8h.5 - Implement Namespace Handlers with Auth Middleware (parallel: false)
- [ ] PizzaPi-b8h.6 - Migrate UI WebSocket Connections to socket.io-client (parallel: true)
- [ ] PizzaPi-b8h.7 - Migrate CLI remote.ts to socket.io-client (parallel: true)
- [ ] PizzaPi-b8h.8 - Migrate Runner daemon.ts to socket.io-client (parallel: true)
- [ ] PizzaPi-b8h.9 - Backward Compatibility Shim for Raw WS Clients (parallel: true)

Total tasks: 10
Parallel tasks: 4
Sequential tasks: 6
## Estimated Effort

- **Overall timeline**: 2–3 weeks (assuming spike passes in first 1–2 days)
- **Critical path**: Spike → Protocol → Server migration → Client migration → Validation
- **Parallelism**: After server namespaces are live, UI/CLI/runner client migrations can proceed concurrently (3 parallel streams)
- **Risk buffer**: 2–3 days for Bun compatibility issues or unexpected Socket.IO edge cases
- **Breakdown by task**:
  - Spike: 0.5 day
  - Protocol package: 0.5 day
  - Server migration (Tasks 3–5): 4–5 days
  - Client migrations (Tasks 6–8): 3–4 days (parallel)
  - Backward compat shim: 1 day
  - E2E validation: 1–2 days
