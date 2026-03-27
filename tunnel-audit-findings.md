# Tunnel System Audit Findings — Night Shift 003

## Bug 1: Relay HTTP timeout does not abort runner-side request
- **File:** packages/tunnel/src/server.ts:138
- **Type:** bug
- **Priority:** P1
- **Category:** resource-leak
- **Description:** In `proxyHttpRequest`, the timeout path deletes the pending entry and calls `onError("Tunnel request timed out")`, but it does **not** send `request-end` to the runner. The runner-side `TunnelClient` only aborts local HTTP requests when it receives `request-end` (`packages/tunnel/src/client.ts:383-389`). For slow/hung local services, the relay times out and returns an error to the viewer while the local socket/request can continue indefinitely.
- **Impact:** Repeated timed-out tunnel requests can accumulate hanging local requests/sockets on runners, increasing FD/memory usage and creating a practical DoS path.
- **Proposed Fix:** On timeout, send `{ type: "request-end", id }` to the runner before/after deleting pending state (guarded by runner availability). Consider a hard runner-side per-request timeout as a second safety net.

## Bug 2: WebSocket open timeout leaves orphaned local WebSocket connections
- **File:** packages/tunnel/src/server.ts:213
- **Type:** bug
- **Priority:** P1
- **Category:** resource-leak
- **Description:** In `proxyWsOpen`, when the open timer fires, the relay deletes `pendingWs` and reports `"WebSocket open timed out"`, but it does **not** send a `ws-close` for that ID. The runner-side client creates/stores the local WS immediately in `handleWsOpen` (`packages/tunnel/src/client.ts:438`) and only removes it on close/error/control messages. If the relay times out first, that WS can remain open with no owning pending state on the relay.
- **Impact:** Orphaned local WS connections can accumulate under latency/handshake delays and leak resources on the runner.
- **Proposed Fix:** On WS open timeout, send `{ type: "ws-close", id, code: 1001, reason: "open timed out" }` to the runner so `handleWsClose` can tear down local state.

## Bug 3: Tunnel protocol collapses multi-value headers (breaks Set-Cookie semantics)
- **File:** packages/tunnel/src/client.ts:314
- **Type:** bug
- **Priority:** P1
- **Category:** protocol
- **Description:** Response headers are serialized as `Record<string, string>` (`packages/tunnel/src/types.ts:59`). In `TunnelClient`, array-valued headers are flattened with `value.join(", ")`. This is incorrect for headers like `Set-Cookie`, which are not comma-joinable and must be sent as separate header lines.
- **Impact:** Multi-cookie responses can be corrupted, causing login/session failures and subtle auth bugs in tunneled apps.
- **Proposed Fix:** Change protocol header representation to preserve repeated headers (e.g., `Record<string, string | string[]>` or tuple list), and on relay HTTP response reconstruction use `Headers.append` for multi-value headers.

## Bug 4: Malformed URL-encoded session IDs can throw and escape as 500
- **File:** packages/server/src/routes/tunnel.ts:553
- **Type:** bug
- **Priority:** P2
- **Category:** error-handling
- **Description:** `handleTunnelRoute` calls `decodeURIComponent(match[1])` without try/catch. Invalid percent-encoding in the path segment throws `URIError`, which is not converted into a controlled 4xx response.
- **Impact:** A malformed tunnel URL can trigger avoidable 500s and noisy error paths instead of a clean client error.
- **Proposed Fix:** Mirror `tunnel-ws.ts` behavior: wrap decode in try/catch and return `400 Bad Request` on decode failure.

## Bug 5: HTML/JS/CSS rewrite path buffers response body with no size limit
- **File:** packages/server/src/routes/tunnel.ts:465
- **Type:** bug
- **Priority:** P1
- **Category:** memory
- **Description:** When content type is rewritable (`text/html`, JS, CSS), chunks are pushed into `bodyChunks` until upstream end. There is no max buffer cap or early bailout.
- **Impact:** Large or unbounded responses can cause unbounded memory growth in the relay process, risking process OOM and cross-session impact.
- **Proposed Fix:** Add a strict max buffered size (configurable, sane default). If exceeded, either (a) abort and return 413/502, or (b) disable rewriting and stream through unchanged.

## Bug 6: Runner re-registration bypasses disconnect cleanup for in-flight requests
- **File:** packages/tunnel/src/server.ts:339
- **Type:** bug
- **Priority:** P2
- **Category:** state-management
- **Description:** On duplicate runner registration, the relay removes `wsToRunner` mapping for the old socket **before** closing it. `handleDisconnect` relies on `wsToRunner` to identify runner ownership (`packages/tunnel/src/server.ts:410-417`), so old-socket close events no longer clean up pending requests/WS entries immediately.
- **Impact:** In-flight requests/WS proxies tied to the old socket can survive until timeout, producing stale state and delayed failures during reconnect races.
- **Proposed Fix:** During re-registration, explicitly fail and clear all pending entries for that `runnerId` before replacing the socket (or keep mapping until close handler runs and cleanup completes).
