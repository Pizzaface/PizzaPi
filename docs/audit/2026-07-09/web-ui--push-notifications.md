# Audit: web-ui/push-notifications.mdx
Verdict: MINOR ISSUES
Claims checked: 34 | Failed: 5

## Findings

### [P2] `agent_finished` body is misleading — it usually shows the agent's reply text
- Claim (line 16, table): _"Your agent in {session} has finished its task."_
- Reality: `notifyAgentFinished` only emits that string when `replyText` is empty; otherwise the body is the agent's last assistant message text (`packages/server/src/push.ts:619-628`), and `push-tracker.ts:103` always passes `extractLastAssistantText(event)` as the reply. In the typical case (agent ends with an assistant turn) the notification body is the reply summary, not the "finished its task" sentence. The doc presents the fallback string as the body.
- Fix: Note that the body is the agent's final reply when present, falling back to the "finished its task" line.

### [P2] "Quick reply requires collab mode" link is broken
- Claim (line 28): _"Quick reply requires [collab mode](/PizzaPi/web-ui/terminal/) to be enabled on the session."_
- Reality: `terminal.mdx` documents the Web Terminal only and never mentions "collab mode" (`grep collab` in `terminal.mdx` → no matches). "collab mode" is not described as a user-facing feature anywhere in docs except this link and `reference/protocol.mdx`/`api.mdx`. The check itself is real (`push-tracker.ts:139`: `session?.collabMode === true`), and the remote extension always sets `collabMode: true` (`packages/cli/src/extensions/remote/connection.ts:267`), so for normal PizzaPi sessions the requirement is always satisfied — the framing implies user action that doesn't exist.
- Fix: Either document collab mode on a real page and point there, or drop the link and state that quick reply is available on linked (remote) sessions by default.

### [P3] Stale-subscription cleanup also handles 404, doc says only 410
- Claim (line ~172, "VAPID key mismatch"): _"The server automatically cleans up stale subscriptions (410 Gone responses from push services)..."_
- Reality: `sendPushToUser` prunes on `err?.statusCode === 410 || err?.statusCode === 404` (`packages/server/src/push.ts:583-587`).
- Fix: Mention 410 and 404, or just say "expired/invalid subscriptions".

### [P3] Child-session suppression does not affect native (ntfy) push — undocumented gap
- Claim (lines 64-71): "Suppress child session notifications" suppresses child notifications, per-subscription.
- Reality: The suppression column is checked only for Web Push subs (`packages/server/src/push.ts:574` `if (isChildSession && sub.suppressChildNotifications) return;`). `sendNtfyToUser` ignores `isChildSession` entirely (`packages/server/src/push.ts:389` `void isChildSession; // native has no suppression columns yet`). The toggle is correctly hidden on native UI (`NotificationToggle.tsx:177` `{!native && (...)}`), so web-only readers won't hit this, but the doc never states the toggle is web-push-only and silently inapplicable to native. A reader using the Android app could be confused why child alerts still arrive.
- Fix: Add a one-line note that suppression applies to browser (Web Push) subscriptions only; native app push is unaffected.

### [P3] Suppress-child on mobile lives in the mobile menu, not "the bell dropdown menu"
- Claim (line 65): _"toggle **Suppress child session notifications** in the bell dropdown menu."_
- Reality: On desktop the toggle is in the bell's `DropdownMenuContent`; on mobile it's a separate `MobileNotificationMenuItem` rendered inside the header's mobile dropdown (`AppHeaders.tsx:482`), and the bell icon itself is not rendered in the mobile top bar as a dropdown trigger. Phrasing implies a single bell-dropdown entry point.
- Fix: Say "in the notifications dropdown (desktop) or the mobile menu".

## Redesign notes
- The page cleanly covers Web Push (VAPID) only; `deployment/mobile-push.mdx` covers ntfy native. There is no real content duplication — they describe genuinely different transports — so do **not** merge. Add a one-line cross-link near the top of `push-notifications.mdx` pointing Android-app users to `mobile-push.mdx`, and vice versa (mobile-push already notes the PWA path runs independently).
- The "What Gets Notified" table conflates the *event* with the *body string*; bodies are dynamic (reply text, truncated question, truncated error). Consider splitting into "trigger" + "default body" and noting truncation limits (120 chars for question/error, 300 for reply) visible in `push.ts`.
- The "Per-Event Filtering" section exposes a raw `curl` with a session cookie — there is no UI. This is a code UX opportunity (see below), and the doc reads as if the API is the intended path. Flag the API as the only path explicitly.
- "Quick reply requires collab mode" reads as a user action but collab mode is implicitly always on for remote sessions; this section would be clearer as "quick reply is available on linked remote sessions."

## Code UX opportunities
- Add a per-event toggle UI to the bell dropdown (the `enabledEvents` column and `PUT /api/push/events` endpoint already exist, `push.ts:543-547`). Currently users must `curl` with a cookie — friction that the doc itself surfaces as the only path.
- Default `suppressChildNotifications` to on, or suppress child pushes for native too (`sendNtfyToUser` ignores `isChildSession`, `push.ts:389`); the doc promises "no notification storm from sub-agents" but a user with only the Android app gets every child alert.
- Document/expose collab mode as an actual user-visible concept (a settings row, or a doc page) rather than a link target that doesn't mention it; otherwise the quick-reply "requires collab mode" sentence is unactionable.
- Surface a "re-subscribe" hint in the bell dropdown when the server detects the local subscription is stale (410/404 already pruned server-side) — currently the UI shows the bell as active until the user notices silence and re-toggles.
