---
name: Implement Namespace Handlers with Auth Middleware
status: done
created: 2026-02-22T20:50:58Z
updated: 2026-02-22T22:45:27Z
beads_id: PizzaPi-b8h.5
depends_on: [PizzaPi-b8h.4]
parallel: false
conflicts_with: []
---

# Task: Implement Namespace Handlers with Auth Middleware

## Description

Replace the monolithic `relay.ts` (710 lines) with per-namespace Socket.IO event handlers. Each namespace gets its own auth middleware and typed event handlers using the protocol package. Remove `routes/ws.ts` (96 lines) as Socket.IO handles upgrade + auth natively.

## Acceptance Criteria

- [ ] `/relay` namespace: TUI registration, session events, heartbeat, state, exec commands — with API key auth
- [ ] `/viewer` namespace: session event streaming, viewer messages, exec commands — with session cookie auth
- [ ] `/runner` namespace: runner registration, new_session, kill_session, skills, usage — with API key auth
- [ ] `/terminal` namespace: PTY data, resize, spawn, kill — with session cookie auth
- [ ] `/hub` namespace: session list feed (started/ended/updated) — with session cookie auth
- [ ] Auth middleware per namespace validates credentials before connection
- [ ] `thinking_start`/`thinking_end`/`augmentMessageThinkingDurations` logic ported to `/relay` handler
- [ ] `routes/ws.ts` removed
- [ ] All event types imported from `@pizzapi/protocol`

## Technical Details

### Files to Create/Modify
- `packages/server/src/ws/namespaces/relay.ts` — full implementation (from placeholder)
- `packages/server/src/ws/namespaces/viewer.ts` — full implementation
- `packages/server/src/ws/namespaces/runner.ts` — full implementation
- `packages/server/src/ws/namespaces/terminal.ts` — full implementation
- `packages/server/src/ws/namespaces/hub.ts` — full implementation
- `packages/server/src/ws/namespaces/auth.ts` — shared auth middleware factories

### Files to Remove
- `packages/server/src/routes/ws.ts`

### Files to Modify
- `packages/server/src/ws/relay.ts` — remove (replaced by namespace handlers)
- `packages/server/src/index.ts` — remove old `websocket: { open, message, close }` references (keep during transition if Task 009 runs concurrently)

### Port Logic From relay.ts
1. **TUI registration flow** → `/relay` namespace `connection` + `register` event
2. **Session event forwarding** → `/relay` `session_event` → `io.to("session:{id}").emit()`
3. **Heartbeat handling** → `/relay` `heartbeat` event
4. **State snapshots** → `/relay` `session_active` event
5. **Exec commands** (from viewer) → `/viewer` events → forwarded to TUI via `/relay`
6. **Runner registration** → `/runner` namespace `connection` + auth
7. **Terminal PTY** → `/terminal` namespace binary data events
8. **Hub session feed** → `/hub` namespace with room-based broadcast

### Auth Middleware Pattern
```typescript
relayNamespace.use((socket, next) => {
  const apiKey = socket.handshake.auth.apiKey;
  if (!apiKey || !validateApiKey(apiKey)) return next(new Error("unauthorized"));
  socket.data.userId = lookupUserId(apiKey);
  next();
});
```

## Dependencies

- [ ] Task 004 (registry must be Redis-backed before handlers can use it)

## Effort Estimate

- Size: L
- Hours: 12
- Parallel: false (core server logic, touches most server files)

## Definition of Done

- [ ] All 5 namespace handlers fully functional
- [ ] Auth middleware validates correctly per namespace
- [ ] Thinking duration tracking works in `/relay` handler
- [ ] `routes/ws.ts` removed
- [ ] All events typed with protocol package (no `any` casts)
- [ ] `bun run build:server` succeeds
- [ ] `bun run typecheck` passes
