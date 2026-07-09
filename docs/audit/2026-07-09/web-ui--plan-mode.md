# Audit: web-ui/plan-mode.mdx
Verdict: MAJOR ISSUES
Claims checked: 35 | Failed: 5

## Findings

### [P1] Pending plan cards do NOT display a "waiting indicator" — they are hidden
- Claim (line ~"Plan cards in the conversation"): "Pending (unresolved) plans are visually distinct — they display a waiting indicator while the plan review panel is active in the composer area."
- Reality: `PlanModeCard` returns `null` while the plan is pending: `if (isStreaming && !isResponded) return null;` and `if (!resultText && !isStreaming) return null;` (packages/ui/src/components/session-viewer/cards/PlanModeCard.tsx:135-139). The card is absent during pending state, not "visually distinct with a waiting indicator". The only waiting affordance is the viewer status text "Waiting for plan review…" (packages/ui/src/lib/meta-state-apply.ts:67-72) plus the composer panel.
- Fix: Replace with: "Pending plans are hidden from the transcript while the review panel is active in the composer area; once you respond, the styled card appears in the conversation."

### [P2] /plan from the web UI does not produce an in-conversation notification
- Claim (line ~"Activating plan mode"): "When plan mode activates, a notification appears in the conversation confirming that read-only exploration is enabled."
- Reality: Typing `/plan` in the web UI dispatches an exec command `set_plan_mode` (packages/ui/src/components/session-viewer/slash-commands.ts:851), which only updates viewer status ("⏸ Plan mode ON") and the toolbar pill (packages/ui/src/App.tsx:2455-2460). No message is injected into the conversation. The in-conversation "Plan Mode Activated" card only renders for the agent's `toggle_plan_mode` tool call (packages/ui/src/components/session-viewer/tool-rendering.tsx:871-873, TogglePlanModeCard.tsx). The `ctx.ui.notify(...)` toast in the `/plan` handler (packages/cli/src/extensions/plan-mode/extension.ts:147-153) is a TUI-only affordance.
- Fix: Clarify that the in-conversation card only appears when the agent toggles via `toggle_plan_mode`; the `/plan` slash command only updates the toolbar pill and viewer status.

### [P2] respond_to_trigger approve/cancel examples omit the required `action` option
- Claim (line ~"Parent-child plan reviews"): "Approve — `respond_to_trigger(triggerId, "approve")`" and "Reject — `respond_to_trigger(triggerId, "cancel")`".
- Reality: The `respond_to_trigger` tool description states `action` is "Required for plan_review and session_complete triggers" (packages/cli/src/extensions/triggers/extension.ts:283), and the trigger message itself instructs: `Use respond_to_trigger with action: "approve" to accept, "cancel" to reject, or "edit" with feedback.` (packages/cli/src/extensions/triggers/registry.ts:78). The actionless form only works via a text-matching fallback in remote-plan-mode.ts (packages/cli/src/extensions/remote-plan-mode.ts:~470-475). The sibling features/plan-mode.mdx uses the canonical `respond_to_trigger(triggerId, "approve", { action: "approve" })` form, so the two docs disagree.
- Fix: Use `respond_to_trigger(triggerId, "approve", { action: "approve" })` and `respond_to_trigger(triggerId, "cancel", { action: "cancel" })` to match the tool contract, the trigger message text, and features/plan-mode.mdx.

### [P3] Toolbar pill text is "⏸ plan", not a "Plan Mode" status indicator
- Claim (line ~"Activating plan mode"): 'The session toolbar also shows a **"Plan Mode"** status indicator...'
- Reality: The toolbar renders a lowercase `⏸ plan` pill (packages/ui/src/components/SessionViewer.tsx:640) or a bare `⏸` icon button in the sidebar (packages/ui/src/components/session-viewer/ButtonSidebar.tsx:138-149). No element literally reads "Plan Mode".
- Fix: Reword to "the session toolbar shows a `⏸ plan` pill indicating writes are blocked."

### [P3] Heavy duplication with features/plan-mode.mdx — merge candidate
- Claim: The page includes a "Write-blocking enforcement" section, a "Parent-child plan reviews" section, and the 4-button action table that all duplicate features/plan-mode.mdx ("What's Blocked in Plan Mode", "Multi-Agent Plan Review", "Your response options").
- Reality: features/plan-mode.mdx covers the same material more completely (full bash blocklist, `toggle_plan_mode` parameter table, execution tracking, session behavior). The web-ui page already defers via an Aside ("For the full technical details... see the Plan Mode feature doc") but then re-documents write-blocking and parent-child triggers anyway — and the parent-child `respond_to_trigger` signatures disagree between the two pages (see P2 above).
- Fix: Strip "Write-blocking enforcement" and "Parent-child plan reviews" down to web-UI-specific behavior (what the trigger message looks like in the transcript, link to features doc for the response API). Keep only the panel/card UX on this page.

## Redesign notes
- The page mixes web-UI UX (panel, buttons, cards) with agent/API mechanics (trigger response signatures, write-blocking layers). Split cleanly: this page = what the user sees and clicks; features/plan-mode.mdx = how it works under the hood.
- The "Plan review panel" and "Action buttons" sections are accurate and well-scoped — keep them as the core.
- "Plan cards in the conversation" should describe the actual lifecycle: hidden while pending → appears as a card with a status pill after response. Currently it invents a "waiting indicator" that doesn't exist.
- Reconcile the parent-child response examples with features/plan-mode.mdx so a single canonical form is documented.

## Code UX opportunities
- Pending plans vanishing from the transcript can confuse users into thinking the plan was lost; consider rendering a collapsed "Plan pending — review in composer" placeholder card instead of returning `null` (PlanModeCard.tsx:135-139).
- The `respond_to_trigger` tool marks `action` as required for plan_review in its description but does not enforce it in code (extension.ts:283 vs :370), forcing a fragile text-matching fallback (remote-plan-mode.ts). Either validate `action` for plan_review triggers or drop the "Required" language.
- The `/plan` slash command from the web produces no transcript artifact, making the activation event invisible in history; emitting a lightweight system message (like the `toggle_plan_mode` card) would make sessions self-documenting.
