# Audit: deployment/mobile-push.mdx
Verdict: MINOR ISSUES
Claims checked: 22 | Failed: 3

## Findings

### [P2] "If any of these are unset, the ntfy branch is a silent no-op" is wrong
- Claim (line 5/step 5): "If any of these are unset, the ntfy branch is a silent no-op and only Web Push runs."
- Reality: `isNtfyConfigured()` gates solely on `PIZZAPI_NTFY_URL` (`packages/server/src/push.ts:218-229`). If `PIZZAPI_NTFY_PUBLISH_TOKEN` is unset the branch still runs but publishes with no `Authorization` header (`push.ts:406-417`), which `deny-all` rejects with 403 — and 403 *prunes* the registration (`push.ts:476-493`), the opposite of "silent no-op". If `PIZZAPI_NTFY_PUBLIC_URL` is unset, `getNtfyPublicUrl()` returns `""` and the Android client bails with "register-native returned no topic/url" (`packages/ui/src/lib/ntfy-push.ts:129-137`).
- Fix: Reword to "If `PIZZAPI_NTFY_URL` is unset, the ntfy branch is a silent no-op; `PIZZAPI_NTFY_PUBLIC_URL` and `PIZZAPI_NTFY_PUBLISH_TOKEN` are required for push to actually function."

### [P3] register-native response shape is incomplete
- Claim (line ~step 6): "the server ... returns `{ ntfyPublicUrl, topic }`."
- Reality: The handler returns `{ ok, ntfyPublicUrl, topic, ntfyUser, ntfyPass }` (`packages/server/src/routes/push.ts:225-232`). `ntfyUser`/`ntfyPass` are null in Phase 1 but are part of the contract the doc claims to specify.
- Fix: Show the full response object `{ ok, ntfyPublicUrl, topic, ntfyUser: null, ntfyPass: null }` and note Phase-3 semantics.

### [P3] "server prunes the registration on 403" omits 404
- Claim (step 4): "the server prunes the registration on 403".
- Reality: `sendNtfyToUser` prunes on status `403 || 404` (`packages/server/src/push.ts:476-493`; test "prunes ntfy registrations on 403/404" at `src/push.test.ts:475`). 404 (unknown topic) also prunes.
- Fix: Say "prunes the registration on 403/404".

### [P3] Click-through deep link env var (`PIZZAPI_BASE_URL`) is undocumented
- Claim (Troubleshooting/Limitations): the doc describes tap behavior only implicitly via "reconciles session state from the relay"; never names the env var that powers tap-through.
- Reality: `buildNtfyPublish` builds `fields.click = ${PIZZAPI_BASE_URL}/#/sessions/${sessionId}` and omits `click` entirely when `PIZZAPI_BASE_URL` is unset (`packages/server/src/push.ts:366-376`; test at `push.test.ts:443-466`). Operators following this guide will get notifications with no tap target unless they also set `PIZZAPI_BASE_URL`.
- Fix: Add `PIZZAPI_BASE_URL` (relay public URL) to the env-var list in step 5 and note that without it notifications carry no deep link.

### [P3] CVE link points to a release tag, not an advisory
- Claim (step 1): "pinned to `binwiederhier/ntfy:v2.25.0`, which is past the [CVE-2026-39087](https://github.com/binwiederhier/ntfy/releases/tag/v2.22.0) fix".
- Reality: Compose pins `binwiederhier/ntfy:v2.25.0` (`docker/compose.yml`). The link resolves to the v2.22.0 *release tag*, not a CVE advisory or GHSA, so the reader can't verify the CVE claim. Not falsifiable from this repo.
- Fix: Link to the actual advisory/GHSA or drop the CVE reference and just state "v2.25.0 includes the v2.22.0 security fix".

### [P3] "with its API key" is correct but underspecified
- Claim (step 6): "the app calls `POST /api/push/register-native` with its API key."
- Reality: The route accepts a cookie session *or* `x-api-key` (`packages/server/src/middleware.ts:4-14`); the Android client's requests get `x-api-key` injected by the mobile-fetch wrapper (`packages/ui/src/lib/mobile-fetch.ts:32-37`) from secure storage. Accurate, but a reader implementing the Android side won't find the header anywhere in the doc.
- Fix: Note that auth is via `x-api-key` header (or cookie) and link to the mobile-link enrollment flow that mints the key.

## Redesign notes
- The page and `web-ui/push-notifications.mdx` are **complementary, not duplicated**: the former is ntfy/Capacitor Android background push; the latter is VAPID/Web Push PWA. Do not merge. However, mobile-push.mdx references "the Web Push (PWA) path" several times without a single link — add `{@link}`/relative links to `/web-ui/push-notifications` so readers can pivot.
- "Phase 1 / Phase 3" is referenced ~6 times with no pointer to an issue/roadmap; readers can't tell whether Phase 3 is planned, started, or abandoned. Add a link or a one-line status.
- Step 4's `ntfy access everyone 'pizzapi-*' read-only` relies on ntfy wildcard ACL support — worth a one-line caveat that this requires ntfy ≥ the version that supports `*` topic patterns, or cite the ntfy docs.
- The env-var block in step 5 mixes an internal-only var (`PIZZAPI_NTFY_URL=http://ntfy`) that the compose file already sets with operator-required vars; splitting "already configured by compose" vs "you must set these" would reduce misconfiguration (matches the in-file comments at `docker/compose.yml`).
- Troubleshooting lacks a "notifications arrive but tapping does nothing" entry — directly tied to the `PIZZAPI_BASE_URL` omission above.

## Code UX opportunities
- `isNtfyConfigured()` only checks the URL, so a misconfigured-but-set ntfy (missing token/public URL) fails silently/strangely. Consider a startup `log.warn` when `PIZZAPI_NTFY_URL` is set but `PIZZAPI_NTFY_PUBLIC_URL`/`PIZZAPI_NTFY_PUBLISH_TOKEN` are empty, so operators see the problem instead of debugging 403s.
- `register-native` returning 503 with text "Native push is not configured on this server (PIZZAPI_NTFY_URL unset)" is good, but the client swallows all non-503 errors silently (`packages/ui/src/lib/ntfy-push.ts:121-125`); surfacing a brief reason for 401 (no/invalid API key) would help enrollment debugging.
- The native push schema has no `enabledEvents`/`suppressChildNotifications` columns (`packages/server/src/push.ts:378-389` comment), so per-event filtering and child suppression documented for Web Push silently don't apply to ntfy — either document this gap on the mobile-push page or wire the columns (the comment already flags it).
- `PIZZAPI_BASE_URL` double-duty as the click deep-link source is undocumented coupling; a dedicated `PIZZAPI_WEB_URL` (or reusing `PIZZAPI_SERVER_URL`) would be clearer than overloading the base-url var.
