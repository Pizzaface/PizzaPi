## 2024-03-04 - [Optimize Socket.IO sweeper N+1 queries]
**Learning:** In sweeping or polling loops across distributed sessions, calling `fetchSockets()` (e.g., in `packages/server/src/ws/sio-registry.ts`) triggers an expensive, cluster-wide network operation (N+1 bottleneck) for each session check.
**Action:** Perform cheap local state or staleness checks (like checking last heartbeat or start time locally) before executing expensive cluster-wide network operations. If the local condition fails, the remote query is bypassed, significantly reducing unnecessary network/Redis roundtrips for healthy sessions.

## 2026-03-03 - [Optimize Orphaned Session Sweep]
**Learning:** `sweepOrphanedSessions` runs on an interval and can cause an N+1 problem by making a cluster-wide Socket.IO `fetchSockets()` call for every single active session. Since this function is meant to clean up *orphaned* sessions, active sessions naturally have recent heartbeats. By calculating `lastActivity` and checking against the staleness threshold *first*, we can skip the expensive Socket.IO lookup entirely for the vast majority of active sessions.
**Action:** When implementing polling or sweeping loops, filter items with cheap, local checks (like staleness from Redis data) before making expensive cluster-wide or database calls to avoid N+1 bottlenecks.
