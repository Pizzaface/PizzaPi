## 2024-05-23 - Session Viewer Scalability
**Learning:** The session viewer re-processes the entire message history (grouping, deduplication, sorting) on every update (e.g. streaming tokens). This is O(N) or O(N log N) per update, which becomes a bottleneck for long sessions.
**Action:** Future optimizations should focus on incremental updates or memoization of processed history chunks to avoid reprocessing the entire list.
