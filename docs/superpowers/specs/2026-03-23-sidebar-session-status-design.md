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
- Use the existing active/working color family unless implementation details suggest a nearby variant is clearer.

**User impression:** “This session is currently running.”

### 2. Awaiting

**Meaning:** The session is blocked and waiting for a trigger, user input, or plan response.

**Visual treatment:**
- Remove any spin/busy treatment.
- Use a soft amber pulse.
- Make the state feel paused/pending rather than active.

**User impression:** “This session needs something before it can continue.”

### 3. Complete

**Meaning:** The session completed since the user last viewed it.

**Visual treatment:**
- Remove any spin/busy treatment.
- Use a soft green pulse or similarly completion-coded resolved treatment.
- If practical within the existing compact layout, give this state a subtle “done” cue distinct from awaiting.

**User impression:** “This session is finished and ready to review.”

## UI Surface Areas

### Session row styling

Update the session row state styling so:
- **Active** keeps the stronger working animation.
- **Awaiting** gets a lighter pulse-based pending treatment.
- **Complete** gets a lighter pulse-based resolved treatment.

Avoid making awaiting and completed rows feel identical; the distinction should come from both motion and color semantics.

### Provider/activity dot

Update the small dot on the provider badge so it communicates state consistently:
- **Active:** animated working indicator
- **Awaiting:** amber pulse
- **Complete/unread:** green pulse
- **Idle/default:** subdued static indicator

## Constraints

- Keep the sidebar compact; do not add bulky labels or large badges unless clearly necessary.
- Do not change session-state semantics unless a genuine classification bug is discovered.
- Ensure nested child sessions continue to render correctly after any styling changes.
- Be mindful of narrow sidebar widths and mobile layouts.

## Testing Strategy

Prefer focused testing of state-to-style mapping if the mapping can be extracted cleanly into a pure helper without unnecessary abstraction. Otherwise:
- run UI package tests,
- run typecheck,
- and verify the affected sidebar behavior manually or via targeted UI tests if available.

## Non-Goals

- Redesigning the full sidebar information hierarchy
- Changing session lifecycle semantics
- Adding new backend session statuses
- Reworking swipe actions or tree expansion behavior
