## 2024-05-23 - Session Viewer Scalability
**Learning:** The session viewer re-processes the entire message history (grouping, deduplication, sorting) on every update (e.g. streaming tokens). This is O(N) or O(N log N) per update, which becomes a bottleneck for long sessions.
**Action:** Future optimizations should focus on incremental updates or memoization of processed history chunks to avoid reprocessing the entire list.

## 2024-05-23 - Session Activity Throttling
**Learning:** High-frequency event streams (like TUI output) trigger `touchSessionActivity` on every chunk. Without throttling, this hammers the SQLite database with redundant `UPDATE relay_session` calls, increasing write IOPs significantly for active sessions.
**Action:** Always implement debounce or throttle mechanisms for database updates driven by real-time event streams, especially when precision (e.g., last active time) is tolerant of small delays (seconds).

## 2024-05-22 - Inefficient getRunners aggregation
**Learning:** `getRunners` in `sio-registry.ts` calls `getAllSessions` inside the loop for each runner, making it O(R * S). Optimized to fetch all sessions once and aggregate counts with a Map, reducing to O(R + S).
**Action:** Optimize `getRunners` to aggregate session counts more efficiently, ideally in a single pass or using a map.
