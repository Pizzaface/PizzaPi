# Dish 002: Redis Health Endpoint + Degraded Mode Banner

- **Cook Type:** sonnet
- **Complexity:** M
- **Godmother ID:** q6aqxRbA
- **Dependencies:** none
- **Priority:** P2
- **Status:** served

## Files
- `packages/server/src/index.ts` (modify — add health status tracking)
- `packages/server/src/routes/index.ts` (modify — upgrade /health response)
- `packages/ui/src/components/DegradedBanner.tsx` (create)
- `packages/ui/src/App.tsx` (modify — mount banner)

## Verification
```bash
bun run typecheck
bun run build
bun test packages/server
```

## Task Description

A `/health` endpoint exists at `packages/server/src/routes/index.ts:44` but returns static `{ status: "ok" }` regardless of Redis state. Redis failure is caught at `index.ts:190` — server continues without Socket.IO but nothing exposes this to the UI. WebSocket connections silently fail.

**Changes:**

1. **Track Redis/Socket.IO status** — In `packages/server/src/index.ts`, export a module-level status object:
   ```ts
   export const serverHealth = { redis: false, socketio: false, startedAt: Date.now() };
   ```
   Set `redis: true, socketio: true` after successful init. Leave as `false` in the catch block.

2. **Upgrade `/health` endpoint** — Return `status: "ok" | "degraded"`, plus `redis`, `socketio`, `uptime` fields.

3. **Create `DegradedBanner.tsx`** — Dismissable amber banner:
   - On mount, `fetch("/health")` and check status
   - If degraded: "⚠️ Server running in degraded mode — real-time updates unavailable"
   - Dismiss button hides for session
   - Auto-retry every 30s — hide if Redis recovers
   - Style: `bg-amber-500/10 text-amber-600 dark:text-amber-400`

4. **Mount in App.tsx** — Add `<DegradedBanner />` above main content, inside auth gate.
