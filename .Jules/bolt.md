## 2024-03-04 - [Optimize Socket.IO sweeper N+1 queries]
**Learning:** In sweeping or polling loops across distributed sessions, calling `fetchSockets()` (e.g., in `packages/server/src/ws/sio-registry.ts`) triggers an expensive, cluster-wide network operation (N+1 bottleneck) for each session check.
**Action:** Perform cheap local state or staleness checks (like checking last heartbeat or start time locally) before executing expensive cluster-wide network operations. If the local condition fails, the remote query is bypassed, significantly reducing unnecessary network/Redis roundtrips for healthy sessions.

## 2026-03-03 - [Optimize Orphaned Session Sweep]
**Learning:** `sweepOrphanedSessions` runs on an interval and can cause an N+1 problem by making a cluster-wide Socket.IO `fetchSockets()` call for every single active session. Since this function is meant to clean up *orphaned* sessions, active sessions naturally have recent heartbeats. By calculating `lastActivity` and checking against the staleness threshold *first*, we can skip the expensive Socket.IO lookup entirely for the vast majority of active sessions.
**Action:** When implementing polling or sweeping loops, filter items with cheap, local checks (like staleness from Redis data) before making expensive cluster-wide or database calls to avoid N+1 bottlenecks.

## 2025-03-05 - [Optimize Socket.IO bulk leave operations]
**Learning:** In Socket.IO, when disconnecting or removing multiple clients from a room across a Redis cluster, using `await io.in(room).fetchSockets()` followed by an iterative `.leave()` loop causes a severe N+1 problem by pulling all remote socket instances into memory unnecessarily.
**Action:** Use native broadcast methods like `io.in(room).socketsLeave(room)` or `io.in(room).disconnectSockets(true)` to push the operation directly to the Redis adapter without pulling objects into the application layer.

## 2025-03-09 - Socket.IO Cluster Network Bottlenecks
**Learning:** `fetchSockets()` is highly inefficient when only checking for socket presence in a clustered (Redis) environment, as it pulls full `RemoteSocket` objects across the network. `.allSockets()` is deprecated in Socket.IO v4.
**Action:** Use `adapter.sockets(new Set([roomName]))` directly to efficiently return a `Set` of socket IDs without cross-cluster serialization overhead.

## 2025-03-09 - [Optimize high-frequency event stream bottlenecks]
**Learning:** In high-frequency real-time event streams (like Socket.IO text deltas in `packages/server/src/ws/namespaces/relay.ts`), failing to early-return before executing asynchronous operations (like Redis `getSharedSession` or `getViewerCount`) causes severe systemic N+1 bottlenecks.
**Action:** Strictly evaluate simple synchronous conditions (like `event.type`) to short-circuit the function before invoking any expensive I/O operations.
