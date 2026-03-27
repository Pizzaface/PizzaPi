# Dish 002: Hub Socket Deduplication — Single /hub Connection Per Tab

- **Cook Type:** sonnet
- **Complexity:** M
- **Godmother ID:** wexNsZ1X
- **Dependencies:** 001 (pairing-dependency)
- **Pairing:** ui-reliability
- **Pairing Role:** main
- **Pairing Partners:** 001-react-state-hygiene
- **Paired:** true
- **Files:** packages/ui/src/App.tsx, packages/ui/src/components/SessionSidebar.tsx
- **Verification:** cd packages/ui && bun run typecheck; bun test packages/ui
- **Status:** queued
- **dispatchPriority:** normal

## Task Description

### Problem
Every browser tab opens **2 connections** to the `/hub` Socket.IO namespace:
1. `App.tsx:2121` — `const socket = io("/hub", { withCredentials: true })` stored in `hubSocketRef`
2. `SessionSidebar.tsx:606` — `const socket = io("/hub", { withCredentials: true })` created independently

This doubles server-side connection count and memory. Both scouts confirmed this independently.

### Fix Strategy

Pass the existing hub socket ref from App.tsx down to SessionSidebar as a prop (or pass the socket itself). SessionSidebar should consume the shared socket rather than creating its own.

**Approach A — prop drilling (simplest):**
1. In `App.tsx`, look at what events `SessionSidebar` listens to on its own hub socket
2. Add appropriate props to `SessionSidebar` to receive the hub socket or a callback for the events it needs
3. In `SessionSidebar`, remove the `io("/hub", ...)` call and use the passed-in socket/callback instead
4. Ensure SessionSidebar does NOT call `socket.disconnect()` on the shared socket when it unmounts

**Approach B — React context (cleaner but more code):**
Create a `HubSocketContext` that provides the hub socket, wrap the app in the provider, and consume it in SessionSidebar. This is more scalable but adds a file.

**Recommendation:** Use Approach A (prop drilling) since SessionSidebar is a direct child and this avoids adding a new context. If SessionSidebar already has a hub socket prop in its interface, use that path.

### Key Constraint
- `SessionSidebar` must NOT disconnect the shared hub socket on unmount. The socket's lifecycle is owned by `App.tsx`.
- The socket instance and event handlers from SessionSidebar should register and deregister properly to avoid the N+1 listener stacking pattern.

### Scope
- Only changes needed: SessionSidebar.tsx (remove io("/hub") call) + App.tsx (pass socket ref/socket down)
- Do NOT change any business logic in either file — only the socket creation/sharing
- Do NOT touch any other files unless strictly necessary for TypeScript types

### Verification
```bash
cd packages/ui && bun run typecheck
bun test packages/ui
```
TypeScript must be clean. Tests must pass.

## Status History
| Time | Status | Notes |
|------|--------|-------|
| 05:52 | queued | Created in Prep — blocked on 001 (pairing-dependency) |
