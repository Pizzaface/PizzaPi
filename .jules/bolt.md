
## 2025-03-19 - Use native disconnectSockets over socketsLeave loops
**Learning:** Using `socketsLeave` followed by a custom loop to cleanup sockets or relying on `fetchSockets` triggers expensive operations across the Redis cluster adapter. Socket.IO's native `.disconnectSockets(true)` achieves forceful disconnection of all clients in a room without the N+1 network overhead.
**Action:** Always prefer native bulk operations provided by Socket.IO (like `.disconnectSockets(true)`) instead of iterating over `fetchSockets` or only removing them from rooms via `socketsLeave` when teardown is needed, specifically to prevent N+1 adapter query bottlenecks in a cluster.
