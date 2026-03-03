
## 2026-03-03 - [Optimize Orphaned Session Sweep]
**Learning:** `sweepOrphanedSessions` runs on an interval and can cause an N+1 problem by making a cluster-wide Socket.IO `fetchSockets()` call for every single active session. Since this function is meant to clean up *orphaned* sessions, active sessions naturally have recent heartbeats. By calculating `lastActivity` and checking against the staleness threshold *first*, we can skip the expensive Socket.IO lookup entirely for the vast majority of active sessions.
**Action:** When implementing polling or sweeping loops, filter items with cheap, local checks (like staleness from Redis data) before making expensive cluster-wide or database calls to avoid N+1 bottlenecks.
