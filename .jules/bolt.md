
## 2025-03-19 - Use native disconnectSockets over socketsLeave loops
**Learning:** Using `socketsLeave` followed by a custom loop to cleanup sockets or relying on `fetchSockets` triggers expensive operations across the Redis cluster adapter. Socket.IO's native `.disconnectSockets()` achieves forceful disconnection of all clients in a room without the N+1 network overhead. When multiplexing namespaces, passing `true` to `.disconnectSockets()` tears down the entire Engine.IO connection, dropping unrelated namespace sockets (like `/hub` and `/terminal`).
**Action:** When tearing down sessions, use `.disconnectSockets()` (without `true`) instead of `socketsLeave()` to properly tear down sockets while avoiding closing the underlying multiplexed Engine.IO connection that other namespaces rely on.

## 2025-04-18 - Use adapter.sockets() for presence/count checks
**Learning:** Using `allSockets()` or `fetchSockets()` pulls full `RemoteSocket` objects across the cluster via the Redis adapter. When only the presence of sockets or the count is needed, directly querying the adapter via `adapter.sockets(new Set([roomName]))` avoids this expensive network overhead.
**Action:** Use `await io.of("namespace").adapter.sockets(new Set([roomName]))` to check for room presence or socket count instead of `fetchSockets()`.
## 2024-05-20 - Fast Socket.IO presence checks
**Learning:** In Socket.IO, using `fetchSockets()` to verify if clients are in a room incurs expensive network overhead because it pulls full `RemoteSocket` objects across the Redis cluster.
**Action:** Query the adapter directly using `await io.of('...').adapter.sockets(new Set([room]))` to return a `Set` of socket IDs quickly.
