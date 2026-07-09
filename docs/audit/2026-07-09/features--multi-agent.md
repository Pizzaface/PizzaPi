# Audit: features/multi-agent.mdx
Verdict: MAJOR ISSUES
Claims checked: 40 | Failed: 7

## Findings

### [P1] session_error is NOT fired before session_complete
- Claim (line 110): "Fired **before** `session_complete` when a child hits a usage limit or provider error. This gives the parent an early signal to react"
- Reality: In the agent_end handler, `void followUpGrace.fireSessionComplete(...)` is invoked first, then `maybeFireSessionError(...)` runs synchronously afterward. `fireSessionComplete` synchronously calls `emitSessionCompleteWithAck` → `emitSessionTriggerWithAck`, which calls `socket.emit("session_trigger", ...)` for `session_complete` before control returns to the `maybeFireSessionError` line. So `session_complete` is emitted on the wire FIRST. Both emits occur in the same tick, so the parent batches them (80ms window) and `renderTriggerBatch` renders them in arrival order: `session_complete` text, then `session_error` text — the parent sees completion BEFORE the error, not after. (packages/cli/src/extensions/remote/lifecycle-handlers.ts:411-424; session-complete-delivery.ts:74-108; connection.ts:227-239 flushTriggerBatch)
- Fix: State that `session_error` is emitted alongside (after) `session_complete`, and that it is delivered as a `steer` interrupt while `session_complete` is `followUp`-queued — or fix the code to emit `session_error` first if an early signal is genuinely intended.

### [P1] Push-notification suppression is opt-in per subscription, not automatic for children
- Claim (line 313): "Linked child sessions **do not trigger push notifications**. Only top-level sessions ... send push notifications."
- Reality: `checkPushNotifications` computes `isChildSession` and passes it to `notifyAgentFinished/NeedsInput/Error`, which call `sendPushToUser(userId, payload, isChildSession)`. Web-push sends are only skipped when `isChildSession && sub.suppressChildNotifications` — and `suppressChildNotifications` defaults to `0` (off) in the migration (push.ts:172, push.ts:574). The native ntfy path explicitly delivers ALL events regardless of `isChildSession` (push.ts:384-389). So by default child sessions DO send push notifications; suppression is a per-subscription user opt-in and does not cover ntfy at all.
- Fix: Reword to "Child-session push notifications can be suppressed per subscription via the suppressChildNotifications setting; native (ntfy) delivery is currently never suppressed." Or change the default so children are suppressed by default if that is the intended UX.

### [P2] session_error only fires for usage-limit-class errors, not all provider errors
- Claim (line 110): "Fired ... when a child hits a usage limit or provider error"; line 105 "provider failure"
- Reality: `maybeFireSessionError` only emits when `isUsageLimitError(errorMessage)` is true. The classifier matches only quota/rate-limit/resource-exhausted/context-window phrases (usage-limit-error.ts). A generic provider failure (e.g. 500, network error) sets `lastError` (→ exitReason "error" on session_complete) but does NOT fire a `session_error` trigger.
- Fix: Scope the claim to usage-limit/quota errors only; drop "provider error/failure" or clarify that non-quota provider errors surface only via the `exitReason: "error"` field on the subsequent `session_complete`.

### [P2] session_complete exitReason omits "killed"
- Claim (line 90): exitReason is either `"completed"` or `"error"`
- Reality: `exitReason = rctx.wasAborted ? "killed" : lastError ? "error" : "completed"` (lifecycle-handlers.ts:406). The renderer also handles `"killed"` (registry.ts:99-101: `exitReason === "killed" ? "was killed"`). A third value `"killed"` exists and is sent when the child was aborted (non-manual).
- Fix: Document the `"killed"` exitReason and what it means (aborted child).

### [P3] ask_user_question example does not match the actual rendered trigger text
- Claim (line 48): Example shows `Child session "auth-refactor" is asking:\n  "..." \n  Options: RS256, HS256\n\nUse respond_to_trigger(triggerId, response) to answer.`
- Reality: The renderer emits `🔗 Child "auth-refactor" asks:\n> <question>\nOptions: 1. RS256  2. HS256\n\nRespond with \`respond_to_trigger\` using trigger ID \`<id>\`.` (registry.ts:23-44). No "Child session" wording, no emoji in the doc, options are numbered, and the closing line differs.
- Fix: Replace the illustrative block with the real rendered output, or label it clearly as paraphrased.

### [P3] Trigger metadata prefix omits the `source:` segment shown in code
- Claim (line 38): "Triggers arrive ... prefixed with `<!-- trigger:ID -->` metadata"; examples throughout use `<!-- trigger:abc123 -->`
- Reality: `renderTrigger` emits `<!-- trigger:${triggerId} source:${sourceSessionId}${q64} -->` (registry.ts:253). The actual prefix always carries `source:<id>` and, for ask_user_question, a `questions64:<base64>` segment. The doc never mentions `source:` or `questions64:`.
- Fix: Show the real prefix form (`<!-- trigger:ID source:SID -->`) and note the optional `questions64:` payload for rich UI rendering.

### [P3] 10-minute TTL and 5-minute child timeout are conflated
- Claim (line 132): "Triggers have a **10-minute TTL**. If the parent doesn't respond within that window, the trigger expires and the child times out (5-minute default for ask_user_question and plan_review)."
- Reality: The 10-minute TTL is the parent-side tracking expiry in `extension.ts` (TRIGGER_TTL_MS = 10*60*1000) — it governs when `respond_to_trigger` will reject a stale trigger. The 5-minute value (300_000ms) is the CHILD-side wait timeout in remote-ask-user.ts:454 and remote-plan-mode.ts:452 — the child unblocks and cancels at 5 min, well before the parent's 10-min TTL. So "if the parent doesn't respond within [10 min] the child times out" inverts the relationship: the child gives up first (5 min), and the parent's 10-min TTL is a separate cleanup window.
- Fix: Separate the two timers: child wait timeout = 5 min (question/plan); parent-side trigger tracking TTL = 10 min. State which side each applies to.

## Redesign notes
- The "Trigger system" section mixes emission order, delivery mode (steer/followUp), and parent-side batching in a way that produces a wrong mental model (the session_error "early signal" claim). Restructure around: (1) what the child emits and in what order, (2) the deliverAs steering semantics, (3) the parent's batching/flush behavior, (4) per-trigger response actions.
- The push-notification paragraph is presented as unconditional fact; it should be moved into a "Notification behavior" subsection that explicitly references the `suppressChildNotifications` per-subscription toggle and the ntfy exception, ideally with a link to the settings UI.
- The session_complete exitReason list should be a small table (`completed` / `error` / `killed`) rather than prose, since the renderer branches on all three.
- The trigger-type examples (ask_user_question, plan_review) would be more useful as verbatim rendered output (which the registry already produces deterministically) instead of hand-written approximations.
- `fire_trigger` is documented under "multi-agent" but is really a peer/external-trigger mechanism; consider moving it to a separate "Triggers & services" page and linking from here to reduce scope creep.

## Code UX opportunities
- Emit `session_error` BEFORE `session_complete` (swap the two calls in lifecycle-handlers.ts:411-424) so the documented "early signal to react" becomes actually true, and deliver it as `steer` while `session_complete` is `followUp` — then the parent genuinely sees the error first.
- Default `suppressChildNotifications` to 1 (on) for new subscriptions, or suppress child pushes unconditionally in `notifyAgentFinished/NeedsInput/Error` when `isChildSession` is true, so the documented "children don't notify" behavior holds without per-subscription opt-in. (Currently ntfy can never be suppressed for children — add an `isChildSession` guard in `sendNtfyToUser`.)
- The parent-side `TRIGGER_TTL_MS` (10 min) and the child-side `timeoutMs` (5 min) are silently mismatched; surface the child's timeout in the trigger metadata so the parent agent knows how long it actually has to respond, or align both to the same window.
- `respond_to_trigger` silently defaults `session_complete` to `ack` (which kills the child) when `action` is omitted — a parent that forgets the action on a completion trigger will terminate the child. Consider requiring `action` explicitly for `session_complete`, or making `ack` opt-in rather than the default, to prevent accidental child termination.
