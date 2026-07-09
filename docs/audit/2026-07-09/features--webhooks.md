# Audit: features/webhooks.mdx
Verdict: MINOR ISSUES
Claims checked: 28 | Failed: 6

## Findings

### [P2] Delete confirmation UX is wrong (no "Sure?" button, no 3s auto-dismiss)
- Claim (line ~"Deleting"): "Click the trash icon on a webhook row. You'll see a **"Sure?"** confirmation button (auto-dismisses after 3 seconds)."
- Reality: `DeleteButton` opens an `AlertDialog` modal titled "Delete webhook {name}?" with `AlertDialogCancel` ("Cancel") and `AlertDialogAction` ("Delete webhook") buttons. There is no "Sure?" label and no auto-dismiss timer (packages/ui/src/components/WebhooksManager.tsx:128-186). The doc describes an older inline two-step button UX that no longer exists.
- Fix: Replace with: "Click the trash icon to open a confirmation dialog, then click **Delete webhook** to confirm."

### [P2] Timestamp window is +30s / -5min, not ±5 minutes
- Claim (Enhanced headers table): "Must be within ±5 minutes of server time."
- Reality: Future timestamps are rejected when `timestampMs > nowMs + WEBHOOK_CLOCK_SKEW_MS` where `WEBHOOK_CLOCK_SKEW_MS = 30 * 1000` (30s). Past timestamps rejected when `nowMs - timestampMs > WEBHOOK_REPLAY_WINDOW_MS` (5 min) (packages/server/src/routes/webhooks.ts:63-66, 497-505). The window is asymmetric, not ±5min.
- Fix: State "Must be no more than 30s in the future or 5 minutes in the past of server time."

### [P2] Replay protection is Redis-backed (shared), not "per-process"
- Claim (Enhanced headers table / header desc): "per-process replay protection" and "Prevents replay within the 5-minute window (per server process; multi-node deployments need shared storage)."
- Reality: `consumeNonceOnce` uses Redis `SET ... NX PX ttlMs` when Redis is available, with an in-memory `Map` fallback only when Redis is disabled/unreachable (packages/server/src/redis-kv-store.ts:84, 106-130). Multi-node deployments sharing Redis get shared replay protection automatically; the doc's caveat implies they don't.
- Fix: Say "Redis-backed replay protection (in-memory fallback if Redis unavailable); multi-node deployments sharing Redis are covered."

### [P2] Troubleshooting lists a non-existent "Missing X-Webhook-Timestamp" 401
- Claim (Troubleshooting table): "`401 Missing X-Webhook-Timestamp` | Using enhanced mode but forgot the timestamp header..."
- Reality: No such error is ever returned. If `X-Webhook-Timestamp` (or `X-Webhook-Nonce`) is absent, `useEnhanced = !!(timestampHeader && nonceHeader)` is false and the server silently falls back to legacy mode (packages/server/src/routes/webhooks.ts:486-487, 521-528). The only "Missing ..." 401s are for `X-Webhook-Signature` and (empty) `X-Webhook-Nonce` (webhooks.ts:480, 509).
- Fix: Remove the row, or reframe: "If you omit the timestamp header, the server silently uses legacy mode (no replay protection) — add both timestamp and nonce to enable enhanced mode."

### [P3] 502 row conflates "unreachable" with 503
- Claim (Errors table): "`502` | Runner rejected the spawn request or is unreachable"
- Reality: "Runner is not connected to this server" returns **503** (webhooks.ts:135-139); 502 is only "Failed to send spawn request to runner" (emit threw) or "Runner rejected the spawn request" (ack.ok === false) (webhooks.ts:151-157, 168-172). The 503 row already covers offline/unreachable.
- Fix: Drop "or is unreachable" from the 502 row; keep "Runner rejected the spawn request or the spawn emit failed."

### [P3] triggerId example contains non-hex characters
- Claim (Response example): `{ "ok": true, "triggerId": "wh_a1b2c3d4e5f6g7h8", ... }`
- Reality: `triggerId = wh_${randomUUID().replace(/-/g, "").slice(0, 16)}` — 16 hex chars only (packages/server/src/routes/webhooks.ts:181). `g`, `h` are not hex digits.
- Fix: Use a hex-only example, e.g. `wh_a1b2c3d4e5f6a7b8`.

## Redesign notes
- The "Firing a webhook" headers table and the "Computing the HMAC signature" section repeat the same enhanced/legacy distinction twice; consider consolidating the mode explanation once and keeping the headers table + code tabs.
- The "When to use webhooks" section is generic marketing prose with no verifiable specifics; it adds length without referenceable claims.
- The prompt's dual delivery (passed as the spawned session's initial prompt AND merged into the trigger payload via `triggerPayload = prompt ? { ...payload, prompt } : payload`, webhooks.ts:200-202) is undocumented; users writing prompts may be surprised the prompt appears inside the payload too.
- "Source — Defaults to `custom`" is true in the UI form (useState("custom"), WebhooksManager.tsx:456) but the REST API requires `source` non-empty with no default (webhooks.ts:288-291); the fields table mixes UI and API behavior without disambiguation.
- The errors table and the troubleshooting table overlap heavily (401/404/500/503/504 appear in both); merge or cross-link to reduce duplication.

## Code UX opportunities
- The delete confirmation was changed from an inline "Sure?" auto-dismissing button to a full `AlertDialog` modal — a heavier interaction for a destructive-but-recreatable action. If the inline pattern was intentionally removed for accessibility, fine; otherwise a lightweight inline confirm with keyboard support may be preferable.
- A missing `X-Webhook-Timestamp` silently downgrades to legacy mode with no log/warning, making misconfigured enhanced callers hard to debug. Consider logging (or returning a hint header) when exactly one of timestamp/nonce is present.
- The fire endpoint returns 500 for "no runner assigned" (webhooks.ts:550-555) after HMAC + filter checks already passed; a 409/422 ("configuration conflict") would be more semantically accurate than 500 (server error).
- 502 vs 503 split ("emit threw" → 502, "socket missing" → 503) is subtle for callers; a single consolidated error code with a `reason` field would simplify client retry logic.
