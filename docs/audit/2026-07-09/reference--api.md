# Audit: reference/api.mdx
Verdict: MAJOR ISSUES
Claims checked: 96 | Failed: 24

## Findings

### [P0] API key auth header is wrong — documented `Authorization: Bearer` is not read by the server
- Claim (line 22-25): "Pass your API key in the `Authorization` header: `Authorization: Bearer pk_live_abc123...`"
- Reality: The server only reads API keys from the `x-api-key` header. `requireSession`/`validateApiKey` call `req.headers.get("x-api-key")` and return 401 "Missing API key (x-api-key header)" if absent. There is no Bearer-token parsing anywhere. The trigger-broadcast and attachment docs even correctly say `x-api-key`, contradicting this section. Also the `pk_live_` prefix is fabricated — `register` issues `randomBytes(32).toString("hex")` (no prefix). (packages/server/src/middleware.ts:11-49, packages/server/src/routes/auth.ts:~155)
- Fix: Replace the example with `x-api-key: <hex key>` and drop the `pk_live_` prefix illustration.

### [P1] `GET /api/runners` response is an object `{ runners: [...] }`, not a bare array
- Claim (line 88-98): Response shown as a bare JSON array `[{ "id":..., "name":..., "connected":..., "sessions":[...] }]`
- Reality: Handler returns `Response.json({ runners: await getRunners(...) })`. (packages/server/src/routes/runners.ts:62)
- Fix: Wrap the example in `{ "runners": [ ... ] }`.

### [P1] Runner object field names are wrong (`id`/`connected`/`sessions` vs `runnerId`/`sessionCount`)
- Claim (line 91-96): Each runner has `id`, `name`, `connected` (boolean), `sessions` (array of session IDs).
- Reality: `RunnerInfo` has `runnerId`, `name`, `roots`, `sessionCount` (number), `skills`, `agents`, `plugins?`, `hooks?`, `version`, `platform?`, `serviceIds?`, etc. There is no `connected` field and no `sessions` array; it is a numeric `sessionCount`. (packages/protocol/src/shared.ts:52-80, packages/server/src/ws/sio-registry/runners.ts:420-440)
- Fix: Show `runnerId`, `name`, `sessionCount`, `roots`, `version`, etc., and remove `connected`/`sessions`.

### [P1] `POST /api/runners/spawn` response fabricates `shareUrl` and omits `ok`/`runnerId`/`pending`
- Claim (line 117-122): Response `{ "sessionId": "...", "shareUrl": "https://relay.example.com/sessions/..." }`
- Reality: Handler returns `Response.json({ ok: true, runnerId, sessionId, pending: (ack.timeout === true) })`. There is no `shareUrl` field anywhere in the spawn path. (packages/server/src/routes/runners.ts:~205)
- Fix: Replace response example with `{ "ok": true, "runnerId": "...", "sessionId": "...", "pending": false }`.

### [P1] Spawn request body omits several accepted fields
- Claim (line 104-112): Body supports only `runnerId`, `prompt`, `cwd`, `model`.
- Reality: Handler also reads `agent` (`{ name, systemPrompt?, tools?, disallowedTools? }`), `parentSessionId`, `resumePath`, `resumeId`. (packages/server/src/routes/runners.ts:~75-130)
- Fix: Document the `agent`, `parentSessionId`, `resumePath`, `resumeId` fields.

### [P1] Title and a cross-reference promise a WebSocket section that does not exist
- Claim (line 3, 448): Title "HTTP and WebSocket API endpoints"; Git ops "See the WebSocket section below."
- Reality: The page ends at the Tunnel section (~line 1426). There is no WebSocket section, and the `service_message`/`serviceId="git"` channel is never documented. (file has no `## WebSocket` heading)
- Fix: Either add a WebSocket section documenting the Socket.IO namespaces/events, or drop the title/cross-reference and describe Git ops as "handled via the `service_message` Socket.IO event (out of scope here)."

### [P2] `GET /health` response shape is understated
- Claim (line 60-66): Response `{ "status": "ok" }`.
- Reality: `handleApi` returns `{ status, redis, socketio, uptime, version: { server, socketProtocol, buildTimestamp } }`; `status` can be `"degraded"`. `/status` and `/api/status` are aliases. (packages/server/src/routes/index.ts:60-83)
- Fix: Show the full object and mention `/status`, `/api/status` aliases and the `degraded` state.

### [P2] Attachment max file size default is 30 MB, not 10 MB
- Claim (line 832): "Max file size: Configured by the server (default: 10 MB)."
- Reality: `DEFAULT_MAX_FILE_SIZE_BYTES = 30 * 1024 * 1024` (env override `PIZZAPI_ATTACHMENT_MAX_FILE_SIZE_BYTES`). The HTTP body limit for upload paths is `MAX_ATTACHMENT_BODY_SIZE = 50 MB`. (packages/server/src/attachments/store.ts:23, packages/server/src/handler.ts:22)
- Fix: State default 30 MB (and env var name).

### [P2] `POST /api/runners/restart` misdescribes what is restarted
- Claim (line 144): "Restart an agent session on a runner. Sends a restart signal to the runner daemon."
- Reality: It emits `"restart"` to the runner socket and restarts the runner daemon itself, not an individual agent session. There is no per-session restart REST endpoint. (packages/server/src/routes/runners.ts: restart branch emits `runnerSocket.emit("restart", {})`)
- Fix: Reword to "Restart the runner daemon (and all its sessions)."

### [P2] `GET /api/runners/:id/services` response omits several fields
- Claim (line 287-296): Response `{ "serviceIds": [...], "panels": [...] }`.
- Reality: Handler returns `{ serviceIds, disabledServiceIds, panels, triggerDefs, sigilDefs }`. (packages/server/src/routes/runners.ts: servicesMatch branch)
- Fix: Add `disabledServiceIds`, `triggerDefs`, `sigilDefs` to the example.

### [P2] `GET /api/sessions` omits pagination query params and `nextCursor`
- Claim (line 745-763): Only `includePersisted` param; response `{ sessions, persistedSessions: [] }`.
- Reality: When persisted sessions are included, the handler also reads `limit` (default 20, max 100) and `cursor`, and returns `nextCursor`. (packages/server/src/routes/sessions.ts:21-50)
- Fix: Document `limit`/`cursor` params and the `nextCursor` response field.

### [P2] Webhook fire endpoint omits the enhanced (replay-protected) HMAC mode
- Claim (line 983-1000): Auth is HMAC-SHA256 of "the raw request body"; only `X-Webhook-Signature` header documented.
- Reality: Two modes are auto-detected. Enhanced mode HMACs `${timestamp}.${nonce}.${rawBody}` and requires `X-Webhook-Timestamp` + `X-Webhook-Nonce` headers, with a 5-minute replay window and nonce-once enforcement. Legacy mode (body only) is the fallback. (packages/server/src/routes/webhooks.ts:~290-340)
- Fix: Document both modes, the two extra headers, the 5-min window, and the 409 nonce-replay response.

### [P2] `GET /api/runners/:id/trigger-listeners` listener object is incomplete
- Claim (line 366-373): Listener has `listenerId`, `triggerType`, `prompt`, `cwd`.
- Reality: `addRunnerTriggerListener`/`listRunnerTriggerListeners` also persist `model`, `params`, and `autoClose`. (packages/server/src/routes/runners.ts: POST listener branch and runner-trigger-listener-store.ts)
- Fix: Add `model`, `params`, `autoClose` to the example.

### [P2] `POST /api/runners/:id/trigger-listeners` body omits `autoClose`
- Claim (line 384-395): Body lists `triggerType`, `prompt`, `cwd`, `model`, `params`.
- Reality: Handler also reads `autoClose` (boolean) and passes it to `addRunnerTriggerListener`; spawned sessions get `autoClose: true`. (packages/server/src/routes/runners.ts: listener POST)
- Fix: Document `autoClose`.

### [P3] `POST /api/register` example key prefix `pk_live_` is fabricated
- Claim (line 75): Response `{ "ok": true, "key": "pk_live_abc123..." }`
- Reality: Keys are `randomBytes(32).toString("hex")` — a 64-char hex string with no prefix. (packages/server/src/routes/auth.ts:~150)
- Fix: Show a hex key or remove the prefix.

### [P3] Push `/api/push/answer` error codes mostly accurate but `502` wording differs
- Claim (line 1330-1334): `409` no question/already submitted; `403` not collab mode; `502` runner not connected.
- Reality: Code returns 409 for no pending question OR toolCallId mismatch OR already-consumed; 403 for non-collab; 502 only when the TUI socket is missing (runner disconnected). Accurate, but the 409 case conflates three distinct conditions. (packages/server/src/routes/push.ts: answer branch)
- Fix: Note the three 409 sub-conditions, or leave as-is (minor).

### [P3] Tunnel "Auth headers stripped" list is incomplete
- Claim (line 1418): "Auth headers (`Cookie`, `Authorization`, `x-api-key`) are stripped before forwarding."
- Reality: The strip set is `{ cookie, authorization, x-api-key, referer }`; hop-by-hop headers (host, accept-encoding, etc.) are also removed, and `apiKey`/`tunnelToken` query params are deleted from the forwarded URL. (packages/server/src/routes/tunnel.ts: STRIP_AUTH_HEADERS, HOP_BY_HOP_HEADERS, buildPathWithQuery)
- Fix: Mention `Referer` stripping and query-param redaction.

### [P3] `PUT /api/runners/:id/sandbox-config` response is forwarded runner result, not fixed `{ ok: true }`
- Claim (line 474-478): Response `{ "ok": true }`.
- Reality: Handler returns `Response.json(result)` from the runner command, which may include additional fields. (packages/server/src/routes/runners.ts: sandboxConfigMatch branch)
- Fix: Say the runner's acknowledgement object is returned.

## Missing endpoints (real, undocumented)

- `GET /api/me` — returns `{ userId, userName }`. (routes/index.ts:90)
- `GET /api/version` — returns `{ version }` (latest npm version). (routes/index.ts:85)
- `GET /api/status`, `GET /status` — health aliases. (routes/index.ts:60)
- `GET /api/signup-status` — `{ signupEnabled }`. (routes/auth.ts)
- `GET /api/runners/:id/browse` — folder picker (returns `{ directories }`). (routes/runners.ts: browseMatch)
- `PUT /api/runners/:id/services/:serviceId/enabled` — enable/disable a service. (routes/runners.ts: serviceEnabledMatch)
- `POST /api/runners/:id/mcp/reload` — reload MCP in active sessions. (routes/runners.ts: RUNNER_MCP_RELOAD_RE)
- `GET /api/runners/:id/analysis/:sessionId` — on-demand session analysis. (routes/runners.ts: analysisMatch)
- `GET/PUT /api/runners/:id/settings` — read/write runner config.json sections (models, mcpServers, hooks, sandbox, etc.). (routes/runner-settings.ts)
- `GET /api/runners/:id/packages`, `POST .../packages/install|remove|update` — pi package management. (routes/packages.ts)
- `POST /api/push/register-native`, `POST /api/push/unregister-native` — ntfy native push. (routes/push.ts)
- `POST /api/tunnel-token` — mint a tunnel auth token for mobile iframes. (routes/tunnel.ts: handleTunnelTokenMint)
- `GET /api/tunnel/auth/:token/:sessionId/:port/*` — token-authed tunnel (no session cookie). (routes/tunnel.ts: AUTH_TUNNEL_PATH_RE)
- `GET /api/mcp-oauth-callback` — MCP OAuth redirect proxy. (routes/mcp-oauth.ts)
- `POST /api/setup-claim`, `GET /api/setup-claim/:token`, `POST /api/setup-claim/:token/approve` — QR device enrollment. (routes/setup-claims.ts)
- `POST /api/mobile-link`, `GET /api/mobile-link/:id`, `POST .../scan|approve|redeem` — Android app pairing. (routes/mobile-links.ts)
- `GET /api/sessions/:id/available-sigils` — sigil defs for a session's runner. (routes/triggers.ts: availableSigilsMatch)

## Redesign notes
- The page is titled "HTTP and WebSocket API endpoints" but contains zero WebSocket content, and the Git-ops paragraph references a non-existent section. Either add the WS section or rename/reword.
- Auth is described once at the top with the wrong header; per-endpoint "Auth:" lines then correctly say `x-api-key` or "session cookie", creating an internal contradiction. Reconcile the top-level auth section with the per-endpoint labels.
- The `GET /api/runners` example is the single most visible response in the page and its shape/fields are both wrong — this should be the first fix.
- Response examples frequently show fabricated fields (`shareUrl`, `connected`, `sessions`, `pk_live_`) that read like plausible REST conventions but do not exist in the code. Consider generating examples from test fixtures or route handlers.
- Several "response: `{ ok: true }`" claims are actually forwarded runner-command results whose shape varies; mark these as "runner acknowledgement" rather than a fixed body.
- The page would benefit from a "Missing/global endpoints" subsection (`/api/me`, `/api/version`, health aliases, signup-status) since these are the ones CLI/clients hit first.

## Code UX opportunities
- `validateApiKey` returns a plain-text 401 with no JSON body and no hint that the header name is `x-api-key`; clients using `Authorization: Bearer` (as the docs told them to) get an opaque 401. Returning a JSON error naming the expected header would make this self-diagnosing.
- `GET /api/runners` returns `{ runners }` while `GET /api/sessions` returns `{ sessions, persistedSessions, nextCursor }` — inconsistent envelope shapes. A uniform `{ data, ...meta }` envelope would let the docs (and clients) describe one pattern.
- Spawn returns `pending: true` when the spawn ACK times out, but there is no documented way for a client to recover/poll a pending spawn. Either document the retry semantics or surface a `Location`/poll endpoint.
- The webhook HMAC has two modes silently auto-detected by header presence; a 401 "Invalid signature" gives no hint which mode was attempted. Including the detected mode in the error would help integrators.
- `POST /api/runners/restart` restarting the whole daemon (killing all sessions) under a name that sounds session-scoped is a footgun — consider renaming to `/api/runners/:id/restart-daemon` or accepting an optional `sessionId` for scoped restart.