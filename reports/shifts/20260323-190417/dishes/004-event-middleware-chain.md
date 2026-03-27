# Dish 004: Event Pipeline Middleware Chain

- **Cook Type:** sonnet
- **Complexity:** M
- **Godmother ID:** (new)
- **Dependencies:** 001 (relay decomposition)
- **Files:**
  - packages/server/src/ws/relay/event-pipeline.ts (new)
  - packages/server/src/ws/relay/middleware/index.ts (new)
  - packages/server/src/ws/relay/middleware/thinking.ts (new)
  - packages/server/src/ws/relay/middleware/images.ts (new)
  - packages/server/src/ws/relay/middleware/persist.ts (new)
  - packages/server/src/ws/relay/middleware/broadcast.ts (new)
  - packages/server/src/ws/relay/middleware/push.ts (new)
- **Verification:** bun test, bun run typecheck
- **Status:** queued

## Task Description

Refactor the event handler from a monolithic async function into a composable middleware chain. This is the foundation for the delta architecture — new event types can be handled by adding middleware, not modifying the pipeline.

### Current Problem

The event handler in relay.ts is a single ~170-line async function with deeply nested conditionals:

```
if (event.type === "session_active") { ... }
else if (event.type === "session_messages_chunk") { ... }
else if (event.type === "heartbeat") { ... }
else if (isMetaRelayEvent(event)) { ... }
else { ... }
// Then: thinking tracking
// Then: augment message_end
// Then: meta event routing check
// Then: chunked broadcast vs normal publish
// Then: push tracking
// Then: push notification check
```

### Solution

Define a `RelayMiddleware` type:

```typescript
interface EventContext {
  sessionId: string;
  event: Record<string, unknown>;
  socket: RelaySocket;
  // Mutable flags set by middleware:
  skipCache?: boolean;     // don't append to Redis event cache
  skipBroadcast?: boolean; // don't broadcast to viewers
  transformedEvent?: unknown; // modified event for downstream
}

type RelayMiddleware = (ctx: EventContext, next: () => Promise<void>) => Promise<void>;
```

### Middleware Stack (in order)

1. **sessionActivityMiddleware** — Updates lastState for session_active, handles chunked assembly, updates heartbeat
2. **thinkingMiddleware** — Tracks thinking start/end times, augments message_end with durations
3. **metaEventMiddleware** — Routes meta events to hub session meta rooms, sets skipBroadcast for pure meta
4. **imageStrippingMiddleware** — Strips inline images, stores as attachments
5. **persistMiddleware** — Appends to Redis event cache (unless skipCache)
6. **broadcastMiddleware** — Publishes to viewer rooms (unless skipBroadcast)
7. **pushMiddleware** — Tracks pending questions, fires push notifications (fire-and-forget)

### Benefits

- Each middleware is independently testable
- New event types (like `session_metadata_update` from Dish 002) just add/modify a middleware
- The delta architecture (future) replaces the session_active middleware without touching the rest
- Concerns are truly isolated — push tracking can't accidentally break chunked assembly
