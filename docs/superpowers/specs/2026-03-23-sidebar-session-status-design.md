# Sidebar Session Status Design

**Date:** 2026-03-23
**Scope:** Clarify visual differentiation between active, awaiting, and completed session states in the sidebar tree.

## Goal

Make session status easier to read at a glance by ensuring only actively working sessions use a busy/spinning treatment, while awaiting and completed sessions use lighter pulse treatments with distinct meanings.

## Current Problem

The sidebar currently makes "waiting for a trigger" and "completed" feel too similar to "actively working," especially because motion treatments are overloaded. This makes it harder to tell whether a session is:

- still doing work,
- blocked on user input / trigger response, or
- finished and ready for review.

## Desired State Model

### 1. Active

**Meaning:** The agent is currently doing work.

**Visual treatment:**
- This remains the only clearly busy state.
- Keep the stronger working animation (`spin` / `chase` / equivalent active motion).
- Keep the existing blue/working color family unless implementation details show a very close variant reads better.

**User impression:** “This session is currently running.”

### 2. Awaiting

**Meaning:** The session is blocked and waiting for a trigger, user input, or plan response.

**Visual treatment:**
- Remove any spin/busy treatment.
- Use a soft amber pulse.
- Replace the existing purple/chase-style awaiting treatment with the new amber pending treatment.
- Make the state feel paused/pending rather than active.

**User impression:** “This session needs something before it can continue.”

### 3. Completed (Unread)

**Meaning:** The session completed since the user last viewed it.

**Visual treatment:**
- Remove any spin/busy treatment.
- Use a soft green pulse or similarly completion-coded resolved treatment.
- If practical within the existing compact layout, give this state a subtle “done” cue distinct from awaiting.

**User impression:** “This session is finished and ready to review.”

### 4. Idle

**Meaning:** The session is neither actively working, nor waiting on a trigger, nor newly completed/unread.

**Visual treatment:**
- Keep this subdued and largely static.
- It should not compete visually with the three attention-worthy states above.

**User impression:** “This session is inactive right now.”

## UI Surface Areas

### Session row styling

Update the session row state styling so:
- **Active** keeps the stronger working animation.
- **Awaiting** gets a lighter pulse-based pending treatment.
- **Completed (Unread)** gets a lighter pulse-based resolved treatment.
- **Idle** remains subdued.

Avoid making awaiting and completed rows feel identical; the distinction should come from both motion and color semantics.

Priority note: if multiple booleans could apply at once, preserve the existing semantic priority used by the current sidebar logic unless a real bug is found. In particular, awaiting should continue to win over active if both appear true at render time.

### Provider icon as sole status indicator

**Remove the small activity dot** that currently overlays the provider badge. Instead, the provider icon container itself becomes the status indicator:

- **Active:** the provider icon gets the spin/chase animation — it is the "working" indicator.
- **Awaiting:** the provider icon gets a soft amber pulse/glow.
- **Completed (Unread):** the provider icon gets a soft green pulse/glow.
- **Idle:** the provider icon is static/subdued (no animation, no glow).

This requires threading `sessionsWithPendingQuestion` and `completedUnreadSessions` into the icon container's class logic, which currently only branches on `s.isActive`.

### Remove inline pin icon

Remove the always-visible pin toggle icon from the session row. Pinning remains accessible via:
- Swipe-reveal action buttons
- Long-press context action
- Keyboard shortcut (`P`)

This declutters the compact row layout and lets the status indicator and session text take more space.

## Constraints

- Keep the sidebar compact; do not add bulky labels or large badges unless clearly necessary.
- Do not change session-state semantics unless a genuine classification bug is discovered.
- Ensure nested child sessions continue to render correctly after any styling changes.
- Be mindful of narrow sidebar widths and mobile layouts.

## Testing Strategy

Prefer focused testing of state-to-style mapping if the mapping can be extracted cleanly into a pure helper without unnecessary abstraction. A good target would be a helper that maps the sidebar inputs to a visual state such as:

- `active`
- `awaiting`
- `completedUnread`
- `idle`

Otherwise:
- run UI package tests,
- run typecheck,
- and verify the affected sidebar behavior manually or via targeted UI tests if available.

If the implementation changes custom animation classes, update the existing sidebar animation definitions rather than introducing redundant near-duplicates unless that materially improves clarity.

## Non-Goals

- Redesigning the full sidebar information hierarchy
- Changing session lifecycle semantics
- Adding new backend session statuses
- Reworking swipe actions or tree expansion behavior
