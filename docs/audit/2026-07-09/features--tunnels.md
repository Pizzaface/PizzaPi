# Audit: features/tunnels.mdx

Verdict: MINOR ISSUES
Claims checked: 30 | Failed: 7

## Findings

### [P1] create_tunnel `url` field example value is wrong
- Claim (line ~55, JSON example): `"url": "http://127.0.0.1:3000"`
- Reality: The daemon's TunnelService sets `url: \`/tunnel/${port}\`` for every tunnel_registered payload, and the tool returns `info.url` verbatim. The test fixture confirms `payload: { port: 3000, name: "dev", url: "/tunnel/3000" }`. The `url` field is a relative path fragment (`/tunnel/3000`), not a localhost URL — `publicUrl` is the only real URL. (packages/cli/src/runner/services/tunnel-service.ts:71,79,117; packages/cli/src/extensions/tunnel-tools.test.ts:129)
- Fix: Change the example to `"url": "/tunnel/3000"` and clarify `url` is an internal relay path fragment, not a direct localhost URL.

### [P2] list_tunnels described as "for this runner" but tool says "for this session"
- Claim (line ~88): "List all currently active tunnels for this runner."
- Reality: The registered tool description reads "List all currently active tunnels for this session. Returns each tunnel's port, name, and public URL." (packages/cli/src/extensions/tunnel-tools.ts:260-263). The tunnels live on the per-runner daemon Map, so "runner" is arguably more accurate, but the doc disagrees with the tool's own description.
- Fix: Align the doc wording with the tool description (or fix the tool description to say "runner").

### [P2] Interceptor script patch list is incomplete
- Claim (line ~30): "An injected interceptor script patches `fetch`, `XMLHttpRequest`, `EventSource`, `WebSocket`, `history.pushState`, and dynamic resource loading at runtime."
- Reality: `buildTunnelInterceptScript` also patches `history.replaceState`, `location.assign`, `location.replace`, `navigator.sendBeacon`, `window.open`, and `Element.prototype.setAttribute` (plus src/href/action property setters). (packages/server/src/routes/tunnel.ts:103-170)
- Fix: Add `history.replaceState`, `location.assign/replace`, `navigator.sendBeacon`, `window.open`, and `Element.setAttribute` to the list, or summarize as "navigation, fetch/XHR, WebSocket, EventSource, and dynamic resource loading APIs."

### [P2] "Auth-only access" claim ignores the signed-token (mobile iframe) scheme
- Claim (line ~138): "Auth-only access — every tunnel request requires a valid session cookie or API key."
- Reality: The `/api/tunnel/auth/:token/:sessionId/:port/*` route authenticates via a path-embedded signed token (`verifyTunnelToken`) with no cookie/API key, used by the mobile app and cross-origin iframe embedding. The token is owner-minted via POST `/api/tunnel-token`. (packages/server/src/routes/tunnel.ts:23, 605-665; packages/ui/src/hooks/useTunnelSrc.ts:9-13, 38)
- Fix: Note that runner/session owner-verified requests also work via a short-lived signed path token (for mobile/cross-origin iframe access), in addition to cookie/API-key auth.

### [P2] Header-stripping list omits `Referer`; query-param list omits `tunnelToken`
- Claim (lines ~142, ~144): "Cookie, Authorization, and X-API-Key headers are never forwarded"; "`apiKey` query parameters are stripped before forwarding."
- Reality: `STRIP_AUTH_HEADERS` / `STRIP_AUTH` also strip `referer`. The query-string sanitizer deletes both `apiKey` AND `tunnelToken`. (packages/server/src/routes/tunnel.ts:840, 877, 818-824, 879-887)
- Fix: Add `Referer` to the header list and `tunnelToken` to the query-param list.

### [P2] "Non-HTML content types are streamed directly without buffering" is misleading
- Claim (line ~207): "Non-HTML content types are streamed directly without buffering, so real-time data flows through with minimal latency."
- Reality: `shouldBufferTunnelResponse` returns true for HTML, JavaScript/TypeScript modules, AND CSS — those are buffered (up to `TUNNEL_MAX_BUFFERED_BYTES` = 25 MiB) before rewriting, not streamed. Only content types outside those three are streamed unbuffered. SSE (`text/event-stream`) does stream, but the blanket "non-HTML" framing is wrong since JS/CSS are also buffered. (packages/server/src/routes/tunnel.ts:316-324, 730-736)
- Fix: Rephrase as "Content types that need no rewriting (e.g. SSE, JSON, images, binary) are streamed directly; HTML, JS modules, and CSS are buffered for rewriting."

### [P3] `pinned` shown in `details` but example output omits the `[pinned]` marker
- Claim (line ~98): list_tunnels "Returns: A text summary ... with their ports, names, pinned status, and public URLs."
- Reality: The text formatter appends ` [pinned]` for pinned tunnels (`packages/cli/src/extensions/tunnel-tools.ts:289`), but the example output line `:3000 (dev-server) → ...` shows none, and `pinned: false` in the JSON. The doc never shows what a pinned tunnel looks like in output, despite mentioning pinned status.
- Fix: Add a one-line pinned example, e.g. `:4173 (preview) [pinned] → https://...`.

## Redesign notes
- The doc never mentions the `/api/tunnel/auth/:token/...` signed-token scheme or the `POST /api/tunnel-token` endpoint, which is the mechanism the mobile UI actually uses (`useTunnelSrc.ts`). Readers implementing mobile/cross-origin embedding will miss it. Consider a short "Mobile & cross-origin access" subsection.
- The `url` field semantics are unclear: it's an internal `/tunnel/<port>` fragment, not a usable URL, yet it sits next to `publicUrl` in the `details` object. Either document it explicitly as "internal relay path, not directly usable" or drop it from the documented example.
- Two near-identical hop-by-hop / strip-auth header sets exist (inline in `handleTunnelRoute` and the module-level `HOP_BY_HOP_HEADERS`/`STRIP_AUTH_HEADERS`), and they diverge subtly (e.g. both strip `referer`, but the inline set is duplicated). The doc hand-waves "etc." — a single canonical list in the doc would prevent drift.
- The 10s service-message timeout (tool side) vs 30s relay HTTP-proxy timeout vs 10s WS-open timeout are all different; the doc only mentions the 10s service-message timeout. A small "Timeouts" table would be clearer than one buried bullet.
- The "How It Works" steps describe Socket.IO `service_message` but the tunnel relay data path is actually a separate raw WebSocket (`TunnelRelay`/`TunnelClient` over `/_tunnel`), distinct from the Socket.IO relay namespace. The doc conflates the control plane (service_message) with the data plane, which may confuse contributors.

## Code UX opportunities
- The daemon sets `TunnelInfo.url = /tunnel/${port}` — a non-usable internal fragment surfaced in agent-facing tool output and `details`. Exposing a meaningless value invites confusion (and a wrong docs example). Either omit `url` from the returned `details` or compute a real localhost URL.
- `close_tunnel` is fire-and-forget on the daemon side: on timeout it resolves `{ closed: true }` even if the port was never tracked ("Port {port} was not tunneled." is only reached if a `tunnel_removed` arrives with a non-matching port, which never happens). The tool can mislead the agent into thinking an unknown port was closed. Tighten the success signal.
- `list_tunnels` tool description says "for this session" while tunnels are scoped per-runner daemon; the tool/daemon naming should be reconciled so docs and tool text agree.
- Header stripping strips `Referer` but the doc lists only Cookie/Authorization/X-API-Key — surfacing the full strip set (or auto-documenting it) would keep the security section accurate without code change; conversely, consider whether `Referer` stripping breaks legit referrer-based app behavior and merits a config opt-out.
- The interceptor script patches a broad surface (history, location, sendBeacon, window.open, setAttribute) but the docs only advertise a subset — auto-generating this list from `buildTunnelInterceptScript` (or exporting the patched API names) would keep docs and runtime in sync.
