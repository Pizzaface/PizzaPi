# Dish 004: TunnelService — HTTP Port Tunnel (Option C)

- **Cook Type:** claude-sonnet-4-6
- **Complexity:** L
- **Godmother ID:** isxRzBqL
- **Dependencies:** 002 (service_message relay channel)
- **Band:** C → after refinement
- **Status:** served ✅

## Task Description

Build a lightweight HTTP port tunnel (Option C from isxRzBqL) using the relay infrastructure.
No WebSocket-in-tunnel, no streaming bodies, no chunked transfer encoding.
Simple request/response for dev server preview use case.

## ## Confidence Refinement

**Gaps:** Design choice is Option C (HTTP-only). Request/response matching via requestId.
Server-side HTTP route `/api/tunnel/{sessionId}/{port}/{path*}` translates HTTP requests into service_message envelopes and awaits responses.

**Dependency checks:** Requires 002 (service_message channel) to be done first. Uses ServiceRegistry from 001.

**Verification additions:**
- `bun run typecheck`
- `bun test packages/cli packages/server packages/ui`
- Manual: start a local HTTP server on port 8080, expose via tunnel, access via relay URL

**Fallback model:** claude-sonnet-4-6 (no change — primary model)

**Dispatch guard:** Only dispatch after dishes 001 AND 002 are plated and LGTM'd.

### Refined architecture (Option C):

**Runner side (TunnelService):**
```typescript
class TunnelService implements ServiceHandler {
  id = "tunnel";
  private tunnels = new Map<number, TunnelInfo>(); // port → {name, url}
  
  init(socket, { isShuttingDown }) {
    // Register a port as a tunnel
    socket.on("tunnel_expose", (data) => {
      // { port, name? } from viewer
      // validate port, check it's listening, register
      // emit tunnel_registered back
    });
    
    // Handle HTTP request from relay
    socket.on("service_message", (envelope) => {
      if (envelope.serviceId !== "tunnel") return;
      if (envelope.type === "http_request") {
        // fetch(http://localhost:${envelope.payload.port}${envelope.payload.path})
        // respond via service_message { type: "http_response", requestId, payload: { status, headers, body } }
      }
    });
    
    socket.on("tunnel_list", ...) // list active tunnels
  }
  
  dispose() { this.tunnels.clear(); }
}
```

**Server side:**
- HTTP route: `GET/POST /api/tunnel/:sessionId/:port/*` 
- Auth: session must belong to authenticated user
- Translates to `service_message { serviceId: "tunnel", type: "http_request", requestId, payload: { port, path, method, headers, body } }`
- Waits for `service_message { type: "http_response", requestId }` with 10s timeout
- Returns response to browser

**UI side (TunnelPanel):**
- Shows list of exposed tunnels (from `tunnel_list` responses)
- Each tunnel shows a "Open in new tab" link to `/api/tunnel/{sessionId}/{port}/`
- Option to expose a new port (input field + button)

### Constraints for Option C:
- NO WebSocket upgrade in tunnel (no HMR, no Socket.IO through tunnel)
- NO streaming responses (body must fit in memory, max 10MB)
- NO SSE (would require streaming)
- Response bodies: JSON, HTML, images — normal page loads, API responses

### Re-score after refinement:
- specCompleteness: 3 (architecture clarified, implementation details still open)
- verificationSpecificity: 3 (manual test required, automated test for tunnel logic)
- result: clarityScore≈66, riskScore≈59, confidenceScore≈31 → Band B (promoted)

Band: promoted from C → B

### Dispatch guard
Only dispatch Dish 004 after BOTH:
1. Dish 002 is plated (service_message channel available)
2. Dishes 003 AND 002 are at least dispatched (not blocking)
## Result
- **PR:** https://github.com/Pizzaface/PizzaPi/pull/318
- **Files:** 9 changed, 524 insertions
- **Notes:** TunnelService + HTTP route + pending map cleanup on disconnect

## Critic Review (Round 1)
- **Critic:** gpt-5.3-codex (cc12b382) — SEND BACK
- **P1:** tunnel.ts:74 — auth check `if (sessionData.userId && ...)` is fail-open when userId is null/falsy. Any authenticated user can access a null-owner session's tunnel.
- **Fix:** `if (!sessionData.userId || sessionData.userId !== identity.userId)` → reject
- **P3:** No tunnel-specific tests (non-blocking)
- **All other checks passed:** SSRF pinned to 127.0.0.1, pending map lifecycle clean, response reconstruction correct, 10MB limits enforced, dispose() clean

## Kitchen Disconnect
- **Root cause:** Classic fail-open auth — truthy guard on userId allows null to bypass ownership check
- **Category:** prompt-gap (spec said "owner-only" but didn't specify null-userId handling)
- **Detail:** `if (sessionData.userId && ...)` skips the check when userId is falsy. Security checks must fail closed.
- **Prevention:** Spec should state explicitly: "reject if userId is missing or mismatched"

## Fix Applied
- `if (sessionData.userId && ...)` → `if (!sessionData.userId || ...)`
- Verified via grep: no remaining fail-open userId checks in tunnel.ts
- Note: `!sessionData` null guard (→ 404) was already present above the ownership check; only the ownership line needed fixing
- Committed: 658c484 — pushed to `nightshift/dish-004-tunnel-service`

## Fixer Result (Round 1)
- Commit 658c484: `!sessionData.userId || sessionData.userId !== identity.userId`
- grep confirms no remaining fail-open userId checks

## Critic Review (Round 2)
- **Critic:** gpt-5.3-codex (c379467d) — **LGTM ✅**
- Auth fail-closed confirmed, SSRF intact, pending map lifecycle clean, dispose() clean

## Health Inspection — 2026-03-25
- **Inspector Model:** claude-opus-4-6
- **Verdict:** VIOLATION ⚠️
- **Findings:**
  - **P1 (security):** SSRF via redirect — `fetch()` uses `redirect: "follow"` (default). Localhost service returning 301/302 to internal network (cloud metadata, 10.x.x.x) will be followed. Fix: `redirect: "manual"`.
  - **P1 (security):** SSRF via path injection — `\`http://127.0.0.1:${port}${path}\`` string concatenation. Path containing `@` can redirect to arbitrary host. Fix: parse URL and assert `hostname === "127.0.0.1"`.
  - P2: Runner-side `HOP_BY_HOP` omits `"host"` — server-side strips it, runner-side doesn't (inconsistent)
  - P2: Entire response body buffered before size check — OOM DoS on multi-GB responses
  - P2: `cookie` and `authorization` headers forwarded to localhost service — viewer's PizzaPi creds leak to tunneled service
  - P3: `handleHttpRequest` async + `dispose()` null race — socket null after await
  - P3: `Math.random()` requestId — use `crypto.randomUUID()` instead
- **Critic Missed:** P1 SSRF via redirect and path injection (critics confirmed 127.0.0.1 hardcoding but didn't check redirect-following or URL parsing edge cases)
- **Action:** BLOCK-MERGE until P1 SSRF fixes land
