# Health Inspection — 2026-03-25

**Shift:** 20260325-043904 (Runner Service System — Night Shift 4)
**Inspector:** Health Inspector (invoked 2026-03-25, post-shift)
**Inspector Model:** claude-opus-4-6 (x4, independent sessions)
**Dishes Inspected:** 4 of 4 served
**PRs:** #315 (Dish 001), #317 (Dish 002), #318 (Dish 004), #319 (Dish 003) — all open at inspection time

---

## Overall Grade

**D** — Multiple violations. Critics were unreliable on security-sensitive code.

Two dishes earned VIOLATION (serious P1 bugs missed by critics after final LGTM): Dish 002 has a completely broken viewer→runner routing path; Dish 004 has two SSRF vectors in the tunnel proxy. Two dishes earned CITATION (P2 issues missed). Critics caught zero of four dishes cleanly.

---

## Per-Dish Results

### Dish 001: ServiceHandler Refactor (PR #315)
- **Critic Verdict:** SEND BACK (P1: disposeAll not called on disconnect) → Maître d' OVERRIDE → LGTM ✅
- **Inspector Verdict:** CITATION
- **Inspector Findings:**
  - P2: `dispose()` does not remove socket event listeners. The `ServiceHandler` interface comment describes dispose as called "on socket disconnect or daemon shutdown," but none of the service `dispose()` methods call `socket.off()`. If Phase 2+ introduces per-connection init/dispose cycling (reconnects), `initAll` would double-register every listener silently. The interface contract should either be corrected to "shutdown only" or `dispose()` must store and remove listeners.
  - P3: `ServiceEnvelope` type exported from `service-handler.ts` is unused dead code in Phase 1.
  - P3: Redundant `(data as any)` casts in FileExplorer and GitService (copied from daemon.ts verbatim).
- **Critic Discrepancy:** Critic's P1 was a false positive (overridden). Inspector found P2 that critic missed entirely — listener leakage risk on reconnect cycles.
- **Action:** godmother-captured

---

### Dish 002: Relay Generic Service Envelope (PR #317)
- **Critic Verdict:** LGTM ✅ (round 3, after 2 fix rounds)
- **Inspector Verdict:** VIOLATION
- **Inspector Findings:**
  - **P1 (critical):** Viewer → runner `service_message` routing is broken. `viewer.ts` calls `emitToRelaySession(sessionId, "service_message", envelope)` which emits to the `/relay` namespace room (where the TUI worker lives). But service handlers (`TerminalService`, `FileExplorerService`, `GitService`, `TunnelService`) are registered on the **`/runner` namespace** socket — not `/relay`. The TUI worker does not listen for `service_message`. All viewer-initiated service requests (file listings, git status, tunnel commands) are silently dropped. The fix is to resolve `runnerId` from the session and call `emitToRunner(runnerId, "service_message", envelope)` instead.
  - P2: No runtime validation on `service_message` envelope fields (`serviceId`, `type` required). A large or malformed envelope is forwarded verbatim to all session viewers.
  - P2: `requestId` not hoisted to envelope top level in FileExplorerService and GitService `emitFileResult` helpers — buried inside `payload` instead, breaking consumer-side request correlation.
  - P3: `ServiceEnvelope` type defined in 4 places (protocol/shared.ts, runner.ts inline, viewer.ts inline, service-handler.ts) — will drift.
  - P3: `(socket as any).emit(...)` casts for `service_message` unnecessary since event is now in typed protocol.
- **Critic Discrepancy:** Critics ran 3 rounds catching real P1s (session seeding, dual-emit gaps, announce timing). They confirmed all were fixed. But they missed the routing namespace mismatch entirely — the viewer→runner flow was never tested end-to-end by the critic logic, which checked grep patterns rather than tracing the full routing path.
- **Action:** godmother-captured. **BLOCK-MERGE recommended until P1 fix lands.**

---

### Dish 003: UI useServiceChannel Hook + TunnelPanel (PR #319)
- **Critic Verdict:** LGTM ✅ (round 3, after 2 fix rounds)
- **Inspector Verdict:** CITATION
- **Inspector Findings:**
  - P2: Stale tunnels shown after reconnect. `if (!available) return null` suppresses render but doesn't reset `tunnels` state. On reconnect, the panel re-renders briefly showing stale tunnel entries until the `tunnel_list` response arrives. User can click stale "Open" or "Remove" buttons during that window. Fix: add `else { setTunnels([]); }` to the `useEffect` that fires `send("tunnel_list")`.
  - P2: `send()` in `useServiceChannel` doesn't guard on `available`. Only checks `!socket`. Future consumers without an `if (!available) return null` guard will silently emit to nowhere.
  - P3: Unsafe payload casts in TunnelPanel (`p.tunnels as TunnelInfo[]`) without array validation — misbehaving runner could cause runtime errors.
  - P3: `sessionId` prop interpolated directly into tunnel URL without `encodeURIComponent`. Low risk (UUIDs), but not strictly correct.
- **Critic Discrepancy:** Critics correctly caught disconnect/reconnect lifecycle on the hook (P1 in round 1). But missed the stale tunnels state issue and the `available` guard omission on `send()`.
- **Action:** godmother-captured

---

### Dish 004: TunnelService HTTP Port Tunnel (PR #318)
- **Critic Verdict:** LGTM ✅ (round 2, after 1 fix round)
- **Inspector Verdict:** VIOLATION
- **Inspector Findings:**
  - **P1 (security):** SSRF via redirect. `fetch()` uses default `redirect: "follow"`. If the localhost service returns a 301/302 to an internal network address (e.g., `169.254.169.254` cloud metadata, `10.x.x.x` internal network), Bun follows the redirect and returns that response. The 127.0.0.1 pinning only covers the *initial* URL. Fix: add `redirect: "manual"` to fetch options.
  - **P1 (security):** SSRF via path injection. The URL is assembled as `http://127.0.0.1:${port}${path}` via string concatenation. A path containing `@` can be parsed as `http://127.0.0.1:${port}@evil.com/`. Defense: parse the constructed URL with `new URL(url)` and assert `hostname === "127.0.0.1"` and `port === String(targetPort)` before fetching.
  - P2: Runner-side `HOP_BY_HOP` set does not include `"host"` (server-side does). Inconsistency — host header leaks through runner's proxy to localhost service.
  - P2: Entire response body buffered into memory before size check (`await fetchResponse.arrayBuffer()` then check `byteLength`). A multi-GB response causes OOM before rejection. Fix: check `Content-Length` header first, or stream with bounded accumulation.
  - P2: Server-side header forwarding passes `cookie` and `authorization` headers to the tunneled localhost service. Viewer's PizzaPi auth credentials leak to arbitrary tunneled services.
  - P3: `handleHttpRequest` is async; `dispose()` sets `this.socket = null`. If dispose fires during the `await fetch(...)`, the final `this.socket!.emit("tunnel_response", ...)` crashes with TypeError. Fix: capture socket reference at method entry.
  - P3: `requestId` uses `Math.random()` (non-crypto PRNG). Adequate in practice but `crypto.randomUUID()` is strictly better.
- **Critic Discrepancy:** Round 1 critic correctly caught the fail-open auth bug (userId null bypass) — a good catch. Round 2 critic confirmed the fix and issued LGTM. Both rounds missed the SSRF vectors entirely, despite explicitly checking for SSRF. The check likely verified the *initial URL* was hardcoded to 127.0.0.1 without considering redirect-following or URL parsing edge cases.
- **Action:** godmother-captured. **BLOCK-MERGE recommended until P1 SSRF fixes land.**

---

## Critic Accuracy Summary

| Metric | Value |
|--------|-------|
| Dishes inspected | 4 |
| Clean bills (critic confirmed) | 0 |
| Citations (critic missed minor) | 2 (Dish 001, 003) |
| Violations (critic missed serious) | 2 (Dish 002, 004) |
| Condemned (should not merge) | 0 |
| Critic accuracy rate | 0% |

*Note: "accuracy rate" measures final LGTM vs. inspector findings. Critics did catch real issues during service rounds — the rate above reflects whether the final state was actually clean.*

---

## Systemic Patterns

### 1. Routing / namespace tracing never verified (Dish 002 P1)
The critics confirmed code patterns (grep for dual-emit, check file_result helper, verify service_announce timing) but never traced the full message flow end-to-end. The viewer→runner path's namespace mismatch (`/relay` vs `/runner`) was invisible to a static pattern check. Critics need a "trace the message from source to destination" step for new protocol paths.

### 2. SSRF: initial URL checked, redirects not considered (Dish 004 P1)
Critics explicitly checked for SSRF and found the 127.0.0.1 hardcoding. They didn't ask "what happens if the target redirects?" or "can path injection change the authority?" These are well-known SSRF bypass vectors that should be on a standard security checklist for any HTTP proxy code.

### 3. State lifecycle on reconnect consistently missed (Dish 003, Dish 001 partial)
Stale state after reconnect was missed in Dish 003 (tunnels array). Listener accumulation on re-init was flagged only as P2 risk in Dish 001. Critics caught the *initial* lifecycle (disconnect sets available=false) but didn't follow through to "what happens to data state and listener counts across multiple connect/disconnect cycles?"

### 4. Error-path coverage improving but not complete
Critics pushed back on error-path dual-emit gaps (Dish 002 multiple rounds), which is good. But inspector still found gaps (P2 requestId hoisting, P2 payload validation). Helper-pattern enforcement (one emit site total) needs to be a verifiable spec requirement, not just a recommendation.

---

## Recommendations

### Critic Template
1. Add a **"Trace the full message path"** step for any new protocol event: source namespace → relay → destination namespace → handler. Don't just check the call site.
2. Add a **SSRF checklist** to security-sensitive code reviews: (a) is the target URL fixed to 127.0.0.1? (b) is redirect-following disabled? (c) can path/header injection change the effective target?
3. Add a **"state lifecycle across N reconnects"** step: not just "does available go false on disconnect?" but "is state reset, and would initAll called a second time double-register listeners?"
4. Grep verification for emit completeness should be **required**, not optional — "verify with grep that there is exactly 1 emit site for each event type (the helper), with zero scattered direct emits."

### Process
- Dish 002's P1 routing bug means the viewer→runner service_message path has never worked. This is a **blocker for PR #317 and all downstream PRs** (#318, #319) that depend on viewer-initiated service requests. Merging without this fix would ship a feature that silently doesn't work.
- PRs #318 (TunnelService) and #317 (relay envelope) should not be merged until the SSRF redirect and routing bugs are fixed.

### Model Combination
- gpt-5.3-codex critics: good at code pattern matching and grep verification; weak at end-to-end flow tracing and SSRF bypass vectors.
- claude-opus-4-6 inspectors (this audit): found issues missed by 3 rounds of Codex review on 3 of 4 dishes. Suggests using Opus for security-critical reviews.
- Consider adding one Opus review pass specifically for security-sensitive dishes (auth, tunnel proxy, any HTTP↔WebSocket bridging).
