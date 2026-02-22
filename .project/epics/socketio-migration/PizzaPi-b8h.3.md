---
name: Integrate Socket.IO Server with Bun.serve and Redis Adapter
status: open
created: 2026-02-22T20:50:58Z
updated: 2026-02-22T22:45:27Z
beads_id: PizzaPi-b8h.3
depends_on: [PizzaPi-b8h.1, PizzaPi-b8h.2]
parallel: false
conflicts_with: [PizzaPi-b8h.4, PizzaPi-b8h.5]
---

# Task: Integrate Socket.IO Server with Bun.serve and Redis Adapter

## Description

Set up the Socket.IO server instance attached to PizzaPi's existing Bun.serve HTTP server. Configure the Redis adapter for cross-server pub/sub, enable Connection State Recovery, and define the 5 namespaces with placeholder handlers. This establishes the server-side foundation for the migration.

## Acceptance Criteria

- [ ] Socket.IO Server created and attached to Bun.serve in `src/index.ts`
- [ ] Redis adapter configured using existing `PIZZAPI_REDIS_URL` with distinct key prefix
- [ ] Connection State Recovery enabled (2-minute window)
- [ ] 5 namespaces registered: `/relay`, `/viewer`, `/runner`, `/terminal`, `/hub`
- [ ] CORS configured via Socket.IO options (replacing manual headers)
- [ ] Existing REST API routes (`/api/*`) continue working alongside Socket.IO
- [ ] Server starts without errors and accepts Socket.IO connections
- [ ] `socket.io`, `@socket.io/redis-adapter` added to server dependencies

## Technical Details

### Files to Modify
- `packages/server/package.json` — add `socket.io`, `@socket.io/redis-adapter` dependencies
- `packages/server/src/index.ts` — attach Socket.IO to Bun.serve, configure adapter + CORS + CSR

### Files to Create
- `packages/server/src/ws/namespaces/index.ts` — namespace registration entry point
- `packages/server/src/ws/namespaces/relay.ts` — placeholder `/relay` namespace
- `packages/server/src/ws/namespaces/viewer.ts` — placeholder `/viewer` namespace
- `packages/server/src/ws/namespaces/runner.ts` — placeholder `/runner` namespace
- `packages/server/src/ws/namespaces/terminal.ts` — placeholder `/terminal` namespace
- `packages/server/src/ws/namespaces/hub.ts` — placeholder `/hub` namespace

### Integration Pattern
```typescript
import { Server } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";

// Attach to existing Bun.serve
const io = new Server(server, {
  cors: { origin: ALLOWED_ORIGINS, credentials: true },
  connectionStateRecovery: { maxDisconnectionDuration: 2 * 60 * 1000 },
  transports: ["websocket", "polling"],
});

// Redis adapter (reuse existing Redis URL, separate prefix)
io.adapter(createAdapter(pubClient, subClient, { key: "pizzapi-sio" }));
```

### Key Consideration
- The existing `websocket: { open, message, close }` handler on Bun.serve must coexist with Socket.IO during the transition period (Task 009 handles backward compat)

## Dependencies

- [ ] Task 001 (spike confirms Bun compatibility)
- [ ] Task 002 (protocol types for namespace typing)

## Effort Estimate

- Size: M
- Hours: 6
- Parallel: false (foundation for tasks 004-005)

## Definition of Done

- [ ] Server starts with Socket.IO attached
- [ ] Redis adapter connects and logs successful initialization
- [ ] All 5 namespaces accept connections (verified with socket.io-client)
- [ ] REST API routes unaffected
- [ ] `bun run build:server` succeeds
- [ ] `bun run typecheck` passes
