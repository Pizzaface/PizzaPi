# PizzaPi WebSocket Event Pipeline — Data Duplication Analysis

## Executive Summary

The event pipeline exhibits **5-7 independent copies** of the same session data across Redis, SQLite, and memory. Images are extracted and stored twice. Events are cached in two formats. Viewer reconnects trigger full state reconstruction instead of cache replay. This analysis identifies all redundancy points with specific file:line references.

---

## 1. Full Message History Storage (3 Independent Copies)

### Copy #1: Redis Session Hash — `lastState` field
**Location:** `packages/server/src/ws/sio-registry/sessions.ts:updateSessionState()`

```typescript
// Line 235-269
const fields: Partial<RedisSessionData> = {
    lastState: JSON.stringify(strippedState ?? null),
    sessionName: nextSessionName,
};
await updateSessionFields(session.sessionId, fields);
```

**What's stored:** Full session state object with complete messages array
**Storage path:** Redis HSET `pizzapi:session:{sessionId}` field `lastState`
**When written:**
  - During `session_active` event (chunked or unchunked)
  - During `session_metadata_update` event does NOT write lastState (intentional optimization)
  - Called from event-pipeline.ts:176, 199

### Copy #2: SQLite `relay_session_state` table
**Location:** `packages/server/src/sessions/store.ts:recordRelaySessionState()`

```typescript
// Line 161-173
const serialized = JSON.stringify(state ?? null);
await getKysely()
    .insertInto("relay_session_state")
    .values({ sessionId, state: serialized, updatedAt: nowIso })
    .onConflict((oc) => oc.column("sessionId").doUpdateSet({ state: serialized, updatedAt: nowIso }))
    .execute();
```

**What's stored:** Identical full session state (after image extraction)
**Storage path:** SQLite table `relay_session_state(sessionId, state, updatedAt)`
**When written:**
  - Fire-and-forget from `updateSessionState()` at line 267 of sessions.ts
  - NOT awaited, so can race with Redis write
  - Separate ownership validation in recordRelaySessionState (line 150-156)

**Duplication #1a:** Both Redis and SQLite store the SAME JSON-serialized state. If state is 5 MB, it's now stored in two places.

### Copy #3: Redis Event Cache (as `session_active` event)
**Location:** `packages/server/src/sessions/redis.ts:appendRelayEventToCache()`

**In event-pipeline.ts:**
```typescript
// Line 199 (when chunked assembly completes)
const snapshotEvent = { type: "session_active" as const, state: fullState };
let eventToCache: unknown = snapshotEvent;
await appendRelayEventToCache(sessionId, eventToCache, { isEphemeral: session?.isEphemeral });
```

**What's stored:** Full `session_active` event with complete state
**Storage path:** Redis list `pizzapi:relay:session:{sessionId}:events` (RPUSH)
**When written:**
  - When chunked session assembly completes (line 199)
  - When publishing non-chunked session_active (via `publishSessionEvent` at line 221)
  - On every non-chunked, non-metadata-only event (line 219-227)

**Duplication #1b:** The full state is now in THREE places:
  1. Redis session hash (`lastState`)
  2. SQLite `relay_session_state`
  3. Redis event list (as the most recent `session_active` event)

---

## 2. Image Extraction & Redundant Processing

### Duplication #2a: Image Extraction Happens Twice

**First extraction:** `packages/server/src/ws/sio-registry/sessions.ts:updateSessionState()`
```typescript
// Line 238-245
let strippedState: unknown;
try {
    strippedState = await storeAndReplaceImages(state, sessionId, userId);
} catch (err) {
    log.error("Image extraction failed, using original state:", err);
    strippedState = state;
}
```

**Second extraction:** `packages/server/src/ws/sio-registry/sessions.ts:publishSessionEvent()`
```typescript
// Line 310-317
let strippedEvent: unknown;
try {
    strippedEvent = await storeAndReplaceImagesInEvent(event, sessionId, userId);
} catch (err) {
    log.error("Image extraction from event failed, using original event:", err);
    strippedEvent = event;
}
```

**Both functions:**
- Walk the messages array
- Estimate base64 image sizes (buffer.byteLength on each image)
- Generate deterministic attachment IDs via SHA256 hash
- Store images to disk (Promise.all concurrently)
- Replace inline data with URL references

**The problem:**
For a `session_active` event (which triggers `publishSessionEvent`):
1. `updateSessionState()` extracts and stores images → state updated in Redis + SQLite
2. `publishSessionEvent()` extracts and stores images AGAIN from the original event

If the same session_active contains 10 x 2MB images:
- Image extraction #1: 10 disk I/Os, SHA256 on 10 images
- Image extraction #2: 10 disk I/Os, SHA256 on 10 images again
- Total: 20 disk I/Os for the same data

**File locations:**
- `packages/server/src/ws/strip-images.ts:extractImages()` (line 99-137) — pure logic
- `packages/server/src/ws/strip-images.ts:storeAndReplaceImages()` (line 148-180) — async with I/O
- `packages/server/src/ws/strip-images.ts:storeAndReplaceImagesInEvent()` (line 186-208) — async with I/O
- Called from event-pipeline.ts:167-168 (updateSessionState) and line 310-316 (publishSessionEvent)

### Duplication #2b: Image Storage ID Collision Risk

Both extraction calls use the same ID generation (`contentHash()` in strip-images.ts:line 66):
```typescript
function contentHash(data: string, userId: string): string {
    const normalized = stripDataUriPrefix(data);
    return createHash("sha256").update(userId).update(":").update(normalized).digest("hex").slice(0, 24);
}
```

If extraction #1 stores attachment ABC123, and extraction #2 also generates ID ABC123, the second call to `storeExtractedImage()` will either:
- Return immediately if the file exists (idempotent, good)
- OR overwrite if the attachment record already exists (depends on store.ts logic)

This is actually safe because the hash is deterministic and the I/O is idempotent, but it's wasteful to hash and check twice.

---

## 3. Chunked Delivery Assembly Duplication

### Duplication #3: Full State Stored 3 Times on Chunk Assembly Complete

**Location:** `packages/server/src/ws/namespaces/relay/event-pipeline.ts:170-210`

When the final chunk arrives:
```typescript
// Line 190-210
if (canFinalizeChunkedSnapshot(pending)) {
    const allMessages = pending.chunks.flat();
    const fullState = { ...pending.metadata, messages: allMessages };
    pendingChunkedStates.delete(sessionId);
    
    await updateSessionState(sessionId, fullState);  // Write #1: Redis + SQLite
    
    // ... image stripping happens inside updateSessionState ...
    
    const snapshotEvent = { type: "session_active" as const, state: fullState };
    // ... more image stripping happens here ...
    await appendRelayEventToCache(sessionId, eventToCache, {...});  // Write #2: Redis event list
}
```

**Three writes of the same full state:**
1. **Redis session hash** (`lastState` field in the hash via `updateSessionState()`)
2. **SQLite** (`relay_session_state` via `recordRelaySessionState()` called from `updateSessionState()`)
3. **Redis event list** (as `session_active` event via `appendRelayEventToCache()`)

**Memory footprint during assembly:**
- `pending.chunks`: Array of message slices (in `pendingChunkedStates` map)
- `allMessages`: Flattened array after assembly
- `fullState`: Combined with metadata
- `snapshotEvent`: Wrapper object
- `eventToCache`: Image-stripped version
- All exist in memory simultaneously during finalization

---

## 4. Broadcast vs Cache Redundancy

### Duplication #4: Events Broadcast AND Cached in Different Paths

**Location:** `packages/server/src/ws/sio-registry/sessions.ts:publishSessionEvent()`

```typescript
// Line 301-306
const seq = await incrementSeq(sessionId);
await appendRelayEventToCache(sessionId, strippedEvent, { isEphemeral: session?.isEphemeral });

// Line 309-327 (broadcast to viewers)
io.of("/viewer")
    .to(viewerSessionRoom(sessionId))
    .emit("event", { event: strippedEvent, seq });
```

**The pattern:**
1. Event is **cached in Redis** event list (line 306)
2. Event is **broadcast to Socket.IO room** (line 309-327)

For viewers currently connected: they get the event via Socket.IO broadcast
For viewers reconnecting later: they get the event via Redis cache replay (if they request it)

**The redundancy:**
- The same event lives in:
  - Redis event list (persisted, TTL = 24 hours for non-ephemeral)
  - Socket.IO in-memory buffers (per connected viewer, auto-discarded on disconnect)
  - Viewer's browser memory (the UI keeps messages in state)

### Duplication #4a: NOT All Events Cached

**Session metadata updates** intentionally skip caching (event-pipeline.ts:line 199-206):
```typescript
// session_metadata_update is a lightweight heartbeat-only event:
// broadcast to currently-connected viewers but do NOT cache in Redis.
if (event.type === "session_messages_chunk" || isChunkedSessionActive || isMetadataOnlyUpdate) {
    await broadcastSessionEventToViewers(sessionId, eventToPublish);
} else {
    await publishSessionEvent(sessionId, eventToPublish);
}
```

**Consequence:** If a viewer disconnects and reconnects:
- They get `lastState` snapshot (which has the metadata from last full `session_active`)
- But any **metadata changes that happened via `session_metadata_update`** are LOST from the replay
- The metadata is stored in Redis `metaState` (sio-registry/meta.ts), but the event cache doesn't have the history

---

## 5. Viewer Reconnection — No Cache Replay

### Duplication #5: Snapshot Reconstruction Instead of Event Replay

**Location:** `packages/server/src/ws/sio-registry/sessions.ts:sendSnapshotToViewer()`

```typescript
// Line 285-296
export async function sendSnapshotToViewer(sessionId: string, socket: Socket): Promise<void> {
    const session = await getSession(sessionId);
    if (!session) return;

    const seq = session.seq;
    if (session.lastHeartbeat) {
        const heartbeat = safeJsonParse(session.lastHeartbeat);
        socket.emit("event", { event: heartbeat, seq });
    }
    if (session.lastState) {
        const state = safeJsonParse(session.lastState);
        socket.emit("event", { event: { type: "session_active", state }, seq });
    }
}
```

**What's sent on viewer join/reconnect:**
1. Last heartbeat event
2. Last `session_active` snapshot (from `lastState`)

**Alternative approach NOT used:**
The Redis event cache (`pizzapi:relay:session:{sessionId}:events`) contains ALL events in order. A better approach would be:
1. Fetch the cached event list (getCachedRelayEvents in redis.ts)
2. Replay all events to the viewer

**Why current approach is wasteful:**
- Maintains separate paths: snapshot path vs event cache path
- Snapshot must always be kept in sync with event cache tail
- Event cache is never used for viewer reconnection
- If event cache has 1000 events, viewer still only gets the final snapshot (wasting the cache)

**When snapshot would be stale:**
Example:
1. Session is saved with 5 messages → `lastState` updated
2. 100 more events arrive (model changes, metadata updates, etc.)
3. All 100 events are cached in Redis event list
4. Viewer disconnects and reconnects
5. Viewer is sent the 5-message snapshot, not the 100 new events
6. Viewer makes a resync request (triggering findLatestSnapshotEvent)

**File:** `packages/server/src/sessions/redis.ts:getLatestCachedSnapshotEvent()` (line 113-145)
This function exists to find the latest snapshot in the cache, but `sendSnapshotToViewer()` doesn't use it.

---

## 6. Session State Ownership Tracking — Replicated Validation

### Duplication #6: User Ownership Check in Redis AND SQLite

**Location #1 — Redis check:** `packages/server/src/ws/sio-registry/sessions.ts:registerTuiSession()`
```typescript
// Line 35-45 (Redis)
let existing = await getSession(sessionId);
if (existing) {
    if (existing.userId && existing.userId !== userId) {
        log.warn(`registerTuiSession rejected: session ${sessionId} belongs to different user`);
        sessionId = randomUUID();
    }
}
```

**Location #2 — SQLite check:** `packages/server/src/sessions/store.ts:recordRelaySessionStart()`
```typescript
// Line 118-129 (SQLite)
if (incomingUserId !== null) {
    const existingRow = await getKysely()
        .selectFrom("relay_session")
        .select("userId")
        .where("id", "=", input.sessionId)
        .executeTakeFirst();

    if (existingRow && existingRow.userId !== null && existingRow.userId !== incomingUserId) {
        log.warn(`recordRelaySessionStart: session ${input.sessionId} belongs to a different user`);
        return;
    }
}
```

**Location #3 — SQLite check:** `packages/server/src/sessions/store.ts:recordRelaySessionState()`
```typescript
// Line 150-156 (SQLite)
const ownerRow = await getKysely()
    .selectFrom("relay_session")
    .select("userId")
    .where("id", "=", sessionId)
    .executeTakeFirst();

if (ownerRow && ownerRow.userId !== null && ownerRow.userId !== userId) {
    log.warn(`recordRelaySessionState: userId mismatch`);
    return;
}
```

**The redundancy:**
- Redis check happens first (fast)
- SQLite check happens separately (slow DB query)
- Both are checking the same ownership constraint
- The checks can race (Redis guard passes, then SQLite data changes, then SQLite guard fails)

---

## 7. Metadata State Duplication

### Duplication #7: Metadata Stored in Multiple Hash Fields

**Location:** `packages/server/src/ws/sio-registry/sessions.ts`

Session metadata is stored in:
1. **Redis session hash** (`lastHeartbeat` field) — full heartbeat payload
   ```typescript
   // Line 380-381
   const fields: Partial<RedisSessionData> = {
       lastHeartbeat: JSON.stringify(heartbeat),
   };
   ```

2. **Redis metaState** (separate hash) — extracted model/thinking/sessionName
   ```typescript
   // event-pipeline.ts:167-178
   await updateSessionMetaState(sessionId, patch);
   ```

3. **SQLite relay_session** — sessionName only
   ```typescript
   // store.ts:recordRelaySessionStart
   sessionName: input.sessionName ?? null,
   ```

**Metadata fields and where they live:**
| Field | Redis Hash | metaState | SQLite |
|-------|-----------|-----------|--------|
| lastHeartbeat | ✅ (JSON string) | ❌ | ❌ |
| model | ❌ | ✅ | ❌ |
| thinkingLevel | ❌ | ✅ | ❌ |
| sessionName | ✅ (from lastHeartbeat parse) | ✅ | ✅ |
| todoList | ❌ | ✅ | ❌ |

**The inconsistency:**
- Session name is stored in 3 places
- Other metadata is scattered
- On reconnect, the viewer gets metadata from:
  - `lastHeartbeat` (from Redis session hash) → models the old state
  - `lastState` (from Redis session hash) → has sessionName/model/etc from when state was saved
  - These can diverge if metadata changed but state didn't

---

## 8. Sequence Counter — Unnecessary Indirection

### Duplication #8: Seq Stored per Event, Re-queried for Every Broadcast

**Location:** `packages/server/src/ws/sio-registry/sessions.ts:publishSessionEvent()`

```typescript
// Line 301-302
const seq = await incrementSeq(sessionId);
// ...
// Line 309
io.of("/viewer").to(viewerSessionRoom(sessionId)).emit("event", { event: strippedEvent, seq });
```

**Storage:** Redis counter `pizzapi:seq:{sessionId}` (incremented via INCR)

**Usage pattern:**
1. Increment seq in Redis (INCR, round-trip)
2. Broadcast with seq to viewers
3. Viewer checks seq for gaps
4. If gap detected, viewer requests full state (resync)

**The duplication:**
- Every event published increments the counter
- The seq value is sent with every broadcast
- But seq is ALSO embedded in the Redis hash as a field (line 263 of sessions.ts)
- And potentially in the event itself (depending on event structure)

**Inefficiency:**
For a 1000-message session:
- 1000 Redis INCR operations
- 1000 seq values broadcast to viewers
- Viewers assemble seq sequence to detect gaps
- But the seq is a simple counter; if we know events 1-500 and 510-1000, we know events 501-509 are missing

---

## 9. Chunked Delivery — Partial State Visible

### Duplication #9: Metadata-Only Session_Active Visible Before Assembly

**Location:** `packages/server/src/ws/namespaces/relay/event-pipeline.ts:142-150`

When chunked delivery starts:
```typescript
// Line 142-150
if (state?.chunked) {
    // Chunked session: store metadata and start accumulating chunks.
    // Don't persist incomplete state to lastState
    const snapshotId = typeof state.snapshotId === "string" ? state.snapshotId : "";
    const { messages: _msgs, chunked: _c, snapshotId: _sid, totalMessages: _tm, ...metadata } = state;
    pendingChunkedStates.set(sessionId, {
        snapshotId,
        metadata,
        chunks: [],
        totalChunks: 0,
        receivedChunkIndexes: new Set<number>(),
        finalChunkSeen: false,
    });
    await touchSessionActivity(sessionId);
}
```

**What viewers see immediately:**
The metadata-only `session_active` is broadcast (line 212) with `messages: []` placeholder:
```typescript
// Line 212-214
const isChunkedSessionActive = event.type === "session_active" && !!(event.state as Record<string, unknown> | undefined)?.chunked;
if (event.type === "session_messages_chunk" || isChunkedSessionActive || isMetadataOnlyUpdate) {
    await broadcastSessionEventToViewers(sessionId, eventToPublish);
}
```

**Duplicate state during assembly:**
1. **In memory** (pendingChunkedStates): Accumulated chunks + metadata
2. **Broadcast to viewers**: Empty messages array + metadata (not cached)
3. **Final state**: Full state written to Redis + SQLite + event cache

**Risk:** If viewer connects mid-stream:
- Viewer sees metadata-only snapshot (empty messages)
- Viewer starts receiving chunks
- Viewer reassembles locally
- But if stream is interrupted, viewer has incomplete state until reconnect

---

## 10. Sequence Counter Race — Seq May Lag

### Duplication #10: Seq Incremented Before Events Cached

**Location:** `packages/server/src/ws/sio-registry/sessions.ts:publishSessionEvent()`

```typescript
// Line 301-302 (increment)
const seq = await incrementSeq(sessionId);

// Line 306 (cache the event)
await appendRelayEventToCache(sessionId, strippedEvent, { isEphemeral: session?.isEphemeral });

// Line 309-327 (broadcast with the seq)
io.of("/viewer")
    .to(viewerSessionRoom(sessionId))
    .emit("event", { event: strippedEvent, seq });
```

**Race condition:**
1. Seq incremented to 100
2. Event cached in Redis
3. Broadcast sent to viewers with seq=100
4. Viewer receives event with seq=100
5. **BUT** if Redis cache write fails between step 2 and 3, the event is not in the cache
6. Viewer's resync request won't find event #100 in the cache
7. Viewer gets the snapshot instead (wrong seq)

**File:** `packages/server/src/sessions/redis.ts:appendRelayEventToCache()` (line 63-74)

The cache write is awaited (line 306), so it should complete before broadcast. But the error handling is try/catch, not error-throwing, so a silent failure could occur.

---

## Summary Table: All Duplication Points

| # | Data | Location 1 | Location 2 | Location 3 | Reason |
|---|------|-----------|-----------|-----------|--------|
| 1a | Full state JSON | Redis `lastState` | SQLite `relay_session_state` | — | Persistent storage fallback |
| 1b | Full state JSON | Redis session hash | Redis event list | SQLite | Multiple storage layers |
| 2a | Images extracted | updateSessionState | publishSessionEvent | — | Two separate pipeline paths |
| 2b | Image IDs generated | Extract #1 | Extract #2 | — | Same hash computed twice |
| 3 | Full state after chunks | Redis hash | SQLite table | Redis event list | Assembly duplication |
| 4 | Events | Redis event cache | Socket.IO broadcast buffer | — | Cache vs live |
| 4a | Metadata updates | Broadcast only | Redis metaState | — | Not cached, but state stored elsewhere |
| 5 | Last state snapshot | Redis hash fetch | Event cache query | — | Two ways to get state |
| 6 | User ownership | Redis validation | SQLite validation | — | Check twice |
| 7 | Metadata | lastHeartbeat field | metaState hash | SQLite field | Scattered storage |
| 8 | Seq counter | Redis key | Event payload | — | Redundant tracking |
| 9 | Metadata during chunked | Memory (pending) | Broadcast to viewers | Final state write | Partial visibility |
| 10 | Seq+Event ordering | Increment first | Cache second | Broadcast third | Race potential |

---

## Recommendations for Optimization

1. **Eliminate Redis + SQLite duplication** (Duplication #1a, #1b):
   - Use Redis as source of truth for active sessions
   - Cache only to SQLite on TTL expiry or explicit save
   - OR: Write to SQLite first, async populate Redis

2. **Consolidate image extraction** (Duplication #2a):
   - Extract images once in `publishSessionEvent`
   - Pass stripped event to both `updateSessionState` and `appendRelayEventToCache`
   - Avoid second extraction call

3. **Use event cache for viewer reconnect** (Duplication #5):
   - Replace `sendSnapshotToViewer` with event replay from `getCachedRelayEvents`
   - Reduces snapshot staleness, uses existing cache infrastructure

4. **Consolidate metadata storage** (Duplication #7):
   - Store metadata in a single Redis hash or as part of lastState
   - Update metaState, lastHeartbeat, and SQLite in a transaction

5. **Defer seq counter** (Duplication #8):
   - Only increment seq on broadcast, not on every event
   - Embed seq in event itself rather than round-tripping Redis

6. **Cache metadata updates** (Duplication #4a):
   - Include lightweight metadata snapshots in event cache
   - OR: Store separately as `metaState` snapshots for replay

---

## Largest Impact Areas

**Highest Impact:**
- **Duplication #2a (Image extraction)**: Every session_active with images extracts twice. For a 10MB image, this is 2 SHA256 computations + 2 disk writes. Affects every session with inline images.
- **Duplication #1a (Redis + SQLite)**: Doubling persistent storage writes. Every state update becomes 2 JSON serializations + 2 I/O operations.

**Medium Impact:**
- **Duplication #5 (Event cache not used)**: Snapshot can become stale if many events occur between state updates. Limits ability to replay incremental state changes.
- **Duplication #3 (Chunked assembly)**: Large sessions (> 5MB) assemble once, then write to 3 storage layers simultaneously.

**Lower Impact (but good hygiene):**
- **Duplication #6, #7, #8, #10**: Validation, metadata, counter logistics — reduce code complexity but don't affect performance dramatically.

