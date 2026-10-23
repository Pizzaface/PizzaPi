# Tunnel-system audit — 2026-10-23

Baseline: `origin/main` at `3edfe4bd`. Review and implementation were performed directly, without subagents.

## Scope and trust boundaries

Reviewed the tunnel system, not just the initial panel patch:

- CLI create/list/close tools and credential resolution.
- Runner exposure ownership, shared-port reference counts, session cleanup, and reconnect announcements.
- Tunnel transport registration, HTTP streams, WebSockets, cancellation, buffer limits, protocol detection, and port reuse.
- Server session/runner/token/host routes, token minting and verification, label storage, ownership checks, response rewriting, credentials, CSP, and WebSocket upgrade authorization.
- UI service-channel filtering, automatic panel opening, session selection, preview state, signed-link minting, and new-tab navigation.

Management is session-scoped; the underlying port exposure is reference-counted across sessions and pinned services. Runner-owner access and bearer links are broader than session-local management. A session's tunnel list is not an independent security boundary against another session owned by the same user on the same runner.

## Validated findings and fixes

| Priority | Finding | Source / fix | Evidence |
| --- | --- | --- | --- |
| P1 | Closing the final port exposure blocked new requests but left existing HTTP streams and WebSockets connected. A holder of an already-open link could continue receiving data or using a socket after close. | `packages/tunnel/src/client.ts`: track the port for each active request/socket; abort only that port's streams on unexposure. | Real loopback HTTP stream and WebSocket test fails on the original code; passes with the fix. A socket on another port remains connected. |
| P2 | Two registration notifications in one React batch could toggle the Tunnels panel open and then closed. The stale closure saw it as closed for both events. | `ServicePanels.tsx` adds idempotent `openPanel`; `App.tsx` uses it for tunnel notifications. | Batched hook test fails with toggle and passes with open. Browser test sends duplicate notifications. |
| P2 | A runner-pinned panel retained a different session's identity, so current-session tunnels were filtered out. Changing the identity alone also left stale tabs and a stale selected port. | `tunnel-session.ts`, `App.tsx`, `TunnelPanel.tsx`: prefer the viewed session on that runner, retain cross-runner fallback, clear old list/selection while fetching the new session's list. | Selection boundary tests; panel switch regression; browser switch from session A to B before creating B's tunnel. |
| P2 | Link minting ignored config credentials and `PIZZAPI_API_TOKEN`. Failed minting quietly returned a cookie-only URL as `publicUrl`. | `tunnel-tools.ts`: use the existing credential precedence; return `publicUrl: null`, an explicitly login-only `browserUrl`, and a warning on failure. Preserve the fact that exposure succeeded. Show warnings in CLI rendering too. | Config/token/key tests; HTTP 401 mint-failure regression. Original config/token cases failed. |
| P2 | `close_tunnel` ignored correlated runner errors, accepted another request's response, and reported success after silence. | `tunnel-tools.ts`: reject mismatched IDs, report correlated errors, report timed-out closure as unconfirmed, remove the listener. | Rejection and timeout regressions. Legacy request-ID-less port-removal broadcasts remain supported. |
| P2 | One socket could register multiple runner identities. Disconnect cleaned up only its last identity, leaving stale runner entries. Repeating the same registration also needlessly replaced the socket. | `packages/tunnel/src/server.ts`: enforce one identity after asynchronous authorization and acknowledge identical retries without replacing the connection. | Concurrent registration test fails before the guard; existing reconnect/ownership suites pass. |
| P2 | A viewer abort before response headers removed the relay callback and timeout, but never settled the HTTP handler's promise. | `routes/tunnel.ts`: settle client-aborted requests with an internal 499 response; error an already-started response stream. Internal error paths retain their original status. | Abort-before-headers regression was still pending on old code; passes after the fix. Existing upload-cancellation tests pass. |
| P2 | Null token JSON and a null mint body threw instead of producing authorization/validation failures. Runner commands accepted string/fractional ports and threw on null payloads. | `tunnel-token.ts`, `tunnel.ts`, `tunnel-service.ts`: validate these boundaries before dereferencing or exposing a port. | Token, authenticated mint, and service-message negative tests fail on old code and pass with guards. |

The P1 fix applies when the **last** owner releases the port. Closing one session's reference must not break another session or a pinned service still using that port.

## Redirect investigation

A 302 by itself is not proof of failure. Cookie-authenticated browser navigation intentionally redirects to a signed path, since the sandboxed document cannot use the relay cookie for its own subresources. Upstream apps may also return redirects.

Earlier read-only deployment probes followed both cookie-path redirects and localhost redirects to 200. Those probes established behavior of the deployed instance, **not** its correspondence with main.

The isolated browser check used this branch's server/UI, a disposable Redis/database, mock agent sessions, the real `TunnelService` and `TunnelClient`, and a loopback app returning `302 Location: /landing`. Procedure:

1. View session A to seed the runner's existing session cache.
2. Switch to session B on the same runner.
3. Expose the loopback app for B and send two registration notifications.
4. Confirm the Tunnels panel stays open and renders the landing page in its iframe.
5. Click **Open in new tab** and assert the same landing-page heading in the popup.

All assertions passed. Screenshot: `/tmp/tunnel-browser-audit/redirect-panel.png` in the producing session. The disposable harness was removed from the branch and shut down. No live deployment was rebuilt or restarted.

The user's original redirect failure is **not reproduced**. Its exact URL, Location header, final response, and device/network context are still needed. The browser check is Chromium desktop, not a native Android/iOS WebView test.

## Boundaries checked without a new validated bypass

Existing tests and code review covered cross-runner response injection, durable runner ownership, wrong-user token minting, token expiry/key rotation, session revocation, old capabilities after port reuse, malformed WebSocket frames, CSWSH checks on cookie-based upgrades, path-origin credential stripping, host-only app cookies, and size/backpressure limits.

No new cross-user authorization bypass was validated. This is a scoped code audit, not a security certification or load test.

## Remaining limitations

- **Exposure epochs are port-wide.** If another owner keeps a port exposed, removing one owner's reference does not globally revoke that port or all runner-scoped links. No per-link revocation UI was added.
- **Legacy close replies lack IDs.** Compatibility still accepts an ID-less removal for the matching port. Strict request-only correlation would require a runner protocol migration; silence and explicit errors no longer count as success.
- **TLS detection is asynchronous.** An immediate first request to a newly started HTTPS-only local service can fail before its protocol probe finishes; the source already documents this behavior. This PR does not redesign probe scheduling or add a connection queue. Follow-up tracked as Godmother `RokRqa6G`.
- **Domain reachability is not probed by the UI.** HTTPS and localhost suitability checks do not prove wildcard DNS, certificate trust, or tailnet access on the viewing device. No silent downgrade from a configured isolated origin was introduced.
- **Signed path mode remains limited.** SPA routing, persistent storage, and some app authentication depend on a dedicated tunnel origin. Oversized HTML skips rewriting entirely. Updated the user docs rather than claiming universal app compatibility.
- **Config-file corruption was not attributed.** A zero-valued local API key was observed earlier, but no writer was proven. This PR does not modify personal credentials or claim that the config caused the panel failure.

## Verification

- Complete transport suite: `bun test packages/tunnel/src` — 106 passed.
- CLI tools and runner service suites, including new failure-path regressions — 46 passed.
- Every `tunnel*.test.ts` under `packages/server/src`, run in separate Bun processes with `PIZZAPI_REDIS_URL=off` to avoid shared-module mock contamination and personal Redis — 153 passed.
- Complete UI suite: `cd packages/ui && bun test src` — 1,866 passed, one existing skipped test.
- Workspace TypeScript build and server test typecheck.
- Repository lint, full application build, and docs build.
- Application entry gzip: 503.13 KiB, below the 512 KiB build budget on this machine.
- Real-browser panel/redirect check above.

The first typecheck and lint runs caught defects in the new test code; those were corrected and the gates rerun. A disposable browser fixture also briefly entered the server test typecheck; it was removed before the final passing run.

The full root test orchestration, native mobile builds/device tests, sustained-load tests, and production rollout were not performed. CI and maintainer review remain required before merge.
