# PizzaPi Relay/Event System Refactoring — Architectural Design Spec

**Author:** Prep Chef (Night Shift)  
**Date:** 2026-03-23  
**Status:** Draft — Ready for Menu Planning

---

## Architecture Overview

### Current State

```
┌─────────────────────────────────────────────────────────────────────┐
│                        CURRENT ARCHITECTURE                        │
│                                                                    │
│  Runner (CLI)              Server (Bun)              UI (React)    │
│  ┌──────────┐         ┌─────────────────┐        ┌──────────────┐ │
│  │ pi agent │──SIO──▶ │  /relay (1183L) │──SIO──▶│ App.tsx      │ │
│  │          │ /relay   │    GOD MODULE   │ /viewer│  (4018L)     │ │
│  │          │         │                 │        │  48 useStates │ │
│  └──────────┘         │  ┌────────────┐ │        │  chunked asm │ │
│                       │  │ Thinking   │ │        │  seq tracking│ │
│  Runner Daemon        │  │ Img Strip  │ │        └──────────────┘ │
│  ┌──────────┐         │  │ Chunk Asm  │ │                         │
│  │ daemon   │──SIO──▶ │  │ Push Track │ │        ┌──────────────┐ │
│  │          │ /runner  │  │ Msg Route  │ │        │   Hub Feed   │ │
│  └──────────┘         │  │ Lifecycle  │ │        │  (sidebar)   │ │
│                       │  │ Serialize  │ │        └──────────────┘ │
│                       │  └────────────┘ │                         │
│                       │                 │                         │
│                       │  PERSISTENCE:   │                         │
│                       │  ┌────────────┐ │                         │
│                       │  │ Redis Hash │ │  sio-state.ts (1046L)   │
│                       │  │ Redis List │ │  sessions/redis.ts      │
│                       │  │ SQLite     │ │  sessions/store.ts      │
│                       │  └────────────┘ │                         │
│                       └─────────────────┘                         │
└─────────────────────────────────────────────────────────────────────┘
```

### Target State

```
┌─────────────────────────────────────────────────────────────────────┐
│                        TARGET ARCHITECTURE                         │
│                                                                    │
│  Runner (CLI)              Server (Bun)              UI (React)    │
│  ┌──────────┐         ┌─────────────────┐        ┌──────────────┐ │
│  │ pi agent │──SIO──▶ │  /relay          │──SIO──▶│ App.tsx      │ │
│  │          │ /relay   │  event-pipeline │ /viewer│  (shell)     │ │
│  │          │         │     │           │        │              │ │
│  └──────────┘         │  ┌──┴──────────┐│        │ useSession() │ │
│                       │  │ Middleware  ││        │ useRelay()   │ │
│  Runner Daemon        │  │ Chain:      ││        │ useMessages()│ │
│  ┌──────────┐         │  │             ││        └──────────────┘ │
│  │ daemon   │──SIO──▶ │  │ ┌─thinking ││                         │
│  │          │ /runner  │  │ ├─imgstrip ││        ┌──────────────┐ │
│  └──────────┘         │  │ ├─meta     ││        │ SessionView  │ │
│                       │  │ ├─push     ││        │  useDeltas() │ │
│                       │  │ └─publish  ││        │  useSeq()    │ │
│                       │  └────────────┘│        └──────────────┘ │
│                       │                │                         │
│                       │  session-mgr   │                         │
│                       │  ├─lifecycle   │                         │
│                       │  ├─messaging   │                         │
│                       │  └─triggers    │                         │
│                       │                │                         │
│                       │  PERSISTENCE:  │                         │
│                       │  ┌────────────┐│                         │
│                       │  │Redis Stream││  (event log)            │
│                       │  │Redis Hash  ││  (session metadata)     │
│                       │  │SQLite      ││  (durable archive)      │
│                       │  └────────────┘│                         │
│                       └─────────────────┘                         │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 1. Delta-Based Event Architecture

### 1.1 Problem Statement

Today, the runner emits `session_active` — a full state snapshot containing every message — after every agent turn. For a 200-message session with tool outputs and images, this is 10-50MB per turn. The chunked delivery "fix" added ~300 lines of state-machine code across 3 files, introduced 4 confirmed P1 bugs, and is fundamentally process-local (breaks multi-node).

### 1.2 Design

#### Core Principle: Snapshot Once, Stream Deltas

The runner sends a full snapshot **only** on initial connect or explicit resync. After that, the server already receives granular events (`message_update`, `message_end`, `turn_end`, `tool_execution_start`, etc.) — these are the deltas. The problem is that `session_active` is used as the source of truth for viewer reconnection, which forces the full snapshot on every turn.

#### Protocol Changes

**New events (server → viewer):**

```typescript
// No new wire events needed for the delta path — the existing event
// stream (message_update, message_end, turn_end, etc.) IS the delta
// stream. The change is in WHEN session_active is sent.

// New: lightweight state patch for metadata-only changes
interface SessionStatePatch {
  type: "session_state_patch";
  patch: {
    sessionName?: string;
    isActive?: boolean;
    model?: { provider: string; id: string } | null;
    // extensible — no messages payload
  };
}
```

**Modified behavior:**

| Event | Current | Proposed |
|-------|---------|----------|
| `session_active` | After every turn (full snapshot) | Only on: (1) viewer connect/resync, (2) session switch (`/resume`, `/new`) |
| Agent events | Broadcast to viewers + cached | Same — no change |
| Viewer reconnect | Gets `session_active` from `lastState` in Redis | Gets `session_active` from Redis event stream replay |
| Metadata changes | Embedded in `session_active` or heartbeat | Via `session_state_patch` |

#### Reconnection Protocol

When a viewer reconnects or connects for the first time:

```
1. Viewer connects to /viewer namespace
2. Server sends `connected { sessionId, lastSeq }`
3. Viewer sends `resync { fromSeq }` (0 for fresh, or last known seq)
4. Server computes gap:
   a. If fromSeq == 0 or gap too large: send full snapshot from Redis Stream
   b. If gap is small: replay missed events from Redis Stream (seq > fromSeq)
5. After replay, viewer receives live events normally via room broadcast
```

**Gap threshold:** If the viewer missed more than 500 events, send a snapshot instead of replaying (configurable via `PIZZAPI_RESYNC_THRESHOLD`). The snapshot is constructed from the last `session_active` or `agent_end` event in the stream.

#### Seq-Based Gap Detection (Already Partially Exists)

The viewer already tracks `lastSeqRef` and detects gaps. The change is:

1. Server includes `seq` on every event (already does this via `publishSessionEvent`)
2. Viewer checks `receivedSeq > expectedSeq + 1` → requests resync with `fromSeq`
3. Server replays from Redis Stream starting at `fromSeq`

This replaces the current behavior where a gap triggers a full `session_active` re-emit from the runner.

#### What Gets Removed

| Component | Lines | What it does | Replacement |
|-----------|-------|-------------|-------------|
| `pendingChunkedStates` Map | ~30 | In-memory chunk assembly | Eliminated — no chunks |
| `ChunkedSessionState` interface | ~10 | Chunk buffer type | Eliminated |
| `sessionEventQueues` Map | ~15 | Serialization for chunk ordering | Simplified — events are already ordered by seq |
| `getPendingChunkedSnapshot()` export | ~15 | Cross-module chunk state query | Eliminated |
| `session_messages_chunk` handler in relay.ts | ~50 | Chunk receipt + assembly | Eliminated |
| Chunked `session_active` path | ~30 | Metadata-only SA for chunked sessions | Eliminated |
| `chunkedDeliveryRef` in App.tsx | ~60 lines of UI logic | Client chunk assembly + stale rejection | Eliminated |
| `lastCompletedSnapshotRef` in App.tsx | ~15 | Stale chunk rejection | Eliminated |
| `awaitingSnapshotRef` gating | ~20 | Defer live events during hydration | Replaced by seq-based replay |
| Chunked path in viewer.ts `resync` | ~25 | Skip snapshot during chunk delivery | Eliminated |
| Total **removed** | **~270 lines** | | |

#### Runner-Side Changes

The runner (CLI) must stop sending `session_active` after every turn. This is a change in the `emitSessionActive()` function in the pi extension. The runner should:

1. Send `session_active` when the viewer sends `connected` (triggers re-emit, already happens)
2. Send `session_active` on `/new` and `/resume` (session switch — new conversation)
3. **Not** send `session_active` after `agent_end` (the `agent_end` event itself carries the final message state)

**Backward compatibility:** Old runners that still send `session_active` after every turn will work — the server just processes it as a normal event (updates lastState, broadcasts to viewers). The performance penalty remains for old runners, but nothing breaks.

#### Server-Side lastState

Currently `lastState` in Redis is the JSON-stringified full session state, updated every turn. With deltas:

- `lastState` is still updated when `session_active` arrives (less frequently now)
- `lastState` is also updated from `agent_end` events (which carry full message arrays)
- For viewers connecting when no `lastState` exists, the server replays from the Redis event stream

### 1.3 Data Flow Diagram

```
  Runner                  Server                    Viewer
    │                       │                         │
    │──session_active──────▶│ (initial connect only)  │
    │                       │──event{SA,seq=1}───────▶│
    │                       │                         │
    │──event{msg_update}──▶│                         │
    │                       │──event{msg_upd,seq=2}──▶│
    │                       │                         │
    │──event{msg_end}─────▶│                         │
    │                       │──event{msg_end,seq=3}──▶│
    │                       │                         │
    │──event{agent_end}───▶│ (update lastState)      │
    │                       │──event{agnt_end,seq=4}─▶│
    │                       │                         │
    │   (next turn...)      │                         │
    │──event{msg_update}──▶│                         │
    │                       │──event{msg_upd,seq=5}──▶│
    │                       │                         │
    │                       │     ✕ viewer disconnects │
    │                       │                         │
    │──event{msg_end}─────▶│  (seq=6, cached)        │
    │──event{turn_end}────▶│  (seq=7, cached)        │
    │                       │                         │
    │                       │     viewer reconnects ──│
    │                       │◀─resync{fromSeq=5}──────│
    │                       │                         │
    │                       │ (replay seq 6,7 from    │
    │                       │  Redis Stream)          │
    │                       │──event{msg_end,seq=6}──▶│
    │                       │──event{turn_end,seq=7}─▶│
    │                       │                         │
```

---

## 2. Relay Module Decomposition

### 2.1 Problem Statement

`relay.ts` (1,183 lines) handles 8+ concerns in a single file with interleaved logic. Adding or modifying any concern requires understanding the entire module. In-memory maps (`thinkingStartTimes`, `thinkingDurations`, `pendingChunkedStates`, `sessionEventQueues`, `socketAckedSeqs`) create implicit cross-handler dependencies.

### 2.2 Proposed Module Structure

```
packages/server/src/ws/namespaces/relay/
├── index.ts              (~80 lines)   # registerRelayNamespace — wires handlers
├── event-pipeline.ts     (~120 lines)  # Main event handler + middleware chain
├── session-lifecycle.ts  (~100 lines)  # register, session_end, disconnect
├── messaging.ts          (~150 lines)  # session_message, session_trigger, trigger_response
├── child-lifecycle.ts    (~200 lines)  # cleanup_child_session, delink_children, delink_own_parent
├── thinking-tracker.ts   (~80 lines)   # Thinking-block duration tracking
├── push-tracker.ts       (~80 lines)   # Push notification state + checks
└── ack-tracker.ts        (~30 lines)   # Per-socket cumulative ack tracking
```

#### 2.2.1 `index.ts` — Namespace Registration

Thin wiring module. Creates the namespace, applies auth middleware, and delegates each event to its handler module.

```typescript
// packages/server/src/ws/namespaces/relay/index.ts
export function registerRelayNamespace(io: SocketIOServer): void {
  const relay = io.of("/relay");
  relay.use(apiKeyAuthMiddleware());
  
  relay.on("connection", (socket) => {
    registerSessionLifecycleHandlers(socket);
    registerEventPipelineHandler(socket);
    registerMessagingHandlers(socket);
    registerChildLifecycleHandlers(socket);
  });
}
```

#### 2.2.2 `event-pipeline.ts` — Middleware Chain

The current `socket.on("event", ...)` handler has 6 concerns interleaved in a single async function. Refactor to a middleware chain:

```typescript
// Each middleware transforms or side-effects the event, then calls next()
type EventMiddleware = (
  ctx: EventContext,
  next: () => Promise<void>,
) => Promise<void>;

interface EventContext {
  sessionId: string;
  socket: RelaySocket;
  event: Record<string, unknown>;
  eventToPublish: unknown;  // may be mutated by middleware
  seq?: number;
}

// Pipeline composition
const pipeline: EventMiddleware[] = [
  ackMiddleware,           // Send cumulative ack to runner
  stateUpdateMiddleware,   // Update lastState for session_active/agent_end
  heartbeatMiddleware,     // Handle heartbeat events
  metaEventMiddleware,     // Route meta events to hub
  thinkingMiddleware,      // Track thinking durations
  imageStripMiddleware,    // Extract inline base64 images
  publishMiddleware,       // Broadcast to viewers + cache in Redis
  pushMiddleware,          // Fire-and-forget push notification check
];
```

**Key benefit:** Each middleware is independently testable. The pipeline is explicit about ordering. New concerns (rate limiting, logging, metrics) can be added as middleware without touching existing code.

#### 2.2.3 `session-lifecycle.ts`

Handles `register`, `session_end`, and `disconnect`. These are currently clean enough but entangled with chunked-state cleanup. After removing chunked delivery, this module simplifies significantly.

```typescript
export function registerSessionLifecycleHandlers(socket: RelaySocket): void {
  socket.on("register", async (data) => { /* ... */ });
  socket.on("session_end", async (data) => { /* ... */ });
  socket.on("disconnect", async (reason) => { /* ... */ });
}
```

#### 2.2.4 `messaging.ts`

Inter-session messaging (`session_message`) and the viewer→runner trigger routing (`session_trigger`, `trigger_response`). These are already logically separate in relay.ts — the extraction is mechanical.

#### 2.2.5 `child-lifecycle.ts`

The most complex handlers: `cleanup_child_session`, `delink_children`, `delink_own_parent`. These have extensive validation logic and race-condition handling. Extracting them into their own module makes the parent-child lifecycle auditable independently.

#### 2.2.6 `thinking-tracker.ts`

Pure utility module. Exports:
- `trackThinkingDeltas(sessionId, event)` 
- `augmentMessageThinkingDurations(event, sessionId)`
- `clearThinkingMaps(sessionId)`

The in-memory maps move here. No external dependencies beyond the maps themselves.

#### 2.2.7 `push-tracker.ts`

Exports:
- `trackPushPendingState(sessionId, event)` — manages Redis push-pending key
- `checkPushNotifications(sessionId, event)` — fires push notifications

Currently ~100 lines in relay.ts. Clean extraction.

### 2.3 Migration Strategy

The decomposition is **purely structural** — no behavioral changes. Every handler and every line of logic is preserved; they just move to dedicated files. This makes it safe to ship independently of the delta architecture.

Test strategy: The existing test suite (if any covers relay behavior) continues to pass. Add integration tests per module.

---

## 3. Protocol Envelope

### 3.1 Current State

Each Socket.IO namespace has bespoke event names and payloads:
- `/relay`: `register`, `event`, `session_end`, `exec_result`, `session_message`, `session_trigger`, `trigger_response`, `cleanup_child_session`, `delink_children`, `delink_own_parent`
- `/viewer`: `connected`, `resync`, `input`, `model_set`, `exec`, `trigger_response`
- `/runner`: `runner_register`, `session_ready`, `kill_session`, `session_ended`
- `/hub`: `session_added`, `session_removed`, `session_status`

No unified envelope. Events are identified by Socket.IO event name, not a type field in the payload.

### 3.2 Assessment: Keep Socket.IO (For Now)

**Recommendation: Do NOT switch transports in this refactor.**

Reasons to keep Socket.IO:
1. **Redis adapter** — Built-in multi-node pub/sub. Replacing it means building a custom pub/sub layer.
2. **Rooms** — Session rooms for targeted broadcast are fundamental to viewer delivery. Socket.IO rooms are battle-tested.
3. **Reconnection** — Socket.IO handles exponential backoff, session resumption, and transport fallback (WebSocket → polling) automatically.
4. **ACK support** — Used by `delink_children`, `cleanup_child_session`, and `trigger_response` for delivery confirmation.

Reasons that would justify switching (future):
- Socket.IO overhead is measurable (~5% frame overhead, pingInterval/pingTimeout traffic)
- Need for SSE (Server-Sent Events) for read-only viewers (mobile battery optimization)
- Need for binary protocol (protobuf/flatbuffers) for extreme throughput

**Verdict:** The transport is not the bottleneck. The 50MB `session_active` payloads are. Fix the payload problem (delta architecture) first; transport optimization is a Phase 4+ concern.

### 3.3 Lightweight Envelope (Optional Enhancement)

If we want to future-proof without changing transport, introduce an envelope convention for the `/relay` event channel:

```typescript
// Current: socket.emit("event", { sessionId, token, event, seq })
// The `event` field is already an envelope of sorts. No change needed.

// For runner service abstraction (future):
interface ServiceEnvelope {
  service: "relay" | "terminal" | "files" | "git";
  type: string;        // e.g. "event", "exec_result"
  sessionId: string;
  payload: unknown;
  seq?: number;
}
```

**Recommendation:** Defer the unified envelope. The current per-namespace event names work fine with Socket.IO's built-in event routing. A unified envelope adds a layer of indirection without clear benefit until we have multiple service types per session (e.g., terminal, file explorer, git) sharing a single connection.

### 3.4 What SHOULD Change in the Protocol

1. **`resync` gets `fromSeq`:** Currently `resync` is `Record<string, never>`. Add `fromSeq?: number` so the server knows what to replay.

2. **Remove `session_messages_chunk`:** This event type is eliminated entirely from the protocol.

3. **`session_active` metadata:**  Add a `snapshotSeq` field so viewers can distinguish "replay from seq X" vs "complete state reset."

```typescript
// Updated resync event
resync: (data: { fromSeq?: number }) => void;

// Updated session_active state envelope
interface SessionActiveState {
  // ... existing fields ...
  snapshotSeq?: number;  // seq at which this snapshot was taken
}
```

---

## 4. Persistence Simplification

### 4.1 Current Three-Layer Problem

| Layer | Storage | Key Pattern | What it stores | TTL |
|-------|---------|-------------|---------------|-----|
| **Redis Hashes** (`sio-state.ts`, 1046L) | Redis Hash per session/runner | `pizzapi:sio:session:{id}` | Session metadata, lastState, lastHeartbeat | 24h |
| **Redis Lists** (`sessions/redis.ts`, 191L) | Redis List per session | `pizzapi:relay:session:{id}:events` | Event cache for replay (last 1000 events) | 24h |
| **SQLite** (`sessions/store.ts`, 543L) | `relay_session` + `relay_session_state` tables | By session ID | Durable session metadata + state for replay after Redis expiry | Ephemeral: 10min, Pinned: forever |

A viewer reconnecting hits up to 3 fallback layers:
1. `lastState` from Redis Hash → try first (fastest)
2. `findLatestSnapshotEvent()` from Redis List → scan backward for SA/agent_end
3. `getPersistedRelaySessionSnapshot()` from SQLite → final fallback

### 4.2 Proposed: Redis Streams Replace Redis Lists

**Replace the Redis List event cache with a Redis Stream.**

Redis Streams are purpose-built for event logs:
- Auto-generated IDs that are monotonically increasing (maps to seq)
- `XRANGE` for range queries (replay from seq X to Y)
- `XLEN` for size checks
- `XTRIM` with `MAXLEN` for bounded retention
- `XREVRANGE` for scanning from newest (find latest snapshot)

```typescript
// Current (Redis List):
// RPUSH, LTRIM, LRANGE — no ordering guarantees, manual seq tracking

// Proposed (Redis Stream):
const STREAM_KEY = `pizzapi:relay:stream:${sessionId}`;

// Append event with seq as a field
await redis.xAdd(STREAM_KEY, "*", {
  seq: String(seq),
  event: JSON.stringify(event),
  type: String(event.type),  // indexed for fast snapshot scanning
});
await redis.xTrim(STREAM_KEY, "MAXLEN", "~", 1000);

// Replay from seq
const entries = await redis.xRange(STREAM_KEY, "-", "+");
const fromIndex = entries.findIndex(e => Number(e.message.seq) > fromSeq);
return entries.slice(fromIndex);

// Find latest snapshot (scan from end)
const recent = await redis.xRevRange(STREAM_KEY, "+", "-", { COUNT: 100 });
const snapshot = recent.find(e => 
  e.message.type === "session_active" || e.message.type === "agent_end"
);
```

### 4.3 Minimum Redis Footprint

After the refactor, Redis stores:

| Key Pattern | Type | Purpose | Can be removed? |
|------------|------|---------|-----------------|
| `pizzapi:sio:session:{id}` | Hash | Live session metadata | No — needed for auth, routing, viewer count |
| `pizzapi:sio:runner:{id}` | Hash | Runner metadata | No — needed for session→runner routing |
| `pizzapi:sio:seq:{id}` | String | Monotonic event counter | No — needed for gap detection |
| `pizzapi:relay:stream:{id}` | Stream | Event log for replay | No — this IS the replay source |
| `pizzapi:sio:children:{id}` | Set | Parent→child membership | No — needed for trigger system |
| `pizzapi:sio:delinked:{id}` | String | Delink markers | No — needed for delink correctness |
| `pizzapi:sio:runner-assoc:{id}` | String | Durable runner link | No — needed for reconnect |
| `pizzapi:push-pending:{id}` | String | Push notification tracking | No — needed for push dedup |

**What CAN be removed from Redis Hash:**
- `lastState` field (currently JSON-stringified full state, up to 50MB). With Redis Streams, the snapshot is always recoverable from the stream. Remove `lastState` from the hash entirely.
- `lastHeartbeat` field stays (small, needed for heartbeat serving on viewer connect).

**Estimated Redis memory savings:** Removing `lastState` from session hashes eliminates the largest field. For a session with 200 messages, `lastState` can be 5-10MB of JSON. With 20 concurrent sessions, that's 100-200MB of Redis RAM saved.

### 4.4 SQLite's Role

SQLite becomes a **cold archive** only:
- Records session start/end for history listing
- Stores the final session state on `session_end` or disconnect (for viewing completed sessions)
- Handles pinned session persistence
- **No longer a fallback for live session replay** — Redis Stream is always the replay source for live sessions

The `relay_session_state` table is still updated on `session_active` and `agent_end`, but only for the purpose of serving completed sessions that have expired from Redis.

### 4.5 Reconnect/Replay Contract

```
Viewer connects to session S:

1. Is S live? (Redis Hash `pizzapi:sio:session:S` exists)
   ├─ YES → Join viewer room, serve snapshot + replay from Redis Stream
   │         a. Find latest SA/agent_end in Stream → send as snapshot
   │         b. Send all events after snapshot's seq
   │         c. Live events flow via room broadcast
   │
   └─ NO → Is S in SQLite?
            ├─ YES → Send persisted state as replay-only snapshot
            │         (viewer receives "replayOnly: true", no live events)
            └─ NO → "Session not found" error
```

---

## 5. Phased Implementation Plan

### Phase 1: Module Decomposition (1 Night Shift)

**Goal:** Extract relay.ts into clean modules. No behavioral changes. No protocol changes. Zero risk to production.

| Dish | Description | Complexity | Files Modified | Files Created |
|------|-------------|-----------|---------------|--------------|
| 1.1 | Extract `thinking-tracker.ts` from relay.ts | S | relay.ts | relay/thinking-tracker.ts |
| 1.2 | Extract `push-tracker.ts` from relay.ts | S | relay.ts | relay/push-tracker.ts |
| 1.3 | Extract `ack-tracker.ts` from relay.ts | XS | relay.ts | relay/ack-tracker.ts |
| 1.4 | Extract `messaging.ts` (session_message, session_trigger, trigger_response) | M | relay.ts | relay/messaging.ts |
| 1.5 | Extract `child-lifecycle.ts` (cleanup_child, delink_children, delink_own_parent) | M | relay.ts | relay/child-lifecycle.ts |
| 1.6 | Extract `session-lifecycle.ts` (register, session_end, disconnect) | M | relay.ts | relay/session-lifecycle.ts |
| 1.7 | Create `relay/index.ts` wiring module, convert relay.ts to re-export | S | relay.ts → relay/index.ts | relay/index.ts |
| 1.8 | Add unit tests for thinking-tracker and push-tracker | S | — | relay/thinking-tracker.test.ts, relay/push-tracker.test.ts |

**Estimated total:** 6-8 hours of focused work  
**Risk:** Very low — purely structural refactoring  
**Verification:** `bun run typecheck && bun run test && bun run build`  
**Backward compat:** 100% — no protocol or behavioral changes

### Phase 2: Delta Event Architecture (1-2 Night Shifts)

**Goal:** Eliminate chunked delivery. Reduce per-turn payloads from 10-50MB to <10KB. Implement seq-based replay.

| Dish | Description | Complexity | Files Modified | Files Created |
|------|-------------|-----------|---------------|--------------|
| 2.1 | Replace Redis List with Redis Stream in `sessions/redis.ts` | M | sessions/redis.ts | — |
| 2.2 | Add `fromSeq` to `resync` protocol type | XS | protocol/src/viewer.ts | — |
| 2.3 | Implement seq-range replay in viewer.ts `resync` handler | M | viewer.ts | — |
| 2.4 | Remove chunked delivery from relay event pipeline | M | relay/event-pipeline.ts | — |
| 2.5 | Remove `session_messages_chunk` from protocol types | S | protocol/src/relay.ts | — |
| 2.6 | Remove `lastState` from Redis session hash, use Stream for snapshot | L | sio-state.ts, sio-registry/sessions.ts | — |
| 2.7 | Update viewer.ts to construct snapshot from Stream instead of `lastState` | M | viewer.ts | — |
| 2.8 | Remove chunked delivery UI code from App.tsx | M | App.tsx | — |
| 2.9 | Update runner extension to stop sending post-turn `session_active` | M | CLI extension code (patch) | — |
| 2.10 | Add backward compat: old runners still send SA → server processes normally | S | relay/event-pipeline.ts | — |
| 2.11 | Integration tests: reconnect, replay, gap detection | L | — | ws/namespaces/relay/replay.test.ts |

**Estimated total:** 12-16 hours across 1-2 shifts  
**Risk:** Medium — changes event flow, but seq-based replay is simpler than chunked delivery  
**Verification:** Full test suite + manual testing with old and new CLI versions  
**Backward compat:** Old runners still work (send full SA, processed as before). New runners are more efficient.

**Dependencies:** Phase 1 should be completed first (cleaner codebase for changes).

### Phase 3: Persistence Cleanup (1 Night Shift)

**Goal:** Consolidate persistence contracts. Remove redundant fallback layers.

| Dish | Description | Complexity | Files Modified |
|------|-------------|-----------|---------------|
| 3.1 | Remove `lastState` Redis Hash field entirely | M | sio-state.ts, sio-registry/sessions.ts |
| 3.2 | Update `sendSnapshotToViewer` to always use Stream | M | sio-registry/sessions.ts |
| 3.3 | Simplify SQLite to only write on session_end (final archive) | S | sessions/store.ts |
| 3.4 | Remove `recordRelaySessionState` calls during live sessions | S | sio-registry/sessions.ts |
| 3.5 | Add Stream→SQLite archive on session end | M | sio-registry/sessions.ts, sessions/store.ts |

**Estimated total:** 6-8 hours  
**Risk:** Low-Medium — simplification, well-tested by Phase 2  
**Dependencies:** Phase 2 must be complete

### Phase 4: UI Decomposition (2+ Night Shifts)

**Goal:** Break App.tsx (4018 lines, 48 useStates) into composable hooks and components.

| Dish | Description | Complexity |
|------|-------------|-----------|
| 4.1 | Extract `useRelayConnection()` hook — socket lifecycle, seq tracking, resync | L |
| 4.2 | Extract `useSessionMessages()` hook — message state, deduplication, normalization | L |
| 4.3 | Extract `useSessionMeta()` hook — metadata, model, thinking durations | M |
| 4.4 | Extract `useInteractivePrompts()` hook — pendingQuestion, pendingPlan, pluginTrust | M |
| 4.5 | Extract `useRunnerPanels()` hook — terminal, file explorer, combined panel | M |
| 4.6 | Extract `SessionShell` component — sidebar + viewer layout orchestration | L |
| 4.7 | Remove all chunked delivery refs and logic from UI | S (done in Phase 2.8) |

**Estimated total:** 16-24 hours across 2+ shifts  
**Risk:** Medium — React state management refactoring, visual regression risk  
**Dependencies:** Phase 2 (chunked removal) makes this significantly easier  
**Verification:** Visual regression testing with Playwright screenshots

---

## 6. Risk Analysis

### 6.1 High-Risk Areas

| Risk | Impact | Mitigation |
|------|--------|-----------|
| **Redis Stream migration breaks replay** | Viewers see blank sessions | Feature flag: keep List as fallback during transition. Dual-write to both List and Stream in Phase 2, switch read path, then remove List in Phase 3. |
| **Old CLI versions break** | Users on old `pizza` CLI can't connect | Server always accepts `session_active` with full state. Old behavior is strictly additive — no removal of server-side handling. |
| **Removing lastState from Redis Hash** | Viewer connect is slower (must scan Stream) | Phase 2 keeps lastState; Phase 3 removes it only after Stream replay is battle-tested. Keep a `lastSnapshotStreamId` pointer in the Hash for O(1) snapshot lookup. |
| **UI decomposition causes visual regressions** | Broken UI for users | Playwright screenshot tests before/after each extraction. Ship one hook at a time. |
| **Multi-node Redis Stream consistency** | Events arrive out of order across nodes | Redis Streams are single-writer (one relay socket per session). The `seq` field is the authoritative ordering. |

### 6.2 Low-Risk Areas

| Area | Why low risk |
|------|-------------|
| Module decomposition (Phase 1) | Pure structural refactoring, no behavioral changes |
| Removing chunked delivery code | Well-understood code with 4 known bugs; replacement (stream replay) is simpler |
| Protocol `resync` change | Additive field (`fromSeq`), backward compatible (server handles missing field) |

### 6.3 What NOT to Change

1. **Socket.IO namespaces** — The `/relay`, `/viewer`, `/runner`, `/hub` separation is correct and maps to distinct auth/access patterns.
2. **Redis for Socket.IO adapter** — Required for multi-node room broadcast.
3. **SQLite for session history** — Correct for durable, queryable archive.
4. **The trigger system** — Complex but correct. Don't touch parent-child lifecycle during this refactor.
5. **Push notification logic** — Extract it, but don't change the logic.

---

## 7. Files Inventory Per Phase

### Phase 1: Module Decomposition

**Created:**
```
packages/server/src/ws/namespaces/relay/
├── index.ts
├── event-pipeline.ts
├── session-lifecycle.ts
├── messaging.ts
├── child-lifecycle.ts
├── thinking-tracker.ts
├── thinking-tracker.test.ts
├── push-tracker.ts
├── push-tracker.test.ts
└── ack-tracker.ts
```

**Modified:**
```
packages/server/src/ws/namespaces/relay.ts  → deleted (replaced by relay/index.ts)
```

**Import updates (mechanical):**
```
packages/server/src/ws/namespaces/viewer.ts  (getPendingChunkedSnapshot import)
Any file importing from "./relay.js"
```

### Phase 2: Delta Architecture

**Modified:**
```
packages/protocol/src/viewer.ts              (resync gets fromSeq)
packages/protocol/src/relay.ts               (remove session_messages_chunk)
packages/server/src/sessions/redis.ts        (List → Stream)
packages/server/src/ws/namespaces/viewer.ts  (seq-range replay)
packages/server/src/ws/namespaces/relay/event-pipeline.ts  (remove chunk handlers)
packages/server/src/ws/sio-registry/sessions.ts  (snapshot from Stream)
packages/ui/src/App.tsx                      (remove chunked delivery)
packages/ui/src/lib/session-seq.ts           (update gap detection for fromSeq resync)
```

**Created:**
```
packages/server/src/sessions/redis-stream.ts  (new Stream-based API)
packages/server/tests/replay.test.ts          (integration tests)
```

### Phase 3: Persistence Cleanup

**Modified:**
```
packages/server/src/ws/sio-state.ts           (remove lastState field)
packages/server/src/ws/sio-registry/sessions.ts  (remove lastState writes)
packages/server/src/sessions/store.ts         (simplify to end-of-session archive)
```

### Phase 4: UI Decomposition

**Created:**
```
packages/ui/src/hooks/useRelayConnection.ts
packages/ui/src/hooks/useSessionMessages.ts
packages/ui/src/hooks/useSessionMeta.ts
packages/ui/src/hooks/useInteractivePrompts.ts
packages/ui/src/hooks/useRunnerPanels.ts
packages/ui/src/components/SessionShell.tsx
```

**Modified:**
```
packages/ui/src/App.tsx  (progressively slimmed to ~500 lines)
```

---

## 8. Success Metrics

| Metric | Current | After Phase 2 | After Phase 4 |
|--------|---------|---------------|---------------|
| Per-turn payload size | 10-50MB | <10KB (deltas only) | <10KB |
| relay.ts line count | 1,183 | 0 (decomposed) | 0 |
| App.tsx line count | 4,018 | ~3,700 (chunk code removed) | ~500 |
| Chunked delivery bugs | 4 P1 | 0 (removed) | 0 |
| Persistence layers for replay | 3 (Hash + List + SQLite) | 2 (Stream + SQLite) | 2 |
| Viewer reconnect latency (200-msg session) | ~3s (full SA transfer) | <200ms (replay 0-20 events) | <200ms |

---

## Appendix A: Glossary

| Term | Definition |
|------|-----------|
| SA | `session_active` — full session state snapshot event |
| seq | Monotonically increasing sequence number per session, incremented per event |
| Redis Stream | Redis data structure for append-only event logs with range queries |
| lastState | JSON-stringified full session state stored in Redis session hash |
| Delta | Any non-snapshot event (message_update, message_end, tool_execution_*, etc.) |
| Chunked delivery | Current system where large SAs are split into numbered chunks (to be removed) |

## Appendix B: Event Type Inventory

Events that flow through the relay pipeline (from runner → server → viewer):

| Event Type | Frequency | Size | Snapshot? | Notes |
|-----------|-----------|------|-----------|-------|
| `session_active` | Per-turn (current), connect-only (proposed) | 1-50MB | Yes | The big one |
| `agent_end` | End of agent turn | 1-50MB | Yes | Carries full messages array |
| `message_update` | Per-token (streaming) | <1KB | No | High frequency |
| `message_end` | Per-message | 1-100KB | No | Final message content |
| `turn_end` | Per-turn | 1-100KB | No | Turn summary |
| `tool_execution_start` | Per-tool call | <1KB | No | |
| `tool_execution_end` | Per-tool call | 1-500KB | No | Tool output |
| `heartbeat` | Every 5s while active | <2KB | No | Liveness + model info |
| `session_messages_chunk` | During chunked delivery | 1-5MB | Partial | **To be removed** |
| `mcp_startup_report` | On MCP init | <5KB | No | Meta event |
| `cli_error` | On agent error | <1KB | No | |

## Appendix C: Key Observations from Code Review

1. **`agent_end` already carries full state.** It has a `messages` array with the complete conversation. This means we already have a snapshot mechanism outside `session_active` — we just need to use it as the replay source.

2. **`publishSessionEvent` already caches to Redis and broadcasts with seq.** The infrastructure for seq-based replay exists. The gap is: the replay handler (`resync`) doesn't use the cache — it goes to `lastState` or asks the runner to re-emit.

3. **`sessionEventQueues` exist only for chunk ordering.** Without chunks, the serialization queue is unnecessary. Events from a single relay socket arrive in order; the only reason to serialize was chunk assembly.

4. **The viewer already has `lastSeqRef` and gap detection** in `session-seq.ts`. The `analyzeIncomingSeq` function already detects gaps and returns `"resync"` as an action. The missing piece is sending `fromSeq` in the resync request.

5. **sio-state.ts is well-structured** despite its size (1046L). Each section (sessions, runners, terminals, child tracking, push tracking) is cleanly separated with clear comments. The main improvement would be splitting it into `sio-state/sessions.ts`, `sio-state/runners.ts`, etc., but this is lower priority than the relay decomposition.

6. **Image stripping (`strip-images.ts`, 254L) is already a clean module.** No extraction needed — it's used by the pipeline but doesn't need to change.
