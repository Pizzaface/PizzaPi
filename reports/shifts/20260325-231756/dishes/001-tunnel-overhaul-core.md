# Dish 001: Tunnel Overhaul — MIME/WS Merge + Cache + Accept-Encoding + httpProxy Refactor

- **Cook Type:** sonnet
- **Complexity:** L
- **Band:** B (clarityScore=85, riskScore=50, confidenceScore=55)
- **Godmother ID:** Ulj4kdTT, 673xYgWN
- **Pairing:** tunnel-overhaul (role: related — cooks simultaneously with Dish 002)
- **Paired:** true
- **Pairing Partners:** 002-stale-tunnel-state
- **Dependencies:** none
- **dispatchPriority:** normal
- **Files:**
  - `packages/cli/src/runner/services/tunnel-service.ts` (primary — refactor + cache + encoding)
  - `packages/cli/src/runner/services/tunnel-service.test.ts` (new — unit tests)
  - `packages/server/src/routes/tunnel.ts` (verify — no changes expected)
  - `packages/server/src/routes/tunnel.test.ts` (verify existing tests still pass)
- **Verification:** `bun run typecheck && bun test packages/cli` + sandbox smoke test
- **Status:** ramsey-cleared
- **Session:** 42111939-07bc-4065-9990-3e962a7f84a4
- **Ramsey Send-Back Count:** 1

## Ramsey Report — 2026-03-26 03:46 UTC
- **Verdict:** send-back
- **Demerits found:** 10 (P0: 0, P1: 1, P2: 5, P3: 4)
- **Automated gates:** typecheck: fail (worktree deps — pre-existing), tests: 8/8 pass (dish-specific)

### P1 (send-back trigger)
- WS proxy `forwardHeaders` built but never passed to WebSocket constructor (browser-compat form doesn't accept headers). Inherited from fix/tunnel-module-mime-rewriting branch.

### P2s (log and pass)
- Full body buffered before 10MB size guard
- WS proxy code has zero tests + out of spec scope
- Unexposing port doesn't close active WS connections
- content-length not stripped when content-encoding stripped
- Missing security tests (SSRF guard, redirect, size limit)

### P3s
- Unused `id` binding in dispose loop, missing isShuttingDown guard on ws_close, O(n) sweep on cacheSet, missing TTL/LRU promotion tests

## Task Description

### Objective
Build on `fix/tunnel-module-mime-rewriting` (3 commits: WS upgrade support, absolute import path rewriting, Vite inline import rewriting). Add three improvements to tunnel-service.ts on top of that branch, then open a combined PR.

### Branch Setup
```bash
git checkout fix/tunnel-module-mime-rewriting
git checkout -b nightshift/dish-001-tunnel-overhaul-core
```

### Sub-task 1: Accept-Encoding Passthrough

**Problem:** Bun's `fetch` sends `Accept-Encoding: gzip, deflate, br` by default. When the local service compresses its response, Bun decompresses via `arrayBuffer()` but retains the `Content-Encoding: gzip` header in the response. The relay then sends decompressed bytes with a `Content-Encoding: gzip` header, causing the browser to attempt double-decompression → garbled output.

**Fix:** Force `Accept-Encoding: identity` in the forwarded request headers so local services send uncompressed bodies. Also strip `content-encoding` from response headers (since we sent identity, any returned encoding header is stale/wrong after Bun's transparent decompression).

Add in `httpProxy()` after the hop-by-hop filter loop:
```typescript
// Force uncompressed — Bun decompresses transparently but retains Content-Encoding
forwardHeaders["accept-encoding"] = "identity";
```

Strip from response headers:
```typescript
fetchResponse.headers.forEach((v, k) => {
  const lk = k.toLowerCase();
  if (!HOP_BY_HOP.has(lk) && lk !== "content-encoding") {
    responseHeaders[k] = v;
  }
});
```

### Sub-task 2: Server-Side Response Cache

**Design:**
```typescript
interface CacheEntry {
  status: number;
  headers: Record<string, string>;
  body: string;       // base64-encoded
  expiresAt: number;
}

const CACHE_TTL_MS   = 60_000;
const CACHE_MAX_SIZE = 100;
```

Add to TunnelService class:
- `private responseCache = new Map<string, CacheEntry>()`
- `private cacheGet(key: string): CacheEntry | undefined` — checks expiry, promotes to MRU (Map insertion order)
- `private cacheSet(key: string, data): void` — sweeps expired, evicts LRU, sets entry
- `private cacheInvalidatePort(port: number): void` — removes all keys starting with `${port}:`

Cache rules:
- Only `GET` requests (canCache = method === "GET")
- Only status 200 responses
- Skip if `cache-control` contains `no-store` or `no-cache`
- Cache key: `` `${port}:${method}:${path}` ``
- Invalidate on `handleUnexpose()`
- Clear all on `dispose()`

### Sub-task 3: httpProxy() Engine Refactor

Extract all HTTP proxy logic from `handleHttpRequest` into a module-level standalone async function:

```typescript
interface ProxyResult {
  status: number;
  headers: Record<string, string>;
  body: string;       // base64-encoded
  error?: string;
}

async function httpProxy(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string>,
  bodyBase64: string | undefined,
): Promise<ProxyResult>
```

The function handles:
- SSRF guard (127.0.0.1 only)
- Hop-by-hop + auth header stripping
- Accept-Encoding: identity injection
- Body size enforcement (MAX_RESPONSE_BYTES = 10MB)
- Redirect blocking (`redirect: "manual"`)
- 10s timeout (`AbortSignal.timeout(10_000)`)
- Response header building (stripping hop-by-hop + content-encoding)

`handleHttpRequest` becomes a thin orchestrator that calls `httpProxy()` + cache logic.

### Unit Tests (new file: tunnel-service.test.ts)
Tests must cover:
1. `httpProxy()` sets Accept-Encoding: identity
2. `httpProxy()` strips auth headers
3. `httpProxy()` rejects SSRF paths (@ symbol, redirect to non-127.0.0.1)
4. Cache: returns cached GET 200 on second call
5. Cache: does not cache non-GET
6. Cache: does not cache no-store/no-cache responses
7. Cache: invalidates port on unexpose
8. Cache: evicts LRU at CACHE_MAX_SIZE
9. Cache: expires entries after CACHE_TTL_MS (use fake time or override Date.now)

### Sandbox Verification (MANDATORY)
```bash
# Build UI and server
bun run build

# Start sandbox in screen
screen -dmS sandbox bash -c 'cd packages/server && exec bun tests/harness/sandbox.ts --headless --redis=memory > /tmp/sandbox-out.log 2>&1'
sleep 8
grep "UI (HMR)" /tmp/sandbox-out.log  # note the port

# Open browser and log in
playwright-cli open http://127.0.0.1:<VITE_PORT>
playwright-cli snapshot  # find email/password refs
playwright-cli fill <email-ref> "testuser@pizzapi-harness.test"
playwright-cli fill <password-ref> "HarnessPass123"
playwright-cli snapshot  # find sign-in button
playwright-cli click <button-ref>
playwright-cli screenshot  # save path

# Take screenshot of the app running
playwright-cli screenshot  # confirm logged in

# Clean up
playwright-cli close
screen -S sandbox -X quit
```

Note: Full tunnel proxy testing (exposing a local port) is best done in a real runner session; the sandbox confirms the UI loads and no regressions. The unit tests cover the proxy logic.

Attach sandbox screenshot path to dish file before marking complete.

### Verification Commands
```bash
cd packages/cli && bun run typecheck
bun run typecheck  # root-level checks all packages
bun test packages/cli
bun test packages/server  # ensure existing tunnel tests still pass
```

### Commit Message
```
feat(tunnel): response caching, accept-encoding fix, httpProxy() refactor

- Extract HTTP proxy logic into standalone httpProxy() utility
- Add server-side response cache (60s TTL, 100-entry LRU, port invalidation)
- Force Accept-Encoding: identity to prevent decompressed-body+stale-header bug
- Strip content-encoding from forwarded responses
- Add comprehensive unit tests for cache logic and proxy guards

Builds on fix/tunnel-module-mime-rewriting (WS upgrade + path rewriting commits).
Closes: Ulj4kdTT, 673xYgWN
```
